import {
  classifyTurnResult,
  failureCodeFromResult,
  isProviderFailureResult,
  turnResultCompleted,
} from "./turn-outcome"

const SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
  stop_reason: "end_turn",
}

describe("classifyTurnResult", () => {
  it("calls only a finished success completed", () => {
    expect(classifyTurnResult(SUCCESS)).toEqual({ kind: "completed" })
    // The AI SDK rails carry no terminal reason.
    expect(classifyTurnResult({ type: "result", subtype: "success", is_error: false })).toEqual({
      kind: "completed",
    })
    expect(turnResultCompleted(SUCCESS)).toBe(true)
  })

  it("reads a 404 that arrives as subtype success as a failure", () => {
    const outcome = classifyTurnResult({
      ...SUCCESS,
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 404,
      stop_reason: "stop_sequence",
    })
    expect(outcome).toEqual({ kind: "failed", reason: "api_error" })
  })

  it.each(["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"])(
    "keeps the caller ceiling %s incomplete, not failed",
    (subtype) => {
      expect(classifyTurnResult({ type: "result", subtype, is_error: true })).toEqual({
        kind: "incomplete",
        reason: subtype,
      })
    }
  )

  it.each(["max_tokens", "refusal", "model_context_window_exceeded"])(
    "treats a success cut by %s as incomplete",
    (stop) => {
      expect(classifyTurnResult({ ...SUCCESS, stop_reason: stop })).toEqual({
        kind: "incomplete",
        reason: stop,
      })
    }
  )

  it("treats a stopped turn as incomplete", () => {
    expect(classifyTurnResult({ ...SUCCESS, terminal_reason: "aborted_streaming" })).toEqual({
      kind: "incomplete",
      reason: "aborted_streaming",
    })
  })

  it("fails an execution error and an unknown error subtype", () => {
    expect(
      classifyTurnResult({ type: "result", subtype: "error_during_execution", is_error: true })
    ).toEqual({ kind: "failed", reason: "error_during_execution" })
    expect(classifyTurnResult({ type: "result", subtype: "error_new_kind" })).toEqual({
      kind: "failed",
      reason: "error_new_kind",
    })
    expect(classifyTurnResult({ type: "result", subtype: "success", is_error: true })).toEqual({
      kind: "failed",
      reason: "error",
    })
  })

  it("never infers success from a missing frame", () => {
    expect(classifyTurnResult(undefined)).toEqual({ kind: "incomplete", reason: "no_result" })
    expect(classifyTurnResult(null)).toEqual({ kind: "incomplete", reason: "no_result" })
    expect(turnResultCompleted(undefined)).toBe(false)
  })
})

describe("failureCodeFromResult", () => {
  it("prefers the subtype, then the terminal reason, then an unfinished stop reason", () => {
    expect(
      failureCodeFromResult({ subtype: "error_max_turns", terminal_reason: "max_turns" })
    ).toBe("error_max_turns")
    expect(failureCodeFromResult({ subtype: "success", terminal_reason: "api_error" })).toBe(
      "api_error"
    )
    expect(failureCodeFromResult({ subtype: "success", stop_reason: "max_tokens" })).toBe(
      "max_tokens"
    )
    expect(failureCodeFromResult({ subtype: "success" })).toBe("error")
  })
})

describe("isProviderFailureResult", () => {
  it("matches failure terminal reasons, execution errors and HTTP statuses only", () => {
    expect(isProviderFailureResult({ terminal_reason: "prompt_too_long" })).toBe(true)
    expect(isProviderFailureResult({ subtype: "error_during_execution" })).toBe(true)
    expect(isProviderFailureResult({ api_error_status: 503 })).toBe(true)
    expect(isProviderFailureResult({ api_error_status: null })).toBe(false)
    expect(
      isProviderFailureResult({ subtype: "error_max_turns", terminal_reason: "max_turns" })
    ).toBe(false)
    expect(isProviderFailureResult(undefined)).toBe(false)
  })
})
