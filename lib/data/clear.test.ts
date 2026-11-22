import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { createRecreatedDbTestFixture } from "@/lib/db/test-fixture"
import { setDraftDebounced, clearDraft } from "@/lib/db/chat-drafts"
import { loggers } from "@cognia/logging"
import {
  putSessionAsset,
  getSessionAsset,
  listSessionAssets,
  putLibraryAsset,
  clearTemporarySessionAssets,
} from "@/lib/db/session-assets"
import { LIBRARY_OWNER_PREFIX, LIBRARY_REF_SESSION_ID } from "@/lib/db/message-media-refs"
import { clearBrowserPreviewData } from "@/lib/browser/preview-data"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { purgeDatabaseAppData } from "@/lib/tauri/account-app-data"
import { clearTables, clearAll } from "./clear"
import { saveSettings } from "@/lib/db/settings"
import {
  __resetProviderSecretStoreForTesting,
  __setProviderSecretBackendForTesting,
} from "@/lib/settings/provider-secret-store"

jest.mock("@/lib/browser/preview-data", () => ({ clearBrowserPreviewData: jest.fn() }))
const clearPreview = clearBrowserPreviewData as jest.Mock
jest.mock("@/lib/tauri/account-app-data", () => ({ purgeDatabaseAppData: jest.fn() }))
const purgeAppData = purgeDatabaseAppData as jest.Mock

const fixture = createRecreatedDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  clearTemporarySessionAssets()
  clearPreview.mockReset().mockResolvedValue({ cookiesRemoved: 0 })
  purgeAppData.mockReset().mockResolvedValue(undefined)
})
afterAll(fixture.dispose)

const ownedTables = [
  "sessions",
  "messages",
  "sessionState",
  "chatDrafts",
  "chatInputHistory",
  "messageMediaRefs",
  "chatTurnSummaries",
  "chatTranscriptIndexState",
]

async function seedSessions() {
  const db = getDb()
  for (const sessionId of ["a", "b"]) {
    await db.sessions.put({
      id: sessionId,
      projectId: "p",
      title: sessionId,
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
    })
    await db.messages.put({
      id: sessionId,
      sessionId,
      role: "user",
      parts: [],
      createdAt: 1,
    } as never)
    await db.sessionState.put({ sessionId, lastReadAt: 1, unreadCount: 1 })
    await db.chatDrafts.put({ sessionId, text: "draft", updatedAt: 1 })
    await db.chatInputHistory.add({ sessionId, text: "sent", createdAt: 1 })
    await db.messageMediaRefs.put({ messageId: sessionId, sessionId, hash: "shared" })
    await db.chatTranscriptIndexState.put({
      sessionId,
      revision: 1,
      indexedBeforeCreatedAt: 1,
      complete: true,
      updatedAt: 1,
    })
    await db.chatTurnSummaries.put({
      sessionId,
      turnKey: "turn",
      itemKey: "turn",
      order: 1,
      revision: 1,
      detailRevision: 1,
      item: {
        kind: "completed-turn",
        itemKey: "turn",
        turnKey: "turn",
        revision: 1,
        detailRevision: 1,
        status: "completed",
        userMessages: [],
        startedAt: 1,
        collapsed: { exists: false, messageCount: 1, trailingCount: 0, mediaCount: 0 },
      },
      updatedAt: 1,
    })
  }
  for (const hash of ["shared", "unrelated-orphan"]) {
    await db.messageMedia.put({
      hash,
      mediaType: "image/png",
      width: 1,
      height: 1,
      blob: new Blob(["image"]),
      byteSize: 5,
      createdAt: 1,
      lastUsedAt: 1,
    })
  }
}

