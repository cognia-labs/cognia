/** @jest-environment jsdom */
/** ES-33 code-level evidence. Native stores, vendor transport and process startup
 * are boundary doubles; the Host enforcement, routers and persistence adapters are real. */
import { createElement } from "react"
import { render, waitFor, cleanup } from "@testing-library/react"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getPlugin } from "@/lib/db/plugins"
import { detectPlatform, isHeadlessHost } from "@/lib/platform/detect"
import { isTauri, isCapacitor, transport } from "@/lib/tauri"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { openExternal } from "@/lib/tauri/opener"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { makeDefaultLoader } from "@/lib/capacitor/_shared"
import { createCliAuthSecretStore } from "@/cli/src/plugin/auth-secret-store"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { withNamedLock } from "@/lib/locks/named-lock"
import {
  registerAuthenticationProvider,
  __resetAuthRegistryForTesting,
  type AuthenticationProvider,
} from "@/lib/plugin/auth/auth-provider-registry"
import { connectProvider, AuthConnectError } from "@/lib/plugin/auth/connect"
import {
  ConnectionCredentialStore,
  HostAuthSecrets,
  setHostAuthBackend,
  CredentialStoreDegraded,
} from "@/lib/plugin/auth/connection-credentials"
import { setProviderClientSecret } from "@/lib/plugin/auth/client-secrets"
import { createAuthAPI } from "@/lib/plugin/api/auth-api"
import { createAttempt } from "@/lib/plugin/auth/auth-attempts"
import {
  registerAuthCallbackWaiter,
  routeHostAuthCallback,
  acceptCallback,
} from "@/lib/plugin/auth/callback-acceptor"
import { routePluginDeepLink } from "@/lib/plugin/uri/route-deep-link"
import { parseCogniaDeeplink } from "@/lib/navigation/cognia-deeplink"
import { dispatchRoute } from "@/lib/capacitor/deeplink-router"
import { createPluginContext } from "@/lib/plugin/core/context"
import { preloadModulePluginApis } from "@/lib/plugin/core/module-plugin-api"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { invokePluginApi, PluginGatewayError } from "@/lib/plugin/core/transport"
import { IntegrationRuntimeInitializer } from "@/components/providers/initializers/integration-runtime-initializer"
import { startIntegrationRuntime } from "@/lib/integrations/runtime"
import {
  EXTERNAL_SERVICE_RUNTIME_SUPPORT,
  resolveRuntimeSupport,
  type Facet,
  type RuntimeSupportCell,
} from "./runtime-support"
import { currentExternalServiceRuntimeContext } from "./runtime-profile"
import type { AuthMethod } from "@cognia/plugin-contract/types/plugin/plugin-auth"
import type { Plugin, PluginRuntimeProfile } from "@/types/plugin"
import type { PluginManager } from "@/lib/plugin/core/manager"

jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: jest.fn(),
  isHeadlessHost: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(),
  isCapacitor: jest.fn(),
  transport: { call: jest.fn() },
}))
jest.mock("@/lib/native/utils", () => ({
  ...jest.requireActual("@/lib/native/utils"),
  isTauri: () => jest.requireMock("@/lib/tauri").isTauri(),
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  ...jest.requireActual("@/lib/tauri/transport-routing"),
  isRemoteHostActive: jest.fn(() => false),
}))
jest.mock("@/lib/plugin/core/mirrored-client", () => ({ isMirroredPluginClient: () => false }))
jest.mock("@/lib/plugin/core/transport", () => ({
  ...jest.requireActual("@/lib/plugin/core/transport"),
  invokePluginApi: jest.fn(),
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))
jest.mock("@/lib/db/plugins", () => ({
  ...jest.requireActual("@/lib/db/plugins"),
  getPlugin: jest.fn(),
}))
jest.mock("@/lib/runtime/browser-vault", () => ({
  ...jest.requireActual("@/lib/runtime/browser-vault"),
  getActiveBrowserVault: jest.fn(() => null),
}))
jest.mock("@/lib/capacitor/_shared", () => ({
  ...jest.requireActual("@/lib/capacitor/_shared"),
  makeDefaultLoader: jest.fn(),
}))
jest.mock("@/lib/integrations/runtime", () => ({
  startIntegrationRuntime: jest.fn(async () => jest.fn()),
}))
jest.mock("@/lib/integrations/runtime-owner", () => ({
  isIntegrationRuntimeOwner: async () => true,
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: object) => unknown) =>
    selector({ unlockedAccountId: "evidence", accountRevision: 0 }),
}))

