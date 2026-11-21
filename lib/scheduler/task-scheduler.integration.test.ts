/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { schedulerDb } from "./scheduler-db"
import { createTaskScheduler, registerTaskExecutor, unregisterTaskExecutor } from "./task-scheduler"
import type { ScheduledTask, SchedulerTimingDriver } from "@/types/scheduler"
import { registerTaskPrewarmer, unregisterTaskPrewarmer } from "./prewarm"

// The real account database over this file's own fake IndexedDB. Mocking
// `@/lib/db/schema` with `requireActual` re-enters the mock factory through the
// schema's own import graph (account-sync capture → settings → schema) and
// reads `CogniaDB` before it is initialized, so the suite never loaded.
// Mutable so a case can lower the host cap; read when the cap refreshes.
const mockPolicy = { maxConcurrentExecutions: 5 }
jest.mock("./write-authority", () => ({
  loadSchedulerPolicy: async () => mockPolicy,
}))
jest.mock("./task-workspace-binding", () => ({
  resolveTaskWorkspace: async () => undefined,
  backfillSessionWorkspace: async () => null,
}))
jest.mock("./notification-integration", () => ({ notifyTaskEvent: jest.fn(async () => {}) }))
jest.mock("./event-integration", () => ({ emitSchedulerEvent: jest.fn(async () => {}) }))
jest.mock("./task-completion-linkage", () => ({
  dispatchScheduledTaskSettled: jest.fn(async () => {}),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  // This integration fixture has no plugins; keep the current Host hook seam.
  getPluginEventHooks: () => ({
    hasAnyHook: () => false,
    dispatchScheduledTaskCreate() {},
    dispatchScheduledTaskUpdate() {},
    dispatchScheduledTaskDelete() {},
    dispatchScheduledTaskPause() {},
    dispatchScheduledTaskResume() {},
  }),
  getPluginLifecycleHooks: () => ({
    dispatchOnScheduledTaskStart() {},
    dispatchOnScheduledTaskComplete() {},
    dispatchOnScheduledTaskError() {},
  }),
}))
jest.mock("@cognia/logging", () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  return { loggers: new Proxy({}, { get: () => logger }), createLogger: () => logger }
})

const fixtureNow = new Date("2026-10-22T12:00:00Z")
function draft(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "review-catchup",
    name: "review",
    type: "test",
    status: "active",
    payload: {},
    trigger: { type: "interval", intervalMs: 60_000 },
    config: {
      maxRetries: 0,
      retryDelay: 1000,
      timeout: 30000,
      allowConcurrent: false,
      runMissedOnStartup: true,
      maxMissedRuns: 2,
    },
    notification: { onStart: false, onComplete: false, onError: false },
    nextRunAt: new Date(fixtureNow.getTime() - 5 * 60_000),
    createdAt: new Date(fixtureNow.getTime() - 60 * 60_000),
    updatedAt: fixtureNow,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    ...overrides,
  }
}
function timing(): SchedulerTimingDriver {
  return {
    supportsLeaderElection: false,
    async start() {},
    stop() {},
    onDue() {},
    arm() {},
    disarm() {},
  }
}
let scheduler: ReturnType<typeof createTaskScheduler>
const sweep = () =>
  (scheduler as unknown as { checkMissedTasks(): Promise<void> }).checkMissedTasks()
beforeEach(async () => {
  jest.useRealTimers()
  await schedulerDb.clearAll()
  scheduler = createTaskScheduler(timing())
  await scheduler.initialize()
})
afterEach(async () => {
  jest.restoreAllMocks()
  mockPolicy.maxConcurrentExecutions = 5
  scheduler.stop()
  unregisterTaskExecutor("test")
  unregisterTaskPrewarmer("test")
  await schedulerDb.clearAll()
  jest.useRealTimers()
})
afterAll(async () => {
  await getDb().delete()
})

it("rejects an early promoted one-shot wake even when a legacy row has no nextRunAt", async () => {
  const slot = new Date(Date.now() + 45_000)
  const task = draft({
    trigger: { type: "once", runAt: slot },
    nextRunAt: undefined,
    promotion: { systemTaskId: "os-once", token: "test-token", promotedAt: new Date() },
  })
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  expect(await scheduler.runPromotedTask(task.id, "test-token")).toBeNull()
  expect(executor).not.toHaveBeenCalled()
  expect(await schedulerDb.getTaskExecutions(task.id)).toHaveLength(0)
})

