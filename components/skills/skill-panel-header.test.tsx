/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

// The toolbar hook has its own suite; here it only has to hand the header a
// model, so the header test does not pull the import/sync graph.
const mockCreate = jest.fn()
jest.mock("./skill-panel-toolbar", () => ({
  useSkillPanelToolbar: () => ({
    primaryAction: { id: "new", label: "new", onSelect: mockCreate, testId: "toolbar-new" },
    secondaryActions: [{ id: "record", label: "record", onSelect: jest.fn() }],
    overflowActions: [{ id: "export-all", label: "exportAll", onSelect: jest.fn() }],
    importMenu: <div data-testid="import-stub" />,
  }),
}))

// Stub the preferences popover (its own test covers behavior; this keeps the
// header test from pulling the full hooks/settings graph).
jest.mock("./skill-preferences", () => ({
  SkillPreferencesPopover: () => <div data-testid="prefs-stub" />,
}))

import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSkillsStore } from "@/stores/skills"
import { SkillPanelHeader } from "./skill-panel-header"

function renderHeader(props: Partial<React.ComponentProps<typeof SkillPanelHeader>> = {}) {
  return render(
    <TooltipProvider>
      <SkillPanelHeader totalCount={1} filteredCount={1} {...props} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  mockCreate.mockClear()
  useSkillsStore.setState({
    activeTab: "my-skills",
    filters: {
      query: "",
      category: "all",
      source: "all",
      status: "all",
      tag: null,
      sort: "name",
    },
    filterSheetOpen: false,
    categorySheetOpen: false,
    editorWorkspace: {
      activeSkillId: null,
      openFiles: [],
      activeFileId: null,
      rightPaneOpen: true,
    },
  } as never)
})

describe("SkillPanelHeader", () => {
  it("is a top-level page: its icon tile and h1, with no back arrow", () => {
    // Skills sits in the nav like Agents or Memory. A back arrow to `/` took
    // the icon tile's place and made it the one top-level page that looked
    // like a sub-page.
    renderHeader({ totalCount: 5, filteredCount: 5 })
    expect(screen.queryByRole("link", { name: "back" })).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument()
  })

  it("drops both when a host already owns the identity and the way back", () => {
    // Embedded in the Settings shell or /me/skills, that back arrow sat
    // beside the host's and pointed at `/`, so the control that looked like
    // "up one level" left Settings altogether, and the page carried two h1s.
    renderHeader({ totalCount: 5, filteredCount: 5, embedded: true })
    expect(screen.queryByRole("link", { name: "back" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument()
  })

  it("renders the localized title, description and count", () => {
    renderHeader({ totalCount: 5, filteredCount: 5 })
    expect(screen.getByText("panel.headerTitle")).toBeInTheDocument()
    expect(screen.getByText("panel.headerDescription")).toBeInTheDocument()
    expect(screen.getByText('panel.headerSubtitle:{"count":5}')).toBeInTheDocument()
  })

  it("shows ratio instead of count when filtered count differs", () => {
    renderHeader({ totalCount: 10, filteredCount: 3 })
    expect(screen.getByText("3/10")).toBeInTheDocument()
  })

  it("exposes a category navigator trigger with a localized aria-label on My Skills tab", () => {
    renderHeader()
    expect(screen.getByLabelText("panel.openCategoriesAria")).toBeInTheDocument()
  })

  it("does not draw the category trigger with the page's own identity glyph", () => {
    // Two layers icons side by side read as a rendering glitch on a phone.
    renderHeader()
    const trigger = screen.getByLabelText("panel.openCategoriesAria")
    expect(trigger.querySelector(".lucide-layers")).toBeNull()
    expect(trigger.querySelector(".lucide-layout-list")).not.toBeNull()
  })

  it("hides the category trigger when not on the My Skills tab", () => {
    useSkillsStore.setState({ activeTab: "browse" } as never)
    renderHeader()
    expect(screen.queryByLabelText("panel.openCategoriesAria")).not.toBeInTheDocument()
  })

  it("opens the category sheet via the store when the trigger is clicked", () => {
    renderHeader()
    fireEvent.click(screen.getByLabelText("panel.openCategoriesAria"))
    expect(useSkillsStore.getState().categorySheetOpen).toBe(true)
  })

  // The filter entry lives in the list pane, beside the selects it extends; in
  // the header it sat among the page actions and was a second "filter" control.
  it("leaves filtering to the list pane", () => {
    renderHeader()
    expect(screen.queryByLabelText("filters")).not.toBeInTheDocument()
  })

  // The search input lives in SkillListPane (it owns [data-skill-search],
  // which the `/` shortcut focuses).
  it("does not render a search input", () => {
    renderHeader()
    expect(document.querySelector("[data-skill-search]")).toBeNull()
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument()
  })

  describe("tabs", () => {
    it("draws the four panel tabs in the view bar", () => {
      renderHeader()
      const tabs = screen.getAllByRole("tab")
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        "mySkills",
        "browse",
        "editor",
        "analytics",
      ])
      expect(tabs[0].closest('[data-slot="feature-header-view-bar"]')).not.toBeNull()
      expect(screen.getByTestId("panel-tab-my-skills")).toHaveAttribute("data-state", "active")
    })

    it("writes the new active tab to the store on click", async () => {
      // Radix Tabs listens on the full pointer-down → click sequence, which
      // fireEvent.click alone does not produce in jsdom.
      const user = userEvent.setup()
      renderHeader()
      await user.click(screen.getByRole("tab", { name: /browse/ }))
      expect(useSkillsStore.getState().activeTab).toBe("browse")
    })

    it("counts unsaved editor files on the editor tab", () => {
      useSkillsStore.setState({
        editorWorkspace: {
          activeSkillId: "s1",
          openFiles: [
            {
              id: "main",
              kind: "main",
              path: "SKILL.md",
              language: "markdown",
              draftContent: "dirty",
              savedContent: "clean",
            },
          ],
          activeFileId: "main",
          rightPaneOpen: true,
        },
      } as never)
      renderHeader()
      expect(screen.getByTestId("panel-tab-editor")).toHaveTextContent("editor1")
      expect(screen.getByTestId("panel-tab-my-skills")).toHaveTextContent(/^mySkills$/)
    })
  })

  describe("actions", () => {
    it("mounts the Import menu and the preferences popover on every tab", () => {
      useSkillsStore.setState({ activeTab: "analytics" } as never)
      renderHeader()
      const strip = screen.getByTestId("feature-header-actions")
      expect(within(strip).getByTestId("import-stub")).toBeInTheDocument()
      expect(within(strip).getByTestId("prefs-stub")).toBeInTheDocument()
    })

    it("draws New as the primary button, last in the strip", () => {
      renderHeader()
      const strip = screen.getByTestId("feature-header-actions")
      const last = strip.lastElementChild as HTMLElement
      expect(last).toHaveAttribute("data-testid", "toolbar-new")
      fireEvent.click(last)
      expect(mockCreate).toHaveBeenCalled()
    })

    it("shows Record as a button and folds the occasional actions into More actions", () => {
      renderHeader()
      expect(screen.getByRole("button", { name: "record" })).toBeInTheDocument()
      expect(screen.queryByText("exportAll")).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: "moreActions" })).toBeInTheDocument()
    })
  })
})
