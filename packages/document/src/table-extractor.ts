/**
 * Table Extractor - Extract and parse tables from various formats
 * Supports Markdown, HTML, and message content
 */

import {
  delimitedTable,
  placeTableRows,
  tableGrid,
  type SourceRowGroup,
  type SourceTableCell,
} from "./document-tables"
import { DocumentLimitError } from "./limits"
import type { DocumentTable } from "./types"

// TableData is inlined here (mirrors `lib/export/document/excel-export.ts`
// in Cognia). cognia-next does not yet host the Excel export module, so we
// keep the structural contract local — `extractedTableToTableData` is the
// only consumer in this file, and downstream callers in cognia-next assert
// on this same shape.
export interface TableData {
  headers: string[]
  rows: (string | number | boolean | null | undefined)[][]
  title?: string
}

export interface ExtractedTable {
  headers: string[]
  rows: string[][]
  title?: string
  sourceType: "markdown" | "html" | "text"
  startIndex: number
  endIndex: number
}

export interface TableExtractionResult {
  tables: ExtractedTable[]
  hasTable: boolean
  tableCount: number
}

/**
 * Extract all tables from content (auto-detect format)
 */
export function extractTables(content: string): TableExtractionResult {
  const markdownTables = extractMarkdownTables(content)
  const htmlTables = extractHTMLTables(content)

  const tables = [...markdownTables, ...htmlTables]

  return {
    tables,
    hasTable: tables.length > 0,
    tableCount: tables.length,
  }
}

/**
 * Extract Markdown tables from content
 */
export function extractMarkdownTables(content: string): ExtractedTable[] {
  const tables: ExtractedTable[] = []
  const lines = content.split("\n")

  let tableStart = -1
  let tableLines: string[] = []
  let inTable = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Check if line is a table row (starts and ends with |)
    const isTableRow = line.startsWith("|") && line.endsWith("|")
    // Check if it's a separator row (contains only |, -, :, and spaces)
    const isSeparatorRow = /^\|[\s\-:|]+\|$/.test(line)

    if (isTableRow || isSeparatorRow) {
      if (!inTable) {
        inTable = true
        tableStart = i
        tableLines = []
      }
      tableLines.push(line)
    } else if (inTable) {
      // End of table
      const table = parseMarkdownTableLines(tableLines, tableStart, i - 1)
      if (table) {
        tables.push(table)
      }
      inTable = false
      tableLines = []
    }
  }

  // Handle table at end of content
  if (inTable && tableLines.length > 0) {
    const table = parseMarkdownTableLines(tableLines, tableStart, lines.length - 1)
    if (table) {
      tables.push(table)
    }
  }

  return tables
}

/**
 * Parse markdown table lines into ExtractedTable
 */
function parseMarkdownTableLines(
  lines: string[],
  startIndex: number,
  endIndex: number
): ExtractedTable | null {
  if (lines.length < 2) return null

  // First line is headers
  const headerLine = lines[0]
  const headers = parseTableRow(headerLine)

  if (headers.length === 0) return null

  // Second line should be separator (---)
  const separatorLine = lines[1]
  if (!/^\|[\s\-:|]+\|$/.test(separatorLine)) {
    // No separator, treat first row as data
    const rows = lines.map(parseTableRow)
    return {
      headers: rows[0] || [],
      rows: rows.slice(1),
      sourceType: "markdown",
      startIndex,
      endIndex,
    }
  }

  // Parse data rows (skip separator)
  const rows = lines.slice(2).map(parseTableRow)

  return {
    headers,
    rows,
    sourceType: "markdown",
    startIndex,
    endIndex,
  }
}

/**
 * Parse a single table row
 */
function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell, index, arr) => {
      // Remove empty first and last cells (from leading/trailing |)
      if (index === 0 && cell === "") return false
      if (index === arr.length - 1 && cell === "") return false
      return true
    })
}

/**
 * Extract HTML tables from content
 */
export function extractHTMLTables(content: string): ExtractedTable[] {
  const tables: ExtractedTable[] = []

  // Simple regex-based extraction (for basic tables)
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi
  let match

  while ((match = tableRegex.exec(content)) !== null) {
    const tableHtml = match[0]
    const startIndex = match.index
    const endIndex = startIndex + tableHtml.length

    const table = parseHTMLTable(tableHtml, startIndex, endIndex)
    if (table) {
      tables.push(table)
    }
  }

  return tables
}

/**
 * Parse HTML table string into ExtractedTable. The cells go on the grid the
 * way the HTML table model places them (`placeTableRows`), so a `colspan` or
 * `rowspan` no longer shifts every later value a column left; a merged value
 * is repeated into the positions it covers. The first row is the headers.
 */
