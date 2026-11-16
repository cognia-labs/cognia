/**
 * What an external engine needs from the process host to launch, declared by
 * the engine's own package (ADR-0217) and interpreted generically by every
 * host. The process hosts (`crates/cognia-external-agent`,
 * `cli/src/runtime/external`) name no engine: they read these descriptors
 * from `protocol/external-agent-launch.json`, which
 * `scripts/build/gen-external-agent-launch.mjs` writes from the packages.
 *
 * A descriptor relocates and narrows. It cannot widen what the host allows:
 * every path stays home-relative or inside a root the host owns, and the
 * host's own invariants (writable scope, loader-env denial, the admission
 * allowlist) apply to every launch regardless of what a descriptor says.
 * A spawn request never carries a descriptor; the host looks it up by the
 * launch target.
 */

/**
 * How a descriptor matches a launch target. `base` is the command without
 * directory or Windows executable suffix, lower-cased; `target` is the npx
 * package for an `npx` launch, otherwise the base. `contains` matches a
 * substring of the target.
 */
export interface EngineLaunchMatch {
  kind: "base" | "target" | "contains"
  values: readonly string[]
}

/** How an engine's state moves into a configuration's private root (ADR-0216). */
export interface EngineStateIsolation {
  /** Env key -> path relative to the private root. */
  env: Readonly<Record<string, string>>
  /** Fixed env an isolated launch needs (Goose's keyring switch). */
  setEnv?: Readonly<Record<string, string>>
  /** Writable state roots the private root replaces; defaults to `stateRoots`. */
  sharedRoots?: readonly string[]
  /** Home-relative paths hidden so the engine cannot fall back to the shared login. */
  denyReadable: readonly string[]
}

/**
 * Where an engine lets its user move its own state, described as the engine
 * resolves it. The host applies the same rules to every relocation: a flag
 * beats the env keys, a request env value beats the host's (which never
 * applies to a gateway task), a relative value resolves against the working
 * directory, and a private launch's root must stay inside its own state.
 * The resolved root (or its `writable` sub-paths) replaces the engine's
 * `stateRoots` in the writable set, and every `env` key is set to it.
 */
export interface EngineStateRelocation {
  /** Env keys the engine reads, in its own precedence order. */
  env: readonly string[]
  /** Flags that select the root; `pick` follows the engine's own parser. */
  args?: Readonly<{ flags: readonly string[]; pick: "first" | "last" }>
  /** Flags whose state the host cannot scope; a launch naming one is refused. */
  refusedArgs?: readonly string[]
  /** The engine treats an empty env value as unset; otherwise an empty selection is refused. */
  skipEmpty?: boolean
  /** The engine trims the selected value. */
  trim?: boolean
  /** The engine expands a leading `~`. */
  expandTilde?: boolean
  /**
   * The root when nothing selects one, relative to the launch's home. Absent:
   * the relocation applies only when selected, and the declared state roots
   * stand otherwise.
   */
  default?: string
  /** Writable sub-paths of the root; absent makes the whole root writable. */
  writable?: readonly string[]
  /** Root-relative temp directory for TMPDIR, TMP and TEMP. */
  temp?: string
  /** Env a relocated launch always carries (update and telemetry switches). */
  setEnv?: Readonly<Record<string, string>>
}

/** A temp directory for an engine without a relocation. */
export interface EngineTempDirectory {
  /** Relative to the launch's home. */
  home: string
  /** Under a private state root: relative to the value of this isolation env key. */
  isolated?: Readonly<{ env: string; path: string }>
}

/**
 * A helper executable the engine loads from beside its own binary. The host
 * launches the canonical engine executable and passes the helper's path.
 */
export interface EngineCompanionExecutable {
  /** File name in the engine executable's directory (`.exe` added for a Windows engine). */
  sibling: string
  /** Env key that receives the helper's absolute path. */
  env: string
}

/** The engine's own environment, beyond what the host passes to every engine. */
export interface EngineEnvironment {
  /** Request env keys the engine reads; the host admits them. */
  keys?: readonly string[]
  /** Request env key families the engine reads; the host admits them. */
  prefixes?: readonly string[]
  /**
   * Families the engine also reads implicitly (identity, OAuth or executable
   * hooks). Only `keys` of them reach it: from the request, and from the host
   * outside a private launch.
   */
  reviewedPrefixes?: readonly string[]
  /** The host's own keys of the reviewed families never reach the engine, even outside a private launch. */
  reviewedRequestOnly?: boolean
  /** Credentials set empty in a private launch unless the request sets them, so the engine cannot find the host's. */
  privateBlank?: readonly string[]
}

/** Files the engine reads implicitly, which the sandbox hides. */
export interface EngineHiddenFiles {
  /** Searched for in the home directory and every ancestor of the working directory. */
  searched?: readonly string[]
  /** Home-relative. */
  home?: readonly string[]
}

/**
 * The request env an adapter puts a session's MCP servers in (ACP
 * `McpServer[]` JSON) for an engine that reads its servers only from its
 * own configuration files. The host consumes it; the engine never sees it.
 */
