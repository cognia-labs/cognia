/**
 * @jest-environment jsdom
 *
 * The section-wide settings provider. What it must guarantee: every write is
 * a read-modify-write against the host's current settings (so a panel can
 * never put back an `enabled` flag the status strip already changed), writes
 * are serialized, a failed write falls back to what the host holds, and the
 * master switch goes through `setEnabled`, never through a bulk save.
 */

import { useEffect } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"

const settingsGet = jest.fn()
const settingsSet = jest.fn()
const setEnabled = jest.fn()
const killSwitch = jest.fn()
const killSwitchEngaged = jest.fn()
jest.mock("@/lib/automation/client", () => {
  const actual =
    jest.requireActual<typeof import("@/lib/automation/client")>("@/lib/automation/client")
  return {
    ...actual,
    desktop: {
      settingsGet: (...a: unknown[]) => settingsGet(...a),
      settingsSet: (...a: unknown[]) => settingsSet(...a),
      setEnabled: (...a: unknown[]) => setEnabled(...a),
      killSwitch: (...a: unknown[]) => killSwitch(...a),
      killSwitchEngaged: (...a: unknown[]) => killSwitchEngaged(...a),
    },
  }
})

const listeners = new Map<string, () => void>()
const unlisten = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
  transport: {
    subscribe: jest.fn((event: string, cb: () => void) => {
      listeners.set(event, cb)
      return unlisten
    }),
  },
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}))

import { defaultAutomationSettings, type AutomationSettings } from "@/lib/automation/client"
import { isTauri } from "@/lib/tauri"

import {
  AutomationSettingsProvider,
  KILL_SWITCH_EVENT,
  useAutomationSettings,
  type AutomationSettingsValue,
} from "./automation-settings-context"

let latest: AutomationSettingsValue | null = null

function Probe() {
  const value = useAutomationSettings()
  // Handed out from an effect: assigning a module variable during render is a
  // side effect the React Compiler lint rejects.
  useEffect(() => {
    latest = value
  })
  return (
    <div>
      <span data-testid="enabled">{String(value.settings?.enabled)}</span>
      <span data-testid="tier">{value.settings?.defaultTier ?? "none"}</span>
      <span data-testid="engaged">{String(value.killSwitchEngaged)}</span>
      <span data-testid="saving">{String(value.saving)}</span>
    </div>
  )
}

function renderProvider() {
  return render(
    <AutomationSettingsProvider>
      <Probe />
    </AutomationSettingsProvider>
  )
}

function host(over: Partial<AutomationSettings> = {}): AutomationSettings {
  return { ...defaultAutomationSettings(), ...over }
}

beforeEach(() => {
  latest = null
  listeners.clear()
  unlisten.mockReset()
  ;(isTauri as jest.Mock).mockReturnValue(true)
  settingsGet.mockReset().mockResolvedValue(host())
  settingsSet.mockReset().mockResolvedValue(undefined)
  setEnabled.mockReset().mockResolvedValue(undefined)
  killSwitch.mockReset().mockResolvedValue(undefined)
  killSwitchEngaged.mockReset().mockResolvedValue(false)
  jest.mocked(toast.error).mockReset()
  jest.mocked(toast.warning).mockReset()
})

describe("AutomationSettingsProvider", () => {
  it("loads the host settings and kill-switch state once mounted", async () => {
    killSwitchEngaged.mockResolvedValue(true)
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("tier")).toHaveTextContent("off"))
    expect(screen.getByTestId("engaged")).toHaveTextContent("true")
  })

  it("applies an edit to what the host holds now, not to its own snapshot", async () => {
    renderProvider()
    await waitFor(() => expect(screen.getByTestId("enabled")).toHaveTextContent("false"))
    // The engine was switched on elsewhere after this provider loaded.
    settingsGet.mockResolvedValue(host({ enabled: true }))
    await act(() => latest!.update((current) => ({ ...current, defaultTier: "perCall" })))
    expect(settingsSet).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, defaultTier: "perCall" })
    )
    expect(screen.getByTestId("tier")).toHaveTextContent("perCall")
  })

  it("serializes writes so two edits never race on one read", async () => {
    renderProvider()
    await waitFor(() => expect(latest?.settings).not.toBeNull())
    const gate = Promise.withResolvers<void>()
    let stored = host()
    settingsGet.mockImplementation(async () => stored)
    settingsSet.mockImplementation(async (next: AutomationSettings) => {
      await gate.promise
      stored = next
    })
    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = latest!.update((current) => ({ ...current, defaultTier: "whitelist" }))
      second = latest!.update((current) => ({ ...current, pasteThresholdChars: 7 }))
    })
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("saving")).toHaveTextContent("true")
    await act(async () => {
      gate.resolve()
      await first
      await second
    })
    expect(stored).toMatchObject({ defaultTier: "whitelist", pasteThresholdChars: 7 })
    expect(screen.getByTestId("saving")).toHaveTextContent("false")
  })

  it("puts back the host's settings and reports when a write fails", async () => {
    renderProvider()
    await waitFor(() => expect(latest?.settings).not.toBeNull())
    settingsSet.mockRejectedValueOnce(new Error("WRITE_FAILED"))
    await act(() => latest!.update((current) => ({ ...current, defaultTier: "whitelist" })))
    expect(toast.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ description: "WRITE_FAILED" })
    )
    expect(screen.getByTestId("tier")).toHaveTextContent("off")
  })

  it("routes the master switch through setEnabled, never a bulk save", async () => {
    renderProvider()
    await waitFor(() => expect(latest?.settings).not.toBeNull())
    settingsGet.mockResolvedValue(host({ enabled: true }))
    await act(() => latest!.setEnabled(true))
    expect(setEnabled).toHaveBeenCalledWith(true)
    expect(settingsSet).not.toHaveBeenCalled()
    expect(screen.getByTestId("enabled")).toHaveTextContent("true")
  })

  it("engages the kill switch and re-reads the host state", async () => {
    renderProvider()
    await waitFor(() => expect(latest?.settings).not.toBeNull())
    killSwitchEngaged.mockResolvedValue(true)
    await act(() => latest!.engageKillSwitch())
    expect(killSwitch).toHaveBeenCalledTimes(1)
    expect(toast.warning).toHaveBeenCalled()
    expect(screen.getByTestId("engaged")).toHaveTextContent("true")
  })

  it("follows a kill switch pulled from the tray or the hotkey", async () => {
    renderProvider()
    await waitFor(() => expect(listeners.has(KILL_SWITCH_EVENT)).toBe(true))
    killSwitchEngaged.mockResolvedValue(true)
    await act(async () => listeners.get(KILL_SWITCH_EVENT)!())
    await waitFor(() => expect(screen.getByTestId("engaged")).toHaveTextContent("true"))
  })

  it("stops listening when unmounted", async () => {
    const { unmount } = renderProvider()
    await waitFor(() => expect(listeners.has(KILL_SWITCH_EVENT)).toBe(true))
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it("reads nothing off the desktop shell", () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    renderProvider()
    expect(settingsGet).not.toHaveBeenCalled()
    expect(latest?.loading).toBe(false)
    expect(latest?.settings).toBeNull()
  })

  it("refuses to be read outside the provider", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/AutomationSettingsProvider/)
    spy.mockRestore()
  })
})
