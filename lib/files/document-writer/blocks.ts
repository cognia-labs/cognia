// Markdown → document blocks, for the Word and PDF writers.
//
// The writers lay out what the blocks say, so the blocks carry everything a
// chat answer's Markdown means: headings, paragraphs whose runs keep bold,
// italic, strikethrough, code spans and links, ordered, bulleted and task
// lists at any depth, block quotes, GFM tables, fenced and indented code
// (verbatim), embedded images and thematic breaks. The Markdown is read by
// `marked`'s GFM lexer, the parser the app's other Markdown exports use
// (`lib/chat/parts/markdown-html.ts`), so an export and its HTML twin agree on
// what the source says.
//
// What a document file cannot hold is never dropped silently. An image the
// writer cannot embed (a remote or relative address, a format other than PNG
// or JPEG, an image inside a table cell or heading) is written as its alt text
// and address, and raw HTML as literal text; each such run is marked `stand`,
// and `documentLosses` counts them so the export can tell the user.

import { Lexer, type Token, type Tokens } from "marked"

/** A stretch of text and the inline styling the source gave it. */
export interface DocRun {
  /** The text; `"\n"` is a hard line break. */
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  /** A code span: drawn in a monospace face. */
  code?: boolean
  /** Where the text links to: an `http:`, `https:` or `mailto:` address. */
  href?: string
  /**
   * What the run stands in for when the writer could not keep the original:
   * an image it did not embed (written as its alt text and address) or a raw
   * HTML tag (written as text).
   */
  stand?: DocStandIn
}

export type DocStandIn = "image" | "html"

/**
 * A container a block sits in, outermost first: a block quote, or the content
 * column of a list item (a nested list, or an item's later paragraphs).
 */
export type DocNest = "quote" | "list"

export type DocAlign = "left" | "center" | "right" | null

/** A list item's marker. A numbered item's `value` counts on from its list's `start`. */
export type DocListMarker = { type: "bullet" } | { type: "number"; start: number; value: number }

export type DocImageFormat = "PNG" | "JPEG"

interface Placement {
  /** The containers the block sits in; absent at the top level. */
  nest?: readonly DocNest[]
}

/** What the writers lay out, in reading order. */
export type DocBlock = Placement &
  (
    | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: DocRun[] }
    | { kind: "paragraph"; runs: DocRun[] }
    | {
        kind: "listItem"
        marker: DocListMarker
        /** A task item's state; absent for an ordinary item. */
        checked?: boolean
        runs: DocRun[]
      }
    | { kind: "code"; text: string }
    | { kind: "table"; align: DocAlign[]; header: DocRun[][]; rows: DocRun[][][] }
    | { kind: "image"; dataUrl: string; format: DocImageFormat; alt?: string }
    | { kind: "rule" }
  )

/** How many list levels deep a block sits: a list item's own level. */
export function listDepth(nest: readonly DocNest[] | undefined): number {
  return nest?.filter((container) => container === "list").length ?? 0
}

/** The plain text of some runs. */
export function runsText(runs: readonly DocRun[]): string {
  return runs.map((run) => run.text).join("")
}

/** What the writer could not keep, by kind, for the export to report. */
export interface DocumentLoss {
  kind: DocStandIn
  count: number
}

/** The runs that stand in for content the file does not hold, counted by kind. */
export function documentLosses(blocks: readonly DocBlock[]): DocumentLoss[] {
  const counts: Record<DocStandIn, number> = { image: 0, html: 0 }
  const count = (runs: readonly DocRun[]) => {
    for (const run of runs) if (run.stand) counts[run.stand] += 1
  }
  for (const block of blocks) {
    if (block.kind === "heading" || block.kind === "paragraph" || block.kind === "listItem") {
      count(block.runs)
    } else if (block.kind === "table") {
      for (const cell of block.header) count(cell)
      for (const row of block.rows) for (const cell of row) count(cell)
    }
  }
  return (["image", "html"] as const)
    .filter((kind) => counts[kind] > 0)
    .map((kind) => ({ kind, count: counts[kind] }))
}

