/** Build the pinned optional session-engine artifact; preview packaging is opt-in. */
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { sha256 as digest } from "./source-fingerprint.mjs"

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export { digest }

export function readAgentDesktopPin(root = defaultRoot) {
  const pin = JSON.parse(fs.readFileSync(path.join(root, "integrations/agent-desktop.json"), "utf8"))
  if (pin.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(pin.sourceRevision)
      || !/^[a-f0-9]{64}$/.test(pin.sourceSha256) || !/^[a-f0-9]{64}$/.test(pin.patchSha256)
      || pin.repository !== "vercel-labs/agent-desktop" || pin.profile !== "cognia-bound-window-v1"
      || pin.patch !== "integrations/agent-desktop/patches/cognia-bound-window-v1.patch")
    throw new Error("Invalid agent-desktop compatibility pin")
  const patch = fs.readFileSync(path.join(root, pin.patch))
  if (digest(patch) !== pin.patchSha256) throw new Error("agent-desktop patch integrity mismatch")
  return { ...pin, patchBytes: patch }
}

export function verifyAgentDesktopProfile(envelope, pin) {
  const data = envelope?.data
  if (envelope?.ok !== true || envelope.version !== "2.6" || envelope.command !== "version"
      || data?.version !== pin.version || data.os !== "macos" || data.target !== "aarch64"
      || data.cognia?.profile !== pin.profile || data.cognia.windowBinding !== "per-ax-mutation-v1"
      || data.cognia.supervisorLease !== "inherited-flock-v1" || data.cognia.legacyHostCleanup !== false
      || data.cognia.rendererActivation !== false
      || data.cognia.rendererObservation !== "partial-without-activation-v1")
    throw new Error("agent-desktop executable profile mismatch")
}

function executable(run, root) {
  return (program, args, options = {}) => {
    const result = run(program, args, { cwd: root, encoding: "utf8", timeout: 600_000, ...options })
    if (result.status !== 0) throw new Error(`agent-desktop ${program} failed: ${result.stderr || result.error || result.status}`)
    return result.stdout
  }
}

function regularTree(directory, prefix = "") {
  for (const entry of fs.readdirSync(directory)) {
    const item = path.join(directory, entry)
    const stat = fs.lstatSync(item)
    if (stat.isDirectory()) regularTree(item, prefix + entry + "/")
    else if (prefix + entry === ".claude" && stat.isSymbolicLink() && fs.readlinkSync(item) === ".agents") continue
    else if (!stat.isFile()) throw new Error("agent-desktop source contains a non-regular entry")
  }
}

export function agentDesktopSourceDigest(source) {
  const entries = []
  const walk = (directory, prefix = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!prefix && [".git", "target"].includes(name)) continue
      const file = path.join(directory, name)
      const relative = prefix + name
      const stat = fs.lstatSync(file)
      if (stat.isDirectory()) walk(file, relative + "/")
      else if (stat.isFile()) entries.push([relative, stat.mode & 0o111, digest(fs.readFileSync(file))])
      else if (relative === ".claude" && stat.isSymbolicLink() && fs.readlinkSync(file) === ".agents") entries.push([relative, "symlink", ".agents"])
      else throw new Error("agent-desktop source contains a non-regular entry")
    }
  }
  walk(source)
  return digest(JSON.stringify(entries))
}

export function verifyAgentDesktopReceipt(binary, source, root = defaultRoot) {
  const pin = readAgentDesktopPin(root)
  const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(binary), "receipt.json"), "utf8"))
  if (receipt.sourceRevision !== pin.sourceRevision || receipt.sourceSha256 !== pin.sourceSha256
      || receipt.patchSha256 !== pin.patchSha256 || receipt.profile !== pin.profile
      || receipt.sha256 !== digest(fs.readFileSync(binary))
      || receipt.sourceTreeSha256 !== agentDesktopSourceDigest(source))
    throw new Error("agent-desktop qualification inputs do not match the build receipt")
  return receipt
}

/** Always prepare fresh authenticated bytes; never trust a mutable checkout. */
export function prepareAgentDesktopSource({ root = defaultRoot, cache, run = spawnSync } = {}) {
  const pin = readAgentDesktopPin(root)
  if (!cache) throw new Error("Explicit agent-desktop build cache required")
  fs.mkdirSync(cache, { recursive: true })
  if (fs.lstatSync(cache).isSymbolicLink()) throw new Error("agent-desktop cache must not be a symlink")
  const exec = executable(run, root)
  const archive = path.join(cache, "source.tgz")
  if (!fs.existsSync(archive)) {
    const temporary = `${archive}.${randomUUID()}`
    try {
      exec("curl", ["--fail", "--location", "--proto", "=https", "--tlsv1.2", "--output", temporary,
        `https://codeload.github.com/${pin.repository}/tar.gz/${pin.sourceRevision}`])
      if (digest(fs.readFileSync(temporary)) !== pin.sourceSha256) throw new Error("agent-desktop source integrity mismatch")
      fs.renameSync(temporary, archive)
    } finally { fs.rmSync(temporary, { force: true }) }
  }
  if (!fs.lstatSync(archive).isFile() || digest(fs.readFileSync(archive)) !== pin.sourceSha256)
    throw new Error("agent-desktop source integrity mismatch")
  const source = fs.mkdtempSync(path.join(cache, "source-"))
  try {
    exec("tar", ["-xzf", archive, "--strip-components=1", "-C", source])
    regularTree(source)
    exec("git", ["init", "--quiet"], { cwd: source })
    exec("git", ["apply", "--check", "-"], { cwd: source, input: pin.patchBytes })
    exec("git", ["apply", "-"], { cwd: source, input: pin.patchBytes })
    return { source, pin }
  } catch (error) {
    fs.rmSync(source, { recursive: true, force: true })
    throw error
  }
}

