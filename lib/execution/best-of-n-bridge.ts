/**
 * Projects a best-of-N group onto the canonical run journal as
 * `kind: "best-of-n"`.
 *
 * The group keeps a durable team run for its ledger (dispatch, children,
 * usage), but its row is its own: written before the durable run is prepared,
 * so the team journal sees it and writes no `team` row (`durable-runtime.ts`).
 * Each candidate's `job` row is a child of this one. The row sits in the
 * conversation the group was started from, so that conversation's run tree
 * reaches the attempts.
 *
 * What crosses is the prompt as the title (the person typed it, and two
 * groups running at once must be told apart) and the terminal status. The
 * candidates' answers stay in their own conversations.
 */

import {
  createExecutionRun,
  getExecutionRun,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { isTerminalRunStatus, type ExecutionRun } from "@/types/execution/run"
import { recordedRunMetadata } from "./acting-authority"

/** The group's row, keyed by its durable team run so the ledger can find it. */
export function bestOfNExecutionRunId(teamRunId: string): string {
  return `execution:best-of-n:${teamRunId}`
}

/** The group a best-of-N row belongs to, or `undefined` for any other row. */
export function bestOfNGroupIdOf(run: Pick<ExecutionRun, "kind" | "sourceId">): string | undefined {
  return run.kind === "best-of-n" && run.sourceId ? run.sourceId : undefined
}

/** The longest title the row keeps; the prompt itself stays in the conversation. */
export const BEST_OF_N_TITLE_MAX = 200

function rowTitle(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0] ?? ""
  return line.length > BEST_OF_N_TITLE_MAX ? `${line.slice(0, BEST_OF_N_TITLE_MAX - 1)}…` : line
}

export interface BestOfNRunSeed {
  groupId: string
  teamRunId: string
  prompt: string
  /** The conversation the group was started from. */
  sessionId?: string
  projectId?: string
  at: number
}

/** Write the group's row once. Safe to call again for the same group. */
export async function ensureBestOfNExecutionRun(seed: BestOfNRunSeed): Promise<string> {
  const runId = bestOfNExecutionRunId(seed.teamRunId)
  if (await getExecutionRun(runId)) return runId
  try {
    await createExecutionRun({
      id: runId,
      // As the group's team row was: no requester authority of its own.
      ...recordedRunMetadata("external-event", { runId }),
      kind: "best-of-n",
      sourceId: seed.groupId,
      ...(seed.projectId ? { projectId: seed.projectId } : {}),
      ...(seed.sessionId ? { sessionId: seed.sessionId } : {}),
      title: rowTitle(seed.prompt) || "Best-of-N",
      status: "running",
      currentRevision: 0,
      startedAt: seed.at,
      updatedAt: seed.at,
    })
  } catch (error) {
    if (!(error instanceof Error && error.name === "ConstraintError")) throw error
  }
  await runEventJournal.append(
    runId,
    semanticRunEvent(
      "run.started",
      { groupId: seed.groupId },
      { ts: seed.at, sourceEventId: `best-of-n:${seed.groupId}:started` }
    )
  )
  return runId
}

/**
 * Settle the group's row. `recovery_required` leaves it open for a person;
 * a row already settled stays as it is.
 */
export async function settleBestOfNExecutionRun(
  teamRunId: string,
  status: "completed" | "cancelled" | "recovery_required",
  ts = Date.now()
): Promise<boolean> {
  const runId = bestOfNExecutionRunId(teamRunId)
  const run = await getExecutionRun(runId)
  if (!run) return false
  if (isTerminalRunStatus(run.status)) return true
  await runEventJournal.append(
    runId,
    semanticRunEvent(
      `run.${status}`,
      {},
      { ts, sourceEventId: `best-of-n:${run.sourceId}:terminal:${status}` }
    )
  )
  return true
}