// ---------------------------------------------------------------------------
// Images

const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,([\s\S]*)$/i
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The bytes of a base64 `data:` URL, or `null` when it is not one. */
export function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> | null {
  const match = DATA_IMAGE.exec(dataUrl.trim())
  if (!match) return null
  const base64 = match[1].replace(/\s+/g, "")
  if (!BASE64.test(base64)) return null
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The format the bytes are, by their signature, whatever the URL claimed. */
export function imageFormatOf(bytes: Uint8Array): DocImageFormat | null {
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return "PNG"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG"
  return null
}

const readUint16 = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1]
const readUint32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]

/** JPEG start-of-frame markers, which carry the image size (not DHT, JPG or DAC). */
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

/**
 * The pixel size a PNG (its IHDR chunk) or JPEG (its start-of-frame segment)
 * declares, or `null` when the bytes are neither or are cut short.
 */
export function imagePixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  const format = imageFormatOf(bytes)
  if (format === "PNG") {
    if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null
    const width = readUint32(bytes, 16)
    const height = readUint32(bytes, 20)
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (format === "JPEG") {
    let at = 2
    while (at + 3 < bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1]
      // Fill bytes, and markers that stand alone without a length.
      if (marker === 0xff) {
        at += 1
        continue
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2
        continue
      }
      const length = readUint16(bytes, at + 2)
      if (length < 2) return null
      if (isStartOfFrame(marker)) {
        if (at + 9 > bytes.length) return null
        const height = readUint16(bytes, at + 5)
        const width = readUint16(bytes, at + 7)
        return width > 0 && height > 0 ? { width, height } : null
      }
      at += 2 + length
    }
  }
  return null
}

/**
 * The image as the writers embed it, or `null` for one they cannot: only a
 * PNG or JPEG `data:` URL whose bytes declare a size. The format comes from
 * the bytes, so a PNG labelled `image/jpeg` is still embedded as a PNG.
 */
export function embeddableImage(href: string): { dataUrl: string; format: DocImageFormat } | null {
  const bytes = dataUrlBytes(href)
  if (!bytes) return null
  const format = imageFormatOf(bytes)
  if (!format || !imagePixelSize(bytes)) return null
  const base64 = href
    .trim()
    .slice(href.trim().indexOf(",") + 1)
    .replace(/\s+/g, "")
  return { dataUrl: `data:image/${format === "PNG" ? "png" : "jpeg"};base64,${base64}`, format }
}

// ---------------------------------------------------------------------------
// Markdown

const LINK_SCHEMES = /^(?:https?:|mailto:)/i
const BREAK_TAG = /^<br\s*\/?>$/i
const COMMENT = /^\s*<!--[\s\S]*?-->\s*$/

/** A character reference (`&amp;`, `&#169;`, `&#x1F600;`) as Markdown text can carry. */
const CHARACTER_REFERENCE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g

let referenceDecoder: HTMLTextAreaElement | null = null

/**
 * `marked` leaves character references in text for an HTML renderer to
 * resolve; a document has none, so they are resolved here, by the HTML
 * parser's own table. Only the reference itself goes through a `<textarea>`,
 * whose content is never parsed as markup.
 */
function decodeReferences(text: string): string {
  if (!text.includes("&")) return text
  return text.replace(CHARACTER_REFERENCE, (reference) => {
    referenceDecoder ??= document.createElement("textarea")
    referenceDecoder.innerHTML = reference
    return referenceDecoder.value
  })
}

type RunStyle = Omit<DocRun, "text" | "stand">

/** An embedded image met inside running text, which splits the paragraph there. */
interface InlineImage {
  image: { dataUrl: string; format: DocImageFormat; alt: string }
}

type Piece = DocRun | InlineImage

const isImage = (piece: Piece): piece is InlineImage => "image" in piece

const sameStyle = (a: DocRun, b: RunStyle) =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.strike === b.strike &&
  a.code === b.code &&
  a.href === b.href

