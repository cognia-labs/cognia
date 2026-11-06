/** @jest-environment jsdom */
import { LOCAL_PERSON_RUN, startToolExecutionRun } from "@/lib/execution/acting-authority"
import { waitFor } from "@testing-library/react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getAuthConnection, listAuthConnections } from "@/lib/db/auth-connections"
import { getSettings } from "@/lib/db/settings"
import { getPlugin } from "@/lib/db/plugins"
import {
  __resetAuthRegistryForTesting,
  getProvider,
} from "@/lib/plugin/auth/auth-provider-registry"
import { getConnectionManager, getHostConnectionDriver } from "@/lib/plugin/auth/connection-manager"
import { connectionMetadata, hostAuthProviderServices } from "@/lib/plugin/auth/connection-access"
import { withAuthLock } from "@/lib/plugin/auth/connection-credentials"
import { createAuthConnectionsAPI } from "@/lib/plugin/auth/connections-api"
import {
  googleState,
  subscribeGoogleStateChanged,
  type GoogleStateReply,
} from "@/lib/auth-providers/google/state"
import {
  registerIntegrationDefinitions,
  __resetIntegrationRegistryForTesting,
} from "@/lib/integrations/registry"
import {
  registerExternalServices,
  unregisterExternalServicesByPlugin,
} from "@/lib/external-services/catalog"
import { createIntegrationAccount } from "@/lib/db/integrations"
import { listServiceConnections, putCapabilityGrant } from "@/lib/db/external-services"
import { authenticatedIntegrationRequest } from "@/lib/integrations/action-runner"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { openUrl } from "@/lib/native/opener"
import { connectorsEnsureServer } from "@/lib/connectors/tauri/commands"
import { isHeadlessHost, isTauri } from "@/lib/platform/detect"
import {
  ensureGoogleHostProvider,
  reconcileGoogleConnections,
  resolveGoogleConnection,
  authorizeGoogleConnection,
  startGoogleHostAuth,
  createGoogleDeviceAuthorization,
} from "./host-auth"

jest.mock("@/lib/auth-providers/google/state", () => ({
  googleState: jest.fn(),
  subscribeGoogleStateChanged: jest.fn(() => jest.fn()),
}))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn() }))
jest.mock("@/lib/db/plugins", () => ({ getPlugin: jest.fn() }))
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsEnsureServer: jest.fn() }))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
jest.mock("@/lib/platform/detect", () => ({
  isTauri: jest.fn(() => true),
  isHeadlessHost: jest.fn(() => false),
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
let snapshot: GoogleStateReply
beforeEach(async () => {
  await fixture.restore()
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  unregisterExternalServicesByPlugin("business")
  jest.clearAllMocks()
  jest.mocked(isTauri).mockReturnValue(true)
  jest.mocked(isHeadlessHost).mockReturnValue(false)
  jest
    .mocked(getSettings)
    .mockResolvedValue({ docsProviders: { google: { clientId: "desktop-client" } } } as never)
  jest
    .mocked(getPlugin)
    .mockResolvedValue({ manifest: { requiresServices: { "auth.google": "^1.0.0" } } } as never)
  jest.mocked(connectorsEnsureServer).mockResolvedValue("127.0.0.1:7842")
  snapshot = {
    lineages: [
      {
        id: "native-lineage",
        clientId: "desktop-client",
        method: "loopback-pkce",
        scopes: ["docs.read"],
        sub: "google-sub",
        email: "ada@example.test",
        status: "connected",
        revision: "nonce-1",
        credentialRevision: "credential-1",
        needsIdentity: false,
      },
    ],
    clients: [{ clientId: "desktop-client", hasClientSecret: true }],
    pending: [],
    migrationNeedsClientId: false,
    backupMigrationNeedsClientId: false,
  }
  jest.mocked(googleState).mockImplementation(async (input) => {
    if (input.action === "accessToken")
      return {
        ...snapshot,
        credential: {
          accessToken: "private-access",
          expiresAt: Date.now() + 3_600_000,
          revision: snapshot.lineages[0].revision,
          credentialRevision: snapshot.lineages[0].credentialRevision,
        },
      }
    if (input.action === "begin")
      return {
        ...snapshot,
        attempt: {
          attemptId: "attempt",
          authorizeUrl: "https://accounts.google.com/authorize",
          expiresAt: Date.now() + 600_000,
        },
      }
    if (input.action === "disconnect")
      snapshot.lineages[0] = {
        ...snapshot.lineages[0],
        status: "disconnected",
        revision: "disconnected",
      }
    return structuredClone(snapshot)
  })
})

it("reconciles identities idempotently and registers auth.google 1.0.0 without secrets in Dexie or metadata", async () => {
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  expect(row).toMatchObject({
    providerId: "google",
    ownerPluginId: null,
    publisher: "cognia",
    contractMajor: 1,
    issuer: "https://accounts.google.com",
    clientId: "desktop-client",
    principalId: "google-sub",
    principalKind: "user",
    accountLabel: "ada@example.test",
    revision: 1,
    credentialRevision: 1,
    hostMetadata: { adapterId: "native-lineage", authorizationEpoch: "nonce-1" },
  })
  expect(await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })).toEqual([row])
  expect(getProvider("google")?.pluginId).toBeNull()
  expect(hostAuthProviderServices()).toContainEqual({
    providerId: "google",
    services: { "auth.google": "1.0.0" },
  })
  ensureGoogleHostProvider()
  expect(hostAuthProviderServices().filter((item) => item.providerId === "google")).toHaveLength(1)
  expect(connectionMetadata(row)).not.toHaveProperty("hostMetadata")
  expect(JSON.stringify(await getDb().authConnections.toArray())).not.toMatch(
    /private-access|refreshToken|clientSecret/
  )
})

it("changes credentialRevision only on refresh and revision only on authorization changes", async () => {
  const [first] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  snapshot.lineages[0].credentialRevision = "credential-2"
  expect(
    (await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN }))[0]
  ).toMatchObject({
    id: first.id,
    revision: 1,
    credentialRevision: 2,
  })
  snapshot.lineages[0].revision = "nonce-2"
  snapshot.lineages[0].scopes.push("new.scope")
  expect(
    (await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN }))[0]
  ).toMatchObject({
    id: first.id,
    revision: 2,
    credentialRevision: 2,
    scopes: ["docs.read", "new.scope"],
  })
})

