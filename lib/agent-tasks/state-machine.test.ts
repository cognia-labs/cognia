import type { AgentTaskStatus } from "@/types/agent/agent-task"
import {
  allowedAgentTaskMoves,
  deriveDependencyStatus,
  guardAgentTaskMove,
  type AgentTaskMoveDenial,
} from "./state-machine"

describe("single-Agent task state machine", () => {
  it("keeps dependency blocking machine-owned", () => {
    expect(guardAgentTaskMove("pending", "blocked")).toEqual({
      allowed: false,
      reason: "dependency-owned",
    })
    expect(guardAgentTaskMove("blocked", "pending")).toEqual({
      allowed: false,
      reason: "dependency-owned",
    })
  })

  it("allows only explicit human-owned board moves", () => {
    expect(allowedAgentTaskMoves("pending")).toEqual(["cancelled"])
    expect(allowedAgentTaskMoves("in_progress")).toEqual(["paused", "cancelled"])
    expect(allowedAgentTaskMoves("review")).toEqual(["completed", "failed"])
    expect(allowedAgentTaskMoves("failed")).toEqual(["pending", "cancelled"])
    expect(allowedAgentTaskMoves("paused")).toEqual(["pending", "cancelled"])
    expect(allowedAgentTaskMoves("completed")).toEqual([])
  })

  it("derives blocked and unblocked states from dependency completion", () => {
    expect(deriveDependencyStatus("pending", ["completed", "in_progress"])).toBe("blocked")
    expect(deriveDependencyStatus("blocked", ["completed", "completed"])).toBe("pending")
    expect(deriveDependencyStatus("in_progress", ["failed"])).toBe("in_progress")
  })
})

/**
 * Characterization: the full transition table, frozen from the hand-written
 * guard before it moved onto `lib/board/move-guard.ts`. Rows are `from`,
 * columns follow `ALL`; "ok" is allowed, anything else is the denial reason.
 */
describe("guardAgentTaskMove transition table", () => {
  const ALL: AgentTaskStatus[] = [
    "pending",
    "blocked",
    "in_progress",
    "review",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]
  type Cell = "ok" | AgentTaskMoveDenial
  const D = "dependency-owned"
  const R = "runtime-owned"
  const I = "illegal-transition"
  const TABLE: Record<AgentTaskStatus, Cell[]> = {
    pending: ["ok", D, R, R, I, I, I, "ok"],
    blocked: [D, "ok", D, D, D, D, D, D],
    in_progress: [I, D, "ok", R, "ok", I, I, "ok"],
    review: [I, D, R, "ok", I, "ok", "ok", I],
    paused: ["ok", D, R, R, "ok", I, I, "ok"],
    completed: [I, D, R, R, I, "ok", I, I],
    failed: ["ok", D, R, R, I, I, "ok", "ok"],
    cancelled: [I, D, R, R, I, I, I, "ok"],
  }

  it.each(ALL)("matches the frozen row for %s", (from) => {
    const row = ALL.map((to) => {
      const verdict = guardAgentTaskMove(from, to)
      return verdict.allowed ? "ok" : verdict.reason
    })
    expect(row).toEqual(TABLE[from])
  })

  it("lists exactly the allowed targets other than the own column", () => {
    for (const from of ALL) {
      expect(allowedAgentTaskMoves(from)).toEqual(
        ALL.filter((to, index) => to !== from && TABLE[from][index] === "ok")
      )
    }
  })
})
