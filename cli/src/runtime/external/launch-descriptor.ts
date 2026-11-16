/**
 * The CLI host's interpreter of the engine launch table (ADR-0217), the twin
 * of `crates/cognia-external-agent/src/launch_descriptor.rs`. It names no
 * engine: everything engine-specific is a descriptor field.
 */

import fs from "node:fs"
import path from "node:path"

import type {
  EngineCompanionExecutable,
  EngineLaunchDescriptor,
} from "@cognia/agent-contracts/engine-launch"
import { descriptorsFor } from "@cognia/agent-contracts/engine-launch"
import { ENGINE_LAUNCH_DESCRIPTORS } from "@/lib/ai/agent/external/policy/engine-launch"

function firstWith<K extends keyof EngineLaunchDescriptor>(
  command: string,
  args: readonly string[],
  field: K
): (EngineLaunchDescriptor & Required<Pick<EngineLaunchDescriptor, K>>) | undefined {
  return descriptorsFor(ENGINE_LAUNCH_DESCRIPTORS, command, args).find(
    (descriptor) => descriptor[field] !== undefined
  ) as (EngineLaunchDescriptor & Required<Pick<EngineLaunchDescriptor, K>>) | undefined
}

/** Refuse a private launch (a Bot run) of an engine that cannot run one. */
export function checkPrivateLaunch(command: string, args: readonly string[], isPrivate: boolean) {
  if (!isPrivate) return
  const descriptor = firstWith(command, args, "privateLaunchUnsupported")
  if (descriptor)
    throw new Error(
      `${descriptor.id} cannot run a private launch: ${descriptor.privateLaunchUnsupported}`
    )
}

/** The launch's arguments plus any the engine needs on `platform`, appended unless already named. */
export function withPlatformArgs(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform
): string[] {
  const needed =
    firstWith(command, args, "platformArgs")?.platformArgs[
      platform as "linux" | "darwin" | "win32"
    ] ?? []
  const out = [...args]
  for (const arg of needed) {
    const flag = arg.split("=")[0]
    if (!out.some((existing) => existing === flag || existing.startsWith(`${flag}=`))) out.push(arg)
  }
  return out
}

export interface EngineCompanion {
  engine: string
  env: EngineCompanionExecutable["env"]
  /** The canonical engine executable the launch runs. */
  executablePath: string
  helperPath: string
}

/**
 * The helper the engine `command` loads from beside its own binary, with
 * `resolve` finding the installed executable. The helper must be a regular
 * executable file in the canonical executable's own directory; a
 * caller-selected helper is never trusted.
 */
export function companionFor(
  command: string,
  resolve: (command: string) => string | null
): EngineCompanion | undefined {
  const descriptor = firstWith(command, [], "companion")
  if (!descriptor) return undefined
  const { id, companion } = descriptor
  const resolvedPath = resolve(command)
  if (!resolvedPath) throw new Error(`${id} is not installed`)
  const executablePath = fs.realpathSync(resolvedPath)
  const name = /\.exe$/i.test(resolvedPath) ? `${companion.sibling}.exe` : companion.sibling
  const helperPath = path.join(path.dirname(executablePath), name)
  try {
    const stat = fs.lstatSync(helperPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file")
    fs.accessSync(helperPath, fs.constants.X_OK)
    fs.accessSync(executablePath, fs.constants.X_OK)
  } catch {
    throw new Error(`${id} requires an executable ${name} beside its executable`)
  }
  return { engine: id, env: companion.env, executablePath, helperPath }
}

export interface RelocatedState {
  engine: string
  root: string
  /** What the launch writes: the root, or its declared sub-paths. */
  writable: string[]
  temp?: string
  /** Every relocation key set to the root, then the relocation's fixed switches. */
  env: Record<string, string>
}

export interface RelocationInput {
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  cwd?: string
  /** The launch's home: the gateway task's own home when it has one. */
  home: string
  /** The private state a Bot launch must stay inside. */
  privateBase?: string
  /** A gateway task never inherits the host's selection. */
  hostEnvApplies: boolean
}

function outside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

/** The real path of `candidate`'s deepest existing ancestor, with the missing tail re-attached. */
function existingRealPath(candidate: string): string {
  const missing: string[] = []
  for (let current = candidate; ; current = path.dirname(current)) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (current === path.dirname(current)) return candidate
      missing.push(path.basename(current))
    }
  }
}

/**
 * The launch's relocated state root, or `undefined` when the engine has no
 * relocation, or has one without a default and nothing selects it.
 */
