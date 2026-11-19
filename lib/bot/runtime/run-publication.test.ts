/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import { installBot } from "@/lib/db/bot-installations"
import { getExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"

import {
  flushStagedBotRunPublications,
  publishStagedBotRunEvent,
  settleDeadletteredBotRun,
} from "./run-publication"

const NOW = 1_700_000_000_000

function envelope(id: string): BotEventEnvelopeV1 {
  return {
    eventId: `bev_${id}`,
    deliveryId: `bdl_${id}`,
    source: "integration",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: {},
    provenance: { selfProduced: false, depth: 0 },
  }
}

async function staged(id: string, status: "completed" | "failed" = "completed") {
  const row = await enqueueBotDelivery({ envelope: envelope(id), now: NOW })
  await getDb().botEventDeliveries.update(row.id, {
    runId: `run_bot_${row.id}`,
    status: "succeeded",
    runPublication: { status, botId: "acme:digest", summary: "done", stagedAt: NOW },
  })
  return row.id
}

beforeEach(async () => {
  __resetDbForTesting()
  const db = getDb()
  await db.botEventDeliveries.clear()
  await db.botInstallations.clear()
  await db.executionRuns.clear()
  await db.executionRunEvents.clear()
}, 15_000)

async function deadLetteredWithRun(status = "running") {
  const row = await enqueueBotDelivery({ envelope: envelope("9"), now: NOW })
  await getDb().executionRuns.add({
    id: `run_bot_${row.id}`,
    kind: "bot",
    sourceId: "boti_1",
    title: "Digest",
    status,
    currentRevision: 0,
    startedAt: NOW,
    updatedAt: NOW,
  } as never)
  return {
    ...row,
    status: "deadletter" as const,
    runId: `run_bot_${row.id}`,
    lastError: "bot run interrupted: the host stopped mid-attempt",
  }
}

/** Run the settler the way a recovery does: inside its transaction. */
function settleInTransaction(row: Awaited<ReturnType<typeof deadLetteredWithRun>>) {
  const db = getDb()
  return db.transaction(
    "rw",
    [
      db.botEventDeliveries,
      db.botInstallations,
      db.executionRuns,
      db.executionRunEvents,
      db.notificationProjectionWork,
    ],
    () => settleDeadletteredBotRun(row, NOW + 5)
  )
}

describe("settleDeadletteredBotRun", () => {
  it("fails the run with the delivery and stages its bot.run.failed (B06)", async () => {
    await installBot({
      id: "boti_1",
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
    const row = await deadLetteredWithRun()

    const settled = await settleInTransaction(row)

    expect(settled.runPublication).toEqual({
      status: "failed",
      botId: "acme:digest",
      stagedAt: NOW + 5,
    })
    expect((await getExecutionRun(row.runId))?.status).toBe("failed")
    expect((await runEventJournal.replay(row.runId)).at(-1)).toMatchObject({
      type: "run.failed",
      payload: { error: expect.stringContaining("interrupted") },
    })
  })

  it("leaves an already settled run alone", async () => {
    const row = await deadLetteredWithRun("completed")
    expect(await settleInTransaction(row)).toBe(row)
    expect((await getExecutionRun(row.runId))?.status).toBe("completed")
  })

  it("fails the run but stages nothing for an installation that is gone", async () => {
    const row = await deadLetteredWithRun()
    const settled = await settleInTransaction(row)
    expect(settled.runPublication).toBeUndefined()
    expect((await getExecutionRun(row.runId))?.status).toBe("failed")
  })
})

describe("publishStagedBotRunEvent", () => {
  it("dispatches the staged event and clears the stage", async () => {
    const id = await staged("1")
    const dispatch = jest.fn().mockResolvedValue(undefined)

    expect(await publishStagedBotRunEvent(id, { dispatch })).toBe(true)
    expect(dispatch).toHaveBeenCalledWith({
      runId: `run_bot_${id}`,
      installationId: "boti_1",
      botId: "acme:digest",
      status: "completed",
      summary: "done",
      cause: expect.objectContaining({ eventId: "bev_1" }),
    })
    expect((await getDb().botEventDeliveries.get(id))?.runPublication).toBeUndefined()
  })

  it("leaves the stage in place when the dispatch fails", async () => {
    const id = await staged("1", "failed")
    const dispatch = jest.fn().mockRejectedValue(new Error("router down"))

    await expect(publishStagedBotRunEvent(id, { dispatch })).rejects.toThrow("router down")
    expect((await getDb().botEventDeliveries.get(id))?.runPublication).toMatchObject({
      status: "failed",
    })
  })

  it("does not clear a newer stage written while the older one was dispatching", async () => {
    const id = await staged("1")
    const dispatch = jest.fn(async () => {
      await getDb().botEventDeliveries.update(id, {
        runPublication: { status: "failed", botId: "acme:digest", stagedAt: NOW + 1 },
      })
    })

    await publishStagedBotRunEvent(id, { dispatch })
    expect((await getDb().botEventDeliveries.get(id))?.runPublication).toMatchObject({
      status: "failed",
      stagedAt: NOW + 1,
    })
  })

  it("publishes nothing for a row without a stage or a mirrored row", async () => {
    const plain = await enqueueBotDelivery({ envelope: envelope("2"), now: NOW })
    const mirrored = await staged("3")
    await getDb().botEventDeliveries.update(mirrored, { syncedFromHost: true })
    const dispatch = jest.fn()

    expect(await publishStagedBotRunEvent(plain.id, { dispatch })).toBe(false)
    expect(await publishStagedBotRunEvent(mirrored, { dispatch })).toBe(false)
    expect(await publishStagedBotRunEvent("missing", { dispatch })).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe("flushStagedBotRunPublications", () => {
  it("publishes every stage, isolating one failing dispatch from the rest", async () => {
    const first = await staged("1")
    const second = await staged("2", "failed")
    const dispatch = jest.fn(async (input: { runId: string }) => {
      if (input.runId === `run_bot_${first}`) throw new Error("route broken")
    })

    expect(await flushStagedBotRunPublications({ dispatch })).toBe(1)
    expect((await getDb().botEventDeliveries.get(first))?.runPublication).toBeDefined()
    expect((await getDb().botEventDeliveries.get(second))?.runPublication).toBeUndefined()
  })
})
