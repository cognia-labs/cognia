/** @jest-environment jsdom */
import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  deleteExternalSyncSeen,
  getExternalSyncCursor,
  getExternalSyncSeen,
  listDeferredExternalSyncs,
  listExternalSyncSubscriptions,
} from "./external-sync"
const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
it("reads deferred/subscription rows and isolates generation seen sets", async () => {
  await getDb().externalSyncCursors.bulkPut([
    { key: "one", owner: "host", failures: 0, deferredOffline: true },
    {
      key: "two",
      owner: "plugin:example",
      failures: 0,
      subscription: { id: "sub", expiresAt: 100, renewAt: 50, attempts: 0, state: "active" },
    },
  ])
  await getDb().externalSyncSeen.bulkPut([
    { key: "one", generation: "a", itemId: "1" },
    { key: "one", generation: "b", itemId: "2" },
    { key: "two", generation: "a", itemId: "3" },
  ])
  expect((await getExternalSyncCursor("one"))?.owner).toBe("host")
  expect((await listDeferredExternalSyncs()).map((r) => r.key)).toEqual(["one"])
  expect((await listExternalSyncSubscriptions()).map((r) => r.key)).toEqual(["two"])
  expect(await getExternalSyncSeen("one", "a")).toEqual(new Set(["1"]))
  expect(await deleteExternalSyncSeen("one", "a")).toBe(1)
  expect(await getDb().externalSyncSeen.count()).toBe(2)
})
