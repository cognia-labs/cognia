# Evidence ledger: scheduled task implementation audit

- Status: verifying
- Lane: deep
- Created: 2026-10-22
- Updated: 2026-11-17
- Related: ADR-0079, ADR-0128, ADR-0167; docs/reports/2026-10-22-scheduled-task-implementation-audit.md

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 检查一下Cognia内部定时任务的实现情况

Current audit-only follow-up (2026-11-17):

> 帮我分析一下现在的定时任务的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

The current increment authorizes source inspection, isolated diagnostic checks and
an industry comparison. Historical implementation/provider authorization below
does not extend the scope of this new increment. Do not alter user schedules,
invoke real providers, install OS jobs, or repair product code in this audit.

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                   | State    | Basis                                                                                                              | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| G1  | Audit scheduling implementation and verification gaps; historical audit-only goal superseded by G3.                                                         | Revised  | User authorized repairs after both reviews, 2026-10-22                                                             | -          |
| C1  | Preserve concurrent work and existing user schedules; only G5-authorized isolated provider probes may produce external effects.                             | Verified | Audit scope and shared-tree rules, 2026-10-22                                                                      | G1         |
| O1  | App tasks, workflow cron, OS tasks and subsystem timers are separate execution paths.                                                                       | Observed | lib/scheduler, crates/cognia-scheduling, lib/data/backup-scheduler.ts, 2026-10-22                                  | -          |
| Q1  | Are built-in schedules reachable from supported boot paths?                                                                                                 | Answered | Current-source boot/write traces and 17 maintenance suites, 2026-10-22                                             | O1         |
| Q2  | Do lifecycle and recovery claims pass focused checks?                                                                                                       | Answered | Existing regressions pass; three new catch-up assertions fail, 2026-10-22                                          | O1         |
| O2  | Existing scheduler regressions pass: 102 suites / 1712 tests; maintenance regressions pass: 17 suites / 178 tests.                                          | Verified | .cache/scheduler-audit/jest-core.log and jest-maintenance.log, 2026-10-22                                          | -          |
| O3  | Catch-up overwrites counters and automatic pause with its original task snapshot.                                                                           | Verified | Two behavioral probe failures and task-scheduler.ts:1243-1353, 2026-10-22                                          | -          |
| O4  | Catch-up executes two missed slots with maxRuns 1.                                                                                                          | Verified | Third probe failure in jest-probe.log, 2026-10-22                                                                  | -          |
| O5  | Tauri arm and listener errors are swallowed and resolve to success-shaped values.                                                                           | Verified | daemon-bridge.ts and existing bridge error tests, 2026-10-22                                                       | -          |
| O6  | Rust scheduling crate tests pass: 144 passed, no ignored tests.                                                                                             | Verified | .cache/scheduler-audit/rust.log, macOS host, 2026-10-22                                                            | -          |
| C2  | Physical sleep, application-quit OS wake, mobile and provider delivery remain outside this repair evidence.                                                 | Observed | Isolated real-shell alarm/IPC path is covered by O13; no hardware sleep or provider calls, 2026-10-22              | G3         |
| G2  | Re-review the findings and adjacent recovery/lifecycle paths, without changing implementation.                                                              | Agreed   | User re-review request and continue, 2026-10-22                                                                    | G1         |
| O7  | Real Dexie probes reproduce F1/F2 and task resurrection, continued runs after pause/stop, and scheduler restart after stop.                                 | Verified | Corrected jest-review-final.log and cached review probe, 2026-10-22                                                | -          |
| O8  | An old native alarm executes a rescheduled one-shot one hour early through actual driver/core/persistence.                                                  | Verified | Corrected stale-native probe in jest-review-final.log, 2026-10-22                                                  | -          |
| O9  | Grace-window admission skips a fresh daily slot after an older expired slot consumes the count cap.                                                         | Verified | Corrected real-cron probe in jest-review-final.log, 2026-10-22                                                     | -          |
| O10 | Final focused review run: 254 existing tests plus one positive control pass; eight defect assertions fail.                                                  | Verified | 5 passing suites, 1 failing probe suite, 263 tests total; Node 26.12.1, 2026-10-22                                 | -          |
| O11 | User chose to skip additional cross-model review.                                                                                                           | Observed | Explicit answer to optional review question, 2026-10-22                                                            | -          |
| G3  | Fix all findings from both reviews, add permanent regressions, perform real Tauri verification and preserve unrelated changes; skip typecheck.              | Agreed   | Explicit user implementation request and latest steering, 2026-10-22                                               | G2, C1     |
| O12 | Fixed core suites pass 283 tests; affected consumers pass 264 tests.                                                                                        | Verified | .cache/scheduler-fixes/core-check.log and consumers-check.log, 2026-10-22                                          | G3         |
| O13 | Eleven cases pass in the real macOS main WKWebView, including genuine Rust alarm events and native rejection.                                               | Verified | .cache/scheduler-fixes/native/28ed6832-7dc9-4c81-8cb2-a8f780f079b2/results.json; API v3 revision 4, 2026-10-22     | G3         |
| O14 | Native error propagation exposed next-arm loss, partial-bootstrap status and same-time replacement cleanup gaps.                                            | Verified | Independent reviewer, red-final-review.log and red-same-slot-arm.log; repaired regressions pass in O12, 2026-10-22 | G3         |
| G4  | Continue improving the repair with bounded async lifecycle hardening and expanded real Tauri verification; preserve the existing skip-typecheck constraint. | Agreed   | User: continue improving, 2026-10-22                                                                               | G3, C1     |
| O15 | Before follow-up fixes, seven regressions reproduced late due execution, stale one-shot expiry and prewarm after stop.                                      | Verified | Independent in-memory reproduction and followup/red-all.log: 7 failed, 14 passed, 2026-10-22                       | G4         |
| O16 | Follow-up core passes 291 tests and affected consumers pass 264 tests; reviewer independently reran 8 targeted cases.                                       | Verified | followup/core-check.log, consumers-check.log and read-only review; no typecheck or coverage, 2026-10-22            | G4         |
| O17 | Expanded native fixture passes 19 cases and observes 10 genuine Rust due events; private DB cleanup is confirmed.                                           | Verified | native/4ad413b4-2b59-43fd-8616-e8c682c4eda5/results.json, sources.json and cleanup.json, 2026-10-22                | G4         |

| G5 | Verify physical resume, OS wake and both real IM/notification and AI provider paths; repair demonstrated defects; skip typecheck and preserve concurrent work. | Agreed | User request and both-provider answer, 2026-10-22 | G4, C1 |
| O18 | Legacy promoted once wakes execute early and use receipt time; promotion discards canonical nextRunAt. | Verified | real-acceptance/red-promoted.log: 3 failed, 21 passed before repair, 2026-10-22 | G5 |
| O19 | macOS once calendar uses input offset fields and generated Label differs from registered ID. | Verified | real-acceptance/red-macos.log: 2 failed before repair, 2026-10-22 | G5 |
| O20 | No passwordless OS power-management access; no environment-backed IM live credentials or explicit test recipient. | Observed | sudo -n true requires password; IM loader reports all platforms not configured; user chose both paths without recipient, 2026-10-22 | G5 |

