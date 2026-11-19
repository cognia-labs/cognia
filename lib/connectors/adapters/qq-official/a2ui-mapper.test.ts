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

it.each(["group", "c2c"] as const)(
  "preserves automatic %s Table/Chart data with media, keyboards and overflow",
  async (scene) => {
    for (const mode of ["plain", "media", "keyboard", "overflow"] as const) {
      const input = request()
      input.conversationRef.scene = scene
      const actions =
        mode === "keyboard"
          ? ["run"]
          : mode === "overflow"
            ? Array.from({ length: 26 }, (_, i) => `run${i}`)
            : []
      input.segments = [
        buildA2UISegment("data", {
          rootId: "root",
          dataModel: { rows: [{ name: "A", total: 123, private: "hidden-data" }] },
          components: {
            root: { component: "Column", children: ["table", "chart", ...actions] },
            table: {
              component: "Table",
              columns: [
                { key: "name", header: "Name" },
                { key: "total", header: "Total" },
              ],
              data: { path: "/rows" },
            },
            chart: {
              component: "Chart",
              chartType: "bar",
              data: { path: "/rows" },
              xKey: "name",
              yKeys: ["total"],
              clickAction: "never-create-chart-action",
            },
            ...Object.fromEntries(
              actions.map((id) => [id, { component: "Button", text: id, action: id }])
            ),
          },
        }),
        ...(mode === "media"
          ? [{ type: "image" as const, url: "https://example.org/media.png" }]
          : []),
      ]
      const prepared = await prepareQQKeyboards(input)
      const calls = serializeOutboundParts(prepared.request, false)
      const body = JSON.stringify(calls)
      expect(body).toContain("Total: 123")
      expect(body).toContain("total: 123")
      expect(body).not.toContain("hidden-data")
      expect(prepared.bindings.size).toBe(mode === "keyboard" ? 1 : 0)
      expect(calls).toHaveLength(1)
    }
  }
)

it.each(["group", "c2c"] as const)(
  "keeps explicit %s summaries equal to legacy generated text authoritative",
  async (scene) => {
    for (const overflow of [false, true]) {
      const input = request()
      input.conversationRef.scene = scene
      const actions = overflow ? Array.from({ length: 26 }, (_, i) => `run${i}`) : []
      const segment = buildA2UISegment("same-summary", {
        rootId: "root",
        dataModel: {},
        components: {
          root: { component: "Column", children: ["table", ...actions] },
          table: {
            component: "Table",
            columns: [{ key: "raw", header: "Raw" }],
            data: [{ raw: "authored-summary-hidden-detail" }],
          },
          ...Object.fromEntries(
            actions.map((id) => [id, { component: "Button", text: id, action: id }])
          ),
        },
      })
      segment.content.widget = { fallbackText: segment.plainTextMirror }
      input.segments = [segment]
      const prepared = await prepareQQKeyboards(input)
      const body = JSON.stringify(serializeOutboundParts(prepared.request, false))
      expect(body).toContain("[Table]")
      expect(body).not.toContain("authored-summary-hidden-detail")
      expect(prepared.bindings.size).toBe(0)
    }
  }
)

it("keeps authored summaries authoritative even with overflowing data widgets", async () => {
  const input = request()
  const actions = Array.from({ length: 26 }, (_, i) => `run${i}`)
  input.segments = [
    buildA2UISegment("summary", {
      rootId: "root",
      widget: { fallbackText: "Approved aggregate: 42" },
      dataModel: {},
      components: {
        root: { component: "Column", children: ["table", ...actions] },
        table: {
          component: "Table",
          columns: [{ key: "raw", header: "Raw" }],
          data: [{ raw: "unselected-raw-detail" }],
        },
        ...Object.fromEntries(
          actions.map((id) => [id, { component: "Button", text: id, action: id }])
        ),
      },
    }),
  ]
  const prepared = await prepareQQKeyboards(input)
  const body = JSON.stringify(serializeOutboundParts(prepared.request, false))
  expect(body).toContain("Approved aggregate: 42")
  expect(body).not.toContain("unselected-raw-detail")
  expect(prepared.bindings.size).toBe(0)
})

