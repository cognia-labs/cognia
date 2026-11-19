# Evidence ledger: selection toolbar support audit

- Status: verifying
- Lane: standard
- Created: 2026-11-08
- Updated: 2026-11-09
- Related: ADR-0093, ADR-0095, ADR-0159, ADR-0181

## Original request

> 研究一下现在对滑词工具栏调用的支持情况，看看存在什么bug或者缺口

## Knowledge

| ID  | Statement                                                                                                                                | State    | Basis                                                                                                                                       | Depends on                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| G1  | Audit support and identify reproducible bugs, separating intentional limits from defects.                                                | Agreed   | User request, 2026-11-08.                                                                                                                   | -                          |
| C1  | Preserve concurrent changes; research/evidence only, without product fixes or real external sends.                                       | Verified | User scope and shared-tree instructions, 2026-11-08.                                                                                        | G1                         |
| O1  | Desktop native perception/commands, overlay, main-renderer execution, plugins, settings and in-chat selection are distinct linked paths. | Observed | Current owning source and ADR-0093/0095/0159/0181, 2026-11-08.                                                                              | -                          |
| O2  | ADR-0159 promises main-window execution, per-invocation consent, normalized results, preview-first replacement and short-lived undo.     | Observed | ADR-0159, 2026-11-08.                                                                                                                       | -                          |
| Q1  | Which error, timeout, dismissal and concurrent-selection cases fail?                                                                     | Answered | Seven reproducible defects plus a source-confirmed hidden-consent gap below, 2026-11-08.                                                    | O1, O2                     |
| Q2  | Which native/platform behaviors can be verified here?                                                                                    | Answered | Debug status returns bridge_unavailable; an existing compiled Rust test binary runs. No live shell/provider smoke, 2026-11-08.              | C1                         |
| O3  | Pending consent can release text to an unregistered action after its permission guard registration is removed.                           | Verified | Actual broker, guard and quick-action registry fault-injection probe; main host checks registry only after invocation finishes, 2026-11-08. | O1                         |
| O4  | A selection-only plugin accelerator dispatches its handler with undefined invocation.                                                    | Verified | Actual registry and mirrored-command probe; shortcut bind seam captured, 2026-11-08.                                                        | O1                         |
| O5  | Rewrite has no toolbar-level deadline or abort signal, and emits success after host unmount.                                             | Verified | Deferred enhance dependency + 35,000ms fake-clock probe, 2026-11-08.                                                                        | O1                         |
| O6  | A resolved no-op speech call emits no terminal selection playback event.                                                                 | Verified | Main-host probe; speech watcher requires sawPlaying; actual TTS-disabled test passes, 2026-11-08.                                           | O1                         |
| O7  | Remember remains busy beyond 35 seconds if its main-host result never arrives.                                                           | Verified | Overlay probe, 2026-11-08. Cold-start trigger refuted on 2026-11-09 (O12).                                                                  | O1                         |
| O8  | Open in Cognia emits an event but does not finish the overlay; the main handler routes internally without native window reveal/focus.    | Verified | Overlay probe + both source handlers reviewed, 2026-11-08; native visual outcome still untested.                                            | O1                         |
| O9  | Two generated texts for one candidate stage only the first snapshot.                                                                     | Verified | Main-host probe: first variant retained, second event routes but is deduplicated, 2026-11-08.                                               | O1                         |
| O10 | Selection plugin consent is a main-renderer DOM card, without native reveal or overlay-side consent UI.                                  | Observed | PluginConsentOverlay, broker, AppRuntime and selection execution path, 2026-11-08; no native hidden-window repro.                           | O1                         |
| O11 | Existing focused tests pass while fault probes reproduce uncovered defects.                                                              | Verified | 24 suites / 403 existing tests; 3 suites / 7 positive defect probes; prebuilt native binary 65 tests, 2026-11-08.                           | O3, O4, O5, O6, O7, O8, O9 |
| G2  | Adversarially review the original audit for false positives and omissions.                                                               | Agreed   | User follow-up, 2026-11-09.                                                                                                                 | G1                         |
| O12 | Cold-locked restore waits for capabilities whose readiness is below AccountGate.                                                         | Verified | Real restore/capability-registry probe with simulated readiness, plus actual mount topology, 2026-11-09.                                    | O1                         |
| O13 | Authorizing plugin A releases selection text to a different command owner or a commands:read interceptor.                                | Verified | Actual broker/guard/registry and interceptor dispatch probes, 2026-11-09.                                                                   | O1, O2                     |
| O14 | Cached confirm-tier consent survives explicit selection:read revocation.                                                                 | Verified | Actual guard and broker with two selection invocations, 2026-11-09.                                                                         | O3                         |
| O15 | Credential-window refusal is collapsed into no text, and native capture can outlive Off or use stale preflight metadata.                 | Observed | Fresh native reviewer and owning Rust source, 2026-11-09.                                                                                   | O1                         |
| O16 | A fresh host drains Remember for a dismissed candidate.                                                                                  | Verified | Initializer probe with empty current candidate and populated native mailbox seam, 2026-11-09.                                               | O7                         |
| O17 | Initial shortcut can be dropped, OCR open-link can bypass visibility policy, and a reused overlay keeps the first locale.                | Verified | Actual overlay with controlled Tauri delivery and preferences, 2026-11-09.                                                                  | O1                         |
| O18 | Refresh certifies an edited code excerpt while preserving a semantically obsolete snapshot.                                              | Verified | Actual excerpt refresh and isolated database fixture, 2026-11-09.                                                                           | O1                         |

