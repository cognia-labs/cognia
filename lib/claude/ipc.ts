import {
  personalOperationToolIds,
  personalOperationScope,
} from "@/lib/execution/personal-operation"
// Thin wrapper around the Claude sidecar IPC. Components should use this
// module rather than touching @tauri-apps/api directly — every boundary
// goes through `transport` from `@/lib/tauri`.

import type { Page, PageRequest } from "@/lib/tauri/companion-paging"
import type { UnlistenFn } from "@tauri-apps/api/event"
import type { UIMessage } from "@/types"
import { transport } from "@/lib/tauri"
import type { Transport } from "@/lib/tauri/transport-types"
import { detectHostProfile } from "@/lib/platform/capabilities"
import { getActiveRemoteTransport, isRemoteHostActive } from "@/lib/tauri/transport-routing"
import {
  ExecutionRouteChangedError,
  bindSessionExecutionRoute,
  captureExecutionRoute,
  forgetSessionExecutionRoute,
  sessionControlRoute,
  settleSessionExecutionRoute,
  subscribeSessionEvents,
  type ExecutionRoute,
} from "./execution-route"
import { reportGovernanceProjectionFailure } from "@/lib/db/governance-ledger"
import type {
  AgentId,
  ApprovalDecision,
  ChatSession,
  ClaudeEvent,
  PermissionRequestEvent,
  PluginToolExecEvent,
  SdkContextUsage,
  SdkMcpServerStatus,
  SdkModelInfo,
  SdkSlashCommand,
  SendContent,
  SendOptions,
  SessionApiMethod,
  SessionControlMethod,
  StoredMessage,
  RuntimeSessionStatus,
} from "@cognia/agent-config-types"
import {
  isControlResponseEvent,
  isPluginToolExecEvent,
  isProtocolAdapterCancelEvent,
  isSessionApiResponseEvent,
} from "@cognia/agent-config-types"
import type { PluginToolExecResponse } from "./plugin-tool-ipc"
import type { ProtocolAdapterExecEvent } from "./protocol-adapter-ipc"
import type { ProtocolAdapterCancelEvent } from "@cognia/agent-config-types"
import type {
  ActionReviewActorKind,
  ActionReviewAuthority,
  ActionReviewGrant,
} from "@cognia/agent-config-types/action-review"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { sessionInjectionProtection } from "@/lib/chat/conversation-channel"
import {
  assertSafeModelInput,
  assertSafeModelHistory,
  ContentSafetyBlockedError,
} from "@cognia/content-safety"
import {
  authorizeOutboundToolCall,
  forgetPlannedOutboundToolCall,
} from "@/lib/policy/action-review/authorized-tool-calls"
import {
  isRemoteExecutionContext,
  type RemoteExecutionContext,
} from "@/lib/ai/agent/execution/remote-execution"
import {
  isSessionCapturedByOtherTurn,
  awaitApproval as awaitLocalApproval,
  hasPendingApproval,
  resolveApproval as resolveLocalApproval,
} from "@/lib/claude/hitl/approval-registry"
import { stableHash } from "@/lib/notifications/result/materiality"
import { abortPluginToolCallsForSession } from "./plugin-tool-dispatch-bridge"

const SIDECAR_EVENT = "claude://message"
/** Canonical agent-event channel (ADR-0090 Phase 3). */
const AGENT_EVENT = "agent://message"
const remoteApprovalContexts = new Map<string, RemoteExecutionContext>()
const personalEgressSessions = new Set<{
  sessionId: string
  turnId?: string
  transportIdentity: object
  release: () => void
}>()
// The transport route is part of ownership: an identically named session on
// another host must survive this renderer's Stop or late session-ended event.
const pluginToolSessionContexts = new WeakMap<object, Map<string, RemoteExecutionContext>>()

/**
 * The plugin tool contexts of the Host `route` names, or of the selected Host
 * without one. Local contexts key on the shared transport.
 */
function pluginToolSessionContextsFor(route?: ExecutionRoute): Map<string, RemoteExecutionContext> {
  const remote = route ? (route.remote ? route.identity : null) : getActiveRemoteTransport()
  const key = remote ?? transport
  let contexts = pluginToolSessionContexts.get(key)
  if (!contexts) {
    contexts = new Map()
    pluginToolSessionContexts.set(key, contexts)
  }
  return contexts
}

interface LocalApprovalRequest {
  sessionId: string
  signal: AbortSignal
  ttlMs?: number
  emit(event: ClaudeEvent): void | Promise<void>
}

interface LocalTurnApprovalRequest extends LocalApprovalRequest {
  reason: string
  step: number
  toolName?: never
}

interface LocalToolApprovalRequest extends LocalApprovalRequest {
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  requiresApproval?: boolean
  requiresHumanApproval?: boolean
  requiresPerCallApproval?: boolean
  suppressAlwaysAllowRule?: boolean
  defaultToNo?: boolean
}

export type LocalToolApprovalResult = { allowed: true; input: unknown } | { allowed: false }

/** Local AI SDK turns use the same approval card, response funnel and review receipts. */
export function requestLocalToolApproval(input: LocalTurnApprovalRequest): Promise<boolean>
export function requestLocalToolApproval(
  input: LocalToolApprovalRequest
): Promise<LocalToolApprovalResult>
export async function requestLocalToolApproval(
  input: LocalTurnApprovalRequest | LocalToolApprovalRequest
): Promise<boolean | LocalToolApprovalResult> {
  input.signal.throwIfAborted()
  const toolRequest =
    typeof input.toolName === "string" ? (input as LocalToolApprovalRequest) : undefined
  const toolName = toolRequest?.toolName ?? "agent.turn.decide"
  const denied = () => (toolRequest ? { allowed: false as const } : false)
  const requestId = `local:${globalThis.crypto.randomUUID()}`
  let answered = false
  let expired = false
  const promise = awaitLocalApproval(input.sessionId, requestId, {
    signal: input.signal,
    ttlMs: input.ttlMs,
    onExpire: () => {
      expired = true
    },
  })
  try {
    const { openChatToolReview } = await import("@/lib/policy/action-review/chat-tool-channel")
    await openChatToolReview({
      sessionId: input.sessionId,
      requestId,
      toolName,
    })
    input.signal.throwIfAborted()
    if (!hasPendingApproval(input.sessionId, requestId)) return denied()
    await input.emit({
      type: "permission_request",
      sessionId: input.sessionId,
      requestId,
      toolUseID: toolRequest?.toolUseId ?? requestId,
      toolName,
      input: toolRequest?.input ?? {
        step: (input as LocalTurnApprovalRequest).step,
        reason: (input as LocalTurnApprovalRequest).reason,
      },
      ...(toolRequest
        ? {
            requiresApproval: toolRequest.requiresApproval,
            requiresHumanApproval: toolRequest.requiresHumanApproval,
            requiresPerCallApproval: toolRequest.requiresPerCallApproval,
            suppressAlwaysAllowRule: toolRequest.suppressAlwaysAllowRule,
            defaultToNo: toolRequest.defaultToNo,
          }
        : { requiresPerCallApproval: true, suppressAlwaysAllowRule: true, defaultToNo: true }),
    })
    const answer = await promise
    answered = !expired
    if (answer.decision !== "allow") return denied()
    return toolRequest
      ? {
          allowed: true,
          input: answer.updatedInput ?? toolRequest.input,
        }
      : true
  } finally {
    resolveLocalApproval(input.sessionId, requestId, {
      decision: "deny",
      message: "Local approval owner ended",
    })
    if (!answered) {
      const reason = input.signal.aborted ? "interrupted" : "timeout"
      await recordApprovalReceipt(input.sessionId, requestId, "deny", reason, {
        authority: input.signal.aborted ? "system" : "timeout",
      })
      await input.emit({
        type: "permission_interrupted",
        sessionId: input.sessionId,
        requestId,
        reason,
      })
    }
  }
}

function remoteApprovalKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`
}

/**
 * Read the server-issued execution context attached to one permission ask.
 *
 * Deliberately NON-consuming. Single-use is the Host's contract, not the
 * cache's: `remote_execution::validate_and_consume` moves the key from
 * `pending` to `consumed` and answers `REMOTE_RESPONSE_STALE` on a replay.
 * Mirroring that here bought nothing and broke the request that read second —
 * the canonical and legacy approval paths both look this up, and the loser
 * sent no context to an arm where `remote_execution_context` is required,
 * so its approval was rejected as malformed and the turn stalled at the
 * prompt. Eviction is explicit, via {@link forgetRemoteApprovalContext}.
 */
export function peekRemoteApprovalContext(
  sessionId: string,
  requestId: string
): RemoteExecutionContext | undefined {
  return remoteApprovalContexts.get(remoteApprovalKey(sessionId, requestId))
}

/** Drop a cached context once its ask has been resolved. */
export function forgetRemoteApprovalContext(sessionId: string, requestId: string): void {
  remoteApprovalContexts.delete(remoteApprovalKey(sessionId, requestId))
}

/** Cache the context projected with a permission request event. */
export function rememberRemoteApprovalContext(
  sessionId: string,
  requestId: string,
  context: RemoteExecutionContext
): void {
  remoteApprovalContexts.set(remoteApprovalKey(sessionId, requestId), context)
}

/**
 * Narrow a sidecar frame to a permission ask. Local rather than exported from
 * the contract package because it guards a projection, not a protocol branch:
 * a frame that fails it is simply not audited.
 */
function isPermissionRequestEvent(event: unknown): event is PermissionRequestEvent {
  if (!event || typeof event !== "object") return false
  const candidate = event as Partial<PermissionRequestEvent>
  return (
    candidate.type === "permission_request" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.toolName === "string"
  )
}

/** Frozen replay must keep the transcript generation it was accepted against. */
export class TranscriptRuntimeRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "TranscriptRuntimeRecoveryError"
  }
}

type PromptDelivery = {
  commandId?: string
  /** Renderer admission cancellation; never serialized to the host. */
  signal?: AbortSignal
  /** Synchronous notification at the irreversible transport boundary. */
  onDispatch?: () => void
  /** Renderer-only validation, inside local transcript admission's lock. */
  beforeSend?: () => Promise<void>
  /**
   * `prepared` requires the caller to hold the transcript lock through this
   * receipt. `host-owned` is for a host that keeps its own durable history
   * and has no app transcript row (the CLI writes JSONL and restores provider
   * history itself): the app's Dexie preparation would find no session and
   * hydrate an empty `initialConversation`, restarting the runtime session
   * without history on every turn.
   */
  transcriptRuntime?: "prepared" | "frozen" | "host-owned"
  /**
   * The user message this turn sends. Only a paired host receives it: the
   * host admits the turn under this id (`paired_turn_admit`), so its copy of
   * the transcript keeps the row this client already shows.
   */
  messageId?: string
  /**
   * The Host this turn was pinned to when its listener subscribed. The send
   * goes there, or is refused if the selection changed in between, and the
   * session's later interrupt and close follow it (postfix review P05).
   */
  route?: ExecutionRoute
}

// An AI-SDK runtime retains MCP clients across turns. A changed credential map
// must rebuild that runtime even when transcript/model policy otherwise matches.
const sentMcpConfigurations = new Map<string, { configuration: string; generation?: string }>()

/** Unknown renderer state cannot prove a retained engine's credentials. */
export function mcpRuntimeConfigurationMatches(
  sessionId: string,
  options: SendOptions,
  generation = options.transcriptInvalidationId
): boolean {
  const previous = sentMcpConfigurations.get(sessionId)
  // A different window advances the existing transcript generation before it
  // replaces a credential map. Our old in-memory map cannot bless its engine.
  return (
    !!generation &&
    previous?.generation === generation &&
    previous.configuration === stableHash(JSON.stringify(options.mcpServers ?? {}))
  )
}

export async function sendPrompt(
  sessionId: string,
  prompt: SendContent,
  options?: SendOptions,
  delivery?: PromptDelivery
): Promise<void> {
  delivery?.signal?.throwIfAborted()
  let personalExecutionRunId: string | undefined
  // Bind the existing turn/attempt wire to the canonical host run before dispatch.
  if (options?.turnId) {
    const { bindToolCallRun, toolCallExecutionRunId } =
      await import("@/lib/execution/acting-authority")
    // Connector recovery binds its current attempt at Host dispatch. Provider
    // execution.identity is stable routing data, never credential authority.
    const boundRunId = toolCallExecutionRunId(
      sessionId,
      options.turnId,
      options.execution?.identity?.attemptId
    )
    // An unbound turn never adopts a concurrent turn from this session.
    personalExecutionRunId = boundRunId || undefined
    bindToolCallRun(
      sessionId,
      options.turnId,
      personalExecutionRunId,
      options.execution?.identity?.attemptId,
      // This entry dispatches to the builtin transport; external engines use
      // their separate controller rail. Never infer this from a session label.
      { builtinRuntime: true }
    )
  }
  // A mirrored row is not the execution host's transcript authority. Preserve
  // host-issued options on remote sends; frozen local replay needs a local row.
  if (turnsRunOnPairedHost()) {
    if (delivery?.transcriptRuntime === "frozen") {
      throw new TranscriptRuntimeRecoveryError("frozen_transcript_host_unverified")
    }
    const { getSession } = await import("@/lib/db/sessions")
    const mirror = await getSession(sessionId)
    if (mirror?.runtimeTranscriptGeneration || mirror?.runtimeTranscriptInvalidated) {
      throw new TranscriptRuntimeRecoveryError("transcript_authoritative_host_required")
    }
    // The Host re-derives audience and canonical history at admission. A mirror
    // cannot attest a digest or supply the history used to rebuild its engine.
    const pairedOptions = { ...options }
    for (const key of [
      "personalVisibilityDigest",
      "personalContextReadersDigest",
      "personalVisibilityHasWithheld",
      "initialConversation",
      "priorMessages",
      "history",
      "runtimeHistory",
    ]) {
      delete (pairedOptions as Record<string, unknown>)[key]
    }
    return sendPromptToTransport(sessionId, prompt, pairedOptions, delivery, { pairedHost: true })
  }
  if (delivery?.transcriptRuntime === "prepared" || delivery?.transcriptRuntime === "host-owned") {
    if (delivery.transcriptRuntime === "prepared") {
      await assertPersonalVisibilityDigest(sessionId, options, false, personalExecutionRunId)
    }
    if (
      delivery.transcriptRuntime === "prepared" &&
      options?.expectedRuntimeSessionId &&
      !mcpRuntimeConfigurationMatches(sessionId, options)
    ) {
      const { prepareTranscriptRuntimeSend } = await import("@/hooks/chat/claude-chat-send-options")
      options = await prepareTranscriptRuntimeSend(sessionId, options, {
        currentMessageId: delivery.messageId,
        executionRunId: personalExecutionRunId,
      })
    }
    return sendPromptToTransport(sessionId, prompt, options, delivery)
  }
  const { withTranscriptRuntimeLock } = await import("@/lib/chat/transcript/revision-events")
  await withTranscriptRuntimeLock(sessionId, async () => {
    if (delivery?.transcriptRuntime === "frozen") {
      const { getSession } = await import("@/lib/db/sessions")
      const session = await getSession(sessionId)
      if (!session) throw new TranscriptRuntimeRecoveryError("frozen_transcript_session_missing")
      if (options?.transcriptInvalidationId !== session.runtimeTranscriptGeneration) {
        throw new TranscriptRuntimeRecoveryError("frozen_transcript_generation_mismatch")
      }
      await assertPersonalVisibilityDigest(sessionId, options, false, personalExecutionRunId)
      return sendPromptToTransport(sessionId, prompt, options, delivery)
    }
    const { prepareTranscriptRuntimeSend } = await import("@/hooks/chat/claude-chat-send-options")
    const prepared = await prepareTranscriptRuntimeSend(sessionId, options ?? {}, {
      currentMessageId: delivery?.messageId,
      executionRunId: personalExecutionRunId,
    })
    return sendPromptToTransport(
      sessionId,
      prompt,
      options || Object.values(prepared).some((value) => value !== undefined)
        ? prepared
        : undefined,
      delivery
    )
  })
}

/** An async admission/steer may tighten readers after history was prepared. */
async function assertPersonalVisibilityDigest(
  sessionId: string,
  options?: SendOptions,
  allowFullyVisibleEngine = false,
  executionRunId?: string
): Promise<void> {
  const [
    { getSession, updateSession },
    { listMessages },
    { selectVisibleMessages },
    { preparePersonalHistory },
  ] = await Promise.all([
    import("@/lib/db/sessions"),
    import("@/lib/db/messages"),
    import("@/stores/chat"),
    import("@/lib/execution/personal-visibility"),
  ])
  const session = await getSession(sessionId)
  if (
    !session &&
    !options?.personalVisibilityDigest &&
    !options?.personalContextReadersDigest &&
    !options?.resumeSessionId &&
    !options?.forkFromSessionId &&
    !options?.expectedRuntimeSessionId &&
    !options?.initialConversation?.length
  )
    return
  const filtered = await preparePersonalHistory(
    sessionId,
    selectVisibleMessages(await listMessages(sessionId), session?.activeBranchByGroup ?? {}),
    { session, executionRunId }
  )
  if (allowFullyVisibleEngine && filtered.withheldMessageIds.length === 0) {
    if (session && session.runtimePersonalVisibilityDigest !== filtered.visibilityDigest) {
      await updateSession(sessionId, { runtimePersonalVisibilityDigest: filtered.visibilityDigest })
    }
    return
  }
  if (
    options?.personalVisibilityDigest !== filtered.visibilityDigest ||
    session?.runtimePersonalVisibilityDigest !== filtered.visibilityDigest
  ) {
    throw new TranscriptRuntimeRecoveryError("personal_visibility_changed")
  }
}

/** An ACK and its lifecycle belong to one concrete Host, never the routing facade. */
async function fencePersonalSession(
  target: Transport,
  sessionId: string,
  excludedToolUseIds: readonly string[] = []
): Promise<void> {
  const requestId = crypto.randomUUID()
  let resolve!: () => void
  let reject!: (error: Error) => void
  const ack = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  const unlisten = await target.subscribe<ClaudeEvent>(SIDECAR_EVENT, (event) => {
    if (
      !isControlResponseEvent(event) ||
      event.requestId !== requestId ||
      event.sessionId !== sessionId
    )
      return
    if (
      event.ok &&
      (event.result as { personalEgressFenced?: boolean })?.personalEgressFenced === true
    )
      resolve()
    else reject(new Error("Personal egress fence was not acknowledged; private content withheld"))
  })
  const timer = setTimeout(
    () => reject(new Error("Personal egress fence timed out; private content withheld")),
    CONTROL_TIMEOUT_MS
  )
  try {
    await Promise.all([
      ack,
      target.call("claude_session_control", {
        sessionId,
        requestId,
        method: "updateSettings",
        params: {
          personalEgressFence: true,
          ...(excludedToolUseIds.length
            ? { personalEgressExcludeToolUseIds: excludedToolUseIds }
            : {}),
        },
      }),
    ])
  } finally {
    clearTimeout(timer)
    unlisten()
  }
}

async function sendPromptToTransport(
  sessionId: string,
  prompt: SendContent,
  options?: SendOptions,
  delivery?: PromptDelivery,
  route: { pairedHost?: boolean } = {}
): Promise<void> {
  if (isSessionCapturedByOtherTurn(sessionId, options?.turnId))
    throw new TranscriptRuntimeRecoveryError("session_turn_busy")
  await delivery?.beforeSend?.()
  if (
    !route.pairedHost &&
    delivery?.transcriptRuntime !== "host-owned" &&
    options?.personalVisibilityDigest
  ) {
    await assertPersonalVisibilityDigest(sessionId, options)
  }
  if (isSessionCapturedByOtherTurn(sessionId, options?.turnId))
    throw new TranscriptRuntimeRecoveryError("session_turn_busy")
  const sdk = options?.claudeAgentSdk
  if (
    !hasNoLeakingPiiDeep({
      prompt,
      ...(options?.initialConversation ? { initialConversation: options.initialConversation } : {}),
      systemPrompt: options?.systemPrompt,
      appendSystemPrompt: options?.appendSystemPrompt,
      ...(options?.agents ? { agents: options.agents } : {}),
      ...(options?.pluginTools ? { pluginTools: options.pluginTools } : {}),
      ...(sdk
        ? {
            claudeAgentSdk: {
              outputFormat: sdk.outputFormat,
              permissionPromptToolName: sdk.permissionPromptToolName,
              planModeInstructions: sdk.planModeInstructions,
              skills: sdk.skills,
              toolAliases: sdk.toolAliases,
              toolConfig: sdk.toolConfig,
              tools: sdk.tools,
            },
          }
        : {}),
    })
  ) {
    throw new Error("prompt rejected by the renderer PII gate")
  }
  // Recheck after request middleware without changing the PII or text contract.
  // System instructions are Host-authored and are not inbound user content.
  if (options?.contentSafety?.injectionProtection === true) {
    assertSafeModelInput(prompt)
    if (options.initialConversation) assertSafeModelHistory(options.initialConversation)
  }
  // A send that names no route pins one now, the Host it dispatches to, so
  // the session's controls, answers and events stay with that Host after
  // another is selected (postfix review P05). It lets the Host go once the
  // turn ends.
  const own = delivery?.route ? null : captureExecutionRoute()
  try {
    await dispatchPrompt(sessionId, prompt, options, delivery, route, delivery?.route ?? own!, own)
  } finally {
    own?.release()
  }
}

async function dispatchPrompt(
  sessionId: string,
  prompt: SendContent,
  options: SendOptions | undefined,
  delivery: PromptDelivery | undefined,
  route: { pairedHost?: boolean },
  pinned: ExecutionRoute,
  own: ExecutionRoute | null
): Promise<void> {
  if (!pinned.isCurrent()) throw new ExecutionRouteChangedError(pinned.key)
  const dispatchTransport = pinned.identity
  const { personalEgressFenced, bindPersonalEgressSession } =
    await import("@/lib/execution/personal-egress")
  const { toolCallExecutionRunId } = await import("@/lib/execution/acting-authority")
  const context = {
    sessionId,
    executionRunId:
      toolCallExecutionRunId(sessionId, options?.turnId, options?.execution?.identity?.attemptId) ??
      "",
  }
  const fenced = await personalEgressFenced(context)
  if (fenced) options = { ...options, personalEgressFenced: true }
  if (!fenced && context.executionRunId && options?.personalEgressFenced !== true) {
    // Own a lifecycle subscription even for callers without a chat capture.
    // The control/ACK listener itself stays lazy until a fence is requested.
    const transportIdentity = dispatchTransport
    let unlistenPersonal: UnlistenFn = () => {}
    for (const previous of personalEgressSessions)
      if (previous.sessionId === sessionId && previous.transportIdentity === transportIdentity) {
        previous.release()
        personalEgressSessions.delete(previous)
      }
    const binding = {
      sessionId,
      turnId: options?.turnId,
      transportIdentity,
      release: bindPersonalEgressSession(context, async (admission) => {
        await fencePersonalSession(
          transportIdentity,
          sessionId,
          personalOperationToolIds(
            admission,
            sessionId,
            personalOperationScope(pluginToolSessionContexts.get(transportIdentity)?.get(sessionId))
          )
        )
        binding.release()
        personalEgressSessions.delete(binding)
      }),
    }
    const releaseRun = binding.release
    binding.release = () => {
      releaseRun()
      unlistenPersonal()
    }
    personalEgressSessions.add(binding)
    unlistenPersonal = await transportIdentity.subscribe<ClaudeEvent>(SIDECAR_EVENT, (event) => {
      if (
        event.type !== "session_ended" ||
        event.sessionId !== sessionId ||
        event.turnId !== binding.turnId
      )
        return
      binding.release()
      personalEgressSessions.delete(binding)
    })
    // The listener setup yielded; context may have become personal meanwhile.
    if (await personalEgressFenced(context)) options = { ...options, personalEgressFenced: true }
  }
  const messageId = route.pairedHost ? delivery?.messageId : undefined
  // Router + Fusion's routing inputs are renderer-only (a reseal reads them
  // from the cached or frozen options); the host never needs the prompt twice.
  let wireOptions = options
  if (options && "routerFusionRouting" in options) {
    const { routerFusionRouting: _renderOnly, ...rest } = options
    wireOptions = rest
  }
  const mcpConfiguration = stableHash(JSON.stringify(wireOptions?.mcpServers ?? {}))
  // ADR-0243: reserve from the run tree's ledger at dispatch, after preparation.
  const budget = await reserveTurnBudget(
    pinned,
    sessionId,
    context.executionRunId,
    options,
    delivery
  )
  if (budget) wireOptions = { ...wireOptions, runBudget: budget.bounds }
  // No await between this check and dispatch: cancelled admission cannot
  // lazily restart the Rust sidecar after its capture has declared it stopped.
  try {
    delivery?.signal?.throwIfAborted()
    if (!pinned.isCurrent()) throw new ExecutionRouteChangedError(pinned.key)
  } catch (error) {
    // Nothing was dispatched, so nothing can still spend this hold.
    await budget?.settle({ inputTokens: 0, outputTokens: 0 }, true)
    throw error
  }
  bindSessionExecutionRoute(sessionId, pinned)
  // A route this send pinned itself has no listener to settle it: the turn's
  // end on that Host does. Subscribed before dispatch, so a fast end is heard.
  let unlistenEnd: (() => void) | null = null
  const settleOwn = () => {
    unlistenEnd?.()
    unlistenEnd = null
    if (own) settleSessionExecutionRoute(sessionId, own)
  }
  if (own) {
    unlistenEnd = own.transport.subscribe<ClaudeEvent>(SIDECAR_EVENT, (event) => {
      if (event.type !== "session_ended" || event.sessionId !== sessionId) return
      if (options?.turnId && event.turnId && event.turnId !== options.turnId) return
      settleOwn()
    })
  }
  delivery?.onDispatch?.()
  try {
    await pinned.transport.call("agent_send", {
      sessionId,
      prompt,
      options: wireOptions,
      ...(delivery?.commandId ? { commandId: delivery.commandId } : {}),
      ...(messageId ? { messageId } : {}),
    })
  } catch (error) {
    settleOwn()
    // A failed ACK may still have delivered the request: no stop proof.
    await budget?.settle(undefined, false)
    throw error
  }
  sentMcpConfigurations.set(sessionId, {
    configuration: mcpConfiguration,
    generation: wireOptions?.transcriptInvalidationId,
  })
}

/**
 * One sidecar turn's ledger hold. Usage comes from the turn's result; stop
 * proof is the executor's own: the turn settled with nothing left running, or
 * the executor was disposed. A sidecar that exits proves nothing, so the whole
 * hold is charged.
 */
async function reserveTurnBudget(
  pinned: ExecutionRoute,
  sessionId: string,
  runId: string,
  options: SendOptions | undefined,
  delivery: PromptDelivery | undefined
) {
  const { beginRailBudget } = await import("@/lib/execution/run-budget-rail")
  const budget = await beginRailBudget(
    runId,
    { providerId: options?.provider, modelId: options?.model ?? "" },
    {
      ...(options?.maxBudgetUsd !== undefined ? { caps: { costUsd: options.maxBudgetUsd } } : {}),
      ...(delivery?.signal ? { signal: delivery.signal } : {}),
    }
  )
  if (!budget) return undefined
  const bounds = {
    ...(budget.tokens !== undefined ? { tokens: budget.tokens } : {}),
    ...(budget.deadlineAt !== undefined ? { deadlineAt: budget.deadlineAt } : {}),
  }
  const { extractUsage } = await import("./adapter")
  let usage: import("@/lib/execution/run-budget-rail").MeteredUsage | undefined
  let executorId: string | undefined
  const interrupt = () =>
    void pinned.transport.call("agent_interrupt", { sessionId }).catch(() => undefined)
  budget.signal.addEventListener("abort", interrupt, { once: true })
  let unlisten: UnlistenFn = () => {}
  let settled: Promise<void> | undefined
  const settle = (final: typeof usage, confirmed: boolean) =>
    (settled ??= (async () => {
      unlisten()
      budget.signal.removeEventListener("abort", interrupt)
      await budget.finish(final, confirmed)
    })())
  unlisten = pinned.transport.subscribe<ClaudeEvent>(SIDECAR_EVENT, (event) => {
    const lifecycle = event as {
      type: string
      sessionId?: string
      turnId?: string
      executorId?: string
      backgroundProcessesRunning?: boolean
    }
    if (lifecycle.type === "sidecar_exited") return void settle(usage, false)
    if (lifecycle.sessionId !== sessionId) return
    const ours = !options?.turnId || lifecycle.turnId === options.turnId
    if (lifecycle.type === "executor_started" && ours) executorId = lifecycle.executorId
    if (!ours && (!executorId || lifecycle.executorId !== executorId)) return
    if (event.type === "session_ended") {
      // A send the sidecar refused before any executor bound it spent nothing.
      if ((event as { sendRefused?: boolean }).sendRefused && !executorId)
        return void settle({ inputTokens: 0, outputTokens: 0 }, true)
      const result = event.result ? extractUsage(event.result) : null
      usage = result
        ? {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheReadInputTokens,
            cacheCreationTokens: result.cacheCreationInputTokens,
            // The generic (AI-SDK) lane reports 0 for a turn it did not price;
            // the rail prices those tokens itself.
            ...(result.totalCostUsd ? { costUsd: result.totalCostUsd } : {}),
          }
        : undefined
      if (usage) void budget.report(usage).catch(() => undefined)
    } else if (
      lifecycle.type === "session_disposed" ||
      (lifecycle.type === "turn_settled" && lifecycle.backgroundProcessesRunning === false)
    )
      void settle(usage, true)
  })
  return { bounds, settle }
}

/**
 * Subscribe to canonical `AgentEventEnvelope` frames (ADR-0090 Phase 3).
 * Emitted only for sessions that carry a frozen execution spec — legacy
 * sessions produce nothing here.
 */
export async function subscribeAgentEvents(
  onEnvelope: (
    envelope: import("@cognia/agent-config-types/agent-execution").AgentEventEnvelope
  ) => void,
  route?: ExecutionRoute
): Promise<UnlistenFn> {
  const { isAgentEventEnvelope } = await import("@cognia/agent-config-types/agent-execution")
  const onPayload = (payload: { type: string; envelope?: unknown }) => {
    const envelope = payload?.envelope
    if (isAgentEventEnvelope(envelope)) onEnvelope(envelope)
  }
  if (route) return route.transport.subscribe(AGENT_EVENT, onPayload)
  return subscribeSessionEvents<{ type: string; envelope?: unknown }>(
    AGENT_EVENT,
    (payload) => sessionOfEvent(payload?.envelope),
    onPayload
  )
}

export async function interruptSession(
  sessionId: string,
  options?: { commandId?: string; route?: ExecutionRoute }
): Promise<void> {
  const target = sessionControlRoute(sessionId, options?.route)
  const context = pluginToolSessionContextsFor(target.route).get(sessionId)
  // An unknown remote identity must never fall through to local cancellation.
  if (context || !target.remote) abortPluginToolCallsForSession(sessionId, "interrupted", context)
  await target.transport.call("agent_interrupt", {
    sessionId,
    ...(options?.commandId ? { commandId: options.commandId } : {}),
  })
}

/**
 * Manually compact a running session's context. Mirrors {@link interruptSession}
 * — a fire-and-forget control message routed to the sidecar. On the generic
 * (AI-SDK) path the sidecar runs a summary round-trip now; on the Anthropic
 * path it pushes a `/compact` turn the Agent SDK intercepts. `focus` is the
 * optional compact-instruction argument (e.g. from `/compact <focus>`).
 */
export async function compactSession(
  sessionId: string,
  focus?: string,
  options?: {
    commandId?: string
    hostOwnedTranscriptControl?: typeof HOST_OWNED_TRANSCRIPT_CONTROL
  }
): Promise<void> {
  if (!hasNoLeakingPiiDeep(focus)) throw new Error("compact rejected by the renderer PII gate")
  const hostOwned = options?.hostOwnedTranscriptControl === HOST_OWNED_TRANSCRIPT_CONTROL
  const protection = hostOwned ? undefined : await sessionInjectionProtection(sessionId)
  assertSafeModelInput(focus, hostOwned || protection === true)
  await assertCurrentControlContentPolicy(sessionId, protection)
  await assertPersonalControlVisibility(sessionId, options)
  await sessionControlRoute(sessionId).transport.call("agent_compact", {
    sessionId,
    focus,
    ...(options?.commandId ? { commandId: options.commandId } : {}),
  })
}

/**
 * Undo a prior compaction by restoring the pre-compaction message snapshot.
 * Mirrors {@link compactSession}: a fire-and-forget control message. `messages`
 * is the sidecar-format snapshot captured on the `compact_boundary` event
 * (`compact_metadata.pre_messages`) — NOT renderer UIMessages. Only valid on the
 * generic (AI-SDK) path while the session is still live and idle.
 */
export async function restoreSession(
  sessionId: string,
  messages: unknown[],
  options?: { hostOwnedTranscriptControl?: typeof HOST_OWNED_TRANSCRIPT_CONTROL }
): Promise<void> {
  if (!hasNoLeakingPiiDeep(messages)) {
    throw new Error("session restore rejected by the renderer PII gate")
  }
  const hostOwned = options?.hostOwnedTranscriptControl === HOST_OWNED_TRANSCRIPT_CONTROL
  const protection = hostOwned ? undefined : await sessionInjectionProtection(sessionId)
  assertSafeModelHistory(messages, hostOwned || protection === true)
  await assertCurrentControlContentPolicy(sessionId, protection)
  await assertPersonalControlVisibility(sessionId, options)
  await sessionControlRoute(sessionId).transport.call("claude_restore", { sessionId, messages })
}

/** Only the CLI's canonical transcript owner may supply this in-process proof. */
export const HOST_OWNED_TRANSCRIPT_CONTROL = Symbol("host-owned-transcript-control")

async function assertPersonalControlVisibility(
  sessionId: string,
  options?: { hostOwnedTranscriptControl?: typeof HOST_OWNED_TRANSCRIPT_CONTROL }
): Promise<void> {
  if (
    options?.hostOwnedTranscriptControl === HOST_OWNED_TRANSCRIPT_CONTROL ||
    turnsRunOnPairedHost()
  )
    return
  const { getSession } = await import("@/lib/db/sessions")
  const session = await getSession(sessionId)
  if (!session) throw new TranscriptRuntimeRecoveryError("personal_visibility_changed")
  try {
    await assertPersonalVisibilityDigest(
      sessionId,
      {
        personalVisibilityDigest: session.runtimePersonalVisibilityDigest,
      },
      true
    )
  } catch (error) {
    if (
      error instanceof TranscriptRuntimeRecoveryError &&
      error.code === "personal_visibility_changed"
    ) {
      const { invalidateTranscriptRuntime } = await import("@/lib/chat/transcript/revision-events")
      await invalidateTranscriptRuntime(sessionId)
    }
    throw error
  }
}

/** A control cannot keep an older tool/history policy after the Host setting changes. */
async function assertCurrentControlContentPolicy(
  sessionId: string,
  current: boolean | undefined
): Promise<void> {
  if (current === undefined) return
  const runtime = await sessionControl<RuntimeSessionStatus>(sessionId, "runtimeStatus")
  if (runtime?.contentSafety?.injectionProtection !== current)
    throw new ContentSafetyBlockedError(["runtime_content_safety_changed"])
}

/**
 * Change a running session's permission mode in place — without tearing down
 * and respawning the sidecar (which would lose the in-process conversation).
 * Mirrors {@link compactSession}: a fire-and-forget control message. On the
 * Anthropic path the sidecar calls the live SDK `Query.setPermissionMode`; on
 * both paths it mutates the session's `sendOptions.permissionMode` so the next
 * tool gate honours the change.
 */
export async function setSessionMode(
  sessionId: string,
  mode: NonNullable<SendOptions["permissionMode"]>,
  options?: { commandId?: string }
): Promise<void> {
  const result = await sessionControl<{ mode: NonNullable<SendOptions["permissionMode"]> }>(
    sessionId,
    "setPermissionMode",
    { mode },
    options
  )
  if (result?.mode !== mode)
    throw new Error("Runtime did not acknowledge the requested permission mode")
}

// ---- Live session introspection & control (SDK Query control methods) ----
//
// The renderer drives the Claude Agent SDK `Query`'s streaming-input-only
// control methods on a LIVE session through a request/response round-trip:
// `claude_session_control` writes a `control` line to the sidecar stdin; the
// sidecar invokes `q[method](...)` and replies with a `control_response` event
// (correlated by `requestId`) on the same `claude://message` channel. The
// correlation reuses the single `onClaudeMessage` subscription — exactly like
// {@link subscribePluginToolExec} — so it is decoupled from the chat hook's
// lifecycle (the Settings MCP tab can call it with no chat mounted).

