import {
  CONNECT_TIMEOUT_CODE,
  HostConnectError,
  MAX_CONNECT_DEADLINE_MS,
  connectDeadlineMs,
  neverSent,
} from "./connect-phase"

const coded = (code: string) => Object.assign(new Error(code), { code })

describe("neverSent", () => {
  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "tls_pin_mismatch",
  ])("reads %s as a failure before any byte was written", (code) => {
    expect(neverSent(coded(code))).toBe(true)
  })

  it.each(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"])(
    "reads %s as a request that may have arrived",
    (code) => {
      expect(neverSent(coded(code))).toBe(false)
    }
  )

  it("follows undici's fetch failed wrapper to the connect error", () => {
    const error = new TypeError("fetch failed", { cause: coded("ECONNREFUSED") })
    expect(neverSent(error)).toBe(true)
  })

  it("trusts the pinned connection layer's own error", () => {
    expect(neverSent(new HostConnectError("pin mismatch", "COGNIA_PIN_MISMATCH"))).toBe(true)
    expect(neverSent(new HostConnectError("slow", CONNECT_TIMEOUT_CODE))).toBe(true)
  })

  it("does not guess from a message alone", () => {
    expect(neverSent(new Error("ECONNREFUSED"))).toBe(false)
    expect(neverSent("ECONNREFUSED")).toBe(false)
    expect(neverSent(undefined)).toBe(false)
  })

  it("stops walking a cause chain that never ends", () => {
    const loop: { cause?: unknown } = {}
    loop.cause = loop
    expect(neverSent(loop)).toBe(false)
  })
})

describe("connectDeadlineMs", () => {
  it("takes a third of the budget, within bounds", () => {
    expect(connectDeadlineMs(3_000)).toBe(1_000)
    expect(connectDeadlineMs(600)).toBe(500)
    expect(connectDeadlineMs(120_000)).toBe(MAX_CONNECT_DEADLINE_MS)
  })

  it("moves in 100 ms steps as the remaining budget shrinks", () => {
    expect(connectDeadlineMs(2_999)).toBe(900)
    const deadlines = new Set(
      Array.from({ length: 30_000 }, (_unused, index) => connectDeadlineMs(index + 1))
    )
    expect(deadlines.size).toBeLessThanOrEqual(46)
  })

  it("falls back to the ceiling without a usable budget", () => {
    expect(connectDeadlineMs(undefined)).toBe(MAX_CONNECT_DEADLINE_MS)
    expect(connectDeadlineMs(0)).toBe(MAX_CONNECT_DEADLINE_MS)
    expect(connectDeadlineMs(Number.POSITIVE_INFINITY)).toBe(MAX_CONNECT_DEADLINE_MS)
  })
})
