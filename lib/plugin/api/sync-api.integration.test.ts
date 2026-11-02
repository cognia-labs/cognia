/** @jest-environment jsdom */
/** @cognia-host-integration-test */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import {
  defineSyncDriver,
  syncCursorInvalid,
  syncRateLimited,
  type PluginSyncAPI,
  type PluginSyncRegistrationOptions,
} from "@cognia/plugin-sdk"
import { createSyncAPI, clearSyncForPlugin } from "./sync-api"
import { connectionAccess } from "@/lib/plugin/auth/connection-access"

jest.mock("@/lib/plugin/auth/connection-access", () => ({ connectionAccess: jest.fn() }))

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
afterEach(() => clearSyncForPlugin("roundtrip"))

it("accepts a serialized register-time binding before invoking realm callbacks", async () => {
  await getDb().authConnections.put({ id: "ref", status: "connected" } as never)
  const connected = jest.fn(async (ref: string) => ({
    id: ref,
    status: "connected",
    ownerPluginId: "roundtrip",
  }))
  jest.mocked(connectionAccess).mockReturnValue({
    connected,
    checked: async <T>(task: () => Promise<T>) => task(),
  } as unknown as ReturnType<typeof connectionAccess>)
  const sync = createSyncAPI("roundtrip", { hasPermission: () => true })
  const binding: PluginSyncRegistrationOptions = JSON.parse('{"connectionRef":"ref"}')
  const applied: string[] = []
  sync.register(
    "bound",
    defineSyncDriver({
      itemId: (item: string) => item,
      fetchPage: () => realm(async () => ({ items: ["one"], cursor: "opaque" })),
      async applyPage({ items }) {
        applied.push(...items)
      },
    }),
    binding
  )
  expect(connected).toHaveBeenCalledWith("ref")
  binding.connectionRef = "changed-after-register" as never
  expect(await sync.run("bound")).toMatchObject({ status: "completed" })
  expect(connected.mock.calls.every(([ref]) => ref === "ref")).toBe(true)
  expect(applied).toEqual(["one"])
  expect(await getDb().externalSyncCursors.get("plugin:roundtrip/bound")).toMatchObject({
    connectionRef: "ref",
    cursor: "opaque",
  })
})

/** Model a callback boundary that preserves only JSON-safe tagged properties. */
async function realm<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return JSON.parse(JSON.stringify(await callback())) as T
  } catch (error) {
    throw JSON.parse(JSON.stringify(error))
  }
}

it("round-trips public driver pages/errors through the bridge and the real Host cursor core", async () => {
  const sync: PluginSyncAPI = createSyncAPI("roundtrip", { hasPermission: () => true })
  const applied: string[] = []
  const fetched: Array<{ mode: string; cursor?: string; page?: string }> = []
  let failure: "invalid" | "rate" | undefined
  sync.register(
    "items",
    defineSyncDriver({
      itemId: (item: { id: string }) => item.id,
      fetchPage: (input) =>
        realm(async () => {
          fetched.push({ mode: input.mode, cursor: input.cursor, page: input.page })
          if (failure === "invalid") {
            failure = undefined
            syncCursorInvalid()
          }
          if (failure === "rate") syncRateLimited(60_000)
          return input.page
            ? { items: [{ id: "two" }], cursor: "opaque-next" }
            : { items: [{ id: "one" }], nextPage: "page-two" }
        }),
      async applyPage({ items }, { signal }) {
        signal.throwIfAborted()
        applied.push(...items.map((item) => item.id))
      },
    })
  )
  expect(await sync.run("items")).toMatchObject({ status: "completed", pages: 2 })
  failure = "invalid"
  expect(await sync.run("items")).toMatchObject({ status: "completed", mode: "full" })
  expect(fetched.slice(2, 4)).toEqual([
    { mode: "incremental", cursor: "opaque-next", page: undefined },
    { mode: "full", cursor: undefined, page: undefined },
  ])
  failure = "rate"
  expect(await sync.run("items")).toMatchObject({ status: "backoff", errorCode: "rate-limited" })
  expect(await getDb().externalSyncCursors.get("plugin:roundtrip/items")).toMatchObject({
    cursor: "opaque-next",
    failures: 1,
  })
  expect(applied).toEqual(["one", "two", "one", "two"])
})

it("fails a timed-out realm without committing its late terminal cursor", async () => {
  const sync = createSyncAPI("roundtrip", { hasPermission: () => true, callbackTimeoutMs: 5 })
  let finish!: (page: { items: string[]; cursor: string }) => void
  sync.register<string>("items", {
    itemId: String,
    fetchPage: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    applyPage: async () => {},
  })
  expect(await sync.run("items")).toMatchObject({ status: "failed", errorCode: "sync-failed" })
  finish({ items: ["late"], cursor: "must-not-commit" })
  expect((await getDb().externalSyncCursors.get("plugin:roundtrip/items"))?.cursor).toBeUndefined()
})
