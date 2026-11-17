"use client"

import type { ComposerInnerProps } from "../composer"
import type React from "react"
import { type ComposerPopoverHandle } from "../composer-popover"
import { nextPermissionMode } from "../permission-mode-indicator"
import { type TextInputContext } from "@/components/ai-elements/prompt-input"
import { isImeComposing } from "@/lib/ui/ime"
import { type KeyboardEvent as ReactKeyboardEvent } from "react"

import type { ComposerTrigger } from "@/components/chat/composer-trigger"
import type { UseInputHistory } from "@/components/chat/composer/hooks/use-input-history"
import type { UseComposerGhostTextResult } from "@/hooks/chat/use-composer-ghost-text"
import type { UseFollowUpSuggestionsResult } from "@/hooks/chat/use-follow-up-suggestions"
import type { ParamSegment } from "@/lib/slash-commands/parse-segments"
import type { PermissionMode } from "@/stores/chat/chat-store"
import type { ChatStatus } from "ai"

/** What the composer's key handler reads from `ComposerInner`. */
export interface ComposerKeyDownContext {
  props: Pick<ComposerInnerProps, "onOpenCheatsheet" | "session">
  sendOnEnter: boolean
  inputHistoryRecall: boolean
  textInput: TextInputContext
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  activeHintRef: React.RefObject<string>
  popoverRef: React.RefObject<ComposerPopoverHandle | null>
  setCaret: React.Dispatch<React.SetStateAction<number>>
  isComposing: boolean
  setPermissionMode: (mode: PermissionMode | null, sessionId?: string | null | undefined) => void
  permissionMode: PermissionMode | null
  setActiveParamId: React.Dispatch<React.SetStateAction<string | null>>
  paramTokens: ParamSegment[]
  activeParamId: string | null
  history: UseInputHistory
  ghost: UseComposerGhostTextResult
  completionTrigger: ComposerTrigger | null
  markShellSubmitted: () => void
  dismissPopover: () => void
  submit: () => Promise<boolean>
  acceptGhost: () => boolean
  predictionEligible: boolean
  prediction: UseFollowUpSuggestionsResult
  acceptPrediction: (text: string, sendImmediately?: boolean) => boolean
  stepToParam: (direction: 1 | -1) => boolean
  deletePillAtCaret: (ta: HTMLTextAreaElement, direction: "backward" | "forward") => boolean
  turnStatus: ChatStatus
  onStopTurn: () => void | Promise<void>
}

