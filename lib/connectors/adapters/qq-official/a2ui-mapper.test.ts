import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { prepareQQKeyboards, recordQQKeyboardReceipts } from "./a2ui-mapper"
import { resolveCallbackBinding, recordCallbackBinding } from "../_shared/a2ui-mapper"
import type { OutboundRequest } from "@/types/connectors/outbound"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function request(raw: Record<string, unknown> = {}): OutboundRequest {
  return {
    conversationRef: {
      platform: "qq-official",
      adapterId: "qq",
      scene: "group",
      sceneId: "chat",
      msgId: "m",
    },
    metadata: { idempotencyKey: "job" },
    segments: [
      {
        type: "a2ui",
        surfaceId: "surface",
        plainTextMirror: "Choose",
        content: {
          rootId: "root",
          dataModel: {},
          components: {
            root: { component: "Column", children: ["btn"] },
            btn: { component: "Button", text: "Approve", action: "approve", ...raw },
          },
        },
      },
    ],
  }
}

it("writes only confirmed parts and keeps author-owned HITL bindings unchanged", async () => {
  await recordCallbackBinding({
    adapterId: "qq",
    actionId: "wfapp:job",
    surfaceId: "surface",
    conversationKey: "qq-official:qq:chat",
    kind: "wf_approve",
    payload: { workflowId: "workflow" },
    actorScope: { mode: "initiator", allowedUserIds: ["owner"] },
  })
  const before = await resolveCallbackBinding("qq", "wfapp:job")
  // A namespaced value is authored by the caller, not replaced by a generic mapping.
  const input = request({ value: "wfapp:job" })
  const prepared = await prepareQQKeyboards(input)
  expect(await getDb().connectorCallbackBindings.count()).toBe(1)
  const card = prepared.request.segments[0]!
  expect(card.type).toBe("card")
  if (card.type !== "card") throw new Error("expected keyboard")
  const keyboard = (card.card.payload as { keyboard: unknown }).keyboard
  await recordQQKeyboardReceipts(prepared.bindings, keyboard, "sent-message")
  expect(await resolveCallbackBinding("qq", before!.actionId)).toEqual(before)
  expect(await getDb().connectorCallbackBindings.count()).toBe(2)
  expect([...prepared.bindings.keys()][0]).toMatch(/^qqkb:/)
})

it("does not persist pending buttons or accept cross-conversation authored bindings", async () => {
  const prepared = await prepareQQKeyboards(request())
  expect(prepared.bindings.size).toBe(1)
  expect(await getDb().connectorCallbackBindings.count()).toBe(0)
  await recordCallbackBinding({
    adapterId: "qq",
    actionId: "wfapp:job",
    surfaceId: "surface",
    conversationKey: "qq-official:qq:other",
    kind: "wf_approve",
  })
  await expect(prepareQQKeyboards(request({ value: "wfapp:job" }))).rejects.toThrow(/conversation/)
})

it("projects link and command buttons without creating callback bindings", async () => {
  for (const raw of [{ href: "https://example.org" }, { qqCommand: "/help" }]) {
    const prepared = await prepareQQKeyboards(request(raw))
    expect(prepared.bindings.size).toBe(0)
  }
})

it("keeps disabled controls and guild surfaces on the text path", async () => {
  const disabled = request({ disabled: true })
  expect((await prepareQQKeyboards(disabled)).request.segments[0]?.type).toBe("a2ui")
  const guild = request()
  guild.conversationRef.scene = "channel"
  expect((await prepareQQKeyboards(guild)).request).toBe(guild)
})
