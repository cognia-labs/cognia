/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { renderHook } from "@testing-library/react"
import type { IssueGroupBy } from "@/lib/issues/board-model"
import { useIssueGroupLabel } from "./use-issue-group-label"

function labelFor(
  groupBy: IssueGroupBy,
  key: string,
  sources: Parameters<typeof useIssueGroupLabel>[1] = {}
) {
  return renderHook(() => useIssueGroupLabel(groupBy, sources)).result.current(key)
}

describe("useIssueGroupLabel", () => {
  it("names the catch-all group per axis", () => {
    expect(labelFor("assignee", "")).toBe("actor.unassigned")
    expect(labelFor("project", "")).toBe("toolbar.groupBy.none")
    expect(labelFor("priority", "")).toBe("toolbar.groupBy.none")
  })

  it("localizes status and priority keys", () => {
    expect(labelFor("status", "in_review")).toBe("status.in_review")
    expect(labelFor("priority", "urgent")).toBe("priority.urgent")
  })

  it("resolves a container name, falling back to its id", () => {
    const projectNamesById = new Map([["p1", "Mercury"]])
    expect(labelFor("project", "p1", { projectNamesById })).toBe("Mercury")
    expect(labelFor("project", "p2", { projectNamesById })).toBe("p2")
  })

  it("names an assignee, never by raw id", () => {
    const assigneeLabels = new Map([["agent:a1", "Reviewer"]])
    expect(labelFor("assignee", "human:self")).toBe("actor.human")
    expect(labelFor("assignee", "agent:a1", { assigneeLabels })).toBe("Reviewer")
    expect(labelFor("assignee", "team:t9")).toBe("actor.team")
  })

  it("returns the key for an axis with no label of its own", () => {
    expect(labelFor("none", "x")).toBe("x")
  })
})
