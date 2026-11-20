/**
 * OpenDocument Parser - Extract readable content from ODT/ODS/ODP archives.
 *
 * `content.xml` is read as an XML tree (`./xml-tree`): the format's meaning
 * lives in self-closing elements (an empty cell, `<text:s/>` spaces, a
 * `<text:line-break/>`), in attributes (a cell's `office:value`, its repeat
 * and span counts) and in nesting, none of which a regular expression over the
 * markup can see. Spreadsheets keep every cell in its column, typed values
 * keep the value they store, and repeated rows/cells are counted against the
 * shared expansion budget before they are materialised.
 */

import { DEFAULT_DOCUMENT_LIMITS, DocumentBudget, DocumentLimitError } from "../limits"
import type { ExcelParseResult, ExcelSheet, WordParseResult } from "./office-parser"
import { computeSheetStats, convertSheetToText } from "./office-parser"
import type {
  PresentationMetadata,
  PresentationParseResult,
  PresentationSlide,
} from "./presentation-parser"
import {
  childElements,
  findElement,
  findElements,
  isElement,
  parseXmlTree,
  textContent,
  type XmlElement,
  type XmlNode,
} from "./xml-tree"

interface ZipTextFileLike {
  async: (type: "string") => Promise<string>
}

interface ZipLike {
  file: (path: string) => ZipTextFileLike | null
}

export interface OpenDocumentParseOptions {
  /** Cells a spreadsheet may expand into (defaults to `DEFAULT_DOCUMENT_LIMITS`). */
  maxExpandedCells?: number
}

export async function parseOpenDocumentText(data: ArrayBuffer): Promise<WordParseResult> {
  const zip = await loadOpenDocumentZip(data)
  await assertNotEncrypted(zip)

  const content = await parseXmlTree(await readRequiredText(zip, "content.xml"))
  const blocks = textBlocks(content)
  const text = blocks
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n\n")
    .trim()

  if (!text) {
    throw new Error("No readable text content found in OpenDocument file.")
  }

  const metadata = await extractOpenDocumentMetadata(zip)
  const headings = blocks
    .filter((block) => block.heading)
    .map((block) => ({
      level: Math.max(Number(block.outlineLevel || 1), 1),
      text: block.text,
    }))

  return {
    text,
    html: blocks.map((block) => `<p>${escapeHtml(block.text)}</p>`).join(""),
    messages: [],
    images: [],
    metadata,
    headings,
  }
}

export async function parseOpenDocumentSpreadsheet(
  data: ArrayBuffer,
  options: OpenDocumentParseOptions = {}
): Promise<ExcelParseResult> {
  const zip = await loadOpenDocumentZip(data)
  await assertNotEncrypted(zip)

  const content = await parseXmlTree(await readRequiredText(zip, "content.xml"))
  // Sheets are the spreadsheet body's tables; a table nested in a cell is
  // part of that cell, not a sheet of its own.
  const tables = findElements(findElement(content, "office:spreadsheet") ?? content, "table:table")

  if (tables.length === 0) {
    throw new Error("No readable spreadsheet content found in OpenDocument file.")
  }

  const budget = new DocumentBudget(
    "expanded-cells",
    options.maxExpandedCells ?? DEFAULT_DOCUMENT_LIMITS.maxExpandedCells
  )
  const sheets: ExcelSheet[] = tables.map((table, index) => {
    const { rows, mergedCells } = readSpreadsheetTable(table, budget)
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
    return {
      name: table.attribs["table:name"] || `Sheet ${index + 1}`,
      data: rows,
      rowCount: rows.length,
      columnCount,
      mergedCells: mergedCells.length > 0 ? mergedCells : undefined,
    }
  })

  return {
    text: sheets
      .map((sheet) => convertSheetToText(sheet.name, sheet.data, sheet.mergedCells))
      .join("\n\n"),
    sheets,
    sheetNames: sheets.map((sheet) => sheet.name),
    sheetStats: sheets.map((sheet) =>
      computeSheetStats(sheet.name, sheet.data, sheet.columnCount, sheet.mergedCells ?? [])
    ),
  }
}

export async function parseOpenDocumentPresentation(
  data: ArrayBuffer
): Promise<PresentationParseResult> {
  const zip = await loadOpenDocumentZip(data)
  await assertNotEncrypted(zip)

  const content = await parseXmlTree(await readRequiredText(zip, "content.xml"))
  const pages = findElements(content, "draw:page")
  if (pages.length > DEFAULT_DOCUMENT_LIMITS.maxSlides) {
    throw new DocumentLimitError("slides", DEFAULT_DOCUMENT_LIMITS.maxSlides, pages.length)
  }
  // Every page keeps its position, text or not: slide N is the user's slide
  // N, and a picture-only slide is still a slide.
  const slides: PresentationSlide[] = pages.map((page, index) => {
    // Speaker notes live inside the page element but are not slide content.
    const blocks = textBlocks(page, SLIDE_SKIPPED_ELEMENTS)
    const slideText = blocks
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n")
      .trim()
    return {
      slideNumber: index + 1,
      ...(blocks[0]?.text ? { title: blocks[0].text } : {}),
      text: slideText,
    }
  })

  if (!slides.some((slide) => slide.text)) {
    throw new Error("No readable slide content found in OpenDocument file.")
  }

  const metadata = await extractOpenDocumentMetadata(zip)

  return {
    text: slides
      .filter((slide) => slide.text)
      .map((slide) => `## Slide ${slide.slideNumber}\n${slide.text}`)
      .join("\n\n"),
    slideCount: slides.length,
    slides,
    metadata: toPresentationMetadata(metadata),
  }
}

