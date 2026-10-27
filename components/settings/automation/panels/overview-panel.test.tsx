/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"
import { defaultAutomationSettings, type AutomationSettings } from "@/lib/automation/client"
import type { AutomationHostStatus } from "@/hooks/automation/use-automation-host-status"
import type { AutomationSettingsValue } from "../automation-settings-context"

const ctx: { current: Partial<AutomationSettingsValue> } = { current: {} }
jest.mock("../automation-settings-context", () => ({
  useAutomationSettings: () => ctx.current,
}))

const listAuditRows = jest.fn()
jest.mock("@/lib/automation/audit", () => ({
  listAuditRows: (...a: unknown[]) => listAuditRows(...a),
}))

const repair = jest.fn()
jest.mock("@/lib/tauri/selection-toolbar", () => ({
  repairSelectionToolbarPermission: (...a: unknown[]) => repair(...a),
}))

import { OverviewPanel, setupGaps } from "./overview-panel"

const setEnabled = jest.fn()

function hostStatus(over: Partial<AutomationHostStatus> = {}): AutomationHostStatus {
  return {
    caps: { platform: "macos" } as AutomationHostStatus["caps"],
    permissions: { accessibility: "ok", screenRecording: "ok", uiAutomation: "notApplicable" },
    initFailure: null,
    dismissInitFailure: jest.fn(),
    refreshPermissions: jest.fn().mockResolvedValue(undefined),
    ...over,
  }
}

function running(over: Partial<AutomationSettings> = {}): AutomationSettings {
  return { ...defaultAutomationSettings(), enabled: true, defaultTier: "perCall", ...over }
}

function mount(settings: AutomationSettings, host = hostStatus(), killSwitchEngaged = false) {
  ctx.current = { settings, killSwitchEngaged, setEnabled, saving: false }
  const onNavigate = jest.fn()
  render(<OverviewPanel host={host} onNavigate={onNavigate} />)
  return { onNavigate }
}

beforeEach(() => {
  setEnabled.mockReset()
  repair.mockReset()
  listAuditRows.mockReset().mockResolvedValue([])
})

describe("setupGaps", () => {
  it("is empty for a running, permitted, healthy host", () => {
    expect(setupGaps(hostStatus(), running(), false)).toEqual([])
  })

  it("orders gaps from most to least blocking", () => {
    const gaps = setupGaps(
      hostStatus({
        initFailure: { platform: "macos", error: "x" },
        permissions: {
          accessibility: "missing",
          screenRecording: "ok",
          uiAutomation: "notApplicable",
        },
        caps: null,
      }),
      defaultAutomationSettings(),
      true
    )
    expect(gaps.map((gap) => gap.kind)).toEqual([
      "initFailure",
      "engine",
      "permission",
      "capabilities",
      "allDenied",
    ])
    expect(gaps[1]).toEqual({ kind: "engine", state: "stopped" })
  })

  it("does not call a source denied when it only follows a permissive default", () => {
    const gaps = setupGaps(hostStatus(), running({ defaultTier: "whitelist" }), false)
    expect(gaps).toEqual([])
  })
})

describe("OverviewPanel", () => {
  it("says the machine is ready when nothing blocks automation", () => {
    mount(running())
    expect(screen.getByTestId("automation-setup-checklist")).toHaveTextContent(
      en.automation.overview.setup.readyDescription
    )
    expect(screen.queryByTestId("automation-setup-gaps")).not.toBeInTheDocument()
  })

  it("resumes the engine from the checklist", async () => {
    mount(running({ enabled: false }), hostStatus(), true)
    await userEvent.click(screen.getByTestId("automation-setup-enable"))
    expect(setEnabled).toHaveBeenCalledWith(true)
  })

  it("opens the matching System Settings pane for a missing macOS permission", async () => {
    mount(
      running(),
      hostStatus({
        permissions: {
          accessibility: "ok",
          screenRecording: "missing",
          uiAutomation: "notApplicable",
        },
      })
    )
    const gaps = screen.getByTestId("automation-setup-gaps")
    await userEvent.click(
      within(gaps).getByRole("button", { name: en.automation.overview.setup.openSystemSettings })
    )
    expect(repair).toHaveBeenCalledWith("screenRecording")
  })

  it("summarises the last day of activity and links to the audit log", async () => {
    const now = Date.now()
    listAuditRows.mockResolvedValue([
      { ts: now - 1000, decision: "deny", command: "type" },
      { ts: now - 2000, decision: "allow", command: "screenshot" },
    ])
    const { onNavigate } = mount(running())
    await waitFor(() =>
      expect(screen.getByTestId("automation-top-failing")).toHaveTextContent("type")
    )
    await userEvent.click(
      within(screen.getByTestId("automation-activity")).getByRole("button", {
        name: new RegExp(en.automation.overview.metrics.openAudit),
      })
    )
    expect(onNavigate).toHaveBeenCalledWith("audit")
  })

  it("shows each source's effective tier and links to the panel that changes it", async () => {
    const { onNavigate } = mount(running({ defaultTier: "whitelist" }))
    const summary = screen.getByTestId("automation-policy-summary")
    expect(within(summary).getAllByText("Whitelist (default)").length).toBe(4)
    await userEvent.click(
      within(summary).getByRole("button", { name: en.automation.overview.policy.admitEmpty })
    )
    expect(onNavigate).toHaveBeenCalledWith("accessRules")
  })

  it("sends people looking for sandboxes to this device in Devices", () => {
    mount(running())
    expect(screen.getByTestId("automation-sandbox-link")).toHaveAttribute(
      "href",
      "/devices?device=local&deviceSection=sandbox"
    )
  })
})
