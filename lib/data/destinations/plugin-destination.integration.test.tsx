/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { PluginBackupDestinations } from "@/components/settings/data/plugin-backup-destinations"
import { BackupScheduleDialog } from "@/components/scheduler/backup-schedule-dialog"
import { createBackupAPI } from "@/lib/plugin/api/backup-api"
import { unregisterBackupDestinationsForPlugin } from "@/lib/plugin/bridge/backup-destinations-bridge"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { getDb, whenSeeded } from "@/lib/db/schema"
import { saveSettings } from "@/lib/db/settings"
import { listBackupHistory } from "@/lib/db/backup-history"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { executeBackupTask } from "@/lib/scheduler/executors/backup-executor"
import { clearSyncPassphrase, setSyncPassphrase } from "@/lib/webdav/passphrase-cache"
import { decryptBackupPackage } from "@/lib/data/crypto"
import { runRemoteBackupSyncNow } from "./sync-now"
import { dispatchBackupDestination, readBackupDestinationReadiness } from "./index"
import type { PluginManifest } from "@/types/plugin"
import {
  DEFAULT_EXECUTION_CONFIG,
  type BackupDestination,
  type ScheduledTask,
  type TaskExecution,
} from "@/types/scheduler"
import type {
  BackupDestinationContribution,
  BackupDestinationResult,
} from "@cognia/plugin-contract/types/plugin/plugin-backup-destinations"
import dataMessages from "@/i18n/messages/en/settings/data.json"
import schedulerMessages from "@/i18n/messages/en/scheduler.json"

jest.mock("@/lib/data/build-package", () => ({
  buildBackupPackage: async () => ({
    manifest: {
      version: "3.0",
      schemaVersion: 3,
      exportedAt: "2026-11-01T00:00:00.000Z",
      traceId: "test",
      appVersion: "test",
      backend: "web-dexie",
    },
    payload: { settings: { marker: "PLAINTEXT_MARKER" } },
  }),
  serializePackage: (pkg: unknown) => JSON.stringify(pkg),
}))
jest.mock("@/lib/data/retrieval-key-backup", () => ({
  attachPortableRetrievalKeys: async (pkg: unknown) => pkg,
}))
jest.mock("@/lib/scheduler/host-support", () => ({
  assertTaskTypeSupportedOnHost: () => undefined,
}))
jest.mock("@/lib/data/backup-host-filesystem", () => ({
  resolveBackupHostFilesystem: async () => null,
}))
jest.mock("@/hooks/scheduler", () => {
  const createTask = jest.fn(async () => ({ id: "retained-task" }))
  return { useScheduler: () => ({ createTask }), __createTask: createTask }
})

