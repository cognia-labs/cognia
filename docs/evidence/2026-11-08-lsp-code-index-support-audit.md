# Evidence ledger: lsp code index support audit

- Status: verifying
- Lane: standard
- Created: 2026-11-08
- Updated: 2026-11-09
- Related: ADR-0044, ADR-0046; HEAD `8ca2394da3e1c15cb077b95ec4b8d457a525c7ba`

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 研究一下现在对LSP和代码索引调用的支持情况，看看存在什么bug或者缺口

> 继续完成修复，把配对浏览器的远程 LSP 诊断和回调打通，确保事件只发给对应设备。重跑 SQLite 重开和 watcher 回归测试，注意架构设计合理，符合现有的架构

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                       | State    | Basis                                                                                                      | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Editor LSP, agent LSP and code graph have separate runtime entry points.                                        | Observed | Owning source inspected on 2026-11-08; HEAD 8ca2394da3e1c15cb077b95ec4b8d457a525c7ba.                      | -          |
| G1  | Inventory currently reachable support and identify evidenced bugs and gaps.                                     | Agreed   | Original request, 2026-11-08.                                                                              | -          |
| C1  | Research only; preserve concurrent changes and avoid installing language servers or modifying application data. | Verified | Task scope and initial git status, 2026-11-08.                                                             | -          |
| Q1  | Do runtime contracts preserve language selection, diagnostics freshness and configuration?                      | Answered | Counterexamples F2, F5–F9 below, 2026-11-08.                                                               | O1         |
| Q2  | Does the graph remain complete and fresh across mutations and failures?                                         | Answered | Counterexamples F3, F4, F10 below, 2026-11-08.                                                             | O1         |
| O2  | Agent-LSP probes reproduce contract, diagnostics, retry and protected-path defects.                             | Verified | Adjacent `.probes.mjs`, Node 26.12.1/macOS, 2026-11-08: 7 passed; assertions confirm defects.              | O1         |
| O3  | Index updates lose incoming calls, retain oversized stale files and admit ignored/symlink files.                | Verified | Adjacent `.index-probes.mjs`, memory store and actual macOS fs.watch, 2026-11-08.                          | O1         |
| O4  | Project-file changes reject before didChange; same-ID configuration changes are skipped.                        | Verified | Adjacent `.editor-probes.mjs`, actual registry and workspace manager with injected boundaries, 2026-11-08. | O1         |

| G2 | Restore paired-browser LSP diagnostics and callbacks, restrict delivery to their authenticated device, and recheck graph freshness across reopen and watcher changes. | Agreed | Follow-up implementation authorization, 2026-11-09. | G1 |
| O5 | Browser pairing replaces the global transport. Desktop host selection changes a routing pointer. A shared local LSP process would mix document and callback state across those callers. | Verified | Companion pairing code, routing holder, and VscodeExtensionState, 2026-11-09. | O1 |
| O6 | Device IDs can recur across tenants. Relay serializes mutations and a server response can be required to complete a currently executing mutation. | Verified | SecurityStore device key, authenticated relay dispatcher and LSP callbacks, 2026-11-09. | O5 |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Audit editor, built-in agent and external tool-host routes from settings to execution (G1, O1). Success is a source-backed capability map and reproducible counterexamples with severity, affected conditions and next actions. No product fixes, package installation, remote writes or commits are part of this investigation (C1). This new ledger records this distinct audit; no existing LSP/code-index ledger was found in `docs/evidence/`.

