/**
 * Acceptance corpus (G6).
 *
 * A fixed bilingual (English / 简体中文) set of documents, generated in memory
 * by real writers (`docx`, SheetJS, hand-written ODF / PPTX / EPUB packages),
 * read by the real parsers through `processDocumentAsync`, nothing mocked.
 * Each capability is checked on its own against a golden expectation, so a
 * regression names what broke (text, sections, tables, locators, parse
 * identity) instead of moving one blended score:
 *
 * - text: the key phrases of both languages survive.
 * - sections: heading titles and levels, in order.
 * - tables: every anchored cell, with its spans, header flag and stored value.
 * - locators: each table's locator resolves (a text locator's slice holds
 *   its cells; a sheet locator names the used range).
 * - identity: the reader recorded for the parse.
 *
 * Negative samples pin what must be refused or reported, not read.
 *
 * Not in this lane: PDF. pdf.js 6 ships as ES modules Jest cannot load, so
 * the PDF reader is covered by its unit tests (pdf.js mocked) and needs a
 * real runtime (browser or desktop shell) for an acceptance run; the
 * baseline record says so, with what else this lane does not cover
 * (`docs/evidence/2026-11-18-document-parsing-export-gap-audit.probes/acceptance-corpus-baseline.md`).
 */

import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalMergeType,
} from "docx"
import JSZip from "jszip"
import * as XLSX from "xlsx"
import { processDocumentAsync } from "./document-processor"
import { DocumentLimitError } from "./limits"
import type { DocumentTableCell, ProcessedDocument } from "./types"

type Cell = Pick<DocumentTableCell, "row" | "column" | "text"> &
  Partial<Pick<DocumentTableCell, "rowSpan" | "columnSpan" | "header" | "value">>

interface GoldenTable {
  rowCount: number
  columnCount: number
  headerRowCount: number
  caption?: string
  locator: "text" | { type: "sheet"; sheet: string; range: string }
  cells: Cell[]
}

interface CorpusCase {
  id: string
  filename: string
  build: () => Promise<string | ArrayBuffer>
  golden: {
    parser: string
    text: string[]
    /** Heading sections below the root, as [title, level]; omitted where the format has none. */
    sections?: [string, number][]
    tables?: GoldenTable[]
  }
}

const zipBuffer = async (entries: Record<string, string>): Promise<ArrayBuffer> => {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(entries)) zip.file(path, content)
  const bytes = await zip.generateAsync({ type: "uint8array" })
  return Uint8Array.from(bytes).buffer
}

const cellOf = (cell: DocumentTableCell): Cell => ({
  row: cell.row,
  column: cell.column,
  text: cell.text,
  ...(cell.rowSpan !== 1 ? { rowSpan: cell.rowSpan } : {}),
  ...(cell.columnSpan !== 1 ? { columnSpan: cell.columnSpan } : {}),
  ...(cell.header ? { header: true } : {}),
  ...(cell.value !== undefined && cell.value !== cell.text ? { value: cell.value } : {}),
})

const docxTableCell = (
  text: string,
  options: Partial<ConstructorParameters<typeof TableCell>[0]> = {}
) => new TableCell({ children: [new Paragraph(text)], ...options })

