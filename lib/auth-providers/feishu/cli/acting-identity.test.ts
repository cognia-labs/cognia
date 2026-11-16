/** @jest-environment node */
jest.mock("@/lib/i18n/runtime-translator", () => ({ currentLocale: jest.fn(async () => "en") }))
jest.mock("@/lib/execution/acting-authority", () => ({
  resolveRunActingIdentity: jest.fn(),
  snapshotActingAuthority: jest.fn(async () => undefined),
  observeActingAuthority: jest.fn(async () => ({ ok: true })),
}))
jest.mock("@/lib/execution/personal-credential", () => ({ admitPersonalCredential: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({ connectorsLarkUserAuth: jest.fn() }))
jest.mock("../host-auth", () => ({ larkActingPerson: jest.fn() }))
jest.mock("@/lib/connectors/delegated-authorization", () => ({
  offerDelegatedAuthorization: jest.fn(async () => "queued"),
}))
jest.mock("@/lib/skills/built-in/context", () => ({
  resolveBuiltInSkillRunScope: (ctx: { sessionId: string; executionRunId?: string }) => ({
    sessionId: ctx.sessionId,
    runId: ctx.executionRunId,
  }),
  resolveBuiltInSkillSessionBinding: jest.fn(),
}))

import { currentLocale } from "@/lib/i18n/runtime-translator"
import { observeActingAuthority, snapshotActingAuthority } from "@/lib/execution/acting-authority"
import { admitPersonalCredential } from "@/lib/execution/personal-credential"
import { connectorsLarkUserAuth } from "@/lib/connectors/tauri/commands"
import { larkActingPerson } from "../host-auth"
import { resolveBuiltInSkillSessionBinding } from "@/lib/skills/built-in/context"
import { offerDelegatedAuthorization } from "@/lib/connectors/delegated-authorization"
import zhSkills from "@/i18n/messages/zh-CN/skills.json"
import {
  admitLarkUserAuthorization,
  assertLarkActingIdentity,
  LarkActingIdentityError,
} from "./acting-identity"

const KEY = "a".repeat(64)
const member = {
  kind: "platform",
  platform: "lark",
  adapterId: "a1",
  remoteUserId: "ou_m",
} as const
const ctx = { sessionId: "s1", executionRunId: "r1" }

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(larkActingPerson).mockResolvedValue({ person: member, key: KEY })
  jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
    binding: undefined,
    personalLane: "local-session",
    personalRunOnly: false,
  } as never)
  jest
    .mocked(admitPersonalCredential)
    .mockResolvedValue({ ok: true, source: "lark-user", person: member })
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({
    configured: true,
    accessToken: "member-token",
    authorizationEpoch: "e1",
  } as never)
})

it("uses the acting person's own authorization, admitted as that person", async () => {
  await expect(admitLarkUserAuthorization("a1", ctx)).resolves.toEqual({
    principal: KEY,
    accessToken: "member-token",
    authorizationEpoch: "e1",
  })
  expect(larkActingPerson).toHaveBeenCalledWith("a1", ctx)
  expect(admitPersonalCredential).toHaveBeenCalledWith(ctx, {
    source: "lark-user",
    person: member,
  })
  expect(connectorsLarkUserAuth).toHaveBeenCalledWith({
    action: "snapshot",
    adapterId: "a1",
    principal: KEY,
  })
})

it("answers no authorization when the admitted person can have none here", async () => {
  jest.mocked(larkActingPerson).mockResolvedValue({ person: { kind: "local-person" } })
  await expect(admitLarkUserAuthorization("a1", ctx)).resolves.toBeUndefined()
  expect(admitPersonalCredential).toHaveBeenCalledWith(ctx, {
    source: "lark-user",
    person: { kind: "local-person" },
  })
  expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
})

it("refuses a run acting as a person of another adapter", async () => {
  jest.mocked(larkActingPerson).mockResolvedValue(undefined)
  await expect(admitLarkUserAuthorization("a1", ctx)).rejects.toBeInstanceOf(
    LarkActingIdentityError
  )
  expect(admitPersonalCredential).not.toHaveBeenCalled()
})

