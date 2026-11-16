/** @jest-environment jsdom */
import { createHash } from "node:crypto"
import { larkDeployment } from "@cognia/feishu-protocol"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { listAuthConnections } from "@/lib/db/auth-connections"
import {
  getConnectionManager,
  ConnectionIdentityConflict,
} from "@/lib/plugin/auth/connection-manager"
import {
  registerAuthenticationProvider,
  getProvider,
  __resetAuthRegistryForTesting,
} from "@/lib/plugin/auth/auth-provider-registry"
import { connectionAccess, connectionMetadata } from "@/lib/plugin/auth/connection-access"
import {
  connectorsLarkUserAuth,
  connectorsKeyringGet,
  connectorsHttpRequest,
} from "@/lib/connectors/tauri/commands"
import { getPlugin } from "@/lib/db/plugins"
import {
  reconcileLarkConnection,
  reconcileLarkAdapter,
  resolveLarkConnection,
  authorizeLarkConnection,
  assertLarkIdentityAvailable,
  startLarkHostAuth,
  markLarkNeedsReauth,
  larkConnectionAdapter,
  larkOwner,
  larkOwnerKey,
  larkAuthorizedPerson,
  larkActingPerson,
  larkActingKey,
  listLarkConnections,
} from "./host-auth"
import { beginLarkOAuth } from "./oauth-begin"
import { openUrl } from "@/lib/native/opener"
import { connectorListen } from "@/lib/connectors/events"
import { waitFor } from "@testing-library/react"
jest.mock("./oauth-begin", () => ({ beginLarkOAuth: jest.fn() }))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
jest.mock("@/lib/connectors/events", () => ({ connectorListen: jest.fn(async () => jest.fn()) }))
import { refreshUserToken } from "./auth"
import { withAuthLock } from "@/lib/plugin/auth/connection-credentials"
import { larkDocsProvider } from "@/lib/lark-docs/provider"
import {
  captureKeptCopyProvenance,
  resolveKeptCopySource,
} from "@/lib/docs-providers/kept-copy-source"
import { getDocsProvider } from "@/lib/docs-providers/registry"
import { createAuthConnectionsAPI } from "@/lib/plugin/auth/connections-api"
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
import { createLarkTaskSyncProvider } from "@/lib/issues/sync/providers/lark-task"
import { createLarkBitableSyncProvider } from "@/lib/issues/sync/providers/lark-bitable"
import { fetchLarkDocAsRawSource } from "@/lib/twin/ingest/lark-doc-fetcher"
import type { IssueSyncBinding } from "@/lib/issues/sync/types"
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsLarkUserAuth: jest.fn(),
  connectorsKeyringGet: jest.fn(),
  connectorsHttpRequest: jest.fn(),
}))
jest.mock("@/lib/db/plugins", () => ({ getPlugin: jest.fn() }))
jest.mock("@/lib/docs-providers/registry", () => {
  const getDocsProvider = jest.fn()
  return {
    getDocsProvider,
    resolveDocsProvider: async (id: string) => getDocsProvider(id),
    whenDocsProvidersReady: async () => {},
  }
})
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
type LarkUserAuthState = Awaited<ReturnType<typeof connectorsLarkUserAuth>>
/** `larkUserKey(openId)`: the key a person's authorization is stored under. */
const keyOf = (openId: string) => createHash("sha256").update(openId).digest("hex")
/** Ada signed the connector in (the owner); Bob authorized it too. */
const ADA = keyOf("ou_ada")
const BOB = keyOf("ou_bob")
const ADA_USER = { openId: "ou_ada", tenantKey: "tenant", authorizationEpoch: "epoch-1" }
const BOB_USER = { openId: "ou_bob", tenantKey: "tenant", authorizationEpoch: "bob-epoch-1" }
const BOB_STATE: LarkUserAuthState = {
  configured: true,
  authorizationEpoch: "bob-epoch-1",
  accessToken: "bob-user-token",
  refreshToken: "bob-refresh",
  refreshRevision: "bob-r1",
  accountLabel: "Bob",
  scopes: ["search:docs:read"],
}
const UNCONFIGURED: LarkUserAuthState = {
  configured: false,
  authorizationEpoch: "none",
  accessToken: null,
  refreshToken: null,
  refreshRevision: null,
  accountLabel: null,
  scopes: [],
}
/** Ada's Host authorization. */
let state: LarkUserAuthState
/** Everyone else's, by key. */
let others: Record<string, LarkUserAuthState>
const authOf = (principal: string) =>
  principal === ADA ? state : (others[principal] ?? UNCONFIGURED)
