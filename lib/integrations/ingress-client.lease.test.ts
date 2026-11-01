import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createIntegrationAccount } from "@/lib/db/integrations"
import {
  acquireSyncLease,
  fenceConnectionSyncLeases,
  type SyncLease,
} from "@/lib/external-services/sync-lease"
import { transport } from "@/lib/tauri"
import { drainIntegrationIngress } from "./ingress-client"
import { publishIntegrationEvent } from "./events"

jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => "tauri",
  isTauri: () => false,
}))
jest.mock("./registry", () => ({ getIntegrationEventNormalizer: jest.fn() }))
jest.mock("./events", () => ({
  publishIntegrationEvent: jest.fn(async (_plugin, _event, options: { syncLease: SyncLease }) =>
    options.syncLease.commit([], async () => undefined)
  ),
}))
import { getIntegrationEventNormalizer } from "./registry"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  await getDb().authConnections.put({ id: "ref", status: "connected" } as never)
  const account = await createIntegrationAccount("consumer", {
    integrationId: "items",
    providerId: "vendor",
    authSessionId: "legacy",
    remoteAccountId: "one",
    label: "one",
    connectionId: "ref",
  })
  await getDb().integrationAccounts.update(account.id, {
    ingressEndpoint: {
      id: "endpoint",
      accountId: account.id,
      routeId: "route",
      secretHandle: "secret",
      enabled: true,
      createdAt: "",
      updatedAt: "",
    },
  })
  jest
    .mocked(transport.call)
    .mockImplementation(async (command) =>
      command === "integration_ingress_poll"
        ? [{ routeId: "route", deliveryId: "delivery" }]
        : undefined
    )
})
afterAll(fixture.dispose)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it("holds one connection lease across normalization, publish and acknowledgement", async () => {
  const started = deferred()
  const finish = deferred()
  jest.mocked(getIntegrationEventNormalizer).mockReturnValue(async () => {
    started.resolve()
    await finish.promise
    return { id: "event" } as never
  })
  const a = drainIntegrationIngress()
  await started.promise
  expect(await drainIntegrationIngress()).toBe(0)
  expect(await acquireSyncLease("ref", "ingress")).toBeNull()
  finish.resolve()
  expect(await a).toBe(1)
  expect(publishIntegrationEvent).toHaveBeenCalledTimes(1)
  expect(transport.call).toHaveBeenCalledWith("integration_ingress_ack", {
    routeId: "route",
    deliveryId: "delivery",
  })
  expect(await getDb().syncLeases.count()).toBe(0)
})

it("drops a late normalizer result after disconnect without publishing or acknowledging", async () => {
  const started = deferred()
  const finish = deferred()
  jest.mocked(getIntegrationEventNormalizer).mockReturnValue(async () => {
    started.resolve()
    await finish.promise
    return { id: "late-event" } as never
  })
  const pending = drainIntegrationIngress()
  const failed = expect(pending).rejects.toThrow("lease")
  await started.promise
  await fenceConnectionSyncLeases("ref")
  finish.resolve()
  await failed
  expect(publishIntegrationEvent).not.toHaveBeenCalled()
  expect(transport.call).not.toHaveBeenCalledWith("integration_ingress_ack", expect.anything())
  expect(transport.call).not.toHaveBeenCalledWith("integration_ingress_nack", expect.anything())
})
