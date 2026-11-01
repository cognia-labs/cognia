// WebDAV retains its public entry point and result shape; all remote work is Host-owned.
import {
  runRemoteBackupSyncNow,
  type RemoteBackupSyncPhase,
} from "@/lib/data/destinations/sync-now"
import type { BackupHistoryType } from "@/lib/db/backup-history"

export type WebDavSyncPhase = RemoteBackupSyncPhase
export interface WebDavSyncNowOptions {
  historyType?: BackupHistoryType
  onProgress?: (phase: WebDavSyncPhase) => void
  signal?: AbortSignal
}

export async function runWebDavSyncNow(
  passphrase: string,
  opts: WebDavSyncNowOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await runRemoteBackupSyncNow("webdav", passphrase, opts)
  return result.ok ? { ok: true } : result
}
