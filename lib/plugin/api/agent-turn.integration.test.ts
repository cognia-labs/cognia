/** @jest-environment node */
jest.mock("@/lib/i18n/runtime-translator", () => ({
  currentLocale: jest.fn(async () => "en"),
}))
/** Real session/message persistence and transcript preparation; only the engine is fake. */
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { deleteSession, getSession, updateSession } from "@/lib/db/sessions"
import { clearMessages, deleteStoredMessage, listMessages, truncateAfter } from "@/lib/db/messages"
import { prepareTranscriptRuntimeSend } from "@/hooks/chat/claude-chat-send-options"
import { hasCaptureResponder } from "@/lib/connectors/hitl/approval-registry"
import { assertLarkActingIdentity } from "@/lib/skills/built-in/lark/acting-identity"
import { resolveRunActingIdentity, recordedRunMetadata } from "@/lib/execution/acting-authority"
import { runAndCaptureAssistantReply } from "@/lib/claude/run-and-capture"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { finishToolExecutionRun } from "@/lib/execution/acting-authority"
import { closeSession } from "@/lib/claude/ipc"
import { runPluginAgentTurn } from "./agent-turn"
import type { SendOptions } from "@cognia/agent-config-types"

jest.mock("@/lib/db/characters", () => ({
  ...jest.requireActual("@/lib/db/characters"),
  resolveCharacterById: async () => ({ id: "lecturer", name: "Lecturer" }),
}))
jest.mock("@/lib/claude/build-options", () => ({ resolveSendOptions: jest.fn() }))
jest.mock("@/lib/claude/run-and-capture", () => ({
  RunAndCaptureError: jest.requireActual("@/lib/claude/run-and-capture").RunAndCaptureError,
  runAndCaptureAssistantReply: jest.fn(),
}))
jest.mock("@/lib/claude/ipc", () => ({
  ...jest.requireActual("@/lib/claude/ipc"),
  sessionControl: async () => null,
  closeSession: jest.fn(async () => {}),
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({ isStandaloneChatMode: () => false }))
jest.mock("@/lib/claude/unattended-park", () => ({
  createUnattendedPark: () => ({ park: jest.fn(), finish: async () => {}, runId: () => null }),
}))

jest.mock("@/lib/execution/acting-authority", () => ({
  ...jest.requireActual("@/lib/execution/acting-authority"),
  finishToolExecutionRun: jest.fn(
    jest.requireActual("@/lib/execution/acting-authority").finishToolExecutionRun
  ),
}))

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
const request = { characterId: "lecturer", prompt: "Review material A", cwd: "/repo" }
const topic = (name: string) => ({
  grantSource: { kind: "bot" as const, id: "lecturer-bot" },
  sessionKey: JSON.stringify(["installation", `lark:lark-1:chat:${name}`]),
  platformBinding: {
    platform: "lark" as const,
    adapterId: "lark-1",
    conversationKey: `lark:lark-1:chat:${name}`,
    conversationRef: { platform: "lark" as const, adapterId: "lark-1" },
  },
})

it.each([false, true])(
  "serializes concurrent turns into one topic session (explicit cwd repin: %s)",
  async (repin) => {
    jest
      .mocked(resolveSendOptions)
      .mockImplementation(async () => ({ cwd: "/repo", provider: "openai" }))
    let existingSessionId: string | undefined
    if (repin) {
      jest.mocked(runAndCaptureAssistantReply).mockResolvedValue({
        text: "Seed",
        messageId: "seed-reply",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })
      existingSessionId = (await runPluginAgentTurn(request, topic("concurrent"))).sessionId
    }
    let releaseFirst!: () => void
    const firstReply = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let enteredFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const histories: SendOptions["initialConversation"][] = []
    let active = 0
    let maximumActive = 0
    jest
      .mocked(runAndCaptureAssistantReply)
      .mockImplementation(async (id, prompt, options, cap) => {
        active++
        maximumActive = Math.max(maximumActive, active)
        try {
          const prepared = await prepareTranscriptRuntimeSend(id, options!, {
            currentMessageId: cap?.currentMessageId,
          })
          // Match IPC: preparation can advance the generation before dispatch records it.
          await cap?.beforeSend?.()
          histories.push(prepared.initialConversation)
          if (prompt === "First") {
            enteredFirst()
            await firstReply
          }
          return {
            text: `${prompt} reply`,
            messageId: `reply-${prompt}`,
            a2uiSurfaces: {},
            a2uiSurfaceOrder: [],
          }
        } finally {
          active--
        }
      })
    const turns = [
      runPluginAgentTurn(
        { ...request, prompt: "First", sessionId: existingSessionId },
        topic("concurrent")
      ),
      runPluginAgentTurn(
        {
          ...request,
          prompt: "Second",
          sessionId: existingSessionId,
          cwd: repin ? "/other-repo" : "/repo",
        },
        topic("concurrent")
      ),
    ]
    await firstStarted
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFirst()
    const results = await Promise.all(turns)
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1)
    expect(maximumActive).toBe(1)
    expect(
      await getDb()
        .sessions.filter((session) => session.agentTurnOwner?.id === "lecturer-bot")
        .count()
    ).toBe(1)
    expect(
      (await listMessages(results[0].sessionId))
        .slice(-4)
        .map((message) => [message.role, message.parts])
    ).toEqual([
      ["user", [{ type: "text", text: "First" }]],
      ["assistant", [expect.objectContaining({ type: "text", text: "First reply" })]],
      ["user", [{ type: "text", text: "Second" }]],
      ["assistant", [expect.objectContaining({ type: "text", text: "Second reply" })]],
    ])
    expect(JSON.stringify(histories[1])).toContain("First reply")
  }
)

it("uses Web Locks for identity creation and full-session turns", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  const pending = new Map<string, Promise<unknown>>()
  const acquire = jest.fn(
    async (
      name: string,
      optionsOrAction: unknown,
      callback?: (lock: object) => Promise<unknown>
    ) => {
      const action = callback
        ? () => callback({ name })
        : (optionsOrAction as () => Promise<unknown>)
      const current = (pending.get(name) ?? Promise.resolve()).then(action)
      pending.set(
        name,
        current.catch(() => {})
      )
      return current
    }
  )
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: "en-US", languages: ["en-US"], locks: { request: acquire } },
  })
  try {
    jest.mocked(resolveSendOptions).mockImplementation(async () => ({ cwd: "/repo" }))
    jest.mocked(runAndCaptureAssistantReply).mockImplementation(async () => ({
      text: "Reply",
      messageId: crypto.randomUUID(),
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }))
    const results = await Promise.all([
      runPluginAgentTurn(request, topic("web-locks")),
      runPluginAgentTurn(request, topic("web-locks")),
    ])
    expect(results[0].sessionId).toBe(results[1].sessionId)
    expect(acquire.mock.calls.filter(([name]) => name.includes(":identity:")).length).toBe(2)
    expect(
      acquire.mock.calls.filter(([name]) => name.endsWith(`:session:${results[0].sessionId}`))
        .length
    ).toBe(2)
    expect((await listMessages(results[0].sessionId)).map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
  } finally {
    if (previous) Object.defineProperty(globalThis, "navigator", previous)
    else Reflect.deleteProperty(globalThis, "navigator")
  }
})

