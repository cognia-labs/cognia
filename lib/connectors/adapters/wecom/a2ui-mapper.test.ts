/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  buildWeComTemplateCard,
  parseTemplateCardEvent,
  parseActionId,
  buildAckUpdateCard,
} from "./a2ui-mapper"
import type { A2UIMessageSegment } from "@/types/connectors/segment"
import type { WeComInboundEventBody } from "./protocol"
import { parseWeComMessage } from "./parse"
import { authorizeConnectorCallback } from "@/lib/connectors/callback-authorization"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

function surface(): A2UIMessageSegment {
  return {
    type: "a2ui",
    surfaceId: "sfc1",
    content: {
      rootId: "root",
      dataModel: {},
      components: {
        root: { id: "root", component: "Card", title: "Pick one", children: ["b1", "b2"] },
        b1: { id: "b1", component: "Button", text: "Yes", action: "approve" },
        b2: { id: "b2", component: "Button", text: "No", action: "reject" },
      },
    },
    plainTextMirror: "Pick one [Yes] [No]",
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("buildWeComTemplateCard", () => {
  it("maps Card + Buttons to a button_interaction card and records bindings", async () => {
    const card = await buildWeComTemplateCard("adp", surface(), "wecom:adp:c1")
    expect(card).not.toBeNull()
    expect(card!.card_type).toBe("button_interaction")
    expect(card!.main_title?.title).toBe("Pick one")
    expect(card!.button_list).toEqual([
      { key: "a2ui:sfc1:b1:approve", text: "Yes", style: 1 },
      { key: "a2ui:sfc1:b2:reject", text: "No", style: 1 },
    ])

    const bindings = await getDb().connectorCallbackBindings.toArray()
    expect(bindings).toHaveLength(2)
    expect(bindings[0]).toMatchObject({
      adapterId: "adp",
      surfaceId: "sfc1",
      conversationKey: "wecom:adp:c1",
    })
  })

  it("preserves canonical Alert.message in the native card description", async () => {
    const seg = surface()
    seg.content.components.root = { component: "Column", children: ["alert", "b1"] }
    seg.content.components.alert = {
      component: "Alert",
      title: "Warning",
      message: "Action required",
    }
    const card = await buildWeComTemplateCard("adp", seg)
    expect(card?.main_title?.desc).toBe("Warning: Action required")
  })

  it("returns null for a surface with no buttons", async () => {
    const noButtons: A2UIMessageSegment = {
      type: "a2ui",
      surfaceId: "s2",
      content: {
        rootId: "root",
        dataModel: {},
        components: { root: { id: "root", component: "Text", text: "just text" } },
      },
      plainTextMirror: "just text",
    }
    expect(await buildWeComTemplateCard("adp", noButtons)).toBeNull()
  })
})

describe("parseActionId", () => {
  it("splits the namespaced action id", () => {
    expect(parseActionId("a2ui:sfc1:b1:approve")).toEqual({
      surfaceId: "sfc1",
      componentId: "b1",
      action: "approve",
    })
  })
  it("returns null for non-a2ui ids", () => {
    expect(parseActionId("random")).toBeNull()
  })
})

describe("parseTemplateCardEvent", () => {
  it("authorizes a private approval without chatid using the inbound sender address", async () => {
    const conversationKey = parseWeComMessage("adp", "self", {
      aibotid: "self",
      msgid: "inbound",
      chattype: "single",
      from: { userid: "u_alice" },
      msgtype: "text",
      text: { content: "Run workflow" },
    })!.conversationKey
    await recordCallbackBinding({
      adapterId: "adp",
      actionId: "wfapp:private",
      surfaceId: "approval",
      kind: "wf_approve",
      conversationKey,
      actorScope: { mode: "initiator", allowedUserIds: ["u_alice"] },
      allowedActions: ["approve"],
    })
    const binding = (await getDb().connectorCallbackBindings.toArray())[0]
    const callback = parseTemplateCardEvent("adp", "self", {
      aibotid: "self",
      chattype: "single",
      from: { userid: "u_alice" },
      msgtype: "event",
      event: { eventtype: "template_card_event", template_card: { event_key: binding.actionId } },
    })!
    const adapter: AdapterInstanceRow = {
      id: "adp",
      type: "wecom",
      displayName: "WeCom",
      enabled: true,
      transportMode: "gateway",
      settings: { larkStrictCallbackAuthorization: "enforce" },
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      createdAt: 1,
      updatedAt: 1,
    }
    expect(callback.conversationKey).toBe(conversationKey)
    expect(
      await authorizeConnectorCallback({
        event: callback,
        adapterRow: adapter,
        binding,
        kindClass: "wf_approve",
        resolvedConversationKey: conversationKey,
      })
    ).toMatchObject({ allowed: true, mode: "enforce" })
    expect(
      await authorizeConnectorCallback({
        event: { ...callback, conversationKey: "wecom:adp:other" },
        adapterRow: adapter,
        binding,
        kindClass: "wf_approve",
        resolvedConversationKey: conversationKey,
      })
    ).toMatchObject({ allowed: false, reason: "conversation_mismatch" })
  })

  it.each(["group", undefined] as const)(
    "does not infer a missing %s chat from its sender",
    (chattype) => {
      expect(
        parseTemplateCardEvent("adp", "self", {
          ...event("wfapp:private"),
          chatid: undefined,
          chattype,
        })?.conversationKey
      ).toBeUndefined()
    }
  )

  function event(eventKey?: string): WeComInboundEventBody {
    return {
      aibotid: "self",
      chatid: "c1",
      from: { userid: "u_alice", name: "Alice" },
      msgtype: "event",
      event: { eventtype: "template_card_event", template_card: { event_key: eventKey } },
    }
  }

  it("projects a card click into a ConnectorCallbackEvent (triggerId = action id)", () => {
    const cb = parseTemplateCardEvent("adp", "self", event("a2ui:sfc1:b1:approve"), 999)
    expect(cb).not.toBeNull()
    expect(cb).toMatchObject({
      platform: "wecom",
      adapterId: "adp",
      triggerId: "a2ui:sfc1:b1:approve",
      surfaceId: "sfc1",
      componentId: "b1",
      actionType: "button",
      value: "approve",
      conversationKey: "wecom:adp:c1",
      timestamp: 999,
    })
    expect(cb!.user.remoteUserId).toBe("u_alice")
  })

  it("returns null when the event key is missing", () => {
    expect(parseTemplateCardEvent("adp", "self", event(undefined))).toBeNull()
  })

  it("returns null for non-card events", () => {
    const enter: WeComInboundEventBody = {
      aibotid: "self",
      msgtype: "event",
      event: { eventtype: "enter_chat" },
    }
    expect(parseTemplateCardEvent("adp", "self", enter)).toBeNull()
  })
})

describe("buildAckUpdateCard", () => {
  it("preserves the task_id and sets the ack text", () => {
    const body: WeComInboundEventBody = {
      aibotid: "self",
      msgtype: "event",
      event: { eventtype: "template_card_event", template_card: { task_id: "t9" } },
    }
    const card = buildAckUpdateCard(body, "✓")
    expect(card.task_id).toBe("t9")
    expect(card.main_title?.title).toBe("✓")
  })
})

it.each(["tapa:request", "tapd:request", "wffanoutapp:request", "skill_invoke:skill:request"])(
  "reuses %s and keeps its verb on inbound callbacks",
  async (actionId) => {
    const seg = surface()
    seg.content.rootId = "b1"
    seg.content.components.b1 = {
      component: "Button",
      text: "Decide",
      action: "approve",
      value: actionId,
    }
    await recordCallbackBinding({
      adapterId: "adp",
      actionId,
      surfaceId: seg.surfaceId,
      kind: "tool_approve",
    })
    const before = await getDb().connectorCallbackBindings.toArray()
    const card = await buildWeComTemplateCard("adp", seg)
    expect(card!.button_list![0].key).toBe(actionId)
    const callback = parseTemplateCardEvent("adp", "bot", {
      event: {
        eventtype: "template_card_event",
        template_card: { event_key: card!.button_list![0].key },
      },
      from: { userid: "user" },
      chatid: "chat",
    } as WeComInboundEventBody)
    expect(callback).toMatchObject({
      triggerId: actionId,
      value: actionId.startsWith("tapd:") ? "cancel" : "approve",
    })
    expect(await getDb().connectorCallbackBindings.toArray()).toEqual(before)
  }
)