it("keeps different OAuth clients as independent connections for the same principal", async () => {
  snapshot.lineages.push({
    ...snapshot.lineages[0],
    id: "backup-lineage",
    clientId: "backup-client",
    method: "device-code",
  })
  const rows = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map((row) => row.id)).size).toBe(2)
  expect(rows.map((row) => row.clientId).sort()).toEqual(["backup-client", "desktop-client"])
})

it.each(["disconnected", "missing"])(
  "tombstones a native %s lineage without recreating it",
  async (status) => {
    const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
    if (status === "missing") snapshot.lineages = []
    else snapshot.lineages[0].status = "disconnected"
    await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
    await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
    expect(await getAuthConnection(row.id)).toMatchObject({ status: "tombstoned", revision: 2 })
  }
)

it("orders snapshot reads with other windows so a stale disconnect cannot tombstone a newer reauthorization", async () => {
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  snapshot.lineages[0] = {
    ...snapshot.lineages[0],
    status: "disconnected",
    revision: "disconnected",
  }
  // A snapshot reply reflects native state when it is READ, and may arrive late.
  let openGate!: () => void
  const gate = new Promise<void>((resolve) => (openGate = resolve))
  const answer = jest.mocked(googleState).getMockImplementation()!
  jest.mocked(googleState).mockImplementation(async (input) => {
    if (input.action !== "snapshot") return answer(input)
    const seen = await answer(input)
    await gate
    return seen
  })
  const snapshotReads = () =>
    jest.mocked(googleState).mock.calls.filter(([input]) => input.action === "snapshot").length
  const readsBefore = snapshotReads()
  // Another window holds the reconcile lock while native state is reauthorized.
  let entered!: () => void
  const otherWindowEntered = new Promise<void>((resolve) => (entered = resolve))
  let release!: () => void
  const otherWindow = withAuthLock(
    "cognia-auth-provider:google:reconcile",
    async () => {
      entered()
      await new Promise<void>((resolve) => (release = resolve))
    },
    "provider-reconcile"
  )
  await otherWindowEntered
  const stale = reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(snapshotReads()).toBe(readsBefore)
    snapshot.lineages[0] = {
      ...snapshot.lineages[0],
      status: "connected",
      revision: "nonce-2",
      credentialRevision: "credential-2",
    }
    await getConnectionManager().reconcileHostConnection(
      "google",
      {
        issuer: "https://accounts.google.com",
        clientId: "desktop-client",
        principal: { id: "google-sub", kind: "user" },
        accountLabel: "ada@example.test",
        scopes: ["docs.read"],
      },
      {
        adapterId: "native-lineage",
        authorizationEpoch: "nonce-2",
        credentialVersion: "credential-2",
        bot: false,
      }
    )
  } finally {
    // A failed assertion must not leave the shared lock held for later tests.
    openGate()
    release()
  }
  await otherWindow
  await stale
  expect(await getAuthConnection(row.id)).toMatchObject({
    status: "connected",
    hostMetadata: { authorizationEpoch: "nonce-2" },
  })
})

