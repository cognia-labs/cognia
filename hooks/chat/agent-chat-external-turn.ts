"use client"

import type React from "react"
import { drainSteerVia, tryAutoModeDecision } from "./agent-chat-events"
import { assertPersonalContextReaders } from "./agent-chat-send-options"
import { behaviorTurnStartedAt, finishBehaviorTurn } from "./agent-chat-tool-hooks"
import {
  buildPersonalAsideContext,
  chatHookCredentialContext,
  executePersonalExternalTurn,
  externalSessionVisibilityMatches,
  resolveNativeExternalSessionId,
  type ExternalTurnOmissions,
  type AgentChatSendCallOptions,
  type externalTurnPrompt,
} from "./agent-chat-turn-helpers"
import { applyInstantTitle, extractAssistantText, type SendFn } from "./agent-chat-turn-tasks"
import { driveInSessionPlanAfterTurn, haltInSessionPlanOnTurnFailure } from "./plan-turn-settle"
import { turnAgentStamp } from "@/lib/agent/composition/turn-agent-mode"
import {
  canonicalEventFromExternalEvent,
  captureEventFromCanonical,
} from "@/lib/ai/agent/execution/event-envelope"
import { externalAgentPresetIdOf } from "@/lib/ai/agent/external/config/preset-identity"
import { isCogniaProjectedTool } from "@/lib/ai/agent/external/policy/tool-preapproval"
import { type RemoteAttachmentsWithheld } from "@/lib/ai/agent/external/runtimes/remote/remote-execute"
import {
  externalAgentRouteKey,
  isGatewaySessionLink,
  rememberGatewaySession,
  resolveExternalAgentModelSelection,
} from "@/lib/ai/agent/external/session/session-models"
import { type TurnImagesWithheld } from "@/lib/ai/agent/external/session/turn-images"
import {
  classifyExternalTurnFailure,
  piPackageTurnFailure,
  planHaltCauseForCode,
} from "@/lib/ai/agent/external/turn-failure"
import {
  attachRunMetadataToLastAssistant,
  attachUsageToLastAssistant,
  buildCompletedRunMetadata,
  buildRoutingRunMetadata,
  type MessageRunRouteStamp,
} from "@/lib/chat/message-run-metadata"
import { closeOpenToolParts } from "@/lib/chat/phantom-run"
import { markPendingSteersFailed, setSessionExternalLane } from "@/lib/chat/steer-runtime"
import {
  invalidateTranscriptRuntime,
  withTranscriptRuntimeLock,
  type TranscriptRuntimeFence,
} from "@/lib/chat/transcript/revision-events"
import { markTurnAdmission, turnMessageId } from "@/lib/chat/turn-admission"
import {
  externalLaneMemory,
  foreignTurnsHandoffText,
  unseenForeignTurns,
} from "@/lib/chat/turn-route/history"
import { gateWorkbenchProviderPayload } from "@/lib/context-workbench/provider-payload"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { advanceResourceAsideExternalSession } from "@/lib/db/resource-workbench-sessions"
import { recordExternalAgentUsage } from "@/lib/db/session-usage"
import {
  clearBranchSeed,
  freezeImportedSession,
  getSession,
  touchSession,
  updateSession,
} from "@/lib/db/sessions"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import {
  finishDirectChatExecutionRun,
  projectDirectChatCaptureEvent,
} from "@/lib/execution/direct-chat-run"
import { bindPersonalMessageRun } from "@/lib/execution/personal-marks"
import * as personalSinkHost from "@/lib/execution/personal-sink"
import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import { chatTurnPerformance } from "@/lib/perf/chat-turn-performance"
import { dispatchChatError as dispatchPluginChatError } from "@/lib/plugin/messaging/agent-hook-dispatch"
import { SystemEvents, emitSystemBusEvent } from "@/lib/plugin/messaging/message-bus"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { externalTokenUsageToUsageInfo } from "@/lib/usage/usage-info"
import { useExternalAgentStore } from "@/stores/agent"
import {
  compositionForSession,
  externalSessionLinkForSession,
  useAgentRuntimeStore,
} from "@/stores/agent/agent-runtime-store"
import { selectVisibleMessages, useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { type ExternalAgentImageContent } from "@/types/agent/external-agent"
import { isCapabilityUsable } from "@cognia/agent-config-types/external-agent-capability"
import { createDiagnostic, type CogniaDiagnostic } from "@cognia/diagnostics"
import { type UIMessage } from "ai"
import { type useTranslations } from "next-intl"
import { type AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { type SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import { type SendOptions, type SendContent, type ChatSession } from "@cognia/agent-config-types"
import { type SessionExecutionContext } from "@/types/execution-context"
import { type RoutingDecision } from "@/lib/ai/agent/external/delegation-router"
import { type AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { type RendererToolHost } from "@/lib/ai/agent/external/session/renderer-tool-host"

/** A renderer tool host lent to an external agent's session (ADR-0217). */
export interface ExternalToolHostEntry {
  host: RendererToolHost
  agentId: string
  nativeSessionId?: string
  launchContextSignature?: string
}

/**
 * What the external-agent lane reads from the send that routed to it. The
 * send pipeline decides the lane, builds the user turn and admits its run;
 * every value here is final by the time the lane starts, except the armed
 * branch owner, which the send's `disarmBranch` can still clear and the lane
 * takes through `takeArmedOwner`.
 */
export interface ExternalAgentTurnContext {
  store: typeof useChatStore
  tDiagnostics: ReturnType<typeof useTranslations<"diagnostics">>
  tPiPackages: ReturnType<typeof useTranslations<"plugins.piPackages">>
  warnUndeliveredAttachments: (
    recipient: "external" | "squad",
    report: {
      omitted: ExternalTurnOmissions
      withheld: readonly TurnImagesWithheld[]
      agent?: string | null
    },
    manifest: readonly AttachmentManifestEntry[] | undefined
  ) => void
  activeRef: React.RefObject<string | null>
  ownedContinuationRef: React.RefObject<SendFn | null>
  externalGatewayAbortRef: React.RefObject<Map<string, AbortController>>
  externalTurnSettlementsRef: React.RefObject<Map<string, Promise<void>>>
  externalToolHostsRef: React.RefObject<Map<string, ExternalToolHostEntry>>
  releaseExternalToolHost: (sessionId: string) => Promise<void>
  registry: SessionCoalescingRegistry
  transcriptFenceRef: React.RefObject<TranscriptRuntimeFence | null>
  opts: SendOptions | undefined
  callOptions: AgentChatSendCallOptions | undefined
  sessionId: string
  disarmBranch: () => void
  claimReplyBranch: (replyId: string) => Record<string, unknown>
  rejectSend: (error?: unknown) => boolean
  session: ChatSession | undefined
  isSessionAside: boolean
  chatRunId: number
  executionRunId: string
  sendOptions: SendOptions
  turnManifest: AttachmentManifestEntry[] | undefined
  previousMessages: UIMessage[]
  userMsg: UIMessage
  skipAppend: boolean
  next: UIMessage[]
  displayContent: SendContent
  personalAsideRequiresRebuild: boolean
  personalAsideSourceDigest: string | undefined
  externalTurn: ReturnType<typeof externalTurnPrompt>
  executionContext: SessionExecutionContext | undefined
  routeStamp: MessageRunRouteStamp | undefined
  delegation: RoutingDecision | null
  turnRuntimeRef: AgentRuntimeRef | null
  routedExternalAgentId: string | undefined
  refuseTurn: (input: {
    diagnostic: CogniaDiagnostic
    cause?: unknown
    errorCode: string
    finishRun?: boolean
  }) => Promise<boolean>
  boundWorkspaceRoot: string | undefined
  /** Reads and clears the edit's armed branch owner, which `disarmBranch` also clears. */
  takeArmedOwner: () => string | null
}

/**
 * The external-agent lane of a chat send: a turn the composer pointed at an
 * external agent (manual), or a delegation rule routed to one, runs on that
 * agent's manager instead of the built-in sidecar. The optimistic user message
 * is already in the store; the assistant reply is appended from the manager's
 * result. Resolves as `send` does: true once the turn was accepted.
 */
export async function runExternalAgentTurn(ctx: ExternalAgentTurnContext): Promise<boolean> {
  const {
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
    takeArmedOwner,
  } = ctx
  // A configuration the paired HOST owns, when the composer points at one
  // instead of at a locally configured agent. Only the manual lane can
  // select one — a delegation rule names a local agent by id, and there
  // is no rule syntax for "whatever the host is called this week".
  const hostSelection =
    turnRuntimeRef?.kind === "host"
      ? {
          configId: turnRuntimeRef.configId,
          revision: turnRuntimeRef.revision,
          lifecycleGeneration: turnRuntimeRef.lifecycleGeneration,
        }
      : null
  const extAgentId = routedExternalAgentId
  // Fail-closed backstop, not a reachable path. `turnRuntimeRef` is built
  // from the composer's ref (which names its target) or from a delegation
  // decision (`routeDelegation` refuses one with no `targetAgentId`), so
  // reaching here means the two disagreed. Refusing beats dispatching a
  // turn to nothing.
  if (!extAgentId) {
    // The optimistic user message is rolled back before the refusal:
    // nothing was sent, so it must not stay in the transcript.
    store.getState().replaceSessionMessages(sessionId, previousMessages)
    return await refuseTurn({
      errorCode: "external_agent_not_selected",
      finishRun: true,
      diagnostic: createDiagnostic("externalAgentNotSelected", {
        source: "external-agent",
        meta: { sessionId },
      }),
    })
  }
  // Record the lane this session's turn is actually on, so a follow-up
  // typed while it runs steers this agent rather than whatever the
  // composer's global runtime selector happens to say (see
  // `sessionExternalLane`). Cleared when the turn settles, in
  // `maybeDrainSteer`.
  setSessionExternalLane(sessionId, extAgentId)
  // Which models this agent runs this turn on: its own, or a Cognia
  // provider/model through the gateway. The conversation's explicit
  // per-agent choice (`externalAgentModels`), never the built-in lane's
  // the built-in model, provider and provider-account fields. Reading those as a
  // binding is what sent a Kimi turn through a Claude model left over
  // from a built-in turn. Resolved once, for both executors.
  //
  // The configuration's own default is known only for a LOCAL agent; a
  // Host-owned configuration's default is the Host's to apply, which an
  // omitted `cogniaModel` asks it to do.
  const modelSelection = resolveExternalAgentModelSelection({
    agentId: extAgentId,
    session,
    ...(hostSelection
      ? {}
      : { agentDefault: useExternalAgentStore.getState().agents[extAgentId]?.cogniaModel }),
    appDefaults: useSettingsStore.getState().settings,
  })
  const cogniaModel = modelSelection.cogniaModel
  const managedGatewayTask = !!cogniaModel || modelSelection.gatewayLink !== undefined
  // The agent's own models, on its own session. A Cognia route resumes
  // only the gateway task its binding names; a native one resumes the
  // agent's own session and never a gateway link.
  const nativeRoute = !managedGatewayTask
  // A session remembers its lane across reloads; the manager does not.
  // Registering the config with the manager happens when the user picks
  // the agent, so a restored session sent without touching the picker
  // reached `ExternalAgentManager.execute` with an id it had never been
  // given and died on the manager-internal "Agent not found: <id>".
  //
  // Local lanes only. A host lane names a configuration the Host owns and
  // runs; there is no local adapter to register, and asking the local
  // store for it would answer `unknown-agent` for a perfectly good agent.
  if (turnRuntimeRef?.kind === "external") {
    const { ensureExternalAgentReady } = await import("@/lib/agent/ensure-external-agent-ready")
    // ADR-0182: a project run is readied WHERE its runtime environment
    // puts it — resolved first, refused before any process starts, and
    // restarted if the agent is running somewhere else. A session with
    // no project has nothing to resolve and connects as before (Q39).
    const runProjectId = session?.projectId ?? executionContext?.projectId
    const readiness = await ensureExternalAgentReady(extAgentId, {
      deferConnect: managedGatewayTask,
      ...(runProjectId
        ? {
            environment: {
              projectId: runProjectId,
              ...(executionContext?.environmentId
                ? { environmentId: executionContext.environmentId }
                : {}),
              project: useProjectStore
                .getState()
                .projects.find((candidate) => candidate.id === runProjectId),
              executionRoot: boundWorkspaceRoot ?? executionContext?.projectRoot,
              surface: "interactive" as const,
            },
          }
        : {}),
    })
    if (!readiness.ok) {
      store.getState().replaceSessionMessages(sessionId, previousMessages)
      return await refuseTurn({
        errorCode: "external_agent_unavailable",
        finishRun: true,
        diagnostic: createDiagnostic("externalAgentNotReady", {
          source: "external-agent",
          message:
            readiness.reason === "unknown-agent"
              ? undefined
              : (readiness as { detail: string }).detail,
          meta: { sessionId, agentId: extAgentId },
        }),
      })
    }
  }
  let asideExternalPermission:
    | import("@/lib/ai/agent/external/policy/permission-ceiling").PermissionBoundExternalExecutionOptions
    | undefined
  if (isSessionAside && !hostSelection) {
    const [{ getExternalAgentManager }, { attestsExternalPermissionMode }] = await Promise.all([
      import("@/lib/ai/agent/external/manager"),
      import("@/lib/ai/agent/external/policy/permission-ceiling"),
    ])
    const manager = getExternalAgentManager()
    const agent = manager.getAgent(extAgentId)
    const mode = sendOptions.permissionMode === "auto" ? "default" : sendOptions.permissionMode
    if (
      mode &&
      (mode === "plan" ||
        (agent &&
          attestsExternalPermissionMode(
            agent.config.protocol,
            agent.capabilities,
            mode,
            manager.getAgentCapabilityProfile(extAgentId)
          )))
    ) {
      asideExternalPermission = {
        permissionMode: mode,
        permissionCeiling: { permissionMode: mode },
      }
    }
    // An opaque adapter has no permission override to enforce. After an
    // explicit unlock it uses this same agent's configured default, just
    // as the main conversation does. A plan turn always has a hard ceiling.
  }
  // The text sent to the external agent: the PII-filtered prompt when
  // delegated by rule, else the turn as `externalTurnPrompt` reads it —
  // the typed question, behind any attachment text, never the file alone.
  const externalSendText = delegation ? delegation.filteredPrompt : externalTurn.prompt
  // Badge metadata so the assistant bubble can show "delegated to <rule>".
  const delegatedMeta = delegation
    ? {
        delegatedTo: {
          agentId: extAgentId,
          ruleId: delegation.matchedRuleId,
          ruleName: delegation.matchedRuleName,
        },
      }
    : undefined

  // B3 — failure fallback. A rule-delegated turn that fails falls back to
  // the built-in (trusted, in-process) path when `chatFailurePolicy` is
  // "fallback"; under "strict" it surfaces the error like a manual run.
  const chatFailurePolicy = useExternalAgentStore.getState().chatFailurePolicy
  /**
   * Take down every decision surface this session's external agent owns.
   *
   * One helper for two call sites that must NOT be collapsed into one:
   * the `finally` below runs after the whole turn, but the failure path
   * has to clear the surface BEFORE the sidecar fallback re-issues the
   * turn — `PaneApprovalGate` renders the first pending entry, so a dead
   * external card left in the queue would hide the fallback turn's own
   * approval behind a dialog nothing can answer, hanging that turn too.
   * Idempotent, so running it twice costs nothing.
   */
  const releaseExternalDecisionSurfaces = async (): Promise<void> => {
    const { releaseExternalApprovals, elicitationCancelResponse } =
      await import("@/lib/ai/agent/external/session/chat-decision-bridge")
    for (const requestId of releaseExternalApprovals(sessionId)) {
      store.getState().clearApproval(requestId, sessionId)
    }
    const { useExternalElicitationStore: elicitations } =
      await import("@/stores/agent/external-elicitation-store")
    const stranded = elicitations.getState().clearSession(sessionId)
    if (stranded.length === 0) return
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    const manager = getExternalAgentManager()
    // Best effort: the adapter is usually already gone, which is why the
    // question was stranded in the first place. Telling it the user
    // walked away costs nothing and lets an agent that IS still
    // listening stop waiting.
    for (const entry of stranded) {
      void manager
        .respondToElicitation(entry.agentId, elicitationCancelResponse(entry))
        .catch(() => undefined)
    }
  }
  const assistantId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  bindPersonalMessageRun(assistantId, executionRunId)
  const handleExternalFailure = async (message: string, error?: Error): Promise<void> => {
    // Before the fallback re-issues this turn on the sidecar: the
    // external agent is gone, so its card is dead and would sit in front
    // of the fallback turn's own approval.
    await releaseExternalDecisionSurfaces()
    // ADR-0127: the external rail streams through the per-session
    // coalescer, so a failure must drop any pending frame / debounced
    // write (a late rAF commit would resurrect the partial over the
    // failure state) and re-pin Dexie to the user turn alone — the
    // debounced writer may already have stored a partial assistant.
    const pending = registry.get(sessionId)
    pending.commit.cancel()
    pending.persist.cancel()
    registry.release(sessionId)
    await persistMessages(sessionId, next, { deleteIds: [assistantId] }).catch(() => undefined)
    if (delegation && chatFailurePolicy === "fallback" && !managedGatewayTask) {
      await finishDirectChatExecutionRun(sessionId, "failed", Date.now(), "Fallback requested")
      // Keep the user turn, drop any partial external assistant, then
      // re-issue THIS turn through the SDK path (skipUserAppend so the
      // user message isn't duplicated; bypassDelegation so we don't
      // re-match the same rule and loop).
      store.getState().replaceSessionMessages(sessionId, next)
      store.getState().setSessionError(sessionId, null)
      // An edit's bookkeeping already ran on THIS send, for the row it
      // appended: carrying `branchTag` into the re-issue would stamp and
      // select the user message the fallback builds but never appends,
      // and own its reply by that phantom id. The fallback takes only
      // the owner, and this send lets go of its entry first — the
      // `finally` below disarms what this send still holds, and the
      // fallback's entry names the same row.
      const { branchTag: _editTag, ...fallbackCallOptions } = callOptions ?? {}
      const editOwner = callOptions?.branchTag ? takeArmedOwner() : null
      await ownedContinuationRef.current?.(displayContent, opts, {
        ...fallbackCallOptions,
        skipUserAppend: true,
        bypassDelegation: true,
        ...(editOwner ? { branchOwnerId: editOwner } : {}),
      })
      // Disclose the substitution. The user routed this turn to a specific
      // external agent; it ran on the built-in one instead, which changes
      // cost, tooling and output. Silently succeeding looked identical to
      // the agent having worked.
      dispatchDiagnostic(
        createDiagnostic("fallbackToBuiltin", {
          source: "external-agent",
          message,
          meta: { sessionId, agentId: extAgentId },
        }),
        undefined,
        personalSinkHost.sessionPersonalSinkContext(sessionId)
      )
      return
    }
    await finishDirectChatExecutionRun(sessionId, "failed")
    const durationMs = finishBehaviorTurn(sessionId)
    if (durationMs !== undefined) {
      void trackEvent("chat.turn.failed", {
        sessionId,
        provider: "external",
        surface: "chat",
        errorType: error?.name || "ExternalAgentError",
        durationMs,
      })
    }
    chatTurnPerformance.finish(sessionId, "failed")
    // Classified from the error's TYPE first: a Pi process that exited
    // during startup, a handshake that never arrived, an agent process id
    // still held by another process. Each has a code whose localized hint
    // says what happened and what to do; the runtime's English sentence
    // moves to `detail`. Anything untyped keeps the text classifier.
    const typedCode = error ? classifyExternalTurnFailure(error) : null
    // A refused plugin Pi package says WHICH refusal in the user's
    // language (ADR-0210); the adapter's English stays in `detail`.
    const piPackageFailure =
      typedCode === "piPackageUnavailable" && error ? piPackageTurnFailure(error) : null
    const diagnostic = typedCode
      ? createDiagnostic(typedCode, {
          source: "external-agent",
          message: piPackageFailure
            ? tPiPackages(`errors.${piPackageFailure.messageKey}`, piPackageFailure.params)
            : tDiagnostics(`code.${typedCode}.hint`),
          detail: message,
          meta: { sessionId, agentId: extAgentId },
        })
      : toDiagnostic(error ?? message, {
          source: "external-agent",
          meta: { sessionId, agentId: extAgentId },
        })
    // The user's message STAYS, marked as a turn that did not run. It
    // used to be pulled out of the store while the copy persisted above
    // stayed in Dexie, so the row showed no failure now and reappeared
    // unmarked after a reload — and Retry regenerated the PREVIOUS turn,
    // because the failed one was no longer the last user message.
    const failedTurn = turnMessageId(next, skipAppend ? null : userMsg.id)
    // A failed turn's tool calls never get results (a timed-out ACP
    // prompt drops its tool state), so close them here — left open they
    // read as a turn still running after every reload.
    const failedList = markTurnAdmission(
      closeOpenToolParts(store.getState().sessions[sessionId]?.messages ?? next, message).messages,
      failedTurn,
      {
        state: "failed",
        code: diagnostic.code,
        detail: message,
        at: Date.now(),
      }
    )
    store.getState().replaceSessionMessages(sessionId, failedList)
    await persistMessages(sessionId, failedList).catch((persistError: unknown) =>
      console.warn("failed external turn persist failed", persistError)
    )
    store.getState().setSessionDiagnostic(sessionId, diagnostic)
    store.getState().setSessionStatus(sessionId, "idle")
    // Follow-ups queued behind this turn cannot ride a turn that never
    // ran; the same rule the sidecar applies to an errored settle.
    markPendingSteersFailed(sessionId, diagnostic.message)
    // The same in-session plan contract the sidecar lane has: a step whose
    // turn failed halts the plan on it with the classified cause — a lease
    // conflict or a start-up death is `not_started`, anything later
    // `turn_failed` — rather than waiting for the step watchdog.
    if (callOptions?.skipUserAppend) {
      await haltInSessionPlanOnTurnFailure({
        sessionId,
        cause: planHaltCauseForCode(diagnostic.code),
        detail: `${diagnostic.code}: ${message}`,
      })
    }
    if (error)
      void chatHookCredentialContext(
        sessionId,
        executionRunId,
        undefined,
        session?.projectThread?.parentExecutionRunId
      ).then((context) => dispatchPluginChatError(sessionId, error, context))
  }

  const gatewayController = !hostSelection ? new AbortController() : undefined
  let externalTurnCompleted = false
  let settleExternalTurn!: () => void
  const externalTurnSettlement = new Promise<void>((resolve) => {
    settleExternalTurn = resolve
  })
  externalTurnSettlementsRef.current.set(sessionId, externalTurnSettlement)
  try {
    await persistMessages(sessionId, next)
    await touchSession(sessionId)
    await applyInstantTitle(sessionId, displayContent)

    const { executeOnExternalAgent } = await import("@/lib/ai/agent/external/manager")
    const { executeOnRemoteHostAgent, remoteApprovalDecisionId } = hostSelection
      ? await import("@/lib/ai/agent/external/runtimes/remote/remote-execute")
      : { executeOnRemoteHostAgent: null, remoteApprovalDecisionId: null }
    // The run id a host turn is addressed by. Captured here so the
    // decision ids the event handler mints below refer to the same run
    // the executor is about to start.
    const remoteRunId = hostSelection
      ? `rer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      : null
    const { applyExternalAgentEventToParts } =
      await import("@/lib/ai/agent/external/session/event-to-parts")
    const {
      registerExternalApproval,
      registerExternalElicitation,
      registerExternalQuestionTarget,
      toPermissionResponse,
    } = await import("@/lib/ai/agent/external/session/chat-decision-bridge")
    const { useExternalElicitationStore } =
      await import("@/stores/agent/external-elicitation-store")

    // Pre-allocate the assistant message so partial deltas land in it
    // without flickering the chat list. Parts start empty and grow as
    // ExternalAgentEvents arrive via the onEvent callback below.
    const externalStartedAt = behaviorTurnStartedAt.get(sessionId)
    let assistantParts: UIMessage["parts"] = [] as unknown as UIMessage["parts"]
    const baseList = store.getState().sessions[sessionId]?.messages ?? []

    // ADR-0127 §1: the external rail rides the same per-session
    // coalescer as the sidecar rail — ≤1 React commit per frame and a
    // debounced mid-stream Dexie write — instead of a synchronous full
    // `replaceSessionMessages` per delta and a Dexie write only at the
    // end (which lost the partial on a mid-turn crash).
    const coalesce = registry.get(sessionId)
    // The branch stamp is claimed by the first write of the reply (the
    // point `handleEvent` claims it for a sidecar reply) and carried by
    // every rewrite of the same message after it.
    let replyBranch: Record<string, unknown> | null = null
    const writeAssistant = () => {
      replyBranch ??= claimReplyBranch(assistantId)
      // Write into this session's *own* slice — a mid-run focus switch is
      // safe because the slice is keyed by session, so the in-flight
      // external turn lands in its pane (live in background or focused),
      // never clobbering whatever session is now focused.
      const assistantMsg: UIMessage = {
        id: assistantId,
        role: "assistant",
        parts: assistantParts,
        metadata: {
          ...(delegatedMeta ?? {}),
          ...replyBranch,
          run: {
            providerId: "external",
            startedAt: externalStartedAt,
          },
        },
      }
      const nextMessages = [...baseList, assistantMsg]
      coalesce.commit.call(nextMessages)
      coalesce.persist.call(nextMessages)
    }
    /**
     * What the agent said when it refused this turn.
     *
     * Pi reports a failed turn on the assistant message it could not
     * produce (`stopReason: "error"` carrying the provider's own words),
     * and the adapter maps that to an `error` event. Nothing downstream
     * read it: `applyExternalAgentEventToParts` has no `error` case, so
     * "402 Insufficient Balance" was dropped and the turn settled as a
     * perfectly ordinary completion with an empty assistant bubble. The
     * user was told nothing at all.
     */
    let externalErrorDetail: string | null = null
    /** Seal the coalescer: apply the last frame now, drop the debounced write. */
    const sealCoalescer = () => {
      coalesce.commit.flush()
      coalesce.persist.cancel()
    }

    chatTurnPerformance.markDispatched(sessionId)
    /**
     * One event handler for both lanes.
     *
     * `applyExternalAgentEventToParts` deliberately does not render a
     * permission request — its contract is that the caller routes it
     * "through dedicated UI channels (e.g. the existing pendingApprovals
     * store)". Nothing here did, so an external agent that asked for
     * permission on the chat surface got no dialog and no answer, and the
     * turn stalled until the adapter timed out. Pi hits this on its
     * ordinary path: its native edit/write/bash calls are intercepted
     * precisely so they can be asked about (ADR-0119).
     *
     * A host run mints a `remoteDecisionId` alongside, which is the only
     * thing that differs: the card, the store and the dialog are the same
     * ones the local lane uses.
     */
    let persistedExternalSessionId = session?.externalAgentSession?.sessionId
    const externalPersonalHistory = await preparePersonalHistory(
      sessionId,
      selectVisibleMessages(
        await listMessages(sessionId),
        store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
      ),
      { executionRunId, session }
    )
    const externalHistoryMessages = externalPersonalHistory.messages.filter(
      (message) => message.id !== userMsg.id
    )
    const retainedExternalLink = [
      session?.externalAgentSession,
      ...(session?.externalAgentGatewaySessions ?? []),
    ].find(
      (link) =>
        link?.agentId === extAgentId &&
        (modelSelection.gatewayLink
          ? link.sessionId === modelSelection.gatewayLink
          : !isGatewaySessionLink(link.sessionId))
    )
    let persistedExternalVisibilityDigest = retainedExternalLink?.personalVisibilityDigest
    const externalVisibilityChanged = !externalSessionVisibilityMatches(
      retainedExternalLink,
      externalPersonalHistory.visibilityDigest,
      externalPersonalHistory.withheldMessageIds
    )
    if (
      externalVisibilityChanged &&
      (session?.externalAgentSession ||
        session?.externalAgentGatewaySessions?.length ||
        session?.importRuntimeBinding?.nativeSessionId)
    ) {
      // Imported/native sessions without a persisted visibility identity
      // cannot prove they forgot content, even after an app restart.
      await withTranscriptRuntimeLock(sessionId, () => invalidateTranscriptRuntime(sessionId))
      await updateSession(sessionId, {
        externalAgentSession: undefined,
        externalAgentGatewaySessions: [],
      })
    }
    // The links as this turn last wrote them, so a second write in the
    // same turn builds on the first rather than on the stale row.
    let persistedLinks = {
      externalAgentSession: session?.externalAgentSession,
      externalAgentGatewaySessions: session?.externalAgentGatewaySessions,
    }
    // Capture after this turn's intentional visibility invalidations.
    // A concurrent parent clear still refuses the already-assembled prompt.
    const externalSessionSnapshot = isSessionAside ? await getSession(sessionId) : session
    if (
      isSessionAside &&
      externalSessionSnapshot?.asideParentClearedAt !== session?.asideParentClearedAt
    )
      throw new Error("personal_history_context_changed")
    const externalFence = isSessionAside
      ? await transcriptFenceRef.current?.capture(
          sessionId,
          externalSessionSnapshot?.runtimeTranscriptGeneration
        )
      : undefined
    if (externalFence?.shouldPersist?.() === false) return true
    if (gatewayController) externalGatewayAbortRef.current.set(sessionId, gatewayController)
    let externalSessionWrite = Promise.resolve()
    let externalSessionWriteError: unknown
    // Streams can arrive before the start RPC returns. Keep the reset
    // pending until the Host acknowledges admission, including on retry.
    let remoteRunAccepted = !hostSelection
    let remoteSessionResetAccepted = false
    let pendingRemoteSessionId: string | undefined
    const persistExternalSession = (nativeId?: string) => {
      if (externalFence?.shouldPersist?.() === false) return
      if (!remoteRunAccepted) {
        pendingRemoteSessionId = nativeId ?? pendingRemoteSessionId
        return
      }
      // An older Host accepted the text turn but could not forget. Keep
      // the one-shot reset pending so upgrading it still starts fresh.
      if (hostSelection && resetExternalSession && !remoteSessionResetAccepted) return
      const rememberNativeSession = () => {
        if (!nativeId) return
        useAgentRuntimeStore.getState().setSessionExternalLink(sessionId, {
          agentId: extAgentId,
          sessionId: nativeId,
          ...(hostSelection
            ? {
                host: {
                  configId: hostSelection.configId,
                  revision: hostSelection.revision,
                  lifecycleGeneration: hostSelection.lifecycleGeneration,
                },
              }
            : {}),
        })
        const hosted = externalToolHostsRef.current.get(sessionId)
        if (hosted?.agentId === extAgentId && !isGatewaySessionLink(nativeId))
          hosted.nativeSessionId = nativeId
      }
      // Aside links become visible only after their guarded DB write.
      // Ordinary conversations keep their existing immediate reconnect.
      if (!isSessionAside) rememberNativeSession()
      if (
        !nativeId ||
        (!isSessionAside &&
          nativeId === persistedExternalSessionId &&
          persistedExternalVisibilityDigest === externalPersonalHistory.visibilityDigest)
      )
        return
      persistedExternalSessionId = nativeId
      persistedExternalVisibilityDigest = externalPersonalHistory.visibilityDigest
      const link = {
        agentId: extAgentId,
        sessionId: nativeId,
        personalVisibilityDigest: externalPersonalHistory.visibilityDigest,
      }
      // The task this conversation used before stays retained, so a
      // switch back to its binding resumes it rather than starting over.
      const { sessions: retained, evicted } = rememberGatewaySession(
        externalVisibilityChanged ? undefined : persistedLinks,
        link
      )
      persistedLinks = { externalAgentSession: link, externalAgentGatewaySessions: retained }
      externalSessionWrite = externalSessionWrite
        .then(async () => {
          const links = {
            externalAgentSession: link,
            externalAgentGatewaySessions: retained,
          }
          if (isSessionAside) {
            const accepted = await advanceResourceAsideExternalSession(sessionId, links, {
              runtimeTranscriptGeneration: externalSessionSnapshot?.runtimeTranscriptGeneration,
              asideParentClearedAt: externalSessionSnapshot?.asideParentClearedAt,
            })
            if (!accepted || externalFence?.shouldPersist?.() === false) return
            rememberNativeSession()
          } else await updateSession(sessionId, links)
        })
        .catch((error: unknown) => {
          externalSessionWriteError = error
        })
      // A task that fell off the bounded list is named by nothing any
      // more, so its retained native history would outlive every way to
      // reach or delete it. Deleted here, best effort, where the local
      // manager owns it. A Host's tasks are the Host's to clean up.
      if (evicted.length > 0 && !hostSelection) {
        void (async () => {
          const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
          for (const stale of evicted) {
            await getExternalAgentManager()
              .deleteSession(stale.agentId, stale.sessionId)
              .catch((error: unknown) => console.warn("Retired gateway task cleanup failed", error))
          }
        })()
      }
    }
    let hostedServerNames: string[] = []
    const handleExternalEvent = (
      event: import("@/types/agent/external-agent").ExternalAgentEvent
    ) => {
      if (gatewayController?.signal.aborted || externalFence?.shouldPersist?.() === false) return
      if (event.type === "session_start") persistExternalSession(event.sessionId)
      // First, before anything else in this handler can throw or return:
      // an agent that refused the turn has exactly one useful thing to
      // say, and remembering it must not depend on the projection or the
      // routing below succeeding. Remembered rather than rendered,
      // because an `error` can also arrive mid-turn on an agent that
      // recovers and answers anyway; it is promoted to a failure only
      // when the turn ends with nothing to show.
      if (event.type === "error") {
        externalErrorDetail = event.error ?? externalErrorDetail
      }
      const capture = captureEventFromCanonical(canonicalEventFromExternalEvent(event))
      if (capture) void projectDirectChatCaptureEvent(sessionId, capture)
      if (event.type === "permission_request") {
        const responseRequestId = event.request?.requestId || event.request?.id
        const nativePermissionSessionId = event.sessionId ?? event.request.sessionId
        if (
          !hostSelection &&
          nativePermissionSessionId &&
          isCogniaProjectedTool(event.request.toolInfo?.name, hostedServerNames)
        ) {
          void import("@/lib/ai/agent/external/manager")
            .then(({ getExternalAgentManager }) =>
              getExternalAgentManager().respondToPermission(
                extAgentId,
                nativePermissionSessionId,
                toPermissionResponse("allow", {
                  agentId: extAgentId,
                  chatSessionId: sessionId,
                  externalSessionId: nativePermissionSessionId,
                  responseRequestId: responseRequestId ?? event.request.id,
                  options: event.request.options,
                })
              )
            )
            .catch((error) => {
              void handleExternalFailure(error instanceof Error ? error.message : String(error))
            })
          return
        }
        const approval = registerExternalApproval({
          agentId: extAgentId,
          chatSessionId: sessionId,
          event,
          ...(remoteRunId && remoteApprovalDecisionId && responseRequestId
            ? { remoteDecisionId: remoteApprovalDecisionId(remoteRunId, responseRequestId) }
            : {}),
        })
        if (approval) store.getState().pushApproval(approval)
        return
      }
      // The other half of the same gap: a Pi `confirm` / `select` /
      // `input` / `editor` arrives as an elicitation, and it blocks the
      // agent exactly like a permission request does. It rides its own
      // store rather than `pendingApprovals` because it carries a
      // schema, not a tool call.
      if (event.type === "elicitation_request") {
        const pending = registerExternalElicitation({
          agentId: extAgentId,
          chatSessionId: sessionId,
          event,
          ...(remoteRunId && remoteApprovalDecisionId && event.request?.id
            ? { remoteDecisionId: remoteApprovalDecisionId(remoteRunId, event.request.id) }
            : {}),
        })
        if (pending) useExternalElicitationStore.getState().push(pending)
        return
      }
      // The agent withdrew or already resolved the question — take the
      // dialog down rather than leaving one nothing is waiting on.
      if (event.type === "elicitation_complete") {
        useExternalElicitationStore.getState().remove(sessionId, event.elicitationId)
        return
      }
      // `async_questions` is opt-in UI: off, the same event degrades
      // to a plain text part rather than rendering an answer card.
      // Read per event so a mid-turn settings flip takes effect.
      const inlineQuestions =
        useSettingsStore.getState().settings?.inlineQuestions?.enabled === true
      // An `async_questions` event with a `requestId` backs a pending
      // server request (Codex `requestUserInput` + `isBlocking:false`):
      // the card's answer must resolve that RPC, not arrive as a chat
      // message. Register the delivery target so the card can call
      // `resolveExternalQuestion` with the chat-side key stamped into
      // the part's data. Skipped when the feature is off — a degraded
      // text part has no way to resolve, so the entry would only leak —
      // and on host-lane runs, whose remote decision channel cannot
      // carry an answers map.
      const questionRequestId =
        event.type === "async_questions" && event.requestId && inlineQuestions && !remoteRunId
          ? registerExternalQuestionTarget({
              agentId: extAgentId,
              chatSessionId: sessionId,
              event,
            })
          : null
      const nextParts = applyExternalAgentEventToParts(assistantParts, event, {
        inlineQuestions,
        sessionId,
        ...(questionRequestId ? { questionRequestId } : {}),
      })
      if (nextParts !== assistantParts) {
        assistantParts = nextParts as UIMessage["parts"]
        chatTurnPerformance.markFirstResponse(sessionId)
        writeAssistant()
      }
    }

    // The model and the thinking level this turn runs on, resolved once
    // for BOTH executors.
    //
    // The model is the one the picker persisted, replayed onto whatever
    // session the agent opens next. `select()` writes it through to a
    // session that already exists, but a catalog pick made before the
    // first turn has no session to write to, and every later turn opens
    // against an agent that was never told. The row was being written
    // and never read back, so the chip showed a model the turn did not
    // run on. `resolveExternalAgentModelSelection` owns every place the
    // choice can live, and never reads the built-in lane's model as the
    // agent's. `extAgentId` is the configuration id on the host lane,
    // which is also the id the picker keys the choice by, so one call
    // covers both lanes.
    //
    // The thinking level reached only the built-in runtime before this.
    // On an external agent the control was silently inert. Both fields
    // carry the same resolved precedence chain (IM override, then
    // session, then bot, then app default), and the adapter folds the
    // value onto whatever ladder its model publishes.
    //
    // `requestedEffort` rather than `effort`: the latter has already been
    // through the `modelSupportsEffort` gate against the SESSION's model,
    // which this rail does not run, because the external agent brings its
    // own. Reading the gated field made the control inert again whenever
    // the session happened to sit on a model that rejects the Anthropic
    // `effort` parameter (Haiku, Sonnet 4.5), even though the agent about
    // to run it honours the level fine.
    //
    // Shared rather than written out per branch: the host-owned lane had
    // no model axis at all, so a conversation bound to a host
    // configuration ran on the agent's own default however loudly the
    // chip promised otherwise.
    //
    // The native model is part of the same selection as the Cognia
    // binding (`resolveExternalAgentModelSelection` above), so the two
    // can never both be sent: a Cognia route carries no native model.
    const appSettings = useSettingsStore.getState().settings
    const externalModel = modelSelection.model
    const externalModelAxes = {
      ...(cogniaModel !== undefined ? { cogniaModel } : {}),
      ...(externalModel ? { model: externalModel } : {}),
      ...(sendOptions.requestedEffort || sendOptions.effort
        ? { reasoningEffort: sendOptions.requestedEffort ?? sendOptions.effort }
        : {}),
    }

    const { resolvedMcpServerMapToAcpConfigs } =
      await import("@/lib/ai/agent/external/runtimes/acp/resolve-acp-mcp-servers")
    const externalMcpServers = resolvedMcpServerMapToAcpConfigs(sendOptions.mcpServers, sendOptions)
    let sandboxToolHostLeaseIds: string[] | undefined
    let externalContinuationContext: string | undefined
    // A Cognia binding no retained task serves starts a new task, and
    // the conversation's previous session on this agent (native, or a
    // task bound to another model) must not be resumed into it.
    // A Host lane cannot rebind a task to another model, so there the
    // switch starts a new task and hands the transcript over instead.
    let resetExternalSession =
      personalAsideRequiresRebuild ||
      externalVisibilityChanged ||
      // The manager/tool host can retain a native session after its row
      // links were retired. A parent clear must start a fresh task too.
      (isSessionAside && session?.asideParentClearedAt !== undefined && !retainedExternalLink) ||
      modelSelection.resetExternalSession === true ||
      (modelSelection.rebind === true && Boolean(hostSelection))
    let verifiedNativeResume = false
    // The agent's own session for this conversation, as its manager
    // knows it: what a native turn resumes. Never a gateway link.
    let nativeConversationSessionId: string | undefined
    // A stale tool host belongs to the previous runtime, including when
    // the new target cannot host MCP and would otherwise skip cleanup.
    const previousHost = externalToolHostsRef.current.get(sessionId)
    if (previousHost && (hostSelection || previousHost.agentId !== extAgentId)) {
      await releaseExternalToolHost(sessionId)
    }
    if (!hostSelection) {
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      const manager = getExternalAgentManager()
      const agentConfig = manager.getAgent(extAgentId)?.config
      const composition = compositionForSession(sessionId)
      if (nativeRoute) {
        const resolved = manager.resolveConversationSessionId(extAgentId, sessionId)
        nativeConversationSessionId =
          !resetExternalSession && resolved && !isGatewaySessionLink(resolved)
            ? resolved
            : undefined
      }
      verifiedNativeResume = Boolean(
        !externalVisibilityChanged &&
        nativeRoute &&
        sessionId.startsWith("import:") &&
        composition.verifiedNativeResume &&
        composition.verifiedNativeResumeAgentId === extAgentId &&
        session?.importOwnership === "native-bound" &&
        session.importRuntimeBinding?.nativeSessionId &&
        agentConfig &&
        session?.importRuntimeBinding?.presetId === externalAgentPresetIdOf(agentConfig)
      )
      const { buildDeclaredCapabilityProfile } =
        await import("@/lib/ai/agent/external/capability/capability-profile")
      const profile =
        manager.getAgentCapabilityProfile(extAgentId, sessionId) ??
        (agentConfig
          ? buildDeclaredCapabilityProfile({ protocol: agentConfig.protocol })
          : undefined)
      if (agentConfig?.protocol === "dsh-sdk" && managedGatewayTask && modelSelection.gatewayLink) {
        const { renderTranscript } = await import("@/lib/chat/branch-session")
        externalContinuationContext = renderTranscript(externalHistoryMessages)
      }
      const mcpLevel = profile?.effective.mcp.level
      if (mcpLevel === "native" || mcpLevel === "equivalent") {
        const { createRendererToolHost } =
          await import("@/lib/ai/agent/external/session/renderer-tool-host")
        let entry = externalToolHostsRef.current.get(sessionId)
        if (entry?.host.isCurrentHost?.() === false) {
          // A replaced connection already revoked this renderer bridge.
          // Do not close an old native session through the new Host.
          externalToolHostsRef.current.delete(sessionId)
          await entry.host.close()
          entry = undefined
        }
        if (entry && entry.agentId !== extAgentId) {
          await releaseExternalToolHost(sessionId)
          entry = undefined
        }
        if (!entry) {
          entry = { host: createRendererToolHost(sessionId), agentId: extAgentId }
          externalToolHostsRef.current.set(sessionId, entry)
        }
        const hosted = await entry.host.start({
          agentId: extAgentId,
          // Session-scoped runtimes spawn after tools are prepared.
          deferSandbox: true,
          sendOptions,
          signal: gatewayController?.signal,
          // DSH publishes its own broker tool calls; duplicating them here
          // would render two calls for one execution.
          onToolEvent:
            isCapabilityUsable(profile?.effective["tools.ordinary"]?.level ?? "unknown") &&
            isCapabilityUsable(profile?.effective["tools.results"]?.level ?? "unknown")
              ? undefined
              : handleExternalEvent,
          onPermissionRequest: async (request, signal) => {
            const { awaitApproval, hasSessionBypass } =
              await import("@/lib/ai/agent/execution/hitl/approval-registry")
            if (hasSessionBypass(sessionId, request.toolName)) return { decision: "allow" }
            if (sendOptions.permissionMode === "auto") {
              let automatic: { decision: "allow" | "deny"; message?: string } | undefined
              await tryAutoModeDecision({ ...request, sessionId }, async (decision, message) => {
                automatic = { decision, message }
              })
              if (signal.aborted) return { decision: "deny", message: "Tool turn was cancelled" }
              if (automatic) return automatic
            }
            const pending = awaitApproval(sessionId, request.requestId, { signal })
            store.getState().pushApproval({ ...request, sessionId, status: "pending" })
            try {
              return await pending
            } finally {
              store.getState().clearApproval(request.requestId, sessionId)
            }
          },
        })
        if (hosted.sandboxToolHostLeaseId) sandboxToolHostLeaseIds = [hosted.sandboxToolHostLeaseId]
        const launchContextSignature = JSON.stringify({
          catalog: hosted.catalogFingerprint,
          servers: [...hosted.mcpServers, ...externalMcpServers],
          cwd: sendOptions.cwd,
          additionalDirectories: sendOptions.additionalDirectories ?? [],
          systemPrompt: sendOptions.systemPrompt,
          appendSystemPrompt: sendOptions.appendSystemPrompt,
          permissionMode: sendOptions.permissionMode,
          allowedTools: sendOptions.allowedTools,
        })
        entry.nativeSessionId = resolveNativeExternalSessionId(sessionId, extAgentId, entry)
        if (
          entry.launchContextSignature &&
          entry.launchContextSignature !== launchContextSignature &&
          entry.nativeSessionId
        ) {
          await manager.closeSession(extAgentId, entry.nativeSessionId)
          if (!isCapabilityUsable(profile?.effective["session.resume"]?.level ?? "unknown")) {
            // A protocol without resume starts a fresh native session.
            // Preserve Cognia's transcript explicitly as task context.
            const { renderTranscript } = await import("@/lib/chat/branch-session")
            externalContinuationContext = renderTranscript(externalHistoryMessages)
            resetExternalSession = true
            entry.nativeSessionId = undefined
            useAgentRuntimeStore.getState().setSessionExternalLink(sessionId, undefined)
          }
        }
        entry.launchContextSignature = launchContextSignature
        manager.setSessionHostFacts(extAgentId, sessionId, {
          toolHostRunning: true,
          subagentDispatchProjected:
            sendOptions.pluginTools?.some((tool) => tool.name === "dispatch_agent") ?? false,
          hookRuntimeAvailable: true,
        })
        hostedServerNames = hosted.mcpServers.map((server) => server.name)
        externalMcpServers.unshift(...hosted.mcpServers)
      }
    }
    if (!verifiedNativeResume && compositionForSession(sessionId).verifiedNativeResume) {
      // Once another runtime takes a turn the original native history no
      // longer contains the full conversation. Returning to it needs a
      // fresh contextual handoff, not the stale verification marker.
      const {
        verifiedNativeResume: _verified,
        verifiedNativeResumeAgentId: _agentId,
        ...composition
      } = compositionForSession(sessionId)
      useAgentRuntimeStore.getState().setSessionComposition(sessionId, composition)
    }
    if (resetExternalSession)
      useAgentRuntimeStore.getState().setSessionExternalLink(sessionId, undefined)
    const hostedSession = externalToolHostsRef.current.get(sessionId)
    const matchingHostedNativeSessionId =
      nativeRoute && !resetExternalSession
        ? resolveNativeExternalSessionId(sessionId, extAgentId, hostedSession)
        : undefined
    // A session on THIS route: the gateway task the selection names, or
    // the agent's own session on a native turn. A session on the other
    // route is not one, however recently it ran: switching between the
    // agent's models and Cognia's hands the transcript over instead.
    const hasMatchingExternalSession =
      modelSelection.gatewayLink !== undefined ||
      (nativeRoute &&
        (!!matchingHostedNativeSessionId || !!nativeConversationSessionId || verifiedNativeResume))
    // The memory this route keeps, for the unseen-turns handoff below.
    const externalLane = externalLaneMemory(
      extAgentId,
      externalAgentRouteKey({ sessionId: modelSelection.gatewayLink, cogniaModel })
    )
    if (
      resetExternalSession ||
      externalContinuationContext !== undefined ||
      !hasMatchingExternalSession
    ) {
      const history = externalHistoryMessages
      const imported = session?.importCanonicalState
      const state = imported
        ? {
            tasks: imported.tasks,
            plans: imported.plans,
            goals: imported.goals,
            checkpoints: imported.checkpoints,
            interAgentMessages: imported.interAgentMessages,
          }
        : undefined
      // Same projection, summary and fallback as the unseen-turns handoff
      // below. A shell with no model of its own (a phone driving its
      // Host's agent) hands over the marked excerpt instead of failing
      // the first turn on the new route with `no-client`.
      externalContinuationContext =
        (await foreignTurnsHandoffText(history, {
          sessionId,
          executionRunId,
          ...(state ? { state } : {}),
          client: async () => {
            const { buildAgentBackedLlmClient } =
              await import("@/lib/ai/generation/agent-backed-client")
            return buildAgentBackedLlmClient({
              session,
              appSettings,
              featureId: "handoff",
              label: "Summarize task handoff",
            })
          },
          ...(gatewayController ? { signal: gatewayController.signal } : {}),
        })) || undefined
    } else if (!verifiedNativeResume) {
      // The agent resumes a session on this route, which never saw what
      // any other memory answered since it last did — an `@claude` turn,
      // a stretch on the conversation's own lane between two `@codex`
      // turns, or this same agent on its other route (its own models vs
      // a Cognia task). Only that part of the thread is handed over.
      const unseen = unseenForeignTurns(
        selectVisibleMessages(
          externalHistoryMessages,
          store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
        ),
        externalLane
      )
      if (unseen.length > 0) {
        externalContinuationContext =
          (await foreignTurnsHandoffText(unseen, {
            sessionId,
            executionRunId,
            client: async () => {
              const { buildAgentBackedLlmClient } =
                await import("@/lib/ai/generation/agent-backed-client")
              return buildAgentBackedLlmClient({
                session,
                appSettings,
                featureId: "handoff",
                label: "Summarize task handoff",
              })
            },
            ...(gatewayController ? { signal: gatewayController.signal } : {}),
          })) || undefined
      }
    }
    // All adapters consume prompt text. The custom context field alone
    // is only understood by some runtimes and cannot carry the handoff.
    const assembledExternalPrompt = externalContinuationContext
      ? `${externalContinuationContext}\n\nCurrent user request:\n${externalSendText}`
      : externalSendText
    const externalExecutionPrompt = gateWorkbenchProviderPayload({
      content: assembledExternalPrompt,
      messages: [],
      sendOptions,
    }).content as string
    // The turn's images (attached, or sampled from a video), in a format
    // agents read. The local lane asks this agent and its model what they
    // can see before sending; a Host lane hands them to the Host, which
    // answers the same question against its own agent when the turn
    // starts. Whatever stays behind is named, with what to do about it.
    const { prepareExternalTurnImages, withheldTurnImages } =
      await import("@/lib/ai/agent/external/session/turn-images")
    const turnImages = await prepareExternalTurnImages(externalTurn.images)
    const turnAgentName =
      useExternalAgentStore.getState().agents[extAgentId]?.name ??
      (turnRuntimeRef?.kind === "host" ? turnRuntimeRef.name : undefined)
    const warnExternalUndelivered = (
      omitted: ExternalTurnOmissions,
      withheld: TurnImagesWithheld[]
    ) =>
      warnUndeliveredAttachments(
        "external",
        { omitted, withheld, agent: turnAgentName },
        turnManifest
      )
    let deliveredImages: ExternalAgentImageContent[] = []
    if (hostSelection) {
      deliveredImages = turnImages.ready.map((image) => image.content)
      warnExternalUndelivered(externalTurn.omitted, withheldTurnImages(turnImages, null))
    } else {
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      const imageVerdict =
        turnImages.ready.length > 0
          ? await getExternalAgentManager().resolvePromptAttachments(
              extAgentId,
              turnImages.ready.map((image) => image.content),
              {
                ...(externalModel ? { model: externalModel } : {}),
                ...(cogniaModel !== undefined ? { cogniaModel } : {}),
                // The session the turn continues, whose model list names
                // the model it runs on.
                ...(!resetExternalSession && modelSelection.gatewayLink
                  ? { sessionId: modelSelection.gatewayLink }
                  : nativeConversationSessionId
                    ? { sessionId: nativeConversationSessionId }
                    : {}),
              }
            )
          : null
      deliveredImages = imageVerdict?.delivered ?? []
      warnExternalUndelivered(
        externalTurn.omitted,
        withheldTurnImages(turnImages, imageVerdict?.withheld ?? null)
      )
    }
    // Reuse the completed instruction pipeline, including selected skills,
    // project context and per-turn additions, on the external lane too.
    const externalSystemPrompt = [sendOptions.systemPrompt, sendOptions.appendSystemPrompt]
      .filter((section): section is string => typeof section === "string" && !!section.trim())
      .join("\n\n")

    await assertPersonalContextReaders(sessionId, sendOptions, executionRunId)
    const currentExternalHistory = await preparePersonalHistory(
      sessionId,
      selectVisibleMessages(
        await listMessages(sessionId),
        store.getState().sessions[sessionId]?.activeBranchByGroup ?? {}
      ),
      { executionRunId, session }
    )
    if (currentExternalHistory.visibilityDigest !== externalPersonalHistory.visibilityDigest) {
      await invalidateTranscriptRuntime(sessionId)
      throw new Error("personal_visibility_changed")
    }
    if (isSessionAside && session?.surfaceBinding?.kind === "session") {
      const currentSource = await buildPersonalAsideContext(
        sessionId,
        session.surfaceBinding.sessionId,
        executionRunId
      )
      if (currentSource.visibilityDigest !== personalAsideSourceDigest) {
        await invalidateTranscriptRuntime(sessionId)
        throw new Error("personal_history_context_changed")
      }
    }

    const retainedExecutionSessionId = resetExternalSession
      ? undefined
      : hostSelection
        ? modelSelection.gatewayLink && !modelSelection.rebind
          ? modelSelection.gatewayLink
          : externalSessionLinkForSession(sessionId)?.host
            ? externalSessionLinkForSession(sessionId)?.sessionId
            : undefined
        : verifiedNativeResume && session?.importRuntimeBinding?.nativeSessionId
          ? session.importRuntimeBinding.nativeSessionId
          : (matchingHostedNativeSessionId ??
            modelSelection.gatewayLink ??
            nativeConversationSessionId)
    // Existing sessions need the new digest even when the adapter does
    // not repeat their id in an event or in the completed result.
    persistExternalSession(retainedExecutionSessionId)
    await externalSessionWrite
    if (externalSessionWriteError) throw externalSessionWriteError

    // Two executors, one contract. `executeOnRemoteHostAgent` presents
    // the same `(prompt, { onEvent }) => ExternalAgentResult | null`
    // shape over the companion plane, so everything downstream of this
    // call — the coalescer, the parts, the failure and fallback paths —
    // is shared rather than duplicated per lane.
    const result =
      hostSelection && executeOnRemoteHostAgent && remoteRunId
        ? await executeOnRemoteHostAgent(externalExecutionPrompt, {
            contentSafety: sendOptions.contentSafety,
            // The host's closed turn protocol has no permission override.
            // Read-only asides fall back before here; unlocked asides use
            // the same config stamp/default authority as their main chat.
            stamp: {
              configId: hostSelection.configId,
              revision: hostSelection.revision,
              lifecycleGeneration: hostSelection.lifecycleGeneration,
            },
            chatSessionId: sessionId,
            ...(resetExternalSession ? { resetExternalSession: true } : {}),
            onStarted: (sessionReset: boolean) => {
              remoteRunAccepted = true
              remoteSessionResetAccepted = sessionReset
              persistExternalSession(pendingRemoteSessionId)
            },
            workspaceCapture: { runId: chatRunId, assistantMessageId: assistantId },
            // Only the gateway task the selection names. A native turn
            // after a Cognia one must not hand the Host that task.
            ...(!resetExternalSession && modelSelection.gatewayLink && !modelSelection.rebind
              ? { externalSessionId: modelSelection.gatewayLink }
              : !resetExternalSession && externalSessionLinkForSession(sessionId)?.host
                ? { externalSessionId: externalSessionLinkForSession(sessionId)?.sessionId }
                : {}),
            newRunId: () => remoteRunId,
            ...externalModelAxes,
            systemPrompt: externalSystemPrompt || undefined,
            allowedTools: sendOptions.allowedTools,
            mcpServers: externalMcpServers,
            ...(deliveredImages.length > 0
              ? {
                  attachments: deliveredImages,
                  // The Host's verdict, or the route's (an older Host, a
                  // failed upload), for the images it did not pass on.
                  onAttachmentsWithheld: (verdict: RemoteAttachmentsWithheld) =>
                    warnExternalUndelivered(
                      { attachments: [], unnamed: 0 },
                      withheldTurnImages({ ready: turnImages.ready, unreadable: [] }, verdict)
                    ),
                }
              : {}),
            onEvent: handleExternalEvent,
          })
        : await executePersonalExternalTurn(
            executeOnExternalAgent,
            externalExecutionPrompt,
            {
              contentSafety: sendOptions.contentSafety,
              agentId: extAgentId,
              ...asideExternalPermission,
              ...(gatewayController ? { signal: gatewayController.signal } : {}),
              ...(!resetExternalSession && modelSelection.gatewayLink
                ? { sessionId: modelSelection.gatewayLink }
                : {}),
              // Cognia model A → B on the same task: the agent resumes its
              // own history on the new model (manager checks account,
              // device and runtime are unchanged).
              ...(!resetExternalSession && modelSelection.rebind ? { rebind: true } : {}),
              ...(!resetExternalSession && matchingHostedNativeSessionId
                ? { sessionId: matchingHostedNativeSessionId }
                : {}),
              // Tells the manager not to fall back on the conversation's
              // previous session either: this turn starts a new task.
              ...(resetExternalSession ? { resetExternalSession: true } : {}),
              // Resume the agent's own native session, but only for an
              // import whose binding has been verified. The id comes from
              // the session row, which is where it has always lived. The
              // composition carries the verification decision, nothing more.
              ...(!resetExternalSession &&
              verifiedNativeResume &&
              session?.importRuntimeBinding?.nativeSessionId
                ? { sessionId: session.importRuntimeBinding.nativeSessionId }
                : {}),
              workingDirectory: sendOptions.cwd,
              systemPrompt: externalSystemPrompt || undefined,
              allowedTools: sendOptions.allowedTools,
              ...(deliveredImages.length > 0 ? { attachments: deliveredImages } : {}),
              ...externalModelAxes,
              context: {
                custom: {
                  additionalDirectories: sendOptions.additionalDirectories ?? [],
                  chatSessionId: sessionId,
                  mcpServers: externalMcpServers,
                  ...(sandboxToolHostLeaseIds ? { sandboxToolHostLeaseIds } : {}),
                  ...(externalContinuationContext
                    ? { conversationHistory: externalContinuationContext }
                    : {}),
                },
              },
              onEvent: handleExternalEvent,
            },
            { sessionId, executionRunId }
          )

    sealCoalescer()
    persistExternalSession(result?.sessionId)
    await externalSessionWrite
    if (externalSessionWriteError) throw externalSessionWriteError
    if (gatewayController?.signal.aborted || externalFence?.shouldPersist?.() === false) return true

    if (!result) {
      await handleExternalFailure("No external agent available for this request")
      return true
    }

    if (!result.success) {
      await handleExternalFailure(result.error ?? "External agent execution failed")
      return true
    }

    const hasVisibleText = assistantParts.some(
      (p) => (p as { type?: string }).type === "text" && (p as { text?: string }).text
    )

    // An agent that reported an error and produced nothing did not
    // complete: it was refused, and the provider's own words are the
    // only useful thing to show. Checked before the `finalResponse`
    // fallback below, which would otherwise paint an empty string over
    // the reason. Guarded on there being no text so a turn that
    // recovered and answered is still a success.
    if (!hasVisibleText && externalErrorDetail) {
      await handleExternalFailure(externalErrorDetail)
      return true
    }

    // When the event stream never produced a text track (some agents
    // only emit a single final response), fall back to the assembled
    // finalResponse to make sure the user always sees something.
    if (!hasVisibleText) {
      assistantParts = [
        ...(assistantParts as unknown as Array<Record<string, unknown>>),
        { type: "text", text: result.finalResponse, state: "done" },
      ] as unknown as UIMessage["parts"]
      chatTurnPerformance.markFirstResponse(sessionId)
      writeAssistant()
      sealCoalescer()
    }

    // Persist this session's final list. The slice already holds the
    // live writes (keyed by session), so read it back; fall back to a
    // locally-assembled list if the slice was somehow cleared.
    const externalAgentName =
      useExternalAgentStore.getState().agents[extAgentId]?.name ??
      (turnRuntimeRef?.kind === "host" ? turnRuntimeRef.name : undefined)
    const finalAssistant: UIMessage = {
      id: assistantId,
      role: "assistant",
      parts: assistantParts,
      metadata: {
        ...(delegatedMeta ?? {}),
        ...(replyBranch ??= claimReplyBranch(assistantId)),
        run: { providerId: "external", startedAt: externalStartedAt },
      },
    }
    const completedAt = Date.now()
    const withRun = attachRunMetadataToLastAssistant(
      store.getState().sessions[sessionId]?.messages ?? [...baseList, finalAssistant],
      buildCompletedRunMetadata({
        providerId: "external",
        startedAt: externalStartedAt,
        completedAt,
        reportedDurationMs: result.duration,
        routing: buildRoutingRunMetadata(sendOptions),
        // The agent that answered, not the conversation's agent mode: the
        // reply header named every Kimi Code turn "Standard".
        agent: externalAgentName ? { name: externalAgentName } : turnAgentStamp(sessionId),
        ...(routeStamp ? { route: routeStamp } : {}),
        // Which of the agent's memories answered, so the route resumed
        // next can be told what this one said.
        externalAgent: {
          agentId: extAgentId,
          route: externalAgentRouteKey({
            sessionId: result.sessionId ?? modelSelection.gatewayLink,
            cogniaModel,
          }),
        },
      })
    )
    // The agent's own token accounting — including the context occupancy
    // and window size it reports (ACP `usage_update`, Codex
    // `modelContextWindow`). Without this the turn lands with no usage at
    // all and the context read-out shows an empty window for a session
    // that is anything but.
    const finalMessages = result.tokenUsage
      ? attachUsageToLastAssistant(
          withRun,
          externalTokenUsageToUsageInfo(result.tokenUsage) as unknown as Record<string, unknown>
        )
      : withRun
    store.getState().replaceSessionMessages(sessionId, finalMessages)
    chatTurnPerformance.beginFinalPersistence(sessionId)
    await persistMessages(sessionId, finalMessages, externalFence)
    if (result.tokenUsage) {
      await recordExternalAgentUsage({
        sessionId,
        messageId: assistantId,
        usage: result.tokenUsage,
        model: externalModel ?? cogniaModel?.modelId,
        durationMs: result.duration,
        at: completedAt,
      }).catch((error) => console.warn("recordExternalAgentUsage failed", error))
    }
    chatTurnPerformance.endFinalPersistence(sessionId)
    if (session?.branchSeed) {
      void clearBranchSeed(sessionId).catch((error) =>
        console.error("clearBranchSeed failed", error)
      )
      if (sessionId.startsWith("import:") && session.importOwnership !== "native-bound") {
        void freezeImportedSession(sessionId).catch((error) =>
          console.error("freezeImportedSession failed", error)
        )
      }
    }
    registry.release(sessionId)
    store.getState().setSessionStatus(sessionId, "idle")
    await finishDirectChatExecutionRun(sessionId, "completed")
    chatTurnPerformance.finish(sessionId, "completed")
    const durationMs = finishBehaviorTurn(sessionId)
    if (durationMs !== undefined) {
      void trackEvent("chat.turn.completed", {
        sessionId,
        provider: "external",
        surface: "chat",
        durationMs,
      })
    }
    // Plugin bus: external-agent run finished (ids only).
    emitSystemBusEvent(SystemEvents.MESSAGE_RECEIVED, { sessionId })
    emitSystemBusEvent(SystemEvents.AGENT_COMPLETED, { sessionId })
    externalTurnCompleted = true
  } catch (err) {
    if (gatewayController?.signal.aborted) return true
    const error = err instanceof Error ? err : new Error(String(err))
    await handleExternalFailure(error.message, error)
  } finally {
    try {
      // A turn that wrote no reply (stopped, or failed before its first
      // frame) still has its regenerate slot and edit owner armed, and no
      // `session_ended` drops them on this lane. A sidecar fallback has
      // already armed its own by now, which this leaves alone.
      disarmBranch()
      const hosted = externalToolHostsRef.current.get(sessionId)
      if (hosted) {
        const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
        const manager = getExternalAgentManager()
        const link = externalSessionLinkForSession(sessionId)
        const backgroundTurns =
          link?.agentId === extAgentId && !isGatewaySessionLink(link.sessionId)
            ? await manager
                .getSessionOperationCapabilities(extAgentId, link.sessionId)
                .then((caps) => caps.backgroundTurns === "supported")
                .catch(() => false)
            : false
        // Runtime-advertised autonomous turns retain the session broker
        // and its per-call permission gate between explicit prompts.
        if (!backgroundTurns) {
          if (manager.getAgent(extAgentId)) manager.setSessionHostFacts(extAgentId, sessionId, null)
          await hosted.host
            .pause()
            .catch((error) => console.error("external tool host pause failed", error))
        }
      }
      if (externalGatewayAbortRef.current.get(sessionId) === gatewayController) {
        externalGatewayAbortRef.current.delete(sessionId)
      }
      // However this turn ended, the adapter's waiters are gone. An entry
      // left behind would be an unanswerable dialog pinned over the pane —
      // the approval dialog has no close button, because on the SDK path
      // closing it would orphan a live promise. Released here rather than
      // on each exit path so a throw between them cannot skip it.
      await releaseExternalDecisionSurfaces()
    } finally {
      settleExternalTurn()
      if (externalTurnSettlementsRef.current.get(sessionId) === externalTurnSettlement)
        externalTurnSettlementsRef.current.delete(sessionId)
    }
  }
  // A clean end replays what the user queued behind this turn — the
  // sidecar does this on `session_ended`, and without it a follow-up
  // typed on an external lane with no live steering sat queued forever.
  // After the `finally`, so the next turn cannot race this one's
  // teardown of its decision surfaces.
  if (externalTurnCompleted) {
    // Drive an in-session plan exactly as the sidecar's settle does
    // (`plan-turn-settle.ts`): mark the step done and send the next one.
    const lastAssistant = [...(store.getState().sessions[sessionId]?.messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant")
    const dispatchedNextStep = await driveInSessionPlanAfterTurn({
      sessionId,
      lastResponse: extractAssistantText(lastAssistant),
      isActiveSession: () => sessionId === activeRef.current,
      dispatchNextStep: (userMessage) =>
        void ownedContinuationRef.current?.(userMessage, undefined, {
          sessionId,
          skipUserAppend: true,
        }),
    })
    // Follow-ups queued behind this turn wait for the next settle when a
    // plan step was just dispatched; two turns must never start at once.
    if (!dispatchedNextStep) drainSteerVia(sessionId, ownedContinuationRef)
  }
  if (store.getState().sessions[sessionId]?.errorDiagnostic) return rejectSend()
  return true
}