For the follow-up (G2), the client must use its actual paired transport and explicit interactive approval. The Host owns device process identity and recipient selection. Successful requests must produce diagnostics and return correlated callbacks on the authorized route, while the same document path or request ID on another device stays isolated.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                               |
| ------------ | ------ | ----------------------------------------------------------------------------------------- |
| scale        | medium | Renderer configuration, editor/plugin runtime, sidecar LSP, graph service and tool hosts. |
| technical    | medium | Existing LSP protocol and heuristic parser/resolver; inspect actual implementation.       |
| coupling     | high   | Shared configuration and host routes with different process lifetimes.                    |
| requirement  | low    | Read-only support/defect audit explicitly requested.                                      |
| verification | high   | Headless counterexamples available; real desktop/remote/mobile acceptance is separate.    |
| risk         | low    | Audit writes only this ledger and disposable verification artifacts.                      |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                  | Severity | Source                                          | Claim                                                           | Refuted by                                                                           |
| --- | -------------------------------------------------------------- | -------- | ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| R1  | A registered feature can be unavailable in the real call path. | medium   | Catalog: wiring; ADR-0044                       | Follow each declared capability to its runtime handler.         | Registration exists but a required parameter or route is dropped.                    |
| R2  | Wrong/stale diagnostics or graph results mislead the agent.    | high     | ADR-0046; lens:FMEA                             | Results preserve document identity/version and index freshness. | An isolated fixture returns stale or incorrect data after a controlled change.       |
| R3  | Audit tests can be mistaken for real-shell acceptance.         | medium   | Catalog: three shells; verification-and-outcome | Evidence states its environment and limits.                     | Claims extend beyond exercised routes/environments.                                  |
| R4  | LSP reads bypass credential-path protection.                   | high     | Catalog: trust boundaries; confinement source   | Protected paths receive the same deny as ordinary read tools.   | A protected fixture reaches didOpen through the LSP handler and confinement wrapper. |

| R5 | A different device or tenant can receive a diagnostic or complete a callback. | high | O5, O6, authenticated event transport review | Runtime, outgoing event and reply must agree on authenticated tenant and device. | A second device, reused ID from another tenant, or service stream gets the frame or accepts the reply. |
| R6 | An accepted RPC can stall if event readiness or callback scheduling is wrong. | high | O5, O6, relay queue review | Require an accepted subscription and let correlated responses complete an in-flight relay mutation. | Subscription refusal still starts a server or a reply waits behind the RPC that needs it. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk | Method                                                        | Independence | Evidence                                                                                                                  | Coverage                                                                                             | Status |
| --- | ---- | ------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1   | Trace settings, registrations and callers.                    | tool         | Source map below, including session and broker forwarding.                                                                | Editor, both agent rails, external bridge; source evidence only for remote routes.                   | passed |
| V2  | R2   | Run focused suites and deterministic counterexamples.         | tool         | 244 existing tests passed, 2 skipped, 0 failed; 7 agent checks and index/editor probes reproduce defects; commands below. | Headless contracts/freshness; no downloads or real provider/native UI.                               | passed |
| V3  | R3   | Review findings against source and state verification limits. | self         | Findings label source vs execution evidence; final source and git-status review.                                          | Audit result, not real-shell acceptance.                                                             | passed |
| V4  | R4   | Compare ordinary read and LSP protected-path handling.        | tool         | Probe 7: read=deny; lsp_hover=null; actual resolver sends protected fixture to injected didOpen through real middleware.  | No real credentials; fake LSP process, actual file read/policy; no complete OS-sandbox/provider run. | passed |

