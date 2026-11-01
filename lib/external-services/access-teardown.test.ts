import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  createIntegrationAccount,
  enqueueIntegrationActionJob,
  appendIntegrationAudit,
  createIntegrationSubscription,
  claimIntegrationActionJob,
  pruneIntegrationRetention,
} from "@/lib/db/integrations"
import { putConnectionBinding } from "@/lib/db/connection-bindings"
import { revokeConsumerAccess } from "@/lib/plugin/auth/revoke-consumer-access"
import { registerDerivedDataPurger, type DerivedDataTarget } from "./derived-data-registry"
import { queueAccessTeardown, runAccessTeardown, sweepAccessTeardowns } from "./access-teardown"
import { removePluginConnectionAccess } from "./lifecycle"
import { purgePluginExternalServices } from "./lifecycle"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { removeSession } from "@/lib/plugin/auth/auth-provider-registry"
import { createSession } from "@/lib/db/sessions"

jest.mock("@/lib/plugin/auth/auth-provider-registry", () => ({
  ...jest.requireActual("@/lib/plugin/auth/auth-provider-registry"),
  removeSession: jest.fn(async () => {}),
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

const ref = "host-connection" as AuthConnectionRef
async function seed(pluginId: string) {
  const account = await createIntegrationAccount(pluginId, {
    integrationId: "items",
    providerId: "vendor",
    authSessionId: "legacy",
    remoteAccountId: pluginId,
    label: pluginId,
    connectionId: ref,
  })
  await createIntegrationSubscription(pluginId, {
    integrationId: "items",
    accountId: account.id,
    eventTypes: ["changed"],
  })
  const job = await enqueueIntegrationActionJob({
    pluginId,
    integrationId: "items",
    accountId: account.id,
    actionId: "write",
    input: {},
    status: "running",
    risk: "write",
    source: "manual",
    attempts: 1,
    maxAttempts: 3,
    remoteWriteStartedAt: new Date().toISOString(),
  })
  await getDb().integrationEvents.put({
    schemaVersion: 1,
    id: pluginId,
    pluginId,
    integrationId: "items",
    accountId: account.id,
    deliveryId: pluginId,
    eventType: "changed",
    occurredAt: "",
    receivedAt: "",
    payload: {},
  })
  await appendIntegrationAudit({
    pluginId,
    integrationId: "items",
    accountId: account.id,
    kind: "event.changed",
    outcome: "succeeded",
  })
  await appendIntegrationAudit({
    pluginId,
    integrationId: "items",
    accountId: account.id,
    kind: "auth.denied",
    outcome: "denied",
  })
  await putConnectionBinding(pluginId, "vendor", ref)
  return { account, job }
}

it("consumer revoke stops and purges only its accounts; a second consumer keeps working", async () => {
  const one = await seed("one")
  const two = await seed("two")
  const kept = await createSession({ title: "User-kept copy" })
  await revokeConsumerAccess(ref, "one")
  const db = getDb()
  expect(await db.integrationSubscriptions.where("accountId").equals(one.account.id).count()).toBe(
    0
  )
  expect(await db.integrationActionJobs.get(one.job.id)).toMatchObject({
    status: "cancelled",
    remoteOutcome: "unknown",
  })
  expect(
    await claimIntegrationActionJob(one.job.id, { owner: "new", leaseMs: 1000 })
  ).toBeUndefined()
  expect(await db.integrationEvents.get("one")).toBeUndefined()
  expect(await db.integrationAccounts.get(one.account.id)).toMatchObject({ enabled: false })
  expect(await db.integrationSubscriptions.where("accountId").equals(two.account.id).count()).toBe(
    1
  )
  expect(await db.integrationActionJobs.get(two.job.id)).toMatchObject({ status: "running" })
  expect(await db.integrationEvents.get("two")).toBeDefined()
  expect(await db.connectionBindings.get(["two", "vendor"])).toBeDefined()
  expect(await db.integrationAudit.where("kind").equals("auth.denied").count()).toBe(2)
  expect(await db.sessions.get(kept.id)).toBeDefined()
})

it("finishes a failed consumer uninstall on startup without deleting the shared session", async () => {
  const { account } = await seed("one")
  const endpoint = {
    id: "endpoint",
    accountId: account.id,
    routeId: "route",
    secretHandle: "signing-secret",
    enabled: true,
    createdAt: "",
    updatedAt: "",
  }
  await getDb().integrationAccounts.update(account.id, { ingressEndpoint: endpoint })
  await createKeyringStore("integration-ingress").save(endpoint.secretHandle, "secret")
  const purge = jest.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined)
  const dispose = registerDerivedDataPurger({ id: "uninstall-retry", purge })
  try {
    await removePluginConnectionAccess("one")
    await purgePluginExternalServices("one")
    expect(await getDb().integrationAccounts.get(account.id)).toMatchObject({
      enabled: false,
      ingressEndpoint: { routeId: "route" },
    })
    await sweepAccessTeardowns()
    expect(await getDb().integrationAccounts.get(account.id)).toBeUndefined()
    expect(await createKeyringStore("integration-ingress").load(endpoint.secretHandle)).toBeNull()
    expect(removeSession).not.toHaveBeenCalled()
    expect(
      await getDb().integrationAudit.where("kind").equals("access.cleanup.pending").count()
    ).toBe(0)
  } finally {
    dispose()
  }
})

it("continues independent cleanup when a background table fails, then retries it", async () => {
  const { account, job } = await seed("one")
  const target = { kind: "consumer" as const, ref, consumerPluginId: "one" }
  await queueAccessTeardown(target)
  const update = jest
    .spyOn(getDb().integrationAccounts, "update")
    .mockRejectedValueOnce(new Error("temporary"))
  try {
    const report = await runAccessTeardown(target)
    expect(report.failed).toEqual(["integration-background"])
    expect(await getDb().integrationActionJobs.get(job.id)).toMatchObject({ status: "cancelled" })
    expect(await getDb().integrationEvents.get("one")).toBeUndefined()
    expect(await getDb().connectionBindings.get(["one", "vendor"])).toBeUndefined()
    await sweepAccessTeardowns()
    expect(await getDb().integrationAccounts.get(account.id)).toMatchObject({ enabled: false })
  } finally {
    update.mockRestore()
  }
})

it("serializes duplicate cleanup calls and leaves a freshly rebound generation alone", async () => {
  await seed("one")
  const target = { kind: "consumer" as const, ref, consumerPluginId: "one" }
  await queueAccessTeardown(target)
  await Promise.all([runAccessTeardown(target), runAccessTeardown(target)])
  await putConnectionBinding("one", "vendor", ref)
  expect(await runAccessTeardown(target)).toEqual({ purged: [], failed: [] })
  expect(await getDb().connectionBindings.get(["one", "vendor"])).toBeDefined()
})

it("retries failed purge at startup and retains pending cleanup beyond audit retention", async () => {
  await seed("one")
  const target = { kind: "connection" as const, ref }
  const purge = jest.fn().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(undefined)
  const dispose = registerDerivedDataPurger({ id: "transient", purge })
  try {
    await queueAccessTeardown(target)
    expect((await runAccessTeardown(target)).failed).toEqual(["transient"])
    await pruneIntegrationRetention(Date.now() + 100 * 24 * 60 * 60 * 1000)
    expect(
      await getDb().integrationAudit.where("kind").equals("access.cleanup.pending").count()
    ).toBe(1)
    await sweepAccessTeardowns()
    expect(purge).toHaveBeenCalledTimes(2)
    expect(
      await getDb().integrationAudit.where("kind").equals("access.cleanup.pending").count()
    ).toBe(0)
  } finally {
    dispose()
  }
})

it.each([false, true])(
  "consumer uninstall keeps the shared connection and wipes derived plugin data with cascade=%s",
  async (cascade) => {
    await seed("one")
    await seed("two")
    // A minimal Host row is enough here: teardown must never change it.
    const connection = {
      id: ref,
      status: "connected",
      revision: 1,
    } as unknown as import("@/lib/db/auth-connections").AuthConnectionRow
    await getDb().authConnections.put(connection)
    const purger = jest.fn(async (_target: DerivedDataTarget) => {})
    const dispose = registerDerivedDataPurger({ id: "plugin-data-test", purge: purger })
    try {
      await removePluginConnectionAccess("one", cascade)
      expect(await getDb().authConnections.get(ref)).toEqual(connection)
      expect(await getDb().connectionBindings.get(["one", "vendor"])).toBeUndefined()
      expect(await getDb().connectionBindings.get(["two", "vendor"])).toBeDefined()
      expect(purger.mock.calls.some(([target]) => target.kind === "plugin-data")).toBe(cascade)
    } finally {
      dispose()
    }
  }
)
