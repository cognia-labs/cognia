import { createHash } from "node:crypto"
import { LarkApiError } from "@cognia/feishu-protocol"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import {
  admitPersonalCredential,
  PersonalCredentialRefusedError,
} from "@/lib/execution/personal-credential"
import { assertHostConnectionCredentialAuthorization } from "@/lib/plugin/auth/connection-manager"
import {
  connectorsHttpRequest,
  connectorsKeyringGet,
  connectorsKeyringSet,
  connectorsLarkUserAuth,
} from "@/lib/connectors/tauri/commands"
import {
  getTenantAccessToken,
  getTenantToken,
  clearTokenCache,
  exchangeCodeForUserAccessToken,
  refreshUserAccessToken,
  fetchLarkUserInfo,
  refreshUserToken,
} from "./auth"
import { withUserTokenRefresh } from "./auth-retry"
import { larkAuthorizedPerson, markLarkNeedsReauth, reconcileLarkConnection } from "./host-auth"

const mockHttp = connectorsHttpRequest as jest.Mock
const mockKeyringGet = connectorsKeyringGet as jest.Mock
const mockKeyringSet = connectorsKeyringSet as jest.Mock
const mockLarkUserAuth = connectorsLarkUserAuth as jest.Mock
const mockAdmit = admitPersonalCredential as jest.Mock
const mockAssertConnection = assertHostConnectionCredentialAuthorization as jest.Mock
const mockAuthorizedPerson = larkAuthorizedPerson as jest.Mock
const mockMarkNeedsReauth = markLarkNeedsReauth as jest.Mock
const mockReconcile = reconcileLarkConnection as jest.Mock

