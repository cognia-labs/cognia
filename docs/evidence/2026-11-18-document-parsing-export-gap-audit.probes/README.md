# Document parsing/export audit probes

Run from the repository root using installed workspace dependencies:

```sh
rtk proxy pnpm exec tsx docs/evidence/2026-11-18-document-parsing-export-gap-audit.probes/parsing.ts
rtk proxy pnpm exec tsx docs/evidence/2026-11-18-document-parsing-export-gap-audit.probes/resource.ts
rtk proxy pnpm exec tsx docs/evidence/2026-11-18-document-parsing-export-gap-audit.probes/rich-plugins.mts
rtk proxy node docs/evidence/2026-11-18-document-parsing-export-gap-audit.probes/export.mjs
```

These are audit reproductions, not product regression tests. Some assert the observed defective behavior, so exit 0 means the probe executed and reproduced its assertions; it does not mean the product is correct. Parsing probes print actual results for inspection. All fixtures are synthetic and stay local. Resource expansion is bounded to 10,000 cells; no destructive exhaustion test runs.

The export probe uses real jsPDF, docx, PDF.js, Mammoth, JSZip and a local PDF renderer. It substitutes save/export side effects, logging and the unused raster branch; the actual text Artifact PDF branch runs. Canvas checks demonstrate dispatch, not a real native save. It writes generated documents, rendered PNG, JSON results and a locally authored HTML fixture under `.cache/document-export-adversarial/`. The HTML script is an inert local marker; this is not proof that conversation text controls a theme field. Resource admission uses an inert macro-name fixture and an injected parser to inspect routing only; no macro executes.

The rich-plugin probes use real ExcelJS, DOCX and PPTX package serialization, but do not launch Office clients. The main evidence ledger records source scope and limitations.
