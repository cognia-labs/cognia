import type {
  AuthAttemptContext,
  AuthCredentialSet,
  AuthLineageContext,
  PluginContext,
} from "@cognia/plugin-sdk"
import { AuthRefreshRejected } from "@cognia/plugin-sdk"
import { createFeishuAuthProvider, FEISHU_PROVIDER_ID } from "./oauth"

export const TOKEN = {
  code: 0,
  access_token: "user-token",
  refresh_token: "refresh-one",
  expires_in: 7200,
  scope: "offline_access calendar:calendar:readonly",
}
const attempt: AuthAttemptContext = {
  attemptId: "host-state",
  providerId: FEISHU_PROVIDER_ID,
  method: "oauth-pkce",
  issuer: "https://accounts.feishu.cn",
  clientId: "app-one",
  codeVerifier: "verifier",
  codeChallenge: "challenge",
  redirectUri: "https://cognia.test/plugin-auth/callback",
  scopes: ["calendar:calendar:readonly"],
}
function fixture() {
  const exchangeConfidential = jest.fn(
    async (_request: unknown): Promise<{ status: number; body: Record<string, unknown> }> => ({
      status: 200,
      body: { ...TOKEN },
    })
  )
  const get = jest.fn(
    async (
      _url: string,
      _options?: unknown
    ): Promise<{ ok: boolean; status: number; data: unknown }> => ({
      ok: true,
      status: 200,
      data: { code: 0, data: { open_id: "ou_one", tenant_key: "tenant-one", name: "Person" } },
    })
  )
  const ctx = { auth: { exchangeConfidential }, network: { get } } as unknown as PluginContext
  const provider = createFeishuAuthProvider(ctx, { now: () => 1_000_000 })
  return { provider, exchangeConfidential, get }
}
function lineage(
  credentials: AuthCredentialSet,
  kind: "user" | "bot" = "user"
): AuthLineageContext {
  return {
    ref: "ref" as AuthLineageContext["ref"],
    lineageId: "lineage",
    credentialRevision: 1,
    credentials,
    identity: {
      provider: {
        providerId: FEISHU_PROVIDER_ID,
        ownerPluginId: "feishu-auth",
        publisher: "Cognia",
        contractMajor: 1,
      },
      issuer: attempt.issuer,
      clientId: attempt.clientId,
      principal: { id: kind === "bot" ? attempt.clientId : "ou_one", kind },
    },
  }
}

it.each(["feishu.cn", "larksuite.com"])(
  "builds bound PKCE and describes a user at %s without owning sessions",
  async (domain) => {
    const f = fixture()
    const bound = { ...attempt, issuer: `https://accounts.${domain}` }
    const url = new URL((await f.provider.authorize!(bound)).url)
    expect(url.origin).toBe(bound.issuer)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      state: "host-state",
      client_id: "app-one",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    })
    expect(url.searchParams.get("scope")).toContain("offline_access")
    const tokens = await f.provider.exchange!(bound, { state: bound.attemptId, code: "accepted" })
    expect(f.exchangeConfidential).toHaveBeenCalledWith({
      providerId: FEISHU_PROVIDER_ID,
      issuer: bound.issuer,
      clientId: "app-one",
      placement: "json",
      tokenUrl: `https://open.${domain}/open-apis/authen/v2/oauth/token`,
      params: {
        grant_type: "authorization_code",
        code: "accepted",
        code_verifier: "verifier",
        redirect_uri: attempt.redirectUri,
      },
    })
    expect(await f.provider.describe(tokens)).toMatchObject({
      issuer: bound.issuer,
      clientId: "app-one",
      tenantId: "tenant-one",
      principal: { id: "ou_one", kind: "user" },
    })
    expect(f.provider.management).toBe("host")
    expect(f.provider).not.toHaveProperty("getSessions")
    expect(f.provider).not.toHaveProperty("createSession")
    expect(f.provider).not.toHaveProperty("removeSession")
    expect(JSON.stringify(f.exchangeConfidential.mock.calls)).not.toMatch(
      /client_secret|app_secret|clientSecret/
    )
  }
)

