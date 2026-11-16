jest.mock("@/lib/db/messages", () => ({
  ...jest.requireActual("@/lib/db/messages"),
  persistMessages: jest.fn().mockResolvedValue(undefined),
  persistStreamingMessages: jest.fn().mockResolvedValue(undefined),
}))

import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { useAgentChat } from "./use-agent-chat-controller"
import {
  resolveChatTurnAttemptIdentity,
  localChatRunAuthorization,
  chatHookCredentialContext,
  externalSessionVisibilityMatches,
  applyChatCommandOverrides,
} from "./agent-chat-turn-helpers"

import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { applyRunAuthorityToSendOptions } from "@/lib/execution/run-authority"
import {
  guardBuiltinSessionHostSend,
  registerSessionHostPromptHandler,
  type SessionHostPromptHandler,
} from "@/lib/chat/session-host-binding"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"
import { act, renderHook } from "@testing-library/react"
import { acquireSessionTurnLease } from "@/lib/execution/session-turn-lock"
import { useChatStore } from "@/stores/chat/chat-store"

jest.mock("@/lib/execution/session-turn-lock", () => ({
  ...jest.requireActual("@/lib/execution/session-turn-lock"),
  acquireSessionTurnLease: jest.fn(),
}))

const promptSessionHostSend = jest.fn<
  ReturnType<SessionHostPromptHandler>,
  Parameters<SessionHostPromptHandler>
>(async () => false)
jest.mock("@/lib/task-workspace/origin", () => ({
  ...jest.requireActual("@/lib/task-workspace/origin"),
  callTaskWorkspaceOrigin: jest.fn(async () => ({
    roots: [{ path: "/host/repo", source: "desktop-project" }],
  })),
}))

