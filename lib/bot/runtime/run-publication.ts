/**
 * The `bot.run.*` events settled runs owe the Bot plane.
 *
 * A transactional outbox, kept on the delivery row (`runPublication`). Whatever
 * settles a run stages the event in the SAME transaction as the run's terminal
 * state; this module dispatches it afterwards and clears the stage. Dispatching
 * straight from the settling code, after its commit and without a record, was
 * how an event went missing: a host stopping between the two lost it, and the
 * failure paths never dispatched one at all.
 *
 * A second dispatch is harmless. The envelope's event id is derived from the
 * run id and the status, and the queue folds a redelivery of one event onto
 * one delivery per subscriber, so the flush can retry without a subscriber
 * ever seeing the same settlement twice.
 */

import type { BotDeadletterSettler } from "@/lib/db/bot-event-deliveries"
import type { BotEventDeliveryRow, BotRunPublication } from "@/lib/db/bot-types"
import { appendRunEventInsideTransaction, semanticRunEvent } from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { isTerminalRunStatus } from "@/types/execution/run"

/** How often a runner re-dispatches events a failed or interrupted dispatch left staged. */
export const BOT_RUN_PUBLICATION_FLUSH_INTERVAL_MS = 60_000

export interface PublishBotRunDeps {
  dispatch?: (input: {
    runId: string
    installationId: string
    botId: string
    status: BotRunPublication["status"]
    summary?: string
    cause: BotEventDeliveryRow["envelope"]
  }) => Promise<unknown>
}

async function defaultDispatch(
  input: Parameters<NonNullable<PublishBotRunDeps["dispatch"]>>[0]
): Promise<unknown> {
  const { dispatchBotRunToBots } = await import("@/lib/bot/sources/bot-run")
  return dispatchBotRunToBots(input)
}

/**
 * Dispatch the event one delivery's settled run staged, then clear the stage.
 *
 * Returns false when there was nothing to publish. Throws when the dispatch
 * itself failed, leaving the stage in place for the next flush.
 */
export async function publishStagedBotRunEvent(
  deliveryId: string,
  deps: PublishBotRunDeps = {}
): Promise<boolean> {
  const db = getDb()
  const row = await db.botEventDeliveries.get(deliveryId)
  const publication = row?.runPublication
  if (!row || !publication || !row.runId || row.syncedFromHost) return false
  await (deps.dispatch ?? defaultDispatch)({
    runId: row.runId,
    installationId: row.installationId,
    botId: publication.botId,
    status: publication.status,
    ...(publication.summary ? { summary: publication.summary } : {}),
    cause: row.envelope,
  })
  await db.transaction("rw", db.botEventDeliveries, async () => {
    const current = await db.botEventDeliveries.get(deliveryId)
    // Only the stage this call dispatched. A retry that settled the run again
    // in the meantime staged its own, and that one still has to go out.
    if (
      !current?.runPublication ||
      current.runPublication.stagedAt !== publication.stagedAt ||
      current.runPublication.status !== publication.status
    )
      return
    const next = { ...current }
    delete next.runPublication
    await db.botEventDeliveries.put(next)
  })
  return true
}

/**
 * Publish every event still staged. Each failure is isolated so one broken
 * subscriber route cannot hold back the rest; it stays staged for next time.
 */
export async function flushStagedBotRunPublications(deps: PublishBotRunDeps = {}): Promise<number> {
  const staged = await getDb()
    .botEventDeliveries.filter((row) => row.runPublication !== undefined && !row.syncedFromHost)
    .toArray()
  let published = 0
  for (const row of staged) {
    try {
      if (await publishStagedBotRunEvent(row.id, deps)) published += 1
    } catch {
      // Left staged. The next flush tries again.
    }
  }
  return published
}

/**
 * Fail the run a recovery dead-lettered, and stage the `bot.run.failed` event
 * it owes. The {@link BotDeadletterSettler} every recovery path takes.
 *
 * Runs inside the recovery's transaction. A run already settled is left as it
 * is, and without an installation there is nothing to attribute the event to
 * and nobody whose subscribers it would wake.
 */
export const settleDeadletteredBotRun: BotDeadletterSettler = async (row, now) => {
  if (!row.runId) return row
  const db = getDb()
  const run = await db.executionRuns.get(row.runId)
  if (!run || isTerminalRunStatus(run.status)) return row
  await appendRunEventInsideTransaction(
    db,
    row.runId,
    semanticRunEvent(
      "run.failed",
      { error: row.lastError ?? "Bot delivery dead-lettered" },
      { ts: now, sourceEventId: `run.failed:${row.id}` }
    )
  )
  const installation = await db.botInstallations.get(row.installationId)
  return installation
    ? {
        ...row,
        runPublication: { status: "failed", botId: installation.definitionId, stagedAt: now },
      }
    : row
}
