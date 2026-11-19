"use client"

/**
 * The expanded sidebar's workspace shortcuts: pinned workspaces, then the few
 * used last, one click each.
 *
 * The expanded sidebar always groups by team (`channel-list.tsx`), and the
 * only way to another workspace was the switcher in its header: open it, find
 * the row, pick it. Pinned and recent workspaces sat one popover away from a
 * sidebar that is otherwise one click per destination (sidebar audit item 9).
 * This block puts them at the top of the sidebar's scroll, above the
 * navigation rows.
 *
 * Which workspaces appear is `lib/workspace/quick-access.ts`, the same rule
 * the switcher's Pinned / Recent groups read, so the two never disagree. The
 * active workspace is not listed: the sidebar is already headed by it. A row
 * switches exactly as the switcher does (`setActiveProject`); its context
 * menu pins or unpins it and opens it in the workspace manager. With nothing
 * to switch to, the block draws nothing.
 */

import { useId, useMemo } from "react"
import { useTranslations } from "next-intl"
import { FolderIcon, SettingsIcon, StarIcon, StarOffIcon } from "lucide-react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { workspaceShortcuts } from "@/lib/workspace/quick-access"
import { requestWorkspaceDialog } from "@/lib/workspace/workspace-dialog-request"
import { useProjectStore } from "@/stores/project/project-store"
import { SidebarRow } from "./sidebar-nav-section"

export function SidebarWorkspaceShortcuts({ className }: { className?: string }) {
  const t = useTranslations("workspace.switcher")
  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const updateProject = useProjectStore((s) => s.updateProject)
  const headingId = useId()
  const rows = useMemo(() => {
    const { pinned, recent } = workspaceShortcuts(projects, activeProjectId ?? null)
    return [
      ...pinned.map((workspace) => ({ workspace, pinned: true })),
      ...recent.map((workspace) => ({ workspace, pinned: false })),
    ]
  }, [projects, activeProjectId])

  if (rows.length === 0) return null
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-testid="sidebar-workspace-shortcuts"
      className={cn("flex shrink-0 flex-col gap-px px-2 py-1", className)}
    >
      <div
        id={headingId}
        className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-muted-foreground/80"
      >
        {t("heading")}
      </div>
      {rows.map(({ workspace, pinned }) => {
        const name = workspace.name
        const testId = `sidebar-workspace-${workspace.id}`
        return (
          <ContextMenu key={workspace.id}>
            <ContextMenuTrigger asChild>
              <SidebarRow
                // A workspace row switches context; it is not a destination
                // the travelling highlight should move to, and the active
                // workspace is never one of these rows anyway.
                highlight={false}
                current={false}
                onClick={() => setActiveProject(workspace.id)}
                title={t("sidebar.switchTo", { name })}
                icon={<FolderIcon aria-hidden />}
                label={name}
                trailing={
                  pinned ? (
                    <StarIcon
                      aria-label={t("pinnedHeading")}
                      className="size-3 fill-current text-amber-500/80"
                      data-testid={`${testId}-pinned`}
                    />
                  ) : undefined
                }
                testId={testId}
              />
            </ContextMenuTrigger>
            <ContextMenuContent data-testid={`${testId}-menu`}>
              <ContextMenuItem
                onSelect={() => updateProject(workspace.id, { pinned: !pinned })}
                data-testid={`${testId}-toggle-pin`}
              >
                {pinned ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
                {pinned ? t("unpin", { name }) : t("pin", { name })}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => requestWorkspaceDialog("manage", { workspaceId: workspace.id })}
                data-testid={`${testId}-manage`}
              >
                <SettingsIcon aria-hidden />
                {t("sidebar.manage")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </div>
  )
}
