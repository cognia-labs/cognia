import {
  cleanupCategories,
  clearCategory,
  deepCleanup,
  previewCleanup,
  quickCleanup,
  selectableCategories,
  getCleanupCategoryAvailability,
  getCleanupTargetKey,
  __TESTING__,
} from "./cleanup"
import { appendBackupHistory } from "@/lib/db/backup-history"
import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { RuntimeTargetRegistry } from "@/lib/runtime/target-registry"
import { AccountContentCipher, activateAccountContentCipher } from "@/lib/accounts/content-cipher"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { getNotificationIdentity } from "@/lib/notifications/identity-cache"
import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { saveSettings } from "@/lib/db/settings"
import { installHostStateSync } from "@/lib/sync/host-state-service"
import { hostStateDigest, sessionIndexChannel } from "@cognia/agent-config-types/host-state"
import type { Transport } from "@/lib/tauri/transport-types"
import { releaseSubjectPortLeases } from "@/lib/task-workspace/client"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import {
  setRuntimeSnapshot,
  __resetRuntimeSnapshotForTesting,
} from "@/lib/runtime/runtime-snapshot-store"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
jest.mock("dexie", () => {
  // Node WebCrypto and Jest async callbacks have different Promise realms.
  // Let Dexie detect the callbacks' realm; the cipher still uses real crypto.
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  const probe = jest
    .spyOn(crypto.subtle, "digest")
    .mockImplementation((...args) => Promise.resolve(digest(...args)))
  try {
    return jest.requireActual("dexie")
  } finally {
    probe.mockRestore()
  }
})
jest.mock("@/lib/tauri/transport-companion", () => ({
  ...jest.requireActual("@/lib/tauri/transport-companion"),
  loadCompanionConfig: jest.fn(() => null),
}))
jest.mock("@/lib/notifications/identity-cache", () => ({
  ...jest.requireActual("@/lib/notifications/identity-cache"),
  getNotificationIdentity: jest.fn(
    jest.requireActual("@/lib/notifications/identity-cache").getNotificationIdentity
  ),
}))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
  isCapacitor: jest.fn(() => false),
}))
jest.mock("@/lib/task-workspace/client", () => ({
  ...jest.requireActual("@/lib/task-workspace/client"),
  releaseSubjectPortLeases: jest.fn(async () => undefined),
}))
jest.mock("@/lib/task-workspace/user-action", () => ({
  ...jest.requireActual("@/lib/task-workspace/user-action"),
  runWorkspaceUserAction: jest.fn((_command, operation) => operation()),
}))

const dbFixture = createDbTestFixture()

beforeAll(async () => {
  await dbFixture.initialize()
})
beforeEach(async () => {
  jest.mocked(loadCompanionConfig).mockReturnValue(null)
  __resetRuntimeSnapshotForTesting()
  jest.mocked(isTauri).mockReturnValue(false)
  jest.mocked(isCapacitor).mockReturnValue(false)
  jest.mocked(releaseSubjectPortLeases).mockClear()
  useRemoteHostStore.setState({ activeHostId: null })
  await dbFixture.restore()
})

async function seedHistory(rows: number, baseAt = Date.now()) {
  for (let i = 0; i < rows; i += 1) {
    await appendBackupHistory({
      completedAt: baseAt - i * 1000,
      type: "manual",
      success: true,
      encryption: "none",
      filename: `f${i}.cbk`,
    })
  }
}

afterAll(dbFixture.dispose)

