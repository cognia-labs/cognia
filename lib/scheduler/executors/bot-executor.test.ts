/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot, updateBotInstallation, writeBotTriggerState } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotDef, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"
import type { ScheduledTask, TaskExecution } from "@/types/scheduler"

import { dispatchBotEvent } from "@/lib/bot/events/dispatch"
import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { claimBotDelivery } from "@/lib/db/bot-event-deliveries"
import { executeBotTask } from "./bot-executor"

const NOW = 1_700_000_000_000

function task(payload: Record<string, unknown>): ScheduledTask {
  return { id: "task_1", name: "Digest", type: "bot", payload } as ScheduledTask
}

const execution = {} as TaskExecution
const live = new AbortController().signal

async function seed(triggers: PluginBotTriggerDef[]) {
  const definition: PluginBotDef = {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers,
  } as PluginBotDef
  registerBot("digest", { id: "acme:digest", definition, handler: jest.fn() }, { pluginId: "acme" })
  return installBot({
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    now: NOW,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  const db = getDb()
  await db.botInstallations.clear()
  await db.botEventDeliveries.clear()
}, 15_000)

describe("executeBotTask", () => {
  it("shares declared concurrency across poll and event triggers", async () => {
    await seed([
      {
        id: "poll",
        kind: "poll",
        everyMs: 60000,
        concurrencyKey: "monitor",
        holdConcurrencyWhileWaiting: false,
      },
      {
        id: "event",
        kind: "event",
        source: "integration",
        types: ["push"],
        concurrencyKey: "monitor",
      },
    ])
    await executeBotTask(task({ installationId: "boti_1", triggerId: "poll" }), execution, live)
    const {
      installationId: _i,
      triggerId: _t,
      deliveryId: _d,
      ...envelope
    } = buildBotEventEnvelope({
      source: "integration",
      sourceRecordId: "push",
      type: "push",
      installationId: "",
      triggerId: "",
      occurredAt: NOW,
      receivedAt: NOW,
      payload: {},
    })
    await dispatchBotEvent({ envelope, query: { source: "integration", type: "push" }, now: NOW })
    const rows = await getDb().botEventDeliveries.toArray()
    expect(rows.map((row) => row.concurrencyKey)).toEqual(["boti_1::monitor", "boti_1::monitor"])
    expect(rows.find((row) => row.triggerId === "poll")?.holdConcurrencyWhileWaiting).toBe(false)
    const claims = await Promise.all(
      rows.map((row) => claimBotDelivery(row.id, "runner", Date.now()))
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  it("refuses a payload that names no installation or trigger", async () => {
    const result = await executeBotTask(task({}), execution, live)
    expect(result.success).toBe(false)
    expect(result.terminalReason).toBe("executor-failure")
  })

  it("enqueues a delivery for a schedule trigger", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "morning" }),
      execution,
      live
    )

    expect(result.success).toBe(true)
    const rows = await getDb().botEventDeliveries.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].envelope.source).toBe("schedule")
    expect(rows[0].envelope.type).toBe("bot.schedule")
  })

  it("gives every tick started by hand its own event, so a second is not deduplicated away", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    const payload = task({ installationId: "boti_1", triggerId: "morning" })
    const byHand = { triggerSource: "run-now" } as TaskExecution

    await executeBotTask(payload, byHand, live)
    await executeBotTask(payload, byHand, live)

    expect(await getDb().botEventDeliveries.count()).toBe(2)
  })

  it("keys a timed tick on its slot: two slots are two events, one slot fired twice is one", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    const payload = task({ installationId: "boti_1", triggerId: "morning" })
    const slot = new Date("2026-10-12T09:00:00.000Z")
    const fire = (scheduledFor: Date, triggerSource: TaskExecution["triggerSource"]) =>
      ({ scheduledFor, triggerSource }) as TaskExecution

    await executeBotTask(payload, fire(slot, "schedule"), live)
    // The same slot again, reached late by the catch-up path.
    await executeBotTask(payload, fire(slot, "catch-up"), live)
    await executeBotTask(payload, fire(new Date(slot.getTime() + 86_400_000), "schedule"), live)

    const rows = await getDb().botEventDeliveries.toArray()
    expect(rows).toHaveLength(2)
    // The event happened at the slot, not when this host fired it.
    expect(rows.map((row) => row.envelope.occurredAt).sort()).toEqual([
      slot.getTime(),
      slot.getTime() + 86_400_000,
    ])
  })

  it("leaves the cursor and edge value for the slot's first run to read (B08)", async () => {
    await seed([
      { id: "sweep", kind: "poll", everyMs: 60_000 },
      { id: "stale", kind: "derivedState", everyMs: 60_000, state: "stale" },
    ])
    await writeBotTriggerState("boti_1", "sweep", { cursor: "page-2" }, NOW)
    await writeBotTriggerState("boti_1", "stale", { lastEdgeValue: true }, NOW)

    await executeBotTask(task({ installationId: "boti_1", triggerId: "sweep" }), execution, live)
    await executeBotTask(task({ installationId: "boti_1", triggerId: "stale" }), execution, live)

    // Copied here, a second slot queued before the first committed carried the
    // same stale cursor. `runBotDelivery` pins it when the slot starts.
    const rows = await getDb().botEventDeliveries.toArray()
    const payloads = Object.fromEntries(rows.map((row) => [row.triggerId, row.envelope.payload]))
    expect(payloads.sweep).toEqual({ triggerKind: "poll" })
    expect(payloads.stale).toEqual({ triggerKind: "derivedState", state: "stale" })
  })

  it("serialises a poll or derivedState trigger's slots when it declares no key (B08)", async () => {
    await seed([
      { id: "sweep", kind: "poll", everyMs: 60_000 },
      { id: "stale", kind: "derivedState", everyMs: 60_000, state: "stale" },
      { id: "scan", kind: "poll", everyMs: 60_000, concurrencyKey: "monitor" },
    ])
    for (const triggerId of ["sweep", "stale", "scan"])
      await executeBotTask(task({ installationId: "boti_1", triggerId }), execution, live)

    const keys = Object.fromEntries(
      (await getDb().botEventDeliveries.toArray()).map((row) => [row.triggerId, row.concurrencyKey])
    )
    // Per trigger, in the host's reserved namespace; a declared key wins.
    expect(keys).toEqual({
      sweep: "boti_1::__host:trigger:sweep",
      stale: "boti_1::__host:trigger:stale",
      scan: "boti_1::monitor",
    })
  })

  it("runs two due slots of one poll trigger in turn, each on the cursor the last committed (B08)", async () => {
    const seen: string[] = []
    const handler = jest.fn(async (ctx: { event: { payload: unknown } }) => {
      const cursor = (ctx.event.payload as { cursor?: string }).cursor ?? "none"
      seen.push(cursor)
      return { output: { cursor: String(Number(cursor) + 1) } }
    })
    const definition = {
      id: "digest",
      name: "Digest",
      version: "1.0.0",
      executor: "handler",
      triggers: [{ id: "sweep", kind: "poll", everyMs: 60_000 }],
    } as PluginBotDef
    registerBot("digest", { id: "acme:digest", definition, handler }, { pluginId: "acme" })
    await installBot({
      id: "boti_1",
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
    await writeBotTriggerState("boti_1", "sweep", { cursor: "0" }, NOW)
    // Two slots due at once: a host catching up, or a run longer than the
    // interval. In parallel both read cursor 0 and handled one page twice.
    for (const minute of [0, 1]) {
      await executeBotTask(
        task({ installationId: "boti_1", triggerId: "sweep" }),
        {
          triggerSource: "schedule",
          scheduledFor: new Date(NOW + 60_000 * minute),
        } as TaskExecution,
        live
      )
    }
    const { drainBotDeliveries } = await import("@/lib/bot/runtime/delivery-runner")
    const { readBotTriggerState } = await import("@/lib/db/bot-installations")
    const host = { owner: "host", now: () => Date.now() }

    expect((await drainBotDeliveries(host)).map((attempt) => attempt.outcome.status)).toEqual([
      "completed",
    ])
    expect((await drainBotDeliveries(host)).map((attempt) => attempt.outcome.status)).toEqual([
      "completed",
    ])
    expect(seen).toEqual(["0", "1"])
    expect((await readBotTriggerState("boti_1", "sweep"))?.cursor).toBe("2")
  })

  it("enqueues nothing for a trigger disarmed before its tick reached intake (B07)", async () => {
    await seed([{ id: "sweep", kind: "poll", everyMs: 60_000 }])
    await updateBotInstallation("boti_1", { triggerOverrides: { sweep: false } })

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "sweep" }),
      execution,
      live
    )

    expect(result).toMatchObject({ success: true, output: { skipped: "trigger-disarmed" } })
    expect(await getDb().botEventDeliveries.count()).toBe(0)
  })

  it("refuses to fire a trigger the scheduler does not own", async () => {
    await seed([{ id: "opened", kind: "event", source: "integration", types: ["x"] }])

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "opened" }),
      execution,
      live
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("which the scheduler does not fire")
  })

  it("is terminal when the installation is gone", async () => {
    const result = await executeBotTask(
      task({ installationId: "boti_missing", triggerId: "x" }),
      execution,
      live
    )
    // Every future tick would fail the same way, so the scheduler is told to
    // stop rather than retry forever.
    expect(result.terminalReason).toBe("executor-failure")
  })

  it("fails without a terminal reason when the installation is merely disabled", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    await updateBotInstallation("boti_1", { status: "disabled" })

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "morning" }),
      execution,
      live
    )
    // Re-enabling it should start working again without touching the schedule.
    expect(result.success).toBe(false)
    expect(result.terminalReason).toBeUndefined()
  })

  it("does nothing once aborted", async () => {
    await seed([{ id: "morning", kind: "schedule", cron: "0 9 * * *" }])
    const controller = new AbortController()
    controller.abort()

    const result = await executeBotTask(
      task({ installationId: "boti_1", triggerId: "morning" }),
      execution,
      controller.signal
    )
    expect(result.success).toBe(false)
    expect(await getDb().botEventDeliveries.count()).toBe(0)
  })
})
