/** Google Rust lineages adapted to Host connections (ADR-0246 P6a). */
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import {
  getAuthConnection,
  listAuthConnections,
  type AuthConnectionRow,
} from "@/lib/db/auth-connections"
import { getSettings } from "@/lib/db/settings"
import {
  getProvider,
  registerAuthenticationProvider,
} from "@/lib/plugin/auth/auth-provider-registry"
import { registerHostAuthProviderService } from "@/lib/plugin/auth/connection-access"
import { withAuthLock } from "@/lib/plugin/auth/connection-credentials"
import {
  ConnectionRevisionChanged,
  ConnectionUnavailableError,
  getConnectionManager,
  getHostConnectionDriver,
  registerHostConnectionDriver,
  type HostDeviceAuthorization,
} from "@/lib/plugin/auth/connection-manager"
import {
  type GoogleAuthAttempt,
  googleState,
  subscribeGoogleStateChanged,
} from "@/lib/docs-providers/providers/google/state"
import { connectorsEnsureServer } from "@/lib/connectors/tauri/commands"
import { CONNECTORS_SERVER_PORT } from "@/lib/connectors/server-transport"
import { isHeadlessHost, isTauri } from "@/lib/platform/detect"
import { openUrl } from "@/lib/native/opener"

export const GOOGLE_ISSUER = "https://accounts.google.com"
const GOOGLE_RECONCILE_LOCK = "cognia-auth-provider:google:reconcile"
export interface GoogleDeviceAuthorization extends HostDeviceAuthorization {
  /** The exact native lineage reported by a successful poll, after reconciliation. */
  lineageId?: string
}

/** Adapt Host metadata for the shared dialog; OAuth credentials remain in Rust. */
export function createGoogleDeviceAuthorization(
  attempt: GoogleAuthAttempt
): GoogleDeviceAuthorization {
  if (!attempt.userCode || !attempt.verificationUrl)
    throw new ConnectionUnavailableError("device-challenge-missing")
  let intervalSeconds = Math.max(1, attempt.interval ?? 5)
  let cancelled = false
  const authorization: GoogleDeviceAuthorization = {
    kind: "device-code",
    userCode: attempt.userCode,
    verificationUrl: attempt.verificationUrl,
    expiresAt: attempt.expiresAt,
    intervalSeconds,
    async poll() {
      const reply = await googleState({ action: "pollDevice", attemptId: attempt.attemptId })
      if (cancelled) return { status: "expired" }
      if (reply.pollStatus === "connected") {
        if (!reply.lineageId) throw new ConnectionUnavailableError("authorized-lineage-missing")
        await reconcileGoogleConnections()
        if (cancelled) return { status: "expired" }
        authorization.lineageId = reply.lineageId
        return { status: "authorized" }
      }
      if (reply.pollStatus === "slow_down") intervalSeconds += 5
      if (!reply.pollStatus) throw new ConnectionUnavailableError("device-poll-status-missing")
      return { status: reply.pollStatus, intervalSeconds }
    },
    async cancel() {
      if (cancelled) return
      cancelled = true
      await googleState({ action: "cancel", attemptId: attempt.attemptId })
    },
  }
  return authorization
}

let disposeRegistration: (() => void) | undefined
let reconciliation: Promise<unknown> = Promise.resolve()

/** Registration is lazy, so reads also work before integration startup. */
export function ensureGoogleHostProvider(): void {
  if (getProvider("google")?.pluginId === null && getHostConnectionDriver("google")) return
  disposeRegistration?.()
  const disposeDriver = registerHostConnectionDriver("google", {
    publisher: "cognia",
    synchronize: async () => {
      await reconcileGoogleConnections()
    },
    getCredentials: async (row) => {
      const reply = await googleState({
        action: "accessToken",
        lineageId: lineageId(row),
        minValidityMs: 60_000,
      }).catch(async (error: unknown) => {
        await reconcileGoogleConnections()
        throw error
      })
      const credential = reply.credential
      // A refresh may finish after a native disconnect or reauthorization.
      if (!credential || credential.revision !== row.hostMetadata!.authorizationEpoch)
        throw new ConnectionUnavailableError("authorization-changed")
      await reconcileGoogleConnections()
      await getConnectionManager().getConnection(row.id, row.revision)
      return {
        accessToken: credential.accessToken,
        expiresAt: new Date(credential.expiresAt).toISOString(),
        scopes: [...row.scopes],
      }
    },
    disconnect: async (row) => {
      await googleState({ action: "disconnect", lineageId: lineageId(row) })
    },
    reauthorize: (ref) => authorizeGoogleConnection(ref),
  })
  let disposeProvider: () => void
  try {
    disposeProvider = registerAuthenticationProvider({
      id: "google",
      label: "Google",
      pluginId: null,
      getSessions: async () => [],
      createSession: async () => {
        throw new ConnectionUnavailableError("host-authorization-required")
      },
      removeSession: async () => {
        throw new ConnectionUnavailableError("connection-reference-required")
      },
    })
  } catch (error) {
    disposeDriver()
    throw error
  }
  const disposeService = registerHostAuthProviderService("google", "auth.google", "1.0.0")
  disposeRegistration = () => {
    disposeService()
    disposeProvider()
    disposeDriver()
    disposeRegistration = undefined
  }
}

