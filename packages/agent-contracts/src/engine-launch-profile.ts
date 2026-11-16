/**
 * ADR-0243 3C: how an external engine process is launched, derived once on
 * the Host from the run's acting identity and carried to the process host as
 * one env value. The Rust process host
 * (`crates/cognia-external-agent/src/launch_profile.rs`) and the CLI host
 * (`cli/src/runtime/external/state-isolation.ts`, `node-backend.ts`) interpret it.
 *
 * - `owner` (also when absent): the local person's own run.
 * - `isolated`: a run for someone else, an event, the service lane or a Bot.
 *   It gets no ambient credential, helper socket or native login, a private
 *   state root the host derives from `key`, and only the request env the
 *   host admits.
 * - `personal`: the owner's run once it carries personal content. It is
 *   `isolated` and also a Cognia gateway task whose only network is the
 *   Host's own loopback services in `loopbackPorts` (its gateway and its
 *   tool host), so the content reaches the model and Cognia's tools and
 *   nothing else.
 */

/** Host-minted; never forwarded to the engine. */
export const ENGINE_PROFILE_ENV = "COGNIA_ENGINE_PROFILE"

export type EngineIsolationReason = "bot" | "requester" | "event" | "service"

export type EngineLaunchProfile =
  | { kind: "owner" }
  | { kind: "isolated"; key: string; reason: EngineIsolationReason }
  | { kind: "personal"; key: string; loopbackPorts: number[] }

/**
 * A key is a directory name: the isolated launch's private state root is
 * `<data>/cognia/isolated-agents/<key>` on the host that runs it.
 */
export const ENGINE_PROFILE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const REASONS: ReadonlySet<string> = new Set<EngineIsolationReason>([
  "bot",
  "requester",
  "event",
  "service",
])

export class EngineLaunchProfileError extends Error {
  constructor() {
    super(`Invalid ${ENGINE_PROFILE_ENV}`)
    this.name = "EngineLaunchProfileError"
  }
}

/** Read the profile from a launch env. Absent is `owner`; anything malformed throws. */
export function readEngineLaunchProfile(
  env: Readonly<Record<string, string | undefined>> | undefined
): EngineLaunchProfile {
  const raw = env?.[ENGINE_PROFILE_ENV]
  if (raw === undefined) return { kind: "owner" }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new EngineLaunchProfileError()
  }
  if (typeof value !== "object" || value === null) throw new EngineLaunchProfileError()
  const { kind, key, reason, loopbackPorts } = value as Record<string, unknown>
  if (kind === "owner") return { kind }
  if (typeof key !== "string" || !ENGINE_PROFILE_KEY_PATTERN.test(key))
    throw new EngineLaunchProfileError()
  if (kind === "isolated" && typeof reason === "string" && REASONS.has(reason))
    return { kind, key, reason: reason as EngineIsolationReason }
  if (
    kind === "personal" &&
    Array.isArray(loopbackPorts) &&
    loopbackPorts.length > 0 &&
    loopbackPorts.every((port) => Number.isInteger(port) && port > 0 && port < 65536)
  )
    return { kind, key, loopbackPorts: loopbackPorts as number[] }
  throw new EngineLaunchProfileError()
}

/** Whether a launch env asks for a private launch: `isolated` or `personal`. */
export function isIsolatedLaunch(
  env: Readonly<Record<string, string | undefined>> | undefined
): boolean {
  return readEngineLaunchProfile(env).kind !== "owner"
}

/** The env entry that carries `profile`; an owner launch carries none. */
export function engineLaunchProfileEnv(profile: EngineLaunchProfile): Record<string, string> {
  return profile.kind === "owner" ? {} : { [ENGINE_PROFILE_ENV]: JSON.stringify(profile) }
}
