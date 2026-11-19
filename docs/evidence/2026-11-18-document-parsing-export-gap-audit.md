# Evidence ledger: document parsing export gap audit

- Status: verifying
- Lane: deep
- Created: 2026-11-18
- Updated: 2026-11-18
- Related: ADR-0024 (OCR), ADR-0158 (artifacts/Canvas), ADR-0134 (remote documents); [reproduction probes](./2026-11-18-document-parsing-export-gap-audit.probes/README.md); [remediation proposal](../plans/2026-11-18-document-parsing-export-remediation.md).

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 帮我分析一下现在的文档解析和导出，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

Follow-up on 2026-11-18:

> 基于这份审计报告，帮我制定完整的修复和功能补齐方案，覆盖这 15 项问题和业内实践差距，按优先级拆分阶段，并明确每阶段的验收标准。

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                 | State     | Basis                                                                                                               | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Current ingestion uses packages/document; exports span core writers, Canvas/chat and rich-document plugins.                                                               | Observed  | Source inventory on 2026-11-18, HEAD b50c5c9501263e3abf20f5792c98756cdc675687 with concurrent working-tree changes. | -          |
| H1  | Advertised formats diverge from actual caller routes and delivered content.                                                                                               | Verified  | F1–F14; real-parser/output probes plus caller tracing on 2026-11-18.                                                | O1         |
| H2  | Most gaps may be explicit fidelity boundaries rather than absent format support.                                                                                          | Contested | Rich features and loss warnings exist, but F2/F5/F11–F14 show silent loss beyond those declarations.                | O1         |
| G1  | Audit current parsing/export capabilities, actionable defects and gaps against primary-source industry practice.                                                          | Agreed    | User request, 2026-11-18.                                                                                           | -          |
| C1  | Preserve concurrent edits; perform analysis and bounded probes, without product changes or external publication.                                                          | Verified  | Task scope and repository shared-tree instructions, 2026-11-18.                                                     | -          |
| Q1  | Which document workload should set the final fidelity and performance acceptance thresholds?                                                                              | Open      | No customer corpus or workload preference supplied; recommendations will remain proposals.                          | -          |
| O2  | Audited parser, core writer, Twin ingest, IM extractor and rich-plugin paths are unchanged between audit HEAD and proposal HEAD 2e6da23843f9134e8e6865d8f32a213d2402d5ad. | Verified  | Scoped git diff and current source inspection on 2026-11-18; unrelated concurrent edits remain.                     | O1         |
| G2  | Deliver a complete prioritized remediation proposal covering F1–F15, industry gaps and phase acceptance.                                                                  | Agreed    | Explicit user follow-up on 2026-11-18; planning, not product implementation.                                        | G1         |

## Problem frame

