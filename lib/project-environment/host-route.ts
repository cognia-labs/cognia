/**
 * Host identity, reactive Host-switch subscription, and pinned execution route
 * for project environment setup and runtime management (F7, F9).
 *
 * Why a dedicated helper beside `lib/ai/agent/execution/execution-route.ts`:
 * - Setup reuse history is persisted in Dexie and needs a **stable** Host key
 *   (no ephemeral routing generation, and no `"remote:unnamed"` collision when
 *   an endpoint carries `baseUrl` + `deviceId` without `remoteHost.id`).
 * - Runtime management panels need a **reactive** scope key (`useSyncExternalStore`)
 *   that ticks across desktop remote switches, paired target context switches,
 *   transport swaps, and companion config reloads.
 * - Multi-step operations (setup file reads → mise → execute → cancel; or
 *   build start → poll → cancel) must pin ONE Host transport so a mid-flight
 *   Host switch never splits steps across Host A and Host B.
 */

import { ExecutionRouteChangedError } from "@/lib/ai/agent/execution/execution-route"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { transport } from "@/lib/tauri"
import { getCompanionConfigGeneration, loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { localTransport, onTransportChange } from "@/lib/tauri/transport-instance"
import {
  RoutingTransport,
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  retainRemoteTransport,
  subscribeActiveRemoteEndpoint,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { Transport, TransportCallOptions } from "@/lib/tauri/transport-types"

export { ExecutionRouteChangedError }

const COMPANION_CONFIG_EVENT = "cognia:companion-config-changed"

const remoteTransportIds = new WeakMap<object, number>()
let nextRemoteTransportId = 1

function remoteTransportId(remote: object): number {
  let id = remoteTransportIds.get(remote)
  if (!id) {
    id = nextRemoteTransportId++
    remoteTransportIds.set(remote, id)
  }
  return id
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

function safeActiveRemoteTransport(): Transport | null {
  return typeof getActiveRemoteTransport === "function" ? getActiveRemoteTransport() : null
}

function safeActiveRemoteEndpoint() {
  return typeof getActiveRemoteEndpoint === "function" ? getActiveRemoteEndpoint() : null
}

function safeRuntimeTargetContext() {
  return typeof getActiveRuntimeTargetContext === "function"
    ? getActiveRuntimeTargetContext()
    : null
}

function safeCompanionConfig() {
  try {
    return typeof loadCompanionConfig === "function" ? loadCompanionConfig() : null
  } catch {
    return null
  }
}

function safeCompanionGeneration(): number {
  return typeof getCompanionConfigGeneration === "function" ? getCompanionConfigGeneration() : 0
}

/**
 * Stable identity of the currently selected execution Host, suitable for
 * persisted setup reuse history, signatures, and per-Host flight locking.
 *
 * Returns `cacheable: false` when a remote transport is active with no
 * endpoint identity so two anonymous remote Hosts can never share reuse.
 */
export function currentEnvironmentHostIdentity(): { hostKey: string; cacheable: boolean } {
  const remote = safeActiveRemoteTransport()
  if (remote) {
    const endpoint = safeActiveRemoteEndpoint()
    if (endpoint?.remoteHost?.id) {
      return { hostKey: `remote:${endpoint.remoteHost.id}`, cacheable: true }
    }
    if (endpoint?.baseUrl) {
      return {
        hostKey: `remote-endpoint:${normalizeBaseUrl(endpoint.baseUrl)}:${endpoint.deviceId}:${endpoint.accountId ?? ""}`,
        cacheable: true,
      }
    }
    return { hostKey: `remote-ephemeral:${remoteTransportId(remote)}`, cacheable: false }
  }

  const context = safeRuntimeTargetContext()
  if (context) {
    return { hostKey: `paired:${context.accountId}:${context.targetId}`, cacheable: true }
  }

  const config = safeCompanionConfig()
  if (config?.baseUrl) {
    return {
      hostKey: `paired-endpoint:${normalizeBaseUrl(config.baseUrl)}:${config.deviceId}:${config.targetId ?? ""}:${config.accountId ?? ""}`,
      cacheable: true,
    }
  }

  return { hostKey: "local", cacheable: true }
}

/** Stable Host key for the currently active execution Host. */
export function currentEnvironmentHostKey(): string {
  return currentEnvironmentHostIdentity().hostKey
}

/**
 * Reactive epoch key for UI panels (`useSyncExternalStore`). Changes on every
 * Host switch, reconnect generation bump, or companion config change — even
 * when switching Host A → Host B → Host A.
 */
export function currentEnvironmentHostScopeKey(): string {
  const remote = safeActiveRemoteTransport()
  if (remote) {
    const { hostKey } = currentEnvironmentHostIdentity()
    return `${hostKey}#t${remoteTransportId(remote)}`
  }
  const context = safeRuntimeTargetContext()
  if (context) {
    return `paired:${context.accountId}:${context.targetId}#g${context.routingGeneration}:c${safeCompanionGeneration()}`
  }
  const config = safeCompanionConfig()
  if (config?.baseUrl) {
    return `${currentEnvironmentHostIdentity().hostKey}#c${safeCompanionGeneration()}`
  }
  return "local"
}

/** Subscribe to every signal that can change which Host commands target. */
export function subscribeEnvironmentHostChange(listener: () => void): () => void {
  const unsubscribes: Array<() => void> = []
  if (typeof subscribeActiveRemoteTransport === "function") {
    unsubscribes.push(subscribeActiveRemoteTransport(() => listener()))
  }
  if (typeof subscribeActiveRemoteEndpoint === "function") {
    unsubscribes.push(subscribeActiveRemoteEndpoint(() => listener()))
  }
  if (typeof subscribeRuntimeTargetContext === "function") {
    unsubscribes.push(subscribeRuntimeTargetContext(() => listener()))
  }
  if (typeof onTransportChange === "function") {
    unsubscribes.push(onTransportChange(() => listener()))
  }
  if (typeof window !== "undefined") {
    window.addEventListener(COMPANION_CONFIG_EVENT, listener)
    unsubscribes.push(() => window.removeEventListener(COMPANION_CONFIG_EVENT, listener))
  }
  return () => {
    for (const stop of unsubscribes) stop()
  }
}

export interface EnvironmentHostRoute {
  /** Stable persistent Host key (`local`, `remote:<id>`, `paired:<acct>:<id>`, …). */
  readonly hostKey: string
  /** Reactive scope key at capture time. */
  readonly scopeKey: string
  /** Whether a success on this route may vouch for future setup reuse. */
  readonly cacheable: boolean
  /** True when executing on a remote/paired Host rather than local desktop IPC. */
  readonly remote: boolean
  /**
   * True when calls on `transport` still reach this exact Host after the UI
   * switches to another Host (desktop retained transport), false on paired
   * clients whose single transport follows the active target.
   */
  readonly reachableAfterSwitch: boolean
  /** Pinned transport targeting ONLY this captured Host. */
  readonly transport: Pick<Transport, "call">
  /** Whether the underlying pinned transport is the shared global `transport`. */
  readonly usesDefaultTransport: boolean
  /** True while the globally active Host still matches this route. */
  isCurrent(): boolean
  /** Throws {@link ExecutionRouteChangedError} if a non-retained route switched Hosts. */
  assertCurrent(): void
  /** Release any retained remote transport hold. Idempotent. */
  release(): void
}

/**
 * Pin the currently selected Host once for an entire multi-step environment
 * operation (setup execution, runtime reload, build lifecycle, approval).
 */
export function captureEnvironmentHostRoute(): EnvironmentHostRoute {
  const { hostKey, cacheable } = currentEnvironmentHostIdentity()
  const scopeKey = currentEnvironmentHostScopeKey()
  const remote = safeActiveRemoteTransport()
  const isDesktopRouter =
    typeof RoutingTransport === "function" && transport instanceof RoutingTransport

  if (remote || isDesktopRouter) {
    const releaseRetained =
      remote && typeof retainRemoteTransport === "function"
        ? retainRemoteTransport(remote)
        : () => undefined
    let released = false
    const isCurrent = () => safeActiveRemoteTransport() === remote
    const target: Pick<Transport, "call"> = remote ?? {
      call<T = unknown>(
        name: string,
        args?: Record<string, unknown>,
        options?: TransportCallOptions
      ): Promise<T> {
        const active = isCurrent() ? transport : localTransport
        return options === undefined
          ? active.call<T>(name, args)
          : active.call<T>(name, args, options)
      },
    }
    return {
      hostKey,
      scopeKey,
      cacheable,
      remote: remote !== null,
      reachableAfterSwitch: true,
      transport: target,
      usesDefaultTransport: false,
      isCurrent,
      assertCurrent() {
        // Desktop routes retain their own transport, so they remain bound to
        // their original Host even after the UI selects another Host.
      },
      release() {
        if (released) return
        released = true
        releaseRetained()
      },
    }
  }

  const initialTransport = transport
  const isCurrent = () =>
    transport === initialTransport && currentEnvironmentHostScopeKey() === scopeKey
  const assertCurrent = () => {
    if (!isCurrent()) throw new ExecutionRouteChangedError(hostKey)
  }
  const pinned: Pick<Transport, "call"> = {
    call<T = unknown>(
      name: string,
      args?: Record<string, unknown>,
      options?: TransportCallOptions
    ): Promise<T> {
      if (!isCurrent()) return Promise.reject(new ExecutionRouteChangedError(hostKey))
      return options === undefined
        ? initialTransport.call<T>(name, args)
        : initialTransport.call<T>(name, args, options)
    },
  }
  return {
    hostKey,
    scopeKey,
    cacheable,
    remote: hostKey !== "local",
    reachableAfterSwitch: false,
    transport: pinned,
    usesDefaultTransport: true,
    isCurrent,
    assertCurrent,
    release() {},
  }
}

/** Test-only reset for WeakMap counter. */
export function __resetEnvironmentHostRouteForTests(): void {
  nextRemoteTransportId = 1
}
