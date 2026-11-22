/**
 * Gather + PII-gate + pre-filter the items the Attention Radar analyzes.
 *
 * Primary source: the autonomous long-term memory store (`lib/db/memories.ts`)
 * — already deduped, importance-weighted, and PII-redacted at write time, so it
 * is the cleanest "what the user has been engaging with" signal. Phase 4's
 * captured items fold in through `opts.extra`.
 *
 * We intentionally do NOT scrape raw chat messages / clipboard buffer / OCR
 * cache here: those are high-noise and (clipboard/OCR) not a chronological
 * consumption log — memories already distill them. Every item still passes
 * through `hasNoLeakingPii` as a belt-and-suspenders gate before it can reach
 * the model.
 */

import { listMemories } from "@/lib/db/memories"
import { listCapturedItemsSince } from "@/lib/db/captured-items"
import { getDb } from "@/lib/db/schema"
import {
  applyStableKeyPrecedence,
  isMemoryEligibleForRetrieval,
} from "@cognia/memory/retrieve/retriever"
import { hasNoLeakingPii } from "@cognia/redact"
import { smartPreFilter } from "./prefilter"
import type { RadarDataItem } from "@/types/radar"

const DAY_MS = 86_400_000
const BLOCKED_GOAL_STATUSES = new Set(["paused", "budget_limited", "turn_limited", "timed_out"])

export interface CollectRadarOptions {
  /** Activity window in days. Default 14. */
  windowDays?: number
  /** Cap on items sent to the analyzer. Default 60. */
  maxItems?: number
  /** Injected clock for deterministic tests. */
  now?: number
  /** Extra pre-normalized items (e.g. Phase 4 captured items). */
  extra?: RadarDataItem[]
  /** Include local high-value obligations (pending drafts, overdue SLAs, blocked goals, failed tasks). Default true. */
  includeObligations?: boolean
  /** Optional seam for obligation loading in unit tests. */
  loadObligations?: (cutoff: number, now: number) => Promise<RadarDataItem[]>
  /** Optional cancellation signal checked across async reads. */
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const err = new Error(
    typeof signal.reason === "string" && signal.reason ? signal.reason : "Radar collection aborted"
  )
  err.name = "AbortError"
  throw err
}

function summarizeDraftSegments(segments: unknown): string {
  if (!Array.isArray(segments)) return ""
  return segments
    .flatMap((seg) => {
      if (!seg || typeof seg !== "object") return []
      const text = (seg as { text?: unknown }).text
      return typeof text === "string" && text.trim() ? [text.trim()] : []
    })
    .join(" ")
    .slice(0, 200)
}

