/**
 * CRUD layer for the `codeAdoptionTurns` Dexie table (v108). Written by the
 * turn tracker after each settled turn; read by `metrics.ts` and the existing
 * Task Resources panel. Local-only — this table is intentionally absent from
 * `lib/sync`, so rows never leave the device.
 */

import { getDb } from "@/lib/db/schema"
import type { TaskWorkspaceOrigin } from "@/lib/task-workspace/types"

import type { CodeAdoptionTurnRow } from "./types"

export interface CodeAdoptionDatabaseScope {
  readonly databaseName: string
}

export class CodeAdoptionDatabaseScopeChangedError extends Error {
  constructor() {
    super("Code adoption database scope changed")
    this.name = "CodeAdoptionDatabaseScopeChangedError"
  }
}

/** Capture before asynchronous Host or database work, never at its completion. */
export function captureCodeAdoptionDatabaseScope(): CodeAdoptionDatabaseScope {
  return { databaseName: getDb().name }
}

export function isCodeAdoptionDatabaseScopeCurrent(scope: CodeAdoptionDatabaseScope): boolean {
  return getDb().name === scope.databaseName
}

export function assertCodeAdoptionDatabaseScope(scope: CodeAdoptionDatabaseScope): void {
  if (!isCodeAdoptionDatabaseScopeCurrent(scope)) throw new CodeAdoptionDatabaseScopeChangedError()
}

export async function persistCodeAdoptionTurn(
  row: CodeAdoptionTurnRow,
  scope = captureCodeAdoptionDatabaseScope()
): Promise<void> {
  assertCodeAdoptionDatabaseScope(scope)
  await getDb().codeAdoptionTurns.put(row)
  assertCodeAdoptionDatabaseScope(scope)
}

export async function getCodeAdoptionTurn(
  id: string,
  scope = captureCodeAdoptionDatabaseScope()
): Promise<CodeAdoptionTurnRow | undefined> {
  assertCodeAdoptionDatabaseScope(scope)
  const row = await getDb().codeAdoptionTurns.get(id)
  assertCodeAdoptionDatabaseScope(scope)
  return row
}

/** Resolve the adoption row correlated with a durable Task Workspace run. */
export async function getCodeAdoptionTurnByTaskWorkspaceRun(
  taskWorkspaceRunId: string,
  origin?: TaskWorkspaceOrigin,
  scope = captureCodeAdoptionDatabaseScope()
): Promise<CodeAdoptionTurnRow | undefined> {
  const matchesOrigin = (candidate?: TaskWorkspaceOrigin) =>
    !origin ||
    (candidate?.kind === origin.kind &&
      (origin.kind === "local" ||
        (candidate.kind === "remote" &&
          candidate.hostId === origin.hostId &&
          candidate.accountId === origin.accountId)))
  const matchesRun = (row: CodeAdoptionTurnRow) =>
    (row.taskWorkspaceRunId === taskWorkspaceRunId && matchesOrigin(row.origin)) ||
    row.taskWorkspaceRuns?.some(
      (run) => run.runId === taskWorkspaceRunId && matchesOrigin(run.origin)
    ) === true
  const derivedId = taskWorkspaceRunId.startsWith("run:")
    ? taskWorkspaceRunId.slice("run:".length)
    : undefined
  if (derivedId) {
    const direct = await getCodeAdoptionTurn(derivedId, scope)
    if (direct && matchesRun(direct)) return direct
  }
  assertCodeAdoptionDatabaseScope(scope)
  const row = await getDb().codeAdoptionTurns.filter(matchesRun).first()
  assertCodeAdoptionDatabaseScope(scope)
  return row
}

/** All turns for a session, oldest-first. */
export async function listCodeAdoptionTurnsBySession(
  sessionId: string,
  scope = captureCodeAdoptionDatabaseScope()
): Promise<CodeAdoptionTurnRow[]> {
  assertCodeAdoptionDatabaseScope(scope)
  const rows = await getDb().codeAdoptionTurns.where("sessionId").equals(sessionId).sortBy("ts")
  assertCodeAdoptionDatabaseScope(scope)
  return rows
}

/**
 * The turn record whose closing message is `messageId` (the row the turn
 * tracker stamps `assistantMessageId` on), or `undefined`. When a message was
 * stamped twice (a regenerate re-settling the same row) the newest wins.
 */
export async function getCodeAdoptionTurnForMessage(
  sessionId: string,
  messageId: string,
  scope = captureCodeAdoptionDatabaseScope()
): Promise<CodeAdoptionTurnRow | undefined> {
  assertCodeAdoptionDatabaseScope(scope)
  const rows = await getDb()
    .codeAdoptionTurns.where("sessionId")
    .equals(sessionId)
    .filter((row) => row.assistantMessageId === messageId)
    .sortBy("ts")
  assertCodeAdoptionDatabaseScope(scope)
  return rows.at(-1)
}

/** Newest-first list across all sessions, capped. */
export async function listRecentCodeAdoptionTurns(
  limit = 50,
  scope = captureCodeAdoptionDatabaseScope()
): Promise<CodeAdoptionTurnRow[]> {
  assertCodeAdoptionDatabaseScope(scope)
  const rows = await getDb().codeAdoptionTurns.orderBy("ts").reverse().limit(limit).toArray()
  assertCodeAdoptionDatabaseScope(scope)
  return rows
}

/** Oldest-first rows in an explicit time window. */
export async function listCodeAdoptionTurnsInRange(
  from: number,
  to: number,
  scope = captureCodeAdoptionDatabaseScope()
): Promise<CodeAdoptionTurnRow[]> {
  assertCodeAdoptionDatabaseScope(scope)
  const rows = await getDb()
    .codeAdoptionTurns.where("ts")
    .between(from, to, true, true)
    .sortBy("ts")
  assertCodeAdoptionDatabaseScope(scope)
  return rows
}

/** Trim to the newest `keep` metric-only rows (call after each write to bound growth). */
export async function pruneCodeAdoptionTurns(
  keep = 10_000,
  scope = captureCodeAdoptionDatabaseScope()
): Promise<number> {
  assertCodeAdoptionDatabaseScope(scope)
  const db = getDb()
  const ids = await db.codeAdoptionTurns.orderBy("ts").reverse().offset(keep).primaryKeys()
  assertCodeAdoptionDatabaseScope(scope)
  if (ids.length === 0) return 0
  await db.codeAdoptionTurns.bulkDelete(ids as string[])
  return ids.length
}
