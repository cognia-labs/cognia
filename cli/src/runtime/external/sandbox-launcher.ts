import { validateExternalAgentSandboxPolicy } from "@cognia/agent-contracts"
import { resolveAgentSearchPath } from "./agent-path"
import { resolveProbeExecutable } from "./version-probe"
import { validateCodexWritableRoots } from "@cognia/agent-codex/app-server-client"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

import {
  bundledCandidates,
  defaultNativeCandidates,
  findNativeBinary,
  isDevCheckout as isRepoCheckout,
  isExecutable as isExecutableFile,
  nativeBinaryName,
} from "../native-binary"

import {
  botRuntimeEnvironment,
  isDshLauncherInvocation,
  type ExternalAgentLaunch,
  type NodeExternalAgentSpawnConfig,
} from "./node-backend"
import { devinOwnedConfigRoot, devinOriginalConfigRoot } from "./devin-mcp-config"
import { hostAgentStateDataDir, type StateIsolationPlan } from "./state-isolation"
import { assertDshWritableRoots } from "./dsh-installer"
import {
  registeredNativeBridgeId,
  registeredNativeBridgeRoot,
  registeredHermesProbeStateRoot,
} from "./native-bridges"
import { toolHostRuntimeDir } from "../../agent/tool-host/protocol"
import { SANDBOX_SUPPORTED_PLATFORMS } from "@/lib/ai/agent/external/policy/security-policy"
import {
  acceptsExtraWritableRoots,
  checkPrivateLaunch,
  companionFor,
  engineTemp,
  hiddenFiles,
  loginRoots,
  programRoots,
  relocatedState,
  withPlatformArgs,
  type RelocatedState,
} from "./launch-descriptor"
import {
  agentStateFileRoots as policyAgentStateFileRoots,
  agentStateWritableRoots as policyAgentStateWritableRoots,
} from "@/lib/ai/agent/external/policy/engine-launch"

/** Base name of the launcher binary built from `crates/cognia-automation`. */
const LAUNCHER_BASE_NAME = "cognia-external-agent-launcher"

export interface SandboxLauncherRuntime {
  platform: NodeJS.Platform
  homedir: string
  candidates: string[]
  isExecutable: (candidate: string) => boolean
  ensureDir?: (candidate: string) => void
  ensureFile?: (candidate: string) => void
  /** True when running from a repo checkout, which unlocks the build hint. */
  isDevCheckout?: () => boolean
  /** Probe only the selected host launcher; never execute a target command. */
  supportsBotIsolation?: (launcher: string) => boolean
}

/** Platform-correct launcher filename. `platform` is a parameter so the Windows
 * spelling is reachable from a test on any host. */
export const launcherName = (platform: NodeJS.Platform = process.platform): string =>
  nativeBinaryName(LAUNCHER_BASE_NAME, platform)

/** Resolve launcher locations for both a single-file bundle and a split `chunks/` bundle. */
export function bundledLauncherCandidates(moduleUrl: string, name: string): string[] {
  return bundledCandidates(moduleUrl, name)
}

function defaultCandidates(): string[] {
  return defaultNativeCandidates({
    base: LAUNCHER_BASE_NAME,
    envVar: "COGNIA_EXTERNAL_AGENT_LAUNCHER",
    moduleUrl: import.meta.url,
  })
}

const isExecutable = isExecutableFile

/** Is this an in-repo checkout (where `pnpm cli:external-host:build` is a real
 * remedy) rather than an installed CLI (where it is noise)? */
export function isDevCheckout(): boolean {
  return isRepoCheckout()
}

/**
 * Why external agents cannot start, phrased for whoever is actually reading it.
 *
 * The build command is a maintainer instruction and is meaningless to someone
 * running an installed `cognia-agent`, so it is appended only in a checkout.
 */
export function sandboxLauncherUnavailableMessage(command: string, devCheckout: boolean): string {
  const base =
    `Can't launch "${command}": the external-agent sandbox launcher is unavailable. ` +
    `Cognia only runs external agents inside a strict sandbox and never falls back to an ` +
    `unsandboxed process. Reinstall cognia-agent, or point COGNIA_EXTERNAL_AGENT_LAUNCHER at a ` +
    `built launcher.`
  return devCheckout ? `${base} (repo checkout: run \`pnpm cli:external-host:build\`)` : base
}

