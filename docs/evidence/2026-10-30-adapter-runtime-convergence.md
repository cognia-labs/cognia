# Evidence ledger: adapter runtime convergence

- Status: verifying
- Lane: standard
- Created: 2026-10-30
- Updated: 2026-10-30
- Related: ADR-0217; packages/agent-runtime-kit; packages/plugin-sdk

## Original request

> 先治理两套 Adapter，补上共享行为测试，修复 usage 和 artifact 的分叉，再收敛公共逻辑，清理死代码

## Knowledge

| ID  | Statement                                                                                                                     | State    | Basis                                                                                                                                                           | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | SDK drops detailed usage and artifacts, unlike runtime-kit.                                                                   | Verified | Local event probes and shared Jest RED run on 2026-10-30: 7 failed, 16 passed; SDK usage/artifact/refusal failures and runtime-kit message-ID override failure. | -          |
| G1  | Both public adapters use one collection implementation and pass identical behavioral expectations.                            | Agreed   | User request, 2026-10-30.                                                                                                                                       | -          |
| C1  | Keep SDK public createSession and void cancel signatures, protected helpers, and host-independent browser-compatible imports. | Observed | SDK source, ADR-0217, runtime-kit subpath and neutral build configuration, 2026-10-30.                                                                          | -          |

## Problem frame

Fix O1 by satisfying G1 while preserving C1. Consolidate the SDK base through the existing runtime-kit base rather than creating another module. Keep SDK-specific protocol availability helpers. Remove only superseded SDK implementation and the unused runtime-kit event buffer. No provider, shell, persistence, or protocol redesign is needed. Extend the existing SDK test file so the same event fixtures exercise both public entry points; the only new documentation file is this required evidence ledger.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                               |
| ------------ | ------ | ----------------------------------------------------------------------------------------- |
| scale        | low    | Two implementation modules, shared tests, dependency metadata, package checks.            |
| technical    | low    | Existing base class and subpath, ordinary inheritance.                                    |
| coupling     | medium | SDK author declarations and ESM/CJS consumers must resolve the new dependency.            |
| requirement  | low    | Usage and artifact divergence reproduced before implementation.                           |
| verification | medium | Deterministic event streams prove collection; installed/bundled consumers prove delivery. |
| risk         | medium | Public SDK base must retain author overrides and callback behavior.                       |

## Risks

| ID  | Risk (impact)                                                  | Severity | Source                            | Claim                                                                | Refuted by                                                                              |
| --- | -------------------------------------------------------------- | -------- | --------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| R1  | Usage or artifacts lost or double-counted.                     | medium   | O1; failure injection             | Latest accounting and artifact snapshots survive both execute paths. | Shared fixtures lose cache/cost fields, binary bodies, or keep replaced snapshots.      |
| R2  | Public SDK or browser delivery breaks after reuse.             | medium   | ADR-0217; Cognia SDK risk catalog | SDK remains portable and compatible with existing subclasses.        | Typecheck, browser build, declarations or packed consumer fails because of this change. |
| R3  | Approvals, callbacks, failures or author ID overrides regress. | medium   | Existing base-adapter tests; C1   | Common behavior preserves these execution contracts.                 | Shared behavioral test fails or callback/stream exception is reported as success.       |

## Verification obligations

| ID  | Risk   | Method                                                                   | Independence | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                              | Coverage                                                                                                                                                    | Status |
| --- | ------ | ------------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1, R3 | Shared tests first RED, then GREEN with existing runtime-kit tests.      | tool         | RED: 7 failed / 16 passed before implementation. GREEN: pnpm test scoped packages and example: 181 suites / 708 tests passed; focused collectors: 3 suites / 66 tests passed.                                                                                                                                                                                                                                                                         | Both execute methods; usage precedence, snapshots/binary, callbacks, failures and author overrides; no real provider.                                       | passed |
| V2  | R2     | Scoped type, lint, SDK standalone and static-export checks.              | tool         | Both package tsc checks passed; pnpm lint passed; SDK standalone and plugin contract/selection checks passed. Static-export reviewer built the actual browser closure successfully (13,728 bytes, 5 portable inputs). Full static-export gate still reports 14 Node imports in unchanged agent-codebuff/agent-crush files. Root pnpm typecheck reports 3 diagnostics in unchanged remote-desktop source/tests. See .cache/adapter-root-typecheck.log. | Scoped checks passed; repository-wide gates are blocked outside this change.                                                                                | failed |
| V3  | R2     | Build and exercise ESM/CJS packed SDK consumers and author declarations. | tool         | SDK build passed; enhanced SDK pack/typecheck passed: 55 typed exports, ESM/CJS usage/artifact smoke, author subclass contract, deep-research compile. Runtime-kit independent tarball test passed: 11 ESM/CJS entries, one packed Cognia dependency, 2 data-only checks, NodeNext tsc.                                                                                                                                                               | SDK tarball installed with unpublished dependencies linked by its existing harness; runtime-kit independently tested from tarballs without workspace links. | passed |

| V4 | R2 | Regenerate offline CLI author types and check reproducibility. | tool | pnpm author-types:bundle passed; pnpm author-types:check passed: bundle is up to date (85 declarations). | Shared generated bundle includes SDK and already-landed plugin-ui declarations; no host aliases in the standalone SDK bundle. | passed |

## Decisions

| ID  | Date       | Decision                                                                                                                               | Action    | Based on   | Reversal trigger                                                                                 |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | ------------------------------------------------------------------------------------------------ |
| D1  | 2026-10-30 | Make the SDK base a compatibility subclass of runtime-kit, re-export usage helpers, remove its duplicate lifecycle/collection helpers. | implement | O1, G1, C1 | Inheritance breaks a public signature or brings host/Node-only imports into the browser subpath. |

## Residual risks

| ID  | Residual | From | Why still open | Next action | Status |
| --- | -------- | ---- | -------------- | ----------- | ------ |

| X1 | Repository-wide static-export and root type gates fail outside the Adapter change. | V2 | 14 Node imports in agent-codebuff/agent-crush; 3 remote-desktop diagnostics. No scoped Adapter errors. | Owning workstreams repair these unrelated modules, then rerun full gates. | open |
| X2 | Offline author-type reproducibility check. | V4 | Previously pending; now author-types:check reports 85 declarations up to date. | None. | closed |

## Outcome

| ID  | Signal                                                                                       | How / when measured                                                    | Result                                                                                                                                             | Status |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Both public entries return the same correct accounting and artifact result.                  | Shared source fixtures and installed SDK ESM/CJS smoke, 2026-10-30.    | 20 shared behavior cases pass; detailed usage stays 100/20/120 with cache fields, replacement artifacts/binary bodies retained.                    | met    |
| M2  | Duplicate SDK collector and unused event buffer are removed without removing public exports. | Final diff, package type checks and author subclass smoke, 2026-10-30. | SDK now inherits runtime-kit and re-exports both usage helpers; duplicate helpers and unused events buffer removed; message ID override preserved. | met    |

## Delivery notes

- The existing package/test modules were extended; no new production module was needed.
- The SDK dependency and lockfile importer add only agent-runtime-kit. A frozen, offline filtered install passed, linking that dependency without version changes.
- CLI author types were regenerated using the owning script. That combined artifact also refreshes the already-landed plugin-ui touch-control declarations; its source was not changed by this task. One provider declaration has ordering-only churn.
- Work remained uncommitted; unrelated concurrent edits were preserved. No coverage run was requested or performed.
