jest.mock("@/lib/db/messages", () => ({
  ...jest.requireActual("@/lib/db/messages"),
  persistMessages: jest.fn().mockResolvedValue(undefined),
  persistStreamingMessages: jest.fn().mockResolvedValue(undefined),
}))

import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import {
  executePersonalExternalTurn,
  createExternalIdleEventConsumer,
  asideProviderHistoryMode,
  asideContextForRegenerate,
  resolveChatTurnAttemptIdentity,
  localChatRunAuthorization,
  chatHookCredentialContext,
  resolveNativeExternalSessionId,
  externalSessionVisibilityMatches,
  useClaudeChat,
  userPromptText,
  rewriteUserPromptText,
  applyChatCommandOverrides,
  externalTurnPrompt,
  externalAsideTurnContent,
  redirectSendToBundleAliases,
} from "./use-claude-chat-controller"
import type { SendContentBlock, SendOptions } from "@cognia/agent-config-types"
import { gateWorkbenchProviderPayload } from "@/lib/context-workbench/provider-payload"
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
    const { result } = renderHook(() => useClaudeChat())
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
    const { result } = renderHook(() => useClaudeChat())
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
    const { result } = renderHook(() => useClaudeChat())
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
    const { result } = renderHook(() => useClaudeChat())
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
    const { result, unmount } = renderHook(() => useClaudeChat())
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
    expect(typeof useClaudeChat).toBe("function")
    expect(useClaudeChat.name).toBe("useClaudeChat")
  })

  it("keeps durable-work behavior covered by the public hook contract suite", () => {
    // The behavioral tests live in use-claude-chat.test.ts because that suite
    // owns the hook's full sidecar/store harness. Keep this seam explicit so a
    // future split cannot silently drop acceptance/claim/handoff coverage.
    expect(typeof useClaudeChat).toBe("function")
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
  // hook contract suite in `use-claude-chat.test.ts`; this seam test remains
  // intentionally dependency-free so import regressions fail quickly.
})

describe("attachment prompt hook isolation", () => {
  const content = [
    { type: "text" as const, text: "PRIVATE ATTACHMENT BODY" },
    { type: "text" as const, text: "Summarize the report" },
    { type: "text" as const, text: "Unrelated appended context" },
  ]
  it("selects only the authored block after attachment provenance", () => {
    expect(userPromptText(content, 1)).toBe("Summarize the report")
    expect(userPromptText(content.slice(0, 1), 1)).toBe("")
  })
  it("rewrites only authored prose and preserves every attachment/context block", () => {
    expect(rewriteUserPromptText(content, "Rewritten request", 1)).toEqual([
      content[0],
      { type: "text", text: "Rewritten request" },
      content[2],
    ])
    expect(rewriteUserPromptText(content.slice(0, 1), "Do not replace the file", 1)).toEqual(
      content.slice(0, 1)
    )
    expect(rewriteUserPromptText("original", "new")).toBe("new")
  })
})

