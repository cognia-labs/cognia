# Evidence ledger: plugin contract runtime completion

- Status: verifying
- Lane: standard
- Created: 2026-10-28
- Updated: 2026-10-29
- Related: `packages/plugin-contract/contract/catalog.json`; ADR-0016; ADR-0189

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 把刚才发现的问题都修复完善一下，补齐缺失的 API 契约、修正平台判断和过期的审计及测试路径，并跑通相关验证。确保功能完整，插件点位都真实实现，注意架构统一，和相关的代码统一

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                  | State    | Basis                                                                                                          | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Implemented context APIs are absent from the canonical method catalog.                                                                     | Verified | Governed-context regression: 8 failed, 5 passed; .cache/plugin-contract-repair/governed-before.log, 2026-10-28 | -          |
| O2  | Context policy defaults every unspecified platform to desktop.                                                                             | Verified | Same regression covers web, mobile and headless/CLI, 2026-10-28                                                | -          |
| O3  | Contract extraction left stale audit sources, proof-test paths and UI/runtime bindings.                                                    | Verified | Prior read-only audit and current explorer source checks, 2026-10-28                                           | -          |
| O4  | The standalone VS Code shim lacks whole-host debugger, notebook, custom-editor and filesystem capabilities.                                | Verified | Native shim source sweep, 2026-10-28; this did not assess the separate Managed Pro IDE host.                   | -          |
| O5  | The existing Managed Pro IDE already owns real custom-editor, filesystem, notebook and debug consumers, and Code owns walkthrough display. | Verified | Read-only runtime explorers, current broker/adapters and real-code-server E2E, 2026-10-29.                     | -          |
| G1  | Complete implemented API contracts, correct host policy and real point wiring, with consistent architecture and passing relevant checks.   | Agreed   | User request, 2026-10-28                                                                                       | -          |
| C1  | Preserve concurrent changes; never fake point implementation or weaken tests and permission gates.                                         | Verified | AGENTS.md and user requirement, 2026-10-28                                                                     | -          |
| Q1  | Continue completing the remaining feature mechanisms.                                                                                      | Answered | User: 继续完善功能, 2026-10-28; implementations proceed from existing host capabilities.                       | O4         |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Repair the canonical contract and host wiring together (O1–O3), then verify author types, real context calls, platform refusals and actual source-to-consumer delivery. Continue the confirmed host-backed capabilities under Q1 and keep unavailable whole-host capabilities explicit.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                              |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------- |
| scale        | high   | Contract, SDK mirrors, host context, registry sources and gates.                                         |
| technical    | medium | Reuse current dispatchers, registries and platform detection.                                            |
| coupling     | high   | Shared frontend, mobile and headless author surface.                                                     |
| requirement  | medium | Q1 authorizes continued host-backed implementation; whole-host subsystems remain explicit residual work. |
| verification | high   | Static/unit/browser checks available; native and external-provider acceptance separate.                  |
| risk         | high   | Permission and runtime policy must fail closed without blocking supported hosts.                         |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact) | Severity | Source | Claim | Refuted by |
| --- | ------------- | -------- | ------ | ----- | ---------- |

| R1 | Catalog drifts from public and mounted runtime APIs. | high | O1 | Both directions are checked against actual callable methods. | A real context method is unmapped or a catalog method is absent. |
| R2 | Platform checks allow unsupported hosts or block supported headless operations. | high | O2 | Canonical detection and accurate catalog platforms agree. | Desktop-only call executes on web or supported headless operation is denied. |
| R3 | Declared point lacks a real consumer or cleanup. | high | O3, O4 | Implemented points have real bindings, dispatch and lifecycle tests. | Registration succeeds but nothing consumes it. |

| R4 | Semantic refusal or failed projection is retried, approved without authority, or leaves the provider running. | high | ADR-0189, eight_wiring_review | A refusal is terminal across Sidecar, capture, renderer and subagent routing; owned request signals abort on strict failure. | A second model dispatch follows denial or the provider continues after terminal projection failure. |
| R5 | A managed activation wakes another owner or invokes a provider after timeout, disable or trust change. | high | eight_wiring_review, broker regression | Verified scope addresses only its owner and is rechecked after awaits; stale continuations cannot invoke. | Same local ID wakes a different owner, or a late activation invokes after refusal. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk | Method | Independence | Evidence | Coverage | Status |
| --- | ---- | ------ | ------------ | -------- | -------- | ------ |