const fixture = createDbTestFixture()
const lock: typeof import("@/lib/plugin/auth/connection-credentials").withAuthLock = (name, task) =>
  withNamedLock(name, task, { mode: "in-process" })
let provider: AuthenticationProvider
let durable: Map<string, string>
let home: string
beforeAll(fixture.initialize)
beforeEach(async () => {
  await fixture.restore()
  jest.clearAllMocks()
  __resetAuthRegistryForTesting()
  home = mkdtempSync(join(tmpdir(), "cognia-p9a-"))
  durable = new Map()
  setHostAuthBackend({
    lock,
    storeFor: (namespace) => ({
      load: async (key) => durable.get(`${namespace}:${key}`) ?? null,
      save: async (key, value) => {
        durable.set(`${namespace}:${key}`, value)
      },
      delete: async (key) => {
        durable.delete(`${namespace}:${key}`)
      },
      isPersistent: () => true,
    }),
  })
  jest.mocked(isRemoteHostActive).mockReturnValue(false)
  jest.mocked(getActiveBrowserVault).mockReturnValue(null)
  jest.mocked(getPlugin).mockResolvedValue({
    manifest: {
      authProviders: [
        {
          id: "evidence",
          label: "Evidence",
          methods: [
            "oauth-pkce",
            "oauth-confidential",
            "client-credentials",
            "device-code",
            "api-key",
          ],
          issuers: ["https://vendor.test"],
        },
      ],
    },
  } as never)
  provider = {
    id: "evidence",
    label: "Evidence",
    pluginId: "evidence-owner",
    getSessions: async () => [],
    createSession: jest.fn(),
    removeSession: jest.fn(),
    authorization: { clientId: "public-client", issuer: "https://vendor.test" },
    authorize: jest.fn(async (attempt) => ({
      url: `https://vendor.test/authorize?state=${attempt.attemptId}`,
    })),
    exchange: jest.fn(async () => ({ accessToken: "test-key", scopes: [] })),
    refresh: jest.fn(),
    describe: jest.fn(async (credentials) => ({
      issuer: "https://vendor.test",
      clientId: "public-client",
      principal: { id: "person", kind: "user" as const },
      accountLabel: "Person",
      scopes: credentials.scopes,
    })),
  }
  registerAuthenticationProvider(provider)
  jest.mocked(openExternal).mockImplementation(async (url) => {
    const state = new URL(url).searchParams.get("state")!
    await acceptCallback({ state, code: "accepted" }, "message")
  })
  jest
    .mocked(invokePluginApi)
    .mockResolvedValue({ status: 200, body: { access_token: "test-key" } })
})
afterEach(() => {
  cleanup()
  __resetAuthRegistryForTesting()
  setHostAuthBackend(null)
  rmSync(home, { recursive: true, force: true })
})
afterAll(fixture.dispose)

