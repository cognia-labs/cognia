"use client"
import { memo, useEffect } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"
import {
  COMPOSER_APPEND_EVENT,
  composerAppendHasContent,
  type ComposerAppendDetail,
} from "@/lib/chat/composer-append"
import { selectComposerReplyTo, useChatStore } from "@/stores/chat"

/**
 * Lets components outside the PromptInput controller context (e.g. the OCR
 * result card in the message list, a sidechat handing a conclusion back, or a
 * stopped turn putting its queued follow-ups back) stage material in the
 * composer by dispatching `COMPOSER_APPEND_EVENT`. Text is appended; files are
 * staged as attachments; citations, reply target and carried envelopes go to
 * this conversation's composer state, where the send path reads them.
 */
export const ComposerAppendBridge = memo(function ComposerAppendBridge({
  sessionId,
  textInput,
  addFiles,
  requestSubmit,
}: {
  sessionId?: string
  /** The composer's stable text handle — see `VoiceTranscriptionBridge`. */
  textInput: TextInputContext
  /** Stage files the way a drop or paste does. */
  addFiles: (files: File[]) => void
  requestSubmit: (text: string, onSubmitted?: (sent: boolean) => void) => void
}) {
  const t = useTranslations("chat.composer.putBack")
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  useEffect(() => {
    const onAppend = (e: Event) => {
      const detail = (e as CustomEvent<ComposerAppendDetail>).detail
      if (!composerAppendHasContent(detail) || detail.claimed) return
      // Addressed events go to exactly one composer. An un-addressed event is
      // legacy shorthand for "the active session", which keeps the single-pane
      // callers working without making every composer echo it.
      const target = detail.sessionId ?? activeSessionId
      if (target && target !== sessionId) return
      detail.claimed = true
      const text = detail.text
      let appended = textInput.value
      if (text && text.trim()) {
        const cur = textInput.value
        const sep = cur && !cur.endsWith(" ") ? " " : ""
        appended = `${cur}${sep}${text}`
        textInput.setInput(appended)
      }
      if (detail.files?.length) addFiles([...detail.files])
      const chat = useChatStore.getState()
      const slice = sessionId ?? null
      for (const ref of detail.citations ?? []) chat.addCitedRef(ref, slice)
      if (detail.submit) requestSubmit(appended, detail.onSubmitted)
      if (detail.carried?.length) chat.addCarriedPreambles([...detail.carried], slice)
      // A reply the user already picked here wins over the one coming back.
      if (detail.replyTo && !selectComposerReplyTo(chat, slice))
        chat.setReplyTo(detail.replyTo, slice)
      if (detail.missing?.length) {
        toast.warning(
          t("missing", { count: detail.missing.length, names: detail.missing.join(", ") })
        )
      }
    }
    window.addEventListener(COMPOSER_APPEND_EVENT, onAppend)
    return () => window.removeEventListener(COMPOSER_APPEND_EVENT, onAppend)
  }, [textInput, activeSessionId, sessionId, addFiles, requestSubmit, t])
  return null
})
