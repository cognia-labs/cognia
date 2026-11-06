/**
 * SHA-256 over strings, blobs, bytes and data URLs, hex-encoded, through Web
 * Crypto: content identity for attachments, uploads, packages and caches.
 *
 * The implementation lives in `@cognia/ocr` (via the plugin contract), where
 * it first served the OCR cache key. It was never OCR's: this neutral shim is
 * what the app imports, so hashing does not reach into the OCR module
 * (ADR-0250 M3).
 */
export * from "@cognia/plugin-contract/lib/ocr/hash"
// Keep the runtime value explicit when this shim is also a bundle entry.
export { sha256Bytes } from "@cognia/plugin-contract/lib/ocr/hash"
