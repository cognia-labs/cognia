/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

import { OTHER_SERIES_KEY, type DailyStack } from "@/lib/usage/usage-insights"
import { formatSeriesCost, UsageStackedCostChart } from "./usage-stacked-cost-chart"

jest.mock("@/hooks/logging/use-theme-colors", () => ({
  useThemeColors: () => ({
    "chart-1": "#111",
    "chart-2": "#222",
    "chart-3": "#333",
    "chart-4": "#444",
    "chart-5": "#555",
  }),
}))

const stack: DailyStack = {
  keys: ["claude-opus", "gpt-4.1", OTHER_SERIES_KEY],
  days: [
    {
      date: "2026-05-19",
      values: { "claude-opus": 1, "gpt-4.1": 0.5, [OTHER_SERIES_KEY]: 0.1 },
      turns: { "claude-opus": 2, "gpt-4.1": 1, [OTHER_SERIES_KEY]: 1 },
      unpriced: { "claude-opus": 0, "gpt-4.1": 0, [OTHER_SERIES_KEY]: 0 },
      total: 1.6,
    },
    {
      date: "2026-05-20",
      values: { "claude-opus": 2, "gpt-4.1": 0, [OTHER_SERIES_KEY]: 0 },
      turns: { "claude-opus": 1, "gpt-4.1": 2, [OTHER_SERIES_KEY]: 0 },
      unpriced: { "claude-opus": 0, "gpt-4.1": 2, [OTHER_SERIES_KEY]: 0 },
      total: 2,
    },
  ],
}

describe("UsageStackedCostChart", () => {
  it("renders a legend entry per series with the other bucket localized", () => {
    render(<UsageStackedCostChart stack={stack} labelFor={(k) => `label:${k}`} reduce />)
    const legend = screen.getByTestId("usage-stacked-chart-legend")
    const items = legend.querySelectorAll("li")
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent("label:claude-opus")
    expect(items[1]).toHaveTextContent("label:gpt-4.1")
    expect(items[2]).toHaveTextContent("Other")
    expect(items[0].querySelector("span")).toHaveStyle({ backgroundColor: "#111" })
  })
})

describe("formatSeriesCost (ADR-0253 §10)", () => {
  it("shows an unpriced series as unknown and a partly priced one as a lower bound", () => {
    expect(formatSeriesCost(0, "s1", { s1: 0, t1: 2, u1: 2 })).toBe("—")
    expect(formatSeriesCost(1.5, "s0", { s0: 1.5, t0: 3, u0: 1 })).toBe("≥ $1.50")
    expect(formatSeriesCost(1.5, "s0", { s0: 1.5, t0: 3, u0: 0 })).toBe("$1.50")
  })

  it("falls back to the plain figure without series counts", () => {
    expect(formatSeriesCost(2, "total", { total: 2 })).toBe("$2.00")
    expect(formatSeriesCost(2, "s0", undefined)).toBe("$2.00")
  })
})