const CORPUS: CorpusCase[] = [
  {
    id: "docx-bilingual-report",
    filename: "季度报告-report.docx",
    build: async () => {
      const document = new Document({
        sections: [
          {
            children: [
              new Paragraph({ text: "概述 Overview", heading: HeadingLevel.HEADING_1 }),
              new Paragraph({
                children: [new TextRun("本季度收入增长 20%。 Revenue grew 20% this quarter.")],
              }),
              new Paragraph({ text: "区域明细 Regions", heading: HeadingLevel.HEADING_2 }),
              new Table({
                rows: [
                  new TableRow({
                    tableHeader: true,
                    children: [
                      docxTableCell("区域 Region"),
                      docxTableCell("一月 Jan"),
                      docxTableCell("二月 Feb"),
                    ],
                  }),
                  new TableRow({
                    children: [
                      docxTableCell("北区 North", { verticalMerge: VerticalMergeType.RESTART }),
                      docxTableCell("10"),
                      docxTableCell("20"),
                    ],
                  }),
                  new TableRow({
                    children: [
                      docxTableCell("", { verticalMerge: VerticalMergeType.CONTINUE }),
                      docxTableCell("30"),
                      docxTableCell("40"),
                    ],
                  }),
                  new TableRow({
                    children: [docxTableCell("合计 Total 100", { columnSpan: 3 })],
                  }),
                ],
              }),
              new Paragraph({ text: "风险 Risks", heading: HeadingLevel.HEADING_1 }),
              new Paragraph({
                alignment: AlignmentType.LEFT,
                children: [new TextRun("供应延迟。 Supply may slip.")],
              }),
            ],
          },
        ],
      })
      const bytes = await Packer.toBuffer(document)
      return Uint8Array.from(bytes).buffer
    },
    golden: {
      parser: "mammoth",
      text: ["本季度收入增长", "Revenue grew 20%", "供应延迟", "Supply may slip"],
      sections: [
        ["概述 Overview", 1],
        ["区域明细 Regions", 2],
        ["风险 Risks", 1],
      ],
      tables: [
        {
          rowCount: 4,
          columnCount: 3,
          headerRowCount: 1,
          locator: "text",
          cells: [
            { row: 0, column: 0, text: "区域 Region", header: true },
            { row: 0, column: 1, text: "一月 Jan", header: true },
            { row: 0, column: 2, text: "二月 Feb", header: true },
            { row: 1, column: 0, text: "北区 North", rowSpan: 2 },
            { row: 1, column: 1, text: "10" },
            { row: 1, column: 2, text: "20" },
            // Under Jan, not under Region: the merge holds column 0.
            { row: 2, column: 1, text: "30" },
            { row: 2, column: 2, text: "40" },
            { row: 3, column: 0, text: "合计 Total 100", columnSpan: 3 },
          ],
        },
      ],
    },
  },
  {
    id: "xlsx-bilingual-sales",
    filename: "销售-sales.xlsx",
    build: async () => {
      const sheet = XLSX.utils.aoa_to_sheet([
        ["区域 Region", "第一季度 Q1", "第二季度 Q2"],
        ["北区 North", 10, 20.5],
        ["南区 South", 0.1 + 0.2, 40],
        ["合计 Total", null, null],
      ])
      sheet["!merges"] = [{ s: { r: 3, c: 0 }, e: { r: 3, c: 2 } }]
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, "销售 Sales")
      const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer
      return bytes
    },
    golden: {
      parser: "sheetjs",
      text: ["北区 North", "南区 South", "20.5"],
      tables: [
        {
          rowCount: 4,
          columnCount: 3,
          headerRowCount: 1,
          locator: { type: "sheet", sheet: "销售 Sales", range: "A1:C4" },
          cells: [
            { row: 0, column: 0, text: "区域 Region", header: true },
            { row: 0, column: 1, text: "第一季度 Q1", header: true },
            { row: 0, column: 2, text: "第二季度 Q2", header: true },
            { row: 1, column: 0, text: "北区 North" },
            { row: 1, column: 1, text: "10", value: 10 },
            { row: 1, column: 2, text: "20.5", value: 20.5 },
            { row: 2, column: 0, text: "南区 South" },
            // The stored value, to 15 significant digits, not 0.30000000000000004.
            { row: 2, column: 1, text: "0.3", value: 0.30000000000000004 },
            { row: 2, column: 2, text: "40", value: 40 },
            { row: 3, column: 0, text: "合计 Total", columnSpan: 3 },
          ],
        },
      ],
    },
  },
  {
    id: "ods-bilingual-budget",
    filename: "预算-budget.ods",
    build: () =>
      zipBuffer({
        "content.xml": `<office:document-content><office:body><office:spreadsheet>
          <table:table table:name="预算 Budget">
            <table:table-row>
              <table:table-cell office:value-type="string"><text:p>项目 Item</text:p></table:table-cell>
              <table:table-cell office:value-type="string"><text:p>金额 Amount</text:p></table:table-cell>
            </table:table-row>
            <table:table-row>
              <table:table-cell table:number-rows-spanned="2" office:value-type="string"><text:p>差旅 Travel</text:p></table:table-cell>
              <table:table-cell office:value-type="float" office:value="1200.5"><text:p>1,200.50</text:p></table:table-cell>
            </table:table-row>
            <table:table-row>
              <table:covered-table-cell/>
              <table:table-cell office:value-type="float" office:value="300"><text:p>300.00</text:p></table:table-cell>
            </table:table-row>
          </table:table>
        </office:spreadsheet></office:body></office:document-content>`,
      }),
    golden: {
      parser: "odf",
      text: ["差旅 Travel", "1200.5"],
      tables: [
        {
          rowCount: 3,
          columnCount: 2,
          headerRowCount: 1,
          locator: { type: "sheet", sheet: "预算 Budget", range: "A1:B3" },
          cells: [
            { row: 0, column: 0, text: "项目 Item", header: true },
            { row: 0, column: 1, text: "金额 Amount", header: true },
            { row: 1, column: 0, text: "差旅 Travel", rowSpan: 2 },
            { row: 1, column: 1, text: "1200.5", value: 1200.5 },
            { row: 2, column: 1, text: "300", value: 300 },
          ],
        },
      ],
    },
  },
  {
    id: "odt-bilingual-minutes",
    filename: "会议纪要-minutes.odt",
    build: () =>
      zipBuffer({
        "content.xml": `<office:document-content><office:body><office:text>
          <text:h text:outline-level="1">议程 Agenda</text:h>
          <text:p>讨论预算。 Discuss the budget.</text:p>
          <table:table table:name="Actions">
            <table:table-header-rows>
              <table:table-row>
                <table:table-cell office:value-type="string"><text:p>负责人 Owner</text:p></table:table-cell>
                <table:table-cell office:value-type="string"><text:p>事项 Task</text:p></table:table-cell>
              </table:table-row>
            </table:table-header-rows>
            <table:table-row>
              <table:table-cell office:value-type="string"><text:p>李雷 Li</text:p></table:table-cell>
              <table:table-cell office:value-type="string"><text:p>报价 Quote</text:p></table:table-cell>
            </table:table-row>
          </table:table>
          <text:h text:outline-level="2">决议 Decisions</text:h>
          <text:p>通过。 Approved.</text:p>
        </office:text></office:body></office:document-content>`,
        "meta.xml": `<office:document-meta><dc:title>纪要 Minutes</dc:title></office:document-meta>`,
      }),
    golden: {
      parser: "odf",
      text: ["讨论预算", "Discuss the budget", "Approved"],
      sections: [
        ["议程 Agenda", 1],
        ["决议 Decisions", 2],
      ],
      tables: [
        {
          rowCount: 2,
          columnCount: 2,
          headerRowCount: 1,
          locator: "text",
          cells: [
            { row: 0, column: 0, text: "负责人 Owner", header: true },
            { row: 0, column: 1, text: "事项 Task", header: true },
            { row: 1, column: 0, text: "李雷 Li" },
            { row: 1, column: 1, text: "报价 Quote" },
          ],
        },
      ],
    },
  },
  {
    id: "html-bilingual-page",
    filename: "页面-page.html",
    build: async () => `<html><head><title>产品 Product</title></head><body>
      <h1>功能 Features</h1>
      <p>支持离线。 Works offline.</p>
      <h2>价格 Pricing</h2>
      <table>
        <caption>价格表 Price list</caption>
        <thead><tr><th rowspan="2">套餐 Plan</th><th colspan="2">价格 Price</th></tr>
        <tr><th>月 Month</th><th>年 Year</th></tr></thead>
        <tbody><tr><td>基础 Basic</td><td>9</td><td>90</td></tr></tbody>
      </table>
    </body></html>`,
    golden: {
      parser: "html",
      text: ["支持离线", "Works offline"],
      // The <title> is the document's title (the root's), not a section.
      sections: [
        ["功能 Features", 1],
        ["价格 Pricing", 2],
      ],
      tables: [
        {
          rowCount: 3,
          columnCount: 3,
          headerRowCount: 2,
          caption: "价格表 Price list",
          locator: "text",
          cells: [
            { row: 0, column: 0, text: "套餐 Plan", rowSpan: 2, header: true },
            { row: 0, column: 1, text: "价格 Price", columnSpan: 2, header: true },
            { row: 1, column: 1, text: "月 Month", header: true },
            { row: 1, column: 2, text: "年 Year", header: true },
            { row: 2, column: 0, text: "基础 Basic" },
            { row: 2, column: 1, text: "9" },
            { row: 2, column: 2, text: "90" },
          ],
        },
      ],
    },
  },
  {
    id: "csv-bilingual-contacts",
    filename: "联系人-contacts.csv",
    build: async () => '姓名 Name,城市 City\n王芳 Wang,"上海, Shanghai"\nAda,伦敦 London\n',
    golden: {
      parser: "csv",
      text: ["王芳 Wang", "上海, Shanghai"],
      tables: [
        {
          rowCount: 3,
          columnCount: 2,
          headerRowCount: 1,
          locator: "text",
          cells: [
            { row: 0, column: 0, text: "姓名 Name", header: true },
            { row: 0, column: 1, text: "城市 City", header: true },
            { row: 1, column: 0, text: "王芳 Wang" },
            { row: 1, column: 1, text: "上海, Shanghai" },
            { row: 2, column: 0, text: "Ada" },
            { row: 2, column: 1, text: "伦敦 London" },
          ],
        },
      ],
    },
  },
  {
    id: "markdown-bilingual-guide",
    filename: "指南-guide.md",
    build: async () =>
      "# 安装 Install\n\n运行命令。 Run the command.\n\n## 配置 Configure\n\n编辑文件。\n",
    golden: {
      parser: "markdown",
      text: ["运行命令", "Run the command"],
      sections: [
        ["安装 Install", 1],
        ["配置 Configure", 2],
      ],
    },
  },
  {
    id: "pptx-bilingual-deck",
    filename: "路线图-roadmap.pptx",
    build: () =>
      zipBuffer({
        "ppt/slides/slide1.xml":
          "<p:sld><a:p><a:r><a:t>路线图 Roadmap</a:t></a:r></a:p><a:p><a:r><a:t>第三季度发布 Launch in Q3</a:t></a:r></a:p></p:sld>",
        "ppt/slides/slide2.xml":
          "<p:sld><a:p><a:r><a:t>风险 Risks</a:t></a:r></a:p><a:p><a:r><a:t>人手不足 Short-staffed</a:t></a:r></a:p></p:sld>",
      }),
    golden: {
      parser: "pptx",
      text: ["第三季度发布 Launch in Q3", "人手不足 Short-staffed"],
    },
  },
  {
    id: "epub-bilingual-book",
    filename: "手册-handbook.epub",
    build: () =>
      zipBuffer({
        "META-INF/container.xml": `<container version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        "OEBPS/content.opf": `<package version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>手册 Handbook</dc:title></metadata>
          <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest>
          <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
        "OEBPS/c1.xhtml":
          "<html><body><h1>入门 Getting started</h1><p>欢迎。 Welcome aboard.</p></body></html>",
        "OEBPS/c2.xhtml":
          "<html><body><h1>进阶 Advanced</h1><p>深入配置。 Deep configuration.</p></body></html>",
      }),
    golden: {
      parser: "epub",
      text: ["欢迎", "Welcome aboard", "Deep configuration"],
    },
  },
  {
    id: "rtf-bilingual-letter",
    filename: "信件-letter.rtf",
    build: async () =>
      "{\\rtf1\\ansi\\ansicpg936\\deff0{\\fonttbl{\\f0 SimSun;}}\\f0 Dear team,\\par \\u20320?\\u22909? hello\\par}",
    golden: {
      parser: "rtf",
      text: ["Dear team", "你好"],
    },
  },
]

