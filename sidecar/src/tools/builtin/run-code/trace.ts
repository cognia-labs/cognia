// The trace of one `run_code` program's nested tool calls (ADR-0117 Phase 4,
// CM-12).
//
// A program's `cognia.*` calls never reach the transcript as tool calls of
// their own: the model did not make them, and history must not replay them
// as if it had. What the chat and the event log get instead is one event per
// change in a nested call's state, named after the outer `run_code` call and
// the nested call's place in the program. It carries the safe facts only: the
// tool, its state, the failure kind, the time it took and the size of what it
// returned. Never its input or its output.
//
// The nested call's id, `<run_code call id>/<ordinal>`, is the same id its
// approval, its output review and its execution use, so all of them point at
// one call under one parent.

import type { ToolFailureKind } from "../../kernel/failure.ts"

/** The `system` subtype the event rides as, on both rails. */
export const CODE_RUN_CALL_SUBTYPE = "code_run_call"

export type CodeRunCallState = "running" | "succeeded" | "failed"

/** One nested call as the supervisor saw it. */
export interface CodeRunCall {
  /** 1-based, in the order the program made its calls. */
  ordinal: number
  tool: string
  state: CodeRunCallState
  /** Set when `state` is `failed`. */
  failure?: ToolFailureKind | undefined
  /** Set once the call has ended. */
  durationMs?: number | undefined
  /** Bytes of the result the program received; set when it succeeded. */
  resultBytes?: number | undefined
}

/** A nested call's state, under the `run_code` call that made it. */
export interface CodeRunCallReport {
  parentToolCallId: string
  call: CodeRunCall
}

/** The id one nested call's approval, review and execution share. */
export function nestedToolCallId(parentToolCallId: string, ordinal: number): string {
  return `${parentToolCallId}/${ordinal}`
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * The tool name a trace may carry. The program can name anything; a name that
 * is not a tool name is reported as `unknown` rather than echoed.
 */
export function traceableToolName(name: unknown): string {
  return typeof name === "string" && TOOL_NAME.test(name) ? name : "unknown"
}

/** The wire frame: an SDK-shaped `system` event in the session's stream. */
export function codeRunCallFrame(sessionId: string | undefined, report: CodeRunCallReport) {
  const { call } = report
  return {
    type: "event",
    sessionId,
    event: {
      type: "system",
      subtype: CODE_RUN_CALL_SUBTYPE,
      parent_tool_use_id: report.parentToolCallId,
      call: {
        id: nestedToolCallId(report.parentToolCallId, call.ordinal),
        ordinal: call.ordinal,
        tool: call.tool,
        state: call.state,
        ...(call.failure ? { failure: call.failure } : {}),
        ...(call.durationMs !== undefined ? { duration_ms: call.durationMs } : {}),
        ...(call.resultBytes !== undefined ? { result_bytes: call.resultBytes } : {}),
      },
    },
  }
}
