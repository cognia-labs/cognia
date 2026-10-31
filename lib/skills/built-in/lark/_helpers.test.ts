import { z } from "zod"
import { getSharedBuiltInSkillRegistry } from "../registry"
import { resolveLarkAdapter } from "./auth-bridge"
import {
  argsToFlags,
  buildConfirmSurface,
  capLarkData,
  larkAdapterIdFromCtx,
  MAX_RESULT_DISPLAY_CHARS,
  registerLarkSkill,
  runLarkCli,
} from "./_helpers"
import "./calendar"
import "./doc"
import "./base"
import "./sheets"
import "./task"
import "./wiki"

jest.mock("./_helpers", () => ({
  ...jest.requireActual("./_helpers"),
  runLarkCli: jest.fn(),
}))
jest.mock("./auth-bridge", () => ({
  ...jest.requireActual("./auth-bridge"),
  resolveLarkAdapter: jest.fn(),
}))

const runMock = runLarkCli as jest.Mock
const resolveAdapterMock = resolveLarkAdapter as jest.Mock

beforeEach(() => {
  runMock.mockReset()
  resolveAdapterMock.mockReset().mockResolvedValue({
    ok: true,
    adapter: { id: "cai_school", displayName: "School club" },
  })
})

describe("Lark account routing", () => {
  it("exposes optional connection selection on every Lark skill", () => {
    const skills = getSharedBuiltInSkillRegistry()
      .list()
      .filter((skill) => skill.family.startsWith("lark."))
    expect(skills).toHaveLength(43)
    for (const skill of skills) {
      const schema = z.toJSONSchema(skill.inputSchema)
      expect(schema.properties?.adapterId).toEqual(
        expect.objectContaining({ type: "string", minLength: 1 })
      )
      expect(schema.required ?? []).not.toContain("adapterId")
    }
  })

  it.each([
    ["lark.calendar.agenda_today", {}],
    ["lark.doc.fetch", { docToken: "doc_1" }],
    ["lark.base.list_tables", { appToken: "app_1" }],
    ["lark.sheets.list_sheets", { spreadsheetToken: "sheet_1" }],
    ["lark.task.get_task", { taskGuid: "task_1" }],
    ["lark.wiki.read_node", { spaceId: "space_1", nodeToken: "wiki_1" }],
  ])("routes %s through the selected connection without a CLI flag", async (id, input) => {
    const skill = getSharedBuiltInSkillRegistry().get(id as string)!
    const args = skill.inputSchema.parse({ ...input, adapterId: "cai_school" })
    const context = { sessionId: "desktop" }

    await skill.execute(args, context)

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "cai_school",
        context: { sessionId: "desktop", larkAdapterId: "cai_school" },
      })
    )
    expect(runMock.mock.calls[0][0].args).not.toContain("--adapter-id")
    expect(runMock.mock.calls[0][0].args).not.toContain("cai_school")
    expect(context).toEqual({ sessionId: "desktop" })
  })

  it("preserves strict inputs and document operation refinements", () => {
    const registry = getSharedBuiltInSkillRegistry()
    expect(
      registry.get("lark.calendar.agenda_today")!.inputSchema.safeParse({
        adapterId: "cai_school",
        unexpected: true,
      }).success
    ).toBe(false)
    for (const [id, input] of [
      ["lark.doc.fetch", { docToken: "doc_1", mode: "section" }],
      ["lark.doc.fetch", { docToken: "doc_1", mode: "keyword" }],
      ["lark.doc.update", { docToken: "doc_1", operation: "append" }],
      ["lark.doc.update", { docToken: "doc_1", operation: "block_move_after", anchor: "blk_1" }],
    ] as const) {
      expect(
        registry.get(id)!.inputSchema.safeParse({ ...input, adapterId: "cai_school" }).success
      ).toBe(false)
    }
  })

  it("keeps the explicit connection visible and retains it through confirmation replay", async () => {
    const skill = getSharedBuiltInSkillRegistry().get("lark.doc.update")!
    const args = skill.inputSchema.parse({
      docToken: "doc_1",
      operation: "append",
      payload: "<p>Approved change</p>",
      adapterId: "cai_school",
    })
    const surface = skill.hitlSurface!(args)
    expect(JSON.stringify(surface)).toContain("cai_school")

    const replay = skill.inputSchema.parse(JSON.parse(JSON.stringify(args)))
    await skill.execute(replay, { sessionId: "desktop", humanConfirmed: true })
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "cai_school" }))
    expect(runMock.mock.calls[0][0].args).not.toContain("--adapter-id")
  })

  it("pins an automatically selected connection before building the confirmation card", async () => {
    const skill = getSharedBuiltInSkillRegistry().get("lark.doc.update")!
    const args = skill.inputSchema.parse({
      docToken: "doc_1",
      operation: "append",
      payload: "<p>Approved change</p>",
    })
    const context = { sessionId: "desktop" }
    expect(skill.preflight).toEqual(expect.any(Function))
    await skill.preflight!(args, context)
    expect(resolveAdapterMock).toHaveBeenCalledWith({ adapterId: undefined, context })
    expect(args).toMatchObject({ adapterId: "cai_school" })
    expect(JSON.stringify(skill.hitlSurface!(args))).toContain("School club")
    expect(JSON.stringify(skill.hitlSurface!(args))).toContain("cai_school")

    resolveAdapterMock.mockResolvedValue({ ok: true, adapter: { id: "cai_other" } })
    const replay = skill.inputSchema.parse(JSON.parse(JSON.stringify(args)))
    await skill.execute(replay, { sessionId: "desktop", humanConfirmed: true })
    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "cai_school" }))
  })

  it.each(["Multiple Lark connections require a choice", "IM account cannot be redirected"])(
    "refuses account selection before confirmation: %s",
    async (message) => {
      resolveAdapterMock.mockResolvedValue({ ok: false, reason: "ambiguous_adapter", message })
      const skill = getSharedBuiltInSkillRegistry().get("lark.doc.update")!
      const args = skill.inputSchema.parse({
        docToken: "doc_1",
        operation: "append",
        payload: "<p>change</p>",
      })
      expect(skill.preflight).toEqual(expect.any(Function))
      await expect(skill.preflight!(args, { sessionId: "desktop" })).rejects.toThrow(message)
      expect(runMock).not.toHaveBeenCalled()
    }
  )

  it("retains the original preflight and its normalized arguments without sharing context", async () => {
    const execute = jest.fn(async () => ({ done: true }))
    const preflight = jest.fn(async (args: { value: number }) => {
      args.value += 2
    })
    const schema = z
      .object({ value: z.number().int() })
      .strict()
      .superRefine((args, ctx) => {
        if (args.value % 2 !== 0) ctx.addIssue({ code: "custom", message: "Use an even value" })
      })
    registerLarkSkill({
      id: "lark.test.route",
      family: "lark.test",
      label: { en: "Test route", "zh-CN": "测试路由" },
      description: { en: "Test routing", "zh-CN": "测试路由" },
      platforms: ["lark"],
      mutation: "read",
      imAccess: "always",
      mcpToolName: "lark_test_route",
      inputSchema: schema,
      execute,
      preflight,
    })
    const registry = getSharedBuiltInSkillRegistry()
    try {
      const skill = registry.get("lark.test.route")!
      expect(skill.inputSchema.safeParse({ value: 3, adapterId: "cai_school" }).success).toBe(false)
      const args = skill.inputSchema.parse({ value: 2, adapterId: "  cai_school  " })
      const context = { sessionId: "desktop" }
      await skill.preflight!(args, context)
      expect(preflight).toHaveBeenCalledWith(
        { value: 4 },
        { sessionId: "desktop", larkAdapterId: "cai_school" }
      )
      expect(args).toEqual({ value: 4, adapterId: "cai_school" })
      await skill.execute(args, context)
      expect(execute).toHaveBeenCalledWith(
        { value: 4 },
        { sessionId: "desktop", larkAdapterId: "cai_school" }
      )
      expect(context).toEqual({ sessionId: "desktop" })
      expect(schema.safeParse({ value: 2, adapterId: "cai_school" }).success).toBe(false)
    } finally {
      registry.unregister("lark.test.route")
    }
  })
})

