import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button data-testid="sidebar-trigger" />,
}))

let hostState = { suspended: false, onlyWhileOpen: false }

jest.mock("./scheduler-host-popover", () => ({
  SchedulerHostPopover: () => <div data-testid="host-popover" />,
  SchedulerHostSummaryLine: ({ summary }: { summary: { label: string } }) => (
    <span data-testid="host-summary">{summary.label}</span>
  ),
  useSchedulerHostSummary: () => ({
    target: "local",
    label: "this device",
    pairedAvailable: false,
    ...hostState,
    pairedLabel: "",
    setTarget: jest.fn(),
  }),
}))

import { SchedulerPageHeader, type SchedulerPageHeaderProps } from "./scheduler-page-header"

function props(over: Partial<SchedulerPageHeaderProps> = {}): SchedulerPageHeaderProps {
  return {
    schedulerStatus: "running",
    onCreate: jest.fn(),
    onCreateSystemTask: jest.fn(),
    onCreateWorkflowTrigger: jest.fn(),
    onOpenBackupSettings: jest.fn(),
    onOpenPluginSettings: jest.fn(),
    onRefresh: jest.fn(),
    onExport: jest.fn(),
    onImport: jest.fn(),
    onOpenTemplates: jest.fn(),
    onCleanup: jest.fn(),
    ...over,
  }
}

/** `TooltipProvider` is mounted once at the app root; the refresh glyph's tooltip needs it. */
function renderHeader(p: SchedulerPageHeaderProps) {
  return render(
    <TooltipProvider>
      <SchedulerPageHeader {...p} />
    </TooltipProvider>
  )
}

describe("SchedulerPageHeader", () => {
  beforeEach(() => {
    hostState = { suspended: false, onlyWhileOpen: false }
  })

  it("names the host, the scheduler state, and carries the popover and list trigger", () => {
    renderHeader(props())
    expect(screen.getByTestId("host-summary")).toHaveTextContent("this device")
    const status = screen.getByTestId("scheduler-status-badge")
    expect(status).toHaveTextContent("Running")
    expect(status).toHaveAttribute("data-slot", "feature-header-status")
    expect(status).toHaveAttribute("data-tone", "success")
    expect(screen.getByTestId("host-popover")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-trigger")).toBeInTheDocument()
  })

  it("puts the host popover beside refresh rather than in a row of its own", () => {
    renderHeader(props())
    const popover = screen.getByTestId("host-popover")
    expect(popover.parentElement).toContainElement(screen.getByTestId("scheduler-refresh-button"))
    expect(document.querySelector('[data-slot="feature-header-view-bar"]')).toBeNull()
  })

  it("can omit the list trigger and says when the scheduler is stopped", () => {
    renderHeader(props({ schedulerStatus: "stopped", showListTrigger: false }))
    expect(screen.queryByTestId("sidebar-trigger")).not.toBeInTheDocument()
    expect(screen.getByTestId("scheduler-status-badge")).toHaveTextContent("Scheduler stopped")
    expect(screen.getByTestId("scheduler-status-badge")).toHaveAttribute("data-tone", "warning")
  })

  it("keeps one status chip and says a suspended local schedule after the description", () => {
    hostState = { suspended: true, onlyWhileOpen: false }
    renderHeader(props())
    expect(document.querySelectorAll('[data-slot="feature-header-status"]')).toHaveLength(1)
    expect(screen.getByTestId("scheduler-host-suspended")).toHaveTextContent(
      "suspended — taken over by the cloud host"
    )
    expect(screen.getByText("Manage automated tasks and workflows")).toBeInTheDocument()
  })

  it("says when the local schedule only ticks while the app is open", () => {
    hostState = { suspended: false, onlyWhileOpen: true }
    renderHeader(props())
    expect(screen.getByTestId("scheduler-host-only-open")).toHaveTextContent(
      "runs only while this app is open"
    )
  })

  it("spins and blocks the refresh glyph while a refresh runs", () => {
    renderHeader(props({ isRefreshing: true }))
    expect(screen.getByTestId("scheduler-refresh-button")).toBeDisabled()
    expect(screen.getByTestId("scheduler-refresh-button")).toHaveAccessibleName("Refresh")
  })

  it("creates, refreshes, and offers every kind in the split menu", async () => {
    const user = userEvent.setup()
    const p = props()
    renderHeader(p)
    fireEvent.click(screen.getByTestId("scheduler-new-task-button"))
    expect(p.onCreate).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("scheduler-refresh-button"))
    expect(p.onRefresh).toHaveBeenCalled()
    await user.click(screen.getByTestId("scheduler-new-task-button-menu"))
    // System tasks are their own group: a rule sits right above the item.
    const system = await screen.findByTestId("scheduler-new-system-task")
    expect(system.previousElementSibling).toHaveAttribute("role", "separator")
    await user.click(system)
    expect(p.onCreateSystemTask).toHaveBeenCalled()
    await user.click(screen.getByTestId("scheduler-new-task-button-menu"))
    await user.click(await screen.findByTestId("scheduler-new-workflow-trigger"))
    expect(p.onCreateWorkflowTrigger).toHaveBeenCalled()
  })

  it("hides a kind whose creation path is absent", async () => {
    const user = userEvent.setup()
    renderHeader(props({ onCreateSystemTask: undefined, onOpenBackupSettings: undefined }))
    await user.click(screen.getByTestId("scheduler-new-task-button-menu"))
    expect(await screen.findByTestId("scheduler-new-workflow-trigger")).toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-new-system-task")).not.toBeInTheDocument()
    expect(screen.queryByTestId("scheduler-open-backup-settings")).not.toBeInTheDocument()
  })

  it("keeps templates, export, import and cleanup behind the overflow", async () => {
    const user = userEvent.setup()
    const p = props()
    renderHeader(p)
    await user.click(screen.getByRole("button", { name: "More options" }))
    await user.click(await screen.findByRole("menuitem", { name: /Export Tasks/ }))
    expect(p.onExport).toHaveBeenCalled()
  })
})