| O21 | Pending promoted wake and OS creation cross public lifecycle controls; manual once parsing changes argv/env whitespace/entities. | Verified | Independent private-DB probes, red-promoted-lifecycle.log, red-promotion-create.log, red-manual-xml.log; repaired regressions pass, 2026-10-22 | G5 |
| O22 | Current TS sources pass 23 real WKWebView cases, with 9 genuine Rust events and private DB cleanup. | Verified | native/ab0fd5c7-c877-474f-972e-c777e7448b89/results.json and sources.json, 2026-10-22 | G5 |
| O23 | Real provider test under native unlocked-profile binding returns HTTP 402; receipt becomes a failed scheduled execution. | Verified | native/1927128a-0939-41b7-bad9-622af3a9c22c/provider-results.json, safe synthetic prompt, 2026-10-22 | G5 |

| G6 | Skip IM for now; verify actual scheduled AI completion through the user-provided local proxy using ark-deepseek-v4.1-flash. | Agreed | Explicit user steering, 2026-10-22 | G5, C1 |
| O24 | Authenticated loopback proxy is live and advertises the requested model. | Verified | proxy-acceptance/catalog-check.json, live /v1/models HTTP 200, 2026-10-22 | G6 |

| O25 | Direct WKWebView fetch to the supplied loopback proxy fails with TypeError Load failed; production LlmClient omits platform HTTP transport. | Verified | Real native provider task failed before HTTP receipt; healthz browser fetch fails; proxy host request succeeds; red-transport.log has 2 transport regressions failing, 2026-10-22 | G6 |

| O26 | Native scheduled ordinary/streaming calls to ark-deepseek-v4.1-flash both complete with the expected marker and counters. | Verified | V21 artifacts: 1363 ms / 1151 ms, streaming 6 chunks, total cumulative usage 211 tokens, 2026-10-22 | G6, O25 |

| G7 | Fix the Azure assertion and complete resume/OS-wake acceptance; skip IM/typecheck and preserve concurrent work. Physical sleep is subsequently deferred by the user. | Agreed | Explicit follow-up and user authentication reply, 2026-10-23 | G6, C1 |
| O27 | Catalog-first resolution suppresses Azure SDK auth and URL handling; explicit OpenAI overrides and other catalog compatibility adapters must remain valid. | Verified | azure-wake/red-provider.log; tests-final.log: 5 suites/157 passed after repair; actual SDK request capture and independent review, 2026-10-23 | G7 |
| O28 | The shared native process still generates pre-repair macOS plists: mismatched Label, UTC fields used as host calendar, no canonical once metadata or guard. | Verified | Native PID 83487; native/c4148a29-9775-46d0-9784-827827ff466a/stale-native.plist and os-calendar-results.json; owned jobs cleaned, 2026-10-23 | G7 |
| O29 | OS administrator authentication did not complete; the user explicitly defers physical sleep/hardware wake. No power event or sleep was initiated. | Observed | azure-wake/sleep-control/209d8d55-a3d9-4418-824d-98272b6b3bec/result.json and explicit user reply, 2026-10-23 | G7 |

| G8 | Analyze the current scheduler's defects and missing capabilities against current primary-source industry practices; deliver prioritized evidence without product fixes. | Agreed | Current user request, 2026-11-17 | C1 |
| O30 | Automatic app scheduling, workflow cron and native OS schedules have distinct timing and persistence owners. | Observed | Current lib/scheduler, crates/cognia-scheduling and ADR-0128/0167/0179/0224, 2026-11-17 | - |
| Q3 | Which restart, cancellation and cross-platform guarantees fail in current source or isolated behavioral checks? | Answered | Current report F1-F11; seven behavioral counterexamples and four source-harness cases, 2026-11-17 | G8, O30 |
| O31 | Current focused scheduler regressions pass 11 suites / 448 tests. | Verified | .cache/scheduler-gap-audit-2026-11-17/regression.log; pnpm test through the repository runner, no coverage, 2026-11-17 | - |
| O32 | Isolated current-scheduler/DB/RTL checks produce seven failed invariants and two passing controls. Restart loses retry/queue/claimed work; completion reverses pause and loses counters; cap=1 rejects cancel-previous replacement; form changes zero retries to three. | Verified | docs/evidence/2026-11-17-scheduler-gap-audit.probes.mjs and .cache/scheduler-gap-audit-2026-11-17/probes.log; private fake-IndexedDB and mocked peripheral hooks, 2026-11-17 | - |
| O33 | Linux timer/service naming and absolute-once offset, Windows month conversion, and native rename-collision replacement each have a source-harness counterexample. | Verified | Independent current-source review and native-probe-results.log; pure Rust generators plus full macos.rs with stubbed launchctl; no live platform claim, 2026-11-17 | - |
| O34 | App tasks have overlap/catch-up/backfill/auto-pause controls; workflow cron separately skips offline slots; official Temporal/Kubernetes/EventBridge contracts provide useful comparison points. | Observed | Current report capability/source matrix and direct official source pages, accessed 2026-11-17 | O30 |

| G9 | Adversarially challenge the current audit, reproduce omitted failure modes and correct unsupported claims; no product repair. | Agreed | User: 做一次对抗性审查, 2026-11-17 | C1, G8 |
| H30 | Completion scheduling and buffered-drain continuations violate task controls independently of the statistics-write race. | Verified | Adversarial A1 pause/delete/stop and A2 desired assertions fail; real DB facade and public controls, 2026-11-17 | - |
| H31 | The combined identity/replay hypothesis needs separation: subsecond keys and bookkeeping replay fail current requirements; retaining original retry time is a redesign expectation. | Contested | O36 and fresh reviewer contract reconciliation; split into H32 and H33, 2026-11-17 | - |
| H32 | Current retry semantics require scheduledFor to remain the original slot. | Invalidated | occurrence.ts:20-23,69-72 explicitly treat retries as independent starts at retry time; A4 is a rejected expectation, 2026-11-17 | - |
| H33 | API-accepted subsecond slots merge, and a post-success statistics failure can call the executor twice. | Verified | A3 100ms versus 1000ms control and A6 synthetic persistence failure; no external effects, 2026-11-17 | - |
| O35 | Original seven desired-invariant failures still reproduce with two passing controls. | Verified | adversarial-original-probes.log, current source fixture, 2026-11-17 | - |
| O36 | Expanded adversarial probes return 10 failed / 3 passed: nine defect assertions and one rejected design-comparison assertion A4. | Verified | adversarial-probes.log; A0 public due/claim boundary, A1 drain controls, A2 completion writer, A3 precision, A5 budget rollback, A6 bookkeeping replay, A7 cooperative cancellation, 2026-11-17 | - |
| O37 | Current affected regression check passes 7 suites / 338 tests. | Verified | adversarial-regression.log; core/integration/DB/occurrence/workflow idempotency and executor/TaskForm; existing React act warnings preserved, 2026-11-17 | - |
| O38 | User explicitly skipped additional CLI review. One boundary-review continuation was stopped by automatic tool risk review before its remaining candidate checks completed. | Observed | User reply and agent result possible cybersecurity risk, 2026-11-17; no external CLI invoked | G9 |
| Q4 | Do queue-one concurrent replacements or late writes after account DB swap violate their boundaries? | Open | Independent source-level candidates; not reproduced or counted as verified findings in this bounded review, 2026-11-17 | - |

