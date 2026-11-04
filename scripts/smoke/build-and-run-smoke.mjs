// Bundle + run the external-parity smoke.
//
// Uses the SAME esbuild pipeline as the CLI itself (see scripts/build/dev-cli.mjs
// for why `tsx` cannot run this graph: the repo root is CommonJS while `cli/` is
// ESM, so a `export *` boundary shim breaks a from-source run).
import { spawnSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { createBundleAgentProtocolDependenciesPlugin } from "../build/esbuild-shared.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

// One lane per flag, first match wins. Kimi and Qoder moved to
// `pnpm smoke:agent` (scripts/smoke/agent.ts), which installs the host itself,
// and the Pi subagent models to `pnpm smoke:subagent-models`.
// `cliModules` lanes reach CLI-only dependencies such as undici.
const LANES = [
  {
    flags: ["--goose-v156"],
    entry: "goose-v156-smoke.ts",
    out: ".cache/goose-v156-implementation/smoke.mjs",
    cliModules: true,
  },
  {
    flags: ["--copilot-acp"],
    entry: "copilot-acp-smoke.ts",
    out: ".cache/copilot-cli-acceptance/probe.mjs",
    cliModules: true,
  },
  {
    flags: ["--cline-acp"],
    entry: "cline-acp-smoke.ts",
    out: "cli/dist/smoke/cline-acp-smoke.mjs",
  },
  {
    flags: ["--aider-cli"],
    entry: "aider-cli-smoke.ts",
    out: "cli/dist/smoke/aider-cli-smoke.mjs",
  },
  {
    flags: ["--goose-acp"],
    entry: "goose-acp-smoke.ts",
    out: "cli/dist/smoke/goose-acp-smoke.mjs",
  },
  {
    flags: ["--deepseek-harness", "--pi", "--opencode"],
    entry: "deepseek-harness-adapter-smoke.ts",
    out: "cli/dist/smoke/deepseek-harness-adapter-smoke.mjs",
  },
  {
    flags: ["--devin-acp"],
    entry: "devin-acp-smoke.ts",
    out: "cli/dist/smoke/devin-acp-smoke.mjs",
  },
]
const DEFAULT_LANE = {
  entry: "external-cognia-parity-smoke.ts",
  out: "cli/dist/smoke/external-cognia-parity-smoke.mjs",
}
const lane =
  LANES.find((candidate) => candidate.flags.some((flag) => process.argv.includes(flag))) ??
  DEFAULT_LANE
const entry = path.join(root, "scripts/smoke", lane.entry)
const outfile = path.join(root, lane.out)

const esbuild = await import("esbuild")

// Mirrors build-cli.mjs: the CLI graph incidentally reaches Next-only modules
// that must merely RESOLVE, never execute.
const STUB_PATTERN = /^(next\/|server-only$|client-only$)/
const stubNextPlugin = {
  name: "stub-next-runtime",
  setup(build) {
    build.onResolve({ filter: STUB_PATTERN }, (args) => ({
      path: args.path,
      namespace: "smoke-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "smoke-stub" }, () => ({
      contents:
        "const noop = () => null; module.exports = new Proxy(noop, { get: (_t, p) => (p === '__esModule' ? false : noop), apply: () => noop });",
      loader: "js",
    }))
  },
}

const jsonDefaultOnlyPlugin = {
  name: "json-default-only-messages",
  setup(build) {
    build.onLoad({ filter: /i18n[\\/]messages[\\/][^\\/]+\.json$/ }, async (args) => {
      const raw = await fs.promises.readFile(args.path, "utf8")
      return { contents: `export default ${raw}`, loader: "js" }
    })
  },
}

// Every smoke runs over the CLI's external-agent host, installed exactly the
// way cli/src/cli/entry.ts installs it, before the smoke module is evaluated.
const smokeEntry = {
  contents: [
    `import { installCliExternalAgentHost } from ${JSON.stringify(path.join(root, "cli/src/runtime/external/host-branch.ts"))}`,
    "installCliExternalAgentHost()",
    `await import(${JSON.stringify(entry)})`,
  ].join("\n"),
  resolveDir: root,
  sourcefile: `${path.basename(entry, ".ts")}-entry.mjs`,
  loader: "js",
}

fs.mkdirSync(path.dirname(outfile), { recursive: true })
if (lane.cliModules) {
  // This graph includes CLI-only dependencies such as undici. Keep generated
  // output in the root cache while retaining the CLI's dependency resolution.
  const modules = path.join(path.dirname(outfile), "node_modules")
  if (!fs.existsSync(modules)) fs.symlinkSync(path.join(root, "cli/node_modules"), modules, "dir")
}
await esbuild.build({
  stdin: smokeEntry,
  outfile,
  bundle: true,
  banner: { js: "globalThis.__COGNIA_CLI__ = true;" },
  platform: "node",
  format: "esm",
  target: "node26",
  tsconfig: path.join(root, "tsconfig.json"),
  packages: "external",
  loader: {
    ".ttf": "empty",
    ".css": "empty",
    ".svg": "empty",
    ".woff": "empty",
    ".woff2": "empty",
  },
  plugins: [
    createBundleAgentProtocolDependenciesPlugin(root),
    stubNextPlugin,
    jsonDefaultOnlyPlugin,
  ],
  logLevel: "warning",
})

const smokeArgs = process.argv.slice(2).filter((arg) => arg !== "--deepseek-harness")
if (smokeArgs.includes("--build-only")) {
  process.stdout.write(`built ${path.relative(root, outfile)}\n`)
  process.exit(0)
}

const run = spawnSync(process.execPath, [outfile, ...smokeArgs], { stdio: "inherit" })
process.exit(run.status ?? 1)
