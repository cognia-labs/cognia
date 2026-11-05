import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { PlatformAvatarTarget } from "@/lib/connectors/platform-avatar"
import type { ConnectorVendorAvatarContext } from "@/lib/connectors/vendor-contribution"

jest.mock("@/lib/db/adapter-instances", () => ({ listAdapterInstancesByType: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsKeyringGet: jest.fn() }))
jest.mock("./http", () => ({ larkTenantRequest: jest.fn() }))

import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { larkTenantRequest } from "./http"
import { resolveLarkAvatar } from "./avatar"

const adapter = { id: "lark-1", type: "lark", settings: {} } as unknown as AdapterInstanceRow

function context(
  target: Partial<PlatformAvatarTarget>,
  overrides: Partial<ConnectorVendorAvatarContext> = {}
): ConnectorVendorAvatarContext {
  return {
    target: { platform: "lark", adapterId: "lark-1", kind: "user", remoteId: "ou_1", ...target },
    adapter,
    active: () => true,
    // The framework screen: only the test CDN passes.
    publicUrl: (value) =>
      typeof value === "string" && value.startsWith("https://cdn.feishucdn.com/")
        ? value
        : undefined,
    ...overrides,
  }
}

beforeEach(() => {
  jest.resetAllMocks()
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(async (_id, key) => (key === "appId" ? "cli_self" : "secret") as never)
})

it("returns nothing without the adapter's app credentials", async () => {
  jest.mocked(connectorsKeyringGet).mockResolvedValue(null as never)
  await expect(resolveLarkAvatar(context({}))).resolves.toBeUndefined()
  expect(larkTenantRequest).not.toHaveBeenCalled()
})

it("reads a user portrait through the contact API and screens the URL", async () => {
  jest.mocked(larkTenantRequest).mockResolvedValue({
    data: { user: { avatar: { avatar_240: "https://cdn.feishucdn.com/u.png" } } },
  })
  await expect(resolveLarkAvatar(context({}))).resolves.toEqual({
    url: "https://cdn.feishucdn.com/u.png",
  })
  expect(larkTenantRequest).toHaveBeenCalledWith(
    { appId: "cli_self", appSecret: "secret" },
    "GET",
    "/contact/v3/users/ou_1?user_id_type=open_id",
    undefined,
    "service-data",
    { avatarPolicy: true }
  )
  jest.mocked(larkTenantRequest).mockResolvedValue({
    data: { user: { avatar: { avatar_240: "https://evil.example/u.png" } } },
  })
  await expect(resolveLarkAvatar(context({}))).resolves.toBeUndefined()
})

it("reads a chat avatar through the chat API", async () => {
  jest.mocked(larkTenantRequest).mockResolvedValue({
    data: { avatar: "https://cdn.feishucdn.com/g.png" },
  })
  await expect(resolveLarkAvatar(context({ kind: "group", remoteId: "oc_1" }))).resolves.toEqual({
    url: "https://cdn.feishucdn.com/g.png",
  })
  expect(jest.mocked(larkTenantRequest).mock.calls[0][2]).toBe("/im/v1/chats/oc_1")
})

it("uses bot/v3/info only for the verified self bot", async () => {
  jest.mocked(listAdapterInstancesByType).mockResolvedValue([])
  jest.mocked(larkTenantRequest).mockResolvedValue({
    bot: { open_id: "ou_self", avatar_url: "https://cdn.feishucdn.com/self.png" },
  })
  await expect(
    resolveLarkAvatar(context({ actorKind: "bot", remoteId: "ou_self" }))
  ).resolves.toEqual({ url: "https://cdn.feishucdn.com/self.png" })
  await expect(
    resolveLarkAvatar(context({ actorKind: "bot", remoteId: "ou_other" }))
  ).resolves.toBeUndefined()
})

it("takes a sibling bot's confirmed avatar when its app id matches the keyring", async () => {
  jest.mocked(listAdapterInstancesByType).mockResolvedValue([
    {
      id: "lark-2",
      lastWhoamiResult: {
        openId: "ou_sib",
        appId: "cli_sib",
        botAvatar: "https://cdn.feishucdn.com/sib.png",
      },
    },
  ] as never)
  jest
    .mocked(connectorsKeyringGet)
    .mockImplementation(
      async (id, key) =>
        (key === "appId" ? (id === "lark-2" ? "cli_sib" : "cli_self") : "secret") as never
    )
  await expect(
    resolveLarkAvatar(context({ actorKind: "bot", remoteId: "ou_sib" }))
  ).resolves.toEqual({ url: "https://cdn.feishucdn.com/sib.png" })
  expect(larkTenantRequest).not.toHaveBeenCalled()
})

it("stops when the lookup goes stale mid-flight", async () => {
  let live = true
  jest.mocked(larkTenantRequest).mockImplementation(async () => {
    live = false
    return { data: { user: { avatar: { avatar_240: "https://cdn.feishucdn.com/u.png" } } } }
  })
  jest.mocked(listAdapterInstancesByType).mockResolvedValue([])
  await expect(
    resolveLarkAvatar(context({ actorKind: "bot", remoteId: "ou_self" }, { active: () => live }))
  ).resolves.toBeUndefined()
})
