import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { tombstoneAuthConnection, type AuthConnectionRow } from "@/lib/db/auth-connections"
import { getRemoteDocumentConnection } from "@/lib/db/remote-document-connections"
import { getDocsProvider } from "./registry"
import { DocsProviderError, type DocsProvider, type RemoteDocContent } from "./types"
import {
  captureKeptCopyProvenance,
  captureKeptCopyConnection,
  requireKeptCopySource,
  recordKeptCopySourceFailure,
  resolveKeptCopyConnection,
  resolveKeptCopySource,
} from "./kept-copy-source"
import type { RemoteDocumentProvenanceV1 } from "./document-provenance"

jest.mock("./registry", () => {
  const getDocsProvider = jest.fn()
  return {
    getDocsProvider,
    resolveDocsProvider: async (id: string) => getDocsProvider(id),
    listDocsProviders: jest.fn(() => []),
  }
})
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.mocked(getDocsProvider).mockReturnValue(provider)
})
afterAll(fixture.dispose)

const connection: AuthConnectionRow = {
  id: "original" as AuthConnectionRow["id"],
  providerId: "auth.vendor",
  ownerPluginId: "vendor",
  publisher: "vendor",
  contractMajor: 1,
  issuer: "https://auth.vendor.test",
  clientId: "client",
  principalId: "person",
  principalKind: "user",
  accountLabel: "Person",
  scopes: ["docs:read"],
  revision: 2,
  credentialRevision: 1,
  lineageId: "lineage",
  status: "connected",
  identityKey: "stable-original-identity",
  createdAt: 1,
  updatedAt: 1,
}
const content: RemoteDocContent = {
  ref: { providerId: "plugin:vendor/docs", kind: "resource", id: "report", title: "Report" },
  title: "Report",
  text: "Kept body",
  format: "text",
}
const provider: DocsProvider = {
  id: "plugin:vendor/docs",
  kinds: ["resource"],
  hosts: ["tauri"],
  urlOrigins: [],
  mentionPrefix: "vendor:",
  matchRef: () => null,
  listAccounts: async () => [],
  fetch: async () => content,
}
const binding = { accountId: connection.id, authorizationEpoch: "2" }
async function capture() {
  await getDb().authConnections.put(connection)
  return (await captureKeptCopyProvenance(content, binding))!
}

it("returns unknown for legacy and built-in captures without a Host connection", async () => {
  const legacy = await captureKeptCopyProvenance(
    {
      ...content,
      ref: { ...content.ref, providerId: "lark", kind: "doc" },
    },
    binding
  )
  expect(legacy).not.toHaveProperty("connectionScoped")
  expect(await getDb().remoteDocumentConnections.count()).toBe(0)
  expect(await resolveKeptCopySource(legacy)).toBe("unknown")
  expect(await resolveKeptCopySource(undefined)).toBe("unknown")
})

it("captures the connection only in the local table, under a random stable id", async () => {
  const provenance = await capture()
  expect(provenance).toMatchObject({ connectionScoped: true, captureId: expect.any(String) })
  expect(JSON.stringify(provenance)).not.toMatch(/connectionRef|identityKey|original|person/)
  expect(await getRemoteDocumentConnection(provenance.captureId!)).toEqual({
    captureId: provenance.captureId,
    providerId: content.ref.providerId,
    connectionRef: connection.id,
    identityKey: connection.identityKey,
    capturedAt: provenance.fetchedAt,
  })
  expect(await resolveKeptCopySource(provenance)).toBe("available")
})
it("also captures built-ins when their account id is a Host connection ref", async () => {
  await getDb().authConnections.put(connection)
  const provenance = await captureKeptCopyProvenance(
    { ...content, ref: { ...content.ref, providerId: "lark", kind: "doc" } },
    binding
  )
  expect(provenance?.connectionScoped).toBe(true)
  expect(await getRemoteDocumentConnection(provenance!.captureId!)).toMatchObject({
    connectionRef: connection.id,
    identityKey: connection.identityKey,
  })
})

it("captures a provider-resolved legacy binding as connectionScoped without vendor branches", async () => {
  await getDb().authConnections.put(connection)
  const account = { id: connection.id, label: connection.accountLabel, authorizationEpoch: "2" }
  jest.mocked(getDocsProvider).mockReturnValue({
    ...provider,
    listAccounts: async () => [account],
    resolveLegacyAccount: async (binding: { accountId: string }) =>
      binding.accountId === "legacy-default" ? account : null,
  } as never)
  const provenance = await captureKeptCopyProvenance(
    { ...content, ref: { ...content.ref, providerId: "google", kind: "doc" } },
    { accountId: "legacy-default", authorizationEpoch: "old-native-nonce" }
  )
  expect(provenance?.connectionScoped).toBe(true)
  expect(await getRemoteDocumentConnection(provenance!.captureId!)).toMatchObject({
    connectionRef: connection.id,
  })
  expect(JSON.stringify(provenance)).not.toContain(connection.id)
})

