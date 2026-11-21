"use client"

import type React from "react"
import * as personalSinkHost from "@/lib/execution/personal-sink"
import { drainSteerVia } from "./agent-chat-events"
import { runExternalAgentTurn } from "./agent-chat-external-turn"
import {
  assertPersonalContextReaders,
  buildSendOptions,
  preparePersonalSteer,
  prepareTranscriptRuntimeSend,
} from "./agent-chat-send-options"
import { behaviorTurnStartedAt, finishBehaviorTurn } from "./agent-chat-tool-hooks"
import {
  applyChatCommandOverrides,
  asideContextForRegenerate,
  asideProviderHistoryMode,
  buildPersonalAsideContext,
  chatHookCredentialContext,
  externalAsideTurnContent,
  externalTurnPrompt,
  localChatRunAuthorization,
  memberUploadDiagnostic,
  redirectSendToBundleAliases,
  resolveChatTurnAttemptIdentity,
  rewriteUserPromptText,
  type AgentChatSendCallOptions,
  userPromptText,
} from "./agent-chat-turn-helpers"
import {
  applyInstantTitle,
  clearPendingLoopContinuation,
  type SendFn,
} from "./agent-chat-turn-tasks"
import { supersedePendingApprovals } from "./approval-supersede"
import { hostStateSendEligible, type HostStateSendFacts } from "./host-state-send-eligibility"
import { haltInSessionPlanOnTurnFailure } from "./plan-turn-settle"
import {
  fusionChatTurnActive,
  routerFusionSendDiagnostic,
  runFusionChatTurn,
} from "./router-fusion-chat-turn"
import { toTraceparent } from "@/lib/agent-trace/trace-context"
import {
  AgentCapabilityError,
  createAgentExecutionHandle,
  type AgentExecutionHandle,
} from "@/lib/ai/agent/execution/agent-execution-handle"
import { invalidateJudgeContext } from "@/lib/ai/agent/execution/permissions/command-judge"
import {
  interruptSession,
  sendPrompt,
  turnsRunOnPairedHost,
} from "@/lib/ai/agent/execution/sidecar-client"
import { assertExternalRuntimeFeatureSupport } from "@/lib/ai/agent/external/session/session-models"