describe("externalTurnPrompt", () => {
  const doc = { type: "text" as const, text: "EXTRACTED REPORT BODY" }
  const typed = { type: "text" as const, text: "Summarize the report" }
  const link = { type: "text" as const, text: "Fetched page context" }
  const image: Extract<SendContentBlock, { type: "image" }> = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
  }
  const video: SendContentBlock = {
    type: "document",
    source: { type: "base64", media_type: "video/mp4", data: "AAAA" },
  }
  /** Nothing left out. */
  const none = { attachments: [], unnamed: 0 }

  it("sends a plain-string turn whole", () => {
    expect(externalTurnPrompt("fix the bug")).toEqual({
      request: "fix the bug",
      prompt: "fix the bug",
      images: [],
      omitted: none,
    })
  })

  it("reads the question past an extracted document and keeps the document ahead of it", () => {
    expect(externalTurnPrompt([doc, typed], 1)).toEqual({
      request: "Summarize the report",
      prompt: "EXTRACTED REPORT BODY\n\nSummarize the report",
      images: [],
      omitted: none,
    })
  })

  it("hands over an image beside its OCR text, by the attachment it came from", () => {
    const ocr = { type: "text" as const, text: "OCR LINES" }
    expect(externalTurnPrompt([image, ocr, doc, typed], 3)).toEqual({
      request: "Summarize the report",
      prompt: "OCR LINES\n\nEXTRACTED REPORT BODY\n\nSummarize the report",
      images: [{ block: image, attachment: 0 }],
      omitted: none,
    })
  })

  it("keeps provider lines in front and the fetched link context after the question", () => {
    const reply = { type: "text" as const, text: '[Replying to: "earlier"]' }
    expect(externalTurnPrompt([reply, doc, typed, link], 1, 1)).toEqual({
      request: "Summarize the report",
      prompt:
        '[Replying to: "earlier"]\n\nEXTRACTED REPORT BODY\n\nSummarize the report\n\nFetched page context',
      images: [],
      omitted: none,
    })
  })

  it("sends the question and its links when nothing is attached", () => {
    expect(externalTurnPrompt([typed, link], 0)).toEqual({
      request: "Summarize the report",
      prompt: "Summarize the report\n\nFetched page context",
      images: [],
      omitted: none,
    })
    expect(externalTurnPrompt([image, typed], 1)).toEqual({
      request: "Summarize the report",
      prompt: "Summarize the report",
      images: [{ block: image, attachment: 0 }],
      omitted: none,
    })
  })

  it("sends the attachment text alone when nothing was typed", () => {
    expect(externalTurnPrompt([doc], 1)).toEqual({
      request: "",
      prompt: "EXTRACTED REPORT BODY",
      images: [],
      omitted: none,
    })
  })

  it("names every frame of a sampled video by its one attachment", () => {
    const caption = { type: "text" as const, text: "Video: clip.mp4, 4 frames" }
    const frame = { ...image, source: { ...image.source, data: "frame" } }
    expect(externalTurnPrompt([caption, frame, frame, typed], 3).images).toEqual([
      { block: frame, attachment: 1 },
      { block: frame, attachment: 2 },
    ])
  })

  it("leaves out only blocks that are neither text nor an image, and ignores empty text", () => {
    expect(externalTurnPrompt([video, typed], 1).omitted).toEqual({ attachments: [0], unnamed: 0 })
    const result = externalTurnPrompt([typed, image, video, { type: "text", text: "  " }], 0)
    expect(result.omitted).toEqual({ attachments: [], unnamed: 1 })
    // An image no manifest names still goes, unnamed.
    expect(result.images).toEqual([{ block: image, attachment: null }])
    expect(result.prompt).toBe("Summarize the report")
  })
})

