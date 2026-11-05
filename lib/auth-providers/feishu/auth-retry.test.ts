/**
 * @jest-environment node
 */
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"

import { LarkApiError } from "@cognia/feishu-protocol"
import { withTatRefresh, withUserTokenRefresh } from "./auth-retry"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { refreshUserToken } from "./auth"

const mockClearTokenCache = jest.fn()

jest.mock("./auth", () => ({
  clearTokenCache: (...args: unknown[]) => mockClearTokenCache(...args),
  refreshUserToken: jest.fn(),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsLarkUserAuth: jest.fn() }))

beforeEach(() => {
  mockClearTokenCache.mockClear()
  ;(connectorsLarkUserAuth as jest.Mock).mockReset().mockResolvedValue({
    configured: true,
    authorizationEpoch: "request-epoch",
    accessToken: "user-a",
  })
  ;(refreshUserToken as jest.Mock).mockReset()
})

describe("withUserTokenRefresh", () => {
  const ctx = {
    adapterId: "fixture",
    appId: "app",
    appSecret: "secret",
    credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
  } as const
  it("refreshes against the originating request epoch and retries once", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new LarkApiError({ status: 401, code: null, message: "expired" }))
      .mockResolvedValueOnce("result")
    await expect(withUserTokenRefresh(ctx, fn)).resolves.toBe("result")
    expect(refreshUserToken).toHaveBeenCalledWith({
      ...ctx,
      expectedAuthorizationEpoch: "request-epoch",
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it("retains the Lark international deployment during user refresh", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new LarkApiError({ status: 401, code: null, message: "expired" }))
      .mockResolvedValueOnce("ok")
    await expect(withUserTokenRefresh({ ...ctx, brand: "lark" }, fn)).resolves.toBe("ok")
    expect(refreshUserToken).toHaveBeenCalledWith({
      ...ctx,
      brand: "lark",
      expectedAuthorizationEpoch: "request-epoch",
    })
  })
  it("passes the captured identity and refuses a successful result after replacement", async () => {
    const fn = jest.fn(async (token: string, epoch: string) => {
      expect(token).toBe("user-a")
      expect(epoch).toBe("request-epoch")
      ;(connectorsLarkUserAuth as jest.Mock).mockResolvedValue({
        configured: true,
        authorizationEpoch: "replacement",
        accessToken: "user-b",
      })
      return "private user-a result"
    })
    await expect(withUserTokenRefresh(ctx, fn)).rejects.toThrow("lark_auth_stale")
    expect(fn).toHaveBeenCalledTimes(1)
    expect(refreshUserToken).not.toHaveBeenCalled()
  })
  it("retains the origin epoch and paired token after a valid refresh", async () => {
    ;(refreshUserToken as jest.Mock).mockImplementation(async () => {
      ;(connectorsLarkUserAuth as jest.Mock).mockResolvedValue({
        configured: true,
        authorizationEpoch: "request-epoch",
        accessToken: "user-a-rotated",
      })
    })
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new LarkApiError({ status: 401, code: null, message: "expired" }))
      .mockResolvedValueOnce("private result")
    await expect(withUserTokenRefresh(ctx, fn)).resolves.toBe("private result")
    expect(fn.mock.calls).toEqual([
      ["user-a", "request-epoch"],
      ["user-a-rotated", "request-epoch"],
    ])
  })
  it("does not retry when cancellation arrives during an already-dispatched refresh", async () => {
    const controller = new AbortController()
    ;(refreshUserToken as jest.Mock).mockImplementation(async () => {
      controller.abort()
      return "rotated"
    })
    const fn = jest
      .fn()
      .mockRejectedValue(new LarkApiError({ status: 401, code: null, message: "expired" }))
    await expect(
      withUserTokenRefresh({ ...ctx, signal: controller.signal }, fn)
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe("withTatRefresh", () => {
  const ctx = { appId: "cli_test", appSecret: "secret" }

  it("returns result on first-pass success without touching cache", async () => {
    const fn = jest.fn().mockResolvedValue("ok")
    const result = await withTatRefresh(ctx, "service-data", fn)
    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
    expect(mockClearTokenCache).not.toHaveBeenCalled()
  })

  it("propagates non-TAT errors without retry", async () => {
    const err = new Error("network timeout")
    const fn = jest.fn().mockRejectedValue(err)
    await expect(withTatRefresh(ctx, "service-data", fn)).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(mockClearTokenCache).not.toHaveBeenCalled()
  })

  it("clears cache and retries once on TAT invalidation", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new LarkApiError({ status: 401, code: null, message: "Unauthorized" }))
      .mockResolvedValueOnce("refreshed-ok")
    const result = await withTatRefresh(ctx, "service-data", fn)
    expect(result).toBe("refreshed-ok")
    expect(fn).toHaveBeenCalledTimes(2)
    expect(mockClearTokenCache).toHaveBeenCalledWith("cli_test", "secret")
    expect(mockClearTokenCache).toHaveBeenCalledTimes(1)
  })

  it("clears cache on code=99991663 invalidation", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(
        new LarkApiError({ status: 200, code: 99991663, message: "code=99991663" })
      )
      .mockResolvedValueOnce("ok")
    await withTatRefresh(ctx, "service-data", fn)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(mockClearTokenCache).toHaveBeenCalledWith("cli_test", "secret")
  })

  it("propagates the retry's failure unchanged (no third attempt)", async () => {
    const persistent = new LarkApiError({
      status: 401,
      code: null,
      message: "still unauthorized after refresh",
    })
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new LarkApiError({ status: 401, code: null, message: "first 401" }))
      .mockRejectedValueOnce(persistent)
    await expect(withTatRefresh(ctx, "service-data", fn)).rejects.toBe(persistent)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(mockClearTokenCache).toHaveBeenCalledTimes(1)
  })

  it("does not call clearTokenCache for unrelated errors during retry detection", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("dns lookup failed"))
    await expect(withTatRefresh(ctx, "service-data", fn)).rejects.toThrow("dns lookup failed")
    expect(mockClearTokenCache).not.toHaveBeenCalled()
  })
})

it.each(["transport", "service-data", "adapter-admin"] as const)(
  "preserves the callback result for %s retries",
  async (purpose) => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new LarkApiError({ status: 401, code: 99991663, message: "expired" }))
      .mockResolvedValueOnce("unchanged")
    await expect(
      withTatRefresh({ appId: "purpose", appSecret: "secret" }, purpose, fn)
    ).resolves.toBe("unchanged")
    expect(fn).toHaveBeenCalledTimes(2)
  }
)

it("forwards Host credential admission into a refresh without replacing its epoch", async () => {
  const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
  let first = true
  await withUserTokenRefresh(
    { adapterId: "fixture", appId: "app", appSecret: "secret", credentialContext },
    async () => {
      if (first) {
        first = false
        throw new LarkApiError({ status: 401, code: 99991677, message: "expired" })
      }
      return "ok"
    }
  )
  expect(refreshUserToken).toHaveBeenCalledWith(
    expect.objectContaining({ credentialContext, expectedAuthorizationEpoch: "request-epoch" })
  )
})
