import type * as ExcelJS from "exceljs"
import type JSZipType from "jszip"
import type { CellObject, WorkBook, WorkSheet } from "xlsx"
import { encodeColumn, encodeRange } from "./a1"
import type {
  WorkbookBorderEdge,
  WorkbookBorderSide,
  WorkbookCell,
  WorkbookCellStyle,
  WorkbookDocument,
  WorkbookSheet,
} from "./model"
import {
  UNSUPPORTED_FEATURES,
  WORKBOOK_BORDER_EDGES,
  WORKBOOK_BORDER_STYLES,
  WORKBOOK_SCHEMA_VERSION,
} from "./model"

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

// The spreadsheet engines are loaded on first use, not at plugin activation:
// together they are most of this plugin's size, and creating, editing, and
// previewing a workbook never touches them.
type ExcelJsModule = typeof ExcelJS
type SheetJsModule = typeof import("xlsx")

/** A CommonJS module arrives as `default` from some bundlers and flat from others. */
function interop<T extends object>(mod: T | { default: T }): T {
  return "default" in mod && mod.default ? (mod.default as T) : (mod as T)
}

export async function loadSheetJs(): Promise<SheetJsModule> {
  return interop<SheetJsModule>(await import("xlsx"))
}

async function loadExcelJs(): Promise<ExcelJsModule> {
  return interop<ExcelJsModule>(await import("exceljs"))
}

async function loadJsZip(): Promise<typeof JSZipType> {
  return interop<typeof JSZipType>(await import("jszip"))
}

export async function importWorkbookXlsx(
  bytes: Uint8Array,
  title: string,
  sourceFilename?: string,
  /** Title when neither `title` nor the filename supplies one (localized by the caller). */
  fallbackTitle = "Workbook"
): Promise<WorkbookDocument> {
  const XLSX = await loadSheetJs()
  const binary = XLSX.read(bytes, {
    type: "array",
    cellDates: true,
    cellFormula: true,
    cellStyles: true,
    bookVBA: true,
  })
  const unsupportedFeatures = await detectUnsupportedFeatures(bytes, binary)
  const sheets = binary.SheetNames.map((sheetName, index) =>
    importSheet(binary.Sheets[sheetName], sheetName, index)
  )
  for (const warning of await enrichSheetsFromExcelJs(bytes, sheets)) {
    if (!unsupportedFeatures.includes(warning)) unsupportedFeatures.push(warning)
  }
  return {
    schemaVersion: WORKBOOK_SCHEMA_VERSION,
    title: title.trim() || sourceFilename?.replace(/\.xlsx?$/i, "") || fallbackTitle,
    sheets,
    unsupportedFeatures,
    recalculateOnOpen: true,
    ...(sourceFilename ? { sourceFilename } : {}),
  }
}

/** The workbook's default font (the first in `xl/styles.xml`), which every styled cell repeats. */
interface DefaultFont {
  name?: string
  size?: number
  color?: { argb?: string; theme?: number }
}

/** The package's stylesheet, or undefined when the bytes hold none (CSV, a non-OOXML file). */
async function readStylesheet(bytes: Uint8Array): Promise<string | undefined> {
  try {
    const JSZip = await loadJsZip()
    return await (await JSZip.loadAsync(bytes)).file("xl/styles.xml")?.async("string")
  } catch {
    return undefined
  }
}

function readDefaultFont(styles: string): DefaultFont {
  const font = /<fonts\b[^>]*>\s*<font\b[^>]*>([\s\S]*?)<\/font>/.exec(styles)?.[1] ?? ""
  const value = (tag: string) => new RegExp(`<${tag}\\b[^>]*\\bval="([^"]*)"`).exec(font)?.[1]
  const colorTag = /<color\b([^>]*)\/?>/.exec(font)?.[1] ?? ""
  const theme = /\btheme="(\d+)"/.exec(colorTag)?.[1]
  const rgb = /\brgb="([0-9A-Fa-f]{8})"/.exec(colorTag)?.[1]
  const size = Number(value("sz"))
  return {
    ...(value("name") ? { name: value("name") } : {}),
    ...(Number.isFinite(size) && size > 0 ? { size } : {}),
    ...(theme !== undefined || rgb
      ? {
          color: {
            ...(rgb ? { argb: rgb.toUpperCase() } : {}),
            ...(theme !== undefined ? { theme: Number(theme) } : {}),
          },
        }
      : {}),
  }
}

