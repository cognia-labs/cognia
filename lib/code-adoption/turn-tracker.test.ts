jest.mock("@/lib/task-workspace/client", () => ({
  settleTaskWorkspaceTurn: jest.fn(),
  turnRecordId: (sessionId: string, runId: number) => `${sessionId}:${runId}:epoch`,
}))
jest.mock("@/lib/db/messages", () => ({ listRecentMessages: jest.fn() }))
jest.mock("./client", () => ({
  endCodeAdoptionTurn: jest.fn(),
  consumeCodeAdoptionTrackingAttempt: jest.fn(),
}))
jest.mock("./persist", () => ({
  ...jest.requireActual("./persist"),
  getCodeAdoptionTurn: jest.fn(),
  persistCodeAdoptionTurn: jest.fn(),
  pruneCodeAdoptionTurns: jest.fn(),
}))
let mockDatabaseName = "account-A"
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: mockDatabaseName }) }))
const mockChatState: {
  activeSessionId: string | null
  messages: unknown[]
  sessions: Record<string, { messages?: unknown[] }>
} = {
  activeSessionId: null,
  messages: [],
  sessions: {},
}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { subscribe: jest.fn(), getState: () => mockChatState },
}))

import { listRecentMessages } from "@/lib/db/messages"
import { settleTaskWorkspaceTurn } from "@/lib/task-workspace/client"
import { useChatStore } from "@/stores/chat/chat-store"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"

import { consumeCodeAdoptionTrackingAttempt, endCodeAdoptionTurn } from "./client"
import { getCodeAdoptionTurn, persistCodeAdoptionTurn, pruneCodeAdoptionTurns } from "./persist"
import {
  closingAssistantMessageId,
  isSettleEdge,
  markTaskWorkspaceTurnCancelled,
  markTaskWorkspaceTurnUnowned,
  persistTaskWorkspaceTurn,
  persistUnavailableTaskWorkspaceTurn,
  startCodeAdoptionTracker,
} from "./turn-tracker"

const mockSettleTaskWorkspace = settleTaskWorkspaceTurn as jest.Mock
const mockSubscribe = useChatStore.subscribe as unknown as jest.Mock
const mockEnd = endCodeAdoptionTurn as jest.Mock
const mockAttempt = consumeCodeAdoptionTrackingAttempt as jest.Mock
const mockPersist = persistCodeAdoptionTurn as jest.Mock
const mockGet = getCodeAdoptionTurn as jest.Mock
const mockPrune = pruneCodeAdoptionTurns as jest.Mock
const mockListRecent = listRecentMessages as jest.Mock

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  jest.clearAllMocks()
  mockDatabaseName = "account-A"
  mockAttempt.mockReturnValue(undefined)
  mockListRecent.mockResolvedValue([])
  mockGet.mockResolvedValue(undefined)
  mockChatState.activeSessionId = null
  mockChatState.messages = []
  mockChatState.sessions = {}
  useTaskWorkspaceStore.getState().clear()
  useTaskWorkspaceStore.getState().activate({
    taskId: "task",
    runId: "renderer-run",
    sessionId: "s1",
    workspaceRoot: "/repo",
    executionRoot: "/repo",
    state: "running",
  })
})

describe("closingAssistantMessageId", () => {
  it("returns the last assistant message after the last user message", () => {
    expect(
      closingAssistantMessageId([
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "u2", role: "user" },
        { id: "a2", role: "assistant" },
        { id: "a3", role: "assistant" },
      ])
    ).toBe("a3")
  })

  it("returns undefined when the turn produced no assistant message", () => {
    expect(
      closingAssistantMessageId([
        { id: "a1", role: "assistant" },
        { id: "u1", role: "user" },
      ])
    ).toBeUndefined()
    expect(closingAssistantMessageId([])).toBeUndefined()
  })
})

describe("isSettleEdge", () => {
  it.each([
    ["streaming", "idle", true],
    ["streaming", "error", true],
    ["awaiting_approval", "idle", true],
    ["awaiting_approval", "error", true],
    ["streaming", "awaiting_approval", false],
    ["idle", "streaming", false],
    [undefined, "idle", false],
  ])("%s -> %s = %s", (before, now, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isSettleEdge(before as any, now as any)).toBe(expected)
  })
})

