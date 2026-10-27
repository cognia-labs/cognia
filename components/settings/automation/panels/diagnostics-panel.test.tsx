/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"
import type { AutomationHostStatus } from "@/hooks/automation/use-automation-host-status"

const mockBackend = { value: "macos-cgvirtualdisplay", installed: true, error: "" }

jest.mock("@/hooks/automation/use-virtual-display-health", () => ({
  useVirtualDisplayHealth: () => ({
    health: {
      available: !mockBackend.error,
      installed: mockBackend.installed,
      backend: mockBackend.value,
      driverVersion: "1",
      activeMonitor: "",
      lastError: mockBackend.error,
    },
    refresh: jest.fn(),
    error: null,
  }),
}))

const repair = jest.fn()
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  repairSelectionToolbarPermission: (...a: unknown[]) => repair(...a),
}))

import { DiagnosticsPanel } from "./diagnostics-panel"

function hostStatus(over: Partial<AutomationHostStatus> = {}): AutomationHostStatus {
  return {
    caps: {
      platform: "macos",
      hasUia: false,
      hasA11yTree: true,
      hasInputSim: true,
      hasScreenshot: true,
      hasEvents: false,
      monitors: [],
    } as unknown as AutomationHostStatus["caps"],
    permissions: { accessibility: "ok", screenRecording: "missing", uiAutomation: "notApplicable" },
    initFailure: null,
    dismissInitFailure: jest.fn(),
    refreshPermissions: jest.fn().mockResolvedValue(undefined),
    ...over,
  }
}

beforeEach(() => {
  repair.mockReset()
  mockBackend.value = "macos-cgvirtualdisplay"
  mockBackend.installed = true
  mockBackend.error = ""
})

describe("DiagnosticsPanel", () => {
  it("lists only the permissions this platform uses, with a remedy for a missing one", async () => {
    render(<DiagnosticsPanel host={hostStatus()} onNavigate={jest.fn()} />)
    expect(screen.getByTestId("automation-os-permission-accessibility")).toHaveTextContent(
      en.automation.diagnostics.permissions.state.ok
    )
    expect(screen.queryByTestId("automation-os-permission-uiAutomation")).not.toBeInTheDocument()
    const recording = screen.getByTestId("automation-os-permission-screenRecording")
    await userEvent.click(within(recording).getByRole("button"))
    expect(repair).toHaveBeenCalledWith("screenRecording")
  })

  it("re-probes the permissions on request", async () => {
    const host = hostStatus()
    render(<DiagnosticsPanel host={host} onNavigate={jest.fn()} />)
    await userEvent.click(
      within(screen.getByTestId("automation-os-permissions")).getByRole("button", {
        name: new RegExp(en.automation.diagnostics.permissions.recheck),
      })
    )
    expect(host.refreshPermissions).toHaveBeenCalled()
  })

  it("shows a failed backend start with its error", () => {
    render(
      <DiagnosticsPanel
        host={hostStatus({ initFailure: { platform: "macos", error: "AX unavailable" } })}
        onNavigate={jest.fn()}
      />
    )
    expect(screen.getByTestId("automation-backend-status")).toHaveTextContent("AX unavailable")
  })

  it("shows screen-off health only where a backend exists, linking to Behavior", async () => {
    const { unmount } = render(<DiagnosticsPanel host={hostStatus()} onNavigate={jest.fn()} />)
    expect(screen.getByTestId("automation-screen-off-health")).toHaveTextContent(
      "macos-cgvirtualdisplay"
    )
    unmount()

    const onNavigate = jest.fn()
    const windows = hostStatus({
      caps: { ...hostStatus().caps!, platform: "windows" } as AutomationHostStatus["caps"],
      permissions: {
        accessibility: "notApplicable",
        screenRecording: "notApplicable",
        uiAutomation: "ok",
      },
    })
    mockBackend.value = "windows-parsec-vdd"
    render(<DiagnosticsPanel host={windows} onNavigate={onNavigate} />)
    const block = screen.getByTestId("automation-screen-off-health")
    expect(block).toHaveTextContent("windows-parsec-vdd")
    await userEvent.click(within(block).getByRole("button"))
    expect(onNavigate).toHaveBeenCalledWith("behavior")
  })

  it("says so when the permission probe failed", () => {
    render(<DiagnosticsPanel host={hostStatus({ permissions: null })} onNavigate={jest.fn()} />)
    expect(screen.getByTestId("automation-os-permissions")).toHaveTextContent(
      en.automation.diagnostics.permissions.probeFailed
    )
  })
})

it("reports an unsupported macOS runtime as unavailable rather than installable", () => {
  mockBackend.installed = false
  mockBackend.error = "unsupported: CGVirtualDisplay"
  render(<DiagnosticsPanel host={hostStatus()} onNavigate={jest.fn()} />)
  const block = screen.getByTestId("automation-screen-off-health")
  expect(block).toHaveTextContent(en.automation.screenOff.status.down)
  expect(block).toHaveTextContent("unsupported: CGVirtualDisplay")
})
