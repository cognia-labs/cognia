/**
 * Lark's adapter builder and the bot open_id refresh (`./build.ts`),
 * contributed to the adapter registry through `./contribution.ts`.
 */

import { getTenantToken } from "@/lib/auth-providers/feishu/auth"
jest.mock("@/lib/auth-providers/feishu/auth", () => {
  const actual = jest.requireActual("@/lib/auth-providers/feishu/auth")
  return { ...actual, getTenantToken: jest.fn(actual.getTenantToken) }
})

import { invoke } from "@tauri-apps/api/core"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"

jest.mock("@/lib/db/adapter-instances", () => ({
  ...jest.requireActual("@/lib/db/adapter-instances"),
  getAdapterInstance: jest.fn(),
  updateAdapterInstance: jest.fn(async () => undefined),
}))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("./index", () => ({
  createLarkAdapter: jest.fn().mockReturnValue({ platform: "lark", id: "lk-mock" }),
}))

import { buildLarkAdapter, refreshSelfBotOpenId } from "./build"
import { createLarkAdapter } from "./index"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultPrivateChatPolicy } from "@/types/connectors/policy"

const mockInvoke = invoke as jest.Mock
const mockCreateLarkAdapter = createLarkAdapter as jest.Mock

function makeRow(overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "test-adapter",
    type: "lark",
    displayName: "Test Adapter",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["botToken"] },
    trigger: defaultPrivateChatPolicy(),
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  }
}

function makeLarkBotInfoResp(openId: string) {
  // Lark `/open-apis/bot/v3/info` returns `{ code, msg, bot: { open_id, ... } }`
  // (see `lib/connectors/adapters/lark/whoami.ts:LarkBotInfoResponse`). The
  // earlier `data.open_id` shape here mirrored a buggy parser in
  // `refreshSelfBotOpenId` that always reported `api-failed` against real
  // Lark traffic — fixed in lockstep.
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, bot: { open_id: openId, app_name: "cognia-bot" } }),
  }
}

function makeLarkTatResp() {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, tenant_access_token: "t-test-tat", expire: 7200 }),
  }
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockCreateLarkAdapter.mockClear()
  jest.mocked(getAdapterInstance).mockReset()
  jest.mocked(updateAdapterInstance).mockClear()
})

describe("buildLarkAdapter", () => {
  it.each([
    ["invalid", "fill"],
    ["default", "default"],
    ["compact", "compact"],
    ["fill", "fill"],
  ])("passes normalized persisted %s width into the running adapter", async (width, expected) => {
    await buildLarkAdapter(
      makeRow({
        type: "lark",
        settings: {
          selfBotOpenId: "ou_cached",
          cardPresentation: { theme: "purple", showElapsed: false, width },
        },
      })
    )
    expect(mockCreateLarkAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        cardPresentation: expect.objectContaining({
          theme: "purple",
          showElapsed: false,
          width: expected,
        }),
      })
    )
  })
  it("passes selfBotOpenId resolved from bot/v3/info into createLarkAdapter", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "connectors_keyring_get") return "lark-cred-value"
      if (cmd === "connectors_http_request") {
        const url = (args as { req?: { url?: string } })?.req?.url ?? ""
        if (url.includes("tenant_access_token")) return makeLarkTatResp()
        return makeLarkBotInfoResp("ou_bot_open_001")
      }
      return null
    })

    const row = makeRow({
      id: "lk-10",
      type: "lark",
      transportMode: "gateway",
      settings: { transport: "long-connection" },
      credentialsRef: {
        keyringService: "com.cognia.platforms",
        accounts: ["appId", "appSecret", "encryptKey", "verificationToken"],
      },
    })
    await buildLarkAdapter(row)

    const callArgs = mockCreateLarkAdapter.mock.calls[0][0] as {
      id: string
      selfBotOpenId: string
      transport: string
      appId: () => Promise<string>
    }
    expect(callArgs.id).toBe("lk-10")
    expect(callArgs.selfBotOpenId).toBe("ou_bot_open_001")
    expect(callArgs.transport).toBe("long-connection")
    expect(typeof callArgs.appId).toBe("function")
  })

  it("falls back to empty selfBotOpenId when bot/v3/info throws", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "connectors_keyring_get") return "lark-cred"
      if (cmd === "connectors_http_request") {
        const url = (args as { req?: { url?: string } })?.req?.url ?? ""
        if (url.includes("tenant_access_token")) return makeLarkTatResp()
        throw new Error("network error")
      }
      return null
    })

    const row = makeRow({ id: "lk-11", type: "lark", transportMode: "gateway" })
    await buildLarkAdapter(row)

    const callArgs = mockCreateLarkAdapter.mock.calls[0][0] as { selfBotOpenId: string }
    expect(callArgs.selfBotOpenId).toBe("")
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("lk-11"))
    warnSpy.mockRestore()
  })

  it("uses webhook transport when settings.transport is webhook", async () => {
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "connectors_keyring_get") return "lark-cred"
      if (cmd === "connectors_http_request") {
        const url = (args as { req?: { url?: string } })?.req?.url ?? ""
        if (url.includes("tenant_access_token")) return makeLarkTatResp()
        return makeLarkBotInfoResp("ou_wh_bot")
      }
      return null
    })

    const row = makeRow({
      id: "lk-12",
      type: "lark",
      transportMode: "webhook",
      settings: { transport: "webhook" },
    })
    await buildLarkAdapter(row)

    const callArgs = mockCreateLarkAdapter.mock.calls[0][0] as { transport: string }
    expect(callArgs.transport).toBe("webhook")
  })

  it("credential factories resolve fresh values from keyring on each call", async () => {
    let callCount = 0
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "connectors_keyring_get") {
        callCount++
        return `CRED-${callCount}`
      }
      if (cmd === "connectors_http_request") {
        const url = (args as { req?: { url?: string } })?.req?.url ?? ""
        if (url.includes("tenant_access_token")) return makeLarkTatResp()
        return makeLarkBotInfoResp("ou_fresh")
      }
      return null
    })

    const row = makeRow({ id: "lk-13", type: "lark", transportMode: "gateway" })
    await buildLarkAdapter(row)

    const callArgs = mockCreateLarkAdapter.mock.calls[0][0] as {
      appId: () => Promise<string>
    }
    const cred = await callArgs.appId()
    expect(cred).toMatch(/^CRED-/)
  })
})

