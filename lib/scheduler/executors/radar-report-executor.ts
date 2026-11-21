// Cron-driven Attention Radar executor.
//
// Pairs with the settings card in `components/settings/radar/radar-card.tsx`:
// the card creates one `radar-report` task; this executor runs
// `runRadarReport()` on each fire (respecting the interval guard unless the
// report is due) and surfaces the outcome. Not Tauri-gated — it reads Dexie +
// a renderer-side LLM client, both of which exist in web mode too.

import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { explicitHostPersonalSinkContext } from "@/lib/execution/personal-sink"
import { notify as centerNotify } from "@/lib/notifications/runtime"
import { runRadarReport, NoRadarModelError } from "@/lib/radar/radar-runner"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

interface ExecutorResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export async function executeRadarReportTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<ExecutorResult> {
  if (signal.aborted) {
    return { success: false, error: "Radar report cancelled" }
  }
  try {
    const report = await runRadarReport({ signal })
    if (!report) {
      log.info("Scheduler radar-report skipped (guard)", {
        taskId: task.id,
        executionId: execution.id,
      })
      return { success: true, output: { skipped: true } }
    }
    log.info("Scheduler radar-report complete", {
      taskId: task.id,
      executionId: execution.id,
      itemCount: report.itemCount,
    })
    // Actionable-only notification (F6): surface a notification when scheduled
    // Radar generation discovers concrete suggestions, while keeping empty or
    // skipped runs silent (`notification.onComplete` stays false).
    const actionCount = Array.isArray(report.actions) ? report.actions.length : 0
    if (actionCount > 0) {
      try {
        await centerNotify(
          {
            source: "scheduler",
            level: "info",
            title: `Attention Radar: ${actionCount} new suggestion${actionCount === 1 ? "" : "s"}`,
            body:
              report.verdict?.trim() || report.actions[0] || "New suggestions ready for review.",
            dedupeKey: `radar-report:actionable:${report.id}`,
            groupKey: `task:${task.id}`,
            sourceRef: { kind: "task", id: task.id },
          },
          { personalContext: explicitHostPersonalSinkContext("fixed-notice") }
        )
      } catch (notifyErr) {
        log.error("Failed to dispatch actionable radar notification", {
          taskId: task.id,
          reportId: report.id,
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        })
      }
    }
    return { success: true, output: { itemCount: report.itemCount, reportId: report.id } }
  } catch (err) {
    const error =
      err instanceof NoRadarModelError
        ? "No LLM API key configured — add one in Settings → Providers."
        : err instanceof Error
          ? err.message
          : String(err)
    log.error("Scheduler radar-report failed", { taskId: task.id, error })
    return { success: false, error }
  }
}
