/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

// Each segment has its own suite; stub them so this one asserts the id →
// component mapping, the ordering, and the responsive breakpoint classes.
jest.mock("@/components/desktop/title-bar-nav-arrows", () => ({
  TitleBarNavArrows: ({ className }: { className?: string }) => (
    <div data-testid="seg-navArrows" className={className} />
  ),
}))
let mockWorkspaceVisible = true
jest.mock("@/components/desktop/title-bar-workspace", () => ({
  TitleBarWorkspace: ({ className }: { className?: string }) =>
    mockWorkspaceVisible ? <div data-testid="seg-workspace" className={className} /> : null,
}))
jest.mock("@/components/desktop/title-bar-search-pill", () => ({
  TitleBarSearchPill: ({
    appName,
    onClick,
    compact,
  }: {
    appName: string
    onClick: () => void
    compact?: boolean
  }) => (
    <button
      type="button"
      data-testid="seg-search"
      data-compact={compact || undefined}
      onClick={onClick}
    >
      {appName}
    </button>
  ),
}))
jest.mock("@/components/desktop/title-bar-command-center-menu", () => ({
  TitleBarCommandCenterMenu: ({ compact }: { compact?: boolean }) => (
    <div data-testid="seg-commandCenterCaret" data-compact={compact || undefined} />
  ),
}))
jest.mock("@/components/desktop/title-bar-quick-actions", () => ({
  TitleBarQuickActions: ({ className }: { className?: string }) => (
    <div data-testid="seg-quickActions" className={className} />
  ),
}))
jest.mock("@/components/desktop/title-bar-layout-controls", () => ({
  TitleBarLayoutControls: ({
    className,
    controls,
  }: {
    className?: string
    controls?: string[]
  }) => (
    <div
      data-testid={`seg-${
        controls?.[0] === "sidebar"
          ? "primarySidebarToggle"
          : controls?.[0] === "panel"
            ? "panelToggle"
            : controls?.[0] === "rightSidebar"
              ? "secondarySidebarToggle"
              : "layoutControls"
      }`}
      className={className}
    />
  ),
}))
jest.mock("@/components/account/account-bar-button", () => ({
  AccountBarButton: ({ className }: { className?: string }) => (
    <div data-testid="seg-accountTop" className={className} />
  ),
}))

import { TitleBarZone, type TitleBarItemContext } from "./title-bar-zone"
import { getBarCatalog } from "@/lib/shell/bar-items"
import { TITLE_BAR_ITEMS } from "@/types/shell/bars"

const catalog = getBarCatalog("title", "tauri")
const pick = (...ids: string[]) => ids.map((id) => catalog.find((c) => c.id === id)!)

const onCommandPalette = jest.fn()
const ctx: TitleBarItemContext = {
  appName: "Cognia",
  separator: " — ",
  searchPlaceholder: "Search",
  recentSessions: [],
  onCommandPalette,
  onOpenRecentSession: jest.fn(),
  onGo: jest.fn(),
}

beforeEach(() => {
  onCommandPalette.mockClear()
  mockWorkspaceVisible = true
})

