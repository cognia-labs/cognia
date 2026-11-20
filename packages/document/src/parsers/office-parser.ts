/**
 * Office Parser - Extract content from Word (.docx) and Excel (.xlsx) files
 * Uses mammoth for Word and xlsx for Excel
 * Enhanced with image extraction, metadata, style mapping, date/merged cell/formula support
 */

import { formatStoredNumber, htmlTables, sheetHasHeaderRow } from "../document-tables"
import { DEFAULT_DOCUMENT_LIMITS, DocumentBudget } from "../limits"
import type { DocumentTable } from "../types"

export interface WordParseResult {
  text: string
  html: string
  messages: WordMessage[]
  images: WordImage[]
  metadata?: WordMetadata
  headings?: WordHeading[]
  /** The document's tables as typed grids, merged cells as spans. */
  tables?: DocumentTable[]
}

export interface WordMessage {
  type: "warning" | "error"
  message: string
}

export interface WordImage {
  contentType: string
  base64: string
}

export interface WordMetadata {
  title?: string
  author?: string
  lastModifiedBy?: string
  created?: Date
  modified?: Date
  revision?: number
  description?: string
  subject?: string
  keywords?: string
}

export interface WordHeading {
  level: number
  text: string
}

export interface WordParseOptions {
  extractImages?: boolean
  styleMap?: string[]
  extractMetadata?: boolean
}

export interface ExcelParseResult {
  text: string
  sheets: ExcelSheet[]
  sheetNames: string[]
  sheetStats?: ExcelSheetStats[]
}

export interface ExcelSheet {
  name: string
  data: (string | number | boolean | null)[][]
  rowCount: number
  columnCount: number
  mergedCells?: string[]
}

export interface ExcelCell {
  value: string | number | boolean | null
  type: "string" | "number" | "boolean" | "date" | "empty"
}

export interface ExcelParseOptions {
  /** Cells the whole workbook may expand into (defaults to `DEFAULT_DOCUMENT_LIMITS`). */
  maxExpandedCells?: number
}

export interface ExcelSheetStats {
  name: string
  rowCount: number
  columnCount: number
  mergedCellCount: number
  emptyRate: number
  columnTypes: Record<number, "string" | "number" | "date" | "boolean" | "mixed">
}

/**
 * Parse Word document from ArrayBuffer
 */
export async function parseWord(
  data: ArrayBuffer,
  options: WordParseOptions = {}
): Promise<WordParseResult> {
  const mammoth = await import("mammoth")

  const convertOptions: Record<string, unknown> = {}

  // Image extraction via convertImage callback
  const extractedImages: WordImage[] = []
  if (options.extractImages !== false) {
    convertOptions.convertImage = mammoth.default.images.imgElement(
      (image: { read: (encoding: string) => Promise<string>; contentType: string }) => {
        return image.read("base64").then((imageBase64: string) => {
          extractedImages.push({
            contentType: image.contentType,
            base64: imageBase64,
          })
          return { src: `data:${image.contentType};base64,${imageBase64}` }
        })
      }
    )
  }

  // Style mapping for better HTML output
  if (options.styleMap && options.styleMap.length > 0) {
    convertOptions.styleMap = options.styleMap
  }

  const input = mammothInput(data)
  const result = await mammoth.default.convertToHtml(input, convertOptions)
  const textResult = await mammoth.default.extractRawText(input)

  const messages: WordMessage[] = result.messages.map((msg) => ({
    type: msg.type as "warning" | "error",
    message: msg.message,
  }))

  // Extract headings from HTML
  const headings = extractHeadingsFromHtml(result.value)

  // mammoth writes merged cells as colspan / rowspan, so the HTML keeps the
  // grid the raw text loses (that has one paragraph per cell).
  const cheerio = await import("cheerio")
  const tables = htmlTables(cheerio.load(result.value))

  // Extract metadata from docx (it's a ZIP containing XML)
  let metadata: WordMetadata | undefined
  if (options.extractMetadata !== false) {
    metadata = await extractWordMetadata(data)
  }

  return {
    text: textResult.value,
    html: result.value,
    messages,
    images: extractedImages,
    metadata,
    headings,
    ...(tables.length > 0 ? { tables } : {}),
  }
}

/**
 * Extract headings from mammoth-generated HTML
 */
function extractHeadingsFromHtml(html: string): WordHeading[] {
  const headings: WordHeading[] = []
  const headingRegex = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi
  let match

  while ((match = headingRegex.exec(html)) !== null) {
    const level = parseInt(match[1], 10)
    // Strip HTML tags from heading text
    const text = match[2].replace(/<[^>]*>/g, "").trim()
    if (text) {
      headings.push({ level, text })
    }
  }

  return headings
}