async function loadOpenDocumentZip(data: ArrayBuffer) {
  const JSZip = (await import("jszip")).default

  try {
    return await JSZip.loadAsync(data)
  } catch {
    throw new Error("Failed to parse OpenDocument file. Ensure the file is a valid archive.")
  }
}

async function assertNotEncrypted(zip: ZipLike): Promise<void> {
  const manifestFile = zip.file("META-INF/manifest.xml")
  if (!manifestFile) {
    return
  }

  const manifestXml = await manifestFile.async("string")
  if (/<(?:\w+:)?encryption-data\b/i.test(manifestXml)) {
    throw new Error(
      "OpenDocument file appears to be password protected. Remove protection and retry."
    )
  }
}

async function readRequiredText(zip: ZipLike, path: string): Promise<string> {
  const file = zip.file(path)
  if (!file) {
    throw new Error(`Missing required OpenDocument entry: ${path}`)
  }

  return file.async("string")
}

async function extractOpenDocumentMetadata(
  zip: ZipLike
): Promise<{ title?: string; author?: string }> {
  const metaFile = zip.file("meta.xml")
  if (!metaFile) {
    return {}
  }

  const meta = await parseXmlTree(await metaFile.async("string"))
  const read = (name: string) => {
    const element = findElement(meta, name)
    const value = element ? textContent(element).replace(/\s+/g, " ").trim() : ""
    return value || undefined
  }
  return {
    title: read("dc:title"),
    author: read("dc:creator") ?? read("meta:initial-creator"),
  }
}

function toPresentationMetadata(metadata: {
  title?: string
  author?: string
}): PresentationMetadata {
  return {
    title: metadata.title,
    author: metadata.author,
  }
}

interface TextBlock {
  heading: boolean
  outlineLevel?: string
  text: string
}

const SLIDE_SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(["presentation:notes"])

/**
 * Headings and paragraphs below `node`, in document order. A paragraph's
 * frames and notes are part of that paragraph, not blocks of their own.
 * Elements named in `skip` are left out with everything inside them.
 */
function textBlocks(node: XmlNode, skip: ReadonlySet<string> = new Set()): TextBlock[] {
  const blocks: TextBlock[] = []
  const visit = (current: XmlNode) => {
    for (const child of current.children ?? []) {
      if (isElement(child) && skip.has(child.name)) continue
      if (isElement(child, "text:h") || isElement(child, "text:p")) {
        const text = paragraphText(child).trim()
        if (text)
          blocks.push({
            heading: child.name === "text:h",
            outlineLevel: child.attribs["text:outline-level"],
            text,
          })
      } else {
        visit(child)
      }
    }
  }
  visit(node)
  return blocks
}

/**
 * The text of one `text:p` / `text:h`, by the ODF rules: runs of white space
 * in character data collapse to one space, `text:s` is `text:c` spaces,
 * `text:tab` a tab and `text:line-break` a new line. A note's citation mark is
 * dropped and its body kept in place, in parentheses.
 */
function paragraphText(node: XmlNode): string {
  let out = ""
  for (const child of node.children ?? []) {
    if (child.type === "text") {
      out += (child.data ?? "").replace(/[ \t\r\n]+/g, " ")
      continue
    }
    if (!isElement(child)) {
      out += paragraphText(child)
      continue
    }
    switch (child.name) {
      case "text:s":
        out += " ".repeat(Math.min(positiveInteger(child.attribs["text:c"]) ?? 1, 1024))
        break
      case "text:tab":
        out += "\t"
        break
      case "text:line-break":
        out += "\n"
        break
      case "text:note-citation":
        break
      case "text:note": {
        const body = findElement(child, "text:note-body")
        const noteText = body
          ? textBlocks(body)
              .map((block) => block.text)
              .join(" ")
          : ""
        if (noteText) out += ` (${noteText})`
        break
      }
      case "text:p":
      case "text:h":
        // A paragraph inside a frame or text box sits on its own line.
        out += `${out && !out.endsWith("\n") ? "\n" : ""}${paragraphText(child)}`
        break
      default:
        out += paragraphText(child)
    }
  }
  return out
}

type SheetValue = string | number | boolean | null

