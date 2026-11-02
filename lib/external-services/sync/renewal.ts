import Dexie from "dexie"
import { getDb } from "@/lib/db/schema"
import { listExternalSyncSubscriptions } from "@/lib/db/external-sync"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getTaskScheduler } from "@/lib/scheduler/task-scheduler"
import { SILENT_MAINTENANCE_NOTIFICATION } from "@/lib/scheduler/maintenance-tasks"
import type { CreateScheduledTaskInput, ScheduledTask, TaskExecution } from "@/types/scheduler"
import { externalSyncBackoff } from "./core"
import { requestExternalSync } from "./runtime"
import type { ExternalSyncRenewer, ExternalSyncSubscription } from "./types"

export const EXTERNAL_SYNC_RENEWAL_SWEEP_ID = "system:external-sync-renewal-sweep"
export const externalSyncRenewalTaskId = (key: string) => `external-sync-renewal::${key}`
const renewers = new Map<string, ExternalSyncRenewer>()
const running = new Map<string, AbortController>()
let scheduling: Promise<void> = Promise.resolve()

function schedule(task: () => Promise<void>): Promise<void> {
  // A disposer may run while a cursor transaction is yielding. Scheduler
  // work must not inherit that transaction's narrower table scope.
  const next = scheduling.then(() => Dexie.ignoreTransaction(task))
  scheduling = next.catch(() => undefined)
  return next
}

const reportScheduleFailure = () => console.warn("External sync renewal scheduling failed")

/** Dormant: no shipped provider registers this yet (ADR-0246 P8). */
export function registerExternalSyncRenewer(key: string, renew: ExternalSyncRenewer): () => void {
  if (renewers.has(key)) throw new Error("External sync renewer already registered")
  renewers.set(key, renew)
  void schedule(async () => {
    const sub = (await getDb().externalSyncCursors.get(key))?.subscription
    if (sub) await arm(key, sub, Date.now())
    await syncSweep()
  }).catch(reportScheduleFailure)
  return () => {
    if (renewers.get(key) === renew) {
      void abortExternalSyncRenewal(key).catch(reportScheduleFailure)
    }
  }
}

export function abortExternalSyncRenewal(key: string): Promise<void> {
  running.get(key)?.abort()
  renewers.delete(key)
  return schedule(async () => {
    await getTaskScheduler().deleteTask(externalSyncRenewalTaskId(key))
    await syncSweep()
  })
}

function taskInput(
  id: string,
  trigger: ScheduledTask["trigger"],
  payload: Record<string, unknown>
): CreateScheduledTaskInput {
  return {
    id,
    name: "External sync renewal (inert; no shipped provider)",
    type: "external-sync-renewal",
    trigger,
    payload,
    config: { maxRetries: 0, allowConcurrent: false, runMissedOnStartup: false },
    notification: { ...SILENT_MAINTENANCE_NOTIFICATION },
    tags: ["system:external-sync", "inert"],
  }
}

async function arm(
  key: string,
  sub: ExternalSyncSubscription,
  now: number,
  signal?: AbortSignal
): Promise<void> {
  const id = externalSyncRenewalTaskId(key)
  signal?.throwIfAborted()
  const existing = await schedulerDb.getTask(id)
  signal?.throwIfAborted()
  if (!renewers.has(key)) {
    if (existing) await getTaskScheduler().deleteTask(id)
    return
  }
  const runAt = new Date(Math.max(now + 1000, sub.renewAt))
  if (
    existing?.status === "active" &&
    existing.trigger.type === "once" &&
    existing.trigger.runAt?.getTime() === runAt.getTime()
  )
    return
  const input = taskInput(id, { type: "once", runAt }, { key })
  if (existing) await getTaskScheduler().updateTask(id, { ...input, status: "active" })
  else await getTaskScheduler().createTask(input)
  // Teardown may race a scheduler call that yielded after the cursor read.
  const current = (await getDb().externalSyncCursors.get(key))?.subscription
  if (
    signal?.aborted ||
    !renewers.has(key) ||
    !current ||
    current.id !== sub.id ||
    current.renewAt !== sub.renewAt
  )
    await getTaskScheduler().deleteTask(id)
  signal?.throwIfAborted()
}

export async function setExternalSyncSubscription(
  key: string,
  subscription: { id: string; expiresAt: number },
  now = Date.now()
): Promise<void> {
  await commitSubscription(key, subscription, now)
}

/** Renewal uses a signal and compare-and-swap fence; the public setter stays unchanged. */
async function commitSubscription(
  key: string,
  subscription: { id: string; expiresAt: number },
  now: number,
  guard?: { signal: AbortSignal; expected: ExternalSyncSubscription }
): Promise<void> {
  if (!subscription.id || !Number.isFinite(subscription.expiresAt))
    throw new Error("Invalid external sync subscription")
  const sub: ExternalSyncSubscription = {
    ...subscription,
    renewAt: subscription.expiresAt - Math.max((subscription.expiresAt - now) * 0.1, 5 * 60_000),
    state: "active",
    attempts: 0,
  }
  const db = getDb()
  const updated = await db.transaction("rw", db.externalSyncCursors, async () => {
    guard?.signal.throwIfAborted()
    const current = await db.externalSyncCursors.get(key)
    guard?.signal.throwIfAborted()
    if (
      guard &&
      (!current?.subscription ||
        current.subscription.id !== guard.expected.id ||
        current.subscription.renewAt !== guard.expected.renewAt)
    )
      return false
    if (!(await db.externalSyncCursors.update(key, { subscription: sub })))
      throw new Error("External sync target is not persisted")
    // An abort while IndexedDB was updating must roll back the same transaction.
    guard?.signal.throwIfAborted()
    return true
  })
  if (!updated) return
  await scheduleArm(key, sub, now, guard?.signal)
}

