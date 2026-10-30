jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsLarkUserAuth: jest.fn(async () => ({
    configured: true,
    authorizationEpoch: "http-fixture",
    accessToken: "connected-user",
  })),
}))

jest.mock("./auth", () => ({
  getTenantAccessToken: jest.fn(),
  getUserAccessToken: jest.fn(),
  clearTokenCache: jest.fn(),
  refreshUserToken: jest.fn(),
}))

import { connectorsHttpRequest, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { clearTokenCache, getTenantAccessToken, getUserAccessToken, refreshUserToken } from "./auth"
import { LarkApiError } from "./auth-retry"
import { classifyScopeError, larkTenantRequest, larkUserRequest } from "./http"
import { ChatManagementScopeError } from "@/types/connectors/chat-management"
import { assertLarkActingIdentity } from "@/lib/skills/built-in/lark/acting-identity"
jest.mock("@/lib/skills/built-in/lark/acting-identity", () => ({
  assertLarkActingIdentity: jest.fn(),
}))

const mHttp = connectorsHttpRequest as jest.Mock
const mTat = getTenantAccessToken as jest.Mock
const mUserToken = getUserAccessToken as jest.Mock
const mClear = clearTokenCache as jest.Mock

const CREDS = { appId: "cli_x", appSecret: "sec" }

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(assertLarkActingIdentity).mockReset().mockResolvedValue(undefined)
  ;(connectorsLarkUserAuth as jest.Mock).mockReset().mockImplementation(async () => ({
    configured: true,
    authorizationEpoch: "http-fixture",
    accessToken: await mUserToken("fixture"),
  }))
  mTat.mockResolvedValue("tat-1")
  mHttp.mockResolvedValue({ status: 200, body: JSON.stringify({ code: 0, data: { ok: true } }) })
})

describe("larkTenantRequest", () => {
  it("opts avatar profile reads into the native no-redirect policy", async () => {
    await larkTenantRequest(CREDS, "GET", "/contact/v3/users/ou_1", undefined, {
      avatarPolicy: true,
    })
    expect(mHttp.mock.calls[0][0].headers["X-Cognia-Avatar-Policy"]).toBe("1")
    mHttp.mockClear()
    await larkTenantRequest(CREDS, "GET", "/im/v1/chats/oc_1")
    expect(mHttp.mock.calls[0][0].headers["X-Cognia-Avatar-Policy"]).toBeUndefined()
  })
  it("issues a bearer tenant-token request and returns the parsed body", async () => {
    const out = await larkTenantRequest(CREDS, "POST", "/im/v1/chats?x=1", { name: "g" })
    expect(out).toEqual({ code: 0, data: { ok: true } })
    const call = mHttp.mock.calls[0][0]
    expect(call.url).toBe("https://open.feishu.cn/open-apis/im/v1/chats?x=1")
    expect(call.method).toBe("POST")
    expect(call.headers.Authorization).toBe("Bearer tat-1")
    expect(JSON.parse(call.body)).toEqual({ name: "g" })
  })

  it("supports PUT (chat update — the factory closures never did)", async () => {
    await larkTenantRequest(CREDS, "PUT", "/im/v1/chats/oc_1", { name: "n" })
    expect(mHttp.mock.calls[0][0].method).toBe("PUT")
  })

  it("retries exactly once after a token-invalidation code, clearing the cache", async () => {
    mHttp
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ code: 99991663, msg: "invalid token" }),
      })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ code: 0, data: { ok: 1 } }) })
    const out = await larkTenantRequest(CREDS, "GET", "/x")
    expect(out).toEqual({ code: 0, data: { ok: 1 } })
    expect(mClear).toHaveBeenCalledWith("cli_x", "sec")
    expect(mHttp).toHaveBeenCalledTimes(2)
  })

  it("throws LarkApiError on non-zero business codes (no retry for non-auth codes)", async () => {
    mHttp.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ code: 1248006, msg: "no perm" }),
    })
    await expect(larkTenantRequest(CREDS, "GET", "/x")).rejects.toBeInstanceOf(LarkApiError)
    expect(mHttp).toHaveBeenCalledTimes(1)
  })

  it("throws LarkApiError with the extracted code on HTTP >= 400", async () => {
    mHttp.mockResolvedValue({ status: 403, body: JSON.stringify({ code: 99991672, msg: "scope" }) })
    const err = await larkTenantRequest(CREDS, "GET", "/x").catch((e) => e)
    expect(err).toBeInstanceOf(LarkApiError)
    expect((err as LarkApiError).status).toBe(403)
    expect((err as LarkApiError).code).toBe(99991672)
  })
})

