import "fake-indexeddb/auto"

import { encodeHlc } from "@cognia/sync-protocol"

import { TEST_SPACE } from "../enrollment/test-support"
import { __clearAccountSyncKeyCache } from "../vault-store"
import {
  armAndSeed,
  disarm,
  isArmedFor,
  joinWithChoice,
  planJoin,
  remoteLogLength,
  replaceWithAccount,
  summarizeLocalData,
  type JoinTarget,
} from "./join"
import { closeAll, settleAll, syncedDevices, type SyncDevice } from "./test-support"
import type { AccountSyncCaptureState, AccountSyncCursorState } from "./types"

beforeEach(() => __clearAccountSyncKeyCache())

const NOW = 10_000_000

const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: "Plan", createdAt: 1_000, updatedAt: 2_000, ...extra }) as never

/** Two enrolled devices whose databases are not armed yet (what enrollment leaves behind). */
async function unarmedPair() {
  const { server, devices } = await syncedDevices(["a", "b"])
  for (const device of devices) await disarm(device.db)
  const target = async (device: SyncDevice): Promise<JoinTarget> => ({
    db: device.db,
    spaceId: TEST_SPACE,
    deviceId: (await device.keys()).deviceId,
    now: () => NOW,
  })
  return { server, devices, a: devices[0] as SyncDevice, b: devices[1] as SyncDevice, target }
}

describe("planJoin", () => {
  it("seeds without asking when either side is empty, and asks when both hold data", async () => {
    const { devices, a, b, target } = await unarmedPair()
    const keysA = await a.keys()
    const keysB = await b.keys()
    // Nothing local: seed (settings only).
    expect(await planJoin(await target(a), a.context.api, keysA)).toMatchObject({ kind: "seed" })

    await a.db.sessions.put(session("s1"))
    await a.db.skills.put({ id: "k0", name: "Built-in", content: "", source: "builtin" } as never)
    const plan = await planJoin(await target(a), a.context.api, keysA)
    expect(plan).toMatchObject({ kind: "seed", local: { total: 1 } })
    expect(plan.kind === "seed" && plan.local.counts.skills).toBe(0)

    await armAndSeed(await target(a))
    expect(await planJoin(await target(a), a.context.api, keysA)).toEqual({ kind: "armed" })
    await a.round()
    expect(await remoteLogLength(b.context.api, keysB)).toBe(1)

    await b.db.characters.put({ id: "c1", name: "Mine", createdAt: 1, updatedAt: 1 } as never)
    expect(await planJoin(await target(b), b.context.api, keysB)).toMatchObject({
      kind: "ask",
      question: "both-hold-data",
      remoteSeq: 1,
      local: { total: 1, counts: { characters: 1 } },
    })
    closeAll(devices)
  })
})

describe("planJoin for a database that synced with another space", () => {
  it("asks instead of seeding, however empty either side is, even after a removal", async () => {
    const { devices, a, target } = await unarmedPair()
    const keysA = await a.keys()
    await armAndSeed(await target(a))
    const other = { ...(await target(a)), spaceId: "o".repeat(43) }
    // Nothing queued on the other side yet, nothing local: still a question.
    expect(await planJoin(other, a.context.api, keysA)).toMatchObject({
      kind: "ask",
      question: "other-account",
      local: { total: 0 },
    })
    await a.db.sessions.put(session("s1"))
    // A removal disarms capture; the cursor still names the old space.
    await disarm(a.db)
    expect(await planJoin(other, a.context.api, keysA)).toMatchObject({
      kind: "ask",
      question: "other-account",
      local: { total: 1 },
    })
    // Joining the old space again is an ordinary join (its log is still empty here).
    expect(await planJoin(await target(a), a.context.api, keysA)).toMatchObject({ kind: "seed" })
    closeAll(devices)
  })
})

