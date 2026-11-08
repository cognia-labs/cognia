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
const mockBuildCapabilityPromptSection = jest.fn()
const mockPostWorkflowRunApproval = jest.fn()
const mockPostWorkflowFanoutApproval = jest.fn()
const mockRecordCallbackBinding = jest.fn()

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
jest.mock("../a2ui-bridge/capability-evaluator", () => ({
  buildCapabilityPromptSection: (...args: unknown[]) => mockBuildCapabilityPromptSection(...args),
}))
jest.mock("../hitl/skill-confirmation", () => ({
  postSkillConfirmation: (input: unknown) => mockPostSkillConfirmation(input),
}))

jest.mock("../hitl/workflow-approval-cards", () => ({
  postWorkflowRunApproval: (input: unknown) => mockPostWorkflowRunApproval(input),
  postWorkflowFanoutApproval: (input: unknown) => mockPostWorkflowFanoutApproval(input),
}))
jest.mock("../adapters/_shared/a2ui-mapper", () => ({
  recordCallbackBinding: (input: unknown) => mockRecordCallbackBinding(input),
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

  it("posts workflow run and fan-out approvals through the approval cards", async () => {
    const card = { surfaceId: "wfsurf:1", workflowName: "Digest", surface: { rootId: "root" } }
    mockPostWorkflowRunApproval.mockResolvedValue(card)
    mockPostWorkflowFanoutApproval.mockResolvedValue(card)
    const triggeredFrom = {
      source: "im" as const,
      sessionId: "s_1",
      adapterId: "adp_1",
      conversationKey: KEY,
    }
    const run = { workflowId: "wf_1", runParams: { a: 1 }, triggeredFrom }
    await expect(port.approveWorkflowRun(run)).resolves.toBe(card)
    expect(mockPostWorkflowRunApproval).toHaveBeenCalledWith(run)
    const fanout = {
      workflowId: "wf_1",
      workflowName: "Digest",
      triggeredFrom,
      actorScope: { mode: "operators" as const },
    }
    await expect(port.approveWorkflowFanout(fanout)).resolves.toBe(card)
    expect(mockPostWorkflowFanoutApproval).toHaveBeenCalledWith(fanout)
  })

  it("records a plugin's callback binding only in a conversation or adapter it serves", async () => {
    const binding = {
      adapterId: "adp_1",
      actionId: "wfapp:1",
      kind: "wf_approve" as const,
      surfaceId: "wfsurf:1",
      payload: {},
      actorScope: { mode: "operators" as const },
    }
    await expect(port.recordCallbackBinding({ ...binding, conversationKey: KEY })).resolves.toBe(
      true
    )
    expect(mockRecordCallbackBinding).toHaveBeenCalledWith({ ...binding, conversationKey: KEY })
    await expect(
      port.recordCallbackBinding({ ...binding, conversationKey: "workflow:wf_1" })
    ).resolves.toBe(false)
    mockGetAdapterInstance.mockResolvedValueOnce(undefined)
    await expect(port.recordCallbackBinding(binding)).resolves.toBe(false)
    expect(mockGetAdapterInstance).toHaveBeenCalledWith("adp_1")
    mockGetAdapterInstance.mockResolvedValueOnce({ id: "adp_1" })
    await expect(port.recordCallbackBinding(binding)).resolves.toBe(true)
    expect(mockRecordCallbackBinding).toHaveBeenCalledTimes(2)
  })

  it("words what the conversation can render once the adapter has learned it", async () => {
    mockBuildCapabilityPromptSection.mockReturnValue("delivered via lark")
    const skills = [{ family: "lark.calendar" }]
    const adapter = {
      lastKnownCapabilities: { button: "native" },
      lastKnownSkillCapabilities: skills,
    } as unknown as AdapterInstanceRow
    const snapshot = { loadedAt: 3 } as never
    await expect(
      port.capabilityPrompt({
        binding: { conversationKey: KEY },
        adapter,
        platform: "lark",
        promptSnapshot: snapshot,
      })
    ).resolves.toBe("delivered via lark")
    expect(mockBuildCapabilityPromptSection).toHaveBeenCalledWith(
      "lark",
      { button: "native" },
      skills,
      snapshot
    )
    for (const lastKnownCapabilities of [undefined, {}])
      await expect(
        port.capabilityPrompt({
          binding: { conversationKey: KEY },
          adapter: { lastKnownCapabilities } as unknown as AdapterInstanceRow,
          platform: "lark",
        })
      ).resolves.toBeNull()
    expect(mockBuildCapabilityPromptSection).toHaveBeenCalledTimes(1)
  })

  it("serves the adapter instance's capabilities, or the platform's without a row", async () => {
    const row = {
      id: "adp_1",
      type: "slack",
      settings: {},
      implMetadata: undefined,
      transportMode: undefined,
    } as unknown as AdapterInstanceRow
    const instance = await port.channelCapabilities({
      binding: { conversationKey: "slack:adp_1:C1" },
      platform: "slack",
      adapter: row,
    })
    expect(instance.fingerprint).toEqual(expect.stringContaining("slack"))
    expect(instance.capabilities.length).toBeGreaterThan(0)
    const platform = await port.channelCapabilities({
      binding: { conversationKey: "slack:adp_1:C1" },
      platform: "slack",
    })
    expect(platform.fingerprint).toBeNull()
    expect(platform.capabilities.length).toBeGreaterThan(0)
  })
})