| V5 | R2 | Reopen a warm SQLite graph, move a definition, and run the real filesystem watcher through edits and ignore changes. | tool | `run-sidecar-tests.mjs` on index-service and resolver-pass, 25 passed, 0 skipped. | SQLite binding checked before and after reopening, no extraction on reopen, real watcher, Node and Bun worker parity. | passed |
| V6 | R1, R6 | Exercise browser transport, registry, sidecar callbacks and event readiness. | tool | 577 Jest tests in 16 suites, 50 VS Code host protocol tests and 99 sidecar checks passed. Real stdio editor fixture passed. | Browser transport selection, actual dispatcher, rejected subscriptions, host changes and current text replay. Sidecar typecheck also passed. | passed |
| V7 | R5, R6 | Verify scoped delivery, no replay, callback ownership and relay scheduling. | tool | Rust event-bus suite 176 passed and 1 existing ignored. LSP RPC fixture 2 passed. Relay callback queue and throughput tests 2 passed. | Real fixture child processes isolate two devices and a colliding device ID in another tenant. Device-only event topic is not replayed. The callback releases an in-flight relay mutation. | passed |
| V8 | R3, R5, R6 | Exercise a current native Host and two paired browsers on live event sockets. | real-env | Agent-debug status reports `bridge_unavailable` for the current endpoint. | Actual Tauri browser pairing, WS/RTC and language server. | blocked |
| V9 | R3 | Run whole-checkout type, lint, static export, i18n and contract checks. | tool | Static export, i18n and scoped ESLint passed. Whole-checkout typecheck reports storage, memory and network errors. Full ESLint reports 13 warnings outside this repair. Semantic parity reports other feature contract gaps. | Shared dirty checkout at HEAD bad13a5143ad619242e716101fc5a8067fc6aa43 plus local changes. | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                | Action   | Based on           | Reversal trigger                                                                |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ | ------------------------------------------------------------------------------- |
| D1  | 2026-11-08 | Standard-lane diagnosis; parallel read-only module discovery as described by the skill's complexity-discovery guidance. | diagnose | O1, G1, C1         | User requests implementation or a source path is found outside the current map. |
| D2  | 2026-11-08 | Deliver prioritized findings and stop after reproducible counterexamples; product behavior remains unchanged.           | diagnose | G1, C1, O2, O3, O4 | A failed repro or conflicting owning source invalidates a finding.              |

| D3 | 2026-11-09 | Use the existing system LSP supervisor per authenticated tenant and device and the existing targeted ephemeral bus. Keep the local system host separate. | implement | G2, O5, O6 | A real device cannot complete a callback, or a cross-device probe observes another runtime. |
| D4 | 2026-11-09 | Keep process operations on the ordinary serial/strict policy. Allow correlated relay replies to complete in-flight RPCs and give transient buffer synchronization the existing wider bounded quota. | harden | G2, O6 | An unrelated write becomes parallel or a callback still waits behind its own request. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                   | From               | Why still open                                                                                                         | Next action                                               | Status |
| --- | -------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| X1  | Original confirmed defects needed product repair.                          | R1, R2, R4, V6, V7 | Scoped product regressions and private-runtime checks now pass. Live-shell acceptance is tracked by X2.                | Retain these regression fixtures.                         | closed |
| X2  | Native Host and two real paired browsers have not been exercised together. | R3, V8             | Current local Tauri bridge is unreachable.                                                                             | Exercise two isolated pairings against a current Host.    | open   |
| X3  | Original audit did not cover Bun or a warm SQLite index.                   | V2, V5             | The follow-up runs both and checks the persisted reference candidates.                                                 | Keep the warm-reopen regression.                          | closed |
| X4  | Whole-checkout gates remain red outside the repaired LSP paths.            | V9                 | Concurrent changes in storage, memory, network, plugin permissions and selection-toolbar have outstanding diagnostics. | Resolve those module-owned failures and rerun full gates. | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                               | How / when measured                             | Result                                                                             | Status |
| --- | -------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| M1  | A reviewable inventory and prioritized, reproducible findings exist. | Audit report and ledger validation, 2026-11-08. | Inventory, findings and repeatable artifacts below; product repair is not claimed. | met    |

| M2 | An unchanged caller still points to a moved symbol after reopening SQLite, and the watcher preserves index admission. | CodeGraph fixtures, 2026-11-09. | 25 focused checks passed with no skips. | met |
| M3 | Browser transport and Host fixtures deliver diagnostics and complete callbacks only for their authenticated tenant and device. | Renderer fixture, child-process RPC fixture and event-bus checks, 2026-11-09. | Both directions passed. Another device, a colliding ID in another tenant and a stale renderer callback are refused. | met |

## Current support (initial audit)

