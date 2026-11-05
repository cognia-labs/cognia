import type { AgentTaskStatus } from "@/types/agent/agent-task"
import type { TeamTaskStatus } from "@/types/agent/agent-team"
import { ISSUE_PRIORITIES } from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import {
  agentTaskPriorityToIssuePriority,
  agentTaskStatusToIssueStatus,
  issuePriorityToAgentTaskPriority,
  issuePriorityToSubAgentPriority,
  subAgentPriorityToIssuePriority,
  teamTaskStatusToIssueStatus,
} from "./agent-status-map"

describe("agentTaskStatusToIssueStatus", () => {
  it.each<[AgentTaskStatus, string]>([
    ["pending", "backlog"],
    ["blocked", "todo"],
    ["in_progress", "in_progress"],
    ["paused", "in_progress"],
    ["review", "in_review"],
    ["completed", "done"],
    ["failed", "canceled"],
    ["cancelled", "canceled"],
  ])("%s → %s", (from, to) => {
    expect(agentTaskStatusToIssueStatus(from)).toBe(to)
  })

  it("keeps failed out of the completed category so progress bars stay honest", () => {
    expect(statusCategoryOf(agentTaskStatusToIssueStatus("failed"))).toBe("canceled")
    expect(statusCategoryOf(agentTaskStatusToIssueStatus("completed"))).toBe("completed")
  })
})

describe("teamTaskStatusToIssueStatus", () => {
  it.each<[TeamTaskStatus, string]>([
    ["pending", "backlog"],
    ["blocked", "todo"],
    ["claimed", "todo"],
    ["in_progress", "in_progress"],
    ["review", "in_review"],
    ["completed", "done"],
    ["failed", "canceled"],
    ["cancelled", "canceled"],
  ])("%s → %s", (from, to) => {
    expect(teamTaskStatusToIssueStatus(from)).toBe(to)
  })
})

describe("priority projections", () => {
  it("reads an engine's own priorities, its default as no priority", () => {
    expect(agentTaskPriorityToIssuePriority("critical")).toBe("urgent")
    expect(agentTaskPriorityToIssuePriority("high")).toBe("high")
    expect(agentTaskPriorityToIssuePriority("normal")).toBe("none")
    expect(agentTaskPriorityToIssuePriority("low")).toBe("low")
    expect(subAgentPriorityToIssuePriority("critical")).toBe("urgent")
    expect(subAgentPriorityToIssuePriority("normal")).toBe("none")
    expect(subAgentPriorityToIssuePriority("background")).toBe("none")
  })

  it.each(ISSUE_PRIORITIES)("carries %s to both engines and back unchanged", (priority) => {
    const task = issuePriorityToAgentTaskPriority(priority)
    expect(agentTaskPriorityToIssuePriority(task, priority)).toBe(priority)
    const team = issuePriorityToSubAgentPriority(priority)
    expect(subAgentPriorityToIssuePriority(team, priority)).toBe(priority)
  })

  it("sends both medium and none as the engine default", () => {
    expect(issuePriorityToAgentTaskPriority("medium")).toBe("normal")
    expect(issuePriorityToAgentTaskPriority("none")).toBe("normal")
    expect(issuePriorityToAgentTaskPriority("urgent")).toBe("critical")
    expect(issuePriorityToSubAgentPriority("low")).toBe("low")
  })

  it("ignores an origin priority the engine's value no longer matches", () => {
    // The issue went urgent after dispatch; the task still says normal.
    expect(agentTaskPriorityToIssuePriority("normal", "urgent")).toBe("none")
    expect(subAgentPriorityToIssuePriority("high", "medium")).toBe("high")
    expect(subAgentPriorityToIssuePriority("background", "medium")).toBe("none")
  })
})
