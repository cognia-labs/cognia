jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsLarkUserAuth: jest.fn(),
}))

jest.mock("@/lib/auth-providers/feishu/auth", () => {
  const getTenantAccessToken = jest.fn()
  return {
    getTenantAccessToken,
    getTenantToken: getTenantAccessToken,
    clearTokenCache: jest.fn(),
    refreshUserToken: jest.fn(),
  }
})

import { createHash } from "node:crypto"
import { LarkApiError } from "@cognia/feishu-protocol"
import { connectorsHttpRequest, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import {
  clearTokenCache,
  getTenantAccessToken,
  refreshUserToken,
} from "@/lib/auth-providers/feishu/auth"
import { classifyScopeError, larkTenantRequest, larkUserRequest } from "./http"
import { ChatManagementScopeError } from "@/types/connectors/chat-management"
import {
  assertLarkActingIdentity,
  LarkActingIdentityError,
} from "@/lib/auth-providers/feishu/cli/acting-identity"
import { resolveBuiltInSkillRunScope } from "@/lib/skills/built-in/context"
jest.mock("@/lib/skills/built-in/context", () => ({
  resolveBuiltInSkillRunScope: jest.fn((ctx) => ({
    sessionId: ctx.sessionId,
    runId: ctx.executionRunId,
  })),
}))
// Admission itself is pinned by acting-identity.test.ts; this suite covers the
// HTTP call made with the authorization it admits.
jest.mock("@/lib/auth-providers/feishu/cli/acting-identity", () => ({
  ...jest.requireActual("@/lib/auth-providers/feishu/cli/acting-identity"),
  assertLarkActingIdentity: jest.fn(),
}))

const mHttp = connectorsHttpRequest as jest.Mock
const mTat = getTenantAccessToken as jest.Mock
const mClear = clearTokenCache as jest.Mock
const mSnapshot = connectorsLarkUserAuth as jest.Mock

const CREDS = { appId: "cli_x", appSecret: "sec" }
/** The admitted person's authorization key (`larkUserKey` of their open_id). */
const KEY = createHash("sha256").update("ou_member").digest("hex")
/** The token the native snapshot holds for KEY; null = none. */
let userToken: string | null

beforeEach(() => {
  jest.clearAllMocks()
  userToken = "connected-user"
  jest
    .mocked(assertLarkActingIdentity)
    .mockReset()
    .mockImplementation(async (adapterId) => {
      const snapshot = await connectorsLarkUserAuth({
        action: "snapshot",
        adapterId,
        principal: KEY,
      })
      return snapshot.configured && snapshot.accessToken
        ? {
            principal: KEY,
            accessToken: snapshot.accessToken,
            authorizationEpoch: snapshot.authorizationEpoch!,
          }
        : undefined
    })
  mSnapshot.mockReset().mockImplementation(async () => ({
    configured: userToken !== null,
    authorizationEpoch: "http-fixture",
    accessToken: userToken,
  }))
  mTat.mockResolvedValue("tat-1")
  mHttp.mockResolvedValue({ status: 200, body: JSON.stringify({ code: 0, data: { ok: true } }) })
})

describe("larkTenantRequest", () => {
  it("opts avatar profile reads into the native no-redirect policy", async () => {
    await larkTenantRequest(CREDS, "GET", "/contact/v3/users/ou_1", undefined, "service-data", {
      avatarPolicy: true,
    })
    expect(mHttp.mock.calls[0][0].headers["X-Cognia-Avatar-Policy"]).toBe("1")
    mHttp.mockClear()
    await larkTenantRequest(CREDS, "GET", "/im/v1/chats/oc_1", undefined, "service-data")
    expect(mHttp.mock.calls[0][0].headers["X-Cognia-Avatar-Policy"]).toBeUndefined()
  })
  it("issues a bearer tenant-token request and returns the parsed body", async () => {
    const out = await larkTenantRequest(
      CREDS,
      "POST",
      "/im/v1/chats?x=1",
      { name: "g" },
      "service-data"
    )
    expect(out).toEqual({ code: 0, data: { ok: true } })
    const call = mHttp.mock.calls[0][0]
    expect(call.url).toBe("https://open.feishu.cn/open-apis/im/v1/chats?x=1")
    expect(call.method).toBe("POST")
    expect(call.headers.Authorization).toBe("Bearer tat-1")
    expect(JSON.parse(call.body)).toEqual({ name: "g" })
  })

  it("supports PUT (chat update — the factory closures never did)", async () => {
    await larkTenantRequest(CREDS, "PUT", "/im/v1/chats/oc_1", { name: "n" }, "service-data")
    expect(mHttp.mock.calls[0][0].method).toBe("PUT")
  })

  it("retries exactly once after a token-invalidation code, clearing the cache", async () => {
    mHttp
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ code: 99991663, msg: "invalid token" }),
      })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ code: 0, data: { ok: 1 } }) })
    const out = await larkTenantRequest(CREDS, "GET", "/x", undefined, "service-data")
    expect(out).toEqual({ code: 0, data: { ok: 1 } })
    expect(mClear).toHaveBeenCalledWith("cli_x", "sec")
    expect(mHttp).toHaveBeenCalledTimes(2)
  })

  it("throws LarkApiError on non-zero business codes (no retry for non-auth codes)", async () => {
    mHttp.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ code: 1248006, msg: "no perm" }),
    })
    await expect(
      larkTenantRequest(CREDS, "GET", "/x", undefined, "service-data")
    ).rejects.toBeInstanceOf(LarkApiError)
    expect(mHttp).toHaveBeenCalledTimes(1)
  })

  it("throws LarkApiError with the extracted code on HTTP >= 400", async () => {
    mHttp.mockResolvedValue({ status: 403, body: JSON.stringify({ code: 99991672, msg: "scope" }) })
    const err = await larkTenantRequest(CREDS, "GET", "/x", undefined, "service-data").catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(LarkApiError)
    expect((err as LarkApiError).status).toBe(403)
    expect((err as LarkApiError).code).toBe(99991672)
  })
})

