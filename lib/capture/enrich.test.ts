const mockFetchUrlAsRawSource = jest.fn()
const mockProxyFetch = jest.fn()
const mockExtract = jest.fn()
let mockOcrPort: { extract: (...args: unknown[]) => unknown } | null = null

jest.mock("@/lib/twin/ingest/url-fetcher", () => ({
  fetchUrlAsRawSource: (...args: unknown[]) => mockFetchUrlAsRawSource(...args),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({
  createProxyFetch: () => mockProxyFetch,
}))
jest.mock("@/lib/native/utils", () => ({ isTauri: () => true }))
jest.mock("@/lib/modules/ports", () => ({
  loadPort: async (id: string) => (id === "ocr" ? mockOcrPort : null),
}))

import { buildEnrichDeps, enrichCandidate, type EnrichDeps } from "./enrich"
import type { CaptureCandidate } from "@/types/capture"

const urlCandidate: CaptureCandidate = {
  kind: "url",
  text: "https://x.test",
  sourceUrl: "https://x.test",
  fingerprint: "fp",
}
const imageCandidate: CaptureCandidate = {
  kind: "image",
  imageDataUrl: "data:image/png;base64,AAAA",
  fingerprint: "fp2",
}

describe("enrichCandidate", () => {
  it("reads a URL into markdown", async () => {
    const deps: EnrichDeps = { readUrl: async () => ({ markdown: "# Page", title: "Page" }) }
    const e = await enrichCandidate(urlCandidate, deps)
    expect(e).toEqual({ markdown: "# Page", title: "Page", via: "url-reader" })
  })

  it("OCRs an image into text", async () => {
    const deps: EnrichDeps = { ocrImage: async () => ({ text: "scanned text" }) }
    const e = await enrichCandidate(imageCandidate, deps)
    expect(e).toEqual({ markdown: "scanned text", via: "ocr" })
  })

  it("returns undefined when the reader yields nothing", async () => {
    const deps: EnrichDeps = { readUrl: async () => ({ markdown: "   " }) }
    expect(await enrichCandidate(urlCandidate, deps)).toBeUndefined()
  })

  it("swallows enricher errors", async () => {
    const deps: EnrichDeps = {
      readUrl: async () => {
        throw new Error("net")
      },
    }
    expect(await enrichCandidate(urlCandidate, deps)).toBeUndefined()
  })

  it("returns undefined for a text candidate", async () => {
    const c: CaptureCandidate = { kind: "text", text: "note", fingerprint: "fp3" }
    expect(await enrichCandidate(c, {})).toBeUndefined()
  })
})

describe("buildEnrichDeps", () => {
  beforeEach(() => {
    mockFetchUrlAsRawSource.mockReset()
    mockFetchUrlAsRawSource.mockResolvedValue({ text: "page", title: "Page" })
    mockExtract.mockReset()
  })

  it("lets privacy-sensitive callers disable the Jina fallback", async () => {
    await buildEnrichDeps({ jinaFallback: false }).readUrl?.("https://example.com")

    expect(mockFetchUrlAsRawSource).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ fetchImpl: mockProxyFetch, jinaFallback: false })
    )
  })

  it("keeps the existing Tauri Jina default and omits an empty title", async () => {
    mockFetchUrlAsRawSource.mockResolvedValue({ text: "page", title: "" })
    await expect(buildEnrichDeps().readUrl?.("https://example.com")).resolves.toEqual({
      markdown: "page",
    })
    expect(mockFetchUrlAsRawSource).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ jinaFallback: true })
    )
  })

  it("normalizes OCR markdown, text fallback, and empty output", async () => {
    mockOcrPort = { extract: (...args: unknown[]) => mockExtract(...args) }
    const ocrImage = buildEnrichDeps().ocrImage!
    mockExtract.mockResolvedValueOnce({ combinedMarkdown: "  # Scan  ", combinedText: "ignored" })
    await expect(ocrImage("data:image/png;base64,AAAA")).resolves.toEqual({ text: "# Scan" })

    mockExtract.mockResolvedValueOnce({ combinedMarkdown: " ", combinedText: "  plain scan  " })
    await expect(ocrImage("data:;base64,AAAA")).resolves.toEqual({ text: "plain scan" })

    mockExtract.mockResolvedValueOnce({ combinedMarkdown: "", combinedText: "   " })
    await expect(ocrImage("data:image/png;base64,AAAA")).resolves.toBeNull()
    expect(mockExtract).toHaveBeenCalledTimes(3)
    expect(mockExtract).toHaveBeenLastCalledWith({
      source: { kind: "data-url", dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" },
    })
  })

  it("captures an image without text where no module provides OCR", async () => {
    mockOcrPort = null
    mockExtract.mockClear()
    await expect(buildEnrichDeps().ocrImage!("data:image/png;base64,AAAA")).resolves.toBeNull()
    expect(mockExtract).not.toHaveBeenCalled()
  })
})
