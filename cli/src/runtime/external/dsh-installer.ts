import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"

import type { DshDoctorReport, DshInstalledRuntimeFacts } from "@cognia/agent-dsh/install"
import {
  buildDshChannelManifest,
  doctorDshRuntime,
  dshPlatformKey,
} from "@cognia/agent-dsh/install"
import type { DshProfileId, DshRuntimeChannel } from "@cognia/agent-dsh/channel"

import { createRuntimeHasher, hashHex } from "../crypto-hasher"

/**
 * Installs the Cognia-owned DeepSeek Harness runtime into an isolated home.
 *
 * The verdict logic lives in `lib/ai/agent/external/runtimes/dsh/dsh-runtime-install.ts` and
 * is pure; this module is only the IO that gathers facts for it and moves bytes.
 * Keeping the split means the Tauri and headless paths cannot drift on what
 * counts as a healthy install.
 *
 * Nothing here touches the user's project: no `package.json` is modified, no
 * dependency is added to the Cognia workspace, and `npx -y` is never used at
 * execution time.
 */

/** Files copied from `packages/agent-dsh/runtime/` into the runtime home. */
export const RUNTIME_ARTIFACTS = [
  "package.json",
  "launcher.mjs",
  "host.root.yml",
  "host.sdk-readonly.yml",
  "host.sdk-workspace.yml",
  "host.acp.yml",
] as const

/** Files whose bytes make up the composition digest, in a stable order. */
const COMPOSITION_DIGEST_FILES = [
  "launcher.mjs",
  "host.root.yml",
  "host.sdk-readonly.yml",
  "host.sdk-workspace.yml",
  "host.acp.yml",
] as const

export const CHANNEL_MANIFEST_FILE = "cognia-channel.json"
export {
  DSH_UPSTREAM_VERSION as UPSTREAM_VERSION,
  DSH_NODE_MAJOR_REQUIRED as NODE_MAJOR_REQUIRED,
  DSH_CONFORMANCE_SUITE_VERSION as CONFORMANCE_SUITE_VERSION,
} from "@cognia/agent-dsh/install"

export interface DshInstallPaths {
  /** Cognia data root, e.g. `~/.cognia`. */
  dataRoot: string
  /** Source directory holding the artifacts (repo `packages/agent-dsh/runtime/`). */
  sourceDir: string
}

export function runtimeHomeFor(dataRoot: string): string {
  return path.join(dataRoot, "deepseek-harness")
}

export function dshHomeFor(dataRoot: string): string {
  // Inside the runtime home, which is what the launcher's containment check
  // requires. DSH's own default (~/.dsh) would be user-writable.
  return path.join(runtimeHomeFor(dataRoot), "dsh-home")
}

function sha256(data: string | Buffer): string {
  return hashHex("sha256", data)
}

/**
 * Digest over the composition and launcher bytes.
 *
 * Each file contributes its name and length as well as its content, so moving
 * bytes between two files cannot produce the same digest.
 */
export function computeCompositionDigest(dir: string): string {
  const hash = createRuntimeHasher("sha256")
  for (const name of COMPOSITION_DIGEST_FILES) {
    const content = fs.readFileSync(path.join(dir, name))
    hash.update(name).update("\0").update(String(content.length)).update("\0").update(content)
  }
  return hash.digest("hex")
}

export function computeLockfileDigest(runtimeHome: string): string {
  return sha256(fs.readFileSync(path.join(runtimeHome, "package-lock.json")))
}

export interface InstallOptions extends DshInstallPaths {
  /** Emits progress lines. Never receives credential material. */
  onProgress?: (line: string) => void
  /** Overridable for tests; defaults to spawning real npm. */
  runNpmInstall?: (cwd: string) => Promise<void>
}

export class DshInstallError extends Error {}

const INSTALL_READY_FILE = ".cognia-install.json"
const SAFE_INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface OwnershipRecord {
  schemaVersion: 1 | 2
  pid: number
  operationId?: string
  processId?: string
  childPid?: number
  nonceDigest?: string
  bootId?: string
  retirementRequired?: boolean
  retired?: boolean
  legacyRecord?: string
}

function validBootId(value: unknown): value is string {
  return typeof value === "string" && SAFE_INSTALL_ID.test(value) && value === value.toLowerCase()
}