describe("startCodeAdoptionTracker", () => {
  /** Releases handed out by `wire`, so one test's subscription cannot leak. */
  const held: Array<() => void> = []

  afterEach(() => {
    while (held.length) held.pop()?.()
  })

  function wire() {
    const storeUnsub = jest.fn()
    mockSubscribe.mockReturnValue(storeUnsub)
    const ret = startCodeAdoptionTracker()
    held.push(ret)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = mockSubscribe.mock.calls[0][0] as (s: any, p: any) => void
    return { fn, storeUnsub, ret }
  }

  it.each(["account-B", "account-A-host-B"])(
    "does not index or prune a settled account-A turn after switching to %s",
    async (nextDatabase) => {
      let finish!: (resources: unknown[]) => void
      mockSettleTaskWorkspace.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      mockEnd.mockResolvedValueOnce({ id: "s1:3", files: [] })
      const error = jest.spyOn(console, "error").mockImplementation(() => {})
      try {
        const { fn } = wire()
        fn(
          { sessions: { s1: { status: "idle", runId: 3 } } },
          { sessions: { s1: { status: "streaming", runId: 3 } } }
        )
        mockDatabaseName = nextDatabase
        finish([])
        await flush()
        expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 3, "ready")
        expect(mockPersist).not.toHaveBeenCalled()
        expect(mockPrune).not.toHaveBeenCalled()
      } finally {
        error.mockRestore()
      }
    }
  )

  it("ends and persists on a settle edge", async () => {
    const row = { id: "s1:3" }
    mockListRecent.mockResolvedValue([
      { id: "u", role: "user" },
      { id: "a-closing", role: "assistant" },
    ])
    mockEnd.mockResolvedValue(row)
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 3, "ready")
    expect(mockEnd).toHaveBeenCalledWith("s1:3")
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s1:3:epoch",
        measurement: "legacyFingerprint",
        assistantMessageId: "a-closing",
      }),
      { databaseName: "account-A" }
    )
    expect(mockPrune).toHaveBeenCalled()
  })

  it("does not use a new account after delayed legacy reconciliation", async () => {
    let finish!: (value: null) => void
    mockSettleTaskWorkspace.mockResolvedValueOnce([])
    mockEnd.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { fn } = wire()
      fn(
        { sessions: { s1: { status: "idle", runId: 3 } } },
        { sessions: { s1: { status: "streaming", runId: 3 } } }
      )
      await flush()
      mockDatabaseName = "account-B"
      finish(null)
      await flush()
      expect(mockEnd).toHaveBeenCalledWith("s1:3")
      expect(mockPersist).not.toHaveBeenCalled()
      expect(mockPrune).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it("reads the closing message from the live transcript when the session is on screen", async () => {
    mockEnd.mockResolvedValue({ id: "s1:2" })
    mockChatState.activeSessionId = "s1"
    mockChatState.messages = [
      { id: "u", role: "user" },
      { id: "a-live", role: "assistant" },
    ]
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 2 } } },
      { sessions: { s1: { status: "streaming", runId: 2 } } }
    )
    await flush()
    expect(mockListRecent).not.toHaveBeenCalled()
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s1:2:epoch", assistantMessageId: "a-live" }),
      { databaseName: "account-A" }
    )
  })

  it("pins the ending message before delayed legacy reconciliation lets the next turn advance", async () => {
    let finishLegacy!: (value: null) => void
    mockEnd.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finishLegacy = resolve
        })
    )
    mockSettleTaskWorkspace.mockResolvedValueOnce([
      {
        path: "first.ts",
        origin: "agent",
        captureClass: "source",
        kind: "modified",
        insertions: 1,
        deletions: 0,
      },
    ])
    mockChatState.activeSessionId = "s1"
    mockChatState.messages = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
    ]
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 1 } } },
      { sessions: { s1: { status: "streaming", runId: 1 } } }
    )
    await flush()
    mockChatState.messages = [
      ...mockChatState.messages,
      { id: "u2", role: "user" },
      { id: "a2", role: "assistant" },
    ]
    finishLegacy(null)
    await flush()
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 1, assistantMessageId: "a1" }),
      { databaseName: "account-A" }
    )
  })

  it("does not attach a failed turn with no assistant to a later turn's message", async () => {
    let finishLegacy!: (value: null) => void
    mockEnd.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finishLegacy = resolve
        })
    )
    mockSettleTaskWorkspace.mockResolvedValueOnce([
      {
        path: "partial.ts",
        origin: "agent",
        captureClass: "source",
        kind: "modified",
        insertions: 1,
        deletions: 0,
      },
    ])
    mockChatState.activeSessionId = "s1"
    mockChatState.messages = [{ id: "u1", role: "user" }]
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "error", runId: 1 } } },
      { sessions: { s1: { status: "streaming", runId: 1 } } }
    )
    await flush()
    mockChatState.messages = [
      { id: "u2", role: "user" },
      { id: "a2", role: "assistant" },
    ]
    finishLegacy(null)
    await flush()
    expect(mockPersist.mock.calls[0][0]).not.toHaveProperty("assistantMessageId")
  })

  it("prefers a background session's in-memory slice over the persisted tail", async () => {
    mockEnd.mockResolvedValue({ id: "s1:8" })
    mockChatState.sessions = {
      s1: {
        messages: [
          { id: "u", role: "user" },
          { id: "a-slice", role: "assistant" },
        ],
      },
    }
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 8 } } },
      { sessions: { s1: { status: "streaming", runId: 8 } } }
    )
    await flush()
    expect(mockListRecent).not.toHaveBeenCalled()
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({ assistantMessageId: "a-slice" }),
      { databaseName: "account-A" }
    )
  })

  it("still persists the record when the closing message cannot be read", async () => {
    mockEnd.mockResolvedValue({ id: "s1:6" })
    mockListRecent.mockRejectedValue(new Error("db closed"))
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 6 } } },
      { sessions: { s1: { status: "streaming", runId: 6 } } }
    )
    await flush()
    const persisted = mockPersist.mock.calls[0][0]
    expect(persisted.id).toBe("s1:6:epoch")
    expect(persisted).not.toHaveProperty("assistantMessageId")
  })

  it("does nothing without a settle edge", async () => {
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "awaiting_approval", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockEnd).not.toHaveBeenCalled()
  })

  it("skips persist when the turn was not tracked", async () => {
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "error", runId: 1 } } },
      { sessions: { s1: { status: "streaming", runId: 1 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 1, "failed")
    expect(mockEnd).toHaveBeenCalledWith("s1:1")
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockPrune).not.toHaveBeenCalled()
  })

  it("settles a user-aborted turn as cancelled", async () => {
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    markTaskWorkspaceTurnCancelled("s1", 5)
    fn(
      { sessions: { s1: { status: "idle", runId: 5 } } },
      { sessions: { s1: { status: "streaming", runId: 5 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 5, "cancelled")
  })

  it("detaches the store subscription when its last holder releases", () => {
    const { ret, storeUnsub } = wire()
    ret()
    expect(storeUnsub).toHaveBeenCalledTimes(1)
    // Releasing twice must not detach a subscription a later start reopened.
    ret()
    expect(storeUnsub).toHaveBeenCalledTimes(1)
  })

  /**
   * Two chunks mount the initializer — the core-chat one and the
   * workflow-automation one — and outside development the eager boot profile
   * requests both, so this runs twice. Two listeners meant `settleTurn` ran
   * twice per edge, and every mark it consumes is a `Set.delete`: the first
   * subscriber took the mark and the second, seeing none, did the exact thing
   * the mark exists to prevent.
   */
  describe("mounted by more than one boot chunk", () => {
    it("subscribes once and settles once per edge", async () => {
      mockEnd.mockResolvedValue(null)
      const { fn } = wire()
      wire()

      expect(mockSubscribe).toHaveBeenCalledTimes(1)
      fn(
        { sessions: { s1: { status: "idle", runId: 3 } } },
        { sessions: { s1: { status: "streaming", runId: 3 } } }
      )
      await flush()
      expect(mockSettleTaskWorkspace).toHaveBeenCalledTimes(1)
    })

    it("keeps the store attached until the last holder releases", () => {
      const { storeUnsub, ret } = wire()
      const second = wire()

      ret()
      expect(storeUnsub).not.toHaveBeenCalled()
      second.ret()
      expect(storeUnsub).toHaveBeenCalledTimes(1)
    })

    // The mark is consumed by a `Set.delete`, so a second subscriber saw no
    // mark and settled the previous, still-live turn's working copy.
    it("does not let a second mount defeat the unowned mark", async () => {
      mockEnd.mockResolvedValue(null)
      const { fn } = wire()
      wire()
      markTaskWorkspaceTurnUnowned("s1", 9)

      fn(
        { sessions: { s1: { status: "idle", runId: 9 } } },
        { sessions: { s1: { status: "streaming", runId: 9 } } }
      )
      await flush()

      expect(mockSettleTaskWorkspace).not.toHaveBeenCalled()
    })

    // Same hole, older mark: an interrupted turn was settled once as
    // `cancelled` and once as `ready`.
    it("does not let a second mount defeat the cancelled mark", async () => {
      mockEnd.mockResolvedValue(null)
      const { fn } = wire()
      wire()
      markTaskWorkspaceTurnCancelled("s1", 10)

      fn(
        { sessions: { s1: { status: "idle", runId: 10 } } },
        { sessions: { s1: { status: "streaming", runId: 10 } } }
      )
      await flush()

      expect(mockSettleTaskWorkspace).toHaveBeenCalledTimes(1)
      expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 10, "cancelled")
    })
  })

  /**
   * A turn refused the working copy never opened a run of its own, so
   * `activeBySession` still holds the PREVIOUS turn's — very often the live one
   * that caused the refusal. Settling it here tore the working copy out from
   * under a turn whose agent was still streaming.
   */
  it("settles nothing for a turn that never owned the workspace run", async () => {
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    markTaskWorkspaceTurnUnowned("s1", 6)
    fn(
      { sessions: { s1: { status: "idle", runId: 6 } } },
      { sessions: { s1: { status: "streaming", runId: 6 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).not.toHaveBeenCalled()
  })

  it("settles the captured renderer owner after a resource-only refresh", async () => {
    useTaskWorkspaceStore.getState().reconcileRun("renderer-run", [])
    expect(useTaskWorkspaceStore.getState().ownedRunBySession.s1).toBe("renderer-run")
    mockEnd.mockResolvedValueOnce(null)
    mockSettleTaskWorkspace.mockResolvedValueOnce([])
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 3, "ready")
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        taskWorkspaceRunId: "renderer-run",
        taskWorkspaceRuns: [expect.objectContaining({ runId: "renderer-run" })],
      }),
      { databaseName: "account-A" }
    )
  })

  // The mark names one turn, not the conversation: the next turn does own its
  // run and must settle it.
  it("only skips the turn that was marked", async () => {
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    markTaskWorkspaceTurnUnowned("s1", 6)
    fn(
      { sessions: { s1: { status: "idle", runId: 6 } } },
      { sessions: { s1: { status: "streaming", runId: 6 } } }
    )
    await flush()
    fn(
      { sessions: { s1: { status: "idle", runId: 7 } } },
      { sessions: { s1: { status: "streaming", runId: 7 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledTimes(1)
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 7, "ready")
  })

  // The only subscriber to this edge, so a throw here is the last chance
  // anything hears that a turn did not close out.
  it("reports a settle that throws instead of swallowing it", async () => {
    const reported: unknown[][] = []
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => void reported.push(args))
    mockSettleTaskWorkspace.mockRejectedValue(new Error("host unreachable"))
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 8 } } },
      { sessions: { s1: { status: "streaming", runId: 8 } } }
    )
    await flush()
    expect(reported).toHaveLength(1)
    expect(reported[0][0]).toBe("code adoption turn settle failed")
    expect(reported[0][1]).toMatchObject({ sessionId: "s1", runId: 8 })
    spy.mockRestore()
  })

  it("projects agent-only adoption metrics from the authoritative task ledger", async () => {
    mockSettleTaskWorkspace.mockResolvedValue([
      {
        path: "agent.ts",
        origin: "agent",
        kind: "modified",
        captureClass: "source",
        insertions: 4,
        deletions: 1,
      },
      {
        path: "dist/bundle.js",
        origin: "agent",
        kind: "created",
        captureClass: "generated",
        insertions: null,
        deletions: null,
      },
      { path: "notes.txt", origin: "user", kind: "created", insertions: 2, deletions: 0 },
    ])
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s1:3:epoch",
        workspaceRoot: "/repo",
        totalFiles: 1,
        totalAdded: 4,
        totalRemoved: 1,
        measurement: "taskWorkspace",
        adoptionState: "pending",
        proposedAdded: 4,
        acceptedAdded: 0,
      }),
      { databaseName: "account-A" }
    )
  })

  it("persists an unavailable coverage row instead of silently dropping a skipped turn", async () => {
    mockSettleTaskWorkspace.mockResolvedValue(null)
    mockEnd.mockResolvedValue(null)
    mockAttempt.mockReturnValue({
      cwd: "/repo",
      sessionId: "s1",
      runId: 4,
      model: "opus",
      agentKind: "in-app",
      status: "unavailable",
      reason: "concurrent",
    })
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 4 } } },
      { sessions: { s1: { status: "streaming", runId: 4 } } }
    )
    await flush()
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s1:4:epoch",
        trackingState: "unavailable",
        trackingReason: "concurrent",
      }),
      { databaseName: "account-A" }
    )
  })

  it("preserves an authoritative Host-owned capture when its idle edge has only legacy tracking", async () => {
    mockSettleTaskWorkspace.mockResolvedValueOnce(null)
    mockEnd.mockResolvedValueOnce({ totalFiles: 1, files: [{ path: "legacy.ts" }] })
    mockGet.mockResolvedValueOnce({
      id: "s1:3:epoch",
      measurement: "taskWorkspace",
      taskWorkspaceRunId: "host-run",
    })
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockGet).toHaveBeenCalledWith("s1:3:epoch", { databaseName: "account-A" })
    expect(mockPersist).not.toHaveBeenCalled()
  })

  it("keeps the Host-owned turn after a previous Local turn leaves a ready session run", async () => {
    const local = {
      taskId: "local-task",
      runId: "local-run",
      sessionId: "s1",
      workspaceRoot: "/local",
      executionRoot: "/local",
      state: "running" as const,
      origin: { kind: "local" as const },
    }
    useTaskWorkspaceStore.getState().activate(local)
    const localResources = [
      {
        runId: "local-run",
        path: "local.ts",
        origin: "agent",
        kind: "modified",
        insertions: 1,
        deletions: 0,
      },
    ]
    mockSettleTaskWorkspace.mockResolvedValue(localResources)
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 1 } } },
      { sessions: { s1: { status: "streaming", runId: 1 } } }
    )
    await flush()
    useTaskWorkspaceStore.getState().completeRun(local.runId, "ready", [])
    const host = await persistTaskWorkspaceTurn({
      sessionId: "s1",
      runId: 2,
      assistantMessageId: "host-assistant",
      runs: [
        { runId: "host-run", workspaceRoot: "/host", origin: { kind: "remote", hostId: "host-a" } },
      ],
      resources: [
        {
          runId: "host-run",
          path: "host.ts",
          origin: "agent",
          kind: "modified",
          insertions: 2,
          deletions: 0,
        } as Parameters<typeof persistTaskWorkspaceTurn>[0]["resources"][number],
      ],
    })
    mockGet.mockResolvedValue(host)
    mockSettleTaskWorkspace.mockClear()
    mockPersist.mockClear()
    fn(
      { sessions: { s1: { status: "idle", runId: 2 } } },
      { sessions: { s1: { status: "streaming", runId: 2 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).not.toHaveBeenCalled()
    expect(mockPersist).not.toHaveBeenCalled()
    expect(host).toMatchObject({
      taskWorkspaceRunId: "host-run",
      workspaceRoot: "/host",
      assistantMessageId: "host-assistant",
      origin: { kind: "remote", hostId: "host-a" },
    })
  })

  it("does not replace an authoritative terminal row even if stale settlement returns resources", async () => {
    mockSettleTaskWorkspace.mockResolvedValueOnce([
      { runId: "old-run", path: "old.ts", origin: "agent", kind: "modified" },
    ])
    mockEnd.mockResolvedValueOnce(null)
    mockGet.mockResolvedValueOnce({
      id: "s1:3:epoch",
      measurement: "taskWorkspace",
      taskWorkspaceRunId: "host-run",
    })
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockPersist).not.toHaveBeenCalled()
  })

  it("retains every root's run and source contribution without mixing same-path identities", async () => {
    const primary = {
      taskId: "task-primary",
      state: "running" as const,
      sessionId: "s1",
      runId: "r1",
      bundleTurnId: "bt",
      workspaceRoot: "/one",
      executionRoot: "/exec/one",
      origin: { kind: "remote" as const, hostId: "host-a" },
    }
    const other = { ...primary, runId: "r2", workspaceRoot: "/two", executionRoot: "/exec/two" }
    useTaskWorkspaceStore.getState().activate(other)
    useTaskWorkspaceStore.getState().activate(primary)
    mockSettleTaskWorkspace.mockResolvedValueOnce([
      {
        runId: "r1",
        path: "same.ts",
        origin: "agent",
        captureClass: "source",
        kind: "modified",
        insertions: 1,
        deletions: 0,
      },
      {
        runId: "r2",
        path: "same.ts",
        origin: "agent",
        captureClass: "source",
        kind: "modified",
        insertions: 2,
        deletions: 0,
      },
      {
        runId: "r2",
        path: "upload.txt",
        origin: "user",
        captureClass: "source",
        kind: "created",
        insertions: 3,
        deletions: 0,
      },
    ])
    mockEnd.mockResolvedValueOnce(null)
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 1 } } },
      { sessions: { s1: { status: "streaming", runId: 1 } } }
    )
    await flush()
    const record = mockPersist.mock.calls[0][0]
    expect(record.taskWorkspaceRuns).toEqual([
      {
        runId: "r1",
        workspaceRoot: "/one",
        executionRoot: "/exec/one",
        origin: { kind: "remote", hostId: "host-a" },
      },
      {
        runId: "r2",
        workspaceRoot: "/two",
        executionRoot: "/exec/two",
        origin: { kind: "remote", hostId: "host-a" },
      },
    ])
    expect(record.bundleTurnId).toBe("bt")
    expect(
      record.files.map(
        (file: { taskWorkspaceRunId: string; workspaceRoot: string; path: string }) => [
          file.taskWorkspaceRunId,
          file.workspaceRoot,
          file.path,
        ]
      )
    ).toEqual([
      ["r1", "/one", "same.ts"],
      ["r2", "/two", "same.ts"],
    ])
    expect(record.capturedFiles).toHaveLength(3)
    expect(record.capturedFiles[2]).toMatchObject({
      origin: "user",
      taskWorkspaceRunId: "r2",
      workspaceRoot: "/two",
    })
    expect(record.totalFiles).toBe(2)
  })
})

