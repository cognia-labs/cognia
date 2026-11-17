"use client"

import { type ComposerTrigger } from "../../composer-trigger"
import { useShellIntelligence } from "@/hooks/chat/use-shell-intelligence"
import { type useTranslations } from "next-intl"
import { useMemo } from "react"

export interface ComposerShellModeInput {
  textValue: string
  caret: number
  cwd: string | null
  trigger: ComposerTrigger | null
  tShellUi: ReturnType<typeof useTranslations<"chat.composer.popover">>
}

/**
 * `!` mode shell intelligence over the composer line: completions, diagnostics
 * mapped onto the textarea, and the empty-panel message.
 */
export function useComposerShellMode(input: ComposerShellModeInput) {
  const { textValue, caret, cwd, trigger, tShellUi } = input

  // ── `!` mode shell intelligence ──────────────────────────────────────
  // The line is `value` minus the leading `!`, up to the first newline — the
  // exact span `detectTrigger` and the submit path already agree the mode owns.
  // Every offset below is therefore `textareaOffset - 1`, which is what lets
  // completion spans and diagnostic ranges map back with a single addition.
  const shellLine = useMemo(() => {
    if (trigger?.kind !== "bash") return null
    const value = textValue
    const newline = value.indexOf("\n")
    return value.slice(1, newline === -1 ? value.length : newline)
  }, [trigger?.kind, textValue])

  const shellMessages = useMemo(
    () => ({
      commandNotFound: (name: string) => tShellUi("shell.commandNotFound", { name }),
      incompleteSyntax: () => tShellUi("shell.incompleteSyntax"),
      shellUnavailable: (shellPath: string) =>
        tShellUi("shell.shellUnavailable", { shell: shellPath }),
      unsupportedShell: (shellPath: string) =>
        tShellUi("shell.unsupportedShell", { shell: shellPath }),
    }),
    [tShellUi]
  )

  const shell = useShellIntelligence({
    line: shellLine,
    cursor: shellLine === null ? 0 : Math.max(0, Math.min(caret - 1, shellLine.length)),
    cwd,
    messages: shellMessages,
  })

  // Pulled out so the key handler can depend on the callback rather than on the
  // whole (freshly built each render) intelligence object.
  const markShellSubmitted = shell.markSubmitted
  const dismissShell = shell.dismiss

  // Diagnostics are computed over the LINE; the textarea holds `!` + the line,
  // so every span shifts by one. Mapping here (rather than inside the overlay)
  // keeps the overlay a pure painter of ranges it is handed.
  const shellDiagnosticsForOverlay = useMemo(
    () => shell.diagnostics.map((d) => ({ ...d, from: d.from + 1, to: d.to + 1 })),
    [shell.diagnostics]
  )

  // "Nothing matched" and "this client cannot look" are different answers, and
  // an empty list looks identical for both. Without a Host the panel says so
  // and names the fix, instead of reading as a broken feature.
  //
  // With the master switch off there is a THIRD answer, and it is neither of
  // those: nothing was looked up. `terminal.autocomplete.enabled` ships false,
  // so reporting "No completions for “ls”" would be the default experience and
  // it would be a lie. An empty string tells the popover to render the hint
  // alone — `!` mode exactly as it was before this feature.
  const shellEmptyMessage = useMemo(() => {
    if (!shell.enabled) return ""
    if (shell.availability === "static-only") return tShellUi("shell.noHost")
    // `shell.query` is the TOKEN under the cursor, not the line: in
    // `cat foo | gre` the panel is completing `gre`, and naming the whole line
    // reads as "all of this is wrong" for a miss on one word.
    return tShellUi("shell.noMatches", { query: shell.query })
  }, [shell.enabled, shell.availability, shell.query, tShellUi])
  return {
    dismissShell,
    markShellSubmitted,
    shellDiagnosticsForOverlay,
    shell,
    shellEmptyMessage,
  }
}