/**
 * The first executable launcher among the candidates, or `undefined`. Exported
 * so `/doctor` can report sandbox readiness WITHOUT attempting a spawn — the
 * external command being on PATH says nothing about whether we can sandbox it.
 */
export function findSandboxLauncher(
  runtime: Pick<SandboxLauncherRuntime, "candidates" | "isExecutable"> = {
    candidates: defaultCandidates(),
    isExecutable,
  }
): string | undefined {
  return findNativeBinary(runtime.candidates, runtime.isExecutable)
}

/** An omitted target keeps this a parser-only capability check, before any sandbox or agent starts. */
export function launcherSupportsBotIsolation(launcher: string): boolean {
  try {
    const probe = spawnSync(launcher, ["--bot-isolation"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16_384,
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? "production" },
    })
    return (
      !probe.error &&
      probe.status === 1 &&
      probe.stderr.trim() === "cognia-external-agent-launcher: missing -- target separator"
    )
  } catch {
    return false
  }
}

/**
 * Can this platform host external agents at all? Fails closed off macOS/Linux.
 *
 * The platform list is the shared security policy's, not a literal here: the
 * settings UI has to be able to say "external agents cannot run on this
 * machine" BEFORE a user configures one, and it cannot import this Node-only
 * module to find out.
 */
export function sandboxSupportsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return (SANDBOX_SUPPORTED_PLATFORMS as readonly string[]).includes(platform)
}

/**
 * Mirror the native wrapper's validation of the host-owned writable-roots
 * hint, honoured only by an engine whose descriptor accepts it.
 */
export function extraWritableRoots(config: NodeExternalAgentSpawnConfig): string[] {
  const raw = config.env?.COGNIA_AGENT_WRITABLE_ROOTS
  if (raw === undefined || !acceptsExtraWritableRoots(config.command, config.args ?? [])) return []
  let requested: string[]
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.some((root) => typeof root !== "string"))
      throw new Error("expected paths")
    requested = value
  } catch {
    console.warn("Ignoring malformed extra writable roots")
    return []
  }
  const report = (root: string, reason: string) =>
    console.warn("Ignoring extra writable root", { root, reason })
  const canonicalize = (root: string): string => {
    let ancestor = root
    const tail: string[] = []
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
      tail.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
    }
    return path.join(fs.realpathSync(ancestor), ...tail)
  }
  let ceiling: string[] | undefined
  const rawCeiling = config.env?.COGNIA_AGENT_WRITABLE_CEILING
  if (rawCeiling !== undefined) {
    try {
      const value: unknown = JSON.parse(rawCeiling)
      if (
        !Array.isArray(value) ||
        value.some((root) => typeof root !== "string" || !path.isAbsolute(root))
      ) {
        throw new Error("expected absolute ceiling roots")
      }
      ceiling = value.map(canonicalize)
    } catch {
      console.warn("Ignoring extra writable roots: invalid session writable ceiling")
      return []
    }
  }
  const canonical = validateCodexWritableRoots(requested, report).flatMap((root) => {
    if (!path.isAbsolute(root)) {
      report(root, "an absolute path on this host is required")
      return []
    }
    try {
      return [canonicalize(root)]
    } catch {
      report(root, "path cannot be resolved on this host")
      return []
    }
  })
  const configuredData = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "cognia")
    : undefined
  let dataRoot = configuredData
  if (configuredData) {
    try {
      dataRoot = canonicalize(configuredData)
    } catch {
      // A missing/unresolvable configured data root must not remove its lexical deny.
    }
  }
  return validateCodexWritableRoots(canonical, report).filter((root) => {
    if (
      ceiling &&
      !ceiling.some((allowed) => {
        const relative = path.relative(allowed, root)
        return (
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        )
      })
    ) {
      report(root, "outside the canonical session writable ceiling")
      return false
    }
    if (
      [dataRoot, configuredData].some(
        (data) => data && (root === data || root.startsWith(`${data}${path.sep}`))
      )
    ) {
      report(root, "Cognia app-data roots cannot be writable")
      return false
    }
    return true
  })
}

