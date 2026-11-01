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
import { dispatchBackupDestination } from "@/lib/data/destinations"
import {
  getBackupDestination,
  withBackupDestination,
  readBackupDestinationBody,
} from "@/lib/data/destinations/registry"
import { listBackupDestinationSnapshots } from "@/lib/data/destinations/restore"
import { encryptBackupPackage, decryptBackupPackage } from "@/lib/data/crypto"
import type { BackupDestinationMeta } from "@cognia/plugin-sdk"

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

const destinationId = "plugin:cognia-example-backup-destination/archive"
const meta: BackupDestinationMeta = {
  snapshotId: "snapshot",
  createdAt: "2026-11-01T00:00:00.000Z",
  bytes: 4,
  contentType: "application/octet-stream",
  encryption: "passphrase",
}

it("round-trips Host-encrypted ciphertext through upload, list and download without learning a token or passphrase", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const passphrase = "test-only-host-passphrase"
  const envelope = await encryptBackupPackage("USER_PRIVATE_BACKUP", passphrase, {
    version: "3.0",
    schemaVersion: 3,
    exportedAt: meta.createdAt,
    traceId: "example",
    appVersion: "0.1.0",
    backend: "web-dexie",
  })
  const ciphertext = JSON.stringify(envelope)
  let stored: { ciphertext: string; meta: BackupDestinationMeta } | undefined
  serviceReply = (url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer host-only-token")
    if (init?.method === "PUT") {
      stored = JSON.parse(String(init.body))
      expect(JSON.stringify(stored)).not.toContain("USER_PRIVATE_BACKUP")
      expect(JSON.stringify(stored)).not.toContain(passphrase)
      return json({ remoteId: "snapshot", bytes: stored!.meta.bytes })
    }
    if (url.pathname === "/backups")
      return json([
        {
          remoteId: "snapshot",
          label: "snapshot",
          bytes: stored!.meta.bytes,
          createdAt: meta.createdAt,
        },
      ])
    return json({ ciphertext: stored!.ciphertext })
  }
  const result = await dispatchBackupDestination(destinationId, ciphertext, {
    filename: "snapshot",
    exportedAt: meta.createdAt,
    sizeBytes: ciphertext.length,
  })
  expect(result).toMatchObject({ ok: true, result: { remoteId: "snapshot" } })
  expect(await listBackupDestinationSnapshots(destinationId)).toMatchObject([
    { remoteId: "snapshot" },
  ])
  const downloaded = await withBackupDestination(destinationId, undefined, async (entry, signal) =>
    readBackupDestinationBody(await entry.download!("snapshot", signal), signal)
  )
  expect(new TextDecoder().decode(downloaded)).toBe(ciphertext)
  expect(
    await decryptBackupPackage(JSON.parse(new TextDecoder().decode(downloaded)), passphrase)
  ).toBe("USER_PRIVATE_BACKUP")
  expect(prompts.at(-1)).toMatchObject({
    operations: [
      { id: "backups.request.GET", risk: "read" },
      { id: "backups.request.PUT", risk: "write" },
    ],
  })
})

it("preserves arbitrary ciphertext bytes and accepts stream chunks", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  serviceReply = (_url, init) => {
    const payload = JSON.parse(String(init?.body))
    expect([...Uint8Array.from(atob(payload.ciphertext), (value) => value.charCodeAt(0))]).toEqual([
      0, 128, 255, 42,
    ])
    return json({ remoteId: "snapshot", bytes: 4 })
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 128]))
      controller.enqueue(new Uint8Array([255, 42]))
      controller.close()
    },
  })
  expect(
    await withBackupDestination(destinationId, undefined, (entry, signal) =>
      entry.upload({ body: stream, meta }, signal)
    )
  ).toMatchObject({ bytes: 4 })
})

it("rejects plaintext at Host dispatch before calling the destination", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const before = requests.length
  expect(
    await dispatchBackupDestination(destinationId, '{"plaintext":true}', {
      filename: "snapshot",
      exportedAt: meta.createdAt,
      sizeBytes: 18,
    })
  ).toMatchObject({ ok: false, error: "Remote backup requires ciphertext" })
  expect(requests).toHaveLength(before)
})

it("blocks both backup reads and uploads after its consumer grant is revoked", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const [connection] = await ctx.auth.connections.list()
  await revokeConsumerAccess(connection.ref, manifest.id)
  const before = requests.length
  await expect(listBackupDestinationSnapshots(destinationId)).rejects.toMatchObject({
    name: "ConsumerGrantRequired",
  })
  await expect(
    withBackupDestination(destinationId, undefined, (entry, signal) =>
      entry.upload({ body: new Uint8Array([0, 128, 255, 42]), meta }, signal)
    )
  ).rejects.toMatchObject({ name: "ConsumerGrantRequired" })
  expect(requests).toHaveLength(before)
  expect(prompts).toHaveLength(2)
})

it("reports needs-auth while its provider is disabled and retains a waiting service requirement", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  await providerTransition("markProviderUnavailable", () => ownerHooks?.onDisable?.())
  services.removeProvider(authManifest.id)
  expect(services.evaluate(manifest.requiresServices).required).toMatchObject([{ kind: "missing" }])
  expect(
    await getBackupDestination(destinationId)!.readiness(new AbortController().signal)
  ).toMatchObject({ state: "needs-auth" })
})

it("cancels a blocked ciphertext stream and sends no upload", async () => {
  expect(await requestAccess(ctx)).toBe(true)
  const cancel = jest.fn()
  const body = new ReadableStream<Uint8Array>({ cancel })
  const controller = new AbortController()
  const before = requests.length
  const pending = getBackupDestination(destinationId)!.upload({ body, meta }, controller.signal)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(requests).toHaveLength(before)
})
