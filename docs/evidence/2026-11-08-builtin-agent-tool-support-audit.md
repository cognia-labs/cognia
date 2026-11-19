# Evidence ledger: builtin agent tool support audit

- Status: verifying
- Lane: standard
- Created: 2026-11-08
- Updated: 2026-11-08
- Related: ADR-0090, ADR-0198, ADR-0070

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 研究一下现在对内置Agent工具调用的支持情况，看看存在什么bug或者缺口

Follow-up request on 2026-11-08:

> 做一次对抗性审查，然后给出完整的问题列表

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                         | State    | Basis                                                                                                                                                                                            | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| O1  | Built-in execution has renderer-contributed tools and sidecar-native tools, with AI SDK and Anthropic adapters.                   | Observed | `lib/claude/build-options.ts`, `sidecar/src/tools/adapters/ai-sdk.ts`; source on 2026-11-08.                                                                                                     | -          |
| H1  | Some defects occur where tool identity, policy or lifecycle crosses adapters.                                                     | Verified | Seven characterization probes reproduce six defects and one compatibility gap on 2026-11-08; see findings below.                                                                                 | O1         |
| H2  | Some unavailable tools are deliberate category, shell, or per-run capability restrictions.                                        | Verified | Category defaults, resolver guards, module surface gates and standalone unsupported-capability check inspected on 2026-11-08.                                                                    | O1         |
| G1  | Inventory current built-in Agent tool support and report actionable bugs/gaps with source and reproducible evidence.              | Agreed   | User request, 2026-11-08.                                                                                                                                                                        | -          |
| C1  | Research only: preserve concurrent edits; no production fixes, commits, external sends or paid provider experiments.              | Verified | User requested investigation; shared dirty checkout observed on 2026-11-08.                                                                                                                      | -          |
| Q1  | Which tools reach each adapter, and do permissions and lifecycle semantics survive?                                               | Answered | Support map and F1-F6 below; local source and deterministic fixtures, 2026-11-08.                                                                                                                | O1         |
| O2  | Catalogs declare 84 sidecar tools across 12 categories and 84 module tools across 18 families; these are conditional inventories. | Verified | `builtin-tools-data.json` and generated module registry counted locally on 2026-11-08; special host tools are additional.                                                                        | O1         |
| O3  | AI SDK native deny aliases, Code-mode nested calls and approval rewrites have policy gaps.                                        | Verified | F1, F2 and F6 probes; bare-name/direct-gate/Anthropic controls distinguish each gap, 2026-11-08.                                                                                                 | O1         |
| O4  | Standalone tools ignore resolved lists/modes/approval metadata and omit the executor abort signal.                                | Verified | F4/F5 exercise actual standalone bridge with only its effectful executor substituted; production resolver/controller/dispatcher source traced, 2026-11-08.                                       | O1         |
| O5  | AI SDK renderer-proxied MCP errors lose their error status.                                                                       | Verified | F3 compares AI SDK output and actual event projection with the Anthropic proxy control, 2026-11-08.                                                                                              | O1         |
| O6  | Standalone drops dotted tool identifiers rather than aliasing them.                                                               | Verified | Probe G1 and sidecar model-name alias implementation, 2026-11-08.                                                                                                                                | O1         |
| O7  | Standalone emits success after its eight-step budget or a length-truncated stream.                                                | Verified | Independent offline real-SDK engine fixture: eight tool calls/no final answer, and one length-truncated generation both produce success; 2026-11-08.                                             | O1         |
| O8  | Fresh reviewers independently confirm F1-F6, with narrower authority and environment bounds.                                      | Verified | Three source-only fresh-context reviews, plus independent native/standalone/renderer scripts rerun by the main session on 2026-11-08.                                                            | O3, O4, O5 |
| O9  | Standalone text after a tool call duplicates prior tool history and breaks the next SDK send.                                     | Verified | Actual installed streamText to current mapper/adapter produces duplicate tc1; next stream throws AI_MissingToolResultsError before model invocation, 2026-11-08.                                 | O1         |
| O10 | Standalone omits turn/attempt identity required by progressive Skill loading.                                                     | Verified | Actual loader returns stale_context through bridge; matching-identity control succeeds, 2026-11-08.                                                                                              | O1         |
| O11 | AI SDK JSON Schema wrappers lack runtime validators, allowing schema-invalid model input into the renderer proxy.                 | Verified | New F7 probe uses actual generateText and MockLanguageModelV4; invalid numeric query/over-limit value reaches proxy, converted Zod control rejects, 2026-11-08.                                  | O1         |
| O12 | A same-name plugin manifest can describe one owner while dispatch selects the built-in module.                                    | Verified | Current resolver composition block fixture and source trace of registration and module-first dispatch, 2026-11-08; no actual plugin installation acceptance.                                     | O1         |
| O13 | Sidecar interrupt drains its waiter but leaves the ordinary desktop ask_user question active.                                     | Verified | Actual AI adapter plus actual question store fixture: pendingSidecar=0, hostQuestionStillActive=true, hostFinished=false, 2026-11-08.                                                            | O1         |
| O14 | Empty-content valid MCP results lose error/envelope identity through the native plugin proxy.                                     | Verified | Installed CallToolResultSchema accepts fixture; actual proxy wraps it in success text, 2026-11-08.                                                                                               | O1         |
| O15 | Audio/resource-only results lose structured content before the UI consumer on both AI SDK paths.                                  | Verified | Actual event shapers return strings; adapter requires array content to attach mcpContent; image-containing control stays structured, 2026-11-08.                                                 | O1         |
| O16 | Standalone sends rich MCP output to the next model step as JSON.                                                                  | Verified | Actual SDK second-step prompt carries image envelope as output.type=json; bridge has no toModelOutput converter, 2026-11-08.                                                                     | O1         |
| O17 | A final tool-only snapshot resets completed tools and discards their rendered output on both AI SDK paths.                        | Verified | Bounded reconciliation uses actual SDK stream and applySdkEvent: output-available before seal becomes input-available without output after seal/finish; both sidecar and standalone, 2026-11-08. | O1         |

