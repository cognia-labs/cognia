jest.mock("@/lib/i18n/runtime-translator", () => ({
  currentLocale: jest.fn(async () => "en"),
}))
jest.mock("@/lib/execution/acting-authority", () => ({
  ...jest.requireActual("@/lib/execution/acting-authority"),
  observeTenantServiceData: jest.fn(),
  resolveRunActingIdentity: (sessionId: string) => mockRunIdentity(sessionId),
  snapshotActingAuthority: async () => undefined,
  observeActingAuthority: async () => undefined,
}))
import { observeTenantServiceData } from "@/lib/execution/acting-authority"
/**
 * Tests for lib/auth-providers/feishu/cli/auth-bridge.ts.
 *
 * Mocks the external deps (Dexie adapter row fetch, keyring read, tenant
 * token fetch, the Host connection) and the personal admission entry points,
 * whose rules `acting-identity.test.ts` and the kernel's
 * `personal-credential.test.ts` pin. These tests cover what the bridge
 * decides itself: the account, the default identity per run lane, which
 * admission it asks, and the Host connection fence around the admitted token.
 */

import { createHash } from "node:crypto"
import { resolveLarkAuth } from "./auth-bridge"
import {
  admitLarkUserAuthorization,
  assertLarkActingIdentity,
  LarkActingIdentityError,
} from "./acting-identity"
import { LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { getAdapterInstance, listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken } from "@/lib/auth-providers/feishu/auth"
import { resolveBuiltInSkillSessionBinding } from "@/lib/skills/built-in/context"
import { resolveLarkConnection } from "@/lib/auth-providers/feishu/host-auth"
import { getConnectionManager } from "@/lib/plugin/auth/connection-manager"
jest.mock("@/lib/auth-providers/feishu/host-auth", () => ({
  resolveLarkConnection: jest.fn(),
  larkActingPerson: jest.fn(),
}))
jest.mock("@/lib/plugin/auth/connection-manager", () => ({ getConnectionManager: jest.fn() }))
jest.mock("./acting-identity", () => ({
  ...jest.requireActual("./acting-identity"),
  assertLarkActingIdentity: jest.fn(),
  admitLarkUserAuthorization: jest.fn(),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  listAdapterInstancesByType: jest.fn(),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(),
  connectorsLarkUserAuth: jest.fn(),
}))
// The lane needs the executing run's recorded identity (ADR-0243 phase 2-0).
const mockRunIdentity = jest.fn<Promise<unknown>, [string]>()
jest.mock("@/lib/skills/built-in/context", () => ({
  ...jest.requireActual("@/lib/skills/built-in/context"),
  resolveBuiltInSkillSessionBinding: jest.fn(),
}))
jest.mock("@/lib/auth-providers/feishu/auth", () => {
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
const mockAssert = jest.mocked(assertLarkActingIdentity)
const mockAdmit = jest.mocked(admitLarkUserAuthorization)
const mockGetCredentials = jest.fn()
const localContext = { sessionId: "desktop" }
const OWNER_KEY = createHash("sha256").update("ou_owner").digest("hex")
const BOB_KEY = createHash("sha256").update("ou_bob").digest("hex")
const bob = { kind: "platform", platform: "lark", adapterId: "lark-1", remoteUserId: "ou_bob" }
/** The token the Host connection holds for the admitted person; undefined = none. */
let personalToken: string | undefined

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

function appCredentials(appId = "app", appSecret = "secret") {
  mockKeyring.mockImplementation(async (_id: string, key: string) =>
    key === "appId" ? appId : key === "appSecret" ? appSecret : undefined
  )
}

beforeEach(() => {
  personalToken = "personal-token"
  mockRunIdentity
    .mockReset()
    .mockImplementation(async (sessionId) =>
      sessionId === "desktop" || sessionId === "local"
        ? { requesters: [], trigger: "local", authorizingPrincipal: { kind: "local-person" } }
        : { trigger: "requester", requesters: [] }
    )
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
  const admitted = async () =>
    personalToken
      ? { principal: OWNER_KEY, accessToken: personalToken, authorizationEpoch: "epoch-a" }
      : undefined
  mockAssert.mockReset().mockImplementation(admitted)
  mockAdmit.mockReset().mockImplementation(admitted)
  mockGetAdapter.mockReset()
  mockListByType.mockReset()
  mockKeyring.mockReset()
  mockTenantToken.mockReset()
  jest
    .mocked(resolveLarkConnection)
    .mockReset()
    .mockResolvedValue({
      id: "host-ref",
      revision: 1,
      hostMetadata: { authorizationEpoch: "epoch-a" },
    } as never)
  mockGetCredentials.mockReset().mockImplementation(async () => ({ accessToken: personalToken }))
  jest.mocked(getConnectionManager).mockReturnValue({ getCredentials: mockGetCredentials } as never)
})

describe("resolveLarkAuth", () => {
  it.each([
    ["plugin", "external-event"],
    ["webhook", "external-event"],
    ["schedule", "schedule"],
    ["legacy requester", "requester"],
  ] as const)("selects service data for an unbound %s run", async (source, trigger) => {
    jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
      rootSessionId: source,
      binding: undefined,
      personalLane: "local-session",
    } as never)
    mockRunIdentity.mockResolvedValue({ trigger, requesters: [] })
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials()
    mockTenantToken.mockResolvedValue("tenant-token")
    const context = { sessionId: source }

    await expect(resolveLarkAuth({ context })).resolves.toMatchObject({
      ok: true,
      identity: "bot",
      lane: "service",
      env: {
        LARKSUITE_CLI_USER_ACCESS_TOKEN: "",
        LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "tenant-token",
      },
    })
    expect(mockRunIdentity).toHaveBeenCalledWith(source)
    expect(mockTenantToken).toHaveBeenCalledWith(
      { appId: "app", appSecret: "secret" },
      "service-data"
    )
    expect(mockAssert).not.toHaveBeenCalled()
    // An explicit user request still goes through the personal admission.
    mockAssert.mockRejectedValueOnce(new LarkActingIdentityError())
    await expect(resolveLarkAuth({ context, identity: "user" })).resolves.toMatchObject({
      ok: false,
      reason: "personal_access_refused",
      adapterId: "lark-1",
      message: expect.stringMatching(/principal registry/i),
    })
    expect(mockAssert).toHaveBeenCalledWith("lark-1", context)
    expect(resolveLarkConnection).not.toHaveBeenCalled()
    expect(mockGetCredentials).not.toHaveBeenCalled()
  })

  it("keeps a bound IM requester outside the delegated lane on the service lane", async () => {
    const binding = { platform: "lark" as const, adapterId: "lark-1", conversationKey: "chat" }
    jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
      rootSessionId: "im",
      session: {},
      rootSession: {},
      binding,
    } as never)
    mockRunIdentity.mockResolvedValue({ trigger: "requester", lane: "legacy", requesters: [bob] })
    mockGetAdapter.mockResolvedValue(mkAdapter())
    appCredentials()
    mockTenantToken.mockResolvedValue("tenant-token")
    await expect(
      resolveLarkAuth({ context: { sessionId: "im", imBinding: binding } })
    ).resolves.toMatchObject({ ok: true, identity: "bot", lane: "service" })
    expect(mockAssert).not.toHaveBeenCalled()
    expect(mockGetCredentials).not.toHaveBeenCalled()
  })

  it("uses a delegated run's acting person's own authorization by default", async () => {
    const binding = { platform: "lark" as const, adapterId: "lark-1", conversationKey: "chat" }
    jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
      rootSessionId: "im",
      session: {},
      rootSession: {},
      binding,
    } as never)
    mockRunIdentity.mockResolvedValue({
      trigger: "requester",
      lane: "delegated",
      actingPrincipal: bob,
      requesters: [bob],
    })
    mockGetAdapter.mockResolvedValue(mkAdapter())
    appCredentials()
    mockAssert.mockResolvedValueOnce({
      principal: BOB_KEY,
      accessToken: "bob-snapshot",
      authorizationEpoch: "epoch-bob",
    })
    jest.mocked(resolveLarkConnection).mockResolvedValueOnce({
      id: "bob-ref",
      revision: 4,
      hostMetadata: { authorizationEpoch: "epoch-bob" },
    } as never)
    mockGetCredentials.mockResolvedValueOnce({ accessToken: "bob-token" })
    const context = { sessionId: "im", executionRunId: "run-1", imBinding: binding }
    await expect(resolveLarkAuth({ context })).resolves.toMatchObject({
      ok: true,
      identity: "user",
      env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: "bob-token", LARKSUITE_CLI_DEFAULT_AS: "user" },
      connection: { ref: "bob-ref", revision: 4 },
    })
    const credentialContext = { sessionId: "im", executionRunId: "run-1" }
    expect(mockAssert).toHaveBeenCalledWith("lark-1", context)
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(resolveLarkConnection).toHaveBeenCalledWith("lark-1", BOB_KEY, credentialContext)
    expect(mockGetCredentials).toHaveBeenCalledWith("bob-ref", { credentialContext })
    expect(mockTenantToken).not.toHaveBeenCalled()
    expect(mockKeyring).not.toHaveBeenCalledWith("lark-1", expect.stringMatching(/^user_/))
  })

  it("keeps the unbound local desktop run on its personal identity", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials()
    await expect(resolveLarkAuth({ context: localContext })).resolves.toMatchObject({
      ok: true,
      identity: "user",
      env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: "personal-token" },
    })
    expect(mockTenantToken).not.toHaveBeenCalled()
    expect(resolveLarkConnection).toHaveBeenCalledWith("lark-1", OWNER_KEY, {
      sessionId: "desktop",
    })
  })

  it.each([
    ["a delegated requester", { trigger: "requester", lane: "delegated", actingPrincipal: bob }],
    ["an external event", { trigger: "external-event" }],
  ])("authenticates a deleted-child confirmation of %s through its root", async (_, identity) => {
    const binding = { platform: "lark" as const, adapterId: "lark-1", conversationKey: "chat" }
    jest
      .mocked(resolveBuiltInSkillSessionBinding)
      .mockImplementation(
        async (id) => ({ rootSessionId: id, binding: id === "root" ? binding : undefined }) as never
      )
    mockRunIdentity.mockResolvedValue({ ...identity, requesters: [] })
    mockGetAdapter.mockResolvedValue(mkAdapter())
    appCredentials()
    mockTenantToken.mockResolvedValue("tenant")
    const delegated = identity.trigger === "requester"
    const context = {
      sessionId: "gone-child",
      imAuthoritySessionId: "root",
      executionRunId: "replay",
      imBinding: binding,
      hitlBypass: true,
    }
    await expect(resolveLarkAuth({ context })).resolves.toMatchObject({
      ok: true,
      identity: delegated ? "user" : "bot",
    })
    expect(resolveBuiltInSkillSessionBinding).toHaveBeenCalledWith("root")
    expect(mockGetAdapter).toHaveBeenCalledWith("lark-1")
    expect(mockAssert).toHaveBeenCalledTimes(delegated ? 1 : 0)
    if (delegated) expect(mockAssert).toHaveBeenCalledWith("lark-1", context)
  })

  it("returns the personal refusal for a local session whose executing run is not a local person's", async () => {
    mockRunIdentity.mockResolvedValue({ trigger: "external-event" })
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials()
    mockAssert.mockRejectedValueOnce(new LarkActingIdentityError())
    await expect(
      resolveLarkAuth({ context: localContext, identity: "user" })
    ).resolves.toMatchObject({ ok: false, reason: "personal_access_refused" })
    expect(resolveLarkConnection).not.toHaveBeenCalled()
  })

  it("propagates an admission failure that is not a personal refusal", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials()
    mockAssert.mockRejectedValueOnce(new Error("host unavailable"))
    await expect(resolveLarkAuth({ context: localContext })).rejects.toThrow("host unavailable")
  })

  it("admits a call without a skill context through its credential context", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter())
    appCredentials()
    mockAdmit.mockRejectedValueOnce(new LarkActingIdentityError())
    await expect(resolveLarkAuth({ adapterId: "lark-1" })).resolves.toMatchObject({
      ok: false,
      reason: "personal_access_refused",
    })
    expect(mockAdmit).toHaveBeenCalledWith("lark-1", undefined)
    expect(mockAssert).not.toHaveBeenCalled()
    expect(resolveLarkConnection).not.toHaveBeenCalled()

    const credentialContext = { localAuthorization: LOCAL_PERSON_RUN } as const
    await expect(
      resolveLarkAuth({ adapterId: "lark-1", credentialContext })
    ).resolves.toMatchObject({
      ok: true,
      identity: "user",
      env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: "personal-token" },
    })
    expect(mockAdmit).toHaveBeenLastCalledWith("lark-1", credentialContext)
    expect(resolveLarkConnection).toHaveBeenCalledWith("lark-1", OWNER_KEY, credentialContext)
    expect(mockGetCredentials).toHaveBeenCalledWith("host-ref", { credentialContext })
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
    appCredentials("cli_school", "school-secret")
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
      expect(mockAssert).not.toHaveBeenCalled()
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
    appCredentials("cli_school", "secret")
    personalToken = "user-token"
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
    appCredentials("cli_school", "secret")
    await expect(
      resolveLarkAuth({ context: { sessionId: "local", larkAdapterId: "school" } })
    ).resolves.toMatchObject({ ok: true, adapterId: "school" })
    expect(mockGetAdapter).toHaveBeenCalledWith("school")
    expect(mockAssert).toHaveBeenCalledWith("school", {
      sessionId: "local",
      larkAdapterId: "school",
    })
    mockGetAdapter.mockResolvedValue(undefined)
    await expect(resolveLarkAuth({ adapterId: "missing" })).resolves.toMatchObject({
      ok: false,
      reason: "no_adapter",
    })
    expect(mockListByType).not.toHaveBeenCalled()
  })

  it("pins bot identity and clears any inherited personal token", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter())
    appCredentials("cli_school", "secret")
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
    expect(mockAdmit).not.toHaveBeenCalled()
    expect(mockGetCredentials).not.toHaveBeenCalled()
  })

  it("refuses when the person's Host connection was republished after admission", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials()
    jest.mocked(resolveLarkConnection).mockResolvedValueOnce({
      id: "host-ref",
      revision: 2,
      hostMetadata: { authorizationEpoch: "epoch-b" },
    } as never)
    await expect(resolveLarkAuth({ context: localContext })).resolves.toMatchObject({
      ok: false,
      reason: "user_not_authorized",
      message: expect.stringContaining("reconnect"),
    })
    expect(mockGetCredentials).not.toHaveBeenCalled()
    expect(mockTenantToken).not.toHaveBeenCalled()

    jest.mocked(resolveLarkConnection).mockRejectedValueOnce(new Error("no connection"))
    await expect(resolveLarkAuth({ context: localContext })).resolves.toMatchObject({
      ok: false,
      reason: "user_not_authorized",
    })
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
    appCredentials("  cli_from_keyring  ", "secret-x")
    const r = await resolveLarkAuth({ context: localContext })
    expect(mockKeyring).toHaveBeenCalledWith("lark-1", "appId")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.env.LARKSUITE_CLI_APP_ID).toBe("cli_from_keyring")
  })

  it("falls back to settings.appId on rows written by an older form", async () => {
    mockListByType.mockResolvedValue([mkAdapter({ settings: { appId: "cli_legacy" } })])
    mockKeyring.mockImplementation(async (_id: string, key: string) =>
      key === "appSecret" ? "secret-x" : undefined
    )
    const r = await resolveLarkAuth({ context: localContext })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.env.LARKSUITE_CLI_APP_ID).toBe("cli_legacy")
  })

  it("prefers the keyring appId over a stale settings.appId", async () => {
    mockListByType.mockResolvedValue([mkAdapter({ settings: { appId: "cli_stale" } })])
    appCredentials("cli_current", "secret-x")
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

  it("returns user identity env when the admitted person has a token", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials("cli_test_app", "secret-x")
    personalToken = "uat-aaa"
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

  it("fails with user_not_authorized when the admitted person has no authorization", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials("cli_test_app", "secret-x")
    personalToken = undefined
    const r = await resolveLarkAuth({ identity: "user", context: localContext })
    expect(r).toMatchObject({
      ok: false,
      reason: "user_not_authorized",
      message: expect.stringContaining("connect Lark user OAuth"),
    })
    expect(resolveLarkConnection).not.toHaveBeenCalled()
    expect(mockTenantToken).not.toHaveBeenCalled()
  })

  it("identity='bot' explicit override skips personal admission", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials("cli_test_app", "secret-x")
    mockTenantToken.mockResolvedValue("tat-bbb")
    const r = await resolveLarkAuth({ identity: "bot" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.identity).toBe("bot")
      expect(r.env.LARKSUITE_CLI_USER_ACCESS_TOKEN).toBe("")
      expect(r.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("tat-bbb")
    }
    expect(mockAdmit).not.toHaveBeenCalled()
  })

  it("tenant_token_failed surfaces upstream error", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    appCredentials("cli_test_app", "secret-x")
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
    appCredentials("cli_test_app", "secret-x")
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
  appCredentials("cli_app", "secret")
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
  expect(observeTenantServiceData).toHaveBeenCalledWith("im-session", "lark-1", "lark-cli", {
    authoritySessionId: "s1",
  })
})

it("selects the external-event service lane without personal admission, and refuses explicit user identity", async () => {
  mockRunIdentity.mockResolvedValue({ trigger: "external-event" })
  mockGetAdapter.mockResolvedValue(mkAdapter())
  appCredentials()
  mockTenantToken.mockResolvedValue("tenant-token")
  const context = { sessionId: "bot-topic" }
  await expect(resolveLarkAuth({ context })).resolves.toMatchObject({
    ok: true,
    identity: "bot",
    lane: "service",
    env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: "", LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "tenant-token" },
  })
  expect(mockAssert).not.toHaveBeenCalled()
  expect(mockGetCredentials).not.toHaveBeenCalled()
  expect(mockTenantToken).toHaveBeenCalledWith(
    { appId: "app", appSecret: "secret" },
    "service-data"
  )
  mockAssert.mockRejectedValueOnce(new LarkActingIdentityError())
  await expect(resolveLarkAuth({ context, identity: "user" })).resolves.toMatchObject({
    ok: false,
    reason: "personal_access_refused",
    message: expect.stringMatching(/principal registry/i),
  })
})

it("returns the personal refusal from a user-only Bot skill before touching any personal credential", async () => {
  mockRunIdentity.mockResolvedValue({ trigger: "external-event" })
  mockGetAdapter.mockResolvedValue(mkAdapter())
  appCredentials()
  mockAssert.mockRejectedValueOnce(new LarkActingIdentityError())
  const { execLarkCli } = await import("./exec-lark-cli")
  await expect(
    execLarkCli({
      args: ["docs", "+search", "--query", "review"],
      context: { sessionId: "bot-topic" },
    })
  ).resolves.toMatchObject({
    status: "error",
    reason: "auth_unavailable",
    message: expect.stringContaining("principal registry"),
  })
  expect(mockAssert).toHaveBeenCalledWith("lark-1", { sessionId: "bot-topic" })
  expect(mockTenantToken).not.toHaveBeenCalled()
  expect(resolveLarkConnection).not.toHaveBeenCalled()
  expect(mockGetCredentials).not.toHaveBeenCalled()
})
