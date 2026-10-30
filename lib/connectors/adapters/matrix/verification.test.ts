jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsMatrixCryptoVerification: jest.fn(),
  connectorsMatrixCryptoMarkRequestSent: jest.fn(async () => undefined),
}))
import {
  connectorsMatrixCryptoVerification as native,
  connectorsMatrixCryptoMarkRequestSent as mark,
} from "@/lib/connectors/tauri/commands"
import { MatrixVerification } from "./verification"

function fixture() {
  let active = true
  const request = jest.fn(async () => ({}))
  const flush = jest.fn(async () => undefined)
  const verification = new MatrixVerification({
    adapterId: "matrix",
    request,
    flush,
    refresh: async () => undefined,
    capture: () => () => active,
  })
  return {
    verification,
    request,
    flush,
    stop: () => {
      active = false
    },
  }
}
beforeEach(() => jest.clearAllMocks())
test("inactive verification never reaches native crypto", async () => {
  const f = fixture()
  f.stop()
  await expect(
    f.verification.interact({ action: "request", userId: "@bob:test", deviceId: "BOB" })
  ).rejects.toThrow("not active")
  expect(native).not.toHaveBeenCalled()
})
test("QR image and binary payload survive the final status read after generation", async () => {
  const f = fixture()
  const qrImage = { size: 21, modules: new Array(441).fill(false) }
  const qrBytes = [77, 65, 84, 82, 73, 88, 0, 1]
  const state = {
    flowId: "flow",
    userId: "@peer:test",
    state: "qr",
    deviceVerified: false,
    requests: [],
  }
  jest
    .mocked(native)
    .mockResolvedValueOnce({ ...state, qrImage, qrBytes } as never)
    .mockResolvedValueOnce(state as never)
  await expect(
    f.verification.interact({ action: "generateQr", userId: "@peer:test", flowId: "flow" })
  ).resolves.toMatchObject({ qrBytes, qrImage, requests: [] })
})
test("refresh downloads trust only after completion and never confirms a proof", async () => {
  const refresh = jest.fn(async () => undefined)
  const verification = new MatrixVerification({
    adapterId: "matrix",
    request: jest.fn(),
    flush: jest.fn(),
    capture: () => () => true,
    refresh,
  })
  jest.mocked(native).mockResolvedValueOnce({ state: "qr" } as never)
  await expect(verification.refreshTrust("@peer:test", "flow")).rejects.toThrow("not complete")
  expect(refresh).not.toHaveBeenCalled()
  jest
    .mocked(native)
    .mockResolvedValueOnce({ state: "done", deviceVerified: false } as never)
    .mockResolvedValueOnce({ state: "done", deviceVerified: true } as never)
  await expect(verification.refreshTrust("@peer:test", "flow")).resolves.toMatchObject({
    deviceVerified: true,
    requests: [],
  })
  expect(refresh).toHaveBeenCalledWith("@peer:test", expect.any(Function))
  expect(jest.mocked(native).mock.calls.every(([input]) => input.action === "status")).toBe(true)
})
test("stop overtaking native completion cannot send a late verification request", async () => {
  const f = fixture()
  let release!: (value: Awaited<ReturnType<typeof native>>) => void
  jest.mocked(native).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const work = f.verification.interact({ action: "accept", userId: "@bob:test", flowId: "flow" })
  await Promise.resolve()
  f.stop()
  release({ requests: [{ method: "PUT", path: "/sendToDevice" }] } as never)
  await expect(work).rejects.toThrow("not active")
  expect(f.request).not.toHaveBeenCalled()
  expect(f.flush).not.toHaveBeenCalled()
})
test("rejected signature uploads cannot be acknowledged or reported as success", async () => {
  const f = fixture()
  jest.mocked(native).mockResolvedValueOnce({
    requests: [
      { method: "POST", kind: "signatureUpload", path: "/keys/signatures/upload", body: {} },
    ],
  } as never)
  f.request.mockResolvedValueOnce({ failures: { user: { key: {} } } })
  await expect(
    f.verification.interact({ action: "confirmSas", userId: "@bob:test", flowId: "flow" })
  ).rejects.toThrow("signatures were rejected")
  expect(mark).not.toHaveBeenCalled()
  expect(f.flush).not.toHaveBeenCalled()
})

