# Evidence ledger: sidechat mechanism audit

- Status: verifying
- Lane: standard
- Created: 2026-11-13
- Updated: 2026-11-13 (remediation round)
- Related: `docs/content/docs/en/chat/side-chat.mdx`; `docs/evidence/2026-11-13-sidechat-mechanism-audit.probes.mjs`

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 校验一下现在的sidechat机制，和业内常规的进行对比，看看存在什么缺口

Follow-up, 2026-11-13: 做一次对抗性审查，看看有没有更多的问题

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                        | State       | Basis                                                                                                                                   | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Side chats are embedded resource-workbench sessions attached through surfaceBinding, with a separate transcript and provider identity.           | Observed    | lib/context-workbench/resource-session.ts; lib/db/resource-workbench-sessions.ts, checked-out source, 2026-11-13.                       | -          |
| O2  | Parent context is a bounded text/tool-summary snapshot with an SDK-bound delta cursor.                                                           | Observed    | lib/chat/session-aside-context.ts; lib/context-workbench/aside-context-dispatch.ts, 2026-11-13.                                         | -          |
| G1  | Assess the current mechanism against documented industry patterns and identify actionable gaps with evidence strength.                           | Agreed      | User request, 2026-11-13.                                                                                                               | -          |
| C1  | Assessment only; preserve concurrent changes and avoid real-provider sends or product fixes.                                                     | Verified    | Scope inferred from the user's audit request; concurrent checkout observed, 2026-11-13.                                                 | G1         |
| Q1  | Do lifecycle, dispatch, context and read-only claims hold across supported paths?                                                                | Answered    | Focused tests plus independent fake-provider and pure probes establish scoped defects; real environments remain unverified, 2026-11-13. | O1, O2     |
| O3  | The actual standalone engine accepts raw synthetic parent email after the controller-equivalent message rebuild.                                 | Verified    | Reproduction command below; fake stream called once, fullPayloadPiiSafe=false, real provider calls=0, 2026-11-13.                       | O2         |
| O4  | Promotion retains a prefix that three routing guards reject; text projection collapses meaningful formatting.                                    | Verified    | Seven pure probes plus source call-path trace, 2026-11-13.                                                                              | O1, O2     |
| H1  | All final provider-bound parent context passes the workbench PII gate.                                                                           | Invalidated | Actual engine reproduction and positive control, 2026-11-13; standalone path only.                                                      | O2         |
| H2  | A side chat's fresh parent ceiling incorporates current parent tool restrictions even before another parent send.                                | Invalidated | Actual resolver allow/deny probes and native inventory assertions, 2026-11-13; see A1.                                                  | O1         |
| O6  | Existing asides retain broader tools until the newly restricted parent resolves another turn.                                                    | Verified    | Root adversarial runner: allowlist and denylist cases, real resolveSendOptions; no tool execution, 2026-11-13.                          | O1         |
| O7  | Controlled Dexie interleavings overwrite promoted identity, insert after parent deletion and delete a promoted conversation during orphan sweep. | Verified    | Lifecycle runner: production functions with fake-indexeddb and barriers, three reproductions, 2026-11-13.                               | O1         |
| O8  | Refused queued questions and asynchronous Composer flows can lose or unintentionally combine user input.                                         | Verified    | Handoff runner: real controller rejection and full Composer, six assertions including a positive control, 2026-11-13.                   | O1         |
| O9  | Native history preparation ignores replacesHistory under an otherwise valid retained SDK session.                                                | Verified    | Actual imported helper and injection-protection positive control, 2026-11-13; real native SDK behavior remains unaccepted.              | O2         |
| O5  | Current source deliberately excludes embedded asides from search/mentions and phones; delta delivery is native-SDK-specific.                     | Verified    | Exposure, entry-point and history-mode source; focused tests and pure probes, 2026-11-13.                                               | O1, O2     |

## Problem frame

Audit the runtime entry points, parent-context delivery, permissions, handoff, lifecycle and platform boundaries (G1). Compare ephemeral side questions, durable side conversations and forks separately. Success is a reproducible assessment that distinguishes confirmed defects, capability gaps, intentional trade-offs and untested environments. Product implementation and provider/device acceptance are outside this assessment (C1).

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                    |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| scale        | medium | UI, chat controller, context builder, runtime policy, Dexie and dock routing.                                  |
| technical    | medium | SDK history differs between built-in, external and browser transports.                                         |
| coupling     | high   | Shared transcript/runtime, main-thread steering, provider sessions and desktop/web layout.                     |
| requirement  | low    | Read-only audit with a clear comparison goal.                                                                  |
| verification | high   | Deterministic probes are available; live provider, native desktop and device behavior are separate acceptance. |
| risk         | low    | Audit changes documentation only; inspected mechanisms include high-impact authority boundaries.               |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                                                         | Severity | Source                                                            | Claim                                                                                    | Refuted by                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| R1  | Misleading context causes answers based on stale, missing or unintended parent material.                              | high     | Docs contract; FMEA: context pipeline                             | A bounded snapshot/delta accurately represents its declared parent scope.                | A deterministic edit, multimodal or replay sequence yields missing or misleading context without disclosure.     |
| R2  | A side chat mutates beyond user or parent authority.                                                                  | high     | Repository risk catalog; STRIDE: authority boundary               | Read-only and parent ceilings bind every runtime lane.                                   | An allowed side-chat path can invoke a forbidden mutation or regain revoked authority.                           |
| R3  | Requests, handoffs or durable conversations become unreachable or disappear.                                          | medium   | FMEA: routing/lifecycle; prior artifact audit in checked-out docs | Every supported entry reaches its intended aside and durable material stays retrievable. | A supported-width invocation leaves a request unconsumed, or lifecycle loses required history.                   |
| R4  | The comparison conflates distinct product modes or unsupported internals.                                             | medium   | Primary product documentation                                     | Comparisons describe documented behavior and label inference.                            | A claimed industry requirement is unsupported by fetched primary documentation.                                  |
| R5  | Canonical parent text is reintroduced after workbench redaction and reaches a provider without the required PII gate. | high     | Fresh-context reviewer; repository outbound-text catalog          | Every final parent-context payload passes the same gate as other model-bound content.    | The composed provider-bound messages retain a synthetic PII sentinel while the final first-provider gate passes. |

