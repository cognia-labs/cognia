import { DEFAULT_OCR_SETTINGS, type UserOcrSettings } from "@/types/ocr"

const builtDeps = (settings: UserOcrSettings = DEFAULT_OCR_SETTINGS) => ({
  registry: { marker: "registry" },
  settings,
  platform: "tauri",
  osTag: "macos",
})
jest.mock("./deps", () => ({
  buildOcrDeps: jest.fn((options: { settings?: UserOcrSettings } = {}) =>
    builtDeps(options.settings)
  ),
}))
jest.mock("./index", () => ({ extract: jest.fn(async () => ({ providerId: "p" })) }))
jest.mock("./pdf-loader", () => ({ createPdfLoader: jest.fn(() => "loader") }))
jest.mock("./pdf-router", () => ({ extractPdf: jest.fn() }))
jest.mock("./registry", () => ({
  getSharedOcrRegistry: () => ({ list: () => [{ id: "tesseract-wasm" }] }),
}))
jest.mock("./user-settings", () => ({ loadUserOcrSettings: jest.fn() }))
jest.mock("./auto-router", () => ({ listProviderCandidates: jest.fn(async () => []) }))

import type { ExtractDeps } from "@cognia/ocr"
import { listProviderCandidates } from "./auto-router"
import { buildOcrDeps } from "./deps"
import { extract } from "./index"
import { extractPdf } from "./pdf-router"
import { port } from "./port"
import { loadUserOcrSettings } from "./user-settings"

const custom: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "mistral-ocr" }

beforeEach(() => jest.clearAllMocks())

describe("ocr port", () => {
  it("reads the person's settings, or the defaults where none are stored", async () => {
    jest.mocked(loadUserOcrSettings).mockResolvedValueOnce(custom)
    await expect(port.loadSettings()).resolves.toBe(custom)
    jest.mocked(loadUserOcrSettings).mockResolvedValueOnce(undefined)
    await expect(port.loadSettings()).resolves.toBe(DEFAULT_OCR_SETTINGS)
  })

  it("builds the host's deps from what the caller adds", () => {
    const filePathResolver = jest.fn()
    port.deps({ settings: custom, filePathResolver })
    expect(buildOcrDeps).toHaveBeenCalledWith({ settings: custom, filePathResolver })
  })

  it("extracts through the metered entry, with the default deps when none are given", async () => {
    const input = {
      source: { kind: "data-url" as const, dataUrl: "data:,", mimeType: "image/png" },
    }
    await port.extract(input)
    expect(extract).toHaveBeenCalledWith(input, builtDeps())
    const given = builtDeps(custom) as unknown as ExtractDeps
    await port.extract(input, given)
    expect(extract).toHaveBeenLastCalledWith(input, given)
  })

  it("gives the PDF router the pdf.js loader over the host's deps", () => {
    expect(port.pdfDeps({ settings: custom })).toEqual({
      loadPdf: "loader",
      extractDeps: builtDeps(custom),
      settings: custom,
    })
    expect(port.pdfDeps().settings).toBe(DEFAULT_OCR_SETTINGS)
    expect(port.extractPdf).toBe(extractPdf)
  })

  it("lists candidates, keeping cloud fallback out when asked", async () => {
    const deps = builtDeps({ ...DEFAULT_OCR_SETTINGS, cloudFallbackEnabled: true }) as never
    await port.candidates(deps)
    expect(jest.mocked(listProviderCandidates).mock.calls[0][0].settings.cloudFallbackEnabled).toBe(
      true
    )
    await port.candidates(deps, { cloudFallback: false })
    expect(jest.mocked(listProviderCandidates).mock.calls[1][0].settings.cloudFallbackEnabled).toBe(
      false
    )
  })

  it("lists every registered provider", () => {
    expect(port.providers()).toEqual([{ id: "tesseract-wasm" }])
  })
})
