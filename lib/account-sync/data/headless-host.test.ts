import "fake-indexeddb/auto"

import { CogniaDB } from "@/lib/db/schema"

import { commitFirstDevice, prepareFirstDevice } from "../enrollment/first-device"
import { revokeDevice } from "../enrollment/manage"
import { recoverWithKey } from "../enrollment/recover"
import { createFakeSyncServer } from "../testing/fake-sync-server"
import { runSyncRound } from "./sync-round"
import { TEST_SPACE } from "../enrollment/test-support"
import type { SyncSession } from "../sync-session"
import { createMemoryKeyring } from "../testing/memory-keyring"
import { __clearAccountSyncKeyCache } from "../vault-store"
import {
  headlessSyncContext,
  readDataChoice,
  saveDataChoice,
  startHeadlessAccountSync,
  type HeadlessAccountSync,
} from "./headless-host"
import { closeAll, syncedDevices, type SyncDevice } from "./test-support"

beforeEach(() => __clearAccountSyncKeyCache())

const FAST = {
  pushDebounceMs: 5,
  pushMaxDelayMs: 40,
  pingMs: 1_000,
  longPollWaitS: 1,
  retryMs: () => 20,
}
const HOST_ACCOUNT = "local_acct_brain"

const session: SyncSession = {
  localAccountId: HOST_ACCOUNT,
  issuer: "https://id.test/api/auth",
  userId: "usr_person",
  spaceId: TEST_SPACE,
  syncUrl: "https://sync.test",
  accessToken: async () => "token",
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let databases = 0

async function setup() {
  const { server, devices, recoveryKeyText } = await syncedDevices(["a"])
  const a = devices[0] as SyncDevice
  const keyring = createMemoryKeyring()
  const db = new CogniaDB(`account-sync-headless-${++databases}`, "account-sync-test")
  await db.open()
  const logs: string[] = []
  let signedIn: SyncSession | null = session
  const backup = jest.fn(async () => undefined)
  let sync: HeadlessAccountSync | null = null
  const begin = () => {
    sync = startHeadlessAccountSync({
      host: { session: async () => signedIn, keyring, backup },
      db: () => db,
      log: (_level, message) => logs.push(message),
      pollMs: 60_000,
      fetchImpl: server.fetch,
      engineDeps: { openSocket: null, delays: FAST },
    })
    return sync
  }
  const enroll = () =>
    recoverWithKey(headlessSyncContext(session, keyring, server.fetch), recoveryKeyText, {
      name: "Server",
      platform: "desktop",
    })
  return {
    server,
    a,
    keyring,
    db,
    logs,
    backup,
    begin,
    enroll,
    signOut: () => {
      signedIn = null
    },
    finish: () => {
      sync?.stop()
      db.close()
      closeAll(devices)
    },
  }
}

describe("startHeadlessAccountSync", () => {
  it("says what to run while the host is signed out or not enrolled", async () => {
    const h = await setup()
    h.signOut()
    const sync = h.begin()
    await sync.check()
    expect(h.logs.at(-1)).toMatch(/not signed in; run `cognia-agent logto login`/)
    h.finish()

    const enrolled = await setup()
    const second = enrolled.begin()
    await second.check()
    expect(enrolled.logs.at(-1)).toMatch(/not enrolled; run `cognia-agent account-sync status`/)
    expect(await enrolled.db.accountSyncState.get("capture")).toBeUndefined()
    enrolled.finish()
  })

  it("syncs once the commands enrolled the host, and stops when it is removed", async () => {
    const h = await setup()
    const sync = h.begin()
    await sync.check()
    await h.enroll()
    await sync.check()
    await until(() => h.logs.some((line) => line.includes("syncing (poll)")))

    await h.a.db.sessions.put({ id: "s1", title: "From A", createdAt: 1, updatedAt: 1 } as never)
    await h.a.round()
    await until(async () => (await h.db.sessions.get("s1")) !== undefined)

    const hostId = (await headlessSyncContext(
      session,
      h.keyring,
      h.server.fetch
    ).vault.loadDeviceKeys())!.deviceId
    await revokeDevice(h.a.context, await h.a.keys(), hostId)
    await until(() => h.logs.some((line) => line.includes("removed from sync")))
    expect(await h.db.accountSyncState.get("capture")).toBeUndefined()
    h.finish()
  })

  it("joins with the choice given from the terminal, after a backup", async () => {
    const h = await setup()
    await h.a.db.sessions.put({ id: "from-a", title: "A", createdAt: 1, updatedAt: 1 } as never)
    await h.a.round()
    await h.db.sessions.put({ id: "from-host", title: "Host", createdAt: 1, updatedAt: 1 } as never)
    await h.enroll()
    const sync = h.begin()
    await sync.check()
    await until(() => h.logs.some((line) => line.includes("account-sync data --merge")))
    expect(h.backup).not.toHaveBeenCalled()

    const scope = { localAccountId: HOST_ACCOUNT, spaceId: TEST_SPACE }
    await saveDataChoice(h.keyring, scope, "merge")
    expect(await readDataChoice(h.keyring, scope)).toBe("merge")
    await sync.check()
    await until(async () => (await h.db.sessions.get("from-a")) !== undefined)
    expect(h.backup).toHaveBeenCalledTimes(1)
    expect(await readDataChoice(h.keyring, scope)).toBeNull()
    await until(async () => {
      await h.a.round()
      return (await h.a.db.sessions.get("from-host")) !== undefined
    })
    h.finish()
  })
})

describe("a sign-in as someone else on the same host", () => {
  it("sends nothing to the new person's space until the person chooses, then backs up first", async () => {
    const spaceA = "a".repeat(43)
    const spaceB = "b".repeat(43)
    const personA: SyncSession = {
      ...session,
      userId: "usr_a",
      spaceId: spaceA,
      accessToken: async () => "token-a",
    }
    const personB: SyncSession = {
      ...session,
      userId: "usr_b",
      spaceId: spaceB,
      accessToken: async () => "token-b",
    }
    const serverA = createFakeSyncServer({ spaceId: spaceA })
    const serverB = createFakeSyncServer({ spaceId: spaceB })
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const auth = request.headers.get("authorization")
      if (auth === "Bearer token-a") return serverA.fetch(request)
      if (auth === "Bearer token-b") return serverB.fetch(request)
      throw new Error(`unexpected authorization ${auth}`)
    }
    const keyring = createMemoryKeyring()
    const contextA = headlessSyncContext(personA, keyring, fetchImpl)
    await commitFirstDevice(
      contextA,
      await prepareFirstDevice(contextA, { name: "Host", platform: "desktop" })
    )

    const db = new CogniaDB(`account-sync-headless-${++databases}`, "account-sync-test")
    await db.open()
    await db.sessions.put({
      id: "a-row",
      title: "Written as A",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    let signedIn: SyncSession = personA
    const logs: string[] = []
    const backup = jest.fn(async () => undefined)
    const sync = startHeadlessAccountSync({
      host: { session: async () => signedIn, keyring, backup },
      db: () => db,
      log: (_level, message) => logs.push(message),
      pollMs: 60_000,
      fetchImpl,
      engineDeps: { openSocket: null, delays: FAST },
    })
    const receiverDb = new CogniaDB(`account-sync-headless-${++databases}`, "account-sync-test")
    await receiverDb.open()
    try {
      await sync.check()
      await until(() => serverA.batches.length > 0)

      // `logto login` as B; B's space is enrolled, with an empty log.
      signedIn = personB
      const contextB = headlessSyncContext(personB, keyring, fetchImpl)
      const prepared = await prepareFirstDevice(contextB, { name: "Host", platform: "desktop" })
      await commitFirstDevice(contextB, prepared)
      const receiver = headlessSyncContext(
        { ...personB, localAccountId: "local_acct_receiver" },
        createMemoryKeyring(),
        fetchImpl
      )
      await recoverWithKey(receiver, prepared.recoveryKeyText, {
        name: "B's phone",
        platform: "desktop",
      })

      await sync.check()
      await until(() => logs.some((line) => line.includes("different Cognia account")))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(serverB.batches).toHaveLength(0)
      expect(backup).not.toHaveBeenCalled()

      // B chooses to keep only B's data: backed up first, and A's row never reaches B.
      await saveDataChoice(keyring, { localAccountId: HOST_ACCOUNT, spaceId: spaceB }, "replace")
      await sync.check()
      await until(async () => (await db.sessions.get("a-row")) === undefined)
      expect(backup).toHaveBeenCalledTimes(1)
      await runSyncRound(
        {
          db: receiverDb,
          api: receiver.api,
          vault: receiver.vault,
          spaceId: spaceB,
          now: receiver.now,
        },
        (await receiver.vault.loadDeviceKeys())!
      )
      expect(await receiverDb.sessions.get("a-row")).toBeUndefined()
    } finally {
      sync.stop()
      receiverDb.close()
      db.close()
    }
  }, 20_000)
})

describe("data choice", () => {
  it("keeps only merge or replace, and clears", async () => {
    const keyring = createMemoryKeyring()
    const scope = { localAccountId: "x", spaceId: "y" }
    expect(await readDataChoice(keyring, scope)).toBeNull()
    await keyring.save("x:y:data-choice", "bogus")
    expect(await readDataChoice(keyring, scope)).toBeNull()
    await saveDataChoice(keyring, scope, "replace")
    expect(await readDataChoice(keyring, scope)).toBe("replace")
    await saveDataChoice(keyring, scope, null)
    expect(await readDataChoice(keyring, scope)).toBeNull()
  })
})
