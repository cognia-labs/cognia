/** @jest-environment jsdom */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { type PluginSyncDriver, syncCursorInvalid, syncRateLimited } from "@cognia/plugin-sdk"
import { assertSyncConnection, clearSyncForPlugin, createSyncAPI } from "./sync-api"
import { connectionAccess } from "@/lib/plugin/auth/connection-access"
import { purgeDerivedData } from "@/lib/external-services/derived-data-registry"
import { pendingExternalSyncKeys } from "@/lib/external-services/sync/runtime"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import {
  HOST_BACKGROUND,
  bindPluginContextCallbacks,
  pluginExecutionContext,
  withPluginExecutionContext,
} from "@/lib/plugin/core/invocation-identity"

jest.mock("@/lib/plugin/auth/connection-access", () => ({ connectionAccess: jest.fn() }))

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
afterEach(() => clearSyncForPlugin("sync-test"))
afterEach(() => jest.restoreAllMocks())
const key = "plugin:sync-test/calendar:a:b"
const row = () => getDb().externalSyncCursors.get(key)
const driver = () =>
  ({
    itemId: (id) => id,
    fetchPage: jest.fn(async (_input: Parameters<PluginSyncDriver<string>["fetchPage"]>[0]) => ({
      items: ["a"],
      cursor: "secret-cursor",
    })),
    applyPage: jest.fn(async () => {}),
  }) satisfies PluginSyncDriver<string>
const api = () => createSyncAPI("sync-test", { hasPermission: () => true })

it("pins direct sync callbacks to their initiating Host identity across awaits", async () => {
  const sync = bindPluginContextCallbacks("sync-test", api())
  const identity: PersonalCredentialContext = { localAuthorization: LOCAL_PERSON_RUN }
  const observed: unknown[] = []
  const record = async () => {
    await Promise.resolve()
    observed.push(pluginExecutionContext("sync-test"))
  }
  sync.register("calendar:a:b", {
    itemId: (id: string) => {
      observed.push(pluginExecutionContext("sync-test"))
      return id
    },
    fetchPage: async () => {
      await record()
      return { items: ["a"], cursor: "next" }
    },
    applyPage: record,
    complete: record,
  })
  let pending!: ReturnType<typeof sync.run>
  withPluginExecutionContext("sync-test", identity, () => {
    pending = sync.run("calendar:a:b")
  })
  expect(await pending).toMatchObject({ status: "completed" })
  expect(observed).toEqual(Array(4).fill(identity))
  expect(pluginExecutionContext("sync-test")).toBeUndefined()
})