Trace local document ingestion through chat, Canvas and knowledge consumers, and trace chat/Canvas/rich-document exports through the actual writers and save boundary (O1, G1). Deliver an evidence-backed capability matrix, prioritized findings and a primary-source comparison. Explicitly distinguish extracting content for retrieval from editing and round-tripping an Office document. Cloud document provider adapters are adjacent boundaries, not a full auth/provider audit. No product implementation, benchmark ranking, external upload, or claim of three-shell acceptance is in scope (C1).

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                                   |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Shared parser plus many ingestion and export consumers, and four rich-document plugins.                                       |
| technical    | high   | Binary formats, OCR, rendering, native/browser save and lossy semantic transformations.                                       |
| coupling     | high   | Same extension can take different routes depending on the caller's payload type and shell.                                    |
| requirement  | medium | Audit scope is clear; target workload and fidelity threshold remain Q1.                                                       |
| verification | high   | Headless real-file probes are feasible; Office viewer, mobile and native save acceptance need separate real-environment runs. |
| risk         | high   | Silent text/numeric loss, false successful exports and untrusted document resource consumption.                               |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                      | Severity | Source                                                | Claim                                                                                      | Refuted by                                                                                        |
| --- | ---------------------------------------------------------------------------------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| R1  | Supported input becomes missing or misleading content.                             | high     | FMEA; document support matrix; fresh parsing reviewer | Accepted formats route through an appropriate parser with visible failures.                | Same payload parsed differently by actual caller type; omitted data without diagnostics.          |
| R2  | Export is unreadable or loses meaningful content silently.                         | high     | FMEA; ADR-0158; fresh export reviewer                 | Advertised export is reachable and output preserves its declared semantics.                | Offered action returns no output, or round trip loses meaningful content without warning.         |
| R3  | Save/cancellation and cross-shell behavior mislead users.                          | medium   | Cognia risk catalog; saveExport contract              | Cancel, error and saved states remain distinguishable.                                     | Cancel displays failure/success, or caller discards save outcome.                                 |
| R4  | Comparison mistakes broad format support for fidelity or invents missing features. | medium   | Primary documentation: Docling, Unstructured, Pandoc  | Findings distinguish implemented capabilities, explicit limitations and unverified claims. | Existing reachable implementation refutes a claimed gap.                                          |
| R5  | Untrusted input exhausts resources or crosses an unsafe rendering boundary.        | high     | STRIDE; fresh reviewers                               | Parser/resource boundaries and exported HTML are assessed with their actual callers.       | Unbounded expansion or unsafe content reaches a consumer; isolated utility alone is insufficient. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk | Method                                                                                                | Independence   | Evidence                                                                                                                                                                 | Coverage                                                                             | Status |
| --- | ---- | ----------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------ |
| V1  | R1   | Trace ingestion routes and run focused parser/caller tests plus adversarial real-file probes.         | tool           | Parsing probes executed with exit 0 and reproduced F2–F6; 185 scoped tests passed; Twin source path F1 disproves OCR reachability from staging.                          | Synthetic files and current source; no representative customer corpus or real IM.    | failed |
| V2  | R2   | Trace core and plugin writers; inspect actual outputs and run focused tests.                          | tool           | Export and rich-plugin probes exit 0 reproduce F8–F14; Unicode PDF rendered locally; 103 core tests pass, rich scope 76 pass / 1 fail.                                   | Synthetic serialization and PDF rendering; no Office GUI acceptance.                 | failed |
| V3  | R3   | Inspect save state propagation and platform adapters.                                                 | fresh-reviewer | SaveExport already has typed outcomes; Canvas collapses cancellation and error (F10).                                                                                    | Source and existing focused tests; no real devices.                                  | failed |
| V4  | R4   | Verify comparison against current official documentation and reconcile independent findings.          | fresh-reviewer | Three fresh reviewers completed; parent checked disputed boundaries and reran durable probes; current primary sources S1–S7 below.                                       | No unsupported claim that Office/PDF export, OCR, diagnostics or plugins are absent. | passed |
| V5  | R5   | Inspect limits, cancellation and unsafe content paths; use bounded probes where useful.               | tool           | F7 bounded ODS expansion and Canvas admission probe exit 0; F15 local theme breakout executes only a synthetic marker.                                                   | No exhaustion, macro execution, real exploit or external disclosure demonstrated.    | failed |
| V6  | R4   | Check proposal traceability, phase gates, architecture boundaries and independent adversarial review. | fresh-reviewer | F1–F15/G1–G6/S0–S6 and local links checked; two P2 proposal findings corrected and independently rechecked; Prettier passes; ledger final check has 0 errors/0 warnings. | Plan completeness only; does not discharge failed product obligations V1–V3/V5.      | passed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                             | Action   | Based on       | Reversal trigger                                                                            |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------- |
| D1  | 2026-11-18 | Audit current source and use small discriminating probes; no product changes.                                                                                        | diagnose | O1, G1, C1     | User requests implementation or source evidence changes task boundaries.                    |
| D2  | 2026-11-18 | Separate extraction, rich editing, serialization and delivery; classify conditional HTML input risk separately from conversation content.                            | diagnose | O1, H1, C1     | A caller or validation boundary invalidates a finding.                                      |
| D3  | 2026-11-18 | Stop discovery and deliver assessment; do not interpret passing smoke tests as lossless document support.                                                            | stop     | G1, C1, H1     | New customer fixtures or a request to implement changes.                                    |
| D4  | 2026-11-18 | Propose S0–S6 remediation using existing Blob ownership, parser/OCR, generation swap, plugin models and save boundaries; separate optional specialized PDF profiles. | diagnose | G2, O2, H1, C1 | Baseline drift, customer corpus or supported-shell requirements invalidate phase contracts. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                              | From   | Why still open                                                                         | Next action                                                                          | Status |
| --- | ------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| X1  | Ingestion defects and provenance/OCR gaps remain.                                     | V1, R1 | Remediation proposed; product implementation not requested in this planning follow-up. | Implement proposal S1/S4 with real-format behavioral regressions.                    | open   |
| X2  | Export fidelity and plugin losses remain.                                             | V2, R2 | Remediation proposed; one scoped DOCX test also fails.                                 | Implement proposal S2/S3/S5; isolate the existing failing test before attribution.   | open   |
| X3  | Real Web/Tauri/Capacitor save, IM and OCR provider acceptance is unmeasured.          | V3, R3 | This run used headless fixtures and source tracing.                                    | Run real-shell cancellation/save and scan/mixed-PDF acceptance after changes.        | open   |
| X4  | Resource exhaustion magnitude and theme trust-boundary exploitability are unmeasured. | V5, R5 | Only bounded local fixtures; no stress test or external attack path.                   | Enforce budgets and validate palette fields; separately test under process limits.   | open   |
| X5  | Customer-specific fidelity, speed and accessibility thresholds remain undecided.      | Q1, R4 | No workload corpus or priority supplied.                                               | Agree a corpus and separate extraction accuracy from document round-trip acceptance. | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                                    | How / when measured                                                                                                      | Result                                                                                                | Status |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------ |
| M1  | User receives a source-backed capability/gap assessment with concrete priorities and comparisons.         | Report, four rerunnable probe commands, source citations and primary-source comparison on 2026-11-18.                    | Assessment assembled; product defects intentionally remain unfixed.                                   | met    |
| M2  | User receives a complete phased repair and feature-completion proposal with explicit acceptance criteria. | F1–F15/G1–G6 mapping, S0–S6 gates, migration/recovery and real-environment acceptance; independent review on 2026-11-18. | Canonical proposal delivered; review and document checks passed. Product implementation remains open. | met    |