| V1 | R1 | Failing regression then real context, contract, SDK and Python tests. | tool | jest-final.log: 30 suites, 2083 passed; Python: 348 passed; plugin:contract:check passed; SDK helper: 6 passed after canonical import repair. Logs under .cache/plugin-contract-repair/. | 91 namespaces and 937 public methods; missing namespaces, nested/optional methods, runtime and permission refusals. SDK package ESM/CJS and bundled declarations plus artifact assertions passed (sdk-build.log). | passed |
| V2 | R2 | Platform matrix tests. | tool | governed-context.test.ts passed, including explicit denied-implementation assertions. | Desktop, browser, mobile, headless and CLI; frontend-only namespaces refused on Python; file dialogs refused headlessly. | passed |
| V3 | R3 | Slot/hook/runtime-binding audits and actual dispatch integration tests. | tool | audit:slots passed; check-plugin-hooks: 141 fired, 0 virtual; runtime-proof/contract-path audits passed without silent exceptions; 10 Node gate tests passed. | CRUD commit/abort, gates/veto/stale instructions, registry ownership, cloning, stream identity/termination and runtime teardown. Static call-site evidence is not native/provider acceptance. | passed |
| V4 | R1, R2, R3 | Focused Jest, lint, typecheck, static export and browser smoke. | tool | 32 Jest suites / 2203 tests across focused and compatibility runs passed; pnpm lint, lint:i18n and i18n:sort:check passed; root and all Sidecar typechecks passed after repairing ES2018 BigInt syntax and three required activity fixtures; static-export: 14 imports in agent-codebuff/agent-crush; build and E2E prebuild refused native bridge pin drift. Exact logs under .cache/plugin-contract-repair/. | Unit/integration complete; production static export and rendered browser smoke did not start. | blocked |
| V5 | R1, R2, R3 | Fresh read-only preflight review. | fresh-reviewer | final_wiring, final_contracts and final_pii reviews; findings fixed with regression tests. | Added denial matrix, progress-independent AgentStep delivery, per-listener clone, committed edit/branch creation and stream snapshot/exit/late-identity handling. No new outbound gate bypass or bundled Node dependency. | passed |

| V6 | R1, R2, R3 | Terminal/task activation and real chat/tool Host callbacks, plus lifecycle and authority regressions. | tool | continued-jest-passing.log: 30 suites / 2534 passed; continued-vscode-host-final.log: all 218 real Host tests passed; continued-python-final.log: 348 passed; Compatibility: 4 suites / 73 passed; SDK entrypoints: 2 suites / 7 passed (6 overlap with compatibility); Node gate/build regressions: 10 + 6 + 10 passed. | Matching activation, registration acknowledgement, owned callbacks, queued cancellation, abort/timeout, frozen turn identities, visible commentary projection, ChatResult metadata history, disabled intent, local-only runtime and persisted policy across reload. No real native UI acceptance. | passed |
| V7 | R1, R2, R3 | Final type, lint, contract, SDK build and production preflight checks. | tool | Root typecheck, all Sidecar typechecks, full pnpm lint, lint:i18n, i18n:sort:check, plugin:contract:check, audit:slots, audit:hooks, audit:vscode-api-coverage and contract/SDK package builds passed. Packed SDK consumer: 55 typed exports, ESM/CJS runtime imports and isolated author compile passed (continued-sdk-packed-consumer.log); runtime contract smoke confirms version 1.5.0 / 91 namespaces / 937 methods. Logs: continued-*-passing/final.log and continued-sdk-build-artifact-fix.log. Static export still reports the same 14 out-of-scope native adapter imports; native bridge staging refuses pin drift. | Current sources and published ESM/CJS/declarations checked. Production application build and rendered E2E remain blocked. | blocked |
| V8 | R1, R2, R3 | Read-only i18n, test-gap, PII and runtime-wiring preflight reviews. | fresh-reviewer | continued_i18n, continued_test_gap, continued_pii and continued_wiring reviews. Final wiring recheck confirms shared authority and policy-preserving registration/teardown; latest targeted lifecycle run: 5 suites / 844 tests passed. | No new user-facing strings, co-located tests present, PII gate before extension callbacks, direct tool owner isolation, immutable registry disposal, policy checks before activation. | passed |

