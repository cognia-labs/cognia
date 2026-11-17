"use client"

import type { ComposerInnerProps } from "../../composer"
import { resolveSendButton } from "../send-button-mode"
import { type AttachmentsContext } from "@/components/ai-elements/prompt-input"
import { mobileTransition, useReducedMotionTransition } from "@/lib/ui/motion"

export interface ComposerSendButtonInput {
  outboundBlocked: boolean
  textValue: string
  attachments: AttachmentsContext
  turnInFlight: boolean
  followUpInFlight: boolean
  isPreparingAttachments: boolean
  props: Pick<
    ComposerInnerProps,
    "canResume" | "commandRunning" | "disabled" | "pendingDraftCount" | "session" | "status"
  >
}

/**
 * The primary button's whole state (send / stop / spinner / draft) in one
 * decision, and the cross-fade for its icon swap. See `send-button-mode.ts` for
 * the combination table.
 */
export function useComposerSendButton(input: ComposerSendButtonInput) {
  const {
    outboundBlocked,
    textValue,
    attachments,
    turnInFlight,
    followUpInFlight,
    isPreparingAttachments,
    props,
  } = input

  const isStreaming = props.status === "streaming"
  // The primary button's whole state (send / stop / spinner / draft) in one
  // decision — see `send-button-mode.ts` for the combination table. While a
  // turn runs the button is Stop; a typed follow-up gets its own control
  // beside it rather than taking Stop away.
  //
  // A fresh turn's dispatch counts as "sending" only until the turn is live:
  // past that point the run's own state (Stop) is the truth, however long the
  // runtime keeps `onSubmit` pending.
  const isSending = followUpInFlight || (turnInFlight && !isStreaming)
  const sendButton = resolveSendButton({
    status: props.commandRunning
      ? "streaming"
      : props.session?.platformBinding
        ? "ready"
        : props.status,
    isSending: props.commandRunning ? false : isSending,
    isPreparingAttachments,
    hasContent:
      !props.commandRunning && (textValue.trim().length > 0 || attachments.files.length > 0),
    canResume: props.canResume,
    hasPendingDrafts: (props.pendingDraftCount ?? 0) > 0,
    composerDisabled: !!props.disabled,
    outboundBlocked,
  })
  // Cross-fade transition for the send/stop button icon swap (reduced-motion aware).
  const sendIconTransition = useReducedMotionTransition(mobileTransition("fast"))
  return { isStreaming, sendButton, sendIconTransition }
}