interface PendingControl {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingControl = new Map<string, PendingControl>()
/** Lazily-created singleton listener that settles `control_response` events. */
let controlListener: Promise<UnlistenFn> | null = null

function ensureControlListener(): Promise<UnlistenFn> {
  if (!controlListener) {
    controlListener = onClaudeMessage((evt) => {
      // Fail-fast on a sidecar crash/restart: the PROCESS died, so every
      // in-flight control request (model picker, MCP settings action,
      // context-usage poll) can never be answered. Reject them now instead of
      // each waiting out CONTROL_TIMEOUT_MS — mirrors run-and-capture's
      // `sidecar_exited` posture so a control issued just before a restart
      // doesn't hang the UI for 8s.
      if (evt.type === "sidecar_exited") {
        for (const [id, pending] of pendingControl) {
          pendingControl.delete(id)
          clearTimeout(pending.timer)
          pending.reject(new Error("sidecar exited"))
        }
        return
      }
      // Both round-trips settle here. They share the map because they share a
      // requestId space and the crash handling above: a session_api call
      // orphaned by a sidecar restart is exactly as unanswerable as a control.
      if (!isControlResponseEvent(evt) && !isSessionApiResponseEvent(evt)) return
      const pending = pendingControl.get(evt.requestId)
      if (!pending) return
      pendingControl.delete(evt.requestId)
      clearTimeout(pending.timer)
      if (evt.ok) pending.resolve(evt.result)
      else pending.reject(new Error(evt.error ?? "control_failed"))
    })
  }
  return controlListener
}

/** Reject if the sidecar hasn't replied within this window. */
const CONTROL_TIMEOUT_MS = 8000

/**
 * Invoke an allowlisted SDK `Query` control method on a live session and await
 * its result. Rejects with `control "<method>" timed out` after
 * {@link CONTROL_TIMEOUT_MS}, or with the sidecar's stable error code
 * (`no_active_session` | `unsupported_provider` | `unknown_method`) when the
 * call can't run. Anthropic-path + open-session only — callers degrade
 * gracefully on rejection.
 */
async function sidecarRoundTrip<T>(
  command: string,
  buildArgs: (requestId: string) => Record<string, unknown>,
  label: string,
  timeoutMs: number,
  beforeDispatch?: () => Promise<void>,
  via: Pick<Transport, "call"> = transport
): Promise<T> {
  // Await the subscription before firing so a fast reply can't race the listener.
  await ensureControlListener()
  await beforeDispatch?.()
  const requestId = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingControl.delete(requestId)
      reject(new Error(`${label} timed out`))
    }, timeoutMs)
    pendingControl.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    })
    via.call(command, buildArgs(requestId)).catch((err) => {
      const pending = pendingControl.get(requestId)
      if (!pending) return
      pendingControl.delete(requestId)
      clearTimeout(timer)
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

async function sessionControlRequest<T>(
  sessionId: string,
  method: SessionControlMethod,
  params?: Record<string, unknown>,
  options?: {
    commandId?: string
    hostOwnedTranscriptControl?: typeof HOST_OWNED_TRANSCRIPT_CONTROL
  }
): Promise<T> {
  return sidecarRoundTrip<T>(
    "claude_session_control",
    (requestId) => ({ sessionId, requestId, method, params, commandId: options?.commandId }),
    `control "${method}"`,
    CONTROL_TIMEOUT_MS,
    method === "steer" ? () => assertPersonalControlVisibility(sessionId, options) : undefined,
    // The reply comes back from the same Host through the session-aware listener.
    sessionControlRoute(sessionId).transport
  )
}

export async function sessionControl<T = unknown>(
  sessionId: string,
  method: Exclude<SessionControlMethod, "steer">,
  params?: Record<string, unknown>,
  options?: { commandId?: string }
): Promise<T> {
  if ((method as SessionControlMethod) === "steer") {
    throw new Error("steer must use the PII-gated steerSession wrapper")
  }
  return sessionControlRequest<T>(sessionId, method, params, options)
}

/** Live context-window usage from the SDK (authoritative window + breakdown). */
export function getSessionContextUsage(sessionId: string): Promise<SdkContextUsage> {
  return sessionControl<SdkContextUsage>(sessionId, "getContextUsage", {
    options: { detail: "summary" },
  })
}

/** Live MCP client status for the running session (one entry per server). */
export function getSessionMcpStatus(sessionId: string): Promise<SdkMcpServerStatus[]> {
  return sessionControl<SdkMcpServerStatus[]>(sessionId, "mcpServerStatus")
}

/**
 * Reconnect a failed/needs-auth MCP server on the running session.
 *
 * The wire param is `serverName`, matching the SDK's own parameter name. Every
 * control's params are named after the SDK signature so that
 * `protocol/agent-control-methods.json` can carry one `args` list and the gate
 * can compare it against `controlArgs` — the old `name` here was the single
 * exception, and it was already out of step with the manifest.
 */
export function reconnectSessionMcpServer(sessionId: string, serverName: string): Promise<void> {
  return sessionControl<void>(sessionId, "reconnectMcpServer", { serverName })
}

/** Enable/disable an MCP server on the running session. */
export function toggleSessionMcpServer(
  sessionId: string,
  serverName: string,
  enabled: boolean
): Promise<unknown> {
  return sessionControl<unknown>(sessionId, "toggleMcpServer", { serverName, enabled })
}

/** Account-authoritative model list (with per-model capability flags). */
export function getSessionSupportedModels(sessionId: string): Promise<SdkModelInfo[]> {
  return sessionControl<SdkModelInfo[]>(sessionId, "supportedModels")
}

/** Agent-facing slash-command list as the SDK currently sees it. */
export function getSessionSupportedCommands(sessionId: string): Promise<SdkSlashCommand[]> {
  return sessionControl<SdkSlashCommand[]>(sessionId, "supportedCommands")
}

/** Switch the model on the running query in place (no session restart). */
export function setSessionModel(
  sessionId: string,
  model: string,
  options?: { commandId?: string }
): Promise<void> {
  return sessionControl<void>(sessionId, "setModel", { model }, options)
}

/**
 * Queue a user message into the active Anthropic streaming-input query.
 * Success acknowledges sidecar queue acceptance only; the SDK applies the
 * message at its next supported boundary and may not mutate an HTTP request
 * that is already in flight.
 */
export async function steerSession(
  sessionId: string,
  prompt: SendContent,
  sourceMessageId?: string,
  options?: {
    priority?: "now" | "next"
    commandId?: string
    hostOwnedTranscriptControl?: typeof HOST_OWNED_TRANSCRIPT_CONTROL
  }
): Promise<{ accepted: true }> {
  if (!hasNoLeakingPiiDeep(prompt)) {
    throw new Error("live-steer prompt rejected by the renderer PII gate")
  }
  const hostOwned = options?.hostOwnedTranscriptControl === HOST_OWNED_TRANSCRIPT_CONTROL
  const protection = hostOwned ? undefined : await sessionInjectionProtection(sessionId)
  assertSafeModelInput(prompt, hostOwned || protection === true)
  await assertPersonalControlVisibility(sessionId, options)
  return sessionControlRequest<{ accepted: true }>(
    sessionId,
    "steer",
    {
      prompt,
      priority: options?.priority ?? "now",
      ...(protection !== undefined ? { contentSafety: { injectionProtection: protection } } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
    },
    options
  )
}

export interface RewindFilesResult {
  status: "ready" | "unavailable" | "unknown"
  reason?: string
  paths: string[]
}

/** Normalize SDK-version-specific rewind previews at the IPC boundary. */
export function normalizeRewindFilesResult(value: unknown): RewindFilesResult {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const candidates = [record.paths, record.files, record.affectedFiles, record.changedFiles]
  const paths =
    candidates.find(Array.isArray)?.flatMap((item) => {
      if (typeof item === "string" && item) return [item]
      if (!item || typeof item !== "object") return []
      const row = item as Record<string, unknown>
      const path = row.path ?? row.filePath ?? row.file_path
      return typeof path === "string" && path ? [path] : []
    }) ?? []
  const reason = typeof record.reason === "string" ? record.reason : undefined
  const status =
    record.canRewind === false
      ? "unavailable"
      : record.canRewind === true || paths.length > 0
        ? "ready"
        : "unknown"
  return { status, ...(reason ? { reason } : {}), paths: [...new Set(paths)] }
}

// ---- Session-level SDK functions (the `session_api` frame) ----------------
//
// `sessionControl` above drives a LIVE query by session id. These do the
// opposite: they read and mutate transcripts on disk with no session running,
// which is what makes session management reachable from Settings with no chat
// open. Same correlation machinery, different Tauri command and frame type.

/**
 * A filesystem scan across every project directory can genuinely outrun the
 * 8s control budget on a large machine, and a timeout there reads to the user
 * as a broken feature rather than a slow one.
 */
const SESSION_API_TIMEOUT_MS = 20_000

/**
 * Call an allowlisted session-level SDK function and await its result.
 *
 * `sendOptions` names the SessionStore backend for the call — it is forwarded
 * verbatim to the sidecar, which resolves it to a live store. The renderer
 * never sends a store: the descriptor names a backend, never a location.
 *
 * Rejects with the sidecar's stable error code (`unknown_method`,
 * `invalid_session_id`, `no_session_store`, …) or `sidecar exited`. Callers
 * that can run against a non-Anthropic runtime must gate on
 * `SESSION_API_CAPABILITIES` first — this is IPC, and ADR-0090 constraint 3
 * wants the fail-closed decision made before it.
 */
export type SdkSessionApiOptions = Pick<SendOptions, "cwd" | "execution" | "claudeAgentSdk">

export async function sessionApi<T = unknown>(
  method: SessionApiMethod,
  params?: Record<string, unknown>,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sidecarRoundTrip<T>(
    "agent_session_api",
    (requestId) => ({ requestId, method, params, sendOptions }),
    `session api "${method}"`,
    SESSION_API_TIMEOUT_MS
  )
}

/** Sessions the SDK can see, from the store and/or `dir`'s transcripts. */
export function listSdkSessions<T = unknown>(
  params?: { dir?: string },
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("listSessions", params, sendOptions)
}

/** Metadata for one session (title, tag, timestamps). */
export function getSdkSessionInfo<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("getSessionInfo", { sessionId }, sendOptions)
}

/**
 * One session's message chain.
 *
 * This is the COMPACTED chain — the SDK drops what compaction replaced. A
 * caller that needs the raw history reads the store directly rather than
 * "fixing" a short result by re-fetching here.
 */
export function getSdkSessionMessages<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("getSessionMessages", { sessionId }, sendOptions)
}

/** Subagents that ran inside a session. */
export function listSdkSubagents<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("listSubagents", { sessionId }, sendOptions)
}

