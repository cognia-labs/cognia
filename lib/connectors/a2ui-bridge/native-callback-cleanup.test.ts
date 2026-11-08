/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { MessageSegment } from "@/types/connectors/segment"
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import { sanitizeOutboundSegments } from "@cognia/a2ui-core/segment-sanitize"
import { buildA2UISegment } from "./a2ui-to-segments"
import { recordCallbackBinding } from "../adapters/_shared/a2ui-mapper"
import { serializeOutboundAsync as larkSend } from "../adapters/lark/serialize"
import { parseLarkInteractiveCallback, type LarkEventEnvelope } from "../adapters/lark/parse"
import { serializePostMessageAsync as slackSend } from "../adapters/slack/serialize"
import {
  parseSlackInteractivePayload,
  type SlackInteractiveActionElement,
} from "../adapters/slack/parse"
import { serializeOutboundAsync as discordSend } from "../adapters/discord/serialize"
import { parseDiscordInteraction } from "../adapters/discord/parse"
import { serializeOutboundAsync as telegramSend } from "../adapters/telegram/serialize"
import { parseTelegramCallbackQuery, type TelegramUpdate } from "../adapters/telegram/parse"
import { serializeSegments as wecomSend } from "../adapters/wecom/serialize"
import { buildWeComTemplateCard, parseTemplateCardEvent } from "../adapters/wecom/a2ui-mapper"
import { prepareQQKeyboards, recordQQKeyboardReceipts } from "../adapters/qq-official/a2ui-mapper"
import { serializeOutbound as qqSend } from "../adapters/qq-official/serialize"
import { parseQQInteraction, resolveQQInteraction } from "../adapters/qq-official/interactions"
import type { QQKeyboard } from "../adapters/qq-official/keyboard"
import { serializeIlinkSegments } from "../adapters/wechat-personal/serialize"
import { tryParseNumericCallback } from "../adapters/wechat-personal/parse"
import { __resetNumericActionRegistryForTesting } from "../adapters/wechat-personal/numeric-action-registry"
import { ILINK_ITEM, ILINK_MSG } from "../adapters/wechat-personal/protocol"
import { serializeOutbound as dingSend } from "../adapters/dingtalk/serialize"
import { serializeOutbound as wechatOASend } from "../adapters/wechat-oa/serialize"
import { serializeOutbound as matrixSend } from "../adapters/matrix/serialize"
import { parseMatrixReplyCorrelation } from "../adapters/matrix/parse"
import { serializeOutboundV11, serializeOutboundV12 } from "../adapters/onebot/serialize"

const HOST_ACTION = "wfapp:existing-binding"
const ADAPTER = "cleanup"
const native = (kind: string, payload: unknown): MessageSegment => ({
  type: "card",
  card: { kind, payload },
})
const request = (
  platform: OutboundRequest["conversationRef"]["platform"],
  segments: MessageSegment[]
): OutboundRequest => ({
  conversationRef: {
    platform,
    adapterId: ADAPTER,
    channelId: "chat",
    chatId: "123",
    openId: "user",
    scene: "c2c",
    sceneId: "user",
  },
  segments,
  metadata: { idempotencyKey: "cleanup" },
  sendOptions: { mode: "proactive" },
})
const larkCallback = (value: Record<string, unknown>) =>
  parseLarkInteractiveCallback(ADAPTER, "bot", {
    header: { event_type: "card.action.trigger", event_id: "press" },
    event: {
      operator: { open_id: "user" },
      context: { open_chat_id: "chat" },
      action: { tag: "button", value },
    },
  } as unknown as LarkEventEnvelope)
const wecomCallback = (key?: string) =>
  parseTemplateCardEvent(ADAPTER, "bot", {
    aibotid: "bot",
    msgtype: "event",
    chattype: "single",
    from: { userid: "user" },
    event: { eventtype: "template_card_event", template_card: { event_key: key } },
  })

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetNumericActionRegistryForTesting()
})