## Problem frame

For G1, trace selection → overlay → native/main execution → result/composer, and compare in-chat support. Establish capabilities and evidence-backed defects, including consent and stale-input boundaries. Run existing suites and isolated probes. Product fixes and real provider calls are outside this research increment (C1).

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                         |
| ------------ | ------ | ----------------------------------------------------------------------------------- |
| scale        | medium | Native perception, overlay, main renderer, plugin registry, settings and chat.      |
| technical    | medium | Existing implementation; AX/UIA, clipboard and focus need platform context.         |
| coupling     | high   | IPC, plugin consent, model input, and three shells sharing one export.              |
| requirement  | low    | Support audit with no prescribed cause or fix.                                      |
| verification | high   | Jest covers logic; native focus/permissions and real providers need shell evidence. |
| risk         | medium | Research is reversible; audited paths release text and replace foreign-app content. |

## Risks

| ID  | Risk (impact)                                                                                      | Severity | Source                                    | Claim                                                                           | Refuted by                                                                          |
| --- | -------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| R1  | Advertised actions cannot execute or settle visibly.                                               | medium   | ADR-0093; lens:FMEA                       | Every action has a mounted handler and bounded settlement.                      | An invocation has no handler, terminal result or bounded error.                     |
| R2  | Stale/dismissed selections release text or accept obsolete execution.                              | high     | ADR-0159; lens:failure-injection          | Identity, consent and lifecycle protect asynchronous boundaries.                | Deferred execution acts after selection/action invalidation.                        |
| R3  | Native replacement targets wrong content or overstates readiness.                                  | high     | ADR-0159; risk catalog                    | Native checks revalidate source/text and disclose rollout limits.               | Incorrect source can pass or UI promises disabled behavior.                         |
| R4  | Mocked evidence is mistaken for native/provider acceptance.                                        | medium   | ADR-0095; verification reference          | Claims state the exact verified environment.                                    | Real-shell success inferred only from mocked tests.                                 |
| R5  | Capture after Off, stale source identity or fallback from a denied surface breaks user exclusions. | high     | ADR-0095, ADR-0159, fresh native reviewer | Permission, provenance and the active capture generation authorize publication. | A denied or retired capture publishes a new candidate.                              |
| R6  | Selection text crosses a plugin principal or account boundary after approval or replay.            | high     | ADR-0159 and fresh renderer reviewer      | Only the authorized live recipient receives the candidate text.                 | Another command owner, guard or session receives a payload without its own binding. |

## Verification obligations

| ID  | Risk           | Method                                                                                             | Independence   | Evidence                                                                                                                                                 | Coverage                                                                          | Status  |
| --- | -------------- | -------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| V1  | R1             | Trace registrations, shell mounting, built-ins, plugins, settings and chat.                        | self           | Support map and source references below; all 16 native commands are registered in lib.rs.                                                                | Reachability and intentional limits; runtime gaps F4/F8.                          | passed  |
| V2  | R1, R2         | Existing focused Jest suites plus discriminating fault-injection probes.                           | tool           | 403 existing tests passed; 7 positive defect probes passed, reproducing F1–F7. Commands and replay script below.                                         | TS/React logic; actual guard/broker/registry for F1, stubbed OS/model boundaries. | passed  |
| V3  | R3             | Review native safety/rollout/platform branches; run feasible native checks.                        | tool           | Native source reviewed; existing app_lib-5fa938dad8795277 ran 65 selection tests successfully.                                                           | Prebuilt binary only, no fresh Cargo build or foreign-app paste.                  | passed  |
| V4  | R4             | Discover shell and E2E coverage; record real environment evidence or blocker.                      | real-env       | pnpm tauri:debug:agent:status returned ok:false, status:bridge_unavailable; no existing selection-toolbar E2E specification found in searched E2E trees. | No live native UI, Windows/device or provider acceptance.                         | blocked |
| V5  | R1, R2, R5, R6 | Fresh independent review of native, renderer and integration contracts with discriminating probes. | fresh-reviewer | Three read-only reviewers, 5 generated suites with 16 checks, and correction/omission records below.                                                     | Source and controlled IPC; one refutation plus 15 defect counterexamples.         | passed  |
| V6  | R3, R5, R6     | Execute native stop/capture, credential-window and account-transition scenarios on a live shell.   | real-env       | Debug bridge status again bridge_unavailable on 2026-11-09.                                                                                              | macOS and Windows interaction and actual account isolation.                       | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                                                                       | Action   | Based on                                      | Reversal trigger                                                                   |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| D1  | 2026-11-08 | Diagnose with source and focused probes before proposing fixes. CodeGraph has no index; use owning-source reads and literal search.                            | diagnose | G1, C1, O1, O2                                | User requests implementation or new evidence changes scope.                        |
| D2  | 2026-11-08 | Complete this research increment with ranked findings and executable counterexamples; carry repairs and native acceptance as open residuals.                   | stop     | G1, C1, O3, O4, O5, O6, O7, O8, O9, O11       | User requests repairs or real-environment validation.                              |
| D3  | 2026-11-09 | Correct F4's cold-start trigger and F3's timeout scope. Retain the observed no-result and late-completion failures. Add the missed paths as separate findings. | diagnose | G2, O5, O7, O12, O13, O14, O15, O16, O17, O18 | Recheck after changed boot wiring, authorization, or native capture state machine. |

