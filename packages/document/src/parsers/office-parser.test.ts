/**
 * Tests for Office Parser (Word and Excel)
 *
 * Excel runs through the real SheetJS reader on workbooks written by SheetJS,
 * and Word metadata is read from a real ZIP: the mocked reader is how the
 * two-decimal rounding and the metadata scan of compressed bytes went
 * unnoticed. Mammoth stays mocked; its own conversion is not under test.
 */

import JSZip from "jszip"
import * as XLSX from "xlsx"
import {
  parseWord,
  parseWordFile,
  parseExcel,
  parseExcelFile,
  extractWordEmbeddableContent,
  extractExcelEmbeddableContent,
  detectOfficeType,
  type WordParseResult,
  type ExcelParseResult,
  type ExcelSheet,
} from "./office-parser"

jest.mock("mammoth", () => ({
  __esModule: true,
  default: {
    images: {
      imgElement: jest.fn(
        (
          handler: (image: {
            read: (encoding: string) => Promise<string>
            contentType: string
          }) => Promise<{ src: string }>
        ) => handler
      ),
    },
    convertToHtml: jest.fn(),
    extractRawText: jest.fn(),
  },
}))

const mammothMock = jest.requireMock("mammoth").default as {
  images: { imgElement: jest.Mock }
  convertToHtml: jest.Mock
  extractRawText: jest.Mock
}