describe("base-account row ownership", () => {
  it.each(["sessions", "messages"] as const)(
    "revalidates new Host ownership before deleting %s",
    async (tableName) => {
      jest.mocked(isTauri).mockReturnValue(true)
      const accountId = "storage-owner-race"
      activateAccountDatabase(accountId)
      setActiveRuntimeTargetContext(accountId, "local-host")
      const db = getDb()
      activateAccountContentCipher(await AccountContentCipher.createForTesting(accountId, db.name))
      await db.sessions.put({ id: "new-mirror" } as never)
      await db.messages.put({
        id: "new-mirror-message",
        sessionId: "new-mirror",
        parts: [],
      } as never)
      const table = db.tables.find((entry) => entry.name === tableName)!
      const original = table.toArray.bind(table)
      const read = jest.spyOn(table, "toArray")
      // Change ownership after the candidate scan, before deletion revalidates it.
      read.mockImplementationOnce(() =>
        original().then((rows) =>
          db.sessions.update("new-mirror", { programmaticCreator: "host-state" }).then(() => rows)
        )
      )
      try {
        const result = await cleanupCategories({
          categories: [tableName === "sessions" ? "session" : "chat"],
        })
        expect(result.deletedItems).toBe(0)
        if (tableName === "sessions")
          expect(result.errors).toEqual([expect.stringContaining("ownership changed")])
        else expect(result.errors).toEqual([])
        expect(await db.sessions.get("new-mirror")).toBeDefined()
        expect(await db.messages.get("new-mirror-message")).toBeDefined()
        expect(await db.syncTombstones.get(["sessions", "new-mirror"])).toBeUndefined()
        expect(await db.syncTombstones.get(["messages", "new-mirror-message"])).toBeUndefined()
        expect(releaseSubjectPortLeases).not.toHaveBeenCalled()
      } finally {
        read.mockRestore()
        await db.delete()
        clearAccountDatabaseSelection()
        clearActiveRuntimeTargetContext()
      }
    }
  )

  it.each([true, false])(
    "keeps HostState mirrors with remote Host selected: %s",
    async (selected) => {
      jest.mocked(isTauri).mockReturnValue(true)
      const accountId = "storage-native-mixed"
      activateAccountDatabase(accountId)
      setActiveRuntimeTargetContext(accountId, "local-host")
      const db = getDb()
      activateAccountContentCipher(await AccountContentCipher.createForTesting(accountId, db.name))
      const runtimeTargetId = "remote-reviewer"
      const channel = sessionIndexChannel(runtimeTargetId)
      const state = {
        kind: "session-index" as const,
        channel,
        revision: 1,
        sessions: ["mirrored", "existing-bound"].map((sessionId) => ({
          sessionId,
          title: "Remote",
          transcriptRevision: 0,
          conversation: "present" as const,
          turn: "idle" as const,
          revision: 1,
        })),
      }
      const transport: Transport = {
        subscribe: () => () => undefined,
        call: async (command) =>
          (command === "host_state_status"
            ? {
                hostId: runtimeTargetId,
                hostGeneration: 1,
                hostSeq: 1,
                leaseExpiresAt: 10000,
                pendingDispatch: 0,
                pendingBroadcast: 0,
                recovery: "ready",
              }
            : {
                channel,
                hostId: runtimeTargetId,
                hostGeneration: 1,
                cutHostSeq: 1,
                revision: 1,
                digest: hostStateDigest(state),
                state,
              }) as never,
      }
      let sync: Awaited<ReturnType<typeof installHostStateSync>> | undefined
      try {
        await db.sessions.put({ id: "existing-bound" } as never)
        sync = await installHostStateSync({
          transport,
          accountId,
          runtimeTargetId,
          channels: async () => [channel],
        })
        expect((await db.sessions.get("mirrored"))?.programmaticCreator).toBe("host-state")
        expect((await db.sessions.get("existing-bound"))?.programmaticCreator).toBeUndefined()
        sync.stop()
        useRemoteHostStore.setState({ activeHostId: selected ? runtimeTargetId : null })
        await db.sessions.bulkPut([
          { id: "genuinely-local", createdAt: 1 },
          {
            id: "host-child",
            parentSessionId: "mirrored",
            attachedChild: { parentSessionId: "mirrored", lifecycleOwnerSessionId: "mirrored" },
          },
          { id: "host-sidechat", surfaceBindingKey: "session:mirrored" },
        ] as never)
        await db.messages.bulkPut([
          { id: "mirror-message", sessionId: "mirrored", parts: [] },
          { id: "local-message", sessionId: "genuinely-local", parts: [] },
          { id: "child-message", sessionId: "host-child", parts: [] },
          { id: "side-message", sessionId: "host-sidechat", parts: [] },
        ] as never)
        await db.chatGoals.put({ id: "mirror-goal", sessionId: "mirrored" } as never)
        await db.chatGoalEvents.put({ id: "mirror-goal-event", goalId: "mirror-goal" } as never)
        await db.sessionPeerMessages.put({
          id: "cross-peer",
          senderSessionId: "genuinely-local",
          receiverSessionId: "mirrored",
        } as never)
        await db.skills.put({ id: "unmarked-source" } as never)
        const options = { categories: ["session", "chat"] as const }
        const preview = await previewCleanup({ categories: [...options.categories] })
        expect(preview.deletedItems).toBe(2)
        const result = await cleanupCategories({ categories: [...options.categories] })
        expect(result.errors).toEqual([])
        expect(result.deletedItems).toBe(preview.deletedItems)
        expect(await db.sessions.get("mirrored")).toBeDefined()
        for (const id of ["existing-bound", "host-child", "host-sidechat"])
          expect(await db.sessions.get(id)).toBeDefined()
        expect(await db.messages.get("mirror-message")).toBeDefined()
        for (const id of ["child-message", "side-message"])
          expect(await db.messages.get(id)).toBeDefined()
        expect(await db.chatGoals.get("mirror-goal")).toBeDefined()
        expect(await db.chatGoalEvents.get("mirror-goal-event")).toBeDefined()
        expect(await db.sessionPeerMessages.get("cross-peer")).toBeDefined()
        expect(await db.sessions.get("genuinely-local")).toBeUndefined()
        expect(await db.messages.get("local-message")).toBeUndefined()
        expect(await db.syncTombstones.get(["sessions", "mirrored"])).toBeUndefined()
        expect(await db.syncTombstones.get(["messages", "mirror-message"])).toBeUndefined()
        expect(jest.mocked(releaseSubjectPortLeases).mock.calls).toEqual([
          [{ kind: "desktop-session", key: "genuinely-local" }],
        ])
        expect(await db.hostStateChannels.get(channel)).toBeDefined()
        expect((await cleanupCategories({ categories: ["skill"] })).deletedItems).toBe(0)
        expect(await db.skills.get("unmarked-source")).toBeDefined()
      } finally {
        sync?.stop()
        useRemoteHostStore.setState({ activeHostId: null })
        await db.delete()
        clearAccountDatabaseSelection()
        clearActiveRuntimeTargetContext()
      }
    }
  )

  it.each([true, false])(
    "cleans standalone Capacitor history only with persisted mode: %s",
    async (persisted) => {
      jest.mocked(isCapacitor).mockReturnValue(true)
      const accountId = "storage-capacitor-base"
      activateAccountDatabase(accountId)
      setActiveRuntimeTargetContext(accountId, "mobile-companion")
      const db = getDb()
      activateAccountContentCipher(await AccountContentCipher.createForTesting(accountId, db.name))
      try {
        if (persisted)
          await saveSettings({ mobileRuntimeMode: "standalone" }, { mirrorToHost: false })
        await db.sessions.put({ id: "mobile-local" } as never)
        await db.messages.put({
          id: "mobile-message",
          sessionId: "mobile-local",
          parts: [],
        } as never)
        const result = await cleanupCategories({ categories: ["session", "chat"] })
        expect(result.errors).toEqual([])
        expect(result.deletedItems).toBe(persisted ? 2 : 0)
        expect(Boolean(await db.sessions.get("mobile-local"))).toBe(!persisted)
        expect(Boolean(await db.messages.get("mobile-message"))).toBe(!persisted)
      } finally {
        await db.delete()
        clearAccountDatabaseSelection()
        clearActiveRuntimeTargetContext()
      }
    }
  )
})

