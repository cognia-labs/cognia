import { invalidateTranscriptRuntime } from "@/lib/chat/transcript/revision-events"
jest.mock("@/lib/chat/transcript/revision-events", () => ({
  ...jest.requireActual("@/lib/chat/transcript/revision-events"),
  invalidateTranscriptRuntime: jest.fn(async () => undefined),
}))

import type { ChatSession, SessionSurfaceBinding } from "@cognia/agent-config-types"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import { persistMessages, listMessages } from "./messages"
import {
  advanceResourceAsideContextCursor,
  advanceResourceAsideExternalSession,
  clearResourceWorkbenchSession,
  createResourceSessionRepository,
  createResourceWorkbenchSession,
  deleteResourceWorkbenchSession,
  listResourceWorkbenchSessions,
  listSessionBoundAsides,
  retireAsideParentContext,
  promoteResourceWorkbenchSession,
  renameResourceWorkbenchSession,
  updateAsideParentMessagePins,
} from "./resource-workbench-sessions"
import {
  ensureResourceWorkbenchSession,
  resourceWorkbenchSessionId,
} from "@/lib/context-workbench/resource-session"
import { isSessionExposed } from "@/lib/chat/session-exposure"
import { emptyWorkingSet } from "@/lib/chat/working-set"
import { deleteSession } from "./sessions"
import type { UIMessage } from "ai"

// Session deletion dynamically imports the artifact Zustand store for a
// best-effort cleanup. This DB suite does not exercise that store, and paying
// its full transform graph inside a 5s test obscures the database behavior.
jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: () => ({ clearSessionData: jest.fn() }),
  },
}))

const binding: SessionSurfaceBinding = { kind: "session", sessionId: "main-1" }

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  jest.mocked(invalidateTranscriptRuntime).mockReset().mockResolvedValue(undefined)
  await dbFixture.restore()
  await getDb().sessions.put({
    id: "main-1",
    title: "Main",
    kind: "direct",
    projectId: "proj-main",
    createdAt: 1,
    updatedAt: 1,
  } as ChatSession)
})
afterAll(dbFixture.dispose)

/** The aside `ensureResourceWorkbenchSession` auto-creates on first open. */
async function seedPrimary(): Promise<string> {
  const id = resourceWorkbenchSessionId(binding)
  await getDb().sessions.put({
    id,
    title: "Aside",
    kind: "resource-workbench",
    visibility: "embedded",
    surfaceBinding: binding,
    surfaceBindingKey: "session:main-1",
    projectId: "proj-main",
    createdAt: 2,
    updatedAt: 2,
  } as ChatSession)
  return id
}

