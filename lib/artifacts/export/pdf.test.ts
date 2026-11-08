/** @jest-environment jsdom */
const generateDocumentMock = jest.fn()
jest.mock("@/lib/files/document-writer", () => ({
  generateDocument: (opts: unknown) => generateDocumentMock(opts),
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
  generateDocumentMock.mockReset().mockResolvedValue({
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

  it("uses the jupyter transport as well as the text type list", async () => {
    const adapter = ARTIFACT_RUNTIME_ADAPTERS.html
    const previousTransport = adapter.transport
    adapter.transport = "jupyter"
    try {
      expect(pdfNeedsMountedPreview({ type: "html" })).toBe(false)
      await renderArtifactToPdfBlob({ id: "a", type: "html", title: "T", content: "# hi" })
      expect(generateDocumentMock).toHaveBeenCalledWith({
        title: "T",
        markdown: "# hi",
        format: "pdf",
      })
      expect(renderPngMock).not.toHaveBeenCalled()
    } finally {
      adapter.transport = previousTransport
    }
  })
  it("lays out notebook cells and embeds image outputs in reading order", async () => {
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
            { output_type: "display_data", data: { "image/jpeg": "anBlZw==" } },
            { output_type: "display_data", data: { "text/markdown": "## Conclusion" } },
          ],
        },
      ],
    })
    const result = await renderArtifactToPdfBlob({ id: "a", type: "jupyter", title: "T", content })
    expect(result.type).toBe("application/pdf")
    expect(generateDocumentMock).not.toHaveBeenCalled()
    expect(renderPngMock).not.toHaveBeenCalled()
    const text = textMock.mock.calls.map(([line]) => line).join("\n")
    expect(text).toContain("Analysis")
    expect(text).toContain("In [7] (python)")
    expect(text).toContain("print(42)")
    expect(text).toContain("42")
    expect(text).toContain("Conclusion")
    expect(text).not.toContain('"cell_type"')
    expect(addImageMock).toHaveBeenCalledWith(
      "data:image/png;base64,cG5n",
      "PNG",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    )
    expect(addImageMock).toHaveBeenCalledWith(
      "data:image/jpeg;base64,anBlZw==",
      "JPEG",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    )
    expect(textMock.mock.invocationCallOrder[0]).toBeLessThan(
      addImageMock.mock.invocationCallOrder[0]
    )
    expect(addImageMock.mock.invocationCallOrder[1]).toBeLessThan(
      textMock.mock.invocationCallOrder.at(-1)!
    )
  })

  it.each(["document", "code", "jupyter"] as const)(
    "lays %s out as selectable text instead of a picture of itself",
    async (type) => {
      await renderArtifactToPdfBlob({ id: "a", type, title: "T", content: "# hi" })
      expect(generateDocumentMock).toHaveBeenCalledWith({
        title: "T",
        markdown: "# hi",
        format: "pdf",
      })
      expect(renderPngMock).not.toHaveBeenCalled()
    }
  )

  it("falls back to a stable title when the artifact has none", async () => {
    await renderArtifactToPdfBlob({ id: "a", type: "document", title: "", content: "x" })
    expect(generateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "artifact" })
    )
  })

  it.each(["{malformed", "null", '{"cells":null}'])(
    "retains raw text fallback for invalid notebook content %s",
    async (content) => {
      await renderArtifactToPdfBlob({ id: "a", type: "jupyter", title: "T", content })
      expect(generateDocumentMock).toHaveBeenCalledWith({
        title: "T",
        markdown: content,
        format: "pdf",
      })
      expect(jsPDFMock).not.toHaveBeenCalled()
    }
  )

  it("paginates long code output without losing its final line", async () => {
    const content = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "run()",
          execution_count: 1,
          outputs: [
            { output_type: "stream", text: Array.from({ length: 100 }, (_, i) => `line ${i}\n`) },
          ],
        },
      ],
    })
    await renderArtifactToPdfBlob({ id: "a", type: "jupyter", title: "T", content })
    expect(addPageMock).toHaveBeenCalled()
    expect(textMock).toHaveBeenCalledWith("line 99", expect.any(Number), expect.any(Number))
  })

  it("fits a large notebook image onto a new page within the page margins", async () => {
    imageSize = { width: 2000, height: 4000 }
    const content = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "plot()",
          outputs: [{ output_type: "display_data", data: { "image/png": "cG5n" } }],
        },
      ],
    })
    await renderArtifactToPdfBlob({ id: "a", type: "jupyter", title: "T", content })
    expect(addPageMock).toHaveBeenCalledTimes(1)
    const [, , x, y, width, height] = addImageMock.mock.calls[0]
    expect(x).toBeGreaterThanOrEqual(36)
    expect(y).toBe(36)
    expect(x + width).toBeLessThanOrEqual(595.28 - 36)
    expect(y + height).toBeLessThanOrEqual(841.89 - 36)
    expect(width / height).toBeCloseTo(0.5)
  })

  it("propagates an unreadable notebook image instead of silently omitting it", async () => {
    imageShouldFail = true
    const content = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "plot()",
          outputs: [{ output_type: "display_data", data: { "image/png": "broken" } }],
        },
      ],
    })
    await expect(
      renderArtifactToPdfBlob({ id: "a", type: "jupyter", title: "T", content })
    ).rejects.toThrow("failed to measure the rendered image")
    expect(generateDocumentMock).not.toHaveBeenCalled()
  })

  it("produces a real PDF with selectable text and an embedded PNG", async () => {
    const { jsPDF } = jest.requireActual<typeof import("jspdf")>("jspdf")
    jsPDFMock.mockImplementationOnce((options) => new jsPDF(options))
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
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blob)
    })
    expect(pdf).toMatch(/^%PDF-/)
    expect(pdf).toContain("(Analysis)")
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
    expect(generateDocumentMock).not.toHaveBeenCalled()
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
