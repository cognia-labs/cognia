import * as cheerio from "cheerio"
import {
  cellValueText,
  columnLetters,
  delimitedTable,
  formatStoredNumber,
  htmlTable,
  htmlTables,
  locateTables,
  mergedGridTable,
  parseCellRange,
  placeTableRows,
  sheetHasHeaderRow,
  sheetTable,
  tableGrid,
  tableToMarkdown,
} from "./document-tables"
import { DocumentBudget, DocumentLimitError } from "./limits"
import type { DocumentTable } from "./types"

const cell = (
  row: number,
  column: number,
  text: string,
  extra: Partial<{ rowSpan: number; columnSpan: number; header: boolean }> = {}
) => ({ row, column, rowSpan: 1, columnSpan: 1, text, ...extra })

const firstTable = (html: string) => {
  const $ = cheerio.load(html)
  return htmlTable($, $("table").first(), 1)
}

describe("htmlTable", () => {
  it("places merged cells at their real columns, by the HTML table model (G3)", () => {
    const table = firstTable(`
      <table>
        <caption> Quarterly  sales </caption>
        <thead>
          <tr><th rowspan="2">Region</th><th colspan="2">Q1</th></tr>
          <tr><th>Jan</th><th>Feb</th></tr>
        </thead>
        <tbody>
          <tr><td rowspan="2">North</td><td>1</td><td>2</td></tr>
          <tr><td>3</td><td>4</td></tr>
        </tbody>
      </table>`)
    expect(table).toEqual({
      index: 1,
      caption: "Quarterly sales",
      rowCount: 4,
      columnCount: 3,
      headerRowCount: 2,
      cells: [
        cell(0, 0, "Region", { rowSpan: 2, header: true }),
        cell(0, 1, "Q1", { columnSpan: 2, header: true }),
        cell(1, 1, "Jan", { header: true }),
        cell(1, 2, "Feb", { header: true }),
        cell(2, 0, "North", { rowSpan: 2 }),
        cell(2, 1, "1"),
        cell(2, 2, "2"),
        // Reading cells in order put 3 under Region; it is under Jan.
        cell(3, 1, "3"),
        cell(3, 2, "4"),
      ],
    })
  })

  it("reads span attributes as HTML does", () => {
    const table = firstTable(`
      <table>
        <tbody>
          <tr><td rowspan="0">all</td><td colspan="0">zero</td><td colspan="2abc">two</td></tr>
          <tr><td>b</td></tr>
          <tr><td rowspan="9">past the group</td></tr>
        </tbody>
        <tbody><tr><td>next group</td></tr></tbody>
      </table>`)
    expect(table.cells).toEqual([
      // rowspan="0" reaches the end of its row group; colspan="0" is 1.
      cell(0, 0, "all", { rowSpan: 3 }),
      cell(0, 1, "zero"),
      cell(0, 2, "two", { columnSpan: 2 }),
      cell(1, 1, "b"),
      // A rowspan stops at the end of its row group.
      cell(2, 1, "past the group"),
      cell(3, 0, "next group"),
    ])
    expect(table.columnCount).toBe(4)
    expect(table.rowCount).toBe(4)
  })

  it("puts the footer last, reads rows outside a section, and keeps cell line breaks", () => {
    const table = firstTable(`
      <table>
        <tfoot><tr><td>total</td></tr></tfoot>
        <tr><th>head</th></tr>
        <tr><td><p>one</p><p>two   words</p>line<br>break</td></tr>
      </table>`)
    expect(table.cells).toEqual([
      cell(0, 0, "head", { header: true }),
      cell(1, 0, "one\ntwo words\nline\nbreak"),
      cell(2, 0, "total"),
    ])
    // Without a <thead>, leading rows of header cells head the table.
    expect(table.headerRowCount).toBe(1)
  })

  it("refuses a span that would expand past the cell budget", () => {
    const $ = cheerio.load(`<table><tr><td colspan="20">wide</td></tr></table>`)
    expect(() => htmlTable($, $("table"), 1, new DocumentBudget("expanded-cells", 10))).toThrow(
      DocumentLimitError
    )
  })

  it("counts the positions no cell covers, which a projection lays out", () => {
    // One cell 9 columns wide over 9 one-cell rows: 18 cells, a 90-position grid.
    const rows = Array.from({ length: 9 }, () => "<tr><td>x</td></tr>").join("")
    const $ = cheerio.load(`<table><tr><td colspan="9">wide</td></tr>${rows}</table>`)
    expect(() => htmlTable($, $("table"), 1, new DocumentBudget("expanded-cells", 89))).toThrow(
      DocumentLimitError
    )
    expect(htmlTable($, $("table"), 1, new DocumentBudget("expanded-cells", 90)).rowCount).toBe(10)
  })

  it("finds every table, nested ones included, in document order", () => {
    const $ = cheerio.load(
      `<table><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table><table><tr><td>second</td></tr></table>`
    )
    const tables = htmlTables($)
    expect(tables.map((table) => [table.index, table.cells[0].text])).toEqual([
      [1, "outer\ninner"],
      [2, "inner"],
      [3, "second"],
    ])
  })
})

