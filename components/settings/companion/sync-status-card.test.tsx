/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

const runSyncDown = jest.fn()
const snapshotSyncStates = jest.fn()

jest.mock("@/lib/sync/companion-sync", () => ({
  SYNC_HANDLER_TABLES: [
    "characters",
    "skills",
    "sessions",
    "messages",
    "workflows",
    "twinProfile",
    "plugins",
    "adapterInstances",
    "settings",
  ],
  runSyncDown: (...args: unknown[]) => runSyncDown(...args),
  snapshotSyncStates: () => snapshotSyncStates(),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

// Exercises the real `useHasSyncHost` hook: only the stored config is faked.
const loadCompanionConfig = jest.fn((): object | null => ({ deviceId: "dev" }))
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => loadCompanionConfig(),
}))

import { SyncStatusCard } from "./sync-status-card"
import { toast } from "sonner"

const messages = {
  mobile: {
    companion: {
      syncStatus: {
        title: "Sync Status",
        description: "Per-table sync state.",
        statusHealthy: "Healthy",
        statusErrors: "Errors",
        statusNeverSynced: "Not synced yet",
        statusNotPaired: "Not paired",
        statusPartial: "Partly synced",
        syncAll: "Sync all",
        syncAllAria: "Sync every table",
        colTable: "Table",
        colLastSync: "Last sync",
        colCursor: "Cursor",
        colActions: "Actions",
        never: "Never",
        syncNowAria: "Sync {table}",
        toastSyncOneOk: "{table} synced",
        toastSyncOneFail: "{table} failed: {reason}",
        toastSyncAllOk: "{count} tables synced",
        toastSyncAllPartial: "{failed}/{total} tables failed",
        tableLabels: {
          characters: "Characters",
          skills: "Skills",
          sessions: "Sessions",
          messages: "Messages",
          workflows: "Workflows",
          twinProfile: "Twin profile",
          plugins: "Plugins",
          adapterInstances: "Connectors",
          settings: "Settings",
        },
      },
    },
  },
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

function syncedStates() {
  const states = emptyStates()
  for (const table of Object.keys(states)) {
    states[table] = { lastSyncAt: 1_700_000_000_000, since: 3, lastError: null }
  }
  return states
}

function emptyStates() {
  const states: Record<
    string,
    { lastSyncAt: number | null; since: number; lastError: string | null }
  > = {}
  for (const table of messages.mobile.companion.syncStatus.tableLabels
    ? Object.keys(messages.mobile.companion.syncStatus.tableLabels)
    : []) {
    states[table] = { lastSyncAt: null, since: 0, lastError: null }
  }
  return states
}

describe("SyncStatusCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    snapshotSyncStates.mockReturnValue(emptyStates())
    loadCompanionConfig.mockReturnValue({ deviceId: "dev" })
  })

  it("renders a row for every registered handler", () => {
    render(withIntl(<SyncStatusCard />))
    expect(screen.getByTestId("sync-status-row-characters")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-skills")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-sessions")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-messages")).toBeInTheDocument()
    // The four "Wave 4" handlers that previously had no UI surface:
    expect(screen.getByTestId("sync-status-row-workflows")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-twinProfile")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-plugins")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-adapterInstances")).toBeInTheDocument()
    expect(screen.getByTestId("sync-status-row-settings")).toBeInTheDocument()
  })

  it("renders Never when a handler has not yet synced", () => {
    render(withIntl(<SyncStatusCard />))
    const row = screen.getByTestId("sync-status-row-characters")
    expect(row).toHaveTextContent("Never")
  })

  it("calls runSyncDown({ only: [table] }) when Sync now is clicked", async () => {
    const user = userEvent.setup()
    runSyncDown.mockResolvedValue([{ ok: true, result: { table: "characters", nextSince: 42 } }])
    render(withIntl(<SyncStatusCard />))
    const btn = screen.getByRole("button", { name: /Sync Characters/i })
    await user.click(btn)
    expect(runSyncDown).toHaveBeenCalledWith({ only: ["characters"] })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("toasts an error message when a per-table sync fails", async () => {
    const user = userEvent.setup()
    runSyncDown.mockResolvedValue([{ ok: false, failure: { message: "network down" } }])
    render(withIntl(<SyncStatusCard />))
    await user.click(screen.getByRole("button", { name: /Sync Skills/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("network down"))
    )
  })

  it('calls runSyncDown() with no args when "Sync all" is clicked', async () => {
    const user = userEvent.setup()
    runSyncDown.mockResolvedValue([
      { ok: true, result: { table: "characters", nextSince: 1 } },
      { ok: true, result: { table: "skills", nextSince: 1 } },
    ])
    render(withIntl(<SyncStatusCard />))
    await user.click(screen.getByRole("button", { name: /Sync every table/i }))
    expect(runSyncDown).toHaveBeenCalledWith()
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("surfaces lastError under the table label when present", async () => {
    const states = emptyStates()
    states.workflows = { lastSyncAt: null, since: 0, lastError: "auth failure" }
    snapshotSyncStates.mockReturnValue(states)
    render(withIntl(<SyncStatusCard />))
    expect(screen.getByTestId("sync-status-row-workflows-error")).toHaveTextContent("auth failure")
    expect(screen.getByTestId("sync-status-badge")).toHaveTextContent("Errors")
  })

  // Regression (A8): the badge used to read only `lastError`, and the scheduler
  // records none for a table that has never synced, so an all-never snapshot
  // showed a green "Healthy".
  it("does not call a snapshot that never synced healthy", () => {
    render(withIntl(<SyncStatusCard />))
    const badge = screen.getByTestId("sync-status-badge")
    expect(badge).toHaveAttribute("data-sync-overall", "never")
    expect(badge).toHaveTextContent("Not synced yet")
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument()
  })

  it("says partly synced when some tables synced and the rest never did", () => {
    const states = emptyStates()
    states.characters = { lastSyncAt: 1_700_000_000_000, since: 2, lastError: null }
    snapshotSyncStates.mockReturnValue(states)
    render(withIntl(<SyncStatusCard />))
    const badge = screen.getByTestId("sync-status-badge")
    expect(badge).toHaveAttribute("data-sync-overall", "partial")
    expect(badge).toHaveTextContent("Partly synced")
  })

  it("says not paired when there is no host, even if every table once synced", () => {
    loadCompanionConfig.mockReturnValue(null)
    snapshotSyncStates.mockReturnValue(syncedStates())
    render(withIntl(<SyncStatusCard />))
    const badge = screen.getByTestId("sync-status-badge")
    expect(badge).toHaveAttribute("data-sync-overall", "noHost")
    expect(badge).toHaveTextContent("Not paired")
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument()
  })

  it("shows the healthy badge only when every table synced and none failed", () => {
    snapshotSyncStates.mockReturnValue(syncedStates())
    render(withIntl(<SyncStatusCard />))
    const badge = screen.getByTestId("sync-status-badge")
    expect(badge).toHaveAttribute("data-sync-overall", "healthy")
    expect(badge).toHaveTextContent("Healthy")
  })
})
