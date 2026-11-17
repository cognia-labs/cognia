"use client"

/**
 * The message commands whose work is the same on every surface (D10): reply,
 * rerun the template a turn was written from, save as a memory or an issue,
 * and hand a message back up (bring back / send to main). The desktop bar and
 * "…" menu and the phone's long-press sheet call these, so the sheet offers
 * them too and the two cannot drift. Commands with surface-specific feedback
 * (copy's tick, the sheet's haptics and close) keep their own handlers.
 */

import { useCallback, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { UIMessage } from "ai"
import { loggers } from "@cognia/logging"

import { dispatchComposerAppend } from "@/components/chat/composer"
import { useAsideTarget } from "@/components/context-workbench/aside-target"
import { messageRefId } from "@/lib/chat/mentions/message-reference"
import { entityCitation } from "@/lib/chat/mentions/selection-citations"
import { messageTypedText } from "@/lib/chat/message-share"
import { buildReplyTo } from "@/lib/chat/reply-to"
import { saveMessageAsIssue } from "@/lib/chat/save-message-as-issue"
import { saveMessageAsMemory } from "@/lib/chat/save-message-as-memory"
import { requestTemplateRerun } from "@/lib/chat/template/rerun-request"
import { readChatTemplateRun } from "@/lib/chat/template/run"
import { getSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useProjectStore } from "@/stores/project/project-store"

export interface MessageCommandTarget {
  /** Null while a sheet is closed: every command is then a no-op. */
  message: UIMessage | null
  /** The conversation the message belongs to. */
  sessionId: string | undefined
  /** The session the row is drawn in (a side chat's own id); defaults to `sessionId`. */
  documentSessionId?: string | null
}

export interface MessageCommands {
  /** A side chat's main conversation, when the row sits in one. */
  asideTargetSessionId: string | null
  /** Where "bring back" lands: the main conversation, or the branch's parent. */
  handBackTargetId: string | null
  /** The template parameters the turn was written from, when it recorded them. */
  templateRun: ReturnType<typeof readChatTemplateRun>
  reply: () => void
  rerunTemplate: () => void
  saveAsMemory: () => Promise<void>
  saveAsIssue: () => Promise<void>
  bringBack: () => Promise<void>
  sendToMain: () => Promise<void>
}

function quoted(content: string): string {
  return `${content
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}\n\n`
}

export function useMessageCommands({
  message,
  sessionId,
  documentSessionId = sessionId,
}: MessageCommandTarget): MessageCommands {
  const t = useTranslations("chat.message")
  const tAsides = useTranslations("contextWorkbench.asides")
  const router = useRouter()
  // Non-null only inside a workbench sidechat — see `AsideTargetProvider`.
  const asideTargetSessionId = useAsideTarget()
  // An aside hands back to the main conversation; a branch hands back to the
  // one it was cut from. Both are "up one level", so one command covers both.
  const branchParentId = useLiveQuery(
    async () => (sessionId ? ((await getSession(sessionId))?.parentSessionId ?? null) : null),
    [sessionId]
  )
  const handBackTargetId = asideTargetSessionId ?? branchParentId ?? null
  const templateRun = useMemo(
    () => (message ? readChatTemplateRun((message as { metadata?: unknown }).metadata) : null),
    [message]
  )

  // Aim the composer's next send at this row (ADR-0177 batch 2). The store
  // keeps one target per conversation, so a second click on another row simply
  // replaces the first, and the chip over the composer is the only UI state.
  const reply = useCallback(() => {
    if (!sessionId || !message) return
    useChatStore.getState().setReplyTo(buildReplyTo(message), sessionId)
  }, [sessionId, message])

  const rerunTemplate = useCallback(() => {
    if (!sessionId || !templateRun) return
    requestTemplateRerun({ sessionId, run: templateRun })
  }, [sessionId, templateRun])

  const saveAsMemory = useCallback(async () => {
    if (!sessionId || !message) return
    try {
      // Read at click time rather than subscribed: the value is used once per
      // action, and `branch-dialog.tsx` reaches for it the same way.
      const { activeProjectId } = useProjectStore.getState()
      const title = await saveMessageAsMemory({
        parts: message.parts,
        sessionId,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      })
      // Nothing readable in the turn. Saying so beats a success toast for a
      // draft that was never filed.
      if (!title) {
        toast.error(t("saveAsMemoryEmpty"))
        return
      }
      toast.success(t("saveAsMemoryDone", { title }))
    } catch (err) {
      // A PII-gate refusal arrives here, and it is a real answer the user has
      // to see — the draft was not filed and no retry will change that.
      toast.error(
        t("saveAsMemoryFailed", { reason: err instanceof Error ? err.message : String(err) })
      )
    }
  }, [sessionId, message, t])

  const saveAsIssue = useCallback(async () => {
    if (!sessionId || !message) return
    try {
      const { activeProjectId } = useProjectStore.getState()
      const issue = await saveMessageAsIssue({
        parts: message.parts,
        sessionId,
        messageId: message.id,
        ...(activeProjectId ? { projectId: activeProjectId } : {}),
      })
      if (!issue) {
        toast.error(t("saveAsIssueEmpty"))
        return
      }
      toast.success(t("saveAsIssueDone", { identifier: issue.identifier }), {
        action: {
          label: t("saveAsIssueOpen"),
          onClick: () => router.push(`/issues?id=${encodeURIComponent(issue.id)}`),
        },
      })
    } catch (err) {
      // "Create a project first" is a real answer the user has to see.
      toast.error(
        t("saveAsIssueFailed", { reason: err instanceof Error ? err.message : String(err) })
      )
    }
  }, [sessionId, message, router, t])

  const handBack = useCallback(
    async (submit: boolean) => {
      const target = submit ? asideTargetSessionId : handBackTargetId
      if (!target || !message) return
      const content = messageTypedText(message).trim()
      if (!content) return
      const text = quoted(content)
      const source =
        asideTargetSessionId && documentSessionId
          ? await getSession(documentSessionId).catch((error) => {
              loggers.chat.warn("Could not read side chat title", error)
              return undefined
            })
          : undefined
      const citations =
        asideTargetSessionId && documentSessionId
          ? [
              entityCitation(
                "message",
                messageRefId(documentSessionId, message.id),
                source?.title || tAsides("fallbackName")
              ),
            ]
          : []
      const claimed = dispatchComposerAppend({
        text,
        citations,
        sessionId: target,
        submit,
        ...(submit
          ? {
              onSubmitted: (sent: boolean) => {
                if (sent) toast.success(t("sendToMainDone"))
                else toast.info(t("sendToMainDraft"))
              },
            }
          : {}),
      })
      if (!claimed) {
        useComposerIntentStore.getState().stage(target, {
          candidateId: crypto.randomUUID(),
          prompt: text,
          mode: "append",
          citations,
        })
        toast.info(t(submit ? "sendToMainDraft" : "bringBackDraft"))
      } else if (!submit) toast.success(t("bringBackDone"))
    },
    [asideTargetSessionId, documentSessionId, handBackTargetId, message, t, tAsides]
  )
  const bringBack = useCallback(() => handBack(false), [handBack])
  const sendToMain = useCallback(() => handBack(true), [handBack])

  return {
    asideTargetSessionId,
    handBackTargetId,
    templateRun,
    reply,
    rerunTemplate,
    saveAsMemory,
    saveAsIssue,
    bringBack,
    sendToMain,
  }
}