/**
 * Metadata from a .docx package's `docProps/core.xml`.
 *
 * The part is read out of the ZIP: package members are normally deflated, so
 * searching the raw archive bytes for `<cp:coreProperties>` finds nothing in a
 * real Word file. A package without the part (or not a ZIP at all) has no
 * metadata; that is not a parse failure, since mammoth already read the body.
 */
async function extractWordMetadata(data: ArrayBuffer): Promise<WordMetadata | undefined> {
  let coreXml: string | undefined
  try {
    const JSZip = (await import("jszip")).default
    const zip = await JSZip.loadAsync(data)
    coreXml = await zip.file("docProps/core.xml")?.async("string")
  } catch {
    return undefined
  }
  if (!coreXml) return undefined
  const xml = coreXml

  const getTag = (tag: string): string | undefined => {
    const regex = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i")
    const m = xml.match(regex)
    const value = m ? decodeXmlText(m[1]).trim() : ""
    return value || undefined
  }

  const parseXmlDate = (dateStr?: string): Date | undefined => {
    if (!dateStr) return undefined
    const d = new Date(dateStr)
    return isNaN(d.getTime()) ? undefined : d
  }

  const revision = getTag("revision")
  const metadata: WordMetadata = {
    title: getTag("title"),
    author: getTag("creator"),
    lastModifiedBy: getTag("lastModifiedBy"),
    description: getTag("description"),
    subject: getTag("subject"),
    keywords: getTag("keywords"),
    created: parseXmlDate(getTag("created")),
    modified: parseXmlDate(getTag("modified")),
    revision: revision && /^\d+$/.test(revision) ? Number.parseInt(revision, 10) : undefined,
  }
  return Object.values(metadata).some((value) => value !== undefined) ? metadata : undefined
}

/** XML character data: the five predefined entities and numeric references. */
function decodeXmlText(input: string): string {
  return input
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * Parse Word document from File object
 */
export async function parseWordFile(
  file: File,
  options: WordParseOptions = {}
): Promise<WordParseResult> {
  const buffer = await file.arrayBuffer()
  return parseWord(buffer, options)
}

/**
 * Parse Excel file from ArrayBuffer.
 *
 * Rows are anchored at A1 (`data[r][c]` is the cell `encode_cell({ r, c })`),
 * so a sheet whose first value sits in C5 keeps its coordinates. Numbers keep
 * the value the workbook stores (to Excel's 15 significant digits), not the
 * cell's display rounding, and a date-formatted serial becomes its calendar
 * date. The materialised range is the tight bound of the stored cells, counted
 * against `maxExpandedCells` before anything is allocated.
 */
export async function parseExcel(
  data: ArrayBuffer,
  options: ExcelParseOptions = {}
): Promise<ExcelParseResult> {
  const XLSX = await import("xlsx")

  // `cellNF` keeps each cell's number format, which is how a date is told
  // apart from a number: both are stored as serials.
  const workbook = XLSX.read(data, { type: "array", cellNF: true })
  const budget = new DocumentBudget(
    "expanded-cells",
    options.maxExpandedCells ?? DEFAULT_DOCUMENT_LIMITS.maxExpandedCells
  )
  const sheets: ExcelSheet[] = []
  const textParts: string[] = []
  const allStats: ExcelSheetStats[] = []

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName]
    const rows = readSheetRows(XLSX, worksheet, budget)

    // Calculate dimensions
    const rowCount = rows.length
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)

    // Extract merged cells
    const merges = worksheet["!merges"] || []
    const mergedCells = merges.map(
      (merge: { s: { c: number; r: number }; e: { c: number; r: number } }) => {
        const startCol = XLSX.utils.encode_col(merge.s.c)
        const endCol = XLSX.utils.encode_col(merge.e.c)
        return `${startCol}${merge.s.r + 1}:${endCol}${merge.e.r + 1}`
      }
    )

    sheets.push({
      name: sheetName,
      data: rows,
      rowCount,
      columnCount,
      mergedCells: mergedCells.length > 0 ? mergedCells : undefined,
    })

    // Compute sheet statistics
    const stats = computeSheetStats(sheetName, rows, columnCount, mergedCells)
    allStats.push(stats)

    // Convert to text for embedding
    const sheetText = convertSheetToText(sheetName, rows, mergedCells)
    textParts.push(sheetText)
  }

  return {
    text: textParts.join("\n\n"),
    sheets,
    sheetNames: workbook.SheetNames,
    sheetStats: allStats.length > 0 ? allStats : undefined,
  }
}

