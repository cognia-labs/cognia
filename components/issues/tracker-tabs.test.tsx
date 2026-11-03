/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import { render, renderHook, screen } from "@testing-library/react"
import { TrackerTabs, TRACKER_DESTINATIONS, useTrackerHeaderTabs } from "./tracker-tabs"

describe("TrackerTabs", () => {
  it("offers the three tracker destinations as links", () => {
    render(<TrackerTabs active="issues" />)
    expect(screen.getByTestId("tracker-nav-issues")).toHaveAttribute("href", "/issues")
    expect(screen.getByTestId("tracker-nav-projects")).toHaveAttribute("href", "/projects")
    expect(screen.getByTestId("tracker-nav-cycles")).toHaveAttribute("href", "/projects?tab=cycles")
    expect(TRACKER_DESTINATIONS.map((d) => d.id)).toEqual(["issues", "projects", "cycles"])
  })

  it("marks the current destination with aria-current, not a pressed state", () => {
    render(<TrackerTabs active="projects" />)
    expect(screen.getByTestId("tracker-nav-projects")).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("tracker-nav-issues")).not.toHaveAttribute("aria-current")
    expect(screen.getByTestId("tracker-nav-cycles")).not.toHaveAttribute("aria-current")
  })

  it("stretches into equal segments when compact", () => {
    render(<TrackerTabs active="cycles" compact />)
    expect(screen.getByTestId("tracker-nav").className).toContain("w-full")
    expect(screen.getByTestId("tracker-nav-cycles").className).toContain("flex-1")
    expect(screen.getByTestId("tracker-nav-cycles")).toHaveAttribute("aria-current", "page")
  })
})

describe("useTrackerHeaderTabs", () => {
  it("hands the header the same destinations as route tabs", () => {
    const { result } = renderHook(() => useTrackerHeaderTabs("cycles"))
    expect(result.current.value).toBe("cycles")
    expect(result.current.ariaLabel).toBe("rail.trackerNav")
    // Route tabs: the links switch, so there is no change handler.
    expect(result.current.onValueChange).toBeUndefined()
    expect(
      result.current.items.map(({ value, label, href, testId }) => ({ value, label, href, testId }))
    ).toEqual([
      { value: "issues", label: "title", href: "/issues", testId: "tracker-nav-issues" },
      {
        value: "projects",
        label: "projects.title",
        href: "/projects",
        testId: "tracker-nav-projects",
      },
      {
        value: "cycles",
        label: "cycles.title",
        href: "/projects?tab=cycles",
        testId: "tracker-nav-cycles",
      },
    ])
    expect(result.current.items.every((item) => item.icon !== undefined)).toBe(true)
  })
})
