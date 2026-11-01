import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en/settings/data.json"
import { PluginBackupDestinations } from "./plugin-backup-destinations"
import { runRemoteBackupSyncNow } from "@/lib/data/destinations/sync-now"
import {
  listBackupDestinationSnapshots,
  restoreFromBackupDestination,
} from "@/lib/data/destinations/restore"

jest.mock("@/lib/data/destinations", () => ({
  getBackupDestinationRevision: () => 0,
  subscribeBackupDestinations: () => () => {},
  listBackupDestinations: () => [
    { id: "webdav", label: "WebDAV" },
    { id: "plugin:fake/archive", pluginId: "fake", label: "Archive" },
  ],
  readBackupDestinationReadiness: async () => ({ state: "ready" }),
}))
jest.mock("@/lib/data/destinations/sync-now", () => ({
  runRemoteBackupSyncNow: jest.fn(async () => ({ ok: true })),
}))
jest.mock("@/lib/data/destinations/restore", () => ({
  supportsBackupDestinationRestore: jest.fn(() => false),
  listBackupDestinationSnapshots: jest.fn(async () => [
    { remoteId: "remote", label: "Snapshot one" },
  ]),
  restoreFromBackupDestination: jest.fn(async () => ({})),
}))
jest.mock("@/lib/webdav/passphrase-cache", () => ({ getSyncPassphrase: () => "cached" }))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => ({
    destination: "plugin:fake/archive",
    success: true,
    result: { status: "success" },
  }),
}))
import { supportsBackupDestinationRestore } from "@/lib/data/destinations/restore"

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ settings: { data: messages } }}>
      <PluginBackupDestinations />
    </NextIntlClientProvider>
  )
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(supportsBackupDestinationRestore).mockReturnValue(false)
})

it("offers a generic plugin card with history, settings and Host backup but no restore without list/download", async () => {
  mount()
  expect(screen.getByRole("heading", { name: "Archive" })).toBeInTheDocument()
  expect(screen.queryByRole("heading", { name: "WebDAV" })).not.toBeInTheDocument()
  expect(screen.getByText("Last result: Succeeded")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Plugin settings" })).toHaveAttribute(
    "href",
    "/plugins?plugin=fake&subtab=configure"
  )
  expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled())
  fireEvent.change(screen.getByLabelText("Sync passphrase"), { target: { value: "typed-pass" } })
  fireEvent.click(screen.getByRole("button", { name: "Back up now" }))
  await waitFor(() =>
    expect(runRemoteBackupSyncNow).toHaveBeenCalledWith("plugin:fake/archive", "typed-pass", {
      signal: expect.any(AbortSignal),
    })
  )
})

it("offers snapshots and forwards ciphertext restore to the Host after confirmation", async () => {
  jest.mocked(supportsBackupDestinationRestore).mockReturnValue(true)
  mount()
  fireEvent.click(screen.getByRole("button", { name: "Restore" }))
  expect(await screen.findByRole("dialog")).toBeInTheDocument()
  expect(listBackupDestinationSnapshots).toHaveBeenCalledWith(
    "plugin:fake/archive",
    expect.any(AbortSignal)
  )
  const dialog = screen.getByRole("dialog")
  expect(within(dialog).getByRole("combobox", { name: "Snapshot" })).toHaveTextContent(
    "Snapshot one"
  )
  fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }))
  await waitFor(() =>
    expect(restoreFromBackupDestination).toHaveBeenCalledWith(
      "plugin:fake/archive",
      "remote",
      {
        passphrase: "cached",
        mergeStrategy: "skip",
        includeApiKey: false,
        onImportStart: expect.any(Function),
      },
      expect.any(AbortSignal)
    )
  )
})