const setAuth = (principal: string, next: LarkUserAuthState) => {
  if (principal === ADA) state = next
  else others[principal] = next
}
/** Bob authorizes the adapter alongside Ada. */
async function addBob() {
  others[BOB] = { ...BOB_STATE }
  await getDb().adapterInstances.update("adapter", {
    [`settings.authorizedUsers.${BOB}`]: BOB_USER,
  })
}
beforeEach(async () => {
  await fixture.restore()
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  unregisterExternalServicesByPlugin("business")
  jest.clearAllMocks()
  state = {
    configured: true,
    authorizationEpoch: "epoch-1",
    accessToken: "private-user-token",
    refreshToken: "private-refresh",
    refreshRevision: "native-r1",
    accountLabel: "Ada",
    scopes: ["search:docs:read"],
  }
  others = {}
  jest.mocked(connectorsLarkUserAuth).mockImplementation(async (input) => {
    const current = authOf(input.principal)
    if (input.action === "disconnect")
      setAuth(input.principal, {
        ...current,
        accessToken: null,
        refreshToken: null,
        authorizationEpoch: "disconnected",
      })
    if (input.action === "refresh")
      setAuth(input.principal, {
        ...current,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        refreshRevision: `${current.refreshRevision}-rotated`,
      })
    return { ...authOf(input.principal) }
  })
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_adapter, name) => (name === "appId" ? "cli_app" : "app-secret"))
  jest.mocked(getPlugin).mockImplementation(
    async (id) =>
      ({
        manifest:
          id === "business"
            ? { requiresServices: { "auth.feishu": "^1.0.0" } }
            : { author: "third-party", providesServices: { "auth.feishu": "1.0.0" } },
      }) as never
  )
  jest.mocked(getDocsProvider).mockReturnValue(larkDocsProvider)
  await getDb().adapterInstances.put({
    id: "adapter",
    type: "lark",
    enabled: true,
    displayName: "Work",
    settings: { connectedUser: ADA_USER, authorizedUsers: { [ADA]: ADA_USER } },
  } as never)
})

/** Moves Ada's authorization (both her record and the owner record) to `epoch`. */
const stampAdaEpoch = (epoch: string) =>
  getDb().adapterInstances.update("adapter", {
    "settings.connectedUser.authorizationEpoch": epoch,
    [`settings.authorizedUsers.${ADA}.authorizationEpoch`]: epoch,
  })

