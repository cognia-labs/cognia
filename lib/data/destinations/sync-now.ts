/**
 * Manual "Sync now" for the remote backup destinations other than WebDAV
 * (GitHub / Google Drive) — the same pipeline `lib/webdav/sync-now.ts` runs:
 * build the full package, encrypt with the sync passphrase, upload through
 * the destination dispatcher, record a history row (with `destination`), and
 * cache the passphrase for the session. Shared by the settings cards and any
 * future caller (mobile trigger, agent tool).
 */

import { buildBackupPackage, serializePackage } from "@/lib/data/build-package"
import { attachPortableRetrievalKeys } from "@/lib/data/retrieval-key-backup"
import { appendBackupHistory, type BackupHistoryType } from "@/lib/db/backup-history"
import {
  getSyncPassphrase,
  persistSyncPassphrase,
  setSyncPassphrase,
} from "@/lib/webdav/passphrase-cache"
import { getDb } from "@/lib/db/schema"
import type { BackupPackageV3 } from "@/lib/data/types"
import type { BackupDestination } from "@/types/scheduler"
import {
  dispatchBackupDestination,
  readBackupDestinationReadiness,
  getBackupDestination,
} from "./index"
import { encryptSnapshotBody, webdavSnapshotName } from "./webdav"

export type RemoteBackupSyncPhase = "building" | "encrypting" | "uploading" | "done"

export type RemoteBackupSyncDestination = Extract<
  BackupDestination,
  "github" | "googledrive" | "webdav" | `plugin:${string}/${string}`
>

export interface RemoteBackupSyncNowOptions {
  missingPassphraseMessage?: string
  basePackage?: BackupPackageV3
  producer?: "interval" | "cron"
  assertActive?: () => void
  signal?: AbortSignal
  historyType?: BackupHistoryType
  onProgress?: (phase: RemoteBackupSyncPhase) => void
  /** Test seam. */
  dispatch?: typeof dispatchBackupDestination
}

export async function runRemoteBackupSyncNow(
  destination: RemoteBackupSyncDestination,
  passphrase: string,
  opts: RemoteBackupSyncNowOptions = {}
): Promise<{ ok: true; target?: string } | { ok: false; error: string }> {
  const historyType = opts.historyType ?? "manual"
  const onProgress = opts.onProgress ?? (() => undefined)
  const dispatch = opts.dispatch ?? dispatchBackupDestination

  const db = getDb()
  const assertActive = () => {
    opts.signal?.throwIfAborted()
    opts.assertActive?.()
    if (getDb() !== db) throw new Error("backup_owner_changed")
  }
  const pass = passphrase || getSyncPassphrase() || ""
  if (!pass) {
    const error = opts.missingPassphraseMessage ?? "A sync passphrase is required."
    await appendBackupHistory({
      completedAt: Date.now(),
      type: historyType,
      success: false,
      encryption: "passphrase",
      destination,
      producer: opts.producer,
      errorMessage: error,
      result: { status: "skipped", reasonKey: "syncPassphraseLocked" },
    })
    return { ok: false, error }
  }

  try {
    assertActive()
    if (!opts.dispatch) {
      const readiness = await readBackupDestinationReadiness(
        destination,
        opts.signal,
        Boolean(pass)
      )
      assertActive()
      if (readiness.state !== "ready") {
        const unavailable = !getBackupDestination(destination)
        const error = unavailable
          ? "destination unavailable on this runtime"
          : `skipped: not ready (${readiness.reasonKey ?? readiness.state})`
        await appendBackupHistory({
          completedAt: Date.now(),
          type: historyType,
          success: false,
          encryption: "passphrase",
          destination,
          producer: opts.producer,
          errorMessage: error,
          result: {
            status: unavailable ? "failed" : "skipped",
            reasonKey: readiness.reasonKey,
          },
        })
        return { ok: false, error }
      }
    }
    opts.signal?.throwIfAborted()
    onProgress("building")
    const basePackage =
      opts.basePackage ??
      (await buildBackupPackage({ includeSessions: true, includeApiKey: false }))
    const pkg = await attachPortableRetrievalKeys(basePackage, pass)
    const plaintext = serializePackage(pkg)
    onProgress("encrypting")
    const body = await encryptSnapshotBody(plaintext, pkg, pass)
    assertActive()
    const filename = webdavSnapshotName(pkg.manifest.exportedAt)

    onProgress("uploading")
    const result = await dispatch(
      destination,
      body,
      {
        filename,
        exportedAt: pkg.manifest.exportedAt,
        sizeBytes: body.length,
      },
      assertActive,
      opts.signal
    )

    if (!result.cancelled) assertActive()
    if (getDb() !== db) throw new Error("backup_owner_changed")
    await appendBackupHistory({
      completedAt: Date.now(),
      type: historyType,
      success: result.ok,
      encryption: "passphrase",
      sizeBytes: result.ok ? body.length : undefined,
      filename: result.ok ? filename : undefined,
      errorMessage: result.ok ? undefined : result.error,
      deviceId: pkg.manifest.device?.id,
      deviceLabel: pkg.manifest.device?.label,
      destination,
      producer: opts.producer,
      result: {
        status: result.cancelled ? "cancelled" : result.ok ? "success" : "failed",
        ...result.result,
      },
    })

    if (!result.ok) return { ok: false, error: result.error ?? "Upload failed." }

    setSyncPassphrase(pass)
    await persistSyncPassphrase(pass)
    onProgress("done")
    return { ok: true, target: result.target }
  } catch (error) {
    if (getDb() !== db) return { ok: false, error: "backup_owner_changed" }
    const cancelled =
      opts.signal?.aborted || (error instanceof Error && error.name === "AbortError")
    const message = cancelled ? "cancelled" : error instanceof Error ? error.message : String(error)
    await appendBackupHistory({
      completedAt: Date.now(),
      type: historyType,
      success: false,
      encryption: "passphrase",
      destination,
      producer: opts.producer,
      errorMessage: message,
      result: { status: cancelled ? "cancelled" : "failed" },
    })
    return { ok: false, error: message }
  }
}
