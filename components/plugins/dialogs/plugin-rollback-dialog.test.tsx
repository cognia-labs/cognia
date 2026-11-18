/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars) return `${key}(${JSON.stringify(vars)})`
    return key
  },
  useFormatter: () => ({
    dateTime: (d: Date, opts?: Record<string, unknown>) =>
      `fmt:${d.toISOString()}:${JSON.stringify(opts ?? {})}`,
  }),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

import { PluginRollbackDialog, __resetPluginRollbackClientForTests } from "./plugin-rollback-dialog"
import { isTauri } from "@/lib/tauri"
import type { PluginDataRollback } from "@/lib/plugin/dexie/data-rollback"

const NO_DATA_CHANGE: PluginDataRollback = { kind: "none" }

beforeEach(() => {
  __resetPluginRollbackClientForTests(null)
  ;(isTauri as jest.Mock).mockReturnValue(true)
})

const sampleInfo = {
  pluginId: "alpha",
  currentVersion: "1.2.0",
  hasBackups: true,
  availableVersions: [
    {
      version: "1.0.0",
      source: "backup" as const,
      date: new Date("2026-04-01T00:00:00.000Z"),
      size: 100,
      canRollback: true,
      reason: "before update",
      data: NO_DATA_CHANGE,
    },
  ],
  lastBackup: undefined,
}

async function confirmRollback() {
  const confirm = await screen.findByRole("alertdialog")
  await act(async () => {
    fireEvent.click(within(confirm).getByRole("button", { name: "confirmAction" }))
  })
}