it("anchors a legacy promoted one-shot wake to its trigger and deduplicates delivery", async () => {
  const slot = new Date(Date.now() - 45_000)
  const task = draft({
    trigger: { type: "once", runAt: slot },
    nextRunAt: undefined,
    promotion: { systemTaskId: "os-once", token: "test-token", promotedAt: new Date() },
  })
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  expect(await scheduler.runPromotedTask(task.id, "test-token")).toMatchObject({
    status: "completed",
    scheduledFor: slot,
  })
  await scheduler.runPromotedTask(task.id, "test-token")
  expect(executor).toHaveBeenCalledTimes(1)
})

it.each(["pause", "delete", "stop", "reschedule"] as const)(
  "rejects a promoted wake after %s during its initial database read",
  async (action) => {
    const slot = new Date(Date.now() - 45_000)
    const task = draft({
      trigger: { type: "once", runAt: slot },
      nextRunAt: slot,
      promotion: { systemTaskId: "os-once", token: "test-token", promotedAt: new Date() },
    })
    await schedulerDb.createTask(task)
    const executor = jest.fn(async () => ({ success: true }))
    registerTaskExecutor("test", executor)
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const original = schedulerDb.getTask.bind(schedulerDb)
    const read = jest.spyOn(schedulerDb, "getTask").mockImplementationOnce(async (id) => {
      const captured = await original(id)
      entered()
      await blocked
      return captured
    })
    const wake = scheduler.runPromotedTask(task.id, "test-token")
    const replacement = new Date(Date.now() + 600_000)
    try {
      await waiting
      if (action === "pause") await scheduler.pauseTask(task.id)
      if (action === "delete") await scheduler.deleteTask(task.id)
      if (action === "stop") scheduler.stop()
      if (action === "reschedule")
        await scheduler.updateTask(task.id, { trigger: { type: "once", runAt: replacement } })
      release()
      expect(await wake).toBeNull()
      expect(executor).not.toHaveBeenCalled()
      expect(await schedulerDb.getTaskExecutions(task.id)).toHaveLength(0)
      if (action === "pause") expect(await original(task.id)).toMatchObject({ status: "paused" })
      if (action === "delete") expect(await original(task.id)).toBeNull()
      if (action === "reschedule")
        expect(await original(task.id)).toMatchObject({ nextRunAt: replacement })
    } finally {
      release()
      await wake
      read.mockRestore()
    }
  }
)

it.each(["pause", "delete", "stop", "reschedule"] as const)(
  "rolls back OS promotion after %s during native creation",
  async (action) => {
    const slot = new Date(Date.now() + 60_000)
    const task = draft({ trigger: { type: "once", runAt: slot }, nextRunAt: slot })
    await schedulerDb.createTask(task)
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const remove = jest.fn(async () => true)
    scheduler.setSystemSchedulerPort({
      getSchedulerCapabilities: async () => ({ available: true, backend: "launchd" }),
      createSystemTask: async () => {
        entered()
        await blocked
        return { status: "success", task: { id: "created-os-task" } }
      },
      deleteSystemTask: remove,
      enableSystemTask: async () => true,
      disableSystemTask: async () => true,
    } as never)
    const promotion = scheduler.promoteTask(task.id, { platform: "macos", token: "test-token" })
    const replacement = new Date(Date.now() + 600_000)
    try {
      await waiting
      if (action === "pause") await scheduler.pauseTask(task.id)
      if (action === "delete") await scheduler.deleteTask(task.id)
      if (action === "stop") scheduler.stop()
      if (action === "reschedule")
        await scheduler.updateTask(task.id, { trigger: { type: "once", runAt: replacement } })
      release()
      expect(await promotion).toMatchObject({ status: "error" })
      expect(remove).toHaveBeenCalledWith("created-os-task")
      const current = await schedulerDb.getTask(task.id)
      if (action === "delete") expect(current).toBeNull()
      else {
        expect(current?.promotion).toBeUndefined()
        expect(current?.status).toBe(action === "pause" ? "paused" : "active")
        expect(current?.nextRunAt).toEqual(action === "reschedule" ? replacement : slot)
      }
    } finally {
      release()
      await promotion
    }
  }
)

