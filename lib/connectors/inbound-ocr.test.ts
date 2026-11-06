const extractMock = jest.fn()
const loadSettingsMock = jest.fn()
const appendAuditMock = jest.fn()
const mockOcr = {
  extract: (...a: unknown[]) => extractMock(...a),
  loadSettings: () => loadSettingsMock(),
  deps: (options: unknown) => ({ built: options }),
}
let mockOcrPort: typeof mockOcr | null = mockOcr
jest.mock("@/lib/modules/ports", () => ({
  loadPort: async (id: string) => (id === "ocr" ? mockOcrPort : null),
}))
jest.mock("./audit", () => ({
  __esModule: true,
  appendAudit: (...a: unknown[]) => appendAuditMock(...a),
}))

import {
  hasOcrableInboundImage,
  maybeOcrInboundSegments,
  runInboundOcr,
  type InboundOcrDeps,
} from "./inbound-ocr"
import type { MessageSegment } from "@/types/connectors/segment"
import { DEFAULT_OCR_SETTINGS, type OcrResult } from "@/types/ocr"

function ocrResult(text: string): OcrResult {
  return {
    providerId: "tesseract-wasm",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: text,
    combinedText: text,
    languages: ["en"],
    durationMs: 1,
    cached: false,
  }
}

function imageSeg(extra: Record<string, unknown> = {}): MessageSegment {
  return { type: "image", url: "img://1", ...extra } as MessageSegment
}

function deps(over: Partial<InboundOcrDeps> = {}): InboundOcrDeps {
  return {
    enabled: true,
    extract: jest.fn(async () => ocrResult("HELLO")),
    ocrDeps: {} as InboundOcrDeps["ocrDeps"],
    ...over,
  }
}