it("keeps queued cursor callbacks background despite a pending person invocation or manual label", async () => {
  const sync = api()
  let release!: () => void
  const pending = withPluginExecutionContext(
    "sync-test",
    { localAuthorization: LOCAL_PERSON_RUN },
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const observed: unknown[] = []
  let complete!: () => void
  const finished = new Promise<void>((resolve) => {
    complete = resolve
  })
  sync.register("calendar:a:b", {
    itemId: String,
    fetchPage: async () => {
      observed.push(pluginExecutionContext("sync-test"))
      complete()
      return { items: [] }
    },
    applyPage: async () => {},
  })
  try {
    sync.request("calendar:a:b", {
      reason: "manual",
      ...{ credentialContext: { localAuthorization: LOCAL_PERSON_RUN } },
    })
    await finished
    expect(observed).toEqual([HOST_BACKGROUND])
  } finally {
    release()
    await pending
  }
})

it("retains cancelled sync callback binding until the plugin promise actually settles", async () => {
  const sync = api()
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release!: () => void
  const resume = new Promise<void>((resolve) => {
    release = resolve
  })
  let observed: unknown
  const d = driver()
  d.fetchPage.mockImplementationOnce(async () => {
    entered()
    await resume
    observed = pluginExecutionContext("sync-test")
    return { items: [], cursor: "late" }
  })
  sync.register("calendar:a:b", d)
  const controller = new AbortController()
  const pending = sync.run("calendar:a:b", { signal: controller.signal })
  await ready
  controller.abort()
  expect(await pending).toMatchObject({ status: "cancelled" })
  expect(pluginExecutionContext("sync-test")).toEqual(HOST_BACKGROUND)
  release()
  await resume
  await Promise.resolve()
  expect(observed).toEqual(HOST_BACKGROUND)
})

it("checks Host integration grants without requiring a legacy builtin to declare auth services", async () => {
  const db = getDb()
  await db.authConnections.put({
    id: "github-ref",
    providerId: "github-pat",
    status: "connected",
    revision: 1,
    ownerPluginId: null,
  } as never)
  await db.integrationAccounts.put({
    id: "github-account",
    pluginId: "github-delivery",
    providerId: "github-pat",
    connectionId: "github-ref",
  } as never)
  await db.serviceConnections.put({
    id: "github-projection",
    pluginId: "github-delivery",
    status: "connected",
    providerFingerprint: "fp",
    providerRef: {
      kind: "integration",
      accountId: "github-account",
      authConnectionRef: "github-ref",
    },
  } as never)
  await db.capabilityGrants.put({
    id: "github-grant",
    connectionId: "github-projection",
    consumerPluginId: "github-delivery",
    connectionRevision: 1,
    providerFingerprint: "fp",
    operationPatterns: ["github.request.GET"],
  } as never)
  jest.mocked(connectionAccess).mockReturnValue({
    connected: async () => undefined,
    checked: async <T>(read: () => Promise<T>) => read(),
  } as never)
  await expect(
    assertSyncConnection("github-delivery", "github-ref" as never, () => {}, {
      hostIntegration: true,
    })
  ).resolves.toBeUndefined()
  await expect(
    assertSyncConnection("github-delivery", "github-ref" as never, () => {})
  ).rejects.toThrow(/unavailable/)
  await db.capabilityGrants.delete("github-grant")
  await expect(
    assertSyncConnection("github-delivery", "github-ref" as never, () => {}, {
      hostIntegration: true,
    })
  ).rejects.toThrow(/grant/)
})

it("namespaces a registration, hides cursors, resets to full and disposes", async () => {
  const sync = api()
  const d = driver()
  const registration = sync.register("calendar:a:b", d)
  expect(() => sync.register("calendar:a:b", d)).toThrow(/registered/)
  expect(await sync.run("calendar:a:b")).toMatchObject({ status: "completed", mode: "full" })
  expect(await row()).toMatchObject({ owner: "plugin:sync-test", cursor: "secret-cursor" })
  expect(JSON.stringify(await sync.status("calendar:a:b"))).not.toContain("secret-cursor")
  expect(await sync.run("calendar:a:b")).toMatchObject({ mode: "incremental" })
  await sync.reset("calendar:a:b")
  expect(await sync.run("calendar:a:b")).toMatchObject({ mode: "full" })
  registration.dispose()
  expect(() => sync.request("calendar:a:b", { reason: "poll" })).toThrow()
  sync.register("calendar:a:b", d)
  registration.dispose()
  expect(await sync.run("calendar:a:b")).toMatchObject({ status: "completed" })
})

it("keeps subscription renewal dormant on the public surface", () => {
  expect(Object.keys(api()).sort()).toEqual(["register", "request", "reset", "run", "status"])
})

it("denies missing permissions and invalid keys", () => {
  expect(() =>
    createSyncAPI("denied", { hasPermission: () => false }).register("a", driver())
  ).toThrow(/sync:run/)
  const sync = api()
  for (const id of ["", "a/b", "a".repeat(129)])
    expect(() => sync.register(id, driver())).toThrow(/key/)
})

it("maps tagged errors but never maps a Node-target message-only error", async () => {
  const sync = api()
  const d = driver()
  d.fetchPage.mockImplementationOnce(async () => syncCursorInvalid())
  sync.register("calendar:a:b", d)
  expect(await sync.run("calendar:a:b")).toMatchObject({ status: "completed", mode: "full" })
  d.fetchPage.mockImplementationOnce(async () => syncRateLimited(60_000))
  expect(await sync.run("calendar:a:b")).toMatchObject({
    status: "backoff",
    errorCode: "rate-limited",
  })
  expect((await row())?.backoffUntil).toBeGreaterThan(Date.now() + 50_000)
  await sync.reset("calendar:a:b")
  d.fetchPage.mockImplementationOnce(async () => {
    throw Object.assign(new Error("ExternalSyncCursorInvalid: private remote body"), {
      name: "ExternalSyncCursorInvalid",
    })
  })
  expect(await sync.run("calendar:a:b")).toMatchObject({
    status: "failed",
    errorCode: "sync-failed",
  })
  expect((await row())?.cursor).toBe("secret-cursor")
  expect((await row())?.invalidated).toBe(true)
})

it.each([
  { items: null, cursor: "next" },
  { items: Array(1001).fill("a"), cursor: "next" },
  { items: [1], cursor: "next" },
  { items: [], deleted: [1], cursor: "next" },
  { items: [], nextPage: "x".repeat(16385) },
  { items: [], cursor: "x".repeat(16385) },
  { items: [], cursor: 1 },
])("rejects malformed pages before applying or committing %#", async (page) => {
  const sync = api()
  const d = driver()
  d.fetchPage.mockResolvedValueOnce(page as never)
  sync.register("calendar:a:b", d)
  expect(await sync.run("calendar:a:b")).toMatchObject({ status: "failed" })
  expect(d.applyPage).not.toHaveBeenCalled()
  expect((await row())?.cursor).toBeUndefined()
})

it("aborts a disposed plugin's pending callback and never commits late results", async () => {
  const lifecycle = new AbortController()
  const sync = createSyncAPI("sync-test", { hasPermission: () => true, signal: lifecycle.signal })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let release!: (page: { items: string[]; cursor: string }) => void
  let received: AbortSignal | undefined
  const d = driver()
  d.fetchPage.mockImplementationOnce(async ({ signal }) => {
    received = signal
    started()
    return new Promise((resolve) => {
      release = resolve
    })
  })
  sync.register("calendar:a:b", d)
  const run = sync.run("calendar:a:b")
  await ready
  expect(await sync.status("calendar:a:b")).toMatchObject({ inProgress: true })
  lifecycle.abort()
  expect(await run).toMatchObject({ status: "cancelled" })
  expect(received?.aborted).toBe(true)
  release({ items: ["late"], cursor: "late" })
  expect((await row())?.cursor).toBeUndefined()
  expect(d.applyPage).not.toHaveBeenCalled()
})

it("cancels a caller's run, unregisters on Host disable and coalesces polling", async () => {
  const sync = api()
  const d = driver()
  sync.register("calendar:a:b", d)
  const controller = new AbortController()
  controller.abort()
  expect(await sync.run("calendar:a:b", { signal: controller.signal })).toMatchObject({
    status: "cancelled",
  })
  sync.request("calendar:a:b", { reason: "poll", full: true })
  sync.request("calendar:a:b", { reason: "poll" })
  expect(pendingExternalSyncKeys().filter((value) => value === key)).toEqual([key])
  clearSyncForPlugin("sync-test")
  expect(pendingExternalSyncKeys()).not.toContain(key)
})

it("accepts callback-initiated cancellation without committing a cursor", async () => {
  const sync = api()
  const d = driver()
  d.fetchPage.mockImplementationOnce(async () => {
    throw new DOMException("Plugin cancelled", "AbortError")
  })
  sync.register("calendar:a:b", d)
  expect(await sync.run("calendar:a:b")).toMatchObject({ status: "cancelled" })
  expect((await row())?.cursor).toBeUndefined()
})

it("cancels a run paused before core entry when plugin data is purged", async () => {
  const sync = api()
  const d = driver()
  sync.register("calendar:a:b", d)
  let release!: () => void
  let entered!: () => void
  const paused = new Promise<void>((resolve) => {
    entered = resolve
  })
  const resume = new Promise<void>((resolve) => {
    release = resolve
  })
  const table = getDb().externalSyncCursors
  const read = table.get.bind(table)
  const spy = jest.spyOn(table, "get").mockImplementationOnce((criteria) =>
    read(criteria).then(async (result) => {
      entered()
      await resume
      return result
    })
  )
  const pending = sync.run("calendar:a:b")
  await paused
  await purgeDerivedData({ kind: "plugin-data", pluginId: "sync-test" })
  // A replacement with the same key cannot revive the old registration.
  sync.register("calendar:a:b", driver())
  release()
  expect(await pending).toMatchObject({ status: "cancelled" })
  spy.mockRestore()
  expect(await row()).toBeUndefined()
  expect(d.fetchPage).not.toHaveBeenCalled()
  expect(d.applyPage).not.toHaveBeenCalled()
})

it("never overlaps runs of a registration, including a queued background run", async () => {
  const sync = api()
  const d = driver()
  await getDb().authConnections.put({ id: "ref", status: "connected" } as never)
  jest.mocked(connectionAccess).mockReturnValue({
    connected: async () => ({ id: "ref", status: "connected", ownerPluginId: "sync-test" }),
    checked: async <T>(task: () => Promise<T>) => task(),
  } as unknown as ReturnType<typeof connectionAccess>)
  let release!: () => void
  let entered!: () => void
  const paused = new Promise<void>((resolve) => {
    entered = resolve
  })
  const resume = new Promise<void>((resolve) => {
    release = resolve
  })
  let active = 0
  let maximum = 0
  d.fetchPage.mockImplementation(async () => {
    maximum = Math.max(maximum, ++active)
    entered()
    await resume
    active--
    return { items: ["a"], cursor: "next" }
  })
  const binding = { connectionRef: "ref" as never }
  sync.register("calendar:a:b", d, binding)
  binding.connectionRef = "other-exclusion-domain" as never
  const first = sync.run("calendar:a:b")
  await paused
  const second = sync.run("calendar:a:b")
  sync.request("calendar:a:b", { reason: "manual" })
  expect(await second).toMatchObject({ status: "busy" })
  release()
  expect(await first).toMatchObject({ status: "completed" })
  expect(await row()).toMatchObject({ connectionRef: "ref" })
  expect(maximum).toBe(1)
})

it("fails safely when a persisted connection differs from the immutable registration", async () => {
  const sync = api()
  const d = driver()
  await getDb().externalSyncCursors.put({
    key,
    owner: "plugin:sync-test",
    connectionRef: "old" as never,
    cursor: "keep",
    failures: 0,
  })
  sync.register("calendar:a:b", d)
  expect(await sync.run("calendar:a:b")).toMatchObject({
    status: "failed",
    errorCode: "target-mismatch",
  })
  expect(await row()).toMatchObject({ connectionRef: "old", cursor: "keep", failures: 0 })
  expect(d.fetchPage).not.toHaveBeenCalled()
})

it("requires a current consumer grant, binds a lease and purges on revocation", async () => {
  const sync = api()
  jest.mocked(connectionAccess).mockReturnValue({
    connected: async () => ({
      id: "ref",
      providerId: "provider",
      revision: 1,
      status: "connected",
      ownerPluginId: "auth",
    }),
    checked: async <T>(task: () => Promise<T>) => task(),
    visible: async () => true,
  } as unknown as ReturnType<typeof connectionAccess>)
  const db = getDb()
  await db.authConnections.put({ id: "ref", status: "connected" } as never)
  await db.integrationAccounts.put({
    id: "account",
    pluginId: "sync-test",
    providerId: "provider",
    connectionId: "ref",
  } as never)
  await db.serviceConnections.put({
    id: "projection",
    pluginId: "sync-test",
    status: "connected",
    providerFingerprint: "fp",
    providerRef: { kind: "integration", accountId: "account", authConnectionRef: "ref" },
  } as never)
  let registration = sync.register("calendar:a:b", driver(), { connectionRef: "ref" as never })
  await expect(sync.run("calendar:a:b")).rejects.toThrow(/grant/)
  registration.dispose()
  await db.capabilityGrants.put({
    id: "grant",
    connectionId: "projection",
    consumerPluginId: "sync-test",
    connectionRevision: 0,
    providerFingerprint: "fp",
    operationPatterns: ["calendar.read"],
  } as never)
  registration = sync.register("calendar:a:b", driver(), { connectionRef: "ref" as never })
  await expect(sync.run("calendar:a:b")).rejects.toThrow(/grant/)
  registration.dispose()
  await db.capabilityGrants.update("grant", { connectionRevision: 1 })
  const options = { connectionRef: "ref" as never }
  registration = sync.register("calendar:a:b", driver(), options)
  options.connectionRef = "other" as never
  expect(await sync.run("calendar:a:b")).toMatchObject({
    status: "completed",
  })
  expect(await row()).toMatchObject({ connectionRef: "ref" })
  await db.capabilityGrants.delete("grant")
  await expect(sync.run("calendar:a:b")).rejects.toThrow(/grant/)
  await purgeDerivedData({ kind: "consumer", ref: "ref" as never, consumerPluginId: "sync-test" })
  expect(await row()).toBeUndefined()
  expect(() => sync.request("calendar:a:b", { reason: "poll" })).toThrow(/registered/)
})

it("does not expose provider errors while resolving a connection binding", async () => {
  const sync = api()
  jest.mocked(connectionAccess).mockReturnValue({
    connected: async () => {
      throw new Error("private refresh response")
    },
  } as unknown as ReturnType<typeof connectionAccess>)
  sync.register("calendar:a:b", driver(), { connectionRef: "ref" as never })
  await expect(sync.run("calendar:a:b")).rejects.toThrow("Sync connection unavailable")
  expect(await row()).toBeUndefined()
})
