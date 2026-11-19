# Evidence ledger: update hot update audit

- Status: verifying
- Lane: deep
- Created: 2026-11-08
- Updated: 2026-11-08
- Related: ADR-0189, ADR-0224 A10, ADR-0226; `src-tauri/UPDATER.md`

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 研究一下现在对更新体系和热更新的支持情况，看看存在什么bug或者缺口

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                             | State       | Basis                                                                                                                             | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Update Center has adapters for desktop, mobile, browser extensions, CLI, plugins, skills, packs and hosts.                                            | Observed    | `lib/updates/runtime.ts`, source inspection 2026-11-08                                                                            | -          |
| G1  | Inventory current update and hot update support and report evidenced bugs and gaps.                                                                   | Agreed      | User request 2026-11-08                                                                                                           | -          |
| C1  | Audit only: preserve concurrent edits; do not install updates, publish releases, or change production behavior.                                       | Verified    | Request is research; dirty-tree baseline recorded 2026-11-08                                                                      | G1         |
| H1  | Background download may reach an installer because the coordinator and desktop adapter disagree about consent.                                        | Verified    | Actual coordinator/adapter fault probe invokes installer; 2026-11-08, injected I/O only                                           | O1, O2     |
| H2  | Update UI may describe a candidate different from the version selected by the underlying desktop updater.                                             | Verified    | Actual adapter/updater probe offers 2.0.0 and selects mocked native 3.0.0; 2026-11-08                                             | O1, O3     |
| Q1  | What trust root, signing credentials and private/store publication state would an actual production build use?                                        | Open        | Public delivery checked; private release environment and built artifacts not inspected, 2026-11-08                                | -          |
| O2  | Six coordinator probes reproduce unintended background installation/handoff, illegal store states, revoked fallback and ignored backoff.              | Verified    | `pnpm exec tsx .cache/update-hot-update-audit/probe.ts`; result JSON, 2026-11-08, native I/O injected                             | O1         |
| O3  | Actual adapter/updater source can offer catalog version 2.0.0 and invoke installation of native version 3.0.0; native check receives timeout only.    | Verified    | `node .cache/update-hot-update-audit/native-target-probe.cjs`; version and command assertions, 2026-11-08                         | O1         |
| O4  | Native CLI reload commits/finalizes package before renderer admission; rollback can restore package after runtime teardown failure.                   | Verified    | Fresh reviewer plus parent source reconciliation; plugin failure-injection probe, 2026-11-08; no native install                   | O1         |
| O5  | Plugin update preflight misses networkAccess widening. Production policy configures notify-only, not automatic installation.                          | Verified    | Actual updater probe with allowedDomains widened to wildcard; `lib/plugin/core/policy-runtime.ts:82`; 2026-11-08                  | O1         |
| O6  | Public stable catalog and macOS Tauri endpoint return HTTP 204; GitHub releases list is empty and latest.json returns 404.                            | Observed    | Read-only curl and gh API on 2026-11-08; commands below                                                                           | -          |
| O7  | Production browser-extension adapters have no pairedExtension/requestReload dependencies. Repo release wiring does not inject the catalog trust root. | Verified    | `lib/updates/runtime.ts:76`; literal search of checked-in workflows; 2026-11-08                                                   | O1         |
| O8  | Configured native URL omits channel/bucket; actual service defaults stable/bucket 0 and offers a one-percent release to that default.                 | Verified    | Real service handler with D1 fixture; `.cache/update-hot-update-audit/control-plane-results.json`; 2026-11-08                     | O1         |
| O9  | Existing targeted suites pass: 329 Jest tests across 19 suites, plus 44 Node release tests.                                                           | Verified    | Commands/results below, 2026-11-08; macOS arm64 / Node v26.12.1                                                                   | -          |
| G2  | Perform an adversarial review and deliver the complete reconciled issue list.                                                                         | Agreed      | User follow-up 2026-11-08: 做一次对抗性审查，然后给出完整的问题列表                                                               | G1         |
| C2  | Skip cross-model review; deliver this local review.                                                                                                   | Verified    | User selected skip after the optional doubt-driven offer, 2026-11-08                                                              | G2         |
| O10 | Standard Android build lacks the AppUpdate native dependency/registration; Play bridge returns unsupported without it.                                | Verified    | Native manifests/build inputs plus current default-loader probe, 2026-11-08                                                       | O1         |
| O11 | Actual loader can resolve unload while marking dirty; updater still commits/restores, and staging can use a stale initial status.                     | Verified    | Fresh review and parent replay of actual loader/updater probes, 2026-11-08                                                        | O4         |
| O12 | Native handle recheck/install races, candidate mutation during apply and cancelled retry have deterministic counterexamples.                          | Verified    | Four current executor scenarios, parent replay; actual JS Update.install used in one branch, 2026-11-08                           | O1         |
| O13 | Actual runtime persistence loses one concurrent skip; an in-flight check survives an account/settings switch and writes A's asset snapshot into B.    | Verified    | Actual runtime/coordinator source with in-memory serialized settings I/O; source account switch has no update cleanup; 2026-11-08 | O1         |
| O14 | Plugin apply uses mutable pending version, Skill apply re-fetches mutable latest content, and catalog failure can erase candidates as current.        | Verified    | Fresh source review; real Skill/iOS adapter and coordinator probes, 2026-11-08                                                    | O1         |
| A1  | A plugin whose update teardown fails has no recovery indication or path.                                                                              | Invalidated | Actual manager writes error/dirty diagnostics and detail UI offers Retry Cleanup; F14 withdrawn as stated, 2026-11-08             | -          |
| O15 | Initial cache probes are no longer present; historical results remain recorded, while new review probes were independently rerun.                     | Observed    | Parent and reviewer filesystem inspection, 2026-11-08; cause of cache removal not investigated                                    | -          |

## Problem frame

Determine what the checked-out implementation can discover, download, activate, restart and roll back across web/PWA, Tauri, Capacitor and plugin/content/host runtimes (G1). Distinguish implemented code, reachable runtime behavior and live delivery evidence. Deliver a support matrix, prioritized reproducible findings and explicit verification limits. Remediation and real installations are outside this research pass (C1).