it("labels registry self-bot discovery as adapter administration", async () => {
  mockInvoke.mockImplementation(async (cmd: string, args: { req?: { url?: string } }) => {
    if (cmd === "connectors_keyring_get") return "purpose-registry-credential"
    if (cmd === "connectors_http_request")
      return args.req?.url?.includes("tenant_access_token")
        ? makeLarkTatResp()
        : makeLarkBotInfoResp("ou_purpose")
    return null
  })
  await buildLarkAdapter(makeRow({ id: "purpose-registry", type: "lark", settings: {} }))
  expect(getTenantToken).toHaveBeenCalledWith(
    { appId: "purpose-registry-credential", appSecret: "purpose-registry-credential" },
    "adapter-admin"
  )
})

describe("refreshSelfBotOpenId", () => {
  it("refuses an adapter that is not Lark", async () => {
    jest.mocked(getAdapterInstance).mockResolvedValue(makeRow({ id: "tg-1", type: "telegram" }))
    await expect(refreshSelfBotOpenId("tg-1")).resolves.toMatchObject({
      ok: false,
      reason: "not-lark",
    })
  })

  it("asks for credentials before probing", async () => {
    jest.mocked(getAdapterInstance).mockResolvedValue(makeRow({ id: "lk-1" }))
    mockInvoke.mockResolvedValue(null)
    await expect(refreshSelfBotOpenId("lk-1")).resolves.toMatchObject({
      ok: false,
      reason: "missing-credentials",
    })
  })

  it("persists the probed open_id", async () => {
    jest.mocked(getAdapterInstance).mockResolvedValue(makeRow({ id: "lk-2" }))
    mockInvoke.mockImplementation(async (cmd: string, args: { req?: { url?: string } }) => {
      if (cmd === "connectors_keyring_get") return "refresh-credential"
      if (cmd === "connectors_http_request")
        return args.req?.url?.includes("tenant_access_token")
          ? makeLarkTatResp()
          : makeLarkBotInfoResp("ou_refreshed")
      return null
    })
    await expect(refreshSelfBotOpenId("lk-2")).resolves.toEqual({
      ok: true,
      openId: "ou_refreshed",
    })
    expect(updateAdapterInstance).toHaveBeenCalledWith("lk-2", {
      settings: expect.objectContaining({ selfBotOpenId: "ou_refreshed" }),
    })
  })
})