describe("placeTableRows", () => {
  it("places cells from any source by the HTML table model", () => {
    expect(
      placeTableRows([
        {
          header: false,
          rows: [
            [
              { text: "a", rowspan: "2", header: true },
              { text: "b", colspan: " 2 ", header: true },
            ],
            [{ text: "c", header: false }],
          ],
        },
      ])
    ).toEqual({
      rowCount: 2,
      columnCount: 3,
      // The second row holds a non-header cell, so only the first heads it.
      headerRowCount: 1,
      cells: [
        cell(0, 0, "a", { rowSpan: 2, header: true }),
        cell(0, 1, "b", { columnSpan: 2, header: true }),
        cell(1, 1, "c"),
      ],
    })
  })
})

describe("mergedGridTable", () => {
  it("heads the grid with the rows its source marks, and gives no locator", () => {
    const table = mergedGridTable(
      {
        data: [
          ["Name", "Age"],
          ["Ada", 36],
        ],
        columnCount: 2,
        headerRowCount: 1,
      },
      3
    )
    expect(table).toEqual({
      index: 3,
      rowCount: 2,
      columnCount: 2,
      headerRowCount: 1,
      cells: [
        { ...cell(0, 0, "Name", { header: true }), value: "Name" },
        { ...cell(0, 1, "Age", { header: true }), value: "Age" },
        { ...cell(1, 0, "Ada"), value: "Ada" },
        { ...cell(1, 1, "36"), value: 36 },
      ],
    })
    expect(
      mergedGridTable({ data: [["x"]], columnCount: 1, headerRowCount: 5 }, 1).headerRowCount
    ).toBe(1)
  })

  it("refuses merges that widen the grid past the budget before building it", () => {
    const sheet = { data: [["x"]], columnCount: 1, headerRowCount: 0 }
    // One stored cell, a merge claiming every row and column a sheet can have.
    expect(() => mergedGridTable({ ...sheet, mergedCells: ["A1:XFD1048576"] }, 1)).toThrow(
      DocumentLimitError
    )
    // Overlapping merges cost what they repeat, though the grid is small.
    const overlapping = Array.from({ length: 20 }, () => "A1:A1")
    expect(() =>
      mergedGridTable(
        { ...sheet, mergedCells: overlapping },
        1,
        new DocumentBudget("expanded-cells", 19)
      )
    ).toThrow(DocumentLimitError)
  })
})

describe("sheetTable", () => {
  it("keeps typed values and merged ranges as spans, located by the used range (G3)", () => {
    const table = sheetTable(
      {
        name: "Sales",
        data: [
          ["Region", "Q1", null],
          ["North", 0.1, true],
          [null, 12345678901234, null],
        ],
        columnCount: 3,
        mergedCells: ["A2:A3", "B1:C1", "E5:F6"],
      },
      2
    )
    expect(table).toEqual({
      index: 2,
      locator: { type: "sheet", sheet: "Sales", range: "A1:F6" },
      rowCount: 6,
      columnCount: 6,
      headerRowCount: 1,
      cells: [
        { ...cell(0, 0, "Region", { header: true }), value: "Region" },
        { ...cell(0, 1, "Q1", { columnSpan: 2, header: true }), value: "Q1" },
        { ...cell(1, 0, "North", { rowSpan: 2 }), value: "North" },
        { ...cell(1, 1, "0.1"), value: 0.1 },
        { ...cell(1, 2, "TRUE"), value: true },
        { ...cell(2, 1, "12345678901234"), value: 12345678901234 },
        // A merge whose top-left holds nothing still occupies its range.
        { ...cell(4, 4, "", { rowSpan: 2, columnSpan: 2 }), value: null },
      ],
    })
  })

  it("has no header row when the first row holds a number, and no locator when empty", () => {
    expect(sheetTable({ name: "N", data: [[1], ["a"]], columnCount: 1 }, 1).headerRowCount).toBe(0)
    expect(sheetTable({ name: "E", data: [], columnCount: 0 }, 1)).toEqual({
      index: 1,
      rowCount: 0,
      columnCount: 0,
      headerRowCount: 0,
      cells: [],
    })
  })
})

describe("delimitedTable", () => {
  it("heads the grid with the header row and leaves empty fields out", () => {
    expect(
      delimitedTable(
        ["a", "b"],
        [
          ["1", ""],
          ["2", "3", "4"],
        ],
        1
      )
    ).toEqual({
      index: 1,
      rowCount: 3,
      columnCount: 3,
      headerRowCount: 1,
      cells: [
        cell(0, 0, "a", { header: true }),
        cell(0, 1, "b", { header: true }),
        cell(1, 0, "1"),
        cell(2, 0, "2"),
        cell(2, 1, "3"),
        cell(2, 2, "4"),
      ],
    })
  })
})