Acceptance and verification: (1) map entry points to executors in source; (2) test coordinator/adapter boundaries with deterministic fault probes; (3) inspect release/catalog provisioning and perform read-only delivery checks; (4) independently audit plugin hot reload; (5) run existing focused suites, check this ledger and inspect the final task diff. No runtime source files need to be added: the existing modules own the behavior; temporary probes belong in `.cache/update-hot-update-audit/`.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                                                                                      |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Shared coordinator plus native updater, SW, plugin lifecycle, CLI and release workflows.                                                                                         |
| technical    | medium | Existing mechanisms; signature, platform and lifecycle semantics need source checks.                                                                                             |
| coupling     | high   | Shared static export and multiple processes/executors with independently selected versions.                                                                                      |
| requirement  | low    | Research scope is explicit; no product behavior decision needed.                                                                                                                 |
| verification | high   | Logic can be checked locally; a full upgrade needs installed N-1 clients and devices.                                                                                            |
| risk         | high   | Premature installs/restarts can interrupt work; metadata or runtime mismatch can defeat rollout/rollback. Audit operations remain read-only except this ledger and local probes. |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                               | Severity | Source                                                              | Claim                                                                                          | Refuted by                                                                                                    |
| --- | ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R1  | Automatic activity installs or restarts unexpectedly.                                       | high     | Coordinator contract; lens:STPA                                     | Background download moves bytes only.                                                          | A background sweep invokes installer or external handoff.                                                     |
| R2  | UI state or selected version diverges from the executor.                                    | high     | Update state contract; lens:FMEA                                    | States and target version describe what actually happened.                                     | Store handoff stays installing, or applying catalog target installs a different version.                      |
| R3  | Release policy cannot be enforced or delivered.                                             | high     | Catalog trust contract; ADR-0224 A10; lens:STRIDE                   | Revocation/channel/rollout controls survive fallback; deployed feed is usable.                 | Revoked target reappears through fallback, missing root/endpoint, mismatched artifacts.                       |
| R4  | Hot activation leaves mixed generations or disrupts in-flight consumers.                    | high     | ADR-0189, ADR-0226; fresh failure hunt                              | Reload serializes activation, protects consumers and restores usable prior runtime on failure. | Concrete interleaving or failed reload leaves stale/broken runtime.                                           |
| R5  | Web update silently changes controller or reloads active work.                              | medium   | PWA source; lens:FMEA                                               | Activation and reload are safe and user-visible.                                               | Connectivity regain unconditionally reloads, or new SW controls old document without activation coordination. |
| R6  | Concurrent writes or account/runtime changes mix update state between operations or scopes. | high     | Account scope contract; settings save queue; lens:Failure injection | Saved holds remain durable and each task writes only to its initiating account/runtime.        | Concurrent skip loses a hold, or old account check writes a snapshot in the newly selected account.           |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk                   | Method                                                                                             | Independence   | Evidence                                                                                                                                   | Coverage                                                                                                           | Status  |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------- |
| V1  | R1, R2                 | Compose real coordinator with adapters using injected native I/O, plus state-machine fault checks. | tool           | 6 coordinator cases reproduced violations; native-target probe installs mocked 3.0.0 after offering 2.0.0.                                 | Actual TS control flow, injected I/O; no real installers. Safety properties fail.                                  | failed  |
| V2  | R3                     | Inspect catalog/signing/release wiring and read-only public endpoint responses.                    | tool           | Revoked fallback reproduced; actual Worker fixture demonstrates lost cohort/channel; public 204/404 and no releases.                       | Local source, signed-metadata-shaped fixtures and public delivery only; private CI secret state not inspected.     | failed  |
| V3  | R4                     | Fresh-context read-only failure hunt, reconcile against actual owning source.                      | fresh-reviewer | Reviewer found native pre-admission commit and dirty-runtime rollback; parent re-read owning branches and reran four updater fault probes. | Plugin TS logic and Rust call-chain evidence; no actual Tauri install/process teardown.                            | failed  |
| V4  | R1, R2, R3, R5         | Run existing focused update/PWA/native bridge suites and relevant release-script tests.            | tool           | 19 Jest suites / 329 tests passed; 44 Node tests passed; 0 test failures. Plugin dialog tests emitted existing React act warnings.         | Headless regression baseline only; mocks miss the reproduced integration faults. No coverage requested or run.     | passed  |
| V5  | R1, R2, R3, R4, R5     | N-1 to N upgrade with real signed packages, web deployment and Android/iOS clients.                | real-env       | No published N/N-1 GitHub releases found; live catalog empty. No real installation performed in this audit.                                | Full delivery, crash recovery, in-flight work and rollback remain unverified.                                      | blocked |
| V6  | R1, R2, R3, R4, R5, R6 | Fresh-context adversarial review, source reconciliation and parent replay of counterexamples.      | tool           | Three independent reviewers; 13 current injected-I/O scenarios reproduced; old F14 contradicted by actual manager/UI.                      | Actual TS control flow and selected SDK class; no native installation or real account switch. Full register below. | failed  |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                         | Action   | Based on                                 | Reversal trigger                                                |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------- | --------------------------------------------------------------- |
| D1  | 2026-11-08 | Diagnose supported paths and use bounded non-installing probes before labeling suspected bugs.                                                                   | diagnose | G1, C1, O1                               | User requests remediation or new evidence changes owning paths. |
| D2  | 2026-11-08 | Report confirmed integration faults and distinguish operational gaps from deliberate platform limits. Stop expanding the hunt; remediation is a separate action. | stop     | G1, C1, O2, O3, O4, O5, O6, O7, O8, O9   | New user scope or evidence invalidates a finding.               |
| D3  | 2026-11-08 | Reopen audit after explicit adversarial-review request; challenge old claims, split independent defects and investigate scope/concurrency boundaries.            | diagnose | G2, C1, O1                               | Source/call-site counterevidence invalidates a finding.         |
| D4  | 2026-11-08 | Deliver the reconciled register, withdraw the disproved recovery claim and mark conditional/operational items separately. Skip cross-model as requested.         | stop     | G2, C1, C2, O10, O11, O12, O13, O14, O15 | New source, runtime evidence or user-requested remediation.     |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                                            | From       | Why still open                                                                           | Next action                                                                                          | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| X1  | Confirmed coordinator, state, version/policy and plugin lifecycle defects remain unfixed.                                                           | V1, V2, V3 | User requested research; no production code changed.                                     | Fix in priority order below, add composed behavioral regressions first.                              | open   |
| X2  | End-to-end signed desktop upgrades, native plugin failure recovery and Android/iOS store flows are unverified.                                      | V5         | No suitable published upgrade pair/catalog in public checks; no real install undertaken. | Prepare signed N-1/N packages and isolated clients/devices, then execute the upgrade/failure matrix. | open   |
| X3  | Private signing credentials, current deployed build trust root and store review/publication state are unknown.                                      | Q1         | Read-only public checks and checked-in workflows cannot prove private operational state. | Inspect release-run environment/provenance and actual built assets when preparing delivery.          | open   |
| X4  | PWA controller replacement and online-triggered reload were inspected/tested headlessly, not exercised across two deployed builds with active work. | R5, V5     | No full web deployment upgrade performed.                                                | Run two-version PWA upgrade with open chats, tools, unsaved editors and multiple tabs.               | open   |
| X5  | Adversarially identified version, concurrency, account-scope and mobile-wiring defects remain unfixed.                                              | V6, R6     | This is a review-only follow-up.                                                         | Use the complete register below for targeted behavioral regressions and remediation.                 | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                          | How / when measured                                                                       | Result                                                                                                                                         | Status |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | User receives support matrix and prioritized findings with sources and verification limits.     | Audit report and ledger on 2026-11-08.                                                    | Matrix, findings, probes, public delivery snapshot and validation limits recorded below. This is a completed audit, not completed remediation. | met    |
| M2  | Complete adversarially reconciled issue list is available with corrections and evidence limits. | Three fresh reviews, parent source reconciliation and current probe replay on 2026-11-08. | 25 implementation findings, 2 conditional defects and 3 delivery/acceptance gaps recorded below; original F14 withdrawn as stated.             | met    |