| R6 | Parent authority changes are enforced only after the parent's next send. | high | Adversarial STRIDE review; resolver's current-ceiling contract | A newly restricted parent's aside cannot retain broader tools. | Aside resolution still allows a tool denied by the current parent row before parent resend. |
| R7 | Concurrent lifecycle operations overwrite newer identity, context or ownership. | high | Fresh lifecycle reviewer; failure-injection checklist | Clear/delete/promotion and initialization are ordered safely. | A controlled stale ensure recreates or downgrades a newer durable session. |
| R8 | Asynchronous entry/handoff loses text, mixes sessions or reports an unsent request as sent. | medium | Fresh control-chain reviewer; FMEA | Accepted questions remain correctly addressed and recoverable. | A delayed send or submit loses a draft or routes material to the wrong session. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk       | Method                                                                         | Independence   | Evidence                                                                                                                           | Coverage                                                                                                                    | Status |
| --- | ---------- | ------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1, R2, R3 | Run relevant existing Jest tests through pnpm test.                            | tool           | Reproduction commands below: 13 suites / 166 tests and 5 suites / 122 tests passed.                                                | Existing headless assertions only; React act warnings in panel tests and an empty SDK-tool warning did not fail assertions. | passed |
| V2  | R1, R3     | Run isolated falsification probes against owning source.                       | tool           | `node docs/evidence/2026-11-13-sidechat-mechanism-audit.probes.mjs`: 7/7 observed-behavior assertions reproduced.                  | Synthetic inputs; reproducing a gap is not a claim of product correctness.                                                  | passed |
| V3  | R2, R3, R5 | Independent failure hunt using system model and contracts.                     | fresh-reviewer | Independent reviewer reported F1/F2; reconciled with owning source and deterministic probes.                                       | Reviewer received the system model without parent conclusions; no claim of exhaustive absence of defects.                   | passed |
| V4  | R4         | Fetch current primary product documentation.                                   | tool           | Fetched full Claude Code, Cursor and official OpenAI pages listed under Industry comparison, 2026-11-13.                           | Publicly documented guarantees; no inference about vendor internals.                                                        | passed |
| V5  | R1, R2, R3 | Trace complete send, handoff and lifecycle call paths.                         | self           | Source paths and line anchors recorded in mechanism/findings; earlier tablet candidate not carried forward without reproduction.   | Current checkout; does not establish real-provider or native behavior.                                                      | passed |
| V6  | R5         | Isolate final standalone message composition and gate with synthetic PII only. | tool           | Probe script with `--standalone`: 1 suite / 2 tests passed; fakeStreamCalls=1, fullPayloadPiiSafe=false; positive control blocked. | Actual engine and redactor, controller-equivalent helper composition; no full React controller or external provider.        | passed |

