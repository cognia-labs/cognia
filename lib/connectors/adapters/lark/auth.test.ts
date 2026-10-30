import {
  connectorsHttpRequest,
  connectorsKeyringGet,
  connectorsKeyringSet,
  connectorsLarkUserAuth,
} from "@/lib/connectors/tauri/commands"
import {
  LARK_SENDAS_SCOPES,
  LARK_DOC_READ_SCOPES,
  LARK_TASK_SCOPES,
  LARK_BITABLE_SCOPES,
  hasLarkDocumentSearchScope,
  mergeLarkScopes,
  getTenantAccessToken,
  clearTokenCache,
  buildLarkOAuthUrl,
  exchangeCodeForUserAccessToken,
  refreshUserAccessToken,
  fetchLarkUserInfo,
  getUserAccessToken,
  refreshUserToken,
} from "./auth"
import { LarkApiError, withUserTokenRefresh } from "./auth-retry"

const mockHttp = connectorsHttpRequest as jest.Mock
const mockKeyringGet = connectorsKeyringGet as jest.Mock
const mockKeyringSet = connectorsKeyringSet as jest.Mock

it("requests read-only document scopes and distinguishes search grants from IM-only grants", () => {
  expect(LARK_DOC_READ_SCOPES.split(" ").every((scope) => /:read(?:only)?$/.test(scope))).toBe(true)
  expect(LARK_DOC_READ_SCOPES.split(" ")).toContain("search:docs:read")
  expect(hasLarkDocumentSearchScope(["drive:drive:readonly"])).toBe(false)
  expect(hasLarkDocumentSearchScope(["drive:drive.search:readonly"])).toBe(true)
  expect(hasLarkDocumentSearchScope(LARK_SENDAS_SCOPES.split(" "))).toBe(false)
  expect(hasLarkDocumentSearchScope(LARK_DOC_READ_SCOPES.split(" "))).toBe(true)
  expect(hasLarkDocumentSearchScope(["search:docs:read"])).toBe(true)
  expect(hasLarkDocumentSearchScope(["drive:drive"])).toBe(true)
})

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
  connectorsKeyringSet: jest.fn(),
  connectorsLarkUserAuth: jest.fn(),
}))

function makeTokenResponse(token = "t-test-tat-123", expire = 7200, code = 0) {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code, tenant_access_token: token, expire }),
  }
}

function makeErrorResponse(code = 99991663, msg = "Invalid app") {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code, msg }),
  }
}

describe("getTenantAccessToken", () => {
  const APP_ID = "cli_test_app_001"
  const APP_SECRET = "test-secret-001"

  beforeEach(() => {
    mockHttp.mockReset()
    clearTokenCache(APP_ID, APP_SECRET)
  })

  it("fetches a token and returns it", async () => {
    mockHttp.mockResolvedValue(makeTokenResponse("t-fresh"))
    const token = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })
    expect(token).toBe("t-fresh")
    expect(mockHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("tenant_access_token/internal"),
        method: "POST",
      })
    )
  })

  it("returns the cached token on a second call without hitting the API", async () => {
    mockHttp.mockResolvedValue(makeTokenResponse("t-cached"))

    const t1 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })
    const t2 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })

    expect(t1).toBe("t-cached")
    expect(t2).toBe("t-cached")
    expect(mockHttp).toHaveBeenCalledTimes(1) // cached on second call
  })

  it("re-fetches after the cache is cleared", async () => {
    mockHttp
      .mockResolvedValueOnce(makeTokenResponse("t-first"))
      .mockResolvedValueOnce(makeTokenResponse("t-second"))

    await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })
    clearTokenCache(APP_ID, APP_SECRET)
    const t2 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })

    expect(t2).toBe("t-second")
    expect(mockHttp).toHaveBeenCalledTimes(2)
  })

  it("throws when Lark returns a non-zero code", async () => {
    mockHttp.mockResolvedValue(makeErrorResponse(99991663, "invalid_app"))
    await expect(getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET })).rejects.toThrow(
      /tenant_access_token failed/
    )
  })

  it("sends appId and appSecret in the request body", async () => {
    mockHttp.mockResolvedValue(makeTokenResponse())
    await getTenantAccessToken({ appId: "cli_abc", appSecret: "sec_xyz" })

    const call = mockHttp.mock.calls[0][0] as { body: string }
    const body = JSON.parse(call.body) as { app_id: string; app_secret: string }
    expect(body.app_id).toBe("cli_abc")
    expect(body.app_secret).toBe("sec_xyz")
  })
})

