"use client"

import type { ComposerInnerProps } from "../../composer"
import { type ComposerTrigger } from "../../composer-trigger"
import { type UseComposerGhostTextResult } from "@/hooks/chat/use-composer-ghost-text"
import { useEffect } from "react"

export interface ComposerGhostFeedInput {
  textValue: string
  caret: number
  ghost: UseComposerGhostTextResult
  trigger: ComposerTrigger | null
  isStreaming: boolean
  props: Pick<ComposerInnerProps, "disabled">
}

/**
 * Drives the inline ghost-text engine off the current draft. Suppressed while a
 * `/@!#` trigger popover is open, the caret isn't at the end of the text, or a
 * turn is streaming / the composer is disabled — the controller debounces and
 * only the most recent feed is queried, so this always reflects state.
 */
export function useComposerGhostFeed(input: ComposerGhostFeedInput) {
  const { textValue, caret, ghost, trigger, isStreaming, props } = input

  const ghostFeed = ghost.feed
  useEffect(() => {
    const value = textValue
    const suppress = !!trigger || isStreaming || !!props.disabled || caret !== value.length
    ghostFeed(value, { suppress })
  }, [textValue, caret, trigger, isStreaming, props.disabled, ghostFeed])
}
