"use client"

import type { RefObject } from "react"

import type { ExternalAgentEvent } from "@/types/agent/external-agent"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { useChatStore } from "@/stores/chat"

import type { AgentChatSendContext } from "./agent-chat-send"
import { createExternalIdleEventConsumer } from "./agent-chat-turn-helpers"

export type ExternalIdleSubscriptionContext = Pick<
  AgentChatSendContext,
  "registry" | "externalTurnSettlementsRef" | "externalToolHostsRef"
> & {
  /** The controller's per-session serialized event queues. */
  eventQueuesRef: RefObject<Map<string, Promise<void>>>
}

/**
 * Follow every external-agent session link for events the runtime delivers
 * outside an owned turn (`delivery: "out_of_band"`: a background handoff, a
 * remote Host's own run). Local links listen on the external agent manager; a
 * link with a `host` watches the remote session. Each event is queued behind
 * the session's owned turn and any earlier event, and a link that changes or
 * disappears is unsubscribed (pausing its renderer tool host when no owned turn
 * still needs it). Returns the teardown.
 */
export function subscribeExternalIdleEvents({
  registry,
  eventQueuesRef,
  externalTurnSettlementsRef,
  externalToolHostsRef,
}: ExternalIdleSubscriptionContext): () => void {
  let disposed = false
  const subscriptions = new Map<string, { key: string; unsubscribe: () => void }>()
  let sync: (() => void) | undefined
  const unsubscribeRuntime = useAgentRuntimeStore.subscribe(() => sync?.())
  void import("@/lib/ai/agent/external/manager").then(({ getExternalAgentManager }) => {
    if (disposed) return
    const manager = getExternalAgentManager()
    sync = () => {
      const links = useAgentRuntimeStore.getState().sessionExternalLinks
      for (const [id, subscription] of subscriptions) {
        const link = links[id]
        if (!link || subscription.key !== JSON.stringify(link)) {
          subscription.unsubscribe()
          subscriptions.delete(id)
          if (!externalTurnSettlementsRef.current.has(id)) {
            const hosted = externalToolHostsRef.current.get(id)
            if (hosted) {
              manager.setSessionHostFacts(hosted.agentId, id, null)
              void hosted.host
                .pause()
                .catch((error) => console.warn("External tool host pause failed", error))
            }
          }
        }
      }
      for (const [id, link] of Object.entries(links)) {
        if (subscriptions.has(id)) continue
        let decisionRunId: string | undefined
        const consume = createExternalIdleEventConsumer(
          id,
          link.agentId,
          link.sessionId,
          registry,
          link.host ? () => decisionRunId : undefined
        )
        const accept = (event: ExternalAgentEvent) => {
          if (event.delivery !== "out_of_band" || event.sessionId !== link.sessionId) return
          const previous = eventQueuesRef.current.get(id) ?? Promise.resolve()
          const ownedTurn = externalTurnSettlementsRef.current.get(id)
          const next = previous
            .then(async () => {
              // A runtime can hand off immediately after its command ACK,
              // before the owned send finishes its final persistence.
              await ownedTurn
              if (!disposed) await consume(event)
            })
            .catch((error) => {
              console.error("External background event failed", error)
              useChatStore
                .getState()
                .setSessionError(id, error instanceof Error ? error.message : String(error))
            })
          eventQueuesRef.current.set(id, next)
        }
        const failRemoteBackground = (error: string) => {
          accept({
            type: "error",
            error,
            sessionId: link.sessionId,
            timestamp: new Date(),
            delivery: "out_of_band",
          })
          accept({
            type: "done",
            success: false,
            sessionId: link.sessionId,
            timestamp: new Date(),
            delivery: "out_of_band",
          })
        }
        let unsubscribe: () => void
        if (link.host) {
          let cancelled = false
          let close: (() => Promise<void>) | undefined
          void import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
            .then(async ({ watchRemoteSession }) => {
              if (cancelled) return
              const watcher = await watchRemoteSession(
                { stamp: link.host!, chatSessionId: id, externalSessionId: link.sessionId },
                {
                  onEvent: (event, frame) => {
                    decisionRunId = frame.runId
                    accept(event)
                  },
                  onTerminal: (_status, error) =>
                    failRemoteBackground(error ?? "Remote session closed"),
                  onGap: () => failRemoteBackground("Remote session event stream has a gap"),
                }
              )
              close = watcher.close
              if (cancelled) await close()
            })
            .catch((error) => {
              if (!cancelled) useChatStore.getState().setSessionError(id, String(error))
            })
          unsubscribe = () => {
            cancelled = true
            void close?.()
          }
        } else unsubscribe = manager.addEventListener(link.agentId, accept)
        subscriptions.set(id, {
          key: JSON.stringify(link),
          unsubscribe: () => {
            unsubscribe()
            void consume
              .dispose()
              .catch((error) => console.warn("External background cleanup failed", error))
          },
        })
      }
    }
    sync()
  })
  return () => {
    disposed = true
    unsubscribeRuntime()
    for (const subscription of subscriptions.values()) subscription.unsubscribe()
  }
}