## Residual risks

| ID  | Residual | From | Why still open | Next action | Status |
| --- | -------- | ---- | -------------- | ----------- | ------ |

| X1 | The original and follow-up findings remain open. Text release and action lifecycle have reproducible counterexamples. | R1, R2 | User requested research; no production code changed. | Repair F1 first, then consent/dispatch and lifecycle paths with protective regression tests. | open |
| X2 | Native UI/provider behavior, fresh Rust build and Windows/Capacitor acceptance are unverified. | V3, V4 | Debug bridge unavailable; no provider calls made. The disk had about 5.4GiB free, so no cold native rebuild was started for this read-only audit. | Start a current debug shell; verify hidden/locked/unlocked paths and macOS/Windows application matrix. | open |
| X3 | Hidden consent-card behavior is source-confirmed, not visually reproduced. | R1, V4 | Consent exists only in main DOM; native window unavailable in this session. | Hide main window, invoke a text-reading reference-plugin action, verify approval is surfaced and can be answered. | open |
| X4 | New source-level native failures and cross-account consequence need real-shell reproduction. | R5, R6, V6 | Controlled test data exercised the renderer seams. No native capture, credential contents or account switch was used. | Run fault injection with synthetic text in disposable windows/accounts. Confirm Off, exclusions, account ownership and recipient authorization before an action can use text. | open |

## Outcome

| ID  | Signal                                                                                    | How / when measured                                       | Result                                                                                                                           | Status |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Deliver support inventory and ranked reproducible findings with explicit acceptance gaps. | Source and focused checks, 2026-11-08.                    | Inventory, F1–F8, replay script and validation limits recorded below. Audit complete; repairs and native acceptance remain open. | met    |
| M2  | Classify previous false positives and add evidence-backed omissions.                      | Independent review plus deterministic probes, 2026-11-09. | F4 cold-start trigger refuted, F3 narrowed, F1 expanded, and F9–F16 recorded with native limits.                                 | met    |

## Current support inventory

