/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { DocumentLiveView } from "./document-live-view"
import { isTauri } from "@/lib/tauri"
import { useLocalBrowser } from "@/hooks/browser/use-local-browser"
import type { DockDocumentTab } from "@/stores/artifact/dock-documents-store"
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
  ;(isTauri as jest.Mock).mockReturnValue(false)
  ;(useLocalBrowser as jest.Mock).mockReturnValue({
    status: { installed: true },
    refresh: jest.fn(),
  })
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
