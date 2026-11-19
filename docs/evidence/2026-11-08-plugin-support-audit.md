# Evidence ledger: plugin support audit

- Status: verifying
- Lane: standard
- Created: 2026-11-08
- Updated: 2026-11-17
- Related: ADR-0016, ADR-0126, ADR-0155, ADR-0156; `2026-10-28-plugin-contract-runtime-completion.md`; `2026-11-03-plugin-storage-write-errors.md`
- Evidence directory: `.cache/plugin-support-audit/`

## Original request

> 研究一下现在对插件体系的支持情况，看看存在什么bug或者缺口

## Knowledge

| ID  | Statement                                                                                                                                                 | State    | Basis                                                                                                                                                                       | Depends on         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| G1  | Audit current support and report reproducible defects, intentional boundaries and verification gaps.                                                      | Agreed   | User request, 2026-11-08.                                                                                                                                                   | -                  |
| C1  | Preserve concurrent work; do not change production behavior, publish, or modify real plugin installations.                                                | Verified | AGENTS.md and initial/final dirty-tree inventories, 2026-11-08.                                                                                                             | -                  |
| O1  | There are 81 in-tree manifests: 76 frontend, four Python, one WASM; none selects the isolated Node-target frontend runtime.                               | Verified | Direct `plugins/*/plugin.json` inventory and loader's runtime-selection predicate, 2026-11-08.                                                                              | -                  |
| O2  | Canonical contract 1.7.0 declares five plugin types, 93 API namespaces and 950 methods; point catalog has 298 points, 292 implemented and six deprecated. | Verified | Current `packages/plugin-contract/contract/{catalog,plugin-points}.json`, 2026-11-08. Counts describe declarations.                                                         | -                  |
| O3  | Node callbacks reset activation state and discard host calls made during the callback.                                                                    | Verified | Real subprocess probe: counter results 1,1; callback frame contains only result despite awaited storage.set. `node-reproductions.log`, 2026-11-08.                          | -                  |
| O4  | Node activation replay does not await an asynchronous context method.                                                                                     | Verified | Real loader with deferred storage.set: activation completed before write settlement. `reproductions-final.log`, 2026-11-08.                                                 | -                  |
| O5  | Tauri Python loader invokes an absent legacy command and requests an unavailable-runtime warning before the manager's real Python load.                   | Verified | Loader probe and command-source search; current manager uses plugin_python_load. `loader.ts:492,554`, `manager.ts:4293,7434`, 2026-11-08.                                   | -                  |
| O6  | Browser storage quota arithmetic mixes bytes and UTF-16 code-unit counts.                                                                                 | Verified | A three-Mi-character value resolves despite exceeding the host's five-MiB budget; control writes pass. `storage-api.ts:127-134,215`, `reproductions-final.log`, 2026-11-08. | -                  |
| O7  | Updater misses prerelease-to-stable versions and ignores its prerelease option in the Cognia update path.                                                 | Verified | 1.0.0-beta.1 to 1.0.0 yields no update; allowPrerelease=false still dispatches update for 1.1.0-beta.1. `reproductions-final.log`, 2026-11-08.                              | -                  |
| O8  | General update checking omits installed plugins whose runtime is suspended.                                                                               | Verified | Same manifest/version produces one update when enabled and none when suspended. `reproductions-final.log`, 2026-11-08.                                                      | -                  |
| O9  | Author-type freshness and API-matrix checks currently fail.                                                                                               | Verified | author-types.log: three stale embedded declaration entries; api-matrix.log: Unclassified namespace sync. 2026-11-08.                                                        | -                  |
| O10 | Structural gates and focused existing behavior tests pass within their stated scope.                                                                      | Verified | Contract/import/SDK/slots/hooks/VS Code gates; focused-tests.log: 13 suites, 744 tests; node-host-baseline.log: seven tests. 2026-11-08.                                    | -                  |
| H1  | Contract completeness can differ from runtime/platform behavior.                                                                                          | Verified | O2 versus O3-O9; declaration counts are not acceptance evidence.                                                                                                            | O2, O3, O4, O5, O9 |
| H2  | Existing green tests leave lifecycle and update edge cases uncovered.                                                                                     | Verified | Existing baseline passes while new discriminating probes fail on the owning implementation.                                                                                 | O6, O7, O8, O10    |

| G2 | Perform a fresh adversarial review and provide the consolidated issue list. | Agreed | User follow-up, 2026-11-08. | G1 |
| G3 | Audit current plugin API gaps and problems against established industry practices. | Agreed | User request, 2026-11-17: 帮我分析一下现在的插件API的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践 | - |
| G4 | Adversarially review the API audit and the actual API implementation; refute weak findings and seek missed defects. | Agreed | User follow-up, 2026-11-17: 做一次对抗性审查 | G3 |
| G5 | Audit plugin versions, environment preparation, installation, updates and recovery across supported hosts. | Agreed | User follow-up, 2026-11-17: 同理帮我分析一下现在的插件更新、版本管理之类的，以及不同环境的插件准备、安装、更新之类的 | G1 |
| C2 | This follow-up changes evidence only; preserve shared source changes and avoid real installations or external writes. | Verified | Read-only analysis scope and shared-tree instructions, 2026-11-17. | G3 |
| O11 | Earlier API/runtime findings are historical evidence and need current owning-source verification before reuse. | Observed | Existing ledger dated 2026-11-08; fresh review began 2026-11-17. | - |
| O12 | Current catalog declares 93 namespaces and 945 methods; 17 namespaces enforce centrally and 76 use shadow policy. | Verified | Canonical catalog inventory, .cache/plugin-api-audit/inventory.json, 2026-11-17. Declaration counts are not behavioral acceptance. | - |
| O13 | Three normal SDK paths fail live permission revocation: promoted web tools, existing event subscriptions and remote-desktop provider registration. | Verified | Actual-owner source probes plus rejecting controls; authority-review-main-confirmation.log, 2026-11-17. Final Host execution is mocked. | - |
| O14 | Isolated Node-target bridge mishandles binary values, async iterables, live configuration, synchronous getters and local DOM discovery. | Verified | Actual codecs and child context probes, runtime-review-main-confirmation.log, 2026-11-17; no real filesystem/provider call. | - |
| O15 | Host compatibility accepts incompatible zero-major/prerelease versions and rejects a valid compound range. | Verified | Real canonical evaluator against installed node-semver: four mismatches and two agreeing controls; compatibility.probe.log, 2026-11-17. | - |
| O16 | Contract, public imports, standalone baseline and WIT checks pass; embedded author types and the API research matrix are stale. | Verified | Refreshed direct check logs; five focused Jest suites / 84 tests and Node baseline 16 tests pass, 2026-11-17. | - |
| O17 | Established platforms document explicit execution location, resource permissions, stable/proposed APIs, typed transport and real-host extension testing. | Verified | Official VS Code, Chrome Extensions, Extism and npm/node-semver pages linked in the dated comparison below; read 2026-11-17. | - |
| O18 | The registered simple AI-provider adapter drops abortSignal, stringifies rich content and changes tool-role messages to user-role messages. | Verified | Source-extracted buildPluginLlmCodeAdapter probe with text-stream control; ai-provider.probe.log, 2026-11-17. No actual provider called. | - |
| O19 | Fresh adversarial probes identify eight additional confirmed issue groups, including the formerly component-only stale-generation risk. | Verified | API11-API18 below; real manager lifecycle, real Node subprocess and actual SDK/registry probes; primary reviewer replayed the scripts, 2026-11-17. | - |
| O20 | Compatibility defaults to warn, and full npm-semver compound ranges are not an established public promise. | Verified | manager.ts:1068,2557-2589; canonical satisfiesSimpleRange and manifest engines documentation; fresh reviewer reconciliation, 2026-11-17. | - |
| O21 | Nine original API defects survive stronger route checks; the compatibility item needs qualification, and several tempting privacy/leak claims were rejected. | Verified | API01-API08 and API10 retained; actual registered adapter/IPC, real manager and live Node transport probes. Rejected candidates documented below, 2026-11-17. | O13, O14, O18, O20 |
| O22 | Preparation, package mutation and runtime execution have different owners across Tauri, browser/mobile, standalone CLI and supervised headless. | Verified | Current source matrix in the lifecycle section; inspected package scripts, installer/manager/CLI/native owners, 2026-11-17. | - |
| O23 | The lifecycle audit identifies nineteen issue groups with controlled component probes or owning-source chains; some historical findings are now repaired. | Verified | PL01-PL19 below, independent update/install/preparation checks plus primary review and replay; .cache/plugin-lifecycle-audit/, 2026-11-17. Native acceptance is explicitly excluded. | - |
| O24 | Python dependency installation is explicit; load checks imports and does not automatically provision dependencies. Complete data rollback is not provided by package snapshots. | Verified | Actual native Python owner/source; actual Dexie update regression; paths and limits in lifecycle section, 2026-11-17. | - |
| O25 | Current Host authoring ABI differs from its pin; focused existing Jest checks pass while artifact producer test startup fails at the ABI guard. | Verified | final-freshness.json: styleContractSha256, sdkSourceSha256, lockfileSha256 drift; 15 Jest suites / 393 tests passed; Node 48 passed, one file failed before test startup, 2026-11-17. | - |

## Problem frame

Map plugin authoring and user lifecycle through the SDK, loader, governed context, persistence and visible consumers (G1). Separate demonstrated defects from intentional runtime restrictions and untested acceptance. This task adds this evidence document and disposable probes/logs under `.cache/plugin-support-audit/`. It does not implement repairs, commit, deploy, or touch real installations (C1). The existing contract/storage ledgers concern earlier repairs; this broader current-support audit links them without changing their historical evidence.

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                               |
| ------------ | ------ | ----------------------------------------------------------------------------------------- |
| scale        | high   | SDK/contract, frontend/native runtimes, installation/distribution, user interfaces.       |
| technical    | medium | Existing implementations and runners; no new runtime design.                              |
| coupling     | high   | Browser/Tauri/Capacitor and CLI/headless share contracts and lifecycle.                   |
| requirement  | low    | Research and evidence-backed findings explicitly requested.                               |
| verification | high   | Logic is reproducible headlessly; packaged native/mobile/provider acceptance is separate. |
| risk         | medium | Reversible audit; findings about execution and persistence require counterexamples.       |

## Current support map

| Area                   | Current owning implementation and evidence                                                                                                                                                                                  | Boundary                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime bootstrap      | AppRuntime mounts PluginRuntimeInitializer; shell-specific bootstrap selects browser/mobile/Tauri and account ownership. CLI plugin-runtime supplies importer/fetcher/native invoker and selects headless when appropriate. | Reachable source and bootstrap tests checked; no live application boot in this audit.                                                         |
| Plugin types           | Loader dispatches frontend, Python, hybrid, WASM and VS Code extensions. Node-target is a frontend subtype selected by engines.node or the Tauri node entrypoint.                                                           | The 81 bundled manifests exercise frontend/Python/WASM; no in-tree hybrid, VS Code or Node-target manifest was counted.                       |
| Authoring and contract | Public SDK/UI/contract packages, Python SDK and Rust/WIT surfaces; canonical contract 1.7.0 and wire protocol 2.0.0. All 81 plugins pass the public-import gate.                                                            | SDK standalone gate allows five existing baselined Host references; passing does not mean zero dependencies or current embedded author types. |
| Contributions          | Slots, commands/tools, hooks, skills, workflows, providers, UI registries and lifecycle consumers have concrete registration/teardown paths. Slot audit passes; hook audit reports 141 fired, zero virtual.                 | Structural and focused behavioral checks do not prove every contribution on all shells.                                                       |
| Installation/lifecycle | Local/URL/GitHub/registry install adapters, staged commit/rollback, permission review, config, disable/unload/uninstall, update/backup and portable cogpack/cogset modules exist.                                           | Marketplace package install/update requires desktop. No live marketplace download or real installation was performed.                         |
| Permission/security    | Explicit frontend trust, signature policy, PermissionGuard, governed context, generation-aware native paths and account gate exist.                                                                                         | Trusted renderer JavaScript is not an isolation boundary; this audit makes no blanket security sign-off.                                      |
| VS Code compatibility  | Current coverage gate passes against its VS Code 1.91.0 inventory: 317 implemented, 65 explicitly unsupported, zero unclassified/missing.                                                                                   | This is the standalone shim's bounded inventory; it is not compatibility with every VS Code API or the separate Managed Pro IDE.              |
| Native guests          | WASM loader uses native Host on Tauri/headless; Python manager uses supervised plugin_python_* commands. Browser/mobile do not execute these native guests locally.                                                         | Native transport and real guest acceptance were not executed; see the Python false-warning defect.                                            |

Effective bundled manifest declarations, using the current mobile/headless fallback rules:

| Runtime  | supported | degraded | blocked |
| -------- | --------- | -------- | ------- |
| Tauri    | 81        | 0        | 0       |
| Browser  | 39        | 13       | 29      |
| Mobile   | 34        | 15       | 32      |
| Headless | 32        | 17       | 32      |

These are **manifest availability declarations**, not measured working-plugin counts. Host-derived auth/network diagnostics, runtime provisioning, permissions and the defects below can narrow actual availability. Mobile inherits browser compatibility when absent; headless inherits Tauri for native/Node targets and browser for other frontend plugins.

## Confirmed findings

### 1. P1: Node callback host effects are lost; callback state is recreated

- Sources: `scripts/plugin/node-plugin-host.mjs:65-72,180-193,215-235`; `crates/cognia-plugin-runtime/src/lifecycle.rs:1034-1062`; loader callback revival at `lib/plugin/core/loader.ts:147-150`.
- The context records calls and returns undefined. A callback action runs activate again in a new process and returns only the encoded result. Its recorded storage/AI/other host calls are neither returned nor executed, and the native boundary extracts only result.
- Real-process reproduction: a callback increments an activation-local counter, awaits `ctx.storage.set("last", count)`, and returns count. Two invocations return 1,1; both frames contain only `{result:{handled:true,payload:1}}`. The expected second value of 2 and expected write delivery both fail; the ordinary callback control passes.
- Impact: stateful Node plugins and host side effects in their commands/tools do not have the declared plugin semantics. Re-running activation can also repeat plugin-local effects. No bundled manifest currently selects this path, so do not generalize to all 81 bundled plugins.
- Repair direction: keep callbacks in their owned live runtime and implement an acknowledged bidirectional context bridge, or explicitly refuse unsupported context operations with an author-visible bounded contract. Merely replaying callback writes does not fix reads, return values or lost closure state.

