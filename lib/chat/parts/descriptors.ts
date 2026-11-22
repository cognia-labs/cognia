/**
 * One description per message part type of what the part is outside the live
 * chat (D11): its text for search, the Inbox preview and model context; what
 * copy and native share hand over; and its Markdown, HTML and plain-text
 * export. The exporters, the share and copy path, the Inbox extractor and the
 * search projection all derive from here, so a part type is described once
 * and no consumer drops it on its own.
 *
 * Exports never drop a part silently. A part with no faithful export (an
 * interactive surface, a card a plugin draws) leaves a labelled note where it
 * was; only the AI SDK's structural step markers render as nothing.
 *
 * Pure, DOM-free and synchronous: the same walk runs in the renderer, the idle
 * search indexer and a Host's brain.
 */

import { videoAttachmentInfoOfPart } from "@/lib/chat/attachments/video/attachment-info"
import { normalizeToolName, type ToolPartLike } from "@/lib/chat/tool-summary"

import type { PartLabels } from "./labels"
import { escapeHtml, markdownToSafeHtml } from "./markdown-html"

/**
 * Who reads a part's plain text:
 *
 * - `preview` — the Inbox row and its search: the readable conversation only.
 * - `search` — chat-history search, which also finds reasoning, attached file
 *   names, cited sources and tool inputs (never tool outputs, which would bury
 *   prose under logs).
 * - `model-context` — text handed to a model: the readable conversation with
 *   files named, never their payloads.
 */
export type PlainTextPurpose = "preview" | "search" | "model-context"

export interface PartRenderContext {
  labels: PartLabels
  /** HTML only: whether folded blocks (thinking, tools) start open. */
  expandDetails?: boolean
}

/** What copy and native share hand over for one part. */
export interface PartShare {
  /** Clipboard text. */
  plain: string
  /** Share-sheet text: names an inline image instead of pasting its data URL. */
  native: string
  /** Clipboard HTML. */
  html: string
  /** An image the share sheet can attach as a file. */
  image?: { url: string; filename?: string; mediaType?: string }
}

type PartRecord = Record<string, unknown>

interface PartDescriptor {
  /** Absent: the part contributes no plain text for any purpose. */
  plainText?: (part: PartRecord, purpose: PlainTextPurpose) => string
  /**
   * Whether copy and share carry this part, cheap enough to ask while a row
   * renders. Defaults to whether `share` is present.
   */
  shareable?: (part: PartRecord) => boolean
  /** Absent: copy and share leave the part out. Built only when the user acts. */
  share?: (part: PartRecord) => PartShare | null
  markdown: (part: PartRecord, ctx: PartRenderContext) => string
  html: (part: PartRecord, ctx: PartRenderContext) => string
  text: (part: PartRecord, ctx: PartRenderContext) => string
}

/** Per-field ceiling when harvesting strings out of a tool call's input. */
export const TOOL_INPUT_FIELD_MAX_CHARS = 1_000

/** How deep to walk a tool input looking for strings. */
const TOOL_INPUT_MAX_DEPTH = 3

/** Citations anyone can follow; the other origins are the user's own material. */
const PUBLIC_SOURCE_ORIGINS = new Set(["anthropic", "cognia-web"])

/** Structural markers the AI SDK interleaves between steps: no content at all. */
const STRUCTURAL_PART_TYPES = new Set(["step-start", "step-finish"])

// ---------------------------------------------------------------------------
// Small helpers