describe("clearTables", () => {
  it("clears memory-only temporary assets without requiring session or reference rows", async () => {
    const db = getDb()
    await putSessionAsset({
      sessionId: "unsaved-session",
      assetId: "private-source",
      temporary: true,
      filename: "notes.txt",
      mediaType: "text/plain",
      blob: new Blob(["private upload"]),
    })
    expect(await db.sessions.count()).toBe(0)
    expect(await db.messageMediaRefs.count()).toBe(0)
    expect(await getSessionAsset("unsaved-session", "private-source")).toBeDefined()
    await clearTables(["sessions"])
    expect(await getSessionAsset("unsaved-session", "private-source")).toBeUndefined()
  })

  it.each([true, false])(
    "clears orphan conversation rows and timers while preserving Files (sessions empty=%s)",
    async (empty) => {
      await seedSessions()
      const db = getDb()
      await db.messageMedia.put({
        hash: "orphan-message-media",
        mediaType: "image/png",
        width: 1,
        height: 1,
        blob: new Blob(["orphan"]),
        byteSize: 6,
        createdAt: 1,
        lastUsedAt: 1,
      })
      await db.messageMediaRefs.put({
        messageId: "a",
        sessionId: "a",
        hash: "orphan-message-media",
      })
      await putSessionAsset({
        sessionId: "a",
        assetId: "orphan-source",
        filename: "source.txt",
        mediaType: "text/plain",
        blob: new Blob(["unkept source"]),
      })
      const source = await db.messageMediaRefs
        .where("messageId")
        .startsWith("session-asset:")
        .first()
      await db.messageMediaRefs.put({
        messageId: `${LIBRARY_OWNER_PREFIX}pin`,
        sessionId: LIBRARY_REF_SESSION_ID,
        hash: "shared",
      })
      await putLibraryAsset({
        assetId: "orphan-test-file",
        filename: "kept.txt",
        mediaType: "text/plain",
        blob: new Blob(["Files-owned source"]),
      })
      await db.mediaGenerationJobs.bulkPut([
        { id: "orphan-job", sessionId: "a" },
        { id: "files-job" },
      ] as never)
      if (empty) await db.sessions.clear()
      else await db.sessions.delete("a")
      const setTimer = jest.spyOn(globalThis, "setTimeout")
      setDraftDebounced("a", "must not return", [], 60_000)
      const timer = setTimer.mock.results.at(-1)!.value
      setTimer.mockRestore()
      const clearTimer = jest.spyOn(globalThis, "clearTimeout")
      try {
        await clearTables(["sessions"])
        for (const table of ownedTables.filter((name) => name !== "messageMediaRefs")) {
          expect(await db.table(table).count()).toBe(0)
        }
        expect(clearTimer).toHaveBeenCalledWith(timer)
        for (const id of ["a", "b"]) {
          expect(await db.syncTombstones.get(["messages", id])).toBeDefined()
          expect(await db.syncTombstones.get(["sessionState", id])).toBeDefined()
        }
        expect(await db.syncTombstones.get(["sessions", "a"])).toBeUndefined()
        expect(await db.mediaGenerationJobs.get("orphan-job")).toBeUndefined()
        expect(await db.mediaGenerationJobs.get("files-job")).toBeDefined()
        expect(await db.messageMedia.get(source!.hash)).toBeUndefined()
        expect(await db.messageMedia.get("orphan-message-media")).toBeUndefined()
        expect(await db.messageMedia.get("shared")).toBeDefined()
        const refs = await db.messageMediaRefs.toArray()
        expect(refs).toHaveLength(2)
        for (const ref of refs) {
          expect(ref.messageId.startsWith(LIBRARY_OWNER_PREFIX)).toBe(true)
          expect(await db.messageMedia.get(ref.hash)).toBeDefined()
        }
        expect(await db.libraryItems.get("upload:orphan-test-file")).toBeDefined()
      } finally {
        clearTimer.mockRestore()
        await clearDraft("a", { hostAlreadyCleared: true })
      }
    }
  )

  it.each(["creator", "channel", "message", "delivery", "missing-session", "only-host"] as const)(
    "leaves Host conversations and their rows to the Host (%s provenance)",
    async (provenance) => {
      await seedSessions()
      const db = getDb()
      if (provenance === "only-host") await db.sessions.delete("a")
      if (provenance === "creator" || provenance === "only-host") {
        await db.sessions.update("b", { programmaticCreator: "host-state" })
      } else if (provenance === "delivery") {
        await db.sessions.update("b", { deliverySourceHosts: [{ hostId: "host" }] } as never)
      } else if (provenance === "message") {
        await db.messages.update("b", { metadata: { hostState: { optimistic: true } } } as never)
      } else {
        await db.hostStateChannels.put({
          channel: "host-index",
          hostId: "host",
          state: { kind: "session-index", sessions: [{ sessionId: "b" }] },
        } as never)
        if (provenance === "missing-session") await db.sessions.delete("b")
      }
      for (const sessionId of provenance === "only-host" ? ["b"] : ["a", "b"]) {
        await db.chatGoals.put({ id: `goal-${sessionId}`, sessionId } as never)
        await db.sessionUsage.put({ messageId: `usage-${sessionId}`, sessionId } as never)
        await db.mediaGenerationJobs.put({ id: `job-${sessionId}`, sessionId } as never)
      }
      const hostRows = new Map<string, unknown[]>()
      await putSessionAsset({
        sessionId: "b",
        assetId: "host-memory-only",
        temporary: true,
        filename: "kept.txt",
        mediaType: "text/plain",
        blob: new Blob(["Host upload"]),
      })
      for (const table of ownedTables.filter((name) => name !== "sessions")) {
        hostRows.set(
          table,
          await db
            .table(table)
            .filter((row) => row.sessionId === "b")
            .toArray()
        )
      }
      await expect(clearTables(["sessions"])).resolves.toBeUndefined()
      expect(await getSessionAsset("b", "host-memory-only")).toBeDefined()
      expect(await db.sessions.get("a")).toBeUndefined()
      if (provenance !== "missing-session") expect(await db.sessions.get("b")).toBeDefined()
      for (const [table, rows] of hostRows) expect(await db.table(table).toArray()).toEqual(rows)
      expect(await db.chatGoals.get("goal-a")).toBeUndefined()
      // Spent money outlives the conversation (F13): kept, never tombstoned.
      if (provenance === "only-host") {
        expect(await db.sessionUsage.get("usage-a")).toBeUndefined()
      } else {
        expect(await db.sessionUsage.get("usage-a")).toBeDefined()
      }
      expect(await db.syncTombstones.get(["sessionUsage", "usage-a"])).toBeUndefined()
      expect(await db.mediaGenerationJobs.get("job-a")).toBeUndefined()
      expect(await db.chatGoals.get("goal-b")).toBeDefined()
      expect(await db.sessionUsage.get("usage-b")).toBeDefined()
      expect(await db.mediaGenerationJobs.get("job-b")).toBeDefined()
      expect(await db.messageMedia.get("shared")).toBeDefined()
      for (const table of ["sessions", "messages", "sessionState"] as const) {
        expect(await db.syncTombstones.get([table, "b"])).toBeUndefined()
      }
    }
  )

  it("rolls back orphan cleanup and tombstones when a combined settings reset fails", async () => {
    await seedSessions()
    const db = getDb()
    await db.sessions.clear()
    await db.settings.put({ id: "singleton" } as never)
    await putSessionAsset({
      sessionId: "unsaved-rollback",
      assetId: "memory-source",
      temporary: true,
      filename: "kept.txt",
      mediaType: "text/plain",
      blob: new Blob(["rollback keeps memory"]),
    })
    const failure = () => {
      throw new Error("settings reset failed")
    }
    db.settings.hook("deleting", failure)
    try {
      await expect(clearTables(["sessions", "settings"])).rejects.toThrow("settings reset failed")
      for (const table of ownedTables.filter((name) => name !== "sessions")) {
        expect(await db.table(table).count()).toBe(2)
      }
      expect(await db.syncTombstones.count()).toBe(0)
      expect(await db.messageMedia.get("shared")).toBeDefined()
      expect(await getSessionAsset("unsaved-rollback", "memory-source")).toBeDefined()
    } finally {
      db.settings.hook("deleting").unsubscribe(failure)
    }
  })

  it("uses the session cascade for goals, usage, plans, loops and peer messages", async () => {
    await seedSessions()
    const db = getDb()
    await db.chatGoals.put({ id: "goal", sessionId: "a" } as never)
    await db.chatGoalEvents.put({ id: "goal-event", goalId: "goal" } as never)
    await db.sessionUsage.put({ messageId: "usage", sessionId: "a", at: 1 } as never)
    await db.agentPlans.put({ id: "plan", sessionId: "a" } as never)
    await db.agentPlanEvents.put({ id: "plan-event", planId: "plan" } as never)
    await db.loops.put({ id: "loop", sessionId: "a" } as never)
    await db.loopEvents.put({ id: "loop-event", loopId: "loop" } as never)
    await db.sessionPeerMessages.put({
      id: "peer",
      senderSessionId: "a",
      receiverSessionId: "b",
    } as never)
    await db.mediaGenerationJobs.put({ id: "video-job", sessionId: "a" } as never)
    await clearTables(["sessions"])
    for (const table of [
      "chatGoals",
      "chatGoalEvents",
      "agentPlans",
      "agentPlanEvents",
      "loops",
      "loopEvents",
      "sessionPeerMessages",
      "mediaGenerationJobs",
    ]) {
      expect(await db.table(table).count()).toBe(0)
    }
    // Spent money outlives the conversation (F13): kept, never tombstoned.
    expect(await db.sessionUsage.count()).toBe(1)
    expect(await db.syncTombstones.get(["goals", "goal"])).toBeDefined()
    expect(await db.syncTombstones.get(["sessionUsage", "usage"])).toBeUndefined()
  })
  it("returns immediately when given no names", async () => {
    const transaction = jest.spyOn(getDb(), "transaction")
    try {
      await clearTables([])
      expect(transaction).not.toHaveBeenCalled()
    } finally {
      transaction.mockRestore()
    }
  })

  it("keeps the canonical cascade and tombstones in a combined conversation and settings reset", async () => {
    await seedSessions()
    const db = getDb()
    await db.settings.put({ id: "singleton" } as never)
    await db.chatGoals.put({ id: "goal", sessionId: "a" } as never)
    await db.sessionUsage.put({ messageId: "usage", sessionId: "a", at: 1 } as never)
    await clearTables(["sessions", "settings"])
    expect(await db.settings.count()).toBe(0)
    expect(await db.chatGoals.count()).toBe(0)
    expect(await db.sessionUsage.count()).toBe(1)
    for (const table of ownedTables) expect(await db.table(table).count()).toBe(0)
    expect(await db.syncTombstones.get(["goals", "goal"])).toBeDefined()
    expect(await db.syncTombstones.get(["sessionUsage", "usage"])).toBeUndefined()
  })

  it.each([false, true])(
    "leaves a generated video kept in Files with what its job recorded (orphan=%s)",
    async (orphan) => {
      await seedSessions()
      const db = getDb()
      await db.messageMediaRefs.put({
        sessionId: "a",
        messageId: "session-asset:a:video-vjob_v",
        hash: "original:sha",
        sessionAsset: { sessionId: "a", assetId: "video-vjob_v", contentHash: "sha" } as never,
      })
      await db.mediaGenerationJobs.put({
        id: "vjob_v",
        sessionId: "a",
        status: "succeeded",
        request: { prompt: "waves" },
        provider: { providerId: "google", modelId: "veo" },
        result: { content: { kind: "session-asset", sessionId: "a", assetId: "video-vjob_v" } },
      } as never)
      await db.libraryItems.put({
        key: "session-upload:sha",
        kind: "session-upload",
        sourceId: "sha",
        favoritedAt: 1,
        snapshot: { title: "waves.mp4" },
        createdAt: 1,
        updatedAt: 1,
      })
      if (orphan) await db.sessions.clear()
      await clearTables(["sessions"])
      expect(await db.mediaGenerationJobs.count()).toBe(0)
      expect((await db.libraryItems.get("session-upload:sha"))?.snapshot?.generated).toEqual({
        jobId: "vjob_v",
        prompt: "waves",
        providerId: "google",
        modelId: "veo",
      })
    }
  )

  it("clears session-owned rows and tombstones them, collecting only candidate media", async () => {
    await seedSessions()
    await clearTables(["sessions"])
    const db = getDb()
    for (const name of ownedTables) expect(await db.table(name).count()).toBe(0)
    expect((await db.messageMedia.toArray()).map((row) => row.hash)).toEqual(["unrelated-orphan"])
    for (const name of ["sessions", "messages", "sessionState"]) {
      expect(
        (await db.syncTombstones.where("table").equals(name).toArray()).map((row) => row.id).sort()
      ).toEqual(["a", "b"])
    }
  })

  it("clears requested settings tables while preserving unselected sessions and shared media", async () => {
    await seedSessions()
    const db = getDb()
    const names = [
      "characters",
      "skills",
      "teams",
      "promptPresets",
      "mcpServers",
      "settings",
    ] as const
    for (const name of names) await db.table(name).put({ id: "configured" })
    await clearTables([...names])
    for (const name of names) expect(await db.table(name).count()).toBe(0)
    expect(await db.sessions.count()).toBe(2)
    expect(await db.messageMediaRefs.count()).toBe(2)
    expect(await db.messageMedia.get("shared")).toBeDefined()
    // Sessions were not selected, so none of theirs; the cleared user-authored
    // character and skill are tombstoned so paired clients drop them too.
    const tombstones = (await db.syncTombstones.toArray()).map((row) => `${row.table}:${row.id}`)
    expect(tombstones.sort()).toEqual(["characters:configured", "skills:configured"])
  })

  it("tombstones only user-authored characters and skills, never built-ins", async () => {
    const db = getDb()
    await db.characters.bulkPut([
      { id: "mine", isBuiltIn: false },
      { id: "seeded", isBuiltIn: true },
    ] as never)
    await db.skills.bulkPut([
      { id: "my-skill", isBuiltIn: false },
      { id: "builtin-skill", isBuiltIn: true },
    ] as never)
    await clearTables(["characters", "skills"])
    const tombstones = (await db.syncTombstones.toArray()).map((row) => `${row.table}:${row.id}`)
    expect(tombstones.sort()).toEqual(["characters:mine", "skills:my-skill"])
  })

  it("clears the mirrored MCP summaries with the servers and tombstones them", async () => {
    const db = getDb()
    await db.mcpServers.put({ id: "srv" } as never)
    await db.mcpServerSummaries.put({ id: "srv", updatedAt: 1 } as never)
    await db.mcpCapabilityCache.put({ id: "cap", serverId: "srv" } as never)
    await clearTables(["mcpServers"])
    expect(await db.mcpServerSummaries.count()).toBe(0)
    expect(await db.mcpCapabilityCache.count()).toBe(0)
    expect(
      (await db.syncTombstones.where("table").equals("mcpServers").toArray()).map((row) => row.id)
    ).toEqual(["srv"])
  })

  it("rolls back session cleanup and tombstones when another selected table fails", async () => {
    await seedSessions()
    const db = getDb()
    await db.characters.put({ id: "character" } as never)
    const failDelete = () => {
      throw new Error("character delete failed")
    }
    db.characters.hook("deleting", failDelete)
    try {
      await expect(clearTables(["sessions", "characters"])).rejects.toThrow(
        "character delete failed"
      )
    } finally {
      db.characters.hook("deleting").unsubscribe(failDelete)
    }
    for (const name of ownedTables) expect(await db.table(name).count()).toBe(2)
    expect(await db.characters.count()).toBe(1)
    expect(await db.syncTombstones.count()).toBe(0)
    expect(await db.messageMedia.count()).toBe(2)
  })

  it("preserves unselected settings tables", async () => {
    const db = getDb()
    await db.characters.put({ id: "character" } as never)
    await db.skills.put({ id: "skill" } as never)
    await clearTables(["characters"])
    expect(await db.characters.count()).toBe(0)
    expect(await db.skills.get("skill")).toBeDefined()
  })

  it("keeps reset committed when draft timer cleanup fails", async () => {
    await seedSessions()
    const db = getDb()
    const failDelete = jest
      .spyOn(db.chatDrafts, "delete")
      .mockRejectedValueOnce(new Error("closed"))
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
    try {
      await expect(clearTables(["sessions"])).resolves.toBeUndefined()
      expect(await db.sessions.count()).toBe(0)
      expect(await db.chatDrafts.count()).toBe(0)
      expect(warn).toHaveBeenCalledWith("session draft cleanup failed", {
        sessionId: "a",
        error: "Error: closed",
      })
    } finally {
      failDelete.mockRestore()
      warn.mockRestore()
    }
  })

  it("keeps a committed reset successful when media collection fails", async () => {
    await seedSessions()
    const db = getDb()
    const failDelete = () => {
      throw new Error("media unavailable")
    }
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => {})
    db.messageMedia.hook("deleting", failDelete)
    try {
      await expect(clearTables(["sessions"])).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith("session media cleanup failed", {
        error: "Error: media unavailable",
        sessionIds: ["a", "b"],
      })
    } finally {
      db.messageMedia.hook("deleting").unsubscribe(failDelete)
      warn.mockRestore()
    }
    expect(await db.sessions.count()).toBe(0)
    expect(await db.messageMediaRefs.count()).toBe(0)
    expect(await db.messageMedia.get("shared")).toBeDefined()
  })

  it("cancels pending draft saves after reset", async () => {
    await seedSessions()
    const setTimer = jest.spyOn(globalThis, "setTimeout")
    setDraftDebounced("a", "must not return", [], 1000)
    const timer = setTimer.mock.results.at(-1)?.value
    setTimer.mockRestore()
    const clearTimer = jest.spyOn(globalThis, "clearTimeout")
    try {
      await clearTables(["sessions"])
      expect(clearTimer).toHaveBeenCalledWith(timer)
    } finally {
      clearTimer.mockRestore()
      await clearDraft("a", { hostAlreadyCleared: true })
    }
  })
})