### 2. P2: Node activation publishes success before async host replay settles

- Source: `lib/plugin/core/loader.ts:161-190,428`.
- `replayNodePluginActivation` calls `method.apply(owner,args)` without awaiting it; its caller also does not await replay.
- Probe: defer the actual context storage.set promise. The real loader's activation has already completed while the host write remains pending. This violates activation ordering and can detach write failures from activation rollback.
- Repair direction: await replayed async work and propagate failure through the existing lifecycle cleanup. This is distinct from finding 1's missing callback RPC.

### 3. P2: Python runtime is falsely labeled unavailable on Tauri

- Sources: `lib/plugin/core/loader.ts:492-554`; current native functions in `crates/cognia-plugin-runtime/src/python/commands.rs`; real load at `lib/plugin/core/manager.ts:4293,7434`; warning renderer in `components/plugins/plugin-status-badge.tsx:96-107`.
- The loader still attempts `plugin_load_python`; the native registry/source has `plugin_python_load` and no legacy command. Rejection falls through to a stub, whose activate requests persistent `python-runtime-unavailable` metadata. The manager subsequently invokes the real supervised Python host.
- Probe: simulate the current native command surface refusing the absent legacy name. The removed-command assertion fails, and the fallback is reached. The warning path writes manifest metadata and has no corresponding successful-load clearing path here.
- Impact: an otherwise runnable Python/hybrid plugin can be misleadingly marked unavailable. This audit does **not** conclude that all Python execution is broken; the canonical manager path exists and is separate.
- Repair direction: remove the duplicate legacy loader lifecycle and use the manager-owned Python lifecycle consistently; reconcile stale warnings after confirmed native success.

### 4. P2: Browser per-plugin storage budget is undercounted

- Source: `lib/plugin/api/storage-api.ts:127-141,198-215`.
- getUsage returns UTF-16 bytes, but newEntrySize and existingSize are code-unit lengths. A first value of 3,145,728 ASCII characters is accepted by the host calculation even though its serialized value alone exceeds six MiB under the same byte metric; the documented budget is five MiB.
- Probe uses a quota-free Storage implementation to isolate the host calculation. Small write and same-size overwrite controls pass. The overflow refusal assertion fails with `Received promise resolved instead of rejected`.
- Impact: per-plugin accounting does not enforce its own budget, potentially consuming shared origin storage. A real browser may independently reject at its origin quota; this probe does not assert that every browser will physically store six MiB.
- Headless storage already counts bytes consistently inside a transaction and is outside this finding.
- Repair direction: use one byte metric for current/replaced/new entries and serialize check-plus-write if concurrent writes must obey the same budget.

### 5. P2: Update version and prerelease policy are inconsistent

- Sources: `lib/plugin/lifecycle/updater.ts:301,843-912,936-948`.
- The comparator splits on dots and parseInt's each part: 1.0.0-beta.1 to 1.0.0 is not detected. Prerelease identifiers and build metadata do not receive proper version precedence.
- AutoUpdateConfig declares allowPrerelease but the Cognia path never reads it. In the probe, allowPrerelease=false and latestVersion=1.1.0-beta.1 still dispatch update for an installed 1.0.0 plugin. Open VSX separately hard-codes stable-only selection, so the same option cannot opt in there either.
- Scope: current policy-runtime configures notifyOnly=true and autoInstall=false. The default app flow can offer the unwanted candidate; automatic prerelease installation is demonstrated only for callers configuring autoInstall=true, not claimed for the default UI setting.
- Repair direction: reuse the project's semver utilities and apply one explicit prerelease policy across Cognia and Open VSX selection.

### 6. P2: General update checks omit suspended plugins

- Source: `lib/plugin/lifecycle/updater.ts:970-986`.
- getAllInstalledPlugins enumerates installed/runtime statuses without suspended, although the manager preserves enabled intent while suspending and the update method explicitly handles suspended reactivation.
- Probe: enabled 1.0.0 with available 1.0.1 returns one update; changing only status to suspended returns none. Explicit checkForUpdates([id]) uses another path and is unaffected.
- Impact: check-all/automatic checks can silently miss installed idle-suspended plugins. No current bundled manifest opts into idleSuspend, so the common trigger is an external plugin or explicit suspension.
- Repair direction: derive installed membership from installation identity or include the resting installed states, with a status-matrix regression.

### 7. Authoring/research gates are not fully current

- `pnpm author-types:check` exits 1 after successful declaration builds: the embedded `crates/cognia-cli/assets/author-types.json` differs in entries `types/cognia-plugin-sdk.d.ts`, `types/provider-types/index.d.ts`, and `types/provider-types/provider-profile.d.ts`. These are **keys inside the embedded bundle**, not three root filesystem files.
- Impact: generated authoring declarations can disagree with current SDK/provider source. Regenerate and review in the owning SDK change; this audit deliberately does not overwrite concurrent generated artifacts.
- `pnpm plugin:api-matrix:check` exits 1: `Unclassified namespace sync; add an explicit namespace rule.` The classification rules omit sync, so matrix freshness cannot currently be established. This is a research/gate gap, not proof that ctx.sync runtime itself fails.

## Risks

| ID  | Risk (impact)                                                    | Severity | Source                              | Claim                                                                          | Refuted by                                                         |
| --- | ---------------------------------------------------------------- | -------- | ----------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| R1  | Declaration counts overstate behavior.                           | high     | ADR-0016, ADR-0126                  | Report distinguishes declarations, reachable consumers and runtime acceptance. | A declared point is presented as measured three-shell behavior.    |
| R2  | Permission or lifecycle failure is missed or overstated.         | high     | ADR-0155, risk catalog, lens:STRIDE | Concrete runtime findings have source paths and discriminating probes.         | An alleged runtime failure cannot be reproduced against its owner. |
| R3  | Persistence/update paths falsely report success or availability. | medium   | Prior storage ledger, lens:FMEA     | Audit checks write budgets and update error/selection boundaries.              | Green nominal tests are the only evidence for the claim.           |
| R4  | Headless results are mistaken for native/mobile acceptance.      | medium   | Risk catalog                        | Every result states its environment and omissions.                             | Unit success is reported as packaged native/device acceptance.     |

## Verification obligations

| ID  | Risk   | Method                                                                           | Independence | Evidence                                                                                                                                                                                                                           | Coverage                                                                                                          | Status |
| --- | ------ | -------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1     | Contract, author types/imports, SDK standalone, matrix and slot/hook gates.      | tool         | Contract, author-imports, SDK standalone, slots, hooks and VS Code coverage passed. author-types and api-matrix exited 1; logs under evidence directory.                                                                           | Current source consistency; five SDK references remain baselined; no coverage run.                                | failed |
| V2  | R2, R3 | Focused existing lifecycle, loader, permissions, install and storage tests.      | tool         | focused-tests.log: 13 suites / 744 tests passed. node-host-baseline.log: seven real-node/helper tests passed. contract-runtime-tests-final.log: five suites / 250 tests passed. Total unique existing Jest suites: 18; tests: 994. | Headless logic, fault/error paths and some real subprocess behavior; no real native app.                          | passed |
| V3  | R2, R3 | New minimal counterexamples and positive controls.                               | tool         | reproductions-final.log: six expected acceptance failures and three controls passed. node-reproductions.log: two expected failures and one control passed.                                                                         | Eight deliberate red assertions confirm the reported defects; these are diagnosis evidence, not fixed acceptance. | passed |
| V4  | R1, R4 | Inspect bootstrap, UI consumers, runtime declarations and actual command owners. | tool         | Source paths in support map and findings; manifest inventory and source snapshot retained.                                                                                                                                         | Reachability and supported boundaries only; real app/device/provider smoke not executed.                          | passed |

| V5 | R1, R2, R3 | Fresh-context adversarial source review across runtime, transactions and permission/SDK boundaries. | fresh-reviewer | Three independent bounded reviews completed; reconciled catalog B01-B25, G01-G02 and rejected candidates below. | Source contracts, counterexamples and false-positive rejection; no external model CLI. | passed |
| V6 | R2, R3 | Reproduce and reconcile newly reported failures. | tool | Main UI/storage run: three expected red assertions, three controls passed; reviewer probes recorded per stable issue ID. | Actual-source narrow probes and explicit source-only/native limits. | passed |
| V7 | R1, R2 | Refresh canonical API inventory and API-related consistency gates. | tool | Inventory refreshed; contract/imports/standalone/WIT passed. author-types and api-matrix checks exit 1 for stale artifacts; exact logs under .cache/plugin-api-audit/. | Current checkout; declarations and consistency, not shell acceptance. | failed |
| V8 | R1, R2 | Trace API discoverability, compatibility, cancellation and resource semantics; independently review runtime parity and authority. | fresh-reviewer | Initial ten candidate groups were behaviorally probed; API09 was later qualified by V10-V11. Existing focused Jest: 5 suites / 84 tests; Node baseline: 16 tests passed. Stronger follow-up evidence below supersedes the component-only generation limit. | Actual-owner boundary probes, selected dependency stubs and rejecting controls; no blanket security certification or packaged acceptance. | passed |
| V9 | R1 | Compare concrete gaps with current primary documentation from established plugin platforms. | tool | Official VS Code, Chrome Extensions, Extism and npm/node-semver pages read and linked with claim-specific comparisons below. | Design comparison; recommendations are judgment rather than measured product outcomes. | passed |
| V10 | R1, R2 | Fresh adversarial review of authority, real Node transport, AI-provider and compatibility paths; challenge mocks and finding scope. | fresh-reviewer | Three fresh-context reviews completed; one bounded review of the new foreign-registry mutation probe completed. Nine original defects retained, API09 qualified, API11-API18 recorded. User explicitly skipped cross-model review. | Source and reversible probes; no production changes or real user data. | passed |
| V11 | R1, R2 | Independently reconcile counterexamples, inspect alleged regressions and run discriminating tests with controls. | tool | Primary reviewer replayed real-child, actual AI routing/IPC and registry scripts; actual manager suite: 1 diagnostic test passed; existing registry/guardrail baseline: 3 suites / 16 tests passed. Exact logs listed in dated follow-up. | Specific failure conditions, not exhaustive platform certification; successful probes assert defects, not repairs. | passed |
| V12 | R1, R3, R4 | Map version identities and environment-specific prepare/install/update/restore paths from actual owners. | tool | Matrix and version taxonomy recorded below; desktop/native and standalone/supervised CLI distinguished; Python explicit install and paired-client UI gates traced. | Current source, declarations and UI/CLI consumers; no real installations. | passed |
| V13 | R2, R3 | Freshly inspect acquisition, update transactions and build artifacts; reproduce failure/cancellation/version-policy counterexamples with controls. | fresh-reviewer | Independent update and preparation reports, installation probes/source-chain findings and main reconciliation; all replayed probes retained under cache directory. Root CLI probes received a bounded independent review. | Synthetic packages and edge-stubbed effects; native/provider acceptance remains separate. Source-only chains are labeled. | passed |
| V14 | R1, R3 | Run focused existing checks and compare actionable lifecycle gaps with current primary platform practices. | tool | 15 unique existing Jest suites / 393 tests passed; 4 diagnostic suites / 11 assertions passed. Existing Node checks: 48 passed, one produce.test.mjs file fails at current ABI pin guard. Official VS Code, TUF, PyPI and npm docs read. | ABI drift is a real current checkout blocker, not a repaired or delivered-release failure. No coverage or mutating root preparation/build commands. | failed |

## Decisions

| ID  | Date       | Decision                                                                                                                                 | Action   | Based on                           | Reversal trigger                                                                  |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| D1  | 2026-11-08 | Audit current source and tests; prioritize demonstrated defects without production repairs.                                              | diagnose | G1, C1, O1                         | User requests implementation or evidence changes scope.                           |
| D2  | 2026-11-08 | Use actual Node subprocess probes and deferred host writes to distinguish callback transport gaps from ordinary unsupported permissions. | diagnose | O3, O4                             | The host gains a live bidirectional bridge or state-preserving callback dispatch. |
| D3  | 2026-11-08 | Deliver the audit with explicit open defects and environment gaps; do not claim the plugin system is fully accepted.                     | diagnose | G1, C1, O3, O4, O5, O6, O7, O8, O9 | Repairs and matching real-environment evidence become available.                  |

| D4 | 2026-11-08 | Re-enter diagnosis with a fresh adversarial review; extend the current ledger rather than opening another. | diagnose | G2, C1 | New current-source evidence refutes a prior finding. |
| D5 | 2026-11-17 | Re-enter API-focused diagnosis and industry comparison; refresh evidence before prioritizing repairs. | diagnose | G3, C2, O11 | User changes scope or current source refutes historical findings. |
| D6 | 2026-11-17 | Prioritize live authority and transport correctness, then effective capability discovery and conformance fixtures; align host/UI changes with ADR-0250 rather than adding a competing contract. | diagnose | G3, C2, O12, O13, O14, O15, O16, O17, O18 | Full manager/native evidence or a new contract changes the observed failures or migration boundary. |
| D7 | 2026-11-17 | Re-enter diagnosis and challenge the dated API audit before using it as an implementation contract. | diagnose | G4, C2 | Current-source counterevidence changes a finding or a fresh defect changes priority. |
| D8 | 2026-11-17 | Put cross-plugin provider/registry ownership and activation-generation fencing ahead of broad API expansion; correct compatibility claims and preserve failed teardown as a distinct repair. | diagnose | G4, C2, O19, O20, O21 | A route-level owner/generation fence or actual runtime counterevidence refutes a retained case. |
| D9 | 2026-11-17 | Extend the existing support ledger with a fresh distribution/lifecycle audit; historical update/install findings are pointers, not current verdicts. | diagnose | G5, C2 | Current owners or tests establish repaired behavior or a different supported environment boundary. |
| D10 | 2026-11-17 | Prioritize host-issued trust evidence, approved package identity and transactional consistency across install paths; distinguish package rollback from data rollback and shipped notify policy from optional auto-install. | diagnose | G5, C2, O22, O23, O24, O25 | Real native acceptance or a source fix refutes a retained chain or changes the environment boundary. |

## Residual risks

