import { MatrixKeyBackup, MatrixRequestNotDispatchedError } from "./key-backup"
import { connectorsMatrixCryptoBackup } from "@/lib/connectors/tauri/commands"

jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsMatrixCryptoBackup: jest.fn() }))
const native = jest.mocked(connectorsMatrixCryptoBackup)
const info = {
  version: "v1",
  algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
  auth_data: { public_key: "synthetic-public" },
}

beforeEach(() => {
  native.mockReset().mockImplementation(async (req) =>
    req.action === "prepare"
      ? {
          recoveryKey: "synthetic-secret",
          backupInfo: { algorithm: info.algorithm, auth_data: info.auth_data },
        }
      : { imported: 1, total: 1, enabled: true }
  )
})

it("refuses inactive ownership before any native or network request", async () => {
  const request = jest.fn()
  const backup = new MatrixKeyBackup({
    adapterId: "A",
    request,
    capture: () => () => false,
    flush: jest.fn(),
  })
  await expect(backup.create()).rejects.toThrow("not active")
  expect(request).not.toHaveBeenCalled()
  expect(native).not.toHaveBeenCalled()
})

it("persists preparation before version creation and never sends the recovery key to the server", async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce({ status: 404 })
    .mockResolvedValueOnce({ version: "v1" })
  const flush = jest.fn(async () => {})
  const backup = new MatrixKeyBackup({ adapterId: "A", request, capture: () => () => true, flush })
  expect(await backup.create()).toEqual({ version: "v1", recoveryKey: "synthetic-secret" })
  expect(native.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0])
  expect(request.mock.calls.map((call) => call[0])).toEqual(["GET", "POST"])
  expect(JSON.stringify(request.mock.calls)).not.toContain("synthetic-secret")
  expect(native.mock.calls.find(([req]) => req.action === "enable")![0]).toMatchObject({
    action: "enable",
    version: "v1",
    backupInfo: info,
  })
  expect(flush).toHaveBeenCalledTimes(1)
})

it("reconciles an ambiguously accepted create without repeating the mutation", async () => {
  let created = false
  const request = jest.fn(async (method: string) => {
    if (method === "POST") {
      created = true
      throw new Error("lost response")
    }
    if (!created) throw { status: 404 }
    return info
  })
  const backup = new MatrixKeyBackup({
    adapterId: "A",
    request,
    capture: () => () => true,
    flush: jest.fn(),
  })
  await expect(backup.create()).rejects.toThrow("lost response")
  expect((await backup.create()).version).toBe("v1")
  expect(request.mock.calls.filter((call) => call[0] === "POST")).toHaveLength(1)
})

it("does not overwrite a foreign server backup", async () => {
  const request = jest.fn(async () => info)
  native.mockImplementation(async (req) => {
    if (req.action === "prepare") return { recoveryKey: "synthetic-secret", backupInfo: {} }
    throw new Error("Matrix backup public key mismatch")
  })
  const backup = new MatrixKeyBackup({
    adapterId: "A",
    request,
    capture: () => () => true,
    flush: jest.fn(),
  })
  await expect(backup.create()).rejects.toThrow("public key mismatch")
  expect(request.mock.calls).toHaveLength(1)
})

it("does not repeat an unknown create while the server still reports 404", async () => {
  let pending = false
  native.mockImplementation(async (req) => {
    if (req.action === "prepare")
      return { recoveryKey: "synthetic-secret", backupInfo: {}, createPending: pending }
    if (req.action === "beginCreate") pending = true
    return { createPending: pending }
  })
  const request = jest.fn(async (method: string) => {
    if (method === "POST") throw new Error("ambiguous create")
    throw { status: 404 }
  })
  const value = new MatrixKeyBackup({
    adapterId: "A",
    request,
    capture: () => () => true,
    flush: jest.fn(),
  })
  await expect(value.create()).rejects.toThrow("ambiguous create")
  await expect(value.create()).rejects.toThrow("outcome is unknown")
  expect(request.mock.calls.filter(([method]) => method === "POST")).toHaveLength(1)
})

it.each(["not-dispatched", "unauthorized"])(
  "releases only its own claim for a proven %s create failure",
  async (failure) => {
    const request = jest
      .fn()
      .mockRejectedValueOnce({ status: 404 })
      .mockRejectedValueOnce(
        failure === "not-dispatched"
          ? new MatrixRequestNotDispatchedError("before dispatch")
          : { status: 401 }
      )
    const value = new MatrixKeyBackup({
      adapterId: "A",
      request,
      capture: () => () => true,
      flush: jest.fn(),
    })
    await expect(value.create()).rejects.toBeDefined()
    const begin = native.mock.calls.find(([req]) => req.action === "beginCreate")![0]
    expect(typeof begin.createClaim).toBe("string")
    expect(native.mock.calls.find(([req]) => req.action === "cancelCreate")![0]).toEqual({
      adapterId: "A",
      action: "cancelCreate",
      createClaim: begin.createClaim,
    })
  }
)

it("bounds restore downloads and retries pending input only after authenticated native import", async () => {
  const rooms = { "!room:fixture": { sessions: {} } }
  const request = jest.fn().mockResolvedValueOnce(info).mockResolvedValueOnce({ rooms })
  const flush = jest.fn(async () => {})
  const backup = new MatrixKeyBackup({ adapterId: "A", request, capture: () => () => true, flush })
  expect(await backup.restore("synthetic-secret", "v1")).toEqual({
    version: "v1",
    imported: 1,
    total: 1,
  })
  expect(request.mock.calls[1]).toEqual([
    "GET",
    "/_matrix/client/v3/room_keys/keys?version=v1",
    undefined,
    { maxResponseBytes: 8 * 1024 * 1024 },
  ])
  expect(JSON.stringify(request.mock.calls)).not.toContain("synthetic-secret")
  expect(native.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0])
})

it("rejects a changed generation and a mismatched restore version before native mutation", async () => {
  let active = true
  const request = jest.fn(async () => {
    active = false
    return info
  })
  const backup = new MatrixKeyBackup({
    adapterId: "A",
    request,
    capture: () => () => active,
    flush: jest.fn(),
  })
  await expect(backup.restore("synthetic-secret", "v1")).rejects.toThrow("not active")
  expect(native).not.toHaveBeenCalled()
  active = true
  const mismatch = new MatrixKeyBackup({
    adapterId: "A",
    request: jest.fn(async () => info),
    capture: () => () => true,
    flush: jest.fn(),
  })
  await expect(mismatch.restore("synthetic-secret", "foreign")).rejects.toThrow("version mismatch")
  expect(native).not.toHaveBeenCalled()
})
