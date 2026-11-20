import { unfinishedSessionEnd } from "./session-end"

describe("unfinishedSessionEnd", () => {
  it("leaves an errored or finished end alone", () => {
    expect(unfinishedSessionEnd({ error: "boom", interrupted: true })).toBeNull()
    expect(unfinishedSessionEnd({})).toBeNull()
    expect(
      unfinishedSessionEnd({ result: { type: "result", subtype: "success", is_error: false } })
    ).toBeNull()
  })

  it("names a ceiling, a cut reply and a Stop", () => {
    expect(
      unfinishedSessionEnd({
        result: { type: "result", subtype: "error_max_turns", is_error: true },
      })
    ).toEqual({ outcome: "failed", reason: "error_max_turns" })
    expect(
      unfinishedSessionEnd({
        result: { type: "result", subtype: "success", stop_reason: "refusal" },
      })
    ).toEqual({ outcome: "failed", reason: "refusal" })
    expect(unfinishedSessionEnd({ interrupted: true })).toEqual({
      outcome: "cancelled",
      reason: "interrupted",
    })
  })
})