| ID  | Residual                                                                                | From                       | Why still open                                                                                                                                | Next action                                                                                                            | Status |
| --- | --------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Confirmed behavioral defects remain unfixed.                                            | V3, O3, O4, O5, O6, O7, O8 | This is a research request; red probes intentionally remain red.                                                                              | Repair Node Host semantics first, then Python lifecycle, quota and updater; move probes into owning co-located suites. | open   |
| X2  | Two current consistency gates fail.                                                     | V1, O9                     | Embedded author declarations and API-matrix classification need owning changes.                                                               | Regenerate/review embedded author types; classify sync and rerun matrix check.                                         | open   |
| X3  | Packaged desktop, Android/iOS, real provider and live registry acceptance are untested. | V4, R4                     | No real installation, device session or deployed service was exercised. This is an unexecuted scope limit, not a claimed environment failure. | Run the relevant real flow after scoped repairs with disposable plugins/accounts.                                      | open   |
| X4  | Audit is bounded and the checkout is shared.                                            | R1, R2                     | Other sessions committed work during the audit. Not every API or security boundary was exhaustively reviewed.                                 | Use source hashes/snapshot for reproduction and recheck affected sources when implementing.                            | open   |

| X5 | Expanded adversarial findings remain unrepaired and some native paths lack real-environment reproduction. | V5, V6 | This remains an audit; source-only evidence is identified per catalog row. | Repair and add owning regressions, then exercise native race/install/restore cases. | open |
| X6 | Current author declarations and API research matrix are stale. | V7, O16 | Checks fail on this shared checkout; no generated source repair was requested. | Regenerate and review in the owning change, then rerun the exact checks. | open |
| X7 | Seventeen confirmed API issue groups and one qualified compatibility concern remain unresolved; packaged desktop/device/provider acceptance is unexecuted. | V8, V10, V11, O19, O20, O21 | This remains analysis. Probes deliberately avoid real user data and real external effects; native relay/install and isolation are not certified. | Repair owning call paths and rerun regression fixtures plus actual shells. | open |
| X8 | Prior component-only stale-generation uncertainty is resolved for the synthetic frontend manager lifecycle. | V8, V11 | Actual manager enable-disable-enable reproduces generation-1 context writing after generation-2 grants; native/cross-account scope remains in X7. | Carry the cache repro into an owning regression when fixing API13. | closed |
| X9 | Requested adversarial review is complete within its stated bounds. | V10, V11 | Findings reconciled; remaining product defects and real-environment gaps are carried in X7. | Use the refined catalog below for repairs; user skipped cross-model review. | closed |
| X10 | Lifecycle defects, recovery capability gaps and current preparation ABI drift remain unresolved. | V12, V13, V14 | This is an analysis task; artifact producer check fails on the shared checkout and no product remediation was authorized. | Repair owning paths and integration drift, then run the per-environment acceptance matrix. | open |
| X11 | Actual native install/update/recovery, cross-platform packaging and real dependency provisioning were not run. | V12, V13, V14 | Controlled probes avoid real plugin directories, downloads, user data and dependency installations; source-only chains are not native certification. | Use disposable N-1/N packages, clean environments and failure injection after repairs. | open |

## Outcome

| ID  | Signal                                                                 | How / when measured                                                                       | Result                                                                                 | Status |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| M1  | Deliver a current support map and actionable evidence-backed findings. | Source inventory, structural gates, existing tests and discriminating probes, 2026-11-08. | Support/platform map and seven finding groups recorded; production behavior unchanged. | met    |

| M2 | Deliver the adversarially reconciled complete issue catalog for the reviewed surfaces. | Three fresh-context reviews, primary source reconciliation and fault probes, 2026-11-08. | B01-B25 behavior findings and G01-G02 gate gaps recorded, with intentional limits and rejected candidates separated; cross-model skipped at user request. | met |
| M3 | Deliver a current API gap analysis with source evidence, industry comparison and an actionable order of work. | Current inventory, two fresh reviews, primary reviewer replays and official-document comparison, 2026-11-17. | Initial ten candidate groups and six capability gaps delivered; M4 refines the finding count and lifecycle evidence. | met |
| M4 | Challenge the API audit and deliver a reconciled issue list with stronger evidence and rejected claims. | Three bounded fresh reviews, targeted registry re-review and main-session replay, 2026-11-17. | Nine original defects retained; one compatibility item qualified; seven new defects plus the prior lifecycle risk promoted, yielding seventeen confirmed groups and one compatibility concern. | met |
| M5 | Deliver current plugin version/preparation/install/update/recovery support and gaps across environments. | Current source, independent investigations, controlled probes, scoped tests and official practice comparison, 2026-11-17. | Environment matrix, version taxonomy, PL01-PL19 issue catalog, capability gaps and verification limits recorded below. | met |

## Reproduction and validation commands

Run from the repository root. Logs and scratch fixtures/config remain in `.cache/plugin-support-audit/` and are not committed.

```sh
pnpm plugin:contract:check
pnpm plugin:author-imports
pnpm plugin:sdk:standalone
pnpm author-types:check
pnpm plugin:api-matrix:check
pnpm audit:slots
pnpm audit:hooks
pnpm audit:vscode-api-coverage
pnpm test --runInBand --runTestsByPath lib/plugin/core/manager.test.ts lib/plugin/core/loader.test.ts lib/plugin/core/runtime-compatibility.test.ts lib/plugin/core/bootstrap.test.ts lib/plugin/security/permission-guard.test.ts lib/plugin/api/permission-api.test.ts lib/plugin/api/storage-api.test.ts lib/plugin/lifecycle/updater.test.ts lib/plugin/lifecycle/backup.test.ts lib/plugin/package/marketplace.test.ts lib/plugin/marketplace/install-flow.test.ts hooks/plugins/use-plugin-enable-action.test.tsx hooks/plugins/use-plugin-uninstall.test.tsx
pnpm test --runInBand --runTestsByPath lib/plugin/contracts/governed-context.test.ts lib/plugin/contracts/runtime-proof-audit.test.ts lib/plugin/contracts/permission-catalog-parity.test.ts lib/plugin/package/local-installer.test.ts lib/plugin/package/http-installer.test.ts
node --test scripts/plugin/node-plugin-host.test.mjs
pnpm test --config .cache/plugin-support-audit/jest.audit.json --runInBand --runTestsByPath .cache/plugin-support-audit/updater.audit.test.ts .cache/plugin-support-audit/storage.audit.test.ts .cache/plugin-support-audit/loader.audit.test.ts
node --test .cache/plugin-support-audit/node-runtime.audit.test.mjs
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/2026-11-08-plugin-support-audit.md --final
```

The custom audit Jest config derives from the repository's resolved jsdom project, preserves its setup/transform/module mapping, and excludes other cache snapshots. Early scratch attempts had config/path mistakes; only `reproductions-final.log` is the completed diagnostic run. An additional test command initially named core/governed-context.test.ts instead of contracts/governed-context.test.ts; that invocation is not counted as passing. No full lint, typecheck, production build, coverage, browser UI smoke, native package test or device test was run for this documentation-only audit.

## Adversarial review: 2026-11-08

Authoritative consolidated list for this review: **25 behavioral findings (12 P1, 13 P2), plus two consistency-gate gaps**. This is the complete list of confirmed findings from the bounded review, not a claim of exhaustive defect absence across all 950 methods. Prior numbered sections remain the first-round record; the stable IDs below are the reconciled issue catalog.

Fresh reviewers: review_runtimes, review_install_updates and review_permissions_sdk. They received artifacts and contracts without the prior report or its reasoning; the main session separately reviewed mirrored UI failure paths, reproduced new failures, and checked counter-evidence. No production code changed.

Cross-model escalation was offered under doubt-driven. The user explicitly chose to skip; no external model CLI ran.

Evidence levels: **D** = deterministic current-source probe (real Node subprocess, actual-source transpilation/extraction or fault injection as stated); **S** = complete current source/caller/protocol chain, without real-shell reproduction; **C** = executed consistency check. D is not packaged Tauri/device acceptance.

### Consolidated issue catalog

| ID  | Priority | Finding                                                                        | Evidence | Owning source                                                                                                                                        |
| --- | -------- | ------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 | P1       | LocalProfile data crosses ctx.storage, including encrypted values              | D        | `lib/plugin/api/storage-api.ts:45-50; lib/plugin/api/crypto-helpers.ts:58; stores/plugin-runtime/plugin-store.ts:1270-1298`                          |
| B02 | P1       | A pending optional permission request can grant the next account               | D        | `lib/plugin/api/permission-api.ts:236-278; lib/plugin/security/account-isolation.ts:22-26; components/plugins/plugin-permission-request-host.tsx:60` |
| B03 | P1       | Mirrored toggle can address a different account or Host after await            | D        | `lib/plugin/core/set-plugin-enabled-for-host.ts:80-88; lib/db/mobile-outbound-queue.ts:342`                                                          |
| B04 | P1       | toJSON can introduce uninspected PII after the network gate                    | D        | `lib/plugin/api/plugin-pii-gate.ts:194-205; lib/plugin/core/context.ts:1657-1660`                                                                    |
| B05 | P2       | First optional grant disagrees with guard-only API enforcement                 | D        | `lib/plugin/api/permission-api.ts:271-278; lib/plugin/core/context.ts:296`                                                                           |
| B06 | P1       | Node callback/deactivate cannot access the live activation state               | D        | `scripts/plugin/node-plugin-host.mjs:180-227; crates/cognia-plugin-runtime/src/lifecycle.rs:961-980`                                                 |
| B07 | P1       | Node callback/deactivate context side effects are discarded                    | D        | `scripts/plugin/node-plugin-host.mjs:201-238; crates/cognia-plugin-runtime/src/lifecycle.rs:1057-1062`                                               |
| B08 | P1       | Node context reads/handles return undefined and actual config is missing       | D/S      | `scripts/plugin/node-plugin-host.mjs:54-77,180-187; lib/plugin/core/loader.ts:413-428`                                                               |
| B09 | P2       | Node activation completes before asynchronous host replay settles              | D        | `lib/plugin/core/loader.ts:161-190,428`                                                                                                              |
| B10 | P1       | A hanging deactivate permanently occupies the lifecycle queue                  | D/S      | `lib/plugin/core/manager.ts:6330; lib/plugin/core/manager.ts:4779-4786`                                                                              |
| B11 | P1       | Failed Python unload can still be reported clean and inactive                  | D/S      | `lib/plugin/core/manager.ts:6350-6363,1737-1742,4828-4838`                                                                                           |
| B12 | P2       | Sidecar-free VS Code contributions become dirty when unloaded                  | D/S      | `lib/plugin/core/vscode-loader.ts:428-440,595-605; lib/plugin/core/loader.ts:909-917`                                                                |
| B13 | P1       | Node stop/action lock ordering permits an old action after stop                | S        | `crates/cognia-plugin-runtime/src/lifecycle.rs:706-716,1044-1046,1095-1097`                                                                          |
| B14 | P2       | Python loader requests an unavailable warning through removed IPC              | D/S      | `lib/plugin/core/loader.ts:492-554; lib/plugin/core/manager.ts:4293,7434`                                                                            |
| B15 | P1       | WASM Git replacement commits before capability review and ignores cancellation | D/S      | `components/plugins/dialogs/plugin-wasm-from-git-dialog.tsx:84-96; crates/cognia-plugin-runtime/src/wasm/installer.rs:778-805`                       |
| B16 | P2       | WASM Git installation does not reconcile the live plugin inventory             | S        | `lib/plugin/package/git-installer.ts:97-111; components/plugins/plugin-panel-toolbar.tsx:405`                                                        |
| B17 | P2       | Update rollback violates the native transaction-finalize protocol              | S        | `lib/plugin/lifecycle/updater.ts:661-708; crates/cognia-plugin-runtime/src/marketplace.rs:961-965,277-288`                                           |
| B18 | P1       | Backup panel restores disk trees while the old runtime keeps running           | S        | `components/plugins/plugin-backup-panel.tsx:60,135; lib/plugin/lifecycle/backup.ts:367-377; crates/cognia-plugin-runtime/src/backup.rs:203-214`      |
| B19 | P2       | Backup panel ignores normal restore/delete failure results                     | S        | `components/plugins/plugin-backup-panel.tsx:131-140; lib/plugin/lifecycle/backup.ts:379-386`                                                         |
| B20 | P2       | Version comparison misses prerelease to stable                                 | D        | `lib/plugin/lifecycle/updater.ts:936-947`                                                                                                            |
| B21 | P2       | Prerelease selection ignores the declared update option                        | D/S      | `lib/plugin/lifecycle/updater.ts:886-893,414; lib/plugin/core/policy-runtime.ts:82-88`                                                               |
| B22 | P2       | General update checks omit suspended installed plugins                         | D        | `lib/plugin/lifecycle/updater.ts:970-986`                                                                                                            |
| B23 | P2       | Browser per-plugin quota mixes bytes and code-unit lengths                     | D        | `lib/plugin/api/storage-api.ts:127-141,198-215`                                                                                                      |
| B24 | P2       | Concurrent browser writes race the per-plugin quota check                      | D        | `lib/plugin/api/storage-api.ts:127-141`                                                                                                              |
| B25 | P2       | Failed mirror enqueue leaves an optimistic durable flag without intent         | D        | `lib/plugin/core/set-plugin-enabled-for-host.ts:80-96`                                                                                               |
| G01 | P2       | Embedded author declarations are stale                                         | C        | `crates/cognia-cli/assets/author-types.json; scripts/plugin/generate-author-types.mjs:247-251`                                                       |
| G02 | P2       | API-matrix namespace classification is incomplete                              | C        | `scripts/gates/convergence/plugin-api-matrix.mjs:1094-1098`                                                                                          |

### B01: LocalProfile data crosses ctx.storage, including encrypted values

