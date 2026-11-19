import assert from "node:assert/strict"
import JSZip from "jszip"
import { parseOpenDocumentSpreadsheet } from "../../../packages/document/src/parsers/open-document-parser"
import { inspectUploadContent } from "../../../lib/security/upload-content-inspection"
import { importCanvasDocument } from "../../../lib/canvas/document-import"

async function main() {
  // Deliberately bounded: 10,000 cells, not a resource-exhaustion attempt.
  const zip = new JSZip()
  zip.file("mimetype", "application/vnd.oasis.opendocument.spreadsheet")
  zip.file(
    "META-INF/manifest.xml",
    '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'
  )
  zip.file(
    "content.xml",
    '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="Expansion"><table:table-row table:number-rows-repeated="10000"><table:table-cell><text:p>value</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>'
  )
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
  const inspected = inspectUploadContent({
    name: "repeat.ods",
    declaredMediaType: "application/vnd.oasis.opendocument.spreadsheet",
    bytes,
  })
  const result = await parseOpenDocumentSpreadsheet(Uint8Array.from(bytes).buffer)
  assert.equal(result.sheets[0].rowCount, 10000)
  console.log(
    JSON.stringify({
      probe: "bounded-ods-expansion",
      inputBytes: bytes.byteLength,
      rows: result.sheets[0].rowCount,
      uploadInspectionPassed: inspected.archive,
    })
  )

  const office = new JSZip()
  office.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
  )
  office.file("word/document.xml", "<document/>")
  office.file("word/vbaProject.bin", "inert audit fixture; no executable macro")
  const macroBytes = await office.generateAsync({ type: "uint8array" })
  assert.throws(
    () =>
      inspectUploadContent({
        name: "sample.docm",
        declaredMediaType: "application/vnd.ms-word.document.macroenabled.12",
        bytes: macroBytes,
      }),
    /malicious_content/
  )
  let parserReached = false
  await importCanvasDocument(new File([Uint8Array.from(macroBytes)], "sample.docm"), {
    processDocument: async () => {
      parserReached = true
      return { type: "word", content: "fixture" }
    },
  })
  assert.equal(parserReached, true)
  console.log(
    JSON.stringify({
      probe: "canvas-admission-boundary",
      uploadRejected: true,
      canvasReachedInjectedParser: parserReached,
      scope: "routing only; no macro executed",
    })
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