const uiMsg = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe("atomic aside ownership", () => {
  it("does not re-embed a row promoted while legacy repair was pending", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { surfaceBindingKey: undefined })
    const repository = createResourceSessionRepository()
    const entered = gate()
    const resume = gate()
    const delayed = ensureResourceWorkbenchSession(binding, "Aside", {
      ...repository,
      repair: async (rowId, patch) => {
        entered.release()
        await resume.promise
        return repository.repair!(rowId, patch)
      },
    })
    await entered.promise
    try {
      await promoteResourceWorkbenchSession(id)
      await getDb().sessions.update(id, { model: "chosen", sdkSessionId: "sdk" })
      resume.release()
      expect((await delayed).id).toBe(`${id}#primary:1`)
      expect(await getDb().sessions.get(id)).toMatchObject({
        kind: "direct",
        model: "chosen",
        sdkSessionId: "sdk",
      })
    } finally {
      resume.release()
    }
  })

  it("refuses additional-aside creation when deletion follows the parent read", async () => {
    const db = getDb()
    const originalGet = db.sessions.get.bind(db.sessions)
    const spy = jest.spyOn(db.sessions, "get").mockImplementationOnce((async (key: string) => {
      const parent = await originalGet(key)
      await deleteSession("main-1")
      return parent
    }) as never)
    try {
      await expect(createResourceWorkbenchSession(binding, "Late extra")).rejects.toMatchObject({
        code: "aside_parent_gone",
      })
      expect(await listResourceWorkbenchSessions(binding)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it("converges after a competing creator promotes the occupied primary", async () => {
    const repository = createResourceSessionRepository()
    const entered = gate()
    const resume = gate()
    const delayed = ensureResourceWorkbenchSession(binding, "Late", {
      ...repository,
      create: async (row) => {
        entered.release()
        await resume.promise
        return repository.create!(row)
      },
    })
    await entered.promise
    try {
      const winner = await ensureResourceWorkbenchSession(binding, "Winner", repository)
      await getDb().sessions.update(winner.id, { sdkSessionId: "sdk", model: "chosen" })
      await persistMessages(winner.id, [uiMsg("kept", "Keep me")])
      await promoteResourceWorkbenchSession(winner.id)
      resume.release()
      expect((await delayed).id).toBe(`${winner.id}#primary:1`)
      expect(await getDb().sessions.get(winner.id)).toMatchObject({
        kind: "direct",
        sdkSessionId: "sdk",
        model: "chosen",
        title: "Winner",
      })
      expect(await listMessages(winner.id)).toHaveLength(1)
    } finally {
      resume.release()
    }
  })

  it("refuses a delayed create after the real parent deletion and tombstone", async () => {
    const repository = createResourceSessionRepository()
    const entered = gate()
    const resume = gate()
    const delayed = ensureResourceWorkbenchSession(binding, "Late", {
      ...repository,
      create: async (row) => {
        entered.release()
        await resume.promise
        return repository.create!(row)
      },
    })
    const rejection = expect(delayed).rejects.toMatchObject({ code: "aside_parent_gone" })
    await entered.promise
    try {
      await deleteSession("main-1")
      expect(await getDb().syncTombstones.get(["sessions", "main-1"])).toBeDefined()
    } finally {
      resume.release()
    }
    await rejection
    expect(await getDb().sessions.get(resourceWorkbenchSessionId(binding))).toBeUndefined()
  })

  it.each(["missing", "tombstoned"])(
    "refuses creation and promotion for a %s parent",
    async (state) => {
      const id = await seedPrimary()
      await persistMessages(id, [uiMsg("kept", "Keep me")])
      if (state === "missing") await getDb().sessions.delete("main-1")
      else await getDb().syncTombstones.put({ table: "sessions", id: "main-1", deletedAt: 3 })
      await expect(promoteResourceWorkbenchSession(id)).rejects.toMatchObject({
        code: "aside_parent_gone",
      })
      await expect(createResourceWorkbenchSession(binding, "Extra")).rejects.toMatchObject({
        code: "aside_parent_gone",
      })
      expect((await getDb().sessions.get(id))?.kind).toBe("resource-workbench")
      expect(await listMessages(id)).toHaveLength(1)
      expect(await listResourceWorkbenchSessions(binding)).toHaveLength(1)
    }
  )
})

describe("createResourceWorkbenchSession", () => {
  it("inherits parent configuration without activating team or squad executors", async () => {
    await getDb().sessions.update("main-1", {
      model: "parent-model",
      accountId: "account",
      permissionMode: "acceptEdits",
      teamId: "team",
      squadId: "squad",
      sandboxTier: "microvm",
      systemPrompt: "Rules",
    })
    const extra = await createResourceWorkbenchSession(binding, "Aside")
    expect(extra).toMatchObject({
      model: "parent-model",
      accountId: "account",
      permissionMode: "acceptEdits",
      sandboxTier: "microvm",
      systemPrompt: "Rules",
    })
    expect(extra.teamId).toBeUndefined()
    expect(extra.squadId).toBeUndefined()
  })

  it("shares the indexed repository used by ensure and migration callers", async () => {
    await seedPrimary()
    const repository = createResourceSessionRepository()
    await expect(repository.findByBinding?.(binding)).resolves.toMatchObject({
      surfaceBindingKey: "session:main-1",
    })
    await expect(repository.resolveProjectId?.(binding)).resolves.toBe("proj-main")
  })

  it("mints a distinct row that still shares the binding key", async () => {
    const primaryId = await seedPrimary()
    const extra = await createResourceWorkbenchSession(binding, "Check the versions")

    expect(extra.id).not.toBe(primaryId)
    // Sharing the key is what makes "every aside of this conversation" one
    // indexed lookup instead of a table scan.
    expect(extra.surfaceBindingKey).toBe("session:main-1")
    expect(extra.kind).toBe("resource-workbench")
    expect(extra.visibility).toBe("embedded")
  })

  it("inherits the MAIN conversation's workspace, not the active one", async () => {
    // A row without a projectId is absent from `[projectId+updatedAt]` — hidden
    // from scoped reads AND from `deleteProjectCascade`, so it would outlive
    // the workspace it belongs to.
    await getDb().settings.put({ id: "singleton", activeProjectId: "proj-elsewhere" } as never)
    const extra = await createResourceWorkbenchSession(binding, "Aside 2")
    expect(extra.projectId).toBe("proj-main")
  })

  it("stays out of every user-facing channel", async () => {
    const extra = await createResourceWorkbenchSession(binding, "Aside 2")
    expect(isSessionExposed(extra, "main-list")).toBe(false)
    expect(isSessionExposed(extra, "global-search")).toBe(false)
  })
})

describe("listResourceWorkbenchSessions", () => {
  it("returns every aside for the binding, oldest first", async () => {
    const primaryId = await seedPrimary()
    const a = await createResourceWorkbenchSession(binding, "A")
    const b = await createResourceWorkbenchSession(binding, "B")

    const ids = (await listResourceWorkbenchSessions(binding)).map((s) => s.id)
    // Creation order, not recency: this renders as a stable pick-list and
    // re-sorting on every send would move the entry under the cursor. Both
    // extras are created inside the same millisecond here, which is exactly the
    // case a bare `Date.now()` stamp cannot order.
    expect(ids).toEqual([primaryId, a.id, b.id])
    expect(a.createdAt).toBeLessThan(b.createdAt)
  })

  it("does not leak another resource's asides", async () => {
    await seedPrimary()
    await createResourceWorkbenchSession({ kind: "artifact", artifactId: "art-1" }, "Other")
    const ids = (await listResourceWorkbenchSessions(binding)).map((s) => s.id)
    expect(ids).toHaveLength(1)
  })
})

describe("renameResourceWorkbenchSession", () => {
  it("trims the new name", async () => {
    const id = await seedPrimary()
    await renameResourceWorkbenchSession(id, "  Renamed  ")
    expect((await getDb().sessions.get(id))?.title).toBe("Renamed")
  })

  it("rejects an empty name rather than persisting one", async () => {
    const id = await seedPrimary()
    await expect(renameResourceWorkbenchSession(id, "   ")).rejects.toThrow()
    expect((await getDb().sessions.get(id))?.title).toBe("Aside")
  })
})

describe("retiring inherited parent context", () => {
  it("lists only the parent's session-bound asides through the binding index", async () => {
    const primaryId = await seedPrimary()
    const extra = await createResourceWorkbenchSession(binding, "Extra")
    await createResourceWorkbenchSession({ kind: "artifact", artifactId: "art-1" }, "Artifact")
    await getDb().sessions.put({
      id: "other-aside",
      kind: "resource-workbench",
      surfaceBinding: { kind: "session", sessionId: "other-parent" },
      surfaceBindingKey: "session:other-parent",
      title: "Other",
      createdAt: 1,
      updatedAt: 1,
    })
    expect((await listSessionBoundAsides("main-1")).map((row) => row.id)).toEqual([
      primaryId,
      extra.id,
    ])
  })

  it("retires provider links and cursor while preserving the aside transcript and config", async () => {
    const id = await seedPrimary()
    await persistMessages(id, [uiMsg("own-question", "Keep this side question")])
    await getDb().sessions.update(id, {
      model: "chosen-model",
      asideWriteAccess: true,
      sdkSessionId: "old-sdk",
      forkedFromSdkSessionId: "parent-sdk",
      sdkSessionStorage: { backend: "filesystem" },
      externalAgentSession: { agentId: "agent", sessionId: "old-external" },
      externalAgentGatewaySessions: [{ agentId: "agent", sessionId: "old-gateway" }],
      branchSeed: { kind: "transcript", content: "Old inherited parent seed" },
      asideContextCursor: { sdkSessionId: "old-sdk", parentMessageId: "p1", tailFingerprint: "h" },
      asidePinnedParentMessageIds: ["p1"],
    })
    const before = await listMessages(id)
    await retireAsideParentContext(id)
    expect(invalidateTranscriptRuntime).toHaveBeenCalledWith(id)
    const row = await getDb().sessions.get(id)
    expect(row).toMatchObject({ model: "chosen-model", asideWriteAccess: true })
    expect(row?.asideParentClearedAt).toBeGreaterThan(row?.lastMessageAt ?? 0)
    for (const field of [
      "sdkSessionId",
      "forkedFromSdkSessionId",
      "sdkSessionStorage",
      "externalAgentSession",
      "externalAgentGatewaySessions",
      "branchSeed",
      "asideContextCursor",
      "asidePinnedParentMessageIds",
    ])
      expect(row).not.toHaveProperty(field)
    expect(await listMessages(id)).toEqual(before)
    await advanceResourceAsideContextCursor(id, {
      sdkSessionId: "old-sdk",
      parentMessageId: "late-parent",
      tailFingerprint: "late",
    })
    expect((await getDb().sessions.get(id))?.asideContextCursor).toBeUndefined()
  })

  it("keeps the cursor and links when runtime retirement fails", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "still-live" })
    jest.mocked(invalidateTranscriptRuntime).mockRejectedValueOnce(new Error("close failed"))
    await expect(retireAsideParentContext(id)).rejects.toThrow("close failed")
    expect(await getDb().sessions.get(id)).toMatchObject({ sdkSessionId: "still-live" })
    expect((await getDb().sessions.get(id))?.asideParentClearedAt).toBeUndefined()
  })

  it("rejects late external-session writes after parent retirement, then accepts a fresh turn", async () => {
    const id = await seedPrimary()
    const links = { externalAgentSession: { agentId: "agent", sessionId: "old-external" } }
    expect(await advanceResourceAsideExternalSession(id, links, {})).toBe(true)
    await retireAsideParentContext(id)
    expect(await advanceResourceAsideExternalSession(id, links, {})).toBe(false)
    expect((await getDb().sessions.get(id))?.externalAgentSession).toBeUndefined()
    const current = (await getDb().sessions.get(id))!
    expect(
      await advanceResourceAsideExternalSession(
        id,
        {
          externalAgentSession: { agentId: "agent", sessionId: "fresh-external" },
        },
        current
      )
    ).toBe(true)
    expect((await getDb().sessions.get(id))?.externalAgentSession?.sessionId).toBe("fresh-external")
  })

  it("does not retire new provider history when recovering a completed or older clear", async () => {
    const id = await seedPrimary()
    await retireAsideParentContext(id, getDb(), 100)
    await getDb().sessions.update(id, { sdkSessionId: "fresh-sdk" })
    jest.mocked(invalidateTranscriptRuntime).mockClear()
    await retireAsideParentContext(id, getDb(), 100)
    await retireAsideParentContext(id, getDb(), 99)
    expect(invalidateTranscriptRuntime).not.toHaveBeenCalled()
    expect((await getDb().sessions.get(id))?.sdkSessionId).toBe("fresh-sdk")
  })
})

