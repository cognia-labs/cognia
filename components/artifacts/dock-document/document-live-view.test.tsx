/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { DocumentLiveView } from "./document-live-view"
import { isTauri } from "@/lib/tauri"
import { useLocalBrowser } from "@/hooks/browser/use-local-browser"
import type { DockDocumentTab } from "@/stores/artifact/dock-documents-store"
let mockLiveState = "blocked"
let mockLiveReason: string | undefined = "isolation-unavailable"
jest.mock("@/components/browser/document-viewer-browser", () => ({
  DocumentViewerBrowser: ({
    onState,
  }: {
    onState: (state: string, detail?: { reason?: string }) => void
  }) => {
    const { useEffect } = jest.requireActual("react")
    useEffect(() => onState(mockLiveState, { reason: mockLiveReason }), [onState])
    return <div role="application" aria-label="document" className="flex min-h-0 flex-1" />
  },
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/hooks/browser/use-local-browser", () => ({ useLocalBrowser: jest.fn() }))
jest.mock("@/components/browser/browser-backend-switcher", () => ({
  LocalChromiumInstall: () => <button>install chromium</button>,
}))
const tab: DockDocumentTab = {
  id: "d",
  providerId: "lark",
  resourceKind: "doc",
  resourceId: "abcdefghijklmnop1234",
  url: "https://a.feishu.cn/docx/abcdefghijklmnop1234",
  title: "Report",
  view: "live",
  openedAt: 1,
}
beforeEach(() => {
  mockLiveState = "blocked"
  mockLiveReason = "isolation-unavailable"
  ;(isTauri as jest.Mock).mockReturnValue(false)
  ;(useLocalBrowser as jest.Mock).mockReturnValue({
    status: { installed: true },
    refresh: jest.fn(),
  })
})
it("lets the ready browser fill the panel without status or action rows", () => {
  ;(isTauri as jest.Mock).mockReturnValue(true)
  mockLiveState = "ready"
  mockLiveReason = undefined
  const { container } = render(<DocumentLiveView sessionId="s" tab={tab} />)
  expect(screen.getByRole("application", { name: "document" })).toHaveClass("flex-1", "min-h-0")
  expect(screen.queryByRole("status")).toBeNull()
  expect(screen.queryByRole("button", { name: "retry" })).toBeNull()
  expect(container.firstChild).toHaveClass("relative", "min-h-0")
})
it("shows failures in an overlay without shrinking the page", () => {
  ;(isTauri as jest.Mock).mockReturnValue(true)
  mockLiveState = "blocked"
  mockLiveReason = "cap-reached"
  render(<DocumentLiveView sessionId="s" tab={tab} />)
  expect(screen.getByText("live.reasons.cap-reached")).toBeInTheDocument()
  expect(screen.getByRole("status").parentElement?.parentElement).toHaveClass("absolute")
})
it("explains desktop-only availability without embedding the page", () => {
  const { container } = render(<DocumentLiveView sessionId="s" tab={tab} />)
  expect(screen.getByText("live.reasons.web")).toBeInTheDocument()
  expect(container.querySelector("iframe")).toBeNull()
})
it("reuses the Chromium install control when it is missing", () => {
  ;(isTauri as jest.Mock).mockReturnValue(true)
  ;(useLocalBrowser as jest.Mock).mockReturnValue({
    status: { installed: false },
    refresh: jest.fn(),
  })
  render(<DocumentLiveView sessionId="s" tab={tab} />)
  expect(screen.getByRole("button", { name: "install chromium" })).toBeInTheDocument()
})
it("reports the unavailable isolated runtime on desktop with Chromium", () => {
  ;(isTauri as jest.Mock).mockReturnValue(true)
  render(<DocumentLiveView sessionId="s" tab={tab} />)
  expect(screen.getByText("live.reasons.isolation-unavailable")).toBeInTheDocument()
})
it("never invents a link for picker hits without an original URL", () => {
  render(<DocumentLiveView sessionId="s" tab={{ ...tab, url: "" }} />)
  expect(screen.getByText("live.reasons.unknown-link")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "openSystem" })).toBeDisabled()
})
