# Evidence ledger: context management gap audit

- Status: verifying
- Lane: deep
- Created: 2026-11-17
- Updated: 2026-11-17 (implementation round)
- Related: ADR-0063, ADR-0083, ADR-0250; [assembly probes](./2026-11-17-context-management-gap-audit.probes.mjs), [sidecar probes](./2026-11-17-context-management-gap-audit.sidecar-probes.mjs), [continuity probes](./2026-11-17-context-management-gap-audit.continuity-probes.mjs)

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 帮我分析一下现在的上下文管理的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

Follow-up on 2026-11-17: “做一次对抗性审查”. Reopen the audit against current callers, outer safeguards, production message shapes and counterexamples. Preserve the original evidence and record corrections explicitly.

Implementation request on 2026-11-17: “辩证的看待下面的问题，然后进行确切的修复，如果遇到老代码或者死代码就直接删除” — fix the 11 confirmed defects and the 2 verification-infrastructure problems precisely, judge the 5 capability gaps on their merits, and delete legacy or dead code met on the way.

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                         | State       | Basis                                                                                                                                                                                                             | Depends on  |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| O1  | Context spans module contributions, build-options, sidecar runtimes, memory/RAG and the usage UI.                                 | Observed    | Checked-out source and ADR-0063/0083/0250, 2026-11-17.                                                                                                                                                            | -           |
| H1  | Individually bounded producers may exceed the total request budget when composed.                                                 | Verified    | Collector probe accepts 1,572,864 characters; build-options joins these sections without shared allocation. Downstream compaction/rejection exists; successful real-provider overflow is not claimed. 2026-11-17. | O1          |
| H2  | Safeguards already cover the important failure modes; the main gap may be cross-runtime visibility and acceptance evidence.       | Invalidated | Actual-source probes also reproduce budget bypass, ineffective output capping and multimodal summary omission, 2026-11-17.                                                                                        | O1          |
| G1  | Deliver an implementation-grounded gap assessment, reproducible issues, primary-source comparisons and prioritized next work.     | Agreed      | User's original request, 2026-11-17.                                                                                                                                                                              | -           |
| C1  | Audit only: preserve concurrent work and do not change production code or send private data to a provider.                        | Verified    | Authorized analysis scope and concurrent-tree-safety; local source and synthetic tests only, 2026-11-17.                                                                                                          | -           |
| O2  | Tool-call arguments are omitted from the estimator used by retained-context fit checks.                                           | Verified    | Sidecar probe publishes estimated 35 tokens while retaining 400,000 characters of arguments, 2026-11-17.                                                                                                          | O1          |
| O3  | Text-summary preparation replaces file/image content with placeholders before replacing old active messages.                      | Verified    | Actual createCompactor probe; source markers absent from summary input and resulting active conversation, 2026-11-17.                                                                                             | O1          |
| O4  | Plugin context has no deadline, cancellation input or output size bound.                                                          | Verified    | Actual resolver remains pending for a never-settling provider and accepts 1,048,576 characters, 2026-11-17.                                                                                                       | O1          |
| O5  | Instruction capping keeps earlier low-precedence files; shared loader returns empty off-Tauri without fs injection.               | Verified    | Continuity probes and CLI caller trace; native vendor discovery is separate and unverified, 2026-11-17.                                                                                                           | O1          |
| O6  | Workspace RAG loses chunk locators and merges same-named citations.                                                               | Verified    | Three injected chunks from two same-named files become one persisted source, 2026-11-17.                                                                                                                          | O1          |
| O7  | Fallback context attribution omits assistant prose and object-valued tool output.                                                 | Verified    | Two actual-source synthetic probes with 400,000 characters each, 2026-11-17.                                                                                                                                      | O1          |
| O8  | Tool-result cap does not descend into the canonical text-output object's value.                                                   | Verified    | Production builtinToModelOutput plus capToolResults probe: 4,000 characters unchanged at 100-token cap, 2026-11-17.                                                                                               | O1          |
| O9  | Focused baseline passes coexist with four stale-mock failures and a package-manager setup blocker.                                | Observed    | Sidecar 186 passed; continuity 84 passed; root baseline 72 passed/4 failed; see verification record below, 2026-11-17.                                                                                            | O1          |
| G2  | Challenge the existing assessment and correct overstatement or missing defects.                                                   | Agreed      | User follow-up “做一次对抗性审查”, 2026-11-17.                                                                                                                                                                    | G1          |
| O10 | The original media finding overgeneralized ordinary PDF inputs, and G03 omitted existing Bash offloading.                         | Verified    | Composer dispatch extracts document text; actual Bash preview has spill reference; fresh reviewer source trace and valid PNG control, 2026-11-17.                                                                 | O1          |
| O11 | Plugin context preparation remains pending after caller abort and run timeout; default native overlay disables ambient discovery. | Verified    | AH01 actual public run/launcher/resolver with synthetic host adapters; AH02 actual SDK overlay, 2026-11-17.                                                                                                       | O1          |
| O12 | Explicit scheduled custom skills can be entirely omitted by full-mode budgeting while their declared tools remain granted.        | Verified    | Real resolver and isolated Dexie, two defect cases plus hybrid Composer control; registered scheduler caller trace, 2026-11-17.                                                                                   | O1          |
| O13 | Canonical tool image output is not recognized by the current image projector.                                                     | Verified    | Actual mapper/projector with valid PNG: zero projected images; installed OpenAI Chat converter serializes remaining content as text, 2026-11-17.                                                                  | O1          |
| O14 | Configured summary payload clipping removes the only Bash spill-path reference in the synthetic old result.                       | Verified    | Actual composeBashBody and createCompactor; source path absent from summary input at configured 100-token cap, 2026-11-17.                                                                                        | O1          |
| O15 | SDK growth-yield does not fix argument undercounting and the actual compactor still publishes an uncapped canonical output.       | Verified    | Actual dispatch loop reached second fake model send after growth-yield; compactor retained 4000 characters at 100-token cap, 2026-11-17.                                                                          | O2, O8      |
| G3  | Fix F01–F11 and the two infrastructure problems at their owning seams; record the gaps as follow-up capabilities.                 | Agreed      | User implementation request, 2026-11-17.                                                                                                                                                                          | G2          |
| O16 | After the fixes, the audit's own characterization probes fail at their first defect assertion.                                    | Verified    | sidecar-probes and adversarial-runtime-probes exit 1 on the post-fix tree (e.g. canonical tool images now project), 2026-11-17.                                                                                   | O2, O8, O13 |

## Problem frame

Adversarial re-entry (2026-11-17): assess whether the artifact overstates production reachability, misses existing controls, or omits stronger counterexamples. Source mutations in the shared tree are not ours. No product fixes or real-provider calls are authorized by this follow-up.

