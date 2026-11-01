// Cron-driven backup executor. Reads the task payload (`BackupTaskPayload`),
// streams the local package with auto-key encryption to disk under
// `appDataDir()/backups/`, and records a `scheduled` row in `backupHistory`.
//
// Different from the interval-based `BackupSchedulerProvider`:
//
//   - That provider runs every 30 min and reads `appSettings.backupAutoSchedule`
//     for a single global schedule (interval days + retain count + dirPath).
//   - This executor handles arbitrary cron expressions created via the
//     `BackupScheduleDialog` and runs through the standard scheduler tab-lock
//     so only the leader tab fires it.
//
// Host gate: needs the host filesystem (`lib/scheduler/host-support.ts`), so it
// runs on the desktop and the headless brain and is refused with a structured
// reason elsewhere. The local leg writes through `lib/data/backup-host-filesystem`
// (Tauri plugin-fs on the desktop, the injected Node adapter on the brain).
// Destinations: `local` writes the auto-key-encrypted package to disk;
// `webdav` / `github` / `googledrive` upload a sync-passphrase-encrypted
// snapshot through `lib/data/destinations`; `all` does local + every remote.
// `convex` is deprecated.

import type { ScheduledTask, TaskExecution, TaskExecutorResult } from "@/types/scheduler"
import type {
  BackupDestination,
  BackupSelectionOptions,
  BackupTaskPayload,
  BackupTaskType,
} from "@/types/scheduler"
import {
  buildBackupPackage,
  defaultExportFileName,
  serializePackage,
} from "@/lib/data/build-package"
import type { ExportOptions } from "@/lib/data/types"
import { getDefaultBackupPassphrase } from "@/lib/data/backup-key"
import { appendBackupHistory, type BackupHistoryEncryption } from "@/lib/db/backup-history"
import { getDb } from "@/lib/db/schema"
import { assertTaskTypeSupportedOnHost } from "../host-support"
import { loggers } from "@cognia/logging"
import {
  dispatchBackupDestination,
  remoteLegsFor,
  readBackupDestinationReadiness,
  getBackupDestination,
} from "@/lib/data/destinations"
import { isDeprecatedBackupDestination } from "@/lib/data/destinations/config"
import { encryptSnapshotBody, webdavSnapshotName } from "@/lib/data/destinations/webdav"
import { resolveBackupHostFilesystem } from "@/lib/data/backup-host-filesystem"
import { getSyncPassphrase } from "@/lib/webdav/passphrase-cache"
import { attachPortableRetrievalKeys } from "@/lib/data/retrieval-key-backup"
import { writeEncryptedLocalBackup } from "@/lib/data/backup-scheduler"

const log = loggers.scheduler

type ExecutorResult = TaskExecutorResult

/**
 * Map the schedule's user-facing selection to an exact payload contract.
 */
function payloadToBuildOptions(
  type: BackupTaskType | undefined,
  options: BackupSelectionOptions | undefined
): ExportOptions {
  // The cron path always omits the API key — it's a long-lived encrypted-file
  // sitting on disk; baking the API key in would be a leak.
  const base = { includeApiKey: false } as const
  if (type === "sessions") {
    return {
      ...base,
      includeSessions: true,
      includeSettings: false,
      includeCoreData: false,
      includePlugins: false,
      includeLocalStorage: false,
    }
  }
  if (type === "settings") {
    return {
      ...base,
      includeSessions: false,
      includeSettings: true,
      includeCoreData: false,
      includePlugins: false,
      includeLocalStorage: true,
      includeArtifacts: false,
    }
  }
  if (type === "plugins") {
    return {
      ...base,
      includeSessions: false,
      includeSettings: false,
      includeCoreData: false,
      includePlugins: true,
      includeLocalStorage: false,
    }
  }
  if (type === "all") {
    return {
      ...base,
      includeSessions: true,
      includeSettings: true,
      includeCoreData: true,
      includePlugins: true,
      includeLocalStorage: true,
      includeArtifacts: true,
    }
  }
  return {
    ...base,
    includeSessions: options?.includeSessions ?? true,
    includeSettings: options?.includeSettings ?? true,
    includeCoreData: options?.includeIndexedDB ?? true,
    includePlugins: false,
    includeLocalStorage: true,
    includeArtifacts: options?.includeArtifacts ?? true,
  }
}

// Destinations the executor fires. `local`/`undefined` → host filesystem;
// `webdav` / `github` / `googledrive` → the matching remote uploader; `all` →
// local + every remote. A destination is supported iff it targets at least one
// wired backend — `convex` is deprecated (see `lib/data/destinations/config.ts`).
function wantsLocal(destination: BackupDestination | undefined): boolean {
  return destination === undefined || destination === "local" || destination === "all"
}

/** @deprecated kept for `__TESTING__` compatibility; use `remoteLegsFor`. */
function wantsWebdav(destination: BackupDestination | undefined): boolean {
  return remoteLegsFor(destination).includes("webdav")
}