## Problem frame

Determine the supported built-in tool surface from registration through execution and result delivery, then distinguish reproducible defects from intentional restrictions (G1, H1, H2). This audit may add its ledger and bounded local reproduction artifacts. It does not change application behavior (C1). A useful outcome is an evidence-backed prioritized list with explicit limits on real-provider and shell acceptance.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                       |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Tool registration, renderer/CLI contributions, two adapters, permission gate and transcript projection.           |
| technical    | medium | Existing code, but multiple representations of tool identities/results.                                           |
| coupling     | high   | Browser, Tauri, paired Host and CLI share policy/configuration but differ in available capabilities.              |
| requirement  | low    | Read-only audit, no requested implementation.                                                                     |
| verification | high   | Local deterministic checks can establish defects; complete provider/device acceptance requires real environments. |
| risk         | low    | Audit artifacts only; inspected execution surfaces themselves can perform high-impact operations.                 |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                      | Severity | Source                       | Claim                                                                        | Refuted by                                                                  |
| --- | ------------------------------------------------------------------ | -------- | ---------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| R1  | Mistake intentional filtering for a missing feature.               | medium   | H2; ADR-0198                 | Findings trace the actual effective tool surface and policy.                 | A reported missing tool is intentionally unavailable in the selected scope. |
| R2  | Miss a permission bypass or identity collision at an adapter seam. | high     | ADR-0070; adapter inspection | Tool identity and deny rules remain consistent through execution.            | A local fixture executes or exposes a denied/colliding tool.                |
| R3  | Overstate lifecycle or result support from green isolated tests.   | medium   | O1                           | Claims distinguish actual source/reproduction from real-provider acceptance. | A claimed full pass has no corresponding provider/shell run.                |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk       | Method                                                                                                                      | Independence   | Evidence                                                                                                                                                        | Coverage                                                                                                              | Status |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1         | Trace composition, registration, adapter filtering, execution and transcript call sites; inspect ADRs.                      | self           | Support map below; ADR-0090, ADR-0198 and ADR-0070 inspected.                                                                                                   | Main built-in Agent path; external-agent runtimes are outside this audit.                                             | passed |
| V2  | R2         | Run existing focused adapter/policy tests and safe fault-injection reproductions against owning functions.                  | tool           | Existing sidecar runs: 165 + 45 tests passed; seven characterization probes passed, confirming the reported bad behaviors; commands below.                      | Identity, nested policy, rewritten inputs, cancellation and errors; fixed fixtures only.                              | passed |
| V3  | R3         | Inspect UI/result and persisted-history consumers; state real-environment limits explicitly.                                | self           | `sidecar/src/runtimes/ai-sdk/events.ts`, `lib/claude/adapter.ts:1238-1320`, tool-call row state map, standalone mapper and controller traced.                   | Source-level lifecycle and result projection; no device/provider acceptance.                                          | passed |
| V4  | R1, R2, R3 | Validate ledger and review final scoped diff/status.                                                                        | tool           | Final checks recorded below.                                                                                                                                    | Audit artifact integrity and concurrent-tree safety.                                                                  | passed |
| V5  | R1, R3     | Run resolver, catalog, standalone and transcript baseline suites.                                                           | tool           | Two `pnpm test --runInBand --runTestsByPath ...` runs: 4 suites/87 tests and 4 suites/725 tests passed.                                                         | Existing resolution, subagent catalog, standalone and transcript contracts; not regressions for the newly found gaps. | passed |
| V6  | R1, R2, R3 | Fresh-context adversarial reviews of three bounded source surfaces, then reconcile every item.                              | fresh-reviewer | Reviewers review_native_policy, review_standalone and review_renderer_tools returned source anchors, controls and reproducible local scripts; reconciled below. | Native policy, standalone runtime, renderer registration/dispatch/results.                                            | passed |
| V7  | R1, R2, R3 | Rerun characterization and independent scripts against current source; exercise actual installed SDK with in-memory models. | tool           | Eight durable probes passed; three independent scripts exited 0; key outputs preserved below.                                                                   | No network/provider/device calls; app storage/parser/transport seams isolated where documented.                       | passed |
| V8  | R3         | Check existing tests on newly uncovered lifecycle/transcript/Skill surfaces.                                                | tool           | pnpm test --runInBand --runTestsByPath: 5 suites/92 tests passed; renderer reviewer sidecar baseline: 4 files/137 tests passed.                                 | Existing tests do not cover the reproduced counterexamples; counts are separate runs, not unique aggregate coverage.  | passed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                 | Action   | Based on                                          | Reversal trigger                                                                     |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| D1  | 2026-11-08 | Investigate current source and bounded local checks; defer implementation decisions until findings exist.                                                | diagnose | G1, C1, O1                                        | Evidence requires a different built-in Agent definition or broader authorized scope. |
| D2  | 2026-11-08 | Stop discovery after reproducing six defects and one compatibility gap; deliver priorities and preserve unresolved acceptance separately.                | stop     | G1, C1, O2, O3, O4, O5, O6                        | A reported finding fails its control, source changes, or the user requests repairs.  |
| D3  | 2026-11-08 | Reopen on the user's adversarial-review request; split artifacts for three independent read-only reviews and SDK-level counterexamples.                  | diagnose | G1, C1, O1                                        | New evidence invalidates a previous finding or changes its reachable scope.          |
| D4  | 2026-11-08 | Preserve confirmed findings, narrow security claims to retained guards, and publish the reconciled inventory; user declined external cross-model review. | stop     | G1, C1, O8, O9, O10, O11, O12, O13, O14, O15, O16 | A counterexample or source change defeats a listed trigger/control.                  |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                       | From                                                  | Why still open                                                                                                   | Next action                                                                    | Status |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| X1  | Provider, full Tauri UI, Android and full CLI execution have not been accepted.                | R3                                                    | This is a local source and deterministic-boundary audit; no provider credentials or real account data were used. | After repairs, run the affected real flows on authorized providers/devices.    | open   |
| X2  | Confirmed findings remain in production source.                                                | R2, O3, O4, O5, O9, O10, O11, O12, O13, O14, O15, O16 | Research and adversarial review only; business code was not changed.                                             | Repair prioritized items with behavioral regressions and real-flow acceptance. | open   |
| X3  | Fixed-step termination and standalone rich-media behavior required deterministic verification. | O7, O16, R3                                           | Closed by real installed SDK fixtures; actual provider/device acceptance remains X1.                             | Track confirmed defects F14/F15 for repair.                                    | closed |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                          | How / when measured                                                            | Result                                                                                                                                      | Status |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | User receives a current support map and prioritized reproducible findings.      | Source audit and local checks on 2026-11-08.                                   | Support map, six defects, two additional gaps, repro commands and validation limits recorded below.                                         | met    |
| M2  | User receives an adversarially reviewed inventory with evidence and exclusions. | Three fresh-context reviews plus reconciled source/SDK fixtures on 2026-11-08. | Authoritative inventory below preserves original IDs, adds missed defects, and distinguishes compatibility trade-offs and unverified areas. | met    |

