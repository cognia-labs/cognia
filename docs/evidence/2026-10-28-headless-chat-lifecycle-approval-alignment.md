# Evidence ledger: headless chat lifecycle approval alignment

- Status: verifying
- Lane: standard
- Created: 2026-10-28
- Updated: 2026-10-28
- Related: .cache/cognia-headless-setup/extended-2026-10-28/report.md; ADR-0224; paired Web production deployment

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 修复这些问题，而且消息区域和下面也没有对齐

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                             | State       | Basis                                                                                                                                                                              | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Successful first turn leaves a pipeline run running; second send is refused in two sessions, including after reload.                  | Verified    | Deployed Debian Host/Web smoke and public run metadata, 2026-10-28                                                                                                                 | -          |
| O2  | Allow once for hostname and uname is rejected with remote execution context mismatch; no tool result arrives.                         | Verified    | Real Web dialog, Host event stream and Brain stderr, 2026-10-28                                                                                                                    | -          |
| O3  | Assistant response starts at x=0 versus composer x=20 at 707px; wide-pane centres also differ by half the native scrollbar width.     | Verified    | Before DOM rectangles at 390, 707 and settled 1440px, layout-before.json, 2026-10-28                                                                                               | -          |
| H1  | Bundle settlement leaves a distinct pipeline-owned run open.                                                                          | Verified    | Controller opens a scoped lease then sends another Host-acquisition envelope; Headless begins an unscoped run. Behavioral regression failed twice before the fix.                  | O1         |
| H2  | Approval response context is enriched or reconstructed differently from the pending request identity.                                 | Invalidated | No field reconstruction was found; stale per-turn snapshots are a separate verified cause H4.                                                                                      | O2         |
| H3  | Device-origin approval enters HostState and is answered by Brain's service caller.                                                    | Verified    | Queue/controller/Brain/Host validator trace plus failing queue regression; Rust validation remains unchanged.                                                                      | O2         |
| H4  | Cached AI SDK permission gates and response bridges retain the first turn caller context.                                             | Verified    | Direct browser RPC still failed after the queue repair; cached-gate/plugin regressions reproduced a,a,a instead of a,b,undefined; code cancellation lacked its execution snapshot. | O2,H3      |
| G1  | Existing and fresh paired conversations support consecutive sends, approved read-only tools, and consistent message/composer gutters. | Agreed      | Explicit user repair request, 2026-10-28                                                                                                                                           | -          |
| C1  | Preserve Owner/run/request authorization fences, other live runs, account secrets, pairing, and unrelated dirty work.                 | Verified    | Session authorization and repository concurrency rules, 2026-10-28                                                                                                                 | -          |

## Problem frame