describe("armAndSeed", () => {
  it("arms capture and queues every synced row whole, with clocks from when the row changed", async () => {
    const { devices, a, target } = await unarmedPair()
    const deviceId = (await a.keys()).deviceId
    await a.db.sessions.bulkPut([
      session("s1", { pinned: true }),
      session("s2", { updatedAt: undefined }),
    ])
    await a.db.characters.put({ id: "c0", name: "Default", isBuiltIn: true } as never)
    await a.db.settings.put({
      id: "singleton",
      profile: { displayName: "Ada" },
      updatedAt: 3_000,
    } as never)
    expect(await a.db.accountSyncOutbox.count()).toBe(0)

    const progress: string[] = []
    await armAndSeed(await target(a), (step) =>
      progress.push(`${step.table}:${step.done}/${step.total}`)
    )

    expect(
      isArmedFor(
        (await a.db.accountSyncState.get("capture")) as AccountSyncCaptureState,
        TEST_SPACE,
        deviceId
      )
    ).toBe(true)
    expect(await a.db.syncFieldClocks.get(["sessions", "s1"])).toMatchObject({
      fields: {
        title: encodeHlc({ ms: 2_000, c: 0, deviceId }),
        pinned: encodeHlc({ ms: 2_000, c: 0, deviceId }),
      },
    })
    expect((await a.db.syncFieldClocks.get(["sessions", "s2"]))!.fields.title).toBe(
      encodeHlc({ ms: 1_000, c: 0, deviceId })
    )
    expect(await a.db.syncFieldClocks.get(["characters", "c0"])).toBeUndefined()
    expect(await a.db.accountSyncOutbox.get(["sessions", "s1"])).toMatchObject({
      resend: true,
      fields: [],
      mutationId: expect.any(String),
    })
    expect(await a.db.accountSyncOutbox.get(["settings", "profile"])).toMatchObject({
      fields: ["value"],
      mutationId: expect.any(String),
    })
    expect((await a.db.syncFieldClocks.get(["settings", "profile"]))!.fields.value).toBe(
      encodeHlc({ ms: 3_000, c: 0, deviceId })
    )
    expect(progress).toContain("sessions:2/2")
    expect(progress.at(-1)).toBe("settings:1/1")

    // Armed: a later write is captured as usual.
    await a.db.sessions.update("s1", { title: "Edited" })
    expect((await a.db.syncFieldClocks.get(["sessions", "s1"]))!.fields.title).not.toBe(
      encodeHlc({ ms: 2_000, c: 0, deviceId })
    )
    closeAll(devices)
  })

  it("keeps clocks a capture already wrote, and starts the cursor over for a new device id", async () => {
    const { devices, a, target } = await unarmedPair()
    const deviceId = (await a.keys()).deviceId
    const real = encodeHlc({ ms: 9_000, c: 3, deviceId })
    await a.db.sessions.put(session("s1"))
    await a.db.syncFieldClocks.put({ table: "sessions", rowId: "s1", fields: { title: real } })
    await a.db.accountSyncState.bulkPut([
      {
        id: "capture",
        spaceId: TEST_SPACE,
        deviceId: "dev_old",
        classes: { content: false, settings: true },
        hlc: { ms: 9_000, c: 3 },
      },
      { id: "cursor", spaceId: TEST_SPACE, serverSeq: 40, deviceSeq: 12 },
    ] as never)
    await a.db.accountSyncInbox.put({ serverSeq: 7, op: {} as never, reason: "key", receivedAt: 1 })

    await armAndSeed(await target(a))
    expect((await a.db.syncFieldClocks.get(["sessions", "s1"]))!.fields.title).toBe(real)
    const state = (await a.db.accountSyncState.get("capture")) as AccountSyncCaptureState
    // The person's class choice and the clock survive re-arming.
    expect(state).toMatchObject({ deviceId, classes: { content: false }, hlc: { ms: 9_000, c: 3 } })
    expect((await a.db.accountSyncState.get("cursor")) as AccountSyncCursorState).toMatchObject({
      serverSeq: 0,
      deviceSeq: 0,
    })
    expect(await a.db.accountSyncInbox.count()).toBe(0)
    closeAll(devices)
  })
})

describe("joinWithChoice", () => {
  async function accountWithData() {
    const pair = await unarmedPair()
    const { a, target } = pair
    await a.db.sessions.put(session("shared", { title: "From A", updatedAt: 5_000 }))
    await a.db.sessions.put(session("only-a"))
    await armAndSeed(await target(a))
    await a.round()
    return pair
  }

  it("merges: backs up first, then both devices hold both sides, newer fields winning", async () => {
    const { devices, b, target } = await accountWithData()
    await b.db.sessions.put(session("shared", { title: "From B", pinned: true, updatedAt: 4_000 }))
    await b.db.sessions.put(session("only-b"))
    const order: string[] = []
    await joinWithChoice(await target(b), "merge", {
      backup: async () => {
        order.push(`backup:${await b.db.accountSyncOutbox.count()}`)
      },
    })
    order.push(`seeded:${await b.db.accountSyncOutbox.count()}`)
    expect(order).toEqual(["backup:0", "seeded:2"])
    await settleAll(devices)

    for (const device of devices) {
      expect((await device.db.sessions.toArray()).map((row) => row.id).sort()).toEqual([
        "only-a",
        "only-b",
        "shared",
      ])
      expect(await device.db.sessions.get("shared")).toMatchObject({
        title: "From A",
        pinned: true,
      })
    }
    closeAll(devices)
  })

  it("replaces: removes this device's synced rows, keeps built-ins, and takes the account's", async () => {
    const { devices, b, target } = await accountWithData()
    await b.db.sessions.put(session("only-b"))
    await b.db.characters.put({ id: "c0", name: "Default", isBuiltIn: true } as never)
    await b.db.settings.put({ id: "singleton", profile: { displayName: "B" } } as never)
    let backedUp = false
    await joinWithChoice(await target(b), "replace", {
      backup: async () => {
        backedUp = true
      },
    })
    expect(backedUp).toBe(true)
    expect(await b.db.sessions.get("only-b")).toBeUndefined()
    expect(await b.db.characters.get("c0")).toMatchObject({ name: "Default" })
    // Settings keep their value until the account's arrives.
    expect(
      ((await b.db.settings.get("singleton")) as never as { profile: unknown }).profile
    ).toEqual({
      displayName: "B",
    })
    expect(await b.db.syncFieldClocks.count()).toBe(0)

    await settleAll(devices)
    expect((await b.db.sessions.toArray()).map((row) => row.id).sort()).toEqual([
      "only-a",
      "shared",
    ])
    closeAll(devices)
  })

  it("changes nothing when the backup fails", async () => {
    const { devices, b, target } = await accountWithData()
    await b.db.sessions.put(session("only-b"))
    await expect(
      joinWithChoice(await target(b), "replace", {
        backup: async () => {
          throw new Error("disk full")
        },
      })
    ).rejects.toThrow("disk full")
    expect(await b.db.sessions.get("only-b")).toBeDefined()
    expect(await b.db.accountSyncState.get("capture")).toBeUndefined()
    closeAll(devices)
  })

  it("replace on an armed database clears what was queued", async () => {
    const { devices, a, target } = await accountWithData()
    await a.db.sessions.put(session("queued"))
    expect(await a.db.accountSyncOutbox.count()).toBe(1)
    await replaceWithAccount(await target(a))
    expect(await a.db.accountSyncOutbox.count()).toBe(0)
    expect(await a.db.sessions.count()).toBe(0)
    closeAll(devices)
  })
})

