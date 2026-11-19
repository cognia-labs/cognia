/** @jest-environment jsdom */
// Additional isolated probes: the original audit only observes queue rows.
// These exercise the real governed producer and real runner before a fake adapter.
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import {
  prepareGovernedNotificationDelivery,
  persistGovernedNotificationInsideTransaction,
} from "@/lib/notifications/delivery/governed"
import { cancelNotificationDelivery } from "@/lib/notifications/api"
import {
  startOutboundRunner,
  __resetAdapterRuntimeStateForTesting,
} from "@/lib/connectors/outbound-runner"
import { __setNotificationIdentityForTesting } from "@/lib/notifications/scope"
import type { PlatformAdapter } from "@/types/connectors"

// The extension callback is irrelevant to this probe. Keep every DB,
// authorization, personal-sink check, and runner state transition real.
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchConnectorDecision: async () => ({ action: "allow" }) }),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({ trackEvent: async () => true }))

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  __resetAdapterRuntimeStateForTesting()
  __setNotificationIdentityForTesting({ namespaceId: "ns", accountId: "a", authorityHostId: "h" })
})
afterAll(async () => {
  __setNotificationIdentityForTesting(null)
  await fixture.dispose()
})

async function produce() {
  const target = await upsertNotificationTarget({
    scope: { namespaceId: "ns", accountId: "a", authorityHostId: "h" },
    label: "test connector",
    address: {
      kind: "connector",
      adapterId: "audit-adapter",
      conversationKey: "telegram:audit-adapter:chat",
      deliveryTarget: {
        conversationRef: { platform: "telegram", adapterId: "audit-adapter" },
        address: {
          conversationKey: "telegram:audit-adapter:chat",
          platform: "telegram",
          adapterId: "audit-adapter",
          scopeKind: "group",
          containerId: "chat",
        },
        refreshedAt: Date.now(),
      },
    },
    enabled: true,
    consent: { mode: "proactive", grantRef: "audit", grantedBy: "a", grantedAt: Date.now() },
    disclosureProfileId: "internal",
    locale: "en",
    timezone: "UTC",
  })
  const prepared = await prepareGovernedNotificationDelivery({
    targetId: target.id,
    payload: {
      title: "AuditOriginalPayload",
      body: "Body",
      level: "info",
      disclosureLevel: "internal",
      clippedFactCount: 0,
      contentHash: "audit-hash",
    },
    purpose: "terminal-state",
    category: "run.terminal",
    operationKey: "audit-real-runner",
  })
  const db = getDb()
  return db.transaction(
    "rw",
    [
      db.outboundQueue,
      db.notificationDeliveryIntents,
      db.notificationTargets,
      db.notificationSubscriptions,
    ],
    () => persistGovernedNotificationInsideTransaction(db, prepared)
  )
}

for (const cancel of [false, true]) {
  test(`real governed job ${cancel ? "after cancellation" : "without cancellation"} has no execution admission and cannot send original payload`, async () => {
    const produced = await produce()
    expect(
      await getDb().executionRuns.get(`execution:job:outbound:${produced.outboundJobId}`)
    ).toBeUndefined()
    if (cancel) await cancelNotificationDelivery(produced.intentId)
    const send = jest.fn(async () => ({ ok: true, platformMessageId: "fake-ack" }))
    const adapter = {
      id: "audit-adapter",
      meta: {
        type: "telegram",
        displayName: "Audit",
        version: "1",
        capabilities: [],
        transportModes: ["stub"],
        configSchema: {},
      },
      start: async () => {},
      stop: async () => {},
      health: () => ({ state: "running" }),
      send,
    } as unknown as PlatformAdapter
    const controller = new AbortController()
    const running = startOutboundRunner({
      adapters: new Map([[adapter.id, adapter]]),
      pollIntervalMs: 1,
      signal: controller.signal,
      jitter: () => 0,
      settings: () => ({ agentPermissions: {} }),
    })
    try {
      for (let i = 0; i < 250; i++) {
        if ((await getDb().outboundQueue.get(produced.outboundJobId))?.status === "deadlettered")
          break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const job = await getDb().outboundQueue.get(produced.outboundJobId)
      expect(job).toMatchObject({ status: "deadlettered", lastErrorCode: "personal_withheld" })
      expect(JSON.stringify(send.mock.calls)).not.toContain("AuditOriginalPayload")
      console.log(
        "ADVERSARIAL-REAL-RUNNER",
        JSON.stringify({
          cancel,
          status: job?.status,
          error: job?.lastErrorCode,
          originalPayloadSent: false,
          observedSendCalls: send.mock.calls.length,
        })
      )
    } finally {
      controller.abort()
      await running
    }
  })
}