it("removes a created OS task when promotion persistence fails", async () => {
  const slot = new Date(Date.now() + 60_000)
  const task = draft({ trigger: { type: "once", runAt: slot }, nextRunAt: slot })
  await schedulerDb.createTask(task)
  const remove = jest.fn(async () => true)
  scheduler.setSystemSchedulerPort({
    getSchedulerCapabilities: async () => ({ available: true, backend: "launchd" }),
    createSystemTask: async () => ({ status: "success", task: { id: "created-os-task" } }),
    deleteSystemTask: remove,
  } as never)
  const write = jest
    .spyOn(schedulerDb, "setTaskPromotion")
    .mockRejectedValueOnce(new Error("disk failed"))
  try {
    expect(
      await scheduler.promoteTask(task.id, { platform: "macos", token: "test-token" })
    ).toMatchObject({ status: "error", reason: "Promotion persistence failed; OS task removed" })
    expect(remove).toHaveBeenCalledWith("created-os-task")
    expect((await schedulerDb.getTask(task.id))?.promotion).toBeUndefined()
  } finally {
    write.mockRestore()
  }
})

it("preserves pause after promotion metadata writes but before its continuation", async () => {
  const slot = new Date(Date.now() + 60_000)
  const task = draft({ trigger: { type: "once", runAt: slot }, nextRunAt: slot })
  await schedulerDb.createTask(task)
  const remove = jest.fn(async () => true)
  scheduler.setSystemSchedulerPort({
    getSchedulerCapabilities: async () => ({ available: true, backend: "launchd" }),
    createSystemTask: async () => ({ status: "success", task: { id: "created-os-task" } }),
    deleteSystemTask: remove,
    disableSystemTask: async () => true,
  } as never)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = schedulerDb.setTaskPromotion.bind(schedulerDb)
  const write = jest
    .spyOn(schedulerDb, "setTaskPromotion")
    .mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      entered()
      await blocked
      return result
    })
  const promotion = scheduler.promoteTask(task.id, { platform: "macos", token: "test-token" })
  try {
    await waiting
    await scheduler.pauseTask(task.id)
    release()
    expect(await promotion).toMatchObject({ status: "error" })
    expect(await schedulerDb.getTask(task.id)).toMatchObject({
      status: "paused",
      promotion: undefined,
    })
    expect(remove).toHaveBeenCalledWith("created-os-task")
  } finally {
    release()
    await promotion
    write.mockRestore()
  }
})

it("keeps the canonical slot when recording OS promotion without arming an app timer", async () => {
  const slot = new Date(Date.now() + 60_000)
  const task = draft({ trigger: { type: "once", runAt: slot }, nextRunAt: slot })
  await schedulerDb.createTask(task)
  await scheduler.recordPromotion(task.id, { systemTaskId: "os-once", token: "test-token" })
  expect(await schedulerDb.getTask(task.id)).toMatchObject({ nextRunAt: slot })
  expect(scheduler.getStatus().scheduledCount).toBe(0)
})

// Keep the real Dexie facade, serializer, compound indexes and transactions.
// Each task is written only after scheduler initialization to avoid any startup rewrite.
async function seed(task = draft()) {
  const now = new Date()
  const offset = now.getTime() - fixtureNow.getTime()
  const shifted = {
    ...task,
    nextRunAt: task.nextRunAt ? new Date(task.nextRunAt.getTime() + offset) : undefined,
    createdAt: new Date(task.createdAt.getTime() + offset),
    updatedAt: now,
  }
  await schedulerDb.createTask(shifted)
  return shifted
}

it("preserves success counters with the real scheduler database", async () => {
  const task = await seed()
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  await sweep()
  expect(executor).toHaveBeenCalledTimes(2)
  expect(await schedulerDb.getTask(task.id)).toMatchObject({ runCount: 2, successCount: 2 })
})
it("preserves automatic pause with the real scheduler database", async () => {
  const task = draft()
  task.config.maxMissedRuns = 1
  task.config.pauseAfterConsecutiveFailures = 1
  await seed(task)
  registerTaskExecutor("test", async () => ({ success: false, error: "review failure" }))
  await sweep()
  expect(await schedulerDb.getTask(task.id)).toMatchObject({
    status: "paused",
    failureCount: 1,
    consecutiveFailures: 1,
  })
})
it("reserves the remaining maxRuns budget before each replay", async () => {
  const task = draft()
  task.config.maxRuns = 1
  await seed(task)
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  await sweep()
  expect(executor).toHaveBeenCalledTimes(1)
})
it("does not resurrect a task deleted during catch-up", async () => {
  const task = draft()
  task.config.maxMissedRuns = 1
  await seed(task)
  registerTaskExecutor("test", async () => {
    await scheduler.deleteTask(task.id)
    return { success: true }
  })
  await sweep()
  expect(await schedulerDb.getTask(task.id)).toBeNull()
})
it("does not continue replaying after scheduler stop", async () => {
  await seed()
  const executor = jest.fn(async () => {
    if (executor.mock.calls.length === 1) scheduler.stop()
    return { success: true }
  })
  registerTaskExecutor("test", executor)
  await sweep()
  expect({
    calls: executor.mock.calls.length,
    initialized: scheduler.getStatus().initialized,
  }).toEqual({ calls: 1, initialized: false })
})
it("does not continue replaying after a manual pause", async () => {
  const task = await seed()
  const executor = jest.fn(async () => {
    if (executor.mock.calls.length === 1) await scheduler.pauseTask(task.id)
    return { success: true }
  })
  registerTaskExecutor("test", executor)
  await sweep()
  expect({
    calls: executor.mock.calls.length,
    status: (await schedulerDb.getTask(task.id))?.status,
  }).toEqual({ calls: 1, status: "paused" })
})

