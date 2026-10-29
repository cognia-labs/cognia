"use client"

/**
 * What a chat pane shows while it waits on history, so neither wait is silent.
 *
 * {@link PaneSwitchingIndicator} — opening a conversation for the first time
 * keeps the previous one on screen until the new one's row is read
 * (`useHeldPaneSession`). Without a sign of it, the click looked ignored: the
 * sidebar had moved and the transcript had not. A thin bar sweeps across the
 * top of the pane, and the held transcript dims (`data-pane-switching`, see
 * `ChatPane`), saying "this is the old one, the new one is coming".
 *
 * {@link HistoryWaitStrip} — a send made while a long conversation still shows
 * its tail preview waits for the full history (`lib/chat/history-preview.ts`).
 * The composer keeps the message and blocks a second send meanwhile; this strip,
 * docked on the composer like the run strip, says why nothing has gone out yet.
 *
 * Both are shown through `useDeferredLoading` by their hosts, so the usual
 * millisecond waits never flash them.
 */

import { Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"

export function PaneSwitchingIndicator() {
  const t = useTranslations("chat.history")
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden"
      data-testid="pane-switching-indicator"
    >
      <span role="status" className="sr-only">
        {t("opening")}
      </span>
      <div className="pending-progress-bar h-full w-1/3 rounded-full bg-primary/70" aria-hidden />
    </div>
  )
}

export function HistoryWaitStrip() {
  const t = useTranslations("chat.history")
  return (
    <div
      role="status"
      className="flex items-center gap-1.5 rounded-t-[var(--run-strip-radius,0.625rem)] border border-b-0 border-border/60 bg-muted/45 px-2.5 py-1 text-xs text-muted-foreground backdrop-blur-sm"
      data-testid="history-wait-strip"
    >
      <Loader2Icon className="size-3 shrink-0 animate-spin" aria-hidden />
      <span className="min-w-0 truncate">{t("sendWaiting")}</span>
    </div>
  )
}
