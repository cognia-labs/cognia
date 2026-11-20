/**
 * Whether a file's bytes are the container its extension claims (remediation
 * plan §3.3: format identification weighs the extension against the magic
 * bytes, and a conflict is a typed diagnostic, never a silent guess).
 *
 * SheetJS reads almost anything as a sheet, so plain text named `.xlsx` came
 * out as a "complete" one-cell workbook; mammoth and the ZIP-based readers
 * failed with a generic "corrupted" message. The check runs before any
 * parser: a ZIP-package format (OOXML, ODF, EPUB), a legacy Office file or a
 * PDF whose bytes are something else is refused with `format_mismatch`
 * naming what the bytes look like. Two formats real files legitimately bend
 * are let through with a warning instead: `.xls`, which Excel and SheetJS
 * also read as HTML, CSV, SYLK or SpreadsheetML, and `.rtf`, which the RTF
 * reader reads as text when it carries no RTF header.
 */

import { attachDiagnosticToError } from "./parse-diagnostics"
import type { ParseDiagnostic } from "./types"

/** What a file's leading bytes say it is. */
export type ContainerSignature = "zip" | "ole" | "pdf" | "rtf" | "text" | "binary" | "empty"

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
/** A PDF header may follow up to 1024 bytes of leading data (ISO 32000-2 §7.5.2, Annex H). */
const PDF_HEADER_WINDOW = 1024

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte)

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0))

/** The container the bytes are, by their signature. */
export function containerSignature(bytes: Uint8Array): ContainerSignature {
  if (bytes.length === 0) return "empty"
  // Local file header, empty archive, spanned archive.
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "zip"
  }
  if (startsWith(bytes, OLE_SIGNATURE)) return "ole"
  const pdf = ascii("%PDF-")
  const window = Math.min(bytes.length - pdf.length, PDF_HEADER_WINDOW - pdf.length)
  for (let offset = 0; offset <= window; offset += 1) {
    if (startsWith(bytes, pdf, offset)) return "pdf"
  }
  // RTF may follow a UTF-8 byte-order mark or white space.
  let start = 0
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) start = 3
  while (start < bytes.length && [0x09, 0x0a, 0x0d, 0x20].includes(bytes[start])) start += 1
  if (startsWith(bytes, ascii("{\\rtf"), start)) return "rtf"
  return looksLikeText(bytes) ? "text" : "binary"
}

/** Whether the first bytes decode as UTF-8 with no control characters but white space. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096)
  // A cut through a multi-byte sequence at the sample's end is not an error.
  const text = new TextDecoder("utf-8", { fatal: false }).decode(sample, { stream: true })
  if (text.includes("�")) return false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) {
      return false
    }
  }
  return true
}

/** The containers each binary format's files may be, and whether others only warn. */
const EXPECTED: Record<string, { containers: readonly ContainerSignature[]; lenient?: boolean }> = {
  ...Object.fromEntries(
    ["docx", "docm", "dotx", "dotm", "xlsx", "xlsm", "xltx", "xltm", "pptx", "pptm", "potx", "potm"]
      .concat(["odt", "ods", "odp", "epub"])
      .map((extension) => [extension, { containers: ["zip"] as const }])
  ),
  // A legacy file that is really its OOXML successor still reads.
  doc: { containers: ["ole", "zip"] },
  ppt: { containers: ["ole", "zip"] },
  xls: { containers: ["ole", "zip"], lenient: true },
  pdf: { containers: ["pdf"] },
  rtf: { containers: ["rtf"], lenient: true },
}

const DESCRIPTION: Record<ContainerSignature, string> = {
  zip: "a ZIP package",
  ole: "a legacy Office (OLE) file",
  pdf: "a PDF",
  rtf: "an RTF document",
  text: "plain text",
  binary: "unrecognized binary data",
  empty: "nothing (the file is empty)",
}

/** A file whose bytes are not the format its name claims. */
export class DocumentFormatMismatchError extends Error {
  readonly name = "DocumentFormatMismatchError"
  constructor(
    readonly extension: string,
    readonly detected: ContainerSignature
  ) {
    super(
      `This .${extension} file is not a ${extension.toUpperCase()} file: its contents are ${DESCRIPTION[detected]}. Open it in the program that made it and save it again in its real format, or rename it to match its contents.`
    )
  }
}

/**
 * Check the bytes against the extension: refuse a conflict for a strict
 * format, or return the warning to report for a lenient one. Formats without
 * a container signature (text, CSV, HTML, code) are not checked.
 */
export function checkContainer(extension: string, bytes: Uint8Array): ParseDiagnostic | undefined {
  const expected = EXPECTED[extension.toLowerCase()]
  if (!expected) return undefined
  const detected = containerSignature(bytes)
  if (expected.containers.includes(detected)) return undefined
  const error = new DocumentFormatMismatchError(extension.toLowerCase(), detected)
  const diagnostic: ParseDiagnostic = {
    code: "format_mismatch",
    severity: expected.lenient ? "warning" : "error",
    message: error.message,
  }
  if (expected.lenient && detected !== "empty") return diagnostic
  throw attachDiagnosticToError(error, diagnostic)
}
