"use client"

/**
 * The title bar's command-palette pill: the app name and what is in front (the
 * conversation on the chat home, the page's name elsewhere — `useBarTitle`),
 * a streaming dot while that conversation's turn is in flight, and the
 * palette's key hint.
 *
 * Chat headers already show the conversation title. Their compact variant
 * retains search and run indicators without repeating that title in a pill.
 *
 * It used to be a private component inside `title-bar.tsx`. It moved out when
 * the bar became customizable — `title-bar-zone.tsx` mounts segments by id, so
 * every segment has to be importable.
 *
 * The chat-store status (which changes per token during streaming) and the
 * title's live query stay scoped to this leaf rather than
 * sitting on `TitleBar`: on the bar itself they forced the whole menubar tree
 * to re-render whenever the active chat changed.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { SearchIcon } from "lucide-react"

import { useBarTitle } from "@/hooks/desktop/use-bar-title"
import { useAppShortcutLabel } from "@/hooks/shortcuts/use-app-shortcut-label"
import { aggregateRunState } from "@/lib/chat/aggregate-run-state"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"

export function TitleBarSearchPill({
  appName,
  separator,
  placeholder,
  onClick,
  className,
  compact = false,
}: {
  appName: string
  separator: string
  placeholder: string
  onClick: () => void
  className?: string
  compact?: boolean
}) {
  // The other strings arrive as props so the bar can keep this leaf render
  // stable; this one is local because only the leaf knows the count.
  const t = useTranslations("desktop.statusBar")
  const sessions = useChatStore((s) => s.sessions)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const run = useMemo(
    () => aggregateRunState({ sessions, activeSessionId }),
    [sessions, activeSessionId]
  )
  const { title: subject, label: doc } = useBarTitle()
  const title = doc ? `${appName}${separator}${doc}` : appName
  // The dot belongs to the conversation this pill NAMES, so it stays focused.
  // What was missing is the other half: with the named conversation idle and
  // two more streaming, the pill was the shell's most prominent "nothing is
  // happening" claim. The count says otherwise without stealing the dot.
  //
  // On another page the pill names that page, so no conversation owns the
  // dot: every turn in flight is "elsewhere", the focused one included. The
  // compact pill always sits beside the chat header that names the focused
  // conversation, so it keeps the dot.
  const namesConversation = compact || subject.kind === "conversation"
  const isStreaming = namesConversation && run.focused === "streaming"
  const showCount = namesConversation ? run.activeElsewhere : run.active > 0
  const backgroundHint = t("runningCount", { count: run.active })
  // The palette's effective chord — the user's rebinding, in this platform's
  // glyphs. A fixed "Ctrl+K" string printed Ctrl on a Mac.
  const { label: kbdHint, aria: kbdAria } = useAppShortcutLabel("app.commandPalette.toggle")

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="title-bar-search-pill"
      data-compact={compact || undefined}
      aria-label={placeholder}
      aria-keyshortcuts={kbdAria}
      title={compact ? (kbdHint ? `${placeholder} (${kbdHint})` : placeholder) : undefined}
      className={cn(
        "group flex items-center gap-2 rounded-md text-xs",
        compact
          ? "h-7 min-w-7 shrink-0 justify-center px-1.5"
          : "h-6 min-w-[180px] max-w-[480px] flex-1 border border-border bg-background/60 px-2",
        "text-muted-foreground transition-colors hover:bg-background hover:text-foreground",
        className
      )}
    >
      {isStreaming ? (
        <span
          aria-hidden
          data-testid="title-bar-streaming-dot"
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
        />
      ) : (
        <SearchIcon aria-hidden className="size-3 shrink-0" />
      )}
      {!compact && (
        <span className="truncate font-medium tracking-tight" data-testid="title-bar-title">
          {title}
        </span>
      )}
      {showCount ? (
        <span
          data-testid="title-bar-background-count"
          title={backgroundHint}
          aria-label={backgroundHint}
          className="ml-auto shrink-0 rounded-sm bg-primary/15 px-1 text-[10px] font-medium tabular-nums text-primary"
        >
          {run.active}
        </span>
      ) : null}
      {!compact && kbdHint && (
        <span
          aria-hidden
          className={cn("hidden text-[10px] opacity-60 sm:inline", !showCount && "ml-auto")}
        >
          {kbdHint}
        </span>
      )}
    </button>
  )
}