it("creates another implicit cwd session after an explicit repin", async () => {
  jest.mocked(resolveSendOptions).mockImplementation(async () => ({ cwd: "/repo" }))
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async () => ({
    text: "Reply",
    messageId: crypto.randomUUID(),
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
  }))
  const first = await runPluginAgentTurn(request, topic("repin"))
  const repinned = await runPluginAgentTurn(
    { ...request, sessionId: first.sessionId, cwd: "/other-repo" },
    topic("repin")
  )
  const returned = await runPluginAgentTurn(request, topic("repin"))
  expect(repinned.sessionId).toBe(first.sessionId)
  expect(returned.sessionId).not.toBe(first.sessionId)
  expect((await getSession(first.sessionId))?.workingDir).toBe("/other-repo")
  expect((await getSession(returned.sessionId))?.workingDir).toBe("/repo")
  expect((await runPluginAgentTurn(request, topic("repin"))).sessionId).toBe(returned.sessionId)
})

it("commits a real inline image reply and its media reference outside media preparation", async () => {
  jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
  const data = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
  jest
    .mocked(runAndCaptureAssistantReply)
    .mockImplementation(async (_id, _prompt, _options, cap) => {
      await cap?.beforeSend?.()
      cap?.onSdkEvent?.({
        type: "assistant",
        uuid: "image-wire",
        message: {
          id: "image-reply",
          role: "assistant",
          content: [{ type: "file", source: { type: "base64", media_type: "image/gif", data } }],
        },
      } as import("@cognia/agent-config-types").SDKMessage)
      return {
        text: "",
        messageId: "image-reply",
        sdkSessionId: "image-runtime",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      }
    })
  const result = await runPluginAgentTurn(request, topic("A"))
  const reply = (await listMessages(result.sessionId)).find(
    (message) => message.id === "image-reply"
  )!
  expect(reply.parts[0]).toMatchObject({
    type: "file",
    mediaType: "image/gif",
    url: expect.stringMatching(/^cognia-media:/),
  })
  const hash = (reply.parts[0] as { url: string }).url.slice("cognia-media:".length)
  const media = await getDb().messageMedia.get(hash)
  expect(media?.byteSize).toBe(Buffer.from(data, "base64").length)
  expect(await getDb().messageMediaRefs.where("messageId").equals(reply.id).toArray()).toEqual([
    expect.objectContaining({ messageId: reply.id, sessionId: result.sessionId, hash }),
  ])
  expect((await getSession(result.sessionId))?.sdkSessionId).toBe("image-runtime")
})