function canonicalSandboxPath(candidate: string): string {
  try {
    return fs.realpathSync(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const absolute = path.resolve(candidate)
    const parent = path.dirname(absolute)
    if (parent === absolute) throw error
    return path.join(canonicalSandboxPath(parent), path.basename(absolute))
  }
}

/** Command admission has already pinned the runtime; environment cannot widen its state. */
function managedDshSandboxRoots(config: NodeExternalAgentSpawnConfig) {
  const raw = config.env?.COGNIA_DSH_RUNTIME_HOME
  const invalid = () => new Error("Invalid managed DeepSeek Harness state paths")
  let invocationRoot: string | undefined
  try {
    const launcher = fs.realpathSync(config.args?.[0] ?? "")
    const root = path.dirname(launcher)
    if (isDshLauncherInvocation(config.args ?? [], path.dirname(root))) invocationRoot = root
  } catch {
    // Other runtime commands do not carry a managed launcher path.
  }
  if (raw === undefined) {
    if (invocationRoot)
      throw new Error("Managed DeepSeek Harness host environment and lease are required")
    return undefined
  }
  if (
    !invocationRoot ||
    !path.isAbsolute(raw) ||
    path.basename(config.command) !== "node" ||
    config.args?.length !== 2 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      config.env?.COGNIA_DSH_PROCESS_LEASE ?? ""
    ) ||
    (config.env?.COGNIA_DSH_PROCESS_LEASE_NONCE?.length ?? 0) < 32
  )
    throw invalid()
  const runtimeHome = fs.realpathSync(raw)
  if (runtimeHome !== invocationRoot) throw invalid()
  if (
    fs.realpathSync(config.args[0]) !== path.join(runtimeHome, "launcher.mjs") ||
    !["host.sdk-readonly.yml", "host.sdk-workspace.yml", "host.acp.yml"].some(
      (name) => fs.realpathSync(config.args![1]) === path.join(runtimeHome, name)
    )
  )
    throw invalid()
  const state = [path.join(runtimeHome, "dsh-home"), path.join(runtimeHome, "sessions")]
  for (const [index, key] of ["DSH_HOME", "COGNIA_DSH_SESSION_ROOT"].entries()) {
    const requested = config.env?.[key]
    if (
      (requested !== state[index] && requested !== path.join(raw, path.basename(state[index]))) ||
      canonicalSandboxPath(state[index]) !== state[index]
    )
      throw invalid()
  }
  const controlRoot = path.join(path.dirname(runtimeHome), ".deepseek-harness-control")
  const processes = path.join(controlRoot, "processes")
  if (canonicalSandboxPath(processes) !== processes) throw invalid()
  return { runtimeHome, state, controlRoot, processes }
}

/**
 * The launcher argv for one spawn.
 *
 * `isolation` is the configuration's private state root (ADR-0216), resolved
 * by the backend. When present the root is writable, the runtime's shared
 * default roots leave the writable set and every `denyReadable` root is
 * hidden, so the CLI cannot fall back to the user's own login. Bot and
 * gateway launches never carry one: both already own a private home.
 */