describe("tableGrid", () => {
  it("lays the text out by position and counts the repeated values", () => {
    const table: DocumentTable = {
      index: 1,
      rowCount: 2,
      columnCount: 2,
      headerRowCount: 0,
      cells: [cell(0, 0, "a", { columnSpan: 2 }), cell(1, 0, "", { columnSpan: 2 })],
    }
    // An empty merged cell repeats nothing.
    expect(tableGrid(table)).toEqual({
      grid: [
        ["a", "a"],
        ["", ""],
      ],
      repeated: 1,
    })
  })
})

describe("tableToMarkdown", () => {
  const merged: DocumentTable = {
    index: 1,
    caption: "Sales",
    rowCount: 3,
    columnCount: 2,
    headerRowCount: 1,
    cells: [
      cell(0, 0, "Region", { header: true }),
      cell(0, 1, "Amount", { header: true }),
      cell(1, 0, "North", { rowSpan: 2 }),
      cell(1, 1, "a|b"),
      cell(2, 1, "two\nlines"),
    ],
  }

  it("repeats a merged value into the positions it covers, and counts them", () => {
    expect(tableToMarkdown(merged)).toEqual({
      markdown: [
        "*Sales*",
        "",
        "| Region | Amount |",
        "| --- | --- |",
        "| North | a\\|b |",
        "| North | two<br>lines |",
      ].join("\n"),
      repeatedCells: 1,
    })
  })

  it("gives a table without header rows an empty one, as GFM requires", () => {
    const table: DocumentTable = {
      index: 1,
      rowCount: 1,
      columnCount: 2,
      headerRowCount: 0,
      cells: [cell(0, 0, "x"), cell(0, 1, "y")],
    }
    expect(tableToMarkdown(table).markdown).toBe("|  |  |\n| --- | --- |\n| x | y |")
    expect(tableToMarkdown({ ...table, rowCount: 0, cells: [] })).toEqual({
      markdown: "",
      repeatedCells: 0,
    })
  })
})

describe("locateTables", () => {
  const table = (texts: string[]): DocumentTable => ({
    index: 1,
    rowCount: 1,
    columnCount: texts.length,
    headerRowCount: 0,
    cells: texts.map((text, column) => cell(0, column, text)),
  })

  it("finds each table's cells in reading order, after the one before", () => {
    const content = "Name in prose.\n\nName\nAge\nJane\n\nmore\n\nName\nCity"
    const [first, second] = locateTables(content, [
      table(["Name", "Age", "Jane"]),
      table(["Name", "City"]),
    ])
    expect(first.locator).toEqual({ type: "text", start: 16, end: 29 })
    expect(content.slice(16, 29)).toBe("Name\nAge\nJane")
    expect(second.locator).toEqual({ type: "text", start: 37, end: 46 })
  })

  it("gives no locator it cannot back, and keeps one the table already has", () => {
    expect(locateTables("only a", [table(["a", "missing"])])[0].locator).toBeUndefined()
    const sheet = { ...table(["a"]), locator: { type: "sheet" as const, sheet: "S" } }
    expect(locateTables("a", [sheet])[0].locator).toEqual({ type: "sheet", sheet: "S" })
  })
})

describe("cell helpers", () => {
  it("formats stored values as the cell shows them", () => {
    expect(formatStoredNumber(0.1 + 0.2)).toBe("0.3")
    expect(formatStoredNumber(0.00012345)).toBe("0.00012345")
    expect(cellValueText(null)).toBe("")
    expect(cellValueText(false)).toBe("FALSE")
    expect(cellValueText(2.5)).toBe("2.5")
    expect(cellValueText("x")).toBe("x")
  })

  it("reads ranges and column letters", () => {
    expect(columnLetters(0)).toBe("A")
    expect(columnLetters(27)).toBe("AB")
    expect(parseCellRange("$B$2:A1")).toEqual({ top: 0, left: 0, bottom: 1, right: 1 })
    expect(parseCellRange("C3")).toEqual({ top: 2, left: 2, bottom: 2, right: 2 })
    expect(parseCellRange("not a range")).toBeNull()
  })

  it("takes the first row as headers only when it is text over data", () => {
    expect(
      sheetHasHeaderRow([
        ["a", "b"],
        [1, 2],
      ])
    ).toBe(true)
    expect(sheetHasHeaderRow([["a"]])).toBe(false)
    expect(sheetHasHeaderRow([[], ["x"]])).toBe(false)
    expect(
      sheetHasHeaderRow([
        ["a", 1],
        [1, 2],
      ])
    ).toBe(false)
  })
})