- Priority: P1; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/api/storage-api.ts:45-50; lib/plugin/api/crypto-helpers.ts:58; stores/plugin-runtime/plugin-store.ts:1270-1298`.
- Trigger and consequence: Profile A writes; after account teardown and profile B activation, the same plugin reads A values through ordinary get and getSecure. Browser/Desktop keys contain only pluginId, and secure values use a per-install rather than per-profile root.
- Evidence and limits: Actual storage/crypto/key source probes returned A plaintext and decrypted private data in B. Headless account-database storage is excluded. Normal trusted plugin use is sufficient; no renderer escape is claimed.

### B02: A pending optional permission request can grant the next account

- Priority: P1; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/api/permission-api.ts:236-278; lib/plugin/security/account-isolation.ts:22-26; components/plugins/plugin-permission-request-host.tsx:60`.
- Trigger and consequence: A public ctx.permissions.requestPermission waits while A is torn down; the independent request queue survives. B remounts the dialog and approves the old request; the continuation mirrors a grant through the current Host.
- Evidence and limits: Fresh reviewer exercised actual governed context, disposable scope, callback binding, queue and teardown source: scopeAborted=true, old prompt remains, result=true, grant write profile=B. The method resourceEffect is none; outer wrappers do not prevent the side effect after the internal await.

### B03: Mirrored toggle can address a different account or Host after await

- Priority: P1; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/core/set-plugin-enabled-for-host.ts:80-88; lib/db/mobile-outbound-queue.ts:342`.
- Trigger and consequence: The mirror row update uses scope A, but enqueue resolves account, target and database afresh after that await. A runtime-target switch can turn A intent into a command for B.
- Evidence and limits: Actual source probe deferred A update then selected B/host-B: A queue empty, B queue receives plugin_set_enabled with accountId B and targetId host-B. Switching only Host avoids relying on account-database close timing.

### B04: toJSON can introduce uninspected PII after the network gate

- Priority: P1; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/api/plugin-pii-gate.ts:194-205; lib/plugin/core/context.ts:1657-1660`.
- Trigger and consequence: sanitizeValue retains function values in structured bodies. A body toJSON function survives the gate and credential resolution, then runs during final JSON.stringify, producing previously uninspected locally derived text.
- Evidence and limits: Actual redact/gate/resolver/public callback wrapper/network API probe with a fake fetch captured {"prompt":"contact alice@example.com"}; hasNoLeakingPii on the wire body was false despite piiPolicy=block and literalCredentials=inspect. No real network send or credential was used.

### B05: First optional grant disagrees with guard-only API enforcement

- Priority: P2; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/api/permission-api.ts:271-278; lib/plugin/core/context.ts:296`.
- Trigger and consequence: For a first-time optional filesystem:read grant, API permission state is updated but PermissionGuard.grant runs only for an already revoked permission. Introspection returns true while ctx.fs still refuses.
- Evidence and limits: Actual API/queue/guard probe: granted=true, hasPermission=true, guardCheck=false, PermissionError filesystem:read. Re-grant after revocation and APIs combining both stores are counterexamples that narrow the scope; they do not fix the first-grant path.

### B06: Node callback/deactivate cannot access the live activation state

- Priority: P1; evidence: D; reconciliation: valid + actionable.
- Source: `scripts/plugin/node-plugin-host.mjs:180-227; crates/cognia-plugin-runtime/src/lifecycle.rs:961-980`.
- Trigger and consequence: Each callback runs in a fresh subprocess and re-runs activate; deactivate imports a fresh module without activating it. State, connections and closure variables from the retained activation process are unavailable.
- Evidence and limits: Real Node probes return counter values 1,1; a deactivate requiring activation-local state throws. No bundled manifest currently chooses Node-target execution.

### B07: Node callback/deactivate context side effects are discarded

- Priority: P1; evidence: D; reconciliation: valid + actionable.
- Source: `scripts/plugin/node-plugin-host.mjs:201-238; crates/cognia-plugin-runtime/src/lifecycle.rs:1057-1062`.
- Trigger and consequence: The recorder accumulates calls, but callback returns only result and deactivate only ok. Native code also extracts only result. storage.set and other host calls can appear successful without executing.
- Evidence and limits: Real callback probe awaiting storage.set produces only a result frame, with no write delivery. Activation-only replay does not cover callbacks or deactivate.

### B08: Node context reads/handles return undefined and actual config is missing

- Priority: P1; evidence: D/S; reconciliation: valid + actionable.
- Source: `scripts/plugin/node-plugin-host.mjs:54-77,180-187; lib/plugin/core/loader.ts:413-428`.
- Trigger and consequence: The recording proxy returns undefined for every method, while host execution occurs only after activate finishes. Reads, translation results and disposer/handle APIs cannot satisfy the public signatures. The child is created with config={} rather than actual context.config.
- Evidence and limits: Actual recorder storage.get returns undefined; source contains no response channel or actual config argument. This is a missing runtime API bridge, separate from the intentionally unavailable network/subprocess brokers.

### B09: Node activation completes before asynchronous host replay settles

- Priority: P2; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/core/loader.ts:161-190,428`.
- Trigger and consequence: Replay invokes method.apply without awaiting returned Promises. Activation can complete before storage/registration work or failures settle.
- Evidence and limits: Deferred actual loader context storage.set remains pending while activation completion is true. Rejections can detach from activation rollback.

### B10: A hanging deactivate permanently occupies the lifecycle queue

- Priority: P1; evidence: D/S; reconciliation: valid + actionable.
- Source: `lib/plugin/core/manager.ts:6330; lib/plugin/core/manager.ts:4779-4786`.
- Trigger and consequence: disable/unload directly awaits definition.deactivate without the activation/hook timeouts. A never-settling Promise prevents loader teardown, permission cleanup and later same-plugin lifecycle operations.
- Evidence and limits: Fresh reviewer executed the unchanged extracted method with a pending deactivate and observed it remain pending. The loader teardown budget is downstream and cannot protect this await.

### B11: Failed Python unload can still be reported clean and inactive

- Priority: P1; evidence: D/S; reconciliation: valid + actionable.
- Source: `lib/plugin/core/manager.ts:6350-6363,1737-1742,4828-4838`.
- Trigger and consequence: The Python unload catch records a diagnostic without throwing or populating runtimeCleanupFailures. Retained Python generation is not part of hasUnresolvedActivationResources. Disable can release the lease and publish clean inactive without proving the process stopped.
- Evidence and limits: Extracted current method with unload rejection resolves with cleanupFailureCount=0 and unresolved=false. Full native transport failure injection remains unexecuted.

### B12: Sidecar-free VS Code contributions become dirty when unloaded

- Priority: P2; evidence: D/S; reconciliation: valid + actionable.
- Source: `lib/plugin/core/vscode-loader.ts:428-440,595-605; lib/plugin/core/loader.ts:909-917`.
- Trigger and consequence: Theme/grammar/snippet-only extensions activate without a native generation. Generic unload nonetheless requires that generation, records dirty teardown, and subsequent recovery has no generation to retire.
- Evidence and limits: Actual transpiled loader probe: theme activation succeeds, generation undefined, unload reports runtime generation unavailable. Existing generation-bearing extension tests do not cover this path.

### B13: Node stop/action lock ordering permits an old action after stop

- Priority: P1; evidence: S; reconciliation: valid + actionable.
- Source: `crates/cognia-plugin-runtime/src/lifecycle.rs:706-716,1044-1046,1095-1097`.
- Trigger and consequence: stop holds the write gate while awaiting child kill, leaving the registry generation visible. A new callback validates that generation before waiting for its read gate. After stop removes the generation, the callback acquires the gate and spawns without revalidation.
- Evidence and limits: Complete source ordering establishes the race. Existing stale-at-entry and action-before-stop tests do not cover callback entry while stop holds the write gate. No Rust concurrency fault-injection run was performed; retain that verification obligation.

### B14: Python loader requests an unavailable warning through removed IPC

- Priority: P2; evidence: D/S; reconciliation: valid + actionable.
- Source: `lib/plugin/core/loader.ts:492-554; lib/plugin/core/manager.ts:4293,7434`.
- Trigger and consequence: The legacy plugin_load_python command is absent; its rejection chooses a stub that requests python-runtime-unavailable metadata, before manager uses the real plugin_python_load path.
- Evidence and limits: Removed-command probe reaches fallback; current native command inventory and warning writer confirm the mismatch. This is a false warning, not a claim that supervised Python execution is universally broken.

### B15: WASM Git replacement commits before capability review and ignores cancellation

- Priority: P1; evidence: D/S; reconciliation: valid + actionable.
- Source: `components/plugins/dialogs/plugin-wasm-from-git-dialog.tsx:84-96; crates/cognia-plugin-runtime/src/wasm/installer.rs:778-805`.
- Trigger and consequence: The Git path directly replaces the canonical package and removes its previous tree, then asks for capability review. A null cancellation result is ignored and installation success callbacks run. Same-id replacement has no staged rollback protecting the old package.
- Evidence and limits: Actual current dialog handler probe with requestGrant=null calls onInstalled once and closes. Native replacement/source path is confirmed; no real installation was performed. ZIP/URL transaction protection is not on this Git path.

### B16: WASM Git installation does not reconcile the live plugin inventory

- Priority: P2; evidence: S; reconciliation: valid + actionable.
- Source: `lib/plugin/package/git-installer.ts:97-111; components/plugins/plugin-panel-toolbar.tsx:405`.
- Trigger and consequence: Installer records origin and returns but does not register with manager/store/DB or scan; production toolbar supplies no onInstalled callback. Fresh installs remain on disk without immediate enableability; replacements retain old live manifest/runtime.
- Evidence and limits: Call-site and event/watcher search found no inventory refresh on this path. Source-confirmed reachability gap; real native UI acceptance remains unexecuted.

### B17: Update rollback violates the native transaction-finalize protocol

- Priority: P2; evidence: S; reconciliation: valid + actionable.
- Source: `lib/plugin/lifecycle/updater.ts:661-708; crates/cognia-plugin-runtime/src/marketplace.rs:961-965,277-288`.
- Trigger and consequence: After post-commit failure, TS restores a pre-update backup and then finalizes the update transaction. That old package lacks the transaction ownership marker required by finalize. The transaction remains, and startup recovery refuses the restored package as unknown ownership/version.
- Evidence and limits: Current TS/Rust source chain requires installed package does not belong to this transaction. Existing TS tests mock finalize success. Native refusal to overwrite unknown packages is correct; the TS rollback protocol is wrong. Full native failure injection remains open.

### B18: Backup panel restores disk trees while the old runtime keeps running

- Priority: P1; evidence: S; reconciliation: valid + actionable.
- Source: `components/plugins/plugin-backup-panel.tsx:60,135; lib/plugin/lifecycle/backup.ts:367-377; crates/cognia-plugin-runtime/src/backup.rs:203-214`.
- Trigger and consequence: Data/Backup calls raw backup.restore, not the lifecycle-aware rollback manager. It replaces package/host-state trees without reservation, disable, unload, scan or reactivation, while requiresRestart is always false.
- Evidence and limits: Enabled v2 to restored v1 gives v1 disk state with v2 runtime/store projection by the current call chain. The separate PluginRollbackManager does quiesce/refresh but is bypassed by this panel.

### B19: Backup panel ignores normal restore/delete failure results

- Priority: P2; evidence: S; reconciliation: valid + actionable.
- Source: `components/plugins/plugin-backup-panel.tsx:131-140; lib/plugin/lifecycle/backup.ts:379-386`.
- Trigger and consequence: Restore commonly returns success=false and delete returns false rather than throwing. The panel awaits either and returns null, clearing busy without showing the error.
- Evidence and limits: The error result is consumed as success on the current handler path. Existing tests check invocation and create errors, not negative restore/delete results.

### B20: Version comparison misses prerelease to stable

- Priority: P2; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/lifecycle/updater.ts:936-947`.
- Trigger and consequence: Dot splitting and parseInt do not implement version precedence. Installed 1.0.0-beta.1 is not offered 1.0.0.
- Evidence and limits: Both original and independent source probes returned no update/false. Reviewer assertion that beta.1 to beta.2 also fails was rejected: its final numeric component is compared correctly.

### B21: Prerelease selection ignores the declared update option

- Priority: P2; evidence: D/S; reconciliation: valid + actionable.
- Source: `lib/plugin/lifecycle/updater.ts:886-893,414; lib/plugin/core/policy-runtime.ts:82-88`.
- Trigger and consequence: Cognia selection does not read allowPrerelease; false can still dispatch a beta update. Open VSX separately hard-codes false, ignoring a true opt-in.
- Evidence and limits: Actual auto-update probe dispatches demo at 1.1.0-beta.1 despite false. Default app policy is notifyOnly=true, autoInstall=false: do not claim the default UI silently auto-installs betas.

### B22: General update checks omit suspended installed plugins

- Priority: P2; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/lifecycle/updater.ts:970-986`.
- Trigger and consequence: The installed-status allowlist excludes suspended. General/automatic checks miss those plugins, while explicit-id checks and update reactivation handle them.
- Evidence and limits: Changing only enabled to suspended changes one available update to zero. No bundled manifest currently opts into idleSuspend; external plugins/explicit suspension are the relevant scope.

### B23: Browser per-plugin quota mixes bytes and code-unit lengths

- Priority: P2; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/api/storage-api.ts:127-141,198-215`.
- Trigger and consequence: getUsage returns UTF-16 bytes, while replacement/new entry sizes use character counts. The host budget can accept an oversized value.
- Evidence and limits: Fresh probe accepts a three-Mi-character value. Browser origin quota is a separate possible refusal; this does not claim all real browsers store the value.

### B24: Concurrent browser writes race the per-plugin quota check

- Priority: P2; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/api/storage-api.ts:127-141`.
- Trigger and consequence: Two set calls read usage before either writes; no serialization or atomic check-plus-write exists. Correcting byte units alone does not eliminate this race.
- Evidence and limits: Discriminating fresh real-method probe: two writes of two Mi-characters each both fulfilled concurrently and getUsage=8388756 bytes, exceeding 5242880; the same writes sequentially reject the second and remain below budget. Headless uses a database transaction and is excluded.

### B25: Failed mirror enqueue leaves an optimistic durable flag without intent

- Priority: P2; evidence: D; reconciliation: valid + actionable.
- Source: `lib/plugin/core/set-plugin-enabled-for-host.ts:80-96`.
- Trigger and consequence: The mirror flag is committed before enqueue in a separate transaction. If queue insertion fails, the function reports ok=false but does not restore the flag.
- Evidence and limits: Fresh fake-IndexedDB probe with actual entry point: enqueue rejects, result.ok=false, stored enabled=true although previously false. Successful enqueue control passes. This is independent of B03 scope drift.

### G01: Embedded author declarations are stale