## Implementation authorization

On 2026-10-22 the user requested fixing every finding from both reviews, permanent regressions, real Tauri verification and preservation of unrelated uncommitted work. This supersedes the original audit-only boundary for this increment. The existing unrelated managed Tauri session must not be stopped or have its schedules altered. No external model CLI is authorized.

## Problem frame

The initial audit required an inventory and reproducible findings. G3 now authorizes fixing F1–F5, permanent behavioral regressions and actual Tauri verification. C1 still prohibits touching existing user schedules and unrelated working-tree changes. Native fixtures must use an isolated database and unique alarm ids; G5 additionally authorizes synthetic real provider checks against a designated safe test target.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                         |
| ------------ | ------ | ------------------------------------------------------------------- |
| scale        | high   | App scheduler, workflow cron, OS backends and subsystem timers.     |
| technical    | medium | Existing deterministic test seams.                                  |
| coupling     | high   | Account data, authority, capabilities, notifications and backups.   |
| requirement  | low    | Inspect and report; fixes are follow-up work.                       |
| verification | high   | Real process lifetime and device acceptance differ from unit tests. |
| risk         | low    | Source audit and fixture tests only.                                |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                    | Severity | Source                                                            | Claim                                                                                         | Refuted by                                                                              |
| --- | -------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| R1  | Visible tasks have no live clock or executor.                                    | high     | ADR-0079 and hardening incident                                   | Boot and writes reach live owners.                                                            | Storage-only writes or missing mounts.                                                  |
| R2  | Duplicate or missed work repeats side effects.                                   | high     | ADR-0128 and failure-injection lens                               | Authority, occurrences and cancellation preserve contracts.                                   | Deterministic tests violate declared behavior.                                          |
| R3  | Host or account claims exceed evidence.                                          | high     | ADR-0167 and risk catalog                                         | Evidence is scoped by host and account.                                                       | Unit tests described as native acceptance.                                              |
| R4  | Independent timers bypass controls or silently stop.                             | medium   | Prior inventory and STPA lens                                     | Ownership, cadence and stop behavior are identified.                                          | Orphan clocks or swallowed operational failures.                                        |
| R5  | A stale delivery runs a newly rescheduled future slot early.                     | high     | Fresh-context reviewer and source event-identity trace            | Native delivery retains its arm identity through core admission.                              | An old event consumes a new future slot.                                                |
| R6  | Fresh intended delivery is lost after a longer outage.                           | medium   | Catchup policy contract and F5 probe                              | Grace admission considers fresh eligible slots before dropping the backlog.                   | A fresh slot exists but no replay starts.                                               |
| R7  | Pending async work crosses pause/delete/reschedule/stop and changes newer state. | high     | Independent follow-up counterexamples and failing regressions O15 | Due, one-shot expiry and prewarm continuations honor their original scheduler/task lifecycle. | A cancelled slot executes, current schedule is overwritten, or prewarm arms after stop. |

| R8 | OS translation and early wake can move or duplicate an absolute once occurrence. | high | O18, O19 and independent promotion review | Canonical slot admission, Local minute ceiling, persistent one-attempt claim and original timestamp round-trip. | An early/duplicate attempt runs, pause is reversed, or a live plist has a mismatched label/time. |

| R9 | Claimed occurrences, retries or buffered starts disappear across a process restart. | high | Failure-injection lens; Temporal schedule and Kubernetes CronJob reliability contracts | Durable state accounts for each accepted occurrence or records an explicit disposition. | Restart leaves an advanced cursor or retry-scheduled row with neither executable work nor a terminal disposition. |
| R10 | Platform-specific translation or update failure silently disables native scheduling. | high | Fresh-context failure hunt; ADR-0128 | A generated timer addresses its generated service and unsuccessful edits preserve the old task. | Timer Unit names a different service or invalid replacement deletes the original. |
| R11 | Feature comparison confuses implemented controls, intentional scope and real reliability gaps. | medium | ADR-0179/0224; current official industry documentation | Findings distinguish current protections, defects, missing capabilities and unverified environments. | Existing overlap, catch-up, ownership or backfill controls are described as absent. |
| R12 | Concurrent completion reverses operator controls or loses counts; cancellation and policy editing change requested behavior. | high | Current statistics-write trace; F4-F7 deterministic counterexamples | Pause remains effective; concurrent completions accumulate; cancel-previous works with a cap of one; zero retries survives editing. | A completed run restores active status, counters undercount, replacement is dropped, or form changes zero to three. |

