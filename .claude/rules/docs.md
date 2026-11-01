---
paths:
  - "docs/**"
---

# Documentation ownership

- The Fumadocs site and product guides live in https://github.com/cognia-labs/cognia-docs. Follow that checkout's AGENTS.md; do not recreate site code or public guide folders here.
- ADRs remain under docs/content/docs/{en,zh}/adr/. API contracts, plans, research, reports and evidence stay here. Preserve bilingual ADR catalogs and use a unique sequential identifier.
- The docs site imports ADRs and generated reference as committed, read-only snapshots. Normal app builds consume pinned local corpus/page-index artifacts and require no sibling checkout.
- Run pnpm docs:check, pnpm audit:adr-catalog and pnpm audit:docs-links here. Run pnpm check and Pages/browser verification in the standalone docs checkout.
