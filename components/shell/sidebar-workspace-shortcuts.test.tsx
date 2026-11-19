/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import en from "@/i18n/messages/en.json"
import type { Project } from "@/types"

const mockRequestWorkspaceDialog = jest.fn()
jest.mock("@/lib/workspace/workspace-dialog-request", () => ({
  requestWorkspaceDialog: (...args: unknown[]) => mockRequestWorkspaceDialog(...args),
}))

import { useProjectStore } from "@/stores/project/project-store"
import { SidebarWorkspaceShortcuts } from "./sidebar-workspace-shortcuts"

const initialProjectState = useProjectStore.getState()
const at = (day: number) => new Date(Date.UTC(2026, 10, day))
const workspace = (id: string, over: Partial<Project> = {}) =>
  ({ id, name: `${id} workspace`, lastAccessedAt: at(1), ...over }) as Project

const setActiveProject = jest.fn()
const updateProject = jest.fn()

function seed(projects: Project[], activeProjectId: string | null) {
  useProjectStore.setState({ projects, activeProjectId, setActiveProject, updateProject })
}

const renderShortcuts = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SidebarWorkspaceShortcuts />
    </NextIntlClientProvider>
  )

beforeEach(() => {
  jest.clearAllMocks()
  useProjectStore.setState(initialProjectState, true)
})

describe("SidebarWorkspaceShortcuts", () => {
  it("draws nothing when the active workspace is the only one", () => {
    seed([workspace("here")], "here")
    renderShortcuts()
    expect(screen.queryByTestId("sidebar-workspace-shortcuts")).toBeNull()
  })

  it("lists pinned workspaces, then recent ones, without the active one", () => {
    seed(
      [
        workspace("here", { pinned: true, lastAccessedAt: at(9) }),
        workspace("beta", { pinned: true }),
        workspace("alpha", { pinned: true }),
        workspace("old", { lastAccessedAt: at(2) }),
        workspace("new", { lastAccessedAt: at(8) }),
        workspace("archived", { isArchived: true, lastAccessedAt: at(7) }),
      ],
      "here"
    )
    renderShortcuts()
    const group = screen.getByRole("group", { name: "Workspaces" })
    const rows = Array.from(group.querySelectorAll("[data-testid^='sidebar-workspace-']"))
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => /^sidebar-workspace-[a-z]+$/.test(id ?? ""))
    expect(rows).toEqual([
      "sidebar-workspace-alpha",
      "sidebar-workspace-beta",
      "sidebar-workspace-new",
      "sidebar-workspace-old",
    ])
    expect(screen.getByTestId("sidebar-workspace-alpha-pinned")).toBeInTheDocument()
    expect(screen.queryByTestId("sidebar-workspace-new-pinned")).toBeNull()
  })

  it("switches to a workspace on click, the way the switcher does", () => {
    seed([workspace("here"), workspace("other")], "here")
    renderShortcuts()
    const row = screen.getByTestId("sidebar-workspace-other")
    expect(row).toHaveAttribute("title", "Switch to other workspace")
    // Not a destination: no page-current claim, whatever the row's state.
    expect(row).not.toHaveAttribute("aria-current")
    fireEvent.click(row)
    expect(setActiveProject).toHaveBeenCalledWith("other")
  })

  it("pins a recent workspace from its context menu", () => {
    seed([workspace("here"), workspace("other")], "here")
    renderShortcuts()
    fireEvent.contextMenu(screen.getByTestId("sidebar-workspace-other"))
    const toggle = screen.getByTestId("sidebar-workspace-other-toggle-pin")
    expect(toggle).toHaveTextContent("Pin other workspace")
    fireEvent.click(toggle)
    expect(updateProject).toHaveBeenCalledWith("other", { pinned: true })
  })

  it("unpins a pinned workspace and opens it in the manager from its context menu", () => {
    seed([workspace("here"), workspace("other", { pinned: true })], "here")
    renderShortcuts()
    fireEvent.contextMenu(screen.getByTestId("sidebar-workspace-other"))
    const toggle = screen.getByTestId("sidebar-workspace-other-toggle-pin")
    expect(toggle).toHaveTextContent("Unpin other workspace")
    fireEvent.click(toggle)
    expect(updateProject).toHaveBeenCalledWith("other", { pinned: false })

    fireEvent.contextMenu(screen.getByTestId("sidebar-workspace-other"))
    fireEvent.click(screen.getByTestId("sidebar-workspace-other-manage"))
    expect(mockRequestWorkspaceDialog).toHaveBeenCalledWith("manage", { workspaceId: "other" })
  })
})