const processed = new Map<string, ProcessedDocument>()

beforeAll(async () => {
  for (const sample of CORPUS) {
    processed.set(
      sample.id,
      await processDocumentAsync(sample.id, sample.filename, await sample.build())
    )
  }
})

const result = (id: string): ProcessedDocument => {
  const document = processed.get(id)
  if (!document) throw new Error(`corpus case ${id} was not processed`)
  return document
}

describe("acceptance corpus — text", () => {
  it.each(CORPUS.map((sample) => [sample.id, sample]))("%s keeps its key phrases", (id, sample) => {
    const { content } = result(id)
    for (const phrase of sample.golden.text)
      expect([id, content.includes(phrase)]).toEqual([id, true])
  })
})

describe("acceptance corpus — sections", () => {
  const withSections = CORPUS.filter((sample) => sample.golden.sections)
  it.each(withSections.map((sample) => [sample.id, sample]))(
    "%s reads its headings as sections, in order",
    (id, sample) => {
      const nodes = result(id).structure?.nodes.slice(1) ?? []
      expect(nodes.map((node) => [node.title, node.level])).toEqual(sample.golden.sections)
    }
  )
})

describe("acceptance corpus — tables", () => {
  const withTables = CORPUS.filter((sample) => sample.golden.tables)
  it.each(withTables.map((sample) => [sample.id, sample]))(
    "%s keeps every cell at its position, with spans and values",
    (id, sample) => {
      const tables = result(id).structure?.tables ?? []
      expect(
        tables.map((table) => ({
          rowCount: table.rowCount,
          columnCount: table.columnCount,
          headerRowCount: table.headerRowCount,
          ...(table.caption ? { caption: table.caption } : {}),
          cells: table.cells.map(cellOf),
        }))
      ).toEqual(sample.golden.tables!.map(({ locator: _locator, ...golden }) => golden))
    }
  )
})

