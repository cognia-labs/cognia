/** @jest-environment jsdom */
import { inflateSync } from "node:zlib"

const generatePdfMock = jest.fn()
jest.mock("@/lib/files/document-writer", () => ({
  generatePdf: (opts: unknown) => generatePdfMock(opts),
}))

const renderPngMock = jest.fn()
jest.mock("./raster", () => ({
  ...jest.requireActual<typeof import("./raster")>("./raster"),
  renderArtifactToPngBlob: (...args: unknown[]) => renderPngMock(...args),
}))

const addImageMock = jest.fn()
const outputMock = jest.fn(() => new Blob(["pdf"], { type: "application/pdf" }))
const jsPDFMock = jest.fn()
const textMock = jest.fn()
const addPageMock = jest.fn()
jest.mock("jspdf", () => ({
  jsPDF: class {
    constructor(opts: unknown) {
      const document = jsPDFMock(opts)
      if (document) return document
    }
    addImage = addImageMock
    output = outputMock
    text = textMock
    addPage = addPageMock
    setFont = jest.fn()
    setFontSize = jest.fn()
    splitTextToSize = (text: string) => text.split("\n")
    internal = { pageSize: { getHeight: () => 841.89, getWidth: () => 595.28 } }
  },
}))

import { pdfNeedsMountedPreview, renderArtifactToPdfBlob } from "./pdf"
import { ArtifactNotebookUnreadableError } from "./document-blocks"
import { ARTIFACT_RUNTIME_ADAPTERS } from "@/components/artifacts/runtime-adapters"

// jsdom does not decode images; stand in for the natural-size read.
let imageSize = { width: 800, height: 400 }
let imageShouldFail = false
beforeAll(() => {
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    set(this: HTMLImageElement) {
      Object.defineProperty(this, "naturalWidth", { value: imageSize.width, configurable: true })
      Object.defineProperty(this, "naturalHeight", { value: imageSize.height, configurable: true })
      setTimeout(() => this.dispatchEvent(new Event(imageShouldFail ? "error" : "load")), 0)
    },
    configurable: true,
  })
})

beforeEach(() => {
  generatePdfMock.mockReset().mockResolvedValue({
    data: new Blob(["doc"], { type: "application/pdf" }),
    mimeType: "application/pdf",
    filename: "x.pdf",
  })
  renderPngMock.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }))
  addImageMock.mockClear()
  jsPDFMock.mockClear()
  textMock.mockClear()
  addPageMock.mockClear()
  imageSize = { width: 800, height: 400 }
  imageShouldFail = false
})