describe("clearAll", () => {
  it("deletes the entire database", async () => {
    const db = getDb()
    const remove = jest.spyOn(db, "delete")
    try {
      await expect(clearAll()).resolves.toEqual({ databaseReset: true, cleanupFailures: [] })
      expect(remove).toHaveBeenCalledTimes(1)
    } finally {
      remove.mockRestore()
    }
  })

  it("deletes the Router + Fusion ledger beside the database", async () => {
    const fusionName = `${getDb().name}-router-fusion-v1`
    const fusion = new Dexie(fusionName)
    fusion.version(1).stores({ fusionRuns: "&runId" })
    await fusion.open()
    await fusion.table("fusionRuns").put({ runId: "run-1" })
    fusion.close()

    await clearAll()

    expect(await Dexie.exists(fusionName)).toBe(false)
  })

  it("refuses to report the data cleared when the ledger survives its deletion", async () => {
    const fusionName = `${getDb().name}-router-fusion-v1`
    const exists = jest
      .spyOn(Dexie, "exists")
      .mockImplementation(async (name) => name === fusionName)
    try {
      await expect(clearAll()).rejects.toThrow(
        `Clear all data could not verify the deletion of ${fusionName}`
      )
      expect(exists).toHaveBeenCalledWith(getDb().name)
    } finally {
      exists.mockRestore()
    }
  })

  // The preview's cookies and preferences live outside the database; a reset
  // device must not stay signed in to the sites the preview visited.
  it("signs the built-in browser out and forgets its preferences", async () => {
    clearPreview.mockReset().mockResolvedValue({ cookiesRemoved: 2 })
    await clearAll()
    expect(clearPreview).toHaveBeenCalledTimes(1)
  })

  // Workflow videos and composer staging copies are files under AppData in
  // the database's own directory; they must not outlive it.
  it("removes the files the database kept under AppData", async () => {
    const name = getDb().name
    purgeAppData.mockReset().mockResolvedValue(undefined)
    await clearAll()
    expect(purgeAppData).toHaveBeenCalledTimes(1)
    expect(purgeAppData).toHaveBeenCalledWith(getActiveAccountId(), name)
  })

  it("reports a verified database reset separately from files held open", async () => {
    purgeAppData.mockReset().mockRejectedValue(new Error("file in use"))
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => undefined)
    try {
      await expect(clearAll()).resolves.toEqual({
        databaseReset: true,
        cleanupFailures: ["appData"],
      })
      expect(warn).toHaveBeenCalledWith(
        "clear all: generated video files were not all removed",
        expect.anything()
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("still clears the database when the browser's cookie store is unreachable", async () => {
    clearPreview.mockReset().mockRejectedValue(new Error("no webview"))
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => undefined)
    const remove = jest.spyOn(getDb(), "delete")
    try {
      await expect(clearAll()).resolves.toEqual({
        databaseReset: true,
        cleanupFailures: ["browserPreview"],
      })
      expect(remove).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalled()
    } finally {
      remove.mockRestore()
      warn.mockRestore()
    }
  })

  it("reports each ancillary failure after verifying both databases were deleted", async () => {
    const mainName = getDb().name
    clearPreview.mockRejectedValueOnce(new Error("cookies unavailable"))
    purgeAppData.mockRejectedValueOnce(new Error("files unavailable"))
    const warn = jest.spyOn(loggers.store, "warn").mockImplementation(() => undefined)
    try {
      await expect(clearAll()).resolves.toEqual({
        databaseReset: true,
        cleanupFailures: ["browserPreview", "appData"],
      })
      expect(await Dexie.exists(mainName)).toBe(false)
      expect(await Dexie.exists(`${mainName}-router-fusion-v1`)).toBe(false)
      expect(purgeAppData).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

it("clears durable and temporary attachment ownership with sessions", async () => {
  await seedSessions()
  await putSessionAsset({
    sessionId: "a",
    assetId: "durable",
    filename: "source",
    mediaType: "text/plain",
    blob: new Blob(["retained"]),
  })
  await putSessionAsset({
    sessionId: "a",
    assetId: "temporary",
    filename: "source",
    mediaType: "text/plain",
    blob: new Blob(["ephemeral"]),
    temporary: true,
  })
  await clearTables(["sessions"])
  expect(await listSessionAssets("a")).toEqual([])
  expect(await getDb().messageMedia.where("hash").startsWith("original:").count()).toBe(0)
})

it.each([false, true])(
  "leaves Files pins and Files-owned uploads, with their bytes, when clearing conversations (orphan=%s)",
  async (orphan) => {
    await seedSessions()
    const db = getDb()
    await putSessionAsset({
      sessionId: "a",
      assetId: "kept",
      filename: "kept.txt",
      mediaType: "text/plain",
      blob: new Blob(["kept source"]),
    })
    const kept = await db.messageMediaRefs.where("messageId").startsWith("session-asset:").first()
    await db.messageMediaRefs.put({
      messageId: `${LIBRARY_OWNER_PREFIX}session-upload:x`,
      sessionId: LIBRARY_REF_SESSION_ID,
      hash: kept!.hash,
    })
    await putLibraryAsset({
      assetId: "own",
      filename: "own.md",
      mediaType: "text/markdown",
      blob: new Blob(["owned by files"]),
    })

    if (orphan) await db.sessions.clear()
    await clearTables(["sessions"])

    const refs = await db.messageMediaRefs.toArray()
    expect(refs.every((row) => row.sessionId === LIBRARY_REF_SESSION_ID)).toBe(true)
    expect(refs).toHaveLength(2)
    expect(await db.messageMedia.where("hash").startsWith("original:").count()).toBe(2)
    expect(await db.libraryItems.get("upload:own")).toBeDefined()
  }
)

describe("provider credentials (ADR-0256)", () => {
  const values = new Map<string, string>()
  beforeEach(() => {
    values.clear()
    __setProviderSecretBackendForTesting({
      save: async (k, v) => void values.set(k, v),
      load: async (k) => values.get(k) ?? null,
      delete: async (k) => void values.delete(k),
    })
  })
  afterAll(() => __resetProviderSecretStoreForTesting())

  it("clearing the settings table also removes its credentials", async () => {
    await saveSettings({ apiKey: "sk-synthetic" }, { mirrorToHost: false })
    expect(values.has(getDb().name)).toBe(true)
    await clearTables(["settings"])
    expect(values.has(getDb().name)).toBe(false)
  })

  it("clearing all data also removes the credentials of the deleted database", async () => {
    await saveSettings({ apiKey: "sk-synthetic" }, { mirrorToHost: false })
    const name = getDb().name
    await clearAll()
    expect(values.has(name)).toBe(false)
  })
})