function pushText(out: Piece[], text: string, style: RunStyle) {
  if (!text) return
  const last = out.at(-1)
  if (last && !isImage(last) && !last.stand && sameStyle(last, style)) last.text += text
  else out.push({ text, ...style })
}

/**
 * Inline tokens as runs. `images` says whether an embeddable image becomes an
 * inline image (in running text) or a stand-in run (in a cell, heading or
 * link, which hold text only).
 */
function inlinePieces(
  tokens: readonly Token[],
  style: RunStyle,
  out: Piece[],
  images: boolean
): Piece[] {
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text
        if (text.tokens?.length) inlinePieces(text.tokens, style, out, images)
        // A soft line break reads as a space, as it does in the rendered answer.
        else pushText(out, decodeReferences(text.text).replace(/\n/g, " "), style)
        break
      }
      case "escape":
        pushText(out, (token as Tokens.Escape).text, style)
        break
      case "strong":
        inlinePieces((token as Tokens.Strong).tokens, { ...style, bold: true }, out, images)
        break
      case "em":
        inlinePieces((token as Tokens.Em).tokens, { ...style, italic: true }, out, images)
        break
      case "del":
        inlinePieces((token as Tokens.Del).tokens, { ...style, strike: true }, out, images)
        break
      case "codespan":
        pushText(out, (token as Tokens.Codespan).text.replace(/\n/g, " "), {
          ...style,
          code: true,
        })
        break
      case "br":
        pushText(out, "\n", style)
        break
      case "link": {
        const link = token as Tokens.Link
        const href = (link.autolink ? link.href : decodeReferences(link.href)).trim()
        const linked: RunStyle = LINK_SCHEMES.test(href) ? { ...style, href } : style
        // An autolink's text is the address itself, with references unresolved.
        if (link.autolink) pushText(out, link.text, linked)
        else inlinePieces(link.tokens, linked, out, false)
        break
      }
      case "image": {
        const image = token as Tokens.Image
        const alt = decodeReferences(image.text)
        const embedded = images ? embeddableImage(image.href) : null
        if (embedded) {
          out.push({ image: { ...embedded, alt } })
          break
        }
        const href = image.href.trim()
        // A data URL is the image itself: its text would be pages of base64.
        const text = /^data:/i.test(href) ? alt : alt ? `${alt} (${href})` : href
        const target = style.href ?? (LINK_SCHEMES.test(href) ? href : undefined)
        out.push({ ...style, ...(target ? { href: target } : {}), text, stand: "image" })
        break
      }
      // A task item's box: the item carries its state (`checked`).
      case "checkbox":
        break
      case "html": {
        const tag = (token as Tokens.Tag).text
        if (BREAK_TAG.test(tag.trim())) pushText(out, "\n", style)
        // A comment is not shown in the rendered answer either.
        else if (!COMMENT.test(tag)) out.push({ ...style, text: tag, stand: "html" })
        break
      }
      default:
        pushText(
          out,
          "text" in token && typeof token.text === "string" ? token.text : token.raw,
          style
        )
    }
  }
  return out
}

/** Runs only: an embeddable image is still written as its stand-in. */
const inlineRuns = (tokens: readonly Token[]): DocRun[] =>
  inlinePieces(tokens, {}, [], false).filter((piece): piece is DocRun => !isImage(piece))

/** Trim a paragraph's outer whitespace, which a split at an image leaves behind. */
function trimRuns(runs: DocRun[]): DocRun[] {
  const out = runs.map((run) => ({ ...run }))
  while (out.length && !out[0].stand && !out[0].text.trimStart()) out.shift()
  while (out.length && !out.at(-1)!.stand && !out.at(-1)!.text.trimEnd()) out.pop()
  if (out.length && !out[0].stand) out[0].text = out[0].text.trimStart()
  const last = out.at(-1)
  if (last && !last.stand) last.text = last.text.trimEnd()
  return out
}

/**
 * Parse Markdown (CommonMark plus GFM tables, task lists, strikethrough and
 * autolinks) into document blocks.
 */
