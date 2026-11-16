"use client"

import {
  canonicalEventFromExternalEvent,
  captureEventFromCanonical,
} from "@/lib/ai/agent/execution/event-envelope"
import {
  externalAgentRouteKey,
  isGatewaySessionLink,
} from "@/lib/ai/agent/external/session/session-models"
import { type ExternalTurnImage } from "@/lib/ai/agent/external/session/turn-images"
import {
  attachRunMetadataToLastAssistant,
  attachUsageToLastAssistant,
  buildCompletedRunMetadata,
} from "@/lib/chat/message-run-metadata"
import { readPersonalAsideHistory } from "@/lib/chat/personal-history/aside"
import { prepareAsideContext, type AsideContextDelivery } from "@/lib/chat/session-aside-context"
import { setSessionExternalLane } from "@/lib/chat/steer-runtime"
import { type SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import { sessionAsideSystemPrompt } from "@/lib/claude/build-options"
import { type MemberAttachmentUploadError } from "@/lib/companion/member-turn-attachments"
import { persistMessages, persistStreamingMessages } from "@/lib/db/messages"
import { updateAsideParentMessagePins } from "@/lib/db/resource-workbench-sessions"
import { recordExternalAgentUsage } from "@/lib/db/session-usage"
import { toDiagnostic } from "@/lib/diagnostics/to-diagnostic"
import { LOCAL_PERSON_RUN, type LocalPersonRun } from "@/lib/execution/acting-authority"
import { projectDirectChatCaptureEvent } from "@/lib/execution/direct-chat-run"
import { type PersonalCredentialContext } from "@/lib/execution/personal-credential"
import { bindPersonalEgressOptions } from "@/lib/execution/personal-egress"
import { preparePersonalHistory } from "@/lib/execution/personal-visibility"
import { remapExactRoots, remapPathsIntoAliases } from "@/lib/task-workspace/root-aliases"
import { externalTokenUsageToUsageInfo } from "@/lib/usage/usage-info"
import { externalSessionLinkForSession } from "@/stores/agent/agent-runtime-store"
import { useChatStore, type selectComposerPendingCommandOverrides } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { type SendContent, type SendOptions, type MessageReplyTo } from "@cognia/agent-config-types"
import {
  automatedTurnMetadata,
  type AutomatedTurnProducer,
} from "@cognia/agent-config-types/automated-turn"
import { createDiagnostic, type CogniaDiagnostic } from "@cognia/diagnostics"
import { type UIMessage } from "ai"
import { type AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { type ChatTemplateRun } from "@/lib/chat/template/run"
import { type PromptPreambleSummary } from "@/lib/chat/prompt-preamble"
import { type ContextRef } from "@/lib/chat/mentions/types"
import { type TurnRoute } from "@/lib/chat/turn-route/types"

/** Plugins receive only the user-authored block following the attachment manifest. */
/** Reissued turns can reuse only the context captured for their own user row. */
export function asideContextForRegenerate(
  cached: (AsideContextDelivery & { messageId: string }) | undefined,
  anchorId: string | undefined
): AsideContextDelivery | undefined {
  return anchorId && cached?.messageId === anchorId ? cached : undefined
}

/** Only native Claude has a context cursor tied to an acknowledged SDK session. */
export function asideProviderHistoryMode(
  options: SendOptions,
  standalone: boolean
): "sdk-resume" | "rebuild" | "unsupported" {
  const adapter =
    options.execution?.runtimeAdapter ??
    (!options.provider || options.provider === "anthropic" ? "claude-agent-sdk" : "ai-sdk")
  if (options.routerFusionRun || !["claude-agent-sdk", "ai-sdk", "external"].includes(adapter))
    return "unsupported"
  // External dispatch can switch between a native session, a gateway task and
  // a remote host, including rebinding during dispatch. Those ids are not the
  // SDK acknowledgement the cursor tracks: deliver a full snapshot each turn.
  if (adapter === "external") return "rebuild"
  return !standalone && adapter === "claude-agent-sdk" ? "sdk-resume" : "rebuild"
}

/** External adapters all read the turn prompt; not all honor system-prompt overrides. */
export function externalAsideTurnContent(content: SendContent, readOnly: boolean): SendContent {
  const framing = sessionAsideSystemPrompt(readOnly)
  return typeof content === "string"
    ? `${framing}\n\n${content}`
    : [{ type: "text", text: framing }, ...content]
}

export function userPromptText(content: SendContent, attachmentCount = 0): string {
  if (typeof content === "string") return content
  const block = content.find((entry, index) => index >= attachmentCount && entry.type === "text")
  return block?.type === "text" ? block.text : ""
}

export function rewriteUserPromptText(
  content: SendContent,
  text: string,
  attachmentCount = 0
): SendContent {
  if (typeof content === "string") return text
  const index = content.findIndex(
    (entry, position) => position >= attachmentCount && entry.type === "text"
  )
  return content.map((block, position) =>
    position === index && block.type === "text" ? { ...block, text } : block
  )
}

/** Command tool patterns are SDK pre-approvals; dispatch rechecks ancestor caps. */
export function applyChatCommandOverrides(
  options: SendOptions,
  pending: NonNullable<ReturnType<typeof selectComposerPendingCommandOverrides>>
): SendOptions {
  const next: SendOptions = {
    ...options,
    model: pending.model ?? options.model,
    allowedTools: pending.allowedTools
      ? Array.from(new Set([...(options.allowedTools ?? []), ...pending.allowedTools]))
      : options.allowedTools,
    additionalDirectories: pending.paths
      ? Array.from(new Set([...(options.additionalDirectories ?? []), ...pending.paths]))
      : options.additionalDirectories,
  }
  return next
}

/**
 * What an external agent (Codex, ACP, a paired host's agent) is sent for a turn.
 *
 * External executors take one prompt string plus the turn's images. This lane
 * used to send the payload's FIRST text block, which is the extracted document
 * or OCR text whenever one is attached (`buildSendContent` puts attachment
 * blocks first), so the agent got the file and never the question.
 *
 * - `request` is what the user typed: the first text block past the
 *   attachments, read at the offset `userPromptText` uses. Delegation rules
 *   match on it, not on a file's contents.
 * - `prompt` is what the agent reads: the text blocks in front of the request
 *   (the provider lines put ahead of the turn, then the attachments' text), the
 *   request, then the text after it (fetched link context), in the order the
 *   builtin lane sends them.
 * - `images` are the turn's image blocks, attached or sampled from a video,
 *   each with the manifest index of its attachment. Whether the agent and its
 *   model can see them is decided later (`resolvePromptAttachments`).
 * - `omitted` is what neither carries, so the lane can say so instead of
 *   dropping it silently: the manifest indexes of attachment blocks that are
 *   neither text nor an image (a native video), and any other such block.
 *
 * `leadingCount` is how many blocks the provider pipeline put in front of the
 * turn's own blocks (the reply line, the resource context); the attachments
 * start right after them. A plain-string payload is sent whole, as before.
 */
export function externalTurnPrompt(
  content: SendContent,
  attachmentCount = 0,
  leadingCount = 0
): {
  request: string
  prompt: string
  images: ExternalTurnImage[]
  omitted: ExternalTurnOmissions
} {
  const omitted: ExternalTurnOmissions = { attachments: [], unnamed: 0 }
  const images: ExternalTurnImage[] = []
  if (typeof content === "string") {
    return { request: content, prompt: content, images, omitted }
  }
  const request = userPromptText(content.slice(leadingCount), attachmentCount)
  const attachmentsEnd = leadingCount + attachmentCount
  const requestIndex = content.findIndex(
    (block, index) => index >= attachmentsEnd && block.type === "text"
  )
  const texts = (from: number, to: number) =>
    content
      .slice(from, to)
      .flatMap((block) => (block.type === "text" && block.text.trim() ? [block.text] : []))
  const ahead = texts(0, attachmentsEnd)
  const after = requestIndex >= 0 ? texts(requestIndex + 1, content.length) : []
  content.forEach((block, index) => {
    if (block.type === "text") return
    const attachment = index >= leadingCount && index < attachmentsEnd ? index - leadingCount : null
    if (block.type === "image") {
      images.push({ block, attachment })
    } else if (attachment !== null) {
      omitted.attachments.push(attachment)
    } else {
      omitted.unnamed += 1
    }
  })
  return {
    request,
    prompt: [...ahead, ...(request.trim() ? [request] : []), ...after].join("\n\n"),
    images,
    omitted,
  }
}

/**
 * What a member is told when a file of their turn did not reach their
 * partition (ADR-0253 §9 G25). A Host refusal the diagnostics know (standing,
 * a busy or stopped brain, a full staging area) keeps its own code; anything
 * else reads as the upload failing.
 */
export function memberUploadDiagnostic(
  error: MemberAttachmentUploadError,
  sessionId: string
): CogniaDiagnostic {
  const inner = toDiagnostic(error.failure, { source: "chat", meta: { sessionId } })
  if (inner.code !== "unknown") return inner
  return createDiagnostic("memberAttachmentUploadFailed", {
    source: "chat",
    message: inner.message,
    meta: { sessionId },
    ...(inner.detail ? { detail: inner.detail } : {}),
  })
}

/** What an external agent's prompt (text plus images) could not carry of a turn. */
export interface ExternalTurnOmissions {
  /** Manifest indexes of attachment blocks that are neither text nor an image (a native video). */
  attachments: number[]
  /** Such blocks outside the attachments, which no manifest names. */
  unnamed: number
}

/** The local external lane receives the exact Host run outside serializable model options. */
export function executePersonalExternalTurn<T extends object, R>(
  execute: (prompt: string, options: T) => Promise<R>,
  prompt: string,
  options: T,
  source: { sessionId: string; executionRunId: string }
): Promise<R> {
  return execute(prompt, bindPersonalEgressOptions(options, source))
}

/** Only a host person gesture can mint a local run; automation never inherits the gesture. */
export function localChatRunAuthorization(options?: {
  localAuthorization?: LocalPersonRun
  automatedTurn?: unknown
  backgroundDelivery?: unknown
}): LocalPersonRun | undefined {
  return options?.localAuthorization === LOCAL_PERSON_RUN &&
    options.automatedTurn === undefined &&
    options.backgroundDelivery === undefined
    ? LOCAL_PERSON_RUN
    : undefined
}

/** New hook launches use a Host-known parent, never an unadmitted turn id. */
export async function chatHookCredentialContext(
  sessionId: string,
  executionRunId: string,
  localAuthorization?: LocalPersonRun,
  parentExecutionRunId?: string
): Promise<PersonalCredentialContext> {
  const reservation = {
    executionRunReserved: true as const,
    ...(parentExecutionRunId ? { executionRunParentId: parentExecutionRunId } : {}),
  }
  if (localAuthorization !== LOCAL_PERSON_RUN) {
    // Automated/error hooks cannot mint local proof. The launch resolver checks
    // whether this reserved identity has since been admitted before parenting.
    return { sessionId, executionRunId, ...reservation }
  }
  try {
    const { getExecutionRun } = await import("@/lib/db/execution-runs")
    if (!(await getExecutionRun(executionRunId))) {
      return { sessionId, localAuthorization, ...reservation }
    }
  } catch {
    // A failed journal read cannot prove that this is a new action, so no
    // local proof; the launch resolver re-reads the reservation before parenting.
    return { sessionId, executionRunId, ...reservation }
  }
  return { sessionId, executionRunId }
}

export function resolveChatTurnAttemptIdentity(input: {
  sessionId: string
  runId: string
  messages: readonly UIMessage[]
  reuseLastUserTurn: boolean
  attempts: Map<string, number>
  mintTurnId?: () => string
}): { runId: string; turnId: string; attemptId: string } {
  const anchor = input.reuseLastUserTurn
    ? [...input.messages].reverse().find((message) => message.role === "user")
    : undefined
  const turnId = anchor?.id ?? (input.mintTurnId ?? (() => `user-${crypto.randomUUID()}`))()
  const attemptKey = `${input.sessionId}:${turnId}`
  const ordinal = (input.attempts.get(attemptKey) ?? 0) + 1
  input.attempts.set(attemptKey, ordinal)
  return { runId: input.runId, turnId, attemptId: `a${ordinal}` }
}

/**
 * Re-point a send at a Registry Bundle's aliases, and carry its Workspace
 * Trust proof along in the same step.
 *
 * `resolveSendOptions` stamps `trustedWorkspaceRoots` with the owning
 * workspace's SOURCE roots. The sidecar honours only a trusted root that is
 * also active for the send, so once cwd and additionalDirectories name the
 * aliases, an un-remapped proof intersects to nothing and every requested
 * `claudeAgentSdk` skill or plugin is refused. Each alias inherits the grant of
 * the exact source root it checks out; one whose source was not trusted stays
 * unproven. A proof already on the aliases passes through, so a second
 * redirect over the same bundle is a no-op for it.
 *
 * The aliases join the directories the send already named instead of
 * replacing them: `@`-referenced folders, a slash command's `paths` and the
 * project's extra roots all reach `additionalDirectories` before this runs.
 * Each one that sits in a checked-out source root moves into its alias, so the
 * turn never reaches into the source checkout; one outside every aliased root
 * is kept as it was.
 */
export function redirectSendToBundleAliases(
  options: SendOptions,
  aliases: { primaryAlias: string; additionalAliases: string[] },
  aliasesBySource: ReadonlyMap<string, string>
): SendOptions {
  const additionalDirectories: string[] = []
  for (const directory of [
    ...aliases.additionalAliases,
    ...remapPathsIntoAliases(options.additionalDirectories ?? [], aliasesBySource),
  ]) {
    const trimmed = directory.trim()
    if (!trimmed || trimmed === aliases.primaryAlias || additionalDirectories.includes(trimmed))
      continue
    additionalDirectories.push(trimmed)
  }
  return {
    ...options,
    cwd: aliases.primaryAlias,
    additionalDirectories,
    ...(options.trustedWorkspaceRoots?.length
      ? { trustedWorkspaceRoots: remapExactRoots(options.trustedWorkspaceRoots, aliasesBySource) }
      : {}),
  }
}

/**
 * Owns the direct-chat runtime. Only AgentChatRuntimeProvider mounts this
 * controller; surfaces consume the shared public useAgentChat hook.
 */
/** Retained memory must be retired only when the current projection withholds content. */
export function externalSessionVisibilityMatches(
  link: { personalVisibilityDigest?: string } | undefined,
  visibilityDigest: string,
  withheldMessageIds: readonly string[]
): boolean {
  return withheldMessageIds.length === 0 || link?.personalVisibilityDigest === visibilityDigest
}

/** Rebuild from the canonical parent after admission; cached prompt text grants no visibility. */
export async function buildPersonalAsideContext(
  sessionId: string,
  sourceSessionId: string,
  executionRunId: string,
  options: Parameters<typeof prepareAsideContext>[1] = {}
) {
  const pins = await updateAsideParentMessagePins(sessionId)
  const filtered = await readPersonalAsideHistory(sessionId, sourceSessionId, executionRunId)
  const readers = await preparePersonalHistory(sessionId, [], { executionRunId })
  return {
    ...filtered,
    readersDigest: readers.visibilityDigest,
    delivery: prepareAsideContext(filtered.messages, { ...options, pins }),
  }
}

/** A UI-created fork/clone takes precedence over the tool host's previous native session. */
export function resolveNativeExternalSessionId(
  chatSessionId: string,
  agentId: string,
  hosted?: { agentId: string; nativeSessionId?: string }
): string | undefined {
  const link = externalSessionLinkForSession(chatSessionId)
  if (link?.agentId === agentId && !isGatewaySessionLink(link.sessionId)) return link.sessionId
  return hosted?.agentId === agentId && !isGatewaySessionLink(hosted.nativeSessionId)
    ? hosted.nativeSessionId
    : undefined
}

/** Consume runtime-owned turns through the same parts, approval and durable
 * message seams as prompted external turns. Callers serialize events per chat. */
export function createExternalIdleEventConsumer(
  chatSessionId: string,
  agentId: string,
  nativeSessionId: string,
  registry: SessionCoalescingRegistry,
  remoteDecisionRunId?: () => string | undefined
) {
  let disposed = false
  const approvalIds = new Set<string>()
  const elicitationIds = new Set<string>()
  let run:
    | {
        id: string
        startedAt: number
        parts: UIMessage["parts"]
        usage?: import("@/types/agent/external-agent").ExternalAgentTokenUsage
      }
    | undefined
  const cleanupDecisions = async () => {
    const { resolveExternalApproval, elicitationCancelResponse, getExternalApprovalTarget } =
      await import("@/lib/ai/agent/external/session/chat-decision-bridge")
    const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
    const manager = getExternalAgentManager()
    for (const id of approvalIds) {
      useChatStore.getState().clearApproval(id, chatSessionId)
      const remoteId = getExternalApprovalTarget(id)?.remoteDecisionId
      await resolveExternalApproval(id, "deny", async (agent, session, response) => {
        if (remoteId) {
          const { resolveRemotePermission } =
            await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
          await resolveRemotePermission(remoteId, "deny")
        } else await manager.respondToPermission(agent, session, response)
      }).catch(() => undefined)
    }
    const { useExternalElicitationStore } =
      await import("@/stores/agent/external-elicitation-store")
    for (const entry of useExternalElicitationStore.getState().bySession[chatSessionId] ?? []) {
      if (!elicitationIds.has(entry.request.id)) continue
      useExternalElicitationStore.getState().remove(chatSessionId, entry.request.id)
      if (entry.remoteDecisionId) {
        const { resolveRemoteElicitation } =
          await import("@/lib/ai/agent/external/runtimes/remote/remote-run-client")
        await resolveRemoteElicitation(
          entry.remoteDecisionId,
          elicitationCancelResponse(entry)
        ).catch(() => undefined)
      } else
        await manager
          .respondToElicitation(entry.agentId, elicitationCancelResponse(entry))
          .catch(() => undefined)
    }
    approvalIds.clear()
    elicitationIds.clear()
  }
  const consume = async (event: import("@/types/agent/external-agent").ExternalAgentEvent) => {
    const link = externalSessionLinkForSession(chatSessionId)
    if (
      disposed ||
      event.delivery !== "out_of_band" ||
      event.sessionId !== nativeSessionId ||
      link?.agentId !== agentId ||
      link.sessionId !== nativeSessionId
    )
      return
    const {
      registerExternalApproval,
      registerExternalElicitation,
      registerExternalQuestionTarget,
    } = await import("@/lib/ai/agent/external/session/chat-decision-bridge")
    const { useExternalElicitationStore } =
      await import("@/stores/agent/external-elicitation-store")
    const currentLink = externalSessionLinkForSession(chatSessionId)
    if (disposed || currentLink?.agentId !== agentId || currentLink.sessionId !== nativeSessionId)
      return
    const state = useChatStore.getState()
    if (event.type === "session_end") {
      if (event.error) state.setSessionError(chatSessionId, event.error)
      event = { ...event, type: "done", success: event.reason === "completed" }
    }
    if (event.type === "permission_request") {
      const runId = remoteDecisionRunId?.()
      const approval = registerExternalApproval({
        agentId,
        chatSessionId,
        event,
        ...(runId
          ? { remoteDecisionId: `${runId}:${event.request.requestId ?? event.request.id}` }
          : {}),
      })
      if (approval) {
        approvalIds.add(approval.requestId)
        state.pushApproval(approval)
      }
      return
    }
    if (event.type === "elicitation_request") {
      const runId = remoteDecisionRunId?.()
      const pending = registerExternalElicitation({
        agentId,
        chatSessionId,
        event,
        ...(runId ? { remoteDecisionId: `${runId}:${event.request.id}` } : {}),
      })
      if (pending) {
        elicitationIds.add(pending.request.id)
        useExternalElicitationStore.getState().push(pending)
      }
      return
    }
    if (event.type === "elicitation_complete") {
      useExternalElicitationStore.getState().remove(chatSessionId, event.elicitationId)
      return
    }
    if (event.type === "session_start" && !run) {
      run = { id: crypto.randomUUID(), startedAt: Date.now(), parts: [] }
      state.setSessionStatus(chatSessionId, "streaming")
      setSessionExternalLane(chatSessionId, agentId)
    }
    if (!run) return
    if (event.type === "content_block_start" && event.role === "user") {
      const id = event.messageId ?? `external-user:${run.id}`
      const current = useChatStore.getState().sessions[chatSessionId]?.messages ?? []
      const existing = current.find((message) => message.id === id)
      const block = event.block
      const part =
        block.type === "text"
          ? { type: "text" as const, text: block.text }
          : block.type === "image"
            ? {
                type: "file" as const,
                mediaType: block.mimeType,
                url: `data:${block.mimeType};base64,${block.data}`,
              }
            : undefined
      if (!part) return
      // Reported by the external runtime, not typed here: never the
      // requester's instruction (ADR-0239).
      const message: UIMessage = {
        id,
        role: "user",
        parts: [...(existing?.parts ?? []), part],
        metadata: {
          ...((existing?.metadata as Record<string, unknown> | undefined) ?? {}),
          ...automatedTurnMetadata("external-runtime"),
        },
      }
      const messages = existing
        ? current.map((item) => (item.id === id ? message : item))
        : [...current, message]
      useChatStore.getState().replaceSessionMessages(chatSessionId, messages)
      await persistStreamingMessages(chatSessionId, messages)
      return
    }
    const capture = captureEventFromCanonical(canonicalEventFromExternalEvent(event))
    if (capture) void projectDirectChatCaptureEvent(chatSessionId, capture)
    const inlineQuestions =
      !remoteDecisionRunId &&
      useSettingsStore.getState().settings?.inlineQuestions?.enabled === true
    const questionRequestId =
      event.type === "async_questions" && event.requestId && inlineQuestions
        ? registerExternalQuestionTarget({ agentId, chatSessionId, event })
        : null
    const { applyExternalAgentEventToParts } =
      await import("@/lib/ai/agent/external/session/event-to-parts")
    if (disposed || !run) return
    if (questionRequestId) approvalIds.add(questionRequestId)
    run.parts = applyExternalAgentEventToParts(run.parts, event, {
      inlineQuestions,
      sessionId: chatSessionId,
      ...(questionRequestId ? { questionRequestId } : {}),
    }) as UIMessage["parts"]
    if (event.type === "usage_update" || event.type === "done")
      run.usage = event.tokenUsage ?? run.usage
    if (event.type === "error") state.setSessionError(chatSessionId, event.error)
    if (!run.parts.length) {
      if (event.type === "done") {
        run = undefined
        registry.release(chatSessionId)
        state.setSessionStatus(chatSessionId, event.success ? "idle" : "error")
        setSessionExternalLane(chatSessionId, null)
        await cleanupDecisions()
      }
      return
    }
    const message: UIMessage = {
      id: run.id,
      role: "assistant",
      parts: run.parts,
      metadata: {
        run: {
          providerId: "external",
          startedAt: run.startedAt,
          externalAgent: {
            agentId,
            route: externalAgentRouteKey({ sessionId: nativeSessionId }),
          },
        },
      },
    }
    const current = useChatStore.getState().sessions[chatSessionId]?.messages ?? []
    let messages = [...current.filter((item) => item.id !== run!.id), message]
    const coalescer = registry.get(chatSessionId)
    if (event.type !== "done") {
      coalescer.commit.call(messages)
      coalescer.persist.call(messages)
      return
    }
    coalescer.commit.flush()
    coalescer.persist.cancel()
    messages = attachRunMetadataToLastAssistant(
      messages,
      buildCompletedRunMetadata({
        providerId: "external",
        startedAt: run.startedAt,
        completedAt: Date.now(),
        reportedDurationMs: event.durationMs,
        externalAgent: { agentId, route: externalAgentRouteKey({ sessionId: nativeSessionId }) },
      })
    )
    if (run.usage)
      messages = attachUsageToLastAssistant(
        messages,
        externalTokenUsageToUsageInfo(run.usage) as unknown as Record<string, unknown>
      )
    useChatStore.getState().replaceSessionMessages(chatSessionId, messages)
    await persistMessages(chatSessionId, messages)
    if (disposed || !run) return
    if (run.usage)
      await recordExternalAgentUsage({
        sessionId: chatSessionId,
        messageId: run.id,
        usage: run.usage,
        durationMs: event.durationMs,
        at: Date.now(),
      }).catch((error) => console.warn("recordExternalAgentUsage failed", error))
    run = undefined
    registry.release(chatSessionId)
    useChatStore.getState().setSessionStatus(chatSessionId, event.success ? "idle" : "error")
    setSessionExternalLane(chatSessionId, null)
    await cleanupDecisions()
  }
  return Object.assign(consume, {
    async dispose() {
      disposed = true
      if (run) {
        const coalescer = registry.get(chatSessionId)
        coalescer.commit.flush()
        coalescer.persist.flush()
        registry.release(chatSessionId)
        run = undefined
        useChatStore.getState().setSessionStatus(chatSessionId, "idle")
        setSessionExternalLane(chatSessionId, null)
      }
      await cleanupDecisions()
    },
  })
}

/** Per-call options of the chat send pipeline (`useAgentChat().send` and its lanes). */
export interface AgentChatSendCallOptions {
  localAuthorization?: LocalPersonRun
  /** Host-only preparation ownership, captured by invokeOwnedSend. */
  onExecutionRunPrepared?: (runId: string) => void
  /** Skip the optimistic user-message append. Used by `regenerate` so we
   *  don't duplicate the user turn when re-issuing the SDK request. */
  sharedRequest?: { messageId: string; queueItemId: string; takeover?: boolean }
  skipUserAppend?: boolean
  /** Continue the latest interrupted user turn on the runtime that handled it. */
  continuationOf?: string
  /** Stable journal batch identity, reserved before automatic result delivery. */
  backgroundDelivery?: {
    id: string
    onAccepted: () => void
    personalRunIds?: readonly string[]
  }
  /**
   * An automation, not the person, is sending this turn. Stamped on the
   * user row as `metadata.automatedTurn` so it never counts as the
   * person's instruction (ADR-0239). A background delivery is always
   * `background-result`.
   */
  automatedTurn?: AutomatedTurnProducer
  /** Let approval continuations retain a retry action when dispatch is refused. */
  throwOnError?: boolean
  /** Skip Thread-B delegation routing. Set on the built-in fallback
   *  re-entry so a failed external delegation runs the SDK path without
   *  re-evaluating (and re-matching) the delegation rules. */
  bypassDelegation?: boolean
  /** This turn is the steer queue replaying itself. Like `skipUserAppend`
   *  it must not append a user message (each queued entry was already
   *  shown optimistically when typed), but unlike it this IS a genuine
   *  user turn: it still pauses a self-driving goal/loop, still counts as
   *  a sent message, and still goes through delegation routing. Kept as
   *  its own flag rather than reusing `skipUserAppend` precisely so those
   *  three behaviors don't silently disappear. */
  steerDrain?: boolean
  /** Target session — defaults to the focused session. A multi-pane
   *  composer passes its own session id so each pane sends to itself. */
  sessionId?: string
  /** Private Context Workbench snapshot/selection. This is never exposed
   *  to plugin prompt hooks or persisted as visible message content. */
  resourceContext?: string
  /** Provenance for the leading attachment blocks, from
   *  `buildSendContent`. Lets the optimistic user message render file
   *  cards (with filenames) instead of raw extracted text. */
  attachmentManifest?: readonly AttachmentManifestEntry[]
  /** What this turn was written from, when a template with parameters
   *  produced it. Persisted on the user message row so the turn can be
   *  re-run with different values — the sent text has the values
   *  substituted in and no longer marks which words they were. */
  templateRun?: ChatTemplateRun | null
  /** Search sources resolved by the composer before this turn dispatches. */
  webSearchContext?: SendOptions["webSearchContext"]
  /** Explicit user choice after a failed interactive setup. Scheduled
   * runs never expose or honor this bypass. */
  bypassEnvironmentSetup?: boolean
  /** Stamp the optimistic USER message into a branch group.
   *
   *  Set by `editAndResend`, which keeps the original question as a
   *  sibling instead of deleting it. Passed explicitly rather than via a
   *  pending-tag ref (the shape `regenerate` uses) because the message
   *  being tagged is created right here — a ref would have to survive
   *  until an SDK event arrives, which is only necessary when the target
   *  is an assistant message that does not exist yet. */
  branchTag?: {
    groupId: string
    index: number
    edit?: { messageId: string; previousContent: string }
  }
  /** Own this turn's replies by an edit's replacement row that is
   *  already in the transcript (set by the external-delegation fallback
   *  when it re-issues an `editAndResend`, alongside `skipUserAppend`).
   *
   *  Only the owner half of `branchTag`: the send that appended the row
   *  already stamped it into its group and selected it. Re-running
   *  `branchTag` here would stamp and select the fresh user message this
   *  send builds but never appends, and own the reply by that id — a row
   *  that does not exist, so the reply shows under every sibling. */
  branchOwnerId?: string
  /** Re-issue the thread's last user turn as a new branch (set by
   *  `regenerate`, alongside `skipUserAppend`).
   *
   *  The replies under `anchorId` become siblings in its branch group
   *  and the reply this turn produces is armed to take the next slot.
   *  Applied here, past every gate that can refuse the turn before it
   *  starts, rather than by `regenerate` up front: a tag armed for a turn
   *  that never runs is consumed by the NEXT turn's first reply. */
  regenerateBranch?: { anchorId: string }
  /**
   * The message this turn answers (ADR-0177 batch 2). Persisted as
   * `metadata.replyTo` on the user row, and read to the model as one
   * line ahead of the prompt, so the quoted text never becomes part of
   * what the user is recorded as having typed.
   */
  replyTo?: MessageReplyTo
  /**
   * What the context envelope in front of the typed text carries
   * (`lib/chat/prompt-preamble.ts`). Persisted as
   * `metadata.promptPreamble` so the bubble can name the references.
   */
  promptPreamble?: PromptPreambleSummary
  /**
   * The records this turn cites, assembled by the composer from the
   * chips it sent. Preferred over the store's `citedRefs`, which are
   * keyed by conversation and so empty for a first message staged in
   * the new-chat composer. Absent for sends that do not come from a
   * composer.
   */
  citations?: readonly ContextRef[]
  /** The executor chosen for THIS turn only (ADR-0117 axes).
   *
   *  Deliberately not persisted: a sticky override would quietly become
   *  a session-level switch, leaving nothing on screen to name what the
   *  conversation is actually bound to. The composer resets after send;
   *  the durable binding is `ChatSession.squadId`. */
  compositionOverride?:
    import("@cognia/agent-config-types/agent-composition").AgentCompositionSelectionV1 | null
  /**
   * The runtime this turn is addressed to by its leading `@claude` /
   * `@codex` / `@<Squad member>` (`lib/chat/turn-route/`).
   *
   * Re-resolved here against the stores at commit time: a lane that
   * cannot run refuses the turn before anything is written, and it NEVER
   * falls back to the conversation's own runtime. Persisted as
   * `metadata.turnRoute` on the user row so a regenerate re-runs the turn
   * where it was addressed. Nothing about the session changes.
   */
  turnRoute?: TurnRoute | null
}