/** One subagent's own message chain. */
export function getSdkSubagentMessages<T = unknown>(
  sessionId: string,
  agentId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("getSubagentMessages", { sessionId, agentId }, sendOptions)
}

/** Retitle a session. */
export function renameSdkSession(
  sessionId: string,
  title: string,
  sendOptions?: SdkSessionApiOptions
): Promise<void> {
  return sessionApi<void>("renameSession", { sessionId, title }, sendOptions)
}

/** Set or clear a session's tag. `null` is the documented "clear" value. */
export function tagSdkSession(
  sessionId: string,
  tag: string | null,
  sendOptions?: SdkSessionApiOptions
): Promise<void> {
  return sessionApi<void>("tagSession", { sessionId, tag }, sendOptions)
}

/**
 * Delete a session's transcript.
 *
 * Irreversible, and it cascades to the session's subagent transcripts. Callers
 * owe the user a confirmation — {@link isMutatingSessionApiMethod} is exported
 * from the contract so a UI can decide that from the method rather than from a
 * hand-maintained list of "the scary ones".
 */
export function deleteSdkSession(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<void> {
  return sessionApi<void>("deleteSession", { sessionId }, sendOptions)
}

/** Copy a session so a new branch can diverge from it. */
export function forkSdkSession<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("forkSession", { sessionId }, sendOptions)
}

