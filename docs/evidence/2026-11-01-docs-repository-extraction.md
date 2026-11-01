# Documentation repository extraction evidence

Date: 2026-11-01

## Delivered boundary

- Independent repository: https://github.com/cognia-labs/cognia-docs.
- Source baseline: cognia origin/dev at be4e03e4f856c55f3a211282ce51ca1fd1390a86. The extraction excludes unpublished commits and unrelated changes in the parallel working tree.
- The filtered repository retains 442 historical commits before its independent bootstrap. History was scanned with Gitleaks before publication and after bootstrap; no leaks were found.
- ADRs, OpenAPI/AsyncAPI, generated SDK reference and development/research/plan/report/evidence/runbook sources stay in cognia. A retained-source inventory checked 1,329 files with no missing files. The bilingual macOS virtual-display ADR moved from the duplicated 0242 identifier to 0251; the docs export preserves the old HTML and Markdown redirects.
- The site contains 487 immutable ADR/reference publication records pinned to cognia commit 93ac2ee9dd6c4bb98e0b8677009a284873b15809. Imported page links point to that exact source revision. Product guides and site translations are owned locally by cognia-docs.
- The application consumes artifacts/support-docs.json and artifacts/doc-pages.json from the committed docs revision recorded in integrations/cognia-docs.json. SHA-256, schemas, bilingual entries and page URLs are checked offline. Explicit sync reads one immutable Git revision, even if HEAD changes during the operation; uncommitted producer edits are ignored.

## Independent docs verification

Local frozen-lockfile install, peer checks, formatting, lint, strict typecheck, publication integrity, deterministic artifact checks, ADR catalog and documentation link checks passed. Jest: 19 suites and 106 tests passed. Node script tests: 35 passed. All 12 desktop/mobile Chromium journeys passed in CI. The exported guide screenshot was downloaded and visually inspected: the page, sidebar, table of contents, controls and typography render correctly.

The GitHub CI performs its own clean installation and full static production build, then browser journeys, a real Wrangler Pages runtime smoke check and export artifact upload:

- https://github.com/cognia-labs/cognia-docs/actions/runs/41306287648 — clean install, complete quality checks, production build and all 12 browser journeys passed. Pages startup exposed an unsupported compatibility date; corrected by sharing a pinned Wrangler configuration for preview and deployment.
- https://github.com/cognia-labs/cognia-docs/actions/runs/41306858996 — passed end to end: clean install, format/lint/types, 35 script tests, 106 Jest tests, full production export, 12 Chromium journeys, actual Pages redirects/assets/search smoke, packaged export and browser diagnostic uploads.
- https://github.com/cognia-labs/cognia-docs/actions/runs/41305030911 — staging deployment dry run passed. This verifies the missing-configuration report and performs no upload.

The browser matrix covers localized home/guide/shared pages, page ownership, Markdown/language links, compressed search, custom 404, legacy ADR redirects, sitemap, robots and LLM output. Pages smoke uses the actual exported search Worker and compressed index. The static preview refuses a missing or stale deployed Worker rather than masking the export with an unrelated source copy.

The full-mode changed-file 90% CI gate is retained. No local coverage command was run.

## Main consumer verification

- Full pnpm lint passed.
- Support Agent and repaired baseline registry suite: 3 Jest suites, 121 tests passed. Support citations assert the exact producer commit.
- Publication validator/sync, links, CI impact/planner and workflow contracts: 110 Node tests passed.
- pnpm i18n:build:check, pnpm lint:i18n and pnpm i18n:sort:check passed after removing the site-only namespaces.
- pnpm docs:check --docs-root /Users/bytedance/Project/cognia-docs, pnpm audit:adr-catalog and pnpm audit:docs-links passed.
- Retained-source inventory and git diff --check passed.

The isolated worktree reuses installed dependencies through ignored links and runs pnpm with verify-deps-before-run=false to avoid reinstalling into the parallel worktree's node_modules. This changes no source or gate policy. next typegen generated ignored route/image type declarations before the final typecheck.

### Baseline limitations

Full pnpm typecheck fails with six diagnostics in unchanged baseline sources:

1. components/settings/security/outbound-authorization-card.test.tsx:305: missing integration fixture.
2. hooks/automation/use-sandbox-desktop.test.ts:62: missing NativeFrameStream.input fixture.
3. lib/account-sync/data/tables.ts:181: missing programmaticCreator field policy.
4. lib/sandbox/session-runtime.test.ts:173, 242, 262: operationsQualified is not part of the narrowed Docker configuration.

Each diagnostic owner and its relevant type definition were checked byte for byte against the published baseline. No diagnostic points at the extraction's changed application code. The typecheck stops before the downstream sidecar check, so a full typecheck or main-app production build is not claimed.

pnpm lint:static-export reports 14 Node-only imports in packages/agent-codebuff/src/native-process.ts, packages/agent-codebuff/src/node-bridge.ts and packages/agent-crush/src/node-bridge.ts. These files and the gate itself match the baseline byte for byte. The gate and its policy were not weakened.

A separate prerequisite test fix restores the missing registerAuthenticationProvider import and removes the accidental comma expression around describe. It reproduced as ReferenceError before repair, then all 121 focused tests and full lint passed. No plugin production behavior was changed.

Main migration review: https://github.com/cognia-labs/cognia/pull/4 (draft). The new repository is published; the main switch remains reviewable until cutover.

## Deployment remaining

The independent repository has staging and production GitHub environments and a manual serialized Pages deployment workflow. Its guard validates configuration before dependency installation, requires a public HTTPS docs origin, and never prints secrets.

Actual upload remains blocked by missing DOCS_SITE_URL, CLOUDFLARE_ACCOUNT_ID, CF_DOCS_PAGES_PROJECT and the environment secret CLOUDFLARE_API_TOKEN. WEB_SITE_URL is optional. No working Cloudflare session or transferable configuration was found. The dry run does not establish a real upload, public DNS, custom-domain routing or production availability. Configure the environments and dispatch staging before the final production cutover.
