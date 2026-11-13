# Evidence ledger: ADR-0243 phase 2D strict personal disclosure

- Status: verifying
- Lane: deep
- Created: 2026-11-13
- Updated: 2026-11-13
- Related: ADR-0243; baseline 7d3dd44735; phase 2D brief

## Original request

Implement phase 2D and its addenda in p2d-tip. Implementation cutoff 2026-11-13T04:09:36Z; final deadline 2026-11-13T04:24:36Z. No network, dependencies, Rust, schema migration or git mutations.

## Knowledge

| ID  | Statement                                                                      | State    | Basis                                                                                                 | Depends on |
| --- | ------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Existing receipt, callback and outbound rows support unindexed fields.         | Observed | Read lib/db/action-review-receipts.ts, outbound-jobs.ts and connector binding contract on 2026-11-13. | -          |
| O2  | Existing initiator scope admits configured operators.                          | Observed | Read callback-authorization.ts and ask-user-question.ts on 2026-11-13.                                | -          |
| G1  | Only every marked person can disclose one exact request to its original group. | Agreed   | Binding task brief and ADR-0243 section 5.                                                            | -          |
| C1  | Disclosure must never relax opaque egress.                                     | Observed | Brief addenda and personal-egress.ts canonical taint fence.                                           | -          |

## Problem frame

Private connector replies need a strict, single-use person decision. A grant must survive queueing without becoming a general tool approval or an exception to opaque egress. Only the same conversation session may later read the disclosed message.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                          |
| ------------ | ------ | -------------------------------------------------------------------- |
| scale        | medium | Callback, queue, sink and history boundaries.                        |
| technical    | high   | Atomic grant consumption with enqueue and immutable replay.          |
| coupling     | high   | Existing delivery policy and final runner rechecks.                  |
| requirement  | low    | Eight explicit implementation items and addenda.                     |
| verification | high   | Local tests can establish Host behavior; no live provider available. |
| risk         | high   | A broad or forged grant discloses personal information.              |

## Risks

| ID  | Risk (impact)                                   | Severity | Source           | Claim                                                              | Refuted by                                                   |
| --- | ----------------------------------------------- | -------- | ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| R1  | Operator or payload identity grants disclosure. | high     | O2,G1            | Verified transport identity must match every marked person.        | Operator, requester or member press succeeds.                |
| R2  | Replay changes content, target or send count.   | high     | G1               | Hash, target, persons, expiry and one queue job bind every grant.  | Tamper, expiry or double press sends.                        |
| R3  | Disclosure widens history or opaque egress.     | high     | C1               | Session-only canonical history disclosure; egress taint unchanged. | Another session/share/plugin reads or opaque operation runs. |
| R4  | Local tests overstate provider acceptance.      | medium   | task environment | Report observed commands and remaining live boundary.              | Claim native/provider delivery without evidence.             |

## Verification obligations

| ID  | Risk     | Method                                               | Independence | Evidence                                                                                                                        | Coverage                                                                                                             | Status  |
| --- | -------- | ---------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1       | Actor matrix and duplicate ask-user tests            | tool         | Final focused batch: 38 suites and 1027 tests passed, one benchmark skipped, exit 0.                                            | Marked people, connected owner, requester/operators, all marked persons and callback modes.                          | passed  |
| V2  | R2       | Real Dexie replay and real outbound-runner tests     | tool         | Same final batch passed. Dedicated regressions cover races, rollback and exact wire request.                                    | Exact original request and destination, atomic enqueue, tamper, expiry, Keep private and one use.                    | passed  |
| V3  | R3       | History, share, opaque fence and source guards       | tool         | Sink and opaque-egress guards plus behavioral tests passed. Three historical guard suites still fail on unchanged HEAD anchors. | Same conversation/session only, forged metadata, owner digest, no opaque unlock; current inventory entries reviewed. | failed  |
| V4  | R1,R2,R3 | Root tsc, touched ESLint, formatting and diff checks | tool         | Initial root tsc: exit 2, 90 diagnostics including two fixed touched diagnostics. Final results below.                          | Touched diagnostics, formatting and static inventories.                                                              | failed  |
| V5  | R4       | Live provider card and delivery                      | real-env     | No network in task environment.                                                                                                 | Native platform acceptance.                                                                                          | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                              | Action    | Based on | Reversal trigger                                           |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------- | ---------------------------------------------------------- |
| D1  | 2026-11-13 | Keep exact pending request on a Host-only receipt field; no new table or version.                                                     | implement | O1,G1    | Existing persistence cannot provide atomic enqueue.        |
| D2  | 2026-11-13 | Isolate Host grant/capability logic from connector card orchestration. Existing sink policy remains the only outbound allow boundary. | harden    | O1,C1    | Serializable context or plugin payload can mint authority. |

