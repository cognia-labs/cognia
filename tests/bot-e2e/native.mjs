import { spawn, execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const digest = async (file) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")
async function sources() {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    })
  )
  const packages = new Map(metadata.packages.map((pkg) => [path.dirname(pkg.manifest_path), pkg]))
  const directories = new Set()
  const visit = (directory) => {
    if (directories.has(directory)) return
    directories.add(directory)
    for (const dependency of packages.get(directory)?.dependencies ?? []) {
      if (dependency.path && dependency.kind !== "dev") visit(dependency.path)
    }
  }
  visit(path.join(root, "crates/cognia-connectors"))
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "Cargo.toml",
      "Cargo.lock",
      "rust-toolchain.toml",
      ".cargo",
      ...[...directories].map((directory) => path.relative(root, directory)),
      "tests/bot-e2e/native-bridge.rs",
      "tests/bot-e2e/tauri-bridge.rs",
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 }
  )
    .toString()
    .split("\0")
    .filter(Boolean)
  const hash = createHash("sha256")
  for (const file of [...new Set(files)].sort())
    hash
      .update(file)
      .update("\0")
      .update(await digest(path.join(root, file)))
      .update("\0")
  return hash.digest("hex")
}
export function nativeArtifact(message, tauri = false) {
  const name = tauri ? "connector-tauri-fixture" : "connector-native-fixture"
  const source = tauri ? "tauri-bridge.rs" : "native-bridge.rs"
  if (
    message.reason === "compiler-artifact" &&
    message.target?.name === name &&
    message.target.kind?.includes("bin") &&
    path.resolve(message.target.src_path) === path.join(root, "tests/bot-e2e", source) &&
    typeof message.executable === "string"
  )
    return message.executable
}
async function run(command, args, env = process.env, onLine) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: ["inherit", onLine ? "pipe" : "inherit", "inherit"],
  })
  if (onLine) createInterface({ input: child.stdout }).on("line", onLine)
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  if (code !== 0) throw new Error(`${command} exited ${code}`)
}
export async function nativeMain({ browser = false, tauri = false, verificationUi = false } = {}) {
  if (verificationUi && !browser) throw new Error("--verification-ui requires --browser")
  const suite = browser
    ? verificationUi
      ? "matrix-verification-ui"
      : "matrix-browser"
    : tauri
      ? "matrix-verification-native"
      : "im-native"
  const before = await sources()
  const runId = randomUUID()
  const artifacts = new Set()
  await run(
    "cargo",
    [
      "build",
      "--locked",
      "-p",
      "cognia-connectors",
      "--bin",
      tauri ? "connector-tauri-fixture" : "connector-native-fixture",
      "--features",
      tauri ? "native-test-fixture,tauri-host" : "native-test-fixture",
      "-j",
      "2",
      "--message-format=json-render-diagnostics",
    ],
    process.env,
    (line) => {
      const binary = nativeArtifact(JSON.parse(line), tauri)
      if (binary) artifacts.add(binary)
    }
  )
  if (artifacts.size !== 1)
    throw new Error("Cargo did not return exactly one native fixture executable")
  const [binary] = artifacts
  if (before !== (await sources()))
    throw new Error("Native source changed during build; rerun native tests")
  const binaryDigest = await digest(binary)
  const directory = path.join(
    root,
    tauri
      ? browser
        ? ".cache/test-results/im-tauri-browser"
        : ".cache/test-results/im-tauri-native"
      : browser
        ? ".cache/test-results/im-browser-native"
        : ".cache/test-results/im-native"
  )
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, "build.json"),
    JSON.stringify(
      {
        schema: "cognia.im-native-build/1",
        suite,
        runId,
        builtAt: new Date().toISOString(),
        sourceDigest: before,
        binaryDigest,
        binary,
        realPlatform: false,
        actualTauriIpc: tauri,
        fullApp: false,
      },
      null,
      2
    ) + "\n"
  )
  await run(
    process.execPath,
    browser
      ? [
          "node_modules/@playwright/test/cli.js",
          "test",
          "--config",
          "playwright.matrix.config.ts",
          ...(verificationUi ? ["--grep", "Matrix operator"] : []),
        ]
      : [
          "scripts/test/jest.mjs",
          "--",
          "--runInBand",
          tauri
            ? "cli/src/serve/connector-matrix-verification-native.test.ts"
            : "cli/src/(serve/connector-(native|matrix-native|matrix-media-native|matrix-sync-native|matrix-backup-native|matrix-cross-signing-native|matrix-verification-native|ws\\.loopback|wechat\\.loopback)|test-support/connector-native)\\.test\\.ts$",
        ],
    {
      ...process.env,
      COGNIA_IM_NATIVE: "1",
      COGNIA_IM_TAURI: tauri ? "1" : "0",
      COGNIA_IM_BROWSER_SUITE: verificationUi ? "matrix-verification-ui" : "matrix-browser",
      COGNIA_IM_NATIVE_BINARY: binary,
      COGNIA_IM_NATIVE_DIGEST: binaryDigest,
      COGNIA_IM_NATIVE_SOURCE: before,
      COGNIA_IM_NATIVE_RUN: runId,
      COGNIA_IM_NATIVE_REPORT_DIR: directory,
    }
  )
  if (before !== (await sources()) || binaryDigest !== (await digest(binary)))
    throw new Error("Native source/artifact changed during tests; results are stale")
  await fs.writeFile(
    path.join(directory, "run.json"),
    JSON.stringify(
      {
        runId,
        sourceDigest: before,
        binaryDigest,
        passed: true,
        suite,
        actualTauriIpc: tauri,
        finishedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  )
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2)
  if (flags.some((flag) => !["--browser", "--tauri", "--verification-ui"].includes(flag)))
    throw new Error("Usage: native.mjs [--browser] [--tauri] [--verification-ui]")
  await nativeMain({
    browser: flags.includes("--browser"),
    tauri: flags.includes("--tauri"),
    verificationUi: flags.includes("--verification-ui"),
  })
}
