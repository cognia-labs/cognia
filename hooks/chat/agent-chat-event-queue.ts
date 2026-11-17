"use client"

import type React from "react"
import { handleEvent } from "./agent-chat-events"
import { desktopTurnLeases, type DesktopTurnLease } from "./agent-chat-turn-leases"
import { type SendFn } from "./agent-chat-turn-tasks"
import { type AgentExecutionHandle } from "@/lib/ai/agent/execution/agent-execution-handle"
import { hasCaptureResponder } from "@/lib/ai/agent/execution/hitl/approval-registry"
import { type SilenceWatchdog } from "@/lib/chat/silence-watchdog"
import { type SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import { type TranscriptRuntimeFence } from "@/lib/chat/transcript/revision-events"
import { sessionTurnLockKey } from "@/lib/execution/session-turn-lock"
import { type ClaudeEvent } from "@cognia/agent-config-types"
import { type UIMessage } from "ai"

/** What these operations read from `useAgentChat`. */
export interface AgentChatEventQueueContext {
  activeRef: React.RefObject<string | null>
  messagesMirrorRef: React.RefObject<Map<string, UIMessage[]>>
  allowListRef: React.RefObject<string[]>
  asideContextDispatchRef: React.RefObject<
    Map<
      string,
      {
        acknowledgeSdk(id: string, eventTurnId?: string | undefined): Promise<void>
        dispatched(): Promise<void>
        cancel(): void
      }
    >
  >
  pendingBranchTagRef: React.RefObject<Map<string, { groupId: string; index: number }>>
  pendingBranchOwnerRef: React.RefObject<Map<string, string>>
  sendRef: React.RefObject<SendFn | null>
  continueFromLeaseRef: React.RefObject<
    ((lease: DesktopTurnLease | undefined, args: Parameters<SendFn>) => ReturnType<SendFn>) | null
  >
  eventQueuesRef: React.RefObject<Map<string, Promise<void>>>
  getExecutionHandle: (sessionId: string) => AgentExecutionHandle | undefined
  registry: SessionCoalescingRegistry
  transcriptFenceRef: React.RefObject<TranscriptRuntimeFence | null>
  silenceWatchdogRef: React.RefObject<SilenceWatchdog | null>
}

export function enqueueAgentChatEvent(
  ctx: Pick<
    AgentChatEventQueueContext,
    | "activeRef"
    | "messagesMirrorRef"
    | "allowListRef"
    | "asideContextDispatchRef"
    | "pendingBranchTagRef"
    | "pendingBranchOwnerRef"
    | "sendRef"
    | "continueFromLeaseRef"
    | "eventQueuesRef"
    | "getExecutionHandle"
    | "registry"
    | "transcriptFenceRef"
    | "silenceWatchdogRef"
  >,
  evt: ClaudeEvent
) {
  const {
    activeRef,
    messagesMirrorRef,
    allowListRef,
    asideContextDispatchRef,
    pendingBranchTagRef,
    pendingBranchOwnerRef,
    sendRef,
    continueFromLeaseRef,
    eventQueuesRef,
    getExecutionHandle,
    registry,
    transcriptFenceRef,
    silenceWatchdogRef,
  } = ctx

  // Snapshot ownership before queuing: the capture may settle and release
  // its turn before this session's queued transcript work drains.
  if (hasCaptureResponder(evt)) return Promise.resolve()
  const key =
    typeof (evt as { sessionId?: unknown }).sessionId === "string"
      ? (evt as { sessionId: string }).sessionId
      : "__nosession__"
  // Any frame naming a session is a sign of life for that turn. Fed here
  // rather than from a second subscription so there is one demux, not two.
  if (key !== "__nosession__") silenceWatchdogRef.current?.notice(key)
  const queues = eventQueuesRef.current
  const tail = (queues.get(key) ?? Promise.resolve())
    // A prior failure must not break the chain for later events.
    .catch(() => {})
    .then(() => {
      // A continuation this frame decides belongs to the turn that holds the
      // lease now. It joins exactly that lease; a lease taken since by another
      // turn, or a pending Stop, sends it back through public admission.
      const lease =
        key === "__nosession__" ? undefined : desktopTurnLeases.get(sessionTurnLockKey(key))
      const continuation: SendFn = (...args) =>
        continueFromLeaseRef.current?.(lease, args) ??
        sendRef.current?.(...args) ??
        Promise.resolve()
      // Only around a synchronous drain: clearing the steer queue notifies the
      // store before the replay joins, and that nested settle must not release
      // the lease (release is async). Never across a handler's awaits.
      const holdTurnLease = (work: () => void) => {
        if (!lease) return work()
        lease.pendingDispatches++
        try {
          work()
        } finally {
          lease.pendingDispatches--
          lease.settle()
        }
      }
      return handleEvent(
        evt,
        activeRef,
        allowListRef,
        pendingBranchTagRef,
        pendingBranchOwnerRef,
        sendRef,
        {
          messagesMirrorRef,
          registry,
          transcriptFence: transcriptFenceRef.current ?? undefined,
          getExecutionHandle,
          ownedContinuationRef: { current: continuation },
          holdTurnLease,
        }
      )
    })
    .then(async () => {
      if (evt.type === "sdk_session_id") {
        await asideContextDispatchRef.current
          .get(evt.sessionId)
          ?.acknowledgeSdk(evt.sdkSessionId, (evt as typeof evt & { turnId?: string }).turnId)
      }
    })
    .catch((err) => {
      console.error("handleEvent failed", err)
    })
  queues.set(key, tail)
  // Drop the entry once the chain drains so the map doesn't grow per event.
  void tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return tail
}
