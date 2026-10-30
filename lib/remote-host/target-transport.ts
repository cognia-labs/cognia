import {
  loadRemoteHostCredential,
  type RemoteHostCredential,
} from "@/lib/remote-host/credential-vault"
import { companionCredentialBook, type CompanionHostRecord } from "@/lib/companion/credential-book"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
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
  /** A paired channel is invalid after a route or device identity changes. */
  assertCurrent?: () => void
}

export interface RemoteHostTargetDeps {
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
 * authority expires when that route or paired device changes. The Host's
 * public record supplies its name and age without exposing private keys.
 */
async function openPairedHostTarget(
  ref: string,
  hostId: string,
  deps: PairedHostTargetDeps = {}
): Promise<RemoteHostTarget> {
  const currentActive = (deps.activeTarget ?? getActiveRuntimeTargetContext)()
  const currentConfig = (deps.loadConfig ?? loadCompanionConfig)()
  const active = currentActive ? { ...currentActive } : null
  const config = currentConfig ? { ...currentConfig } : null
  if (!active || active.targetId !== hostId || config?.targetId !== hostId) {
    throw new Error(`Paired Host ${hostId} is not the Host this app is connected to`)
  }
  const assertCurrent = () => {
    const next = (deps.activeTarget ?? getActiveRuntimeTargetContext)()
    const nextConfig = (deps.loadConfig ?? loadCompanionConfig)()
    if (
      next?.accountId !== active.accountId ||
      next?.targetId !== active.targetId ||
      next?.routingGeneration !== active.routingGeneration ||
      nextConfig?.targetId !== config.targetId ||
      nextConfig?.deviceId !== config.deviceId
    )
      throw new Error(`Paired Host ${hostId} connection changed`)
  }
  const record = await (
    deps.loadRecord ??
    ((localAccountId, id) =>
      companionCredentialBook().get({ accountNamespace: localAccountId, hostId: id }))
  )(active.accountId, hostId)
  assertCurrent()
  if (!record) throw new Error(`Paired Host ${hostId} is not paired`)
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
  const pinnedConfig = await withSigningKey({ ...config }).catch(() => ({ ...config }))
  assertCurrent()
  const pinned = deps.transport
    ? deps.transport()
    : (getRemoteTransportFactory() as (provider: () => CompanionConfig) => DisposableTransport)(
        () => pinnedConfig
      )
  const transport: Transport = {
    ...(pinned.whenSubscribed
      ? {
          async whenSubscribed(channels: readonly string[], timeoutMs?: number) {
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
      assertCurrent()
      const result = await pinned.call<T>(command, args, options)
      assertCurrent()
      return result
    },
    subscribe<T>(event: string, handler: (payload: T) => void) {
      assertCurrent()
      return pinned.subscribe<T>(event, (payload) => {
        assertCurrent()
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
  return {
    host,
    transport,
    assertCurrent,
    close: () => {
      if (!deps.transport) (pinned as DisposableTransport).destroy?.()
    },
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
  if (pairedHostId) return openPairedHostTarget(stableHostRef, pairedHostId, deps.paired)
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
