/**
 * Document Processor - Unified document processing for various file types
 * Enhanced with file validation, encoding detection, CJK token estimation, document comparison
 */

import {
  parseMarkdown,
  extractEmbeddableContent as extractMarkdownContent,
} from "./parsers/markdown-parser"
import { parseCode, extractCodeEmbeddableContent, detectLanguage } from "./parsers/code-parser"
import { chunkDocument, type ChunkingOptions } from "@cognia/provider-embedding/chunking"
import { detectDocumentTypeFromFilename, getFilenameExtension } from "./support-matrix"
import {
  normalizeMarkdownSummary,
  normalizeCodeSummary,
  normalizeJSONSummary,
  normalizeTextSummary,
  normalizePDFSummary,
  normalizeWordSummary,
  normalizeExcelSummary,
  normalizePresentationSummary,
  normalizeRTFSummary,
  normalizeEPUBSummary,
  normalizeCSVSummary,
  normalizeHTMLSummary,
} from "./parse-summary"
import { buildDocumentStructure } from "./document-structure"
import { delimitedTable, sheetTable, tableToMarkdown } from "./document-tables"
import { mapWordMessages, attachDiagnosticToError } from "./parse-diagnostics"
import {
  DEFAULT_DOCUMENT_LIMITS,
  DocumentBudget,
  DocumentLimitError,
  inputByteLength,
} from "./limits"

export type { DocumentType, DocumentMetadata, ProcessedDocument } from "./types"
import type {
  DocumentType,
  DocumentMetadata,
  DocumentTable,
  ProcessedDocument,
  ParseSummary,
  ParseDiagnostic,
  WordParseResult,
} from "./types"

export interface ProcessingOptions {
  signal?: AbortSignal
  extractEmbeddable?: boolean
  generateChunks?: boolean
  chunkingOptions?: Partial<ChunkingOptions>
  /** Bytes the input may hold (UTF-8 bytes for a string); larger input is refused. */
  maxFileSize?: number
  /** PDF bookmarks default on; native spatial extraction is retained. */
  extractPdfOutline?: boolean
  /** Opt-in rollout gate for the experimental AnyDoc legacy Office adapter. */
  anyDoc?: {
    enabled?: boolean
    signal?: AbortSignal
    timeoutMs?: number
  }
}

const DEFAULT_PROCESSING_OPTIONS: ProcessingOptions = {
  extractEmbeddable: true,
  generateChunks: false,
  anyDoc: {
    enabled: process.env.NEXT_PUBLIC_ENABLE_ANYDOC_LEGACY_OFFICE === "true",
  },
}

/**
 * Detect document type from filename
 */
export function detectDocumentType(filename: string): DocumentType {
  return detectDocumentTypeFromFilename(filename)
}

/**
 * Count words in text
 */
function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length
}

function normalizeAnyDocMarkdown(
  markdown: string,
  engineVersion: string,
  baseMetadata: DocumentMetadata,
  parser: "word" | "presentation",
  label: string
): {
  metadata: DocumentMetadata
  parseSummary: ParseSummary
  parseDiagnostics: ParseDiagnostic[]
} {
  return {
    metadata: {
      ...baseMetadata,
      lineCount: markdown.split("\n").length,
      wordCount: countWords(markdown),
      language: parser,
      parseEngine: "anydoc",
      parseEngineVersion: engineVersion,
      parseMode: "markdown-only",
    },
    parseSummary: {
      parser,
      structure: { segmentCount: 1 },
      quality: {
        status: "partial",
        reason: `AnyDoc produced Markdown without a structured ${label} parse result`,
      },
    },
    parseDiagnostics: [
      {
        code: "parser_info",
        severity: "info",
        message: `Legacy ${label} document parsed as Markdown by AnyDoc`,
      },
    ],
  }
}

