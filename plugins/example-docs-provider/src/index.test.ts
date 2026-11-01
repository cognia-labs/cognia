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
import { upsertPlugin } from "@/lib/db/plugins"
import { getAuthConnection } from "@/lib/db/auth-connections"
import { listServiceConnections } from "@/lib/db/external-services"
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
import { revokeConsumerAccess } from "@/lib/plugin/auth/revoke-consumer-access"
import { withNamedLock } from "@/lib/locks/named-lock"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { PluginServiceRegistry } from "@/lib/plugin/core/service-registry"
import { CompanionTransport } from "@/lib/tauri/transport-companion"
import { setTransport, transport } from "@/lib/tauri/transport-instance"
import { setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import definition, { manifest, requestAccess } from "./index"
import authDefinition, { manifest as authManifest } from "../../example-auth-provider/src/index"
import { getDocsProvider } from "@/lib/docs-providers/registry"
import { classifyCloudDocumentUrl } from "@/lib/docs-providers/document-url"
import issueDefinition, { manifest as issueManifest } from "../../example-issue-sync/src/index"
import backupDefinition, {
  manifest as backupManifest,
} from "../../example-backup-destination/src/index"
import { PluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import { usePluginStore } from "@/stores/plugin-runtime"
import {
  registerSlashCommand,
  unregisterCommandsByPlugin,
  dispatchSlashCommand,
} from "@/lib/slash-commands/registry"

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
let identityId: string

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
  identityId = "example-user"
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
      return json({ id: identityId, name: "Example Author" })
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
})

const providerId = "plugin:cognia-example-docs-provider/docs"
const documentUrl = "https://docs.example-tracker.test/documents/welcome"
async function readDocument() {
  const provider = getDocsProvider(providerId)!
  const [account] = await provider.listAccounts()
  if (!account) throw new Error("Waiting for Example Tracker provider")
  return provider.fetch(
    { ...provider.matchRef(documentUrl)!, providerId, title: "welcome" },
    {
      accountId: account.id,
      expectedAuthorizationEpoch: account.authorizationEpoch,
    }
  )
}

it("answers sign-in and consumer grant prompts, recognizes a URL, and fetches through injected credentials", async () => {
  serviceReply = (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer host-only-token")
    return json({ title: "Welcome", text: "# Third-party document" })
  }
  expect(await requestAccess(ctx)).toBe(true)
  expect(prompts.map((prompt) => prompt.kind)).toEqual(["sign-in", "grant"])
  expect(prompts.at(-1)).toMatchObject({ operations: [{ id: "docs.request.GET", risk: "read" }] })
  expect(classifyCloudDocumentUrl(documentUrl)?.providerId).toBe(providerId)
  expect(getDocsProvider(providerId)?.matchRef("https://wrong.test/documents/welcome")).toBeNull()
  expect(await readDocument()).toMatchObject({
    title: "Welcome",
    text: "# Third-party document",
    format: "markdown",
  })
  const [metadata] = await ctx.auth.connections.list()
  expect(metadata).not.toHaveProperty("accessToken")
  expect(metadata).not.toHaveProperty("refreshToken")
  await expect(ctx.auth.getSessions("example-tracker")).rejects.toMatchObject({
    name: "ConsumerTokenReadDenied",
  })
  expect(await listServiceConnections({ pluginId: manifest.id })).toHaveLength(1)
})

it("does not send a read after the user denies the grant", async () => {
  grantAnswer = "denied"
  expect(await requestAccess(ctx)).toBe(false)
  const before = requests.length
  await expect(readDocument()).rejects.toThrow()
  expect(requests).toHaveLength(before)
})

it("offers only the Host-bound account when a second principal connects", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const [bound] = await ctx.auth.connections.list()
  identityId = "second-user"
  const second = await signIn()
  expect(second).not.toBe(bound.ref)
  expect(await ctx.auth.connections.list()).toHaveLength(2)
  expect(await getDocsProvider(providerId)!.listAccounts()).toMatchObject([{ id: bound.ref }])
  serviceReply = () => json({ title: "Bound account", text: "Still authorized" })
  expect(await readDocument()).toMatchObject({ text: "Still authorized" })
})

