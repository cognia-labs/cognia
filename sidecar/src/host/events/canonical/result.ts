import { asString, asNumber, compact, type CanonicalEvent, type SdkMappingState } from "./common.ts"
import { classifyStructuredOutcome } from "@cognia/agent-config-types/claude-agent-sdk-options"
import {
  classifyTurnResult,
  failureCodeFromResult,
  isProviderFailureResult,
} from "@cognia/agent-config-types/turn-outcome"
import { providerFailureMessage } from "../../../runtimes/claude-agent-sdk/result-terminal.ts"

/**
 * A `result` frame: the turn's usage, then the structured-output verdict.
 *
 * The frame does NOT settle the turn. A steer pushes a second prompt into the
 * same query, so the first prompt's `result` is not the end of the turn, and
 * a rail that ends a turn always says so once, on `session_ended`, carrying
 * the frame that decided it ({@link terminalEventsFromSessionEnded}). Settling
 * here as well put two terminal events on the stream for one turn — or an
 * early `ended` before the real outcome.
 *
 * The verdict goes out here, before the terminal event, so a consumer that
 * stops reading at `lifecycle: ended` has already seen it.
 */
export function fromResult(evt: Record<string, unknown>, state: SdkMappingState): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  if (evt.usage && typeof evt.usage === "object") {
    events.push({ kind: "usage", usage: evt.usage })
  }
  const structured = structuredOutcomeOf(evt, state)
  if (structured) {
    events.push(compact({ kind: "structured-output", ...structured }))
  }
  return events
}

function structuredOutcomeOf(evt: Record<string, unknown>, state: SdkMappingState | undefined) {
  return classifyStructuredOutcome(
    {
      subtype: asString(evt.subtype),
      is_error: evt.is_error === true,
      structured_output: evt.structured_output,
    },
    state?.expectStructuredOutput === true
  )
}

const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * The ONE terminal canonical event for a turn, from its `session_ended`.
 *
 * Every built-in rail emits exactly one `session_ended` per turn and attaches
 * the `result` frame that ended it, so the outcome is decided once:
 *
 *  - an interrupted turn (a Stop) is `lifecycle: interrupted`;
 *  - an error is a `failure`, coded by the turn's own code, else by the
 *    result's failure code, else `session_error`;
 *  - a result that is not a finished turn — a ceiling, a truncated or refused
 *    reply, a provider failure, a requested schema that never came back — is
 *    a `failure` carrying that code, with its partial output already on the
 *    stream;
 *  - anything else is `lifecycle: ended`, with the result's delivery timing.
 */
export function terminalEventsFromSessionEnded(
  msg: Record<string, unknown>,
  state: SdkMappingState | undefined
): CanonicalEvent[] {
  const result =
    msg.result && typeof msg.result === "object"
      ? (msg.result as Record<string, unknown>)
      : undefined
  const outcome = result ? classifyTurnResult(result) : undefined
  if (msg.error) {
    // The turn's own code when it named one (a gateway refusal such as
    // `member_usage_cap_reached`), so a member's devices can say why.
    const code =
      typeof msg.code === "string" && ERROR_CODE.test(msg.code)
        ? msg.code
        : result && outcome?.kind !== "completed"
          ? failureCodeFromResult(result)
          : "session_error"
    return [
      compact({
        kind: "failure",
        code,
        message: String(msg.error),
        retryable: result?.subtype === "error_during_execution" ? true : undefined,
      }),
    ]
  }
  if (msg.interrupted === true) return [{ kind: "lifecycle", phase: "interrupted" }]
  if (!result || !outcome) return [{ kind: "lifecycle", phase: "ended" }]

  if (outcome.kind === "completed" && structuredOutcomeOf(result, state)?.status === "missing") {
    return [
      {
        kind: "failure",
        code: "structured_output_missing",
        message:
          "the turn completed but returned no structured_output for the requested json_schema",
        // The model answered in prose once; asking again can land differently, so
        // unlike a budget ceiling this is worth another attempt.
        retryable: true,
      },
    ]
  }
  if (outcome.kind === "completed") {
    const timing = timingOf(result)
    return [
      compact({
        kind: "lifecycle",
        phase: "ended",
        timing: Object.keys(timing).length ? timing : undefined,
      }),
    ]
  }
  return [
    compact({
      kind: "failure",
      // NOT `String(subtype)`: an upstream 404 arrives as `subtype: "success"`
      // with `is_error: true`. See `failureCodeFromResult`.
      code: failureCodeFromResult(result),
      // A provider failure gets the status-led message, so a mistyped base
      // URL reads as `HTTP 404: …` rather than as the SDK's model-shaped
      // prose. Caller-owned ceilings keep their existing wording.
      message: isProviderFailureResult(result)
        ? providerFailureMessage(result)
        : (asString(result.result) ?? outcome.reason),
      // Budget and turn ceilings are the caller's policy, not a transient
      // fault — retrying the same request hits the same wall. Schema retries
      // are likewise already exhausted by the SDK itself.
      retryable: result.subtype === "error_during_execution" ? true : undefined,
    }),
  ]
}

function timingOf(evt: Record<string, unknown>) {
  const queueReason = (value: unknown) =>
    typeof value === "string" &&
    ["durable_post", "ephemeral_post", "retry_backoff", "hold", "none"].includes(value)
      ? value.replaceAll("_", "-")
      : undefined
  return compact({
    firstContentMs: asNumber(evt.first_content_frame_ms),
    firstStreamMs: asNumber(evt.first_stream_post_ms),
    firstStreamAckMs: asNumber(evt.first_stream_post_ack_ms),
    firstStreamQueueWaitMs: asNumber(evt.first_stream_post_queue_wait_ms),
    firstStreamQueueReason: queueReason(evt.first_stream_post_queued_behind),
    firstTextMs: asNumber(evt.first_text_post_ms),
    firstTextQueueWaitMs: asNumber(evt.first_text_post_queue_wait_ms),
    firstTextQueueReason: queueReason(evt.first_text_post_queued_behind),
  })
}
