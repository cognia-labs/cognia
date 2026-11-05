/** @jest-environment node */
/** Real capture, run identity, event conversion and persistence; transport and credentials are fake. */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import {
  clearMessages,
  deleteStoredMessage,
  commitMessageDelta,
  listMessages,
} from "@/lib/db/messages"
import {
  invalidateTranscriptRuntime,
  withTranscriptRuntimeLock,
} from "@/lib/chat/transcript/revision-events"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { onClaudeMessage, sendPrompt, closeSession } from "@/lib/claude/ipc"
import { runPluginAgentTurn } from "./agent-turn"
import { prepareTranscriptRuntimeSend } from "@/hooks/chat/claude-chat-send-options"
import { handleEvent } from "@/hooks/chat/claude-chat-events"
import type { ClaudeEvent } from "@cognia/agent-config-types"
import { resolveLarkAuth } from "@/lib/skills/built-in/lark/auth-bridge"
import { execLarkCli } from "@/lib/skills/built-in/lark/exec-lark-cli"
import { recordedRunMetadata, resolveRunActingIdentity } from "@/lib/execution/acting-authority"
import { connectorsKeyringGet, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { getTenantToken } from "@/lib/auth-providers/feishu/auth"
import { createUnattendedPark } from "@/lib/claude/unattended-park"
import { beginCapturedTurn } from "@/lib/policy/action-review/captured-turns"
import { resolveBuiltInSkillContext } from "@/lib/skills/built-in/context"
import { runBuiltInSkill } from "@/lib/skills/built-in/dispatcher"
import {
  registerBuiltInSkill,
  __resetSharedBuiltInSkillRegistry,
} from "@/lib/skills/built-in/registry"
import { buildConfirmSurface } from "@/lib/skills/built-in/_shared/confirm-surface"
import { z } from "zod"
import {
  registerChatMiddleware,
  __resetChatMiddlewareRegistryForTesting,
} from "@/lib/claude/chat-middleware/registry"
import {
  setChatMiddlewareExecutionEnabled,
  __resetChatMiddlewareFlagForTesting,
} from "@/lib/claude/chat-middleware/feature-flag"
import { runPluginAgent } from "@/lib/plugin/agent-sdk/run"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { executeAgentTurnFromRenderer } from "@/lib/ai/agent/execution/agent-execution-service"
import { __resetInterceptorRegistryForTesting } from "@/lib/plugin/interceptors"

jest.mock("@/lib/i18n/runtime-translator", () => ({ currentLocale: async () => "en" }))
jest.mock("@/lib/db/characters", () => ({
  ...jest.requireActual("@/lib/db/characters"),
  resolveCharacterById: async () => ({ id: "artist", name: "Artist" }),
}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: jest.fn(async () => ({ cwd: "/repo", provider: "anthropic" })),
}))
jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  onClaudeMessage: jest.fn(),
  sendPrompt: jest.fn(),
  closeSession: jest.fn(async () => {}),
  interruptSession: async () => {},
  approveTool: async () => {},
  toolResultDecision: async () => {},
  sessionControl: async () => null,
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({ isStandaloneChatMode: () => false }))
jest.mock("@/lib/claude/unattended-park", () => ({
  createUnattendedPark: jest.fn(() => ({
    park: jest.fn(),
    finish: async () => {},
    runId: () => null,
  })),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(async (_id: string, key: string) =>
    key === "appId" ? "app" : "secret"
  ),
  connectorsLarkUserAuth: jest.fn(),
}))
jest.mock("@/lib/auth-providers/feishu/auth", () => ({
  getTenantToken: jest.fn(async () => "tenant"),
}))

jest.mock("@/lib/ai/agent/execution/agent-execution-service", () => ({
  executeAgentTurnFromRenderer: jest.fn(),
}))
jest.mock("@/lib/ai/agent/background-agent-manager", () => ({
  getBackgroundAgentManager: () => ({
    registerAgent: () => new AbortController().signal,
    finishAgent: () => {},
  }),
}))