function normalizeDocumentParseError(label: string, error: unknown): Error {
  // A budget refusal already says which limit and by how much.
  if (error instanceof DocumentLimitError) return error
  const message = error instanceof Error ? error.message : ""

  if (
    /password protected|encrypted|no readable|legacy powerpoint|convert to \.pptx/i.test(message)
  ) {
    const err = error instanceof Error ? error : new Error(message)
    return attachDiagnosticToError(err, {
      code: "parse_failed",
      severity: "error",
      message: err.message,
    })
  }

  const err = new Error(
    `Failed to parse ${label} file. Ensure the file is not password protected or corrupted, then retry.`
  )
  return attachDiagnosticToError(err, {
    code: "parse_failed",
    severity: "error",
    message: err.message,
  })
}

/** Types whose text IS the document: no parser stands between bytes and content. */
const PLAIN_TEXT_TYPES: ReadonlySet<DocumentType> = new Set([
  "markdown",
  "code",
  "json",
  "text",
  "unknown",
])

function assertWithinFileSize(data: string | ArrayBuffer, maxFileSize: number | undefined): void {
  if (maxFileSize === undefined) return
  const size = inputByteLength(data)
  if (size > maxFileSize) throw new DocumentLimitError("file-bytes", maxFileSize, size)
}

/**
 * Process a plain-text document (Markdown, code, JSON, text) synchronously.
 *
 * Every other format has a dedicated parser, and most of them are async:
 * use `processDocumentAsync`, which routes by format whatever the payload is.
 * Handing HTML, CSV or a binary format to this function is refused rather than
 * read as plain text, which is how markup and script source used to land in
 * retrieval text.
 */
export function processDocument(
  id: string,
  filename: string,
  content: string,
  options: ProcessingOptions = {}
): ProcessedDocument {
  const opts = { ...DEFAULT_PROCESSING_OPTIONS, ...options }
  const type = detectDocumentType(filename)
  if (!PLAIN_TEXT_TYPES.has(type)) {
    throw new Error(
      `processDocument reads plain-text formats only; '${type}' needs processDocumentAsync.`
    )
  }
  assertWithinFileSize(content, opts.maxFileSize)
  const lines = content.split("\n")

  let embeddableContent = content
  let metadata: DocumentMetadata = {
    size: content.length,
    lineCount: lines.length,
    wordCount: countWords(content),
  }

  let parseSummary: ParseSummary | undefined

  // Process based on type
  switch (type) {
    case "markdown": {
      const parsed = parseMarkdown(content)
      if (opts.extractEmbeddable) {
        embeddableContent = extractMarkdownContent(content)
      }
      metadata = {
        ...metadata,
        title: parsed.title,
        language: "markdown",
        tags: parsed.frontmatter?.tags as string[] | undefined,
      }
      parseSummary = normalizeMarkdownSummary(parsed)
      break
    }

    case "code": {
      const parsed = parseCode(content, filename)
      if (opts.extractEmbeddable) {
        embeddableContent = extractCodeEmbeddableContent(content, filename)
      }
      metadata = {
        ...metadata,
        language: parsed.language,
        functionCount: parsed.functions.length,
        importCount: parsed.imports.length,
      }
      parseSummary = normalizeCodeSummary(parsed)
      break
    }

    case "json": {
      try {
        const parsed = JSON.parse(content)
        metadata = {
          ...metadata,
          language: "json",
          isArray: Array.isArray(parsed),
          keyCount: typeof parsed === "object" && parsed !== null ? Object.keys(parsed).length : 0,
        }
      } catch {
        // Invalid JSON, treat as text
      }
      parseSummary = normalizeJSONSummary(metadata)
      break
    }

    case "text":
    default: {
      metadata = {
        ...metadata,
        language: detectLanguage(filename),
      }
      parseSummary = normalizeTextSummary(metadata)
      break
    }
  }

  if (parseSummary) {
    metadata = { ...metadata, parseSummary }
  }

  const result: ProcessedDocument = {
    id,
    filename,
    type,
    content,
    embeddableContent,
    metadata,
    parseSummary,
    parseDiagnostics: [],
    structure: buildDocumentStructure({
      content,
      title: metadata.title,
      ...(type === "markdown" ? { markdown: parseMarkdown(content) } : {}),
    }),
    sourceSegments: [
      {
        id: `${id}:text`,
        text: content,
        locator: { type: "text", start: 0, end: content.length },
      },
    ],
  }

  // Generate chunks if requested
  if (opts.generateChunks) {
    const strategy = opts.chunkingOptions?.strategy ?? "semantic"
    // In sync version, always use sync chunking
    const chunkResult = chunkDocument(embeddableContent, { strategy, ...opts.chunkingOptions }, id)

    result.chunks = chunkResult.chunks
  }

  return result
}

