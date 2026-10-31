jest.mock("@/lib/execution/acting-authority", () => ({
  ...jest.requireActual("@/lib/execution/acting-authority"),
  observeTenantServiceData: jest.fn(),
}))
import { observeTenantServiceData } from "@/lib/execution/acting-authority"
/**
 * Tests for lib/skills/built-in/lark/auth-bridge.ts.
 *
 * Mocks the three external deps (Dexie adapter row fetch, keyring read,
 * tenant token fetch) so the bridge can be exercised in isolation
 * without a real Lark adapter configured.
 */

import { resolveLarkAuth } from "./auth-bridge"
import { getAdapterInstance, listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet, connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken } from "@/lib/connectors/adapters/lark/auth"
import { resolveBuiltInSkillSessionBinding } from "../context"

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  listAdapterInstancesByType: jest.fn(),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(),
  connectorsLarkUserAuth: jest.fn(),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions: {
      get: async () => ({
        platformBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "chat" },
      }),
    },
  }),
}))
jest.mock("../context", () => ({
  ...jest.requireActual("../context"),
  resolveBuiltInSkillSessionBinding: jest.fn(),
  resolveBuiltInSkillTurnActors: async () => ({ actingSenders: [{ remoteUserId: "alice" }] }),
}))
jest.mock("@/lib/connectors/adapters/lark/auth", () => {
  const getTenantAccessToken = jest.fn()
  return {
    getTenantAccessToken,
    getTenantToken: getTenantAccessToken,
  }
})

const mockGetAdapter = getAdapterInstance as jest.Mock
const mockListByType = listAdapterInstancesByType as jest.Mock
const mockKeyring = connectorsKeyringGet as jest.Mock
const mockTenantToken = getTenantAccessToken as jest.Mock
const localContext = { sessionId: "desktop" }

function mkAdapter(overrides: Record<string, unknown> = {}) {
  return {
    id: "lark-1",
    type: "lark",
    displayName: "My Lark",
    enabled: true,
    transportMode: "webhook",
    // The settings form and OAuth handler keep appId in the keyring, not here.
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  jest
    .mocked(resolveBuiltInSkillSessionBinding)
    .mockReset()
    .mockImplementation(async (sessionId) =>
      sessionId === localContext.sessionId
        ? ({
            rootSessionId: sessionId,
            session: { id: sessionId },
            binding: undefined,
            personalLane: "local-session",
          } as never)
        : ({
            rootSessionId: "s1",
            session: {},
            rootSession: {},
            binding: { platform: "lark", adapterId: "lark-1", conversationKey: "chat" },
          } as never)
    )
  jest.mocked(connectorsLarkUserAuth).mockReset()
  mockGetAdapter.mockReset()
  mockListByType.mockReset()
  mockKeyring.mockReset()
  mockTenantToken.mockReset()
})

