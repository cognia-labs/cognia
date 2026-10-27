/**
 * @jest-environment jsdom
 *
 * Tests for the Behavior blocks (Settings → UI Automation → Behavior), mounted
 * inside the real `AutomationSettingsProvider` with `desktop.*` mocked. The
 * next-intl jest mock resolves real English strings so queries use accessible
 * names.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"

const settingsGet = jest.fn()
const settingsSet = jest.fn()
jest.mock("@/lib/automation/client", () => {
  const actual =
    jest.requireActual<typeof import("@/lib/automation/client")>("@/lib/automation/client")
  return {
    ...actual,
    desktop: {
      settingsGet: (...a: unknown[]) => settingsGet(...a),
      settingsSet: (...a: unknown[]) => settingsSet(...a),
      killSwitchEngaged: () => Promise.resolve(false),
    },
  }
})

jest.mock("@/lib/tauri", () => ({
  isTauri: () => true,
  transport: { subscribe: () => () => {} },
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() },
}))

import { defaultAutomationSettings, type AutomationSettings } from "@/lib/automation/client"
import { AutomationSettingsProvider } from "./automation-settings-context"
import { BehaviorCard as BehaviorBlocks } from "./behavior-card"

function BehaviorCard() {
  return (
    <AutomationSettingsProvider>
      <BehaviorBlocks />
    </AutomationSettingsProvider>
  )
}

/**
 * The provider re-reads the host before every write, so a host that "keeps"
 * what was written is what makes consecutive edits build on each other.
 */
let stored: AutomationSettings

beforeEach(() => {
  stored = defaultAutomationSettings()
  settingsGet.mockReset().mockImplementation(async () => stored)
  settingsSet.mockReset().mockImplementation(async (next: AutomationSettings) => {
    stored = next
  })
  jest.mocked(toast.error).mockReset()
})