/**
 * Read the cell formatting SheetJS cannot see through ExcelJS, sheet by sheet.
 * Returns the loss sentences to add to the workbook's unsupported features:
 * a sheet whose formatting could not be read, or formatting the model has no
 * place for, is reported, never silently dropped.
 */
async function enrichSheetsFromExcelJs(
  bytes: Uint8Array,
  sheets: WorkbookSheet[]
): Promise<string[]> {
  const stylesheet = await readStylesheet(bytes)
  // No stylesheet, no formatting: delimited text or a package SheetJS read by
  // other means. (Whether the package could be inspected is reported apart.)
  if (stylesheet === undefined) return []
  const { Workbook } = await loadExcelJs()
  const workbook = new Workbook()
  try {
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer)
  } catch {
    return [UNSUPPORTED_FEATURES.cellStyles]
  }
  const defaults = readDefaultFont(stylesheet)
  const warnings = new Set<string>()
  for (const sheet of sheets) {
    // By name: ExcelJS skips chartsheets, so positions drift from SheetJS's list.
    const worksheet = workbook.getWorksheet(sheet.title)
    if (!worksheet) continue
    try {
      const frozen = (worksheet.views ?? []).find(
        (view): view is Partial<ExcelJS.WorksheetViewFrozen> => view?.state === "frozen"
      )
      if (frozen) {
        sheet.freeze = {
          rows: frozen.ySplit ?? 0,
          columns: frozen.xSplit ?? 0,
        }
      }
      for (const [ref, target] of Object.entries(sheet.cells)) {
        const imported = importExcelJsStyle(worksheet.getCell(ref), defaults)
        if (imported.lost) warnings.add(UNSUPPORTED_FEATURES.cellFormatting)
        // ExcelJS read this sheet's formatting, so it replaces SheetJS's guess.
        if (imported.style) target.style = imported.style
        else delete target.style
      }
    } catch {
      warnings.add(UNSUPPORTED_FEATURES.cellStyles)
    }
  }
  return [...warnings]
}

type ExcelColor = { argb?: string; theme?: number; indexed?: number; tint?: number } | undefined

/** Whether a font color is just the workbook default's (absent, or the same theme / ARGB, untinted). */
function isDefaultFontColor(color: ExcelColor, defaults: DefaultFont): boolean {
  if (!color) return true
  if (color.tint) return false
  if (color.argb !== undefined) return color.argb.toUpperCase() === defaults.color?.argb
  if (color.indexed !== undefined) return false
  return color.theme === undefined || color.theme === defaults.color?.theme
}

/** An explicit ARGB color; `lost` when the color is a theme or indexed one the model cannot keep. */
function explicitColor(color: ExcelColor): { argb?: string; lost: boolean } {
  if (!color) return { lost: false }
  if (color.argb) return { argb: color.argb, lost: Boolean(color.tint) }
  return { lost: color.theme !== undefined || color.indexed !== undefined }
}

const SUPPORTED_HORIZONTAL = new Set(["left", "center", "right"])
const SUPPORTED_VERTICAL = new Set(["top", "middle", "bottom"])
const BORDER_STYLES: ReadonlySet<string> = new Set(WORKBOOK_BORDER_STYLES)

/**
 * A cell's formatting in the model's terms, and whether it carried more than
 * the model keeps. Properties equal to the workbook's default font are not
 * formatting the user applied, so they are neither kept nor reported.
 */
