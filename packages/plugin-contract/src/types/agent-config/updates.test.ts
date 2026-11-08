import { canTransitionUpdateState, type UpdateState } from "./updates"

describe("executor result transitions (U05, L01)", () => {
  it.each<[UpdateState, UpdateState]>([
    ["installing", "awaiting-store"],
    ["installing", "current"],
    ["installing", "available"],
    ["downloading", "awaiting-store"],
    ["downloading", "current"],
    ["downloading", "awaiting-restart"],
    ["cancelled", "installing"],
    ["cancelled", "downloading"],
  ])("allows %s to %s", (from, to) => {
    expect(canTransitionUpdateState(from, to)).toBe(true)
  })

  it("still rejects checking or a new apply from a restart handoff", () => {
    expect(canTransitionUpdateState("installing", "checking")).toBe(false)
    expect(canTransitionUpdateState("awaiting-restart", "installing")).toBe(false)
  })
})