it("retains invalid_grant as needs-reauth until a new authorization nonce", async () => {
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  snapshot.lineages[0].status = "needs-reauth"
  expect(
    (await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN }))[0]
  ).toMatchObject({
    id: row.id,
    status: "needs-reauth",
    revision: 1,
  })
  expect(
    (await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN }))[0].status
  ).toBe("needs-reauth")
  await expect(
    getConnectionManager().getCredentials(row.id, {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
    })
  ).rejects.toMatchObject({
    reason: "needs-reauth",
  })
  snapshot.lineages[0].status = "connected"
  snapshot.lineages[0].revision = "reauthorized"
  expect(
    (await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN }))[0]
  ).toMatchObject({
    id: row.id,
    status: "connected",
    revision: 2,
  })
})

it("gets access credentials only from Rust and discards a nonce that moved during the request", async () => {
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  expect(
    await getConnectionManager().getCredentials(row.id, {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
    })
  ).toMatchObject({
    accessToken: "private-access",
    scopes: ["docs.read"],
  })
  expect(googleState).toHaveBeenCalledWith(
    {
      action: "accessToken",
      lineageId: "native-lineage",
      minValidityMs: 60_000,
    },
    expect.objectContaining({
      connectionAuthorization: expect.any(Object),
      lineageId: "native-lineage",
    })
  )
  const native = jest.mocked(googleState).getMockImplementation()!
  jest.mocked(googleState).mockImplementation(async (input) =>
    input.action === "accessToken"
      ? {
          ...snapshot,
          credential: {
            accessToken: "late-access",
            expiresAt: 9_999_999_999_999,
            revision: "new-auth",
            credentialRevision: "credential-2",
          },
        }
      : native(input)
  )
  await expect(
    getConnectionManager().getCredentials(row.id, {
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
    })
  ).rejects.toMatchObject({
    reason: "authorization-changed",
  })
})

it("disconnects through the native lineage without importing refresh material", async () => {
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  await expect(getConnectionManager().disconnect(row.id)).rejects.toMatchObject({
    name: "PersonalCredentialRefusedError",
  })
  expect(await getAuthConnection(row.id)).toMatchObject({ status: "connected" })
  expect(googleState).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "disconnect" }),
    expect.anything()
  )
  await getConnectionManager().disconnect(row.id, {
    credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
  })
  expect(googleState).toHaveBeenCalledWith(
    { action: "disconnect", lineageId: "native-lineage" },
    { localAuthorization: LOCAL_PERSON_RUN }
  )
  expect(await getAuthConnection(row.id)).toMatchObject({ status: "tombstoned" })
  await expect(resolveGoogleConnection(row.id)).rejects.toMatchObject({
    name: "ConnectionUnavailableError",
  })
})

it("reauthorizes through Begin with the native client, scopes, lineage and actual callback port", async () => {
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  snapshot.lineages[0].status = "needs-reauth"
  jest.mocked(connectorsEnsureServer).mockResolvedValue("127.0.0.1:7843")
  await authorizeGoogleConnection(row.id, { localAuthorization: LOCAL_PERSON_RUN })
  expect(googleState).toHaveBeenCalledWith({
    action: "begin",
    clientId: "desktop-client",
    scopes: ["docs.read"],
    reauthorizeLineage: "native-lineage",
    redirectUri: "http://127.0.0.1:7843/oauth/docs/google/callback",
  })
  expect(openUrl).toHaveBeenCalledWith("https://accounts.google.com/authorize")
  expect(getHostConnectionDriver("google")?.reauthorize).toBeDefined()
})

