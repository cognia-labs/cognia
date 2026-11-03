/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: (date: Date) => `date:${date.getTime()}` }),
}))

const analyticsRef: { current: ReturnType<typeof emptyAnalytics> } = {
  current: emptyAnalytics(),
}
function emptyAnalytics() {
  return {
    loading: true as boolean,
    totalSkills: 0,
    totalEnabled: 0,
    totalUsage: 0,
    estimatedTokens: 0,
    byCategory: [] as { category: string; count: number; usage: number }[],
    mostUsed: [] as { id: string; name: string; category: string; usageCount?: number }[],
    recentlyUsed: [] as { id: string; name: string; lastUsedAt?: number }[],
    neverUsed: [] as { id: string; name: string; source: string }[],
    usageByDay: [] as { date: string; count: number }[],
  }
}
jest.mock("@/hooks/skills", () => ({
  useSkillAnalytics: () => analyticsRef.current,
}))

// recharts touches DOM measurements jsdom doesn't model; stub to a no-op
// container so the flat analytics sections render predictably. The ResponsiveContainer stub
// records `initialDimension` so we can assert every chart is seeded with a
// positive size (guards the width(-1)/height(-1) tab-switch mount flash).
jest.mock("recharts", () => {
  const captured: { initialDimension?: { width: number; height: number } }[] = []
  return {
    __esModule: true,
    __captured: captured,
    Bar: ({ fill }: { fill?: string }) => <i data-testid="bar" data-fill={fill} />,
    BarChart: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    CartesianGrid: () => null,
    ResponsiveContainer: ({
      children,
      initialDimension,
    }: {
      children: React.ReactNode
      initialDimension?: { width: number; height: number }
    }) => {
      captured.push({ initialDimension })
      return <div>{children}</div>
    },
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Line: () => null,
    LineChart: () => null,
  }
})

const rechartsMock = jest.requireMock("recharts") as {
  __captured: { initialDimension?: { width: number; height: number } }[]
}

import { fireEvent, render, screen } from "@testing-library/react"
import { useSkillsStore } from "@/stores/skills"
import { SkillAnalytics } from "./skill-analytics"

beforeEach(() => {
  analyticsRef.current = emptyAnalytics()
  rechartsMock.__captured.length = 0
})

describe("SkillAnalytics", () => {
  it("shows a localized loading state, not the literal 'Loading…' string", () => {
    render(<SkillAnalytics />)
    expect(screen.getByText("loading")).toBeInTheDocument()
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument()
  })

  it("renders the four summary metrics once data loads", () => {
    analyticsRef.current = { ...emptyAnalytics(), loading: false }
    render(<SkillAnalytics />)
    expect(screen.getByText("totalSkills")).toBeInTheDocument()
    expect(screen.getByText("totalEnabled")).toBeInTheDocument()
    expect(screen.getByText("totalUsage")).toBeInTheDocument()
    expect(screen.getByText("tokensEstimated")).toBeInTheDocument()
  })

  it("uses distinct headers for the category-usage chart and the most-used list", () => {
    analyticsRef.current = {
      ...emptyAnalytics(),
      loading: false,
      totalUsage: 5,
      byCategory: [{ category: "development", count: 1, usage: 5 }],
      mostUsed: [{ id: "s1", name: "Alpha", category: "development", usageCount: 5 }],
    }
    render(<SkillAnalytics />)
    expect(screen.getByText("categoryUsageTitle")).toBeInTheDocument()
    expect(screen.getByText("mostUsedTitle")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeInTheDocument()
  })

  // Regression: every recharts container (category bar chart + the usage-trend
  // line chart) must be seeded with a positive `initialDimension`. Otherwise it
  // starts at {-1,-1} and, on each tab remount, logs "The width(-1) and
  // height(-1) of chart should be greater than 0" and flashes empty — the
  // reported tab-switch jitter.
  it("seeds every chart with a positive initialDimension", () => {
    analyticsRef.current = {
      ...emptyAnalytics(),
      loading: false,
      totalUsage: 5,
      byCategory: [{ category: "development", count: 1, usage: 5 }],
      usageByDay: [{ date: "2026-05-01", count: 3 }],
    }
    render(<SkillAnalytics />)
    // Category bar chart + usage-trend line chart both render.
    expect(rechartsMock.__captured.length).toBeGreaterThanOrEqual(2)
    for (const cap of rechartsMock.__captured) {
      expect(cap.initialDimension).toBeDefined()
      expect(cap.initialDimension!.width).toBeGreaterThan(0)
      expect(cap.initialDimension!.height).toBeGreaterThan(0)
    }
  })

  it("says nothing has been counted yet instead of drawing empty charts", () => {
    analyticsRef.current = {
      ...emptyAnalytics(),
      loading: false,
      neverUsed: [{ id: "s1", name: "Alpha", source: "custom" }],
    }
    render(<SkillAnalytics />)
    expect(screen.getByTestId("skill-analytics-no-usage")).toHaveTextContent("noUsageTitle")
    expect(screen.queryByTestId("skill-usage-trend")).not.toBeInTheDocument()
    expect(screen.queryByText("categoryUsageTitle")).not.toBeInTheDocument()
    // What has never run is still worth listing.
    expect(screen.getByText("neverUsedTitle")).toBeInTheDocument()
  })

  it("paints the bars with the theme colour as it is, not wrapped in hsl()", () => {
    analyticsRef.current = {
      ...emptyAnalytics(),
      loading: false,
      totalUsage: 2,
      byCategory: [{ category: "development", count: 1, usage: 2 }],
    }
    render(<SkillAnalytics />)
    expect(screen.getByTestId("bar")).toHaveAttribute("data-fill", "var(--primary)")
  })

  it("opens a listed skill on My Skills, where its detail pane is", () => {
    useSkillsStore.setState({ activeTab: "analytics", detailSkillId: null } as never)
    analyticsRef.current = {
      ...emptyAnalytics(),
      loading: false,
      neverUsed: [{ id: "s1", name: "Alpha", source: "custom" }],
    }
    render(<SkillAnalytics />)
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }))
    expect(useSkillsStore.getState().activeTab).toBe("my-skills")
    expect(useSkillsStore.getState().detailSkillId).toBe("s1")
  })

  it("badges never-used rows with their source only when the sources differ", () => {
    analyticsRef.current = {
      ...emptyAnalytics(),
      loading: false,
      neverUsed: [
        { id: "a", name: "Alpha", source: "builtin" },
        { id: "b", name: "Beta", source: "builtin" },
      ],
    }
    const { unmount } = render(<SkillAnalytics />)
    expect(screen.queryByText("builtin")).not.toBeInTheDocument()
    unmount()
    analyticsRef.current = {
      ...analyticsRef.current,
      neverUsed: [
        { id: "a", name: "Alpha", source: "builtin" },
        { id: "b", name: "Beta", source: "custom" },
      ],
    }
    render(<SkillAnalytics />)
    expect(screen.getByText("builtin")).toBeInTheDocument()
    expect(screen.getByText("custom")).toBeInTheDocument()
  })
})