describe("clearResourceWorkbenchSession", () => {
  it("persists explicit inclusion and prunes pins after deletion or a branch switch", async () => {
    const id = await seedPrimary()
    await persistMessages("main-1", [uiMsg("pin", "Earlier message"), uiMsg("keep", "Latest")])
    expect(await updateAsideParentMessagePins(id, { messageId: "pin", included: true })).toEqual([
      "pin",
    ])
    expect((await getDb().sessions.get(id))?.asidePinnedParentMessageIds).toEqual(["pin"])
    await getDb().messages.delete("pin")
    expect(await updateAsideParentMessagePins(id)).toEqual([])
    await persistMessages("main-1", [
      { ...uiMsg("branch-a", "A"), metadata: { branchGroupId: "group", branchIndex: 0 } },
      { ...uiMsg("branch-b", "B"), metadata: { branchGroupId: "group", branchIndex: 1 } },
    ])
    await getDb().sessions.update("main-1", { activeBranchByGroup: { group: "branch-a" } })
    expect(
      await updateAsideParentMessagePins(id, { messageId: "branch-a", included: true })
    ).toEqual(["branch-a"])
    await getDb().sessions.update("main-1", { activeBranchByGroup: { group: "branch-b" } })
    expect(await updateAsideParentMessagePins(id)).toEqual([])
    expect(
      await updateAsideParentMessagePins(id, { messageId: "branch-a", included: true })
    ).toEqual([])
  })
  it("clears every retained thread seed and cursor while preserving configuration and unlock", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, {
      model: "model",
      permissionMode: "acceptEdits",
      asideWriteAccess: true,
      branchSeed: { kind: "transcript", content: "Old context" },
      spawnedTask: { mode: "inherit", pendingPrompt: "Old task" },
      sdkSessionId: "sdk",
      forkedFromSdkSessionId: "parent-sdk",
      sdkSessionStorage: { backend: "filesystem" },
      externalAgentSession: { agentId: "agent", sessionId: "native-old" },
      externalAgentGatewaySessions: [{ agentId: "agent", sessionId: "native-old" }],
      asideContextCursor: { sdkSessionId: "sdk", parentMessageId: "m1", tailFingerprint: "hash" },
      asidePinnedParentMessageIds: ["m1"],
      runtimeTranscriptInvalidated: "old-mutation",
      workingSet: emptyWorkingSet(),
    } as Partial<ChatSession>)
    await clearResourceWorkbenchSession(id)
    const row = await getDb().sessions.get(id)
    expect(row).toMatchObject({
      model: "model",
      permissionMode: "acceptEdits",
      asideWriteAccess: true,
    })
    for (const field of [
      "branchSeed",
      "spawnedTask",
      "sdkSessionId",
      "forkedFromSdkSessionId",
      "sdkSessionStorage",
      "externalAgentSession",
      "externalAgentGatewaySessions",
      "asideContextCursor",
      "runtimeTranscriptInvalidated",
      "asidePinnedParentMessageIds",
      "workingSet",
    ]) {
      expect(row).not.toHaveProperty(field)
    }
  })

  it("refuses to clear if the provider runtime cannot be stopped", async () => {
    const id = await seedPrimary()
    await persistMessages(id, [uiMsg("kept", "still here")])
    jest.mocked(invalidateTranscriptRuntime).mockRejectedValueOnce(new Error("host unavailable"))
    await expect(clearResourceWorkbenchSession(id)).rejects.toThrow("host unavailable")
    expect(await listMessages(id)).toHaveLength(1)
  })

  it("drops the messages, keeps the aside, and unlinks the SDK conversation", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "sdk-1" })
    await persistMessages(id, [uiMsg("m1", "hello")])

    await clearResourceWorkbenchSession(id)

    expect(invalidateTranscriptRuntime).toHaveBeenCalledWith(id)
    expect(await listMessages(id)).toHaveLength(0)
    const row = await getDb().sessions.get(id)
    expect(row).toBeDefined()
    // The provider still holds the turns we deleted; resuming would reintroduce
    // exactly the context the user asked to be rid of.
    expect(row?.sdkSessionId).toBeUndefined()
  })
})

