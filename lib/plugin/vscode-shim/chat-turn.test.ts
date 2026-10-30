import type { ClaudeEvent, SDKMessage } from "@cognia/agent-config-types"
import {
  configureChatRegistry,
  handleChatParticipantRespond,
  handleCreateChatParticipant,
  resolveVscodeChatParticipant,
  __resetChatRegistryForTesting,
} from "./chat-participant-registry"
import { applySdkEvent } from "@/lib/claude/adapter"
import {
  participantHistory,
  participantPrompt,
  runVscodeChatAgentTurn,
  runVscodeChatTurn,
} from "./chat-turn"

beforeEach(() => {
  __resetChatRegistryForTesting()
  configureChatRegistry({
    upsertCharacter: async () => {},
    activate: async () => {},
    canInvoke: async () => true,
  })
})

it("streams extension markdown into assistant snapshots and the final result, with progress and references", async () => {
  await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
  const target = await resolveVscodeChatParticipant("vscode-chat:ext:helper")
  const provider = jest.fn(async (_owner, _method, raw) => {
    const request = raw as { requestId: string; context: { history: unknown[] } }
    expect(request.context.history).toHaveLength(2)
    for (const part of [
      { kind: "progress", value: "Searching" },
      { kind: "markdown", value: "Hello" },
      { kind: "reference", value: "https://example.com/source" },
      { kind: "markdown", value: " world" },
    ]) {
      await handleChatParticipantRespond({
        extensionId: "ext",
        id: "helper",
        requestId: request.requestId,
        part: part as never,
      })
    }
    return { metadata: { complete: true } }
  })
  configureChatRegistry({ callProvider: provider })
  const events: ClaudeEvent[] = []
  await runVscodeChatTurn({
    sessionId: "s",
    turnId: "turn-1",
    characterId: target.characterId,
    binding: target,
    prompt: "question",
    signal: new AbortController().signal,
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "before" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "answer" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "question" }] },
    ],
    emit: async (event) => {
      events.push(event)
    },
  })
  expect(events.every((event) => "turnId" in event && event.turnId === "turn-1")).toBe(true)
  const messages = events
    .filter((event): event is Extract<ClaudeEvent, { type: "event" }> => event.type === "event")
    .map((event) => event.event) as SDKMessage[]
  expect(messages.find((message) => message.type === "result")).toEqual(
    expect.objectContaining({ result: "Hello world" })
  )
  expect(messages.filter((message) => message.type === "assistant").at(-1)).toEqual(
    expect.objectContaining({
      message: expect.objectContaining({
        content: expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Hello world" }),
        ]),
      }),
    })
  )
  const projected = messages.reduce(
    (rows, event) => applySdkEvent(rows, event).messages,
    [] as import("ai").UIMessage[]
  )
  expect(projected.flatMap((message) => message.parts)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "data-commentary", data: { text: "Searching" } }),
    ])
  )
  expect(
    projected.find(
      (message) => (message.metadata as { vscodeChat?: unknown } | undefined)?.vscodeChat
    )?.metadata
  ).toEqual(
    expect.objectContaining({
      vscodeChat: expect.objectContaining({ result: { metadata: { complete: true } } }),
    })
  )
  expect(
    messages.some(
      (message) => message.type === "system" && String(message.subtype).startsWith("task_")
    )
  ).toBe(false)
  expect(participantHistory(projected, target).at(-1)?.result).toEqual({
    metadata: { complete: true },
  })
  expect(events.at(-1)).toEqual({ type: "session_ended", sessionId: "s", turnId: "turn-1" })
})

it("reports unsupported attachments without invoking the extension", async () => {
  const provider = jest.fn()
  configureChatRegistry({ callProvider: provider })
  const events: ClaudeEvent[] = []
  await runVscodeChatTurn({
    sessionId: "s",
    turnId: "turn-1",
    characterId: "vscode-chat:ext:p",
    prompt: [{ type: "image" }],
    binding: { pluginId: "ext", participantId: "p", generation: "g" },
    messages: [],
    signal: new AbortController().signal,
    emit: (event) => {
      events.push(event)
    },
  })
  expect(provider).not.toHaveBeenCalled()
  expect(events.at(-1)).toEqual(
    expect.objectContaining({
      type: "session_ended",
      error: expect.stringContaining("text requests only"),
    })
  )
  expect(() => participantPrompt([{ type: "text", text: "x" }, { type: "document" }])).toThrow(
    "text requests only"
  )
})