const manifest = {
  id: "fake-backup",
  backupDestinations: [{ id: "archive", label: "Fake Archive" }],
} as PluginManifest
const destination = "plugin:fake-backup/archive" as const
function register(overrides: Partial<BackupDestinationContribution> = {}) {
  getPermissionGuard().registerPlugin(manifest.id, ["backup:destination"])
  const contribution: BackupDestinationContribution = {
    id: "archive",
    label: "Fake Archive",
    readiness: async () => ({ state: "ready" }),
    upload: jest.fn(async ({ meta }) => ({ remoteId: "remote-one", bytes: meta.bytes })),
    ...overrides,
  }
  const registration = createBackupAPI(manifest.id, manifest).registerDestination(contribution)
  return { contribution, registration }
}
function task(target: BackupDestination = destination): ScheduledTask {
  return {
    id: "retained-task",
    name: "Backup",
    type: "backup",
    payload: { destination: target },
    trigger: { type: "cron", cronExpression: "0 0 * * *" },
    config: DEFAULT_EXECUTION_CONFIG,
    notification: { onStart: false, onComplete: false, onError: false },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}
const execution = { id: "execution", taskId: "retained-task" } as TaskExecution
const view = (children: React.ReactNode) => (
  <NextIntlClientProvider
    locale="en"
    messages={{
      settings: { data: dataMessages },
      scheduler: schedulerMessages,
      common: { cancel: "Cancel" },
    }}
  >
    {children}
  </NextIntlClientProvider>
)

jest.setTimeout(30_000)
beforeEach(async () => {
  await whenSeeded()
  await getDb().backupHistory.clear()
  await schedulerDb.clearAll()
  resetPermissionGuard()
  setSyncPassphrase("host-sync-passphrase")
})
afterEach(() => {
  unregisterBackupDestinationsForPlugin(manifest.id)
  clearSyncPassphrase()
})

it("registers into settings/dialog, sends ciphertext manually and on schedule, preserves a disabled task, and works after re-enable", async () => {
  const seen: string[] = []
  register({
    upload: async ({ body, meta }) => {
      expect(ArrayBuffer.isView(body)).toBe(true)
      const json = new TextDecoder().decode(body as Uint8Array)
      expect(json).not.toContain("PLAINTEXT_MARKER")
      expect(meta.encryption).toBe("passphrase")
      expect(Object.keys(meta).sort()).toEqual([
        "bytes",
        "contentType",
        "createdAt",
        "encryption",
        "snapshotId",
      ])
      expect(await decryptBackupPackage(JSON.parse(json), "host-sync-passphrase")).toContain(
        "PLAINTEXT_MARKER"
      )
      seen.push(json)
      return { remoteId: "remote-one", bytes: meta.bytes }
    },
  })
  const mounted = render(view(<PluginBackupDestinations />))
  expect(await screen.findByRole("heading", { name: "Fake Archive" })).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Back up now" }))
  await waitFor(async () => expect(await listBackupHistory()).not.toHaveLength(0))
  expect((await listBackupHistory())[0]?.errorMessage).toBeUndefined()
  expect(seen).toHaveLength(1)
  await waitFor(async () =>
    expect(
      (await listBackupHistory()).some(
        (row) => row.type === "manual" && row.destination === destination && row.success
      )
    ).toBe(true)
  )
  mounted.rerender(view(<BackupScheduleDialog open />))
  const user = userEvent.setup()
  await user.click(screen.getAllByRole("combobox").at(-1)!)
  expect(await screen.findByRole("option", { name: "Fake Archive" })).toBeInTheDocument()
  await user.click(screen.getByRole("option", { name: "Fake Archive" }))
  await user.click(screen.getByRole("button", { name: /^Schedule$/ }))
  const createTask = jest.requireMock("@/hooks/scheduler").__createTask as jest.Mock
  await waitFor(() => expect(createTask).toHaveBeenCalled())
  expect(createTask.mock.calls.at(-1)![0].payload.destination).toBe(destination)
  mounted.rerender(view(<PluginBackupDestinations />))
  const saved = { ...task(), payload: createTask.mock.calls.at(-1)![0].payload }
  await schedulerDb.createTask(saved)
  expect((await executeBackupTask(saved, execution, new AbortController().signal)).success).toBe(
    true
  )
  expect(seen).toHaveLength(2)
  act(() => unregisterBackupDestinationsForPlugin(manifest.id))
  expect(screen.queryByRole("heading", { name: "Fake Archive" })).not.toBeInTheDocument()
  const unavailable = await executeBackupTask(saved, execution, new AbortController().signal)
  expect(unavailable).toMatchObject({
    success: false,
    error: "destination unavailable on this runtime",
  })
  expect((await schedulerDb.getTask(saved.id))?.payload).toEqual(saved.payload)
  expect(
    (await listBackupHistory()).some(
      (row) =>
        row.destination === destination &&
        row.errorMessage === "destination unavailable on this runtime"
    )
  ).toBe(true)
  act(() => {
    register()
  })
  expect((await executeBackupTask(saved, execution, new AbortController().signal)).success).toBe(
    true
  )
})

it.each(["task", "dispose", "permission"])(
  "cancels scheduled uploads on %s, records cancellation, and drops a late success",
  async (cause) => {
    let active!: AbortSignal
    let finish!: (result: BackupDestinationResult) => void
    const { registration } = register({
      upload: async (_input, signal) => {
        active = signal
        return new Promise<BackupDestinationResult>((resolve) => {
          finish = resolve
        })
      },
    })
    const controller = new AbortController()
    const pending = executeBackupTask(task(), execution, controller.signal)
    await waitFor(() => expect(active).toBeDefined())
    if (cause === "task") controller.abort()
    else if (cause === "permission") getPermissionGuard().revoke(manifest.id, "backup:destination")
    else registration.unregister()
    expect(active.aborted).toBe(true)
    if (cause === "permission")
      expect(await readBackupDestinationReadiness(destination)).toMatchObject({
        state: "unavailable",
      })
    expect((await pending).success).toBe(false)
    finish({ remoteId: "late", bytes: 123 })
    await Promise.resolve()
    const rows = await listBackupHistory()
    expect(rows.filter((row) => row.destination === destination)).toEqual([
      expect.objectContaining({ success: false, result: { status: "cancelled" } }),
    ])
  }
)

it("all uploads only ready registry entries and records every not-ready leg with its reason", async () => {
  const { contribution } = register()
  const otherManifest = {
    id: "locked-backup",
    backupDestinations: [{ id: "archive", label: "Locked Archive" }],
  } as PluginManifest
  getPermissionGuard().registerPlugin(otherManifest.id, ["backup:destination"])
  const upload = jest.fn()
  const other = createBackupAPI(otherManifest.id, otherManifest).registerDestination({
    id: "archive",
    label: "Locked Archive",
    readiness: async () => ({ state: "needs-auth", reasonKey: "signIn" }),
    upload,
  })
  try {
    expect(
      (await executeBackupTask(task("all"), execution, new AbortController().signal)).success
    ).toBe(true)
    expect(contribution.upload).toHaveBeenCalledTimes(1)
    expect(upload).not.toHaveBeenCalled()
    expect(
      (await listBackupHistory()).find((row) => row.destination === other.destinationId)
    ).toMatchObject({
      success: false,
      errorMessage: "skipped: not ready (signIn)",
      result: { status: "skipped", reasonKey: "signIn" },
    })
  } finally {
    other.unregister()
  }
})

it("reports Host needs-setup without a key and refuses plaintext even at the dispatch boundary", async () => {
  const { contribution } = register()
  clearSyncPassphrase()
  expect(await readBackupDestinationReadiness(destination)).toEqual({
    state: "needs-setup",
    reasonKey: "syncPassphraseLocked",
  })
  expect((await runRemoteBackupSyncNow(destination, "")).ok).toBe(false)
  expect(
    await dispatchBackupDestination(destination, JSON.stringify({ marker: "PLAINTEXT_MARKER" }), {
      filename: "one",
      exportedAt: "2026-11-01",
      sizeBytes: 1,
    })
  ).toMatchObject({ ok: false, error: "Remote backup requires ciphertext" })
  expect(contribution.upload).not.toHaveBeenCalled()
})

it("keeps plugin retention in the Host, preserving the current snapshot and pruning only dated older snapshots", async () => {
  await saveSettings({ backupAutoSchedule: { enabled: false, intervalDays: 7, retainCount: 2 } })
  const remove = jest.fn(async () => undefined)
  register({
    list: async () => [
      { remoteId: "remote-one", label: "Current", createdAt: "2026-11-01" },
      { remoteId: "recent", label: "Recent", createdAt: "2026-10-31" },
      { remoteId: "old", label: "Old", createdAt: "2026-10-30" },
      { remoteId: "undated", label: "Undated" },
    ],
    delete: remove,
  })
  expect((await runRemoteBackupSyncNow(destination, "")).ok).toBe(true)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(remove).toHaveBeenCalledWith("old", expect.any(AbortSignal))
})

it.each(["task", "dispose"])(
  "records the original all-fanout leg on %s during readiness without a false local cancellation",
  async (cause) => {
    let active!: AbortSignal
    const { registration } = register({
      readiness: async (signal) => {
        active = signal
        return new Promise(() => undefined)
      },
    })
    const controller = new AbortController()
    const pending = executeBackupTask(task("all"), execution, controller.signal)
    await waitFor(() => expect(active).toBeDefined())
    if (cause === "task") controller.abort()
    else registration.unregister()
    expect((await pending).success).toBe(false)
    const rows = await listBackupHistory()
    expect(rows.filter((row) => row.destination === destination)).toEqual([
      expect.objectContaining({
        success: false,
        encryption: "passphrase",
        result: { status: "cancelled" },
      }),
    ])
    expect(
      rows.some((row) => row.destination === "local" && row.result?.status === "cancelled")
    ).toBe(false)
  }
)

it("records cancellation for an all task's active upload and remaining ready legs", async () => {
  let active!: AbortSignal
  let finish!: (result: BackupDestinationResult) => void
  register({
    upload: async (_input, signal) => {
      active = signal
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  const laterManifest = {
    id: "later-backup",
    backupDestinations: [{ id: "archive", label: "Later Archive" }],
  } as PluginManifest
  const laterUpload = jest.fn(async () => ({ remoteId: "later", bytes: 1 }))
  getPermissionGuard().registerPlugin(laterManifest.id, ["backup:destination"])
  createBackupAPI(laterManifest.id, laterManifest).registerDestination({
    id: "archive",
    label: "Later Archive",
    readiness: async () => ({ state: "ready" }),
    upload: laterUpload,
  })
  try {
    const controller = new AbortController()
    const pending = executeBackupTask(task("all"), execution, controller.signal)
    await waitFor(() => expect(active).toBeDefined())
    controller.abort()
    expect((await pending).success).toBe(false)
    expect(active.aborted).toBe(true)
    finish({ remoteId: "late-result", bytes: 1 })
    await Promise.resolve()
    expect(laterUpload).not.toHaveBeenCalled()
    const rows = await listBackupHistory()
    for (const id of [destination, "plugin:later-backup/archive"]) {
      expect(rows.filter((row) => row.destination === id)).toEqual([
        expect.objectContaining({ success: false, result: { status: "cancelled" } }),
      ])
    }
  } finally {
    unregisterBackupDestinationsForPlugin(laterManifest.id)
  }
})