export function buildSandboxLauncherArgs(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  isolation: StateIsolationPlan | null = null
): string[] {
  validateExternalAgentSandboxPolicy(config.sandboxPolicy)
  const managedDsh = managedDshSandboxRoots(config)
  const nativeBridgeRoot = registeredNativeBridgeRoot(config.command, config.args ?? [])
  const crushBridge = registeredNativeBridgeId(config.command, config.args ?? []) === "crush-http"
  const hermesProbeRoot = registeredHermesProbeStateRoot(
    config.command,
    config.args ?? [],
    config.env,
    hostAgentStateDataDir()
  )
  // A private launch's relocation is checked even though its bot state is
  // already its whole writable scope.
  launchRelocation(config, homedir)
  const taskHome = config.env?.COGNIA_GATEWAY_TASK_HOME
  const botIsolation = config.env?.COGNIA_BOT_ISOLATION === "1"
  const botState = config.env?.COGNIA_BOT_STATE_DIR
  if (botIsolation && (!botState || !path.isAbsolute(botState)))
    throw new Error("Bot isolation requires an owned state directory")
  if (hermesProbeRoot)
    config = { ...config, sandboxPolicy: { ...config.sandboxPolicy, readableScope: "workspace" } }
  if (!config.cwd) throw new Error("external-agent sandbox requires a working directory")
  const effectiveHome = taskHome ?? homedir
  const writable = [
    config.cwd,
    ...extraWritableRoots(config),
    ...(crushBridge
      ? policyAgentStateWritableRoots("crush", []).map((root) => path.join(homedir, root))
      : []),
    ...(managedDsh
      ? managedDsh.state
      : botIsolation
        ? [botState!]
        : taskHome
          ? [taskHome]
          : agentStateWritableRoots(config, homedir, isolation)),
    ...(isolation && !managedDsh && !botIsolation && !taskHome ? [isolation.root] : []),
    toolHostRuntimeDir(),
  ]
  const devinConfigRoot = devinOwnedConfigRoot(config)
  if (devinConfigRoot) writable.push(devinConfigRoot)
  if (managedDsh) {
    assertDshWritableRoots(path.dirname(managedDsh.runtimeHome), writable)
  }
  return [
    ...(managedDsh
      ? ["--readable", managedDsh.runtimeHome, "--readable", managedDsh.processes]
      : []),
    ...[nativeBridgeRoot, hermesProbeRoot]
      .filter((root): root is string => !!root)
      .flatMap((root) => ["--readable", root]),
    ...hiddenFiles(config.command, config.args ?? [], config.cwd, homedir).flatMap((file) => [
      "--deny-readable",
      file,
    ]),
    ...(isolation && !botIsolation && !taskHome
      ? isolation.denyReadable.flatMap((root) => ["--deny-readable", root])
      : []),
    ...(config.env?.COGNIA_BOT_ISOLATION === "1"
      ? [
          "--bot-isolation",
          "--deny-readable",
          homedir,
          ...[
            ...[
              ".nvm",
              ".local/bin",
              ".local/share/pnpm",
              ".bun/bin",
              ".cargo/bin",
              ".rustup/toolchains",
              "Library/pnpm",
            ].map((relative) => path.join(homedir, relative)),
            ...programRoots(config.command, config.args ?? [], homedir),
          ].flatMap((root) => ["--readable", root]),
        ]
      : []),
    "--cwd",
    config.cwd,
    ...writable.flatMap((root) => ["--writable", root]),
    ...(!botIsolation
      ? config.sandboxPolicy?.readableScope === "workspace"
        ? [
            "--workspace-readable",
            ...workspaceToolchainReadableRoots(config.command, homedir).flatMap((root) => [
              "--readable",
              root,
            ]),
          ]
        : ["--readable", effectiveHome]
      : []),
    ...(!botIsolation && devinOriginalConfigRoot(config)
      ? ["--readable", devinOriginalConfigRoot(config)!]
      : []),
    ...(taskHome
      ? [
          ...(config.sandboxPolicy?.readableScope === "workspace" ? [] : ["--readable", homedir]),
          // Every engine keeps logins and provider settings in its own roots;
          // a task uses its own, and never reads another task's.
          ...[
            ...loginRoots(homedir),
            path.join(homedir, ".local/share/cognia-agent-tasks"),
          ].flatMap((root) => ["--deny-readable", root]),
        ]
      : []),
    ...(config.sandboxPolicy?.network === "off"
      ? []
      : config.sandboxPolicy?.network === "allowlist"
        ? (config.sandboxPolicy.allowedHosts ?? []).flatMap((host) => ["--network-allow", host])
        : ["--network"]),
    "--",
    config.command,
    ...(config.args ?? []),
  ]
}

/** Match the native wrapper: exact install prefixes, never the whole home. */
export function workspaceToolchainReadableRoots(command: string, home: string): string[] {
  const roots = new Set(
    [".local/bin", ".cargo/bin", ".rustup/toolchains", ".gitconfig", ".config/git"].map((root) =>
      path.join(home, root)
    )
  )
  if (command === "npx") roots.add(path.join(home, ".npm"))
  const broadRoots = new Set([home, path.join(home, ".local"), path.join(home, ".cargo")])
  try {
    const canonicalHome = fs.realpathSync(home)
    for (const root of [
      canonicalHome,
      path.join(canonicalHome, ".local"),
      path.join(canonicalHome, ".cargo"),
    ])
      broadRoots.add(root)
  } catch {
    /* A not-yet-created home still has lexical scope guards. */
  }
  for (const binary of [command, "node"]) {
    const candidates = path.isAbsolute(binary)
      ? [binary]
      : resolveAgentSearchPath()
          .split(path.delimiter)
          .map((dir) => path.join(dir, binary))
    const found = candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile()
      } catch {
        return false
      }
    })
    if (!found) continue
    const executables = [found]
    try {
      executables.push(fs.realpathSync(found))
    } catch {
      /* Lexical install path remains readable. */
    }
    for (const executable of executables) {
      const parent = path.dirname(executable)
      let prefix = path.basename(parent) === "bin" ? path.dirname(parent) : parent
      for (let dir = parent; dir !== path.dirname(dir); dir = path.dirname(dir)) {
        if (path.basename(dir) === "node_modules") {
          prefix = dir
          break
        }
      }
      if ([home, path.join(home, ".local"), path.join(home, ".cargo")].includes(prefix))
        prefix = parent
      if (prefix !== home && prefix !== path.parse(prefix).root) roots.add(prefix)
    }
  }
  return [...roots]
}

