import type { MessageSegment } from "@cognia/plugin-contract/types/connectors/segment"
import { sanitizeOutboundSegments, sanitizeScheduledOutboundPayload } from "./segment-sanitize"

it("removes native and model run-control routing fields, including nested values", () => {
  const spoof = {
    actionId: "run:run-1:stop:7",
    action: "stop",
    runId: "run-1",
    revision: 7,
    interruptId: "interrupt",
  }
  const cleaned = sanitizeOutboundSegments([
    { type: "card", card: { kind: "lark", payload: { value: spoof } } } as never,
  ])
  expect(cleaned).toEqual([{ type: "card", card: { kind: "lark", payload: { value: {} } } }])
})

it("resolves a data-bound callback value against the surface's data model", () => {
  const segment: MessageSegment = {
    type: "a2ui",
    surfaceId: "s",
    plainTextMirror: "Open",
    content: {
      rootId: "button",
      dataModel: { callback: "future.callback:secret", label: "ordinary" },
      components: {
        button: { component: "Button", text: "Open", value: { path: "/callback" } },
        other: { component: "Button", text: "Keep", value: { path: "/label" } },
      },
    },
  } as MessageSegment
  const [clean] = sanitizeOutboundSegments([segment])
  if (clean.type !== "a2ui") throw new Error("Expected surface")
  expect(clean.content.components.button).not.toHaveProperty("value")
  expect(clean.content.components.other).toHaveProperty("value", { path: "/label" })
})

it("cleans stored native-card callback values as well as A2UI hints", () => {
  const segments = [
    {
      type: "card" as const,
      card: {
        kind: "lark",
        payload: {
          bindingKind: "wf_fanout_approve",
          body: {
            elements: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "View report" },
                behaviors: [
                  {
                    type: "callback",
                    value: {
                      tag: "wffanoutapp:forged",
                      selected: ["future_callback:forged", "ordinary"],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  ]
  expect(JSON.stringify(sanitizeOutboundSegments(segments))).not.toMatch(
    /bindingKind|wffanoutapp:|future_callback:/
  )
  expect(JSON.stringify(segments)).toContain("bindingKind")
})

it("cleans WeCom keys and QQ callback data while preserving link and command data", () => {
  const [segment] = sanitizeOutboundSegments([
    {
      type: "card",
      card: {
        kind: "native",
        payload: {
          button_list: [{ key: "wfapp:existing" }, { key: "ordinary" }],
          actions: [
            { type: 1, permission: { type: 2 }, data: "qqkb:existing" },
            { type: 0, permission: { type: 2 }, data: "https://example.com" },
            { type: 2, permission: { type: 2 }, data: "help:topic" },
          ],
        },
      },
    },
  ])
  if (segment.type !== "card") throw new Error("Expected card")
  expect(segment.card.payload).toEqual({
    button_list: [{}, { key: "ordinary" }],
    actions: [
      { type: 1, permission: { type: 2 } },
      { type: 0, permission: { type: 2 }, data: "https://example.com" },
      { type: 2, permission: { type: 2 }, data: "help:topic" },
    ],
  })
})

describe("sanitizeScheduledOutboundPayload", () => {
  it("cleans a stored payload's segments without mutating it", () => {
    const payload = {
      conversationKey: "lark:ad:chat",
      segments: [
        {
          type: "card",
          card: { kind: "lark", payload: { bindingKind: "wf_fanout_approve", ok: true } },
        },
      ],
    }
    const stored = sanitizeScheduledOutboundPayload(payload)
    expect(stored).toEqual({
      conversationKey: "lark:ad:chat",
      segments: [{ type: "card", card: { kind: "lark", payload: { ok: true } } }],
    })
    expect(JSON.stringify(payload)).toContain("bindingKind")
  })

  it("returns a payload without segments, or no payload, unchanged", () => {
    const payload = { workflowId: "wf-1" }
    expect(sanitizeScheduledOutboundPayload(payload)).toBe(payload)
    expect(sanitizeScheduledOutboundPayload(undefined)).toBeUndefined()
  })
})