## Adversarial review

This section supersedes the initial pass's grouping and support claims. The user requested one adversarial review; three fresh-context reviewers independently inspected execution/coordinator, plugin lifecycle and delivery/mobile/PWA boundaries before comparing the initial findings. The parent adjudicated their findings against actual source and replayed the current counterexamples. No production source was changed. Cross-model review was offered under doubt-driven and explicitly skipped by the user.

Claim under review: the report distinguishes reachable defects, conditional capabilities and unverified losses accurately enough to guide repairs. The review deliberately sought counterexamples to the report as well as to the implementation.

Corrections:

- **Withdraw F14 as a standalone defect.** Actual manager unload failures record status error, actual dirty/error and lastError (`lib/plugin/core/manager.ts:4977-4996`). Plugin detail exposes Retry Cleanup (`components/plugins/detail/plugin-detail-header.tsx:132-138,274-285`), and clean error activation has a fresh recovery path (`manager.ts:4505-4520`). A mocked stopped runtime plus requiresRestart false did not prove recovery was absent or that a full process restart was necessary.
- **Narrow F02.** The normal Update Center intercepts character-pack apply and opens the diff directly (`components/updates/update-center.tsx:60-67,127-133`). Its adapter/coordinator transition mismatch is conditional, not evidence that normal pack updates hang. Store handoff and cancelled retry defects remain reachable at their stated executor boundaries.
- **Correct Android support.** Play Core wrapper/adapter/tests exist, but the required native AppUpdate plugin is absent from the standard mobile manifest/build registration. In-app Play download/completion must not be called supported by the standard build until wired and exercised on device.
- **Narrow F13.** Sample public requests returned no update; that does not establish deployed D1 contents, deployed revision, every channel/store's state, or the root contained in an uninspected built artifact. Root injection is missing from checked-in standard workflows; private/custom provisioning remains unknown.
- **Retain F07 with evidence limits.** Restore is attempted without confirmed runtime cleanup. The injected v1-disk/v2-orphan/finalize-success outcome is not a measured native filesystem result. Native finalize validates transaction markers and may reject after restore.
- Do not infer a separate bug merely from two independent autoDownload settings. Their divergence and the reachable macOS policy conflict are facts; whether the two settings should be consolidated is a product decision.

## Complete issue register

25 implementation findings are grouped by independently repairable root cause: 10 P1 and 15 P2. This is the complete reconciled list from this bounded audit, not proof that every update-related component is free of other defects. P1 describes a critical safety/policy or runtime-generation boundary to address before reliable production delivery; P2 describes functional/reliability failure. Evidence `reproduced` means actual source with injected I/O, not a real upgrade. `source` means owning source and reachable call chain. `historical` refers to initial-pass execution, corroborated by current source review.