describe("resolveLarkAuth", () => {
  it("refuses the personal lane without a session before reading the owner's token", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter())
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "user_token" ? "owner-token" : "app-credential"
    )
    await expect(resolveLarkAuth({ adapterId: "lark-1" })).resolves.toMatchObject({
      ok: false,
      reason: "sender_not_token_owner",
    })
    expect(mockKeyring).not.toHaveBeenCalledWith("lark-1", "user_token")
    expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
  })

  it("refuses ambiguous enabled accounts without touching any credentials", async () => {
    mockListByType.mockResolvedValue([mkAdapter(), mkAdapter({ id: "school" })])
    await expect(resolveLarkAuth()).resolves.toMatchObject({
      ok: false,
      reason: "ambiguous_adapter",
    })
    expect(mockKeyring).not.toHaveBeenCalled()
  })

  it("uses the authoritative IM account instead of the first enabled account", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter())
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appId" ? "cli_school" : "school-secret"
    )
    mockTenantToken.mockResolvedValue("school-tenant-token")
    await expect(
      resolveLarkAuth({ context: { sessionId: "s1" }, identity: "bot" })
    ).resolves.toMatchObject({ ok: true, adapterId: "lark-1" })
    expect(mockGetAdapter).toHaveBeenCalledWith("lark-1")
    expect(mockListByType).not.toHaveBeenCalled()
  })

  it.each(["user", "bot"] as const)(
    "refuses an explicit account conflicting with the IM binding for %s",
    async (identity) => {
      await expect(
        resolveLarkAuth({ adapterId: "other", context: { sessionId: "s1" }, identity })
      ).resolves.toMatchObject({ ok: false, reason: "adapter_mismatch" })
      expect(mockKeyring).not.toHaveBeenCalled()
      expect(mockTenantToken).not.toHaveBeenCalled()
    }
  )

  it("refuses a Lark action from another platform without reading credentials", async () => {
    jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
      rootSessionId: "s1",
      session: {},
      rootSession: {},
      binding: { platform: "slack", adapterId: "slack-1", conversationKey: "chat" },
    } as never)
    await expect(
      resolveLarkAuth({ context: { sessionId: "s1" }, identity: "bot" })
    ).resolves.toMatchObject({ ok: false, reason: "adapter_mismatch" })
    expect(mockKeyring).not.toHaveBeenCalled()
  })

  it("rejects a non-Lark adapter explicitly selected by id", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter({ type: "slack" }))
    await expect(resolveLarkAuth({ adapterId: "lark-1" })).resolves.toMatchObject({
      ok: false,
      reason: "invalid_adapter",
    })
    expect(mockKeyring).not.toHaveBeenCalled()
  })

  it("fails closed when the session lineage cannot be resolved", async () => {
    jest.mocked(resolveBuiltInSkillSessionBinding).mockRejectedValue(new Error("missing parent"))
    await expect(resolveLarkAuth({ context: { sessionId: "child" } })).resolves.toMatchObject({
      ok: false,
      reason: "adapter_mismatch",
    })
    expect(mockKeyring).not.toHaveBeenCalled()
  })

  it("pins user credentials and clears inherited CLI account selectors", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter())
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appId" ? "cli_school" : key === "appSecret" ? "secret" : "user-token"
    )
    const r = await resolveLarkAuth({ adapterId: "lark-1", context: localContext })
    expect(r).toMatchObject({
      ok: true,
      env: {
        LARKSUITE_CLI_APP_ID: "cli_school",
        LARKSUITE_CLI_APP_SECRET: "secret",
        LARKSUITE_CLI_USER_ACCESS_TOKEN: "user-token",
        LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "",
        LARKSUITE_CLI_DEFAULT_AS: "user",
        LARKSUITE_CLI_STRICT_MODE: "user",
        LARKSUITE_CLI_BRAND: "feishu",
        LARKSUITE_CLI_PROFILE: "",
        LARKSUITE_CLI_AUTH_PROXY: "",
        LARKSUITE_CLI_PROXY_KEY: "",
        LARKSUITE_CLI_TENANT_ACCESS_TOKEN_SOURCE: "",
        LARKSUITE_CLI_CONFIG_DIR: "",
      },
    })
  })

  it("uses a local tool's selected connection and never falls back on an unknown id", async () => {
    jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
      rootSessionId: "local",
      session: {},
      rootSession: {},
      binding: undefined,
      personalLane: "local-session",
    } as never)
    mockGetAdapter.mockResolvedValue(mkAdapter({ id: "school" }))
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appId" ? "cli_school" : key === "appSecret" ? "secret" : "token"
    )
    await expect(
      resolveLarkAuth({ context: { sessionId: "local", larkAdapterId: "school" } })
    ).resolves.toMatchObject({ ok: true, adapterId: "school" })
    expect(mockGetAdapter).toHaveBeenCalledWith("school")
    mockGetAdapter.mockResolvedValue(undefined)
    await expect(resolveLarkAuth({ adapterId: "missing" })).resolves.toMatchObject({
      ok: false,
      reason: "no_adapter",
    })
    expect(mockListByType).not.toHaveBeenCalled()
  })

  it("pins bot identity and clears any inherited personal token", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter())
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appId" ? "cli_school" : "secret"
    )
    mockTenantToken.mockResolvedValue("tenant-token")
    await expect(resolveLarkAuth({ adapterId: "lark-1", identity: "bot" })).resolves.toMatchObject({
      ok: true,
      env: {
        LARKSUITE_CLI_DEFAULT_AS: "bot",
        LARKSUITE_CLI_STRICT_MODE: "bot",
        LARKSUITE_CLI_USER_ACCESS_TOKEN: "",
        LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "tenant-token",
        LARKSUITE_CLI_AUTH_PROXY: "",
        LARKSUITE_CLI_TENANT_ACCESS_TOKEN_SOURCE: "",
      },
    })
    expect(mockKeyring).not.toHaveBeenCalledWith("lark-1", "user_token")
  })

  it("uses the IM gate's verified token without separately reading user_token", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockGetAdapter.mockResolvedValue(
      mkAdapter({
        settings: {
          connectedUser: { openId: "alice", name: "Alice", authorizationEpoch: "auth-alice" },
        },
      })
    )
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appId" ? "app" : key === "appSecret" ? "secret" : "bob-separate-token"
    )
    jest.mocked(connectorsLarkUserAuth).mockResolvedValueOnce({
      configured: true,
      accessToken: "alice-snapshot-token",
      authorizationEpoch: "auth-alice",
      accountLabel: "Alice",
    } as never)
    const result = await resolveLarkAuth({ context: { sessionId: "s1" } })
    expect(result).toMatchObject({
      ok: true,
      env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: "alice-snapshot-token" },
    })
    expect(mockKeyring).not.toHaveBeenCalledWith("lark-1", "user_token")
    expect(connectorsLarkUserAuth).toHaveBeenCalledTimes(1)
  })

  it("refuses reconnect publication before connectedUser catches up", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockGetAdapter.mockResolvedValue(
      mkAdapter({
        settings: {
          connectedUser: { openId: "alice", name: "Alice", authorizationEpoch: "auth-alice" },
        },
      })
    )
    mockKeyring.mockResolvedValue("app-credential")
    jest.mocked(connectorsLarkUserAuth).mockResolvedValueOnce({
      configured: true,
      accessToken: "bob-token",
      authorizationEpoch: "auth-bob",
      accountLabel: "Bob",
    } as never)
    await expect(resolveLarkAuth({ context: { sessionId: "s1" } })).resolves.toMatchObject({
      ok: false,
      reason: "sender_not_token_owner",
    })
    expect(mockKeyring).not.toHaveBeenCalledWith("lark-1", "user_token")
    expect(mockTenantToken).not.toHaveBeenCalled()
  })
  it("fails closed when adapter lookup fails", async () => {
    mockListByType.mockRejectedValue(new Error("read failed"))
    await expect(resolveLarkAuth()).resolves.toMatchObject({ ok: false, reason: "no_adapter" })
    expect(mockTenantToken).not.toHaveBeenCalled()
    expect(mockKeyring).not.toHaveBeenCalled()
  })
  it("no_adapter when no Lark row exists", async () => {
    mockListByType.mockResolvedValue([])
    const r = await resolveLarkAuth()
    expect(r).toEqual({
      ok: false,
      reason: "no_adapter",
      message: expect.stringContaining("No Lark adapter"),
    })
  })

  it("adapter_disabled when row exists but enabled=false", async () => {
    mockListByType.mockResolvedValue([mkAdapter({ enabled: false })])
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("adapter_disabled")
      if ("adapterId" in r) expect(r.adapterId).toBe("lark-1")
    }
  })

  it("missing_app_id when neither the keyring nor settings hold an appId", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appSecret" ? "secret-x" : undefined
    )
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("missing_app_id")
  })

  it("reads appId from the keyring, where the settings form stores it", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appId") return "  cli_from_keyring  "
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-aaa"
      return undefined
    })
    const r = await resolveLarkAuth({ context: localContext })
    expect(mockKeyring).toHaveBeenCalledWith("lark-1", "appId")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.env.LARKSUITE_CLI_APP_ID).toBe("cli_from_keyring")
  })

  it("falls back to settings.appId on rows written by an older form", async () => {
    mockListByType.mockResolvedValue([mkAdapter({ settings: { appId: "cli_legacy" } })])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-aaa"
      return undefined
    })
    const r = await resolveLarkAuth({ context: localContext })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.env.LARKSUITE_CLI_APP_ID).toBe("cli_legacy")
  })

  it("prefers the keyring appId over a stale settings.appId", async () => {
    mockListByType.mockResolvedValue([mkAdapter({ settings: { appId: "cli_stale" } })])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appId") return "cli_current"
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-aaa"
      return undefined
    })
    const r = await resolveLarkAuth({ context: localContext })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.env.LARKSUITE_CLI_APP_ID).toBe("cli_current")
  })

  it("missing_app_secret when keyring returns undefined", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appId" ? "cli_test_app" : undefined
    )
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("missing_app_secret")
  })

  it("returns user identity env when user_token present", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appId") return "cli_test_app"
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-aaa"
      return undefined
    })
    const r = await resolveLarkAuth({ context: localContext })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.identity).toBe("user")
      expect(r.env).toMatchObject({
        LARKSUITE_CLI_APP_ID: "cli_test_app",
        LARKSUITE_CLI_APP_SECRET: "secret-x",
        LARKSUITE_CLI_USER_ACCESS_TOKEN: "uat-aaa",
      })
    }
  })

  it("fails with user_not_authorized when a preferred user token is absent", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appId" ? "cli_test_app" : key === "appSecret" ? "secret-x" : undefined
    )
    const r = await resolveLarkAuth({ identity: "user", context: localContext })
    expect(r).toMatchObject({ ok: false, reason: "user_not_authorized" })
    expect(mockTenantToken).not.toHaveBeenCalled()
  })

  it("identity='bot' explicit override skips user_token lookup", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appId") return "cli_test_app"
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-aaa"
      return undefined
    })
    mockTenantToken.mockResolvedValue("tat-bbb")
    const r = await resolveLarkAuth({ identity: "bot" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.identity).toBe("bot")
      expect(r.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("")
      expect(r.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("tat-bbb")
    }
  })

  it("tenant_token_failed surfaces upstream error", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appId") return "cli_test_app"
      if (key === "appSecret") return "secret-x"
      return undefined
    })
    mockTenantToken.mockRejectedValue(new Error("invalid app_secret"))
    const r = await resolveLarkAuth({ identity: "bot" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("tenant_token_failed")
      expect(r.message).toContain("invalid app_secret")
    }
  })

  it("explicit adapterId routes to getAdapterInstance instead of listByType", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter({ id: "lark-2" }))
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appId") return "cli_test_app"
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-z"
      return undefined
    })
    const r = await resolveLarkAuth({ adapterId: "lark-2", context: localContext })
    expect(mockGetAdapter).toHaveBeenCalledWith("lark-2")
    expect(mockListByType).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.adapterId).toBe("lark-2")
  })

  it("keyring throw is treated as missing credential (graceful)", async () => {
    mockListByType.mockResolvedValue([mkAdapter({ settings: { appId: "cli_legacy" } })])
    mockKeyring.mockRejectedValue(new Error("keyring locked"))
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("missing_app_secret")
  })
})

it("labels explicit CLI bot credentials as service data and forwards existing session context", async () => {
  mockListByType.mockResolvedValue([mkAdapter()])
  mockKeyring.mockImplementation(async (_id: string, key: string) =>
    key === "appId" ? "cli_app" : "secret"
  )
  mockGetAdapter.mockResolvedValue(mkAdapter())
  mockTenantToken.mockResolvedValue("tat-labelled")
  await expect(
    resolveLarkAuth({ identity: "bot", context: { sessionId: "im-session" } })
  ).resolves.toMatchObject({
    ok: true,
    identity: "bot",
    env: { LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "tat-labelled" },
  })
  expect(mockTenantToken).toHaveBeenCalledWith(
    { appId: "cli_app", appSecret: "secret" },
    "service-data"
  )
  expect(observeTenantServiceData).toHaveBeenCalledWith("im-session", "lark-1", "lark-cli")
})
