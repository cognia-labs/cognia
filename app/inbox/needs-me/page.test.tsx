/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import InboxNeedsMePage from "./page"

let compact = false
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: () => compact }))

jest.mock("@/components/mobile/inbox/mobile-inbox-body", () => ({
  MobileInboxBody: ({ initialTab }: { initialTab?: string }) => (
    <div data-testid="stub-mobile-inbox" data-tab={initialTab} />
  ),
}))
jest.mock("@/components/inbox/inbox-shell", () => ({
  InboxShell: ({ children, view }: { children?: React.ReactNode; view: string }) => (
    <div data-testid="stub-inbox-shell" data-view={view}>
      {children}
    </div>
  ),
}))
jest.mock("@/components/inbox/needs-me-center", () => ({
  NeedsMeCenter: () => <div data-testid="stub-needs-me-center" />,
}))
jest.mock("@/components/ui/loading-states", () => ({ PageLoading: () => null }))

describe("/inbox/needs-me dispatch (F10)", () => {
  it("opens the mobile inbox on the needs-me tab on a narrow viewport", () => {
    compact = true
    render(<InboxNeedsMePage />)
    expect(screen.getByTestId("stub-mobile-inbox")).toHaveAttribute("data-tab", "needs-me")
    expect(screen.queryByTestId("stub-inbox-shell")).not.toBeInTheDocument()
  })

  it("renders the desktop InboxShell + NeedsMeCenter on a wide viewport", () => {
    compact = false
    render(<InboxNeedsMePage />)
    expect(screen.getByTestId("stub-inbox-shell")).toHaveAttribute("data-view", "needs-me")
    expect(screen.getByTestId("stub-needs-me-center")).toBeInTheDocument()
    expect(screen.queryByTestId("stub-mobile-inbox")).not.toBeInTheDocument()
  })
})
