/**
 * Recovery decisions for work stranded by a crash (ADR-0123).
 *
 * A submission that was `claimed` or `dispatched` when the process died is
 * ambiguous: the runtime may never have seen it, may have started it, or may
 * have run tools and died before reporting. This module answers one question
 * per submission — **may this be re-dispatched automatically?** — and defaults
 * to "no".
 *
 * The rule is asymmetric on purpose. Re-dispatching work that already ran a
 * tool can double-fire a side effect the user cannot undo; leaving work parked
 * costs an explicit resume. So automatic replay requires positive evidence that
 * nothing happened, not merely the absence of evidence that something did.
 *
 * Empty records are not that evidence for an attempt a crash cut off: the
 * journal is written by the renderer as the runtime reports, so a tool the
 * runtime had already started can be missing from both logs. Only a runner
 * that watched the runtime decline the work (and released the row) proves the
 * attempt did nothing; an attempt still `claimed` or `dispatched` stays
 * unknown and waits for a person.
 *
 * This does **not** introduce a second recovery machine. It composes the
 * existing zero-replay machinery in `lib/ai/agent/recovery/`:
 * `readCanonicalEnvelopes` + `candidateFromEnvelopes` + `planRecovery` decide
 * whenever a canonical envelope log exists. The semantic run journal is
 * consulted first because Direct Chat writes `tool.*` events there long before
 * it writes canonical envelopes, and a tool call recorded in either place is
 * disqualifying.
 */

import { listExecutionRunEvents } from "@/lib/db/execution-runs"
import {
  candidateFromEnvelopes,
  CanonicalLogCorruptionError,
  readCanonicalEnvelopes,
} from "@/lib/ai/agent/recovery/canonical-log"
import { planRecovery } from "@/lib/ai/agent/recovery/recovery-planner"
import type { WorkSubmissionRow } from "@/lib/db/work-submissions"

/** Run-event types that prove the turn reached a tool. */
const TOOL_EVENT_TYPES = new Set(["tool.started", "tool.completed", "tool.failed"])

/**
 * States a runner sets only after `dispatch` reported that the runtime did not
 * take the work (`releaseWorkSubmission`). Any other state on a row being
 * planned again means its attempt ended in a crash, mid-flight.
 */
const RELEASED_STATES = new Set<WorkSubmissionRow["dispatchState"]>(["pending", "blocked"])

export type WorkRecoveryDecision =
  | {
      action: "redispatch"
      /**
       * `never-dispatched` — the runtime was never handed the work.
       * `no-observed-effects` — an earlier attempt was declined by the runtime
       * and released, and nothing side-effecting was recorded for it.
       */
      reason: "never-dispatched" | "no-observed-effects"
    }
  | {
      action: "recovery_required"
      reason:
        | "observed-tool-activity"
        /** A crash cut the attempt off and nothing proves it had not started. */
        | "unconfirmed-attempt"
        | "corrupt-canonical-log"
        | "no-candidates"
        | "forked-history"
        | "no-dominant"
        | "ambiguous-side-effects"
        | "unreadable-journal"
      detail: string[]
    }

export interface WorkRecoveryDeps {
  listRunEvents?: typeof listExecutionRunEvents
  readEnvelopes?: typeof readCanonicalEnvelopes
}

/**
 * Decide whether a stranded submission may be re-dispatched without asking.
 *
 * Order matters: the cheap, always-present semantic journal is checked before
 * the canonical envelope log, because a `tool.*` event is disqualifying on its
 * own and reading envelopes cannot make it safe again.
 */
export async function planWorkSubmissionRecovery(
  row: WorkSubmissionRow,
  deps: WorkRecoveryDeps = {}
): Promise<WorkRecoveryDecision> {
  // Never claimed means the runtime never saw it: replaying is a first attempt,
  // not a retry.
  if (row.attemptCount === 0) return { action: "redispatch", reason: "never-dispatched" }

  const listEvents = deps.listRunEvents ?? listExecutionRunEvents
  let events
  try {
    events = await listEvents(row.runId)
  } catch (error) {
    return {
      action: "recovery_required",
      reason: "unreadable-journal",
      detail: [error instanceof Error ? error.message : String(error)],
    }
  }
  const toolEvents = events.filter((event) => TOOL_EVENT_TYPES.has(event.type))
  if (toolEvents.length > 0) {
    return {
      action: "recovery_required",
      reason: "observed-tool-activity",
      detail: [`${toolEvents.length} tool event(s) recorded on run ${row.runId}`],
    }
  }

  let envelopes
  try {
    envelopes = await (deps.readEnvelopes ?? readCanonicalEnvelopes)(row.runId)
  } catch (error) {
    if (error instanceof CanonicalLogCorruptionError) {
      return {
        action: "recovery_required",
        reason: "corrupt-canonical-log",
        detail: [error.message],
      }
    }
    return {
      action: "recovery_required",
      reason: "unreadable-journal",
      detail: [error instanceof Error ? error.message : String(error)],
    }
  }

  // (`candidateFromEnvelopes` returns undefined exactly when there are none.)
  const candidate = candidateFromEnvelopes(envelopes)
  if (candidate) {
    const plan = planRecovery([candidate])
    if (plan.action === "recovery_required") {
      return { action: "recovery_required", reason: plan.reason, detail: plan.detail }
    }
    // Replay starts the turn over, so a tool that finished runs a second time:
    // a resolved call is as disqualifying as an open one.
    const calls = candidate.turns.flatMap((turn) => turn.toolCalls ?? [])
    if (calls.length > 0) {
      return {
        action: "recovery_required",
        reason: "observed-tool-activity",
        detail: [`${calls.length} tool call(s) in the canonical log of run ${row.runId}`],
      }
    }
  }

  if (!RELEASED_STATES.has(row.dispatchState)) {
    return {
      action: "recovery_required",
      reason: "unconfirmed-attempt",
      detail: [
        `attempt ${row.attemptCount} of run ${row.runId} was cut off while ${row.dispatchState}`,
      ],
    }
  }
  return { action: "redispatch", reason: "no-observed-effects" }
}