it("injects the Lark credential for an auth.feishu consumer only under its own grant", async () => {
  const row = (await reconcileLarkConnection("adapter", ADA))!
  const consumerApi = createAuthConnectionsAPI("business", () => true)
  const selected = await consumerApi.get({ service: "auth.feishu", scopes: [] })
  expect(selected).toMatchObject({ ref: row.id, providerId: "lark", principalKind: "user" })
  expect(JSON.stringify(selected)).not.toMatch(/private-user-token|private-refresh|adapterId/)
  registerExternalServices("business", [
    {
      id: "calendar",
      label: "Calendar",
      fallbackPolicy: "never",
      providers: [
        {
          id: "api",
          kind: "integration",
          contributionId: "calendar",
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
        id: "calendar",
        label: "Calendar",
        allowedOrigins: ["https://open.feishu.cn"],
        authStrategies: [{ id: "oauth", type: "oauth2", label: "OAuth", providerId: "lark" }],
        resourceKinds: [],
        eventTypes: [],
        actions: [],
      },
    ],
    handlers: {},
  })
  const account = await createIntegrationAccount("business", {
    integrationId: "calendar",
    providerId: "lark",
    connectionId: row.id,
    authSessionId: row.id,
    remoteAccountId: "ou_ada",
    label: "Ada",
  })
  const url = "https://open.feishu.cn/open-apis/calendar/v4/calendars"
  await expect(authenticatedIntegrationRequest("business", account.id, url)).rejects.toMatchObject({
    name: "ConsumerGrantRequired",
    connectionRef: row.id,
    consumerPluginId: "business",
  })
  expect(proxyFetch).not.toHaveBeenCalled()
  const [projection] = await listServiceConnections({ pluginId: "business" })
  await putCapabilityGrant({
    id: "lark-grant",
    connectionId: projection.id,
    providerFingerprint: projection.providerFingerprint,
    consumerPluginId: "business",
    connectionRevision: row.revision,
    operationPatterns: ["calendar.request.GET"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  jest.mocked(proxyFetch).mockResolvedValue(
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  )
  // A raw request is admitted as a background Host service request (the
  // personal sink refuses an unverified direct-UI context for an unknown
  // audience); the grant alone decides whether the credential is injected.
  const response = await authenticatedIntegrationRequest("business", account.id, url)
  expect(response.data).toEqual({ items: [] })
  const headers = new Headers(jest.mocked(proxyFetch).mock.calls[0][1]?.headers)
  expect(headers.get("authorization")).toBe("Bearer private-user-token")
  expect(JSON.stringify(await consumerApi.list())).not.toContain("private-user-token")
})

it("reconciles real identity idempotently, follows epochs, and changes only credentialRevision on refresh", async () => {
  const first = (await reconcileLarkConnection("adapter", ADA))!
  expect(first).toMatchObject({
    providerId: "lark",
    ownerPluginId: null,
    publisher: "cognia",
    contractMajor: 1,
    issuer: "https://accounts.feishu.cn",
    clientId: "cli_app",
    tenantId: "tenant",
    principalId: "ou_ada",
    principalKind: "user",
    revision: 1,
    credentialRevision: 1,
    hostMetadata: {
      adapterId: "adapter",
      principal: ADA,
      person: { kind: "platform", platform: "lark", adapterId: "adapter", remoteUserId: "ou_ada" },
      bot: true,
    },
  })
  expect(await reconcileLarkConnection("adapter", ADA)).toEqual(first)
  state.refreshRevision = "native-r2"
  const refreshed = (await reconcileLarkConnection("adapter", ADA))!
  expect(refreshed).toMatchObject({ id: first.id, revision: 1, credentialRevision: 2 })
  state.authorizationEpoch = "epoch-2"
  await stampAdaEpoch("epoch-2")
  expect(await reconcileLarkConnection("adapter", ADA)).toMatchObject({
    id: first.id,
    revision: 2,
    credentialRevision: 2,
  })
  expect(JSON.stringify(await getDb().authConnections.toArray())).not.toMatch(
    /private-user-token|private-refresh|app-secret/
  )
  expect(connectionMetadata(first)).not.toHaveProperty("hostMetadata")
})

it.each(["task", "bitable"] as const)(
  "resolves %s sync through the connection, preserves resources/watermarks, and refuses disconnected reads and writes",
  async (kind) => {
    const row = (await reconcileLarkConnection("adapter", ADA))!
    const provider =
      kind === "task" ? createLarkTaskSyncProvider() : createLarkBitableSyncProvider()
    const resource =
      kind === "task"
        ? {
            kind: "lark-tasklist",
            adapterId: "adapter",
            tasklistGuid: "tasks",
            name: "Tasks",
            addedAt: 1,
          }
        : {
            kind: "lark-bitable",
            adapterId: "adapter",
            appToken: "base",
            tableId: "table",
            name: "Base",
            addedAt: 1,
            fieldMap: { title: "Name" },
          }
    const binding = {
      providerId: provider.id,
      projectId: "project",
      issueProjectId: "container",
      projectKey: "TASK",
      key: "binding",
      resource,
    } as IssueSyncBinding
    const options = { since: 123456, full: false, credentialContext }
    const savedResource = structuredClone(resource)
    jest.mocked(connectorsHttpRequest).mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, data: { items: [], has_more: false } }),
    })
    expect(await provider.pull(binding, options)).toMatchObject({ items: [], notModified: false })
    expect(resource).toEqual(savedResource)
    expect(options).toEqual({ since: 123456, full: false, credentialContext })
    expect(connectorsHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer private-user-token" }),
      })
    )
    await getConnectionManager().disconnect(row.id)
    jest.mocked(connectorsHttpRequest).mockClear()
    await expect(provider.pull(binding, options)).rejects.toMatchObject({ code: "notAuthorized" })
    await expect(
      provider.push!(
        binding,
        { provider: provider.id, externalId: "item", syncedAt: 1, meta: {} },
        { title: "Updated" },
        {
          id: "issue",
          identifier: "TASK-1",
          number: 1,
          projectId: "project",
          issueProjectId: "container",
          title: "Updated",
          status: "todo",
          statusCategory: "unstarted",
          priority: "none",
          createdBy: { kind: "human" },
          labelIds: [],
          order: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        { credentialContext, idempotencyKey: "disconnected-push", by: { kind: "human" } }
      )
    ).rejects.toMatchObject({ code: "notAuthorized" })
    expect(connectorsHttpRequest).not.toHaveBeenCalled()
    expect(resource).toEqual(savedResource)
    expect(options.since).toBe(123456)
  }
)