describe("acceptance corpus — locators", () => {
  const withTables = CORPUS.filter((sample) => sample.golden.tables)
  it.each(withTables.map((sample) => [sample.id, sample]))(
    "%s locates each table where it is",
    (id, sample) => {
      const document = result(id)
      const tables = document.structure?.tables ?? []
      sample.golden.tables!.forEach((golden, index) => {
        const locator = tables[index]?.locator
        if (golden.locator === "text") {
          expect(locator?.type).toBe("text")
          if (locator?.type !== "text") return
          const slice = document.content.slice(locator.start, locator.end)
          for (const cell of golden.cells) {
            if (cell.text) expect([cell.text, slice.includes(cell.text)]).toEqual([cell.text, true])
          }
        } else {
          expect(locator).toEqual(golden.locator)
        }
      })
    }
  )
})

describe("acceptance corpus — parse identity", () => {
  it.each(CORPUS.map((sample) => [sample.id, sample]))("%s names its reader", (id, sample) => {
    expect(result(id).structure?.parse).toMatchObject({
      parser: sample.golden.parser,
      strategy: "native",
    })
  })
})

describe("acceptance corpus — negative samples", () => {
  it("refuses an encrypted OpenDocument file with an actionable error", async () => {
    const encrypted = await zipBuffer({
      "content.xml": "<office:document-content/>",
      "META-INF/manifest.xml":
        '<manifest:manifest><manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>',
    })
    await expect(processDocumentAsync("enc", "secret.odt", encrypted)).rejects.toThrow(
      /encrypt|password/i
    )
  })

  it("refuses text named as a workbook instead of reading it as one", async () => {
    const notXlsx = new TextEncoder().encode("this is not a spreadsheet").buffer
    await expect(processDocumentAsync("bad", "broken.xlsx", notXlsx)).rejects.toMatchObject({
      name: "DocumentFormatMismatchError",
      diagnostic: { code: "format_mismatch", severity: "error" },
    })
  })

  it("reads an .xls that is really HTML, as Excel does, and says so", async () => {
    const htmlXls = "<table><tr><td>旧表 Legacy</td><td>1</td></tr></table>"
    const document = await processDocumentAsync("html-xls", "export.xls", htmlXls)
    expect(document.content).toContain("旧表 Legacy")
    expect(document.parseDiagnostics).toContainEqual(
      expect.objectContaining({ code: "format_mismatch", severity: "warning" })
    )
  })

  it("refuses a PDF whose bytes are not a PDF", async () => {
    await expect(
      processDocumentAsync("fake", "scan.pdf", new TextEncoder().encode("# notes").buffer)
    ).rejects.toMatchObject({ diagnostic: { code: "format_mismatch" } })
  })

  it("refuses a Word file whose package has no document", async () => {
    await expect(
      processDocumentAsync(
        "empty",
        "empty.docx",
        await zipBuffer({ "[Content_Types].xml": "<Types/>" })
      )
    ).rejects.toThrow()
  })

  it("refuses an HTML table whose spans would lay out past the cell budget", async () => {
    const rows = Array.from({ length: 1100 }, () => "<tr><td>x</td></tr>").join("")
    await expect(
      processDocumentAsync(
        "wide",
        "wide.html",
        `<table><tr><td colspan="1000">w</td></tr>${rows}</table>`
      )
    ).rejects.toBeInstanceOf(DocumentLimitError)
  })

  it("reports bytes that are not valid UTF-8 instead of decoding them silently", async () => {
    const invalid = Uint8Array.from([0x68, 0x69, 0xff, 0xfe, 0x21]).buffer
    const document = await processDocumentAsync("latin", "notes.txt", invalid)
    expect(document.parseDiagnostics?.length).toBeGreaterThan(0)
  })

  it("gives text without tables no table structure", () => {
    expect(result("markdown-bilingual-guide").structure).not.toHaveProperty("tables")
  })
})