describe("larkTenantRequest — body/parse edges", () => {
  it("omits the body for body-less requests and returns null for empty responses", async () => {
    mHttp.mockResolvedValue({ status: 200, body: "" })
    const out = await larkTenantRequest(CREDS, "GET", "/im/v1/chats/oc_1")
    expect(out).toBeNull()
    expect(mHttp.mock.calls[0][0].body).toBeUndefined()
  })

  it("extracts null codes from non-JSON error bodies (HTTP >= 400)", async () => {
    mHttp.mockResolvedValue({ status: 500, body: "<html>gateway error</html>" })
    const err = await larkTenantRequest(CREDS, "GET", "/x").catch((e) => e)
    expect(err).toBeInstanceOf(LarkApiError)
    expect((err as LarkApiError).code).toBeNull()
  })

  it("ignores non-numeric code fields in error bodies", async () => {
    mHttp.mockResolvedValue({ status: 400, body: JSON.stringify({ code: "weird" }) })
    const err = await larkTenantRequest(CREDS, "GET", "/x").catch((e) => e)
    expect((err as LarkApiError).code).toBeNull()
  })
})

describe("larkUserRequest", () => {
  it("sends the verified IM token rather than a separately read or recaptured token", async () => {
    jest
      .mocked(assertLarkActingIdentity)
      .mockResolvedValue({ accessToken: "verified-token", authorizationEpoch: "auth-owner" })
    jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
      configured: true,
      accessToken: "later-same-authorization-token",
      authorizationEpoch: "auth-owner",
    } as never)
    await larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x", undefined, {
      sessionId: "s1",
    })
    expect(mHttp.mock.calls[0][0].headers.Authorization).toBe("Bearer verified-token")
    expect(mUserToken).not.toHaveBeenCalled()
  })

  it("refuses an authorization change between the gate and the HTTP call", async () => {
    jest
      .mocked(assertLarkActingIdentity)
      .mockResolvedValue({ accessToken: "alice-token", authorizationEpoch: "auth-alice" })
    jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
      configured: true,
      accessToken: "bob-token",
      authorizationEpoch: "auth-bob",
    } as never)
    await expect(
      larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x", undefined, { sessionId: "s1" })
    ).rejects.toThrow("lark_auth_stale")
    expect(mHttp).not.toHaveBeenCalled()
    expect(mUserToken).not.toHaveBeenCalled()
  })

  it("does not refresh and retry a verified IM request under a replacement authorization", async () => {
    jest
      .mocked(assertLarkActingIdentity)
      .mockResolvedValue({ accessToken: "alice-token", authorizationEpoch: "auth-alice" })
    let epoch = "auth-alice"
    jest.mocked(connectorsLarkUserAuth).mockImplementation(
      async () =>
        ({
          configured: true,
          accessToken: epoch === "auth-alice" ? "alice-token" : "bob-token",
          authorizationEpoch: epoch,
        }) as never
    )
    mHttp.mockResolvedValue({ status: 401, body: JSON.stringify({ code: 99991677 }) })
    jest.mocked(refreshUserToken).mockImplementationOnce(async () => {
      epoch = "auth-bob"
      return "bob-token"
    })
    await expect(
      larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x", undefined, { sessionId: "s1" })
    ).rejects.toThrow("lark_auth_stale")
    expect(refreshUserToken).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAuthorizationEpoch: "auth-alice" })
    )
    expect(mHttp).toHaveBeenCalledTimes(1)
    expect(mHttp.mock.calls[0][0].headers.Authorization).toBe("Bearer alice-token")
  })
  it("checks the acting identity before reading a user token", async () => {
    jest.mocked(assertLarkActingIdentity).mockRejectedValueOnce(new Error("sender_not_token_owner"))
    const ctx = { sessionId: "im-session" }
    await expect(
      larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x", undefined, ctx)
    ).rejects.toThrow("sender_not_token_owner")
    expect(assertLarkActingIdentity).toHaveBeenCalledWith("a1", ctx)
    expect(mUserToken).not.toHaveBeenCalled()
    expect(mTat).not.toHaveBeenCalled()
    expect(mHttp).not.toHaveBeenCalled()
  })
  it("does not retry a write as a replacement identity after refresh commits", async () => {
    let state = { configured: true, authorizationEpoch: "auth-a", accessToken: "user-a" }
    ;(connectorsLarkUserAuth as jest.Mock).mockImplementation(async () => state)
    mUserToken.mockImplementation(async () => state.accessToken)
    ;(refreshUserToken as jest.Mock).mockImplementation(async () => {
      state = { ...state, authorizationEpoch: "auth-b", accessToken: "user-b" }
      return "refreshed-a"
    })
    mHttp.mockResolvedValueOnce({ status: 401, body: JSON.stringify({ code: 99991677 }) })
    await expect(
      larkUserRequest("fixture", CREDS, "POST", "/im/v1/messages", { text: "fixture" })
    ).rejects.toThrow("lark_auth_stale")
    expect(mHttp).toHaveBeenCalledTimes(1)
  })

  it("uses the token captured with the retry epoch even when another native continuation replaces the account", async () => {
    let state = { configured: true, authorizationEpoch: "auth-a", accessToken: "user-a" }
    let refreshFinished = false
    ;(connectorsLarkUserAuth as jest.Mock).mockImplementation(async () => {
      const captured = state
      if (refreshFinished)
        queueMicrotask(() => {
          state = { ...state, authorizationEpoch: "auth-b", accessToken: "user-b" }
        })
      return captured
    })
    mUserToken.mockImplementation(async () => state.accessToken)
    ;(refreshUserToken as jest.Mock).mockImplementation(async () => {
      state = { ...state, accessToken: "refreshed-a" }
      refreshFinished = true
      return "refreshed-a"
    })
    mHttp
      .mockResolvedValueOnce({ status: 401, body: JSON.stringify({ code: 99991677 }) })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ code: 0, data: {} }) })
    await expect(
      larkUserRequest("fixture", CREDS, "POST", "/im/v1/messages", { text: "fixture" })
    ).rejects.toThrow("lark_auth_stale")
    expect(state.authorizationEpoch).toBe("auth-b")
    expect(mHttp.mock.calls.map(([request]) => request.headers.Authorization)).toEqual([
      "Bearer user-a",
      "Bearer refreshed-a",
    ])
  })
  it("returns null when the adapter has no stored user token", async () => {
    mUserToken.mockResolvedValue(null)
    expect(await larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x")).toBeNull()
    expect(mHttp).not.toHaveBeenCalled()
  })

  it("uses the user token as the bearer when present", async () => {
    mUserToken.mockResolvedValue("user-tok")
    const out = await larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x")
    expect(out).toEqual({ code: 0, data: { ok: true } })
    expect(mHttp.mock.calls[0][0].headers.Authorization).toBe("Bearer user-tok")
  })
})

