/**
 * OCR fallback for the twin ingest parse stage (ADR-0024).
 *
 * `lib/document/parsers/pdf-parser.ts` extracts only a PDF's text layer, so a
 * scanned / image-only PDF yields (near-)empty text and silently produces no
 * embeddings. When the parsed text is below a small threshold we re-run the
 * document through the `ocr` port's `extractPdf` (the PDF router), whose own per-page
 * text-layer fast-path keeps digital PDFs free and only OCRs the empty pages.
 *
 * The OCR'd text then flows through the unchanged redact → chunk → embed →
 * persist chain (the existing PII redaction gate applies automatically).
 * Each page records where its text came from (`DocumentPageStatus`) and,
 * when the provider reports block confidences, their mean; a page OCR cannot
 * read keeps its text-layer text and reads `ocr-failed`, and tables the
 * provider recognised are kept as typed grids located by page (G2).
 * Best-effort: a document the router cannot read at all keeps the text
 * layer, except on cancellation, which stops the job with the signal's reason.
 */

import type { PdfRouterDeps, PdfRouterInput } from "@cognia/ocr/pdf-router"
import { loadPort } from "@/lib/modules/ports"
import type { OcrBlock, OcrResult } from "@/types/ocr"
import { buildDocumentStructure } from "@cognia/document/document-structure"
import { extractDocumentTables } from "@cognia/document/table-extractor"
import type {
  DocumentPageRange,
  DocumentPageStatus,
  DocumentTable,
  PDFOutlineItem,
} from "@cognia/document/types"
import type { ParsedSource, RawSource } from "./parse"

/** Below this many non-whitespace chars a PDF is treated as scanned → OCR. */
export const TWIN_OCR_MIN_TEXT_CHARS = 32

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, "").length
}

export interface TwinOcrFallbackDeps {
  extractPdf: (input: PdfRouterInput, deps: PdfRouterDeps) => Promise<OcrResult>
  /** Build the per-document router deps (loader + extract deps). */
  buildPdfRouterDeps: () => PdfRouterDeps
  /** Override the low-text threshold (tests). */
  minTextChars?: number
}

/** How the OCR fallback may be stopped. */
export interface TwinOcrFallbackOptions {
  /**
   * Stops the OCR: the router checks it between pages and cancels the PDF
   * load and page rendering. An abort is thrown as the signal's reason, not
   * read as "OCR failed, keep the text layer".
   */
  signal?: AbortSignal
}

/**
 * Returns OCR'd text to use in place of the parsed text, or null to keep the
 * text layer. Only fires for low-text PDF binaries. Pure w.r.t. injected deps.
 */