function parseHTMLTable(html: string, startIndex: number, endIndex: number): ExtractedTable | null {
  const table = htmlGridTable(html)
  if (!table) return null
  const { grid } = tableGrid({ index: 0, ...table })
  return {
    headers: grid[0],
    rows: grid.slice(1),
    ...(table.caption ? { title: table.caption } : {}),
    sourceType: "html",
    startIndex,
    endIndex,
  }
}

/**
 * One `<table>`'s markup as a typed grid, or `null` for a table with no
 * cells or one whose spans would lay out past the cell budget.
 */
function htmlGridTable(html: string): Omit<DocumentTable, "index"> | null {
  let placed: ReturnType<typeof placeTableRows>
  try {
    placed = placeTableRows(htmlRowGroups(html))
  } catch (error) {
    if (error instanceof DocumentLimitError) return null
    throw error
  }
  if (placed.rowCount === 0 || placed.columnCount === 0) return null
  const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(html)
  const captionText = caption ? stripHtmlTags(caption[1]).replace(/\s+/g, " ").trim() : ""
  return { ...(captionText ? { caption: captionText } : {}), ...placed }
}

/**
 * The tables in Markdown or HTML content as typed grids, in the order they
 * appear: GFM pipe tables (a header row over a `---` separator) headed by
 * that row, unless it is empty, and HTML tables with their spans. An OCR
 * provider writes a page's tables either way (Azure Document Intelligence
 * as HTML, others as pipe tables).
 */
export function extractDocumentTables(content: string): DocumentTable[] {
  const found: { offset: number; table: Omit<DocumentTable, "index"> }[] = []
  const lines = content.split("\n")
  const lineOffsets: number[] = []
  let offset = 0
  for (const line of lines) {
    lineOffsets.push(offset)
    offset += line.length + 1
  }
  for (const table of extractMarkdownTables(content)) {
    if (!/^\|[\s\-:|]+\|$/.test(lines[table.startIndex + 1]?.trim() ?? "")) continue
    const headers = table.headers.some((header) => header !== "") ? table.headers : []
    const { index: _index, ...typed } = delimitedTable(headers, table.rows, 0)
    if (typed.rowCount > 0 && typed.columnCount > 0) {
      found.push({ offset: lineOffsets[table.startIndex], table: typed })
    }
  }
  const tableRegex = /<table\b[^>]*>[\s\S]*?<\/table>/gi
  let match
  while ((match = tableRegex.exec(content)) !== null) {
    const table = htmlGridTable(match[0])
    if (table) found.push({ offset: match.index, table })
  }
  return found
    .sort((a, b) => a.offset - b.offset)
    .map(({ table }, index) => ({ index: index + 1, ...table }))
}

/** A table's rows by section: `<thead>`, each body and loose rows in order, `<tfoot>` last. */
function htmlRowGroups(html: string): SourceRowGroup[] {
  const inner = html.replace(/^<table\b[^>]*>/i, "").replace(/<\/table>$/i, "")
  const groups: SourceRowGroup[] = []
  const footer: SourceTableCell[][] = []
  const addLoose = (markup: string) => {
    const rows = htmlRows(markup)
    if (rows.length > 0) groups.push({ header: false, rows })
  }
  const sectionRegex = /<(thead|tbody|tfoot)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let last = 0
  let match
  while ((match = sectionRegex.exec(inner)) !== null) {
    addLoose(inner.slice(last, match.index))
    const rows = htmlRows(match[2])
    const section = match[1].toLowerCase()
    if (section === "tfoot") footer.push(...rows)
    else groups.push({ header: section === "thead", rows })
    last = match.index + match[0].length
  }
  addLoose(inner.slice(last))
  if (footer.length > 0) groups.push({ header: false, rows: footer })
  return groups
}

/** The `<tr>` rows in `markup`, each its `<td>` / `<th>` cells with their span attributes. */
function htmlRows(markup: string): SourceTableCell[][] {
  const rows: SourceTableCell[][] = []
  const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let trMatch
  while ((trMatch = trRegex.exec(markup)) !== null) {
    const cells: SourceTableCell[] = []
    const cellRegex = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi
    let cellMatch
    while ((cellMatch = cellRegex.exec(trMatch[1])) !== null) {
      cells.push({
        text: stripHtmlTags(cellMatch[3]).trim(),
        colspan: htmlAttribute(cellMatch[2], "colspan"),
        rowspan: htmlAttribute(cellMatch[2], "rowspan"),
        header: cellMatch[1].toLowerCase() === "th",
      })
    }
    rows.push(cells)
  }
  return rows
}

/** One attribute's value from a tag's attribute text, quoted or not. */
function htmlAttribute(attributes: string, name: "colspan" | "rowspan"): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(
    attributes
  )
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined
}

/**
 * Strip HTML tags from string
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .trim()
}

/**
 * Detect if message content contains a table
 */