| R13 | The audit overstates fixture evidence or recommends incomplete repairs. | high | doubt-driven fresh-context review | Each finding names its actual boundary and repair addresses all owning writers/continuations. | A stop/start fixture is called a real crash test or another whole-row writer still reverses pause after the proposed change. |
| R14 | Buffered starts ignore cancellation, occurrence identities merge, or post-effect failures cause unsafe replay. | high | Independent failure hunt; STPA and failure-injection lenses | Cancellation fences pending starts and each admitted slot/attempt retains an accountable identity. | Paused/deleted work starts after a pending read, distinct accepted slots share a row, or completed effects are retried due only to bookkeeping failure. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk                   | Method                                                                                        | Independence   | Evidence                                                                                                                                   | Coverage                                                                                                                                               | Status |
| --- | ---------------------- | --------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| V1  | R1, R4                 | Trace boot, live writes and timer owners.                                                     | self           | Report runtime/maintenance/independent-loop inventory, 2026-10-22.                                                                         | Current source and actual live reconciliation; no user execution.                                                                                      | passed |
| V2  | R1, R2, R3             | Focused scheduler and subsystem Jest tests.                                                   | tool           | pnpm test: 102 suites / 1712 tests and 17 suites / 178 tests passed; logs in .cache/scheduler-audit.                                       | Existing regressions; fixtures; no coverage.                                                                                                           | passed |
| V3  | R2, R3                 | cognia-scheduling Rust unit tests.                                                            | tool           | cargo test -p cognia-scheduling --lib --locked: 144 passed, 0 failed, 0 ignored.                                                           | macOS timing and backend logic; no OS installation or Tauri host feature acceptance.                                                                   | passed |
| V4  | R2, R3                 | Identify real-shell acceptance boundaries.                                                    | self           | Report acceptance-boundaries section and browser E2E source inspection.                                                                    | Browser, Tauri, headless and providers kept separate.                                                                                                  | passed |
| V5  | R2                     | Probe persisted catch-up statistics, automatic pause and maxRuns admission.                   | tool           | Historical 3-test red probe retained; permanent actual-Dexie integration cases now pass in core-check.log (283 total).                     | Current-row counters, automatic pause and per-slot maxRuns reservation; no external effects.                                                           | passed |
| V6  | R2, R3, R4, R5, R6     | Real-shell scheduler timing, persistence, lifecycle and native failure acceptance.            | real-env       | Real macOS WKWebView: 11 passed; genuine Rust events and i64 argument rejection; native/28ed6832-7dc9-4c81-8cb2-a8f780f079b2/results.json. | Actual current TypeScript scheduler/DB/driver/IPC; private DB; old event held across public reschedule; no physical sleep/OS wake/provider claim (X2). | passed |
| V7  | R2                     | Verify lifecycle controls with real Dexie persistence logic.                                  | tool           | Original red probes retained; permanent integration regressions in core-check.log pass for pause, deletion, stop and overlapping sweeps.   | Actual serializers/indexes/transactions in fake IndexedDB; native equivalents pass in V6.                                                              | passed |
| V8  | R2, R3                 | Re-run five existing suites and an ordinary-run control against the same fixture.             | tool           | Final review invocation: 254 existing tests and one completed-run positive control passed; 263 total with eight failing probes.            | Focused regressions only; full first-pass suite and Rust not repeated.                                                                                 | passed |
| V9  | R5                     | Deliver stale alarm through actual Rust timing driver and core.                               | tool           | Permanent driver/core/DB regression passes in core-check.log; actual old Rust event reschedule case passes in V6.                          | Replacement arm and future canonical slot survive stale delivery, including existing jitter regressions.                                               | passed |
| V10 | R6                     | Reconcile daily cron with expired oldest slot and fresh current slot.                         | tool           | Permanent cron/DB regression passes in core-check.log; fresh-grace-slot-after-long-outage passes in V6.                                    | Grace eligibility before count cap; bounded long-backlog cursor advancement.                                                                           | passed |
| V11 | R2, R5                 | Reconcile fresh-context adversarial candidates against source and behavioral evidence.        | fresh-reviewer | Two candidate counterexamples received before interruption, both independently reproduced in corrected probes; no full reviewer sign-off.  | Catch-up lifecycle and stale native delivery; external cross-model review explicitly skipped.                                                          | passed |
| V12 | R2, R4                 | Recheck failure paths after exposing native IPC rejection.                                    | fresh-reviewer | Independent review identified three gaps; each reproduced red, then six suites / 283 tests passed, including optional-prewarm failure.     | Next-arm failure preserves current work; bootstrap cleanup/retry; same-time replacement stop cleanup; co-located tests present.                        | passed |
| V13 | R1, R2, R4             | Run affected consumer suites and affected-file ESLint/format checks.                          | tool           | 13 suites / 264 tests passed; affected ESLint --max-warnings=0 passed; formatting result recorded in final verification below.             | Initializer/store/hook, other drivers, occurrence/backfill/maintenance and pet due listener; typecheck explicitly skipped.                             | passed |
| V14 | R2, R4, R7             | Reproduce and permanently test pending due, one-shot expiry and prewarm lifecycle races.      | tool           | Seven regressions failed before repair; six suites now pass 291 tests, including expiry CAS stale-slot protection.                         | Real Dexie facade and transactions with controlled async boundaries; original behavior tests retained.                                                 | passed |
| V15 | R2, R3, R4, R5, R6, R7 | Expand the isolated real Tauri fixture through pending native IPC and hidden-window delivery. | real-env       | 19/19 passed; 10 Rust due events; native/4ad413b4-2b59-43fd-8616-e8c682c4eda5/results.json; cleanup.json confirms fixture DB absent.       | Actual WKWebView/IndexedDB/Rust IPC; hidden main window restored; current source hashes captured; no physical sleep or provider claim.                 | passed |
| V16 | R1, R2, R4, R7         | Independently recheck fixes and run affected consumer/file checks.                            | fresh-reviewer | Reviewer: 2 suites, 8 targeted tests passed, 54 skipped; no blocker. Consumer suites: 13/264 passed; affected ESLint passed.               | Bounded F6-F8 review, co-located tests, initializer/store/hook/driver consumers; typecheck and coverage skipped.                                       | passed |

| V17 | R8 | Red/green real-Dexie and native macOS regressions for once time, ID, guard and manual execution. | tool | real-acceptance/core-check-final.log: 8 suites/340 passed; rust-check-final.log: 150 passed, 1 opt-in test ignored. Red promotion/XML logs retained. | Actual source, real shell subprocesses and focused tests; no typecheck or coverage. | passed |
| V18 | R8 | Actual launchd calendar job, duplicate start, deletion and recreation. | real-env | launchd-live-final.log: 1 passed, scheduledAttempts 1, manualAttempts 1, deleted/absent/recreated true; current-source target lateness 22002 ms. | OS backend and local calendar; does not establish hardware or app cold wake. | passed |
| V19 | R3, R8 | Physical sleep/resume with native due-event and persisted execution timestamps. | real-env | Existing helper plus bounded native administrator prompt prepared; authentication not completed. User explicitly defers this item on 2026-10-23. | Real host sleep and OS logs still required; no physical sleep claimed. | waived |
| V20 | R1, R8 | Original IM and direct-DeepSeek acceptance scope, superseded by G6/V21. | human | User explicitly deferred IM and selected the local proxy; the historical direct-DeepSeek HTTP 402 remains recorded. | IM not sent; AI success is assessed by V21. | waived |

| V21 | R3, R8 | Actual native-timed complete and stream tasks via production LlmClient and the supplied local proxy. | real-env | native/aff33c4a-b249-4974-9f84-0a0c3e377e02/provider-results.json: both passed/completed, expected marker, count=1/success=1 each, stream 6 chunks; cleanup.json absent DB. | Current sources hashed; no credentials in artifacts; diagnostic executor, not built-in chat/plan. | passed |

| V22 | R1, R3 | Repair Azure protocol resolution, preserve explicit overrides/relays, inspect real SDK requests and run affected consumers. | tool | azure-wake/tests-final.log: 5 suites/157 passed; 4 actual Azure SDK request captures stop before network; independent functional/PII reviews pass. | Chat/Responses paths, api-key, API version, configured origin, custom gateway, renderer/utility/judge; no cloud Azure claim or typecheck. | passed |
| V23 | R8 | Verify the current macOS scheduler through real Tauri IPC and launchd calendar. | real-env | Native replacement PID 97006: native/5ee2363c-32e6-45fb-b045-994164ff0a64/os-calendar-results.json passes; current-source cached Rust opt-in OS test passes again in azure-wake/current-source-launchd.log. | Actual wrapper/local transport/IPC/launchd; correct Label, canonical metadata, minute ceiling, guard and argument round-trip; one calendar and one manual run; duplicate suppressed; cleanup confirmed. No hardware/cold-start claim. | passed |
| V24 | R3, R8 | Verify application-quit OS launch and deep-link execution. | real-env | The native shell is owned/restarted by another active session. An owned launch attempt exits without a private endpoint once that replacement instance takes the single-instance lock; no other process is stopped. | Cold launch is distinct from an awake calendar job and from RTC hardware wake. | blocked |