describe("larkAdapterIdFromCtx", () => {
  it("carries an explicit route separately so the auth bridge can check it", () => {
    expect(
      larkAdapterIdFromCtx({
        sessionId: "desktop",
        larkAdapterId: "cai_school",
      })
    ).toBe("cai_school")
    expect(
      larkAdapterIdFromCtx({
        sessionId: "im",
        larkAdapterId: "cai_school",
        imBinding: { adapterId: "cai_work", platform: "lark", conversationKey: "oc_1" },
      })
    ).toBe("cai_school")
  })
  it("returns the bound adapter id for Lark-bound sessions", () => {
    expect(
      larkAdapterIdFromCtx({
        sessionId: "s1",
        imBinding: { adapterId: "cai_a", platform: "lark", conversationKey: "oc_1" },
      })
    ).toBe("cai_a")
  })

  it("returns undefined for in-app sessions and non-Lark bindings", () => {
    expect(larkAdapterIdFromCtx({ sessionId: "s1" })).toBeUndefined()
    expect(
      larkAdapterIdFromCtx({
        sessionId: "s1",
        imBinding: { adapterId: "cai_b", platform: "slack", conversationKey: "C1" },
      })
    ).toBeUndefined()
  })
})

describe("argsToFlags", () => {
  it("kebab-cases keys and stringifies scalar values", () => {
    expect(argsToFlags({ calendarId: "primary", pageSize: 50 })).toEqual([
      "--calendar-id",
      "primary",
      "--page-size",
      "50",
    ])
  })

  it("emits a bare flag for true booleans and omits false/undefined/null", () => {
    expect(argsToFlags({ notifyAttendees: true, dryRun: false, note: undefined, x: null })).toEqual(
      ["--notify-attendees"]
    )
  })

  it("repeats the flag for each array element and JSON-encodes objects", () => {
    expect(argsToFlags({ assignees: ["a", "b"] })).toEqual(["--assignees", "a", "--assignees", "b"])
    expect(argsToFlags({ fields: { Name: "Acme" } })).toEqual(["--fields", '{"Name":"Acme"}'])
  })

  it("skips the listed keys", () => {
    expect(argsToFlags({ confirmed: true, query: "x" }, ["confirmed"])).toEqual(["--query", "x"])
  })
})

