import type { AgentTask } from "@/types/agent/agent-task"
import type { TaskExecution } from "@/types/scheduler"
import {
  acceptedStart,
  AgentTaskMoveDeniedError,
  applyAgentTaskMove,
  cancelAgentTask,
  ensureAgentTaskSchedule,
  pauseAgentTask,
  resumeAgentTask,
  reconcileAgentTaskRuntime,
  runAgentTaskNow,
  startAgentTaskNow,
  type AgentTaskRuntimeDeps,
} from "./runtime"

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    agentId: "agent-1",
    title: "Research",
    description: "Find primary sources",
    status: "pending",
    priority: "high",
    dependencies: [],
    tags: [],
    order: 0,
    approvalPolicy: "manual",
    latestAttemptNo: 0,
    comments: [],
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}

function fixture(row = task()) {
  const createTask = jest.fn(async () => ({ id: "scheduled-1" }))
  const runTaskNowMock = jest.fn(async () => ({ id: "execution-1", status: "completed" }))
  const startTaskNowMock = jest.fn(async () => ({
    executionId: "execution-1",
    status: "running" as const,
  }))
  const deleteTask = jest.fn(async () => true)
  const pauseTask = jest.fn(async () => true)
  const pauseTaskIfIdle = jest.fn(async () => true)
  const resumeTask = jest.fn(async () => true)
  const bindSchedule = jest.fn(async () => undefined)
  const moveTask = jest.fn(async () => row)
  const getExecution = jest.fn<
    ReturnType<AgentTaskRuntimeDeps["getExecution"]>,
    Parameters<AgentTaskRuntimeDeps["getExecution"]>
  >(async () => null)
  const reconcile = jest.fn<
    ReturnType<AgentTaskRuntimeDeps["reconcile"]>,
    Parameters<AgentTaskRuntimeDeps["reconcile"]>
  >(async () => ({ interrupted: [], settled: [] }))
  return {
    deps: {
      now: () => 100,
      getTask: async () => row,
      bindSchedule,
      moveTask,
      createTask,
      runTaskNow: runTaskNowMock,
      startTaskNow: startTaskNowMock,
      pauseTask,
      pauseTaskIfIdle,
      resumeTask,
      deleteTask,
      getExecution,
      reconcile,
    },
    createTask,
    runTaskNowMock,
    startTaskNowMock,
    deleteTask,
    pauseTask,
    pauseTaskIfIdle,
    resumeTask,
    bindSchedule,
    moveTask,
    reconcile,
    getExecution,
  }
}

