import assert from "node:assert/strict"
import ExcelJS from "exceljs"
import JSZip from "jszip"
import {
  createDocument,
  applyDocumentOperations,
  validateDocument,
} from "../../../plugins/cognia-documents/src/model.ts"
import {
  exportDocx,
  importDocx,
  validateDocxRoundTrip,
} from "../../../plugins/cognia-documents/src/docx.ts"
import { exportWorkbookXlsx, importWorkbookXlsx } from "../../../plugins/cognia-office/src/xlsx.ts"
import { createPresentation } from "../../../plugins/cognia-presentations/src/model.ts"
import {
  exportPptx,
  importPptx,
  validatePptxRoundTrip,
} from "../../../plugins/cognia-presentations/src/pptx.ts"

const model = applyDocumentOperations(createDocument("Table comment", "Intro paragraph"), [
  {
    op: "appendTable",
    rows: [
      ["Item", "Value"],
      ["A", "10"],
    ],
  },
])
const table = model.blocks.find((b) => b.type === "table")!
const annotated = applyDocumentOperations(model, [
  { op: "addComment", blockId: table.id, text: "Check this table", author: "Reviewer" },
])
const docBytes = await exportDocx(annotated)
const docZip = await JSZip.loadAsync(docBytes)
const docXml = await docZip.file("word/document.xml")!.async("string")
const commentXml = await docZip.file("word/comments.xml")!.async("string")
const roundDoc = await importDocx(docBytes)
assert.equal(annotated.comments[0].blockId, table.id)
assert.equal((docXml.match(/<w:commentRangeStart\b/g) ?? []).length, 0)
assert.match(commentXml, /Check this table/)
assert.equal(roundDoc.comments[0].blockId, roundDoc.blocks[0].id)
assert.notEqual(roundDoc.comments[0].blockId, roundDoc.blocks.find((b) => b.type === "table")!.id)
console.log(
  "DOCX_TABLE_COMMENT",
  JSON.stringify({
    sourceComment: annotated.comments[0],
    modelValidation: validateDocument(annotated),
    exportValidation: await validateDocxRoundTrip(docBytes),
    commentAnchors: 0,
    roundTripComment: roundDoc.comments[0],
    roundTripBlockType: roundDoc.blocks.find((b) => b.id === roundDoc.comments[0].blockId)?.type,
  })
)

const workbook = new ExcelJS.Workbook()
const sheet = workbook.addWorksheet("Budget")
const a1 = sheet.getCell("A1")
a1.value = "Revenue"
a1.font = { name: "Courier New", size: 24, bold: true, underline: true }
a1.border = { bottom: { style: "double", color: { argb: "FFFF0000" } } }
a1.alignment = { textRotation: 45 }
const sourceXlsx = new Uint8Array(await workbook.xlsx.writeBuffer())
const directlyReopenedWorkbook = new ExcelJS.Workbook()
await directlyReopenedWorkbook.xlsx.load(sourceXlsx.buffer)
assert.equal(directlyReopenedWorkbook.worksheets[0].views, null)
assert.equal(directlyReopenedWorkbook.worksheets[0].getCell("A1").font.bold, true)
const importedWorkbook = await importWorkbookXlsx(sourceXlsx, "Budget")
const exportedWorkbook = new ExcelJS.Workbook()
await exportedWorkbook.xlsx.load((await exportWorkbookXlsx(importedWorkbook)).buffer)
const roundA1 = exportedWorkbook.worksheets[0].getCell("A1")
assert.deepEqual(importedWorkbook.unsupportedFeatures, [])
assert.equal(roundA1.font?.bold, undefined)
assert.equal(roundA1.font?.size, undefined)
assert.equal(roundA1.font?.name, undefined)
assert.equal(roundA1.font?.underline, undefined)
assert.equal(roundA1.border?.bottom, undefined)
assert.equal(roundA1.alignment?.textRotation, undefined)
console.log(
  "XLSX_SILENT_STYLES",
  JSON.stringify({
    before: { font: a1.font, border: a1.border, alignment: a1.alignment },
    warnings: importedWorkbook.unsupportedFeatures,
    modeledCell: importedWorkbook.sheets[0].cells.A1,
    after: { font: roundA1.font, border: roundA1.border, alignment: roundA1.alignment },
  })
)

sheet.views = [{ state: "normal" }]
const normalViewWorkbook = await importWorkbookXlsx(
  new Uint8Array(await workbook.xlsx.writeBuffer()),
  "Budget"
)
assert.equal(normalViewWorkbook.sheets[0].cells.A1.style?.font?.bold, true)
assert.deepEqual(normalViewWorkbook.unsupportedFeatures, [])
console.log(
  "XLSX_EXPLICIT_VIEW_CONTROL",
  JSON.stringify({
    modeledCell: normalViewWorkbook.sheets[0].cells.A1,
    unsupportedFeatures: normalViewWorkbook.unsupportedFeatures,
    directReopenDefaultViews: null,
  })
)

const deck = createPresentation("Rich runs")
deck.slides.push({
  id: "s1",
  title: "Rich runs",
  elements: [{ id: "e1", type: "text", x: 1, y: 1, width: 8, height: 1, text: "AlphaBeta" }],
})
const pptZip = await JSZip.loadAsync(await exportPptx(deck))
let slideXml = await pptZip.file("ppt/slides/slide1.xml")!.async("string")
slideXml = slideXml.replace(
  /<a:r>[\s\S]*?<\/a:r>/,
  '<a:r><a:rPr sz="1800" b="1"/><a:t>Alpha</a:t></a:r><a:r><a:rPr sz="3600" i="1"/><a:t>Beta</a:t></a:r>'
)
pptZip.file("ppt/slides/slide1.xml", slideXml)
const richPptx = await pptZip.generateAsync({ type: "uint8array" })
const importedDeck = await importPptx(richPptx)
const exportedPptx = await exportPptx(importedDeck)
const roundPptxZip = await JSZip.loadAsync(exportedPptx)
const roundSlideXml = await roundPptxZip.file("ppt/slides/slide1.xml")!.async("string")
assert.deepEqual(importedDeck.importedFeatures, [])
assert.equal(importedDeck.slides[0].elements[0].type, "text")
assert.equal((roundSlideXml.match(/<a:r>/g) ?? []).length, 1)
assert.doesNotMatch(roundSlideXml, /i="1"/)
assert.doesNotMatch(roundSlideXml, /sz="3600"/)
console.log(
  "PPTX_SILENT_RUNS",
  JSON.stringify({
    importedFeatures: importedDeck.importedFeatures,
    element: importedDeck.slides[0].elements[0],
    outputRunCount: 1,
    outputLostItalic: true,
    outputLostSecondRunSize: true,
    validation: await validatePptxRoundTrip(exportedPptx),
  })
)
