import { classifyTurnResult } from "@cognia/agent-config-types/turn-outcome"

/**
 * The settlement of a clean `session_ended` (no error) whose turn did not
 * finish, or `null` for a finished or result-less clean end.
 *
 * Both built-in rails attach the turn's `result` frame to its end and mark a
 * Stop `interrupted`. A ceiling (`error_max_turns`, …), a reply cut at the
 * token limit or refused, or a failed frame that came without an error is
 * `failed` with its reason as the error code; a Stop is `cancelled`. Every
 * consumer that settles a submission off a session end — the chat view and
 * the Host's own listener — reads it here, so a step cap can no longer be
 * settled as a completed piece of work.
 */
export function unfinishedSessionEnd(evt: {
  error?: unknown
  interrupted?: unknown
  result?: unknown
}): { outcome: "failed" | "cancelled"; reason: string } | null {
  if (evt.error) return null
  if (evt.interrupted === true) return { outcome: "cancelled", reason: "interrupted" }
  if (evt.result === undefined || evt.result === null) return null
  const outcome = classifyTurnResult(evt.result)
  return outcome.kind === "completed" ? null : { outcome: "failed", reason: outcome.reason }
}