it("runs the background rail with the same callback, history, streaming, and cancellation token", async () => {
  await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
  const target = await resolveVscodeChatParticipant("vscode-chat:ext:helper")
  configureChatRegistry({
    callProvider: async (_owner, _method, raw, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      const request = raw as { requestId: string; context: { history: unknown[] } }
      expect(request.context.history).toHaveLength(1)
      await handleChatParticipantRespond({
        extensionId: "ext",
        id: "helper",
        requestId: request.requestId,
        part: { kind: "markdown", value: "background answer" },
      })
      return {}
    },
  })
  const onDelta = jest.fn()
  const result = await runVscodeChatAgentTurn(
    "question",
    { priorMessages: [{ role: "user", content: "before" }], onDelta },
    target
  )
  expect(result).toEqual(
    expect.objectContaining({
      text: "background answer",
      channel: "sidecar",
      toolsAvailable: false,
      finishReason: "stop",
      messageMetadata: { vscodeChat: { pluginId: "ext", participantId: "helper", result: {} } },
    })
  )
  expect(onDelta).toHaveBeenCalledWith("background answer")
})

it.each(["throw", "errorDetails"])(
  "seals partial output and reports an extension %s failure without a success result",
  async (mode) => {
    await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
    const target = await resolveVscodeChatParticipant("vscode-chat:ext:helper")
    configureChatRegistry({
      callProvider: async (_id, _method, raw) => {
        await handleChatParticipantRespond({
          extensionId: "ext",
          id: "helper",
          requestId: (raw as { requestId: string }).requestId,
          part: { kind: "markdown", value: "partial" },
        })
        if (mode === "throw") throw new Error("Denied")
        return { errorDetails: { message: "Denied" } }
      },
    })
    const events: ClaudeEvent[] = []
    await runVscodeChatTurn({
      sessionId: "s",
      turnId: "failed-turn",
      characterId: target.characterId,
      binding: target,
      prompt: "q",
      messages: [],
      signal: new AbortController().signal,
      emit: (event) => {
        events.push(event)
      },
    })
    expect(events.at(-1)).toEqual({
      type: "session_ended",
      sessionId: "s",
      turnId: "failed-turn",
      error: "Denied",
    })
    const messages = events
      .filter((event): event is Extract<ClaudeEvent, { type: "event" }> => event.type === "event")
      .map((event) => event.event)
    expect(messages.some((message) => message.type === "result")).toBe(false)
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant",
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: "partial" }),
            ]),
          }),
        }),
      ])
    )
  }
)

it("fences aborted output with the original turn and emits no successful result", async () => {
  await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
  const target = await resolveVscodeChatParticipant("vscode-chat:ext:helper")
  const controller = new AbortController()
  configureChatRegistry({
    callProvider: async (_id, _method, raw) => {
      await handleChatParticipantRespond({
        extensionId: "ext",
        id: "helper",
        requestId: (raw as { requestId: string }).requestId,
        part: { kind: "markdown", value: "partial" },
      })
      controller.abort()
      return {}
    },
  })
  const events: ClaudeEvent[] = []
  await runVscodeChatTurn({
    sessionId: "s",
    turnId: "old-turn",
    characterId: target.characterId,
    binding: target,
    prompt: "q",
    messages: [],
    signal: controller.signal,
    emit: (event) => {
      events.push(event)
    },
  })
  expect(events.every((event) => "turnId" in event && event.turnId === "old-turn")).toBe(true)
  expect(events.some((event) => event.type === "event" && event.event.type === "result")).toBe(
    false
  )
  expect(events.at(-1)).toEqual({ type: "session_ended", sessionId: "s", turnId: "old-turn" })
})

it("applies background timeouts to the extension callback", async () => {
  await handleCreateChatParticipant({ extensionId: "ext", id: "helper", token: "callback" })
  const target = await resolveVscodeChatParticipant("vscode-chat:ext:helper")
  configureChatRegistry({
    callProvider: async (_id, _method, _raw, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true }
        )
      }),
  })
  await expect(runVscodeChatAgentTurn("q", { timeoutMs: 20 }, target)).rejects.toMatchObject({
    name: "AbortError",
  })
})