- Priority: P2; evidence: C; reconciliation: valid + actionable.
- Source: `crates/cognia-cli/assets/author-types.json; scripts/plugin/generate-author-types.mjs:247-251`.
- Trigger and consequence: The SDK and provider source disagree with the embedded authoring bundle.
- Evidence and limits: author-types:check reports changed bundle entries types/cognia-plugin-sdk.d.ts, types/provider-types/index.d.ts and types/provider-types/provider-profile.d.ts. They are bundle keys, not root filesystem files.

### G02: API-matrix namespace classification is incomplete

- Priority: P2; evidence: C; reconciliation: valid + actionable.
- Source: `scripts/gates/convergence/plugin-api-matrix.mjs:1094-1098`.
- Trigger and consequence: sync has no explicit namespace layer rule, preventing matrix freshness checking.
- Evidence and limits: plugin:api-matrix:check exits 1 with Unclassified namespace sync. This is not evidence that ctx.sync runtime execution itself fails.

### Intentional capability boundaries and product gaps

| ID  | Boundary                                                                                            | Current consequence                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C01 | Node has no scoped network/subprocess broker.                                                       | These grants are explicitly refused; this is incomplete capability, not an implicit safe fallback.                                                                                                                                         |
| C02 | Browser/mobile do not locally execute Python/WASM/VS Code guests.                                   | Use supported frontend paths or a native Host; mirrored execution must be labeled as Host execution.                                                                                                                                       |
| C03 | Standalone VS Code shim inventory is bounded.                                                       | 65 APIs are explicitly unsupported in its VS Code 1.91.0 inventory; the separate Managed Pro IDE does not make the shim fully compatible.                                                                                                  |
| C04 | Package installation/update/backup mutations and mirrored uninstall are bounded by Host capability. | Mirrored clients cannot remove the Host package through the current queued command vocabulary; desktop-only affordances must remain explicit.                                                                                              |
| C05 | Native plugin backups are filesystem snapshots.                                                     | They do not snapshot desktop ctx.storage/localStorage, Dexie configuration/dynamic plugin tables or install-origin rows. Existing tests intentionally reject incompatible data downgrades; do not promise full application-state rollback. |

### Rejected or unconfirmed candidates

- Rejected: beta.1 to beta.2 is also missed. The current comparator compares the final numeric component and detects that particular update. B20 retains only proven prerelease-to-stable/version-precedence defects.
- Rejected as new defects: declared Node broker refusals, explicit browser native-runtime limits, documented literal-credential observe transition, and intentional incompatible-Dexie-downgrade refusal.
- Counter-evidence: ordinary createGuardedAPI consent paths recheck revocation/account after await; auth session reads recheck auth:consume. Neither candidate became a finding.
- Unconfirmed: legacy WASM preopen-ledger migration might cross account scope. The complete evidence chain was not established, so it is not in the confirmed catalog.
- Scope corrections: bundled runtime availability numbers are manifest declarations; no bundled manifest selects Node-target or opts into idleSuspend; default auto-update policy only notifies. These limits constrain the reported blast radius.

### Verification and retained evidence

- First-round existing baseline: 18 Jest suites / 994 tests and seven Node host tests passed. Those are historical completed results from this session, not evidence that the new adversarial cases pass.
- Fresh reviewer existing-test run: updater, backup and review-client, three suites / 62 tests passed (overlaps the baseline; not summed as unique tests).
- Main-session new UI/storage probe run: two suites; three expected red assertions and three passing controls. The failures are quota units, concurrent quota enforcement and durable optimism after enqueue failure. See `.cache/plugin-support-audit/adversarial-ui-storage.log`.
- Fresh reviewers executed the narrow actual-source probes described per finding, including public permission wrappers, real crypto/key derivation, actual queue scope resolution, the final network serialization path, and real Node callback/deactivate branches.
- Main-session focused existing regression run: seven suites / 120 tests passed (`adversarial-existing-tests.log`). Refreshed author-types:check and plugin:api-matrix:check both exit 1 with the same three stale bundle entries and unclassified sync namespace (`adversarial-author-types.log`, `adversarial-api-matrix.log`).
- The first-round disposable cache was observed absent during this follow-up. The report and source were intact; current scratch probes/config/logs were recreated under the same cache directory. Earlier test results remain recorded in tool output and this ledger, but the original temporary log/probe files are not claimed to be retained. Reproduction triggers and exact source locations above are the durable record.
- Not executed: full typecheck/lint/build/coverage, real plugin install/update/restore, packaged native fault injection, Rust race injection, live provider/registry traffic, browser UI/device acceptance. These remain explicit verification gaps; no production failure rate or blanket security acceptance is claimed.

Catalog count check: 27 entries; 12 P1 behavior entries, 13 P2 behavior entries, 2 gate gaps.

### Adversarial finalization

The primary reviewer read the owning call paths for each reviewer finding, retained the independent source/probe scope, and corrected the beta.1-to-beta.2 false detail. The browser quota race was strengthened with a sequential control: equal writes are refused sequentially but accepted concurrently. This distinguishes concurrency from the separately confirmed byte-unit bug. All stable catalog entries are actionable findings; documented limitations and the incomplete WASM legacy-ledger hypothesis remain outside the confirmed count.

No business source, generated SDK declaration bundle, native installation, user data, or published state was changed. The only task-authored non-cache artifact is this ledger. It remains verifying because repairs and real-environment acceptance are open; the requested adversarial review and consolidated issue list are complete.

## API-focused refresh and industry comparison: 2026-11-17

### Scope and current conclusion

Request: “帮我分析一下现在的插件API的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践”. The investigation is complete; repairs are not part of this request. This dated section supersedes the older section only where it explicitly refreshes a claim. It does not relabel all historical findings as current.

The API is already broad. The largest current gaps are live authority, faithful cross-process values and streams, effective capability discovery, and real-runtime conformance. Adding more namespaces would not address those failures. This is a prioritization judgment based on the counterexamples below, not a measured production incident rate.

Current declaration inventory (`packages/plugin-contract/contract/catalog.json`):

| Item                      | Current value                           | Meaning                                                                                                              |
| ------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| SDK / contract / protocol | 0.3.0 / 1.7.0 / 2.0.0                   | Different version axes; not interchangeable.                                                                         |
| API namespaces / methods  | 93 / 945                                | Declared catalog surface, not working-method counts.                                                                 |
| Plugin points             | 298: 292 implemented, six deprecated    | Declarative status, not acceptance across shells.                                                                    |
| Central policy mode       | 17 active namespaces; 76 shadow         | Shadow is intentional rollout. Domain factories can still enforce permission; this is not 76 unprotected namespaces. |
| In-tree manifests         | 81; zero isolated Node-target manifests | Node findings affect the advertised authoring path, not all bundled plugins.                                         |

Existing capabilities include tools/commands, hooks, agents, workflows, views/webviews/A2UI, editor/LSP, storage/Dexie/secrets, network/auth/integrations, sync, services, lifecycle scopes and capability/point metadata. The SDK already has a testing context and abort helper. Missing OAuth, missing lifecycle cleanup, or missing extension metadata would therefore be incorrect blanket diagnoses.

### Initial API issue catalog (adversarial qualification below)

Severity reflects impact under the affected route. Source-level probes establish the stated boundary behavior, with native/provider effects substituted where named.

| ID    | Priority          | Current failure                                                                                | Owning evidence and scope                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API01 | P1                | Revoking `network:fetch` does not block promoted `ctx.agent.invokeTool("web_fetch")`.          | `lib/plugin/core/context.ts:1007-1019,1046-1057`: manifest-only special case bypasses live grants. Actual extracted factory dispatches after revoke while the ordinary guarded network control rejects. The domain allowlist still applies; final Host execution was mocked.                                                                                                                                                                  |
| API02 | P1                | Existing event subscriptions keep receiving future events after `events:subscribe` is revoked. | `lib/plugin/messaging/message-bus.ts:384-392,674-681`; `lib/plugin/api/permission-api.ts:415-428`. Actual bus/event/grant probe receives a new post-revoke event; new subscription control correctly rejects. Full disable teardown does remove subscriptions; this finding is live revocation.                                                                                                                                               |
| API03 | P2                | Remote-desktop provider registration ignores a revoked live grant.                             | `lib/plugin/core/context.ts:489-491`; `lib/plugin/api/remote-desktop-api.ts:37-48`. Production injects static manifest membership; shadow governance does not replace it. Actual factory/registry/wrapper accepts after revoke; false-permission callback control rejects. This does not prove remote-control takeover.                                                                                                                       |
| API04 | P1                | Node binary reads lose type and binary writes can become empty bytes.                          | `lib/plugin/launcher/launchPluginJs.ts:220-236`; `scripts/plugin/node-plugin-host.mjs:45`; `lib/plugin/core/context.ts:1844-1851`. Actual codecs turn `Uint8Array([65,66,255])` into numeric-key object without length; owning write conversion `Array.from` yields `[]`. No real file was truncated.                                                                                                                                         |
| API05 | P1                | Node `ctx.ai.chat` cannot carry its declared async stream.                                     | Same codecs; `scripts/plugin/node-plugin-host.mjs:197`; `packages/plugin-contract/src/types/plugin/plugin.ts:5452`. Actual async generator becomes `{}` with no async iterator. Neither direct iteration nor awaiting the remote value restores it. No provider called.                                                                                                                                                                       |
| API06 | P2                | Node configuration reads stay stale after an awaited update.                                   | `scripts/plugin/node-plugin-host.mjs:138-143` reads activation snapshot; `lib/plugin/api/config-api.ts:69-85` promises live reads. Probe updates Host value to `new`, but child `get/getAll` still return `old`.                                                                                                                                                                                                                              |
| API07 | P2                | Node non-local synchronous getters return callable async handles.                              | `scripts/plugin/node-plugin-host.mjs:196-219`; declared `fs.getTempDir(): string` at canonical `plugin.ts:3268`. Probe returns a function; awaiting produces the expected path. An author following the published synchronous signature gets the wrong type.                                                                                                                                                                                  |
| API08 | P2                | Node capability discovery reports renderer DOM availability inside a DOM-free child.           | `lib/plugin/api/capabilities-api.ts:28`; `lib/plugin/launcher/launchPluginJs.ts:643-649`. Snapshot copies `browser: true`; actual child has `typeof window === "undefined"`. Host platform and local execution capability need separate meanings.                                                                                                                                                                                             |
| API09 | Qualified concern | Compatibility semantics differ from npm-semver; supported grammar needs clarification.         | `packages/plugin-contract/src/lib/plugin/core/compatibility.ts:32-85`: four measured differences and two agreeing controls. Later review found default manager policy is warn, and the helper explicitly supports simple ranges. Unsupported compound ranges alone are not a confirmed defect; see the adversarial disposition below.                                                                                                         |
| API10 | P2                | Simple AI-provider main-chat adapter loses cancellation and rich-message semantics.            | `lib/plugin/api/ai-provider-api.ts:55-95`: incoming `abortSignal` is omitted from callback options, structured content is JSON text, tool-role becomes user-role. Actual extracted adapter probe reproduces all three, while text stream/finish control works. Model projection advertises vision/tools at lines 196-197, beyond this simple contract's representable inputs/outputs. No real-provider billing or stop behavior was measured. |

All API04-API08 findings are restricted to the isolated Node-target frontend subclass selected in `lib/plugin/core/loader.ts:81`. Ordinary frontend plugins run another path. These are important public-path gaps despite zero bundled manifests currently selecting it.

At the initial audit, stale-generation authority was only a component-level risk: a scope/guard probe retained a generation-1 closure and reused generation-2 grants. The follow-up below supplies the actual manager enable-disable-enable counterexample and promotes this to API13; X8's narrow evidence gap is now closed.

### Functional capability gaps and industry comparison

These are recommended capabilities or incomplete guarantees, separate from confirmed defects. Existing platform choices and narrower APIs are not automatically bugs.