function importExcelJsStyle(
  cell: ExcelJS.Cell,
  defaults: DefaultFont
): { style?: WorkbookCellStyle; lost: boolean } {
  let lost = false
  const style: WorkbookCellStyle = {}
  if (cell.numFmt && cell.numFmt !== "General") style.numberFormat = cell.numFmt

  const sourceFont = cell.font as
    | (Partial<ExcelJS.Font> & { color?: ExcelColor; underline?: unknown; vertAlign?: string })
    | undefined
  if (sourceFont) {
    const font: NonNullable<WorkbookCellStyle["font"]> = {}
    if (sourceFont.bold) font.bold = true
    if (sourceFont.italic) font.italic = true
    if (sourceFont.strike) font.strike = true
    if (sourceFont.name && sourceFont.name !== defaults.name) font.name = sourceFont.name
    if (typeof sourceFont.size === "number" && sourceFont.size !== defaults.size)
      font.size = sourceFont.size
    const underline = sourceFont.underline
    if (underline === true || underline === "single") font.underline = "single"
    else if (underline === "double") font.underline = "double"
    else if (underline === "singleAccounting" || underline === "doubleAccounting") lost = true
    if (sourceFont.vertAlign === "superscript" || sourceFont.vertAlign === "subscript") lost = true
    if (!isDefaultFontColor(sourceFont.color, defaults)) {
      const fontColor = explicitColor(sourceFont.color)
      if (fontColor.argb) font.color = fontColor.argb
      lost ||= fontColor.lost
    }
    if (Object.keys(font).length) style.font = font
  }

  const fill = cell.fill as { type?: string; pattern?: string; fgColor?: ExcelColor } | undefined
  if (fill?.type === "gradient") lost = true
  else if (fill?.type === "pattern" && fill.pattern && fill.pattern !== "none") {
    const fillColor = explicitColor(fill.fgColor)
    if (fill.pattern === "solid" && fillColor.argb) style.fill = { color: fillColor.argb }
    else lost = true
  }

  const border = cell.border as
    | Partial<Record<WorkbookBorderSide | "diagonal", { style?: string; color?: ExcelColor }>>
    | undefined
  if (border?.diagonal?.style) lost = true
  const edges: Partial<Record<WorkbookBorderSide, WorkbookBorderEdge>> = {}
  for (const side of WORKBOOK_BORDER_EDGES) {
    const edge = border?.[side]
    if (!edge?.style) continue
    if (!BORDER_STYLES.has(edge.style)) {
      lost = true
      continue
    }
    const edgeColor = explicitColor(edge.color)
    lost ||= edgeColor.lost
    edges[side] = {
      style: edge.style as WorkbookBorderEdge["style"],
      ...(edgeColor.argb ? { color: edgeColor.argb } : {}),
    }
  }
  if (Object.keys(edges).length) style.border = edges

  const source = cell.alignment as Partial<ExcelJS.Alignment> | undefined
  if (source) {
    const alignment: NonNullable<WorkbookCellStyle["alignment"]> = {}
    // OOXML's "general" (the default) is not in ExcelJS's type but can be read.
    if (source.horizontal && (source.horizontal as string) !== "general") {
      if (SUPPORTED_HORIZONTAL.has(source.horizontal))
        alignment.horizontal = source.horizontal as "left" | "center" | "right"
      else lost = true
    }
    if (source.vertical) {
      if (SUPPORTED_VERTICAL.has(source.vertical))
        alignment.vertical = source.vertical as "top" | "middle" | "bottom"
      else lost = true
    }
    if (source.wrapText !== undefined) alignment.wrapText = source.wrapText
    if (source.textRotation === "vertical") alignment.textRotation = "vertical"
    else if (typeof source.textRotation === "number" && source.textRotation !== 0)
      alignment.textRotation = source.textRotation
    if (typeof source.indent === "number" && source.indent > 0) alignment.indent = source.indent
    if (source.shrinkToFit || source.readingOrder === "rtl") lost = true
    if (Object.keys(alignment).length) style.alignment = alignment
  }
  return { ...(Object.keys(style).length ? { style } : {}), lost }
}

export async function importDelimitedWorkbook(
  content: string,
  title: string,
  fallbackTitle = "Workbook"
): Promise<WorkbookDocument> {
  const XLSX = await loadSheetJs()
  const binary = XLSX.read(content, { type: "string", raw: false, cellFormula: true })
  return {
    schemaVersion: WORKBOOK_SCHEMA_VERSION,
    title: title.trim() || fallbackTitle,
    sheets: binary.SheetNames.map((sheetName, index) =>
      importSheet(binary.Sheets[sheetName], sheetName, index)
    ),
    unsupportedFeatures: [],
    recalculateOnOpen: true,
  }
}

