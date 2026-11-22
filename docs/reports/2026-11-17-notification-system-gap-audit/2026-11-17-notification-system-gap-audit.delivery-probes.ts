import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import {
  upsertNotificationSubscription,
  deleteNotificationSubscription,
} from "@/lib/db/notification-subscriptions"
import { persistDeliveryIntent, getDeliveryIntent } from "@/lib/db/notification-delivery"
import { claimProjectionWork, runSubjectKey } from "@/lib/db/notification-projection-work"
import { coordinateProjectionWork } from "@/lib/notifications/delivery/coordinator"
import {
  reconcileNotificationReceipts,
  projectOutboundJobReceipt,
} from "@/lib/notifications/delivery/receipts"
import { cancelNotificationDelivery, retryNotificationDelivery } from "@/lib/notifications/api"
import {
  prepareWebhookNotificationDelivery,
  persistWebhookIntentInsideTransaction,
  sendPendingWebhookIntents,
} from "@/lib/notifications/delivery/webhook-sender"
import { __setNotificationIdentityForTesting } from "@/lib/notifications/scope"
import { scopeKeyOf } from "@/types/notifications/scope"
import { foldIntoDigest } from "@/lib/notifications/policy/aggregation"
import { reconcileNotifications } from "@/lib/notifications/delivery/reconciler"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  __setNotificationIdentityForTesting({
    namespaceId: "ns",
    accountId: "acct",
    authorityHostId: "host-1",
  })
})
afterAll(async () => {
  __setNotificationIdentityForTesting(null)
  await fixture.dispose()
})

test("AUDIT digest deadline fires without producing digest delivery work", async () => {
  const { member, flushAt } = await foldIntoDigest({
    fact: {
      factKey: "audit-fact",
      notificationId: "audit-center",
      category: "run.terminal",
      purpose: "terminal-state",
      level: "info",
      source: "run",
    },
    scopeKey: scopeKeyOf(scope),
    aggregateKey: "audit-bucket",
    window: { windowMs: 1000 },
    now: 1000,
  })
  const one = await reconcileNotifications({
    scopeKey: scopeKeyOf(scope),
    policy,
    leaseOwner: "host-1",
    now: flushAt + 1,
  })
  const two = await reconcileNotifications({
    scopeKey: scopeKeyOf(scope),
    policy,
    leaseOwner: "host-1",
    now: flushAt + 2,
  })
  expect(one.timersFired).toBe(1)
  expect(two.timersFired).toBe(0)
  expect((await getDb().notificationTimers.toArray())[0].state).toBe("fired")
  expect((await getDb().notificationAggregateMembers.get(member.id))?.flushedAt).toBeUndefined()
  expect(await getDb().notificationDeliveryIntents.count()).toBe(0)
  console.log(
    "AUDIT-DIGEST",
    JSON.stringify({
      timersFired: one.timersFired,
      nextPassFired: two.timersFired,
      intents: 0,
      memberUnflushed: true,
    })
  )
})

const scope = { namespaceId: "ns", accountId: "acct", authorityHostId: "host-1", workspaceId: "ws" }
const payload = {
  title: "T",
  body: "B",
  level: "info" as const,
  disclosureLevel: "public" as const,
  clippedFactCount: 0,
  contentHash: "hash",
}
const policy = {
  policyVersion: 1,
  timezone: "UTC",
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  quietHoursAllowCritical: false,
  osThreshold: "info" as const,
  pushThreshold: "info" as const,
}