describe("mergeLarkScopes", () => {
  it("joins groups, drops repeats and blanks, and keeps first-seen order", () => {
    expect(
      mergeLarkScopes("offline_access im:message", undefined, " task:task:read  im:message ")
    ).toBe("offline_access im:message task:task:read")
    expect(mergeLarkScopes()).toBe("")
  })
})

describe("buildLarkOAuthUrl", () => {
  it("requests the selected tracker account's user scopes explicitly", () => {
    const url = new URL(
      buildLarkOAuthUrl({
        appId: "cli_tracker",
        redirectUri: "https://relay.example/oauth/lark/callback",
        state: "tracker-state",
        scope: mergeLarkScopes("offline_access", LARK_TASK_SCOPES, LARK_BITABLE_SCOPES),
      })
    )
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining([
        "offline_access",
        "task:task:read",
        "task:task:write",
        "task:tasklist:read",
        "task:section:read",
        "bitable:app",
      ])
    )
  })
  it("requests both mandatory user-send permissions and refresh access for send-as-user", () => {
    const url = new URL(
      buildLarkOAuthUrl({
        appId: "cli_send_as_user",
        redirectUri: "https://relay.example/oauth/lark/callback",
        state: "send-as-state",
        scope: LARK_SENDAS_SCOPES,
      })
    )

    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "offline_access",
      "im:message",
      "im:message.send_as_user",
    ])
  })

  it("builds an OAuth 2.0 authorize URL with client_id + response_type", () => {
    const url = buildLarkOAuthUrl({
      appId: "cli_my_app",
      redirectUri: "https://relay.example/oauth/lark/callback",
      state: "random-state-123",
      scope: "offline_access im:message",
      codeChallenge: "challenge-abc",
    })
    expect(url).toContain("accounts.feishu.cn")
    expect(url).toContain("authen/v1/authorize")
    expect(url).toContain("client_id=cli_my_app")
    expect(url).toContain("response_type=code")
    expect(url).toContain("state=random-state-123")
    // scope is space-separated → URL-encoded to +/%20
    expect(decodeURIComponent(new URL(url).searchParams.get("scope") ?? "")).toBe(
      "offline_access im:message"
    )
    expect(url).toContain("code_challenge=challenge-abc")
    expect(url).toContain("code_challenge_method=S256")
  })

  it("omits scope and PKCE params when not supplied", () => {
    const url = buildLarkOAuthUrl({
      appId: "cli_app",
      redirectUri: "https://relay.example/cb",
      state: "s",
    })
    expect(url).not.toContain("scope=")
    expect(url).not.toContain("code_challenge")
  })

  it("URL-encodes the redirect_uri", () => {
    const url = buildLarkOAuthUrl({
      appId: "cli_app",
      redirectUri: "https://relay.example/oauth/lark/callback?foo=bar",
      state: "s",
    })
    expect(url).not.toContain("/callback?foo=bar")
    expect(url).toContain("redirect_uri=")
  })
})

// ---------------------------------------------------------------------------
// OAuth 2.0 code exchange + refresh + user info (authen/v2/oauth/token)
// ---------------------------------------------------------------------------

