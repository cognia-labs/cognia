import { CompanionError } from "@/lib/tauri/transport-companion"

import { HOST_UNAVAILABLE, isHostUnavailableError } from "./host-unavailable"

describe("isHostUnavailableError", () => {
  it("recognises the host's refusal as the companion transport raises it", () => {
    const error = new CompanionError({
      code: HOST_UNAVAILABLE,
      message: "the host's brain is not connected; nothing was written",
      retryable: true,
    })
    expect(isHostUnavailableError(error)).toBe(true)
  })

  it("finds it inside an AggregateError from a fan-out", () => {
    const refused = Object.assign(new Error("refused"), { code: HOST_UNAVAILABLE })
    const aggregate = new AggregateError([new Error("other"), refused], "2 failed")
    expect(isHostUnavailableError(aggregate)).toBe(true)
  })

  it("does not treat an unreachable host or another refusal as this one", () => {
    expect(
      isHostUnavailableError(
        new CompanionError({ code: "network", message: "offline", retryable: true })
      )
    ).toBe(false)
    expect(isHostUnavailableError({ code: "SESSION_NOT_FOUND" })).toBe(false)
    expect(isHostUnavailableError(new AggregateError([new Error("x")], "1 failed"))).toBe(false)
    expect(isHostUnavailableError(new Error(HOST_UNAVAILABLE))).toBe(false)
    expect(isHostUnavailableError(null)).toBe(false)
    expect(isHostUnavailableError("HOST_UNAVAILABLE")).toBe(false)
  })
})