const fixture = createDbTestFixture()
const request = { characterId: "artist", cwd: "/repo", prompt: "Draw a picture", timeoutMs: 1_000 }
let listener: ((event: ClaudeEvent) => void) | undefined
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  jest
    .mocked(resolveSendOptions)
    .mockImplementation(async () => ({ cwd: "/repo", provider: "anthropic" }))
  jest
    .mocked(createUnattendedPark)
    .mockImplementation(() => ({ park: jest.fn(), finish: async () => {}, runId: () => null }))
  __resetChatMiddlewareRegistryForTesting()
  __resetInterceptorRegistryForTesting()
  __resetChatMiddlewareFlagForTesting()
  __resetSharedBuiltInSkillRegistry()
  jest.mocked(onClaudeMessage).mockImplementation(async (receive) => {
    listener = receive
    return () => {
      listener = undefined
    }
  })
})
afterAll(fixture.dispose)

it.each([
  "clear",
  "delete",
  "edit",
  "move",
  "recall",
  "role",
  "recall-native",
  "recall-ai",
  "clear-short",
  "edit-short",
  "recall-short",
] as const)(
  "cancels dispatch when middleware allows a user-row %s before beforeSend",
  async (mutation) => {
    const engine = jest.fn()
    let sessionId!: string
    setChatMiddlewareExecutionEnabled(true)
    registerChatMiddleware({
      pluginId: "prompt-race",
      middlewareId: "before-send",
      fn: async (_request, next) => {
        const user = (await getDb().messages.toArray()).find((row) => row.role === "user")!
        sessionId = user.sessionId
        if (mutation.startsWith("clear")) await clearMessages(sessionId)
        else if (mutation === "delete") await deleteStoredMessage(user.id)
        else if (mutation.startsWith("edit"))
          await withTranscriptRuntimeLock(sessionId, () =>
            commitMessageDelta(sessionId, {
              upserts: [{ id: user.id, role: "user", parts: [{ type: "text", text: "Changed" }] }],
            })
          )
        else
          await getDb().messages.update(
            user.id,
            mutation === "move"
              ? { sessionId: "another-session" }
              : mutation === "role"
                ? { role: "assistant" }
                : { metadata: { ...user.metadata, deletedAt: Date.now() } }
          )
        if (mutation === "recall-native") await invalidateTranscriptRuntime(sessionId)
        if (mutation.endsWith("short")) return { text: "Middleware response" }
        return next()
      },
    })
    jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
      // The real IPC keeps this same lock through preparation, beforeSend and
      // transport dispatch. Count only the engine call beyond that boundary.
      await withTranscriptRuntimeLock(id, async () => {
        await prepareTranscriptRuntimeSend(id, options ?? {}, {
          currentMessageId: delivery?.messageId,
        })
        await delivery?.beforeSend?.()
        engine()
        listener!({
          type: "event",
          sessionId: id,
          turnId: options?.turnId,
          event: {
            type: "assistant",
            uuid: "obsolete-reply",
            message: {
              id: "obsolete-reply",
              role: "assistant",
              content: [{ type: "text", text: "Obsolete" }],
            },
          },
        } as ClaudeEvent)
        listener!({ type: "session_ended", sessionId: id, turnId: options?.turnId } as ClaudeEvent)
      })
    })
    if (mutation === "recall-ai")
      jest
        .mocked(resolveSendOptions)
        .mockImplementation(async () => ({ cwd: "/repo", provider: "openai" }))
    const result = await runPluginAgentTurn(request, {
      grantSource: { kind: "bot", id: "prompt-race" },
      operationId: `race-${mutation}`,
    }).then(
      () => null,
      (error: unknown) => error
    )
    expect(engine).not.toHaveBeenCalled()
    expect(result).toMatchObject({ code: "aborted" })
    expect(
      (await getDb().executionRuns.where("sessionId").equals(sessionId).toArray()).filter((run) =>
        run.id.startsWith("execution:tool:")
      )
    ).toEqual([expect.objectContaining({ status: "cancelled" })])
    expect(
      (await getDb().messages.toArray()).find((row) => row.id === "obsolete-reply")
    ).toBeUndefined()
    // Admission records a pending operation; no reply result may ever land in it.
    const operations = (await getDb().sharedRunJournals.toArray()).map(
      (row) => row.agentTurnOperation
    )
    expect(operations.every((operation) => operation?.result === undefined)).toBe(true)
    if (mutation.startsWith("clear") || mutation === "delete") {
      expect(await listMessages(sessionId)).toEqual([])
      expect(operations).toEqual([expect.objectContaining({ deleted: true })])
    }
  }
)