/** The launch's relocated state root, resolved against its own home and private state. */
export function launchRelocation(
  config: NodeExternalAgentSpawnConfig,
  homedir: string
): RelocatedState | undefined {
  const taskHome = config.env?.COGNIA_GATEWAY_TASK_HOME
  return relocatedState({
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    cwd: config.cwd,
    home: taskHome ?? homedir,
    privateBase:
      config.env?.COGNIA_BOT_ISOLATION === "1" ? config.env.COGNIA_BOT_STATE_DIR : undefined,
    hostEnvApplies: taskHome === undefined,
  })
}

/**
 * The agent's own state directories, absolute.
 *
 * The RULES live in `protocol/external-agent-security-policy.json` (shared with
 * the Rust launcher, which keeps compiled-in literals and is checked against
 * the same file by `pnpm audit:agent-capabilities`). Only the join to the real
 * home directory happens here. While this list was hand-maintained in two
 * places it lacked an OpenCode rule on both sides, so `opencode serve` could
 * not persist a session inside the sandbox and resume started over every time.
 */
function agentStateWritableRoots(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  isolation: StateIsolationPlan | null = null
): string[] {
  const managedDsh = managedDshSandboxRoots(config)
  if (managedDsh) return managedDsh.state
  if (registeredNativeBridgeId(config.command, config.args ?? []) === "crush-http")
    return policyAgentStateWritableRoots("crush", []).map((root) => path.join(homedir, root))
  const relocated = launchRelocation(config, homedir)
  if (relocated) return relocated.writable
  // An isolated launch writes its own root instead of the shared login roots.
  const shared = new Set(isolation?.sharedRoots ?? [])
  return policyAgentStateWritableRoots(config.command, config.args ?? [])
    .map((root) => path.join(homedir, ...root.split("/")))
    .filter((root) => !shared.has(root))
}

/** The policy's file roots for this launch, absolute. */
function policyFileRoots(config: NodeExternalAgentSpawnConfig, homedir: string): Set<string> {
  return new Set(
    policyAgentStateFileRoots(config.command, config.args ?? []).map((root) =>
      path.join(homedir, ...root.split("/"))
    )
  )
}

function agentStateDirectoryRoots(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  isolation: StateIsolationPlan | null
): string[] {
  const files = policyFileRoots(config, homedir)
  return agentStateWritableRoots(config, homedir, isolation).filter((root) => !files.has(root))
}

function agentStateFileRoots(
  config: NodeExternalAgentSpawnConfig,
  homedir: string,
  isolation: StateIsolationPlan | null
): string[] {
  const files = policyFileRoots(config, homedir)
  return agentStateWritableRoots(config, homedir, isolation).filter((root) => files.has(root))
}

/** The real host runtime. Exported so its fs shims are directly testable — as an
 * inline default-parameter literal they could only be reached by a call that
 * actually spawned an agent and wrote to the user's home. */
export function defaultSandboxRuntime(): SandboxLauncherRuntime {
  return {
    platform: process.platform,
    homedir: os.homedir(),
    candidates: defaultCandidates(),
    isExecutable,
    ensureDir: (candidate) => fs.mkdirSync(candidate, { recursive: true }),
    ensureFile: (candidate) => fs.closeSync(fs.openSync(candidate, "a", 0o600)),
    isDevCheckout,
  }
}

