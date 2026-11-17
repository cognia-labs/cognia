"use client"
import { FileTextIcon, XIcon } from "lucide-react"
import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { findPastePlaceholders } from "@/lib/paste-collapse"

/** Line count of a text block, without allocating the lines. */
export function countLines(text: string): number {
  let lines = 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++
  return lines
}

/**
 * Folded large-paste chips — only those whose placeholder is still in the
 * text (manual deletion drops the chip too).
 */
export function ComposerPastedChips({
  text,
  pastedBlocks,
  onRemove,
}: {
  text: string
  pastedBlocks: Record<string, string>
  onRemove: (placeholder: string) => void
}) {
  const t = useTranslations("chat.composer")
  // A folded paste is large by definition — that is why it folded — and its
  // chip only shows a line count. Counted once per paste, not by splitting
  // every body again on every keystroke.
  const pastedLineCounts = useMemo(
    () =>
      Object.entries(pastedBlocks).map(
        ([placeholder, body]) => [placeholder, countLines(body)] as const
      ),
    [pastedBlocks]
  )
  const chips = pastedLineCounts.filter(([ph]) => text.includes(ph))
  if (chips.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1 px-1 pb-1" data-testid="composer-pasted-chips">
      {chips.map(([ph, lineCount]) => (
        <span
          key={ph}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >
          <FileTextIcon className="size-3 shrink-0" aria-hidden />
          {t("pastedChip", { count: lineCount })}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onRemove(ph)}
            aria-label={t("removePastedChip")}
            className="-mr-1 size-4 rounded-sm text-muted-foreground/60 hover:bg-transparent hover:text-foreground"
          >
            <XIcon className="size-3" aria-hidden />
          </Button>
        </span>
      ))}
    </div>
  )
}

/**
 * Re-paste reminder: a restored draft can carry `[Pasted …]` placeholders
 * whose bodies weren't persisted. Nudge the user to re-paste (the placeholder
 * text stays visible so they see exactly where).
 */
export function ComposerPasteReminder({
  text,
  pastedBlocks,
}: {
  text: string
  pastedBlocks: Record<string, string>
}) {
  const t = useTranslations("chat.composer")
  const orphans = findPastePlaceholders(text).filter((ph) => !(ph in pastedBlocks))
  if (orphans.length === 0) return null
  return (
    <div className="px-1 pb-1 text-[11px] text-warning-ink" data-testid="composer-paste-reminder">
      {t("pasteReminder", { count: orphans.length })}
    </div>
  )
}