describe("larkTenantRequest — body/parse edges", () => {
  it("omits the body for body-less requests and returns null for empty responses", async () => {
    mHttp.mockResolvedValue({ status: 200, body: "" })
    const out = await larkTenantRequest(
      CREDS,
      "GET",
      "/im/v1/chats/oc_1",
      undefined,
      "service-data"
    )
    expect(out).toBeNull()
    expect(mHttp.mock.calls[0][0].body).toBeUndefined()
  })

  it("extracts null codes from non-JSON error bodies (HTTP >= 400)", async () => {
    mHttp.mockResolvedValue({ status: 500, body: "<html>gateway error</html>" })
    const err = await larkTenantRequest(CREDS, "GET", "/x", undefined, "service-data").catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(LarkApiError)
    expect((err as LarkApiError).code).toBeNull()
  })

  it("ignores non-numeric code fields in error bodies", async () => {
    mHttp.mockResolvedValue({ status: 400, body: JSON.stringify({ code: "weird" }) })
    const err = await larkTenantRequest(CREDS, "GET", "/x", undefined, "service-data").catch(
      (e) => e
    )
    expect((err as LarkApiError).code).toBeNull()
  })
})

describe("larkUserRequest", () => {
  it("sends the admitted token, re-checking the same person's authorization", async () => {
    jest.mocked(assertLarkActingIdentity).mockResolvedValue({
      principal: KEY,
      accessToken: "admitted-token",
      authorizationEpoch: "auth-member",
    })
    mSnapshot.mockResolvedValue({
      configured: true,
      accessToken: "later-same-authorization-token",
      authorizationEpoch: "auth-member",
    })
    const ctx = { sessionId: "s1" }
    await larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x", undefined, ctx)
    expect(assertLarkActingIdentity).toHaveBeenCalledWith("a1", ctx)
    expect(mHttp.mock.calls[0][0].headers.Authorization).toBe("Bearer admitted-token")
    expect(mSnapshot).toHaveBeenCalledWith({ action: "snapshot", adapterId: "a1", principal: KEY })
  })

  it("refuses an authorization change between admission and the HTTP call", async () => {
    jest.mocked(assertLarkActingIdentity).mockResolvedValue({
      principal: KEY,
      accessToken: "alice-token",
      authorizationEpoch: "auth-alice",
    })
    mSnapshot.mockResolvedValue({
      configured: true,
      accessToken: "alice-reauthorized-token",
      authorizationEpoch: "auth-alice-2",
    })
    await expect(
      larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x", undefined, { sessionId: "s1" })
    ).rejects.toThrow("lark_auth_stale")
    expect(mHttp).not.toHaveBeenCalled()
  })

  it("does not refresh and retry an admitted request under a replacement authorization", async () => {
    jest
      .mocked(resolveBuiltInSkillRunScope)
      .mockReturnValueOnce({ sessionId: "parent", runId: "execution:job:child" })
    jest.mocked(assertLarkActingIdentity).mockResolvedValue({
      principal: KEY,
      accessToken: "alice-token",
      authorizationEpoch: "auth-alice",
    })
    let epoch = "auth-alice"
    mSnapshot.mockImplementation(async () => ({
      configured: true,
      accessToken: epoch === "auth-alice" ? "alice-token" : "alice-new-token",
      authorizationEpoch: epoch,
    }))
    mHttp.mockResolvedValue({ status: 401, body: JSON.stringify({ code: 99991677 }) })
    jest.mocked(refreshUserToken).mockImplementationOnce(async () => {
      epoch = "auth-alice-2"
      return "alice-new-token"
    })
    await expect(
      larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x", undefined, { sessionId: "s1" })
    ).rejects.toThrow("lark_auth_stale")
    expect(refreshUserToken).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "a1",
        principal: KEY,
        expectedAuthorizationEpoch: "auth-alice",
        credentialContext: { sessionId: "parent", executionRunId: "execution:job:child" },
      })
    )
    expect(mHttp).toHaveBeenCalledTimes(1)
    expect(mHttp.mock.calls[0][0].headers.Authorization).toBe("Bearer alice-token")
  })

  it("checks the acting identity before reading a user token", async () => {
    jest.mocked(assertLarkActingIdentity).mockRejectedValueOnce(new LarkActingIdentityError())
    const ctx = { sessionId: "im-session" }
    await expect(
      larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x", undefined, ctx)
    ).rejects.toThrow(/^personal_access_refused/)
    expect(assertLarkActingIdentity).toHaveBeenCalledWith("a1", ctx)
    expect(mSnapshot).not.toHaveBeenCalled()
    expect(mTat).not.toHaveBeenCalled()
    expect(mHttp).not.toHaveBeenCalled()
  })

  it("does not retry a write as a replacement identity after refresh commits", async () => {
    let state = { configured: true, authorizationEpoch: "auth-a", accessToken: "user-a" }
    mSnapshot.mockImplementation(async () => state)
    ;(refreshUserToken as jest.Mock).mockImplementation(async () => {
      state = { ...state, authorizationEpoch: "auth-b", accessToken: "user-b" }
      return "refreshed-a"
    })
    mHttp.mockResolvedValueOnce({ status: 401, body: JSON.stringify({ code: 99991677 }) })
    await expect(
      larkUserRequest("fixture", CREDS, "POST", "/im/v1/messages", { text: "fixture" })
    ).rejects.toThrow("lark_auth_stale")
    expect(mHttp).toHaveBeenCalledTimes(1)
    expect(refreshUserToken).toHaveBeenCalledWith(
      expect.objectContaining({ principal: KEY, credentialContext: undefined })
    )
  })

  it("uses the token captured with the retry epoch even when another native continuation replaces the account", async () => {
    let state = { configured: true, authorizationEpoch: "auth-a", accessToken: "user-a" }
    let refreshFinished = false
    mSnapshot.mockImplementation(async () => {
      const captured = state
      if (refreshFinished)
        queueMicrotask(() => {
          state = { ...state, authorizationEpoch: "auth-b", accessToken: "user-b" }
        })
      return captured
    })
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
  it("returns null when the admitted person has no stored user token", async () => {
    userToken = null
    expect(await larkUserRequest("a1", CREDS, "GET", "/search/v1/user?query=x")).toBeNull()
    expect(mHttp).not.toHaveBeenCalled()
  })

  it("uses the user token as the bearer when present", async () => {
    userToken = "user-tok"
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
    await expect(
      larkTenantRequest(CREDS, "GET", "/x", undefined, "service-data")
    ).rejects.toMatchObject({
      retryAfterMs: 1500,
    })
    expect(mHttp).toHaveBeenCalledTimes(1)
  })
})

it.each(["transport", "service-data", "adapter-admin"] as const)(
  "threads the %s label without adding it to the wire request",
  async (purpose) => {
    await larkTenantRequest(CREDS, "GET", "/bot/v3/info", undefined, purpose)
    expect(mTat).toHaveBeenCalledWith(CREDS, purpose)
    expect(mHttp.mock.calls[0][0]).toEqual({
      url: "https://open.feishu.cn/open-apis/bot/v3/info",
      method: "GET",
      headers: { Authorization: "Bearer tat-1", "Content-Type": "application/json; charset=utf-8" },
      body: undefined,
    })
  }
)

it("does not fall back to another token when admission has no authorization snapshot", async () => {
  jest.mocked(assertLarkActingIdentity).mockResolvedValue(undefined)
  expect(await larkUserRequest("a1", CREDS, "GET", "/private")).toBeNull()
  expect(mSnapshot).not.toHaveBeenCalled()
  expect(mHttp).not.toHaveBeenCalled()
})