Assess the current system (O1), rather than assume context management is absent. Distinguish confirmed source defects, capabilities that are incomplete across runtimes, and acceptance evidence that is missing. The outcome is a reviewable assessment (G1); feature implementation, deployment and real private-provider runs are outside this audit (C1).

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                    |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Host assembly, sidecar runtimes, memory/RAG, persistence, UI and plugin contracts.                             |
| technical    | medium | Existing mechanisms can be traced and tested; external best practice needs current primary sources.            |
| coupling     | high   | Browser/Tauri/Capacitor, external agents and model/provider selection have different context owners.           |
| requirement  | low    | User requests analysis and comparison, not implementation.                                                     |
| verification | high   | Synthetic checks can prove local defects; real-provider retention and cross-shell fidelity remain separate.    |
| risk         | high   | Lost instructions, tool state or provenance can affect long-running agent actions; audit itself is reversible. |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                   | Severity | Source                                                   | Claim                                                                          | Refuted by                                                                                          |
| --- | ------------------------------------------------------------------------------- | -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| R1  | Incorrectly report existing capability as missing.                              | medium   | ADR-0063, ADR-0083, source drift in contribution plan    | Every finding names an owning source and actual consumer.                      | A runtime caller already implements the allegedly missing behavior.                                 |
| R2  | Context budget or compaction loses task-critical information.                   | high     | catalog: runtime behavior; lens:FMEA                     | Budget and retention claims receive deterministic evidence.                    | A synthetic boundary case loses a tool pair, user constraint or required prompt segment.            |
| R3  | Session/provider boundaries apply stale or unauthorized context.                | high     | catalog: external sends; fresh-context continuity review | Continuity claims identify scope and persistence boundaries.                   | A replay/reload/switch uses stale or another session's material.                                    |
| R4  | Industry comparison relies on outdated or secondary claims.                     | medium   | primary-source requirement                               | Recommendations cite retrieved official docs or original research with limits. | The cited source does not support the recommendation or current capability.                         |
| R5  | Existing audit overstates reachable failures or undercredits existing controls. | high     | fresh-reviewer; counterexample lens                      | Each retained finding survives actual caller and boundary review.              | A production transform removes the alleged trigger or an outer guard enforces the promised control. |

## Verification obligations

Adversarial obligations established before the additional probes: V6 challenges existing findings with two fresh reviewers; V7 executes reachable counterexamples and regression characterization; V8 rechecks existing offloading and primary-source recommendation scope. These do not replace V1-V5.

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk           | Method                                                                                          | Independence   | Evidence                                                                                                                                                                                                         | Coverage                                                                                                       | Status  |
| --- | -------------- | ----------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2         | Trace composition, budget and compaction runtime callers.                                       | fresh-reviewer | Independent context_failure_hunt plus current caller inspection confirmed O2/O3/O4/O8.                                                                                                                           | Checked-out tree, not just HEAD or design documents.                                                           | passed  |
| V2  | R2             | Run focused existing tests and synthetic regression probes.                                     | tool           | Three checked-in probe commands exit 0 and reproduce 11 characterization cases; existing suites 186 + 84 + 72 passed, four stale-mock failures disclosed below.                                                  | Synthetic inputs, actual functions; these results characterize defects rather than certify product acceptance. | passed  |
| V3  | R3             | Trace memory/RAG, project context and restart/switch boundaries.                                | fresh-reviewer | Independent context_continuity_review confirmed O5/O6; 7 suites/84 tests passed; mixed-runtime replay/handoff exists.                                                                                            | Source and local tests; no claim that all native vendors load identical instructions.                          | passed  |
| V4  | R4             | Retrieve current primary sources and map practices to current implementation.                   | tool           | Official Anthropic/OpenAI/LangChain pages and Microsoft Research preprint page retrieved on 2026-11-17; links below. Context7 quota exceeded.                                                                    | Mechanism comparisons; third-party benchmark gains are not claimed for Cognia.                                 | passed  |
| V5  | R1, R2, R3     | Long-running real-provider and browser/Tauri/Capacitor acceptance.                              | real-env       | Not executed in this analysis-only task.                                                                                                                                                                         | Genuine retention, task success and cross-shell behavior.                                                      | blocked |
| V6  | R1, R2, R3, R5 | Two bounded fresh-context adversarial reviewers challenge current source and original probes.   | fresh-reviewer | Runtime and host reviews reconciled; F02/F03/F05/G03 scopes corrected and new F09-F11 recorded below.                                                                                                            | Source guards, actual production shapes and bounded synthetic host/runtime evidence.                           | passed  |
| V7  | R2, R5         | Execute counterexamples plus a normal-mode control through the real resolver.                   | tool           | Replayed original 11 cases; 5 new runtime cases, 2 host cases and 3 real-resolver Jest cases completed successfully.                                                                                             | Characterization and positive control; no real provider or actual source stores.                               | passed  |
| V8  | R4, R5         | Check existing offloading/eval infrastructure and the scope of native-provider recommendations. | tool           | Bash spill implementation and existing eval targets inspected; official OpenAI/LangChain/Microsoft pages rechecked on 2026-11-17.                                                                                | Provider-native adoption is optional; no measured quality/performance superiority claimed.                     | passed  |
| V9  | R2, R3, R5     | Regression tests pinning each fix on production shapes, through the real resolver/compactor.    | tool           | Sidecar node --test 412 passed / 2 skipped of 414 after the review round (context, ai-sdk runtime/compaction/index/messages, bash, shared, ai-sdk-output); Jest 518 passed across 20 suites; see 修复记录 below. | Synthetic inputs through actual functions; no real provider, shell or device.                                  | passed  |

## Decisions

