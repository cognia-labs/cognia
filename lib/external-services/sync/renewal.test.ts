/** @jest-environment jsdom */
jest.mock("@/lib/scheduler/task-scheduler", () => {
  const scheduler = {
    createTask: jest.fn(async (input: import("@/types/scheduler").CreateScheduledTaskInput) => {
      const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
      const task = {
        ...input,
        status: "active",
        config: {},
        notification: {},
        runCount: 0,
        successCount: 0,
        failureCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as import("@/types/scheduler").ScheduledTask
      await schedulerDb.createTask(task)
      return task
    }),
    updateTask: jest.fn(async (id: string, patch: object) => {
      const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
      const row = await schedulerDb.getTask(id)
      if (row) await schedulerDb.updateTask({ ...row, ...patch })
    }),
    deleteTask: jest.fn(async (id: string) => {
      const { schedulerDb } = await import("@/lib/scheduler/scheduler-db")
      await schedulerDb.deleteTask(id)
    }),
  }
  return { getTaskScheduler: () => scheduler }
})
jest.mock("./runtime", () => ({ requestExternalSync: jest.fn() }))
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"
import { requestExternalSync } from "./runtime"
import {
  registerExternalSyncRenewer,
  setExternalSyncSubscription,
  executeExternalSyncRenewalTask,
  syncExternalSyncRenewalSchedule,
  externalSyncRenewalTaskId,
  EXTERNAL_SYNC_RENEWAL_SWEEP_ID,
  abortExternalSyncRenewal,
} from "./renewal"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  await getDb().externalSyncCursors.put({ key: "test", owner: "host", failures: 0 })
})
afterEach(async () => {
  jest.restoreAllMocks()
  await abortExternalSyncRenewal("test")
  await abortExternalSyncRenewal("other")
})
afterAll(fixture.dispose)
const subscription = () =>
  getDb()
    .externalSyncCursors.get("test")
    .then((row) => row?.subscription)
const execute = async () => {
  await syncExternalSyncRenewalSchedule()
  return executeExternalSyncRenewalTask(
    (await schedulerDb.getTask(externalSyncRenewalTaskId("test")))!,
    {} as TaskExecution,
    new AbortController().signal
  )
}

async function waitForTask(id: string, present: boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (Boolean(await schedulerDb.getTask(id)) !== present) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for renewal task")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

it("computes renewal time and re-arms on success", async () => {
  const now = Date.now()
  const renew = jest.fn(async () => ({ id: "two", expiresAt: now + 20_000_000 }))
  const dispose = registerExternalSyncRenewer("test", renew)
  await setExternalSyncSubscription("test", { id: "one", expiresAt: now + 10_000_000 }, now)
  expect(await subscription()).toMatchObject({
    renewAt: now + 9_000_000,
    state: "active",
    attempts: 0,
  })
  const task = await schedulerDb.getTask(externalSyncRenewalTaskId("test"))
  expect(task).toMatchObject({
    type: "external-sync-renewal",
    trigger: { type: "once", runAt: new Date(now + 9_000_000) },
  })
  expect(await schedulerDb.getTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID)).toMatchObject({
    trigger: { type: "interval", intervalMs: 3_600_000 },
  })
  try {
    expect(await execute()).toEqual({ success: true })
    expect(await subscription()).toMatchObject({ id: "two", state: "active", attempts: 0 })
    expect((await schedulerDb.getTask(task!.id))!.trigger.runAt!.getTime()).toBeGreaterThan(
      task!.trigger.runAt!.getTime()
    )
  } finally {
    dispose()
  }
})

it("floors lead time at five minutes and retries past expiry with a full sync", async () => {
  let now = Date.now()
  jest.spyOn(Date, "now").mockImplementation(() => now)
  jest.spyOn(Math, "random").mockReturnValue(0.5)
  const dispose = registerExternalSyncRenewer("test", async () => {
    throw new Error("private service error")
  })
  await setExternalSyncSubscription("test", { id: "one", expiresAt: now + 60_000 }, now)
  expect((await subscription())!.renewAt).toBe(now + 60_000 - 300_000)
  try {
    expect(await execute()).toEqual({ success: false, error: "renewal-failed" })
    expect(await subscription()).toMatchObject({
      state: "renew-failed",
      attempts: 1,
      renewAt: now + 30_000,
    })
    expect(requestExternalSync).not.toHaveBeenCalled()
    now += 61_000
    await execute()
    expect(await subscription()).toMatchObject({ attempts: 2, renewAt: now + 60_000 })
    expect(requestExternalSync).toHaveBeenCalledWith("test", "manual", { full: true })
    expect(JSON.stringify(await subscription())).not.toContain("private service error")
  } finally {
    dispose()
  }
})

