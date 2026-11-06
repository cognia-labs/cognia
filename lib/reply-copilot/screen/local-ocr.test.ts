let mockOcrPort: Record<string, jest.Mock> | null = null
jest.mock("@/lib/modules/ports", () => ({
  loadPort: async (id: string) => (id === "ocr" ? mockOcrPort : null),
}))

import type { ExtractDeps } from "@cognia/ocr"
import type { Screenshot } from "@/lib/automation/types"
import type { OcrInput, OcrProvider, OcrResult } from "@/types/ocr"
import { LocalOcrUnavailableError, readWindowText, type LocalOcrDeps } from "./local-ocr"

const shot: Screenshot = {
  bytes: "AAAA",
  width: 400,
  height: 300,
  capturedAt: 0,
  format: "png",
  sourceWidth: 800,
  sourceHeight: 600,
}

function provider(id: string, category: OcrProvider["category"]): OcrProvider {
  return { id, label: id, category, shells: {}, credentialKeys: [], extract: jest.fn() } as never
}

const result: OcrResult = {
  providerId: "apple-vision",
  pages: [
    {
      pageNumber: 1,
      markdown: "",
      text: "",
      width: 400,
      height: 300,
      blocks: [
        { text: "在吗", bbox: { x: 10, y: 20, width: 50, height: 10 } },
        { text: "no geometry" },
      ],
    },
  ],
  combinedMarkdown: "",
  combinedText: "",
  languages: [],
  durationMs: 1,
  cached: false,
}

function deps(candidates: OcrProvider[]) {
  const extract = jest.fn(async (_input: OcrInput, _deps: ExtractDeps) => result)
  const d: LocalOcrDeps = {
    ocrDeps: async () => ({}) as ExtractDeps,
    candidates: async () => candidates,
    extract,
  }
  return { d, extract }
}

describe("readWindowText", () => {
  it("uses the first local engine explicitly, uncached, and maps lines to frame pixels", async () => {
    const { d, extract } = deps([
      provider("google-vision", "document-cloud"),
      provider("apple-vision", "local"),
    ])
    const text = await readWindowText(shot, undefined, d)
    const [input] = extract.mock.calls[0]
    expect(input.providerId).toBe("apple-vision")
    expect(input.useCache).toBe(false)
    expect(input.source).toEqual({
      kind: "data-url",
      dataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
    })
    // The capture was downscaled 2x; lines come back in source pixels.
    expect(text).toEqual({
      providerId: "apple-vision",
      lines: [{ text: "在吗", bbox: { x: 20, y: 40, width: 100, height: 20 } }],
    })
  })

  it("refuses to fall back to a cloud engine", async () => {
    const { d, extract } = deps([provider("google-vision", "document-cloud")])
    await expect(readWindowText(shot, undefined, d)).rejects.toBeInstanceOf(
      LocalOcrUnavailableError
    )
    expect(extract).not.toHaveBeenCalled()
  })

  it("stops before OCR when aborted", async () => {
    const { d, extract } = deps([provider("apple-vision", "local")])
    const controller = new AbortController()
    controller.abort()
    await expect(readWindowText(shot, controller.signal, d)).rejects.toThrow()
    expect(extract).not.toHaveBeenCalled()
  })
})

describe("readWindowText through the ocr port", () => {
  it("reads the person's settings and lists candidates with cloud fallback off", async () => {
    const settings = { defaultProviderId: "auto" }
    const hostDeps = { marker: "host" }
    mockOcrPort = {
      loadSettings: jest.fn(async () => settings),
      deps: jest.fn(() => hostDeps),
      candidates: jest.fn(async () => [provider("paddle-ocr", "local")]),
      extract: jest.fn(async () => result),
    }
    const text = await readWindowText(shot)
    expect(mockOcrPort.deps).toHaveBeenCalledWith({ settings })
    expect(mockOcrPort.candidates).toHaveBeenCalledWith(hostDeps, { cloudFallback: false })
    expect(mockOcrPort.extract).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "paddle-ocr", useCache: false }),
      hostDeps
    )
    expect(text.providerId).toBe("apple-vision")
  })

  it("has no local engine where no module provides OCR", async () => {
    mockOcrPort = null
    await expect(readWindowText(shot)).rejects.toBeInstanceOf(LocalOcrUnavailableError)
  })
})
