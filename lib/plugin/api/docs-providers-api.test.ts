import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { HOST_BACKGROUND, pluginExecutionContext } from "../core/invocation-identity"
import { createDocsProvidersAPI, clearDocsProvidersForPlugin } from "./docs-providers-api"
import {
  __clearDocsProvidersForTests,
  getDocsProvider,
  listDocsProviders,
} from "@/lib/docs-providers/registry"
import { classifyCloudDocumentUrl } from "@/lib/docs-providers/document-url"
import { remoteDocumentProvenance } from "@/lib/docs-providers/document-provenance"
import type {
  PluginDocsProvider,
  PluginDocsProviderDef,
} from "@cognia/plugin-contract/types/plugin/plugin-docs-providers"
import type { PluginManifest } from "@cognia/plugin-contract/types/plugin/plugin"
import type { AuthConnectionMetadata } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { IntegrationRequestInit } from "@cognia/plugin-contract/types/plugin/plugin-integration"

jest.mock("@/lib/plugin/auth/connections-api", () => ({ createAuthConnectionsAPI: jest.fn() }))

const def: PluginDocsProviderDef = {
  id: "docs",
  label: "Acme Docs",
  mentionPrefix: "acme.docs:",
  kinds: ["doc"],
  urlOrigins: ["https://docs.example.test"],
}
const manifest = {
  id: "acme",
  docsProviders: [def],
  permissions: ["docs:provide", "auth:consume"],
} as PluginManifest
const connection = {
  ref: "host-connection",
  status: "connected",
  revision: 4,
  accountLabel: "Alice",
} as AuthConnectionMetadata
const ref = {
  providerId: "plugin:acme/docs",
  kind: "doc" as const,
  id: "report",
  title: "Report",
  url: "https://docs.example.test/report",
}

function setup(definitions: PluginDocsProviderDef[] = [def]) {
  let allowed = true
  const listeners = new Set<() => void>()
  const permissionListeners = new Set<() => void>()
  const list = jest.fn(async () => [connection])
  const authenticatedRequest = jest.fn(
    async (_account: string, _url: string, _init?: IntegrationRequestInit) => ({
      body: "from the Host transport",
    })
  )
  const ctx = { integrations: { authenticatedRequest } }
  const input: PluginDocsProvider = {
    id: def.id,
    mentionPrefix: def.mentionPrefix,
    kinds: def.kinds,
    listAccounts: async () => [
      { id: connection.ref, label: "claimed label", authorizationEpoch: "4" },
    ],
    matchRef: (url) => ({ kind: "doc", id: "report", url }),
    async fetch(target, options) {
      const response = await ctx.integrations.authenticatedRequest(options.accountId, target.url!, {
        signal: options.signal,
      })
      expect(options.accountId).toBe(connection.ref)
      return { ref: target, title: "Report", text: response.body, format: "markdown" }
    },
  }
  const api = createDocsProvidersAPI(
    "acme",
    { ...manifest, docsProviders: definitions },
    {
      hasPermission: () => allowed,
      subscribePermissions: (listener) => {
        permissionListeners.add(listener)
        return () => {
          permissionListeners.delete(listener)
        }
      },
      connections: {
        list,
        onDidChange: (listener) => {
          const notify = () => listener({ added: [], removed: [], changed: [connection] })
          listeners.add(notify)
          return () => {
            listeners.delete(notify)
          }
        },
      },
    }
  )
  return {
    api,
    input,
    list,
    authenticatedRequest,
    listeners,
    revoke: () => {
      allowed = false
      for (const listener of [...permissionListeners]) listener()
    },
  }
}

it("binds account discovery and reads to Host proof and backgrounds URL matching", async () => {
  const { api, input } = setup()
  input.matchRef = (url) => {
    expect(pluginExecutionContext("acme")).toEqual(HOST_BACKGROUND)
    return { kind: "doc", id: "report", url }
  }
  input.listAccounts = async () => {
    expect(pluginExecutionContext("acme")?.localAuthorization).toBe(LOCAL_PERSON_RUN)
    return [{ id: connection.ref, label: "Alice", authorizationEpoch: "4" }]
  }
  input.fetch = async (target) => {
    await Promise.resolve()
    expect(pluginExecutionContext("acme")?.localAuthorization).toBe(LOCAL_PERSON_RUN)
    return { ref: target, title: "Report", text: "safe", format: "markdown" }
  }
  api.register(input)
  const provider = getDocsProvider(ref.providerId)!
  await provider.fetch(ref, {
    accountId: connection.ref,
    expectedAuthorizationEpoch: "4",
    credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
  })
  expect(pluginExecutionContext("acme")).toBeUndefined()
})

beforeEach(() => {
  clearDocsProvidersForPlugin("acme")
  __clearDocsProvidersForTests()
})
afterEach(() => clearDocsProvidersForPlugin("acme"))

