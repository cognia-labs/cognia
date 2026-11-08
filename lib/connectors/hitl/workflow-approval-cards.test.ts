import { resolveBuiltInSkillSessionBinding } from "@/lib/skills/built-in/context"
import { serializeOutboundAsync as serializeLark } from "../adapters/lark/serialize"
import { serializeOutboundAsync as serializeTelegram } from "../adapters/telegram/serialize"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getSettings } from "@/lib/db/settings"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { getResolvedPermissionCeiling } from "@/lib/claude/agents/dispatch-context-registry"
import { deriveExternalSessionPermission } from "@/lib/ai/agent/external/policy/permission-cascade"
import type { ConversationDeliveryTarget } from "@/types/connectors/event"
import { recordCallbackBinding } from "../adapters/_shared/a2ui-mapper"
import { enqueueGoverned } from "../delivery-gateway"
import { buildImPermissionCeiling } from "../im-permission-ceiling"
import { getImElicitationContext } from "./im-elicitation-context"
import { holdWorkflowDispatchForApproval } from "./workflow-run-approval"
import { postWorkflowFanoutApproval, postWorkflowRunApproval } from "./workflow-approval-cards"

jest.mock("@/lib/skills/built-in/context", () => ({ resolveBuiltInSkillSessionBinding: jest.fn() }))
jest.mock("./im-elicitation-context", () => ({ getImElicitationContext: jest.fn() }))
jest.mock("../delivery-gateway", () => ({ enqueueGoverned: jest.fn(async () => ({})) }))
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => ({ language: "en" })) }))
jest.mock("./workflow-run-approval", () => ({ holdWorkflowDispatchForApproval: jest.fn() }))
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(async () => ({ id: "ad" })),
}))
jest.mock("@/lib/db/conversation-overrides", () => ({ readForResolution: jest.fn() }))
jest.mock("../im-permission-ceiling", () => ({
  buildImPermissionCeiling: jest.fn(async () => ({})),
}))
jest.mock("../adapters/_shared/a2ui-mapper", () => ({
  ...jest.requireActual("../adapters/_shared/a2ui-mapper"),
  recordCallbackBinding: jest.fn(),
}))
jest.mock("@/lib/claude/agents/dispatch-context-registry", () => ({
  getResolvedPermissionCeiling: jest.fn(),
}))
// Exercise host copy without the global React next-intl mock.
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: jest.fn(async (namespace: string) => {
    if (namespace !== "workflows.approvals") throw new Error(`Unexpected namespace: ${namespace}`)
    const { getSettings } = await import("@/lib/db/settings")
    const locale = (await getSettings())?.language === "zh-CN" ? "zh-CN" : "en"
    const messages = jest.requireActual(`@/i18n/messages/${locale}/workflows/approvals.json`)
    return (key: string, values?: Record<string, unknown>) => {
      const template = key.split(".").reduce((value, part) => value[part], messages)
      return template.replace(/\{(\w+)\}/g, (_: string, name: string) =>
        String(values?.[name] ?? "")
      )
    }
  }),
}))

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

function target(platform: "lark" | "telegram", threaded = false): ConversationDeliveryTarget {
  return {
    address: {
      platform,
      adapterId: "ad",
      conversationKey: `${platform}:ad:chat`,
      containerId: "chat",
      scopeKind: threaded ? "thread" : "group",
      ...(threaded ? { topicId: "123" } : {}),
    },
    conversationRef:
      platform === "lark"
        ? {
            platform,
            adapterId: "ad",
            channelId: "oc_chat",
            ...(threaded ? { threadTs: "123", threadRootMessageId: "om_anchor" } : {}),
          }
        : { platform, adapterId: "ad", chatId: "chat" },
    sourceMessageId: "42",
    refreshedAt: 1,
  }
}

function bindSession(deliveryTarget: ConversationDeliveryTarget | undefined) {
  jest.mocked(resolveBuiltInSkillSessionBinding).mockResolvedValue({
    personalRunOnly: false,
    rootSessionId: "root",
    personalLane: "unverified",
    session: undefined,
    binding: deliveryTarget && {
      platform: deliveryTarget.address.platform,
      adapterId: "ad",
      conversationKey: deliveryTarget.address.conversationKey,
      conversationRef: deliveryTarget.conversationRef,
      deliveryTarget,
    },
  })
}