## Assessment

Cognia has broad format coverage and substantial document infrastructure. The primary gap is contract consistency: accepting a format, extracting correct content, preserving an editable document, generating a file, and delivering that file are separate promises. Current callers and validators sometimes treat those promises as equivalent. Several reproducible failures change numbers, page order, code layout or annotations while still returning complete/valid results.

The most urgent work is input/output correctness and visible loss reporting, followed by richer representations and corpus-based quality gates. Adding another parser or more file extensions alone would not address the observed failures. All priorities below are recommendations, not an accepted implementation plan.

### Existing capabilities

| Surface             | Present in current source                                                                                                                                                                 | Important boundary                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared parsing      | PDF, Word, Excel, CSV/TSV, HTML, RTF, EPUB, presentations, OpenDocument, Markdown/code/text/JSON; native PDF extraction with PDF.js fallback; optional worker-based AnyDoc legacy parsing | Supported extensions do not establish identical caller behavior or full semantic fidelity. `packages/document/src/support-matrix.ts`; `document-processor.ts`.                                                                                                                 |
| Structured reading  | Original/embedding text fields, chapters, page ranges, source segments, hashes, parse summaries and diagnostics                                                                           | Some consumers discard the richer envelope. `packages/document/src/types.ts:67–132`; package README.                                                                                                                                                                           |
| OCR                 | Local/cloud providers, page-wise PDF text-layer/OCR routing, progress and partial failures; chat retains original Blob                                                                    | Twin staging bypasses its downstream fallback. `packages/ocr/src/pdf-router.ts:66–81`; `lib/chat/attachments/pdf-ocr-fallback.ts:44`.                                                                                                                                          |
| Canvas              | File import, conversion warnings, raw source and visual/PDF exports                                                                                                                       | Import is a Markdown/text projection, not an Office editor. `lib/canvas/document-import.ts:126–155`.                                                                                                                                                                           |
| Chat/core export    | Markdown/text/JSON/JSONL, HTML variants, images, batch ZIP, core DOCX/PDF writer and shell-aware saving                                                                                   | Core writer supports a small Markdown subset; rich plugins have different models.                                                                                                                                                                                              |
| Word plugin         | Native DOCX import/export, headings/lists/tables, block comments, tracked changes, unsupported-feature warnings                                                                           | Inline runs, images, complex layout and other imported features are explicitly limited; table comment anchoring is defective. `plugins/cognia-documents/src/{model,docx,export-control}.ts`.                                                                                   |
| Spreadsheet plugin  | Typed cells, formulas, merge ranges, filtering/freezing, row/column sizes and partial styles                                                                                              | Formula recalculation and rendering depend on the output consumer; charts/pivots/drawings have explicit loss warnings, but some style losses are unreported. `plugins/cognia-office/src/{model,xlsx}.ts`.                                                                      |
| Presentation plugin | Native PPTX, text/shapes/images/tables/clustered-column charts, notes and several feature warnings                                                                                        | Mixed run formatting is not modeled faithfully. `plugins/cognia-presentations/src/{model,pptx}.ts`.                                                                                                                                                                            |
| PDF plugin          | Original-byte import/export, inspection, AcroForm filling, page selection/combination, OCR extraction and preview; signed/read-only mutation protection                                   | Distinct from generating text PDFs. No general body editing, redaction or signing API found. Validation does not certify PDF/A or tagged-PDF compliance. Original-byte export does not imply source tags are stripped. `plugins/cognia-pdf/src/{tools,pdf-engine,runtime}.ts`. |
| Delivery            | `saveExport` distinguishes saved/cancelled/error and implements web, Tauri and Capacitor paths; ZIP duplicate names are disambiguated                                                     | Caller state propagation and real-device delivery still need acceptance. `lib/files/save-export.ts`; `lib/export/batch/batch-export.ts`.                                                                                                                                       |

