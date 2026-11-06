// The `ocr` capability port (ADR-0024, ADR-0250 §14 M3): reading text out of
// an image or a PDF. The kernel declares it here; the OCR module
// (`lib/ocr/module.ts`) provides it. Users ask `lib/modules/ports.ts` for
// `"ocr"` and never import `lib/ocr/`.
//
// The pure engine stays the `@cognia/ocr` package: its types, `OcrError`, the
// confidence helpers and the provider registry a plugin registers into are
// shared by both ends. What the port adds is the host's assembly around it:
// the built-in providers and native engines, the person's settings, keyring
// credentials, the result caches and usage metering.

import type { AttachmentResolver, ExtractDeps, FilePathResolver } from "@cognia/ocr"
import type { PdfRouterDeps, PdfRouterInput } from "@cognia/ocr/pdf-router"
import type { OcrInput, OcrProvider, OcrResult, UserOcrSettings } from "@/types/ocr"

/** What a caller may add to the host's extraction deps. */
export interface OcrDepsOptions {
  /** The person's settings, from `loadSettings()`; absent means the defaults. */
  settings?: UserOcrSettings
  /** Resolves `attachment-id` sources. */
  attachmentResolver?: AttachmentResolver
  /** Resolves `file-path` sources. */
  filePathResolver?: FilePathResolver
  /** Sees every result. */
  onResult?: (result: OcrResult) => void
}

export interface OcrPort {
  /** The person's OCR settings, with the defaults where nothing is set. */
  loadSettings(): Promise<UserOcrSettings>
  /**
   * The host's extraction deps: the shared registry, the settings, the
   * platform, keyring credentials, runtime readiness and the result caches.
   */
  deps(options?: OcrDepsOptions): ExtractDeps
  /**
   * Read one image or document, and meter what the provider billed. Without
   * `deps` it uses `deps()`, that is the default settings.
   */
  extract(input: OcrInput, deps?: ExtractDeps): Promise<OcrResult>
  /** The PDF router's deps: the pdf.js loader over `deps({ settings })`. */
  pdfDeps(options?: { settings?: UserOcrSettings }): PdfRouterDeps
  /** A PDF page by page, OCR only for the pages without a text layer. */
  extractPdf(input: PdfRouterInput, deps: PdfRouterDeps): Promise<OcrResult>
  /**
   * The providers the auto-router would try for `deps`, best first, each
   * usable on this shell and ready. `cloudFallback: false` keeps the person's
   * cloud fallback out of the list whatever the settings say.
   */
  candidates(deps: ExtractDeps, options?: { cloudFallback?: boolean }): Promise<OcrProvider[]>
  /** Every registered provider, built-in and plugin-contributed. */
  providers(): readonly OcrProvider[]
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    ocr: OcrPort
  }
}
