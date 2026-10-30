"use client"

import { useEffect } from "react"

export type DocumentLiveState =
  "idle" | "preparing" | "needs-login" | "loading" | "ready" | "error" | "blocked"
export interface DocumentViewerBrowserProps {
  sessionId: string
  docTabId: string
  url: string
  providerId: string
  onState: (state: DocumentLiveState, detail?: { reason?: string }) => void
}

/** The isolated runtime is a later slice. Never borrow the agent's shared profile. */
export function DocumentViewerBrowser({ onState }: DocumentViewerBrowserProps) {
  useEffect(() => {
    onState("blocked", { reason: "isolation-unavailable" })
  }, [onState])
  return null
}
