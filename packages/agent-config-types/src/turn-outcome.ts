// How one agent turn ended, read off its terminal `result` frame (ADR-0090).
//
// Every built-in rail closes a turn with an SDK-shaped `result` frame: the
// Claude Agent SDK's own, the AI SDK sidecar's (`runtimes/ai-sdk/events.ts`)
// and the standalone engine's (`lib/ai/chat/sdk-event-mapper.ts`). A frame
// arriving is NOT the same thing as the turn having done its work:
//
//   • A provider failure can arrive as `subtype: "success"` with
//     `is_error: true` (a 404 from a mistyped base URL).
//   • A caller's ceiling — steps, money, structured-output retries — ends the
//     turn cleanly with partial work (`error_max_turns`, …).
//   • A reply cut at the output-token limit, or refused by a content filter,
//     is a `success` whose `stop_reason` says it is not finished.
//   • A Stop ends the turn with `terminal_reason: "aborted_*"`.
//
// Only `completed` may advance anything that waits on the turn having
// finished: a plan step, a work submission settled as done, a verifier's
// verdict, a completion notification. `incomplete` keeps the partial output
// and lets a caller that is built to continue (a goal, a loop) do so;
// `failed` is a failure. This module is the one place that decides which is
// which, shared by the sidecar (compiled `dist/` under Node) and the app.

/** The subset of an SDK `result` frame this classification reads. */
export interface TurnResultFrame {
  type?: unknown
  subtype?: unknown
  is_error?: unknown
  terminal_reason?: unknown
  stop_reason?: unknown
  api_error_status?: unknown
  [key: string]: unknown
}

/** Ceilings the caller set on the turn. The turn ended cleanly with partial work. */
export const TURN_CEILING_SUBTYPES: ReadonlySet<string> = new Set([
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
])

/**
 * `TerminalReason` values that mean the provider leg itself failed, as opposed
 * to a ceiling the caller asked for or a stop the caller initiated. Kept as an
 * explicit allowlist: an unknown future reason must not silently become a
 * failure.
 */
export const PROVIDER_FAILURE_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "api_error",
  "model_error",
  "prompt_too_long",
  "image_error",
  "turn_setup_failed",
])

/** `stop_reason` values that say the final reply is not a finished answer. */
export const INCOMPLETE_STOP_REASONS: ReadonlySet<string> = new Set([
  "max_tokens",
  "refusal",
  "model_context_window_exceeded",
])

export type TurnOutcome =
  | { kind: "completed" }
  | {
      kind: "incomplete"
      /**
       * A ceiling subtype (`error_max_turns`), a stop reason (`max_tokens`,
       * `refusal`) or a terminal reason (`aborted_streaming`).
       */
      reason: string
    }
  | {
      kind: "failed"
      /** The failure code, as {@link failureCodeFromResult} names it. */
      reason: string
    }

function asRecord(value: unknown): TurnResultFrame | null {
  return value !== null && typeof value === "object" ? (value as TurnResultFrame) : null
}

/** Whether this `result` frame reports a genuine provider/transport failure. */
export function isProviderFailureResult(value: unknown): boolean {
  const result = asRecord(value)
  if (!result) return false
  if (
    typeof result.terminal_reason === "string" &&
    PROVIDER_FAILURE_TERMINAL_REASONS.has(result.terminal_reason)
  ) {
    return true
  }
  if (result.subtype === "error_during_execution") return true
  // Last resort: an HTTP status is only ever attached when a request failed.
  return typeof result.api_error_status === "number" && result.api_error_status >= 400
}

/**
 * Canonical failure code for a non-successful `result` frame.
 *
 * Never the subtype alone: a 404 arrives with `subtype: "success"`, so
 * `String(subtype)` produced the nonsense code `"success"`. An explicit error
 * subtype still wins — `error_max_turns` is a more useful code than its
 * `max_turns` terminal reason — then the terminal reason, then a stop reason
 * that says the reply is unfinished.
 */
export function failureCodeFromResult(value: unknown): string {
  const result = asRecord(value)
  const subtype = typeof result?.subtype === "string" ? result.subtype : ""
  if (subtype && subtype !== "success") return subtype
  const reason = typeof result?.terminal_reason === "string" ? result.terminal_reason : ""
  if (reason && reason !== "completed") return reason
  const stop = typeof result?.stop_reason === "string" ? result.stop_reason : ""
  if (INCOMPLETE_STOP_REASONS.has(stop)) return stop
  return "error"
}

/**
 * Classify how a turn ended from its terminal `result` frame.
 *
 * A missing or malformed frame is `incomplete` (`no_result`): nothing says
 * the work was done, and a caller must not infer success from silence.
 */
export function classifyTurnResult(value: unknown): TurnOutcome {
  const result = asRecord(value)
  if (!result) return { kind: "incomplete", reason: "no_result" }
  const subtype = typeof result.subtype === "string" ? result.subtype : undefined
  if (subtype && TURN_CEILING_SUBTYPES.has(subtype)) return { kind: "incomplete", reason: subtype }
  if (isProviderFailureResult(result))
    return { kind: "failed", reason: failureCodeFromResult(result) }
  if (result.is_error === true || (subtype !== undefined && subtype !== "success")) {
    return { kind: "failed", reason: failureCodeFromResult(result) }
  }
  const terminal = typeof result.terminal_reason === "string" ? result.terminal_reason : undefined
  if (terminal && terminal !== "completed") return { kind: "incomplete", reason: terminal }
  const stop = typeof result.stop_reason === "string" ? result.stop_reason : undefined
  if (stop && INCOMPLETE_STOP_REASONS.has(stop)) return { kind: "incomplete", reason: stop }
  return { kind: "completed" }
}

/** Whether a turn whose result is `value` finished its work. */
export function turnResultCompleted(value: unknown): boolean {
  return classifyTurnResult(value).kind === "completed"
}
