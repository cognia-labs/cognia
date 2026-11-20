import JSZip from "jszip"
import {
  parseOpenDocumentPresentation,
  parseOpenDocumentSpreadsheet,
  parseOpenDocumentText,
} from "./open-document-parser"

async function createOpenDocumentBuffer(entries: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()

  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, content)
  }

  const bytes = await zip.generateAsync({ type: "uint8array" })
  return Uint8Array.from(bytes).buffer
}

describe("open-document-parser", () => {
  it("parses readable text and metadata from odt content", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content>
          <text:h text:outline-level="1">Chapter 1</text:h>
          <text:p>OpenDocument text paragraph</text:p>
        </office:document-content>
      `,
      "meta.xml": `
        <office:document-meta>
          <dc:title>Notebook</dc:title>
          <dc:creator>Alice</dc:creator>
        </office:document-meta>
      `,
    })

    const result = await parseOpenDocumentText(buffer)

    expect(result.text).toContain("Chapter 1")
    expect(result.text).toContain("OpenDocument text paragraph")
    expect(result.metadata?.title).toBe("Notebook")
    expect(result.metadata?.author).toBe("Alice")
  })

  it("reads a text document's tables as typed grids, spans and header rows kept (G3)", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content><office:body><office:text>
          <text:p>Budget</text:p>
          <table:table table:name="Costs">
            <table:table-header-rows>
              <table:table-row>
                <table:table-cell office:value-type="string"><text:p>Item</text:p></table:table-cell>
                <table:table-cell office:value-type="string"><text:p>Cost</text:p></table:table-cell>
              </table:table-row>
            </table:table-header-rows>
            <table:table-row>
              <table:table-cell table:number-rows-spanned="2" office:value-type="string"><text:p>Travel</text:p></table:table-cell>
              <table:table-cell office:value-type="float" office:value="10"><text:p>10.00</text:p></table:table-cell>
            </table:table-row>
            <table:table-row>
              <table:covered-table-cell/>
              <table:table-cell office:value-type="float" office:value="20"><text:p>20.00</text:p></table:table-cell>
            </table:table-row>
          </table:table>
        </office:text></office:body></office:document-content>
      `,
    })

    const result = await parseOpenDocumentText(buffer)

    expect(result.tables).toEqual([
      {
        index: 1,
        rowCount: 3,
        columnCount: 2,
        headerRowCount: 1,
        cells: [
          {
            row: 0,
            column: 0,
            rowSpan: 1,
            columnSpan: 1,
            text: "Item",
            value: "Item",
            header: true,
          },
          {
            row: 0,
            column: 1,
            rowSpan: 1,
            columnSpan: 1,
            text: "Cost",
            value: "Cost",
            header: true,
          },
          { row: 1, column: 0, rowSpan: 2, columnSpan: 1, text: "Travel", value: "Travel" },
          { row: 1, column: 1, rowSpan: 1, columnSpan: 1, text: "10", value: 10 },
          { row: 2, column: 1, rowSpan: 1, columnSpan: 1, text: "20", value: 20 },
        ],
      },
    ])
    // The text still reads each cell as a paragraph.
    expect(result.text).toBe("Budget\n\nItem\n\nCost\n\nTravel\n\n10.00\n\n20.00")
  })

  it("parses sheet content from ods content", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content>
          <table:table table:name="Sheet A">
            <table:table-row>
              <table:table-cell><text:p>Name</text:p></table:table-cell>
              <table:table-cell><text:p>Value</text:p></table:table-cell>
            </table:table-row>
            <table:table-row>
              <table:table-cell><text:p>Alpha</text:p></table:table-cell>
              <table:table-cell><text:p>42</text:p></table:table-cell>
            </table:table-row>
          </table:table>
        </office:document-content>
      `,
    })

    const result = await parseOpenDocumentSpreadsheet(buffer)

    expect(result.sheetNames).toEqual(["Sheet A"])
    expect(result.sheets[0].data[1]).toEqual(["Alpha", "42"])
    expect(result.text).toContain("Sheet A")
  })

  it("keeps empty, covered and value-only cells in their columns (F5)", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content>
          <office:body><office:spreadsheet>
          <table:table table:name="Typed">
            <table:table-header-rows>
              <table:table-row>
                <table:table-cell><text:p>A1</text:p></table:table-cell>
                <table:table-cell/>
                <table:table-cell><text:p>C1</text:p></table:table-cell>
              </table:table-row>
            </table:table-header-rows>
            <table:table-row>
              <table:table-cell office:value-type="float" office:value="3.14159"/>
              <table:table-cell office:value-type="percentage" office:value="0.125"><text:p>13%</text:p></table:table-cell>
              <table:table-cell office:value-type="boolean" office:boolean-value="false"><text:p>FALSE</text:p></table:table-cell>
              <table:table-cell office:value-type="date" office:date-value="2024-01-15"><text:p>15/01/24</text:p></table:table-cell>
            </table:table-row>
            <table:table-row>
              <table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="2"><text:p>merged</text:p></table:table-cell>
              <table:covered-table-cell/>
              <table:table-cell><text:p>two<text:s text:c="2"/>spaces<text:line-break/>next</text:p></table:table-cell>
            </table:table-row>
            <table:table-row>
              <table:covered-table-cell table:number-columns-repeated="2"/>
              <table:table-cell><text:p>C4 &amp; more</text:p></table:table-cell>
            </table:table-row>
          </table:table>
          </office:spreadsheet></office:body>
        </office:document-content>
      `,
    })

    const result = await parseOpenDocumentSpreadsheet(buffer)

    expect(result.sheets[0].data).toEqual([
      ["A1", null, "C1"],
      [3.14159, 0.125, false, "2024-01-15"],
      ["merged", null, "two  spaces\nnext"],
      [null, null, "C4 & more"],
    ])
    expect(result.sheets[0].mergedCells).toEqual(["A3:B4"])
    expect(result.text).toContain("A1 |  | C1")
    expect(result.text).toContain("3.14159 | 0.125 | FALSE | 2024-01-15")
  })

  it("expands repeats but not the trailing padding office suites write (F7)", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content><office:body><office:spreadsheet>
          <table:table table:name="Padded">
            <table:table-row table:number-rows-repeated="2">
              <table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell>
              <table:table-cell table:number-columns-repeated="16380"/>
            </table:table-row>
            <table:table-row table:number-rows-repeated="1048574">
              <table:table-cell table:number-columns-repeated="16384"/>
            </table:table-row>
          </table:table>
        </office:spreadsheet></office:body></office:document-content>
      `,
    })

    const result = await parseOpenDocumentSpreadsheet(buffer)

    expect(result.sheets[0].data).toEqual([
      ["x", "x"],
      ["x", "x"],
    ])
  })

  it("refuses repeats that would expand past the cell budget, and malformed counts", async () => {
    const bomb = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content><office:body><office:spreadsheet>
          <table:table table:name="Bomb">
            <table:table-row table:number-rows-repeated="10000">
              <table:table-cell table:number-columns-repeated="100"><text:p>x</text:p></table:table-cell>
            </table:table-row>
          </table:table>
        </office:spreadsheet></office:body></office:document-content>
      `,
    })
    await expect(
      parseOpenDocumentSpreadsheet(bomb, { maxExpandedCells: 999_999 })
    ).rejects.toMatchObject({ name: "DocumentLimitError", scope: "expanded-cells" })

    const malformed = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content><office:body><office:spreadsheet>
          <table:table table:name="Bad">
            <table:table-row table:number-rows-repeated="1e400">
              <table:table-cell><text:p>x</text:p></table:table-cell>
            </table:table-row>
          </table:table>
        </office:spreadsheet></office:body></office:document-content>
      `,
    })
    await expect(parseOpenDocumentSpreadsheet(malformed)).rejects.toThrow("repeat count")
  })

  it("keeps a textless slide's position and leaves speaker notes out of slide text", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content>
          <draw:page draw:name="one"><draw:frame><draw:text-box><text:p>First</text:p></draw:text-box></draw:frame>
            <presentation:notes><draw:frame><draw:text-box><text:p>Say hello</text:p></draw:text-box></draw:frame></presentation:notes>
          </draw:page>
          <draw:page draw:name="picture"/>
          <draw:page draw:name="three"><text:p>Third</text:p></draw:page>
        </office:document-content>
      `,
    })

    const result = await parseOpenDocumentPresentation(buffer)

    expect(result.slideCount).toBe(3)
    expect(result.slides.map((slide) => [slide.slideNumber, slide.text])).toEqual([
      [1, "First"],
      [2, ""],
      [3, "Third"],
    ])
    expect(result.text).toBe("## Slide 1\nFirst\n\n## Slide 3\nThird")
  })

  it("parses slide text from odp content", async () => {
    const buffer = await createOpenDocumentBuffer({
      "content.xml": `
        <office:document-content>
          <draw:page draw:name="page1">
            <text:p>Roadmap</text:p>
            <text:p>Launch in Q4</text:p>
          </draw:page>
        </office:document-content>
      `,
      "meta.xml": `
        <office:document-meta>
          <dc:title>Launch Deck</dc:title>
          <dc:creator>Bob</dc:creator>
        </office:document-meta>
      `,
    })

    const result = await parseOpenDocumentPresentation(buffer)

    expect(result.slideCount).toBe(1)
    expect(result.slides[0].text).toContain("Roadmap")
    expect(result.metadata.title).toBe("Launch Deck")
  })

  it("throws actionable error for encrypted open document archives", async () => {
    const buffer = await createOpenDocumentBuffer({
      "META-INF/manifest.xml": `
        <manifest:manifest>
          <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
          <manifest:encryption-data />
        </manifest:manifest>
      `,
      "content.xml": "<office:document-content />",
    })

    await expect(parseOpenDocumentText(buffer)).rejects.toThrow("password protected")
  })
})