export const ENGINE_MCP_SERVERS_ENV = "COGNIA_ENGINE_MCP_SERVERS"

/**
 * An engine that reads its MCP servers only from its configuration files.
 * For each launch carrying `ENGINE_MCP_SERVERS_ENV` the host builds a private
 * copy of the engine's configuration root, writes the servers into
 * `directory/serversFile` (its `mcpServers` map: `command`/`args`/`env` or
 * `url`/`transport`/`headers`) and points `rootEnv` at the copy. The owner's
 * launch keeps the engine's own servers and links the rest of the root; a
 * private launch (a Bot run) keeps only `privateKeep` of the settings file and
 * none of the root. Every stdio server gets `rootEnv` set to the person's own
 * root unless it names one.
 */
export interface EngineMcpConfigFile {
  /** The first argument a launch carrying servers has. */
  subcommand: string
  /** Env key the engine reads its configuration root from. */
  rootEnv: string
  /** The root when `rootEnv` is unset, relative to home. */
  rootDefault: string
  /** The engine's directory inside the root. */
  directory: string
  /** File in `directory` the servers are written to. */
  serversFile: string
  /** File in `directory` with the engine's settings, whose `mcpServers` the owner's launch keeps too. */
  settingsFile: string
  /** Project configuration the engine reads from the working directory and its ancestors; a project server named like a session server is refused. */
  project: Readonly<{ directory: string; files: readonly string[] }>
  /** Dotted paths of the settings file a private launch keeps, when they hold a scalar. */
  privateKeep: readonly string[]
  /** Dotted paths a private launch sets in the settings file. */
  privateSet: Readonly<Record<string, string | number | boolean>>
  /** Files a private launch copies once from home into its own state, which the engine needs to sign in. */
  privateCopy?: readonly Readonly<{ home: string; state: string }>[]
}

export interface EngineLaunchDescriptor {
  /** Runtime family id, for diagnostics. */
  id: string
  match: EngineLaunchMatch
  /** Home-relative roots the engine writes: logins, sessions, settings, caches. */
  stateRoots?: readonly string[]
  /** `stateRoots` entries that are files, created before launch. */
  fileRoots?: readonly string[]
  /** Absent: the engine documents no home variable and cannot run with a private state root. */
  isolation?: EngineStateIsolation
  relocation?: EngineStateRelocation
  temp?: EngineTempDirectory
  companion?: EngineCompanionExecutable
  /** Why the engine cannot run a private launch (a Bot run), which the host then refuses. */
  privateLaunchUnsupported?: string
  /**
   * Arguments the engine needs on one platform, appended unless the launch
   * already names the flag (the text before `=`).
   */
  platformArgs?: Readonly<Partial<Record<"linux" | "darwin" | "win32", readonly string[]>>>
  env?: EngineEnvironment
  hiddenFiles?: EngineHiddenFiles
  /**
   * Home-relative read-only roots holding the engine's own installed program,
   * readable even where the home is not (a Bot launch).
   */
  programRoots?: readonly string[]
  /**
   * Home-relative roots with the engine's logins or provider settings that its
   * `stateRoots` and isolation do not already name. A launch that is not the
   * owner's own (a gateway task) never reads them.
   */
  loginRoots?: readonly string[]
  /** Stderr lines that are expected noise: each entry lists substrings that must all appear. */
  stderrNoise?: readonly (readonly string[])[]
  /**
   * The engine honours the per-launch writable roots its adapter asks for
   * (`AgentProcessSpawnSpec.extraWritableRoots`), which the host validates
   * against the session ceiling before granting.
   */
  extraWritableRoots?: boolean
  /** Plugin Pi packages (ADR-0210) may be mounted into this engine read-only. */
  piPackages?: boolean
  mcpConfigFile?: EngineMcpConfigFile
}

/** The command without directory or Windows executable suffix, lower-cased. */
export function launchBaseCommand(command: string): string {
  const name = command.trim().split(/[\\/]/).pop() ?? ""
  return name.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "")
}

/** The base command and, for `npx`, the package it runs. */
export function launchTarget(
  command: string,
  args: readonly string[] = []
): { base: string; target: string } {
  const base = launchBaseCommand(command)
  const npxPackage = base === "npx" ? args.find((arg) => !arg.startsWith("-")) : undefined
  return { base, target: npxPackage ?? base }
}

export function launchMatches(
  match: EngineLaunchMatch,
  launch: { base: string; target: string }
): boolean {
  return match.kind === "contains"
    ? match.values.some((value) => launch.target.includes(value))
    : match.kind === "target"
      ? match.values.includes(launch.target)
      : match.values.includes(launch.base)
}

/** Every descriptor matching a launch, in table order. */
export function descriptorsFor(
  table: readonly EngineLaunchDescriptor[],
  command: string,
  args: readonly string[] = []
): EngineLaunchDescriptor[] {
  const launch = launchTarget(command, args)
  return table.filter((descriptor) => launchMatches(descriptor.match, launch))
}