describe("classifyScopeError", () => {
  it("maps the Lark permission code family to ChatManagementScopeError", () => {
    const err = new LarkApiError({ status: 200, code: 99991672, message: "no scope" })
    const scoped = classifyScopeError(err, "im:chat:create")
    expect(scoped).toBeInstanceOf(ChatManagementScopeError)
    expect(scoped?.requiredScope).toBe("im:chat:create")
    expect(scoped?.platform).toBe("lark")
    expect(scoped?.message).toContain("im:chat:create")
  })

  it("maps bare HTTP 403 to a scope error", () => {
    const err = new LarkApiError({ status: 403, code: null, message: "forbidden" })
    expect(classifyScopeError(err, "im:chat:update")).toBeInstanceOf(ChatManagementScopeError)
  })

  it("returns null for non-permission LarkApiErrors and foreign errors", () => {
    expect(
      classifyScopeError(new LarkApiError({ status: 200, code: 230001, message: "x" }), "s")
    ).toBeNull()
    expect(classifyScopeError(new Error("boom"), "s")).toBeNull()
  })
})

describe("Lark rate-limit reset headers", () => {
  it.each([429, 400, 200])("retains the server delay on HTTP %s", async (status) => {
    mHttp.mockResolvedValue({
      status,
      headers: { "x-ogw-ratelimit-reset": "1.5" },
      body: JSON.stringify({ code: 99991400, msg: "limited" }),
    })
    await expect(larkTenantRequest(CREDS, "GET", "/x")).rejects.toMatchObject({
      retryAfterMs: 1500,
    })
    expect(mHttp).toHaveBeenCalledTimes(1)
  })
})