describe("summarizeLocalData and disarm", () => {
  it("counts synced rows only, and a disarmed database captures nothing", async () => {
    const { devices, a } = await unarmedPair()
    await a.db.memories.bulkPut([
      { id: "m1", text: "Global", tags: [] },
      { id: "m2", text: "In a project", tags: [], projectId: "p1" },
    ] as never)
    await a.db.settings.put({
      id: "singleton",
      profile: { displayName: "Ada" },
      // Every save writes defaults too; they are not data this device holds.
      theme: "system",
      fontScale: "md",
    } as never)
    const summary = await summarizeLocalData(a.db)
    expect(summary.counts).toMatchObject({ memories: 1, settings: 1, sessions: 0 })
    // A setting of its own is held data, so a join asks (with a backup).
    expect(summary.total).toBe(2)
    expect(await a.db.accountSyncOutbox.count()).toBe(0)
    closeAll(devices)
  })
})

describe("joining with settings", () => {
  it("lets the account's theme land on a device whose row only holds defaults", async () => {
    // The device picked a microphone (device-local) before joining; the save
    // wrote the whole row, defaults included, with a fresh time. Seeding every
    // key with that time turned the account's dark theme into "system" on
    // every device.
    const { devices, a, b, target } = await unarmedPair()
    await a.db.settings.put({ id: "singleton", theme: "dark" } as never)
    await armAndSeed(await target(a))
    expect((await a.round({ pushOnly: true })).pushed).toBe(1)
    await b.db.settings.put({
      id: "singleton",
      theme: "system",
      fontScale: "md",
      selectedMicId: "local-mic",
      updatedAt: Date.now() + 60_000,
    } as never)
    const keys = await b.keys()
    expect(await planJoin(await target(b), b.context.api, keys)).toMatchObject({ kind: "seed" })
    await armAndSeed(await target(b))
    expect(await b.db.accountSyncOutbox.count()).toBe(0)
    await settleAll(devices)
    expect((await a.db.settings.get("singleton"))?.theme).toBe("dark")
    expect((await b.db.settings.get("singleton"))?.theme).toBe("dark")
    expect((await b.db.settings.get("singleton"))?.selectedMicId).toBe("local-mic")
    closeAll(devices)
  })

  it("asks when this device set a shared setting of its own and the account holds data", async () => {
    const { devices, a, b, target } = await unarmedPair()
    await a.db.settings.put({ id: "singleton", theme: "dark" } as never)
    await armAndSeed(await target(a))
    await a.round({ pushOnly: true })
    await b.db.settings.put({ id: "singleton", theme: "light" } as never)
    expect(await planJoin(await target(b), b.context.api, await b.keys())).toMatchObject({
      kind: "ask",
      question: "both-hold-data",
      local: { counts: { settings: 1 }, total: 1 },
    })
    closeAll(devices)
  })
})

describe("an interrupted seed", () => {
  it("resumes on the next start instead of leaving rows it had not reached unsent", async () => {
    const { devices, a, b, target } = await unarmedPair()
    await a.db.settings.put({ id: "singleton", theme: "dark" } as never)
    await a.db.sessions.put(session("s-before-join"))
    const join = await target(a)
    const keys = await a.keys()
    await expect(
      armAndSeed(join, ({ table }) => {
        if (table === "sessions") throw new Error("interrupted between seed pages")
      })
    ).rejects.toThrow("interrupted between seed pages")
    // Armed (writes are captured from here on) but the seed is still owed.
    expect(await planJoin(join, a.context.api, keys)).toMatchObject({ kind: "seed" })
    await armAndSeed(join)
    expect(await planJoin(join, a.context.api, keys)).toEqual({ kind: "armed" })
    await settleAll(devices)
    expect(await b.db.sessions.get("s-before-join")).toBeDefined()
    expect((await b.db.settings.get("singleton"))?.theme).toBe("dark")
    closeAll(devices)
  })
})
