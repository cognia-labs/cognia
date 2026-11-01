/**
 * @jest-environment jsdom
 * @cognia-host-integration-test
 */
// Host integration harness: real APIs, registries, Dexie and credential CAS.
// Only the fictional service/OAuth popup and the trusted gateway HTTP peer are simulated.
import type {
  PluginContext,
  PluginHooks,
  PluginManifest,
  NetworkRequestOptions,
} from "@cognia/plugin-sdk"
import { createRecreatedDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { upsertPlugin } from "@/lib/db/plugins"
import { createAuthAPI } from "@/lib/plugin/api/auth-api"
import { createIntegrationsAPI } from "@/lib/plugin/api/integrations-api"
import {
  createDocsProvidersAPI,
  clearDocsProvidersForPlugin,
} from "@/lib/plugin/api/docs-providers-api"
import { createIssuesAPI, clearIssueSyncProvidersForPlugin } from "@/lib/plugin/api/issues-api"
import { createBackupAPI, clearBackupDestinationsForPlugin } from "@/lib/plugin/api/backup-api"
import { createI18nAPI } from "@/lib/plugin/api/i18n-api"
import {
  registerIntegrationDefinitions,
  __resetIntegrationRegistryForTesting,
} from "@/lib/integrations/registry"
import {
  registerExternalServices,
  unregisterExternalServicesByPlugin,
} from "@/lib/external-services/catalog"
import { __resetAuthRegistryForTesting } from "@/lib/plugin/auth/auth-provider-registry"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
import { setHostAuthBackend } from "@/lib/plugin/auth/connection-credentials"
import { acceptCallback } from "@/lib/plugin/auth/callback-acceptor"
import {
  subscribeConnectionPrompts,
  resolveConnectionPrompt,
  type ConnectionPrompt,
} from "@/lib/plugin/auth/connection-prompts"
import { revokeConsumerAccess } from "@/lib/plugin/auth/revoke-consumer-access"
import { withNamedLock } from "@/lib/locks/named-lock"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { PluginServiceRegistry } from "@/lib/plugin/core/service-registry"
import { CompanionTransport } from "@/lib/tauri/transport-companion"
import { setTransport, transport } from "@/lib/tauri/transport-instance"
import { setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import definition, { manifest, requestAccess } from "./index"
import authDefinition, { manifest as authManifest } from "../../example-auth-provider/src/index"
import { getIssueSyncRegistry } from "@/lib/issues/sync/registry"
import { resolvePluginSyncBindings, pluginResourceState } from "@/lib/issues/sync/plugin-resources"
import { reconcileBinding } from "@/lib/issues/sync/engine"
import { createIssueProject } from "@/lib/db/issue-projects"
import { getIssueByExternalKey } from "@/lib/db/issues"
import type { IssueSyncBinding } from "@cognia/plugin-sdk/api/issues"

const fixture = createRecreatedDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const SCOPES = ["docs.read", "issues.read", "backups.read", "backups.write"]
const originalTransport = transport
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
let ctx: PluginContext
let ownerHooks: PluginHooks | void
let hooks: PluginHooks | void
let requests: Array<{ url: string; init?: RequestInit }>
let exchanges: Array<{
  api: string
  pluginId: string
  payload: { params: Record<string, string>; tokenUrl: string; placement: string }
}>
let prompts: ConnectionPrompt[]
let stopPrompts: () => void
let grantAnswer: "approved" | "denied"
let expiresIn: number
let tokenError: string | undefined
let serviceReply: (url: URL, init?: RequestInit) => Response | Promise<Response>
let services: PluginServiceRegistry
let authorized: URL | undefined

// Observe the real reconciliation promise before the fixture closes its database.
async function providerTransition<T>(
  method: "restoreProvider" | "markProviderUnavailable",
  action: () => T | Promise<T>
): Promise<T> {
  const manager = getConnectionManager()
  const original = manager[method].bind(manager)
  let complete!: () => void
  let fail!: (error: unknown) => void
  const settled = new Promise<void>((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  const observer = jest.spyOn(manager, method).mockImplementation(async (id) => {
    try {
      await original(id)
      complete()
    } catch (error) {
      fail(error)
      throw error
    }
  })
  try {
    const result = await action()
    await settled
    return result
  } finally {
    observer.mockRestore()
  }
}

beforeEach(async () => {
  localStorage.clear()
  resetPermissionGuard()
  __resetAuthRegistryForTesting()
  __resetIntegrationRegistryForTesting()
  requests = []
  exchanges = []
  prompts = []
  expiresIn = 3600
  tokenError = undefined
  grantAnswer = "approved"
  authorized = undefined
  const stores = new Map<string, Map<string, string>>()
  setHostAuthBackend({
    lock: (name, task) => withNamedLock(name, task, { mode: "in-process" }),
    storeFor(namespace) {
      const values = stores.get(namespace) ?? new Map<string, string>()
      stores.set(namespace, values)
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
  serviceReply = () => {
    throw new Error("Unexpected service request")
  }
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    requests.push({ url: url.href, init })
    if (url.origin === "https://host.example-tracker.test") {
      expect(url.pathname).toBe("/api/_rpc/plugin_api_invoke")
      const { request } = JSON.parse(String(init?.body))
      exchanges.push(request)
      expect(request.api).toBe("auth:exchange")
      expect(request.pluginId).toBe(authManifest.id)
      expect(request.payload).toMatchObject({
        tokenUrl: "https://api.example-tracker.test/oauth/token",
        clientId: "cognia-example-public-client",
        placement: "none",
      })
      expect(request.payload.params).not.toHaveProperty("client_secret")
      const refresh = request.payload.params.grant_type === "refresh_token"
      if (!refresh) {
        const hash = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(request.payload.params.code_verifier)
        )
        const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "")
        expect(challenge).toBe(authorized?.searchParams.get("code_challenge"))
        expect(request.payload.params.redirect_uri).toBe(
          authorized?.searchParams.get("redirect_uri")
        )
      }
      return json({
        result: {
          requestId: request.requestId,
          success: true,
          data: {
            status: tokenError ? 400 : 200,
            body: tokenError
              ? { error: tokenError }
              : {
                  access_token: refresh ? "rotated-host-token" : "host-only-token",
                  refresh_token: refresh ? "rotated-refresh-token" : "host-only-refresh",
                  token_type: "Bearer",
                  expires_in: expiresIn,
                  scope: SCOPES.join(" "),
                },
          },
        },
      })
    }
    if (url.pathname === "/me") {
      expect(new Headers(init?.headers).get("authorization")).toMatch(
        /^Bearer (host-only-token|rotated-host-token)$/
      )
      return json({ id: "example-user", name: "Example Author" })
    }
    return serviceReply(url, init)
  })
  // The peer is a network fixture. Auth API, transport envelopes and callback acceptance stay real.
  const gateway = new CompanionTransport({
    configProvider: () => ({
      baseUrl: "https://host.example-tracker.test",
      deviceId: "example-peer",
      serverVersion: "0.1.0",
      serviceToken: "test-host-peer",
    }),
  })
  setTransport(gateway)
  setActiveRemoteTransport(gateway)
  jest.spyOn(window, "open").mockImplementation((input) => {
    authorized = new URL(String(input))
    expect(authorized.origin).toBe("https://api.example-tracker.test")
    expect(authorized.searchParams.get("code_challenge_method")).toBe("S256")
    void acceptCallback(
      { state: authorized.searchParams.get("state")!, code: "accepted-code" },
      "broadcast"
    )
    return null
  })
  stopPrompts = subscribeConnectionPrompts(({ current }) => {
    if (!current) return
    prompts.push(current)
    resolveConnectionPrompt(
      current.id,
      current.kind === "sign-in" ? { kind: "sign-in" } : { kind: grantAnswer }
    )
  })
  for (const item of new Map([authManifest, manifest].map((value) => [value.id, value])).values()) {
    await upsertPlugin({
      id: item.id,
      name: item.name,
      version: item.version,
      type: item.type,
      source: "local",
      path: `/fixture/${item.id}`,
      manifest: item as unknown as Record<string, unknown>,
      enabled: true,
    })
    getPermissionGuard().registerPlugin(item.id, item.permissions ?? [])
  }
  services = new PluginServiceRegistry()
  services.beginProvider(authManifest.id, 1, authManifest.providesServices)
  services.publishProvider(authManifest.id, 1)
  const permission = (item: PluginManifest) => (id: string) =>
    getPermissionGuard().check(item.id, id as never)
  const auth = createAuthAPI(authManifest.id, { hasPermission: permission(authManifest) }, "deny")
  const network = {
    fetch: async <T>(url: string, options?: NetworkRequestOptions) => {
      const response = await fetch(url, {
        headers: options?.headers as Record<string, string>,
        signal: options?.signal,
      })
      return {
        data: (await response.json()) as T,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: {},
      }
    },
  }
  ownerHooks = await providerTransition("restoreProvider", () =>
    authDefinition.activate!({ auth, network } as PluginContext)
  )
  registerIntegrationDefinitions({
    pluginId: manifest.id,
    definitions: manifest.integrations ?? [],
    handlers: {},
  })
  registerExternalServices(manifest.id, manifest.services ?? [])
  ctx = {
    auth: createAuthAPI(manifest.id, { hasPermission: permission(manifest) }, "deny"),
    integrations: createIntegrationsAPI(manifest.id, permission(manifest)),
    docsProviders: createDocsProvidersAPI(manifest.id, manifest),
    issues: createIssuesAPI(manifest.id, manifest),
    backup: createBackupAPI(manifest.id, manifest),
    i18n: createI18nAPI(manifest.id),
    network,
  } as PluginContext
  hooks = manifest.id === authManifest.id ? ownerHooks : await definition.activate!(ctx)
})

afterEach(async () => {
  if (hooks !== ownerHooks) await hooks?.onDisable?.()
  await providerTransition("markProviderUnavailable", () => ownerHooks?.onDisable?.())
  clearDocsProvidersForPlugin(manifest.id)
  clearIssueSyncProvidersForPlugin(manifest.id)
  clearBackupDestinationsForPlugin(manifest.id)
  unregisterExternalServicesByPlugin(manifest.id)
  __resetIntegrationRegistryForTesting()
  __resetAuthRegistryForTesting()
  stopPrompts?.()
  setActiveRemoteTransport(null)
  setTransport(originalTransport)
  setHostAuthBackend(null)
  jest.restoreAllMocks()
})

it("ships the complete manifest and uses no legacy session callbacks", () => {
  expect(definition.manifest).toEqual(manifest)
  expect(authManifest.providesServices).toEqual({ "auth.example-tracker": "1.0.0" })
})

const providerId = "plugin:cognia-example-issue-sync/issues"
async function binding(version = 2): Promise<IssueSyncBinding> {
  const project = await createIssueProject({
    projectId: "example-workspace",
    key: "EX",
    name: "Example",
    resources: [
      {
        kind: "plugin",
        providerId,
        schemaVersion: version,
        config: {
          projectKey: "DEMO",
          ...(version === 2 ? { mapping: { open: "in_progress", closed: "done" } } : {}),
        },
      },
    ],
  })
  return resolvePluginSyncBindings([project])[0]
}
const remote = {
  items: [
    {
      id: "42",
      title: "Public plugin issue",
      description: "Pulled",
      state: "open",
      updatedAt: 1793491200000,
    },
  ],
}

it("pulls a mapped issue through the registered provider into the Host issue database", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const target = await binding()
  serviceReply = (url, init) => {
    expect(url.pathname).toBe("/projects/DEMO/issues")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer host-only-token")
    return json(remote)
  }
  expect(await reconcileBinding(target, getIssueSyncRegistry().get(providerId)!)).toMatchObject({
    created: 1,
  })
  expect(await getIssueByExternalKey(providerId, "DEMO:42")).toMatchObject({
    title: "Public plugin issue",
    status: "in_progress",
    issueProjectId: target.issueProjectId,
  })
  expect(prompts.map((prompt) => prompt.kind)).toEqual(["sign-in", "grant"])
})

it("migrates a v1 resource on the Host working copy while preserving identity and stored data", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const target = await binding(1)
  expect(target.resource).toMatchObject({
    schemaVersion: 2,
    config: { projectKey: "DEMO", mapping: { open: "todo", closed: "done" } },
  })
  const stored = (await getDb().issueProjects.toArray())[0].resources[0]
  expect(stored).toMatchObject({ schemaVersion: 1, config: { projectKey: "DEMO" } })
  expect(stored).not.toHaveProperty("config.mapping")
  if (stored.kind !== "plugin") throw new Error("Expected plugin resource")
  expect(pluginResourceState(stored).key).toBe(target.key)
  serviceReply = () => json(remote)
  expect(await reconcileBinding(target, getIssueSyncRegistry().get(providerId)!)).toMatchObject({
    created: 1,
  })
  expect(await getIssueByExternalKey(providerId, "DEMO:42")).toMatchObject({ status: "todo" })
})

it("refuses revoked consumer reads before sending or importing anything", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const target = await binding()
  const [connection] = await ctx.auth.connections.list()
  await revokeConsumerAccess(connection.ref, manifest.id)
  const before = requests.length
  await expect(
    reconcileBinding(target, getIssueSyncRegistry().get(providerId)!)
  ).rejects.toMatchObject({ name: "ConsumerGrantRequired" })
  expect(requests).toHaveLength(before)
  expect(await getDb().issues.count()).toBe(0)
})

it("waits when the auth provider is disabled and keeps the saved resource", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const target = await binding()
  await providerTransition("markProviderUnavailable", () => ownerHooks?.onDisable?.())
  services.removeProvider(authManifest.id)
  expect(services.evaluate(manifest.requiresServices).required).toMatchObject([{ kind: "missing" }])
  const before = requests.length
  await expect(reconcileBinding(target, getIssueSyncRegistry().get(providerId)!)).rejects.toThrow(
    "connection unavailable"
  )
  expect(requests).toHaveLength(before)
  expect(await getDb().issueProjects.count()).toBe(1)
})

it.each([{ items: [{ ...remote.items[0], state: "unknown" }] }, { ...remote, nextCursor: "more" }])(
  "does not import malformed or incomplete remote pages: %j",
  async (page) => {
    expect(await requestAccess(ctx)).toBe(true)
    const target = await binding()
    serviceReply = () => json(page)
    await expect(
      reconcileBinding(target, getIssueSyncRegistry().get(providerId)!)
    ).rejects.toThrow()
    expect(await getDb().issues.count()).toBe(0)
  }
)
