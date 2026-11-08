/**
 * Whether shared rooms are available here, detected (ADR-0252 §6, ADR-0177
 * batch 5).
 *
 * Available when all of these hold: this machine has not turned shared chat
 * off (`./shared-chat-feature.ts`), a collaboration server is configured for
 * the active account, the account is signed in to its org, and the server's
 * `/health` lists `shared-chat` at a protocol this client speaks. Anything
 * else is `unavailable` with the reason, which every entry point shows
 * instead of hiding itself: a control that disappears reads as a missing
 * feature, one that says "no collaboration server configured" says what to do.
 *
 * This decides what the UI offers and whether the background sync runs. It
 * authorizes nothing: the server refuses every shared route it does not serve,
 * and re-checks every write.
 *
 * One snapshot per process, refreshed when it is stale, when the connection
 * or the preference changes, and when the network comes back. An answer that
 * is about to change (a server out of reach, an account signing in) is asked
 * again sooner than a settled one.
 */

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { SHARED_CHAT_PROTOCOL_VERSION, type CollabHealth } from "./client"
import { loadCollabConnection, subscribeCollabConnection } from "./connection"
import { resolveCurrentCollabContext } from "./runtime-client"
import { isSharedChatClientEnabled, subscribeSharedChatPreference } from "./shared-chat-feature"

/** The `/health` feature of a server that serves shared chat. */
export const SHARED_CHAT_HEALTH_FEATURE = "shared-chat"

export const SHARED_CHAT_UNAVAILABLE_REASONS = [
  /** This machine turned shared chat off. */
  "turned_off",
  /** No collaboration server is configured for this account. */
  "no_server",
  /** A server is configured, but this account is not signed in to its org. */
  "not_signed_in",
  /** The server did not answer `/health`. */
  "server_unreachable",
  /** The server answered, but does not serve shared chat. */
  "not_offered",
  /** The server serves shared chat at a protocol this client does not speak. */
  "protocol_unsupported",
] as const
export type SharedChatUnavailableReason = (typeof SHARED_CHAT_UNAVAILABLE_REASONS)[number]

export type SharedChatAvailability =
  /** Not asked yet: nothing is offered, and nothing is said to be missing. */
  | { state: "checking" }
  | { state: "available"; accountId: string; checkedAt: number }
  | {
      state: "unavailable"
      reason: SharedChatUnavailableReason
      accountId: string
      checkedAt: number
    }

/** How long a settled answer holds. */
export const SHARED_CHAT_AVAILABILITY_TTL_MS = 5 * 60_000
/**
 * How long an answer that is about to change holds: a server out of reach, or
 * an account in the middle of signing in.
 */
export const SHARED_CHAT_TRANSIENT_TTL_MS = 30_000

/** Reasons that say "not now", not "not here". */
const TRANSIENT_REASONS: ReadonlySet<SharedChatUnavailableReason> = new Set([
  "server_unreachable",
  "not_signed_in",
])

export interface SharedChatAvailabilityDeps {
  /** The account the answer is for: another account's answer is never shown. */
  accountId: () => string
  clientEnabled: () => boolean
  /** Whether a server is configured for the active account (an e2e context counts). */
  hasServer: () => boolean
  /** The server's `/health`, or `null` when this account is not signed in to it. */
  readHealth: () => Promise<CollabHealth | null>
  now: () => number
}

function defaultDeps(): SharedChatAvailabilityDeps {
  return {
    accountId: getActiveAccountId,
    clientEnabled: () => isSharedChatClientEnabled(),
    hasServer: () =>
      (process.env.NEXT_PUBLIC_E2E === "1" &&
        typeof window !== "undefined" &&
        Boolean(window.__cogniaCollabE2EContext)) ||
      loadCollabConnection(getActiveAccountId()) !== null,
    readHealth: async () => {
      const context = await resolveCurrentCollabContext()
      return context ? context.client.health() : null
    },
    now: Date.now,
  }
}

/** Decide availability once, from the deps. Never throws. */
export async function probeSharedChatAvailability(
  deps: SharedChatAvailabilityDeps
): Promise<Exclude<SharedChatAvailability, { state: "checking" }>> {
  const accountId = deps.accountId()
  const unavailable = (reason: SharedChatUnavailableReason) =>
    ({ state: "unavailable", reason, accountId, checkedAt: deps.now() }) as const
  if (!deps.clientEnabled()) return unavailable("turned_off")
  if (!deps.hasServer()) return unavailable("no_server")
  let health: CollabHealth | null
  try {
    health = await deps.readHealth()
  } catch {
    return unavailable("server_unreachable")
  }
  if (!health) return unavailable("not_signed_in")
  if (!(health.features ?? []).includes(SHARED_CHAT_HEALTH_FEATURE))
    return unavailable("not_offered")
  if ((health.collabProtocolVersion ?? 0) < Number(SHARED_CHAT_PROTOCOL_VERSION))
    return unavailable("protocol_unsupported")
  return { state: "available", accountId, checkedAt: deps.now() }
}

