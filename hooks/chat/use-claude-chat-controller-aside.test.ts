/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import type { UIMessage } from "ai"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { clearMessages, listMessages } from "@/lib/db/messages"
import { useChatStore } from "@/stores/chat"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { runStandaloneTurn } from "@/lib/ai/chat/standalone-engine"
import { executeOnRemoteHostAgent } from "@/lib/ai/agent/external/runtimes/remote/remote-execute"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { useClaudeChat } from "./use-claude-chat-controller"

// Keep the real controller, canonical history, context builder and PII gate.
// Only the provider and unrelated host services are replaced at their ports.
let mockHostRuntime: AgentRuntimeRef | undefined
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-execute", () => ({
  executeOnRemoteHostAgent: jest.fn(),
  remoteApprovalDecisionId: (run: string, request: string) => `${run}:${request}`,
}))
jest.mock("@/lib/claude/build-options", () => {
  const actual = jest.requireActual("@/lib/claude/build-options")
  return {
    ...actual,
    resolvedSessionAsideRuntime: (options: unknown) =>
      mockHostRuntime ?? actual.resolvedSessionAsideRuntime(options),
  }
})
jest.mock("@/lib/ai/agent/external/session/session-models", () => ({
  ...jest.requireActual("@/lib/ai/agent/external/session/session-models"),
  assertExternalRuntimeFeatureSupport: jest.fn(async () => undefined),
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({ isStandaloneChatMode: () => true }))
jest.mock("@/lib/ai/chat/standalone-engine", () => ({
  runStandaloneTurn: jest.fn(async () => undefined),
}))
jest.mock("./claude-chat-send-options", () => ({
  ...jest.requireActual("./claude-chat-send-options"),
  buildSendOptions: jest.fn(async () => ({
    provider: "openai",
    model: "test-model",
    permissionMode: mockHostRuntime ? "default" : "plan",
    allowedTools: [],
    ...(mockHostRuntime ? {} : { toolSurface: "none" }),
    contentSafety: { injectionProtection: false },
  })),
}))
jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  onClaudeMessage: jest.fn(async () => () => {}),
  turnsRunOnPairedHost: jest.fn(() => false),
}))
jest.mock("@/lib/files/project-editor-bridge", () => ({
  flushProjectEditorEdits: jest.fn(async () => []),
}))
jest.mock("@/lib/telemetry/events/track-event", () => ({ trackEvent: jest.fn(async () => true) }))
jest.mock("@/lib/execution/direct-chat-run", () => {
  const actual = jest.requireActual("@/lib/execution/direct-chat-run")
  return {
    ...actual,
    startDirectChatExecutionRun: jest.fn(async (...args: unknown[]) => {
      if (mockHostRuntime) await actual.startDirectChatExecutionRun(...args)
    }),
    finishDirectChatExecutionRun: jest.fn(async (...args: unknown[]) => {
      if (mockHostRuntime) await actual.finishDirectChatExecutionRun(...args)
    }),
    recordDirectChatSdkMessage: jest.fn(async () => undefined),
  }
})
jest.mock("@/lib/execution/chat-lease", () => ({
  ...jest.requireActual("@/lib/execution/chat-lease"),
  acquireChatLease: jest.fn(async () => () => {}),
}))
jest.mock("@/lib/chat/canonical-sink", () => ({
  ...jest.requireActual("@/lib/chat/canonical-sink"),
  recordChatCanonicalEvents: jest.fn(async () => undefined),
}))

const fixture = createDbTestFixture({ seeded: false })
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
afterEach(() => {
  mockHostRuntime = undefined
  jest.mocked(executeOnRemoteHostAgent).mockReset()
})