| Surface                  | Implemented behavior                                                                                                                                                                                                            | Limits / evidence                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native perception        | macOS AX / Windows UIA selection, mouse gestures and selection-change settling; manual live capture and clipboard capture; OCR fallback.                                                                                        | Automatic raise stops above 4,000 Unicode characters; captured text is bounded at 20,000. Linux's input-hook stub blocks native toolbar startup before shortcut binding, including the toolbar's clipboard entry point. Desktop settings scope support to macOS and Windows. ADR-0095; native `spawn_publish`, `capture_live_candidate`, `capture_clipboard_candidate`; `crates/cognia-automation/src/automation/selection.rs:12`. |
| Desktop built-ins        | Copy; Explain / Translate / Ask / Convert Unit; Remember; Speak; Open Link / Compose Email / Search Web.                                                                                                                        | Explain/Translate/Ask/Convert stage a context chip and optional prompt into the composer; they do not automatically send an inline AI answer. Copy/launch are native; memory/speech need main renderer. Action table: `components/selection-toolbar/selection-toolbar-actions.ts`; native execute at `src-tauri/src/selection_toolbar.rs:1516`.                                                                                    |
| Cognia Rewrite           | Six modes: improve, concise, detailed, technical, simpler, variants. Calls utility-model client, then a headless-turn fallback when no direct client exists.                                                                    | Reuses composer prompt-enhance logic; input PII check is in `lib/chat/completion/enhance.ts`. Result is previewed; execution lifecycle has F3. Host at `selection-toolbar-initializer.tsx:225`.                                                                                                                                                                                                                                    |
| Plugin selection actions | Opt-in selection surface; metadata/text input; none/status/preview/copy/replace output; origin/content-type/maxChars filtering; result normalization; text consent.                                                             | Metadata omits text; URL metadata removes userinfo/query/fragment. Text/variant outputs capped at 20,000 characters each, 8 variants; status message capped at 1,000. Runtime reference: `plugins/ui-surface-reference/src/index.tsx:137`. F1/F2/F8 affect real invocation.                                                                                                                                                        |
| Results                  | Original/result comparison, attribution, origin warning, variants, Copy, Open in Cognia, conditional Replace/Undo.                                                                                                              | Plain-text only; F6/F7 affect handoff. `components/selection-toolbar/selection-result-panel.tsx`.                                                                                                                                                                                                                                                                                                                                  |
| Replace / Undo           | Native PID/source/control/window/bounds/text/freshness checks, exclusive replacement guard, clipboard-restoring paste; 8-second one-use undo lease tied to physical-input generation.                                           | Compile-time `COGNIA_SELECTION_REPLACE=1` gate; default builds advertise no paste capability. This is intentional, not a missing implementation. OCR/clipboard/truncated/read-only selections cannot replace. `selection_toolbar.rs:1607,1721,1815`. Actual application matrix is unverified.                                                                                                                                      |
| Settings / shortcuts     | Off/automatic/manual; app and hostname exclusions; seven translation targets; contextual actions/search engine; ordering/hiding/pinning; per-action shortcut editor; direct-replace allowlist displayed inert when unavailable. | Stable six action chords plus show-toolbar/clipboard activation are selection-scope bindings; action chords can capture long selections on demand. Plugin-declared accelerator path differs (F2).                                                                                                                                                                                                                                  |
| In-chat selection        | Reference passage, ask in an aside, summarize/explain/translate in a result panel, copy/reference result; utility/headless client ladder, chunking, input PII checks, streaming and abort.                                      | Mounted in `components/chat/message-list.tsx:1081`. This is a separate product path, not the full system-wide action/plugin surface. Pure web without a key or reachable companion has no model client. No real-provider run in this audit.                                                                                                                                                                                        |
| Three shells             | System-wide toolbar is a desktop feature; browser/Capacitor use in-app text-selection UI.                                                                                                                                       | Desktop settings are profile-gated. A shared static export is not evidence of OS-wide selection capture on web/mobile.                                                                                                                                                                                                                                                                                                             |

## Findings

### F1 — P1: action/permission revocation is checked after selected text is released

- Trigger: invoke a text-reading quick action, leave consent pending, unregister/unload the action and revoke its guard registration, then approve the pending prompt.
- Reproduction: the actual `PluginConsentBroker`, `PermissionGuard` and quick-action registry still invoke the retained callback with `candidate.text`. The action is absent from the registry at that point.
- Root: `lib/selection/plugin-actions.ts:183` awaits consent, then assigns/releases text at lines 193–213 without checking current registry identity or revocation again. `PermissionGuard.checkWithConsent` returns the old broker decision without a post-await revocation check. `clearSessionGrantsForPlugin` clears cached grants, not pending requests (`consent-broker.ts:243`). Actual unload cleanup uses those operations (`lib/plugin/core/manager.ts:5008`).
- The main host's registry check at `selection-toolbar-initializer.tsx:346` discards the eventual result **after** the callback has already received text. It does not prevent disclosure.
- Repair: cancel plugin-specific pending consent on disable/unload; revalidate the live action, permission state and candidate immediately before text release.
- Acceptance: approving an obsolete prompt invokes no callback and releases no text. Current registered/authorized actions must continue to work.
- The follow-up confirmed a second release path using the real guard and broker. Approve for the session, call `PermissionGuard.revoke`, then invoke again. `check` denies, but `checkWithConsent` takes the unchanged confirm tier and accepts the cached broker decision (`permission-guard.ts:626`, `:753`, `consent-broker.ts:172`). The second invocation receives the text without another prompt. The permission UI calls this revoke path (`components/plugins/plugin-permission-review.tsx:273`, `lib/plugin/api/permission-api.ts:366`). Both probes use synthetic text.

### F2 — P2: a selection-only plugin's declared accelerator uses the wrong invocation route