it("reuses the logical user row after failure, excludes it from rebuilt history, and changes attempt ids", async () => {
  jest
    .mocked(resolveSendOptions)
    .mockImplementation(async () => ({ cwd: "/repo", provider: "openai" }))
  const attempts: string[] = []
  const histories: SendOptions["initialConversation"][] = []
  let calls = 0
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id, prompt, options, cap) => {
    attempts.push(options!.turnId!)
    const prepared = await prepareTranscriptRuntimeSend(id, options!, {
      currentMessageId: cap?.currentMessageId,
    })
    await cap?.beforeSend?.()
    histories.push(prepared.initialConversation)
    expect(prompt).toBe(request.prompt)
    if (++calls === 1) throw new Error("engine failed after send")
    return { text: "Reviewed", messageId: "retried-reply", a2uiSurfaces: {}, a2uiSurfaceOrder: [] }
  })
  const operation = {
    ...topic("A"),
    usage: { operationId: "bot:delivery-1:agent-turn", sessionId: "bot:delivery-1" },
  }
  await expect(runPluginAgentTurn(request, operation)).rejects.toThrow("engine failed after send")
  const result = await runPluginAgentTurn(request, operation)
  expect((await listMessages(result.sessionId)).map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ])
  expect(histories).toEqual([[], []])
  expect(attempts[0]).not.toBe(attempts[1])
})

it.each(["clear", "delete", "truncate", "missing-row"])(
  "does not revive an unfinished operation after %s removes its prompt",
  async (removal) => {
    jest.mocked(resolveSendOptions).mockImplementation(async () => ({ cwd: "/repo" }))
    jest.mocked(runAndCaptureAssistantReply).mockRejectedValue(new Error("first attempt failed"))
    const options = { ...topic(`unfinished-${removal}`), operationId: `unfinished-${removal}` }
    await expect(runPluginAgentTurn(request, options)).rejects.toThrow("first attempt failed")
    const session = (await getDb().sessions.toArray()).find(
      (row) => row.agentTurnOwner?.key === options.sessionKey
    )!
    const [user] = await listMessages(session.id)
    if (removal === "clear") await clearMessages(session.id)
    else if (removal === "delete") await deleteStoredMessage(user.id)
    else if (removal === "truncate") await truncateAfter(session.id, user.id, { inclusive: true })
    else await getDb().messages.delete(user.id)
    jest.mocked(runAndCaptureAssistantReply).mockClear()
    await expect(runPluginAgentTurn(request, options)).rejects.toMatchObject({
      code: "aborted",
      terminalCancellation: true,
    })
    expect(runAndCaptureAssistantReply).not.toHaveBeenCalled()
    expect(await listMessages(session.id)).toEqual([])
  }
)

it.each(
  [false, true].flatMap((desktop) =>
    (desktop ? ["tool", "surface"] : ["tool", "surface", "external-tool"]).map((kind) => ({
      desktop,
      kind,
    }))
  )
)(
  "persists a complete $kind-only reply (desktop observer: $desktop)",
  async ({ desktop, kind }) => {
    jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo", provider: "openai" })
    const surface = {
      rootId: "root",
      catalogId: "review-catalog",
      components: { root: { id: "root", component: "Text", text: "Review ready" } },
      dataModel: {},
    }
    jest
      .mocked(runAndCaptureAssistantReply)
      .mockImplementation(
        async (
          id,
          _prompt,
          options,
          cap
        ): Promise<import("@/lib/claude/run-and-capture").RunAndCaptureResult> => {
          await cap?.beforeSend?.()
          const sdkEvents = [
            {
              type: "assistant",
              session_id: id,
              uuid: "wire-assistant",
              message: {
                id: "full-reply",
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "call",
                    name: kind === "tool" ? "Read" : "mcp__a2ui-bridge__a2ui_create_surface",
                    input:
                      kind === "tool"
                        ? { file_path: "/repo/material" }
                        : { surfaceId: "review", surfaceType: "inline" },
                  },
                ],
              },
            },
            {
              type: "user",
              session_id: id,
              uuid: "wire-result",
              message: {
                content: [{ type: "tool_result", tool_use_id: "call", content: "completed" }],
              },
            },
          ] as import("@cognia/agent-config-types").SDKMessage[]
          if (kind === "external-tool") {
            for (const event of [
              {
                type: "tool_use_start",
                toolUseId: "call",
                toolName: "Read",
                rawInput: { file_path: "/repo/material" },
              },
              { type: "tool_use_end", toolUseId: "call", input: { file_path: "/repo/material" } },
              { type: "tool_result", toolUseId: "call", result: "completed" },
            ])
              cap?.onExternalEvent?.(
                event as import("@/types/agent/external-agent").ExternalAgentEvent
              )
          }
          for (const event of kind === "external-tool" ? [] : sdkEvents) {
            cap?.onSdkEvent?.(event)
            if (desktop) {
              const { handleEvent } = await import("@/hooks/chat/claude-chat-events")
              // A viewed session's real desktop listener must return at the capture
              // ownership gate before it reaches its independent transcript writer.
              await handleEvent(
                {
                  type: "event",
                  sessionId: id,
                  turnId: options!.turnId,
                  event,
                } as import("@cognia/agent-config-types").ClaudeEvent,
                { current: id },
                { current: [] },
                { current: new Map() },
                { current: new Map() },
                { current: null },
                null as never
              )
            }
          }
          return {
            text: "",
            messageId: "full-reply",
            a2uiSurfaces: kind === "surface" ? { review: surface } : {},
            a2uiSurfaceOrder: kind === "surface" ? ["review"] : [],
          }
        }
      )
    const result = await runPluginAgentTurn(request, topic("A"))
    const assistants = (await listMessages(result.sessionId)).filter(
      (message) => message.role === "assistant"
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: kind === "surface" ? "tool-mcp__a2ui-bridge__a2ui_create_surface" : "tool-Read",
          toolCallId: "call",
          input:
            kind === "surface"
              ? { surfaceId: "review", surfaceType: "inline" }
              : { file_path: "/repo/material" },
          state: "output-available",
          output: "completed",
        }),
      ])
    )
    if (kind === "surface") {
      const part = assistants[0].parts.find(
        (part) => (part as { type: string }).type === "a2ui"
      ) as unknown as { surfaceId: string; content: string }
      expect(part?.surfaceId).toBe("review")
      const { parseA2UIInput } = await import("@/lib/a2ui/parser")
      expect(parseA2UIInput(part.content).messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "createSurface",
            surfaceId: "review",
            catalogId: "review-catalog",
          }),
          expect.objectContaining({
            type: "updateComponents",
            surfaceId: "review",
            components: [expect.objectContaining({ id: "root", text: "Review ready" })],
          }),
        ])
      )
    }
  }
)

