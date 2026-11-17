"use client"

import type { RefObject } from "react"
import type { useTranslations } from "next-intl"
import { toast } from "sonner"

import { closeSession } from "@/lib/ai/agent/execution/sidecar-client"
import { pickChatContinuationMetadata } from "@/lib/chat/continuation"
import {
  canAutomaticallyDrainSharedQueue,
  sharedRequestTranscript,
} from "@/lib/collab/shared-run-coordinator"
import { isRoomAsleepRefusal } from "@/lib/collab/shared-room-settings"
import { getSession } from "@/lib/db/sessions"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { useChatStore } from "@/stores/chat"

import type { SendFn } from "./agent-chat-turn-tasks"

export interface SharedQueueDrainContext {
  /** The controller's public send, read at drain time. */
  sendRef: RefObject<SendFn | null>
  /** Read at failure time: the listener installs once. */
  tCollabRef: RefObject<ReturnType<typeof useTranslations<"chatCollaboration">>>
}

/**
 * Run a shared (collaboration) session's queued AI requests on this device.
 *
 * Listens for `cognia:shared-request-ai` (a member asked for a reply here),
 * `cognia:shared-queue-updated` and `cognia:shared-run-completed`. Each pulse
 * syncs the room, enqueues a requested message, and — once the session is idle
 * and, for an automatic pulse, this device may drain the queue — sends the
 * next queued request with the room's transcript. One drain per session at a
 * time; a pulse during one is replayed after it, and a drain refused while a
 * turn runs waits for the session to go idle. Returns the teardown.
 */
export function installSharedQueueDrain({
  sendRef,
  tCollabRef,
}: SharedQueueDrainContext): () => void {
  const inFlight = new Set<string>()
  const pendingDrains = new Set<string>()
  const pendingPulses = new Set<string>()
  let disposed = false
  const request = async (event: Event) => {
    const detail = (
      event as CustomEvent<{ sessionId: string; messageId?: string; takeover?: boolean }>
    ).detail
    if (!detail?.sessionId || disposed) return
    if (inFlight.has(detail.sessionId)) {
      if (event.type === "cognia:shared-queue-updated") pendingPulses.add(detail.sessionId)
      return
    }
    inFlight.add(detail.sessionId)
    try {
      const target = await getSession(detail.sessionId)
      if (!target?.collaboration) return
      const { resolveCurrentCollabContext } = await import("@/lib/collab/runtime-client")
      const context = await resolveCurrentCollabContext()
      if (
        !context ||
        context.orgId !== target.collaboration.orgId ||
        (target.collaboration.endpoint && target.collaboration.endpoint !== context.client.baseUrl)
      )
        return
      const { syncSharedSession } = await import("@/lib/collab/shared-chat-sync")
      const synced = await syncSharedSession(
        context.client,
        context.orgId,
        target.collaboration.sessionId
      )
      const { getDb } = await import("@/lib/db/schema")
      const messages = await getDb().messages.where("sessionId").equals(detail.sessionId).toArray()
      if (detail.messageId) {
        const message = messages.find((candidate) => candidate.id === detail.messageId)
        if (!message || message.role !== "user") return
        const remoteId = message.collaboration?.remoteMessageId ?? message.id
        await context.client.enqueueSessionRunInput(context.orgId, target.collaboration.sessionId, {
          payload: { messageId: remoteId },
          operationId: `ai-request:${crypto.randomUUID()}`,
        })
      }
      const slice = useChatStore.getState().sessions[detail.sessionId]
      if (slice?.status === "streaming" || slice?.status === "awaiting_approval") {
        if (!detail.messageId) pendingDrains.add(detail.sessionId)
        return
      }
      const [next] = await context.client.listSessionRunQueue(
        context.orgId,
        target.collaboration.sessionId
      )
      if (!next) return
      if (event.type === "cognia:shared-queue-updated") {
        const { getDeviceId } = await import("@/lib/device/device-identity")
        if (
          !(await canAutomaticallyDrainSharedQueue(
            context,
            target.collaboration.sessionId,
            Math.max(
              synced?.cursor ?? target.collaboration.syncCursor,
              Number(next.payload.contextSequence)
            ),
            await getDeviceId()
          ))
        )
          return
      }
      const messageId = String(next.payload.messageId)
      const message = messages.find(
        (candidate) => (candidate.collaboration?.remoteMessageId ?? candidate.id) === messageId
      )
      if (!message) return
      const content = await sharedRequestTranscript(
        context.client,
        context.orgId,
        target.collaboration.sessionId,
        Number(next.payload.contextSequence)
      )
      if (!isStandaloneChatMode()) await closeSession(detail.sessionId)
      await sendRef.current?.(content, undefined, {
        sessionId: detail.sessionId,
        skipUserAppend: true,
        sharedRequest: { messageId, queueItemId: next.id, takeover: detail.takeover },
        ...(typeof pickChatContinuationMetadata(message.metadata)?.continuationOf === "string"
          ? {
              continuationOf: pickChatContinuationMetadata(message.metadata)!
                .continuationOf as string,
            }
          : {}),
      })
    } catch (error) {
      // An asleep room answers nobody: the refusal is the room's setting
      // working, not a failure (the server audited the silence).
      if (isRoomAsleepRefusal(error)) {
        toast.info(tCollabRef.current("roomAsleepRefused"))
        return
      }
      useChatStore
        .getState()
        .setSessionDiagnostic(
          detail.sessionId,
          toDiagnostic(error, { source: "chat", meta: { sessionId: detail.sessionId } })
        )
    } finally {
      inFlight.delete(detail.sessionId)
      if (pendingPulses.delete(detail.sessionId) && !disposed) {
        queueMicrotask(() =>
          listener(
            new CustomEvent("cognia:shared-queue-updated", {
              detail: { sessionId: detail.sessionId },
            })
          )
        )
      }
    }
  }
  const listener = (event: Event) => {
    void request(event)
  }
  const unsubscribe = useChatStore.subscribe((state) => {
    for (const sessionId of pendingDrains) {
      if (state.sessions[sessionId]?.status !== "idle") continue
      pendingDrains.delete(sessionId)
      queueMicrotask(() =>
        listener(new CustomEvent("cognia:shared-queue-updated", { detail: { sessionId } }))
      )
    }
  })
  window.addEventListener("cognia:shared-queue-updated", listener)
  window.addEventListener("cognia:shared-request-ai", listener)
  window.addEventListener("cognia:shared-run-completed", listener)
  return () => {
    unsubscribe()
    disposed = true
    window.removeEventListener("cognia:shared-queue-updated", listener)
    window.removeEventListener("cognia:shared-request-ai", listener)
    window.removeEventListener("cognia:shared-run-completed", listener)
  }
}
