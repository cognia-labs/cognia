/**
 * Image and data-URL byte helpers: decode a data URL, base64 and data-URL
 * encoding, MIME predicates, measuring, downscaling and converting to a
 * portable image type.
 *
 * The implementation lives in `@cognia/ocr` (`image-prep`), where OCR
 * providers first needed it. Chat attachments, media ingest, sharing and the
 * remote runtimes use it for images that never meet OCR, so they import this
 * neutral shim instead of the OCR module (ADR-0250 M3).
 */
export * from "@cognia/ocr/image-prep"
