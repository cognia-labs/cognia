import { resolveBranchWinners, visibleThread, type BranchedMessage } from "./branch-visibility"

/** A stored row, not a UIMessage: the rules only read `id` and `metadata`. */
interface Row extends BranchedMessage {
  role: "user" | "assistant"
  createdAt: number
}

const row = (id: string, role: Row["role"], metadata?: Record<string, unknown>): Row => ({
  id,
  role,
  createdAt: Number(id.replace(/\D/g, "")) || 0,
  ...(metadata ? { metadata } : {}),
})

describe("resolveBranchWinners", () => {
  const rows = [
    row("a0", "assistant", { branchGroupId: "g", branchIndex: 0 }),
    row("a1", "assistant", { branchGroupId: "g", branchIndex: 1 }),
  ]

  it("takes the explicit choice, else the newest sibling", () => {
    expect(resolveBranchWinners(rows, { g: "a0" }).get("g")).toBe("a0")
    expect(resolveBranchWinners(rows, {}).get("g")).toBe("a1")
  })

  it("ignores a choice that names no member", () => {
    expect(resolveBranchWinners(rows, { g: "gone" }).get("g")).toBe("a1")
  })
})

describe("visibleThread", () => {
  it("hands back the same list when nothing is branched", () => {
    // Selectors and memos downstream keep their identity across frames.
    const rows = [row("u1", "user"), row("a1", "assistant")]
    expect(visibleThread(rows, {})).toBe(rows)
  })

  it("shows the winner at the first sibling's position", () => {
    const rows = [
      row("u1", "user"),
      row("a0", "assistant", { branchGroupId: "g", branchIndex: 0 }),
      row("x2", "user"),
      row("a1", "assistant", { branchGroupId: "g", branchIndex: 1 }),
    ]
    expect(visibleThread(rows, {}).map((r) => r.id)).toEqual(["u1", "a1", "x2"])
  })

  it("hides what hangs off a hidden sibling, transitively", () => {
    const rows = [
      row("u1", "user", { branchGroupId: "ask", branchIndex: 0 }),
      row("a1", "assistant", { branchOwnerId: "u1" }),
      row("t1", "user", { branchOwnerId: "a1" }),
      row("u2", "user", { branchGroupId: "ask", branchIndex: 1 }),
      row("a2", "assistant", { branchOwnerId: "u2" }),
    ]
    expect(visibleThread(rows, { ask: "u2" }).map((r) => r.id)).toEqual(["u2", "a2"])
    expect(visibleThread(rows, { ask: "u1" }).map((r) => r.id)).toEqual(["u1", "a1", "t1"])
  })
})
