import { toolCallEgressRunId } from "@/lib/execution/acting-authority"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import { onClaudeMessage } from "@/lib/ai/agent/execution/sidecar-client"
import type { ClaudeEvent } from "@cognia/agent-config-types"
import { getPluginEventHooks } from "./hooks-system"

type StreamState = {
  messageId?: string
  content: string
  execution: PersonalCredentialContext
  owner: string
}

/** One transport observer covers both interactive chat and autonomous captures. */
export function installStreamHookSource(): () => void {
  const streams = new Map<string, StreamState>()
  const completedMessages = new Map<string, string>()
  let stopped = false
  let unsubscribe: (() => void) | undefined
  const end = (sessionId: string) => {
    const state = streams.get(sessionId)
    if (!state) return
    streams.delete(sessionId)
    if (state.messageId) {
      completedMessages.set(sessionId, state.messageId)
      if (completedMessages.size > 128)
        completedMessages.delete(completedMessages.keys().next().value!)
    }
    getPluginEventHooks().dispatchStreamEnd(sessionId, state.content, state.execution)
  }
  const begin = (
    sessionId: string,
    messageId: string | undefined,
    execution: PersonalCredentialContext,
    owner: string
  ): StreamState => {
    const previous = streams.get(sessionId)
    if (previous && previous.messageId === messageId && previous.owner === owner) return previous
    end(sessionId)
    // Bound unfinished streams when a transport dies without a terminal event.
    if (streams.size >= 128) end(streams.keys().next().value!)
    const state: StreamState = { messageId, content: "", execution, owner }
    streams.set(sessionId, state)
    getPluginEventHooks().dispatchStreamStart(sessionId, execution)
    return state
  }
  const observe = (frame: ClaudeEvent) => {
    if (stopped) return
    if (frame.type === "sidecar_exited") {
      for (const sessionId of [...streams.keys()]) end(sessionId)
      return
    }
    if (!("sessionId" in frame) || typeof frame.sessionId !== "string") return
    const { sessionId } = frame
    const identity = frame as ClaudeEvent & { turnId?: string; attemptId?: string }
    const execution = {
      sessionId,
      executionRunId: toolCallEgressRunId(sessionId, identity.turnId, identity.attemptId),
    }
    const owner = JSON.stringify([identity.turnId, identity.attemptId])
    const endOwned = () => {
      if (!identity.turnId || streams.get(sessionId)?.owner === owner) end(sessionId)
    }
    if (frame.type === "session_ended") {
      endOwned()
      return
    }
    if (frame.type !== "event") return
    const event = frame.event as {
      type?: string
      event?: { type?: string; message?: { id?: string }; delta?: { type?: string; text?: string } }
      message?: { id?: string; content?: Array<{ type?: string; text?: string }> }
    }
    if (event.type === "result") {
      endOwned()
      return
    }
    if (event.type === "stream_event") {
      const stream = event.event
      if (stream?.type === "message_start") begin(sessionId, stream.message?.id, execution, owner)
      else if (
        stream?.type === "content_block_delta" &&
        stream.delta?.type === "text_delta" &&
        stream.delta.text
      ) {
        const previous = streams.get(sessionId)
        const state =
          previous?.owner === owner ? previous : begin(sessionId, undefined, execution, owner)
        state.content += stream.delta.text
        getPluginEventHooks().dispatchStreamChunk(
          sessionId,
          stream.delta.text,
          state.content,
          state.execution
        )
      } else if (stream?.type === "message_stop") endOwned()
    } else if (event.type === "assistant") {
      if (event.message?.id && completedMessages.get(sessionId) === event.message.id) return
      const existing = streams.get(sessionId)
      // Some providers stream text before supplying the assistant message id.
      // The snapshot identifies that same stream; only two known differing ids
      // establish a new message boundary.
      if (existing?.owner === owner && !existing.messageId) existing.messageId = event.message?.id
      const text = (event.message?.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
      const state = begin(sessionId, event.message?.id, execution, owner)
      if (text.startsWith(state.content) && text.length > state.content.length) {
        const delta = text.slice(state.content.length)
        state.content = text
        getPluginEventHooks().dispatchStreamChunk(sessionId, delta, text, state.execution)
      }
    }
  }
  void onClaudeMessage(observe)
    .then((stop) => {
      if (stopped) stop()
      else unsubscribe = stop
    })
    .catch(() => {
      /* A host with no agent transport has no streams to observe. */
    })
  return () => {
    stopped = true
    unsubscribe?.()
    streams.clear()
    completedMessages.clear()
  }
}