it("sweeps missing and stale tasks and removes the backstop when no subscriptions remain", async () => {
  await syncExternalSyncRenewalSchedule()
  expect(await schedulerDb.getTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID)).toBeNull()
  registerExternalSyncRenewer("test", async () => ({
    id: "new",
    expiresAt: Date.now() + 20_000_000,
  }))
  await setExternalSyncSubscription("test", { id: "one", expiresAt: Date.now() + 10_000_000 })
  const id = externalSyncRenewalTaskId("test")
  await schedulerDb.deleteTask(id)
  await syncExternalSyncRenewalSchedule()
  expect(await schedulerDb.getTask(id)).not.toBeNull()
  const existing = (await schedulerDb.getTask(id))!
  await schedulerDb.updateTask({ ...existing, status: "expired" })
  await syncExternalSyncRenewalSchedule()
  expect((await schedulerDb.getTask(id))!.status).toBe("active")
  await getDb().externalSyncCursors.delete("test")
  await syncExternalSyncRenewalSchedule()
  expect(await schedulerDb.getTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID)).toBeNull()
})

it("disposal aborts an in-flight renewal and does not record a failure", async () => {
  await setExternalSyncSubscription("test", { id: "one", expiresAt: Date.now() + 10_000_000 })
  let release!: () => void
  let entered!: () => void
  let signal!: AbortSignal
  const gate = new Promise<void>((r) => {
    release = r
  })
  const started = new Promise<void>((r) => {
    entered = r
  })
  const dispose = registerExternalSyncRenewer("test", async (_sub, input) => {
    signal = input
    entered()
    await gate
    return { id: "late", expiresAt: Date.now() + 20_000_000 }
  })
  const pending = execute()
  await started
  dispose()
  expect(signal.aborted).toBe(true)
  release()
  expect(await pending).toEqual({ success: false, error: "cancelled" })
  expect(await subscription()).toMatchObject({ id: "one", attempts: 0 })
})

it("cancellation during the post-renew read cannot persist or re-arm a late subscription", async () => {
  await setExternalSyncSubscription("test", { id: "one", expiresAt: Date.now() + 10_000_000 })
  const before = await subscription()
  let readStarted!: () => void
  let finishRead!: () => void
  const started = new Promise<void>((resolve) => {
    readStarted = resolve
  })
  const gate = new Promise<void>((resolve) => {
    finishRead = resolve
  })
  const table = getDb().externalSyncCursors
  const get = table.get.bind(table)
  const dispose = registerExternalSyncRenewer("test", async () => {
    jest.spyOn(table, "get").mockImplementationOnce((key) => {
      const read = get(key as unknown as string)
      readStarted()
      return read.then(async (row) => {
        await gate
        return row
      }) as ReturnType<typeof table.get>
    })
    return { id: "late", expiresAt: Date.now() + 20_000_000 }
  })
  try {
    const pending = execute()
    await started
    const stopped = abortExternalSyncRenewal("test")
    finishRead()
    expect(await pending).toEqual({ success: false, error: "cancelled" })
    await stopped
    expect(await subscription()).toEqual(before)
    await syncExternalSyncRenewalSchedule()
    expect(await schedulerDb.getTask(externalSyncRenewalTaskId("test"))).toBeNull()
  } finally {
    finishRead()
    dispose()
  }
})

it("rolls back a renewal aborted during its subscription update", async () => {
  const dispose = registerExternalSyncRenewer("test", async () => ({
    id: "late",
    expiresAt: Date.now() + 20_000_000,
  }))
  await setExternalSyncSubscription("test", { id: "one", expiresAt: Date.now() + 10_000_000 })
  const before = await subscription()
  const controller = new AbortController()
  const table = getDb().externalSyncCursors
  const update = table.update.bind(table)
  jest.spyOn(table, "update").mockImplementationOnce((key, patch) =>
    update(key, patch).then((count) => {
      controller.abort()
      return count
    })
  )
  try {
    expect(
      await executeExternalSyncRenewalTask(
        (await schedulerDb.getTask(externalSyncRenewalTaskId("test")))!,
        {} as TaskExecution,
        controller.signal
      )
    ).toEqual({ success: false, error: "cancelled" })
    expect(await subscription()).toEqual(before)
  } finally {
    dispose()
  }
})

