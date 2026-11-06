import {
  admitPersonalCredential,
  PersonalCredentialRefusedError,
  type PersonalCredentialContext,
} from "@/lib/execution/personal-credential"
import {
  assertHostConnectionCredentialAuthorization,
  type HostConnectionCredentialAuthorization,
} from "@/lib/plugin/auth/connection-manager"

export type GoogleStateAdmission =
  | PersonalCredentialContext
  | {
      connectionAuthorization: HostConnectionCredentialAuthorization
      lineageId: string
    }
/** Atomic credential transitions executed by the selected host, shared by WebViews. */
import { transport } from "@/lib/tauri/transport-instance"
import { DocsProviderError } from "@/lib/docs-providers/types"
export interface GoogleLineage {
  id: string
  clientId: string
  method: "loopback-pkce" | "device-code"
  scopes: string[]
  sub: string
  email: string | null
  status: "connected" | "needs-reauth" | "disconnected"
  revision: string
  credentialRevision: string
  needsIdentity: boolean
}
export interface GooglePendingAttempt {
  attemptId: string
  clientId: string
  method: GoogleLineage["method"]
  expiresAt: number
  reauthorizeLineage?: string
}
export interface GoogleAuthAttempt {
  attemptId: string
  authorizeUrl?: string
  userCode?: string
  verificationUrl?: string
  interval?: number
  expiresAt: number
}
export type GoogleStateInput =
  | { action: "snapshot"; legacyClientId?: string; legacyBackupClientId?: string }
  | {
      action: "begin"
      clientId: string
      scopes: readonly string[]
      reauthorizeLineage?: string
      redirectUri?: string
    }
  | {
      action: "beginDevice"
      clientId: string
      scopes: readonly string[]
      reauthorizeLineage?: string
    }
  | { action: "complete"; state: string; code: string; clientId?: string }
  | { action: "pollDevice"; attemptId: string }
  | { action: "accessToken"; lineageId: string; minValidityMs?: number }
  | { action: "disconnect"; lineageId: string }
  | { action: "setClientSecret"; clientId: string; secret: string }
  | { action: "clearClientSecret"; clientId: string }
  | { action: "cancel"; attemptId: string }
export type GoogleDisconnectOutcome = { revoked: boolean; reason?: string }
export interface GoogleStateReply {
  lineages: GoogleLineage[]
  clients: { clientId: string; hasClientSecret: boolean }[]
  pending: GooglePendingAttempt[]
  attempt?: GoogleAuthAttempt
  pollStatus?: "pending" | "slow_down" | "denied" | "expired" | "connected"
  credential?: {
    accessToken: string
    expiresAt: number
    revision: string
    credentialRevision: string
  }
  outcome?: GoogleDisconnectOutcome
  backupMigrationNeedsClientId: boolean
  lineageId?: string
  migrationNeedsClientId: boolean
}
export type GoogleStatePort = (input: GoogleStateInput) => Promise<GoogleStateReply>
let override: GoogleStatePort | null = null
export function __setGoogleStatePortForTests(port: GoogleStatePort | null): void {
  override = port
}
const observers = new Set<() => void>()
let stopSubscription: (() => void) | undefined
function notify() {
  for (const observer of observers) {
    try {
      observer()
    } catch {
      /* Observers cannot undo a host commit. */
    }
  }
}

export async function googleState(
  input: GoogleStateInput,
  admission?: GoogleStateAdmission
): Promise<GoogleStateReply> {
  const assertAdmission = async () => {
    // Snapshot/completion/poll may call userinfo; disconnect reads a personal
    // token for revocation. None may silently run with ambient user authority.
    if (!["snapshot", "accessToken", "complete", "pollDevice", "disconnect"].includes(input.action))
      return
    if (admission && "connectionAuthorization" in admission) {
      // A consumer's row grant permits that row's token, not userinfo probes
      // for unrelated legacy lineages during a global native snapshot.
      if (input.action !== "accessToken") throw new DocsProviderError("notAuthorized")
      if (input.action === "accessToken" && input.lineageId !== admission.lineageId)
        throw new DocsProviderError("notAuthorized")
      await assertHostConnectionCredentialAuthorization(
        admission.connectionAuthorization,
        admission.lineageId
      )
    } else {
      const decision = await admitPersonalCredential(admission, { source: "google-docs" })
      if (!decision.ok) throw new PersonalCredentialRefusedError(decision)
    }
  }
  await assertAdmission()
  try {
    const reply = await (override
      ? override(input)
      : transport.call<GoogleStateReply>("connectors_google_docs_auth", { input }))
    await assertAdmission()
    return reply
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("google_docs_state_stale"))
      throw new DocsProviderError("notAuthorized", { reason: "connection changed" })
    if (message.includes("google_docs_state_mismatch"))
      throw new DocsProviderError("notAuthorized", { reason: "oauth state mismatch" })
    throw err
  } finally {
    if (input.action !== "snapshot") notify()
  }
}

/** Events contain only a reload signal, never account data, tokens or PKCE. */
export function subscribeGoogleStateChanged(observer: () => void): () => void {
  observers.add(observer)
  if (!stopSubscription)
    stopSubscription = transport.subscribe("google-docs-connection-changed", notify)
  return () => {
    observers.delete(observer)
    if (!observers.size) {
      stopSubscription?.()
      stopSubscription = undefined
    }
  }
}
