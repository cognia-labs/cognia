import { render, screen, within } from "@testing-library/react"

jest.mock("./radar-panel", () => ({ RadarPanel: () => <div data-testid="radar-panel" /> }))

import RadarPetConsoleTab from "./pet-console-tab"

describe("RadarPetConsoleTab", () => {
  it("shows the radar panel, whatever the console passes it", () => {
    render(<RadarPetConsoleTab formFactor="panel" context={{ level: 3 }} />)
    expect(
      within(screen.getByTestId("radar-pet-console-tab")).getByTestId("radar-panel")
    ).toBeInTheDocument()
  })
})