it("persists a Host-owned terminal capture with its explicit message and owner without a second settle", async () => {
  const record = await persistTaskWorkspaceTurn({
    id: "host-owned:turn",
    sessionId: "s1",
    runId: 4,
    assistantMessageId: "a4",
    agentKind: "codex",
    resources: [
      {
        runId: "host-run",
        path: "answer.ts",
        origin: "agent",
        captureClass: "source",
        kind: "created",
        insertions: 4,
        deletions: 0,
      } as never,
    ],
    runs: [
      { runId: "host-run", workspaceRoot: "/repo", origin: { kind: "remote", hostId: "host-a" } },
    ],
  })
  expect(mockSettleTaskWorkspace).not.toHaveBeenCalled()
  expect(record).toMatchObject({
    id: "host-owned:turn",
    assistantMessageId: "a4",
    agentKind: "codex",
    origin: { kind: "remote", hostId: "host-a" },
  })
  expect(record.capturedFiles?.[0]).toMatchObject({
    taskWorkspaceRunId: "host-run",
    workspaceRoot: "/repo",
  })
  expect(mockPersist).toHaveBeenCalledWith(record, { databaseName: "account-A" })
})

it.each([false, true])(
  "does not prune a new database when a %s unavailable projection write completes after switching",
  async (unavailable) => {
    mockPersist.mockImplementationOnce(async () => {
      mockDatabaseName = "account-B"
    })
    const input = { sessionId: "s1", runId: 3, assistantMessageId: "a3", runs: [] }
    const writing = unavailable
      ? persistUnavailableTaskWorkspaceTurn({ ...input, reason: "capture-failed" })
      : persistTaskWorkspaceTurn({ ...input, resources: [] })
    await expect(writing).rejects.toThrow(/database scope changed/i)
    expect(mockPersist).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }), {
      databaseName: "account-A",
    })
    expect(mockPrune).not.toHaveBeenCalled()
  }
)

it("keeps a failed remote manifest read unavailable with its known run owner", async () => {
  const runs = [
    {
      runId: "remote-run",
      workspaceRoot: "/remote/repo",
      origin: { kind: "remote" as const, hostId: "host-a" },
    },
  ]
  const record = await persistUnavailableTaskWorkspaceTurn({
    sessionId: "s1",
    runId: 9,
    assistantMessageId: "a9",
    reason: "capture-failed",
    runs,
  })
  expect(record).toMatchObject({
    measurement: "unavailable",
    trackingState: "unavailable",
    trackingReason: "capture-failed",
    taskWorkspaceRunId: "remote-run",
    taskWorkspaceRuns: runs,
    assistantMessageId: "a9",
  })
  expect(record).not.toHaveProperty("capturedFiles")
  expect(mockSettleTaskWorkspace).not.toHaveBeenCalled()
  expect(mockPersist).toHaveBeenCalledWith(record, { databaseName: "account-A" })
})