describe("single-Agent task Scheduler runtime", () => {
  it("creates one Scheduler definition with Agent ownership and overlap protection", async () => {
    const fx = fixture(task({ scheduledFor: 1_000 }))
    const id = await ensureAgentTaskSchedule("task-1", fx.deps)

    expect(id).toBe("scheduled-1")
    expect(fx.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent",
        trigger: { type: "once", runAt: new Date(1_000) },
        payload: expect.objectContaining({
          agentTaskId: "task-1",
          characterId: "agent-1",
          prompt: "Find primary sources",
        }),
        config: expect.objectContaining({ overlapPolicy: "skip", allowConcurrent: false }),
      })
    )
    expect(fx.bindSchedule).toHaveBeenCalledWith("task-1", "scheduled-1", 100)
  })

  it("runs now through the same Scheduler executor used by background fires", async () => {
    const fx = fixture()
    await runAgentTaskNow("task-1", fx.deps)
    expect(fx.runTaskNowMock).toHaveBeenCalledWith("scheduled-1")
  })

  it("cancels the Scheduler owner before moving the card", async () => {
    const fx = fixture(task({ scheduledTaskId: "scheduled-existing", status: "in_progress" }))
    await cancelAgentTask("task-1", fx.deps)
    expect(fx.deleteTask).toHaveBeenCalledWith("scheduled-existing")
    expect(fx.moveTask).toHaveBeenCalledWith("task-1", "cancelled", 100)
  })

  it("reconciles persisted attempts against Scheduler execution history", async () => {
    const fx = fixture()
    await reconcileAgentTaskRuntime(fx.deps)
    expect(fx.reconcile).toHaveBeenCalledWith(expect.any(Function), 100)
  })

  it("normalizes skipped Scheduler executions to cancelled attempts", async () => {
    const fx = fixture()
    fx.getExecution.mockResolvedValue({
      id: "execution-1",
      taskId: "scheduled-1",
      taskName: "Research",
      taskType: "agent",
      status: "skipped",
      output: { reason: "overlap" },
      error: undefined,
      retryAttempt: 0,
      startedAt: new Date(0),
      logs: [],
    })

    await reconcileAgentTaskRuntime(fx.deps)
    const resolveExecution = fx.reconcile.mock.calls[0][0]

    await expect(resolveExecution("execution-1")).resolves.toEqual({
      status: "cancelled",
      output: { reason: "overlap" },
      error: undefined,
    })
  })

  it("keeps missing Scheduler executions unresolved", async () => {
    const fx = fixture()
    await reconcileAgentTaskRuntime(fx.deps)
    const resolveExecution = fx.reconcile.mock.calls[0][0]

    await expect(resolveExecution("missing")).resolves.toBeNull()
  })

  it("refuses a stale cancel, pause or resume before touching the Scheduler", async () => {
    const fx = fixture(task({ scheduledTaskId: "scheduled-existing", status: "completed" }))
    await expect(cancelAgentTask("task-1", fx.deps)).rejects.toBeInstanceOf(
      AgentTaskMoveDeniedError
    )
    await expect(pauseAgentTask("task-1", fx.deps)).rejects.toMatchObject({
      reason: "illegal-transition",
    })
    await expect(resumeAgentTask("task-1", fx.deps)).rejects.toMatchObject({
      reason: "illegal-transition",
    })
    expect(fx.deleteTask).not.toHaveBeenCalled()
    expect(fx.pauseTask).not.toHaveBeenCalled()
    expect(fx.resumeTask).not.toHaveBeenCalled()
    expect(fx.moveTask).not.toHaveBeenCalled()
  })
})