## Audit scope and environment

- Date: 2026-11-08, Asia/Shanghai. macOS arm64, Node v26.12.1, installed AI SDK `ai@7.0.128`.
- Source snapshot: shared checkout, HEAD `8c7d787f494941c7613b5b2ef349fdfb25f61d6d` when findings were validated. Concurrent unrelated edits/commits were present; this is not a clean-commit release acceptance.
- Scope: Cognia's built-in Agent runtime, including its native sidecar tools, renderer-contributed tools and standalone browser/mobile branch. External runtimes such as Codex/OpenCode are outside the findings.
- CodeGraph CLI was available but the checkout had no index; source navigation used `rg` and direct reads. No index was created.
- The existing built-in-budget ledger concerns long-run budgeting, not this tool-policy audit. This new ledger owns the broader tool support map. The adjacent probe file is a reviewable diagnostic artifact; extending production tests would mix research with a behavior change. Outputs stay under `.cache/builtin-agent-tool-support-audit/`.

## Current support map

| Surface                   | Implemented support                                                                                                                                                                                                                                | Boundary                                                                                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition               | `resolveSendOptions` collects module tools, built-in skills, plugins and special tools; combines grants, rulesets, allow/deny lists and final tool-surface projection.                                                                             | Some downstream consumers fail to preserve these decisions (F1, F2, F4).                                                                                                                                                              |
| Sidecar-native catalog    | 12 categories, 84 metadata entries: file extras, core files, Git, process, environment, advanced shell, terminal REPL, LSP, CodeGraph, AST grep, dependency research and webclone.                                                                 | Counts describe possible tools, not the tools exposed in one turn. LSP/CodeGraph also require resolvers. Plan/Code/verification tools can add conditional definitions outside this metadata count.                                    |
| Renderer module tools     | 18 families with 84 declarations: Agent Builder, Artifact, Automation, Code Server, Filespace, Knowledge Base, Media, Memory, Pet, Project Coordinator, Sites, Slash Commands, Squads, Tasks, Templates, Terminal, Vector and Workflow.            | Families have their own shell/session/settings gates; declarations are not all exposed simultaneously. Additional special tools include web search/fetch, Skill, attachments, working state, `ask_user`, and `dispatch_agent`/`Task`. |
| Anthropic sidecar         | Claude Agent SDK native tools plus Cognia's synthetic MCP servers; schemas, tool discovery, permissions, approval TTL, read-only execution timeout and result safety middleware exist.                                                             | Core file tools normally come from the SDK; `coreFilesOnAnthropic` deliberately opts into Cognia equivalents. Nested Code calls still bypass per-tool policy (F2).                                                                    |
| AI SDK sidecar            | Native `tool()` maps over the same definitions; external MCP integration, allow-list aliases, permission ladder, deferred ToolSearch, input streaming, error events, image/audio/resource output conversion and prompt-stable tool ordering exist. | Deny aliases, approval rewrites and proxied MCP error status differ from the Anthropic path (F1, F6, F3).                                                                                                                             |
| Browser/mobile standalone | Direct provider loop with renderer-executable `pluginTools`, shared dispatcher and transcript mapper. The chat controller actually calls `runStandaloneTurn`; this is reachable product code.                                                      | No sidecar-native OS tools. Native fork/auto-compaction/dynamic-extension/portable tool-policy requests are explicitly refused. Existing allow/deny/ruleset/plan/approval metadata is otherwise ignored (F4).                         |
| Built-in subagents        | One catalog defines `general-purpose`, `Explore`, `Plan`, `code-reviewer` and four workflow roles. Read-only roles use a scoped tool policy; dispatch supports foreground/background collection, cancellation and resume.                          | Catalog surfaces intentionally differ. This audit does not establish real-model delegation or full CLI parity.                                                                                                                        |
| Results/UI                | Stream adapters emit tool-use/result pairs; the renderer patches by tool-use ID and selects `output-error` from `is_error`; tool rows show approval/running/result states.                                                                         | Once an adapter drops the error flag, downstream UI treats it as an available result (F3).                                                                                                                                            |