Adversarial decision D3 (2026-11-17): `diagnose` the assessment rather than implement product changes, based on G2 and C1. Reopen any finding disproven by an outer production guard; preserve the original probe and explain the changed scope.

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                                               | Action    | Based on                                      | Reversal trigger                                                                           |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| D1  | 2026-11-17 | Use Deep discovery, independent read-only failure hunts, source trace and synthetic tests; do not implement fixes.                                                                                                                     | diagnose  | G1, C1, O1                                    | User asks for implementation or evidence changes the scope.                                |
| D2  | 2026-11-17 | Initial snapshot: report eight defects and five gaps. Reopened by D3; scope and priorities superseded by D4 after adversarial corrections.                                                                                             | diagnose  | G1, C1, O2, O3, O4, O5, O6, O7, O8            | A production guard disproves a counterexample or new user scope requires implementation.   |
| D3  | 2026-11-17 | Reopen the assessment for one bounded adversarial review; preserve original characterization evidence and correct its production scope.                                                                                                | diagnose  | G2, C1, O1                                    | New outer production guards or counterexamples change a finding.                           |
| D4  | 2026-11-17 | Retain the eight findings with corrected scope, add F09-F11, and credit existing Bash/eval infrastructure. Treat native compaction adoption as an option. Complete this bounded review without product changes.                        | diagnose  | G2, C1, O10, O11, O12, O13, O14, O15          | New production safeguards or real-provider acceptance disprove the scoped counterexamples. |
| D5  | 2026-11-17 | Implement F01–F11, X2 and X3 at their owning seams and delete the legacy shapes the defects hid behind; G01, G02, G04, G05 stay capability work for their own ADR-scoped tasks, G03 is closed for Bash output, media and RAG excerpts. | implement | G3, O2, O3, O4, O5, O6, O7, O8, O12, O13, O14 | A regression test or real-provider run shows a fix regressed another context path.         |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                  | From              | Why still open                                                                                                                     | Next action                                                                                | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| X1  | Real-provider retention and cross-shell context acceptance are not established by this audit.                             | V5                | No real-provider/device run in current scope.                                                                                      | Execute a separate synthetic-data acceptance matrix after fixes are selected.              | open   |
| X2  | The default pnpm test/sidecar:test setup does not reach tests in this tree.                                               | O9                | Fixed: `agent-capability-grant` / `agent-composition` gained `node` exports and tsup entries; the linked-package validator passes. | None.                                                                                      | closed |
| X3  | Four existing cache-assembly tests use an outdated memory mock contract.                                                  | O9                | Fixed: the fixture builds its snapshot with the producer's own `buildMemoryContextSnapshot`; 10/10 pass.                           | None.                                                                                      | closed |
| X4  | No measured task-level retention, cache benefit or model/provider equivalence is established here.                        | R2, R3, V5        | Unit/probe results do not measure genuine long-running task success.                                                               | Add the repeated-compaction evaluation matrix specified below.                             | open   |
| X5  | Adversarial review results are reconciled.                                                                                | V6, V7, V8        | Two fresh reviewers, counterexamples and source corrections completed.                                                             | Reopen only on new evidence or implementation scope.                                       | closed |
| X6  | Real-provider visual understanding, native instruction loading and task-level effect remain outside the synthetic review. | V5, O10, O11, O13 | Fake adapters establish wire/control behavior, not semantic vision accuracy or a real vendor session.                              | Real-provider/shell acceptance with synthetic media and projects after fixes are selected. | open   |
| X7  | Plugin context providers still receive no cancellation signal; a late answer is discarded, not stopped.                   | D5                | `PluginContextProviderInput` is a plugin-contract type; adding `signal` invalidates the authoring kit pin (rebuild + publish).     | Add `signal` to the contract in a kit-repin change.                                        | open   |
| X8  | The headless Host loads instruction files only under its workspace roots; ancestors and `~/.cognia/<file>` are not read.  | D5                | Its file reads are root-confined by design; the CLI and desktop read ancestors.                                                    | Accept as the Host's trust boundary, or add a Host-owned global instruction file.          | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                               | How / when measured                                                                             | Result                                                                                         | Status |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| M1  | User receives concrete problems, missing capabilities and prioritized work against industry sources. | Review this audit artifact against G1 on 2026-11-17.                                            | Eight defects, five gaps, source comparison and prioritized acceptance criteria recorded.      | met    |
| M2  | User receives a corrected assessment that identifies what survived challenge and what changed.       | Reconciled independent findings and 10 additional characterization/control cases on 2026-11-17. | Three new defects; production scope corrections; originals rerun; no product changes.          | met    |
| M3  | The confirmed defects no longer reproduce and each fix is pinned by a regression test.               | Focused suites and the audit's own probes on the post-fix tree, 2026-11-17.                     | 11 defects + 2 infra fixed; probes fail at their defect assertions; gaps G01/G02/G04/G05 open. | met    |

## 审计结论（2026-11-17）

当前上下文管理已经有较完整的功能骨架。主要缺口集中在 **跨模块统一预算、压缩的证据保真、跨运行时一致性，以及可解释的降级与验收**。初审确认 8 项缺陷；本轮对抗审查修订适用范围并新增 3 项，当前共 11 项缺陷，另列 5 项能力或验证缺口（详见文末复核）；没有修改产品源码、提交代码或调用真实模型。

审计对象是当日实际 working tree，包含其他会话的并行改动。结论代表下面标明的源码路径和合成场景，不代表生产故障发生率或所有 provider 的验收结果。P1 表示建议优先修复的可靠性问题；P2 表示受条件约束的正确性或可观测性问题。

### 已有能力：应当继续复用

- `lib/claude/build-options.ts` 已统一组装 agent/persona、harness、项目指令、skills、模块 context、goal/plan、working set 等段落；支持稳定前缀与动态尾部，且工具集合排序以改善缓存复用。
- `lib/ai/agent/execution/contributions/context-contributions.ts` 已有模块注册、依赖次序、deadline、PII gate、来源旁路输出和会话工具状态。它与插件 Agent SDK 的 context provider 是不同路径，保障程度不同。
- `sidecar/src/runtimes/ai-sdk/compaction.ts` 已有自动/手动压缩、后台准备、摘要预算、tool-call/result 配对、候选发布校验、结构化 progress checkpoint、增量合并和已有事实保留。不能把这些列为完全缺失。
- Memory recall、project continuity、Project RAG 和 Agent KB 已接入真实发送路径；working set、加密 compaction checkpoint、undo、post-compaction recovery、附件重读工具及 mixed-runtime replay/handoff 已存在。
- Bash 已有完整输出的磁盘 spill、head/tail preview 和 read 指引（`sidecar/src/tools/builtin/core-files/bash.ts:310-335,497-533`）；现有 eval 靶标、trace/replay 和 benchmark 基础设施也应复用。
- 上下文 UI 已区分 SDK 实测与估算来源；存在来源面板和使用量分解。问题在于估算完整性及跨 runtime 的统一程度。

### 确认的问题

