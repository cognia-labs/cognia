jest.mock("./_helpers", () => ({
  ...jest.requireActual("./_helpers"),
  resolveChatCapableAdapter: jest.fn(),
  withScopeCapture: jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
}))

import { getSharedBuiltInSkillRegistry } from "../registry"
import "./resolve-contact"
import { resolveChatCapableAdapter } from "./_helpers"
import { createLarkChatManagement } from "@/lib/connectors/adapters/lark/chat-management"
import { getUserAccessToken } from "@/lib/connectors/adapters/lark/auth"

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    sessions: {
      get: async () => ({
        platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "chat" },
      }),
    },
  }),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: async () => ({
    type: "lark",
    enabled: true,
    settings: { connectedUser: { openId: "owner" } },
  }),
}))
jest.mock("../context", () => ({
  resolveBuiltInSkillTurnActors: async () => ({ actingSenders: [{ remoteUserId: "other" }] }),
}))
jest.mock("@/lib/connectors/adapters/lark/auth", () => ({
  getUserAccessToken: jest.fn(),
  getTenantAccessToken: jest.fn(),
}))

const mResolve = resolveChatCapableAdapter as jest.Mock
const mContacts = jest.fn()

function skill() {
  const s = getSharedBuiltInSkillRegistry()
    .list()
    .find((x) => x.id === "im.resolve_contact")
  if (!s) throw new Error("im.resolve_contact not registered")
  return s
}

beforeEach(() => {
  jest.clearAllMocks()
  mResolve.mockResolvedValue({
    adapterId: "a1",
    platform: "lark",
    adapter: { resolveContacts: mContacts },
  })
  mContacts.mockResolvedValue([{ memberId: "ou_a", email: "a@x.com", confidence: "exact" }])
})

describe("im.resolve_contact", () => {
  it("refuses a non-owner IM name search through the real adapter path before reading a token", async () => {
    const adapter = createLarkChatManagement("a1", async () => ({
      appId: "app",
      appSecret: "secret",
    }))
    mResolve.mockResolvedValue({ adapterId: "a1", platform: "lark", adapter })
    await expect(skill().execute({ query: "Alice" }, { sessionId: "s" })).rejects.toMatchObject({
      reason: "sender_not_token_owner",
    })
    expect(getUserAccessToken).not.toHaveBeenCalled()
  })
  it("schema refuses an empty request (no emails/phones/query)", () => {
    expect(skill().inputSchema.safeParse({}).success).toBe(false)
    expect(skill().inputSchema.safeParse({ query: "  " }).success).toBe(false)
  })

  it("passes emails/phones/query through and wraps candidates", async () => {
    const out = await skill().execute(
      { emails: ["a@x.com"], phones: ["+861380"], query: "Alice" },
      { sessionId: "s" }
    )
    expect(mContacts).toHaveBeenCalledWith({
      emails: ["a@x.com"],
      phones: ["+861380"],
      query: "Alice",
      skillContext: { sessionId: "s" },
    })
    expect(out).toEqual({
      candidates: [{ memberId: "ou_a", email: "a@x.com", confidence: "exact" }],
    })
  })

  it("is a read-tier skill (no hitlSurface)", () => {
    expect(skill().mutation).toBe("read")
    expect(skill().hitlSurface).toBeUndefined()
  })

  it("accepts phones-only and query-only requests (schema refine legs)", async () => {
    expect(skill().inputSchema.safeParse({ phones: ["+8613800000000"] }).success).toBe(true)
    expect(skill().inputSchema.safeParse({ query: "Alice" }).success).toBe(true)
    await skill().execute({ phones: ["+8613800000000"] }, { sessionId: "s" })
    expect(mContacts).toHaveBeenCalledWith({
      emails: undefined,
      phones: ["+8613800000000"],
      query: undefined,
      skillContext: { sessionId: "s" },
    })
  })

  it("declares the contact-identifier fields as piiArgFields (dispatcher exemption)", () => {
    expect(skill().piiArgFields).toEqual(["emails", "phones", "query"])
  })
})
