/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getAuthConnection, listAuthConnections } from "@/lib/db/auth-connections"
import { createIntegrationAccount } from "@/lib/db/integrations"
import { getPlugin } from "@/lib/db/plugins"
import { getSecret, clearSecret } from "@/lib/keyring"
import { createAuthAPI } from "@/lib/plugin/api/auth-api"
import { createIntegrationsAPI } from "@/lib/plugin/api/integrations-api"
import {
  registerIntegrationDefinitions,
  __resetIntegrationRegistryForTesting,
} from "@/lib/integrations/registry"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { invokePluginApi } from "@/lib/plugin/core/transport"
import { transport } from "@/lib/tauri/transport-instance"
import { openExternal } from "@/lib/tauri/opener"
import { withNamedLock } from "@/lib/locks/named-lock"
import { __resetAuthRegistryForTesting } from "./auth-provider-registry"
import { connectProvider } from "./connect"
import { acceptCallback } from "./callback-acceptor"
import { getConnectionManager, ConnectionIdentityConflict } from "./connection-manager"
import { accountAuthSecrets, setHostAuthBackend } from "./connection-credentials"
import { runLegacySessionMigrations, legacySessionAliases } from "./legacy-session-migrations"
import { getProvider } from "./auth-provider-registry"
import { createFeishuAuthProvider, FEISHU_PROVIDER_ID } from "@/plugins/feishu-auth/src/oauth"
import manifest from "@/plugins/feishu-auth/plugin.json"
import * as calendar from "@/plugins/feishu-calendar/src/index"
import type { IntegrationActionHandler } from "@cognia/plugin-sdk/api/integration"
import { createCalendarSync, type CalendarSyncHost } from "@/plugins/feishu-calendar/src/sync"
import { requestCalendarAccess } from "@/plugins/feishu-calendar/src/connection"
import {
  registerExternalServices,
  unregisterExternalServicesByPlugin,
} from "@/lib/external-services/catalog"
import { subscribeConnectionPrompts, resolveConnectionPrompt } from "./connection-prompts"
import { revokeConsumerAccess } from "./revoke-consumer-access"
import { reconcileLarkConnection } from "@/lib/connectors/adapters/lark/host-auth"
import { connectorsKeyringGet, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"

jest.mock("@/lib/db/plugins", () => ({ getPlugin: jest.fn() }))
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
jest.mock("@/lib/keyring", () => ({
  getSecret: jest.fn(),
  clearSecret: jest.fn(),
  setWebKeyringPassphrase: jest.fn(),
}))
jest.mock("@/lib/plugin/core/transport", () => ({
  ...jest.requireActual("@/lib/plugin/core/transport"),
  isPluginGatewayAvailable: () => true,
  invokePluginApi: jest.fn(),
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(),
  connectorsLarkUserAuth: jest.fn(),
  connectorsHttpRequest: jest.fn(),
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
const scopes = ["calendar:calendar:readonly", "offline_access"]
const configuration = {
  appId: "app-one",
  clientSecret: "host-only-secret",
  redirectUri: "https://cognia.test/plugin-auth/callback",
}
let clock: number
let tokenBody: Record<string, unknown>
let hostSecrets: Map<string, Map<string, string>>
let oldSecrets: Map<string, string>
let get: jest.Mock
const owner = () => createAuthAPI("feishu-auth", { hasPermission: () => true })
function register() {
  const provider = createFeishuAuthProvider({ auth: owner(), network: { get } } as never, {
    now: () => clock,
  })
  owner().registerProvider(provider)
  return provider
}
function legacy(id = "legacy-one", app = "app-one", secret = "legacy-app-secret") {
  const key = `oauth-session:${id}`
  oldSecrets.set(
    key,
    JSON.stringify({
      version: 1,
      session: {
        id,
        accessToken: `old-access-${id}`,
        account: { id: `${app}:ou_one`, label: "Person" },
        scopes,
      },
      configuration: {
        clientId: app,
        clientSecret: secret,
        redirectUri: configuration.redirectUri,
      },
      refreshToken: `old-refresh-${id}`,
      expiresAt: clock + 10000,
      refreshExpiresAt: clock + 86400000,
    })
  )
  localStorage.setItem(
    "cognia.plugin-secrets-index.feishu-auth",
    JSON.stringify([...oldSecrets.keys()])
  )
  return key
}
beforeEach(async () => {
  await fixture.restore()
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  localStorage.clear()
  jest.clearAllMocks()
  clock = Date.now()
  tokenBody = {
    code: 0,
    access_token: "user-token",
    refresh_token: "refresh-one",
    expires_in: 7200,
    scope: scopes.join(" "),
  }
  hostSecrets = new Map()
  oldSecrets = new Map()
  setHostAuthBackend({
    lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
    storeFor(namespace) {
      const values = hostSecrets.get(namespace) ?? new Map<string, string>()
      hostSecrets.set(namespace, values)
      return {
        load: async (key) => values.get(key) ?? null,
        save: async (key, value) => {
          values.set(key, value)
        },
        delete: async (key) => {
          values.delete(key)
        },
        isPersistent: () => true,
      }
    },
  })
  jest.mocked(getSecret).mockImplementation(async ({ key }) => oldSecrets.get(key) ?? null)
  jest.mocked(clearSecret).mockImplementation(async ({ key }) => {
    oldSecrets.delete(key)
  })
  jest.mocked(transport.call).mockImplementation(async (command, args) => {
    const key = (args as { input: { key: string } }).input.key
    if (command === "secret_store_get") return (oldSecrets.get(key) as never) ?? (null as never)
    oldSecrets.delete(key)
    return undefined as never
  })
  jest.mocked(getPlugin).mockResolvedValue({ manifest } as never)
  jest
    .mocked(invokePluginApi)
    .mockImplementation(async (_plugin, op) =>
      op === "auth:exchange"
        ? ({ status: tokenBody.error ? 400 : 200, body: { ...tokenBody } } as never)
        : (undefined as never)
    )
  jest.mocked(openExternal).mockImplementation(async (raw) => {
    await acceptCallback(
      { state: new URL(raw).searchParams.get("state")!, code: "accepted-code" },
      "broadcast"
    )
  })
  get = jest.fn(async () => ({
    ok: true,
    status: 200,
    data: { code: 0, data: { open_id: "ou_one", tenant_key: "tenant-one", name: "Person" } },
  }))
})
afterEach(() => {
  setHostAuthBackend(null)
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  jest.restoreAllMocks()
})

it("connects PKCE, stores the resolved App ID, rotates only credential revision, then needs reauth", async () => {
  const messages = ["log", "warn", "error"].map((level) =>
    jest.spyOn(console, level as "log" | "warn" | "error").mockImplementation(() => {})
  )
  const provider = register()
  const ref = await connectProvider({ providerId: FEISHU_PROVIDER_ID, scopes, configuration })
  const initial = (await getAuthConnection(ref))!
  expect(initial).toMatchObject({
    clientId: "app-one",
    issuer: "https://accounts.feishu.cn",
    tenantId: "tenant-one",
    principalId: "ou_one",
    principalKind: "user",
    revision: 1,
    credentialRevision: 1,
  })
  tokenBody = { ...tokenBody, access_token: "user-two", refresh_token: "refresh-two" }
  await getConnectionManager().getCredentials(ref, { minValidityMs: 7200001 })
  const rotated = (await getAuthConnection(ref))!
  expect(rotated).toMatchObject({
    revision: initial.revision,
    lineageId: initial.lineageId,
    credentialRevision: 2,
  })
  expect((await owner().getSessions(FEISHU_PROVIDER_ID))[0].accessToken).toBe("user-two")
  tokenBody = { error: "invalid_grant" }
  await expect(
    getConnectionManager().getCredentials(ref, { minValidityMs: 7200001 })
  ).rejects.toMatchObject({ name: "AuthRefreshRejected" })
  expect(await getAuthConnection(ref)).toMatchObject({
    status: "needs-reauth",
    revision: 1,
    credentialRevision: 2,
  })
  expect(provider).not.toHaveProperty("getSessions")
  expect(oldSecrets.size).toBe(0)
  expect(JSON.stringify([...hostSecrets.values()].flatMap((values) => [...values]))).not.toContain(
    configuration.clientSecret
  )
  const exchanges = jest
    .mocked(invokePluginApi)
    .mock.calls.filter(([, op]) => op === "auth:exchange")
  expect(JSON.stringify(exchanges)).not.toContain(configuration.clientSecret)
  expect(JSON.stringify(messages.flatMap((logger) => logger.mock.calls))).not.toContain(
    configuration.clientSecret
  )
  expect(jest.mocked(invokePluginApi).mock.calls).toContainEqual([
    "feishu-auth",
    "auth:setClientSecret",
    {
      providerId: FEISHU_PROVIDER_ID,
      clientId: "app-one",
      issuer: "https://accounts.feishu.cn",
      value: configuration.clientSecret,
    },
  ])
})

it("connects a bot using client credentials and the documented tenant envelope", async () => {
  register()
  tokenBody = { code: 0, msg: "ok", tenant_access_token: "tenant-token", expire: 7200 }
  get.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      code: 0,
      msg: "ok",
      data: {
        tenant: {
          name: "Company",
          display_id: "display",
          tenant_tag: 1,
          tenant_key: "tenant-one",
          avatar: {},
        },
      },
    },
  })
  const ref = await connectProvider({
    providerId: FEISHU_PROVIDER_ID,
    scopes: [],
    configuration,
    method: "client-credentials",
  })
  expect(await getAuthConnection(ref)).toMatchObject({
    principalKind: "bot",
    principalId: "app-one",
    tenantId: "tenant-one",
    tenantLabel: "Company",
    accountLabel: "Company",
  })
  expect(openExternal).not.toHaveBeenCalled()
  await getConnectionManager().getCredentials(ref, { minValidityMs: 7200001 })
  expect(
    jest.mocked(invokePluginApi).mock.calls.filter(([, op]) => op === "auth:exchange")
  ).toHaveLength(2)
})

it("maps denied tenant discovery to a safe, translatable connect reason", async () => {
  register()
  tokenBody = { code: 0, tenant_access_token: "tenant-token", expire: 7200 }
  get.mockResolvedValue({ ok: false, status: 403, data: { code: 1184001, msg: "private" } })
  await expect(
    connectProvider({
      providerId: FEISHU_PROVIDER_ID,
      scopes: [],
      configuration,
      method: "client-credentials",
    })
  ).rejects.toMatchObject({ reason: "tenant-scope-required" })
  expect(await listAuthConnections(FEISHU_PROVIDER_ID)).toEqual([])
})

it("refuses the same identity after the real built-in Lark reconciliation without changing it", async () => {
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_adapter, name) => (name === "appId" ? "app-one" : "builtin-secret"))
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    authorizationEpoch: "epoch-one",
    accessToken: "builtin-access",
    refreshToken: "builtin-refresh",
    refreshRevision: "native-one",
    accountLabel: "Person",
    scopes,
  } as never)
  await getDb().adapterInstances.put({
    id: "adapter",
    type: "lark",
    enabled: true,
    displayName: "Work",
    settings: {
      connectedUser: { openId: "ou_one", tenantKey: "tenant-one", authorizationEpoch: "epoch-one" },
    },
  } as never)
  const builtin = (await reconcileLarkConnection("adapter"))!
  register()
  await expect(
    connectProvider({ providerId: FEISHU_PROVIDER_ID, scopes, configuration })
  ).rejects.toBeInstanceOf(ConnectionIdentityConflict)
  expect(await getAuthConnection(builtin.id)).toEqual(builtin)
  expect(await listAuthConnections(FEISHU_PROVIDER_ID)).toEqual([])
  expect(connectorsLarkUserAuth).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "disconnect" })
  )
})

