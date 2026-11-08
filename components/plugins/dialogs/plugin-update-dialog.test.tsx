/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { UpdateResult } from "@/lib/plugin/lifecycle/updater"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (key === "versionChange" && vars) return `v${vars.from} → v${vars.to}`
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

import { PluginUpdateDialog, __resetPluginUpdateClientForTests } from "./plugin-update-dialog"

beforeEach(() => {
  __resetPluginUpdateClientForTests(null)
})

function makeClient(
  updates: Array<{
    pluginId: string
    currentVersion: string
    latestVersion: string
  }> = []
) {
  return {
    checkForUpdates: jest.fn(async () => updates),
    installUpdate: jest.fn(async (pluginId: string, newVersion: string): Promise<UpdateResult> => ({
      success: true,
      pluginId,
      previousVersion: "1.0.0",
      newVersion,
      duration: 0,
    })),
    cancelUpdate: jest.fn(),
    onProgress: jest.fn(() => () => undefined),
  }
}

describe("PluginUpdateDialog", () => {
  it("clears the previous error as soon as a retry starts", async () => {
    const client = makeClient([
      { pluginId: "retry", currentVersion: "1.0.0", latestVersion: "2.0.0" },
    ])
    const result: UpdateResult = {
      success: false,
      pluginId: "retry",
      previousVersion: "1.0.0",
      newVersion: "2.0.0",
      duration: 0,
      error: "Old failure",
    }
    client.installUpdate.mockResolvedValueOnce(result)
    let finish!: (value: UpdateResult) => void
    client.installUpdate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    const button = await screen.findByRole("button", { name: "install" })
    fireEvent.click(button)
    expect(await screen.findByRole("alert")).toHaveTextContent("Old failure")
    fireEvent.click(button)
    await waitFor(() => expect(client.installUpdate).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    await act(async () => finish({ ...result, success: true, error: undefined }))
  })
  it("keeps a refused single update and shows the error (U22)", async () => {
    const client = makeClient([
      { pluginId: "refused", currentVersion: "1.0.0", latestVersion: "2.0.0" },
    ])
    client.installUpdate.mockResolvedValue({
      success: false,
      pluginId: "refused",
      previousVersion: "1.0.0",
      newVersion: "2.0.0",
      duration: 0,
      error: "Restart required",
    })
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole("button", { name: "install" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Restart required")
    expect(screen.getByText("refused")).toBeInTheDocument()
    expect(screen.getByText("availableCount:1")).toBeInTheDocument()
  })

  it("removes only succeeded rows from install-all (U22)", async () => {
    const client = makeClient([
      { pluginId: "succeeded", currentVersion: "1.0.0", latestVersion: "2.0.0" },
      { pluginId: "refused", currentVersion: "1.0.0", latestVersion: "2.0.0" },
    ])
    client.installUpdate
      .mockResolvedValueOnce({
        success: true,
        pluginId: "succeeded",
        previousVersion: "1.0.0",
        newVersion: "2.0.0",
        duration: 0,
      })
      .mockResolvedValueOnce({
        success: false,
        pluginId: "refused",
        previousVersion: "1.0.0",
        newVersion: "2.0.0",
        duration: 0,
        error: "Permission review required",
      })
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await screen.findByText("succeeded")
    fireEvent.click(screen.getByRole("button", { name: "installAll" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission review required")
    expect(screen.queryByText("succeeded")).not.toBeInTheDocument()
    expect(screen.getByText("refused")).toBeInTheDocument()
  })
  it("shows the up-to-date message when no updates are available", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalled())
    expect(screen.getByText("upToDate")).toBeInTheDocument()
  })

  it("renders update entries returned by the client", async () => {
    const client = makeClient([
      { pluginId: "alpha", currentVersion: "1.0.0", latestVersion: "1.1.0" },
      { pluginId: "beta", currentVersion: "0.5.0", latestVersion: "0.6.0" },
    ])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument())
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(screen.getByText("availableCount:2")).toBeInTheDocument()
    // The version delta renders from currentVersion → latestVersion (an earlier
    // fromVersion/toVersion mismatch showed "v undefined → v undefined").
    expect(screen.getByText("v1.0.0 → v1.1.0")).toBeInTheDocument()
  })

  it("install-all calls installUpdate with the latest version for every entry", async () => {
    const client = makeClient([
      { pluginId: "alpha", currentVersion: "1.0.0", latestVersion: "1.1.0" },
    ])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument())
    fireEvent.click(screen.getByText("installAll"))
    await waitFor(() => expect(client.installUpdate).toHaveBeenCalledWith("alpha", "1.1.0"))
  })

  it("close button invokes onClose", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    const onClose = jest.fn()
    render(<PluginUpdateDialog open onClose={onClose} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "recheck" })).toBeEnabled())
    fireEvent.click(screen.getByText("close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("applies mobile-first w-[95vw] width to DialogContent", async () => {
    __resetPluginUpdateClientForTests(makeClient([]))
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "recheck" })).toBeEnabled())
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })

  // `dvh`, not `vh`: on a phone `vh` is measured with the browser chrome
  // retracted, so a `vh` cap can still run under the toolbar.
  it("caps DialogContent at the dynamic viewport with a fixed header and footer", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalled())
    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveClass("flex", "flex-col", "max-h-[85dvh]")
    expect(dialog).not.toHaveClass("max-h-[85vh]")
    expect(dialog.querySelector("[data-slot='dialog-header']")).toHaveClass("shrink-0")
    expect(dialog.querySelector("[data-slot='dialog-footer']")).toHaveClass("shrink-0")
    // The list keeps its own `min-h-0 flex-1` scroller, the one that flexes.
    expect(dialog.querySelector("[data-slot='scroll-area']")).toHaveClass("min-h-0", "flex-1")
  })

  it("names each update by the plugin's display name, falling back to its id", async () => {
    const { usePluginStore } = await import("@/stores/plugin-runtime/plugin-store")
    usePluginStore.setState((state) => ({
      ...state,
      plugins: {
        ...state.plugins,
        alpha: { manifest: { id: "alpha", name: "Alpha Tools", version: "1.0.0" } },
      } as never,
    }))
    const client = makeClient([
      { pluginId: "alpha", currentVersion: "1.0.0", latestVersion: "1.1.0" },
      { pluginId: "beta", currentVersion: "2.0.0", latestVersion: "2.1.0" },
    ])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("Alpha Tools")).toBeInTheDocument())
    expect(screen.getByText("beta")).toBeInTheDocument()
  })

  it("scopes the check to one plugin when opened from its detail view", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open pluginId="gamma" onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalledWith(["gamma"]))
    fireEvent.click(screen.getByRole("button", { name: "recheck" }))
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalledTimes(2))
    expect(client.checkForUpdates).toHaveBeenLastCalledWith(["gamma"])
    expect(screen.getByText("titleSingle:gamma")).toBeInTheDocument()
    expect(screen.getByText("descriptionSingle")).toBeInTheDocument()
    expect(screen.getByText("upToDateSingle")).toBeInTheDocument()
  })

  it("checks every plugin when no plugin is given", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalledWith(undefined))
    expect(screen.getByText("title")).toBeInTheDocument()
  })
})
