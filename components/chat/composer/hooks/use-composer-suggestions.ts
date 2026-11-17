"use client"

import type React from "react"
import type { ComposerInnerProps } from "../../composer"
import {
  type AttachmentsContext,
  type TextInputContext,
} from "@/components/ai-elements/prompt-input"
import { type UseComposerGhostTextResult } from "@/hooks/chat/use-composer-ghost-text"
import { useFollowUpSuggestions } from "@/hooks/chat/use-follow-up-suggestions"
import { type DraftAttachmentMeta } from "@/lib/db/chat-drafts"
import { useCallback } from "react"

export interface ComposerSuggestionsInput {
  outboundBlocked: boolean
  persistDrafts: boolean
  textValue: string
  textInput: TextInputContext
  attachments: AttachmentsContext
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  turnInFlight: boolean
  followUpInFlight: boolean
  turnInFlightRef: React.RefObject<boolean>
  followUpInFlightRef: React.RefObject<boolean>
  setCaret: React.Dispatch<React.SetStateAction<number>>
  isComposing: boolean
  draftHydratedFor: string | null
  restoredAttachments: DraftAttachmentMeta[]
  attachmentPrepareCountRef: React.RefObject<number>
  sessionId: string | null
  ghost: UseComposerGhostTextResult
  acceptedPredictionRef: React.RefObject<{ sessionId: string | null; text: string } | null>
  submit: () => Promise<boolean>
  props: Pick<ComposerInnerProps, "disabled" | "session" | "status">
}

/**
 * Inline suggestions in the composer: accepting ghost text, and the follow-up
 * prediction offered in an empty box (fill it, or send it at once).
 */
export function useComposerSuggestions(input: ComposerSuggestionsInput) {
  const {
    outboundBlocked,
    persistDrafts,
    textValue,
    textInput,
    attachments,
    textareaRef,
    turnInFlight,
    followUpInFlight,
    turnInFlightRef,
    followUpInFlightRef,
    setCaret,
    isComposing,
    draftHydratedFor,
    restoredAttachments,
    attachmentPrepareCountRef,
    sessionId,
    ghost,
    acceptedPredictionRef,
    submit,
    props,
  } = input

  // Accept the inline ghost-text suggestion: write the completed value back
  // into the textarea and park the caret at the end. Shared by the keyboard
  // (Tab) path below and the suggestion card's accept button, since touch
  // devices have no Tab key. Returns false when there was nothing to
  // accept so the Tab keystroke can fall through to its default behavior.
  const acceptGhost = useCallback((): boolean => {
    const next = ghost.accept()
    if (next === null) return false
    textInput.setInput(next)
    setCaret(next.length)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (ta) {
        ta.setSelectionRange(next.length, next.length)
        ta.focus()
      }
    })
    return true
  }, [ghost, textInput, setCaret, textareaRef])

  // Predictions belong to this input's session and never replace a user's work.
  // Wait for draft hydration so a late restore cannot overwrite an accepted prediction.
  const predictionEligible =
    !!props.session &&
    props.session.kind !== "subagent" &&
    !props.session.platformBinding &&
    !props.disabled &&
    !outboundBlocked &&
    props.status !== "streaming" &&
    !turnInFlight &&
    !followUpInFlight &&
    !isComposing &&
    textValue === "" &&
    attachments.files.length === 0 &&
    restoredAttachments.length === 0 &&
    (!persistDrafts || draftHydratedFor === props.session.id)
  const prediction = useFollowUpSuggestions(props.session, { enabled: predictionEligible })
  const acceptPrediction = useCallback(
    (text: string, sendImmediately = false): boolean => {
      if (
        !predictionEligible ||
        turnInFlightRef.current ||
        followUpInFlightRef.current ||
        textInput.value !== "" ||
        attachments.files.length > 0 ||
        attachmentPrepareCountRef.current > 0 ||
        isComposing
      )
        return false
      acceptedPredictionRef.current = { sessionId, text }
      textInput.setInput(text)
      setCaret(text.length)
      if (sendImmediately) {
        // Reuse this bound composer's validation, model routing and send protection.
        void submit()
      } else {
        const input = textareaRef.current
        requestAnimationFrame(() => {
          // A session change remounts/resets the input; never focus a new owner.
          if (input && input === textareaRef.current && input.value === text) {
            input.setSelectionRange(text.length, text.length)
            input.focus()
          }
        })
      }
      prediction.dismiss()
      return true
    },
    [
      predictionEligible,
      sessionId,
      textInput,
      attachments.files.length,
      attachmentPrepareCountRef,
      isComposing,
      prediction,
      submit,
      acceptedPredictionRef,
      followUpInFlightRef,
      setCaret,
      textareaRef,
      turnInFlightRef,
    ]
  )
  return { acceptGhost, predictionEligible, prediction, acceptPrediction }
}