it("registers a namespaced provider, recognizes only declared origins and reads through the plugin's public transport", async () => {
  const { api, input, authenticatedRequest } = setup()
  const registration = api.register(input)
  expect(registration.providerId).toBe("plugin:acme/docs")
  const provider = getDocsProvider(registration.providerId)!
  expect(listDocsProviders().map((item) => item.label)).toEqual(["Acme Docs"])
  expect(await provider.listAccounts()).toEqual([
    { id: connection.ref, label: "Alice", authorizationEpoch: "4" },
  ])
  expect(classifyCloudDocumentUrl(ref.url)?.providerId).toBe(registration.providerId)
  for (const url of [
    "http://docs.example.test/report",
    "https://docs.example.test.evil/report",
    "https://other.example.test/report",
    "https://user@docs.example.test/report",
    "https://@docs.example.test/report",
  ]) {
    expect(provider.matchRef(url)).toBeNull()
    expect(classifyCloudDocumentUrl(url)).toBeNull()
  }
  const content = await provider.fetch(ref, {
    accountId: connection.ref,
    expectedAuthorizationEpoch: "4",
  })
  expect(authenticatedRequest).toHaveBeenCalledTimes(1)
  expect(remoteDocumentProvenance(content)).toMatchObject({
    providerId: registration.providerId,
    resourceId: "report",
  })
  registration.unregister()
  expect(getDocsProvider(registration.providerId)).toBeUndefined()
})

it("requires docs:provide, refuses undeclared ids and cannot shadow a built-in", () => {
  const runtime = setup()
  expect(() => runtime.api.register({ ...runtime.input, id: "lark" })).toThrow(/declared/)
  runtime.revoke()
  expect(() => runtime.api.register(runtime.input)).toThrow(/docs:provide/)
})

it("refuses duplicate registrations and clears every contribution on disable", () => {
  const { api, input, listeners } = setup()
  const registration = api.register(input)
  expect(() => api.register(input)).toThrow(/already registered/)
  expect(listeners.size).toBe(1)
  clearDocsProvidersForPlugin("acme")
  registration.unregister()
  expect(listDocsProviders()).toEqual([])
  expect(listeners.size).toBe(0)
  expect(() => api.register(input)).toThrow(/activation/)
})

it("rejects invented connections and stale authorization epochs before reading", async () => {
  const { api, input, list, authenticatedRequest } = setup()
  const { providerId } = api.register(input)
  const provider = getDocsProvider(providerId)!
  await expect(
    provider.fetch(ref, { accountId: connection.ref, expectedAuthorizationEpoch: "3" })
  ).rejects.toMatchObject({ code: "notAuthorized" })
  list.mockResolvedValue([])
  expect(await provider.listAccounts()).toEqual([])
  await expect(
    provider.fetch(ref, { accountId: "invented", expectedAuthorizationEpoch: "4" })
  ).rejects.toMatchObject({ code: "notAuthorized" })
  expect(authenticatedRequest).not.toHaveBeenCalled()
})

it("fences a retained API when the same plugin is enabled again", () => {
  const previous = setup()
  clearDocsProvidersForPlugin("acme")
  const current = setup()
  expect(() => previous.api.register(previous.input)).toThrow(/activation/)
  const registration = current.api.register(current.input)
  expect(getDocsProvider(registration.providerId)).toBeDefined()
})

it.each(["replace", "dispose"])(
  "passes cancellation into the public authenticated transport on %s",
  async (change) => {
    const runtime = setup()
    let signal!: AbortSignal
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    runtime.authenticatedRequest.mockImplementation(async (_account, _url, init) => {
      signal = init!.signal!
      entered()
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Action cancelled or timed out")), {
          once: true,
        })
      })
    })
    const registration = runtime.api.register(runtime.input)
    const pending = getDocsProvider(registration.providerId)!.fetch(ref, {
      accountId: connection.ref,
      expectedAuthorizationEpoch: "4",
    })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await started
    registration.unregister()
    if (change === "replace") runtime.api.register(runtime.input)
    expect(signal.aborted).toBe(true)
    await rejected
  }
)

it("aborts and drops an uncooperative read when the plugin is disabled", async () => {
  const { api, input } = setup()
  let finish!: () => void
  let signal!: AbortSignal
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  input.fetch = async (target, options) => {
    signal = options.signal!
    entered()
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { ref: target, title: "Report", text: "late", format: "text" }
  }
  const { providerId } = api.register(input)
  const provider = getDocsProvider(providerId)!
  const pending = provider.fetch(ref, {
    accountId: connection.ref,
    expectedAuthorizationEpoch: "4",
  })
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
  await started
  clearDocsProvidersForPlugin("acme")
  expect(signal.aborted).toBe(true)
  await rejected
  finish()
  await expect(
    provider.fetch(ref, { accountId: connection.ref, expectedAuthorizationEpoch: "4" })
  ).rejects.toMatchObject({ name: "AbortError" })
})

