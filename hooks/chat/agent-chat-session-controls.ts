"use client"

import type React from "react"
import { desktopTurnLeases } from "./agent-chat-turn-leases"
import { stopFusionChatTurn } from "./router-fusion-chat-turn"
import { type AgentExecutionHandle } from "@/lib/ai/agent/execution/agent-execution-handle"
import {
  closeSession,
  compactSession,
  interruptSession,
  setSessionModel,
} from "@/lib/ai/agent/execution/sidecar-client"
import { restoreWithdrawnToComposer } from "@/lib/chat/restore-withdrawn"
import { putBackPendingSteers, sessionExternalLane, steerArmed } from "@/lib/chat/steer-runtime"

import { markTaskWorkspaceTurnCancelled } from "@/lib/code-adoption/turn-tracker"
import {
  enqueueHostStateIntentIfAvailable,
  type WithdrawnHostStateMessage,
  withdrawUnsentHostStateMessages,
} from "@/lib/db/mobile-outbound-queue"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { finishDirectChatExecutionRun } from "@/lib/execution/direct-chat-run"
import { beginSessionStop, sessionTurnLockKey } from "@/lib/execution/session-turn-lock"
import { refreshGitStatus } from "@/lib/git/load"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import { clearSessionGrants } from "@/lib/plugin/security/computer-use-session-grants"
import { cancelRouterFusionTurn } from "@/lib/router-fusion/gate/chat-events"
import { releaseSkillLoadContext } from "@/lib/skills/runtime-loader"
import { settleChatTurnForSession } from "@/lib/work-submission/chat-adapter"
import { externalSessionLinkForSession } from "@/stores/agent/agent-runtime-store"
import { useChatStore } from "@/stores/chat"
import { useGitStore } from "@/stores/git/git-store"
import { useSettingsStore } from "@/stores/settings"
import { createDiagnostic } from "@cognia/diagnostics"
import { type UIMessage } from "ai"
import { type useTranslations } from "next-intl"
import { toast } from "sonner"

/** What the session controls (stop, close, compact, model, reset, rewind) read from the chat controller (`useAgentChat`). */
export interface AgentChatSessionControlContext {
  store: typeof useChatStore
  tSteer: ReturnType<typeof useTranslations<"chat.steer">>
  messagesMirrorRef: React.RefObject<Map<string, UIMessage[]>>
  standaloneAbortRef: React.RefObject<Map<string, AbortController>>
  externalGatewayAbortRef: React.RefObject<Map<string, AbortController>>
  checkoutAbortRef: React.RefObject<Map<string, AbortController>>
  hostStateTurnsRef: React.RefObject<Set<string>>
  releaseExternalToolHost: (sessionId: string) => Promise<void>
  executionHandlesRef: React.RefObject<Map<string, AgentExecutionHandle>>
  executionHandleDirectory: import("@/components/providers/agent-execution-handle-provider").AgentExecutionHandleDirectory
  getExecutionHandle: (
    sessionId: string
  ) => import("@/lib/ai/agent/execution/agent-execution-handle").AgentExecutionHandle | undefined
  registry: import("@/lib/chat/stream-coalescing").SessionCoalescingRegistry
  abortRunningTurn: (sessionId: string, hostStateAbortQueued: boolean) => Promise<void>
}

/** Aborts whatever runs a session's turn — the sidecar, an external agent's handle, a standalone or gateway request, a working-copy checkout — and drops its stream state. */
export async function abortRunningChatTurn(
  ctx: Pick<
    AgentChatSessionControlContext,
    "standaloneAbortRef" | "externalGatewayAbortRef" | "getExecutionHandle"
  >,
  sessionId: string,
  hostStateAbortQueued: boolean
): Promise<void> {
  const { standaloneAbortRef, externalGatewayAbortRef, getExecutionHandle } = ctx

  // Standalone (BYOK) turns are cancelled by aborting the renderer
  // streamText loop; the engine then emits its own `session_ended`. The
  // sidecar path interrupts the host instead. The follow-up
  // `session_ended` remains idempotent with the optimistic local seal.
  const standaloneController = standaloneAbortRef.current.get(sessionId)
  const gatewayController = externalGatewayAbortRef.current.get(sessionId)
  if (hostStateAbortQueued) {
    // Durable HostState action owns the interrupt; the runner retries it
    // with the same action id after reconnect.
  } else if (gatewayController) {
    gatewayController.abort()
  } else if (
    sessionExternalLane(sessionId) &&
    externalSessionLinkForSession(sessionId)?.agentId === sessionExternalLane(sessionId)
  ) {
    const link = externalSessionLinkForSession(sessionId)!
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    if (link.host) {
      const { createRemoteSessionOperationsClient } =
        await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
      await createRemoteSessionOperationsClient({
        stamp: link.host,
        chatSessionId: sessionId,
        externalSessionId: link.sessionId,
      }).cancel(link.agentId, link.sessionId)
    } else await getExternalAgentManager().cancel(link.agentId, link.sessionId)
  } else if (standaloneController) {
    standaloneController.abort()
    standaloneAbortRef.current.delete(sessionId)
  } else {
    const handle = getExecutionHandle(sessionId)
    if (handle) await handle.interrupt()
    else await interruptSession(sessionId)
  }
}

