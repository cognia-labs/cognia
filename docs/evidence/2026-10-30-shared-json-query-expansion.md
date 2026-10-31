# Evidence ledger: shared JSON and keyword expansion

- Status: verifying
- Lane: standard
- Created: 2026-10-30
- Updated: 2026-10-30
- Related: ADR-0068; ADR-0115

## Original request

> 继续治理 JSON 提取和查询扩展的重复实现，统一到合适的公共模块，补齐共享行为测试，并清理旧实现和死代码。

## Knowledge

| ID  | Statement                                                                                                                         | State    | Basis                                                                                                                                                                   | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Memory/eval JSON extraction and memory/app keyword wrappers have identical implementations.                                       | Verified | Source comparison and characterization tests, 2026-10-30. Existing 5 suites / 98 tests passed; expanded shared fixtures: 2 suites / 49 tests passed before refactoring. | -          |
| G1  | One implementation per capability, real shared behavior tests, no obsolete implementation or private orphan wrapper.              | Agreed   | User request, 2026-10-30.                                                                                                                                               | -          |
| C1  | Preserve first-candidate/fence parsing behavior, errors, synonym order and query formatting. Preserve published package subpaths. | Observed | Existing implementation and characterization matrix, 2026-10-30.                                                                                                        | -          |
| C2  | Portable lower-layer modules must not import app state, network, model generation or evaluation domains.                          | Observed | ADR-0068 and ADR-0115; existing package boundaries.                                                                                                                     | -          |

## Problem frame

Satisfy G1 and C1 by moving JSON extraction to primitives and deterministic lexical expansion to RAG. The new extract-json module is necessary because primitives has no existing parser module and evaluation is not the owner of a domain-neutral parser. The new keyword-expansion module is necessary to keep local lexical retrieval independent of the generation/logging imports in the mixed RAG query-expansion module. Retain public memory/eval/RAG subpaths as re-exports. Migrate app/internal callers, then delete the private app keyword wrapper; move its behavioral tests rather than dropping them. No parser robustness or synonym-policy redesign is included.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                    |
| ------------ | ------ | ---------------------------------------------------------------------------------------------- |
| scale        | medium | Two shared modules, compatibility exports, call sites, tests and dependency metadata.          |
| technical    | low    | Relocate existing code and reuse existing source-package patterns.                             |
| coupling     | medium | Public package subpaths and compiled eval/memory delivery must continue working.               |
| requirement  | low    | Characterized behavior; no new matching or parsing semantics requested.                        |
| verification | low    | Deterministic fixtures, consumer regressions, type checks and package builds.                  |
| risk         | medium | Incorrect JSON could affect evaluation or learned memory; query changes could alter retrieval. |

## Risks

| ID  | Risk (impact)                                            | Severity | Source               | Claim                                                                                                           | Refuted by                                                                                 |
| --- | -------------------------------------------------------- | -------- | -------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| R1  | Parsing or retrieval semantics silently change.          | medium   | O1; characterization | Both old package entries and canonical entries preserve values, errors and exact query strings.                 | Shared fixtures or consumer regressions differ after relocation.                           |
| R2  | Layering or built delivery breaks.                       | medium   | ADR-0068; ADR-0115   | JSON parser is dependency-free; keyword entry has no generation dependencies; builds retain compatible exports. | Browser closure gains I/O/model dependencies or built subpath smoke fails.                 |
| R3  | Duplicate implementations/private orphan imports remain. | low      | G1                   | Only one parser and one keyword wrapper implement these contracts.                                              | Final source/import search finds old function bodies or callers to the removed app module. |

## Verification obligations

