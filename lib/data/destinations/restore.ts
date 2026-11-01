import { getBackupDestination, withBackupDestination, readBackupDestinationBody } from "./index"
import { restoreBackupCiphertext, type RestoreOptions } from "@/lib/webdav/restore"
import type { BackupDestinationSnapshot } from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"

export function supportsBackupDestinationRestore(id: string): boolean {
  const entry = getBackupDestination(id)
  return Boolean(entry?.list && entry.download)
}

export async function listBackupDestinationSnapshots(
  id: string,
  signal?: AbortSignal
): Promise<BackupDestinationSnapshot[]> {
  return withBackupDestination(id, signal, async (entry, active) => {
    if (!entry.list || !entry.download) throw new Error("Destination restore is unavailable")
    const snapshots = await entry.list(active)
    if (
      !Array.isArray(snapshots) ||
      snapshots.some(
        (snapshot) =>
          !snapshot ||
          typeof snapshot.remoteId !== "string" ||
          !snapshot.remoteId ||
          typeof snapshot.label !== "string"
      )
    )
      throw new Error("Invalid backup snapshot list")
    return snapshots.map(({ remoteId, label, createdAt, bytes }) => ({
      remoteId,
      label,
      createdAt,
      bytes,
    }))
  })
}

export async function restoreFromBackupDestination(
  id: string,
  remoteId: string,
  opts: RestoreOptions,
  signal?: AbortSignal
) {
  const raw = await withBackupDestination(id, signal, async (entry, active) => {
    if (!entry.list || !entry.download) throw new Error("Destination restore is unavailable")
    const body = await entry.download(remoteId, active)
    active.throwIfAborted()
    const bytes = await readBackupDestinationBody(body, active)
    active.throwIfAborted()
    return new TextDecoder().decode(bytes)
  })
  // The remote read has completed. A user-kept ciphertext copy now belongs to
  // the Host restore flow; disposing its provider cannot race a local commit.
  return restoreBackupCiphertext(raw, opts, () => signal?.throwIfAborted())
}
