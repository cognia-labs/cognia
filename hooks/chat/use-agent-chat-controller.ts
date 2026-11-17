"use client"

import { preparePersonalDerivedHistory } from "@/lib/execution/personal-visibility"

import {
  acquireSessionTurnLease,
  sessionStopFenced,
  sessionStopPending,
  sessionTurnLockKey,
} from "@/lib/execution/session-turn-lock"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

import { guardBuiltinSessionHostSend } from "@/lib/chat/session-host-binding"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  hasCaptureResponder,
  isSessionCaptured,
  captureOwnedSessionIds,
  subscribeCaptureOccupancy,
} from "@/lib/ai/agent/execution/hitl/approval-registry"
import { useTranslations } from "next-intl"

import type { UnlistenFn } from "@tauri-apps/api/event"

import { toast } from "sonner"

import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"

import {
  carryPromptPreamble,
  chipCitationsOf,
  readPromptPreambleSummary,
  stripPromptPreamble,
} from "@/lib/chat/prompt-preamble"
import { createDiagnostic } from "@cognia/diagnostics"

import { createSilenceWatchdog, type SilenceWatchdog } from "@/lib/chat/silence-watchdog"

import { isGatewaySessionLink } from "@/lib/ai/agent/external/session/session-models"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"

import { getLoopRuntime } from "@/lib/loop/runtime"
import { renderLoopIterationMessage } from "@/lib/loop/prompts"

import {
  installChatSessionSteerLane,
  isSessionOpen,
  liveSessionIds,
  markPendingSteersFailed,
  sessionStatusOf,
  steerArmed,
} from "@/lib/chat/steer-runtime"

import {
  drainSessionPeerMessages,
  registerSessionPeerRuntime,
} from "@/lib/chat/session-peer-messaging"
import {
  buildSessionPeerInboundMessage,
  renderSessionPeerModelPrompt,
} from "@/lib/chat/session-peer-delivery"
import { expireSessionPeerMessages } from "@/lib/db/session-peer-messages"

import {
  maybeDrainBackgroundResults,
  registerBackgroundReplaySend,
} from "./background-result-runtime"
import { registerChatRetryBridge, registerChatSendBridge } from "./chat-send-bridge"

import { registerChatApprovalBridge, registerChatStopBridge } from "./chat-control-bridge"
import { tagEditSibling } from "@/lib/chat/branch-regen"
import { closeSession, onClaudeMessage } from "@/lib/ai/agent/execution/sidecar-client"

import { listMessages, persistMessages, persistStreamingMessages } from "@/lib/db/messages"

import { SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import { mergeInboundMessagesForStream } from "@/lib/db/inbound-stored-parts"
import { getSession } from "@/lib/db/sessions"

import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"

import { runIdForTurn } from "@/lib/task-workspace/client"

import { finishUnstartedDirectChatExecutionRun } from "@/lib/execution/direct-chat-run"
import {
  sharedRequestTranscript,
  canAutomaticallyDrainSharedQueue,
} from "@/lib/collab/shared-run-coordinator"
import { installSharedSessionSteerLane } from "@/lib/collab/shared-run-steer"
import { isRoomAsleepRefusal } from "@/lib/collab/shared-room-settings"

import { type AgentExecutionHandle } from "@/lib/ai/agent/execution/agent-execution-handle"
import { useAgentExecutionHandleDirectory } from "@/components/providers/agent-execution-handle-provider"

import { snapshotRouteContext } from "@/lib/chat/turn-route/snapshot"
import { resolveRouteLane } from "@/lib/chat/turn-route/resolve"
import { parseLeadingRoute } from "@/lib/chat/turn-route/parse"

import { isRoutableSession, readTurnRoute, type TurnRoute } from "@/lib/chat/turn-route/types"

import { type AsideContextDelivery } from "@/lib/chat/session-aside-context"
import { createAsideContextDispatch } from "@/lib/context-workbench/aside-context-dispatch"

import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"

import type {
  ApprovalDecision,
  ApprovalResponseOptions,
  ClaudeEvent,
  PendingApproval,
  SendContent,
  SendOptions,
} from "@cognia/agent-config-types"
import { useChatStore } from "@/stores/chat"

import { pickChatContinuationMetadata } from "@/lib/chat/continuation"

import { isChatTurnQueued } from "@/lib/execution/chat-lease"

import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  selectSessionSubagents,
  applySubagentsToMessages,
  subagentSignature,
} from "@/lib/chat/subagent-bridge"
import { useSettingsStore } from "@/stores/settings"

import { externalSessionLinkForSession } from "@/stores/agent/agent-runtime-store"

import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"

import type { UIMessage } from "ai"
import { registerInteractiveWorkSubmissionEvents } from "@/lib/work-submission/terminal-events"

import type { SendFn } from "./agent-chat-turn-tasks"

import {
  createTranscriptRuntimeFence,
  type TranscriptRuntimeFence,
} from "@/lib/chat/transcript/revision-events"

import type { TurnImagesWithheld } from "@/lib/ai/agent/external/session/turn-images"

import { drainSteerVia, handleEvent } from "./agent-chat-events"

import {
  createExternalIdleEventConsumer,
  type ExternalTurnOmissions,
  userPromptText,
  type AgentChatSendCallOptions,
} from "./agent-chat-turn-helpers"

import { respondToChatApproval } from "./agent-chat-approvals"
import { desktopTurnLeases, type DesktopTurnLease } from "./agent-chat-turn-leases"
import {
  abortRunningChatTurn,
  stopChatTurn,
  closeChatSession,
  compactChatSession,
  setChatSessionModel,
  resetChatRuntime,
  rewindChatFiles,
} from "./agent-chat-session-controls"
import { interruptChatTurnAndSteer, flushChatSteer } from "./agent-chat-steer-controls"
import { runChatSend } from "./agent-chat-send"

/** The send pipeline reads the live settings through this, not the store. */
const readAppSettings = () => useSettingsStore.getState().settings