describe("deleteResourceWorkbenchSession", () => {
  it("removes the aside and its messages", async () => {
    const extra = await createResourceWorkbenchSession(binding, "Doomed")
    await persistMessages(extra.id, [uiMsg("m1", "hello")])

    await deleteResourceWorkbenchSession(extra.id)

    expect(await getDb().sessions.get(extra.id)).toBeUndefined()
    expect(await listMessages(extra.id)).toHaveLength(0)
  })
})

describe("promoteResourceWorkbenchSession", () => {
  it("keeps a promoted primary visible and creates one fresh primary shared across windows", async () => {
    const id = await seedPrimary()
    await persistMessages(id, [uiMsg("kept-message", "Keep this conversation")])
    await promoteResourceWorkbenchSession(id)
    const repository = createResourceSessionRepository()
    const first = await ensureResourceWorkbenchSession(binding, "Fresh", repository, "window-a")
    const second = await ensureResourceWorkbenchSession(binding, "Fresh", repository, "window-b")
    expect(first.id).not.toBe(id)
    expect(second.id).toBe(first.id)
    expect((await getDb().sessions.get(id))?.kind).toBe("direct")
    expect(isSessionExposed((await getDb().sessions.get(id))!, "main-list")).toBe(true)
    expect(await listMessages(id)).toHaveLength(1)
    expect(await listMessages(first.id)).toHaveLength(0)
    expect((await listResourceWorkbenchSessions(binding)).map((row) => row.id)).toEqual([first.id])
  })

  it("clears every marker that kept it out of the rails, in place", async () => {
    const extra = await createResourceWorkbenchSession(binding, "Worth keeping")
    await persistMessages(extra.id, [uiMsg("m1", "hello")])

    const promoted = await promoteResourceWorkbenchSession(extra.id)

    expect(promoted.kind).toBe("direct")
    expect(isSessionExposed(promoted, "main-list")).toBe(true)
    const row = await getDb().sessions.get(extra.id)
    // `isEmbeddedSession` reads kind OR visibility — clearing one and not the
    // other would leave it hidden with no surface able to render it.
    expect(row?.visibility).toBeUndefined()
    expect(row?.surfaceBinding).toBeUndefined()
    expect(row?.surfaceBindingKey).toBeUndefined()
    // Same id, so permalinks into the aside survive being promoted.
    expect(promoted.id).toBe(extra.id)
    expect(await listMessages(extra.id)).toHaveLength(1)
  })

  it("keeps the workspace so the promoted row is reachable from the sidebar", async () => {
    const extra = await createResourceWorkbenchSession(binding, "Worth keeping")
    const promoted = await promoteResourceWorkbenchSession(extra.id)
    expect(promoted.projectId).toBe("proj-main")
  })

  it("drops out of the binding list once promoted", async () => {
    const primaryId = await seedPrimary()
    const extra = await createResourceWorkbenchSession(binding, "Leaving")
    await promoteResourceWorkbenchSession(extra.id)
    const ids = (await listResourceWorkbenchSessions(binding)).map((s) => s.id)
    expect(ids).toEqual([primaryId])
  })

  it("refuses a session that is not an aside", async () => {
    await expect(promoteResourceWorkbenchSession("main-1")).rejects.toThrow(/not an aside/)
  })

  it("refuses a missing session", async () => {
    await expect(promoteResourceWorkbenchSession("nope")).rejects.toThrow(/not found/)
  })
})

