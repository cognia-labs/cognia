import {
  loadRemoteHostCredential,
  type RemoteHostCredential,
} from "@/lib/remote-host/credential-vault"
import { companionCredentialBook, type CompanionHostRecord } from "@/lib/companion/credential-book"
import {
  getActiveRuntimeTargetContext,
  subscribeRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import {
  assertPerformanceSecurityGeneration,
  getPerformanceSecurityGeneration,
  subscribePerformanceSecurityBarrier,
} from "@/lib/perf/security-generation"
import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { transport as appTransport } from "@/lib/tauri/transport-instance"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import {
  CompanionTransport,
  loadCompanionConfig,
  retainCompanionRunConnection,
} from "@/lib/tauri/transport-companion"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  getRemoteTransportFactory,
  useRemoteHostStore,
  withSigningKey,
  type RemoteHost,
} from "@/stores/remote-host/remote-host-store"

type DisposableTransport = Transport & { destroy?: () => void }

export interface RemoteHostTarget {
  host: RemoteHost
  transport: Transport
  close: () => void
  /** A paired channel checks its route, or only pairing/account for a retained run. */
  assertCurrent?: () => void
}

export interface RemoteHostTargetDeps {
  /** Only admitted runs may outlive the active paired route. */
  mode?: "retained-run"
  loadCredential?: (hostId: string) => Promise<RemoteHostCredential | null>
  createTransport?: (configProvider: () => CompanionConfig) => DisposableTransport
  /** The `/pair` Host path's seams; production reads the live app state. */
  paired?: PairedHostTargetDeps
}

/**
 * The ref a `/pair` Host's device row carries. Such a Host is not in the
 * remote-host store: it is the companion target the app itself is paired to,
 * reached through the app's own transport.
 */
export const PAIRED_HOST_REF_PREFIX = "companion:"

/** The Host id a `companion:<hostId>` ref names, else null. */
export function pairedHostIdOf(ref: string): string | null {
  if (!ref.startsWith(PAIRED_HOST_REF_PREFIX)) return null
  return ref.slice(PAIRED_HOST_REF_PREFIX.length) || null
}

export interface PairedHostTargetDeps {
  activeTarget?: () => { accountId: string; targetId: string; routingGeneration?: number } | null
  loadRecord?: (localAccountId: string, hostId: string) => Promise<CompanionHostRecord | null>
  loadConfig?: () => CompanionConfig | null
  transport?: () => Transport
}

/** Use the account's existing lock/switch barrier and Vault unlock lifetime. */
export function retainRunAccountAuthority(
  accountId: string | undefined,
  onInvalidated: () => void,
  currentAccount: () => string | undefined = () => getActiveRuntimeTargetContext()?.accountId
): { assertCurrent(): void; close(): void } {
  const generation = getPerformanceSecurityGeneration()
  const vault = getActiveBrowserVault()
  let invalid = false
  const invalidate = () => {
    if (invalid) return
    invalid = true
    onInvalidated()
  }
  const assertCurrent = () => {
    try {
      assertPerformanceSecurityGeneration(generation)
      if (
        invalid ||
        (accountId && currentAccount() !== accountId) ||
        (vault && (getActiveBrowserVault() !== vault || !vault.isUnlocked()))
      )
        throw new Error("Run account authorization changed")
    } catch (error) {
      invalidate()
      throw error
    }
  }
  const check = () => {
    try {
      assertCurrent()
    } catch {
      /* Owner observes control loss. */
    }
  }
  const stopContext = subscribeRuntimeTargetContext(check)
  const stopSecurity = subscribePerformanceSecurityBarrier(check)
  return {
    assertCurrent,
    close() {
      stopContext()
      stopSecurity()
    },
  }
}

/**
 * Whether a `/pair` Host's channel still talks to it: the app's transport
 * serves whichever companion target is active, so a switch to another Host,
 * or a re-pair that replaced this device's identity, ends the old channel.
 */
export function isPairedHostTargetCurrent(
  hostId: string,
  deviceId: string | undefined,
  deps: PairedHostTargetDeps = {}
): boolean {
  const active = (deps.activeTarget ?? getActiveRuntimeTargetContext)()
  const config = (deps.loadConfig ?? loadCompanionConfig)()
  return (
    active?.targetId === hostId &&
    config?.targetId === hostId &&
    (deviceId === undefined || config.deviceId === deviceId)
  )
}

/**
 * Open a fixed-config management channel to the active `/pair` Host. Its
 * ordinary authority expires when the active route changes. A retained run
 * checks the captured account and pairing instead. The public record supplies
 * its name and age without exposing private keys.
 */
