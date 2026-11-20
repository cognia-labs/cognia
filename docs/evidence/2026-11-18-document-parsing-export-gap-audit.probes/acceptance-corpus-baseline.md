# Document acceptance corpus: baseline (G6)

- Recorded: 2026-11-20, on `dev` after `65e631636d` (G1), with the container check and the mammoth Node-input fix from the same change.
- Suite: `packages/document/src/acceptance-corpus.test.ts`.
- Command: `node scripts/test/jest.mjs --runInBand --runTestsByPath packages/document/src/acceptance-corpus.test.ts`.
- Result: 44 of 44 checks pass. The whole corpus (10 documents plus 8 negative samples) parses in 0.45 s wall time on the development machine. That time includes Jest; it is not a performance budget.

## Method

Every document is generated in memory by a real writer: `docx` for DOCX, SheetJS for XLSX, and hand-written packages for ODS, ODT, PPTX and EPUB, plus HTML, CSV, Markdown and RTF strings. Each is read by the real parser through `processDocumentAsync`; nothing is mocked. Every document mixes English and Simplified Chinese.

Each capability is checked separately against its golden expectation, so a regression names the capability that broke. There is no blended score.

| Capability      | What is golden                                                                 | Documents | Pass |
| --------------- | ------------------------------------------------------------------------------ | --------- | ---- |
| Text            | Key phrases in both languages survive                                          | 10        | 10   |
| Sections        | Heading titles and levels, in order (DOCX and ODT from styles, HTML, Markdown) | 4         | 4    |
| Tables          | Every anchored cell: row, column, spans, header flag, stored value             | 6         | 6    |
| Locators        | A text locator's slice holds the cells; a sheet locator names the used range   | 6         | 6    |
| Parse identity  | The reader recorded for the parse                                              | 10        | 10   |
| Negative sample | Refused or reported, not read                                                  | 8         | 8    |

The table cases cover the defects G3 fixed:

- a vertically merged DOCX cell (`w:vMerge`) with the value under it kept in its own column;
- a DOCX row spanning the whole table (`w:gridSpan`);
- an HTML header that is two rows deep;
- an ODS covered cell;
- an XLSX merge with an empty anchor;
- a stored float (`0.1 + 0.2` reads `0.3`, while the cell keeps the stored value).

The negative samples are:

- an encrypted ODF package;
- text named `.xlsx`;
- text named `.pdf`;
- an `.xls` that is really HTML (read, with a `format_mismatch` warning);
- a DOCX package with no document;
- an HTML table whose spans exceed the cell budget;
- bytes that are not valid UTF-8;
- a Markdown file, which must not gain a table structure.

## Defects the corpus found

1. **DOCX parsing failed on Node hosts.** mammoth's Node build reads only `buffer` or `path`; only its browser build reads the `arrayBuffer` our parser passed. Node hosts therefore failed with "Could not find file in options", and the CLI's `.docx` attachments went through this path. The CLI test mocks the processor, so this never surfaced. The parser now passes both keys over the same bytes.
2. **Nothing compared the extension with the bytes.** Plain text named `.xlsx` became a "complete" one-cell workbook, because SheetJS sniffs it as CSV. Remediation plan §3.3 requires the extension to be checked against the magic bytes. `format-signature.ts` now refuses a ZIP-package format (OOXML, ODF, EPUB), a legacy Office file or a PDF whose bytes are something else. It reports this as `format_mismatch`, naming what the bytes look like. `.xls` (Excel also reads HTML, CSV, SYLK and SpreadsheetML) and `.rtf` get a warning instead.

## Not covered by this lane

| Gap                                   | Why                                                                                             | Where it is covered instead                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| PDF (pdf.js and native)               | pdf.js 6 ships only ES modules, which Jest cannot load; the native reader needs the Tauri shell | `pdf-parser.test.ts` with pdf.js mocked; acceptance needs a browser or desktop run |
| OCR (any provider)                    | Needs a provider and rasterized pages                                                           | `ocr-fallback.test.ts` with the router faked; needs a real-provider run            |
| Legacy `.doc`, `.xls`, `.ppt` (OLE)   | No OLE writer in the toolchain; AnyDoc runs in a browser Worker                                 | `anydoc-parser.test.ts`, `document-processor.test.ts` with AnyDoc mocked           |
| Slide tables (PPTX / ODP)             | The presentation readers do not type tables yet                                                 | Residual gap                                                                       |
| Large or real-world files, memory use | The corpus is small, synthetic and fixed by design                                              | Needs a real-file run against customer-like fixtures                               |

Re-run the suite after any parser change. A changed golden must be justified in the commit that changes it, and a parser change that alters output also bumps `DOCUMENT_PROCESSING_VERSION`.
