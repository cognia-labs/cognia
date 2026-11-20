/**
 * Tests for Presentation Parser
 */

import JSZip from "jszip"
import {
  parsePresentation,
  extractPresentationEmbeddableContent,
  type PresentationParseResult,
} from "./presentation-parser"

async function createValidPptxBuffer(): Promise<ArrayBuffer> {
  const zip = new JSZip()

  zip.file(
    "ppt/slides/slide1.xml",
    "<p:sld><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p><a:p><a:r><a:t>Revenue up 20%</a:t></a:r></a:p></p:sld>"
  )
  zip.file(
    "ppt/slides/slide2.xml",
    "<p:sld><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p><a:p><a:r><a:t>Launch in Q3</a:t></a:r></a:p></p:sld>"
  )
  zip.file(
    "docProps/core.xml",
    "<cp:coreProperties><dc:title>Q2 Deck</dc:title><dc:creator>Alice</dc:creator></cp:coreProperties>"
  )

  const bytes = await zip.generateAsync({ type: "uint8array" })
  return Uint8Array.from(bytes).buffer
}

describe("parsePresentation", () => {
  it("parses slides and metadata from valid pptx", async () => {
    const buffer = await createValidPptxBuffer()
    const result = await parsePresentation(buffer)

    expect(result.slideCount).toBe(2)
    expect(result.slides[0].slideNumber).toBe(1)
    expect(result.slides[0].text).toContain("Quarterly Review")
    expect(result.metadata.title).toBe("Q2 Deck")
    expect(result.metadata.author).toBe("Alice")
    expect(result.text).toContain("Slide 1")
    expect(result.text).toContain("Launch in Q3")
  })

  it("reads slides in presentation order and keeps textless slides (F6)", async () => {
    const zip = new JSZip()
    zip.file(
      "ppt/presentation.xml",
      `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>
        <p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId7"/><p:sldId id="258" r:id="rId8"/>
      </p:sldIdLst></p:presentation>`
    )
    zip.file(
      "ppt/_rels/presentation.xml.rels",
      `<Relationships>
        <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
        <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="/ppt/slides/slide3.xml"/>
        <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="./slides/../slides/slide2.xml"/>
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
      </Relationships>`
    )
    zip.file(
      "ppt/slides/slide2.xml",
      `<p:sld><a:p><a:r><a:t xml:space="preserve">Al</a:t></a:r><a:r><a:t>pha &amp; co</a:t></a:r><a:br/><a:r><a:t>second line</a:t></a:r></a:p></p:sld>`
    )
    zip.file("ppt/slides/slide1.xml", "<p:sld><p:pic/></p:sld>")
    zip.file("ppt/slides/slide3.xml", "<p:sld><a:p><a:fld><a:t>Gamma</a:t></a:fld></a:p></p:sld>")
    const bytes = await zip.generateAsync({ type: "uint8array" })

    const result = await parsePresentation(Uint8Array.from(bytes).buffer)

    expect(result.slideCount).toBe(3)
    expect(result.slides).toEqual([
      { slideNumber: 1, title: "Alpha & co", text: "Alpha & co\nsecond line" },
      { slideNumber: 2, text: "" },
      { slideNumber: 3, title: "Gamma", text: "Gamma" },
    ])
    expect(result.text).toBe("## Slide 1\nAlpha & co\nsecond line\n\n## Slide 3\nGamma")
  })

  it("throws explicit error for corrupted data", async () => {
    const corrupted = new Uint8Array([1, 2, 3, 4]).buffer
    await expect(parsePresentation(corrupted)).rejects.toThrow("Failed to parse presentation file")
  })

  it("throws when slides have no readable text", async () => {
    const zip = new JSZip()
    zip.file("ppt/slides/slide1.xml", "<p:sld><a:r></a:r></p:sld>")
    const bytes = await zip.generateAsync({ type: "uint8array" })
    const buffer = Uint8Array.from(bytes).buffer

    await expect(parsePresentation(buffer)).rejects.toThrow("No readable text content found")
  })
})

describe("extractPresentationEmbeddableContent", () => {
  it("includes metadata and body text", () => {
    const result: PresentationParseResult = {
      text: "## Slide 1\nOverview text",
      slideCount: 1,
      slides: [{ slideNumber: 1, title: "Overview", text: "Overview text" }],
      metadata: { title: "Deck Title", author: "Bob" },
    }

    const embeddable = extractPresentationEmbeddableContent(result)

    expect(embeddable).toContain("Title: Deck Title")
    expect(embeddable).toContain("Author: Bob")
    expect(embeddable).toContain("Overview text")
  })
})