New modules are needed to separate private grant capabilities and transactional persistence from connector rendering/callback dispatch; adding them to the portable contract or audience resolver would mix Host authority with presentation and introduce circular ownership.

## Residual risks

| ID  | Residual                                                                            | From  | Why still open                                                                                                                                                                                                                             | Next action                                                                         | Status |
| --- | ----------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------ |
| X1  | Live provider/native acceptance unavailable.                                        | V5    | Network is disabled.                                                                                                                                                                                                                       | Exercise private card, click and group delivery on a connected Host.                | open   |
| X2  | Bound-person disclosure and arbitrary writes remain refused.                        | R2    | Phase 5 recipients do not exist; arbitrary writes cannot be safely replayed.                                                                                                                                                               | Implement phase 5 recipient authority separately.                                   | open   |
| X3  | Derived artifacts, public shares and shared collaboration retain withholding.       | R3    | Grant covers only canonical message history in the original session.                                                                                                                                                                       | Separate scoped disclosure design if required.                                      | open   |
| X4  | Existing guard anchors and required root typecheck are not green.                   | V3,V4 | Fixed on dev before this change: guard pins in 1a0409400e, credential guard and hook R2 fixture in 4cff210abd. Root and sidecar tsc diagnostics are identical to the baseline clone (88 / 159, all in files this change leaves untouched). | None.                                                                               | closed |
| X5  | A send that fails after the grant is recorded cannot be retried from the same card. | R4    | The press consumes every button of the card before the enqueue; the recorded grant stays inert because only the in-memory Host capability can use it.                                                                                      | Offer a fresh card on a failed disclosed send if this shows up on a connected Host. | open   |

## Outcome

| ID  | Signal                                         | How / when measured                                     | Result                                                                                       | Status |
| --- | ---------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| M1  | Person can share the fixed private reply once. | Real Dexie and outbound-runner regressions, 2026-11-13. | Exact request sent once after the marked-person grant; history published only after success. | met    |

## Implementation against the brief

1. New `marked-person` scope is strict even when ordinary callback authorization is off/audit. The duplicate ask-user path uses the same verified actor check; no operator exception.
2. Pending disclosure reuses an unindexed Host-only receipt-row field. It stores the exact request/hash/target/persons, canonical or exact-projection message identity, creation and 24-hour expiry. No new table or Dexie version. Composite producer sources resolve one persisted session.
3. Existing A2UI mappers render the localized Share/Keep actions; Lark ephemeral cards include native mapped buttons and other supported private channels retain the existing fallback. No split-source locale keys or generated locale changes.
4. Strict callback rechecks the live binding, receipt, hash, target, persons, expiry and Host identity. A WeakMap capability admits only the exact replay. Queue consumption is atomic with one job; transforms and reroutes cannot change a granted delivery. Private copies use a distinct key; the original request is byte-for-byte structurally retained. Shared-by notices follow successful delivery; Keep private consumes both choices and closes without replay.
5. Only sent, canonical Host disclosure metadata admits later turns in that exact conversation session. Metadata merges retain previous Host disclosures and strip imports. A tool-bearing original stays private and the exact delivered projection is persisted separately. Digest includes grants even for an already-visible owner.
6. Literal text/markdown connector sends can offer the same card; Host sends the fixed request on grant and never runs the originally withheld arbitrary tool. Unsupported shapes and mutable media remain opaque.
7. The typed declared-recipient seam always refuses the bound-person lane until phase 5.
8. Sink, mark-writer and history inventories include the new paths. Both ADR languages mark strict disclosure done and describe the residuals; the caller inventory includes Host replay ownership.

## Evidence and command outcomes

All Jest invocations go through the private-worktree Jest wrapper with the cache disabled and `NODE_ENV=test`. No pnpm, network, dependency installation, Rust edits, schema changes or git mutations.