describe("persisted database ownership", () => {
  it.each(["companion", "standalone"] as const)(
    "uses the persisted %s kind when execution routing disagrees",
    async (kind) => {
      const registry = new RuntimeTargetRegistry()
      const accountId = "storage-ownership"
      const id = `storage-${kind}`
      await registry.addTarget({
        accountId,
        id,
        kind,
        label: id,
        ...(kind === "companion" ? { hostKind: "desktop" as const } : {}),
      })
      await registry.activateTarget(accountId, id)
      activateAccountDatabase(accountId, id)
      setActiveRuntimeTargetContext(accountId, id)
      activateAccountContentCipher(
        await AccountContentCipher.createForTesting(accountId, getDb().name)
      )
      // Lost pairing on cold boot versus a server-URL build's companion executor.
      setRuntimeSnapshot({
        target:
          kind === "companion"
            ? { id, kind: "standalone", platform: "web" }
            : { id, kind: "companion", platform: "web", hostKind: "cloud" },
        vaultState: "unlocked",
        connectionState: "offline",
      })
      jest
        .mocked(loadCompanionConfig)
        .mockReturnValue(
          kind === "companion" ? null : ({ deviceId: "server-url", targetId: id } as never)
        )
      try {
        const db = getDb()
        await db.skills.put({ id: "ownership-skill", createdAt: 1 } as never)
        await db.sessions.put({ id: "ownership-session", createdAt: 1 } as never)
        await seedHistory(1)
        const result = await cleanupCategories({
          categories: ["skill", "session", "backupHistory"],
        })
        expect(result.errors).toEqual([])
        expect(await db.backupHistory.count()).toBe(0)
        if (kind === "companion") {
          expect(await db.skills.get("ownership-skill")).toBeDefined()
          expect(await db.sessions.get("ownership-session")).toBeDefined()
        } else {
          expect(await db.skills.get("ownership-skill")).toBeUndefined()
          expect(await db.sessions.get("ownership-session")).toBeUndefined()
        }
      } finally {
        await getDb().delete()
        clearAccountDatabaseSelection()
        clearActiveRuntimeTargetContext()
        await registry.deleteActiveTarget(accountId, id)
        registry.close()
      }
    }
  )

  it("protects synced rows when the persisted owner is missing while cleaning local-only rows", async () => {
    const accountId = "storage-unknown"
    activateAccountDatabase(accountId, "host-missing")
    setActiveRuntimeTargetContext(accountId, "host-missing")
    const db = getDb()
    activateAccountContentCipher(await AccountContentCipher.createForTesting(accountId, db.name))
    try {
      await db.skills.put({ id: "unknown-skill", createdAt: 1 } as never)
      await db.sessions.put({ id: "unknown-session", createdAt: 1 } as never)
      await seedHistory(1)
      const result = await cleanupCategories({ categories: ["skill", "session", "backupHistory"] })
      expect(result.errors).toEqual([])
      expect(await db.skills.get("unknown-skill")).toBeDefined()
      expect(await db.sessions.get("unknown-session")).toBeDefined()
      expect(await db.backupHistory.count()).toBe(0)
    } finally {
      await db.delete()
      clearAccountDatabaseSelection()
      clearActiveRuntimeTargetContext()
    }
  })
})

