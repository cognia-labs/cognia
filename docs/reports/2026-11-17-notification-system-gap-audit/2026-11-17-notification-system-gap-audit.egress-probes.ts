import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import { upsertNotificationSubscription } from "@/lib/db/notification-subscriptions"
import { claimProjectionWork, runSubjectKey } from "@/lib/db/notification-projection-work"
import { coordinateProjectionWork } from "@/lib/notifications/delivery/coordinator"
import {
  sendPendingWebhookIntents,
  prepareWebhookNotificationDelivery,
  persistWebhookIntentInsideTransaction,
} from "@/lib/notifications/delivery/webhook-sender"
import { __setNotificationIdentityForTesting } from "@/lib/notifications/scope"
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { checkPersonalSink } from "@/lib/execution/personal-sink"

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
const scope = { namespaceId: "ns", accountId: "acct", authorityHostId: "host-1" }
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
const payload = {
  title: "Synthetic",
  body: "Audit",
  level: "info" as const,
  disclosureLevel: "internal" as const,
  clippedFactCount: 0,
  contentHash: "audit-hash",
}
async function target(label: string) {
  return upsertNotificationTarget({
    scope,
    label,
    address: { kind: "feishu-webhook", endpointSecretRef: "svc:shared", region: "feishu" },
    enabled: true,
    consent: { mode: "proactive", grantRef: "audit", grantedBy: "acct", grantedAt: 0 },
    disclosureProfileId: "internal",
    locale: "en",
    timezone: "UTC",
  })
}
async function subscription(targetIds: string[]) {
  return upsertNotificationSubscription({
    scope,
    principalId: "acct",
    binding: { kind: "scope" },
    targetIds,
    maxDisclosureProfileId: "internal",
    minLevel: "info",
    enabled: true,
    createdBy: "audit",
  })
}
async function coordinate(runId: string) {
  const work = await claimProjectionWork(runSubjectKey(runId), "host-1", Date.now())
  expect(work).toBeDefined()
  return coordinateProjectionWork({ work: work!, policy, leaseOwner: "host-1" })
}
test("ADVERSARIAL personal-marked run is sent by webhook despite real personal gate withholding", async () => {
  const t = await target("private-boundary")
  await subscription([t.id])
  const run = await startToolExecutionRun("audit-private-session", {
    localAuthorization: LOCAL_PERSON_RUN,
    title: "Private roadmap synthetic",
  })
  await getDb().executionRuns.update(run.id, {
    personalMarks: [
      { person: { kind: "local-person" }, source: "synthetic-personal-document", markedAt: 1 },
    ],
  })
  const result = await coordinate(run.id)
  expect(result.processedEvents).toBe(1)
  const actualIntent = (await getDb().notificationDeliveryIntents.toArray())[0]
  expect(actualIntent).toBeDefined()
  const gate = await checkPersonalSink(
    { executionRunId: run.id },
    { kind: "unknown", label: "webhook destination" },
    actualIntent.payload,
    t.address
  )
  expect(gate.outcome).toBe("withhold")
  const sendHttp = jest.fn(async () => ({ status: 200, body: '{"code":0}' }) as never)
  await sendPendingWebhookIntents({
    deps: { sendHttp, resolveSecret: async () => "https://audit.invalid/webhook" },
  })
  expect(sendHttp).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(sendHttp.mock.calls)).toContain("Private roadmap synthetic")
  console.log(
    "ADVERSARIAL-PERSONAL",
    JSON.stringify({
      realGate: gate.outcome,
      sendCalls: sendHttp.mock.calls.length,
      privateTitleSent: true,
    })
  )
})
test("ADVERSARIAL target aliases sharing fingerprint cause duplicate webhook sends", async () => {
  const a = await target("alias-A")
  const b = await target("alias-B")
  expect(a.addressFingerprint).toBe(b.addressFingerprint)
  await subscription([a.id, b.id])
  await createExecutionRun({
    id: "r-alias",
    kind: "workflow",
    sourceId: "audit",
    title: "Synthetic alias",
    status: "running",
    currentRevision: 0,
    startedAt: 0,
    updatedAt: 0,
  })
  await runEventJournal.append("r-alias", {
    type: "run.completed",
    ts: 1,
    visibility: "summary",
    payload: {},
  })
  await coordinate("r-alias")
  const sendHttp = jest.fn(async () => ({ status: 200, body: '{"code":0}' }) as never)
  await sendPendingWebhookIntents({
    deps: { sendHttp, resolveSecret: async () => "https://audit.invalid/webhook" },
  })
  expect(sendHttp).toHaveBeenCalledTimes(2)
  console.log(
    "ADVERSARIAL-ALIAS",
    JSON.stringify({ fingerprintsEqual: true, sendCalls: sendHttp.mock.calls.length })
  )
})
test("ADVERSARIAL 2xx null body causes automatic repeated send", async () => {
  const t = await target("ambiguous-response")
  const sub = await subscription([t.id])
  const prepared = await prepareWebhookNotificationDelivery({
    target: t,
    payload,
    purpose: "terminal-state",
    category: "run.terminal",
    operationKey: "ambiguous-response",
    subscriptionId: sub.id,
  })
  const db = getDb()
  const id = await db.transaction(
    "rw",
    [db.notificationDeliveryIntents, db.notificationTargets, db.notificationSubscriptions],
    () => persistWebhookIntentInsideTransaction(db, prepared)
  )
  const sendHttp = jest.fn(async () => ({ status: 200, body: "null" }) as never)
  const deps = { sendHttp, resolveSecret: async () => "https://audit.invalid/webhook" }
  await sendPendingWebhookIntents({ deps, now: 10000 })
  const first = await db.notificationDeliveryIntents.get(id)
  expect(first?.status).toBe("queued")
  await sendPendingWebhookIntents({ deps, now: 12000 })
  expect(sendHttp).toHaveBeenCalledTimes(2)
  console.log(
    "ADVERSARIAL-AMBIGUOUS",
    JSON.stringify({ firstStatus: first?.status, sendCalls: sendHttp.mock.calls.length })
  )
})
