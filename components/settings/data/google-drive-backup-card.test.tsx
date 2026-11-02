/** @jest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { __resetAuthRegistryForTesting } from "@/lib/plugin/auth/auth-provider-registry"
import { createGoogleDocsTestHost } from "@/lib/testing/google-docs-host"
import { __setGoogleStatePortForTests } from "@/lib/docs-providers/providers/google/state"
import { listGoogleConnections } from "@/lib/auth-providers/google/host-auth"
import {
  bindGoogleDriveConnection,
  resolveGoogleDriveConnection,
  GOOGLE_DRIVE_SCOPE,
} from "@/lib/data/destinations/google-oauth"
import "@/lib/data/destinations/builtins"
import { listBackupDestinations } from "@/lib/data/destinations/registry"
import { toast } from "sonner"
import { runRemoteBackupSyncNow } from "@/lib/data/destinations/sync-now"
import { GoogleDriveBackupCard } from "./google-drive-backup-card"

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/data/destinations/sync-now", () => ({ runRemoteBackupSyncNow: jest.fn() }))
jest.mock("@/lib/webdav/passphrase-cache", () => ({
  hasSyncPassphrase: () => true,
  loadPersistedSyncPassphrase: async () => true,
}))
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
afterAll(fixture.dispose)
let host: ReturnType<typeof createGoogleDocsTestHost>
beforeEach(async () => {
  await fixture.restore()
  __resetAuthRegistryForTesting()
  jest.clearAllMocks()
  await saveSettings({ backupDestinations: { googleDrive: { enabled: true, clientId: "backup" } } })
  host = createGoogleDocsTestHost({ clients: [{ clientId: "backup", hasClientSecret: true }] })
  __setGoogleStatePortForTests(host.call)
})
afterEach(async () => {
  cleanup()
  jest.useRealTimers()
  // Drain native reconciliation before replacing its port or disposing Dexie.
  await listGoogleConnections()
  __setGoogleStatePortForTests(null)
})

function addAccount(status: "connected" | "needs-reauth" = "connected") {
  host.snapshot.lineages = [
    {
      id: "native",
      clientId: "backup",
      method: "device-code",
      scopes: ["openid", "email", GOOGLE_DRIVE_SCOPE],
      sub: "sub",
      email: "ada@example.test",
      status,
      revision: "r1",
      credentialRevision: "c1",
      needsIdentity: false,
    },
  ]
}
async function begin() {
  fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }))
  await waitFor(() => expect(screen.getByText("ABCD")).toBeVisible())
  expect(screen.getByRole("link", { name: "https://google.com/device" })).toHaveAttribute(
    "href",
    "https://google.com/device"
  )
}
async function tick(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

it("writes the secret to Rust without reading it back and clears the input", async () => {
  render(<GoogleDriveBackupCard />)
  const input = await screen.findByRole("textbox", { name: "OAuth client ID" })
  await waitFor(() => expect(input).toHaveValue("backup"))
  const secret = screen.getByLabelText("OAuth client secret")
  expect(secret).toHaveValue("")
  fireEvent.change(secret, { target: { value: "private-secret" } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() =>
    expect(host.calls).toContainEqual({
      action: "setClientSecret",
      clientId: "backup",
      secret: "private-secret",
    })
  )
  await waitFor(() => expect(secret).toHaveValue(""))
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith("Google Drive backup settings saved")
  )
  expect(JSON.stringify(await getSettings())).not.toContain("private-secret")
})
it("displays the device code, honors pending and slow_down intervals, then binds the reported lineage", async () => {
  render(<GoogleDriveBackupCard />)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeEnabled()
  )
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  let polls = 0
  host.handle = async (input) => {
    if (input.action !== "pollDevice") return undefined
    polls++
    if (polls === 1) return { ...host.snapshot, pollStatus: "pending" }
    if (polls === 2) return { ...host.snapshot, pollStatus: "slow_down" }
    addAccount()
    return { ...host.snapshot, pollStatus: "connected", lineageId: "native" }
  }
  await begin()
  expect(host.calls).toContainEqual({
    action: "beginDevice",
    clientId: "backup",
    scopes: ["openid", "email", GOOGLE_DRIVE_SCOPE],
  })
  await tick(4999)
  expect(polls).toBe(0)
  await tick(1)
  expect(polls).toBe(1)
  await tick(5000)
  expect(polls).toBe(2)
  await tick(9999)
  expect(polls).toBe(2)
  await tick(1)
  expect(polls).toBe(3)
  jest.useRealTimers()
  await listGoogleConnections()
  await screen.findByText("Connected as ada@example.test", {}, { timeout: 5000 })
  expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBeTruthy()
})
it.each(["denied", "expired"] as const)(
  "reports terminal device authorization %s",
  async (pollStatus) => {
    render(<GoogleDriveBackupCard />)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeEnabled()
    )
    jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
    host.handle = async (input) =>
      input.action === "pollDevice" ? { ...host.snapshot, pollStatus } : undefined
    await begin()
    await tick(5000)
    expect(screen.getByRole("alert")).toHaveTextContent(
      pollStatus === "denied" ? "Authorization was denied" : "The device code expired — try again"
    )
    expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBeUndefined()
  }
)
it.each(["cancel", "unmount"])("cancels the Rust attempt on %s", async (action) => {
  const view = render(<GoogleDriveBackupCard />)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeEnabled()
  )
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  await begin()
  if (action === "unmount") view.unmount()
  else fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await tick(10_000)
  expect(host.calls).toContainEqual({ action: "cancel", attemptId: "google:fixture-1" })
  expect(host.calls.some((input) => input.action === "pollDevice")).toBe(false)
})
it("shows the connected account and disconnects through the driver before clearing the binding", async () => {
  addAccount()
  render(<GoogleDriveBackupCard />)
  await screen.findByText("Connected as ada@example.test")
  expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))
  await waitFor(() =>
    expect(host.calls).toContainEqual({ action: "disconnect", lineageId: "native" })
  )
  await waitFor(async () =>
    expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBeNull()
  )
  expect(host.snapshot.lineages[0].status).toBe("disconnected")
})
it("re-authorizes a device-code lineage through the Host driver", async () => {
  addAccount()
  render(<GoogleDriveBackupCard />)
  await screen.findByText("Connected as ada@example.test")
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  fireEvent.click(screen.getByRole("button", { name: "Re-authorize" }))
  await waitFor(() => expect(screen.getByText("ABCD")).toBeVisible())
  expect(host.calls).toContainEqual({
    action: "beginDevice",
    clientId: "backup",
    scopes: ["openid", "email", GOOGLE_DRIVE_SCOPE],
    reauthorizeLineage: "native",
  })
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await tick(1)
})
it("syncs the connected destination through the Host backup pipeline", async () => {
  addAccount()
  jest.mocked(runRemoteBackupSyncNow).mockResolvedValue({ ok: true } as never)
  render(<GoogleDriveBackupCard />)
  await waitFor(() => expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Sync now" }))
  await waitFor(() =>
    expect(runRemoteBackupSyncNow).toHaveBeenCalledWith("googledrive", "", expect.any(Object))
  )
})

it("requires a stored secret for the selected client before connecting", async () => {
  host.snapshot.clients = [{ clientId: "another-client", hasClientSecret: true }]
  render(<GoogleDriveBackupCard />)
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "OAuth client ID" })).toHaveValue("backup")
  )
  expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeDisabled()
  expect(screen.getByLabelText("OAuth client secret")).toHaveValue("")
})
it("cancels a challenge that arrives after the card has unmounted", async () => {
  let release!: () => void
  let pending = false
  host.handle = async (input) => {
    if (input.action === "beginDevice") {
      pending = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
    return undefined
  }
  const view = render(<GoogleDriveBackupCard />)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeEnabled()
  )
  fireEvent.click(screen.getByRole("button", { name: "Connect Google Drive" }))
  await waitFor(() => expect(pending).toBe(true))
  view.unmount()
  release()
  await waitFor(() =>
    expect(host.calls).toContainEqual({ action: "cancel", attemptId: "google:fixture-1" })
  )
})

it("disconnects account A without rebinding B, needs auth, then explicitly binds the polled lineage", async () => {
  addAccount()
  host.snapshot.lineages.push({
    ...host.snapshot.lineages[0],
    id: "other",
    sub: "other",
    email: "bob@example.test",
  })
  await bindGoogleDriveConnection("native")
  render(<GoogleDriveBackupCard />)
  await screen.findByText("Connected as ada@example.test")
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }))
  await waitFor(async () =>
    expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBeNull()
  )
  expect(await resolveGoogleDriveConnection()).toBeNull()
  const destination = listBackupDestinations().find((value) => value.id === "googledrive")!
  expect(await destination.readiness(new AbortController().signal)).toEqual({
    state: "needs-auth",
    reasonKey: "googledrive",
  })
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Connect Google Drive" })).toBeEnabled()
  )
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  host.handle = async (input) => {
    if (input.action !== "pollDevice") return undefined
    host.snapshot.lineages[0].status = "connected"
    host.snapshot.lineages[0].revision = "reauthorized"
    return { ...host.snapshot, pollStatus: "connected", lineageId: "native" }
  }
  await begin()
  await tick(5000)
  jest.useRealTimers()
  await listGoogleConnections()
  await screen.findByText("Connected as ada@example.test", {}, { timeout: 5000 })
  expect((await resolveGoogleDriveConnection())?.hostMetadata?.adapterId).toBe("native")
  expect(await destination.readiness(new AbortController().signal)).toEqual({ state: "ready" })
})

it("preserves explicit unbinding when saving a different backup client", async () => {
  await saveSettings({
    backupDestinations: { googleDrive: { enabled: true, clientId: "backup", connectionId: null } },
  })
  addAccount()
  host.snapshot.lineages[0].clientId = "other-client"
  render(<GoogleDriveBackupCard />)
  const input = await screen.findByRole("textbox", { name: "OAuth client ID" })
  await waitFor(() => expect(input).toHaveValue("backup"))
  fireEvent.change(input, { target: { value: "other-client" } })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith("Google Drive backup settings saved")
  )
  expect((await getSettings()).backupDestinations?.googleDrive?.connectionId).toBeNull()
  expect(await resolveGoogleDriveConnection()).toBeNull()
})
