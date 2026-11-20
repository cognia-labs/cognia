import ExcelJS from "exceljs"
import JSZip from "jszip"
import * as XLSX from "xlsx"
import { applyWorkbookOperations, createWorkbook, UNSUPPORTED_FEATURES } from "./model"
import {
  exportWorkbookXlsx,
  importDelimitedWorkbook,
  importWorkbookXlsx,
  validateXlsxPackage,
} from "./xlsx"

it("writes native XLSX styles, formulas, merges, filters, freezes, and dimensions", async () => {
  const source = applyWorkbookOperations(createWorkbook("Quote", "Quote"), [
    {
      op: "setCell",
      sheet: "Quote",
      cell: "A1",
      value: {
        type: "string",
        value: "Total",
        style: {
          font: { bold: true, color: "FFFFFF" },
          fill: { color: "2563EB" },
          alignment: { horizontal: "center" },
        },
      },
    },
    {
      op: "setCell",
      sheet: "Quote",
      cell: "B1",
      value: { type: "number", value: 12.5, formula: "10+2.5", style: { numberFormat: "$0.00" } },
    },
    { op: "merge", sheet: "Quote", range: "A2:B2" },
    { op: "setFilter", sheet: "Quote", range: "A1:B3" },
    { op: "setFreeze", sheet: "Quote", rows: 1, columns: 1 },
    { op: "setRowDimension", sheet: "Quote", row: 1, height: 24 },
    { op: "setColumnDimension", sheet: "Quote", column: "A", width: 20 },
  ])
  const bytes = await exportWorkbookXlsx(source)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer)
  const sheet = workbook.getWorksheet("Quote")!
  expect(sheet.getCell("A1").font.bold).toBe(true)
  expect(sheet.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FF2563EB" } })
  expect(sheet.getCell("B1").value).toMatchObject({ formula: "10+2.5", result: 12.5 })
  expect(sheet.getCell("B1").numFmt).toBe("$0.00")
  expect(sheet.views[0]).toMatchObject({ state: "frozen", xSplit: 1, ySplit: 1 })
  expect(sheet.autoFilter).toBe("A1:B3")
  expect(sheet.getRow(1).height).toBe(24)
  expect(sheet.getColumn("A").width).toBe(20)
  expect(sheet.getCell("A2").isMerged).toBe(true)
})

it("imports workbook values and warns about unsupported OOXML parts", async () => {
  const bytes = await exportWorkbookXlsx(createWorkbook("Backtest", "Results"))
  const zip = await JSZip.loadAsync(bytes)
  zip.file("xl/charts/chart1.xml", "<chart/>")
  const withChart = await zip.generateAsync({ type: "uint8array" })
  const imported = await importWorkbookXlsx(withChart, "Backtest", "backtest.xlsx")
  expect(imported.sheets[0].title).toBe("Results")
  expect(imported.sourceFilename).toBe("backtest.xlsx")
  expect(imported.unsupportedFeatures).toEqual(
    expect.arrayContaining([expect.stringContaining("charts")])
  )
})