it("removes the once task when cancellation lands during arming", async () => {
  const dispose = registerExternalSyncRenewer("test", async () => ({
    id: "late",
    expiresAt: Date.now() + 20_000_000,
  }))
  await setExternalSyncSubscription("test", { id: "one", expiresAt: Date.now() + 10_000_000 })
  const controller = new AbortController()
  const scheduler = getTaskScheduler()
  const update = jest.mocked(scheduler.updateTask).getMockImplementation()!
  jest.mocked(scheduler.updateTask).mockImplementationOnce(async (...args) => {
    const updated = await update(...args)
    controller.abort()
    return updated
  })
  try {
    expect(
      await executeExternalSyncRenewalTask(
        (await schedulerDb.getTask(externalSyncRenewalTaskId("test")))!,
        {} as TaskExecution,
        controller.signal
      )
    ).toEqual({ success: false, error: "cancelled" })
    expect(await schedulerDb.getTask(externalSyncRenewalTaskId("test"))).toBeNull()
    await syncExternalSyncRenewalSchedule()
    expect(await schedulerDb.getTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID)).toBeDefined()
  } finally {
    dispose()
  }
})

it("pauses disposal, skips unregistered subscriptions, and re-arms on registration", async () => {
  await getDb().externalSyncCursors.put({ key: "other", owner: "host", failures: 0 })
  await setExternalSyncSubscription("test", { id: "one", expiresAt: Date.now() + 10_000_000 })
  await setExternalSyncSubscription("other", { id: "other", expiresAt: Date.now() + 10_000_000 })
  expect(await schedulerDb.getTask(externalSyncRenewalTaskId("test"))).toBeNull()
  expect(await schedulerDb.getTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID)).toBeNull()
  const renew = jest.fn(async () => ({ id: "new", expiresAt: Date.now() + 20_000_000 }))
  const dispose = registerExternalSyncRenewer("test", renew)
  await syncExternalSyncRenewalSchedule()
  expect(await schedulerDb.getTask(externalSyncRenewalTaskId("test"))).not.toBeNull()
  expect(await schedulerDb.getTask(externalSyncRenewalTaskId("other"))).toBeNull()
  const before = await subscription()
  dispose()
  await waitForTask(externalSyncRenewalTaskId("test"), false)
  await waitForTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID, false)
  expect(await schedulerDb.getTask(externalSyncRenewalTaskId("test"))).toBeNull()
  expect(await schedulerDb.getTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID)).toBeNull()
  expect(await subscription()).toEqual(before)
  const again = registerExternalSyncRenewer("test", renew)
  try {
    // Registration itself restores the persisted subscription's task.
    await waitForTask(externalSyncRenewalTaskId("test"), true)
    await waitForTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID, true)
    expect(await schedulerDb.getTask(externalSyncRenewalTaskId("test"))).not.toBeNull()
    expect(await schedulerDb.getTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID)).not.toBeNull()
  } finally {
    again()
  }
})

it("treats an already queued task with no renewer as paused without attempts or full sync", async () => {
  await setExternalSyncSubscription("test", { id: "expired", expiresAt: Date.now() - 60_000 })
  const before = await subscription()
  const task: ScheduledTask = {
    id: externalSyncRenewalTaskId("test"),
    payload: { key: "test" },
    name: "queued renewal",
    type: "external-sync-renewal",
    trigger: { type: "once", runAt: new Date() },
    status: "active",
    config: { timeout: 30_000, maxRetries: 0, retryDelay: 1000, runMissedOnStartup: false },
    notification: { onStart: false, onComplete: false, onError: false },
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  await schedulerDb.createTask(task)
  expect(
    await executeExternalSyncRenewalTask(task, {} as TaskExecution, new AbortController().signal)
  ).toEqual({ success: true, output: { paused: true } })
  expect(await subscription()).toEqual(before)
  expect(requestExternalSync).not.toHaveBeenCalled()
  expect(await schedulerDb.getTask(task.id)).toBeNull()
})

it("does not overwrite a subscription replaced while its renewer was running", async () => {
  const expiresAt = Date.now() + 20_000_000
  const dispose = registerExternalSyncRenewer("test", async () => {
    await setExternalSyncSubscription("test", { id: "replacement", expiresAt })
    return { id: "stale", expiresAt: expiresAt + 10_000_000 }
  })
  try {
    await setExternalSyncSubscription("test", { id: "one", expiresAt: Date.now() + 10_000_000 })
    expect(await execute()).toEqual({ success: true })
    expect(await subscription()).toMatchObject({ id: "replacement", expiresAt, attempts: 0 })
  } finally {
    dispose()
  }
})

it("reports rejected registration scheduling with a static diagnostic", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  jest
    .spyOn(getDb().externalSyncCursors, "get")
    .mockRejectedValueOnce(new Error("private remote content"))
  const dispose = registerExternalSyncRenewer("test", async () => ({
    id: "new",
    expiresAt: Date.now() + 10_000_000,
  }))
  try {
    await syncExternalSyncRenewalSchedule()
    expect(warn).toHaveBeenCalledWith("External sync renewal scheduling failed")
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private remote content")
  } finally {
    dispose()
  }
})