function scheduleArm(
  key: string,
  sub: ExternalSyncSubscription,
  now: number,
  signal?: AbortSignal
): Promise<void> {
  return schedule(async () => {
    try {
      await arm(key, sub, now, signal)
    } finally {
      if (signal?.aborted) await getTaskScheduler().deleteTask(externalSyncRenewalTaskId(key))
      await syncSweep()
    }
  })
}

/** Hourly backstop exists only for persisted subscriptions with a registered renewer. */
export async function syncExternalSyncRenewalSchedule(now = Date.now()): Promise<void> {
  await schedule(async () => {
    for (const row of await listExternalSyncSubscriptions()) {
      if (renewers.has(row.key)) await arm(row.key, row.subscription!, now)
      else await getTaskScheduler().deleteTask(externalSyncRenewalTaskId(row.key))
    }
    await syncSweep()
  })
}

async function syncSweep(): Promise<void> {
  const rows = (await listExternalSyncSubscriptions()).filter((row) => renewers.has(row.key))
  const existing = await schedulerDb.getTask(EXTERNAL_SYNC_RENEWAL_SWEEP_ID)
  if (!rows.length) {
    if (existing) await getTaskScheduler().deleteTask(existing.id)
    return
  }
  const input = taskInput(
    EXTERNAL_SYNC_RENEWAL_SWEEP_ID,
    { type: "interval", intervalMs: 60 * 60_000 },
    { sweep: true }
  )
  if (!existing) await getTaskScheduler().createTask(input)
  else if (
    existing.status !== "active" ||
    existing.trigger.type !== "interval" ||
    existing.trigger.intervalMs !== 60 * 60_000
  )
    await getTaskScheduler().updateTask(existing.id, { ...input, status: "active" })
}

export async function executeExternalSyncRenewalTask(
  task: ScheduledTask,
  _execution: TaskExecution,
  signal: AbortSignal
): Promise<{ success: boolean; error?: string; output?: Record<string, unknown> }> {
  if (task.id === EXTERNAL_SYNC_RENEWAL_SWEEP_ID) {
    await syncExternalSyncRenewalSchedule()
    return { success: true }
  }
  const key = typeof task.payload?.key === "string" ? task.payload.key : undefined
  if (!key || task.id !== externalSyncRenewalTaskId(key))
    return { success: false, error: "invalid-renewal-task" }
  if (running.has(key)) return { success: true, output: { busy: true } }
  const row = await getDb().externalSyncCursors.get(key)
  const renew = renewers.get(key)
  if (!renew) {
    await abortExternalSyncRenewal(key)
    return { success: true, output: { paused: true } }
  }
  if (!row?.subscription) return { success: true, output: { removed: true } }
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) abort()
  signal.addEventListener("abort", abort, { once: true })
  running.set(key, controller)
  const sub = row.subscription
  try {
    controller.signal.throwIfAborted()
    const next = await renew(sub, controller.signal)
    controller.signal.throwIfAborted()
    await commitSubscription(key, next, Date.now(), { signal: controller.signal, expected: sub })
    controller.signal.throwIfAborted()
    return { success: true }
  } catch {
    if (controller.signal.aborted) {
      await schedule(async () => {
        await getTaskScheduler().deleteTask(externalSyncRenewalTaskId(key))
        await syncSweep()
      })
      return { success: false, error: "cancelled" }
    }
    const now = Date.now()
    let updated = false
    try {
      await getDb().transaction("rw", getDb().externalSyncCursors, async () => {
        controller.signal.throwIfAborted()
        const current = (await getDb().externalSyncCursors.get(key))?.subscription
        if (
          !current ||
          current.id !== sub.id ||
          current.renewAt !== sub.renewAt ||
          controller.signal.aborted
        )
          return
        const attempts = current.attempts + 1
        await getDb().externalSyncCursors.update(key, {
          subscription: {
            ...current,
            state: "renew-failed",
            attempts,
            renewAt: now + externalSyncBackoff(attempts),
          },
        })
        controller.signal.throwIfAborted()
        updated = true
      })
    } catch (error) {
      if (controller.signal.aborted) return { success: false, error: "cancelled" }
      throw error
    }
    if (updated) {
      if (now >= sub.expiresAt) requestExternalSync(key, "manual", { full: true })
      const current = (await getDb().externalSyncCursors.get(key))?.subscription
      if (current && !controller.signal.aborted) {
        try {
          await scheduleArm(key, current, now, controller.signal)
        } catch (error) {
          if (!controller.signal.aborted) throw error
        }
      }
    }
    if (controller.signal.aborted) return { success: false, error: "cancelled" }
    return { success: false, error: "renewal-failed" }
  } finally {
    signal.removeEventListener("abort", abort)
    if (running.get(key) === controller) running.delete(key)
  }
}

export async function deleteExternalSyncRenewalTask(key: string): Promise<void> {
  await abortExternalSyncRenewal(key)
}