it("uses the deployment issuer and resolves legacy tenant identity through user_info", async () => {
  await getDb().adapterInstances.update("adapter", {
    settings: {
      brand: "lark",
      connectedUser: { openId: "ou_ada" },
      authorizedUsers: { [ADA]: { openId: "ou_ada" } },
    },
  })
  jest.mocked(connectorsHttpRequest).mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, data: { open_id: "ou_ada", tenant_key: "lark-tenant" } }),
  })
  expect(await reconcileLarkConnection("adapter", ADA, { credentialContext })).toMatchObject({
    issuer: "https://accounts.larksuite.com",
    tenantId: "lark-tenant",
    principalId: "ou_ada",
  })
  expect(connectorsHttpRequest).toHaveBeenCalledWith(
    expect.objectContaining({ url: "https://open.larksuite.com/open-apis/authen/v1/user_info" })
  )
  // The hydrated identity is written back to the person's record and the owner record.
  const settings = (await getDb().adapterInstances.get("adapter"))!.settings
  expect(settings.authorizedUsers).toEqual({
    [ADA]: expect.objectContaining({ tenantKey: "lark-tenant", authorizationEpoch: "epoch-1" }),
  })
  expect(settings.connectedUser).toMatchObject({ openId: "ou_ada", tenantKey: "lark-tenant" })
})

it("refuses a token whose user_info names a different person than the authorization", async () => {
  await getDb().adapterInstances.update("adapter", {
    settings: {
      connectedUser: { openId: "ou_ada" },
      authorizedUsers: { [ADA]: { openId: "ou_ada" } },
    },
  })
  jest.mocked(connectorsHttpRequest).mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, data: { open_id: "ou_mallory", tenant_key: "tenant" } }),
  })
  await expect(
    reconcileLarkConnection("adapter", ADA, { credentialContext })
  ).rejects.toMatchObject({ name: "ConnectionUnavailableError", reason: "identity-unavailable" })
  expect(await listAuthConnections("lark")).toEqual([])
})

it("publishes nothing for an authorization with no record of who it belongs to", async () => {
  others[BOB] = { ...BOB_STATE }
  await expect(
    reconcileLarkConnection("adapter", BOB, { credentialContext })
  ).rejects.toMatchObject({
    name: "ConnectionUnavailableError",
    reason: "identity-unavailable",
  })
  expect(connectorsHttpRequest).not.toHaveBeenCalled()
  expect(await listAuthConnections("lark")).toEqual([])
})

it.each(["missing-tenant", "old-epoch"])(
  "hydrates a legacy %s account only when the person's Host UI lists accounts",
  async (legacy) => {
    await getDb().adapterInstances.update("adapter", {
      settings: {
        connectedUser: { openId: "ou_ada" },
        authorizedUsers: {
          [ADA]: {
            openId: "ou_ada",
            ...(legacy === "old-epoch" ? { tenantKey: "tenant", authorizationEpoch: "old" } : {}),
          },
        },
      },
    })
    jest.mocked(connectorsHttpRequest).mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, data: { open_id: "ou_ada", tenant_key: "tenant" } }),
    })
    await expect(reconcileLarkConnection("adapter", ADA)).rejects.toMatchObject({
      name: "PersonalCredentialRefusedError",
    })
    await expect(larkDocsProvider.listAccounts()).resolves.toEqual([])
    expect(connectorsHttpRequest).not.toHaveBeenCalled()
    await expect(larkDocsProvider.listAccounts({ credentialContext })).resolves.toEqual([
      { id: expect.any(String), label: "Ada", authorizationEpoch: "1", searchable: true },
    ])
    expect(connectorsHttpRequest).toHaveBeenCalledTimes(1)
    expect(connectorsHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://open.feishu.cn/open-apis/authen/v1/user_info",
        headers: expect.objectContaining({ Authorization: "Bearer private-user-token" }),
      })
    )
    // Once the UI hydrated metadata, background listing needs no personal HTTP.
    await expect(larkDocsProvider.listAccounts()).resolves.toHaveLength(1)
    expect(connectorsHttpRequest).toHaveBeenCalledTimes(1)
  }
)