function makeTokenV2Response(
  opts: {
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
    refreshExpiresIn?: number
    scope?: string
    code?: number
    error?: string
    errorDescription?: string
  } = {}
) {
  const isErr = opts.code !== undefined && opts.code !== 0
  return {
    status: 200,
    headers: {},
    body: JSON.stringify(
      isErr
        ? { code: opts.code, error: opts.error, error_description: opts.errorDescription }
        : {
            code: 0,
            access_token: opts.accessToken ?? "u-token",
            refresh_token: opts.refreshToken ?? "u-refresh",
            expires_in: opts.expiresIn ?? 7200,
            refresh_token_expires_in: opts.refreshExpiresIn ?? 31_104_000,
            token_type: "Bearer",
            scope: opts.scope ?? "offline_access im:message",
          }
    ),
  }
}

function makeUserInfoResponse(
  opts: { openId?: string; name?: string; code?: number; msg?: string } = {}
) {
  const ok = (opts.code ?? 0) === 0
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({
      code: opts.code ?? 0,
      msg: opts.msg,
      data: ok
        ? {
            open_id: opts.openId ?? "ou_default",
            union_id: "on_default",
            name: opts.name ?? "User",
            avatar_url: "https://avatar.example.com",
            email: "user@example.com",
            enterprise_email: "user@bigcorp.example.com",
          }
        : undefined,
    }),
  }
}

describe("exchangeCodeForUserAccessToken", () => {
  beforeEach(() => {
    mockHttp.mockReset()
  })

  it("POSTs the v2 token endpoint with client credentials + PKCE verifier", async () => {
    mockHttp.mockResolvedValueOnce(
      makeTokenV2Response({ accessToken: "u-access", refreshToken: "u-refresh" })
    )
    const result = await exchangeCodeForUserAccessToken({
      code: "abc123",
      appId: "cli_app",
      appSecret: "sec",
      redirectUri: "https://relay/oauth/lark/callback",
      codeVerifier: "verifier-1",
    })
    expect(result.accessToken).toBe("u-access")
    expect(result.refreshToken).toBe("u-refresh")
    expect(result.expiresInSec).toBe(7200)
    expect(result.refreshExpiresInSec).toBe(31_104_000)

    const call = mockHttp.mock.calls[0][0] as {
      url: string
      headers: Record<string, string>
      body: string
    }
    expect(call.url).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token")
    // v2 sends client_secret in the body — no Bearer header.
    expect(call.headers.Authorization).toBeUndefined()
    expect(JSON.parse(call.body)).toEqual({
      grant_type: "authorization_code",
      client_id: "cli_app",
      client_secret: "sec",
      code: "abc123",
      redirect_uri: "https://relay/oauth/lark/callback",
      code_verifier: "verifier-1",
    })
  })

  it("omits code_verifier when not supplied", async () => {
    mockHttp.mockResolvedValueOnce(makeTokenV2Response({}))
    await exchangeCodeForUserAccessToken({
      code: "c",
      appId: "a",
      appSecret: "s",
      redirectUri: "r",
    })
    const body = JSON.parse((mockHttp.mock.calls[0][0] as { body: string }).body)
    expect(body.code_verifier).toBeUndefined()
  })

  it("throws with Feishu's error_description on failure", async () => {
    mockHttp.mockResolvedValueOnce(
      makeTokenV2Response({ code: 20050, error: "invalid_grant", errorDescription: "code expired" })
    )
    await expect(
      exchangeCodeForUserAccessToken({
        code: "stale",
        appId: "a",
        appSecret: "s",
        redirectUri: "r",
      })
    ).rejects.toThrow(/code expired/)
  })

  it("throws when the response is missing access_token", async () => {
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, refresh_token: "r-only" }),
    })
    await expect(
      exchangeCodeForUserAccessToken({ code: "x", appId: "a", appSecret: "s", redirectUri: "r" })
    ).rejects.toThrow(/oauth\/token access failed/)
  })

  it("applies default TTLs + token_type when the response omits them", async () => {
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ access_token: "a", refresh_token: "r" }),
    })
    const result = await exchangeCodeForUserAccessToken({
      code: "c",
      appId: "a",
      appSecret: "s",
      redirectUri: "r",
    })
    expect(result.expiresInSec).toBe(7200)
    expect(result.refreshExpiresInSec).toBe(31_104_000)
    expect(result.tokenType).toBe("Bearer")
    expect(result.scope).toBeUndefined()
  })
})