| Surface         | Implemented capability                                                                                                                                                                        | Activation / boundary                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent LSP       | Five tools: definition, references, hover, document symbols, diagnostics; 1-based tool positions convert to 0-based LSP.                                                                      | `builtinTools.lsp` plus `lsp.enabled` and `cwd`; `sidecar/src/tools/builtin/lsp/index.ts:121`, `sidecar/src/tools/builtin/registry.ts:139`.                                                                 |
| Configuration   | builtin → plugin → user → project merge; nine builtin server entries for TS/JS, Python, Rust, Go, JSON, CSS family, HTML, YAML, Bash.                                                         | `lib/lsp/resolve-config.ts`, `lib/lsp/builtin-defaults.ts`. Agent assembly supplies user/project but no plugin list (`lib/claude/build-options.ts:3215`). Plugin servers register separately in the editor. |
| Server runtime  | Binary detection/npm provisioning, initialization timeout, crash supervisor, diagnostic debounce/dedupe/version filtering, status/logs.                                                       | `sidecar/vscode-ext-host/src/lsp-{installer,client,service,diagnostics-buffer}.ts`. Rust/Go provisioning is intentionally detect-only.                                                                      |
| Editor          | Monaco completion, hover, definition, references, formatting, code actions, rename, symbols, signature help, semantic tokens, inlay hints, hierarchies, conditional on server capabilities.   | `lib/plugin/lsp/lsp-monaco-runtime.ts:280` onward. Pure builtin auto-start is intentionally excluded by ADR-0044; user/project/overridden-builtin entries are eligible.                                     |
| Agent rails     | Claude Agent SDK and AI SDK use the same session resolver factories. Native SDK edits use diagnostic hooks; core write/edit/apply-patch tools have diagnostic feedback.                       | `sidecar/src/tools/session.ts:96`; `sidecar/src/runtimes/claude-agent-sdk/options.ts:222`; `sidecar/src/tools/builtin/core-files/write.ts:35`.                                                              |
| External agents | CLI broker forwards LSP/index options; stdio bridge constructs actual session tools and applies visibility filtering.                                                                         | `cli/src/agent/tool-host/broker.ts:205`; `sidecar/src/mcp/servers/tool-bridge.ts:144`. Source-proven, not real Codex/ACP acceptance.                                                                        |
| Code index      | Nine tools: status/search/node/callers/callees/impact/context/explore/files. Lazy index, SQLite persistence or memory fallback, hash updates, recursive watcher and output/traversal budgets. | `sidecar/src/tools/builtin/code-graph/tools.ts`; `sidecar/src/services/code-graph/`. Extractors: TS/TSX, JS/JSX/MJS/CJS, Python, Rust. No Go/Java/C/C++ extractor.                                          |

The installed navigation CLI `codegraph` is separate from Cognia's internal implementation. This checkout has no `.codegraph` index; navigation used `rg` and source reads without initializing one. Standalone browser/mobile have no local server process. Companion-backed LSP is partially implemented, with gaps below.

## Prioritized findings

### F1 — P1: agent LSP misses the credential-path hard deny

`READ_TOOLS` omits `lsp_*` and `PATH_KEYS` omits their `file` argument (`sidecar/src/policy/confinement/classify.ts:132,168,333`). Both permission classification and `assertToolCallWithinRoots` skip these tools. The resolver reads the file in the parent process before server startup (`sidecar/src/services/lsp/resolver.ts:219–243`).

**Reproduced:** temporary `.ssh/fixture.ts`; a markerless `.ts` server; `lsp_hover` through actual confinement middleware. Ordinary `read` is denied; LSP classification returns `null`; the handler sends fixture contents to injected `didOpen`. No real credential was accessed. This establishes a tool-policy bypass, not full provider/OS-sandbox behavior. Add tool/path classification and resolver-boundary checks, including protected symlink targets.

### F2 — P1: normal project editor changes never reach didChange

`lib/plugin/lsp/lsp-registry.ts:503–525` always calls `flushMaterializedDocument` before `didChange`. Real `file://` documents are accepted (`lib/plugin/vscode-shim/lsp-workspace-manager.ts:560`) but have no synthetic materialization record, so flush rejects (`:384–392`).

**Reproduced with actual modules:** register project, open model, change content → client receives only `start`, `didOpen`; error: `lsp-workspace-manager: no materialised document for file:///tmp/audit-project/main.ts`. Later editor results can remain based on the opened text. Split project-file and synthetic-document handling and test both branches.

