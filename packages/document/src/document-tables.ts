/**
 * Tables as typed grids (G3).
 *
 * A table is its cells, each anchored at its top-left row and column with how
 * many rows and columns it spans, whether it heads the table and, from a
 * spreadsheet, the value it stores. A position a merge covers holds no cell.
 * Markdown, CSV and plain text are projections of this grid: Markdown has no
 * merged cells, so `tableToMarkdown` repeats a merged value into the positions
 * it covers and says how many it repeated, rather than shifting the columns
 * the way reading `<td>`s in order did (a `colspan="2"` cell used to push
 * every cell after it one column left).
 */

import type { CheerioAPI } from "cheerio"
import { DEFAULT_DOCUMENT_LIMITS, DocumentBudget } from "./limits"
import type { DocumentTable, DocumentTableCell, DocumentTableValue } from "./types"

type Selection = ReturnType<CheerioAPI>

/** HTML caps a cell's spans here (`colspan` at 1000, `rowspan` at 65534). */
const MAX_COLUMN_SPAN = 1000
const MAX_ROW_SPAN = 65534

/**
 * A stored number as text. Excel keeps 15 significant digits; cutting there
 * drops binary noise (`0.30000000000000004`) without rounding a real value the
 * way a fixed decimal count would (`0.00012345` is not `0.00`).
 */
export function formatStoredNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (Number.isInteger(value)) return value.toString()
  return String(Number(value.toPrecision(15)))
}

/** A typed cell value as the cell shows it. */
export function cellValueText(value: DocumentTableValue): string {
  if (value === null) return ""
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "number") return formatStoredNumber(value)
  return value
}

/**
 * Whether a sheet's first row labels its columns: it holds text and nothing
 * else (an empty cell, such as one a merged label covers, is allowed), and
 * there is a row of data under it.
 */
export function sheetHasHeaderRow(data: readonly (readonly DocumentTableValue[])[]): boolean {
  const first = data[0]
  return (
    data.length > 1 &&
    first !== undefined &&
    first.some((cell) => typeof cell === "string") &&
    first.every((cell) => cell === null || typeof cell === "string")
  )
}

/** Spreadsheet column letters for a 0-based index (0 → A, 26 → AA). */
export function columnLetters(index: number): string {
  let name = ""
  let current = index + 1
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return name
}

/** `A1:C3` as 0-based inclusive bounds, or `null` for something that is not a range. */
export function parseCellRange(
  range: string
): { top: number; left: number; bottom: number; right: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(range.trim())
  if (!match) return null
  const column = (letters: string) =>
    Array.from(letters.toUpperCase()).reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) -
    1
  const top = Number(match[2]) - 1
  const left = column(match[1])
  const bottom = match[4] ? Number(match[4]) - 1 : top
  const right = match[3] ? column(match[3]) : left
  if (top < 0 || bottom < 0) return null
  return {
    top: Math.min(top, bottom),
    left: Math.min(left, right),
    bottom: Math.max(top, bottom),
    right: Math.max(left, right),
  }
}

/** The HTML "rules for parsing non-negative integers", for a span attribute. */
function spanAttribute(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const match = /^\s*\+?(\d+)/.exec(raw)
  return match ? Number(match[1]) : null
}

