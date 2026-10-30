"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { DOCK_DOCUMENT_PANEL_ID, setDockDocumentView } from "@/lib/artifacts/dock-documents"
import { dockSessionScopeKey } from "@/lib/artifacts/dock-pages"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import {
  selectActiveDockDocument,
  useDockDocumentsStore,
} from "@/stores/artifact/dock-documents-store"
import { DocumentLiveView } from "./document-live-view"
import { DocumentSnapshotView } from "./document-snapshot-view"

export function DockDocumentPanel({ sessionId }: { sessionId: string | null }) {
  const t = useTranslations("cloudDocPreview")
  const tab = useDockDocumentsStore((state) => selectActiveDockDocument(state, sessionId))
  const orphaned = !!sessionId && !tab
  // A restored workbench can still point at this panel after its ephemeral
  // document tabs were dropped on reload; close it so the dock falls back to
  // the session's other tabs instead of a blank pane with no tab selected.
  useEffect(() => {
    if (!orphaned || !sessionId) return
    useContextWorkbenchStore
      .getState()
      .closePanelTab(dockSessionScopeKey(sessionId), DOCK_DOCUMENT_PANEL_ID)
  }, [orphaned, sessionId])
  if (!sessionId || !tab) return null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b p-2" role="group" aria-label={t("views.label")}>
        {(["snapshot", "live"] as const).map((view) => (
          <Button
            key={view}
            size="sm"
            variant={tab.view === view ? "secondary" : "ghost"}
            aria-pressed={tab.view === view}
            onClick={() => setDockDocumentView(sessionId, tab.id, view)}
          >
            {t(`views.${view}`)}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab.view === "snapshot" ? (
          <DocumentSnapshotView key={tab.id} sessionId={sessionId} tab={tab} />
        ) : (
          <DocumentLiveView key={tab.id} sessionId={sessionId} tab={tab} />
        )}
      </div>
    </div>
  )
}
