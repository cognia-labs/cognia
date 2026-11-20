import {
  RunAndCaptureError,
  capturedTurnUnfinished,
  compactBoundaryFromInner,
  retryFromInner,
} from "./capture-types"

describe("RunAndCaptureError", () => {
  it("carries the capture code and only the metadata it was given", () => {
    const bare = new RunAndCaptureError("no reply", "no_assistant_text")
    expect(bare).toBeInstanceOf(Error)
    expect(bare.name).toBe("RunAndCaptureError")
    expect(bare.code).toBe("no_assistant_text")
    expect(bare.httpStatus).toBeUndefined()
    expect(bare.retryAfterMs).toBeUndefined()
    expect(bare.partial).toBeUndefined()

    const partial = { text: "half", conversationSnapshot: [{ role: "assistant" }] }
    const full = new RunAndCaptureError("rate limited", "session_error", {
      httpStatus: 429,
      retryAfterMs: 1_500,
      partial,
    })
    expect(full).toMatchObject({ httpStatus: 429, retryAfterMs: 1_500, partial })
  })
})

describe("compactBoundaryFromInner", () => {
  it("maps a compact_boundary system message to the typed compact event", () => {
    expect(
      compactBoundaryFromInner({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 90_000, post_tokens: 12_000 },
      })
    ).toEqual({ type: "compact", trigger: "manual", preTokens: 90_000, postTokens: 12_000 })
  })

  it("defaults a non-manual / missing trigger to auto and coerces non-numeric tokens to 0", () => {
    expect(
      compactBoundaryFromInner({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { pre_tokens: "x" },
      })
    ).toEqual({ type: "compact", trigger: "auto", preTokens: 0, postTokens: 0 })
  })

  it("returns null for non-boundary inputs", () => {
    expect(compactBoundaryFromInner(null)).toBeNull()
    expect(compactBoundaryFromInner({ type: "assistant" })).toBeNull()
    expect(compactBoundaryFromInner({ type: "system", subtype: "init" })).toBeNull()
  })
})

describe("retryFromInner", () => {
  it("maps an api_retry system message to the typed retry event", () => {
    expect(
      retryFromInner({
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 2_495,
        error_status: 429,
        error: "rate_limit_error",
      })
    ).toEqual({
      type: "retry",
      phase: "scheduled",
      attempt: 3,
      maxRetries: 10,
      code: "api_retry",
      delayMs: 2_495,
      status: 429,
      message: "rate_limit_error",
    })
  })

  it("omits the status the SDK reports as null on a transport failure", () => {
    // An unreachable endpoint has no HTTP response, so the SDK sends
    // `error_status: null` / `error: "unknown"`.
    const event = retryFromInner({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 10,
      retry_delay_ms: 564,
      error_status: null,
      error: "unknown",
    })
    expect(event).not.toBeNull()
    expect(event && "status" in event).toBe(false)
    expect(event?.message).toBe("unknown")
  })

  it("defaults the counters rather than emitting NaN", () => {
    expect(retryFromInner({ type: "system", subtype: "api_retry" })).toEqual({
      type: "retry",
      phase: "scheduled",
      attempt: 0,
      maxRetries: 0,
      code: "api_retry",
    })
  })

  it("returns null for non-retry inputs", () => {
    expect(retryFromInner(null)).toBeNull()
    expect(retryFromInner({ type: "assistant" })).toBeNull()
    expect(retryFromInner({ type: "system", subtype: "init" })).toBeNull()
  })
})

// ── Execution-broker admission ─────────────────────────────────────────────
// The wrapper funnels every headless leg through the global ExecutionBroker so
// the four concurrency subsystems share one ceiling and are observable/
// cancellable as a unit.

describe("capturedTurnUnfinished", () => {
  it("names a ceiling, a cut reply and a failure, and passes a finished turn", () => {
    expect(capturedTurnUnfinished({ resultSubtype: "error_max_turns" })).toBe("error_max_turns")
    // A truncated reply is a `success` subtype: only the outcome says so.
    expect(
      capturedTurnUnfinished({
        resultSubtype: "success",
        turnOutcome: { kind: "incomplete", reason: "max_tokens" },
      })
    ).toBe("max_tokens")
    expect(capturedTurnUnfinished({ turnOutcome: { kind: "failed", reason: "api_error" } })).toBe(
      "api_error"
    )
    expect(
      capturedTurnUnfinished({ resultSubtype: "success", turnOutcome: { kind: "completed" } })
    ).toBeNull()
    expect(capturedTurnUnfinished({})).toBeNull()
  })
})