it("delivers a fresh grace slot even when an older slot is outside the window", async () => {
  const now = new Date()
  const fresh = new Date(now)
  fresh.setUTCSeconds(0, 0)
  const task = draft({
    trigger: {
      type: "cron",
      cronExpression: `${fresh.getUTCMinutes()} ${fresh.getUTCHours()} * * *`,
      timezone: "UTC",
    },
    nextRunAt: new Date(fresh.getTime() - 2 * 24 * 60 * 60_000),
    createdAt: new Date(fresh.getTime() - 3 * 24 * 60 * 60_000),
  })
  task.config.maxMissedRuns = 1
  task.config.catchupWindowMs = 15 * 60_000
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  await sweep()
  expect(executor).toHaveBeenCalledTimes(1)
})

jest.mock("./daemon-bridge", () => {
  let handler: ((event: unknown) => void) | undefined
  return {
    armTask: jest.fn(async () => {}),
    disarmTask: jest.fn(async () => {}),
    listenTaskDue: jest.fn(async (next: (event: unknown) => void) => {
      handler = next
      return () => {
        handler = undefined
      }
    }),
    __emitDue: (event: unknown) => handler?.(event),
  }
})

it("does not relabel a stale native alarm as the newly rescheduled future slot", async () => {
  const { RustDaemonTimingDriver } = await import("./timing/rust-daemon-driver")
  scheduler.stop()
  const oldSlot = new Date(Date.now() - 100)
  const newSlot = new Date(Date.now() + 60 * 60_000)
  const task = draft({ trigger: { type: "once", runAt: oldSlot }, nextRunAt: oldSlot })
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  scheduler = createTaskScheduler(new RustDaemonTimingDriver())
  await scheduler.initialize()
  await scheduler.updateTask(task.id, { trigger: { type: "once", runAt: newSlot } })
  const methods = scheduler as unknown as {
    handleTaskDue(...args: unknown[]): Promise<void>
    executeTask(...args: unknown[]): Promise<unknown>
  }
  const handle = jest.spyOn(methods, "handleTaskDue")
  const execute = jest.spyOn(methods, "executeTask")
  const bridge = jest.requireMock("./daemon-bridge")
  bridge.__emitDue({ taskId: task.id, scheduledForMs: oldSlot.getTime(), firedAtMs: Date.now() })
  await Promise.all(handle.mock.results.map((result) => result.value))
  await Promise.all(execute.mock.results.map((result) => result.value))
  expect(executor).not.toHaveBeenCalled()
  expect(await schedulerDb.getTask(task.id)).toMatchObject({ nextRunAt: newSlot, runCount: 0 })
})

it("control: a normal manual run persists completed state and counters", async () => {
  const task = await seed(draft({ nextRunAt: new Date(fixtureNow.getTime() + 60_000) }))
  registerTaskExecutor("test", async () => ({ success: true }))
  const execution = await scheduler.runTaskNow(task.id)
  expect(execution).toMatchObject({ status: "completed", terminalReason: "completed" })
  expect(await schedulerDb.getTask(task.id)).toMatchObject({
    runCount: 1,
    successCount: 1,
    failureCount: 0,
  })
})

it("does not let an overlapping minute sweep consume another replay while one is running", async () => {
  const task = await seed()
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const executor = jest.fn(async () => {
    if (executor.mock.calls.length === 1) {
      started()
      await blocked
    }
    return { success: true }
  })
  registerTaskExecutor("test", executor)
  const first = sweep()
  await running
  await sweep()
  release()
  await first
  expect(executor).toHaveBeenCalledTimes(2)
  expect(await schedulerDb.getTask(task.id)).toMatchObject({ runCount: 2, successCount: 2 })
})

