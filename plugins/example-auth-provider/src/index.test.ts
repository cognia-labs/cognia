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
import { getAuthConnection } from "@/lib/db/auth-connections"
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
import { connectProvider } from "@/lib/plugin/auth/connect"
import { acceptCallback } from "@/lib/plugin/auth/callback-acceptor"
import {
  subscribeConnectionPrompts,
  resolveConnectionPrompt,
  type ConnectionPrompt,
} from "@/lib/plugin/auth/connection-prompts"
import { withNamedLock } from "@/lib/locks/named-lock"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { PluginServiceRegistry } from "@/lib/plugin/core/service-registry"
import { CompanionTransport } from "@/lib/tauri/transport-companion"
import { setTransport, transport } from "@/lib/tauri/transport-instance"
import { setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import definition, { manifest, createProvider } from "./index"
const authDefinition = definition
const authManifest = manifest

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
const grantAnswer = "approved" as const
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

async function signIn() {
  return connectProvider({ providerId: "example-tracker", scopes: SCOPES })
}

it("ships the complete manifest and uses no legacy session callbacks", () => {
  expect(definition.manifest).toEqual(manifest)
  expect(authManifest.providesServices).toEqual({ "auth.example-tracker": "1.0.0" })
  const provider = createProvider(ctx)
  expect(provider.management).toBe("host")
  expect(provider).not.toHaveProperty("getSessions")
  expect(provider).not.toHaveProperty("createSession")
  expect(provider).not.toHaveProperty("removeSession")
})

it("signs in with Host-bound PKCE, stores a connection, and refuses callback replay", async () => {
  const ref = await signIn()
  expect(await getAuthConnection(ref)).toMatchObject({
    ownerPluginId: manifest.id,
    status: "connected",
    revision: 1,
    issuer: "https://api.example-tracker.test",
    principalKind: "user",
    principalId: "example-user",
  })
  expect(await getConnectionManager().getCredentials(ref)).toMatchObject({
    accessToken: "host-only-token",
  })
  expect(await getDb().authConnections.count()).toBe(1)
  expect(JSON.stringify(await getDb().plugins.toArray())).not.toContain("host-only-token")
  expect(JSON.stringify(await getDb().authConnections.toArray())).not.toContain("host-only-refresh")
  await acceptCallback(
    { state: authorized!.searchParams.get("state")!, code: "replayed-code" },
    "broadcast"
  )
  expect(exchanges).toHaveLength(1)
  expect(await getDb().authConnections.count()).toBe(1)
})

it("refreshes once through auth:exchange under the Host lock and stores rotated credentials", async () => {
  expiresIn = 120
  const ref = await signIn()
  expiresIn = 3600
  const credentials = await Promise.all([
    getConnectionManager().getCredentials(ref, { minValidityMs: 180_000 }),
    getConnectionManager().getCredentials(ref, { minValidityMs: 180_000 }),
  ])
  expect(credentials.map((value) => value.accessToken)).toEqual([
    "rotated-host-token",
    "rotated-host-token",
  ])
  expect(
    exchanges.filter((entry) => entry.payload.params.grant_type === "refresh_token")
  ).toHaveLength(1)
  expect(exchanges[1].payload.params.refresh_token).toBe("host-only-refresh")
  expect(await getConnectionManager().getCredentials(ref)).toMatchObject({
    refreshToken: "rotated-refresh-token",
  })
  expect(await getAuthConnection(ref)).toMatchObject({ revision: 1, credentialRevision: 2 })
})

it("marks a permanently rejected refresh as needs-reauth", async () => {
  expiresIn = 120
  const ref = await signIn()
  tokenError = "invalid_grant"
  await expect(
    getConnectionManager().getCredentials(ref, { minValidityMs: 180_000 })
  ).rejects.toThrow()
  expect(await getAuthConnection(ref)).toMatchObject({ status: "needs-reauth" })
})