it("redacts fresh parent context at the session-aside controller to standalone boundary", async () => {
  const parentId = "parent-pii-regression"
  const asideId = "aside-pii-regression"
  const parentMessages: UIMessage[] = [
    {
      id: "parent-answer",
      role: "assistant",
      parts: [
        { type: "text", text: "Contact jane@example.com about the report." },
        {
          type: "file",
          filename: "report.png",
          mediaType: "image/png",
          url: "data:image/png;base64,U0VDUkVUX0JZVEVT",
        },
      ],
    },
  ]
  await getDb().sessions.bulkPut([
    { id: parentId, title: "Parent", kind: "direct", createdAt: 1, updatedAt: 1 },
    {
      id: asideId,
      title: "Side question",
      kind: "resource-workbench",
      visibility: "embedded",
      surfaceBinding: { kind: "session", sessionId: parentId },
      asidePinnedParentMessageIds: [parentMessages[0].id],
      createdAt: 1,
      updatedAt: 1,
    },
  ])
  await getDb().messages.put({
    id: parentMessages[0].id,
    role: parentMessages[0].role,
    parts: parentMessages[0].parts,
    sessionId: parentId,
    createdAt: 1,
  })
  useAgentRuntimeStore.setState({ runtimeRef: { kind: "builtin" }, sessionRuntimeRefs: {} })
  useChatStore.getState().replaceSessionMessages(parentId, parentMessages)
  useChatStore.getState().setActiveSession(asideId)
  const { result, unmount } = renderHook(useClaudeChat)
  try {
    await act(async () => {
      await expect(
        result.current.send("Who should I contact?", undefined, {
          replyTo: { messageId: "parent-answer", preview: "The report" },
        })
      ).resolves.toBe(true)
    })
    expect(runStandaloneTurn).toHaveBeenCalledTimes(1)
    const dispatched = jest.mocked(runStandaloneTurn).mock.calls[0][0]
    expect(dispatched.sessionId).toBe(asideId)
    const providerMessages = JSON.stringify(dispatched.messages)
    expect(providerMessages).toContain("Contact")
    expect(providerMessages).toContain("Messages the user pinned from the main conversation")
    expect(providerMessages).toContain("Who should I contact?")
    expect(dispatched.messages.at(-1)?.parts).toContainEqual({
      type: "text",
      text: '[Replying to: "The report"]',
    })
    expect(providerMessages).not.toContain("jane@example.com")
    expect(providerMessages).toContain("[attached file: report.png (image/png)]")
    expect(providerMessages).not.toContain("U0VDUkVUX0JZVEVT")
    expect(parentMessages[0].parts).toEqual([
      { type: "text", text: "Contact jane@example.com about the report." },
      {
        type: "file",
        filename: "report.png",
        mediaType: "image/png",
        url: "data:image/png;base64,U0VDUkVUX0JZVEVT",
      },
    ])
    expect((await getDb().messages.get("parent-answer"))?.parts).toEqual(parentMessages[0].parts)
  } finally {
    unmount()
  }
})