it("round-trips typed cells, optional dimensions, styles, and all unsupported OOXML warnings", async () => {
  const source = applyWorkbookOperations(createWorkbook("Typed", "Data"), [
    { op: "setCell", sheet: "Data", cell: "A1", value: { type: "boolean", value: true } },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A2",
      value: {
        type: "date",
        value: "2026-08-08T00:00:00.000Z",
        style: {
          font: { bold: true, italic: true, color: "#FF112233" },
          fill: { color: "ABCDEF" },
          alignment: { horizontal: "left", vertical: "middle", wrapText: true },
        },
      },
    },
    { op: "setCell", sheet: "Data", cell: "A3", value: { type: "error", value: "#N/A" } },
    { op: "setCell", sheet: "Data", cell: "A4", value: { type: "blank", formula: "1+1" } },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A5",
      value: { type: "string", value: "italic", style: { font: { italic: true } } },
    },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A6",
      value: { type: "string", value: "color", style: { font: { color: "112233" } } },
    },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A7",
      value: {
        type: "string",
        value: "wrapped",
        style: { alignment: { wrapText: true } },
      },
    },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A8",
      value: {
        type: "string",
        value: "right",
        style: { alignment: { horizontal: "right" } },
      },
    },
    { op: "setRowDimension", sheet: "Data", row: 2, hidden: true },
    { op: "setColumnDimension", sheet: "Data", column: "A", hidden: true },
    { op: "setColumnDimension", sheet: "Data", column: "C", width: 14 },
    { op: "setFreeze", sheet: "Data", rows: 1, columns: 1 },
  ])
  const bytes = await exportWorkbookXlsx(source)
  const styledImported = await importWorkbookXlsx(bytes, "Typed")
  expect(styledImported.sheets[0].cells.A2.style).toMatchObject({
    font: { bold: true, italic: true, color: "FF112233" },
    fill: { color: "FFABCDEF" },
    alignment: { horizontal: "left", vertical: "middle", wrapText: true },
  })
  expect(styledImported.sheets[0].freeze).toEqual({ rows: 1, columns: 1 })
  expect(styledImported.sheets[0].cells).toMatchObject({
    A5: { style: { font: { italic: true } } },
    A6: { style: { font: { color: "FF112233" } } },
    A7: { style: { alignment: { wrapText: true } } },
    A8: { style: { alignment: { horizontal: "right" } } },
  })

  const zip = await JSZip.loadAsync(bytes)
  zip.file("xl/pivotTables/pivotTable1.xml", "<pivotTable/>")
  zip.file("xl/externalLinks/externalLink1.xml", "<externalLink/>")
  const augmented = await zip.generateAsync({ type: "uint8array" })
  const imported = await importWorkbookXlsx(augmented, "", "typed.xlsx")

  expect(imported.title).toBe("typed")
  expect(imported.sheets[0].cells).toMatchObject({
    A1: { type: "boolean", value: true },
    A2: { type: "date" },
    A3: { type: "error" },
  })
  expect(imported.sheets[0].columnDimensions).toMatchObject({ C: { width: expect.any(Number) } })
  expect(imported.unsupportedFeatures).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Pivot tables"),
      expect.stringContaining("External workbook links"),
    ])
  )

  const loaded = new ExcelJS.Workbook()
  await loaded.xlsx.load(Uint8Array.from(bytes).buffer)
  expect(loaded.getWorksheet("Data")?.getRow(2).hidden).toBe(true)
  expect(loaded.getWorksheet("Data")?.getColumn("A").hidden).toBe(true)
  expect(loaded.getWorksheet("Data")?.getCell("A4").value).toMatchObject({ formula: "1+1" })
})

it("uses the caller's localized fallback title", async () => {
  const csv = new TextEncoder().encode("A,1")
  await expect(importWorkbookXlsx(csv, "", undefined, "工作簿")).resolves.toMatchObject({
    title: "工作簿",
  })
  await expect(importDelimitedWorkbook("A,1", " ", "工作簿")).resolves.toMatchObject({
    title: "工作簿",
  })
})

it("imports delimited data and fails closed when a non-OOXML package cannot be inspected", async () => {
  const delimited = await importDelimitedWorkbook("Name,Enabled\nA,true", "")
  expect(delimited).toMatchObject({
    title: "Workbook",
    sheets: [{ cells: { A1: { value: "Name" }, B2: { value: "true" } } }],
  })

  const csvBytes = new TextEncoder().encode("Name,Value\nA,1")
  const imported = await importWorkbookXlsx(csvBytes, "")
  expect(imported.title).toBe("Workbook")
  expect(imported.unsupportedFeatures).toContain(
    "The workbook package could not be inspected for unsupported OOXML features."
  )
})

it("imports sparse SheetJS dimensions and detects embedded macros", async () => {
  const sparseSheet = XLSX.utils.aoa_to_sheet([["value"]])
  const rows: XLSX.RowInfo[] = []
  const columns: XLSX.ColInfo[] = []
  rows[1] = { hpt: 10 }
  columns[1] = { wch: 12 }
  sparseSheet["!rows"] = rows
  sparseSheet["!cols"] = columns
  const sparseBook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(sparseBook, sparseSheet, "Sparse")
  sparseBook.vbaraw = new Uint8Array([1, 2, 3])
  const bytes = XLSX.write(sparseBook, {
    type: "array",
    bookType: "xlsm",
    bookVBA: true,
    cellStyles: true,
  }) as ArrayBuffer

  const imported = await importWorkbookXlsx(new Uint8Array(bytes), "Macros")
  expect(imported.sheets[0].rowDimensions).toMatchObject({ 2: { height: 10 } })
  expect(imported.sheets[0].columnDimensions).toMatchObject({ B: { width: 12 } })
  expect(imported.unsupportedFeatures).toContain(
    "Macros are present and will not be preserved when this workbook is exported."
  )
})

