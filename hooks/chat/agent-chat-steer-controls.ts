"use client"

import type React from "react"
import { drainSteerVia } from "./agent-chat-events"
import { type SendFn } from "./agent-chat-turn-tasks"
import { fusionChatTurnActive, stopFusionChatTurn } from "./router-fusion-chat-turn"
import { steerArmed } from "@/lib/chat/steer-runtime"
import { enqueueHostStateIntentIfAvailable } from "@/lib/db/mobile-outbound-queue"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { cancelRouterFusionTurn } from "@/lib/router-fusion/gate/chat-events"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"

/** What the steer controls read from the chat controller (`useAgentChat`). */
export interface AgentChatSteerControlContext {
  store: typeof useChatStore
  refuseCapturedTurn: (sessionId: string) => boolean
  sendRef: React.RefObject<SendFn | null>
  externalGatewayAbortRef: React.RefObject<Map<string, AbortController>>
  hostStateTurnsRef: React.RefObject<Set<string>>
  abortRunningTurn: (sessionId: string, hostStateAbortQueued: boolean) => Promise<void>
}

/**
 * "Interrupt & steer now": cuts the running turn short through the same
 * dispatch Stop uses, so its settle replays the queued steer at once. Arming
 * covers an abort that surfaces as an errored `session_ended`. No-op with an
 * empty queue.
 */
export async function interruptChatTurnAndSteer(
  ctx: Pick<
    AgentChatSteerControlContext,
    | "store"
    | "refuseCapturedTurn"
    | "externalGatewayAbortRef"
    | "hostStateTurnsRef"
    | "abortRunningTurn"
  >,
  targetSessionId?: string
) {
  const {
    store,
    refuseCapturedTurn,
    externalGatewayAbortRef,
    hostStateTurnsRef,
    abortRunningTurn,
  } = ctx

  const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
  if (!sessionId) return
  if (refuseCapturedTurn(sessionId)) return
  const queued = useChatStore.getState().sessions[sessionId]?.steerQueue ?? []
  if (queued.length === 0) return
  steerArmed.add(sessionId)
  try {
    if (!externalGatewayAbortRef.current.has(sessionId) && fusionChatTurnActive(sessionId)) {
      // A verified run has no live input: stop it, and its settle replays
      // the queue.
      await stopFusionChatTurn(sessionId, useSettingsStore.getState().settings, {
        settled: false,
      })
      return
    }
    // The same dispatch Stop uses, so a BYOK, external-agent or
    // paired-host turn is really cut short. A sidecar-only interrupt
    // reached none of those: the turn ran on, and the "now" message
    // waited for it to finish.
    const hostStateAbortQueued = Boolean(
      await enqueueHostStateIntentIfAvailable({
        sessionId,
        action: { kind: "turn.abort" },
      })
    )
    if (hostStateAbortQueued) hostStateTurnsRef.current.add(sessionId)
    await abortRunningTurn(sessionId, hostStateAbortQueued)
    await cancelRouterFusionTurn(sessionId)
  } catch (err) {
    console.error("interrupt(steer) failed", err)
    steerArmed.delete(sessionId)
    store
      .getState()
      .setSessionDiagnostic(sessionId, toDiagnostic(err, { source: "chat", meta: { sessionId } }))
  }
}

/**
 * Replays a session's queued steer now, without a turn boundary — after an
 * errored settle, where the queue is kept but no settle event is coming.
 */
export function flushChatSteer(
  ctx: Pick<AgentChatSteerControlContext, "refuseCapturedTurn" | "sendRef">,
  targetSessionId?: string
) {
  const { refuseCapturedTurn, sendRef } = ctx

  const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
  if (!sessionId) return
  if (refuseCapturedTurn(sessionId)) return
  drainSteerVia(sessionId, sendRef)
}