Default category flags enable `fileExtras`, `coreFiles`, `git` and `environment`. Process, advanced shell, terminal REPL, LSP, CodeGraph, AST grep, dependency research and webclone default off. Disabled categories and absent resolvers are deliberate restrictions, not missing implementations.

## Confirmed defects

### F1 — P1: native deny aliases are not enforced on the AI SDK tool map

**Trigger:** resolve a character/filter/grant deny list containing Claude-style names such as `Write`, `Read`, `Edit` or `Bash`, with the equivalent native category enabled.

**Cause:** [`ai-sdk.ts:424`](../../sidecar/src/tools/adapters/ai-sdk.ts) checks only the bare Cognia name and its MCP-qualified form for denials. The allow path adds the Claude alias at lines 485-488, so the two policies disagree. The resolver copies character/grant denies at `build-options.ts:2983` and its finalizer preserves those spellings; it does not normalize this away. The gate does not independently consume `disallowedTools`.

**Evidence:** probe F1 finds all four lowercase tools still exposed and successfully writes `audit-marker` to its own temporary fixture through `write`, despite `disallowedTools: ["Write", ...]`. A `disallowedTools: ["write"]` control removes the tool. No shell command was executed. The write fixture uses `bypassPermissions` to isolate the explicit deny contract from a separate approval prompt; other permission modes retain their own gate behavior.

**Impact and repair:** switching the same constrained Agent to an AI SDK provider can restore explicitly excluded capabilities. Reuse one canonical alias matcher for both allow and deny decisions, and pin parity for every core tool alias.

### F2 — P1: Code presentation bypasses individual tool denials and rulesets

**Trigger:** enable Code/combined presentation and a category, while excluding an eligible read tool such as `file_info`.

**Cause:** [`registry.ts:200`](../../sidecar/src/tools/builtin/registry.ts) applies presentation before the adapter filters. [`presentation.ts:28`](../../sidecar/src/tools/middleware/presentation.ts) captures all category-enabled definitions in `byName`; its broker calls `def.handler(parsed.value)` at line 46 without re-entering the per-tool permission gate. Category confinement and argument parsing remain, but allow/deny/ruleset checks, per-tool review and event identity do not follow the nested call.

**Evidence:** probe F2 uses the actual `run_code` child through macOS `sandbox-exec`, with child network and writes denied. Direct `file_info` is removed, and a fully qualified ruleset explicitly denies it. `cognia.file_info(...)` still reads metadata for the probe fixture and returns `exists: true`, size 12, one nested call. With only palette filtering removed, the direct tool correctly rejects the same ruleset. This verifies a policy bypass; it does not demonstrate a sandbox escape or secret-file access.

**Impact and repair:** the wrapper widens a run's effective read authority beyond its selected tool policy. Build Code SDK declarations from the final permitted surface and route every nested call through the same per-call authorization/review/cancellation/event seam. Preserve existing confinement and schema validation.

### F4 — P1: standalone bypasses resolved tool restrictions and approval metadata

**Trigger:** a normal standalone browser/mobile turn carries a module tool such as `artifact_delete` while the final policy excludes it, sets plan mode, or requires approval.

**Cause:** [`standalone-tools.ts:71`](../../lib/ai/chat/standalone-tools.ts) accepts only `pluginTools`, `sandboxRuntimeRef` and `toolSurface`; its loop projects all usable entries and calls the renderer executor directly. The resolver's general finalizer narrows `allowedTools`/`disallowedTools` but only special aside branches prune `pluginTools` (`build-options.ts:5121` onward). The ordinary controller passes the resolved options to standalone unchanged (`use-claude-chat-controller.ts:6376`). The `prepareStep` callback asks plugin interceptors about the step; it does not evaluate these per-tool policies. `requestedRuntimeCapabilities` rejects the newer `toolPermissionRules` feature, but does not cover legacy lists, `permissionRuleset`, permission modes or `requiresApproval`.

**Evidence:** probe F4 exercises five separate policies: the real finalizer's deny filter, its nonempty allow filter containing another tool, ruleset deny, plan mode, and `requiresApproval: true` alone. Each leaves `artifact_delete` callable and reaches the substituted effectful executor. Only that executor is substituted; the bridge and installed AI SDK tool definitions are real. No artifact was deleted. `toolSurface: "none"` remains correctly enforced.

**Impact and repair:** browser/mobile standalone can invoke mutations a user excluded or expected to approve. Seal the manifest against the resolved policy and add per-call policy/approval execution; if a policy cannot be honored, refuse the turn explicitly.

### F6 — P1: AI SDK approval rewrites skip hard-authority revalidation

**Trigger:** a permission response approves a tool with `updatedInput` that changes a safe path to a protected credential path.

**Cause:** [`ai-sdk-gate.ts:285`](../../sidecar/src/policy/permission/ai-sdk-gate.ts) returns `decision.updatedInput` immediately. In contrast, [`sdk-can-use-tool.ts:373`](../../sidecar/src/policy/permission/sdk-can-use-tool.ts) re-runs `anthropicToolDenial` on the effective approved input before allowing it. Schema parsing also precedes this rewrite in the AI SDK adapter.

**Evidence:** probe F6 passes a declared-write renderer tool with a safe path through approval, then answers with a fixture path ending in `.ssh/id_rsa`. The AI SDK gate returns the rewritten path. A direct call with that path is correctly denied, and the Anthropic approval route denies the identical rewrite. No effectful handler runs and no credential file is read/written.