it("does not report a failed native arm as scheduled", async () => {
  const { RustDaemonTimingDriver } = await import("./timing/rust-daemon-driver")
  scheduler.stop()
  scheduler = createTaskScheduler(new RustDaemonTimingDriver())
  await scheduler.initialize()
  const bridge = jest.requireMock("./daemon-bridge")
  bridge.armTask.mockRejectedValueOnce(new Error("native IPC unavailable"))
  registerTaskExecutor("test", async () => ({ success: true }))
  await expect(
    scheduler.createTask({
      name: "failed arm",
      type: "test",
      trigger: { type: "once", runAt: new Date(Date.now() + 60000) },
    })
  ).rejects.toThrow("native IPC unavailable")
  expect(scheduler.getStatus().scheduledCount).toBe(0)
})

it("runs the claimed due occurrence even when arming its next native slot fails", async () => {
  const { RustDaemonTimingDriver } = await import("./timing/rust-daemon-driver")
  scheduler.stop()
  scheduler = createTaskScheduler(new RustDaemonTimingDriver())
  await scheduler.initialize()
  const task = await scheduler.createTask({
    name: "next arm failure",
    type: "test",
    trigger: { type: "interval", intervalMs: 60000 },
    config: { maxRetries: 0 },
  })
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  jest.requireMock("./daemon-bridge").armTask.mockRejectedValueOnce(new Error("next arm failed"))
  const runtime = scheduler as unknown as {
    lifecycleVersion: number
    handleTaskDue(id: string, slot: number, version: number): Promise<void>
    executeTask(...args: unknown[]): Promise<unknown>
  }
  const execute = jest.spyOn(runtime, "executeTask")
  await runtime.handleTaskDue(task.id, task.nextRunAt!.getTime(), runtime.lifecycleVersion)
  await Promise.all(execute.mock.results.map((result) => result.value))
  expect(executor).toHaveBeenCalledTimes(1)
  expect(await schedulerDb.getTask(task.id)).toMatchObject({ runCount: 1, successCount: 1 })
  expect(scheduler.getStatus().scheduledCount).toBe(0)
})

it("clears earlier successful arms after a partial native bootstrap failure", async () => {
  const { RustDaemonTimingDriver } = await import("./timing/rust-daemon-driver")
  scheduler.stop()
  for (const id of ["first", "second"]) {
    const slot = new Date(Date.now() + 60000)
    await schedulerDb.createTask(
      draft({ id, trigger: { type: "once", runAt: slot }, nextRunAt: slot })
    )
  }
  const bridge = jest.requireMock("./daemon-bridge")
  bridge.armTask.mockImplementation(async (id: string) => {
    if (id === "second") throw new Error("second arm failed")
  })
  scheduler = createTaskScheduler(new RustDaemonTimingDriver())
  await expect(scheduler.initialize()).rejects.toThrow("second arm failed")
  expect(scheduler.getStatus()).toMatchObject({ initialized: false, scheduledCount: 0 })
  bridge.armTask.mockResolvedValue(undefined)
  await scheduler.initialize()
  expect(scheduler.getStatus()).toMatchObject({ initialized: true, scheduledCount: 2 })
})

it("keeps the main native alarm usable when its optional prewarm arm fails", async () => {
  const { RustDaemonTimingDriver } = await import("./timing/rust-daemon-driver")
  scheduler.stop()
  scheduler = createTaskScheduler(new RustDaemonTimingDriver())
  await scheduler.initialize()
  registerTaskExecutor("test", async () => ({ success: true }))
  registerTaskPrewarmer("test", async () => {})
  const bridge = jest.requireMock("./daemon-bridge")
  bridge.armTask
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("prewarm arm failed"))
  const task = await scheduler.createTask({
    name: "optional prewarm",
    type: "test",
    trigger: { type: "interval", intervalMs: 3600000 },
  })
  expect(scheduler.getStatus().scheduledCount).toBe(1)
  expect(
    (scheduler as unknown as { armedPrewarms: Map<string, number> }).armedPrewarms.has(task.id)
  ).toBe(false)
})