export function parseMarkdownBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = []

  const push = (block: DocBlock, nest: readonly DocNest[]) => {
    blocks.push(nest.length > 0 ? { ...block, nest } : block)
  }

  /** Running text: paragraphs, split at each embedded image. */
  const flow = (pieces: readonly Piece[], nest: readonly DocNest[]) => {
    let runs: DocRun[] = []
    const flush = () => {
      const trimmed = trimRuns(runs)
      if (trimmed.length > 0) push({ kind: "paragraph", runs: trimmed }, nest)
      runs = []
    }
    for (const piece of pieces) {
      if (isImage(piece)) {
        flush()
        const { dataUrl, format, alt } = piece.image
        push({ kind: "image", dataUrl, format, ...(alt ? { alt } : {}) }, nest)
      } else {
        runs.push(piece)
      }
    }
    flush()
  }

  const inlineOf = (token: Token): readonly Token[] =>
    (token as { tokens?: Token[] }).tokens ?? [
      { type: "text", raw: token.raw, text: (token as { text?: string }).text ?? token.raw },
    ]

  const list = (token: Tokens.List, nest: readonly DocNest[]) => {
    const start = token.ordered ? (typeof token.start === "number" ? token.start : 1) : 0
    const inner: readonly DocNest[] = [...nest, "list"]
    token.items.forEach((item, index) => {
      const marker: DocListMarker = token.ordered
        ? { type: "number", start, value: start + index }
        : { type: "bullet" }
      const children = item.tokens.filter((child) => child.type !== "checkbox")
      const [first] = children
      const leads = first !== undefined && (first.type === "text" || first.type === "paragraph")
      const pieces = leads ? inlinePieces(inlineOf(first), {}, [], true) : []
      // The item's own line ends at its first embedded image; the image and
      // what follows sit in the item's content column.
      const split = pieces.findIndex(isImage)
      const lead = (split === -1 ? pieces : pieces.slice(0, split)) as DocRun[]
      push(
        {
          kind: "listItem",
          marker,
          ...(item.task ? { checked: item.checked === true } : {}),
          runs: trimRuns(lead),
        },
        nest
      )
      if (split !== -1) flow(pieces.slice(split), inner)
      walk(leads ? children.slice(1) : children, inner)
    })
  }

  const walk = (tokens: readonly Token[], nest: readonly DocNest[]) => {
    for (const token of tokens) {
      switch (token.type) {
        case "space":
        case "def":
          break
        case "heading": {
          const heading = token as Tokens.Heading
          const level = Math.min(Math.max(heading.depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6
          push({ kind: "heading", level, runs: trimRuns(inlineRuns(heading.tokens)) }, nest)
          break
        }
        case "paragraph":
        case "text":
          flow(inlinePieces(inlineOf(token), {}, [], true), nest)
          break
        case "code":
          push({ kind: "code", text: (token as Tokens.Code).text }, nest)
          break
        case "blockquote":
          walk((token as Tokens.Blockquote).tokens, [...nest, "quote"])
          break
        case "list":
          list(token as Tokens.List, nest)
          break
        case "table": {
          const table = token as Tokens.Table
          push(
            {
              kind: "table",
              align: table.align,
              header: table.header.map((cell) => trimRuns(inlineRuns(cell.tokens))),
              rows: table.rows.map((row) => row.map((cell) => trimRuns(inlineRuns(cell.tokens)))),
            },
            nest
          )
          break
        }
        case "hr":
          push({ kind: "rule" }, nest)
          break
        case "html": {
          const html = (token as Tokens.HTML).text
          if (COMMENT.test(html)) break
          if (BREAK_TAG.test(html.trim())) break
          push(
            { kind: "paragraph", runs: [{ text: html.replace(/\n+$/, ""), stand: "html" }] },
            nest
          )
          break
        }
        default:
          flow([{ text: token.raw.trim() }], nest)
      }
    }
  }

  walk(new Lexer({ gfm: true }).lex(markdown), [])
  return blocks
}
