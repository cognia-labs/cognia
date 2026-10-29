import type { AgentPlan, PlanStep } from "@/types/agent/plan"

import {
  acpEntriesToTaskItems,
  isSettledTaskStatus,
  planStepStatusToTask,
  planStepsToTaskItems,
  summarizeTasks,
  taskItemLabel,
  withStoppedItems,
  type TaskViewItem,
} from "./task-view"

const item = (id: string, status: TaskViewItem["status"], extra: Partial<TaskViewItem> = {}) => ({
  id,
  title: id,
  status,
  ...extra,
})

describe("summarizeTasks", () => {
  it("counts settled items and picks the running one as current", () => {
    const summary = summarizeTasks([
      item("a", "completed"),
      item("b", "skipped"),
      item("c", "pending"),
      item("d", "in_progress"),
    ])
    expect(summary).toMatchObject({ done: 2, total: 4, fraction: 0.5, allDone: false })
    expect(summary.current?.id).toBe("d")
  })

  it("falls back to the next pending item, and to null when all are done", () => {
    expect(summarizeTasks([item("a", "completed"), item("b", "pending")]).current?.id).toBe("b")
    const done = summarizeTasks([item("a", "completed")])
    expect(done.current).toBeNull()
    expect(done.allDone).toBe(true)
  })

  it("treats a stopped item as current", () => {
    expect(summarizeTasks([item("a", "pending"), item("b", "stopped")]).current?.id).toBe("b")
  })

  it("handles an empty list", () => {
    expect(summarizeTasks([])).toEqual({
      done: 0,
      total: 0,
      fraction: 0,
      current: null,
      allDone: false,
    })
  })
})

describe("isSettledTaskStatus", () => {
  it.each([
    ["completed", true],
    ["skipped", true],
    ["cancelled", true],
    ["failed", false],
    ["stopped", false],
    ["pending", false],
  ] as const)("%s → %s", (status, settled) => {
    expect(isSettledTaskStatus(status)).toBe(settled)
  })
})

describe("taskItemLabel", () => {
  it("uses the active form only while running", () => {
    expect(taskItemLabel(item("a", "in_progress", { activeForm: "Doing a" }))).toBe("Doing a")
    expect(taskItemLabel(item("a", "stopped", { activeForm: "Doing a" }))).toBe("a")
  })
})

describe("withStoppedItems", () => {
  const items = [item("a", "completed"), item("b", "in_progress")]
  it("keeps the list while the run is running", () => {
    expect(withStoppedItems(items, true)).toBe(items)
  })
  it("marks in-progress items stopped once the run ended", () => {
    expect(withStoppedItems(items, false).map((i) => i.status)).toEqual(["completed", "stopped"])
  })
  it("returns the same array when nothing is in progress", () => {
    const settled = [item("a", "completed")]
    expect(withStoppedItems(settled, false)).toBe(settled)
  })
})

describe("plan adapters", () => {
  it("maps every plan step status", () => {
    expect(planStepStatusToTask("ready")).toBe("pending")
    expect(planStepStatusToTask("blocked")).toBe("blocked")
    expect(planStepStatusToTask("failed")).toBe("failed")
  })

  it("orders steps and carries a failed step's error", () => {
    const steps = [
      { id: "s2", title: "Second", order: 1, status: "failed", error: "boom" },
      { id: "s1", title: "First", order: 0, status: "completed" },
    ] as unknown as PlanStep[]
    expect(planStepsToTaskItems({ steps } as Pick<AgentPlan, "steps">)).toEqual([
      { id: "s1", title: "First", status: "completed" },
      { id: "s2", title: "Second", status: "failed", detail: "boom" },
    ])
  })

  it("maps ACP entries positionally", () => {
    expect(
      acpEntriesToTaskItems([
        { content: "x", priority: "high", status: "skipped" },
        { content: "y", priority: "low", status: "in_progress" },
      ])
    ).toEqual([
      { id: "acp-0", title: "x", status: "skipped" },
      { id: "acp-1", title: "y", status: "in_progress" },
    ])
  })
})