| ID / 优先级 | 问题与触发条件                                                                 | 当前证据                                                                                                                                                                                                                                          | 影响与建议                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 / P1    | 工具调用的 `input/args` 未计入压缩保留区估算。                                 | `sidecar/src/context/compaction.ts:88-117`；该估算进入 runtime `compaction.ts:1470-1483` 发布校验及 `index.ts:1285` 发送前检查。探针在 window=1000、target=500 时仍发布候选，估算 35 tokens，却保留 400,000 字符参数。                            | 压缩后仍可能超窗；旧 usage 校准不能准确覆盖新增长参数。统一统计实际 wire 中的参数、schema、媒体及 framing，并保留输出/推理预算。真实 provider token 数未测量。        |
| F02 / P1    | 未被正文提取或 OCR 覆盖的旧原始媒体在摘要中退化为占位符。                      | runtime compaction.ts:196-199；有效 PNG 经实际 toAiSdkUserContent 转成 file 后，二进制未进入摘要且退出活动上下文。并列提取文本仍进入摘要。                                                                                                        | 范围修正：普通 Composer PDF 已在 attachments/dispatch.ts:683-707 提取成文本，不能笼统说 PDF 正文丢失。应保留视觉证据/稳定媒体引用；附件文本读取不等于二进制视觉恢复。 |
| F03 / P1    | 插件 context provider 挂起且无取消/大小预算，阻塞 SDK 运行准备。               | context-providers.ts:45-67；run.ts:383/462。AH01 在 timeoutMs=5、caller abort 后 40ms 仍未结算，execution row 仍 running、ownership/stop registration 保持；没有模型调用。                                                                        | BackgroundAgentManager 可立即结算 Job Center 条目，不能把 UI 条目状态与底层运行释放混为一谈。修复准备阶段的取消竞争、deadline 和输出预算。                            |
| F04 / P2    | 指令数量上限优先保留低优先级文件，丢弃更近目录和 extras。                      | `lib/agents/instructions/discover.ts:146-176` 由低到高排序；`render.ts:30` 保留前 maxFiles 项；`build-options.ts:2576` 不消费 warnings。maxFiles=2 的探针丢掉 sub/AGENTS.md 的覆盖规则。默认 maxFiles=50。                                        | 预算裁剪应先保留高优先级规则，再按原优先级顺序呈现；指令丢弃必须可见。                                                                                                |
| F05 / P2    | 共享指令加载器在 CLI/headless 下静默返回空，默认 native overlay 也不自动补偿。 | load.ts:163；build-options.ts:2571 未注入 fs；cli session-context.ts:339 共用 resolver。AH02 证明 sdk-options.ts:648-655 在 nested 配置缺省时清空 settingSources/skills；:699-702 对没有 local-content opt-in 的已提供配置同样清空。              | 为有本地磁盘的 Host 注入 filesystem port，并验证 native 显式 opt-in 的来源和信任边界。第三方 external agents 的自行发现、实际 vendor session 仍需另验。               |
| F06 / P2    | Project RAG 丢失 chunk/版本/位置，并把同名文件证据合并。                       | `apply-project-context.ts:79-85` 去掉 chunk id、generation、offset/hash；`lib/chat/sdk-message-adapter.ts:1951` 生成文件级引用；`lib/chat/citations.ts:127` 按 url 或 title 去重。3 个 chunk、2 个同名文件均进入 prompt，但只持久化 1 条 source。 | 无法稳定定位答案依据、识别旧版本和重读正确范围。复用 Agent KB 已有的 locator 结构，按资源+版本+chunk 标识去重。                                                       |
| F07 / P2    | 非 SDK fallback 的来源占比遗漏 assistant 正文和对象形态工具结果。              | `lib/analysis/context-source-breakdown.ts:67-83`；400,000 字符 assistant 正文归因 0 tokens；同样大小的对象工具输出与空对象归因相同。                                                                                                              | 来源占比会误导排查与优化。保留估算标签，同时补齐序列化形态和无法归因的部分。这不等于 SDK 实测占用或计费统计错误。                                                     |
| F08 / P1    | `maxToolResultTokens` 未处理生产 mapper 的 `{type:"text", value:...}`。        | `sidecar/src/tools/adapters/ai-sdk-output.ts:88` 产生该结构；`context/tool-result-cap.ts:69-97` 只处理字符串/数组；runtime `compaction.ts:1407` 调用 cap。实际 mapper 的 4,000 字符输出在 100-token 上限下原样通过。                              | 常见工具输出没有受到配置承诺的压缩上限约束。按统一 typed output 结构遍历并预算；覆盖 text/json/content 及多块结果，保留可恢复的原文引用。                             |

### 还缺的功能或工程闭环

| ID  | 缺口                                                                     | 现状边界                                                                                                                                                                                                               | 建议验收                                                                                                                                                     |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G01 | 按最终请求统一分配上下文预算。                                           | 各模块有自己的 topK、字节或 token 限额，发送/compaction 也有检查；但 collector 和 build-options 没有按同一个输入预算分配全部来源。合成 collector 接受 1,572,864 字符。该探针证明缺少分配，不证明所有下游都会发送成功。 | `system + instructions + tools + memory/RAG + history + media + output reserve` 合计可解释；必需规则先预留，检索等按优先级降级；无法容纳时给出明确阻断原因。 |
| G02 | 每次发送的上下文收据与一致的取消协议。                                   | collector 的 skipped 只进日志和返回值，build-options 不透出 skipped；instruction warnings 同样未被消费。Promise.race deadline 后，producer 仍继续运行，探针已观察到。                                                  | 可检查每段来源/版本、token、纳入或排除原因、超时/PII/裁剪状态；同一 signal 贯穿检索、插件和准备阶段。无需把敏感原文另存日志。                                |
| G03 | 可恢复的大输入/结果与历史引用需要统一覆盖和保真。                        | 已有附件重读、transcript、optical archive、working set，也已有 Bash 磁盘 spill 和 head/tail preview/read 路径。缺口是不同来源覆盖不一致，以及后续 summary clipping 会删除现有读回引用（F11）。                         | 复用已有 offloading；每次裁剪保留受权限约束的稳定 source ref、版本和按范围读取；跨压缩/重启仍能取回指定证据。                                                |
| G04 | 按 runtime/provider 明示上下文所有权与迁移边界；原生压缩接入是可选扩展。 | 已有自有 compaction、native/external 所有权及 mixed-runtime replay/handoff。未找到已查 generic adapter 的原生 compaction/context-editing 统一映射；该缺省本身不构成必须修复的 bug。                                    | 支持的原生块通过 adapter 保真；跨 provider 的可移植 handoff 和损失回执必须清楚。是否接入原生压缩应由目标模型支持、隐私/锁定成本和任务评测决定。              |
| G05 | 重复压缩需要可执行任务级验收与跨 runtime/三端报告。                      | 已有 lib/ai/eval targets、trace/replay、benchmark 基础设施及 focused compaction tests；未找到本次关心的 repeated-compaction 保真任务集和结果报告。不是没有 eval 系统。                                                 | 复用现有 eval 靶标；固定 trace 比较约束、纠错、证据重读、工具状态、任务完成、成本、延迟和缓存复用；按 runtime 与 shell 分别报告。                            |

### 与业内实践的对应关系

以下是可借鉴的具体机制，不是把某个厂商的默认阈值直接当成 Cognia 标准。资料检索日期为 2026-11-17。