export async function exportWorkbookXlsx(document: WorkbookDocument): Promise<Uint8Array> {
  const { Workbook } = await loadExcelJs()
  const workbook = new Workbook()
  workbook.creator = "Cognia Office"
  workbook.created = new Date()
  workbook.modified = new Date()
  workbook.calcProperties.fullCalcOnLoad = true
  for (const sheet of document.sheets) writeSheet(workbook, sheet)
  const output = await workbook.xlsx.writeBuffer()
  return new Uint8Array(output)
}

/**
 * Whether generated bytes reopen as an XLSX package: a zip holding the
 * content-type map, the workbook part, and at least one worksheet. The export
 * checks this before saving so a writer bug never lands on the user's disk.
 */
export async function validateXlsxPackage(bytes: Uint8Array): Promise<boolean> {
  try {
    const JSZip = await loadJsZip()
    const zip = await JSZip.loadAsync(bytes)
    return Boolean(
      zip.file("[Content_Types].xml") &&
      zip.file("xl/workbook.xml") &&
      Object.keys(zip.files).some((path) => /^xl\/worksheets\/[^/]+\.xml$/.test(path))
    )
  } catch {
    return false
  }
}

function importSheet(sheet: WorkSheet, title: string, index: number): WorkbookSheet {
  const cells: Record<string, WorkbookCell> = {}
  for (const ref of Object.keys(sheet)) {
    if (ref.startsWith("!")) continue
    const cell = sheet[ref]
    if (!cell) continue
    cells[ref] = {
      type: importCellType(cell.t, cell.v),
      ...(cell.v !== undefined ? { value: importCellValue(cell.v) } : {}),
      ...(cell.f ? { formula: cell.f } : {}),
      ...(importStyle(cell) ? { style: importStyle(cell) } : {}),
    }
  }
  const freeze = (sheet as WorkSheet & { "!freeze"?: { xSplit?: number; ySplit?: number } })[
    "!freeze"
  ]
  return {
    id: `sheet-${index + 1}`,
    title,
    cells,
    merges: (sheet["!merges"] ?? []).map((range) => encodeRange(range)),
    ...(sheet["!autofilter"]?.ref ? { filter: sheet["!autofilter"].ref } : {}),
    ...(freeze ? { freeze: { rows: freeze.ySplit ?? 0, columns: freeze.xSplit ?? 0 } } : {}),
    ...(sheet["!rows"]
      ? {
          rowDimensions: Object.fromEntries(
            sheet["!rows"].flatMap((row, rowIndex) =>
              row && (row.hpt !== undefined || row.hidden !== undefined)
                ? [[String(rowIndex + 1), { height: row.hpt, hidden: row.hidden }]]
                : []
            )
          ),
        }
      : {}),
    ...(sheet["!cols"]
      ? {
          columnDimensions: Object.fromEntries(
            sheet["!cols"].flatMap((column, columnIndex) =>
              column && (column.wch !== undefined || column.hidden !== undefined)
                ? [[encodeColumn(columnIndex), { width: column.wch, hidden: column.hidden }]]
                : []
            )
          ),
        }
      : {}),
  }
}