export async function resolveSandboxedExternalAgentLaunch(
  config: NodeExternalAgentSpawnConfig,
  runtime: SandboxLauncherRuntime = defaultSandboxRuntime(),
  isolation: StateIsolationPlan | null = null
): Promise<ExternalAgentLaunch> {
  if (!sandboxSupportsPlatform(runtime.platform)) {
    throw new Error(
      `External agents are not available on ${runtime.platform}: they require a strict sandbox ` +
        `(macOS Seatbelt or Linux bubblewrap), and Cognia never runs them unsandboxed.`
    )
  }
  validateExternalAgentSandboxPolicy(config.sandboxPolicy)
  const hermesHelperRoot = registeredHermesProbeStateRoot(
    config.command,
    config.args ?? [],
    config.env,
    hostAgentStateDataDir()
  )
  if (hermesHelperRoot)
    config = {
      ...config,
      env: { ...config.env, HERMES_HOME: path.join(hermesHelperRoot, "hermes") },
      sandboxPolicy: { ...config.sandboxPolicy, readableScope: "workspace" },
    }
  const isPrivate = config.env?.COGNIA_BOT_ISOLATION === "1"
  checkPrivateLaunch(config.command, config.args ?? [], isPrivate)
  const companion = companionFor(config.command, (command) => resolveProbeExecutable(command))
  config = {
    ...config,
    args: withPlatformArgs(config.command, config.args ?? [], runtime.platform),
  }
  const launcher = findSandboxLauncher(runtime)
  if (!launcher) {
    throw new Error(
      sandboxLauncherUnavailableMessage(config.command, runtime.isDevCheckout?.() ?? false)
    )
  }
  if (
    config.env?.COGNIA_BOT_ISOLATION === "1" &&
    !(runtime.supportsBotIsolation ?? launcherSupportsBotIsolation)(launcher)
  ) {
    throw new Error(
      `BOT_ISOLATION_LAUNCHER_UNSUPPORTED: Selected launcher ${launcher} does not support Bot isolation. ` +
        "Rebuild or reinstall the external-agent launcher and set COGNIA_EXTERNAL_AGENT_LAUNCHER to that executable."
    )
  }
  for (const root of agentStateDirectoryRoots(config, runtime.homedir, isolation))
    runtime.ensureDir?.(root)
  const botRuntime = botRuntimeEnvironment(config.env)
  if (config.env?.COGNIA_BOT_ISOLATION === "1") {
    runtime.ensureDir?.(config.env.COGNIA_BOT_STATE_DIR)
    for (const root of new Set(Object.values(botRuntime))) runtime.ensureDir?.(root)
  }
  let env: Record<string, string> | undefined = hermesHelperRoot
    ? { HERMES_HOME: path.join(hermesHelperRoot, "hermes"), HERMES_TUI_GATEWAY_URL: "" }
    : undefined
  if (registeredNativeBridgeId(config.command, config.args ?? []) === "crush-http")
    env = { TMPDIR: toolHostRuntimeDir(), TMP: toolHostRuntimeDir(), TEMP: toolHostRuntimeDir() }
  const relocated = launchRelocation(config, runtime.homedir)
  if (relocated) {
    for (const root of [relocated.root, ...relocated.writable]) runtime.ensureDir?.(root)
    env = { ...env, ...relocated.env }
  }
  const temp = relocated
    ? relocated.temp
    : engineTemp(
        config.command,
        config.args ?? [],
        config.env ?? {},
        config.env?.COGNIA_GATEWAY_TASK_HOME ?? runtime.homedir,
        isolation !== null
      )
  if (temp && !isPrivate) {
    runtime.ensureDir?.(temp)
    env = { ...env, TMPDIR: temp, TMP: temp, TEMP: temp }
  }
  if (companion) env = { ...env, [companion.env]: companion.helperPath }
  runtime.ensureDir?.(toolHostRuntimeDir())
  for (const root of agentStateFileRoots(config, runtime.homedir, isolation))
    runtime.ensureFile?.(root)
  const args = buildSandboxLauncherArgs(config, runtime.homedir, isolation)
  // Preserve the configured runtime identity while deriving state roots; a
  // system-installed symlink may point at a release executable with another name.
  if (companion) args[args.indexOf("--") + 1] = companion.executablePath
  return {
    command: launcher,
    args,
    ...(env ? { env } : {}),
  }
}