it("passes the backup client hint alongside the Docs client during reconciliation", async () => {
  jest.mocked(getSettings).mockResolvedValue({
    docsProviders: { google: { clientId: "desktop-client" } },
    backupDestinations: { googleDrive: { enabled: true, clientId: " backup-client " } },
  } as never)
  await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  expect(googleState).toHaveBeenCalledWith(
    {
      action: "snapshot",
      legacyClientId: "desktop-client",
      legacyBackupClientId: "backup-client",
    },
    { localAuthorization: LOCAL_PERSON_RUN }
  )
})

it.each(["desktop", "headless"])(
  "does not issue user-authenticated snapshots on unproven %s boot or change signals, and stops its subscription",
  async (host) => {
    jest.mocked(isTauri).mockReturnValue(host === "desktop")
    jest.mocked(isHeadlessHost).mockReturnValue(host === "headless")
    const stop = startGoogleHostAuth()
    try {
      await waitFor(() => expect(subscribeGoogleStateChanged).toHaveBeenCalledTimes(1))
      expect(googleState).not.toHaveBeenCalled()
      snapshot.lineages[0].status = "disconnected"
      jest.mocked(subscribeGoogleStateChanged).mock.calls.at(-1)![0]()
      await reconcileGoogleConnections()
      expect(googleState).not.toHaveBeenCalled()
      expect(await listAuthConnections("google")).toEqual([])
      await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
      expect(googleState).toHaveBeenCalledWith(expect.objectContaining({ action: "snapshot" }), {
        localAuthorization: LOCAL_PERSON_RUN,
      })
    } finally {
      stop()
    }
    expect(jest.mocked(subscribeGoogleStateChanged).mock.results.at(-1)!.value).toHaveBeenCalled()
  }
)

it("does not start the provider from a browser that cannot invoke the Rust command", () => {
  jest.mocked(isTauri).mockReturnValue(false)
  startGoogleHostAuth()()
  expect(googleState).not.toHaveBeenCalled()
  expect(subscribeGoogleStateChanged).not.toHaveBeenCalled()
})