**Impact and repair:** an approval/input-edit route can cross authority that the original input passed. Revalidate the effective input against schema and all mandatory authority checks after approval, with matched AI SDK/Anthropic tests.

### F3 — P2: a proxied MCP error is rendered and supplied as success on AI SDK

**Trigger:** a renderer-proxied tool answers `result: { isError: true, content: [...] }` without a top-level transport `error`.

**Cause:** [`ai-sdk.ts:294`](../../sidecar/src/tools/adapters/ai-sdk.ts) only checks the transport `response.error`. It then JSON-encodes a text-only MCP result, or passes rich content through, without converting payload `isError` into a thrown execution failure. The event adapter reads `event.isError`, which successful AI SDK execution does not derive from the nested payload.

**Evidence:** probe F3 returns an error MCP envelope. Execution resolves successfully to a JSON string containing `isError: true`, while the actual event projection produces `is_error: false`. The Anthropic plugin-proxy control preserves `isError: true`.

**Impact and repair:** tool errors can appear successful to transcript/UI/metrics, and model error handling differs by provider. Distinguish a real MCP `CallToolResult.isError` from intentionally structured domain refusals. Do not blanket-convert every `{ ok: false }` domain response into an exception; the dispatcher explicitly documents that separate contract decision.

### F5 — P2: standalone loses cooperative cancellation at tool execution

**Trigger:** stop a standalone turn while its renderer tool is starting or running.

**Cause:** [`standalone-tools.ts:95`](../../lib/ai/chat/standalone-tools.ts) forwards the call ID but omits `options.abortSignal`. The shared dispatcher supports `request.abortSignal`, checks it before execution (`plugin-tool-ipc.ts:404`) and forwards it to web/attachment/module handlers.

**Evidence:** probe F5 calls the actual bridge with an already-aborted signal. Its effectful-executor fixture is still invoked and receives no signal. This is a deterministic boundary failure, not a real network/tool cancellation acceptance run. The standalone engine's provider request still has its own abort signal, so provider cancellation itself is not claimed broken.

**Impact and repair:** stopped turns may leave web fetches or cooperative renderer tasks running. Forward the signal and check it before dispatch; document noncancellable module actions rather than promising to undo completed effects.

## Additional support gaps

1. **Standalone tool-name parity (reproduced, probe G1):** dotted identifiers such as `ocr.extract` are silently removed from the usable map by `VALID_TOOL_NAME`; the sidecar instead uses reversible sanitization. This is a deliberate current implementation with a compatibility cost, not a missing tool registration. Use shared name aliasing and restore original names for dispatch/transcripts. A real provider rejection for the standalone validator's accepted 65-128-character names was not tested.
2. **Standalone budget/result parity (source observation):** the loop hardcodes eight steps instead of consuming the run's unified budget, and its mapper always emits `subtype: "success"`, `is_error: false`, `num_turns: 1`. There is no dedicated exhausted-budget/incomplete continuation state here. Eight steps is documented as a battery/credit policy, so removing the ceiling is a product decision; reporting incomplete work accurately is a separate requirement. Rich MCP results also lack a standalone `toModelOutput` converter; actual model image/audio consumption was not tested.

## Suggested repair order

1. F4 and F2: preserve the final effective policy across standalone and nested Code execution.
2. F1 and F6: normalize tool identity symmetrically and validate post-approval arguments.
3. F3 and F5: unify explicit MCP errors and propagate cooperative cancellation.
4. Address name, budget and multimodal parity with targeted acceptance for the chosen shells/providers.

Each repair should first turn its characterization into a failing behavioral regression against the expected safe behavior, then pass both the direct and nested/provider controls. These probes intentionally assert today's defects; their green status is evidence of reproduction, not evidence of correctness.

## Reproduction and validation

All commands run from repository root through `rtk proxy`. The scripts below are local and make no provider requests.

```sh
node --test docs/evidence/2026-11-08-builtin-agent-tool-support-audit.probes.mjs
node scripts/test/run-sidecar-tests.mjs sidecar/src/tools/adapters/ai-sdk.test.ts sidecar/src/tools/adapters/sdk-mcp-plugin.test.ts sidecar/src/policy/permission/ai-sdk-gate.test.ts sidecar/src/runtimes/ai-sdk/events.test.ts
node scripts/test/run-sidecar-tests.mjs sidecar/src/policy/permission/sdk-can-use-tool.test.ts sidecar/src/policy/permission/ladder.pins.test.ts sidecar/src/tools/middleware/presentation.test.ts sidecar/src/tools/builtin/registry.test.ts
pnpm test --runInBand --runTestsByPath lib/ai/chat/standalone-tools.test.ts lib/ai/chat/standalone-engine.test.ts lib/claude/tool-surface-finalizer.test.ts lib/claude/tool-contributions.test.ts
pnpm test --runInBand --runTestsByPath lib/claude/build-options.test.ts lib/claude/agents/subagents/index.test.ts lib/agent/builtin-catalog/catalog.test.ts lib/claude/adapter.test.ts
```

Results on 2026-11-08: seven probes passed; existing sidecar tests 165 + 45 passed; existing renderer tests 87 + 725 passed, totaling 1,022 baseline tests. Logs and structured probe results are in `.cache/builtin-agent-tool-support-audit/` (`probes.log`, `probes.json`, `sidecar-baseline.log`, `sidecar-authority.log`, `root-baseline.log`, `root-integration.log`). The first F3 probe expected plain text but the actual adapter returned a JSON-encoded MCP envelope; the assertion was corrected to the observed contract before checking error-status loss. No application behavior was changed to pass a probe.