it("warns about cell-level and package-level features it cannot round-trip", async () => {
  const bytes = await exportWorkbookXlsx(createWorkbook("Features", "Data"))
  const zip = await JSZip.loadAsync(bytes)
  const sheetPath = "xl/worksheets/sheet1.xml"
  const xml = await zip.files[sheetPath].async("string")
  zip.file(
    sheetPath,
    xml.replace(
      "</worksheet>",
      '<dataValidations count="1"><dataValidation type="list" sqref="A1"/></dataValidations>' +
        '<hyperlinks><hyperlink ref="A1" r:id="rId9"/></hyperlinks>' +
        '<conditionalFormatting sqref="A1"/>' +
        "<sheetProtection/>" +
        "</worksheet>"
    )
  )
  zip.file("xl/media/image1.png", new Uint8Array([1]))
  zip.file("xl/comments1.xml", "<comments/>")
  zip.file("xl/tables/table1.xml", "<table/>")
  const augmented = await zip.generateAsync({ type: "uint8array" })

  const imported = await importWorkbookXlsx(augmented, "Features")
  expect(imported.unsupportedFeatures).toEqual(
    expect.arrayContaining([
      expect.stringContaining("data validation"),
      expect.stringContaining("hyperlinks"),
      expect.stringContaining("Conditional formatting"),
      expect.stringContaining("Sheet protection"),
      expect.stringContaining("images or drawing"),
      expect.stringContaining("comments"),
      expect.stringContaining("tables"),
    ])
  )
})

it("writes a default date format and sanitizes unsafe date/error values", async () => {
  const workbook = applyWorkbookOperations(createWorkbook("Dates", "Data"), [
    {
      op: "setCell",
      sheet: "Data",
      cell: "A1",
      value: { type: "date", value: "2026-01-15T00:00:00.000Z" },
    },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A2",
      value: {
        type: "date",
        value: "2026-01-15T00:00:00.000Z",
        style: { numberFormat: "dd/mm/yyyy" },
      },
    },
    { op: "setCell", sheet: "Data", cell: "B1", value: { type: "error", value: "#N/A" } },
    { op: "setCell", sheet: "Data", cell: "B2", value: { type: "error", value: "bogus" } },
    { op: "setCell", sheet: "Data", cell: "B3", value: { type: "date", value: "not-a-date" } },
  ])
  const bytes = await exportWorkbookXlsx(workbook)
  const loaded = new ExcelJS.Workbook()
  await loaded.xlsx.load(Uint8Array.from(bytes).buffer)
  const sheet = loaded.getWorksheet("Data")!
  expect(sheet.getCell("A1").numFmt).toBe("yyyy-mm-dd")
  expect(sheet.getCell("A1").value).toBeInstanceOf(Date)
  expect(sheet.getCell("A2").numFmt).toBe("dd/mm/yyyy")
  expect(sheet.getCell("B1").value).toMatchObject({ error: "#N/A" })
  expect(sheet.getCell("B2").value).toMatchObject({ error: "#VALUE!" })
  expect(sheet.getCell("B3").value).toBe("not-a-date")
})

it("drops dimension entries that carry no height, width, or hidden flag", async () => {
  const workbook = createWorkbook("Noise", "Data")
  workbook.sheets[0].cells.A1 = { type: "string", value: "x" }
  workbook.sheets[0].rowDimensions = { 2: { height: undefined, hidden: undefined } }
  workbook.sheets[0].columnDimensions = { B: { width: undefined, hidden: undefined } }
  // Exported/re-imported noise entries never reach the model.
  const bytes = await exportWorkbookXlsx(workbook)
  const imported = await importWorkbookXlsx(bytes, "Noise")
  expect(imported.sheets[0].rowDimensions ?? {}).toEqual({})
  expect(imported.sheets[0].columnDimensions ?? {}).toEqual({})
})

