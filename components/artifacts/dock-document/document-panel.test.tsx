/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { DockDocumentPanel } from "./document-panel"
import { useDockDocumentsStore, type DockDocumentTab } from "@/stores/artifact/dock-documents-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { dockSessionScopeKey } from "@/lib/artifacts/dock-pages"
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
beforeEach(() => useDockDocumentsStore.setState({ bySession: {} }))
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
