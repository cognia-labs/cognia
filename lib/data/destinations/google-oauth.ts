/** Drive is a Host contributor: Rust owns all OAuth credentials and transitions. */
import type { GoogleDriveBackupDestinationSettings } from "@cognia/agent-config-types"
import {
  listGoogleConnections,
  resolveGoogleConnection,
} from "@/lib/auth-providers/google/host-auth"
import type { AuthConnectionRow } from "@/lib/db/auth-connections"
import {
  ConnectionRevisionChanged,
  ConnectionUnavailableError,
  getConnectionManager,
} from "@/lib/plugin/auth/connection-manager"
import { getBackupDestinationsSettings, updateBackupDestinationsSettings } from "./config"

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
export const GOOGLE_DRIVE_AUTH_SCOPES = ["openid", "email", GOOGLE_DRIVE_SCOPE] as const

function matches(row: AuthConnectionRow, clientId: string): boolean {
  return (
    row.providerId === "google" &&
    row.ownerPluginId === null &&
    row.clientId === clientId &&
    row.status === "connected" &&
    row.scopes.includes(GOOGLE_DRIVE_SCOPE)
  )
}

async function persistBinding(
  row: AuthConnectionRow,
  settings: GoogleDriveBackupDestinationSettings
) {
  await getConnectionManager().getConnection(row.id, row.revision)
  await updateBackupDestinationsSettings((current) => {
    const cfg = current.googleDrive
    if (cfg?.clientId?.trim() === settings.clientId?.trim() && cfg?.connectionId === row.id)
      return current
    if (
      !cfg ||
      cfg.clientId?.trim() !== settings.clientId?.trim() ||
      cfg?.connectionId !== settings.connectionId
    )
      throw new ConnectionRevisionChanged(row.id, row.revision)
    return { ...current, googleDrive: { ...cfg, connectionId: row.id } }
  })
}

/** Only a never-bound destination may migrate to a single exact candidate. */
export async function resolveGoogleDriveConnection(): Promise<AuthConnectionRow | null> {
  const settings = (await getBackupDestinationsSettings()).googleDrive
  const clientId = settings?.clientId?.trim()
  if (!settings || !clientId) return null
  const rows = await listGoogleConnections()
  const bound = rows.find((row) => row.id === settings.connectionId)
  if (bound)
    return matches(bound, clientId) ? resolveGoogleConnection(bound.id, bound.revision) : null
  if (settings.connectionId !== undefined) return null
  const candidates = rows.filter((row) => matches(row, clientId))
  if (candidates.length !== 1) return null
  const row = await resolveGoogleConnection(candidates[0].id, candidates[0].revision)
  await persistBinding(row, settings)
  return row
}

/** Bind the precise lineage returned by PollDevice, never another account by coincidence. */
export async function bindGoogleDriveConnection(lineageId: string): Promise<AuthConnectionRow> {
  const settings = (await getBackupDestinationsSettings()).googleDrive
  const rows = await listGoogleConnections()
  const row = rows.find((value) => value.hostMetadata?.adapterId === lineageId)
  if (!settings || !row || !matches(row, settings.clientId?.trim() ?? ""))
    throw new ConnectionUnavailableError("backup-connection-mismatch")
  await persistBinding(row, settings)
  return row
}

export async function getGoogleDriveCredentialLease() {
  const connection = await resolveGoogleDriveConnection()
  if (!connection) throw new ConnectionUnavailableError("backup-not-bound")
  const assertCurrent = async () => {
    await resolveGoogleConnection(connection.id, connection.revision)
    const cfg = (await getBackupDestinationsSettings()).googleDrive
    if (cfg?.connectionId !== connection.id || cfg.clientId?.trim() !== connection.clientId)
      throw new ConnectionRevisionChanged(connection.id, connection.revision)
  }
  // Built-in Host credential injection does not consume the plugin auth.google grant.
  const credential = await getConnectionManager()
    .getCredentials(connection.id, { minValidityMs: 60_000 })
    .catch(async (error: unknown) => {
      // A failed refresh can race logout too; retain the typed revision fence.
      await assertCurrent()
      throw error
    })
  await assertCurrent()
  return { accessToken: credential.accessToken, assertCurrent }
}