/**
 * Stop for a chat turn (`useAgentChat().stop`): holds the session's turn lease
 * until the interrupt settles, so no queued follow-up starts on a turn that is
 * still winding down, then aborts it and settles the session.
 */
export async function stopChatTurn(
  ctx: Pick<
    AgentChatSessionControlContext,
    | "store"
    | "tSteer"
    | "messagesMirrorRef"
    | "checkoutAbortRef"
    | "hostStateTurnsRef"
    | "registry"
    | "abortRunningTurn"
  >,
  targetSessionId?: string
) {
  const {
    store,
    tSteer,
    messagesMirrorRef,
    checkoutAbortRef,
    hostStateTurnsRef,
    registry,
    abortRunningTurn,
  } = ctx

  // Each pane wires its own Stop to its own session id; default to focused.
  const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
  if (!sessionId) return
  const stopKey = sessionTurnLockKey(sessionId)
  const lease = desktopTurnLeases.get(stopKey)
  if (lease?.stopping && !lease.stopping.interruptSettled) return
  // Fence every producer's admission before the first await, lease or not
  // (a turn that went idle while its goal judge runs has released it),
  // until the interrupt settles.
  const releaseStopFence = beginSessionStop(sessionId)
  let interruptSettled = releaseStopFence
  // Undo the fence when Stop fails before its interrupt is ever sent.
  let cancelStopping = releaseStopFence
  let stopDeadline: Promise<void> | undefined
  if (lease) {
    let timer: ReturnType<typeof setTimeout> | undefined
    // The race is a stale interrupt reaching the next turn. Once the
    // interrupt command itself has settled (sent and handled, or failed),
    // it can no longer hit another turn, so the lease may go. Waiting for
    // an engine-terminal event as well could hold the session forever.
    const stopping = { interruptSettled: false }
    // UI idle is optimistic. Fence admission before the first await and
    // retain it until the interrupt command has settled.
    lease.stopping = stopping
    stopDeadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        store.getState().setSessionDiagnostic(
          sessionId,
          createDiagnostic("timeout", {
            source: "chat",
            detail: "executor_stop_unconfirmed",
            meta: { sessionId, extra: { executorStopUnconfirmed: true } },
          })
        )
        resolve()
      }, 5_000)
    })
    interruptSettled = () => {
      stopping.interruptSettled = true
      if (timer) clearTimeout(timer)
      releaseStopFence()
      lease.settle()
    }
    cancelStopping = () => {
      if (timer) clearTimeout(timer)
      if (lease.stopping === stopping) lease.stopping = undefined
      releaseStopFence()
      lease.settle()
    }
  }
  // A synchronous failure before the interrupt is dispatched must not leave
  // the fence up, or the session would refuse every later turn.
  let abortDispatched = false
  try {
    let hostStateAbortQueued = false
    let withdrawn: WithdrawnHostStateMessage[] = []
    try {
      // Stop is delivered ahead of sends the outbox has not offered yet (it
      // names the turn it was pressed against), and each of those would
      // otherwise start a new turn right after it. They go back to the
      // composer with the queued follow-ups below.
      withdrawn = await withdrawUnsentHostStateMessages(sessionId)
      hostStateAbortQueued = Boolean(
        await enqueueHostStateIntentIfAvailable({
          sessionId,
          action: { kind: "turn.abort" },
        })
      )
    } catch (error) {
      store
        .getState()
        .setSessionDiagnostic(
          sessionId,
          toDiagnostic(error, { source: "chat", meta: { sessionId } })
        )
      cancelStopping()
      return
    }
    // Plain stop does not replay the queued follow-ups — the user is taking
    // over, not steering — so the drain is disarmed. But they are the user's
    // own words, typed for this conversation: they go back into the composer
    // with everything they carried (files, citations, reply, context), never
    // silently dropped with the run. Esc is the same Stop.
    const queuedSteers = useChatStore.getState().sessions[sessionId]?.steerQueue ?? []
    useChatStore.getState().clearSteerQueue(sessionId)
    steerArmed.delete(sessionId)
    hostStateTurnsRef.current.delete(sessionId)
    if (queuedSteers.length > 0) {
      void putBackPendingSteers(
        sessionId,
        queuedSteers.map((entry) => entry.id),
        queuedSteers
      )
        .then((count) => {
          if (count > 0) toast.info(tSteer("restoredOnStop", { count }))
        })
        .catch((error) => console.error("steer put-back on stop failed", error))
    }
    // Sends still sitting unoffered in the outbox are the same: Stop overtook
    // them, so their bubbles come down and their text goes back to the
    // composer (their files' bytes are on the Host; the composer names them).
    if (withdrawn.length > 0) {
      const ids = new Set(withdrawn.map((message) => message.messageId))
      const current = store.getState().sessions[sessionId]?.messages ?? []
      store.getState().replaceSessionMessages(
        sessionId,
        current.filter((message) => !ids.has(message.id))
      )
      void restoreWithdrawnToComposer(sessionId, withdrawn)
        .then(() => toast.info(tSteer("restoredOnStop", { count: withdrawn.length })))
        .catch((error) => console.error("unsent message put-back on stop failed", error))
    }

    // Seal the renderer state before waiting for the IPC acknowledgement.
    // `agent_interrupt` is best-effort transport control; if its promise is
    // delayed by a busy sidecar, the GUI must still leave the streaming
    // state immediately and preserve the latest partial response.
    const coalesce = registry.get(sessionId)
    coalesce?.commit.flush()
    coalesce?.persist.flush()
    registry.release(sessionId)
    messagesMirrorRef.current.delete(sessionId)
    const chat = store.getState()
    for (const approval of chat.sessions[sessionId]?.pendingApprovals ?? []) {
      if (approval.status !== "interrupted") {
        chat.markApprovalInterrupted(approval.requestId, approval.sessionId, "aborted")
      }
    }
    // Only once Stop is committed: an earlier failure returns with the
    // turn still running, and a cancelled checkout would strand it.
    checkoutAbortRef.current.get(sessionId)?.abort()
    checkoutAbortRef.current.delete(sessionId)
    const endingRunId = chat.sessions[sessionId]?.runId
    if (typeof endingRunId === "number") {
      markTaskWorkspaceTurnCancelled(sessionId, endingRunId)
    }
    chat.setSessionStatus(sessionId, "idle", { turnOutcome: "interrupted" })
    chatTurnPerformance.finish(sessionId, "cancelled")
    const finishRun = Promise.all([
      finishDirectChatExecutionRun(sessionId, "cancelled"),
      settleChatTurnForSession(sessionId, { outcome: "cancelled" }),
      // A ledgered turn stops granting model calls at once (ADR-0188); the
      // turn's `session_ended` seals the run. A no-op for any other turn.
      cancelRouterFusionTurn(sessionId),
      // A cascade or panel run is cancelled and its calls aborted (B3).
      stopFusionChatTurn(sessionId, useSettingsStore.getState().settings, {
        settled: true,
      }).catch((error) => console.warn("router-fusion chat run stop failed", error)),
    ])

    try {
      abortDispatched = true
      const abort = Promise.resolve()
        .then(() => abortRunningTurn(sessionId, hostStateAbortQueued))
        .finally(interruptSettled)
      await (stopDeadline ? Promise.race([abort, stopDeadline]) : abort)
    } catch (err) {
      console.error("interrupt failed", err)
      store.getState().setSessionDiagnostic(
        sessionId,
        toDiagnostic(err, {
          source: "chat",
          meta: { sessionId, extra: { executorStopUnconfirmed: true } },
        })
      )
    }
    await finishRun
  } finally {
    if (!abortDispatched) cancelStopping()
  }
}