- Trigger: register `surfaces: ["selection"]`, `selection.input: "text"`, and an `accelerator`; fire its bound command.
- Reproduction: the captured accelerator binds `_qa:plug-a:accelerated`; dispatch calls `run(undefined)`, with no selection context or selection result event.
- Root: the mirrored handler at `packages/plugin-contract/src/lib/plugin/registries/quick-action-registry.ts:170` calls `runQuickAction(entry)` without an invocation. The accelerator at line 180 binds that mirror. This bypasses the specialized selection execution/result pipeline; the separate user-configured `selection.action:*` shortcut route does use it.
- Impact: a callback expecting selected text fails or sees empty input; returned preview/copy output is not routed to the overlay. This probe demonstrates missing context, **not** a leak of selection text via the accelerator.
- Repair: route selection-only accelerators through live native capture and the main-owned selection-action request. Define explicit semantics for actions shared with other surfaces.
- Evidence: `plugin-lifecycle.test.tsx`, second probe; native `dispatch_shortcut` at `selection_toolbar.rs:1441`.

### F3 — P2: Rewrite has no toolbar request lifetime or abort propagation

- Trigger: a rewrite model call never settles, or the main handler unmounts/locks while a rewrite is pending.
- Reproduction: after 35,000 fake-clock milliseconds no terminal result exists; `enhancePrompt` receives no signal. Resolve after unmount and the host still emits `ok:true`.
- Root: `selection-toolbar-initializer.tsx:246` passes only `{ client }`; no controller/deadline is created, and no `alive`/request/candidate recheck occurs after completion. The 30-second race at line 326 belongs only to plugins.
- Closing the toolbar does not abort model work. Late results can outlive the host lifecycle even if the overlay drops them. The 35-second probe isolates toolbar behavior. The host utility client supplies a 30-second request deadline and the headless capture defaults to five minutes (`lib/ai/host-llm-client.ts:105`, `lib/claude/run-and-capture.ts:638`). The original timeout wording was too broad.
- Repair: own each request with an abort controller and deadline; cancel on dismissal, replacement, account/host teardown; revalidate before publication.
- Evidence: `host-lifecycle.test.tsx`, rewrite probe. Model dependency is deferred locally; no provider call.

### F4 — P2: the restored toolbar can offer await-actions without an active execution receiver

- Trigger: lock the account after its native monitor has already started, or lose the renderer receiver during a request. The original cold-locked trigger is refuted. The restore component mounts above `AccountGate`, but awaits `desktop-tools` and `plugin-runtime` readiness. Their owners mount below the gate, so a fresh locked launch waits for unlock before starting the monitor (`selection-toolbar-restore-initializer.tsx:31`, `lib/boot/capabilities.ts:68`, `desktop-only-initializers.tsx:227`).
- Reproduction: overlay executes Remember successfully at the IPC seam, receives no main-window result, and after 35 seconds still disables its buttons and holds keep-alive.
- Root: native execution stores one `pending_stage` and emits the notification (`selection_toolbar.rs:1558`). Overlay awaits an unbounded `selection://result` / `selection://speech`; there is no receiver-ready/locked indication or response timeout. Host mounting is at `desktop-only-initializers.tsx:270`; restore is in `window-liveness-initializers.tsx:102`.
- Impact: the user sees a busy action with no explanation; pending work may execute later on unlock, rather than at the time of the click. Plugin/rewrite event requests also have no overlay-side acknowledgment/deadline if no receiver answers.
- Repair: expose receiver/account readiness, show a clear unavailable/unlock path, and settle or cancel every waiting request. Specify whether deferred work is permitted before replay.
- The overlay missing-result probe confirms the waiting state. A follow-up probe using the real capability registry confirms the cold-start dependency. Warm lock remains a source-derived trigger awaiting native validation. See F12 for stale mailbox replay.

### F5 — P2: Speak stays pending when TTS is disabled

- Trigger: click Speak with `ttsEnabled=false` (the default speech setting).
- Reproduction: the successful no-op speech call produces no `selection://speech` terminal event.
- Root: `packages/tts/src/tts-orchestrator.ts:172` sets a stopped state and resolves without assigning this selection as an active source. `lib/tts/speak-selection.ts:59` only emits completion after `sawPlaying`. `selection-toolbar-initializer.tsx:406` forwards the promise but handles only rejection, not successful no-playback completion.
- Impact: the overlay remains in pending/keep-alive state instead of explaining that speech is disabled.
- Repair: return an explicit speech outcome or settle after the promise resolves when no playback began; disclose disabled speech before invocation.
- Evidence: no-op host probe; existing actual `TTSOrchestrator` disabled-mode test and watcher tests also passed.

### F6 — P2: Open in Cognia routes internally but does not perform the native handoff