/**
 * Copy a local JSONL transcript into the configured SessionStore.
 *
 * Requires a store — without one the sidecar rejects with `no_session_store`
 * rather than silently doing nothing.
 */
export function importSdkSessionToStore<T = unknown>(
  sessionId: string,
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("importSessionToStore", { sessionId }, sendOptions)
}

/** The effective settings layers the SDK would apply (user/project/local). */
export function resolveSdkSettings<T = unknown>(
  params?: { dir?: string },
  sendOptions?: SdkSessionApiOptions
): Promise<T> {
  return sessionApi<T>("resolveSettings", params, sendOptions)
}

// ---- Mobile-only message + session RPCs (mobile completeness Phase 2) ----

/** One row of `session_list`: a list projection, not the execution configuration. */
export type SessionListRow = Pick<
  ChatSession,
  | "id"
  | "title"
  | "kind"
  | "projectId"
  | "characterId"
  | "teamId"
  | "lastMessagePreview"
  | "lastMessageAt"
  | "createdAt"
  | "updatedAt"
>

/**
 * Page of sessions returned by `session_list` (ADR-0175 B3): `items` sorted
 * desktop-side by `updatedAt` descending, `nextPageToken` while more remain.
 * Direct and degraded stores may additionally answer `total`.
 */
export interface SessionListPage extends Page<SessionListRow> {
  total?: number
}

/**
 * Patch a message on the desktop's Dexie. The mobile client uses this
 * during edit-and-resend so the desktop's authoritative store stays in
 * lockstep. Round-trips through `_rpc/message_update` → Tauri event →
 * `messageRepository.update`.
 */
export async function updateMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<UIMessage>
): Promise<void> {
  await transport.call("message_update", { sessionId, messageId, updates })
}

/**
 * Delete a message on the desktop's Dexie. Used by the mobile
 * regenerate / edit flows when the local truncate must mirror to the
 * desktop's store.
 */
export async function deleteMessage(sessionId: string, messageId: string): Promise<void> {
  await transport.call("message_delete", { sessionId, messageId })
}

/**
 * Paginated read of the desktop's `sessions` table. Read-only —
 * structurally idempotent so the companion transport skips the
 * idempotency-key header. `updatedBefore` narrows to sessions updated before
 * that time. Paging is `pageSize`/`pageToken`.
 */