describe("refreshUserAccessToken", () => {
  beforeEach(() => {
    mockHttp.mockReset()
  })

  it("POSTs the v2 token endpoint with the refresh_token grant body", async () => {
    mockHttp.mockResolvedValueOnce(
      makeTokenV2Response({ accessToken: "u-fresh", refreshToken: "u-rotated" })
    )
    const result = await refreshUserAccessToken({
      refreshToken: "old-refresh",
      appId: "cli_app",
      appSecret: "sec",
    })
    expect(result.accessToken).toBe("u-fresh")
    // Lark may rotate the refresh token; callers must persist whatever comes back.
    expect(result.refreshToken).toBe("u-rotated")

    const call = mockHttp.mock.calls[0][0] as { url: string; body: string }
    expect(call.url).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token")
    expect(JSON.parse(call.body)).toEqual({
      grant_type: "refresh_token",
      client_id: "cli_app",
      client_secret: "sec",
      refresh_token: "old-refresh",
    })
  })

  it("throws on non-zero refresh code", async () => {
    mockHttp.mockResolvedValueOnce(
      makeTokenV2Response({
        code: 20037,
        error: "invalid_grant",
        errorDescription: "refresh token expired",
      })
    )
    await expect(
      refreshUserAccessToken({ refreshToken: "expired", appId: "a", appSecret: "s" })
    ).rejects.toThrow(/refresh token expired/)
  })
})

describe("fetchLarkUserInfo", () => {
  beforeEach(() => {
    mockHttp.mockReset()
  })

  it("GETs user_info with a Bearer user token and maps the fields", async () => {
    mockHttp.mockResolvedValueOnce(makeUserInfoResponse({ openId: "ou_alice", name: "Alice" }))
    const info = await fetchLarkUserInfo("u-access")
    expect(info.openId).toBe("ou_alice")
    expect(info.name).toBe("Alice")
    expect(info.email).toBe("user@example.com")
    expect(info.enterpriseEmail).toBe("user@bigcorp.example.com")

    const call = mockHttp.mock.calls[0][0] as {
      url: string
      method: string
      headers: Record<string, string>
    }
    expect(call.url).toBe("https://open.feishu.cn/open-apis/authen/v1/user_info")
    expect(call.method).toBe("GET")
    expect(call.headers.Authorization).toBe("Bearer u-access")
  })

  it("throws on a non-zero code", async () => {
    mockHttp.mockResolvedValueOnce(makeUserInfoResponse({ code: 99991677, msg: "invalid token" }))
    await expect(fetchLarkUserInfo("bad")).rejects.toThrow(/user_info failed/)
  })

  it("tolerates a user_info response missing optional fields", async () => {
    mockHttp.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: JSON.stringify({ code: 0, data: {} }),
    })
    const info = await fetchLarkUserInfo("t")
    expect(info.openId).toBe("")
    expect(info.name).toBeUndefined()
    expect(info.email).toBeUndefined()
  })
})

