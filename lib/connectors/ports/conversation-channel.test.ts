import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"
import { port } from "./conversation-channel"

const mockReadForResolution = jest.fn()
const mockGetAdapterInstance = jest.fn()
const mockWaitForConversationAutomation = jest.fn()
const mockListSiblingConversations = jest.fn()
const mockFindSessionByConversationKey = jest.fn()
const mockEnqueueAuthorized = jest.fn()
const mockAppendAudit = jest.fn()
const mockGetImElicitationContext = jest.fn()
const mockRunImAskUser = jest.fn()
const mockPostSkillConfirmation = jest.fn()

jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: (key: string) => mockReadForResolution(key),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: (id: string) => mockGetAdapterInstance(id),
}))
jest.mock("../automation-control", () => ({
  waitForConversationAutomation: (...args: unknown[]) => mockWaitForConversationAutomation(...args),
}))
jest.mock("../session-bindings", () => ({
  listSiblingConversations: (key: string) => mockListSiblingConversations(key),
  findSessionByConversationKey: (key: string) => mockFindSessionByConversationKey(key),
}))
jest.mock("../delivery-gateway", () => ({
  enqueueAuthorized: (input: unknown) => mockEnqueueAuthorized(input),
}))
jest.mock("../audit", () => ({ appendAudit: (entry: unknown) => mockAppendAudit(entry) }))
jest.mock("../hitl/im-elicitation-context", () => ({
  getImElicitationContext: (id: string) => mockGetImElicitationContext(id),
}))
jest.mock("../hitl/ask-user-question", () => ({
  runImAskUser: (input: unknown) => mockRunImAskUser(input),
}))
jest.mock("../hitl/skill-confirmation", () => ({
  postSkillConfirmation: (input: unknown) => mockPostSkillConfirmation(input),
}))

const KEY = "lark:adp_1:oc_chat"

beforeEach(() => jest.clearAllMocks())

