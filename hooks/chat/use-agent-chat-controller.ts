"use client"
import * as personalSinkHost from "@/lib/execution/personal-sink"

import { bindPersonalMessageRun } from "@/lib/execution/personal-marks"
import {
  preparePersonalDerivedHistory,
  preparePersonalHistory,
} from "@/lib/execution/personal-visibility"

import {
  acquireSessionTurnLease,
  beginSessionStop,
  sessionStopFenced,
  sessionStopPending,
  sessionTurnLockKey,
} from "@/lib/execution/session-turn-lock"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

import { publishChatLifecycleEvent } from "@/lib/chat/lifecycle-events"
import { waitForModelSelection } from "@/lib/chat/model-selection"
import { guardBuiltinSessionHostSend } from "@/lib/chat/session-host-binding"

import { withWorkbenchMessageContext } from "@/lib/context-workbench/provider-context"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  hasCaptureResponder,
  isSessionCaptured,
  captureOwnedSessionIds,
  subscribeCaptureOccupancy,
} from "@/lib/ai/agent/execution/hitl/approval-registry"
import { useTranslations } from "next-intl"

import type { UnlistenFn } from "@tauri-apps/api/event"
import { persistMessageSessionAssets } from "@/lib/db/session-assets"
import { makeUserMessage } from "@/lib/chat/sdk-message-adapter"
import { clearProjectHistoryEvidence } from "@/lib/chat/history-evidence-registry"
import { toast } from "sonner"

import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { enforceVideoDeliveryForRoute } from "@/lib/chat/attachments/video/route-guard"
import { videoRouteFacts } from "@/lib/chat/attachments/video/route-facts"
import { prefixReplyContext, withReplyContextLines } from "@/lib/chat/reply-to"

import {
  carryPromptPreamble,
  chipCitationsOf,
  readPromptPreambleSummary,
  stripPromptPreamble,
} from "@/lib/chat/prompt-preamble"
import { createDiagnostic, type CogniaDiagnostic } from "@cognia/diagnostics"
import {
  requestedRuntimeCapabilities,
  runtimeFeatureValidationError,
} from "@cognia/agent-contracts/session-operations"
import { createSilenceWatchdog, type SilenceWatchdog } from "@/lib/chat/silence-watchdog"
import { resolveTurnSquad } from "@/lib/squads/squad/resolve-turn-squad"
import {
  assertExternalRuntimeFeatureSupport,
  isGatewaySessionLink,
} from "@/lib/ai/agent/external/session/session-models"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { flushProjectEditorEdits } from "@/lib/files/project-editor-bridge"
import { getGoalRuntime } from "@/lib/goal/runtime"

import { getLoopRuntime } from "@/lib/loop/runtime"
import { renderLoopIterationMessage } from "@/lib/loop/prompts"
import { notifyDroppedCapabilityOnce } from "@/lib/chat/dropped-capability-toast"
import { notifyOverBudgetOnce } from "@/lib/chat/over-budget-toast"
import { steerBlocksOf, steerTextOf, type SteerMessageMeta } from "@/lib/chat/steer"
import {
  appendSteerMessage,
  installChatSessionSteerLane,
  isSessionOpen,
  liveSessionIds,
  markPendingSteersFailed,
  mergeSteerWebSearchIntoLastSend,
  putBackPendingSteers,
  sessionExternalLane,
  sessionStatusOf,
  setSessionExternalLane,
  setSteerMessageState,
  steerArmed,
} from "@/lib/chat/steer-runtime"
import { supersedePendingApprovals } from "./approval-supersede"

import { invalidateJudgeContext } from "@/lib/ai/agent/execution/permissions/command-judge"
import {
  drainSessionPeerMessages,
  registerSessionPeerRuntime,
} from "@/lib/chat/session-peer-messaging"
import {
  buildSessionPeerInboundMessage,
  renderSessionPeerModelPrompt,
} from "@/lib/chat/session-peer-delivery"
import { expireSessionPeerMessages } from "@/lib/db/session-peer-messages"
import { markAttachedSessionRunning } from "@/lib/chat/attached-session"

import {
  maybeDrainBackgroundResults,
  registerBackgroundReplaySend,
} from "./background-result-runtime"
import { registerChatRetryBridge, registerChatSendBridge } from "./chat-send-bridge"
import { automatedTurnMetadata } from "@cognia/agent-config-types/automated-turn"
import { registerChatApprovalBridge, registerChatStopBridge } from "./chat-control-bridge"
import { tagBranchSiblings, tagEditSibling } from "@/lib/chat/branch-regen"
import {
  closeSession,
  compactSession,
  interruptSession,
  onClaudeMessage,
  sendPrompt,
  setSessionModel,
  turnsRunOnPairedHost,
} from "@/lib/ai/agent/execution/sidecar-client"

