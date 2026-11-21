"use client"

/**
 * Bound execution target and step-up approval authority for terminal operations.
 *
 * Terminal streams (`/ws/terminal` and `cognia.terminal` WebRTC) and terminal
 * RPCs (`terminal_host_sync_profiles`, `terminal_kill_port`, completion scans)
 * cross two distinct transport planes. Resolving the active Host separately in
 * each step allowed a mid-flight Host switch to synchronize profiles on Host A
 * and spawn on Host B (T14), or run port/completion RPCs on the desktop while
 * re-running commands in an SSH or remote session (T03, T08).
 *
 * Capturing a bound target up front pins the endpoint, RPC transport, WAN data
 * channel lookup, and device-scoped `adminLease` cache to a single authority.
 */

import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { loadRemoteHostCredential } from "@/lib/remote-host/credential-vault"
import { openRemoteHostTarget } from "@/lib/remote-host/target-transport"
import {
  getActiveRuntimeTargetContext,
  type RuntimeTargetScope,
} from "@/lib/runtime/runtime-target-context"
import {
  HostConsentRequiredError,
  issueHostAdminLease,
  type HostAdminLease,
} from "@/lib/tauri/admin-lease"
import { companionErrorCode } from "@/lib/tauri/companion-auth"
import {
  defaultCompanionEndpointResolver,
  type CompanionEndpoint,
  type CompanionEndpointResolver,
} from "@/lib/tauri/companion-endpoint"
import { getCompanionConfigGeneration, loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { localTransport, transport as appTransport } from "@/lib/tauri/transport-instance"
import {
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  retainRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"

import { TerminalSessionError } from "./base-session"
import type { SessionInfo } from "./types"

const LEASE_EXPIRY_SKEW_MS = 5_000
const DEFAULT_LEASE_TTL_SECONDS = 120

const remoteTransportIds = new WeakMap<object, number>()
let nextRemoteTransportId = 1

const transportLeaseCaches = new WeakMap<object, Map<string, HostAdminLease>>()

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "")
}

function remoteTransportId(remote: object): number {
  let id = remoteTransportIds.get(remote)
  if (!id) {
    id = nextRemoteTransportId++
    remoteTransportIds.set(remote, id)
  }
  return id
}

/** Stable key identifying a concrete companion/remote-host endpoint + device pairing. */
export function endpointTargetKey(
  endpoint: Pick<CompanionEndpoint, "baseUrl" | "deviceId" | "accountId" | "remoteHost">
): string {
  return JSON.stringify([
    "endpoint",
    endpoint.remoteHost?.id ?? null,
    normalizeBaseUrl(endpoint.baseUrl),
    endpoint.deviceId,
    endpoint.accountId ?? null,
  ])
}

/**
 * Synchronous key for the terminal Host currently selected by the app shell.
 *
 * Distinguishes:
 *   - desktop remote-host overlays (per transport instance + endpoint identity),
 *   - paired mobile / web companion targets (per activation generation + baseUrl + deviceId + targetId + accountId),
 *   - local desktop / unconfigured standalone (`"default"`).
 */
export function currentTerminalTargetKey(): string {
  const remote = getActiveRemoteTransport()
  if (remote) {
    const endpoint = getActiveRemoteEndpoint()
    const id = remoteTransportId(remote)
    if (!endpoint) return `remote:${id}`
    return `remote:${id}:${normalizeBaseUrl(endpoint.baseUrl)}:${endpoint.deviceId}:${endpoint.accountId ?? ""}`
  }

  const config = loadCompanionConfig()
  const scope = getActiveRuntimeTargetContext()
  if (config) {
    return [
      "paired",
      String(getCompanionConfigGeneration()),
      normalizeBaseUrl(config.baseUrl),
      config.deviceId,
      config.targetId ?? scope?.targetId ?? "",
      config.accountId ?? scope?.accountId ?? "",
    ].join(":")
  }
  if (scope) {
    return `scope:${scope.accountId}:${scope.targetId}:${scope.routingGeneration}`
  }
  return "default"
}

function sameRuntimeScope(a: RuntimeTargetScope | null, b: RuntimeTargetScope | null): boolean {
  if (a === null && b === null) return true
  if (!a || !b) return false
  return (
    a.accountId === b.accountId &&
    a.targetId === b.targetId &&
    a.routingGeneration === b.routingGeneration
  )
}

function sameEndpointIdentity(a: CompanionEndpoint, b: CompanionEndpoint | null): boolean {
  if (!b) return false
  return (
    normalizeBaseUrl(a.baseUrl) === normalizeBaseUrl(b.baseUrl) &&
    a.deviceId === b.deviceId &&
    (a.accountId ?? null) === (b.accountId ?? null) &&
    (a.remoteHost?.id ?? null) === (b.remoteHost?.id ?? null)
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "")
}