export async function listSessions(
  opts: PageRequest & { updatedBefore?: number } = {}
): Promise<SessionListPage> {
  return transport.call<SessionListPage>("session_list", { ...opts })
}

/**
 * Paginated read of one session's messages. Used by the mobile companion to
 * hydrate a chat history without taking ownership of the desktop's Dexie
 * snapshot. Round-trips through `_rpc/message_get_by_session` → desktop
 * Tauri command → an indexed raw `StoredMessage` page.
 *
 * Returns rows sorted by `createdAt` ascending so the mobile client can
 * append them to its scrollback in order.
 */
export interface MobileMessagesPage extends Page<StoredMessage> {
  /** Present on direct-store responses, which count the table. */
  total?: number
}

export async function getMessagesBySession(
  sessionId: string,
  page: PageRequest = {}
): Promise<MobileMessagesPage> {
  return transport.call<MobileMessagesPage>("message_get_by_session", {
    session_id: sessionId,
    ...page,
  })
}

/**
 * Initiate a mobile-originated send. The desktop side is authoritative —
 * this RPC enqueues the prompt against the existing session and returns the
 * id of the user message that was appended. The downstream assistant
 * response streams back via the standard `claude://message` Tauri event,
 * which the desktop bridges to the mobile websocket / push channel.
 */
export interface MobileMessageSendResult {
  messageId?: string
  ok: boolean
}

export async function sendMessageFromMobile(
  sessionId: string,
  content: string,
  role?: "user" | "assistant" | "system"
): Promise<MobileMessageSendResult> {
  return transport.call<MobileMessageSendResult>("message_send", {
    session_id: sessionId,
    content,
    role,
  })
}

/**
 * Who authorized this decision, for the action-review audit trail.
 *
 * Optional and explicit on purpose: every resolution path funnels through
 * `approveTool`, so this function cannot tell a human's click from an
 * auto-mode rule. A caller that omits it gets no receipt rather than a
 * fabricated `"human"` one — see `lib/policy/action-review/chat-tool-channel`.
 */
export interface ApproveToolAttribution {
  authority: ActionReviewAuthority
  actor?: { kind: ActionReviewActorKind; id?: string; label?: string }
  /** The authorization an outbound allow rests on (ADR-0239). */
  grant?: ActionReviewGrant
}

export async function approveTool(
  sessionId: string,
  requestId: string,
  decision: ApprovalDecision,
  message?: string,
  updatedInput?: unknown,
  remoteExecutionContext?: RemoteExecutionContext,
  attribution?: ApproveToolAttribution
): Promise<void> {
  // ADR-0239: an outbound call's authorization is recorded before the answer
  // leaves, so the delivery the tool makes once it runs can name it.
  if (decision === "deny") {
    forgetPlannedOutboundToolCall(sessionId, requestId)
  } else if (attribution) {
    authorizeOutboundToolCall(sessionId, requestId, {
      authority: attribution.authority,
      ...(attribution.grant ? { grant: attribution.grant } : {}),
    })
  }
  const { recordToolAuthorizationGovernance } =
    await import("@/lib/governance/producers/tool-authorization")
  const key = remoteApprovalKey(sessionId, requestId)
  const local = requestId.startsWith("local:")
  if (local && !hasPendingApproval(sessionId, requestId))
    throw new Error("Local approval has expired or belongs to another session")
  const context = remoteExecutionContext ?? remoteApprovalContexts.get(key)
  const decidedAt = Date.now()
  const governanceOutcome = decision === "deny" ? "deny" : "allow"
  try {
    if (local) {
      if (
        remoteExecutionContext ||
        !resolveLocalApproval(sessionId, requestId, {
          decision: decision === "allow" ? "allow" : "deny",
          message,
          updatedInput,
        })
      )
        throw new Error("Local approval identity changed")
    } else
      await sessionControlRoute(sessionId).transport.call("agent_resolve_permission", {
        sessionId,
        requestId,
        decision,
        message,
        updatedInput,
        ...(context ? { remoteExecutionContext: context } : {}),
      })
    // A rejected dispatch leaves the ask pending. Retain its caller binding
    // so a later operator retry cannot fall into a different identity path.
    remoteApprovalContexts.delete(key)
    // Canonical event log (ADR-0090). Recorded here rather than at the call
    // sites because every resolution path — plugin firewall, allowlist,
    // auto-mode, the modal, a remote device, the backstop deny — funnels
    // through this one call.
    try {
      const { recordChatCanonicalEvents } = await import("@/lib/chat/canonical-sink")
      recordChatCanonicalEvents(sessionId, [
        {
          kind: "permission-resolved",
          requestId,
          behavior: decision === "deny" ? "deny" : "allow",
        },
      ])
    } catch {
      // The journal must never be able to fail an approval the user already made.
    }
    try {
      await recordToolAuthorizationGovernance({
        sessionId,
        requestId,
        outcome: governanceOutcome,
        decidedAt,
        dispatched: true,
        hasUpdatedInput: updatedInput !== undefined,
      })
    } catch (error) {
      await reportGovernanceProjectionFailure(
        {
          producer: "tool-authorization",
          operation: "record-dispatched",
          subjectRef: {
            namespace: "cognia",
            type: "tool-authorization",
            id: `${sessionId}:${requestId}`,
          },
          occurredAt: decidedAt,
        },
        error
      )
    }
    if (attribution) {
      await recordApprovalReceipt(sessionId, requestId, decision, message, attribution)
    }
  } catch (error) {
    try {
      await recordToolAuthorizationGovernance({
        sessionId,
        requestId,
        outcome: governanceOutcome,
        decidedAt,
        dispatched: false,
        hasUpdatedInput: updatedInput !== undefined,
      })
    } catch (projectionError) {
      await reportGovernanceProjectionFailure(
        {
          producer: "tool-authorization",
          operation: "record-failed-dispatch",
          subjectRef: {
            namespace: "cognia",
            type: "tool-authorization",
            id: `${sessionId}:${requestId}`,
          },
          occurredAt: decidedAt,
        },
        projectionError
      )
    }
    throw error
  }
}

/**
 * Write the action-review receipt for a decision that actually reached the
 * sidecar.
 *
 * Called on the success path only — NOT from a `finally`. The receipt is a
 * 90-day audit record asserting that this tool call was authorized and
 * settled; a dispatch that threw authorized nothing, and recording one anyway
 * would put a decision in the trail that the sidecar never received. That is
 * the same distinction `recordToolAuthorizationGovernance` already draws with
 * its `dispatched` flag, and the receipt contract has no way to express it.
 *
 * Never throws: the projection is an observer of a decision the user already
 * made.
 */
async function recordApprovalReceipt(
  sessionId: string,
  requestId: string,
  decision: ApprovalDecision,
  message: string | undefined,
  attribution: ApproveToolAttribution
): Promise<void> {
  try {
    const { settleChatToolReview } = await import("@/lib/policy/action-review/chat-tool-channel")
    await settleChatToolReview({
      sessionId,
      requestId,
      outcome:
        decision === "deny" ? "deny" : decision === "allow_always" ? "allow_always" : "allow",
      authority: attribution.authority,
      ...(message ? { reason: message } : {}),
      ...(attribution.actor ? { actor: attribution.actor } : {}),
      ...(attribution.grant ? { grant: attribution.grant } : {}),
    })
  } catch {
    // Audit projection must never fail an approval the user already made.
  }
}

/**
 * Answer a `tool_result_review` (the plugin Agent SDK's PostToolUse rewrite).
 * `updatedToolOutput` is the rewritten output the model should see; pass
 * `undefined` to leave the tool result unchanged. Mirrors
 * `approveTool`/`agent_resolve_permission` but for tool OUTPUT.
 */
export async function toolResultDecision(
  sessionId: string,
  reviewId: string,
  updatedToolOutput?: unknown,
  remoteExecutionContext?: RemoteExecutionContext
): Promise<void> {
  await sessionControlRoute(sessionId).transport.call("claude_tool_result_decision", {
    sessionId,
    reviewId,
    updatedToolOutput,
    remoteExecutionContext,
  })
}

/**
 * Whether this window's turns run on a paired host's sidecar rather than its
 * own: a phone or a browser paired to a host, or a desktop driving a remote
 * host. Keyed on the host profile, never on `isTauri()` (which every node and
 * jsdom suite would read as "paired").
 */
export function turnsRunOnPairedHost(): boolean {
  const profile = detectHostProfile()
  return profile === "mobile-companion" || profile === "cloud-companion" || isRemoteHostActive()
}

/**
 * Answer a Router + Fusion `call_reserve_request` (ADR-0188). `granted` lets the
 * sidecar send the call (the attempt is already durably dispatched in the fusion
 * ledger); `refused` stops the turn with the refusal code; `bypass` tells the
 * sidecar the ledger is unavailable and the turn continues unledgered.
 *
 * The ledger is this window's fusion database either way. On the desktop the
 * answer goes to its own sidecar (`claude_call_reserve_decision`, a local-only
 * command); a window whose turn runs on a paired host's sidecar answers through
 * that host (`claude_call_reserve_respond`, ADR-0188 D25), which relays it
 * while its companion switch is on.
 */
export async function callReserveDecision(
  sessionId: string,
  requestId: string,
  decision:
    // An envelope check grants continuation, not a call: no attempt.
    | { decision: "granted"; attemptId?: string; attemptNo?: number }
    | { decision: "refused"; code: string; message?: string }
    | { decision: "bypass"; code: string }
): Promise<void> {
  const target = sessionControlRoute(sessionId)
  const profile = detectHostProfile()
  const command =
    profile === "mobile-companion" || profile === "cloud-companion" || target.remote
      ? "claude_call_reserve_respond"
      : "claude_call_reserve_decision"
  const answer = await target.transport.call<{ ok?: unknown; error?: { code?: unknown } } | null>(
    command,
    { sessionId, requestId, ...decision }
  )
  // The paired host answers in the Router + Fusion envelope; a refusal (its
  // companion switch is off) means nothing reached the sidecar, so the caller
  // must know the reservation is still open rather than assume it was answered.
  if (command === "claude_call_reserve_respond" && answer && answer.ok === false) {
    const code = typeof answer.error?.code === "string" ? answer.error.code : "relay_refused"
    throw new Error(`the paired host did not relay the reservation answer: ${code}`)
  }
}