it("normalizes public search refs and refuses a URL for a different document", async () => {
  const { api, input } = setup()
  input.search = jest.fn(async () => [{ ...ref, providerId: "docs" }])
  const registration = api.register(input)
  const provider = getDocsProvider(registration.providerId)!
  expect(
    await provider.search!("report", {
      accountId: connection.ref,
      expectedAuthorizationEpoch: "4",
      limit: 10,
    })
  ).toEqual([{ ...ref, providerId: registration.providerId }])
  await expect(
    provider.fetch(
      { ...ref, id: "different" },
      { accountId: connection.ref, expectedAuthorizationEpoch: "4" }
    )
  ).rejects.toMatchObject({ code: "invalidRef" })
})

it("aborts transports and removes the contribution immediately when its permission is revoked", async () => {
  const runtime = setup()
  let signal!: AbortSignal
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  runtime.authenticatedRequest.mockImplementation(async (_account, _url, options) => {
    signal = options!.signal!
    entered()
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("Action cancelled or timed out")), {
        once: true,
      })
    )
  })
  const registration = runtime.api.register(runtime.input)
  const provider = getDocsProvider(registration.providerId)!
  const pending = provider.fetch(ref, {
    accountId: connection.ref,
    expectedAuthorizationEpoch: "4",
  })
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
  await started
  runtime.revoke()
  expect(signal.aborted).toBe(true)
  expect(getDocsProvider(registration.providerId)).toBeUndefined()
  expect(provider.matchRef(ref.url)).toBeNull()
  await rejected
})

it("cancels connection-revision reads and refuses their late result", async () => {
  const runtime = setup()
  let signal!: AbortSignal
  let complete!: (value: { body: string }) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  runtime.authenticatedRequest.mockImplementation(async (_account, _url, options) => {
    signal = options!.signal!
    entered()
    return new Promise((resolve) => {
      complete = resolve
    })
  })
  const registration = runtime.api.register(runtime.input)
  const pending = getDocsProvider(registration.providerId)!.fetch(ref, {
    accountId: connection.ref,
    expectedAuthorizationEpoch: "4",
  })
  const rejected = expect(pending).rejects.toMatchObject({ code: "notAuthorized" })
  await started
  runtime.list.mockResolvedValue([{ ...connection, revision: 5 }])
  for (const notify of runtime.listeners) notify()
  expect(signal.aborted).toBe(true)
  complete({ body: "late" })
  await rejected
})

it("cleans every provider and Host subscription even when a plugin account disposer throws", () => {
  const second = { ...def, id: "second", mentionPrefix: "acme.second:" }
  const runtime = setup([def, second])
  const stop = jest.fn(() => {
    throw new Error("Plugin cleanup failed")
  })
  runtime.input.subscribeAccounts = () => stop
  const one = runtime.api.register(runtime.input)
  const two = runtime.api.register({
    ...runtime.input,
    id: second.id,
    mentionPrefix: second.mentionPrefix,
  })
  getDocsProvider(one.providerId)!.subscribeAccounts!(() => {})
  getDocsProvider(two.providerId)!.subscribeAccounts!(() => {})
  clearDocsProvidersForPlugin("acme")
  expect(stop).toHaveBeenCalledTimes(2)
  expect(listDocsProviders()).toEqual([])
  expect(runtime.listeners.size).toBe(0)
})

it("releases its Host listener if a plugin account subscription cannot start", () => {
  const runtime = setup()
  runtime.input.subscribeAccounts = () => {
    throw new Error("Cannot subscribe")
  }
  const registration = runtime.api.register(runtime.input)
  expect(() => getDocsProvider(registration.providerId)!.subscribeAccounts!(() => {})).not.toThrow()
  expect(runtime.listeners.size).toBe(1)
  registration.unregister()
  expect(runtime.listeners.size).toBe(0)
})

it("never exposes Host-local credential admission to a plugin fetch callback", async () => {
  const runtime = setup()
  const original = runtime.input.fetch
  const fetch = jest.fn(original)
  runtime.input.fetch = fetch
  const listAccounts = jest.fn(runtime.input.listAccounts)
  runtime.input.listAccounts = listAccounts
  const registration = runtime.api.register(runtime.input)
  await getDocsProvider(registration.providerId)!.listAccounts({
    credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
  })
  expect(listAccounts).toHaveBeenCalledWith()
  await getDocsProvider(registration.providerId)!.fetch(ref, {
    accountId: connection.ref,
    expectedAuthorizationEpoch: "4",
    credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
  })
  expect(fetch.mock.calls[0][1]).not.toHaveProperty("credentialContext")
  expect(fetch.mock.calls[0][1]).toMatchObject({
    accountId: connection.ref,
    expectedAuthorizationEpoch: "4",
  })
})