async function openPairedHostTarget(
  ref: string,
  hostId: string,
  deps: PairedHostTargetDeps = {},
  options: RemoteHostTargetDeps = {}
): Promise<RemoteHostTarget> {
  const currentActive = (deps.activeTarget ?? getActiveRuntimeTargetContext)()
  const currentConfig = (deps.loadConfig ?? loadCompanionConfig)()
  const active = currentActive ? { ...currentActive } : null
  const config = currentConfig ? { ...currentConfig } : null
  const retained = options.mode === "retained-run"
  let invalid = false
  let pairingKnown = true
  let closed = false
  if (!active || active.targetId !== hostId || config?.targetId !== hostId) {
    throw new Error(`Paired Host ${hostId} is not the Host this app is connected to`)
  }
  let invalidateConnection = () => {
    invalid = true
  }
  const assertCurrent = () => {
    authorization?.assertCurrent()
    const next = (deps.activeTarget ?? getActiveRuntimeTargetContext)()
    const nextConfig = (deps.loadConfig ?? loadCompanionConfig)()
    if (
      next?.accountId !== active.accountId ||
      invalid ||
      closed ||
      !pairingKnown ||
      (retained
        ? nextConfig?.targetId === hostId && nextConfig.deviceId !== config.deviceId
        : next?.targetId !== active.targetId ||
          next?.routingGeneration !== active.routingGeneration ||
          nextConfig?.targetId !== config.targetId ||
          nextConfig?.deviceId !== config.deviceId)
    ) {
      if (
        retained &&
        (invalid ||
          next?.accountId !== active.accountId ||
          (nextConfig?.targetId === hostId && nextConfig.deviceId !== config.deviceId))
      )
        invalidateConnection()
      throw new Error(`Paired Host ${hostId} connection changed`)
    }
  }
  const authorization = retained
    ? retainRunAccountAuthority(
        active.accountId,
        () => invalidateConnection(),
        () => (deps.activeTarget ?? getActiveRuntimeTargetContext)()?.accountId
      )
    : undefined
  const loadRecord =
    deps.loadRecord ??
    ((localAccountId, id) =>
      companionCredentialBook().get({ accountNamespace: localAccountId, hostId: id }))
  let opened = false
  try {
    const record = await loadRecord(active.accountId, hostId)
    assertCurrent()
    if (!record) throw new Error(`Paired Host ${hostId} is not paired`)
    const deviceId = record.deviceId
    const thumbprint = record.deviceKeyThumbprint
    if (
      retained &&
      ((deviceId !== undefined && deviceId !== config.deviceId) ||
        (thumbprint !== undefined && thumbprint !== config.deviceKeyThumbprint) ||
        (config.accountId !== undefined && config.accountId !== active.accountId))
    )
      throw new Error(`Paired Host ${hostId} connection changed`)
    const validatePairing = async () => {
      if (!retained) return
      const next = await loadRecord(active.accountId, hostId).catch((error: unknown) => {
        pairingKnown = false
        throw error
      })
      pairingKnown = true
      if (
        !next ||
        next.deviceId !== deviceId ||
        next.deviceKeyThumbprint !== thumbprint ||
        next.connection?.status === "revoked"
      )
        invalid = true
      assertCurrent()
    }
    await validatePairing()
    const publicConfig: CompanionConfig = { ...config }
    delete publicConfig.devicePrivateKeyJwk
    delete publicConfig.signalingPrivateKeyJwk
    delete publicConfig.signalingPrivateKey
    delete publicConfig.serviceToken
    const host: RemoteHost = {
      id: ref,
      label: record.label,
      config: publicConfig,
      credentialRef: ref,
      addedAt: record.createdAt,
      connectionState: "ready",
    }
    // A fixed config is essential: the app router and the default companion
    // transport both follow the currently selected Host after an async boundary.
    const admittedConfig = { ...config, accountId: active.accountId, targetId: hostId }
    const pinnedConfig = await withSigningKey(admittedConfig).catch(() => admittedConfig)
    assertCurrent()
    const create =
      options.createTransport ??
      (getRemoteTransportFactory() as (provider: () => CompanionConfig) => DisposableTransport)
    const activeConnection = [deps.transport?.(), getActiveRemoteTransport(), appTransport].find(
      (candidate) =>
        candidate instanceof CompanionTransport && candidate.matchesRunPairing(pinnedConfig)
    )
    const connection = retained
      ? retainCompanionRunConnection(pinnedConfig, activeConnection ?? undefined, create)
      : undefined
    const pinned =
      connection?.transport ?? (deps.transport ? deps.transport() : create(() => pinnedConfig))
    invalidateConnection = () => {
      invalid = true
      connection?.invalidate()
    }
    // Pairings for inactive Hosts are read from the book, never from the active
    // route's config. Re-pair/removal/revocation permanently invalidates this lease.
    const timer = retained
      ? setInterval(() => {
          void validatePairing().catch(() => {
            if (invalid) connection?.invalidate()
          })
        }, 1_000)
      : undefined
    ;(timer as { unref?: () => void } | undefined)?.unref?.()
    const transport: Transport = {
      ...(pinned.whenSubscribed
        ? {
            async whenSubscribed(channels: readonly string[], timeoutMs?: number) {
              await validatePairing()
              assertCurrent()
              await pinned.whenSubscribed!(channels, timeoutMs)
              assertCurrent()
            },
          }
        : {}),
      ...(pinned.hasSubscribedChannels
        ? {
            hasSubscribedChannels(channels: readonly string[]) {
              assertCurrent()
              return pinned.hasSubscribedChannels!(channels)
            },
          }
        : {}),
      async call<T>(
        command: string,
        args?: Record<string, unknown>,
        options?: Parameters<Transport["call"]>[2]
      ) {
        await validatePairing()
        assertCurrent()
        const result = await pinned.call<T>(command, args, options)
        assertCurrent()
        return result
      },
      subscribe<T>(event: string, handler: (payload: T) => void) {
        assertCurrent()
        return pinned.subscribe<T>(event, (payload) => {
          try {
            assertCurrent()
          } catch {
            return
          }
          handler(payload)
        })
      },
      ...(pinned.readBinary
        ? {
            async readBinary(resource: Parameters<NonNullable<Transport["readBinary"]>>[0]) {
              assertCurrent()
              const result = await pinned.readBinary!(resource)
              assertCurrent()
              return result
            },
          }
        : {}),
    }
    // The run monitor may request a reconnect, always using this fixed config.
    for (const method of ["reconnectWs", "reconnectRtc"] as const) {
      const connection = pinned as Transport & Partial<Record<typeof method, () => unknown>>
      if (connection[method])
        Object.assign(transport, {
          [method]: () => {
            assertCurrent()
            return connection[method]!()
          },
        })
    }
    opened = true
    return {
      host,
      transport,
      assertCurrent,
      close: () => {
        if (closed) return
        closed = true
        if (timer) clearInterval(timer)
        authorization?.close()
        if (connection) connection.release()
        else if (!deps.transport) (pinned as DisposableTransport).destroy?.()
      },
    }
  } finally {
    if (!opened) authorization?.close()
  }
}