it("refuses a legacy duplicate before refreshing the built-in account's lineage", async () => {
  const key = legacy()
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_adapter, name) => (name === "appId" ? "app-one" : "builtin-secret"))
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    authorizationEpoch: "epoch-one",
    accessToken: "builtin-access",
    refreshToken: "builtin-refresh",
    refreshRevision: "native-one",
    accountLabel: "Person",
    scopes,
  } as never)
  await getDb().adapterInstances.put({
    id: "adapter",
    type: "lark",
    enabled: true,
    displayName: "Work",
    settings: {
      connectedUser: { openId: "ou_one", tenantKey: "tenant-one", authorizationEpoch: "epoch-one" },
    },
  } as never)
  const builtin = (await reconcileLarkConnection("adapter"))!
  register()
  await expect(owner().getSessions(FEISHU_PROVIDER_ID)).rejects.toBeInstanceOf(
    ConnectionIdentityConflict
  )
  expect(
    jest.mocked(invokePluginApi).mock.calls.filter(([, op]) => op === "auth:exchange")
  ).toEqual([])
  expect(await getAuthConnection(builtin.id)).toEqual(builtin)
  expect(oldSecrets.has(key)).toBe(true)
})

it("migrates once at registration, moves each app secret by client, and keeps calendar session ids usable", async () => {
  const first = legacy()
  const second = legacy("legacy-two", "app-two", "second-app-secret")
  register()
  const sessions = await owner().getSessions(FEISHU_PROVIDER_ID, scopes)
  expect(sessions.map(({ id }) => id)).toEqual(expect.arrayContaining(["legacy-one", "legacy-two"]))
  const rows = await listAuthConnections(FEISHU_PROVIDER_ID)
  expect(rows).toHaveLength(2)
  expect(rows.map(({ clientId }) => clientId).sort()).toEqual(["app-one", "app-two"])
  expect(jest.mocked(invokePluginApi).mock.calls).toEqual(
    expect.arrayContaining([
      [
        "feishu-auth",
        "auth:setClientSecret",
        {
          providerId: FEISHU_PROVIDER_ID,
          clientId: "app-one",
          issuer: "https://accounts.feishu.cn",
          value: "legacy-app-secret",
        },
      ],
      [
        "feishu-auth",
        "auth:setClientSecret",
        {
          providerId: FEISHU_PROVIDER_ID,
          clientId: "app-two",
          issuer: "https://accounts.feishu.cn",
          value: "second-app-secret",
        },
      ],
    ])
  )
  expect(oldSecrets.has(first)).toBe(false)
  expect(oldSecrets.has(second)).toBe(false)
  const count = jest.mocked(invokePluginApi).mock.calls.length
  await runLegacySessionMigrations(getProvider(FEISHU_PROVIDER_ID)!)
  expect(await legacySessionAliases(getProvider(FEISHU_PROVIDER_ID)!)).toEqual(
    new Map([
      ["legacy-one", rows.find(({ clientId }) => clientId === "app-one")!.id],
      ["legacy-two", rows.find(({ clientId }) => clientId === "app-two")!.id],
    ])
  )
  expect(jest.mocked(invokePluginApi).mock.calls).toHaveLength(count)
  expect(JSON.stringify([...hostSecrets.values()].flatMap((values) => [...values]))).not.toMatch(
    /legacy-app-secret|second-app-secret/
  )
  // Calendar's current integration auth bridge resolves stored authSessionId
  // against provider.getSessions(), so the original id must remain available.
  expect(sessions.find(({ id }) => id === "legacy-one")?.accessToken).toBe("user-token")
  await getProvider(FEISHU_PROVIDER_ID)!.removeSession("legacy-one")
  expect(
    (await owner().getSessions(FEISHU_PROVIDER_ID)).some(({ id }) => id === "legacy-one")
  ).toBe(false)
  expect(
    (await listAuthConnections(FEISHU_PROVIDER_ID)).find(({ clientId }) => clientId === "app-two")
      ?.status
  ).toBe("connected")
})