export async function maybeTwinPdfOcrWithProvenance(
  raw: RawSource,
  parsed: ParsedSource,
  deps: TwinOcrFallbackDeps,
  options: TwinOcrFallbackOptions = {}
): Promise<Pick<ParsedSource, "originalText" | "embeddableText" | "pageMap" | "structure"> | null> {
  const { signal } = options
  signal?.throwIfAborted()
  if (raw.format !== "pdf" || !raw.binary) return null
  const threshold = deps.minTextChars ?? TWIN_OCR_MIN_TEXT_CHARS
  const sparsePage = parsed.structure?.pages.some(
    (page) => nonWhitespaceLength(parsed.originalText.slice(page.charStart, page.charEnd)) < 16
  )
  if (!sparsePage && nonWhitespaceLength(parsed.originalText) >= threshold) return null
  const bytes = raw.binary instanceof Uint8Array ? raw.binary : new Uint8Array(raw.binary)
  // A page OCR cannot read is recorded and skipped: the pages around it are
  // kept, rather than one bad page discarding the whole run.
  const failedPages = new Set<number>()
  let result: OcrResult
  try {
    result = await deps.extractPdf(
      { bytes },
      {
        ...deps.buildPdfRouterDeps(),
        ...(signal ? { signal } : {}),
        continueOnPageError: true,
        onPageError: (_error, pageNumber) => {
          failedPages.add(pageNumber)
        },
      }
    )
  } catch {
    // The document as a whole could not be read: keep the text layer.
    signal?.throwIfAborted()
    return null
  }

  const textLayerPage = (pageNumber: number) =>
    parsed.structure?.pages.find((page) => page.pageNumber === pageNumber)
  const textLayerText = (pageNumber: number) => {
    const range = textLayerPage(pageNumber)
    return range ? parsed.originalText.slice(range.charStart, range.charEnd) : ""
  }
  const ocrPages = new Map(result.pages.map((page) => [page.pageNumber, page]))
  const pageNumbers = [...new Set([...ocrPages.keys(), ...failedPages])].sort((a, b) => a - b)
  if (pageNumbers.length === 0) return null

  const read = pageNumbers.map((pageNumber): ReadPage => {
    const page = ocrPages.get(pageNumber)
    if (!page) return { pageNumber, text: textLayerText(pageNumber), status: "ocr-failed" }
    if (page.fromTextLayer) return { pageNumber, text: page.text, status: "text" }
    if (!page.text.trim()) {
      // OCR found nothing: what little the text layer had is still the page's.
      const fallback = textLayerText(pageNumber)
      return { pageNumber, text: fallback, status: fallback.trim() ? "text" : "blank" }
    }
    const confidence = meanConfidence(page.blocks)
    return {
      pageNumber,
      text: page.text,
      status: "ocr",
      markdown: page.markdown,
      ...(confidence !== undefined ? { confidence } : {}),
    }
  })
  const text = read.map((page) => page.text).join("\n\n")

  let cursor = 0
  const pages: DocumentPageRange[] = read.map((page) => {
    const charStart = cursor
    const charEnd = cursor + page.text.length
    cursor = charEnd + 2
    // Native boxes hold for text the text layer gave, not for OCR'd text.
    const bboxUnion =
      page.status === "ocr" || page.status === "blank"
        ? undefined
        : parsed.pageMap?.find((entry) => entry.pageNumber === page.pageNumber)?.bboxUnion
    return {
      pageNumber: page.pageNumber,
      charStart,
      charEnd,
      lineStart: text.slice(0, charStart).split("\n").length,
      lineEnd: text.slice(0, Math.max(charStart, charEnd - 1)).split("\n").length,
      status: page.status,
      ...(page.confidence !== undefined ? { confidence: page.confidence } : {}),
      ...(bboxUnion ? { bboxUnion } : {}),
    }
  })

  // Tables the provider recognised on its pages (Azure writes HTML tables,
  // others pipe tables), located by page.
  const tables: DocumentTable[] = read
    .flatMap((page) =>
      page.markdown
        ? extractDocumentTables(page.markdown).map((table) => ({
            ...table,
            locator: { type: "page" as const, page: page.pageNumber },
          }))
        : []
    )
    .map((table, index) => ({ ...table, index: index + 1 }))

  // Preserve bookmarks by mapping their source page into the new canonical text.
  const outlineNodes = parsed.structure?.nodes ?? []
  const outlineChildren = (parentId: string): PDFOutlineItem[] =>
    outlineNodes
      .filter((node) => node.parentId === parentId)
      .map((node) => ({
        title: node.title,
        pageNumber: node.pageStart,
        children: outlineChildren(node.id),
      }))
  const outline = outlineChildren("root")
  // The parse is now the reader's plus OCR: a new identity, so a kept parse
  // can tell which provider read it.
  const parse = parsed.structure?.parse
  const structure = buildDocumentStructure({
    content: text,
    title: parsed.title,
    pages,
    ...(parse
      ? {
          parse: {
            ...parse,
            strategy: "ocr" as const,
            ocrProvider: result.providerId,
            languages: [...result.languages],
            completedAt: Date.now(),
          },
        }
      : {}),
    ...(outline.length
      ? { pdf: { text, pages: [], pageCount: pages.length, metadata: {}, outline } }
      : {}),
    ...(tables.length > 0 ? { tables } : {}),
  })
  return {
    originalText: text,
    embeddableText: text,
    pageMap: pages.map(({ pageNumber, charStart, charEnd, bboxUnion }) => ({
      pageNumber,
      charStart,
      charEnd,
      ...(bboxUnion ? { bboxUnion } : {}),
    })),
    structure,
  }
}

/** One page as the fallback read it. */
interface ReadPage {
  pageNumber: number
  text: string
  status: DocumentPageStatus
  /** The provider's Markdown, for an OCR'd page: where its tables are. */
  markdown?: string
  confidence?: number
}

/** The mean of the blocks' confidences, or undefined when none reports one. */
function meanConfidence(blocks: readonly OcrBlock[] | undefined): number | undefined {
  const values = (blocks ?? [])
    .map((block) => block.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Production wrapper: load OCR settings, build the real router deps (pdfjs
 * loader + keyring-backed extract deps), and run the PDF OCR fallback, all
 * through the `ocr` port (ADR-0250 §14). A host without OCR keeps the text
 * layer.
 */
export async function runTwinPdfOcrWithProvenance(
  raw: RawSource,
  parsed: ParsedSource,
  options: TwinOcrFallbackOptions = {}
): ReturnType<typeof maybeTwinPdfOcrWithProvenance> {
  const ocr = await loadPort("ocr")
  if (!ocr) return null
  // Dexie unavailable reads as the defaults.
  const settings = await ocr.loadSettings()
  return maybeTwinPdfOcrWithProvenance(
    raw,
    parsed,
    {
      extractPdf: ocr.extractPdf,
      buildPdfRouterDeps: () => ocr.pdfDeps({ settings }),
    },
    options
  )
}
