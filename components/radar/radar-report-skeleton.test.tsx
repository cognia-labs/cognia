import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { RadarReportSkeleton } from "./radar-report-skeleton"

describe("RadarReportSkeleton", () => {
  it("is one busy region that names what is loading", () => {
    render(<RadarReportSkeleton testId="radar-loading" />)
    const region = screen.getByTestId("radar-loading")
    expect(region).toHaveAttribute("aria-busy", "true")
    expect(region).toHaveAttribute("role", "status")
    expect(region).toHaveTextContent("panel.loading")
    expect(region.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it.each([1, 3, 5])("draws one placeholder per requested section (%i)", (count) => {
    render(<RadarReportSkeleton testId="radar-loading" count={count} />)
    expect(
      screen.getByTestId("radar-loading").querySelectorAll("[data-skeleton-item]")
    ).toHaveLength(count)
  })

  it("defaults to three sections", () => {
    render(<RadarReportSkeleton testId="radar-loading" />)
    expect(
      screen.getByTestId("radar-loading").querySelectorAll("[data-skeleton-item]")
    ).toHaveLength(3)
  })
})
