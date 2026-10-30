import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const BUILD_DIR = path.join(ROOT, ".cache/bot-e2e")
export const BUILD_MANIFEST = path.join(BUILD_DIR, "build.json")

export async function fileDigest(file) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex")
}

export async function inputDigest(files) {
  const hash = createHash("sha256")
  for (const file of [...new Set(files)].sort()) {
    hash
      .update(file)
      .update("\0")
      .update(await fileDigest(file))
      .update("\0")
  }
  return hash.digest("hex")
}

async function outputFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === "node_modules") continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await outputFiles(file)))
    else if (entry.isFile()) files.push(file)
    else throw new Error("Bot E2E output must contain regular files only")
  }
  return files
}

export async function validateBuild(
  server,
  brain,
  manifestPath = BUILD_MANIFEST,
  checkSources = true
) {
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8").catch(() => {
      throw new Error("Bot E2E build receipt is missing; run pnpm test:e2e:bots:prepare")
    })
  )
  if (
    manifest.server !== server ||
    manifest.brain !== brain ||
    (checkSources && (await inputDigest(manifest.inputs)) !== manifest.inputDigest) ||
    (await inputDigest(await outputFiles(path.dirname(brain)))) !== manifest.outputDigest ||
    (await fileDigest(server)) !== manifest.hostDigest
  ) {
    throw new Error(
      "Bot E2E artifacts or source changed since preparation; run pnpm test:e2e:bots:prepare"
    )
  }
  if (process.env.CI === "true" && !manifest.hostBuiltFromSource)
    throw new Error(
      "CI requires a Host built from current source; --brain-only is a local artifact diagnostic"
    )
  return manifest
}

export async function prepare({ brainOnly = false } = {}) {
  await fs.mkdir(BUILD_DIR, { recursive: true })
  const disk = await fs.statfs(ROOT)
  const minimum = (brainOnly ? 256 : 4096) * 1024 * 1024
  if (disk.bavail * disk.bsize < minimum)
    throw new Error(
      `Bot E2E preparation needs at least ${brainOnly ? "256 MiB" : "4 GiB"} free disk space`
    )
  const metadata = JSON.parse(
    (
      await exec("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
        cwd: ROOT,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout
  )
  const cargoServer = path.join(
    metadata.target_directory,
    "debug",
    process.platform === "win32" ? "cognia-server.exe" : "cognia-server"
  )
  const server = path.resolve(process.env.COGNIA_BOT_E2E_SERVER ?? cargoServer)
  if (!brainOnly && server !== cargoServer)
    throw new Error(
      "A custom Host binary requires --brain-only artifact diagnostics; source preparation uses Cargo's actual output"
    )
  const hostInputs = async () =>
    (
      await exec(
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
          "crates",
          "protocol",
          "sidecar/native-agents/pins.json",
          // Rust embeds non-Rust executable assets (notably the Node plugin
          // host); include their source roots as well as the crate sources.
          "scripts",
          "sidecar",
          "integrations",
        ],
        { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }
      )
    ).stdout
      .split("\0")
      .filter(Boolean)
      .map((file) => path.join(ROOT, file))
  // Artifact diagnostics make no claim about the binary's source snapshot.
  // A source-built Host must capture and verify its full embedded closure.
  const nativeInputs = brainOnly ? [] : await hostInputs()
  const nativeBefore = await inputDigest(nativeInputs)
  const brain = path.join(BUILD_DIR, "brain/cognia-agent.mjs")
  const run = async (command, args) => {
    const child = execFile(command, args, { cwd: ROOT, env: process.env })
    child.stdout.pipe(process.stdout)
    child.stderr.pipe(process.stderr)
    await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Bot E2E preparation failed (${code ?? signal})`))
      )
    })
  }
  await fs.rm(BUILD_MANIFEST, { force: true })
  if (!brainOnly) await run("pnpm", ["terminal-host:prepare:headless"])
  await fs.access(server)
  const inputsPath = path.join(BUILD_DIR, "inputs.json")
  const build = () =>
    run(process.execPath, [
      "scripts/build/build-cli.mjs",
      "--js-only",
      "--outdir",
      path.dirname(brain),
      "--inputs-file",
      inputsPath,
    ])
  await build()
  // esbuild's CLI browser stubs are virtual inputs; their implementation is
  // fingerprinted via esbuild-shared.mjs, which the builder already includes.
  const realInputs = (files) =>
    files.filter((file) => !path.relative(ROOT, file).startsWith("cli-stub:"))
  const inputs = [
    ...realInputs(JSON.parse(await fs.readFile(inputsPath, "utf8"))),
    path.join(ROOT, "pnpm-lock.yaml"),
  ]
  const before = await inputDigest(inputs)
  // The first pass discovers the real esbuild closure. The second proves it
  // was stable while compiling in a shared worktree.
  await build()
  const jsInputs = [
    ...realInputs(JSON.parse(await fs.readFile(inputsPath, "utf8"))),
    path.join(ROOT, "pnpm-lock.yaml"),
  ]
  const nextNativeInputs = brainOnly ? [] : await hostInputs()
  if (
    (await inputDigest(jsInputs)) !== before ||
    (await inputDigest(nextNativeInputs)) !== nativeBefore
  )
    throw new Error(
      "Brain source changed during preparation; retry after the concurrent edit settles"
    )
  const dependencies = path.join(path.dirname(brain), "node_modules")
  const expected = path.join(ROOT, "cli/node_modules")
  try {
    await fs.symlink(expected, dependencies, process.platform === "win32" ? "junction" : "dir")
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      (await fs.realpath(dependencies)) !== (await fs.realpath(expected))
    )
      throw error
  }
  const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim()
  const manifest = {
    schema: "cognia.bot-e2e.build/1",
    preparedAt: new Date().toISOString(),
    revision,
    hostBuiltFromSource: !brainOnly,
    server,
    brain,
    inputs: [...jsInputs, ...nextNativeInputs],
    inputDigest: await inputDigest([...jsInputs, ...nextNativeInputs]),
    outputDigest: await inputDigest(await outputFiles(path.dirname(brain))),
    hostDigest: await fileDigest(server),
  }
  await fs.writeFile(BUILD_MANIFEST, JSON.stringify(manifest, null, 2))
  return manifest
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2).filter((flag) => flag !== "--")
  if (flags.some((flag) => flag !== "--brain-only"))
    throw new Error("Usage: prepare.mjs [--brain-only]")
  await prepare({ brainOnly: flags.includes("--brain-only") })
}