| ID  | Risk   | Method                                                                  | Independence | Evidence                                                                                                                                                                                                                                                                                                                                                                           | Coverage                                                                                                                                      | Status |
| --- | ------ | ----------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1     | Shared real-behavior fixtures and existing consumer tests before/after. | tool         | Before: 5 suites / 98 tests; new shared characterizations: 2 suites / 49 tests. After: 6 focused suites / 158 tests; expanded pnpm test for primitives/RAG/memory/eval-core/Twin: 124 suites / 1923 tests passed.                                                                                                                                                                  | Nested/fenced JSON, strict errors, lexical order/casing/whitespace/CJK/dedup; actual extractors, scorers and Twin BM25 integration.           | passed |
| V2  | R2     | Package typechecks, scoped lint, builds and built JSON subpath smoke.   | tool         | Four package typechecks and both Eval/Memory builds passed. Scoped ESLint and Prettier passed. Six compiled parser entries (Eval JSON, Memory parser and llm barrel, each ESM/CJS) passed in an external temporary consumer without node_modules. Logs: .cache/json-query-typecheck.log, json-query-build.log, json-query-delivery.log.                                            | Source types, declared primitives dependency, compiled parser packaging and failures; not standalone delivery of the entire Memory/RAG graph. | passed |
| V3  | R2, R3 | Browser dependency closure and final scoped diff/import search.         | tool         | Static audit built browser bundles: parser 1095 bytes and lexical module 4926 bytes, each one source input. Wiring and PII audits found no issues. Package-boundaries/SDK-standalone gates passed. AST comparison: all 5 relocated function bodies unchanged. Source search: no deleted app-wrapper imports; one canonical parser/keyword implementation. git diff --check passed. | Pure entries, unchanged outbound gates, reachable live consumers and retained package compatibility exports.                                  | passed |

| V4 | R2 | Repository-wide lint and typecheck. | tool | pnpm lint failed at mobile/scripts/android.test.mjs:605 (no-assign-module-variable). pnpm typecheck failed in managed-desktop-handoff.test.tsx, use-sandbox-desktop.test.ts and remote-desktop/native-stream.ts. Logs: .cache/json-query-lint.log and json-query-root-typecheck.log. | Broader repository checks; all reported files are outside this task and concurrently edited. | failed |

## Decisions

| ID  | Date       | Decision                                                                                                                     | Action    | Based on       | Reversal trigger                                                                 |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | -------------------------------------------------------------------------------- |
| D1  | 2026-10-30 | Put JSON in primitives and deterministic expansion in a pure RAG module; preserve package exports as compatibility forwards. | implement | O1, G1, C1, C2 | A public signature changes or the portable path acquires app/model dependencies. |

## Residual risks

| ID  | Residual | From | Why still open | Next action | Status |
| --- | -------- | ---- | -------------- | ----------- | ------ |

| X1 | Repository-wide gates remain blocked by unrelated mobile/remote-desktop diagnostics. | V4 | Concurrent work is outside this task; scoped checks are passing. | Owning workstreams fix the mobile lint error and three remote-desktop type errors, then rerun full gates. | open |

## Outcome

| ID  | Signal                                                                | How / when measured                                                                   | Result                                                                                                                                      | Status |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Existing consumers use shared implementations with unchanged outputs. | Shared fixtures, 1923 consumer/package tests and compiled parser smoke on 2026-10-30. | Passed; both capability families share canonical implementations with preserved values and failures.                                        | met    |
| M2  | Duplicate bodies and the private app wrapper are removed.             | Final import search, AST comparison, wiring audit and diff.                           | One parser in primitives, one keyword builder in RAG; private app wrapper removed; original app assertions moved into the shared RAG suite. | met    |

## Delivery notes

- Existing package public JSON/query entry points remain forwarding modules. The private app wrapper has no consumers and was removed along with its old test path; its assertions were retained in the new RAG shared suite.
- The memory keyword tests now use the real synonym engine, preserving user-visible assertions instead of a mocked implementation seam.
- Eval-core declares primitives as a dependency; a frozen offline filtered install completed successfully. Existing Adapter lockfile edits and all other concurrent work were preserved.
- Source-only primitives are bundled into Eval and Memory JS/CJS. The shared lexical module imports nothing; model generation remains in the existing mixed RAG module.
- No coverage command, commit, publication, live provider call or UI change was part of this task.
