"use client"

import { useOpenGoal } from "@/components/goal/use-active-goal"
import { type AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { canContinueChat, lastUserMessage } from "@/lib/chat/continuation"
import { type ChatTemplateRun } from "@/lib/chat/template/run"
import { type ComposerTurnMetadata } from "@/lib/chat/turn-metadata"
import { readTurnRoute } from "@/lib/chat/turn-route/types"
import { selectVisibleMessages, useChatStore } from "@/stores/chat"
import { type ChatStatus } from "@/stores/chat/chat-store"
import { type ChatSession, type SendContent } from "@cognia/agent-config-types"
import { useTranslations } from "next-intl"
import { useCallback } from "react"

export interface ComposerResumeInput {
  session: ChatSession | null | undefined
  paneStatus: ChatStatus | undefined
  onSend: (
    content: SendContent,
    manifest?: readonly AttachmentManifestEntry[] | undefined,
    templateRun?: ChatTemplateRun | null | undefined,
    turnMetadata?: ComposerTurnMetadata | undefined
  ) => boolean | void | Promise<boolean | void>
  disabled: boolean | undefined
}

/**
 * Whether this conversation can be resumed after an interrupted turn, and
 * resuming it: a continuation of the last visible user message, re-addressed to
 * that message's route and members. Never for an IM-bound, subagent or
 * goal-driven conversation.
 */
export function useComposerResume(input: ComposerResumeInput) {
  const { session, paneStatus, onSend, disabled } = input

  const tContinuation = useTranslations("chat.composer")
  const openGoal = useOpenGoal(session?.id)
  const canResume = useChatStore((state) => {
    if (!session || session.platformBinding || session.kind === "subagent" || openGoal) return false
    const slice =
      state.sessions[session.id] ?? (state.activeSessionId === session.id ? state : undefined)
    return (
      !!slice &&
      !slice.messagesLoading &&
      canContinueChat({
        status: paneStatus ?? slice.status,
        messages: selectVisibleMessages(slice.messages, slice.activeBranchByGroup),
        diagnostic: slice.errorDiagnostic,
        errorMessage: slice.errorMessage,
        queued: !!("queuedTurnMessageId" in slice && slice.queuedTurnMessageId),
      })
    )
  })
  const handleResume = useCallback(async () => {
    if (!session || disabled || !canResume) return
    const state = useChatStore.getState()
    const slice =
      state.sessions[session.id] ?? (state.activeSessionId === session.id ? state : undefined)
    if (
      !slice ||
      !canContinueChat({
        status: slice.status,
        messages: selectVisibleMessages(slice.messages, slice.activeBranchByGroup),
        diagnostic: slice.errorDiagnostic,
        errorMessage: slice.errorMessage,
        queued: !!("queuedTurnMessageId" in slice && slice.queuedTurnMessageId),
      })
    )
      return
    const user = lastUserMessage(selectVisibleMessages(slice.messages, slice.activeBranchByGroup))
    if (!user) return
    const route = readTurnRoute(user.metadata)
    const memberIds = (user.metadata as { targetMemberIds?: unknown } | undefined)?.targetMemberIds
    await onSend(tContinuation("resumePrompt"), [], null, {
      continuationOf: user.id,
      ...(route ? { route } : {}),
      ...(Array.isArray(memberIds) && memberIds.every((id) => typeof id === "string")
        ? { targetMemberIds: memberIds }
        : {}),
    })
  }, [canResume, disabled, onSend, session, tContinuation])
  return { canResume, handleResume }
}