| V25 | R9 | Inspect and reproduce restart boundaries using the actual scheduler and account-DB facade in a private fake-IndexedDB fixture. | tool | F1-F3 desired invariants fail in probes.log; ordinary execution and same-process retry controls pass. O32, 2026-11-17. | Exact claim-to-record durable boundary, replacement scheduler instance, retry timer and queued starts; not actual SIGKILL or a deployed Host. | failed |
| V26 | R10 | Independent Rust/OS scheduling failure hunt with current source evidence and isolated generators where feasible. | fresh-reviewer | Four source-harness counterexamples in native-probe-results.log and report F8-F11. O33, 2026-11-17. | Linux/Windows pure conversion and current full macOS source with OS stub; no native service acceptance. | failed |
| V27 | R11 | Verify relevant controls and compare primary-source Temporal, Kubernetes and EventBridge contracts. | tool | Report links current owners and official schedule, CronJob, DLQ, monitoring and time-semantics pages. O34, 2026-11-17. | Reliability and user-facing capability matrix; existing protections and intentional scope are identified. | passed |
| V28 | R9, R11 | Re-run focused existing scheduler regression suites and check final audit/ledger consistency. | tool | regression.log: 11 suites / 448 passed; ledger and file consistency checked in final audit notes. O31, 2026-11-17. | Scoped source/fixture verification; no coverage or full production acceptance. | passed |
| V29 | R12 | Exercise concurrent statistics, public pause, cancel-previous at cap=1, and zero-retry editing. | tool | F4-F7 desired assertions fail in probes.log; pause is active again, counts=1, replacement concurrency-blocked, form retries=3. O32, 2026-11-17. | Actual core/DB plus RTL with existing form peripheral stubs; no live UI or external side effects. | failed |

| V30 | R13 | Independently challenge findings, mocks, product reachability, severity and platform evidence. | fresh-reviewer | Two bounded review cycles; A4 rejected; F1/F3 capability scope, F6 display-only evidence, F7 cooperation, F2 public due and all-writer repair boundaries reconciled in report, 2026-11-17. | One reviewer completed both cycles; second contributed independent drain/candidate trace before its continuation stopped (O38). No external CLI or product edits. | passed |
| V31 | R14 | Run isolated desired-invariant checks for completion scheduling, drain cancellation, occurrence/retry identity and post-effect failures. | tool | O36: 10 red assertions / 3 controls; nine defect counterexamples plus the independently rejected A4 expectation. Current regressions O37 pass 338 tests. | Private fake-IndexedDB core/DB fixture; due callback and cooperative-executor controls; no actual process death, native OS or external effects. | failed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                             | Action    | Based on                 | Reversal trigger                                                                    |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------ | ----------------------------------------------------------------------------------- |
| D1  | 2026-10-22 | Audit source and deterministic fixtures before proposing fixes.                                                                                                      | diagnose  | G1, C1, O1               | User requests implementation or evidence changes scope.                             |
| D2  | 2026-10-22 | Report F1/F2 as confirmed defects and F3 as a source-confirmed operational weakness; keep fixes as follow-up work.                                                   | diagnose  | G1, O2, O3, O4, O5, O6   | A counterexample disproves a reproduction or user expands scope.                    |
| D3  | 2026-10-22 | Re-enter verification after the re-review request; replace storage-seam-only evidence with actual Dexie logic and public lifecycle actions.                          | diagnose  | G2, C1                   | Source changes or a fixture error changes the outcomes.                             |
| D4  | 2026-10-22 | Retain and expand F1/F2; add F4/F5. Correct the async event mock and rely only on the final log with a passing positive control. Do not infer native acceptance.     | diagnose  | G2, O7, O8, O9, O10, O11 | Counterexample invalidates a probe or user requests implementation.                 |
| D5  | 2026-10-22 | Implement the five confirmed repairs in existing modules; add real-persistence and isolated native fixtures; preserve the broad dirty tree and skip typecheck.       | implement | G3, C1, O7, O8, O9, O11  | A regression or real native counterexample contradicts the repaired contract.       |
| D6  | 2026-10-22 | Extend F3 hardening to preserve already-claimed work and clean partial failures, with independent reproduction and permanent tests.                                  | harden    | G3, O14                  | Native or permanent regression fails after the repair.                              |
| D7  | 2026-10-22 | Repair three demonstrated async continuation races in existing modules and extend the existing native fixture; keep unrelated platform/provider acceptance separate. | harden    | G4, C1, O15              | A new behavioral/native counterexample violates these captured-lifecycle contracts. |

| D8 | 2026-10-22 | Repair reproduced early once admission and macOS translation; preserve explicit manual execution and distinguish one attempt from provider receipt. | harden | G5, O18, O19 | A regression or actual OS counterexample contradicts the contract. |

| D9 | 2026-10-22 | Extend the existing acceptance fixture for explicit runtime proxy credentials/model and reuse platformStreamingFetch in production LlmClient after O25; preserve native account-binding/PII checks; skip IM. | implement | G6, O24, O25 | Actual scheduler/provider output or persistence fails; secrets enter an artifact. |

| D10 | 2026-10-23 | Keep the default Azure SDK family when the catalog records OpenAI wire compatibility; preserve explicit overrides and other catalog adapters. | implement | G7, O27 | Actual SDK request or relay/override regression contradicts the contract. |
| D11 | 2026-10-23 | Reject the stale shared native backend as current-source acceptance; retain a source-hash-matched Rust OS run and wait for an independently available current shell. | experiment | G7, O28 | A current native shell becomes ready or the observed plist differs from the captured pre-repair behavior. |

| D30 | 2026-11-17 | Audit current code and isolated failure boundaries; use independent platform review and primary sources. Historical repairs are not new findings. | diagnose | G8, O30 | Current-source tests contradict a candidate or the user expands scope. |
| D31 | 2026-11-17 | Extend the failure hunt to statistics/control races, policy combinations and zero-valued form defaults after source inspection exposes those risks; retain desired assertions even when red. | diagnose | G8, O30 | Fixture limitations rather than product behavior explain a result. |
| D32 | 2026-11-17 | Deliver 11 scoped findings and a prioritized capability comparison; keep repairs and live acceptance pending. Seven behavioral checks fail despite 448 existing passing tests. | diagnose | G8, O31, O32, O33, O34 | Independent review or a current-source counterexample changes a finding. |

