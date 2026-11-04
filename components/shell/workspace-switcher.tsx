"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, FolderIcon, LayersIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useProjectStore } from "@/stores/project/project-store"
import {
  useWorkspacePickerRequests,
  WorkspacePickerList,
} from "@/components/workspace/workspace-picker-list"
import { useOverlaySide } from "./rail-overlay-side"
import { useSidebarRowRoving } from "./sidebar-row-roving"
import { NavigationIcon } from "./navigation-icon"

/**
 * Rail entry point for the active workspace. The trigger shows the active
 * workspace's initial, or a folder icon when none is active. The list and its
 * dialogs live in `components/workspace/workspace-picker-list.tsx` so the
 * mobile header chip opens exactly the same thing in a Drawer.
 *
 * Switching drives `setActiveProject`, which re-binds the Git panel and
 * terminal scope and feeds the cwd chain.
 *
 * On the rail the trigger is one of the column's buttons, so it takes its
 * place in the rail's roving order (`sidebar-row-roving.tsx`): no tab stop of
 * its own, reached with the arrow keys like its neighbours. The wide trigger
 * sits in the title bar, outside any roving scope, and keeps its tab stop, as
 * does the composer trigger.
 */
interface WorkspaceSwitcherProps {
  /**
   * `rail` (the default) is the square initial in the icon column, with a
   * tooltip for the name and a popover opening inward — rightward from a left
   * rail, leftward from a right one (`OverlaySideContext`, provided by the
   * rail). `wide` is a text
   * trigger for the title bar's start zone above the expanded sidebar:
   * folder, name, chevron, with the popover opening downward under it. Same
   * list, same actions.
   *
   * `composer` is the first token of the welcome composer's context bar
   * ("workspace › folder · worktree"): a borderless chip sized like the
   * strip's other tokens, so on the web — where the rail trigger is only an
   * initial — the workspace a new chat lands in is named where it is typed.
   * It is a second door onto the same store, never a copy of it.
   */
  variant?: "rail" | "wide" | "composer"
  className?: string
}

export function WorkspaceSwitcher({ variant = "rail", className }: WorkspaceSwitcherProps = {}) {
  const t = useTranslations("workspace.switcher")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const [open, setOpen] = useState(false)
  // Requests to the shell's one dialog host, not dialogs of its own: there
  // are up to three switchers on the desktop shell at once.
  const actions = useWorkspacePickerRequests()

  const active = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId]
  )

  const triggerLabel = active ? t("active", { name: active.name }) : t("none")
  const initial = active?.name.trim().charAt(0).toUpperCase()
  const wide = variant === "wide"
  const composer = variant === "composer"
  const overlaySide = useOverlaySide()
  // Never the selected destination, so it holds the tab stop only when the
  // scope hands it one (nothing else claimed it, or the user arrowed here).
  const roving = useSidebarRowRoving(variant === "rail" ? "workspace-switcher" : undefined, false)

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {composer ? (
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={triggerLabel}
              title={active?.name ?? t("none")}
              data-testid="workspace-switcher"
              data-variant="composer"
              className={cn(
                "group inline-flex h-7 max-w-[11rem] min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none data-[state=open]:bg-muted/70 data-[state=open]:text-foreground",
                className
              )}
            >
              {/* A plain glyph like the strip's other tokens (folder, branch),
                  and a different one from the folder token right after it. */}
              <LayersIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate font-medium">{active?.name ?? t("none")}</span>
              <ChevronDownIcon
                aria-hidden
                className="size-3 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              />
            </button>
          </PopoverTrigger>
        ) : wide ? (
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={triggerLabel}
              title={active?.name ?? t("none")}
              data-testid="workspace-switcher"
              data-variant="wide"
              className={cn(
                "group h-7 max-w-[min(14rem,100%)] min-w-0 justify-start gap-1.5 rounded-md border border-border/50 bg-background/30 px-1.5 text-muted-foreground shadow-xs transition-colors hover:border-border hover:bg-accent/70 hover:text-foreground data-[state=open]:border-border data-[state=open]:bg-accent data-[state=open]:text-foreground",
                className
              )}
            >
              <span
                aria-hidden
                className="flex size-5 shrink-0 items-center justify-center rounded bg-foreground/5 text-muted-foreground group-data-[state=open]:text-foreground"
              >
                <NavigationIcon
                  id="workspace"
                  fallback={FolderIcon}
                  size={20}
                  className="size-3.5"
                />
              </span>
              <span className="min-w-0 truncate text-xs font-medium">
                {active?.name ?? t("none")}
              </span>
              <ChevronDownIcon
                aria-hidden
                className="ml-auto size-3 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              />
            </Button>
          </PopoverTrigger>
        ) : (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  {...roving.rowProps}
                  tabIndex={roving.tabIndex}
                  onKeyDown={roving.onKeyDown}
                  onFocus={roving.onFocus}
                  aria-label={triggerLabel}
                  data-testid="workspace-switcher"
                  className={cn(
                    "size-10 rounded-2xl text-muted-foreground transition-all hover:rounded-xl hover:text-foreground",
                    className
                  )}
                >
                  <NavigationIcon
                    id="workspace"
                    fallback={
                      initial ? (
                        <span className="text-sm font-semibold">{initial}</span>
                      ) : (
                        <FolderIcon className="size-5" />
                      )
                    }
                  />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side={overlaySide}>{triggerLabel}</TooltipContent>
          </Tooltip>
        )}

        <PopoverContent
          side={variant === "rail" ? overlaySide : "bottom"}
          align="start"
          sideOffset={variant === "rail" ? 4 : wide ? 8 : 6}
          collisionPadding={8}
          aria-label={t("switchTitle")}
          className={cn(
            "flex max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border-border/70 p-1.5 shadow-lg",
            variant === "rail" ? "w-72" : "w-80"
          )}
        >
          <WorkspacePickerList
            actions={actions}
            onSwitched={() => setOpen(false)}
            className="min-h-0 flex-1"
          />
        </PopoverContent>
      </Popover>
    </>
  )
}

export default WorkspaceSwitcher
