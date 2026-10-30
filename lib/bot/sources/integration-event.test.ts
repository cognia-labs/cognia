/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotDef, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"
import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"
import { enqueueBotDelivery } from "@/lib/db/bot-event-deliveries"
import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"

import { dispatchIntegrationEventToBots } from "./integration-event"

const NOW = "2026-09-05T09:00:00.000Z"

const OPENED: PluginBotTriggerDef = {
  id: "opened",
  kind: "event",
  source: "integration",
  types: ["pull_request.opened"],
}

function event(overrides: Partial<IntegrationEventEnvelope> = {}): IntegrationEventEnvelope {
  return {
    schemaVersion: 1,
    id: "ie_1",
    pluginId: "github-delivery",
    integrationId: "github",
    accountId: "acct_a",
    deliveryId: "gh-delivery-7",
    eventType: "pull_request.opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: { number: 42 },
    actor: { id: "octocat", label: "Octocat" },
    resource: {
      kind: "pull_request",
      id: "42",
      url: "https://x/42",
      parent: { kind: "repo", id: "acme/web" },
    },
    ...overrides,
  }
}

async function install(accountId: string, id = "boti_1") {
  const definition: PluginBotDef = {
    id: "triage",
    name: "Triage",
    version: "1.0.0",
    executor: "handler",
    triggers: [OPENED],
  } as PluginBotDef
  registerBot("triage", { id: "acme:triage", definition, handler: jest.fn() }, { pluginId: "acme" })
  return installBot({
    id,
    definitionId: "acme:triage",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    credentialBindings: { repo: { integrationAccountId: accountId } },
    now: Date.now(),
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
  await getDb().botEventDeliveries.clear()
}, 15_000)

describe("dispatchIntegrationEventToBots", () => {
  it("enqueues a delivery for a matching installation", async () => {
    await install("acct_a")
    const result = await dispatchIntegrationEventToBots(event())

    expect(result.enqueued).toHaveLength(1)
    const [row] = result.enqueued
    expect(row.envelope.source).toBe("integration")
    expect(row.envelope.type).toBe("pull_request.opened")
    expect(row.envelope.binding?.integrationAccountId).toBe("acct_a")
  })

  it("never routes another account's events to this installation", async () => {
    await install("acct_a")
    // The difference between two teams sharing a Cognia install and two teams
    // reading each other's pull requests.
    expect((await dispatchIntegrationEventToBots(event({ accountId: "acct_b" }))).enqueued).toEqual(
      []
    )
  })

  it("makes a redelivered webhook the same event", async () => {
    await install("acct_a")
    await dispatchIntegrationEventToBots(event())
    await dispatchIntegrationEventToBots(event({ id: "ie_2" }))

    expect(await getDb().botEventDeliveries.count()).toBe(1)
  })

  it("keeps the same provider delivery ID independent across two accounts", async () => {
    await install("acct_a", "a")
    await install("acct_b", "b")
    const [first] = (await dispatchIntegrationEventToBots(event())).enqueued
    const [second] = (
      await dispatchIntegrationEventToBots(event({ id: "ie_2", accountId: "acct_b" }))
    ).enqueued
    expect(first.eventId).not.toBe(second.eventId)
    await dispatchIntegrationEventToBots(event())
    await dispatchIntegrationEventToBots(event({ id: "ie_2", accountId: "acct_b" }))
    expect(await getDb().botEventDeliveries.count()).toBe(2)
  })

  it("admits the new account's colliding delivery after rebinding the same installation", async () => {
    const installed = await install("acct_a")
    const [first] = (await dispatchIntegrationEventToBots(event())).enqueued
    await getDb().botInstallations.update(installed.id, {
      credentialBindings: { repo: { integrationAccountId: "acct_b" } },
    })
    const [second] = (
      await dispatchIntegrationEventToBots(event({ id: "ie_b", accountId: "acct_b" }))
    ).enqueued
    expect(second.id).not.toBe(first.id)
    expect(second.envelope.binding?.integrationAccountId).toBe("acct_b")
    expect(await getDb().botEventDeliveries.count()).toBe(2)
  })

  it("bounds source IDs so downstream run IDs fit the Host command contract", async () => {
    await install("acct_a")
    const [delivery] = (
      await dispatchIntegrationEventToBots(event({ deliveryId: "x".repeat(256) }))
    ).enqueued
    expect(delivery.eventId.length).toBeLessThanOrEqual(100)
  })

  it("keeps the new identity namespace disjoint from valid legacy provider IDs", async () => {
    await install("acct_a")
    const original = event({ pluginId: "v2", integrationId: "integration", deliveryId: "new-id" })
    const oldProviderId = JSON.stringify([
      original.pluginId,
      original.integrationId,
      original.accountId,
      original.deliveryId,
    ])
    const legacy = await enqueueBotDelivery({
      envelope: buildBotEventEnvelope({
        source: "integration",
        sourceRecordId: `v2:${oldProviderId}`,
        type: original.eventType,
        installationId: "boti_1",
        triggerId: "opened",
        occurredAt: Date.parse(NOW),
        payload: {},
        binding: { integrationAccountId: "acct_a" },
      }),
    })
    const [fresh] = (await dispatchIntegrationEventToBots(original)).enqueued
    expect(fresh.id).not.toBe(legacy.id)
    expect(await getDb().botEventDeliveries.count()).toBe(2)
  })

  it.each(["pending", "succeeded"] as const)(
    "reuses a %s legacy delivery and its run identity on projection recovery",
    async (status) => {
      await install("acct_a")
      const original = event()
      const legacy = await enqueueBotDelivery({
        envelope: buildBotEventEnvelope({
          source: "integration",
          sourceRecordId: `${original.pluginId}:${original.deliveryId}`,
          type: original.eventType,
          installationId: "boti_1",
          triggerId: "opened",
          occurredAt: Date.parse(NOW),
          payload: original.payload,
          binding: { integrationAccountId: "acct_a" },
        }),
      })
      await getDb().botEventDeliveries.update(legacy.id, { status, runId: "existing-run" })
      const [replayed] = (await dispatchIntegrationEventToBots(original)).enqueued
      expect(replayed).toMatchObject({
        id: legacy.id,
        eventId: legacy.eventId,
        runId: "existing-run",
        status,
      })
      expect(await getDb().botEventDeliveries.count()).toBe(1)
    }
  )

  it("does not borrow a legacy event identity belonging to another account", async () => {
    await install("acct_a", "a")
    await install("acct_b", "b")
    const original = event()
    const legacy = await enqueueBotDelivery({
      envelope: buildBotEventEnvelope({
        source: "integration",
        sourceRecordId: `${original.pluginId}:${original.deliveryId}`,
        type: original.eventType,
        installationId: "b",
        triggerId: "opened",
        occurredAt: Date.parse(NOW),
        payload: original.payload,
        binding: { integrationAccountId: "acct_b" },
      }),
    })
    const [newAccount] = (await dispatchIntegrationEventToBots(original)).enqueued
    expect(newAccount.eventId).not.toBe(legacy.eventId)
    const [replayed] = (await dispatchIntegrationEventToBots(event({ accountId: "acct_b" })))
      .enqueued
    expect(replayed.id).toBe(legacy.id)
    expect(await getDb().botEventDeliveries.count()).toBe(2)
  })

  it("projects the actor without claiming a verified identity", async () => {
    await install("acct_a")
    const [row] = (await dispatchIntegrationEventToBots(event())).enqueued

    expect(row.envelope.actor).toEqual({ kind: "human", id: "octocat", displayName: "Octocat" })
    // A webhook says who acted on the far side, not who they are here.
    expect(row.envelope.actor?.principalId).toBeUndefined()
  })

  it("projects the resource with its parent as the scope", async () => {
    await install("acct_a")
    const [row] = (await dispatchIntegrationEventToBots(event())).enqueued

    expect(row.envelope.resource).toEqual({
      kind: "pull_request",
      id: "42",
      url: "https://x/42",
      scope: "acme/web",
    })
  })

  it("falls back to now for an unparseable timestamp", async () => {
    await install("acct_a")
    const [row] = (await dispatchIntegrationEventToBots(event({ occurredAt: "not a date" })))
      .enqueued
    expect(Number.isFinite(row.envelope.occurredAt)).toBe(true)
  })

  it("marks the event as nobody's output, so the loop guard lets it through", async () => {
    await install("acct_a")
    const [row] = (await dispatchIntegrationEventToBots(event())).enqueued
    expect(row.envelope.provenance).toEqual({ selfProduced: false, depth: 0 })
  })
})

describe("dispatchIntegrationEventToBots retries", () => {
  it("re-routes only to the named installations", async () => {
    await install("acct_a", "boti_1")
    await install("acct_a", "boti_2")
    const result = await dispatchIntegrationEventToBots(event(), { installationIds: ["boti_2"] })
    expect(result.enqueued.map((row) => row.envelope.installationId)).toEqual(["boti_2"])
  })

  it("never hands a retried event to an installation created after it was projected", async () => {
    await install("acct_a")
    const result = await dispatchIntegrationEventToBots(event(), {
      installedBefore: Date.parse(NOW),
    })
    expect(result.enqueued).toEqual([])
  })

  it("reports an installation whose plugin has not registered yet as retryable", async () => {
    await install("acct_a")
    __resetBotsForTesting()
    const result = await dispatchIntegrationEventToBots(event())
    expect(result.enqueued).toEqual([])
    expect(result.unresolved).toEqual(["boti_1"])
    expect(result.retryable).toEqual(["boti_1"])
  })
})
