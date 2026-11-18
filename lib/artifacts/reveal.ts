import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"
import type { Artifact, CanvasDocument } from "@/types"
import type { ContextPanelMode } from "@/types/context-workbench"

export function revealArtifactInWorkspace(id: string): Artifact | null {
  const store = useArtifactStore.getState()
  const artifact = store.artifacts[id]

  if (!artifact) {
    return null
  }

  store.setActiveArtifact(id)
  // Puts the surface on screen: the desktop dock and the narrow Sheet alike.
  store.openPanel()
  // The artifact surface opens on its preview; ask for it explicitly so a dock
  // parked on (say) the workspace panel follows the artifact you just revealed.
  useArtifactDockLayoutStore.getState().requestReveal({ panelId: "preview", mode: "narrow" })
  return artifact
}

/**
 * Bring one of the dock's *session-surface* panels (Plan, Sources, Memory, …)
 * forward for `sessionId`.
 *
 * Those panel ids belong to the session surface only, which the dock shows
 * when no artifact is active, so the conversation is focused and its active
 * artifact dropped before the reveal intent is published. `setDockCollapsed`
 * puts the dock on screen on both form factors (desktop dock and the mobile
 * Sheet move together).
 */
export function revealSessionPanel(
  sessionId: string,
  panelId: string,
  mode: ContextPanelMode = "wide"
): void {
  const chat = useChatStore.getState()
  if (chat.activeSessionId !== sessionId) chat.setActiveSession(sessionId)
  useArtifactStore.getState().setActiveArtifact(null, sessionId)
  const dock = useArtifactDockLayoutStore.getState()
  dock.requestReveal({ panelId, mode })
  dock.setDockCollapsed(false)
}

/**
 * The canvas twin of {@link revealArtifactInWorkspace}.
 *
 * There is deliberately no route to push. The editable canvas surface is
 * `CanvasShell`, which `desktop-chat-workspace.tsx` mounts when the shell's
 * selected guild is `{ kind: "canvas" }` — the app is a static export with no
 * dynamic segments at all, so the `/canvas/<id>` this used to link to never
 * existed and always 404'd. `app/canvas/join/page.tsx` already reveals a shared
 * document exactly this way (store write + guild switch); this is that path,
 * named, so chat cards and the agent's `canvas_open` tool share one seam.
 *
 * Callers that are not already on `/` must route there themselves — `lib/` has
 * no router. `components/shell/use-shell-nav.ts:goHome` is the shape to copy.
 *
 * The artifact store's `openPanel` is *not* called: it puts the artifact dock
 * on screen, which has nothing to do with the Canvas surface.
 */
export function revealCanvasDocument(id: string): CanvasDocument | null {
  const store = useArtifactStore.getState()
  // Workspace-scoped: revealing a document the active workspace does not own
  // would switch the guild to a canvas whose rail cannot list it.
  const document = store.getCanvasDocumentForWorkspace(id)

  if (!document) {
    return null
  }

  store.setActiveCanvas(id)
  useUIStore.getState().setSelectedGuild({ kind: "canvas" })
  return document
}