type SheetJs = typeof import("xlsx")
type SheetCellValue = string | number | boolean | null

/** The stored cells of one sheet as A1-anchored rows, bounded by `budget`. */
function readSheetRows(
  XLSX: SheetJs,
  worksheet: import("xlsx").WorkSheet,
  budget: DocumentBudget
): SheetCellValue[][] {
  // The declared `!ref` comes from the file and can claim a million rows for
  // one stored cell; the stored addresses are what the sheet really holds.
  let maxRow = -1
  let maxCol = -1
  const addresses: Array<{ key: string; r: number; c: number }> = []
  for (const key of Object.keys(worksheet)) {
    if (key.startsWith("!")) continue
    const { r, c } = XLSX.utils.decode_cell(key)
    if (r < 0 || c < 0) continue
    addresses.push({ key, r, c })
    if (r > maxRow) maxRow = r
    if (c > maxCol) maxCol = c
  }
  if (maxRow < 0) return []
  budget.take((maxRow + 1) * (maxCol + 1))

  const rows: SheetCellValue[][] = Array.from({ length: maxRow + 1 }, () =>
    new Array<SheetCellValue>(maxCol + 1).fill(null)
  )
  for (const { key, r, c } of addresses) {
    rows[r][c] = sheetCellValue(XLSX, worksheet[key] as import("xlsx").CellObject)
  }
  // A row is as wide as its last stored cell, like `sheet_to_json` reported.
  return rows.map((row) => {
    let end = row.length
    while (end > 0 && row[end - 1] === null) end -= 1
    return end === row.length ? row : row.slice(0, end)
  })
}

/** The value a cell stores, as text the reader can trust. */
function sheetCellValue(XLSX: SheetJs, cell: import("xlsx").CellObject): SheetCellValue {
  if (cell.t === "z" || cell.v === undefined || cell.v === null) return null
  if (cell.t === "e") return cell.w ?? String(cell.v)
  if (cell.t === "b") return Boolean(cell.v)
  if (cell.t === "d") return cell.v instanceof Date ? cell.v.toISOString() : String(cell.v)
  if (cell.t === "n" && typeof cell.v === "number") {
    const format = typeof cell.z === "string" ? cell.z : ""
    if (format && XLSX.SSF.is_date(format)) return formatSerialDate(XLSX, cell.v) ?? cell.v
    return cell.v
  }
  return String(cell.v)
}

/**
 * A date serial as `YYYY-MM-DD` (plus `HH:MM[:SS]` when it has a time part).
 * `SSF.parse_date_code` reads the serial's own calendar fields, so the result
 * does not shift with the machine's time zone the way a `Date` would.
 */
function formatSerialDate(XLSX: SheetJs, serial: number): string | null {
  const parts = XLSX.SSF.parse_date_code(serial) as
    { y: number; m: number; d: number; H: number; M: number; S: number } | undefined
  if (!parts) return null
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  const date = `${pad(parts.y, 4)}-${pad(parts.m)}-${pad(parts.d)}`
  if (!parts.H && !parts.M && !parts.S) return date
  return `${date} ${pad(parts.H)}:${pad(parts.M)}${parts.S ? `:${pad(parts.S)}` : ""}`
}

/**
 * Compute statistics for an Excel sheet
 */
export function computeSheetStats(
  name: string,
  data: (string | number | boolean | null)[][],
  columnCount: number,
  mergedCells: string[]
): ExcelSheetStats {
  let totalCells = 0
  let emptyCells = 0
  const colTypeCounts: Record<number, Record<string, number>> = {}

  for (const row of data) {
    for (let col = 0; col < columnCount; col++) {
      totalCells++
      const val = col < row.length ? row[col] : null

      if (val === null || val === undefined || val === "") {
        emptyCells++
        continue
      }

      if (!colTypeCounts[col]) colTypeCounts[col] = {}

      let cellType: string
      if (typeof val === "object" && val !== null && "getTime" in val) {
        cellType = "date"
      } else if (typeof val === "number") {
        cellType = "number"
      } else if (typeof val === "boolean") {
        cellType = "boolean"
      } else {
        // Check if string looks like a date
        const strVal = String(val)
        if (/^\d{4}-\d{2}-\d{2}/.test(strVal) && !isNaN(Date.parse(strVal))) {
          cellType = "date"
        } else {
          cellType = "string"
        }
      }

      colTypeCounts[col][cellType] = (colTypeCounts[col][cellType] || 0) + 1
    }
  }

  const columnTypes: Record<number, "string" | "number" | "date" | "boolean" | "mixed"> = {}
  for (const [col, types] of Object.entries(colTypeCounts)) {
    const typeEntries = Object.entries(types)
    if (typeEntries.length === 1) {
      columnTypes[Number(col)] = typeEntries[0][0] as "string" | "number" | "date" | "boolean"
    } else {
      columnTypes[Number(col)] = "mixed"
    }
  }

  return {
    name,
    rowCount: data.length,
    columnCount,
    mergedCellCount: mergedCells.length,
    emptyRate: totalCells > 0 ? emptyCells / totalCells : 0,
    columnTypes,
  }
}

