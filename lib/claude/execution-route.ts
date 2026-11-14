/**
 * The Host a turn's executor runs on, pinned for the whole turn.
 *
 * Calls and subscriptions through the shared transport follow whichever Host
 * is selected when they happen. A turn that began on Host A must still send
 * its interrupt and close to A, and keep hearing A's lifecycle events, after
 * the person selects Host B: otherwise the control reaches B, which may run a
 * mirrored session of the same id, while A keeps running and its stop is never
 * observed (postfix review P05).
 *
 * - On the desktop the route holds the transport the turn dispatched to: this
 *   machine's own IPC, or the remote Host's transport, which stays open after
 *   a switch until the route is released.
 * - A paired client has one transport that follows its active target. Its
 *   route cannot reach the old Host after a switch, so it fails closed: calls
 *   are refused and events dropped once the target or its routing generation
 *   changes.
 */

import { transport } from "@/lib/tauri"
import { localTransport } from "@/lib/tauri/transport-instance"
import {
  RoutingTransport,
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  retainRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { Transport, TransportCallOptions } from "@/lib/tauri/transport-types"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"

/** A control or subscription for a turn whose Host is no longer reachable. */
export class ExecutionRouteChangedError extends Error {
  readonly code = "execution_host_changed"
  constructor(readonly routeKey: string) {
    super(`the Host this turn runs on (${routeKey}) is no longer the connected one`)
    this.name = "ExecutionRouteChangedError"
  }
}

export interface ExecutionRoute {
  /** Stable name of the Host: `local`, `remote:<host id>` or `target:<id>:<generation>`. */
  readonly key: string
  /** The turn runs on another machine. */
  readonly remote: boolean
  /**
   * The transport the turn dispatched to, by identity. Per-transport state
   * (plugin tool contexts, personal egress bindings) is keyed on it.
   */
  readonly identity: Transport
  /** Calls and subscriptions pinned to that Host. */
  readonly transport: Transport
  /**
   * Calls and events still reach this Host after another is selected: true
   * on the desktop, which keeps the transport open while the route is held;
   * false on a paired client, whose one transport follows the selection.
   */
  readonly reachableAfterSwitch: boolean
  /** The shared transport still resolves to this Host. */
  isCurrent(): boolean
  /** Another holder; release each holder once. */
  retain(): ExecutionRoute
  release(): void
}

function pinnedRemoteKey(): string {
  const id = getActiveRemoteEndpoint()?.remoteHost?.id
  return `remote:${id ?? "unnamed"}`
}

/** The key {@link captureExecutionRoute} would name now, without holding anything. */
export function currentExecutionRouteKey(): string {
  if (transport instanceof RoutingTransport) {
    return getActiveRemoteTransport() ? pinnedRemoteKey() : "local"
  }
  const context = getActiveRuntimeTargetContext()
  return context ? `target:${context.targetId}:${context.routingGeneration}` : "local"
}

function desktopRoute(): ExecutionRoute {
  const remote = getActiveRemoteTransport()
  const target = remote ?? localTransport
  const key = remote ? pinnedRemoteKey() : "local"
  let holders = 0
  const releases: Array<() => void> = []
  const route: ExecutionRoute = {
    key,
    remote: remote !== null,
    identity: target,
    transport: target,
    reachableAfterSwitch: true,
    isCurrent: () => getActiveRemoteTransport() === remote,
    retain() {
      holders += 1
      releases.push(remote ? retainRemoteTransport(remote) : () => {})
      return route
    },
    release() {
      if (holders === 0) return
      holders -= 1
      releases.pop()?.()
    },
  }
  return route.retain()
}

function pairedClientRoute(): ExecutionRoute {
  const target = transport
  const context = getActiveRuntimeTargetContext()
  const key = context ? `target:${context.targetId}:${context.routingGeneration}` : "local"
  const isCurrent = () => {
    const now = getActiveRuntimeTargetContext()
    return (
      transport === target &&
      now?.targetId === context?.targetId &&
      now?.routingGeneration === context?.routingGeneration
    )
  }
  const pinned: Transport = {
    call<T = unknown>(
      ...call: [name: string, args?: Record<string, unknown>, options?: TransportCallOptions]
    ): Promise<T> {
      if (!isCurrent()) return Promise.reject(new ExecutionRouteChangedError(key))
      // The caller's arguments as given: a guard adds nothing to the call.
      return target.call<T>(...call)
    },
    subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
      // Events after a switch come from the new target, never from this turn.
      return target.subscribe<T>(event, (payload) => {
        if (isCurrent()) handler(payload)
      })
    },
    ...(target?.whenSubscribed
      ? {
          whenSubscribed: (channels: readonly string[], timeoutMs?: number) =>
            target.whenSubscribed!(channels, timeoutMs),
        }
      : {}),
  }
  const route: ExecutionRoute = {
    key,
    remote: context !== null,
    identity: target,
    transport: pinned,
    reachableAfterSwitch: false,
    isCurrent,
    retain: () => route,
    release() {},
  }
  return route
}

