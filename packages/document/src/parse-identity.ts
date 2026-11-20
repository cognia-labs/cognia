/**
 * How a document's text and structure were produced (G1): which reader ran,
 * at which processing version, with which output-shaping options, by which
 * strategy, and when. A parse with a different identity key is a different
 * parse, even over the same bytes: a consumer that keeps a parse compares
 * keys, not timestamps, to decide whether it must build a new generation.
 */

import { documentContentHash } from "./document-structure"
import type { DocumentParseIdentity } from "./types"

/**
 * What this package's parsers produce, as a number: bump it whenever a parser
 * change alters the text, the structure or the tables a parse yields, so a
 * kept parse can tell it was produced by older code.
 */
export const DOCUMENT_PROCESSING_VERSION = 1

/** A JSON value with object keys in sorted order, so equal options hash equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** A hash of the options that shape a parse's output; key order does not matter. */
export function parseConfigHash(config: Readonly<Record<string, unknown>>): string {
  return documentContentHash(stableJson(config))
}

/**
 * The parts of an identity that decide what a parse produces: reader, its
 * reported version, the processing version, the options and, after OCR, the
 * provider and languages. Timestamps are left out: re-reading the same
 * bytes the same way is the same parse.
 */
export function parseIdentityKey(identity: DocumentParseIdentity): string {
  return stableJson({
    parser: identity.parser,
    parserVersion: identity.parserVersion,
    processingVersion: identity.processingVersion,
    configHash: identity.configHash,
    strategy: identity.strategy,
    ocrProvider: identity.ocrProvider,
    languages: identity.languages,
  })
}