/** A cell's text: line breaks and block boundaries kept, other whitespace collapsed. */
function htmlCellText($: CheerioAPI, cell: Selection): string {
  const clone = cell.clone()
  clone.find("br").replaceWith("\n")
  clone.find("p, div, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote").each((_, element) => {
    $(element).prepend("\n").append("\n")
  })
  return clone
    .text()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

/** A cell as its source wrote it: its text, its raw span attributes, whether it is a header cell. */
export interface SourceTableCell {
  text: string
  colspan?: string
  rowspan?: string
  header: boolean
}

/** A row group (`<thead>`, a body, the footer or loose rows), each row its cells. */
export interface SourceRowGroup {
  header: boolean
  rows: readonly (readonly SourceTableCell[])[]
}

/**
 * Rows on a grid by the HTML table model: each cell takes the first column its
 * row has free, a `colspan` of `0` is `1`, and a `rowspan` reaches at most to
 * the end of its row group (`0` means exactly that). The whole grid, the
 * positions no cell covers included, is counted against `budget`: that is
 * what a projection of the table lays out.
 */
export function placeTableRows(
  groups: readonly SourceRowGroup[],
  budget = new DocumentBudget("expanded-cells", DEFAULT_DOCUMENT_LIMITS.maxExpandedCells)
): Pick<DocumentTable, "rowCount" | "columnCount" | "headerRowCount" | "cells"> {
  const cells: DocumentTableCell[] = []
  const occupied = new Map<number, Set<number>>()
  const headerRows = new Set<number>()
  let row = 0
  let columnCount = 0
  let spanned = 0
  for (const group of groups) {
    const groupEnd = row + group.rows.length
    for (const sourceRow of group.rows) {
      if (group.header) headerRows.add(row)
      let column = 0
      for (const source of sourceRow) {
        while (occupied.get(row)?.has(column)) column += 1
        const columnSpanRaw = spanAttribute(source.colspan)
        const columnSpan =
          columnSpanRaw === null || columnSpanRaw === 0
            ? 1
            : Math.min(columnSpanRaw, MAX_COLUMN_SPAN)
        const rowSpanRaw = spanAttribute(source.rowspan)
        const rowSpan = Math.min(
          rowSpanRaw === null
            ? 1
            : rowSpanRaw === 0
              ? groupEnd - row
              : Math.min(rowSpanRaw, MAX_ROW_SPAN),
          groupEnd - row
        )
        budget.take(rowSpan * columnSpan)
        spanned += rowSpan * columnSpan
        for (let r = row; r < row + rowSpan; r += 1) {
          let taken = occupied.get(r)
          if (!taken) {
            taken = new Set()
            occupied.set(r, taken)
          }
          for (let c = column; c < column + columnSpan; c += 1) taken.add(c)
        }
        const header = group.header || source.header
        cells.push({
          row,
          column,
          rowSpan,
          columnSpan,
          text: source.text,
          ...(header ? { header: true } : {}),
        })
        column += columnSpan
        columnCount = Math.max(columnCount, column)
      }
      row += 1
    }
  }
  // The positions no cell covers: one wide cell over many narrow rows makes a
  // grid far larger than its cells.
  budget.take(Math.max(0, row * columnCount - spanned))

  // Without a <thead>, the leading rows whose cells are all header cells head it.
  let headerRowCount = 0
  if (headerRows.size > 0) {
    while (headerRows.has(headerRowCount)) headerRowCount += 1
  } else {
    for (let r = 0; r < row; r += 1) {
      const anchored = cells.filter((cell) => cell.row === r)
      if (anchored.length === 0 || !anchored.every((cell) => cell.header)) break
      headerRowCount += 1
    }
  }
  return { rowCount: row, columnCount, headerRowCount, cells }
}

/**
 * One `<table>` as a grid (`placeTableRows`): rows come from `<thead>`, the
 * body groups and direct `<tr>` children in order, with `<tfoot>` last.
 */
export function htmlTable(
  $: CheerioAPI,
  table: Selection,
  index: number,
  budget = new DocumentBudget("expanded-cells", DEFAULT_DOCUMENT_LIMITS.maxExpandedCells)
): DocumentTable {
  const groups: { header: boolean; rows: SourceTableCell[][] }[] = []
  const footer: SourceTableCell[][] = []
  let loose: { header: boolean; rows: SourceTableCell[][] } | null = null
  const sourceRow = (tr: Selection): SourceTableCell[] =>
    tr
      .children("td, th")
      .toArray()
      .map((element) => {
        const cell = $(element)
        return {
          text: htmlCellText($, cell),
          colspan: cell.attr("colspan"),
          rowspan: cell.attr("rowspan"),
          header: cell.is("th"),
        }
      })
  table.children().each((_, child) => {
    const element = $(child)
    if (element.is("tr")) {
      if (!loose) {
        loose = { header: false, rows: [] }
        groups.push(loose)
      }
      loose.rows.push(sourceRow(element))
      return
    }
    loose = null
    const rows = element
      .children("tr")
      .toArray()
      .map((tr) => sourceRow($(tr)))
    if (element.is("thead")) groups.push({ header: true, rows })
    else if (element.is("tbody")) groups.push({ header: false, rows })
    else if (element.is("tfoot")) footer.push(...rows)
  })
  if (footer.length > 0) groups.push({ header: false, rows: footer })

  const caption = table.children("caption").first().text().replace(/\s+/g, " ").trim()
  return {
    index,
    ...(caption ? { caption } : {}),
    ...placeTableRows(groups, budget),
  }
}

/** Every `<table>` in the document, in document order, nested ones included. */
export function htmlTables($: CheerioAPI, root?: Selection): DocumentTable[] {
  const budget = new DocumentBudget("expanded-cells", DEFAULT_DOCUMENT_LIMITS.maxExpandedCells)
  return (root ?? $.root())
    .find("table")
    .toArray()
    .map((table, index) => htmlTable($, $(table), index + 1, budget))
}

/**
 * Stored rows as a grid: values typed, merged ranges as spans anchored at
 * their top-left, the first `headerRowCount` rows heading it. The grid, which
 * merges past the stored cells widen, is counted against `budget` before any
 * of it is built.
 */
export function mergedGridTable(
  grid: {
    data: readonly (readonly DocumentTableValue[])[]
    columnCount: number
    mergedCells?: readonly string[]
    headerRowCount: number
  },
  index: number,
  budget = new DocumentBudget("expanded-cells", DEFAULT_DOCUMENT_LIMITS.maxExpandedCells)
): DocumentTable {
  const merges = (grid.mergedCells ?? [])
    .map(parseCellRange)
    .filter((range): range is NonNullable<typeof range> => range !== null)
  let rowCount = grid.data.length
  let columnCount = grid.columnCount
  for (const merge of merges) {
    rowCount = Math.max(rowCount, merge.bottom + 1)
    columnCount = Math.max(columnCount, merge.right + 1)
  }
  // The merges reaching each stored row, so a covered position is found
  // without materialising every cell a merge spans. Merges that do not
  // overlap (all a spreadsheet application writes) give no more of those
  // entries, and no more merges, than the grid has positions; overlapping
  // ones are counted for what they cost.
  const rowsInData = (merge: (typeof merges)[number]) =>
    Math.max(0, Math.min(merge.bottom, grid.data.length - 1) - merge.top + 1)
  const entries = merges.reduce((sum, merge) => sum + rowsInData(merge), 0)
  budget.take(Math.max(rowCount * columnCount, entries, merges.length))
  const mergesByRow = new Map<number, (typeof merges)[number][]>()
  for (const merge of merges) {
    for (let r = merge.top; r < merge.top + rowsInData(merge); r += 1) {
      const list = mergesByRow.get(r)
      if (list) list.push(merge)
      else mergesByRow.set(r, [merge])
    }
  }

  const cells: DocumentTableCell[] = []
  const anchored = new Set<(typeof merges)[number]>()
  grid.data.forEach((values, r) => {
    for (let c = 0; c < values.length; c += 1) {
      const merge = mergesByRow.get(r)?.find((range) => c >= range.left && c <= range.right)
      const anchor = merge !== undefined && merge.top === r && merge.left === c
      if (merge && !anchor) continue
      const value = values[c] ?? null
      if (value === null && !anchor) continue
      if (merge) anchored.add(merge)
      cells.push({
        row: r,
        column: c,
        rowSpan: merge ? merge.bottom - merge.top + 1 : 1,
        columnSpan: merge ? merge.right - merge.left + 1 : 1,
        text: cellValueText(value),
        value,
      })
    }
  })
  // A merge whose top-left holds nothing still occupies its range.
  for (const merge of merges) {
    if (anchored.has(merge)) continue
    cells.push({
      row: merge.top,
      column: merge.left,
      rowSpan: merge.bottom - merge.top + 1,
      columnSpan: merge.right - merge.left + 1,
      text: "",
      value: null,
    })
  }
  cells.sort((a, b) => a.row - b.row || a.column - b.column)

  const headerRowCount = Math.min(Math.max(0, grid.headerRowCount), rowCount)
  for (const cell of cells) if (cell.row < headerRowCount) cell.header = true
  return { index, rowCount, columnCount, headerRowCount, cells }
}

/**
 * A spreadsheet sheet as a grid (`mergedGridTable`), its first row heading it
 * when that row labels the columns, located by the sheet's used range.
 */
export function sheetTable(
  sheet: {
    name: string
    data: readonly (readonly DocumentTableValue[])[]
    columnCount: number
    mergedCells?: readonly string[]
  },
  index: number,
  budget = new DocumentBudget("expanded-cells", DEFAULT_DOCUMENT_LIMITS.maxExpandedCells)
): DocumentTable {
  const table = mergedGridTable(
    { ...sheet, headerRowCount: sheetHasHeaderRow(sheet.data) ? 1 : 0 },
    index,
    budget
  )
  if (table.rowCount === 0 || table.columnCount === 0) return table
  return {
    ...table,
    locator: {
      type: "sheet",
      sheet: sheet.name,
      range: `A1:${columnLetters(table.columnCount - 1)}${table.rowCount}`,
    },
  }
}

/** A delimited file's rows as one grid of text cells, its header row heading it. */
export function delimitedTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  index: number
): DocumentTable {
  const all = headers.length > 0 ? [headers, ...rows] : rows
  const cells: DocumentTableCell[] = []
  let columnCount = 0
  all.forEach((values, r) => {
    columnCount = Math.max(columnCount, values.length)
    values.forEach((text, c) => {
      if (text === "") return
      cells.push({
        row: r,
        column: c,
        rowSpan: 1,
        columnSpan: 1,
        text,
        ...(r === 0 && headers.length > 0 ? { header: true } : {}),
      })
    })
  })
  return {
    index,
    rowCount: all.length,
    columnCount,
    headerRowCount: headers.length > 0 ? 1 : 0,
    cells,
  }
}

