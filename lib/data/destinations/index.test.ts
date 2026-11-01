import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { pluginExecutionContext } from "@/lib/plugin/core/invocation-identity"
const uploadMock = jest.fn(
  async (..._args: unknown[]): Promise<{ ok: boolean; remotePath?: string; error?: string }> => ({
    ok: true,
    remotePath: "/cognia-backups/x.enc.cbk",
  })
)
jest.mock("./webdav", () => ({
  uploadSnapshotToWebDav: (...args: unknown[]) => uploadMock(...args),
}))
const githubUploadMock = jest.fn(
  async (..._args: unknown[]): Promise<{ ok: boolean; remotePath?: string; error?: string }> => ({
    ok: true,
    remotePath: "gh",
  })
)
jest.mock("./github", () => ({
  uploadSnapshotToGithub: (...args: unknown[]) => githubUploadMock(...args),
}))
const driveUploadMock = jest.fn(
  async (
    ..._args: unknown[]
  ): Promise<{ ok: boolean; remotePath?: string; fileId?: string; error?: string }> => ({
    ok: true,
    remotePath: "gd",
    fileId: "f",
  })
)
jest.mock("./google-drive", () => ({
  uploadSnapshotToGoogleDrive: (...args: unknown[]) => driveUploadMock(...args),
}))

import {
  dispatchBackupDestination,
  readBackupDestinationReadiness,
  registerBackupDestination,
  remoteLegsFor,
} from "./index"

const meta = { filename: "f", exportedAt: "2026-05-30T00:00:00.000Z", sizeBytes: 1 }

beforeEach(() => {
  uploadMock.mockClear()
  uploadMock.mockResolvedValue({ ok: true, remotePath: "/cognia-backups/x.enc.cbk" })
})

