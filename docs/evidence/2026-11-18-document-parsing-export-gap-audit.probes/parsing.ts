import { processDocumentAsync } from "../../../packages/document/src/document-processor"
import { parseWord, parseExcel } from "../../../packages/document/src/parsers/office-parser"
import { parsePresentation } from "../../../packages/document/src/parsers/presentation-parser"
import { parseOpenDocumentSpreadsheet } from "../../../packages/document/src/parsers/open-document-parser"
import JSZip from "jszip"
import * as XLSX from "xlsx"
import { Document, Packer, Paragraph } from "docx"

async function main() {
  for (const [filename, data] of [
    ["sample.csv", "name,value\na,1.23456"],
    [
      "sample.html",
      "<html><head><title>Useful title</title><script>hidden script</script></head><body><h1>Heading</h1><p>Visible text</p></body></html>",
    ],
  ] as const) {
    const p = await processDocumentAsync("p", filename, data)
    console.log(
      JSON.stringify({
        probe: filename,
        type: p.type,
        parser: p.parseSummary?.parser,
        parseResult: !!p.parseResult,
        embeddableContent: p.embeddableContent,
        diagnostics: p.parseDiagnostics,
      })
    )
  }
  try {
    await processDocumentAsync(
      "p",
      "sample.txt",
      new TextEncoder().encode("a normal text file").buffer
    )
    console.log("text-buffer: accepted")
  } catch (e) {
    console.log("text-buffer: " + String(e))
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["rate"], [0.00012345], [1.23456789]]),
    "Rates"
  )
  const x = await processDocumentAsync(
    "x",
    "rates.xlsx",
    XLSX.write(wb, { type: "array", bookType: "xlsx" })
  )
  console.log(
    JSON.stringify({
      probe: "xlsx precision",
      content: x.content,
      embeddable: x.embeddableContent,
      sourceSegments: x.sourceSegments,
      quality: x.parseSummary?.quality,
    })
  )
  const ods = new JSZip()
  ods.file(
    "content.xml",
    `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Sheet"><table:table-row><table:table-cell><text:p>A1</text:p></table:table-cell><table:table-cell/><table:table-cell><text:p>C1</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell office:value-type="float" office:value="3.14159"/><table:table-cell><text:p>B2</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`
  )
  const o = await parseOpenDocumentSpreadsheet(await ods.generateAsync({ type: "arraybuffer" }))
  console.log(JSON.stringify({ probe: "ods cells", ...o }))
  const ppt = new JSZip()
  ppt.file(
    "ppt/presentation.xml",
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst></p:presentation>`
  )
  ppt.file(
    "ppt/_rels/presentation.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/></Relationships>`
  )
  ppt.file(
    "ppt/slides/slide1.xml",
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Second visual slide</a:t></p:sld>`
  )
  ppt.file(
    "ppt/slides/slide2.xml",
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>First visual slide</a:t></p:sld>`
  )
  ppt.file(
    "ppt/slides/slide3.xml",
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`
  )
  const p = await processDocumentAsync(
    "p",
    "deck.pptx",
    await ppt.generateAsync({ type: "arraybuffer" })
  )
  console.log(
    JSON.stringify({
      probe: "ppt order and empty slide",
      content: p.content,
      summary: p.parseSummary,
      sourceSegments: p.sourceSegments,
    })
  )
  const capped = await processDocumentAsync(
    "max",
    "large.txt",
    "content larger than requested maximum",
    { maxFileSize: 2 }
  )
  console.log(JSON.stringify({ probe: "maxFileSize option", length: capped.content.length }))
  const doc = new Document({
    title: "Actual DOCX Title",
    creator: "Actual Author",
    sections: [{ children: [new Paragraph("Body text")] }],
  })
  const docBytes = await Packer.toBuffer(doc)
  console.log(
    JSON.stringify({
      probe: "docx metadata regex against actual generated ZIP",
      coreMatch: /<cp:coreProperties[\s\S]*?<\/cp:coreProperties>/i.test(
        new TextDecoder().decode(docBytes)
      ),
    })
  )
  const z = await JSZip.loadAsync(docBytes)
  console.log(
    JSON.stringify({
      probe: "docx actual core XML",
      core: await z.file("docProps/core.xml")!.async("string"),
    })
  )
}
main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