describe("applyAgentTaskMove", () => {
  const scheduled = { scheduledTaskId: "scheduled-1" }

  it("pauses the Scheduler task when a running task is moved to paused", async () => {
    const fx = fixture(task({ ...scheduled, status: "in_progress" }))
    await applyAgentTaskMove("task-1", "paused", fx.deps)
    expect(fx.pauseTask).toHaveBeenCalledWith("scheduled-1")
    expect(fx.moveTask).toHaveBeenCalledWith("task-1", "paused", 100)
  })

  it("deletes the Scheduler task when a task is cancelled", async () => {
    for (const status of ["pending", "in_progress", "paused", "failed"] as const) {
      const fx = fixture(task({ ...scheduled, status }))
      await applyAgentTaskMove("task-1", "cancelled", fx.deps)
      expect(fx.deleteTask).toHaveBeenCalledWith("scheduled-1")
      expect(fx.moveTask).toHaveBeenCalledWith("task-1", "cancelled", 100)
    }
  })

  it("resumes the Scheduler task when a paused task goes back to pending", async () => {
    const fx = fixture(task({ ...scheduled, status: "paused" }))
    await applyAgentTaskMove("task-1", "pending", fx.deps)
    expect(fx.moveTask).toHaveBeenCalledWith("task-1", "pending", 100, { expectedStatus: "paused" })
    expect(fx.resumeTask).toHaveBeenCalledWith("scheduled-1")
  })

  it("writes plain status moves without Scheduler side effects", async () => {
    const retry = fixture(task({ ...scheduled, status: "failed" }))
    await applyAgentTaskMove("task-1", "pending", retry.deps)
    expect(retry.moveTask).toHaveBeenCalledWith("task-1", "pending", 100)
    expect(retry.resumeTask).not.toHaveBeenCalled()

    const verdict = fixture(task({ ...scheduled, status: "review" }))
    await applyAgentTaskMove("task-1", "completed", verdict.deps)
    expect(verdict.moveTask).toHaveBeenCalledWith("task-1", "completed", 100)
    for (const fx of [retry, verdict]) {
      expect(fx.pauseTask).not.toHaveBeenCalled()
      expect(fx.deleteTask).not.toHaveBeenCalled()
    }
  })

  it("does nothing for a move onto the task's own column", async () => {
    const fx = fixture(task({ ...scheduled, status: "paused" }))
    await applyAgentTaskMove("task-1", "paused", fx.deps)
    expect(fx.pauseTask).not.toHaveBeenCalled()
    expect(fx.moveTask).not.toHaveBeenCalled()
  })

  it("throws the guard's reason and touches nothing for a refused move", async () => {
    const fx = fixture(task({ ...scheduled, status: "pending" }))
    await expect(applyAgentTaskMove("task-1", "in_progress", fx.deps)).rejects.toMatchObject({
      name: "AgentTaskMoveDeniedError",
      reason: "runtime-owned",
    })
    await expect(applyAgentTaskMove("task-1", "blocked", fx.deps)).rejects.toMatchObject({
      reason: "dependency-owned",
    })
    expect(fx.moveTask).not.toHaveBeenCalled()
    expect(fx.deleteTask).not.toHaveBeenCalled()
  })

  it("reports a missing task", async () => {
    const fx = fixture()
    const deps = { ...fx.deps, getTask: async () => undefined }
    await expect(applyAgentTaskMove("task-1", "cancelled", deps)).rejects.toThrow(
      "Agent task not found"
    )
  })
})

describe("startAgentTaskNow", () => {
  it("binds the schedule and asks for an accept-time start", async () => {
    const fx = fixture()
    expect(await startAgentTaskNow("task-1", fx.deps)).toEqual({
      executionId: "execution-1",
      status: "running",
    })
    expect(fx.startTaskNowMock).toHaveBeenCalledWith("scheduled-1")
    expect(fx.runTaskNowMock).not.toHaveBeenCalled()
  })
})

describe("acceptedStart", () => {
  function execution(status: TaskExecution["status"]): TaskExecution {
    return { id: "ex-1", status } as TaskExecution
  }

  it("answers at onAccepted, long before the execution settles", async () => {
    let settle: (value: TaskExecution) => void = () => {}
    const run = jest.fn(
      (_id: string, opts: { onAccepted: (execution: TaskExecution) => void }) =>
        new Promise<TaskExecution | null>((resolve) => {
          opts.onAccepted(execution("running"))
          settle = resolve
        })
    )
    await expect(acceptedStart(run, "sched-1")).resolves.toEqual({
      executionId: "ex-1",
      status: "running",
    })
    expect(run).toHaveBeenCalledWith("sched-1", expect.any(Object))
    settle(execution("completed"))
  })

  it("reads a buffered start as queued and a skipped or missing one as refused", async () => {
    await expect(acceptedStart(async () => execution("pending"), "s")).resolves.toEqual({
      executionId: "ex-1",
      status: "queued",
    })
    await expect(acceptedStart(async () => execution("skipped"), "s")).rejects.toThrow(
      "did not start"
    )
    await expect(acceptedStart(async () => null, "s")).rejects.toThrow("did not start")
  })

  it("passes a Scheduler refusal through, and ignores a failure after acceptance", async () => {
    await expect(
      acceptedStart(async () => {
        throw new Error("owner elsewhere")
      }, "s")
    ).rejects.toThrow("owner elsewhere")
    await expect(
      acceptedStart(async (_id, opts) => {
        opts.onAccepted(execution("running"))
        throw new Error("timed out later")
      }, "s")
    ).resolves.toMatchObject({ status: "running" })
  })
})