it("sends the empty-parent snapshot after a clear even when the parent UI cache is stale", async () => {
  await fixture.restore()
  jest.mocked(runStandaloneTurn).mockClear()
  const parentId = "parent-cleared"
  const asideId = "aside-after-clear"
  const staleParent: UIMessage = {
    id: "old-parent",
    role: "user",
    parts: [{ type: "text", text: "PARENT_CONTEXT_TO_FORGET" }],
  }
  const ownMessage: UIMessage = {
    id: "own-question",
    role: "user",
    parts: [{ type: "text", text: "Keep my side question" }],
  }
  await getDb().sessions.bulkPut([
    { id: parentId, title: "Main", kind: "direct", createdAt: 1, updatedAt: 1 },
    {
      id: asideId,
      title: "Aside",
      kind: "resource-workbench",
      visibility: "embedded",
      surfaceBinding: { kind: "session", sessionId: parentId },
      surfaceBindingKey: `session:${parentId}`,
      sdkSessionId: "old-aside-sdk",
      asidePinnedParentMessageIds: [staleParent.id],
      asideContextCursor: {
        sdkSessionId: "old-aside-sdk",
        parentMessageId: staleParent.id,
        tailFingerprint: "old",
      },
      lastMessageAt: 2,
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  await getDb().messages.bulkPut([
    {
      id: staleParent.id,
      role: staleParent.role,
      parts: staleParent.parts,
      sessionId: parentId,
      createdAt: 1,
    },
    {
      id: ownMessage.id,
      role: ownMessage.role,
      parts: ownMessage.parts,
      sessionId: asideId,
      createdAt: 2,
    },
  ])
  useAgentRuntimeStore.setState({ runtimeRef: { kind: "builtin" }, sessionRuntimeRefs: {} })
  useChatStore.getState().replaceSessionMessages(parentId, [staleParent])
  useChatStore.getState().replaceSessionMessages(asideId, [ownMessage])
  useChatStore.getState().setActiveSession(asideId)
  await clearMessages(parentId)
  const retired = await getDb().sessions.get(asideId)
  expect(retired?.sdkSessionId).toBeUndefined()
  expect(retired?.asideContextCursor).toBeUndefined()
  expect(retired?.asidePinnedParentMessageIds).toBeUndefined()
  expect(retired?.asideParentClearedAt).toEqual(expect.any(Number))
  expect((await listMessages(asideId)).map((message) => message.id)).toEqual([ownMessage.id])
  const { result, unmount } = renderHook(useClaudeChat)
  try {
    await act(async () => {
      await expect(result.current.send("Continue the side question")).resolves.toBe(true)
    })
    expect(runStandaloneTurn).toHaveBeenCalledTimes(1)
    const dispatched = jest.mocked(runStandaloneTurn).mock.calls[0][0]
    const providerMessages = JSON.stringify(dispatched.messages)
    expect(providerMessages).toContain("[The main conversation currently has no visible messages.]")
    expect(providerMessages).toContain("Keep my side question")
    expect(providerMessages).not.toContain("PARENT_CONTEXT_TO_FORGET")
    expect(dispatched.sendOptions.resumeSessionId).toBeUndefined()
  } finally {
    unmount()
  }
})

it.each([true, false])(
  "keeps the remote reset pending through refusal and consumes it only after supported acceptance (%s)",
  async (supportsReset) => {
    await fixture.restore()
    const parentId = "remote-parent"
    const asideId = "remote-aside"
    await getDb().sessions.bulkPut([
      { id: parentId, title: "Main", kind: "direct", createdAt: 1, updatedAt: 1 },
      {
        id: asideId,
        title: "Aside",
        kind: "resource-workbench",
        visibility: "embedded",
        surfaceBinding: { kind: "session", sessionId: parentId },
        surfaceBindingKey: `session:${parentId}`,
        asideWriteAccess: true,
        externalAgentSession: { agentId: "cfg", sessionId: "old-native" },
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    mockHostRuntime = { kind: "host", configId: "cfg", revision: "rev", lifecycleGeneration: 1 }
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "builtin" },
      sessionRuntimeRefs: { [parentId]: mockHostRuntime },
      sessionExternalLinks: {},
    })
    useChatStore.getState().replaceSessionMessages(parentId, [])
    useChatStore.getState().replaceSessionMessages(asideId, [])
    useChatStore.getState().setActiveSession(asideId)
    await clearMessages(parentId)
    let attempt = 0
    jest.mocked(executeOnRemoteHostAgent).mockImplementation(async (_prompt, options) => {
      options.onEvent?.({ type: "session_start", sessionId: "fresh-native", timestamp: new Date() })
      // The stream alone must not consume the marker, even before a refusal.
      await Promise.resolve()
      if (attempt < 2)
        expect((await getDb().sessions.get(asideId))?.externalAgentSession).toBeUndefined()
      if (attempt++ === 0) return null
      options.onStarted?.(supportsReset && options.resetExternalSession === true)
      return {
        runId: "remote-run",
        success: true,
        sessionId: "fresh-native",
        finalResponse: "Reply",
        messages: [],
        steps: [],
        toolCalls: [],
        duration: 1,
      }
    })
    const { result, unmount } = renderHook(useClaudeChat)
    try {
      await act(async () => {
        await result.current.send("After clear")
      })
      expect(executeOnRemoteHostAgent).toHaveBeenCalledTimes(1)
      expect(jest.mocked(executeOnRemoteHostAgent).mock.calls[0][1].resetExternalSession).toBe(true)
      expect((await getDb().sessions.get(asideId))?.externalAgentSession).toBeUndefined()
      await act(async () => {
        await result.current.send("Retry")
      })
      expect(executeOnRemoteHostAgent).toHaveBeenCalledTimes(2)
      expect(jest.mocked(executeOnRemoteHostAgent).mock.calls[1][1].resetExternalSession).toBe(true)
      const retained = (await getDb().sessions.get(asideId))?.externalAgentSession
      if (supportsReset) expect(retained?.sessionId).toBe("fresh-native")
      else expect(retained).toBeUndefined()
      if (supportsReset) {
        await act(async () => {
          await result.current.send("Continue fresh session")
        })
        expect(executeOnRemoteHostAgent).toHaveBeenCalledTimes(3)
        expect(
          jest.mocked(executeOnRemoteHostAgent).mock.calls[2][1].resetExternalSession
        ).toBeUndefined()
      }
    } finally {
      unmount()
    }
  }
)