| Gap                                                            | What Cognia already provides / what is still missing                                                                                                                                                                                                                                                                                                    | Established reference                                                                                                                                                                                                                                                                                                                                                                   | Smallest useful next increment and acceptance                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP01: Effective capability discovery                          | Public static catalog, compatibility helper, service availability and shell flags exist. Authors cannot ask one method-level question combining executing location, effective grant, provider readiness and reason for unavailability. Node's false DOM flag is a concrete symptom.                                                                     | [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host) distinguish local/web/remote execution and manifest location preference.                                                                                                                                                                                                                    | Extend the existing capability contract with method-level availability/reason and Host-vs-local properties. Derive it from the same policy as invocation, not a second registry. Test a DOM-free child, offline client, missing service and revoked grant.                                                     |
| GAP02: Faithful typed cross-language transport                 | Bidirectional Node callbacks, Python JSON RPC and WASM WIT exist. They do not provide equivalent transport of binary data, async iteration, AbortSignal, callback handles or synchronous returns. Explicit bounded profiles are preferable to nominal parity.                                                                                           | [Extism memory](https://extism.org/docs/concepts/memory/) explicitly defines byte-buffer serialization; [host functions](https://extism.org/docs/concepts/host-functions/) define typed imports/outputs.                                                                                                                                                                                | Define supported wire values plus stream/next/cancel and disposal semantics; refuse unsupported signatures before activation. Preserve bytes exactly, cancel upstream work, keep streams bounded, and demonstrate correct terminal errors. Do not require identical languages' syntax.                         |
| GAP03: Live, scoped authority throughout a resource's lifetime | Permission grants, optional requests, scoped network rules and lifecycle ownership already exist. Alias routes, retained event delivery and generation reuse remain inconsistent.                                                                                                                                                                       | [Chrome permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) separate API and destination permissions with runtime optional grants; [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust) separates workspace trust and limited execution. Neither reference is a promise of arbitrary-JS isolation. | Use the live permission owner at actual execution/delivery, and bind retained handles to the activation generation and relevant realm. After revoke/dispose, reject new work and stop future deliveries; prove the positive control still works while granted.                                                 |
| GAP04: Explicit Host/UI placement and offline behavior         | Today many APIs mix selected-client state, Host data and UI effects. The fresh static matrix finds 32 proven host-side calls to UI/both methods and 29 unclear methods; these are routing obligations, not 61 demonstrated failures.                                                                                                                    | [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host) provides a practical execution-location distinction. Cognia already chose its direction in [ADR-0250 §9](../content/docs/en/adr/0250-the-runtime-is-a-headless-kernel-the-desktop-embeds.md#9-plugins-a-new-contract-in-one-cutover).                                                       | Finish the planned shared module schema and Host/UI cutover. Route UI work to an online owning client; use a named error when none exists. Test headless execution with/without a client and concurrent clients. Avoid inventing another competing API model.                                                  |
| GAP05: Conformance and API evolution for authors               | Generated mirrors, static gates, scoped tests, actual E2E suites and a fake SDK testing context exist. The fake's generic methods mostly resolve undefined; declarations and happy-path unit tests cannot certify runtime semantics. Embedded author types and the research matrix are currently stale.                                                 | [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension), [web-extension tests](https://code.visualstudio.com/api/extension-guides/web-extensions), and [stable/proposed API separation](https://code.visualstudio.com/api/advanced-topics/using-proposed-api).                                                                         | Publish one fixture plugin per runtime using public imports and run the same value/permission/cancellation/lifecycle vectors in the real Host. Test supported Host-version ranges with standard semver. Keep experimental profiles explicit and regenerate the checked author artifacts.                       |
| GAP06: Rich AI-provider contract                               | Agent tools, protocol adapters and richer CodeAdapterChunk already exist; this is not missing AI integration overall. The simple `AIChatMessage.content: string` / text-only `AIChatChunk` seam cannot represent advertised vision and tool-call semantics faithfully. Another provider-definition surface also exists with text-completion-only scope. | [VS Code LM API](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatMessage) exposes typed message parts, tool requests/results and cancellation.                                                                                                                                                                                                                 | Either restrict the simple seam to text-only model capabilities or direct richer providers through the existing richer adapter contract. If expanding it, add typed content parts, tool events and signal propagation with image/tool/stop fixtures. Do not duplicate the existing protocol-adapter framework. |

Recommendations above are inferences from source findings and documented reference designs; no benchmark establishes that adopting all of them improves user outcomes. Stronger isolation for untrusted third-party JavaScript is a separate threat-model decision. Current renderer trust is explicit, so it is not counted as a newly discovered sandbox escape.

### Cross-runtime matrix: useful evidence and limits

Re-running the existing analyzer without writing its research document produced the following current static inventory:

| Runtime view | Current result                                                              | What it does not prove                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript   | 917 statically provided; one explicit refusal; 27 unclear                   | Dynamic module factory expressions explain uncertainty; 27 is not a missing-function count.                                                                                  |
| Python       | 238 statically provided; 31 explicit no; 64 declared-only; 612 not declared | Some declared-only cases contain optional callbacks/signals or unresolved TS backing. A JSON-only subset may work. This is not 64 reproduced failures.                       |
| WASM         | Six exact catalog-operation equivalents                                     | WIT has differently shaped operations, including `ai.generate-text`; this is not a complete count of available WASM functions or a claim that 939 promised calls are broken. |

Examples of signature gaps retained by the analyzer: `agent.runStreamed` returns iterator/cancel callables; `agent.dispatchSubagent` accepts callback hooks and AbortSignal; `a2ui.updateComponents` can carry a column-render callback. Python explicitly rejects host-callback registration (`plugin-sdk/python/src/cognia/ctx.py:61-93,169-174`), and its router intentionally collapses AsyncIterable to collected JSON (`lib/plugin/python/host-request-router.ts:156-181`). Those are documented limits; an API profile should expose them before authors design around the full TypeScript signature.

### Recommended order of work

1. **Repair current authority and cancellation paths.** API01-API03 and API10 first. Add live revoke/delivery/cancellation regressions at the owning façade and include the full-manager generation case. Completion means the normal SDK route rejects or stops at the actual operation boundary, while granted controls work.
2. **Make isolated Node transport truthful.** API04-API08. Preserve supported values and handles; explicitly refuse the rest. Until that passes, keep Node support labeled as a bounded profile. A runtime being process-isolated does not make its API compatible.
3. **Clarify compatibility semantics and repair authoring drift.** API09 needs an explicit supported-range contract before treating every npm-semver difference as a defect; embedded author types and the matrix are stale. The catalog ABI hash in `authoring-kit.json` DOES match when computed with the canonical JSON helper; raw-file hash differences are not a stale-kit finding. Full kit/source freshness was not certified here.
4. **Finish the planned contract cutover and publish conformance profiles.** GAP01-GAP05 should feed ADR-0250's existing migration. GAP06 is a product capability choice: use the existing richer adapter where required, or deliberately limit the simple provider seam.

Do not switch all 76 shadow namespaces to active blindly: existing domain permissions, runtime declarations and compatibility need reconciliation first. Do not add automatic retries to non-idempotent plugin effects as a generic hardening step.

### Fresh verification and reproducibility

Environment: macOS arm64; Node v26.12.1; shared dirty checkout; date 2026-11-17. CodeGraph had no index, so owning-source navigation used rg and file reads. Context7 returned its monthly quota error; current industry claims were verified directly against official web documentation instead.

Commands (from the repository root):

```sh
rtk proxy node scripts/plugin/generate-contract.mjs --check
rtk proxy node scripts/plugin/check-selection-action-parity.mjs
rtk proxy node scripts/plugin/check-author-imports.mjs
rtk proxy node scripts/plugin/check-sdk-standalone.mjs
rtk proxy node scripts/gates/check-plugin-sdk-wit.mjs
rtk proxy node scripts/gates/convergence/plugin-api-matrix.mjs --check
rtk proxy env pnpm_config_verify_deps_before_run=false node scripts/plugin/generate-author-types.mjs --check
rtk proxy env pnpm_config_verify_deps_before_run=false pnpm test --runInBand --runTestsByPath lib/plugin/contracts/governed-context.test.ts lib/plugin/api/capabilities-api.test.ts packages/plugin-contract/src/lib/plugin/core/compatibility.test.ts lib/plugin/core/disposable-scope.test.ts
rtk proxy env pnpm_config_verify_deps_before_run=false pnpm test --runInBand --runTestsByPath lib/plugin/api/ai-provider-api.test.ts
rtk proxy node --test scripts/plugin/node-plugin-host.test.mjs
rtk proxy node .cache/plugin-api-audit/runtime-review-probes.mjs
rtk proxy node .cache/plugin-api-audit/authority-review-probe.cjs
rtk proxy node .cache/plugin-api-audit/compatibility.probe.cjs
rtk proxy node .cache/plugin-api-audit/ai-provider.probe.cjs
```

- Passed: contract/selection parity, 81-plugin public-import check, standalone baseline (five existing Host references; none new), four WIT mirrors, five focused Jest suites / 84 tests and Node baseline / 16 tests.
- Diagnostic probes exit 0 when the specified defects reproduce; this is passing diagnosis, not fixed product acceptance. They use actual source/codecs with bounded dependency substitutions and no real network/provider/file effects. Runtime probe logs retain source hashes. Other probe source files retain the exact extraction and controls.
- Failed: `plugin-api-matrix --check` reports `Stale: docs/research/plugin-api-matrix-2026-11-01.md`. The current analyzer can generate successfully; this is a stale research note, not the earlier unclassified-sync failure.
- Failed: author-types freshness reports nine changed declaration entries and two added ones. Source regeneration is needed; no bundle was overwritten by this audit.
- Initial pnpm invocations automatically entered dependency verification/install and failed in sidecar linked-package postinstall before executing the intended checks. Refreshed checks above disabled that automatic step or invoked the exact package-script commands directly. The initial failure is not counted as an API gate result.
- Earlier Node callback-state/callback-RPC and duplicate Python load findings have current repairs and are not repeated as current failures. WASM v0.1 refusal and absent-backend `HOST_UNAVAILABLE` are explicit boundaries, not new defects.
- Not run: full lint/typecheck/build, coverage, actual install/update/restore, packaged Tauri/device smoke, a real external provider, or cross-model CLI. No production behavior was changed or committed. The analysis outcome M3 is met; the ledger stays verifying with repairs and real-environment obligations open.

Sources consulted on 2026-11-17: the claim-specific official platform links in the comparison table, plus [npm/node-semver range semantics](https://github.com/npm/node-semver#caret-ranges-123-025-004) for API09. Local source and probe evidence establish Cognia findings; external references support the comparison only.

## API adversarial review: 2026-11-17

### Contract, challenged claim and disposition

Request: “做一次对抗性审查”. Applied `doubt-driven` with three fresh-context bounded reviews: live authority/lifecycle, resident Node transport, and AI-provider/compatibility. A new foreign-registry mutation probe received one additional bounded independent review. Reviewers received source, probes and API constraints without the audit's prioritization rationale. No product repairs were requested or made.

Claim challenged: the initial ten API issue groups are all established current defects and can guide repairs. Why it matters: an unreachable helper, an omitted production guard or a mock-induced failure could send implementation toward the wrong fix. The falsifiers were an actual owner/generation fence, real transport preserving the value, documented narrower semantics, or downstream enforcement preventing the alleged operation.

The result changes the initial report:

- **Nine original defects retained:** API01-API08 and API10. Evidence was strengthened with actual published contexts, real Node subprocess traffic and actual provider registration/renderer IPC.
- **One item qualified:** API09 remains a compatibility-semantic concern, not a blanket confirmed install-blocking defect.
- **Seven new defects plus one previously unconfirmed lifecycle risk:** API11-API18 below. The resulting catalog has **17 confirmed behavioral issue groups within the stated probe scopes, plus one qualified compatibility concern**.
- The user explicitly chose “跳过，完成本轮结果” when offered cross-model escalation under `doubt-driven`. No external model CLI was invoked.

### New findings and promoted lifecycle defect

| ID    | Priority | Finding                                                                                              | Actual source, reproduction and limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | -------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API11 | P1       | One plugin's custom AI provider silently captures another plugin's chat/embedding calls.             | `lib/plugin/api/ai-provider-api.ts:261-265,275-277` searches the global provider map by bare model id or first embed callback. `registerProvider` is intentionally ungated at lines 302-303. Actual factory, permissions and registries show an ungranted plugin registering model `gpt-4o` receives another granted plugin's safe prompt, session id and embedding texts; the caller never selected the namespaced custom provider. Direct no-grant calls reject, and pre-registration controls reach the Host. With ambient runtime disabled, the matched calls also bypass the real missing-session runtime refusal. No real data or network used. |
| API12 | P1       | One plugin can remove another's registered guardrail or context provider through normal SDK methods. | `lib/plugin/core/context.ts:1162-1163,1235-1236` passes only the supplied id to global deletion. `packages/plugin-contract/src/lib/plugin/registries/createOverlayRegistry.ts:267-271` has no caller-owner check. Actual SDK factory, governed wrapper and registries allow a zero-grant caller to delete the owner's entries. A guard that tripped before deletion is silently absent from the next actual `runInputGuardrails` resolution (`guardrails.ts:34-44`); this is not cancellation of an already running guard object. Context-provider impact is removal, not reading another plugin's context.                                           |
| API13 | P1       | A disposed activation's context regains write authority after the same plugin is enabled again.      | `lib/plugin/core/disposable-scope.ts:367-371` invokes the target without a generation/aborted fence; `permission-guard.ts:660-669` reads current grants by plugin id. Actual manager, loader, published context and stores: enable generation 1, disable, enable generation 2; old signal stays aborted yet old `theme.setMode("dark")` changes the actual test settings. The same old call correctly fails while disabled, and the new context signal is live. Synthetic builtin frontend plugin, fake IndexedDB and native-edge mocks; no native/cross-account proof.                                                                               |
| API14 | P1       | Normal Node disable kills the child before its `lifecycle.onDispose` callbacks run.                  | Manager calls runtime deactivation at `manager.ts:4948` before contribution/scope teardown at 4957-4958 and 7171. Definition deactivation reaches child stop via `loader.ts:371-377` and `launchPluginJs.ts:712`. Actual live child plus actual scope, composed in this source-confirmed order, yields no cleanup write, `Node plugin stopped`, and an unresolved disposer. Suspend's opposite order (`manager.ts:5473-5474`) is the control: it writes `cleaned=true`, has zero failures and clears the scope. This test composes actual components and manager ordering; it is not a complete Node-manager/native-relay run.                        |
| API15 | P2       | Node `lifecycle.signal.aborted` is a truthy proxy function even before cancellation.                 | Contract `plugin.ts:2666-2671`; actual Host signal `context.ts:464`. Launcher snapshot at `launchPluginJs.ts:643-662` omits lifecycle, and missing property reads synthesize a function proxy at `node-plugin-host.mjs:195-203`. Actual subprocess reads `abortedType=function`, `abortedTruthy=true`, `isSignal=false` while Host aborted is false. A standard early-abort guard can wrongly skip work. This does not establish that every abort-listener path fails.                                                                                                                                                                                |
| API16 | P2       | Node callback arguments silently erase `AbortSignal`.                                                | `node-plugin-host.mjs:41-48` encodes only enumerable properties; `launchPluginJs.ts:513-516` revives ordinary JSON. A real child passes its controller signal to `ctx.ai.embed`; actual Host receives `{}`, not a signal. Contract `plugin.ts:5391-5393` explicitly accepts cancellation. No actual provider cancellation/billing was measured.                                                                                                                                                                                                                                                                                                       |
| API17 | P2       | Node error transport erases structured failure information.                                          | Host reply at `launchPluginJs.ts:547` carries only message; child at `node-plugin-host.mjs:231` creates a generic Error. A real child observes `Error("denied")` for a Host TypeError carrying `code=PERMISSION_DENIED` and `cause=revoked`. The reverse direction similarly loses structure at child lines 359-361 / launcher 568. The observation is lost name/code/cause, not a requirement that Error instance identity survive processes.                                                                                                                                                                                                        |
| API18 | P2       | An old AI-provider registration disposer deletes its newer same-id replacement.                      | `ai-provider-api.ts:153` replaces the custom map entry; disposer at lines 215-221 deletes map/catalog/protocol/executor by id without registration identity. Actual register old, register new, dispose old removes the new provider and executor. Scope is same-owner duplicate registration, not a proven manager-generation race.                                                                                                                                                                                                                                                                                                                  |

API04-API08 and API14-API17 affect the isolated Node-target profile; the in-tree inventory still has zero manifests selecting it. They do not establish failure of every frontend plugin. API11-API13 and API18 do not require that Node profile.

### Stronger evidence and corrected earlier claims

| Item                                             | Reconciled disposition                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API01 network revocation                         | Retained at Host-dispatch scope. The renderer runtime at `lib/plugin/runtime/renderer-host-runtime.ts:220-245` delegates to the generic Host tool path without a second plugin-grant check, so that downstream code does not refute the finding. Real network execution remains untested.                                                                                                                                                                  |
| API02 event revocation                           | Retained through actual published context and real bus/grant store. New registration rejects after revoke while the existing subscriber receives a new ID-only event. Earlier synthetic `secret` payload does not demonstrate real privacy leakage: bus documentation (`message-bus.ts:631-633`) asks system events to carry IDs only.                                                                                                                     |
| API03 provider revocation                        | Retained through actual manager-created context: permission query is false while actual provider registry insertion succeeds. Registration alone is not proof of remote-control takeover.                                                                                                                                                                                                                                                                  |
| API04-API08 Node values/config/getters/discovery | All five survive production launcher and resident-host communication with a real child process. Working ordinary values and nested callbacks rule out a generally broken test transport.                                                                                                                                                                                                                                                                   |
| API09 compatibility                              | The evaluator is reachable from install/load/enable, but `manager.ts:1068` defaults to `warn`; only explicit `block` mode rejects at lines 2577-2583. The helper is named `satisfiesSimpleRange`, and no full npm-semver grammar promise was established. Keep measured caret-zero/prerelease differences and request a clear supported grammar; do not count unsupported compound syntax alone as a defect or claim default installation blocking.        |
| API10 provider cancellation/rich messages        | Strengthened from extracted helper to actual registerProvider, actual executor registry and actual renderer IPC. IPC passes a real AbortSignal at `protocol-adapter-ipc.ts:108`, but the simple adapter omits it. Cancelled generator stays pending until explicit test release and then executes its post-stop work; IPC correctly suppresses late writes. Image parts are text and tool role becomes user. Real provider stop/charges remain unmeasured. |

### Rejected candidates and scope corrections

- **No main-chat PII bypass claimed.** The real renderer IPC deep PII gate rejects nested email content before the provider callback. API11 uses safe synthetic text; it proves wrong-owner routing despite permission gates, not bypass of PII recognition.
- **No delayed-disposer leak in the tested timeout case.** After a slow registration times out, stopping the live runtime still invokes its disposer exactly once. That case is excluded. API14 is a different ordering failure involving child-owned onDispose callbacks after child death.
- **No registration-overwrite claim for the overlay registry.** Its first-wins-cross-plugin check protects registration collisions. API12 is owner-unaware deletion; reserving an owner's key does not prevent deletion.
- **No separate bug assigned to unknown guardrail ids being skipped.** The existing canonical test deliberately pins that behavior. API12's defect is another plugin being able to make an existing, selected guardrail disappear before the next resolution.
- **No cross-plugin context read claimed by API12.** `resolveContextContributions` filters by owner; foreign removal is the demonstrated failure.
- **No broad network-rule bypass added.** Promoted Host tools currently document a domain-only clamp in their owning code; method/path parity with `ctx.network` needs a contract decision. It is not silently added to the confirmed catalog merely because the generic request-rule evaluator is stricter.
- Static Python/WASM inventories, shadow namespace counts and source-only Host/UI routing candidates remain scoped as in the initial comparison. None became runtime-failure counts during this review.

### Revised repair priority

1. Fix **cross-plugin owner selection/deletion** (API11-API12), **activation fencing** (API13), and retained live revocation (API01-API03). Provider resolution must respect calling owner or an explicitly selected authorized provider; deletion must check the registration owner. A disposed context must not acquire a newer activation's grants.
2. Fix **teardown and cancellation** (API14-API16, API10). Node cleanup callbacks need a live child while they run; transport must represent signal state and cancellation, or refuse unsupported use explicitly. Retain IPC's existing late-write suppression and PII checks.
3. Fix **value/error/registration identity** (API04-API08, API17-API18), then carry reproductions into owning tests and real runtime fixtures.
4. Clarify **compatibility grammar and warn/block policy** (API09) and repair the previously measured authoring drift. Do not substitute a standard-range parser without deciding the supported contract and testing policy call sites.

### Reproduction, controls and remaining limits

```sh
rtk proxy node .cache/plugin-api-audit/adversarial-transport-live.mjs
rtk proxy node .cache/plugin-api-audit/adversarial-ai-provider.probe.cjs
rtk proxy node .cache/plugin-api-audit/adversarial-registry.probe.cjs
rtk proxy env pnpm_config_verify_deps_before_run=false pnpm test --config .cache/plugin-api-audit/adversarial-authority.jest.config.ts --runInBand --no-coverage
rtk proxy env pnpm_config_verify_deps_before_run=false pnpm test --runInBand --runTestsByPath packages/plugin-contract/src/lib/plugin/registries/guardrail-registry.test.ts lib/plugin/registries/context-provider-registry.test.ts packages/plugin-contract/src/lib/plugin/agent-sdk/guardrails.test.ts
```

- Primary reviewer replayed all three new scripts successfully, inspected their extraction/mocking boundaries and checked the actual owner source. Scripts exit 0 when their defect assertions reproduce; no repair acceptance is implied.
- Actual manager diagnostic: **1 suite / 1 test passed**, primary replay 5.753 seconds. It uses actual manager/loader/context/governance/callback wrappers/permissions and test stores; only native/Tauri edges and the imported plugin module are substituted. The latter uses the real loader's configured importer, not a mocked loader.
- Existing guardrail/context-provider baseline: **3 suites / 16 tests passed**. Missing ownership and stale-generation counterexamples are not covered by those green tests.
- Main replay logs: `.cache/plugin-api-audit/adversarial-transport-main-confirmation.log`, `adversarial-ai-main-confirmation.log`, `adversarial-authority-main-confirmation.log`, `adversarial-registry.probe.log`. Independent review logs/scripts share the `adversarial-` prefix. The live Node log records source SHA256 values and Node v26.12.1.
- Native command relay is a JSON-preserving in-memory edge to the real child. Rust relay, runtime installation, native permission provisioning and sandbox isolation were not exercised. The Node teardown discriminator uses actual scope/child and source-confirmed manager order, not full native manager execution.
- No real external model, user data, remote account or actual Tauri/Capacitor session was used. No full lint/typecheck/build/coverage was run for this evidence-only follow-up. Source changes remain unrepaired under X7; the requested adversarial analysis outcome M4 is met.

## Plugin preparation, versions, installation and updates: 2026-11-17

### Scope and finding model

Request: “同理帮我分析一下现在的插件更新、版本管理之类的，以及不同环境的插件准备、安装、更新之类的”. This follows the same evidence-first approach: current owners, an environment matrix, failure controls and an industry comparison. It does not install/update real plugins or implement repairs.

The central problem is inconsistent lifecycle ownership. Cognia packages on desktop have a staged transaction; VSIX, local-directory UI, bundled seeding and standalone CLI still have different mutation/identity boundaries. A version string alone does not describe which bytes are installed, which runtime is executing them, which environment is prepared or which data schema remains after recovery.

Evidence levels used below: **B** = actual production function/class/module with controlled external edges; **C** = production component/control-flow composition, without full manager/native acceptance; **S** = owning-source chain, with partial component checks where stated. These are not claims about production incident frequency or complete platform certification.

### Current environment matrix

| Environment                     | Preparation and executable ownership                                                                                                                                                               | Install/update behavior and limits                                                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main-app dev / static web build | `predev/prebuild`, `stage-plugin-artifacts.mjs` and `with-plugin-artifacts.mjs` validate an artifact set/authoring ABI and lease it while compiling. Current curation selects 60 browser builtins. | Builtin frontend resources ship with the app. Browser cannot create local Python/WASM/Node guest processes; standalone package-install dialogs generally require actual Tauri invoke. Updating builtin web code is an app/artifact deployment, not a local package update.                             |
| Tauri desktop                   | Same frontend artifacts plus curated disk payloads and a prepared plugin Node binary. Current disk curation declares RepoWiki and Laya Guard; runtime prerequisites are separate.                  | Cognia registry/HTTP/Git/WASM manager paths generally stage, review, stop, commit, scan/activate and finalize. Legacy local-directory UI, VSIX and bundled seeding do not all carry the same identity/transaction contract. Python depends on a host interpreter and explicitly prepared dependencies. |
| Capacitor mobile                | `prepare-mobile.mjs` stages `--web-only`; the build wrapper selects web sections for `NEXT_PUBLIC_PLATFORM=mobile`.                                                                                | Runs compatible frontend contributions. Plugin metadata/toggles may mirror a paired Host; that does not imply local guest installation or a complete remote package-management UI. Backup mutations and GitHub/VSIX install affordances remain desktop-gated.                                          |
| Paired browser/mobile           | The Host owns executable packages and native processes; the client owns its local UI/static assets and mirrored projection.                                                                        | Native RPC has plugin install/backup operations, but UI predicates such as `canUseTauriInvoke()` and `isTauri()` still gate several flows. Treat local and Host package versions/readiness separately; queued enable intent is not proof of completed Host installation.                               |
| Standalone CLI                  | Builds/copies builtin frontend chunks under an artifact lease; runtime bootstraps the canonical PluginManager in browser profile with Node-compatible frontend importer.                           | `/plugin install/update` uses the CLI GitHub installer and separate source/fingerprint files. User installation accepts frontend only; Python is disabled in this profile. Its live-directory writes/reload path differs from the desktop package transaction.                                         |
| Supervised headless brain       | `plugin-runtime.ts:265-289` selects headless profile and binds native invoke/subscription transport; `serve/plugin-runtime-adapter.ts:104-139` registers native disk plugin types.                 | Python/WASM/hybrid/VSCode activation depends on real native service hosts and prepared packages; it is not the standalone CLI's frontend-only promise. Native mutation reconciliation is present, but full install/update/recovery acceptance was not run.                                             |
| Plugin authoring / extraction   | Portable authoring kit binds SDK/UI/contract/compiler/style/WIT fingerprints and inventories its files. Host currently still treats local `plugins/` as source of truth.                           | Product adoption of a separately released pinned `cognia-plugins` artifact is explicitly deferred to P3/P4 of the extraction plan. Missing that product pin is future capability work, not proof that the present local-source build violates its accepted plan.                                       |

Current source inventory is 76 frontend, four Python and one WASM manifest. These 81 source entries, 60 selected browser builtins, curated desktop payloads and actually enabled plugins are different sets.

### Version identities that must remain distinct

| Identity                    | Current owner / purpose                                                                                                     | Required relationship                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Plugin release version      | `manifest.version` and registry release metadata                                                                            | Semver selection/channel policy; not a content digest.                                                 |
| Host compatibility          | `engines.cognia`, `minAppVersion`, optional node/python requirements                                                        | Depends on actual selected runtime and warn/block policy. Prior API09's grammar caveat still applies.  |
| SDK / contract / wire       | Current SDK 0.3.0, contract 1.7.0, protocol 2.0.0                                                                           | Separate compatibility axes; one passing version does not establish the others.                        |
| Authoring/artifact ABI      | SDK source, styles, compiler, shared modules, WIT, profile and lockfile hashes                                              | Prepared resources must match the consuming Host; current ABI guard correctly refuses drift.           |
| Source and package identity | Full Git commit, archive digest, file inventory, registry/Open VSX origin                                                   | Reviewed identity must survive staging/promotion and provenance must describe the bytes now installed. |
| Environment readiness       | Node version plus target architecture; Python interpreter plus venv and dependencies; optional Node packageManager/lockfile | Package installation and executable/dependency readiness are separate states.                          |
| Data/activation state       | Plugin Dexie migration version, config, lifecycle generation, desired/actual state                                          | A restored package does not imply restored data or restored activation intent.                         |

### Current issue catalog

| ID   | Priority | Problem                                                                                        | Owning evidence, demonstrated scope and consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PL01 | P1       | WASM Git source can carry a repository-authored verification receipt into signature admission. | **S + component checks.** `wasm/installer.rs:990-1009` copies the tree without removing `.cognia-verification.json`; its actual copy helper preserves the file. `marketplace.rs:533-539` reads it as receipt JSON; real `signature.ts:194-197` accepts `verifiedVia=signature` under requireSignatures. Manager admission calls that verifier at `manager.ts:3337,5738-5755` and later `4208-4214`; native WASM load has no independent signature check. Ordinary GitHub/ZIP paths strip source receipts. No native end-to-end unsigned install was executed. |
| PL02 | P1       | Local-directory UI approval is not bound to the installed identity/bytes.                      | **B + native source.** `local/local-directory-client.ts:47-67` drops expected id/digest; the UI still uses this legacy client. Native directory calls pass expected_plugin_id=None (`src-tauri/src/cli_bridge/handlers.rs:1566-1567,1680-1681`). Actual `runMarketplaceInstall` + client accepts a receipt for a different plugin but reports the reviewed id as installed. Same-id and permission-cancel controls pass. This does not prove untrusted frontend execution.                                                                                    |
| PL03 | P1       | VSIX commit accepts bytes/version different from the reviewed package.                         | **B + native source.** `vscode-shim/install-vscode-extension.ts:138-156` passes only tempPath for staged files and checks only extension id. Native `vscode/commands.rs:293-304` downgrades the receipt on changed digest but still installs. Probe returns same-id v2/different SHA, and TS persists the reviewed v1 manifest. Matching-response/browser-refusal controls pass.                                                                                                                                                                              |
| PL04 | P1       | VSIX immediate replacement is not atomic with persistence/runtime state.                       | **B + native source.** Native installer removes/replaces old disk package (`vscode/installer.rs:296-307`) before TS `upsertPlugin` at `install-vscode-extension.ts:158-176`; there is no compensating command if persistence fails. Probe sees native promotion followed by injected DB failure, with only one install command. Existing runtime is not quiesced by this commit helper.                                                                                                                                                                       |
| PL05 | P2       | Fresh VSIX installation does not explicitly reconcile the canonical runtime inventory.         | **S.** Commit writes Dexie but does not register/scan the PluginManager store. The UI can see the Dexie row while manager enable requires its own entry (`manager.ts:4571-4574`). Full UI/native observer acceptance was not executed, so this remains a source-chain finding requiring a composed regression.                                                                                                                                                                                                                                                |
| PL06 | P1       | Update selection ignores install source and Git commit origin.                                 | **B.** `updater.ts:181-190` drops source/origin; `275-307` sends all non-VSCode plugin ids to the default Cognia registry. git/local/dev/builtin fixtures receive registry candidates. An explicit autoInstall fixture for a git plugin stages/commits that registry release. Shipped `policy-runtime.ts:82-89` is notify-only (`autoInstall:false`); do not claim silent automatic replacement is enabled by default. The check/manual-update source confusion is current.                                                                                   |
| PL07 | P2       | Successful update changes activation intent/state.                                             | **B.** `updater.ts:595,655-657` groups loaded/loading/suspended with active and restores all through enable. Probes reproduce loaded→enabled and suspended→enabled; installed/disabled/enabled controls retain their expected states. Shared staged installation also has suspended→enabled logic (`manager.ts:3847,3884`).                                                                                                                                                                                                                                   |
| PL08 | P2       | Failure before package commit can leave the old plugin unloaded.                               | **B.** Updater disables/unloads first, then persists recovery ownership (`updater.ts:598,630`). Injected `beginUpdateRecovery` storage failure leaves disk v1 intact but previously enabled runtime installed/unloaded, returns failure with requiresRestart=false and does not restore activation. Download-failure control preserves enabled state.                                                                                                                                                                                                         |
| PL09 | P1       | Explicit rollback does not compensate for later failure.                                       | **B.** `rollback.ts:324,369,382,430` tears down before download/restore and does not restore its safety snapshot on catch. Download failure leaves old runtime unloaded; a throwing down-migration after successful target installation leaves disk/inventory at the target version and runtime stopped. Result is success=false/requiresRestart=false. No claim of silent corruption or unrecoverable loss is made.                                                                                                                                          |
| PL10 | P2       | Direct updater success leaves install-origin metadata stale.                                   | **S.** Updater does not call `recordInstallOrigin`; normal marketplace install does (`package/marketplace.ts:929`). Origin version can then disagree with inventory. `cogpack/export.ts:114` treats a mismatching record as non-reproducible and falls back to embedding, losing the expected reference/pin. No real export was run.                                                                                                                                                                                                                          |
| PL11 | P1       | Cross-target Tauri packaging prepares the runner's Node architecture.                          | **B + CI source.** `prepare-plugin-node.mjs:48-82` selects process.platform/arch and ignores target env. On darwin-arm64 with an x86_64 Apple target, an intercepted fetch requests the ARM archive. Tauri bundles the shared result; CI builds both Apple targets on the same runner label without selecting Node architecture. No download/package execution was performed.                                                                                                                                                                                 |
| PL12 | P2       | Bundled seeding drops catalog integrity and native receipt identity.                           | **B + native source.** `seed-bundled-plugins.ts:221-228` invokes directory install with only sourceDir, discarding generated file sizes/hashes and ignoring returned plugin_id. Actual production wiring given a different native id still records expected-plugin builtin provenance and a successful seed marker. Native path has no expected id/hash binding. No shipped bundle was modified.                                                                                                                                                              |
| PL13 | P1       | CLI GitHub install/update writes directly into the live directory.                             | **B.** `cli/src/plugin/install.ts:116-145` downloads/writes files without staged replacement or stale-file removal. Injected second-file write failure leaves v2 manifest with v1 code; successful replacement leaves obsolete files, and returned fingerprint covers only this download rather than the full installed tree. Synthetic filesystem/network only.                                                                                                                                                                                              |
| PL14 | P1       | CLI approval loses the preview commit between phases.                                          | **B + source.** `plugin-controller.ts:459,474` discards preview's pinned ref and puts the original mutable ref in the confirmation command. Confirmed install previews again (`install.ts:104`). Probe approves v1 then installs a v2 result through the same @main command. Each individual preview is already pinned; the defect is between the two previews, not file-by-file mutable downloads. Frontend trust remains a later gate.                                                                                                                      |
| PL15 | P2       | CLI update ignores changed upstream plugin id.                                                 | **B.** `plugin-controller.ts:687-699` does not compare next.id with requested id. Probe downloads different.plugin, reloads/records demo and reports success. The actual installer uses new manifest.id for its directory. This proves wrong attribution, not execution of the different plugin.                                                                                                                                                                                                                                                              |
| PL16 | P2       | CLI update continues after request cancellation.                                               | **B.** The initial signal check is not repeated after refetch; reload, origin write and success notice still execute after abort. Pre-cancel control performs no work. No real download or installed package was affected.                                                                                                                                                                                                                                                                                                                                    |
| PL17 | P2       | CLI update check advertises downgrades as upgrades.                                            | **B.** `plugin-controller.ts:734` uses string inequality. Installed 2.0.0 / upstream 1.0.0 is reported as an available update. No version precedence/channel decision is applied by this check.                                                                                                                                                                                                                                                                                                                                                               |
| PL18 | P2       | CLI reload/update does not preserve disabled runtime state.                                    | **C.** Actual `cli/src/plugin/host.ts:105-110` always calls disable/unload/load/enable, and update calls it without restoring intent. A manager-effect fixture ends disabled→enabled. The disabled file is not deleted; bootstrap reapplies it, but `ensurePluginRuntime` caches bootstrap, so the next turn is not a proven correction. Real manager frontend trust can still refuse loading.                                                                                                                                                                |
| PL19 | P2       | Open VSX staging can orphan a downloaded temporary file.                                       | **B.** `openvsx-install-flow.ts:196` reads bytes before adding the downloaded path to the cleanup-owned staged list at 228. Injected read failure after download leaves no cleanup call; cleanup at 244 only knows earlier entries. No actual disk file was created.                                                                                                                                                                                                                                                                                          |

PL01, PL05 and PL10 rely principally on owning-source chains; the other findings have controlled production-function/component counterexamples. Component probes do not imply real native registry, package activation or cross-platform rename acceptance.

### Preparation and recovery capability gaps

1. **Dependency-ready is not package-installed.** Python load selects a host interpreter and checks import availability (`python/host.py:515-529,573-581`); it does not run pip/uv. The user-confirmed dependency action reaches `manager.installPythonDeps` and `python/commands.rs:1457-1495`. Missing dependencies should remain a distinct actionable state in installation/update acceptance.
2. **Python environments are not fully reproducible/offline bundles.** Default shared environments can fall back to isolated after a dry-run conflict; user/manifest may choose isolated. Installer forwards manifest specs to pip/uv, not a resolved plugin lockfile/offline dependency inventory. Completed venv reuse tracks interpreter version/installer, not a fully locked resolved graph. Import checks do not establish all version/extras/marker constraints. Node optional environments already use a pinned pnpm version and `--frozen-lockfile`; do not describe both as equally unlocked.
3. **Actual selected interpreter needs its own readiness evidence.** Discovery accepts the host baseline; declared engines.python has a separate compatibility check. A per-plugin interpreter override is trusted as custom, so global discovery/version success does not prove that selected override satisfies the plugin's requirements. No interpreter provisioning was run.
4. **Package rollback is not full data rollback.** Native snapshots cover package/host-state/VSCode filesystem trees (`backup.rs:55-106`), not plugin Dexie tables. Existing real Dexie regression (`updater.test.ts:1088-1134`) migrates v2, fails activation and restores v1 package, but retains v2 data; the correct guard raises PluginDataVersionError and requires upgrade or data cleanup. This is a surfaced recovery limitation, not silent corruption.
5. **Cached Node verification is only a version smoke check.** `prepare-plugin-node.mjs:63-76` accepts an executable that prints the pinned --version, including the cache-fixture shell script. Fresh archive downloads do verify SHA-256. Cached bytes/architecture are not revalidated, so --check success must not be presented as complete integrity/target verification or as a newly proven remote-code-execution issue.
6. **Source/release adoption remains a planned distribution capability.** The artifact verifier accepts syntactically valid but unrelated source/toolchain metadata if bytes and ABI fit. A product pin binding repository/commit/archive/kit/profile was planned but explicitly deferred while Host local plugins remain authoritative. Treat future release provenance/revocation/expiry requirements as a design increment, not a current local-source regression.
7. **The per-environment acceptance contract is incomplete.** Desktop package transactions, CLI directory writes, VSIX commit, paired UI gates and headless reconciliation need common identity, cancellation, intent and recovery vectors. Remote Host support should expose its owner/readiness; a browser/native capability declaration alone does not make install/update UI operational.

### Historical findings that must not be repeated as current

- WASM Git now uses the manager's staged install path and respects permission-review cancellation; historical B15/B16's immediate-commit/inventory description is superseded. PL01 is a separate trust-evidence issue inside the now-staged path.
- Historical B17's backup/native-journal finalize mismatch has been repaired. Recovery markers and native journal discard before backup restore are present.
- Backup panel now calls `PluginRollbackManager.restoreBackup`, checks unsuccessful restore/delete results, and displays errors/restart needs. Historical B18/B19 UI claims are superseded.
- Prerelease-to-stable comparison, prerelease filtering and inclusion of suspended plugins in update discovery have current repairs/tests (B20-B22). PL07 concerns post-update state restoration, not discovery omission.
- Shipped auto-update policy schedules notifications, not automatic installation. Cogset pins are consulted for automatic updates. PL06 is loss of ordinary install origin/source routing, not proof that the Cogset pin mechanism is absent.
- Desktop-only VSIX install and browser/mobile local guest restrictions are intentional boundaries. They can be product capability gaps, but are not counted as runtime defects merely for being unavailable.

### Comparison with established distribution practice

| Practice                                                 | Current useful foundation                                                                       | Next concrete obligation                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Explicit release channels and platform-targeted packages | Cognia/Open VSX update selection has prerelease policy; manifests declare runtime availability. | Bind target platform and actual executable architecture through preparation/packaging; make source/channel/held-version visible. [VS Code publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) documents separate pre-release policy and target-specific packages, rather than implying one version grammar fits every ecosystem. |
| Immutable reviewed artifact and publisher identity       | Archive checksums/signature receipts, staged manager installs and pinned Git previews exist.    | Ensure receipts originate from the Host, bind them to reviewed bytes and publisher, and preserve that binding across every adapter. [PyPI attestations](https://docs.pypi.org/attestations/) bind release distributions' digests to publishing identities.                                                                                                               |
| Authenticated and fresh update metadata                  | Local artifact ABI and file inventories already fail closed on mismatch.                        | For external release adoption, define trusted signing roles, freshness/expiry and consistent release metadata; do not trust a package's self-authored receipt. [TUF roles and metadata](https://theupdateframework.io/docs/metadata/) documents these independent protections. Full TUF adoption is not prescribed by this audit.                                        |
| Reproducible dependency preparation                      | Optional Node runtime already pins pnpm and uses frozen lockfile.                               | Apply similarly explicit resolved dependency/target identity to Python where reproducibility is promised; document cache/network requirements. [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/) illustrates refusing lockfile mismatch instead of silently rewriting the dependency contract.                                                                   |

These comparisons are design recommendations inferred from local findings and primary documentation; they are not measurements of user outcomes or claims that every reference platform guarantees full data rollback.

### Current preparation state, verification and next work

The primary reviewer refreshed authoring identity: **styleContractSha256, sdkSourceSha256 and lockfileSha256 differ from the pin**. The identity guard refuses the current shared checkout. Existing cached artifact bytes (1,744 files) can validate against their own older tuple; that does not prove compatibility with the current Host. Do not repair this by bypassing the guard or relabeling a warm cache as a fresh build.

- Existing focused Jest: **15 unique suites / 393 tests passed** across update/backup/rollback, install adapters, CLI controllers/host/installer and update/backup UI.
- Cache-only installation diagnostics: **4 suites / 11 assertions passed**; assertions intentionally reproduce findings and include matching/absent-receipt/cancel/browser controls. The receipt test uses the actual verifier with a controlled native receipt result; copied receipt preservation was separately checked with the actual extracted Rust copy helper and the full admission source chain.
- Existing artifact Node checks: **48 passed, one test-file startup failed**. `produce.test.mjs` calls the real ABI identity guard at module initialization; this failure is a current integration/preparation blocker, not an assertion that the audit changed product behavior.
- Production updater/rollback probe exercised 15 scenarios; CLI probe exercised six defect groups plus a pre-cancel control. Primary reviewer replayed those, the install diagnostics and the preparation/seeder probes, inspected their dependency substitutions and reconciled scope with the actual call paths.
- `prepare-plugin-node.mjs --check` exits 0 on the workstation; its version-only limitation is documented above. Cross-target fixture intercepted the requested URL without downloading. Filesystem and native package effects in install/update probes were synthetic.
- Evidence directory: `.cache/plugin-lifecycle-audit/`. Main logs include `root-existing-tests.log`, `update-existing-tests.log`, `install-existing-tests.log`, `prepare-existing-tests.log`, `install-main-replay.log`, `update-main-replay.log`, `cli-probes.log`, `prepare-main-replay.log`, `prepare-seeder-main.log`, `final-freshness.json`. `source-snapshot.json` records owning-source hashes.
- Diagnostic commands from repository cwd:

```sh
rtk proxy node .cache/plugin-lifecycle-audit/cli-probes.cjs
rtk proxy node .cache/plugin-lifecycle-audit/update-probe.cjs
rtk proxy node .cache/plugin-lifecycle-audit/prepare-probes.mjs
rtk proxy node .cache/plugin-lifecycle-audit/prepare-seeder-probe.mjs
rtk proxy env pnpm_config_verify_deps_before_run=false pnpm test --config .cache/plugin-lifecycle-audit/install-jest.config.json --runInBand --runTestsByPath .cache/plugin-lifecycle-audit/install-vsix.audit.test.ts .cache/plugin-lifecycle-audit/install-directory.audit.test.ts .cache/plugin-lifecycle-audit/install-receipt.audit.test.ts .cache/plugin-lifecycle-audit/install-openvsx-cleanup.audit.test.ts
```

Recommended order: **(1)** Host-issued trust evidence and reviewed identity/digest, **(2)** atomic disk/inventory/runtime/provenance transitions across the legacy paths, **(3)** rollback failure compensation and migration-aware recovery, **(4)** target-correct preparation and explicit dependency readiness, **(5)** source/channel/pin policy and a clean per-environment upgrade fixture matrix.

No real registry download, dependency installation, actual plugin mutation, full build, packaged Tauri/Capacitor session or cross-platform upgrade pair was executed. No product code or generated artifact was changed by this audit. M5's analysis outcome is met; lifecycle repairs, current ABI drift and real-environment obligations remain open in X10-X11.