it.each(["bot", "plugin"] as const)(
  "an unbound %s child waits on its parent's durable park",
  async (kind) => {
    let resolveApproval!: (outcome: { kind: "expired" }) => void
    const approval = new Promise<{ kind: "expired" }>((resolve) => {
      resolveApproval = resolve
    })
    let enteredPark!: () => void
    const parked = new Promise<void>((resolve) => {
      enteredPark = resolve
    })
    const park = jest.fn(() => {
      enteredPark()
      return approval
    })
    jest
      .mocked(createUnattendedPark)
      .mockReturnValue({ park, finish: async () => {}, runId: () => null })
    const execute = jest.fn(async () => ({ done: true }))
    registerBuiltInSkill({
      id: "im.test_write",
      family: "im",
      label: { en: "Write", "zh-CN": "写入" },
      description: { en: "Write", "zh-CN": "写入" },
      platforms: ["lark"],
      mutation: "write",
      imAccess: "always",
      mcpToolName: "im_test_write",
      inputSchema: z.object({}),
      execute,
      hitlSurface: () =>
        buildConfirmSurface({ surfaceId: "confirm", title: "Write", summary: "Confirm write" }),
    })
    jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
      await delivery?.beforeSend?.()
      await getDb().sessions.put({
        id: "unbound-child",
        title: "Child",
        parentSessionId: id,
        kind: "subagent",
        createdAt: 1,
        updatedAt: 1,
      })
      const endChild = beginCapturedTurn("unbound-child", {
        turnId: "child",
        outboundPolicy: { unattended: true },
      })
      try {
        const context = await resolveBuiltInSkillContext("unbound-child")
        expect(context.imBinding).toBeUndefined()
        await runBuiltInSkill("im.test_write", {}, context)
      } finally {
        endChild()
      }
      listener!({
        type: "event",
        sessionId: id,
        turnId: options?.turnId,
        event: {
          type: "assistant",
          uuid: "park-reply",
          message: {
            id: "park-reply",
            role: "assistant",
            content: [{ type: "text", text: "Needs approval" }],
          },
        },
      } as ClaudeEvent)
      listener!({ type: "session_ended", sessionId: id, turnId: options?.turnId } as ClaudeEvent)
    })
    let settled = false
    const turn = runPluginAgentTurn(
      { ...request, timeoutMs: 2_000 },
      { grantSource: { kind, id: kind } }
    )
    const completed = turn.then(
      (result) => {
        settled = true
        return result
      },
      (error) => {
        settled = true
        throw error
      }
    )
    try {
      expect(
        await Promise.race([parked.then(() => "parked"), completed.then(() => "completed")])
      ).toBe("parked")
      expect(settled).toBe(false)
      expect(park).toHaveBeenCalledTimes(1)
      expect(execute).not.toHaveBeenCalled()
    } finally {
      resolveApproval({ kind: "expired" })
    }
    const result = await completed
    expect(result.status).toBe("needs_approval")
    expect(result.needsApproval).toEqual([expect.objectContaining({ toolName: "im_test_write" })])
  }
)