it.each(["Link", "Button"] as const)(
  "keeps disabled %s destinations inert in native, media and overflow projections",
  async (component) => {
    for (const mode of ["native", "media", "overflow"] as const) {
      const input = request()
      const controls = mode === "overflow" ? Array.from({ length: 26 }, (_, i) => `b${i}`) : []
      input.segments = [
        buildA2UISegment("disabled", {
          rootId: "root",
          dataModel: {},
          components: {
            root: { component: "Column", children: ["disabled", ...controls] },
            disabled: {
              component,
              text: "Disabled",
              disabled: true,
              href: "https://example.org/disabled",
              qqCommand: "/disabled-command",
            },
            ...Object.fromEntries(
              controls.map((id) => [id, { component: "Button", text: id, action: id }])
            ),
          },
        }),
        ...(mode === "media"
          ? [{ type: "image" as const, url: "https://example.org/media.png" }]
          : []),
      ]
      const prepared = await prepareQQKeyboards(input)
      const calls = JSON.stringify(serializeOutboundParts(prepared.request, false))
      expect(calls).toContain("Disabled")
      expect(calls).not.toContain("https://example.org/disabled")
      expect(calls).not.toContain("/disabled-command")
    }
  }
)

it.each(["group", "c2c"] as const)(
  "keeps %s action-only cards and unlabeled action links nonempty without restoring blocked URLs",
  async (scene) => {
    for (const component of ["Link", "Card"] as const) {
      const input = request()
      input.conversationRef.scene = scene
      input.segments = [
        buildA2UISegment("action-only", {
          rootId: "root",
          dataModel: {},
          components: {
            root:
              component === "Link"
                ? {
                    component,
                    text: "",
                    action: "approve",
                    href: "https://user:secret@example.org/private",
                  }
                : { component, clickAction: "approve" },
          },
        }),
      ]
      const prepared = await prepareQQKeyboards(input)
      const call = serializeOutboundParts(prepared.request, false)[0]
      expect(call.payload.msg_type).toBe(2)
      expect((call.payload.markdown as { content: string }).content).toContain("approve")
      expect(JSON.stringify(call.payload)).not.toContain("secret")
      expect(JSON.stringify(call.payload)).not.toContain("private")
      expect(prepared.bindings.size).toBe(1)
    }
  }
)

it.each(["group", "c2c"] as const)(
  "does not echo rejected or disabled %s Link resources through generated fallbacks",
  async (scene) => {
    for (const media of [false, true])
      for (const href of [
        "https://127.0.0.1/private",
        "https://user:secret@example.org/private",
        "javascript:alert(1)",
      ]) {
        const input = request()
        input.conversationRef.scene = scene
        input.segments = [
          buildA2UISegment("blocked", {
            rootId: "root",
            dataModel: {},
            components: {
              root: { component: "Card", title: "Safe", children: ["link"] },
              link: { component: "Link", text: "", href },
            },
          }),
          ...(media ? [{ type: "image" as const, url: "https://example.org/media.png" }] : []),
        ]
        const prepared = await prepareQQKeyboards(input)
        expect(JSON.stringify(serializeOutboundParts(prepared.request, false))).not.toContain(href)
      }
    const input = request()
    input.conversationRef.scene = scene
    input.segments = [
      buildA2UISegment("disabled-link", {
        rootId: "link",
        dataModel: {},
        components: {
          link: {
            component: "Link",
            text: "Disabled",
            href: "https://example.org/disabled",
            disabled: true,
          },
        },
      }),
    ]
    const prepared = await prepareQQKeyboards(input)
    expect(
      JSON.stringify(serializeOutboundParts(prepared.request, false)[0].payload)
    ).not.toContain("https://example.org/disabled")
  }
)

