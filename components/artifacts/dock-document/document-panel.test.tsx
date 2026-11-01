/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { DockDocumentPanel } from "./document-panel"
import { useDockDocumentsStore, type DockDocumentTab } from "@/stores/artifact/dock-documents-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { dockSessionScopeKey } from "@/lib/artifacts/dock-pages"
import { useKeptCopySource } from "@/hooks/chat/use-remote-doc-kept-copy-source"
jest.mock("@/hooks/chat/use-remote-doc-kept-copy-source", () => ({
  useKeptCopySource: jest.fn(() => ({ status: "unknown", canReopen: true })),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("./document-snapshot-view", () => ({
  DocumentSnapshotView: ({ tab }: { tab: { title: string } }) => <article>{tab.title}</article>,
}))
jest.mock("./document-live-view", () => ({
  DocumentLiveView: ({ tab }: { tab: { title: string } }) => <article>live {tab.title}</article>,
}))
jest.mock("@/lib/docs-providers", () => ({ getDocsProvider: jest.fn() }))
const tab: DockDocumentTab = {
  id: "d",
  providerId: "lark",
  resourceKind: "doc",
  resourceId: "abcdefghijklmnop1234",
  url: "",
  title: "Report",
  view: "snapshot",
  openedAt: 1,
}
beforeEach(() => {
  useDockDocumentsStore.setState({ bySession: {} })
  jest.mocked(useKeptCopySource).mockReturnValue({ status: "unknown", canReopen: true })
})
it.each(["source-disconnected", "source-deleted", "not-on-this-device"] as const)(
  "returns a blocked live tab to its kept snapshot (%s)",
  (status) => {
    jest.mocked(useKeptCopySource).mockReturnValue({ status, canReopen: false })
    useDockDocumentsStore.getState().put("s", { ...tab, view: "live" })
    render(<DockDocumentPanel sessionId="s" />)
    expect(screen.getByRole("button", { name: "views.live" })).toBeDisabled()
    expect(screen.getByRole("article")).toHaveTextContent("Report")
    expect(screen.getByRole("article")).not.toHaveTextContent("live")
  }
)
it("renders the active document and switches its internal view", () => {
  useDockDocumentsStore.getState().put("s", tab)
  render(<DockDocumentPanel sessionId="s" />)
  expect(screen.getByRole("article")).toHaveTextContent("Report")
  fireEvent.click(screen.getByRole("button", { name: "views.live" }))
  expect(screen.getByRole("article")).toHaveTextContent("live Report")
  act(() => useDockDocumentsStore.getState().put("s", { ...tab, id: "other", title: "Other" }))
  expect(screen.getByRole("article")).toHaveTextContent("Other")
})
it("renders nothing without an active document and closes the orphaned panel", () => {
  const scope = dockSessionScopeKey("s")
  useContextWorkbenchStore.getState().navigatePanel(scope, "cloud-document", "wide")
  expect(useContextWorkbenchStore.getState().layouts[scope].activePanelId).toBe("cloud-document")
  const { container } = render(<DockDocumentPanel sessionId="s" />)
  expect(container).toBeEmptyDOMElement()
  expect(useContextWorkbenchStore.getState().layouts[scope]?.activePanelId).not.toBe(
    "cloud-document"
  )
})
