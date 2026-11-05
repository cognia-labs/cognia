import { statusCategoryOf } from "@/types/issues"
import type { Issue, IssueCycle, IssueStatus } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import {
  blockedIssues,
  blockerRows,
  buildPlanningHints,
  childIssues,
  dueState,
  DUE_SOON_WINDOW_MS,
  hasPlanningBadges,
  openBlockers,
  wouldCreateParentLoop,
} from "./planning-hints"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2026-09-06T12:00:00Z").getTime()

let seq = 0
function local(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  seq += 1
  const sourceId = over.sourceId ?? `i${seq}`
  const status: IssueStatus = over.status ?? "todo"
  return {
    unifiedId: `local:${sourceId}`,
    kind: "local",
    sourceId,
    identifier: `MERC-${seq}`,
    title: "t",
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: FULL_ISSUE_CAPABILITIES,
    ...over,
  }
}

function cycle(over: Partial<IssueCycle> = {}): IssueCycle {
  return {
    externalKeys: [],
    id: "c1",
    projectId: "w1",
    kind: "cycle",
    name: "Sprint 1",
    status: "active",
    externalRefs: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe("buildPlanningHints", () => {
  it("marks an issue blocked only by open blockers that exist", () => {
    const done = local({ sourceId: "done", status: "done" })
    const open = local({ sourceId: "open" })
    const target = local({ sourceId: "t", blockedBy: ["done", "open", "ghost"] })
    const hint = buildPlanningHints([done, open, target], new Map(), NOW).get(target.unifiedId)!
    expect(hint.blocked).toBe(true)
    expect(hint.blockerIdentifiers).toEqual([open.identifier])
  })

  it("is not blocked when every blocker is finished or gone", () => {
    const done = local({ sourceId: "done", status: "done" })
    const target = local({ sourceId: "t", blockedBy: ["done", "ghost"] })
    const hint = buildPlanningHints([done, target], new Map(), NOW).get(target.unifiedId)!
    expect(hint.blocked).toBe(false)
    expect(hint.blockerIdentifiers).toEqual([])
  })

  it("counts direct children and their completion on the parent", () => {
    const parent = local({ sourceId: "p" })
    const a = local({ sourceId: "a", parentId: "p", status: "done" })
    const b = local({ sourceId: "b", parentId: "p" })
    const grandchild = local({ sourceId: "g", parentId: "a", status: "done" })
    const hints = buildPlanningHints([parent, a, b, grandchild], new Map(), NOW)
    expect(hints.get(parent.unifiedId)!.subIssues).toEqual({ total: 2, done: 1 })
    expect(hints.get(a.unifiedId)!.subIssues).toEqual({ total: 1, done: 1 })
    expect(hints.get(a.unifiedId)!.parentIdentifier).toBe(parent.identifier)
    expect(hints.get(b.unifiedId)!.subIssues).toBeUndefined()
  })

  it("resolves the cycle name and the due state", () => {
    const item = local({ cycleId: "c1", dueDate: NOW - DAY })
    const hint = buildPlanningHints([item], new Map([["c1", cycle()]]), NOW).get(item.unifiedId)!
    expect(hint.cycleName).toBe("Sprint 1")
    expect(hint.due).toBe("overdue")
  })

  it("builds a hint for federated rows too, without relations", () => {
    const github: UnifiedIssueItem = {
      ...local({ sourceId: "gh" }),
      unifiedId: "github:gh",
      kind: "github",
      capabilities: READ_ONLY_ISSUE_CAPABILITIES,
      blockedBy: ["x"],
    }
    const hint = buildPlanningHints([github], new Map(), NOW).get("github:gh")!
    expect(hint.blocked).toBe(false)
    expect(hint.due).toBe("none")
  })
})

describe("hasPlanningBadges", () => {
  it("is false for a quiet hint and for no hint", () => {
    expect(hasPlanningBadges(undefined)).toBe(false)
    expect(hasPlanningBadges({ blocked: false, blockerIdentifiers: [], due: "later" })).toBe(false)
    expect(hasPlanningBadges({ blocked: false, blockerIdentifiers: [], due: "met" })).toBe(false)
  })

  it("is true when blocked, due soon, or a parent", () => {
    expect(hasPlanningBadges({ blocked: true, blockerIdentifiers: ["A-1"], due: "none" })).toBe(
      true
    )
    expect(hasPlanningBadges({ blocked: false, blockerIdentifiers: [], due: "soon" })).toBe(true)
    expect(
      hasPlanningBadges({
        blocked: false,
        blockerIdentifiers: [],
        due: "none",
        subIssues: { total: 2, done: 0 },
      })
    ).toBe(true)
  })
})

// ── relation reads (moved from relations.ts) ────────────────────────────────

function issue(over: Partial<Issue> & { id: string }): Issue {
  const status = over.status ?? "todo"
  return {
    identifier: over.id.toUpperCase(),
    number: 1,
    projectId: "w1",
    issueProjectId: "p1",
    title: over.id,
    status,
    statusCategory: statusCategoryOf(status),
    priority: "none",
    createdBy: { kind: "human" },
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const byId = (rows: Issue[]) => new Map(rows.map((row) => [row.id, row]))

describe("blockers", () => {
  it("lists only open, existing blockers", () => {
    const rows = [
      issue({ id: "a" }),
      issue({ id: "b", status: "done" }),
      issue({ id: "c", status: "canceled" }),
    ]
    const target = issue({ id: "t", blockedBy: ["a", "b", "c", "ghost"] })
    expect(openBlockers(target, byId(rows)).map((row) => row.id)).toEqual(["a"])
    expect(openBlockers(issue({ id: "u", blockedBy: ["b"] }), byId(rows))).toEqual([])
    expect(openBlockers(issue({ id: "v" }), byId(rows))).toEqual([])
  })

  it("lists every present blocker for the panel, finished ones included, in order", () => {
    const rows = [issue({ id: "a" }), issue({ id: "b", status: "done" })]
    const target = issue({ id: "t", blockedBy: ["b", "ghost", "a"] })
    expect(blockerRows(target, byId(rows)).map((row) => row.id)).toEqual(["b", "a"])
    expect(blockerRows(issue({ id: "u" }), byId(rows))).toEqual([])
  })

  it("derives the blocks side", () => {
    const rows = [issue({ id: "a" }), issue({ id: "b", blockedBy: ["a"] }), issue({ id: "c" })]
    expect(blockedIssues("a", rows).map((row) => row.id)).toEqual(["b"])
  })
})

describe("hierarchy", () => {
  it("lists direct children only", () => {
    const rows = [
      issue({ id: "p" }),
      issue({ id: "a", parentId: "p", status: "done" }),
      issue({ id: "b", parentId: "p" }),
      issue({ id: "g", parentId: "a", status: "done" }),
    ]
    expect(childIssues("p", rows).map((row) => row.id)).toEqual(["a", "b"])
    expect(childIssues("b", rows)).toEqual([])
  })

  it("detects a parent loop before the write refuses it", () => {
    const rows = [
      issue({ id: "a" }),
      issue({ id: "b", parentId: "a" }),
      issue({ id: "c", parentId: "b" }),
    ]
    const map = byId(rows)
    expect(wouldCreateParentLoop("a", "a", map)).toBe(true)
    expect(wouldCreateParentLoop("a", "c", map)).toBe(true)
    expect(wouldCreateParentLoop("c", "a", map)).toBe(false)
    expect(wouldCreateParentLoop("a", "ghost", map)).toBe(false)
  })
})

describe("dueState", () => {
  const now = new Date("2026-09-06T15:00:00").getTime()

  it("reads the calendar, not the clock", () => {
    expect(dueState(issue({ id: "x" }), now)).toBe("none")
    expect(dueState(issue({ id: "x", dueDate: now - 2 * DAY }), now)).toBe("overdue")
    expect(dueState(issue({ id: "x", dueDate: now - 60_000 }), now)).toBe("today")
    expect(dueState(issue({ id: "x", dueDate: now + 60_000 }), now)).toBe("today")
    expect(dueState(issue({ id: "x", dueDate: now + DUE_SOON_WINDOW_MS - 1 }), now)).toBe("soon")
    expect(dueState(issue({ id: "x", dueDate: now + 30 * DAY }), now)).toBe("later")
  })

  it("never shouts overdue on a finished issue", () => {
    expect(dueState(issue({ id: "x", dueDate: now - 5 * DAY, status: "done" }), now)).toBe("met")
    expect(dueState(issue({ id: "x", dueDate: now - 5 * DAY, status: "canceled" }), now)).toBe(
      "met"
    )
  })
})