it.each([
  { raw: "hello", transformed: "HELLO", mixed: false },
  { raw: "hello", transformed: "HELLO", mixed: true },
  { raw: "public secret", transformed: "public", mixed: false },
  { raw: "secret", transformed: "", mixed: true },
  {
    raw: '```a2ui\n{"type":"createSurface","surfaceId":"secret"}\n```',
    transformed: "",
    mixed: true,
  },
  {
    raw: "Answer[^1]\n\n[^1]: [secret](https://example.test/secret)",
    transformed: "public",
    mixed: true,
  },
])(
  "persists middleware text '$transformed' and retains non-text content (mixed=$mixed)",
  async ({ raw, transformed, mixed }) => {
    setChatMiddlewareExecutionEnabled(true)
    registerChatMiddleware({
      pluginId: "filter",
      middlewareId: "reply",
      fn: async (_request, next) => ({ ...(await next()), text: transformed }),
    })
    jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
      await delivery?.beforeSend?.()
      if (raw.includes("secret"))
        listener!({
          type: "event",
          sessionId: id,
          turnId: options?.turnId,
          event: {
            type: "assistant",
            uuid: "earlier",
            message: {
              id: "earlier",
              role: "assistant",
              content: [{ type: "text", text: "earlier secret" }],
            },
          },
        } as ClaudeEvent)
      listener!({
        type: "event",
        sessionId: id,
        turnId: options?.turnId,
        event: {
          type: "assistant",
          uuid: "filtered",
          message: {
            id: "filtered",
            role: "assistant",
            content: [
              { type: "text", text: raw },
              ...(mixed
                ? [
                    {
                      type: "tool_use",
                      id: "read",
                      name: "Read",
                      input: { file_path: "/repo/doc" },
                    },
                    {
                      type: "file",
                      url: "https://example.test/image.png",
                      media_type: "image/png",
                    },
                  ]
                : []),
            ],
          },
        },
      } as ClaudeEvent)
      if (mixed)
        listener!({
          type: "event",
          sessionId: id,
          turnId: options?.turnId,
          event: {
            type: "user",
            uuid: "read-result",
            message: {
              content: [{ type: "tool_result", tool_use_id: "read", content: "completed" }],
            },
          },
        } as ClaudeEvent)
      listener!({ type: "session_ended", sessionId: id, turnId: options?.turnId } as ClaudeEvent)
    })
    const result = await runPluginAgentTurn(request, {
      grantSource: { kind: "plugin", id: "filter" },
    })
    expect(result.text).toBe(transformed)
    const replies = (await listMessages(result.sessionId)).filter(
      (message) => message.role === "assistant"
    )
    expect(
      replies.flatMap((reply) =>
        reply.parts.filter((part) => part.type === "text").map((part) => part.text)
      )
    ).toEqual(transformed ? [transformed] : [])
    if (mixed)
      expect(replies[0].parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "tool-Read",
            toolCallId: "read",
            state: "output-available",
            output: "completed",
          }),
          expect.objectContaining({ type: "file", url: "https://example.test/image.png" }),
        ])
      )
    expect(JSON.stringify(replies)).not.toContain("secret")
  }
)

it.each(["secret", '```a2ui\n{"type":"createSurface","surfaceId":"secret"}\n```'])(
  "rejects a middleware-filtered empty reply without persisting its secret: %s",
  async (raw) => {
    setChatMiddlewareExecutionEnabled(true)
    registerChatMiddleware({
      pluginId: "filter",
      middlewareId: "empty",
      fn: async (_request, next) => ({ ...(await next()), text: "" }),
    })
    jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
      await delivery?.beforeSend?.()
      listener!({
        type: "event",
        sessionId: id,
        turnId: options?.turnId,
        event: {
          type: "assistant",
          uuid: "secret",
          message: { id: "secret", role: "assistant", content: [{ type: "text", text: raw }] },
        },
      } as ClaudeEvent)
      listener!({ type: "session_ended", sessionId: id, turnId: options?.turnId } as ClaudeEvent)
    })
    await expect(
      runPluginAgentTurn(request, { grantSource: { kind: "plugin", id: "filter" } })
    ).rejects.toMatchObject({ code: "no_assistant_text" })
    expect(
      await getDb()
        .messages.filter((message) => message.role === "assistant")
        .count()
    ).toBe(0)
  }
)

