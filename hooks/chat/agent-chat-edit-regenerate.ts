"use client"

import type React from "react"
import { type AgentChatSendCallOptions, userPromptText } from "./agent-chat-turn-helpers"
import { type AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { tagEditSibling } from "@/lib/chat/branch-regen"
import {
  carryPromptPreamble,
  chipCitationsOf,
  readPromptPreambleSummary,
  stripPromptPreamble,
} from "@/lib/chat/prompt-preamble"
import { type AsideContextDelivery } from "@/lib/chat/session-aside-context"
import { sessionStatusOf } from "@/lib/chat/steer-runtime"
import { type SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import { parseLeadingRoute } from "@/lib/chat/turn-route/parse"
import { resolveRouteLane } from "@/lib/chat/turn-route/resolve"
import { snapshotRouteContext } from "@/lib/chat/turn-route/snapshot"
import { isRoutableSession, readTurnRoute, type TurnRoute } from "@/lib/chat/turn-route/types"
import { interruptedTurnResumeMessage } from "@/lib/chat/interrupted-turn"
import { persistMessages } from "@/lib/db/messages"
import { getSession } from "@/lib/db/sessions"
import { listWorkSubmissions } from "@/lib/db/work-submissions"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { isChatTurnQueued } from "@/lib/execution/chat-lease"
import { closeParkedAgentTurnRun } from "@/lib/execution/direct-chat-run"
import { useChatStore } from "@/stores/chat"
import { type SendContent, type SendOptions } from "@cognia/agent-config-types"
import { createDiagnostic } from "@cognia/diagnostics"
import { type UIMessage } from "ai"
import { type useTranslations } from "next-intl"
import { toast } from "sonner"

/** What these operations read from `useAgentChat`. */
export interface AgentChatEditRegenerateContext {
  store: typeof useChatStore
  tAttachments: ReturnType<typeof useTranslations<"chat.composer.attachments">>
  refuseCapturedTurn: (sessionId: string) => boolean
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
  registry: SessionCoalescingRegistry
  send: (
    content: SendContent,
    opts?: SendOptions | undefined,
    callOptions?: AgentChatSendCallOptions | undefined
  ) => Promise<boolean>
  warnNotResent: (filenames: readonly string[]) => void
}

export function warnMessagesNotResent(
  ctx: Pick<AgentChatEditRegenerateContext, "tAttachments">,
  filenames: readonly string[]
) {
  const { tAttachments } = ctx

  if (filenames.length === 0) return
  toast.warning(tAttachments("notResent", { count: filenames.length, names: filenames.join(", ") }))
}

export async function runEditAndResend(
  ctx: Pick<
    AgentChatEditRegenerateContext,
    | "store"
    | "refuseCapturedTurn"
    | "messagesMirrorRef"
    | "lastResourceContextRef"
    | "registry"
    | "send"
    | "warnNotResent"
  >,
  messageId: string,
  newContent: SendContent,
  targetSessionId?: string,
  resourceContext?: string,
  attachmentManifest?: readonly AttachmentManifestEntry[]
) {
  const {
    store,
    refuseCapturedTurn,
    messagesMirrorRef,
    lastResourceContextRef,
    registry,
    send,
    warnNotResent,
  } = ctx

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
}

export async function runRegenerate(
  ctx: Pick<
    AgentChatEditRegenerateContext,
    | "refuseCapturedTurn"
    | "messagesMirrorRef"
    | "lastUserContentRef"
    | "lastResourceContextRef"
    | "registry"
    | "send"
    | "warnNotResent"
  >,
  targetSessionId?: string,
  resourceContext?: string
) {
  const {
    refuseCapturedTurn,
    messagesMirrorRef,
    lastUserContentRef,
    lastResourceContextRef,
    registry,
    send,
    warnNotResent,
  } = ctx

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
}

/**
 * Continue a turn that a crash or restart cut off and the work outbox parked
 * for a person (ADR-0123). The conversation already holds the interrupted user
 * message and whatever reply was saved, so nothing is appended: one silent
 * turn asks the agent to carry on from there. Once it is sent, the parked run
 * is closed, so the run list stops offering a turn this one replaced.
 *
 * Only the session's newest submission, still parked, is continued: the card
 * that asked may be stale. Returns whether the continuation was sent.
 */
export async function runResumeInterrupted(
  ctx: Pick<AgentChatEditRegenerateContext, "refuseCapturedTurn" | "send">,
  targetSessionId?: string
): Promise<boolean> {
  const sessionId = targetSessionId ?? useChatStore.getState().activeSessionId
  if (!sessionId) return false
  if (ctx.refuseCapturedTurn(sessionId)) return false
  const status = sessionStatusOf(sessionId)
  if (status === "streaming" || status === "awaiting_approval" || isChatTurnQueued(sessionId))
    return false

  const [latest] = await listWorkSubmissions({ sessionId, limit: 1 })
  if (
    !latest ||
    latest.sourceKind !== "chat" ||
    latest.dispatchState !== "settled" ||
    latest.terminalOutcome !== "recovery_required"
  )
    return false

  const sent = await ctx.send(interruptedTurnResumeMessage(), undefined, {
    localAuthorization: LOCAL_PERSON_RUN,
    skipUserAppend: true,
    sessionId,
  })
  if (sent) await closeParkedAgentTurnRun(latest.runId, "Continued in a new turn")
  return sent
}