it("dispatches each consumer's connect command to its own grant with all three installed", async () => {
  const lifecycle = new PluginLifecycleHooks()
  const previousPlugins = usePluginStore.getState().plugins
  const additionalHooks: PluginHooks[] = []
  const consumers = [
    { definition, manifest, ctx, operations: ["docs.request.GET"] },
    { definition: issueDefinition, manifest: issueManifest, operations: ["issues.request.GET"] },
    {
      definition: backupDefinition,
      manifest: backupManifest,
      operations: ["backups.request.GET", "backups.request.PUT"],
    },
  ]
  try {
    for (const [index, consumer] of consumers.entries()) {
      const item = consumer.manifest
      registerPluginI18n({
        pluginId: item.id,
        messages: Object.fromEntries(
          Object.entries(item.i18n!.locales).map(([locale, messages]) => [
            locale,
            Object.fromEntries(
              Object.entries(messages!).map(([key, value]) => [`plugin.${item.id}.${key}`, value])
            ),
          ])
        ),
      })
      const permission = (id: string) => getPermissionGuard().check(item.id, id as never)
      let registered = hooks
      if (!consumer.ctx) {
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
        registerIntegrationDefinitions({
          pluginId: item.id,
          definitions: item.integrations ?? [],
          handlers: {},
        })
        registerExternalServices(item.id, item.services ?? [])
        registered = await consumer.definition.activate!({
          ...ctx,
          auth: createAuthAPI(item.id, { hasPermission: permission }, "deny"),
          integrations: createIntegrationsAPI(item.id, permission),
          issues: createIssuesAPI(item.id, item),
          backup: createBackupAPI(item.id, item),
          i18n: createI18nAPI(item.id),
        })
        if (registered) additionalHooks.push(registered)
      }
      if (!registered) throw new Error("Consumer did not register hooks")
      usePluginStore.setState((state) => ({
        plugins: {
          ...state.plugins,
          [item.id]: {
            manifest: item,
            status: "enabled",
            source: "local",
            path: `/fixture/${item.id}`,
            config: {},
          },
        },
      }))
      lifecycle.registerHooks(item.id, registered, 100 - index)
      const command = item.commands![0]
      registerSlashCommand({
        id: `${item.id}.${command.id}`,
        name: command.name,
        pluginId: item.id,
        source: "plugin",
        // Match the manager's forwarding of the manifest-local command ID.
        handler: async () =>
          (await lifecycle.dispatchOnCommand(command.id, [])) ?? { message: "Unhandled" },
      })
    }
    for (const consumer of [...consumers].reverse()) {
      const item = consumer.manifest
      await expect(
        dispatchSlashCommand(`/${item.id}.${item.commands![0].id}`)
      ).resolves.toMatchObject({ message: "Connection access granted." })
      expect(prompts.at(-1)).toMatchObject({
        kind: "grant",
        pluginId: item.id,
        operations: consumer.operations.map((id) => ({ id })),
      })
    }
    expect(prompts.filter((prompt) => prompt.kind === "grant")).toHaveLength(3)
  } finally {
    for (const hook of additionalHooks) await hook.onDisable?.()
    for (const { manifest: item } of consumers) {
      lifecycle.unregisterHooks(item.id)
      unregisterCommandsByPlugin(item.id)
      unregisterPluginI18n(item.id)
      clearIssueSyncProvidersForPlugin(item.id)
      clearBackupDestinationsForPlugin(item.id)
      if (item.id !== manifest.id) unregisterExternalServicesByPlugin(item.id)
    }
    usePluginStore.setState({ plugins: previousPlugins })
  }
})

it("enforces revocation at credential injection without prompting again", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const [connection] = await ctx.auth.connections.list()
  await revokeConsumerAccess(connection.ref, manifest.id)
  const before = requests.length
  await expect(readDocument()).rejects.toMatchObject({ name: "ConsumerGrantRequired" })
  expect(requests).toHaveLength(before)
  expect(prompts).toHaveLength(2)
  expect(await getAuthConnection(connection.ref)).toMatchObject({ status: "connected" })
})

it("waits for a disabled provider and resumes when the same provider returns", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  await providerTransition("markProviderUnavailable", () => ownerHooks?.onDisable?.())
  services.removeProvider(authManifest.id)
  expect(services.evaluate(manifest.requiresServices).required).toMatchObject([
    { serviceId: "auth.example-tracker", kind: "missing" },
  ])
  expect(await getDocsProvider(providerId)!.listAccounts()).toEqual([])
  expect(await ctx.auth.connections.get({ service: "auth.example-tracker" })).toBeUndefined()
  expect(await ctx.auth.connections.list()).toMatchObject([{ status: "provider-unavailable" }])
  const before = requests.length
  await expect(readDocument()).rejects.toThrow("Waiting")
  expect(requests).toHaveLength(before)
  ownerHooks = await providerTransition("restoreProvider", () =>
    authDefinition.activate!({
      auth: createAuthAPI(authManifest.id, {
        hasPermission: (id) => (authManifest.permissions ?? []).includes(id as never),
      }),
      network: ctx.network,
    } as PluginContext)
  )
  services.beginProvider(authManifest.id, 2, authManifest.providesServices)
  services.publishProvider(authManifest.id, 2)
  expect(services.evaluate(manifest.requiresServices).required).toEqual([])
  serviceReply = () => json({ title: "Back", text: "Restored" })
  expect(await readDocument()).toMatchObject({ text: "Restored" })
})

it("drops a document result if its grant is revoked while the network is in flight", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const [connection] = await ctx.auth.connections.list()
  serviceReply = async () => {
    await revokeConsumerAccess(connection.ref, manifest.id)
    return json({ title: "Late", text: "Must not escape" })
  }
  await expect(readDocument()).rejects.toMatchObject({ name: "ConsumerGrantRequired" })
})
