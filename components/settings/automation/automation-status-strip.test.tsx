/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"
import { defaultAutomationSettings, type AutomationSettings } from "@/lib/automation/client"
import type { AutomationSettingsValue } from "./automation-settings-context"

const ctx: { current: Partial<AutomationSettingsValue> } = { current: {} }
jest.mock("./automation-settings-context", () => ({
  useAutomationSettings: () => ctx.current,
}))

import { AutomationStatusStrip, engineStateOf } from "./automation-status-strip"

const setEnabled = jest.fn()
const engageKillSwitch = jest.fn()

function mount(
  settings: AutomationSettings | null,
  {
    killSwitchEngaged = false,
    permissions,
  }: {
    killSwitchEngaged?: boolean
    permissions?: Parameters<typeof AutomationStatusStrip>[0]["host"]["permissions"]
  } = {}
) {
  ctx.current = {
    settings,
    loading: false,
    saving: false,
    killSwitchEngaged,
    setEnabled,
    engageKillSwitch,
  }
  const onNavigate = jest.fn()
  render(<AutomationStatusStrip host={{ permissions }} onNavigate={onNavigate} />)
  return { onNavigate }
}

const OK_PERMISSIONS = {
  accessibility: "ok",
  screenRecording: "ok",
  uiAutomation: "notApplicable",
} as const

beforeEach(() => {
  setEnabled.mockReset()
  engageKillSwitch.mockReset()
})

describe("engineStateOf", () => {
  it("lets the kill switch win over the persisted flag", () => {
    expect(engineStateOf(true, true)).toBe("stopped")
    expect(engineStateOf(false, true)).toBe("stopped")
    expect(engineStateOf(true, false)).toBe("running")
    expect(engineStateOf(false, false)).toBe("off")
  })
})

describe("AutomationStatusStrip", () => {
  it("shows a skeleton until settings arrive", () => {
    mount(null)
    expect(screen.getByTestId("automation-status-loading")).toBeInTheDocument()
  })

  it("offers a one-click emergency stop while running, without a confirmation", async () => {
    mount({ ...defaultAutomationSettings(), enabled: true }, { permissions: OK_PERMISSIONS })
    expect(screen.getByTestId("automation-engine-state")).toHaveTextContent(
      en.automation.status.engine.running
    )
    await userEvent.click(screen.getByTestId("automation-kill-switch"))
    expect(engageKillSwitch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("disables the emergency stop when nothing is running", () => {
    mount(defaultAutomationSettings())
    expect(screen.getByTestId("automation-kill-switch")).toBeDisabled()
  })

  it("shows the switch off while the kill switch holds, so switching on resumes", async () => {
    mount({ ...defaultAutomationSettings(), enabled: true }, { killSwitchEngaged: true })
    expect(screen.getByTestId("automation-status-strip")).toHaveAttribute("data-engine", "stopped")
    const toggle = screen.getByRole("switch", { name: en.automation.status.engineToggle })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(setEnabled).toHaveBeenCalledWith(true)
  })

  it("points at the overview when an OS permission is missing", async () => {
    const { onNavigate } = mount(defaultAutomationSettings(), {
      permissions: { ...OK_PERMISSIONS, screenRecording: "missing" },
    })
    await userEvent.click(screen.getByTestId("automation-permissions-missing"))
    expect(onNavigate).toHaveBeenCalledWith("overview")
  })

  it("says the permissions are ready when nothing is missing", () => {
    mount(defaultAutomationSettings(), { permissions: OK_PERMISSIONS })
    expect(screen.getByTestId("automation-permissions-ready")).toHaveTextContent(
      en.automation.status.permissionsReady
    )
  })

  it("claims nothing about permissions while the probe is still running", () => {
    mount(defaultAutomationSettings(), { permissions: undefined })
    expect(screen.queryByTestId("automation-permissions-ready")).not.toBeInTheDocument()
    expect(screen.queryByTestId("automation-permissions-missing")).not.toBeInTheDocument()
  })
})
