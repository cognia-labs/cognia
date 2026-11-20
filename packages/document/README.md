# @cognia/document

Cognia's "read file" layer. Folds eleven mainstream document formats (PDF,
Office, EPUB, HTML, Markdown, RTF, CSV, code, presentation, OpenDocument) into a
single `ProcessedDocument`: raw text + embeddable text + structured metadata +
parse diagnostics.

Framework-agnostic. Heavy parsers (`pdfjs-dist`, `mammoth`, `xlsx`, `jszip`,
`cheerio`) are dynamically imported and declared as peer dependencies so they
stay out of the mobile bundle unless actually used.

```ts
import { processDocument } from "@cognia/document/document-processor"
import { detectDocumentType } from "@cognia/document/support-matrix"
```

Consumed in dev/test from source (`packages/document/src`).

### Canonical document navigation

`ProcessedDocument.content` is original extracted source text. `embeddableContent`
is a distinct embedding projection and must not replace it in persisted sources.
`structure` contains a versioned chapter tree and page ranges over `content`:
UTF-16 character ranges are half-open; line and page numbers are 1-based and
inclusive. `contentHash` identifies the extracted text version, independently
of any binary source fingerprint. Section IDs derive from parent/title paths
and repeated-heading occurrences, so body-only edits retain section identity.
Optional summaries are navigation aids; readers answer from original slices.

`structure.tables` holds a document's tables as typed grids
(`DocumentTable`): each cell is anchored at its top-left row and column with
its `rowSpan` / `columnSpan`, its text, whether it heads the table and, from a
spreadsheet, the value it stores. HTML and DOCX tables (mammoth's
`colspan` / `rowspan` / `<thead>`) are placed by the HTML table model, so a
merged cell no longer shifts the cells after it. ODT text tables, XLSX / ODS
sheets (merges as spans, located by sheet range) and CSV files are read the
same way. Markdown and plain text are projections: Markdown has no merged
cells, so `tableToMarkdown` repeats a merged value into the positions it
covers and the processor reports `table_merges_projected`. Each grid,
including the positions no cell covers, counts against `maxExpandedCells`.
`extractDocumentTables` reads the pipe and HTML tables in Markdown content the
same way; the application's OCR fallback uses it for the tables an OCR
provider writes on a page, located by page. Slide tables (PPTX / ODP) and
tables in a PDF's text layer are not typed yet.

Each page range has a `status`: `text` (the PDF text layer), `no-text-layer`
(empty text layer, no OCR run: blank or scanned is unknown), `ocr`, `blank`
(OCR found nothing) or `ocr-failed` (the page keeps its text-layer text). An
OCR'd page carries `confidence` only when the provider reports block
confidences; absent means unknown.

`buildTextDocumentStructure` backfills text documents through the existing
Markdown parser. PDF processing extracts bookmarks by default (override with
`extractPdfOutline: false`) while retaining native spatial extraction where
available. Unresolved bookmarks fall back to page navigation. Named PDF
destinations and indirect page references are resolved by pdfjs, rather than
assuming PDF object numbers are page numbers. OCR remains in the application
OCR router, which publishes fresh canonical ranges when page text changes.

`DocumentSnapshot<Format>` is the shared parsed-text/tree envelope for activated
index generations. Twin stores its current snapshot on the existing source
row in the same transaction as chunk replacement and pointer activation;
failed replacements preserve it, and deleting the source removes it. Empty
replacements activate an empty generation and retire prior chunks/vectors.
Twin has no retained-revision rollback API; Knowledge Base owns its separate
revision history and authorization semantics.
