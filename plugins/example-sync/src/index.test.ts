/** @jest-environment jsdom */
/** @cognia-host-integration-test */
import { createDbTestFixture } from "../../../lib/db/test-fixture"
import { getDb } from "../../../lib/db/schema"
import { createSyncAPI, clearSyncForPlugin } from "../../../lib/plugin/api/sync-api"
import type { PluginContext } from "@cognia/plugin-sdk"
import definition, { manifest } from "./index"

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
afterEach(() => clearSyncForPlugin(manifest.id))

it("runs an unbundled public plugin through pages, cursor reuse, tombstones and disposal", async () => {
  const values = new Map<string, unknown>([["mirror", { gone: { id: "gone", title: "Keep me" } }]])
  const disposers: Array<() => void> = []
  const sync = createSyncAPI(manifest.id, { hasPermission: () => true })
  await definition.activate?.({
    sync,
    storage: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      set: async (key, value) => {
        values.set(key, structuredClone(value))
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => {
        disposers.push(dispose)
      },
    },
  } as PluginContext)
  expect(await sync.run("demo")).toMatchObject({
    status: "completed",
    mode: "full",
    pages: 2,
    tombstoned: 1,
  })
  expect(values.get("mirror")).toEqual({
    one: { id: "one", title: "First item" },
    two: { id: "two", title: "Second item" },
    gone: { id: "gone", title: "Keep me", sourceRemoved: true },
  })
  expect(await sync.run("demo")).toMatchObject({
    status: "completed",
    mode: "incremental",
    applied: 0,
  })
  expect(await getDb().externalSyncCursors.get(`plugin:${manifest.id}/demo`)).toMatchObject({
    cursor: "demo-v1",
  })
  expect(JSON.stringify(await sync.status("demo"))).not.toContain("demo-v1")
  disposers.forEach((dispose) => dispose())
  expect(() => sync.request("demo", { reason: "manual" })).toThrow()
})