| V9 | R1, R2, R3 | Webview persistence/serializer and terminal-profile integration, real Host execution and fresh read-only review. | tool | next-jest-final.log: 36 suites / 2675 tests passed; next-host-all-final.log: all 223 real Host tests passed; next-python-final.log: 348 passed. next_i18n_review, next_pii_review, next_test_gap and next_wiring_review completed; findings fixed and wiring rechecked. | Workspace-scoped JSON state, startup adoption, close/read races, restart identities, serializer visibility, graceful deactivation, callback acknowledgement, dormant profile discovery, process/PTY creation, disabled intent, permissions, cancellation, late cleanup, local Host routing and UI interaction tests. Rendered browser/native acceptance remains open. | passed |
| V10 | R1, R2, R3 | Canonical and packaged contracts, lint/i18n, Sidecar types, root types and production preflight. | tool | Contract and SDK builds exited 0; packed SDK consumer verified 55 typed exports, ESM/CJS runtime and isolated author compilation. Runtime catalog: 1.6.0 / 298 points / 284 implemented / 8 virtual / 6 deprecated. Contract parity, API coverage (317 implemented / 65 unsupported / 0 missing), slots, hooks (141 fired / 0 virtual), 15 gate tests, full lint, i18n generation/parity/sort and all Sidecar types passed. pnpm typecheck failed only at concurrent cli/src/test-support/connector-loopback.ts:230 (TS2352, incomplete AdapterContext.tauri); static export retains 14 native-adapter imports; native bridge staging still refuses embedded pin drift. Exact next-*-final.log/build.log evidence is under .cache/plugin-contract-repair/. | Current plugin sources and package artifacts verified; full application types, production build and rendered UI are not green. No coverage run or pin bypass. | blocked |

| V11 | R3, R4, R5 | Actual semantic consumers, UI transitions, managed callbacks and stale/cancelled authority regressions. | tool | eight-jest-release.log: 54 suites / 3188 passed; eight-node-semantic-release.log: 187 passed; eight-host-final.log: 223 passed; eight-broker-final.log: 134 passed; eight-python-final.log: 348 passed; eight-gate-tests-final.log: 28 passed. | Failing-before regressions cover completion bypass (3 failures), cross-owner aliases (5 failures), virtual URI rejection, and Sidecar denial retry. Real ai@7 tests observe provider AbortSignal cancellation. Existing event fixtures now supply activeBranchByGroup and no longer swallow errors. | passed |
| V12 | R1, R2, R3 | Contract/package parity and real managed IDE acceptance, with global preflight boundaries. | tool | eight-pro-ide-release.log: 30 real Code Server tests passed, including filesystem bytes, custom editor, Notebook, DAP and owned walkthrough command. Contract 1.7.0: 298 points / 292 implemented / 0 virtual / 6 deprecated. Contract build and packed SDK consumer passed: 55 typed exports, ESM/CJS execution and isolated author compile (eight-contract-release.log, eight-sdk-packed-release.log). The earlier full lint run passed (eight-lint-release.log); the final full rerun was blocked by one concurrent unused AgentPlan warning in lib/agent/plan/steps.ts:8 (eight-lint-verified.log). Scoped lint, formatting, all five Sidecar configs, docs types, contract parity and i18n checks passed. Root types reported 14 out-of-scope diagnostics; static export reported the existing 14 native-adapter imports; main app build refused native bridge pin drift. | Main application production build remains blocked by native bridge pin drift; Managed Pro IDE verification is independent. | blocked |
| V13 | R3, R4, R5 | Independent read-only runtime, PII, i18n, static-export and test-gap audits. | fresh-reviewer | eight_wiring_review recheck and independent actual ai@7 probe: guard calls/attempts/model dispatches changed from 2/2/1 to 1/1/0; strict projection observes signalAborted=true and producedLate=false. Other audit findings have regressions and no unresolved scoped blocker. | All eight supported consumers are reachable. Native Welcome activation and inaccessible native Claude model-step boundaries remain explicit limitations. | passed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date | Decision | Action | Based on | Reversal trigger |
| --- | ---- | -------- | ------ | -------- | ---------------- |

| D1 | 2026-10-28 | Fix shared owning sources and generated mirrors, preserving existing permissions and user work. | implement | O1, O2, O3, G1, C1 | New evidence invalidates runtime/platform assumptions. |

| D2 | 2026-10-29 | Implement terminal/task/chat/tool activation through existing managers, callback transport, standard tool registry and agent execution service; retain unsupported whole-host mechanisms explicitly. | implement | O4, G1, C1, Q1 | Missing consumer, owner isolation, stored authority or cancellation evidence. |

| D3 | 2026-10-29 | Implement desktop Webview restoration through existing storage/rail and terminal profiles through the existing terminal manager; preserve headless boundaries and explicit remaining virtual contracts. | implement | O4, G1, C1, Q1 | Missing durable-state isolation, actual serializer/provider consumption or stale/cancelled launch cleanup. |

| D4 | 2026-10-29 | Complete the eight points through canonical interceptors, existing approval owners and Managed Pro IDE callbacks. Scope onWalkthrough to its generated owned command; do not invent native Code activation observers or duplicate IDE hosts. | implement | O5, G1, C1 | A supported route lacks a real consumer, terminal policy propagation, cancellation, addressed ownership or runtime evidence. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual | From | Why still open | Next action | Status |
| --- | -------- | ---- | -------------- | ----------- | ------ |

