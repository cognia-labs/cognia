import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { acquireSyncLease, fenceConnectionSyncLeases, withSyncLease } from "./sync-lease"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  await getDb().authConnections.put({ id: "ref", status: "connected" } as never)
})
afterAll(fixture.dispose)

it("heartbeats while work runs and aborts and fences it on disconnect", async () => {
  let lease!: NonNullable<Awaited<ReturnType<typeof acquireSyncLease>>>
  let finish!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = withSyncLease(
    "ref",
    "ingress",
    async (held) => {
      lease = held
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      await held.commit([], async () => undefined)
    },
    { ttlMs: 3000 }
  )
  const failed = expect(pending).rejects.toThrow("lease")
  await ready
  const first = (await getDb().syncLeases.get(lease.row.key))!
  // Keep real IDB scheduling; wait for a real heartbeat, not a mocked renew.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 4000
    const check = async () => {
      const row = await getDb().syncLeases.get(first.key)
      if (row!.heartbeatAt > first.heartbeatAt) return resolve()
      if (Date.now() > deadline) return reject(new Error("No heartbeat"))
      setTimeout(() => {
        void check().catch(reject)
      }, 10)
    }
    void check().catch(reject)
  })
  expect(await acquireSyncLease("ref", "ingress")).toBeNull()
  await fenceConnectionSyncLeases("ref")
  expect(lease.signal.aborted).toBe(true)
  finish()
  await failed
  expect(await getDb().syncLeases.count()).toBe(0)
})

it("aborts on renewal loss and releases on success and task failure", async () => {
  const held = (await acquireSyncLease("ref", "cursor"))!
  await getDb().syncLeases.clear()
  expect(await held.renew()).toBe(false)
  expect(held.signal.aborted).toBe(true)
  await held.release()
  expect(await withSyncLease("ref", "cursor", async () => 42)).toBe(42)
  await expect(
    withSyncLease("ref", "cursor", async () => {
      throw new Error("task failed")
    })
  ).rejects.toThrow("task failed")
  expect(await getDb().syncLeases.count()).toBe(0)
})
