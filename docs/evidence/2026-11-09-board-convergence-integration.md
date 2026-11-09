# Evidence ledger: board convergence integration

- Status: verifying
- Lane: standard
- Created: 2026-11-09
- Updated: 2026-11-09
- Related: ADR-0066, ADR-0220, ADR-0250, ADR-0252; source `17e455215a`, base `a7d42793fb`

## Original request

> 适配新的架构体系，把合理的东西放进去就可以

## Knowledge

| ID  | Statement                                                                                                         | State    | Basis                                                                 | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- | ---------- |
| O1  | The old board branch has five commits outside current dev and eight textual merge conflicts.                      | Verified | git merge-tree, 2026-11-09                                            | -          |
| O2  | Squads is now a module and board is already classified as a module.                                               | Verified | ADR-0250 §14; lib/squads/module.ts; module-ownership.json, 2026-11-09 | -          |
| O3  | Drop preview and committed cross-column order disagree; Scheduler refusals can still update card status.          | Verified | source review and preview probe, 2026-11-09                           | -          |
| G1  | Integrate useful shared board behavior into the current architecture.                                             | Agreed   | User request, 2026-11-09                                              | -          |
| C1  | Preserve current Squad paths, human transition rules, Issue Run accept-time start, and unrelated working changes. | Verified | ADR-0066, ADR-0250, ADR-0252; current call sites, 2026-11-09          | O2         |

## Problem frame

Integrate the reusable board rules, single-Agent shared board UI, durable ordering and common runtime move entry from O1, adapted to O2 and C1; correct O3 while keeping each domain's transition semantics (G1). Pure board helpers belong beside the existing board module because the React shell cannot own host-neutral rules without coupling consumers to React. Extend its existing public API instead of adding a kernel member. No schema, wire contract, provider or native changes are required.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                             |
| ------------ | ------ | --------------------------------------------------------------------------------------- |
| scale        | medium | Shared UI, pure derivations, DB transaction, Scheduler and companion handler.           |
| technical    | low    | Existing dnd-kit, Dexie and Scheduler APIs.                                             |
| coupling     | medium | Shared rules serve Squad and Agent task boards; current Issue Run startup must survive. |
| requirement  | low    | User authorizes adapting the useful parts rather than merging obsolete structure.       |
| verification | medium | Jest, gates and browser flow; physical shells are separate acceptance.                  |
| risk         | medium | Incorrect ordering or state can misrepresent execution.                                 |

## Risks

| ID  | Risk (impact)                                                                      | Severity | Source                                 | Claim                                                                          | Refuted by                                               |
| --- | ---------------------------------------------------------------------------------- | -------- | -------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| R1  | Obsolete kernel promotion or renamed imports break current module layering.        | medium   | ADR-0250; independent Standards review | board remains a module and current Squad paths survive.                        | Module gate reports a new boundary violation.            |
| R2  | Preview promises an insertion point that persistence ignores.                      | medium   | independent Spec review                | Cross-column moves persist the shown index; same-column order survives reload. | A regression test observes another order after the move. |
| R3  | Scheduler refuses but card status changes, or current Issue Run startup regresses. | medium   | independent Spec review; STPA          | Refused actions leave status alone and accept-time startup survives.           | Failure-injection or startup tests fail.                 |
| R4  | UI or mobile moves bypass the shared runtime, or translations are missing.         | medium   | Cognia risk catalog; ADR-0066          | Both move doors use runtime and all new UI strings exist in both locales.      | Wiring, i18n or browser checks find a bypass.            |

## Verification obligations

| ID  | Risk | Method                                                                          | Independence | Evidence                                                                                                                                                                                                                                              | Coverage                                                                         | Status  |
| --- | ---- | ------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------- |
| V1  | R1   | Module gate, typecheck and scoped lint.                                         | tool         | Scoped ESLint exit 0; static-export exit 0. Full lint: 13 warnings in unchanged files. Typecheck: 11 errors in unchanged memory/OCR/IP files after dependency preparation. Module gate: unchanged lib/claude/build-options.ts -> memory G2 edge only. | No new board/module/type diagnostics; global gate failures carried in X2.        | blocked |
| V2  | R2   | Failing regressions, then shared drop, persistence and store tests.             | tool         | RED: 7 failures/41 passes for lost placement and refused side effects. GREEN: repository pnpm test wrapper, 17 suites/534 tests passed; .cache/board-integration/unit.json.                                                                           | Placement, tenant/column scope, durable writes and atomic store updates.         | passed  |
| V3  | R3   | Scheduler false/throw cases and existing acceptedStart tests.                   | tool         | 534 focused tests passed including acceptedStart, conditional handoff and real accepted-execution idle-compensation guard. Independent Spec re-review found no remaining actionable issue.                                                            | Refusal, Scheduler-owned compensation and Issue Run acceptance.                  | passed  |
| V4  | R4   | UI/handler tests, browser flow, i18n build/check/lint and independent auditors. | tool         | Chromium target: 1 passed (14.1 s); keyboard reorder survives reload and runtime cancellation persists. i18n build/check/lint/sort exit 0. Wiring/i18n/test-gap findings corrected. E2E governance has one unchanged expired gestures exception.      | Dev-browser UI, persistence and locale keys; native acceptance remains separate. | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                                                                                                       | Action    | Based on       | Reversal trigger                              |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | --------------------------------------------- |
| D1  | 2026-11-09 | Port selected changes on an isolated branch, keep board as a module, and preserve dev's runtime additions. Reuse the clean old checkout after managed worktree creation failed for disk space. | implement | O1, O2, G1, C1 | A current consumer requires another boundary. |

## Residual risks

| ID  | Residual                                                                              | From   | Why still open                                                                                                                                                                                                                                                               | Next action                                                                                                                 | Status |
| --- | ------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Native/device acceptance remains separate from browser and headless tests.            | R4     | No native protocol or schema change; this run exercises the shared browser bundle.                                                                                                                                                                                           | Native host acceptance belongs to its device lane.                                                                          | open   |
| X2  | Repository-wide lint/typecheck/module/E2E governance checks fail outside this change. | V1, V4 | The changed-file list excludes all reported failure owners.                                                                                                                                                                                                                  | Repair owning memory/OCR/IP modules, unused-variable owners and expired gestures exception separately.                      | open   |
| X3  | Fresh production static-export verification is blocked by disk space.                 | R1, R4 | pnpm test:e2e:build compiled JavaScript with an unrelated optional livekit-client warning, then exited 1 while prerendering /me, /me/teams and other pages: ENOSPC. Static target was not run. Task-created dev/Jest caches and partial .next output were removed afterward. | Free sufficient disk space and rerun the build plus static target. Build log remains at .cache/board-integration/build.log. | open   |

## Outcome

| ID  | Signal                                                    | How / when measured                                    | Result                                                                                                                                    | Status |
| --- | --------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Useful old-branch behavior works on current architecture. | Focused regressions and real browser flow, 2026-11-09. | Current Squad paths/module boundary retained; ordering survives reload and runtime cancellation persists. Global gate debt tracked in X2. | met    |