/**
 * The parse result's tables as typed grids: a spreadsheet's sheets, a
 * delimited file's rows, and the tables an HTML or Word document holds.
 */
function typedTables(
  type: DocumentType,
  parseResult: ProcessedDocument["parseResult"]
): DocumentTable[] {
  if (!parseResult) return []
  if ("sheets" in parseResult) {
    // One budget for the workbook, as its parse had: merges can widen a
    // sheet's grid past its stored cells.
    const budget = new DocumentBudget("expanded-cells", DEFAULT_DOCUMENT_LIMITS.maxExpandedCells)
    return parseResult.sheets.map((sheet, index) => sheetTable(sheet, index + 1, budget))
  }
  if (type === "csv" && "headers" in parseResult && "delimiter" in parseResult) {
    return [delimitedTable(parseResult.headers, parseResult.data, 1)]
  }
  if (type === "html" && "tables" in parseResult) return parseResult.tables ?? []
  if (type === "word" && "tables" in parseResult) return parseResult.tables ?? []
  return []
}

/**
 * Process a document asynchronously (supports binary and rich formats)
 */
export async function processDocumentAsync(
  id: string,
  filename: string,
  data: string | ArrayBuffer,
  options: ProcessingOptions = {}
): Promise<ProcessedDocument> {
  options.signal?.throwIfAborted()
  const opts = {
    ...DEFAULT_PROCESSING_OPTIONS,
    ...options,
    anyDoc: { ...DEFAULT_PROCESSING_OPTIONS.anyDoc, ...options.anyDoc },
  }
  const type = detectDocumentType(filename)
  assertWithinFileSize(data, opts.maxFileSize)

  // The format decides the parser, never the payload's container: an HTML
  // string and HTML bytes both go through the HTML parser, and a `.txt`
  // ArrayBuffer is decoded and read as text.
  if (PLAIN_TEXT_TYPES.has(type)) {
    if (typeof data === "string") return processDocument(id, filename, data, options)
    const decoded = decodeTextBytes(data)
    const processed = processDocument(id, filename, decoded.text, {
      ...options,
      maxFileSize: undefined,
    })
    return decoded.diagnostics.length
      ? { ...processed, parseDiagnostics: [...decoded.diagnostics] }
      : processed
  }

  let content = ""
  let embeddableContent = ""
  let metadata: DocumentMetadata = {
    size: typeof data === "string" ? data.length : data.byteLength,
    lineCount: 0,
    wordCount: 0,
  }
  let parseResult: ProcessedDocument["parseResult"]
  let parseSummary: ParseSummary | undefined
  let parseDiagnostics: ParseDiagnostic[] = []

  switch (type) {
    case "pdf": {
      // Dynamic import to reduce bundle size and memory usage
      const { parsePDF, extractPDFEmbeddableContent } = await import("./parsers/pdf-parser")
      const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data
      const parsed = await parsePDF(buffer, {
        signal: opts.signal,
        extractOutline: opts.extractPdfOutline !== false,
      })
      content = parsed.text
      embeddableContent = opts.extractEmbeddable ? extractPDFEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        title: parsed.metadata.title,
        lineCount: content.split("\n").length,
        wordCount: countWords(content),
        pageCount: parsed.pageCount,
        author: parsed.metadata.author,
      }
      parseResult = parsed
      parseSummary = normalizePDFSummary(parsed)
      if (parsed.diagnostics?.length) {
        parseDiagnostics = [...parsed.diagnostics]
      }
      break
    }

    case "word": {
      const extension = getFileExtension(filename)
      const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data

      if (extension === "doc" && opts.anyDoc?.enabled) {
        const { AnyDocParseError, parseLegacyOfficeWithAnyDoc } =
          await import("./parsers/anydoc-parser")
        try {
          const parsed = await parseLegacyOfficeWithAnyDoc(buffer, "doc", {
            signal: opts.signal ?? opts.anyDoc.signal,
            timeoutMs: opts.anyDoc.timeoutMs,
          })
          content = parsed.markdown
          embeddableContent = content
          const normalized = normalizeAnyDocMarkdown(
            content,
            parsed.engineVersion,
            metadata,
            "word",
            "Word"
          )
          metadata = normalized.metadata
          parseSummary = normalized.parseSummary
          parseDiagnostics = normalized.parseDiagnostics
          break
        } catch (error) {
          if (
            !(error instanceof AnyDocParseError) ||
            error.engineCode !== "formatMismatch" ||
            error.detectedFormat !== "docx"
          ) {
            throw error
          }
        }
      }

      try {
        if (extension === "odt") {
          const { parseOpenDocumentText } = await import("./parsers/open-document-parser")
          const parsed = await parseOpenDocumentText(buffer)
          content = parsed.text
          embeddableContent = opts.extractEmbeddable ? content : content
          metadata = {
            ...metadata,
            title: parsed.metadata?.title,
            author: parsed.metadata?.author,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "word",
          }
          parseResult = parsed
          parseSummary = normalizeWordSummary(parsed as WordParseResult)
          parseDiagnostics = mapWordMessages((parsed as WordParseResult).messages ?? [])
        } else {
          // Dynamic import to reduce bundle size and memory usage
          const { parseWord, extractWordEmbeddableContent } =
            await import("./parsers/office-parser")
          const parsed = await parseWord(buffer)
          content = parsed.text
          embeddableContent = opts.extractEmbeddable
            ? extractWordEmbeddableContent(parsed)
            : content
          metadata = {
            ...metadata,
            ...(parsed.metadata?.title ? { title: parsed.metadata.title } : {}),
            ...(parsed.metadata?.author ? { author: parsed.metadata.author } : {}),
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "word",
          }
          parseResult = parsed
          parseSummary = normalizeWordSummary(parsed)
          parseDiagnostics = mapWordMessages(parsed.messages)
        }
      } catch (error) {
        throw normalizeDocumentParseError("word processing", error)
      }
      break
    }

    case "excel": {
      try {
        const extension = getFileExtension(filename)
        const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data

        if (extension === "ods") {
          const { parseOpenDocumentSpreadsheet } = await import("./parsers/open-document-parser")
          const parsed = await parseOpenDocumentSpreadsheet(buffer)
          content = parsed.text
          embeddableContent = content
          metadata = {
            ...metadata,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "excel",
            sheetCount: parsed.sheets.length,
            sheetNames: parsed.sheetNames,
          }
          parseResult = parsed
          parseSummary = normalizeExcelSummary(parsed)
        } else {
          // Dynamic import to reduce bundle size and memory usage
          const { parseExcel, extractExcelEmbeddableContent } =
            await import("./parsers/office-parser")
          const parsed = await parseExcel(buffer)
          content = parsed.text
          embeddableContent = opts.extractEmbeddable
            ? extractExcelEmbeddableContent(parsed)
            : content
          metadata = {
            ...metadata,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "excel",
            sheetCount: parsed.sheets.length,
            sheetNames: parsed.sheetNames,
          }
          parseResult = parsed
          parseSummary = normalizeExcelSummary(parsed)
        }
      } catch (error) {
        throw normalizeDocumentParseError("spreadsheet", error)
      }
      break
    }

    case "presentation": {
      const ext = getFileExtension(filename)
      if (ext === "ppt") {
        if (!opts.anyDoc?.enabled) {
          throw new Error(
            "Legacy PowerPoint (.ppt) is not supported. Please convert to .pptx and retry."
          )
        }
        const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data
        const { AnyDocParseError, parseLegacyOfficeWithAnyDoc } =
          await import("./parsers/anydoc-parser")
        try {
          const parsed = await parseLegacyOfficeWithAnyDoc(buffer, "ppt", {
            signal: opts.signal ?? opts.anyDoc.signal,
            timeoutMs: opts.anyDoc.timeoutMs,
          })
          content = parsed.markdown
          embeddableContent = content
          const normalized = normalizeAnyDocMarkdown(
            content,
            parsed.engineVersion,
            metadata,
            "presentation",
            "PowerPoint"
          )
          metadata = normalized.metadata
          parseSummary = normalized.parseSummary
          parseDiagnostics = normalized.parseDiagnostics
          break
        } catch (error) {
          if (
            !(error instanceof AnyDocParseError) ||
            error.engineCode !== "formatMismatch" ||
            error.detectedFormat !== "pptx"
          ) {
            throw error
          }
        }
      }

      try {
        const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data

        if (ext === "odp") {
          const { parseOpenDocumentPresentation } = await import("./parsers/open-document-parser")
          const parsed = await parseOpenDocumentPresentation(buffer)
          content = parsed.text
          embeddableContent = content
          metadata = {
            ...metadata,
            title: parsed.metadata.title,
            author: parsed.metadata.author,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "presentation",
            slideCount: parsed.slideCount,
          }
          parseResult = parsed
          parseSummary = normalizePresentationSummary(parsed)
        } else {
          const { parsePresentation, extractPresentationEmbeddableContent } =
            await import("./parsers/presentation-parser")
          const parsed = await parsePresentation(buffer)
          content = parsed.text
          embeddableContent = opts.extractEmbeddable
            ? extractPresentationEmbeddableContent(parsed)
            : content
          metadata = {
            ...metadata,
            title: parsed.metadata.title,
            author: parsed.metadata.author,
            lineCount: content.split("\n").length,
            wordCount: countWords(content),
            language: "presentation",
            slideCount: parsed.slideCount,
          }
          parseResult = parsed
          parseSummary = normalizePresentationSummary(parsed)
        }
        const textless = (parseResult as { slides: { slideNumber: number; text: string }[] }).slides
          .filter((slide) => !slide.text.trim())
          .map((slide) => slide.slideNumber)
        if (textless.length) {
          parseDiagnostics = [
            ...parseDiagnostics,
            {
              code: "unsupported_feature",
              severity: "warning",
              message: `Slides ${textless.join(", ")} have no extractable text; pictures, charts and diagrams on them are not read.`,
            },
          ]
        }
      } catch (error) {
        throw normalizeDocumentParseError("presentation", error)
      }
      break
    }

    case "rtf": {
      const { parseRTF, extractRTFEmbeddableContent } = await import("./parsers/rtf-parser")
      const text = typeof data === "string" ? data : decodeTextPayload(data, parseDiagnostics)
      const parsed = parseRTF(text)
      content = parsed.text
      embeddableContent = opts.extractEmbeddable ? extractRTFEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        lineCount: content.split("\n").length,
        wordCount: countWords(content),
        language: "rtf",
        charset: parsed.metadata.charset,
      }
      parseResult = parsed
      parseSummary = normalizeRTFSummary(parsed)
      break
    }

    case "epub": {
      const { parseEPUB, extractEPUBEmbeddableContent } = await import("./parsers/epub-parser")
      const buffer = typeof data === "string" ? stringToArrayBuffer(data) : data
      const parsed = await parseEPUB(buffer)
      content = parsed.text
      embeddableContent = opts.extractEmbeddable ? extractEPUBEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        title: parsed.metadata.title,
        author: parsed.metadata.author,
        lineCount: content.split("\n").length,
        wordCount: countWords(content),
        language: "epub",
        chapterCount: parsed.chapterCount,
      }
      parseResult = parsed
      parseSummary = normalizeEPUBSummary(parsed)
      break
    }

    case "csv": {
      // Dynamic import to reduce bundle size and memory usage
      const { parseCSV, extractCSVEmbeddableContent } = await import("./parsers/csv-parser")
      const text = typeof data === "string" ? data : decodeTextPayload(data, parseDiagnostics)
      const parsed = parseCSV(text)
      content = text
      embeddableContent = opts.extractEmbeddable ? extractCSVEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        lineCount: parsed.rowCount,
        wordCount: countWords(content),
        language: "csv",
        rowCount: parsed.rowCount,
        columnCount: parsed.columnCount,
        headers: parsed.headers,
      }
      parseResult = parsed
      parseSummary = normalizeCSVSummary(parsed)
      break
    }

    case "html": {
      // Dynamic import to reduce bundle size and memory usage
      const { parseHTML, extractHTMLEmbeddableContent, htmlToMarkdown } =
        await import("./parsers/html-parser")
      const text = typeof data === "string" ? data : decodeTextPayload(data, parseDiagnostics)
      const parsed = await parseHTML(text)
      // The readable document, not its markup: scripts, styles and tags are
      // source, and every consumer (retrieval, Canvas, IM, the CLI) reads
      // `content` as the document's text.
      content = await htmlToMarkdown(text)
      embeddableContent = opts.extractEmbeddable ? extractHTMLEmbeddableContent(parsed) : content
      metadata = {
        ...metadata,
        title: parsed.title,
        lineCount: content.split("\n").length,
        wordCount: countWords(parsed.text),
        language: "html",
        linkCount: parsed.links.length,
        imageCount: parsed.images.length,
      }
      parseResult = parsed
      parseSummary = normalizeHTMLSummary(parsed)
      break
    }

    default: {
      throw new Error(`No parser is configured for document type '${type}'.`)
    }
  }

  if (parseSummary) {
    metadata = { ...metadata, parseSummary }
  }

  const tables = typedTables(type, parseResult)
  if (type === "html") {
    // The text is Markdown, which has no merged cells: say how many values it
    // repeats into the positions their merges cover.
    const repeated = tables.reduce((sum, table) => sum + tableToMarkdown(table).repeatedCells, 0)
    if (repeated > 0) {
      parseDiagnostics = [
        ...parseDiagnostics,
        {
          code: "table_merges_projected",
          severity: "info",
          message: `${repeated} merged table cell position(s) repeat their merged value in the text, which has no merged cells; the document's table structure keeps the merges.`,
        },
      ]
    }
  }

  const result: ProcessedDocument = {
    id,
    filename,
    type,
    content,
    embeddableContent,
    metadata,
    parseResult,
    parseSummary,
    parseDiagnostics,
    structure: buildDocumentStructure({
      content,
      title: metadata.title,
      ...(parseResult && "pages" in parseResult
        ? { pdf: parseResult }
        : { markdown: parseMarkdown(content) }),
      tables,
    }),
  }

  opts.signal?.throwIfAborted()
  if (parseResult && "pages" in parseResult) {
    result.sourceSegments = parseResult.pages.map((page) => ({
      id: `${id}:page:${page.pageNumber}`,
      text: page.text,
      locator: { type: "page" as const, page: page.pageNumber },
    }))
  } else if (parseResult && "sheets" in parseResult) {
    result.sourceSegments = parseResult.sheets.map((sheet, index) => {
      let column = sheet.columnCount
      let lastColumn = ""
      while (column > 0) {
        column -= 1
        lastColumn = String.fromCharCode(65 + (column % 26)) + lastColumn
        column = Math.floor(column / 26)
      }
      return {
        id: `${id}:sheet:${index + 1}`,
        text: sheet.data
          .map((row) => row.map((cell) => JSON.stringify(cell ?? "")).join("\t"))
          .join("\n"),
        locator: {
          type: "sheet" as const,
          sheet: sheet.name,
          ...(sheet.rowCount > 0 && lastColumn
            ? { range: `A1:${lastColumn}${sheet.rowCount}` }
            : {}),
        },
      }
    })
  } else if (parseResult && "slides" in parseResult) {
    result.sourceSegments = parseResult.slides.map((slide) => ({
      id: `${id}:slide:${slide.slideNumber}`,
      text: slide.text,
      locator: { type: "slide" as const, slide: slide.slideNumber },
    }))
  } else {
    result.sourceSegments = [
      {
        id: `${id}:text`,
        text: content,
        locator: { type: "text", start: 0, end: content.length },
      },
    ]
  }

  // Generate chunks if requested
  if (opts.generateChunks) {
    const chunkResult = chunkDocument(embeddableContent, opts.chunkingOptions, id)
    result.chunks = chunkResult.chunks
  }

  return result
}