function utf8ArrayBuffer(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("Office Parser", () => {
  describe("parseWord", () => {
    it("extracts raw text, html headings, messages, images, style options, and docx metadata", async () => {
      const metadataXml = `
        <cp:coreProperties>
          <dc:title>Quarterly Plan</dc:title>
          <dc:creator>Ada</dc:creator>
          <cp:lastModifiedBy>Grace</cp:lastModifiedBy>
          <dc:description>Planning document</dc:description>
          <dc:subject>Roadmap</dc:subject>
          <cp:keywords>planning,roadmap</cp:keywords>
          <dcterms:created>2024-01-02T03:04:05.000Z</dcterms:created>
          <dcterms:modified>not-a-date</dcterms:modified>
          <cp:revision>7</cp:revision>
        </cp:coreProperties>
      `

      mammothMock.convertToHtml.mockImplementation(async (_input, options) => {
        await options.convertImage({
          contentType: "image/png",
          read: jest.fn().mockResolvedValue("image-base64"),
        })

        expect(options.styleMap).toEqual(["p[style-name='Title'] => h1:fresh"])

        return {
          value: "<h1>Main <em>Title</em></h1><h2>Details</h2><p>Body</p>",
          messages: [{ type: "warning", message: "Converted with warning" }],
        }
      })
      mammothMock.extractRawText.mockResolvedValue({ value: "Plain document text" })

      const zip = new JSZip()
      zip.file("word/document.xml", "<w:document/>")
      zip.file("docProps/core.xml", metadataXml)
      const docx = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })

      const result = await parseWord(docx, {
        extractImages: true,
        styleMap: ["p[style-name='Title'] => h1:fresh"],
      })

      expect(result).toMatchObject({
        text: "Plain document text",
        html: "<h1>Main <em>Title</em></h1><h2>Details</h2><p>Body</p>",
        messages: [{ type: "warning", message: "Converted with warning" }],
        images: [{ contentType: "image/png", base64: "image-base64" }],
        headings: [
          { level: 1, text: "Main Title" },
          { level: 2, text: "Details" },
        ],
        metadata: {
          title: "Quarterly Plan",
          author: "Ada",
          lastModifiedBy: "Grace",
          description: "Planning document",
          subject: "Roadmap",
          keywords: "planning,roadmap",
          revision: 7,
          modified: undefined,
        },
      })
      expect(result.metadata?.created?.toISOString()).toBe("2024-01-02T03:04:05.000Z")
      expect(mammothMock.images.imgElement).toHaveBeenCalledTimes(1)
    })

    it("honors disabled image and metadata extraction and reads File objects", async () => {
      mammothMock.convertToHtml.mockResolvedValue({
        value: "<p>No headings</p>",
        messages: [],
      })
      mammothMock.extractRawText.mockResolvedValue({ value: "No metadata" })

      const result = await parseWord(utf8ArrayBuffer("plain docx bytes"), {
        extractImages: false,
        extractMetadata: false,
      })

      expect(result.images).toEqual([])
      expect(result.metadata).toBeUndefined()
      expect(result.headings).toEqual([])
      expect(mammothMock.images.imgElement).not.toHaveBeenCalled()

      const file = {
        arrayBuffer: jest.fn().mockResolvedValue(utf8ArrayBuffer("file bytes")),
      } as unknown as File

      await expect(parseWordFile(file, { extractMetadata: false })).resolves.toMatchObject({
        text: "No metadata",
      })
      expect(file.arrayBuffer).toHaveBeenCalledTimes(1)
    })
  })

  describe("parseExcel", () => {
    function workbookBytes(sheets: Record<string, XLSX.WorkSheet>): ArrayBuffer {
      const workbook = XLSX.utils.book_new()
      for (const [name, sheet] of Object.entries(sheets)) {
        XLSX.utils.book_append_sheet(workbook, sheet, name)
      }
      return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer
    }

    it("keeps the stored value of every number instead of rounding it (F2)", async () => {
      const bytes = workbookBytes({
        Values: XLSX.utils.aoa_to_sheet([
          ["label", "value"],
          ["tiny", 0.00012345],
          ["long", 1.23456789],
          ["negative", -2.5],
          ["scientific", 6.02214076e23],
          ["noise", 0.1 + 0.2],
          ["integer", 42],
        ]),
      })

      const result = await parseExcel(bytes)

      expect(result.sheets[0].data.map((row) => row[1])).toEqual([
        "value",
        0.00012345,
        1.23456789,
        -2.5,
        6.02214076e23,
        0.30000000000000004,
        42,
      ])
      for (const text of ["0.00012345", "1.23456789", "-2.5", "6.02214076e+23", "| 0.3", "42"]) {
        expect(result.text).toContain(text)
      }
      expect(result.text).not.toContain("0.00 ")
      expect(result.text).not.toContain("1.23 ")
    })

    it("reads a date-formatted serial as its calendar date, independent of time zone", async () => {
      const sheet = XLSX.utils.aoa_to_sheet([["when"]])
      sheet.A2 = { t: "n", v: 45306, z: "yyyy-mm-dd" }
      sheet.A3 = { t: "n", v: 45292.75, z: "yyyy-mm-dd hh:mm" }
      sheet["!ref"] = "A1:A3"

      const result = await parseExcel(workbookBytes({ Dates: sheet }))

      expect(result.sheets[0].data).toEqual([["when"], ["2024-01-15"], ["2024-01-01 18:00"]])
    })

    it("anchors rows at A1 so values keep their coordinates", async () => {
      const sheet: XLSX.WorkSheet = {
        C2: { t: "s", v: "late start" },
        B4: { t: "n", v: 7 },
        "!ref": "B2:C4",
      }

      const result = await parseExcel(workbookBytes({ Offset: sheet }))

      expect(result.sheets[0].data).toEqual([[], [null, null, "late start"], [], [null, 7]])
      expect(result.sheets[0]).toMatchObject({ rowCount: 4, columnCount: 3 })
    })

    it("sizes the sheet from its stored cells, not the range the file declares", async () => {
      // Written small, then the package's <dimension> claims the whole grid:
      // asking SheetJS to write that range would walk all 17 billion cells.
      const zip = await JSZip.loadAsync(
        workbookBytes({ Huge: XLSX.utils.aoa_to_sheet([["only"]]) })
      )
      const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string")
      expect(sheetXml).toContain('<dimension ref="A1"/>')
      zip.file(
        "xl/worksheets/sheet1.xml",
        sheetXml.replace('<dimension ref="A1"/>', '<dimension ref="A1:XFD1048576"/>')
      )

      const result = await parseExcel(await zip.generateAsync({ type: "arraybuffer" }))

      expect(result.sheets[0].data).toEqual([["only"]])
    })

    it("refuses a workbook that would expand past the cell budget (F7)", async () => {
      const sheet: XLSX.WorkSheet = {
        A1: { t: "s", v: "a" },
        Z400: { t: "s", v: "z" },
        "!ref": "A1:Z400",
      }

      await expect(
        parseExcel(workbookBytes({ Wide: sheet }), { maxExpandedCells: 26 * 400 - 1 })
      ).rejects.toMatchObject({ name: "DocumentLimitError", scope: "expanded-cells" })
      await expect(
        parseExcel(workbookBytes({ Wide: sheet }), { maxExpandedCells: 26 * 400 })
      ).resolves.toMatchObject({ sheets: [{ rowCount: 400, columnCount: 26 }] })
    })

    it("extracts every sheet with merges, stats, booleans and header formatting", async () => {
      const data = XLSX.utils.aoa_to_sheet([
        ["Name", "Score", "Active"],
        ["Ada", 42, true],
        ["Grace", null, false],
        ["Pipe | and\nbreak", 1, true],
      ])
      data["!merges"] = [{ s: { c: 0, r: 0 }, e: { c: 1, r: 0 } }]

      const result = await parseExcel(
        workbookBytes({ Data: data, Empty: XLSX.utils.aoa_to_sheet([]) })
      )

      expect(result.sheetNames).toEqual(["Data", "Empty"])
      expect(result.sheets[0]).toMatchObject({
        name: "Data",
        rowCount: 4,
        columnCount: 3,
        mergedCells: ["A1:B1"],
      })
      expect(result.sheets[1]).toMatchObject({ name: "Empty", data: [], rowCount: 0 })
      expect(result.sheetStats?.[0]).toMatchObject({
        name: "Data",
        rowCount: 4,
        columnCount: 3,
        mergedCellCount: 1,
        columnTypes: { 0: "string", 1: "mixed", 2: "mixed" },
      })
      expect(result.text).toContain("Merged cells: A1:B1")
      expect(result.text).toContain("Name | Score | Active\n--- | --- | ---")
      expect(result.text).toContain("Ada | 42 | TRUE")
      expect(result.text).toContain("Grace |  | FALSE")
      // A cell's own pipe and line break do not read as a new column or row.
      expect(result.text).toContain("Pipe \\| and break | 1 | TRUE")
      expect(result.text).toContain("(empty sheet)")
    })

    it("reads File objects", async () => {
      const bytes = workbookBytes({ Values: XLSX.utils.aoa_to_sheet([[1]]) })
      const file = { arrayBuffer: jest.fn().mockResolvedValue(bytes) } as unknown as File

      await expect(parseExcelFile(file)).resolves.toMatchObject({ sheetNames: ["Values"] })
      expect(file.arrayBuffer).toHaveBeenCalledTimes(1)
    })
  })

  describe("detectOfficeType", () => {
    it("detects Word documents", () => {
      expect(detectOfficeType("document.docx")).toBe("word")
      expect(detectOfficeType("document.doc")).toBe("word")
      expect(detectOfficeType("template.docm")).toBe("word")
      expect(detectOfficeType("notes.odt")).toBe("word")
      expect(detectOfficeType("DOCUMENT.DOCX")).toBe("word")
    })

    it("detects Excel files", () => {
      expect(detectOfficeType("spreadsheet.xlsx")).toBe("excel")
      expect(detectOfficeType("spreadsheet.xls")).toBe("excel")
      expect(detectOfficeType("financials.xlsm")).toBe("excel")
      expect(detectOfficeType("budget.ods")).toBe("excel")
      expect(detectOfficeType("SPREADSHEET.XLSX")).toBe("excel")
    })

    it("returns unknown for non-Office files", () => {
      expect(detectOfficeType("file.txt")).toBe("unknown")
      expect(detectOfficeType("file.pdf")).toBe("unknown")
      expect(detectOfficeType("file.md")).toBe("unknown")
      expect(detectOfficeType("file")).toBe("unknown")
    })

    it("handles files with multiple dots", () => {
      expect(detectOfficeType("my.document.v2.docx")).toBe("word")
      expect(detectOfficeType("data.backup.xlsx")).toBe("excel")
    })
  })

  describe("extractWordEmbeddableContent", () => {
    it("returns text content", () => {
      const result: WordParseResult = {
        text: "This is the document content.",
        html: "<p>This is the document content.</p>",
        messages: [],
        images: [],
      }

      const embeddable = extractWordEmbeddableContent(result)
      expect(embeddable).toBe("This is the document content.")
    })

    it("handles empty content", () => {
      const result: WordParseResult = {
        text: "",
        html: "",
        messages: [],
        images: [],
      }

      const embeddable = extractWordEmbeddableContent(result)
      expect(embeddable).toBe("")
    })

    it("handles content with warnings", () => {
      const result: WordParseResult = {
        text: "Content with issues.",
        html: "<p>Content with issues.</p>",
        messages: [{ type: "warning", message: "Some formatting was lost" }],
        images: [],
      }

      const embeddable = extractWordEmbeddableContent(result)
      expect(embeddable).toBe("Content with issues.")
    })

    it("includes title, author, and heading structure when available", () => {
      const result: WordParseResult = {
        text: "Body content",
        html: "<h1>Plan</h1>",
        messages: [],
        images: [],
        metadata: {
          title: "Launch Plan",
          author: "Ada",
        },
        headings: [
          { level: 1, text: "Overview" },
          { level: 3, text: "Risks" },
        ],
      }

      expect(extractWordEmbeddableContent(result)).toBe(
        "Title: Launch Plan\n\nAuthor: Ada\n\nDocument Structure:\n\n# Overview\n    ### Risks\n\nBody content"
      )
    })
  })

  describe("extractExcelEmbeddableContent", () => {
    it("returns formatted text", () => {
      const result: ExcelParseResult = {
        text: "## Sheet: Sheet1\nname | age\n--- | ---\nJohn | 30",
        sheets: [
          {
            name: "Sheet1",
            data: [["John", "30"]],
            rowCount: 1,
            columnCount: 2,
          },
        ],
        sheetNames: ["Sheet1"],
      }

      const embeddable = extractExcelEmbeddableContent(result)
      expect(embeddable).toContain("Sheet1")
      expect(embeddable).toContain("John")
    })

    it("handles empty spreadsheet", () => {
      const result: ExcelParseResult = {
        text: "",
        sheets: [],
        sheetNames: [],
      }

      const embeddable = extractExcelEmbeddableContent(result)
      expect(embeddable).toBe("")
    })

    it("includes sheet statistics summary with merged-cell counts", () => {
      const result: ExcelParseResult = {
        text: "## Sheet: Data",
        sheets: [],
        sheetNames: ["Data", "Empty"],
        sheetStats: [
          {
            name: "Data",
            rowCount: 3,
            columnCount: 4,
            mergedCellCount: 2,
            emptyRate: 0.1,
            columnTypes: {},
          },
          {
            name: "Empty",
            rowCount: 0,
            columnCount: 0,
            mergedCellCount: 0,
            emptyRate: 0,
            columnTypes: {},
          },
        ],
      }

      expect(extractExcelEmbeddableContent(result)).toBe(
        "Sheets: Data: 3 rows × 4 cols, 2 merged; Empty: 0 rows × 0 cols\n\n## Sheet: Data"
      )
    })
  })

  describe("WordParseResult type", () => {
    it("supports all fields", () => {
      const result: WordParseResult = {
        text: "Plain text content",
        html: "<p>HTML content</p>",
        messages: [
          { type: "warning", message: "Warning message" },
          { type: "error", message: "Error message" },
        ],
        images: [{ contentType: "image/png", base64: "base64data" }],
      }

      expect(result.text).toBe("Plain text content")
      expect(result.html).toContain("HTML content")
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0].type).toBe("warning")
      expect(result.images).toHaveLength(1)
    })
  })

  describe("ExcelParseResult type", () => {
    it("supports multiple sheets", () => {
      const sheet1: ExcelSheet = {
        name: "Data",
        data: [
          ["Name", "Age", "City"],
          ["John", "30", "NYC"],
          ["Jane", "25", "LA"],
        ],
        rowCount: 2,
        columnCount: 3,
      }

      const sheet2: ExcelSheet = {
        name: "Summary",
        data: [["Total", "2"]],
        rowCount: 1,
        columnCount: 2,
      }

      const result: ExcelParseResult = {
        text: "Combined text",
        sheets: [sheet1, sheet2],
        sheetNames: ["Data", "Summary"],
      }

      expect(result.sheets).toHaveLength(2)
      expect(result.sheetNames).toEqual(["Data", "Summary"])
      expect(result.sheets[0].data[0]).toEqual(["Name", "Age", "City"])
    })

    it("supports various cell types", () => {
      const sheet: ExcelSheet = {
        name: "Mixed",
        data: [
          ["Text", 123, true, null],
          ["Another", 45.67, false, null],
        ],
        rowCount: 2,
        columnCount: 4,
      }

      expect(sheet.data[0][0]).toBe("Text")
      expect(sheet.data[0][1]).toBe(123)
      expect(sheet.data[0][2]).toBe(true)
      expect(sheet.data[0][3]).toBeNull()
      expect(sheet.data[1][1]).toBe(45.67)
    })
  })

  describe("ExcelSheet type", () => {
    it("tracks dimensions correctly", () => {
      const sheet: ExcelSheet = {
        name: "Test",
        data: [
          ["A", "B", "C", "D", "E"],
          ["1", "2", "3", "4", "5"],
          ["6", "7", "8", "9", "10"],
        ],
        rowCount: 3,
        columnCount: 5,
      }

      expect(sheet.rowCount).toBe(3)
      expect(sheet.columnCount).toBe(5)
      expect(sheet.data.length).toBe(sheet.rowCount)
      expect(sheet.data[0].length).toBe(sheet.columnCount)
    })

    it("handles empty sheet", () => {
      const sheet: ExcelSheet = {
        name: "Empty",
        data: [],
        rowCount: 0,
        columnCount: 0,
      }

      expect(sheet.data).toHaveLength(0)
      expect(sheet.rowCount).toBe(0)
    })
  })
})