export async function closeSession(
  sessionId: string,
  options?: { commandId?: string; route?: ExecutionRoute }
): Promise<void> {
  const target = sessionControlRoute(sessionId, options?.route)
  const contexts = pluginToolSessionContextsFor(target.route)
  const context = contexts.get(sessionId)
  if (context || !target.remote)
    abortPluginToolCallsForSession(sessionId, "session closed", context)
  // Always the canonical command (ADR-0090): it is the one a person brain's
  // channel and a member device's grant admit (P6c, ADR-0253 G12). Its
  // idempotency key is minted here when the caller has none.
  await target.transport.call("agent_close_session", {
    sessionId,
    commandId: options?.commandId ?? crypto.randomUUID(),
  })
  sentMcpConfigurations.delete(sessionId)
  if (contexts.get(sessionId) === context) contexts.delete(sessionId)
  forgetSessionExecutionRoute(sessionId)
}

export async function getSidecarStatus(): Promise<{ ready: boolean }> {
  return transport.call<{ ready: boolean }>("claude_sidecar_status")
}

/** Rust-owned turn registry; missing support, web mode and errors are unknown. */
export async function getLiveSidecarSessionIds(): Promise<ReadonlySet<string> | undefined> {
  if (detectHostProfile() !== "desktop" || isRemoteHostActive()) return undefined
  try {
    const status = await transport.call<{ liveSessionIds?: unknown }>("agent_status")
    const ids = status?.liveSessionIds
    return Array.isArray(ids) && ids.every((id) => typeof id === "string")
      ? new Set(ids as string[])
      : undefined
  } catch {
    return undefined
  }
}

/** Start the desktop Agent Host and resolve after its ready handshake. */
export async function ensureSidecarReady(): Promise<{ ready: boolean }> {
  return transport.call<{ ready: boolean }>("agent_start")
}

export async function setApiKey(key: string | null): Promise<void> {
  await transport.call("claude_set_api_key", { key })
}

/**
 * Replace the Anthropic provider env (api key + optional base URL) atomically.
 * Used by the CCSwitch provider-switch flow so the sidecar restart sees a
 * coherent (key, base-url) pair rather than a half-switched state.
 *
 * Pass `null` for either field to clear it. Empty strings are treated as null
 * by the Rust side.
 *
 * `customHeaders` carries relay-required headers (e.g.
 * `{ "anthropic-beta": "context-1m-2025-08-07" }` for the 1M window), forwarded
 * as `ANTHROPIC_CUSTOM_HEADER_*` at sidecar spawn. Semantics on the Rust side:
 * `undefined` leaves the existing header set untouched (legacy callers that
 * don't manage headers); an explicit object — including `{}` — replaces it, so
 * switching to a provider without headers clears a previous relay's headers.
 */
export async function setProviderEnv(
  apiKey: string | null,
  baseUrl: string | null,
  customHeaders?: Record<string, string>
): Promise<void> {
  await transport.call("claude_set_provider_env", {
    apiKey,
    baseUrl,
    customHeaders: customHeaders ? Object.entries(customHeaders) : undefined,
  })
}

export async function hasApiKey(): Promise<boolean> {
  return transport.call<boolean>("claude_has_api_key")
}

// `setOauthBearer` was removed in ADR-0025 — the unified subscription module
// pushes the bearer into `ApiKeyState` server-side via `subscription_set_active`.
// Renderers that previously called `setOauthBearer(token)` + `restartSidecar()`
// now call `subscription_set_active("anthropic", accountId)` (see
// `lib/subscription/anthropic/sidecar-sync.ts`). The Rust-side
// `claude_set_oauth_bearer` command continues to exist for the diagnostics
// `hasOauthBearer()` read below and as a transitional surface during the
// migration window, but no renderer code calls it directly.

export async function hasOauthBearer(): Promise<boolean> {
  return transport.call<boolean>("claude_has_oauth_bearer")
}

export async function restartSidecar(): Promise<void> {
  await transport.call("claude_restart_sidecar")
}

export async function onClaudeMessage(
  handler: (evt: ClaudeEvent) => void,
  route?: ExecutionRoute
): Promise<UnlistenFn> {
  const onEvent = (event: ClaudeEvent, from: ExecutionRoute | null) => {
    const routed = event as ClaudeEvent & { remoteExecutionContext?: unknown }
    const remoteContext = isRemoteExecutionContext(routed.remoteExecutionContext)
      ? routed.remoteExecutionContext
      : undefined
    const contexts = pluginToolSessionContextsFor(from ?? undefined)
    if (isPluginToolExecEvent(event)) {
      if (remoteContext) contexts.set(event.sessionId, remoteContext)
      else contexts.delete(event.sessionId)
    }
    if (event.type === "session_ended") {
      const context = remoteContext ?? contexts.get(event.sessionId)
      const remote = from ? from.remote : getActiveRemoteTransport() !== null
      if (context || !remote)
        abortPluginToolCallsForSession(event.sessionId, "session ended", context, event.turnId)
    }
    if (
      (routed as { type?: string }).type === "permission_request" &&
      "sessionId" in routed &&
      "requestId" in routed &&
      typeof routed.sessionId === "string" &&
      typeof routed.requestId === "string" &&
      isRemoteExecutionContext(routed.remoteExecutionContext)
    ) {
      rememberRemoteApprovalContext(
        routed.sessionId,
        routed.requestId,
        routed.remoteExecutionContext
      )
    }
    if (isPermissionRequestEvent(routed)) {
      // Fire-and-forget: the ask must reach its handler at once, and a failed
      // projection is a missing list row, never a stalled approval.
      void import("@/lib/policy/action-review/chat-tool-channel")
        .then(({ openChatToolReview }) =>
          openChatToolReview({
            sessionId: routed.sessionId,
            requestId: routed.requestId,
            toolName: routed.toolName,
          })
        )
        .catch(() => undefined)
    }
    handler(event)
  }
  // A pinned route hears only its own Host, also after the selection changes.
  if (route) return route.transport.subscribe<ClaudeEvent>(SIDECAR_EVENT, (e) => onEvent(e, route))
  return subscribeSessionEvents<ClaudeEvent>(SIDECAR_EVENT, sessionOfEvent, onEvent)
}

function sessionOfEvent(event: unknown): string | undefined {
  const sessionId = (event as { sessionId?: unknown } | null)?.sessionId
  return typeof sessionId === "string" ? sessionId : undefined
}

/**
 * Subscribe to `plugin_tool_exec` events on the sidecar channel and forward
 * them to `handler` (which runs the tool via `handlePluginToolExec` and writes
 * the result back with `sendPluginToolResponse`). Reuses the single
 * `onClaudeMessage` subscription + the `ClaudeEvent` type guard. No-op in web.
 */
export async function subscribePluginToolExec(
  handler: (req: PluginToolExecEvent & { remoteExecutionContext?: RemoteExecutionContext }) => void
): Promise<UnlistenFn> {
  return onClaudeMessage((evt) => {
    if (isPluginToolExecEvent(evt)) handler(evt)
  })
}

/**
 * Write a `plugin_tool_response` back onto the sidecar stdin so the pending
 * `pendingPluginToolCalls` entry resolves. Mirrors `approveTool`/`agent_resolve_permission`.
 */
export async function sendPluginToolResponse(
  resp: PluginToolExecResponse,
  remoteExecutionContext?: RemoteExecutionContext
): Promise<void> {
  await sessionControlRoute(resp.sessionId).transport.call("claude_plugin_tool_response", {
    sessionId: resp.sessionId,
    toolUseId: resp.toolUseId,
    result: resp.result,
    error: resp.error,
    ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
  })
}

/** One `{ type: "plugin" }` lifecycle-hook round-trip request from the sidecar. */
export interface PluginHookExecEvent {
  type: "plugin_hook_exec"
  sessionId: string
  execId: string
  pluginId: string
  hookId: string
  payload: Record<string, unknown>
}

/**
 * Subscribe to `plugin_hook_exec` events — the settings.json ⇄ plugin bridge.
 *
 * Mirrors {@link subscribePluginToolExec}: the frame falls through Rust's
 * default branch onto the same sidecar channel, so no Rust routing was needed
 * for the outbound half. (`host_rpc`, the channel this looks like it should
 * use, never reaches the renderer at all — see `dispatch/plugin-hook-exec.mjs`.)
 */
export async function subscribePluginHookExec(
  handler: (req: PluginHookExecEvent) => void
): Promise<UnlistenFn> {
  return onClaudeMessage((evt) => {
    const e = evt as unknown as PluginHookExecEvent
    if (e?.type === "plugin_hook_exec" && typeof e.execId === "string") handler(e)
  })
}

/**
 * Write a `plugin_hook_response` back onto the sidecar stdin so the pending
 * `pendingPluginHookCalls` entry resolves. Mirrors `sendPluginToolResponse`.
 */
export async function sendPluginHookResponse(resp: {
  sessionId: string
  execId: string
  result?: unknown
  error?: string
}): Promise<void> {
  await sessionControlRoute(resp.sessionId).transport.call("claude_plugin_hook_response", {
    sessionId: resp.sessionId,
    execId: resp.execId,
    result: resp.result ?? null,
    error: resp.error ?? null,
  })
}

/**
 * Subscribe to `protocol_adapter_exec` events (P2-E code adapter round-trip)
 * and forward them to `handler`. Reuses the single `onClaudeMessage`
 * subscription. No-op in web.
 */
export async function subscribeProtocolAdapterExec(
  handler: (req: ProtocolAdapterExecEvent) => void
): Promise<UnlistenFn> {
  return onClaudeMessage((evt) => {
    if ((evt as { type?: string }).type === "protocol_adapter_exec") {
      handler(evt as unknown as ProtocolAdapterExecEvent)
    }
  })
}

export async function subscribeProtocolAdapterCancel(
  handler: (req: ProtocolAdapterCancelEvent) => void
): Promise<UnlistenFn> {
  return onClaudeMessage((evt) => {
    if (isProtocolAdapterCancelEvent(evt)) handler(evt)
  })
}

/** Write a `protocol_adapter_{chunk,done,error}` line onto the sidecar stdin. */
export async function sendProtocolAdapterMessage(
  message: Record<string, unknown>,
  remoteExecutionContext?: RemoteExecutionContext
): Promise<void> {
  const routedMessage = {
    ...message,
    messageId: crypto.randomUUID(),
  }
  const target =
    typeof message.sessionId === "string"
      ? sessionControlRoute(message.sessionId).transport
      : transport
  await target.call("claude_protocol_adapter_message", {
    message: routedMessage,
    ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
    ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
  })
}

