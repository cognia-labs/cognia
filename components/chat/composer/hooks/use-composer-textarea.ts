"use client"

import type React from "react"
import type { ComposerInnerProps } from "../../composer"
import { type UseInputHistory } from "./use-input-history"
import { type TextInputContext } from "@/components/ai-elements/prompt-input"
import { type LinkFolding } from "@/components/chat/composer/hooks/use-link-folding"
import { requestBrowserUrl } from "@/lib/browser/open-url-request"
import { type ParamSegment } from "@/lib/slash-commands/parse-segments"
import { type CommandError } from "@/lib/slash-commands/run-segments"
import { openExternal } from "@/lib/tauri/opener"
import { noteComposerTyping } from "@/stores/chat/composer-typing-store"
import { type ChangeEvent, useCallback, useEffect, useImperativeHandle } from "react"

// Max composer textarea height before it scrolls. Single source of truth so the
// CSS cap (`maxHeight`) and the JS auto-resize fallback can't drift apart. The
// px form assumes the app's default 16px root (the JS path only runs on old
// WebViews lacking `field-sizing`).
export const COMPOSER_MAX_HEIGHT_REM = 12
const COMPOSER_MAX_HEIGHT_PX = COMPOSER_MAX_HEIGHT_REM * 16

export interface ComposerTextareaInput {
  textValue: string
  textInput: TextInputContext
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  chipOverlayRef: React.RefObject<HTMLDivElement | null>
  ghostOverlayRef: React.RefObject<HTMLDivElement | null>
  setCaret: React.Dispatch<React.SetStateAction<number>>
  isComposing: boolean
  setCommandErrors: React.Dispatch<React.SetStateAction<CommandError[]>>
  linkFolding: LinkFolding
  setActiveParamId: React.Dispatch<React.SetStateAction<string | null>>
  activeParamId: string | null
  paramTokenAt: (caret: number) => ParamSegment | null
  history: UseInputHistory
  acceptedPredictionRef: React.RefObject<{ sessionId: string | null; text: string } | null>
  props: Pick<ComposerInnerProps, "handleRef" | "session">
}

/**
 * The textarea's own wiring: change, blur, select and pointer handlers, the
 * auto-resize fallback, and the imperative handle the desktop shell uses to
 * mention a teammate or focus the box.
 */