it("admits local-person Twin ingest through the real Host connection and refuses an unproven agent", async () => {
  const http = jest.fn(async (request: { url: string }) => ({
    status: 200,
    headers: {},
    body: JSON.stringify({
      code: 0,
      data: request.url.includes("raw_content")
        ? { content: "Twin body" }
        : { document: { title: "Twin document" } },
    }),
  }))
  const url = "https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890"
  await expect(
    fetchLarkDocAsRawSource(url, { adapterId: "adapter", httpImpl: http })
  ).rejects.toMatchObject({ code: "larkNotAuthorized" })
  expect(http).not.toHaveBeenCalled()
  await expect(
    fetchLarkDocAsRawSource(url, { adapterId: "adapter", credentialContext, httpImpl: http })
  ).resolves.toMatchObject({ title: "Twin document", text: "Twin body" })
  expect(http).toHaveBeenCalledWith(
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer private-user-token" }),
    })
  )
  expect(await listAuthConnections("lark")).toHaveLength(1)
})

it("tombstones token clearing and disconnect, keeps captured copies, and drops a deleted adapter's connection", async () => {
  const row = (await reconcileLarkConnection("adapter", ADA))!
  expect(await larkDocsProvider.listAccounts()).toEqual([
    { id: row.id, label: "Ada", authorizationEpoch: "1", searchable: true },
  ])
  const provenance = await captureKeptCopyProvenance(
    {
      ref: { providerId: "lark", kind: "doc", id: "doc", title: "Kept" },
      title: "Kept",
      text: "Body",
      format: "text",
    },
    { accountId: row.id, authorizationEpoch: "1" }
  )
  expect(provenance?.connectionScoped).toBe(true)
  await getConnectionManager().disconnect(row.id, { revoke: true })
  expect(connectorsLarkUserAuth).toHaveBeenCalledWith({
    action: "disconnect",
    adapterId: "adapter",
    principal: ADA,
    expectedAuthorizationEpoch: "epoch-1",
  })
  expect((await listAuthConnections("lark"))[0].status).toBe("tombstoned")
  expect(await resolveKeptCopySource(provenance)).toBe("source-disconnected")
  await expect(resolveLarkConnection("adapter", ADA)).rejects.toMatchObject({
    name: "ConnectionUnavailableError",
  })
  await getDb().adapterInstances.delete("adapter")
  await reconcileLarkConnection("adapter", ADA)
  expect(await listAuthConnections("lark")).toEqual([])
  expect(await getDb().remoteDocumentConnections.count()).toBe(1)
})

it("orders snapshot reads with other windows so a stale token clearing cannot tombstone a newer reauthorization", async () => {
  const row = (await reconcileLarkConnection("adapter", ADA))!
  state = { ...state, accessToken: null, refreshToken: null }
  // A snapshot reply reflects native state when it is READ, and may arrive late.
  let openGate!: () => void
  const gate = new Promise<void>((resolve) => (openGate = resolve))
  const answer = jest.mocked(connectorsLarkUserAuth).getMockImplementation()!
  jest.mocked(connectorsLarkUserAuth).mockImplementation(async (input) => {
    if (input.action !== "snapshot") return answer(input)
    const seen = await answer(input)
    await gate
    return seen
  })
  const snapshotReads = () =>
    jest.mocked(connectorsLarkUserAuth).mock.calls.filter(([input]) => input.action === "snapshot")
      .length
  const readsBefore = snapshotReads()
  // Another window holds this adapter's reconcile lock while it reauthorizes.
  let entered!: () => void
  const otherWindowEntered = new Promise<void>((resolve) => (entered = resolve))
  let release!: () => void
  const otherWindow = withAuthLock(
    `cognia-auth-provider:lark:reconcile:adapter:${ADA}`,
    async () => {
      entered()
      await new Promise<void>((resolve) => (release = resolve))
    },
    "provider-reconcile"
  )
  await otherWindowEntered
  const stale = reconcileLarkConnection("adapter", ADA)
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(snapshotReads()).toBe(readsBefore)
    state = {
      ...state,
      authorizationEpoch: "epoch-2",
      accessToken: "private-user-token-2",
      refreshToken: "private-refresh-2",
    }
    await stampAdaEpoch("epoch-2")
    await getConnectionManager().reconcileHostConnection(
      "lark",
      {
        issuer: larkDeployment("feishu").issuer,
        clientId: "cli_app",
        tenantId: "tenant",
        principal: { id: "ou_ada", kind: "user" },
        accountLabel: "Ada",
        scopes: ["search:docs:read"],
      },
      {
        adapterId: "adapter",
        principal: ADA,
        person: {
          kind: "platform",
          platform: "lark",
          adapterId: "adapter",
          remoteUserId: "ou_ada",
        },
        authorizationEpoch: "epoch-2",
        credentialVersion: "native-r1",
        bot: true,
      }
    )
  } finally {
    // A failed assertion must not leave the shared lock held for later tests.
    openGate()
    release()
  }
  await otherWindow
  await stale
  expect((await listAuthConnections("lark")).find((item) => item.id === row.id)).toMatchObject({
    status: "connected",
    hostMetadata: { authorizationEpoch: "epoch-2" },
  })
})
it("marks invalid_grant needs-reauth and does not silently restore it on reconciliation", async () => {
  const row = (await reconcileLarkConnection("adapter", ADA))!
  jest.mocked(connectorsHttpRequest).mockResolvedValue({
    status: 400,
    headers: {},
    body: JSON.stringify({ error: "invalid_grant" }),
  })
  await expect(
    refreshUserToken({
      credentialContext,
      adapterId: "adapter",
      principal: ADA,
      appId: "cli_app",
      appSecret: "secret",
    })
  ).rejects.toMatchObject({ code: "invalid_grant" })
  expect(await reconcileLarkConnection("adapter", ADA)).toMatchObject({
    id: row.id,
    status: "needs-reauth",
    revision: 1,
  })
  await expect(
    getConnectionManager().getCredentials(row.id, { credentialContext })
  ).rejects.toMatchObject({
    reason: "needs-reauth",
  })
})

