"use client"

import type React from "react"
import { pillDeleteRange } from "../../composer-pill-delete"
import { type ComposerTrigger } from "../../composer-trigger"
import { type TextInputContext } from "@/components/ai-elements/prompt-input"
import { useStableCallback } from "@/hooks/ui/use-stable-callback"
import { type ParamSegment, type RichSegment } from "@/lib/slash-commands/parse-segments"
import { useCallback, useEffect } from "react"

export interface ComposerPillEditingInput {
  textInput: TextInputContext
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  setCaret: React.Dispatch<React.SetStateAction<number>>
  overlaySegments: RichSegment[]
  setActiveParamId: React.Dispatch<React.SetStateAction<string | null>>
  paramTokens: ParamSegment[]
  completionTrigger: ComposerTrigger | null
}

/**
 * Editing the input's pills as units: Tab steps between template parameters,
 * and Backspace/Delete beside a pill removes the whole token, from the keyboard
 * or a soft keyboard's beforeinput.
 */
export function useComposerPillEditing(input: ComposerPillEditingInput) {
  const {
    textInput,
    textareaRef,
    setCaret,
    overlaySegments,
    setActiveParamId,
    paramTokens,
    completionTrigger,
  } = input

  // --- Textarea key handling --------------------------------------------
  /**
   * Move the caret to the parameter after (or before) the caret and open it.
   * Returns false when there is nowhere to go, so the caller can let the key
   * do its normal job.
   */
  const stepToParam = useCallback(
    (direction: 1 | -1): boolean => {
      const ta = textareaRef.current
      if (!ta || paramTokens.length === 0) return false
      const caretAt = ta.selectionStart ?? 0
      const ordered = direction === 1 ? paramTokens : [...paramTokens].reverse()
      const next =
        ordered.find((seg) => (direction === 1 ? seg.start > caretAt : seg.end < caretAt)) ??
        ordered[0]
      if (!next) return false
      ta.setSelectionRange(next.start, next.start)
      setCaret(next.start)
      setActiveParamId(next.paramId)
      return true
    },
    [paramTokens, setActiveParamId, setCaret, textareaRef]
  )

  /**
   * Remove the whole `/command`, `@mention`, `{{parameter}}` or folded-link pill
   * the collapsed caret is hugging, and report whether it did. Only while no
   * completion popover is open, so mid-typing edits stay character by character.
   */
  const deletePillAtCaret = useCallback(
    (ta: HTMLTextAreaElement, direction: "backward" | "forward"): boolean => {
      if (completionTrigger || ta.selectionStart !== ta.selectionEnd) return false
      const range = pillDeleteRange(textInput.value, ta.selectionStart, overlaySegments, direction)
      if (!range) return false
      const cur = textInput.value
      textInput.setInput(cur.slice(0, range.start) + cur.slice(range.end))
      setCaret(range.start)
      requestAnimationFrame(() => {
        const ta2 = textareaRef.current
        if (ta2) {
          ta2.setSelectionRange(range.start, range.start)
          ta2.focus()
        }
      })
      return true
    },
    [completionTrigger, textInput, overlaySegments, setCaret, textareaRef]
  )

  // The same atomic delete for keyboards that never send a usable keydown.
  // Android's soft keyboards (Gboard, the EMUI keyboard, every IME) report
  // Backspace as `key: "Unidentified"`, so on a phone the keydown branch never
  // fired and one Backspace turned the `/goal` pill into the plain text
  // `/goa`, which then went out as an ordinary message. What they do send is
  // a cancelable `beforeinput` naming the edit, so the pill is caught there.
  // Listened for on the document because the textarea mounts and remounts
  // with the composer's mode, and a capture listener outlives all of that.
  // A delete that is part of an IME composition is not cancelable and is left
  // to the keyboard.
  const deletePillFromInputEvent = useStableCallback((event: InputEvent) => {
    const ta = textareaRef.current
    if (!ta || event.target !== ta || !event.cancelable || event.isComposing) return
    const direction =
      event.inputType === "deleteContentBackward"
        ? "backward"
        : event.inputType === "deleteContentForward"
          ? "forward"
          : null
    if (!direction) return
    if (deletePillAtCaret(ta, direction)) event.preventDefault()
  })
  useEffect(() => {
    document.addEventListener("beforeinput", deletePillFromInputEvent, true)
    return () => document.removeEventListener("beforeinput", deletePillFromInputEvent, true)
  }, [deletePillFromInputEvent])
  return { stepToParam, deletePillAtCaret }
}