describe("BehaviorCard", () => {
  it("renders defaults: scaling on, dedup on, threshold 200", async () => {
    render(<BehaviorCard />)
    const scaling = await screen.findByRole("switch", { name: /downscale screenshots/i })
    expect(scaling).toBeChecked()
    expect(screen.getByRole("switch", { name: /skip unchanged screenshots/i })).toBeChecked()
    expect(screen.getByLabelText(/paste threshold/i)).toHaveValue(200)
    expect(screen.getByLabelText(/max width/i)).toHaveValue(1280)
    expect(screen.getByLabelText(/max height/i)).toHaveValue(800)
  })

  it("disabling scaling persists the full settings blob and hides dimensions", async () => {
    render(<BehaviorCard />)
    const scaling = await screen.findByRole("switch", { name: /downscale screenshots/i })
    fireEvent.click(scaling)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshotScaling: { enabled: false, maxWidth: 1280, maxHeight: 800 },
        })
      )
    )
    await waitFor(() => expect(screen.queryByLabelText(/max width/i)).not.toBeInTheDocument())
    expect(screen.queryByLabelText(/max height/i)).not.toBeInTheDocument()
  })

  it("dimension inputs clamp to their ranges and persist", async () => {
    stored = {
      ...defaultAutomationSettings(),
      screenshotScaling: { enabled: true, maxWidth: 1280, maxHeight: 800 },
    }
    render(<BehaviorCard />)
    const width = await screen.findByLabelText(/max width/i)
    fireEvent.change(width, { target: { value: "9999" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshotScaling: expect.objectContaining({ maxWidth: 3840 }),
        })
      )
    )
    const height = await screen.findByLabelText(/max height/i)
    fireEvent.change(height, { target: { value: "100" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshotScaling: expect.objectContaining({ maxHeight: 240 }),
        })
      )
    )
  })

  it("toggling dedup persists", async () => {
    render(<BehaviorCard />)
    const dedup = await screen.findByRole("switch", { name: /skip unchanged screenshots/i })
    fireEvent.click(dedup)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ screenshotDedup: false }))
    )
  })

  it("persists the global picture-in-picture visibility preference", async () => {
    render(<BehaviorCard />)
    const toggle = await screen.findByRole("switch", {
      name: /always hide picture in picture/i,
    })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({ alwaysHidePictureInPicture: true })
      )
    )
  })

  it("changing the paste threshold clamps to >= 0 and persists", async () => {
    render(<BehaviorCard />)
    const input = await screen.findByLabelText(/paste threshold/i)
    fireEvent.change(input, { target: { value: "-5" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ pasteThresholdChars: 0 }))
    )
  })

  it("shows the consent wait in seconds", async () => {
    render(<BehaviorCard />)
    // Default is 90_000ms — the operator sees 90, not the raw milliseconds.
    expect(await screen.findByLabelText(/consent wait/i)).toHaveValue(90)
  })

  it("clamps the consent wait below the sidecar tool-call ceiling", async () => {
    render(<BehaviorCard />)
    const input = await screen.findByLabelText(/consent wait/i)
    // 600s would outlive the plugin tool call it is gating, so the answer
    // would land on a request the sidecar already abandoned.
    fireEvent.change(input, { target: { value: "600" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({ consentTimeoutMs: 115_000 })
      )
    )
  })

  it("floors an unanswerably short consent wait", async () => {
    render(<BehaviorCard />)
    const input = await screen.findByLabelText(/consent wait/i)
    fireEvent.change(input, { target: { value: "1" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ consentTimeoutMs: 5_000 }))
    )
  })

  it("shows the load error inline when settingsGet rejects", async () => {
    settingsGet.mockRejectedValue(new Error("UNSUPPORTED_PLATFORM"))
    render(<BehaviorCard />)
    expect(await screen.findByText(/UNSUPPORTED_PLATFORM/)).toBeInTheDocument()
  })

  it("stringifies non-Error load failures", async () => {
    settingsGet.mockRejectedValue("raw-failure")
    render(<BehaviorCard />)
    expect(await screen.findByText(/raw-failure/)).toBeInTheDocument()
  })

  it("clearing a dimension input falls back to its default", async () => {
    stored = {
      ...defaultAutomationSettings(),
      screenshotScaling: { enabled: true, maxWidth: 1280, maxHeight: 800 },
    }
    render(<BehaviorCard />)
    const width = await screen.findByLabelText(/max width/i)
    fireEvent.change(width, { target: { value: "" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(
        expect.objectContaining({
          screenshotScaling: expect.objectContaining({ maxWidth: 1280 }),
        })
      )
    )
    const threshold = screen.getByLabelText(/paste threshold/i)
    fireEvent.change(threshold, { target: { value: "" } })
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ pasteThresholdChars: 0 }))
    )
  })

  it("reports a failed save and shows what the host still holds", async () => {
    render(<BehaviorCard />)
    const dedup = await screen.findByRole("switch", { name: /skip unchanged screenshots/i })
    settingsSet.mockRejectedValueOnce(new Error("KILL_SWITCH_ACTIVE"))
    fireEvent.click(dedup)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ description: "KILL_SWITCH_ACTIVE" })
      )
    )
    await waitFor(() => expect(dedup).toBeChecked())
  })

  it("rolls back the PiP preference when persistence fails", async () => {
    render(<BehaviorCard />)
    const toggle = await screen.findByRole("switch", {
      name: /always hide picture in picture/i,
    })
    settingsSet.mockRejectedValueOnce(new Error("WRITE_FAILED"))
    fireEvent.click(toggle)
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    await waitFor(() => expect(toggle).not.toBeChecked())
  })

  it("serializes rapid saves so the second builds on the first", async () => {
    const first = Promise.withResolvers<void>()
    render(<BehaviorCard />)
    const pip = await screen.findByRole("switch", {
      name: /always hide picture in picture/i,
    })
    const dedup = screen.getByRole("switch", { name: /skip unchanged screenshots/i })
    settingsSet.mockImplementationOnce(async (next: AutomationSettings) => {
      await first.promise
      stored = next
    })

    fireEvent.click(pip)
    fireEvent.click(dedup)
    expect(pip).toBeChecked()
    expect(dedup).not.toBeChecked()
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1))

    await act(async () => first.resolve())
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(2))
    expect(settingsSet).toHaveBeenLastCalledWith(
      expect.objectContaining({ alwaysHidePictureInPicture: true, screenshotDedup: false })
    )
  })
})
