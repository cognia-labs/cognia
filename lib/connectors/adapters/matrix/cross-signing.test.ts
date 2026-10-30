import { MatrixCrossSigning } from "./cross-signing"
import {
  connectorsMatrixCryptoCrossSigning,
  connectorsMatrixCryptoMarkRequestSent,
} from "@/lib/connectors/tauri/commands"

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsMatrixCryptoCrossSigning: jest.fn(),
  connectorsMatrixCryptoMarkRequestSent: jest.fn(),
}))

const native = jest.mocked(connectorsMatrixCryptoCrossSigning)
const mark = jest.mocked(connectorsMatrixCryptoMarkRequestSent)
const queryResponse = {
  device_keys: {
    "@me:example.org": { DEVICE: { user_id: "@me:example.org", device_id: "DEVICE" } },
  },
  master_keys: {},
  failures: {},
}
const status = {
  hasMaster: true,
  hasSelfSigning: true,
  hasUserSigning: true,
  masterKey: "public",
  identityVerified: true,
  deviceCrossSigned: true,
  deviceTrusted: true,
}
const requests = [
  {
    requestId: "signing",
    kind: "signingKeysUpload",
    method: "POST",
    path: "/_matrix/client/v3/keys/device_signing/upload",
    body: { master_key: { keys: { "ed25519:public": "public" } } },
  },
  {
    requestId: "signatures",
    kind: "signatureUpload",
    method: "POST",
    path: "/_matrix/client/v3/keys/signatures/upload",
    body: {},
  },
]

function fixture() {
  let active = true
  const request = jest.fn().mockResolvedValue(queryResponse)
  const refresh = jest.fn().mockResolvedValue(undefined)
  const runtime = new MatrixCrossSigning({
    adapterId: "matrix",
    userId: "@me:example.org",
    deviceId: "DEVICE",
    request,
    refresh,
    capture: () => () => active,
  })
  return {
    runtime,
    request,
    refresh,
    stop: () => {
      active = false
    },
  }
}

beforeEach(() => {
  jest.resetAllMocks()
  native.mockImplementation((async (req: { action: string }) =>
    req.action === "prepare" ? { requests } : status) as typeof connectorsMatrixCryptoCrossSigning)
  mark.mockResolvedValue(undefined)
})

test("queries own identity first and sends ordered public uploads with bounded replies", async () => {
  const f = fixture()
  await expect(
    f.runtime.bootstrap({ type: "m.login.password", session: "session" })
  ).resolves.toEqual(status)
  expect(f.request.mock.calls[0]).toEqual([
    "POST",
    "/_matrix/client/v3/keys/query",
    { device_keys: { "@me:example.org": [] } },
    { maxResponseBytes: 65536 },
  ])
  expect(native).toHaveBeenCalledWith({
    adapterId: "matrix",
    action: "prepare",
    serverMasterKey: null,
  })
  expect(f.request.mock.calls.slice(1).map((call) => call[1])).toEqual(
    requests.map((req) => req.path)
  )
  expect(f.request.mock.calls[1][2]).toHaveProperty("auth.session", "session")
  expect(f.request.mock.calls[2][2]).not.toHaveProperty("auth")
  expect(mark.mock.calls.map(([req]) => req.kind)).toEqual(["signingKeysUpload", "signatureUpload"])
  expect(f.refresh).toHaveBeenCalledTimes(1)
})

test("a 200 response with rejected signatures is not successful bootstrap", async () => {
  const f = fixture()
  f.request
    .mockResolvedValueOnce(queryResponse)
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({
      failures: { "@me:example.org": { DEVICE: { errcode: "M_INVALID_SIGNATURE" } } },
    })
  await expect(f.runtime.bootstrap()).rejects.toThrow("signatures were rejected")
  expect(mark).toHaveBeenCalledTimes(1)
  expect(f.refresh).not.toHaveBeenCalled()
})

test("401 leaves bootstrap incomplete and a later explicit retry can succeed", async () => {
  const f = fixture()
  f.request
    .mockResolvedValueOnce(queryResponse)
    .mockRejectedValueOnce(Object.assign(new Error("UIA required"), { status: 401 }))
  await expect(f.runtime.bootstrap()).rejects.toMatchObject({ status: 401 })
  expect(mark).not.toHaveBeenCalled()
  await expect(f.runtime.bootstrap({ session: "challenge" })).resolves.toEqual(status)
})

test("stop during public-key query prevents native preparation and uploads", async () => {
  const f = fixture()
  f.request.mockImplementationOnce(async () => {
    f.stop()
    return {}
  })
  await expect(f.runtime.bootstrap()).rejects.toThrow("not active")
  expect(native).not.toHaveBeenCalled()
  expect(mark).not.toHaveBeenCalled()
})

test("malformed existing identity cannot be treated as an absent identity", async () => {
  const f = fixture()
  f.request.mockResolvedValue({
    ...queryResponse,
    master_keys: { "@me:example.org": { keys: {} } },
  })
  await expect(f.runtime.bootstrap()).rejects.toThrow("Invalid Matrix server master key")
  expect(native).not.toHaveBeenCalled()
})

test("status queries preserve the distinction between cross-signing and trust", async () => {
  const f = fixture()
  native.mockResolvedValueOnce({
    ...status,
    identityVerified: false,
    deviceCrossSigned: true,
    deviceTrusted: false,
  })
  await expect(f.runtime.status("@peer:example.org", "PEER")).resolves.toMatchObject({
    identityVerified: false,
    deviceCrossSigned: true,
    deviceTrusted: false,
  })
  expect(native).toHaveBeenCalledWith({
    adapterId: "matrix",
    action: "status",
    userId: "@peer:example.org",
    deviceId: "PEER",
  })
})

test.each([
  {},
  { ...queryResponse, failures: { "example.org": {} } },
  { ...queryResponse, device_keys: {} },
])("incomplete self query cannot reset a hidden existing identity: %p", async (response) => {
  const f = fixture()
  f.request.mockResolvedValue(response)
  await expect(f.runtime.bootstrap()).rejects.toThrow("query is incomplete")
  expect(native).not.toHaveBeenCalled()
  expect(mark).not.toHaveBeenCalled()
})
