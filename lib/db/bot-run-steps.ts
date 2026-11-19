/**
 * Durable step checkpoints for a Bot handler.
 *
 * A handler is re-entered from the top after a crash, a Host handover, or a
 * resumed wait. These rows are what make that safe: a step that already
 * completed returns its stored output instead of running again.
 *
 * Kept out of the run journal on purpose. `runEventJournal` redacts every
 * string in an event payload, which is right for a timeline and fatal for a
 * memoized value, because the handler would carry on with corrupted data it
 * has no way to notice.
 */

import { getDb } from "@/lib/db/schema"
import type { BotRunStepRow } from "@/lib/db/bot-types"

/**
 * The host-owned checkpoint holding a settled run's final output.
 *
 * Reserved (`__host:`), so a handler cannot write it through `ctx.step`.
 */
export const BOT_RUN_RESULT_STEP = "__host:result"

/** The memoization key. Stable across re-entries by construction. */
export function botRunStepId(runId: string, name: string): string {
  return `${runId}::${name}`
}

export type BotStepBeginResult =
  { memoized: true; value: unknown } | { memoized: false; attempt: number }

/**
 * Claim a step, or hand back what it already produced.
 *
 * A `failed` step is re-entered rather than replayed: the whole point of a
 * retry is to try the failing work again, and only a completed step carries an
 * output worth trusting. The attempt counter comes back so a handler can back
 * off on its own if it wants to.
 */
export async function beginBotRunStep(
  runId: string,
  name: string,
  now = Date.now()
): Promise<BotStepBeginResult> {
  const db = getDb()
  const id = botRunStepId(runId, name)
  return db.transaction("rw", db.botRunSteps, async () => {
    const existing = await db.botRunSteps.get(id)
    if (existing?.status === "completed") {
      return { memoized: true, value: existing.output } as const
    }
    const attempt = (existing?.attempt ?? 0) + 1
    const row: BotRunStepRow = {
      id,
      runId,
      name,
      status: "running",
      attempt,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    }
    await db.botRunSteps.put(row)
    return { memoized: false, attempt } as const
  })
}

/**
 * Write a completed checkpoint. `replace` decides what an existing completed
 * row means: kept (a step's memoized value) or overwritten (the run result).
 */
async function writeCompletedStep(
  runId: string,
  name: string,
  output: unknown,
  now: number,
  replace: boolean
): Promise<void> {
  const db = getDb()
  const id = botRunStepId(runId, name)
  await db.transaction("rw", db.botRunSteps, async () => {
    const existing = await db.botRunSteps.get(id)
    if (existing?.status === "completed" && !replace) return
    await db.botRunSteps.put({
      id,
      runId,
      name,
      status: "completed",
      output,
      attempt: replace ? (existing?.attempt ?? 0) + 1 : (existing?.attempt ?? 1),
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    })
  })
}

/** Record a step's output. Idempotent: a repeat write keeps the first value. */
export async function completeBotRunStep(
  runId: string,
  name: string,
  output: unknown,
  now = Date.now()
): Promise<void> {
  await writeCompletedStep(runId, name, output, now, false)
}

/**
 * Record a step's failure.
 *
 * The row survives so the next entry knows which attempt it is on. Deleting it
 * would make every retry look like the first one, which is how a permanently
 * failing step retries forever.
 */
export async function failBotRunStep(
  runId: string,
  name: string,
  error: string,
  now = Date.now()
): Promise<void> {
  const db = getDb()
  const id = botRunStepId(runId, name)
  await db.transaction("rw", db.botRunSteps, async () => {
    const existing = await db.botRunSteps.get(id)
    if (existing?.status === "completed") return
    await db.botRunSteps.put({
      id,
      runId,
      name,
      status: "failed",
      error,
      attempt: existing?.attempt ?? 1,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    })
  })
}

/**
 * Record the output of the attempt that settled the run.
 *
 * Overwrites, unlike {@link completeBotRunStep}. A step memoizes the FIRST
 * value because a re-entry must replay what the handler already did; the
 * result is the opposite case: an attempt whose terminal commit failed is
 * retried, recomputes, and the attempt that actually committed is the one
 * whose output the run reports. Call it inside the transaction that commits
 * the run's terminal state, so the two can never disagree.
 */
export async function putBotRunResult(
  runId: string,
  output: unknown,
  now = Date.now()
): Promise<void> {
  await writeCompletedStep(runId, BOT_RUN_RESULT_STEP, output, now, true)
}

/** The host step a run's spent execution time accumulates under. */
export const BOT_RUN_EXECUTION_TIME_STEP = "__host:execution-time"

/**
 * Execution time this run has spent, in ms, over every attempt and resumed
 * segment. What `maxRunDurationMs` is measured against; a parked wait is not
 * in it.
 */
export async function readBotRunExecutionMs(runId: string): Promise<number> {
  const step = await getBotRunStep(runId, BOT_RUN_EXECUTION_TIME_STEP)
  const usedMs = (step?.output as { usedMs?: unknown } | undefined)?.usedMs
  return typeof usedMs === "number" ? usedMs : 0
}

/**
 * Add one segment's execution time and return the run's new total.
 *
 * Read-modify-write in one transaction, so two segments that end close
 * together (a lease recovery and the attempt it replaced) both count.
 */
export async function addBotRunExecutionMs(
  runId: string,
  ms: number,
  now = Date.now()
): Promise<number> {
  const db = getDb()
  const id = botRunStepId(runId, BOT_RUN_EXECUTION_TIME_STEP)
  return db.transaction("rw", db.botRunSteps, async () => {
    const existing = await db.botRunSteps.get(id)
    const previous = (existing?.output as { usedMs?: unknown } | undefined)?.usedMs
    const usedMs = (typeof previous === "number" ? previous : 0) + Math.max(0, ms)
    await db.botRunSteps.put({
      id,
      runId,
      name: BOT_RUN_EXECUTION_TIME_STEP,
      status: "completed",
      output: { usedMs },
      attempt: (existing?.attempt ?? 0) + 1,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    })
    return usedMs
  })
}

export async function getBotRunStep(
  runId: string,
  name: string
): Promise<BotRunStepRow | undefined> {
  return getDb().botRunSteps.get(botRunStepId(runId, name))
}

/** Every checkpoint of one run, in the order the handler reached them. */
export async function listBotRunSteps(runId: string): Promise<BotRunStepRow[]> {
  const rows = await getDb().botRunSteps.where("runId").equals(runId).toArray()
  return rows.sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name))
}

/**
 * Drop every checkpoint of these runs: business steps, the policy snapshot and
 * the final result alike. Joins the caller's transaction when it includes
 * `botRunSteps`, so a retention sweep removes a delivery and the checkpoints
 * it owns in one commit.
 */
export async function deleteBotRunStepsForRuns(runIds: readonly string[]): Promise<number> {
  if (runIds.length === 0) return 0
  const db = getDb()
  const ids = (
    await db.botRunSteps
      .where("runId")
      .anyOf([...runIds])
      .toArray()
  ).map((row) => row.id)
  if (ids.length === 0) return 0
  await db.botRunSteps.bulkDelete(ids)
  return ids.length
}