describe("advanceResourceAsideContextCursor", () => {
  const cursor = { sdkSessionId: "sdk", parentMessageId: "m1", tailFingerprint: "hash" }

  it("records a cursor for the same live session-bound aside SDK history", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "sdk" })
    await advanceResourceAsideContextCursor(id, cursor)
    expect((await getDb().sessions.get(id))?.asideContextCursor).toEqual(cursor)
  })

  it("does not reintroduce a cursor after clear or SDK replacement", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "sdk" })
    await clearResourceWorkbenchSession(id)
    await advanceResourceAsideContextCursor(id, cursor)
    expect((await getDb().sessions.get(id))?.asideContextCursor).toBeUndefined()
    await getDb().sessions.update(id, { sdkSessionId: "replacement" })
    await advanceResourceAsideContextCursor(id, cursor)
    expect((await getDb().sessions.get(id))?.asideContextCursor).toBeUndefined()
  })

  it("does not restore aside state after promotion or for another resource kind", async () => {
    const id = await seedPrimary()
    await getDb().sessions.update(id, { sdkSessionId: "sdk" })
    await promoteResourceWorkbenchSession(id)
    await advanceResourceAsideContextCursor(id, cursor)
    expect((await getDb().sessions.get(id))?.asideContextCursor).toBeUndefined()
    const artifact = await createResourceWorkbenchSession(
      { kind: "artifact", artifactId: "a" },
      "Artifact"
    )
    await getDb().sessions.update(artifact.id, { sdkSessionId: "sdk" })
    await advanceResourceAsideContextCursor(artifact.id, cursor)
    expect((await getDb().sessions.get(artifact.id))?.asideContextCursor).toBeUndefined()
  })
})
