/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { clearAll } from "@/lib/data/clear"

let mockLocale = "en"
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const messages =
      mockLocale === "en"
        ? jest.requireActual("@/i18n/messages/en/settings/data.json")
        : jest.requireActual("@/i18n/messages/zh-CN/settings/data.json")
    const root = namespace
      .split(".")
      .slice(2)
      .reduce((value, part) => value?.[part], messages)
    return (key: string, values: Record<string, unknown> = {}) => {
      const template = key.split(".").reduce((value, part) => value?.[part], root)
      if (typeof template !== "string") throw new Error(`Missing ${mockLocale} message: ${key}`)
      return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name]))
    }
  },
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))

const saveMock = jest.fn(async (..._a: unknown[]) => undefined)
let storeState: { settings: Record<string, unknown> | null; save: typeof saveMock }

// useSettingsStore is a selector hook — drive it from a mutable fake state.
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))
jest.mock("@/components/settings/data/port-leases-block", () => ({
  PortLeasesBlock: () => <div data-testid="port-leases-block" />,
}))
// Heavy siblings reduce to inert stubs so we can mount just the tab.
jest.mock("@/hooks/storage", () => ({
  useStorageBreakdown: () => ({ formatBytes: (n: number) => String(n), refresh: jest.fn() }),
}))
jest.mock("@/components/data/storage/storage-cleanup-dialog", () => ({
  StorageCleanupDialog: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}))
jest.mock("@/lib/data/clear", () => ({
  clearAll: jest.fn(),
  clearTables: jest.fn(),
}))
const mockTrackEvent = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))
const runWorkspaceMaintenanceMock = jest.fn()
const maintenanceOutcome = {
  startedAt: 1,
  finishedAt: 2,
  reconcile: { reclaimed: [], orphaned: [], imported: [] },
  reclaimedWorkspaceIds: [],
  expiredSnapshotTaskIds: [],
  removedBlobCount: 0,
  reclaimedBytes: 0,
  events: [],
}
const listWorkspaceMaintenanceEventsMock = jest.fn()
const getWorkspaceLifecyclePolicyMock = jest.fn()
const setWorkspaceLifecyclePolicyMock = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  runWorkspaceMaintenance: (...args: unknown[]) => runWorkspaceMaintenanceMock(...args),
  listWorkspaceMaintenanceEvents: (...args: unknown[]) =>
    listWorkspaceMaintenanceEventsMock(...args),
  getWorkspaceLifecyclePolicy: (...args: unknown[]) => getWorkspaceLifecyclePolicyMock(...args),
  setWorkspaceLifecyclePolicy: (...args: unknown[]) => setWorkspaceLifecyclePolicyMock(...args),
}))
// The policy write is `approval: "interactive"`, so it rides the lease wrapper.
const runWorkspaceUserActionMock = jest.fn((_command: string, operation: () => Promise<unknown>) =>
  operation()
)
jest.mock("@/lib/task-workspace/user-action", () => ({
  ...jest.requireActual("@/lib/task-workspace/user-action"),
  runWorkspaceUserAction: (...args: unknown[]) =>
    (runWorkspaceUserActionMock as unknown as (...a: unknown[]) => unknown)(...args),
}))

let mockHostRuntime = true
jest.mock("@/lib/platform/capabilities", () => ({
  ...jest.requireActual("@/lib/platform/capabilities"),
  hasHostRuntime: () => mockHostRuntime,
}))

import { MaintenanceTab } from "./maintenance-tab"

