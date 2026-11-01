import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { registerBackupDestination } from "./registry"
import {
  listBackupDestinationSnapshots,
  restoreFromBackupDestination,
  supportsBackupDestinationRestore,
} from "./restore"
import { restoreBackupCiphertext } from "@/lib/webdav/restore"

jest.mock("@/lib/webdav/restore", () => ({
  restoreBackupCiphertext: jest.fn(async () => ({ summary: {} })),
}))

it("offers restore only with list AND download and forwards ciphertext to the existing Host restore boundary", async () => {
  const input = {
    id: "archive",
    label: "Archive",
    readiness: async () => ({ state: "ready" as const }),
    upload: jest.fn(),
    list: async () => [{ remoteId: "one", label: "One" }],
    download: async () => new TextEncoder().encode("ciphertext"),
  }
  const dispose = registerBackupDestination(input, { pluginId: "restore", declarations: [input] })
  try {
    expect(supportsBackupDestinationRestore("plugin:restore/archive")).toBe(true)
    expect(await listBackupDestinationSnapshots("plugin:restore/archive")).toEqual([
      { remoteId: "one", label: "One", createdAt: undefined, bytes: undefined },
    ])
    const options = { passphrase: "pass", mergeStrategy: "skip" as const }
    await restoreFromBackupDestination("plugin:restore/archive", "one", options)
    expect(restoreBackupCiphertext).toHaveBeenCalledWith(
      "ciphertext",
      options,
      expect.any(Function)
    )
  } finally {
    dispose()
  }
  const partial = registerBackupDestination(
    { ...input, download: undefined },
    { pluginId: "restore", declarations: [input] }
  )
  expect(supportsBackupDestinationRestore("plugin:restore/archive")).toBe(false)
  await expect(listBackupDestinationSnapshots("plugin:restore/archive")).rejects.toThrow(
    /unavailable/
  )
  partial()
})

it("aborts a download on disposal and never decrypts a late result", async () => {
  jest.mocked(restoreBackupCiphertext).mockClear()
  let finish!: (body: Uint8Array) => void
  let active!: AbortSignal
  const input = {
    id: "archive",
    label: "Archive",
    readiness: async () => ({ state: "ready" as const }),
    upload: jest.fn(),
    list: async () => [],
    download: async (_id: string, signal: AbortSignal) => {
      active = signal
      return new Promise<Uint8Array>((resolve) => {
        finish = resolve
      })
    },
  }
  const dispose = registerBackupDestination(input, { pluginId: "restore", declarations: [input] })
  const pending = restoreFromBackupDestination("plugin:restore/archive", "one", {
    passphrase: "pass",
    mergeStrategy: "skip",
  })
  dispose()
  expect(active.aborted).toBe(true)
  await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  finish(new TextEncoder().encode("late"))
  await Promise.resolve()
  expect(restoreBackupCiphertext).not.toHaveBeenCalled()
})

jest.mock("./google-drive", () => ({
  listGoogleDriveSnapshots: jest.fn(async () => [
    { remoteId: "drive-snapshot", label: "Drive snapshot" },
  ]),
  downloadGoogleDriveSnapshot: jest.fn(async () => new TextEncoder().encode("drive-ciphertext")),
}))
import { downloadGoogleDriveSnapshot, listGoogleDriveSnapshots } from "./google-drive"

it("routes built-in Drive listing and restore through the shared connection-checked destination", async () => {
  // The public barrel installs the built-in descriptor, including list/download.
  await import("./index")
  expect(supportsBackupDestinationRestore("googledrive")).toBe(true)
  expect(
    await listBackupDestinationSnapshots("googledrive", undefined, {
      localAuthorization: LOCAL_PERSON_RUN,
    })
  ).toEqual([{ remoteId: "drive-snapshot", label: "Drive snapshot" }])
  const options = { passphrase: "pass", mergeStrategy: "skip" as const }
  await restoreFromBackupDestination("googledrive", "drive-snapshot", options, undefined, {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  expect(listGoogleDriveSnapshots).toHaveBeenCalledWith({
    assertActive: expect.any(Function),
    credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
  })
  expect(downloadGoogleDriveSnapshot).toHaveBeenCalledWith("drive-snapshot", {
    assertActive: expect.any(Function),
    credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
  })
  expect(restoreBackupCiphertext).toHaveBeenCalledWith(
    "drive-ciphertext",
    options,
    expect.any(Function)
  )
})