export function handleComposerKeyDown(
  ctx: Pick<
    ComposerKeyDownContext,
    | "props"
    | "sendOnEnter"
    | "inputHistoryRecall"
    | "textInput"
    | "textareaRef"
    | "activeHintRef"
    | "popoverRef"
    | "setCaret"
    | "isComposing"
    | "setPermissionMode"
    | "permissionMode"
    | "setActiveParamId"
    | "paramTokens"
    | "activeParamId"
    | "history"
    | "ghost"
    | "completionTrigger"
    | "markShellSubmitted"
    | "dismissPopover"
    | "submit"
    | "acceptGhost"
    | "predictionEligible"
    | "prediction"
    | "acceptPrediction"
    | "stepToParam"
    | "deletePillAtCaret"
    | "turnStatus"
    | "onStopTurn"
  >,
  e: ReactKeyboardEvent<HTMLTextAreaElement>
) {
  const {
    props,
    sendOnEnter,
    inputHistoryRecall,
    textInput,
    textareaRef,
    activeHintRef,
    popoverRef,
    setCaret,
    isComposing,
    setPermissionMode,
    permissionMode,
    setActiveParamId,
    paramTokens,
    activeParamId,
    history,
    ghost,
    completionTrigger,
    markShellSubmitted,
    dismissPopover,
    submit,
    acceptGhost,
    predictionEligible,
    prediction,
    acceptPrediction,
    stepToParam,
    deletePillAtCaret,
    turnStatus,
    onStopTurn,
  } = ctx

  // While an IME composes (Chinese, Japanese, Korean), every key belongs to
  // the candidate window: Enter picks a candidate, Esc cancels it, arrows
  // move through it. Nothing below may claim one. WebKit (Safari, the Tauri
  // macOS webview) reports the confirming key after compositionend, so the
  // shared check also reads keyCode 229.
  if (isComposing || isImeComposing(e)) return
  // `?` opens the shortcut cheatsheet — but ONLY on a completely empty
  // input, so it never swallows a question mark the user is typing.
  if (e.key === "?" && textInput.value.length === 0) {
    e.preventDefault()
    props.onOpenCheatsheet()
    return
  }
  // Shift+Tab cycles permission mode regardless of popover state.
  if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault()
    const next = nextPermissionMode(permissionMode)
    setPermissionMode(next, props.session?.id ?? null)
    return
  }
  if (
    predictionEligible &&
    prediction.suggestions[0] &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey
  ) {
    if (e.key === "Tab" || e.key === "ArrowRight") {
      if (acceptPrediction(prediction.suggestions[0])) e.preventDefault()
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      prediction.dismiss()
      return
    }
  }
  // Tab on an empty box accepts the typewriter hint like a ghost
  // completion — the whole hint lands in the input, caret at the end.
  if (
    e.key === "Tab" &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    textInput.value === "" &&
    activeHintRef.current !== ""
  ) {
    e.preventDefault()
    const hint = activeHintRef.current
    textInput.setInput(hint)
    setCaret(hint.length)
    // A controlled textarea restores the pre-edit caret (position 0)
    // once React commits the new value — park it at the end instead.
    const el = e.currentTarget
    requestAnimationFrame(() => {
      if (document.activeElement === el) {
        el.selectionStart = el.selectionEnd = el.value.length
      }
    })
    return
  }
  if (completionTrigger) {
    if (e.key === "Escape") {
      e.preventDefault()
      dismissPopover()
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      popoverRef.current?.navigate(1)
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      popoverRef.current?.navigate(-1)
      return
    }
    // Tab selects the highlighted item — in `!` mode as well, now that it
    // has a list to confirm.
    //
    // `!` is the only kind whose panel can legitimately be EMPTY (no Host
    // to ask, or nothing matched), and there Tab has to fall through to the
    // textarea as it always did. Every other kind has a list by
    // construction, so Tab stays unconditionally theirs — letting a
    // mid-search empty frame leak a literal tab into the message would be a
    // regression in the pickers this feature never touched.
    if (e.key === "Tab" && !e.shiftKey) {
      const confirmed = popoverRef.current?.confirm()
      if (confirmed || completionTrigger.kind !== "bash") {
        e.preventDefault()
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Bash mode: Enter runs the line, whatever the panel is showing.
      // Diagnostics are advisory — an underline must never be the reason a
      // command the checker was wrong about cannot be run.
      if (completionTrigger.kind === "bash") {
        e.preventDefault()
        markShellSubmitted()
        void submit()
        return
      }
      // ⌥↵ takes a row its second way when it has one — a prompt the
      // user sent before goes back into the draft as text instead of
      // becoming a chip. Rows without one are picked as usual.
      if (popoverRef.current?.confirm({ alternate: e.altKey })) {
        e.preventDefault()
        return
      }
    }
  }
  // Atomic pill delete: a Backspace/Delete next to an already-inserted
  // `/command` or `@mention` removes the WHOLE token in one keystroke, so a
  // picked chip deletes as a unit instead of nibbling `/rese`. Only a plain
  // key (let ⌥/⌘ word/line deletes through). A soft keyboard reports these
  // keys as "Unidentified"; `beforeinput` below covers it.
  if (
    (e.key === "Backspace" || e.key === "Delete") &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    deletePillAtCaret(e.currentTarget, e.key === "Backspace" ? "backward" : "forward")
  ) {
    e.preventDefault()
    return
  }
  // Inline ghost-text acceptance (only when no `/@!#` popover is open).
  // Tab walks the `{{parameter}}` chips. Only claimed when the text
  // actually HAS parameters — otherwise Tab keeps its normal job of moving
  // focus out of the composer, which is the only way a keyboard user
  // reaches the toolbar.
  if (
    e.key === "Tab" &&
    !e.shiftKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey &&
    // No open panel — with one showing, Tab belongs to its list.
    !completionTrigger &&
    !ghost.ghost &&
    paramTokens.length > 0
  ) {
    if (stepToParam(1)) {
      e.preventDefault()
      return
    }
  }
  // Escape closes the parameter editor before anything else claims it.
  if (e.key === "Escape" && activeParamId) {
    e.preventDefault()
    setActiveParamId(null)
    return
  }
  // Alt+\ asks the agent tier for a continuation. Deliberately OUTSIDE the
  // `ghost.ghost` guard below: its whole purpose is to produce a suggestion
  // when the free tiers had nothing to offer, so requiring one first would
  // make the key unreachable exactly when it is wanted. `requestManual` is
  // a no-op when the tier is unavailable, so the keystroke still falls
  // through on a shell that cannot carry a turn.
  // `turnStatus === "streaming"` mirrors the ghost's own suppression: while
  // a turn runs, every `feed` resets the engine, so a manual answer would
  // appear and be wiped on the next keystroke.
  if (
    !completionTrigger &&
    e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    // `e.code`, not `e.key`: on macOS Option+\ produces `«`, and an IME may
    // swallow or translate the key — the physical key is the stable signal.
    e.code === "Backslash" &&
    ghost.manualAvailable &&
    turnStatus !== "streaming"
  ) {
    e.preventDefault()
    ghost.requestManual()
    return
  }
  // Tab accepts the dim continuation; Esc dismisses it; Alt+]/Alt+[ walk
  // the ranked alternatives (the same bindings VS Code uses for cycling
  // inline suggestions). All fall through to existing behavior when there
  // is no ghost to act on — except Esc, which also cancels a thinking or
  // failed round (the card is open and the user wants it gone).
  if (!completionTrigger && (ghost.ghost || ghost.querying || ghost.completionError)) {
    if (e.key === "Tab" && !e.shiftKey && ghost.ghost) {
      if (acceptGhost()) {
        e.preventDefault()
        return
      }
    }
    // `e.code` (physical key), not `e.key`: on macOS Option+] produces `‘`
    // and an IME may emit `】`, so the character never matches. `!ctrlKey`
    // keeps AltGr (Ctrl+Alt on Windows/Linux layouts) typing a real bracket.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const forward = e.code === "BracketRight" || e.key === "]"
      const backward = e.code === "BracketLeft" || e.key === "["
      // Only meaningful with something to cycle to; otherwise let the
      // keystroke through so it still types a bracket.
      if ((forward || backward) && ghost.candidates.length > 1) {
        e.preventDefault()
        if (forward) ghost.cycleNext()
        else ghost.cyclePrev()
        return
      }
    }
    if (e.key === "Escape") {
      e.preventDefault()
      ghost.dismiss()
      return
    }
  }
  // Esc interrupts the running turn — the keystroke behind the run-status
  // bar's "Esc to interrupt" affordance — once no popover/ghost claimed it.
  if (e.key === "Escape" && turnStatus === "streaming") {
    e.preventDefault()
    void onStopTurn()
    return
  }
  // ↑/↓ recall of previously sent messages (only when no popover is open).
  // ↑ engages from the very start of the input; while
  // navigating, both arrows walk the history and ↓ past the newest restores
  // the stashed draft.
  if (inputHistoryRecall && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const ta = e.currentTarget
    const caretAtStart = ta.selectionStart === 0 && ta.selectionEnd === 0
    const next = history.recall(e.key === "ArrowUp" ? "up" : "down", {
      value: textInput.value,
      caretAtStart,
    })
    if (next !== null) {
      e.preventDefault()
      textInput.setInput(next)
      setCaret(next.length)
      requestAnimationFrame(() => {
        const t = textareaRef.current
        if (t) {
          t.setSelectionRange(next.length, next.length)
          t.focus()
        }
      })
      return
    }
  }
  // Submit on Enter. Default: plain Enter sends, Shift+Enter is a newline.
  // When `sendOnEnter` is off: Enter inserts a newline and ⌘/Ctrl+Enter
  // sends instead (the non-submit cases fall through to the textarea).
  if (e.key === "Enter") {
    const wantsSubmit = sendOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey
    if (wantsSubmit) {
      e.preventDefault()
      void submit()
    }
  }
}