/**
 * Open an isolated transport to a configured Host without changing the app's
 * active routing target. Placement probes and dispatch must not make the whole
 * desktop start driving whichever candidate is being evaluated.
 */
export async function openRemoteHostTarget(
  stableHostRef: string,
  deps: RemoteHostTargetDeps = {}
): Promise<RemoteHostTarget> {
  const pairedHostId = pairedHostIdOf(stableHostRef)
  if (pairedHostId) return openPairedHostTarget(stableHostRef, pairedHostId, deps.paired, deps)
  const host = useRemoteHostStore.getState().hosts.find((candidate) => {
    const manifestRef =
      candidate.featureManifest?.schemaVersion === 2
        ? candidate.featureManifest.hostIdentity.id
        : undefined
    return candidate.id === stableHostRef || manifestRef === stableHostRef
  })
  if (!host) throw new Error(`Remote Host ${stableHostRef} is not configured`)

  const credential =
    host.config.devicePrivateKeyJwk !== undefined
      ? {
          devicePrivateKeyJwk: host.config.devicePrivateKeyJwk,
          ...(host.config.signalingPrivateKeyJwk
            ? { signalingPrivateKeyJwk: host.config.signalingPrivateKeyJwk }
            : {}),
        }
      : await (deps.loadCredential ?? loadRemoteHostCredential)(host.id)
  if (!credential?.devicePrivateKeyJwk) {
    throw new Error(`Remote Host ${host.label} credential is unavailable; pair it again`)
  }

  const paired: CompanionConfig = {
    ...host.config,
    devicePrivateKeyJwk: credential.devicePrivateKeyJwk,
    signalingPrivateKeyJwk: credential.signalingPrivateKeyJwk,
  }
  // The relay route signs its room with a CryptoKey; the vault hands back the
  // JWK. Without the import an always-on host behind NAT, which only the relay
  // reaches, could never be managed (ADR-0224 A4). A key that will not import
  // still leaves the direct route.
  const config = await withSigningKey(paired).catch(() => paired)
  // Same construction the store activates a host through, so a transport seam
  // installed for one covers the other and there is one place to change how a
  // companion transport is built.
  const transport = (
    deps.createTransport ??
    (getRemoteTransportFactory() as (p: () => CompanionConfig) => DisposableTransport)
  )(() => config)
  return {
    host,
    transport,
    close: () => transport.destroy?.(),
  }
}
