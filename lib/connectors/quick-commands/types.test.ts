import { isIMQuickCommand, normalizeQuickCommand, normalizeQuickCommandList } from "./types"

describe("normalizeQuickCommand", () => {
  it("passes through a canonical IMQuickCommand row", () => {
    const row = {
      triggerKey: "menu.x",
      label: "X",
      action: { type: "prompt" as const, value: "do x" },
    }
    expect(normalizeQuickCommand(row)).toEqual(row)
  })

  it("returns null for malformed rows", () => {
    expect(normalizeQuickCommand(null)).toBeNull()
    expect(normalizeQuickCommand({})).toBeNull()
    expect(normalizeQuickCommand({ triggerKey: 1 })).toBeNull()
    expect(normalizeQuickCommand({ triggerKey: "x" })).toBeNull()
    expect(
      normalizeQuickCommand({
        triggerKey: "x",
        action: { type: "bogus", value: "v" },
      })
    ).toBeNull()
    expect(normalizeQuickCommand({ eventKey: "x" })).toBeNull()
    expect(
      normalizeQuickCommand({ eventKey: "menu.x", action: { type: "slash", value: "/x" } })
    ).toBeNull()
  })
})

describe("isIMQuickCommand", () => {
  it("validates the action shape validates action shape", () => {
    expect(
      isIMQuickCommand({
        triggerKey: "x",
        action: { type: "prompt", value: "v" },
      })
    ).toBe(true)
    expect(isIMQuickCommand({ triggerKey: "x" })).toBe(false)
    expect(isIMQuickCommand({ triggerKey: "x", action: { type: "prompt" } })).toBe(false)
  })
})

describe("normalizeQuickCommandList", () => {
  it("drops malformed entries while keeping valid ones", () => {
    const out = normalizeQuickCommandList([
      { triggerKey: "a", action: { type: "prompt", value: "v" } },
      { eventKey: "b", action: { type: "slash", value: "/b" } },
      null,
      "bogus",
      { triggerKey: "c" },
    ])
    expect(out.map((c) => c.triggerKey)).toEqual(["a"])
  })

  it("returns an empty list for non-array input", () => {
    expect(normalizeQuickCommandList(undefined)).toEqual([])
    expect(normalizeQuickCommandList("oops")).toEqual([])
  })
})
