# Evidence ledger: turn diff completion

- Status: verifying
- Lane: deep
- Created: 2026-10-29
- Updated: 2026-10-30
- Related: ../reports/2026-10-30-turn-diff-adversarial-review.md

## Original request

> 补全这些缺口，确保功能完善，架构合理

## Knowledge

| ID  | Statement                                                                                                                 | State    | Basis                                                                       | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- | ---------- |
| O1  | Shared patch path altered payload, dropped later hunks, failed chmod, and exposed inconsistent Undo scope.                | Verified | Native service repro and fresh review, adversarial report, macOS 2026-10-29 | -          |
| O2  | Runtime and environment capture coverage differs by lifecycle owner and filesystem visibility.                            | Verified | Three independent source reviews, support matrix 2026-10-29                 | -          |
| G1  | Close all actionable audit findings and make supported/unavailable execution paths accurate.                              | Agreed   | User request 2026-10-29                                                     | O1, O2     |
| C1  | Preserve existing task uploads, explicit Local semantics, Host grants, concurrent tree work, and static export.           | Verified | ADR0086/0108/0111, repository instructions 2026-10-29                       | -          |
| A1  | Physical cross-platform/provider acceptance needs those actual runtimes; unit/native tests do not establish it.           | Verified | Audit verification boundaries 2026-10-29                                    | -          |
| O3  | A second adversarial audit reproduced nine lifecycle, resource-type, binary, metadata, fixture and restore-scope defects. | Verified | 2026-10-30 adversarial report and cached actual-helper reproducers          | O1, O2     |
| G2  | Fix all nine findings, add regressions, refresh fixtures and generated i18n, and complete relevant verification.          | Agreed   | User request 2026-10-30                                                     | O3         |

## Problem frame

Repair the existing ledger and lifecycle seams instead of creating a provider-specific duplicate. Display, stored scope, message/root/run/Host identity, and inverse mutation must agree (G1,C1). Explicitly carry unavailable capture and remote filesystem limitations rather than infer clean state (O2). Preserve complete application semantics for user uploads while making their inclusion visible (O1).

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                        |
| ------------ | ------ | -------------------------------------------------------------------------------------------------- |
| scale        | high   | Native ledger, shared TS client, chat projection, Review, external runtime entry points            |
| technical    | medium | Existing mechanisms reused; explicit Local uses native observed runs with exclusive root ownership |
| coupling     | high   | Persisted optional identities, companion reads/mutations, multiple roots/Hosts                     |
| requirement  | medium | All audit findings are actionable; arbitrary remote files need real capture authority              |
| verification | high   | Regressions reproducible here; real provider/device/platform acceptance separate                   |
| risk         | high   | Incorrect byte writes or inverse operation can lose user data                                      |

## Risks

| ID  | Risk (impact)                                                          | Severity | Source                              | Claim                                                                          | Refuted by                                            |
| --- | ---------------------------------------------------------------------- | -------- | ----------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| R1  | Patch transform or partial apply changes intended bytes                | high     | Fresh reviewer, ADR0086             | Preserve payload and all file kinds                                            | Native apply bytes differ from execution capture      |
| R2  | Display and Undo target different contributions                        | high     | Fresh reviewer, ADR0108             | One exact visible scope including provenance                                   | Hidden upload/root affected by mutation               |
| R3  | Message/root/run/Host identity races                                   | high     | Fresh reviewer, STRIDE              | Retained reads stay on owning authority                                        | Next message/Host shown for previous run              |
| R4  | Adapter ignores capture directory or lifecycle                         | high     | Runtime review, wiring catalog      | Execution writes inside observed root                                          | Empty capture while executor edits elsewhere          |
| R5  | UI/DTO changes break export/i18n/test boundaries                       | medium   | Repository risk catalog             | Export-safe bilingual UI and complete contracts                                | Gate or real flow failure                             |
| R6  | Unknown executor stop releases authority or publishes reversible state | high     | Fresh independent review 2026-10-30 | Durable quarantine fences overlapping roots and blocks further executor launch | New executor writes before explicit stop confirmation |

## Verification obligations