Repair the three observed contracts O1-O3 and validate G1 on the deployed Host/Web. Preserve C1. Model discovery and basic single-turn inference already work; do not replace the proxy, weaken approval validation, reset accounts, or redesign unrelated chat surfaces.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                        |
| ------------ | ------ | -------------------------------------------------------------------------------------------------- |
| scale        | medium | Workspace lifecycle, approval identity and chat layout are distinct ownership boundaries.          |
| technical    | medium | Existing mechanisms can be extended; exact identity ownership needs tracing.                       |
| coupling     | high   | Paired browser, Host, Brain and persisted workspace state cross process boundaries.                |
| requirement  | low    | Three concrete failures and the required live acceptance flow are agreed.                          |
| verification | high   | Requires real model, Owner transport, terminal approval, old-state recovery and rendered geometry. |
| risk         | high   | An incorrect reclaim or relaxed identity match could authorize another run's action.               |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                           | Severity | Source                                          | Claim                                                                                                     | Refuted by                                                               |
| --- | ----------------------------------------------------------------------- | -------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | Repair releases another live run or strands an old conversation.        | high     | Incident evidence O1; concurrency risk catalog  | Only renderer-owned runs are settled; existing orphan records are preserved and old sessions can recover. | Live competing run is reclaimed or old session still refuses.            |
| R2  | Approval fix accepts a different device/run/request's response.         | high     | Strict existing identity validator; lens STRIDE | Legitimate approval context matches while all identity fences remain enforced.                            | Cross-peer/run/request response succeeds or real Allow once still hangs. |
| R3  | Layout patch shifts only one renderer or clips wide content.            | medium   | User screenshot O3; AI Elements ownership rules | Paired history/live transcript rows and composer share the same bounded column at relevant widths.        | Geometry differs or horizontal overflow appears.                         |
| R4  | Deployment overwrites concurrent work or changes account/Host identity. | medium   | concurrent-tree-safety; prior deployment record | Deploy only owned files/artifacts with rollback and unchanged credentials/certificate.                    | Unrelated diff is absorbed or pairing is lost.                           |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk     | Method                                                             | Independence | Evidence                                                                                                                                                                                                                                  | Coverage                                                                                                                                                           | Status |
| --- | -------- | ------------------------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| V1  | R1       | Failing lifecycle regression, then relevant unit/integration tests | tool         | Two pre-fix failures; resolved/prebuilt lease tests and no-lease preservation pass; related run-lease/turn-tracker suites pass                                                                                                            | Single renderer acquisition, alias/trust preservation, retained busy fences; live old-state recovery belongs to V4                                                 | passed |
| V2  | R2       | Failing identity regressions plus negative identity-fence tests    | tool         | Queue/cache/stream regressions red then green; cached gate/plugin/context cancellation red then green; 227 sidecar tests pass on the remote machine; 46 remote_execution validation tests pass                                            | Original authenticated caller; current turn context including Host-origin undefined; failed dispatch retry; exec/cancel share one snapshot; server fences retained | passed |
| V3  | R3       | Co-located layout regression and real DOM geometry                 | real-env     | layout-before.json and layout-after.json; 390px edges 12–370, 707px edges 20–679, 1440px edges 448–1240; assistant/user/composer boundaries match, no document overflow; 86 layout tests pass                                             | Paired timeline history/live rows and responsive native-gutter compensation; error/notice wrapper covered by unit tests                                            | passed |
| V4  | R1,R2,R4 | Build and real deployed paired Web smoke                           | real-env     | 129 static pages, 299 assets; old session three turns plus reload recall; retained later-turn Allow once returns n37-091-230 and Linux; active stream Stop gives proxy 499/cancelled, next send succeeds; fresh session two turns succeed | Existing orphan unchanged; scoped runs settled; account and Owner pairing preserved; only Web and idle sidecar reloaded, Host binary/certificate unchanged         | passed |
| V5  | R2,R3,R4 | Scoped lint/type/build, diff review and independent review         | subagent     | 12 Jest suites/777 tests; remote 5 sidecar suites/227 tests; full final lint, sidecar typechecks, i18n parity/lint and sort pass; test-gap/i18n/security/PII reviews clean; same 11 baseline root type diagnostics                        | 22 owned source/test hashes match deployment; no authorization broadening, PII bypass, new UI labels or unrelated staged paths                                     | passed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                                                                                            | Action     | Based on          | Reversal trigger                                                                                  |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| D1  | 2026-10-28 | Trace each failure boundary and record discriminating regressions before edits.                                                                                                                                                                                                     | diagnose   | O1,O2,O3,G1,C1    | Evidence places the failure in a different boundary.                                              |
| D2  | 2026-10-28 | Remove only the redundant Host-acquisition envelope after renderer lease ownership; preserve hosted callers and old orphan records. Route cached caller-bound approvals directly and retain cache on rejection. Reuse reading gutters and measure native scrollbar inset for docks. | implement  | O1,O2,O3,H1,H3,C1 | Consecutive turns, real approval or responsive geometry still fail.                               |
| D4  | 2026-10-28 | Refresh the admitted turn context on retained option objects; cached plugin/reviewer/code bridges read a live getter and capture one context per request, shared with cancellation.                                                                                                 | implement  | H4,C1             | Later-turn or Host-origin requests retain an old context, or cancellation adopts the next caller. |
| D3  | 2026-10-28 | Build a new static artifact using only the 16 owned source/test files; retain current service artifact and rollback.                                                                                                                                                                | experiment | V1,V2,V5,C1       | Remote source hash guard, build, staged assets or live acceptance fail.                           |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                | From     | Why still open                                                                            | Next action                                                                   | Status |
| --- | ----------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| X1  | Deployed acceptance and responsive geometry were pending.               | V3,V4,H4 | All requested live checks now pass; report and screenshots retained.                      | No further repair action required.                                            | closed |
| X2  | Full root typecheck still reports the same 11 pre-existing diagnostics. | V5       | Baseline comparison proves zero added/removed diagnostics; unrelated source is preserved. | Report the existing global gate limitation separately from repair acceptance. | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                           | How / when measured                                              | Result                                                                                                                                      | Status |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Existing and fresh conversations continue after completed turns. | Real paired browser, public Host runs and matching proxy results | Old session three consecutive sends, reload/context recovery and post-Stop send pass; fresh two-turn recall passes; all scoped runs settled | met    |
| M2  | Approved read-only hostname command returns real Host output.    | Real Allow once, tool_result and rendered final answer           | Retained later-turn bash tool returns n37-091-230 and Linux with isError=false; final answer rendered                                       | met    |
| M3  | Message and composer columns align without clipping.             | Before/after DOM rectangles and screenshots across widths        | Assistant left and user right match composer bounds at 390,707,1440px; scrollWidth equals viewport width                                    | met    |

Repair acceptance is met. The ledger remains `verifying` because X2 is an unrelated existing root typecheck baseline, not an unfinished repair behavior.

Detailed commands, proof boundaries and artifacts: [runtime report](../../.cache/cognia-headless-setup/chat-repair-2026-10-28/report.md).