describe("public built-in send Host guard before turn admission", () => {
  const fixture = createDbTestFixture({ seeded: false })
  const remoteState = useRemoteHostStore.getState()
  const runtimeState = useAgentRuntimeStore.getState()
  beforeAll(fixture.initialize)
  afterAll(fixture.dispose)
  beforeEach(async () => {
    await fixture.restore()
    promptSessionHostSend.mockReset().mockResolvedValue(false)
    registerSessionHostPromptHandler(promptSessionHostSend)
    jest.mocked(acquireSessionTurnLease).mockReset()
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "builtin" }, sessionRuntimeRefs: {} })
    useRemoteHostStore.setState({
      hosts: ["a", "b"].map(
        (id) =>
          ({
            id,
            label: `Host ${id}`,
            connectionState: "ready",
            capabilities: ["sidecar"],
            config: {},
          }) as RemoteHost
      ),
      activeHostId: "b",
    })
  })
  afterEach(() => {
    useRemoteHostStore.setState(remoteState, true)
    useAgentRuntimeStore.setState(runtimeState, true)
  })

  it("holds an unattended send back without waiting on a dialog, whatever the UI answers", async () => {
    promptSessionHostSend.mockResolvedValue(true)
    await getDb().sessions.put({
      id: "s",
      title: "A",
      createdAt: 1,
      updatedAt: 1,
      hostBinding: { origin: { kind: "remote", hostId: "a" } },
    })
    expect(await guardBuiltinSessionHostSend("s", { interactive: false })).toBe(false)
    expect(promptSessionHostSend).toHaveBeenCalledTimes(1)
    expect(promptSessionHostSend).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "switch-required", interactive: false })
    )
  })

  it("still binds an unbound session on an unattended send", async () => {
    await getDb().sessions.put({ id: "s", title: "A", createdAt: 1, updatedAt: 1 })
    expect(await guardBuiltinSessionHostSend("s", { interactive: false })).toMatchObject({
      origin: { kind: "remote", hostId: "b" },
    })
    expect(promptSessionHostSend).not.toHaveBeenCalled()
  })

  it("refuses, never sends elsewhere, when no prompt UI is installed", async () => {
    registerSessionHostPromptHandler(promptSessionHostSend)()
    await getDb().sessions.put({
      id: "s",
      title: "A",
      createdAt: 1,
      updatedAt: 1,
      hostBinding: { origin: { kind: "remote", hostId: "a" } },
    })
    expect(await guardBuiltinSessionHostSend("s")).toBe(false)
    expect(promptSessionHostSend).not.toHaveBeenCalled()
  })

  it("blocks a session bound to A while B is active and offers switching to A", async () => {
    const hostBinding = {
      origin: { kind: "remote" as const, hostId: "a" },
      workspaceRoot: "/a/repo",
    }
    await getDb().sessions.put({ id: "s", title: "A", createdAt: 1, updatedAt: 1, hostBinding })
    expect(await guardBuiltinSessionHostSend("s")).toBe(false)
    expect(promptSessionHostSend).toHaveBeenCalledWith({
      sessionId: "s",
      binding: hostBinding,
      decision: "switch-required",
      interactive: true,
    })
    expect((await getDb().sessions.get("s"))?.hostBinding).toEqual(hostBinding)
  })

  it("blocks actual send before admission when A is bound and B is active", async () => {
    await getDb().sessions.put({
      id: "s",
      title: "Bound",
      createdAt: 1,
      updatedAt: 1,
      hostBinding: { origin: { kind: "remote", hostId: "a" } },
    })
    const { result } = renderHook(() => useAgentChat())
    await act(async () => {
      expect(await result.current.send("hello", undefined, { sessionId: "s" })).toBe(false)
    })
    expect(acquireSessionTurnLease).not.toHaveBeenCalled()
    expect(promptSessionHostSend).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "switch-required" })
    )
  })

  it("persists the first binding before actual send attempts admission", async () => {
    await getDb().sessions.put({ id: "s", title: "New", createdAt: 1, updatedAt: 1 })
    jest.mocked(acquireSessionTurnLease).mockImplementationOnce(async () => {
      expect((await getDb().sessions.get("s"))?.hostBinding).toEqual({
        origin: { kind: "remote", hostId: "b" },
        workspaceRoot: "/host/repo",
      })
      return null
    })
    const { result } = renderHook(() => useAgentChat())
    await act(async () => {
      await expect(result.current.send("hello", undefined, { sessionId: "s" })).rejects.toThrow(
        "session_turn_busy"
      )
    })
    expect(acquireSessionTurnLease).toHaveBeenCalledWith("s", true)
  })

  it("releases admission and refuses dispatch if the target changes while admission waits", async () => {
    useRemoteHostStore.setState({ activeHostId: "a" })
    await getDb().sessions.put({
      id: "s",
      title: "Bound",
      createdAt: 1,
      updatedAt: 1,
      hostBinding: { origin: { kind: "remote", hostId: "a" } },
    })
    const release = jest.fn(async () => undefined)
    jest.mocked(acquireSessionTurnLease).mockImplementationOnce(async () => {
      useRemoteHostStore.setState({ activeHostId: "b" })
      return release
    })
    const { result } = renderHook(() => useAgentChat())
    await act(async () => {
      expect(await result.current.send("hello", undefined, { sessionId: "s" })).toBe(false)
    })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("refuses a concurrent session rebind while admission waits even if the active Host stays A", async () => {
    useRemoteHostStore.setState({ activeHostId: "a" })
    await getDb().sessions.put({
      id: "s",
      title: "Bound",
      createdAt: 1,
      updatedAt: 1,
      hostBinding: { origin: { kind: "remote", hostId: "a" }, workspaceRoot: "/a" },
    })
    const release = jest.fn(async () => undefined)
    jest.mocked(acquireSessionTurnLease).mockImplementationOnce(async () => {
      await getDb().sessions.update("s", {
        hostBinding: { origin: { kind: "remote", hostId: "b" }, workspaceRoot: "/b" },
      })
      return release
    })
    const { result } = renderHook(() => useAgentChat())
    await act(async () => {
      expect(await result.current.send("hello", undefined, { sessionId: "s" })).toBe(false)
    })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("does not re-guard a dispatch joining a live turn lease", async () => {
    useRemoteHostStore.setState({ activeHostId: "a" })
    await getDb().sessions.put({
      id: "s",
      title: "Bound",
      createdAt: 1,
      updatedAt: 1,
      hostBinding: { origin: { kind: "remote", hostId: "a" } },
    })
    const previousChat = useChatStore.getState()
    const release = jest.fn(async () => undefined)
    jest.mocked(acquireSessionTurnLease).mockResolvedValueOnce(release)
    const { result, unmount } = renderHook(() => useAgentChat())
    try {
      act(() => useChatStore.getState().setSessionStatus("s", "streaming"))
      // Empty content stops before provider work while the streaming slice
      // retains the admitted lease, just as an awaited live turn does.
      await act(async () => {
        expect(await result.current.send("", undefined, { sessionId: "s" })).toBe(false)
      })
      await getDb().sessions.update("s", {
        hostBinding: { origin: { kind: "remote", hostId: "b" } },
      })
      await act(async () => {
        expect(await result.current.send("", undefined, { sessionId: "s" })).toBe(false)
      })
      expect(acquireSessionTurnLease).toHaveBeenCalledTimes(1)
      expect(promptSessionHostSend).not.toHaveBeenCalled()
    } finally {
      act(() => useChatStore.getState().setSessionStatus("s", "idle"))
      unmount()
      useChatStore.setState(previousChat, true)
    }
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("binds an unbound session to the active Host and its reported workspace before admission", async () => {
    await getDb().sessions.put({ id: "s", title: "New", createdAt: 1, updatedAt: 1 })
    expect(await guardBuiltinSessionHostSend("s")).toMatchObject({
      origin: { kind: "remote", hostId: "b" },
    })
    expect((await getDb().sessions.get("s"))?.hostBinding).toEqual({
      origin: { kind: "remote", hostId: "b" },
      workspaceRoot: "/host/repo",
    })
    expect(promptSessionHostSend).not.toHaveBeenCalled()
  })

  it("offers unavailable recovery and never changes the binding to a ready alternative", async () => {
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((host) =>
        host.id === "b" ? { ...host, connectionState: "disconnected" } : host
      ),
    }))
    const hostBinding = { origin: { kind: "remote" as const, hostId: "b" } }
    await getDb().sessions.put({
      id: "s",
      title: "Offline",
      createdAt: 1,
      updatedAt: 1,
      hostBinding,
    })
    expect(await guardBuiltinSessionHostSend("s")).toBe(false)
    expect(promptSessionHostSend).toHaveBeenCalledWith({
      sessionId: "s",
      binding: hostBinding,
      decision: "host-unavailable",
      interactive: true,
    })
    expect((await getDb().sessions.get("s"))?.hostBinding).toEqual(hostBinding)
  })

  it("rechecks live state after Wait before allowing the original bound Host", async () => {
    useRemoteHostStore.setState({ activeHostId: "a" })
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((host) =>
        host.id === "a" ? { ...host, connectionState: "connecting" } : host
      ),
    }))
    await getDb().sessions.put({
      id: "s",
      title: "Waiting",
      createdAt: 1,
      updatedAt: 1,
      hostBinding: { origin: { kind: "remote", hostId: "a" } },
    })
    promptSessionHostSend.mockImplementationOnce(async () => {
      useRemoteHostStore.setState((state) => ({
        hosts: state.hosts.map((host) =>
          host.id === "a" ? { ...host, connectionState: "ready" } : host
        ),
      }))
      return true
    })
    expect(await guardBuiltinSessionHostSend("s")).toMatchObject({
      origin: { kind: "remote", hostId: "a" },
    })
  })
})