it("exposes auth.feishu to a declared consumer, and refuses a second provider's identical lineage without changing Lark", async () => {
  const row = (await reconcileLarkConnection("adapter", ADA))!
  expect(await connectionAccess("business", () => {}).visible(row, "auth.feishu")).toBe(true)
  const provider = {
    id: "feishu-alternative",
    pluginId: "third-party",
    label: "Alternative",
    getSessions: async () => [],
    createSession: async () => {
      throw new Error("unused")
    },
    removeSession: async () => {},
    describe: async () => ({
      issuer: row.issuer,
      clientId: row.clientId,
      tenantId: row.tenantId,
      principal: { id: row.principalId, kind: "user" as const },
      accountLabel: "Ada",
      scopes: row.scopes,
    }),
  }
  const dispose = registerAuthenticationProvider(provider)
  try {
    await expect(
      getConnectionManager().createConnectionFromCredentials(provider, {
        accessToken: "plugin-token",
        scopes: row.scopes,
      })
    ).rejects.toBeInstanceOf(ConnectionIdentityConflict)
    expect(await listAuthConnections()).toEqual([row])
    expect(getProvider("lark")?.pluginId).toBeNull()
    expect(await getConnectionManager().getCredentials(row.id, { credentialContext })).toEqual({
      accessToken: "private-user-token",
      scopes: row.scopes,
    })
  } finally {
    dispose()
  }
})

it("tombstones native token clearing and restores the same identity only after a new epoch", async () => {
  const row = (await reconcileLarkConnection("adapter", ADA))!
  state.accessToken = null
  await reconcileLarkConnection("adapter", ADA)
  expect((await listAuthConnections())[0]).toMatchObject({
    id: row.id,
    status: "tombstoned",
    revision: 2,
  })
  state.accessToken = "reauthorized-token"
  state.authorizationEpoch = "epoch-2"
  state.refreshRevision = "native-r2"
  await stampAdaEpoch("epoch-2")
  expect(await reconcileLarkConnection("adapter", ADA)).toMatchObject({
    id: row.id,
    status: "connected",
    revision: 3,
  })
})

it("uses the native refresh coordinator and changes credentialRevision without changing connection revision", async () => {
  const row = (await reconcileLarkConnection("adapter", ADA, {
    expiresAt: "2000-01-01T00:00:00Z",
  }))!
  jest.mocked(connectorsHttpRequest).mockResolvedValue({
    status: 200,
    headers: {},
    body: JSON.stringify({
      access_token: "refreshed",
      refresh_token: "rotated",
      expires_in: 7200,
    }),
  })
  expect(await getConnectionManager().getCredentials(row.id, { credentialContext })).toMatchObject({
    accessToken: "refreshed",
  })
  expect((await listAuthConnections())[0]).toMatchObject({
    id: row.id,
    revision: 1,
    credentialRevision: 2,
  })
  expect(connectorsLarkUserAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "refresh",
      principal: ADA,
      expectedAuthorizationEpoch: "epoch-1",
      expectedRefreshRevision: "native-r1",
    })
  )
})