/** A repeat/span count: a decimal positive integer, or the attribute is malformed. */
function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid OpenDocument repeat count: ${JSON.stringify(value)}.`)
  }
  const count = Number.parseInt(value, 10)
  if (count < 1) throw new Error(`Invalid OpenDocument repeat count: ${JSON.stringify(value)}.`)
  return count
}

/**
 * The value a cell stores, by its `office:value-type`. Numbers, percentages
 * and currency keep `office:value` (what the cell holds, not its display
 * rounding); dates and times keep their ISO value; strings are the cell's
 * paragraphs, one per line.
 */
function cellValue(cell: XmlElement): SheetValue {
  const attrs = cell.attribs
  const type = attrs["office:value-type"] ?? attrs["calcext:value-type"]
  switch (type) {
    case "float":
    case "percentage":
    case "currency": {
      const value = Number(attrs["office:value"])
      if (attrs["office:value"] !== undefined && Number.isFinite(value)) return value
      break
    }
    case "boolean":
      if (attrs["office:boolean-value"] !== undefined)
        return attrs["office:boolean-value"] === "true"
      break
    case "date":
      if (attrs["office:date-value"]) return attrs["office:date-value"].replace("T00:00:00", "")
      break
    case "time":
      if (attrs["office:time-value"]) return attrs["office:time-value"]
      break
    case "string":
      if (attrs["office:string-value"] !== undefined) return attrs["office:string-value"]
      break
  }
  const text = childElements(cell)
    .filter((child) => child.name === "text:p" || child.name === "text:h")
    .map((paragraph) => paragraphText(paragraph))
    .join("\n")
    .trim()
  return text ? text : null
}

/** Rows of a spreadsheet table, wherever the format groups them. */
function tableRows(table: XmlElement): XmlElement[] {
  const rows: XmlElement[] = []
  const visit = (node: XmlElement) => {
    for (const child of childElements(node)) {
      if (child.name === "table:table-row") rows.push(child)
      else if (
        child.name === "table:table-rows" ||
        child.name === "table:table-header-rows" ||
        child.name === "table:table-row-group"
      )
        visit(child)
    }
  }
  visit(table)
  return rows
}

/**
 * One sheet as A1-anchored rows plus its merged ranges.
 *
 * Empty cells and covered (merged-away) cells take their column, so a value is
 * always at its real coordinate. Repeated rows and cells are expanded, but a
 * run of empty ones is only materialised once something follows it: office
 * suites pad every sheet to its full million-row extent with one repeated
 * empty row, and that padding must not cost a million rows.
 */
function readSpreadsheetTable(
  table: XmlElement,
  budget: DocumentBudget
): { rows: SheetValue[][]; mergedCells: string[] } {
  const rows: SheetValue[][] = []
  const mergedCells: string[] = []
  let pendingEmptyRows = 0

  for (const rowElement of tableRows(table)) {
    const rowRepeat = positiveInteger(rowElement.attribs["table:number-rows-repeated"]) ?? 1
    const cells: SheetValue[] = []
    let pendingEmptyCells = 0
    let column = 0
    const rowIndex = rows.length + pendingEmptyRows

    for (const cell of childElements(rowElement)) {
      if (cell.name !== "table:table-cell" && cell.name !== "table:covered-table-cell") continue
      const repeat = positiveInteger(cell.attribs["table:number-columns-repeated"]) ?? 1
      const value = cell.name === "table:covered-table-cell" ? null : cellValue(cell)
      const columnsSpanned = positiveInteger(cell.attribs["table:number-columns-spanned"]) ?? 1
      const rowsSpanned = positiveInteger(cell.attribs["table:number-rows-spanned"]) ?? 1
      if (cell.name === "table:table-cell" && (columnsSpanned > 1 || rowsSpanned > 1)) {
        budget.take(repeat * rowRepeat)
        for (let r = 0; r < rowRepeat; r++) {
          for (let i = 0; i < repeat; i++) {
            const start = column + i
            const top = rowIndex + r + 1
            mergedCells.push(
              `${columnName(start)}${top}:${columnName(start + columnsSpanned - 1)}${
                top + rowsSpanned - 1
              }`
            )
          }
        }
      }
      if (value === null) {
        pendingEmptyCells += repeat
      } else {
        budget.take((pendingEmptyCells + repeat) * rowRepeat)
        for (let i = 0; i < pendingEmptyCells; i++) cells.push(null)
        for (let i = 0; i < repeat; i++) cells.push(value)
        pendingEmptyCells = 0
      }
      column += repeat
    }

    if (cells.length === 0) {
      pendingEmptyRows += rowRepeat
      continue
    }
    budget.take(pendingEmptyRows)
    for (let i = 0; i < pendingEmptyRows; i++) rows.push([])
    pendingEmptyRows = 0
    for (let i = 0; i < rowRepeat; i++) rows.push(i === 0 ? cells : [...cells])
  }

  return { rows, mergedCells }
}

/** Spreadsheet column letters for a 0-based index (0 → A, 26 → AA). */
function columnName(index: number): string {
  let name = ""
  let current = index + 1
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return name
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