Four rich plugins are registered in the generated built-in catalog and their activation entry points. Passing activation tests establishes source wiring, not real three-shell startup acceptance. The PDF plugin explicitly requires its UI/Worker runtime for operations; headless availability must not be assumed.

### Findings

Evidence labels: **reproduced** means a small synthetic input was run through the actual relevant parser/serializer; **source-confirmed** means the reachable branch was traced but the real shell/provider was not exercised. P1 means high-impact correctness loss; P2 means a concrete functional/fidelity defect. Security observations without an external attacker-controlled path remain conditional.

#### F1 — P1: Twin file staging makes PDF OCR unreachable and loses provenance

**Source-confirmed.** The current add-source UI calls `stageFile` (`components/twin/add-source/source-inputs.tsx:96`). Binary staging parses immediately, rejects empty extracted text, then stores only the extracted/embedding text with `format: "markdown"` (`lib/twin/ingest/stage.ts:287–309`). Commit writes `item.text` (`stage.ts:597–609`); the worker reloads only text (`lib/twin/worker-runtime.ts:16–21`). The downstream PDF OCR fallback requires both PDF format and raw binary (`lib/twin/ingest/ocr-fallback.ts:46`).

Consequences for this upload path: scanned PDFs are rejected before OCR; scanned pages in mixed PDFs are not recovered; original page structure and reprocessing bytes are not retained by this flow. This is a caller wiring/persistence defect, not evidence that Cognia lacks OCR. Two existing filtered tests explicitly pin the current conversion/rejection behavior. Real UI/provider acceptance remains open.

#### F2 — P1: Excel extraction silently rounds values to two decimals

**Reproduced.** `packages/document/src/parsers/office-parser.ts:442` applies `toFixed(2)` to non-integers. A real generated XLSX containing `0.00012345` and `1.23456789` yields `0.00` and `1.23` in `content`/`embeddableContent`, while quality is `complete`.

The precise values still exist in `sourceSegments`, so the entire parsed result is not irrecoverably rounded. However, project knowledge persists the rounded content (`components/shell/workspace-knowledge-section.tsx:161–175`) and chunks it (`lib/project-knowledge/ingest/ingest-file.ts:108`); Twin staging also persists the text projection. Store exact scalar values separately from display formatting and test the actual ingest consumer.

#### F3 — P2: HTML/CSV string inputs bypass their dedicated parsers

**Reproduced plus caller trace.** The async string fast path excludes several binary formats but not HTML/CSV (`packages/document/src/document-processor.ts:303–308`); the sync implementation handles them as generic text. Chat dispatch (`lib/chat/attachments/dispatch.ts:395–403`), Canvas import (`lib/canvas/document-import.ts:195–199`) and project upload (`components/shell/workspace-knowledge-section.tsx:111–116`) supply strings for these formats.

Both probes returned `parser: "text"`, no `parseResult`, and no diagnostic. HTML script source and markup remained in embedding text instead of being processed as document content. This is content contamination/structure loss; the probe does not establish script execution in chat. Route by detected format independently of the input container type.

#### F4 — P2: IM text attachments fail when passed as ArrayBuffer

