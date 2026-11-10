/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { render, screen, within } from "@testing-library/react"
import { DataOverviewTab } from "./data-overview-tab"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { toast } from "sonner"
import type { StorageStats } from "@/lib/storage"
import { getCleanupTargetKey } from "@/lib/storage"
import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
jest.mock("@/lib/storage", () => {
  const actual = jest.requireActual("@/lib/storage")
  return { ...actual, getCleanupTargetKey: jest.fn(actual.getCleanupTargetKey) }
})
let mockStats: StorageStats | null = null
const mockCleanup = jest.fn()
const mockPreview = jest.fn()
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

let mockSnapshot: unknown = null
jest.mock("@/lib/storage/retention", () => ({ getStorageRetentionSnapshot: () => mockSnapshot }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    key === "breakdown.cleared" ? `${key}:${values?.count}` : key,
}))
jest.mock("@/hooks/data/use-backup-history", () => ({
  useBackupHistory: () => [],
  useLatestSuccessfulBackup: () => null,
  clearBackupHistory: jest.fn(),
  deleteBackupHistory: jest.fn(),
}))
jest.mock("@/hooks/storage", () => ({
  useStorageBreakdown: () => ({
    stats: mockStats,
    health: null,
    isLoading: false,
    refresh: jest.fn(),
    formatBytes: String,
  }),
  useStorageCleanup: () => ({
    cleanup: mockCleanup,
    preview: mockPreview,
    targetKey: getCleanupTargetKey(),
    isRunning: false,
  }),
}))
jest.mock("@/components/data/shared/storage-usage-display", () => ({
  StorageUsageDisplay: () => null,
}))
jest.mock("@/components/data/import/reminder-banner", () => ({ ReminderBanner: () => null }))
jest.mock("@/components/data/storage/local-persistence-visibility-panel", () => ({
  LocalPersistenceVisibilityPanel: () => null,
}))

beforeEach(() => {
  mockSnapshot = null
  mockStats = null
  jest.clearAllMocks()
})

it("shows unknown when this runtime has no sweep evidence", async () => {
  render(<DataOverviewTab />)
  expect(await screen.findByText("retentionHealth.unknown")).toBeInTheDocument()
  expect(screen.getByText("retentionHealth.title").closest("details")).not.toHaveAttribute("open")
})

it("renders failed and partial stages in passive details without error content", async () => {
  mockSnapshot = {
    completedAt: 1000,
    results: [
      {
        id: "mediaGenerationJobs",
        removed: 1,
        status: "partial",
        reason: "file-delete-failed",
        stages: [{ id: "files", removed: 0, status: "failed", reason: "prune-failed" }],
      },
    ],
  }
  render(<DataOverviewTab />)
  expect(await screen.findByText(/retentionHealth\.status\.partial/)).toBeInTheDocument()
  expect(screen.getByText(/retentionHealth\.status\.failed/)).toBeInTheDocument()
  expect(screen.getByText(/retentionHealth\.reasons\.file-delete-failed/)).toBeInTheDocument()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

async function openCategoryConfirmation() {
  mockStats = {
    total: { used: 100, quota: 1000, usagePercent: 10 },
    indexedDB: { used: 100 },
    localStorage: { used: 0 },
    generatedAt: 1,
    byCategory: [
      {
        category: "backupHistory",
        displayName: "Backup history",
        itemCount: 1,
        totalSize: 100,
        sources: ["backupHistory"],
      },
    ],
  }
  mockPreview.mockResolvedValue({ deletedItems: 1, freedSpace: 100, details: [], errors: [] })
  const user = userEvent.setup()
  render(
    <TooltipProvider>
      <DataOverviewTab />
    </TooltipProvider>
  )
  await user.click(screen.getByRole("button", { name: "viewDetails" }))
  await user.click(screen.getByRole("button", { name: "clearCategory" }))
  return { user, dialog: within(await screen.findByRole("alertdialog")) }
}

it("requires explicit confirmation and cancellation preserves the category", async () => {
  const { user, dialog } = await openCategoryConfirmation()
  expect(mockCleanup).not.toHaveBeenCalled()
  await user.click(dialog.getByRole("button", { name: "cancel" }))
  expect(mockCleanup).not.toHaveBeenCalled()
})

it("refuses the old Overview confirmation after switching the runtime target", async () => {
  const { user, dialog } = await openCategoryConfirmation()
  activateAccountDatabase("storage-preview", "target-b")
  setActiveRuntimeTargetContext("storage-preview", "target-b")
  try {
    await getDb().backupHistory.put({ id: "target-b-history", completedAt: 1 } as never)
    await user.click(dialog.getByRole("button", { name: "cleanup.confirm" }))
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(await getDb().backupHistory.get("target-b-history")).toBeDefined()
    expect(toast.error).toHaveBeenCalledWith("cleanup.targetChanged")
  } finally {
    await getDb().delete()
    clearAccountDatabaseSelection()
    clearActiveRuntimeTargetContext()
  }
})

it("requires a fresh Overview preview when the confirmation target is unknown", async () => {
  const { user, dialog } = await openCategoryConfirmation()
  jest.mocked(getCleanupTargetKey).mockReturnValue("")
  try {
    await user.click(dialog.getByRole("button", { name: "cleanup.confirm" }))
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith("cleanup.targetChanged")
  } finally {
    jest
      .mocked(getCleanupTargetKey)
      .mockImplementation(jest.requireActual("@/lib/storage").getCleanupTargetKey)
  }
})

it.each([
  { deletedItems: 1, errors: ["delete failed"] },
  { deletedItems: 0, errors: ["delete failed"] },
])("reports cleanup errors as failure: %j", async (result) => {
  mockCleanup.mockResolvedValue({ ...result, freedSpace: 0, details: [] })
  const { user, dialog } = await openCategoryConfirmation()
  await user.click(dialog.getByRole("button", { name: "cleanup.confirm" }))
  expect(mockCleanup).toHaveBeenCalledWith({
    categories: ["backupHistory"],
    targetKey: getCleanupTargetKey(),
  })
  expect(toast.error).toHaveBeenCalledWith("cleanup.failed")
  expect(toast.success).not.toHaveBeenCalled()
})

it.each([0, 1])(
  "reports success with the actual count of %i deleted rows",
  async (deletedItems) => {
    mockCleanup.mockResolvedValue({ deletedItems, freedSpace: 100, details: [], errors: [] })
    const { user, dialog } = await openCategoryConfirmation()
    await user.click(dialog.getByRole("button", { name: "cleanup.confirm" }))
    expect(toast.success).toHaveBeenCalledWith(`breakdown.cleared:${deletedItems}`)
    expect(toast.error).not.toHaveBeenCalled()
  }
)