import { planHaltCauseForCode } from "@/lib/ai/agent/external/turn-failure"
import { type AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { runStandaloneTurn } from "@/lib/ai/chat/standalone-engine"
import { markAttachedSessionRunning } from "@/lib/chat/attached-session"
import { type AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { videoRouteFacts } from "@/lib/chat/attachments/video/route-facts"
import { enforceVideoDeliveryForRoute } from "@/lib/chat/attachments/video/route-guard"
import { tagBranchSiblings } from "@/lib/chat/branch-regen"
import {
  canContinueChat,
  continuationMessageId,
  continuationRuntimeOf,
  lastUserMessage,
} from "@/lib/chat/continuation"
import { notifyDroppedCapabilityOnce } from "@/lib/chat/dropped-capability-toast"
import { clearProjectHistoryEvidence } from "@/lib/chat/history-evidence-registry"
import { publishChatLifecycleEvent } from "@/lib/chat/lifecycle-events"
import { chatMentionResolvers } from "@/lib/chat/mentions/agent-targets"
import { resolveTurnContextRefs } from "@/lib/chat/mentions/resolve-mentions"
import { type MessageRunRouteStamp } from "@/lib/chat/message-run-metadata"
import { waitForModelSelection } from "@/lib/chat/model-selection"
import { notifyOverBudgetOnce } from "@/lib/chat/over-budget-toast"
import { stripPromptPreamble } from "@/lib/chat/prompt-preamble"
import { prefixReplyContext, withReplyContextLines } from "@/lib/chat/reply-to"
import { makeUserMessage } from "@/lib/chat/sdk-message-adapter"
import {
  ASIDE_REFERENCE_HEADER,
  prepareAsideContext,
  type AsideContextDelivery,
} from "@/lib/chat/session-aside-context"
import { resolveEffectiveCwdForSession } from "@/lib/chat/session-effective-cwd"
import { isEmbeddedSession } from "@/lib/chat/session-exposure"
import { assertSessionWritable } from "@/lib/chat/session-write-guard"
import { type SilenceWatchdog } from "@/lib/chat/silence-watchdog"
import { steerBlocksOf, steerTextOf, type SteerMessageMeta } from "@/lib/chat/steer"
import {
  appendSteerMessage,
  markPendingSteersFailed,
  mergeSteerWebSearchIntoLastSend,
  sessionExternalLane,
  sessionStatusOf,
  setSessionExternalLane,
  recordSteerOutcome,
  setSteerMessageState,
  steerArmed,
} from "@/lib/chat/steer-runtime"
import type { SteerOutcome } from "@/lib/execution/steer"

import {
  invalidateTranscriptRuntime,
  type TranscriptRuntimeFence,
  withTranscriptRuntimeLock,
} from "@/lib/chat/transcript/revision-events"
import {
  markTurnAdmission,
  turnMessageId,
  type TurnAdmissionMeta,
  waitFromBlocker,
} from "@/lib/chat/turn-admission"
import {
  foreignTurnsHandoffText,
  prefixForeignTurnsContext,
  unseenForeignTurns,
} from "@/lib/chat/turn-route/history"
import { stripLeadingRouteToken } from "@/lib/chat/turn-route/parse"
import { buildRouteStamp, resolveRouteLane, routeCharacter } from "@/lib/chat/turn-route/resolve"
import {
  routeTargetsFromStores,
  snapshotRouteContext,
  type RouteContextSnapshot,
} from "@/lib/chat/turn-route/snapshot"
import {
  isRoutableSession,
  readTurnRoute,
  type RouteLane,
  type TurnRoute,
} from "@/lib/chat/turn-route/types"
import { resolvedSessionAsideRuntime } from "@/lib/claude/build-options"
import {
  beginCodeAdoptionTurn,
  markCodeAdoptionTrackingUnavailable,
} from "@/lib/code-adoption/client"
import { markTaskWorkspaceTurnUnowned } from "@/lib/code-adoption/turn-tracker"
import { isTranscriptEntityRefId } from "@/lib/collab/shared-reference-scan"
import {
  applySharedRoomInstructions,
  shouldRequestSharedReply,
} from "@/lib/collab/shared-room-settings"
import {
  beginSharedSessionRun,
  sendSharedSessionMessage,
} from "@/lib/collab/shared-run-coordinator"
import { steerSharedFollowUp } from "@/lib/collab/shared-run-steer"
import {
  MemberAttachmentUploadError,
  memberTurnAttachments,
  uploadMemberTurnAttachments,
} from "@/lib/companion/member-turn-attachments"
import { createAsideContextDispatch } from "@/lib/context-workbench/aside-context-dispatch"
import { withWorkbenchMessageContext } from "@/lib/context-workbench/provider-context"
import { gateWorkbenchProviderPayload } from "@/lib/context-workbench/provider-payload"
import { commitMessageDelta, listMessages, persistMessages } from "@/lib/db/messages"
import {
  HostStateChannelUnavailableError,
  enqueueHostStateIntentIfAvailable,
  enqueueHostStateIntentWhenAvailable,
  hostStateSessionIntentAvailable,
} from "@/lib/db/mobile-outbound-queue"
import { getProjectEnvironment } from "@/lib/db/project-environments"
import { advanceResourceAsideContextCursor } from "@/lib/db/resource-workbench-sessions"
import { persistMessageSessionAssets } from "@/lib/db/session-assets"
import {
  clearBranchSeed,
  freezeImportedSession,
  getSession,
  touchSession,
  updateSession,
} from "@/lib/db/sessions"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { getExecutionBroker } from "@/lib/execution/broker"
import {
  acquireChatLease,
  isChatTurnQueued,
  isQueuedChatTurnCancellation,
} from "@/lib/execution/chat-lease"
import {
  ensureDirectChatExecutionRun,
  finishDirectChatExecutionRun,
  releasePreparedDirectChatExecutionRun,
  startDirectChatExecutionRun,
} from "@/lib/execution/direct-chat-run"
import { workingCopyConflict } from "@/lib/execution/lease-conflict"
import { bindPersonalMessageRun } from "@/lib/execution/personal-marks"
import {
  preparePersonalDerivedHistory,
  preparePersonalHistory,
} from "@/lib/execution/personal-visibility"
import { slotKeyForTurn } from "@/lib/execution/slot-key"
import { flushProjectEditorEdits } from "@/lib/files/project-editor-bridge"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { getLoopRuntime } from "@/lib/loop/runtime"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import { isCapacitor } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import {
  dispatchChatError as dispatchPluginChatError,
  dispatchOnMessageSend as dispatchPluginMessageSend,
  dispatchUserPromptSubmit as dispatchPluginUserPromptSubmit,
  hasPostToolUseListeners,
} from "@/lib/plugin/messaging/agent-hook-dispatch"
import { SystemEvents, emitSystemBusEvent } from "@/lib/plugin/messaging/message-bus"
import { runVscodeChatTurn } from "@/lib/plugin/vscode-shim/chat-turn"
import { isProjectRoleSessionPaused } from "@/lib/project-coordinator/project-access"
import { executeProjectEnvironment } from "@/lib/project-environment/executor"
import { resolveEnvironmentForRun } from "@/lib/project-environment/resolve-environment"
import { cancelRouterFusionTurn } from "@/lib/router-fusion/gate/chat-events"
import { abortRouterFusionSend, prepareRouterFusionSend } from "@/lib/router-fusion/gate/chat-send"
import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"
import { routerFusionGate } from "@/lib/router-fusion/gate/feature-gate"
import { routerFusionRefusalDiagnostic } from "@/lib/router-fusion/gate/refusal-diagnostic"
import { routingPlanTraceAttributes } from "@/lib/routing/plan-trace-attributes"
import { getRuntimeSnapshot, isMemberOnPartition } from "@/lib/runtime/runtime-snapshot-store"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
import { releaseSkillLoadContext } from "@/lib/skills/runtime-loader"
import { resolveTurnSquad } from "@/lib/squads/squad/resolve-turn-squad"
import { hostStateActionOfferedHere } from "@/lib/sync/host-state-offered-actions"
import { externalAgentWorkspaceCaptureSupport } from "@/lib/task-workspace/capture-support"
import {
  acquireWorkspaceBundle,
  beginObservedTaskWorkspaceTurn,
  isExecutorStopUnconfirmedRefusal,
  isWorkspaceBusyRefusal,
  runIdForTurn,
  taskIdForMessage,
} from "@/lib/task-workspace/client"
import { ensureExecutionPortLease } from "@/lib/task-workspace/execution-port-lease"
import { openWorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"
import {
  ensureSessionExecutionBundle,
  type SessionBundleBinding,
} from "@/lib/task-workspace/session-bundle"
import {
  bindExecutionBundleTurn,
  bindExecutionRun,
  repairManagedContextProjectId,
  resolveSessionWorkspaceRoot,
  transitionManagedWorktree,
} from "@/lib/task-workspace/session-execution-context"
import { isTauri } from "@/lib/tauri"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { enforceCostBudget, isCostBudgetConfigured } from "@/lib/usage/cost-budget-gate"
import {
  acceptChatTurn,
  bindChatTurnContext,
  chatSubmissionId,
  claimChatTurnForDispatch,
  markChatTurnStarted,
  settleChatTurnForSession,
} from "@/lib/work-submission/chat-adapter"
import { startWorkSubmissionLeaseHeartbeat } from "@/lib/work-submission/lease-heartbeat"
import { useExternalAgentStore } from "@/stores/agent"
import {
  compositionForSession,
  externalSessionLinkForSession,
  runtimeRefForSession,
  useAgentRuntimeStore,
} from "@/stores/agent/agent-runtime-store"
import {
  selectComposerCitedRefs,
  selectComposerEphemeralSkillIds,
  selectComposerPendingCommandOverrides,
  selectVisibleMessages,
  useChatStore,
} from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useInFlightStore } from "@/stores/settings/in-flight-store"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"
import {
  type ApprovalDecision,
  type PendingApproval,
  type SendContent,
  type SendOptions,
} from "@cognia/agent-config-types"
import { automatedTurnMetadata } from "@cognia/agent-config-types/automated-turn"
import {
  requestedRuntimeCapabilities,
  runtimeFeatureValidationError,
} from "@cognia/agent-contracts/session-operations"
import { endSpan, recordEvent, startSpan } from "@cognia/agent-trace/emitter"
import { createDiagnostic, type CogniaDiagnostic } from "@cognia/diagnostics"
import { type UIMessage } from "ai"
import { type useTranslations } from "next-intl"
import { toast } from "sonner"

/**
 * Sessions whose live shared send already warned about embedded references.
 * Once per session is deliberate: every send carrying a `@chat:`/`@msg:`
 * snapshot publishes it to every member, but a toast per message is spam —
 * the first one is when the user can still change their mind cheaply.
 */
const sharedReferenceWarnedSessions = new Set<string>()

/** What a chat send reads from the chat controller (`useAgentChat`): its stores, refs, translators and the lanes' shared callbacks. */
export interface AgentChatSendContext {
  store: typeof useChatStore
  tRouting: ReturnType<typeof useTranslations<"providers.routingView">>
  tInlineErr: ReturnType<typeof useTranslations<"chat.inlineError">>
  tAside: ReturnType<typeof useTranslations<"contextWorkbench.asides">>
  tDiagnostics: ReturnType<typeof useTranslations<"diagnostics">>
  tPiPackages: ReturnType<typeof useTranslations<"plugins.piPackages">>
  tVideo: ReturnType<typeof useTranslations<"chat.composer.attachments.video">>
  tCollab: ReturnType<typeof useTranslations<"chatCollaboration">>
  tWorkspaceLayout: ReturnType<typeof useTranslations<"chat.workspaceLayout">>
  refuseCapturedTurn: (sessionId: string) => boolean
  warnUndeliveredAttachments: (
    recipient: "external" | "squad",
    report: {
      omitted: import("@/hooks/chat/agent-chat-turn-helpers").ExternalTurnOmissions
      withheld: readonly import("@/lib/ai/agent/external/session/turn-images").TurnImagesWithheld[]
      agent?: string | null | undefined
    },
    manifest:
      readonly import("@/lib/chat/attachments/dispatch").AttachmentManifestEntry[] | undefined
  ) => void
  activeRef: React.RefObject<string | null>
  messagesMirrorRef: React.RefObject<Map<string, UIMessage[]>>
  lastUserContentRef: React.RefObject<
    Map<
      string,
      {
        messageId: string
        content: SendContent
        manifest: readonly AttachmentManifestEntry[] | undefined
      }
    >
  >
  lastResourceContextRef: React.RefObject<Map<string, AsideContextDelivery & { messageId: string }>>
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
  skillAttemptByTurnRef: React.RefObject<Map<string, number>>
  pendingBranchTagRef: React.RefObject<Map<string, { groupId: string; index: number }>>
  pendingBranchOwnerRef: React.RefObject<Map<string, string>>
  ownedContinuationRef: React.RefObject<SendFn | null>
  sharedApprovalResponseRef: React.RefObject<
    ((approval: PendingApproval, decision: ApprovalDecision) => Promise<void>) | null
  >
  squadWatchersRef: React.RefObject<Map<string, () => void>>
  standaloneAbortRef: React.RefObject<Map<string, AbortController>>
  externalGatewayAbortRef: React.RefObject<Map<string, AbortController>>
  checkoutAbortRef: React.RefObject<Map<string, AbortController>>
  hostStateTurnsRef: React.RefObject<Set<string>>
  externalTurnSettlementsRef: React.RefObject<Map<string, Promise<void>>>
  externalToolHostsRef: React.RefObject<
    Map<
      string,
      {
        host: import("@/lib/ai/agent/external/session/renderer-tool-host").RendererToolHost
        agentId: string
        nativeSessionId?: string | undefined
        launchContextSignature?: string | undefined
      }
    >
  >
  releaseExternalToolHost: (sessionId: string) => Promise<void>
  executionHandlesRef: React.RefObject<Map<string, AgentExecutionHandle>>
  executionHandleDirectory: import("@/components/providers/agent-execution-handle-provider").AgentExecutionHandleDirectory
  getExecutionHandle: (
    sessionId: string
  ) => import("@/lib/ai/agent/execution/agent-execution-handle").AgentExecutionHandle | undefined
  registry: import("@/lib/chat/stream-coalescing").SessionCoalescingRegistry
  transcriptFenceRef: React.RefObject<TranscriptRuntimeFence | null>
  silenceWatchdogRef: React.RefObject<SilenceWatchdog | null>
  enqueueClaudeEvent: (evt: import("@cognia/agent-config-types").ClaudeEvent) => Promise<void>
  /** The live app settings, read at the moment each step needs them. */
  readSettings: () => import("@cognia/agent-config-types").AppSettings | null
}

/**
 * The send pipeline of a chat turn (`useAgentChat`'s `sendUnexcluded`): resolves
 * the session and its lane, builds and appends the user turn, admits its run,
 * and dispatches it to the Host, a Squad, Router + Fusion, an external agent
 * (`runExternalAgentTurn`) or the built-in sidecar. Resolves true once the
 * input reached the transcript, as `send` documents.
 */
export async function runChatSend(
  ctx: Pick<
    AgentChatSendContext,
    | "store"
    | "tRouting"
    | "tInlineErr"
    | "tAside"
    | "tDiagnostics"
    | "tPiPackages"
    | "tVideo"
    | "tCollab"
    | "tWorkspaceLayout"
    | "refuseCapturedTurn"
    | "warnUndeliveredAttachments"
    | "activeRef"
    | "messagesMirrorRef"
    | "lastUserContentRef"
    | "lastResourceContextRef"
    | "asideContextDispatchRef"
    | "skillAttemptByTurnRef"
    | "pendingBranchTagRef"
    | "pendingBranchOwnerRef"
    | "ownedContinuationRef"
    | "sharedApprovalResponseRef"
    | "squadWatchersRef"
    | "standaloneAbortRef"
    | "externalGatewayAbortRef"
    | "checkoutAbortRef"
    | "hostStateTurnsRef"
    | "externalTurnSettlementsRef"
    | "externalToolHostsRef"
    | "releaseExternalToolHost"
    | "executionHandlesRef"
    | "executionHandleDirectory"
    | "getExecutionHandle"
    | "registry"
    | "transcriptFenceRef"
    | "silenceWatchdogRef"
    | "enqueueClaudeEvent"
    | "readSettings"
  >,
  content: SendContent,
  opts?: SendOptions,
  callOptions?: AgentChatSendCallOptions
): Promise<boolean> {
  const {
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
    readSettings,
  } = ctx

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
  let armedPick: { groupId: string; messageId: string; previous: string | undefined } | null = null
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
  ).filter((message) => continuationMessageId(message) !== callOptions?.sharedRequest?.messageId)
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
  const turnRoute = readTurnRoute(continuationSource?.metadata) ?? callOptions?.turnRoute ?? null
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
    if (!hostQueuesFollowUps && (st === "streaming" || st === "awaiting_approval" || turnQueued)) {
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
      // says "accepted" until the turn settles. Unsupported lanes can use
      // the durable queue below. An attempted external delivery cannot be
      // replayed automatically: a lost reply may hide a successful inject.
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
          let steeringAttempted = false
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
              steeringAttempted = true
              await (remoteClient ?? mgr).steerSession(externalAgentId, link.sessionId, text)
              mergeSteerWebSearchIntoLastSend(sessionId, callOptions?.webSearchContext)
              setSteerMessageState(sessionId, entryId, "accepted")
              return true
            }
          } catch (err) {
            if (steeringAttempted) {
              setSteerMessageState(
                sessionId,
                entryId,
                "failed",
                err instanceof Error ? err.message : String(err)
              )
              return true
            }
            console.warn("live steer unavailable; queueing instead", err)
          }
        }
      } else {
        // Anthropic streaming input. `steerSession` is PII-gated and rejects
        // non-Anthropic providers sidecar-side, so a wrong-provider session
        // simply falls through to the queue. It takes the whole `content`,
        // so an attachment-only follow-up goes live here too.
        try {
          const handle = getExecutionHandle(sessionId)
          let outcome: SteerOutcome
          if (handle) {
            await handle.steer(content)
            outcome = { status: "delivered", receiptIds: [] }
          } else {
            // The one steer entry (ADR-0252 §5): the sidecar's streaming
            // input, or the Squad run this conversation is holding for.
            const { steerRun } = await import("@/lib/execution/steer")
            outcome = await steerRun({
              target: { sessionId },
              origin: "person",
              content,
            })
          }
          // Delivered reads "accepted"; a Squad's hold for a teammate's next
          // dispatch reads "queued" and keeps no local copy.
          if (recordSteerOutcome(sessionId, entryId, outcome, callOptions?.webSearchContext)) {
            return true
          }
          throw new Error(`steer ${outcome.status}`)
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
    const personalHistory = await preparePersonalHistory(sessionId, await listMessages(sessionId))
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
      const { buildAgentBackedLlmClient } = await import("@/lib/ai/generation/agent-backed-client")
      builtinHandoffContext = (
        await prepareHandoffContext(history, {
          state,
          client: await buildAgentBackedLlmClient({
            session,
            appSettings: readSettings(),
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
  const executionRunId = callOptions?.backgroundDelivery?.id ?? runIdForTurn(sessionId, chatRunId)
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
    routerFusionGate(readSettings(), "chat") === "on" &&
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
    if (builtinHandoffContext && !sendOptions.appendSystemPrompt?.includes(builtinHandoffContext)) {
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
    useChatStore.getState().setSessionError(sessionId, tInlineErr("providerConcurrencyCapReached"))
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
      providerSettings: readSettings()?.providerSettings,
      customProviders: readSettings()?.customProviders,
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
    const additionalContext = (promptDecision as { additionalContext?: string }).additionalContext
    if (typeof additionalContext === "string" && additionalContext.trim()) {
      const existing = sendOptions.appendSystemPrompt?.trim() ?? ""
      sendOptions = {
        ...sendOptions,
        appendSystemPrompt: existing ? `${existing}\n\n${additionalContext}` : additionalContext,
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
  const citedRefs = callOptions?.citations ?? selectComposerCitedRefs(store.getState(), sessionId)
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
        store.getState().sessions[sessionId]?.activeBranchByGroup[callOptions.branchTag.groupId],
    }
    store.getState().setSessionActiveBranch(sessionId, callOptions.branchTag.groupId, userMsg.id)
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
              appSettings: readSettings(),
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
    callOptions?.replyTo ? prefixReplyContext(routedContent, callOptions.replyTo) : routedContent,
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
  if (asideToolCeiling && sendOptions.allowedTools?.some((tool) => !asideToolCeiling.has(tool))) {
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
  let externalTurn = externalTurnPrompt(effectiveContent, turnManifest?.length ?? 0, leadingCount)
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
    ? memberTurnAttachments(effectiveContent, turnManifest, leadingCount, getRuntimeSnapshot().host)
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
        ...(callOptions?.backgroundDelivery ? { actionId: callOptions.backgroundDelivery.id } : {}),
        action: {
          kind: "message.enqueue",
          messageId: userMsg.id,
          // A plain-string turn is the whole of it; a member's turn with
          // files is this text plus the files, which the Host extracts
          // from the uploaded originals.
          text: externalTurn.request,
          attachments: attachmentRefs,
          ...(mentionRefs.length > 0 ? { mentions: mentionRefs } : {}),
          ...(callOptions?.promptPreamble ? { promptPreamble: callOptions.promptPreamble } : {}),
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
          ...(callOptions?.backgroundDelivery ? { runId: callOptions.backgroundDelivery.id } : {}),
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
      settings: readSettings(),
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
    // Snapshot pre-reply message ids synchronously BEFORE the async import so
    // a fast main reply that finishes before subscription installation is still
    // detected as new and verified once.
    const preTurnMessageIds = new Set(
      (store.getState().sessions[sessionId]?.messages ?? []).map((message) => message.id)
    )
    void import("@/lib/agent/composition/verified-fresh-agent")
      .then(({ armVerifiedFreshAgentFollowup }) =>
        armVerifiedFreshAgentFollowup({
          sessionId,
          // Its contract: the user's request, without attachments.
          request: externalTurn.request,
          cwd: turnCwd,
          knownMessageIds: preTurnMessageIds,
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
  let delegation: import("@/lib/ai/agent/external/delegation-router").RoutingDecision | null = null
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
        current.map((message) => (message.id === anchor.id ? { ...message, metadata } : message))
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
    !hasNoToolSurface && !standaloneEngineTurn && !hostOwnedExternalTurn && captureSupport.available
  if (!hasNoToolSurface && executionContext?.location === "local") {
    sendOptions = { ...sendOptions, cwd: executionContext.projectRoot }
  }
  // ADR-0130 cost ceiling. Evaluated BEFORE any durable acceptance so a
  // refused overrun leaves no half-open run behind. A ceiling it cannot read
  // asks the user rather than letting the turn through unchecked, and near a
  // ceiling the turn holds its scopes until it settles, so the next turn is
  // judged on what this one booked.
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
          sessionId,
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
          // A regenerate or continuation reuses the message it answers: a new
          // turn of its own, not a redelivery of that message's first turn.
          ...(callOptions?.skipUserAppend === true ? { rerun: true } : {}),
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
      diagnostic: toDiagnostic(new Error("background_delivery_durable_acceptance_unavailable"), {
        source: "chat",
        meta: { sessionId },
      }),
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
            appSettings: readSettings(),
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
        executionContext?.taskWorkspace.taskId ?? taskIdForMessage(anchorMessage?.id ?? userMsg.id),
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
      useTaskWorkspaceStore.getState().bindTrace(sessionId, sendOptions.traceId, sendOptions.spanId)
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
        settings: readSettings(),
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
        throw new RouterFusionRefusalError(fusionSend.code, "Router + Fusion refused this turn.")
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
          sessionId,
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
        startedAt: Date.now(),
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
      void clearBranchSeed(sessionId).catch((err) => console.error("clearBranchSeed failed", err))
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
}