- `node scripts/build/gen-module-registry.mjs`: exit 0, once; materialized the ignored in-scope generated registries.
- Actor RED: exit 1, three intended failures (off admitted a foreign presser; other modes did not recognize the new scope), followed by a Jest timing-output EPERM outside this worktree. No out-of-scope file was written. Actor GREEN after output redirection: exit 0, 40/40 tests at that revision. Later expanded actor matrix passed in the final batch. No without-fix source mutation was used or left behind.
- Dedicated disclosure runs: exit 1 (null settings access), exit 1 (test fixture enabled the principal registry without a principal), then exit 0 (14/14), exit 0 (15/15 after the real-runner case). Both failures were corrected and all final disclosure regressions are included in the passing batch.
- Initial sink/history guard run: exit 1; sink guard passed, history guard reported unrelated phase-2C inventory/anchor drift. New phase-2D paths were explicitly classified.
- Required 44-suite batch: exit 1, 35 passed / 8 failed / 1 skipped, 1023 passed tests / 47 failed / 1 skipped. Repairable changes were corrected: eager schema import cycle, namespace-spy fixture, new writer inventory and distinct private-delivery key expectation.
- Second required batch: exit 1, 37 passed / 6 failed / 1 skipped, 1062 passed tests / 45 failed / 1 skipped. The remaining private-key expectation was then corrected without removing its assertions. The other five failing suites are the two known bus baselines and three phase-2C guard baselines.
- Final focused batch (39 selected suites): exit 0, 38 passed / 1 existing benchmark skipped; 1027 tests passed / 1 skipped. This includes every changed source co-test, all new tests, the actor/ask-user paths, personal sink/egress behavior, real outbound runner, queue rollback/races and portable contracts, apart from the five separately reported baseline suites already exercised above.
- Baseline anchor proof: exit 0. `git show HEAD` bytes match the current `lib/claude/plugin-hook-ipc.ts`, `lib/plugin/agent-sdk/session.ts` and `lib/db/plugin-bridge.ts`; those HEAD files already lack the exact guard anchors. No source mutation was needed. Visibility inventory drift also points to unchanged phase-2C files.
- Initial root diagnostic ownership proof: exit 0; every one of the 37 unrelated diagnostic-bearing paths is byte-identical to HEAD. Final tsc results remain to be appended.
- Touched-path ESLint: initial exit 0; final check recorded below. Prettier write completed twice with exit 0; final formatting recorded below. `git diff --check` passed at both interim checks, exit 0.

## Residual behavior and environment

Live IM/provider rendering and transport are not exercised: native card JSON and the real Host queue/runner are tested locally. Bound-person recipients, arbitrary document/integration/HTTP replay, derived artifacts elsewhere, public shares and shared collaboration remain withheld as required. Unsupported private audience resolution offers no disclosure card. A crash after the sent-status commit but before the following history/notice commit can leave conservative withholding or an old notice; it never grants another send. Later history also conservatively withholds if its supporting receipt or sent-job evidence is pruned. These recovery/retention edges are not claimed as provider acceptance.

## Final checks

- Root native TypeScript reruns: exit 2 with 89 diagnostics (one missing `idempotencyKey` in the new type fixture), then exit 2 with 88 diagnostics after that fixture was corrected. Final ownership check: exit 0, zero diagnostics in touched files and all 37 diagnostic-bearing source paths byte-identical to HEAD. The brief mentioned 65 historical diagnostics; this environment actually reports 88 in untouched files, so no 65-error parity is claimed.
- Final new-tests rerun after the type-fixture correction: exit 0, 3/3 suites and 18/18 tests.
- Source ESLint completed twice with exit 0 before the final type-only fixture correction; final lint result is appended below. Prettier write completed with exit 0 after all source edits. The evidence ledger structural check has passed, exit 0; the final run follows this update.
- Implementation completed before the 2026-11-13T04:09:36Z cutoff. Subsequent work is verification and evidence reporting only.

Final ESLint: exit 0 over 38 touched TS/test paths, `--max-warnings 0`. Final checks below validate ledger structure, formatter output, allowed paths and the final diff. No source edits follow the final tests except the type fixture idempotency field and formatting.

## Claude verification at commit time

- Review of the actor scope, grant transaction, sink allow branch, history disclosure and fence: no defects. Forged `personalDisclosures` metadata grants nothing; history opens only for the same session and conversation after the job is `sent`.
- Combined 2C-2 focused list plus every 2D test and co-located test (180 suites): 146 ran in the first run (144 passed, 2 failed) before the Jest parent ran out of heap; the remaining 34 passed with an 8 GB heap (1258 tests). The two failures were baseline 2C-2 drift, fixed on dev (X4) and rerun green with the three personal guards (172 tests).
- ESLint with zero warnings and prettier on every changed file; root and sidecar tsc identical to the baseline clone.