| ID  | Priority | Defect and minimal trigger                                                                                                                                                                               | Owning source                                                                                                                           | Evidence / relation                                                                                                                                                                                 |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U01 | P1       | Background-download sweep passes consented true and drops downloadOnly, invoking install on Windows/Linux or opening macOS release page.                                                                 | `lib/updates/coordinator.ts:492-500,616-635`; `lib/updates/adapters/desktop-adapter.ts:109-146`                                         | Historical reproduction + fresh source; F01; setting defaults false.                                                                                                                                |
| U02 | P1       | Desktop candidate version is not bound to the native cached/rechecked install handle; offered A can install B.                                                                                           | `desktop-adapter.ts:129-146`; `lib/tauri/updater.ts:274-291,376-410`                                                                    | Historical actual-source reproduction + fresh source; F03 execution half.                                                                                                                           |
| U03 | P1       | Known catalog revocation/compatibility exclusion is lost when desktop falls back to another native feed.                                                                                                 | `desktop-adapter.ts:66-116`; `lib/updates/catalog-lookup.ts:80-98`                                                                      | Historical revoked-target reproduction + fresh source; F03 discovery half; minisign is not bypassed.                                                                                                |
| U04 | P2       | Native endpoint omits selected channel and device cohort; fallback defaults to stable/bucket 0 rather than user's policy.                                                                                | `src-tauri/tauri.conf.json:107-111`; `updater.ts:142-171`; service `index.ts:129-132,472-483`                                           | Source + initial real-handler/D1 fixture; F04.                                                                                                                                                      |
| U05 | P2       | State table rejects legitimate executor results/retries, but apply still performs side effects: store handoff stays installing; cancelled retry stays cancelled; vanished release cannot become current. | `packages/plugin-contract/src/types/agent-config/updates.ts:385-416`; `coordinator.ts:616-655`; `components/updates/update-row.tsx:168` | Current cancelled retry: 2 executor calls and 2 illegal transitions; historical store handoffs; F02 expanded.                                                                                       |
| U06 | P2       | Awaiting-restart row retains install-in-app; pressing it never invokes relaunch when automatic relaunch was disabled/failed.                                                                             | `coordinator.ts:486-490,655`; `components/updates/update-center.tsx:67`; `desktop-adapter.ts:129-158`                                   | Source; F09 split. About's separate restart button is a workaround.                                                                                                                                 |
| U07 | P2       | A check during apply overwrites candidate/action of the busy row despite rejecting its state transition. UI can say B while A was installed and persisted.                                               | `coordinator.ts:403,486-490,576,655`                                                                                                    | Current reproduction: installed 2.0.0, displayed 3.0.0, attempt target 2.0.0. Independent from U02.                                                                                                 |
| U08 | P2       | Native recheck can close a downloaded handle during install or substitute an undownloaded replacement.                                                                                                   | `updater.ts:189-194,277,320,384`                                                                                                        | Two current schedules; real SDK Update.install throws `Update.install called before Update.download` in one. No actual package corruption observed.                                                 |
| U09 | P2       | Concurrent hold/attempt writes construct whole snapshot maps from stale state; later serialized save overwrites earlier hold.                                                                            | `coordinator.ts:187-191`; `lib/updates/runtime.ts:44-50`; `stores/settings/settings-store.ts:934-936`; `lib/db/settings.ts:583-605`     | Current actual runtime/coordinator + serialized store fixture: both live skips set, first persisted skip lost.                                                                                      |
| U10 | P2       | Update singleton and in-flight tasks are not bound/reset to account/runtime scope; A's late check can persist its asset snapshot in B.                                                                   | `runtime.ts:163-170`; `coordinator.ts:285-287,754-763`; initializer cleanup; `stores/account/account-store.ts:489-530,1868-1915,2155`   | Current simulated account/settings switch with actual runtime/coordinator: same singleton, writtenAccount B, savedAsset from A. No real account data modified; no claim of chat/credential leakage. |
| U11 | P2       | Catalog network/verification/HTTP failure collapses to null/empty, so catalog-only adapters erase an available candidate as current with no failure indicator.                                           | `lib/updates/catalog-client.ts:133-151`; `coordinator.ts:380-386,504-513`; `adapters/mobile-adapter.ts:117-128`                         | Current 503, 503+Retry-After and empty-feed cases: current, candidate null, failure undefined. Failure case is a confirmed truth-state bug; authoritative-empty semantics need definition.          |
| U12 | P2       | nextCheckAt, exponential backoff and Retry-After are recorded but not consulted by production sweeps.                                                                                                    | `coordinator.ts:523-552`; `components/providers/initializers/update-center-initializer.tsx:151,174`                                     | Historical reproduction + fresh call-site search; F10.                                                                                                                                              |
| U13 | P2       | About still performs direct macOS in-place update while Update Center intentionally requires release/DMG handoff.                                                                                        | `components/settings/about/about-section.tsx:51`; `update-card.tsx:153,175-183`; `desktop-adapter.ts:167`                               | Source; F09 policy half. This does not prove native macOS replacement itself always fails.                                                                                                          |
| U14 | P1       | Native CLI reload installs/finalizes replacement before renderer admission/quiescence; refusal/timeout leaves no compensating restore.                                                                   | `src-tauri/src/cli_bridge/handlers.rs:663-675,757-766`; `crates/cognia-plugin-runtime/src/marketplace.rs:169-179,947-980`               | Two independent source reviews + parent reconciliation; F05. Native installation not performed.                                                                                                     |
| U15 | P1       | Plugin patch can widen allowed network domains without reviewing authority diff, if ordinary signature/trust requirements pass.                                                                          | `lib/plugin/lifecycle/updater.ts:781-791`; `manager.ts:4075-4082`; `lib/plugin/security/network-allowlist.ts:112`; `runtime.ts:90`      | Historical preflight probe + fresh full activation-chain review; F06. Default plugin policy remains notify-only.                                                                                    |
| U16 | P1       | Resolved teardown is mistaken for clean teardown: loader can record dirty and resolve, yet updater proceeds to commit. Existing disabled/error dirty runtime can skip unload altogether.                 | `lib/plugin/core/loader.ts:930-957`; `manager.ts:4828-4832,4958-4962`; `updater.ts:487-490,558-583`                                     | Current actual Loader+Updater probe: unload-resolved:dirty → commit-during:dirty. Manager's separate installer correctly checks unresolved resources at :3702.                                      |
| U17 | P1       | Update rollback restores old package without proving the new/old runtime has stopped; standalone rollback also lacks the post-unload dirty check.                                                        | `updater.ts:649-661`; `lib/plugin/lifecycle/rollback.ts:298-310`; `crates/cognia-plugin-runtime/src/backup.rs:203,235`                  | Current dirty-loader composite + source; F07 extended. Rollback success can be incorrectly computed by injected path; real finalize may refuse marker mismatch.                                     |
| U18 | P1       | initialStatus is captured before async staging/backup; an old plugin enabled meanwhile is not torn down before commit.                                                                                   | `updater.ts:487-490,557-583`; manager runtime-graph reservation                                                                         | Current actual Updater probe: installed → enabled during staging → commit-during:active → success true. Native package/activation I/O injected.                                                     |
| U19 | P1       | Plugin Update Center applies by pluginId rather than candidate.targetVersion; another check can change pendingUpdates from A to B after A's policy/consent check.                                        | `lib/updates/adapters/plugin-adapter.ts:66-92,104-106`; `updater.ts:448,485-486`                                                        | Complete source call chain; no separate real installation.                                                                                                                                          |
| U20 | P1       | Skill apply re-downloads mutable latest content by skillId without binding expected hash/ref, then marks the previously checked hash verified.                                                           | `adapters/skill-adapter.ts:64-92`; `runtime.ts:122-132`; `lib/skills/marketplace-install.ts:58-79`; `marketplace-skillssh.ts:271-292`   | Current real adapter fixture: checked aaaaaaaaaaaa, installed bbbbbbbbbbbb0000, result verified. No real Skill written.                                                                             |
| U21 | P2       | Single-plugin update dialog passes scalar pluginId to string[] updater API, so the id is iterated as characters and real updates disappear.                                                              | `components/plugins/dialogs/plugin-update-dialog.tsx:37,47-51,92,108`; `updater.ts:259,956-963`                                         | Historical source probe + fresh source review; F08 API half.                                                                                                                                        |
| U22 | P2       | Dialog/batch UI treats fulfilled success:false as success, removing rows or incrementing success counts.                                                                                                 | `plugin-update-dialog.tsx:118-135`; `components/plugins/plugin-batch-actions-bar.tsx:159`; `updater.ts:721-733`                         | Source; F08 result half. Update Center plugin adapter does inspect success.                                                                                                                         |
| U23 | P2       | Browser-extension version/reload bridge is unwired; an unpaired candidate may be labelled reload-extension while apply only opens store.                                                                 | `runtime.ts:76-77`; `adapters/browser-extension-adapter.ts:78-94,135-151`; executor primary action mapping                              | Source; F11 extended. Default URLs lack actual published extension ids; a catalog URL can only fix navigation.                                                                                      |
| U24 | P2       | Play AppUpdate bridge dependency/native registration is missing from standard Android build; flexible/immediate flow and completion listeners are unavailable.                                           | `lib/capacitor/app-update.ts:70-73`; `mobile/package.json:19-47`; generated Gradle inputs; `_shared.ts:133-162`                         | Source + current default-loader/native-absence fixture returns unsupported. Corrects initial support matrix.                                                                                        |
| U25 | P2       | Every browser online event requests a full reload without checking active work; Serwist reloadOnOnline false does not disable this manual handler.                                                       | `components/providers/initializers/pwa-lifecycle-initializer.tsx:39-40`; `next.config.ts:127`                                           | Source, F12 concrete behavior. Actual lost edits/tasks are unmeasured; immediate SW claim is a related activation risk, not a proven incident.                                                      |

