/** Radar-specific decision lifecycle; execution stays in the existing scheduler. */
import { captureDatabaseScope, getDb, type DatabaseScopeSnapshot } from "@/lib/db/schema"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { DEFAULT_EXECUTION_CONFIG, type ScheduledTask } from "@/types/scheduler"
import type { RadarReport, RadarSuggestion } from "@/types/radar"

export function radarSuggestions(report: RadarReport): RadarSuggestion[] {
  return (
    report.suggestions ??
    report.actions.map((_, actionIndex) => ({
      id: `${report.id}:action:${actionIndex}`,
      actionIndex,
      status: "pending",
    }))
  )
}

export interface PendingRadarSuggestionItem {
  reportId: string
  generatedAt: number
  suggestionId: string
  actionIndex: number
  text: string
  verdict: string
}

/**
 * List undecided (`pending`) Radar action suggestions across recent reports,
 * newest report first, for unified personal-responsibility surfaces (F10).
 */
export async function listPendingRadarSuggestions(
  limit = 25
): Promise<PendingRadarSuggestionItem[]> {
  if (typeof indexedDB === "undefined") return []
  try {
    const reports = await getDb().radarReports.orderBy("generatedAt").reverse().limit(10).toArray()
    const out: PendingRadarSuggestionItem[] = []
    for (const report of reports) {
      for (const suggestion of radarSuggestions(report)) {
        if (suggestion.status !== "pending") continue
        const text = report.actions[suggestion.actionIndex]?.trim()
        if (!text) continue
        out.push({
          reportId: report.id,
          generatedAt: report.generatedAt,
          suggestionId: suggestion.id,
          actionIndex: suggestion.actionIndex,
          text,
          verdict: report.verdict,
        })
        if (out.length >= limit) return out
      }
    }
    return out
  } catch {
    return []
  }
}

export async function decideRadarSuggestion(
  reportId: string,
  suggestionId: string,
  decision: "accepted" | "dismissed"
): Promise<RadarSuggestion> {
  const scope = captureDatabaseScope()
  const pinnedSchedulerDb =
    typeof schedulerDb.pinned === "function" ? schedulerDb.pinned(scope.databaseName) : schedulerDb

  if (decision === "accepted") {
    const { assertTaskTypeSupportedOnHost } = await import("@/lib/scheduler/host-support")
    scope.assertActive()
    const unsupported = assertTaskTypeSupportedOnHost("goal")
    if (unsupported) throw new Error(unsupported.error)
  }
  scope.assertActive()
  const db = getDb()
  scope.assertActive()
  const result = await db.transaction("rw", db.radarReports, db.scheduledTasks, async () => {
    scope.assertActive()
    const report = await db.radarReports.get(reportId)
    if (!report) throw new Error("Radar report no longer exists")
    const suggestions = radarSuggestions(report)
    const suggestion = suggestions.find((row) => row.id === suggestionId)
    if (!suggestion) throw new Error("Radar suggestion no longer exists")
    if (suggestion.status !== "pending") {
      if (suggestion.status !== decision) throw new Error("Radar suggestion already decided")
      return suggestion
    }
    const now = new Date()
    if (decision === "accepted") {
      const text = report.actions[suggestion.actionIndex]?.trim()
      if (!text) throw new Error("Radar suggestion has no instruction")
      const taskId = `radar-action:${suggestion.id}`
      const sources = (report.actionEvidence?.[suggestion.actionIndex] ?? []).flatMap((index) =>
        report.sources?.[index] ? [report.sources[index]] : []
      )
      const task: ScheduledTask = {
        id: taskId,
        name: text.slice(0, 120),
        description: `Radar ${reportId}`,
        type: "goal",
        status: "active",
        trigger: { type: "once", runAt: now },
        payload: {
          objective: `${text}\n\nAccepted Radar suggestion: ${suggestion.id}\nSource references (verify current content before relying on it): ${JSON.stringify(sources)}\nReport the final result, evidence, and any remaining blockers.`,
          sessionTitle: text.slice(0, 120),
          config: { requireAcceptance: true },
        },
        config: {
          ...DEFAULT_EXECUTION_CONFIG,
          allowConcurrent: false,
          runMissedOnStartup: true,
          maxMissedRuns: 1,
          maxRuns: 1,
          maxRetries: 0,
        },
        notification: { onStart: false, onComplete: true, onError: true },
        createdBy: { kind: "user" },
        tags: ["radar", reportId],
        runCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
        nextRunAt: now,
      }
      await pinnedSchedulerDb.createTask(task)
      suggestion.taskId = taskId
    }
    suggestion.status = decision
    suggestion.decidedAt = now.getTime()
    await db.radarReports.update(reportId, { suggestions })
    return suggestion
  })
  if (result.taskId && scope.isActive()) {
    try {
      const { getTaskScheduler } = await import("@/lib/scheduler/task-scheduler")
      if (!scope.isActive()) return result
      // Arming is after commit; startup also discovers the persisted one-shot.
      // Replays never reset runCount or create another execution slot.
      const task = await getTaskScheduler().updateTask(result.taskId, {})
      if (!task) throw new Error("Radar task no longer exists")
      if (scope.isActive()) {
        await setDispatchError(reportId, suggestionId, undefined, scope)
      }
    } catch (error) {
      if (scope.isActive()) {
        await setDispatchError(reportId, suggestionId, String(error), scope)
      }
      throw error
    }
  }
  return result
}

async function setDispatchError(
  reportId: string,
  suggestionId: string,
  error: string | undefined,
  scope: DatabaseScopeSnapshot
): Promise<void> {
  if (!scope.isActive()) return
  const db = getDb()
  if (!scope.isActive()) return
  await db.transaction("rw", db.radarReports, async () => {
    scope.assertActive()
    const report = await db.radarReports.get(reportId)
    if (!report?.suggestions) return
    const suggestions = report.suggestions.map((row) =>
      row.id === suggestionId ? { ...row, dispatchError: error } : row
    )
    await db.radarReports.update(reportId, { suggestions })
  })
}