it.each(["missing-refresh", "invalid-grant"])(
  "preserves %s legacy sessions as needs-reauth and deletes their old record",
  async (failure) => {
    const key = legacy()
    if (failure === "missing-refresh") {
      const record = JSON.parse(oldSecrets.get(key)!)
      delete record.refreshToken
      oldSecrets.set(key, JSON.stringify(record))
    } else tokenBody = { error: "invalid_grant" }
    register()
    expect(await owner().getSessions(FEISHU_PROVIDER_ID)).toEqual([])
    const [row] = await listAuthConnections(FEISHU_PROVIDER_ID)
    expect(row).toMatchObject({
      status: "needs-reauth",
      clientId: "app-one",
      principalId: "ou_one",
    })
    expect(oldSecrets.has(key)).toBe(false)
    await expect(getConnectionManager().getCredentials(row.id)).rejects.toThrow()
  }
)

it("reauthenticates a migrated session whose expired token could not describe its tenant", async () => {
  legacy()
  tokenBody = { error: "invalid_grant" }
  get.mockResolvedValue({ ok: false, status: 401, data: { code: 99991663 } })
  register()
  await owner().getSessions(FEISHU_PROVIDER_ID)
  const [recovery] = await listAuthConnections(FEISHU_PROVIDER_ID)
  expect(recovery).toMatchObject({ status: "needs-reauth", principalId: "ou_one" })
  expect(recovery.tenantId).toBeUndefined()
  tokenBody = {
    code: 0,
    access_token: "reconnected",
    refresh_token: "new-refresh",
    expires_in: 7200,
    scope: scopes.join(" "),
  }
  get.mockResolvedValue({
    ok: true,
    status: 200,
    data: { code: 0, data: { open_id: "ou_one", tenant_key: "tenant-one", name: "Person" } },
  })
  await expect(
    connectProvider({
      providerId: FEISHU_PROVIDER_ID,
      scopes,
      configuration,
      reconnect: recovery.id,
    })
  ).resolves.toBe(recovery.id)
  expect(await getAuthConnection(recovery.id)).toMatchObject({
    status: "connected",
    tenantId: "tenant-one",
  })
})