describe("the IM conversation channel", () => {
  it("claims connector conversation keys and nothing else", () => {
    expect(port.claimsBinding({ conversationKey: KEY })).toBe(true)
    expect(port.claimsBinding({ conversationKey: "workflow:wf_1" })).toBe(false)
    expect(port.claimsBinding({ conversationKey: "" })).toBe(false)
  })

  it("resolves host capabilities from the adapter ceiling and the conversation's opt-ins", async () => {
    mockReadForResolution.mockResolvedValue({ allowGoalDriving: true } as ConversationOverrideRow)
    mockGetAdapterInstance.mockResolvedValue({
      hostCapabilityCeiling: ["goal_driving"],
    } as AdapterInstanceRow)
    const caps = await port.hostCapabilities({ binding: { conversationKey: KEY } })
    expect(mockGetAdapterInstance).toHaveBeenCalledWith("adp_1")
    expect(caps).toMatchObject({ goal_driving: true, computer_use: false, schedule_tools: false })
  })

  it("uses the rows a caller already read, even when one is missing", async () => {
    const caps = await port.hostCapabilities({
      binding: { conversationKey: KEY, adapterId: "adp_1" },
      adapter: undefined,
      override: { allowGoalDriving: true } as ConversationOverrideRow,
    })
    expect(mockReadForResolution).not.toHaveBeenCalled()
    expect(mockGetAdapterInstance).not.toHaveBeenCalled()
    expect(caps.goal_driving).toBe(true)
    const capped = await port.hostCapabilities({
      binding: { conversationKey: KEY },
      adapter: { hostCapabilityCeiling: [] } as unknown as AdapterInstanceRow,
      override: { allowGoalDriving: true } as ConversationOverrideRow,
    })
    expect(capped.goal_driving).toBe(false)
  })

  it("waits on the conversation's automation control", async () => {
    mockWaitForConversationAutomation.mockResolvedValue(false)
    const signal = new AbortController().signal
    await expect(
      port.waitForAutomation({ conversationKey: KEY }, 42, { signal, runId: "r1" })
    ).resolves.toBe(false)
    expect(mockWaitForConversationAutomation).toHaveBeenCalledWith(KEY, 42, {
      signal,
      runId: "r1",
    })
  })

  it("lists sibling conversations", async () => {
    const siblings = [{ adapterId: "adp_2", conversationKey: "lark:adp_2:oc_chat", sessionId: "s" }]
    mockListSiblingConversations.mockResolvedValue(siblings)
    await expect(port.listSiblingConversations({ conversationKey: KEY })).resolves.toEqual(siblings)
  })

  it("posts text on the durable outbound queue with the call's authorization", async () => {
    mockFindSessionByConversationKey.mockResolvedValue(undefined)
    mockEnqueueAuthorized.mockResolvedValue({ kind: "drafted" })
    const authorization = { kind: "origin-reply", inboundConversationKey: KEY } as const
    await expect(
      port.postText({
        binding: { adapterId: "adp_1", conversationKey: KEY },
        text: "hi",
        authorization,
      })
    ).resolves.toBe("drafted")
    expect(mockEnqueueAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "adp_1",
        conversationKey: KEY,
        source: "skill",
        authorization,
        request: expect.objectContaining({
          conversationRef: { platform: "lark", adapterId: "adp_1", channelId: "oc_chat" },
          segments: [{ type: "text", text: "hi" }],
        }),
      })
    )
  })

  it("posts to the session's own conversation reference when one is bound", async () => {
    const conversationRef = {
      platform: "lark",
      adapterId: "adp_1",
      channelId: "oc_chat",
      threadId: "t",
    }
    mockFindSessionByConversationKey.mockResolvedValue({ platformBinding: { conversationRef } })
    mockEnqueueAuthorized.mockResolvedValue({ kind: "queued" })
    await port.postText({
      binding: { adapterId: "adp_1", conversationKey: KEY },
      text: "hi",
      authorization: { kind: "origin-reply", inboundConversationKey: KEY },
    })
    expect(mockEnqueueAuthorized.mock.calls[0][0].request.conversationRef).toBe(conversationRef)
  })

  it("appends audit rows and swallows an audit failure", async () => {
    mockAppendAudit.mockRejectedValueOnce(new Error("db closed"))
    await expect(
      port.appendAudit({ adapterId: "adp_1", kind: "team.posted_as_bot", conversationKey: KEY })
    ).resolves.toBeUndefined()
    expect(mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "adp_1",
        kind: "team.posted_as_bot",
        at: expect.any(Number),
      })
    )
  })

  it("answers ask_user for a session one of its turns owns, as a card in the conversation", async () => {
    const ctx = { sessionId: "s_1", adapterId: "adp_1", conversationKey: KEY }
    mockGetImElicitationContext.mockReturnValue(ctx)
    mockRunImAskUser.mockResolvedValue("Selected: Beta")
    const signal = new AbortController().signal
    await expect(
      port.askUser({ sessionId: "s_1", toolUseId: "tu_1", args: { q: 1 }, signal })
    ).resolves.toEqual({ result: "Selected: Beta" })
    expect(mockGetImElicitationContext).toHaveBeenCalledWith("s_1")
    expect(mockRunImAskUser).toHaveBeenCalledWith({
      ctx,
      toolUseId: "tu_1",
      args: { q: 1 },
      signal,
    })
  })

  it("leaves ask_user to others for a session none of its turns owns", async () => {
    mockGetImElicitationContext.mockReturnValue(undefined)
    await expect(port.askUser({ sessionId: "s_2", toolUseId: "tu", args: {} })).resolves.toBeNull()
    expect(mockRunImAskUser).not.toHaveBeenCalled()
  })

  it("posts a skill confirmation through the confirmation card", async () => {
    mockPostSkillConfirmation.mockResolvedValue({ status: "pending_hitl", bindingId: "b" })
    const input = {
      ctx: {
        sessionId: "s_1",
        imBinding: { adapterId: "adp_1", platform: "lark" as const, conversationKey: KEY },
      },
      skill: { id: "lark.x" } as never,
      args: {},
      now: 1,
    }
    await expect(port.confirmSkill(input)).resolves.toEqual({
      status: "pending_hitl",
      bindingId: "b",
    })
    expect(mockPostSkillConfirmation).toHaveBeenCalledWith(input)
  })
})
