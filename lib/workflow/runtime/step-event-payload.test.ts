/**
 * @jest-environment node
 */
import { getLoggerConfig } from "@cognia/logging"
import {
  MAX_STEP_INPUT_BYTES,
  STEP_INPUT_PREVIEW_CHARS,
  describeStepError,
  recordStepInputs,
} from "./step-event-payload"

const REPLACEMENT = getLoggerConfig().redaction.replacement

describe("recordStepInputs", () => {
  it("keeps the resolved inputs as plain data and redacts sensitive keys", () => {
    const recorded = recordStepInputs({
      url: "https://example.com",
      apiKey: "sk-live",
      count: BigInt(3),
      nested: { note: "Bearer abc.def" },
    })
    expect(recorded.inputsTruncatedBytes).toBeUndefined()
    expect(recorded.inputs).toEqual({
      url: "https://example.com",
      apiKey: REPLACEMENT,
      count: "3n",
      nested: { note: REPLACEMENT },
    })
  })

  it("replaces inputs above the byte bound with a bounded preview and their size", () => {
    const big = Array.from({ length: 200 }, (_, i) => `${i}:${"x".repeat(1_000)}`)
    const recorded = recordStepInputs({ rows: big })
    expect(recorded.inputsTruncatedBytes).toBeGreaterThan(MAX_STEP_INPUT_BYTES)
    expect(typeof recorded.inputs).toBe("string")
    expect((recorded.inputs as string).length).toBe(STEP_INPUT_PREVIEW_CHARS)
  })
})

describe("describeStepError", () => {
  it("keeps name, message, stack and the cause chain of a thrown Error", () => {
    const root = new TypeError("socket closed")
    const err = new Error("request failed", { cause: root })
    const detail = describeStepError(err)
    expect(detail.name).toBe("Error")
    expect(detail.message).toBe("request failed")
    expect(detail.stack).toContain("request failed")
    expect(detail.cause).toEqual(
      expect.objectContaining({ name: "TypeError", message: "socket closed" })
    )
  })

  it("redacts secrets the message or stack carries", () => {
    const detail = describeStepError(new Error("401 for Bearer sk-abc123"))
    expect(detail.message).toBe(`401 for ${REPLACEMENT}`)
    expect(detail.stack).not.toContain("sk-abc123")
  })

  it("keeps a non-Error throw as its string message", () => {
    expect(describeStepError("plain failure")).toEqual({ name: "Error", message: "plain failure" })
  })
})