describe("dispatchBackupDestination", () => {
  it("propagates the owner check into every destination rather than dropping it at dispatch", async () => {
    const assertActive = jest.fn()
    await dispatchBackupDestination("webdav", "encrypted", meta, assertActive)
    expect(uploadMock).toHaveBeenLastCalledWith("encrypted", meta, expect.any(Function))
    const ownerChecks = assertActive.mock.calls.length
    ;(uploadMock.mock.calls.at(-1)![2] as () => void)()
    expect(assertActive.mock.calls.length).toBe(ownerChecks + 1)
    await dispatchBackupDestination("github", "encrypted", meta, assertActive)
    expect(githubUploadMock).toHaveBeenLastCalledWith("encrypted", meta, {
      assertActive: expect.any(Function),
      credentialContext: undefined,
    })
    await dispatchBackupDestination("googledrive", "encrypted", meta, assertActive)
    expect(driveUploadMock).toHaveBeenLastCalledWith("encrypted", meta, {
      assertActive: expect.any(Function),
      credentialContext: undefined,
    })
  })
  it("treats local / undefined as a no-op handled by the caller", async () => {
    expect(await dispatchBackupDestination(undefined, "b", meta)).toEqual({
      ok: true,
      target: "local",
    })
    expect(await dispatchBackupDestination("local", "b", meta)).toEqual({
      ok: true,
      target: "local",
    })
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it("uploads for webdav and all", async () => {
    const webdav = await dispatchBackupDestination("webdav", "b", meta)
    expect(webdav).toEqual({
      ok: true,
      target: "/cognia-backups/x.enc.cbk",
      result: {
        remoteId: "/cognia-backups/x.enc.cbk",
        bytes: 1,
        locationLabel: "/cognia-backups/x.enc.cbk",
      },
    })
    await dispatchBackupDestination("all", "b", meta)
    expect(uploadMock).toHaveBeenCalledTimes(2)
  })

  it("surfaces upload failure", async () => {
    uploadMock.mockResolvedValueOnce({ ok: false, error: "boom" })
    expect(await dispatchBackupDestination("webdav", "b", meta)).toEqual({
      ok: false,
      error: "boom",
    })
  })

  it("reports convex as deprecated and unknown values as unsupported", async () => {
    const result = await dispatchBackupDestination("convex", "b", meta)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/deprecated/i)
    const unknown = await dispatchBackupDestination("dropbox" as never, "b", meta)
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toMatch(/not supported/i)
  })

  it("expands `all` into every remote leg and single remotes into themselves", () => {
    expect(remoteLegsFor("all")).toEqual(["webdav", "github", "googledrive"])
    expect(remoteLegsFor("github")).toEqual(["github"])
    expect(remoteLegsFor("googledrive")).toEqual(["googledrive"])
    expect(remoteLegsFor("local")).toEqual([])
    expect(remoteLegsFor(undefined)).toEqual([])
    expect(remoteLegsFor("convex")).toEqual([])
  })

  it("routes github and googledrive through their uploaders", async () => {
    githubUploadMock.mockResolvedValueOnce({ ok: true, remotePath: "o/r:cognia-backups/x" })
    expect(await dispatchBackupDestination("github", "b", meta)).toEqual({
      ok: true,
      target: "o/r:cognia-backups/x",
      result: { remoteId: "o/r:cognia-backups/x", bytes: 1, locationLabel: "o/r:cognia-backups/x" },
    })
    githubUploadMock.mockResolvedValueOnce({ ok: false, error: "public" })
    expect(await dispatchBackupDestination("github", "b", meta)).toEqual({
      ok: false,
      error: "public",
    })
    driveUploadMock.mockResolvedValueOnce({ ok: true, remotePath: "Cognia Backups/x", fileId: "f" })
    expect(await dispatchBackupDestination("googledrive", "b", meta)).toEqual({
      ok: true,
      target: "Cognia Backups/x",
      result: { remoteId: "f", bytes: 1, locationLabel: "Cognia Backups/x" },
    })
    driveUploadMock.mockResolvedValueOnce({ ok: false, error: "nope" })
    expect(await dispatchBackupDestination("googledrive", "b", meta)).toEqual({
      ok: false,
      error: "nope",
    })
  })
})

it("forwards Host credential context through builtin dispatch", async () => {
  const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
  await dispatchBackupDestination(
    "github",
    "ciphertext",
    meta,
    undefined,
    undefined,
    credentialContext
  )
  expect(githubUploadMock).toHaveBeenLastCalledWith(
    "ciphertext",
    meta,
    expect.objectContaining({ credentialContext })
  )
  await dispatchBackupDestination(
    "googledrive",
    "ciphertext",
    meta,
    undefined,
    undefined,
    credentialContext
  )
  expect(driveUploadMock).toHaveBeenLastCalledWith(
    "ciphertext",
    meta,
    expect.objectContaining({ credentialContext })
  )
})

it("does not pass Host credential admission to plugin destination callbacks", async () => {
  const readiness = jest.fn(async () => {
    expect(pluginExecutionContext("proof-test")?.localAuthorization).toBe(LOCAL_PERSON_RUN)
    return { state: "ready" as const }
  })
  const upload = jest.fn(async () => {
    expect(pluginExecutionContext("proof-test")?.localAuthorization).toBe(LOCAL_PERSON_RUN)
    return { remoteId: "remote", bytes: 1 }
  })
  const dispose = registerBackupDestination(
    { id: "private", label: "Private", readiness, upload },
    { pluginId: "proof-test", declarations: [{ id: "private", label: "Private" }] }
  )
  const context = { localAuthorization: LOCAL_PERSON_RUN } as const
  try {
    await expect(
      readBackupDestinationReadiness("plugin:proof-test/private", undefined, true, context)
    ).resolves.toEqual({ state: "ready" })
    expect(readiness).toHaveBeenCalledWith(expect.any(AbortSignal))
    await expect(
      dispatchBackupDestination(
        "plugin:proof-test/private",
        JSON.stringify({ version: "enc-v1", ciphertext: "ciphertext", kdf: {} }),
        meta,
        undefined,
        undefined,
        context
      )
    ).resolves.toMatchObject({ ok: true })
    expect(upload).toHaveBeenCalledWith(
      { body: expect.any(Uint8Array), meta: expect.objectContaining({ encryption: "passphrase" }) },
      expect.any(AbortSignal)
    )
  } finally {
    dispose()
  }
})