async function seedIntent(key: string, status = "queued", jobId = `job-${key}`) {
  return persistDeliveryIntent({
    scopeKey: scopeKeyOf(scope),
    scope,
    operationKey: key,
    targetId: "t",
    targetAddress: { kind: "connector", adapterId: "a", deliveryTarget: {} as never },
    targetVersion: 1,
    purpose: "terminal-state",
    category: "run.terminal",
    status: status as never,
    payload,
    attemptCount: 0,
    maxAttempts: 5,
    outboundJobId: jobId,
  })
}
function job(key: string, status = "sent") {
  return {
    id: `job-${key}`,
    adapterId: "a",
    conversationKey: "c",
    request: {
      conversationRef: { platform: "feishu", adapterId: "a" },
      segments: [],
      metadata: { idempotencyKey: key },
    },
    status: status as never,
    attempts: 1,
    createdAt: 0,
    updatedAt: 0,
    nextAttemptAt: 0,
    idempotencyKey: key,
    source: "notification" as const,
    notificationOperationKey: key,
  }
}
async function seedRunWithRoute() {
  await createExecutionRun({
    id: "r1",
    kind: "workflow",
    sourceId: "src",
    title: "Deploy",
    status: "running",
    currentRevision: 0,
    startedAt: 0,
    updatedAt: 0,
    projectId: "ws",
  })
  const target = await upsertNotificationTarget({
    scope,
    label: "chat",
    address: {
      kind: "connector",
      adapterId: "ad-1",
      region: "feishu",
      deliveryTarget: {
        address: {
          conversationKey: "ck-chat",
          platform: "feishu",
          adapterId: "ad-1",
          scopeKind: "group",
          containerId: "chat-1",
        },
        conversationRef: { platform: "feishu", adapterId: "ad-1" },
        refreshedAt: 0,
      },
    },
    enabled: true,
    consent: { mode: "proactive", grantRef: "g", grantedBy: "acct", grantedAt: 0 },
    disclosureProfileId: "internal",
    locale: "en",
    timezone: "UTC",
  })
  await upsertNotificationSubscription({
    scope,
    principalId: "acct",
    binding: { kind: "scope" },
    targetIds: [target.id],
    maxDisclosureProfileId: "internal",
    minLevel: "info",
    enabled: true,
    createdBy: "audit",
  })
}

test("AUDIT settings enable toggle drops subscription rules and filters", async () => {
  const original = await upsertNotificationSubscription({
    scope,
    principalId: "acct",
    binding: { kind: "scope" },
    targetIds: ["t"],
    maxDisclosureProfileId: "internal",
    minLevel: "info",
    enabled: true,
    createdBy: "audit",
    rules: [{ kind: "deny" }],
    categories: ["run.terminal"],
    maxIntentsPerFact: 1,
    aggregateKeyTemplate: "custom-bucket",
  })
  // Exact field set forwarded by NotificationDeliveryPanel.toggleSubscription.
  const toggled = await upsertNotificationSubscription({
    id: original.id,
    scope: original.scope,
    principalId: original.principalId,
    binding: original.binding,
    targetIds: original.targetIds,
    maxDisclosureProfileId: original.maxDisclosureProfileId,
    minLevel: original.minLevel,
    enabled: false,
    createdBy: original.createdBy,
    expectedVersion: original.version,
  })
  expect(toggled.rules).toEqual([])
  expect(toggled.categories).toBeUndefined()
  expect(toggled.maxIntentsPerFact).toBeUndefined()
  expect(toggled.aggregateKeyTemplate).toBeUndefined()
  console.log(
    "AUDIT-SETTINGS-TOGGLE",
    JSON.stringify({
      rulesBefore: original.rules.length,
      rulesAfter: toggled.rules.length,
      filtersRemoved: true,
    })
  )
})

test("AUDIT failed center projection advances work without scheduling inbox recovery", async () => {
  await seedRunWithRoute()
  await runEventJournal.append("r1", {
    type: "run.completed",
    ts: 1,
    visibility: "summary",
    payload: {},
  })
  const key = runSubjectKey("r1")
  const work = await claimProjectionWork(key, "host-1", 1000)
  expect(work).toBeDefined()
  const emitCenter = jest.fn(async () => {
    throw new Error("audit center unavailable")
  })
  const result = await coordinateProjectionWork({
    work: work!,
    policy,
    leaseOwner: "host-1",
    emitCenter,
    now: 1000,
  })
  await reconcileNotifications({
    scopeKey: scopeKeyOf(scope),
    policy,
    leaseOwner: "host-1",
    emitCenter,
    now: 2000,
  })
  expect(result.processedEvents).toBe(1)
  expect(emitCenter).toHaveBeenCalledTimes(1)
  expect(await getDb().notifications.count()).toBe(0)
  console.log(
    "AUDIT-CENTER-RECOVERY",
    JSON.stringify({
      processedEvents: result.processedEvents,
      centerAttempts: emitCenter.mock.calls.length,
      centerRows: 0,
    })
  )
})

