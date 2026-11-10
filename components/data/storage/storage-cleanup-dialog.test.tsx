import "fake-indexeddb/auto"
import Dexie from "dexie"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { StorageCleanupDialog } from "./storage-cleanup-dialog"
import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getCleanupCategoryAvailability, getCleanupTargetKey } from "@/lib/storage"
import {
  setActiveRuntimeTargetContext,
  clearActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
jest.mock("@/lib/tauri/transport-companion", () => ({
  ...jest.requireActual("@/lib/tauri/transport-companion"),
  loadCompanionConfig: jest.fn(() => null),
}))
jest.mock("@/lib/storage", () => {
  const actual = jest.requireActual("@/lib/storage")
  return {
    ...actual,
    getCleanupCategoryAvailability: jest.fn(actual.getCleanupCategoryAvailability),
    getCleanupTargetKey: jest.fn(actual.getCleanupTargetKey),
  }
})
const fixture = createDbTestFixture()
beforeAll(async () => {
  Object.assign(
    jest.requireActual("@/i18n/messages/en.json").settings.data,
    jest.requireActual("@/i18n/messages/en/settings/data.json")
  )
  await fixture.initialize()
})
beforeEach(fixture.restore)
afterAll(fixture.dispose)

const messages = {
  settings: {
    data: {
      cleanup: {
        title: "Storage cleanup",
        desc: "Free up space.",
        button: "Cleanup",
        tabs: { quick: "Quick", custom: "Custom", deep: "Deep" },
        quickDesc: "Safe & fast.",
        customDesc: "Pick categories.",
        deepDesc: "Aggressive.",
        deepWarning: "Removes data older than 7 days.",
        runQuick: "Run quick cleanup",
        runDeep: "Run deep cleanup",
        preview: "Preview",
        confirm: "Confirm cleanup",
        complete: "Cleanup complete!",
        freedSpace: "Freed space",
        deletedItems: "Deleted items",
        errors: "{count} errors occurred",
        willBeFreed: "will be freed",
        itemsWillBeDeleted: "{count} items will be deleted",
        back: "Back",
        done: "Done",
      },
    },
  },
  common: { done: "Done" },
}

function renderDialog() {
  const onComplete = jest.fn()
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StorageCleanupDialog formatBytes={(n) => `${n} B`} onCleanupComplete={onComplete} />
    </NextIntlClientProvider>
  )
  return { ...utils, onComplete }
}

describe("StorageCleanupDialog", () => {
  it("opens the dialog when the trigger is clicked", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /cleanup/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    // Global jest mock pulls translations from `i18n/messages/en.json`, where
    // the quick-cleanup blurb reads "Clears transient buckets ... Safe and fast.".
    expect(screen.getByText(/safe and fast/i)).toBeInTheDocument()
  })

  it("renders the three cleanup-mode tabs", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /cleanup/i }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("tab", { name: /quick/i })).toBeInTheDocument()
    expect(within(dialog).getByRole("tab", { name: /custom/i })).toBeInTheDocument()
    expect(within(dialog).getByRole("tab", { name: /deep/i })).toBeInTheDocument()
  })

  it("custom tab swaps in the custom-cleanup description", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole("button", { name: /cleanup/i }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/safe and fast/i)).toBeInTheDocument()
    // userEvent simulates real pointer events that radix Tabs requires.
    await user.click(within(dialog).getByRole("tab", { name: /custom/i }))
    expect(await within(dialog).findByText(/pick which categories/i)).toBeInTheDocument()
  })
})

it("keeps phone margins and makes long cleanup panels vertically scrollable", () => {
  renderDialog()
  fireEvent.click(screen.getByRole("button", { name: /cleanup/i }))
  expect(screen.getByRole("dialog")).toHaveClass("max-h-[85vh]", "overflow-y-auto", "sm:max-w-lg")
})

it("disables empty Custom cleanup and preview without deleting data", async () => {
  const db = getDb()
  await db.sessions.put({ id: "keep-session" } as never)
  await db.messages.put({ id: "keep-message", sessionId: "keep-session" } as never)
  const user = userEvent.setup()
  renderDialog()
  await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
  const dialog = within(screen.getByRole("dialog"))
  await user.click(dialog.getByRole("tab", { name: /custom/i }))
  expect(dialog.getByRole("button", { name: /^cleanup$/i })).toBeDisabled()
  expect(dialog.getByRole("button", { name: /^preview$/i })).toBeDisabled()
  expect(await db.sessions.get("keep-session")).toBeDefined()
  expect(await db.messages.get("keep-message")).toBeDefined()
})