/**
 * Parse Excel file from File object
 */
export async function parseExcelFile(
  file: File,
  options: ExcelParseOptions = {}
): Promise<ExcelParseResult> {
  const buffer = await file.arrayBuffer()
  return parseExcel(buffer, options)
}

/**
 * Convert Excel sheet data to readable text
 */
export function convertSheetToText(
  sheetName: string,
  data: (string | number | boolean | null)[][],
  mergedCells?: string[]
): string {
  const lines: string[] = [`## Sheet: ${sheetName}`]

  if (data.length === 0) {
    lines.push("(empty sheet)")
    return lines.join("\n")
  }

  // Note merged cells if present
  if (mergedCells && mergedCells.length > 0) {
    lines.push(`Merged cells: ${mergedCells.join(", ")}`)
  }

  // Use first row as header if it looks like headers
  const hasHeader = sheetHasHeaderRow(data)

  // Every row is as wide as the widest, so a cell's position in the line is
  // its column whatever the row stored.
  const width = data.reduce((max, row) => Math.max(max, row.length), 0)
  const line = (row: (string | number | boolean | null)[]) =>
    Array.from({ length: width }, (_, column) => formatCellValue(row[column] ?? null)).join(" | ")

  if (hasHeader) {
    lines.push(line(data[0]))
    lines.push(Array.from({ length: width }, () => "---").join(" | "))
    for (let i = 1; i < data.length; i++) lines.push(line(data[i]))
  } else {
    // No header, just convert rows
    for (const row of data) lines.push(line(row))
  }

  return lines.join("\n")
}

/**
 * The document for either of mammoth's builds. The app bundles its browser
 * build (through the package's `browser` field), which reads `arrayBuffer`;
 * Node hosts (the CLI's attachments) load its Node build, which reads only
 * `buffer` or `path` and refuses an `arrayBuffer` with "Could not find file in
 * options". Where Node's `Buffer` exists both keys are given, over the same
 * bytes.
 */
function mammothInput(data: ArrayBuffer): { arrayBuffer: ArrayBuffer } {
  if (typeof Buffer === "undefined") return { arrayBuffer: data }
  const input: { arrayBuffer: ArrayBuffer; buffer: Buffer } = {
    arrayBuffer: data,
    buffer: Buffer.from(data),
  }
  return input
}

/**
 * Format cell value for text output
 */
function formatCellValue(value: string | number | boolean | null): string {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE"
  }
  if (typeof value === "number") return formatStoredNumber(value)
  // A cell's own line breaks and pipes would read as new rows and columns.
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

/**
 * Extract embeddable content from Word document
 */
export function extractWordEmbeddableContent(result: WordParseResult): string {
  const parts: string[] = []

  if (result.metadata?.title) {
    parts.push(`Title: ${result.metadata.title}`)
  }
  if (result.metadata?.author) {
    parts.push(`Author: ${result.metadata.author}`)
  }

  // Include heading structure for context
  if (result.headings && result.headings.length > 0) {
    parts.push("Document Structure:")
    parts.push(
      result.headings
        .map((h) => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}`)
        .join("\n")
    )
  }

  parts.push(result.text)

  return parts.join("\n\n")
}

/**
 * Extract embeddable content from Excel file
 */
export function extractExcelEmbeddableContent(result: ExcelParseResult): string {
  const parts: string[] = []

  // Include sheet statistics summary
  if (result.sheetStats && result.sheetStats.length > 0) {
    const summary = result.sheetStats
      .map(
        (s) =>
          `${s.name}: ${s.rowCount} rows × ${s.columnCount} cols` +
          (s.mergedCellCount > 0 ? `, ${s.mergedCellCount} merged` : "")
      )
      .join("; ")
    parts.push(`Sheets: ${summary}`)
  }

  parts.push(result.text)

  return parts.join("\n\n")
}

/**
 * Detect Office file type from extension
 */
export function detectOfficeType(filename: string): "word" | "excel" | "unknown" {
  const ext = filename.split(".").pop()?.toLowerCase() || ""

  if (["docx", "doc", "docm", "odt"].includes(ext)) {
    return "word"
  }
  if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) {
    return "excel"
  }

  return "unknown"
}