describe("maybeOcrInboundSegments", () => {
  it("no-ops when disabled", async () => {
    const extract = jest.fn(async () => ocrResult("X"))
    const segs = [imageSeg({ dataBase64: "AAAA" })]
    await maybeOcrInboundSegments(segs, deps({ enabled: false, extract }))
    expect(extract).not.toHaveBeenCalled()
    expect((segs[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("OCRs an image with inline bytes and attaches ocrText", async () => {
    const extract = jest.fn(async () => ocrResult("INVOICE 42"))
    const segs = [imageSeg({ dataBase64: "AAAA", mimeType: "image/jpeg" })]
    await maybeOcrInboundSegments(segs, deps({ extract }))
    expect((segs[0] as { ocrText?: string }).ocrText).toBe("INVOICE 42")
    expect(extract).toHaveBeenCalledWith(
      {
        source: {
          kind: "data-url",
          dataUrl: "data:image/jpeg;base64,AAAA",
          mimeType: "image/jpeg",
        },
      },
      expect.anything()
    )
  })

  it("skips images that carry no inline bytes", async () => {
    const extract = jest.fn(async () => ocrResult("X"))
    const segs = [imageSeg()]
    await maybeOcrInboundSegments(segs, deps({ extract }))
    expect(extract).not.toHaveBeenCalled()
    expect((segs[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("does not re-OCR a segment that already has ocrText", async () => {
    const extract = jest.fn(async () => ocrResult("X"))
    const segs = [imageSeg({ dataBase64: "AAAA", ocrText: "kept" })]
    await maybeOcrInboundSegments(segs, deps({ extract }))
    expect(extract).not.toHaveBeenCalled()
    expect((segs[0] as { ocrText?: string }).ocrText).toBe("kept")
  })

  it("leaves the segment untouched when extraction throws (non-fatal)", async () => {
    const extract = jest.fn(async () => {
      throw new Error("provider down")
    })
    const segs = [imageSeg({ dataBase64: "AAAA" })]
    await expect(maybeOcrInboundSegments(segs, deps({ extract }))).resolves.toBeUndefined()
    expect((segs[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("fires the onError sink when extraction throws", async () => {
    const extract = jest.fn(async () => {
      throw new Error("provider down")
    })
    const onError = jest.fn()
    const segs = [imageSeg({ dataBase64: "AAAA" })]
    await maybeOcrInboundSegments(segs, deps({ extract, onError }))
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as { error: unknown }).error).toBeInstanceOf(Error)
  })

  it("ignores blank OCR output and non-image segments", async () => {
    const extract = jest.fn(async () => ocrResult("   "))
    const segs: MessageSegment[] = [{ type: "text", text: "hi" }, imageSeg({ dataBase64: "AAAA" })]
    await maybeOcrInboundSegments(segs, deps({ extract }))
    expect((segs[1] as { ocrText?: string }).ocrText).toBeUndefined()
    expect(extract).toHaveBeenCalledTimes(1)
  })
})

describe("runInboundOcr (production wrapper)", () => {
  beforeEach(() => {
    extractMock.mockReset().mockResolvedValue(ocrResult("FROM SETTINGS"))
    loadSettingsMock.mockReset()
    mockOcrPort = mockOcr
  })

  it("runs OCR when settings enable inbound images", async () => {
    const settings = { ...DEFAULT_OCR_SETTINGS, ocrInboundImages: true }
    loadSettingsMock.mockResolvedValue(settings)
    const event = { segments: [imageSeg({ dataBase64: "AAAA" })] }
    await runInboundOcr(event)
    expect((event.segments[0] as { ocrText?: string }).ocrText).toBe("FROM SETTINGS")
    expect(extractMock.mock.calls[0][1]).toEqual({ built: { settings } })
  })

  it("skips OCR when inbound images are disabled in settings", async () => {
    loadSettingsMock.mockResolvedValue({ ...DEFAULT_OCR_SETTINGS, ocrInboundImages: false })
    const event = { segments: [imageSeg({ dataBase64: "AAAA" })] }
    await runInboundOcr(event)
    expect(extractMock).not.toHaveBeenCalled()
  })

  it("runs OCR at the default settings (inbound images on)", async () => {
    loadSettingsMock.mockResolvedValue(DEFAULT_OCR_SETTINGS)
    const event = { segments: [imageSeg({ dataBase64: "AAAA" })] }
    await runInboundOcr(event)
    expect(extractMock).toHaveBeenCalledTimes(1)
  })

  it("leaves the images alone where no module provides OCR", async () => {
    mockOcrPort = null
    const event = { segments: [imageSeg({ dataBase64: "AAAA" })] }
    await runInboundOcr(event)
    expect(extractMock).not.toHaveBeenCalled()
    expect((event.segments[0] as { ocrText?: string }).ocrText).toBeUndefined()
  })

  it("audits inbound.ocr_failed when extraction throws and adapterId is present", async () => {
    loadSettingsMock.mockResolvedValue({ ...DEFAULT_OCR_SETTINGS, ocrInboundImages: true })
    extractMock.mockReset().mockRejectedValue(new Error("provider down"))
    appendAuditMock.mockClear()
    const event = {
      segments: [imageSeg({ dataBase64: "AAAA" })],
      adapterId: "tg",
      conversationKey: "telegram:tg:1",
    }
    await runInboundOcr(event)
    expect(appendAuditMock).toHaveBeenCalledTimes(1)
    const entry = appendAuditMock.mock.calls[0][0] as { kind: string; adapterId: string }
    expect(entry.kind).toBe("inbound.ocr_failed")
    expect(entry.adapterId).toBe("tg")
  })

  it("does not audit when no adapterId is present (legacy narrow event)", async () => {
    loadSettingsMock.mockResolvedValue({ ...DEFAULT_OCR_SETTINGS, ocrInboundImages: true })
    extractMock.mockReset().mockRejectedValue(new Error("provider down"))
    appendAuditMock.mockClear()
    await runInboundOcr({ segments: [imageSeg({ dataBase64: "AAAA" })] })
    expect(appendAuditMock).not.toHaveBeenCalled()
  })
})

describe("hasOcrableInboundImage", () => {
  it("is true only when an image segment carries non-empty inline bytes", () => {
    expect(hasOcrableInboundImage([{ type: "text", text: "hi" } as MessageSegment])).toBe(false)
    // Image arriving as a bare URL — no inline bytes, nothing to OCR.
    expect(hasOcrableInboundImage([imageSeg()])).toBe(false)
    expect(hasOcrableInboundImage([imageSeg({ dataBase64: "" })])).toBe(false)
    expect(hasOcrableInboundImage([imageSeg({ dataBase64: "AAAA" })])).toBe(true)
    expect(
      hasOcrableInboundImage([
        { type: "text", text: "hi" } as MessageSegment,
        imageSeg({ dataBase64: "AAAA" }),
      ])
    ).toBe(true)
  })
})
describe("a picture sent as a document", () => {
  it("is OCR'd like any other image", async () => {
    // Telegram's "send as file" path. It reaches the model as
    // `[file: <name>]`, so without OCR the model is told a file arrived and
    // nothing about what is in it.
    const segments: MessageSegment[] = [
      {
        type: "file",
        url: "https://x/shot",
        name: "screenshot.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 10,
        dataBase64: "QUJD",
      },
    ]
    expect(hasOcrableInboundImage(segments)).toBe(true)

    const extract = jest.fn().mockResolvedValue({ combinedText: " invoice total 42 " })
    await maybeOcrInboundSegments(segments, {
      enabled: true,
      extract,
      ocrDeps: {} as never,
    })

    expect(extract).toHaveBeenCalledWith(
      {
        source: {
          kind: "data-url",
          dataUrl: "data:image/jpeg;base64,QUJD",
          mimeType: "image/jpeg",
        },
      },
      {}
    )
    expect((segments[0] as { ocrText?: string }).ocrText).toBe("invoice total 42")
  })

  it("leaves a non-image file alone", async () => {
    const segments: MessageSegment[] = [
      {
        type: "file",
        url: "https://x/doc",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        dataBase64: "QUJD",
      },
    ]
    expect(hasOcrableInboundImage(segments)).toBe(false)

    const extract = jest.fn()
    await maybeOcrInboundSegments(segments, { enabled: true, extract, ocrDeps: {} as never })
    expect(extract).not.toHaveBeenCalled()
  })
})