describe("redirectSendToBundleAliases", () => {
  // The owning workspace's two roots, as a canonical bundle checks them out.
  const lease = { primaryAlias: "/isolated/app", additionalAliases: ["/isolated/docs"] }
  const aliasesBySource = new Map([
    ["/repo", "/isolated/app"],
    ["/docs", "/isolated/docs"],
  ])
  const sourceSend: SendOptions = {
    model: "sonnet",
    cwd: "/repo",
    additionalDirectories: ["/docs"],
    trustedWorkspaceRoots: ["/repo", "/docs"],
  }
  /** What the sidecar honours: a trusted root that is also active for the send. */
  const honoured = (options: SendOptions) => {
    const active = [options.cwd, ...(options.additionalDirectories ?? [])]
    return (options.trustedWorkspaceRoots ?? []).filter((root) => active.includes(root))
  }

  it("moves the trust proof onto the aliases the send now runs in", () => {
    const redirected = redirectSendToBundleAliases(sourceSend, lease, aliasesBySource)

    expect(redirected).toEqual({
      model: "sonnet",
      cwd: "/isolated/app",
      additionalDirectories: ["/isolated/docs"],
      trustedWorkspaceRoots: ["/isolated/app", "/isolated/docs"],
    })
    // Without the remap the source paths are inactive and prove nothing, so
    // the sidecar refused every requested claudeAgentSdk skill or plugin.
    expect(honoured({ ...redirected, trustedWorkspaceRoots: ["/repo", "/docs"] })).toEqual([])
    expect(honoured(redirected)).toEqual(["/isolated/app", "/isolated/docs"])
  })

  it("grants an alias only the trust of the exact source root it checks out", () => {
    const redirected = redirectSendToBundleAliases(
      // "/docs" was never trusted; "/repo/packages/app" is a different root
      // from "/repo" and its grant was never given for "/isolated/app".
      { ...sourceSend, trustedWorkspaceRoots: ["/repo/packages/app", " /repo "] },
      lease,
      aliasesBySource
    )

    expect(redirected.trustedWorkspaceRoots).toEqual(["/repo/packages/app", "/isolated/app"])
    expect(honoured(redirected)).toEqual(["/isolated/app"])
  })

  it("keeps an aliased proof when the turn lease re-points the same bundle again", () => {
    const bound = redirectSendToBundleAliases(sourceSend, lease, aliasesBySource)
    const leased = redirectSendToBundleAliases(bound, lease, aliasesBySource)

    expect(leased.trustedWorkspaceRoots).toEqual(["/isolated/app", "/isolated/docs"])
  })

  it("keeps the directories the send named, moving the ones inside a checked-out root into it", () => {
    const redirected = redirectSendToBundleAliases(
      {
        ...sourceSend,
        // An @-referenced folder elsewhere, one inside the app checkout, a slash
        // command's path, the docs root itself, and the primary root again.
        additionalDirectories: ["/notes", "/repo/src", "/docs", "/shared/fixtures", "/repo"],
      },
      lease,
      aliasesBySource
    )

    expect(redirected.cwd).toBe("/isolated/app")
    expect(redirected.additionalDirectories).toEqual([
      "/isolated/docs",
      "/notes",
      "/isolated/app/src",
      "/shared/fixtures",
    ])
  })

  it("keeps a project root the bundle did not check out as it was", () => {
    const redirected = redirectSendToBundleAliases(
      { ...sourceSend, additionalDirectories: ["/docs"] },
      { primaryAlias: "/isolated/app", additionalAliases: [] },
      new Map([["/repo", "/isolated/app"]])
    )

    expect(redirected.additionalDirectories).toEqual(["/docs"])
  })

  it("adds no proof to a send that carried none", () => {
    const { trustedWorkspaceRoots: _dropped, ...untrusted } = sourceSend
    const redirected = redirectSendToBundleAliases(untrusted, lease, aliasesBySource)

    expect(redirected).not.toHaveProperty("trustedWorkspaceRoots")
    expect(redirected.cwd).toBe("/isolated/app")
  })
})

describe("native external session continuation", () => {
  beforeEach(() => {
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId: "pi" },
      sessionRuntimeRefs: {},
      sessionExternalLinks: {},
    })
  })

  it("continues the selected fork instead of the original tool-host session", () => {
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink("chat", { agentId: "pi", sessionId: "forked-native" })
    expect(
      resolveNativeExternalSessionId("chat", "pi", {
        agentId: "pi",
        nativeSessionId: "original-native",
      })
    ).toBe("forked-native")
  })

  it("retains the native lane when the most recent link names a gateway task", () => {
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink("chat", { agentId: "pi", sessionId: "cognia-gateway:task:session" })
    expect(
      resolveNativeExternalSessionId("chat", "pi", {
        agentId: "pi",
        nativeSessionId: "original-native",
      })
    ).toBe("original-native")
    expect(
      resolveNativeExternalSessionId("chat", "codex", {
        agentId: "pi",
        nativeSessionId: "original-native",
      })
    ).toBeUndefined()
  })
})