it.each([false, true])(
  "keeps terminal fallback text alongside a captured tool-only assistant (empty text: %s)",
  async (emptyText) => {
    jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
    jest
      .mocked(runAndCaptureAssistantReply)
      .mockImplementation(async (_id, _prompt, _options, cap) => {
        await cap?.beforeSend?.()
        cap?.onSdkEvent?.({
          type: "assistant",
          uuid: "fallback-wire",
          message: {
            id: "fallback-reply",
            role: "assistant",
            content: [
              ...(emptyText ? [{ type: "text", text: "" }] : []),
              { type: "tool_use", id: "read", name: "Read", input: {} },
            ],
          },
        } as import("@cognia/agent-config-types").SDKMessage)
        return {
          text: "Reviewed the material",
          messageId: "fallback-reply",
          a2uiSurfaces: {},
          a2uiSurfaceOrder: [],
        }
      })
    const result = await runPluginAgentTurn(request, topic("A"))
    const [assistant] = (await listMessages(result.sessionId)).filter(
      (message) => message.role === "assistant"
    )
    expect(assistant.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool-Read", toolCallId: "read" }),
        expect.objectContaining({ type: "text", text: "Reviewed the material" }),
      ])
    )
  }
)

it("rebuilds AI-SDK history from durable topic rows after runtime loss, excluding this turn and other topics", async () => {
  jest
    .mocked(resolveSendOptions)
    .mockImplementation(async () => ({ cwd: "/repo", provider: "openai" }))
  const prepared: SendOptions[] = []
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id, _prompt, options, cap) => {
    expect(hasCaptureResponder({ type: "event", sessionId: id, turnId: options?.turnId })).toBe(
      true
    )
    const sendOptions = await prepareTranscriptRuntimeSend(id, options!)
    await cap?.beforeSend?.()
    expect((await resolveRunActingIdentity(id))?.trigger).toBe("external-event")
    await expect(assertLarkActingIdentity("lark-1", { sessionId: id })).rejects.toThrow(
      /phases 4 and 5/i
    )
    prepared.push(sendOptions)
    await cap?.onSdkSessionId?.(`sdk-${id}`)
    return {
      text: `Reply ${prepared.length}`,
      messageId: `reply-${prepared.length}`,
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }
  })
  const a = await runPluginAgentTurn(request, topic("A"))
  await runPluginAgentTurn({ ...request, prompt: "Re-review A" }, topic("A"))
  const b = await runPluginAgentTurn({ ...request, prompt: "Review B" }, topic("B"))
  expect(a.sessionId).not.toBe(b.sessionId)
  await expect(
    runPluginAgentTurn({ ...request, sessionId: a.sessionId }, topic("B"))
  ).rejects.toThrow(/not owned/)
  expect((await getSession(a.sessionId))?.agentTurnOwner?.key).toBe(topic("A").sessionKey)
  expect(await getSession(a.sessionId)).toMatchObject({
    imAuthorityBinding: topic("A").platformBinding,
  })
  expect((await getSession(a.sessionId))?.platformBinding).toBeUndefined()
  expect((await getSession(a.sessionId))?.platformConversationKey).toBeUndefined()
  expect(await getDb().sessions.count()).toBe(2)
  expect(prepared[0].initialConversation).toEqual([])
  expect(prepared[1].initialConversation).toEqual([
    { role: "user", content: [{ type: "text", text: "Review material A" }] },
    { role: "assistant", content: [{ type: "text", text: "Reply 1" }] },
  ])
  expect(prepared[2].initialConversation).toEqual([])
  expect((await listMessages(a.sessionId)).map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ])
  expect(hasCaptureResponder({ type: "event", sessionId: a.sessionId })).toBe(false)
})