it("rotates user credentials through the gateway and rejects invalid_grant", async () => {
  const f = fixture()
  const initial = await f.provider.exchange!(attempt, { state: "host-state", code: "code" })
  f.exchangeConfidential.mockResolvedValueOnce({
    status: 200,
    body: { ...TOKEN, access_token: "user-two", refresh_token: "refresh-two" },
  })
  const updated = await f.provider.refresh(lineage(initial))
  expect(updated.refreshToken).toBe("refresh-two")
  expect(f.exchangeConfidential.mock.calls[1][0]).toMatchObject({
    params: { grant_type: "refresh_token", refresh_token: "refresh-one" },
  })
  f.exchangeConfidential.mockResolvedValueOnce({
    status: 400,
    body: { error: "invalid_grant", error_description: "private-value" },
  })
  await expect(f.provider.refresh(lineage(updated))).rejects.toBeInstanceOf(AuthRefreshRejected)
  await expect(
    f.provider.refresh(lineage({ ...updated, refreshToken: undefined }))
  ).rejects.toBeInstanceOf(AuthRefreshRejected)
})

it.each(["feishu.cn", "larksuite.com"])(
  "connects and re-exchanges a bot and obtains the tenant identity at %s",
  async (domain) => {
    const f = fixture()
    f.exchangeConfidential.mockResolvedValue({
      status: 200,
      body: { code: 0, msg: "ok", tenant_access_token: "tenant-token", expire: 7200 },
    })
    f.get.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        code: 0,
        msg: "ok",
        data: {
          tenant: {
            name: "Company",
            display_id: "display",
            tenant_tag: 1,
            tenant_key: "tenant-key",
            avatar: {},
            domain: "example",
          },
        },
      },
    })
    const tokens = await f.provider.exchange!(
      {
        ...attempt,
        issuer: `https://accounts.${domain}`,
        method: "client-credentials",
        scopes: [],
      },
      { state: "host-state" }
    )
    expect(f.exchangeConfidential.mock.calls[0][0]).toMatchObject({
      tokenUrl: `https://open.${domain}/open-apis/auth/v3/tenant_access_token/internal`,
      params: {},
    })
    expect(await f.provider.describe(tokens)).toEqual({
      issuer: `https://accounts.${domain}`,
      clientId: "app-one",
      tenantId: "tenant-key",
      tenantLabel: "Company",
      accountLabel: "Company",
      principal: { id: "app-one", kind: "bot" },
      scopes: [],
    })
    expect(f.get).toHaveBeenCalledWith(`https://open.${domain}/open-apis/tenant/v2/tenant/query`, {
      headers: { Authorization: "Bearer tenant-token" },
    })
    await f.provider.refresh(lineage(tokens, "bot"))
    expect(f.exchangeConfidential).toHaveBeenCalledTimes(2)
  }
)

it.each([
  [403, 1184001],
  [404, 1184000],
  [200, 1184001],
  [200, 1184000],
])("fails bot tenant discovery clearly for HTTP %s / code %s", async (status, code) => {
  const f = fixture()
  f.get.mockResolvedValue({
    ok: status === 200,
    status,
    data: { code, msg: "private-provider-message" },
  })
  await expect(
    f.provider.describe({
      accessToken: "bot",
      scopes: [],
      extra: { clientId: "app", issuer: attempt.issuer, principalKind: "bot" },
    })
  ).rejects.toMatchObject({
    code: "AUTH_TENANT_SCOPE_REQUIRED",
    message: expect.not.stringContaining("private-provider-message"),
  })
})

it("keeps a tenant permission failure actionable even without a JSON response", async () => {
  const f = fixture()
  f.get.mockResolvedValue({ ok: false, status: 403, data: null })
  await expect(
    f.provider.describe({
      accessToken: "bot",
      scopes: [],
      extra: { clientId: "app", issuer: attempt.issuer, principalKind: "bot" },
    })
  ).rejects.toMatchObject({ code: "AUTH_TENANT_SCOPE_REQUIRED" })
})

it("rejects missing tenant identity and missing grants, and sanitizes vendor errors", async () => {
  const f = fixture()
  f.get.mockResolvedValue({
    ok: true,
    status: 200,
    data: { code: 0, data: { open_id: "ou", name: "Person" } },
  })
  const tokens = await f.provider.exchange!(attempt, { state: "host-state", code: "code" })
  await expect(f.provider.describe(tokens)).rejects.toMatchObject({
    reason: "identity-unavailable",
  })
  f.exchangeConfidential.mockResolvedValueOnce({
    status: 200,
    body: { ...TOKEN, scope: "offline_access" },
  })
  await expect(
    f.provider.exchange!(attempt, { state: "host-state", code: "code" })
  ).rejects.toMatchObject({ reason: "missing-granted-scopes" })
  f.exchangeConfidential.mockResolvedValueOnce({
    status: 200,
    body: { code: 20001, msg: "secret" },
  })
  await expect(
    f.provider.exchange!(attempt, { state: "host-state", code: "code" })
  ).rejects.toMatchObject({
    reason: "token-rejected",
    message: expect.not.stringContaining("secret"),
  })
})