beforeEach(() => {
  mockLocale = "en"
  jest.mocked(clearAll).mockReset()
  jest.mocked(toast.success).mockClear()
  jest.mocked(toast.warning).mockClear()
  jest.mocked(toast.error).mockClear()
  saveMock.mockClear()
  mockTrackEvent.mockClear()
  runWorkspaceMaintenanceMock.mockReset().mockResolvedValue(maintenanceOutcome)
  listWorkspaceMaintenanceEventsMock.mockReset().mockResolvedValue({ items: [] })
  getWorkspaceLifecyclePolicyMock.mockReset().mockResolvedValue({
    activeDirectoryCap: 25,
    snapshotRetentionDays: 14,
    blobBudgetBytes: 2_000_000_000,
    sandboxSnapshotBudgetBytes: 536_870_912,
    portRangeStart: 42000,
    portRangeEnd: 45999,
    portBlockSize: 20,
  })
  setWorkspaceLifecyclePolicyMock.mockReset().mockImplementation(async (policy) => policy)
  runWorkspaceUserActionMock.mockClear()
  runWorkspaceUserActionMock.mockImplementation((_command, operation) => operation())
  localStorage.clear()
  storeState = { settings: { storageRetention: { traceRetentionDays: 30 } }, save: saveMock }
  mockHostRuntime = true
})

describe("<MaintenanceTab /> reset outcome", () => {
  it.each([
    ["en", ["browserPreview"], "browser cookies and preferences"],
    ["en", ["appData"], "AppData and generated files"],
    [
      "en",
      ["browserPreview", "appData"],
      "browser cookies and preferences, AppData and generated files",
    ],
    ["zh-CN", ["browserPreview", "appData"], "浏览器 Cookie 和偏好设置, AppData 和生成文件"],
    ["en", [], ""],
  ] as const)("shows the %s outcome for %j", async (locale, failures, items) => {
    mockLocale = locale
    jest.useFakeTimers()
    jest.mocked(clearAll).mockResolvedValue({ databaseReset: true, cleanupFailures: [...failures] })
    const timer = jest.spyOn(globalThis, "setTimeout")
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
    try {
      render(<MaintenanceTab />)
      await user.click(screen.getByRole("combobox"))
      await user.click(screen.getByRole("option", { name: "Everything (entire database)" }))
      await user.click(screen.getByRole("button", { name: locale === "en" ? "Clear…" : "清空…" }))
      const dialog = screen.getByRole("alertdialog")
      await user.type(within(dialog).getByRole("textbox"), "DELETE")
      await user.click(
        within(dialog).getByRole("button", {
          name: locale === "en" ? "Permanently delete" : "永久删除",
        })
      )
      await waitFor(() => expect(clearAll).toHaveBeenCalledTimes(1))
      if (failures.length) {
        expect(toast.warning).toHaveBeenCalledWith(
          locale === "en"
            ? `Database reset; ${items} could not be removed. Reloading…`
            : `数据库已重置；未能移除：${items}。正在重新载入…`,
          { duration: 5000 }
        )
        expect(toast.success).not.toHaveBeenCalled()
      } else {
        expect(toast.success).toHaveBeenCalledWith("All data cleared. Reloading…")
        expect(toast.warning).not.toHaveBeenCalled()
      }
      const reloadTimerIndex = timer.mock.calls.findIndex(
        ([, ms]) => ms === (failures.length ? 5000 : 250)
      )
      expect(reloadTimerIndex).toBeGreaterThanOrEqual(0)
      clearTimeout(timer.mock.results[reloadTimerIndex].value)
    } finally {
      timer.mockRestore()
      jest.useRealTimers()
    }
  })
})