export function hasTable(content: string): boolean {
  // Check for markdown table
  const hasMarkdownTable = /^\|.+\|$/m.test(content) && /^\|[\s\-:|]+\|$/m.test(content)

  // Check for HTML table
  const hasHtmlTable = /<table[^>]*>/i.test(content)

  return hasMarkdownTable || hasHtmlTable
}

/**
 * Convert ExtractedTable to TableData format
 */
export function extractedTableToTableData(table: ExtractedTable): TableData {
  return {
    headers: table.headers,
    rows: table.rows,
    title: table.title,
  }
}

/**
 * Extract first table from content
 */
export function extractFirstTable(content: string): ExtractedTable | null {
  const result = extractTables(content)
  return result.tables[0] || null
}

/**
 * Convert plain text table to structured data
 * Handles space/tab separated values
 */
export function parseTextTable(content: string): ExtractedTable | null {
  const lines = content
    .trim()
    .split("\n")
    .filter((line) => line.trim())

  if (lines.length < 2) return null

  // Detect delimiter (tab or multiple spaces)
  const firstLine = lines[0]
  const delimiter = firstLine.includes("\t") ? "\t" : /\s{2,}/

  const allRows = lines.map((line) => {
    if (typeof delimiter === "string") {
      return line.split(delimiter).map((cell) => cell.trim())
    }
    return line.split(delimiter).map((cell) => cell.trim())
  })

  // Use first row as headers
  const headers = allRows[0]
  const rows = allRows.slice(1)

  return {
    headers,
    rows,
    sourceType: "text",
    startIndex: 0,
    endIndex: content.length,
  }
}

/**
 * Validate table structure
 */
export function validateTable(table: ExtractedTable): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (table.headers.length === 0) {
    errors.push("Table has no headers")
  }

  if (table.rows.length === 0) {
    errors.push("Table has no data rows")
  }

  // Check for consistent column count
  const headerCount = table.headers.length
  const inconsistentRows = table.rows.filter((row) => row.length !== headerCount)

  if (inconsistentRows.length > 0) {
    errors.push(`${inconsistentRows.length} rows have inconsistent column count`)
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Normalize table (ensure all rows have same column count)
 */
export function normalizeTable(table: ExtractedTable): ExtractedTable {
  const maxColumns = Math.max(table.headers.length, ...table.rows.map((row) => row.length))

  // Pad headers if needed
  const headers = [...table.headers]
  while (headers.length < maxColumns) {
    headers.push(`Column ${headers.length + 1}`)
  }

  // Pad/trim rows to match column count
  const rows = table.rows.map((row) => {
    const newRow = [...row]
    while (newRow.length < maxColumns) {
      newRow.push("")
    }
    return newRow.slice(0, maxColumns)
  })

  return {
    ...table,
    headers,
    rows,
  }
}

/**
 * Merge multiple tables into one
 */
export function mergeTables(tables: ExtractedTable[]): ExtractedTable | null {
  if (tables.length === 0) return null
  if (tables.length === 1) return tables[0]

  // Use headers from first table
  const headers = tables[0].headers

  // Combine all rows
  const rows = tables.flatMap((table) => table.rows)

  return {
    headers,
    rows,
    sourceType: "markdown",
    startIndex: 0,
    endIndex: 0,
  }
}

/**
 * Convert table to markdown format
 */
export function tableToMarkdown(table: ExtractedTable): string {
  const lines: string[] = []

  // Header row
  lines.push("| " + table.headers.join(" | ") + " |")

  // Separator row
  lines.push("| " + table.headers.map(() => "---").join(" | ") + " |")

  // Data rows
  for (const row of table.rows) {
    // Pad row to match header length
    const paddedRow = [...row]
    while (paddedRow.length < table.headers.length) {
      paddedRow.push("")
    }
    lines.push("| " + paddedRow.slice(0, table.headers.length).join(" | ") + " |")
  }

  return lines.join("\n")
}

/**
 * Get table statistics
 */
export function getTableStats(table: ExtractedTable): {
  rowCount: number
  columnCount: number
  cellCount: number
  emptyCount: number
  numericColumnCount: number
} {
  const rowCount = table.rows.length
  const columnCount = table.headers.length
  const cellCount = rowCount * columnCount

  let emptyCount = 0
  const numericColumns = new Set<number>()

  for (let colIndex = 0; colIndex < columnCount; colIndex++) {
    let isNumeric = true

    for (const row of table.rows) {
      const cell = row[colIndex]

      if (!cell || cell.trim() === "") {
        emptyCount++
      }

      if (cell && isNaN(Number(cell))) {
        isNumeric = false
      }
    }

    if (isNumeric && table.rows.length > 0) {
      numericColumns.add(colIndex)
    }
  }

  return {
    rowCount,
    columnCount,
    cellCount,
    emptyCount,
    numericColumnCount: numericColumns.size,
  }
}