it("rebuilds the engine from the stored transcript after middleware answers without dispatch", async () => {
  setChatMiddlewareExecutionEnabled(true)
  registerChatMiddleware({
    pluginId: "short",
    middlewareId: "answer",
    fn: async () => ({ text: "Answered by middleware" }),
  })
  const engine = jest.fn()
  jest.mocked(sendPrompt).mockImplementation(async () => {
    engine()
  })
  await runPluginAgentTurn(request, { grantSource: { kind: "plugin", id: "short-circuit" } })
  expect(engine).not.toHaveBeenCalled()
  const session = (await getDb().sessions.toArray()).find(
    (row) => row.agentTurnOwner?.id === "short-circuit"
  )!
  // The engine never saw this turn, so its history must not be resumed as-is.
  expect(session.runtimeTranscriptInvalidated).toEqual(expect.any(String))
  const next = await prepareTranscriptRuntimeSend(session.id, {
    cwd: "/repo",
    provider: "anthropic",
    resumeSessionId: "stale-runtime",
  })
  expect(JSON.stringify(next)).toContain("Answered by middleware")
})

it.each(["anthropic", "openai"])(
  "rebuilds %s context after a transformed or rejected reply",
  async (provider) => {
    for (const transformed of ["public", ""]) {
      __resetChatMiddlewareRegistryForTesting()
      setChatMiddlewareExecutionEnabled(true)
      registerChatMiddleware({
        pluginId: "filter",
        middlewareId: "runtime",
        fn: async (_request, next) => ({ ...(await next()), text: transformed }),
      })
      jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
        await delivery?.beforeSend?.()
        listener!({
          type: "sdk_session_id",
          sessionId: id,
          turnId: options?.turnId,
          sdkSessionId: "opaque-runtime",
        } as ClaudeEvent)
        listener!({
          type: "event",
          sessionId: id,
          turnId: options?.turnId,
          event: {
            type: "assistant",
            uuid: "runtime-reply",
            message: {
              id: "runtime-reply",
              role: "assistant",
              content: [{ type: "text", text: "public secret" }],
            },
          },
        } as ClaudeEvent)
        listener!({ type: "session_ended", sessionId: id, turnId: options?.turnId } as ClaudeEvent)
      })
      const run = runPluginAgentTurn(request, {
        grantSource: { kind: "plugin", id: `runtime-${provider}-${transformed}` },
      })
      if (transformed) await run
      else await expect(run).rejects.toMatchObject({ code: "no_assistant_text" })
      const session = (await getDb().sessions.toArray()).find(
        (row) => row.agentTurnOwner?.id === `runtime-${provider}-${transformed}`
      )!
      expect(closeSession).toHaveBeenCalledWith(session.id)
      expect(session.runtimeTranscriptInvalidated).toEqual(expect.any(String))
      const next = await prepareTranscriptRuntimeSend(session.id, {
        cwd: "/repo",
        provider,
        resumeSessionId: "opaque-runtime",
      })
      expect(JSON.stringify(next)).not.toContain("secret")
      if (provider === "openai") {
        expect(next.initialConversation).toBeDefined()
        expect(next.expectedRuntimeSessionId).toBeUndefined()
        expect(next.transcriptInvalidationId).toEqual(expect.any(String))
      }
      if (transformed) expect(JSON.stringify(next)).toContain("public")
    }
  }
)