Full repository typecheck/build/lint, coverage, real-provider calls and browser/Tauri/device UI acceptance were not run: this change adds only the audit and its diagnostic artifact. Scoped ESLint completed with zero warnings; Prettier, ledger `check --final` (zero errors/warnings), whitespace and owned-file status checks passed. The final review confirmed that the only task-owned files are this ledger and its probe script, both uncommitted. The ledger remains `verifying` because production findings and environment acceptance remain open; the requested research deliverable is complete.

## Adversarial review follow-up — 2026-11-08

Review contract: the report must distinguish reachable defects from isolated gate behavior, preserve compensating guards in its impact statements, separate intentional constraints from bugs, and check omitted registration/lifecycle/result seams. Six initial findings are claims under review, not an exhaustive inventory.

Three fresh-context read-only reviewers receive source artifacts and the required policy/result/cancellation contracts without the earlier conclusions: native sidecar authorization and Code presentation; standalone execution and installed SDK boundaries; renderer registration/dispatch/result lifecycle. Reviewers may not change business code, send data externally, invoke real providers, or start nested agents. The main session reconciles every candidate against source and deterministic controls. No external-model invocation is authorized.

Additional verification completed: the main session reran all eight durable probes and all three independent scripts against current source. Real installed `generateText`, `streamText`, `convertToModelMessages` and in-memory model fixtures exercise schema, transcript, multimodal and budget boundaries. Existing focused tests on the additional surfaces passed (5 Jest suites/92 tests; 4 sidecar files/137 tests). Source and terminal outputs below carry the limitations of each isolated seam.

Cross-model review was offered under `doubt-driven`; the user answered “跳过，按当前证据出清单”. No external-model CLI was invoked.

### Authoritative reconciled inventory

This table supersedes the initial six-item summary: 16 confirmed issues, six P1 and ten P2. IDs F1-F6 remain stable. Priority refers to repair order and demonstrated consequence; evidence is local current-source/SDK behavior, not a production incident rate or real-device acceptance.

| ID  | Priority | Confirmed problem and trigger                                                                            | Demonstrated consequence                                                                                                                             | Owning source                                                                                                                   |
| --- | -------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| F1  | P1       | Native deny aliases such as Write/Read/Bash are not translated on AI SDK.                                | Equivalent lowercase tools remain exposed and execute; bare-name deny control works.                                                                 | `sidecar/src/tools/adapters/ai-sdk.ts:424`                                                                                      |
| F2  | P1       | Code broker captures enabled definitions before final per-tool filtering and skips nested authorization. | An approved run_code invokes file_info despite allow/deny/ruleset ceilings; one wrapper prompt does not authorize the forbidden inner call.          | `sidecar/src/tools/middleware/presentation.ts:28`, `:46`                                                                        |
| F3  | P2       | Renderer-proxied MCP isError is ignored on AI SDK sidecar and standalone.                                | Execution resolves as success, PostToolUse may receive false, and transcript gets is_error=false.                                                    | `sidecar/src/tools/adapters/ai-sdk.ts:293`; `lib/ai/chat/standalone-tools.ts:110`                                               |
| F4  | P1       | Normal standalone turns ignore final allow/deny, ruleset, permission mode and per-call metadata.         | Excluded or approval-required module tools reach the executor. toolSurface=none and independent plugin consent still work.                           | `lib/ai/chat/standalone-tools.ts:71`                                                                                            |
| F5  | P2       | Standalone omits SDK abortSignal when dispatching a tool.                                                | An already-running cooperative tool receives no signal and can continue after Stop; provider cancellation itself still works.                        | `lib/ai/chat/standalone-tools.ts:95`                                                                                            |
| F6  | P1       | AI SDK returns approval updatedInput without mandatory permission/schema revalidation.                   | Direct protected fixture read is denied, but approval rewrite reads its marker; write-body credential guard control still denies writes.             | `sidecar/src/policy/permission/ai-sdk-gate.ts:285`                                                                              |
| F7  | P2       | JSON Schema manifests become jsonSchema(schema) without a runtime validator on both AI SDK tool bridges. | Actual SDK accepts wrong types/over-limit values and invokes the proxy; Anthropic-converted Zod rejects the same invalid input.                      | `sidecar/src/tools/adapters/ai-sdk.ts:260`; `lib/ai/chat/standalone-tools.ts:94`                                                |
| F8  | P2       | Standalone drops turnId and attemptId from tool calls.                                                   | Normal hybrid progressive Skill load returns stale_context; matching-identity control succeeds.                                                      | `lib/ai/chat/standalone-tools.ts:96`; `lib/skills/runtime-loader.ts:204`                                                        |
| F9  | P1       | Standalone rotates assistant ID after a tool but retains prior text/tool buffers.                        | Real SDK stream duplicates old tc1; next send fails AI_MissingToolResultsError before the model is invoked.                                          | `lib/ai/chat/sdk-event-mapper.ts:605`; `:489`                                                                                   |
| F10 | P1       | Same-name plugin manifest wins composition, but declared built-in module wins dispatch.                  | Advertised schema/description/timeout/owner can name a different tool than the one executed. Approval bypass is not established.                     | `lib/claude/build-options.ts:3695`; `lib/claude/plugin-tool-ipc.ts:409`                                                         |
| F11 | P2       | Ordinary sidecar relay has no host-side cancellation correlation.                                        | Interrupt clears the sidecar pending call while actual ask_user store remains active and host promise unfinished.                                    | `sidecar/src/tools/adapters/ai-sdk.ts:280`; `lib/claude/plugin-tool-dispatch-bridge.ts:40`; `lib/claude/plugin-tool-ipc.ts:604` |
| F12 | P2       | Native MCP plugin proxy requires nonempty content to recognize an MCP envelope.                          | Valid content=[]/isError=true/structuredContent result becomes successful JSON text and loses envelope identity.                                     | `sidecar/src/tools/plugin/proxy.ts:74`; `:243`                                                                                  |
| F13 | P2       | Both AI SDK event shapers preserve structured MCP content only if an image is present.                   | Audio/resource-only outputs become strings, preventing the existing structured audio/resource UI from receiving mcpContent.                          | `sidecar/src/runtimes/ai-sdk/events-payload.ts:17`; `lib/ai/chat/sdk-event-mapper.ts:175`                                       |
| F14 | P2       | Standalone rich MCP results have no toModelOutput converter.                                             | The next actual SDK model prompt carries an image envelope as JSON, not a multimodal content result. Image UI preservation does not compensate.      | `lib/ai/chat/standalone-tools.ts:90`; `:111`                                                                                    |
| F15 | P2       | Standalone termination ignores exhausted-step/truncated-output completion semantics.                     | Eight tool-only steps with no answer, or a length-truncated reply, emit success/is_error=false and num_turns=1.                                      | `lib/ai/chat/standalone-engine.ts:331`; `lib/ai/chat/sdk-event-mapper.ts:877`                                                   |
| F16 | P2       | Final assistant snapshots rebuild tool parts without preserving results already delivered.               | On both AI SDK paths a successful tool becomes input-available again and loses its rendered/persisted output after seal; finish does not restore it. | `lib/claude/adapter.ts:902`; `sidecar/src/runtimes/ai-sdk/events.ts:641`; `lib/ai/chat/sdk-event-mapper.ts:569`                 |

