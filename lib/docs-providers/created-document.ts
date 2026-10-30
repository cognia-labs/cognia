import { classifyCloudDocumentUrl, type CloudDocumentTarget } from "./document-url"

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Known create results only: CLI data.document/data.spreadsheet and office's result envelope. */
export function createdDocumentTarget(part: {
  state?: string
  type?: string
  toolName?: string
  output?: unknown
}): CloudDocumentTarget | null {
  if (part.state !== "output-available") return null
  const name = (part.toolName ?? part.type?.replace(/^tool-/, "") ?? "").replace(
    /^mcp__(?:cognia-tools|cognia-plugin-tools)__/,
    ""
  )
  const doc = ["lark.doc.create", "lark_doc_create"].includes(name)
  const sheet = ["lark.sheets.create", "lark_sheets_create", "office_sync_lark"].includes(name)
  if (!doc && !sheet) return null
  let value = part.output
  // MCP text output is one JSON record, never a scan of prose or streaming chunks.
  const output = record(value)
  if (output?.isError === true) return null
  if (Array.isArray(output?.content)) {
    if (output.content.length !== 1) return null
    const block = record(output.content[0])
    if (block?.type !== "text" || typeof block.text !== "string") return null
    value = block.text
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  let body = record(value)
  if (name === "office_sync_lark") {
    if (body?.ok !== true) return null
    body = record(body.result)
  }
  for (let depth = 0; depth < 4 && body; depth++) {
    if (
      body.ok === false ||
      body.isError === true ||
      body.truncated === true ||
      (body.status !== undefined && !["ok", "success"].includes(String(body.status))) ||
      (body.code !== undefined && body.code !== 0)
    )
      return null
    if (!record(body.data)) break
    if (depth === 3) return null
    body = record(body.data)
  }
  if (!body) return null
  const resource = record(doc ? body.document : body.spreadsheet) ?? body
  const url = resource.url ?? (doc ? resource.doc_url : resource.spreadsheet_url)
  if (typeof url !== "string") return null
  const target = classifyCloudDocumentUrl(url)
  return target?.providerId === "lark" &&
    (doc ? ["doc", "wiki"].includes(target.resourceKind) : target.resourceKind === "sheet")
    ? target
    : null
}