/**
 * Pin the Host the shared transport resolves to now. The caller holds the
 * route once and releases it when the turn no longer needs that Host.
 */
export function captureExecutionRoute(): ExecutionRoute {
  // A remote Host transport is selected only on the desktop.
  return transport instanceof RoutingTransport || getActiveRemoteTransport()
    ? desktopRoute()
    : pairedClientRoute()
}

/**
 * The Host each session's current turn was sent to (postfix review P05).
 * Interrupt and close for that session go there, not to whichever Host is
 * selected when they happen. An entry keeps its route open until the session
 * closes or sends again; once its turn has ended on a Host that is no longer
 * selected, it lets the transport go after {@link IDLE_ROUTE_RETENTION_MS}
 * and keeps only the Host's name, so a late control is refused instead of
 * reaching the new Host.
 */
interface SessionRouteEntry {
  key: string
  remote: boolean
  route: ExecutionRoute | null
  inFlight: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}
const sessionRoutes = new Map<string, SessionRouteEntry>()
/** How long a finished turn's switched-away Host stays reachable for a deferred close. */
export const IDLE_ROUTE_RETENTION_MS = 5 * 60_000
let unsubscribeRouteSwitches: (() => void) | null = null
/** Told whenever a session's route changes, or the selection does. */
const routeChangeListeners = new Set<() => void>()

function routesChanged(): void {
  for (const listener of [...routeChangeListeners]) listener()
}

function scheduleIdleRouteRelease(entry: SessionRouteEntry): void {
  if (entry.inFlight || !entry.route || entry.idleTimer || entry.route.isCurrent()) return
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null
    if (entry.inFlight || !entry.route || entry.route.isCurrent()) return
    entry.route.release()
    entry.route = null
    routesChanged()
  }, IDLE_ROUTE_RETENTION_MS)
}

function watchRouteSwitches(): void {
  if (unsubscribeRouteSwitches) return
  unsubscribeRouteSwitches = subscribeActiveRemoteTransport(() => {
    for (const entry of sessionRoutes.values()) scheduleIdleRouteRelease(entry)
    routesChanged()
  })
}

export function forgetSessionExecutionRoute(sessionId: string): void {
  const entry = sessionRoutes.get(sessionId)
  if (!entry) return
  sessionRoutes.delete(sessionId)
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.route?.release()
  routesChanged()
}

/** Record that `sessionId`'s turn now runs on `route`'s Host. */
export function bindSessionExecutionRoute(sessionId: string, route: ExecutionRoute): void {
  const previous = sessionRoutes.get(sessionId)
  if (previous?.route === route) {
    previous.inFlight = true
    if (previous.idleTimer) clearTimeout(previous.idleTimer)
    previous.idleTimer = null
    return
  }
  forgetSessionExecutionRoute(sessionId)
  sessionRoutes.set(sessionId, {
    key: route.key,
    remote: route.remote,
    route: route.retain(),
    inFlight: true,
    idleTimer: null,
  })
  watchRouteSwitches()
  routesChanged()
}

