/**
 * Processing budgets every document entry point shares.
 *
 * A compressed-byte cap does not bound what a document expands into: an
 * OpenDocument spreadsheet repeats a row a million times in a few bytes, and an
 * OOXML sheet can declare a range far larger than the cells it stores. The
 * parsers therefore count what they would materialise and stop before they
 * allocate it. Hitting a budget is a refusal, never a quietly truncated
 * "complete" result.
 */

import { attachDiagnosticToError } from "./parse-diagnostics"

/** What a budget measures. */
export type DocumentLimitScope =
  /** Bytes of the input, as the caller handed it over (UTF-8 bytes for a string). */
  | "file-bytes"
  /** Spreadsheet cells a parser would materialise, empty ones included. */
  | "expanded-cells"
  /** Slides or pages a parser would read. */
  | "slides"

export interface DocumentLimits {
  /** Bytes one document may hold when a user brings it in (Canvas, Twin, knowledge). */
  maxInputBytes: number
  /** Cells one workbook may expand into, across all of its sheets. */
  maxExpandedCells: number
  /** Slides one presentation may hold. */
  maxSlides: number
}

/**
 * Desktop/browser budgets. Fifty megabytes is the largest file the upload
 * commit lets through as one archive member. A million cells is a 10,000 × 100 sheet; a real
 * dataset past that belongs in a database, not in a retrieval index, and
 * materialising it costs hundreds of megabytes in the webview.
 */
export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = {
  // The upload commit's ceiling for one archive member.
  maxInputBytes: 50 * 1024 * 1024,
  maxExpandedCells: 1_000_000,
  maxSlides: 2_000,
}

/** A document that would exceed one of its processing budgets. */
export class DocumentLimitError extends Error {
  constructor(
    readonly scope: DocumentLimitScope,
    readonly limit: number,
    readonly observed: number
  ) {
    super(
      `Document exceeds the ${scope} limit: ${observed.toLocaleString("en-US")} > ${limit.toLocaleString(
        "en-US"
      )}.`
    )
    this.name = "DocumentLimitError"
    attachDiagnosticToError(this, {
      code: "limit_exceeded",
      severity: "error",
      message: this.message,
      suggestion: "Split the document into smaller files and retry.",
    })
  }
}

/** Running count against one budget; throws the moment it would be crossed. */
export class DocumentBudget {
  private used = 0

  constructor(
    private readonly scope: DocumentLimitScope,
    private readonly limit: number
  ) {}

  /** Reserve `count` more units, or throw before anything is allocated. */
  take(count: number): void {
    if (!Number.isFinite(count) || count < 0) {
      throw new DocumentLimitError(this.scope, this.limit, Number.POSITIVE_INFINITY)
    }
    const next = this.used + count
    if (next > this.limit) throw new DocumentLimitError(this.scope, this.limit, next)
    this.used = next
  }
}

/** Byte length of the input as handed over: a string counts its UTF-8 encoding. */
export function inputByteLength(data: string | ArrayBuffer): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength
}