describe("getUserAccessToken / refreshUserToken (send-as-user)", () => {
  beforeEach(() => {
    mockHttp.mockReset()
    mockKeyringGet.mockReset()
    mockKeyringSet.mockReset()
    ;(connectorsLarkUserAuth as jest.Mock).mockReset().mockImplementation(async (input) =>
      input.action === "snapshot"
        ? {
            configured: true,
            accessToken: "user-a",
            authorizationEpoch: "auth-a",
            refreshToken: await mockKeyringGet(input.adapterId, "user_refresh_token"),
            refreshRevision: "refresh-a",
          }
        : { authorizationEpoch: "auth-a", accessToken: input.accessToken }
    )
    clearTokenCache("cli_app", "secret")
  })

  it("returns null when no user token is stored", async () => {
    mockKeyringGet.mockResolvedValue(null)
    expect(await getUserAccessToken("lark-u")).toBeNull()
  })

  it("rechecks the host token so another window can replace the authorization", async () => {
    mockKeyringGet.mockResolvedValue("u-stored")
    expect(await getUserAccessToken("lark-u")).toBe("u-stored")
    expect(await getUserAccessToken("lark-u")).toBe("u-stored")
    expect(mockKeyringGet).toHaveBeenCalledTimes(2)
  })

  it("refreshes via the refresh token (v2) and persists the rotated pair", async () => {
    mockKeyringGet.mockImplementation(async (_id: string, cred: string) =>
      cred === "user_refresh_token" ? "old-refresh" : null
    )
    // A single v2 token-endpoint call — no tenant token needed anymore.
    mockHttp.mockResolvedValueOnce(
      makeTokenV2Response({ accessToken: "u-new-access", refreshToken: "u-new-refresh" })
    )

    const token = await refreshUserToken({
      adapterId: "lark-u",
      appId: "cli_app",
      appSecret: "secret",
    })

    expect(token).toBe("u-new-access")
    // Rotated tokens persisted back to the keyring.
    expect(connectorsLarkUserAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refresh",
        expectedAuthorizationEpoch: "auth-a",
        expectedRefreshRevision: "refresh-a",
        accessToken: "u-new-access",
        refreshToken: "u-new-refresh",
      })
    )
    expect(mockKeyringSet).not.toHaveBeenCalled()
    // A subsequent read uses the authoritative host value.
    mockKeyringGet.mockResolvedValue("u-new-access")
    mockKeyringGet.mockClear()
    expect(await getUserAccessToken("lark-u")).toBe("u-new-access")
    expect(mockKeyringGet).toHaveBeenCalledWith("lark-u", "user_token")
  })

  it("throws when there is no refresh token to use", async () => {
    mockKeyringGet.mockResolvedValue(null)
    await expect(
      refreshUserToken({ adapterId: "lark-u", appId: "cli_app", appSecret: "secret" })
    ).rejects.toThrow(/no refresh token/)
  })

  it("does not refresh a revoked access identity even if its refresh token remains", async () => {
    ;(connectorsLarkUserAuth as jest.Mock).mockResolvedValue({
      configured: true,
      authorizationEpoch: "revoked",
      accessToken: null,
      refreshToken: "still-stored",
      refreshRevision: "revision-a",
    })
    await expect(
      refreshUserToken({ adapterId: "lark-u", appId: "app", appSecret: "secret" })
    ).rejects.toThrow("lark_auth_stale")
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("saves an already-dispatched refresh pair even if its caller aborts", async () => {
    const controller = new AbortController()
    mockKeyringGet.mockResolvedValue("old-refresh")
    mockHttp.mockImplementation(async () => {
      controller.abort()
      return makeTokenV2Response({ accessToken: "rotated-access", refreshToken: "rotated-refresh" })
    })
    await expect(
      refreshUserToken({
        adapterId: "lark-u",
        appId: "app",
        appSecret: "secret",
        signal: controller.signal,
      })
    ).resolves.toBe("rotated-access")
    expect(connectorsLarkUserAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refresh",
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
      })
    )
  })

  it.each([null, "user-b"])(
    "pins the request identity before an old 401 arrives (%s)",
    async (accessToken) => {
      let state = {
        configured: true,
        authorizationEpoch: "auth-a",
        accessToken: "user-a" as string | null,
        refreshToken: "refresh-a",
        refreshRevision: "revision-a",
      }
      ;(connectorsLarkUserAuth as jest.Mock).mockImplementation(async () => state)
      const request = jest.fn(async () => {
        state = { ...state, authorizationEpoch: "auth-replaced", accessToken }
        throw new LarkApiError({ status: 401, code: 99991677, message: "old request rejected" })
      })
      await expect(
        withUserTokenRefresh({ adapterId: "lark-u", appId: "app", appSecret: "secret" }, request)
      ).rejects.toThrow("lark_auth_stale")
      expect(request).toHaveBeenCalledTimes(1)
      expect(mockHttp).not.toHaveBeenCalled()
      expect(connectorsLarkUserAuth).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "refresh" })
      )
    }
  )
})