it("refuses before reading a token when admission refuses", async () => {
  jest.mocked(admitPersonalCredential).mockResolvedValue({
    ok: false,
    source: "lark-user",
    reason: "trigger-not-personal",
  })
  await expect(admitLarkUserAuthorization("a1", ctx)).rejects.toBeInstanceOf(
    LarkActingIdentityError
  )
  expect(connectorsLarkUserAuth).not.toHaveBeenCalled()
})

it("answers no authorization when the native state has no token", async () => {
  jest.mocked(connectorsLarkUserAuth).mockResolvedValue({ configured: false } as never)
  await expect(admitLarkUserAuthorization("a1", ctx)).resolves.toBeUndefined()
})

describe("a requester who never authorized", () => {
  beforeEach(() => {
    jest.mocked(connectorsLarkUserAuth).mockResolvedValue({ configured: false } as never)
  })
  const bound = (adapterId: string) =>
    jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
      binding: { adapterId, conversationKey: `lark:${adapterId}:oc_group` },
      personalLane: "im-binding",
      personalRunOnly: false,
    } as never)

  it("gets their own link as a delivery of this turn", async () => {
    bound("a1")
    await expect(admitLarkUserAuthorization("a1", ctx)).resolves.toBeUndefined()
    expect(offerDelegatedAuthorization).toHaveBeenCalledWith({
      adapterId: "a1",
      conversationKey: "lark:a1:oc_group",
      executionRunId: "r1",
      person: member,
    })
  })

  it("gets no link outside a conversation of this adapter, or for the local person", async () => {
    bound("other")
    await admitLarkUserAuthorization("a1", ctx)
    bound("a1")
    jest.mocked(larkActingPerson).mockResolvedValue({ person: { kind: "local-person" } })
    await admitLarkUserAuthorization("a1", ctx)
    expect(offerDelegatedAuthorization).not.toHaveBeenCalled()
  })

  it("still answers no authorization when the link cannot be issued", async () => {
    bound("a1")
    jest
      .mocked(offerDelegatedAuthorization)
      .mockRejectedValueOnce(new Error("redirect_uri_unresolved"))
    await expect(admitLarkUserAuthorization("a1", ctx)).resolves.toBeUndefined()
  })
})

it("observes the run's authority without waiting for it", async () => {
  jest.mocked(snapshotActingAuthority).mockResolvedValue({ runId: "r1", revision: 3 })
  jest.mocked(observeActingAuthority).mockReturnValue(new Promise(() => undefined))
  await expect(admitLarkUserAuthorization("a1", ctx)).resolves.toMatchObject({ principal: KEY })
  expect(snapshotActingAuthority).toHaveBeenCalledWith("s1", "r1")
})

it("refuses a skill call without a context or invoked by a plugin", async () => {
  await expect(assertLarkActingIdentity("a1")).rejects.toBeInstanceOf(LarkActingIdentityError)
  await expect(
    assertLarkActingIdentity("a1", {
      sessionId: "s1",
      outboundAuthorization: { kind: "plugin" },
    } as never)
  ).rejects.toBeInstanceOf(LarkActingIdentityError)
  expect(larkActingPerson).not.toHaveBeenCalled()
})

it("refuses a skill call in a session nobody's desktop lane owns", async () => {
  jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
    binding: undefined,
    personalLane: "unverified",
    personalRunOnly: false,
  } as never)
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "s1", executionRunId: "r1" })
  ).rejects.toBeInstanceOf(LarkActingIdentityError)
  jest.mocked(resolveBuiltInSkillSessionBinding).mockRejectedValue(new Error("cycle"))
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "s1", executionRunId: "r1" })
  ).rejects.toBeInstanceOf(LarkActingIdentityError)
  expect(larkActingPerson).not.toHaveBeenCalled()
})

it("admits a skill call with its run scope", async () => {
  await expect(
    assertLarkActingIdentity("a1", { sessionId: "s1", executionRunId: "r1", delivery: true })
  ).resolves.toMatchObject({ principal: KEY })
  expect(larkActingPerson).toHaveBeenCalledWith("a1", {
    sessionId: "s1",
    executionRunId: "r1",
    delivery: true,
  })
})

it("uses the shared Chinese refusal catalog when the runtime translator selects it", async () => {
  jest.mocked(currentLocale).mockResolvedValue("zh-CN")
  await expect(assertLarkActingIdentity("a1")).rejects.toThrow(
    zhSkills.actingIdentity.personalAccessRule
  )
})