describe("<MaintenanceTab /> managed workspace block", () => {
  it("runs host-owned maintenance and refreshes durable history", async () => {
    listWorkspaceMaintenanceEventsMock.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({
      items: [
        {
          eventId: "event-1",
          kind: "reconciled",
          workspaceId: null,
          occurredAt: 1,
          detail: "registry checked",
        },
      ],
    })
    const user = userEvent.setup()
    render(<MaintenanceTab />)

    await waitFor(() =>
      expect(listWorkspaceMaintenanceEventsMock).toHaveBeenCalledWith({ pageSize: 20 })
    )
    const block = screen.getByTestId("workspace-maintenance")
    await user.click(within(block).getByRole("button"))

    await waitFor(() => expect(runWorkspaceMaintenanceMock).toHaveBeenCalledTimes(1))
    expect(runWorkspaceUserActionMock).toHaveBeenCalledWith(
      "task_workspace_maintenance_run",
      expect.any(Function)
    )
    expect(listWorkspaceMaintenanceEventsMock).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(block).toHaveAttribute("data-last-event-detail", "registry checked"))
  })

  it.each(["en", "zh-CN"])(
    "shows the full %s run response despite newer history",
    async (locale) => {
      mockLocale = locale
      runWorkspaceMaintenanceMock.mockResolvedValue({
        ...maintenanceOutcome,
        reclaimedWorkspaceIds: ["old"],
        removedBlobCount: 1,
        reclaimedBytes: 12,
        events: [
          { eventId: "ok", kind: "directoryReclaimed", detail: "old directory removed" },
          { eventId: "git", kind: "failed", detail: "source commit-graph failed" },
          { eventId: "blob", kind: "failed", detail: "blob unlink permission denied" },
        ],
      })
      listWorkspaceMaintenanceEventsMock.mockResolvedValue({
        items: [{ eventId: "other", kind: "reconciled", detail: "another run finished" }],
      })
      render(<MaintenanceTab />)
      await userEvent.setup().click(
        screen.getByRole("button", {
          name: locale === "en" ? "Run workspace maintenance" : "运行工作区维护",
        })
      )

      const result = await screen.findByRole("region", {
        name: locale === "en" ? "This maintenance run" : "本次维护结果",
      })
      expect(within(result).getAllByRole("listitem")).toHaveLength(3)
      expect(result).toHaveTextContent("old directory removed")
      expect(result).toHaveTextContent("source commit-graph failed")
      expect(result).toHaveTextContent("blob unlink permission denied")
      expect(result).toHaveTextContent(
        locale === "en"
          ? "Directories reclaimed: 1; snapshots expired: 0; blobs removed: 1; bytes reclaimed: 12."
          : "已回收 1 个目录、清理 0 个快照、移除 1 个数据块，释放 12 字节。"
      )
      expect(within(result).getByRole("alert")).toHaveTextContent(
        locale === "en" ? "Maintenance completed with failures." : "维护已结束，部分操作失败。"
      )
    }
  )

  it("keeps the run response visible if refreshing history fails", async () => {
    listWorkspaceMaintenanceEventsMock
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new Error("history unavailable"))
    runWorkspaceMaintenanceMock.mockResolvedValue({
      ...maintenanceOutcome,
      events: [{ eventId: "failure", kind: "failed", detail: "source maintenance refused" }],
    })
    render(<MaintenanceTab />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Run workspace maintenance" }))
    expect(await screen.findByRole("region", { name: "This maintenance run" })).toHaveTextContent(
      "source maintenance refused"
    )
    expect(await screen.findByText(/history unavailable/)).toBeInTheDocument()
  })

  // A standalone browser has no host: reading anyway painted the transport's
  // "tauri-only command" error in red beside a Run button that could only fail.
  it("says maintenance needs a host instead of calling one that is not there", async () => {
    mockHostRuntime = false
    render(<MaintenanceTab />)
    const block = screen.getByTestId("workspace-maintenance")
    expect(within(block).getByTestId("workspace-maintenance-needs-host")).toBeInTheDocument()
    expect(within(block).getByTestId("workspace-maintenance-run")).toBeDisabled()
    expect(within(block).queryByRole("alert")).not.toBeInTheDocument()
    expect(listWorkspaceMaintenanceEventsMock).not.toHaveBeenCalled()
    expect(getWorkspaceLifecyclePolicyMock).not.toHaveBeenCalled()
  })
})

