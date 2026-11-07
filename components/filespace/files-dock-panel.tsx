"use client"

// The conversation's Files panel in the chat dock (ADR-0222, ADR-0214). The
// filespace module contributes it through its UI manifest's `effects`, by
// registering it with the context panel registry the dock already resolves,
// rather than the dock importing filespace: filespace depends on the
// artifact module the dock lives in, and module dependencies are acyclic
// (ADR-0250 §14, G6).

import { useEffect } from "react"
import { FolderOpenIcon } from "lucide-react"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import type { ContextPanelDefinition, ContextPanelRenderProps } from "@/types/context-workbench"
import { CONVERSATION_FILES_PANEL_ID } from "@/stores/filespace/filespace-panel-store"
import { ConversationFilesPanel } from "./conversation-files-panel"

function FilesPanelRenderer({ resource }: ContextPanelRenderProps) {
  const sessionId = resource.kind === "session" ? resource.sessionId : null
  // Keyed on the conversation, so switching conversations starts it afresh.
  return <ConversationFilesPanel key={sessionId ?? "none"} sessionId={sessionId} />
}

/**
 * Everything a conversation owns as files (its working directory, its other
 * roots, its uploads and its artifacts), with a link to each. The editor
 * beside it browses one root; this lists them.
 */
export const conversationFilesPanel: ContextPanelDefinition = {
  id: CONVERSATION_FILES_PANEL_ID,
  activity: "workspace",
  labelKey: "filespace.panel.title",
  icon: FolderOpenIcon,
  order: 28,
  appliesTo: (resource) => resource.kind === "session",
  retention: "stateful",
  scope: "session",
  renderer: FilesPanelRenderer,
}

/** Registers the Files panel while mounted, in every window. Renders nothing. */
export default function FilesDockPanel() {
  useEffect(() => contextPanelRegistry.register(conversationFilesPanel), [])
  return null
}