test("AUDIT receipt sweep starves job 129 after first 128 intents settled", async () => {
  for (let n = 0; n < 129; n++) {
    const key = n.toString().padStart(3, "0")
    await seedIntent(key, n < 128 ? "accepted" : "queued")
    await getDb().outboundQueue.put(job(key))
  }
  const one = await reconcileNotificationReceipts()
  const two = await reconcileNotificationReceipts()
  const tail = await getDb().notificationDeliveryIntents.where("operationKey").equals("128").first()
  expect(one).toEqual({ projected: 0, scanned: 128 })
  expect(two).toEqual({ projected: 0, scanned: 128 })
  expect(tail?.status).toBe("queued")
  console.log("AUDIT-RECEIPT", JSON.stringify({ one, two, tailStatus: tail?.status }))
})

test("AUDIT first event releases lease and second commits send despite rejected cursor", async () => {
  await seedRunWithRoute()
  await runEventJournal.append("r1", {
    type: "tool.started",
    ts: 1,
    visibility: "summary",
    payload: {},
  })
  await runEventJournal.append("r1", {
    type: "run.failed",
    ts: 2,
    visibility: "summary",
    payload: { title: "Failed", summary: "boom" },
  })
  const work = await claimProjectionWork(runSubjectKey("r1"), "host-1")
  const result = await coordinateProjectionWork({ work: work!, policy, leaseOwner: "host-1" })
  const row = await getDb().notificationProjectionWork.where("subjectKey").equals("run:r1").first()
  const intents = await getDb().notificationDeliveryIntents.count()
  expect(result).toMatchObject({ done: false, processedEvents: 1 })
  expect(row?.processedRunSeq).toBe(1)
  expect(row?.desiredRunSeq).toBe(2)
  expect(intents).toBe(1)
  console.log(
    "AUDIT-LEASE",
    JSON.stringify({ result, cursor: row?.processedRunSeq, desired: row?.desiredRunSeq, intents })
  )
})

test("AUDIT stale generation still commits delivery job", async () => {
  await seedRunWithRoute()
  await runEventJournal.append("r1", {
    type: "run.failed",
    ts: 1,
    visibility: "summary",
    payload: { title: "Failed", summary: "boom" },
  })
  const work = await claimProjectionWork(runSubjectKey("r1"), "host-1")
  await getDb().notificationProjectionWork.update(work!.id, { generation: work!.generation + 1 })
  const result = await coordinateProjectionWork({ work: work!, policy, leaseOwner: "host-1" })
  expect(result).toMatchObject({ done: false, processedEvents: 0 })
  expect(await getDb().notificationDeliveryIntents.count()).toBe(1)
  expect(await getDb().outboundQueue.count()).toBe(1)
  console.log(
    "AUDIT-STALE",
    JSON.stringify({
      result,
      intents: await getDb().notificationDeliveryIntents.count(),
      jobs: await getDb().outboundQueue.count(),
    })
  )
})

test("AUDIT cancel leaves connector job pending and ignores late send receipt", async () => {
  const intent = await seedIntent("cancel")
  await getDb().outboundQueue.put(job("cancel", "pending"))
  await cancelNotificationDelivery(intent.id)
  expect((await getDb().outboundQueue.get("job-cancel"))?.status).toBe("pending")
  expect(await projectOutboundJobReceipt(job("cancel", "sent"))).toBeNull()
  expect(await getDb().notificationDeliveryAttempts.count()).toBe(0)
  console.log(
    "AUDIT-CANCEL",
    JSON.stringify({
      intent: (await getDeliveryIntent(intent.id))?.status,
      job: (await getDb().outboundQueue.get("job-cancel"))?.status,
      attempts: await getDb().notificationDeliveryAttempts.count(),
    })
  )
})

