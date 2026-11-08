/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("@/lib/platform/os", () => ({ detectOsFamily: jest.fn(() => "windows") }))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))

const isTauriMock = jest.fn<boolean, []>(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const checkMock = jest.fn()
jest.mock("@tauri-apps/plugin-updater", () => ({ check: () => checkMock() }), { virtual: true })

const relaunchMock = jest.fn(async () => {})
jest.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunchMock() }), {
  virtual: true,
})

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

const saveMock = jest.fn(async () => {})
const saveUpdateSettingsMock = jest.fn(async (_patch: Record<string, unknown>) => {})
const defaultUpdateSettings = {
  autoCheck: true,
  checkIntervalMinutes: 360,
  autoDownload: false,
  relaunchAfterInstall: true,
  requestTimeoutSeconds: 30,
  useProxy: true,
}
const settingsState = {
  settings: { updates: { ...defaultUpdateSettings } } as Record<string, unknown>,
  save: saveMock,
  saveUpdateSettings: saveUpdateSettingsMock,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState }
  ),
}))

import { toast } from "sonner"
import { __resetPendingUpdate, checkForUpdate } from "@/lib/tauri/updater"
import { detectOsFamily } from "@/lib/platform/os"
import { openExternal } from "@/lib/tauri/opener"
import { UpdateCard } from "./update-card"

const toastMock = toast as unknown as {
  success: jest.Mock
  error: jest.Mock
  info: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  jest.mocked(detectOsFamily).mockReturnValue("windows")
  settingsState.settings = { updates: { ...defaultUpdateSettings } }
  saveUpdateSettingsMock.mockImplementation(async (patch: Record<string, unknown>) => {
    const current = settingsState.settings.updates as Record<string, unknown>
    settingsState.settings = { ...settingsState.settings, updates: { ...current, ...patch } }
  })
  // The updater caches the last `check()` handle module-side; clear it so each
  // case starts cold.
  __resetPendingUpdate()
})