it("disambiguates long-vs-short and duplicate short action labels", async () => {
  for (const labels of [
    ["Transfer money to Alice", "1. Transf…"],
    ["Delete", "Delete"],
  ]) {
    const input = request()
    input.segments = [
      buildA2UISegment("collisions", {
        rootId: "root",
        dataModel: {},
        components: {
          root: { component: "Column", children: ["a", "b"] },
          a: { component: "Button", text: labels[0], action: "a" },
          b: { component: "Button", text: labels[1], action: "b" },
        },
      }),
    ]
    const prepared = await prepareQQKeyboards(input)
    const body = serializeOutboundParts(prepared.request, false)[0].payload as {
      keyboard: { content: { rows: { buttons: { render_data: { label: string } }[] }[] } }
    }
    const rendered = body.keyboard.content.rows[0].buttons.map((b) => b.render_data.label)
    expect(new Set(rendered).size).toBe(2)
    expect(rendered[0]).toMatch(/^1\./)
    expect(rendered[1]).toMatch(/^2\./)
  }
})

it("retains titleless Card actions when the generated keyboard overflows", async () => {
  const input = request()
  input.segments = [
    buildA2UISegment("card-overflow", {
      rootId: "root",
      dataModel: {},
      components: Object.fromEntries([
        ["root", { component: "Column", children: Array.from({ length: 26 }, (_, i) => `c${i}`) }],
        ...Array.from({ length: 26 }, (_, i) => [
          `c${i}`,
          { component: "Card", clickAction: `action-${i}` },
        ]),
      ]),
    }),
  ]
  const prepared = await prepareQQKeyboards(input)
  expect(serializeOutboundParts(prepared.request, false)[0].payload.content).toContain("action-25")
  expect(prepared.bindings.size).toBe(0)
})

it.each(["group", "c2c"] as const)(
  "renders %s bound card images and image/link resources with or without buttons",
  async (scene) => {
    for (const button of [false, true]) {
      const input = request()
      input.conversationRef.scene = scene
      input.segments = [
        buildA2UISegment("resources", {
          rootId: "card",
          dataModel: { image: "https://example.org/card(1).png" },
          components: {
            card: {
              component: "Card",
              title: "Report",
              image: { path: "/image" },
              children: ["image", "link", ...(button ? ["go"] : [])],
            },
            image: { component: "Image", src: "https://example.org/chart.png", alt: "Chart [one]" },
            link: {
              component: "Link",
              text: "Read [report]",
              href: "https://example.org/report(1)",
            },
            go: { component: "Button", text: "Next", href: "https://example.org/next" },
          },
        }),
      ]
      const before = JSON.stringify(input)
      const prepared = await prepareQQKeyboards(input)
      const call = serializeOutboundParts(prepared.request, false)[0]
      const body = (call.payload.markdown as { content: string }).content
      expect(body).toContain("https://example.org/card%281%29.png")
      expect(body).toContain("![Chart \\[one\\]](https://example.org/chart.png)")
      expect(body).toContain("[Read \\[report\\]](https://example.org/report%281%29)")
      expect(Boolean(call.payload.keyboard)).toBe(button)
      expect(JSON.stringify(input)).toBe(before)
    }
  }
)