it("round-trips formulas rewritten by structural edits and a renamed sheet", async () => {
  const edited = applyWorkbookOperations(createWorkbook("Refs", "Data"), [
    {
      op: "setRange",
      sheet: "Data",
      range: "A1:A2",
      values: [[{ type: "number", value: 1 }], [{ type: "number", value: 2 }]],
    },
    { op: "addSheet", title: "Summary" },
    {
      op: "setCell",
      sheet: "Summary",
      cell: "A1",
      value: { type: "number", value: 3, formula: "SUM(Data!A1:A2)" },
    },
    { op: "insertRows", sheet: "Data", row: 1 },
    { op: "renameSheet", sheet: "Data", title: "Raw data" },
  ])
  expect(edited.sheets[1].cells.A1.formula).toBe("SUM('Raw data'!A2:A3)")
  const reopened = await importWorkbookXlsx(await exportWorkbookXlsx(edited), "")
  expect(reopened.sheets.map((sheet) => sheet.title)).toEqual(["Raw data", "Summary"])
  expect(reopened.sheets[1].cells.A1.formula).toBe("SUM('Raw data'!A2:A3)")
  expect(reopened.sheets[0].cells.A3).toMatchObject({ value: 2 })
})

it("recognizes a package that reopens as XLSX and rejects anything else", async () => {
  await expect(validateXlsxPackage(await exportWorkbookXlsx(createWorkbook("Ok")))).resolves.toBe(
    true
  )
  await expect(validateXlsxPackage(Uint8Array.from([1, 2, 3]))).resolves.toBe(false)
  const zip = new JSZip()
  zip.file("[Content_Types].xml", "<Types/>")
  zip.file("xl/workbook.xml", "<workbook/>")
  const noSheets = new Uint8Array(await zip.generateAsync({ type: "arraybuffer" }))
  await expect(validateXlsxPackage(noSheets)).resolves.toBe(false)
})

