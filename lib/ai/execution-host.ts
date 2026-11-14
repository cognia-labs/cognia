/**
 * Which machine executes this client's model work and local inference engines.
 *
 * Two kinds of client hand that work to another machine:
 *
 * - A Tauri desktop driving a remote Cognia Host (ADR-0082). Its routing
 *   transport sends Execution commands to the Host while one is active.
 * - A browser or phone paired to a Host (ADR-0123). Every command it sends
 *   goes to the Host.
 *
 * Everywhere else (a standalone desktop, `pnpm dev` without a pairing) this
 * device executes the work itself and the answer is `null`.
 *
 * Chat turns already follow the execution Host. Utility calls (titles,
 * labels, connection tests) and the local-engine panel ask here so they
 * reach the same machine: a `localhost` engine URL means the Host's own
 * loopback once a Host executes the turns.
 */

import { isTauri, transport } from "@/lib/tauri"
import type { Transport } from "@/lib/tauri/transport-types"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import {
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import {
  getActiveRuntimeTargetContext,
  getRuntimeTargetScopeKey,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

export type RemoteExecutionHostKind = "desktop-remote" | "paired-client"

export interface RemoteExecutionHost {
  /** How this client reaches the Host. */
  kind: RemoteExecutionHostKind
  /** A transport bound to that Host (not one that might switch underneath). */
  transport: Transport
  /** The Host's name as the pairing recorded it, when known. */
  label: string | undefined
  /**
   * Identity of the route: the runtime target plus the Host connection. Two
   * reads with the same key address the same Host over the same pairing.
   */
  scopeKey: string
}

function hostnameOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return new URL(baseUrl).hostname || undefined
  } catch {
    return undefined
  }
}

function pairedClientHost(): RemoteExecutionHost | null {
  const active = getActiveRuntimeTargetContext()
  const config = loadCompanionConfig()
  if (!active || !config?.deviceId || config.targetId !== active.targetId) return null
  return {
    kind: "paired-client",
    transport,
    label: config.hostName?.trim() || hostnameOf(config.baseUrl),
    scopeKey: JSON.stringify([
      "paired-client",
      getRuntimeTargetScopeKey(),
      config.deviceId,
      config.deviceKeyThumbprint,
      config.baseUrl,
      config.serverFingerprint,
    ]),
  }
}

/**
 * A per-object id for the remote transport. A reconnect to the same Host
 * installs a new transport, and requests (and answers) bound to the old one
 * belong to a route that no longer exists.
 */
const transportIds = new WeakMap<object, number>()
let nextTransportId = 1
function transportId(remote: Transport): number {
  let id = transportIds.get(remote)
  if (id === undefined) {
    id = nextTransportId++
    transportIds.set(remote, id)
  }
  return id
}

function desktopRemoteHost(): RemoteExecutionHost | null {
  const remote = getActiveRemoteTransport()
  if (!remote) return null
  const endpoint = getActiveRemoteEndpoint()
  return {
    kind: "desktop-remote",
    transport: remote,
    label: endpoint?.remoteHost?.label?.trim() || hostnameOf(endpoint?.baseUrl),
    scopeKey: JSON.stringify([
      "desktop-remote",
      transportId(remote),
      getRuntimeTargetScopeKey(),
      endpoint?.remoteHost?.id,
      endpoint?.deviceId,
      endpoint?.deviceKeyThumbprint,
      endpoint?.baseUrl,
      endpoint?.serverFingerprint,
    ]),
  }
}

/** The Host that executes this client's work, or `null` when this device does. */
export function getRemoteExecutionHost(): RemoteExecutionHost | null {
  return isTauri() ? desktopRemoteHost() : pairedClientHost()
}

/**
 * The scope key of the current execution route. Compare a key taken before an
 * asynchronous step with one taken after it to detect a Host switch.
 */
export function getExecutionHostScopeKey(): string {
  return getRemoteExecutionHost()?.scopeKey ?? JSON.stringify(["this-device"])
}

/**
 * Same Host, same connection, and (for a desktop) the very transport object
 * captured earlier: a reconnect to the same Host replaces the transport, and a
 * request built for the old one must not land on the new one unannounced.
 */
export function isSameExecutionHost(host: RemoteExecutionHost): boolean {
  const current = getRemoteExecutionHost()
  return !!current && current.scopeKey === host.scopeKey && current.transport === host.transport
}

/**
 * Observe switches of the execution route: the runtime target (pairing, lock,
 * account) and the desktop's active remote Host. Returns an idempotent
 * unsubscribe.
 */
export function subscribeExecutionHost(listener: () => void): () => void {
  let done = false
  // The remote-host store installs the transport (which notifies) and then
  // its endpoint (which does not). Read the route once both are in place.
  const notify = () =>
    queueMicrotask(() => {
      if (!done) listener()
    })
  const offTarget = subscribeRuntimeTargetContext(notify)
  const offRemote = subscribeActiveRemoteTransport(notify)
  return () => {
    if (done) return
    done = true
    offTarget()
    offRemote()
  }
}