it("finishes retiring legacy metadata when deletion interrupted a completed migration", async () => {
  const key = legacy()
  const saved = oldSecrets.get(key)!
  register()
  await owner().getSessions(FEISHU_PROVIDER_ID)
  const [connection] = await listAuthConnections(FEISHU_PROVIDER_ID)
  const bridgeId = "old-bridge" as typeof connection.id
  await getDb().authConnections.put({
    ...connection,
    id: bridgeId,
    identityKey: "legacy-bridge-identity",
    legacySessionId: "legacy-one",
    credentialRevision: 0,
  })
  oldSecrets.set(key, saved)
  await runLegacySessionMigrations(getProvider(FEISHU_PROVIDER_ID)!)
  expect(await getAuthConnection(bridgeId)).toMatchObject({ status: "tombstoned" })
  expect(oldSecrets.has(key)).toBe(false)
})

it("does not replay a legacy refresh whose remote outcome is unknown", async () => {
  const key = legacy()
  const record = JSON.parse(oldSecrets.get(key)!)
  await accountAuthSecrets("auth-connections").compareAndSet(
    "migration:feishu-auth:host-v1",
    null,
    JSON.stringify({
      [key]: {
        phase: "exchanging",
        credentials: {
          accessToken: record.session.accessToken,
          refreshToken: record.refreshToken,
          scopes,
          expiresAt: new Date(clock + 10000).toISOString(),
          extra: {
            clientId: "app-one",
            issuer: "https://accounts.feishu.cn",
            principalKind: "user",
          },
        },
        description: {
          clientId: "app-one",
          issuer: "https://accounts.feishu.cn",
          principal: { id: "ou_one", kind: "user" },
          accountLabel: "Person",
          scopes,
        },
      },
    }),
    true
  )
  register()
  expect(await owner().getSessions(FEISHU_PROVIDER_ID)).toEqual([])
  expect(jest.mocked(invokePluginApi).mock.calls.some(([, op]) => op === "auth:exchange")).toBe(
    false
  )
  expect(await listAuthConnections(FEISHU_PROVIDER_ID)).toEqual([
    expect.objectContaining({ status: "needs-reauth" }),
  ])
  expect(oldSecrets.has(key)).toBe(false)
})