/**
 * Convert string to ArrayBuffer
 */
function stringToArrayBuffer(str: string): ArrayBuffer {
  const encoder = new TextEncoder()
  return encoder.encode(str).buffer
}

/**
 * Text from the bytes of a text file.
 *
 * A byte-order mark names the encoding (UTF-8, UTF-16 LE/BE) and is dropped;
 * without one the bytes are read as UTF-8. UTF-32 has no decoder in the
 * WHATWG Encoding standard, so it is refused instead of being read as UTF-16.
 * Bytes that are not valid in the chosen encoding are decoded with U+FFFD and
 * reported, so a mis-encoded file is visibly damaged rather than silently.
 */
export function decodeTextBytes(buffer: ArrayBuffer): {
  text: string
  encoding: string
  diagnostics: ParseDiagnostic[]
} {
  const encoding = detectEncoding(buffer)
  if (encoding === "utf-32le" || encoding === "utf-32be") {
    throw attachDiagnosticToError(new Error("UTF-32 text files are not supported."), {
      code: "parse_failed",
      severity: "error",
      message: "UTF-32 text files are not supported.",
      suggestion: "Save the file as UTF-8 and retry.",
    })
  }
  try {
    return {
      text: new TextDecoder(encoding, { fatal: true }).decode(buffer),
      encoding,
      diagnostics: [],
    }
  } catch {
    return {
      text: new TextDecoder(encoding).decode(buffer),
      encoding,
      diagnostics: [
        {
          code: "parser_warning",
          severity: "warning",
          message: `The file is not valid ${encoding.toUpperCase()}; unreadable bytes were replaced with U+FFFD.`,
          suggestion: "Save the file as UTF-8 and retry.",
        },
      ],
    }
  }
}