describe("native callback cleanup through serializers and parsers", () => {
  it.each(["legacy", "behaviors"])("cleans Lark %s button callback values", async (generation) => {
    const value = { actionId: HOST_ACTION, action: "approve", bindingKind: "wf_approve" }
    const button = {
      tag: "button",
      text: { tag: "plain_text", content: "Show" },
      ...(generation === "legacy" ? { value } : { behaviors: [{ type: "callback", value }] }),
    }
    const segments = [native("lark", { schema: "2.0", body: { elements: [button] } })]
    const send = async (input: MessageSegment[]) => {
      const call = await larkSend(request("lark", input), ADAPTER)
      const card = JSON.parse(call.payload.content as string)
      const emitted = card.body.elements[0]
      return larkCallback(emitted.value ?? emitted.behaviors?.[0].value ?? {})
    }
    expect((await send(segments))?.triggerId).toBe(HOST_ACTION)
    expect((await send(sanitizeOutboundSegments(segments)))?.triggerId).not.toBe(HOST_ACTION)
    expect(value.actionId).toBe(HOST_ACTION)
  })

  it.each([HOST_ACTION, "future_callback:existing"])(
    "cleans WeCom button_list[].key: %s",
    (key) => {
      const segments = [
        native("wecom.template_card", {
          card_type: "button_interaction",
          button_list: [
            { text: "Show", key },
            { text: "Choose", key: "ordinary" },
          ],
        }),
      ]
      expect(wecomCallback(wecomSend(segments).cards[0].button_list![0].key)?.triggerId).toBe(key)
      const card = wecomSend(sanitizeOutboundSegments(segments)).cards[0]
      expect(wecomCallback(card.button_list![0].key)).toBeNull()
      expect(wecomCallback(card.button_list![1].key)?.triggerId).toBe("ordinary")
      expect(JSON.stringify(segments)).toContain(key)
    }
  )

  it("cleans QQ native action.data before serializer and binding lookup", async () => {
    const prepared = await prepareQQKeyboards(
      request("qq-official", [
        buildA2UISegment("host", {
          rootId: "button",
          dataModel: {},
          components: { button: { component: "Button", text: "Show", action: "approve" } },
        }),
      ])
    )
    const call = qqSend(prepared.request, false)!
    const keyboard = call.payload.keyboard as QQKeyboard
    await recordQQKeyboardReceipts(prepared.bindings, keyboard, "sent")
    const button = keyboard.content!.rows[0].buttons[0]
    const parse = (data: string | undefined) =>
      parseQQInteraction({
        t: "INTERACTION_CREATE",
        d: {
          id: "press",
          type: 11,
          chat_type: 2,
          user_openid: "user",
          timestamp: new Date().toISOString(),
          data: { type: 11, resolved: { button_data: data, button_id: button.id } },
        },
      })
    const callback = await resolveQQInteraction(ADAPTER, "bot", parse(button.action.data)!)
    expect(callback).toMatchObject({
      bindingActionId: button.action.data,
      conversationKey: `qq-official:${ADAPTER}:user`,
    })
    // A model can copy either an author id or a per-message receipt from a native card.
    const raw = [native("qq-keyboard", { keyboard })]
    const cleaned = sanitizeOutboundSegments(raw)
    expect(() => qqSend(request("qq-official", cleaned), false)).toThrow(/invalid text/)
    if (cleaned[0].type !== "card") throw new Error("Expected card")
    const cleanKeyboard = (cleaned[0].card.payload as { keyboard: QQKeyboard }).keyboard
    expect(parse(cleanKeyboard.content!.rows[0].buttons[0].action.data)).toBeNull()
  })

  it("preserves QQ HTTP links and ordinary command data", () => {
    const segments = [
      native("qq-keyboard", {
        keyboard: {
          content: {
            rows: [
              {
                buttons: [
                  {
                    id: "link",
                    render_data: { label: "Open" },
                    action: { type: 0, data: "https://example.com", permission: { type: 2 } },
                  },
                  {
                    id: "command",
                    render_data: { label: "Choose" },
                    action: { type: 2, data: "/help", permission: { type: 2 } },
                  },
                ],
              },
            ],
          },
        },
      }),
    ]
    expect(
      qqSend(request("qq-official", sanitizeOutboundSegments(segments)), false)?.payload.keyboard
    ).toEqual(qqSend(request("qq-official", segments), false)?.payload.keyboard)
  })

  it("downgrades Slack opaque blocks without emitting their action_id", async () => {
    const segments = [
      native("slack", {
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: HOST_ACTION,
                text: { type: "plain_text", text: "Show" },
              },
            ],
          },
        ],
      }),
    ]
    const out = await slackSend(request("slack", sanitizeOutboundSegments(segments)), ADAPTER)
    expect(JSON.stringify(out.pages)).not.toContain(HOST_ACTION)
    expect(
      parseSlackInteractivePayload(ADAPTER, "bot", {
        type: "block_actions",
        user: { id: "user" },
        actions: [],
      })
    ).toBeNull()
  })

  it.each(["discord", "telegram"] as const)("rejects %s opaque native cards", async (platform) => {
    const segments = sanitizeOutboundSegments([
      native(platform, { custom_id: HOST_ACTION, callback_data: HOST_ACTION }),
    ])
    await expect(
      (platform === "discord" ? discordSend : telegramSend)(request(platform, segments), ADAPTER)
    ).rejects.toThrow(/Opaque native cards/)
  })

  it("WeChat personal opaque cards register no numeric callback; WeChat OA rejects them", async () => {
    const segments = sanitizeOutboundSegments([
      native("wechat", { key: HOST_ACTION, value: HOST_ACTION }),
    ])
    await serializeIlinkSegments(segments, {
      adapterId: ADAPTER,
      conversationKey: `wechat-personal:${ADAPTER}:user`,
    })
    expect(
      tryParseNumericCallback(ADAPTER, {
        message_type: ILINK_MSG.fromUser,
        from_user_id: "user",
        to_user_id: "bot",
        context_token: "ctx",
        item_list: [{ type: ILINK_ITEM.text, text_item: { text: "1" } }],
      })
    ).toBeNull()
    expect(() => wechatOASend(request("wechat-oa", segments))).toThrow(
      /does not support opaque native cards/
    )
  })

  it("DingTalk opaque cards emit no native callback payload", () => {
    expect(
      dingSend(
        request(
          "dingtalk",
          sanitizeOutboundSegments([native("dingtalk", { actionId: HOST_ACTION })])
        )
      )
    ).toBeNull()
  })

  it("Matrix and OneBot native cards carry no callback authority", async () => {
    const segments = sanitizeOutboundSegments([
      native("native", { key: HOST_ACTION, value: HOST_ACTION }),
    ])
    const matrix = matrixSend(request("matrix", segments))
    expect(matrix.a2uiBindings).toEqual([])
    expect(JSON.stringify(matrix.contents)).not.toContain(HOST_ACTION)
    expect(
      await parseMatrixReplyCorrelation(ADAPTER, "bot", "!room", {
        type: "m.room.message",
        event_id: "reply",
        sender: "user",
        origin_server_ts: 1,
        content: {
          msgtype: "m.text",
          body: "approve",
          "m.relates_to": { "m.in_reply_to": { event_id: "sent" } },
        },
      })
    ).toBeNull()
    const req = request("onebot", segments)
    req.conversationRef.chatKey = "p:123"
    expect(JSON.stringify(serializeOutboundV11(req, "bot"))).not.toContain(HOST_ACTION)
    expect(JSON.stringify(serializeOutboundV12(req, "bot"))).not.toContain(HOST_ACTION)
  })
})