| ID  | Risk                   | Method                                      | Independence   | Evidence                                                                                                                                                                                                                | Coverage                                                                                                                                             | Status  |
| --- | ---------------------- | ------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1                     | Native public-service regressions           | tool           | 581 unit and 10 integration passed at default concurrency; production Clippy -D warnings passed; full-test-bootstrap-final.log                                                                                          | Bytes, kinds, modes, multi-hunk, binary, recovery and ownership; no installed Host/provider claim                                                    | passed  |
| V2  | R2                     | Projection/card/restore tests               | tool           | Integrated 40 passing suites /1483 tests; parent planner/dialog/chat417 passed; production browser confirmation verified                                                                                                | Applied selections, User/Unknown, original roots/Hosts/accounts and cancellation                                                                     | passed  |
| V3  | R3                     | Deferred-settle and identity regressions    | tool           | Resource lifecycle4 suites236 passed; all relevant suites passed in integrated-final.json                                                                                                                               | Read-only refresh, delayed results, newer run ownership, retained original authority                                                                 | passed  |
| V4  | R4                     | CLI/runtime lifecycle integration           | tool           | 11 CLI suites435 passed with real helper, zero skips; same suites passed integrated run                                                                                                                                 | Borrowed success/failure/retry, REPL/TUI, explicit unavailable receipts and no-session admission                                                     | passed  |
| V5  | R5                     | Lint/type/i18n/export/contracts             | tool           | Full ESLint, scoped Prettier, sidecar typecheck, i18n build/check/ICU/sort/lint and API generation/check passed; root type/export, broad provisioning and managed-handoff generator checks have scope-external failures | No owned TypeScript diagnostics; full application/native-shell build and package-wide rustfmt remain unverified or blocked                           | blocked |
| V6  | R1, R2, R3, R4         | Fresh independent falsification             | fresh-reviewer | Two actual-helper bypass reproducers rerun after repair; final-repros-evidence.json: both closed, no new confirmed issue in bounded trace                                                                               | Symmetric overlap, unknown-stop native quarantine and provider zero-send refusal; test-gap/i18n audits also passed                                   | passed  |
| V7  | R4, R5                 | Actual helper and browser flow              | real-env       | Compiled helper14/14 filesystem/process cases; bilingual production restore dialog browser fixture passed cancel and original-Host Undo order                                                                           | Current macOS helper and rendered component, deterministic provider/history/transport boundaries; other platforms/provider/installed shell remain X1 | passed  |
| V8  | R1                     | F1/F2/F6/F8 native regressions              | tool           | RED reproducers and GREEN public-service/actual-helper cases; native/actual-helper-results.json; 581+10 full suite                                                                                                      | Resource kinds, foreign process ownership, complete UTF-8 classification and mode headers                                                            | passed  |
| V9  | R3, R4, R6             | F3/F4/F5 ownership and stop proof           | tool           | Panel/store236 tests; CLI435 tests; helper14 cases; fresh post-repair repro verified zero sends for tracked/no-session denial                                                                                           | EOF/crash/delivery ambiguity, explicit no-patch recovery, overlapping roots, inherited owner, retries and refusal propagation                        | passed  |
| V10 | R2, R4, R5             | F7/F9 fixtures and locale verification      | tool           | Parent417 passed; TUI completed/failed/cancelled/repeated/stale-event tests passed; locale generation and independent audit passed; browser-results.json                                                                | Honest autonomous unavailable state, applied-scope approval and current generated translations                                                       | passed  |
| V11 | R1, R2, R3, R4, R5, R6 | Final independent audit and source identity | fresh-reviewer | Fresh stop-proof and test-gap/i18n reviews complete; wiring trace complete;104 source hashes and helper unchanged during integrated verification                                                                        | Accepted overlapping-root/CLI/REPL gaps repaired; whole-repo gate failures retained as explicit residuals                                            | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                                        | Action    | Based on   | Reversal trigger                                                          |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------- | ------------------------------------------------------------------------- |
| D1  | 2026-10-29 | Repair existing ledger; retain generic upload/apply/undo semantics, expose complete provenance in UI.                           | implement | O1, C1, G1 | Any hidden mutation or lost upload behavior                               |
| D2  | 2026-10-29 | Persist root/run/origin and bind historical reads to explicit Host transports.                                                  | implement | O1, O2, C1 | Old account or routing change can redirect retained reads                 |
| D3  | 2026-10-29 | Add Host-owned external capture at the execution Host with bounded terminal refs.                                               | implement | O2, C1     | Double acquisition, unbounded frame, or missing cancellation settlement   |
| D4  | 2026-10-29 | Explicit interactive Local uses Observed runs in the same native ledger; retain managed isolation for team/scheduled execution. | implement | O1, O2, C1 | Hidden isolation, double apply, premature recovery, or live-root deletion |
| D5  | 2026-10-29 | CLI reuses persistent bounded workspace worker and carries borrowed lifecycle ownership into the logical turn.                  | implement | O2, C1     | Duplicate or orphaned pending run, or new parallel store                  |
| D6  | 2026-10-30 | Persist stop-proof quarantine in the existing run/snapshot owner; no patch or root reuse without positive stop proof.           | implement | O3, G2, C1 | EOF, crash, nested-root or runtime fallback bypass                        |
| D7  | 2026-10-30 | Background runtime events without a before-write boundary receive explicit unavailable notices rather than a late baseline.     | implement | O3, G2     | Runtime gains a genuine awaited before-write lifecycle hook               |