function writeSheet(workbook: ExcelJS.Workbook, sheet: WorkbookSheet): void {
  const worksheet = workbook.addWorksheet(sheet.title, {
    views: sheet.freeze
      ? [{ state: "frozen", xSplit: sheet.freeze.columns ?? 0, ySplit: sheet.freeze.rows ?? 0 }]
      : undefined,
  })
  for (const [ref, source] of Object.entries(sheet.cells)) {
    const cell = worksheet.getCell(ref)
    if (source.formula) {
      const result = toExcelValue(source)
      cell.value = { formula: source.formula, ...(result !== null ? { result } : {}) }
    } else {
      cell.value = toExcelValue(source)
    }
    applyStyle(cell, source.style)
    // A date cell without an explicit format renders as a raw serial number in
    // Excel — fall back to a plain ISO date format.
    if (source.type === "date" && !source.style?.numberFormat) {
      cell.numFmt = DEFAULT_DATE_FORMAT
    }
  }
  for (const merge of sheet.merges) worksheet.mergeCells(merge)
  if (sheet.filter) worksheet.autoFilter = sheet.filter
  for (const [row, dimension] of Object.entries(sheet.rowDimensions ?? {})) {
    const target = worksheet.getRow(Number(row))
    if (dimension.height !== undefined) target.height = dimension.height
    if (dimension.hidden !== undefined) target.hidden = dimension.hidden
  }
  for (const [column, dimension] of Object.entries(sheet.columnDimensions ?? {})) {
    const target = worksheet.getColumn(column)
    if (dimension.width !== undefined) target.width = dimension.width
    if (dimension.hidden !== undefined) target.hidden = dimension.hidden
  }
}

function toExcelValue(
  cell: WorkbookCell
): null | string | number | boolean | Date | ExcelJS.CellErrorValue {
  if (cell.type === "blank" || cell.value === undefined) return null
  if (cell.type === "date") {
    const date = new Date(String(cell.value))
    return Number.isNaN(date.getTime()) ? String(cell.value) : date
  }
  if (cell.type === "error") {
    const literal = String(cell.value)
    // ExcelJS only accepts the fixed set of OOXML error literals — anything
    // else would serialize a corrupt cell, so normalize to #VALUE!.
    return {
      error: (EXCEL_ERROR_VALUES.has(literal) ? literal : "#VALUE!") as ExcelJS.ErrorValue,
    }
  }
  return cell.value
}

function applyStyle(cell: ExcelJS.Cell, style: WorkbookCellStyle | undefined): void {
  if (!style) return
  if (style.numberFormat) cell.numFmt = style.numberFormat
  if (style.font)
    cell.font = {
      bold: style.font.bold,
      italic: style.font.italic,
      ...(style.font.name ? { name: style.font.name } : {}),
      ...(style.font.size !== undefined ? { size: style.font.size } : {}),
      ...(style.font.underline ? { underline: style.font.underline } : {}),
      ...(style.font.strike ? { strike: true } : {}),
      ...(style.font.color ? { color: { argb: color(style.font.color) } } : {}),
    }
  if (style.fill)
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color(style.fill.color) } }
  if (style.border) {
    const border: Partial<ExcelJS.Borders> = {}
    for (const side of WORKBOOK_BORDER_EDGES) {
      const edge = style.border[side]
      if (!edge) continue
      border[side] = {
        style: edge.style,
        ...(edge.color ? { color: { argb: color(edge.color) } } : {}),
      }
    }
    cell.border = border
  }
  if (style.alignment)
    cell.alignment = {
      horizontal: style.alignment.horizontal,
      vertical: style.alignment.vertical === "middle" ? "middle" : style.alignment.vertical,
      wrapText: style.alignment.wrapText,
      ...(style.alignment.textRotation !== undefined
        ? { textRotation: style.alignment.textRotation }
        : {}),
      ...(style.alignment.indent !== undefined ? { indent: style.alignment.indent } : {}),
    }
}

function importCellType(type: string | undefined, value: unknown): WorkbookCell["type"] {
  if (value instanceof Date || type === "d") return "date"
  if (type === "n") return "number"
  if (type === "b") return "boolean"
  if (type === "e") return "error"
  if (type === "z" || value == null) return "blank"
  return "string"
}

function importCellValue(value: unknown): string | number | boolean {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value
  return String(value)
}

