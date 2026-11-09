import {
  allowedMoveTargets,
  canMoveTask,
  reorderColumn,
  sortColumn,
  type TaskMoveDenial,
} from "./task-move-guard"
import type { TeamStatus, TeamTaskStatus } from "@/types/agent/agent-team"

const ALL: TeamTaskStatus[] = [
  "pending",
  "blocked",
  "claimed",
  "in_progress",
  "review",
  "completed",
  "failed",
  "cancelled",
]

const task = { id: "t1", dependencies: [] as string[] }

/**
 * Full expected matrix while the team is AT REST (idle / paused / terminal).
 * `undefined` = allowed; otherwise the expected denial reason.
 */
const AT_REST: Record<TeamTaskStatus, Partial<Record<TeamTaskStatus, TaskMoveDenial>>> = {
  pending: {
    blocked: "blocked-column",
    claimed: "illegal-transition",
    in_progress: "illegal-transition",
    review: "illegal-transition",
    completed: "illegal-transition",
    failed: "illegal-transition",
    // cancelled: allowed
  },
  blocked: {
    pending: "blocked-column",
    claimed: "blocked-column",
    in_progress: "blocked-column",
    review: "blocked-column",
    completed: "blocked-column",
    failed: "blocked-column",
    cancelled: "blocked-column",
  },
  claimed: {
    // pending: allowed (unstrand at rest)
    blocked: "blocked-column",
    in_progress: "illegal-transition",
    review: "illegal-transition",
    completed: "illegal-transition",
    failed: "illegal-transition",
    cancelled: "illegal-transition",
  },
  in_progress: {
    // pending: allowed (unstrand at rest)
    blocked: "blocked-column",
    claimed: "illegal-transition",
    review: "illegal-transition",
    completed: "illegal-transition",
    failed: "illegal-transition",
    cancelled: "illegal-transition",
  },
  review: {
    pending: "illegal-transition",
    blocked: "blocked-column",
    claimed: "illegal-transition",
    in_progress: "illegal-transition",
    // completed: allowed (verdict)
    // failed: allowed (verdict)
    cancelled: "illegal-transition",
  },
  completed: {
    pending: "illegal-transition",
    blocked: "blocked-column",
    claimed: "illegal-transition",
    in_progress: "illegal-transition",
    review: "illegal-transition",
    failed: "illegal-transition",
    cancelled: "illegal-transition",
  },
  failed: {
    // pending: allowed (manual retry)
    blocked: "blocked-column",
    claimed: "illegal-transition",
    in_progress: "illegal-transition",
    review: "illegal-transition",
    completed: "illegal-transition",
    cancelled: "illegal-transition",
  },
  cancelled: {
    pending: "illegal-transition",
    blocked: "blocked-column",
    claimed: "illegal-transition",
    in_progress: "illegal-transition",
    review: "illegal-transition",
    completed: "illegal-transition",
    failed: "illegal-transition",
  },
}

describe("canMoveTask", () => {
  const restStatuses: TeamStatus[] = ["idle", "paused", "completed", "failed", "cancelled"]
  const activeStatuses: TeamStatus[] = ["planning", "executing"]

  it.each(restStatuses)("full 8×8 matrix at rest (team %s)", (teamStatus) => {
    for (const from of ALL) {
      for (const to of ALL) {
        const verdict = canMoveTask(task, from, to, teamStatus)
        if (from === to) {
          expect(verdict).toEqual({ allowed: true })
          continue
        }
        const expected = AT_REST[from][to]
        if (expected === undefined) {
          expect({ from, to, verdict }).toEqual({ from, to, verdict: { allowed: true } })
        } else {
          expect({ from, to, verdict }).toEqual({
            from,
            to,
            verdict: { allowed: false, reason: expected },
          })
        }
      }
    }
  })

  it.each(activeStatuses)(
    "locks runtime-owned columns while the run is active (team %s)",
    (teamStatus) => {
      // Dragging OUT of claimed/in_progress is denied wholesale.
      for (const from of ["claimed", "in_progress"] as const) {
        for (const to of ALL.filter((s) => s !== from)) {
          const verdict = canMoveTask(task, from, to, teamStatus)
          expect(verdict.allowed).toBe(false)
          const reason = (verdict as { reason: TaskMoveDenial }).reason
          expect(["runtime-owned", "blocked-column"]).toContain(reason)
        }
      }
      // Dragging INTO them is denied as runtime-owned (blocked stays blocked-column).
      expect(canMoveTask(task, "pending", "claimed", teamStatus)).toEqual({
        allowed: false,
        reason: "runtime-owned",
      })
      expect(canMoveTask(task, "pending", "in_progress", teamStatus)).toEqual({
        allowed: false,
        reason: "runtime-owned",
      })
      // Human-owned transitions stay available mid-run (the board's core value:
      // review verdicts + retries while the team works).
      expect(canMoveTask(task, "pending", "cancelled", teamStatus).allowed).toBe(true)
      expect(canMoveTask(task, "review", "completed", teamStatus).allowed).toBe(true)
      expect(canMoveTask(task, "review", "failed", teamStatus).allowed).toBe(true)
      expect(canMoveTask(task, "failed", "pending", teamStatus).allowed).toBe(true)
    }
  )

  it("same-column moves are always allowed (reorder), even in blocked", () => {
    for (const status of ALL) {
      expect(canMoveTask(task, status, status, "executing").allowed).toBe(true)
    }
  })
})

