"use client"

/**
 * Registers the rebindable `artifacts.toggleDock` shortcut (default Cmd/Ctrl+J)
 * for the docked artifacts panel. The single dispatcher owns the listener plus
 * the editable / Monaco guards; the descriptor's `when: "!view.canvas"` keeps it
 * from contending with the Canvas right-rail (which also defaults to Cmd+J).
 */

import { useBreakpoint } from "@/hooks/ui"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"

export function useArtifactDockShortcuts(): void {
  const breakpoint = useBreakpoint()
  const toggleDock = useArtifactDockLayoutStore((s) => s.toggleDock)
  const toggleSheet = useArtifactDockLayoutStore((s) => s.toggleSheet)

  useAppShortcut(
    "artifacts.toggleDock",
    () => {
      // One Sheet on narrow screens, so one toggle, keyed on the Sheet itself.
      // This branch used to flip the artifact store's `panelOpen`, a flag the
      // Sheet does not read, so on a tablet the shortcut handled the key and
      // the drawer stayed shut.
      if (breakpoint === "desktop") toggleDock()
      else toggleSheet()
    },
    { preventDefault: true, editorSelectors: [".monaco-editor"] }
  )
}

export default useArtifactDockShortcuts