export function relocatedState(
  input: RelocationInput,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env
): RelocatedState | undefined {
  const descriptor = firstWith(input.command, input.args, "relocation")
  if (!descriptor) return undefined
  const { id, relocation } = descriptor
  const invalid = () =>
    new Error(
      `${id} state directory must be nonempty and stay inside the launch's own state when it runs privately`
    )
  const refused = relocation.refusedArgs?.find((flag) =>
    input.args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
  )
  if (refused)
    throw new Error(
      `${id} cannot scope ${refused}; select its state with ${relocation.env.join(" or ")} instead`
    )
  let selected: string | undefined
  for (const key of relocation.env) {
    const value = input.env[key] ?? (input.hostEnvApplies ? hostEnv[key] : undefined)
    if (value === undefined) continue
    if (relocation.skipEmpty && !value.trim()) continue
    selected = value
    break
  }
  if (relocation.args) {
    const { flags, pick } = relocation.args
    let fromFlag: string | undefined
    for (let index = 0; index < input.args.length; index++) {
      const arg = input.args[index]
      const value = flags.includes(arg)
        ? (input.args[++index] ?? "")
        : flags
            .map((flag) => (arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined))
            .find((v) => v !== undefined)
      if (value === undefined) continue
      fromFlag = value
      if (pick === "first") break
    }
    if (fromFlag !== undefined) selected = fromFlag
  }
  if (selected !== undefined && relocation.trim) selected = selected.trim()
  if (selected !== undefined && !selected.trim()) throw invalid()
  if (selected !== undefined && relocation.expandTilde) {
    if (selected === "~") selected = input.home
    else if (selected.startsWith("~/")) selected = path.join(input.home, selected.slice(2))
  }
  const base = input.privateBase ?? input.home
  if (!path.isAbsolute(base)) throw invalid()
  let root: string
  if (selected !== undefined) {
    if (!path.isAbsolute(selected) && !input.cwd)
      throw new Error(`${id} needs a working directory to resolve its state directory`)
    root = path.resolve(input.cwd ?? base, selected)
  } else if (relocation.default !== undefined) {
    root = path.join(base, ...relocation.default.split("/"))
  } else {
    return undefined
  }
  if (input.privateBase) {
    if (outside(input.privateBase, root)) throw invalid()
    if (outside(existingRealPath(input.privateBase), existingRealPath(root))) throw invalid()
  }
  return {
    engine: id,
    root,
    writable: relocation.writable?.length
      ? relocation.writable.map((relative) => path.join(root, ...relative.split("/")))
      : [root],
    ...(relocation.temp !== undefined && {
      temp: path.join(root, ...relocation.temp.split("/")),
    }),
    env: {
      ...Object.fromEntries(relocation.env.map((key) => [key, root])),
      ...relocation.setEnv,
    },
  }
}

/**
 * The temp directory of an engine without a relocation: home-relative, or
 * under the private root an isolation mapped into `env`.
 */
export function engineTemp(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  isolated: boolean
): string | undefined {
  const temp = firstWith(command, args, "temp")?.temp
  if (!temp) return undefined
  if (temp.isolated && isolated) {
    const root = env[temp.isolated.env]
    return root === undefined ? undefined : path.join(root, ...temp.isolated.path.split("/"))
  }
  return path.join(home, ...temp.home.split("/"))
}

const matching = (command: string, args: readonly string[]) =>
  descriptorsFor(ENGINE_LAUNCH_DESCRIPTORS, command, args)

/** Whether any engine reads this request env key, so the host admits it. */
export function admitsRequestEnv(key: string): boolean {
  return ENGINE_LAUNCH_DESCRIPTORS.some(
    ({ env }) => env?.keys?.includes(key) || env?.prefixes?.some((prefix) => key.startsWith(prefix))
  )
}

/**
 * Whether a key of one of the launch's reviewed env families must not reach
 * the engine: an unreviewed key always, and a host key in a private launch
 * or when the engine takes them from the request only.
 */
export function reviewedEnvRefused(
  command: string,
  args: readonly string[],
  key: string,
  fromHost: boolean,
  isPrivate: boolean
): boolean {
  return matching(command, args).some(
    ({ env }) =>
      env?.reviewedPrefixes?.some((prefix) => key.startsWith(prefix)) &&
      (!env.keys?.includes(key) || (fromHost && (isPrivate || env.reviewedRequestOnly === true)))
  )
}

/** The credentials a private launch sets empty unless its request sets them. */
export function privateBlankCredentials(command: string, args: readonly string[]): string[] {
  return matching(command, args).flatMap(({ env }) => env?.privateBlank ?? [])
}

/**
 * Files the engine reads implicitly that the sandbox hides: each searched name
 * in the home directory and every ancestor of `cwd`, then the home-relative ones.
 */
export function hiddenFiles(
  command: string,
  args: readonly string[],
  cwd: string,
  home: string
): string[] {
  const files = new Set<string>()
  for (const { hiddenFiles: hidden } of matching(command, args)) {
    if (hidden?.searched?.length) {
      const roots = new Set([home])
      for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        roots.add(dir)
        if (dir === path.dirname(dir)) break
      }
      for (const root of roots) for (const name of hidden.searched) files.add(path.join(root, name))
    }
    for (const relative of hidden?.home ?? []) files.add(path.join(home, ...relative.split("/")))
  }
  return [...files]
}

/** The engine's own installed program roots under `home`, read-only. */
export function programRoots(command: string, args: readonly string[], home: string): string[] {
  return [
    ...new Set(
      matching(command, args).flatMap(({ programRoots: roots }) =>
        (roots ?? []).map((relative) => path.join(home, ...relative.split("/")))
      )
    ),
  ]
}

/**
 * Every engine's logins and provider settings under `home`: the roots a
 * private launch hides plus each engine's other login roots. A launch that is
 * not the owner's own reads none of them.
 */
export function loginRoots(home: string): string[] {
  return [
    ...new Set(
      ENGINE_LAUNCH_DESCRIPTORS.flatMap((descriptor) => [
        ...(descriptor.isolation?.denyReadable ?? []),
        ...(descriptor.loginRoots ?? []),
      ]).map((relative) => path.join(home, ...relative.split("/")))
    ),
  ]
}

/** Whether the launched engine honours per-launch writable roots. */
export function acceptsExtraWritableRoots(command: string, args: readonly string[]): boolean {
  return matching(command, args).some((descriptor) => descriptor.extraWritableRoots)
}

/** Whether plugin Pi packages (ADR-0210) may be mounted into the launched engine. */
export function takesPiPackages(command: string, args: readonly string[]): boolean {
  return matching(command, args).some((descriptor) => descriptor.piPackages)
}
