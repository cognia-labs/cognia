import { render, screen } from "@testing-library/react"
import { DesktopOnlyNotice } from "./desktop-only-notice"

describe("DesktopOnlyNotice", () => {
  it("says what the place is, why it stays on the desktop, and where to find it", () => {
    render(<DesktopOnlyNotice tab="appearance" />)
    const notice = screen.getByTestId("pet-desktop-only-notice")
    expect(notice).toHaveAttribute("data-tab", "appearance")
    expect(notice).toHaveTextContent(/Appearance & settings is on your desktop/)
    expect(notice).toHaveTextContent(/skin, size and behavior/)
    expect(notice).toHaveTextContent(/stored on your desktop/)
    expect(notice).toHaveTextContent(/Pet → Appearance & settings/)
  })

  it("names the path to insights inside Activity", () => {
    render(<DesktopOnlyNotice tab="insights" />)
    expect(screen.getByTestId("pet-desktop-only-notice")).toHaveTextContent(
      /Pet → Activity → Insights/
    )
  })

  it.each(["appearance", "insights", "plugins"] as const)("explains the %s place", (tab) => {
    render(<DesktopOnlyNotice tab={tab} />)
    // Two descriptions: what the place is for, then why it is desktop-only.
    const notice = screen.getByTestId("pet-desktop-only-notice")
    expect(notice.querySelectorAll("[data-slot='empty-description']").length).toBe(2)
  })
})