| D33 | 2026-11-17 | Reopen diagnosis for an adversarial review, test fresh counterexamples and correct the report's evidence/repair scope. | diagnose | G9 | Current-source checks refute candidates or the user changes the review scope. |
| D34 | 2026-11-17 | Reject the original-slot retry expectation because current source explicitly defines retry-time semantics. Keep A4's red result as a design comparison, outside defect totals; no obligation is silently weakened. | diagnose | G9, O36 | A downstream current contract or observed failure requires retaining the original slot. |
| D35 | 2026-11-17 | Preserve first-pass facts with narrower evidence claims; add F12-F14 and extend F4/F5. Require all-writer lifecycle consistency and cooperative cancellation semantics rather than a single-point statistics fix or unsafe reservation transfer. | diagnose | G9, H30, H33, O35, O36, O37 | A corrected fixture refutes a result or current owning source changes. |
| D36 | 2026-11-17 | Stop after two cycles on materially changed artifacts; user skips extra CLI review. Carry Q4 as unverified rather than expanding findings from an incomplete reviewer continuation. | diagnose | G9, O38 | Repair scope or additional private-fixture evidence warrants reopening. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                     | From              | Why still open                                                                                                                                        | Next action                                                                                            | Status |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| X1  | Catch-up snapshot overwrite and maxRuns defects.                                                             | V5, R2            | Fixed with live-row transactional claims and narrow CAS advancement; regressions and native cases pass.                                               | Re-run permanent regressions when admission changes.                                                   | closed |
| X2  | Physical sleep/resume, application-quit OS wake, mobile/paired-host and provider outcomes remain unverified. | V6, R2, R3        | Native alarm/IPC/persistence evidence cannot establish other device, process-exit or provider behavior.                                               | Separate physical-device/OS-promotion/provider acceptance; no such behavior is newly implemented here. | open   |
| X3  | Native alarm failure visibility and cleanup.                                                                 | R4, O5, V12       | Fixed typed native rejection and status cleanup; bootstrap retry and next-arm current execution pass regressions; genuine native rejection passes V6. | Re-run failure regressions when native transport changes.                                              | closed |
| X4  | Deletion, pause and stop reversal during catch-up.                                                           | V7, R2            | Per-slot lifecycle/status/authority checks and no-upsert updates pass actual DB and native cases.                                                     | Keep permanent integration tests in the scheduler suite.                                               | closed |
| X5  | Stale native event consumes future occurrence.                                                               | V9, R5            | Arm identity is checked before consuming state; actual old-event buffering/reschedule case passes in WKWebView.                                       | Re-run native fixture after event contract changes.                                                    | closed |
| X6  | Grace policy loses a fresh slot after long outage.                                                           | V10, R6           | Eligibility precedes count cap; real parser/DB and native fixture pass.                                                                               | Keep fresh-daily-cron regression.                                                                      | closed |
| X7  | Pending due, one-shot expiry and prewarm transitions violate newer lifecycle state.                          | R7, V14, V15, V16 | Fixed entry/post-await lifecycle checks and active-slot expiry CAS; permanent and actual native cases pass.                                           | Retain seven race regressions and the expanded native fixture.                                         | closed |

| X8 | Application-quit deep-link launch acceptance remains incomplete; IM deferred by G6. | R8, V24 | The replacement shared shell passes V23 but remains owned by another session. No exclusive instance can be stopped for cold-launch acceptance. AI proxy already passes V21. | Perform cold-launch/deep-link execution when the native app is exclusively available. | open |
| X9 | Physical sleep/resume and RTC hardware wake remain unverified. | V19 | Administrator authentication did not complete; the user explicitly chose to retain this item as unverified on 2026-10-23. | Re-run the prepared bounded helper only when local authentication is available. | accepted |

| X30 | Claimed work, pending retries and buffered starts can be lost at restart. | V25, R9 | F1-F3 are reproduced; current request is audit-only and no fix is implemented. Real process death and Host durability remain untested. | Implement atomic occurrence enqueue and durable attempt/queue recovery, then verify actual process termination and Host persistence. | open |
| X31 | Four OS translation/update issues remain unrepaired and real platform acceptance is absent. | V26, R10 | F8-F11 use generator/source harnesses, not actual systemd/schtasks/launchd. | Repair canonical names, absolute-time conversion, month rejection/expression and failure-safe replacement; run native platform checks. | open |
| X32 | Current industry comparison and implemented-feature inventory completed. | V27 | Relevant source contracts and primary documentation are linked in the report. | Revisit if product goals or upstream contracts change. | closed |
| X33 | Focused existing regressions completed; full production checks remain outside this audit. | V28 | Existing 11 suites / 448 tests pass and artifact consistency is checked. | Broaden checks when repairs are implemented; do not reuse scoped tests as platform acceptance. | closed |
| X34 | Completion/control races, cancellation-at-cap and zero-retry editing remain unrepaired. | V29, R12 | F4-F7 desired behavioral invariants fail; product changes are not authorized by this audit. | Use transactional narrow-field stats updates, settled cancellation admission and zero-preserving defaults; retain these counterexamples as permanent regressions during repair. | open |

| X35 | Adversarial audit evidence/repair claims reconciled. | V30, R13 | Report now distinguishes direct controls, due/instance models, real OS limits, rejected A4 expectation and all-writer repair obligations. | Reopen on contradictory current-source evidence. | closed |
| X36 | Additional confirmed controls, identity precision and post-success replay problems remain unfixed. | V31, R14 | Nine defect assertions remain red; no product repair is authorized. A4 is excluded as a rejected expectation. | Fix F12-F14 and expand F4/F5 remediation, retain controls, then verify actual process/Host/platform boundaries. | open |
| X37 | Queue-one concurrency and late account-switch writes remain source-level candidates only. | Q4, O38 | The second reviewer continuation stopped at tool risk review; no completed reproduction exists. | Run separately bounded private fixtures if these candidates affect the repair design; do not treat them as verified defects. | open |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                             | How / when measured                                                                        | Result                                                                                                                         | Status |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| M1  | Source-backed inventory, findings and evidence limits delivered.                   | docs/reports/2026-10-22-scheduled-task-implementation-audit.md, 2026-10-22                 | Inventory and three findings documented; fixes and native acceptance explicitly pending.                                       | met    |
| M2  | Re-review challenges previous evidence and identifies missed failure modes.        | Updated report and corrected review log, 2026-10-22                                        | Existing findings confirmed with stronger persistence evidence; two additional findings and broader lifecycle impact recorded. | met    |
| M3  | All five reviewed defects are repaired and permanently regression-tested.          | Core 283 tests, affected consumers 264 tests and real Tauri 11 cases, 2026-10-22           | F1–F5 and newly exposed F3 failure continuations pass; unrelated account tasks are not used as fixtures.                       | met    |
| M4  | Follow-up lifecycle races are fixed and the native acceptance surface is expanded. | 291 core tests, 264 consumer tests, independent 8-case subset and native 19/19, 2026-10-22 | Pause/delete/reschedule during re-arm, once expiry replacement, stopped prewarm and hidden-window dispatch pass.               | met    |