describe("autonomous external turns", () => {
  it("persists delayed output and scopes approval while ignoring ordinary delivery and old links", async () => {
    const { useChatStore } = await import("@/stores/chat/chat-store")
    const messagesDb = await import("@/lib/db/messages")
    const { SessionCoalescingRegistry } = await import("@/lib/chat/stream-coalescing")
    const persist = jest.mocked(messagesDb.persistMessages).mockClear()
    const persistStreaming = jest.mocked(messagesDb.persistStreamingMessages).mockClear()
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId: "pi" },
      sessionRuntimeRefs: {},
      sessionExternalLinks: {},
    })
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink("idle-chat", { agentId: "pi", sessionId: "native-idle" })
    useChatStore.getState().replaceSessionMessages("idle-chat", [])
    const registry = new SessionCoalescingRegistry({
      onCommit: (id, messages) => useChatStore.getState().replaceSessionMessages(id, messages),
      onPersist: () => {},
      persistDelayMs: 0,
    })
    const consume = createExternalIdleEventConsumer("idle-chat", "pi", "native-idle", registry)
    const base = {
      sessionId: "native-idle",
      timestamp: new Date(),
      delivery: "out_of_band" as const,
    }
    try {
      await consume({ ...base, type: "session_start" })
      await consume({
        ...base,
        type: "content_block_start",
        role: "user",
        messageId: "extension-user",
        block: { type: "text", text: "background request" },
      })
      await consume({
        ...base,
        type: "message_delta",
        delta: { type: "text", text: "delayed answer" },
      })
      await consume({
        ...base,
        delivery: undefined,
        type: "message_delta",
        delta: { type: "text", text: "duplicate" },
      })
      await consume({
        ...base,
        type: "permission_request",
        request: {
          id: "idle-approve",
          toolInfo: {
            id: "bash",
            name: "bash",
            description: "Run shell",
            parameters: { type: "object" },
          },
        },
      })
      expect(
        useChatStore
          .getState()
          .sessions["idle-chat"].pendingApprovals.some(
            (approval) =>
              approval.sessionId === "idle-chat" && approval.requestId.includes("idle-approve")
          )
      ).toBe(true)
      await consume({ ...base, type: "done", success: true })
      expect(persist).toHaveBeenCalledWith(
        "idle-chat",
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            parts: [expect.objectContaining({ type: "text", text: "background request" })],
            // Out-of-band input the runtime reported, never the person's
            // instruction (ADR-0239).
            metadata: { automatedTurn: { producer: "external-runtime" } },
          }),
          expect.objectContaining({
            role: "assistant",
            parts: [expect.objectContaining({ type: "text", text: "delayed answer" })],
          }),
        ])
      )
      expect(useChatStore.getState().sessions["idle-chat"].status).toBe("idle")
      const count = persist.mock.calls.length
      useAgentRuntimeStore
        .getState()
        .setSessionExternalLink("idle-chat", { agentId: "pi", sessionId: "forked" })
      await consume({ ...base, type: "session_start" })
      await consume({
        ...base,
        type: "message_delta",
        delta: { type: "text", text: "old process" },
      })
      await consume({ ...base, type: "done", success: true })
      expect(persist).toHaveBeenCalledTimes(count)
    } finally {
      persist.mockClear()
      persistStreaming.mockClear()
      registry.release("idle-chat")
    }
  })
  it("flushes a detached autonomous reply and refuses late events", async () => {
    const { useChatStore } = await import("@/stores/chat/chat-store")
    const { SessionCoalescingRegistry } = await import("@/lib/chat/stream-coalescing")
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId: "pi" },
      sessionRuntimeRefs: {},
      sessionExternalLinks: {},
    })
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink("detach-chat", { agentId: "pi", sessionId: "detached-native" })
    useChatStore.getState().replaceSessionMessages("detach-chat", [])
    const persist = jest.fn()
    const registry = new SessionCoalescingRegistry({
      onCommit: (id, messages) => useChatStore.getState().replaceSessionMessages(id, messages),
      onPersist: persist,
      persistDelayMs: 10000,
    })
    const consume = createExternalIdleEventConsumer(
      "detach-chat",
      "pi",
      "detached-native",
      registry
    )
    const base = {
      delivery: "out_of_band" as const,
      sessionId: "detached-native",
      timestamp: new Date(),
    }
    await consume({ ...base, type: "session_start" })
    await consume({
      ...base,
      type: "message_delta",
      delta: { type: "text", text: "retained partial" },
    })
    expect(persist).not.toHaveBeenCalled()
    await consume.dispose()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState().sessions["detach-chat"].messages[0].parts).toEqual([
      expect.objectContaining({ type: "text", text: "retained partial" }),
    ])
    await consume({ ...base, type: "message_delta", delta: { type: "text", text: "discard late" } })
    expect(persist).toHaveBeenCalledTimes(1)
  })
})