const triggeredFrom = {
  source: "im" as const,
  sessionId: "root",
  adapterId: "ad",
  conversationKey: "lark:ad:chat",
  initiator: { platformIdentityId: "requester", remoteUserId: "requester" },
}
const scope = { mode: "initiator" as const, allowedUserIds: ["requester"] }
const fanout = { workflowId: "wf", workflowName: "Daily", triggeredFrom, actorScope: scope }

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getImElicitationContext).mockReturnValue(undefined)
  bindSession(target("lark"))
})

describe("postWorkflowRunApproval", () => {
  it("holds the run under the narrower ceiling and reports the card only after delivery", async () => {
    const parent = { tools: { mode: "allowlist", names: ["read"] } }
    const current = { tools: { mode: "allowlist", names: ["read", "write"] } }
    jest.mocked(getResolvedPermissionCeiling).mockReturnValue(parent as never)
    jest.mocked(buildImPermissionCeiling).mockResolvedValue(current as never)
    jest.mocked(holdWorkflowDispatchForApproval).mockResolvedValue({
      held: true,
      surfaceId: "workflow:prepared",
      workflowName: "Daily",
      surface: {} as never,
    })
    expect(
      await postWorkflowRunApproval({ workflowId: "wf", runParams: { a: 1 }, triggeredFrom })
    ).toEqual({ surfaceId: "workflow:prepared", workflowName: "Daily", surface: {} })
    expect(buildImPermissionCeiling).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "lark", target: "workflow" })
    )
    expect(holdWorkflowDispatchForApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        deliverCard: true,
        workflowId: "wf",
        runParams: { a: 1 },
        adapterId: "ad",
        conversationKey: "lark:ad:chat",
        deliveryTarget: target("lark"),
        conversationRef: target("lark").conversationRef,
        initiatorUserId: "requester",
        permissionCeiling: deriveExternalSessionPermission(parent as never, current as never),
      })
    )
    jest
      .mocked(holdWorkflowDispatchForApproval)
      .mockResolvedValue({ held: false, reason: "card_delivery_failed", message: "hold failed" })
    await expect(postWorkflowRunApproval({ workflowId: "wf", triggeredFrom })).rejects.toThrow(
      "hold failed"
    )
  })

  it("refuses when the adapter is gone", async () => {
    jest.mocked(getAdapterInstance).mockResolvedValueOnce(undefined)
    await expect(postWorkflowRunApproval({ workflowId: "wf", triggeredFrom })).rejects.toThrow(
      "adapter not found"
    )
    expect(holdWorkflowDispatchForApproval).not.toHaveBeenCalled()
  })
})

describe("postWorkflowFanoutApproval", () => {
  it("records both bindings before sending a governed notice to the triggering conversation", async () => {
    const result = await postWorkflowFanoutApproval(fanout)
    const calls = jest.mocked(recordCallbackBinding).mock.calls.map(([binding]) => binding)
    expect(calls).toHaveLength(2)
    expect(calls.map((binding) => binding.kind)).toEqual(["wf_fanout_approve", "wf_fanout_cancel"])
    for (const binding of calls) {
      expect(binding).toMatchObject({
        adapterId: "ad",
        surfaceId: result.surfaceId,
        conversationKey: "lark:ad:chat",
        actorScope: scope,
        allowedActions: ["approve", "cancel"],
        payload: {
          workflowId: "wf",
          workflowName: "Daily",
          target: { adapterId: "ad", conversationKey: "lark:ad:chat" },
          createdBy: "claude-tool",
        },
      })
      expect(result.surface.components[binding.componentId!]).toHaveProperty(
        "value",
        binding.actionId
      )
    }
    expect(enqueueGoverned).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "ad",
        conversationKey: "lark:ad:chat",
        source: "ai-run",
        authorization: { kind: "system-notice", inboundConversationKey: "lark:ad:chat" },
        request: expect.objectContaining({
          segments: [
            expect.objectContaining({
              type: "a2ui",
              surfaceId: result.surfaceId,
              content: result.surface,
            }),
          ],
        }),
      })
    )
    expect(jest.mocked(recordCallbackBinding).mock.invocationCallOrder[1]).toBeLessThan(
      jest.mocked(enqueueGoverned).mock.invocationCallOrder[0]
    )
  })

  it("does not claim success if governed delivery fails", async () => {
    jest.mocked(enqueueGoverned).mockRejectedValueOnce(new Error("delivery refused"))
    await expect(postWorkflowFanoutApproval(fanout)).rejects.toThrow("delivery refused")
  })

  it("uses Chinese host copy when selected", async () => {
    jest.mocked(getSettings).mockResolvedValueOnce({ language: "zh-CN" } as never)
    const result = await postWorkflowFanoutApproval(fanout)
    expect(result.surface.title).toBe("订阅「Daily」")
    expect(result.surface.widget?.fallbackText).toContain("回复 1 同意 / 2 取消")
  })
})