/** Decode a text payload, appending any decoding diagnostic to `diagnostics`. */
function decodeTextPayload(buffer: ArrayBuffer, diagnostics: ParseDiagnostic[]): string {
  const decoded = decodeTextBytes(buffer)
  diagnostics.push(...decoded.diagnostics)
  return decoded.text
}

/**
 * Get file extension from filename
 */
export function getFileExtension(filename: string): string {
  return getFilenameExtension(filename)
}

/**
 * Estimate token count for content (CJK-aware approximation)
 * CJK characters typically map to 1-2 tokens each
 * English text averages ~4 characters per token
 * Code tends to have more tokens per character (~3 chars/token)
 */
export function estimateTokenCount(content: string): number {
  if (!content) return 0

  // Count CJK characters (Chinese, Japanese, Korean)
  // CJK Unified Ideographs: U+4E00-U+9FFF
  // CJK Extension A: U+3400-U+4DBF
  // Hiragana: U+3040-U+309F, Katakana: U+30A0-U+30FF
  // Hangul Syllables: U+AC00-U+D7AF
  // Fullwidth forms: U+FF00-U+FFEF
  const cjkRegex = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/g
  const cjkMatches = content.match(cjkRegex)
  const cjkCount = cjkMatches ? cjkMatches.length : 0

  // Non-CJK character count
  const nonCjkLength = content.length - cjkCount

  // CJK: ~1.5 tokens per character on average
  // Non-CJK: ~4 characters per token (0.25 tokens/char)
  const cjkTokens = cjkCount * 1.5
  const nonCjkTokens = nonCjkLength / 4

  return Math.ceil(cjkTokens + nonCjkTokens)
}

/**
 * Detect BOM encoding from ArrayBuffer
 * Returns encoding name or 'utf-8' as default
 */
export function detectEncoding(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  // UTF-8 BOM: EF BB BF
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8"
  }

  // UTF-32 BE BOM: 00 00 FE FF
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  ) {
    return "utf-32be"
  }

  // UTF-32 LE BOM: FF FE 00 00
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return "utf-32le"
  }

  // UTF-16 LE BOM: FF FE
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le"
  }

  // UTF-16 BE BOM: FE FF
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be"
  }

  // Default to UTF-8
  return "utf-8"
}