// ---- File-system commands (Skills + MCP import/export) -------------------

export async function readTextFile(path: string): Promise<string> {
  return transport.call<string>("read_text_file", { path })
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await transport.call("write_text_file", { path, content })
}

/**
 * Write a text file confined to `allowedRoots` (the active workspace roots).
 * The authoritative on-disk counterpart to {@link writeTextFile}: the Rust host
 * canonicalizes and rejects writes that escape the roots — including via a
 * symlink the lexical TS pre-flight can't see. Prefer this for in-app writes.
 */
export async function writeTextFileConfined(
  path: string,
  content: string,
  allowedRoots: string[]
): Promise<void> {
  await transport.call("write_text_file_confined", { path, content, allowedRoots })
}

export async function ensureDir(path: string): Promise<void> {
  await transport.call("ensure_dir", { path })
}

/** Ensure a directory exists, confined to `allowedRoots` (see {@link writeTextFileConfined}). */
export async function ensureDirConfined(path: string, allowedRoots: string[]): Promise<void> {
  await transport.call("ensure_dir_confined", { path, allowedRoots })
}

export async function defaultExportDir(): Promise<string> {
  return transport.call<string>("default_export_dir")
}

export interface DiscoveredSkillFile {
  dirName: string
  filePath: string
  content: string
}

export async function scanClaudeSkills(): Promise<DiscoveredSkillFile[]> {
  const raw =
    await transport.call<Array<{ dir_name: string; file_path: string; content: string }>>(
      "scan_claude_skills"
    )
  return raw.map((r) => ({
    dirName: r.dir_name,
    filePath: r.file_path,
    content: r.content,
  }))
}

export async function readClaudeUserConfig(): Promise<unknown> {
  return transport.call<unknown>("read_claude_user_config")
}

// ---- Multi-agent MCP IO (read / write external agents' config files) -----

export interface AgentReadResult {
  /** Resolved path on this OS, or null when the agent isn't supported here. */
  path: string | null
  exists: boolean
  writable: boolean
  format: "json" | "jsonc" | "toml"
  /** Raw file content (or empty string when missing). */
  raw: string
  /** Parsed canonical JSON tree, or `null` when missing / unparseable. */
  parsed: unknown
  /** Set when the file existed but couldn't be parsed. */
  parseError?: string
}

export async function readAgentConfig(agent: AgentId): Promise<AgentReadResult> {
  return transport.call<AgentReadResult>("read_agent_config", { agent })
}

export interface AgentWriteResult {
  path: string
  backupPath?: string
}

export async function writeAgentConfig(agent: AgentId, value: unknown): Promise<AgentWriteResult> {
  return transport.call<AgentWriteResult>("write_agent_config", { agent, value })
}

/**
 * Read a workspace's project-scoped `.mcp.json`. Read-only: that file is
 * normally committed and shared with the user's teammates, so Cognia imports
 * from it but never writes back.
 */
export async function readProjectMcpConfig(cwd: string): Promise<AgentReadResult> {
  return transport.call<AgentReadResult>("read_project_mcp_config", { cwd })
}

// ---- Skills (native sync, marketplace registry, scanner) -----------------

export interface NativeSkillResource {
  kind: "script" | "reference" | "asset"
  path: string
  name: string
  content: string
  encoding: "utf-8" | "base64"
  mimeType?: string
  size: number
}

export interface NativeSkill {
  dirName: string
  filePath: string
  content: string
  resources: NativeSkillResource[]
  /**
   * SKILL.md mtime in milliseconds since epoch. Zero when filesystem
   * metadata couldn't be read (handled as "unknown" by sync — pull
   * conservatively).
   */
  mtimeMs: number
}

export interface RegistrySkillEntry {
  id: string
  source: string
  sourceType: string
  skillPath?: string
  computedHash?: string
  displayName?: string
  description?: string
  category?: string
  tags?: string[]
  author?: string
  iconUrl?: string
  rawSkillUrl?: string
}

export interface InstallSkillRequest {
  dirName: string
  content: string
  resources: NativeSkillResource[]
  clean: boolean
}

export interface InstallSkillResponse {
  directory: string
  writtenFiles: string[]
}

export type SkillsTarget = "cognia" | "claude" | "codex"

/**
 * Bundle-import-aware install request. Wraps the legacy single-target
 * payload with a `targets` list (cognia + claude + codex toggleable) and
 * a `trashBeforeClean` flag that moves the prior cognia copy into
 * `<appData>/cognia/skills/.trash/` before overwriting.
 */
export interface InstallSkillMirroredRequest extends InstallSkillRequest {
  targets: SkillsTarget[]
  trashBeforeClean: boolean
}

export interface MirrorTargetOutcome {
  target: SkillsTarget
  directory: string
  writtenFiles: string[]
  /** Set when a target was requested but degraded (e.g. no home dir). */
  note?: string | null
}

export interface InstallSkillMirroredResponse {
  targets: MirrorTargetOutcome[]
  /** Path of the trashed prior cognia copy, when applicable. */
  trashedFrom?: string | null
}

export interface HostSkillsCatalog {
  cognia: NativeSkill[]
  claude: NativeSkill[]
  codex: NativeSkill[]
}

export interface SkillBundleUploadHandle {
  handleId: string
  chunkBytes: number
}

export interface SkillScanIssue {
  severity: "low" | "medium" | "high"
  kind: string
  message: string
  line?: number
}

export async function skillsScanNative(): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_native")
}

export async function skillsCatalogGet(): Promise<HostSkillsCatalog> {
  return transport.call<HostSkillsCatalog>("skills_catalog_get")
}

export async function skillsBundleUploadOpen(
  expectedSize: number,
  expectedHash: string
): Promise<SkillBundleUploadHandle> {
  return transport.call<SkillBundleUploadHandle>("skills_bundle_upload_open", {
    request: { expectedSize, expectedHash },
  })
}

export async function skillsBundleUploadWrite(args: {
  handleId: string
  offset: number
  dataBase64: string
  chunkHash: string
}): Promise<number> {
  return transport.call<number>("skills_bundle_upload_write", args)
}

export async function skillsBundleUploadCommit(handleId: string): Promise<void> {
  return transport.call<void>("skills_bundle_upload_commit", { handleId })
}

export async function skillsBundleUploadAbort(handleId: string): Promise<void> {
  return transport.call<void>("skills_bundle_upload_abort", { handleId })
}

export async function skillsInstallAtomic(
  handleId: string,
  adminLease: string
): Promise<InstallSkillMirroredResponse> {
  return transport.call<InstallSkillMirroredResponse>("skills_install_atomic", {
    handleId,
    adminLease,
  })
}

export async function skillsUninstall(
  target: SkillsTarget,
  dirName: string,
  adminLease: string
): Promise<{ removed: boolean; directory: string }> {
  return transport.call<{ removed: boolean; directory: string }>("skills_uninstall", {
    target,
    dirName,
    adminLease,
  })
}

export async function skillsScanDir(path: string): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_dir", { path })
}

export async function skillsScanCodex(): Promise<NativeSkill[]> {
  return transport.call<NativeSkill[]>("skills_scan_codex")
}

/** Scan OpenCode's environment-aware global `skills/` directory. */
export async function skillsScanOpencode(): Promise<NativeSkill[]> {
  const [{ resolveVendorRoots }, { joinPath }] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/agents/instructions/paths"),
  ])
  const { opencodeConfigDir } = await resolveVendorRoots()
  if (!opencodeConfigDir) return []
  return skillsScanDir(joinPath(opencodeConfigDir, "skills"))
}

/** Scan Cursor's global `~/.cursor/skills` directory. */
export async function skillsScanCursor(): Promise<NativeSkill[]> {
  const [{ resolveVendorRoots }, { joinPath }] = await Promise.all([
    import("@/lib/agent-roots"),
    import("@/lib/agents/instructions/paths"),
  ])
  const { cursorDir } = await resolveVendorRoots()
  if (!cursorDir) return []
  return skillsScanDir(joinPath(cursorDir, "skills"))
}

export async function skillsMoveToTrash(dirName: string): Promise<string> {
  return transport.call<string>("skills_move_to_trash", { dirName })
}

export async function skillsListTrash(): Promise<string[]> {
  return transport.call<string[]>("skills_list_trash")
}

export async function skillsEmptyTrash(): Promise<number> {
  return transport.call<number>("skills_empty_trash")
}

export async function skillsInstallNative(
  request: InstallSkillRequest
): Promise<InstallSkillResponse> {
  return transport.call<InstallSkillResponse>("skills_install_native", { request })
}

export async function skillsInstallMirrored(
  request: InstallSkillMirroredRequest
): Promise<InstallSkillMirroredResponse> {
  return transport.call<InstallSkillMirroredResponse>("skills_install_mirrored", { request })
}

export async function skillsUninstallNative(
  dirName: string
): Promise<{ removed: boolean; directory: string }> {
  return transport.call<{ removed: boolean; directory: string }>("skills_uninstall_native", {
    dirName,
  })
}

export async function skillsFetchRemoteMd(url: string): Promise<string> {
  return transport.call<string>("skills_fetch_remote_md", { url })
}

/** Response of the Rust JSON GET proxy. Non-2xx statuses are returned (not thrown). */
export interface SkillsRemoteGetResponse {
  status: number
  body: string
  retryAfter?: string | null
}

export async function skillsFetchRemoteJson(req: {
  url: string
  bearerToken?: string
  accept?: string
}): Promise<SkillsRemoteGetResponse> {
  return transport.call<SkillsRemoteGetResponse>("skills_fetch_remote_json", { req })
}

export async function skillsLoadRegistry(): Promise<RegistrySkillEntry[]> {
  return transport.call<RegistrySkillEntry[]>("skills_load_registry")
}

export async function skillsScanSecurity(content: string): Promise<SkillScanIssue[]> {
  return transport.call<SkillScanIssue[]>("skills_scan_security", { content })
}

export async function skillsScanResources(
  resources: Array<[string, string]>
): Promise<SkillScanIssue[]> {
  return transport.call<SkillScanIssue[]>("skills_scan_resources", { resources })
}