export function isTerminalApprovalRefusal(error: unknown): boolean {
  if (error instanceof HostConsentRequiredError) return true
  const code = companionErrorCode(error)
  if (code === "interactive_approval_required") return true
  const lower = messageOf(error).toLowerCase()
  return (
    lower.includes("interactive_approval_required") ||
    lower.includes("remote_consent_required") ||
    lower.includes("approval lease is required") ||
    lower.includes("admin lease is invalid or expired")
  )
}

export interface TerminalAdminLeaseCallOptions {
  transport?: Pick<Transport, "call">
  targetKey?: string
  ttlSeconds?: number
  issueLease?: typeof issueHostAdminLease
  now?: () => number
}

function leaseMapFor(caller: object): Map<string, HostAdminLease> {
  let map = transportLeaseCaches.get(caller)
  if (!map) {
    map = new Map()
    transportLeaseCaches.set(caller, map)
  }
  return map
}

/**
 * Invoke an `approval: "interactive"` terminal RPC with a device-bound `adminLease`.
 *
 * Owner devices receive a lease immediately; non-owner devices trigger an
 * idempotent host-consent prompt and surface {@link HostConsentRequiredError}.
 * If a cached lease is rejected (for example after a Host restart cleared its
 * in-memory lease table), the stale entry is evicted and re-issued once.
 */
export async function callWithTerminalAdminLease<T>(
  command: string,
  args: Record<string, unknown>,
  options: TerminalAdminLeaseCallOptions = {}
): Promise<T> {
  const caller = options.transport ?? getActiveRemoteTransport() ?? appTransport
  const now = options.now ?? Date.now
  const issue = options.issueLease ?? issueHostAdminLease
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS
  const cacheKey = `${options.targetKey ?? currentTerminalTargetKey()}::${command}`
  const cache = leaseMapFor(caller as object)

  let cached = cache.get(cacheKey)
  let usedCached = false
  if (
    cached &&
    cached.expiresAt > now() + LEASE_EXPIRY_SKEW_MS &&
    (cached.operations.includes(command) || cached.operations.includes("*"))
  ) {
    usedCached = true
  } else {
    cached = await issue([command], ttlSeconds, caller)
    cache.set(cacheKey, cached)
  }

  try {
    return await caller.call<T>(command, { ...args, adminLease: cached.token })
  } catch (error) {
    if (isTerminalApprovalRefusal(error) && cache.get(cacheKey) === cached) {
      cache.delete(cacheKey)
      if (usedCached) {
        const fresh = await issue([command], ttlSeconds, caller)
        cache.set(cacheKey, fresh)
        return caller.call<T>(command, { ...args, adminLease: fresh.token })
      }
    }
    throw error
  }
}

export interface BoundTerminalRemoteTarget {
  readonly key: string
  readonly endpoint: CompanionEndpoint
  readonly remoteHost: NonNullable<SessionInfo["remoteHost"]>
  readonly transport: Pick<Transport, "call">
  getWanChannel(): RTCDataChannel | null
  getWanClientId(): string | undefined
  assertCurrent(): Promise<void>
  release(): void
}

/**
 * Capture the active remote/paired terminal Host once for an entire multi-step
 * operation (profile sync → LAN spawn → WAN fallback) so a concurrent Host
 * switch aborts cleanly instead of splitting steps across different machines.
 */