| V7 | R6 | Compare current parent and existing aside send options before and after the parent re-resolves. | tool | Root adversarial runner: two resolver assertions reproduced the gap; native Read inventory and deny-Write controls checked. | No tool execution or external send; persisted parent config and registry state controlled. | passed |
| V8 | R1, R3, R7, R8 | Three independent adversarial reviews plus controlled race reproductions. | fresh-reviewer | Three reviews reconciled; lifecycle 1 suite/3 tests, handoff 2 suites/6 tests, root 2 suites/4 tests passed. | Real imported functions/controllers or full Composer with declared seams; no live user data, browser or native provider. | passed |
| V11 | R1, R3, R6, R7, R8 | Product round: Codex jobs A (clear retirement incl. host-state truncate + remote reset marker), D (scoped discovery), B (source links), C (inheritance chip/pins/attach), each reviewed and rerun independently. | other-model | Own reruns: A 470 + 576, D 533, B 314, C 221 tests passed; companion-api:check, i18n:build:check, lint:i18n, audit:colocated-tests pass; root typecheck 21 errors, all in files outside this work. | No browser/Tauri/paired-host run; Rust test in cognia-companion-rpc blocked by foreign cognia-automation compile errors. | passed |
| V10 | R1, R2, R3, R5, R6, R7, R8 | Remediation: Codex gpt-6.1-sol implement jobs reviewed hunk by hunk, then rerun independently. | other-model | Own reruns: send path 5 suites / 153 tests (+ send-options 75 after the external-agent scope fix); lifecycle/routing 12 suites / 503 tests; input/handoff/context 10 suites / 394 tests, all passed. | Fake-indexeddb, JSDOM and mocked provider seams; no browser, Tauri, real provider or multi-window run. The audit probe runners assert the pre-fix defects and are expected to fail now. | passed |
| V9 | R1 | Challenge native history replacement and cursor acknowledgment. | tool | Root runner executes actual helper with a rebuilding positive control; context runner emits three helper-level observations. | Native SDK fault acceptance still required for cursor risk and end-to-end regenerate effect. | passed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Action    | Based on           | Reversal trigger                                                                                                     |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| D1  | 2026-11-13 | Diagnose and compare before proposing implementation; retain separate evidence levels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | diagnose  | G1, C1, O1, O2     | User requests changes or new evidence changes the mechanism model.                                                   |
| D2  | 2026-11-13 | Re-enter risk discovery after the independent reviewer identified a possible final-payload redaction overwrite; verify before assigning severity.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | diagnose  | C1, O2             | Downstream compulsory redaction disproves the candidate.                                                             |
| D3  | 2026-11-13 | Publish the scoped audit with F1 prioritized for remediation; H1 is disproved, so do not claim blanket outbound safety or close unresolved product risks.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | stop      | G1, C1, O3, O4, O5 | Product fixes requested, or changed source requires rerunning probes.                                                |
| D4  | 2026-11-13 | Reopen diagnosis for an explicitly requested adversarial pass; challenge concurrency, lifecycle, context delivery and handoff contracts independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | diagnose  | G1, C1             | Reproductions rule out the candidates, or three bounded review cycles finish.                                        |
| D6  | 2026-11-13 | User asked to implement. Fix F1, A1-A9, F2, F3, the cheap part of F4 (attachment/omission/truncation markers) and F6 wording; keep Send-to-main merging an existing draft (user decision); leave F4 preview UI, F5, F7, X7, X8 open. A3 re-rated P2 (needs an A4-style orphan with an open panel). A9 limited to native Claude after review found it would retire external-agent aside sessions every turn. F2 guard made fail-closed after review found a plugin-store lookup failed open.                                                                                                               | implement | O3, O6, O7, O8, O9 | A browser/Tauri/provider run contradicts a fix, or the user changes a product decision.                              |
| D7  | 2026-11-13 | User asked to fix X6 here. Make refusal a returned value rather than a throw (no double error UI), and define `false` as refused-before-transcript after review found post-append refusals would duplicate text.                                                                                                                                                                                                                                                                                                                                                                                          | implement | O8                 | A host relies on `send` resolving `void`, or a real run shows duplicated or lost drafts.                             |
| D8  | 2026-11-13 | Product decisions (user): (1) F5 — side chats are searchable knowledge within their parent conversation/workspace scope, and handoff carries a source link (ContextRef) back to the side chat message; no global exposure. (2) Clearing the main thread retires every side chat's inherited parent context and native provider history (side chat transcript kept, fresh snapshot next turn, in-chat notice). (3) /btw stays durable like /side. (4) F4 — inherited-scope summary chip above the side chat composer with a list to manually include messages/attachments; no automatic image inheritance. | implement | O5                 | A personal-history visibility (ADR-0243) constraint conflicts with scoped discovery, or the user revises a decision. |
| D9  | 2026-11-14 | Remote external-agent side chats: full backward-compatible fix (user). Optional `resetExternalSession` on `external_agent_run_turn`, sent only to Hosts advertising `external_agent_run_turn_reset_session`; older Hosts get an honest in-panel notice. Parent-clear retirement is best-effort on the UI path (never fails a committed clear) and recorded/retried on the host-state path.                                                                                                                                                                                                                | implement | O6                 | A Host ignores the marker semantics, or a real paired run shows the old native session re-attached.                  |
| D5  | 2026-11-13 | Deliver nine additional scoped findings after one decomposed adversarial cycle; do not equate helper evidence with live native acceptance. User explicitly declined cross-model review.                                                                                                                                                                                                                                                                                                                                                                                                                   | stop      | C1, O6, O7, O8, O9 | Changed owning source, a refuting integration result, or a request for remediation.                                  |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                                                                                                                                                                 | From                   | Why still open                                                                | Next action                                                                       | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| X1  | Standalone redaction defect fixed (shared gated rebuild in the controller; controller-to-standalone regression).                                                                                                                                                         | R5, O3                 | Fixed and tested at the controller seam; no real BYOK provider run.           | Real-provider smoke on a BYOK aside.                                              | closed |
| X2  | F2/F3/F4/F5 implemented per D8: scoped discovery (`withScopedAsides`: ⌘K, message search, @chat, @msg; headless context and project_history_search unchanged), handoff source chip, inherited-scope chip with pins and explicit attachments. Not run in a browser/Tauri. | R1, R3, O4, O5         | Jest/jsdom only.                                                              | Browser/Tauri pass over the chip, pins, attach, ⌘K reveal and source chip.        | open   |
| X3  | Real provider, Tauri, phone and complete UI flow behavior are not accepted here.                                                                                                                                                                                         | R1, R2, R3, V1, V5, V6 | Headless tests and fake-provider probes do not establish these environments.  | Controlled browser flow, native/external smoke and separate phone scope decision. | open   |
| X4  | Token/cache/latency benefits are unmeasured; comparison does not expose vendor internals.                                                                                                                                                                                | R4, O5                 | Public product documentation and functional tests do not measure performance. | Correct F6 wording and measure representative repeated-turn workloads.            | open   |

| X5 | A1-A4 fixed (current parent tool filter folded into the aside ceiling; conditional create/repair/promote; orphan sweep rechecks in prepare and transaction). Real two-window and native tool-boundary acceptance not run. | R6, R7, O6, O7 | Headless tests only. | Two-window Tauri/browser run and a native tool inventory check on a restricted parent. | open |
| X6 | A5-A9 fixed, including Send to main: `send` resolves `false` only for a refusal before the input reaches the transcript (`inputReachedTranscript`), the desktop workspace / ChatPaneGroup / ChatView pass it through, and Composer restores the draft or handoff quote on `false`. Not accepted in a real browser or Tauri. | R8, O8, O9 | Headless tests only (11 suites / 1014 tests). | Browser/Tauri run: hit the concurrency cap from the main composer and from Send to main. | open |
| X7 | Transport acknowledgment may advance the context cursor before provider history contains the payload. | R1, V9 | Helper behavior reproduced; no actual native failure established missing provider history. | Inject a native failure after command acceptance and inspect retained history plus next aside prompt. | open |
| X8 | Aside clear omits standard lifecycle/revision/tombstone cleanup; sync/media consequences remain untested. | R3, R7, V8 | Source discrepancy only; journal replay candidate was refuted by digest checks. | Controlled two-client delta and retention tests before reporting a sync or replay defect. | open |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                       | How / when measured                                           | Result                                                                                                              | Status |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Deliver a prioritized assessment with reproducible evidence and a primary-source comparison. | Inspect this report against the original request, 2026-11-13. | Three local defects, four capability/documentation/acceptance gaps, scoped evidence and remediation order recorded. | met    |

| M2 | Find additional actionable failures and challenge the first audit's assumptions. | Reconcile independent reviewers and executable counterexamples, 2026-11-13. | Nine additional scoped failures, two open risk candidates, and rejected counterexamples documented; 5 suites/13 assertions plus 3 helper observations. | met |

## Assessment scope and interpretation

