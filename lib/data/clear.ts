// Helpers used by the Clear-data section of the settings dialog. Each helper
// is destructive — the UI requires the user to type "DELETE" to confirm.

import Dexie from "dexie"

import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { clearBrowserPreviewData } from "@/lib/browser/preview-data"
import { getDb } from "@/lib/db/schema"
import { clearTemporarySessionAssets } from "@/lib/db/session-assets"
import { prepareBulkDeleteSessions } from "@/lib/db/sessions"
import { clearDraft } from "@/lib/db/chat-drafts"
import { preserveGeneratedVideoRecords } from "@/lib/db/files-library-items"
import { collectUnreferencedMessageMedia, isLibraryMediaRef } from "@/lib/db/message-media-refs"
import {
  CLEANUP_OWNERSHIP_TABLES,
  readCleanupRowOwnership,
  type CleanupRowOwnership,
} from "@/lib/storage/cleanup-ownership"
import { getRuntimeTargetScopeKey } from "@/lib/runtime/runtime-target-context"
import { fusionDatabaseName } from "@/lib/router-fusion/gate/database-name"
import { recordTombstones } from "@/lib/db/tombstones"
import { purgeDatabaseAppData } from "@/lib/tauri/account-app-data"
import { loggers } from "@cognia/logging"

export type ClearableTable =
  "sessions" | "characters" | "skills" | "teams" | "promptPresets" | "mcpServers" | "settings"

/**
 * Clear the named tables. Sessions also clear their associated messages,
 * draft/unread state and derived transcript/media indexes. Built-in
 * characters/skills/teams will be re-seeded automatically on next read.
 */
export async function clearTables(names: ClearableTable[]): Promise<void> {
  if (names.length === 0) return
  const db = getDb()
  const wantsSessions = names.includes("sessions")
  const targetKey = getRuntimeTargetScopeKey()
  const assertActive = () => {
    if (getDb() !== db || getRuntimeTargetScopeKey() !== targetKey)
      throw new Error("clear_owner_changed")
  }
  const draftSessionIds = new Set<string>()
  const orphanCandidates = new Set<string>()
  // These are the legacy reset's orphan tables, not a second session cascade.
  const orphanTables = [
    db.messages,
    db.sessionState,
    db.chatDrafts,
    db.chatInputHistory,
    db.chatTurnSummaries,
    db.chatTranscriptIndexState,
  ] as const
  let rowOwnership: CleanupRowOwnership | undefined
  const refreshOwnership = async () => {
    const ownership = await readCleanupRowOwnership(db)
    assertActive()
    rowOwnership = ownership
    return ownership
  }
  let deletion: Awaited<ReturnType<typeof prepareBulkDeleteSessions>> = null
  if (wantsSessions) {
    const ownership = await refreshOwnership()
    // Mirrored conversations are left to their Host, including persisted
    // channel bindings and descendants protected by the storage cleanup guard.
    const ids = await db.sessions.filter((row) => ownership.allows("sessions", row)).primaryKeys()
    assertActive()
    deletion = await prepareBulkDeleteSessions(ids, {
      db,
      assertActive,
      allowsCleanupRow: (table, row) => rowOwnership?.allows(table, row) ?? false,
      async assertSessionsDeletable(sessionIds) {
        const ownership = await refreshOwnership()
        if (sessionIds.some((id) => !ownership.allows("sessions", { id })))
          throw new Error("Storage cleanup session ownership changed")
      },
    })
  }

  try {
    await db.transaction(
      "rw",
      // The canonical cascade owns its evolving table set. Keep a combined reset
      // atomic without maintaining a second copy of that set here.
      [
        ...(deletion?.tables ?? []),
        ...(wantsSessions
          ? [
              ...orphanTables,
              db.messageMediaRefs,
              db.messageMedia,
              db.mediaGenerationJobs,
              db.libraryItems,
              ...CLEANUP_OWNERSHIP_TABLES.map((name) => db.table(name)),
            ]
          : []),
        db.characters,
        db.skills,
        db.teams,
        db.promptPresets,
        db.mcpServers,
        db.mcpServerSummaries,
        db.mcpCapabilityCache,
        db.settings,
        db.syncTombstones,
      ],
      async (transaction) => {
        assertActive()
        await deletion?.deleteInsideTransaction(transaction)
        if (wantsSessions) {
          const ownership = await refreshOwnership()
          const survivingIds = new Set(await db.sessions.toCollection().primaryKeys())
          const isOrphan = (row: { sessionId?: string }) =>
            typeof row.sessionId === "string" &&
            !survivingIds.has(row.sessionId) &&
            ownership.allows("sessions", { id: row.sessionId })
          // A reset also removes rows whose local session was already lost.
          // Host provenance still protects orphan rows through the same guard.
          const messageIds = await db.messages.filter(isOrphan).primaryKeys()
          const stateIds = await db.sessionState.filter(isOrphan).primaryKeys()
          for (const id of await db.chatDrafts.filter(isOrphan).primaryKeys())
            draftSessionIds.add(id)
          const videoSessionIds = new Set<string>()
          await db.mediaGenerationJobs
            .where("sessionId")
            .above("")
            .filter(isOrphan)
            .each((row) => {
              videoSessionIds.add(row.sessionId!)
            })
          await preserveGeneratedVideoRecords(db, [...videoSessionIds])
          const refs = db.messageMediaRefs.filter((row) => isOrphan(row) && !isLibraryMediaRef(row))
          const sourceHashes = new Set<string>()
          for (const ref of await refs.toArray()) {
            orphanCandidates.add(ref.hash)
            if (ref.sessionAsset) sourceHashes.add(ref.hash)
          }
          await refs.delete()
          for (const hash of sourceHashes) {
            if (!(await db.messageMediaRefs.where("hash").equals(hash).count()))
              await db.messageMedia.delete(hash)
          }
          for (const table of orphanTables) {
            await table.filter(isOrphan).delete()
          }
          await db.mediaGenerationJobs.where("sessionId").above("").filter(isOrphan).delete()
          const at = Date.now()
          await recordTombstones("messages", messageIds, at)
          await recordTombstones("sessionState", stateIds, at)
        }
        // Paired clients learn about a clear only through tombstones. Built-ins
        // are re-seeded on the Host and a paired client keeps its own, so only
        // user-authored rows are tombstoned: a built-in id in `deleted_ids`
        // would delete the client's seeded copy.
        const clearedAt = Date.now()
        if (names.includes("characters")) {
          const ids = await db.characters.filter((row) => !row.isBuiltIn).primaryKeys()
          await db.characters.clear()
          await recordTombstones("characters", ids as string[], clearedAt)
        }
        if (names.includes("skills")) {
          const ids = await db.skills.filter((row) => !row.isBuiltIn).primaryKeys()
          await db.skills.clear()
          await recordTombstones("skills", ids as string[], clearedAt)
        }
        if (names.includes("teams")) await db.teams.clear()
        if (names.includes("promptPresets")) await db.promptPresets.clear()
        if (names.includes("mcpServers")) {
          // The summaries are what a paired client mirrors (`mcpServers` on the
          // wire), so they go with the servers rather than outliving them.
          const ids = await db.mcpServerSummaries.toCollection().primaryKeys()
          await db.mcpServers.clear()
          await db.mcpServerSummaries.clear()
          await db.mcpCapabilityCache.clear()
          await recordTombstones("mcpServers", ids as string[], clearedAt)
        }
        if (names.includes("settings")) await db.settings.clear()
        assertActive()
      }
    )
  } catch (error) {
    await deletion?.finish(false)
    throw error
  }
  await deletion?.finish(true)
  assertActive()
  if (wantsSessions)
    clearTemporarySessionAssets(undefined, {
      db,
      allowsSession: (id) => rowOwnership?.allows("sessions", { id }) ?? false,
    })
  // External cleanup follows the combined commit so rollback preserves drafts
  // and media. The canonical cascade already handles the sessions it deleted.
  for (const sessionId of draftSessionIds) {
    assertActive()
    try {
      await clearDraft(sessionId, { hostAlreadyCleared: true })
    } catch (error) {
      loggers.store.warn("cleared session draft cleanup failed", {
        sessionId,
        error: String(error),
      })
    }
  }
  assertActive()
  if (orphanCandidates.size > 0) {
    try {
      await collectUnreferencedMessageMedia(orphanCandidates)
    } catch (error) {
      loggers.store.warn("cleared session media cleanup failed", { error: String(error) })
    }
  }
}

