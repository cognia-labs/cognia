/** Adapts extension responses to the existing chat stream and agent service rails. */
import type { UIMessage } from "ai"
import type { ClaudeEvent, SDKMessage } from "@cognia/agent-config-types"
import type { ExecuteAgentConfig, ExecuteAgentResult } from "@/lib/ai/agent/agent-executor"
import { createSdkEventMapper } from "@/lib/ai/chat/sdk-event-mapper"
import {
  runVscodeChatParticipant,
  type ChatParticipantHistoryTurn,
} from "./chat-participant-registry"

type Binding = { pluginId: string; participantId: string; generation: string }

export function participantPrompt(value: unknown): string {
  if (typeof value === "string") return value
  if (
    Array.isArray(value) &&
    value.every((part) => part?.type === "text" && typeof part.text === "string")
  ) {
    return value.map((part) => part.text).join("\n")
  }
  throw new Error("Chat participants currently accept text requests only")
}

export function participantHistory(
  messages: UIMessage[],
  binding?: Binding
): ChatParticipantHistoryTurn[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .flatMap((message) => {
      const previous = (
        message.metadata as
          | {
              vscodeChat?: {
                pluginId: string
                participantId: string
                result: { metadata?: unknown }
              }
            }
          | undefined
      )?.vscodeChat
      if (
        binding &&
        previous &&
        (previous.pluginId !== binding.pluginId || previous.participantId !== binding.participantId)
      )
        return []
      if (message.parts.some((part) => ["file", "image", "audio", "video"].includes(part.type)))
        throw new Error("Chat participant history supports text only")
      const content = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      return content || previous
        ? [
            {
              role: message.role as "user" | "assistant",
              content,
              ...(previous ? { participant: previous.participantId, result: previous.result } : {}),
            },
          ]
        : []
    })
}

export async function runVscodeChatTurn(input: {
  sessionId: string
  turnId: string
  characterId: string
  prompt: unknown
  binding: Binding
  messages: UIMessage[]
  signal: AbortSignal
  emit: (event: ClaudeEvent) => void | Promise<void>
}): Promise<void> {
  const { sessionId, turnId, signal, emit, binding } = input
  const sdkSessionId = globalThis.crypto.randomUUID()
  const mapper = createSdkEventMapper({
    sessionId,
    sdkSessionId,
    provider: "vscode-chat",
    model: binding.participantId,
  })
  mapper.reset()
  const envelope = async (event: SDKMessage) => {
    await emit({ type: "event", sessionId, turnId, event })
  }
  let error: string | undefined
  let cancelled = false
  let text = ""
  let metadata: unknown
  try {
    const result = await runVscodeChatParticipant({
      characterId: input.characterId,
      prompt: participantPrompt(input.prompt),
      sessionId,
      generation: binding.generation,
      history: participantHistory(input.messages.slice(0, -1), binding),
      signal,
      onPart: async (part) => {
        if (part.kind === "progress") {
          for (const event of mapper.setCommentary(part.value)) await envelope(event)
          return
        }
        if (part.kind === "markdown") text += part.value
        const events =
          part.kind === "markdown"
            ? mapper.handle({ type: "text-delta", text: part.value })
            : mapper.handle({
                type: "source-url",
                sourceId: globalThis.crypto.randomUUID(),
                url: part.value,
                title: part.value,
              })
        for (const event of events) await envelope(event)
      },
    })
    metadata = result.metadata
  } catch (caught) {
    cancelled = signal.aborted || (caught instanceof Error && caught.name === "AbortError")
    if (!cancelled) error = caught instanceof Error ? caught.message : String(caught)
  }
  const messageMetadata = {
    vscodeChat: {
      pluginId: binding.pluginId,
      participantId: binding.participantId,
      result: { ...(metadata !== undefined ? { metadata } : {}) },
    },
  }
  for (const event of mapper.handle({ type: "message-metadata", messageMetadata }))
    await envelope(event)
  const sealed = mapper.sealAssistant()
  if (!sealed.length && metadata !== undefined)
    sealed.push({
      type: "assistant",
      uuid: globalThis.crypto.randomUUID(),
      session_id: sdkSessionId,
      message: {
        id: globalThis.crypto.randomUUID(),
        role: "assistant",
        content: [],
        metadata: messageMetadata,
      },
    })
  for (const event of sealed) await envelope(event)
  if (!error && !cancelled)
    for (const event of mapper.finish())
      await envelope(event.type === "result" ? { ...event, result: text } : event)
  await emit({ type: "session_ended", sessionId, turnId, ...(error ? { error } : {}) })
}

export async function runVscodeChatAgentTurn(
  prompt: string,
  config: ExecuteAgentConfig,
  binding: Binding
): Promise<ExecuteAgentResult> {
  let history = config.priorMessages
    ? participantHistory(
        config.priorMessages.map((message, index) => ({
          id: `prior-${index}`,
          role: message.role,
          parts: [{ type: "text" as const, text: message.content }],
          ...(message.metadata ? { metadata: message.metadata } : {}),
        })),
        binding
      )
    : undefined
  if (!history && config.sessionId) {
    const { listMessages } = await import("@/lib/db/messages")
    history = participantHistory(await listMessages(config.sessionId), binding)
  }
  const signal =
    config.timeoutMs && config.timeoutMs > 0
      ? AbortSignal.any([
          ...(config.abortSignal ? [config.abortSignal] : []),
          AbortSignal.timeout(config.timeoutMs),
        ])
      : config.abortSignal
  const result = await runVscodeChatParticipant({
    characterId: `vscode-chat:${binding.pluginId}:${binding.participantId}`,
    prompt,
    sessionId: config.sessionId ?? globalThis.crypto.randomUUID(),
    history,
    signal,
    generation: binding.generation,
    onPart: (part) => {
      if (part.kind !== "markdown") return
      config.onDelta?.(part.value)
      config.onEvent?.({ type: "text-delta", delta: part.value })
    },
  })
  return {
    text: result.text,
    channel: "sidecar",
    toolsAvailable: false,
    finishReason: "stop",
    messageMetadata: {
      vscodeChat: {
        pluginId: binding.pluginId,
        participantId: binding.participantId,
        result: { ...(result.metadata !== undefined ? { metadata: result.metadata } : {}) },
      },
    },
  }
}
