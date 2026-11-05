import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsKeyringGet: jest.fn() }))
jest.mock("./resolve", () => ({ resolveLarkPrincipal: jest.fn() }))
jest.mock("./bootstrap", () => ({ bootstrapFeishuRegistry: jest.fn() }))
jest.mock("./self-bind", () => ({
  isForgeResistantTransport: jest.fn(),
  selfBindSignedInOwner: jest.fn(),
}))

import { resolveLarkPrincipal } from "./resolve"
import { bootstrapFeishuRegistry } from "./bootstrap"
import { isForgeResistantTransport, selfBindSignedInOwner } from "./self-bind"
import { resolveLarkInboundPrincipal } from "./inbound"

const adapterRow = {
  id: "lark-1",
  settings: {},
  lastWhoamiResult: { appId: "cli_1" },
} as unknown as AdapterInstanceRow

function event(identityScope?: Record<string, unknown>): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId: "lark-1",
    conversationKey: "lark:lark-1:oc_1",
    sender: { id: "s", remoteUserId: "ou_1" },
    channelData: identityScope ? { identityScope } : {},
  } as unknown as NormalizedInboundEvent
}

const unbound = { status: "unbound" as const, openIdHash: "h" }
const resolved = { status: "resolved" as const, accountId: "acct", principal: {}, tenant: {} }

function input(scope?: Record<string, unknown>) {
  return {
    event: event(scope),
    adapterRow,
    transportModes: ["webhook" as const],
    activeAccountId: "acct",
  }
}

beforeEach(() => {
  jest.resetAllMocks()
  jest.mocked(isForgeResistantTransport).mockResolvedValue(true)
  jest.mocked(bootstrapFeishuRegistry).mockResolvedValue({ status: "skipped" } as never)
  jest.mocked(selfBindSignedInOwner).mockResolvedValue({ status: "skipped" } as never)
})

it("returns a resolved sender without seeding or self-binding", async () => {
  jest.mocked(resolveLarkPrincipal).mockResolvedValue(resolved as never)
  await expect(
    resolveLarkInboundPrincipal(input({ tenantKey: "tk", appId: "cli_1" }))
  ).resolves.toBe(resolved)
  expect(resolveLarkPrincipal).toHaveBeenCalledWith(
    expect.objectContaining({
      platform: "lark",
      remoteUserId: "ou_1",
      identityScope: { tenantKey: "tk", appId: "cli_1" },
      activeAccountId: "acct",
    })
  )
  expect(bootstrapFeishuRegistry).not.toHaveBeenCalled()
  expect(selfBindSignedInOwner).not.toHaveBeenCalled()
})

it("drops union_id evidence on a transport that only checks a static token", async () => {
  jest.mocked(isForgeResistantTransport).mockResolvedValue(false)
  jest.mocked(resolveLarkPrincipal).mockResolvedValue(resolved as never)
  await resolveLarkInboundPrincipal(input({ tenantKey: "tk", appId: "cli_1", unionId: "on_1" }))
  expect(resolveLarkPrincipal).toHaveBeenCalledWith(
    expect.objectContaining({ identityScope: { tenantKey: "tk", appId: "cli_1" } })
  )
})

it("keeps union_id evidence on a forge-resistant transport", async () => {
  jest.mocked(resolveLarkPrincipal).mockResolvedValue(resolved as never)
  await resolveLarkInboundPrincipal(input({ tenantKey: "tk", appId: "cli_1", unionId: "on_1" }))
  expect(resolveLarkPrincipal).toHaveBeenCalledWith(
    expect.objectContaining({ identityScope: { tenantKey: "tk", appId: "cli_1", unionId: "on_1" } })
  )
})

it("seeds an unseeded registry from the first event and resolves again", async () => {
  jest
    .mocked(resolveLarkPrincipal)
    .mockResolvedValueOnce(unbound as never)
    .mockResolvedValueOnce(resolved as never)
  jest.mocked(bootstrapFeishuRegistry).mockResolvedValue({ status: "seeded" } as never)
  await expect(resolveLarkInboundPrincipal(input())).resolves.toBe(resolved)
  expect(bootstrapFeishuRegistry).toHaveBeenCalledWith({ adapterId: "lark-1", adapterRow })
  expect(selfBindSignedInOwner).not.toHaveBeenCalled()
})

it("admits the signed-in owner after a failed seed, and stays unbound otherwise", async () => {
  jest
    .mocked(resolveLarkPrincipal)
    .mockResolvedValueOnce(unbound as never)
    .mockResolvedValueOnce(resolved as never)
  jest.mocked(bootstrapFeishuRegistry).mockRejectedValue(new Error("db"))
  jest.mocked(selfBindSignedInOwner).mockResolvedValue({ status: "bound" } as never)
  await expect(resolveLarkInboundPrincipal(input())).resolves.toBe(resolved)
  expect(selfBindSignedInOwner).toHaveBeenCalledWith(
    expect.objectContaining({ adapterId: "lark-1", openId: "ou_1", fallbackAppId: "cli_1" })
  )

  jest
    .mocked(resolveLarkPrincipal)
    .mockReset()
    .mockResolvedValue(unbound as never)
  jest.mocked(selfBindSignedInOwner).mockRejectedValue(new Error("keyring"))
  await expect(resolveLarkInboundPrincipal(input())).resolves.toBe(unbound)
})

it("re-admits only a self-bound principal a sign-out unlinked", async () => {
  const unlinked = {
    status: "principal_disabled" as const,
    principal: { status: "unlinked", selfBoundAt: 1 },
  }
  jest
    .mocked(resolveLarkPrincipal)
    .mockResolvedValueOnce(unlinked as never)
    .mockResolvedValueOnce(resolved as never)
  jest.mocked(selfBindSignedInOwner).mockResolvedValue({ status: "bound" } as never)
  await expect(resolveLarkInboundPrincipal(input())).resolves.toBe(resolved)

  const disabled = { status: "principal_disabled" as const, principal: { status: "disabled" } }
  jest
    .mocked(resolveLarkPrincipal)
    .mockReset()
    .mockResolvedValue(disabled as never)
  jest.mocked(selfBindSignedInOwner).mockClear()
  await expect(resolveLarkInboundPrincipal(input())).resolves.toBe(disabled)
  expect(selfBindSignedInOwner).not.toHaveBeenCalled()
})
