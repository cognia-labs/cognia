import type { Issue, IssueStatus } from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import {
  computeProgress,
  computeProgressFromIssues,
  cycleProgress,
  EMPTY_ISSUE_PROJECT_PROGRESS,
} from "./project-progress"

const row = (status: IssueStatus, issueProjectId?: string) => ({ status, issueProjectId })

describe("computeProgress", () => {
  it("returns a zeroed tally for no issues, not NaN", () => {
    expect(computeProgress([])).toEqual(EMPTY_ISSUE_PROJECT_PROGRESS)
  })

  it("counts every issue in total, cancelled included", () => {
    expect(computeProgress([row("done"), row("canceled"), row("todo")]).total).toBe(3)
  })

  it("excludes cancelled issues from the denominator", () => {
    expect(computeProgress([row("done"), row("canceled")]).denominator).toBe(1)
  })

  it("measures ratio against the denominator, so cancelling scope is not lost ground", () => {
    // One done, one cancelled: the project is finished, not half finished.
    expect(computeProgress([row("done"), row("canceled")]).ratio).toBe(1)
  })

  it("counts started as in_progress and in_review only, not backlog", () => {
    const progress = computeProgress([
      row("backlog"),
      row("todo"),
      row("in_progress"),
      row("in_review"),
    ])
    expect(progress.started).toBe(2)
  })

  it("reports cancelled separately", () => {
    expect(computeProgress([row("canceled"), row("canceled")]).canceled).toBe(2)
  })

  it("is 0 rather than NaN for an all-cancelled container", () => {
    expect(computeProgress([row("canceled")]).ratio).toBe(0)
  })
})

describe("computeProgressFromIssues", () => {
  it("gives an empty container a zeroed entry rather than dropping it", () => {
    const result = computeProgressFromIssues(["p1"], [])
    expect(result.get("p1")).toEqual(EMPTY_ISSUE_PROJECT_PROGRESS)
  })

  it("keeps containers apart", () => {
    const result = computeProgressFromIssues(
      ["p1", "p2"],
      [row("done", "p1"), row("todo", "p2"), row("todo", "p2")]
    )
    expect(result.get("p1")?.completed).toBe(1)
    expect(result.get("p2")?.total).toBe(2)
    expect(result.get("p2")?.completed).toBe(0)
  })

  it("ignores issues with no container", () => {
    const result = computeProgressFromIssues(["p1"], [row("done"), row("done", "p1")])
    expect(result.get("p1")?.total).toBe(1)
  })

  it("ignores issues pointing at a container it was not asked about", () => {
    const result = computeProgressFromIssues(["p1"], [row("done", "p9")])
    expect(result.get("p1")).toEqual(EMPTY_ISSUE_PROJECT_PROGRESS)
    expect(result.has("p9")).toBe(false)
  })

  it("agrees with the single-list tally", () => {
    const issues = [row("done", "p1"), row("canceled", "p1"), row("in_progress", "p1")]
    expect(computeProgressFromIssues(["p1"], issues).get("p1")).toEqual(
      computeProgress(issues.map((issue) => ({ status: issue.status })))
    )
  })
})

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

describe("cycleProgress", () => {
  it("sums counts and points for one cycle only", () => {
    const rows = [
      issue({ id: "a", cycleId: "c1", estimate: 3, status: "done" }),
      issue({ id: "b", cycleId: "c1", estimate: 5 }),
      issue({ id: "c", cycleId: "c1" }),
      issue({ id: "d", cycleId: "c2", estimate: 8 }),
    ]
    expect(cycleProgress("c1", rows)).toEqual({ total: 3, done: 1, points: 8, pointsDone: 3 })
    expect(cycleProgress("zzz", rows)).toEqual({ total: 0, done: 0, points: 0, pointsDone: 0 })
  })
})