export async function captureActiveTerminalRemoteTarget(options?: {
  endpointResolver?: CompanionEndpointResolver
}): Promise<BoundTerminalRemoteTarget> {
  const resolver = options?.endpointResolver ?? defaultCompanionEndpointResolver
  const initialRemote = getActiveRemoteTransport()
  const initialScope = getActiveRuntimeTargetContext()
  const initialGeneration = getCompanionConfigGeneration()
  const endpoint = await resolver()
  if (!endpoint) {
    throw new TerminalSessionError("unpaired", "terminal host is not paired")
  }

  const snapshot: CompanionEndpoint = {
    ...endpoint,
    remoteHost: endpoint.remoteHost ? { ...endpoint.remoteHost } : undefined,
  }
  const remoteHost: NonNullable<SessionInfo["remoteHost"]> = snapshot.remoteHost
    ? { ...snapshot.remoteHost }
    : { id: null, label: normalizeBaseUrl(snapshot.baseUrl) }
  const key = endpointTargetKey(snapshot)

  if (initialRemote) {
    if (getActiveRemoteTransport() !== initialRemote) {
      throw new TerminalSessionError(
        "host_offline",
        "terminal host changed before the launch could bind"
      )
    }
    const releaseRetained = retainRemoteTransport(initialRemote)
    let released = false
    const assertSync = () => {
      if (released || getActiveRemoteTransport() !== initialRemote) {
        throw new TerminalSessionError(
          "host_offline",
          "selected terminal host changed during launch"
        )
      }
      const activeEndpoint = getActiveRemoteEndpoint()
      if (activeEndpoint && !sameEndpointIdentity(snapshot, activeEndpoint)) {
        throw new TerminalSessionError(
          "host_offline",
          "selected terminal host endpoint changed during launch"
        )
      }
    }
    const capable = initialRemote as {
      getTerminalDataChannel?: () => RTCDataChannel | null
      getTerminalClientId?: () => string | null
    }
    return {
      key,
      endpoint: snapshot,
      remoteHost,
      transport: {
        async call<T>(
          name: string,
          args?: Record<string, unknown>,
          callOpts?: Parameters<Transport["call"]>[2]
        ) {
          assertSync()
          const result = await initialRemote.call<T>(name, args, callOpts)
          assertSync()
          return result
        },
      },
      getWanChannel: () => {
        assertSync()
        return capable.getTerminalDataChannel?.() ?? null
      },
      getWanClientId: () => capable.getTerminalClientId?.() ?? undefined,
      assertCurrent: async () => {
        assertSync()
      },
      release: () => {
        if (released) return
        released = true
        releaseRetained()
      },
    }
  }

  let released = false
  const assertCurrent = async () => {
    if (
      released ||
      getActiveRemoteTransport() !== null ||
      getCompanionConfigGeneration() !== initialGeneration ||
      !sameRuntimeScope(initialScope, getActiveRuntimeTargetContext())
    ) {
      throw new TerminalSessionError("host_offline", "paired terminal host changed during launch")
    }
    const currentEndpoint = await resolver()
    if (!sameEndpointIdentity(snapshot, currentEndpoint)) {
      throw new TerminalSessionError("host_offline", "paired terminal host changed during launch")
    }
  }

  const capable = appTransport as {
    getTerminalDataChannel?: () => RTCDataChannel | null
    getTerminalClientId?: () => string | null
  }

  return {
    key,
    endpoint: snapshot,
    remoteHost,
    transport: {
      async call<T>(
        name: string,
        args?: Record<string, unknown>,
        callOpts?: Parameters<Transport["call"]>[2]
      ) {
        await assertCurrent()
        const result = await appTransport.call<T>(name, args, callOpts)
        await assertCurrent()
        return result
      },
    },
    getWanChannel: () => capable.getTerminalDataChannel?.() ?? null,
    getWanClientId: () => capable.getTerminalClientId?.() ?? undefined,
    assertCurrent,
    release: () => {
      released = true
    },
  }
}

export interface BoundSessionExecutionTarget {
  readonly kind: "local" | "remote"
  readonly key: string
  readonly transport: Pick<Transport, "call">
  close(): void
}

/**
 * Resolve the exact Host transport that owns an already-opened terminal session,
 * independent of whichever Host is currently selected in the global UI.
 */
export async function openBoundSessionTarget(
  session: {
    kind?: SessionInfo["kind"]
    origin?: SessionInfo["origin"]
    remoteHost?: SessionInfo["remoteHost"]
  },
  deps: {
    isDesktop?: () => boolean
    local?: Pick<Transport, "call">
    openRemoteHost?: typeof openRemoteHostTarget
    resolvePairedEndpoint?: CompanionEndpointResolver
    pairedTransport?: Pick<Transport, "call">
  } = {}
): Promise<BoundSessionExecutionTarget> {
  if (session.kind && session.kind !== "localPty") {
    throw new Error(`terminal operation is unsupported for ${session.kind} sessions`)
  }

  const isRemote =
    session.origin === "remote" || (session.remoteHost !== undefined && session.remoteHost !== null)
  if (!isRemote) {
    if (!(deps.isDesktop ?? isTauri)()) {
      throw new Error("local terminal host is unavailable in this shell")
    }
    return {
      kind: "local",
      key: "local",
      transport: deps.local ?? localTransport,
      close() {},
    }
  }

  const remoteHostId = session.remoteHost?.id ?? null
  if (remoteHostId) {
    const target = await (deps.openRemoteHost ?? openRemoteHostTarget)(remoteHostId)
    return {
      kind: "remote",
      key: `remote-host:${remoteHostId}`,
      transport: target.transport,
      close: target.close,
    }
  }

  if (
    !(deps.isDesktop ?? isTauri)() &&
    !isCapacitor() &&
    !hasWebCompanionTarget() &&
    !deps.resolvePairedEndpoint
  ) {
    throw new Error("paired terminal host is unavailable")
  }
  const endpoint = await (deps.resolvePairedEndpoint ?? defaultCompanionEndpointResolver)()
  if (!endpoint) {
    throw new Error("paired terminal host is unavailable")
  }
  const expectedLabel = session.remoteHost?.label
    ? normalizeBaseUrl(session.remoteHost.label)
    : null
  if (
    expectedLabel &&
    /^https?:\/\//i.test(expectedLabel) &&
    normalizeBaseUrl(endpoint.baseUrl) !== expectedLabel
  ) {
    throw new Error("terminal session belongs to another paired host")
  }
  return {
    kind: "remote",
    key: endpointTargetKey(endpoint),
    transport: deps.pairedTransport ?? appTransport,
    close() {},
  }
}

