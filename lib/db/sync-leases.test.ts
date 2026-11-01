import { createDbTestFixture } from "./test-fixture"
import { getDb } from "./schema"
import {
  claimSyncLease,
  commitSyncLease,
  releaseSyncLease,
  renewSyncLease,
  sweepExpiredSyncLeases,
  SyncLeaseLost,
} from "./sync-leases"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().authConnections.put({ id: "ref", status: "connected" } as never)
})
afterEach(() => jest.restoreAllMocks())
afterAll(fixture.dispose)

it("fault injection: a silent owner loses its cursor fence only at expiry", async () => {
  let now = Date.now()
  jest.spyOn(Date, "now").mockImplementation(() => now)
  const first = (await claimSyncLease("ref", "ingress", "A", 1000))!
  now += 999
  expect(await claimSyncLease("ref", "ingress", "B", 1000)).toBeNull()
  now += 1
  // Expiry alone fences A, even before B acquires.
  await expect(
    commitSyncLease(first, [getDb().integrationAudit], async () => {
      await getDb().integrationAudit.put({ id: "stale-cursor" } as never)
    })
  ).rejects.toBeInstanceOf(SyncLeaseLost)
  const second = (await claimSyncLease("ref", "ingress", "B", 1000))!
  expect(second.ownerId).toBe("B")
  expect(second.token).not.toBe(first.token)
  expect(await renewSyncLease(first, 1000)).toBe(false)
  await releaseSyncLease(first)
  expect(await getDb().syncLeases.get(second.key)).toEqual(second)
  await expect(commitSyncLease(first, [], async () => "stale")).rejects.toBeInstanceOf(
    SyncLeaseLost
  )
  await commitSyncLease(second, [getDb().integrationAudit], async () => {
    await getDb().integrationAudit.put({ id: "cursor-B" } as never)
  })
  expect(await getDb().integrationAudit.get("stale-cursor")).toBeUndefined()
  expect(await getDb().integrationAudit.get("cursor-B")).toBeDefined()
})

it("serializes contenders, isolates duties, renews and sweeps expired rows", async () => {
  const results = await Promise.all([
    claimSyncLease("ref", "cursor", "A", 1000),
    claimSyncLease("ref", "cursor", "B", 1000),
  ])
  expect(results.filter(Boolean)).toHaveLength(1)
  const lease = results.find(Boolean)!
  expect(await claimSyncLease("ref", "cursor", lease.ownerId, 1000)).toBeNull()
  expect(await claimSyncLease("ref", "watch", "B", 1000)).not.toBeNull()
  expect(await renewSyncLease(lease, 1000)).toBe(true)
  await releaseSyncLease(lease)
  expect(await getDb().syncLeases.get(lease.key)).toBeUndefined()
  expect(await sweepExpiredSyncLeases(Date.now() + 1001)).toBe(1)
  await expect(claimSyncLease("ref", "cursor", "A", 0)).rejects.toThrow("TTL")
})

it("rolls back cursor writes that cross expiry and refuses disconnected or cleaning connections", async () => {
  let now = Date.now()
  jest.spyOn(Date, "now").mockImplementation(() => now)
  const row = (await claimSyncLease("ref", "cursor", "A", 1000))!
  await expect(
    commitSyncLease(row, [getDb().integrationAudit], async () => {
      await getDb().integrationAudit.put({ id: "late" } as never)
      now += 1000
    })
  ).rejects.toBeInstanceOf(SyncLeaseLost)
  expect(await getDb().integrationAudit.get("late")).toBeUndefined()
  await getDb().authConnections.update("ref", { status: "revoked" })
  expect(await claimSyncLease("ref", "cursor", "B", 1000)).toBeNull()
  await getDb().authConnections.update("ref", { status: "connected" })
  await getDb().integrationAudit.put({
    id: "cleanup",
    kind: "access.cleanup.pending",
    detail: { target: { kind: "connection", ref: "ref" } },
  } as never)
  expect(await claimSyncLease("ref", "cursor", "B", 1000)).toBeNull()
})
