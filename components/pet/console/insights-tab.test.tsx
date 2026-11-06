import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render, screen, within } from "@testing-library/react"

jest.mock("@/components/capture/capture-settings-panel", () => ({
  CaptureSettingsPanel: () => <div data-testid="capture-settings" />,
}))

import { InsightsTab } from "./insights-tab"

describe("InsightsTab", () => {
  it("frames the capture settings under their own heading", () => {
    render(<InsightsTab />)
    const section = screen
      .getByRole("heading", { name: /capture/i })
      .closest("section") as HTMLElement
    expect(within(screen.getByTestId("pet-insights-tab")).getByRole("heading")).toBeInTheDocument()
    expect(within(section).getByTestId("capture-settings")).toBeInTheDocument()
    // It names what the captures feed, which now lives in the Extensions tab.
    expect(within(section).getByText(/radar/i)).toBeInTheDocument()
  })

  it("no longer holds the radar report, which the radar module puts in the Extensions tab", () => {
    // The pet imports no radar code (ADR-0250 §14, `components/radar/module.ui.ts`).
    const source = readFileSync(join(__dirname, "insights-tab.tsx"), "utf8")
    expect(source).not.toMatch(/from "[^"]*radar/)
  })
})