| M5 | Azure renderer features retain the correct default SDK authentication/endpoint family without changing configured overrides. | 5 focused suites/157 tests plus independent SDK request/PII review, 2026-10-23 | Existing renderer assertion and added resolver/request regressions pass. | met |
| M6 | Repaired macOS OS-calendar behavior is observed through actual Tauri IPC. | native/5ee2363c-32e6-45fb-b045-994164ff0a64 and current-source-launchd.log, 2026-10-23 | One scheduled attempt, duplicate suppression, explicit manual execution and cleanup pass; no early run. | met |

| M7 | Deliver a current-source scheduler gap audit and industry comparison with reproducible counterexamples and explicit evidence limits. | 2026-11-17 report; 11 suites / 448 existing passing tests; 7 failed desired invariants / 2 controls; four Rust source-harness cases; bounded independent final review. | Audit report delivered; product repairs and real-environment acceptance remain open in X30/X31/X34 and historical residuals. | met |

| M8 | Adversarially review the scheduler gap audit, correct evidence/scope, and reproduce material omitted cases. | Original 7 red assertions/2 controls; new 10 red/3 controls with A4 explicitly rejected; current 338 regressions pass; two bounded fresh-review cycles, 2026-11-17. | Report adds three new issue groups and expands two existing impacts, narrows unsupported claims, and leaves repairs/real environments and Q4 candidates explicitly pending. | met |

## Final verification notes

### Adversarial review follow-up (2026-11-17)

- Read and applied `.agents/skills/doubt-driven/SKILL.md`; reviewer artifacts
  excluded orchestration rationale. Two cycles were limited to the report and
  then the changed private-fixture checks. No external model CLI ran; the user
  explicitly skipped the optional offer.
- The original defects/capability facts are retained with narrower evidence
  wording. A4 is a rejected design expectation, not a defect. F12/F13/F14 are
  new groups; A2/A5 expand existing F4/F5 rather than inflating root-cause counts.
- New runner: `docs/evidence/2026-11-17-scheduler-gap-audit.adversarial-probes.mjs`.
  Logs: `.cache/scheduler-gap-audit-2026-11-17/adversarial-{original-probes,probes,regression}.log`.
  Raw outcomes and actual execution boundaries are O35-O38 and V30/V31.
- No product fixes, real account data, existing schedules, OS jobs, provider
  calls or repository history changes. Remaining source candidates from the
  interrupted reviewer are Q4/X37, not findings. Native/process/Host acceptance
  is still absent rather than inferred from fake-IndexedDB or driver fixtures.

### Current audit-only follow-up (2026-11-17)

- Deliverable: `docs/reports/2026-11-17-scheduled-task-gap-audit.md`; reusable
  counterexamples: `docs/evidence/2026-11-17-scheduler-gap-audit.probes.mjs`.
- Current focused regression evidence is O31; current desired-invariant failures
  are O32/O33. Historical green repairs and provider authorization are not reused
  as current production acceptance.
- The initial pnpm invocation triggered automatic dependency installation and
  failed in the unrelated sidecar-linked-package postinstall check. Subsequent
  commands disable automatic install for that invocation only and still run the
  repository's `pnpm test` entry point. No package configuration is edited.
- No current live OS tasks, user schedules, model calls or Host installations are
  used. This increment changes audit documentation and its isolated probe runner
  only. Physical sleep, cold launch and paired/provider acceptance stay scoped to
  the historical residuals; they have not been accepted anew or completed here.
- Audit complexity: scale/coupling high (three schedule mechanisms and shells),
  technical medium (existing seams), requirement low (analysis), verification
  high (source/fixtures cannot establish real environments), execution risk low
  under private fixtures. The next action is prioritized repair, not more
  speculative exploration or an unsubstantiated engine replacement.
- Independent final review narrowed F7 wording: the fixture proves abort was
  requested and the replacement was skipped, not that an executor's external
  effect stopped. Report wording now preserves that distinction.
- Final artifact checks: `ledger.mjs check <this-file> --final` reports zero
  errors/warnings; targeted Prettier check and `node --check` pass; the report's
  61 local links resolve; both generated temporary fixture files are absent;
  path-scoped `git diff --check` passes. Full dirty-tree changes are preserved
  and nothing is staged or committed by this increment.

### Re-entry on 2026-10-23

G7 reopens the shared provider-resolution boundary. Azure now retains its existing native SDK family while explicit overrides, Claude relays and Mistral/Cohere compatibility endpoints keep their prior routes. The actual SDK is exercised with a rejecting fetch, so generated URL/auth/body assertions do not send synthetic credentials to a cloud endpoint. Physical sleep was attempted only as preparation: authentication did not complete, no timer was armed and no sleep command ran. The user explicitly defers this physical requirement.

- Core: `pnpm test -- --runInBand --runTestsByPath` for the six changed scheduler suites: 6 passed, 283 tests passed (`.cache/scheduler-fixes/core-check.log`).
- Consumers: 13 affected suites, 264 tests passed (`.cache/scheduler-fixes/consumers-check.log`).
- ESLint: explicit 13-file source/test/native-runner list with `--max-warnings=0`, exit 0 (`.cache/scheduler-fixes/eslint.log`). No typecheck or coverage command was run.
- Native: passing run artifact `.cache/scheduler-fixes/native/28ed6832-7dc9-4c81-8cb2-a8f780f079b2`; real main window, macOS, helper API 3 revision 4, 3 native due events, 11 cases passed. Fixture uses current bundled TypeScript and an existing debug binary; no Rust source changed. It deletes only its private fixture DB and unique alarms/public module. Screenshot, console, network and native-log captures are retained there.
- The initial native rebuild failed with ENOSPC. Only inactive incremental caches touched by that failed launch were removed, with an explicit deletion manifest at `.cache/scheduler-fixes/removed-own-rust-caches.json`; no source/binary cleanup was performed by this task. After shared workspace activity replaced the executable/app, the final fixture was rerun successfully in the ready same-workspace native shell (PID 21265), without stopping that shared process. The extra build attempt was cancelled after the replacement binary became available; no successful fresh full-build claim is made.
- Historical failed audit obligations V5/V7/V9/V10 are now discharged by the corresponding repaired regressions; original red logs remain evidence of the defect. X2 carries the broader acceptance boundary, so this ledger stays verifying without pretending those unrelated platform/provider flows passed.

- Final independent recheck confirmed all three failure-path findings resolved, with no new blockers. Formatting and ledger checks passed; changed scheduler source hashes remained stable after tests. Final native console contained no errors, one expected auto-pause warning and one unrelated pre-existing plugin compatibility warning. Native screenshots showed the desktop wallpaper, so screenshots are not used as UI acceptance evidence.

## Follow-up verification (2026-10-22)

