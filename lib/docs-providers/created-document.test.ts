import { createdDocumentTarget } from "./created-document"
const url = "https://team.feishu.cn/docx/abcdefghijklmnop1234"
const sheet = url.replace("docx", "sheets")
it.each([
  ["lark.doc.create", { ok: true, data: { document: { url } } }, "doc"],
  ["lark_doc_create", { status: "ok", data: { ok: true, data: { document: { url } } } }, "doc"],
  ["lark.sheets.create", { code: 0, data: { spreadsheet: { url: sheet } } }, "sheet"],
  [
    "office_sync_lark",
    { ok: true, artifactId: "a", result: { ok: true, data: { spreadsheet: { url: sheet } } } },
    "sheet",
  ],
])("reads completed known %s result envelopes", (toolName, output, resourceKind) => {
  expect(
    createdDocumentTarget({ toolName: toolName as string, state: "output-available", output })
  ).toMatchObject({ providerId: "lark", resourceKind })
})
it.each([
  { state: "input-streaming" },
  { state: "input-available" },
  { state: "output-error" },
  { toolName: "lark.doc.update" },
  { toolName: "other" },
  { output: { ok: false, data: { document: { url } } } },
  { output: { code: 1, data: { document: { url } } } },
  { output: { status: "needs_confirmation", data: { document: { url } } } },
  {
    output: {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ document: { url } }) }],
    },
  },
  {
    output: {
      ok: true,
      data: { document: { url: url.replace("feishu.cn", "feishu.cn.evil.test") } },
    },
  },
  { output: { note: url } },
  { output: { unknown: { url } } },
  { output: "not JSON" },
])("rejects streaming, failure, spoofed and unknown results: %j", (change) => {
  expect(
    createdDocumentTarget({
      toolName: "lark.doc.create",
      state: "output-available",
      output: { ok: true, data: { document: { url } } },
      ...change,
    })
  ).toBeNull()
})
it("reads a single completed MCP text result without searching arbitrary text", () => {
  expect(
    createdDocumentTarget({
      type: "tool-mcp__cognia-tools__lark_doc_create",
      state: "output-available",
      output: {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, data: { document: { url } } }) },
        ],
      },
    })?.url
  ).toBe(url)
})