### Additional defect evidence and repair obligations

**F7 — runtime schema validation.** `@ai-sdk/provider-utils@5.0.54`'s `schema.ts:105` makes its validate callback optional; `safeValidateTypes` returns success unchanged when it is absent. The actual `generateText` F7 probe advertises a required string query and integer limit <=2, then receives `{query:123,limit:999,extra:true}` in the proxy. A converted-Zod control rejects it. This is a validation-boundary defect, not proof every handler accepts arbitrary effects: several built-ins validate their arguments again. Add one shared real runtime validator at the manifest boundary and test invalid types, limits, defaults and additional properties on each bridge. Do not treat model-facing JSON Schema alone as host validation.

**F8 — progressive Skill identity.** The ordinary UI defaults to `skillRenderMode: hybrid` (`hooks/chat/claude-chat-send-options.ts:699`); the resolver binds Skill load context with turn/attempt identity (`build-options.ts:5055`). The standalone executor forwards only session/call identity, and the loader's `requireContext` rejects the missing turn/attempt as stale. Fixture output is `code: stale_context`; the same actual loader with matching IDs returns ok=true. Forward the frozen identity fields, retaining stale-context rejection rather than weakening the loader. The broader execution-authority impact of missing IDs remains source-level; Skill loading is the directly demonstrated failure.

**F9 — history corruption.** The independent fixture consumes actual installed SDK stream events for `before -> tool tc1 -> result -> after`, then current mapper/adapter and seal. It produces an original output-available tc1 and a new assistant containing text `beforeafter` plus another tc1 in input-available state. Actual subsequent `streamText` throws `AI_MissingToolResultsError: Tool result is missing for tool call tc1.` with model invocation false. Normal controller standalone history is passed through `providerPayload.messages` without the separate sidecar hydration helper's ignoreIncompleteToolCalls option (`controller:3279-3330`, `:6376`); completed settlement does not repair open tools (`claude-chat-events.ts:174`). The sidecar text-boundary handler already clears its buffers, so the ID-rotation defect is scoped to standalone. Repair by sealing/clearing message-scoped state at boundaries; verify normal tool-text-tool sequences and successful next-turn conversion.

**F10 — discovery/dispatch identity drift.** Plugin registration validates name format and cross-plugin collisions, without reserving all declared host names. The current composition block preserves an existing plugin entry and drops a same-name contributed module entry. The shared dispatcher routes declared module names first. A fixture using the current composition block retains the plugin owner and metadata, while the source-confirmed dispatch would select the module. No actual plugin was installed and no module effect was invoked. Align reserved-name/precedence/owner binding at registration, composition and dispatch. A claim that this necessarily disables per-call approval was rejected: the contribution ruleset and outbound explicit policy can independently compensate.

**F11 — sidecar Stop leaves host interaction alive.** The actual AI plugin adapter starts ask_user with timeout disabled, and the actual question store receives it through the relay's normal fields. Draining pending calls as interrupt does yields `sidecarError: interrupted`, `pendingSidecar: 0`, yet `hostQuestionStillActive: true`, `hostFinished: false`. The shared bridge creates no per-call AbortController/cancel subscription. Direct renderer requests with a signal and conversation-channel-specific signals are separate working paths. Add an explicit correlated cancellation channel or session-scoped host cleanup; test stop, late reply and next question. Do not promise to undo already-completed noncancellable actions.

**F12 — legal empty MCP results.** Installed `CallToolResultSchema.parse` accepts `{content:[],isError:true,structuredContent:{error:failure}}`. The actual native plugin proxy classifies it as a plain value and calls toolText, yielding a text-only success envelope containing JSON. Preserve valid empty MCP envelopes and structuredContent/error identity; nonempty-envelope passthrough already works.

**F13/F14 — multimodal boundaries.** The sidecar `toModelOutput` conversion already maps audio/resource content for the model, but its event shaper reduces audio-only/resource-only payloads to JSON strings; the renderer's `extractMcpContentBlocks` only accepts arrays. Standalone has that projection defect and a separate model-output defect: without toModelOutput the installed SDK encodes the raw MCP object as `output.type: json`. The independent second-model-step fixture demonstrates the JSON shape. Preserve structured nontext blocks independently of whether an image is present, and use a shared provider/model output conversion. No actual vision/audio model or device renderer was exercised.

