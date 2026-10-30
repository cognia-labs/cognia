jest.mock("@/lib/execution/acting-authority", () => ({
  snapshotActingAuthority: jest.fn(async () => undefined),
  observeActingAuthority: jest.fn(async () => ({ ok: true })),
}))
import { observeActingAuthority, snapshotActingAuthority } from "@/lib/execution/acting-authority"
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))
jest.mock("../context", () => ({ resolveBuiltInSkillTurnActors: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsLarkUserAuth: jest.fn() }))

import { getDb } from "@/lib/db/schema"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { resolveBuiltInSkillTurnActors } from "../context"
import { assertLarkActingIdentity } from "./acting-identity"
import type { BuiltInSkillActingSenders } from "../types"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"

const sessionGet = jest.fn()
const binding = { platform: "lark", adapterId: "a1", conversationKey: "chat" }

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
    accountLabel: "Alice",
  } as never)
  jest.mocked(getDb).mockReturnValue({ sessions: { get: sessionGet } } as never)
  sessionGet.mockResolvedValue({ platformBinding: binding })
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: { connectedUser: { openId: "owner", unionId: "union-owner", name: "Alice" } },
  } as never)
  jest
    .mocked(resolveBuiltInSkillTurnActors)
    .mockResolvedValue({ actingSenders: [{ remoteUserId: "owner", unionId: "union-owner" }] })
})

it("allows the connected owner, including an available matching unionId", async () => {
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
  })
  expect(connectorsLarkUserAuth).toHaveBeenCalledTimes(1)
  expect(resolveBuiltInSkillTurnActors).toHaveBeenCalledWith("chat", "a1", "s1")
})

it("refuses Alice after Bob's token is published but before connectedUser is rewritten", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: {
      connectedUser: { openId: "owner", name: "Alice", authorizationEpoch: "auth-alice" },
    },
  } as never)
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "bob-token",
    authorizationEpoch: "auth-bob",
    accountLabel: "Bob",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("requires the atomic account label to match for legacy rows without an epoch", async () => {
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "bob-token",
    authorizationEpoch: "auth-bob",
    accountLabel: "Bob",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
    accountLabel: null,
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("returns the matching stamped authorization and fails closed on missing native state", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: { connectedUser: { openId: "owner", authorizationEpoch: "auth-owner" } },
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
  })
  jest.mocked(connectorsLarkUserAuth).mockResolvedValueOnce({
    configured: false,
    accessToken: null,
    authorizationEpoch: "auth-owner",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
  jest.mocked(connectorsLarkUserAuth).mockRejectedValueOnce(new Error("native lookup failed"))
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("compares a nameless legacy account using its openId", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: { connectedUser: { openId: "owner" } },
  } as never)
  jest.mocked(connectorsLarkUserAuth).mockResolvedValueOnce({
    configured: true,
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
    accountLabel: "owner",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
  })
})

it("uses the stamped epoch even when two users have the same display name", async () => {
  jest.mocked(getAdapterInstance).mockResolvedValue({
    type: "lark",
    enabled: true,
    settings: {
      connectedUser: { openId: "owner", name: "Alice", authorizationEpoch: "auth-alice" },
    },
  } as never)
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "bob-token",
    authorizationEpoch: "auth-bob",
    accountLabel: "Alice",
  } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

const refusedActors: BuiltInSkillActingSenders[] = [
  [{ remoteUserId: "other" }],
  [{ remoteUserId: "owner" }, { remoteUserId: "other" }],
  "unknown",
  [],
  [{ remoteUserId: "owner", unionId: "wrong-union" }],
]
it.each(refusedActors.map((actingSenders) => ({ actingSenders })))(
  "refuses non-owner, mixed, unknown, empty, or mismatching union actors: %j",
  async ({ actingSenders }) => {
    jest.mocked(resolveBuiltInSkillTurnActors).mockResolvedValue({ actingSenders })
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
      reason: "sender_not_token_owner",
    })
  }
)

it("refuses adapters without a connected user", async () => {
  jest
    .mocked(getAdapterInstance)
    .mockResolvedValue({ type: "lark", enabled: true, settings: {} } as never)
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("fails closed on session and adapter lookup failures", async () => {
  sessionGet.mockRejectedValueOnce(new Error("read failed"))
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
  jest.mocked(getAdapterInstance).mockRejectedValueOnce(new Error("read failed"))
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
    reason: "sender_not_token_owner",
  })
})

it("allows local sessions without a platform binding", async () => {
  sessionGet.mockResolvedValue({ id: "s1" })
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toBeUndefined()
  expect(getAdapterInstance).not.toHaveBeenCalled()
  expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
})

it("uses the explicit verified clicker on confirmation, never the running job", async () => {
  jest
    .mocked(resolveBuiltInSkillTurnActors)
    .mockResolvedValue({ actingSenders: [{ remoteUserId: "other" }] })
  await expect(
    assertLarkActingIdentity("a1", {
      sessionId: "s1",
      hitlBypass: true,
      actingSenders: [{ remoteUserId: "owner" }],
    })
  ).resolves.toEqual({ accessToken: "owner-token", authorizationEpoch: "auth-owner" })
  expect(resolveBuiltInSkillTurnActors).not.toHaveBeenCalled()
})

it("ignores an earlier owner snapshot when another sender is now acting", async () => {
  jest
    .mocked(resolveBuiltInSkillTurnActors)
    .mockResolvedValue({ actingSenders: [{ remoteUserId: "other" }] })
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "s1", actingSenders: [{ remoteUserId: "owner" }] })
  ).rejects.toMatchObject({ reason: "sender_not_token_owner" })
})

it.each([
  undefined,
  { platformBinding: { ...binding, platform: "slack" } },
  { platformBinding: { ...binding, adapterId: "another-app" } },
  { platformBinding: { ...binding, conversationKey: "" } },
])(
  "refuses missing sessions and bindings that cannot prove same-app identity: %j",
  async (session) => {
    sessionGet.mockResolvedValue(session)
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).rejects.toMatchObject({
      reason: "sender_not_token_owner",
    })
  }
)

it.each(
  [undefined, "unknown", []].map((actingSenders) => ({
    actingSenders: actingSenders as BuiltInSkillActingSenders | undefined,
  }))
)("refuses a Confirm re-fire without verified senders: %j", async ({ actingSenders }) => {
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "s1", hitlBypass: true, actingSenders })
  ).rejects.toMatchObject({ reason: "sender_not_token_owner" })
})

it.each(["missing", "revision_advanced"] as const)(
  "observes %s without changing the existing owner gate",
  async (reason) => {
    jest.mocked(snapshotActingAuthority).mockResolvedValueOnce({ runId: "run", revision: 2 })
    jest.mocked(observeActingAuthority).mockResolvedValueOnce({ ok: false, reason })
    await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
      accessToken: "owner-token",
      authorizationEpoch: "auth-owner",
    })
    await Promise.resolve()
    expect(observeActingAuthority).toHaveBeenCalledWith("run", 2, "lark-personal-token")
  }
)

it("does not wait for the observe-only personal-token check", async () => {
  jest.mocked(snapshotActingAuthority).mockResolvedValueOnce({ runId: "run", revision: 0 })
  jest.mocked(observeActingAuthority).mockReturnValueOnce(new Promise(() => {}))
  await expect(assertLarkActingIdentity("a1", { sessionId: "s1" })).resolves.toEqual({
    accessToken: "owner-token",
    authorizationEpoch: "auth-owner",
  })
})
