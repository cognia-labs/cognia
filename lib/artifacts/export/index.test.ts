/** @jest-environment jsdom */
const saveExportMock = jest.fn()
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (opts: unknown) => saveExportMock(opts),
}))

const renderPngMock = jest.fn()
jest.mock("./raster", () => ({
  renderArtifactToPngBlob: (...a: unknown[]) => renderPngMock(...a),
  ArtifactNotRasterisableError: class extends Error {},
  ArtifactPreviewNotMountedError: class extends Error {},
  ArtifactTooLargeToRasteriseError: class extends Error {},
}))

const renderPdfMock = jest.fn()
jest.mock("./pdf", () => ({
  renderArtifactToPdfBlob: (...a: unknown[]) => renderPdfMock(...a),
}))

const generateDocxMock = jest.fn()
jest.mock("@/lib/files/document-writer", () => ({
  generateDocx: (opts: unknown) => generateDocxMock(opts),
}))

import {
  ArtifactNotebookUnreadableError,
  PdfFontUnavailableError,
  PdfUnsupportedCharactersError,
  UnsupportedArtifactExportError,
  artifactExportFilename,
  describeArtifactExportFailure,
  exportArtifact,
  exportArtifactAsWord,
  renderArtifactExport,
  renderArtifactWordExport,
} from "./index"
import type { Artifact } from "@/types"

const artifact = (over: Partial<Artifact> = {}) =>
  ({
    id: "a1",
    type: "chart",
    title: "Q4 revenue",
    content: '{"type":"bar"}',
    ...over,
  }) as Artifact

beforeEach(() => {
  saveExportMock.mockReset().mockResolvedValue({ kind: "saved", location: "/tmp/x" })
  renderPngMock.mockReset().mockResolvedValue(new Blob(["png"], { type: "image/png" }))
  renderPdfMock.mockReset().mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }))
  generateDocxMock.mockReset().mockResolvedValue({
    data: new Blob(["docx"]),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: "ignored.docx",
  })
})

describe("artifactExportFilename", () => {
  it("uses the artifact's own extension for raw", () => {
    expect(artifactExportFilename(artifact({ type: "mermaid" }), "raw")).toBe("Q4 revenue.mmd")
  })

  it("uses the format as the extension for a rendered export", () => {
    // The old chat-side download used `.${artifact.type}`, so a chart came out
    // as `chart.chart`.
    expect(artifactExportFilename(artifact(), "png")).toBe("Q4 revenue.png")
    expect(artifactExportFilename(artifact(), "pdf")).toBe("Q4 revenue.pdf")
  })

  it("strips characters a filename cannot carry", () => {
    expect(artifactExportFilename(artifact({ title: 'a/b:c*d?"e<f>g|h' }), "png")).toBe(
      "a b c d e f g h.png"
    )
  })

  it("falls back to a usable name when the title is empty or only separators", () => {
    expect(artifactExportFilename(artifact({ title: "" }), "png")).toBe("artifact.png")
    expect(artifactExportFilename(artifact({ title: "///" }), "png")).toBe("artifact.png")
  })
})

describe("renderArtifactExport", () => {
  it("returns the source text for raw, without loading a renderer", async () => {
    const out = await renderArtifactExport(
      artifact({ type: "code", language: "typescript" }),
      "raw"
    )
    expect(out.data).toBe('{"type":"bar"}')
    expect(out.mimeType).toBe("text/plain;charset=utf-8")
    expect(renderPngMock).not.toHaveBeenCalled()
    expect(renderPdfMock).not.toHaveBeenCalled()
  })

  it("routes png through the raster renderer", async () => {
    const out = await renderArtifactExport(artifact(), "png")
    expect(renderPngMock).toHaveBeenCalled()
    expect(out.mimeType).toBe("image/png")
  })

  it("routes pdf through the pdf renderer", async () => {
    const out = await renderArtifactExport(artifact(), "pdf")
    expect(renderPdfMock).toHaveBeenCalled()
    expect(out.mimeType).toBe("application/pdf")
  })

  it("refuses a format the artifact's adapter does not offer", async () => {
    // `jupyter` has no raster path at all, so png is genuinely unavailable
    // there. (`react` used to sit here, and now offers png by capturing its
    // live frame instead of re-rendering unexecuted JSX.)
    await expect(renderArtifactExport(artifact({ type: "jupyter" }), "png")).rejects.toBeInstanceOf(
      UnsupportedArtifactExportError
    )
    expect(renderPngMock).not.toHaveBeenCalled()
  })

  it("honours a metadata narrowing of the adapter's formats", async () => {
    await expect(
      renderArtifactExport(artifact({ metadata: { exportFormats: ["raw"] } }), "png")
    ).rejects.toBeInstanceOf(UnsupportedArtifactExportError)
  })
})