**F15 — incomplete termination.** In-memory real SDK execution makes eight successive tool calls with no final answer; the engine ends with subtype=success, is_error=false and num_turns=1. A one-step length-truncated fixture gets the same terminal classification. The standalone mapper has no finish-reason/stop-reason preservation equivalent to the sidecar's mapper. The eight-step battery/credit cap is an explicit current trade-off and is not itself classified as a bug; losing the incomplete/truncated state is. Preserve terminal reason, actual steps and an explicit incomplete/continuation contract.

**F16 — final snapshot overwrites completed results.** A bounded follow-up to F9 feeds actual tool-call-only SDK streams through each current event mapper and actual `applySdkEvent`. Both start with `output-available` plus `completed tool output`; after `sealAssistant` they contain `input-available` with no output, and `finish` leaves that state unchanged. The normal sidecar loop emits the tool result at `index.ts:1400` before the final seal at `:1432`; its later internal conversation persistence does not re-emit the result. The seal's completedToolUses list remains nonempty, and `appendAssistantMessage` rebuilds/replaces parts without preserving completed outputs. This differs from F9: it affects both paths without a text-boundary duplicate, while sidecar provider history can remain intact. Preserve completed result state across canonical snapshots or seal before result patching, and test terminal tools, failures, mixed parallel results and persisted replay.

### Reconciliation, exclusions and repair order

- All six original findings remain actionable. F2 is limited to enabled programmatic-read-only tools; category, process-scope and outer wrapper authorization still apply. It is not an OS sandbox escape.
- F6 is stronger than the original gate-only probe: the independent production core-read fixture reads a public marker after a credential-path rewrite. Separate write-body and OS-scope guards remain effective; arbitrary protected writes were not demonstrated.
- F3 explicitly concerns MCP isError. Deliberate domain refusals such as `{ok:false}` remain valid results and must not be blanket-converted to exceptions.
- Same-name manifest/dispatch mismatch is actionable (F10). Universal approval bypass and cross-session Artifact authorization were excluded for lack of a fully established contract and counterexample.
- Dropped dotted standalone tool names remain a confirmed compatibility limitation/trade-off, not an additional newly discovered authorization defect. Name-length rejection by real providers was not tested.
- Full-runtime/browser/Tauri/Android/CLI/provider acceptance remains X1. The list is complete for the findings established in these reviewed surfaces; it is not a proof that unreviewed tools and environments are defect-free.

Repair sequence after this review: first F9/F16 (conversation and result continuity), F4/F2/F1/F6 (effective authority) and F10 (identity consistency); then F8/F7, cancellation F5/F11, explicit MCP errors F3/F12, multimodal F13/F14 and termination F15. Use behavioral regressions against the expected correct behavior; characterization green status only confirms the current defects.

### Follow-up commands and preserved outputs

```sh
node --test docs/evidence/2026-11-08-builtin-agent-tool-support-audit.probes.mjs
node .cache/native-tool-policy-review-20261108.mjs
node .cache/builtin-agent-tool-support-audit/renderer-boundaries-independent-20261108.mjs
node .cache/builtin-agent-tool-support-audit/standalone-review-offline-20261108.mjs
node .cache/builtin-agent-tool-support-audit/standalone-review-offline-20261108.mjs --snapshot-only
pnpm test --runInBand --runTestsByPath lib/ai/chat/sdk-event-mapper.test.ts lib/skills/runtime-loader.test.ts lib/claude/skill-builtin-tools.test.ts lib/claude/plugin-tool-dispatch-bridge.test.ts lib/claude/tool-contributions.test.ts
pnpm --dir sidecar test src/tools/adapters/ai-sdk.test.ts src/tools/plugin/proxy.test.ts src/runtimes/ai-sdk/events.test.ts src/tools/adapters/ai-sdk-output.test.ts
```

Main-session reruns: eight durable probes passed; three independent scripts exited 0; the five-suite Jest run passed all 92 tests. The renderer reviewer ran the four-file sidecar baseline: 137 passed. Logs in `.cache/builtin-agent-tool-support-audit/adversarial-*.log` preserve the following key excerpts; cache files may be pruned, so the evidence is also recorded here:

```text
direct protected read: DENIED; approved rewritten read: PUBLIC_AUDIT_FIXTURE_NO_REAL_CREDENTIAL
approved rewritten credential write: DENIED by tool-body backstop
visible code tools: [ 'run_code' ]
permission prompts: [ 'mcp__cognia-tools__run_code' ]
forbidden nested file_info succeeded: true
SKILL_BRIDGE: { ok:false, code:'stale_context' }; SKILL_MATCHING_ID_CONTROL: true
FOLLOWUP_ERROR AI_MissingToolResultsError Tool result is missing for tool call tc1.
FOLLOWUP_PROVIDER_CALLED false
MODEL_IMAGE_OUTPUT: tool-result.output.type='json'
ask-user-interrupt: pendingSidecar=0, hostQuestionStillActive=true, hostFinished=false
ENGINE_TERMINATION tools: modelCalls=8, subtype='success', is_error=false, num_turns=1
ENGINE_TERMINATION length: modelCalls=1, subtype='success', is_error=false
SNAPSHOT_ONLY standalone: beforeSeal=output-available with output; afterSeal/afterFinish=input-available without output
SNAPSHOT_ONLY sidecar: beforeSeal=output-available with output; afterSeal/afterFinish=input-available without output
```