- Goal G4 re-entered discovery after the user's continuation request. Three independent counterexamples became seven red integration tests, then fixes in the existing scheduler and database modules. The existing changeset now includes these lifecycle continuations.
- Final focused results: 6 core suites / 291 tests, 13 affected-consumer suites / 264 tests. A read-only reviewer independently reran 8 targeted regressions across two suites (54 tests skipped by pattern) and confirmed the three findings resolved.
- Final native artifact: `.cache/scheduler-fixes/native/4ad413b4-2b59-43fd-8616-e8c682c4eda5`. All 19 cases passed, with 10 real Rust alarm events. The window was hidden for the relevant case and restored. `sources.json` captures current bundled source hashes and `cleanup.json` confirms the private database is absent. The shared native process is left running.
- Native error logs include the two deliberately injected native argument rejections. An intermediate import failed before fixture execution; final acceptance comes from the complete 19-case run. The runner now retains failure diagnostics and module response metadata.
- Typecheck remains explicitly skipped; no coverage, full repository build/lint or native rebuild was run. X2 still carries physical sleep, OS-wake, mobile/paired-host and provider acceptance; hidden-window execution is now verified by V15.

## Real acceptance follow-up, 2026-10-22

The one-shot OS adapter now retains the absolute date (including year/seconds), generates the registered Label, rounds the calendar up in host local time, and uses a fixed argv-only persistent one-attempt guard. Explicit manual execution bypasses that guard and preserves cwd/env and literal argument bytes. OS delivery latency remains unbounded by launchd. A successful /usr/bin/open only acknowledges URL dispatch, not provider delivery.

The core retains promotion cadence, rejects early one-shot wakes, fences the initial promoted read, and rolls back stale/failed OS creation through an atomic promotion-only database patch. A rejected wake returns ran=false. Independent reviewers drove the new regressions; original red logs remain available. Provider probes pass the PII gate and require native unlocked-account authority. The first unbound provider probe was superseded by O23 and is not active-account evidence. No extra external review model was invoked.

The real shared WKWebView run did not change window visibility or navigate. Physical resume modes and the administrator-authenticated helper are prepared, but no physical sleep or RTC wake has been observed. launchd's missed-calendar behavior is distinct from waking sleeping hardware: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html . DeepSeek documents 402 as insufficient balance: https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/ . No IM outbound message was sent because no configured adapter or designated safe recipient exists.

Final current-source evidence: `launchd-live-final.log` passed after the XML fix (scheduled once, manual once, duplicate suppressed, delete/recreate and absent plist confirmed). `native-build-final.log` passed. The awake control of resume-arm/read/cleanup also passed: one genuine native event, one completed canonical execution, start delay 37 ms and private DB removed (`native/cb6972fa-4720-4a5a-8c62-4a61f501e4dc`). This is an awake control only. The independent final reviewer reran 11 targeted Jest tests and the XML Rust regression, all passed. PII reviewer verified six account/diagnostics scenarios in memory, all passed; no post-dispatch account-lock cancellation is claimed. Core/consumer total is 604 passing Jest tests. `preservation-check.json` confirms staging unchanged and all accepted native fixture source hashes still match.

## Supplied proxy acceptance, 2026-10-22

G6 explicitly defers IM and names the local Aiden proxy model. The proxy was independently discovered live on 127.0.0.1:8787 (current listener PID differs from the user's earlier snapshot), with authenticated model catalog HTTP 200. The running proxy was not changed or stopped. Keys were obtained only with the user-provided CLI, kept in memory and passed at runtime through authenticated local agent-debug evaluation; they never enter the esbuild define/bundle, account settings, task payloads or saved execution output.

O25 exposed an actual production transport gap: the direct LlmClient let the SDK choose browser fetch, which failed against the local non-CORS origin in WKWebView. Two complete/stream transport assertions failed before the fix. The client now reuses the existing platformStreamingFetch for SDK families, composing Perplexity Responses normalization over the same transport. Host-neutral/browser fallback and native cancellation remain owned by that existing transport. No proxy configuration or new native command was added.

The supplied model passed actual native-timed complete and stream tasks in V21. The second usage snapshot is cumulative across both calls (211 tokens), not an extra 211-token charge. Both task rows have one run and one success, canonical scheduledFor identity, no early start, and the expected provider/model marker. The private fixture database is absent after cleanup and source hashes match accepted sources. Provider diagnostics stay suppressed; a runtime-key scan of 28 acceptance files found zero matches.

Focused final transport/DB/LLM tests pass 3 suites / 93 tests, including the Perplexity request-delegation regression; scoped ESLint passes. An affected-consumer check passed 35 tests but found one Azure protocol assertion mismatch in renderer-llm-client.test.ts (expected azure, got openai). That suite replaces createLlmClient entirely; the failing provider resolution is outside the changed transport and is recorded rather than changing unrelated behavior. Typecheck and coverage remain skipped. PII preflight found no new gate bypass or credential log; bounded transport/static-export review found no production blocker and requested the now-added Perplexity regression.

## Azure and native OS follow-up (2026-10-23)

- Focused provider/renderer/LLM/utility/judge tests: **5 suites / 157 passed** (`.cache/scheduler-fixes/azure-wake/tests-final.log`). Existing Azure regression was red before the repair. Four actual SDK captures validate configured origin, Chat/Responses paths, version parameters, `api-key`, absent unintended Bearer auth and deployment model. The fetch rejects before network delivery, so this is protocol verification, not Azure cloud acceptance. Independent functional and PII reviews find no remaining blocker. Scoped ESLint, Prettier and diff checks pass; typecheck and coverage remain skipped.
- The old shared binary (PID 83487) failed real calendar acceptance and exposed the pre-repair backend. Its plist is retained as negative evidence; no source fix is removed or weakened to make that stale binary pass. All uniquely named jobs created by that failed probe are removed.
- The other session subsequently replaces the native binary and starts PID 97006. The owned candidate never acquires a private endpoint and is not counted as acceptance. Only its unused cached bundle is removed. The passing native run uses the replacement same-workspace authenticated API-v3 shell without stopping it or navigating its window.
- Current native proof: `.cache/scheduler-fixes/native/5ee2363c-32e6-45fb-b045-994164ff0a64/{environment,sources,created,os-calendar-results}.json` and `native.plist`. The test uses the actual system-scheduler wrapper bound to production local TauriTransport, genuine Rust commands and a user launchd calendar job. The marker command first runs at `2026-10-23T00:16:06+08:00`, 13,055 ms after its canonical target and after the local minute ceiling. One scheduled attempt, a suppressed duplicate launchctl start, one explicit manual run, exact argv round-trip, deletion and absence all pass. The main foreground URL stays unchanged.
- The source-hash-matched cached Rust OS test also passes again: one calendar attempt, one manual attempt, duplicate suppression, deletion and recreation (`azure-wake/current-source-launchd.log`). Its target is rounded to `2026-10-23T00:13:00+08:00`; observed delay from the original canonical timestamp is 47,754 ms. The macOS source hash matches the previously compiled accepted source; no additional full native build was claimed by this task.
- Physical sleep/resume and RTC wake remain unverified by explicit user deferral. The native authentication preparation times out before arming a task or power event; no host sleep occurs. Application-quit deep-link startup remains blocked by shared-instance ownership. Real launchd calendar execution does not establish either physical hardware wake or cold-app deep-link behavior.