describe("allowedMoveTargets", () => {
  it("excludes the current column and mirrors canMoveTask", () => {
    expect(allowedMoveTargets({ ...task, status: "failed" }, "idle")).toEqual(["pending"])
    expect(allowedMoveTargets({ ...task, status: "review" }, "executing")).toEqual([
      "completed",
      "failed",
    ])
    expect(allowedMoveTargets({ ...task, status: "blocked" }, "idle")).toEqual([])
    expect(allowedMoveTargets({ ...task, status: "claimed" }, "executing")).toEqual([])
    expect(allowedMoveTargets({ ...task, status: "claimed" }, "paused")).toEqual(["pending"])
    expect(allowedMoveTargets({ ...task, status: "pending" }, "idle")).toEqual(["cancelled"])
  })
})

describe("reorderColumn", () => {
  const col = [
    { id: "a", order: 0 },
    { id: "b", order: 1 },
    { id: "c", order: 2 },
  ]

  it("moves a task down and renumbers only changed rows", () => {
    expect(reorderColumn(col, "a", 2)).toEqual([
      { id: "b", order: 0 },
      { id: "c", order: 1 },
      { id: "a", order: 2 },
    ])
  })

  it("moves a task up", () => {
    expect(reorderColumn(col, "c", 0)).toEqual([
      { id: "c", order: 0 },
      { id: "a", order: 1 },
      { id: "b", order: 2 },
    ])
  })

  it("no-ops for unknown ids", () => {
    expect(reorderColumn(col, "zz", 0)).toEqual([])
  })

  it("no-ops when the position doesn't change and orders are already dense", () => {
    expect(reorderColumn(col, "b", 1)).toEqual([])
  })

  it("clamps out-of-range target indexes", () => {
    expect(reorderColumn(col, "a", 99)).toEqual([
      { id: "b", order: 0 },
      { id: "c", order: 1 },
      { id: "a", order: 2 },
    ])
    expect(reorderColumn(col, "c", -5)).toEqual([
      { id: "c", order: 0 },
      { id: "a", order: 1 },
      { id: "b", order: 2 },
    ])
  })

  it("re-densifies sparse orders even on a same-position drop", () => {
    const sparse = [
      { id: "a", order: 0 },
      { id: "b", order: 5 },
      { id: "c", order: 9 },
    ]
    expect(reorderColumn(sparse, "b", 1)).toEqual([
      { id: "b", order: 1 },
      { id: "c", order: 2 },
    ])
  })
})

describe("sortColumn", () => {
  it("sorts by order, then createdAt, then id", () => {
    const now = Date.now()
    const rows = [
      { id: "b", order: 1, createdAt: new Date(now) },
      { id: "a", order: 0, createdAt: new Date(now) },
      { id: "d", order: 1, createdAt: new Date(now - 1000) },
      { id: "c", order: 1, createdAt: new Date(now) },
    ]
    expect(sortColumn(rows).map((r) => r.id)).toEqual(["a", "d", "b", "c"])
  })
})

/**
 * Characterization: the full transition table, frozen from the hand-written
 * guard before it moved onto `lib/board/move-guard.ts`. Rows are `from`,
 * columns follow `ALL`; "ok" is allowed, anything else is the denial reason.
 */
describe("canMoveTask transition table", () => {
  type Cell = "ok" | TaskMoveDenial
  const B = "blocked-column"
  const R = "runtime-owned"
  const I = "illegal-transition"
  const ACTIVE: Record<TeamTaskStatus, Cell[]> = {
    pending: ["ok", B, R, R, I, I, I, "ok"],
    blocked: [B, "ok", B, B, B, B, B, B],
    claimed: [R, B, "ok", R, R, R, R, R],
    in_progress: [R, B, R, "ok", R, R, R, R],
    review: [I, B, R, R, "ok", "ok", "ok", I],
    completed: [I, B, R, R, I, "ok", I, I],
    failed: ["ok", B, R, R, I, I, "ok", I],
    cancelled: [I, B, R, R, I, I, I, "ok"],
  }
  const AT_REST: Record<TeamTaskStatus, Cell[]> = {
    pending: ["ok", B, I, I, I, I, I, "ok"],
    blocked: [B, "ok", B, B, B, B, B, B],
    claimed: ["ok", B, "ok", I, I, I, I, I],
    in_progress: ["ok", B, I, "ok", I, I, I, I],
    review: [I, B, I, I, "ok", "ok", "ok", I],
    completed: [I, B, I, I, I, "ok", I, I],
    failed: ["ok", B, I, I, I, I, "ok", I],
    cancelled: [I, B, I, I, I, I, I, "ok"],
  }
  const TEAM_STATUSES: TeamStatus[] = [
    "idle",
    "planning",
    "executing",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]
  const cell = (from: TeamTaskStatus, to: TeamTaskStatus, teamStatus: TeamStatus): Cell => {
    const verdict = canMoveTask({ id: "t", dependencies: [] }, from, to, teamStatus)
    return verdict.allowed ? "ok" : verdict.reason
  }

  it.each(TEAM_STATUSES)("matches the frozen table while the team is %s", (teamStatus) => {
    const expected = teamStatus === "planning" || teamStatus === "executing" ? ACTIVE : AT_REST
    for (const from of ALL) {
      expect([from, ALL.map((to) => cell(from, to, teamStatus))]).toEqual([from, expected[from]])
    }
  })
})
