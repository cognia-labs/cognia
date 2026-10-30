/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import { DocumentSnapshotView } from "./document-snapshot-view"
import { useDocumentSnapshot } from "./use-document-snapshot"
import type { DockDocumentTab } from "@/stores/artifact/dock-documents-store"
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: () => "time" }),
}))
jest.mock("./use-document-snapshot", () => ({ useDocumentSnapshot: jest.fn() }))
jest.mock("@/components/chat/message-parts/file-part-preview", () => ({
  FilePartPreview: ({
    filename,
    presentation,
    hideDownloadFallback,
  }: {
    filename: string
    presentation: string
    hideDownloadFallback: boolean
  }) => (
    <div
      role="document"
      aria-label={filename}
      data-presentation={presentation}
      data-hide-download={String(hideDownloadFallback)}
    />
  ),
}))
jest.mock("./document-grid-view", () => ({
  DocumentGridView: ({ text }: { text: string }) => <div role="table">{text}</div>,
}))
jest.mock("@/components/docs-providers/docs-provider-notice", () => ({
  DocsProviderNotice: () => null,
}))
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
  URL.createObjectURL = jest.fn(() => "blob:snapshot")
  URL.revokeObjectURL = jest.fn()
  ;(useDocumentSnapshot as jest.Mock).mockReturnValue({
    state: "ready",
    reach: { available: true },
    refresh: jest.fn(),
    content: {
      title: "Report",
      text: "# Hello",
      format: "markdown",
      fetchedAt: 1,
      origin: "sent",
      completeness: { status: "complete" },
    },
  })
})
it("uses the existing document attachment renderer and revokes body URLs", async () => {
  const { unmount } = render(<DocumentSnapshotView sessionId="s" tab={tab} />)
  await act(async () => {})
  expect(screen.getByRole("document", { name: "Report.md" })).toHaveAttribute(
    "data-presentation",
    "document"
  )
  expect(screen.getByRole("document")).toHaveAttribute("data-hide-download", "true")
  expect(screen.getByText("sentAt")).toBeInTheDocument()
  unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:snapshot")
})
it("shows explicit named account choices without silently selecting one", () => {
  const refresh = jest.fn()
  ;(useDocumentSnapshot as jest.Mock).mockReturnValue({
    state: "idle",
    reach: { available: true },
    refresh,
    accounts: [{ id: "a", label: "Alice", authorizationEpoch: "e" }],
  })
  render(<DocumentSnapshotView sessionId="s" tab={tab} />)
  expect(refresh).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Alice" }))
  expect(refresh).toHaveBeenCalledWith({ accountId: "a", authorizationEpoch: "e" })
})
it("disables refresh on unavailable hosts while retaining a CSV snapshot", () => {
  ;(useDocumentSnapshot as jest.Mock).mockReturnValue({
    state: "partial",
    reach: { available: false },
    refresh: jest.fn(),
    refreshFailed: true,
    error: "network",
    content: {
      title: "Report",
      text: "a,b\n1,2",
      format: "csv",
      fetchedAt: 1,
      origin: "sent",
      truncated: true,
      completeness: { status: "partial", reasons: ["budget"] },
    },
  })
  render(<DocumentSnapshotView sessionId="s" tab={tab} />)
  expect(screen.getByRole("button", { name: "refresh" })).toBeDisabled()
  expect(screen.getByRole("table")).toBeInTheDocument()
  expect(screen.getByText("refreshFailed")).toBeInTheDocument()
  expect(screen.getByText("truncated")).toBeInTheDocument()
})