function isSupportedDestination(destination: BackupDestination | undefined): boolean {
  if (isDeprecatedBackupDestination(destination)) return false
  return wantsLocal(destination) || remoteLegsFor(destination).length > 0
}

export async function executeBackupTask(
  task: ScheduledTask,
  execution: TaskExecution,
  _signal: AbortSignal
): Promise<ExecutorResult> {
  const db = getDb()
  const assertActive = () => {
    _signal.throwIfAborted()
    if (getDb() !== db) throw new Error("backup_owner_changed")
  }
  const finishedLegs = new Set<BackupDestination>()
  const payload = (task.payload ?? {}) as Partial<BackupTaskPayload>
  const destination = payload.destination
  const plannedRemoteLegs = remoteLegsFor(destination)

  if (!isSupportedDestination(destination)) {
    const error = isDeprecatedBackupDestination(destination)
      ? `Backup destination "${destination}" is deprecated and no longer supported; edit the task to pick local / webdav / github / googledrive.`
      : `Backup destination "${destination}" is not supported in cognia-next; only "local"/"webdav"/"github"/"googledrive"/"all" are wired up.`
    await safelyAppendFailure(error, "auto-key", destination)
    return { success: false, error }
  }

  const refused = assertTaskTypeSupportedOnHost(task.type)
  if (refused) {
    await safelyAppendFailure(refused.error, "auto-key", destination)
    return refused
  }

  try {
    const buildOpts = payloadToBuildOptions(payload.backupType, payload.options)
    let basePackage: Awaited<ReturnType<typeof buildBackupPackage>> | undefined
    const output: Record<string, unknown> = {}
    const remoteLegs = plannedRemoteLegs
    const localOnly = destination === undefined || destination === "local"

    if (wantsLocal(destination)) {
      const host = await resolveBackupHostFilesystem()
      const dir = host ? await host.resolveBackupDir() : null
      assertActive()
      if (!host || !dir) {
        const error = host
          ? "Local backup skipped — no backup directory is configured on this host (Settings → Data → Auto backup directory)."
          : "Local backup skipped — this host has no filesystem for backups."
        await safelyAppendFailure(error, "auto-key", "local")
        // Local-only tasks fail hard; `all` keeps going and reports the leg.
        if (localOnly) return { success: false, error }
        finishedLegs.add("local")
        output.local = { skipped: true, error }
      } else {
        const passphrase = await getDefaultBackupPassphrase()
        assertActive()
        if (!passphrase) throw new Error("Auto-key not available on this runtime.")
        // A different payload/request must retain its own generation, even on the
        // same day and in the interval producer's configured directory.
        const filename = defaultExportFileName(new Date(), "encrypted").replace(
          ".enc.cbk",
          `-cron-${encodeURIComponent(task.id)}-${encodeURIComponent(execution.id)}.enc.cbk`
        )
        const target = host.join(dir, filename)
        const written = await writeEncryptedLocalBackup(
          host.filesystem,
          target,
          buildOpts,
          passphrase,
          _signal
        )
        assertActive()
        basePackage = written.basePackage
        await appendBackupHistory({
          completedAt: Date.now(),
          type: "scheduled",
          success: true,
          encryption: "auto-key",
          sizeBytes: written.sizeBytes,
          filename,
          destination: "local",
          producer: "cron",
        })
        finishedLegs.add("local")
        output.local = { target, sizeBytes: written.sizeBytes, filename }
      }
    }

    assertActive()
    if (remoteLegs.length > 0) {
      const syncPass = getSyncPassphrase()
      const readyLegs: BackupDestination[] = []
      for (const leg of remoteLegs) {
        const readiness = await readBackupDestinationReadiness(leg, _signal)
        assertActive()
        if (readiness.state === "ready") readyLegs.push(leg)
        else {
          const unavailable = !getBackupDestination(leg)
          const error = unavailable
            ? "destination unavailable on this runtime"
            : `skipped: not ready (${readiness.reasonKey ?? readiness.state})${readiness.reasonKey === "syncPassphraseLocked" ? "; unlock the sync passphrase" : ""}`
          await appendBackupHistory({
            completedAt: Date.now(),
            type: "scheduled",
            success: false,
            encryption: "passphrase",
            destination: leg,
            producer: "cron",
            errorMessage: error,
            result: { status: unavailable ? "failed" : "skipped", reasonKey: readiness.reasonKey },
          })
          finishedLegs.add(leg)
          output[leg] = { skipped: !unavailable, failed: unavailable, error }
        }
      }
      if (!readyLegs.length && !wantsLocal(destination))
        return { success: false, output, error: (output[remoteLegs[0]] as { error: string }).error }
      if (syncPass && readyLegs.length) {
        try {
          basePackage ??= await buildBackupPackage(buildOpts)
          const pkg = await attachPortableRetrievalKeys(basePackage, syncPass)
          const plaintext = serializePackage(pkg)
          const body = await encryptSnapshotBody(plaintext, pkg, syncPass)
          const filename = webdavSnapshotName(pkg.manifest.exportedAt)
          const meta = { filename, exportedAt: pkg.manifest.exportedAt, sizeBytes: body.length }
          let anyRemoteSucceeded = false
          for (const leg of readyLegs) {
            assertActive()
            const result = await dispatchBackupDestination(leg, body, meta, assertActive, _signal)
            if (getDb() !== db)
              return { success: false, error: "backup_owner_changed_or_cancelled" }
            finishedLegs.add(leg)
            if (result.cancelled) {
              await appendBackupHistory({
                completedAt: Date.now(),
                type: "scheduled",
                success: false,
                encryption: "passphrase",
                destination: leg,
                producer: "cron",
                errorMessage: "cancelled",
                result: { status: "cancelled" },
              })
              output[leg] = { cancelled: true }
              // Let the outer cancellation handler close every remaining planned leg.
              _signal.throwIfAborted()
              continue
            }
            assertActive()
            if (result.ok) {
              anyRemoteSucceeded = true
              await appendBackupHistory({
                completedAt: Date.now(),
                type: "scheduled",
                success: true,
                encryption: "passphrase",
                sizeBytes: body.length,
                filename,
                destination: leg,
                producer: "cron",
                result: { status: "success", ...result.result },
              })
              output[leg] = { target: result.target, sizeBytes: body.length, filename }
            } else {
              const error = result.error ?? `${leg} upload failed.`
              await safelyAppendFailure(error, "passphrase", leg)
              output[leg] = { failed: true, error }
            }
          }
          // A single-remote task fails when its one leg failed; `all` (or a
          // remote-only fan-out) fails only when every remote leg failed and
          // there was no local success to report.
          const remoteFailures = readyLegs.filter(
            (leg) =>
              (output[leg] as { failed?: boolean; cancelled?: boolean } | undefined)?.failed ||
              (output[leg] as { cancelled?: boolean } | undefined)?.cancelled
          )
          if (remoteFailures.length > 0 && !wantsLocal(destination) && !anyRemoteSucceeded) {
            const first = output[remoteFailures[0]] as { error?: string }
            return { success: false, output, error: first.error ?? "Remote upload failed." }
          }
          if (
            remoteFailures.length === remoteLegs.length &&
            remoteLegs.length === 1 &&
            !wantsLocal(destination)
          ) {
            const first = output[remoteFailures[0]] as { error?: string }
            return { success: false, output, error: first.error ?? "Remote upload failed." }
          }
        } catch (error) {
          assertActive()
          const message = error instanceof Error ? error.message : String(error)
          for (const leg of readyLegs) {
            await safelyAppendFailure(message, "passphrase", leg)
            output[leg] = { failed: true, error: message }
          }
          if (!output.local || (output.local as { skipped?: boolean }).skipped)
            return { success: false, output, error: message }
        }
      }
    }

    log.info("Scheduler backup task complete", {
      taskId: task.id,
      executionId: execution.id,
      destination: destination ?? "local",
      output,
    })

    if (
      !Object.values(output).some(
        (value) => value && typeof value === "object" && "target" in value
      )
    )
      return { success: false, output, error: "No backup destination is ready." }
    return { success: true, output }
  } catch (err) {
    if (getDb() !== db) return { success: false, error: "backup_owner_changed_or_cancelled" }
    if (_signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      const pending: BackupDestination[] = [
        ...(wantsLocal(destination) ? ["local" as const] : []),
        ...plannedRemoteLegs,
      ].filter((leg) => !finishedLegs.has(leg))
      for (const leg of pending) {
        await appendBackupHistory({
          completedAt: Date.now(),
          type: "scheduled",
          success: false,
          encryption: leg === "local" ? "auto-key" : "passphrase",
          destination: leg,
          producer: "cron",
          errorMessage: "cancelled",
          result: { status: "cancelled" },
        })
      }
      return { success: false, error: "cancelled" }
    }
    const error = err instanceof Error ? err.message : String(err)
    await safelyAppendFailure(error, "auto-key", destination)
    log.error("Scheduler backup task failed", { taskId: task.id, error })
    return { success: false, error }
  }
}

async function safelyAppendFailure(
  errorMessage: string,
  encryption: BackupHistoryEncryption = "auto-key",
  destination?: BackupDestination
): Promise<void> {
  try {
    await appendBackupHistory({
      completedAt: Date.now(),
      type: "scheduled",
      success: false,
      encryption,
      errorMessage,
      destination,
      producer: "cron",
      result: { status: "failed" },
    })
  } catch {
    // Don't let history failures mask the real error in the result.
  }
}

export const __TESTING__ = {
  payloadToBuildOptions,
  isSupportedDestination,
  wantsLocal,
  wantsWebdav,
}
