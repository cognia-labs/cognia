// Persisted row ownership is separate from target selection: the desktop's
// base DB keeps Host mirrors after disconnect. Preview and deletion share this
// policy, including the guard used by the canonical session cascade.
import type { CogniaDB } from "@/lib/db/schema"
import { surfaceBindingKey } from "@/lib/context-workbench/resource-session"
import { companionSyncTablesForSources } from "@/lib/data-governance/table-catalog"
import type { CleanupOwnership } from "./cleanup-target"

export const CLEANUP_OWNERSHIP_TABLES = [
  "sessions",
  "messages",
  "hostStateChannels",
  "chatGoals",
  "agentPlans",
  "loops",
  "executionRuns",
] as const

const SESSION_OWNED_SYNC_SOURCES = new Set([
  "sessions",
  "messages",
  "sessionState",
  "sessionUsage",
  "chatGoals",
  "agentPlans",
  "executionRuns",
  "executionRunBindings",
])

export function cleanupSourceIsAllowed(name: string, kind: CleanupOwnership["kind"]): boolean {
  if (kind === "local") return true
  if (companionSyncTablesForSources([name]).length === 0) return true
  // Other sync sources have no persisted per-row Host provenance. Protect the
  // entire table on native mixed targets instead of guessing from connectivity.
  return kind === "session-rows" && SESSION_OWNED_SYNC_SOURCES.has(name)
}

export interface CleanupRowOwnership {
  allows(table: string, row: unknown): boolean
}

export async function readCleanupRowOwnership(db: CogniaDB): Promise<CleanupRowOwnership> {
  const sessions = await db.sessions.toArray()
  const channels = await db.hostStateChannels.toArray()
  const protectedSessions = new Set(
    sessions
      .filter((row) => row.programmaticCreator === "host-state" || row.deliverySourceHosts?.length)
      .map((row) => row.id)
  )
  // materializeOptimisticMessages also persists metadata.hostState. Retain
  // that provenance if its channel or session creator is no longer present.
  await db.messages.each((row) => {
    if (row.metadata?.hostState) protectedSessions.add(row.sessionId)
  })
  // persistConfirmedState marks newly created sessions, but retains an existing
  // row's creator. Its persisted channel binding covers those updates as well.
  for (const { state } of channels) {
    if (state.kind === "session") protectedSessions.add(state.sessionId)
    else for (const summary of state.sessions) protectedSessions.add(summary.sessionId)
  }
  const bindingOwners = new Map(
    [...new Set([...sessions.map((row) => row.id), ...protectedSessions])].map((id) => [
      surfaceBindingKey({ kind: "session", sessionId: id }),
      id,
    ])
  )
  // Protect attached descendants and bound side chats, and any ancestor whose
  // deletion would delete or reparent a protected row. Ordinary local branches
  // under a mirror are independent and remain cleanable.
  let expanded: boolean
  do {
    expanded = false
    const protect = (id: string | undefined) => {
      if (id && !protectedSessions.has(id)) {
        protectedSessions.add(id)
        expanded = true
      }
    }
    for (const row of sessions) {
      const sideChatOwner = bindingOwners.get(row.surfaceBindingKey ?? "")
      const attachedOwner =
        row.parentSessionId &&
        row.attachedChild?.parentSessionId === row.parentSessionId &&
        row.attachedChild.lifecycleOwnerSessionId === row.parentSessionId
          ? row.parentSessionId
          : undefined
      if (
        (attachedOwner && protectedSessions.has(attachedOwner)) ||
        (sideChatOwner && protectedSessions.has(sideChatOwner))
      )
        protect(row.id)
      if (protectedSessions.has(row.id)) {
        protect(row.parentSessionId)
        protect(sideChatOwner)
      }
    }
  } while (expanded)
  const localSessions = new Set(
    sessions.filter((row) => !protectedSessions.has(row.id)).map((row) => row.id)
  )
  // Read sequentially: encrypted cursors in a shared transaction must not hold
  // each other open while awaiting decryption.
  const goals = await db.chatGoals.toArray()
  const plans = await db.agentPlans.toArray()
  const loops = await db.loops.toArray()
  const runs = await db.executionRuns.toArray()
  const protectedGoals = new Set(
    goals.filter((row) => protectedSessions.has(row.sessionId)).map((row) => row.id)
  )
  const protectedPlans = new Set(
    plans.filter((row) => protectedSessions.has(row.sessionId)).map((row) => row.id)
  )
  const protectedLoops = new Set(
    loops.filter((row) => protectedSessions.has(row.sessionId)).map((row) => row.id)
  )
  const protectedRuns = new Set(
    runs.filter((row) => protectedSessions.has(row.sessionId ?? "")).map((row) => row.id)
  )
  const localRuns = new Set(
    runs.filter((row) => localSessions.has(row.sessionId ?? "")).map((row) => row.id)
  )
  return {
    allows(table, value) {
      if (!value || typeof value !== "object") return false
      const row = value as Record<string, unknown>
      const id = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : "")
      if (table === "sessions") return !protectedSessions.has(id("id"))
      if (
        protectedSessions.has(id("sessionId")) ||
        protectedSessions.has(id("senderSessionId")) ||
        protectedSessions.has(id("receiverSessionId")) ||
        protectedGoals.has(id("goalId")) ||
        protectedPlans.has(id("planId")) ||
        protectedLoops.has(id("loopId")) ||
        protectedRuns.has(id("runId"))
      )
        return false
      if (table === "messages" && (row.metadata as { hostState?: unknown } | undefined)?.hostState)
        return false
      if (!SESSION_OWNED_SYNC_SOURCES.has(table)) return true
      if (table === "executionRunBindings") return localRuns.has(id("runId"))
      // A session link without its owning session cannot establish local
      // provenance (for example, a stale mirrored message after disconnect).
      return localSessions.has(id("sessionId"))
    },
  }
}