test("AUDIT retry leaves connector job deadlettered and receipt makes retry failed again", async () => {
  const intent = await seedIntent("retry", "failed")
  await getDb().outboundQueue.put(job("retry", "deadlettered"))
  expect((await retryNotificationDelivery(intent.id))?.status).toBe("queued")
  expect((await getDb().outboundQueue.get("job-retry"))?.status).toBe("deadlettered")
  await reconcileNotificationReceipts()
  expect((await getDeliveryIntent(intent.id))?.status).toBe("failed")
  console.log(
    "AUDIT-RETRY",
    JSON.stringify({
      intent: (await getDeliveryIntent(intent.id))?.status,
      job: (await getDb().outboundQueue.get("job-retry"))?.status,
    })
  )
})

async function seedWebhookRoute(operationKey: string) {
  const target = await upsertNotificationTarget({
    scope,
    label: "webhook",
    address: { kind: "feishu-webhook", endpointSecretRef: "svc:acct", region: "feishu" },
    enabled: true,
    consent: { mode: "proactive", grantRef: "g", grantedBy: "acct", grantedAt: 0 },
    disclosureProfileId: "public",
    locale: "en",
    timezone: "UTC",
  })
  const sub = await upsertNotificationSubscription({
    scope,
    principalId: "acct",
    binding: { kind: "scope" },
    targetIds: [target.id],
    maxDisclosureProfileId: "public",
    minLevel: "info",
    enabled: true,
    createdBy: "audit",
  })
  const prepared = await prepareWebhookNotificationDelivery({
    target,
    payload,
    purpose: "terminal-state",
    category: "run.terminal",
    operationKey,
    subscriptionId: sub.id,
  })
  const db = getDb()
  const id = await db.transaction(
    "rw",
    [db.notificationDeliveryIntents, db.notificationTargets, db.notificationSubscriptions],
    () => persistWebhookIntentInsideTransaction(db, prepared)
  )
  return { id, target, sub }
}

test("AUDIT revoked subscription still permits queued webhook send", async () => {
  const { id, sub } = await seedWebhookRoute("revoked")
  await deleteNotificationSubscription(sub.id, sub.version)
  const sendHttp = jest.fn(async () => ({ status: 200, body: '{"code":0}' }) as never)
  const result = await sendPendingWebhookIntents({
    deps: { sendHttp, resolveSecret: async () => "https://example.invalid/fake-webhook" },
  })
  expect(sendHttp).toHaveBeenCalledTimes(1)
  expect((await getDeliveryIntent(id))?.status).toBe("accepted")
  console.log(
    "AUDIT-REVOKE",
    JSON.stringify({
      result,
      sendCalls: sendHttp.mock.calls.length,
      intent: (await getDeliveryIntent(id))?.status,
    })
  )
})

test("AUDIT target disable blocks pre-claim work but misses a claimed send awaiting credentials", async () => {
  const early = await seedWebhookRoute("disable-before-claim")
  await upsertNotificationTarget({
    ...early.target,
    enabled: false,
    expectedVersion: early.target.version,
  })
  const sendHttp = jest.fn(async () => ({ status: 200, body: '{"code":0}' }) as never)
  await sendPendingWebhookIntents({
    deps: { sendHttp, resolveSecret: async () => "https://example.invalid/fake-webhook" },
  })
  expect(sendHttp).not.toHaveBeenCalled()
  expect((await getDeliveryIntent(early.id))?.status).toBe("cancelled")

  const late = await seedWebhookRoute("disable-after-claim")
  const enteredKeyring = Promise.withResolvers<void>()
  const resumeKeyring = Promise.withResolvers<void>()
  const sending = sendPendingWebhookIntents({
    deps: {
      sendHttp,
      resolveSecret: async () => {
        enteredKeyring.resolve()
        await resumeKeyring.promise
        return "https://example.invalid/fake-webhook"
      },
    },
  })
  try {
    await Promise.race([
      enteredKeyring.promise,
      sending.then(() => {
        throw new Error("Sender completed without resolving credentials")
      }),
    ])
    expect((await getDeliveryIntent(late.id))?.status).toBe("sending")
    await upsertNotificationTarget({
      ...late.target,
      enabled: false,
      expectedVersion: late.target.version,
    })
  } finally {
    resumeKeyring.resolve()
    await sending
  }
  expect(sendHttp).toHaveBeenCalledTimes(1)
  expect((await getDeliveryIntent(late.id))?.status).toBe("accepted")
})