it("preserves resource URLs alongside custom fallback and media captions, but never emits unsafe resource links", async () => {
  const input = request({ href: "https://example.org/next" })
  const surface = {
    rootId: "root",
    dataModel: {},
    widget: { fallbackText: "Revenue: 123" },
    components: {
      root: { component: "Column", children: ["image", "link", "field", "button"] },
      image: { component: "Image", src: "https://example.org/chart.png", alt: "Chart" },
      link: { component: "Link", text: "Report", href: "https://example.org/report" },
      field: { component: "TextField", label: "Name" },
      button: { component: "Button", text: "Next", href: "https://example.org/next" },
    },
  }
  input.segments = [buildA2UISegment("fallback", surface)]
  let prepared = await prepareQQKeyboards(input)
  let body = JSON.stringify(serializeOutboundParts(prepared.request, false)[0].payload)
  expect(body).toContain("Revenue: 123")
  expect(body).toContain("https://example.org/chart.png")
  expect(body).toContain("https://example.org/report")
  for (const src of [
    "https://127.0.0.1/secret",
    "https://user:secret@example.org/private",
    "javascript:alert(1)",
  ]) {
    input.segments = [
      buildA2UISegment("unsafe", {
        rootId: "root",
        dataModel: {},
        components: {
          root: { component: "Card", image: src, children: ["link"] },
          link: { component: "Link", text: "Read", href: src },
        },
      }),
    ]
    prepared = await prepareQQKeyboards(input)
    body = JSON.stringify(serializeOutboundParts(prepared.request, false)[0].payload)
    expect(body).not.toContain(src)
    expect(body).not.toContain("secret")
  }
  input.segments = [
    buildA2UISegment("media", {
      ...surface,
      components: {
        ...surface.components,
        root: { component: "Column", children: ["image", "link"] },
      },
    }),
    { type: "image", url: "https://example.org/attachment.png" },
  ]
  prepared = await prepareQQKeyboards(input)
  expect(serializeOutboundParts(prepared.request, false)).toHaveLength(1)
  expect(serializeOutboundParts(prepared.request, false)[0].payload.content).toContain(
    "https://example.org/chart.png"
  )
})

it("keeps colliding long action labels distinguishable and fully readable", async () => {
  const input = request()
  input.segments = [
    buildA2UISegment("long-labels", {
      rootId: "root",
      dataModel: {},
      components: {
        root: { component: "Column", children: ["alice", "mallory"] },
        alice: { component: "Button", text: "Transfer money to Alice", action: "alice" },
        mallory: { component: "Button", text: "Transfer money to Mallory", action: "mallory" },
      },
    }),
  ]
  const prepared = await prepareQQKeyboards(input)
  const payload = serializeOutboundParts(prepared.request, false)[0].payload as {
    markdown: { content: string }
    keyboard: { content: { rows: { buttons: { render_data: { label: string } }[] }[] } }
  }
  const buttons = payload.keyboard.content.rows[0].buttons
  expect(buttons[0].render_data.label).not.toBe(buttons[1].render_data.label)
  expect(buttons[0].render_data.label).toMatch(/^1\./)
  expect(buttons[1].render_data.label).toMatch(/^2\./)
  expect(buttons.every((b) => [...b.render_data.label].length <= 10)).toBe(true)
  expect(payload.markdown.content).toContain("1\\. Transfer money to Alice")
  expect(payload.markdown.content).toContain("2\\. Transfer money to Mallory")
  expect(prepared.bindings.size).toBe(2)
})

it("keeps oversized keyboards readable without splitting exclusive groups or granting callbacks", async () => {
  const input = request()
  input.segments = [
    buildA2UISegment("overflow", {
      rootId: "root",
      dataModel: {},
      widget: { fallbackText: "Choose an option" },
      components: Object.fromEntries([
        ["root", { component: "Column", children: Array.from({ length: 26 }, (_, i) => `b${i}`) }],
        ...Array.from({ length: 26 }, (_, i) => [
          `b${i}`,
          {
            component: "Button",
            text: `Action ${i}`,
            action: `action-${i}`,
            exclusiveGroup: "one-group",
          },
        ]),
      ]),
    }),
  ]
  const prepared = await prepareQQKeyboards(input)
  const calls = serializeOutboundParts(prepared.request)
  expect(calls).toHaveLength(1)
  expect(calls[0].payload).toMatchObject({
    msg_type: 0,
    content: expect.stringContaining("Choose an option"),
  })
  expect(calls[0].payload.content).toContain("Action 25")
  expect(calls[0].payload).not.toHaveProperty("keyboard")
  expect(prepared.bindings.size).toBe(0)
  expect(calls[0].downgrades).toContainEqual(expect.objectContaining({ from: "a2ui", to: "text" }))
  expect(await getDb().connectorCallbackBindings.count()).toBe(0)
})

