# Evidence ledger: agent observability completion

- Status: verifying
- Lane: standard
- Created: 2026-11-12
- Updated: 2026-11-12
- Related: ADR-0074, ADR-0090, ADR-0165; agent observability adversarial review dated 2026-11-12

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 完整的补齐这些缺口

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                                                                  | State    | Basis                                                                                                                                       | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Seven data defects were reproduced before this repair: workflow invocation collisions, external result mapping, root termination, remote filtering, provider timestamps, duplicate accounting and unknown failure latency. | Verified | Current owning source and isolated probes in `.cache/agent-observability-adversarial/`, 2026-11-12; no live-provider incidence measurement. | -          |
| O2  | At audit time dashboard requests/latency mixed span kinds, diagnostics had independent consent and capture lacked unified trace/run correlation.                                                                           | Verified | `lib/observability/aggregate-series.ts`, `lib/perf/renderer-diagnostics.ts`, capture contracts, 2026-11-12.                                 | -          |
| G1  | Repair all seven defects and make statistics, collection readiness, durability and run/resource correlation usable without inventing exclusive resource costs.                                                             | Agreed   | User: 完整的补齐这些缺口, 2026-11-12.                                                                                                       | O1, O2     |
| C1  | Preserve concurrent working-tree changes, existing privacy consent, static export and one authoritative usage writer.                                                                                                      | Verified | AGENTS.md, concurrent-tree-safety, ADR-0074 and ADR-0165, 2026-11-12.                                                                       | -          |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Complete the observed gaps (G1) through existing runtime, trace, ledger and performance seams. Success requires invocation-level cost conservation, standard external result/stream accounting and failure status, terminal root closure, export of renderer-owned observations without an operation-name blacklist, correctly positioned provider timing, duplicate-free accounting, measured-or-unknown health latency, truthful dashboard units and usable trace/run capture correlation. Resource samples remain shared process observations, not fabricated exclusive CPU allocation. No unrelated product refactors, credential changes or publication (C1).

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                               |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Workflow runtime, ledger, external bridge, chat lifecycle, trace aggregates and performance UI.                           |
| technical    | medium | Extend existing identities and instrumentation; reuse current pricing and persistence.                                    |
| coupling     | high   | Shared runtime contracts, i18n, local/remote observations and all UI shells.                                              |
| requirement  | low    | Explicitly authorized gap completion following concrete audit.                                                            |
| verification | high   | Unit/integration checks can prove data invariants; browser flow and native/provider boundaries require separate evidence. |
| risk         | high   | Wrong identity silently loses billed cost; wrong export filtering loses data or duplicates it.                            |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                             | Severity | Source                                                       | Claim                                                                                     | Refuted by                                                                  |
| --- | ----------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| R1  | Duplicate delivery or repeated invocation changes billed totals incorrectly.              | high     | ADR-0165; independent coverage reviewer                      | Each real invocation counts once; snapshots replace only that invocation.                 | Two loop calls collapse or same invocation snapshot charges twice.          |
| R2  | Standard external results or terminal branches lose usage/status/root span.               | high     | Independent trace and coverage reviewers                     | Actual manager/hook inputs reach terminal spans with original accounting.                 | Failed result becomes ok, or terminated root remains pending.               |
| R3  | Export provenance or local aggregates discard real work or duplicate inclusive summaries. | high     | ADR-0074; independent coverage reviewer                      | Remote spans retain renderer-owned work; local totals use explicit measurement ownership. | Renderer MCP/workflow missing or root/provider amounts add twice.           |
| R4  | UI metrics imply request latency or exclusive resources that were not measured.           | medium   | ADR-0165 evidence requirement; independent resource reviewer | Unknown values remain explicit and shared samples have truthful identity/units.           | Unknown duration becomes zero or capture claims exclusive CPU.              |
| R5  | Shared tree, static export or privacy constraints regress.                                | high     | AGENTS.md; Cognia risk catalog                               | Changes stay scoped, client-compatible and within existing gates/consent.                 | New source lacks tests, server-only code enters UI or export bypasses gate. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk       | Method                                                                              | Independence   | Evidence                                                                                                                                                                                                                                                                                                                                         | Coverage                                                                                                                                                                            | Status  |
| --- | ---------- | ----------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1         | Workflow runtime, ledger, budget and replay behavioral checks.                      | tool           | Workflow suites passed during implementation; final `event-log`, `step-cost` and durable exhaustion cases passed in the focused batches below. `session-usage` verifies two execution rows, same-ID replacement, zero retraction and conserved daily totals.                                                                                     | Independent actual dispatches, cumulative snapshots, live/replay terminal budget; no real Host loop E2E claim.                                                                      | passed  |
| V2  | R2         | External bridge and actual chat hook regression tests.                              | tool           | External 17 tests passed; hook regressions for clean result-less end and fallback exhaustion passed after reproducing both failures. Latest external error test also preserves streamed usage/cost.                                                                                                                                              | Standard result, streamed fallback, USD-only cost, error status and terminal root closure.                                                                                          | passed  |
| V3  | R3         | Producer, transport and all affected aggregation checks.                            | tool           | Initial affected batch: 8 suites / 168 tests passed. Consumer/pending batch: 7 suites / 32 selected tests passed. Latest shared helper/eval cases included in final 10 suites / 38 selected tests, all passed (`.cache/agent-observability-completion/final-focused-tests.log`).                                                                 | Provider timestamps; remote operation filtering; pending-to-terminal local upsert without remote pending export; owner/aggregate/partial/cycle/orphan math and metric availability. | passed  |
| V4  | R4         | Health, capture and component behavior checks.                                      | tool           | Capture/workflow batch: 10 suites / 134 tests passed; initial affected UI/Node batch: 5 suites / 87 tests passed; final focused batch: 10 suites / 38 selected tests passed. Scope/write-failure/exhaustion batch: 5 suites / 7 selected tests passed. Final live-origin checks: 2 suites / 2 selected tests passed (`active-origin-tests.log`). | Unknown latency; truthful span units; diagnostic settings; encrypted association; imported-link exclusion; final-await and lock/render scope boundaries.                            | passed  |
| V5  | R5         | Scoped ESLint, i18n/static-export gates, package typecheck and preflight reviewers. | fresh-reviewer | 71 task TS/TSX files: ESLint exit 0. `pnpm --filter @cognia/agent-trace typecheck`: exit 0. `i18n:build:check`, `lint:i18n`, `i18n:sort:check` and `lint:static-export`: passed. Test-gap/i18n/PII/wiring reviews completed; all identified task findings fixed, including final scope re-review.                                                | Task-owned code; no coverage run. Full repository gates tracked separately in V8/X2.                                                                                                | passed  |
| V6  | R2, R3, R4 | Real browser startup and full-repository typecheck.                                 | real-env       | User explicitly requested `跳过pnpm dev和全量typecheck` on 2026-11-12. Temporary preview was stopped.                                                                                                                                                                                                                                            | Browser/desktop acceptance remains unclaimed; no further full typecheck or dev launch.                                                                                              | waived  |
| V7  | R4         | Real native Node sampler smoke.                                                     | real-env       | `pnpm exec tsx --tsconfig tsconfig.build.json .cache/agent-observability-completion/native-node-smoke.ts`: exit 0. Two frames; RSS, CPU and event-loop delay measured; first CPU unknown; lease closed (`native-node-smoke.log`).                                                                                                                | Actual Node 26.12.1 built-ins on macOS; not the real Cognia Host, model provider or deployed collector.                                                                             | passed  |
| V8  | R5         | Full repository gate observation before user's waiver.                              | tool           | Initial `pnpm lint` reported 3 task errors (fixed and scoped lint passed) plus 10 warnings outside task scope. Full typecheck observations reported unrelated plugin/mobile/memory/sidecar errors; own test typing error was fixed. No post-waiver full rerun.                                                                                   | Full shared tree is not a green repository-wide acceptance baseline.                                                                                                                | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                 | Action    | Based on       | Reversal trigger                                            |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | ----------------------------------------------------------- |
| D1  | 2026-11-12 | Extend existing seams with co-located failing behavioral tests, then implement and verify each invariant; preserve current consent and ledger ownership. | implement | O1, O2, G1, C1 | New evidence invalidates an identity or runtime assumption. |