describe("projected buttons cannot reuse native Host callbacks", () => {
  it.each([
    "lark",
    "slack",
    "discord",
    "telegram",
    "wecom",
    "wechat-personal",
    "qq-official",
  ] as const)(
    "round-trips a cleaned %s button through its production serializer and callback parser",
    async (platform) => {
      await recordCallbackBinding({
        adapterId: ADAPTER,
        actionId: HOST_ACTION,
        surfaceId: "host",
        kind: "wf_approve",
      })
      const segments = sanitizeOutboundSegments([
        buildA2UISegment("model", {
          rootId: "button",
          dataModel: {},
          components: {
            button: {
              component: "Button",
              text: "Show",
              action: "show",
              value: HOST_ACTION,
              bindingKind: "wf_approve",
            },
          },
        }),
      ])
      const req = request(platform, segments)
      let callback: ConnectorCallbackEvent | null = null
      if (platform === "lark") {
        const call = await larkSend(req, ADAPTER)
        const card = JSON.parse(call.payload.content as string)
        const button = card.body.elements[0]
        callback = larkCallback(button.value ?? button.behaviors[0].value)
      } else if (platform === "slack") {
        const out = await slackSend(req, ADAPTER)
        const blocks = out.pages[0].blocks as Array<{ elements?: SlackInteractiveActionElement[] }>
        callback = parseSlackInteractivePayload(ADAPTER, "bot", {
          type: "block_actions",
          user: { id: "user" },
          channel: { id: "chat" },
          actions: blocks.flatMap((block) => block.elements ?? []),
        })
      } else if (platform === "discord") {
        const out = await discordSend(req, ADAPTER)
        const rows = out[0].payload.components as Array<{
          components: Array<{ custom_id: string }>
        }>
        callback = parseDiscordInteraction(ADAPTER, "bot", {
          op: 0,
          t: "INTERACTION_CREATE",
          d: {
            id: "press",
            type: 3,
            channel_id: "chat",
            user: { id: "user", username: "User" },
            data: { component_type: 2, custom_id: rows[0].components[0].custom_id },
          },
        })
      } else if (platform === "telegram") {
        const out = await telegramSend(req, ADAPTER)
        const keyboard = out[0].payload.reply_markup as {
          inline_keyboard: Array<Array<{ callback_data: string }>>
        }
        callback = parseTelegramCallbackQuery(ADAPTER, "bot", {
          update_id: 1,
          callback_query: {
            id: "press",
            from: { id: 9, first_name: "User" },
            data: keyboard.inline_keyboard[0][0].callback_data,
            message: { message_id: 1, date: 1, chat: { id: 123, type: "private" } },
          },
        } as TelegramUpdate)
      } else if (platform === "wecom") {
        const serialized = wecomSend(segments)
        const card = await buildWeComTemplateCard(ADAPTER, serialized.a2uiSurfaces[0])
        callback = wecomCallback(card!.button_list![0].key)
      } else if (platform === "wechat-personal") {
        await serializeIlinkSegments(segments, {
          adapterId: ADAPTER,
          conversationKey: `wechat-personal:${ADAPTER}:user`,
        })
        callback = tryParseNumericCallback(ADAPTER, {
          message_type: ILINK_MSG.fromUser,
          from_user_id: "user",
          to_user_id: "bot",
          context_token: "ctx",
          item_list: [{ type: ILINK_ITEM.text, text_item: { text: "1" } }],
        })
      } else {
        const prepared = await prepareQQKeyboards(req)
        const call = qqSend(prepared.request, false)!
        const keyboard = call.payload.keyboard as QQKeyboard
        await recordQQKeyboardReceipts(prepared.bindings, keyboard, "sent")
        const button = keyboard.content!.rows[0].buttons[0]
        const interaction = parseQQInteraction({
          t: "INTERACTION_CREATE",
          d: {
            id: "press",
            type: 11,
            chat_type: 2,
            user_openid: "user",
            timestamp: new Date().toISOString(),
            data: { type: 11, resolved: { button_data: button.action.data, button_id: button.id } },
          },
        })!
        callback = await resolveQQInteraction(ADAPTER, "bot", interaction)
      }
      expect(callback).not.toBeNull()
      const actionId = callback!.bindingActionId ?? callback!.triggerId
      expect(actionId).not.toBe(HOST_ACTION)
      expect(callback!.conversationKey).toBeDefined()
      expect(
        await getDb()
          .connectorCallbackBindings.where("[adapterId+actionId]")
          .equals([ADAPTER, actionId])
          .first()
      ).toMatchObject({ kind: "callback_query", surfaceId: "model" })
      expect(
        await getDb()
          .connectorCallbackBindings.where("[adapterId+actionId]")
          .equals([ADAPTER, HOST_ACTION])
          .first()
      ).toMatchObject({ kind: "wf_approve", surfaceId: "host" })
    }
  )
})