it("preserves Link.action and Card.clickAction as callbacks instead of navigation", async () => {
  const input = request()
  input.segments = [
    buildA2UISegment("actions", {
      rootId: "card",
      dataModel: {},
      components: {
        card: {
          component: "Card",
          title: "Report",
          clickAction: "open-report",
          children: ["link"],
        },
        link: {
          component: "Link",
          text: "Run action",
          href: "https://example.org/report",
          action: "run-report",
        },
      },
    }),
  ]
  const prepared = await prepareQQKeyboards(input)
  const call = serializeOutboundParts(prepared.request, false)[0]
  const keyboard = call.payload.keyboard as {
    content: { rows: { buttons: { action: { type: number; data: string } }[] }[] }
  }
  expect(keyboard.content.rows[0].buttons.map((b) => b.action.type)).toEqual([1, 1])
  expect(prepared.bindings.size).toBe(2)
  expect((call.payload.markdown as { content: string }).content).not.toContain(
    "](https://example.org/report)"
  )
  const binding = [...prepared.bindings.values()].find((row) => row.componentId === "link")!
  expect(binding.payload?.qqKeyboard).toMatchObject({
    action: "run-report",
    actionPayload: { href: "https://example.org/report" },
  })
  expect(await getDb().connectorCallbackBindings.count()).toBe(0)
})

it.each(["group", "c2c"] as const)(
  "preserves authoritative fallback content with %s buttons and unsupported widgets",
  async (scene) => {
    const summary = "Revenue: 123 units\n**literal** [report](https://example.org/report)"
    for (const component of ["Table", "Chart"] as const) {
      const input = request({ href: "https://example.org/report" })
      input.conversationRef.scene = scene
      input.segments = [
        buildA2UISegment("report", {
          rootId: "card",
          dataModel: {},
          widget: { fallbackText: summary },
          components: {
            card: { component: "Card", title: "Report", children: ["body", "button"] },
            body: { component, text: "Compact preview", data: [{ revenue: 123 }] },
            button: { component: "Button", text: "Details", href: "https://example.org/report" },
          },
        }),
      ]
      const original = JSON.stringify(input)
      const prepared = await prepareQQKeyboards(input)
      const calls = serializeOutboundParts(prepared.request, false)
      expect(calls).toHaveLength(1)
      expect(calls[0].payload).toMatchObject({
        msg_type: 2,
        markdown: { content: expect.stringContaining("Revenue: 123 units") },
        keyboard: { content: { rows: [{ buttons: [expect.objectContaining({ id: "b0" })] }] } },
      })
      expect((calls[0].payload.markdown as { content: string }).content).toContain(
        "\\*\\*literal\\*\\*"
      )
      expect((calls[0].payload.markdown as { content: string }).content).toContain(
        "https://example.org/report"
      )
      expect(JSON.stringify(input)).toBe(original)
      expect(prepared.bindings.size).toBe(0)
    }
  }
)

it("keeps supported cards semantic when their fallback is intentionally plainer", async () => {
  const input = request()
  input.segments = [
    buildA2UISegment("summary", {
      rootId: "root",
      dataModel: {},
      widget: { fallbackText: "Plain fallback" },
      components: { root: { component: "Text", text: "Report", variant: "heading2" } },
    }),
  ]
  const prepared = await prepareQQKeyboards(input)
  expect(serializeOutboundParts(prepared.request)[0].payload).toMatchObject({
    msg_type: 2,
    markdown: { content: "## Report" },
  })
})

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
