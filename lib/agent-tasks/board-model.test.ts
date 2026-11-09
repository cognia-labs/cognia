import type { AgentTask } from "@/types/agent/agent-task"
import {
  AGENT_TASK_BOARD_COLUMN_ORDER,
  buildAgentTaskColumns,
  reorderAgentTaskColumn,
  resolveAgentTaskDrop,
  resolveAgentTaskDropPreview,
  sortAgentTaskColumn,
} from "./board-model"

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    agentId: "agent-1",
    title: id,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    order: 0,
    approvalPolicy: "on-risk",
    latestAttemptNo: 0,
    comments: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

const byId = (tasks: AgentTask[]) => new Map(tasks.map((t) => [t.id, t]))

const tasks = [
  task("p1", { order: 0, updatedAt: 5 }),
  task("p2", { order: 1, updatedAt: 1 }),
  task("p3", { order: 2, updatedAt: 1 }),
  task("run", { status: "in_progress" }),
  task("rev", { status: "review" }),
  task("done", { status: "completed" }),
  task("other", { agentId: "agent-2", order: 0 }),
]
const map = byId(tasks)

describe("agent task columns", () => {
  it("has the guard's eight statuses in board order", () => {
    expect(AGENT_TASK_BOARD_COLUMN_ORDER).toEqual([
      "pending",
      "blocked",
      "in_progress",
      "review",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ])
  })

  it("orders a column by order, then last update, then id", () => {
    expect(
      sortAgentTaskColumn([
        task("b", { updatedAt: 3 }),
        task("a", { updatedAt: 3 }),
        task("z", { updatedAt: 1 }),
        task("y", { order: -1, updatedAt: 9 }),
      ]).map((t) => t.id)
    ).toEqual(["y", "z", "a", "b"])
  })

  it("always yields every column, each sorted", () => {
    const columns = buildAgentTaskColumns(tasks)
    expect(columns.map((column) => column.status)).toEqual(AGENT_TASK_BOARD_COLUMN_ORDER)
    expect(columns[0].tasks.map((t) => t.id)).toEqual(["other", "p1", "p2", "p3"])
    expect(columns.find((column) => column.status === "paused")?.tasks).toEqual([])
  })
})

describe("resolveAgentTaskDrop", () => {
  it("reorders within the Agent's own column", () => {
    expect(resolveAgentTaskDrop("p1", "p3", map)).toEqual({
      type: "reorder",
      itemId: "p1",
      targetIndex: 2,
    })
    expect(resolveAgentTaskDrop("p1", "other", map)).toBeNull()
  })

  it("moves where a person may, and denies with the guard's reason elsewhere", () => {
    expect(resolveAgentTaskDrop("run", "col:paused", map)).toEqual({
      type: "move",
      itemId: "run",
      to: "paused",
      targetIndex: 0,
    })
    expect(resolveAgentTaskDrop("rev", "done", map)).toEqual({
      type: "move",
      itemId: "rev",
      to: "completed",
      targetIndex: 0,
    })
    expect(resolveAgentTaskDrop("p1", "col:in_progress", map)).toEqual({
      type: "denied",
      itemId: "p1",
      reason: "runtime-owned",
    })
    expect(resolveAgentTaskDrop("p1", "col:blocked", map)).toEqual({
      type: "denied",
      itemId: "p1",
      reason: "dependency-owned",
    })
    expect(resolveAgentTaskDrop("done", "col:pending", map)).toEqual({
      type: "denied",
      itemId: "done",
      reason: "illegal-transition",
    })
  })
})

describe("resolveAgentTaskDropPreview", () => {
  it("marks a legal target and nothing on a refusing one", () => {
    expect(resolveAgentTaskDropPreview("run", "col:cancelled", map)).toEqual({
      status: "cancelled",
      index: 0,
    })
    expect(resolveAgentTaskDropPreview("p1", "col:review", map)).toBeNull()
  })
})

describe("reorderAgentTaskColumn", () => {
  it("renumbers the Agent's column as the board shows it", () => {
    expect(reorderAgentTaskColumn(map, "p3", 0)).toEqual([
      { id: "p3", order: 0 },
      { id: "p1", order: 1 },
      { id: "p2", order: 2 },
    ])
  })

  it("is a no-op for an unknown task", () => {
    expect(reorderAgentTaskColumn(map, "missing", 0)).toEqual([])
  })
})