describe("aside provider-history ownership", () => {
  it("uses incremental context only for native SDK resumes", () => {
    expect(asideProviderHistoryMode({}, false)).toBe("sdk-resume")
    expect(asideProviderHistoryMode({ provider: "anthropic" }, false)).toBe("sdk-resume")
  })
  it("rebuilds every standalone turn, including Anthropic API turns", () => {
    expect(asideProviderHistoryMode({ provider: "anthropic" }, true)).toBe("rebuild")
    expect(asideProviderHistoryMode({ provider: "openai" }, true)).toBe("rebuild")
  })
  it("rebuilds retained AI SDK loops so permission grants and full context stay current", () => {
    expect(
      asideProviderHistoryMode({ provider: "openai", expectedRuntimeSessionId: "retained" }, false)
    ).toBe("rebuild")
    expect(
      asideProviderHistoryMode(
        { provider: "anthropic", execution: { runtimeAdapter: "ai-sdk" } } as SendOptions,
        false
      )
    ).toBe("rebuild")
  })
})

it("reuses provider-only context only for the same regenerated user turn", () => {
  const captured = { messageId: "user-a", context: "original parent", header: "reference" }
  expect(asideContextForRegenerate(captured, "user-a")).toBe(captured)
  // Live steering or a send from another window can replace the latest user row.
  expect(asideContextForRegenerate(captured, "user-b")).toBeUndefined()
  expect(asideContextForRegenerate(captured, undefined)).toBeUndefined()
})

it("sends full parent snapshots on external lanes without borrowing the SDK cursor", () => {
  expect(
    asideProviderHistoryMode(
      { execution: { runtimeAdapter: "external" } } as unknown as SendOptions,
      false
    )
  ).toBe("rebuild")
})

it("fails closed if a non-direct runtime escapes aside routing", () => {
  expect(asideProviderHistoryMode({ routerFusionRun: {} } as SendOptions, false)).toBe(
    "unsupported"
  )
})

it("delivers side-question framing to external prompts without changing transcript content", () => {
  const typed = [{ type: "text" as const, text: "Explain this function" }]
  const content = externalAsideTurnContent(typed, true)
  const turn = externalTurnPrompt(content, 0, 1)
  expect(typed).toEqual([{ type: "text", text: "Explain this function" }])
  expect(turn.request).toBe("Explain this function")
  expect(turn.prompt).toContain("[Side chat]")
  expect(turn.prompt).toContain("reference material only")
  expect(turn.prompt).toContain("enable editing")
  expect(externalAsideTurnContent("Explain this function", false)).not.toContain("enable editing")
})

it("gates the full external side-chat prompt while leaving the typed transcript untouched", () => {
  const typed = [{ type: "text" as const, text: "Explain the report from jane@example.com" }]
  const gated = gateWorkbenchProviderPayload(
    { content: externalAsideTurnContent(typed, true), messages: [], sendOptions: {} },
    "Parent contact jane@example.com",
    "Main conversation — reference only"
  )
  const turn = externalTurnPrompt(gated.content, 0, 2)
  expect(turn.prompt).toContain("[Main conversation — reference only]")
  expect(turn.prompt).toContain("[Side chat]")
  expect(turn.prompt).not.toContain("jane@example.com")
  expect(typed[0].text).toContain("jane@example.com")
})

it("uses the Host user-message constructor for staged personal attachment marks", () => {
  const { makeUserMessage } = jest.requireActual("@/lib/claude/adapter")
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

it("R10 external chat dispatch binds the exact Host run without changing prompt or options", async () => {
  const { personalEgressOptionsSource } = await import("@/lib/execution/personal-egress")
  const options = {
    agentId: "external",
    context: { custom: { conversationHistory: "clean history" } },
  }
  const execute = jest.fn(async (_prompt: string, _options: typeof options) => "done")
  const source = { sessionId: "chat", executionRunId: "host-chat-run" }
  await expect(executePersonalExternalTurn(execute, "next", options, source)).resolves.toBe("done")
  expect(execute).toHaveBeenCalledWith("next", options)
  expect(personalEgressOptionsSource(execute.mock.calls[0]?.[1])).toBe(source)
  expect(options).toEqual({
    agentId: "external",
    context: { custom: { conversationHistory: "clean history" } },
  })
})