function platform(profile: PluginRuntimeProfile) {
  jest.mocked(detectPlatform).mockReturnValue(profile === "browser" ? "web" : profile)
  jest.mocked(isTauri).mockReturnValue(profile === "tauri")
  jest.mocked(isCapacitor).mockReturnValue(profile === "mobile")
  jest.mocked(isHeadlessHost).mockReturnValue(profile === "headless")
  expect(currentExternalServiceRuntimeContext()).toEqual({ local: profile, gateway: profile })
}
const supported = (): RuntimeSupportCell => ({
  availability: "supported",
  reason: "runtime-supported",
  recovery: [],
})
function refusal(error: unknown): RuntimeSupportCell {
  if (error instanceof AuthConnectError)
    return {
      availability: "blocked",
      reason: error.reason as RuntimeSupportCell["reason"],
      recovery: error.details.recovery,
    }
  expect(error).toBeInstanceOf(PluginGatewayError)
  const details = (error as PluginGatewayError).details as Pick<
    RuntimeSupportCell,
    "reason" | "recovery"
  >
  return { availability: "blocked", ...details }
}
const authProbe = (method: AuthMethod) => async (): Promise<RuntimeSupportCell> => {
  try {
    const ref = await connectProvider({
      providerId: provider.id,
      method,
      scopes: [],
      configuration: { apiKey: "test-key" },
    })
    expect(ref).toEqual(expect.any(String))
    if (method === "api-key") {
      expect(provider.exchange).not.toHaveBeenCalled()
      expect(provider.refresh).not.toHaveBeenCalled()
    }
    if (method === "oauth-confidential")
      expect(jest.mocked(provider.exchange!).mock.calls[0][0]).not.toHaveProperty("codeVerifier")
    return supported()
  } catch (error) {
    return refusal(error)
  }
}
async function exchangeProbe(): Promise<RuntimeSupportCell> {
  const operations = [
    () =>
      createAuthAPI("evidence-owner", { hasPermission: () => true }).exchangeConfidential({
        providerId: "evidence",
        clientId: "client",
        issuer: "https://vendor.test",
        tokenUrl: "https://vendor.test/token",
        placement: "json",
        params: {},
      }),
    () => setProviderClientSecret("evidence-owner", "evidence", "client", "secret"),
  ]
  const outcomes: RuntimeSupportCell[] = []
  for (const operation of operations) {
    try {
      await operation()
      outcomes.push(supported())
    } catch (error) {
      outcomes.push(refusal(error))
    }
  }
  expect(outcomes[0]).toEqual(outcomes[1])
  return outcomes[0]
}
async function persistenceProbe(profile: PluginRuntimeProfile): Promise<RuntimeSupportCell> {
  setHostAuthBackend(null)
  jest.mocked(transport.call).mockImplementation(async (name, args) => {
    const input = (args as { input: { namespace: string; key: string; value?: string } }).input
    const key = `${input.namespace}:${input.key}`
    if (name === "secret_store_set") durable.set(key, input.value!)
    if (name === "secret_store_delete") durable.delete(key)
    return name === "secret_store_get" ? (durable.get(key) ?? null) : undefined
  })
  jest.mocked(makeDefaultLoader).mockImplementation(
    () => async () =>
      ({
        set: async ({ key, value }: { key: string; value: string }) => {
          durable.set(key, value)
        },
        get: async ({ key }: { key: string }) => ({ value: durable.get(key) }),
        remove: async ({ key }: { key: string }) => {
          durable.delete(key)
        },
      }) as never
  )
  const store = () =>
    new ConnectionCredentialStore(
      new HostAuthSecrets("evidence", {
        native: false,
        lock,
        store:
          profile === "headless"
            ? createCliAuthSecretStore(home, "evidence")
            : createKeyringStore("evidence"),
      })
    )
  const first = store()
  if (profile === "browser") {
    expect(first.isPersistent()).toBe(false)
    await expect(
      first.commit("ref", { raw: null, revision: 0 }, { accessToken: "secret", scopes: [] })
    ).rejects.toBeInstanceOf(CredentialStoreDegraded)
    jest.mocked(getActiveBrowserVault).mockReturnValue({
      localAccountId: "evidence",
      storeSecret: async (key: string, value: string) => {
        durable.set(key, value)
      },
      loadSecret: async (key: string) => durable.get(key) ?? null,
      deleteSecret: async (key: string) => {
        durable.delete(key)
      },
    } as never)
  }
  await first.commit("ref", { raw: null, revision: 0 }, { accessToken: "secret", scopes: [] })
  expect((await store().read("ref")).credentials?.accessToken).toBe("secret")
  return profile === "browser"
    ? {
        availability: "degraded",
        reason: "non-persistent-until-vault-unlock",
        recovery: ["unlock-vault"],
      }
    : supported()
}
async function callbackProbe(profile: PluginRuntimeProfile): Promise<RuntimeSupportCell> {
  if (profile === "headless") {
    const outcome = await authProbe("oauth-pkce")()
    expect(outcome.reason).toBe("no-interactive-browser")
    expect(provider.authorize).not.toHaveBeenCalled()
    try {
      await routeHostAuthCallback("cognia://auth/callback?state=external&code=code")
    } catch (error) {
      const refusal = error as {
        code: string
        reason: RuntimeSupportCell["reason"]
        recovery: RuntimeSupportCell["recovery"]
      }
      expect(refusal.code).toBe("NOT_SUPPORTED")
      return { availability: "blocked", reason: refusal.reason, recovery: refusal.recovery }
    }
    throw new Error("Headless external callback unexpectedly accepted")
  }
  const binding = { providerId: "evidence", clientId: "client", issuer: "https://vendor.test" }
  const attempt = await createAttempt({ ...binding, scopes: [], method: "oauth-pkce" })
  const waiter = registerAuthCallbackWaiter(attempt.state, binding)
  const raw = `cognia://auth/callback?state=${attempt.state}&code=accepted`
  if (profile === "browser")
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { __pluginAuth: true, state: attempt.state, code: "accepted" },
      })
    )
  else if (profile === "tauri") expect(await routePluginDeepLink(raw)).toBe(true)
  else
    dispatchRoute(parseCogniaDeeplink(raw), {
      pushSession: jest.fn(),
      openShareTarget: jest.fn(),
      redeemPair: jest.fn(),
      openWorkflowRun: jest.fn(),
    })
  expect((await waiter.promise).callback.code).toBe("accepted")
  expect(await acceptCallback({ state: attempt.state, code: "replay" }, "deep-link")).toBe(false)
  await waiter.cancel()
  expect(await routeHostAuthCallback("cognia://auth/not-a-callback")).toBe(false)
  return supported()
}
async function networkProbe(profile: PluginRuntimeProfile): Promise<RuntimeSupportCell> {
  getPermissionGuard().grant("evidence-network", "network:fetch")
  const context = createPluginContext(
    {
      manifest: {
        id: "evidence-network",
        name: "Evidence Network",
        version: "1.0.0",
        description: "Runtime network evidence",
        type: "frontend",
        capabilities: [],
        permissions: ["network:fetch"],
        networkAccess: { rules: [{ domain: "vendor.test", methods: ["GET"], paths: ["/data"] }] },
      },
      config: {},
      path: "",
      source: "builtin",
      status: "enabled",
    } satisfies Plugin,
    { createPluginServicesAPI: () => ({}) } as unknown as PluginManager
  )
  const fetch = jest
    .spyOn(global, "fetch")
    .mockRejectedValue(new TypeError("CORS response blocked"))
  try {
    if (profile === "browser" || profile === "mobile") {
      await expect(context.network.fetch("https://vendor.test/data")).rejects.toThrow(
        "CORS response blocked"
      )
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(invokePluginApi).not.toHaveBeenCalled()
      return {
        availability: "degraded",
        reason: "vendor-cors-required",
        recovery: ["pair-with-desktop"],
      }
    }
    await context.network.fetch("https://vendor.test/data")
    expect(invokePluginApi).toHaveBeenCalledWith(
      "evidence-network",
      "network:fetch",
      expect.objectContaining({ url: "https://vendor.test/data" })
    )
    expect(fetch).not.toHaveBeenCalled()
    return supported()
  } finally {
    fetch.mockRestore()
  }
}
async function syncProbe(profile: PluginRuntimeProfile): Promise<RuntimeSupportCell> {
  const view = render(createElement(IntegrationRuntimeInitializer))
  if (profile === "browser" || profile === "mobile") {
    expect(startIntegrationRuntime).not.toHaveBeenCalled()
    view.unmount()
    return {
      availability: "blocked",
      reason: "background-sync-unavailable",
      recovery: ["pair-with-desktop", "use-always-on-host"],
    }
  }
  await waitFor(() => expect(startIntegrationRuntime).toHaveBeenCalledTimes(1))
  const dispose = await jest.mocked(startIntegrationRuntime).mock.results[0].value
  view.unmount()
  expect(dispose).toHaveBeenCalledTimes(1)
  return {
    availability: "supported",
    reason: "host-process-required",
    recovery: ["keep-app-open", "use-always-on-host"],
  }
}

