"use client"
import { memo, useCallback } from "react"

import type { TextInputContext } from "@/components/ai-elements/prompt-input"

import { VoiceControls } from "./voice-controls"

/**
 * Speech → text, appended to the draft.
 *
 * Takes the composer's stable text handle as a prop instead of reading the
 * prompt-input context: a context consumer re-renders on every keystroke, and
 * this one carries the whole voice cluster (dictation, live voice, the
 * settings popover) with it. Memoized with a stable handle, typing never
 * reaches it.
 */
export const VoiceTranscriptionBridge = memo(function VoiceTranscriptionBridge({
  disabled,
  textInput,
}: {
  disabled?: boolean
  textInput: TextInputContext
}) {
  const onTranscription = useCallback(
    (text: string) => {
      if (!text.trim()) return
      const cur = textInput.value
      const sep = cur && !cur.endsWith(" ") ? " " : ""
      textInput.setInput(`${cur}${sep}${text}`)
    },
    [textInput]
  )
  return <VoiceControls disabled={disabled} onTranscription={onTranscription} />
})