it("binds adapter reauthorization to the existing Host identity and revision", async () => {
  const row = (await reconcileLarkConnection("adapter", ADA))!
  jest.mocked(beginLarkOAuth).mockResolvedValue({
    authorizeUrl: "https://accounts.feishu.cn/authorize?state=reconnect",
    state: "reconnect",
    redirectUri: "https://relay.test/oauth/lark/callback",
  })
  await authorizeLarkConnection(row.id, "https://relay.test")
  expect(beginLarkOAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      adapterId: "adapter",
      // A reconnect is the same person signing in again.
      issuedTo: ADA,
      connection: { ref: row.id, revision: row.revision },
      extraScopes: row.scopes.join(" "),
    })
  )
  expect(openUrl).toHaveBeenCalledWith("https://accounts.feishu.cn/authorize?state=reconnect")
  await expect(
    assertLarkIdentityAvailable(
      "adapter",
      "cli_app",
      { openId: "ou_other", tenantKey: "tenant" },
      "feishu",
      { ref: row.id, revision: row.revision }
    )
  ).rejects.toMatchObject({ name: "ReconnectIdentityMismatch" })
  await expect(
    assertLarkIdentityAvailable(
      "adapter",
      "cli_app",
      { openId: "ou_ada", tenantKey: "tenant" },
      "feishu",
      { ref: row.id, revision: 99 }
    )
  ).rejects.toMatchObject({ name: "ConnectionRevisionChanged" })
})

it("reconciles at boot and on native authorization events, observes deletion, and disposes listeners", async () => {
  const stop = startLarkHostAuth()
  try {
    await waitFor(async () => expect(await listAuthConnections("lark")).toHaveLength(1))
    const [[event, notify]] = jest.mocked(connectorListen).mock.calls
    expect(event).toBe("lark-user-authorization-changed")
    state.accessToken = null
    notify({ payload: undefined })
    await waitFor(async () =>
      expect((await listAuthConnections("lark"))[0].status).toBe("tombstoned")
    )
    await getDb().adapterInstances.delete("adapter")
    await waitFor(async () => expect(await listAuthConnections("lark")).toEqual([]))
  } finally {
    stop()
  }
  expect(await jest.mocked(connectorListen).mock.results[0].value).toHaveBeenCalled()
})

it("disposes an event registration that completes after runtime shutdown", async () => {
  let complete!: (unlisten: () => void) => void
  jest.mocked(connectorListen).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const stop = startLarkHostAuth()
  stop()
  const unlisten = jest.fn()
  complete(unlisten)
  await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1))
})