describe("exportArtifact", () => {
  it("hands the rendered bytes to the cross-platform saver", async () => {
    const outcome = await exportArtifact(artifact(), "png")
    expect(saveExportMock).toHaveBeenCalledWith({
      filename: "Q4 revenue.png",
      data: expect.any(Blob),
      mimeType: "image/png",
    })
    expect(outcome).toEqual({ kind: "saved", location: "/tmp/x" })
  })

  it("propagates a cancelled save rather than reporting success", async () => {
    saveExportMock.mockResolvedValue({ kind: "cancelled" })
    await expect(exportArtifact(artifact(), "raw")).resolves.toEqual({ kind: "cancelled" })
  })

  it("does not reach the saver when rendering fails", async () => {
    renderPngMock.mockRejectedValue(new Error("no preview"))
    await expect(exportArtifact(artifact(), "png")).rejects.toThrow("no preview")
    expect(saveExportMock).not.toHaveBeenCalled()
  })
})

describe("Word export (A07)", () => {
  it("refuses a chart, whose Word file used to be its JSON", async () => {
    await expect(renderArtifactWordExport(artifact())).rejects.toBeInstanceOf(
      UnsupportedArtifactExportError
    )
    expect(generateDocxMock).not.toHaveBeenCalled()
  })

  it("writes code as one verbatim block and saves it under the artifact's title", async () => {
    const code = artifact({ type: "code", title: "main/py", content: "# c\n    x = 1" })
    await expect(exportArtifactAsWord(code)).resolves.toEqual({
      kind: "saved",
      location: "/tmp/x",
    })
    expect(generateDocxMock).toHaveBeenCalledWith({
      title: "main/py",
      blocks: [{ kind: "code", text: "# c\n    x = 1" }],
    })
    expect(saveExportMock).toHaveBeenCalledWith({
      filename: "main py.docx",
      data: expect.any(Blob),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
  })

  it("writes a document from its Markdown", async () => {
    await renderArtifactWordExport(artifact({ type: "document", content: "# T\n\nBody" }))
    expect(generateDocxMock).toHaveBeenCalledWith({
      title: "Q4 revenue",
      blocks: [
        { kind: "heading", level: 1, text: "T" },
        { kind: "paragraph", text: "Body" },
      ],
    })
  })
})

describe("describeArtifactExportFailure", () => {
  it("names the characters a text PDF cannot draw (C09)", () => {
    expect(
      describeArtifactExportFailure(new PdfUnsupportedCharactersError(["中", "文"]), {
        neededPreview: false,
      })
    ).toEqual({ reason: "unsupported-characters", characters: "中 文" })
  })

  it("reports a bundled PDF font that could not be read (C09)", () => {
    expect(
      describeArtifactExportFailure(new PdfFontUnavailableError(new Error("HTTP 404")), {
        neededPreview: false,
      })
    ).toEqual({ reason: "pdf-font-unavailable" })
  })

  it("reports an unreadable notebook (C09)", () => {
    expect(
      describeArtifactExportFailure(new ArtifactNotebookUnreadableError("nb"), {
        neededPreview: false,
      })
    ).toEqual({ reason: "notebook-unreadable" })
  })

  it("points at the preview only when the export rendered one", () => {
    const error = new Error("boom")
    expect(describeArtifactExportFailure(error, { neededPreview: true })).toEqual({
      reason: "preview",
    })
    expect(describeArtifactExportFailure(error, { neededPreview: false })).toEqual({
      reason: "failed",
    })
  })
})