it("requires the business consumer grant at injection for auth.google and exposes only metadata", async () => {
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  const api = createAuthConnectionsAPI("business", () => true)
  const selected = await api.get({ service: "auth.google", scopes: ["docs.read"] })
  expect(selected).toMatchObject({ ref: row.id, providerId: "google" })
  expect(JSON.stringify(selected)).not.toMatch(/private-access|native-lineage|hostMetadata/)
  registerExternalServices("business", [
    {
      id: "documents",
      label: "Documents",
      fallbackPolicy: "never",
      providers: [
        {
          id: "api",
          kind: "integration",
          contributionId: "documents",
          priority: 1,
          surfaces: ["chat"],
        },
      ],
    },
  ])
  registerIntegrationDefinitions({
    pluginId: "business",
    definitions: [
      {
        id: "documents",
        label: "Documents",
        allowedOrigins: ["https://docs.googleapis.com"],
        authStrategies: [
          { id: "oauth", type: "connection", label: "Google", service: "auth.google" },
        ],
        resourceKinds: [],
        eventTypes: [],
        actions: [],
      },
    ],
    handlers: {},
  })
  const account = await createIntegrationAccount("business", {
    integrationId: "documents",
    providerId: "google",
    connectionId: row.id,
    authSessionId: row.id,
    remoteAccountId: "google-sub",
    label: "Ada",
  })
  const url = "https://docs.googleapis.com/v1/documents/doc"
  await expect(authenticatedIntegrationRequest("business", account.id, url)).rejects.toMatchObject({
    name: "ConsumerGrantRequired",
    connectionRef: row.id,
    consumerPluginId: "business",
  })
  expect(proxyFetch).not.toHaveBeenCalled()
  const [projection] = await listServiceConnections({ pluginId: "business" })
  await putCapabilityGrant({
    id: "google-consumer-grant",
    connectionId: projection.id,
    providerFingerprint: projection.providerFingerprint,
    consumerPluginId: "business",
    connectionRevision: row.revision,
    operationPatterns: ["documents.request.GET"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  jest.mocked(proxyFetch).mockResolvedValue(
    new Response(JSON.stringify({ title: "Doc" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )
  jest.mocked(googleState).mockClear()
  expect((await authenticatedIntegrationRequest("business", account.id, url)).data).toEqual({
    title: "Doc",
  })
  expect(new Headers(jest.mocked(proxyFetch).mock.calls[0][1]?.headers).get("authorization")).toBe(
    "Bearer private-access"
  )
  expect(jest.mocked(googleState).mock.calls.map(([input]) => input.action)).toEqual([
    "accessToken",
  ])
  expect(JSON.stringify(await api.list())).not.toMatch(/private-access|refreshToken|hostMetadata/)
})

it("reauthorizes device-code lineages through the Host driver without starting loopback", async () => {
  snapshot.lineages[0].method = "device-code"
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  const answer = jest.mocked(googleState).getMockImplementation()!
  jest.mocked(googleState).mockImplementation(async (input) =>
    input.action === "beginDevice"
      ? {
          ...snapshot,
          attempt: {
            attemptId: "device",
            userCode: "ABCD",
            verificationUrl: "https://google.com/device",
            expiresAt: Date.now() + 60_000,
            interval: 5,
          },
        }
      : answer(input)
  )
  const authorization = await getHostConnectionDriver("google")!.reauthorize!(row.id, {
    credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
  })
  expect(googleState).toHaveBeenCalledWith({
    action: "beginDevice",
    clientId: "desktop-client",
    scopes: ["docs.read"],
    reauthorizeLineage: "native-lineage",
  })
  expect(authorization).toMatchObject({ kind: "device-code", userCode: "ABCD", intervalSeconds: 5 })
  await authorization!.cancel()
  expect(googleState).toHaveBeenCalledWith({ action: "cancel", attemptId: "device" })
  expect(connectorsEnsureServer).not.toHaveBeenCalled()
  expect(openUrl).not.toHaveBeenCalled()
})

it("adapts device polls, applies slow_down and reconciles the exact authorized lineage before resolving", async () => {
  const authorization = createGoogleDeviceAuthorization(
    {
      attemptId: "device",
      userCode: "ABCD",
      verificationUrl: "https://google.com/device",
      expiresAt: Date.now() + 60_000,
      interval: 5,
    },
    { localAuthorization: LOCAL_PERSON_RUN }
  )
  jest.mocked(googleState).mockResolvedValueOnce({ ...snapshot, pollStatus: "pending" })
  expect(await authorization.poll()).toEqual({ status: "pending", intervalSeconds: 5 })
  jest.mocked(googleState).mockResolvedValueOnce({ ...snapshot, pollStatus: "slow_down" })
  expect(await authorization.poll()).toEqual({ status: "slow_down", intervalSeconds: 10 })
  snapshot.lineages[0].revision = "reauthorized"
  jest
    .mocked(googleState)
    .mockResolvedValueOnce({ ...snapshot, pollStatus: "connected", lineageId: "native-lineage" })
  expect(await authorization.poll()).toEqual({ status: "authorized" })
  expect(authorization.lineageId).toBe("native-lineage")
  expect((await listAuthConnections("google"))[0].hostMetadata?.authorizationEpoch).toBe(
    "reauthorized"
  )
  expect(googleState).toHaveBeenCalledWith(
    { action: "pollDevice", attemptId: "device" },
    { localAuthorization: LOCAL_PERSON_RUN }
  )
})

it.each(["denied", "expired"] as const)(
  "passes through device poll %s without authorizing",
  async (status) => {
    const authorization = createGoogleDeviceAuthorization(
      {
        attemptId: "device",
        userCode: "ABCD",
        verificationUrl: "https://google.com/device",
        expiresAt: Date.now() + 60_000,
      },
      { localAuthorization: LOCAL_PERSON_RUN }
    )
    jest.mocked(googleState).mockResolvedValueOnce({ ...snapshot, pollStatus: status })
    expect(await authorization.poll()).toMatchObject({ status })
    expect(authorization.lineageId).toBeUndefined()
  }
)

it("refuses unproven and non-person Google reads before the native token exit, including a forged driver authorization", async () => {
  const [row] = await reconcileGoogleConnections({ localAuthorization: LOCAL_PERSON_RUN })
  const run = await startToolExecutionRun(undefined, { runId: "google-external" })
  jest.mocked(googleState).mockClear()
  for (const credentialContext of [undefined, { executionRunId: run.id }]) {
    await expect(
      getConnectionManager().getCredentials(row.id, { credentialContext })
    ).rejects.toMatchObject({
      name: "PersonalCredentialRefusedError",
      decision: { source: "google-docs" },
    })
  }
  await expect(
    getHostConnectionDriver("google")!.getCredentials(row, {} as never)
  ).rejects.toMatchObject({ reason: "credential-admission-missing" })
  expect(
    jest.mocked(googleState).mock.calls.some(([request]) => request.action === "accessToken")
  ).toBe(false)
})