// Explicit probes and profiles, independent of matrix iteration: adding a cell
// without adding evidence fails the completeness test below.
const probes: Record<Facet, (profile: PluginRuntimeProfile) => Promise<RuntimeSupportCell>> = {
  "auth-method:oauth-pkce": authProbe("oauth-pkce"),
  "auth-method:oauth-confidential": authProbe("oauth-confidential"),
  "auth-method:client-credentials": authProbe("client-credentials"),
  "auth-method:device-code": authProbe("device-code"),
  "auth-method:api-key": authProbe("api-key"),
  "auth:confidential-exchange": exchangeProbe,
  "auth:callback": callbackProbe,
  "secrets:persistent": persistenceProbe,
  "network:cross-origin": networkProbe,
  "sync:background": syncProbe,
}
const profiles: PluginRuntimeProfile[] = ["browser", "tauri", "mobile", "headless"]
const cases = profiles.flatMap((profile) =>
  (Object.keys(probes) as Facet[]).map((facet) => ({ profile, facet }))
)
it.each(cases)("ES-33 $profile × $facet", async ({ profile, facet }) => {
  platform(profile)
  expect(await probes[facet](profile)).toEqual(EXTERNAL_SERVICE_RUNTIME_SUPPORT[profile][facet])
})
// `ctx.a2ui` and `ctx.connectors` are built by their modules, whose plugin
// API the manager loads before it builds a context.
beforeAll(() => preloadModulePluginApis())