describe("paired mirror cleanup policy", () => {
  it.each(["local-host", "mobile-companion"])(
    "keeps base-account cleanup available on the %s route",
    async (route) => {
      activateAccountDatabase("storage-native")
      setActiveRuntimeTargetContext("storage-native", route)
      try {
        await seedHistory(1)
        const targetKey = getCleanupTargetKey()
        expect(
          (await previewCleanup({ categories: ["backupHistory"], targetKey })).deletedItems
        ).toBe(1)
        const result = await cleanupCategories({ categories: ["backupHistory"], targetKey })
        expect(result.errors).toEqual([])
        expect(result.deletedItems).toBe(1)
      } finally {
        await getDb().delete()
        clearAccountDatabaseSelection()
        clearActiveRuntimeTargetContext()
      }
    }
  )

  it("returns an unknown render key without throwing and refuses an empty confirmation binding", async () => {
    await seedHistory(1)
    jest.mocked(getNotificationIdentity).mockImplementationOnce(() => {
      throw new Error("runtime identity unavailable")
    })
    expect(getCleanupTargetKey()).toBe("")
    const result = await cleanupCategories({ categories: ["backupHistory"], targetKey: "" })
    expect(result.errors).toEqual([expect.stringContaining("target changed")])
    expect(await getDb().backupHistory.count()).toBe(1)
  })
  it("protects an offline mirror before companion credentials hydrate", async () => {
    setRuntimeSnapshot({
      target: { id: "host", kind: "companion", platform: "web", hostKind: "desktop" },
      vaultState: "unlocked",
      connectionState: "offline",
    })
    await getDb().sessions.put({ id: "cold-host-session" } as never)
    expect((await cleanupCategories({ categories: ["session"] })).deletedItems).toBe(0)
    expect(await getDb().sessions.get("cold-host-session")).toBeDefined()
  })
  it("never previews or deletes mirrored tables through any cleanup entry point", async () => {
    jest
      .mocked(loadCompanionConfig)
      .mockReturnValue({ deviceId: "paired", targetId: "host" } as never)
    const db = getDb()
    await db.sessions.put({
      id: "host-session",
      createdAt: 1,
      deliverySourceHosts: [{ hostId: "host" }],
    } as never)
    await db.messages.put({ id: "host-message", sessionId: "host-session", createdAt: 1 } as never)
    await db.sessionState.put({ sessionId: "host-session", lastReadAt: 1 } as never)
    const read = jest.spyOn(db.sessions, "toArray")
    for (const run of [previewCleanup, cleanupCategories]) {
      const result = await run({ categories: ["session", "chat"] })
      expect(result.deletedItems).toBe(0)
      expect(result.errors).toEqual([])
    }
    await quickCleanup()
    await deepCleanup()
    expect(await clearCategory("session")).toBe(0)
    expect(read).not.toHaveBeenCalled()
    read.mockRestore()
    expect(await db.sessions.get("host-session")).toBeDefined()
    expect(await db.messages.get("host-message")).toBeDefined()
    expect(await db.sessionState.get("host-session")).toBeDefined()
    expect(await db.managedDesktopDeletionOutbox.count()).toBe(0)
  })

  it("cleans local-only history offline without starting sync or resetting cursors", async () => {
    jest
      .mocked(loadCompanionConfig)
      .mockReturnValue({ deviceId: "paired", targetId: "host" } as never)
    await seedHistory(1)
    await getDb().hostSyncCursors.put({
      serverKey: "host",
      table: "messages",
      since: 100,
      lastSyncAt: 1,
      lastError: null,
    })
    expect((await previewCleanup({ categories: ["backupHistory"] })).deletedItems).toBe(1)
    expect((await cleanupCategories({ categories: ["backupHistory"] })).errors).toEqual([])
    expect(await getDb().backupHistory.count()).toBe(0)
    expect((await getDb().hostSyncCursors.get(["host", "messages"]))?.since).toBe(100)
    expect(getCleanupCategoryAvailability("session", ["sessions"])).toBe("host-managed")
    expect(getCleanupCategoryAvailability("backupHistory")).toBe("cleanable")
  })

  it("allows same-pairing baseUrl metadata replacement while cleanup is running", async () => {
    const config = { deviceId: "paired", targetId: "host", baseUrl: "http://old" }
    jest.mocked(loadCompanionConfig).mockReturnValue(config as never)
    await seedHistory(1)
    const table = getDb().backupHistory
    const original = table.toArray.bind(table)
    const read = jest.spyOn(table, "toArray").mockImplementationOnce(() =>
      original().then((rows) => {
        jest
          .mocked(loadCompanionConfig)
          .mockReturnValue({ ...config, baseUrl: "http://new" } as never)
        return rows
      })
    )
    try {
      expect((await cleanupCategories({ categories: ["backupHistory"] })).errors).toEqual([])
    } finally {
      read.mockRestore()
    }
    expect(await getDb().backupHistory.count()).toBe(0)
  })

  it("refuses a confirmation captured before a target activation changed", async () => {
    await seedHistory(1)
    const targetKey = getCleanupTargetKey()
    setActiveRuntimeTargetContext("storage-binding", "host-other")
    const result = await cleanupCategories({ categories: ["backupHistory"], targetKey })
    expect(result.errors).toEqual([expect.stringContaining("target changed")])
    expect(await getDb().backupHistory.count()).toBe(1)
    clearActiveRuntimeTargetContext()
  })
})

