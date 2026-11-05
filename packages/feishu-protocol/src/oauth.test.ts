import {
  LarkOAuthError,
  buildLarkOAuthUrl,
  exchangeCodeForUserAccessToken,
  fetchLarkUserInfo,
  refreshUserAccessToken,
  requestTenantAccessToken,
} from "./oauth"
import {
  LARK_BITABLE_SCOPES,
  LARK_SENDAS_SCOPES,
  LARK_TASK_SCOPES,
  mergeLarkScopes,
} from "./scopes"
import type { FeishuHttpRequest, FeishuTransport } from "./transport"

/** A transport that records requests and answers each with the next body. */
function fakeTransport(...bodies: unknown[]) {
  const requests: FeishuHttpRequest[] = []
  const transport: FeishuTransport = async (request) => {
    requests.push(request)
    return { status: 200, headers: {}, body: JSON.stringify(bodies.shift() ?? {}) }
  }
  return { transport, requests }
}

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

describe("requestTenantAccessToken", () => {
  it("POSTs the internal-app endpoint with the app credentials and returns the TTL", async () => {
    const { transport, requests } = fakeTransport({
      code: 0,
      tenant_access_token: "t-1",
      expire: 3600,
    })
    await expect(
      requestTenantAccessToken({ transport, appId: "cli_a", appSecret: "s" })
    ).resolves.toEqual({ token: "t-1", expiresInSec: 3600 })
    expect(requests[0]).toMatchObject({
      url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      method: "POST",
    })
    expect(JSON.parse(requests[0]!.body!)).toEqual({ app_id: "cli_a", app_secret: "s" })
  })

  it("uses the Lark deployment and defaults the TTL to 7200 s", async () => {
    const { transport, requests } = fakeTransport({ code: 0, tenant_access_token: "t-2" })
    const token = await requestTenantAccessToken({
      transport,
      appId: "cli_a",
      appSecret: "s",
      brand: "lark",
    })
    expect(token.expiresInSec).toBe(7200)
    expect(new URL(requests[0]!.url).origin).toBe("https://open.larksuite.com")
  })

  it("throws with Feishu's code and message on failure", async () => {
    const { transport } = fakeTransport({ code: 99991663, msg: "Invalid app" })
    await expect(
      requestTenantAccessToken({ transport, appId: "cli_a", appSecret: "s" })
    ).rejects.toThrow("code=99991663, msg=Invalid app")
  })
})

describe("the v2 token endpoint", () => {
  const tokens = {
    code: 0,
    access_token: "u-token",
    refresh_token: "u-refresh",
    token_type: "Bearer",
    scope: "offline_access im:message",
  }

  it("exchanges a code with client credentials and the PKCE verifier", async () => {
    const { transport, requests } = fakeTransport(tokens)
    const result = await exchangeCodeForUserAccessToken({
      transport,
      code: "c",
      appId: "cli_a",
      appSecret: "s",
      redirectUri: "https://relay.example/cb",
      codeVerifier: "v",
    })
    expect(requests[0]!.url).toBe("https://open.feishu.cn/open-apis/authen/v2/oauth/token")
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      grant_type: "authorization_code",
      client_id: "cli_a",
      client_secret: "s",
      code: "c",
      redirect_uri: "https://relay.example/cb",
      code_verifier: "v",
    })
    // Defaults fill the TTLs the response left out.
    expect(result).toEqual({
      accessToken: "u-token",
      refreshToken: "u-refresh",
      expiresInSec: 7200,
      refreshExpiresInSec: 31_104_000,
      tokenType: "Bearer",
      scope: "offline_access im:message",
    })
  })

  it("refreshes with the refresh_token grant", async () => {
    const { transport, requests } = fakeTransport(tokens)
    await refreshUserAccessToken({ transport, refreshToken: "r", appId: "cli_a", appSecret: "s" })
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      grant_type: "refresh_token",
      client_id: "cli_a",
      client_secret: "s",
      refresh_token: "r",
    })
  })

  it("throws LarkOAuthError carrying Feishu's OAuth error code", async () => {
    const { transport } = fakeTransport({
      code: 20064,
      error: "invalid_grant",
      error_description: "refresh token revoked",
    })
    const failure = refreshUserAccessToken({
      transport,
      refreshToken: "r",
      appId: "cli_a",
      appSecret: "s",
    })
    await expect(failure).rejects.toBeInstanceOf(LarkOAuthError)
    await expect(failure).rejects.toMatchObject({
      code: "invalid_grant",
      message: "Lark oauth/token refresh failed: refresh token revoked",
    })
  })

  it("rejects a success code without both tokens", async () => {
    const { transport } = fakeTransport({ code: 0, access_token: "only-access" })
    await expect(
      exchangeCodeForUserAccessToken({
        transport,
        code: "c",
        appId: "cli_a",
        appSecret: "s",
        redirectUri: "https://relay.example/cb",
      })
    ).rejects.toThrow("Lark oauth/token access failed: code=0")
  })
})

describe("fetchLarkUserInfo", () => {
  it("GETs user_info with the bearer token and maps the identity", async () => {
    const { transport, requests } = fakeTransport({
      code: 0,
      data: {
        open_id: "ou_1",
        tenant_key: "tk",
        name: "Alice",
        enterprise_email: "a@corp.example",
      },
    })
    await expect(fetchLarkUserInfo({ transport, accessToken: "u-token" })).resolves.toEqual({
      openId: "ou_1",
      tenantKey: "tk",
      unionId: undefined,
      name: "Alice",
      avatarUrl: undefined,
      email: undefined,
      enterpriseEmail: "a@corp.example",
    })
    expect(requests[0]).toMatchObject({
      url: "https://open.feishu.cn/open-apis/authen/v1/user_info",
      method: "GET",
      headers: { Authorization: "Bearer u-token" },
    })
  })

  it("throws on a non-zero code", async () => {
    const { transport } = fakeTransport({ code: 99991677, msg: "expired" })
    await expect(fetchLarkUserInfo({ transport, accessToken: "x" })).rejects.toThrow(
      "Lark user_info failed: code=99991677, msg=expired"
    )
  })
})