| 实践 / 一手来源                                                                                                                                                                                                        | 对 Cognia 的判断                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Anthropic：Context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 强调按需取回、结构化笔记、压缩及隔离工作上下文。                                                   | Cognia 的 working set、progress checkpoint、skills 渐进加载和 handoff 已对齐方向。应补的是精确引用、裁剪后的读回和真实任务保真测量。   |
| [Claude：Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) 以结构化完整输入统计 system、tools、images、PDF。                                                                       | F01/F08 表明当前不同模块理解的消息结构不一致。应统一 typed wire 计量，结合 provider 实测校准；不能把文本 char/4 当作所有形态的硬预算。 |
| [Claude：Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) 提供工具结果清理、保留数量和排除项。                                                                                  | Cognia 已有裁剪/压缩，但需要保留关键工具的可配置规则及效果回执，避免所有结果按同一种方式处理；原生支持应通过能力协商接入。             |
| [Claude：Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 要求缓存段精确匹配，tools/system/messages 的变化会影响后续缓存。                                                        | 稳定前缀、动态尾部、工具排序是已有优点。下一步测量实际 hit/miss 与压缩后的缓存复用，证明收益；token 压缩率不能替代缓存或总成本指标。   |
| [OpenAI：Compaction](https://developers.openai.com/api/docs/guides/compaction) 支持服务器压缩及显式 compact；返回 opaque/encrypted 状态，显式 compact 输出整体作为后续 canonical window。                              | 通用文本摘要和 provider-native 状态应分别建模。接入时保留原生块的整体性；跨 provider 迁移需要清晰的可移植状态和损失边界。              |
| [LangChain Deep Agents：How to remember](https://www.langchain.com/blog/context-engineering-deep-agents-remember)，2026-10-14，组合 offloading、recoverable summarization、按需 skills、subagents、长期记忆。          | 最值得补的是 G03：在进入窗口之前控制体积，并使摘要/裁剪内容可以按引用取回。已有附件工具可复用，但需要覆盖普通工具结果与历史。          |
| [Microsoft Research：CompactionBench](https://www.microsoft.com/en-us/research/publication/benchmarking-long-horizon-agent-context-compaction-with-compactionbench/)，2026-11 预印本，将重复压缩与可执行任务评估结合。 | 用任务成功、重复压缩和缓存/时延一起验收 G05。该论文的机制和测量方法可借鉴，其报告的收益不代表 Cognia 已取得同样结果。                  |

### 建议实施顺序及验收条件

1. **首先修复 F01/F08/F03。** 用真实工具 wire 形态覆盖参数和输出；大结果无法绕过上限；永不完成的 provider 能超时、取消且不阻塞运行终结。随后处理 F02，为媒体证据设置可恢复的保留策略。
2. **接着统一 G01/G02，并修复 F04/F05。** 所有段落共享最终预算，规则截断遵守优先级；桌面与有磁盘的 headless Host 加载行为有对照测试；排除或降级会出现在上下文收据中。
3. **补齐 G03、F06/F07。** 存储 chunk/version/offset、统一大结果引用和读回，修正来源归因；验证同名文件、更新后的文档和压缩后的重读。
4. **扩展现有 eval 基础设施完成 G05，再根据实测决定 G04 的可选接入。** 场景至少包括：纠正旧事实、必须保留的限制、很长 write/edit 参数、结构化结果、多模态证据、连续三次压缩、provider/runtime 切换、重启恢复、取消，以及 source 被撤销或版本变化。逐项报告保留率、任务结果和成本时延。

### 验证记录与边界

环境：macOS / Apple Silicon，Node.js v26.12.1；读取当前工作树；全部探针使用合成数据和替代 provider/文件系统边界，无真实模型请求。

可重跑的 characterization probes（exit 0 表示成功复现当前行为，不表示产品正确）：

```sh
rtk proxy node docs/evidence/2026-11-17-context-management-gap-audit.probes.mjs
rtk proxy node docs/evidence/2026-11-17-context-management-gap-audit.sidecar-probes.mjs
rtk proxy node docs/evidence/2026-11-17-context-management-gap-audit.continuity-probes.mjs
```

三份脚本分别执行 4、4、3 项 characterization，共 11 项。部分 probe 为隔离浏览器/store 启动而转译实际源码、注入 registry/fs/retrieval；sidecar 压缩探针直接运行当前 `createCompactor`。它们不代替真实 provider 或产品 UI 验收。

已执行的现有测试：

```sh
rtk proxy node scripts/test/run-sidecar-tests.mjs sidecar/src/context/compaction.test.ts sidecar/src/context/strategies.test.ts sidecar/src/context/tool-message-pairing.test.ts sidecar/src/context/tool-result-cap.test.ts sidecar/src/context/progress-checkpoint.test.ts sidecar/src/runtimes/ai-sdk/compaction.test.ts
# 186 passed, 0 failed, 0 skipped

rtk proxy node scripts/test/jest.mjs --runInBand --runTestsByPath lib/agents/instructions/render.test.ts lib/agents/instructions/discover.test.ts lib/agents/instructions/load.test.ts lib/project-knowledge/context.test.ts lib/memory/context.test.ts lib/chat/turn-route/history.test.ts lib/chat/handoff-context.test.ts
# 7 suites passed, 84 tests passed

rtk proxy pnpm --config.verifyDepsBeforeRun=false test --runInBand --runTestsByPath lib/analysis/context-source-breakdown.test.ts lib/usage/context-breakdown.test.ts lib/ai/agent/execution/contributions/context-contributions.test.ts lib/claude/build-options-cache-opt.test.ts lib/rag/compaction-runtime.test.ts lib/chat/compaction-undo.test.ts
# 5 suites passed, 1 failed; 72 tests passed, 4 failed
```

最后一组的 4 个失败均在 `build-options-cache-opt.test.ts`：旧 mock 缺少 `snapshot`，当前 `lib/memory/context.ts` 读取 `result.snapshot.memoryRefs`，日志为 `Cannot read properties of undefined (reading 'memoryRefs')`。真实 producer 的正常/降级出口都构造 snapshot（`packages/memory/src/runtime/apply-memory-context.ts:290-306`）；因此这里记录为测试契约漂移，不据此判定生产召回失败。

直接 `pnpm test` / `pnpm sidecar:test` 在到达测试前触发 pnpm 11 的依赖检查和 postinstall，报错 `@cognia/agent-config-types/agent-capability-grant resolves to .../src/agent-capability-grant.ts`、`agent-composition resolves to .../src/agent-composition.ts`，随后要求 compiled JS `node` export 和 tsup entry。本次使用同一仓库 runner 或禁用自动依赖安装的配置完成 focused tests；没有修复或绕过测试断言。

未执行：真实模型长会话、真实媒体理解、三端 UI/native E2E、配对设备、生产性能与故障率测量，以及全仓 lint/typecheck/build。本次只新增证据文档和探针，不据此声称上述验收通过。账本保留 `verifying`，用于承接这些残余风险；分析交付已经完成。

## 对抗性复核（2026-11-17）

本轮以初审报告和原有探针为被审查对象，使用两位 fresh-context reviewer 分别挑战 runtime 与 host 边界；主会话检查显式 skills、既有 offloading/eval 和一手资料的推荐边界。没有让 reviewer 读取主会话的论证过程，没有修改产品实现。

结论：初审 8 项没有被整体证伪，但 **F02 的 PDF 表述、F03 的取消影响、F05 的 native 保留意见以及 G03/G04/G05 的能力描述需要修正**。另新增 F09/F10/F11 三项具体缺陷。当前总计 11 项缺陷、5 项能力或验证缺口；优先级是修复建议，不是已测量的生产发生率。

### 初审结论如何经受挑战

| 对象    | 对抗假设 / 分类                                                                               | 核查结果与修订                                                                                                                                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01     | “SDK 的增长检测/yield 会在下一次发送前阻断”——misread/noise。                                  | 实际 `dispatchAiSdk` 探针中，增长保护确实触发，第二次 fake model send 仍到达：window=16000，估算=14000，序列化=76284 字符，其中新参数 20000 字符、结果 24000 字符。说明外围保护没有消除漏计；字符数不是真实 provider token 数。                                                                      |
| F02     | “原探针代表普通 Composer PDF”——valid/actionable，必须收窄。                                   | `lib/chat/attachments/dispatch.ts:683-707` 将普通 PDF/文档提取成文本，`:750-788` 为大文档提供 assetId 和定位摘录；`:842` 附近加入可用 OCR。新探针使用有效 PNG 和实际 `toAiSdkUserContent`：并列提取文本进入摘要，二进制图片不进入。原始 PDF fixture 只证明函数边界，不证明常规 PDF 内容普遍丢失。    |
| F03     | “外层 abort/timeout 会终结 provider 等待”——misread/noise；“Job Center 无法取消”——范围不成立。 | AH01 经实际 public `runPluginAgent`、child launcher、resolver 和 guardrails：timeoutMs=5、caller abort 后 40ms，Promise 未终结、execution row 为 running，ownership 和 stop registration 仍保持，modelCalls=0。但 `background-agent-manager.ts:128-134` 能先结算可见条目；已区分 UI 状态与底层释放。 |
| F04     | “数量裁剪按优先级保留”——未成立。                                                              | 原探针重跑仍保留 global/root，丢弃 sub 覆盖；默认阈值 50 和配置触发条件继续保留。                                                                                                                                                                                                                    |
| F05     | “默认 native SDK 会自动补上 headless 指令”——misread/noise。                                   | `claude-agent-sdk/options.ts:495` 总会应用 overlay；`sdk-options.ts:648-655` 在 nested SDK 配置缺省时设置 settingSources=[]、skills=[]，AH02 复现；nested 已提供但没有 local-content opt-in 时，:699-702 也会清空。第三方 external agent 和显式 opt-in 的实际 vendor 会话仍未验收。                  |
| F06     | “只是有意做文件级引用聚合”——不足以解释不同文件混并。                                          | 两个同名、不同 fileId 的来源仍按 title 合为一个；并且已存储的 generation/offset/hash 在上游被丢弃。原探针重跑结果不变。                                                                                                                                                                              |
| F07     | “归因 0 意味着 UI 总占用 0”——noise，审计没有据此推导总量。                                    | `context-breakdown.ts:336-348` 仍接收并保留外部 usedTokens，比例分母明确是 attributed。问题限定在来源归因，继续不扩大到实测占用或计费。                                                                                                                                                              |
| F08     | “只在孤立 cap helper 中失败，实际 compactor 会处理”——misread/noise。                          | 新探针直接运行实际 compactor；候选已发布，配置 100-token cap 的 canonical 工具结果仍保留 4000 字符。该配置默认 0（关闭），影响限定为启用该上限的运行。                                                                                                                                               |
| G01/G04 | “缺少共享 allocator/原生压缩映射就是发送必然超窗或架构错误”——valid trade-off，不能这样推断。  | 已有下游 compaction、预算检查和拒绝路径。统一预算分配是可解释降级能力；原生压缩接入是可选方案，应以支持矩阵、隐私/可移植性和任务实测决定。                                                                                                                                                           |
| G03/G05 | “尚无普通工具 offloading / 尚无 eval”——valid/actionable，原描述不完整。                       | 已补记 Bash spill/readback，以及现有 eval targets/trace/replay；缺口收窄为覆盖和引用保真，以及重复压缩任务集/验收报告。                                                                                                                                                                              |

### 新增的具体缺陷

| ID / 优先级 | 可达路径、证据与影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 验证边界 / 建议                                                                                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F09 / P1    | **定时执行自定义 skill 时，主体可能完全没进入 prompt，工具却继续授予。** `lib/scheduler/executors/index.ts:1343-1354` 的 skill executor，经 `:777-790` 将 skillId 作为 ephemeralSkillIds 传入，却省略 skillRenderMode，落到 full 分支。`build-options.ts:2587-2631` 固定 4000-token budget、没有 protectedIds；`lib/db/skills.ts:624-636` 整体省略装不下的主体，`:1819-1829` 又把显式条目放在隐式条目后；后续仍按原技能授予工具。实际 resolver 探针确认：短显式 skill 被较长隐式 skill 挤掉，以及单个 17000 字符的 scheduled skill 主体全丢；Bash 仍在 allowedTools。         | 两个缺陷 case 通过真实 resolver 和隔离 Dexie 复现；没有执行真实定时任务/model。普通 Composer 在 `agent-chat-send-options.ts:859` 使用 hybrid，正向对照保留同一显式主体，不能把问题扩大到所有 Composer。建议显式技能优先预算，无法加载时明确失败/降级，并统一实际加载状态、usage 和工具授予。 |
| F10 / P1    | **canonical 工具图片没有进入现有图片投影路径。** `sidecar/src/tools/adapters/ai-sdk-output.ts:72-80,94-97` 产生 `content → file + data:{type:"data",data}`；`runtimes/ai-sdk/messages.ts:127-133,167-172` 只识别旧 image-data/file-data/media。实际 mapper+projector 使用有效 1×1 PNG：raw MCP 图片可识别，canonical 图片不可识别，投影图片数=0。`index.ts:1684` 在真实 responseMessages 边界调用该 projector；当前安装的 OpenAI Chat converter（`node_modules/@ai-sdk/openai/src/chat/convert-to-openai-chat-messages.ts:378-380`）将遗留 content 作为工具文本 JSON 序列化。 | 已证明本地消息形态和转译路径错误，未调用视觉模型。影响限定到 OpenAI Chat 等依赖图片转 user-message 投影的路径，不概括所有 provider。建议统一 canonical 媒体结构，并以真实 mapper → responseMessages → projector → provider wire 的契约覆盖验证。                                             |
| F11 / P2    | **已有 Bash spill 的读回路径会被摘要输入裁剪删除。** `core-files/bash.ts:310-335` 把完整日志路径放在 head/tail preview 中间；runtime `compaction.ts:136-140,244-253` 按配置对工具 payload 保留头尾，删掉中间。实际 `composeBashBody` → mapper → compactor 探针确认：原 preview 有 `/tmp/synthetic-audit-output.log`，配置 maxToolResultTokens=100 后摘要模型的输入没有该路径。                                                                                                                                                                                                | 没有创建真实 spill 文件；证明的是引用在摘要输入中丢失，不是磁盘文件被删除。只有引用未被其他消息独立保留且结果被选中摘要时才影响恢复。该上限默认关闭。建议把 source ref 作为受保护元数据保留，不依赖从裁剪正文猜回路径。                                                                      |

### 本轮新增验证

```sh
rtk proxy node docs/evidence/2026-11-17-context-management-gap-audit.adversarial-probes.mjs
# 3 Jest cases passed: full 显式 skill 遗失、scheduler 默认 full 遗失、Composer hybrid 正向对照。

rtk proxy node docs/evidence/2026-11-17-context-management-gap-audit.adversarial-runtime-probes.mjs
# 5 runtime characterization cases completed, exit 0。

rtk proxy node docs/evidence/2026-11-17-context-management-gap-audit.adversarial-host-probes.mjs
# 2 host characterization cases completed, exit 0。
```

共新增执行 10 项 characterization/control，初审三份脚本的 11 项也已在本轮重跑。新探针分别使用实际 resolver+隔离 Dexie、实际 sidecar dispatch/compactor、转译的 public plugin run+launcher+context resolver；journal/authority/ownership/背景管理适配器为合成边界，未将其表示为真实 Host/native E2E。增长探针的 streamText 和摘要 adapter 均为本地替代，没有任何模型请求。

初审记录的 342 passed / 4 stale-mock failures 是上一轮的 focused suite 结果；本轮没有重跑这些完整套件，也没有据此宣称失败已经修复。此次只增加证据脚本并修订本账本。

复核后的修复顺序：优先处理 F01/F08 的 typed 计量/上限、F03 的准备阶段释放、F09 的 scheduled skill 交付和 F10 的工具媒体 wire；随后补 F02/F11 的证据保留与读回，修复指令和引用问题，再扩展现有 eval。G04 原生压缩接入保留为经实测选择的方案。

跨模型边界：按 `doubt-driven` 的要求已向用户提供可选追加审查；本轮执行的是同模型 fresh-context 审查，未调用外部 Codex/Gemini CLI。真实 provider、native shell、三端任务保真和生产发生率继续属于 X1/X4/X6 的未验证范围。

## 修复记录（2026-11-17）

本轮按 D5 实施。辩证处理原则：缺陷在其所属接缝处修复；被缺陷掩盖的旧形态分支（只对旧 SDK 形态生效、生产形态从未命中）直接删除；能力缺口只在与缺陷同一接缝时一并补齐，其余作为独立任务。

| ID  | 修复                                                                                                                                                                                                                                                                                                                       | 删除的旧代码 / 死代码                                                                                  | 回归测试                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| F01 | `estimateTokens` 按 AI SDK 类型计量：`tool-call.input`、`text/json/error/content/execution-denied` 输出；图片按头部像素 `w·h/750`（上限 1600，未知尺寸按上限），音视频按时长等价字节（500 字节/token），其他文件按页面等价字节（32 字节/token，至少一张图）。新增 `shared/media/image-size.ts` 读取 PNG/GIF/WebP/JPEG 头。 | 旧 `textLength`/`toolBodyLength`（读 `output ?? result ?? content`，漏 `input`）。                     | `context/compaction.test.ts`、`shared/media/image-size.test.ts`                     |
| F02 | 压缩时把被摘要部分中最新的图片（≤4 张，且受剩余保留预算约束）作为冻结的 `media="1"` 消息放在摘要/光学归档后；再生成摘要时从旧保留消息中重新收集；摘要输入只写 `[image]` 占位，不再混入 base64。                                                                                                                            | —                                                                                                      | `runtimes/ai-sdk/compaction.test.ts`（保留 + 再生成）、`context/compaction.test.ts` |
| F03 | `resolveContextContributions` 单 provider 5 s 截止、运行信号中止即以其原因拒绝、单个 16 000 / 合计 32 000 字符预算（超出整段省略），每次省略记日志；`run.ts` 传入 runSignal。                                                                                                                                              | —                                                                                                      | `context-providers.test.ts`、`run.test.ts`（挂起 provider + 调用方取消）            |
| F04 | 超过 `maxFiles` 时保留优先级最高的尾部文件；发送路径记录 warnings。                                                                                                                                                                                                                                                        | —                                                                                                      | `render.test.ts`                                                                    |
| F05 | `BuildOptionsContext.instructionsHost`（CLI 注入 Node fs + home）；无头 Host 走受根目录约束的工作区读取；无文件系统时返回 `NO_INSTRUCTION_FS_WARNING`。                                                                                                                                                                    | —                                                                                                      | `load.test.ts`、`cli/src/config/to-build-context.test.ts`（真实 Node fs）           |
| F06 | 摘录携带 `chunkId/generationId/contentHash/charStart/charEnd/projectId`；提示词标注字符范围并区分同名文件；来源按 chunk 建 id 并持久化 `projectKnowledgeRef`；`mergeSources` 按 `url` 或 `origin:id` 去重；compaction 引用与 grounding 用 chunk 标识和版本。                                                               | sdk-message-adapter 中重复的 `ProjectKnowledgeSourcesContext` 类型（改用 `types/project-knowledge`）。 | `apply-project-context.test.ts`、`sdk-message-adapter.test.ts`、`citations.test.ts` |
| F07 | 新增 `assistantMessages` 来源（含 i18n）；工具输入/输出按序列化长度计；识别 `dynamic-tool`。                                                                                                                                                                                                                               | —                                                                                                      | `context-source-breakdown.test.ts`、`context-detail-panel.test.tsx`                 |
| F08 | `capToolResults` 按 typed output 截断（json 截断后转 text，error 保持 error 类型，content 只截文本、媒体不动），截断保留可恢复引用。                                                                                                                                                                                       | 只覆盖 `role:"tool"` 字符串、`tool_result`、`result/content` 字段的旧分支及其测试。                    | `tool-result-cap.test.ts`（生产 mapper 输出）、compactor 发布测试                   |
| F09 | full 模式下点名技能整段交付、不受 4 000 token 上限；上限只决定 agent 自带技能；被省略的技能撤回工具授予与 usage 计数。                                                                                                                                                                                                     | —                                                                                                      | `build-options-skill-delivery.test.ts`（含 scheduler 调用形态、hybrid 对照）        |
| F10 | 投影器识别规范 `file` + `{type:"data"/"url"}` 图片（含 `mediaType:"image"`），投影为 user `file` 部件；provider reference 不投影。                                                                                                                                                                                         | `image-data`/`file-data`/`media` 旧变体分支及只测旧变体的测试。                                        | `runtimes/ai-sdk/index.test.ts`（真实 mapper → projector）                          |
| F11 | 新增 `shared/text/recoverable-ref.ts` 固定引用格式；Bash 把引用放在首行；`clipPayload` 与 `capToolResults` 截断后只补回首行声明的引用（输出正文里的同形行是不受信数据，照常截断）。                                                                                                                                        | —                                                                                                      | `recoverable-ref.test.ts`、`bash.test.ts`、compactor 摘要输入测试                   |
| X2  | 见残余风险 X2。                                                                                                                                                                                                                                                                                                            | —                                                                                                      | `build-sidecar-linked-packages.mjs` 通过                                            |
| X3  | 见残余风险 X3。                                                                                                                                                                                                                                                                                                            | —                                                                                                      | `build-options-cache-opt.test.ts` 10/10                                             |

另删除只被测试引用的死代码：`applyCompaction`、`applyCompactionIncremental`、`applyCompactionRegenerated`、`isOpticalMessage`、`CompactionPlan.head`，以及摘要渲染中的 `tool_use`/`tool_result`/`redacted-reasoning`/`args`/`name` 旧形态分支。

### 能力缺口的处理

- **G03** 在本轮接缝内补齐：Bash spill 引用跨裁剪保留、图片跨压缩与再生成保留、RAG 摘录持久化精确定位。其余来源（普通工具结果的自动 offloading）仍未覆盖。
- **G01 / G02** 是跨模块的预算分配器与上下文收据协议，需要 ADR 与界面设计，本轮不实施；本轮修复让它们依赖的计量（F01/F08）和取消（F03）先变正确。
- **G04** 属于支持矩阵与可选的原生压缩接入，没有缺陷待修。
- **G05** 需要固定任务集与真实 provider 运行，属于独立评测任务。

### 本轮验证

```sh
node scripts/test/run-sidecar-tests.mjs <context, shared, ai-sdk compaction/index, bash, optical, tool-result-cap, strategies, pairing, progress-checkpoint, ai-sdk-output>
# 修复后复核轮重跑：414 tests: 412 passed, 0 failed, 2 skipped（分批运行；一次跑全部会被系统内存回收）
node scripts/test/jest.mjs --runInBand --runTestsByPath <20 suites: context-providers, run, instructions render/load/discover, build-options skill-delivery/cache-opt/harness, CLI to-build-context, project-knowledge, citations, sdk-message-adapter, rag grounding/compaction-runtime, context breakdowns, context-detail-panel, compaction parity, safe-send-prompt>
# 20 suites, 518 passed
node scripts/build/build-sidecar-linked-packages.mjs
# ok (… agent-config-types/agent-capability-grant, agent-config-types/agent-composition …)
```

### 修复后复核（fresh-context reviewer，2026-11-17）

对本轮改动做了一次独立复核，6 项问题和 1 项性能问题都按源码核实成立，已修复：

| 复核项 | 问题                                                                                                                         | 修复                                                                                                                       | 回归测试                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| RV1    | 非图片内联文件按解码字节 ÷4 计：6 MB 原生视频估 150 万 token，`index.ts` 发送前检查直接拒绝该轮（原先计 0）。                | 音视频按 500 字节/token（Gemini 32–263 token/秒在常见码率下的折算），其他文件按 32 字节/token，至少一张图。                | `compaction.test.ts`（视频、音频、PDF）                     |
| RV2    | 保留图片填满到 `totalTarget`，准备期间下一条腿追加的截图使 `publish` 的 `projectedInput > target` 恒成立，软压缩全部被丢弃。 | 图片最多占剩余空间的一半。                                                                                                 | 既有保留/再生成测试                                         |
| RV3    | 上下文分解面板把工具结果里的 base64 图片按字符计，与 F01 修掉的膨胀相同。                                                    | MCP image/audio/blob 与 AI SDK file 块按一张图（1600 token）计；普通 JSON 字段中的 base64 仍按文本计（它确实以文本发送）。 | `context-source-breakdown.test.ts`                          |
| RV4    | `keepRecoverableRefs` 补回正文中所有同形引用行，不设上限：读取含大量引用的日志即可让截断失效，并把不受信行移到顶部。         | 只认首行（可带 kernel 的 `bash: ` 前缀）声明的一条引用，长度 ≤1024。                                                       | `recoverable-ref.test.ts`、`tool-result-cap.test.ts`        |
| RV5    | 非 Anthropic 通道把工具图片重投影进 user 消息后，保留消息把它标成"来自用户消息"。                                            | 重投影消息的首行文本提为 `TOOL_IMAGES_LEAD_TEXT` 共用常量，`collectImages` 据此标为工具返回。                              | `compaction.test.ts`（collectImages）                       |
| RV6    | 保留图片消息计入 `MAX_FROZEN_SUMMARIES`，含图会话每 2 次压缩就再生成一次（破坏前缀缓存并重新摘要）。                         | 只计摘要消息。                                                                                                             | `runtimes/ai-sdk/compaction.test.ts`（3 摘要 + 1 媒体复用） |
| RV7    | `imagePixelSize` 对每张图都解码 192 KiB 再判格式，估算每条腿多次运行。                                                       | 先解 64 字节；仅 JPEG 再按 4 KiB、192 KiB 两级扫描帧头；base64 查表改为 `Int8Array`。                                      | `image-size.test.ts`（EXIF 后的帧头）                       |

复核确认无误的部分：跨压缩不产生重复图片；工具调用配对不受影响；非缩小检查一致；skills 的 implicit/explicit 划分完整；`mergeSources` 的各来源 id 稳定；`cognia serve` 不经 `toBuildContext`，Node fs 不会覆盖 Host 的根目录约束读取；context provider 的定时器和 abort 监听在结束时释放。

审计原有探针在修复后的树上于第一个缺陷断言处失败（O16），这是预期结果；它们保留为修复前行为的记录，回归测试取代其作用。未执行：真实 provider 长会话、视觉理解、三端 UI/native E2E（X1/X4/X6 仍开放）。