describe("PluginRollbackDialog", () => {
  it("shows empty hint when there are no snapshots", async () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => ({
        pluginId: "alpha",
        currentVersion: "1.0.0",
        availableVersions: [],
        hasBackups: false,
      }),
      rollback: async () => ({
        success: true,
        pluginId: "alpha",
        fromVersion: "",
        toVersion: "",
        duration: 0,
        dataRestored: false,
        requiresRestart: false,
      }),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("empty")).toBeInTheDocument())
  })

  it("renders version rows and triggers rollback on click", async () => {
    const rollback = jest.fn(async () => ({
      success: true,
      pluginId: "alpha",
      fromVersion: "1.2.0",
      toVersion: "1.0.0",
      duration: 1,
      dataRestored: false,
      requiresRestart: false,
    }))
    const onClose = jest.fn()
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback,
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText(/rollbackAria.*1\.0\.0/))
    // Rolling back replaces the installed version, so it asks first.
    expect(rollback).not.toHaveBeenCalled()
    await confirmRollback()
    expect(rollback).toHaveBeenCalledWith("alpha", "1.0.0", {})
    expect(onClose).toHaveBeenCalled()
  })

  it("says the data goes back to a snapshot and authorizes exactly that one", async () => {
    const rollback = jest.fn(async () => ({
      success: true,
      pluginId: "alpha",
      fromVersion: "2.0.0",
      toVersion: "1.0.0",
      duration: 1,
      dataRestored: true,
      requiresRestart: false,
    }))
    const data: PluginDataRollback = {
      kind: "restore",
      snapshotId: "snap-1",
      capturedAt: Date.parse("2026-03-30T10:00:00.000Z"),
      dataVersion: 1,
      currentDataVersion: 2,
      currentRows: 9,
      snapshotRows: 4,
    }
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => ({
        ...sampleInfo,
        currentVersion: "2.0.0",
        availableVersions: [{ ...sampleInfo.availableVersions[0]!, data }],
      }),
      rollback,
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    // The row already says the data comes back from that snapshot.
    expect(await screen.findByText(/^rowRestore/)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText(/rollbackAria.*1\.0\.0/))
    const confirm = await screen.findByRole("alertdialog")
    expect(within(confirm).getByTestId("plugin-data-rollback-restore")).toHaveTextContent(
      '"snapshotRows":4'
    )
    await confirmRollback()
    expect(rollback).toHaveBeenCalledWith("alpha", "1.0.0", { confirmedDataSnapshot: "snap-1" })
  })

  it("does not offer a version that cannot read the data, and says why", async () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => ({
        ...sampleInfo,
        currentVersion: "2.0.0",
        availableVersions: [
          {
            ...sampleInfo.availableVersions[0]!,
            canRollback: false,
            data: { kind: "unavailable", currentDataVersion: 2, targetDataVersion: 1 },
          },
        ],
      }),
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    expect(await screen.findByText("rowUnavailable")).toBeInTheDocument()
    expect(screen.getByLabelText(/rollbackAria.*1\.0\.0/)).toBeDisabled()
  })

  it("surfaces a non-success result error", async () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback: async () => ({
        success: false,
        pluginId: "alpha",
        fromVersion: "1.2.0",
        toVersion: "1.0.0",
        duration: 0,
        dataRestored: false,
        requiresRestart: false,
        error: "lockfile mismatch",
      }),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText(/rollbackAria.*1\.0\.0/))
    await confirmRollback()
    await waitFor(() => expect(screen.getByText("lockfile mismatch")).toBeInTheDocument())
  })

  it("warns when no version is rollback-able", async () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => ({
        pluginId: "alpha",
        currentVersion: "1.0.0",
        hasBackups: true,
        availableVersions: [
          {
            version: "0.9.0",
            source: "backup" as const,
            date: undefined,
            size: 0,
            canRollback: false,
            reason: "missing migration",
            data: NO_DATA_CHANGE,
          },
        ],
      }),
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("canNotRollback")).toBeInTheDocument())
  })

  it("disables actions and shows hint when not in Tauri", async () => {
    ;(isTauri as jest.Mock).mockReturnValue(false)
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    expect(await screen.findByText("desktopOnlyHint")).toBeInTheDocument()
    // Wait for the async getRollbackInfo to resolve so the version list mounts.
    const button = (await screen.findByLabelText(/rollbackAria.*1\.0\.0/)) as HTMLButtonElement
    expect(button).toBeDisabled()
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })

  it("cancelling the confirmation leaves the plugin alone", async () => {
    const rollback = jest.fn()
    __resetPluginRollbackClientForTests({ getRollbackInfo: async () => sampleInfo, rollback })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument())
    fireEvent.click(screen.getByLabelText(/rollbackAria.*1\.0\.0/))
    const confirm = await screen.findByRole("alertdialog")
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "cancel" }))
    })
    expect(rollback).not.toHaveBeenCalled()
  })

  // It showed "no snapshots" while the request was still in flight.
  it("says it is loading instead of claiming there is nothing", async () => {
    let resolve!: (info: typeof sampleInfo) => void
    __resetPluginRollbackClientForTests({
      getRollbackInfo: () => new Promise((r) => (resolve = r)),
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    expect(screen.getByTestId("plugin-rollback-loading")).toBeInTheDocument()
    expect(screen.queryByText("empty")).toBeNull()
    await act(async () => resolve(sampleInfo))
    expect(screen.queryByTestId("plugin-rollback-loading")).toBeNull()
  })

  // Switching the target used to show the previous plugin's versions until the
  // new request resolved.
  it("never shows one plugin's versions for another", async () => {
    const byPlugin: Record<string, typeof sampleInfo> = {
      alpha: sampleInfo,
      beta: {
        ...sampleInfo,
        pluginId: "beta",
        availableVersions: [{ ...sampleInfo.availableVersions[0]!, version: "0.5.0" }],
      },
    }
    let resolveBeta!: () => void
    __resetPluginRollbackClientForTests({
      getRollbackInfo: (id: string) =>
        id === "beta"
          ? new Promise((r) => (resolveBeta = () => r(byPlugin.beta!)))
          : Promise.resolve(byPlugin.alpha!),
      rollback: jest.fn(),
    })
    const { rerender } = render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument())
    rerender(<PluginRollbackDialog open pluginId="beta" onClose={() => {}} />)
    expect(screen.queryByText(/v1\.0\.0/)).toBeNull()
    expect(screen.getByTestId("plugin-rollback-loading")).toBeInTheDocument()
    await act(async () => resolveBeta())
    expect(screen.getByText(/v0\.5\.0/)).toBeInTheDocument()
  })

  it("formats the snapshot date for the user's locale", async () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    const time = await screen.findByText(/^fmt:2026-04-01T00:00:00.000Z/)
    expect(time.tagName).toBe("TIME")
    expect(time).toHaveAttribute("dateTime", "2026-04-01T00:00:00.000Z")
  })

  it("keeps the dialog within a phone screen", () => {
    __resetPluginRollbackClientForTests({
      getRollbackInfo: async () => sampleInfo,
      rollback: jest.fn(),
    })
    render(<PluginRollbackDialog open pluginId="alpha" onClose={() => {}} />)
    expect(screen.getByRole("dialog")).toHaveClass("max-h-[85dvh]", "flex-col")
    expect(screen.getByTestId("plugin-rollback-body")).toHaveClass("overflow-y-auto", "min-h-0")
  })
})