it("preserves untransformed assistant rounds and tool/media parts", async () => {
  jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
    await delivery?.beforeSend?.()
    for (const [uuid, content] of [
      [
        "first-round",
        [
          { type: "text", text: "First round" },
          { type: "tool_use", id: "read", name: "Read", input: {} },
        ],
      ],
      [
        "last-round",
        [
          { type: "text", text: "Final round" },
          { type: "file", url: "https://example.test/image.png", media_type: "image/png" },
        ],
      ],
    ] as const)
      listener!({
        type: "event",
        sessionId: id,
        turnId: options?.turnId,
        event: { type: "assistant", uuid, message: { id: uuid, role: "assistant", content } },
      } as unknown as ClaudeEvent)
    listener!({
      type: "event",
      sessionId: id,
      turnId: options?.turnId,
      event: {
        type: "user",
        uuid: "ordinary-read-result",
        message: { content: [{ type: "tool_result", tool_use_id: "read", content: "completed" }] },
      },
    } as ClaudeEvent)
    listener!({ type: "session_ended", sessionId: id, turnId: options?.turnId } as ClaudeEvent)
  })
  const result = await runPluginAgentTurn(request, {
    grantSource: { kind: "plugin", id: "ordinary" },
  })
  const parts = (await listMessages(result.sessionId))
    .filter((row) => row.role === "assistant")
    .flatMap((row) => row.parts)
  expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
    "First round",
    "Final round",
  ])
  expect(parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "tool-Read",
        toolCallId: "read",
        state: "output-available",
        output: "completed",
      }),
      expect.objectContaining({ type: "file" }),
    ])
  )
})

it.each([false, true].flatMap((desktop) => ["file", "image"].map((type) => ({ desktop, type }))))(
  "real capture saves a $type-only reply (desktop observer: $desktop)",
  async ({ desktop, type }) => {
    const data = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
    jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
      await delivery?.beforeSend?.()
      for (const frame of [
        {
          type: "event",
          sessionId: id,
          turnId: options?.turnId,
          event: {
            type: "assistant",
            uuid: "media-wire",
            message: {
              id: "media-reply",
              role: "assistant",
              content: [{ type, source: { type: "base64", media_type: "image/gif", data } }],
            },
          },
        },
        { type: "session_ended", sessionId: id, turnId: options?.turnId },
      ] as ClaudeEvent[]) {
        listener!(frame)
        if (desktop)
          await handleEvent(
            frame,
            { current: id },
            { current: [] },
            { current: new Map() },
            { current: new Map() },
            { current: null },
            null as never
          )
      }
    })
    const result = await runPluginAgentTurn(request, {
      grantSource: { kind: "plugin", id: "artist-plugin" },
    })
    const messages = await listMessages(result.sessionId)
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(messages[1].parts[0]).toMatchObject({
      type: "file",
      mediaType: "image/gif",
      url: expect.stringMatching(/^cognia-media:/),
    })
    expect(await getDb().messageMedia.count()).toBe(1)
    expect(await getDb().messageMediaRefs.where("messageId").equals(messages[1].id).count()).toBe(1)
    expect(listener).toBeUndefined()
  }
)

it.each([
  ["plugin", "external-event"],
  ["webhook", "external-event"],
  ["schedule", "schedule"],
] as const)(
  "an actual unbound %s turn uses app access and refuses user-only skills",
  async (source, trigger) => {
    await getDb().adapterInstances.put({
      id: "lark",
      type: "lark",
      enabled: true,
      displayName: "Lark",
      settings: {},
      createdAt: 1,
      updatedAt: 1,
    } as never)
    if (source !== "plugin")
      await getDb().executionRuns.put({
        id: source,
        kind: "bot",
        sourceId: "installation",
        title: source,
        status: "running",
        startedAt: 1,
        updatedAt: 1,
        currentRevision: 0,
        ...recordedRunMetadata(trigger, { runId: source }),
      } as never)
    jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
      await delivery?.beforeSend?.()
      expect((await getSession(id))?.platformBinding).toBeUndefined()
      expect(await resolveRunActingIdentity(id)).toMatchObject({ trigger })
      await expect(resolveLarkAuth({ context: { sessionId: id } })).resolves.toMatchObject({
        ok: true,
        identity: "bot",
        lane: "service",
        env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: "", LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "tenant" },
      })
      await expect(
        execLarkCli({ args: ["docs", "+search", "--query", "review"], context: { sessionId: id } })
      ).resolves.toMatchObject({
        status: "error",
        message: expect.stringMatching(/phases 4 and 5/i),
      })
      listener!({
        type: "event",
        sessionId: id,
        turnId: options?.turnId,
        event: {
          type: "assistant",
          uuid: "auth-wire",
          message: {
            id: "auth-reply",
            role: "assistant",
            content: [{ type: "text", text: "Checked access" }],
          },
        },
      } as ClaudeEvent)
      listener!({ type: "session_ended", sessionId: id, turnId: options?.turnId } as ClaudeEvent)
    })
    await runPluginAgentTurn(request, {
      grantSource: { kind: source === "plugin" ? "plugin" : "bot", id: source },
      ...(source !== "plugin" ? { parentRunId: source } : {}),
    })
    expect(getTenantToken).toHaveBeenCalledWith(
      { appId: "app", appSecret: "secret" },
      "service-data"
    )
    expect(connectorsKeyringGet).not.toHaveBeenCalledWith("lark", "user_token")
    expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
  }
)

