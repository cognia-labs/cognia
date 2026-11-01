/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getConnectionBinding, putConnectionBinding } from "@/lib/db/connection-bindings"
import { revokeConsumerAccess } from "./revoke-consumer-access"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { ServiceConnection, CapabilityGrant } from "@/types/external-service"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("removes only this consumer's grants and bindings for this Host connection, idempotently", async () => {
  const ref = "host" as AuthConnectionRef
  const other = "other" as AuthConnectionRef
  const db = getDb()
  const projection = (id: string, authConnectionRef: string): ServiceConnection => ({
    id,
    pluginId: "consumer",
    serviceId: "items",
    providerId: "api",
    runtimeTargetId: "local",
    status: "connected",
    providerFingerprint: "fp",
    providerRef: { kind: "integration", accountId: id, authConnectionRef },
    enabledSurfaces: ["chat"],
    createdAt: "",
    updatedAt: "",
  })
  await db.serviceConnections.bulkPut([
    projection("one", ref),
    projection("two", ref),
    projection("foreign", other),
  ])
  const grant = (
    id: string,
    connectionId: string,
    consumerPluginId = "consumer"
  ): CapabilityGrant => ({
    id,
    connectionId,
    consumerPluginId,
    providerFingerprint: "fp",
    connectionRevision: 1,
    operationPatterns: ["items.list"],
    createdAt: "",
    updatedAt: "",
  })
  await db.capabilityGrants.bulkPut([
    grant("one", "one"),
    grant("two", "two"),
    grant("keep-consumer", "one", "other"),
    grant("keep-connection", "foreign"),
  ])
  await putConnectionBinding("consumer", "vendor", ref)
  await putConnectionBinding("other", "vendor", ref)
  await putConnectionBinding("consumer", "second-provider", other)
  await revokeConsumerAccess(ref, "consumer")
  await revokeConsumerAccess(ref, "consumer")
  expect((await db.capabilityGrants.toArray()).map((row) => row.id).sort()).toEqual([
    "keep-connection",
    "keep-consumer",
  ])
  expect(await getConnectionBinding("consumer", "vendor")).toBeUndefined()
  expect(await getConnectionBinding("other", "vendor")).toMatchObject({ connectionRef: ref })
  expect(await getConnectionBinding("consumer", "second-provider")).toMatchObject({
    connectionRef: other,
  })
  expect(await db.serviceConnections.count()).toBe(3)
})
