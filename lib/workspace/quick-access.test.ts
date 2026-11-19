import {
  pinnedWorkspaces,
  recentWorkspaces,
  RECENT_WORKSPACE_COUNT,
  workspaceShortcuts,
} from "./quick-access"

const at = (day: number) => new Date(Date.UTC(2026, 10, day))
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id.toUpperCase(),
  lastAccessedAt: at(1),
  ...over,
})

describe("pinnedWorkspaces", () => {
  it("keeps only pinned rows, by name", () => {
    const rows = [row("c", { pinned: true }), row("a", { pinned: true }), row("b")]
    expect(pinnedWorkspaces(rows).map((r) => r.id)).toEqual(["a", "c"])
  })
})

describe("recentWorkspaces", () => {
  it("orders by last use, newest first, and caps the list", () => {
    const rows = [
      row("a", { lastAccessedAt: at(2) }),
      row("b", { lastAccessedAt: at(9) }),
      row("c", { lastAccessedAt: at(5) }),
      row("d", { lastAccessedAt: at(7) }),
    ]
    expect(RECENT_WORKSPACE_COUNT).toBe(3)
    expect(recentWorkspaces(rows).map((r) => r.id)).toEqual(["b", "d", "c"])
    expect(recentWorkspaces(rows, { count: 1 }).map((r) => r.id)).toEqual(["b"])
  })

  it("reads a persisted ISO string and sorts an unreadable date as never used", () => {
    const rows = [
      row("broken", { lastAccessedAt: "not a date" }),
      row("iso", { lastAccessedAt: at(4).toISOString() }),
      row("never", { lastAccessedAt: undefined }),
      row("date", { lastAccessedAt: at(3) }),
    ]
    // The two without a usable date keep the order they came in.
    expect(recentWorkspaces(rows, { count: 4 }).map((r) => r.id)).toEqual([
      "iso",
      "date",
      "broken",
      "never",
    ])
  })

  it("skips excluded rows before counting", () => {
    const rows = [row("a", { lastAccessedAt: at(9) }), row("b", { lastAccessedAt: at(5) })]
    expect(recentWorkspaces(rows, { count: 1, exclude: (r) => r.id === "a" })).toEqual([rows[1]])
  })
})

describe("workspaceShortcuts", () => {
  it("lists pinned workspaces, then recent ones that are not pinned", () => {
    const rows = [
      row("p2", { pinned: true, lastAccessedAt: at(9) }),
      row("p1", { pinned: true, lastAccessedAt: at(1) }),
      row("r1", { lastAccessedAt: at(8) }),
      row("r2", { lastAccessedAt: at(6) }),
      row("r3", { lastAccessedAt: at(4) }),
      row("r4", { lastAccessedAt: at(2) }),
    ]
    const { pinned, recent } = workspaceShortcuts(rows, null)
    expect(pinned.map((r) => r.id)).toEqual(["p1", "p2"])
    expect(recent.map((r) => r.id)).toEqual(["r1", "r2", "r3"])
  })

  it("leaves out the active workspace and archived ones, pinned or not", () => {
    const rows = [
      row("here", { pinned: true, lastAccessedAt: at(9) }),
      row("old", { isArchived: true, pinned: true }),
      row("gone", { isArchived: true, lastAccessedAt: at(8) }),
      row("next", { lastAccessedAt: at(3) }),
    ]
    expect(workspaceShortcuts(rows, "here")).toEqual({ pinned: [], recent: [rows[3]] })
  })

  it("has nothing to offer when the only workspace is the active one", () => {
    expect(workspaceShortcuts([row("only")], "only")).toEqual({ pinned: [], recent: [] })
  })
})