function isObject(value: unknown): value is PartRecord {
  return typeof value === "object" && value !== null
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** True when a file part should render as an image (by MIME, data URL, or extension). */
export function isImageFile(file: {
  url?: string
  mediaType?: string
  filename?: string
}): boolean {
  return Boolean(
    file.mediaType?.startsWith("image/") ||
    file.url?.startsWith("data:image/") ||
    file.filename?.match(/\.(?:avif|gif|jpe?g|png|svg|webp)$/i)
  )
}

/** A code fence longer than any backtick run inside `text`. */
export function markdownFence(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return "`".repeat(Math.max(3, longest + 1))
}

function fenced(text: string, language = ""): string {
  const fence = markdownFence(text)
  return `${fence}${language}\n${text}\n${fence}`
}

/** Escape the characters that would turn a title into Markdown or HTML. */
function escapeMarkdownInline(text: string): string {
  return text.replace(/([\\`*_[\]<>#|])/g, "\\$1")
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1")
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function isSafeHref(url: string, image: boolean): boolean {
  const lower = url.trim().toLowerCase()
  if (/^(https?:|mailto:)/.test(lower)) return true
  return image && lower.startsWith("data:image/")
}

/** Share keeps app-relative and blob links: the clipboard lands back in a WebView. */
function isSafeShareUrl(url: string, image: boolean): boolean {
  const lower = url.trim().toLowerCase()
  if (/^(https?:|mailto:|blob:)/.test(lower) || lower.startsWith("/") || lower.startsWith("#")) {
    return true
  }
  return image && lower.startsWith("data:image/")
}

function openAttr(ctx: PartRenderContext): string {
  return ctx.expandDetails === false ? "" : " open"
}

/**
 * A card with no text of its own: one labelled line, and the card's own
 * Markdown (a reply, an objective, findings) under it when it has one.
 */
function card(
  kind: string,
  lineOf: (part: PartRecord, labels: PartLabels) => string,
  bodyOf?: (part: PartRecord) => string
): PartDescriptor {
  return {
    markdown: (part, { labels }) => {
      const line = escapeMarkdownInline(lineOf(part, labels))
      const body = bodyOf?.(part).trim()
      return body ? `> **${line}**\n>\n${quoted(body)}` : `> *${line}*`
    },
    html: (part, { labels }) => {
      const body = bodyOf?.(part).trim()
      return `<div class="part-card part-${kind}"><p class="part-card-title">${escapeHtml(lineOf(part, labels))}</p>${
        body ? markdownToSafeHtml(body) : ""
      }</div>`
    },
    text: (part, { labels }) => {
      const line = lineOf(part, labels)
      const body = bodyOf?.(part).trim()
      return body ? `[${line}]\n${body}` : `[${line}]`
    },
  }
}

const NOT_EXPORTED: PartDescriptor = card("not-exported", (part, labels) =>
  labels.notExported(asString(part.type) || "unknown")
)

const SILENT: PartDescriptor = { markdown: () => "", html: () => "", text: () => "" }

// ---------------------------------------------------------------------------
// Text-bearing parts

function textDescriptor(field: "text" | "md"): PartDescriptor {
  // A video's description is the model's reading of it, not message text.
  const shareable = (part: PartRecord) =>
    Boolean(asString(part[field])) && videoAttachmentInfoOfPart(part) === null
  return {
    plainText: (part) => asString(part[field]),
    shareable,
    share: (part) => {
      if (!shareable(part)) return null
      const text = asString(part[field])
      return { plain: text, native: text, html: `<div>${markdownToSafeHtml(text)}</div>` }
    },
    markdown: (part) => asString(part[field]),
    html: (part) => {
      const text = asString(part[field])
      return text ? `<div class="text">${markdownToSafeHtml(text)}</div>` : ""
    },
    text: (part) => asString(part[field]),
  }
}

function codeText(part: PartRecord): string {
  return asString(part.text) || asString(part.code)
}

const CODE: PartDescriptor = {
  plainText: (part) => {
    const language = asString(part.language)
    return language ? `[${language}] ${codeText(part)}` : codeText(part)
  },
  markdown: (part) => fenced(codeText(part), asString(part.language)),
  html: (part) => `<pre><code>${escapeHtml(codeText(part))}</code></pre>`,
  text: (part) => codeText(part),
}

/** The Inbox's image segment: an alt text and, sometimes, a URL. */
const IMAGE: PartDescriptor = {
  plainText: (part) => {
    const alt = asString(part.alt)
    return alt ? `[image: ${alt}]` : "[image]"
  },
  markdown: (part, ctx) => {
    const url = asString(part.url)
    return url
      ? `![${escapeMarkdownLabel(asString(part.alt))}](${url})`
      : NOT_EXPORTED.markdown(part, ctx)
  },
  html: (part, ctx) => {
    const url = asString(part.url)
    return url && isSafeHref(url, true)
      ? `<figure class="image"><img src="${escapeHtml(url)}" alt="${escapeHtml(asString(part.alt))}" loading="lazy"></figure>`
      : NOT_EXPORTED.html(part, ctx)
  },
  text: (part, ctx) => asString(part.alt) || NOT_EXPORTED.text(part, ctx),
}

const REASONING: PartDescriptor = {
  plainText: (part, purpose) => (purpose === "search" ? asString(part.text) : ""),
  markdown: (part, { labels }) =>
    [
      "<details>",
      `<summary>💭 ${escapeHtml(labels.thinking)}</summary>`,
      "",
      quoted(asString(part.text)),
      "",
      "</details>",
    ].join("\n"),
  html: (part, ctx) => `<details${openAttr(ctx)} class="reasoning">
  <summary>💭 ${escapeHtml(ctx.labels.thinking)}</summary>
  <pre>${escapeHtml(asString(part.text))}</pre>
</details>`,
  text: (part, { labels }) => `[${labels.thinking}]\n${asString(part.text)}`,
}

// ---------------------------------------------------------------------------
// Tool calls

/**
 * Collect string values out of a tool call's input, depth-limited and
 * cycle-safe. Field order follows `Object.keys`, which is insertion order for
 * the JSON-derived objects tool inputs always are.
 */
function harvestInputStrings(
  value: unknown,
  depth: number,
  seen: Set<object>,
  out: string[]
): void {
  if (depth > TOOL_INPUT_MAX_DEPTH) return
  if (typeof value === "string") {
    if (value) out.push(value.slice(0, TOOL_INPUT_FIELD_MAX_CHARS))
    return
  }
  if (!isObject(value)) return
  // A tool input arrives as JSON, but it is handed over as a live object that
  // callers may have decorated — guard the cycle rather than trusting that.
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    // An array is a list of siblings, not a nesting level. Counting it would put
    // `MultiEdit`'s real shape — `input.edits[i].old_string` — out of reach.
    for (const entry of value) harvestInputStrings(entry, depth, seen, out)
    return
  }
  for (const key of Object.keys(value)) {
    harvestInputStrings(value[key], depth + 1, seen, out)
  }
}

function toolTitle(part: PartRecord): string {
  return normalizeToolName(part as unknown as ToolPartLike)
    .split(/[-_]/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ""))
    .join(" ")
}

function toolOutputText(output: unknown): string {
  return typeof output === "string" ? output : safeJson(output)
}

const TOOL: PartDescriptor = {
  plainText: (part, purpose) => {
    if (purpose !== "search") return ""
    const buf: string[] = [normalizeToolName(part as unknown as ToolPartLike)]
    harvestInputStrings(part.input, 1, new Set<object>(), buf)
    return buf.join(" ")
  },
  markdown: (part, { labels }) => {
    const state = asString(part.state) || "unknown"
    const lines = [
      "<details>",
      `<summary>🔧 ${escapeHtml(labels.tool(toolTitle(part)))} [${escapeHtml(state)}]</summary>`,
      "",
    ]
    if (part.input !== undefined) {
      lines.push(
        `**${escapeMarkdownInline(labels.toolInput)}:**`,
        fenced(safeJson(part.input), "json")
      )
    }
    if (part.output !== undefined) {
      lines.push(
        "",
        `**${escapeMarkdownInline(labels.toolOutput)}:**`,
        fenced(toolOutputText(part.output), typeof part.output === "string" ? "" : "json")
      )
    }
    const error = asString(part.errorText)
    if (error) lines.push("", `**${escapeMarkdownInline(labels.toolError)}:**`, `> ❌ ${error}`)
    lines.push("", "</details>")
    return lines.join("\n")
  },
  html: (part, ctx) => {
    const { labels } = ctx
    const error = asString(part.errorText)
    return `<details${openAttr(ctx)} class="tool">
  <summary>🔧 ${escapeHtml(labels.tool(toolTitle(part)))} <span class="state">[${escapeHtml(asString(part.state) || "?")}]</span></summary>
  ${part.input !== undefined ? `<h4>${escapeHtml(labels.toolInput)}</h4><pre>${escapeHtml(safeJson(part.input))}</pre>` : ""}
  ${part.output !== undefined ? `<h4>${escapeHtml(labels.toolOutput)}</h4><pre>${escapeHtml(toolOutputText(part.output))}</pre>` : ""}
  ${error ? `<p class="error">❌ ${escapeHtml(error)}</p>` : ""}
</details>`
  },
  text: (part, { labels }) => {
    const lines = [`[${labels.tool(toolTitle(part))}] ${asString(part.state)}`.trimEnd()]
    const error = asString(part.errorText)
    if (error) lines.push(`${labels.toolError}: ${error}`)
    return lines.join("\n")
  },
}

// ---------------------------------------------------------------------------
// Files and sources

function fileLabel(part: PartRecord, labels: PartLabels): string {
  return asString(part.filename) || asString(part.mediaType) || labels.file
}

function fileShape(part: PartRecord) {
  return {
    url: asString(part.url) || undefined,
    mediaType: asString(part.mediaType) || undefined,
    filename: asString(part.filename) || undefined,
  }
}

const FILE: PartDescriptor = {
  plainText: (part, purpose) => {
    if (purpose === "search") return asString(part.filename)
    if (purpose !== "model-context") return ""
    const filename = asString(part.filename).replace(/\s+/g, " ").trim() || "unnamed"
    const mediaType = asString(part.mediaType).replace(/\s+/g, " ").trim() || "unknown"
    return `[attached file: ${filename} (${mediaType})]`
  },
  share: (part) => {
    const file = fileShape(part)
    const label = file.filename || file.mediaType || "file"
    if (!file.url) return { plain: label, native: label, html: `<p>${escapeHtml(label)}</p>` }
    const image = Boolean(file.mediaType?.startsWith("image/"))
    const link = image
      ? `![${escapeMarkdownLabel(label)}](${file.url})`
      : `[${escapeMarkdownLabel(label)}](${file.url})`
    const html = isSafeShareUrl(file.url, image)
      ? image
        ? `<figure><img src="${escapeHtml(file.url)}" alt="${escapeHtml(label)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`
        : `<p><a href="${escapeHtml(file.url)}">${escapeHtml(label)}</a></p>`
      : `<p>${escapeHtml(label)}</p>`
    return {
      plain: link,
      native: image && file.url.startsWith("data:image/") ? label : link,
      html,
      ...(image
        ? { image: { url: file.url, filename: file.filename, mediaType: file.mediaType } }
        : {}),
    }
  },
  markdown: (part, { labels }) => {
    const file = fileShape(part)
    const name = fileLabel(part, labels)
    if (!file.url) return `📎 ${escapeMarkdownInline(name)}`
    return isImageFile(file)
      ? `![${escapeMarkdownLabel(name)}](${file.url})`
      : `📎 [${escapeMarkdownLabel(name)}](${file.url})`
  },
  html: (part, { labels }) => {
    const file = fileShape(part)
    const name = fileLabel(part, labels)
    if (file.url && isImageFile(file) && isSafeHref(file.url, true)) {
      return `<figure class="image"><img src="${escapeHtml(file.url)}" alt="${escapeHtml(name)}" loading="lazy"><figcaption>${escapeHtml(name)}</figcaption></figure>`
    }
    return file.url && isSafeHref(file.url, false)
      ? `<p class="file">📎 <a href="${escapeHtml(file.url)}">${escapeHtml(name)}</a></p>`
      : `<p class="file">📎 ${escapeHtml(name)}</p>`
  },
  text: (part, { labels }) => {
    const url = asString(part.url)
    const name = fileLabel(part, labels)
    // A data URL is the file itself: name it rather than print megabytes.
    return url && !url.startsWith("data:") ? `${name} <${url}>` : name
  },
}

const SOURCE_URL: PartDescriptor = {
  share: (part) => {
    const url = asString(part.url)
    const label = asString(part.title) || url
    const link = `[${escapeMarkdownLabel(label)}](${url})`
    return {
      plain: link,
      native: link,
      html: isSafeShareUrl(url, false)
        ? `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`
        : `<p>${escapeHtml(label)}</p>`,
    }
  },
  markdown: (part) => {
    const url = asString(part.url)
    return `🔗 [${escapeMarkdownLabel(asString(part.title) || url)}](${url})`
  },
  html: (part) => {
    const url = asString(part.url)
    const label = escapeHtml(asString(part.title) || url)
    return isSafeHref(url, false)
      ? `<p class="source">🔗 <a href="${escapeHtml(url)}">${label}</a></p>`
      : `<p class="source">🔗 ${label}</p>`
  },
  text: (part) => {
    const url = asString(part.url)
    const title = asString(part.title)
    return title && title !== url ? `${title} <${url}>` : url
  },
}

function sourceDocumentLabel(part: PartRecord, labels?: PartLabels): string {
  return asString(part.title) || asString(part.mediaType) || (labels ? labels.source : "source")
}

const SOURCE_DOCUMENT: PartDescriptor = {
  share: (part) => {
    const label = sourceDocumentLabel(part)
    return { plain: label, native: label, html: `<p>${escapeHtml(label)}</p>` }
  },
  markdown: (part, { labels }) => `📄 ${escapeMarkdownInline(sourceDocumentLabel(part, labels))}`,
  html: (part, { labels }) =>
    `<p class="source">📄 ${escapeHtml(sourceDocumentLabel(part, labels))}</p>`,
  text: (part, { labels }) => sourceDocumentLabel(part, labels),
}

interface SourceItem {
  title: string
  url: string
  origin: string
}

function sourceItems(part: PartRecord): SourceItem[] {
  const sources = part.sources
  if (!Array.isArray(sources)) return []
  return sources.filter(isObject).map((source) => ({
    title: asString(source.title),
    url: asString(source.url),
    origin: asString(source.origin),
  }))
}

/**
 * A turn's citations: web citations are listed; the user's own material
 * (memory, twin, project history, knowledge bases) is counted, never listed,
 * because exports are shared. Footnotes are already in the reply's text.
 */
function splitSources(part: PartRecord): { cited: SourceItem[]; privateCount: number } {
  const cited: SourceItem[] = []
  let privateCount = 0
  for (const item of sourceItems(part)) {
    if (item.origin === "footnote") continue
    if (PUBLIC_SOURCE_ORIGINS.has(item.origin) && (item.url || item.title)) cited.push(item)
    else privateCount += 1
  }
  return { cited, privateCount }
}

const SOURCES: PartDescriptor = {
  plainText: (part, purpose) => {
    if (purpose !== "search") return ""
    const buf: string[] = []
    for (const source of sourceItems(part)) {
      if (!PUBLIC_SOURCE_ORIGINS.has(source.origin)) continue
      if (source.title) buf.push(source.title)
      if (source.url) buf.push(source.url)
    }
    return buf.join(" ")
  },
  markdown: (part, { labels }) => {
    const { cited, privateCount } = splitSources(part)
    if (cited.length === 0 && privateCount === 0) return ""
    const lines = [`**${escapeMarkdownInline(labels.sources)}**`, ""]
    for (const item of cited) {
      const title = item.title || item.url
      lines.push(
        item.url && isSafeHref(item.url, false)
          ? `- [${escapeMarkdownLabel(title)}](${item.url})`
          : `- ${escapeMarkdownInline(title)}`
      )
    }
    if (privateCount > 0)
      lines.push(`- *${escapeMarkdownInline(labels.privateSources(privateCount))}*`)
    return lines.join("\n")
  },
  html: (part, { labels }) => {
    const { cited, privateCount } = splitSources(part)
    if (cited.length === 0 && privateCount === 0) return ""
    const items = cited.map((item) => {
      const title = escapeHtml(item.title || item.url)
      return item.url && isSafeHref(item.url, false)
        ? `<li><a href="${escapeHtml(item.url)}">${title}</a></li>`
        : `<li>${title}</li>`
    })
    if (privateCount > 0) {
      items.push(`<li class="note">${escapeHtml(labels.privateSources(privateCount))}</li>`)
    }
    return `<div class="sources"><p class="part-card-title">${escapeHtml(labels.sources)}</p><ul>${items.join("")}</ul></div>`
  },
  text: (part, { labels }) => {
    const { cited, privateCount } = splitSources(part)
    if (cited.length === 0 && privateCount === 0) return ""
    const lines = [`[${labels.sources}]`]
    for (const item of cited) {
      lines.push(
        item.title && item.url ? `- ${item.title} <${item.url}>` : `- ${item.title || item.url}`
      )
    }
    if (privateCount > 0) lines.push(`- ${labels.privateSources(privateCount)}`)
    return lines.join("\n")
  },
}

// ---------------------------------------------------------------------------
// Cards

function a2uiMirror(part: PartRecord): string {
  return asString(part.plainTextMirror) || asString(part.text)
}

const A2UI: PartDescriptor = {
  plainText: (part) => a2uiMirror(part),
  ...card("a2ui", (_part, labels) => labels.interactiveSurface, a2uiMirror),
}

function groundingCounts(part: PartRecord): { supported: number; total: number } {
  const claims = Array.isArray(part.claims) ? part.claims.filter(isObject) : []
  return {
    supported: claims.filter((claim) => claim.supported === true).length,
    total: claims.length,
  }
}

function verificationLine(part: PartRecord, labels: PartLabels): string {
  const status = asString(part.status)
  if (status === "running") return labels.verificationRunning
  if (status === "failed") return labels.verificationFailed(asString(part.error))
  return labels.verification(asString(part.verdict) || "unsure")
}

function verificationBody(part: PartRecord): string {
  const points = Array.isArray(part.points)
    ? part.points.filter(
        (point): point is string => typeof point === "string" && point.trim() !== ""
      )
    : []
  return [asString(part.summary), points.map((point) => `- ${point}`).join("\n")]
    .filter(Boolean)
    .join("\n\n")
}

function dataField(part: PartRecord, key: string): string {
  return isObject(part.data) ? asString(part.data[key]) : ""
}

const DESCRIPTORS: Readonly<Record<string, PartDescriptor>> = {
  text: textDescriptor("text"),
  markdown: textDescriptor("md"),
  code: CODE,
  image: IMAGE,
  reasoning: REASONING,
  file: FILE,
  "source-url": SOURCE_URL,
  "source-document": SOURCE_DOCUMENT,
  sources: SOURCES,
  a2ui: A2UI,
  artifact: card("artifact", (part, labels) =>
    labels.artifact(asString(part.title), asString(part.kind))
  ),
  canvas: card("canvas", (part, labels) => labels.canvas(asString(part.title))),
  subagent: card(
    "subagent",
    (part, labels) => labels.subagent(asString(part.name), asString(part.status)),
    (part) => asString(part.finalResponse) || asString(part.summary)
  ),
  "agent-team-dispatch": card(
    "team-dispatch",
    (part, labels) => labels.teamDispatch(asString(part.toName) || asString(part.to)),
    (part) => asString(part.task)
  ),
  "squad-run": card(
    "squad-run",
    (part, labels) => labels.squadRun(asString(part.squadName)),
    (part) => asString(part.objective)
  ),
  "squad-gate": card("squad-gate", (part, labels) =>
    labels.squadGate(asString(part.title), asString(part.decision))
  ),
  "verification-verdict": card("verification", verificationLine, verificationBody),
  grounding: card("grounding", (part, labels) => {
    const { supported, total } = groundingCounts(part)
    return labels.grounding(supported, total)
  }),
  "data-tool-summary": card(
    "tool-summary",
    (_part, labels) => labels.toolSummary,
    (part) => dataField(part, "summary")
  ),
  "data-commentary": {
    markdown: (part) => quoted(dataField(part, "text")),
    html: (part) => {
      const text = dataField(part, "text")
      return text.trim() ? `<div class="commentary">${markdownToSafeHtml(text)}</div>` : ""
    },
    text: (part) => dataField(part, "text"),
  },
  "data-shared-withheld": card("withheld", (_part, labels) => labels.withheld),
  "compact-boundary": card("compacted", (_part, labels) => labels.compacted),
}

function isToolType(type: string): boolean {
  return type.startsWith("tool-") || type === "dynamic-tool"
}

function descriptorOf(part: unknown): { descriptor: PartDescriptor; part: PartRecord } | null {
  if (!isObject(part)) return null
  const type = asString(part.type)
  if (!type) return null
  if (STRUCTURAL_PART_TYPES.has(type)) return { descriptor: SILENT, part }
  if (isToolType(type)) return { descriptor: TOOL, part }
  return { descriptor: DESCRIPTORS[type] ?? NOT_EXPORTED, part }
}

// ---------------------------------------------------------------------------
// Public surface

/** A part's text for `purpose`; empty when it contributes none. */
export function partPlainText(part: unknown, purpose: PlainTextPurpose): string {
  const found = descriptorOf(part)
  return found?.descriptor.plainText?.(found.part, purpose) ?? ""
}

/** What copy and share hand over for a part, or null when they leave it out. */
export function partShare(part: unknown): PartShare | null {
  const found = descriptorOf(part)
  return found?.descriptor.share?.(found.part) ?? null
}

/** Whether copy and share carry this part, without building what they hand over. */
export function isShareablePart(part: unknown): boolean {
  const found = descriptorOf(part)
  if (!found?.descriptor.share) return false
  return found.descriptor.shareable?.(found.part) ?? true
}

/** A part as exported Markdown; empty only for structural markers and empty text. */
export function renderPartMarkdown(part: unknown, ctx: PartRenderContext): string {
  const found = descriptorOf(part)
  return found ? found.descriptor.markdown(found.part, ctx) : ""
}

/** A part as exported HTML, safe to open in another person's browser. */
export function renderPartHtml(part: unknown, ctx: PartRenderContext): string {
  const found = descriptorOf(part)
  return found ? found.descriptor.html(found.part, ctx) : ""
}

/** A part as exported plain text. */
export function renderPartText(part: unknown, ctx: PartRenderContext): string {
  const found = descriptorOf(part)
  return found ? found.descriptor.text(found.part, ctx) : ""
}