/**
 * Whether the background plane (discovery, streams, run recovery) keeps
 * running: shared chat is offered, or only out of reach for now. A network
 * blip must not suspend a run this machine executes; the plane's own
 * reconnects carry it across.
 */
export function keepsSharedChatRunning(availability: SharedChatAvailability): boolean {
  return (
    availability.state === "available" ||
    (availability.state === "unavailable" && availability.reason === "server_unreachable")
  )
}

/**
 * The `chatCollaboration` message that says why an entry point is inert, or
 * `null` when shared chat is offered. Every entry point shows this instead of
 * hiding itself.
 */
export function sharedChatInertMessageKey(
  availability: SharedChatAvailability
): `unavailable.${SharedChatUnavailableReason}` | "availability.checking" | null {
  if (availability.state === "available") return null
  if (availability.state === "checking") return "availability.checking"
  return `unavailable.${availability.reason}`
}

const CHECKING: SharedChatAvailability = { state: "checking" }

let deps: SharedChatAvailabilityDeps = defaultDeps()
let snapshot: SharedChatAvailability = CHECKING
let inFlight: Promise<SharedChatAvailability> | null = null
let inFlightAccountId: string | null = null
/** Bumped on every change that invalidates the snapshot, so a late probe is dropped. */
let generation = 0
const listeners = new Set<() => void>()
let stopTriggers: (() => void) | null = null

function publish(next: SharedChatAvailability): void {
  snapshot = next
  for (const listener of [...listeners]) listener()
}

function isStale(current: SharedChatAvailability, now: number): boolean {
  if (current.state === "checking") return true
  if (current.accountId !== deps.accountId()) return true
  const ttl =
    current.state === "unavailable" && TRANSIENT_REASONS.has(current.reason)
      ? SHARED_CHAT_TRANSIENT_TTL_MS
      : SHARED_CHAT_AVAILABILITY_TTL_MS
  return now - current.checkedAt >= ttl
}

/**
 * The current answer, without asking anything. An answer for another account
 * reads as `checking`: after a switch, nothing is offered on the previous
 * account's word.
 */
export function readSharedChatAvailability(): SharedChatAvailability {
  if (snapshot.state !== "checking" && snapshot.accountId !== deps.accountId()) return CHECKING
  return snapshot
}

/** Ask again when the answer is stale (or always, with `force`), sharing one probe. */
export function refreshSharedChatAvailability(
  options: { force?: boolean } = {}
): Promise<SharedChatAvailability> {
  if (options.force) {
    generation += 1
    inFlight = null
    inFlightAccountId = null
  } else if (!isStale(snapshot, deps.now())) {
    return Promise.resolve(snapshot)
  }
  // A probe for another account answers the wrong question: ask again.
  if (inFlightAccountId !== null && inFlightAccountId !== deps.accountId()) {
    generation += 1
    inFlight = null
  }
  if (inFlight) return inFlight
  const asked = generation
  inFlightAccountId = deps.accountId()
  const probe = probeSharedChatAvailability(deps).then((result) => {
    if (asked === generation) {
      inFlight = null
      inFlightAccountId = null
      publish(result)
      return result
    }
    return snapshot
  })
  inFlight = probe
  return probe
}

function installTriggers(): void {
  if (stopTriggers) return
  // What changes the answer: the server, the account's preference, the network.
  const changed = () => void refreshSharedChatAvailability({ force: true })
  const unsubscribeConnection = subscribeCollabConnection(changed)
  const unsubscribePreference = subscribeSharedChatPreference(changed)
  const online = typeof window !== "undefined" && typeof window.addEventListener === "function"
  if (online) window.addEventListener("online", changed)
  stopTriggers = () => {
    unsubscribeConnection()
    unsubscribePreference()
    if (online) window.removeEventListener("online", changed)
  }
}

/** Hear every change of the answer. The first listener installs the refresh triggers. */
export function subscribeSharedChatAvailability(listener: () => void): () => void {
  listeners.add(listener)
  installTriggers()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopTriggers?.()
      stopTriggers = null
    }
  }
}

/** Test-only: replace what detection reads, and forget the snapshot. */
export function __setSharedChatAvailabilityDepsForTesting(
  next: Partial<SharedChatAvailabilityDeps> | null
): void {
  deps = next ? { ...defaultDeps(), ...next } : defaultDeps()
  generation += 1
  inFlight = null
  inFlightAccountId = null
  snapshot = CHECKING
}