it("does not publish a capture when a legacy binding becomes ambiguous", async () => {
  jest.mocked(getDocsProvider).mockReturnValue({
    ...provider,
    listAccounts: async () => [],
    resolveLegacyAccount: async () => null,
  } as never)
  await expect(captureKeptCopyProvenance(content, { accountId: "legacy" })).rejects.toMatchObject({
    code: "notAuthorized",
  })
  expect(await getDb().remoteDocumentConnections.count()).toBe(0)
})

it.each(["missing", "revision", "revoked"])("refuses a %s capture binding", async (reason) => {
  if (reason !== "missing")
    await getDb().authConnections.put({
      ...connection,
      ...(reason === "revision" ? { revision: 3 } : { status: "revoked" as const }),
    })
  await expect(captureKeptCopyProvenance(content, binding)).rejects.toMatchObject({
    code: "notAuthorized",
  })
  expect(await getDb().remoteDocumentConnections.count()).toBe(0)
})

it("returns not-on-this-device for a synced capture, including one without a usable id", async () => {
  const provenance = await capture()
  await getDb().remoteDocumentConnections.clear()
  expect(await resolveKeptCopySource(provenance)).toBe("not-on-this-device")
  expect(await resolveKeptCopySource({ ...provenance, captureId: undefined })).toBe(
    "not-on-this-device"
  )
})

it.each(["revoked", "tombstoned", "provider-unavailable", "needs-reauth", "missing"] as const)(
  "returns source-disconnected for a %s connection while retaining the binding",
  async (status) => {
    const provenance = await capture()
    if (status === "missing") await getDb().authConnections.clear()
    else await getDb().authConnections.update(connection.id, { status })
    expect(await resolveKeptCopySource(provenance)).toBe("source-disconnected")
    expect(await getRemoteDocumentConnection(provenance.captureId!)).toBeDefined()
  }
)

it("restores live reopen by identity after the terminal row releases its slot", async () => {
  const provenance = await capture()
  await getDb().authConnections.put(tombstoneAuthConnection(connection, "tombstoned"))
  const unrelated = {
    ...connection,
    id: "different-account" as AuthConnectionRow["id"],
    identityKey: "other",
  }
  await getDb().authConnections.put(unrelated)
  expect(await resolveKeptCopySource(provenance)).toBe("source-disconnected")
  const restored = { ...connection, id: "reconnected" as AuthConnectionRow["id"], revision: 1 }
  await getDb().authConnections.put(restored)
  expect(await resolveKeptCopySource(provenance)).toBe("available")
  expect((await resolveKeptCopyConnection(provenance))?.id).toBe(restored.id)
})

it("requires the document provider on this device even with a live auth connection", async () => {
  const provenance = await capture()
  jest.mocked(getDocsProvider).mockReturnValue(undefined)
  expect(await resolveKeptCopySource(provenance)).toBe("source-disconnected")
})

it.each(["notFound", "noPermission"] as const)(
  "persists source-deleted after provider %s",
  async (code) => {
    const provenance = await capture()
    await recordKeptCopySourceFailure(provenance, new DocsProviderError(code))
    getDb().close()
    await getDb().open()
    const reloaded: RemoteDocumentProvenanceV1 = JSON.parse(JSON.stringify(provenance))
    expect(await resolveKeptCopySource(reloaded)).toBe("source-deleted")
    expect(await resolveKeptCopyConnection(reloaded)).toBeUndefined()
    await getDb().authConnections.clear()
    expect(await resolveKeptCopySource(reloaded)).toBe("source-deleted")
  }
)

it.each([
  new DocsProviderError("network"),
  new DocsProviderError("notAuthorized"),
  new Error("notFound"),
])("does not confuse an outage with remote deletion (%s)", async (error) => {
  const provenance = await capture()
  await recordKeptCopySourceFailure(provenance, error)
  expect(await resolveKeptCopySource(provenance)).toBe("available")
})

it("keeps Issue Sync provenance without requiring a document provider", async () => {
  await getDb().authConnections.put(connection)
  const captureId = await captureKeptCopyConnection({
    providerId: "github",
    connectionRef: connection.id,
    revision: connection.revision,
  })
  const source = { providerId: "github", captureId, connectionScoped: true as const }
  jest.mocked(getDocsProvider).mockReturnValue(undefined)
  expect(await resolveKeptCopySource(source)).toBe("available")
  await getDb().authConnections.put(tombstoneAuthConnection(connection, "tombstoned"))
  expect(await resolveKeptCopySource(source)).toBe("source-disconnected")
  await expect(requireKeptCopySource(source)).rejects.toMatchObject({
    name: "KeptCopySourceError",
    code: "source-disconnected",
  })
  await getDb().authConnections.put({ ...connection, id: "restored" as never })
  await expect(requireKeptCopySource(source)).resolves.toBeUndefined()
  expect((await resolveKeptCopyConnection(source))?.id).toBe("restored")
})