/** `larkUserKey(openId)`: the key a person's authorization is stored under. */
const keyOf = (openId: string) => createHash("sha256").update(openId).digest("hex")
const ALICE = keyOf("ou_alice")
const BOB = keyOf("ou_bob")

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
  connectorsKeyringSet: jest.fn(),
  connectorsLarkUserAuth: jest.fn(),
}))
jest.mock("@/lib/execution/personal-credential", () => ({
  ...jest.requireActual("@/lib/execution/personal-credential"),
  admitPersonalCredential: jest.fn(),
}))
jest.mock("@/lib/plugin/auth/connection-manager", () => ({
  assertHostConnectionCredentialAuthorization: jest.fn(),
}))
jest.mock("./host-auth", () => ({
  larkAuthorizedPerson: jest.fn(),
  markLarkNeedsReauth: jest.fn(),
  reconcileLarkConnection: jest.fn(),
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
    const token = await getTenantAccessToken(
      { appId: APP_ID, appSecret: APP_SECRET },
      "service-data"
    )
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

    const t1 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET }, "service-data")
    const t2 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET }, "service-data")

    expect(t1).toBe("t-cached")
    expect(t2).toBe("t-cached")
    expect(mockHttp).toHaveBeenCalledTimes(1) // cached on second call
  })

  it("re-fetches after the cache is cleared", async () => {
    mockHttp
      .mockResolvedValueOnce(makeTokenResponse("t-first"))
      .mockResolvedValueOnce(makeTokenResponse("t-second"))

    await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET }, "service-data")
    clearTokenCache(APP_ID, APP_SECRET)
    const t2 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET }, "service-data")

    expect(t2).toBe("t-second")
    expect(mockHttp).toHaveBeenCalledTimes(2)
  })

  it("throws when Lark returns a non-zero code", async () => {
    mockHttp.mockResolvedValue(makeErrorResponse(99991663, "invalid_app"))
    await expect(
      getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET }, "service-data")
    ).rejects.toThrow(/tenant_access_token failed/)
  })

  it("sends appId and appSecret in the request body", async () => {
    mockHttp.mockResolvedValue(makeTokenResponse())
    await getTenantAccessToken({ appId: "cli_abc", appSecret: "sec_xyz" }, "service-data")

    const call = mockHttp.mock.calls[0][0] as { body: string }
    const body = JSON.parse(call.body) as { app_id: string; app_secret: string }
    expect(body.app_id).toBe("cli_abc")
    expect(body.app_secret).toBe("sec_xyz")
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

describe("refreshUserToken (send-as-user, one person's authorization)", () => {
  /** Each person's Host authorization on `lark-u`, by `larkUserKey`. */
  let people: Record<string, Record<string, unknown>>

  beforeEach(() => {
    mockHttp.mockReset()
    mockKeyringGet.mockReset()
    mockKeyringSet.mockReset()
    mockAdmit.mockReset().mockImplementation(async (_context, credential) => ({
      ok: true,
      source: credential.source,
      person: credential.person,
    }))
    mockAuthorizedPerson
      .mockReset()
      .mockImplementation(async (adapterId: string, principal: string) =>
        principal === ALICE
          ? { kind: "platform", platform: "lark", adapterId, remoteUserId: "ou_alice" }
          : principal === BOB
            ? { kind: "platform", platform: "lark", adapterId, remoteUserId: "ou_bob" }
            : undefined
      )
    mockMarkNeedsReauth.mockReset().mockResolvedValue(undefined)
    mockReconcile.mockReset().mockResolvedValue(undefined)
    mockAssertConnection.mockReset().mockResolvedValue(undefined)
    people = {
      [ALICE]: {
        configured: true,
        accessToken: "alice-access",
        authorizationEpoch: "alice-epoch",
        refreshToken: "alice-refresh",
        refreshRevision: "alice-revision",
      },
      [BOB]: {
        configured: true,
        accessToken: "bob-access",
        authorizationEpoch: "bob-epoch",
        refreshToken: "bob-refresh",
        refreshRevision: "bob-revision",
      },
    }
    mockLarkUserAuth.mockReset().mockImplementation(async (input) => {
      const current = people[input.principal] ?? { configured: false, accessToken: null }
      if (input.action === "snapshot") return current
      people[input.principal] = {
        ...current,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
      }
      return people[input.principal]
    })
    clearTokenCache("cli_app", "secret")
  })

  const refreshAlice = (overrides: Partial<Parameters<typeof refreshUserToken>[0]> = {}) =>
    refreshUserToken({
      credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
      adapterId: "lark-u",
      principal: ALICE,
      appId: "cli_app",
      appSecret: "secret",
      ...overrides,
    })

  it("refreshes via the refresh token (v2) and persists the rotated pair", async () => {
    // A single v2 token-endpoint call — no tenant token needed anymore.
    mockHttp.mockResolvedValueOnce(
      makeTokenV2Response({ accessToken: "u-new-access", refreshToken: "u-new-refresh" })
    )

    await expect(refreshAlice()).resolves.toBe("u-new-access")

    expect(JSON.parse(mockHttp.mock.calls[0][0].body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "alice-refresh",
    })
    // Rotated tokens published through the Host, for this person only.
    expect(mockLarkUserAuth).toHaveBeenCalledWith({
      action: "refresh",
      adapterId: "lark-u",
      principal: ALICE,
      expectedAuthorizationEpoch: "alice-epoch",
      expectedRefreshRevision: "alice-revision",
      accessToken: "u-new-access",
      refreshToken: "u-new-refresh",
    })
    expect(mockKeyringSet).not.toHaveBeenCalled()
    expect(mockReconcile).toHaveBeenCalledWith("lark-u", ALICE, {
      expiresAt: expect.any(String),
      onlyExisting: true,
    })
  })

  it("admits the person whose authorization it refreshes", async () => {
    mockHttp.mockResolvedValueOnce(makeTokenV2Response({}))
    await refreshAlice()
    expect(mockAuthorizedPerson).toHaveBeenCalledWith("lark-u", ALICE)
    expect(mockAdmit).toHaveBeenCalledWith(
      { localAuthorization: LOCAL_PERSON_RUN },
      {
        source: "lark-user",
        person: {
          kind: "platform",
          platform: "lark",
          adapterId: "lark-u",
          remoteUserId: "ou_alice",
        },
      }
    )
  })

  it("refuses a person who never authorized this adapter before reading any token", async () => {
    await expect(refreshAlice({ principal: keyOf("ou_stranger") })).rejects.toThrow(
      "lark_auth_stale"
    )
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockLarkUserAuth).not.toHaveBeenCalled()
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("refuses when the run may not use that person's credential", async () => {
    mockAdmit.mockResolvedValueOnce({
      ok: false,
      source: "lark-user",
      reason: "owner-not-verified",
    })
    await expect(refreshAlice()).rejects.toBeInstanceOf(PersonalCredentialRefusedError)
    expect(mockLarkUserAuth).not.toHaveBeenCalled()
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("takes a Host connection authorization instead of a personal admission", async () => {
    mockHttp.mockResolvedValueOnce(makeTokenV2Response({ accessToken: "via-connection" }))
    const connectionAuthorization = {} as NonNullable<
      Parameters<typeof refreshUserToken>[0]["connectionAuthorization"]
    >
    await expect(
      refreshAlice({ credentialContext: undefined, connectionAuthorization })
    ).resolves.toBe("via-connection")
    expect(mockAssertConnection).toHaveBeenCalledWith(connectionAuthorization, "lark-u")
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockAuthorizedPerson).not.toHaveBeenCalled()
  })

  it("refreshes one person's authorization without touching another's", async () => {
    mockHttp.mockResolvedValueOnce(
      makeTokenV2Response({ accessToken: "bob-rotated", refreshToken: "bob-refresh-2" })
    )
    await expect(refreshAlice({ principal: BOB })).resolves.toBe("bob-rotated")

    expect(JSON.parse(mockHttp.mock.calls[0][0].body).refresh_token).toBe("bob-refresh")
    for (const [input] of mockLarkUserAuth.mock.calls) expect(input.principal).toBe(BOB)
    expect(mockLarkUserAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refresh",
        principal: BOB,
        expectedAuthorizationEpoch: "bob-epoch",
        expectedRefreshRevision: "bob-revision",
      })
    )
    expect(people[ALICE]).toMatchObject({
      accessToken: "alice-access",
      refreshToken: "alice-refresh",
    })
    expect(mockReconcile).toHaveBeenCalledWith("lark-u", BOB, expect.anything())
    expect(mockReconcile).not.toHaveBeenCalledWith("lark-u", ALICE, expect.anything())
  })

  it("marks only that person's authorization for reauth when Lark rejects the grant", async () => {
    mockHttp.mockResolvedValueOnce(
      makeTokenV2Response({
        code: 20037,
        error: "invalid_grant",
        errorDescription: "refresh token expired",
      })
    )
    await expect(refreshAlice()).rejects.toThrow(/refresh token expired/)
    expect(mockMarkNeedsReauth).toHaveBeenCalledTimes(1)
    expect(mockMarkNeedsReauth).toHaveBeenCalledWith(
      "lark-u",
      ALICE,
      "alice-epoch",
      "alice-revision"
    )
    expect(mockLarkUserAuth).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "refresh" })
    )
  })

  it("throws when there is no refresh token to use", async () => {
    people[ALICE] = { ...people[ALICE], refreshToken: null }
    await expect(refreshAlice()).rejects.toThrow(/no refresh token/)
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("refuses a replaced authorization when the caller pinned an epoch", async () => {
    await expect(refreshAlice({ expectedAuthorizationEpoch: "older-epoch" })).rejects.toThrow(
      "lark_auth_stale"
    )
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("does not refresh a revoked access identity even if its refresh token remains", async () => {
    people[ALICE] = {
      configured: true,
      authorizationEpoch: "revoked",
      accessToken: null,
      refreshToken: "still-stored",
      refreshRevision: "revision-a",
    }
    await expect(refreshAlice({ appId: "app" })).rejects.toThrow(
      /lark_auth_stale|authorization-unavailable/
    )
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it("returns a concurrent refresh of the same authorization that won the race", async () => {
    mockHttp.mockResolvedValueOnce(makeTokenV2Response({ accessToken: "lost-race" }))
    mockLarkUserAuth.mockImplementation(async (input) => {
      if (input.action === "refresh") throw new Error("lark_auth_stale")
      return mockLarkUserAuth.mock.calls.length > 1
        ? { ...people[ALICE], accessToken: "won-race" }
        : people[ALICE]
    })
    await expect(refreshAlice()).resolves.toBe("won-race")
  })

  it("saves an already-dispatched refresh pair even if its caller aborts", async () => {
    const controller = new AbortController()
    mockHttp.mockImplementation(async () => {
      controller.abort()
      return makeTokenV2Response({ accessToken: "rotated-access", refreshToken: "rotated-refresh" })
    })
    await expect(refreshAlice({ signal: controller.signal })).resolves.toBe("rotated-access")
    expect(mockLarkUserAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refresh",
        principal: ALICE,
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
      mockLarkUserAuth.mockImplementation(async () => state)
      const request = jest.fn(async () => {
        state = { ...state, authorizationEpoch: "auth-replaced", accessToken }
        throw new LarkApiError({ status: 401, code: 99991677, message: "old request rejected" })
      })
      await expect(
        withUserTokenRefresh(
          {
            adapterId: "lark-u",
            principal: ALICE,
            appId: "app",
            appSecret: "secret",
            credentialContext: { localAuthorization: LOCAL_PERSON_RUN },
          },
          request
        )
      ).rejects.toThrow(/lark_auth_stale|authorization-unavailable/)
      expect(request).toHaveBeenCalledTimes(1)
      expect(mockHttp).not.toHaveBeenCalled()
      expect(mockLarkUserAuth).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "refresh" })
      )
    }
  )
})

it("shares the same tenant token and request across every purpose", async () => {
  clearTokenCache("purpose-app", "purpose-secret")
  mockHttp.mockReset().mockResolvedValue(makeTokenResponse("same-token"))
  const creds = { appId: "purpose-app", appSecret: "purpose-secret" }
  for (const purpose of ["transport", "service-data", "adapter-admin"] as const) {
    expect(await getTenantToken(creds, purpose)).toBe("same-token")
  }
  expect(mockHttp).toHaveBeenCalledTimes(1)
  expect(JSON.parse(mockHttp.mock.calls[0][0].body)).toEqual({
    app_id: creds.appId,
    app_secret: creds.appSecret,
  })
})
