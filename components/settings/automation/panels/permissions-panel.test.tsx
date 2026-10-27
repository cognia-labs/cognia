/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import en from "@/i18n/messages/en.json"
import { defaultAutomationSettings, type AutomationSettings } from "@/lib/automation/client"
import type { AutomationSettingsValue } from "../automation-settings-context"

const ctx: { current: Partial<AutomationSettingsValue> } = { current: {} }
jest.mock("../automation-settings-context", () => ({
  useAutomationSettings: () => ctx.current,
}))

const plugins: Record<string, unknown> = {}
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: { getState: () => ({ plugins }) },
}))

import { PermissionsPanel, effectiveTier } from "./permissions-panel"

const update = jest.fn()

function mount(settings: AutomationSettings) {
  ctx.current = { settings, saving: false, update }
  const onNavigate = jest.fn()
  render(<PermissionsPanel onNavigate={onNavigate} />)
  return { onNavigate }
}

/** Run the mutator the panel handed to `update` against `base`. */
function applied(base: AutomationSettings, call = 0): AutomationSettings {
  const mutate = update.mock.calls[call][0] as (s: AutomationSettings) => AutomationSettings
  return mutate(base)
}

beforeEach(() => {
  update.mockReset().mockResolvedValue(undefined)
  for (const key of Object.keys(plugins)) delete plugins[key]
})

// The per-plugin list loads the plugin store with a dynamic import; let it
// settle inside act so its state update does not land after the test.
afterEach(async () => {
  await act(async () => {})
})

function withComputerUsePlugin() {
  plugins["cu"] = {
    status: "enabled",
    manifest: { id: "cognia-computer-use", name: "Computer Use", permissions: ["native:input"] },
  }
  plugins["other"] = {
    status: "enabled",
    manifest: { id: "notes", name: "Notes", permissions: ["storage"] },
  }
}

describe("effectiveTier", () => {
  it("reads a source's off as the default tier, as the Rust gate does", () => {
    const settings = { ...defaultAutomationSettings(), defaultTier: "whitelist" as const }
    expect(effectiveTier(settings, "off")).toBe("whitelist")
    expect(effectiveTier(settings, "perCall")).toBe("perCall")
  })
})

describe("PermissionsPanel", () => {
  it("labels a source's off as following the default, never as Off", () => {
    mount({ ...defaultAutomationSettings(), defaultTier: "whitelist" })
    const control = screen.getByTestId("automation-surface-computerUse-tier")
    expect(control).toHaveTextContent("Default (Whitelist)")
    expect(control).not.toHaveTextContent(/^Off/)
  })

  it("writes the default tier onto the host's current settings", async () => {
    mount(defaultAutomationSettings())
    await userEvent.click(screen.getByTestId("automation-default-tier-perCall"))
    const base = { ...defaultAutomationSettings(), enabled: true }
    expect(applied(base)).toEqual({ ...base, defaultTier: "perCall" })
  })

  it("writes one source's tier without touching the others", async () => {
    mount(defaultAutomationSettings())
    await userEvent.click(screen.getByTestId("automation-surface-mcp-tier-perCall"))
    const next = applied(defaultAutomationSettings())
    expect(next.perSurface.mcp.tier).toBe("perCall")
    expect(next.perSurface.workflow.tier).toBe("off")
  })

  it("warns when a Whitelist tier admits everything for want of rules", async () => {
    const { onNavigate } = mount({ ...defaultAutomationSettings(), defaultTier: "whitelist" })
    expect(screen.getByTestId("automation-whitelist-empty-warning")).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole("button", { name: new RegExp(en.automation.permissions.openAccessRules) })
    )
    expect(onNavigate).toHaveBeenCalledWith("accessRules")
  })

  it("does not warn once an access rule admits something", () => {
    const base = defaultAutomationSettings()
    mount({
      ...base,
      defaultTier: "whitelist",
      whitelist: { processNames: ["notepad.exe"], windowTitlePatterns: [] },
    })
    expect(screen.queryByTestId("automation-whitelist-empty-warning")).not.toBeInTheDocument()
  })

  it("keeps only the copilot surface from the copilot block's write", async () => {
    mount(defaultAutomationSettings())
    await userEvent.click(screen.getByRole("radio", { name: "Allow listed chat apps" }))
    const base = { ...defaultAutomationSettings(), enabled: true, defaultTier: "perCall" as const }
    const next = applied(base)
    expect(next.enabled).toBe(true)
    expect(next.defaultTier).toBe("perCall")
    expect(next.perSurface.chatCopilot.tier).toBe("whitelist")
  })

  it("gives an automation plugin its own tier", async () => {
    withComputerUsePlugin()
    const base = defaultAutomationSettings()
    mount(base)
    await userEvent.click(screen.getByText(en.automation.permissions.perPlugin.title))
    await waitFor(() =>
      expect(screen.getByTestId("automation-plugin-cognia-computer-use")).toBeInTheDocument()
    )
    expect(screen.queryByTestId("automation-plugin-notes")).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId("automation-plugin-cognia-computer-use-tier-perCall"))
    expect(applied(base).perSurface.plugin.perPluginOverrides).toEqual({
      "cognia-computer-use": { tier: "perCall" },
    })
  })

  it("clears a plugin override back to the Plugin source", async () => {
    withComputerUsePlugin()
    const base = defaultAutomationSettings()
    const overridden: AutomationSettings = {
      ...base,
      perSurface: {
        ...base.perSurface,
        plugin: {
          ...base.perSurface.plugin,
          perPluginOverrides: { "cognia-computer-use": { tier: "perCall" } },
        },
      },
    }
    mount(overridden)
    // Opens by itself: an override exists.
    await waitFor(() =>
      expect(screen.getByTestId("automation-plugin-cognia-computer-use")).toBeInTheDocument()
    )
    await userEvent.click(screen.getByTestId("automation-plugin-cognia-computer-use-tier-inherit"))
    expect(applied(overridden).perSurface.plugin.perPluginOverrides).toEqual({})
  })
})