| D2 | 2026-11-12 | Follow user's request to avoid redundant tests and skip dev/full typecheck; use changed behavioral cases, scoped checks and read-only final reviewers. | harden | G1, C1 | User changes verification scope or a focused check finds an unresolved defect. |

New modules are necessary at existing boundaries: `packages/agent-trace/src/accounting.ts` is a pure package-level owner selector shared by DB analytics, dashboard series/timeline and eval; placing it in one app consumer would create divergent rules or an app dependency from the package. `lib/perf/execution-correlation.ts` isolates strict identity parsing and canonical run/trace joins for the controller, encrypted metadata reader and URL/UI without loading encryption or capture services into the URL parser.

Implemented behavior:

- Workflow runtime stamps a fresh opaque `stepExecutionId` for each actual execution attempt. One execution's cumulative reports replace; independent invocations accumulate. New event/ledger pricing is frozen once, including known zero; partial per-step costs stay unknown. Budget termination survives later negative corrections and replay.
- External manager results, streamed usage and thrown errors retain USD accounting and terminal status. Chat result-less end and exhausted fallback close the original root. Provider spans use measured start/end bounds; health latency uses measured sample counts.
- Renderer-owned workflow/MCP/plugin observations export without a blanket `chat`/`execute_tool` exclusion. Local statistical projections share one per-metric accounting selector; raw spans remain inspectable. Explicit mirrors, partial inclusive lower bounds, independent children, missing owners and cycles have distinct rules.
- Renderer logging persists pending rows through a local-only sink and requests immediate local flush on terminal events. Remote transports receive terminal observations only. A stale-span timer settles abandoned active entries. Awaiting the local flush barrier still requires checking transport health; synchronous emitter return does not acknowledge durable disk commit.
- Run and trace details link into performance captures; captures store explicit associations in encrypted metadata and link back using canonical IDs. The whole encrypted capture library is scanned in bounded batches, with explicit read errors. Imported evidence never creates local identity links. Default export pseudonymizes all newly associated IDs.
- Capture UI reuses the existing opt-in diagnostics controls and records the settings/capability snapshot. Shared process/renderer interval scope is explicit. Persisted pending rows require canonical run state or a matching live in-memory span before new linked capture. Pending capture starts are fenced across every asynchronous scope boundary; decrypted React state is synchronously scope-checked. Write failures/account lock leave failed artifacts and stop demand. Node event-loop monitoring follows actual leases, including close/reopen during an in-flight collect.

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                | From               | Why still open                                                                                                                                                       | Next action                                                                                                  | Status |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| X1  | Native Tauri/paired Host, real model-provider and deployed collector acceptance are unverified.                         | R2, R3, R4, V6, V7 | Browser startup/full typecheck explicitly waived; local probes and Node smoke do not establish those boundaries.                                                     | Run targeted native/provider/collector acceptance in an available environment if requested.                  | open   |
| X2  | Repository-wide gates are not green for the shared tree.                                                                | R5, V8             | Full lint found 10 warnings outside owned paths. Prior full typecheck found unrelated plugin/mobile/memory/sidecar errors; no rerun after waiver.                    | Owners of unrelated changes resolve their diagnostics; task-scoped ESLint already passes.                    | open   |
| X3  | Historical collided invocations and previously missing telemetry cannot be reconstructed reliably.                      | R1, R2, R3         | Legacy events lack invocation identities or were never stored. New readers preserve explicit legacy behavior rather than fabricate past calls.                       | Apply new attempt identities to new observations; import only independently trustworthy historical evidence. | open   |
| X4  | Local trace persistence is asynchronous and renderer-scoped; raw remote span billing depends on backend interpretation. | R3, R4, V3         | Immediate queue flush is not crash-proof sync commit; no headless Dexie pending sink was added. Raw exported spans retain their original per-span values/provenance. | Inspect transport health, and validate collector-specific aggregation before relying on its spend totals.    | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                              | How / when measured                                                               | Result                                                                                                                                    | Status |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | All seven original reproductions become regression tests asserting corrected behavior.              | Owning behavioral tests after observed failures, plus consumer regressions.       | Corrected runtime/ledger/trace behavior passed; extra review counterexamples were fixed and verified.                                     | met    |
| M2  | Performance readouts distinguish span/unknown/shared-sample semantics and attach run/trace context. | Component and metadata/controller tests; real Node smoke; browser waived by user. | Correct units/availability, encrypted canonical correlation, scope fencing and explicit collection settings verified locally; X1 remains. | met    |