| X1 | Eight formerly virtual point contracts lacked actual consumers. | O5, V11, V12, V13 | All eight now have verified consumers in their declared runtime; current point catalog has zero virtual entries. Runtime limitations remain separately in X7. | No remaining missing consumer in the declared scope. | closed |
| X2 | Static-export gate is not green. | V4, V10 | 14 Node imports remain in agent-codebuff/agent-crush. | Review the owning native-adapter extraction and its actual static-export boundary, then rerun the gate. | open |
| X3 | Main application production build and browser/native smoke did not start. | V4, V7, V12 | The current native bridge source/output/dependency inventory differs from embedded pins. The exact staging preflight still refuses it on 2026-10-29. | Reconcile the concurrent native bridge changes and verified pins, then rerun pnpm build and plugin UI E2E. | open |
| X4 | SDK package runtime and declaration artifacts. | V1, V10 | SDK and contract package builds exited 0; current ESM/CJS and bundled declarations passed, followed by declared-artifact assertions and a packed consumer smoke (contract 1.7.0, 937 methods, 55 typed exports). | No remaining action in this scope. | closed |
| X5 | Standalone SDK gate retains five pre-existing host-reference baseline entries. | V1 | plugin:sdk:standalone passes its no-new-reference ratchet, not zero host references. | Migrate those owning data/effort contracts separately without weakening public types. | open |
| X6 | Full application typecheck can be blocked by concurrent source/fixture changes. | V10, V12 | Final eight-types-release.log reports 14 diagnostics in managed-desktop-handoff.test.tsx, managed-desktop-settings.test.tsx and remote-desktop/native-stream.ts. A scoped-path intersection reports zero diagnostics in this task; all five Sidecar configs passed separately. | Preserve concurrent edits and report the actual final root result separately from all Sidecar checks. | open |
| X7 | Runtime support is intentionally bounded. | O4, V12, V13 | Managed whole-host callbacks do not add support to the standalone VS Code shim. Direct Code Welcome/native open does not wake Cognia owner; generated walkthrough commands do. Native Claude internal model steps have no supported guard boundary and active semantic interceptors explicitly refuse that runtime. | Use the owned walkthrough command and AI SDK runtime for these seams; expanding native entry points requires an explicit supported host integration. | open |

| X8 | Latest full lint is blocked by a concurrent out-of-scope warning. | V12 | eight-lint-verified.log reports only unused AgentPlan in lib/agent/plan/steps.ts:8; the earlier full run passed, and this task does not own that module. | Resolve that concurrent import in its owning change and rerun full lint; scoped lint remains a separate result. | open |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal | How / when measured | Result | Status |
| --- | ------ | ------------------- | ------ | ------ |

New source rationale: the deterministic API-surface inspector prevents bidirectional catalog drift; the pure prompt owner breaks catalog-to-executor coupling; the local chat lifecycle bus avoids DB-to-plugin imports; the three host hook sources reuse one runtime installation/teardown path. Each has co-located tests.

| M1 | Previously unmapped plugin APIs execute through the governed context while invalid calls remain denied. | Regression, public surface extraction and real mounted context tests. | 33 methods added, no unmapped mounted callables; 10 formerly virtual hooks now have real sources; 273 implemented, 14 virtual, 6 deprecated point contracts. | met |

| M2 | Four formerly virtual activation contracts drive real host behavior. | Real Host callbacks and current generated point catalog, 2026-10-29. | onTerminal, onTaskType:_, onChatParticipant:_ and onLanguageModelTool:* are implemented. Current shared-tree catalog: 298 points, 282 implemented, 10 virtual, 6 deprecated; it also includes five gateway points added by concurrent work. API catalog remains 91 namespaces / 937 methods; contract version 1.5.0. | met |

| M3 | Two additional activation contracts have actual persisted panel and terminal-session consumers. | Real Host serializer/provider tests, renderer integration, picker interactions and built SDK catalog, 2026-10-29. | onWebviewPanel:* and onTerminalProfile:* are implemented. Current catalog: 298 points / 284 implemented / 8 virtual / 6 deprecated; contract 1.6.0. Structural API count is 317 implemented / 65 unsupported / 0 missing. | met |

| M4 | All remaining eight point contracts drive verified actual consumers. | Current canonical/built catalog and real/behavioral regression evidence, 2026-10-29. | Contract 1.7.0: 298 points, 292 implemented, 0 virtual, 6 deprecated. Public API remains 91 namespaces / 937 methods; standalone VS Code coverage stays 317 implemented / 65 unsupported / 0 missing. | met |

## Implementation record

