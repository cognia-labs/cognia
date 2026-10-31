import { assistantReplyToSegments, buildA2UISegment, readA2UISurface } from "./a2ui-to-segments"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import { trackInboxEvent } from "@/lib/telemetry/inbox-events"
import { CALLBACK_PREFIXES } from "@/lib/connectors/hitl/callback-prefixes"
import { buildApprovalSurface } from "./workflow-to-a2ui"
jest.mock("@/lib/telemetry/inbox-events", () => ({ trackInboxEvent: jest.fn() }))

const SURFACE: A2UISegmentContent = {
  components: {
    root: { id: "root", component: "Column", children: ["txt"] },
    txt: { id: "txt", component: "Text", text: "Hi" },
  },
  dataModel: {},
  rootId: "root",
}

const payload = (id = "s1") => ({
  surface: { id, type: "inline" },
  components: Object.values(SURFACE.components),
})
const fence = (value: unknown, language = "a2ui") =>
  `\`\`\`${language}\n${JSON.stringify(value)}\n\`\`\``

describe("buildA2UISegment", () => {
  it("prefers widget.fallbackText when present", () => {
    const seg = buildA2UISegment("s1", {
      ...SURFACE,
      widget: { fallbackText: "User-provided mirror" },
    })
    expect(seg.type).toBe("a2ui")
    expect(seg.surfaceId).toBe("s1")
    expect(seg.plainTextMirror).toBe("User-provided mirror")
  })

  it("falls back to generatePlainTextMirror when widget.fallbackText is empty/missing", () => {
    const seg = buildA2UISegment("s1", SURFACE)
    expect(seg.plainTextMirror).toBe("Hi")
  })

  it("ignores whitespace-only widget.fallbackText", () => {
    const seg = buildA2UISegment("s1", { ...SURFACE, widget: { fallbackText: "   " } })
    expect(seg.plainTextMirror).toBe("Hi")
  })

  it("records generated plain-text mirror downgrades when adapter context is known", () => {
    buildA2UISegment("s1", SURFACE, { adapterId: "adapter-1", platform: "slack" })
    expect(trackInboxEvent).toHaveBeenCalledWith(
      "a2ui.downgrade",
      expect.objectContaining({
        adapterId: "adapter-1",
        fields: expect.objectContaining({ platform: "slack", reason: "missing_fallback_text" }),
      })
    )
  })
})

