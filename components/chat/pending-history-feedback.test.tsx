/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { HistoryWaitStrip, PaneSwitchingIndicator } from "./pending-history-feedback"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

describe("PaneSwitchingIndicator", () => {
  it("announces the conversation being opened and draws the sweeping bar", () => {
    render(<PaneSwitchingIndicator />)
    expect(screen.getByRole("status")).toHaveTextContent("chat.history.opening")
    const indicator = screen.getByTestId("pane-switching-indicator")
    expect(indicator).toHaveClass("pointer-events-none", "absolute")
    expect(indicator.querySelector(".pending-progress-bar")).not.toBeNull()
  })
})

describe("HistoryWaitStrip", () => {
  it("says the send is waiting for the full history", () => {
    render(<HistoryWaitStrip />)
    expect(screen.getByRole("status")).toHaveTextContent("chat.history.sendWaiting")
    expect(screen.getByTestId("history-wait-strip")).toHaveClass(
      "rounded-t-[var(--run-strip-radius,0.625rem)]"
    )
  })
})
