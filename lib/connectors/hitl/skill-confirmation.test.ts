/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { z } from "zod"
import { buildConfirmSurface } from "@/lib/skills/built-in/_shared/confirm-surface"
import type { BuiltInSkill } from "@/lib/skills/built-in/types"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { postSkillConfirmation, type SkillConfirmationInput } from "./skill-confirmation"

const mockEnqueue = jest.fn()
jest.mock("../delivery-gateway", () => ({
  enqueueGoverned: (...args: unknown[]) => mockEnqueue(...args),
}))
const mockLiveContext = jest.fn()
jest.mock("./im-elicitation-context", () => ({
  getImElicitationContext: (id: string) => mockLiveContext(id),
}))

const imBinding = {
  adapterId: "lark-1",
  platform: "lark" as const,
  conversationKey: "lark:lark-1:oc_x",
}
const conversationRef = { platform: "lark" as const, adapterId: "lark-1", channelId: "oc_x" }

const skill: BuiltInSkill = {
  id: "lark.calendar.create_event",
  family: "lark.calendar",
  label: { en: "Create event", "zh-CN": "创建日程" },
  description: { en: "Create event", "zh-CN": "创建" },
  platforms: ["lark"],
  mutation: "write",
  imAccess: "always",
  mcpToolName: "lark_calendar_create_event",
  inputSchema: z.object({ calendarId: z.string() }),
  execute: async () => ({ ok: true }),
  hitlSurface: () =>
    buildConfirmSurface({ surfaceId: "sfc_confirm", title: "Confirm", summary: "Create it" }),
}

function input(overrides: Partial<SkillConfirmationInput> = {}): SkillConfirmationInput {
  return {
    ctx: { sessionId: "s_x", imBinding },
    skill,
    args: { calendarId: "cal_1" },
    now: 1_000,
    ...overrides,
  }
}

beforeEach(async () => {
  mockEnqueue.mockReset().mockResolvedValue({ kind: "queued", job: { id: "card" } })
  mockLiveContext.mockReset().mockReturnValue(undefined)
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().sessions.put({
    id: "s_x",
    title: "Root chat",
    createdAt: 0,
    updatedAt: 0,
    platformBinding: { ...imBinding, conversationRef },
  })
})

describe("postSkillConfirmation", () => {
  it("posts the skill's surface with confirm and cancel choices that re-fire it", async () => {
    const result = await postSkillConfirmation(input())
    expect(result).toMatchObject({ status: "pending_hitl", surfaceId: "sfc_confirm" })
    const bindings = await getDb().connectorCallbackBindings.toArray()
    expect(bindings.map((b) => [b.componentId, b.allowedActions])).toEqual(
      expect.arrayContaining([
        ["btn_confirm", ["approve"]],
        ["btn_cancel", ["cancel"]],
      ])
    )
    expect(bindings[0]).toMatchObject({
      kind: "skill_invoke",
      conversationKey: imBinding.conversationKey,
      expiresAt: 1_000 + 7 * 24 * 3600 * 1000,
      payload: { skillId: skill.id, args: { calendarId: "cal_1" }, sessionId: "s_x" },
      // No running inbound job and no live turn: only operators may answer.
      actorScope: { mode: "operators" },
    })
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "lark-1",
        source: "skill",
        authorization: { kind: "system-notice", inboundConversationKey: imBinding.conversationKey },
        request: expect.objectContaining({ conversationRef }),
      }),
      { executionContext: { sessionId: "s_x", executionRunId: "" } }
    )
    expect(
      await getDb().connectorAudit.where("kind").equals("builtin_skill_hitl_pending").count()
    ).toBe(1)
  })

  it("lets only the live turn's initiator answer, through its delivery target", async () => {
    const deliveryTarget = { conversationRef: { ...conversationRef, threadId: "t_1" } }
    mockLiveContext.mockReturnValue({
      sessionId: "s_x",
      ...imBinding,
      conversationRef,
      deliveryTarget,
      initiatorUserId: "ou_1",
    })
    await postSkillConfirmation(input())
    const [binding] = await getDb().connectorCallbackBindings.toArray()
    expect(binding.actorScope).toEqual({ mode: "initiator", allowedUserIds: ["ou_1"] })
    expect(mockEnqueue.mock.calls[0][0].request).toMatchObject({
      conversationRef: deliveryTarget.conversationRef,
      deliveryTarget,
    })
  })

  it("refuses a binding that is not the session's conversation", async () => {
    const result = await postSkillConfirmation(
      input({
        ctx: { sessionId: "s_x", imBinding: { ...imBinding, conversationKey: "lark:lark-1:oc_y" } },
      })
    )
    expect(result).toEqual({
      status: "error",
      message: "No active delivery target for this confirmation",
    })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("refuses while the live turn is drafting", async () => {
    mockLiveContext.mockReturnValue({
      sessionId: "s_x",
      ...imBinding,
      conversationRef,
      drafting: true,
    })
    expect(await postSkillConfirmation(input())).toMatchObject({ status: "error" })
    expect(await getDb().connectorCallbackBindings.count()).toBe(0)
  })

  it("removes both choices when the card cannot be queued", async () => {
    mockEnqueue.mockRejectedValueOnce(new Error("queue unavailable"))
    expect(await postSkillConfirmation(input())).toEqual({
      status: "error",
      message: "queue unavailable",
    })
    expect(await getDb().connectorCallbackBindings.count()).toBe(0)
  })

  it("refuses a skill without a confirmation surface", async () => {
    const { hitlSurface: _unused, ...bare } = skill
    expect(await postSkillConfirmation(input({ skill: bare }))).toEqual({
      status: "error",
      message: `Skill "${skill.id}" requires HITL but defines no hitlSurface.`,
    })
  })
})
