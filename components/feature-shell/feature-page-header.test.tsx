/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { PlusIcon } from "lucide-react"

jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    ...props
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
    "data-testid"?: string
  }) => (
    <button
      type="button"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect?.()
      }}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { FeaturePageHeader, MAX_VISIBLE_SECONDARY_ACTIONS } from "./feature-page-header"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"

function renderHeader(header: React.ReactNode) {
  return render(<TooltipProvider>{header}</TooltipProvider>)
}

test("renders the identity row: icon, title, status chip, description, context, summary", () => {
  const onCreate = jest.fn()
  renderHeader(
    <FeaturePageHeader
      variant="management"
      icon={<PlusIcon data-testid="identity-icon" />}
      title="Workflows"
      description="Build and run repeatable automations"
      context={<span>Root folder</span>}
      status={{ label: "Ready", tone: "success", testId: "wf-status" }}
      summary={<span>12 workflows</span>}
      primaryAction={{ id: "create", label: "New workflow", icon: PlusIcon, onSelect: onCreate }}
      actions={<button type="button">Custom action</button>}
    />
  )

  const header = screen.getByRole("banner")
  expect(header).toHaveAttribute("data-variant", "management")
  expect(header).toHaveAttribute("data-has-secondary", "false")
  expect(screen.getByRole("heading", { name: "Workflows" })).toBeInTheDocument()
  expect(screen.getByText("Build and run repeatable automations")).toBeInTheDocument()
  expect(screen.getByText("Root folder")).toBeInTheDocument()
  expect(screen.getByText("12 workflows")).toBeInTheDocument()
  expect(screen.getByTestId("identity-icon")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Custom action" })).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "New workflow" }))
  expect(onCreate).toHaveBeenCalledTimes(1)
})

// One chip style for every page: a dot in the tone's colour and a short label.
// Pages used to pass their own pill, which is how /plugins, /memory and
// /scheduler each grew a different one.
test("draws status as the one chip, coloured by tone", () => {
  renderHeader(
    <FeaturePageHeader
      title="Scheduler"
      status={{ label: "Running", tone: "active", title: "2 tasks running", testId: "chip" }}
    />
  )
  const chip = screen.getByTestId("chip")
  expect(chip).toHaveAttribute("data-slot", "feature-header-status")
  expect(chip).toHaveAttribute("data-tone", "active")
  expect(chip).toHaveAttribute("title", "2 tasks running")
  expect(chip).toHaveTextContent("Running")
})

test("orders the actions: refresh, custom, secondary, overflow, primary last", () => {
  renderHeader(
    <FeaturePageHeader
      title="Devices"
      refresh={{ label: "Refresh", onSelect: jest.fn(), testId: "refresh" }}
      actions={<button type="button" data-testid="custom" />}
      secondaryActions={[{ id: "add", label: "Add host", testId: "add" }]}
      overflowActions={[{ id: "ssh", label: "Add SSH host" }]}
      primaryAction={{ id: "pair", label: "Pair", testId: "pair" }}
    />
  )
  const strip = screen.getByTestId("feature-header-actions")
  const order = Array.from(strip.querySelectorAll("button"))
    .map(
      (button) =>
        button.getAttribute("data-testid") ??
        button.getAttribute("data-slot") ??
        button.getAttribute("aria-label")
    )
    // The mocked menu renders its items inline; they are not strip buttons.
    .filter((id) => id !== null)
  expect(order).toEqual(["refresh", "custom", "add", "feature-header-overflow", "pair"])
})

// More than two visible secondary buttons turned the identity row into a
// toolbar (/skills drew six). The rest fold into "⋯" ahead of its own items.
test("shows two secondary actions and folds the rest into the overflow menu", () => {
  const onExport = jest.fn()
  renderHeader(
    <FeaturePageHeader
      title="Skills"
      secondaryActions={[
        { id: "import", label: "Import", testId: "import" },
        { id: "sync", label: "Sync", testId: "sync" },
        { id: "export", label: "Export all", onSelect: onExport, testId: "export" },
      ]}
      overflowActions={[{ id: "updates", label: "Check for updates", testId: "updates" }]}
    />
  )
  expect(MAX_VISIBLE_SECONDARY_ACTIONS).toBe(2)
  const strip = screen.getByTestId("feature-header-actions")
  const menu = screen.getByTestId("export").closest('[role="menu"], div') as HTMLElement
  expect(strip).toContainElement(screen.getByTestId("import"))
  expect(screen.getByTestId("import")).toHaveAttribute("data-slot", "button")
  expect(screen.getByTestId("export")).not.toHaveAttribute("data-slot", "button")
  expect(menu).toContainElement(screen.getByTestId("updates"))
  // The folded item leads the menu, before the page's own overflow items.
  const items = Array.from(menu.querySelectorAll("button")).map((b) => b.textContent)
  expect(items.indexOf("Export all")).toBeLessThan(items.indexOf("Check for updates"))
  fireEvent.click(screen.getByTestId("export"))
  expect(onExport).toHaveBeenCalledTimes(1)
  // With no label passed, the trigger is named by the shared string.
  expect(screen.getByRole("button", { name: "moreActions" })).toBeInTheDocument()
})

test("renders destructive and disabled overflow actions with stable test ids", () => {
  const onDelete = jest.fn()
  renderHeader(
    <FeaturePageHeader
      title="Plugins"
      overflowLabel="More plugin actions"
      overflowActions={[
        { id: "disabled", label: "Checking updates", disabled: true },
        {
          id: "delete",
          label: "Remove plugin",
          destructive: true,
          onSelect: onDelete,
          testId: "remove-plugin",
        },
      ]}
    />
  )
  expect(screen.getByRole("button", { name: "More plugin actions" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Checking updates" })).toBeDisabled()
  fireEvent.click(screen.getByTestId("remove-plugin"))
  expect(onDelete).toHaveBeenCalledTimes(1)
})

test("keeps overflow actions keyboard accessible", () => {
  const onExport = jest.fn()
  renderHeader(
    <FeaturePageHeader
      title="Logs"
      overflowActions={[{ id: "export", label: "Export logs", onSelect: onExport }]}
    />
  )
  fireEvent.keyDown(screen.getByRole("button", { name: "Export logs" }), { key: "Enter" })
  expect(onExport).toHaveBeenCalledTimes(1)
})

test("splits the primary action with a menu of related creations", () => {
  const onTemplate = jest.fn()
  renderHeader(
    <FeaturePageHeader
      title="Scheduler"
      primaryAction={{
        id: "create",
        label: "Create task",
        testId: "create",
        menuLabel: "More ways to create",
        menu: [
          { id: "tpl", label: "From template", onSelect: onTemplate },
          { id: "sys", label: "System task", separatorBefore: true },
        ],
      }}
    />
  )
  expect(screen.getByTestId("create")).toBeInTheDocument()
  expect(screen.getByTestId("create-menu")).toHaveAccessibleName("More ways to create")
  fireEvent.click(screen.getByRole("button", { name: "From template" }))
  expect(onTemplate).toHaveBeenCalledTimes(1)
  // A rule opens the System group; none leads the menu.
  const sys = screen.getByRole("button", { name: "System task" })
  expect(sys.previousElementSibling?.tagName).toBe("HR")
  expect(screen.getByRole("button", { name: "From template" }).previousElementSibling).toBeNull()
})

test("spins the refresh glyph and blocks a second press while busy", () => {
  const onRefresh = jest.fn()
  const { rerender } = renderHeader(
    <FeaturePageHeader title="Devices" refresh={{ label: "Refresh", onSelect: onRefresh }} />
  )
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
  expect(onRefresh).toHaveBeenCalledTimes(1)
  rerender(
    <TooltipProvider>
      <FeaturePageHeader
        title="Devices"
        refresh={{ label: "Refresh", onSelect: onRefresh, busy: true }}
      />
    </TooltipProvider>
  )
  const button = screen.getByRole("button", { name: "Refresh" })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute("aria-busy", "true")
  expect(button.querySelector("svg")).toHaveClass("motion-safe:animate-spin")
})

test("draws a sub-page's way back where the icon tile goes", () => {
  renderHeader(
    <FeaturePageHeader
      title="prod-eu-1"
      icon={<PlusIcon data-testid="identity-icon" />}
      back={{ label: "Back to servers", href: "/servers", testId: "back" }}
    />
  )
  const back = screen.getByRole("link", { name: "Back to servers" })
  expect(back).toHaveAttribute("href", "/servers")
  expect(back).toHaveAttribute("data-slot", "feature-header-back")
  expect(screen.queryByTestId("identity-icon")).toBeNull()
})

describe("view bar", () => {
  test("puts tabs, search and controls in their own row, never the identity row", () => {
    const onTab = jest.fn()
    const onSearch = jest.fn()
    renderHeader(
      <FeaturePageHeader
        title="Issues"
        tabs={{
          ariaLabel: "Tracker views",
          value: "issues",
          onValueChange: onTab,
          items: [
            { value: "issues", label: "Issues", count: 12 },
            { value: "projects", label: "Projects", count: 3, testId: "tab-projects" },
          ],
        }}
        search={{ value: "", onChange: onSearch, placeholder: "Search issues", testId: "q" }}
        controls={<button type="button">Filter</button>}
      />
    )
    const header = screen.getByRole("banner")
    expect(header).toHaveAttribute("data-has-secondary", "true")
    const bar = header.querySelector('[data-slot="feature-header-view-bar"]') as HTMLElement
    expect(bar).toContainElement(screen.getByRole("tablist", { name: "Tracker views" }))
    expect(bar).toContainElement(screen.getByTestId("q"))
    expect(bar).toContainElement(screen.getByRole("button", { name: "Filter" }))
    // One tab style everywhere: the underline list.
    expect(screen.getByRole("tablist")).toHaveAttribute("data-variant", "line")
    expect(screen.getByRole("tab", { name: "Issues 12" })).toHaveAttribute("data-state", "active")
    fireEvent.mouseDown(screen.getByTestId("tab-projects"))
    expect(onTab).toHaveBeenCalledWith("projects")
    fireEvent.change(screen.getByRole("searchbox", { name: "Search issues" }), {
      target: { value: "crash" },
    })
    expect(onSearch).toHaveBeenCalledWith("crash")
  })

  // A page whose query lives in the URL gets it back a render later. The box
  // keeps the user's text, reports only final text, and still follows a
  // change it did not make.
  test("search keeps its draft through URL lag, waits out an IME, and follows outside changes", () => {
    const onChange = jest.fn()
    const header = (value: string) => (
      <TooltipProvider>
        <FeaturePageHeader
          title="Templates"
          search={{ value, onChange, placeholder: "Search templates" }}
        />
      </TooltipProvider>
    )
    const { rerender } = render(header(""))
    const box = screen.getByRole("searchbox", { name: "Search templates" })

    fireEvent.change(box, { target: { value: "a" } })
    fireEvent.change(box, { target: { value: "ab" } })
    expect(onChange).toHaveBeenLastCalledWith("ab")
    // The URL catches up one step behind: "a" is an echo, not a reset.
    rerender(header("a"))
    expect(box).toHaveValue("ab")
    rerender(header("ab"))
    expect(box).toHaveValue("ab")

    // An IME composes "ni" then commits 你: only the commit is reported.
    onChange.mockClear()
    fireEvent.compositionStart(box)
    fireEvent.input(box, { target: { value: "abni" }, isComposing: true })
    fireEvent.input(box, { target: { value: "ab你" }, isComposing: true })
    expect(onChange).not.toHaveBeenCalled()
    expect(box).toHaveValue("ab你")
    fireEvent.compositionEnd(box)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith("ab你")

    // A Clear filters button outside the box empties it.
    rerender(header(""))
    expect(box).toHaveValue("")
  })

  test("route tabs are links that mark the current page", () => {
    renderHeader(
      <FeaturePageHeader
        title="Issues"
        tabs={{
          ariaLabel: "Tracker",
          value: "projects",
          items: [
            { value: "issues", label: "Issues", href: "/issues" },
            { value: "projects", label: "Projects", href: "/projects" },
          ],
        }}
      />
    )
    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute("href", "/projects")
    expect(screen.getByRole("tab", { name: "Projects" })).toHaveAttribute("aria-current", "page")
    expect(screen.getByRole("tab", { name: "Issues" })).not.toHaveAttribute("aria-current")
  })

  // /pet keeps its own Tabs root so each tab still controls its panel, and
  // badges the places a paired phone can only look at.
  test("draws only the list inside a page-owned Tabs root, with per-tab badges", () => {
    const onChange = jest.fn()
    renderHeader(
      <Tabs value="home" onValueChange={onChange}>
        <FeaturePageHeader
          title="Boba"
          tabs={{
            ariaLabel: "Places",
            value: "home",
            inOuterRoot: true,
            testId: "places",
            items: [
              { value: "home", label: "Home" },
              { value: "insights", label: "Insights", badge: "Desktop" },
            ],
          }}
        />
        <TabsContent value="home">home panel</TabsContent>
      </Tabs>
    )
    const list = screen.getByTestId("places")
    expect(list).toHaveAttribute("role", "tablist")
    // No second root: the tab controls the page's own panel.
    const home = screen.getByRole("tab", { name: "Home" })
    expect(home).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id)
    const insights = list.querySelector('[data-tab="insights"]') as HTMLElement
    expect(insights).toHaveAttribute("data-badged", "true")
    expect(insights).toHaveTextContent("Desktop")
    fireEvent.mouseDown(insights)
    expect(onChange).toHaveBeenCalledWith("insights")
  })

  test("renders compact chrome without a view bar", () => {
    renderHeader(<FeaturePageHeader variant="compact" title="Source control" />)
    const header = screen.getByRole("banner")
    expect(header).toHaveAttribute("data-variant", "compact")
    expect(header).toHaveAttribute("data-has-secondary", "false")
  })

  test("every view-bar slot and the breadcrumb can scroll their own overflow", () => {
    // The header is `overflow-hidden`, so a slot that can neither shrink nor
    // scroll does not spill visibly, it disappears: /eval shipped four tabs of
    // which two were unreachable at 375px, and /logs lost its buttons the same
    // way.
    const { rerender } = renderHeader(
      <FeaturePageHeader
        title="Logs"
        navigation={<nav aria-label="Channels">Logs</nav>}
        controls={<button type="button">Filter</button>}
      />
    )
    const nav = screen
      .getByRole("navigation", { name: "Channels" })
      .closest("[data-slot='feature-header-view-navigation']")
    expect(nav).toHaveClass("overflow-x-auto")
    expect(
      screen
        .getByRole("button", { name: "Filter" })
        .closest("[data-slot='feature-header-controls']")
    ).toHaveClass("overflow-x-auto", "ms-auto")

    rerender(
      <TooltipProvider>
        <FeaturePageHeader title="Source Control" breadcrumb={<button>Root</button>} />
      </TooltipProvider>
    )
    const breadcrumb = screen
      .getByRole("button", { name: "Root" })
      .closest("[data-slot='feature-header-breadcrumb']")
    expect(breadcrumb).toHaveClass("overflow-x-auto")
    expect(breadcrumb).not.toHaveClass("shrink-0")
  })
})

test("keeps the title visible at every width", () => {
  renderHeader(
    <FeaturePageHeader
      title="Logs"
      tabs={{ ariaLabel: "Channels", value: "a", items: [{ value: "a", label: "A" }] }}
    />
  )
  expect(screen.getByRole("heading", { name: "Logs" })).not.toHaveClass("sr-only")
})

test("draws an avatar in the identity tile without the icon sizing", () => {
  renderHeader(
    <FeaturePageHeader
      title="Boba"
      icon={<PlusIcon data-testid="identity-icon" />}
      avatar={<svg data-testid="identity-avatar" />}
    />
  )
  const tile = document.querySelector('[data-slot="feature-header-avatar"]')
  expect(tile).toContainElement(screen.getByTestId("identity-avatar"))
  // The icon-only rule would shrink a drawn picture to a 16px glyph.
  expect(tile?.className).not.toMatch(/\[&_svg\]/)
  // The avatar replaces the icon rather than sitting beside it.
  expect(screen.queryByTestId("identity-icon")).toBeNull()
})
