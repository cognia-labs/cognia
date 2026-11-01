// The same registry drives built-in and plugin dispatch. Local files stay Host-owned.
import "./builtins"
import type { BackupDestination } from "@/types/scheduler"
import type { BackupDestinationResult } from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"
import { isDeprecatedBackupDestination } from "./config"
import { getBackupDestination, listBackupDestinations, withBackupDestination } from "./registry"
import type { SnapshotMeta } from "./webdav"
import { isEncryptedEnvelope } from "@/lib/data/migrate"
import { getSyncPassphrase } from "@/lib/webdav/passphrase-cache"
import type { BackupDestinationReadiness } from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"

export * from "./registry"
export type DispatchResult = {
  ok: boolean
  target?: string
  error?: string
  cancelled?: boolean
  result?: BackupDestinationResult
}

/** Host key readiness always precedes a contributor's account readiness. */
export async function readBackupDestinationReadiness(
  destination: string,
  signal?: AbortSignal,
  keyAvailable = Boolean(getSyncPassphrase())
): Promise<BackupDestinationReadiness> {
  if (!getBackupDestination(destination))
    return { state: "unavailable", reasonKey: "destinationUnavailable" }
  if (!keyAvailable) return { state: "needs-setup", reasonKey: "syncPassphraseLocked" }
  try {
    return await withBackupDestination(destination, signal, async (entry, active) => {
      const result = await entry.readiness(active)
      if (!["ready", "needs-setup", "needs-auth", "unavailable"].includes(result?.state))
        return { state: "unavailable", reasonKey: "destinationUnavailable" }
      return {
        state: result.state,
        ...(typeof result.reasonKey === "string" ? { reasonKey: result.reasonKey } : {}),
      }
    })
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error
    return { state: "unavailable", reasonKey: "destinationUnavailable" }
  }
}

export function remoteLegsFor(destination: BackupDestination | undefined): BackupDestination[] {
  if (destination === "all") return listBackupDestinations().map((entry) => entry.id)
  if (!destination || destination === "local" || isDeprecatedBackupDestination(destination))
    return []
  // Keep unavailable plugin tasks; dispatch records the failed leg.
  return destination.startsWith("plugin:") || getBackupDestination(destination) ? [destination] : []
}

export async function dispatchBackupDestination(
  destination: BackupDestination | undefined,
  envelopeJson: string,
  meta: SnapshotMeta,
  assertActive: () => void = () => undefined,
  signal?: AbortSignal
): Promise<DispatchResult> {
  assertActive()
  if (!destination || destination === "local") return { ok: true, target: "local" }
  if (isDeprecatedBackupDestination(destination))
    return {
      ok: false,
      error: `Backup destination "${destination}" is deprecated and no longer supported.`,
    }
  if (
    destination !== "all" &&
    !getBackupDestination(destination) &&
    !destination.startsWith("plugin:")
  )
    return {
      ok: false,
      error: `Backup destination "${destination}" is not supported in cognia-next.`,
    }
  try {
    return await withBackupDestination(
      destination === "all" ? "webdav" : destination,
      signal,
      async (entry, active) => {
        assertActive()
        if (entry.pluginId && !isEncryptedEnvelope(JSON.parse(envelopeJson)))
          throw new Error("Remote backup requires ciphertext")
        const body = new TextEncoder().encode(envelopeJson)
        const input = {
          body,
          meta: {
            snapshotId: meta.filename,
            createdAt: meta.exportedAt,
            bytes: entry.pluginId ? body.byteLength : meta.sizeBytes,
            contentType: "application/octet-stream",
            encryption: "passphrase" as const,
          },
        }
        const uploaded = entry.pluginId
          ? await entry.upload(input, active)
          : await entry.upload(input, active, assertActive)
        active.throwIfAborted()
        assertActive()
        if (
          !uploaded ||
          typeof uploaded.remoteId !== "string" ||
          !uploaded.remoteId ||
          !Number.isFinite(uploaded.bytes) ||
          uploaded.bytes < 0 ||
          (uploaded.locationLabel !== undefined && typeof uploaded.locationLabel !== "string")
        )
          throw new Error("Invalid backup destination result")
        const result = {
          remoteId: uploaded.remoteId,
          bytes: uploaded.bytes,
          ...(uploaded.locationLabel ? { locationLabel: uploaded.locationLabel } : {}),
        }
        // Host retention is optional when the contributor cannot enumerate/delete.
        if (entry.pluginId && entry.list && entry.delete) {
          try {
            const { getSettings } = await import("@/lib/db/settings")
            const settings = await getSettings()
            active.throwIfAborted()
            assertActive()
            const configured = settings.backupAutoSchedule?.retainCount
            const retain = Number.isInteger(configured) && configured! > 0 ? configured! : 5
            const snapshots = await entry.list(active)
            const known = snapshots.filter(
              (snapshot) =>
                snapshot &&
                typeof snapshot.remoteId === "string" &&
                snapshot.remoteId !== result.remoteId &&
                typeof snapshot.createdAt === "string" &&
                Number.isFinite(Date.parse(snapshot.createdAt))
            )
            known.sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!))
            for (const snapshot of known.slice(retain - 1)) {
              active.throwIfAborted()
              assertActive()
              await entry.delete(snapshot.remoteId, active)
            }
          } catch {
            active.throwIfAborted()
            assertActive()
          }
        }
        return { ok: true, target: result.locationLabel ?? result.remoteId, result }
      }
    )
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
      return { ok: false, cancelled: true, error: "cancelled" }
    assertActive()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
