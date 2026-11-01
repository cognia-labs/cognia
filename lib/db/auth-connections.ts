import type {
  AuthConnectionIdentity,
  AuthConnectionRef,
  AuthConnectionStatus,
  AuthPrincipalKind,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getDb } from "./schema"

/** Device-local metadata only. Tokens must never enter Dexie or account sync. */
export interface AuthConnectionRow {
  id: AuthConnectionRef
  providerId: string
  ownerPluginId: string | null
  publisher: string | null
  contractMajor: number
  issuer: string
  clientId: string
  tenantId?: string
  tenantLabel?: string
  principalId: string
  principalKind: AuthPrincipalKind
  accountLabel: string
  scopes: string[]
  revision: number
  credentialRevision: number
  lineageId: string
  status: AuthConnectionStatus
  /** Restore reauthentication state after a temporary provider outage. */
  unavailableStatus?: "connected" | "needs-reauth"
  identityKey: string
  legacySessionId?: string
  /** Host-only binding to Rust-owned credentials. Never projected to plugins or synced. */
  hostMetadata?: {
    adapterId: string
    authorizationEpoch: string
    credentialVersion?: string
    bot: boolean
    expiresAt?: string
  }
  createdAt: number
  updatedAt: number
}

/** Escape delimiters so distinct identities cannot alias each other. */
export function authConnectionIdentityKey(
  identity: Pick<AuthConnectionIdentity, "issuer" | "clientId" | "principal">
): string {
  return [identity.issuer, identity.clientId, identity.principal.kind, identity.principal.id]
    .map(encodeURIComponent)
    .join("|")
}

export async function getAuthConnection(id: string): Promise<AuthConnectionRow | undefined> {
  return getDb().authConnections.get(id)
}

export async function findAuthConnection(
  identityKey: string
): Promise<AuthConnectionRow | undefined> {
  return getDb().authConnections.where("identityKey").equals(identityKey).first()
}

export async function listAuthConnections(providerId?: string): Promise<AuthConnectionRow[]> {
  const table = getDb().authConnections
  return providerId ? table.where("providerId").equals(providerId).toArray() : table.toArray()
}

export async function putAuthConnection(row: AuthConnectionRow): Promise<void> {
  await getDb().authConnections.put(row)
}

/** Terminal rows release the unique remote identity but retain their opaque ref. */
export function tombstoneAuthConnection(
  row: AuthConnectionRow,
  status: "revoked" | "tombstoned",
  now = Date.now()
): AuthConnectionRow {
  return { ...row, identityKey: `tombstoned:${row.id}`, status, updatedAt: now }
}