- Canonical contract version 1.4.0; regenerated TypeScript, Rust, Python, point JSON and API documentation mirrors.
- Added files/skills/plans/hooks namespaces and missing connector/sandbox/workflow operations using their real runtime, permission and host constraints.
- Added TypeScript-checker extraction of every public context callable to contract generation, while the real context test independently enumerates mounted functions.
- Corrected stale capability proof paths, point bindings/docs/tests and Python parity source paths; removed dispatch-reachability soft passes and silent exceptions.
- Scheduler CRUD/import/owner changes publish observations only after persistence. Before-run gates are bounded and fail closed; reserve concurrency, honor cancellation and prevent stale payload execution.
- Workflow registry feeds report the actual winning owner. Chat CRUD facts publish after commit; rolled-back transactions do not publish. Edit-as-branch and branch creation use real acceptance/persistence boundaries.
- Single stream transport observer covers chat and captures, including complete snapshots, message identity, missing initial identity, terminal sessions, transport exit and subscription cleanup races.
- AgentStep reaches observers even without progress UI; observations clone per listener. Compaction broadcast uses the same merge policy as the in-process dispatcher.
- No commit or push performed. Unrelated concurrent changes remain in place. No coverage target, native/provider result or browser acceptance is claimed.

- Validation follow-through: the complete contract package build exposed Discord avatar BigInt literals incompatible with ES2018. Replaced only `22n`/`6n` with equivalent `BigInt()` constructors in source and its existing test (3 tests passed). Three pre-existing ContextWorkbench fixture objects now name their required `activity` (117 tests passed); scoped i18n review found no user-facing-string change. Root and every Sidecar typecheck then exited 0.

## Continued implementation: 2026-10-28

Acceptance sequence:

1. Terminal/task activation: source installation before the first extension loads; query activates matching providers before collection; disabled intent remains off; teardown detaches listeners. Validate real registry/RPC/manager paths and stale-source teardown.
2. Chat participants and language-model tools: preserve contributed descriptors, bind callback ownership/generation, use existing callback transport and tool registry/permission/abort seam, consume results in foreground/background chat, test real Host callbacks.
3. Shared semantic dispatch: isolate transform input and immutable identities before activating any new transform consumer. New sidecar/UI seams require actual changed output and failure/cancellation regressions, not catalog-only changes.
4. Keep unsupported whole-host capabilities explicit until their actual host and user flow exist. Re-run focused tests, contract generation/parity, root/Sidecar types and production/browser checks as available.

New sources require a distinct runtime responsibility that the existing owner cannot absorb; prefer extending current registry, loader, provider, dispatcher and renderer modules. No independent replacement registry or permission protocol.

Early regressions: activation-before.log records 4 failures; activation-bootstrap-before.log records the missing pre-first-extension listener installation. Terminal/task and manager bootstrap repairs currently pass 5 suites / 386 tests (activation-complete.log).

### Continued implementation result: 2026-10-29

- Graduated `onTerminal`, `onTaskType:*`, `onChatParticipant:*` and `onLanguageModelTool:*` only after connecting real consumers and callback tests. Activation listeners install before the first extension loads; consumer queries await activation and Host registration acknowledgement. Concurrent activation joins do not deadlock reentrant extension calls.
- Manifest descriptors preserve participant/tool definitions and infer task, participant and tool activation events. Dormant participants appear in the existing character chooser. Foreground and background turns share the participant registry, callback transport and canonical execution authority; runtime `vscode-chat` advertises only its actual capabilities and refuses remote/Worker/native session contracts it cannot honor.
- Streaming uses the existing SDK mapper and visible commentary renderer, preserving turn identity, cancellation and partial errors. `ChatResult.errorDetails` fails the turn; JSON metadata is persisted and rehydrated into subsequent `ChatResponseTurn.result` history. Text-only and HTTP(S)-reference limits remain explicit.
- Chat registration uses transactional profile merge, preserving saved user permissions, sandbox and profile fields. Teardown removes callbacks and aborts requests without deleting stored policy. Both single-participant and extension-wide reload tests use real Dexie storage. Foreground/background calls use the same authority ladder and reject unsupported profile contracts before activation.
- Language-model tools use the standard plugin tool registry, lifecycle and model approval path. Direct discovery/invocation is caller-owned and permission-gated; direct cross-extension invocation is refused until a session-bound consent contract exists. Structured participant history/tool arguments pass the existing PII gate before outbound extension callbacks. Stale disposers cannot unregister replacement or dependency-owned tools.
- Generic observe/guard/transform payloads are detached from plugin mutations. Nested invariant identity comparison accepts plain JSON across realms and rejects opaque/primitive replacements. Failed or timed-out handlers cannot mutate the caller's retained payload.
- Fixed the API coverage gate's obsolete synchronous RPC stand-in; regenerated its extra-symbol inventory for `lm.onDidChangeTools`. Bilingual docs now describe the actual activation and invocation behavior. The 316 mounted / 66 explicitly unsupported / 0 missing API-symbol count is a structural check, not full option or whole-host compatibility.
- New `chat-turn.ts` and its co-located test isolate the conversion between extension response parts and the existing SDK/agent execution rails; placing that conversion in the transport or registry would couple those owners to foreground UI history and agent-result persistence.
- Remaining virtual contracts: `model.stream.transform`, `agent.turn.decide`, `ui.surface.project`, `onWebviewPanel:*`, `onCustomEditor:*`, `onFileSystem:*`, `onDebugResolve:*`, `onTerminalProfile:*`, `onNotebook:*`, `onWalkthrough:*`. Optional VS Code chat follow-up/variable-resolution invocation and a native `lm.sendChatRequest` tool loop are also outside the supported subset; their registration surface does not establish runtime parity.
- Verification logs live under `.cache/plugin-contract-repair/`; production export/native UI/provider acceptance remains unverified for the reasons in X2/X3. No coverage run, commit, staging or push was performed. Concurrent source and generated changes were preserved.