## Residual risks

| ID  | Residual                                                     | From           | Why still open                                                                                                                                                                                                                        | Next action                                                                                                    | Status |
| --- | ------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Full real provider and cross-platform environment acceptance | V7, A1         | Requires actual agents/devices/providers                                                                                                                                                                                              | Check available real shells and retain precise remaining acceptance                                            | open   |
| X2  | Previous process-startup blocker                             | V1, V4, V5, V6 | Node/Rust startup recovered on 2026-10-30; no OS/security setting was changed                                                                                                                                                         | Current-source verification resumed; retain historical failed-run evidence                                     | closed |
| X3  | Repository-wide type/export/format gates                     | V5             | Root tsc17 scope-external errors (14 baseline plus3 concurrent identity-test errors); export14 pre-existing Codebuff/Crush imports; package-wide rustfmt also fails pre-edit snapshots. Host build not rerun under low disk capacity. | Resolve owning baseline workstreams, then rerun full root/static-export/native-shell acceptance.               | open   |
| X4  | Broad provisioning regression baseline                       | V5             | Expanded41-suite run:1499 passed,3 failed. Failing workspace-provisioning assertions and all three Best-of-N/Harness caller files are byte-identical to HEAD; provisioning-baseline.json records proof.                               | Repair provisioning in its owning Best-of-N/Harness workstream and rerun that suite; assertions were retained. | open   |

| X5 | Unrelated generator fixture mismatch | V5 | Companion generator tests69 passed,1 failed: managed desktop criteria fixture is string[] while its request schema requires objects. This repair did not edit that request or test. | Update the owning managed-desktop fixture and rerun the generator suite. | open |

## Outcome

| ID  | Signal                                                                      | How / when measured                                                             | Result                                                                                                                                 | Status |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Original byte/scope/identity reproducers are closed                         | Current-source native, TS and independent helper/browser evidence on 2026-10-30 | Targeted boundaries pass; real provider/platform acceptance remains X1                                                                 | met    |
| M2  | Runtime capture and unavailable states match supported lifecycle boundaries | Source-to-runtime trace plus CLI/helper and browser checks                      | Managed/Local/borrowed/REPL/TUI paths are wired; autonomous post-write events explicitly unavailable; other actual platforms remain X1 | met    |

Verification artifacts: `.cache/turn-diff-fix-2026-10-30/`. Current repair details: [nine-finding report](../reports/2026-10-30-turn-diff-fixes.md). No coverage, commit, deployment or real upstream-provider acceptance is claimed.

Final contract follow-up: TaskRun response schema omission reproduced RED, fixed as optional boolean/default false, native type/schema13 passed; API validation/catalog57 passed; final-helper runtime/client102 passed with zero skips. The relinked final helper is `a8da80c9718711ac00783185999d2dec773af1f9d264dbcde90658712df42004`; its14 filesystem/process cases and independent original reproducers were rerun successfully.
