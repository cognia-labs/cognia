"use client"

/**
 * Dropdown affordance attached to the right of the search pill — VSCode's
 * command-center caret. The pill itself still opens the command palette on
 * click; this caret reveals quick targets (palette, recent sessions,
 * go-to-view) without disturbing the render-stable pill leaf.
 *
 * Not a bar segment of its own: the `search` segment draws the pill and this
 * caret as one group (`title-bar-zone.tsx`), so the caret can never be
 * reordered, hidden or folded away from the pill it is the right half of.
 *
 * Everything lives in ONE flat menu — no second-level submenus. Radix renders
 * a `DropdownMenuSubContent` as a NON-portaled `position: fixed` descendant of
 * the scrollable `DropdownMenuContent` (`overflow-y-auto`); on the Tauri
 * WebView that submenu was getting clipped / left unclickable, so the "Recent
 * Sessions" and "Go to View" fly-outs were effectively unusable. Inlining the
 * two groups keeps every target one hover away and reliably clickable, and the
 * per-item icons make the surface easier to scan.
 *
 * Receives data + handlers as props (owned by `TitleBar`) so it carries no
 * store subscriptions of its own.
 */

import { ChevronDownIcon, MessageSquareIcon, SearchIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MENU_CONTENT_PERF } from "@/components/shared/menu-kit"
import type { RecentSessionEntry } from "@/hooks/desktop/use-app-menu-controller"
import { useAppShortcutLabel } from "@/hooks/shortcuts/use-app-shortcut-label"
import { getGoMenuItem, type GoMenuItem } from "@/lib/desktop/go-menu"
import type { MenuActionId } from "@/lib/desktop/menu-actions"
import { cn } from "@/lib/utils"

// Curated "Go to View" targets — a subset of the Go menu surfaced inline. The
// label and icon of each come from the Go-menu table (`lib/desktop/go-menu.ts`),
// i.e. the rail's, so this list cannot drift from the Go menu's vocabulary.
const GO_TARGET_IDS = [
  "go-inbox",
  "go-workflows",
  "go-sites",
  "go-squads",
  "go-scheduler",
  "go-discover",
  "go-plugins",
  "go-settings",
] as const

const GO_TARGETS: readonly GoMenuItem[] = GO_TARGET_IDS.map(getGoMenuItem).filter(
  (item): item is GoMenuItem => item !== undefined
)

// Cap the inline recent list so the flat menu stays a sane height.
const MAX_RECENT = 6

export type { RecentSessionEntry }

export function TitleBarCommandCenterMenu({
  recentSessions,
  onCommandPalette,
  onOpenRecentSession,
  onGo,
  className,
  compact = false,
}: {
  recentSessions: RecentSessionEntry[]
  onCommandPalette: () => void
  onOpenRecentSession: (sessionId: string) => void
  onGo: (id: MenuActionId) => void
  className?: string
  /** Beside the icon-only pill: borderless, as tall as the icon button. */
  compact?: boolean
}) {
  const t = useTranslations("desktop.titleBar.commandCenter")
  const tMenu = useTranslations("desktop.menu")
  const tRail = useTranslations("desktop.guildRail")
  const recent = recentSessions.slice(0, MAX_RECENT)
  const paletteShortcut = useAppShortcutLabel("app.commandPalette.toggle")

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-testid="title-bar-command-center-menu"
          aria-label={t("menuLabel")}
          title={t("menuLabel")}
          className={cn(
            compact
              ? "h-7 w-4 shrink-0 rounded-sm"
              : "h-6 w-5 shrink-0 rounded-md rounded-l-none border border-l-0 border-border bg-background/60",
            "text-muted-foreground transition-colors hover:bg-background hover:text-foreground",
            "motion-safe:transition-transform motion-safe:active:scale-90",
            className
          )}
        >
          <ChevronDownIcon className="size-3 shrink-0" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={compact ? "end" : "center"}
        collisionPadding={8}
        className={cn("w-64 max-w-[calc(100vw-1rem)]", MENU_CONTENT_PERF)}
      >
        <DropdownMenuItem onSelect={onCommandPalette} data-testid="cc-command-palette">
          <SearchIcon aria-hidden />
          <span className="min-w-0 flex-1 truncate">{tMenu("view.commandPalette")}</span>
          {paletteShortcut.label ? (
            <DropdownMenuShortcut>{paletteShortcut.label}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t("recentSessions")}
        </DropdownMenuLabel>
        {recent.length === 0 ? (
          <DropdownMenuItem disabled data-testid="cc-recent-empty">
            {t("noRecent")}
          </DropdownMenuItem>
        ) : (
          recent.map((s) => (
            <DropdownMenuItem
              key={s.id}
              data-testid={`cc-recent-${s.id}`}
              onSelect={() => onOpenRecentSession(s.id)}
            >
              <MessageSquareIcon aria-hidden />
              <span className="min-w-0 flex-1 truncate">{s.title || t("untitled")}</span>
            </DropdownMenuItem>
          ))
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {t("goToView")}
        </DropdownMenuLabel>
        {GO_TARGETS.map(({ id, labelKey, Icon }) => (
          <DropdownMenuItem key={id} data-testid={`cc-go-${id}`} onSelect={() => onGo(id)}>
            <Icon aria-hidden />
            <span className="min-w-0 flex-1 truncate">{tRail(labelKey)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