- The final built-artifact smoke exposed a pre-existing packaging defect: the SDK `contracts` ESM entry had no value exports even though CJS and declaration builds succeeded. Added explicit re-exports from the canonical catalog, kept all type re-exports, and added a mandatory ESM/CJS contract parity check before declaration packaging. Existing build tests now exercise both missing-export failure and valid runtime metadata. The packed SDK consumer now imports the version and metadata at runtime in both formats; all 55 typed exports and isolated author compilation passed.

## Next increment: Webview restoration and terminal profiles (2026-10-29)

User request: 继续完善. Acceptance criteria for this increment:

1. Persist panel JSON state in the existing per-plugin storage, scoped to its workspace. On restart activate the owning enabled extension's onWebviewPanel event and invoke its actual serializer into the existing rail/frame. Do not persist executable HTML. User close removes the saved record, Host loss preserves it, stale/cancelled restores cannot resurrect closed panels.
2. Preserve contributed terminal profiles, infer their activation, show dormant profiles in the existing terminal picker, and await the real Host provider. Consume its process or Pseudoterminal options inside the Host, creating the existing terminal session; do not transport callbacks as JSON or fall back to a default shell. Permission, disabled intent, cancellation, owner disposal and local workspace/Host identity must hold through asynchronous creation.
3. Verify real Host callbacks, renderer persistence/ownership tests, picker interaction and integration wiring, current canonical/generated contracts, root/Sidecar types, lint/i18n and package artifacts. Keep unavailable native/browser acceptance and remaining whole-host features explicit.

New-source rationale: webview-restoration.ts owns durable metadata, activation and serializer lifecycle before any extension loads. Existing webview-bridge owns synchronous UI state and frame delivery; webview-handlers owns RPC/frame operations. Adding restart/storage orchestration to either would couple iframe rendering to plugin-manager bootstrap. The new module reuses their existing storage, registry and callback transport and has a co-located behavioral test.

Early evidence: next-webview-before.log reproduced the absent serializer registration handler (1 failed / 14 passed). Actual restoration, metadata retention/removal and stale/disabled/cancelled ownership tests then passed with existing webview and manager suites: 4 suites / 300 tests. A real Host serializer test reuses a saved panel handle, consumes saved JSON state and flushes HTML/title updates; 6 real webview Host tests passed.

### Increment result: 2026-10-29