/**
 * Drop the entire database. The page must reload afterwards so Dexie can
 * re-open and re-run the seed step. The Router + Fusion ledger beside it only
 * describes the sessions just dropped, so it goes too; deleting a database that
 * was never created (Router + Fusion never switched on) is a no-op.
 *
 * The built-in browser keeps its preferences and its cookies outside the
 * database, so those are cleared here as well — otherwise a reset device stays
 * signed in to every site the preview visited, imported sign-ins included.
 * That part is best-effort: a cookie store that cannot be reached must not
 * leave the user's data half-deleted, so it is logged rather than thrown.
 *
 * Both deletions are verified, like every other path that deletes a main
 * database and its ledger (account removal, runtime-target removal, the
 * refused-layout reset): a delete that silently did nothing must not be
 * reported to the user as "all data cleared".
 *
 * The videos this database's workflow jobs generated, and any composer
 * staging copy, are files under AppData in the database's own directory; they
 * go too. Also best-effort: a file held open is removed by the retention sweep
 * once no job row accounts for it.
 */
export interface ClearAllResult {
  databaseReset: true
  cleanupFailures: Array<"browserPreview" | "appData">
}

export async function clearAll(): Promise<ClearAllResult> {
  const db = getDb()
  const mainName = db.name
  const localAccountId = getActiveAccountId()
  const fusionName = fusionDatabaseName(mainName)
  await db.delete()
  clearTemporarySessionAssets()
  await Dexie.delete(fusionName)
  for (const name of [mainName, fusionName]) {
    if (await Dexie.exists(name)) {
      throw new Error(`Clear all data could not verify the deletion of ${name}`)
    }
  }
  const cleanupFailures: ClearAllResult["cleanupFailures"] = []
  try {
    await clearBrowserPreviewData()
  } catch (error) {
    cleanupFailures.push("browserPreview")
    loggers.store.warn("clear all: browser preview data was not cleared", {
      error: String(error),
    })
  }
  try {
    await purgeDatabaseAppData(localAccountId, mainName)
  } catch (error) {
    cleanupFailures.push("appData")
    loggers.store.warn("clear all: generated video files were not all removed", {
      error: String(error),
    })
  }
  return { databaseReset: true, cleanupFailures }
}