it("ES-33 completeness: every matrix cell has exactly one named enforcement case", () => {
  const expected = Object.entries(EXTERNAL_SERVICE_RUNTIME_SUPPORT)
    .flatMap(([profile, facets]) => Object.keys(facets).map((facet) => `${profile}:${facet}`))
    .sort()
  const actual = cases.map(({ profile, facet }) => `${profile}:${facet}`).sort()
  expect(actual).toEqual(expected)
  expect(new Set(actual).size).toBe(actual.length)
})
it("ES-33 paired gateway: exchange runs on the Host while secrets stay in the local vault", async () => {
  platform("browser")
  jest.mocked(isRemoteHostActive).mockReturnValue(true)
  const context = currentExternalServiceRuntimeContext()
  expect(context).toEqual({ local: "browser", gateway: "tauri" })
  expect(await exchangeProbe()).toEqual(
    resolveRuntimeSupport("auth:confidential-exchange", context)
  )
  expect(resolveRuntimeSupport("auth:confidential-exchange", context).availability).toBe(
    "supported"
  )
  expect(await persistenceProbe("browser")).toEqual(
    resolveRuntimeSupport("secrets:persistent", context)
  )
  expect(resolveRuntimeSupport("secrets:persistent", context).availability).toBe("degraded")
  expect(resolveRuntimeSupport("sync:background", context).availability).toBe("blocked")
})
