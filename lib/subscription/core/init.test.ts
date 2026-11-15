import {
  __resetSecretStoreReadinessForTesting,
  getSecretStoreReadiness,
} from "@/lib/credentials/secret-store-readiness"
import { subscriptionInitOnce } from "./init"
import { subscriptionInit } from "./transport"

jest.mock("./transport", () => ({
  subscriptionInit: jest.fn(),
}))

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockIsTauri(),
  isCapacitor: () => mockIsCapacitor(),
  detectPlatform: () => (mockIsTauri() ? "tauri" : mockIsCapacitor() ? "mobile" : "web"),
}))

jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => mockHasWebCompanion(),
}))

const mockIsTauri = jest.fn(() => true)
const mockIsCapacitor = jest.fn(() => false)
const mockHasWebCompanion = jest.fn(() => false)

const mockedInit = subscriptionInit as jest.MockedFunction<typeof subscriptionInit>

beforeEach(() => {
  mockedInit.mockReset()
  mockIsTauri.mockReturnValue(true)
  mockIsCapacitor.mockReturnValue(false)
  mockHasWebCompanion.mockReturnValue(false)
})

describe("subscriptionInitOnce", () => {
  it("invokes subscription_init and reports success", async () => {
    mockedInit.mockResolvedValueOnce(undefined)
    const result = await subscriptionInitOnce()
    expect(mockedInit).toHaveBeenCalledTimes(1)
    expect(result).toEqual({})
  })

  it("skips the command entirely in web mode with no backend", async () => {
    mockIsTauri.mockReturnValue(false)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    const result = await subscriptionInitOnce()

    expect(result).toEqual({ skipped: true })
    expect(mockedInit).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each([
    ["capacitor", () => mockIsCapacitor.mockReturnValue(true)],
    ["a paired web companion", () => mockHasWebCompanion.mockReturnValue(true)],
  ])("skips the client-local init on %s", async (_label, enableHost) => {
    mockIsTauri.mockReturnValue(false)
    enableHost()

    const result = await subscriptionInitOnce()

    expect(result.skipped).toBe(true)
    expect(mockedInit).not.toHaveBeenCalled()
  })

  it("swallows transport errors and returns the message", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockedInit.mockRejectedValueOnce(new Error("keyring offline"))
    const result = await subscriptionInitOnce()
    expect(result.error).toBe("keyring offline")
    warn.mockRestore()
  })

  it("types a locked secret store and reports it once instead of warning", async () => {
    __resetSecretStoreReadinessForTesting()
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockedInit.mockRejectedValueOnce(
      "SECRET_STORE_LOCKED: master key read: Platform failure: passphrase not correct"
    )
    const result = await subscriptionInitOnce()
    expect(result.secretStoreUnavailable).toBe(true)
    expect(result.error).toContain("SECRET_STORE_LOCKED")
    expect(getSecretStoreReadiness()).toBe("locked")
    expect(warn).not.toHaveBeenCalledWith("subscription_init failed:", expect.anything())
    warn.mockRestore()
  })

  it("keeps other failures untyped", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockedInit.mockRejectedValueOnce(new Error("vault parse failed"))
    const result = await subscriptionInitOnce()
    expect(result.secretStoreUnavailable).toBeUndefined()
    expect(warn).toHaveBeenCalledWith("subscription_init failed:", "vault parse failed")
    warn.mockRestore()
  })
})