it("renders Host-managed categories as inert labelled controls", async () => {
  const actual = jest.requireActual("@/lib/storage").getCleanupCategoryAvailability
  // Presentation contract for a category containing only mirrored sources;
  // cleanup.test.ts separately checks the real source mapping policy.
  jest
    .mocked(getCleanupCategoryAvailability)
    .mockImplementation((category, sources) =>
      category === "session" ? "host-managed" : actual(category, sources)
    )
  try {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
    const dialog = within(screen.getByRole("dialog"))
    await user.click(dialog.getByRole("tab", { name: /custom/i }))
    expect(dialog.getByRole("checkbox", { name: /^Sessions/ })).toBeDisabled()
    expect(dialog.getByText("Managed by the Host")).toBeInTheDocument()
    expect(dialog.getByRole("checkbox", { name: /^Backup history$/ })).toBeEnabled()
  } finally {
    jest.mocked(getCleanupCategoryAvailability).mockImplementation(actual)
  }
})

it("labels paired categories with local-only data and keeps their controls enabled", async () => {
  jest
    .mocked(loadCompanionConfig)
    .mockReturnValue({ deviceId: "paired", targetId: "host" } as never)
  try {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
    const dialog = within(screen.getByRole("dialog"))
    await user.click(dialog.getByRole("tab", { name: /custom/i }))
    const sessions = dialog.getByRole("checkbox", { name: /^Sessions/ })
    expect(sessions).toBeEnabled()
    expect(
      within(sessions.parentElement!).getByText(
        "Host data is managed by the Host. Cleanup affects local-only data."
      )
    ).toBeInTheDocument()
    expect(dialog.getByRole("checkbox", { name: /^Backup history$/ })).toBeEnabled()
  } finally {
    jest.mocked(loadCompanionConfig).mockReturnValue(null)
  }
})

it("freezes the selection during preview and confirms its exact categories", async () => {
  const db = getDb()
  await db.backupHistory.put({ id: "preview-history", completedAt: 1 } as never)
  await db.sessions.put({ id: "unselected-session" } as never)
  const table = db.tables.find((entry) => entry.name === "backupHistory")!
  const read = table.toArray.bind(table)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const spy = jest
    .spyOn(table, "toArray")
    .mockImplementationOnce(() => Dexie.Promise.resolve(gate).then(() => read()))
  const user = userEvent.setup()
  renderDialog()
  await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
  const dialog = within(screen.getByRole("dialog"))
  await user.click(dialog.getByRole("tab", { name: /custom/i }))
  await user.click(dialog.getByRole("checkbox", { name: /^backup history$/i }))
  await user.click(dialog.getByRole("button", { name: /^preview$/i }))
  expect(dialog.getByRole("checkbox", { name: /^sessions/i })).toBeDisabled()
  await user.click(dialog.getByRole("checkbox", { name: /^sessions/i }))
  await act(async () => release())
  await user.click(await dialog.findByRole("button", { name: /^confirm cleanup$/i }))
  await dialog.findByText("Cleanup complete!")
  expect(await db.backupHistory.get("preview-history")).toBeUndefined()
  expect(await db.sessions.get("unselected-session")).toBeDefined()
  spy.mockRestore()
})

it("discards a preview response after closing and changing selection", async () => {
  const db = getDb()
  const table = db.tables.find((entry) => entry.name === "backupHistory")!
  let release!: () => void
  const spy = jest.spyOn(table, "toArray").mockImplementationOnce(
    () =>
      new Dexie.Promise<never[]>((resolve) => {
        release = () => resolve([])
      })
  )
  const user = userEvent.setup()
  renderDialog()
  await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
  let dialog = within(screen.getByRole("dialog"))
  await user.click(dialog.getByRole("tab", { name: /custom/i }))
  await user.click(dialog.getByRole("checkbox", { name: /^backup history$/i }))
  await user.click(dialog.getByRole("button", { name: /^preview$/i }))
  await user.keyboard("{Escape}")
  await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
  await act(async () => release())
  dialog = within(screen.getByRole("dialog"))
  expect(dialog.queryByRole("button", { name: /^confirm cleanup$/i })).toBeNull()
  expect(dialog.getByRole("tab", { name: /custom/i })).toBeInTheDocument()
  spy.mockRestore()
})

