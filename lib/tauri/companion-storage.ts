"use client"

/**
 * The pairing record the mobile / web companion needs to reach its desktop
 * server (`baseUrl`, device identity, `deviceId`, `serverVersion`), and the
 * storage facade every consumer reads it through.
 *
 * The record lives in the multi-host credential book (ADR-0097): public host
 * records in localStorage (web) or native secure storage (Capacitor), private
 * keys in the Browser Vault or secure storage. {@link companionStorage} fronts
 * the book with the flat `CompanionConfig` shape for the account's *active*
 * host; multi-host callers talk to `companionCredentialBook()` directly.
 *
 * Async-everywhere is intentional. Capacitor's secure-storage plugin only
 * exposes async methods, and forcing the same shape on the web backend
 * keeps callers from branching on platform.
 */

// The credential book imports this module for its TYPES only (`import type`),
// so this is a one-way runtime edge, not a cycle.
import {
  CredentialBookCompanionStorage,
  activeAccountNamespace,
  companionCredentialBook,
} from "@/lib/companion/credential-book"
import { isCapacitor } from "@/lib/platform/detect"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { RoomDescriptor } from "@/lib/signaling/crypto"

export interface CompanionConfig {
  /** Stable runtime target id. Added by Web registration after first pair. */
  targetId?: string
  /** e.g. "https://192.168.1.42:7890" */
  baseUrl: string
  /** Internal service-principal token. Never used by a paired device. */
  serviceToken?: string
  /** Extractable form stored only by the platform secure-storage backend. */
  devicePrivateKeyJwk?: JsonWebKey
  /** SHA-256 of the canonical public-key PEM registered with the host. */
  deviceKeyThumbprint?: string
  /** Stable device identifier; namespace for idempotency keys + log lines. */
  deviceId: string
  /** Server semver, captured at pair time. Diagnostics only. */
  serverVersion: string
  /**
   * The name the Host reported for itself at pair time (`hostName`, auth
   * config version 5). Names a new pairing; the stored label is the user's.
   */
  hostName?: string
  /**
   * SHA-256 fingerprint (lower-case hex) of the desktop server's TLS
   * SubjectPublicKeyInfo at pair time. The transport layer pins this and
   * refuses to talk to a peer whose presented cert doesn't match. Wave
   * 1.4. Optional for backwards-compat with rows paired before TLS
   * rolled out.
   */
  serverFingerprint?: string
  /**
   * ADR-0021 — public room id used by the WebRTC signaling service to route
   * SDP/ICE messages between this client and its desktop server. UUIDv4
   * minted by the desktop pair handler. Absence disables the WebRTC
   * transport tier on this client.
   */
  rendezvousId?: string
  /** Public, self-certifying signaling room descriptor. */
  signalingRoomDescriptor?: RoomDescriptor
  /** Browser-reachable signaling endpoint returned by this target's Host. */
  signalingUrl?: string
  /** Target-specific ICE servers returned by the Host auth configuration. */
  iceServers?: RTCIceServer[]
  /**
   * Mobile role ECDSA private key. The credential book keeps this JWK in
   * native secure storage (Capacitor) or the Browser Vault (web), never in the
   * public host record.
   */
  signalingPrivateKeyJwk?: JsonWebKey
  /** Runtime-only key imported from {@link signalingPrivateKeyJwk} on load. */
  signalingPrivateKey?: CryptoKey
  /**
   * Local app/Vault account namespace that owns this target. This is not the
   * remote Host tenant and must never be sent as the device-token tenant.
   */
  accountId?: string
  /** Remote Host tenant used for challenges, access tokens, and authorization. */
  tenantId?: string
  /**
   * ADR-0021 channel inventory — the desktop's cloudflared tunnel URL, as
   * last reported by the `companion_endpoints` RPC.
   *
   * The QR pair payload carries exactly ONE `baseUrl`, so a device paired on
   * the LAN would otherwise never learn that its desktop is also reachable
   * from the internet: leaving the network stranded it on the WebRTC tier
   * alone, and a client with WebRTC disabled (or behind a symmetric NAT with
   * no TURN) had no route home at all. Refreshed on every successful connect
   * by `lib/connectivity/endpoint-refresh.ts` and consumed as a failover
   * candidate by the mobile signaling controller. Absent when the desktop is
   * running no tunnel.
   */
  tunnelBaseUrl?: string
  /**
   * ADR-0021 channel inventory — the desktop's `https://<lan-ip>:<port>`
   * address, as last reported by `companion_endpoints`. The mirror of
   * {@link tunnelBaseUrl} for the opposite transition: a device paired over
   * the tunnel learns where to look on the LAN. Absent when the desktop is
   * loopback-bound or has no routable interface.
   */
  lanBaseUrl?: string
}

export interface CompanionConfigStorage {
  load(): Promise<CompanionConfig | null>
  save(config: CompanionConfig): Promise<void>
  /** Change an existing public record without rewriting credentials or selecting it. */
  updateMetadata?(config: CompanionConfig, isCurrent: () => boolean): Promise<boolean>
  clear(): Promise<void>
  /** Remove one exact pairing without consulting an active-host pointer. */
  remove?(config: CompanionConfig): Promise<void>
}

/**
 * The active storage: the multi-host credential book behind the flat
 * `CompanionConfig` shape.
 *
 * Every downstream consumer (transport, connectivity, sync, endpoint refresh)
 * reads and writes the same flat record for the account's *active* host.
 */
export function pickCompanionStorage(): CompanionConfigStorage {
  return new CredentialBookCompanionStorage({
    book: companionCredentialBook(),
    accountNamespace: activeAccountNamespace,
    activeHostId: () => {
      const targetId = getActiveRuntimeTargetContext()?.targetId
      // A phone boots under the `mobile-companion` placeholder target before
      // it knows which Host it is paired to; that placeholder resolves through
      // the account's active-host pointer instead of naming a host.
      return isCapacitor() && targetId === "mobile-companion" ? undefined : targetId
    },
  })
}

// Module-scope singleton — picked once at first import.
let storageInstance: CompanionConfigStorage | null = null

export function companionStorage(): CompanionConfigStorage {
  if (storageInstance === null) {
    storageInstance = pickCompanionStorage()
  }
  return storageInstance
}

/**
 * Override the active storage instance. Test-only — production code should
 * never call this. The transport caches the resolved config in memory, so
 * swapping storage at runtime in production would leave the cache stale.
 */
export function __setCompanionStorageForTests(next: CompanionConfigStorage | null): void {
  storageInstance = next
}