## Conditional defects and delivery gaps

These are kept out of the 25 implementation findings to avoid inflating currently reachable failures or treating deliberate platform limits as bugs.

| ID  | Kind                       | Item                                                                                                                                                                                              | Evidence / required next step                                                                                                                                                                                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L01 | Conditional API defect     | Character-pack adapter returns available after coordinator enters installing.                                                                                                                     | State mismatch exists, but normal UI bypasses coordinator.apply and opens diff directly. Exercise only if another caller starts using this adapter path; F02 narrowed.                                                          |
| L02 | Conditional Android defect | Once native Play bridge is supplied, check with availability in-progress and downloaded false returns no candidate, so its immediate-resume apply branch cannot be reached after fresh discovery. | `mobile-adapter.ts:77-116,170-190`; initializer only promotes downloaded state. Needs a fixture/device test after U24 wiring.                                                                                                   |
| G01 | Release provisioning gap   | Checked-in release workflow does not inject NEXT_PUBLIC_UPDATE_TRUST_ROOT or gate its presence; no root makes fetchVerifiedCatalog return before network.                                         | `lib/updates/trust-root.ts:45-46`; `catalog-client.ts:91`; release/build workflows. Current shell/local env lacks assignment. Inspect actual release artifacts/private build environment before asserting their root is absent. |
| G02 | Public delivery snapshot   | Sample stable catalog and macOS updater requests return 204; visible GitHub releases list is empty and latest.json is 404.                                                                        | Read-only refresh in this review returned the same results. Does not prove deployed D1 is empty, every channel/store is unavailable or the updater protocol is broken.                                                          |
| G03 | Acceptance gap             | No signed N-1/N desktop upgrade, native dirty-runtime recovery, Android/iOS store update or two-deployment PWA activation has been accepted in this audit.                                        | Existing scoped tests plus injected counterexamples do not discharge real-shell/device obligations V5.                                                                                                                          |

Production main-app code OTA/hot replacement is not implemented; desktop/host package activation needs restart, while mobile live reload is development-only. Those are capability boundaries, not additional defects. The choice of store-only iOS delivery is not treated as a universal claim about App Store policy.

## Current adversarial verification

The parent reran the reviewer probes, rather than accepting their reports without checking source. The account/settings probe is parent-authored. These current commands exited zero because the asserted counterexamples reproduced:

| Command                                                                 | Cases and exact result summary                                                                                                                                                                                                                |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node .cache/update-adversarial-execution/probe.cjs`                    | 4 cases: A.close during A.install; undownloaded B.install throws `Update.install called before Update.download`; installed 2/displayed 3/persisted 2; cancelled retry invokes executor twice but remains cancelled.                           |
| `node .cache/plugin-hot-reload-audit/adversarial-dirty-probe.cjs`       | Actual Loader+Updater: native-unload-rejected → disable-resolved:dirty → unload-resolved:dirty → commit-during:dirty → enable-refused-dirty → restore-during:dirty. Native unload, manager projection and disk I/O injected.                  |
| `node .cache/plugin-hot-reload-audit/adversarial-status-race-probe.cjs` | Actual Updater: old-runtime-enabled-while-staging → commit-during:active → injected finalize success; result success true / requiresRestart false.                                                                                            |
| `node .cache/update-hot-update-adversarial/probe.cjs`                   | 5 cases: missing AppUpdate returns unsupported; empty/503/503+Retry-After each changes real coordinator+iOS adapter row to current/candidate null; Skill checked A but installer receives only skillId and writes fixture B, result verified. |
| `pnpm exec tsx .cache/update-adversarial-root/probe.ts`                 | 2 cases: live skips [1.1.0,1.1.0], persisted holds [null,1.1.0]; in-flight A check completes after simulated switch and writes asset account-A-private-plugin to account B through unchanged runtime singleton.                               |

There are 13 current injected scenarios in this pass. They are not 13 real-shell acceptance tests. The initial cache probe directories disappeared between audit turns; their original output in this ledger is historical evidence, not a claim those old commands still run. Current cache artifacts are also disposable, so the key observations are embedded here. No cause of disappearance is assumed.

The 329 Jest + 44 Node baseline tests above ran in the initial pass, not again in this review. Source was not changed by this task, and no broader tests/coverage/build or real installation were run. The final ledger and formatting checks are rerun after this edit. All original unresolved losses stay open; this report is not risk acceptance or remediation.

## Support matrix

| Surface                  | Implemented and reachable                                                                                                                     | Activation / current limit                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unified Update Center    | `lib/updates/runtime.ts`, initializer mounted in `deferred-boot-initializers-impl.tsx:144`, settings section and row UI                       | Per-asset checks, skip/defer, snapshots and telemetry exist. Integration faults below prevent a reliable complete flow.                                                                                                      |
| Windows / Linux desktop  | Tauri updater registered in `src-tauri/src/lib.rs:368`; check/download/install/restart ACLs; minisign key and updater artifacts configured    | Full package replacement, then process exit/restart. This is not production code hot replacement. Actual N-1/N installation was not run.                                                                                     |
| macOS desktop            | Update Center deliberately opens a release/DMG page                                                                                           | About still exposes direct in-app replacement, contradicting that restriction (F09). Store transition and background behavior also fail (F01/F02).                                                                           |
| Browser / PWA            | Production Serwist worker registered only in web runtime; static precache and offline document fallback                                       | `skipWaiting:true` + `clientsClaim:true`; controller swap produces a toast. No Update Center web-app adapter, version-specific activation consent, task drain or rollback flow.                                              |
| Android                  | Play flexible/immediate wrapper, adapter, GMS gate and listener code exist; native AppUpdate dependency is missing from standard build (U24). | Currently catalog/external-store handoff in the standard build; no verified in-app Play download/completion. Handoff state also fails centrally (F02).                                                                       |
| iOS                      | Catalog discovery and external store handoff                                                                                                  | No runtime bundle OTA updater. Production wiring supplies no default App Store URL; requires valid catalog externalUrl. Dev-only live reload is separate. No blanket claim about App Store policy is made here.              |
| Plugins                  | Stage, backup, quiesce, commit, verify, enable, finalize; frontend/Python/WASM/IDE paths have platform-specific support                       | Hot activation exists, but entry points differ in transaction and failure handling (F05–F07). Mobile deliberately excludes plugin adapter. Browser support does not imply every marketplace package has a browser installer. |
| Plugin development       | CLI/native bridge and unpacked-source watchers feed renderer lifecycle; dependency and dirty-runtime checks exist                             | Native reinstall commits before renderer checks (F05). Watcher has stronger network-scope rejection than marketplace updater.                                                                                                |
| Skills / character packs | Remote hash check and reinstall for skills; installed-parent-plugin pack version + three-way diff                                             | Content updates, not application binary updates. No signed catalog currently visible from public stable endpoint.                                                                                                            |
| Browser extensions       | Adapter models paired version and pending reload                                                                                              | Production wiring never supplies pairing/reload functions; cannot reach that capability (F11). Browser store owns actual extension installation.                                                                             |
| CLI                      | `cognia-agent update` checks npm, identifies install source and delegates after confirmation; Update Center prints package-manager command    | No in-place binary hot patch. Desktop Update Center CLI discovery depends on signed catalog, whereas CLI command has its own registry path.                                                                                  |
| Always-on host           | Server+brain paired signed release, live rollout gate, wait-for-idle, staged swap/restart, trial and rollback code                            | Native install-home and Compose/deploy-agent paths exist; desktop-embedded companion explicitly unmanaged here. Stronger lifecycle than desktop coordinator; not claimed end-to-end verified.                                |

## Prioritized findings

Priority describes impact if the trigger is reached. Confirmed source/control-flow defects are distinguished from actual native upgrade evidence. P1 means fix before enabling dependable production delivery; P2 means functional/reliability gap. No finding claims arbitrary unsigned package installation.

### F01 — P1: background download reaches installation or external handoff

`lib/updates/coordinator.ts:492-500` starts `apply({consented:true, downloadOnly:true})`. `runApply` uses downloadOnly only to name the state (`:616`), then drops it when calling the adapter (`:634-635`). `desktop-adapter.ts:133-146` interprets consented true as download-and-install. The eligibility check also fails to exclude macOS's `open-store` action.

Observed with real coordinator/adapter and injected I/O: Windows calls installer, not download-only, and remains `downloading` after the illegal transition to awaiting-restart; macOS opens the release page without an install click and remains downloading. Linux shares the consented path. Native install can exit/relaunch, so this can interrupt work; no actual app interruption was performed. This setting is false by default.

### F02 — P2: successful handoffs remain stuck installing

Every manual apply enters `installing` (`coordinator.ts:616`), while `UPDATE_STATE_TRANSITIONS.installing` in `packages/plugin-contract/src/types/agent-config/updates.ts` omits `awaiting-store`. macOS, iOS/Android, CLI command handoff and extension store handoff return awaiting-store. `setState` logs and refuses the result; UpdateRow marks installing busy and disables actions (`components/updates/update-row.tsx:49`).

The initial probe confirms `illegal installing to awaiting-store` and a persistent installing row for macOS and the injected Android executor. A vanished desktop candidate returns current from installing, which is also rejected. The adversarial pass additionally reproduced cancellation retry executing again while remaining cancelled (U05). Character-pack adapter's available result has the same API mismatch, but the normal UI bypasses coordinator.apply; it is tracked as L01 rather than a normal-flow failure. State rejection does not prevent executor side effects.

### F03 — P1: catalog policy is not bound to native installation

Two related holes:

1. `desktop-adapter.ts:66-116` drops revoked/incompatible catalog entries through bestCandidate, then unconditionally falls back to native check without applying known revocations to its answer. Probe: a revoked catalog 2.0.0 returns as available from tauri-endpoint. The healthy control plane may itself withhold that release; the defect is that a stale/alternative native feed can override a revocation the app already knows.
2. Catalog discovery returns before native check; apply ignores candidate.targetVersion and calls the generic cached/rechecked native updater. `lib/tauri/updater.ts:274-291` can select a different handle after cache expiry or on first installation. Actual-source probe: offered 2.0.0, native check/download/install selects 3.0.0. The persisted attempt can consequently attest the wrong target. Minisign still authenticates the package; it does not make this catalog selection match.

Fix direction: bind displayed consent/policy to the exact install resource and revalidate revocation/channel/version immediately before execution; distinguish catalog unavailable from catalog deliberately withholding a target.

### F04 — P2: native channel and rollout bucket are not propagated

The endpoint in `src-tauri/tauri.conf.json:109` has no channel or bucket. `updater.ts:requestOptions` passes timeout only, and native plugin construction has no dynamic channel endpoint configuration. Actual service route defaults channel to stable and missing bucket to zero (`cognia-services/services/update-server/worker/src/index.ts:129-132,472-483`).

With actual configured URL + actual Worker handler + in-memory D1, a one-percent release returns 200 for the default request and 204 for bucket 9876. Native fallback checks therefore cluster at zero; beta selection is not carried to native discovery. A catalog candidate can still have its percentage filtered locally, but installation independently rechecks the default native feed (F03). This is a source/fixture result, not a live staged rollout experiment.

### F05 — P1: CLI hot reload commits package before runtime admission

`src-tauri/src/cli_bridge/handlers.rs:663-675` installs bundle/source first. `:757-766` only then dispatches plugin_dev_reload. Local installation calls `install_local_tree_for_state` (`:1365`), which immediately commits and finalizes (`crates/cognia-plugin-runtime/src/marketplace.rs:169-179`); finalization removes the transaction backup (`:947-980`).

Renderer Developer Mode/dirty-runtime checks are later (`lib/cli-bridge/handlers/plugin-dev-reload.ts:208,228`), as is required-consumer quiescence (`lib/plugin/core/manager.ts:4767`). Refusal/timeout has no compensating package restore. A rejected reload can therefore leave new disk package with old live runtime and no transaction backup. Confirmed by complete source call chain, not a performed native install.

### F06 — P1: plugin updates do not review widened network authority

`lib/plugin/lifecycle/updater.ts:781-791` compares permissions only. A patch with unchanged network:fetch but allowedDomains changed from one approved domain to wildcard passes preflight. The actual runtime enforces networkAccess (`lib/plugin/core/context.ts:1543`); wildcard explicitly admits safe targets (`lib/plugin/security/network-allowlist.ts:112`). The ordinary install review and unpacked watcher already treat this as a review-worthy change.

Actual updater probe succeeds with widened networkAccess and no review hook. `lib/updates/runtime.ts:90` supplies no permissionsExpanded resolver to the plugin adapter, so Update Center also cannot surface this before execution. Generic click-to-update consent does not show the expanded network scope. Important reconciliation: `lib/plugin/core/policy-runtime.ts:82-88` always configures autoInstall false / notifyOnly true; do not describe default production plugin policy as silently auto-installing. The callable autoInstall engine shares the weaker preflight but is not wired by that policy UI.

### F07 — P1: rollback restores old package after new runtime teardown fails

`updater.ts:649-661` collects disable/unload failures and still calls backup.restore. Actual-source fault probe sees commit → activation failure → unload failure → restore, ending with mocked v1 disk plus v2 orphan runtime. Restore implementation replaces package/host state (`crates/cognia-plugin-runtime/src/backup.rs:203,235`). Manager's other transactional install correctly uses canRestore false when cleanup fails (`manager.ts:3741-3759`).

The probe mocks finalize success; real finalize can instead reject after restore removes the transaction marker. Proven claim: restore is attempted despite unresolved runtime, not that real finalize necessarily deletes all recovery material. Keep transaction/recovery state until runtime cleanup is confirmed.

### F08 — P2: plugin update dialogs misread API and result

Scoped dialog declares/checks a scalar pluginId (`components/plugins/dialogs/plugin-update-dialog.tsx:37,92,108`) through an unsafe cast; actual updater takes string[] (`updater.ts:259,956-963`). The source probe returns no updates for scalar audit.plugin, one update for [audit.plugin]. Existing dialog tests mock the wrong scalar contract.

The dialog removes rows after any fulfilled installUpdate (`:118-120,125-135`), and `plugin-batch-actions-bar.tsx:159` increments success unconditionally; actual updater usually returns success:false instead of rejecting (`updater.ts:721-733`). Thus failed updates can disappear/be counted as successful. Update Center's plugin adapter does check success, so the defect is limited to these separate UI paths. VS Code extensions are deliberately refused by the ordinary PluginUpdater and directed to marketplace review, making truthful failure handling especially important.

### F09 — P2: About bypasses the macOS Update Center restriction

Update Center explicitly converts macOS install to DMG/release handoff (`desktop-adapter.ts:167`). About remains mounted (`components/settings/about/about-section.tsx:51`) and directly calls native check/install (`update-card.tsx:153,175-183`), gated only by isTauri. Therefore the same app presents both restricted and in-place macOS update policies. About also owns a separate autoDownload setting, while background scheduling uses updateCenter.backgroundDownloadDesktop. They are independent settings with different behavior.

The Update Center awaiting-restart row additionally retains install-in-app instead of switching to restart-desktop; no adapter branch calls relaunch for that row. About has a separate working restart button. These are reachability/policy gaps, not evidence that a real macOS bundle was corrupted.

### F10 — P2: recorded backoff is never enforced by automatic checks

`coordinator.ts:523-548` records nextCheckAt and exposes isSweepDue, but neither runCheck nor the production initializer calls isSweepDue. A second automatic check runs despite isSweepDue false; probe counts two network-failing checks at the same timestamp. The initializer only applies a one-minute sweep throttle and fixed interval, so exponential backoff and Retry-After are bookkeeping rather than scheduling policy. Catalog responses carrying Retry-After also do not impose a catalog-wide hold.

### F11 — P2: browser extension reload is built but unwired

`lib/updates/runtime.ts:76-77` supplies only isSupported to createBrowserExtensionAdapter. With no pairedExtension, adapter always sees null, cannot display actual installed version/updatePending, and cannot call requestReload. Default store URLs also have no published extension IDs. A verified catalog externalUrl could provide a real store destination, but not the missing reload bridge. Existing injected adapter tests do not prove production wiring.

### F12 — P2: web updates have no coordinated safe activation

`app/sw.ts:48-49` sets skipWaiting/clientsClaim. `pwa-lifecycle-initializer.tsx:39` requests window.location.reload on every online event; its controllerchange handler only toasts. `next.config.ts:127` disabling Serwist reloadOnOnline does not disable this manual reload handler. There is no check here for an active model/tool run, editor state, or user consent to reload. A controller swap also does not itself reload the current document into the new app version.

Confirmed behavior is the unconditional reload request and immediate SW activation configuration. Lost edits, chunk mismatches and task interruption remain risks to test across two deployed builds, not claimed observed data loss. Native/mobile worker exclusion is implemented and should be preserved.

### F13 — operational gap: sampled public stable requests supply no upgrade

Read-only snapshot on 2026-11-08:

| Check                                                                        | Actual result        |
| ---------------------------------------------------------------------------- | -------------------- |
| `gh api 'repos/cognia-labs/cognia/releases?per_page=5'`                      | `[]`                 |
| `gh api repos/cognia-labs/cognia/releases/latest`                            | HTTP 404 / Not Found |
| GitHub latest/download/latest.json                                           | HTTP 404             |
| stable `/v1/catalog?channel=stable&platform=macos&appVersion=0.0.0&bucket=0` | HTTP 204             |
| `/v1/tauri/darwin/aarch64/0.0.0`                                             | HTTP 204             |

Checked-in service source returns 204 when no catalog row is found. The live response is consistent with that behavior, but deployed revision/database contents were not inspected. A native 204 stops endpoint iteration in the exact pinned Tauri source (`11211c30e71796cd737280303244552bb7f70797`, updater.rs:618-620), so the configured GitHub URL is an error fallback, not an empty-catalog fallback. At this snapshot these public requests supply no upgrade. This is not a claim that all possible private/store channels are empty. The adversarial pass refreshed these requests with the same 204/404/empty-list results.

`NEXT_PUBLIC_UPDATE_TRUST_ROOT` is absent in this shell and `.env.local`; checked-in release/deploy workflows contain no injection. fetchVerifiedCatalog returns null before fetching if no compiled root (`catalog-client.ts:91`). Operator tooling can generate/sign/publish roots/catalogs, but is separate from tagged release upload. Published builds' actual root remains unknown until their artifacts/build environment are inspected.

Tagged release code does enforce signing/notarization preflight, drafts, and all-desktop-platform publication; it also waits for Android and iOS jobs. A mobile credential/build failure can intentionally block desktop release creation. None of these workflows was triggered by the audit.

### F14 — withdrawn as stated: missing recovery indication/path

The initial injected probe showed no automatic reactivation and requiresRestart false after disable succeeded/unload rejected. That result did not model the real manager's error/dirty projection or recovery UI. Actual manager and detail UI do provide diagnostics and cleanup recovery; clean error retry can perform fresh activation. Therefore the original absence-of-recovery claim is withdrawn. Distinct unsafe commit/restore behavior remains in U16/U17; truthful typed outcome propagation remains in U22.

## Reproducible evidence

All local probes assert the _observed defective behavior_. Their zero exits mean the counterexample reproduced, not that the safety requirement passed. No fixture key/signature was used to install a real package, and no external updates, publishing, store operations or messages were performed.

| Command                                                               | Evidence                                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsx .cache/update-hot-update-audit/probe.ts`               | 6 scenarios; `probe-results.json` includes illegal transitions and installer/handoff calls.                      |
| `node .cache/update-hot-update-audit/native-target-probe.cjs`         | `native-target-results.json`: candidate 2.0.0, installed handle 3.0.0, check timeout only.                       |
| `node .cache/plugin-hot-reload-audit/probe.cjs`                       | 4 actual-updater-source scenarios; copied output at `.cache/update-hot-update-audit/plugin-probe-results.jsonl`. |
| `pnpm exec tsx .cache/update-hot-update-audit/control-plane-probe.ts` | `control-plane-results.json`: configured URL 200 vs bucket 9876 204 for one-percent fixture.                     |

