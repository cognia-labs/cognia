// Category-scoped cleanup operations. The Maintenance tab's
// `StorageCleanupDialog` calls these to free space without nuking everything
// (use `StorageManager.clearAllCogniaData()` for that).
//
// Three flavors:
//   - cleanupCategories: targeted, deletes the user-selected buckets.
//   - quickCleanup: wipes catalog-declared cache/projection rows.
//   - deepCleanup: additionally removes catalog-declared audit/queue rows that
//     have a recognized lifecycle timestamp older than seven days.
//
// `previewCleanup` runs the same accounting without writing, so the dialog
// can show "this will free ~X MB" before the user commits.

import { getDb } from "@/lib/db/schema"
import { bulkDeleteSessions, type SessionPersistenceScope } from "@/lib/db/sessions"
import { isMessageOwnedMediaRef, type MessageMediaRefRow } from "@/lib/db/message-media-refs"
import { recordTombstones } from "@/lib/db/tombstones"
import { getRuntimeTargetScopeKey } from "@/lib/runtime/runtime-target-context"
import {
  canCleanHostSourceTables,
  getCleanupOwnership,
  cleanupDatabaseName,
  getCleanupTargetKey,
  readCleanupOwnership,
} from "./cleanup-target"
import {
  CLEANUP_OWNERSHIP_TABLES,
  cleanupSourceIsAllowed,
  readCleanupRowOwnership,
  type CleanupRowOwnership,
} from "./cleanup-ownership"
import type { CleanupOwnership } from "./cleanup-target"
export { getCleanupTargetKey } from "./cleanup-target"
import { companionSyncTablesForSources } from "@/lib/data-governance/table-catalog"
import { estimateRowSize as rowSize } from "./storage-manager"
import { policyForTable, type DataCleanupPolicy } from "@/lib/data-governance/table-catalog"
import { tablesForCategory } from "./category-info"
import type {
  CleanupOptions,
  CleanupResult,
  StorageCategory,
  StorageCleanupAvailability,
} from "./types"

const DEEP_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000

function emptyResult(): CleanupResult {
  return { freedSpace: 0, deletedItems: 0, details: [], errors: [] }
}

const RETENTION_TIMESTAMP_FIELDS = [
  "completedAt",
  "updatedAt",
  "createdAt",
  "timestamp",
  "ts",
  "startTime",
  "queuedAt",
  "occurredAt",
  "recordedAt",
] as const