describe("text-shaped artifacts", () => {
  it.each(["document", "code", "jupyter"] as const)(
    "%s PDF does not need a mounted preview",
    (type) => expect(pdfNeedsMountedPreview({ type })).toBe(false)
  )

  it("uses the jupyter transport as well as the text type list", () => {
    const adapter = ARTIFACT_RUNTIME_ADAPTERS.html
    const previousTransport = adapter.transport
    adapter.transport = "jupyter"
    try {
      expect(pdfNeedsMountedPreview({ type: "html" })).toBe(false)
    } finally {
      adapter.transport = previousTransport
    }
  })

  it("lays a document out from its Markdown", async () => {
    await renderArtifactToPdfBlob({ id: "a", type: "document", title: "T", content: "# hi" })
    expect(generatePdfMock).toHaveBeenCalledWith({
      title: "T",
      blocks: [{ kind: "heading", level: 1, text: "hi" }],
    })
    expect(renderPngMock).not.toHaveBeenCalled()
  })

  it("lays code out verbatim, not as Markdown (A07)", async () => {
    const content = "# comment\nif x:\n    y()"
    await renderArtifactToPdfBlob({ id: "a", type: "code", title: "T", content })
    expect(generatePdfMock).toHaveBeenCalledWith({
      title: "T",
      blocks: [{ kind: "code", text: content }],
    })
  })

  it("lays notebook cells and their figures out in reading order", async () => {
    const content = JSON.stringify({
      metadata: { kernelspec: { language: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Analysis\n", "A result."] },
        {
          cell_type: "code",
          source: "print(42)",
          execution_count: 7,
          outputs: [
            { output_type: "stream", text: ["42\n"] },
            { output_type: "display_data", data: { "image/png": "cG5n" } },
            { output_type: "display_data", data: { "text/markdown": "## Conclusion" } },
          ],
        },
      ],
    })
    await renderArtifactToPdfBlob({ id: "a", type: "jupyter", title: "T", content })
    expect(generatePdfMock.mock.calls[0][0].blocks).toEqual([
      { kind: "heading", level: 1, text: "Analysis" },
      { kind: "paragraph", text: "A result." },
      { kind: "paragraph", text: "In [7] (python)" },
      { kind: "code", text: "print(42)" },
      { kind: "code", text: "42\n" },
      { kind: "image", dataUrl: "data:image/png;base64,cG5n", format: "PNG" },
      { kind: "heading", level: 2, text: "Conclusion" },
    ])
    expect(renderPngMock).not.toHaveBeenCalled()
  })

  it("falls back to a stable title when the artifact has none", async () => {
    await renderArtifactToPdfBlob({ id: "a", type: "document", title: "", content: "x" })
    expect(generatePdfMock).toHaveBeenCalledWith(expect.objectContaining({ title: "artifact" }))
  })

  it.each(["{malformed", "null", '{"cells":null}'])(
    "rejects an unreadable notebook %s instead of printing its JSON (C09)",
    async (content) => {
      await expect(
        renderArtifactToPdfBlob({ id: "a", type: "jupyter", title: "T", content })
      ).rejects.toBeInstanceOf(ArtifactNotebookUnreadableError)
      expect(generatePdfMock).not.toHaveBeenCalled()
      expect(jsPDFMock).not.toHaveBeenCalled()
    }
  )

  it("produces a real PDF of a notebook with selectable text and an embedded PNG", async () => {
    const { jsPDF } = jest.requireActual<typeof import("jspdf")>("jspdf")
    jsPDFMock.mockImplementationOnce((options) => new jsPDF(options))
    const writer = jest.requireActual<typeof import("@/lib/files/document-writer")>(
      "@/lib/files/document-writer"
    )
    generatePdfMock.mockImplementationOnce((opts) => writer.generatePdf(opts))
    const content = JSON.stringify({
      cells: [
        { cell_type: "markdown", source: "# Analysis" },
        {
          cell_type: "code",
          source: "plot()",
          outputs: [
            {
              output_type: "display_data",
              data: {
                "image/png":
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              },
            },
          ],
        },
      ],
    })
    const blob = await renderArtifactToPdfBlob({ id: "a", type: "jupyter", title: "T", content })
    const pdf = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(Buffer.from(reader.result as ArrayBuffer).toString("latin1"))
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob)
    })
    // The writer deflates its streams, the page's text included.
    const text = Array.from(pdf.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g), ([, body]) => {
      try {
        return inflateSync(Buffer.from(body, "latin1")).toString("latin1")
      } catch {
        return body
      }
    }).join("\n")
    expect(pdf).toMatch(/^%PDF-/)
    expect(text).toContain("(Analysis)")
    expect(text).toContain("(plot\\(\\))")
    expect(pdf).toContain("/Subtype /Image")
  })
})

describe("visual artifacts", () => {
  it.each(["html", "svg", "react", "chart", "mermaid", "math"] as const)(
    "%s PDF needs a mounted preview",
    (type) => expect(pdfNeedsMountedPreview({ type })).toBe(true)
  )
  it("rasterises on a white sheet — a transparent PNG prints unpredictably", async () => {
    await renderArtifactToPdfBlob({ id: "a", type: "chart", title: "T", content: "{}" })
    expect(renderPngMock).toHaveBeenCalledWith(expect.objectContaining({ type: "chart" }), {
      background: "#ffffff",
    })
    expect(generatePdfMock).not.toHaveBeenCalled()
  })

  it("turns the page landscape for an image that is wider than tall", async () => {
    imageSize = { width: 1200, height: 400 }
    await renderArtifactToPdfBlob({ id: "a", type: "chart", title: "T", content: "{}" })
    expect(jsPDFMock).toHaveBeenCalledWith(expect.objectContaining({ orientation: "landscape" }))
  })

  it("keeps portrait for a tall image", async () => {
    imageSize = { width: 400, height: 1200 }
    await renderArtifactToPdfBlob({ id: "a", type: "mermaid", title: "T", content: "graph TD" })
    expect(jsPDFMock).toHaveBeenCalledWith(expect.objectContaining({ orientation: "portrait" }))
  })

  it("never upscales a small image past its natural size", async () => {
    imageSize = { width: 100, height: 50 }
    await renderArtifactToPdfBlob({ id: "a", type: "chart", title: "T", content: "{}" })
    const [, , , , width, height] = addImageMock.mock.calls[0]
    expect(width).toBe(100)
    expect(height).toBe(50)
  })

  it("scales a large image down to fit inside the page margins", async () => {
    imageSize = { width: 4000, height: 2000 }
    await renderArtifactToPdfBlob({ id: "a", type: "chart", title: "T", content: "{}" })
    const [, , x, y, width, height] = addImageMock.mock.calls[0]
    // Landscape A4 is 841.89 x 595.28pt with a 36pt margin on each side.
    expect(width).toBeLessThanOrEqual(841.89 - 72)
    expect(height).toBeLessThanOrEqual(595.28 - 72)
    expect(width / height).toBeCloseTo(2, 5)
    expect(x).toBeGreaterThan(0)
    expect(y).toBeGreaterThan(0)
  })
})