export function stageAgentDesktopRuntime({ root = defaultRoot, run = spawnSync, target = "aarch64-apple-darwin", keepSource = false,
  cache = path.join(root, ".cache/agent-desktop-runtime", target), targetDir } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || target !== "aarch64-apple-darwin")
    return { supported: false, target, reason: "Only native macOS arm64 is supported by this preview builder" }
  fs.mkdirSync(cache, { recursive: true })
  const lock = path.join(cache, "building")
  fs.mkdirSync(lock)
  let source
  try {
    const prepared = prepareAgentDesktopSource({ root, cache, run })
    source = prepared.source
    const { pin } = prepared
    const sourceTreeSha256 = agentDesktopSourceDigest(source)
    const exec = executable(run, root)
    targetDir ??= path.join(cache, "target")
    const environment = { ...process.env, CARGO_TARGET_DIR: targetDir, CARGO_BUILD_JOBS: "4" }
    delete environment.COGNIA_AUTOMATION_LEASE_FD
    delete environment.CARGO_BUILD_TARGET
    exec("cargo", ["build", "--release", "--locked", "-p", "agent-desktop"], {
      cwd: source, env: environment, stdio: "inherit",
    })
    if (agentDesktopSourceDigest(source) !== sourceTreeSha256) throw new Error("agent-desktop build changed its source")
    const bytes = fs.readFileSync(path.join(targetDir, "release/agent-desktop"))
    const sha256 = digest(bytes)
    const artifact = path.join(cache, "artifacts", sha256)
    fs.mkdirSync(artifact, { recursive: true })
    const binary = path.join(artifact, "agent-desktop")
    if (fs.existsSync(binary)) {
      if (digest(fs.readFileSync(binary)) !== sha256) throw new Error("agent-desktop cached artifact integrity mismatch")
    } else {
      fs.writeFileSync(binary, bytes, { mode: 0o755 })
    }
    fs.chmodSync(binary, 0o755)
    const envelope = JSON.parse(exec(binary, ["version"], {
      env: { ...environment, AGENT_DESKTOP_HOME: path.join(cache, "probe-state") },
    }))
    verifyAgentDesktopProfile(envelope, pin)
    const receipt = { schemaVersion: 1, target, version: pin.version, profile: pin.profile,
      sourceRevision: pin.sourceRevision, sourceSha256: pin.sourceSha256,
      patchSha256: pin.patchSha256, sourceTreeSha256, sha256, qualification: "evaluation-only" }
    fs.writeFileSync(path.join(artifact, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n")
    fs.copyFileSync(path.join(source, "LICENSE"), path.join(artifact, "LICENSE"))
    return { supported: true, binary, receipt, ...(keepSource ? { source } : {}) }
  } finally {
    if (source && !keepSource) fs.rmSync(source, { recursive: true, force: true })
    fs.rmdirSync(lock)
  }
}

export function bundleAgentDesktopRuntime({ root = defaultRoot, ...options } = {}) {
  const output = path.join(root, "src-tauri/resources/agent-desktop")
  fs.mkdirSync(output, { recursive: true })
  const clear = () => {
    for (const name of ["agent-desktop", "receipt.json", "agent-desktop.sha256", "LICENSE"]) {
      fs.rmSync(path.join(output, name), { force: true })
    }
  }
  if (process.env.COGNIA_AGENT_DESKTOP_PREVIEW !== "1") {
    clear()
    return { supported: false, reason: "previewDisabled" }
  }
  const result = stageAgentDesktopRuntime({ root, ...options })
  if (!result.supported) { clear(); return result }
  for (const name of ["agent-desktop", "receipt.json", "LICENSE"]) {
    const temporary = path.join(output, `${name}.${randomUUID()}`)
    fs.copyFileSync(path.join(path.dirname(result.binary), name), temporary)
    fs.renameSync(temporary, path.join(output, name))
  }
  fs.chmodSync(path.join(output, "agent-desktop"), 0o755)
  const digestFile = path.join(output, `agent-desktop.sha256.${randomUUID()}`)
  fs.writeFileSync(digestFile, result.receipt.sha256 + "\n")
  fs.renameSync(digestFile, path.join(output, "agent-desktop.sha256"))
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some(arg => !["--bundle", "--keep-source"].includes(arg))) throw new Error("Unknown agent-desktop staging option")
  const prepare = args.includes("--bundle") ? bundleAgentDesktopRuntime : stageAgentDesktopRuntime
  console.log(JSON.stringify(prepare({ keepSource: args.includes("--keep-source") }), null, 2))
}
