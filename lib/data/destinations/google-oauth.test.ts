/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
import { __resetAuthRegistryForTesting } from "@/lib/plugin/auth/auth-provider-registry"
import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests } from "@/lib/docs-providers/providers/google/state"
import { listGoogleConnections } from "@/lib/auth-providers/google/host-auth"
import {
  GOOGLE_DRIVE_SCOPE,
  resolveGoogleDriveConnection,
  bindGoogleDriveConnection,
  getGoogleDriveCredentialLease,
} from "./google-oauth"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
let host: ReturnType<typeof createGoogleDocsTestHost>
beforeEach(async () => {
  await fixture.restore()
  __resetAuthRegistryForTesting()
  await saveSettings({ backupDestinations: { googleDrive: { enabled: true, clientId: "backup" } } })
  host = createGoogleDocsTestHost({
    lineages: [
      {
        id: "native",
        clientId: "backup",
        sub: "sub",
        email: "ada@example.test",
        method: "device-code",
        scopes: [GOOGLE_DRIVE_SCOPE],
        status: "connected",
        revision: "auth-1",
        credentialRevision: "creds-1",
        needsIdentity: false,
      },
    ],
  })
  __setGoogleStatePortForTests(host.call)
})
afterEach(() => __setGoogleStatePortForTests(null))

it("persists the single exact candidate and honors its connectionId on later reads", async () => {
  const row = await resolveGoogleDriveConnection()
  expect(row?.accountLabel).toBe("ada@example.test")
  expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBe(row?.id)
  host.snapshot.lineages.push({ ...host.snapshot.lineages[0], id: "other", sub: "other" })
  expect((await resolveGoogleDriveConnection())?.id).toBe(row?.id)
})
it("never falls back for an unknown reference or chooses among ambiguous candidates", async () => {
  await saveSettings({
    backupDestinations: {
      googleDrive: { enabled: true, clientId: "backup", connectionId: "unknown" },
    },
  })
  host.snapshot.lineages.push({ ...host.snapshot.lineages[0], id: "other", sub: "other" })
  expect(await resolveGoogleDriveConnection()).toBeNull()
  host.snapshot.lineages.pop()
  expect(await resolveGoogleDriveConnection()).toBeNull()
})
it("does not fall back after an explicit unbind even with one eligible account", async () => {
  await saveSettings({
    backupDestinations: {
      googleDrive: { enabled: true, clientId: "backup", connectionId: null },
    },
  })
  expect(await resolveGoogleDriveConnection()).toBeNull()
  expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBeNull()
  const row = await bindGoogleDriveConnection("native")
  expect(row.hostMetadata?.adapterId).toBe("native")
  expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBe(row.id)
})
it.each(["client", "scope", "needs-reauth", "disconnected"])(
  "does not bind a wrong client, missing scope or unavailable grant: %s",
  async (variant) => {
    const lineage = host.snapshot.lineages[0]
    if (variant === "client") lineage.clientId = "wrong"
    if (variant === "scope") lineage.scopes = ["docs.read"]
    if (variant === "needs-reauth") lineage.status = "needs-reauth"
    if (variant === "disconnected") lineage.status = "disconnected"
    expect(await resolveGoogleDriveConnection()).toBeNull()
  }
)
it("never silently replaces a known disconnected binding with another account", async () => {
  const row = await resolveGoogleDriveConnection()
  host.snapshot.lineages[0].status = "disconnected"
  host.snapshot.lineages[0].revision = "disconnected"
  host.snapshot.lineages.push({
    ...host.snapshot.lineages[0],
    id: "other",
    sub: "other",
    status: "connected",
  })
  expect(await resolveGoogleDriveConnection()).toBeNull()
  expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBe(row?.id)
})
it("binds the exact authorized lineage even when several accounts are connected", async () => {
  host.snapshot.lineages.push({ ...host.snapshot.lineages[0], id: "other", sub: "other" })
  const row = await bindGoogleDriveConnection("other")
  expect(row.hostMetadata?.adapterId).toBe("other")
  await expect(bindGoogleDriveConnection("unknown")).rejects.toMatchObject({
    name: "ConnectionUnavailableError",
  })
})
it("gets an access-token lease from the Host connection and rejects a moved revision", async () => {
  host.handle = async (input) =>
    input.action === "accessToken"
      ? {
          ...host.snapshot,
          credential: {
            accessToken: "host-access",
            expiresAt: Date.now() + 3_600_000,
            revision: "auth-1",
            credentialRevision: "creds-1",
          },
        }
      : undefined
  const credentials = jest.spyOn(getConnectionManager(), "getCredentials")
  const lease = await getGoogleDriveCredentialLease()
  expect(lease.accessToken).toBe("host-access")
  expect(credentials).toHaveBeenCalledWith((await listGoogleConnections())[0].id, {
    minValidityMs: 60_000,
  })
  expect(host.calls).toContainEqual(
    expect.objectContaining({ action: "accessToken", lineageId: "native" })
  )
  host.snapshot.lineages[0].revision = "auth-2"
  await expect(lease.assertCurrent()).rejects.toMatchObject({ name: "ConnectionRevisionChanged" })
  credentials.mockRestore()
})

it("makes simultaneous single-candidate binding idempotent", async () => {
  const [first, second] = await Promise.all([
    resolveGoogleDriveConnection(),
    resolveGoogleDriveConnection(),
  ])
  expect(first?.id).toBe(second?.id)
  expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBe(first?.id)
})
it("retains the revision fence when credential acquisition fails after reauthorization", async () => {
  const credentials = jest.spyOn(getConnectionManager(), "getCredentials")
  credentials.mockImplementationOnce(async () => {
    host.snapshot.lineages[0].revision = "reauthorized-during-refresh"
    throw new Error("late refresh refused")
  })
  try {
    await expect(getGoogleDriveCredentialLease()).rejects.toMatchObject({
      name: "ConnectionRevisionChanged",
    })
  } finally {
    credentials.mockRestore()
  }
})
it("does not replace a known wrong-client binding with an eligible account", async () => {
  host.snapshot.lineages.push({
    ...host.snapshot.lineages[0],
    id: "wrong",
    clientId: "wrong-client",
    sub: "wrong-sub",
  })
  const wrong = (await listGoogleConnections()).find((row) => row.clientId === "wrong-client")!
  await saveSettings({
    backupDestinations: {
      googleDrive: { enabled: true, clientId: "backup", connectionId: wrong.id },
    },
  })
  expect(await resolveGoogleDriveConnection()).toBeNull()
})
