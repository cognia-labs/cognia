/** ADR-0246: destinations own protocol/account selection; the Host owns backup data. */
export type PluginBackupDestinationId = `plugin:${string}/${string}`
export type BackupDestinationBody = ReadableStream<Uint8Array> | Uint8Array

export interface BackupDestinationReadiness {
  state: "ready" | "needs-setup" | "needs-auth" | "unavailable"
  /** Translation key supplied by the destination; never credentials or connection references. */
  reasonKey?: string
}

export interface BackupDestinationMeta {
  snapshotId: string
  createdAt: string
  bytes: number
  contentType: string
  encryption: "passphrase" | "device-key"
}

export interface BackupDestinationResult {
  remoteId: string
  bytes: number
  locationLabel?: string
}

export interface BackupDestinationSnapshot {
  remoteId: string
  label: string
  createdAt?: string
  bytes?: number
}

export interface BackupDestinationDeclaration {
  /** Local id. The Host registers it as plugin:<pluginId>/<id>. */
  id: string
  label: string
}

export interface BackupDestinationContribution extends BackupDestinationDeclaration {
  readiness(signal: AbortSignal): Promise<BackupDestinationReadiness>
  /**
   * Ciphertext only. Resolve your own account through ctx.auth.connections and
   * use ctx.integrations.authenticatedRequest under your consumer grant. The
   * Host passes no secrets, plaintext packages, or account identity.
   */
  upload(
    input: { body: BackupDestinationBody; meta: BackupDestinationMeta },
    signal: AbortSignal
  ): Promise<BackupDestinationResult>
  list?(signal: AbortSignal): Promise<BackupDestinationSnapshot[]>
  /** Returns ciphertext; the Host decrypts, validates and applies it. */
  download?(remoteId: string, signal: AbortSignal): Promise<BackupDestinationBody>
  delete?(remoteId: string, signal: AbortSignal): Promise<void>
}

export interface BackupDestinationRegistration {
  destinationId: PluginBackupDestinationId
  unregister(): void
}

const RESERVED_IDS = new Set(["local", "webdav", "github", "googledrive", "convex", "all"])

export function validateBackupDestinationDeclaration(input: unknown): string[] {
  if (!input || typeof input !== "object") return ["Backup destination must be an object"]
  const def = input as Partial<BackupDestinationDeclaration>
  const errors: string[] = []
  if (typeof def.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(def.id))
    errors.push("Backup destination id must be a local lowercase identifier")
  else if (RESERVED_IDS.has(def.id)) errors.push("Backup destination id is reserved by the Host")
  if (typeof def.label !== "string" || !def.label.trim())
    errors.push("Backup destination label is required")
  return errors
}
