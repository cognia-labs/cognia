/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${vars.name}` : key,
}))
jest.mock("@/lib/db/projects", () => ({
  getAllProjects: jest.fn(async () => []),
  loadActiveProjectId: jest.fn(async () => null),
  putProject: jest.fn(async () => undefined),
  deleteProjectRow: jest.fn(async () => undefined),
  persistActiveProjectId: jest.fn(async () => undefined),
}))
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchProjectSwitch: jest.fn() }),
}))
// The list and its dialogs are covered by their own suite. Stubbed here so this
// one stays about the chip becoming a real trigger.
const pickerRender = jest.fn()
const pickerDialogsHook = jest.fn()
jest.mock("@/components/workspace/workspace-picker-list", () => ({
  useWorkspacePickerDialogs: () => pickerDialogsHook(),
  useWorkspacePickerRequests: () => ({
    openFolder: jest.fn(),
    newWorkspace: jest.fn(),
    adopt: jest.fn(),
    manage: jest.fn(),
    canOpenFolder: true,
  }),
  WorkspacePickerList: (props: { density?: string; onSwitched?: () => void }) => {
    pickerRender(props)
    return (
      <button type="button" data-testid="picker-list" onClick={() => props.onSwitched?.()}>
        list
      </button>
    )
  },
}))

import { MobileWorkspaceChip } from "./mobile-workspace-chip"
import { useProjectStore } from "@/stores/project/project-store"

beforeEach(() => {
  pickerRender.mockClear()
  act(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  })
})

it("renders nothing when no workspace is active", () => {
  const { container } = render(<MobileWorkspaceChip />)
  expect(container).toBeEmptyDOMElement()
})

it("shows the active workspace name", () => {
  act(() => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Backend", roots: [] } as never],
      activeProjectId: "p1",
    })
  })
  render(<MobileWorkspaceChip />)
  expect(screen.getByTestId("mobile-workspace-chip")).toHaveTextContent("Backend")
})

it("drops the visible name on the narrowest phones but keeps it in the label", () => {
  act(() => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Backend", roots: [] } as never],
      activeProjectId: "p1",
    })
  })
  render(<MobileWorkspaceChip />)
  // Icon-only below 26rem, so the conversation title keeps the room.
  expect(screen.getByTestId("mobile-workspace-chip-name")).toHaveClass(
    "hidden",
    "min-[26rem]:inline-block"
  )
  expect(screen.getByTestId("mobile-workspace-chip").getAttribute("aria-label")).toContain(
    "Backend"
  )
})

it("draws as one of the app bar's 44px ghost icon buttons, not a muted pill", () => {
  act(() => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Backend", roots: [] } as never],
      activeProjectId: "p1",
    })
  })
  render(<MobileWorkspaceChip />)
  const chip = screen.getByTestId("mobile-workspace-chip")
  expect(chip).toHaveClass("h-11", "min-w-11", "hover:bg-accent")
  expect(chip).not.toHaveClass("bg-muted/60", "text-[10px]")
})

describe('variant="title" (the home screen\'s app-bar title)', () => {
  it("always shows the name, capped so a long one truncates", () => {
    act(() => {
      useProjectStore.setState({
        projects: [{ id: "p1", name: "cognia-next-monorepo-workspace", roots: [] } as never],
        activeProjectId: "p1",
      })
    })
    render(<MobileWorkspaceChip variant="title" />)
    const chip = screen.getByTestId("mobile-workspace-chip")
    expect(chip).toHaveAttribute("data-variant", "title")
    expect(chip).toHaveClass("min-w-0", "font-medium")
    const name = screen.getByTestId("mobile-workspace-chip-name")
    expect(name).toHaveTextContent("cognia-next-monorepo-workspace")
    expect(name).toHaveClass("truncate", "max-w-48", "min-w-0")
    expect(name).not.toHaveClass("hidden")
    // The full name stays readable to assistive tech whatever the truncation.
    expect(chip.getAttribute("aria-label")).toContain("cognia-next-monorepo-workspace")
  })

  it("renders its fallback when no workspace is active", () => {
    render(<MobileWorkspaceChip variant="title" fallback={<h1 data-testid="brand">Cognia</h1>} />)
    expect(screen.getByTestId("brand")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-workspace-chip")).toBeNull()
  })

  it("leaves the icon variant as it was", () => {
    act(() => {
      useProjectStore.setState({
        projects: [{ id: "p1", name: "Backend", roots: [] } as never],
        activeProjectId: "p1",
      })
    })
    render(<MobileWorkspaceChip />)
    expect(screen.getByTestId("mobile-workspace-chip")).toHaveAttribute("data-variant", "icon")
  })
})

function activateWorkspace() {
  act(() => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Backend", roots: [] } as never],
      activeProjectId: "p1",
    })
  })
}

it("opens the same picker the desktop popover uses, at touch density", () => {
  // The chip used to be an inert span whose comment said remote switching was
  // deferred, while the real switcher sat two layers deep in the nav Sheet as a
  // 40px icon. The name in the header is the switcher now.
  activateWorkspace()
  render(<MobileWorkspaceChip />)

  fireEvent.click(screen.getByTestId("mobile-workspace-chip"))

  expect(screen.getByTestId("picker-list")).toBeInTheDocument()
  expect(pickerRender).toHaveBeenCalledWith(
    expect.objectContaining({ density: "comfortable" })
  )
})

it("closes the drawer once a workspace is chosen", () => {
  activateWorkspace()
  render(<MobileWorkspaceChip />)
  fireEvent.click(screen.getByTestId("mobile-workspace-chip"))

  fireEvent.click(screen.getByTestId("picker-list"))

  expect(screen.queryByTestId("picker-list")).not.toBeInTheDocument()
})

it("leaves the dialogs to the shell's host rather than mounting its own", () => {
  // A dialog owned by the drawer content would be torn down by the same close
  // that asked to open it, so the chip's actions are requests to
  // `WorkspaceDialogHost`, which the mobile shell mounts outside every drawer.
  activateWorkspace()
  render(<MobileWorkspaceChip />)

  expect(pickerDialogsHook).not.toHaveBeenCalled()
  expect(screen.queryByTestId("picker-list")).not.toBeInTheDocument()
})