- `registerWebviewPanelSerializer` now registers owned, generation-bound callbacks and acknowledges registration before activation completes. Restoration uses per-plugin storage scoped by project, with at most 32 panel records per project; only stable identity, view type, title and JSON state persist. Saved HTML and resource grants do not persist. Fresh callbacks repopulate the existing rail/frame through the existing RPC queue.
- The desktop PluginManager installs the coordinator and adopts panels created during startup, reading the latest state rather than a retained UI snapshot. Headless bootstrap does not install the UI restorer. User close deletes saved metadata; Host exit and graceful deactivation retain it. Workspace changes, disabled owners, replaced serializers, timeout, user close and late storage reads fence pending restores. Independent persistent IDs prevent Host handle reuse from overwriting older panels. Selected and hidden restored panels report their actual selection state to the serializer.
- Terminal profile contributions and inferred `onTerminalProfile` events survive manifest adaptation. The existing terminal picker discovers dormant profiles without activating them, awaits the actual Host provider on selection, and creates a process terminal or Pseudoterminal through the existing terminal registry. Provider callbacks and PTY functions stay in the Host. No default-shell fallback is used when a profile fails.
- Launches preserve extension/profile/project identity and require enabled intent plus terminal permission through asynchronous creation. Remote targets hide and refuse local profiles; the final spawn uses explicit local terminal execution and rechecks Host/workspace identity. Timeout, cancellation, provider disposal and late native responses clean up newly created sessions. Extension cleanup authenticates its RPC owner before removing any resources.
- Initial graceful-deactivation regression failed with one unwanted `webview:dispose` (next-host-webview-deactivate-before.log); teardown ordering now detaches panels before extension subscriptions dispose. Final review also reproduced reused-handle persistence identity and hidden-panel state failures (next-panel-identity-before.log / next-panel-visibility-before.log); the new regressions pass after correction.
- Final tests: 36 Jest suites / 2675 tests, all 223 real extension Host tests, all 348 Python SDK tests and 15 Node gate regressions passed. Full lint, Sidecar typechecks, contract/API/hook/slot audits, i18n generation/parity/sort and contract/SDK builds passed. Packed SDK consumers passed all 55 typed exports, ESM/CJS execution and isolated author compilation; runtime metadata confirms contract 1.6.0.
- Remaining virtual contracts are `model.stream.transform`, `agent.turn.decide`, `ui.surface.project`, `onCustomEditor:*`, `onFileSystem:*`, `onDebugResolve:*`, `onNotebook:*` and `onWalkthrough:*`. Existing optional chat follow-up/variable-resolution and native model tool-loop limits remain explicit. Registration-only scaffolding is not counted as implementation.
- Full root typecheck is blocked solely by the concurrent CLI fixture's incomplete `AdapterContext.tauri` (X6); static export retains 14 unrelated native-adapter imports (X2). Production staging still refuses native bridge source/output/dependency pin drift (X3), so production export and real browser/native plugin UI acceptance remain unverified. Scope is verified through real Node Host protocol execution and renderer integration/interaction tests. No coverage, staging, commit or push was performed.

## Remaining eight points: implementation acceptance (2026-10-29)

User request: 继续完善剩余的8个插件点位，确保都接入真实运行链路，注意架构统一、复用现有实现，并补齐测试、跑通相关验证。

1. `model.stream.transform`: await the canonical transform before actual text/reasoning mapper accumulation; presentation text only, immutable transport/owner/tool identity, abort and strict-failure behavior. Verify changed deltas and final snapshots in standalone and Sidecar streaming consumers.
2. `agent.turn.decide`: gate every exposed AI SDK model-step boundary, preserving existing budgets and prepareStep composition; consume pass/deny/requireApproval through existing approval ownership. Verify no model call after denial/cancellation and no policy bypass. Native SDK internal loops without a supported boundary remain an explicit runtime limitation.
3. `ui.surface.project`: share one asynchronous projection owner between inline/overflow renderers, retaining real components in the existing registry; serializable presentation DTOs only, immutable host identity/context, generation/revision/cancellation fences. Verify visible changed output, fallback/overflow, strict failure and stale result rejection.
4. `onCustomEditor:*`, `onFileSystem:*`, `onDebugResolve:*`, `onNotebook:*`: reuse the existing Managed Pro IDE adapters, document/kernel/DAP consumers and governed broker. Derive activation from authenticated, verified provider metadata; preserve trust, permissions, enabled intent, cancellation and version/generation checks. Verify broker activation precedes actual provider invocation and actual managed IDE flows. Do not misrepresent standalone shim support.
5. `onWalkthrough:*`: reuse Code's existing walkthrough contributions, renderer and completion tracking. Add an authenticated activation/open command using the existing proxy/broker; preserve namespaced identifiers and contained assets. Verify actual open route, completion descriptors and owner rejection.
6. Shared prerequisites: declared interceptors must honor canonical permissions; async results cannot commit after cancellation or stale activation. Test these before graduating any point. No new parallel registry, notebook host, file-system host or DAP implementation is justified where the Managed Pro IDE already owns the feature.
7. Final verification: focused failing behavior tests, integration/real runtime checks, fresh audits, canonical mirrors, package consumers, root/Sidecar types, lint/i18n and static export. Keep any environmental blocker separate from passing subsystem evidence. All eight were kept virtual until their consumers and behavior tests were verified; final graduation is bounded by the runtime support documented below.

Discovery evidence: read-only explorers eight_semantic_map, eight_editor_map and eight_debug_map; ADR-0189. Existing real-code-server E2E already exercises managed file-system, custom-editor, notebook and DAP owners; the native vscode-ext-host shims do not implement these whole-host capabilities. New semantic consumer modules, if needed, isolate presentation/decision orchestration from existing transport and registry ownership and require co-located tests.

### Final implementation and runtime boundaries for the eight points