- Trigger: generate a preview while the main window is hidden, then choose Open in Cognia.
- Reproduction: overlay emits `selection://open-result`, clears its preview and returns to the capsule; it never calls finish. The host stages text and calls only `router.push("/")`.
- Root: overlay `selection-toolbar-view.tsx:531` and host `selection-toolbar-initializer.tsx:448` lack native reveal/focus and an acknowledged finish. Ordinary Explain/Ask handoff explicitly brings main forward in Rust at `selection_toolbar.rs:1559`.
- Impact: hidden main remains hidden by this code path; the user can lose the visible preview without reaching the destination window.
- Repair: use an acknowledged native handoff that reveals/focuses main and finishes the correct overlay candidate only after staging succeeds.
- Evidence: overlay probe and both source handlers. Native hidden-window visual behavior remains unverified.

### F7 — P2: repeated generated-result handoff silently retains the first text

- Trigger: for one selection candidate, open a first result in Cognia, then generate/choose another result and open it again while the first context chip remains.
- Reproduction: send "first variant", then "second variant"; only one chip exists and its snapshot is still "first variant", though routing ran twice.
- Root: `selection-toolbar-initializer.tsx:454` keys all results as `${candidate.id}:result` and skips adding/updating a matching selection. Result/request identity is discarded.
- Repair: key by generated result/request identity or update the existing staged snapshot deliberately. Preserve the user's chosen variant.
- Evidence: `host-lifecycle.test.tsx`, repeated-result probe.

### F8 — P2, source-confirmed: consent can wait inside a hidden main window

- Trigger: main is hidden in the tray; invoke a text-reading plugin action whose tier requires confirmation.
- Source: `lib/selection/plugin-actions.ts:183` asks the broker; broker dispatches a renderer-local CustomEvent. `PluginConsentOverlay` is mounted in main (`components/runtime/app-runtime.tsx:413`) and only focuses its DOM card (`components/plugins/dialogs/plugin-consent-overlay.tsx:78`). No native main-window reveal or toolbar-side consent path is present in this invocation.
- Consequence: the required approval UI stays in a hidden webview and the broker auto-denies after 30 seconds unless the user independently opens main. The toolbar itself only shows pending and later a generic error.
- Repair: present host-owned consent on a visible native surface and pause/coordinate the action deadline with consent. Preserve explicit text release.
- Evidence strength: source-confirmed missing reveal path; the actual hidden-window symptom is still an open native acceptance item (X3).

## Adversarial review, 2026-11-09

Three fresh-context reviewers independently covered native capture, renderer/plugin release, and settings/shortcut/chat integration. Findings below were reconciled against the owning source. The expanded replay script ran 16 checks in five suites. One check refutes the original cold-start trigger and 15 assert reproducible defect behavior. These checks use controlled timing, synthetic selected text and mocked native transport. The cold-restore probe uses the real boot capability registry.

F1, F2, F5 and F7 were retained with reproduced behavior. F3 retains the missing cancellation and late success, with scope narrowed to the toolbar's own deadline. F4 retains the waiting state for a missing receiver, with the cold-locked trigger removed. F6 reproduces the overlay closing its result and records the missing native reveal in source. F8 remains a source finding. Neither F6 nor F8 was observed on a hidden native window in this review.

### F9 — P1. Consent names one plugin while command routing can release text to others

- Approve a text action owned by A whose command is registered to B. A's consent succeeds and the actual command handler for B receives the selection. B's `selection:read` check returns false. The global command route passes the invocation through at `packages/plugin-contract/src/lib/plugin/registries/quick-action-registry.ts:94`. The host manifest validator checks A's declaration at `packages/plugin-contract/src/lib/plugin/core/validation.ts:2392`.
- Even when A owns the command, `ui.action.invoke` passes the complete arguments to its guard chain. A separate plugin with `commands:read` and no `selection:read` receives the selection in its guard. The command registry sends raw args at `packages/plugin-contract/src/lib/plugin/commands/registry.ts:219`. The point grants access via `commands:read` at `packages/plugin-contract/src/lib/plugin/contracts/plugin-points.ts:1331`. Dispatch clones the payload for the interceptor at `packages/plugin-contract/src/lib/plugin/interceptors/dispatch.ts:619`.
- Both cases reproduced using actual registry/dispatch implementations. Cross-plugin slash dispatch passes the selection context through a similarly broad lookup in source. The executable probes cover command and guard recipients.

### F10 — P1. A credential-window denial can fall through to OCR

- The accessibility helper returns `None` when the credential-window guard refuses the read. The caller treats `None` as missing accessible text and can enter OCR. OCR checks the app blocklist, preflight's secure-field flag, recording permission, backend and drag dimensions. The credential-window verdict does not reach that branch.
- A credential-like window with an unblocked process name, non-password focused control, eligible drag and available OCR can therefore reach screenshot acquisition. This is a source counterexample. Actual password extraction was not tested. See `src-tauri/src/selection_toolbar.rs:2204`, `:987`, and `:1154`.

### F11 — P1. Native capture lacks a publication fence for policy and source changes