**Reproduced plus caller trace.** `.txt` bytes produce `No parser is configured for recognized document type 'text'.` The same default-switch mismatch affects recognized textual formats such as Markdown/JSON/code XML (`packages/document/src/document-processor.ts:639`). The shared IM extractor always passes ArrayBuffer (`lib/connectors/adapters/_shared/inbound-media.ts:229–233`) and its caller replaces extraction failure with empty text (`inbound-media.ts:406`).

The chat path's string decoding avoids this particular failure. The fix needs a format × payload-kind × consumer matrix, not a TXT-only exception. No real external IM message was sent in this audit.

#### F5 — P2: ODS empty and value-only cells disappear, shifting coordinates

**Reproduced.** The cell regex only consumes explicitly closed `table:table-cell` nodes and derives values only from `text:p` (`packages/document/src/parsers/open-document-parser.ts:224–236`). A row with `A1`, a self-closing empty B1, and `C1` becomes `["A1", "C1"]`; a value-only float cell containing `office:value="3.14159"` disappears before the following B2 text. The consumer can therefore associate a value with the wrong column.

Preserve self-closing/covered cells, repeat semantics and typed ODF values. This is structural correctness, not a request for visual spreadsheet fidelity.

#### F6 — P2: PPTX extraction uses package filenames instead of slide order

**Reproduced.** `packages/document/src/parsers/presentation-parser.ts:40–59` sorts `slideN.xml` numerically rather than following `presentation.xml` relationship order, and omits slides without text. A three-slide fixture ordered `slide2 → slide1 → slide3` produced `slide1 → slide2`, counted two slides, and reported `complete`. Slide locators now refer to the wrong user-visible order.

Read the presentation relationship list, retain empty/image-only slide positions, and report non-text content limitations. The separate rich presentation plugin is not the same parser.

#### F7 — P1 hardening: parsing budgets and input admission vary by entry point

**Bounded reproduction plus source inference.** ODS repeated rows/columns use uncapped numeric loops (`open-document-parser.ts:209–236`). A 718-byte archive expands to 10,000 rows and passes the existing ZIP admission check. This bounded probe establishes expansion, not a measured OOM incident. Much larger/non-finite repetition attributes are unchecked in source.

`ProcessingOptions.maxFileSize` is not enforced by the shared processor: a 37-character input is accepted with `maxFileSize: 2`. Canvas reads and parses directly without the upload-commit inspection boundary (`lib/canvas/document-import.ts:186–199`). An inert macro-name fixture is rejected by `inspectUploadContent` but reaches an injected Canvas parser; no macro is executed.

Existing protection must be preserved: upload commits enforce ZIP count/size/ratio and content rules (`lib/security/upload-content-inspection.ts:18–21,391`; `lib/db/session-attachment-uploads.ts:385`), chat has size caps, and AnyDoc has queue/input/time limits. The missing capability is common parser admission plus expanded rows/cells/pages/output budgets and cancellation, not a total absence of safety checks. Do not market this as demonstrated remote code execution.

#### F8 — P1: generated text PDFs visibly corrupt CJK and emoji

**Reproduced and rendered.** The core writer creates default jsPDF and uses Helvetica/Courier without Unicode font registration (`lib/files/document-writer/index.ts:60–75,90–92`). Real PDF.js extraction and a local rendered PNG both show corruption of Chinese/Japanese/emoji while ASCII remains readable. This is not only a text-extraction mapping issue.

Reachable from document/code Artifact PDF export (`hooks/artifacts/use-artifact-panel.ts:417` → `lib/artifacts/export/pdf.ts:100`) and Markdown Canvas. The separate PDF plugin's original-byte export is outside this finding. Local artifacts: `.cache/document-export-adversarial/unicode.pdf` and `unicode.png`.

#### F9 — P2: Canvas advertises PDF for code documents but cannot execute it

**Reproduced dispatch.** `getCanvasExportFormats` falls back to code and offers `["raw", "pdf"]` (`lib/canvas/document-export.ts:72`). Export requires a visual projection and returns null for Python/JSON (`document-export.ts:142`). The synthetic caller probe confirms neither reaches the artifact exporter; Markdown does. UI route: `components/canvas/canvas-side-panels.tsx:329` → `canvas-export-menu.tsx:113`.

Use the same capability/execution resolver and preserve raw code document semantics; adding an item to a menu is not completed export support.

#### F10 — P2: Canvas collapses cancel/error states and misreports failures