### F3 — P1: shifting a definition loses incoming call relationships

Symbol IDs include start line (`sidecar/src/services/code-graph/extractor.ts:43`). File replacement only removes outgoing edges (`store-memory.ts:165`, `store-sqlite.ts:102`). Resolved references were removed (`resolver-pass.ts:57`), so the incremental resolver cannot reconstruct unchanged callers (`index-service.ts:355`).

**Reproduced:** `a.ts` exports `target`; unchanged `b.ts` imports/calls it. Add one comment above target, synchronize → callers `before=["caller"]`, `after=[]`, `unresolved=0`. Repair cross-file invalidation/re-resolution or symbol identity; test line shifts, renames and deletion across callers/callees/impact.

### F4 — P1: watcher admission bypasses ignore and no-symlink rules

Full discovery uses ignores, `dot:false`, `followSymbolicLinks:false` (`index-service.ts:201`). Watch admission checks only extension (`:301`); queued paths go directly to indexing (`:333`); `stat`/`readFile` follow symlinks (`:228`).

**Reproduced with real macOS fs.watch:** ignored `ignored/private.ts` starts absent, then appears in search after editing. New `link.ts` pointing to external temporary source exposes its symbol and full snippet. **Scope:** direct unconfined `createIndexService`; no authorization/OS-sandbox bypass claim. Reuse discovery, canonical-path and symlink rules on incremental admission.

### F5 — P2: existing editor-server configuration changes are ignored

`syncUserLspServers` skips all existing IDs without comparing or updating config (`lib/plugin/lsp/lsp-user-servers.ts:71–75`). Actual-module probe registers `old-server`, then syncs same ID with `new-server` and different settings → one registration, old command retained, `skipped=1`. Same-ID project overrides can retain the previous project's config. Compare effective definitions and restart/update changed records.

### F6 — P2: agent uses file extensions as language IDs