/** The table's text by position, merged values repeated into what they cover. */
export function tableGrid(table: DocumentTable): { grid: string[][]; repeated: number } {
  const grid = Array.from({ length: table.rowCount }, () =>
    Array.from({ length: table.columnCount }, () => "")
  )
  let repeated = 0
  for (const cell of table.cells) {
    for (let r = cell.row; r < Math.min(cell.row + cell.rowSpan, table.rowCount); r += 1) {
      for (
        let c = cell.column;
        c < Math.min(cell.column + cell.columnSpan, table.columnCount);
        c += 1
      ) {
        grid[r][c] = cell.text
        if ((r !== cell.row || c !== cell.column) && cell.text !== "") repeated += 1
      }
    }
  }
  return { grid, repeated }
}

/** How many starts `locateTables` tries before it gives a table no locator. */
const MAX_LOCATE_ATTEMPTS = 50

const markdownCell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, "<br>")

/**
 * The table as a GFM pipe table. Markdown has no merged cells, so a merged
 * value is repeated into every position it covers (a region column merged
 * over three rows reads as that region on each row); `repeatedCells` counts
 * those, for the caller to disclose. A table without header rows gets an
 * empty header row, since GFM requires one.
 */
export function tableToMarkdown(table: DocumentTable): { markdown: string; repeatedCells: number } {
  if (table.rowCount === 0 || table.columnCount === 0) return { markdown: "", repeatedCells: 0 }
  const { grid, repeated } = tableGrid(table)
  const line = (values: readonly string[]) => `| ${values.map(markdownCell).join(" | ")} |`
  // GFM has one header row: later header rows stay rows of the body.
  const header = table.headerRowCount > 0 ? grid[0] : grid[0].map(() => "")
  const body = grid.slice(table.headerRowCount > 0 ? 1 : 0)
  const lines = [
    ...(table.caption ? [`*${markdownCell(table.caption)}*`, ""] : []),
    line(header),
    line(header.map(() => "---")),
    ...body.map(line),
  ]
  return { markdown: lines.join("\n"), repeatedCells: repeated }
}