import { isEmbeddedSession } from "@/lib/chat/session-exposure"
import { gateWorkbenchProviderPayload } from "@/lib/context-workbench/provider-payload"
import { resolvedSessionAsideRuntime } from "@/lib/claude/build-options"
import { clearSessionGrants } from "@/lib/plugin/security/computer-use-session-grants"
import { releaseSkillLoadContext } from "@/lib/skills/runtime-loader"
import {
  commitMessageDelta,
  listMessages,
  persistMessages,
  persistStreamingMessages,
} from "@/lib/db/messages"
import {
  enqueueHostStateIntentIfAvailable,
  enqueueHostStateIntentWhenAvailable,
  HostStateChannelUnavailableError,
  hostStateSessionIntentAvailable,
  withdrawUnsentHostStateMessages,
  type WithdrawnHostStateMessage,
} from "@/lib/db/mobile-outbound-queue"
import {
  MemberAttachmentUploadError,
  memberTurnAttachments,
  uploadMemberTurnAttachments,
} from "@/lib/companion/member-turn-attachments"
import { hostStateActionOfferedHere } from "@/lib/sync/host-state-offered-actions"
import { restoreWithdrawnToComposer } from "@/lib/chat/restore-withdrawn"
import { SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import { mergeInboundMessagesForStream } from "@/lib/db/inbound-stored-parts"
import {
  getSession,
  touchSession,
  updateSession,
  clearBranchSeed,
  freezeImportedSession,
} from "@/lib/db/sessions"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { endSpan, recordEvent, startSpan } from "@cognia/agent-trace/emitter"
import { toTraceparent } from "@/lib/agent-trace/trace-context"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import {
  beginCodeAdoptionTurn,
  markCodeAdoptionTrackingUnavailable,
} from "@/lib/code-adoption/client"
import { externalAgentWorkspaceCaptureSupport } from "@/lib/task-workspace/capture-support"
import { compositionForSession, useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import {
  markTaskWorkspaceTurnCancelled,
  markTaskWorkspaceTurnUnowned,
} from "@/lib/code-adoption/turn-tracker"
import {
  acquireWorkspaceBundle,
  beginObservedTaskWorkspaceTurn,
  isExecutorStopUnconfirmedRefusal,
  isWorkspaceBusyRefusal,
  runIdForTurn,
  taskIdForMessage,
} from "@/lib/task-workspace/client"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import { ensureExecutionPortLease } from "@/lib/task-workspace/execution-port-lease"
import {
  finishDirectChatExecutionRun,
  finishUnstartedDirectChatExecutionRun,
  releasePreparedDirectChatExecutionRun,
  ensureDirectChatExecutionRun,
  startDirectChatExecutionRun,
} from "@/lib/execution/direct-chat-run"
import {
  beginSharedSessionRun,
  sendSharedSessionMessage,
  sharedRequestTranscript,
  canAutomaticallyDrainSharedQueue,
} from "@/lib/collab/shared-run-coordinator"
import { installSharedSessionSteerLane, steerSharedFollowUp } from "@/lib/collab/shared-run-steer"
import {
  applySharedRoomInstructions,
  isRoomAsleepRefusal,
  shouldRequestSharedReply,
} from "@/lib/collab/shared-room-settings"
import {
  acceptChatTurn,
  bindChatTurnContext,
  chatSubmissionId,
  claimChatTurnForDispatch,
  markChatTurnStarted,
  settleChatTurnForSession,
} from "@/lib/work-submission/chat-adapter"
import { startWorkSubmissionLeaseHeartbeat } from "@/lib/work-submission/lease-heartbeat"

import { openWorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"
import {
  ensureSessionExecutionBundle,
  type SessionBundleBinding,
} from "@/lib/task-workspace/session-bundle"
import {
  repairManagedContextProjectId,
  bindExecutionBundleTurn,
  bindExecutionRun,
  resolveSessionWorkspaceRoot,
  transitionManagedWorktree,
} from "@/lib/task-workspace/session-execution-context"
import { getProjectEnvironment } from "@/lib/db/project-environments"
import { executeProjectEnvironment } from "@/lib/project-environment/executor"
import { resolveEnvironmentForRun } from "@/lib/project-environment/resolve-environment"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import {
  AgentCapabilityError,
  createAgentExecutionHandle,
  type AgentExecutionHandle,
} from "@/lib/ai/agent/execution/agent-execution-handle"
import { useAgentExecutionHandleDirectory } from "@/components/providers/agent-execution-handle-provider"
import { useGitStore } from "@/stores/git/git-store"
import { refreshGitStatus } from "@/lib/git/load"
import { chatMentionResolvers } from "@/lib/chat/mentions/agent-targets"
import {
  routeTargetsFromStores,
  snapshotRouteContext,
  type RouteContextSnapshot,
} from "@/lib/chat/turn-route/snapshot"
import { buildRouteStamp, resolveRouteLane, routeCharacter } from "@/lib/chat/turn-route/resolve"
import { parseLeadingRoute, stripLeadingRouteToken } from "@/lib/chat/turn-route/parse"
import {
  foreignTurnsHandoffText,
  prefixForeignTurnsContext,
  unseenForeignTurns,
} from "@/lib/chat/turn-route/history"
import {
  isRoutableSession,
  readTurnRoute,
  type RouteLane,
  type TurnRoute,
} from "@/lib/chat/turn-route/types"
import type { MessageRunRouteStamp } from "@/lib/chat/message-run-metadata"
import { resolveTurnContextRefs } from "@/lib/chat/mentions/resolve-mentions"
import { isTranscriptEntityRefId } from "@/lib/collab/shared-reference-scan"

import {
  dispatchChatError as dispatchPluginChatError,
  dispatchUserPromptSubmit as dispatchPluginUserPromptSubmit,
  dispatchOnMessageSend as dispatchPluginMessageSend,
  hasPostToolUseListeners,
} from "@/lib/plugin/messaging/agent-hook-dispatch"
import {
  prepareAsideContext,
  ASIDE_REFERENCE_HEADER,
  type AsideContextDelivery,
} from "@/lib/chat/session-aside-context"
import { createAsideContextDispatch } from "@/lib/context-workbench/aside-context-dispatch"
import { advanceResourceAsideContextCursor } from "@/lib/db/resource-workbench-sessions"
import { getRuntimeSnapshot, isMemberOnPartition } from "@/lib/runtime/runtime-snapshot-store"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { runStandaloneTurn } from "@/lib/ai/chat/standalone-engine"
import { runVscodeChatTurn } from "@/lib/plugin/vscode-shim/chat-turn"
import type {
  ApprovalDecision,
  ApprovalResponseOptions,
  ClaudeEvent,
  PendingApproval,
  SendContent,
  SendOptions,
} from "@cognia/agent-config-types"
import {
  selectComposerCitedRefs,
  selectComposerEphemeralSkillIds,
  selectComposerPendingCommandOverrides,
  selectVisibleMessages,
  useChatStore,
} from "@/stores/chat"
import { getExecutionBroker } from "@/lib/execution/broker"
import {
  canContinueChat,
  continuationMessageId,
  continuationRuntimeOf,
  lastUserMessage,
  pickChatContinuationMetadata,
} from "@/lib/chat/continuation"
import { slotKeyForTurn } from "@/lib/execution/slot-key"
import { resolveEffectiveCwdForSession } from "@/lib/chat/session-effective-cwd"
import {
  acquireChatLease,
  isChatTurnQueued,
  isQueuedChatTurnCancellation,
} from "@/lib/execution/chat-lease"
import { workingCopyConflict } from "@/lib/execution/lease-conflict"
import {
  markTurnAdmission,
  turnMessageId,
  waitFromBlocker,
  type TurnAdmissionMeta,
} from "@/lib/chat/turn-admission"
import { planHaltCauseForCode } from "@/lib/ai/agent/external/turn-failure"
import { haltInSessionPlanOnTurnFailure } from "./plan-turn-settle"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import {
  selectSessionSubagents,
  applySubagentsToMessages,
  subagentSignature,
} from "@/lib/chat/subagent-bridge"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { useExternalAgentStore } from "@/stores/agent"
import {
  externalSessionLinkForSession,
  runtimeRefForSession,
} from "@/stores/agent/agent-runtime-store"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { isTauri } from "@/lib/tauri"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import { enforceCostBudget, isCostBudgetConfigured } from "@/lib/usage/cost-budget-gate"
import { isProjectRoleSessionPaused } from "@/lib/project-coordinator/project-access"
import { cancelRouterFusionTurn } from "@/lib/router-fusion/gate/chat-events"
import { abortRouterFusionSend, prepareRouterFusionSend } from "@/lib/router-fusion/gate/chat-send"
import { routerFusionRefusalDiagnostic } from "@/lib/router-fusion/gate/refusal-diagnostic"
import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"
import { routerFusionGate } from "@/lib/router-fusion/gate/feature-gate"
import type { UIMessage } from "ai"
import { registerInteractiveWorkSubmissionEvents } from "@/lib/work-submission/terminal-events"
import { behaviorTurnStartedAt, finishBehaviorTurn } from "./agent-chat-tool-hooks"
import { applyInstantTitle, clearPendingLoopContinuation } from "./agent-chat-turn-tasks"
import type { SendFn } from "./agent-chat-turn-tasks"
import {
  prepareTranscriptRuntimeSend,
  preparePersonalSteer,
  assertPersonalContextReaders,
  buildSendOptions,
} from "./agent-chat-send-options"
import {
  createTranscriptRuntimeFence,
  type TranscriptRuntimeFence,
  withTranscriptRuntimeLock,
  invalidateTranscriptRuntime,
} from "@/lib/chat/transcript/revision-events"
import { hostStateSendEligible, type HostStateSendFacts } from "./host-state-send-eligibility"
import type { TurnImagesWithheld } from "@/lib/ai/agent/external/session/turn-images"

import { routingPlanTraceAttributes } from "@/lib/routing/plan-trace-attributes"
import { drainSteerVia, handleEvent } from "./agent-chat-events"
import {
  fusionChatTurnActive,
  routerFusionSendDiagnostic,
  runFusionChatTurn,
  stopFusionChatTurn,
} from "./router-fusion-chat-turn"
import {
  applyChatCommandOverrides,
  asideContextForRegenerate,
  asideProviderHistoryMode,
  buildPersonalAsideContext,
  chatHookCredentialContext,
  createExternalIdleEventConsumer,
  externalAsideTurnContent,
  externalTurnPrompt,
  localChatRunAuthorization,
  memberUploadDiagnostic,
  redirectSendToBundleAliases,
  resolveChatTurnAttemptIdentity,
  rewriteUserPromptText,
  type ExternalTurnOmissions,
  userPromptText,
  type AgentChatSendCallOptions,
} from "./agent-chat-turn-helpers"
import { runExternalAgentTurn } from "./agent-chat-external-turn"
import { respondToChatApproval } from "./agent-chat-approvals"

/**
 * Sessions whose live shared send already warned about embedded references.
 * Once per session is deliberate: every send carrying a `@chat:`/`@msg:`
 * snapshot publishes it to every member, but a toast per message is spam —
 * the first one is when the user can still change their mind cheaply.
 */
const sharedReferenceWarnedSessions = new Set<string>()

type DesktopTurnLease = {
  pendingDispatches: number
  settle: () => void
  /** Set by Stop; the lease is held until the interrupt command settles. */
  stopping?: { interruptSettled: boolean }
}
const desktopTurnLeases = new Map<string, DesktopTurnLease>()

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
    ): Promise<boolean> => {
      const localAuthorization = localChatRunAuthorization(callOptions)
      const sessionId = callOptions?.sessionId ?? useChatStore.getState().activeSessionId
      let inputReachedTranscript = false
      // Branch bookkeeping this send arms for the turn it starts: a
      // regenerate's pending reply tag, and an edit's owner entry plus the
      // navigator pick that shows the edit. Every refusal goes through
      // `rejectSend`, which disarms whatever is still armed — `handleEvent`
      // only drops these on `session_ended`, which a turn that never ran does
      // not produce, so a leftover would stamp the NEXT turn's reply.
      let armedTag: { groupId: string; index: number } | null = null
      let armedOwner: string | null = null
      let armedPick: { groupId: string; messageId: string; previous: string | undefined } | null =
        null
      const disarmBranch = (): void => {
        if (!sessionId) return
        if (armedTag && pendingBranchTagRef.current.get(sessionId) === armedTag) {
          pendingBranchTagRef.current.delete(sessionId)
        }
        armedTag = null
        if (armedOwner && pendingBranchOwnerRef.current.get(sessionId) === armedOwner) {
          pendingBranchOwnerRef.current.delete(sessionId)
        }
        armedOwner = null
        const pick = armedPick
        armedPick = null
        if (!pick) return
        const slice = store.getState().sessions[sessionId]
        // A refusal that kept the edited row (it is marked failed, with its own
        // retry) keeps it selected. One that never appended it, or rolled it
        // back, returns the navigator to the variant it showed before.
        if (slice?.messages.some((message) => message.id === pick.messageId)) return
        const picks = slice?.activeBranchByGroup ?? {}
        if (picks[pick.groupId] !== pick.messageId) return
        const restored = { ...picks }
        if (pick.previous === undefined) delete restored[pick.groupId]
        else restored[pick.groupId] = pick.previous
        store.getState().hydrateSessionActiveBranches(sessionId, restored)
      }
      // The reply half of the same bookkeeping, for the lanes that write their
      // own assistant message instead of streaming it through `handleEvent`
      // (the external agent, a Squad handoff). Stamps `replyId` the way
      // `handleEvent` stamps a sidecar reply — a regenerate's armed slot, which
      // is also selected so the new answer is the one shown, and an edit's
      // owner — and consumes both, so neither outlives this turn. Only entries
      // this send armed and that are still pending: a later send's are its own.
      const claimReplyBranch = (replyId: string): Record<string, unknown> => {
        const stamp: Record<string, unknown> = {}
        if (!sessionId) return stamp
        if (armedTag && pendingBranchTagRef.current.get(sessionId) === armedTag) {
          pendingBranchTagRef.current.delete(sessionId)
          stamp.branchGroupId = armedTag.groupId
          stamp.branchIndex = armedTag.index
          store.getState().setSessionActiveBranch(sessionId, armedTag.groupId, replyId)
        }
        if (armedOwner && pendingBranchOwnerRef.current.get(sessionId) === armedOwner) {
          pendingBranchOwnerRef.current.delete(sessionId)
          stamp.branchOwnerId = armedOwner
        }
        return stamp
      }
      const rejectSend = (error?: unknown): boolean => {
        disarmBranch()
        if (!callOptions?.throwOnError) return inputReachedTranscript
        const diagnostic = sessionId
          ? useChatStore.getState().sessions[sessionId]?.errorDiagnostic
          : null
        throw error instanceof Error
          ? error
          : new Error(
              typeof error === "string"
                ? error
                : diagnostic?.message || diagnostic?.code || "chat_turn_not_accepted"
            )
      }
      if (!sessionId) {
        useChatStore.getState().setError(tInlineErr("noSession"))
        return rejectSend(tInlineErr("noSession"))
      }
      if (
        (typeof content === "string" && !content.trim()) ||
        (Array.isArray(content) && content.length === 0)
      ) {
        return rejectSend("empty_chat_turn")
      }

      if (refuseCapturedTurn(sessionId)) {
        rejectSend("session_turn_busy")
        throw new Error("session_turn_busy")
      }

      if (callOptions?.backgroundDelivery) {
        const { getDb } = await import("@/lib/db/schema")
        const db = getDb()
        const id = callOptions.backgroundDelivery.id
        const { currentFusionStore } = await import("@/lib/router-fusion/chat/store-provider")
        const [accepted, queued, squad, fusion] = await Promise.all([
          db.workSubmissions.get(chatSubmissionId(id)),
          db.mobileOutboundQueue.get(id),
          db.executionRuns.get(`execution:team:${id}`),
          currentFusionStore().then((fusionStore) => fusionStore.getRun(id)),
        ])
        const queuedHere =
          queued?.protocol === "host-state" &&
          Array.isArray(queued.payload.actions) &&
          queued.payload.actions.some(
            (action) => action?.sessionId === sessionId && action?.actionId === id
          )
        if (
          (accepted?.sessionId === sessionId && accepted.runId === id) ||
          queuedHere ||
          (squad?.sessionId === sessionId && squad.sourceId === id) ||
          (fusion?.sessionId === sessionId && fusion.runId === id)
        ) {
          callOptions.backgroundDelivery.onAccepted()
          return true
        }
      }

      const persistAttachments = async (message: UIMessage): Promise<UIMessage | null> => {
        try {
          return await persistMessageSessionAssets(sessionId, message)
        } catch (error) {
          store
            .getState()
            .setSessionDiagnostic(
              sessionId,
              toDiagnostic(error, { source: "chat", meta: { sessionId } })
            )
          rejectSend(error)
          return null
        }
      }

      const modelSelectionReady = async () => {
        try {
          await waitForModelSelection(sessionId)
          return true
        } catch (error) {
          store
            .getState()
            .setSessionDiagnostic(
              sessionId,
              toDiagnostic(error, { source: "chat", meta: { sessionId } })
            )
          rejectSend(error)
          return false
        }
      }
      if (!(await modelSelectionReady())) return false
      const sharedTarget = await getSession(sessionId)
      // A paused project runs nothing (ADR-0204): no brief, report, nudge or
      // typed message starts a turn in its coordinator or threads until the
      // project is resumed. Refused before anything reaches the transcript;
      // the paused banner above the composer carries Resume.
      if (isProjectRoleSessionPaused(sharedTarget)) {
        store
          .getState()
          .setSessionDiagnostic(
            sessionId,
            createDiagnostic("projectPaused", { source: "chat", meta: { sessionId } })
          )
        return rejectSend("project_paused")
      }
      const continuationMessages = selectVisibleMessages(
        store.getState().sessions[sessionId]?.messages ?? [],
        store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
      ).filter(
        (message) => continuationMessageId(message) !== callOptions?.sharedRequest?.messageId
      )
      const continuationSource = callOptions?.continuationOf
        ? lastUserMessage(continuationMessages)
        : undefined
      if (callOptions?.continuationOf) {
        const slice = store.getState().sessions[sessionId]
        if (
          !continuationSource ||
          (callOptions.sharedRequest && continuationSource
            ? continuationMessageId(continuationSource)
            : continuationSource?.id) !== callOptions.continuationOf ||
          !slice ||
          !canContinueChat({
            status: slice.status,
            messages: [continuationSource],
            diagnostic: slice.errorDiagnostic,
            errorMessage: slice.errorMessage,
            queued: isChatTurnQueued(sessionId),
          })
        ) {
          return rejectSend("continuation_no_longer_available")
        }
      }
      const turnRoute =
        readTurnRoute(continuationSource?.metadata) ?? callOptions?.turnRoute ?? null
      // An addressed turn that cannot run: refused with the reason, before
      // anything reaches the transcript.
      const refuseRoute = (route: TurnRoute, reason: string, detail?: string): boolean => {
        store.getState().setSessionDiagnostic(
          sessionId,
          createDiagnostic("turnRouteUnavailable", {
            source: "chat",
            ...(detail ? { message: detail } : {}),
            meta: { sessionId, extra: { handle: route.handle, reason } },
          })
        )
        return rejectSend(`turn_route_unavailable:${reason}`)
      }
      // Only a direct chat has a lane of its own to leave for one turn. The
      // composer never offers a route anywhere else; a programmatic send that
      // carries one is refused rather than run unrouted.
      if (turnRoute && !isRoutableSession(sharedTarget)) {
        refuseRoute(turnRoute, "unroutable-session")
        return false
      }
      // Route handles resolve to `agent` mentions over THIS conversation's
      // targets, the same list its `@` panel offered.
      const routeMentionTargets = routeTargetsFromStores(sharedTarget)
      // Only a NEW user turn is published to the shared transcript. The
      // internal re-entries (regenerate / routing fallback pass
      // `skipUserAppend`, the queue's replay passes `steerDrain`) already have
      // their user message on the server, so routing them here would append a
      // duplicate `message.created` and never run the turn they asked for.
      if (
        sharedTarget?.collaboration &&
        !callOptions?.sharedRequest &&
        !callOptions?.skipUserAppend &&
        !callOptions?.steerDrain
      ) {
        // A shared transcript publishes user parts to the server as they are,
        // so a native video would upload the file itself: always its sampled
        // payload here (the composer's gate says the same).
        const shared = enforceVideoDeliveryForRoute(content, callOptions?.attachmentManifest, {
          providerId: null,
          modelId: null,
          runtimeAdapter: null,
          protocol: null,
          supportsVideo: false,
          sharedCollaboration: true,
        })
        const sharedManifest = shared.manifest
        const message = makeUserMessage(shared.content, crypto.randomUUID(), sharedManifest)
        if (Array.isArray(shared.content)) {
          message.parts = shared.content.flatMap((block, index) =>
            block.type === "document"
              ? [
                  {
                    ...makeUserMessage(
                      [block],
                      undefined,
                      sharedManifest?.[index] ? [sharedManifest[index]] : undefined
                    ).parts[0],
                    ...(sharedManifest?.[index]
                      ? {
                          filename: sharedManifest[index].filename,
                          ...(sharedManifest[index].extractedContent
                            ? { extractedContent: sharedManifest[index].extractedContent }
                            : {}),
                          ...(sharedManifest[index].original
                            ? { attachmentOriginal: sharedManifest[index].original }
                            : {}),
                        }
                      : {}),
                    type: "file" as const,
                    mediaType: block.source.media_type,
                    url: `data:${block.source.media_type};base64,${block.source.data}`,
                  },
                ]
              : makeUserMessage(
                  [block],
                  undefined,
                  sharedManifest?.[index] ? [sharedManifest[index]] : undefined
                ).parts
          )
        }
        // A shared turn still cites what its chips/tokens named. The local row
        // is written by the sync projection of this very event, so the
        // citations must ride the event payload or no member — sender
        // included — ever gets a backlink.
        const sharedMentions = resolveTurnContextRefs(
          shared.content,
          chatMentionResolvers(routeMentionTargets),
          callOptions?.citations ?? selectComposerCitedRefs(store.getState(), sessionId)
        )
        const sharedMetadata = {
          ...(callOptions?.continuationOf
            ? {
                continuationOf: continuationSource
                  ? continuationMessageId(continuationSource)
                  : callOptions.continuationOf,
                ...(continuationRuntimeOf(continuationSource?.metadata)
                  ? { continuationRuntime: continuationRuntimeOf(continuationSource?.metadata) }
                  : {}),
              }
            : {}),
          ...(sharedMentions.length > 0 ? { mentions: sharedMentions } : {}),
          ...(callOptions?.promptPreamble ? { promptPreamble: callOptions.promptPreamble } : {}),
        }
        // A snapshot embedded in this message publishes the quoted
        // conversation's text to every member — including ones who could not
        // open the source. Warn once so the first send is an informed choice.
        if (
          !sharedReferenceWarnedSessions.has(sessionId) &&
          sharedMentions.some((ref) => ref.kind === "entity" && isTranscriptEntityRefId(ref.id))
        ) {
          sharedReferenceWarnedSessions.add(sessionId)
          toast.info(tCollab("shareReferencesLiveToast"))
        }
        const persistedMessage = await persistAttachments(message)
        if (!persistedMessage) return false
        await sendSharedSessionMessage(sharedTarget, {
          id: persistedMessage.id,
          parts: persistedMessage.parts,
          ...(Object.keys(sharedMetadata).length > 0 ? { metadata: sharedMetadata } : {}),
        })
        // Written while the session's run streams, the message also steers
        // that run — on this device or the holder's (ADR-0252 §5). It is in
        // the transcript either way; a steer that cannot land leaves it a
        // message, or the next run's input on the holder.
        const followUpText = steerTextOf(shared.content, sharedManifest?.length ?? 0)
        const steered = followUpText
          ? await steerSharedFollowUp(sessionId, {
              messageId: persistedMessage.id,
              content: followUpText,
            }).catch((error) => {
              console.warn("shared follow-up steer failed", error)
              return "none" as const
            })
          : ("none" as const)
        // A room that answers every human turn (ADR-0177 batch 5): ask for
        // this one, the way "Request AI" does, unless it steered a run that
        // is already answering. Read off the mirror the post just refreshed.
        if (shouldRequestSharedReply(await getSession(sessionId), steered)) {
          window.dispatchEvent(
            new CustomEvent("cognia:shared-request-ai", {
              detail: { sessionId, messageId: persistedMessage.id },
            })
          )
        }
        return true
      }

      // Concurrency cap backstop: never start a turn over the global execution
      // ceiling. The composer already disables send + shows the inline over-cap
      // notice; this guards programmatic sends too. A session that is already
      // streaming is a continuation and never blocked (the broker exempts it).
      // The cap now reflects the unified ExecutionBroker occupancy — headless
      // legs (scheduler / connector / workflow / team) included — not just the
      // renderer's streaming panels.
      if (getExecutionBroker().isAtCapacity("ai-turn", sessionId)) {
        console.warn("send blocked: concurrent stream cap reached", { sessionId })
        return rejectSend("concurrent_stream_cap_reached")
      }

      // Steer instead of restart: a fresh user turn while THIS session is still
      // streaming / awaiting approval must never re-enter the normal send path —
      // a same-session send during a live turn makes the sidecar
      // close-and-restart it (host `restartReason`), silently dropping its
      // context. Internal re-issues (regenerate / routing fallback) pass
      // `skipUserAppend`, and the queue's own replay passes `steerDrain`; both
      // bypass this.
      if (!callOptions?.skipUserAppend && !callOptions?.steerDrain) {
        const st = sessionStatusOf(sessionId)
        // A turn still waiting for its working tree has not started, but it is
        // this session's next turn all the same. A second send is a follow-up
        // to it, not a rival: sent through the normal path it would wait on the
        // same tree and then run with a transcript that predates the first
        // turn's reply.
        const turnQueued = isChatTurnQueued(sessionId)
        // A Host that takes no steering from this caller (an org member's
        // partition, P6) queues a message sent mid-turn itself and runs it
        // when the turn settles. Steered, it was refused; queued here, it
        // waited on a drain this client never sees for a turn it does not run.
        const hostQueuesFollowUps = !hostStateActionOfferedHere("turn.steer")
        if (
          !hostQueuesFollowUps &&
          (st === "streaming" || st === "awaiting_approval" || turnQueued)
        ) {
          if (turnRoute) {
            // A live follow-up can only reach the runtime already answering, and
            // queued follow-ups merge into one payload — neither can move a turn
            // to another runtime. Refused, not demoted to an unaddressed steer.
            // On the bus, not the session: the running turn keeps its status.
            dispatchDiagnostic(
              createDiagnostic("turnRouteWhileBusy", {
                source: "chat",
                meta: { sessionId, extra: { handle: turnRoute.handle } },
              }),
              undefined,
              personalSinkHost.sessionPersonalSinkContext(sessionId)
            )
            return rejectSend("turn_route_while_busy")
          }
          // Live and queued follow-ups carry content only, including while the
          // initial turn awaits admission and has not bound its runtime lane.
          if (opts) {
            try {
              const validationError = runtimeFeatureValidationError(opts)
              if (validationError) throw new Error(validationError)
              const [capability] = requestedRuntimeCapabilities(opts)
              if (capability) throw new AgentCapabilityError(capability, "steer")
            } catch (error) {
              dispatchDiagnostic(
                toDiagnostic(error, { source: "chat", meta: { sessionId } }),
                undefined,
                personalSinkHost.sessionPersonalSinkContext(sessionId)
              )
              throw error
            }
          }
          const text = steerTextOf(content, callOptions?.attachmentManifest?.length ?? 0)
          const blocks = steerBlocksOf(content, callOptions?.attachmentManifest?.length ?? 0)
          if (!text && blocks.length === 0) return false

          const optimistic = await persistAttachments(
            makeUserMessage(content, undefined, callOptions?.attachmentManifest)
          )
          if (!optimistic) return false

          // A new instruction supersedes the context the pending approvals
          // were asked under (Codex 0.154 parity): deny each through its own
          // channel so the waiter resolves, then let the turn continue under
          // the new instruction. The judge cache is re-armed too — a "safe"
          // verdict reached under the old instruction must not auto-approve
          // the retried command under this one. Awaited so the denial lands
          // before the steer text the model reads next.
          // An automation's message is a derived input (ADR-0252 §5): it is not
          // a new instruction, so it supersedes nothing, and it waits for the
          // turn boundary behind any person's follow-up instead of going live.
          const derivedProducer = callOptions?.automatedTurn
          if (!derivedProducer) {
            invalidateJudgeContext(sessionId)
            try {
              await supersedePendingApprovals(sessionId, { getExecutionHandle })
            } catch (err) {
              console.warn("approval supersede failed", err)
            }
          }

          // Show it immediately, in the user's own words. The model-facing
          // framing (`STEER_PREFIX`) is added only on the replay payload; the
          // transcript renders the original text via `stripSteerPrefix`. The
          // `steer` metadata rides along into Dexie so a restart can tell a
          // delivered follow-up from one that never arrived.
          const entryId = crypto.randomUUID()
          ;(await import("@/lib/chat/steer-runtime")).recordLocalPersonSteer(
            sessionId,
            entryId,
            localAuthorization
          )
          const steerMeta: SteerMessageMeta = { entryId, state: "queued" }
          // The normal send path's reference stamp, applied here too: a steer
          // still cites what its chips/tokens named, whether it is delivered
          // live, replayed from the queue, or never delivered at all.
          const steerMentions = resolveTurnContextRefs(
            content,
            chatMentionResolvers(routeMentionTargets),
            callOptions?.citations ?? selectComposerCitedRefs(store.getState(), sessionId)
          )
          ;(optimistic as { metadata?: Record<string, unknown> }).metadata = {
            ...((optimistic as { metadata?: Record<string, unknown> }).metadata ?? {}),
            steer: steerMeta,
            ...(steerMentions.length > 0 ? { mentions: steerMentions } : {}),
            ...(callOptions?.promptPreamble ? { promptPreamble: callOptions.promptPreamble } : {}),
            // Queued for a busy session, still an automation's (ADR-0239).
            ...(callOptions?.automatedTurn ? automatedTurnMetadata(callOptions.automatedTurn) : {}),
          }

          const externalAgentId = sessionExternalLane(sessionId)
          // A cascade or panel run takes no steer (ADR-0188 D19): the
          // follow-up waits in the queue and becomes the next turn.
          const fusionTurn = fusionChatTurnActive(sessionId)
          if (
            !derivedProducer &&
            !fusionTurn &&
            !turnQueued &&
            !externalAgentId &&
            text &&
            blocks.length === 0 &&
            !isStandaloneChatMode()
          ) {
            try {
              const queued = await enqueueHostStateIntentIfAvailable({
                sessionId,
                action: {
                  kind: "turn.steer",
                  text,
                  ...(steerMentions.length > 0 ? { mentions: steerMentions } : {}),
                  ...(callOptions?.promptPreamble
                    ? { promptPreamble: callOptions.promptPreamble }
                    : {}),
                },
              })
              if (queued) {
                appendSteerMessage(sessionId, optimistic)
                inputReachedTranscript = true
                mergeSteerWebSearchIntoLastSend(sessionId, callOptions?.webSearchContext)
                setSteerMessageState(sessionId, entryId, "accepted")
                return true
              }
            } catch (error) {
              store
                .getState()
                .setSessionDiagnostic(
                  sessionId,
                  toDiagnostic(error, { source: "chat", meta: { sessionId } })
                )
              return inputReachedTranscript
            }
          }
          appendSteerMessage(sessionId, optimistic)
          inputReachedTranscript = true

          // Live steer — the message reaches the model without ending the turn.
          // Two lanes, both best-effort: an external adapter implementing
          // turn/steer (Codex app-server), or the Anthropic sidecar's streaming
          // input. Acceptance means the sidecar queued it into the running
          // query, NOT that the model has already acted on it, so the bubble
          // says "accepted" until the turn settles. Anything else (unsupported
          // provider, input already closed, transport hiccup) falls through to
          // the durable queue below.
          //
          // `awaiting_approval` is included deliberately: a turn paused on a
          // tool prompt still holds its input open, and it is the moment when
          // redirecting matters most — the composer stays writable there for
          // exactly that reason.
          //
          // The lane comes from what THIS session dispatched
          // (`sessionExternalLane`), not the composer's global runtime pick,
          // which in split view describes whichever pane happens to be focused.
          const personalSteerAllowed =
            derivedProducer || fusionTurn || turnQueued
              ? false
              : await preparePersonalSteer(
                  sessionId,
                  localAuthorization,
                  externalAgentId
                    ? {
                        kind: "external",
                        sessionId: externalSessionLinkForSession(sessionId)?.sessionId,
                      }
                    : { kind: "builtin" },
                  (await import("@/lib/execution/direct-chat-run")).activeDirectChatExecutionRunId(
                    sessionId
                  )
                )
          if (
            !personalSteerAllowed &&
            externalAgentId &&
            !derivedProducer &&
            !fusionTurn &&
            !turnQueued
          ) {
            const link = externalSessionLinkForSession(sessionId)
            if (link && !link.host) {
              const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
              await getExternalAgentManager().closeSession(externalAgentId, link.sessionId)
            }
          }
          if (derivedProducer || fusionTurn || turnQueued || !personalSteerAllowed) {
            // Queued below: a verified run has no live input, and a turn that
            // has not been admitted has no input open at all.
          } else if (externalAgentId) {
            // Adapter steering carries text only (`turn/steer` takes a string),
            // so an attachment-only follow-up has to queue on this lane.
            if (text && blocks.length === 0) {
              try {
                const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
                const mgr = getExternalAgentManager()
                const link = externalSessionLinkForSession(sessionId)
                const remoteClient = link?.host
                  ? (
                      await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
                    ).createRemoteSessionOperationsClient({
                      stamp: link.host,
                      chatSessionId: sessionId,
                      externalSessionId: link.sessionId,
                    })
                  : undefined
                const canSteer =
                  link?.agentId === externalAgentId &&
                  (remoteClient
                    ? (
                        await remoteClient.getSessionOperationCapabilities(
                          externalAgentId,
                          link.sessionId
                        )
                      ).steering === "supported"
                    : mgr.supportsSteering(externalAgentId))
                if (link && canSteer) {
                  await (remoteClient ?? mgr).steerSession(externalAgentId, link.sessionId, text)
                  mergeSteerWebSearchIntoLastSend(sessionId, callOptions?.webSearchContext)
                  setSteerMessageState(sessionId, entryId, "accepted")
                  return true
                }
              } catch (err) {
                console.warn("live steer failed; queueing instead", err)
              }
            }
          } else {
            // Anthropic streaming input. `steerSession` is PII-gated and rejects
            // non-Anthropic providers sidecar-side, so a wrong-provider session
            // simply falls through to the queue. It takes the whole `content`,
            // so an attachment-only follow-up goes live here too.
            try {
              const handle = getExecutionHandle(sessionId)
              if (handle) await handle.steer(content)
              else {
                // The one steer entry (ADR-0252 §5): the sidecar's streaming
                // input, or the Squad run this conversation is holding for.
                const { steerRun } = await import("@/lib/execution/steer")
                const outcome = await steerRun({
                  target: { sessionId },
                  origin: "person",
                  content,
                })
                if (outcome.status !== "delivered") throw new Error(`steer ${outcome.status}`)
              }
              mergeSteerWebSearchIntoLastSend(sessionId, callOptions?.webSearchContext)
              setSteerMessageState(sessionId, entryId, "accepted")
              return true
            } catch (err) {
              console.warn("live steer failed; queueing instead", err)
            }
          }

          useChatStore.getState().enqueueSteer(sessionId, {
            id: entryId,
            text,
            blocks: blocks.length > 0 ? blocks : undefined,
            ...(callOptions?.attachmentManifest?.length
              ? {
                  attachmentManifest: callOptions.attachmentManifest.map(
                    ({ original: _original, ...entry }) => entry
                  ),
                }
              : {}),
            webSearchContext: callOptions?.webSearchContext,
            ...(callOptions?.replyTo ? { replyTo: callOptions.replyTo } : {}),
            // The queue copy rides a replay onto whichever writer persists the
            // row — locally redundant (the optimistic bubble has them) but the
            // only carrier when a remote drain rebuilds the turn.
            ...(steerMentions.length > 0 ? { citations: steerMentions } : {}),
            ...(callOptions?.promptPreamble ? { promptPreamble: callOptions.promptPreamble } : {}),
            ...(derivedProducer
              ? {
                  origin: "derived" as const,
                  derivedSource: "automation" as const,
                  automatedTurn: derivedProducer,
                }
              : {}),
          })
          return true
        }
      }

      if (!(await modelSelectionReady())) return false
      let session = await getSession(sessionId)
      assertSessionWritable(session, "send-message")
      // The lane THIS turn runs on, decided once. An addressed turn resolves
      // its route against the stores as they are now — a Codex disabled since
      // the pick refuses here, not mid-dispatch; every other turn runs on the
      // session's own lane. Every "which runtime" question below reads
      // `turnLane`, never the store again.
      const sessionLane = runtimeRefForSession(sessionId)
      let routeSnapshot: RouteContextSnapshot | null = null
      let routeLane: Extract<RouteLane, { ok: true }> | null = null
      if (turnRoute) {
        routeSnapshot = await snapshotRouteContext(sessionId, { session: session ?? null })
        const lane = resolveRouteLane(turnRoute.target, routeSnapshot)
        if (!lane.ok) {
          refuseRoute(turnRoute, lane.reason, lane.detail)
          return false
        }
        routeLane = lane
      }
      let turnLane: AgentRuntimeRef =
        routeLane?.runtimeRef ?? continuationRuntimeOf(continuationSource?.metadata) ?? sessionLane
      const isSessionAside =
        session?.kind === "resource-workbench" && session.surfaceBinding?.kind === "session"
      if (isSessionAside && session?.surfaceBinding?.kind === "session") {
        // The resolver chooses the safe lane and returns its exact decision.
        // Until then use the parent's runtime rather than the app-wide default.
        turnLane = runtimeRefForSession(session.surfaceBinding.sessionId)
      }
      // Explicit options bypass the builder; refuse before editor flushes,
      // prompt hooks or provider work on the selected external lane.
      if (!isSessionAside && opts && turnLane.kind !== "builtin" && opts.toolSurface !== "none") {
        try {
          await assertExternalRuntimeFeatureSupport(opts)
        } catch (error) {
          store
            .getState()
            .setSessionDiagnostic(
              sessionId,
              toDiagnostic(error, { source: "chat", meta: { sessionId } })
            )
          throw error
        }
      }
      // Claim imported history before summary generation or editor writes, so a
      // concurrent source watcher cannot replace the snapshot being continued.
      if (sessionId.startsWith("import:") && session?.importOwnership !== "native-bound") {
        await freezeImportedSession(sessionId)
      }

      // The turn is definitely running now, so make disk honest before the agent's
      // file tools read it. Those tools go straight to the filesystem, so a buffer
      // the user edited but never saved is invisible to them: the agent would
      // reason about stale content and its write would then clobber that work.
      // No-op when no project editor is mounted, which is the common case.
      const unflushed = await flushProjectEditorEdits()
      if (unflushed.length > 0) {
        // Proceed anyway — the turn may not touch these files at all — but say so,
        // because for those files disk is not what the user is looking at.
        toast.warning(
          tInlineErr("unflushedEditorBuffers", {
            count: unflushed.length,
            files: unflushed.join(", "),
          })
        )
      }

      let builtinHandoffContext: string | undefined
      if (
        session &&
        turnLane.kind === "builtin" &&
        (session.importOwnership === "native-bound" ||
          (session.branchSeed?.kind === "transcript" &&
            (sessionId.startsWith("import:") ||
              session.handoffSource === "cli" ||
              session.handoffSource === "thread-handoff")))
      ) {
        const { buildHandoffContext, prepareHandoffContext } =
          await import("@/lib/chat/handoff-context")
        const personalHistory = await preparePersonalHistory(
          sessionId,
          await listMessages(sessionId)
        )
        const history = personalHistory.messages
        const imported = session.importCanonicalState
        const state =
          imported && personalHistory.withheldMessageIds.length === 0
            ? {
                tasks: imported.tasks,
                plans: imported.plans,
                goals: imported.goals,
                checkpoints: imported.checkpoints,
                history: imported.history,
                interAgentMessages: imported.interAgentMessages,
              }
            : undefined
        const projected = buildHandoffContext(history, { state })
        if (projected.losses.some((loss) => loss.kind === "budget")) {
          const { buildAgentBackedLlmClient } =
            await import("@/lib/ai/generation/agent-backed-client")
          builtinHandoffContext = (
            await prepareHandoffContext(history, {
              state,
              client: await buildAgentBackedLlmClient({
                session,
                appSettings: useSettingsStore.getState().settings,
                featureId: "handoff",
                label: "Summarize task handoff",
              }),
            })
          ).text
        } else builtinHandoffContext = projected.text
        const patch = {
          sdkSessionId: undefined,
          sdkSessionStorage: undefined,
          forkedFromSdkSessionId: undefined,
          externalAgentSession: undefined,
          importOwnership: "cognia-owned" as const,
          importFrozen: true,
          branchSeed: builtinHandoffContext
            ? { kind: "transcript" as const, content: builtinHandoffContext }
            : undefined,
        }
        await updateSession(sessionId, patch)
        session = { ...session, ...patch }
        const {
          verifiedNativeResume: _verified,
          verifiedNativeResumeAgentId: _agentId,
          ...composition
        } = compositionForSession(sessionId)
        useAgentRuntimeStore.getState().setSessionComposition(sessionId, composition)
        await releaseExternalToolHost(sessionId)
      }
      const identityMessages = store.getState().sessions[sessionId]?.messages ?? []
      const chatRunId = store.getState().sessions[sessionId]?.runId ?? 0
      const executionRunId =
        callOptions?.backgroundDelivery?.id ?? runIdForTurn(sessionId, chatRunId)
      const turnIdentity = resolveChatTurnAttemptIdentity({
        sessionId,
        runId: executionRunId,
        messages: identityMessages,
        reuseLastUserTurn: Boolean(callOptions?.skipUserAppend || callOptions?.steerDrain),
        attempts: skillAttemptByTurnRef.current,
      })
      const frozenTurnId = callOptions?.backgroundDelivery?.id ?? turnIdentity.turnId
      const frozenAttemptId = turnIdentity.attemptId

      // ADR-0019 — a fresh user message while a goal is self-driving is
      // mid-course guidance: PAUSE the goal (rotates generationId + fires the
      // turn-driver abort) rather than terminating it; the user resumes with
      // `/goal resume`. The silent continuation dispatch passes
      // `skipUserAppend`, so it never trips this branch.
      if (!callOptions?.skipUserAppend) {
        const openGoal = await getGoalRuntime().getActiveGoalForSession(sessionId)
        if (openGoal) await getGoalRuntime().pauseGoal(openGoal.id)
        // Same posture for a self-paced /loop: a fresh user message is
        // mid-course guidance — pause rather than fight over the session.
        // Loop kick-offs and continuations pass `skipUserAppend`, so they
        // never trip this branch. Interval loops fire through the scheduler
        // and are unaffected by manual chatting.
        const openLoop = await getLoopRuntime().getActiveLoopForSession(sessionId)
        if (openLoop?.mode === "self_paced") {
          clearPendingLoopContinuation(openLoop.id)
          await getLoopRuntime().pauseLoop(openLoop.id)
        }
      }

      // Extract a plain-text version of the user message for twin RAG. The
      // multimodal path (array of blocks) reads the block the user typed, past
      // the attachments: an extracted document or an image's OCR is a text
      // block too, and `buildSendContent` puts them first. A turn with nothing
      // typed leaves userMessage undefined and the runtime falls back to the
      // no-context path.
      // The composer's context envelope is stripped: recall, routing and skill
      // intent must key off what the user ASKED, not off a referenced document
      // or a page of web results the app put in front of it.
      const sentAttachmentCount = callOptions?.attachmentManifest?.length ?? 0
      const rawTypedText =
        typeof content === "string"
          ? content
          : content.some((block, index) => index >= sentAttachmentCount && block.type === "text")
            ? userPromptText(content, sentAttachmentCount)
            : undefined
      const typedText = rawTypedText === undefined ? undefined : stripPromptPreamble(rawTypedText)
      // An addressed turn's `@codex` is an instruction to Cognia, not part of
      // the question the recall and routing legs key off.
      const userMessageText =
        typedText !== undefined && turnRoute
          ? (stripLeadingRouteToken(typedText, turnRoute.handle) as string)
          : typedText
      // Attachment kinds for the routing classifier: an image block implies a
      // vision requirement; a document block discriminates audio/video by its
      // declared media type. Text blocks never contribute a kind.
      const routingAttachmentKinds = Array.isArray(content)
        ? content
            .map((block) => {
              if (block.type === "image") return "image" as const
              if (block.type === "document") {
                const mediaType = block.source?.media_type ?? ""
                if (mediaType.startsWith("audio/")) return "audio" as const
                if (mediaType.startsWith("video/")) return "video" as const
                return "document" as const
              }
              return undefined
            })
            .filter((kind): kind is "image" | "audio" | "video" | "document" => kind !== undefined)
        : undefined
      // Host-state sends never stamp (ADR-0188 B1). Whether this turn will be
      // handed to the HostState host is foreseen here, before the options are
      // built, so a turn the Host takes is never sealed as a Router + Fusion
      // run nobody would create. Asked only while chat routing is on, so every
      // other send pays nothing; the hand-off below re-checks with the final
      // content and options.
      const hostStateForeseen =
        localAuthorization !== undefined &&
        !session?.characterId?.startsWith("vscode-chat:") &&
        !isSessionAside &&
        !opts &&
        routerFusionGate(useSettingsStore.getState().settings, "chat") === "on" &&
        hostStateSendEligible({
          pairedHost: turnsRunOnPairedHost(),
          personPartition: isMemberOnPartition(),
          fusionRun: false,
          routerFusionStamped: false,
          skipAppend: callOptions?.skipUserAppend === true || callOptions?.steerDrain === true,
          contentIsString: typeof content === "string",
          hasResourceContext: callOptions?.resourceContext !== undefined,
          attachmentCount: callOptions?.attachmentManifest?.length ?? 0,
          attachmentsAsRefs:
            isMemberOnPartition() &&
            memberTurnAttachments(
              content,
              callOptions?.attachmentManifest,
              0,
              getRuntimeSnapshot().host
            ).kind === "files",
          builtinLane: turnLane.kind === "builtin",
          addressed: Boolean(turnRoute),
          // The same test that decides below whether another runtime's replies
          // ride this turn's content.
          carriesForeignTurns:
            turnLane.kind === "builtin" &&
            builtinHandoffContext === undefined &&
            !callOptions?.skipUserAppend &&
            !callOptions?.sharedRequest &&
            !isStandaloneChatMode() &&
            unseenForeignTurns(
              selectVisibleMessages(
                store.getState().sessions[sessionId]?.messages ?? [],
                store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
              ),
              "builtin"
            ).length > 0,
          collaboration: Boolean(session?.collaboration),
          standalone: isStandaloneChatMode(),
        }) &&
        (await hostStateSessionIntentAvailable(sessionId).catch(() => false))
      // The Host may accept this turn after the final content is built.
      // Keep its local journal absent until that routing decision is final.
      callOptions?.onExecutionRunPrepared?.(executionRunId)
      let threadRunPrepared = false
      const prepareLocalRun = async (ownsDispatch = true) => {
        await ensureDirectChatExecutionRun({
          ownsDispatch,
          ...(session?.projectThread?.parentExecutionRunId
            ? { parentRunId: session.projectThread.parentExecutionRunId }
            : {}),
          ...(localAuthorization ? { localAuthorization } : {}),
          sessionId,
          runId: executionRunId,
          ...(session?.projectId ? { projectId: session.projectId } : {}),
        })
      }
      const resolveTurnSendOptions = (deferred = true) =>
        buildSendOptions(
          session,
          userMessageText,
          (spec) => {
            const existingHandle = getExecutionHandle(sessionId)
            if (existingHandle) {
              executionHandlesRef.current.set(sessionId, existingHandle)
              return
            }
            const handle = createAgentExecutionHandle(sessionId, spec)
            executionHandlesRef.current.set(sessionId, handle)
            executionHandleDirectory.register(handle)
          },
          {
            runId: executionRunId,
            turnId: frozenTurnId,
            attemptId: frozenAttemptId,
            ...(callOptions?.backgroundDelivery
              ? { backgroundDeliveryId: callOptions.backgroundDelivery.id }
              : {}),
          },
          routingAttachmentKinds?.length ? { attachmentKinds: routingAttachmentKinds } : undefined,
          // This controller creates the Router + Fusion run before dispatch.
          // An addressed turn runs exactly where it was addressed, so it is
          // never turned into a cascade or panel run.
          // Typed here, so the approval dialog for a schedule write is here too.
          // Only a turn a person typed (or regenerated) counts: goal/loop
          // continuations, plan steps and peer triggers re-send with
          // `skipUserAppend`, and a shared-queue drain is a collaborator's
          // request, not this user's.
          {
            ...(!deferred || turnRoute || isSessionAside || continuationSource
              ? {}
              : { routerFusionSurface: "chat" as const }),
            ...(hostStateForeseen ? { hostState: true } : {}),
            ...(deferred ? { deferExecutionRun: true } : { executionRunId }),
            localAuthorization: localChatRunAuthorization(callOptions),
            interactive:
              !callOptions?.sharedRequest &&
              (!callOptions?.skipUserAppend || Boolean(callOptions?.regenerateBranch)),
          },
          isSessionAside
            ? { runtimeRef: turnLane }
            : routeLane
              ? routeLane.member
                ? (() => {
                    // Answered AS the member: its persona, and its own model
                    // when it has one — for this turn only.
                    const character = routeCharacter(routeLane.member)
                    return {
                      runtimeRef: routeLane.runtimeRef,
                      character,
                      clearSessionModel: Boolean(character.model),
                    }
                  })()
                : { runtimeRef: routeLane.runtimeRef }
              : continuationSource
                ? { runtimeRef: turnLane }
                : undefined
        )
      let sendOptions: SendOptions
      try {
        sendOptions = (isSessionAside ? undefined : opts) ?? (await resolveTurnSendOptions())
        // Routing has selected a direct local turn. Admit its own identity before
        // credentials and hooks; Squad/Fusion/Host turns retain their own journals.
        const earlySquad = resolveTurnSquad({
          turnOverride:
            isSessionAside || turnRoute
              ? {
                  ...(callOptions?.compositionOverride ?? compositionForSession(sessionId)),
                  orchestration: "direct" as const,
                }
              : (callOptions?.compositionOverride ?? null),
          session,
        })
        if (
          session?.projectThread?.parentExecutionRunId &&
          !earlySquad.squadId &&
          !sendOptions.routerFusionRun &&
          !hostStateForeseen
        ) {
          await prepareLocalRun(false)
          threadRunPrepared = true
          const admittedOptions = await resolveTurnSendOptions(false)
          // Caller options retain their credential-bearing MCP map as on HEAD.
          sendOptions = opts && !isSessionAside ? opts : admittedOptions
        }
        // A recorded workspace on the session's Host wins; without one the
        // resolver's cwd stands.
        if (turnLane.kind === "builtin" && session?.hostBinding?.workspaceRoot) {
          sendOptions = { ...sendOptions, cwd: session.hostBinding.workspaceRoot }
        }
        if (turnLane.kind !== "builtin" && sendOptions.toolSurface !== "none") {
          await assertExternalRuntimeFeatureSupport(sendOptions)
        }
      } catch (err) {
        // RoutingNoCandidatesError (alias matched, every deployment down)
        // and any other resolver failure surface as the chat error instead
        // of an unhandled rejection.
        const error = err instanceof Error ? err : new Error(String(err))
        useChatStore
          .getState()
          .setSessionDiagnostic(
            sessionId,
            (await routerFusionSendDiagnostic(err, sessionId)) ??
              toDiagnostic(error, { source: "chat", meta: { sessionId } })
          )
        throw error
      }
      // Resolution rechecks current capabilities and the parent's effective
      // authority. Its final adapter is authoritative if those changed while
      // resolving, so a fallback must dispatch on the built-in lane too.
      if (isSessionAside) {
        turnLane = resolvedSessionAsideRuntime(sendOptions) ?? { kind: "builtin" }
      }
      if (
        isSessionAside &&
        asideProviderHistoryMode(sendOptions, isStandaloneChatMode()) === "unsupported"
      ) {
        store.getState().setSessionError(sessionId, tAside("unsupportedReadOnlyLane"))
        return rejectSend(tAside("unsupportedReadOnlyLane"))
      }
      if (isSessionAside) {
        // Native links are filtered by the session's runtime, not by this
        // function's local lane. Bind only the aside so later turns and live
        // steering can find its own session without borrowing its parent's.
        useAgentRuntimeStore.getState().setSessionRuntimeRef(sessionId, turnLane)
      }
      const asideToolCeiling =
        isSessionAside && turnLane.kind === "builtin" && sendOptions.permissionMode === "plan"
          ? new Set(sendOptions.allowedTools ?? [])
          : undefined
      if (builtinHandoffContext !== undefined) {
        // Explicit send overrides must not smuggle the external runtime handle
        // into the builtin SDK. The resolver may already have injected the seed.
        sendOptions = { ...sendOptions }
        delete sendOptions.resumeSessionId
        delete sendOptions.forkFromSessionId
        if (
          builtinHandoffContext &&
          !sendOptions.appendSystemPrompt?.includes(builtinHandoffContext)
        ) {
          sendOptions.appendSystemPrompt = [sendOptions.appendSystemPrompt, builtinHandoffContext]
            .filter(Boolean)
            .join("\n\n")
        }
      }
      sendOptions = {
        ...sendOptions,
        turnId: frozenTurnId,
        ...(sendOptions.execution
          ? {
              execution: {
                ...sendOptions.execution,
                identity: {
                  ...(sendOptions.execution.identity ?? {}),
                  sessionId,
                  runId: executionRunId,
                  turnId: frozenTurnId,
                  attemptId: frozenAttemptId,
                },
              },
            }
          : {}),
      }

      // A deny-all tool surface keeps every external agent off the turn (the
      // external lane cannot run without its tools, so an unaddressed turn
      // quietly stays builtin). An addressed turn must not: it asked for that
      // runtime, and answering it elsewhere is exactly what routing refuses.
      if (turnRoute && turnLane.kind !== "builtin" && sendOptions.toolSurface === "none") {
        refuseRoute(turnRoute, "no-tool-surface")
        return false
      }

      // Second half of the cap backstop above, run here because the provider is
      // only known once the send options resolve. The lane is a separate
      // admission dimension from the shared pool, so a pool with room says
      // nothing about it. Checked BEFORE the optimistic user append: without
      // this the send proceeds, posts the message, and then parks inside
      // `acquireChatLease` with no status flip, no explanation, and no cancel.
      if (
        getExecutionBroker().isAtCapacity("ai-turn", sessionId, sendOptions.provider) &&
        !getExecutionBroker().isAtCapacity("ai-turn", sessionId)
      ) {
        console.warn("send blocked: provider concurrency cap reached", {
          sessionId,
          provider: sendOptions.provider,
        })
        useChatStore
          .getState()
          .setSessionError(sessionId, tInlineErr("providerConcurrencyCapReached"))
        return rejectSend(tInlineErr("providerConcurrencyCapReached"))
      }

      if (callOptions?.webSearchContext) {
        sendOptions = { ...sendOptions, webSearchContext: callOptions.webSearchContext }
      }

      // ephemeralSkillIds were consumed by buildSendOptions; clear them so
      // the next turn starts with a fresh attachment set. Keyed by THIS
      // conversation — the bare projection is the focused pane, so a send from
      // a background pane read and cleared the other pane's attachments.
      if (selectComposerEphemeralSkillIds(useChatStore.getState(), sessionId).length > 0) {
        useChatStore.getState().clearEphemeralSkillIds?.(sessionId)
      }

      // Apply per-command frontmatter overrides set by the composer when the
      // user picked a custom slash command. Cleared after merge so the next
      // turn doesn't inherit them. Same per-conversation keying as above.
      const pending = selectComposerPendingCommandOverrides(useChatStore.getState(), sessionId)
      if (pending) {
        sendOptions = applyChatCommandOverrides(sendOptions, pending)
        useChatStore.getState().setPendingCommandOverrides(null, sessionId)
      }

      // Plugin PostToolUse (W3.1): only pay for the sidecar's
      // tool_result_review round-trip when a plugin actually listens. The
      // review events are answered in the `tool_result_review` case of the
      // message pump below.
      if (hasPostToolUseListeners()) {
        sendOptions = { ...sendOptions, toolResultReviewEnabled: true }
      }

      // Advisory daily-budget overage — the routing engine selected a provider
      // that is past its dailyCostBudget because nothing under budget was
      // available. Surface once per provider per local day; never blocks.
      notifyOverBudgetOnce(sendOptions.routingDecision?.overBudgetWarning, (v) =>
        tRouting("overBudgetToast", v)
      )

      // Advisory capability drop — the chosen reasoning effort was silently
      // dropped because the resolved model can't honour it. Surface once per
      // model so the setting doesn't vanish without feedback; never blocks.
      notifyDroppedCapabilityOnce(sendOptions.droppedCapabilityWarning, (v) =>
        tRouting("droppedEffortToast", v)
      )

      // Plugin opt-in — fire `onUserPromptSubmit` before the network call.
      // Block / modify / proceed semantics:
      //   • "block" — surface the plugin's reason as the chat error and bail.
      //   • "modify" — when the plugin returns `modifiedPrompt` and the
      //     content is plain text, replace it; multimodal content is left
      //     alone (mod APIs only describe text).
      //   • "modify" with `additionalContext` — fold into the appendSystemPrompt
      //     slot so the SDK passes it through as a system-prompt extension.
      // Errors bubble up as `proceed` (adapter-hooks swallows internally).
      // Native video, decided for real. The composer chose native from its
      // guess at the route; `sendOptions` is the route that will run. A native
      // payload that route cannot take is swapped for the sampled payload its
      // manifest carries before anything reads the content.
      const videoGuard = enforceVideoDeliveryForRoute(
        content,
        callOptions?.attachmentManifest,
        videoRouteFacts({
          providerId: sendOptions.provider,
          modelId: sendOptions.model,
          runtimeAdapter: sendOptions.execution?.runtimeAdapter,
          providerSettings: useSettingsStore.getState().settings?.providerSettings,
          customProviders: useSettingsStore.getState().settings?.customProviders,
          teamRoom: session?.kind === "team",
          sharedCollaboration: Boolean(session?.collaboration),
          standalone: isStandaloneChatMode(),
        })
      )
      const turnContent = videoGuard.content
      const turnManifest = videoGuard.manifest
      for (const downgrade of videoGuard.downgraded) {
        toast.info(
          tVideo("nativeDowngraded", {
            filename: downgrade.filename,
            reason: tVideo(`nativeReason.${downgrade.reason}` as never),
          })
        )
      }
      if (videoGuard.dropped > 0) {
        toast.warning(tVideo("nativeDropped", { count: videoGuard.dropped }))
      }

      let effectiveContent: SendContent = turnContent
      const hookExecution = await chatHookCredentialContext(
        sessionId,
        executionRunId,
        localAuthorization,
        session?.projectThread?.parentExecutionRunId
      )
      const promptText = userPromptText(turnContent, turnManifest?.length ?? 0)
      const promptDecision = await dispatchPluginUserPromptSubmit(
        promptText,
        sessionId,
        // Cast — the dispatcher's structural shape accepts any subset.
        {} as never,
        hookExecution
      )
      if (promptDecision.action === "block") {
        store.getState().setSessionDiagnostic(
          sessionId,
          createDiagnostic("promptBlockedByPlugin", {
            source: "plugin",
            message: promptDecision.reason ?? "",
            meta: { sessionId },
          })
        )
        return rejectSend(promptDecision.reason || "prompt_blocked_by_plugin")
      }
      if (promptDecision.action === "modify") {
        if (typeof promptDecision.modifiedPrompt === "string") {
          effectiveContent = rewriteUserPromptText(
            turnContent,
            promptDecision.modifiedPrompt,
            turnManifest?.length ?? 0
          )
        }
        const additionalContext = (promptDecision as { additionalContext?: string })
          .additionalContext
        if (typeof additionalContext === "string" && additionalContext.trim()) {
          const existing = sendOptions.appendSystemPrompt?.trim() ?? ""
          sendOptions = {
            ...sendOptions,
            appendSystemPrompt: existing
              ? `${existing}\n\n${additionalContext}`
              : additionalContext,
          }
        }
      }

      // Pipeline hook (W3.3): `onMessageSend` — plugins may rewrite the
      // outgoing user message. Same text-only constraint as `modifiedPrompt`;
      // attachments and non-text blocks are untouched. Runs AFTER
      // onUserPromptSubmit so a block decision wins over a rewrite.
      {
        const outboundText = userPromptText(effectiveContent, turnManifest?.length ?? 0)
        const piped = await dispatchPluginMessageSend(
          {
            id: `${sessionId}:outbound`,
            role: "user",
            content: outboundText,
          },
          hookExecution
        )
        if (typeof piped?.content === "string" && piped.content !== outboundText) {
          effectiveContent = rewriteUserPromptText(
            effectiveContent,
            piped.content,
            turnManifest?.length ?? 0
          )
        }
      }

      // New turn: drop any coalesced/debounced streaming work and the mirror
      // from a prior turn (this session only) so its events read the fresh
      // optimistic base. Other sessions' coalescing is untouched.
      registry.release(sessionId)
      messagesMirrorRef.current.delete(sessionId)

      // Regenerate re-parents the replies it replaces here, past every gate
      // above that can refuse the turn (the concurrency caps, an unroutable
      // lane, the plugin prompt guard), so a refused regenerate leaves the
      // thread exactly as it was. Every sibling after the anchor joins one
      // group (direct chat is one reply per turn) and stays reachable through
      // the BranchNavigator; the reply this turn produces takes the next slot.
      if (callOptions?.regenerateBranch) {
        const current = store.getState().sessions[sessionId]?.messages ?? []
        let anchorIdx = -1
        for (let i = current.length - 1; i >= 0; i--) {
          if (current[i].role === "user") {
            anchorIdx = i
            break
          }
        }
        // The thread moved on while the gates ran (another surface added a
        // turn, or the anchor was deleted). Tagging now would drop whatever
        // follows the anchor, and the re-issued content answers a question
        // that is no longer the last one.
        if (current[anchorIdx]?.id !== callOptions.regenerateBranch.anchorId) {
          return rejectSend("regenerate_anchor_moved")
        }
        const groupId = current[anchorIdx].id
        const { merged: tagged, nextIndexByGroup } = tagBranchSiblings(
          current,
          anchorIdx,
          () => groupId
        )
        // Re-running the turn is the retry of whatever the row recorded — a
        // failure, or a wait the app was closed during — so the mark goes. A
        // new failure writes its own.
        const merged = markTurnAdmission(tagged, groupId, null)
        store.getState().replaceSessionMessages(sessionId, merged)
        await persistMessages(sessionId, merged, {
          deleteIds: current
            .filter((message) => !merged.some((kept) => kept.id === message.id))
            .map((message) => message.id),
        })
        publishChatLifecycleEvent({ type: "chat-regenerated", sessionId, messageId: groupId })
        // `handleEvent` stamps the first assistant message that arrives with
        // this tag, and selects it.
        armedTag = { groupId, index: nextIndexByGroup.get(groupId) ?? 0 }
        pendingBranchTagRef.current.set(sessionId, armedTag)
      } else {
        // Any other turn never answers into a regenerate's group, whatever
        // path left a tag behind.
        pendingBranchTagRef.current.delete(sessionId)
      }

      // Optimistic user-message append. Skipped during regenerate so the
      // existing user anchor stays the single source of truth for that turn.
      // Base off this session's own slice — never the focused projection.
      const previousMessages = store.getState().sessions[sessionId]?.messages ?? []
      let userMsg = makeUserMessage(effectiveContent, frozenTurnId, turnManifest)
      if (callOptions?.backgroundDelivery?.personalRunIds)
        bindPersonalMessageRun(userMsg.id, callOptions.backgroundDelivery.personalRunIds)
      userMsg = {
        ...userMsg,
        metadata: {
          ...(userMsg.metadata as Record<string, unknown>),
          continuationRuntime: turnLane,
          ...(callOptions?.continuationOf ? { continuationOf: callOptions.continuationOf } : {}),
        },
      }
      // Structured mention capture: persist the message's inline `@…` tokens
      // as `metadata.mentions: ContextRef[]` so mentions are queryable without
      // regex re-parsing. Known subagent handles resolve to their kind; other
      // tokens fall back to `file` (the CLI's native reading of `@path`).
      // Markdown-agent handles need async discovery and resolve as `file`
      // here — a documented v1 narrowing, not a routing change (routing still
      // uses the full union in resolveTargetAgentId below).
      // Parsed from the TYPED text only. An `@path` inside a referenced message
      // or a fetched page is quoted material, not a mention this turn made —
      // `resolveTurnContextRefs` strips the envelope before scanning.
      // Chip-style picks (a staged remote document, a staged memory / issue /
      // plan / conversation / artifact) leave NO token behind, so re-parsing the
      // text can never recover them — `callOptions.citations` is their only
      // route in. Read before the composer clears it, which it does after
      // `onSend` resolves.
      const citedRefs =
        callOptions?.citations ?? selectComposerCitedRefs(store.getState(), sessionId)
      const mentionRefs = resolveTurnContextRefs(
        effectiveContent,
        chatMentionResolvers(routeSnapshot?.targets ?? routeMentionTargets),
        citedRefs
      )
      if (mentionRefs.length > 0) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          mentions: mentionRefs,
        }
      }
      if (callOptions?.promptPreamble) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          promptPreamble: callOptions.promptPreamble,
        }
      }
      if (callOptions?.templateRun) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          templateRun: callOptions.templateRun,
        }
      }
      if (turnRoute) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          turnRoute,
        }
      }
      if (callOptions?.replyTo) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          replyTo: callOptions.replyTo,
        }
      }
      const automatedProducer =
        callOptions?.automatedTurn ??
        (callOptions?.backgroundDelivery ? "background-result" : undefined)
      if (automatedProducer) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          ...automatedTurnMetadata(automatedProducer),
        }
      }
      // Edit-as-branch: the replacement joins the original's sibling group, and
      // is selected right away so the user sees their edit rather than watching
      // it disappear behind a previously-pinned sibling.
      if (callOptions?.branchTag) {
        ;(userMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...((userMsg as { metadata?: Record<string, unknown> }).metadata ?? {}),
          branchGroupId: callOptions.branchTag.groupId,
          branchIndex: callOptions.branchTag.index,
        }
        armedPick = {
          groupId: callOptions.branchTag.groupId,
          messageId: userMsg.id,
          previous:
            store.getState().sessions[sessionId]?.activeBranchByGroup[
              callOptions.branchTag.groupId
            ],
        }
        store
          .getState()
          .setSessionActiveBranch(sessionId, callOptions.branchTag.groupId, userMsg.id)
        // Everything this turn appends belongs to the replacement variant —
        // stamp it as the owner so the other sibling keeps its own tail.
        armedOwner = userMsg.id
        pendingBranchOwnerRef.current.set(sessionId, userMsg.id)
      } else if (callOptions?.branchOwnerId) {
        // A re-issued edit: the replacement row, its stamp and its pick are
        // already in place; only its replies still need the owner.
        armedOwner = callOptions.branchOwnerId
        pendingBranchOwnerRef.current.set(sessionId, callOptions.branchOwnerId)
      } else {
        // A normal send must never inherit the previous turn's owner.
        pendingBranchOwnerRef.current.delete(sessionId)
      }
      // Both flags mean "the user turn is already in the transcript": a
      // regenerate re-issues an existing one, a steer drain replays entries that
      // were appended optimistically when typed. Appending again would double
      // them. They diverge only on the *other* effects of a user turn — see
      // `steerDrain`'s doc on the option type.
      const skipAppend = callOptions?.skipUserAppend === true || callOptions?.steerDrain === true
      const persistedUserMessage = await persistAttachments(userMsg)
      if (!persistedUserMessage) return false
      userMsg = persistedUserMessage
      const next = skipAppend
        ? previousMessages
        : [
            ...(callOptions?.backgroundDelivery
              ? previousMessages.filter((message) => message.id !== userMsg.id)
              : previousMessages),
            userMsg,
          ]
      const displayContent = effectiveContent
      // The addressed runtime reads the question without the `@handle` that
      // addressed it; the transcript row above keeps what the user typed.
      // Past the attachments: an extracted document is a text block too, and
      // the handle is only ever in what the user typed.
      const routedContent = turnRoute
        ? stripLeadingRouteToken(displayContent, turnRoute.handle, turnManifest?.length ?? 0)
        : displayContent
      // Mixed-runtime history (`lib/chat/turn-route/history.ts`): the builtin
      // lane resumes its own SDK session, which never saw what another runtime
      // answered since its last reply. That part of the thread rides this turn,
      // in its content, so the SDK session keeps it on every later resume.
      // Not for a re-issued turn (its history is the one it already had), and
      // not for the standalone engine, which reads the whole transcript anyway.
      let foreignTurnsContext = ""
      if (
        turnLane.kind === "builtin" &&
        builtinHandoffContext === undefined &&
        !callOptions?.skipUserAppend &&
        !callOptions?.sharedRequest &&
        !isStandaloneChatMode()
      ) {
        const unseen = unseenForeignTurns(
          selectVisibleMessages(
            previousMessages,
            store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
          ),
          "builtin"
        )
        if (unseen.length > 0) {
          try {
            foreignTurnsContext = await foreignTurnsHandoffText(unseen, {
              sessionId,
              executionRunId,
              client: async () => {
                const { buildAgentBackedLlmClient } =
                  await import("@/lib/ai/generation/agent-backed-client")
                return buildAgentBackedLlmClient({
                  session,
                  appSettings: useSettingsStore.getState().settings,
                  featureId: "handoff",
                  label: "Summarize task handoff",
                })
              },
            })
          } catch (error) {
            // The handoff could not be made — a PII refusal above all — and the
            // turn fails with the reason, as a lane switch's handoff fails it.
            // The user row has not been added to the transcript yet.
            store
              .getState()
              .setSessionDiagnostic(
                sessionId,
                toDiagnostic(error, { source: "chat", meta: { sessionId } })
              )
            return rejectSend(error)
          }
        }
      }
      // The reply line goes to the provider only. The transcript row above
      // keeps the typed text and carries the reference in its metadata.
      let providerContent = prefixForeignTurnsContext(
        callOptions?.replyTo
          ? prefixReplyContext(routedContent, callOptions.replyTo)
          : routedContent,
        foreignTurnsContext,
        // A reply line leads the turn ahead of any files; the handoff joins it.
        callOptions?.replyTo ? 0 : (turnManifest?.length ?? 0)
      )
      if (isSessionAside && turnLane.kind !== "builtin") {
        providerContent = externalAsideTurnContent(
          providerContent,
          sendOptions.permissionMode === "plan"
        )
      }
      // Validate every later transform against the resolved grant; never repair
      // a widened SendOptions by patching it after the capability finalizer.
      if (
        asideToolCeiling &&
        sendOptions.allowedTools?.some((tool) => !asideToolCeiling.has(tool))
      ) {
        store.getState().setSessionError(sessionId, tAside("unsupportedReadOnlyLane"))
        return rejectSend(tAside("unsupportedReadOnlyLane"))
      }
      const shouldGateWorkbenchPayload =
        callOptions?.resourceContext !== undefined || isEmbeddedSession(session ?? {})
      // The transcript a provider reads whole (the standalone engine) gets every
      // reply line rebuilt from `metadata.replyTo`; `providerContent` above only
      // reaches a provider that reads the content of the turn being sent.
      const parentSlice =
        isSessionAside && session?.surfaceBinding?.kind === "session"
          ? store.getState().sessions[session.surfaceBinding.sessionId]
          : undefined
      const parentMessages = parentSlice
        ? (
            await preparePersonalHistory(
              sessionId,
              selectVisibleMessages(parentSlice.messages, parentSlice.activeBranchByGroup),
              {
                executionRunId,
                session:
                  session?.surfaceBinding?.kind === "session"
                    ? await getSession(session.surfaceBinding.sessionId)
                    : undefined,
              }
            )
          ).messages
        : []
      const inProgressMessageId =
        parentSlice &&
        (parentSlice.status === "streaming" || parentSlice.status === "awaiting_approval")
          ? parentMessages.findLast((message) => message.role === "assistant")?.id
          : undefined
      const seededFirstTurn =
        isSessionAside &&
        Boolean(session?.spawnedTask?.pendingPrompt) &&
        session?.lastMessageAt === undefined &&
        !session?.forkedFromSdkSessionId
      const cachedAsideContext = isSessionAside
        ? undefined
        : asideContextForRegenerate(
            lastResourceContextRef.current.get(sessionId),
            callOptions?.regenerateBranch?.anchorId
          )
      // Capture once at send time. The final SDK resume id is checked again
      // after transcript preparation, which may replace provider history.
      let resourceDelivery: AsideContextDelivery =
        cachedAsideContext ??
        (isSessionAside && !seededFirstTurn
          ? prepareAsideContext(parentMessages, {
              inProgressMessageId,
              parentClearedAt: session?.asideParentClearedAt,
            })
          : {
              context: callOptions?.resourceContext ?? "",
              header: isSessionAside ? ASIDE_REFERENCE_HEADER : "Current resource context",
            })
      const providerMessages = withWorkbenchMessageContext(
        withReplyContextLines(
          (await preparePersonalHistory(sessionId, next, { executionRunId, session })).messages
        ),
        resourceDelivery.context,
        resourceDelivery.header
      )
      const providerPayload = shouldGateWorkbenchPayload
        ? gateWorkbenchProviderPayload(
            { content: providerContent, sendOptions, messages: providerMessages },
            resourceDelivery.context,
            resourceDelivery.header
          )
        : { content: providerContent, sendOptions, messages: providerMessages }
      let withheldBackgroundParts: UIMessage["parts"] | undefined
      let personalAsideRequiresRebuild = false
      let personalAsideSourceDigest: string | undefined
      const unprojectedBackgroundContent = callOptions?.backgroundDelivery
        ? providerPayload.content
        : undefined
      if (callOptions?.backgroundDelivery) {
        // Squad/Fusion admit their own consuming run below. No caller or
        // originating child identity may stand in for that not-yet-admitted audience.
        const framed = await preparePersonalDerivedHistory(
          undefined,
          [{ ...userMsg, content: providerPayload.content }],
          { runIds: callOptions.backgroundDelivery.personalRunIds }
        )
        const publicHistory = await preparePersonalHistory(undefined, providerPayload.messages, {
          session,
        })
        providerPayload.content = framed.messages[0].content
        providerPayload.messages = publicHistory.messages.map((message) =>
          message.id === userMsg.id
            ? { ...message, parts: framed.messages[0].parts, metadata: framed.messages[0].metadata }
            : message
        )
      }
      if (callOptions?.sharedRequest) {
        providerPayload.messages = [makeUserMessage(turnContent)]
        providerPayload.content = turnContent
        // The room's instructions are the server's (ADR-0177 batch 5), and
        // the run host is whichever member holds the lease: every run reads
        // them, like a team room's members do.
        providerPayload.sendOptions = applySharedRoomInstructions(
          {
            ...providerPayload.sendOptions,
            resumeSessionId: undefined,
            forkFromSessionId: undefined,
            initialConversation: undefined,
          },
          session
        )
      }
      effectiveContent = providerPayload.content
      sendOptions = providerPayload.sendOptions
      // The turn as one string, read past the attachments rather than off the
      // first text block (see `externalTurnPrompt`), which is the extracted
      // document or OCR text whenever a file is attached. Every reader below
      // that takes a string picks one of the two: `request` where it wants
      // what the user asked (a label, a preview, the verifier's brief),
      // `prompt` where it is the only way the turn reaches whoever works on it
      // (the external lane, a Squad). A plain-string turn is both, whole.
      // Every provider step above only PREPENDS blocks to the turn's own (the
      // reply line, the resource context) or folds text into one, so the
      // difference in length is what sits in front of the attachments.
      const providerSourceContent = callOptions?.sharedRequest ? turnContent : routedContent
      const leadingCount =
        Array.isArray(effectiveContent) && Array.isArray(providerSourceContent)
          ? effectiveContent.length - providerSourceContent.length
          : 0
      let externalTurn = externalTurnPrompt(
        effectiveContent,
        turnManifest?.length ?? 0,
        leadingCount
      )
      // A sealed Router + Fusion turn (one the check before the build did not
      // foresee as host-state) is dispatched here, where its run is created:
      // host-state sends never stamp (ADR-0188 B1).
      // ADR-0253 §9: on a member's person partition the HostState intent is
      // the only write path. A turn it cannot carry is refused before any
      // row is written; it never falls through to a direct send the Host
      // would refuse after the user row was already kept here.
      const memberOnPartition = isMemberOnPartition()
      // ADR-0253 §9 G25: a member's files cross as uploads into their own
      // partition, and the intent names the refs. Decided here, on the final
      // content, so a turn whose files the Host cannot take is refused before
      // anything is written or uploaded.
      const memberAttachments = memberOnPartition
        ? memberTurnAttachments(
            effectiveContent,
            turnManifest,
            leadingCount,
            getRuntimeSnapshot().host
          )
        : ({ kind: "none" } as const)
      const hostStateFacts: HostStateSendFacts = {
        pairedHost: turnsRunOnPairedHost(),
        personPartition: memberOnPartition,
        fusionRun: Boolean(sendOptions.routerFusionRun),
        routerFusionStamped: Boolean(sendOptions.routerFusion),
        skipAppend,
        contentIsString: typeof effectiveContent === "string",
        hasResourceContext: callOptions?.resourceContext !== undefined,
        attachmentCount: turnManifest?.length ?? 0,
        attachmentsAsRefs: memberAttachments.kind === "files",
        builtinLane: turnLane.kind === "builtin",
        addressed: Boolean(turnRoute),
        carriesForeignTurns: Boolean(foreignTurnsContext),
        collaboration: Boolean(session?.collaboration),
        standalone: isStandaloneChatMode(),
      }
      const hostStateEligible =
        localAuthorization !== undefined &&
        sendOptions.execution?.runtimeAdapter !== "vscode-chat" &&
        !isSessionAside &&
        hostStateSendEligible(hostStateFacts)
      if (memberOnPartition && !hostStateEligible) {
        // Name the attachment as the reason only when it is the one thing in
        // the way: the same turn without files would have gone out.
        const attachmentRefused =
          memberAttachments.kind === "unsupported" &&
          memberAttachments.reason !== "shape" &&
          localAuthorization !== undefined &&
          sendOptions.execution?.runtimeAdapter !== "vscode-chat" &&
          !isSessionAside &&
          hostStateSendEligible({
            ...hostStateFacts,
            contentIsString: true,
            attachmentCount: 0,
          })
        store.getState().setSessionDiagnostic(
          sessionId,
          attachmentRefused
            ? createDiagnostic("memberAttachmentUnsupported", {
                source: "chat",
                meta: { sessionId, extra: { reason: memberAttachments.reason } },
              })
            : createDiagnostic("memberSendUnsupported", { source: "chat", meta: { sessionId } })
        )
        // A person's own send is thrown, so the composer gives the text (and
        // its attachments) back; an automated turn has no composer to return
        // to and is refused like any other.
        if (localAuthorization !== undefined) {
          disarmBranch()
          throw new Error("member_send_unsupported")
        }
        return rejectSend("member_send_unsupported")
      }
      if (hostStateEligible) {
        try {
          const enqueueIntent = memberOnPartition
            ? enqueueHostStateIntentWhenAvailable
            : enqueueHostStateIntentIfAvailable
          // Uploaded before the intent is queued: a ref must name bytes the
          // partition already holds, or the Host refuses the message.
          const attachmentRefs =
            memberAttachments.kind === "files"
              ? await uploadMemberTurnAttachments(sessionId, memberAttachments.files)
              : []
          const queued = await enqueueIntent({
            sessionId,
            ...(callOptions?.backgroundDelivery
              ? { actionId: callOptions.backgroundDelivery.id }
              : {}),
            action: {
              kind: "message.enqueue",
              messageId: userMsg.id,
              // A plain-string turn is the whole of it; a member's turn with
              // files is this text plus the files, which the Host extracts
              // from the uploaded originals.
              text: externalTurn.request,
              attachments: attachmentRefs,
              ...(mentionRefs.length > 0 ? { mentions: mentionRefs } : {}),
              ...(callOptions?.promptPreamble
                ? { promptPreamble: callOptions.promptPreamble }
                : {}),
            },
          })
          if (queued) {
            callOptions?.backgroundDelivery?.onAccepted()
            hostStateTurnsRef.current.add(sessionId)
            // The outbox transaction completed before this optimistic write.
            // Runtime dispatch, transcript persistence and authoritative title
            // updates now belong to HostStateService on every attached surface.
            store.getState().replaceSessionMessages(sessionId, next)
            inputReachedTranscript = true
            store.getState().setSessionError(sessionId, null)
            store.getState().setSessionStatus(sessionId, "streaming")
            lastUserContentRef.current.set(sessionId, {
              messageId: userMsg.id,
              content: displayContent,
              manifest: turnManifest,
            })
            emitSystemBusEvent(SystemEvents.MESSAGE_SENT, { sessionId })
            emitSystemBusEvent(SystemEvents.AGENT_STARTED, { sessionId })
            behaviorTurnStartedAt.set(sessionId, Date.now())
            void trackEvent("chat.message.sent", {
              sessionId,
              provider: sendOptions.provider ?? "host-state",
              surface: "chat",
            })
            return true
          }
        } catch (error) {
          store.getState().setSessionDiagnostic(
            sessionId,
            error instanceof HostStateChannelUnavailableError
              ? createDiagnostic("hostStateChannelUnavailable", {
                  source: "chat",
                  meta: { sessionId },
                })
              : error instanceof MemberAttachmentUploadError
                ? memberUploadDiagnostic(error, sessionId)
                : toDiagnostic(error, { source: "chat", meta: { sessionId } })
          )
          // A member's send has no other path: the composer must get it back.
          if (memberOnPartition) {
            disarmBranch()
            throw error
          }
          return rejectSend(error)
        }
      }
      if (!skipAppend) {
        store.getState().replaceSessionMessages(sessionId, next)
      }
      // A skipped append reuses a user turn already owned by the transcript.
      inputReachedTranscript = true
      // Register this chat turn with the global execution broker so it counts
      // toward — and is observable / cancellable via — the same governor as
      // every headless leg. Acquired before the `streaming` flip so the broker
      // watcher releases it on settle. Gated by BOTH `isAtCapacity` checks above
      // (shared pool, then the provider lane once the provider resolved), so it
      // admits immediately. Best-effort: a broker hiccup never blocks the turn
      // the user already committed to.
      // Resolved before the lease so the slot names the directory this turn
      // actually writes into. Best-effort: an unresolvable cwd means no slot,
      // which is what it was before any of this existed.
      const turnCwd =
        (turnLane.kind === "builtin" ? session?.hostBinding?.workspaceRoot : undefined) ??
        (await resolveEffectiveCwdForSession(session).catch(() => null))
      // The user message this turn belongs to — appended above, or already in
      // the transcript for a re-issued turn.
      const turnMessage = skipAppend ? turnMessageId(previousMessages) : userMsg.id
      let queuedTurnWrite: Promise<void> | null = null
      try {
        await acquireChatLease({
          sessionId,
          projectId: session?.projectId,
          label: session?.title || `#${sessionId.slice(0, 8)}`,
          // The working tree this turn will mutate. Two turns naming the same
          // tree are serialized; turns in different worktrees stay parallel.
          // The cap alone let two conversations bound to one checkout
          // interleave edits, builds and git operations in it.
          //
          // Keyed off the EFFECTIVE cwd — the same chain the send resolves —
          // not the execution binding alone. The binding is only the middle
          // link: two plain conversations in one workspace have no binding and
          // would have been left unserialized in the very directory they share.
          slotKey: slotKeyForTurn({
            executionContext: session?.executionContext,
            effectiveCwd: turnCwd,
          }),
          providerId: sendOptions.provider,
          providerLimit: sendOptions.providerConcurrencyLimit,
          // The broker is about to park this turn behind whatever holds its
          // working tree. Say so on the message itself, and write it through
          // now: a session switch or reload rehydrates from Dexie, and a
          // store-only message is exactly what vanished for minutes before.
          onQueued: (blocker) => {
            const queuedMeta: TurnAdmissionMeta = {
              state: "queued",
              waitingFor: waitFromBlocker(blocker),
              since: Date.now(),
            }
            const current = store.getState().sessions[sessionId]?.messages ?? next
            const marked = markTurnAdmission(current, turnMessage, queuedMeta)
            store.getState().replaceSessionMessages(sessionId, marked)
            queuedTurnWrite = persistMessages(sessionId, marked).catch((error: unknown) =>
              console.warn("queued turn persist failed", error)
            )
          },
        })
      } catch (leaseErr) {
        if (isQueuedChatTurnCancellation(leaseErr)) {
          // The user withdrew the message while it waited: the turn never ran,
          // so the message leaves the transcript (a re-issued turn keeps its
          // message and loses only the queued mark).
          await queuedTurnWrite
          const current = store.getState().sessions[sessionId]?.messages ?? next
          const withdrawn = skipAppend
            ? markTurnAdmission(current, turnMessage, null)
            : current.filter((message) => message.id !== userMsg.id)
          store.getState().replaceSessionMessages(sessionId, withdrawn)
          await persistMessages(sessionId, withdrawn, {
            deleteIds: skipAppend ? [] : [userMsg.id],
          }).catch((error: unknown) => console.warn("withdrawn turn persist failed", error))
          // Follow-ups typed while it waited were queued behind it; with it
          // gone they are the next turn.
          drainSteerVia(sessionId, ownedContinuationRef)
          return rejectSend("chat_turn_withdrawn")
        }
        console.warn("chat lease acquire failed; sending without admission", leaseErr)
      }
      if (queuedTurnWrite) {
        // Admitted. Settle the queued write first so it cannot land after the
        // turn's own transcript writes, then drop the mark from the row.
        await queuedTurnWrite
        const current = store.getState().sessions[sessionId]?.messages ?? next
        store
          .getState()
          .replaceSessionMessages(sessionId, markTurnAdmission(current, turnMessage, null))
      }
      // Clearing an error also sets idle. Do it before entering the active
      // state so workspace/broker settle subscribers see the actual turn end.
      store.getState().setSessionError(sessionId, null)
      const statusAnchor = callOptions?.sharedRequest
        ? previousMessages.find(
            (message) => continuationMessageId(message) === callOptions.sharedRequest!.messageId
          )?.id
        : callOptions?.regenerateBranch?.anchorId
      if (statusAnchor)
        store.getState().setSessionStatus(sessionId, "streaming", { turnMessageId: statusAnchor })
      else store.getState().setSessionStatus(sessionId, "streaming")
      if (session?.attachedChild) {
        void markAttachedSessionRunning(sessionId).catch((error) =>
          console.warn("attached session start state failed", error)
        )
      }
      chatTurnPerformance.begin(sessionId)
      lastUserContentRef.current.set(sessionId, {
        messageId: userMsg.id,
        content: displayContent,
        manifest: turnManifest,
      })
      if (shouldGateWorkbenchPayload)
        lastResourceContextRef.current.set(sessionId, {
          ...resourceDelivery,
          messageId: callOptions?.regenerateBranch?.anchorId ?? userMsg.id,
        })
      // Plugin bus: the turn has committed (past the prompt-submit block gate).
      // ids only — never the prompt text (PII red-line). Covers all run paths
      // (external + SDK) since this is upstream of the branch below.
      emitSystemBusEvent(SystemEvents.MESSAGE_SENT, { sessionId })
      emitSystemBusEvent(SystemEvents.AGENT_STARTED, { sessionId })
      if (!callOptions?.skipUserAppend) {
        behaviorTurnStartedAt.set(sessionId, Date.now())
        void trackEvent("chat.message.sent", {
          sessionId,
          provider: sendOptions.provider ?? (turnLane.kind === "builtin" ? "unknown" : "external"),
          surface: "chat",
        })
      }

      // ── Squad dispatch (ADR-0117 orchestration axis) ──
      // A conversation bound to a Squad hands the whole turn to the team
      // runtime instead of running one model turn here. Deliberately the same
      // primitive `action.team.run` and the IM lane use, so a Squad turn gets
      // the entire pipeline — skills, memory, twin, MCP, hooks, permission
      // ceiling, tool approval — rather than a second, thinner executor.
      //
      // It branches HERE, above the direct-chat bookkeeping, because that
      // bookkeeping (`startDirectChatExecutionRun`, the work-submission lease,
      // the assembly heartbeat) describes a single model turn. A Squad run has
      // its own execution run and would otherwise have to unwind machinery it
      // never wanted.
      //
      // The session stays `streaming` until the run settles — the same posture
      // `use-team-chat` takes for a multi-member turn. That is what makes a
      // follow-up typed mid-run queue as steering instead of starting a second
      // Squad over the top of the first.
      //
      // An addressed turn is one direct turn by definition, so it opts out of
      // the Squad binding (`resolveTurnSquad`: any non-team orchestration on
      // the turn override beats the session's Squad).
      const turnComposition =
        isSessionAside || turnRoute
          ? {
              ...(callOptions?.compositionOverride ?? compositionForSession(sessionId)),
              orchestration: "direct" as const,
            }
          : (callOptions?.compositionOverride ?? null)
      const squadDecision = resolveTurnSquad({
        turnOverride: turnComposition,
        session,
      })
      if (squadDecision.squadId) {
        const squadId = squadDecision.squadId
        try {
          const [{ startSquadRun }, { buildSquadStartInput }, { agentTeamExecutionRunId }] =
            await Promise.all([
              import("@/lib/squads/squad/start-squad-run"),
              import("@/lib/squads/squad/build-start-input"),
              import("@/lib/execution/agent-team-bridge"),
            ])
          const result = await startSquadRun(
            buildSquadStartInput({
              squadId,
              ...(callOptions?.backgroundDelivery
                ? { runId: callOptions.backgroundDelivery.id }
                : {}),
              // The goal is all the Squad is handed, so the whole turn: the
              // attached files' text, then the question.
              goal: externalTurn.prompt,
              surface: {
                kind: "chat",
                person: localAuthorization !== undefined,
                sessionId,
                ...(session ? { session } : {}),
                ...(session?.characterId ? { characterId: session.characterId } : {}),
              },
            })
          )
          if (!result.started || !result.runId) {
            store.getState().setSessionStatus(sessionId, "idle")
            store.getState().setSessionDiagnostic(
              sessionId,
              createDiagnostic(
                result.reason === "squad_not_found"
                  ? "squadNotFound"
                  : result.reason === "not_ready"
                    ? "squadNotReady"
                    : result.reason === "already_running"
                      ? "squadAlreadyRunning"
                      : "squadDispatchFailed",
                {
                  source: "chat",
                  meta: {
                    sessionId,
                    extra: {
                      squadId,
                      ...(result.blockers
                        ? { blockers: result.blockers.map((blocker) => blocker.code).join(",") }
                        : {}),
                      ...(result.reason === "already_running" && result.runId
                        ? { runId: result.runId }
                        : {}),
                    },
                  },
                }
              )
            )
            chatTurnPerformance.finish(sessionId, "failed")
            return rejectSend(result.reason || "squad_dispatch_failed")
          }
          callOptions?.backgroundDelivery?.onAccepted()
          // The goal is one string: images, a native video and fetched pages
          // did not reach the Squad. Said once the run takes it, and not for a
          // run that already existed, whose goal this turn did not set.
          if (!result.duplicate) {
            // A Squad's goal is text only: the turn's images stay behind too.
            warnUndeliveredAttachments(
              "squad",
              {
                omitted: externalTurn.omitted,
                withheld: externalTurn.images.length
                  ? [
                      {
                        reason: "agent",
                        attachments: externalTurn.images.map((image) => image.attachment),
                      },
                    ]
                  : [],
              },
              turnManifest
            )
          }
          // Leave the conversation's own record of the handoff, now rather
          // than when the run finishes. A Squad run takes minutes, and a
          // conversation that shows nothing for that long reads as broken.
          // The part carries identity only; everything else is live-queried
          // from the run, so this stays true after a reload instead of
          // freezing at whatever was known at dispatch.
          const squadMessageId = crypto.randomUUID()
          // The card is this turn's reply: a regenerate files it as the next
          // sibling, an edit as its variant's (`claimReplyBranch`).
          const squadBranch = claimReplyBranch(squadMessageId)
          const squadMessage: UIMessage = {
            id: squadMessageId,
            role: "assistant",
            parts: [
              {
                type: "squad-run",
                runId: agentTeamExecutionRunId(result.runId),
                squadId,
                squadName: result.squadName ?? squadId,
                // What the card names is what the user asked, not a file.
                objective: externalTurn.request,
              },
            ] as unknown as UIMessage["parts"],
            ...(Object.keys(squadBranch).length > 0 ? { metadata: squadBranch } : {}),
          }
          // Committed directly rather than through the per-session coalescer:
          // that exists to batch streaming deltas, and there is exactly one
          // message here. Routing it through the rAF debounce would only
          // delay the one thing the user is waiting to see.
          const withSquadMessage = [...next, squadMessage]
          store.getState().replaceSessionMessages(sessionId, withSquadMessage)
          await persistMessages(sessionId, withSquadMessage).catch(() => undefined)

          // Release the hold when the run ends, however it ends. Without this
          // the conversation would queue follow-ups forever.
          const { watchSquadRunSettlement } = await import("@/lib/squads/squad/watch-squad-run")
          const stopWatching = watchSquadRunSettlement({
            executionRunId: agentTeamExecutionRunId(result.runId),
            onSettled: (status) => {
              squadWatchersRef.current.delete(sessionId)
              store.getState().setSessionStatus(sessionId, "idle")
              chatTurnPerformance.finish(sessionId, status === "completed" ? "completed" : "failed")
            },
          })
          // One watcher per session: a previous Squad turn's watcher would
          // otherwise settle this one's hold when the old run finally lands.
          squadWatchersRef.current.get(sessionId)?.()
          squadWatchersRef.current.set(sessionId, stopWatching)
        } catch (error) {
          store.getState().setSessionStatus(sessionId, "idle")
          store.getState().setSessionDiagnostic(
            sessionId,
            toDiagnostic(error, {
              source: "chat",
              meta: { sessionId, extra: { squadId } },
            })
          )
          chatTurnPerformance.finish(sessionId, "failed")
          return rejectSend(error)
        }
        return true
      }

      // ── Router + Fusion cascade / panel (ADR-0188 B3) ──
      // The send pipeline stamped this turn as a verified run: the run, not a
      // sidecar stream, answers it. Like a Squad turn it branches above the
      // direct-chat bookkeeping, which describes a single model turn; the run
      // has its own ledger, budget and projection. Only a stamped send gets
      // here, and only while Router + Fusion chat is on.
      const fusionRun = sendOptions.routerFusionRun
      if (fusionRun) {
        let receiptResolve: () => void = () => {}
        const receipt = new Promise<void>((resolve) => {
          receiptResolve = resolve
        })
        const fusionTurn = runFusionChatTurn({
          ...(callOptions?.backgroundDelivery
            ? {
                onAccepted: () => {
                  callOptions.backgroundDelivery!.onAccepted()
                  receiptResolve()
                },
              }
            : {}),
          sessionId,
          stamp: fusionRun,
          messages: providerPayload.messages,
          userMessage: skipAppend
            ? null
            : (providerPayload.messages.find((message) => message.id === userMsg.id) ??
              (callOptions?.backgroundDelivery ? null : userMsg)),
          workspaceRoot: turnCwd,
          settings: useSettingsStore.getState().settings,
          // The answer is this turn's reply, written by the run rather than
          // streamed through `handleEvent`: it takes the armed slot here.
          claimReplyBranch,
          onSettled: (result) => {
            // A run that ended without an answer (refused, failed, stopped
            // before its seal) never claimed its regenerate slot or edit
            // owner, and no `session_ended` drops them on this lane.
            disarmBranch()
            const durationMs = finishBehaviorTurn(sessionId)
            if (durationMs !== undefined && result !== "cancelled") {
              void trackEvent(result === "completed" ? "chat.turn.completed" : "chat.turn.failed", {
                sessionId,
                provider: sendOptions.provider ?? "router-fusion",
                surface: "chat",
                durationMs,
                ...(result === "failed" ? { errorType: "router_fusion_run_failed" } : {}),
              })
            }
            // The same rule as a streamed turn's settle: a clean end drains the
            // queue, an armed interrupt drains it, a failure keeps it.
            if (result === "completed" || steerArmed.has(sessionId)) {
              drainSteerVia(sessionId, ownedContinuationRef)
            } else if (result === "failed") {
              markPendingSteersFailed(sessionId)
            }
          },
        })
        if (callOptions?.backgroundDelivery) await Promise.race([receipt, fusionTurn])
        return true
      }

      // ── Independent reviewer (ADR-0117 `verified-fresh-agent`) ──
      // Armed here, after the Squad branch and before any direct-path await,
      // so the watcher sees this turn's `streaming` state and settles on its
      // end whichever executor runs it (SDK, standalone engine or an external
      // agent). The verifier itself is a brand-new session with none of this
      // turn's context. A companion shell is refused with a reason rather
      // than left to hang, and the picker shows the same reason.
      const turnOrchestration =
        turnComposition?.orchestration ?? compositionForSession(sessionId).orchestration
      if (turnOrchestration === "verified-fresh-agent") {
        void import("@/lib/agent/composition/verified-fresh-agent")
          .then(({ armVerifiedFreshAgentFollowup }) =>
            armVerifiedFreshAgentFollowup({
              sessionId,
              // Its contract: the user's request, without attachments.
              request: externalTurn.request,
              cwd: turnCwd,
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              ...(session?.title ? { mainSessionTitle: session.title } : {}),
            })
          )
          .then((armed) => {
            if (!armed.armed) {
              console.warn("verified-fresh-agent follow-up not armed", armed.reason)
            }
          })
          .catch((error) => console.warn("verified-fresh-agent arm failed", error))
      }

      // A persisted execution context owns the chat's Task Workspace identity.
      // Repeated turns create versioned TaskRuns inside that same managed
      // worktree. The developer flag remains a compatibility path for sessions
      // created before execution contexts existed.
      // Repair a pre-existing managed context that was persisted with an empty
      // projectId before the creation path started stamping the real one. Doing
      // it here rather than in a Dexie upgrade covers the connector and
      // scheduler legs too, which never touch the UI.
      let executionContext = repairManagedContextProjectId(
        session?.executionContext,
        session?.projectId
      )
      const hasNoToolSurface = sendOptions.toolSurface === "none"
      // Read ONCE for the whole send. The store used to be consulted at three
      // separate points below, so a runtime switch part-way through a send
      // could be observed differently by each of them.
      const composerRuntimeRef = turnLane
      const manualExternal = !hasNoToolSurface && composerRuntimeRef.kind !== "builtin"
      // Who answers an addressed turn, stamped on the reply at seal (the
      // external seal below, and the builtin one through `setLastSend`).
      const routeStamp: MessageRunRouteStamp | undefined =
        turnRoute && routeLane
          ? buildRouteStamp(turnRoute, routeLane, {
              runtimes: routeSnapshot?.runtimes ?? [],
              ...(sendOptions.provider ? { providerId: sendOptions.provider } : {}),
            })
          : undefined

      // Resolve rule-based delegation before opening the Task Workspace and
      // adoption windows so their durable agent identity reflects the runtime
      // that will actually write the files.
      let delegation: import("@/lib/ai/agent/external/delegation-router").RoutingDecision | null =
        null
      if (
        !hasNoToolSurface &&
        !manualExternal &&
        !isSessionAside &&
        !callOptions?.skipUserAppend &&
        !callOptions?.bypassDelegation &&
        !continuationSource &&
        // An addressed turn already names who answers; a delegation rule
        // re-routing it would override the user's own choice.
        !turnRoute
      ) {
        try {
          const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
          const mgr = getExternalAgentManager()
          if (mgr.getConnectedAgents().length > 0) {
            mgr.setDelegationRules(useExternalAgentStore.getState().delegationRules)
            const [{ routeDelegation }, { redactText }] = await Promise.all([
              import("@/lib/ai/agent/external/delegation-router"),
              import("@cognia/redact"),
            ])
            // Rules route on the question; the agent is handed the whole turn.
            const decision = routeDelegation(
              {
                prompt: externalTurn.request,
                payload: externalTurn.prompt,
                context: { sessionId },
              },
              {
                checkDelegation: (t, c) => mgr.checkDelegation(t, c),
                redact: (text) => redactText(text),
              }
            )
            if (decision.shouldDelegate) delegation = decision
          }
        } catch (err) {
          console.error("delegation routing failed", err)
        }
      }
      // One ref for the turn: the lane the composer picked, or the local agent a
      // delegation rule chose. The router names an agent rather than a lane, so
      // the ref is built here rather than pushed into its contract.
      const turnRuntimeRef: AgentRuntimeRef | null = manualExternal
        ? composerRuntimeRef
        : delegation?.targetAgentId
          ? { kind: "external", agentId: delegation.targetAgentId }
          : null
      // The lane id. For a host run this is the configuration id, which is also
      // the agent id the host mounts it under, so everything keyed by "which
      // agent is this turn on" keeps working without a second field.
      //
      // A host selection used to answer `null` here, because this read the
      // local-agent field and a host lane leaves that empty. The turn was
      // therefore recorded as `agentKind: "in-app"` under the agent id
      // "built-in", and it registered a durable chat receipt that the comment
      // below explicitly says an external turn must not have.
      const routedExternalAgentId =
        turnRuntimeRef?.kind === "host"
          ? turnRuntimeRef.configId
          : turnRuntimeRef?.kind === "external"
            ? turnRuntimeRef.agentId
            : undefined
      // Delegation rules resolve after the user row is assembled. Keep the
      // actual runtime on that anchor so a generic continuation does not
      // re-evaluate prompt-matching rules and silently change agents.
      {
        const anchor = skipAppend ? lastUserMessage(previousMessages) : userMsg
        const actualRuntime: AgentRuntimeRef = turnRuntimeRef ?? { kind: "builtin" }
        if (
          anchor &&
          JSON.stringify(continuationRuntimeOf(anchor.metadata)) !== JSON.stringify(actualRuntime)
        ) {
          const metadata = {
            ...(anchor.metadata as Record<string, unknown>),
            continuationRuntime: actualRuntime,
          }
          const current = store.getState().sessions[sessionId]?.messages ?? []
          store.getState().replaceSessionMessages(
            sessionId,
            current.map((message) =>
              message.id === anchor.id ? { ...message, metadata } : message
            )
          )
          const { updateMessageMetadata } = await import("@/lib/db/messages")
          await updateMessageMetadata(sessionId, anchor.id, { continuationRuntime: actualRuntime })
        }
      }
      const adoptionAgentKind = routedExternalAgentId ? "external" : "in-app"
      // Whether this turn runs in THIS webview's standalone (BYOK) engine: no
      // sidecar, no host, and a tool catalog in which nothing opens a file
      // (`lib/ai/chat/standalone-tools.ts`). Read once, and the built-in
      // dispatch below branches on this same value, so the working-copy gate
      // and the executor it guards cannot disagree.
      //
      // `isStandaloneChatMode()` and not `hasHostRuntime()`: the question is
      // where the turn executes, and the host profile answers
      // "mobile-companion" for a phone in standalone mode, paired or not.
      const participantBinding =
        sendOptions.execution?.runtimeAdapter === "vscode-chat"
          ? sendOptions.execution.chatParticipant
          : undefined
      if (sendOptions.execution?.runtimeAdapter === "vscode-chat" && !participantBinding)
        throw new Error("Chat participant execution is missing its owner binding")
      if (
        participantBinding &&
        (requestedRuntimeCapabilities(sendOptions).length ||
          sendOptions.cwd ||
          sendOptions.allowedTools?.length ||
          sendOptions.pluginTools?.length ||
          (sendOptions.permissionMode && sendOptions.permissionMode !== "default"))
      ) {
        throw new Error(
          "Chat participant execution cannot satisfy native tool, workspace, or permission options"
        )
      }
      if (
        !manualExternal &&
        !delegation &&
        session?.characterId?.startsWith("vscode-chat:") &&
        !participantBinding
      )
        throw new Error("Chat participant options must be resolved again before sending")
      const standaloneEngineTurn =
        !participantBinding && !manualExternal && !delegation && isStandaloneChatMode()
      // A working copy exists for an executor that opens files in it. A
      // zero-tool turn has none, and neither has a standalone engine turn, so
      // for both the managed bundle, the turn lease and the project environment
      // below have no consumer. Demanding them anyway refused every rootless
      // chat in a plain browser or a standalone phone before its first token:
      // the managed workspace cannot be materialized there, and nothing would
      // have opened it. The durable `managed` identity is left untouched, so a
      // desktop that later receives the conversation materializes it as usual.
      //
      // A turn for an agent the paired Host owns runs on the Host, which picks
      // its own working directory: `external_agent_run_turn` carries none. A
      // working copy here would have no consumer either, and on a phone the
      // managed one cannot be materialized at all, so every rootless chat with
      // a Host agent was refused before it reached the Host.
      const hostOwnedExternalTurn = manualExternal && turnRuntimeRef?.kind === "host"
      const captureConfig =
        routedExternalAgentId && !hostOwnedExternalTurn
          ? (useExternalAgentStore.getState().agents[routedExternalAgentId] ??
            (await import("@/lib/ai/agent/external/manager"))
              .getExternalAgentManager()
              .getAgent(routedExternalAgentId)?.config)
          : undefined
      const captureSupport =
        routedExternalAgentId && !hostOwnedExternalTurn
          ? externalAgentWorkspaceCaptureSupport(captureConfig)
          : { available: true as const }
      const turnUsesWorkingCopy =
        !hasNoToolSurface &&
        !standaloneEngineTurn &&
        !hostOwnedExternalTurn &&
        captureSupport.available
      if (!hasNoToolSurface && executionContext?.location === "local") {
        sendOptions = { ...sendOptions, cwd: executionContext.projectRoot }
      }
      // ADR-0130 hard cost ceiling. Evaluated BEFORE any durable acceptance so
      // a refused overrun leaves no half-open run behind. Fails open on any
      // infrastructure error — the user asked for a spending limit, not for
      // their app to stop when Dexie hiccups.
      //
      // The synchronous pre-check keeps the default install (no ceiling
      // configured) on exactly the code path it had before: no extra await, no
      // Dexie read, nothing to pay for a feature that is switched off.
      //
      // A Router + Fusion turn skips it here (ADR-0188 D35): its run holds the
      // same budget remainder, and going over asks for a one-run grant instead.
      // Should the run then fault and the turn fall back to the original path,
      // the ceiling is checked just before dispatch.
      const budgetDecision =
        isCostBudgetConfigured() && !sendOptions.routerFusion
          ? await enforceCostBudget({
              ...(sendOptions.provider ? { providerId: sendOptions.provider } : {}),
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              runId: executionRunId,
            })
          : null
      if (budgetDecision && !budgetDecision.allowed) {
        store.getState().setSessionStatus(sessionId, "idle")
        store.getState().setSessionDiagnostic(
          sessionId,
          toDiagnostic(new Error("cost_budget_exceeded"), {
            source: "chat",
            // `extra` is `DiagnosticMeta`'s documented escape hatch for
            // subsystem-specific ids, and it takes scalars — hence the join
            // rather than the raw array.
            meta: {
              sessionId,
              extra: { blockedBy: budgetDecision.blockedBy.map((v) => v.scopeKey).join(",") },
            },
          })
        )
        chatTurnPerformance.finish(sessionId, "failed")
        await settleChatTurnForSession(sessionId, {
          outcome: "failed",
          errorCode: "cost_budget_exceeded",
        })
        return rejectSend("cost_budget_exceeded")
      }
      // Durable acceptance (ADR-0123), phase A. `effectiveContent` has been
      // final since the Workbench payload gate — plugin hooks, pipes and
      // redaction all ran before it, and nothing below reassigns it — so
      // freezing it here captures exactly what the model will be sent.
      // `sendOptions` is NOT final yet (cwd, task workspace and routing are
      // still to come), which is why the context is frozen separately, just
      // before dispatch. Returns null when the feature is off or no runtime
      // target is active, in which case the turn proceeds exactly as before.
      // External-agent turns use their own durable runtime. Register only the
      // built-in path here; otherwise a long external turn would leave a chat
      // submission with no replayable SendOptions and the outbox could race it.
      const durableReceipt =
        routedExternalAgentId || participantBinding
          ? null
          : await acceptChatTurn({
              parentRunId: session?.projectThread?.parentExecutionRunId,
              adoptPreparedRun: threadRunPrepared,
              ...(localAuthorization ? { localAuthorization } : {}),
              sessionId,
              runId: executionRunId,
              messageId: userMsg.id,
              content: effectiveContent,
              visibleMessageIds: next.map((message) => message.id),
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              ...(session?.issueId
                ? { workItemRef: { kind: "issue" as const, id: session.issueId } }
                : {}),
              // The user message lands in the SAME transaction as the submission.
              // Without this the row would still reach Dexie eventually, via the
              // debounced transcript writer — but a crash in between would leave a
              // submission whose message is not in the transcript, which is the
              // mirror image of the bug this feature exists to remove. A delta
              // upsert, not `persistMessages`: the latter treats omissions as
              // deletions and would wipe history we are not holding here.
              ...(skipAppend
                ? {}
                : { writeTranscript: () => commitMessageDelta(sessionId, { upserts: [userMsg] }) }),
            }).catch((error) => {
              // Never block a send on the ledger: the legacy path still runs.
              console.error("acceptChatTurn failed", error)
              return null
            })
      if (durableReceipt) callOptions?.backgroundDelivery?.onAccepted()
      // Durable acceptance owns the insert. Legacy/external turns create their
      // row here, after Squad/Fusion/HostState have taken their own branches.
      if (callOptions?.branchTag?.edit) {
        // The replacement must exist before observers see an edit. Legacy and
        // external-agent turns do not have acceptChatTurn's transcript writer.
        if (!durableReceipt) await commitMessageDelta(sessionId, { upserts: [userMsg] })
        publishChatLifecycleEvent({
          type: "message-edited",
          sessionId,
          messageId: callOptions.branchTag.edit.messageId,
          previousContent: callOptions.branchTag.edit.previousContent,
          content: userPromptText(effectiveContent, turnManifest?.length ?? 0),
        })
      }
      let dispatchClaim: Awaited<ReturnType<typeof claimChatTurnForDispatch>> = "legacy"
      let stopAssemblyHeartbeat = () => {}
      let durableLeaseLost = false

      /**
       * Refuse a turn that has already flipped the session to `streaming`.
       *
       * Eight call sites repeated this by hand, and each had to remember five
       * separate steps: terminal status, performance finish, work-submission
       * settle, assembly heartbeat, and — once the execution run has started —
       * finishing that run. A path that forgot one left the composer spinning
       * with nothing to press. One place means a refusal added tomorrow cannot
       * forget, and it is where the metric goes: these refusals emitted nothing
       * at all, so a workspace that refuses every send looked exactly like an
       * install nobody used.
       *
       * The execution lease is deliberately absent. It is released by the store
       * subscription in `lib/execution/chat-lease.ts` on any transition out of
       * an active status, which the `idle` flip below is; releasing here too
       * would give one lease two owners.
       *
       * `chat.turn.failed` rather than a new event name: the turn was accepted
       * and then failed, which is exactly what that event already means.
       */
      const markTurnFailed = async (diagnostic: CogniaDiagnostic): Promise<void> => {
        const current = store.getState().sessions[sessionId]?.messages ?? []
        const target = skipAppend
          ? turnMessageId(current)
          : current.some((message) => message.id === userMsg.id)
            ? userMsg.id
            : null
        if (!target) return
        const marked = markTurnAdmission(current, target, {
          state: "failed",
          code: diagnostic.code,
          ...(diagnostic.detail || diagnostic.message
            ? { detail: diagnostic.detail || diagnostic.message }
            : {}),
          at: Date.now(),
        })
        if (marked === current) return
        store.getState().replaceSessionMessages(sessionId, marked)
        await persistMessages(sessionId, marked).catch((error: unknown) =>
          console.warn("failed turn persist failed", error)
        )
      }
      const refuseTurn = async (input: {
        diagnostic: CogniaDiagnostic
        cause?: unknown
        /** Stable, low-cardinality reason. Doubles as the telemetry `errorType`. */
        errorCode: string
        /** True once `startDirectChatExecutionRun` has run for this turn. */
        finishRun?: boolean
      }): Promise<boolean> => {
        if (input.finishRun) await finishDirectChatExecutionRun(sessionId, "failed")
        store.getState().setSessionStatus(sessionId, "idle")
        store.getState().setSessionDiagnostic(sessionId, input.diagnostic)
        chatTurnPerformance.finish(sessionId, "failed")
        await settleChatTurnForSession(sessionId, {
          outcome: "failed",
          errorCode: input.errorCode,
        })
        releaseSkillLoadContext(sessionId)
        stopAssemblyHeartbeat()
        const durationMs = finishBehaviorTurn(sessionId)
        if (durationMs !== undefined) {
          void trackEvent("chat.turn.failed", {
            sessionId,
            surface: "chat",
            errorType: input.errorCode,
            durationMs,
            ...(sendOptions.provider ? { provider: sendOptions.provider } : {}),
          })
        }
        // The turn never ran. When its message is still in the transcript (a
        // refusal that rolled it back has nothing to mark), the row itself says
        // so — and keeps saying so after the banner is dismissed or the app is
        // reloaded — with its own retry.
        await markTurnFailed(input.diagnostic)
        // A plan step's turn is always dispatched with `skipUserAppend` (the
        // plan runtime wrote its message). A refused one halts the plan on the
        // step now, instead of leaving it `in_progress` for the watchdog; a
        // manual message's refusal never touches the plan.
        if (callOptions?.skipUserAppend) {
          await haltInSessionPlanOnTurnFailure({
            sessionId,
            cause: planHaltCauseForCode(input.diagnostic.code),
            detail: `${input.diagnostic.code}: ${input.diagnostic.detail || input.diagnostic.message || input.errorCode}`,
          })
        }
        return rejectSend(input.cause ?? (input.diagnostic.message || input.errorCode))
      }
      if (turnRuntimeRef) {
        try {
          await assertExternalRuntimeFeatureSupport(sendOptions)
        } catch (error) {
          return await refuseTurn({
            diagnostic: toDiagnostic(error, { source: "chat", meta: { sessionId } }),
            errorCode: "external_runtime_feature_unsupported",
            cause: error,
          })
        }
      }
      let abortStaleLocalRuntime = () => {}
      if (callOptions?.backgroundDelivery && !durableReceipt) {
        return await refuseTurn({
          diagnostic: toDiagnostic(
            new Error("background_delivery_durable_acceptance_unavailable"),
            { source: "chat", meta: { sessionId } }
          ),
          errorCode: "background_delivery_durable_acceptance_unavailable",
        })
      }
      if (durableReceipt) {
        dispatchClaim = await claimChatTurnForDispatch(executionRunId)
        if (dispatchClaim === "owned_elsewhere") {
          releasePreparedDirectChatExecutionRun(executionRunId)
          return true
        }
        if (dispatchClaim === "claimed") {
          stopAssemblyHeartbeat = startWorkSubmissionLeaseHeartbeat(
            chatSubmissionId(executionRunId),
            "live-chat",
            {
              onError: (error) => console.error("work submission lease renewal failed", error),
              onLeaseLost: () => {
                durableLeaseLost = true
                abortStaleLocalRuntime()
              },
            }
          )
        }
      }
      await prepareLocalRun()
      // The checkout is the one step before the turn lease that can run for
      // minutes on a large repository. Stop has already settled the turn as
      // cancelled by the time an aborted checkout returns, so that return ends
      // the send quietly instead of refusing the turn a second time.
      const checkoutAbort = new AbortController()
      checkoutAbortRef.current.set(sessionId, checkoutAbort)
      const forgetCheckoutAbort = () => {
        if (checkoutAbortRef.current.get(sessionId) === checkoutAbort) {
          checkoutAbortRef.current.delete(sessionId)
        }
      }
      const endStoppedCheckout = () => {
        forgetCheckoutAbort()
        releaseSkillLoadContext(sessionId)
        stopAssemblyHeartbeat()
        finishBehaviorTurn(sessionId)
      }
      let bundlePrimaryRootId: string | undefined
      let managedBundle: SessionBundleBinding["bundle"] | undefined
      let managedAliasesBySource: SessionBundleBinding["aliasesBySource"] | undefined
      if (turnUsesWorkingCopy && executionContext?.location === "managedWorktree") {
        const project = useProjectStore
          .getState()
          .projects.find((candidate) => candidate.id === executionContext?.projectId)
        if (!project) {
          return await refuseTurn({
            errorCode: "managed_project_unavailable",
            diagnostic: createDiagnostic("workspaceUnavailable", {
              source: "chat",
              message: tInlineErr("managedWorktreeUnavailable"),
              meta: { sessionId },
            }),
          })
        }
        try {
          const binding = await ensureSessionExecutionBundle({
            sessionId,
            credentialContext: localAuthorization
              ? { localAuthorization }
              : { sessionId, executionRunId: turnIdentity.runId },
            context: executionContext,
            project,
            signal: checkoutAbort.signal,
          })
          executionContext = binding.context
          bundlePrimaryRootId = binding.primaryLogicalRootId
          managedBundle = binding.bundle
          managedAliasesBySource = binding.aliasesBySource
          if (binding.acquired && binding.bundle.flatLayout) {
            toast.warning(
              tWorkspaceLayout("flat", {
                reason: tWorkspaceLayout(`reasons.${binding.bundle.flatLayout}`),
              })
            )
          }
          sendOptions = redirectSendToBundleAliases(sendOptions, binding, binding.aliasesBySource)
          await updateSession(sessionId, { executionContext })
        } catch (error) {
          if (checkoutAbort.signal.aborted) {
            endStoppedCheckout()
            return true
          }
          console.error("managed workspace bundle acquisition failed", error)
          return await refuseTurn({
            errorCode: "workspace_bundle_unavailable",
            diagnostic: createDiagnostic("workspaceBundleFailed", {
              source: "chat",
              message: error instanceof Error ? error.message : String(error),
              meta: { sessionId },
            }),
          })
        }
      }
      const boundWorkspaceRoot = executionContext
        ? resolveSessionWorkspaceRoot(executionContext)
        : undefined
      try {
        const sharedRun = await beginSharedSessionRun(session, executionRunId, {
          messageId: callOptions?.sharedRequest?.messageId ?? userMsg.id,
          parts: userMsg.parts,
          ...callOptions?.sharedRequest,
        })
        if (sharedRun.kind === "queued") {
          store.getState().setSessionStatus(sessionId, "idle")
          await settleChatTurnForSession(sessionId, { outcome: "cancelled" })
          stopAssemblyHeartbeat()
          return true
        }
        if (sharedRun.kind === "acquired") {
          sharedRun.setApprovalDecisionHandler(async (approval, decision) => {
            if (!sharedApprovalResponseRef.current)
              throw new Error("Shared approval response handler is unavailable")
            await sharedApprovalResponseRef.current(approval, decision)
          })
          sharedRun.setLeaseLostHandler(() => {
            durableLeaseLost = true
            abortStaleLocalRuntime()
            void (async () => {
              const handle = getExecutionHandle(sessionId)
              if (handle) await handle.interrupt()
              else await interruptSession(sessionId)
              await cancelRouterFusionTurn(sessionId)
            })().catch(() => undefined)
          })
        }
      } catch (error) {
        return await refuseTurn({
          errorCode: "shared_run_coordination_failed",
          diagnostic: toDiagnostic(error, { source: "chat", meta: { sessionId } }),
        })
      }
      try {
        await startDirectChatExecutionRun({
          ...(localAuthorization ? { localAuthorization } : {}),
          sessionId,
          runId: executionRunId,
          // The canonical log's `user-input` event, clipped from the front: the
          // question, which the files ahead of it would push out. The files
          // are on the user row in `messages`.
          ...(externalTurn.request ? { prompt: externalTurn.request } : {}),
          ...(session?.projectId ? { projectId: session.projectId } : {}),
          ...((boundWorkspaceRoot ?? sendOptions.cwd)
            ? { workspaceRoot: boundWorkspaceRoot ?? sendOptions.cwd }
            : {}),
        })
        const { enforceRunAuthorityOnSendOptions } = await import("@/lib/execution/run-authority")
        await enforceRunAuthorityOnSendOptions(
          executionRunId,
          sendOptions,
          sendOptions.runAuthority?.skills?.only
        )
      } catch (error) {
        return await refuseTurn({
          errorCode: "execution_run_start_failed",
          finishRun: true,
          diagnostic: toDiagnostic(error, { source: "chat", meta: { sessionId } }),
        })
      }
      try {
        if (isSessionAside && session?.surfaceBinding?.kind === "session") {
          await assertPersonalContextReaders(sessionId, sendOptions, executionRunId)
          const fresh = await buildPersonalAsideContext(
            sessionId,
            session.surfaceBinding.sessionId,
            executionRunId,
            { inProgressMessageId, parentClearedAt: session.asideParentClearedAt }
          )
          resourceDelivery = fresh.delivery
          personalAsideSourceDigest = fresh.visibilityDigest
          personalAsideRequiresRebuild = fresh.withheldMessageIds.length > 0
          if (personalAsideRequiresRebuild) await invalidateTranscriptRuntime(sessionId)
          sendOptions = { ...sendOptions, personalContextReadersDigest: fresh.readersDigest }
          effectiveContent = gateWorkbenchProviderPayload(
            { content: providerContent, messages: [], sendOptions },
            resourceDelivery.context,
            resourceDelivery.header
          ).content
          providerPayload.content = effectiveContent
          externalTurn = externalTurnPrompt(
            effectiveContent,
            turnManifest?.length ?? 0,
            Array.isArray(effectiveContent) && Array.isArray(providerSourceContent)
              ? effectiveContent.length - providerSourceContent.length
              : 0
          )
        }
        if (callOptions?.backgroundDelivery) {
          const filtered = await preparePersonalDerivedHistory(
            sessionId,
            [{ id: userMsg.id, content: unprojectedBackgroundContent ?? effectiveContent }],
            { executionRunId, runIds: callOptions.backgroundDelivery.personalRunIds }
          )
          effectiveContent = filtered.messages[0].content
          providerContent = effectiveContent
          providerPayload.content = effectiveContent
          if (filtered.withheldMessageIds.length) {
            withheldBackgroundParts =
              typeof effectiveContent === "string"
                ? [{ type: "text" as const, text: effectiveContent }]
                : effectiveContent.flatMap((block) =>
                    block.type === "text" ? [{ type: "text" as const, text: block.text }] : []
                  )
            providerPayload.messages = providerPayload.messages.map((message) =>
              message.id === userMsg.id ? { ...message, parts: withheldBackgroundParts! } : message
            )
          } else withheldBackgroundParts = undefined
          externalTurn = externalTurnPrompt(effectiveContent)
        }
        if (
          turnLane.kind === "builtin" &&
          builtinHandoffContext === undefined &&
          !callOptions?.skipUserAppend &&
          !callOptions?.sharedRequest &&
          !callOptions?.backgroundDelivery &&
          !isStandaloneChatMode()
        ) {
          const unseen = unseenForeignTurns(
            selectVisibleMessages(
              previousMessages,
              store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
            ),
            "builtin"
          )
          foreignTurnsContext = await foreignTurnsHandoffText(unseen, {
            sessionId,
            executionRunId,
            client: async () => {
              const { buildAgentBackedLlmClient } =
                await import("@/lib/ai/generation/agent-backed-client")
              return buildAgentBackedLlmClient({
                session,
                appSettings: useSettingsStore.getState().settings,
                featureId: "handoff",
                label: "Summarize task handoff",
              })
            },
          })
          providerContent = prefixForeignTurnsContext(
            callOptions?.replyTo
              ? prefixReplyContext(routedContent, callOptions.replyTo)
              : routedContent,
            foreignTurnsContext,
            callOptions?.replyTo ? 0 : (turnManifest?.length ?? 0)
          )
          effectiveContent = gateWorkbenchProviderPayload(
            { content: providerContent, sendOptions, messages: [] },
            resourceDelivery.context,
            resourceDelivery.header
          ).content
          providerPayload.content = effectiveContent
        }
      } catch (error) {
        return await refuseTurn({
          errorCode: "personal_history_preparation_failed",
          finishRun: true,
          diagnostic: toDiagnostic(error, { source: "chat", meta: { sessionId } }),
        })
      }
      const legacyWorkspaceEnabled = !executionContext && Boolean(sendOptions.cwd)
      if (
        turnUsesWorkingCopy &&
        executionContext?.location === "local" &&
        sendOptions.cwd &&
        !sendOptions.taskWorkspace &&
        (isTauri() || isCapacitor() || hasWebCompanionTarget())
      ) {
        try {
          await beginObservedTaskWorkspaceTurn({
            taskId: taskIdForMessage(
              skipAppend
                ? ([...previousMessages].reverse().find((message) => message.role === "user")?.id ??
                    userMsg.id)
                : userMsg.id
            ),
            sessionId,
            runId: executionRunId,
            executionRunId,
            turnId: userMsg.id,
            workspaceKey: `local:${sessionId}`,
            workspaceRoot: sendOptions.cwd,
            agentId: routedExternalAgentId ?? "built-in",
            agentKind: adoptionAgentKind,
            surface: "chat",
          })
        } catch (error) {
          markTaskWorkspaceTurnUnowned(sessionId, chatRunId)
          const beginFailure = error instanceof Error ? error.message : String(error)
          return await refuseTurn({
            errorCode: "task_workspace_unavailable",
            finishRun: true,
            // Sharing a folder with another run no longer refuses a turn
            // (ADR-0255). The one refusal left is a run whose agent was never
            // confirmed stopped, and `workspaceUnavailable` would advise
            // binding a folder that is already bound correctly.
            diagnostic: isExecutorStopUnconfirmedRefusal(error)
              ? createDiagnostic("workspaceStopUnconfirmed", {
                  source: "chat",
                  message: tInlineErr("workspaceStopUnconfirmed"),
                  detail: beginFailure,
                  meta: { sessionId },
                })
              : createDiagnostic("workspaceUnavailable", {
                  source: "chat",
                  message: beginFailure,
                  meta: { sessionId },
                }),
          })
        }
      }
      if (
        turnUsesWorkingCopy &&
        (executionContext?.location === "managedWorktree" || legacyWorkspaceEnabled)
      ) {
        if (executionContext?.location === "managedWorktree" && !boundWorkspaceRoot) {
          return await refuseTurn({
            errorCode: "managed_worktree_unavailable",
            finishRun: true,
            diagnostic: createDiagnostic("workspaceUnavailable", {
              source: "chat",
              message: tInlineErr("managedWorktreeUnavailable"),
              meta: { sessionId },
            }),
          })
        }
        const anchorMessage = skipAppend
          ? [...previousMessages].reverse().find((message) => message.role === "user")
          : userMsg
        const workspaceRoot = boundWorkspaceRoot ?? sendOptions.cwd!
        const taskEnvelope = {
          taskId:
            executionContext?.taskWorkspace.taskId ??
            taskIdForMessage(anchorMessage?.id ?? userMsg.id),
          sessionId,
          runId: executionRunId,
          executionRunId,
          turnId: anchorMessage?.id ?? userMsg.id,
          attemptId: frozenAttemptId,
          surface: "chat",
          agentId: routedExternalAgentId ?? "built-in",
          agentKind: adoptionAgentKind,
          workspaceRoot,
          ...(executionContext?.taskWorkspace.workspaceKey
            ? { workspaceKey: executionContext.taskWorkspace.workspaceKey }
            : {}),
        }
        const legacyBundle = legacyWorkspaceEnabled
          ? await (async () => {
              const { provisioningForWorkspaceRoot } =
                await import("@/lib/task-workspace/workspace-provisioning")
              const provisioning = await provisioningForWorkspaceRoot(workspaceRoot).catch(
                () => undefined
              )
              return acquireWorkspaceBundle(
                {
                  ownerType: "session",
                  ownerRef: sessionId,
                  environmentKind: "managed",
                  base: { kind: "workingState" },
                  roots: [
                    {
                      logicalRootId: "primary",
                      role: "primary",
                      sourceRoot: workspaceRoot,
                    },
                  ],
                  ...(provisioning ? { provisioning } : {}),
                },
                { signal: checkoutAbort.signal }
              )
            })().catch(() => null)
          : null
        // A failed legacy checkout falls back to the folder itself, which is
        // right for a failure and wrong for a Stop: the stopped turn must not
        // go on to run, isolated or not.
        if (checkoutAbort.signal.aborted) {
          endStoppedCheckout()
          return true
        }
        forgetCheckoutAbort()
        // Caught, unlike every other await in this block, because a throw here
        // escaped the send entirely: the composer's own catch logged it, the
        // session stayed `streaming` forever, and the status edge that settles
        // the turn's workspace run therefore never fired. The run stayed
        // `running` on the Host and the session's NEXT turn was refused for
        // good with "pipeline workspace is already active". A refusal both
        // settles the turn and puts the reason on screen.
        // The ending turn's id, read at the refusal rather than captured
        // earlier: the store's counter is the only thing that knows which turn
        // the settle edge is about to fire for.
        const markTurnUnowned = () => {
          const endingRunId = store.getState().sessions[sessionId]?.runId
          if (typeof endingRunId === "number") markTaskWorkspaceTurnUnowned(sessionId, endingRunId)
        }
        let bundleTurnLease: Awaited<ReturnType<typeof openWorkspaceBundleTurnLease>> = null
        try {
          bundleTurnLease =
            executionContext?.location === "managedWorktree" && managedBundle && bundlePrimaryRootId
              ? await openWorkspaceBundleTurnLease(managedBundle, bundlePrimaryRootId, taskEnvelope)
              : legacyBundle
                ? await openWorkspaceBundleTurnLease(legacyBundle, "primary", {
                    ...taskEnvelope,
                    base: { kind: "workingState" },
                  })
                : null
        } catch (error) {
          console.error("workspace turn lease failed", error)
          // This turn never got a working copy, so its refusal must not settle
          // the one the session already holds — which, when the refusal is
          // `isWorkspaceBusyRefusal`, is precisely the live turn that caused it.
          markTurnUnowned()
          const leaseFailure = error instanceof Error ? error.message : String(error)
          // Typed once, where the host's sentence enters: from here on the
          // refusal is a lease conflict on the working copy, with its holder.
          const conflict = isWorkspaceBusyRefusal(error) ? workingCopyConflict(error) : null
          return await refuseTurn({
            errorCode: "task_workspace_unavailable",
            finishRun: true,
            // Two codes, because the two refusals want opposite advice:
            // `workspaceUnavailable` tells the reader to bind a folder, which
            // is exactly wrong for a binding that is already correct and merely
            // held by a turn that has not finished.
            diagnostic: conflict
              ? createDiagnostic("workspaceBusy", {
                  source: "chat",
                  // The host's own sentence names an internal workspace key and
                  // says nothing to a reader, so the translated one is what
                  // `message` carries — it is mirrored onto the legacy
                  // `errorMessage` that the mobile toast and the OS session
                  // notification still render as prose. The host's words go to
                  // `detail`, under the card's raw disclosure.
                  message: tInlineErr("workspaceBusy"),
                  detail: leaseFailure,
                  meta: {
                    sessionId,
                    extra: {
                      leaseResource: conflict.resource,
                      ...(conflict.holder ? { leaseHolder: conflict.holder } : {}),
                    },
                  },
                })
              : createDiagnostic("workspaceUnavailable", {
                  source: "chat",
                  // For every other failure the host's sentence is the ONLY
                  // account of what went wrong, so it stays the message rather
                  // than being demoted into a disclosure.
                  message: leaseFailure,
                  meta: { sessionId },
                }),
          })
        }
        const taskLease = bundleTurnLease
        if (
          !taskLease &&
          (executionContext?.location === "managedWorktree" || legacyWorkspaceEnabled)
        ) {
          markTurnUnowned()
          return await refuseTurn({
            errorCode: "task_workspace_unavailable",
            finishRun: true,
            diagnostic: createDiagnostic("workspaceUnavailable", {
              source: "chat",
              message: tInlineErr("managedWorktreeUnavailable"),
              meta: { sessionId },
            }),
          })
        }
        sendOptions = { ...sendOptions, taskWorkspace: taskEnvelope }
        if (taskLease) {
          // The renderer already owns this bundle turn and its settlement.
          // This envelope asks the Host to acquire another workspace; sending
          // it again strands that second run after the bundle has settled.
          delete sendOptions.taskWorkspace
          sendOptions = bundleTurnLease
            ? redirectSendToBundleAliases(
                sendOptions,
                bundleTurnLease,
                // A turn lease hands back its bundle's own lease aliases. The
                // canonical bundle's are keyed by root id, which the binding
                // resolved to source paths; the legacy bundle has one root,
                // `workspaceRoot`, checked out at the primary alias.
                managedAliasesBySource ??
                  new Map([[workspaceRoot.trim(), bundleTurnLease.primaryAlias]])
              )
            : { ...sendOptions, cwd: taskLease.run.executionRoot }
          if (executionContext?.location === "managedWorktree") {
            const bound = bundleTurnLease
              ? bindExecutionBundleTurn(
                  executionContext,
                  bundleTurnLease.bundleTurnId,
                  taskLease.run.runId
                )
              : bindExecutionRun(executionContext, taskLease.run.runId)
            const active = transitionManagedWorktree(bound, "active", Date.now())
            void updateSession(sessionId, { executionContext: active }).catch((error) =>
              console.error("persist execution context failed", error)
            )
          }
        }
      }

      // Options may be prebuilt, and both the local binding and task lease can
      // replace their cwd. Admit the final working copy once, before setup or
      // either runtime launches. The refusal's status edge settles the acquired
      // task lease through the existing turn tracker.
      if (turnUsesWorkingCopy) {
        try {
          await ensureExecutionPortLease({
            cwd: sendOptions.cwd,
            sessionId,
            projectId: executionContext?.projectId || session?.projectId,
            executionContext,
          })
        } catch (error) {
          return await refuseTurn({
            errorCode: "workspace_port_lease_unavailable",
            finishRun: true,
            diagnostic: createDiagnostic("workspaceUnavailable", {
              source: "chat",
              message: error instanceof Error ? error.message : String(error),
              meta: { sessionId },
            }),
          })
        }
      }

      // The sandbox placement was bound while `resolveSendOptions` assembled
      // the envelope — before this turn knew where it would actually run. A
      // managed worktree only leases its bundle alias above, so re-bind against
      // the final cwd: the microVM preflight claims against `workspaceRoot`,
      // and the confine roots are measured from it. A no-op when the root did
      // not move, and it never throws.
      if (sendOptions.sandboxRuntimeRef) {
        const reboundRef = await sandboxSessionRuntime.rebindWorkspaceRoot(
          sendOptions.sandboxRuntimeRef,
          sendOptions.cwd
        )
        if (reboundRef !== sendOptions.sandboxRuntimeRef) {
          sendOptions = { ...sendOptions, sandboxRuntimeRef: reboundRef }
        }
      }

      if (turnUsesWorkingCopy && executionContext?.environmentId) {
        const environment = await getProjectEnvironment(executionContext.environmentId)
        if (!environment || environment.projectId !== executionContext.projectId) {
          return await refuseTurn({
            errorCode: "environment_unavailable",
            finishRun: true,
            diagnostic: createDiagnostic("environmentUnavailable", {
              source: "chat",
              message: tInlineErr("environmentUnavailable"),
              meta: { sessionId, extra: { environmentId: executionContext.environmentId } },
            }),
          })
        }
        // The repository's own `.cognia/workspace.json`, merged in when the
        // user has approved it. Resolved through the shared seam rather than
        // inline, so the trust gate cannot end up applied on only one of the
        // two run paths (the other is the scheduler executor).
        const environmentRoot = sendOptions.cwd ?? executionContext.projectRoot
        const resolvedEnvironment = await resolveEnvironmentForRun({
          environment,
          executionRoot: environmentRoot,
          surface: "interactive",
          ...(executionContext.projectId ? { projectId: executionContext.projectId } : {}),
        })
        const setup = await executeProjectEnvironment({
          environment: resolvedEnvironment.environment,
          credentialContext: { sessionId, executionRunId },
          executionRoot: environmentRoot,
          scope: executionContext.location,
          surface: "interactive",
          bypassOnFailure: callOptions?.bypassEnvironmentSetup,
        })
        if (!setup.success) {
          return await refuseTurn({
            errorCode: "environment_setup_failed",
            finishRun: true,
            diagnostic: createDiagnostic("environmentSetupFailed", {
              // The setup step's own words when it has them: it names the
              // failing command, which no generic label can.
              source: "chat",
              message: setup.error || tInlineErr("environmentSetupFailed"),
              meta: { sessionId, extra: { environmentId: executionContext.environmentId } },
            }),
          })
        }
      }

      // Code-adoption tracking (Phase 1): open a per-turn attribution window.
      // Fire-and-forget — must never block or disrupt the turn. `runId` is read
      // back from the store, whose streaming flip above bumped it for this turn.
      if (hostOwnedExternalTurn) {
        // The execution Host persists this turn; no renderer run is owned.
        markTaskWorkspaceTurnUnowned(sessionId, chatRunId)
      } else if (!hasNoToolSurface && captureSupport.available) {
        void beginCodeAdoptionTurn(sendOptions.cwd, {
          sessionId,
          runId: chatRunId,
          model: sendOptions.model ?? null,
          agentKind: adoptionAgentKind,
        })
      } else if (!hasNoToolSurface && !captureSupport.available) {
        markTaskWorkspaceTurnUnowned(sessionId, chatRunId)
        markCodeAdoptionTrackingUnavailable(
          sendOptions.cwd ?? "",
          {
            sessionId,
            runId: chatRunId,
            model: sendOptions.model ?? null,
            agentKind: adoptionAgentKind,
          },
          captureSupport.reason
        )
      }

      // ── External agent branch ──────────────────────────────────────────
      // When the user selected "external" runtime in the composer toolbar,
      // dispatch to the external agent manager instead of the Claude SDK
      // sidecar. The optimistic user-message stays in the store so the
      // composer reflects the send immediately; the assistant reply is
      // appended from the manager result when it lands.
      if (manualExternal || delegation) {
        return runExternalAgentTurn({
          store,
          tDiagnostics,
          tPiPackages,
          warnUndeliveredAttachments,
          activeRef,
          ownedContinuationRef,
          externalGatewayAbortRef,
          externalTurnSettlementsRef,
          externalToolHostsRef,
          releaseExternalToolHost,
          registry,
          transcriptFenceRef,
          opts,
          callOptions,
          sessionId,
          disarmBranch,
          claimReplyBranch,
          rejectSend,
          session,
          isSessionAside,
          chatRunId,
          executionRunId,
          sendOptions,
          turnManifest,
          previousMessages,
          userMsg,
          skipAppend,
          next,
          displayContent,
          personalAsideRequiresRebuild,
          personalAsideSourceDigest,
          externalTurn,
          executionContext,
          routeStamp,
          delegation,
          turnRuntimeRef,
          routedExternalAgentId,
          refuseTurn,
          boundWorkspaceRoot,
          takeArmedOwner: () => {
            const owner = armedOwner
            armedOwner = null
            return owner
          },
        })
      }
      // ── End external agent branch ──────────────────────────────────────

      // This turn runs on the built-in sidecar, so the session has no external
      // lane — clear any left by a previous turn before a follow-up reads it.
      setSessionExternalLane(sessionId, null)

      // Router + Fusion (ADR-0188): a run created for this turn is released when
      // the dispatch itself fails. A failure this turn already explained (a
      // refusal, the cost ceiling) carries its own diagnostic into the catch.
      let routerFusionAwaitingDispatch = false
      let explainedSendFailure: { code: string; diagnostic: CogniaDiagnostic } | null = null
      try {
        await persistMessages(sessionId, next)
        await touchSession(sessionId)
        // If the session has no title yet, derive one from the first prompt.
        // `titleAuto` marks the title as machine-set so the turn-complete path
        // may later upgrade it to an LLM-generated title (until the user
        // manually renames, which clears the flag).
        await applyInstantTitle(sessionId, displayContent)
        // Open an agent-trace span for this chat turn. The traceId / spanId
        // are echoed through SendOptions so the sidecar (and later, tool +
        // sub-agent spans) can attach as children. `endSpan` runs in the
        // result / error branches of `handleEvent` keyed off the cached
        // sendOptions, so the span is finalized regardless of which path
        // closes the turn.
        if (!sendOptions.spanId) {
          const handle = startSpan({
            operationName: "invoke_agent",
            providerName: "anthropic",
            sessionId,
            surface: "chat",
            requestModel: sendOptions.model,
            agentId: session?.characterId,
            metadata: sendOptions.provider ? { provider: sendOptions.provider } : undefined,
            // The question, as `buildSendOptions`' root span previews it: an
            // eval promoted from this trace takes the preview as its input.
            inputPreview: externalTurn.request || undefined,
          })
          sendOptions = {
            ...sendOptions,
            traceId: handle.traceId,
            spanId: handle.spanId,
            traceparent: toTraceparent({
              traceId: handle.traceId,
              rootSpanId: handle.spanId,
            }),
          }
        }
        if (!sendOptions.traceparent && sendOptions.traceId && sendOptions.spanId) {
          sendOptions = {
            ...sendOptions,
            traceparent: toTraceparent({
              traceId: sendOptions.traceId,
              rootSpanId: sendOptions.spanId,
            }),
          }
        }
        if (sendOptions.traceId && sendOptions.spanId) {
          useTaskWorkspaceStore
            .getState()
            .bindTrace(sessionId, sendOptions.traceId, sendOptions.spanId)
        }
        if (sendOptions.spanId && sendOptions.routingPlan) {
          const plan = sendOptions.routingPlan
          recordEvent(sendOptions.spanId, {
            name: "routing.plan",
            at: Date.now(),
            // One shared projection (lib/routing/plan-trace-attributes) — the
            // calibration pipeline reads this shape and a hand-written copy
            // here had already drifted once.
            attributes: routingPlanTraceAttributes(plan),
          })
          recordEvent(sendOptions.spanId, {
            name: "routing.attempt",
            at: Date.now(),
            attributes: {
              decisionId: plan.decisionId,
              attemptIndex: 0,
              providerId: plan.selected.providerId,
              modelId: plan.selected.modelId,
            },
          })
          if (plan.shadowComparison?.differs) {
            recordEvent(sendOptions.spanId, {
              name: "routing.shadow_diff",
              at: Date.now(),
              attributes: {
                decisionId: plan.decisionId,
                selectedProviderId: plan.selected.providerId,
                selectedModelId: plan.selected.modelId,
                shadowProviderId: plan.shadowComparison.selected.providerId,
                shadowModelId: plan.shadowComparison.selected.modelId,
              },
            })
          }
        }
        // Durable acceptance (ADR-0123), phase B. This is the last point at
        // which `sendOptions` is still changing — cwd, task workspace and
        // routing have all settled by now — so it is the only honest moment to
        // freeze the execution context. Write-once: on a retry the stored
        // bundle wins, which is what stops a replay from silently re-resolving
        // the project root against whatever the host looks like later.
        if (durableLeaseLost) return true
        // Router + Fusion (ADR-0188): create the run of a routed turn right
        // before dispatch, after every early return above. A send without the
        // stamp — every send while the switch is off — skips this block.
        if (sendOptions.routerFusion) {
          const fusionSend = await prepareRouterFusionSend({
            sessionId,
            options: sendOptions,
            reused: Boolean(opts),
            workspaceId: session?.projectId ?? null,
            settings: useSettingsStore.getState().settings,
          })
          if (fusionSend.kind === "refused") {
            explainedSendFailure = {
              code: "router_fusion_refused",
              diagnostic: await routerFusionRefusalDiagnostic({
                code: fusionSend.code,
                reasons: fusionSend.reasons ?? [],
                sessionId,
                ...(sendOptions.spanId ? { spanId: sendOptions.spanId } : {}),
              }),
            }
            throw new RouterFusionRefusalError(
              fusionSend.code,
              "Router + Fusion refused this turn."
            )
          }
          sendOptions = fusionSend.options
          routerFusionAwaitingDispatch = Boolean(sendOptions.routerFusion)
          // The run faulted and the turn takes the original path — including
          // the cost ceiling it skipped above.
          if (!sendOptions.routerFusion && isCostBudgetConfigured()) {
            const lateBudget = await enforceCostBudget({
              ...(sendOptions.provider ? { providerId: sendOptions.provider } : {}),
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              runId: executionRunId,
            })
            if (!lateBudget.allowed) {
              explainedSendFailure = {
                code: "cost_budget_exceeded",
                diagnostic: toDiagnostic(new Error("cost_budget_exceeded"), {
                  source: "chat",
                  meta: {
                    sessionId,
                    extra: { blockedBy: lateBudget.blockedBy.map((v) => v.scopeKey).join(",") },
                  },
                }),
              }
              throw new Error("cost_budget_exceeded")
            }
          }
        }
        await withTranscriptRuntimeLock(sessionId, async () => {
          sendOptions = await prepareTranscriptRuntimeSend(sessionId, sendOptions, {
            executionRunId,
            currentMessageId:
              callOptions?.regenerateBranch?.anchorId ??
              (skipAppend ? turnMessageId(previousMessages) : userMsg.id),
            // The AI SDK retained loop ignores new options. Rebuild aside runs
            // so permission changes take effect and full parent snapshots do not accumulate.
            replacesHistory: Boolean(
              callOptions?.branchTag ||
              callOptions?.regenerateBranch ||
              (isSessionAside &&
                !standaloneEngineTurn &&
                asideProviderHistoryMode(sendOptions, false) === "rebuild")
            ),
            skipHydration:
              standaloneEngineTurn ||
              Boolean(participantBinding) ||
              Boolean(callOptions?.sharedRequest),
            activeBranchByGroup:
              useChatStore.getState().sessions[sessionId]?.activeBranchByGroup ??
              session?.activeBranchByGroup,
          })
          // Early prompt assembly precedes direct-run admission. Reproject
          // with the admitted Host identity so an owner's own marked history
          // is restored for engines that consume the whole message list.
          const rebuildProviderMessages = async () =>
            gateWorkbenchProviderPayload({
              content: "",
              sendOptions,
              messages: withWorkbenchMessageContext(
                withReplyContextLines(
                  (
                    await preparePersonalHistory(
                      sessionId,
                      next.map((message) =>
                        withheldBackgroundParts && message.id === userMsg.id
                          ? { ...message, parts: withheldBackgroundParts }
                          : message
                      ),
                      { executionRunId, session }
                    )
                  ).messages
                ),
                resourceDelivery.context,
                resourceDelivery.header
              ),
            }).messages
          if (!callOptions?.sharedRequest) {
            providerPayload.messages = await rebuildProviderMessages()
          }
          const asideSdkTurn =
            isSessionAside &&
            asideProviderHistoryMode(sendOptions, standaloneEngineTurn) === "sdk-resume"
          if (isSessionAside && session?.surfaceBinding?.kind === "session") {
            const fresh = await buildPersonalAsideContext(
              sessionId,
              session.surfaceBinding.sessionId,
              executionRunId,
              asideSdkTurn && !seededFirstTurn
                ? {
                    cursor: session?.asideContextCursor,
                    resumeSdkSessionId: sendOptions.resumeSessionId,
                    inProgressMessageId,
                    parentClearedAt: session.asideParentClearedAt,
                  }
                : { inProgressMessageId, parentClearedAt: session.asideParentClearedAt }
            )
            if (fresh.visibilityDigest !== personalAsideSourceDigest) {
              await invalidateTranscriptRuntime(sessionId)
              throw new Error("personal_history_context_changed")
            }
            resourceDelivery = fresh.delivery
            effectiveContent = gateWorkbenchProviderPayload(
              { content: providerContent, messages: [], sendOptions },
              resourceDelivery.context,
              resourceDelivery.header
            ).content
            providerPayload.messages = await rebuildProviderMessages()
          }
          asideContextDispatchRef.current.get(sessionId)?.cancel()
          asideContextDispatchRef.current.delete(sessionId)
          const asideDispatch =
            asideSdkTurn && !callOptions?.regenerateBranch && resourceDelivery.cursor
              ? createAsideContextDispatch(
                  resourceDelivery.cursor,
                  (cursor) => advanceResourceAsideContextCursor(sessionId, cursor),
                  sendOptions.resumeSessionId,
                  sendOptions.turnId
                )
              : undefined
          if (asideDispatch) asideContextDispatchRef.current.set(sessionId, asideDispatch)
          await bindChatTurnContext({
            runId: executionRunId,
            context: {
              ...(sendOptions.cwd ? { cwd: sendOptions.cwd } : {}),
              ...(session?.projectId ? { projectId: session.projectId } : {}),
              ...(boundWorkspaceRoot ? { workspaceBindingRef: executionRunId } : {}),
              sendOptions,
            },
          })
          // Anything `project_history_search` deposited before this point belongs
          // to a turn that never landed (aborted, errored, or interrupted) — its
          // fold never ran to drain it. Clearing here rather than on the turn's
          // way out avoids racing the fold, and states the rule plainly: a turn
          // cites only what THIS turn read.
          clearProjectHistoryEvidence(sessionId)
          // Cache finalized options before dispatch. A host can settle the turn
          // inside the awaited dispatch, and turnComplete reads this exact row to
          // persist pre-search sources on the assistant reply.
          useChatStore.getState().setLastSend(sessionId, {
            content: effectiveContent,
            options: sendOptions,
            attemptIndex: 0,
            routingCommitted: false,
            ...(routeStamp ? { routeStamp } : {}),
          })
          // Armed BEFORE the dispatch, not after it. `sendPrompt` is awaited, and
          // a turn can settle inside that await (the host rejects the prompt, an
          // error or `sidecar_exited` frame is processed). The store subscription
          // that disarms only walks `watchdog.armed()`, so arming afterwards meant
          // the settle found nothing to disarm and the clock then ran against an
          // already-idle session — surfacing "the turn has gone silent" 90 seconds
          // later on a conversation that had finished. Arming first puts the
          // session in `armed()` before any frame can arrive.
          silenceWatchdogRef.current?.arm(sessionId)
          if (standaloneEngineTurn || participantBinding) {
            // Standalone (BYOK): run the turn in-renderer against the user's own
            // provider. Fire-and-forget like `sendPrompt` — streaming reaches the
            // store via the same event queue; the engine emits `session_ended`.
            const controller = new AbortController()
            abortStaleLocalRuntime = () => controller.abort()
            standaloneAbortRef.current.set(sessionId, controller)
            chatTurnPerformance.markDispatched(sessionId)
            const run = participantBinding
              ? runVscodeChatTurn({
                  executionRunId,
                  sessionId,
                  turnId: sendOptions.turnId ?? frozenTurnId,
                  characterId: `vscode-chat:${participantBinding.pluginId}:${participantBinding.participantId}`,
                  prompt: effectiveContent,
                  binding: participantBinding,
                  messages: providerPayload.messages,
                  emit: enqueueClaudeEvent,
                  signal: controller.signal,
                })
              : runStandaloneTurn({
                  executionRunId,
                  sessionId,
                  messages: providerPayload.messages,
                  sendOptions,
                  emit: enqueueClaudeEvent,
                  signal: controller.signal,
                })
            void run.finally(() => {
              if (standaloneAbortRef.current.get(sessionId) === controller) {
                standaloneAbortRef.current.delete(sessionId)
              }
            })
          } else {
            if (
              (sendOptions.execution?.runtimeAdapter ??
                (sendOptions.provider === "anthropic" || !sendOptions.provider
                  ? "claude-agent-sdk"
                  : "ai-sdk")) === "claude-agent-sdk"
            ) {
              const { sdkSessionStorageFromOptions } =
                await import("@/lib/ai/agent/execution/claude-sdk-options")
              await updateSession(sessionId, {
                sdkSessionStorage: sdkSessionStorageFromOptions(sendOptions),
              })
            }
            chatTurnPerformance.markDispatched(sessionId)
            // A paired host admits the turn under the id of the user row shown
            // here, so its copy of the transcript keeps the same row.
            const pairedMessage =
              turnMessage && turnsRunOnPairedHost() ? { messageId: turnMessage } : {}
            if (dispatchClaim === "claimed") {
              await sendPrompt(sessionId, effectiveContent, sendOptions, {
                commandId: chatSubmissionId(executionRunId),
                transcriptRuntime: "prepared",
                ...pairedMessage,
              })
            } else {
              await sendPrompt(sessionId, effectiveContent, sendOptions, {
                transcriptRuntime: "prepared",
                ...pairedMessage,
              })
            }
          }
          if (shouldGateWorkbenchPayload)
            lastResourceContextRef.current.set(sessionId, {
              ...resourceDelivery,
              messageId: callOptions?.regenerateBranch?.anchorId ?? userMsg.id,
            })
          await asideDispatch
            ?.dispatched()
            .catch((error) => console.error("Failed to acknowledge aside parent context", error))
        })
        // The host owns the turn now; its `session_ended` seals the run.
        routerFusionAwaitingDispatch = false
        if (durableLeaseLost) return true
        // The live handoff won this turn. Recording it keeps the periodic
        // pending-work sweep from dispatching the same accepted input again.
        await markChatTurnStarted(executionRunId)
        // Conversation-branching: consume the one-shot context seed now that
        // `resolveSendOptions` has injected it into this send's
        // `appendSystemPrompt`. Provider-agnostic once-only consumption — the
        // ai-sdk path may never capture an `sdkSessionId`, so we can't rely on
        // that gate alone. Fire-and-forget; failure just leaves the seed to be
        // (harmlessly) re-injected next turn.
        if (session?.branchSeed) {
          void clearBranchSeed(sessionId).catch((err) =>
            console.error("clearBranchSeed failed", err)
          )
          // Freeze-on-continue (ADR-0062): the user is now continuing an
          // imported session, so Cognia takes ownership — the fs-watch
          // re-import guard must stop mirroring source-side edits. This is the
          // exact first-continuation signal (imported sessions always carry a
          // `branchSeed`, consumed once here).
          if (sessionId.startsWith("import:") && session.importOwnership !== "native-bound") {
            void freezeImportedSession(sessionId).catch((err) =>
              console.error("freezeImportedSession failed", err)
            )
          }
        }
        // Least-busy signal: this turn is now in flight against the resolved
        // deployment; `session_ended` (any flavor) settles it.
        if (sendOptions.provider) {
          useInFlightStore
            .getState()
            .begin(sessionId, sendOptions.provider, { modelId: sendOptions.model })
        }
      } catch (err) {
        asideContextDispatchRef.current.get(sessionId)?.cancel()
        asideContextDispatchRef.current.delete(sessionId)
        const error = err instanceof Error ? err : new Error(String(err))
        const sendFailureCode = explainedSendFailure?.code ?? "send_failed"
        if (routerFusionAwaitingDispatch) {
          await abortRouterFusionSend(sessionId, sendOptions, error.message)
        }
        store.getState().setSessionDiagnostic(
          sessionId,
          explainedSendFailure?.diagnostic ??
            toDiagnostic(error, {
              source: "chat",
              meta: { sessionId, ...(sendOptions.spanId ? { spanId: sendOptions.spanId } : {}) },
            })
        )
        // Notify plugins; fire-and-forget — host already surfaced the error.
        void chatHookCredentialContext(
          sessionId,
          executionRunId,
          undefined,
          session?.projectThread?.parentExecutionRunId
        ).then((context) => dispatchPluginChatError(sessionId, error, context))
        // Local pre-sidecar failure — close the agent-trace span we just
        // opened so it doesn't dangle (no result event will ever land).
        if (sendOptions.spanId) {
          endSpan(sendOptions.spanId, {
            errorType: sendFailureCode,
            errorMessage: error.message,
          })
        }
        chatTurnPerformance.finish(sessionId, "failed")
        await finishDirectChatExecutionRun(sessionId, "failed", Date.now(), error.message)
        await settleChatTurnForSession(sessionId, {
          outcome: "failed",
          errorCode: sendFailureCode,
        })
        stopAssemblyHeartbeat()
        const durationMs = finishBehaviorTurn(sessionId)
        if (durationMs !== undefined) {
          void trackEvent("chat.turn.failed", {
            sessionId,
            surface: "chat",
            errorType: "send_failed",
            durationMs,
            ...(sendOptions.provider ? { provider: sendOptions.provider } : {}),
          })
        }
        return rejectSend(error)
      }
      return true
    },
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
    async (sessionId: string, hostStateAbortQueued: boolean): Promise<void> => {
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
    },
    [getExecutionHandle]
  )

  const stop = useCallback(
    async (targetSessionId?: string) => {
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
    },
    [store, registry, abortRunningTurn, tSteer]
  )

  // "Interrupt & steer now": cut the running turn short so its settle replays
  // the queued steer immediately, instead of waiting for the turn to finish.
  // Arming covers the case where the abort surfaces as an errored
  // `session_ended`. No-op when nothing is queued.
  const interruptAndSteer = useCallback(
    async (targetSessionId?: string) => {
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
          .setSessionDiagnostic(
            sessionId,
            toDiagnostic(err, { source: "chat", meta: { sessionId } })
          )
      }
    },
    [store, abortRunningTurn, refuseCapturedTurn]
  )

  // Replay a session's queued steer NOW, without a turn boundary. Used by the
  // Run Panel after an errored settle, where the queue is preserved but no
  // settle event is coming — `interruptAndSteer` can't help (nothing to
  // interrupt), so we drain directly. No-op when the queue is empty.
  const flushSteer = useCallback(
    (targetSessionId?: string) => {
      const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
      if (!sessionId) return
      if (refuseCapturedTurn(sessionId)) return
      drainSteerVia(sessionId, sendRef)
    },
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
    async (sessionId: string) => {
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
        const { clearSessionBypass } =
          await import("@/lib/ai/agent/execution/hitl/approval-registry")
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
    },
    [registry, getExecutionHandle, executionHandleDirectory, releaseExternalToolHost]
  )

  const compact = useCallback(
    async (sessionId: string) => {
      const handle = getExecutionHandle(sessionId)
      if (handle) await handle.compact()
      else await compactSession(sessionId)
    },
    [getExecutionHandle]
  )

  const setModel = useCallback(
    async (sessionId: string, model: string) => {
      const handle = getExecutionHandle(sessionId)
      if (handle) await handle.setModel(model)
      else await setSessionModel(sessionId, model)
    },
    [getExecutionHandle]
  )

  const resetRuntime = useCallback(
    async (sessionId: string) => {
      const handle = getExecutionHandle(sessionId)
      try {
        if (handle) await handle.cancel()
        else await closeSession(sessionId)
      } finally {
        executionHandlesRef.current.delete(sessionId)
        executionHandleDirectory.unregister(sessionId, handle)
      }
    },
    [getExecutionHandle, executionHandleDirectory]
  )

  const rewindFiles = useCallback(
    async (sessionId: string, checkpointId: string, dryRun: boolean) => {
      const handle = getExecutionHandle(sessionId)
      if (!handle) throw new Error("checkpoint execution handle is unavailable")
      const result = await handle.rewindFiles(checkpointId, { dryRun })
      if (!dryRun) {
        await refreshGitStatus(useGitStore.getState().rootDir).catch(() => undefined)
      }
      return result
    },
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
