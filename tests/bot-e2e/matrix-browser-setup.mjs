import { build } from "esbuild"
import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { inputDigest } from "./prepare.mjs"
import tailwindcss from "@tailwindcss/postcss"

export const directory = path.resolve(".cache/bot-e2e/matrix-browser")
export default async function setup() {
  await fs.mkdir(directory, { recursive: true })
  const verificationOnly = process.env.COGNIA_IM_BROWSER_SUITE === "matrix-verification-ui"
  // Only the unused default Host transport is substituted. Every invoked
  // connector command is explicitly routed to the real native subprocess.
  const transport = {
    name: "explicit-native-transport",
    setup(builder) {
      builder.onLoad({ filter: /lib\/tauri\/transport-instance\.ts$/ }, () => ({
        contents:
          "export const transport = { call() { throw new Error('Default Host transport unavailable in Matrix fixture') } }; export const localTransport=transport;export function onTransportChange(){return ()=>{}};export function setTransport(){throw new Error('Default transport fixture')}",
      }))
    },
  }
  const nextConfig = await fs.readFile("next.config.ts", "utf8")
  const nodeOnly = new Set(
    [
      ...nextConfig
        .split("const NODE_ONLY_MODULES = [")[1]
        .split("\n]")[0]
        .matchAll(/^\s*"([^\"]+)",?$/gm),
    ].map((match) => match[1])
  )
  const browserCompatibility = {
    name: "app-browser-compatibility",
    setup(builder) {
      builder.onLoad({ filter: /lib\/db\/seed\.ts$/ }, () => ({
        contents: "export async function seedBuiltIns() {}",
      }))
      builder.onResolve({ filter: /.*/ }, (args) =>
        nodeOnly.has(args.path) ? { path: path.resolve("lib/browser-stubs/empty.js") } : undefined
      )
      builder.onLoad({ filter: /lib\/connectors\/bus\.ts$/ }, () => ({
        contents:
          "export function getBus() { return { getAdapter(id) { const a=window.matrixFixture?.adapter(); return a?.id===id?a:undefined }, dispatchConnectorCallback() { throw new Error('Interactive callback bus is outside this storage fixture') } } }",
      }))
      builder.onLoad({ filter: /lib\/connectors\/at-gate\.ts$/ }, () => ({
        contents:
          "export async function gateInboundEvent() { return true };export async function shouldRespondToMessage() { throw new Error('Admission plugin API outside Matrix fixture') }",
      }))
    },
  }
  let accountOutputs = []
  const compile = async () => {
    const cssRequire = createRequire(import.meta.resolve("@tailwindcss/postcss"))
    const stylesheet = (await fs.readFile("app/globals.css", "utf8")).replace(
      '@import "tailwindcss";',
      '@import "tailwindcss" source(none);\n@source "../components/settings/connections/forms/matrix-verification-panel.tsx";\n@source "../components/ui";' +
        (verificationOnly
          ? ""
          : '\n@source "../components/account";\n@source "../components/surface";\n@source "../components/desktop/avatar-badge.tsx";')
    )
    const css = await cssRequire("postcss")([tailwindcss()]).process(stylesheet, {
      from: "app/globals.css",
    })
    await fs.writeFile(path.join(directory, "account.css"), css.css)
    const cssInputs = css.messages
      .filter((message) => message.type === "dependency")
      .map((message) => message.file)
    const account = verificationOnly
      ? { metafile: { inputs: {}, outputs: {} } }
      : await build({
          entryPoints: ["tests/bot-e2e/fixtures/account-gate.tsx"],
          outdir: directory,
          entryNames: "account",
          chunkNames: "account-chunks/[name]-[hash]",
          splitting: true,
          bundle: true,
          platform: "browser",
          format: "esm",
          metafile: true,
          jsx: "automatic",
          inject: ["account-process"],
          resolveExtensions: [".browser.ts", ".browser.tsx", ".tsx", ".ts", ".jsx", ".js", ".json"],
          plugins: [
            transport,
            {
              name: "account-browser-shell",
              setup(builder) {
                // Runtime-target switching is outside this gate fixture. Keep the
                // unused execution engine fail-fast rather than evaluating sidecars.
                builder.onLoad({ filter: /lib\/execution\/broker\.ts$/ }, () => ({
                  contents:
                    "export function getExecutionBroker(){throw new Error('Execution broker outside AccountGate fixture')}export class ExecutionAbortError extends Error{};export const DEFAULT_AI_TURN_LIMIT=16;",
                }))
                builder.onResolve({ filter: /^account-process$/ }, () => ({
                  path: "process",
                  namespace: "account-shell",
                }))
                builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
                  path: "navigation",
                  namespace: "account-shell",
                }))
                builder.onLoad({ filter: /.*/, namespace: "account-shell" }, (args) => ({
                  contents:
                    args.path === "process"
                      ? "export { default as process } from 'next/dist/compiled/process'"
                      : "export const usePathname=()=>'/';export const useRouter=()=>({push(){throw new Error('Navigation outside account fixture')},replace(){throw new Error('Navigation outside account fixture')}});export const useSearchParams=()=>new URLSearchParams()",
                  resolveDir: process.cwd(),
                }))
                // Match Next's production NormalModuleReplacementPlugin, including
                // node:-prefixed transitive imports; os needs its real browser shim.
                builder.onResolve({ filter: /.*/ }, (args) =>
                  args.path === "os" || args.path === "node:os"
                    ? { path: path.resolve("lib/browser-stubs/os-shim.js") }
                    : nodeOnly.has(args.path) || args.path.startsWith("node:")
                      ? { path: path.resolve("lib/browser-stubs/empty.js") }
                      : undefined
                )
              },
            },
          ],
          define: {
            global: "globalThis",
            __dirname: '"/"',
            __filename: '"/fixture.js"',
            "process.env.NODE_ENV": '"production"',
            "process.env.NEXT_PUBLIC_E2E": '"1"',
            "process.env.NEXT_PUBLIC_ACCOUNT_GATE": '"1"',
            "process.env.NEXT_PUBLIC_COGNIA_DEPLOYMENT_MODE": '"desktop"',
          },
          logLevel: "warning",
        })
    accountOutputs = Object.keys(account.metafile.outputs).map((file) => path.resolve(file))
    const browser = await build({
      entryPoints: ["tests/bot-e2e/fixtures/matrix-browser.tsx"],
      outfile: path.join(directory, "browser.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      resolveExtensions: [".browser.ts", ".browser.tsx", ".tsx", ".ts", ".jsx", ".js", ".json"],
      metafile: true,
      plugins: [transport, browserCompatibility],
      define: {
        "process.env.NODE_ENV": '"test"',
        "process.env.NEXT_PUBLIC_E2E": '"1"',
        "process.env.NEXT_PUBLIC_COGNIA_DEPLOYMENT_MODE": '"desktop"',
      },
      logLevel: "warning",
    })
    const node = await build({
      entryPoints: ["tests/bot-e2e/fixtures/matrix-node.ts"],
      outfile: path.join(directory, "node.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      metafile: true,
      packages: "external",
      alias: { ws: createRequire(path.resolve("cli/package.json")).resolve("ws") },
      plugins: [transport],
      banner: {
        js: 'import { createRequire as matrixRequire } from "node:module"; const require = matrixRequire(import.meta.url);',
      },
      logLevel: "warning",
    })
    return [
      ...new Set([
        ...Object.keys(browser.metafile.inputs),
        ...Object.keys(account.metafile.inputs),
        "app/globals.css",
        ...cssInputs,
        ...Object.keys(node.metafile.inputs),
        "tests/bot-e2e/matrix-browser-setup.mjs",
        "tests/bot-e2e/matrix-persistence.browser.mjs",
        "tests/bot-e2e/prepare.mjs",
        "tests/bot-e2e/native.mjs",
        "playwright.matrix.config.ts",
        "package.json",
        "next.config.ts",
        "pnpm-lock.yaml",
      ]),
    ]
      .filter((file) => !file.startsWith("(disabled):") && !file.startsWith("account-shell:"))
      .map((file) => path.resolve(file))
  }
  const inputs = await compile()
  const before = await inputDigest(inputs)
  const nextInputs = await compile()
  if (before !== (await inputDigest(nextInputs)))
    throw new Error("Matrix browser source changed while bundling")
  const outputs = [
    path.join(directory, "browser.js"),
    path.join(directory, "node.mjs"),
    ...accountOutputs,
    path.join(directory, "account.css"),
  ]
  const manifest = {
    sourceDigest: before,
    outputDigest: await inputDigest(outputs),
    inputs: nextInputs,
    outputs,
    realBrowser: true,
    accountUi: !verificationOnly,
    fakeIndexedDb: false,
    realPlatform: false,
  }
  await fs.writeFile(path.join(directory, "build.json"), JSON.stringify(manifest, null, 2) + "\n")
}
export async function validate() {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "build.json"), "utf8"))
  if (
    manifest.sourceDigest !== (await inputDigest(manifest.inputs)) ||
    manifest.outputDigest !== (await inputDigest(manifest.outputs))
  )
    throw new Error("Matrix browser build source or artifact changed")
  return manifest
}