test("retry sends the original transaction and does not repeat a one-shot confirmation", async () => {
  const f = fixture()
  const state = {
    flowId: "flow",
    userId: "@bob:test",
    deviceId: "BOB",
    state: "qr",
    deviceVerified: false,
    requests: [
      {
        requestId: "same-transaction",
        kind: "toDevice",
        method: "PUT",
        path: "/sendToDevice/same-transaction",
        body: { messages: {} },
      },
    ],
  }
  jest.mocked(native).mockResolvedValue(state as never)
  f.request.mockRejectedValueOnce(new Error("temporary failure"))
  const input = { action: "confirmQr" as const, userId: "@bob:test", flowId: "flow" }
  await expect(f.verification.interact(input)).rejects.toThrow("temporary failure")
  await f.verification.interact({
    flowId: input.flowId,
    userId: input.userId,
    action: input.action,
  })
  expect(jest.mocked(native).mock.calls.filter(([req]) => req.action === "confirmQr")).toHaveLength(
    1
  )
  expect(f.request.mock.calls[1]).toEqual(f.request.mock.calls[0])
  expect(mark).toHaveBeenCalledWith(expect.objectContaining({ requestId: "same-transaction" }))
})

test("pending requests use the production native discovery command and refuse after lock", async () => {
  const f = fixture()
  jest.mocked(native).mockResolvedValueOnce({ flows: [{ flowId: "incoming" }] } as never)
  expect(await f.verification.pending("@bob:test")).toEqual([{ flowId: "incoming" }])
  expect(native).toHaveBeenCalledWith({ adapterId: "matrix", action: "list", userId: "@bob:test" })
  f.stop()
  await expect(f.verification.pending("@bob:test")).rejects.toThrow("not active")
})

test("a failed handshake cannot prevent native cancellation or reads of a different flow", async () => {
  const f = fixture()
  let cancelled = false
  jest.mocked(native).mockImplementation(async (input) => {
    if (input.action === "cancel") cancelled = true
    return {
      flowId: input.flowId,
      userId: input.userId,
      deviceId: "BOB",
      state: cancelled ? "cancelled" : "ready",
      deviceVerified: false,
      requests:
        input.action === "accept"
          ? [{ requestId: "ready", method: "PUT", path: "/ready", kind: "toDevice", body: {} }]
          : [],
    } as never
  })
  f.request.mockRejectedValue(new Error("offline"))
  await expect(
    f.verification.interact({ action: "accept", userId: "@bob:test", flowId: "one" })
  ).rejects.toThrow("offline")
  await expect(
    f.verification.interact({ action: "status", userId: "@bob:test", flowId: "two" })
  ).resolves.toMatchObject({ flowId: "two" })
  await expect(
    f.verification.interact({ action: "cancel", userId: "@bob:test", flowId: "one" })
  ).resolves.toMatchObject({ state: "cancelled" })
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(jest.mocked(native).mock.calls.map(([input]) => input.action)).toContain("cancel")
})

test("cancel retry reuses the retained cancellation after the SDK flow is terminal", async () => {
  const f = fixture()
  let cancelled = false
  jest.mocked(native).mockImplementation(async (input) => {
    if (input.action === "cancel" && cancelled)
      throw new Error("Matrix verification flow is terminal")
    if (input.action === "cancel") cancelled = true
    return {
      flowId: "flow",
      userId: "@bob:test",
      state: "cancelled",
      requests:
        input.action === "cancel"
          ? [
              {
                requestId: "cancel-once",
                method: "PUT",
                path: "/cancel/cancel-once",
                kind: "toDevice",
                body: {},
              },
            ]
          : [],
    } as never
  })
  f.request.mockRejectedValueOnce(new Error("offline"))
  const input = { action: "cancel" as const, userId: "@bob:test", flowId: "flow" }
  await expect(f.verification.interact(input)).rejects.toThrow("offline")
  await expect(f.verification.interact(input)).resolves.toMatchObject({ state: "cancelled" })
  expect(jest.mocked(native).mock.calls.filter(([req]) => req.action === "cancel")).toHaveLength(1)
  expect(f.request).toHaveBeenCalledTimes(2)
  expect(f.request.mock.calls[1]).toEqual(f.request.mock.calls[0])
})