Source scope: app HEAD observed as `8c7d787f494941c7613b5b2ef349fdfb25f61d6d`; shared checkout had concurrent changes/commits. No tracked runtime source was edited by this task. Services checkout HEAD `71984922519c7bed73332bc38f9178fed444dbbc`; update Worker source diff against app-pinned `487e9f2d617c9d1b9b648ec510cafcf53b962c2c` is empty. Cache probes are intentionally local/ignored, not product modules.

Existing tests actually run:

```sh
pnpm test -- --runInBand --runTestsByPath \
  lib/updates/coordinator.test.ts \
  lib/updates/adapters/desktop-adapter.test.ts \
  lib/updates/adapters/mobile-adapter.test.ts \
  lib/updates/catalog-client.test.ts lib/updates/catalog-lookup.test.ts \
  lib/updates/runtime.test.ts lib/tauri/updater.test.ts \
  lib/capacitor/app-update.test.ts \
  components/providers/initializers/update-center-initializer.test.tsx \
  components/providers/initializers/pwa-lifecycle-initializer.test.tsx
# 10 suites / 180 tests passed.

pnpm test -- --runInBand --runTestsByPath \
  lib/plugin/lifecycle/updater.test.ts \
  lib/cli-bridge/handlers/plugin-dev-reload.test.ts \
  lib/plugin/local/unpacked-sources.test.ts \
  components/plugins/dialogs/plugin-update-dialog.test.tsx \
  components/plugins/plugin-batch-actions-bar.test.tsx \
  components/settings/about/update-card.test.tsx \
  lib/updates/adapters/browser-extension-adapter.test.ts \
  lib/updates/adapters/host-adapter.test.ts \
  lib/updates/adapters/cli-adapter.test.ts
# 9 suites / 149 tests passed. Existing React act warnings in dialog tests.

node --test scripts/release/update-catalog.test.mjs \
  scripts/sync/version-sync.test.mjs \
  scripts/ci/require-macos-release-signing.test.mjs
# 44 tests passed, 0 failed.
```