/**
 * The turn that ran on `route` has ended (its listener let go). The entry
 * keeps the route for a deferred close while the Host stays selected, and for
 * {@link IDLE_ROUTE_RETENTION_MS} once it is not.
 */
export function settleSessionExecutionRoute(sessionId: string, route: ExecutionRoute): void {
  const entry = sessionRoutes.get(sessionId)
  if (!entry || entry.route !== route) return
  entry.inFlight = false
  scheduleIdleRouteRelease(entry)
}

/**
 * Where a control for `sessionId` goes: the explicit route, else the Host its
 * turn was sent to, else the shared transport. A session whose Host is gone
 * from reach is refused rather than sent to the selected Host.
 */
export function sessionControlRoute(
  sessionId: string,
  explicit?: ExecutionRoute
): { transport: Transport; remote: boolean; route?: ExecutionRoute } {
  if (explicit) return { transport: explicit.transport, remote: explicit.remote, route: explicit }
  const entry = sessionRoutes.get(sessionId)
  if (!entry) return { transport, remote: getActiveRemoteTransport() !== null }
  if (entry.route)
    return { transport: entry.route.transport, remote: entry.remote, route: entry.route }
  if (entry.key === currentExecutionRouteKey()) {
    return { transport, remote: getActiveRemoteTransport() !== null }
  }
  throw new ExecutionRouteChangedError(entry.key)
}

/**
 * The Host `sessionId`'s turn runs on when that Host is still held but no
 * longer selected: its answers go there, and its events come from there only.
 */
export function detachedSessionRoute(sessionId: string): ExecutionRoute | null {
  const route = sessionRoutes.get(sessionId)?.route
  return route && route.reachableAfterSwitch && !route.isCurrent() ? route : null
}

/**
 * Hear `event` the way a listener that is not bound to one turn should
 * across a Host switch (postfix review P05): from the shared transport, except
 * for a session whose recorded Host is held but no longer selected, whose
 * events come from that Host and only from it. Without this, every global
 * listener (the chat view, plugin tool and hook dispatch, control replies)
 * stopped hearing a turn the moment another Host was selected, and heard
 * the new Host's events for a session of the same id instead.
 *
 * `route` is the detached Host an event came from, or null for the shared
 * transport.
 */
export function subscribeSessionEvents<T>(
  event: string,
  sessionOf: (payload: T) => string | undefined,
  handler: (payload: T, route: ExecutionRoute | null) => void
): () => void {
  const fromShared = transport.subscribe<T>(event, (payload) => {
    const sessionId = sessionOf(payload)
    if (sessionId && detachedSessionRoute(sessionId)) return
    handler(payload, null)
  })
  const attached = new Map<ExecutionRoute, () => void>()
  const sync = () => {
    const wanted = new Set<ExecutionRoute>()
    for (const entry of sessionRoutes.values()) {
      const route = entry.route
      if (route?.reachableAfterSwitch && !route.isCurrent()) wanted.add(route)
    }
    for (const [route, unlisten] of attached) {
      if (wanted.has(route)) continue
      unlisten()
      attached.delete(route)
    }
    for (const route of wanted) {
      if (attached.has(route)) continue
      attached.set(
        route,
        route.transport.subscribe<T>(event, (payload) => {
          const sessionId = sessionOf(payload)
          if (sessionId && detachedSessionRoute(sessionId) === route) handler(payload, route)
        })
      )
    }
  }
  sync()
  routeChangeListeners.add(sync)
  watchRouteSwitches()
  return () => {
    fromShared()
    routeChangeListeners.delete(sync)
    for (const unlisten of attached.values()) unlisten()
    attached.clear()
  }
}

/** Test-only: drop every session's recorded Host. */
export function __resetSessionExecutionRoutesForTests(): void {
  for (const sessionId of [...sessionRoutes.keys()]) forgetSessionExecutionRoute(sessionId)
  unsubscribeRouteSwitches?.()
  unsubscribeRouteSwitches = null
}