describe("TitleBarZone", () => {
  it("mounts a component for every catalog id", () => {
    render(<TitleBarZone items={catalog} ctx={ctx} />)
    for (const meta of TITLE_BAR_ITEMS) {
      const testId = meta.id === "appIcon" ? "title-bar-app-icon" : `seg-${meta.id}`
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
  })

  it("renders in the order it is given", () => {
    const { container } = render(<TitleBarZone items={pick("search", "navArrows")} ctx={ctx} />)
    const ids = Array.from(container.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    )
    expect(ids).toEqual([
      "title-bar-command-center",
      "seg-search",
      "seg-commandCenterCaret",
      "seg-navArrows",
    ])
  })

  it("draws the search pill and the command-centre caret as one group", () => {
    render(<TitleBarZone items={pick("search")} ctx={ctx} />)
    const group = screen.getByTestId("title-bar-command-center")
    expect(group).toContainElement(screen.getByTestId("seg-search"))
    expect(group).toContainElement(screen.getByTestId("seg-commandCenterCaret"))
    expect(group.className).toContain("flex-1")
  })

  it("keeps the caret beside the compact pill", () => {
    render(<TitleBarZone items={pick("search")} ctx={ctx} compact />)
    const group = screen.getByTestId("title-bar-command-center")
    expect(group).toContainElement(screen.getByTestId("seg-commandCenterCaret"))
    expect(screen.getByTestId("seg-commandCenterCaret")).toHaveAttribute("data-compact", "true")
    expect(group.className).toContain("shrink-0")
  })

  it("passes the bar's context down to the search pill", () => {
    render(<TitleBarZone items={pick("search")} ctx={ctx} />)
    expect(screen.getByTestId("seg-search")).toHaveTextContent("Cognia")
    screen.getByTestId("seg-search").click()
    expect(onCommandPalette).toHaveBeenCalled()
  })

  // One rule for every zone: a segment whose floor the tier does not reach
  // moves into the zone's "…" menu instead of vanishing.
  it("moves a segment below its floor into the zone's overflow menu", () => {
    render(<TitleBarZone items={pick("navArrows", "workspace")} ctx={ctx} tier="medium" />)
    expect(screen.getByTestId("seg-navArrows")).toBeInTheDocument()
    expect(screen.queryByTestId("seg-workspace")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("title-bar-navigation-menu"))
    expect(screen.getByTestId("seg-workspace")).toBeInTheDocument()
  })

  it("keeps every segment on the bar once the tier reaches its floor", () => {
    render(<TitleBarZone items={pick("workspace", "quickActions")} ctx={ctx} tier="wide" />)
    expect(screen.getByTestId("seg-workspace")).toBeInTheDocument()
    expect(screen.getByTestId("seg-quickActions")).toBeInTheDocument()
    expect(screen.queryByTestId("title-bar-navigation-menu")).not.toBeInTheDocument()
  })

  it("names the end zone's overflow menu for what it holds", () => {
    render(
      <TitleBarZone
        items={pick("quickActions", "accountTop")}
        ctx={ctx}
        tier="regular"
        region="end"
      />
    )
    expect(screen.getByTestId("seg-accountTop")).toBeInTheDocument()
    const more = screen.getByTestId("title-bar-end-overflow-menu")
    expect(more).toHaveAttribute("aria-label", "More controls")
    fireEvent.click(more)
    expect(screen.getByTestId("seg-quickActions")).toBeInTheDocument()
  })

  it("keeps segments without a floor on the bar at any tier", () => {
    render(<TitleBarZone items={pick("navArrows", "accountTop")} ctx={ctx} tier="compact" />)
    expect(screen.queryByTestId("title-bar-navigation-menu")).not.toBeInTheDocument()
    expect(screen.getByTestId("seg-navArrows")).toBeInTheDocument()
    expect(screen.getByTestId("seg-accountTop")).toBeInTheDocument()
  })

  it("renders nothing for an empty zone", () => {
    const { container } = render(<TitleBarZone items={[]} ctx={ctx} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("skips an id with no component instead of throwing", () => {
    // Unreachable for real catalog ids (the first test pins that), but a stored
    // layout is user data and could name an id a later version removed.
    const ghost = { ...catalog[0], id: "ghost" }
    const { container } = render(<TitleBarZone items={[ghost]} ctx={ctx} />)
    expect(container).toBeEmptyDOMElement()
  })
})

it("folds secondary chat navigation while preserving its existing controls and hidden preferences", () => {
  render(<TitleBarZone items={pick("search", "navArrows", "workspace")} ctx={ctx} compact />)
  expect(screen.getByTestId("seg-search")).toHaveAttribute("data-compact", "true")
  expect(screen.queryByTestId("seg-workspace")).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId("title-bar-navigation-menu"))
  expect(screen.getByTestId("seg-navArrows")).toBeInTheDocument()
  expect(screen.getByTestId("seg-workspace")).not.toHaveClass("hidden")
  // The caret never folds away from the pill.
  expect(screen.getAllByTestId("seg-commandCenterCaret")).toHaveLength(1)
  expect(screen.queryByTestId("seg-accountTop")).not.toBeInTheDocument()
})
it("does not add an empty navigation menu when the user keeps only search", () => {
  render(<TitleBarZone items={pick("search")} ctx={ctx} compact />)
  expect(screen.queryByTestId("title-bar-navigation-menu")).not.toBeInTheDocument()
})

it("does not leave a workspace heading when the shared switcher hides itself", () => {
  mockWorkspaceVisible = false
  render(<TitleBarZone items={pick("navArrows", "workspace")} ctx={ctx} compact />)
  fireEvent.click(screen.getByTestId("title-bar-navigation-menu"))
  expect(screen.queryByText("Workspace")).not.toBeInTheDocument()
})