it("saves a native resume identity and acknowledges only the consumed transcript generation", async () => {
  jest.mocked(resolveSendOptions).mockImplementation(async ({ session }) => ({
    cwd: "/repo",
    provider: "anthropic",
    resumeSessionId: session?.sdkSessionId,
  }))
  let calls = 0
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id, _prompt, options, cap) => {
    calls++
    await cap?.beforeSend?.()
    if (calls === 2) expect(options?.resumeSessionId).toBe("native-resume")
    await cap?.onSdkSessionId?.("native-resume")
    return {
      text: "Reviewed",
      messageId: `native-reply-${calls}`,
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }
  })
  const first = await runPluginAgentTurn(request, topic("A"))
  await updateSession(first.sessionId, {
    runtimeTranscriptInvalidated: "newer",
    runtimeTranscriptGeneration: "newer",
  })
  expect((await getSession(first.sessionId))?.runtimeTranscriptInvalidated).toBe("newer")
  await runPluginAgentTurn(request, topic("A"))
  expect(await getSession(first.sessionId)).toMatchObject({
    sdkSessionId: "native-resume",
    runtimeTranscriptGeneration: "newer",
  })
  expect((await getSession(first.sessionId))?.runtimeTranscriptInvalidated).toBeUndefined()
})

it("leaves a crashed plugin turn's user row on disk and cleans up transcript ownership", async () => {
  jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
  jest.mocked(runAndCaptureAssistantReply).mockRejectedValueOnce(new Error("engine exited"))
  await expect(
    runPluginAgentTurn(request, { grantSource: { kind: "plugin", id: "review-plugin" } })
  ).rejects.toThrow("engine exited")
  const [session] = await getDb().sessions.toArray()
  expect((await listMessages(session.id)).map((m) => m.role)).toEqual(["user"])
  expect(hasCaptureResponder({ type: "event", sessionId: session.id })).toBe(false)
})

it.each(["prompt-removed", "engine-failed", "close-failed"])(
  "invalidates the engine context when a dispatched turn ends uncommitted (%s)",
  async (kind) => {
    jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
    // The live runtime cannot be closed; the durable marker must still land.
    if (kind === "close-failed")
      jest.mocked(closeSession).mockRejectedValueOnce(new Error("sidecar unreachable"))
    jest
      .mocked(runAndCaptureAssistantReply)
      .mockImplementationOnce(async (_id, _prompt, _options, cap) => {
        await cap?.beforeSend?.()
        if (kind !== "prompt-removed") throw new Error("engine exited")
        await getDb().messages.delete(cap!.currentMessageId!)
        return {
          text: "Reply to a removed prompt",
          messageId: "orphan-reply",
          a2uiSurfaces: {},
          a2uiSurfaceOrder: [],
        }
      })
    await expect(
      runPluginAgentTurn(request, { ...topic(`uncommitted-${kind}`), operationId: kind })
    ).rejects.toThrow(kind === "prompt-removed" ? /user message changed/ : "engine exited")
    const session = (await getDb().sessions.toArray()).find(
      (row) => row.agentTurnOwner?.key === topic(`uncommitted-${kind}`).sessionKey
    )!
    expect(session.runtimeTranscriptInvalidated).toEqual(expect.any(String))
  }
)

it("converts an owned interim delivery binding without changing its fixed topic key", async () => {
  jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
  jest.mocked(runAndCaptureAssistantReply).mockResolvedValue({
    text: "Reviewed",
    messageId: "converted-reply",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
  })
  const first = await runPluginAgentTurn(request, topic("A"))
  const interim = {
    platformBinding: topic("A").platformBinding,
    platformConversationKey: topic("A").platformBinding.conversationKey,
    imAuthorityBinding: undefined,
  }
  await getDb().sessions.update(first.sessionId, interim)
  const second = await runPluginAgentTurn(request, topic("A"))
  expect(second.sessionId).toBe(first.sessionId)
  expect(await getSession(second.sessionId)).toMatchObject({
    imAuthorityBinding: topic("A").platformBinding,
    agentTurnOwner: { key: topic("A").sessionKey },
  })
  expect((await getSession(second.sessionId))?.platformBinding).toBeUndefined()
  expect((await getSession(second.sessionId))?.platformConversationKey).toBeUndefined()
})