function parseTaskUpdatedMs(updatedAt: Date | string | number | undefined): number {
  if (updatedAt instanceof Date) return updatedAt.getTime()
  if (typeof updatedAt === "number") return Number.isFinite(updatedAt) ? updatedAt : 0
  if (typeof updatedAt === "string") {
    const asNum = Number(updatedAt)
    if (Number.isFinite(asNum)) return asNum
    const parsed = Date.parse(updatedAt)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

export async function collectLocalObligations(
  cutoff: number,
  now: number,
  signal?: AbortSignal
): Promise<RadarDataItem[]> {
  if (typeof indexedDB === "undefined") return []
  let db: ReturnType<typeof getDb>
  try {
    db = getDb()
  } catch {
    return []
  }
  const items: RadarDataItem[] = []
  try {
    const [pendingDrafts, overrides, goals, tasks] = await Promise.all([
      db.connectorDrafts.where("status").equals("pending").toArray(),
      db.conversationOverrides.toArray(),
      db.chatGoals.toArray(),
      db.scheduledTasks.toArray(),
    ])
    throwIfAborted(signal)

    for (const draft of pendingDrafts) {
      if (draft.expiresAt !== undefined && draft.expiresAt <= now) continue
      const at = draft.updatedAt ?? draft.createdAt
      if (at < cutoff) continue
      const preview = summarizeDraftSegments(draft.segments)
      items.push({
        id: `draft:${draft.id}`,
        text: preview
          ? `Pending outbound draft awaiting approval: ${preview}`
          : "Pending outbound draft awaiting approval",
        source: "obligation",
        at,
        importance: 8,
        kind: "pending-draft",
      })
    }

    for (const row of overrides) {
      if (
        !row.nextResponseDueAt ||
        row.status === "resolved" ||
        row.nextResponseDueAt >= now ||
        row.nextResponseDueAt < cutoff
      ) {
        continue
      }
      const overdueMin = Math.max(1, Math.round((now - row.nextResponseDueAt) / 60_000))
      items.push({
        id: `sla:${row.id}`,
        text: `Conversation response SLA overdue by ${overdueMin} minutes`,
        source: "obligation",
        at: row.nextResponseDueAt,
        importance: 9,
        kind: "overdue-sla",
      })
    }

    for (const goal of goals) {
      if (!BLOCKED_GOAL_STATUSES.has(goal.status)) continue
      const at = goal.updatedAt ?? goal.createdAt
      if (at < cutoff) continue
      const summary = (goal.safeObjective ?? goal.rawObjective ?? "").trim().slice(0, 200)
      if (!summary) continue
      items.push({
        id: `goal:${goal.id}`,
        text: `Goal requires attention (${goal.status}): ${summary}`,
        source: "obligation",
        at,
        importance: 8,
        kind: `goal-${goal.status}`,
      })
    }

    for (const task of tasks) {
      const updatedMs = parseTaskUpdatedMs(task.updatedAt)
      const failedRecently =
        task.status === "error" ||
        (task.consecutiveFailures ?? 0) > 0 ||
        (task.failureCount > 0 && Boolean(task.lastError))
      if (!failedRecently || updatedMs < cutoff) continue
      items.push({
        id: `task:${task.id}`,
        text: `Scheduled task failed (${task.name}): ${task.lastError ?? "requires review"}`.slice(
          0,
          240
        ),
        source: "obligation",
        at: updatedMs || now,
        importance: 8,
        kind: "failed-task",
      })
    }
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "AbortError") throw err
    return []
  }
  return items
}

/** Resolve current text for a persisted `obligation` Radar source reference, or null when cleared. */
export async function describeRadarObligationSource(id: string): Promise<string | null> {
  if (typeof indexedDB === "undefined") return null
  try {
    const db = getDb()
    if (id.startsWith("draft:")) {
      const draft = await db.connectorDrafts.get(id.slice("draft:".length))
      if (!draft || draft.status !== "pending") return null
      const preview = summarizeDraftSegments(draft.segments)
      return preview
        ? `Pending outbound draft awaiting approval: ${preview}`
        : "Pending outbound draft awaiting approval"
    }
    if (id.startsWith("sla:")) {
      const row = await db.conversationOverrides.get(id.slice("sla:".length))
      if (!row?.nextResponseDueAt || row.status === "resolved") return null
      return "Conversation response SLA requires attention"
    }
    if (id.startsWith("goal:")) {
      const goal = await db.chatGoals.get(id.slice("goal:".length))
      if (!goal || !BLOCKED_GOAL_STATUSES.has(goal.status)) return null
      return `Goal (${goal.status}): ${(goal.safeObjective ?? goal.rawObjective ?? "").slice(0, 240)}`
    }
    if (id.startsWith("task:")) {
      const task = await db.scheduledTasks.get(id.slice("task:".length))
      if (!task) return null
      return `Scheduled task (${task.status}): ${task.name}`
    }
    return null
  } catch {
    return null
  }
}

export async function collectRadarItems(opts: CollectRadarOptions = {}): Promise<RadarDataItem[]> {
  throwIfAborted(opts.signal)
  const windowDays = opts.windowDays ?? 14
  const maxItems = opts.maxItems ?? 60
  const now = opts.now ?? Date.now()
  const cutoff = now - windowDays * DAY_MS

  const memories = await listMemories({ status: "active" })
  throwIfAborted(opts.signal)
  // Align Radar memory intake with standard recall governance (B2): exclude
  // expired, quarantined, conflict, and unverified procedural rows, then apply
  // stable-key precedence before slicing by the time window.
  const governedMemories = applyStableKeyPrecedence(
    memories.filter((m) => isMemoryEligibleForRetrieval(m, now))
  )
  const memItems: RadarDataItem[] = governedMemories
    .filter((m) => m.updatedAt >= cutoff)
    .map((m) => ({
      id: m.id,
      text: m.text,
      source: "memory" as const,
      at: m.updatedAt,
      importance: m.importance,
      kind: m.type,
    }))

  // Captured items (Phase 4) — the enrichment markdown/title carries the most
  // signal; fall back to the raw text/URL.
  const captures = await listCapturedItemsSince(cutoff)
  throwIfAborted(opts.signal)
  const capItems: RadarDataItem[] = captures.map((c) => ({
    id: c.id,
    text: c.enrichment?.markdown || c.text || c.sourceUrl || "",
    source: "capture" as const,
    at: c.capturedAt,
    kind: c.kind,
  }))

  const obligationItems =
    opts.includeObligations === false
      ? []
      : await (opts.loadObligations
          ? opts.loadObligations(cutoff, now)
          : collectLocalObligations(cutoff, now, opts.signal))
  throwIfAborted(opts.signal)

  const extra = (opts.extra ?? []).filter((i) => i.at >= cutoff)

  // Belt-and-suspenders PII gate before anything reaches the model.
  const safe = [...memItems, ...capItems, ...obligationItems, ...extra].filter(
    (i) => i.text.trim().length > 0 && hasNoLeakingPii(i.text)
  )

  return smartPreFilter(safe, maxItems)
}

/**
 * Local capture-activity heatmap — a per-day count over the window. Computed
 * here (not by the LLM) so it is always accurate.
 */
export function computeHeatmap(
  items: readonly RadarDataItem[],
  windowDays: number,
  now: number
): { day: string; count: number }[] {
  const cells = new Map<string, number>()
  for (let d = windowDays - 1; d >= 0; d--) {
    const day = new Date(now - d * DAY_MS).toISOString().slice(0, 10)
    cells.set(day, 0)
  }
  for (const item of items) {
    const day = new Date(item.at).toISOString().slice(0, 10)
    if (cells.has(day)) cells.set(day, (cells.get(day) ?? 0) + 1)
  }
  return Array.from(cells, ([day, count]) => ({ day, count }))
}