/** Ends a session's live runtime (sidecar session, external tool host, execution handle) when its conversation closes. */
export async function closeChatSession(
  ctx: Pick<
    AgentChatSessionControlContext,
    | "messagesMirrorRef"
    | "standaloneAbortRef"
    | "externalGatewayAbortRef"
    | "releaseExternalToolHost"
    | "executionHandlesRef"
    | "executionHandleDirectory"
    | "getExecutionHandle"
    | "registry"
  >,
  sessionId: string
) {
  const {
    messagesMirrorRef,
    standaloneAbortRef,
    externalGatewayAbortRef,
    releaseExternalToolHost,
    executionHandlesRef,
    executionHandleDirectory,
    getExecutionHandle,
    registry,
  } = ctx

  const handle = getExecutionHandle(sessionId)
  try {
    const localController = standaloneAbortRef.current.get(sessionId)
    const gatewayController = externalGatewayAbortRef.current.get(sessionId)
    if (localController) {
      localController.abort()
      standaloneAbortRef.current.delete(sessionId)
    } else if (gatewayController) gatewayController.abort()
    else if (handle) await handle.cancel()
    else await closeSession(sessionId)
  } catch (err) {
    console.error("close session failed", err)
  } finally {
    // Tear down this session's pane state: cancel its coalescing, drop its
    // streaming mirror, and remove its store slice / tab.
    chatTurnPerformance.finish(sessionId, "cancelled")
    registry.release(sessionId)
    messagesMirrorRef.current.delete(sessionId)
    executionHandlesRef.current.delete(sessionId)
    executionHandleDirectory.unregister(sessionId, handle)
    await releaseExternalToolHost(sessionId).catch((error) => {
      console.error("external tool host close failed", error)
    })
    useChatStore.getState().closeSession(sessionId)
    clearSessionGrants(sessionId)
    const { clearSessionBypass } = await import("@/lib/ai/agent/execution/hitl/approval-registry")
    clearSessionBypass(sessionId)
    releaseSkillLoadContext(sessionId)
    // Drop this session's nested-dispatch state (budget guard + resolved
    // permission ceiling) so neither leaks for the renderer's lifetime. Both
    // are keyed by session id and kept alive across a turn's multiple
    // dispatch_agent calls, so teardown is the only safe release point.
    const { releaseDispatchStateForSession } =
      await import("@/lib/ai/agent/execution/delegation/dispatch-agent-handler")
    releaseDispatchStateForSession(sessionId)
  }
}