export function isRemoteTerminalSessionRow(session: {
  origin?: SessionInfo["origin"]
  remoteHost?: SessionInfo["remoteHost"]
}): boolean {
  return (
    session.origin === "remote" || (session.remoteHost !== undefined && session.remoteHost !== null)
  )
}

/**
 * Capture a {@link BoundTerminalRemoteTarget} pinned to a specific existing
 * remote session's Host, even when the global UI has since switched to Local
 * or to a different remote Host (T04).
 */
export async function captureSessionRemoteTarget(
  remoteHost: NonNullable<SessionInfo["remoteHost"]>,
  options: {
    endpointResolver?: CompanionEndpointResolver
    openRemoteHost?: typeof openRemoteHostTarget
    loadCredential?: typeof loadRemoteHostCredential
  } = {}
): Promise<BoundTerminalRemoteTarget> {
  if (remoteHost.id) {
    const activeEndpoint = getActiveRemoteEndpoint()
    if (getActiveRemoteTransport() && activeEndpoint?.remoteHost?.id === remoteHost.id) {
      return captureActiveTerminalRemoteTarget({ endpointResolver: options.endpointResolver })
    }
    const target = await (options.openRemoteHost ?? openRemoteHostTarget)(remoteHost.id)
    try {
      const storedCredential =
        target.host.config.devicePrivateKeyJwk !== undefined
          ? { devicePrivateKeyJwk: target.host.config.devicePrivateKeyJwk }
          : await (options.loadCredential ?? loadRemoteHostCredential)(target.host.id)
      if (!storedCredential?.devicePrivateKeyJwk) {
        throw new TerminalSessionError(
          "unauthorized",
          `Remote Host ${target.host.label} credential is unavailable; pair it again`
        )
      }
      const endpoint: CompanionEndpoint = {
        baseUrl: target.host.config.baseUrl,
        deviceId: target.host.config.deviceId,
        devicePrivateKeyJwk: storedCredential.devicePrivateKeyJwk,
        deviceKeyThumbprint: target.host.config.deviceKeyThumbprint,
        accountId: target.host.config.accountId,
        serverVersion: target.host.config.serverVersion,
        serverFingerprint: target.host.config.serverFingerprint,
        remoteHost: { id: target.host.id, label: target.host.label },
      }
      const key = endpointTargetKey(endpoint)
      const capable = target.transport as {
        getTerminalDataChannel?: () => RTCDataChannel | null
        getTerminalClientId?: () => string | null
      }
      let released = false
      let wanClaimed = false
      return {
        key,
        endpoint,
        remoteHost: { id: target.host.id, label: target.host.label },
        transport: target.transport,
        getWanChannel: () => {
          if (released) return null
          const channel = capable.getTerminalDataChannel?.() ?? null
          if (channel) wanClaimed = true
          return channel
        },
        getWanClientId: () => capable.getTerminalClientId?.() ?? undefined,
        assertCurrent: async () => {
          if (released) {
            throw new TerminalSessionError("host_offline", "bound terminal host target was closed")
          }
          target.assertCurrent?.()
        },
        release: () => {
          if (released) return
          released = true
          if (!wanClaimed) target.close()
        },
      }
    } catch (error) {
      target.close()
      throw error
    }
  }

  const bound = await captureActiveTerminalRemoteTarget({
    endpointResolver: options.endpointResolver,
  })
  const expectedLabel = remoteHost.label ? normalizeBaseUrl(remoteHost.label) : null
  if (
    expectedLabel &&
    /^https?:\/\//i.test(expectedLabel) &&
    normalizeBaseUrl(bound.endpoint.baseUrl) !== expectedLabel
  ) {
    bound.release()
    throw new TerminalSessionError(
      "host_offline",
      "terminal session belongs to another paired host"
    )
  }
  return bound
}

/** Test-only reset for module counters. */
export function __resetTerminalTargetsForTests(): void {
  nextRemoteTransportId = 1
}