function retentionTimestamp(row: unknown): number | undefined {
  if (!row || typeof row !== "object") return undefined
  const record = row as Record<string, unknown>
  for (const field of RETENTION_TIMESTAMP_FIELDS) {
    const value = record[field]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function isEligibleForCleanup(row: unknown, olderThan?: number): boolean {
  if (typeof olderThan !== "number") return true
  const timestamp = retentionTimestamp(row)
  // A deep cleanup must fail closed when a governed table has no recognized
  // lifecycle timestamp. Deleting undated rows would turn a missing policy
  // adapter into an unbounded purge.
  return timestamp !== undefined && timestamp <= olderThan
}

function captureScope(expectedTarget?: string): SessionPersistenceScope {
  const db = getDb()
  const databaseName = cleanupDatabaseName()
  const targetKey = getRuntimeTargetScopeKey()
  const target = expectedTarget ?? getCleanupTargetKey()
  return {
    db,
    assertActive() {
      if (
        !target ||
        db.name !== databaseName ||
        getDb() !== db ||
        getRuntimeTargetScopeKey() !== targetKey ||
        getCleanupTargetKey() !== target
      ) {
        throw new Error("Storage cleanup target changed")
      }
    },
  }
}

function ownedRow(table: string, row: unknown): boolean {
  if (table === "messageMediaRefs") return isMessageOwnedMediaRef(row as MessageMediaRefRow)
  if (table === "mediaGenerationJobs") return Boolean((row as { sessionId?: string }).sessionId)
  return true
}

// Session deletion owns these cascades, including categories outside Sessions.
const SESSION_CASCADE_TABLES = [
  "sessions",
  "messages",
  "sessionState",
  "chatDrafts",
  "chatInputHistory",
  "chatTurnSummaries",
  "chatTranscriptIndexState",
  "sessionUsage",
  "sessionPeerMessages",
  "chatGoals",
  "chatGoalEvents",
  "agentPlans",
  "agentPlanEvents",
  "loops",
  "loopEvents",
  "mediaGenerationJobs",
  "messageMediaRefs",
  "messageMedia",
  "executionRuns",
  "executionRunEvents",
  "executionRunBindings",
  "executionRunInterrupts",
  "runResultSummaries",
]

function markAccounted(
  scope: SessionPersistenceScope,
  name: string,
  row: Record<string, unknown>,
  seen?: Set<string>
): boolean {
  if (!seen) return true
  const path = scope.db.table(name).schema.primKey.keyPath
  const key = JSON.stringify([
    name,
    Array.isArray(path) ? path.map((part) => row[part]) : row[path as string],
  ])
  if (seen.has(key)) return false
  seen.add(key)
  return true
}

async function sessionCascadeStats(
  scope: SessionPersistenceScope,
  sessions: Record<string, unknown>[],
  seen?: Set<string>
): Promise<{ deletedItems: number; freedSpace: number }> {
  const owned = new Map(sessions.map((row) => [String(row.id), row]))
  let frontier = [...owned.keys()]
  // Match bulkDeleteSessions' attached-child and bound-side-chat closure.
  // The indexed binding key is the canonical encoded ["session", id] key.
  while (frontier.length > 0) {
    scope.assertActive()
    const children = await scope.db
      .table("sessions")
      .where("parentSessionId")
      .anyOf(frontier)
      .toArray()
    const sideChats = await scope.db
      .table("sessions")
      .where("surfaceBindingKey")
      .anyOf(frontier.map((id) => ["session", id].map(encodeURIComponent).join(":")))
      .toArray()
    const next: string[] = []
    for (const row of children) {
      if (
        owned.has(row.id) ||
        !row.parentSessionId ||
        row.attachedChild?.parentSessionId !== row.parentSessionId ||
        row.attachedChild?.lifecycleOwnerSessionId !== row.parentSessionId
      )
        continue
      owned.set(row.id, row)
      next.push(row.id)
    }
    for (const row of sideChats) {
      if (owned.has(row.id)) continue
      owned.set(row.id, row)
      next.push(row.id)
    }
    frontier = next
  }
  const ids = [...owned.keys()]
  const stats = { deletedItems: 0, freedSpace: 0 }
  const account = (name: string, row: Record<string, unknown>) => {
    scope.assertActive()
    if (scope.allowsCleanupRow && !scope.allowsCleanupRow(name, row)) return
    if (!markAccounted(scope, name, row, seen)) return
    stats.deletedItems += 1
    stats.freedSpace += rowSize(row)
  }
  for (const row of owned.values()) account("sessions", row)
  for (const name of SESSION_CASCADE_TABLES) {
    scope.assertActive()
    if (name === "sessions") continue
    // Shared media is released only when its last reference disappears, and
    // execution projections are deleted only for managed desktop runs. Omit
    // those conditional releases from this conservative estimate rather than
    // reading unrelated owners or counting rows the cascade may retain.
    if (name === "messageMedia" || name.startsWith("executionRun") || name === "runResultSummaries")
      continue
    const table = scope.db.tables.find((entry) => entry.name === name)
    if (!table) continue
    if (
      table.schema.primKey.keyPath === "sessionId" ||
      table.schema.indexes.some((index) => index.name === "sessionId")
    ) {
      await table
        .where("sessionId")
        .anyOf(ids)
        .each((row) => account(name, row))
    } else if (name === "sessionPeerMessages") {
      await table
        .where("senderSessionId")
        .anyOf(ids)
        .or("receiverSessionId")
        .anyOf(ids)
        .each((row) => account(name, row))
    } else {
      const owner =
        name === "chatGoalEvents"
          ? { table: scope.db.chatGoals, key: "goalId" }
          : name === "agentPlanEvents"
            ? { table: scope.db.agentPlans, key: "planId" }
            : name === "loopEvents"
              ? { table: scope.db.loops, key: "loopId" }
              : null
      if (!owner) continue // No session ownership index: leave it out of the estimate.
      const ownerIds = await owner.table.where("sessionId").anyOf(ids).primaryKeys()
      scope.assertActive()
      if (ownerIds.length > 0)
        await table
          .where(owner.key)
          .anyOf(ownerIds)
          .each((row) => account(name, row))
    }
  }
  scope.assertActive()
  return stats
}

async function processCategory(
  scope: SessionPersistenceScope,
  category: StorageCategory,
  preview: boolean,
  ownershipKind: CleanupOwnership["kind"],
  olderThan?: number,
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>,
  seen?: Set<string>,
  refreshRowOwnership?: () => Promise<void>
): Promise<CleanupResult> {
  const result = emptyResult()
  const tables = cleanupTableNames(
    category,
    scope.db.tables.map((table) => table.name),
    allowedPolicies,
    ownershipKind
  )
  for (const tableName of tables) {
    const table = scope.db.tables.find((entry) => entry.name === tableName)
    if (!table) continue
    try {
      scope.assertActive()
      const rows = (await table.toArray()).filter(
        (row) =>
          ownedRow(tableName, row) &&
          (scope.allowsCleanupRow?.(tableName, row) ?? true) &&
          isEligibleForCleanup(row, olderThan)
      )
      scope.assertActive()
      const keyPath = table.schema.primKey.keyPath
      const keyOf = (row: Record<string, unknown>) =>
        Array.isArray(keyPath)
          ? keyPath.map((key) => row[key])
          : typeof keyPath === "string"
            ? row[keyPath]
            : undefined
      const candidates = rows.filter((row) => keyOf(row) != null)
      let accountedRows = candidates
      let cascadeStats: { deletedItems: number; freedSpace: number } | undefined
      if (candidates.length === 0) continue
      if (tableName === "sessions")
        cascadeStats = await sessionCascadeStats(scope, candidates, seen)
      else if (preview)
        accountedRows = candidates.filter((row) => markAccounted(scope, tableName, row, seen))
      if (!preview) {
        if (tableName === "sessions") {
          scope.assertActive()
          await bulkDeleteSessions(
            candidates.map((row) => row.id as string),
            scope
          )
        } else {
          const transactionTables = [
            ...new Set([
              table,
              scope.db.syncTombstones,
              ...(refreshRowOwnership
                ? CLEANUP_OWNERSHIP_TABLES.map((name) => scope.db.table(name))
                : []),
            ]),
          ]
          await scope.db.transaction("rw", transactionTables, async () => {
            scope.assertActive()
            await refreshRowOwnership?.()
            const current = await table.bulkGet(candidates.map(keyOf))
            accountedRows = current.filter(
              (row) =>
                row !== undefined &&
                ownedRow(tableName, row) &&
                (scope.allowsCleanupRow?.(tableName, row) ?? true) &&
                isEligibleForCleanup(row, olderThan)
            )
            scope.assertActive()
            await table.bulkDelete(accountedRows.map(keyOf))
            scope.assertActive()
            for (const protocolTable of companionSyncTablesForSources([tableName])) {
              await recordTombstones(
                protocolTable,
                accountedRows.map((row) => String(keyOf(row)))
              )
            }
            scope.assertActive()
          })
        }
      }
      // Publish accounting only after the whole table transaction resolves.
      result.deletedItems += cascadeStats?.deletedItems ?? accountedRows.length
      result.freedSpace +=
        cascadeStats?.freedSpace ?? accountedRows.reduce((sum, row) => sum + rowSize(row), 0)
    } catch (error) {
      result.errors.push(
        `${category}/${tableName}: ${error instanceof Error ? error.message : String(error)}`
      )
      // A read/delete failure may be recoverable; a different owner never is.
      try {
        scope.assertActive()
      } catch {
        break
      }
    }
  }
  if (result.deletedItems > 0)
    result.details.push({
      category,
      deletedItems: result.deletedItems,
      freedSpace: result.freedSpace,
    })
  return result
}

function cleanupTableNames(
  category: StorageCategory,
  runtimeTableNames: readonly string[],
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>,
  ownershipKind = getCleanupOwnership().kind
): string[] {
  if (!selectableCategories().includes(category)) return []
  // A paired DB is a Host mirror. Never invoke canonical deletion or evict
  // any protocol source, including from preview, Quick, Deep or direct APIs.
  const tableNames = tablesForCategory(category, runtimeTableNames).filter((name) =>
    cleanupSourceIsAllowed(name, ownershipKind)
  )
  if (!allowedPolicies && category !== "other") return tableNames
  const policies = allowedPolicies ?? new Set<DataCleanupPolicy>(["quick", "deep"])
  return tableNames.filter((name) => {
    const policy = policyForTable(name)
    return policy !== undefined && policies.has(policy.cleanupPolicy)
  })
}

export function getCleanupCategoryAvailability(
  category: StorageCategory,
  sources: readonly string[] = tablesForCategory(category)
): StorageCleanupAvailability {
  const hasHostData =
    !canCleanHostSourceTables() &&
    companionSyncTablesForSources(tablesForCategory(category, sources)).length > 0
  if (cleanupTableNames(category, sources).length > 0)
    return hasHostData ? "local-only" : "cleanable"
  return hasHostData ? "host-managed" : "protected"
}

async function runCleanup(
  opts: CleanupOptions,
  preview: boolean,
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>
): Promise<CleanupResult> {
  const categories = [...new Set(opts.categories ?? selectableCategories())]
  const result = emptyResult()
  const seen = preview ? new Set<string>() : undefined
  try {
    const scope = captureScope(opts.targetKey)
    scope.assertActive()
    const ownership = await readCleanupOwnership(scope.db.name)
    scope.assertActive()
    // Revalidate persisted ownership even if a liveQuery notification has not
    // reached React yet (or the confirmation's subscriber has unmounted).
    if (opts.targetKey !== undefined && getCleanupTargetKey(ownership) !== opts.targetKey)
      throw new Error("Storage cleanup target changed")
    let rows: CleanupRowOwnership | undefined
    const refreshRowOwnership =
      ownership.kind === "session-rows"
        ? async () => {
            rows = await readCleanupRowOwnership(scope.db)
            scope.assertActive()
          }
        : undefined
    if (refreshRowOwnership) {
      await refreshRowOwnership()
      scope.allowsCleanupRow = (table, row) => rows!.allows(table, row)
      scope.assertSessionsDeletable = async (ids) => {
        await refreshRowOwnership()
        if (ids.some((id) => !rows!.allows("sessions", { id })))
          throw new Error("Storage cleanup session ownership changed")
      }
    }
    for (const category of categories) {
      scope.assertActive()
      const detail = await processCategory(
        scope,
        category,
        preview,
        ownership.kind,
        opts.olderThan,
        allowedPolicies,
        seen,
        refreshRowOwnership
      )
      result.details.push(...detail.details)
      result.errors.push(...detail.errors)
      result.deletedItems += detail.deletedItems
      result.freedSpace += detail.freedSpace
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error))
  }
  return result
}

export async function previewCleanup(opts: CleanupOptions = {}): Promise<CleanupResult> {
  return runCleanup(opts, true)
}

async function cleanupCategoriesWithPolicies(
  opts: CleanupOptions,
  allowedPolicies?: ReadonlySet<DataCleanupPolicy>
): Promise<CleanupResult> {
  return runCleanup(opts, false, allowedPolicies)
}

export async function cleanupCategories(opts: CleanupOptions = {}): Promise<CleanupResult> {
  return cleanupCategoriesWithPolicies(opts)
}

export async function clearCategory(category: StorageCategory): Promise<number> {
  const result = await cleanupCategories({ categories: [category] })
  if (result.errors.length > 0) throw new Error(result.errors.join("; "))
  return result.deletedItems
}

export async function quickCleanup(): Promise<CleanupResult> {
  // Wipe transient buckets only — never user-authored data.
  return cleanupCategoriesWithPolicies(
    { categories: ["ttsKey", "system", "other"] },
    new Set<DataCleanupPolicy>(["quick"])
  )
}

export async function deepCleanup(): Promise<CleanupResult> {
  // Authoritative rows remain protected; a missing timestamp also fails closed.
  const cutoff = Date.now() - DEEP_CLEANUP_AGE_MS
  return cleanupCategoriesWithPolicies(
    {
      categories: ["chat", "backupHistory", "system", "other"],
      olderThan: cutoff,
    },
    new Set<DataCleanupPolicy>(["quick", "deep"])
  )
}

/** Categories the dialog offers via the "Custom" tab. We hide `settings` and
 *  the seed-driven categories so users can't accidentally wipe their config. */
/**
 * Categories the Custom cleanup tab may offer.
 *
 * `artifact`, `character`, `vector` and `pet` are absent on purpose, and the
 * reason is structural rather than taste: `cleanupTableNames` short-circuits
 * with `if (!allowedPolicies && category !== "other") return tableNames`, so a
 * non-`other` category offered here deletes EVERY table in it regardless of
 * `cleanupPolicy: "protected"`. Offering the pet would put "delete the pet you
 * raised, its badges and its imported models" behind a checkbox labelled
 * "Desktop pet". The pet's own destructive reset lives in Settings, behind a
 * confirmation, where it can say what it does.
 */
export function selectableCategories(): StorageCategory[] {
  return [
    "session",
    "chat",
    "skill",
    "team",
    "mcp",
    "preset",
    "canvas",
    "trustedWorkspace",
    "ttsKey",
    "backupHistory",
    "system",
    "other",
  ]
}

export const __TESTING__ = {
  DEEP_CLEANUP_AGE_MS,
  rowSize,
  retentionTimestamp,
  isEligibleForCleanup,
  cleanupTableNames,
}