- Off aborts the monitor, which drops the nested `pending_read` handle. Tauri wraps Tokio's `JoinHandle`, whose drop detaches the child. A capture that passed the mode check can resume after Off and publish because publication never rechecks the active capture generation. Live and clipboard capture also check running state before awaiting, with no corresponding check at publication. A plain click that dismisses the candidate can likewise leave a pending read to publish again. See `src-tauri/src/selection_toolbar.rs:776`, `:953`, `:1028`, `:1283`, `:2151`, and `:2197`.
- Separate accessibility preflight and text requests allow a focus/tab change between them. Preflight can approve site A, then the read can return text from excluded site B in the same browser. Native code rechecks the app name and constructs candidate provenance from the earlier preflight. See `src-tauri/src/selection_toolbar.rs:962` and `:981`. The clipboard route checks the focused app and has no hostname provenance check. Its explicit-import policy needs to be stated separately because clipboard text can predate the current focused page.
- These are source-level interleavings. No native capture was initiated in this review.

### F12 — P2. Native pending actions outlive the candidate and have no account binding

- Native code stores one process-wide `pending_stage` carrying candidate, action and focus flag. Dismiss and Off clear the candidate, but leave that slot. The next main initializer drains it without freshness or account checks.
- The host probe returned an old Remember payload while the current candidate was null. Mounting the initializer invoked the memory writer with that text. This verifies stale dispatch at the sink boundary. A queued action can be routed to the account open at consumption time if the account transition retains the native process. A real account transition and persisted write remain unverified. See `src-tauri/src/selection_toolbar.rs:554`, `:1558`, `:2012`, `:2734` and `selection-toolbar-initializer.tsx:483`, `:525`.

### F13 — P2. First on-demand action chord can be dropped

- When no candidate exists, Rust captures and emits the candidate, then immediately emits the shortcut. The overlay only subscribes to shortcut delivery after rendering a candidate.
- Deliver both events before the React effect mounts and Copy is lost. Repeating the shortcut after subscription reaches Copy. Manual mode and selections above 4,000 characters rely on this on-demand path. See `src-tauri/src/selection_toolbar.rs:1468` and `components/selection-toolbar/selection-toolbar-view.tsx:555`.
- Separate native issue from source. Show Toolbar and Clipboard Capture skip the raw-key claim, so when the hook also reports the base key and capture completes first, the 180 ms delayed dismissal can close the new capsule. See `selection_toolbar.rs:1248`, `:1441`, `src-tauri/src/shortcuts/registry.rs:349`.

### F14 — P2. Custom shortcuts bypass OCR's external-launch restriction

- With an OCR candidate for `https://example.com/`, Open Link is hidden. The configured `selection.action:openLink` chord nevertheless produces an `openLink` IPC with that URL. The native opener checks URL shape and protocol and lacks an origin check. The probe asserts IPC only and did not open a browser.
- The shortcut path resolves the global action table while the visible path applies `isActionSuppressed`. Compose Email shares this path. See `components/settings/selection-action-manager.tsx:165`, `selection-toolbar-actions.ts:252`, `selection-toolbar-view.tsx:440`, `:651`, and `selection_toolbar.rs:1540`.

### F15 — P2. Reused overlay keeps outdated preferences

- The overlay loads translation locale, search engine, contextual toggle, layout and shortcut display on its initial mount. Native code reuses the hidden webview. Changing the saved locale from German to Japanese and publishing a fresh candidate still invoked Translate with German. An independent probe also retained an action after saving a hidden layout.
- Settings consumers and callers can diverge until the overlay remounts. See `components/selection-toolbar/selection-toolbar-view.tsx:289` and `src-tauri/src/selection_toolbar.rs:2438`.

### F16 — P2. Chat excerpt refresh validates a semantically different selection

- An isolated database probe staged `count >= 10`, edited the source to `count <= 10`, and confirmed the fingerprint detected staleness. Refresh then returned current, kept the old snapshot and cleared staleness. Normalization strips both operators before substring comparison.
- The UI can certify a reference whose code changed meaning. See `lib/chat/selection/message-excerpt.ts:172` and `:212`.

### Additional source and rollout observations