`resolver.ts:231` sends `ts`, `tsx`, `py`, `rs` rather than `typescript`, `typescriptreact`, `python`, `rust`; all four payloads were captured. [Microsoft's language identifier reference](https://code.visualstudio.com/docs/languages/identifiers) documents these canonical identifiers. The payload defect is verified; actual breakage depends on server URI inference and was not measured with a real language server. Add extension/filename mapping, including multi-language servers.

### F7 — P2: unavailable or old diagnostics are presented as current

No touched server returns `[]` (`resolver.ts:264–267`), rendered as successful `No diagnostics.` (`sidecar/src/tools/builtin/lsp/index.ts:194–197`). Conditions include missing binaries, no applicable root/server and unreadable files. Cache entries are URI-only (`resolver.ts:155–156`) and survive edits. Filtering old incoming versions below this layer does not invalidate previously cached errors.

**Reproduced:** unavailable fake binary → zero starts and successful `No diagnostics.`; publish `old error`, edit without a fresh publish → old error returned. Distinguish unavailable/pending/clean, correlate document/server generations and identify/merge multiple servers explicitly.

### F8 — P2: transient server and host failures remain cached

`failedServers` prevents all later binary resolution (`resolver.ts:165–173`). After a 30-second install budget expires, later touches cannot detect the newly installed binary in that session, contrary to ADR-0046. Probe switches availability after first touch: resolver called once; both touches return `[]`.

The lazy wrapper clears only rejected factory promises (`lazy-resolver.ts:49–70`), but the real loader catches missing-host errors and returns `null` (`service-loader.ts:202` onward). Probe makes two requests; null factory runs once. Use bounded retry/backoff and distinguish permanent vs temporary failures; reset failed constructor imports if recovery is intended.

### F9 — P2: shared config fields are silently dropped

- Editor conversion omits `endpoint`, `startupTimeout`, `memoryLimitMb`, `install` (`lsp-user-servers.ts:88–104`). Socket config becomes `transport:socket` without endpoint. Missing install metadata is a provisioning gap, not evidence that this route already implements auto-install.
- Agent conversion loses transport/endpoint/memory; startup forces stdio and does not forward timeout (`sidecar/src/services/lsp/servers.ts:183` onward; `resolver.ts:183–202`). `${workspaceFolder}` remains literal in command/args.

Probes capture both omission paths. Preserve supported fields end-to-end or explicitly reject/display unsupported configuration.

### F10 — P2: files exceeding 5 MiB keep stale graph data silently

`index-service.ts:238` skips without invalidating an existing graph. Probe replaces indexed `target` with oversized source defining another symbol → old symbol stays, new one absent, `stalenessBanner=""`. Remove or mark stale previous data and expose the skip reason.

## Additional source-confirmed gaps

- Editor registry passes no server-request callback (`lsp-registry.ts:243–255,431–448`); adapter rejects unhandled requests with `-32601 LSP_CLIENT_METHOD_UNAVAILABLE` (`lsp-client-adapter-tauri.ts:134–160`). Workspace-folder/apply-edit and refresh/show-document requests lack a standalone editor consumer. Probe confirms callback absence; no actual server round trip. Dynamic registration is intentionally disabled and not counted as a bug.
- Remote-aware `EditorLspRuntimeInitializer` is mounted inside Tauri-only initializers (`components/providers/initializers/desktop-only-initializers.tsx:230,258`). This is an automatic browser-companion boot gap; another surface can still initialize manually.
- Status uses a Tauri/headless host predicate excluding ordinary remote browsers and resolves without active-project `rootDir` (`lib/lsp/lsp-status-store.ts:58–75`), hiding project-only definitions from status inventory.
- Default project config reader returns null off-Tauri without injection (`lib/lsp/project-file-reader.ts:31`). CLI supplies its reader (`cli/src/config/to-build-context.ts:463`); browser-companion editor defaults do not. Bootstrap observes settings reference/project ID, not edits to `.cognia/lsp.json` (`lib/plugin/lsp/lsp-bootstrap.ts:191–205`).
- Plugin-contributed LSP does not automatically enter agent resolution. Graph name resolution is intentionally heuristic; its internal ambiguity/provenance is omitted from caller/callee/impact summaries. Unsupported languages and absent agent workspace-symbol/implementation/type-definition/call-hierarchy tools are capability gaps, not regressions in the five existing tools.

## Verification and reproducibility

macOS Apple Silicon, Node `v26.12.1`, 2026-11-08. Shared tree had concurrent unrelated changes; product source was not edited. New files are audit-specific evidence because no existing ledger/probe owns this question. No coverage, downloads, full lint/typecheck/build, native UI, phone or real-provider acceptance was run.

```sh
rtk proxy pnpm sidecar:test sidecar/src/services/lsp/resolver.test.ts sidecar/src/services/lsp/servers.test.ts sidecar/src/services/lsp/lazy-resolver.test.ts sidecar/src/services/lsp/service-loader.test.ts sidecar/src/tools/builtin/lsp/index.test.ts sidecar/src/hooks/lsp-diagnostics.test.ts
# 6 files: 60 passed, 0 failed.

rtk proxy pnpm test --runInBand --runTestsByPath lib/plugin/lsp/lsp-user-servers.test.ts lib/plugin/lsp/lsp-bootstrap.test.ts lib/plugin/lsp/lsp-registry.test.ts lib/plugin/lsp/lsp-monaco-runtime.test.ts lib/plugin/lsp/lsp-client-adapter-tauri.test.ts lib/lsp/ensure-editor-lsp-runtime.test.ts components/providers/initializers/editor-lsp-runtime-initializer.test.tsx
# 7 suites: 74 passed, 0 failed.

rtk proxy node scripts/test/run-sidecar-tests.mjs sidecar/src/services/code-graph/index-service.test.ts sidecar/src/services/code-graph/lazy-resolver.test.ts sidecar/src/services/code-graph/resolver-pass.test.ts sidecar/src/services/code-graph/store-parity.test.ts sidecar/src/services/code-graph/watcher.test.ts sidecar/src/tools/builtin/code-graph/tools.test.ts
# 52 passed, 1 skipped, 0 failed.

rtk proxy node scripts/test/run-sidecar-tests.mjs sidecar/src/services/code-graph/parser.test.ts sidecar/src/services/code-graph/extractor.test.ts sidecar/src/services/code-graph/graph.test.ts sidecar/src/services/code-graph/context-builder.test.ts sidecar/src/services/code-graph/budget.test.ts sidecar/src/services/code-graph/languages/index.test.ts sidecar/src/services/code-graph/store-memory.test.ts sidecar/src/services/code-graph/extraction-pool.test.ts
# 58 passed, 1 skipped, 0 failed. Both skips require a Bun test environment.

rtk proxy node --test docs/evidence/2026-11-08-lsp-code-index-support-audit.probes.mjs
# 7 passed: assertions confirm defects, not correct product behavior.

rtk proxy node docs/evidence/2026-11-08-lsp-code-index-support-audit.index-probes.mjs
# Three defect groups reproduced; fixtures cleaned automatically; actual fs.watch.

rtk proxy node docs/evidence/2026-11-08-lsp-code-index-support-audit.editor-probes.mjs
# Actual-module configuration and project-file lifecycle counterexamples reproduced.
```

Editor probes transpile checked-out modules with TypeScript and execute with `vm.runInThisContext`; only logging/filesystem/RPC/provider boundaries are injected. The lifecycle probe uses the actual workspace manager. The ledger remains `verifying` because product risks X1–X3 remain open; the requested audit outcome M1 is met.

Final artifact checks: all three persisted probe scripts executed successfully after formatting; scoped ESLint and Prettier checks passed; `ledger.mjs check --final` returned 0 errors and 0 warnings. The editor probe resolves the root TypeScript compiler API explicitly because the docs workspace's TypeScript package does not expose that API. HEAD remained the recorded SHA; concurrent unrelated changes were preserved. No commit was created.

## Follow-up repair and adversarial review

The findings and defect probes above describe the original checkout. The adjacent adversarial probe reproduced five more cases on that baseline, including native SQLite on warm reopen, stale snippets, provider fallback, malformed configuration and queued old-version diagnostics. The canonical language ID finding concerns the protocol payload. Server implementations can infer the language from the URI, so it does not imply a universal outage.

The product changes repair workspace and protected-file policy, document synchronization and startup retry, layered configuration, and CodeGraph reference retention and admission. The paired-browser continuation uses the same interactive Companion facade and VS Code LSP supervisor. Its runtime is keyed by authenticated tenant and device. Its opt-in topic delivers live diagnostics and requests using the targeted ephemeral EventBus path. WS and relay match the authenticated recipient. The service renderer's local channel is separate. The renderer requires an accepted subscription, rebinds on target changes and drops old callbacks and markers. The regular editor answers the workspace-folder request. Managed consumers still use their explicit callback and edit preconditions.

The local stdio fixture exercises real child-process document opens, edits and restart. The browser fixture exercises application transport selection and JSON-RPC dispatch with injected Companion frames. The multi-device RPC fixture, relay tests and real browser acceptance are tracked separately in V7 and V8.

### Final repair verification

Verification logs are in the local, ignored directory `.cache/lsp-repair/`. `latest-ui.log`, `sidecar-last.log`, `vscode-final.log`, `rust-bus-full.log`, `rpc-final-verified.log` and `relay-final-verified.log` contain the completed test results. `process.log` contains the real stdio fixture output.

The new `lib/lsp/host-transport.ts` owns LSP-specific selection and event rebinding across the desktop router and the browser pairing owner. Its consumers share one system adapter. Companion keeps authority over the runtime key, tenant stamp, target device, event catalog and execution policy. Remote publication permits the supported LSP and protocol event methods. Host bootstrap frames stay internal.

Additional boundary regressions ensure an external file alias cannot choose the agent LSP workspace and a writable cache alias cannot authorize an unreadable CodeGraph root. Explicit readable roots with writable caches remain supported.

Current native agent-debug status is `bridge_unavailable`. No live two-browser/native-host or real language-server acceptance is claimed. The follow-up remains verifying for X2 and X4. No commit was created.