/** Only a kernel boot identifier may invalidate uncertain ownership. */
export function dshBootId(): string {
  let value: string
  if (process.platform === "linux")
    value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
  else if (process.platform === "darwin")
    value = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" })
  else throw new DshInstallError("DeepSeek Harness ownership requires a supported boot identity")
  const identity = value.trim().toLowerCase()
  if (!validBootId(identity)) throw new DshInstallError("Cannot verify system boot identity")
  return identity
}

function ownedDirectory(dir: string): void {
  if (
    fs.existsSync(dir) &&
    (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory())
  ) {
    throw new DshInstallError(`Runtime control directory is not an owned directory: ${dir}`)
  }
  fs.mkdirSync(dir, { recursive: true })
}

export function dshControlRootFor(dataRoot: string): string {
  return path.join(dataRoot, ".deepseek-harness-control")
}

export function canonicalDshPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const absolute = path.resolve(candidate)
    const parent = path.dirname(absolute)
    if (parent === absolute) throw error
    return path.join(canonicalDshPath(parent), path.basename(absolute))
  }
}

/** Enforced before any resolver so native workspace-write cannot alter host authority. */
export function assertDshWritableRoots(dataRoot: string, roots: readonly string[]): void {
  const runtime = fs.realpathSync(runtimeHomeFor(dataRoot))
  const control = canonicalDshPath(dshControlRootFor(dataRoot))
  const data = canonicalDshPath(dataRoot)
  const state = [path.join(runtime, "dsh-home"), path.join(runtime, "sessions")]
  const inside = (candidate: string, parent: string) => {
    const relative = path.relative(parent, candidate)
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  for (const root of roots) {
    if (!path.isAbsolute(root))
      throw new DshInstallError("Managed DSH writable roots must be absolute")
    const canonical = canonicalDshPath(root)
    const reserved = path.relative(data, canonical).split(path.sep)[0]
    const overlapsInactiveCode =
      reserved === "deepseek-harness.previous" ||
      reserved === "deepseek-harness.staging" ||
      reserved.startsWith("deepseek-harness.staging-")
    const overlapsControl = inside(canonical, control) || inside(control, canonical)
    const overlapsRuntime = inside(canonical, runtime) || inside(runtime, canonical)
    if (
      overlapsControl ||
      overlapsInactiveCode ||
      (overlapsRuntime && !state.some((dir) => inside(canonical, dir)))
    ) {
      throw new DshInstallError(
        "Managed DeepSeek Harness writable roots overlap host control or runtime code"
      )
    }
  }
}

function controlDirectories(dataRoot: string) {
  const control = dshControlRootFor(dataRoot)
  ownedDirectory(control)
  const maintenance = path.join(control, "maintenance")
  const processes = path.join(control, "processes")
  ownedDirectory(maintenance)
  ownedDirectory(processes)
  return { maintenance, processes }
}

function publishRecord(file: string, record: OwnershipRecord, createOnly = false): void {
  const temporary = path.join(path.dirname(file), `${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 })
    if (createOnly) {
      try {
        fs.linkSync(temporary, file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    } else fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function validLegacyBinding(filename: string, legacyRecord: unknown): boolean {
  if (legacyRecord === undefined) return !filename.startsWith("legacy-")
  return (
    typeof legacyRecord === "string" &&
    legacyRecord.endsWith(".json") &&
    path.basename(legacyRecord) === legacyRecord &&
    filename === `legacy-${sha256(legacyRecord)}.json`
  )
}

function validateOwnershipRecord(
  record: OwnershipRecord,
  file: string,
  kind: "maintenance" | "processes"
): void {
  if (
    (record?.schemaVersion !== 1 && (kind !== "processes" || record?.schemaVersion !== 2)) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    (kind === "maintenance" &&
      (typeof record.operationId !== "string" || !SAFE_INSTALL_ID.test(record.operationId))) ||
    (record.childPid !== undefined &&
      (!Number.isSafeInteger(record.childPid) || record.childPid <= 0)) ||
    (record.processId !== undefined && typeof record.processId !== "string") ||
    (record.nonceDigest !== undefined &&
      (typeof record.nonceDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.nonceDigest))) ||
    (record.schemaVersion === 1 && record.legacyRecord !== undefined)
  )
    throw new Error("invalid ownership record")
  if (
    record.schemaVersion === 2 &&
    (!validBootId(record.bootId) ||
      record.retirementRequired !== true ||
      record.retired !== false ||
      !validLegacyBinding(path.basename(file), record.legacyRecord))
  )
    throw new Error("invalid retirement record")
}

function quarantineObservedProcess(
  dir: string,
  name: string,
  currentBoot: string,
  source?: OwnershipRecord
): boolean {
  const shadow = path.join(dir, `legacy-${sha256(name)}.json`)
  publishRecord(
    shadow,
    {
      ...(source ?? { pid: process.pid }),
      schemaVersion: 2,
      bootId: currentBoot,
      retirementRequired: true,
      retired: false,
      legacyRecord: name,
    },
    true
  )
  const metadata = fs.lstatSync(shadow)
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new DshInstallError("Cannot establish legacy runtime retirement")
  const quarantine = JSON.parse(fs.readFileSync(shadow, "utf8")) as OwnershipRecord
  validateOwnershipRecord(quarantine, shadow, "processes")
  if (
    quarantine.schemaVersion !== 2 ||
    quarantine.legacyRecord !== name ||
    !validBootId(quarantine.bootId)
  )
    throw new DshInstallError("Cannot establish legacy runtime retirement")
  return quarantine.bootId === currentBoot
}

function hasLiveOwner(dir: string, kind: "maintenance" | "processes", own?: string): boolean {
  const currentBoot = kind === "processes" ? dshBootId() : undefined
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".tmp")) continue
    const file = path.join(dir, name)
    if (file === own) continue
    let record: OwnershipRecord
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular record")
      record = JSON.parse(fs.readFileSync(file, "utf8")) as OwnershipRecord
      validateOwnershipRecord(record, file, kind)
    } catch (error) {
      if (kind === "processes") quarantineObservedProcess(dir, name, currentBoot!)
      throw new DshInstallError(
        `Cannot establish runtime ownership from ${file}: ${(error as Error).message}`
      )
    }
    if (kind === "processes" && record.schemaVersion === 1) {
      if (quarantineObservedProcess(dir, name, currentBoot!, record)) return true
      continue
    }
    if (record.schemaVersion === 2) {
      if (record.bootId !== currentBoot) continue
      return true
    }
    if (pidIsLive(record.pid) || (record.childPid !== undefined && pidIsLive(record.childPid)))
      return true
  }
  return false
}

export interface DshProcessLease {
  readonly leaseId: string
  readonly nonce: string
  updateChildPid(childPid: number): void
  release(): void
}

/** Publish before checking maintenance, including the pending-launch interval. */
export function acquireDshProcessLease(dataRoot: string, processId?: string): DshProcessLease {
  const dirs = controlDirectories(dataRoot)
  const leaseId = randomUUID()
  const nonce = randomUUID()
  const file = path.join(dirs.processes, `${leaseId}.json`)
  const record: OwnershipRecord = {
    schemaVersion: 2,
    pid: process.pid,
    nonceDigest: sha256(nonce),
    bootId: dshBootId(),
    retirementRequired: true,
    retired: false,
    ...(processId ? { processId } : {}),
  }
  publishRecord(file, record)
  let released = false
  const release = () => {
    if (released) return
    if (record.childPid !== undefined) return
    fs.rmSync(file, { force: true })
    released = true
  }
  try {
    if (hasLiveOwner(dirs.maintenance, "maintenance"))
      throw new DshInstallError("Runtime maintenance is in progress")
  } catch (error) {
    release()
    throw error
  }
  return {
    leaseId,
    nonce,
    updateChildPid(childPid) {
      if (released || !Number.isSafeInteger(childPid) || childPid <= 0)
        throw new DshInstallError("Invalid runtime child lease")
      record.childPid = childPid
      publishRecord(file, record)
    },
    release,
  }
}

function acquireMaintenance(dataRoot: string): () => void {
  const dirs = controlDirectories(dataRoot)
  const operationId = randomUUID()
  const file = path.join(dirs.maintenance, `${operationId}.json`)
  publishRecord(file, { schemaVersion: 1, pid: process.pid, operationId })
  const release = () => fs.rmSync(file, { force: true })
  try {
    if (hasLiveOwner(dirs.maintenance, "maintenance", file))
      throw new DshInstallError("Runtime maintenance is already in progress")
    if (hasLiveOwner(dirs.processes, "processes"))
      throw new DshInstallError(
        "Runtime process leases remain active or retirement is unverified; restart the system before runtime maintenance if retirement cannot be proved"
      )
    return release
  } catch (error) {
    release()
    throw error
  }
}

function recoverPrevious(dataRoot: string): void {
  const home = runtimeHomeFor(dataRoot)
  const previous = `${home}.previous`
  if (!fs.existsSync(previous)) return
  if (fs.existsSync(home)) {
    throw new DshInstallError(
      `Runtime recovery requires inspection of both ${home} and ${previous}; neither was deleted`
    )
  }
  fs.renameSync(previous, home)
}

/** Preserve internal links without importing files or authority from sibling trees. */
function validateDurableTree(dir: string, home: string, root = true): void {
  const stat = fs.lstatSync(dir)
  if (stat.isSymbolicLink()) {
    if (root) throw new DshInstallError(`Durable runtime root must not be a symlink: ${dir}`)
    const relative = path.relative(fs.realpathSync(home), fs.realpathSync(dir))
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new DshInstallError(`Durable runtime link escapes its runtime: ${dir}`)
    }
  } else if (stat.isDirectory()) {
    for (const name of fs.readdirSync(dir)) validateDurableTree(path.join(dir, name), home, false)
  } else if (root) {
    throw new DshInstallError(`Durable runtime root must be a directory: ${dir}`)
  }
}

/**
 * Install or reinstall the runtime.
 *
 * Atomic in the sense that matters: the new tree is built beside the live one
 * and swapped in only after `npm install` succeeds, so a failed install leaves
 * the previously certified runtime untouched.
 */
export async function installDshRuntime(options: InstallOptions): Promise<DshRuntimeChannel> {
  options.onProgress?.("Installing DeepSeek Harness packages…")
  const staged = await stageDshInstall(options)
  const channel = buildDshChannelManifest(staged)
  finalizeDshInstall(options.dataRoot, `${JSON.stringify(channel, null, 2)}\n`, staged.installId)
  options.onProgress?.(`Installed channel ${channel.channelId}`)
  return channel
}

async function defaultNpmInstall(cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npm",
      [
        "install",
        // koffi is a hard dependency of dsh-fs-local but is imported only from a
        // Windows-only code path, so it is installed and never built. Skipping
        // scripts also removes an arbitrary-code-execution step from install.
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock-only=false",
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] }
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm exited ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

/**
 * Paths under `DSH_HOME` that DSH would apply as user patch layers.
 *
 * These apply after every bundle layer and may run arbitrary JavaScript through
 * the `!!js` YAML tag, so their presence means the composition digest no longer
 * describes what will actually be mounted.
 */
export function findStrayPatchLayers(dshHome: string): string[] {
  const found: string[] = []
  const exists = (file: string) => {
    try {
      return fs.lstatSync(file)
    } catch {
      return undefined
    }
  }
  for (const name of ["cordis.patch.yml", ".env"]) {
    const candidate = path.join(dshHome, name)
    if (exists(candidate)) found.push(candidate)
  }
  const profilesDir = path.join(dshHome, "profiles")
  const profilesStat = exists(profilesDir)
  if (!profilesStat) return found
  if (!profilesStat.isDirectory() || profilesStat.isSymbolicLink()) return [...found, profilesDir]
  for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
    // The official CLI installs a dependency lookup link alongside profiles.
    if (entry.name === "node_modules") continue
    const profileDir = path.join(profilesDir, entry.name)
    if (entry.isSymbolicLink()) {
      found.push(profileDir)
      continue
    }
    if (!entry.isDirectory()) continue
    for (const name of ["cordis.patch.yml", "package.json"]) {
      const candidate = path.join(profileDir, name)
      const stat = exists(candidate)
      if (!stat) continue
      let managed = false
      if (
        name === "package.json" &&
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        ["cognia-sdk-readonly", "cognia-sdk-workspace", "cognia-acp"].includes(entry.name)
      ) {
        try {
          // Mirrors launcher.mjs managedProfileManifest; no dependencies or extra fields.
          managed = isDeepStrictEqual(JSON.parse(fs.readFileSync(candidate, "utf8")), {
            name: entry.name,
            private: true,
            type: "module",
            dsh: { profile: { bundles: ["@deepseek-ai/dsh-sdk-minimal"], patchReload: "startup" } },
          })
        } catch {
          managed = false
        }
      }
      if (!managed) found.push(candidate)
    }
  }
  return found.sort()
}

/** Whether a C/C++ toolchain is present, for profiles needing a node-pty build. */
export function hasNativeToolchain(): boolean {
  return ["cc", "gcc", "clang"].some((binary) =>
    (process.env.PATH ?? "")
      .split(path.delimiter)
      .some((dir) => dir && fs.existsSync(path.join(dir, binary)))
  )
}

export interface DoctorOptions extends Pick<DshInstallPaths, "dataRoot"> {
  profileId: DshProfileId
  nodeVersion?: string
  platform?: string
}

/** Gather facts from disk and hand them to the pure verdict function. */
export function doctorInstalledDshRuntime(options: DoctorOptions): DshDoctorReport {
  const runtimeHome = runtimeHomeFor(options.dataRoot)
  const manifestPath = path.join(runtimeHome, CHANNEL_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    return {
      healthy: false,
      findings: [
        {
          code: "channel-malformed",
          severity: "error",
          detail: "no runtime is installed",
        },
      ],
    }
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  } catch (error) {
    return {
      healthy: false,
      findings: [
        { code: "channel-malformed", severity: "error", detail: (error as Error).message },
      ],
    }
  }

  const facts: DshInstalledRuntimeFacts = {
    lockfileDigest: safe(() => computeLockfileDigest(runtimeHome)),
    compositionDigest: safe(() => computeCompositionDigest(runtimeHome)),
    nodeVersion: options.nodeVersion ?? process.version,
    platform: options.platform ?? dshPlatformKey(process.platform, process.arch),
    strayPatchPaths: findStrayPatchLayers(path.join(runtimeHome, "dsh-home")),
    hasNativeToolchain: hasNativeToolchain(),
  }
  return doctorDshRuntime(manifest, facts, options.profileId)
}

/** A missing or unreadable file yields a digest that cannot match, never a throw. */
function safe(compute: () => string): string {
  try {
    return compute()
  } catch {
    return "unreadable"
  }
}

export interface RemoveOptions extends Pick<DshInstallPaths, "dataRoot"> {
  /** Sessions still using the runtime; removal is refused while any is live. */
  activeSessionCount?: number
}

export function removeDshRuntime(options: RemoveOptions): void {
  if ((options.activeSessionCount ?? 0) > 0) {
    throw new DshInstallError(
      `Refusing to remove the runtime while ${options.activeSessionCount} session(s) are still using it.`
    )
  }
  const release = acquireMaintenance(options.dataRoot)
  try {
    const runtimeHome = runtimeHomeFor(options.dataRoot)
    recoverPrevious(options.dataRoot)
    fs.rmSync(runtimeHome, { recursive: true, force: true })
    fs.rmSync(`${runtimeHome}.staging`, { recursive: true, force: true })
    for (const name of fs.readdirSync(options.dataRoot)) {
      const id = name.slice("deepseek-harness.staging-".length)
      if (name.startsWith("deepseek-harness.staging-") && SAFE_INSTALL_ID.test(id)) {
        fs.rmSync(path.join(options.dataRoot, name), { recursive: true, force: true })
      }
    }
  } finally {
    release()
  }
}

/** Relocated host data root, otherwise the CLI's `~/.cognia` convention. */
export function defaultDataRoot(): string {
  return process.env.COGNIA_DATA_DIR?.trim() || path.join(os.homedir(), ".cognia")
}

// ── Host surface shared with the Tauri commands ──────────────────────────────
//
// `dsh_runtime_facts` / `dsh_runtime_install` / `dsh_runtime_finalize` /
// `dsh_runtime_remove` exist in both hosts with the same shapes, so the
// renderer runs one flow everywhere and the verdict is always rendered by the
// shared `doctorDshRuntime()`.

export interface DshInstallDigests {
  installId: string
  lockfileDigest: string
  compositionDigest: string
}

/** Gather install facts; never throws, so a broken install stays diagnosable. */
export function gatherDshRuntimeFacts(dataRoot: string): {
  runtimeHome: string
  nodePath: string
  defaultWorkspace: string
  parentEnv: Record<string, string>
  manifestJson: string | null
  lockfileDigest: string
  compositionDigest: string
  nodeVersion: string
  platform: string
  strayPatchPaths: string[]
  hasNativeToolchain: boolean
} {
  const home = runtimeHomeFor(dataRoot)
  let manifestJson: string | null = null
  try {
    manifestJson = fs.readFileSync(path.join(home, CHANNEL_MANIFEST_FILE), "utf8")
  } catch {
    manifestJson = null
  }
  return {
    runtimeHome: home,
    nodePath: process.execPath,
    defaultWorkspace: process.cwd(),
    parentEnv: Object.fromEntries(
      ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]!]] : []
      )
    ),
    manifestJson,
    // "unreadable" can never equal a certified digest, so the verdict function
    // reports a mismatch rather than the whole check throwing.
    lockfileDigest: safe(() => computeLockfileDigest(home)),
    compositionDigest: safe(() => computeCompositionDigest(home)),
    nodeVersion: process.version,
    platform: dshPlatformKey(process.platform, process.arch),
    strayPatchPaths: findStrayPatchLayers(dshHomeFor(dataRoot)),
    hasNativeToolchain: hasNativeToolchain(),
  }
}

/**
 * Stage a runtime and install its dependencies, returning the digests.
 *
 * The live runtime is untouched until {@link finalizeDshInstall}.
 */
export async function stageDshInstall(
  options: DshInstallPaths & { runNpmInstall?: (cwd: string) => Promise<void> }
): Promise<DshInstallDigests> {
  const { dataRoot, sourceDir } = options
  const installId = randomUUID()
  const staging = `${runtimeHomeFor(dataRoot)}.staging-${installId}`

  for (const artifact of RUNTIME_ARTIFACTS) {
    if (!fs.existsSync(path.join(sourceDir, artifact))) {
      throw new DshInstallError(`Runtime artifact missing from source: ${artifact}`)
    }
  }

  const release = acquireMaintenance(dataRoot)
  try {
    recoverPrevious(dataRoot)
    fs.mkdirSync(staging)
    for (const artifact of RUNTIME_ARTIFACTS) {
      fs.copyFileSync(path.join(sourceDir, artifact), path.join(staging, artifact))
    }
    fs.mkdirSync(path.join(staging, "dsh-home"))
    await (options.runNpmInstall ?? defaultNpmInstall)(staging)
    if (!fs.existsSync(path.join(staging, "package-lock.json"))) {
      throw new DshInstallError("npm install produced no package-lock.json; refusing to certify.")
    }
    const digests = {
      installId,
      lockfileDigest: computeLockfileDigest(staging),
      compositionDigest: computeCompositionDigest(staging),
    }
    fs.writeFileSync(
      path.join(staging, INSTALL_READY_FILE),
      JSON.stringify({ schemaVersion: 1, ...digests }),
      { flag: "wx" }
    )
    return digests
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    if (error instanceof DshInstallError) throw error
    throw new DshInstallError(
      `npm install failed; the previous runtime was left in place. ${(error as Error).message}`
    )
  } finally {
    release()
  }
}

/** Write the renderer-built manifest and activate the staged runtime. */
export function finalizeDshInstall(
  dataRoot: string,
  manifestJson: string,
  installId: string
): void {
  if (!SAFE_INSTALL_ID.test(installId))
    throw new DshInstallError("Invalid runtime install identifier")
  const home = runtimeHomeFor(dataRoot)
  const staging = `${home}.staging-${installId}`
  const previous = `${home}.previous`
  const release = acquireMaintenance(dataRoot)
  try {
    recoverPrevious(dataRoot)
    if (!fs.existsSync(staging) || fs.lstatSync(staging).isSymbolicLink()) {
      throw new DshInstallError("No owned staged runtime to finalize.")
    }
    const ready = JSON.parse(fs.readFileSync(path.join(staging, INSTALL_READY_FILE), "utf8"))
    const manifest = JSON.parse(manifestJson)
    if (
      ready.schemaVersion !== 1 ||
      ready.installId !== installId ||
      ready.lockfileDigest !== computeLockfileDigest(staging) ||
      ready.compositionDigest !== computeCompositionDigest(staging) ||
      manifest.lockfileDigest !== ready.lockfileDigest ||
      manifest.compositionDigest !== ready.compositionDigest
    )
      throw new DshInstallError(
        "Staged runtime digests do not match its ready marker and channel manifest"
      )
    if (!isDeepStrictEqual(manifest, buildDshChannelManifest(ready)))
      throw new DshInstallError("Channel manifest does not match the current runtime certification")
    for (const name of ["sessions", "dsh-home"]) {
      const source = path.join(home, name)
      if (!fs.existsSync(source)) continue
      validateDurableTree(source, home)
      fs.rmSync(path.join(staging, name), { recursive: true, force: true })
      fs.cpSync(source, path.join(staging, name), { recursive: true, verbatimSymlinks: true })
    }
    fs.writeFileSync(path.join(staging, CHANNEL_MANIFEST_FILE), manifestJson)
    if (fs.existsSync(home)) fs.renameSync(home, previous)
    try {
      fs.renameSync(staging, home)
    } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, home)
      throw error
    }
    fs.rmSync(previous, { recursive: true, force: true })
  } catch (error) {
    if (error instanceof DshInstallError) throw error
    throw new DshInstallError(`Cannot activate staged runtime: ${(error as Error).message}`)
  } finally {
    release()
  }
}
