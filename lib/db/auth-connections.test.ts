/** @jest-environment jsdom */
import { createDbTestFixture } from "./test-fixture"
import {
  authConnectionIdentityKey,
  findAuthConnection,
  getAuthConnection,
  listAuthConnections,
  putAuthConnection,
  tombstoneAuthConnection,
  type AuthConnectionRow,
} from "./auth-connections"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function row(id: string): AuthConnectionRow {
  return {
    id: id as AuthConnectionRef,
    providerId: "p",
    ownerPluginId: null,
    publisher: null,
    contractMajor: 1,
    issuer: "https://issuer",
    clientId: "client",
    principalKind: "user",
    principalId: "u",
    accountLabel: "U",
    scopes: [],
    revision: 1,
    credentialRevision: 1,
    lineageId: "lineage",
    status: "connected",
    identityKey: "issuer|client|user|u",
    createdAt: 1,
    updatedAt: 1,
  }
}
it("enforces unique identity and releases it on tombstone", async () => {
  const first = row("first")
  await putAuthConnection(first)
  expect(await getAuthConnection(first.id)).toEqual(first)
  expect(await findAuthConnection(first.identityKey)).toEqual(first)
  await expect(putAuthConnection(row("second"))).rejects.toMatchObject({ name: "ConstraintError" })
  await putAuthConnection(tombstoneAuthConnection(first, "tombstoned", 2))
  await putAuthConnection(row("second"))
  expect(await listAuthConnections("p")).toHaveLength(2)
  expect(await listAuthConnections("other")).toEqual([])
})

it("round-trips a Host-only native credential binding without a schema backfill", async () => {
  const native = {
    ...row("native"),
    hostMetadata: {
      adapterId: "adapter",
      authorizationEpoch: "epoch",
      credentialVersion: "revision",
      bot: true,
    },
  }
  await putAuthConnection(native)
  expect(await getAuthConnection(native.id)).toEqual(native)
})
it("escapes identity delimiters to prevent aliases", () => {
  const key = (issuer: string, clientId: string) =>
    authConnectionIdentityKey({ issuer, clientId, principal: { id: "u", kind: "user" } })
  expect(key("a|b", "c")).not.toBe(key("a", "b|c"))
})