**Source-confirmed.** Export returns null for cancellation and errors (`document-export.ts:153,175`); the menu shows `renderFailed` for every PDF/PNG null but no failure feedback for raw/html/svg (`components/canvas/canvas-export-menu.tsx:79`). The document rail similarly only handles success (`canvas-document-rail.tsx:208`). The underlying save API already provides distinct outcomes.

Propagate the typed outcome to the caller: quiet cancellation, actionable save failure and distinct render failure. Native dialog behavior has not been exercised in this audit.

#### F11 — P2: core Word/PDF export flattens rich content and code layout

**Reproduced.** The core model has four block types and emits only paragraphs/text runs (`lib/files/document-writer/blocks.ts:7`; `index.ts:41`). A rich DOCX fixture produced zero native tables, images and hyperlinks; Markdown table rows became one paragraph. Inline emphasis remains literal by design, but the Download as Word flow does not present that fidelity boundary (`components/artifacts/artifact-panel-content.tsx:373`; `hooks/artifacts/use-artifact-panel.ts:403`).

More concretely, the actual code Artifact PDF path passes unfenced source as Markdown (`lib/artifacts/export/pdf.ts:100`); trimming/joining (`blocks.ts:27,73`) turns three indented Python lines into `def calculate(): value = 42 return value` in the generated PDF. Use a code-aware writer input rather than inferring document semantics from plain strings.

Fenced DOCX code also lacks explicit Word line-break nodes in the inspected XML; native Word appearance remains unverified and is not counted as a separate confirmed visual defect. Rich plugins offer stronger models, so do not claim all DOCX/PPTX/XLSX exports are flat text.

#### F12 — P2: DOCX table comments lose their anchor

**Reproduced.** `addComment` allows a table block (`plugins/cognia-documents/src/model.ts:437`), but the table renderer returns before the comment-anchor path (`docx.ts:272,318`). The comment body survives in comments.xml with zero anchors. Reimport attaches the unanchored comment to the first block (`docx.ts:147–161`). A table comment moved to the introductory paragraph while model validation returned no issues and `validateDocxRoundTrip.valid` was true.

Validate relationships and semantic anchors, not merely successful reopening and extracted text.

#### F13 — P2: XLSX style enrichment can fail silently; loss detection is incomplete

**Reproduced with control.** A normal generated worksheet with no explicit view reopens in ExcelJS with `views=null`. `worksheet.views.find` throws (`plugins/cognia-office/src/xlsx.ts:71`); the broad catch at 85 aborts enrichment for the whole workbook. Bold styling is lost during import/export with `unsupportedFeatures=[]`. Adding only `views=[{state:"normal"}]` preserves bold.

Separately, even the control drops font name/size/underline, borders and rotation from the model (`xlsx.ts:92–125`) without loss warnings. Feature detection focuses on package parts (`xlsx.ts:354–411`), so the export confirmation gate (`runtime.ts:270`) is not triggered for these attributes. Fix the null-view bug independently of deciding which richer styles to support.

#### F14 — P2: PPTX mixed run formatting disappears without a warning

**Reproduced.** Import concatenates runs and takes the first run's size/bold (`plugins/cognia-presentations/src/pptx.ts:223–243,418`). Two runs—Alpha 18pt bold and Beta 36pt italic—become one 18pt bold run; Beta's styling disappears. `importedFeatures=[]` and `validatePptxRoundTrip.valid=true`, so the lossy-export confirmation condition (`runtime.ts:158`) is not reached.

Either model inline runs or detect and report their loss. This is independent of F6's extraction order bug.

#### F15 — conditional hardening: custom theme values can escape exported style

**Reproduced only for an explicitly supplied palette.** A palette value containing a closing style tag and a local marker script executes in the resulting standalone HTML under jsdom. Source: `lib/export/html/beautiful-html.ts:67,150`; local palette editor `components/data/export/custom-theme-editor.tsx:125–135` and persistence `stores/theme/custom-theme-store.ts:43` accept arbitrary strings.

No external attacker-controlled palette route was established. Ordinary conversation text uses safe Markdown/HTML conversion, so this is not evidence of chat-content XSS. Validate palette fields as colors and prevent style-context termination. Treat this below the confirmed content-loss defects unless an untrusted theme-import route is established.

### Further candidates and limits

