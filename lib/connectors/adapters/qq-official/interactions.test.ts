import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { prepareQQKeyboards, recordQQKeyboardReceipts } from "./a2ui-mapper"
import {
  parseQQInteraction,
  resolveQQInteraction,
  qqInteractionAckId,
  qqInteractionResultCode,
} from "./interactions"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

async function envelope(scene: "group" | "c2c" = "group") {
  const prepared = await prepareQQKeyboards({
    conversationRef: {
      platform: "qq-official",
      adapterId: "qq",
      scene,
      sceneId: "target",
      msgId: "inbound",
    },
    metadata: { idempotencyKey: "job" },
    segments: [
      {
        type: "a2ui",
        surfaceId: "surface",
        plainTextMirror: "Approve",
        content: {
          rootId: "button",
          dataModel: {},
          components: {
            button: {
              component: "Button",
              text: "Approve",
              action: "approve",
              bindingActorScope: {
                mode: "initiator",
                allowedUserIds: [scene === "c2c" ? "target" : "owner"],
              },
            },
          },
        },
      },
    ],
  })
  const card = prepared.request.segments[0]!
  if (card.type !== "card") throw new Error("expected keyboard")
  await recordQQKeyboardReceipts(
    prepared.bindings,
    (card.card.payload as { keyboard: unknown }).keyboard,
    "sent"
  )
  return {
    op: 0,
    t: "INTERACTION_CREATE",
    d: {
      id: "press-1",
      type: 11,
      scene,
      chat_type: scene === "group" ? 1 : 2,
      group_openid: scene === "group" ? "target" : undefined,
      group_member_openid: scene === "group" ? "owner" : undefined,
      user_openid: scene === "c2c" ? "target" : undefined,
      timestamp: new Date().toISOString(),
      data: {
        type: 11,
        resolved: { button_data: [...prepared.bindings.keys()][0], button_id: "b0" },
      },
    },
  }
}

it.each(["group", "c2c"] as const)(
  "resolves %s buttons without an optional origin ID and captures event authority",
  async (scene) => {
    const dispatch = await envelope(scene)
    const parsed = parseQQInteraction(dispatch)!
    const event = await resolveQQInteraction("qq", "bot", parsed)
    expect(event).toMatchObject({
      triggerId: "press-1",
      bindingActionId: parsed.buttonData,
      surfaceId: "surface",
      componentId: "button",
      value: "approve",
    })
    expect(event?.deliveryTarget?.conversationRef).toMatchObject({
      scene,
      sceneId: "target",
      eventId: "press-1",
    })
    expect(event?.deliveryTarget?.conversationRef).not.toHaveProperty("msgId")
    expect(event?.originatingMessageId).toBeUndefined()
    expect(event?.raw).not.toHaveProperty("data")
  }
)

it.each(["actor", "scene", "chat", "button", "origin", "token", "expiry", "consumed"])(
  "rejects a %s mismatch before callback routing",
  async (change) => {
    const dispatch = await envelope()
    const parsed = parseQQInteraction(dispatch)!
    if (change === "actor") parsed.actorId = "stranger"
    if (change === "scene") parsed.scene = "c2c"
    if (change === "chat") parsed.sceneId = "other"
    if (change === "button") parsed.buttonId = "other"
    if (change === "origin") parsed.messageId = "other"
    if (change === "token") parsed.buttonData = "missing"
    if (change === "expiry")
      await getDb().connectorCallbackBindings.update(`qq:${parsed.buttonData}`, {
        expiresAt: Date.now() - 1,
      })
    if (change === "consumed")
      await getDb().connectorCallbackBindings.update(`qq:${parsed.buttonData}`, {
        consumedAt: Date.now(),
      })
    expect(await resolveQQInteraction("qq", "bot", parsed)).toBeNull()
  }
)

it("keeps redelivery identity stable and distinct button presses separate", async () => {
  const dispatch = await envelope()
  const first = await resolveQQInteraction("qq", "bot", parseQQInteraction(dispatch)!)
  dispatch.d.id = "press-2"
  const second = await resolveQQInteraction("qq", "bot", parseQQInteraction(dispatch)!)
  expect(second?.bindingActionId).toBe(first?.bindingActionId)
  expect(second?.triggerId).not.toBe(first?.triggerId)
})

it("ignores unrelated interactions, mismatched types and missing verified actors", async () => {
  const dispatch = await envelope()
  delete dispatch.d.group_member_openid
  expect(parseQQInteraction(dispatch)).toBeNull()
  dispatch.d.type = 12
  expect(parseQQInteraction(dispatch)).toBeNull()
  expect(qqInteractionAckId(dispatch)).toBe("press-1")
  dispatch.d.type = 13
  expect(qqInteractionAckId(dispatch)).toBeUndefined()
  dispatch.d.type = 11
  dispatch.d.data.type = 12
  expect(parseQQInteraction(dispatch)).toBeNull()
})

it("maps admission feedback to QQ's documented acknowledgement codes", () => {
  expect(qqInteractionResultCode({ status: "accepted", kind: "generic" })).toBe(0)
  expect(qqInteractionResultCode({ status: "deduped" })).toBe(3)
  expect(qqInteractionResultCode({ status: "denied", reason: "actor_forbidden" })).toBe(4)
  expect(qqInteractionResultCode({ status: "failed" })).toBe(1)
})