/** The existing Host binding slot stores the opaque native lineage, never a credential. */
function lineageId(row: AuthConnectionRow): string {
  if (row.providerId !== "google" || row.ownerPluginId !== null || !row.hostMetadata)
    throw new ConnectionUnavailableError("provider-mismatch")
  return row.hostMetadata.adapterId
}

/**
 * Serialize snapshots and publication so an older reconcile cannot overwrite a
 * newer one. The local queue orders this WebView; the shared auth lock orders
 * every window, so a stale "disconnected" snapshot read in one window cannot
 * tombstone a reauthorization another window has already published.
 */
export function reconcileGoogleConnections(): Promise<AuthConnectionRow[]> {
  ensureGoogleHostProvider()
  const next = reconciliation.then(() =>
    withAuthLock(GOOGLE_RECONCILE_LOCK, publishGoogleSnapshot, "provider-reconcile")
  )
  reconciliation = next.catch(() => undefined)
  return next
}

async function publishGoogleSnapshot(): Promise<AuthConnectionRow[]> {
  const preferences = await getSettings()
  const legacyClientId = preferences.docsProviders?.google?.clientId?.trim()
  const legacyBackupClientId = preferences.backupDestinations?.googleDrive?.clientId?.trim()
  const snapshot = await googleState({
    action: "snapshot",
    ...(legacyBackupClientId ? { legacyBackupClientId } : {}),
    ...(legacyClientId ? { legacyClientId } : {}),
  })
  const manager = getConnectionManager()
  const previous = (await listAuthConnections("google")).filter((row) => row.ownerPluginId === null)
  const active = new Set<string>()
  for (const lineage of snapshot.lineages) {
    active.add(lineage.id)
    if (lineage.status === "disconnected") {
      for (const row of previous.filter((row) => row.hostMetadata?.adapterId === lineage.id))
        await manager.retireHostConnection(row.id)
      continue
    }
    const ref = await manager.reconcileHostConnection(
      "google",
      {
        issuer: GOOGLE_ISSUER,
        clientId: lineage.clientId,
        principal: { id: lineage.sub, kind: "user" },
        accountLabel: lineage.email ?? "Google",
        scopes: lineage.scopes,
      },
      {
        adapterId: lineage.id,
        authorizationEpoch: lineage.revision,
        credentialVersion: lineage.credentialRevision,
        bot: false,
      }
    )
    if (lineage.status === "needs-reauth") await manager.retireHostConnection(ref, "needs-reauth")
  }
  for (const row of previous)
    if (row.hostMetadata && !active.has(row.hostMetadata.adapterId))
      await manager.retireHostConnection(row.id)
  return listAuthConnections("google")
}

export async function listGoogleConnections(): Promise<AuthConnectionRow[]> {
  return reconcileGoogleConnections()
}

export async function resolveGoogleConnection(
  ref: string,
  expectedRevision?: number
): Promise<AuthConnectionRow> {
  await reconcileGoogleConnections()
  const row = await getConnectionManager().getConnection(ref as AuthConnectionRef, expectedRevision)
  lineageId(row)
  return row
}

/** A Host reconnect binds to the same native lineage and client, including rejected grants. */
export async function authorizeGoogleConnection(
  ref: string
): Promise<void | GoogleDeviceAuthorization> {
  ensureGoogleHostProvider()
  await reconcileGoogleConnections()
  const row = await getAuthConnection(ref)
  if (!row) throw new ConnectionUnavailableError("unknown")
  const nativeId = lineageId(row)
  const snapshot = await googleState({ action: "snapshot" })
  const lineage = snapshot.lineages.find((value) => value.id === nativeId)
  if (!lineage) throw new ConnectionUnavailableError("unknown-lineage")
  if (lineage.revision !== row.hostMetadata!.authorizationEpoch)
    throw new ConnectionRevisionChanged(row.id, row.revision)
  if (lineage.method === "device-code") {
    const reply = await googleState({
      action: "beginDevice",
      clientId: lineage.clientId,
      scopes: lineage.scopes,
      reauthorizeLineage: nativeId,
    })
    if (!reply.attempt?.userCode || !reply.attempt.verificationUrl)
      throw new ConnectionUnavailableError("device-challenge-missing")
    return createGoogleDeviceAuthorization(reply.attempt)
  }
  const bound = await connectorsEnsureServer(CONNECTORS_SERVER_PORT)
  const reply = await googleState({
    action: "begin",
    clientId: lineage.clientId,
    scopes: lineage.scopes,
    reauthorizeLineage: nativeId,
    redirectUri: `http://127.0.0.1:${bound.split(":").pop()}/oauth/docs/google/callback`,
  })
  if (!reply.attempt?.authorizeUrl)
    throw new ConnectionUnavailableError("authorization-url-missing")
  await openUrl(reply.attempt.authorizeUrl)
}

/** Only desktop IPC and the brain's internal service transport can reach this command. */
export function startGoogleHostAuth(): () => void {
  if (!isTauri() && !isHeadlessHost()) return () => {}
  ensureGoogleHostProvider()
  let stopped = false
  const reconcile = () => {
    if (!stopped)
      void reconcileGoogleConnections().catch(() => {
        console.warn("Google Host authorization reconciliation pending")
      })
  }
  const stop = subscribeGoogleStateChanged(reconcile)
  reconcile()
  return () => {
    stopped = true
    stop()
  }
}