export function useComposerTextarea(input: ComposerTextareaInput) {
  const {
    textValue,
    textInput,
    textareaRef,
    chipOverlayRef,
    ghostOverlayRef,
    setCaret,
    isComposing,
    setCommandErrors,
    linkFolding,
    setActiveParamId,
    activeParamId,
    paramTokenAt,
    history,
    acceptedPredictionRef,
    props,
  } = input

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      acceptedPredictionRef.current = null
      textInput.setInput(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      // A team room's members wait for the human to finish a sentence before
      // an auto round (ADR-0177 batch 3). The runner polls this at round
      // boundaries, so a keystroke here is the whole signal.
      if (props.session?.kind === "team" && props.session.teamId) {
        noteComposerTyping(props.session.id)
      }
      // Re-mirror the scroll onto the chip + ghost overlays. Shrinking the text
      // (or clearing it) can reset the textarea's scrollTop WITHOUT firing a
      // scroll event, which would otherwise strand the overlays at a stale
      // translateY from the last scroll.
      const offset = `translateY(${-e.target.scrollTop}px)`
      if (chipOverlayRef.current) chipOverlayRef.current.style.transform = offset
      if (ghostOverlayRef.current) ghostOverlayRef.current.style.transform = offset
      // Typing exits history-recall mode so the next ↑ starts from the newest.
      history.noteEdit()
      // Last submit's per-command failures describe text the user has now
      // changed — drop them rather than leave stale red pills on the queue bar.
      setCommandErrors((current) => (current.length > 0 ? [] : current))
      // Fold any URL the caret has moved past. Never the one being typed — the
      // caret rule inside `foldLinks` sees to that — and never mid-composition,
      // where rewriting the value would drop the IME's in-flight text.
      if (!isComposing) {
        linkFolding.fold(e.target.value, e.target.selectionStart ?? e.target.value.length)
      }
    },
    [
      textInput,
      history,
      isComposing,
      linkFolding,
      props.session,
      acceptedPredictionRef,
      chipOverlayRef,
      ghostOverlayRef,
      setCaret,
      setCommandErrors,
    ]
  )

  // Leaving the box settles every remaining URL, including one just pasted with
  // the caret still sitting at its end.
  const onBlur = useCallback(() => {
    linkFolding.fold(textInput.value, -1)
  }, [linkFolding, textInput])

  const onSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const caretAt = ta.selectionStart ?? ta.value.length
      setCaret(caretAt)
      // Close the parameter editor once the caret leaves the token it belongs
      // to — including when the user breaks the token, which stops it being a
      // parameter at all. It never OPENS from here: `onSelect` also fires for
      // arrow keys, and a panel that appeared every time the caret drifted
      // through `{{module}}` would flash at someone reading back their own
      // sentence.
      if (activeParamId && paramTokenAt(caretAt)?.paramId !== activeParamId) {
        setActiveParamId(null)
      }
    },
    [activeParamId, paramTokenAt, setActiveParamId, setCaret]
  )

  /**
   * Open the editor for the parameter the user just clicked in.
   *
   * Pointer release, not `onSelect`: clicking a chip is a deliberate "edit
   * this", where arrowing past one is not.
   */
  const onTextareaMouseUp = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const caretAt = ta.selectionStart ?? 0
      if (caretAt !== (ta.selectionEnd ?? caretAt)) return // a drag-selection, not a click
      // ⌘/Ctrl-click follows a link, the way it does everywhere else. The
      // overlay that paints the label captures no pointer events, so the click
      // lands in the textarea and the caret tells us which token it hit.
      if (e.metaKey || e.ctrlKey) {
        const link = linkFolding.spans.find((span) => caretAt >= span.start && caretAt <= span.end)
        if (link) {
          e.preventDefault()
          // The embedded browser pane takes it when one is open; otherwise the
          // OS browser does, which is what every other link in the app does.
          if (!requestBrowserUrl(link.url)) void openExternal(link.url)
          return
        }
      }
      setActiveParamId(paramTokenAt(caretAt)?.paramId ?? null)
    },
    [setActiveParamId, paramTokenAt, linkFolding.spans]
  )

  // Auto-resize textarea (JS fallback for browsers without field-sizing:content
  // support, e.g. older iOS/Android WebViews). field-sizing-content in the
  // className is the progressive-enhancement path; this effect only runs when
  // the CSS property is absent.
  //
  // Crucially, it must NOT touch the textarea mid-composition: mutating
  // `style.height` forces a synchronous reflow that aborts the active IME
  // composition buffer on Android/iOS WebViews, so on-device typing (esp. CJK
  // / predictive keyboards) appears to "swallow" characters. We defer the
  // resize until composition ends, where this effect re-runs (isComposing flips
  // back to false) and adjusts the height once for the committed text.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return
    if (isComposing) return
    ta.style.height = "auto"
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`
  }, [textValue, isComposing, textareaRef])

  // Imperative handle: insert `@name ` at the caret. Used by the desktop
  // shell's member list to mention a teammate without going through any
  // intermediate draft store.
  useImperativeHandle(
    props.handleRef,
    () => ({
      insertMention: (name: string) => {
        const ta = textareaRef.current
        const cur = textInput.value
        const pos = ta?.selectionStart ?? cur.length
        const needsLeadSpace = pos > 0 && !/\s$/.test(cur.slice(0, pos))
        const insertion = `${needsLeadSpace ? " " : ""}@${name} `
        const next = cur.slice(0, pos) + insertion + cur.slice(pos)
        textInput.setInput(next)
        const caret = pos + insertion.length
        requestAnimationFrame(() => {
          const ta2 = textareaRef.current
          if (ta2) {
            ta2.setSelectionRange(caret, caret)
            ta2.focus()
          }
        })
        setCaret(caret)
      },
      focus: () => {
        textareaRef.current?.focus()
      },
    }),
    [textInput, setCaret, textareaRef]
  )
  return { onChange, onSelect, onTextareaMouseUp, onBlur }
}