describe("assistantReplyToSegments", () => {
  it.each(["text", "generic-tool", "wire"])(
    "strips a model-relayed workflow card from %s",
    (source) => {
      const surface = buildApprovalSurface({ bindingId: "relay", workflowName: "Daily" })
      const result = { surfaceId: "workflow:relay", surface }
      const wire = {
        surface: { id: result.surfaceId },
        components: Object.entries(surface.components).map(([id, component]) => ({
          ...(component as object),
          id,
        })),
        dataModel: surface.dataModel,
      }
      const [segment] = assistantReplyToSegments({
        text: source === "generic-tool" ? "" : fence(source === "wire" ? wire : result),
        ...(source === "generic-tool" ? { a2uiSurfaces: { [result.surfaceId]: surface } } : {}),
      })
      if (segment.type !== "a2ui") throw new Error("Missing surface")
      expect(segment.content.components.approve).not.toHaveProperty("value")
      expect(segment.content.components.cancel).not.toHaveProperty("value")
      // The trusted host builder remains usable for direct delivery.
      expect(buildA2UISegment(result.surfaceId, surface).content.components.approve).toHaveProperty(
        "value",
        "wfapp:relay"
      )
    }
  )

  it.each(["future_callback:existing", "help:existing", "issue:existing", "notification:existing"])(
    "strips unknown callback namespaces as well: %s",
    (value) => {
      const surface = {
        rootId: "button",
        components: { button: { component: "Button", value } },
        dataModel: {},
      }
      const [projected] = assistantReplyToSegments({ text: "", a2uiSurfaces: { s: surface } })
      if (projected.type !== "a2ui") throw new Error("Missing surface")
      expect(projected.content.components.button).not.toHaveProperty("value")
      expect(buildA2UISegment("s", surface).content.components.button).toHaveProperty(
        "value",
        value
      )
    }
  )

  it("preserves ordinary button values while dropping host confirmation references", () => {
    const components = {
      root: { component: "Column", children: ["ordinary", "workflow", "host"] },
      ordinary: { component: "Button", value: "choice-1", text: "Choose" },
      workflow: { component: "Button", value: "wfapp:existing-workflow-binding", text: "Review" },
      host: { component: "Button", value: "skill_invoke:skill:nonce", text: "More" },
    }
    const projected = assistantReplyToSegments({
      text: "",
      a2uiSurfaces: { s1: { rootId: "root", components, dataModel: {} } },
    })[0]
    if (projected.type !== "a2ui") throw new Error("Missing surface")
    expect(projected.content.components.ordinary).toHaveProperty("value", "choice-1")
    expect(projected.content.components.workflow).not.toHaveProperty("value")
    expect(projected.content.components.host).not.toHaveProperty("value")
    expect(components.host.value).toBe("skill_invoke:skill:nonce")
  })

  it.each(
    CALLBACK_PREFIXES.flatMap((prefix) =>
      [false, true].flatMap((bound) =>
        ["text", "generic-tool"].map((source) => ({ prefix, bound, source }))
      )
    )
  )("strips every host callback namespace: %j", ({ prefix, bound, source }) => {
    const components = {
      root: {
        id: "root",
        component: "Button",
        text: "View details",
        value: bound ? { path: "/callback" } : `${prefix}pending`,
      },
    }
    const dataModel = { callback: `${prefix}pending` }
    const projected = assistantReplyToSegments(
      source === "text"
        ? {
            text: fence({
              surface: { id: "s1" },
              components: Object.values(components),
              dataModel,
            }),
          }
        : { text: "", a2uiSurfaces: { s1: { rootId: "root", components, dataModel } } }
    )[0]
    if (projected.type !== "a2ui") throw new Error("Missing surface")
    expect(projected.content.components.root).not.toHaveProperty("value")
    expect(components.root).toHaveProperty("value")
  })

  it("strips all current and future binding hints even from unreachable components", () => {
    const components = {
      ...SURFACE.components,
      hidden: { component: "Button", bindingKind: "skill_invoke", bindingFuture: true },
    }
    const projected = assistantReplyToSegments({
      text: "",
      a2uiSurfaces: { s1: { ...SURFACE, components } },
    })[0]
    expect(projected).toMatchObject({
      type: "a2ui",
      content: { components: { hidden: { component: "Button" } } },
    })
    if (projected.type !== "a2ui") throw new Error("Missing surface")
    expect(projected.content.components.hidden).not.toHaveProperty("bindingFuture")
    expect(components.hidden.bindingKind).toBe("skill_invoke")
  })

  it.each(["a2ui", "A2UI", "json", ""])("extracts %s fences", (language) => {
    expect(assistantReplyToSegments({ text: fence(payload(), language) })[0]).toMatchObject({
      type: "a2ui",
      surfaceId: "s1",
      content: SURFACE,
    })
  })

  it("extracts raw JSON and uses a non-root first component", () => {
    const out = assistantReplyToSegments({
      text: JSON.stringify({
        ...payload(),
        components: [{ id: "title", component: "Text", text: "hello" }],
      }),
    })
    expect(out[0]).toMatchObject({ type: "a2ui", content: { rootId: "title" } })
  })

  it("preserves widget metadata and its explicit fallback", () => {
    const value = payload()
    const out = assistantReplyToSegments({
      text: fence({
        ...value,
        surface: { ...value.surface, widget: { fallbackText: "Accessible overview" } },
      }),
    })
    expect(out[0]).toMatchObject({
      type: "a2ui",
      plainTextMirror: "Accessible overview",
      content: { widget: { fallbackText: "Accessible overview" } },
    })
  })

  it("preserves unrelated fences and prose around multiple surfaces", () => {
    const prefix = `${fence({ example: true }, "json")}\n${fence(payload(), "typescript")}\n`
    const out = assistantReplyToSegments({
      text: `${prefix}${fence(payload())}\nBetween\n${fence(payload("s2"))}\nEnd`,
    })
    expect(out.map((s) => s.type)).toEqual(["markdown", "a2ui", "markdown", "a2ui", "markdown"])
    expect(out[0]).toEqual({ type: "markdown", md: prefix })
    expect(out[2]).toEqual({ type: "markdown", md: "\nBetween\n" })
    expect(out[4]).toEqual({ type: "markdown", md: "\nEnd" })
  })

  it("keeps the tool snapshot authoritative without printing duplicate JSON", () => {
    const out = assistantReplyToSegments({
      text: fence(payload()),
      a2uiSurfaces: { s1: SURFACE },
    })
    expect(out).toEqual([buildA2UISegment("s1", SURFACE)])
  })

  it("reduces protocol updates, merges data, replaces data, and drops deleted surfaces", () => {
    const out = assistantReplyToSegments({
      text: fence([
        { type: "createSurface", surfaceId: "s1", title: "Survey", surfaceType: "panel" },
        {
          type: "updateComponents",
          surfaceId: "s1",
          components: Object.values(SURFACE.components),
        },
        { type: "dataModelUpdate", surfaceId: "s1", data: { stale: true } },
        {
          type: "dataModelUpdate",
          surfaceId: "s1",
          data: { person: { name: "Ada" } },
          merge: false,
        },
        { type: "dataModelUpdate", surfaceId: "s1", data: { person: { age: 30 } } },
        { type: "surfaceReady", surfaceId: "s1" },
        { type: "createSurface", surfaceId: "deleted" },
        { type: "deleteSurface", surfaceId: "deleted" },
      ]),
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: "a2ui",
      content: { title: "Survey", dataModel: { person: { name: "Ada", age: 30 } } },
    })
    expect((out[0] as { content: A2UISegmentContent }).content.dataModel).not.toHaveProperty(
      "stale"
    )
  })

  it("projects computed values into the card data (ADR-0240)", () => {
    const out = assistantReplyToSegments({
      text: fence([
        {
          type: "createSurface",
          surfaceId: "s1",
          surfaceType: "inline",
          computed: { "/total": { op: "add", args: [{ path: "/a" }, { path: "/b" }] } },
        },
        {
          type: "updateComponents",
          surfaceId: "s1",
          components: [{ id: "root", component: "Text", text: { path: "/total" } }],
        },
        { type: "dataModelUpdate", surfaceId: "s1", data: { a: 2, b: 3 } },
        {
          type: "dataModelUpdate",
          surfaceId: "s1",
          data: {},
          computed: { "/double": { op: "multiply", args: [{ path: "/total" }, 2] } },
        },
      ]),
    })
    expect((out[0] as { content: A2UISegmentContent }).content.dataModel).toEqual({
      a: 2,
      b: 3,
      total: 5,
      double: 10,
    })
  })

  it("supports implicit surfaces from protocol component and data updates", () => {
    const out = assistantReplyToSegments({
      text: fence([
        { type: "dataModelUpdate", surfaceId: "s1", data: { title: "Bound" } },
        {
          type: "updateComponents",
          surfaceId: "s1",
          components: [{ id: "label", component: "Text", text: { path: "/title" } }],
        },
      ]),
    })
    expect(out[0]).toMatchObject({
      type: "a2ui",
      content: { rootId: "label", dataModel: { title: "Bound" } },
    })
  })

  it.each([
    "```a2ui\n{broken}\n```",
    '```a2ui\n{"surface":',
    fence({ unrelated: true }),
    fence({ ...payload(), components: [] }),
    fence({ ...payload(), components: [null] }),
    fence({ ...payload(), components: [{ id: 1, component: "Text" }] }),
    fence({ ...payload(), components: [{ id: "__proto__", component: "Text" }] }),
    fence({ ...payload(), components: [{ id: "x" }] }),
    fence({
      ...payload(),
      components: [{ id: "root", component: "Column", children: ["missing"] }],
    }),
    fence({ ...payload(), components: [{ id: "root", component: "Column", children: ["root"] }] }),
    fence([{ type: "updateComponents", surfaceId: 123, components: [] }]),
    fence([{ type: "deleteSurface", surfaceId: "s1" }]),
    fence([{ type: "dataModelUpdate", surfaceId: "s1", data: [] }]),
    fence([{ type: "createSurface", surfaceId: "s1" }, { type: "unknown" }]),
  ])("preserves invalid or incomplete content: %s", (text) => {
    expect(assistantReplyToSegments({ text })).toEqual([{ type: "markdown", md: text }])
  })

  it("projects the fenced simplified A2UI reply from Feishu instead of sending its JSON", () => {
    const payload = {
      surface: { id: "cognia-analysis", type: "inline", title: "Cognia Next 分析" },
      components: Object.values(SURFACE.components),
    }
    const out = assistantReplyToSegments({
      text: `项目速览：\n\n\`\`\`a2ui\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n分析完成。`,
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    expect(out.map((segment) => segment.type)).toEqual(["markdown", "a2ui", "markdown"])
    expect(out[1]).toMatchObject({
      surfaceId: "cognia-analysis",
      content: { ...SURFACE, title: "Cognia Next 分析", surfaceType: "inline" },
      plainTextMirror: "Hi",
    })
    expect(JSON.stringify(out)).not.toContain("```a2ui")
  })

  it("emits surfaces in surfaceOrder ahead of trailing markdown", () => {
    const out = assistantReplyToSegments({
      text: "Look at the card above.",
      a2uiSurfaces: { s1: SURFACE, s2: SURFACE },
      a2uiSurfaceOrder: ["s1", "s2"],
    })
    expect(out.map((s) => s.type)).toEqual(["a2ui", "a2ui", "markdown"])
    expect((out[0] as { surfaceId: string }).surfaceId).toBe("s1")
    expect((out[1] as { surfaceId: string }).surfaceId).toBe("s2")
  })

  it("uses object key order when surfaceOrder is omitted", () => {
    const out = assistantReplyToSegments({
      text: "x",
      a2uiSurfaces: { s1: SURFACE, s2: SURFACE },
    })
    expect(
      out.filter((s) => s.type === "a2ui").map((s) => (s as { surfaceId: string }).surfaceId)
    ).toEqual(["s1", "s2"])
  })

  it("omits the markdown segment when reply text is empty", () => {
    const out = assistantReplyToSegments({
      text: "",
      a2uiSurfaces: { s1: SURFACE },
      a2uiSurfaceOrder: ["s1"],
    })
    expect(out.map((s) => s.type)).toEqual(["a2ui"])
  })

  it("returns a single empty text segment when reply is empty and has no surfaces", () => {
    expect(assistantReplyToSegments({ text: "" })).toEqual([{ type: "text", text: "" }])
  })

  it("preserves trailing whitespace in markdown unless it is the whole reply", () => {
    const out = assistantReplyToSegments({
      text: "Header\n\nBody\n",
    })
    expect(out).toEqual([{ type: "markdown", md: "Header\n\nBody\n" }])
  })

  it("skips surfaceOrder entries that are missing from a2uiSurfaces", () => {
    const out = assistantReplyToSegments({
      text: "x",
      a2uiSurfaces: { s1: SURFACE },
      a2uiSurfaceOrder: ["missing", "s1"],
    })
    expect(out.filter((s) => s.type === "a2ui")).toHaveLength(1)
  })
})

describe("host/plugin surface envelopes", () => {
  const envelope = { surfaceId: "host:surface", surface: SURFACE }
  it("accepts the direct and wrapped content shapes", () => {
    expect(readA2UISurface(envelope)).toEqual({ surfaceId: envelope.surfaceId, content: SURFACE })
    expect(readA2UISurface({ surfaceId: envelope.surfaceId, ...SURFACE })).toEqual({
      surfaceId: envelope.surfaceId,
      content: SURFACE,
    })
  })
  it.each([
    null,
    [],
    { ...envelope, surfaceId: "" },
    { ...envelope, surfaceId: "__proto__" },
    { ...envelope, surfaceId: "a2ui-preview:test" },
    ...[
      { rootId: "missing" },
      { rootId: 1 },
      { components: [] },
      { dataModel: [] },
      { surfaceType: "unknown" },
      { title: 1 },
      { catalogId: false },
      { widget: [] },
      { computed: [] },
      { components: { root: { component: "Column", children: ["missing"] } } },
      { components: { root: { component: "Column", children: ["root"] } } },
      { components: { root: { id: "mismatch", component: "Text" } } },
      { components: { root: { component: "" } } },
      { components: { root: null } },
    ].map((patch) => ({ ...envelope, surface: { ...SURFACE, ...patch } })),
  ])("rejects an invalid host envelope: %j", (input) => {
    expect(readA2UISurface(input)).toBeNull()
  })
})
