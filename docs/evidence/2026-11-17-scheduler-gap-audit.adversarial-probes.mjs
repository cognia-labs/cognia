#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = process.cwd()
const base = readFileSync(
  resolve(root, "docs/evidence/2026-11-17-scheduler-gap-audit.probes.mjs"),
  "utf8"
)
const marker = "const source = String.raw`"
const start = base.indexOf(marker)
const end = base.indexOf('it("control:', start)
if (start < 0 || end < 0) throw new Error("Audit fixture layout changed; review extraction")
const setup = base.slice(start + marker.length, end)
const fixture = resolve(root, "lib/scheduler/scheduler-adversarial-audit-2026-11-17.test.ts")
if (existsSync(fixture)) throw new Error(`Refusing to overwrite ${fixture}`)
mkdirSync(resolve(root, ".cache/scheduler-gap-audit-2026-11-17"), { recursive: true })
const cases = String.raw`
import { normalizeTaskTrigger } from "./trigger-normalizer"
type Run = import("@/types/scheduler").TaskExecution
type TestPort = {
  checkMissedTasks(): Promise<void>
  executeTask(task: ScheduledTask, retry: number, context: { triggerSource: "schedule"; scheduledFor: Date; scheduledSlotClaimed?: boolean }): Promise<Run>
}
const core = () => scheduler as unknown as TestPort
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Audit condition did not settle within 2 seconds")
    await delay(5)
  }
}

function controlledTiming() {
  let due: ((id: string, at: number) => void) | undefined
  const arms = new Map<string, number>()
  const driver: SchedulerTimingDriver = {
    supportsLeaderElection: false,
    async start() {}, stop() {},
    onDue(callback) { due = callback },
    arm(id, at) { arms.set(id, at) }, disarm(id) { arms.delete(id) },
  }
  return { driver, arms, fire(id: string, at: number) { if (!due) throw new Error("Missing due callback"); due(id, at) } }
}

it("control: public creation and an armed due event reach a completed execution", async () => {
  scheduler.stop()
  const clock = controlledTiming()
  scheduler = createTaskScheduler(clock.driver)
  await scheduler.initialize()
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  const slot = new Date(Date.now() + 200)
  const task = await scheduler.createTask({ id: "public-once", name: "public once", type: "test", trigger: { type: "once", runAt: slot }, payload: {}, config: { maxRetries: 0 }, notification: { onStart: false, onComplete: false, onError: false } })
  expect(clock.arms.get(task.id)).toBe(slot.getTime())
  await delay(Math.max(0, slot.getTime() - Date.now()) + 5)
  clock.fire(task.id, slot.getTime())
  await until(async () => (await schedulerDb.getTaskExecutions(task.id)).some((run) => run.status === "completed"))
  expect(executor).toHaveBeenCalledTimes(1)
  expect(await schedulerDb.getTask(task.id)).toMatchObject({ runCount: 1, successCount: 1 })
})

it("A0: a public due event retains recovery work when its cursor commit precedes execution", async () => {
  scheduler.stop()
  const clock = controlledTiming()
  scheduler = createTaskScheduler(clock.driver)
  await scheduler.initialize()
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  const slot = new Date(Date.now() + 200)
  const task = await scheduler.createTask({ id: "public-claim", name: "public claim", type: "test", trigger: { type: "once", runAt: slot }, payload: {}, config: { maxRetries: 0 }, notification: { onStart: false, onComplete: false, onError: false } })
  const entered = latch(), hold = latch()
  const original = schedulerDb.claimTaskSlot.bind(schedulerDb)
  jest.spyOn(schedulerDb, "claimTaskSlot").mockImplementationOnce(async (...args) => {
    const claimed = await original(...args)
    expect(claimed).not.toBeNull()
    entered.release()
    await hold.promise
    return claimed
  })
  await delay(Math.max(0, slot.getTime() - Date.now()) + 5)
  clock.fire(task.id, slot.getTime())
  await entered.promise
  expect(await schedulerDb.getTaskExecutions(task.id)).toHaveLength(0)
  const persisted = await schedulerDb.getTask(task.id)
  expect(persisted?.runCount).toBe(1)
  expect(persisted?.nextRunAt).toBeUndefined()
  try { await restart() } finally { hold.release() }
  await core().checkMissedTasks()
  await delay(30)
  expect(executor).toHaveBeenCalledTimes(1)
})

it.each(["pause", "delete", "stop"] as const)("A1: a popped buffered start respects %s during its row read", async (action) => {
  const task = draft()
  task.config.overlapPolicy = "queue-all"
  await schedulerDb.createTask(task)
  const firstEntered = latch(), firstRelease = latch()
  let calls = 0
  registerTaskExecutor("test", async () => {
    calls += 1
    if (calls === 1) { firstEntered.release(); await firstRelease.promise }
    return { success: true }
  })
  const first = scheduler.runTaskNow(task.id)
  await firstEntered.promise
  expect((await scheduler.runTaskNow(task.id))?.status).toBe("pending")
  const entered = latch(), hold = latch()
  const original = schedulerDb.getTask.bind(schedulerDb)
  let held = false
  jest.spyOn(schedulerDb, "getTask").mockImplementation(async (id) => {
    const matches = new Error().stack?.includes("drainOneBufferedStart")
    const row = await original(id)
    if (matches && !held) { held = true; entered.release(); await hold.promise }
    return row
  })
  firstRelease.release()
  await first
  await entered.promise
  try {
    if (action === "pause") {
      await scheduler.pauseTask(task.id)
      expect((await original(task.id))?.status).toBe("paused")
    }
    if (action === "delete") {
      await scheduler.deleteTask(task.id)
      expect(await original(task.id)).toBeNull()
    }
    if (action === "stop") scheduler.stop()
  } finally { hold.release() }
  await delay(50)
  expect(calls).toBe(1)
})

it("A2: a next-run completion write preserves a public pause", async () => {
  const task = draft()
  await schedulerDb.createTask(task)
  registerTaskExecutor("test", async () => ({ success: true }))
  const entered = latch(), hold = latch()
  const original = schedulerDb.getTask.bind(schedulerDb)
  let held = false
  jest.spyOn(schedulerDb, "getTask").mockImplementation(async (id) => {
    const matches = new Error().stack?.includes("updateNextRunTime")
    const row = await original(id)
    if (matches && !held) { held = true; entered.release(); await hold.promise }
    return row
  })
  const run = scheduler.runTaskNow(task.id)
  await entered.promise
  try {
    await scheduler.pauseTask(task.id)
    expect((await original(task.id))?.status).toBe("paused")
  } finally { hold.release() }
  await run
  expect((await original(task.id))?.status).toBe("paused")
})

it.each([100, 1000])("A3: two admitted %i ms catch-up slots retain separate executions", async (intervalMs) => {
  const trigger = normalizeTaskTrigger({ type: "interval", intervalMs })
  expect(trigger.intervalMs).toBe(intervalMs)
  const slot = new Date(Math.floor(Date.now() / 1000) * 1000 - 5_000 + 100)
  const task = draft({ trigger, nextRunAt: slot })
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  await core().checkMissedTasks()
  expect((await schedulerDb.getTask(task.id))?.runCount).toBe(2)
  expect({ calls: executor.mock.calls.length, rows: (await schedulerDb.getTaskExecutions(task.id)).length }).toEqual({ calls: 2, rows: 2 })
})
// A4 compares a proposed identity model, not the current retry-time contract.
// Its red result is retained as a rejected expectation, not a product defect.
it("A4 design comparison: a scheduled retry keeps the original occurrence time", async () => {
  const slot = new Date(Date.now() - 1_000)
  const task = draft({ nextRunAt: slot })
  task.config.maxRetries = 1
  task.config.maxMissedRuns = 1
  await schedulerDb.createTask(task)
  const slots: Array<number | undefined> = []
  registerTaskExecutor("test", async (_task, execution) => {
    slots.push(execution.scheduledFor?.getTime())
    return slots.length === 1 ? { success: false, error: "synthetic transient" } : { success: true }
  })
  await core().checkMissedTasks()
  await until(() => slots.length === 2 && scheduler.getStatus().runningCount === 0)
  expect(slots).toEqual([slot.getTime(), slot.getTime()])
})

it("A5: completed statistics cannot roll back a later atomic maxRuns reservation", async () => {
  const slot = new Date(Date.now() - 2_000), next = new Date(slot.getTime() + 1_000)
  const task = draft({ nextRunAt: slot, trigger: { type: "interval", intervalMs: 1_000 } })
  task.config.maxRuns = 2
  task.config.overlapPolicy = "allow"
  await schedulerDb.createTask(task)
  registerTaskExecutor("test", async () => ({ success: true }))
  const firstClaim = await schedulerDb.claimTaskSlot(task.id, slot, next)
  expect(firstClaim?.runCount).toBe(1)
  const entered = latch(), hold = latch()
  const original = schedulerDb.getTask.bind(schedulerDb)
  let held = false
  jest.spyOn(schedulerDb, "getTask").mockImplementation(async (id) => {
    const matches = new Error().stack?.includes("updateTaskStats")
    const row = await original(id)
    if (matches && !held) { held = true; entered.release(); await hold.promise }
    return row
  })
  const first = core().executeTask(firstClaim!, 0, { triggerSource: "schedule", scheduledFor: slot, scheduledSlotClaimed: true })
  await entered.promise
  try {
    const secondClaim = await schedulerDb.claimTaskSlot(task.id, next, new Date(next.getTime() + 1_000))
    expect(secondClaim?.runCount).toBe(2)
    expect(secondClaim?.nextRunAt).toBeUndefined()
    expect((await core().executeTask(secondClaim!, 0, { triggerSource: "schedule", scheduledFor: next, scheduledSlotClaimed: true })).status).toBe("completed")
    expect((await original(task.id))?.status).toBe("expired")
  } finally { hold.release() }
  await first
  expect(await original(task.id)).toMatchObject({ runCount: 2, successCount: 2, status: "expired" })
})

it("A6: a bookkeeping write failure does not replay an already successful executor", async () => {
  const task = draft()
  task.config.maxRetries = 1
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true, output: { effectDone: true } }))
  registerTaskExecutor("test", executor)
  jest.spyOn(schedulerDb, "updateTask").mockRejectedValueOnce(new Error("synthetic statistics persistence failure"))
  const run = await scheduler.runTaskNow(task.id)
  expect(run?.output).toEqual({ effectDone: true })
  await delay(300)
  expect(executor).toHaveBeenCalledTimes(1)
})

it("A7: cancel-previous starts the replacement after a cooperative executor exits", async () => {
  ;(loadSchedulerPolicy as jest.Mock).mockResolvedValue({ maxConcurrentExecutions: 1 })
  await restart()
  await delay(10)
  const task = draft()
  task.config.overlapPolicy = "cancel-previous"
  await schedulerDb.createTask(task)
  const entered = latch()
  let calls = 0, active = 0, peak = 0
  const order: string[] = []
  registerTaskExecutor("test", async (_task, _execution, signal) => {
    calls += 1; active += 1; peak = Math.max(peak, active)
    const first = calls === 1
    if (first) {
      entered.release()
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    } else { order.push("replacement-started") }
    active -= 1
    if (first) order.push("previous-exited")
    return { success: true }
  })
  const first = scheduler.runTaskNow(task.id)
  await entered.promise
  const replacement = await scheduler.runTaskNow(task.id)
  await first
  expect(active).toBe(0)
  expect(peak).toBeLessThanOrEqual(1)
  expect(replacement?.status).toBe("completed")
  expect(order).toEqual(["previous-exited", "replacement-started"])
})

it("control: pausing before the queue is popped prevents its execution", async () => {
  const task = draft()
  task.config.overlapPolicy = "queue-all"
  await schedulerDb.createTask(task)
  const entered = latch(), hold = latch()
  let calls = 0
  registerTaskExecutor("test", async () => { calls += 1; entered.release(); await hold.promise; return { success: true } })
  const first = scheduler.runTaskNow(task.id)
  await entered.promise
  expect((await scheduler.runTaskNow(task.id))?.status).toBe("pending")
  await scheduler.pauseTask(task.id)
  hold.release()
  await first
  await delay(20)
  expect(calls).toBe(1)
  expect((await schedulerDb.getTask(task.id))?.status).toBe("paused")
})
`
writeFileSync(fixture, setup + cases, { flag: "wx" })
try {
  const result = spawnSync(
    "pnpm",
    [
      "--config.verify-deps-before-run=false",
      "test",
      "--",
      "--runInBand",
      "--runTestsByPath",
      fixture,
      ...process.argv.slice(2),
    ],
    { cwd: root, stdio: "inherit" }
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  unlinkSync(fixture)
}