it.each(["pause", "delete", "reschedule"] as const)(
  "does not start a due occurrence after %s while its next arm is pending",
  async (action) => {
    scheduler.stop()
    const driver = timing()
    scheduler = createTaskScheduler(driver)
    await scheduler.initialize()
    const task = await scheduler.createTask({
      name: `pending arm ${action}`,
      type: "test",
      trigger: { type: "interval", intervalMs: 60000 },
      config: { maxRetries: 0 },
    })
    const executor = jest.fn(async () => ({ success: true }))
    registerTaskExecutor("test", executor)
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    let holdNext = true
    driver.arm = async () => {
      if (!holdNext) return
      holdNext = false
      entered()
      await blocked
    }
    const runtime = scheduler as unknown as {
      lifecycleVersion: number
      handleTaskDue(id: string, slot: number, version: number): Promise<void>
      executeTask(...args: unknown[]): Promise<unknown>
    }
    const execute = jest.spyOn(runtime, "executeTask")
    const delivery = runtime.handleTaskDue(
      task.id,
      task.nextRunAt!.getTime(),
      runtime.lifecycleVersion
    )
    const replacement = new Date(Date.now() + 600000)
    try {
      await waiting
      if (action === "pause") await scheduler.pauseTask(task.id)
      if (action === "delete") await scheduler.deleteTask(task.id)
      if (action === "reschedule")
        await scheduler.updateTask(task.id, { trigger: { type: "once", runAt: replacement } })
      release()
      await delivery
      await Promise.allSettled(execute.mock.results.map((result) => result.value))
      expect(executor).not.toHaveBeenCalled()
      expect(await schedulerDb.getTaskExecutions(task.id)).toHaveLength(0)
      if (action === "reschedule") {
        expect(await schedulerDb.getTask(task.id)).toMatchObject({
          status: "active",
          nextRunAt: replacement,
        })
        expect(scheduler.getStatus().scheduledCount).toBe(1)
      }
    } finally {
      release()
      await delivery
      execute.mockRestore()
    }
  }
)

it.each(["pause", "reschedule", "stop"] as const)(
  "preserves %s while an overdue one-shot skip is being persisted",
  async (action) => {
    const oldSlot = new Date(Date.now() - 60000)
    const task = draft({ trigger: { type: "once", runAt: oldSlot }, nextRunAt: oldSlot })
    await schedulerDb.createTask(task)
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const original = schedulerDb.createExecution.bind(schedulerDb)
    const write = jest
      .spyOn(schedulerDb, "createExecution")
      .mockImplementationOnce(async (execution) => {
        await original(execution)
        entered()
        await blocked
      })
    const reconciliation = sweep()
    const replacement = new Date(Date.now() + 600000)
    try {
      await waiting
      if (action === "pause") await scheduler.pauseTask(task.id)
      if (action === "reschedule")
        await scheduler.updateTask(task.id, { trigger: { type: "once", runAt: replacement } })
      if (action === "stop") scheduler.stop()
      release()
      await reconciliation
      expect(await schedulerDb.getTask(task.id)).toMatchObject({
        status: action === "pause" ? "paused" : "active",
        nextRunAt: action === "reschedule" ? replacement : oldSlot,
      })
      if (action === "reschedule") expect(scheduler.getStatus().scheduledCount).toBe(1)
      if (action === "stop") expect(scheduler.getStatus().initialized).toBe(false)
    } finally {
      release()
      await reconciliation
      write.mockRestore()
    }
  }
)

it("does not arm a prewarm after stopping during the main native arm", async () => {
  scheduler.stop()
  const driver = timing()
  scheduler = createTaskScheduler(driver)
  await scheduler.initialize()
  registerTaskExecutor("test", async () => ({ success: true }))
  registerTaskPrewarmer("test", async () => {})
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const arm = jest.fn(async () => {
    entered()
    await blocked
  })
  driver.arm = arm
  const creating = scheduler.createTask({
    name: "stopped main arm",
    type: "test",
    trigger: { type: "interval", intervalMs: 3600000 },
  })
  await waiting
  scheduler.stop()
  release()
  await creating
  expect(arm).toHaveBeenCalledTimes(1)
  expect((scheduler as unknown as { armedPrewarms: Map<string, number> }).armedPrewarms.size).toBe(
    0
  )
  expect(scheduler.getStatus()).toMatchObject({ initialized: false, scheduledCount: 0 })
})

// ── Audit 2026-11-17 (scheduled-task gap audit F4 F5 F7 F12 F13 F14) ──────────
// Each case is a counterexample from the audit, kept as a regression.

