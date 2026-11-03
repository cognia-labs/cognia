"use client"

/**
 * A2UI Workspace Header
 *
 * Built on the app-wide `FeaturePageHeader` (same chrome as /servers, /sites,
 * /plugins …) so the editor stops looking like its own product. It used to be
 * one hand-rolled bar stacked on top of `A2UIToolbar`, with the edit/preview/
 * data switch rendered *twice* — as tabs here and as three toggle buttons
 * there. The header's typed `tabs` are now the single mode control, and the
 * toolbar is passed in as `controls` so it renders in this header's view bar
 * instead of a competing bar. The way back to the gallery is the header's
 * `back` button.
 *
 * `controls` is a prop rather than an import so the header stays renderable on
 * its own (the toolbar pulls in the A2UI store, the app builder and tooltips).
 */

import React from "react"
import { useTranslations } from "next-intl"
import { Pencil, Eye, Database } from "lucide-react"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { useMediaQuery } from "@/hooks/ui/use-media-query"
import { useA2UIStore } from "@/stores/a2ui"
import { useWorkspaceContext, type WorkspaceMode } from "./a2ui-workspace-context"

/** Below Tailwind's `sm`, where the workspace switches to its mobile layout. */
const MOBILE_LAYOUT_QUERY = "(max-width: 639.98px)"

const WORKSPACE_MODES: readonly WorkspaceMode[] = ["edit", "preview", "data"]

function isWorkspaceMode(value: string): value is WorkspaceMode {
  return (WORKSPACE_MODES as readonly string[]).includes(value)
}

export interface WorkspaceHeaderProps {
  /** Rendered as the header's secondary band. See the note above. */
  controls?: React.ReactNode
}

export function WorkspaceHeader({ controls }: WorkspaceHeaderProps) {
  const t = useTranslations("a2ui")
  const { surfaceId, workspaceMode, setWorkspaceMode } = useWorkspaceContext()
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  // Mode tabs drive the desktop three-panel layout. On mobile the bottom
  // tab-bar is the single navigator, so these are left out to avoid a no-op
  // control that would just confuse touch users.
  const mobileLayout = useMediaQuery(MOBILE_LAYOUT_QUERY)

  const title = surface?.title || surfaceId.slice(0, 12)
  const isReady = surface?.ready

  return (
    <FeaturePageHeader
      testId="a2ui-workspace-header"
      back={{ label: t("back"), href: "/a2ui", testId: "a2ui-workspace-back" }}
      title={title}
      description={t("workspace.headerDescription")}
      // Only surfaced while the surface is still hydrating. A permanent "all
      // good" chip is chrome that never tells the user anything.
      status={
        isReady
          ? undefined
          : { label: t("workspace.headerLoading"), tone: "active", testId: "a2ui-header-loading" }
      }
      tabs={
        mobileLayout
          ? undefined
          : {
              items: [
                { value: "edit", label: t("editMode"), icon: Pencil },
                { value: "preview", label: t("previewMode"), icon: Eye },
                { value: "data", label: t("dataMode"), icon: Database },
              ],
              value: workspaceMode,
              onValueChange: (value) => {
                if (isWorkspaceMode(value)) setWorkspaceMode(value)
              },
              ariaLabel: t("workspace.modeTabsAria"),
            }
      }
      controls={controls}
    />
  )
}