describe("previewCleanup", () => {
  it("returns zeroes for an empty bucket", async () => {
    // backupHistory starts empty after a fresh seed.
    const result = await previewCleanup({ categories: ["backupHistory"] })
    expect(result.deletedItems).toBe(0)
    expect(result.freedSpace).toBe(0)
    expect(result.details).toEqual([])
  })

  it("counts rows in the requested category without writing", async () => {
    await seedHistory(3)
    const result = await previewCleanup({ categories: ["backupHistory"] })
    expect(result.deletedItems).toBe(3)
    expect(result.freedSpace).toBeGreaterThan(0)
    expect(await getDb().backupHistory.count()).toBe(3)
  })
})

describe("cleanupCategories", () => {
  it("treats an explicit empty selection as no work", async () => {
    await seedHistory(1)
    expect(await cleanupCategories({ categories: [] })).toEqual({
      deletedItems: 0,
      freedSpace: 0,
      details: [],
      errors: [],
    })
    expect(await getDb().backupHistory.count()).toBe(1)
  })

  it("reports no reclaimed rows or bytes for a rejected delete", async () => {
    await seedHistory(1)
    const table = getDb().tables.find((entry) => entry.name === "backupHistory")!
    const spy = jest.spyOn(table, "bulkDelete").mockRejectedValueOnce(new Error("rejected"))
    try {
      const result = await cleanupCategories({ categories: ["backupHistory"] })
      expect(result.deletedItems).toBe(0)
      expect(result.freedSpace).toBe(0)
      expect(result.errors).toEqual([expect.stringContaining("rejected")])
      expect(await getDb().backupHistory.count()).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("does not delete protected categories even when supplied directly", async () => {
    await getDb().petProfile.put({ id: "global" } as never)
    const result = await cleanupCategories({ categories: ["pet", "settings"] })
    expect(result.deletedItems).toBe(0)
    expect(await getDb().petProfile.get("global")).toBeDefined()
  })
  it("deletes rows in the requested category and returns a per-category detail", async () => {
    await seedHistory(2)
    const result = await cleanupCategories({ categories: ["backupHistory"] })
    expect(result.deletedItems).toBe(2)
    expect(result.details).toHaveLength(1)
    expect(result.details[0].category).toBe("backupHistory")
    expect(await getDb().backupHistory.count()).toBe(0)
  })

  it("respects olderThan and leaves newer rows alone", async () => {
    const now = 10_000
    await appendBackupHistory({
      completedAt: now - 5_000, // old
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: now + 5_000, // new
      type: "manual",
      success: true,
      encryption: "none",
    })
    const result = await cleanupCategories({
      categories: ["backupHistory"],
      olderThan: now,
    })
    expect(result.deletedItems).toBe(1)
    expect(await getDb().backupHistory.count()).toBe(1)
  })

  it("defaults to the selectable category set when none supplied", async () => {
    await seedHistory(2)
    const result = await cleanupCategories()
    // The default set excludes seed-driven buckets (characters/skills/teams),
    // so only the rows we just appended should be deleted. Asserting >= 2
    // keeps the test resilient to future selectableCategories tweaks while
    // still catching regressions that skip the explicit ones.
    expect(result.deletedItems).toBeGreaterThanOrEqual(2)
    expect(await getDb().backupHistory.count()).toBe(0)
  })
})

describe("clearCategory", () => {
  it("returns the count of rows deleted", async () => {
    await seedHistory(4)
    const deleted = await clearCategory("backupHistory")
    expect(deleted).toBe(4)
  })
})

describe("quickCleanup", () => {
  it("only touches transient buckets — leaves backup history alone", async () => {
    await seedHistory(3)
    const result = await quickCleanup()
    expect(result.errors).toEqual([])
    expect(await getDb().backupHistory.count()).toBe(3)
  })

  it("cleans governed cache tables in other without deleting authoritative other data", async () => {
    await getDb().chatSearchState.put({ id: "cache", sessionId: "s1" } as never)
    await getDb().chatGoals.put({
      id: "goal",
      sessionId: "s1",
      title: "keep",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    } as never)

    const result = await quickCleanup()

    expect(result.deletedItems).toBeGreaterThanOrEqual(1)
    expect(await getDb().chatSearchState.get("singleton")).toBeUndefined()
    expect(await getDb().chatGoals.get("goal")).toBeDefined()
  })
})

describe("deepCleanup", () => {
  it("drops backup history older than the 7-day window", async () => {
    const now = Date.now()
    await appendBackupHistory({
      completedAt: now - __TESTING__.DEEP_CLEANUP_AGE_MS - 1000,
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: now - 1000,
      type: "manual",
      success: true,
      encryption: "none",
    })
    const result = await deepCleanup()
    expect(result.deletedItems).toBeGreaterThanOrEqual(1)
    expect(await getDb().backupHistory.count()).toBe(1)
  })
})

describe("selectableCategories", () => {
  it("excludes settings + seed-driven categories", () => {
    const set = selectableCategories()
    expect(set).not.toContain("settings")
    expect(set).not.toContain("character")
    expect(set).toContain("backupHistory")
  })
})

describe("governed other table plan", () => {
  it("includes safe governed tables and excludes protected tables", () => {
    const names = __TESTING__.cleanupTableNames("other", ["agentTraces", "agentTasks", "chatGoals"])
    expect(names).toContain("agentTraces")
    expect(names).not.toContain("agentTasks")
    expect(names).not.toContain("chatGoals")
  })

  it("fails closed for an unknown runtime table", () => {
    expect(__TESTING__.cleanupTableNames("other", ["unknown-table"])).toEqual([])
  })

  it("does not infer generic deletion safety from a queue or audit-shaped name", () => {
    expect(
      __TESTING__.cleanupTableNames("other", ["agentTasks", "browserRecordings", "hostSyncCursors"])
    ).toEqual([])
  })

  it("fails closed for undated rows during age-based cleanup", () => {
    expect(__TESTING__.isEligibleForCleanup({ id: "undated" }, Date.now())).toBe(false)
    expect(__TESTING__.isEligibleForCleanup({ id: "trace", startTime: 10 }, 20)).toBe(true)
    expect(__TESTING__.isEligibleForCleanup({ id: "trace", startTime: 30 }, 20)).toBe(false)
  })
})

describe("rowSize fallback (cleanup.ts:32-33)", () => {
  it("returns 0 for a circular structure that JSON.stringify rejects", () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(__TESTING__.rowSize(cyclic)).toBe(0)
  })

  it("returns the JSON length for normal rows", () => {
    expect(__TESTING__.rowSize({ x: 1 })).toBe(JSON.stringify({ x: 1 }).length)
  })
})

describe("previewCleanup with olderThan filter", () => {
  it("only counts rows older than the cutoff (preview parity with cleanup)", async () => {
    const now = 100_000
    await appendBackupHistory({
      completedAt: now - 5_000, // old
      type: "manual",
      success: true,
      encryption: "none",
    })
    await appendBackupHistory({
      completedAt: now + 5_000, // new — must be skipped
      type: "manual",
      success: true,
      encryption: "none",
    })
    const result = await previewCleanup({
      categories: ["backupHistory"],
      olderThan: now,
    })
    expect(result.deletedItems).toBe(1)
    // Preview is non-destructive — both rows still in the table.
    expect(await getDb().backupHistory.count()).toBe(2)
  })
})

describe("category iteration robustness", () => {
  it("surfaces table.toArray() errors as result.errors entries", async () => {
    await seedHistory(2)
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory")
    if (!table) throw new Error("backupHistory table missing")
    const original = table.toArray.bind(table)
    const spy = jest
      .spyOn(table, "toArray")
      .mockRejectedValueOnce(new Error("simulated read failure"))

    const result = await cleanupCategories({ categories: ["backupHistory"] })
    expect(result.errors.some((e) => e.includes("simulated read failure"))).toBe(true)

    spy.mockRestore()
    void original
  })

  it("surfaces bulkDelete failures as result.errors entries", async () => {
    await seedHistory(2)
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory") as unknown as {
      bulkDelete: (ids: unknown[]) => Promise<unknown>
    }
    const spy = jest
      .spyOn(table, "bulkDelete")
      .mockRejectedValueOnce(new Error("simulated bulkDelete fail"))

    const result = await cleanupCategories({ categories: ["backupHistory"] })
    expect(result.errors.some((e) => e.includes("simulated bulkDelete fail"))).toBe(true)
    spy.mockRestore()
  })

  it("surfaces non-Error throws as String(err) entries", async () => {
    await seedHistory(1)
    const db = getDb()
    const table = db.tables.find((t) => t.name === "backupHistory") as unknown as {
      toArray: () => Promise<unknown[]>
    }
    const spy = jest.spyOn(table, "toArray").mockRejectedValueOnce("plain string failure")
    const result = await cleanupCategories({ categories: ["backupHistory"] })
    expect(result.errors.some((e) => e.includes("plain string failure"))).toBe(true)
    spy.mockRestore()
  })
})

describe("categories the Custom tab must not offer", () => {
  it("withholds every category whose tables it would delete wholesale", () => {
    // `cleanupTableNames` short-circuits for any non-`other` category, so an
    // offered category ignores `cleanupPolicy: "protected"` entirely. Offering
    // the pet would put "delete the pet you raised" behind a checkbox.
    for (const category of ["pet", "artifact", "character", "vector"] as const) {
      expect(selectableCategories()).not.toContain(category)
    }
  })

  it("still offers the ones that are safe to clear", () => {
    expect(selectableCategories()).toContain("session")
    expect(selectableCategories()).toContain("other")
  })
})

describe("row size estimation", () => {
  it("counts nested binary payloads by bytes", () => {
    expect(
      __TESTING__.rowSize({
        nested: [new Blob([new Uint8Array(4096)]), new ArrayBuffer(2048), new Uint16Array(512)],
      })
    ).toBeGreaterThanOrEqual(7168)
  })
  it("believes a row that declares its own byte count", () => {
    // JSON.stringify turns a Blob into `{}`, so the binaries a pet stores
    // measured about two bytes. The rows holding them record `totalBytes`.
    expect(__TESTING__.rowSize({ id: "a", totalBytes: 25 * 1024 * 1024 })).toBe(25 * 1024 * 1024)
  })

  it("ignores a nonsensical declared size and falls back", () => {
    expect(__TESTING__.rowSize({ id: "a", totalBytes: -1 })).toBeGreaterThan(0)
    expect(__TESTING__.rowSize({ id: "a", totalBytes: Number.NaN })).toBeGreaterThan(0)
    expect(__TESTING__.rowSize({ id: "a", totalBytes: "big" })).toBeGreaterThan(0)
  })
})

describe("cleanup ownership and target fences", () => {
  const accountId = "storage-cascade"
  const targetId = "web-standalone"
  let registry: RuntimeTargetRegistry
  beforeEach(async () => {
    registry = new RuntimeTargetRegistry()
    await registry.ensureStandaloneTarget(accountId)
    await registry.activateTarget(accountId, targetId)
    activateAccountDatabase(accountId, targetId)
    setActiveRuntimeTargetContext(accountId, targetId)
    activateAccountContentCipher(
      await AccountContentCipher.createForTesting(accountId, getDb().name)
    )
  })
  afterEach(async () => {
    activateAccountDatabase(accountId, targetId)
    await getDb().delete()
    clearAccountDatabaseSelection()
    clearActiveRuntimeTargetContext()
    await registry.deleteAccountTargets(accountId)
    registry.close()
  })
  it.each([["session"], ["session", "chat"], ["chat", "session"]] as const)(
    "previews the same session cascade including attached descendants: %j",
    async (...categories) => {
      const db = getDb()
      await db.sessions.bulkPut([
        { id: "root", createdAt: 1 },
        {
          id: "attached",
          parentSessionId: "root",
          createdAt: 1000,
          attachedChild: { parentSessionId: "root", lifecycleOwnerSessionId: "root" },
        },
        { id: "sidechat", surfaceBindingKey: "session:root", createdAt: 1000 },
        { id: "ordinary-branch", parentSessionId: "root", createdAt: 1000 },
      ] as never)
      await db.messages.bulkPut([
        { id: "root-message", sessionId: "root", createdAt: 1 },
        { id: "child-message", sessionId: "attached", createdAt: 1000 },
        { id: "side-message", sessionId: "sidechat", createdAt: 1000 },
      ] as never)
      const opts = { categories: [...categories], olderThan: 10 }
      const preview = await previewCleanup(opts)
      const deleted = await cleanupCategories(opts)
      expect(preview.errors).toEqual([])
      expect(deleted.errors).toEqual([])
      expect(preview.deletedItems).toBe(6)
      expect(deleted.deletedItems).toBe(preview.deletedItems)
      expect(deleted.freedSpace).toBe(preview.freedSpace)
      expect(await db.sessions.get("ordinary-branch")).toBeDefined()
    }
  )

  it("accounts plan and loop events by owner and peer rows once across both session indexes", async () => {
    const db = getDb()
    await db.sessions.put({ id: "candidate", createdAt: 1 } as never)
    await db.agentPlans.bulkPut([
      { id: "owned-plan", sessionId: "candidate" },
      { id: "other-plan", sessionId: "elsewhere" },
    ] as never)
    await db.agentPlanEvents.bulkPut([
      { id: "owned-plan-event", planId: "owned-plan" },
      { id: "other-plan-event", planId: "other-plan" },
    ] as never)
    await db.loops.bulkPut([
      { id: "owned-loop", sessionId: "candidate" },
      { id: "other-loop", sessionId: "elsewhere" },
    ] as never)
    await db.loopEvents.bulkPut([
      { id: "owned-loop-event", loopId: "owned-loop" },
      { id: "other-loop-event", loopId: "other-loop" },
    ] as never)
    await db.sessionPeerMessages.bulkPut([
      { id: "outgoing", senderSessionId: "candidate", receiverSessionId: "elsewhere" },
      { id: "incoming", senderSessionId: "elsewhere", receiverSessionId: "candidate" },
      { id: "both", senderSessionId: "candidate", receiverSessionId: "candidate" },
      {
        id: "unrelated",
        senderSessionId: "elsewhere",
        receiverSessionId: "elsewhere",
        createdAt: 1000,
      },
    ] as never)
    const result = await cleanupCategories({ categories: ["session"], olderThan: 10 })
    expect(result.errors).toEqual([])
    expect(result.deletedItems).toBe(8)
    expect(await db.agentPlanEvents.get("other-plan-event")).toBeDefined()
    expect(await db.loopEvents.get("other-loop-event")).toBeDefined()
    expect((await db.sessionPeerMessages.toArray()).map((row) => row.id)).toEqual(["unrelated"])
  })

  it("never reads another session's cascade rows into cleanup accounting", async () => {
    const db = getDb()
    await db.sessions.bulkPut([
      { id: "candidate", createdAt: 1 },
      { id: "survivor", createdAt: 1000 },
    ] as never)
    await db.messages.bulkPut([
      { id: "candidate-message", sessionId: "candidate" },
      { id: "survivor-message", sessionId: "survivor" },
    ] as never)
    await db.chatGoals.bulkPut([
      { id: "candidate-goal", sessionId: "candidate" },
      { id: "survivor-goal", sessionId: "survivor" },
    ] as never)
    await db.chatGoalEvents.bulkPut([
      { id: "candidate-event", goalId: "candidate-goal" },
      { id: "survivor-event", goalId: "survivor-goal" },
    ] as never)
    const readRows: string[] = []
    const read = (row: { id: string } | undefined) => {
      if (row) readRows.push(row.id)
      return row
    }
    db.messages.hook("reading", read)
    db.chatGoals.hook("reading", read)
    db.chatGoalEvents.hook("reading", read)
    try {
      const result = await cleanupCategories({ categories: ["session"], olderThan: 10 })
      expect(result.errors).toEqual([])
      expect(result.deletedItems).toBe(4)
      expect(readRows.filter((id) => id.startsWith("survivor"))).toEqual([])
      expect(readRows).toEqual(expect.arrayContaining(["candidate-message", "candidate-event"]))
    } finally {
      db.messages.hook("reading").unsubscribe(read)
      db.chatGoals.hook("reading").unsubscribe(read)
      db.chatGoalEvents.hook("reading").unsubscribe(read)
    }
    expect(await db.messages.get("survivor-message")).toBeDefined()
    expect(await db.chatGoalEvents.get("survivor-event")).toBeDefined()
  })

  it("deletes sessions with their canonical cascade and sync tombstones", async () => {
    const db = getDb()
    await db.sessions.put({ id: "owned-session", title: "Owned" } as never)
    await db.messages.put({ id: "owned-message", sessionId: "owned-session", parts: [] } as never)
    await db.chatGoals.put({ id: "owned-goal", sessionId: "owned-session" } as never)
    await db.sessionUsage.put({
      id: "owned-usage",
      sessionId: "owned-session",
      messageId: "owned-message",
    } as never)
    const result = await cleanupCategories({ categories: ["session"] })
    expect(result.errors).toEqual([])
    expect(await db.sessions.get("owned-session")).toBeUndefined()
    expect(await db.messages.get("owned-message")).toBeUndefined()
    expect(await db.chatGoals.get("owned-goal")).toBeUndefined()
    expect(await db.sessionUsage.where("sessionId").equals("owned-session").count()).toBe(0)
    for (const key of [
      ["sessions", "owned-session"],
      ["messages", "owned-message"],
      ["goals", "owned-goal"],
      ["sessionUsage", "owned-message"],
    ]) {
      expect(await db.syncTombstones.get(key)).toBeDefined()
    }
  })

  it("keeps Files owners and session-less jobs while tombstoning removed messages", async () => {
    const db = getDb()
    await db.messages.put({ id: "message", sessionId: "conversation", parts: [] } as never)
    await db.messageMediaRefs.bulkPut([
      { messageId: "library:pin", sessionId: "library:files", hash: "pin" },
      { messageId: "message", sessionId: "conversation", hash: "chat" },
    ])
    await db.mediaGenerationJobs.bulkPut([
      { id: "independent" },
      { id: "session-job", sessionId: "conversation" },
    ] as never)
    const preview = await previewCleanup({ categories: ["chat"] })
    const result = await cleanupCategories({ categories: ["chat"] })
    expect(result.errors).toEqual([])
    expect(result.deletedItems).toBe(preview.deletedItems)
    expect(await db.messageMediaRefs.get(["library:pin", "pin"])).toBeDefined()
    expect(await db.messageMediaRefs.get(["message", "chat"])).toBeUndefined()
    expect(await db.mediaGenerationJobs.get("independent")).toBeDefined()
    expect(await db.mediaGenerationJobs.get("session-job")).toBeUndefined()
    expect(await db.syncTombstones.get(["messages", "message"])).toBeDefined()
  })

  it("stops before the next category when the active database changes", async () => {
    const account = "cleanup-account",
      target = "cleanup-target"
    activateAccountDatabase(account, target)
    await getDb().backupHistory.put({ id: "other-target", completedAt: 1 } as never)
    clearAccountDatabaseSelection()
    const first = getDb()
    await first.backupHistory.put({ id: "first-target", completedAt: 1 } as never)
    const table = first.tables.find((entry) => entry.name === "backupHistory")!
    const original = table.bulkDelete.bind(table)
    const spy = jest.spyOn(table, "bulkDelete").mockImplementationOnce((keys) =>
      original(keys).then(() => {
        activateAccountDatabase(account, target)
      })
    )
    try {
      const result = await cleanupCategories({ categories: ["backupHistory", "chat"] })
      expect(result.errors.join(" ")).toMatch(/target changed/)
      expect(await getDb().backupHistory.get("other-target")).toBeDefined()
    } finally {
      spy.mockRestore()
      activateAccountDatabase(account, target)
      await getDb().delete()
      clearAccountDatabaseSelection()
    }
  })

  it("Deep cleanup keeps ordinary messages older than seven days", async () => {
    const db = getDb()
    await db.messages.put({
      id: "old-message",
      sessionId: "session",
      createdAt: 1,
      parts: [],
    } as never)
    expect((await deepCleanup()).errors).toEqual([])
    expect(await db.messages.get("old-message")).toBeDefined()
  })
})
