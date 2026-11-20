/**
 * What one Squad run reported, read from that run's own record.
 *
 * A Squad keeps one `finalResult` on its team record across every run, and
 * only an Ultracode run writes it. So it is neither the run's own report (a
 * normal run after an Ultracode one reads the old synthesis) nor always there
 * (a normal run never writes it). Every run writes its own workflow run row
 * under the Squad run's id, holding its terminal output and its error, and a
 * caller that waited for one run reads that row.
 */

import type { WorkflowRunRow } from "@/types/workflow/visual"

/** One Squad run's report: its text and, when it failed, why. */
export interface SquadRunReport {
  text?: string
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The text one terminal step's output carries, if any. */
function stepText(output: Record<string, unknown>): string | undefined {
  // An Ultracode run ends on its synthesis step, which reports `report`.
  if (typeof output.report === "string" && output.report.trim()) return output.report
  // A task step (dispatch or lead review) carries the teammate's answer.
  if (typeof output.text === "string" && output.text.trim()) return output.text
  return undefined
}

/**
 * The report a Squad run's terminal output carries, as text. The workflow
 * engine's output is the one terminal step's output, or a map of every
 * terminal step's output when there are several; those are joined in order.
 * An integration step (`merge-all`) carries no report.
 */
export function squadRunReportText(output: unknown): string | undefined {
  if (!isRecord(output)) return undefined
  const own = stepText(output)
  if (own !== undefined) return own
  if ("reconciled" in output) return undefined
  const texts = Object.values(output).flatMap((step) => {
    const text = isRecord(step) ? stepText(step) : undefined
    return text === undefined ? [] : [text]
  })
  return texts.length > 0 ? texts.join("\n\n") : undefined
}

/** One Squad run's report from its row: what it ended with, never another run's. */
export function squadRunReportOf(
  row: Pick<WorkflowRunRow, "output" | "error"> | undefined
): SquadRunReport {
  if (!row) return {}
  const text = squadRunReportText(row.output)
  const error = row.error?.message?.trim()
  return {
    ...(text !== undefined ? { text } : {}),
    ...(error ? { error } : {}),
  }
}

/** Read one Squad run's report. A run with no row reports nothing. */
export async function readSquadRunReport(runId: string): Promise<SquadRunReport> {
  const { getDb } = await import("@/lib/db/schema")
  return squadRunReportOf(await getDb().workflowRuns.get(runId))
}