describe("one authorization per person (ADR-0243 phase 4)", () => {
  const rowsByPrincipal = async () =>
    Object.fromEntries(
      (await listAuthConnections("lark")).map((row) => [row.hostMetadata!.principal!, row])
    )

  it("names the owner, each authorized person, and whose authorization a local run uses", async () => {
    await addBob()
    const adaPerson = {
      kind: "platform",
      platform: "lark",
      adapterId: "adapter",
      remoteUserId: "ou_ada",
    }
    expect(await larkOwner("adapter")).toEqual({ key: ADA, person: adaPerson })
    expect(await larkOwnerKey("adapter")).toBe(ADA)
    expect(await larkAuthorizedPerson("adapter", BOB)).toEqual({
      ...adaPerson,
      remoteUserId: "ou_bob",
    })
    expect(await larkAuthorizedPerson("adapter", keyOf("ou_stranger"))).toBeUndefined()
    // A local run is the local person's, whose authorization is the owner's.
    expect(await larkActingPerson("adapter", credentialContext)).toEqual({
      key: ADA,
      person: { kind: "local-person" },
    })
    expect(await larkActingKey("adapter", credentialContext)).toBe(ADA)
    // Nobody signed in: the local person, who has no authorization here.
    await getDb().adapterInstances.update("adapter", { "settings.connectedUser": undefined })
    expect(await larkOwner("adapter")).toBeUndefined()
    expect(await larkActingPerson("adapter", credentialContext)).toEqual({
      person: { kind: "local-person" },
    })
    expect(await larkActingKey("adapter", credentialContext)).toBeUndefined()
  })

  it("keeps a separate connection row per person and reconciles every one of them", async () => {
    await addBob()
    await listLarkConnections()
    const rows = await rowsByPrincipal()
    expect(Object.keys(rows).sort()).toEqual([ADA, BOB].sort())
    expect(rows[ADA]).toMatchObject({ principalId: "ou_ada", status: "connected" })
    expect(rows[BOB]).toMatchObject({
      principalId: "ou_bob",
      accountLabel: "Bob",
      status: "connected",
      hostMetadata: {
        adapterId: "adapter",
        principal: BOB,
        person: {
          kind: "platform",
          platform: "lark",
          adapterId: "adapter",
          remoteUserId: "ou_bob",
        },
        authorizationEpoch: "bob-epoch-1",
      },
    })
    expect(rows[ADA].id).not.toBe(rows[BOB].id)
    expect(await larkConnectionAdapter(rows[BOB].id)).toEqual({
      connection: expect.objectContaining({ id: rows[BOB].id }),
      adapterId: "adapter",
      principal: BOB,
    })
    expect((await resolveLarkConnection("adapter", BOB)).id).toBe(rows[BOB].id)
    await expect(resolveLarkConnection("adapter", undefined)).rejects.toMatchObject({
      name: "ConnectionUnavailableError",
      reason: "unavailable",
    })
    // Every snapshot named the person it read.
    for (const [input] of jest.mocked(connectorsLarkUserAuth).mock.calls)
      expect([ADA, BOB]).toContain(input.principal)
  })

  it("gives the local person's UI the owner's token, never another person's", async () => {
    await addBob()
    await reconcileLarkAdapter("adapter")
    const rows = await rowsByPrincipal()
    await expect(
      getConnectionManager().getCredentials(rows[ADA].id, { credentialContext })
    ).resolves.toMatchObject({ accessToken: "private-user-token" })
    await expect(
      getConnectionManager().getCredentials(rows[BOB].id, { credentialContext })
    ).rejects.toMatchObject({ name: "PersonalCredentialRefusedError" })
  })

  it("disconnects one person's authorization and leaves the other's connected", async () => {
    await addBob()
    await reconcileLarkAdapter("adapter")
    const rows = await rowsByPrincipal()
    await getConnectionManager().disconnect(rows[BOB].id, { revoke: true })
    expect(connectorsLarkUserAuth).toHaveBeenCalledWith({
      action: "disconnect",
      adapterId: "adapter",
      principal: BOB,
      expectedAuthorizationEpoch: "bob-epoch-1",
    })
    expect(connectorsLarkUserAuth).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "disconnect", principal: ADA })
    )
    await reconcileLarkAdapter("adapter")
    const after = await rowsByPrincipal()
    expect(after[BOB].status).toBe("tombstoned")
    expect(after[ADA]).toMatchObject({ id: rows[ADA].id, status: "connected", revision: 1 })
    expect(state.accessToken).toBe("private-user-token")
  })

  it("refreshes one person's expiring authorization without touching another's", async () => {
    await addBob()
    const bob = (await reconcileLarkConnection("adapter", BOB))!
    const ada = (await reconcileLarkConnection("adapter", ADA, {
      expiresAt: "2000-01-01T00:00:00Z",
    }))!
    jest.mocked(connectorsHttpRequest).mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({
        access_token: "refreshed",
        refresh_token: "rotated",
        expires_in: 7200,
      }),
    })
    await expect(
      getConnectionManager().getCredentials(ada.id, { credentialContext })
    ).resolves.toMatchObject({ accessToken: "refreshed" })
    const refreshes = jest
      .mocked(connectorsLarkUserAuth)
      .mock.calls.filter(([input]) => input.action === "refresh")
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0][0]).toMatchObject({ principal: ADA, expectedRefreshRevision: "native-r1" })
    expect(others[BOB]).toEqual(BOB_STATE)
    expect((await rowsByPrincipal())[BOB]).toEqual(bob)
  })

  it("marks only the rejected person's authorization as needing reauthorization", async () => {
    await addBob()
    await reconcileLarkAdapter("adapter")
    // A late rejection of an authorization Bob has since replaced changes nothing.
    await markLarkNeedsReauth("adapter", BOB, "bob-epoch-0", "bob-r1")
    expect((await rowsByPrincipal())[BOB].status).toBe("connected")
    await markLarkNeedsReauth("adapter", BOB, "bob-epoch-1", "bob-r1")
    const rows = await rowsByPrincipal()
    expect(rows[BOB].status).toBe("needs-reauth")
    expect(rows[ADA].status).toBe("connected")
  })
})
