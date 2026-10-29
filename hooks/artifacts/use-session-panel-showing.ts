"use client"

/**
 * Whether a session-surface panel is on screen in the desktop dock right now:
 * the dock is open, the conversation's surface is showing (no artifact tab in
 * front of it), and the panel is the active or split one.
 *
 * Narrow screens never count: there the dock is a Sheet over the conversation,
 * so nothing beside the composer can lean on what the panel shows.
 */

import { useBreakpoint } from "@/hooks/ui/use-breakpoint"
import { dockSessionScopeKey } from "@/lib/artifacts/dock-pages"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { selectActiveArtifactId, useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

export function useSessionPanelShowing(
  sessionId: string | null | undefined,
  panelId: string
): boolean {
  const desktop = useBreakpoint() === "desktop"
  const dockOpen = useArtifactDockLayoutStore((s) => !s.dockCollapsed)
  const artifactInFront = useArtifactStore((s) =>
    sessionId ? Boolean(selectActiveArtifactId(s, sessionId)) : false
  )
  const panelActive = useContextWorkbenchStore((s) => {
    if (!sessionId) return false
    const layout = s.layouts[dockSessionScopeKey(sessionId)]
    return layout?.activePanelId === panelId || layout?.splitPanelId === panelId
  })
  return Boolean(sessionId) && desktop && dockOpen && !artifactInFront && panelActive
}