it.each([false, true])(
  "requires durable human approval for a destructive built-in (human park: %s)",
  async (human) => {
    const execute = jest.fn(async () => ({ deleted: true }))
    registerBuiltInSkill({
      id: "im.test_delete",
      family: "im",
      label: { en: "Delete", "zh-CN": "删除" },
      description: { en: "Delete", "zh-CN": "删除" },
      platforms: ["lark"],
      mutation: "destructive",
      imAccess: "always",
      mcpToolName: "im_test_delete",
      inputSchema: z.object({}),
      execute,
      hitlSurface: () =>
        buildConfirmSurface({ surfaceId: "delete", title: "Delete", summary: "Confirm delete" }),
    })
    let skillResult: unknown
    jest.mocked(sendPrompt).mockImplementation(async (id, _prompt, options, delivery) => {
      await delivery?.beforeSend?.()
      skillResult = await runBuiltInSkill(
        "im.test_delete",
        {},
        await resolveBuiltInSkillContext(id)
      )
      listener!({
        type: "event",
        sessionId: id,
        turnId: options?.turnId,
        event: {
          type: "assistant",
          uuid: "delete-reply",
          message: {
            id: "delete-reply",
            role: "assistant",
            content: [{ type: "text", text: "Finished" }],
          },
        },
      } as ClaudeEvent)
      listener!({ type: "session_ended", sessionId: id, turnId: options?.turnId } as ClaudeEvent)
    })
    if (human) {
      jest.mocked(createUnattendedPark).mockReturnValue({
        park: async () => ({ kind: "approved", decision: { decision: "allow" } }),
        finish: async () => {},
        runId: () => "human-run",
      })
      await runPluginAgentTurn(request, { grantSource: { kind: "plugin", id: "human-approved" } })
      expect(execute).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ humanConfirmed: true, hitlBypass: true })
      )
      expect(skillResult).toMatchObject({ status: "ok" })
    } else {
      await getDb().sessions.put({ id: "sdk-root", title: "SDK", createdAt: 0, updatedAt: 0 })
      jest.mocked(executeAgentTurnFromRenderer).mockImplementation(async (prompt, config) => {
        const captured = await runAndCaptureAssistantReply(
          "sdk-root",
          prompt,
          { cwd: "/repo" },
          {
            onPermissionRequest: async (request) => {
              const decision = await config.canUseTool!(request.toolName, request.input, {
                signal: config.abortSignal,
              })
              return decision.behavior === "deny"
                ? { decision: "deny", message: decision.message }
                : { decision: "allow", updatedInput: decision.updatedInput }
            },
          }
        )
        return { text: captured.text, toolsAvailable: true, channel: "sidecar" }
      })
      await runPluginAgent("Delete the issue", { toolsEnabled: true, cwd: "/repo" })
      expect(executeAgentTurnFromRenderer).toHaveBeenCalled()
      expect(skillResult).toMatchObject({ status: "denied", reason: "hitl_rejected" })
      expect(execute).not.toHaveBeenCalled()
    }
  }
)
