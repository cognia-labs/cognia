import type { TaskExecution } from "@/types/scheduler"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import {
  filterRunsByKind,
  taskExecutionKind,
  toUnifiedFromTaskExecution,
  toUnifiedFromWorkflowRun,
} from "./run-mappers"

const execution: TaskExecution = {
  id: "exec-1",
  taskId: "task-1",
  taskName: "Task",
  taskType: "plugin",
  status: "completed",
  retryAttempt: 0,
  startedAt: new Date("2026-07-16T00:00:00Z"),
  completedAt: new Date("2026-07-16T00:00:01Z"),
  duration: 1_000,
  logs: [],
}

describe("scheduler run mappers", () => {
  it("files a cron run under the schedule item that fired it (WF-07)", () => {
    const row = {
      id: "run-1",
      workflowId: "wf:1",
      triggerKind: "trigger.cron",
      triggerId: "trigger-1",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      workflowSnapshot: { name: "Digest" },
    } as unknown as WorkflowRunRow
    expect(toUnifiedFromWorkflowRun(row).itemUnifiedId).toBe("workflow:wf%3A1:trigger-1")
    // Any other run has no schedule item; it stays filed under its workflow.
    expect(
      toUnifiedFromWorkflowRun({ ...row, triggerKind: "trigger.manual" } as WorkflowRunRow)
        .itemUnifiedId
    ).toBe("workflow:wf:1")
  })

  it("classifies task executions by their owning source", () => {
    expect(taskExecutionKind("plugin")).toBe("plugin")
    expect(taskExecutionKind("connection:scheduled:digest")).toBe("connector")
    expect(taskExecutionKind("chat")).toBe("app")
  })

  it("maps plugin runs and filters them for the plugin source", () => {
    const run = toUnifiedFromTaskExecution(execution)
    expect(run).toMatchObject({ kind: "plugin", itemUnifiedId: "plugin:task-1" })
    expect(filterRunsByKind([run], "plugin")).toEqual([run])
    expect(filterRunsByKind([run], "app")).toEqual([])
  })

  it("carries phase timings when the run measured any", () => {
    const phases = [{ name: "turn" as const, startOffsetMs: 0, durationMs: 900 }]
    expect(toUnifiedFromTaskExecution({ ...execution, phases })).toMatchObject({ phases })
    expect(toUnifiedFromTaskExecution(execution)).not.toHaveProperty("phases")
    expect(toUnifiedFromTaskExecution({ ...execution, phases: [] })).not.toHaveProperty("phases")
  })

  it("carries the terminal reason so a run list can tell why it ended", () => {
    const run = toUnifiedFromTaskExecution({
      ...execution,
      taskType: "chat",
      status: "failed",
      terminalReason: "needs-approval",
      error: "needs approval: Bash",
    })
    expect(run).toMatchObject({ status: "failed", terminalReason: "needs-approval" })
    expect(toUnifiedFromTaskExecution(execution)).not.toHaveProperty("terminalReason")
  })
})