- Windows UIA sends focus change to the automation event bus without publishing it to the selection bus. UIA selection-change signals carry length `-1`. The fallback read can return empty or above the automatic cap without retiring an old candidate. A cached shortcut can then use that candidate. This requires a Windows focus/selection repro. See `crates/cognia-automation/src/automation/platform/uia/events.rs:300`, `:330`, and `selection_toolbar.rs:981`.
- The renderer does not handle rejected handoff, launcher and language-choice IPCs. An opener or stale-candidate error can therefore leave the user without feedback. See `selection-toolbar-view.tsx:449` and `:670`. The pinned Tauri `Emitter::emit` broadcasts the candidate/stage event rather than targeting a single webview. This widens exposure to eligible local listeners. No untrusted webview exploit was demonstrated.
- Persisted shortcut hydration skips a user override when a native binding of the same ID is already registered (`lib/shortcuts/registry.ts:81`). A reviewer reproduced that ordering in isolation. The corrected cold-lock finding removes the original assumed ordering. Whether the asynchronous post-unlock startup takes that order remains open.
- For builds with `COGNIA_SELECTION_REPLACE=1`, replacement validates before waiting for the clipboard transaction, then sends an untargeted paste chord. A focus change during the wait can redirect paste. Undo tests and clears the lease under separate acquisitions, so concurrent invocations can both reach key dispatch. These are release blockers for enabling replacement, scoped to the opt-in build. See `selection_toolbar.rs:1772`, `:1856`, and `crates/cognia-automation/src/automation/commands.rs:1135`.

### Follow-up checks

- Replay script on 2026-11-09, 5 suites and 16 checks passed. The generated tests and output are under `.cache/selection-toolbar-support-audit/`.
- The integration reviewer ran 7 existing suites with 109 tests passed. The native reviewer ran `target/debug/deps/app_lib-5fa938dad8795277 selection_toolbar --test-threads=2` with 67 passed, including two NSPanel helper tests. The existing compiled artifact was reused.
- The native debug bridge again returned `bridge_unavailable`. Desktop timing, real Windows behavior, account transitions, live providers and foreign-window replacement remain open. Research edits are limited to this ledger and its replay script.

## Verification record

Existing desktop/action suites:

```sh
pnpm test --runInBand components/selection-toolbar components/providers/initializers/selection-toolbar-initializer.test.tsx components/providers/initializers/selection-toolbar-restore-initializer.test.tsx components/settings/selection-toolbar-settings.test.tsx components/settings/selection-action-manager.test.tsx lib/selection lib/tauri/selection-toolbar.test.ts lib/chat/selection/run-selection-action.test.ts hooks/chat/use-selection-action-run.test.tsx
# 18 suites passed; 280 tests passed.
```

Adjacent chat/speech suites:

```sh
pnpm test --runInBand components/chat/message-selection-toolbar.test.tsx components/chat/message-selection-result-panel.test.tsx hooks/chat/use-message-selection-actions.test.ts lib/chat/selection/selection-text.test.ts lib/tts/speak-selection.test.ts packages/tts/src/tts-orchestrator.test.ts
# 6 suites passed; 123 tests passed.
```

Counterexamples:

```sh
node docs/evidence/2026-11-08-selection-toolbar-support-audit.probes.mjs
# 3 suites passed; 7 positive defect probes passed.
# Assertions intentionally demonstrate broken current behavior, not a fixed product.
# Generated tests and log: .cache/selection-toolbar-support-audit/
```

Native invariant tests:

```sh
target/debug/deps/app_lib-5fa938dad8795277 selection_toolbar::tests --test-threads=1
# 65 passed; 0 failed; 989 filtered out.
```

This was an existing compiled binary (file timestamp 2026-11-08), not a fresh Cargo build. It supplies supporting invariant evidence, not proof that every current Rust dependency or the packaged app builds. No native paste/undo was executed against an application.

Live-shell discovery:

```sh
pnpm tauri:debug:agent:status
# ok:false; status:"bridge_unavailable"; endpoint exists but bridge is unreachable.
```

No selection-toolbar-specific E2E specification was found by searching `tests/e2e`, `tests/real-e2e` and `scripts/tauri` for `selection-toolbar`, `selection://` and `message-selection`. This is a search result, not a claim that all possible indirect coverage is absent.

The replay script passed scoped ESLint, `node --check`, and Prettier checks. The ledger passed `ledger.mjs check --final` with 0 errors and 0 warnings. An open native obligation remains explicitly carried; passing the ledger checker does not close it.

Only this ledger and its replay script were authored. The separate script preserves existing product tests and generates temporary probes under `.cache/`. No product code, settings, permissions, account, plugin installation, commit, deployment or real external send was changed. Full application typecheck/lint/build were not run for this documentation/research increment.

## Repair priority

1. F1 and F9 require checking permission freshness and the actual recipient before releasing text. Guard inputs should carry only the data their permission permits.
2. F10 and F11 require separating denied capture from empty capture and fencing native publication against source, exclusion and mode changes.
3. F3–F5 and F12 require bounded action settlement and ownership across account or renderer transitions.
4. F2, F8 and F13–F14 require a working consent surface, reliable shortcut delivery and the same origin rules for clicks and shortcuts.
5. F6, F7, F15 and F16 require correct destination reveal, result identity, preference refresh and excerpt freshness.
6. Run a fresh native build on macOS and Windows and exercise the confirmed boundaries with synthetic selections. Validate target-bound paste and single-use undo before enabling the replacement build flag.