it("inherits the Bot control-plane event actor without turning that actor into a requester", async () => {
  const metadata = recordedRunMetadata("external-event", {
    runId: "bot-root",
    eventActors: [{ kind: "event-actor", source: "connector", externalId: "connected-owner" }],
  })
  await getDb().executionRuns.put({
    id: "bot-root",
    kind: "bot",
    sourceId: "installation",
    title: "Bot",
    status: "running",
    startedAt: 1,
    updatedAt: 1,
    currentRevision: 0,
    ...metadata,
  })
  jest
    .mocked(resolveSendOptions)
    .mockImplementation(async () => ({ cwd: "/repo", provider: "openai" }))
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id) => {
    expect(await resolveRunActingIdentity(id)).toMatchObject({
      rootRunId: "bot-root",
      trigger: "external-event",
      requesters: [],
      eventActors: [{ kind: "event-actor", source: "connector", externalId: "connected-owner" }],
    })
    return { text: "Reviewed", messageId: "parented-reply", a2uiSurfaces: {}, a2uiSurfaceOrder: [] }
  })
  await runPluginAgentTurn(request, { ...topic("A"), parentRunId: "bot-root" })
})

it("refuses personal access in an actual plugin turn's recorded identity", async () => {
  jest.mocked(resolveSendOptions).mockImplementation(async () => ({ cwd: "/repo" }))
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id) => {
    expect((await resolveRunActingIdentity(id))?.trigger).toBe("external-event")
    await expect(assertLarkActingIdentity("lark-1", { sessionId: id })).rejects.toThrow(
      /phases 4 and 5/i
    )
    return {
      text: "Refused personal access",
      messageId: "plugin-reply",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }
  })
  const result = await runPluginAgentTurn(request, {
    grantSource: { kind: "plugin", id: "review-plugin" },
  })
  expect((await listMessages(result.sessionId)).map((m) => m.role)).toEqual(["user", "assistant"])
})

it("drops a captured reply and resume id when history is cleared before final persistence", async () => {
  const { clearMessages } = await import("@/lib/db/messages")
  jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
  let clearedSession = ""
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id, _prompt, _opts, cap) => {
    await cap?.beforeSend?.()
    clearedSession = id
    const captured = {
      text: "obsolete reply",
      messageId: "obsolete",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }
    // The engine has completed; its resume-id callback is still settling.
    await clearMessages(id)
    await cap?.onSdkSessionId?.("obsolete-runtime")
    return { ...captured, sdkSessionId: "obsolete-runtime" }
  })
  await expect(runPluginAgentTurn(request, topic("A"))).rejects.toMatchObject({ code: "aborted" })
  expect(await listMessages(clearedSession)).toEqual([])
  expect((await getSession(clearedSession))?.sdkSessionId).not.toBe("obsolete-runtime")
})

it("fences the final transaction when a clear wins after capture has completed", async () => {
  const { clearMessages } = await import("@/lib/db/messages")
  jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
  const db = getDb()
  const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>
  let captured = false
  let sessionId = ""
  const intercept = jest.spyOn(db, "transaction")
  intercept.mockImplementation((async (...args: unknown[]) => {
    if (captured && args.includes(db.messages) && args.includes(db.messageMediaRefs)) {
      intercept.mockRestore()
      // Simulate a clear already queued for the database before the final
      // reply transaction can begin. The engine promise has resolved.
      await clearMessages(sessionId)
    }
    return transaction(...args)
  }) as typeof db.transaction)
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id, _prompt, _opts, cap) => {
    await cap?.beforeSend?.()
    sessionId = id
    captured = true
    return {
      text: "obsolete",
      messageId: "obsolete-final",
      sdkSessionId: "obsolete-final-runtime",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }
  })
  try {
    await expect(runPluginAgentTurn(request, topic("A"))).rejects.toMatchObject({ code: "aborted" })
    expect(await listMessages(sessionId)).toEqual([])
    expect((await getSession(sessionId))?.sdkSessionId).toBeUndefined()
  } finally {
    intercept.mockRestore()
  }
})

it("replays a committed operation after a crash before Bot step completion", async () => {
  jest.mocked(resolveSendOptions).mockImplementation(async () => ({ cwd: "/repo" }))
  jest
    .mocked(runAndCaptureAssistantReply)
    .mockReset()
    .mockImplementation(async (_id, _prompt, _options, cap) => {
      await cap?.beforeSend?.()
      return {
        text: "Committed reply",
        messageId: crypto.randomUUID(),
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      }
    })
  const options = { ...topic("crash-after-commit"), operationId: "delivery:committed" }
  jest.mocked(finishToolExecutionRun).mockRejectedValueOnce(new Error("crash after reply commit"))
  await expect(runPluginAgentTurn(request, options)).rejects.toThrow("crash after reply commit")
  const session = (await getDb().sessions.toArray()).find(
    (row) => row.agentTurnOwner?.key === options.sessionKey
  )!
  expect((await listMessages(session.id)).filter((row) => row.role === "assistant")).toHaveLength(1)
  const replay = await runPluginAgentTurn(request, options)
  expect(replay).toMatchObject({
    sessionId: session.id,
    text: "Committed reply",
    status: "completed",
  })
  expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
  expect((await listMessages(session.id)).map((row) => row.role)).toEqual(["user", "assistant"])
  await expect(runPluginAgentTurn({ ...request, prompt: "Changed" }, options)).rejects.toThrow(
    /operation prompt changed/
  )
})