- The canonical interceptor registry remains the only owner of permission, ordering, revocation and failure policy. New `interceptors/consumers.ts` contains shared DTO orchestration; it does not introduce another registry. Stream presentation is awaited before accumulation, guards collect all approval requests without skipping later denials, and provider/tool/transport identity remains immutable.
- Standalone chat, Sidecar AI SDK and `executeAgent` completion all consume these semantics. A per-turn operation ID survives chunks and steps. Strict projection errors cancel owned provider signals; explicit policy refusal survives the existing session event, capture error, renderer fallback and subagent envelope and never becomes a provider retry or a provider breaker failure. Completion uses its existing per-call permission responder; a missing responder denies continuation.
- Local chat approval reuses the existing HITL waiter, review-card channel and receipt owner. Sidecar reuses the existing pending permission waiter and lifecycle-hook round trip. No native tool execution handle swallows a local approval.
- Both slot renderers and presence checks share `useSurfaceProjections`; it runs JSON presentation DTOs outside render while component functions remain in the existing registry. Revision, decorator enabled state, generation, context, operation identity and AbortSignal fence stale commits. Filtering happens before overflow allocation.
- The five IDE mechanisms reuse the existing signed proxy, authenticated broker and Code providers. Normalized and local activation aliases address only the verified plugin. Timeouts, changed trust/version/enable intent and disconnect reject stale provider continuations. Filesystem writes require their declared write capability; virtual paths are interpreted only in the declared provider scheme.
- Walkthrough support means the generated namespaced command, authenticated activation, native Code rendering and native completion descriptors. Native Welcome tiles/direct open are not Cognia activation producers. This is stated in the canonical binding and both language guides. No claim of full standalone VS Code or native Claude semantic-loop parity is made.
- New `agent-config-types/plugin-interception.ts` is a pure terminal-identity leaf shared across process boundaries. The broad configuration barrel contains runtime re-exports that Node cannot load in strip-only mode; a separate leaf avoids importing that graph. New Sidecar and UI consumer modules isolate asynchronous consumer orchestration while retaining the original registry/approval/provider owners. Each new gated host module has a co-located behavioral test.
- Main-app production static export and Tauri-shell acceptance remain separate from the passing real Pro IDE workbench. No real external paid-provider acceptance or local coverage run was claimed.

Final verification artifacts are under `.cache/plugin-contract-repair/`:

| Check                                                             | Actual result                                                                           | Artifact                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Scoped Jest regression                                            | 54 suites / 3188 passed                                                                 | `eight-jest-release.log`                                                                                                |
| Sidecar semantic/session/runtime regression                       | 187 passed, plus final refusal/identity focused check passed                            | `eight-node-semantic-release.log`, `eight-semantic-scope-final.log`                                                     |
| Real extension Host / managed Broker                              | 223 / 134 passed                                                                        | `eight-host-final.log`, `eight-broker-final.log`                                                                        |
| Real Code Server workbench                                        | 30 passed after final addressed-owner fix                                               | `eight-pro-ide-release.log`                                                                                             |
| Python SDK / contract gate tests                                  | 348 / 28 passed                                                                         | `eight-python-final.log`, `eight-gate-tests-final.log`                                                                  |
| Canonical contract build and packaged SDK                         | passed; 55 typed exports and isolated author compile                                    | `eight-contract-release.log`, `eight-sdk-packed-release.log`                                                            |
| Full lint and scoped formatting/diff check                        | passed                                                                                  | `eight-lint-verified.log`, `eight-format-check.log`, `eight-diff-check.log`                                             |
| Sidecar main, Pi, managed Broker, VS Code Host and Webclone types | all passed                                                                              | `eight-sidecar-types-release2.log`                                                                                      |
| Docs typecheck                                                    | passed                                                                                  | `eight-docs-types-final.log`                                                                                            |
| Contract parity / hook-slot audits / SDK reference ratchet        | passed; 141 fired hooks, 0 virtual hooks, 5 pre-existing SDK reference baseline entries | `eight-contract-parity-release.log`, `eight-hooks-final.log`, `eight-slots-final.log`, `eight-sdk-standalone-final.log` |
| Standalone VS Code API matrix                                     | 317 implemented / 65 unsupported / 0 missing                                            | `eight-api-coverage-final.log`                                                                                          |
| i18n build, generated parity, sort and lint                       | passed; no new production .tsx strings                                                  | `eight-i18n-*-final.log`, independent i18n review                                                                       |
| Full root typecheck                                               | blocked: 14 diagnostics in 3 concurrent out-of-scope files; no scoped diagnostic        | `eight-types-release.log`                                                                                               |
| Static export                                                     | blocked: existing 14 agent-codebuff/agent-crush imports                                 | `eight-static-export-release.log`                                                                                       |
| Main application build                                            | blocked before Next build: native bridge inventory differs from embedded pins           | `eight-app-build-final.log`                                                                                             |

No staging, commit, push, coverage run, automatic pin refresh or unrelated cleanup was performed. The ledger remains `verifying` because global/main-shell residuals are still open.