describe.each([
  ["postWorkflowRunApproval", () => postWorkflowRunApproval({ workflowId: "wf", triggeredFrom })],
  ["postWorkflowFanoutApproval", () => postWorkflowFanoutApproval(fanout)],
] as const)("%s", (_name, post) => {
  it("refuses a session with no complete delivery address", async () => {
    bindSession(undefined)
    await expect(post()).rejects.toThrow("delivery target")
    expect(enqueueGoverned).not.toHaveBeenCalled()
    expect(holdWorkflowDispatchForApproval).not.toHaveBeenCalled()
    expect(recordCallbackBinding).not.toHaveBeenCalled()
  })

  it("refuses while the root's live turn is drafting", async () => {
    jest.mocked(getImElicitationContext).mockReturnValue({
      sessionId: "root",
      adapterId: "ad",
      platform: "lark",
      conversationKey: "lark:ad:chat",
      conversationRef: target("lark").conversationRef,
      deliveryTarget: target("lark"),
      drafting: true,
    } as never)
    await expect(post()).rejects.toThrow("delivery target")
    expect(getImElicitationContext).toHaveBeenCalledWith("root")
    expect(enqueueGoverned).not.toHaveBeenCalled()
    expect(holdWorkflowDispatchForApproval).not.toHaveBeenCalled()
  })

  it("refuses a session bound to another conversation", async () => {
    bindSession({
      ...target("lark"),
      address: { ...target("lark").address, conversationKey: "lark:ad:other" },
    })
    await expect(post()).rejects.toThrow("delivery target")
    expect(enqueueGoverned).not.toHaveBeenCalled()
  })
})

it.each(["lark", "telegram"] as const)(
  "sends both host approval cards through the real %s serializer with a recipient and thread anchor",
  async (platform) => {
    for (const threaded of [false, true]) {
      const deliveryTarget = target(platform, threaded)
      bindSession(deliveryTarget)
      const origin = { ...triggeredFrom, conversationKey: deliveryTarget.address.conversationKey }
      await postWorkflowFanoutApproval({ ...fanout, triggeredFrom: origin })
      const fanoutRequest = jest.mocked(enqueueGoverned).mock.calls.at(-1)![0].request
      jest.mocked(holdWorkflowDispatchForApproval).mockImplementationOnce((args) =>
        jest.requireActual("./workflow-run-approval").holdWorkflowDispatchForApproval({
          ...args,
          enqueue: enqueueGoverned,
          recordBinding: jest.fn(),
          audit: jest.fn(),
          readWorkflow: async () => ({ name: "Daily" }),
          resolveDependency: async () => ({
            workflowId: "wf",
            versionId: "v1",
            deploymentId: "d1",
            deploymentRevision: 1,
          }),
        })
      )
      await postWorkflowRunApproval({ workflowId: "wf", triggeredFrom: origin })
      const workflowRequest = jest.mocked(enqueueGoverned).mock.calls.at(-1)![0].request
      for (const request of [fanoutRequest, workflowRequest]) {
        expect(request.deliveryTarget).toEqual(deliveryTarget)
        expect(request.conversationRef).toEqual(deliveryTarget.conversationRef)
        if (platform === "lark") {
          const call = await serializeLark(request, "ad")
          if (threaded) {
            expect(call.url).toContain("/messages/om_anchor/reply")
            expect(call.payload.reply_in_thread).toBe(true)
          } else expect(call.payload.receive_id).toBe("oc_chat")
        } else {
          const calls = await serializeTelegram(request, "ad")
          expect(calls[0].payload.chat_id).toBe("chat")
          if (threaded) expect(calls[0].payload.message_thread_id).toBe(123)
        }
      }
    }
  }
)