it("serializes the operation namespace across different session identities", async () => {
  jest.mocked(resolveSendOptions).mockImplementation(async () => ({ cwd: "/repo" }))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  jest
    .mocked(runAndCaptureAssistantReply)
    .mockReset()
    .mockImplementation(async (_id, _prompt, _options, cap) => {
      await cap?.beforeSend?.()
      entered()
      await gate
      return {
        text: "One execution",
        messageId: crypto.randomUUID(),
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      }
    })
  const options = { ...topic("operation-race"), operationId: "operation-race" }
  const first = runPluginAgentTurn(request, options)
  await started
  const second = runPluginAgentTurn({ ...request, cwd: "/other-repo" }, options)
  const results = Promise.allSettled([first, second])
  await new Promise((resolve) => setTimeout(resolve, 30))
  release()
  const settled = await results
  expect(settled[0].status).toBe("fulfilled")
  expect(settled[1]).toMatchObject({
    status: "rejected",
    reason: { message: expect.stringContaining("operation prompt changed") },
  })
  expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
})

it("tombstones a deleted operation without retaining its reply or rerunning it", async () => {
  jest.mocked(resolveSendOptions).mockImplementation(async () => ({ cwd: "/repo" }))
  jest.mocked(runAndCaptureAssistantReply).mockReset().mockResolvedValue({
    text: "Private deleted reply",
    messageId: "deleted-reply",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
  })
  const options = { ...topic("deleted-operation"), operationId: "deleted-operation" }
  const result = await runPluginAgentTurn(request, options)
  await deleteSession(result.sessionId)
  const journal = await getDb().sharedRunJournals.toArray()
  expect(JSON.stringify(journal)).not.toContain("Private deleted reply")
  await expect(runPluginAgentTurn(request, options)).rejects.toThrow(/operation transcript deleted/)
  expect(await getSession(result.sessionId)).toBeUndefined()
  expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
})

