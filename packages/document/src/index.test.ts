import {
  detectDocumentType,
  extractFirstTable,
  getFileExtension,
  inferKnowledgeFileTypeFromFilename,
} from "./index"

describe("document package barrel", () => {
  it("re-exports document processing helpers", () => {
    expect(getFileExtension("Report.PDF")).toBe("pdf")
    expect(detectDocumentType("notes.md")).toBe("markdown")
  })

  it("re-exports support matrix and table helpers", () => {
    expect(inferKnowledgeFileTypeFromFilename("deck.pptx")).toBe("presentation")
    const table = extractFirstTable("| Name | Value |\n| --- | --- |\n| A | 1 |")
    expect(table?.headers).toEqual(["Name", "Value"])
  })
})

it("exports shared canonical navigation builders", async () => {
  const { buildTextDocumentStructure, documentContentHash } = await import("./index")
  expect(buildTextDocumentStructure("# Chapter\nBody").contentHash).toBe(
    documentContentHash("# Chapter\nBody")
  )
})
