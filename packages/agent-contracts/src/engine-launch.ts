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
  /** Writable state roots the private root replaces; defaults to `stateRoots`. */
  sharedRoots?: readonly string[]
  /** Home-relative paths hidden so the engine cannot fall back to the shared login. */
  denyReadable: readonly string[]
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