/**
 * Set each table's text locator to where its cells appear in `content`, in
 * order: the first position from which every non-empty cell text is found in
 * reading order, after the previous table. A table whose cells cannot be found
 * that way (a pipe escaped in Markdown, text the projection rewrote) keeps no
 * text locator rather than a guessed one.
 */
export function locateTables(content: string, tables: readonly DocumentTable[]): DocumentTable[] {
  let from = 0
  return tables.map((table) => {
    if (table.locator) return table
    const texts = [...table.cells]
      .sort((a, b) => a.row - b.row || a.column - b.column)
      .map((cell) => cell.text.split("\n")[0])
      .filter((text) => text.length > 0)
    if (texts.length === 0) return table
    let start = content.indexOf(texts[0], from)
    for (let attempt = 0; start !== -1 && attempt < MAX_LOCATE_ATTEMPTS; attempt += 1) {
      let end = start + texts[0].length
      let second = -1
      let found = true
      for (const text of texts.slice(1)) {
        const at = content.indexOf(text, end)
        if (at === -1) {
          found = false
          break
        }
        if (second === -1) second = at
        end = at + text.length
      }
      if (found) {
        // The table begins at the first cell's last occurrence before the
        // second's, not at the word's first mention earlier in the prose.
        const begin =
          second === -1 ? start : content.lastIndexOf(texts[0], second - texts[0].length)
        from = end
        return { ...table, locator: { type: "text" as const, start: begin, end } }
      }
      start = content.indexOf(texts[0], start + 1)
    }
    return table
  })
}