type Run = import("@/types/scheduler").TaskExecution
type CorePort = {
  checkMissedTasks(): Promise<void>
  executeTask(
    task: ScheduledTask,
    retry: number,
    context: { triggerSource: "schedule"; scheduledFor: Date; scheduledSlotClaimed?: boolean }
  ): Promise<Run>
}
const core = () => scheduler as unknown as CorePort
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
/** A fresh row for the audit cases: a task that has not run yet. */
function liveDraft(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = new Date()
  return draft({
    id: "audit-task",
    nextRunAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
}
/**
 * Hold the first call of `method` made from inside `frame` (matched on the
 * call stack) until `release`. A read is held after it has read, which is
 * the window a write computed from that read would have to survive; a
 * transactional write is held before it starts, so whatever lands meanwhile
 * is already there when it decides.
 */
function holdCall(method: "getTask" | "mutateTask", frame: string) {
  const entered = latch()
  const hold = latch()
  const original = (schedulerDb[method] as (...args: unknown[]) => Promise<unknown>).bind(
    schedulerDb
  )
  let held = false
  jest.spyOn(schedulerDb, method).mockImplementation((async (...args: unknown[]) => {
    if (held || !new Error().stack?.includes(frame)) return original(...args)
    held = true
    if (method === "getTask") {
      const row = await original(...args)
      entered.release()
      await hold.promise
      return row
    }
    entered.release()
    await hold.promise
    return original(...args)
  }) as never)
  return { entered: entered.promise, release: hold.release }
}

it("F4: a run that settles while the user pauses keeps the task paused", async () => {
  await schedulerDb.createTask(liveDraft())
  registerTaskExecutor("test", async () => ({ success: true }))
  const stats = holdCall("mutateTask", "updateTaskStats")
  const run = scheduler.runTaskNow("audit-task")
  await stats.entered
  try {
    expect(await scheduler.pauseTask("audit-task")).toBe(true)
  } finally {
    stats.release()
  }
  await run
  expect(await schedulerDb.getTask("audit-task")).toMatchObject({
    status: "paused",
    runCount: 1,
    successCount: 1,
  })
})

it("F4: advancing the schedule after a run does not resume a task paused meanwhile", async () => {
  await schedulerDb.createTask(liveDraft())
  registerTaskExecutor("test", async () => ({ success: true }))
  const nextRun = holdCall("getTask", "updateNextRunTime")
  const run = scheduler.runTaskNow("audit-task")
  await nextRun.entered
  try {
    await scheduler.pauseTask("audit-task")
  } finally {
    nextRun.release()
  }
  await run
  expect((await schedulerDb.getTask("audit-task"))?.status).toBe("paused")
})

it("F5: two runs that settle together both count", async () => {
  const task = liveDraft()
  task.config.overlapPolicy = "allow"
  await schedulerDb.createTask(task)
  const both = latch()
  let entered = 0
  registerTaskExecutor("test", async () => {
    entered += 1
    if (entered === 2) both.release()
    await both.promise
    return { success: true }
  })
  const runs = await Promise.all([
    scheduler.runTaskNow("audit-task"),
    scheduler.runTaskNow("audit-task"),
  ])
  expect(runs.map((run) => run?.status)).toEqual(["completed", "completed"])
  expect(await schedulerDb.getTask("audit-task")).toMatchObject({ runCount: 2, successCount: 2 })
})

it("F5: an older run's counters never roll back a later slot's maxRuns reservation", async () => {
  const slot = new Date(Date.now() - 2_000)
  const next = new Date(slot.getTime() + 1_000)
  const task = liveDraft({ nextRunAt: slot, trigger: { type: "interval", intervalMs: 1_000 } })
  task.config.maxRuns = 2
  task.config.overlapPolicy = "allow"
  await schedulerDb.createTask(task)
  registerTaskExecutor("test", async () => ({ success: true }))
  const firstClaim = await schedulerDb.claimTaskSlot(task.id, slot, next)
  expect(firstClaim?.runCount).toBe(1)
  const stats = holdCall("mutateTask", "updateTaskStats")
  const first = core().executeTask(firstClaim!, 0, {
    triggerSource: "schedule",
    scheduledFor: slot,
    scheduledSlotClaimed: true,
  })
  await stats.entered
  try {
    const secondClaim = await schedulerDb.claimTaskSlot(
      task.id,
      next,
      new Date(next.getTime() + 1_000)
    )
    expect(secondClaim).toMatchObject({ runCount: 2, nextRunAt: undefined })
    const second = await core().executeTask(secondClaim!, 0, {
      triggerSource: "schedule",
      scheduledFor: next,
      scheduledSlotClaimed: true,
    })
    expect(second.status).toBe("completed")
    expect((await schedulerDb.getTask(task.id))?.status).toBe("expired")
  } finally {
    stats.release()
  }
  await first
  expect(await schedulerDb.getTask(task.id)).toMatchObject({
    runCount: 2,
    successCount: 2,
    status: "expired",
  })
})

it("F7: cancel-previous starts the replacement once the cancelled run exits, at a cap of one", async () => {
  mockPolicy.maxConcurrentExecutions = 1
  scheduler.stop()
  scheduler = createTaskScheduler(timing())
  await scheduler.initialize()
  await settle(10)
  const task = liveDraft()
  task.config.overlapPolicy = "cancel-previous"
  await schedulerDb.createTask(task)
  const entered = latch()
  let calls = 0
  let active = 0
  let peak = 0
  const order: string[] = []
  registerTaskExecutor("test", async (_task, _execution, signal) => {
    calls += 1
    active += 1
    peak = Math.max(peak, active)
    const first = calls === 1
    if (first) {
      entered.release()
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
    } else {
      order.push("replacement-started")
    }
    active -= 1
    if (first) {
      order.push("previous-exited")
      return { success: false, error: "aborted" }
    }
    return { success: true }
  })
  const first = scheduler.runTaskNow(task.id)
  await entered.promise
  const replacement = await scheduler.runTaskNow(task.id)
  expect(await first).toMatchObject({ status: "cancelled", terminalReason: "overlap-cancelled" })
  expect(replacement).toMatchObject({ status: "completed", terminalReason: "completed" })
  expect(peak).toBe(1)
  expect(order).toEqual(["previous-exited", "replacement-started"])
})

it.each(["pause", "delete", "stop"] as const)(
  "F12: a buffered start the drain already took respects %s during its row read",
  async (action) => {
    const task = liveDraft()
    task.config.overlapPolicy = "queue-all"
    await schedulerDb.createTask(task)
    const firstEntered = latch()
    const firstRelease = latch()
    let calls = 0
    registerTaskExecutor("test", async () => {
      calls += 1
      if (calls === 1) {
        firstEntered.release()
        await firstRelease.promise
      }
      return { success: true }
    })
    const first = scheduler.runTaskNow(task.id)
    await firstEntered.promise
    expect((await scheduler.runTaskNow(task.id))?.status).toBe("pending")
    const drain = holdCall("getTask", "drainOneBufferedStart")
    firstRelease.release()
    await first
    await drain.entered
    try {
      if (action === "pause") await scheduler.pauseTask(task.id)
      if (action === "delete") await scheduler.deleteTask(task.id)
      if (action === "stop") scheduler.stop()
    } finally {
      drain.release()
    }
    await settle(50)
    expect(calls).toBe(1)
  }
)

it("F13: refuses an interval its slot identity cannot tell apart, and keeps one-second slots apart", async () => {
  await expect(
    scheduler.createTask({
      name: "too fine",
      type: "test",
      trigger: { type: "interval", intervalMs: 100 },
    })
  ).rejects.toThrow(/intervalMs >= 1000/)

  const slot = new Date(Math.floor(Date.now() / 1000) * 1000 - 5_000 + 100)
  const task = liveDraft({ trigger: { type: "interval", intervalMs: 1_000 }, nextRunAt: slot })
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  await core().checkMissedTasks()
  expect(executor).toHaveBeenCalledTimes(2)
  expect(await schedulerDb.getTaskExecutions(task.id)).toHaveLength(2)
})

it("F14: a failure to record a successful run never runs its executor again", async () => {
  const task = liveDraft()
  task.config.maxRetries = 1
  task.config.retryDelay = 10
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true, output: { effectDone: true } }))
  registerTaskExecutor("test", executor)
  const original = schedulerDb.mutateTask.bind(schedulerDb)
  jest.spyOn(schedulerDb, "mutateTask").mockImplementation(async (id, mutate) => {
    if (new Error().stack?.includes("updateTaskStats")) {
      throw new Error("synthetic statistics persistence failure")
    }
    return original(id, mutate)
  })
  const run = await scheduler.runTaskNow(task.id)
  expect(run).toMatchObject({ status: "completed", output: { effectDone: true } })
  expect(run?.logs.some((log) => /Could not update the task's statistics/.test(log.message))).toBe(
    true
  )
  await settle(100)
  expect(executor).toHaveBeenCalledTimes(1)
  expect((await schedulerDb.getExecution(run!.id))?.status).toBe("completed")
})