describe("buildConfirmSurface", () => {
  it("builds a card with confirm/cancel actions and detail rows", () => {
    const s = buildConfirmSurface({
      surfaceId: "sfc_1",
      title: "Delete",
      summary: "Delete the thing.",
      details: [{ label: "Id", value: "rec_1" }],
    })
    const components = s.components as Record<
      string,
      { props?: Record<string, unknown>; children?: string[] }
    >
    expect(s.rootId).toBe("sfc_1")
    expect(components.btn_confirm.props?.action).toEqual({ type: "button", value: "confirm" })
    expect(components.detail_0.props?.text).toContain("rec_1")
    // Card children wire summary + detail rows + the actions row.
    expect(components.sfc_1.children).toEqual(["summary", "detail_0", "actions"])
  })
})

describe("capLarkData", () => {
  it("passes small objects through unchanged", () => {
    const data = { records: [{ id: "rec_1" }] }
    expect(capLarkData(data)).toBe(data)
  })

  it("passes short strings through unchanged", () => {
    expect(capLarkData("hello")).toBe("hello")
  })

  it("truncates an oversized string with a hint", () => {
    const big = "x".repeat(MAX_RESULT_DISPLAY_CHARS + 100)
    const out = capLarkData(big) as string
    expect(out.length).toBeLessThan(MAX_RESULT_DISPLAY_CHARS + 80)
    expect(out).toMatch(/output truncated/)
  })

  it("wraps an oversized object in a truncation envelope with a preview", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, name: `row-${i}` })) }
    const out = capLarkData(big) as { truncated: boolean; note: string; preview: string }
    expect(out.truncated).toBe(true)
    expect(out.note).toMatch(/Narrow the query/)
    expect(out.preview.length).toBeLessThanOrEqual(MAX_RESULT_DISPLAY_CHARS + 1)
  })

  it("returns non-serializable values untouched", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(capLarkData(cyclic)).toBe(cyclic)
  })
})