it.each(["feishu-auth", "lark"] as const)(
  "syncs the calendar through the real %s Host connection after consent, and stops on revocation without advancing its cursor",
  async (provider) => {
    const values = new Map<string, unknown>()
    let legacyAccountId: string | undefined
    jest
      .mocked(getPlugin)
      .mockImplementation(
        async (id) =>
          ({ manifest: id === "feishu-calendar" ? calendar.manifest : manifest }) as never
      )
    if (provider === "feishu-auth") {
      legacy()
      register()
      await owner().getSessions(FEISHU_PROVIDER_ID)
      const legacyAccount = await createIntegrationAccount("feishu-calendar", {
        integrationId: "feishu-calendar",
        providerId: FEISHU_PROVIDER_ID,
        authSessionId: "legacy-one",
        remoteAccountId: "app-one:ou_one",
        label: "Person",
      })
      legacyAccountId = legacyAccount.id
      values.set(`calendar-sync:${JSON.stringify([legacyAccountId, "cal"])}`, {
        version: 1,
        syncToken: "legacy-cursor",
        fingerprints: {},
      })
    } else {
      jest
        .mocked(connectorsKeyringGet)
        .mockImplementation(async (_adapter, key) =>
          key === "appId" ? "app-one" : "builtin-secret"
        )
      jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
        configured: true,
        authorizationEpoch: "epoch-one",
        accessToken: "builtin-access",
        refreshRevision: "native-one",
        scopes,
      } as never)
      await getDb().adapterInstances.put({
        id: "calendar-adapter",
        type: "lark",
        enabled: true,
        displayName: "Work",
        settings: {
          brand: "lark",
          connectedUser: {
            openId: "ou_one",
            tenantKey: "tenant-one",
            authorizationEpoch: "epoch-one",
          },
        },
      } as never)
      await reconcileLarkConnection("calendar-adapter")
    }
    registerIntegrationDefinitions({
      pluginId: "feishu-calendar",
      definitions: [calendar.feishuCalendarIntegration],
      handlers: Object.fromEntries(
        calendar.feishuCalendarIntegration.actions.map((action) => [
          `feishu-calendar:${action.id}`,
          calendar[action.handler as keyof typeof calendar] as IntegrationActionHandler,
        ])
      ),
      resourceProviders: { "feishu-calendar": calendar.listCalendarResources },
      accountStatusProviders: { "feishu-calendar": calendar.checkCalendarHealth },
    })
    registerExternalServices("feishu-calendar", calendar.manifest.services!)
    jest.mocked(proxyFetch).mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify({
            code: 0,
            data: String(url).includes("/events?")
              ? { items: [], has_more: false, sync_token: "saved-cursor" }
              : { calendar_list: [], has_more: false },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
    )
    const api = createIntegrationsAPI("feishu-calendar", () => true)
    await api.migrateLegacy({
      id: "calendar-host-test",
      integrationId: "feishu-calendar",
      accounts: [],
      subscriptions: [],
      workflowKindAliases: {},
      rebindLegacyConnections: { service: "auth.feishu" },
    })
    const auth = createAuthAPI("feishu-calendar", { hasPermission: () => true })
    const approvals: string[][] = []
    const stopPrompt = subscribeConnectionPrompts(({ current }) => {
      if (current?.kind !== "grant") return
      approvals.push(current.operations.map((operation) => operation.id))
      resolveConnectionPrompt(current.id, { kind: "approved" })
    })
    const host = {
      auth,
      integrations: api,
      storage: {
        get: async (key: string) =>
          values.has(key) ? structuredClone(values.get(key)) : undefined,
        set: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value))
        },
      },
    } as CalendarSyncHost
    try {
      expect(await requestCalendarAccess(host)).toBe(true)
      expect(approvals).toHaveLength(1)
      const [account] = await api.listAccounts("feishu-calendar")
      expect(account.connectionId).toBeDefined()
      if (legacyAccountId) expect(account.id).toBe(legacyAccountId)
      const sync = createCalendarSync(host)
      await expect(sync.syncCalendar(account.id, "cal")).resolves.toMatchObject({ pages: 1 })
      const checkpoint = [...values.values()][0]
      expect(checkpoint).toMatchObject({ syncToken: "saved-cursor" })
      const call = jest.mocked(proxyFetch).mock.calls[0]!
      if (legacyAccountId)
        expect(new URL(String(call[0])).searchParams.get("sync_token")).toBe("legacy-cursor")
      expect(new URL(String(call[0])).origin).toBe(
        provider === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn"
      )
      expect(new Headers(call[1]?.headers).get("authorization")).toBe(
        provider === "lark" ? "Bearer builtin-access" : "Bearer user-token"
      )
      const count = jest.mocked(proxyFetch).mock.calls.length
      jest.mocked(proxyFetch).mockImplementationOnce(async () => {
        await revokeConsumerAccess(
          account.connectionId as import("@cognia/plugin-contract/types/plugin/plugin-auth").AuthConnectionRef,
          "feishu-calendar"
        )
        return new Response(
          JSON.stringify({
            code: 0,
            data: { items: [], has_more: false, sync_token: "must-not-commit" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      })
      await expect(sync.syncCalendar(account.id, "cal")).rejects.toMatchObject({
        name: "ConsumerGrantRequired",
      })
      expect((await api.listAccounts("feishu-calendar"))[0].status?.code).toBe(
        "consumer-grant-required"
      )
      expect([...values.values()][0]).toMatchObject({ syncToken: "saved-cursor" })
      await expect(sync.syncCalendar(account.id, "cal")).rejects.toThrow()
      expect([...values.values()][0]).toMatchObject({ syncToken: "saved-cursor" })
      expect(jest.mocked(proxyFetch)).toHaveBeenCalledTimes(count + 1)
      expect(approvals).toHaveLength(1)
    } finally {
      stopPrompt()
      unregisterExternalServicesByPlugin("feishu-calendar")
    }
  }
)
