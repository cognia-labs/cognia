import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { prepareQQKeyboards, recordQQKeyboardReceipts } from "./a2ui-mapper"
import { resolveCallbackBinding, recordCallbackBinding } from "../_shared/a2ui-mapper"
import type { OutboundRequest } from "@/types/connectors/outbound"
import { buildHelpSurface } from "@/lib/connectors/help/build-help-surface"
import { buildA2UISegment } from "@/lib/connectors/a2ui-bridge/a2ui-to-segments"
import {
  serializeOutbound,
  serializeOutboundParts,
  registerQQPassiveReply,
  __resetQQMsgSeqForTesting,
} from "./serialize"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
beforeEach(__resetQQMsgSeqForTesting)
afterAll(fixture.dispose)

it.each([
  ["group", false],
  ["group", true],
  ["c2c", false],
  ["c2c", true],
] as const)(
  "renders the shared %s welcome as native Markdown (commands: %s)",
  async (scene, commands) => {
    const surface = buildHelpSurface({
      surfaceId: "welcome-test",
      mode: "welcome",
      displayName: "Private configuration name",
      quickCommands: commands
        ? [
            {
              triggerKey: "tasks",
              label: "查看待办",
              action: { type: "prompt", value: "列出待办" },
            },
          ]
        : [],
    })
    const input = request()
    input.conversationRef.scene = scene
    input.segments = [buildA2UISegment("welcome-test", surface)]
    const before = JSON.stringify(input)
    const prepared = await prepareQQKeyboards(input)
    const call = serializeOutbound(prepared.request, false)!
    expect(call.payload).toMatchObject({
      msg_type: 2,
      markdown: { content: expect.stringContaining("## 👋 开始一个新任务\n\n") },
    })
    const markdown = (call.payload.markdown as { content: string }).content
    expect(markdown).toContain("**快捷指令**")
    expect(markdown).not.toContain("Private configuration name")
    expect(markdown).not.toContain("[查看待办]")
    expect(call.payload).not.toHaveProperty("content")
    expect(Boolean(call.payload.keyboard)).toBe(commands)
    expect(prepared.bindings.size).toBe(commands ? 1 : 0)
    expect(await getDb().connectorCallbackBindings.count()).toBe(0)
    expect(JSON.stringify(input)).toBe(before)
  }
)

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

it("projects shared confirmation and exclusive groups into native keyboard policy", async () => {
  const prepared = await prepareQQKeyboards(
    request({
      confirmation: { message: "Continue?", confirmLabel: "Yes", cancelLabel: "No" },
      exclusiveGroup: "decision",
    })
  )
  const card = prepared.request.segments[0]
  expect(card).toMatchObject({
    type: "card",
    card: {
      payload: {
        keyboard: {
          content: {
            rows: [
              {
                buttons: [
                  expect.objectContaining({
                    group_id: "decision",
                    action: expect.objectContaining({
                      modal: { content: "Continue?", confirm_text: "Yes", cancel_text: "No" },
                    }),
                  }),
                ],
              },
            ],
          },
        },
      },
    },
  })
})

it("renders disabled controls as literal text and keeps guild surfaces on their fallback path", async () => {
  const disabled = request({ disabled: true })
  expect((await prepareQQKeyboards(disabled)).request.segments[0]).toEqual({
    type: "markdown",
    md: "\\[Approve\\]",
  })
  const guild = request()
  guild.conversationRef.scene = "channel"
  expect((await prepareQQKeyboards(guild)).request).toBe(guild)
})

it("preserves custom welcome literals, full help content and unsupported widgets", async () => {
  const surface = buildHelpSurface({
    surfaceId: "help-literals",
    mode: "help",
    displayName: "Helper",
    labels: { helpIntro: "你好 *literal* <literal>" },
    quickCommands: [],
    skillFamilies: [{ family: "calendar", mutations: ["read"] }],
  })
  const input = request()
  input.segments = [buildA2UISegment("help-literals", surface)]
  const prepared = await prepareQQKeyboards(input)
  const call = serializeOutbound(prepared.request, false)!
  expect(call.payload).toMatchObject({ msg_type: 2 })
  const markdown = (call.payload.markdown as { content: string }).content
  expect(markdown).toContain("你好 \\*literal\\* \\<literal\\>")
  expect(markdown).toContain("**可用技能**\n\ncalendar")
  const unsupported = request()
  const segment = unsupported.segments[0]
  if (segment.type !== "a2ui") throw new Error("expected surface")
  segment.content.components.btn = { component: "TextField", label: "Name" }
  expect((await prepareQQKeyboards(unsupported)).request.segments[0]).toEqual(segment)
})

it("retains the serializer's conservative broadcast-tag rejection after Markdown projection", async () => {
  const input = request({ disabled: true })
  const segment = input.segments[0]
  if (segment.type !== "a2ui") throw new Error("expected surface")
  segment.content.components.root = { component: "Text", text: "<qqbot-at-everyone />" }
  const prepared = await prepareQQKeyboards(input)
  expect(() => serializeOutbound(prepared.request, false)).toThrow(/structured mention/)
})

it.each([1, 4])(
  "keeps A2UI captions with %s media parts inside the existing passive budget",
  async (count) => {
    const input = request({ disabled: true })
    input.conversationRef.scene = "c2c"
    for (let i = count; i < 4; i++) registerQQPassiveReply("m", `used-${i}`)
    input.segments.push(
      ...Array.from({ length: count }, (_, i) => ({
        type: "image" as const,
        url: `https://example.org/${i}.png`,
      }))
    )
    const prepared = await prepareQQKeyboards(input)
    const calls = serializeOutboundParts(prepared.request)
    expect(calls).toHaveLength(count)
    expect(calls.every((call) => call.payload.msg_type === 7)).toBe(true)
    expect(calls[0].payload.content).toBe("Choose")
    expect(
      calls.some((call) => call.downgrades?.some((d) => d.from === "a2ui" && d.to === "text"))
    ).toBe(true)
  }
)

it("omits native ButtonGroup containers from the Markdown body and retains literal multiline text", async () => {
  const input = request()
  const segment = input.segments[0]
  if (segment.type !== "a2ui") throw new Error("expected surface")
  segment.content.components.root = {
    component: "Card",
    title: "Choose",
    children: ["body", "group"],
  }
  segment.content.components.body = { component: "Text", text: "literal\n---\n\nliteral\n===" }
  segment.content.components.group = { component: "ButtonGroup", children: ["btn"] }
  const prepared = await prepareQQKeyboards(input)
  const call = serializeOutbound(prepared.request, false)!
  const markdown = (call.payload.markdown as { content: string }).content
  expect(markdown).toContain("literal\n\\---\n\nliteral\n\\===")
  expect(markdown).not.toContain("ButtonGroup")
  expect(markdown).not.toContain("Approve")
  expect(prepared.bindings.size).toBe(1)
})
