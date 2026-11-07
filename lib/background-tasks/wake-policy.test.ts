import { WAKE_CAP_PER_HOUR, WAKE_COALESCE_MS, WakeLimiter } from "./wake-policy"

const HOUR = 60 * 60 * 1000

function wakeOnce(limiter: WakeLimiter, sessionId: string, at: number) {
  limiter.noteSettlement(sessionId, at)
  expect(limiter.decide(sessionId, at + WAKE_COALESCE_MS)).toEqual({ kind: "wake" })
  limiter.recordWake(sessionId, at + WAKE_COALESCE_MS)
}

describe("WakeLimiter", () => {
  it("merges ends that land within the coalescing window into one wake", () => {
    const limiter = new WakeLimiter()
    limiter.noteSettlement("s", 1_000)
    limiter.noteSettlement("s", 4_000)
    expect(limiter.decide("s", 4_000)).toEqual({ kind: "wait", waitMs: 7_000 })
    expect(limiter.decide("s", 1_000 + WAKE_COALESCE_MS)).toEqual({ kind: "wake" })
  })

  it("opens the window when ends are found pending without an event", () => {
    const limiter = new WakeLimiter()
    expect(limiter.decide("s", 0)).toEqual({ kind: "wait", waitMs: WAKE_COALESCE_MS })
    expect(limiter.decide("s", WAKE_COALESCE_MS)).toEqual({ kind: "wake" })
  })

  it("caps wakes per session per hour and announces the first refusal only", () => {
    const limiter = new WakeLimiter()
    for (let i = 0; i < WAKE_CAP_PER_HOUR; i += 1) wakeOnce(limiter, "s", i * 60_000)
    limiter.noteSettlement("s", 10 * 60_000)
    const at = 10 * 60_000 + WAKE_COALESCE_MS
    expect(limiter.decide("s", at)).toEqual({ kind: "over_cap", notify: true })
    expect(limiter.decide("s", at + 1)).toEqual({ kind: "over_cap", notify: false })
    // Another session is not affected.
    wakeOnce(limiter, "other", at)
  })

  it("lets waiting ends go with the boundary after a turn taken for another reason", () => {
    const limiter = new WakeLimiter()
    for (let i = 0; i < WAKE_CAP_PER_HOUR; i += 1) wakeOnce(limiter, "s", i * 60_000)
    limiter.noteSettlement("s", 600_000)
    expect(limiter.decide("s", 700_000).kind).toBe("over_cap")
    limiter.noteOtherTurn("s", 710_000)
    expect(limiter.decide("s", 720_000)).toEqual({ kind: "wake" })
    limiter.recordWake("s", 720_000)
    // A new episode is announced again.
    limiter.noteSettlement("s", 730_000)
    expect(limiter.decide("s", 750_000)).toEqual({ kind: "over_cap", notify: true })
  })

  it("an earlier turn does not release a later refusal", () => {
    const limiter = new WakeLimiter()
    limiter.noteOtherTurn("s", 0)
    for (let i = 0; i < WAKE_CAP_PER_HOUR; i += 1) wakeOnce(limiter, "s", (i + 1) * 60_000)
    limiter.noteSettlement("s", 600_000)
    expect(limiter.decide("s", 700_000).kind).toBe("over_cap")
  })

  it("forgets wakes older than an hour", () => {
    const limiter = new WakeLimiter({ capPerHour: 1 })
    wakeOnce(limiter, "s", 0)
    limiter.noteSettlement("s", 60_000)
    expect(limiter.decide("s", 70_000).kind).toBe("over_cap")
    expect(limiter.decide("s", HOUR + WAKE_COALESCE_MS + 1)).toEqual({ kind: "wake" })
  })
})