describe("<MaintenanceTab /> privacy block", () => {
  it("updates the real behavior-telemetry consent while preserving the legacy setting alias", async () => {
    const user = userEvent.setup()
    render(<MaintenanceTab />)

    await user.click(screen.getByRole("switch"))

    expect(saveMock).toHaveBeenCalledWith({
      telemetryEnabled: true,
      behaviorTelemetry: expect.objectContaining({ enabled: true }),
    })
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: true })
    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: true })
  })

  it("records opt-out before disabling consent", async () => {
    localStorage.setItem("cognia-behavior-telemetry-enabled", "true")
    storeState.settings = {
      storageRetention: { traceRetentionDays: 30 },
      telemetryEnabled: true,
      behaviorTelemetry: { enabled: true },
    }
    const user = userEvent.setup()
    render(<MaintenanceTab />)

    await user.click(screen.getByRole("switch"))

    expect(mockTrackEvent).toHaveBeenCalledWith("telemetry.preference.changed", { enabled: false })
    expect(
      JSON.parse(localStorage.getItem("cognia-behavior-telemetry-enabled") ?? "{}")
    ).toMatchObject({ enabled: false })
  })
})

describe("<MaintenanceTab /> retention block", () => {
  it("renders the current trace-retention window", async () => {
    render(<MaintenanceTab />)
    const input = (await screen.findByLabelText(/Trace retention/i)) as HTMLInputElement
    expect(input.value).toBe("30")
  })

  it("commits a clamped, floored retention value on blur", async () => {
    const user = userEvent.setup()
    render(<MaintenanceTab />)
    const input = await screen.findByLabelText(/Trace retention/i)
    await user.clear(input)
    await user.type(input, "14.9")
    await user.tab()
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ storageRetention: { traceRetentionDays: 14 } })
    )
  })

  it("clamps a negative value to 0 (keep forever)", async () => {
    const user = userEvent.setup()
    render(<MaintenanceTab />)
    const input = await screen.findByLabelText(/Trace retention/i)
    await user.clear(input)
    await user.type(input, "-5")
    await user.tab()
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ storageRetention: { traceRetentionDays: 0 } })
    )
  })

  it("treats an empty entry as 0 (keep forever)", async () => {
    const user = userEvent.setup()
    render(<MaintenanceTab />)
    const input = await screen.findByLabelText(/Trace retention/i)
    await user.clear(input)
    await user.tab()
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({ storageRetention: { traceRetentionDays: 0 } })
    )
  })
})

describe("<MaintenanceTab /> worktree lifecycle policy", () => {
  it("shows the rules the maintenance run enforces", async () => {
    // The policy commands existed, were companion-reachable, and had exactly
    // one caller in the repo: their own unit test. "Run maintenance" was on
    // screen while the three numbers deciding what it reclaims were not.
    render(<MaintenanceTab />)

    expect(await screen.findByTestId("workspace-lifecycle-policy")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-lifecycle-activeDirectoryCap")).toHaveValue(25)
    expect(screen.getByTestId("workspace-lifecycle-snapshotRetentionDays")).toHaveValue(14)
    expect(screen.getByTestId("workspace-lifecycle-blobBudgetBytes")).toHaveValue(2_000_000_000)
  })

  it("preserves the host port allocation policy when saving edited lifecycle fields", async () => {
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")

    fireEvent.change(screen.getByTestId("workspace-lifecycle-activeDirectoryCap"), {
      target: { value: "40" },
    })
    fireEvent.click(screen.getByTestId("workspace-lifecycle-save"))

    await waitFor(() => expect(setWorkspaceLifecyclePolicyMock).toHaveBeenCalled())
    expect(setWorkspaceLifecyclePolicyMock).toHaveBeenCalledWith({
      activeDirectoryCap: 40,
      snapshotRetentionDays: 14,
      blobBudgetBytes: 2_000_000_000,
      sandboxSnapshotBudgetBytes: 536_870_912,
      portRangeStart: 42000,
      portRangeEnd: 45999,
      portBlockSize: 20,
    })
    expect(runWorkspaceUserActionMock).toHaveBeenCalledWith(
      "task_workspace_policy_set",
      expect.any(Function)
    )
  })

  it("preserves the separate sandbox snapshot budget when changing the blob budget", async () => {
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")

    fireEvent.change(screen.getByTestId("workspace-lifecycle-blobBudgetBytes"), {
      target: { value: "3000000000" },
    })
    fireEvent.click(screen.getByTestId("workspace-lifecycle-save"))

    await waitFor(() =>
      expect(setWorkspaceLifecyclePolicyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          blobBudgetBytes: 3_000_000_000,
          sandboxSnapshotBudgetBytes: 536_870_912,
        })
      )
    )
  })

  it("refuses a zero client-side, because the host does", async () => {
    // `service.rs::set_workspace_lifecycle_policy` rejects a zero on all three
    // fields. Catching it here is the difference between a disabled Save and a
    // raw Rust error string.
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")

    fireEvent.change(screen.getByTestId("workspace-lifecycle-snapshotRetentionDays"), {
      target: { value: "0" },
    })

    expect(screen.getByTestId("workspace-lifecycle-save")).toBeDisabled()
    fireEvent.click(screen.getByTestId("workspace-lifecycle-save"))
    expect(setWorkspaceLifecyclePolicyMock).not.toHaveBeenCalled()
  })

  it("keeps Save inert until something actually changed", async () => {
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")

    expect(screen.getByTestId("workspace-lifecycle-save")).toBeDisabled()
  })

  it("surfaces the verbatim host policy read error", async () => {
    getWorkspaceLifecyclePolicyMock.mockRejectedValue(new Error("unsupported"))
    render(<MaintenanceTab />)

    await waitFor(() => expect(getWorkspaceLifecyclePolicyMock).toHaveBeenCalled())
    expect(await screen.findByRole("alert")).toHaveTextContent("unsupported")
  })
})

