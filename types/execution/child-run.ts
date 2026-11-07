/**
 * What every child run reports back to whoever launched it (ADR-0252 §3).
 *
 * `launchChildRun` (`lib/execution/launch-child-run.ts`) settles the child's
 * `executionRuns` row from this outcome and hands it to the caller. The text
 * and the error are for the caller (a model's tool result, a delegation
 * record): like a background task's `resultText`, they never enter the run
 * journal, which is projected to phones and IM cards.
 */

export type ChildRunOutcomeStatus = "completed" | "failed" | "cancelled"

export interface ChildRunOutcome {
  status: ChildRunOutcomeStatus
  /** The child's answer, when it produced one. */
  text?: string
  /** Why it failed or was cancelled, in words the caller can show. */
  error?: string
  /** The engine's own deadline ended it, not a person or the parent. */
  timedOut?: boolean
}

/** A started engine: its settlement, and how to stop it early. */
export interface StartedChildEngine {
  outcome: Promise<ChildRunOutcome>
  /** Ask the engine to stop. The outcome still settles, as `cancelled`. */
  stop(reason?: string): void
}