it("renders a failure after a rejected delete, without a completion message", async () => {
  const db = getDb()
  await db.backupHistory.put({ id: "failed-delete", completedAt: 1 } as never)
  const table = db.tables.find((entry) => entry.name === "backupHistory")!
  const spy = jest.spyOn(table, "bulkDelete").mockRejectedValueOnce(new Error("refused"))
  const user = userEvent.setup()
  renderDialog()
  await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
  const dialog = within(screen.getByRole("dialog"))
  await user.click(dialog.getByRole("tab", { name: /custom/i }))
  await user.click(dialog.getByRole("checkbox", { name: /^backup history$/i }))
  await user.click(dialog.getByRole("button", { name: /^cleanup$/i }))
  expect(await dialog.findByRole("alert")).toHaveTextContent("Cleanup could not be completed.")
  expect(dialog.queryByText("Cleanup complete!")).toBeNull()
  expect(await db.backupHistory.get("failed-delete")).toBeDefined()
  spy.mockRestore()
})

it("succeeds with the actual count when previewed rows were removed meanwhile", async () => {
  const db = getDb()
  await db.backupHistory.put({ id: "removed-after-preview", completedAt: 1 } as never)
  const user = userEvent.setup()
  renderDialog()
  await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
  const dialog = within(screen.getByRole("dialog"))
  await user.click(dialog.getByRole("tab", { name: /custom/i }))
  await user.click(dialog.getByRole("checkbox", { name: /^backup history$/i }))
  await user.click(dialog.getByRole("button", { name: /^preview$/i }))
  await dialog.findByRole("button", { name: /^confirm cleanup$/i })
  await db.backupHistory.delete("removed-after-preview")
  await user.click(dialog.getByRole("button", { name: /^confirm cleanup$/i }))
  expect(await dialog.findByText("Cleanup complete!")).toBeInTheDocument()
  expect(dialog.queryByRole("alert")).toBeNull()
  expect(dialog.getByText("Deleted items").parentElement).toHaveTextContent("0")
})

it("refuses the old Custom confirmation after switching the runtime target", async () => {
  await getDb().backupHistory.put({ id: "target-a-history", completedAt: 1 } as never)
  const user = userEvent.setup()
  const { unmount } = renderDialog()
  await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
  const dialog = within(screen.getByRole("dialog"))
  await user.click(dialog.getByRole("tab", { name: /custom/i }))
  await user.click(dialog.getByRole("checkbox", { name: /^backup history$/i }))
  await user.click(dialog.getByRole("button", { name: /^preview$/i }))
  const confirm = await dialog.findByRole("button", { name: /^confirm cleanup$/i })
  activateAccountDatabase("storage-preview", "target-b")
  try {
    await getDb().backupHistory.put({ id: "target-b-history", completedAt: 1 } as never)
    act(() => setActiveRuntimeTargetContext("storage-preview", "target-b"))
    await user.click(confirm)
    expect(await getDb().backupHistory.get("target-b-history")).toBeDefined()
    expect(dialog.queryByRole("button", { name: /^confirm cleanup$/i })).toBeNull()
    await user.click(dialog.getByRole("tab", { name: /custom/i }))
    expect(dialog.getByRole("button", { name: /^cleanup$/i })).toBeDisabled()
  } finally {
    unmount()
    await getDb().delete()
    clearAccountDatabaseSelection()
    clearActiveRuntimeTargetContext()
  }
})

it("requires a fresh Custom preview when the confirmation target is unknown", async () => {
  await getDb().backupHistory.put({ id: "unknown-target-history", completedAt: 1 } as never)
  const user = userEvent.setup()
  const { unmount } = renderDialog()
  await user.click(screen.getByRole("button", { name: /^cleanup$/i }))
  const dialog = within(screen.getByRole("dialog"))
  await user.click(dialog.getByRole("tab", { name: /custom/i }))
  await user.click(dialog.getByRole("checkbox", { name: /^backup history$/i }))
  await user.click(dialog.getByRole("button", { name: /^preview$/i }))
  const confirm = await dialog.findByRole("button", { name: /^confirm cleanup$/i })
  jest.mocked(getCleanupTargetKey).mockReturnValue("")
  try {
    await user.click(confirm)
    expect(await getDb().backupHistory.get("unknown-target-history")).toBeDefined()
    expect(dialog.queryByRole("button", { name: /^confirm cleanup$/i })).toBeNull()
  } finally {
    unmount()
    jest
      .mocked(getCleanupTargetKey)
      .mockImplementation(jest.requireActual("@/lib/storage").getCleanupTargetKey)
  }
})