This assesses the **checked-out source on 2026-11-13**, based on HEAD
`7d3dd4473524207654ada2c241e6b73858079dbb` plus concurrent local changes.
It does not establish what an installed or deployed build contains. No product
fix, provider request, database migration or commit is part of this task.

The adversarial follow-up below supersedes the first pass's blanket lifecycle
and authority conclusions. F1-F7 remain the original assessment; A1-A9 are
additional findings with separately stated evidence strength.

The mechanism is a durable side conversation, broadly aligned with Cursor's
documented model. Its core building blocks already exist: separate embedded
transcripts, multiple asides, follow-ups, read-only defaults, parent permission
ceilings, safe-runtime fallback, promotion, and explicit handoff. Treating it
as merely a missing `/btw` command would misdiagnose the current state.

### Mechanism verified in source

| Stage     | Current behavior                                                                                                                                                                                                  | Owning source                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Entry     | `/btw`, `/side`, shortcut, dock and selection flows resolve the attached conversation; queued questions survive a closed dock in process memory.                                                                  | `lib/slash-commands/actions/side-chat.ts`; `hooks/chat/use-sidechat-shortcut.ts`; `stores/chat/side-chat-request-store.ts` |
| Identity  | A `resource-workbench` row has its own messages and SDK/runtime identity, indexed by the resource binding. Primary IDs are deterministic; additional asides get minted suffixes.                                  | `lib/context-workbench/resource-session.ts`; `lib/db/resource-workbench-sessions.ts`                                       |
| Context   | The visible parent branch is projected through personal-history visibility; up to 24 quotable rows / 8,000 characters are rendered, with up to eight tool facts per row and 280-character result excerpts.        | `lib/chat/session-aside-context.ts`; `hooks/chat/use-claude-chat-controller.ts`                                            |
| Delivery  | Matching native Claude SDK resumes can send deltas. External and rebuilding providers receive full bounded snapshots each turn. Streaming parent replies are marked incomplete and not acknowledged as finalized. | `asideProviderHistoryMode`; `prepareAsideContext`; `createAsideContextDispatch`                                            |
| Authority | New asides are read-only. The built-in lane restricts actual native tools and plugin manifests; external lanes require attested plan authority or fall back. Parent ceilings are resolved again at send time.     | `lib/context-workbench/session-aside-runtime.ts`; `lib/claude/build-options.ts:1205`, `:1587`, `:5288`                     |
| Handoff   | A reply can be quoted into the addressed parent draft or explicitly submitted through its normal composer path. Missing composers receive a staged draft instead.                                                 | `components/chat/message-renderer.tsx:799`; `lib/chat/composer-append.ts`                                                  |
| Lifecycle | Clear invalidates live transcript runtime and SDK links; delete uses the session cascade; promotion preserves identity and messages. Parent deletion includes attached asides, while archiving retains them.      | `lib/db/resource-workbench-sessions.ts`; `lib/db/sessions.ts`; `lib/db/session-aside-orphans.ts`                           |

## Industry comparison

These are documented product patterns, **not an industry standard**. Public
documentation does not establish the vendors' internal context windows,
permission implementations or privacy guarantees. Three patterns must remain
distinct: an ephemeral side question, a durable side conversation and a fork.

| Product / pattern                    | Documented behavior                                                                                                                                                                                 | Comparison with Cognia                                                                                                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code terminal `/btw`          | Independent questions use existing conversation context and no tools. Main history stays untouched. The terminal keeps exchanges in memory and replays the newest 20; fork can continue with tools. | Cognia already offers durable follow-ups and optional tools. Its bounded, lossy text projection is a different context contract from answering from the existing conversation.                       |
| Claude Code VS Code `/btw`           | A separate panel supports follow-ups and survives reloads under the extension's retention policy.                                                                                                   | Durability and follow-ups are not missing in Cognia. Do not generalize terminal ephemerality to every Claude surface.                                                                                |
| Cursor side chats, 3.11 / 2026-07-10 | Persistent agent conversations run alongside the main agent, begin with main-chat context, default to reading/searching, and can be at-mentioned from the main thread.                              | This is the closest product model. Cognia's main parity gaps are discoverability and reference-based return of context. Cursor's exact context-selection algorithm is not documented by this source. |
| Codex Remote `/side`                 | A connected side conversation can start with a prompt or selected transcript text; it helps users understand ongoing work from a phone.                                                             | Command and selection entry points are present. Cognia deliberately excludes phones. This source does not establish Codex's exact persistence or context budget.                                     |

Sources fetched on 2026-11-13:

- [Claude Code interactive mode: side questions](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw)
- [Cursor: Side Chats and Conversation Search](https://cursor.com/changelog/side-chat)
- [Official OpenAI documentation: Codex Remote side chats](https://developers.openai.com/blog/mastering-codex-remote-for-engineering#3-use-side-chats-as-a-branch-of-thought)

## Findings and recommended order

### F1 — P1: final standalone context can bypass workbench redaction

**Classification:** confirmed local boundary defect; synthetic execution
evidence below. This is a violation of Cognia's own outbound-text invariant,
not a claim about competitors' privacy behavior.

The controller first gates `providerPayload.messages`, then rebuilds parent
context from canonical source at send time. It gates `effectiveContent`, but
overwrites `providerPayload.messages` with `withWorkbenchMessageContext(...)`
using the raw fresh context (`hooks/chat/use-claude-chat-controller.ts:6742`).
The standalone engine receives that message array at `:6818`.

`withWorkbenchMessageContext` prepends derived parent context to the last
**user** message. The standalone first-provider gate checks instructions and
non-user messages only (`lib/ai/chat/standalone-engine.ts:300-310`); only a
provider fallback applies the full-payload check. Consequently, parent-derived
PII inside that user part can escape the gate that already redacted it.

Trigger: a session-bound aside uses the standalone/BYOK provider path, and
fresh parent context contains text matched by the PII detector. This finding
does not establish a leak on native Claude or external-agent paths, and no
real private material was sent during this audit.

Next: gate the final rebuilt payload, preserve the distinction between user
authorship and derived context, and add an integration regression at the
controller-to-engine boundary. Keep legitimate direct-user-input policy
separate from derived-parent-context policy.

### F2 — P2: a promoted conversation is still rejected as a nested aside

**Classification:** confirmed deterministic routing defect.

Promotion changes `kind` to `direct` and drops embedded binding markers, but
preserves the `resource-workbench:*` ID (`lib/db/resource-workbench-sessions.ts:212`).
Three guards still infer nesting from that ID prefix:

- `lib/slash-commands/actions/side-chat.ts:51` silently returns.
- `lib/context-workbench/resource-session.ts:66` refuses the parent binding.
- `components/artifacts/chat-dock-panels.tsx:937` hides the side-chat panel.

Reproduction: promote an aside, open the resulting ordinary conversation and
invoke `/side`. The pure probe confirms a non-embedded `direct` session still
returns `null` for its context binding. The shortcut calls `openSideChat`
directly, so it can create/enqueue a new aside that the panel guard cannot
render. The source traces that route; the shortcut UI was not driven live.

Next: base nesting checks on current session semantics, preserving promoted
IDs and permalinks. Add a promotion → new aside acceptance test.

### F3 — P2: parent code and structured text lose meaningful formatting

**Classification:** confirmed context-fidelity defect.

`renderAsideMessage` reuses the Inbox search projection
(`lib/chat/session-aside-context.ts:84`). That helper collapses every whitespace
run (`lib/inbox/extract-plain-text.ts:81`). It is suitable for a search snippet,
but loses line breaks, indentation, Markdown fences and table structure in
model context. A synthetic YAML input becomes
`User: root: child: true other: false`.

This affects questions about pasted code/configuration even when the complete
message fits the budget. A read-only tool can sometimes recover a real file,
but cannot recover the original structure of an unpersisted pasted snippet.

Next: retain the existing context budget and tool summaries, while preserving
formatting in text/code parts. Do not expand the unrelated Inbox projection.

### F4 — P2: the parent-context boundary is lossy and insufficiently visible

**Classification:** capability and transparency gap; bounded context is an
intentional trade-off, not itself a defect.

The pure probes show:

- A parent `file` part, including an image file, is omitted entirely. The
  aside can receive “What is wrong with this diagram?” without a filename,
  attachment placeholder or image.
- A legacy `image` part becomes an alt-text placeholder, without vision input.
- The oldest material beyond 24 quotable rows or 8,000 characters disappears
  without a global omission marker. A single over-budget message is sliced
  from its tail and may lose even its speaker label.

The UI indicates read-only/fallback state, but provides no per-turn preview of
the inherited parent slice, omitted attachments or truncation. Documentation
mentions the text limit; that does not make the actual model-visible boundary
inspectable during the interaction.

Next: expose source scope and omission notices; allow explicit selection or
attachment of the required parent material. Multimodal inheritance should
respect current provider capability and the same content gates. Full-history
copying on every turn would be an expensive response to the wrong problem.

### F5 — P2: durable knowledge is difficult to find or return with provenance

**Classification:** intentional exposure policy with a product-level gap
relative to Cursor's documented durable/at-mention model.

`isSessionExposed(..., "global-search")` rejects resource-workbench sessions
(`lib/chat/session-exposure.ts:20`). The global session provider and `@chat:`
candidate source both use that channel (`lib/global-search/providers/sessions.ts:43`;
`lib/chat/mentions/entity-sources.ts:886`). The same exclusion is applied to
history-reference lookup. An aside can be retained and synced while remaining
absent from these discovery paths; promotion is a workaround.

Handoff is a plain Markdown quote of `extractText(message)`, with no attached
source-session/message identity or structured tool/image payload
(`components/chat/message-renderer.tsx:799-828`). It safely targets the parent
composer, but copying the conclusion is not equivalent to a traceable link to
the investigation that produced it.

Next: reuse the existing mention/reference and search mechanisms with an
explicit parent/workspace-scoped aside policy. Preserve source message IDs
when bringing conclusions back. Do not make every embedded transcript public
to all existing exposure channels.

### F6 — P3: incremental-context and low-cost claims need narrower wording

**Classification:** documentation mismatch and unmeasured performance.

The guide says later turns send only new parent material
(`docs/content/docs/en/chat/side-chat.mdx:38`). In source,
`asideProviderHistoryMode` returns `rebuild` for external engines and browser
standalone providers (`hooks/chat/use-claude-chat-controller.ts:427-440`). Those
paths resend the full bounded snapshot. The pure probe demonstrates that the
same parent yields zero context with a matching SDK resume, but a full
snapshot without it.

Existing per-run usage infrastructure should be reused for measurement. This
audit did not measure cache hit rate, time to first token, incremental token
cost, or aggregate parent-plus-aside cost. Prompt caching benefits must not be
inferred from functional tests. An optional quick-question mode is a product
choice, not a missing universal requirement.

Next: scope the guide's delta guarantee to the native SDK path; benchmark
representative long parent / repeated aside turns before adding optimization.

### F7 — P3: phone access and real-environment acceptance remain separate gaps

**Classification:** intentional platform scope plus verification debt.

Cognia explicitly rejects phone/native-mobile side-chat entry. Codex Remote
documents a phone flow, so mobile parity is a possible roadmap item rather
than an accidental implementation bug. This audit also found only dock-tab
reachability assertions in the matching E2E source
(`tests/e2e/web/dock-tabs.spec.ts:92-100`); it did not find a complete
side-chat send → concurrent parent → handoff → reload/promotion E2E flow.

Next: first add a deterministic browser flow with a controlled provider, then
separately accept native/external provider behavior. Decide phone scope on
user value rather than assuming every vendor feature must be copied.

## Counterchecks and non-findings

- Read-only is enforced with tool inventories, permission grants and fallback
  routing, beyond prompt wording. The first pass established no escalation;
  the follow-up's A1 disproves the broader assumption that an existing aside
  always inherits the current parent's tool ceiling. Passing mocked tests is
  not external-provider authority acceptance.
- Main-thread handoff uses an addressed composer and reports a draft when it
  cannot submit; it is not an unconditional, silent auto-send.
- Multiple asides, rename/clear/delete/promotion and parent-delete cascade are
  already implemented; they are not missing features.
- The earlier artifact audit's tablet handoff concern cannot be copied forward
  unchanged: the current artifact surface explicitly hands unknown session-tab
  reveals to the session surface (`components/artifacts/artifact-dock.tsx:417`).
  This audit does not claim a current tablet routing failure without a new
  reproduction.
- Retention and authenticated sync are distinct from search exposure. The
  search finding does not imply that asides are never persisted or synced.

## Proposed next increment

1. Close F1 at the final derived-context boundary, with a fake-provider
   regression that inspects the actual engine request.
2. Repair F2 and F3 using existing session semantics and context projection.
3. Improve F4/F5 together: visible inherited scope plus source-aware return of
   conclusions and parent-scoped discovery. Reuse current references.
4. Correct F6 wording and measure costs before choosing an optimization.
   Treat F7 phone support as a separate product decision.

No implementation has been authorized or performed by this assessment.

## Reproduction and verification results

All commands ran from the repository root on macOS / Apple Silicon. No
coverage measurement, full build or repository-wide lint was required for this
documentation-and-probe assessment. No product source was changed.

Existing tests: **18 suites / 288 tests passed**, in two focused invocations:

```sh
pnpm test --runInBand --watch=false --runTestsByPath \
  lib/chat/session-aside-context.test.ts \
  lib/context-workbench/aside-context-dispatch.test.ts \
  lib/context-workbench/session-aside-runtime.test.ts \
  lib/context-workbench/resource-session.test.ts \
  lib/db/resource-workbench-sessions.test.ts \
  lib/db/session-aside-orphans.test.ts \
  lib/claude/build-options-aside.test.ts \
  lib/slash-commands/actions/side-chat.test.ts \
  components/context-workbench/resource-workbench-chat-panel.test.tsx \
  components/context-workbench/aside-switcher.test.tsx \
  hooks/chat/use-sidechat-shortcut.test.tsx \
  stores/chat/side-chat-request-store.test.ts \
  lib/chat/session-config-inheritance.test.ts

pnpm test --runInBand --watch=false --runTestsByPath \
  hooks/chat/use-claude-chat-controller.test.ts \
  lib/ai/chat/standalone-engine.test.ts \
  lib/context-workbench/provider-payload.test.ts \
  lib/context-workbench/provider-context.test.ts \
  lib/chat/session-exposure.test.ts
```

Run all audit probes, including the actual-engine fake-provider regression:

```sh
node docs/evidence/2026-11-13-sidechat-mechanism-audit.probes.mjs --standalone
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check \
  docs/evidence/2026-11-13-sidechat-mechanism-audit.md --final
```

The audit runner generates its isolated Jest fixture/config under
`.cache/sidechat-mechanism-audit/`, reusing the existing engine test fixture
with the real redactor restored. It asserts the **observed defect** so a
subsequent fix will change the expected reproduction result. The positive
control verifies that the gate is actually active.

Observed reproduction result:

```json
{
  "providerCalls": 0,
  "fakeStreamCalls": 1,
  "syntheticEmailReachedFakeStream": true,
  "fullPayloadPiiSafe": false
}
```

Seven pure probes reproduced their specified observations; the fake-provider
suite passed both assertions. Generated evidence:
`.cache/sidechat-mechanism-audit/pure-probe-results.json` and
`.cache/sidechat-mechanism-audit/standalone-pii-probe.log`.

Ledger status remains `verifying` because the product defects and real-environment
residuals are open; the assessment outcome itself is met. No residual was marked
accepted on the user's behalf.

## Adversarial follow-up — 2026-11-13

The user requested another pass to find additional problems. One bounded
adversarial cycle was decomposed into three fresh-context reviews: lifecycle
and ownership; context delivery/history; entry/handoff/composer isolation.
Reviewers received source artifacts and contracts rather than the original
assessment's rationale. The main session independently probed current parent
authority and reran the packaged evidence. The user explicitly chose to skip
cross-model review; no external model CLI was invoked.

The result is **nine additional local implementation findings**, with different
evidence scopes. This is not a count of production incidents. In particular,
A9 establishes a real preparation-function defect, while its native SDK effect
still requires real-environment acceptance. The native cursor candidate remains
a risk rather than a tenth confirmed defect.

| ID  | Priority        | Counterexample                                                                                              | Strongest evidence                                                                                 |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A1  | P1              | Existing aside exceeds the current parent's newly restricted tool set.                                      | Actual send resolver plus native inventory controls.                                               |
| A2  | P1              | Delayed initialization overwrites a successfully promoted conversation and discards its SDK/model identity. | Production ensure/promotion with real Dexie semantics under fake-indexeddb and a barrier.          |
| A3  | P1, conditional | Orphan cleanup deletes a conversation and its messages after successful promotion.                          | Production orphan sweep and deletion cascade with a controlled interleaving.                       |
| A4  | P2              | Initialization inserts a new aside after its parent deletion and tombstone commit.                          | Production ensure/delete/persistMessages; no resurrection of previously deleted messages asserted. |
| A5  | P1              | A refused queued question is consumed without send or draft recovery.                                       | Actual chat controller at the capacity guard, verbatim panel consumer, throwing positive control.  |
| A6  | P2              | Delayed `/side` completion for A clears the matching draft in B.                                            | Full Composer with a delayed repository seam.                                                      |
| A7  | P2              | Handoff can lose a failed quote or auto-submit an unrelated existing draft.                                 | Full Composer with pending/rejected fake onSend and captured payload.                              |
| A8  | P2              | Failed side-chat opening still clears the user's question.                                                  | Full Composer, real slash handler, injected ensure rejection.                                      |
| A9  | P2              | Native regeneration ignores the requested provider-history replacement.                                     | Actual imported preparation helper plus an injection-protection rebuilding control.                |

### A1 — current parent tool restrictions depend on a stale registry

`resolveSessionAsideParentPermission` reads the current parent permission mode
and sandbox policy, but gets tool restrictions from the in-memory resolved
ceiling registry (`lib/claude/build-options.ts:1226-1263`). It does not derive
the current parent's `toolFilter`. The registry is populated when the parent
resolves a send (`:5384`), while the normal filter stage reads the aside's own
snapshot of configuration (`:3130`).

Two actual-resolver probes establish the gap:

- Current parent allowlist is `[Grep]`; an existing read-only aside with its
  earlier `mode: all` still exposes `Read`, including in its native SDK tool
  inventory. Resolving the parent once changes the next aside inventory to
  `[Grep]`.
- Current parent denies `Write`; an unlocked existing aside still resolves to
  `acceptEdits` with no `Write` deny until the parent resolves again. The
  following aside resolution correctly denies it.

The test controls persisted session configuration and registry state. It does
not execute a native write or claim every UI setting change follows this exact
path. It refutes the module's stronger “current parent permissions, never more”
contract. Scope the first pass's read-only conclusions accordingly.

Next: derive the current parent's full authority at the same boundary as
runtime selection, rather than treating a previous send's cached ceiling as
fresh authority. Retain monotonic clamping and exercise both tightened tools
and fallback routes.

### A2 — late ensure overwrites promoted identity

`ensureResourceWorkbenchSession` reads whether a primary exists and later
performs an unconditional repository `put`
(`lib/context-workbench/resource-session.ts:194-253`). That check and write
are not an atomic conditional insert.

The controlled interleaving is:

1. A sees no primary and pauses just before its `put`.
2. B creates that primary, saves messages and explicit `sdkSessionId/model`,
   then successfully promotes it to `direct`.
3. A resumes its original `put` under the same ID.

The durable row becomes `resource-workbench/embedded` again, its SDK/model
fields disappear, and its ordinary-conversation exposure is lost. Existing
messages remain under the hidden row. This is different from F2's sequential
promoted-ID guard. Normal promotion → ensure generation selection works; the
counterexample is a stale writer.

`useResourceWorkbenchSession` cancellation only suppresses `setSession`
(`hooks/chat/use-resource-workbench-session.ts:56-65`); it does not cancel the
already-started persistence. Next: enforce conditional creation and recheck
current identity in the write transaction. Do not overwrite an occupied ID.

### A3 — stale orphan sweep deletes a newly promoted conversation

`purgeOrphanedSessionSideChats` reads bindings and parents, then later deletes
the collected IDs (`lib/db/session-aside-orphans.ts:31-46`). The deletion
cascade rechecks ID existence, but does not recheck that the row is still an
orphaned resource-workbench session (`lib/db/sessions.ts:1309`).

Reproduction: an orphan exists; sweep reads the absent parent and pauses;
promotion succeeds and the row is durably `direct`; sweep resumes and deletes
the ordinary conversation **and all its messages**.

This requires an orphan, such as a legacy row or one created by A4, and a
concurrent promotion. It is not a claim that every promotion is unsafe. The
sweep is reachable through retention cleanup, not just a test-only helper
(`lib/storage/retention.ts:439`). Next: make orphan eligibility part of the
atomic deletion condition rather than carrying stale IDs into a general
session-delete function.

### A4 — pending initialization crosses completed parent deletion

The final ensure write does not recheck the parent or its tombstone
(`lib/context-workbench/resource-session.ts:239-253`). Pausing an ensure before
`put`, completing the real `deleteSession(parent)` cascade, then resuming
creates an embedded aside bound to an absent, tombstoned parent.

The production message persister subsequently accepts a synthetic new message
under that aside. The probe proves **new orphan insertion after deletion**,
not restoration of the parent's deleted old messages. A later orphan sweep
can clean it, but that does not preserve the completed deletion boundary.

Next: serialize parent ownership checks with aside creation or condition the
write on current parent existence and deletion state. Test the same boundary
for additional-aside creation, without assuming this primary-path probe has
already covered it.

### A5 — fulfilled rejection consumes a question without recovery

The panel removes the question with `claim` and restores it only from a rejected
promise (`components/context-workbench/resource-workbench-chat-panel.ts:307-318`).
However, `rejectSend` returns normally unless `throwOnError` was requested
(`hooks/chat/use-claude-chat-controller.ts:1930-1943`). The panel's send callback
does not request that mode.

The actual controller capacity branch (`:2221-2224`) therefore fulfills without
admitting a turn. The source-extracted production consumer removes the queue
entry; no transcript user row, composer recovery intent, provider call or
fallback toast exists. A positive control with `throwOnError: true` rejects
with `concurrent_stream_cap_reached`.

This is an ordinary admission failure, not a hypothetical network race. The
probe mounts the real controller and runs the panel loop verbatim, but does
not mount the entire panel. Main-thread handoff has a related source-level
false-success risk because Composer interprets a fulfilled onSend as success;
that full combined path was not separately mounted.

Next: use the existing explicit error mode for loss-sensitive programmatic
sends and retain recoverable text until admission is known. A fulfilled void
promise must not stand in for “question accepted.”

### A6 — an old command clears a different conversation's matching draft

After awaiting a side command, Composer compares only input text before
clearing it (`components/chat/composer.tsx:2001`). Unlike normal failed-send
recovery, this path does not check the captured session identity.

Full-Composer reproduction: A submits `/side same question`; delay repository
ensure; switch to B and type the same text; resolve A's ensure. B's input is
cleared while the request belongs to A's aside. This requires matching text;
it is not an arbitrary-text overwrite or a provider send to B.

Next: bind post-await draft mutations to both the owning session and the
captured draft operation/version. Preserve the correctly addressed send.

### A7 — handoff does not preserve draft ownership on failure or submission

Two full-Composer probes show distinct consequences of using the live parent
composer as the transfer buffer:

- Send the quoted conclusion, type a follow-up while onSend is pending, then
  reject onSend. `restoreInputAfterFailure` skips restoration when new text
  exists (`components/chat/composer.tsx:2203`). The callback reports `false`,
  which the message renderer labels “draft” (`message-renderer.tsx:815`), yet
  only the follow-up remains and no recovery intent contains the quote.
- Put an unrelated unfinished draft in the parent, then select Send to main.
  The append bridge combines that draft and the quote and immediately submits
  the combined body (`components/chat/composer.tsx:3988-3991`). The captured
  outgoing payload includes both, and the draft is cleared. This is observed
  auto-submission of existing text, not just a missing citation.

Next: keep a handoff's payload and recovery identity separate from unrelated
editing. A failed submission must retain its quote without overwriting new
typing. The existing-draft merge is an observed product-policy ambiguity,
not an additional confirmed defect: whether quote submission should send that
draft too needs an explicit product decision. A7's confirmed failure is the
lost quote and inaccurate draft outcome. Reuse the existing addressed intents
rather than adding a second composer.

### A8 — failed opening is still treated as a handled command

The slash action catches an ensure/opening exception and returns normally
(`lib/slash-commands/actions/side-chat.ts:54`). Composer reports the action as
handled (`components/chat/composer.tsx:4361`), then clears the question at
`:2001`.

The reproduction rejects only repository ensure, using the real slash handler
and full Composer. The input becomes empty, no side-chat question is queued,
and no main send occurs. An error toast does not retain the user's text.

Next: return or propagate a distinguishable failure outcome; clear the captured
draft only when the side-chat handoff actually succeeds. This is separate from
A5, which occurs after a question has already entered the queue.

### A9 — native history replacement flag is ignored during regenerate

The controller sets `replacesHistory` for regeneration
(`hooks/chat/use-claude-chat-controller.ts:6674-6682`). The native preparation
condition does not include that flag
(`hooks/chat/claude-chat-send-options.ts:248-254`), while the AI-SDK branch does.

An actual-import helper test provides canonical Q/A, a retained native SDK ID,
`currentMessageId: Q` and `replacesHistory: true`. The helper returns the same
resume ID without invalidation, SDK unlink or transcript seed. The rebuilding
positive control enables injection protection and correctly removes resume.
Source tracing shows regeneration tags sibling replies and releases the local
mirror, but does not otherwise retire this provider history on that path.

Thus the local preparation contract is violated: a replacement can continue
from opaque SDK history containing the answer being replaced. This condition
requires native resume with injection protection off and no other invalidation.
The helper regression does not measure the native SDK's eventual answer or
establish a real-provider regenerate incident.

Next: honor history replacement on native preparation and verify the actual
native request/history after regeneration. This is a shared chat seam exposed
by SideChat, as are several Composer findings above.

### Candidates retained as risks or rejected

| Candidate                                                                  | Classification and evidence                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor can advance after transport acceptance without a current SDK event. | Helper behavior reproduced: a supplied resume ID allows dispatched() to persist; cancel does not roll it back; next context can be empty. The sidecar transport success boundary is command delivery. No native failure has yet proved the SDK history actually missed that context. Carry as X7. |
| Aside clear bypasses parts of the normal clear lifecycle.                  | Source discrepancy: no standard transcript revision/lifecycle/tombstone/media cleanup path. Two-client sync and retention effects were not reproduced. Carry as X8; do not claim message resurrection from this alone.                                                                            |
| Clearing parent history leaves existing aside provider memory.             | Observed locally, but may be the intended independent aside memory contract. Personal-visibility withholding explicitly retires retained history. Not classified as a privacy bypass.                                                                                                             |
| Completed agent operation replays deleted aside text after clear.          | Rejected: operationTranscriptDigest rechecks prompt/reply rows and refuses missing/changed history (`lib/plugin/api/agent-turn.ts:417-439`).                                                                                                                                                      |
| Explicitly wrong-turn SDK event overwrites the cursor.                     | Rejected for named different turns by the dispatch helper; database cursor writes also check current SDK identity and aside kind.                                                                                                                                                                 |
| Strict Mode dispatches the same queued question twice.                     | Not established: synchronous claim removes the ID before the next consumer can claim it.                                                                                                                                                                                                          |
| Ordinary split-pane handoff broadcasts to both composers.                  | Rejected against the explicit session address and claimed guard. A6 is stale clearing, not broadcast or misrouted provider send.                                                                                                                                                                  |
| Multiple failed append intents overwrite each other.                       | Rejected in the current same-runtime store: append intents merge and focus-only intents do not replace pending text.                                                                                                                                                                              |

### Follow-up reproduction and limits

From the repository root:

```sh
rtk proxy node docs/evidence/2026-11-13-sidechat-mechanism-audit.adversarial-probes.mjs
rtk proxy node docs/evidence/2026-11-13-sidechat-mechanism-audit.adversarial-lifecycle.probes.mjs
rtk proxy node docs/evidence/2026-11-13-sidechat-mechanism-audit.adversarial-handoff.probes.mjs
rtk proxy node docs/evidence/2026-11-13-sidechat-mechanism-audit.adversarial-context.probes.mjs
```

Observed results after copying the self-contained runners into docs:

- Root resolver/native history: **2 suites / 4 tests passed**.
- Lifecycle barriers and production Dexie functions: **1 suite / 3 tests passed**.
- Full Composer and actual-controller admission: **2 suites / 6 tests passed**.
- Context/helper runner: **3 observations reproduced**; one is a carried risk,
  one an unclassified memory behavior, and one corroborates A9.

These **13 passing assertions lock the observed failures and controls**; they
do not certify a correct product. No provider was called, no real user database
was used, and no browser/Tauri/multi-device acceptance is claimed. The first
pass's 288 existing tests remain separately recorded; they were not rerun as
a substitute for these new counterexamples.

Only evidence documents and runners were added/updated. Node's existing Jest
config module-type warning and the deliberately injected send-failure logs
did not fail the assertions. Generated fixtures and logs remain under the
four `.cache/sidechat-adversarial-*` directories; the root directory also
records SHA-256 hashes of 14 owning files as
`verified-source-sha256.json` for detecting concurrent drift.

Remediation should first close F1 and A1-A3/A5, then repair request/draft
recovery and native history replacement. The review stops after one decomposed
cycle with actionable counterexamples; no product fixes or risk acceptance
were performed on the user's behalf.