- DOCX metadata extraction regex scans decoded ZIP bytes rather than reading `docProps/core.xml` (`packages/document/src/parsers/office-parser.ts:176`). A real generated ZIP contains title/author in core XML but the regex does not find them. Full browser Mammoth-path validation remains open.
- Pure-Chinese conversation titles can collapse to the same `conversation.*` filename (`lib/export/single/index.ts:57,139`); Capacitor uses a fixed save path (`lib/files/save-export.ts:111`). Collision is source-derived; actual device overwrite behavior was not tested. Batch ZIP already disambiguates duplicate filenames.
- PDF/A, tagged-PDF/accessibility, signing and redaction are not established product guarantees. The PDF plugin has signature-preservation guards, not cryptographic signing/verification. Existing input PDF tags may survive original-byte export.
- No representative customer document corpus, benchmark accuracy score, latency/peak-memory measurement, real provider comparison, Office client acceptance or three-shell end-to-end acceptance was performed.

### Comparison with current primary-source practices

These are design practices worth adopting, not a claim that any one tool universally outperforms Cognia. Research was checked on 2026-11-18; no user documents were sent to these services.

| Practice                                                 | External evidence                                                                                                                                                                                                                                                                                            | Cognia assessment and recommended increment                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical semantic document plus provenance              | Docling models text/tables/pictures, hierarchy, furniture, layout boxes and provenance; reading order belongs to its document tree. [S1](https://docling-project.github.io/docling/concepts/docling_document/)                                                                                               | Existing ProcessedDocument/structure/sourceSegments are a strong base. Preserve them through ingestion; add typed cells, inline runs and asset references where needed. Keep source bytes/hash, parsed representation and export projection distinct.                                             |
| Explicit routing and quality escalation                  | Unstructured exposes format-specific partitioning and PDF strategy selection; Docling quality grades can route low-quality documents for review. [S2](https://docs.unstructured.io/open-source/core-functionality/partitioning), [S3](https://docling-project.github.io/docling/concepts/confidence_scores/) | Chat already has page OCR fallback. Reuse it across consumers, report per-page omissions and let callers request reprocessing. Do not label nonempty output complete by default. Docling's own table confidence is documented as not yet implemented; do not treat grades as ground truth.        |
| Preserve complex tables structurally                     | Azure Document Intelligence emits HTML tables with rowspan/colspan, captions and table footnotes. [S4](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/markdown-elements?view=doc-intel-4.0.0)                                                                             | Keep typed values, cell coordinates/spans and captions. Derive Markdown for display/RAG; avoid making flattened strings the only persistent representation. Azure is also already an OCR-provider option in Cognia, so the question is end-to-end use of structure, not merely adding a provider. |
| Reader → intermediate model → writer, with explicit loss | Pandoc separates readers/AST/writers and documents that conversion can be lossy. Its reference documents configure styles, page properties and other document presentation. [S5](https://pandoc.org/MANUAL.html)                                                                                             | Unify or bridge core and plugin export models. Add capability/loss reports and reference styles/templates. Do not promise universal lossless round trips; validate the supported subset semantically. No recommendation to embed a new heavyweight engine before measuring existing routes.       |
| Bounded processing                                       | Docling documents file/page/pixel and archive expansion limits, including limits while reading decompressed members. [S6](https://docling-project.github.io/docling/usage/advanced_options/)                                                                                                                 | Reuse existing upload inspection and AnyDoc controls. Extend admission to every document entry and budget expanded cells/pages/output and execution time. A compressed-byte cap alone does not bound ODF repetition.                                                                              |
| Quality measured by document task                        | OmniDocBench evaluates text, tables, formulas and reading order separately. [S7](https://github.com/opendatalab/OmniDocBench)                                                                                                                                                                                | Add a pinned bilingual corpus plus application-specific numeric/anchor tests. Benchmark parsing separately from export/round-trip fidelity and save reliability; passing mocked parser tests is not an accuracy metric.                                                                           |

### Proposed order and acceptance criteria

| Order | Scope                                                                                                                                                          | Acceptance evidence                                                                                                                                                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | F1–F4, F7–F10: OCR reachability, exact numeric content, consistent payload routing, bounded processing, Unicode PDFs, reachable exports and typed save results | Same fixtures through each actual consumer; scanned/mixed PDF original retained and OCR executed; precision retained; CJK renders and is extractable; cancel/error/saved distinguished on real shells.                                                                                                                                                           |
| 2     | F5–F6, F11–F14: structural fidelity and complete loss reporting                                                                                                | Correct ODS coordinates and PPTX visible order; code whitespace, tables, images/links and comment anchors checked after real-file round trip; unsupported features always produce explicit losses.                                                                                                                                                               |
| 3     | Shared document envelope and quality reports                                                                                                                   | One parse identity/version/config, original source hash, preserved assets/provenance, per-element/page diagnostics; menu support and execution derive from the same capability contract.                                                                                                                                                                         |
| 4     | Corpus and delivery acceptance                                                                                                                                 | Start with 20–30 small curated bilingual documents: scans, mixed/multi-column PDFs, precision/merged/formula sheets, reordered/image-only slides, comments/revisions, CJK/code/math, encrypted/truncated and bounded adversarial inputs. Track text error, table structure, reading order, exact scalar/anchor fidelity, latency, peak memory and save outcomes. |
| 5     | Product-dependent additions                                                                                                                                    | Decide whether to prioritize office-layout/template fidelity, academic math/citations, form extraction, archival/accessibility compliance or high-volume jobs. Q1 remains open; these are not all mandatory for every workload.                                                                                                                                  |

### Verification and review record

Environment: macOS workspace, Node v26.12.1, pnpm 11.18.0. Baseline HEAD at start: `b50c5c9501263e3abf20f5792c98756cdc675687`. The checkout has many concurrent edits outside the audited scopes. Scoped status for the parser/core writers/rich plugins was clean when sampled; findings refer to checked-out source, not a released build. CodeGraph reported no index, so navigation fell back to `rg` and source reads.

- Parsing scope: 5 Jest suites, **185 tests passed**. Twin staging filter: **2 passed / 41 skipped**.
- Core export scope: 7 Jest suites, **103 tests passed**.
- Rich plugin scope: **6 suites passed / 1 failed; 76 tests passed / 1 failed**. `plugins/cognia-documents/src/docx.test.ts:472`, “does not report reconstructed layout, tables, list definitions, and styles as lost”, expected `[]`, received `["custom-numbering"]`. No product edit was made by this audit; the failure has not been attributed on an isolated clean checkout.
- All four durable probe commands in [the probe README](./2026-11-18-document-parsing-export-gap-audit.probes/README.md) executed with exit 0. They reproduce defects or print evidence; they are not passing product acceptance tests. The export probe substitutes save side effects, logging and its unused raster branch; the text serializer and parsing libraries are real.
- Three independent fresh-context reviewers covered parsing, core exports/delivery and rich plugins. Parent reran durable probes and inspected owning source. The PDF image was inspected locally. The theme claim was narrowed to user-controlled palettes; precise XLSX values in sourceSegments, existing loss warnings, source-preserving PDF export and existing OCR/safety controls were retained as counterevidence.
- Optional cross-model review was offered as required by the chosen doubt-driven skill; no external CLI review ran. No additional permission was inferred from lack of a response.
- No coverage run, full application build, whole-repository lint/typecheck, real browser/native UI session, Office-client run or real OCR-provider request was performed. This change adds only audit documentation and reproducible probes, not product implementation. Report/probe formatting and ledger validation are checked separately.

### Focused test commands

```sh
rtk proxy pnpm test --runInBand packages/document/src/document-processor.test.ts packages/document/src/parsers/office-parser.test.ts packages/document/src/parsers/presentation-parser.test.ts packages/document/src/parsers/open-document-parser.test.ts lib/twin/ingest/ocr-fallback.test.ts
rtk proxy pnpm test --runInBand lib/twin/ingest/stage.test.ts -t 'stages binary formats|flags binary files with no extractable text'
rtk proxy pnpm test --runInBand --runTestsByPath lib/files/document-writer/index.test.ts lib/files/document-writer/blocks.test.ts lib/canvas/document-export.test.ts lib/files/save-export.test.ts lib/export/html/beautiful-html.test.ts lib/export/batch/batch-export.test.ts components/canvas/canvas-export-menu.test.tsx
rtk proxy pnpm test -- --runInBand --runTestsByPath plugins/cognia-documents/src/docx.test.ts plugins/cognia-office/src/xlsx.test.ts plugins/cognia-presentations/src/pptx.test.ts plugins/cognia-documents/src/index.test.ts plugins/cognia-office/src/index.test.ts plugins/cognia-presentations/src/index.test.ts plugins/cognia-pdf/src/index.test.ts
```

The audit is delivered; remediation and real-environment acceptance remain open. The ledger intentionally remains `verifying`, not `closed`, because the user has not accepted the product risks in X1–X5.