jest.mock("@/lib/db/execution-runs", () => ({
  ...jest.requireActual("@/lib/db/execution-runs"),
  getExecutionRun: jest.fn(),
}))

describe("Claude chat controller seam", () => {
  it.each([false, true])(
    "keeps slash command additions within ancestors only (restricted=%s)",
    (restricted) => {
      const options = applyChatCommandOverrides(
        {
          allowedTools: ["A", "B"],
          runAuthority: { schemaVersion: 1, tools: { allow: ["A", "B"] } },
        },
        { allowedTools: ["C"] }
      )
      expect(options.runAuthority?.tools?.allow).toEqual(["A", "B"])
      applyRunAuthorityToSendOptions(
        options,
        restricted ? { schemaVersion: 1, tools: { allow: ["A", "B"] } } : { schemaVersion: 1 }
      )
      expect(options.allowedTools).toEqual(restricted ? ["A", "B"] : ["A", "B", "C"])
    }
  )
  it("rebuilds an external session when another reader joins, including legacy persisted links", () => {
    expect(externalSessionVisibilityMatches(undefined, "owner-only", ["private"])).toBe(false)
    expect(externalSessionVisibilityMatches({}, "owner-only", ["private"])).toBe(false)
    expect(
      externalSessionVisibilityMatches({ personalVisibilityDigest: "owner-only" }, "two-readers", [
        "private",
      ])
    ).toBe(false)
    expect(
      externalSessionVisibilityMatches({ personalVisibilityDigest: "owner-only" }, "owner-only", [
        "private",
      ])
    ).toBe(true)
  })
  it("retains external history on a fully visible upgrade or owner-only loosening", () => {
    expect(externalSessionVisibilityMatches(undefined, "owner-only", [])).toBe(true)
    expect(externalSessionVisibilityMatches({}, "owner-only", [])).toBe(true)
    expect(
      externalSessionVisibilityMatches(
        { personalVisibilityDigest: "two-readers" },
        "owner-only",
        []
      )
    ).toBe(true)
  })
  it("uses local proof only before a new run and keeps an existing run's identity", async () => {
    jest.mocked(getExecutionRun).mockResolvedValueOnce(undefined)
    await expect(chatHookCredentialContext("session", "run", LOCAL_PERSON_RUN)).resolves.toEqual({
      sessionId: "session",
      localAuthorization: LOCAL_PERSON_RUN,
      executionRunReserved: true,
    })
    jest.mocked(getExecutionRun).mockResolvedValueOnce({ id: "run" } as never)
    await expect(chatHookCredentialContext("session", "run", LOCAL_PERSON_RUN)).resolves.toEqual({
      sessionId: "session",
      executionRunId: "run",
    })
    jest.mocked(getExecutionRun).mockRejectedValueOnce(new Error("journal unavailable"))
    await expect(chatHookCredentialContext("session", "run", LOCAL_PERSON_RUN)).resolves.toEqual({
      sessionId: "session",
      executionRunId: "run",
      executionRunReserved: true,
    })
    await expect(chatHookCredentialContext("session", "run")).resolves.toEqual({
      sessionId: "session",
      executionRunId: "run",
      executionRunReserved: true,
    })
  })
  it("requires a positive host gesture and refuses automation even if it carries a gesture", () => {
    expect(localChatRunAuthorization()).toBeUndefined()
    expect(
      localChatRunAuthorization(
        JSON.parse(JSON.stringify({ localAuthorization: LOCAL_PERSON_RUN }))
      )
    ).toBeUndefined()
    expect(
      localChatRunAuthorization({ localAuthorization: Symbol("host-local-person-run") as never })
    ).toBeUndefined()
    expect(localChatRunAuthorization({ localAuthorization: LOCAL_PERSON_RUN })).toBe(
      LOCAL_PERSON_RUN
    )
    expect(
      localChatRunAuthorization({
        localAuthorization: LOCAL_PERSON_RUN,
        automatedTurn: "coordinator",
      })
    ).toBeUndefined()
    expect(
      localChatRunAuthorization({ localAuthorization: LOCAL_PERSON_RUN, backgroundDelivery: {} })
    ).toBeUndefined()
  })

  it("keeps a typed turn's admitted Host proof for hooks before any branch writes its row", async () => {
    jest.mocked(getExecutionRun).mockResolvedValueOnce(undefined)
    await expect(
      chatHookCredentialContext("thread", "not-created", LOCAL_PERSON_RUN, "parent")
    ).resolves.toEqual({
      sessionId: "thread",
      localAuthorization: LOCAL_PERSON_RUN,
      executionRunReserved: true,
      executionRunParentId: "parent",
    })
  })
  it("exports the public hook implementation", () => {
    expect(typeof useAgentChat).toBe("function")
    expect(useAgentChat.name).toBe("useAgentChat")
  })

  it("keeps durable-work behavior covered by the public hook contract suite", () => {
    // The behavioral tests live in use-agent-chat.test.ts because that suite
    // owns the hook's full sidecar/store harness. Keep this seam explicit so a
    // future split cannot silently drop acceptance/claim/handoff coverage.
    expect(typeof useAgentChat).toBe("function")
  })

  it("keeps turn stable and increments attempt across regenerate/retry", () => {
    const attempts = new Map<string, number>()
    const messages = [{ id: "user-1", role: "user", parts: [] }] as never
    const first = resolveChatTurnAttemptIdentity({
      sessionId: "s1",
      runId: "r1",
      messages: [],
      reuseLastUserTurn: false,
      attempts,
      mintTurnId: () => "user-1",
    })
    const retry = resolveChatTurnAttemptIdentity({
      sessionId: "s1",
      runId: "r1",
      messages,
      reuseLastUserTurn: true,
      attempts,
    })
    expect(first).toEqual({ runId: "r1", turnId: "user-1", attemptId: "a1" })
    expect(retry).toEqual({ runId: "r1", turnId: "user-1", attemptId: "a2" })
  })

  // Paired sends preserve provider credentials on direct Agent RPC; that behavior
  // and HostState send/steer/abort/approval branches are exercised by the public
  // hook contract suite in `use-agent-chat.test.ts`; this seam test remains
  // intentionally dependency-free so import regressions fail quickly.
})

it("uses the Host user-message constructor for staged personal attachment marks", () => {
  const { makeUserMessage } = jest.requireActual("@/lib/chat/sdk-message-adapter")
  const message = makeUserMessage([{ type: "text", text: "document body" }], "controller-doc", [
    {
      kind: "text",
      remoteDocument: {
        v: 1,
        providerId: "google",
        resourceKind: "doc",
        resourceId: "abcdefghijklmnop1234",
        url: "https://docs.google.com/document/d/abcdefghijklmnop1234/edit",
        title: "Private",
        fetchedAt: 12,
        completeness: { status: "complete" },
      },
    },
  ])
  expect(message.metadata?.personalMarks).toEqual([
    { person: { kind: "local-person" }, source: "google-docs", markedAt: 12 },
  ])
})