/** Asks the session's runtime to compact its context now. */
export async function compactChatSession(
  ctx: Pick<AgentChatSessionControlContext, "getExecutionHandle">,
  sessionId: string
) {
  const { getExecutionHandle } = ctx

  const handle = getExecutionHandle(sessionId)
  if (handle) await handle.compact()
  else await compactSession(sessionId)
}

/** Switches the model of a session's live runtime. */
export async function setChatSessionModel(
  ctx: Pick<AgentChatSessionControlContext, "getExecutionHandle">,
  sessionId: string,
  model: string
) {
  const { getExecutionHandle } = ctx

  const handle = getExecutionHandle(sessionId)
  if (handle) await handle.setModel(model)
  else await setSessionModel(sessionId, model)
}

/** Drops a session's runtime so its next turn starts a fresh one. */
export async function resetChatRuntime(
  ctx: Pick<
    AgentChatSessionControlContext,
    "executionHandlesRef" | "executionHandleDirectory" | "getExecutionHandle"
  >,
  sessionId: string
) {
  const { executionHandlesRef, executionHandleDirectory, getExecutionHandle } = ctx

  const handle = getExecutionHandle(sessionId)
  try {
    if (handle) await handle.cancel()
    else await closeSession(sessionId)
  } finally {
    executionHandlesRef.current.delete(sessionId)
    executionHandleDirectory.unregister(sessionId, handle)
  }
}

/** Rewinds the files a session's turns changed to a checkpoint, or reports what would change on a dry run. */
export async function rewindChatFiles(
  ctx: Pick<AgentChatSessionControlContext, "getExecutionHandle">,
  sessionId: string,
  checkpointId: string,
  dryRun: boolean
) {
  const { getExecutionHandle } = ctx

  const handle = getExecutionHandle(sessionId)
  if (!handle) throw new Error("checkpoint execution handle is unavailable")
  const result = await handle.rewindFiles(checkpointId, { dryRun })
  if (!dryRun) {
    await refreshGitStatus(useGitStore.getState().rootDir).catch(() => undefined)
  }
  return result
}