describe("cell formatting (F13)", () => {
  async function excelJsBytes(build: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
    const workbook = new ExcelJS.Workbook()
    build(workbook)
    return new Uint8Array(await workbook.xlsx.writeBuffer())
  }

  it("keeps formatting of a workbook whose sheets have no view", async () => {
    // A sheet with no <sheetViews> reopens with `views = null`; reading
    // `views.find` threw and the catch dropped every sheet's formatting.
    const bytes = await excelJsBytes((workbook) => {
      const sheet = workbook.addWorksheet("Plain")
      sheet.getCell("A1").value = "Bold"
      sheet.getCell("A1").font = { bold: true }
    })
    const imported = await importWorkbookXlsx(bytes, "No views")
    expect(imported.sheets[0].cells.A1.style).toEqual({ font: { bold: true } })
    expect(imported.unsupportedFeatures).toEqual([])
  })

  it("round-trips font family, size, underline, strike, borders, rotation and indent", async () => {
    const style = {
      font: {
        bold: true,
        name: "Arial",
        size: 14,
        underline: "double",
        strike: true,
        color: "FF2563EB",
      },
      border: {
        top: { style: "thin", color: "FFFF0000" },
        bottom: { style: "double" },
        left: { style: "mediumDashed", color: "FF000000" },
      },
      alignment: { horizontal: "left", vertical: "top", textRotation: 45, indent: 2 },
    } as const
    const source = applyWorkbookOperations(createWorkbook("Styles", "S"), [
      { op: "setCell", sheet: "S", cell: "B2", value: { type: "string", value: "x", style } },
      {
        op: "setCell",
        sheet: "S",
        cell: "C3",
        value: { type: "string", value: "y", style: { alignment: { textRotation: "vertical" } } },
      },
    ])

    const imported = await importWorkbookXlsx(await exportWorkbookXlsx(source), "Styles")

    expect(imported.sheets[0].cells.B2.style).toEqual(style)
    expect(imported.sheets[0].cells.C3.style).toEqual({ alignment: { textRotation: "vertical" } })
    expect(imported.unsupportedFeatures).toEqual([])
  })

  it("does not keep or report the workbook's default font as formatting", async () => {
    const bytes = await excelJsBytes((workbook) => {
      const sheet = workbook.addWorksheet("Fill")
      sheet.getCell("A1").value = "x"
      // ExcelJS writes the default Calibri 11 / theme text color into this cell's style.
      sheet.getCell("A1").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFFF00" },
      }
    })
    const imported = await importWorkbookXlsx(bytes, "Defaults")
    expect(imported.sheets[0].cells.A1.style).toEqual({ fill: { color: "FFFFFF00" } })
    expect(imported.unsupportedFeatures).toEqual([])
  })

  it.each([
    ["a theme font color", (cell: ExcelJS.Cell) => (cell.font = { color: { theme: 4 } })],
    [
      "a gradient fill",
      (cell: ExcelJS.Cell) =>
        (cell.fill = {
          type: "gradient",
          gradient: "angle",
          degree: 0,
          stops: [
            { position: 0, color: { argb: "FF0000FF" } },
            { position: 1, color: { argb: "FFFFFFFF" } },
          ],
        }),
    ],
    [
      "a patterned fill",
      (cell: ExcelJS.Cell) =>
        (cell.fill = { type: "pattern", pattern: "darkGrid", fgColor: { argb: "FF00FF00" } }),
    ],
    [
      "a diagonal border",
      (cell: ExcelJS.Cell) => (cell.border = { diagonal: { up: true, style: "thin" } }),
    ],
    ["justified text", (cell: ExcelJS.Cell) => (cell.alignment = { horizontal: "justify" })],
    ["superscript", (cell: ExcelJS.Cell) => (cell.font = { vertAlign: "superscript" })],
    ["shrink to fit", (cell: ExcelJS.Cell) => (cell.alignment = { shrinkToFit: true })],
  ])("reports %s as formatting it cannot keep", async (_label, format) => {
    const bytes = await excelJsBytes((workbook) => {
      const cell = workbook.addWorksheet("S").getCell("A1")
      cell.value = "x"
      format(cell)
    })
    expect((await importWorkbookXlsx(bytes, "Lossy")).unsupportedFeatures).toEqual([
      UNSUPPORTED_FEATURES.cellFormatting,
    ])
  })

  it("matches sheets by name, so one sheet's styles never land on another", async () => {
    const bytes = await excelJsBytes((workbook) => {
      workbook.addWorksheet("First").getCell("A1").value = "plain"
      const second = workbook.addWorksheet("Second").getCell("A1")
      second.value = "bold"
      second.font = { bold: true }
    })
    const imported = await importWorkbookXlsx(bytes, "Two")
    expect(imported.sheets.map((sheet) => [sheet.title, sheet.cells.A1.style])).toEqual([
      ["First", undefined],
      ["Second", { font: { bold: true } }],
    ])
  })

  it("reports a sheet whose formatting cannot be read and keeps the others", async () => {
    const bytes = await excelJsBytes((workbook) => {
      for (const title of ["Good", "Bad"]) {
        const cell = workbook.addWorksheet(title).getCell("A1")
        cell.value = title
        cell.font = { italic: true }
      }
    })
    const getWorksheet = ExcelJS.Workbook.prototype.getWorksheet
    const spy = jest.spyOn(ExcelJS.Workbook.prototype, "getWorksheet").mockImplementation(function (
      this: ExcelJS.Workbook,
      id
    ) {
      const worksheet = getWorksheet.call(this, id)
      if (id === "Bad" && worksheet)
        worksheet.getCell = () => {
          throw new Error("corrupt style record")
        }
      return worksheet
    })
    try {
      const imported = await importWorkbookXlsx(bytes, "Partial")
      expect(imported.sheets[0].cells.A1.style).toEqual({ font: { italic: true } })
      expect(imported.unsupportedFeatures).toEqual([UNSUPPORTED_FEATURES.cellStyles])
    } finally {
      spy.mockRestore()
    }
  })

  it("does not report formatting loss for delimited text", async () => {
    const imported = await importWorkbookXlsx(new TextEncoder().encode("a,b\n1,2"), "CSV")
    expect(imported.unsupportedFeatures).not.toContain(UNSUPPORTED_FEATURES.cellStyles)
    expect(imported.unsupportedFeatures).not.toContain(UNSUPPORTED_FEATURES.cellFormatting)
  })
})