function importStyle(cell: CellObject): WorkbookCellStyle | undefined {
  const source = cell.s as unknown as
    | {
        font?: { bold?: boolean; italic?: boolean; color?: { rgb?: string } }
        fill?: { fgColor?: { rgb?: string } }
        alignment?: WorkbookCellStyle["alignment"]
      }
    | undefined
  const style: WorkbookCellStyle = {
    ...(cell.z && cell.z !== "General" ? { numberFormat: String(cell.z) } : {}),
    ...(source?.font
      ? {
          font: {
            bold: source.font.bold,
            italic: source.font.italic,
            ...(source.font.color?.rgb ? { color: source.font.color.rgb } : {}),
          },
        }
      : {}),
    ...(source?.fill?.fgColor?.rgb ? { fill: { color: source.fill.fgColor.rgb } } : {}),
    ...(source?.alignment ? { alignment: source.alignment } : {}),
  }
  return Object.keys(style).length ? style : undefined
}

const EXCEL_ERROR_VALUES = new Set([
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#GETTING_DATA",
  "#SPILL!",
  "#CALC!",
])

const DEFAULT_DATE_FORMAT = "yyyy-mm-dd"

async function detectUnsupportedFeatures(bytes: Uint8Array, workbook: WorkBook): Promise<string[]> {
  const warnings: string[] = []
  if (workbook.vbaraw) warnings.push(UNSUPPORTED_FEATURES.macros)
  try {
    const JSZip = await loadJsZip()
    const zip = await JSZip.loadAsync(bytes)
    const paths = Object.keys(zip.files)
    const has = (prefix: string) => paths.some((path) => path.startsWith(prefix))
    if (has("xl/pivotTables/") || has("xl/pivotCache/") || has("xl/model/"))
      warnings.push(UNSUPPORTED_FEATURES.pivotTables)
    if (has("xl/charts/") || has("xl/chartsheets/")) warnings.push(UNSUPPORTED_FEATURES.charts)
    if (has("xl/externalLinks/")) warnings.push(UNSUPPORTED_FEATURES.externalLinks)
    if (has("xl/media/") || has("xl/drawings/")) warnings.push(UNSUPPORTED_FEATURES.drawings)
    if (has("xl/comments") || has("xl/threadedComments/") || has("xl/persons/"))
      warnings.push(UNSUPPORTED_FEATURES.comments)
    if (has("xl/tables/")) warnings.push(UNSUPPORTED_FEATURES.tables)
    if (has("xl/slicerCaches/") || has("xl/timelineCaches/"))
      warnings.push(UNSUPPORTED_FEATURES.slicers)
    if (has("xl/queryTables/") || has("xl/connections"))
      warnings.push(UNSUPPORTED_FEATURES.connections)
    if (has("xl/ctrlProps/") || has("xl/activeX/")) warnings.push(UNSUPPORTED_FEATURES.controls)
    if (has("xl/vbaProject") && !workbook.vbaraw) warnings.push(UNSUPPORTED_FEATURES.macros)

    const sheetWarnings = await inspectWorksheetXml(zip, paths)
    warnings.push(...sheetWarnings)
  } catch {
    warnings.push(UNSUPPORTED_FEATURES.uninspectable)
  }
  return warnings
}

/** Scan worksheet XML for cell-level features the model cannot round-trip. */
async function inspectWorksheetXml(zip: JSZipType, paths: string[]): Promise<string[]> {
  const checks: Array<{ pattern: RegExp; warning: string }> = [
    {
      pattern: /<conditionalFormatting[\s/>]/,
      warning: UNSUPPORTED_FEATURES.conditionalFormatting,
    },
    { pattern: /<dataValidation[\s/>]/, warning: UNSUPPORTED_FEATURES.dataValidation },
    { pattern: /<hyperlink[\s/>]/, warning: UNSUPPORTED_FEATURES.hyperlinks },
    { pattern: /<sheetProtection[\s/>]/, warning: UNSUPPORTED_FEATURES.sheetProtection },
    { pattern: /<legacyDrawing[\s/>]/, warning: UNSUPPORTED_FEATURES.legacyDrawings },
  ]
  const found = new Set<string>()
  for (const path of paths) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue
    const xml = await zip.files[path].async("string")
    for (const check of checks) {
      if (!found.has(check.warning) && check.pattern.test(xml)) found.add(check.warning)
    }
  }
  return [...found]
}

function color(value: string): string {
  const hex = value.replace(/^#/, "").toUpperCase()
  return hex.length === 6 ? `FF${hex}` : hex
}