export function useAgentChat() {
  const store = useChatStore
  const tRouting = useTranslations("providers.routingView")
  const tInlineErr = useTranslations("chat.inlineError")
  const tAside = useTranslations("contextWorkbench.asides")
  const tDiagnostics = useTranslations("diagnostics")
  const tPiPackages = useTranslations("plugins.piPackages")
  const tVideo = useTranslations("chat.composer.attachments.video")
  const tAttachments = useTranslations("chat.composer.attachments")
  const tCollab = useTranslations("chatCollaboration")
  // Read by the shared-request listener, which installs once.
  const tCollabRef = useRef(tCollab)
  useEffect(() => {
    tCollabRef.current = tCollab
  }, [tCollab])
  const tSteer = useTranslations("chat.steer")
  const tCaptureBusy = useTranslations("chat.restorePoint")
  const tWorkspaceLayout = useTranslations("chat.workspaceLayout")
  const refuseCapturedTurn = useCallback(
    (sessionId: string) => {
      if (!isSessionCaptured(sessionId)) return false
      toast.warning(tCaptureBusy("busy"))
      return true
    },
    [tCaptureBusy]
  )
  useEffect(() => {
    const occupied = new Set<string>()
    const update = (sessionId: string, active: boolean) => {
      if (active) {
        occupied.add(sessionId)
        store.getState().setSessionStatus(sessionId, "streaming")
      } else if (occupied.delete(sessionId)) {
        store.getState().setSessionStatus(sessionId, "idle")
      }
    }
    for (const sessionId of captureOwnedSessionIds()) update(sessionId, true)
    return subscribeCaptureOccupancy(update)
  }, [store])
  /**
   * Name what a turn's recipient was not handed, and why, so nothing attached
   * goes missing in silence. A Squad's goal is one string, so it gets the
   * text alone. An external agent gets text and the images it can see; each
   * group it did not get says what to do about it (extract the text, switch to
   * a vision model, update the Host). Text extracted from an attachment is
   * always sent, and every message says so.
   */
  const warnUndeliveredAttachments = useCallback(
    (
      recipient: "external" | "squad",
      report: {
        omitted: ExternalTurnOmissions
        withheld: readonly TurnImagesWithheld[]
        agent?: string | null
      },
      manifest: readonly AttachmentManifestEntry[] | undefined
    ) => {
      const named = (attachments: ReadonlyArray<number | null>) => {
        const names = [
          ...new Set(
            attachments.map(
              (index) =>
                (index !== null ? manifest?.[index]?.filename : undefined) ||
                tAttachments("fallbackName")
            )
          ),
        ]
        return { count: names.length, names: names.join(", ") }
      }
      const others: Array<number | null> = [
        ...report.omitted.attachments,
        ...(report.omitted.unnamed > 0 ? [null] : []),
      ]
      const lines: string[] = []
      if (recipient === "squad") {
        const all = [...others, ...report.withheld.flatMap((group) => group.attachments)]
        if (all.length > 0) lines.push(tAttachments("squadOmitted.files", named(all)))
      } else {
        if (others.length > 0) lines.push(tAttachments("externalOmitted.files", named(others)))
        const agent = report.agent || tAttachments("visualNotice.agentFallback")
        for (const group of report.withheld) {
          if (group.attachments.length === 0) continue
          lines.push(
            tAttachments(`imagesWithheld.${group.reason}`, {
              ...named(group.attachments),
              agent,
              model: group.model ?? agent,
            })
          )
        }
      }
      if (lines.length > 0) toast.warning(lines.join(" "))
    },
    [tAttachments]
  )
  // The active session id is captured per-render via a ref so the long-lived
  // event handler always sees the freshest value without resubscribing.
  const activeRef = useRef<string | null>(null)
  /**
   * Per-session authoritative "latest messages" while a coalesced commit /
   * debounced persist is in flight. The streaming hot path reads `current`
   * from here (falling back to the store) so deferring the React commit can't
   * feed a stale base into the next event's `applySdkEvent`. Written
   * synchronously every event; cleared at every turn boundary (turnComplete,
   * session_ended, a new send/edit/regenerate) and on a session switch below.
   */
  const messagesMirrorRef = useRef<Map<string, UIMessage[]>>(new Map())
  useEffect(() => {
    const unsub = useChatStore.subscribe((s) => {
      // Concurrent sessions: the mirror is keyed per session and survives focus
      // changes — a background session that is mid-stream keeps its
      // authoritative base so switching away/back never drops its tokens. Each
      // session's entry is cleared at its own turn boundary (turnComplete /
      // session_ended) and on a new send/edit/regenerate, not on focus switch.
      activeRef.current = s.activeSessionId
    })
    activeRef.current = useChatStore.getState().activeSessionId
    return unsub
  }, [])

  // Surface dispatched sub-agent runs inline in the chat. `recordDispatch*`
  // (the dispatch runtime store) is the producer; this is the consumer the
  // subagent-bridge docstring promised. It folds each run's tree onto the
  // spawning assistant turn, deduped by a cheap signature so progress ticks
  // don't rewrite the message array needlessly.
  //
  // Every OPEN session, not just the focused one. This used to read
  // `activeSessionId`, so a background pane that dispatched subagents never got
  // their tree folded in — and because the signature is only recomputed on a
  // runtime change, switching to that pane later did not fix it either: its
  // transcript was permanently missing the subagent trees for that turn.
  const subagentSigRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const apply = () => {
      const runtime = useSubagentRuntimeStore.getState().subAgents
      const chat = useChatStore.getState()
      const ids = liveSessionIds(chat)
      if (chat.activeSessionId) ids.add(chat.activeSessionId)
      for (const sid of ids) {
        const subs = selectSessionSubagents(runtime, sid)
        const sig = subagentSignature(subs)
        if (sig === subagentSigRef.current.get(sid)) continue
        subagentSigRef.current.set(sid, sig)
        if (subs.length === 0) continue
        // Re-read per session: an earlier iteration may already have written.
        const state = useChatStore.getState()
        const current =
          sid === state.activeSessionId ? state.messages : (state.sessions[sid]?.messages ?? [])
        const next = applySubagentsToMessages(current, subs)
        if (next !== current) state.replaceMessagesForSession(sid, next)
      }
    }
    apply()
    const unsubscribeRuntime = useSubagentRuntimeStore.subscribe(apply)
    const unsubscribePanes = useChatStore.subscribe((state, previous?: typeof state) => {
      if (
        previous &&
        state.paneIdsBySession === previous.paneIdsBySession &&
        state.backgroundHolds === previous.backgroundHolds &&
        state.openSessionIds === previous.openSessionIds &&
        state.activeSessionId === previous.activeSessionId
      )
        return
      // A newly revealed pane may have hydrated its messages after the last
      // subagent update. Re-project even when the runtime signature is unchanged.
      subagentSigRef.current.clear()
      apply()
    })
    return () => {
      unsubscribeRuntime()
      unsubscribePanes()
    }
  }, [])

  // Always-allow tool list — also kept fresh via ref.
  const allowListRef = useRef<string[]>([])
  useEffect(() => {
    const unsub = useSettingsStore.subscribe((s) => {
      allowListRef.current = s.settings?.alwaysAllowTools ?? []
    })
    allowListRef.current = useSettingsStore.getState().settings?.alwaysAllowTools ?? []
    return unsub
  }, [])

  // Track the last user content per session so a regenerate resends exactly
  // what was sent: a natively sent video's file is not in the row. The
  // manifest travels with it (an attachment's text reads as the question
  // without it), and the row id says which turn it was, so a regenerate of
  // any other turn rebuilds from that turn's own row instead.
  const lastUserContentRef = useRef<
    Map<
      string,
      {
        messageId: string
        content: SendContent
        manifest: readonly AttachmentManifestEntry[] | undefined
      }
    >
  >(new Map())
  // Private resource context is kept outside the message log. It is reused for
  // regenerate/edit-resend, but is only attached after plugin prompt hooks.
  const lastResourceContextRef = useRef<Map<string, AsideContextDelivery & { messageId: string }>>(
    new Map()
  )
  const asideContextDispatchRef = useRef(
    new Map<string, ReturnType<typeof createAsideContextDispatch>>()
  )
  /** Retry/regenerate keeps turnId stable and advances only attemptId. */
  const skillAttemptByTurnRef = useRef<Map<string, number>>(new Map())
  /**
   * Pending branch tag set by `regenerate` and consumed by the first
   * assistant message that arrives afterward. Keyed by sessionId so a regen
   * fired from another session doesn't taint the active turn.
   */
  const pendingBranchTagRef = useRef<Map<string, { groupId: string; index: number }>>(new Map())
  /**
   * The replacement user message an edit-as-branch send just appended, keyed by
   * sessionId. `handleEvent` stamps it as `branchOwnerId` on every message the
   * turn writes, so flipping the navigator back to the original hides the new
   * turn's replies along with the variant they answer. Consumed at turn end.
   */
  const pendingBranchOwnerRef = useRef<Map<string, string>>(new Map())

  /**
   * Holds the latest `send` so the module-scope `handleEvent` can dispatch a
   * silent goal continuation (ADR-0019). `handleEvent` is defined outside the
   * hook (can't close over `send`), so we thread the live reference through a
   * ref kept fresh by the effect below.
   */
  const sendRef = useRef<SendFn | null>(null)
  const ownedContinuationRef = useRef<SendFn | null>(null)
  // Joins one exact lease (the turn that emitted a frame) or re-enters admission.
  const continueFromLeaseRef = useRef<
    ((lease: DesktopTurnLease | undefined, args: Parameters<SendFn>) => ReturnType<SendFn>) | null
  >(null)
  const sharedApprovalResponseRef = useRef<
    ((approval: PendingApproval, decision: ApprovalDecision) => Promise<void>) | null
  >(null)

  /**
   * Live Squad-run settlement watchers, one per session.
   *
   * A Squad turn holds its session `streaming` until its run ends, so the
   * watcher that releases the hold has to outlive the `send` call that armed
   * it. Keyed by session so a second Squad turn replaces the first's watcher
   * rather than leaving a stale one to settle a hold it no longer represents.
   */
  const squadWatchersRef = useRef<Map<string, () => void>>(new Map())

  /**
   * Per-session serialization queue for `handleEvent`. Sidecar events arrive
   * fire-and-forget, but `handleEvent` does an async read → apply → persist →
   * store-update that spans multiple `await`s. Without serialization, two
   * events for the same session interleave: both read the same stale base, and
   * the loser's `persistMessages` can `bulkDelete` rows the winner just wrote
   * (durable message loss) or overwrite the store with a base missing a delta.
   * Chaining each event onto the tail of its session's promise guarantees the
   * read-modify-write for one session runs to completion before the next
   * starts. Different sessions keep their own chains so a busy background
   * session never blocks the foreground one.
   */
  const eventQueuesRef = useRef<Map<string, Promise<void>>>(new Map())

  // Per-session AbortControllers for in-flight standalone (BYOK) turns, so Stop
  // can cancel the renderer streamText loop (the sidecar path uses
  // `interruptSession` instead).
  const standaloneAbortRef = useRef<Map<string, AbortController>>(new Map())
  const externalGatewayAbortRef = useRef<Map<string, AbortController>>(new Map())
  // Per-session abort for the turn's working-copy checkout (ADR-0176 A1). Stop
  // aborts it, which cancels the checkout on the host: the git it waits on is
  // killed and the worktree rolled back, instead of Stop waiting it out.
  const checkoutAbortRef = useRef<Map<string, AbortController>>(new Map())
  // Sessions whose running turn belongs to a paired Host (HostState). That
  // turn's end never reaches `handleEvent` here — the Host's projection just
  // flips the session's status — so the steer queue such a turn leaves behind
  // is drained by watching that status (the effect below), with the same rule
  // a local settle applies.
  const hostStateTurnsRef = useRef<Set<string>>(new Set())
  const externalTurnSettlementsRef = useRef<Map<string, Promise<void>>>(new Map())
  const externalToolHostsRef = useRef(
    new Map<
      string,
      {
        host: ReturnType<
          typeof import("@/lib/ai/agent/external/session/renderer-tool-host").createRendererToolHost
        >
        agentId: string
        nativeSessionId?: string
        launchContextSignature?: string
      }
    >()
  )
  const releaseExternalToolHost = useCallback(async (sessionId: string) => {
    const entry = externalToolHostsRef.current.get(sessionId)
    const link = externalSessionLinkForSession(sessionId)
    useAgentRuntimeStore.getState().setSessionExternalLink(sessionId, undefined)
    if (!entry) return
    externalToolHostsRef.current.delete(sessionId)
    try {
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      if (getExternalAgentManager().getAgent(entry.agentId))
        getExternalAgentManager().setSessionHostFacts(entry.agentId, sessionId, null)
      const nativeIds = new Set([
        entry.nativeSessionId,
        link?.agentId === entry.agentId && !isGatewaySessionLink(link.sessionId)
          ? link.sessionId
          : undefined,
      ])
      for (const nativeId of nativeIds) {
        if (nativeId) await getExternalAgentManager().closeSession(entry.agentId, nativeId)
      }
    } finally {
      await entry.host.close()
    }
  }, [])
  // Session-owned handles live beside the existing coalescing resources. The
  // resolver callback supplies the exact spec used for the outgoing send, so
  // this hook never resolves execution a second time.
  const executionHandlesRef = useRef<Map<string, AgentExecutionHandle>>(new Map())
  const executionHandleDirectory = useAgentExecutionHandleDirectory()
  const getExecutionHandle = useCallback(
    (sessionId: string) =>
      executionHandlesRef.current.get(sessionId) ?? executionHandleDirectory.get(sessionId),
    [executionHandleDirectory]
  )

  /**
   * Per-session streaming coalescers. Each open session gets its own
   * rAF-throttled React commit (≤1/frame) + debounced Dexie write so multiple
   * sessions can stream concurrently without their pending snapshots clobbering
   * each other. The commit pushes into that session's slice via the
   * session-scoped store action (which re-projects onto the top-level fields
   * when the session is the focused one). 0ms persist in tests degrades to
   * synchronous so existing persist-ordering assertions hold.
   */
  const PERSIST_DEBOUNCE_MS = process.env.NODE_ENV === "test" ? 0 : 250
  // Stable across renders (lazy `useState` initializer — created once, never
  // accessed as a ref during render).
  const [registry] = useState(
    () =>
      new SessionCoalescingRegistry({
        onCommit: (sid, msgs) => {
          const chat = useChatStore.getState()
          const messages = mergeInboundMessagesForStream(msgs, chat.sessions[sid]?.messages ?? [])
          chat.replaceSessionMessages(sid, messages)
          // Stamp per-tool start/end times off the freshly-committed parts so the
          // Run Panel can show per-tool elapsed (no-op when nothing transitioned).
          useChatStore.getState().syncToolTimestamps?.(sid, messages)
        },
        onPersist: (sid, msgs, options) =>
          void persistStreamingMessages(sid, msgs, options).catch((err) =>
            console.error("debounced persistStreamingMessages failed", err)
          ),
        persistDelayMs: PERSIST_DEBOUNCE_MS,
      })
  )
  useEffect(() => {
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
          const accept = (event: import("@/types/agent/external-agent").ExternalAgentEvent) => {
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
  }, [registry])

  const handleTranscriptInvalidated = useCallback(
    (sessionId: string) => {
      externalGatewayAbortRef.current.get(sessionId)?.abort()
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)
    },
    [registry]
  )
  const transcriptFenceRef = useRef<TranscriptRuntimeFence | null>(null)
  useEffect(() => {
    const fence = createTranscriptRuntimeFence(handleTranscriptInvalidated)
    transcriptFenceRef.current = fence
    return () => {
      fence.dispose()
      if (transcriptFenceRef.current === fence) transcriptFenceRef.current = null
    }
  }, [handleTranscriptInvalidated])

  // Best-effort flush of every session's pending streaming write on unmount so
  // the last partial isn't lost when the hook tears down mid-turn.
  useEffect(() => {
    const executionHandles = executionHandlesRef.current
    const squadWatchers = squadWatchersRef.current
    const gatewayControllers = externalGatewayAbortRef.current
    const localControllers = standaloneAbortRef.current
    const toolHosts = externalToolHostsRef.current
    return () => {
      for (const sessionId of toolHosts.keys()) {
        void releaseExternalToolHost(sessionId).catch((error) =>
          console.error("external tool host close failed", error)
        )
      }
      for (const controller of gatewayControllers.values()) controller.abort()
      gatewayControllers.clear()
      for (const controller of localControllers.values()) controller.abort()
      localControllers.clear()
      registry.flushAllPersist()
      registry.clear()
      executionHandles.clear()
      // Each watcher owns a Dexie subscription and an interval. The Squad run
      // itself is unaffected — it is fire-and-forget and reports through the
      // run surfaces; only this hook's hold on the session goes away with it.
      for (const stop of squadWatchers.values()) stop()
      squadWatchers.clear()
    }
  }, [registry, releaseExternalToolHost])

  /**
   * Turn-silence watchdog (see `lib/chat/silence-watchdog`).
   *
   * Armed once the send is dispatched, fed by every inbound frame, and disarmed
   * by the store watcher below when the session leaves an active status. It
   * raises a persistent `turnSilent` warning and nothing else — it never ends
   * the turn, because a long tool call is indistinguishable from a dropped one
   * at this layer.
   */
  const silenceWatchdogRef = useRef<SilenceWatchdog | null>(null)
  // Created on demand rather than in the render body, because the effect below
  // disposes and clears the ref on cleanup. StrictMode replays mount → cleanup
  // → mount with NO re-render in between, so a render-body lazy init left the
  // second mount reading `null`, returning early, and installing no
  // subscription — the watchdog was inert for the whole of development. Making
  // the effect the thing that guarantees an instance keeps the two in step:
  // whatever is subscribed is what `arm` / `notice` reach.
  const ensureSilenceWatchdog = useCallback((): SilenceWatchdog => {
    const existing = silenceWatchdogRef.current
    if (existing) return existing
    const created = createSilenceWatchdog({
      onSilent: (sessionId, silentForMs) => {
        const session = useChatStore.getState().sessions[sessionId]
        // Never overwrite a real failure with "we heard nothing": a diagnostic
        // already on the session is strictly more informative than this one.
        if (session?.errorDiagnostic) return
        // And never warn about a turn that is not running. The store watcher
        // disarms on every settle, but it can only disarm what is armed — so
        // this is the backstop for any path that settles a session the clock
        // has not been told about yet. A card offering "Interrupt" on an idle
        // conversation is worse than no card.
        if (session?.status !== "streaming" && session?.status !== "awaiting_approval") return
        useChatStore.getState().setSessionDiagnostic(
          sessionId,
          createDiagnostic("turnSilent", {
            source: "chat",
            meta: { sessionId, extra: { silentForMs } },
          })
        )
      },
      onRecovered: (sessionId) => {
        // Clear only our own warning. Anything else on the session came from a
        // producer that knows more than the clock does.
        const current = useChatStore.getState().sessions[sessionId]?.errorDiagnostic
        if (current?.code === "turnSilent") {
          useChatStore.getState().setSessionDiagnostic(sessionId, null)
        }
      },
    })
    silenceWatchdogRef.current = created
    return created
  }, [])

  useEffect(() => {
    const watchdog = ensureSilenceWatchdog()
    // Same shape as the execution-broker lease watcher: one subscription
    // covers every settle path (session_ended, error, interrupt, external-agent
    // completion) instead of a disarm call per exit.
    //
    // Scoped to the ARMED sessions, not to every open one. This store writes
    // once per streaming delta, so an `Object.entries(state.sessions)` sweep
    // here ran the full session list thousands of times a turn to answer a
    // question about (normally) one of them. `state.sessions` identity is the
    // cheap first cut — most writes are composer/projection fields that leave
    // it alone — and `watchdog.armed()` is the second.
    //
    // `previous` is optional on purpose. Zustand always passes it, but it is
    // only ever an OPTIMISATION here — the armed scan below is correct on its
    // own — so a caller that notifies with just the new state (a test double,
    // a wrapper store) must still get the disarm, not a TypeError inside a
    // subscription every other producer shares.
    const unsubscribe = useChatStore.subscribe((state, previous?: typeof state) => {
      if (previous && state.sessions === previous.sessions) return
      for (const sessionId of watchdog.armed()) {
        const session = state.sessions[sessionId]
        // A closed pane drops its slice entirely; that is a settle too, and the
        // old sweep could not see it because it only walked what still existed.
        if (
          !session ||
          (session.status !== "streaming" && session.status !== "awaiting_approval")
        ) {
          watchdog.disarm(sessionId)
        }
      }
    })
    return () => {
      unsubscribe()
      watchdog.dispose()
      if (silenceWatchdogRef.current === watchdog) silenceWatchdogRef.current = null
    }
  }, [ensureSilenceWatchdog])

  // Route one ClaudeEvent into the per-session serialized queue → `handleEvent`.
  // Keyed by session so same-session events serialize; events without a session
  // id (ready/log/sidecar_exited) share one chain. Shared by the Tauri transport
  // subscription AND the standalone (BYOK) engine, so both producers drive the
  // identical store/coalescing/persistence path.
  const enqueueClaudeEvent = useCallback(
    (evt: ClaudeEvent) => {
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
    },
    [registry, getExecutionHandle]
  )

  // Subscribe to sidecar events once. Desktop gets them via Tauri events;
  // Capacitor / web-companion renderers get the same `claude://message`
  // channel mirrored over the companion events WebSocket (event_bus.rs), which
  // is what carries the mobile workflow copilot's streamed turns. Plain web
  // (WebStubTransport) has no event source — skip the subscription.
  useEffect(() => {
    if (!isTauri() && !isCapacitor() && !hasWebCompanionTarget()) return
    let unlisten: UnlistenFn | null = null
    let unregisterWorkSubmissionEvents: UnlistenFn | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const subscribe = () => {
      void onClaudeMessage((evt) => enqueueClaudeEvent(evt as ClaudeEvent))
        .then((u) => {
          if (cancelled) u()
          else {
            unlisten = u
            unregisterWorkSubmissionEvents = registerInteractiveWorkSubmissionEvents()
          }
        })
        .catch((err) => {
          console.error("listen claude events failed", err)
          if (!cancelled) retryTimer = setTimeout(subscribe, 1_000)
        })
    }
    subscribe()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      unlisten?.()
      unregisterWorkSubmissionEvents?.()
    }
  }, [enqueueClaudeEvent])

  /**
   * Send a user prompt to the active session.
   *
   * `content` can be a plain string (the common case) or an array of
   * multimodal content blocks (text + image), to support attachments.
   * Resolve false only for a refusal before the input reaches the transcript;
   * once a user/steer row takes it, resolve true even if dispatch fails.
   * `throwOnError` keeps the existing rejection behavior in either case.
   */
  const sendUnexcluded = useCallback(
    async (
      content: SendContent,
      opts?: SendOptions,
      callOptions?: AgentChatSendCallOptions
    ): Promise<boolean> =>
      runChatSend(
        {
          store,
          tRouting,
          tInlineErr,
          tAside,
          tDiagnostics,
          tPiPackages,
          tVideo,
          tCollab,
          tWorkspaceLayout,
          refuseCapturedTurn,
          warnUndeliveredAttachments,
          activeRef,
          messagesMirrorRef,
          lastUserContentRef,
          lastResourceContextRef,
          asideContextDispatchRef,
          skillAttemptByTurnRef,
          pendingBranchTagRef,
          pendingBranchOwnerRef,
          ownedContinuationRef,
          sharedApprovalResponseRef,
          squadWatchersRef,
          standaloneAbortRef,
          externalGatewayAbortRef,
          checkoutAbortRef,
          hostStateTurnsRef,
          externalTurnSettlementsRef,
          externalToolHostsRef,
          releaseExternalToolHost,
          executionHandlesRef,
          executionHandleDirectory,
          getExecutionHandle,
          registry,
          transcriptFenceRef,
          silenceWatchdogRef,
          enqueueClaudeEvent,
          readSettings: readAppSettings,
        },
        content,
        opts,
        callOptions
      ),
    [
      store,
      refuseCapturedTurn,
      tRouting,
      tInlineErr,
      tWorkspaceLayout,
      tAside,
      tDiagnostics,
      tPiPackages,
      tVideo,
      tCollab,
      warnUndeliveredAttachments,
      registry,
      releaseExternalToolHost,
      enqueueClaudeEvent,
      getExecutionHandle,
      executionHandleDirectory,
    ]
  )

  const invokeOwnedSend = useCallback(
    async (entry: DesktopTurnLease, args: Parameters<typeof sendUnexcluded>, joining = false) => {
      // The share is taken synchronously, so the lease cannot settle away while
      // a join checks for a Stop pressed in another window. Callers pin the
      // target session first: the active session may change during the await.
      entry.pendingDispatches++
      const preparedRunIds = new Set<string>()
      try {
        const sessionId = args[2]?.sessionId
        // Re-check synchronously after the cross-window probe resumes: a Stop
        // here may have begun while it was in flight.
        if (
          joining &&
          sessionId &&
          ((await sessionStopFenced(sessionId)) ||
            sessionStopPending(sessionId) ||
            (entry.stopping && !entry.stopping.interruptSettled))
        ) {
          toast.warning(tCaptureBusy("busy"))
          throw new Error("session_turn_busy")
        }
        return await sendUnexcluded(args[0], args[1], {
          ...args[2],
          onExecutionRunPrepared: (runId) => preparedRunIds.add(runId),
        })
      } finally {
        try {
          for (const runId of preparedRunIds) {
            if (!(await finishUnstartedDirectChatExecutionRun(runId))) continue
            const sessionId = args[2]?.sessionId
            if (!sessionId) continue
            store.setState((state) => {
              const slice = state.sessions[sessionId]
              if (!slice || runIdForTurn(sessionId, slice.runId) !== runId) return state
              // Preparation consumed this identity without ever entering streaming.
              // A retry needs a fresh row; terminal journals cannot be reopened.
              return {
                sessions: { ...state.sessions, [sessionId]: { ...slice, runId: slice.runId + 1 } },
              }
            })
          }
        } finally {
          entry.pendingDispatches--
          entry.settle()
        }
      }
    },
    [sendUnexcluded, store, tCaptureBusy]
  )

  const send = useCallback(
    async (...unpinned: Parameters<typeof sendUnexcluded>) => {
      const sessionId = unpinned[2]?.sessionId ?? store.getState().activeSessionId
      if (!sessionId) return sendUnexcluded(...unpinned)
      // Admission and dispatch target one session, whatever becomes active meanwhile.
      const args: Parameters<typeof sendUnexcluded> = [
        unpinned[0],
        unpinned[1],
        { ...unpinned[2], sessionId },
      ]
      const key = sessionTurnLockKey(sessionId)
      const busy = () => {
        toast.warning(tCaptureBusy("busy"))
        throw new Error("session_turn_busy")
      }
      // Admission re-checks it after taking the lock; this covers joining a lease.
      if (sessionStopPending(sessionId)) return busy()
      const existing = desktopTurnLeases.get(key)
      if (existing) {
        if (existing.stopping && !existing.stopping.interruptSettled) return busy()
        const status = sessionStatusOf(sessionId)
        const running =
          status === "streaming" || status === "awaiting_approval" || isChatTurnQueued(sessionId)
        // An awaited external execution still owns a dispatch, but content sent
        // during its run belongs to its steering/queue path. Before the turn is
        // running or queued, preparation must remain exclusive.
        if (
          (existing.pendingDispatches && !running) ||
          args[2]?.skipUserAppend ||
          args[2]?.steerDrain
        )
          return busy()
        return invokeOwnedSend(existing, args, true)
      }
      // Nobody waits on a dialog for an automation, a background result or a
      // shared-room takeover: those are held back with a notice instead.
      const hostPermit = await guardBuiltinSessionHostSend(sessionId, {
        interactive: !(
          args[2]?.automatedTurn ||
          args[2]?.backgroundDelivery ||
          args[2]?.sharedRequest
        ),
      })
      if (hostPermit === false) return false
      const release = await acquireSessionTurnLease(sessionId, true)
      if (!release) return busy()
      if (hostPermit && !(await hostPermit.isCurrent())) {
        void release()
        return false
      }
      // A Stop that began after admission resolved still fences this turn.
      if (sessionStopPending(sessionId)) {
        void release()
        return busy()
      }
      const entry: DesktopTurnLease = {
        pendingDispatches: 0,
        settle: () => {
          if (entry.pendingDispatches || desktopTurnLeases.get(key) !== entry) return
          if (entry.stopping && !entry.stopping.interruptSettled) return
          const status = sessionStatusOf(sessionId)
          if (
            status === "streaming" ||
            status === "awaiting_approval" ||
            isChatTurnQueued(sessionId)
          )
            return
          desktopTurnLeases.delete(key)
          unsubscribe()
          void release()
        },
      }
      desktopTurnLeases.set(key, entry)
      // The owner outlives dispatch and pane unmount. An internal continuation
      // acquires its share synchronously before its predecessor can settle.
      const unsubscribe = store.subscribe(entry.settle)
      return invokeOwnedSend(entry, args)
    },
    [invokeOwnedSend, sendUnexcluded, store, tCaptureBusy]
  )

  useEffect(() => {
    // Only runtime-owned continuations receive this reference; public entry
    // points must acquire admission. Keep the lease across awaited fallbacks
    // and fire-and-forget plan/steer turns alike.
    const continueFromLease = (
      lease: DesktopTurnLease | undefined,
      unpinned: Parameters<SendFn>
    ): ReturnType<SendFn> => {
      const sessionId = unpinned[2]?.sessionId ?? store.getState().activeSessionId
      const args: Parameters<SendFn> = sessionId
        ? [unpinned[0], unpinned[1], { ...unpinned[2], sessionId }]
        : unpinned
      const joinable =
        lease !== undefined &&
        typeof sessionId === "string" &&
        desktopTurnLeases.get(sessionTurnLockKey(sessionId)) === lease &&
        !sessionStopPending(sessionId) &&
        !(lease.stopping && !lease.stopping.interruptSettled)
      return joinable ? invokeOwnedSend(lease, args, true) : send(...args)
    }
    const continueOwned: SendFn = (...args) => {
      const sessionId = args[2]?.sessionId ?? store.getState().activeSessionId
      return continueFromLease(
        sessionId ? desktopTurnLeases.get(sessionTurnLockKey(sessionId)) : undefined,
        args
      )
    }
    ownedContinuationRef.current = continueOwned
    continueFromLeaseRef.current = continueFromLease
    sendRef.current = send
    return () => {
      if (ownedContinuationRef.current === continueOwned) ownedContinuationRef.current = null
      if (continueFromLeaseRef.current === continueFromLease) continueFromLeaseRef.current = null
      if (sendRef.current === send) sendRef.current = null
    }
  }, [invokeOwnedSend, send, store])

  useEffect(() => {
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
          (target.collaboration.endpoint &&
            target.collaboration.endpoint !== context.client.baseUrl)
        )
          return
        const { syncSharedSession } = await import("@/lib/collab/shared-chat-sync")
        const synced = await syncSharedSession(
          context.client,
          context.orgId,
          target.collaboration.sessionId
        )
        const { getDb } = await import("@/lib/db/schema")
        const messages = await getDb()
          .messages.where("sessionId")
          .equals(detail.sessionId)
          .toArray()
        if (detail.messageId) {
          const message = messages.find((candidate) => candidate.id === detail.messageId)
          if (!message || message.role !== "user") return
          const remoteId = message.collaboration?.remoteMessageId ?? message.id
          await context.client.enqueueSessionRunInput(
            context.orgId,
            target.collaboration.sessionId,
            {
              payload: { messageId: remoteId },
              operationId: `ai-request:${crypto.randomUUID()}`,
            }
          )
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
  }, [])

  // The chat lane of the one steer entry: derived inputs (a wakeup, an
  // automation) wait in a running conversation's queue for its boundary.
  useEffect(() => installChatSessionSteerLane(), [])
  // Its remote lane: a shared conversation whose run another device holds.
  useEffect(() => installSharedSessionSteerLane(), [])

  // Background-run result delivery: register the hook's send as the replay
  // channel, and drain pending results whenever a session (re)opens idle —
  // covers relaunches (journaled pending rows) and panes closed at settle.
  useEffect(() => {
    return registerBackgroundReplaySend(
      async (framedText, sessionId, deliveryId, personalRunIds) => {
        let accepted = false
        try {
          await sendRef.current?.(framedText, undefined, {
            sessionId,
            throwOnError: true,
            backgroundDelivery: {
              id: deliveryId,
              personalRunIds,
              onAccepted: () => {
                accepted = true
              },
            },
          })
        } catch {
          // Durable acceptance owns retries once committed, even if dispatch
          // subsequently fails. Before acceptance the journal remains pending.
        }
        return accepted
      }
    )
  }, [])

  // Same bridge for surfaces that answer the agent with an ordinary user
  // message — currently the inline async-question card (`data-async-questions`
  // parts). One registration covers every session: the callback carries the
  // target sessionId.
  useEffect(() => {
    return registerChatSendBridge((text, targetSessionId, automatedTurn) => {
      void sendRef
        .current?.(text, undefined, {
          sessionId: targetSessionId,
          ...(automatedTurn ? { automatedTurn } : { localAuthorization: LOCAL_PERSON_RUN }),
        })
        .catch(() => undefined)
    })
  }, [])

  // Retry for a transcript row that records a turn which never ran (see
  // `lib/chat/turn-admission.ts`). The row's turn is the session's last user
  // message, which is exactly what `regenerate` re-issues.
  const regenerateRef = useRef<((sessionId: string) => Promise<void>) | null>(null)
  useEffect(() => {
    return registerChatRetryBridge((targetSessionId) => {
      useChatStore.getState().setSessionError(targetSessionId, null)
      void regenerateRef.current?.(targetSessionId)
    })
  }, [])

  useEffect(
    () =>
      registerSessionPeerRuntime({
        isReachable: isSessionOpen,
        getStatus: sessionStatusOf,
        deliver: async (peerMessage) => {
          const sender = await getSession(peerMessage.senderSessionId)
          if (!sender) throw new Error(`Sender session ${peerMessage.senderSessionId} was removed`)
          // The stored peer row carries no originating Host execution proof,
          // and its receiver has not admitted a consuming run yet. Project
          // the title together with the content so the frame cannot disclose it.
          const peerHistory = await preparePersonalDerivedHistory(
            undefined,
            [
              {
                id: `session-peer:${peerMessage.id}`,
                content: JSON.stringify({ title: sender.title, content: peerMessage.content }),
                metadata: {
                  personalMarks: [
                    {
                      person: { kind: "local-person" },
                      source: "unproven-session-peer-history",
                      markedAt: 0,
                    },
                  ],
                },
              },
            ],
            { sessionId: peerMessage.senderSessionId }
          )
          const projected = peerHistory.messages[0]
          const withheld = peerHistory.withheldMessageIds.length > 0
          const visibleSender = withheld ? { ...sender, title: projected.content } : sender
          const visiblePeer = withheld
            ? { ...peerMessage, content: projected.content }
            : peerMessage
          const current =
            useChatStore.getState().sessions[peerMessage.receiverSessionId]?.messages ??
            (await listMessages(peerMessage.receiverSessionId))
          const inbound = buildSessionPeerInboundMessage(visiblePeer, visibleSender)
          inbound.metadata = {
            ...(inbound.metadata as Record<string, unknown> | undefined),
            ...projected.metadata,
          }
          if (!current.some((message) => message.id === inbound.id)) {
            const next = [...current, inbound]
            useChatStore.getState().setSessionMessages(peerMessage.receiverSessionId, next)
            await persistMessages(peerMessage.receiverSessionId, next)
          }
          if (peerMessage.intent === "trigger_turn") {
            const activeSend = sendRef.current
            if (!activeSend) throw new Error("Chat send runtime is unavailable")
            const modelPrompt = renderSessionPeerModelPrompt(visiblePeer, visibleSender)
            if (!hasNoLeakingPiiDeep(modelPrompt)) {
              throw new Error("Session peer prompt rejected by the renderer PII gate")
            }
            await activeSend(modelPrompt, undefined, {
              sessionId: peerMessage.receiverSessionId,
              skipUserAppend: true,
            })
          }
        },
      }),
    []
  )
  const openSessionIdsForDrain = useChatStore((s) => s.openSessionIds)
  const paneIdsForDrain = useChatStore((s) => s.paneIdsBySession)
  const holdsForDrain = useChatStore((s) => s.backgroundHolds)
  useEffect(() => {
    void expireSessionPeerMessages().catch(() => undefined)
    const reachable = liveSessionIds({
      openSessionIds: openSessionIdsForDrain,
      paneIdsBySession: paneIdsForDrain,
      backgroundHolds: holdsForDrain,
    })
    for (const sessionId of reachable) {
      maybeDrainBackgroundResults(sessionId)
      void drainSessionPeerMessages(sessionId).catch(() => undefined)
    }
  }, [openSessionIdsForDrain, paneIdsForDrain, holdsForDrain])

  // Self-paced /loop kick-off: when the runtime creates or resumes a loop
  // for a reachable session, dispatch its next iteration silently — the same
  // skipUserAppend path as every later continuation, so the send never trips
  // the fresh-user-message preempt above.
  // A HostState turn settles by projection, not by a local `session_ended`:
  // once its session leaves the busy states, apply the settle's steer rule —
  // a clean end (or an armed "Interrupt & send") replays the queue, an errored
  // end keeps it and says so on the bubbles.
  useEffect(() => {
    const settleHostStateTurns = () => {
      for (const sessionId of [...hostStateTurnsRef.current]) {
        const status = sessionStatusOf(sessionId)
        if (status === "streaming" || status === "awaiting_approval") continue
        hostStateTurnsRef.current.delete(sessionId)
        if (status === "error" && !steerArmed.has(sessionId)) markPendingSteersFailed(sessionId)
        else {
          // This settle belongs to the turn that still holds the lease. Hold it
          // across the drain: clearing the queue notifies the store again, and
          // that nested settle must not release the lease before the replay joins.
          const lease = desktopTurnLeases.get(sessionTurnLockKey(sessionId))
          if (lease) lease.pendingDispatches++
          try {
            drainSteerVia(sessionId, {
              current: (...args) =>
                continueFromLeaseRef.current?.(lease, args) ?? Promise.resolve(),
            })
          } finally {
            if (lease) {
              lease.pendingDispatches--
              lease.settle()
            }
          }
        }
        // As at a local settle: steer first, then background results, which
        // defer themselves if the steer replay started a new turn.
        maybeDrainBackgroundResults(sessionId, { turnSettled: true })
      }
    }
    return useChatStore.subscribe(settleHostStateTurns)
  }, [])

  useEffect(() => {
    const unsub = getLoopRuntime().onKickoff((loop) => {
      if (!isSessionOpen(loop.sessionId)) return
      void sendRef
        .current?.(renderLoopIterationMessage(loop), undefined, {
          sessionId: loop.sessionId,
          skipUserAppend: true,
        })
        .catch(() => undefined)
    })
    return unsub
  }, [])

  // The one runtime dispatch that cuts a running turn short. Stop, Esc and
  // "Interrupt & send" all end the same turn on the same runtime, so they must
  // reach it the same way: a lane missing here is a turn one of them cannot
  // stop. Every branch makes the runtime emit its own `session_ended`, which
  // is what settles the turn (and, for an armed steer, replays the queue).
  const abortRunningTurn = useCallback(
    async (sessionId: string, hostStateAbortQueued: boolean): Promise<void> =>
      abortRunningChatTurn(
        { standaloneAbortRef, externalGatewayAbortRef, getExecutionHandle },
        sessionId,
        hostStateAbortQueued
      ),
    [getExecutionHandle]
  )

  const stop = useCallback(
    async (targetSessionId?: string) =>
      stopChatTurn(
        {
          store,
          tSteer,
          messagesMirrorRef,
          checkoutAbortRef,
          hostStateTurnsRef,
          registry,
          abortRunningTurn,
        },
        targetSessionId
      ),
    [store, registry, abortRunningTurn, tSteer]
  )

  // "Interrupt & steer now": cut the running turn short so its settle replays
  // the queued steer immediately, instead of waiting for the turn to finish.
  // Arming covers the case where the abort surfaces as an errored
  // `session_ended`. No-op when nothing is queued.
  const interruptAndSteer = useCallback(
    async (targetSessionId?: string) =>
      interruptChatTurnAndSteer(
        { store, refuseCapturedTurn, externalGatewayAbortRef, hostStateTurnsRef, abortRunningTurn },
        targetSessionId
      ),
    [store, abortRunningTurn, refuseCapturedTurn]
  )

  // Replay a session's queued steer NOW, without a turn boundary. Used by the
  // Run Panel after an errored settle, where the queue is preserved but no
  // settle event is coming — `interruptAndSteer` can't help (nothing to
  // interrupt), so we drain directly. No-op when the queue is empty.
  const flushSteer = useCallback(
    (targetSessionId?: string) => flushChatSteer({ refuseCapturedTurn, sendRef }, targetSessionId),
    [refuseCapturedTurn]
  )

  const respondToApproval = useCallback(
    async (
      approval: PendingApproval,
      decision: ApprovalDecision,
      options?: ApprovalResponseOptions
    ): Promise<void> =>
      respondToChatApproval({ store, sendRef, getExecutionHandle }, approval, decision, options),
    [store, getExecutionHandle]
  )

  // Surfaces outside this provider's tree (the island overlay's main-window
  // half) answer approvals and stop turns through the same two closures the
  // approval card and the composer use — see `chat-control-bridge.ts`.
  useEffect(() => registerChatApprovalBridge(respondToApproval), [respondToApproval])
  useEffect(() => registerChatStopBridge(stop), [stop])

  useEffect(() => {
    sharedApprovalResponseRef.current = respondToApproval
    return () => {
      sharedApprovalResponseRef.current = null
    }
  }, [respondToApproval])

  const close = useCallback(
    async (sessionId: string) =>
      closeChatSession(
        {
          messagesMirrorRef,
          standaloneAbortRef,
          externalGatewayAbortRef,
          releaseExternalToolHost,
          executionHandlesRef,
          executionHandleDirectory,
          getExecutionHandle,
          registry,
        },
        sessionId
      ),
    [registry, getExecutionHandle, executionHandleDirectory, releaseExternalToolHost]
  )

  const compact = useCallback(
    async (sessionId: string) => compactChatSession({ getExecutionHandle }, sessionId),
    [getExecutionHandle]
  )

  const setModel = useCallback(
    async (sessionId: string, model: string) =>
      setChatSessionModel({ getExecutionHandle }, sessionId, model),
    [getExecutionHandle]
  )

  const resetRuntime = useCallback(
    async (sessionId: string) =>
      resetChatRuntime(
        { executionHandlesRef, executionHandleDirectory, getExecutionHandle },
        sessionId
      ),
    [getExecutionHandle, executionHandleDirectory]
  )

  const rewindFiles = useCallback(
    async (sessionId: string, checkpointId: string, dryRun: boolean) =>
      rewindChatFiles({ getExecutionHandle }, sessionId, checkpointId, dryRun),
    [getExecutionHandle]
  )

  /** Name the files an edit or a regenerate could not send again. */
  const warnNotResent = useCallback(
    (filenames: readonly string[]) => {
      if (filenames.length === 0) return
      toast.warning(
        tAttachments("notResent", { count: filenames.length, names: filenames.join(", ") })
      )
    },
    [tAttachments]
  )

  /**
   * Resend a user message with edited content, keeping the original as a
   * sibling branch.
   *
   * This used to `truncateAfter(..., { inclusive: true })` — the original
   * question and every reply beneath it were deleted from Dexie outright, so
   * rewording a question halfway up a long thread silently destroyed the rest
   * of it with no undo. Regenerate had kept its alternatives as branches since
   * it was written; editing is the same shape of operation and now behaves the
   * same way. `tagEditSibling` stamps the original into a branch group and
   * re-parents its tail, and `selectVisibleMessages` hides that tail while the
   * new variant is selected. Nothing is deleted; flipping the navigator back
   * brings the original question and its whole subtree with it.
   *
   * Users who genuinely want the old behaviour have the explicit "delete this
   * message and everything after it" action, which still truncates.
   *
   * The edit resends the original's files, as other chat apps keep a message's
   * attachments when it is edited. Every edit surface drafts the typed text
   * alone, so plain-text `newContent` takes the files from the original row
   * (`resendableAttachments`). No edit surface offers to remove them. A file
   * the row cannot send again is named to the user rather than dropped
   * silently.
   *
   * A caller that builds the blocks itself passes `attachmentManifest` for the
   * leading attachment blocks of `newContent`, as `send`'s option of the same
   * name, and decides the files itself. Without the manifest, the first file's
   * extracted text would be read as the question: its `@handle`, the envelope
   * carried onto it, and everything `send` reads from the typed block.
   */
  const editAndResend = useCallback(
    async (
      messageId: string,
      newContent: SendContent,
      targetSessionId?: string,
      resourceContext?: string,
      attachmentManifest?: readonly AttachmentManifestEntry[]
    ) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (refuseCapturedTurn(sessionId)) return
      // Mid-turn this send would land as a steer — and a steer never consumes
      // `branchTag`, leaving the group `tagEditSibling` is about to persist
      // with no replacement variant. Surfaces disable the affordance; this is
      // the backstop for draft submits racing a turn start. A turn still
      // waiting for admission counts as live too: it has not flipped the
      // status yet, and re-issuing it would queue the same turn twice.
      const st = sessionStatusOf(sessionId)
      if (st === "streaming" || st === "awaiting_approval" || isChatTurnQueued(sessionId)) return
      // Rebuilding the branch base invalidates this session's streaming mirror;
      // drop it (and pending coalescing work) so the rebuilt base wins.
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)

      const messages = store.getState().sessions[sessionId]?.messages ?? []
      const editedIdx = messages.findIndex((m) => m.id === messageId)
      if (editedIdx < 0) return

      const edited = messages[editedIdx]
      // The original's files go with a plain-text edit, read from its row
      // before anything is tagged.
      let editedContent: SendContent = newContent
      let editedManifest = attachmentManifest
      let notResent: string[] = []
      if (typeof newContent === "string" && !attachmentManifest?.length) {
        const { resendableAttachments } = await import("@/lib/chat/attachments/resend")
        const carried = await resendableAttachments(edited.parts)
        notResent = carried.unavailable
        if (carried.blocks.length > 0) {
          editedContent = newContent.trim()
            ? [...carried.blocks, { type: "text", text: newContent }]
            : carried.blocks
          editedManifest = carried.manifest
        }
      }
      // The edit is the question again, so its leading `@handle` is read again:
      // adding, changing or removing it re-routes the resend. Resolved BEFORE
      // the original is tagged as a sibling, so a route that cannot run leaves
      // the thread exactly as it was.
      let turnRoute: TurnRoute | null = null
      const attachmentCount = editedManifest?.length ?? 0
      const editedTyped = stripPromptPreamble(userPromptText(editedContent, attachmentCount))
      if (/^\s*@/.test(editedTyped)) {
        const editedSession = await getSession(sessionId)
        if (isRoutableSession(editedSession)) {
          const snapshot = await snapshotRouteContext(sessionId, { session: editedSession ?? null })
          const parsed = parseLeadingRoute(editedTyped, snapshot.targets)
          if (parsed) {
            const lane = resolveRouteLane(parsed.route.target, snapshot)
            if (!lane.ok) {
              store.getState().setSessionDiagnostic(
                sessionId,
                createDiagnostic("turnRouteUnavailable", {
                  source: "chat",
                  ...(lane.detail ? { message: lane.detail } : {}),
                  meta: { sessionId, extra: { handle: parsed.route.handle, reason: lane.reason } },
                })
              )
              return
            }
            turnRoute = parsed.route
          }
        }
      }
      const { merged, groupId, nextIndex } = tagEditSibling(messages, editedIdx)
      store.getState().replaceSessionMessages(sessionId, merged)
      await persistMessages(sessionId, merged)

      // Every edit surface drafts from the typed text, so the context envelope
      // the question was originally sent with — and the citations it made —
      // are carried over from the original row. Passing the citations (even
      // an empty list) also stops the send path from reading whatever chips
      // happen to be staged in the composer right now.
      const promptPreamble = readPromptPreambleSummary(edited.metadata)
      warnNotResent(notResent)
      await send(carryPromptPreamble(edited.parts, editedContent, attachmentCount), undefined, {
        localAuthorization: LOCAL_PERSON_RUN,
        sessionId,
        ...(editedManifest?.length ? { attachmentManifest: editedManifest } : {}),
        citations: chipCitationsOf(edited.metadata),
        ...(promptPreamble ? { promptPreamble } : {}),
        resourceContext: resourceContext ?? lastResourceContextRef.current.get(sessionId)?.context,
        // The replacement is a *user* message, created inside `send` itself,
        // so it is tagged there rather than through the assistant-event path
        // `regenerate` uses.
        branchTag: {
          groupId,
          index: nextIndex,
          edit: { messageId, previousContent: userPromptText(edited.parts as SendContent, 0) },
        },
        ...(turnRoute ? { turnRoute } : {}),
      })
    },
    [send, store, registry, warnNotResent, refuseCapturedTurn]
  )

  /**
   * Re-issue the most recent user turn. Drops the assistant reply that
   * followed it (and anything after) and resends the original content.
   */
  const regenerate = useCallback(
    async (targetSessionId?: string, resourceContext?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (refuseCapturedTurn(sessionId)) return

      // Regenerate bypasses the steer gate via `skipUserAppend`, so mid-turn
      // it would re-enter the normal send path — restarting the sidecar and
      // silently dropping the live turn's context (see the send-gate comment).
      // Surfaces disable the affordance; this is the backstop. A turn parked
      // waiting for admission is live as well (its status is still idle):
      // regenerating it would queue a second copy of the same turn.
      const st = sessionStatusOf(sessionId)
      if (st === "streaming" || st === "awaiting_approval" || isChatTurnQueued(sessionId)) return

      // Rebuilding the branch base invalidates this session's streaming mirror;
      // drop it (and pending coalescing work).
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)

      const messages = useChatStore.getState().sessions[sessionId]?.messages ?? []
      let lastUserIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserIdx = i
          break
        }
      }
      if (lastUserIdx < 0) return

      const anchor = messages[lastUserIdx]
      // A turn addressed with `@codex` is regenerated on Codex again, not on
      // whatever the conversation is on now. A route that can no longer run
      // (the agent disabled since, the member removed) is refused by `send`
      // like every other refusal: before `regenerateBranch` touches the thread.
      const turnRoute = readTurnRoute(anchor.metadata)

      // The turn goes again as it was sent. The cache holds exactly that for
      // the turn this controller last sent; any other (one sent before a
      // reload, or from another surface) is rebuilt from its own row, files
      // included, with the manifest that keeps them from reading as the
      // question.
      const cached = lastUserContentRef.current.get(sessionId)
      let content: SendContent
      let manifest: readonly AttachmentManifestEntry[] | undefined
      if (cached?.messageId === anchor.id) {
        content = cached.content
        manifest = cached.manifest
      } else {
        const { resendableUserTurn } = await import("@/lib/chat/attachments/resend")
        const rebuilt = await resendableUserTurn(anchor.parts)
        content = rebuilt.content
        manifest = rebuilt.manifest
        warnNotResent(rebuilt.unavailable)
      }
      await send(content, undefined, {
        localAuthorization: LOCAL_PERSON_RUN,
        skipUserAppend: true,
        sessionId,
        ...(manifest?.length ? { attachmentManifest: manifest } : {}),
        resourceContext: resourceContext ?? lastResourceContextRef.current.get(sessionId)?.context,
        // The replies become siblings, and the next one's slot is armed, only
        // once the send has passed every gate that can refuse it.
        regenerateBranch: { anchorId: anchor.id },
        ...(turnRoute ? { turnRoute } : {}),
      })
    },
    [send, registry, warnNotResent, refuseCapturedTurn]
  )
  useEffect(() => {
    regenerateRef.current = regenerate
  }, [regenerate])

  const sendFromLocalPerson = useCallback(
    (...args: Parameters<typeof send>) =>
      send(args[0], args[1], { ...args[2], localAuthorization: LOCAL_PERSON_RUN }),
    [send]
  )

  return {
    send: sendFromLocalPerson,
    stop,
    interruptAndSteer,
    flushSteer,
    respondToApproval,
    compact,
    setModel,
    resetRuntime,
    rewindFiles,
    close,
    editAndResend,
    regenerate,
  }
}
