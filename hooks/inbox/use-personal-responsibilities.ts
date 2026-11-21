"use client"

/**
 * Unified personal-responsibility aggregation hook for Inbox `/inbox/needs-me` (F10).
 *
 * Combines the five local responsibility queues into one prioritized feed:
 *  1. `outbound_draft`     — pending `connectorDrafts` awaiting send approval
 *  2. `hitl_approval`      — live & durable HITL asks (`AttentionItem`s)
 *  3. `sla_overdue`        — conversations past `nextResponseDueAt`
 *  4. `blocked_commitment` — stalled inbound jobs (`recovery_required`),
 *                            paused/limited `chatGoals`, and failed `scheduledTasks`
 *  5. `radar_suggestion`   — undecided `pending` Radar suggestions
 */

import { useMemo, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import {
  getAttentionServerSnapshot,
  getAttentionSnapshot,
  subscribeAttention,
} from "@/lib/attention/attention-store"
import type { AttentionItem } from "@/lib/attention/types"
import { isOverdue } from "@/lib/connectors/sla"
import type {
  ConnectorDraftRow,
  ConnectorInboundJobRow,
  ConversationOverrideRow,
} from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import {
  listPendingRadarSuggestions,
  type PendingRadarSuggestionItem,
} from "@/lib/radar/suggestions"
import { usePendingDraftsQuery } from "@/hooks/connectors/use-pending-drafts"
import type { Goal } from "@/types/goal"
import type { ScheduledTask } from "@/types/scheduler"

export type ResponsibilityKind =
  "outbound_draft" | "hitl_approval" | "sla_overdue" | "blocked_commitment" | "radar_suggestion"

export type ResponsibilityPriority = "urgent" | "high" | "normal"

export type PersonalResponsibilityItem =
  | {
      id: string
      kind: "outbound_draft"
      priority: ResponsibilityPriority
      title: string
      subtitle?: string
      createdAt: number
      dueAt?: number
      conversationKey: string
      sessionId: string
      draft: ConnectorDraftRow
    }
  | {
      id: string
      kind: "hitl_approval"
      priority: ResponsibilityPriority
      title: string
      subtitle?: string
      createdAt: number
      dueAt?: number
      attention: AttentionItem
    }
  | {
      id: string
      kind: "sla_overdue"
      priority: ResponsibilityPriority
      title: string
      subtitle?: string
      createdAt: number
      dueAt: number
      overdueMinutes: number
      conversationKey: string
      sessionId: string
      override: ConversationOverrideRow
    }
  | {
      id: string
      kind: "blocked_commitment"
      priority: ResponsibilityPriority
      commitmentKind: "inbound_recovery" | "goal" | "scheduled_task"
      title: string
      subtitle?: string
      createdAt: number
      dueAt?: number
      conversationKey?: string
      sessionId?: string
      taskId?: string
      inboundJob?: ConnectorInboundJobRow
    }
  | {
      id: string
      kind: "radar_suggestion"
      priority: ResponsibilityPriority
      title: string
      subtitle?: string
      createdAt: number
      dueAt?: number
      radar: PendingRadarSuggestionItem
    }

const PRIORITY_RANK: Record<ResponsibilityPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
}

const BLOCKED_GOAL_STATUSES = new Set(["paused", "budget_limited", "turn_limited", "timed_out"])

export function sortPersonalResponsibilities(
  items: readonly PersonalResponsibilityItem[]
): PersonalResponsibilityItem[] {
  return [...items].sort((a, b) => {
    const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (p !== 0) return p
    if (a.dueAt !== undefined && b.dueAt !== undefined && a.dueAt !== b.dueAt) {
      return a.dueAt - b.dueAt
    }
    if (a.dueAt !== undefined && b.dueAt === undefined) return -1
    if (a.dueAt === undefined && b.dueAt !== undefined) return 1
    return b.createdAt - a.createdAt || a.id.localeCompare(b.id)
  })
}

export interface ResponsibilityDbSnapshot {
  sessionTitles: Map<string, string>
  overdueOverrides: ConversationOverrideRow[]
  recoveryJobs: ConnectorInboundJobRow[]
  blockedGoals: Goal[]
  failedTasks: ScheduledTask[]
  radarSuggestions: PendingRadarSuggestionItem[]
  now: number
}

