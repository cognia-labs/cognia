/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { CONVERSATION_FILES_PANEL_ID } from "@/stores/filespace/filespace-panel-store"
import FilesDockPanel, { conversationFilesPanel } from "./files-dock-panel"

const mockPanel = jest.fn((_props: { sessionId: string | null }) => null)
jest.mock("./conversation-files-panel", () => ({
  ConversationFilesPanel: (props: { sessionId: string | null }) => mockPanel(props),
}))

const session = { kind: "session" as const, sessionId: "s1", capabilities: [] }

describe("FilesDockPanel", () => {
  it("registers the Files panel while mounted and takes it back on unmount", () => {
    expect(contextPanelRegistry.get(CONVERSATION_FILES_PANEL_ID)).toBeUndefined()
    const view = render(<FilesDockPanel />)
    expect(contextPanelRegistry.get(CONVERSATION_FILES_PANEL_ID)).toMatchObject({
      id: "conversation-files",
      activity: "workspace",
      labelKey: "filespace.panel.title",
      order: 28,
      scope: "session",
      retention: "stateful",
    })
    expect(contextPanelRegistry.resolve(session).map((panel) => panel.id)).toContain(
      CONVERSATION_FILES_PANEL_ID
    )
    view.unmount()
    expect(contextPanelRegistry.get(CONVERSATION_FILES_PANEL_ID)).toBeUndefined()
  })

  it("applies to a conversation only, and renders that conversation's files", () => {
    expect(conversationFilesPanel.appliesTo(session)).toBe(true)
    expect(
      conversationFilesPanel.appliesTo({
        kind: "canvas-document",
        documentId: "d1",
        capabilities: [],
      } as never)
    ).toBe(false)
    const Renderer = conversationFilesPanel.renderer
    render(<Renderer workbenchInstanceId="w" resource={session} active />)
    expect(mockPanel).toHaveBeenCalledWith({ sessionId: "s1" })
  })
})
