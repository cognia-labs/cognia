/** @jest-environment jsdom */
import { createDbTestFixture } from "./test-fixture"
import {
  getConnectionBinding,
  listConnectionBindings,
  putConnectionBinding,
  removeConnectionBinding,
} from "./connection-bindings"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import { getDb } from "./schema"
import { queueAccessTeardown, runAccessTeardown } from "@/lib/external-services/access-teardown"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

it("does not bind a new access generation while old consumer cleanup is pending", async () => {
  const ref = "pending-ref" as AuthConnectionRef
  const target = { kind: "consumer" as const, ref, consumerPluginId: "consumer" }
  await queueAccessTeardown(target)
  expect(await putConnectionBinding("consumer", "p", ref)).toBe(false)
  expect(await putConnectionBinding("other", "p", ref)).toBe(true)
  await runAccessTeardown(target)
  expect(await putConnectionBinding("consumer", "p", ref)).toBe(true)
})

it("persists one selection per consumer/provider and preserves its creation time", async () => {
  await putConnectionBinding("consumer", "p", "first" as AuthConnectionRef)
  const first = await getConnectionBinding("consumer", "p")
  await putConnectionBinding("consumer", "p", "second" as AuthConnectionRef)
  await putConnectionBinding("other", "p", "first" as AuthConnectionRef)
  expect(await getConnectionBinding("consumer", "p")).toMatchObject({
    connectionRef: "second",
    createdAt: first!.createdAt,
  })
  expect(await listConnectionBindings("consumer")).toHaveLength(1)
  await removeConnectionBinding("consumer", "p")
  expect(await getConnectionBinding("consumer", "p")).toBeUndefined()
  expect(await getConnectionBinding("other", "p")).toBeDefined()
})

it("conditionally commits only the still-connected provider and revision", async () => {
  const ref = "ref" as AuthConnectionRef
  expect(await putConnectionBinding("consumer", "p", ref, 1)).toBe(false)
  await getDb().authConnections.put({
    id: ref,
    providerId: "p",
    ownerPluginId: null,
    publisher: null,
    contractMajor: 1,
    issuer: "https://issuer.test",
    clientId: "client",
    principalId: "user",
    principalKind: "user",
    accountLabel: "Account",
    scopes: [],
    revision: 2,
    credentialRevision: 1,
    lineageId: "lineage",
    status: "connected",
    identityKey: "identity",
    createdAt: 1,
    updatedAt: 1,
  })
  expect(await putConnectionBinding("consumer", "p", ref, 1)).toBe(false)
  expect(await putConnectionBinding("consumer", "other", ref, 2)).toBe(false)
  expect(await putConnectionBinding("consumer", "p", ref, 2)).toBe(true)
  await removeConnectionBinding("consumer", "p")
  await getDb().authConnections.update(ref, { status: "tombstoned" })
  expect(await putConnectionBinding("consumer", "p", ref, 2)).toBe(false)
  expect(await getConnectionBinding("consumer", "p")).toBeUndefined()
})