describe("Scheduler move refusal", () => {
  it.each([
    ["in_progress", "paused", "pauseTask"],
    ["paused", "pending", "resumeTask"],
    ["pending", "cancelled", "deleteTask"],
  ] as const)("does not write %s -> %s when %s refuses", async (from, to, operation) => {
    const fx = fixture(task({ status: from, scheduledTaskId: "scheduled-existing" }))
    fx[operation].mockResolvedValue(false)
    await expect(applyAgentTaskMove("task-1", to, fx.deps)).rejects.toThrow()
    expect(fx.moveTask).not.toHaveBeenCalled()
  })

  it("keeps the card paused when Scheduler resume throws", async () => {
    const fx = fixture(task({ status: "paused", scheduledTaskId: "scheduled-existing" }))
    fx.resumeTask.mockRejectedValue(new Error("owner elsewhere"))
    await expect(resumeAgentTask("task-1", fx.deps)).rejects.toThrow("owner elsewhere")
    expect(fx.moveTask).not.toHaveBeenCalled()
  })
})

it("disarms a resumed Scheduler if the conditional handoff fails", async () => {
  const fx = fixture(task({ status: "paused", scheduledTaskId: "scheduled-1" }))
  fx.moveTask.mockRejectedValue(new Error("database unavailable"))
  await expect(resumeAgentTask("task-1", fx.deps)).rejects.toThrow("database unavailable")
  expect(fx.pauseTaskIfIdle).toHaveBeenCalledWith("scheduled-1")
})

it("retains both errors if resume and its compensation fail", async () => {
  const fx = fixture(task({ status: "paused", scheduledTaskId: "scheduled-1" }))
  fx.resumeTask.mockRejectedValue(new Error("resume failed"))
  fx.pauseTaskIfIdle.mockRejectedValue(new Error("disarm failed"))
  await expect(resumeAgentTask("task-1", fx.deps)).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: "resume failed" }),
      expect.objectContaining({ message: "disarm failed" }),
    ],
  })
  expect(fx.moveTask).not.toHaveBeenCalled()
})

it.each([
  ["in_progress", "paused", "pauseTask"],
  ["pending", "cancelled", "deleteTask"],
] as const)("does not write %s -> %s when %s throws", async (from, to, operation) => {
  const fx = fixture(task({ status: from, scheduledTaskId: "scheduled-existing" }))
  fx[operation].mockRejectedValue(new Error("Scheduler unavailable"))
  await expect(applyAgentTaskMove("task-1", to, fx.deps)).rejects.toThrow("Scheduler unavailable")
  expect(fx.moveTask).not.toHaveBeenCalled()
})

it("never disarms a new run when the resume handoff encounters an error", async () => {
  const row = task({ status: "paused", scheduledTaskId: "scheduled-1" })
  const fx = fixture(row)
  fx.resumeTask.mockImplementation(async () => {
    row.status = "in_progress"
    return true
  })
  fx.moveTask.mockRejectedValue(new Error("database unavailable"))
  await expect(resumeAgentTask("task-1", fx.deps)).rejects.toThrow("database unavailable")
  expect(fx.pauseTask).not.toHaveBeenCalled()
})

it("lets the Scheduler refuse compensation while a newly accepted attempt is not yet visible", async () => {
  const fx = fixture(task({ status: "paused", scheduledTaskId: "scheduled-1" }))
  fx.moveTask.mockRejectedValue(new Error("handoff failed"))
  fx.pauseTaskIfIdle.mockResolvedValue(false)
  await expect(resumeAgentTask("task-1", fx.deps)).rejects.toThrow("handoff failed")
  expect(fx.pauseTaskIfIdle).toHaveBeenCalledWith("scheduled-1")
  expect(fx.pauseTask).not.toHaveBeenCalled()
})