it("settles a committed execution and books usage once when recovery replays it", async () => {
  jest
    .mocked(resolveSendOptions)
    .mockImplementation(async () => ({ cwd: "/repo", provider: "anthropic", model: "sonnet" }))
  jest
    .mocked(runAndCaptureAssistantReply)
    .mockReset()
    .mockResolvedValue({
      text: "Durable",
      messageId: "durable",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  const options = {
    ...topic("settlement"),
    operationId: "settlement",
    usage: { operationId: "settlement", sessionId: "bot:settlement" },
  }
  jest.mocked(finishToolExecutionRun).mockRejectedValueOnce(new Error("process lost after commit"))
  await expect(runPluginAgentTurn(request, options)).rejects.toThrow("process lost after commit")
  const completion = (await getDb().sharedRunJournals.toArray()).find(
    (row) => row.agentTurnOperation?.operationId === "settlement"
  )!.agentTurnOperation!
  expect((await getDb().executionRuns.get(completion.executionRunId!))?.status).toBe("running")
  const db = getDb()
  db.close()
  await db.open()
  await runPluginAgentTurn(request, options)
  await runPluginAgentTurn(request, options)
  expect((await db.executionRuns.get(completion.executionRunId!))?.status).toBe("completed")
  expect(await db.sessionUsage.where("sessionId").equals("bot:settlement").count()).toBe(1)
  expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
})

it.each(["clear", "delete", "truncate"])(
  "tombstones an operation after %s removes its reply",
  async (kind) => {
    jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
    jest.mocked(runAndCaptureAssistantReply).mockReset().mockResolvedValue({
      text: "Deleted content",
      messageId: "removed-content",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    const options = { ...topic(`remove-${kind}`), operationId: `remove-${kind}` }
    const result = await runPluginAgentTurn(request, options)
    if (kind === "clear") await clearMessages(result.sessionId)
    else if (kind === "delete") await deleteStoredMessage(result.messageId!)
    else await truncateAfter(result.sessionId, result.messageId!, { inclusive: true })
    expect(JSON.stringify(await getDb().sharedRunJournals.toArray())).not.toContain(
      "Deleted content"
    )
    await expect(runPluginAgentTurn(request, options)).rejects.toThrow(
      /operation transcript deleted/
    )
    expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
  }
)

it.each(["rewrite", "raw-delete"])(
  "refuses to replay a completed operation after a writer that skips tombstones does a %s",
  async (kind) => {
    jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
    jest.mocked(runAndCaptureAssistantReply).mockReset().mockResolvedValue({
      text: "Private reply",
      messageId: "private-reply",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    const options = { ...topic(`bypass-${kind}`), operationId: `bypass-${kind}` }
    const result = await runPluginAgentTurn(request, options)
    // Plugin repositories and raw-table access write rows without tombstoning.
    if (kind === "rewrite")
      await getDb().messages.update(result.messageId!, {
        parts: [{ type: "text", text: "Redacted" }],
      })
    else await getDb().messages.delete(result.messageId!)
    await expect(runPluginAgentTurn(request, options)).rejects.toThrow(
      /operation transcript changed/
    )
    expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
  }
)

it("keeps replaying a completed operation after an unrelated message is deleted", async () => {
  jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
  jest.mocked(runAndCaptureAssistantReply).mockReset().mockResolvedValue({
    text: "Kept reply",
    messageId: "kept-reply",
    a2uiSurfaces: {},
    a2uiSurfaceOrder: [],
  })
  const options = { ...topic("unrelated-delete"), operationId: "unrelated-delete" }
  const result = await runPluginAgentTurn(request, options)
  const prompt = (await getDb().messages.toArray()).find(
    (row) => row.sessionId === result.sessionId && row.role === "user"
  )!
  await getDb().messages.put({ ...prompt, id: "older-unrelated", createdAt: 1 })
  await deleteStoredMessage("older-unrelated")
  await expect(runPluginAgentTurn(request, options)).resolves.toMatchObject({
    sessionId: result.sessionId,
    text: "Kept reply",
  })
  expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
})

it.each(["missing", "changed"])(
  "replays original authoritative usage when retry booking is %s",
  async (kind) => {
    jest.mocked(resolveSendOptions).mockResolvedValue({
      cwd: "/repo",
      provider: "anthropic",
      model: "sonnet",
      execution: { runtimeAdapter: "claude-agent-sdk" } as SendOptions["execution"],
    })
    jest
      .mocked(runAndCaptureAssistantReply)
      .mockReset()
      .mockResolvedValue({
        text: "Durable charged reply",
        messageId: "charged-reply",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
        usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0 },
      })
    const options = {
      ...topic(`charge-${kind}`),
      operationId: `charge-${kind}`,
      usage: {
        operationId: `charge-${kind}`,
        sessionId: "bot:original",
        runId: "original-run",
        projectId: "original-project",
      },
    }
    jest.mocked(finishToolExecutionRun).mockRejectedValueOnce(new Error("crash"))
    await expect(runPluginAgentTurn(request, options)).rejects.toThrow("crash")
    // Simulate loss after the atomic transcript commit, before any mirror booking.
    await getDb().sessionUsage.clear()
    const retry = {
      ...options,
      usage:
        kind === "missing" ? undefined : { operationId: "different", sessionId: "bot:redirected" },
    }
    await runPluginAgentTurn(request, retry)
    await runPluginAgentTurn(request, retry)
    expect(await getDb().sessionUsage.toArray()).toEqual([
      expect.objectContaining({
        sessionId: "bot:original",
        runId: "original-run",
        projectId: "original-project",
        costKnown: true,
        costSource: "sdk",
        costUsd: 0,
      }),
    ])
    expect(runAndCaptureAssistantReply).toHaveBeenCalledTimes(1)
  }
)

it("persists Host run marks on captured plugin turns and keeps a later unmarked run independent", async () => {
  jest.mocked(resolveSendOptions).mockResolvedValue({ cwd: "/repo" })
  let turn = 0
  jest.mocked(runAndCaptureAssistantReply).mockImplementation(async (id) => {
    const runs = await getDb().executionRuns.where("sessionId").equals(id).toArray()
    const current = runs.find((run) => run.status === "running")!
    if (turn++ === 0)
      await getDb().executionRuns.update(current.id, {
        personalMarks: [{ person: { kind: "local-person" }, source: "google-docs", markedAt: 10 }],
      })
    return {
      text: "captured answer",
      messageId: `marked-capture-${turn}`,
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }
  })
  const first = await runPluginAgentTurn(request, {
    grantSource: { kind: "plugin", id: "marked-plugin" },
  })
  await runPluginAgentTurn(
    { ...request, sessionId: first.sessionId },
    { grantSource: { kind: "plugin", id: "marked-plugin" } }
  )
  const rows = await listMessages(first.sessionId)
  expect(rows.find((row) => row.id === "marked-capture-1")?.metadata).toMatchObject({
    personalMarks: [{ person: { kind: "local-person" }, source: "google-docs", markedAt: 10 }],
  })
  expect(rows.find((row) => row.id === "marked-capture-2")?.metadata).not.toHaveProperty(
    "personalMarks"
  )
})
