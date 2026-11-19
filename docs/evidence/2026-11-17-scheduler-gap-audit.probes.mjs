#!/usr/bin/env node
// Isolated audit assertions, kept out of the normal green regression suite.
// A temporary co-located fixture lets the repository's actual Jest entry point
// resolve the same modules as the existing scheduler integration suite.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const root = process.cwd()
const fixture = resolve(root, "lib/scheduler/scheduler-gap-audit-2026-11-17.test.ts")
const formFixture = resolve(root, "components/scheduler/scheduler-gap-audit-2026-11-17.test.tsx")
if (existsSync(fixture)) throw new Error(`Refusing to overwrite ${fixture}`)
if (existsSync(formFixture)) throw new Error(`Refusing to overwrite ${formFixture}`)
mkdirSync(resolve(root, ".cache/scheduler-gap-audit-2026-11-17"), { recursive: true })
const source = String.raw`/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { schedulerDb } from "./scheduler-db"
import { createTaskScheduler, registerTaskExecutor, unregisterTaskExecutor } from "./task-scheduler"
import { loadSchedulerPolicy } from "./write-authority"
import type { ScheduledTask, SchedulerTimingDriver } from "@/types/scheduler"

jest.mock("@/lib/db/schema", () => {
  const actual = jest.requireActual("@/lib/db/schema")
  const db = new actual.CogniaDB("scheduler-gap-audit-2026-11-17", "scheduler-gap-audit")
  return { ...actual, getDb: () => db }
})
jest.mock("./write-authority", () => ({ loadSchedulerPolicy: jest.fn(async () => ({ maxConcurrentExecutions: 5 })) }))
jest.mock("./task-workspace-binding", () => ({ resolveTaskWorkspace: async () => undefined, backfillSessionWorkspace: async () => null }))
jest.mock("./notification-integration", () => ({ notifyTaskEvent: jest.fn(async () => {}) }))
jest.mock("./event-integration", () => ({ emitSchedulerEvent: jest.fn(async () => {}) }))
jest.mock("./task-completion-linkage", () => ({ dispatchScheduledTaskSettled: jest.fn(async () => {}) }))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ hasAnyHook: () => false, dispatchScheduledTaskCreate() {}, dispatchScheduledTaskUpdate() {}, dispatchScheduledTaskDelete() {}, dispatchScheduledTaskPause() {}, dispatchScheduledTaskResume() {} }),
  getPluginLifecycleHooks: () => ({ dispatchOnScheduledTaskStart() {}, dispatchOnScheduledTaskComplete() {}, dispatchOnScheduledTaskError() {} }),
}))
jest.mock("@cognia/logging", () => {
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  return { loggers: new Proxy({}, { get: () => logger }), createLogger: () => logger }
})

function timing(): SchedulerTimingDriver {
  return { supportsLeaderElection: false, async start() {}, stop() {}, onDue() {}, arm() {}, disarm() {} }
}
function draft(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const now = new Date()
  return {
    id: "audit-task", name: "audit task", type: "test", status: "active", payload: {},
    trigger: { type: "interval", intervalMs: 60_000 },
    config: { maxRetries: 0, retryDelay: 100, maxRetryDelay: 100, timeout: 30_000, overlapPolicy: "skip", runMissedOnStartup: true, maxMissedRuns: 2 },
    notification: { onStart: false, onComplete: false, onError: false },
    nextRunAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now,
    runCount: 0, successCount: 0, failureCount: 0, ...overrides,
  }
}
function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let scheduler: ReturnType<typeof createTaskScheduler>
beforeEach(async () => {
  ;(loadSchedulerPolicy as jest.Mock).mockResolvedValue({ maxConcurrentExecutions: 5 })
  await schedulerDb.clearAll()
  scheduler = createTaskScheduler(timing(), { rng: () => 0 })
  await scheduler.initialize()
})
afterEach(async () => {
  scheduler.stop()
  jest.restoreAllMocks()
  unregisterTaskExecutor("test")
  await schedulerDb.clearAll()
})
afterAll(async () => { await getDb().delete() })
async function restart() {
  scheduler.stop()
  scheduler = createTaskScheduler(timing(), { rng: () => 0 })
  await scheduler.initialize()
}

it("control: an ordinary execution completes and persists", async () => {
  await schedulerDb.createTask(draft())
  registerTaskExecutor("test", async () => ({ success: true }))
  const run = await scheduler.runTaskNow("audit-task")
  expect(run.status).toBe("completed")
  expect(await schedulerDb.getExecution(run.id)).toMatchObject({ status: "completed" })
})

it("control: a retry executes while its original process stays alive", async () => {
  const task = draft()
  task.config.maxRetries = 1
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: false, error: "synthetic transient" }))
  registerTaskExecutor("test", executor)
  const run = await scheduler.runTaskNow(task.id)
  expect(run.terminalReason).toBe("retry-scheduled")
  await delay(300)
  expect(executor).toHaveBeenCalledTimes(2)
})

it("F1: recovers a persisted retry after process replacement", async () => {
  const task = draft()
  task.config.maxRetries = 1
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: false, error: "synthetic transient" }))
  registerTaskExecutor("test", executor)
  const run = await scheduler.runTaskNow(task.id)
  expect(run.terminalReason).toBe("retry-scheduled")
  expect((await schedulerDb.getExecution(run.id))?.retryScheduledAt).toBeDefined()
  await restart()
  await delay(300)
  expect(executor).toHaveBeenCalledTimes(2)
})

it("F2: recovers a slot whose cursor commit preceded its execution record", async () => {
  const slot = new Date(Date.now() - 1_000)
  const next = new Date(slot.getTime() + 60_000)
  const task = draft({ nextRunAt: slot })
  await schedulerDb.createTask(task)
  const executor = jest.fn(async () => ({ success: true }))
  registerTaskExecutor("test", executor)
  // Exact production durable boundary: claimTaskSlot commits before startTask
  // creates an execution row. Simulate process loss at this boundary.
  expect(await schedulerDb.claimTaskSlot(task.id, slot, next)).not.toBeNull()
  expect(await schedulerDb.getTaskExecutions(task.id)).toHaveLength(0)
  await restart()
  await (scheduler as unknown as { checkMissedTasks(): Promise<void> }).checkMissedTasks()
  expect(await schedulerDb.getTask(task.id)).toMatchObject({ runCount: 1, nextRunAt: next })
  expect(executor).toHaveBeenCalledTimes(1)
})

it("F3: retains a buffered start across process replacement", async () => {
  const task = draft()
  task.config.overlapPolicy = "queue-all"
  await schedulerDb.createTask(task)
  const entered = latch()
  const hold = latch()
  const executor = jest.fn(async () => { entered.release(); await hold.promise; return { success: true } })
  registerTaskExecutor("test", executor)
  const first = scheduler.runTaskNow(task.id)
  await entered.promise
  const queued = await scheduler.runTaskNow(task.id)
  expect(queued.status).toBe("pending")
  const queuedRow = await schedulerDb.getExecution(queued.id)
  scheduler.stop()
  hold.release()
  await first
  scheduler = createTaskScheduler(timing())
  await scheduler.initialize()
  await delay(30)
  expect({ persisted: queuedRow !== null, calls: executor.mock.calls.length }).toEqual({ persisted: true, calls: 2 })
})

it("F4: preserves a public pause racing a completion statistics write", async () => {
  const task = draft()
  await schedulerDb.createTask(task)
  registerTaskExecutor("test", async () => ({ success: true }))
  const entered = latch()
  const hold = latch()
  const getTask = schedulerDb.getTask.bind(schedulerDb)
  let held = false
  jest.spyOn(schedulerDb, "getTask").mockImplementation(async (id) => {
    const inStats = new Error().stack?.includes("updateTaskStats")
    const row = await getTask(id)
    if (inStats && !held) { held = true; entered.release(); await hold.promise }
    return row
  })
  const run = scheduler.runTaskNow(task.id)
  await entered.promise
  try {
    expect(await scheduler.pauseTask(task.id)).toBe(true)
    expect((await getTask(task.id))?.status).toBe("paused")
  } finally { hold.release() }
  await run
  expect((await getTask(task.id))?.status).toBe("paused")
})

it("F5: counts two simultaneously completing successful executions", async () => {
  const task = draft()
  task.config.overlapPolicy = "allow"
  await schedulerDb.createTask(task)
  const both = latch()
  let entered = 0
  registerTaskExecutor("test", async () => { entered += 1; if (entered === 2) both.release(); await both.promise; return { success: true } })
  const runs = await Promise.all([scheduler.runTaskNow(task.id), scheduler.runTaskNow(task.id)])
  expect(runs.map((run) => run.status)).toEqual(["completed", "completed"])
  expect(await schedulerDb.getTask(task.id)).toMatchObject({ runCount: 2, successCount: 2 })
})

it("F7: cancel-previous starts the replacement at a host cap of one", async () => {
  ;(loadSchedulerPolicy as jest.Mock).mockResolvedValue({ maxConcurrentExecutions: 1 })
  await restart()
  await delay(10)
  const task = draft()
  task.config.overlapPolicy = "cancel-previous"
  await schedulerDb.createTask(task)
  const entered = latch()
  const hold = latch()
  let calls = 0
  registerTaskExecutor("test", async () => {
    calls += 1
    if (calls === 1) { entered.release(); await hold.promise }
    return { success: true }
  })
  const first = scheduler.runTaskNow(task.id)
  await entered.promise
  const replacement = await scheduler.runTaskNow(task.id)
  hold.release()
  await first
  expect(replacement).toMatchObject({ status: "completed", terminalReason: "completed" })
})
`
writeFileSync(fixture, source, { flag: "wx" })
const formBase = readFileSync(resolve(root, "components/scheduler/task-form.test.tsx"), "utf8")
const formPrefix = formBase
  .slice(0, formBase.indexOf('describe("TaskForm",'))
  .replace(
    "import { render, screen, fireEvent }",
    "import { act, render, screen, fireEvent, within }"
  )
if (!formPrefix || formPrefix === formBase) {
  unlinkSync(fixture)
  throw new Error("Existing TaskForm fixture structure changed; review the audit fixture first")
}
const formSource =
  formPrefix +
  String.raw`
it("F6: preserves a saved zero retry count in the edit form", async () => {
  await act(async () => {
    render(<TaskForm initialValues={{ name: "audit", config: { maxRetries: 0 } }} onSubmit={jest.fn(async () => undefined)} onCancel={jest.fn()} />)
  })
  const label = screen.getByText("maxRetries")
  const input = within(label.parentElement!).getByRole("spinbutton")
  expect(input).toHaveValue(0)
})
`
try {
  writeFileSync(formFixture, formSource, { flag: "wx" })
  const result = spawnSync(
    "pnpm",
    [
      "--config.verify-deps-before-run=false",
      "test",
      "--",
      "--runInBand",
      "--runTestsByPath",
      fixture,
      formFixture,
      ...process.argv.slice(2),
    ],
    { cwd: root, stdio: "inherit" }
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  unlinkSync(fixture)
  if (existsSync(formFixture)) unlinkSync(formFixture)
}