describe("<MaintenanceTab /> port policy", () => {
  it("mounts lease management and shows inclusive range capacity", async () => {
    render(<MaintenanceTab />)
    expect(screen.getByTestId("port-leases-block")).toBeInTheDocument()
    await screen.findByTestId("workspace-lifecycle-policy")
    expect(screen.getByText("Capacity: 200 blocks")).toBeInTheDocument()
    expect(screen.getByText(/Changes affect only new leases/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Last port"), { target: { value: "42040" } })
    expect(screen.getByText("Capacity: 2 blocks")).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("First port"), { target: { value: "42040" } })
    fireEvent.change(screen.getByLabelText("Ports per block"), { target: { value: "1" } })
    expect(screen.getByText("Capacity: 1 blocks")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("workspace-lifecycle-save"))
    await waitFor(() =>
      expect(setWorkspaceLifecyclePolicyMock).toHaveBeenCalledWith(
        expect.objectContaining({
          portRangeStart: 42040,
          portRangeEnd: 42040,
          portBlockSize: 1,
        })
      )
    )
  })

  it.each([
    ["First port", "1023"],
    ["First port", "46000"],
    ["First port", "42000.5"],
    ["Last port", "65536"],
    ["Last port", "41999"],
    ["Last port", ""],
    ["Ports per block", "0"],
    ["Ports per block", "4001"],
    ["Ports per block", "1.5"],
  ])("rejects invalid %s = %s before saving", async (field, value) => {
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")
    fireEvent.change(screen.getByLabelText(field), { target: { value } })
    expect(screen.getByTestId("workspace-lifecycle-save")).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("Use whole numbers")
    fireEvent.click(screen.getByTestId("workspace-lifecycle-save"))
    expect(setWorkspaceLifecyclePolicyMock).not.toHaveBeenCalled()
  })

  it("shows server save errors verbatim", async () => {
    setWorkspaceLifecyclePolicyMock.mockRejectedValue(
      new Error("host policy refused: database is locked")
    )
    render(<MaintenanceTab />)
    await screen.findByTestId("workspace-lifecycle-policy")
    fireEvent.change(screen.getByLabelText("First port"), { target: { value: "41000" } })
    fireEvent.click(screen.getByTestId("workspace-lifecycle-save"))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "host policy refused: database is locked"
    )
  })
})