describe("<UpdateCard />", () => {
  it("hands macOS off to the displayed release without auto-downloading (U13)", async () => {
    jest.mocked(detectOsFamily).mockReturnValue("macos")
    settingsState.settings = { updates: { ...defaultUpdateSettings, autoDownload: true } }
    const update = { version: "2.0.0", download: jest.fn(), install: jest.fn() }
    checkMock.mockResolvedValueOnce(update)
    render(<UpdateCard />)
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    await waitFor(() => expect(screen.getByTestId("update-alert")).toHaveTextContent("2.0.0"))
    expect(update.download).not.toHaveBeenCalled()
    expect(screen.queryByTestId("download-update")).not.toBeInTheDocument()
    expect(screen.queryByTestId("install-update")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open the release page" }))
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/cognia-labs/cognia/releases/tag/v2.0.0"
      )
    )
    expect(update.install).not.toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it.each(["download", "install", "downloaded-install"])(
    "refuses a different version from another surface during %s (U02)",
    async (operation) => {
      const offered = {
        version: "2.0.0",
        download: jest.fn(async () => {}),
        install: jest.fn(async () => {}),
      }
      const changed = {
        version: "3.0.0",
        download: jest.fn(async () => {}),
        install: jest.fn(async () => {}),
      }
      checkMock.mockResolvedValueOnce(offered)
      render(<UpdateCard />)
      fireEvent.click(screen.getByTestId("check-updates"))
      await waitFor(() => expect(screen.getByTestId("update-alert")).toHaveTextContent("2.0.0"))
      if (operation === "downloaded-install") {
        fireEvent.click(screen.getByTestId("download-update"))
        await waitFor(() => expect(screen.getByTestId("update-downloaded")).toBeInTheDocument())
      }
      checkMock.mockResolvedValue(changed)
      await act(async () => {
        await checkForUpdate()
      })
      fireEvent.click(
        screen.getByTestId(operation === "download" ? "download-update" : "install-update")
      )
      await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
      expect(changed.download).not.toHaveBeenCalled()
      expect(changed.install).not.toHaveBeenCalled()
      expect(offered.install).not.toHaveBeenCalled()
      expect(screen.queryByTestId("update-alert")).not.toBeInTheDocument()
      expect(relaunchMock).not.toHaveBeenCalled()
    }
  )

  it("disables checking and explains on web", () => {
    isTauriMock.mockReturnValue(false)
    render(<UpdateCard />)
    expect(screen.getByTestId("updates-desktop-only")).toBeInTheDocument()
    expect(screen.getByTestId("check-updates")).toBeDisabled()
  })

  it("reports already-latest and records last-checked", async () => {
    checkMock.mockResolvedValueOnce(null)
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(screen.getByTestId("row-last-checked")).toBeInTheDocument()
  })

  it("renders the persisted last-check timestamp", () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings },
      lastUpdateCheckAt: Date.UTC(2026, 6, 18, 0, 0, 0),
    }
    render(<UpdateCard />)
    expect(screen.getByTestId("row-last-checked")).toBeInTheDocument()
  })

  it("keeps the successful check result when persisting its timestamp fails", async () => {
    saveMock.mockRejectedValueOnce(new Error("db unavailable"))
    checkMock.mockResolvedValueOnce(null)
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    expect(screen.getByTestId("row-last-checked")).toBeInTheDocument()
  })

  it("surfaces an available update and installs it", async () => {
    const update = {
      version: "1.0.0",
      body: "Notes",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {}),
    }
    checkMock.mockResolvedValue(update)
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("update-alert")).toHaveTextContent("1.0.0"))

    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(update.download).toHaveBeenCalled())
    await waitFor(() => expect(update.install).toHaveBeenCalled())
    await waitFor(() => expect(relaunchMock).toHaveBeenCalled())
  })

  it("reports a check failure via toast", async () => {
    checkMock.mockRejectedValueOnce(new Error("network"))
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("reports when the update vanished before install", async () => {
    // handleCheck caches an update; if the cache is dropped (e.g. another
    // surface re-checked to nothing) the install path re-checks and finds none.
    checkMock.mockResolvedValueOnce({ version: "1.0.0", body: "Notes" })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    __resetPendingUpdate()
    checkMock.mockResolvedValueOnce(null)
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it("surfaces an install failure via toast and resets the installing state", async () => {
    const download = jest.fn(async () => {
      throw new Error("disk full")
    })
    // The cached check handle is reused at install time, so it carries the
    // throwing installer.
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      body: "Notes",
      download,
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(relaunchMock).not.toHaveBeenCalled()
    // Failure re-enables the button (installing state cleared).
    await waitFor(() => expect(screen.getByTestId("install-update")).not.toBeDisabled())
    expect(screen.queryByTestId("install-progress")).not.toBeInTheDocument()
  })

  it("shows determinate download progress while installing", async () => {
    const download = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 200 } })
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } })
    })
    checkMock.mockResolvedValue({
      version: "1.0.0",
      body: "Notes",
      download,
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(screen.getByTestId("install-progress")).toHaveTextContent("50%"))
    await waitFor(() => expect(relaunchMock).toHaveBeenCalled())
  })

  it("shows indeterminate progress when the server omits a content length", async () => {
    const download = jest.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: {} })
      onEvent?.({ event: "Progress", data: { chunkLength: 25 } })
    })
    checkMock.mockResolvedValue({
      version: "1.0.0",
      body: "Notes",
      download,
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(relaunchMock).toHaveBeenCalled())
    // No Content-Length → no percent figure, just the "installing" label.
    expect(screen.getByTestId("install-progress")).not.toHaveTextContent("%")
  })

  it("stringifies a non-Error install rejection in the failure toast", async () => {
    const download = jest.fn(async () => {
      throw "kaboom"
    })
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      body: "Notes",
      download,
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("persists the auto-check toggle via the settings store", async () => {
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("auto-check-updates-toggle"))
    await waitFor(() => expect(saveUpdateSettingsMock).toHaveBeenCalledWith({ autoCheck: false }))
  })

  it("persists advanced updater switches and select options", async () => {
    render(<UpdateCard />)

    fireEvent.click(screen.getByTestId("auto-download-updates-toggle"))
    fireEvent.click(screen.getByTestId("relaunch-after-update-toggle"))
    fireEvent.click(screen.getByTestId("update-use-proxy-toggle"))
    fireEvent.click(screen.getByTestId("update-check-interval"))
    fireEvent.click(screen.getByRole("option", { name: "Every hour" }))
    fireEvent.click(screen.getByTestId("update-request-timeout"))
    fireEvent.click(screen.getByRole("option", { name: "60 seconds" }))

    await waitFor(() => expect(saveUpdateSettingsMock).toHaveBeenCalledTimes(5))
    expect(saveUpdateSettingsMock).toHaveBeenNthCalledWith(1, { autoDownload: true })
    expect(saveUpdateSettingsMock).toHaveBeenNthCalledWith(2, { relaunchAfterInstall: false })
    expect(saveUpdateSettingsMock).toHaveBeenNthCalledWith(3, { useProxy: false })
    expect(saveUpdateSettingsMock).toHaveBeenNthCalledWith(4, { checkIntervalMinutes: 60 })
    expect(saveUpdateSettingsMock).toHaveBeenNthCalledWith(5, { requestTimeoutSeconds: 60 })
  })

  it("downloads immediately after a manual check when auto-download is enabled", async () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings, autoDownload: true },
    }
    const download = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      download,
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)

    fireEvent.click(screen.getByTestId("check-updates"))

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("update-downloaded")).toBeInTheDocument()
  })

  it("surfaces updater preference persistence failures", async () => {
    saveUpdateSettingsMock.mockRejectedValueOnce("db unavailable")
    render(<UpdateCard />)

    fireEvent.click(screen.getByTestId("auto-download-updates-toggle"))

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("db unavailable"))
    )
  })

  it("downloads an available update without installing it", async () => {
    const download = jest.fn(async () => {})
    const install = jest.fn(async () => {})
    checkMock.mockResolvedValueOnce({ version: "1.0.0", download, install })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("download-update")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("download-update"))

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(install).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId("update-downloaded")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
  })

  it("handles a vanished or failed download without installing", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("download-update")).toBeInTheDocument())
    __resetPendingUpdate()
    checkMock.mockResolvedValueOnce(null)
    fireEvent.click(screen.getByTestId("download-update"))
    await waitFor(() => expect(toastMock.info).toHaveBeenCalled())
    expect(screen.queryByTestId("update-alert")).not.toBeInTheDocument()
  })

  it("surfaces download and restart failures", async () => {
    const download = jest.fn(async () => {
      throw new Error("offline")
    })
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      download,
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("download-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("download-update"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("ignores a download if the desktop runtime disappears", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("download-update")).toBeInTheDocument())
    isTauriMock.mockReturnValue(false)
    fireEvent.click(screen.getByTestId("download-update"))
    await waitFor(() => expect(screen.getByTestId("download-update")).not.toBeDisabled())
    expect(screen.queryByTestId("update-downloaded")).not.toBeInTheDocument()
  })

  it("offers a manual restart when immediate relaunch is disabled", async () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings, relaunchAfterInstall: false },
    }
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {}),
    })
    const first = render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("install-update"))

    await waitFor(() => expect(screen.getByTestId("restart-update")).toBeInTheDocument())
    first.unmount()
    render(<UpdateCard />)
    expect(screen.getByTestId("restart-update")).toBeInTheDocument()
    const checkButton = screen.getByTestId("check-updates")
    expect(checkButton).toBeDisabled()
    checkButton.removeAttribute("disabled")
    fireEvent.click(checkButton)
    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(relaunchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("restart-update"))
    await waitFor(() => expect(relaunchMock).toHaveBeenCalled())
  })

  it("keeps the restart action when automatic relaunch fails after installation", async () => {
    relaunchMock.mockRejectedValueOnce(new Error("restart denied"))
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("install-update"))

    await waitFor(() => expect(screen.getByTestId("restart-update")).toBeInTheDocument())
    expect(screen.getByTestId("check-updates")).toBeDisabled()
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining("restart denied"))
  })

  it("surfaces a manual restart failure", async () => {
    settingsState.settings = {
      updates: { ...defaultUpdateSettings, relaunchAfterInstall: false },
    }
    relaunchMock.mockRejectedValueOnce("restart denied")
    checkMock.mockResolvedValueOnce({
      version: "1.0.0",
      download: jest.fn(async () => {}),
      install: jest.fn(async () => {}),
    })
    render(<UpdateCard />)
    fireEvent.click(screen.getByTestId("check-updates"))
    await waitFor(() => expect(screen.getByTestId("install-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("install-update"))
    await waitFor(() => expect(screen.getByTestId("restart-update")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("restart-update"))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("hides the auto-check toggle on web", () => {
    isTauriMock.mockReturnValue(false)
    render(<UpdateCard />)
    expect(screen.queryByTestId("auto-check-updates-toggle")).not.toBeInTheDocument()
  })

  it("defaults the auto-check toggle to on when settings are absent", () => {
    settingsState.settings = {}
    render(<UpdateCard />)
    expect(screen.getByTestId("auto-check-updates-toggle")).toBeChecked()
  })
})