No full typecheck, lint, production build, Rust suite, coverage or UI/native upgrade acceptance was run: production source is unchanged, and this pass verifies a bounded research report. The public endpoint checks and source probes do not substitute for V5.

## Recommended follow-up order

1. F01/F02/F03/F04: explicit download-only executor mode, legal state/result matrix, exact-version resource binding, channel/cohort/revocation enforcement. Test real coordinator+adapter composition, not only isolated mocks.
2. F05/F06/F07/F14: one transactional replacement protocol across CLI, marketplace and watcher; admission and complete authority diff before commit; no restoration until runtime cleanup is confirmed; retain recovery material on uncertainty.
3. F08/F09/F10/F11/F12: unify old and new UI policies, propagate typed update outcomes, wire extension state/reload, enforce backoff, and add user/task-aware web activation.
4. F13/V5: provision trust root and publish signed catalog/release pairs, then perform N-1/N desktop, store/device and two-version PWA acceptance including interrupted work, offline, corrupt signatures, disk failure and crash recovery. No risk acceptance is implied by this list.

Reference: [official Tauri Updater documentation](https://v2.tauri.app/plugin/updater/) for separate check/download/install, package signature verification and endpoint semantics. Exact behavior claims above use the repository-pinned source, rather than assuming the latest documentation matches the shipped revision.
