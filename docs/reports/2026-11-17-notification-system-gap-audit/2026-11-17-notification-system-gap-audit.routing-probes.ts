import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { upsertNotificationTarget } from "@/lib/db/notification-targets"
import { upsertNotificationSubscription } from "@/lib/db/notification-subscriptions"
import { claimProjectionWork } from "@/lib/db/notification-projection-work"
import { coordinateProjectionWork } from "@/lib/notifications/delivery/coordinator"
import { resolveNotificationPlan } from "@/lib/notifications/policy/resolver"
import { deriveFactFromRunEvent } from "@/lib/notifications/delivery/facts"
import { __setNotificationIdentityForTesting } from "@/lib/notifications/scope"
import { scopeKeyOf } from "@/types/notifications/scope"

const fixture = createDbTestFixture()
const accountScope = { namespaceId: "scope-probe", accountId: "acct", authorityHostId: "host" }
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

beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  __setNotificationIdentityForTesting(accountScope)
})
afterAll(async () => {
  __setNotificationIdentityForTesting(null)
  await fixture.dispose()
})

async function seedTarget() {
  return upsertNotificationTarget({
    scope: accountScope,
    label: "Audit target",
    address: { kind: "feishu-webhook", endpointSecretRef: "audit:endpoint", region: "feishu" },
    enabled: true,
    consent: {
      mode: "proactive",
      grantRef: "settings:notifications",
      grantedBy: "acct",
      grantedAt: 0,
    },
    disclosureProfileId: "internal",
    locale: "en",
    timezone: "UTC",
  })
}

test("AUDIT Settings run subscription cannot see its workspace run", async () => {
  const target = await seedTarget()
  await upsertNotificationSubscription({
    scope: accountScope,
    principalId: "acct",
    binding: { kind: "run", runId: "scope-run" },
    targetIds: [target.id],
    maxDisclosureProfileId: "internal",
    minLevel: "info",
    enabled: true,
    createdBy: "acct",
  })
  const run = await createExecutionRun({
    id: "scope-run",
    kind: "workflow",
    sourceId: "wf",
    title: "Workspace run",
    status: "running",
    currentRevision: 0,
    startedAt: 0,
    updatedAt: 0,
    projectId: "ws",
  })
  const event = await runEventJournal.append(run.id, { type: "run.completed", payload: {} })
  const work = (await getDb().notificationProjectionWork.toArray())[0]
  expect(work.scopeKey).not.toBe(scopeKeyOf(accountScope))
  const derived = deriveFactFromRunEvent(run, event)!
  const withRealScope = await resolveNotificationPlan({
    fact: derived.fact,
    scopeKey: work.scopeKey,
    policy,
  })
  const withAccountScope = await resolveNotificationPlan({
    fact: derived.fact,
    scopeKey: scopeKeyOf(accountScope),
    policy,
  })
  expect(withRealScope.outcome).toBe("not-subscribed")
  expect(withAccountScope.outcome).toBe("notified")
  const claimed = await claimProjectionWork(work.subjectKey, "audit-owner")
  expect(claimed).toBeDefined()
  await coordinateProjectionWork({
    work: claimed!,
    policy,
    leaseOwner: "audit-owner",
    emitCenter: async () => undefined,
  })
  expect(await getDb().notificationDeliveryIntents.count()).toBe(0)
  expect((await getDb().notificationProjectionWork.get(work.id))?.processedRunSeq).toBe(event.seq)
  console.log(
    "SCOPE-PROBE",
    JSON.stringify({
      settingsScope: scopeKeyOf(accountScope),
      runScope: work.scopeKey,
      actual: withRealScope.outcome,
      accountControl: withAccountScope.outcome,
      intents: 0,
      cursorAdvanced: true,
    })
  )
})

test("AUDIT Settings scheduler source subscription cannot match scheduled journal facts", async () => {
  const target = await seedTarget()
  await upsertNotificationSubscription({
    scope: accountScope,
    principalId: "acct",
    binding: { kind: "source", source: "scheduler" },
    targetIds: [target.id],
    maxDisclosureProfileId: "internal",
    minLevel: "info",
    enabled: true,
    createdBy: "acct",
  })
  const run = await createExecutionRun({
    id: "source-run",
    kind: "scheduled",
    sourceId: "schedule",
    title: "Scheduled run",
    status: "running",
    currentRevision: 0,
    startedAt: 0,
    updatedAt: 0,
  })
  const event = await runEventJournal.append(run.id, { type: "run.completed", payload: {} })
  const derived = deriveFactFromRunEvent(run, event)!
  const actual = await resolveNotificationPlan({
    fact: derived.fact,
    scopeKey: scopeKeyOf(accountScope),
    policy,
  })
  const control = await resolveNotificationPlan({
    fact: { ...derived.fact, source: "scheduler" },
    scopeKey: scopeKeyOf(accountScope),
    policy,
  })
  expect(derived.fact.source).toBe("run")
  expect(actual.outcome).toBe("not-subscribed")
  expect(control.outcome).toBe("notified")
  console.log(
    "SOURCE-PROBE",
    JSON.stringify({
      settingsSource: "scheduler",
      actualFactSource: derived.fact.source,
      actual: actual.outcome,
      expectedSourceControl: control.outcome,
    })
  )
})