export function buildPersonalResponsibilities(input: {
  drafts: readonly ConnectorDraftRow[]
  attention: readonly AttentionItem[]
  dbSnapshot: ResponsibilityDbSnapshot
}): PersonalResponsibilityItem[] {
  const { drafts, attention, dbSnapshot } = input
  const { now, sessionTitles } = dbSnapshot
  const items: PersonalResponsibilityItem[] = []

  for (const item of attention) {
    if (item.stale) continue
    items.push({
      id: `hitl:${item.id}`,
      kind: "hitl_approval",
      priority: "urgent",
      title: item.title,
      subtitle: item.detail,
      createdAt: item.openedAt,
      ...(item.interrupt?.expiresAt ? { dueAt: item.interrupt.expiresAt } : {}),
      attention: item,
    })
  }

  for (const row of dbSnapshot.overdueOverrides) {
    if (!isOverdue(row, now) || !row.nextResponseDueAt) continue
    const overdueMinutes = Math.max(1, Math.round((now - row.nextResponseDueAt) / 60_000))
    items.push({
      id: `sla:${row.conversationKey}`,
      kind: "sla_overdue",
      priority: "urgent",
      title: sessionTitles.get(row.conversationKey) ?? row.conversationKey,
      createdAt: row.updatedAt ?? row.createdAt,
      dueAt: row.nextResponseDueAt,
      overdueMinutes,
      conversationKey: row.conversationKey,
      sessionId: row.sessionId,
      override: row,
    })
  }

  for (const draft of drafts) {
    if (draft.expiresAt !== undefined && draft.expiresAt <= now) continue
    items.push({
      id: `draft:${draft.id}`,
      kind: "outbound_draft",
      priority: "high",
      title: sessionTitles.get(draft.conversationKey) ?? draft.conversationKey,
      createdAt: draft.createdAt,
      ...(draft.expiresAt ? { dueAt: draft.expiresAt } : {}),
      conversationKey: draft.conversationKey,
      sessionId: draft.sessionId,
      draft,
    })
  }

  for (const job of dbSnapshot.recoveryJobs) {
    items.push({
      id: `recovery:${job.id}`,
      kind: "blocked_commitment",
      priority: "high",
      commitmentKind: "inbound_recovery",
      title: sessionTitles.get(job.conversationKey) ?? job.conversationKey,
      subtitle: job.recoveryReason,
      createdAt: job.updatedAt ?? job.createdAt,
      conversationKey: job.conversationKey,
      inboundJob: job,
    })
  }

  for (const goal of dbSnapshot.blockedGoals) {
    if (!BLOCKED_GOAL_STATUSES.has(goal.status)) continue
    items.push({
      id: `goal:${goal.id}`,
      kind: "blocked_commitment",
      priority: "high",
      commitmentKind: "goal",
      title: (goal.safeObjective ?? goal.objective ?? goal.id).trim().slice(0, 140),
      subtitle: goal.status,
      createdAt: goal.updatedAt ?? goal.createdAt,
      sessionId: goal.sessionId,
    })
  }

  for (const task of dbSnapshot.failedTasks) {
    const updatedAt =
      task.updatedAt instanceof Date ? task.updatedAt.getTime() : Number(task.updatedAt ?? now)
    items.push({
      id: `task:${task.id}`,
      kind: "blocked_commitment",
      priority: "high",
      commitmentKind: "scheduled_task",
      title: task.name,
      subtitle: task.lastError ?? task.status,
      createdAt: updatedAt,
      taskId: task.id,
    })
  }

  for (const suggestion of dbSnapshot.radarSuggestions) {
    items.push({
      id: `radar:${suggestion.suggestionId}`,
      kind: "radar_suggestion",
      priority: "normal",
      title: suggestion.text,
      subtitle: suggestion.verdict || undefined,
      createdAt: suggestion.generatedAt,
      radar: suggestion,
    })
  }

  return sortPersonalResponsibilities(items)
}

async function queryResponsibilityDbSnapshot(): Promise<ResponsibilityDbSnapshot> {
  const now = Date.now()
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return {
      sessionTitles: new Map(),
      overdueOverrides: [],
      recoveryJobs: [],
      blockedGoals: [],
      failedTasks: [],
      radarSuggestions: [],
      now,
    }
  }
  try {
    const db = getDb()
    const [sessions, overrides, recoveryJobs, goals, tasks, radarSuggestions] = await Promise.all([
      db.sessions.filter((s) => s.platformBinding != null).toArray(),
      db.conversationOverrides.toArray(),
      db.connectorInboundJobs.filter((job) => job.status === "recovery_required").toArray(),
      db.chatGoals.toArray(),
      db.scheduledTasks.toArray(),
      listPendingRadarSuggestions(),
    ])
    const sessionTitles = new Map<string, string>()
    for (const s of sessions) {
      const ck = s.platformBinding?.conversationKey
      if (ck) sessionTitles.set(ck, s.title || ck)
    }
    return {
      sessionTitles,
      overdueOverrides: overrides.filter((row) => isOverdue(row, now)),
      recoveryJobs,
      blockedGoals: goals.filter((goal) => BLOCKED_GOAL_STATUSES.has(goal.status)),
      failedTasks: tasks.filter(
        (task) =>
          task.status === "error" || (task.failureCount > 0 && task.lastRunStatus === "failed")
      ),
      radarSuggestions,
      now,
    }
  } catch {
    return {
      sessionTitles: new Map(),
      overdueOverrides: [],
      recoveryJobs: [],
      blockedGoals: [],
      failedTasks: [],
      radarSuggestions: [],
      now,
    }
  }
}

export function usePersonalResponsibilities(): {
  loading: boolean
  items: PersonalResponsibilityItem[]
  countsByKind: Record<ResponsibilityKind, number>
} {
  const draftsQuery = usePendingDraftsQuery()
  const attention = useSyncExternalStore(
    subscribeAttention,
    getAttentionSnapshot,
    getAttentionServerSnapshot
  )
  const dbSnapshot = useLiveQuery(queryResponsibilityDbSnapshot, ["personal-responsibilities-db"])

  return useMemo(() => {
    const validSnapshot =
      dbSnapshot && typeof dbSnapshot === "object" && "overdueOverrides" in dbSnapshot
        ? dbSnapshot
        : undefined
    const loading = draftsQuery === undefined || validSnapshot === undefined
    const items = buildPersonalResponsibilities({
      drafts: draftsQuery ?? [],
      attention,
      dbSnapshot: validSnapshot ?? {
        sessionTitles: new Map(),
        overdueOverrides: [],
        recoveryJobs: [],
        blockedGoals: [],
        failedTasks: [],
        radarSuggestions: [],
        now: 0,
      },
    })
    const countsByKind: Record<ResponsibilityKind, number> = {
      outbound_draft: 0,
      hitl_approval: 0,
      sla_overdue: 0,
      blocked_commitment: 0,
      radar_suggestion: 0,
    }
    for (const item of items) {
      countsByKind[item.kind] += 1
    }
    return { loading, items, countsByKind }
  }, [attention, dbSnapshot, draftsQuery])
}

export function usePersonalResponsibilityCount(): number {
  const { items } = usePersonalResponsibilities()
  return items.length
}
