# Evidence ledger: builtin prompts and settings gap audit

- Status: verifying
- Lane: deep
- Created: 2026-11-18
- Updated: 2026-11-22
- Related: ADR-0236; ADR-0237; ADR-0250; audit of the current shared working tree, not only HEAD

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 帮我分析一下现在的所有的内置提示词和相关的设置，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

Follow-up, 2026-11-18:

> 用 doubt-driven 再深入审查一遍，验证这 13 项问题和 2 个候选是否真实存在，排除误报、补齐遗漏，并更新完整问题清单，先不要修改产品代码。

Follow-up, 2026-11-22:

> 帮我分析一下现在内置提示词的token效率和准确性，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践，检查之前的发现的缺口是否已经修复

Follow-up, 2026-11-22:

> 用 $doubt-driven 再深入复审一轮，逐条验证这次新增的 7 个发现和 F01–F20 的修复状态，重点复现 A2UI 和 ToolSearch 的 token 开销、缓存断点失效及 RepoWiki 旧结果复用。排除误报、补齐遗漏并更新审计台账，先不要改产品代码。然后列出完整的问题列表

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                        | State       | Basis                                                                                         | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------- | ---------- |
| O1  | Prompt Center, revisioned overrides, owner adapters and module contributions exist.                                                              | Verified    | lib/prompts/catalog.ts; ADR-0236; source read 2026-11-18                                      | -          |
| H1  | The main gaps are missing prompt-management features.                                                                                            | Invalidated | Rich management, eval and replay capabilities verified in source; inventory below, 2026-11-18 | O1         |
| H2  | Existing management features have runtime, concurrency or verification gaps.                                                                     | Verified    | Bounded runtime probes and reconciled findings F01–F20 below, 2026-11-18                      | O1         |
| G1  | Inventory built-in prompts and settings, identify defects and gaps, compare current primary-source practices.                                    | Agreed      | User request 2026-11-18                                                                       | -          |
| C1  | Audit only; preserve concurrent source changes and user data; no production prompt changes or external model sends.                              | Verified    | User asks analysis; shared tree status 2026-11-18                                             | -          |
| O2  | CodeGraph has no index in this checkout.                                                                                                         | Observed    | codegraph explore returned no-index error 2026-11-18; use source search                       | -          |
| G2  | Challenge the original 13 findings and 2 candidates, remove overclaims, add omissions, update this ledger without product changes.               | Agreed      | User follow-up 2026-11-18                                                                     | G1, C1     |
| O3  | Three fresh reviewers reproduced narrower contracts with controls; two candidates now have isolated lifecycle/contract counterexamples.          | Verified    | Adversarial storage/UI/safety scripts and reconciliation below, 2026-11-18                    | O1         |
| C2  | No product changes, original-test edits, user-data access, real model sends or external CLI review without authorization.                        | Verified    | User follow-up and bounded probe execution, 2026-11-18                                        | C1         |
| G3  | Re-audit F01–F20 on the current checkout, measure input overhead, and compare runtime, output and release controls with current primary sources. | Agreed      | User request, 2026-11-22                                                                      | G1         |
| H3  | Conditionally appended protocol and tool-name text dominates ordinary slot bodies in the audited fixtures.                                       | Verified    | 272 definitions and actual A2UI/ToolSearch builders in the 2026-11-22 token probe             | O1         |
| H4  | Repaired authoring paths can still diverge from actual sends or reuse output from an earlier revision.                                           | Verified    | 2026-11-22 cache, resolver, renderer, and eval digest controls below                          | O1         |
| G4  | Recheck every T01–T07 and F01–F20 claim adversarially and deliver the complete issue list without product changes.                               | Agreed      | User follow-up 2026-11-22                                                                     | G3, C2     |
| O4  | Real SDK wire captures distinguish the A2UI delta, both ToolSearch cost directions, and two cache block defects.                                 | Verified    | Offline renderer and SDK probes, 2026-11-22                                                   | G4         |
| O5  | Independent review and mounted/local controls expose additional scope, privacy and release identity defects.                                     | Verified    | Three bounded reviewer lenses and reproduced controls below, 2026-11-22                       | G4         |

## Problem frame

Map each prompt family and its editable owner, scope and runtime consumer; distinguish reproduced defects from source-derived risks and product recommendations (G1). Evaluate H1 and H2 against source, isolated deterministic probes and primary documentation. Product fixes, quality claims without model evaluation, account-data inspection and real-provider sends are outside C1.

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                   |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Core catalog, 11 module contributions, plugins, UI, CLI and sidecars.                                         |
| technical    | medium | Existing prompt contracts and resolvers; their wiring needs verification.                                     |
| coupling     | high   | Account snapshots, workspace/session scopes, model settings and multiple execution rails.                     |
| requirement  | low    | Analysis outcome is explicit; implementation is not requested.                                                |
| verification | high   | Deterministic behavior can be probed; prompt quality and real shell/provider parity need separate acceptance. |
| risk         | medium | Read-only audit; inaccurate claims could misdirect later changes.                                             |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                                          | Severity | Source                                        | Claim                                                              | Refuted by                                                                          |
| --- | ------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| R1  | Incomplete inventory falsely labels existing functionality missing.                                    | high     | ADR-0236; FMEA                                | Every reported family maps to an owner and consumer.               | Existing implemented feature contradicts a gap claim.                               |
| R2  | Saved overrides diverge from preview or runtime, or overwrite concurrent edits.                        | high     | ADR-0236; shared-state lens                   | Overrides preserve scope, authority and revision semantics.        | Deterministic counterexample or traced bypass.                                      |
| R3  | Syntactic tests are mistaken for model quality or injection resistance.                                | high     | Anthropic evaluation guidance; STRIDE         | Findings explicitly state evidence strength and scope.             | Real model quality claimed from mocked or string-only tests.                        |
| R4  | Industry advice is outdated or ignores Cognia architecture.                                            | medium   | Primary-source comparison                     | Recommendations link current sources and existing mechanisms.      | Advice requires replacing a capability already present or contradicts current docs. |
| R5  | Unrendered slot counts may be mistaken for production requests or billing.                             | high     | Runtime composition and tokenizer differences | State encoding, surface, fixture, and exclusions for every number. | A reported count mixes source bodies, requests or billing.                          |
| R6  | A published revision may never run on a cached path, or evaluation may be mistaken for a release gate. | medium   | Resolution, cache and activation paths        | Check at the call or result boundary with controls.                | Catalog or resolution events are the only observations.                             |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk               | Method                                                                                               | Independence   | Evidence                                                                                                                                                                | Coverage                                                                                                   | Status  |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1                 | Inventory code slots, owners, settings and runtime consumers.                                        | tool           | inventory-capture.mjs: 266 definitions, 0 module failures, 0 editable default validation errors; full inventory linked below.                                           | Registered shipped slots complete for this load; dynamic plugins and raw text families separately bounded. | passed  |
| V2  | R2                 | Run focused tests and isolated counterexample probes.                                                | tool           | 45 suites: 43 passed / 2 failed; 544 passed / 3 failed. Narrow rerun: 79 passed / 1 failed. Diagnostic probes reproduce findings; see verification record.              | Existing baseline is not green. Pure and stub-backed counterexamples only; no provider calls.              | failed  |
| V3  | R1, R2, R3         | Fresh-context failure hunt of source and audit assumptions.                                          | fresh-reviewer | Independent reviewer found preview parity, stale verdict cache, draft/eval invalidation, and usage-log ambiguity; reproduced in persisted probes.                       | Findings reconciled against source and existing controls; no full UI/device acceptance.                    | passed  |
| V4  | R4                 | Read current primary documentation.                                                                  | tool           | OpenAI, Anthropic, LangSmith, Cursor and Claude Code primary sources retrieved 2026-11-18 and mapped below.                                                             | Documented practices, not benchmark rankings.                                                              | passed  |
| V5  | R3                 | Model-quality and real-shell acceptance.                                                             | real-env       | Not run in this source audit.                                                                                                                                           | Requires representative datasets, selected models and shell matrix.                                        | blocked |
| V6  | R1, R2, R3         | Fresh-context doubt-driven review in three bounded domains.                                          | fresh-reviewer | Storage, UI and safety/catalog reviewers returned independent findings; all 13 originals and both candidates reconciled below.                                          | Same-model independent context; no external model review performed.                                        | passed  |
| V7  | R2, R3             | Stronger lifecycle, transaction, mounted UI, loader and output-boundary probes with controls.        | tool           | Storage: 10 JSON results; safety: 25 result/control records plus completion; history: 2 controls; UI: 4 suites, 9 selected probes passed, 71 inherited tests skipped.   | Actual modules with explicitly isolated dependencies; no browser/native/provider acceptance.               | passed  |
| V8  | R1, R2, R6         | Reconcile F01–F20, rerun targeted regressions, verify authoring ABI.                                 | tool           | 54/55 focused Jest suites, 2/3 assembly suites, 4/4 plugin suites and 31/31 Python tests. Host ABI gate rejected sdkSourceSha256.                                       | Current working tree. In-process and mounted tests. Full F01–F20 table below.                              | failed  |
| V9  | R3, R5, R6         | Count built-in bodies and representative rendered input, and challenge runtime claims.               | tool           | Token recheck and RepoWiki SQLite probes passed with controls. Renderer suffix repro passed. 199/199 AI SDK sidecar tests.                                              | Local encoders and synthetic fixtures. Model reliability, bills and cache hit rates stay in V5.            | passed  |
| V10 | R3, R4, R5         | Compare current vendor guidance on cache, deferred tools, structured output, evaluation and release. | tool           | Primary-source comparisons in the 2026-11-22 recheck.                                                                                                                   | OpenAI, Anthropic and LangSmith official documentation.                                                    | passed  |
| V11 | R1, R2, R3, R5, R6 | Challenge every T01–T07 and F01–F20 interpretation independently.                                    | fresh-reviewer | Three readers using artifact and contract only. Controls and narrowed findings in the adversarial section.                                                              | Same model with independent contexts. User skipped cross-model.                                            | passed  |
| V12 | R2, R3, R5, R6     | Capture model-boundary inputs and prove cache and editor behavior with controls.                     | tool           | Intercepted SDK JSON, real Analyzer/SQLite, mounted editor/profile, and synthetic gate fixtures passed.                                                                 | Synthetic input and no external transport. Live provider acceptance remains in V5.                         | passed  |
| V13 | R1, R2, R6         | Rerun the old and new regression suites plus staging admission.                                      | tool           | 927/928 focused Jest, 599/600 assembly, 199/199 sidecar, 27/27 artifact, 33/33 RepoWiki and four mounted audit controls. Two local staged sets rejected before writing. | Scoped local runtime and fixture databases.                                                                | failed  |
| V14 | R1, R2, R5, R6     | Fix confirmed T01–T15, F04/F11 and X9 defects + sibling paths, repin authoring kit, stage plugin artifacts, and rerun colocated suites. | tool           | All modified Jest suites (Judge/Prompts/UI/Eval/Assembly/Plugin), sidecar ToolSearch + cacheControl, RepoWiki 354/354, author-types, authoring-kit repin, and stage-plugin-artifacts passed. | In-process, fake-IndexedDB, SQLite, and intercepted wire fixtures; live provider/shell acceptance remains in V5. | passed  |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                                                   | Action    | Based on       | Reversal trigger                                                                                       |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| D1  | 2026-11-18 | Inventory and diagnose before recommending additions; use isolated probes.                                                                                                                                                                 | diagnose  | O1, G1, C1     | Evidence reveals a different prompt owner or execution path.                                           |
| D2  | 2026-11-18 | Deliver an audit and reproducible evidence; prioritize existing boundary defects before adding new management infrastructure. H1 is ruled out.                                                                                             | stop      | O1, H2, G1, C1 | Real runtime evidence contradicts findings or user requests implementation.                            |
| D3  | 2026-11-18 | Re-enter diagnosis for G2; independently challenge artifacts and contracts before updating conclusions.                                                                                                                                    | diagnose  | G2, C2         | Stronger evidence disproves an original finding.                                                       |
| D4  | 2026-11-18 | Retain bounded defects and risks, correct unsupported expansions, promote C-A/C-B with limits, add five standalone findings and one F04 subcase. Stop this review cycle; no fixes.                                                         | stop      | G2, O3, C2     | Real shell/provider evidence contradicts the isolated results, or the user authorizes another review.  |
| D5  | 2026-11-21 | audit-fix: re-verify F01–F20 against the code and fix each at its root with a regression test; F10's MCP-server and RepoWiki prompt registration waits for a user decision.                                                                | implement | H2, O3         | A fix's regression test or a real-env acceptance contradicts the reproduced behaviour.                 |
| D6  | 2026-11-21 | User decisions on F10's remainder: the external MCP server's prompts stay outside the Prompt Center (served to external clients, not sent by Cognia); RepoWiki's system wording is registered through `ctx.prompts` and resolved per call. | implement | D5             | RepoWiki needs a workspace-scoped override, or an MCP prompt starts reaching Cognia's own model calls. |
| D7  | 2026-11-22 | Re-enter diagnosis for G3 in the Standard lane. Establish an offline token and correctness baseline, then check prior claims against current runtime and release paths.                                                                    | diagnose  | G3, O1         | Deterministic checks cannot distinguish competing explanations.                                        |
| D8  | 2026-11-22 | Finish the audit with measured local inputs and carry provider and release acceptance forward.                                                                                                                                             | stop      | G3, H3, H4     | New runtime data materially changes the ranked gaps or the reported measurement scope.                 |
| D9  | 2026-11-22 | Complete one adversarial cycle for the follow-up. Keep scoped measurements, reopen disproved parity or coverage claims, and carry confirmed defects forward without patching product code.                                                 | stop      | G4, O4, O5     | Real provider, account, or release evidence contradicts the bounded findings.                          |
| D10 | 2026-11-22 | audit-fix round 2: fix confirmed defects in T01–T15 (plus direct-egress PII and usage-telemetry siblings), F04, F11, and X9; escalate four protocol/product trade-offs (T03 descriptor split, T04 small-catalog threshold, T06 Prompt Center 3-way Eval Lab launcher, F18 room transcript message role) to user decision. | implement | G4, O4, O5     | A regression test, staged artifact verification, or user decision on the four trade-offs changes a contract. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                                                     | From     | Why still open                                                                                                                                                                                                                              | Next action                                                                                                                      | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Existing focused test failures remain; no product fix was requested.                                                                                         | V2       | Fixed: monotonic revision time (F19) and broadest-first slot order, 8c4d41d23a; the suites pass.                                                                                                                                            | None.                                                                                                                            | closed |
| X2  | Real-provider prompt quality, attack outcome, desktop/mobile/paired-host parity are unmeasured.                                                              | V5, R3   | Mounted jsdom UI and isolated DB exercised; no real browser/native/provider/account-vault flow.                                                                                                                                             | Execute the proposed acceptance matrix with controlled accounts and representative fixtures.                                     | open   |
| X3  | Cross-account read/write races are reproduced in isolated actual core DB lifecycle, not verified in full account UI/Host/vault.                              | R2       | Reads and writes are now fenced by database name (8c4d41d23a, 9efb7558ba); verified on fake IndexedDB only.                                                                                                                                 | Run full account/vault/Host acceptance of an account switch during load and publish.                                             | open   |
| X4  | Full semantic quality of every prompt and runtime-loaded third-party plugin is not established by the inventory.                                             | R1, R3   | Registry enumeration is complete for this load; content review is risk-focused.                                                                                                                                                             | Extend feature-specific datasets and capture enabled plugin inventory in the intended deployment.                                | open   |
| X5  | F10 remainder: the external MCP server's prompts and RepoWiki's Python prompts are still outside the Prompt Center.                                          | V6       | Closed by D6: MCP prompts stay out by decision; RepoWiki's wording registered and resolved per call, 793fab4afc.                                                                                                                            | None.                                                                                                                            | closed |
| X6  | Catalog's source-based sentinel guard does not prove every declared call path reaches the send boundary.                                                     | V6, V11  | Slot references and sentinel suites exist. Source matching can pass without a specific runtime assertion; Research is selected by the reviewed group mode test.                                                                             | Enumerate executed consumer paths and capture shipped/override calls at the real seam per declared path.                         | open   |
| X7  | A plugin prompt whose consumer resolves without a session (RepoWiki, config-governance) offers a workspace scope that never applies.                         | V6       | Closed: declarations may narrow to `scopes: ["account"]` (7ff00e58ac); governance block/remind resolve for the call's session (01de269ba5).                                                                                                 | None.                                                                                                                            | closed |
| X8  | The authoring kit pin is stale after 7ff00e58ac (sdkSourceSha256), so the Host refuses to produce plugin artifacts and predev/prebuild cannot stage plugins. | V6, V14  | Closed locally: Host ABI now hashes Python SDK sources (T14), authoring-kit pin was regenerated, and `stage-plugin-artifacts.mjs` passed Host ABI admission (T01).                                                                         | Publish corresponding kit to external `cognia-plugins` remote branch during standalone plugin-repo release if needed.             | closed |
| X9  | Two focused Jest assertions remain red.                                                                                                                      | V8, V14  | Closed: `use-prompt-slots.test.ts` matches `slot.database` and `build-options.test.ts` asserts explicit trial skill delivery outside the 4,000-token implicit ceiling.                                                                     | None.                                                                                                                            | closed |
| X10 | Rechecked runtime and release gaps remain open.                                                                                                              | V9, V14  | Deterministic defects fixed in D10; protocol/product trade-offs (A2UI 67-component split, ToolSearch tiny-catalog threshold, Prompt Center 3-way Eval Lab UI) await user decision and live provider measurement.                           | Decide on T03/T04/T06 product trade-offs and run live provider benchmarks (V5).                                                  | open   |
| X12 | Wider runtime, editor and release acceptance remains open.                                                                                                   | V12, V14 | T01–T15, F04, F11 (mode family), and X9 deterministic defects are fixed and covered by colocated regression tests; F18 room transcript message-role boundary awaits user decision and live multi-agent evaluation.                        | Decide on F18 role framing and complete real-shell/provider acceptance (X2, X3).                                                 | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                                 | How / when measured     | Result                                                                                                                                                   | Status |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | User has an evidence-linked inventory, prioritized findings and industry comparison.                   | Audit report 2026-11-18 | Full inventory, settings map, 20 reconciled findings and comparison delivered below; C-A/C-B promoted with explicit limits. No product behavior changed. | met    |
| M2  | The follow-up separates genuine defects from overclaims and adds omissions with reproducible controls. | Doubt review 2026-11-18 | All 13 originals retained in narrower categories; both candidates promoted; five new standalone findings and a preview-transition subcase added.         | met    |
| M3  | Current audit supplies measured token costs, F01–F20 status, and prioritized gaps.                     | Recheck 2026-11-22      | Delivered measurements, 20 per-item statuses, two runnable probes, and current primary-source comparison. Provider validation remains in X2.             | met    |
| M4  | Full issue list after one adversarial cycle and reproduced priority claims.                            | Review 2026-11-22       | T01–T15 and F01–F20 reconciled, raw measurements and reproducible probes linked below.                                                                   | met    |

## Audit result / 审计结论

**Cognia 已经有相当完整的提示词管理基础。当前最值得投入的是修正“编辑、解析、真实调用、评测”之间的不一致。** 复审后的完整清单为 **20 项**：14 项已复现的行为/契约问题，3 项有具体调用边界的风险，1 项条件性加固项，2 项清单/测试覆盖缺口。原 13 项没有整项撤销，但多处影响范围被收窄；原 C-A/C-B 分别升级为 F14/F15；新增 F16–F20，另补 F04 的切换期间旧预览问题。P1/P2 是建议处理优先级，不表示线上发生频率或已经成功利用。

本次只新增审计文档与探针，没有修改产品代码、用户数据或实际提示词设置，没有提交 Git。检查对象是 **2026-11-18 当前共享工作区**，基准 HEAD 为 `b50c5c9501263e3abf20f5792c98756cdc675687`，首轮采样时工作区有 885 个状态条目；不能把结果当作仅针对干净 HEAD 的结论。CodeGraph 没有索引，因此使用源码搜索、真实模块加载和隔离探针。复审中间检查时共享 HEAD 为 `2e6da23843f9134e8e6865d8f32a213d2402d5ad`；18 个重点 owning source 的起止 SHA-256 一致。并发提交未被回退或归入本任务。

### 1. 全量清点的边界与结果

[266 个登记内置提示词的逐项清单](./2026-11-18-builtin-prompts-and-settings-gap-audit.inventory.md)记录每个 ID 的 operation、risk、scope、host 和 consumer。

| 类别        |    数量 | 覆盖内容                                                  |
| ----------- | ------: | --------------------------------------------------------- |
| chat        |      57 | 基础对话、简短模式、侧聊、可视化、回复助手、IM、宠物等    |
| agents      |      36 | 内置子代理身份、模式、计划、验证者、执行者等              |
| generation  |      26 | 标题、摘要、Canvas、模板辅助等                            |
| completion  |      10 | 续写、建议、提示词增强等                                  |
| knowledge   |      14 | Wiki、网页提取、RAG 扩展、记忆相关等                      |
| developer   |      54 | Git、Issue、Creator、Skills、Workflow、终端、bootstrap 等 |
| permissions |       1 | 命令安全 judge                                            |
| routing     |       9 | 难度判断与 Router Fusion roles                            |
| goals       |       6 | 目标、继续执行、完成判断等                                |
| team        |      38 | 团队编排、任务分解、角色与评审 patterns                   |
| twin        |      15 | 分身身份、知识/风格蒸馏、重排等                           |
| **合计**    | **266** | 核心 154 + 11 个模块贡献 112                              |

- 235 个 `replace-template`、30 个 `inspect-only`、1 个 `narrow-only`。风险标注为 ordinary 145、protocol 115、approval-sensitive 6。
- Host 组合是 app 165、app+CLI 85、CLI 13、bootstrap 3。全部声明 `next-operation`；这只是 definition 元数据，不能代替外部 agent 已运行会话的刷新验收。
- 10 个 owner adapter 还管理 app settings、instruction files、workspace instructions、characters、custom modes、presets、Skills、subagent templates、team templates、composer templates。它们不计入 266，也不应该复制成第二套 authority。
- 已发现 first-party plugin 动态声明：Deep Research 6、config-governance 5；启用后还可注册 plugin subagent identity。未读取用户安装状态，因此没有把这些说成“当前用户已经启用”。
- 266 是本次完整加载的 **登记内置槽位**，不是仓库所有字符串总数。F10 列出仍在 catalog 之外的活跃协议。Provider 内部提示词、远程 upstream agent 的隐藏实现也不属于本仓库可枚举范围。
- 所有可编辑 shipped defaults 通过现有模板检查，模块加载失败为 0。这证明声明自洽，不证明模型输出质量。

### 2. 相关设置与真实生效关系

| 设置面                      | 已有能力 / 生效规则                                                                                                                        | 主要源码                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代码槽位 override           | 仅允许 definition 声明的 scope；`session > agent > workspace > account`，选一个，非逐层拼接。失效 contract/body/PII 回退 shipped default。 | `lib/prompts/resolve.ts:60,134`                                                                                                                                      |
| 文本生命周期                | 草稿、发布、immutable revisions、乐观 rev、reset inheritance、restore、upstream digest 警告、最多 50 条 inactive 非草稿历史。              | `lib/prompts/service.ts`; `lib/db/prompt-overrides.ts:144,203`                                                                                                       |
| 基础 system prompt          | `session > team-member override > character > app default`；基础文本只取一个。                                                             | `lib/prompts/base-selection.ts:27`; `lib/claude/build-options.ts:2492`                                                                                               |
| Persona / harness           | tone、personality、standing rules/domain/tool guidance 会追加；twin identity contribution 可替换 base，并抑制重复 persona。                | `lib/harness/render.ts:17`; `lib/claude/build-options.ts:2839`                                                                                                       |
| 模式 / preset / Skills      | 模式追加 system delta；Skills 有专门加载/投递策略；built-in owner 编辑走 variant/custom copy。                                             | `lib/claude/build-options.ts:2685`; `lib/prompts/adapters/`                                                                                                          |
| 指令文件                    | global/project instruction discovery、imports、配置 override、checked file write、bare mode；headless Host 有 root-confined FS。           | `lib/agents/instructions/load.ts`; `lib/prompts/adapters/instruction-files.ts`                                                                                       |
| 工作区指令                  | workspace 自己的 customInstructions 独立追加。                                                                                             | `lib/workspace/workspace-instructions.ts`; `lib/claude/build-options.ts:2864`                                                                                        |
| brief / bare / output style | 多数按 session → character → app；brief 与 output style 可同时追加。                                                                       | `lib/claude/build-options.ts:2575,4293,4313,4343`                                                                                                                    |
| 模型与 reasoning            | provider/model inference 参数、能力投影；effort 还有 grant、IM、bot、executionPolicy 等层。                                                | `components/settings/provider/provider-parameters-tab.tsx:100`; `lib/ai/providers/provider-attempt-options.ts:222`; `lib/claude/build-options.ts:2017`               |
| context / cache             | compaction 与模型窗口预算已存在；cache optimization 实际默认开启，动态 context 放尾部。                                                    | `lib/claude/build-options.ts:2514,4377`; `lib/ai/prompt-partition.ts`                                                                                                |
| 预览 / 调试                 | 新会话静态 effective preview、scope/source/fallback 最近解析记录、整体 promptDigest、model-request shadow、可选加密 replay asset。         | `lib/prompts/effective-preview.ts`; `lib/prompts/resolution-log.ts`; `lib/agent/composition/resolve-turn-composition.ts:64`; `lib/ai/replay/model-request-shadow.ts` |
| 评测                        | Eval dataset、experiment、target dependency digest、执行前漂移校验、推荐应用与回滚已存在。                                                 | `lib/ai/eval/project-service.ts:98`; `browser-execution.ts:764`; `recommendation-application.ts`                                                                     |
| CLI / profile               | CLI 有 list/show/set/reset/export/import，独立 store 并 prime snapshot；portable profile 搬运 published code-slot override。               | `cli/src/cli/prompts-command.ts`; `cli/src/agent/prompt-overrides.ts`; `lib/prompts/profile.ts`                                                                      |

三个已声明边界不应误报为缺失：preview 已明确把动态 send-time sections 单列；profile 并非完整 agent/Skill/workspace 配置包；ADR-0236 明确 paired-client configuration writes 暂不在范围内。它们可成为后续产品需求，但不是已承诺功能突然失效。

### 3. 复审后的完整问题清单

下表是当前裁决。P1/P2/P3 表示建议处理顺序；“已复现”是实际被测边界的反例，不等同于真实模型、全部客户端或线上事件。F07 是条件性加固；F08/F18/F20 是风险；F10/F11 是覆盖缺口；其余 14 项是已复现的行为或契约问题。原编号保留，方便追踪首轮结果。

| ID            | 优先级  | 当前结论                                                       | 复审裁决 / 新证据                                                                                   |
| ------------- | ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| F01           | P1      | 非法/缺失 risk 被解释为 low，符合条件的 Auto-mode 请求可被允许 | 保留并收窄；实际 renderer 分支可发 allow，但 Host hard deny、personOnly、per-call approval 等仍有效 |
| F02           | P2      | replacement import 覆盖审阅之后的并发修改                      | 真实 Dexie 复现；底层 CAS 和 new→published 冲突控制有效                                             |
| F03           | P2      | 保存会话设置丢失显式 false                                     | 挂载 UI 复现三开关；不仅不能设置 false，还会破坏已存在的 false                                      |
| F04           | P2      | Effective preview 与 runtime 静态内容不一致                    | cwd/mode 复现；新增切换选择期间保留旧 ready 文本的 P3 子问题                                        |
| F05           | P2      | 预览刷新“最近使用”                                             | 挂载真实详情组件复现，无 provider 调用                                                              |
| F06           | P2      | 未发布草稿改变已发布目标的评测 digest                          | 真实 executor 在 target 构建前拒绝；仅已有 published binding 的非 model variant                     |
| F07           | P2 加固 | 同 contractVersion 重注册后沿用旧 validator verdict            | 条件性保留；正常升版控制有效                                                                        |
| F08           | P2 风险 | Canvas attachment snapshot 被放进 system                       | 普通/流式请求参数捕获；撤回“文件/选区生产链已验证”的暗示                                            |
| F09           | P2      | catalog partial load failure 未进入清单 failed 状态            | 真实 catalog/adapter 注入单模块失败；修复 loader 后可恢复                                           |
| F10           | P2 缺口 | 部分活跃协议正文未登记                                         | 实际消费链确认；不等于功能没接通，也不要求全部开放编辑                                              |
| F11           | P2 缺口 | consumer guard 不能证明特定 slot 到达调用边界                  | 保留测试缺口；撤回 inspect-only 没有 resolver 就异常的推论                                          |
| F12           | P3      | Reset 对话框的继承文本与实际 fallback 不一致                   | 挂载 Reset UI + 真实 resolver 复现；有效 account 控制一致                                           |
| F13           | P2      | workspace instructions 保存成功未等待持久化                    | 注入 QuotaExceededError，adapter 返回新值而 DB 保留旧值                                             |
| F14（原 C-A） | P1      | account switch 期间复用旧账户 inflight snapshot                | 实际 core DB activation + fake IndexedDB 复现；旧 DB 关闭也不能撤销已交付的读取结果                 |
| F15（原 C-B） | P3      | RepoWiki 行号坐标契约不一致                                    | 前导空行 fixture 产生 line 3→line 1 引用；模型实际遵循率未测                                        |
| F16           | P2      | 正常升版后同文本 profile 导入被错误跳过                        | v1/X→导入 v2/X 为 unchanged，仍 fallback；v2/Y 控制可激活                                           |
| F17           | P1      | publish 在 digest await 期间可能写入新账户                     | 真实 WebCrypto await + core account switch，无人为延迟，A 发起的 body 写入 B                        |
| F18           | P2 风险 | 团队 transcript 多行正文可伪造说话人标签                       | 实际 renderer 输出伪 User 行，生产 runner 追加到 system；模型/权限后果未测                          |
| F19           | P3      | 同毫秒 revision 历史不能保证 newest-first                      | 真实事务 + 固定时钟/ID 随机数，parent 明确先后但列表倒序错误                                        |
| F20           | P2 风险 | judge 的 cwd 输入与缓存/生产接线不一致                         | helper 可跨 cwd 复用 verdict；生产 renderer 未传 cwd，不能称生产 cwd 切换漏洞已复现                 |

#### F01 · P1 · 安全 judge 将非法或缺失 risk 解释成 low，随后自动允许

**保留，但限定触发条件。** `command-judge.ts:127–130,195–200` 对 `safe:true` 且 risk 缺失/null/数字/对象/大写枚举均归为 low。真实 classifier→judge→auto runner 复现 `git push` 文本得到 `allow/model/low`；提取实际 `hooks/chat/agent-chat-events.ts:289` 函数执行，非 per-call 请求确实调用注入的 respond(allow)。命令没有执行，审批没有发给真实 Host。

生效前提是用户选择 rules+model，规则分类为 ask、非 outbound，且没有显式 command rule 截断。灾难命令 deny、GitHub outbound ask、rules-only、显式 ask/deny 均不调用模型。`personOnly` 跳过 Auto-mode（`:1042,1127`），`requiresPerCallApproval` 阻止 auto-allow（`:330–334`），Host 的 hard deny 和审批后复查继续存在。截断 JSON、数组、safe 字符串均回到 ask；不是所有 malformed output 都放行。narrow-only 仍能阻止 malformed custom 放宽 shipped unsafe/high。

应对输出执行严格 schema 校验；缺失/非法 risk 不能制造安全证据。非法 reason 也会被吞成空串，但不能把它和非法风险等级赋予同样危害。此项不证明 sandbox、Host hard deny 或全部人工审批被绕过。

#### F02 · P2 · Profile replacement 导入覆盖预览之后的并发修改

**真实存储复现。** `lib/prompts/profile.ts:194` 不保存预览基准 rev/body；`:236` 用当前槽位和待导入文本比较，然后使用刚读取的 rev 发布。预览 rev1 → 他人 publish rev2 → apply 返回 `applied:1, conflicted:[]`，rev2 被替换。

控制组显示直接 stale-rev 写入会被拒，new→published 也会冲突。因此是“审阅→应用”的并发保护缺失，不能说底层 CAS 失效。应将 preview 的 revision 身份带入 apply，并要求冲突后重新审阅。

#### F03 · P2 · 会话开关的 false 无法保留

**挂载 RTL 复现。** `session-settings-sheet.tsx:340–342,385–387` 将 undefined 显示成 false；`:557–559` 将 false 保存回 undefined。已经持久化的 `bareMode/debugMode/briefMode=false`，只打开并 Save，三个字段即全部变为 undefined，runtime 的 `session ?? character ?? app` 恢复父级 true（`build-options.ts:2575,4301,4313`）。true 控制组仍为 true。

应使用“继承 / 开启 / 关闭”三态，并展示有效值和来源。session 空 system prompt 的 UI 已声明继承语义，不属于此 false 丢失缺陷；placeholder 仅说 global default，遗漏 character/team-member 中间层，是另一个较轻的说明问题。

#### F04 · P2 · Effective preview 的静态投影与发送路径不一致

**真实 hook 与生产 helper 复现。** `use-effective-chat-preview.ts:78–81` 只用 roots[0]；runtime `build-options.ts:2531–2547` 使用包括 character/default workingDir 的 `resolveEffectiveCwd`。hook `:97–105` 保留 mode raw placeholders；runtime `:2674–2701` 处理模板变量。探针得到 preview `Mode={{mode_name}}; tools={{tools_list}}`、cwd 未设置，runtime helper 得到 `Mode=Research; tools=web_search`、`/agent/project`。

**新增 P3 子问题：切换选择时旧结果仍标记 ready。** hook `:64–66,132–147` 不在重新加载时设 loading；切新 agent 并挂起 instruction load 后，选择已更新、正文仍显示旧 agent。释放 loader 才变为新正文。已有 cancelled 检查阻止旧请求乱序覆盖，不能扩大成永久错写。应明确 pending/previous 状态并标注当前结果对应的选择。

应复用静态投影与 renderer 并做 parity 测试。memory 等已标注 send-time 的动态省略不算此缺陷；本次未运行完整 `resolveSendOptions` 或真实浏览器。

#### F05 · P2 · 打开预览刷新“最近使用”，没有发生模型调用

preview 调用 `resolvePromptAsync` → `resolve.ts:169` 无条件记录 → `resolution-log.ts:24–26` 按 prompt ID 覆盖 → `code-prompt-detail.tsx:206–224` 展示 lastUsed。**挂载详情后仅打开 preview**，从 `Not used since this window opened` 变成 `Shipped text, at …`；还可覆盖之前其他 workspace/revision 的记录。

应分开 preview/resolve/dispatched/completed，并关联 request/run 与 slot/revision/scope/fallback。现有整体 promptDigest、shadow event、加密 replay 是已有基础；不能据此说项目没有 trace/replay，也不应默认记录敏感完整 prompt。

#### F06 · P2 · 草稿元数据使已发布目标的评测失效

`project-service.ts:113,147` 对非 model variant 收集含 active published pointer 的 binding，并把整个 binding 纳入 digest，包括 draftRevisionId/rev/updatedAt。保存 draft 后 published revision 和 runtime text 未变，但 digest 变化，实际 `browser-execution.ts:764` executor 在构建 target 前抛出 `Evaluation target chat-probe changed since the manifest was created`。

**收窄范围：** model variant 提前返回；只有 draft、没有 published pointer 的 binding 被过滤，其控制组 digest 不变。应 hash 实际执行内容及上下文，把编辑态从发布态分开；漂移检测和 Eval Lab 本身并不缺失。

#### F07 · P2 条件性加固 · 同版本重注册可复用过期校验 verdict

`resolve.ts:100` key 只有 ID/contractVersion/revisionId；`plugin-prompts.ts:152` 允许重注册。同 version 新增 requiredFragment 后，实际 validator 判旧 override invalid，而缓存 resolver 仍选 override；清缓存立即 invalid-body。

**正常提升 contractVersion 控制会 contract-incompatible 回退。** 此项前提是同版本改变契约，不能说正常升级普遍失效。Host 可拒绝同版本不兼容注册，或用 contract fingerprint / 定向 invalidation 加固。优先级低于真实账户和保存语义问题。

#### F08 · P2 风险 · Canvas 附件内容进入 system 指令层

实际 `canvas-actions.ts:221,261,319–322,346–349` 在普通/流式两条路径将 attachment.snapshot 置于 system。探针仅捕获 SDK 参数，未让模型执行附件中的指令。插件 API `canvas-api.ts:544–562` 可提供 options；UI 消费已保存附件。

**撤回首轮过宽来源描述：** 当前 source 类型为 canvas-document/artifact/session-message，本轮没有定位到完整“添加附件”的 UI producer，因此“来自文件/选区”的生产构造链没有证据。Canvas run 已走执行面板，也不能将其当作此生成 sink 的工具执行后果。

应把资料和稳定 instructions 分开、标注来源/信任级别，并做对抗评测。PII 检查不解决 authority 混合；本项不是已成功利用的提示注入或泄漏事件。

#### F09 · P2 · 模块加载失败没有进入清单 failed 状态

`catalog.ts:290–297` catch 后返回 failures；`adapters/index.ts:56` 丢弃 catalog 返回值，`:100–116` 只有 throw 才记 failed。**真实 catalog/adapter 探针**注入一个成功 module、一个失败 module：有 warning 和 catalog failure，清单仍 failed=[] 且缺失条目。修复 loader 后重试可恢复。

应将 partial failure 传递到 UI，标明缺失来源并支持重试；不是“所有异常都被吞”或“重试机制完全没有”。

#### F10 · P2 覆盖缺口 · 活跃协议正文未全部进入 Prompt Center

实际消费链包括 Builder `builder-protocol.ts:11 → agent-tools.ts:325`；Project coordinator/worker `protocol.ts:10,22 → agent-tools.ts:554,558`；团队 transcript `team-transcript.ts:165,205 → room/runner.ts:1701,1718`；外部 MCP `server.ts:181,2375,2412`。RepoWiki `pipeline.py:254–255 → analyzer.py:520–526 → host.py:198–217` 直接消费 Python prompts。

ADR-0236 明确机器协议可以 inspect-only；日期、locale、JSON shape 可以留在代码。此项限于有独立行为语义的正文，不把每个内联字符串算缺陷。建议登记为 inspect-only 或建立跨 runtime 可审计清单；这些模块**已经接通**，不是功能不存在。

#### F11 · P2 测试缺口 · consumer guard 未绑定具体 slot

`catalog.test.ts:63–79`，尤其 `:78`，只检查 consumer 文件出现任意 resolver 调用，同文件其他 slot 即可使检查通过。inspect-only 不必调用 resolver 是合理策略，本身不是缺陷。

应对可编辑 slot 注入唯一 sentinel，驱动 builder/adapter 并检查发送边界；多 scope、app/CLI/Host 共享 contract fixtures。本项只证明现有 guard 较弱，没有证明每个登记项都存在 bypass。

#### F12 · P3 · Reset 确认框未解析有效继承内容

`code-prompt-detail.tsx:128–130,473–481` 直接展示 account active body。**实际 Reset UI**在 account contract 不兼容、workspace 有效时展示 `INCOMPATIBLE ACCOUNT TEXT.`；确认 Reset 后真实 resolver 返回 shipped + contract-incompatible。有效 account 控制组展示和解析一致。

应解析移除当前 override 之后的有效结果，并显示 fallback 原因。

#### F13 · P2 · Workspace instructions 保存没有等待 durable write

实际 adapter `workspace-instructions.ts:69` 调用 void updateProject；`project-store.ts:133` 的持久化 Promise 吞错，UI 在 await adapter 后提示成功（`owner-prompt-detail.tsx:89`）。**真实 owner store→Dexie 更新路径**注入 QuotaExceededError 后，adapter 返回新文本、DB 保留旧文本；正常写入控制可持久化。

应 await owner 的 durable write、传播错误并保留编辑态。本次是注入存储失败，不是实际耗尽磁盘，也未用重复 prompt store 绕开 owner。

#### F14 · P1 · Account switch 的 inflight snapshot 缺少身份隔离（原 C-A）

`lib/prompts/snapshot.ts:118`，全局 inflight 不按 DB 分开；`resolve.ts:184` 直接使用 awaited snapshot。真实 CogniaDB schema/Dexie/fake-indexeddb 中，A 的 revision 结果已取出、snapshot 尚未交付时，通过 reading hook 调用实际 `activateAccountDatabase(B)`：A DB 已关闭，B 的公开 resolver 仍返回 A override；guarded peek 为 null，下一次 fresh resolve 正确返回 B。

控制：完整 load 后再切换不会复用旧 override；在更早阶段立即切换没有得到 A body。故“close 一定让所有旧结果失效”被反驳，但竞态依赖交错时点。initializer 新 scope 首次 emission 不 invalidate（`:51`）。应按 database/generation 对 inflight 和交付结果 fencing。

**证据边界：** 已提升为 core lifecycle 的确定性反例，尚未验证真实账户 UI、vault、Host/浏览器调度或线上泄漏；外围加密/同步 middleware 在探针中 inert。

#### F15 · P3 · RepoWiki 行号的生成契约和引用坐标不同（原 C-B）

`prompts.py:73–75` 要求从首个非空行计数；`scanner.py:318,332,340`、`analyzer.py:425–429` 保留前导空行；`wiki_builder.py:229` 把模型 line 直接用作真实 path:line。fixture 两个前导空行使函数实际位于第 3 行，按提示词契约提供 line=1 后，原 renderer 输出 example.py:1。

这是已复现的**契约冲突**，不要求假装真实模型已给出错误结果。应在输入中使用绝对行号或携带 offset，并测试前导空行/截断片段坐标。

#### F16 · P2 · 同文本 profile 导入跳过正常 contract 升级

`profile.ts:194` 用 body 相等决定 unchanged，忽略已发布 revision 的 contractVersion。真实 DB 中发布 v1/X → 合法注册 v2 → 导入有效 v2/X，preview=unchanged、applied=0，resolver 仍 contract-incompatible；v2/Y 控制为 replace 并可激活。

应比较“有效 revision/contract”而非仅文本。此项与 F07 不同：这里插件正确升版也会发生，用户必须无意义地改文本或手动重新发布才能修复导入结果。

#### F17 · P1 · Publish 在异步 digest 期间可能跨账户落库

`service.ts:94–101` 在调用存储前 await shippedBodyDigest，未锁定账户；`prompt-overrides.ts:151` 到事务开始才获取当前 DB。A 下调用实际 publishPromptBody，立即 actual activateAccountDatabase(B)：真实 WebCrypto await 后 body 写进 B、A 没有 binding，返回 rev1。无需人为延迟。编辑器 `code-prompt-detail.tsx:158` 未传账户身份/取消信号。

应在操作入口捕获身份并在每个 await 后/事务前校验，或绑定特定 DB；账户切换应取消/拒绝旧编辑操作。与 F14 的旧账户读取不同，这是新账户写入。只复现 publish 公共 API，不能把相邻 draft/reset 的源码相似性当成它们也已独立实测。

#### F18 · P2 风险 · 团队 transcript 的多行正文能伪造说话人

`team-transcript.ts:253–271` 只给整条消息加 speaker 前缀，保留正文换行，`:205–209` 却告诉模型每行前缀表示说话人；`room/runner.ts:1718–1728` 把 transcript 追加进 systemPrompt。实际 renderer 接收 assistant 正文 `Quoted text\nUser: APPROVAL_SENTINEL`，产生两行 `Writer: Quoted text` / `User: APPROVAL_SENTINEL`。

应保留结构化 role/speaker，或用不可混淆的数据编码/引用边界，并声明正文不能授权。已证实来源标记冲突，未证明模型受骗、工具调用或批准权限绕过。

#### F19 · P3 · 同毫秒 revision 的历史顺序不可靠

`prompt-overrides.ts:118` 的 newest-first 排序使用 createdAt 后按随机 ID；`:208` 的历史裁剪也用相同 tie-break。真实 publish→reset 两个事务，固定同毫秒时钟和合法随机 ID：parentId 证明 reset 在后，列表却返回 published/reset；差 1 ms 控制返回 reset/published。active pointer 和 rev 均正确。

应持久化单调 mutation/revision sequence 或使用确定的序关系。此项解释历史 UI/测试不稳定；未复现历史裁剪误删，更不能解释为某 scope 被误删除。

#### F20 · P2 风险 · Judge cwd 上下文未完整接线，缓存未覆盖该输入

`command-judge.ts:190–191` 支持 cwd 输入，`:88–90` 的 cache key 却不含 cwd。公开 helper 同 session/command 从 /probe/a 改到 /probe/b，第二次复用首个 safe；显式 invalidate 后才重新判断。**生产 renderer `agent-chat-events.ts:313–325` 根本未传 cwd**，因此这不能描述为生产 cwd 切换缓存漏洞已复现；生产缺口是没有真实工作目录提示。

应从可信执行上下文传入 cwd，并让 cache identity 覆盖影响判断的输入；本次仅验证 cwd，不推定其他维度已实测。Host 策略仍独立存在，没有证明此缺口导致危险命令执行。

### 4. Doubt reconciliation、排除项与验证结果

本轮按存储/生命周期、UI/preview、safety/catalog 三个独立领域做 fresh-context review。先给代码和契约，后比较原问题编号；没有向 reviewer 传作者的设计理由。一个有界复审轮次完成，对新实质发现补反例和控制后停止，未进行无穷递归复审。

- **Valid + actionable：** F01–F06、F09、F12–F17、F19；按上文限定的契约处理。
- **Valid, bounded risk/gap：** F08/F10/F11/F18/F20；保留实质缺口，不扩成已经发生的模型攻击或所有消费者失效。
- **Conditional hardening / trade-off：** F07；正常升版已有防护，Host 对违规同版本契约更新是否做额外防御需要权衡。
- **Contract misread / overclaim 已移除：** F01 不覆盖硬拒绝和强制逐次人审；F06 不覆盖 model variant 或 draft-only slot；F08 的文件/选区来源链未获证实；F10 不将动态日期/locale/JSON shape 都算缺失；F11 不要求 inspect-only 走 resolver。
- **Noise / 未成立：** 模板辅助器会抹掉字面 placeholders 的猜测被现有 passthrough values 反驳；session 空 prompt 的继承是声明语义；preview 已标注的动态省略不是 parity bug；取消标记能阻止旧请求乱序覆盖；没有证据证明 unavailable UI 点 account 却删 workspace。

已按 skill 向用户提供跨模型选项；截止本轮文档整理未收到外部 CLI 授权，未运行 Codex/Gemini，也未把源码发送给外部 reviewer。本轮独立性是 fresh-context 同模型，不能冒充跨模型审查；该可选项不阻塞用户已授权的仓库内审查。

首轮现有测试结果（保留，不以新探针覆盖）：

| 执行                                                                                                                                                                                     | 实际结果                                                  | 说明                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm test --runInBand lib/prompts components/settings/prompts hooks/prompts lib/db/prompt-overrides.test.ts cli/src/agent/prompt-overrides.test.ts cli/src/cli/prompts-command.test.ts` | 45 suites：43 pass / 2 fail；547 tests：544 pass / 3 fail | 失败是 reset history 顺序 1 项、unavailable prompt UI 顺序/删除断言 2 项。 |
| 对上述失败涉及文件，加 command-judge 与 session-settings-sheet 做指定路径复跑                                                                                                            | 4 suites：3 pass / 1 fail；80 tests：79 pass / 1 fail     | reset suite 通过；unavailable 删除测试仍失败。不能覆盖抹掉首轮结果。       |

历史排序在 `lib/db/prompt-overrides.ts:118` 使用 createdAt + ID；同毫秒操作不能由随机 ID 保证真实先后。Unavailable UI 测试则依赖 slots[0]/slots[1] 的顺序（`:67,81`），源码按 IndexedDB 查询顺序返回，没有显式 scope 顺序。**没有证据说 UI 点了某一 scope 却删除另一 scope**；测试实际点的是首项，却先假定首项一定是 account。此处需要稳定排序/按 scope 定位的行为测试。测试没有被改写或弱化。

本轮新增验证（断言当前反例及负向控制，不表示修复通过）：

| 脚本                                                                                                 | 结果                                                                  | 被测边界                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Storage probes](./2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-storage-probes.mjs) | exit 0，10 条 JSON                                                    | 实际 CogniaDB schema、activation、Dexie、service/resolver、plugin、eval executor、workspace adapter；fake IndexedDB 和明确列出的外围 stubs |
| [UI probes](./2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-ui-probes.mjs)           | 4 suites passed；9 selected probes passed；71 inherited tests skipped | jsdom RTL 实际组件/hook、真实 catalog/adapter 与 resolver；仅选择新 adversarial cases，不宣称整套原测试通过                                |
| [Safety probes](./2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-safety-probes.mjs)   | exit 0，25 条结果/控制 + completion                                   | 真实 classifier/judge/auto runner、提取的 renderer 函数、Canvas SDK 参数、transcript renderer、Python coordinate fixture；无真实模型/审批  |
| [History probe](./2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-history-probe.mjs)   | exit 0，2 条结果                                                      | 实际 persistence module/Dexie 事务；最小同名索引 schema、fake IndexedDB、显式 clock/ID randomness 注入                                     |

原始日志保存在 `.cache/prompts-doubt/{storage,safety,ui}/`；新脚本可重新生成证据。F14 的 reading-hook 只用于安排确定性交错，F17 使用真实 digest await、没有人为延迟。所有探针不访问用户数据库，不发模型/网络请求，不执行待判断的 shell 命令；外围 middleware 的 stub 边界不能省略。

### 5. 与当前一手实践的对照

以下是已阅读的官方实践，不是对产品做排名，也不是保证采用后质量必然提升。

| 一手实践                                                                                                             | Cognia 当前匹配情况                                                                                 | 应补的具体能力                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI：prompt 与代码共同版本化、typed inputs、代表性 fixtures、eval、渐进发布。                                     | slot 与 owner 同处源码、版本/revision/变量检查已有，方向一致。                                      | 补 ID 到真实调用的 contract 测试；区分草稿与发布；让发布可关联评测证据。 [来源](https://developers.openai.com/api/docs/guides/prompt-engineering)                                                                                                                       |
| Anthropic：先定义可测成功标准，再使用任务样本、边界样本、A/B 与运行指标评测。                                        | Eval Lab 和 target digest 已有。                                                                    | 在 Prompt Center 增加“比较 shipped/当前/draft”的入口，冻结模型、参数、dataset、有效 revision；复用现有 eval，不另建引擎。 [来源](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)                                                                   |
| Anthropic：清晰指令、适量多样示例、结构化区分 context/input/instructions，并按模型实际行为调整。                     | 变量、fragments、protocol contract 已有，部分 prompt 已明确不可信数据。                             | 高风险结构输出用 schema；Canvas 等统一信任边界；用中英、缺输入、长输入、异常模型输出检验每个高风险 family。 [来源](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)                                            |
| OpenAI：不可信输入不放在高优先级 developer 指令中；结构化数据与权限控制分开。                                        | narrow-only judge、inspect-only protocol、PII gate、独立 tool policy 已有。                         | 修 F01/F08；拒绝把模板文本校验或 PII 检查当成注入防护。 [来源](https://developers.openai.com/api/docs/guides/agent-builder-safety)                                                                                                                                      |
| LangSmith：版本、diff、环境 promotion、rollback、owner，以及 Playground/model configuration。                        | 历史、diff、restore、profile 已有；没有看到 code-slot 发布绑定评测结果和环境 promotion 的完整入口。 | 可在现有 revision 上增加 candidate/validated/active 状态与回退记录；先解决并发覆盖。无需为了对标迁移到远程 registry。 [来源](https://docs.langchain.com/langsmith/manage-prompts)、[Playground 与 Context Hub](https://docs.langchain.com/langsmith/prompt-context-hub) |
| Cursor：Always/按路径/相关性/手动触发的规则，嵌套规则有作用域。Claude Code：指令是上下文，硬限制通过 hook/配置执行。 | discovery、Skills 和 harness 已有；权限也独立于文字。                                               | 强化“为什么加载、哪个来源覆盖、何时失效”的展示与三态设置；更复杂条件规则需先对照现有 loader/Skills，不能直接宣称缺失。 [Cursor](https://cursor.com/docs/rules)、[Claude Code](https://code.claude.com/docs/en/memory)                                                   |
| Anthropic context engineering：上下文是有限资源，应保留高信号内容。                                                  | cache-friendly ordering、compaction、token budgets 已有。                                           | 关联真实请求的分段 token、裁剪、cache hit/cost/latency 数据，再决定删减或延迟加载；不能仅按文本长短判好坏。 [来源](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)                                                                      |

模型/provider 专属 prompt variation 可以成为后续能力：当前 slot scope 只有 account/workspace/agent/session，没有直接 model/provider 维度，但角色副本/模式已能间接承载变体。建议先在现有 Eval Lab 中证明同一 wording 在目标模型间存在稳定差异，再决定是否增加该维度，避免配置组合爆炸。

### 6. 建议实施顺序与验收

| 顺序 | 改动                                                 | 可验收结果                                                                                                                             |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | F01 严格输出契约；F14/F17 账户读写 fencing           | 缺 risk/非法 enum 不得 auto-allow，保留截断 JSON 已回退控制；账户切换拒绝旧读写，补真实 UI/Host 验收。                                 |
| 2    | F02/F03/F04/F12/F13/F15/F16/F19 编辑、生效与历史一致 | stale import 被拒绝；继承/开/关可区分；preview 与同输入 runtime 静态部分一致；保存失败可见。                                           |
| 3    | F05/F06/F07/F09 解析、升级、诊断一致                 | preview 不冒充使用；draft 不改变 published target digest；contract 变动重新校验；partial catalog failure 可见。                        |
| 4    | F08/F10/F11/F18/F20 清单完整性与上下文边界           | 活跃裸协议可 inspect；每个可编辑 slot 有 sentinel 发送边界测试；附件和 transcript 来源不可混淆；judge 的上下文和 cache identity 一致。 |
| 5    | Prompt Center → Eval Lab → revision 发布闭环         | 同 dataset/model/参数比较 baseline/candidate，记录 schema 合法率、任务成功率、越权率、成本、延迟；失败可回滚。                         |

优先 acceptance matrix：title/summary、structured extraction、command judge、agent plan/verify、IM reply、memory/twin、RAG/attachments、workflow、CLI/bootstrap 各挑代表样本；至少覆盖中文/英文、空值、长值、恶意资料、异常 JSON、多 scope、两类模型、升级及账户切换。真实模型质量属于下一步可执行验证，不是本次已经得到的结果。

### 7. Reproduction and artifacts

从 repository root 执行；这些诊断断言描述当前反例，修复后应失败或被替换为正确行为断言。所有探针均没有真实模型调用或执行被 judge 的命令。

```sh
rtk proxy pnpm exec tsx docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.inventory-capture.mjs
rtk proxy pnpm exec tsx docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.judge-probe.mjs
rtk proxy node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.probes.mjs
rtk proxy node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.contract-probes.cjs
rtk proxy node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.preview-probes.cjs
rtk proxy node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-storage-probes.mjs
rtk proxy node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-ui-probes.mjs
rtk proxy node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-safety-probes.mjs
rtk proxy node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-history-probe.mjs
rtk proxy node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.md --final
```

原始现有测试日志在 `.cache/prompts-audit/focused-tests.log`、`.cache/prompts-audit/recheck-tests.log`；catalog 原始导出在 `.cache/prompts-audit/catalog.json`，可由持久化脚本重建。没有运行 coverage，没有做产品代码修改对应的全量 typecheck/lint/build，没有宣称真实浏览器/Tauri/mobile/paired-host 验收通过。

首轮 5 份诊断脚本已有成功运行记录；复审新增 4 份已运行成功并通过 Node syntax checks。当前审计文档、inventory 和 9 份脚本的 Prettier 检查、Markdown 本地链接检查和 ledger --final 检查通过。脚本成功表示成功观察到反例及控制，不表示产品缺陷已经修复。

## 修复记录（2026-11-21）

按 audit-fix 流程逐项对照当前代码复核后修复，20 项全部复现。每项修复带回归测试，测试在修复前的代码上失败、修复后通过（F14 用 `git show HEAD` 版本对换确认）。

| ID  | 结论             | 处理                                                                                                                                                                                                                                               | 提交                   |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| F01 | 属实             | 缺失或非法 risk 的 safe 判定不再批准；unsafe 无 risk 视为 high；非字符串 reason 置空                                                                                                                                                               | a0f085c767             |
| F02 | 属实             | 导入按预览读到的 binding rev 和账户数据库发布，期间被改动的槽位计入 conflicted                                                                                                                                                                     | 8c4d41d23a             |
| F03 | 属实             | 三个模式开关改为继承/开/关三态，保存原值，显式关闭不再丢失                                                                                                                                                                                         | 4782626e02             |
| F04 | 属实             | 预览的 cwd 走 `resolveEffectiveCwd`，mode 文本走同一模板替换；切换选择期间显示 loading                                                                                                                                                             | 2773f7f030             |
| F05 | 属实             | `resolvePrompt` 增加 `record: false`，预览与 Reset 计算不再刷新使用记录                                                                                                                                                                            | 8c4d41d23a             |
| F06 | 属实（已收窄）   | 评测依赖 digest 只取每个槽位已发布的 contractVersion 与正文                                                                                                                                                                                        | 3017a584b5             |
| F07 | 条件性加固       | validator verdict 缓存按定义对象区分，重注册即重新校验                                                                                                                                                                                             | 8c4d41d23a             |
| F08 | 风险属实         | 附件移入 user prompt，由 `frameExternalContent` 包裹为不受信参考材料                                                                                                                                                                               | 8b5ba79ac8             |
| F09 | 属实             | 清单报告 `failedModules`，Prompt Center 显示提示并可重试                                                                                                                                                                                           | 9efb7558ba             |
| F10 | 属实（用户决定） | 房间交接协议、房间 transcript 说明、Agent Builder 协议、项目协调者与线程协议登记为 inspect-only；RepoWiki 九个系统措辞经 `ctx.prompts` 登记并逐次解析（协议句、JSON 结构与语言指令固定在代码中）；外部 MCP server 的 prompt 按用户决定不纳入（D6） | 0235d0e0eb, 793fab4afc |
| F11 | 属实             | 守卫要求每个可编辑槽位的每个 consumer 以 id、持有该定义的名字或钉住的访问器引用它；变异测试可捕获                                                                                                                                                  | 1efe4b1f4e             |
| F12 | 属实             | Reset 对话框解析移除当前覆盖后的实际结果，并说明账户覆盖被跳过的原因                                                                                                                                                                               | 9efb7558ba             |
| F13 | 属实（另有一处） | `updateProjectDurably` 等待写入、失败回滚；只存在于上下文中的工作区改为拒绝保存（原为静默无效）                                                                                                                                                    | c58270fe01             |
| F14 | 属实             | 快照在单个数据库的一次读事务内读取，inflight 不跨库共享，只在库仍活跃时安装，resolver 忽略他库快照                                                                                                                                                 | 8c4d41d23a             |
| F15 | 属实             | 分析后按文件前导空行修正符号行号；vendored 提示词不变                                                                                                                                                                                              | 03d0b46e80             |
| F16 | 属实             | 同文本但旧 contract 的条目判为 replace 并可应用                                                                                                                                                                                                    | 8c4d41d23a             |
| F17 | 属实             | 写入固定到读取槽位时的数据库，事务内断言；切换后拒绝并提示                                                                                                                                                                                         | 8c4d41d23a, 9efb7558ba |
| F18 | 风险属实         | 续行缩进在说话人之下，transcript 说明明示参与者文本不是用户批准                                                                                                                                                                                    | 0235d0e0eb             |
| F19 | 属实             | 每个 binding 的修订时间单调递增，历史排序稳定                                                                                                                                                                                                      | 8c4d41d23a             |
| F20 | 风险属实（重述） | 判定缓存键含 cwd 与 locale；生产此前从未传 cwd，分类器与规则集的工作区锚定也随之失效，现由会话有效 cwd 懒加载提供                                                                                                                                  | a0f085c767             |

## 2026-11-22 复核 · Token 效率、准确性与修复验收

**结论。** 当前内置模板通常很短。优先级集中在 A2UI 的固定说明、AI SDK 的延迟工具清单、动态段的缓存边界，以及评测和发布之间的接线。旧问题都有对应改动。F05、F06、F10 和 F11 的原结论需要加上当前实测边界，F18 的格式修复后仍有消息角色问题。插件 authoring kit 的 ABI 核对仍失败。

范围是 2026-11-22 的本地共享工作区，基准提交为 `86c188cba4`。清单按代码与模块加载器实际枚举。通过插件进程动态注册的 RepoWiki 等模板、用户资源、第三方插件、provider 自带系统提示词及 SDK 序列化成本另算。分析使用合成输入、临时数据库和 SDK 边界替身，真实模型任务成功率、误判率、生产命中率、账单及真实 Web/Tauri/Capacitor/配对 Host 仍待实测。

### Token 测量

编码器为仓库安装的 `js-tiktoken@1.0.21`，统计 shipped 正文或指定 builder 输出。分位数采用 nearest rank。表内省略角色、消息封装、平台自带工具、工具 schema、历史、工作区文件、检索片段和用户输入。

| 样本                                       |         cl100k_base |          o200k_base | 口径                                                                                                |
| ------------------------------------------ | ------------------: | ------------------: | --------------------------------------------------------------------------------------------------- |
| 272 个已注册 slot 的 P50                   |                  62 |                  61 | 236 个可编辑、36 个 inspect-only。模块加载失败和可编辑默认正文校验错误均为 0。上次同范围是 266 个。 |
| 同上 P95                                   |                 292 |                 284 | cl100k 超过 1,000 的正文只有下面两项。                                                              |
| `chat.a2ui.protocol`                       |               5,333 |               5,573 | 正文及组件示例。A2UI 按 session/mode/agent/app 与 IM capability 决定是否注入。                      |
| `developer.workflow.copilot`               |               1,792 |               1,793 | 编辑器专用正文。实际工作流快照另计。                                                                |
| 聊天视觉路由，A2UI 关 → 开                 |         406 → 5,771 |         403 → 6,007 | 同为 artifact tool 和 inline chart 可用。使用实际视觉路由 builder 和 A2UI port，无 agent 私有组件。 |
| AI SDK 延迟工具提示，10 / 100 / 500 个工具 | 187 / 1,447 / 7,047 | 187 / 1,447 / 7,047 | 合成 MCP 名称，只测常驻名称列表和说明。延迟的 schema 未计入。                                       |
| 同为 1,024 字符，英文 / 中文               |           183 / 945 |           183 / 670 | 经现有模板渲染器截断的重复文本样本。两种编码及两种语言的比值仅适用于该样本。                        |

A2UI fixture 增加 **5,365 cl100k token** 的静态文本。更值得验证的是启用该能力后整段协议和示例是否需要常驻，以及压缩后调用和渲染成功率如何。RepoWiki 的结果缓存和 provider 的前缀缓存作用不同，前者可能跳过模型调用，后者的命中输入仍占上下文窗口。

### 当前发现与剩余功能

| ID  | 优先级               | 发现及证据                                                                                                                                                                                                                                                                                                        | 可验收改进                                                                                                                                                           |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | P1 构建              | Host 实际 ABI 校验拒绝当前 authoring kit，只有 `sdkSourceSha256` 不符。Stage 代码调用该校验，当前 release 路径仍受阻。最近一次改 pin 后，`84a538b5fe` 又改动了哈希输入中的 SDK 合约文件。                                                                                                                         | 重新发布与当前 ABI 一致的 kit，核对 Host ABI 并实际通过首方产物 staging。                                                                                            |
| T02 | P2 生效              | RepoWiki 新 prompt 在真实 `LLMClient.complete` 中可见。Overview 的 SQLite 命中发生在构造请求前。合成 revision A → B 后同一 tree hash 返回 A，模型边界调用次数保持 1。清缓存后 B 到达并产生新结果。模块缓存同样先按文件内容查缓存，依赖范围需进一步核对。                                                          | 在结果缓存身份中纳入实际生效的 prompt、模型和语言等会改变结果的输入。验证发布、模型切换与正常重复查询。                                                              |
| T03 | P2 成本 / 正确性     | 有 A2UI 的会话携带约 5.3k–5.6k 的协议。A2UI 正文将静态图表交由视觉路由，仅推荐带控件时使用 A2UI 图表。没有 artifact/inline chart 的路由却允许优先用 A2UI Chart 作回退。两段文本通过实际 builder 组合可观察到该歧义，模型影响尚未测。                                                                              | 将互斥输出路由集中给 capability-aware builder。先测短协议 + 按需组件说明的渲染成功率、错误路由率与 token，再决定拆分哪些示例。                                       |
| T04 | P2 成本 / 中文准确性 | AI SDK ToolSearch 延迟 schema，但会将全部 deferred 工具名写进 system。自由检索按 ASCII 切词。实际控制器对同一个工具的中文描述检索返回 0，英文 `orders city` 和精确选择均可激活。适用 AI SDK，这个结果不涵盖 Anthropic Agent SDK 自带 ToolSearch。                                                                 | 给发现目录独立 token 预算和可搜索分组。加入 Unicode/中文检索，保留精确选择。用不同规模目录测发现召回率、实际工具命中率、调用次数和净 token。                         |
| T05 | P2 缓存              | 当前 AI SDK Anthropic 显式第二 breakpoint 依赖 `appendSystemPrompt.endsWith(dynamicSystemPrompt)`。调用真实 `resolveSendOptions` 搭配合成动态 contribution 时，普通会话满足，加入 chart contextual skill 后后缀破坏。后置 branch seed 和 plugin transform 也能改写顺序，后一项是读码风险。未观察生产 cache miss。 | 在最终组装接口携带独立稳定段和动态段，在 sidecar 适配前检查最终请求形状。验证动态检索 + contextual skill、分支首轮与插件修改组合，并对照 provider cache read/write。 |
| T06 | P2 评测              | 现有 Eval Lab 有冻结数据集、target digest、重复试验和回放。Prompt Center 的 shipped/current/draft 比较是文本 diff。发布仅校验 scope、正文契约和并发版本。实际 target digest 仍会把 agent B 的发布计入 agent A 的 chat 实验，model variant 对照不变。                                                              | 复用 Eval Lab，对 shipped / active / draft 固定实际 prompt、model/provider、参数、运行时和数据集。关联结果至 revision。先让 digest 反映目标实际读取的有效依赖。      |
| T07 | P3 观测 / 预算       | Prompt Center 的最近使用示意由 resolver 写入。相同的 judge 输入命中应用缓存时，探针观察到 2 次解析和 1 次模型边界调用。已有上下文面板能显示桌面 Anthropic SDK 的实时分类，web/非 Anthropic 的 transcript 估算看不到 system 和 schema。模板的字符约束也不等于各模型的 token 配额。                                 | 在实际发送边界附加不含正文的 slot、revision、分段 token 与裁剪原因。区分解析、发送和结果缓存命中。用 provider usage 对齐 cache read/write，保留可解释的离线估算。    |

关键源码：

- T01 见 [Host ABI](../../scripts/build/plugin-artifact-contract.mjs) 和 [staging](../../scripts/build/stage-plugin-artifacts.mjs)。
- T02 见 [RepoWiki Analyzer](../../plugins/repowiki/repowiki/core/analyzer.py)、[Host prompt resolver](../../plugins/repowiki/repowiki/host.py) 和 [SQLite 复现](./2026-11-22-repowiki-prompt-cache-probe.py)。
- T03–T05 见 [A2UI protocol](../../lib/a2ui/prompts.ts)、[视觉路由](../../lib/ai/prompts/visual-output-prompts.ts)、[ToolSearch](../../sidecar/src/tools/adapters/ai-sdk-tool-search.ts)、[renderer 组装](../../lib/claude/build-options.ts) 与 [AI SDK dispatch](../../sidecar/src/runtimes/ai-sdk/index.ts)。
- T06–T07 见 [Eval digest](../../lib/ai/eval/project-service.ts)、[发布](../../lib/prompts/service.ts)、[Prompt Center](../../components/settings/prompts/code-prompt-detail.tsx)、[Context breakdown](../../lib/usage/context-breakdown.ts) 和 [探针](./2026-11-22-builtin-prompt-token-recheck.mjs)。

### F01–F20 逐项复核

| 项  | 结果                           | 当前证据和边界                                                                                                                                                                          |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | 回归通过                       | `command-judge.test` 与 `auto-mode-runner.test`。缺/非法 risk 的 safe 结果不会进入低风险自动允许。                                                                                      |
| F02 | 回归通过                       | `profile.test`。并发变化后的 replacement 返回 conflicted。                                                                                                                              |
| F03 | 回归通过                       | `session-settings-sheet.test`。继承、开启、关闭三态保留。                                                                                                                               |
| F04 | 原用例通过                     | `use-effective-chat-preview.test`。cwd、mode 变量和选择过渡通过。预览仍是新会话静态投影，实际请求的动态段与 provider 封装需从发送边界取证。                                             |
| F05 | 原用例通过，有相邻缺口         | 预览与 Reset 使用 `record: false`。Judge 缓存反例见 T07。                                                                                                                               |
| F06 | 原用例通过，有相邻缺口         | 保存 draft 不改变已有 published binding 的 digest。无关 scope 的 published revision 仍会使实验拒绝执行，见 T06。                                                                        |
| F07 | 回归通过                       | `resolve.test`。同版本新定义对象使旧 verdict 失效。                                                                                                                                     |
| F08 | 回归通过                       | `canvas-actions.test` 和 `use-canvas-actions.test`。附件留在 user 数据层并有外部内容标记。模型遵循率待测。                                                                              |
| F09 | 回归通过                       | `prompts-section.test`、adapter 与 catalog。加载失败可见、可重试。                                                                                                                      |
| F10 | 原登记缺口已补，缓存和发布待验 | 房间、Agent Builder、项目等协议有 inspect-only 定义。RepoWiki 九项在有调用时解析，Python 通过。外部 MCP server 延续 D6 的范围决策。RepoWiki 结果缓存和 authoring kit 见 T01–T02。       |
| F11 | 覆盖增强                       | Slot/consumer 守卫及 override 测试集通过。Catalog 自动守卫匹配测试源文件中的 slot/collection 与 override 机制，存在两者同文件但某条用例没有实际发送的可能，不能替代逐路径运行断言。     |
| F12 | 回归通过                       | `code-prompt-detail.test`。Reset 显示真实继承内容和跳过理由。                                                                                                                           |
| F13 | 回归通过                       | Workspace adapter 和 project persist。持久化失败可传播并回滚。                                                                                                                          |
| F14 | 本地回归通过                   | `snapshot.test`。fake IndexedDB 测试不同账户的快照隔离和 inflight。真实账户/Host 接受度见 X3。                                                                                          |
| F15 | Python 回归通过                | `test_symbol_lines.py`。前导空行引用行号控制通过。                                                                                                                                      |
| F16 | 回归通过                       | `profile.test`。相同正文的旧 contract 能重新发布，新 contract 的同正文仍为 unchanged。                                                                                                  |
| F17 | 本地回归通过                   | `service.test` 与 `prompt-overrides.test`。发布固定到读取时的数据库。真实账户/Host 接受度见 X3。                                                                                        |
| F18 | 续行原用例通过，信任边界待验证 | `team-transcript.test`。续行缩进且协议说明参与者原话不代表批准。生产 [room runner](../../lib/chat/room/runner.ts) 仍把整个 transcript 拼入 system，模型误读率和授权边界需在运行时验收。 |
| F19 | 回归通过                       | 单 binding revision 时间单调，历史与旧的 Unavailable UI 失败用例均通过。                                                                                                                |
| F20 | 本地回归通过                   | `command-judge.test` 验证 cwd/locale cache identity。renderer 事件测试通过，生产传入 effective cwd。                                                                                    |

X6/X7 的 catalog、RepoWiki 可编辑措辞和 config-governance 分套通过。仍有两个额外失败。Slot hook 的旧断言期望空对象，账户写入 fencing 后实际形状包含 `database`，独立复跑仍失败。组装的 trial skill 旧断言要求将 4,000 token 预算传给显式 skill，当前有意将显式 skill 单独完整渲染，断言失败。两项测试原样保留。

### 业内实践和取舍

| 实践                             | Cognia 已有                                                                | 当前差距                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 稳定前缀、provider usage 对账    | stable/dynamic 拆分、工具排序、compaction，以及部分缓存用量入账。          | T05 的晚期组装能破坏缓存边界。使用同一合成任务做冷/热/变更后三组跑数，记录读取、写入、首次响应延迟与总成本。 [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [Claude Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)                                                                                                          |
| 最小有效上下文与按需发现         | Skills catalog/loader、AI SDK 和 Claude Agent SDK 各有工具延迟加载。       | 优先量测 T03–T04，工具名及说明也占上下文。对有原生能力的 provider 可比较直接 defer，其他 provider 继续用本地发现机制。 [OpenAI Tool Search](https://developers.openai.com/api/docs/guides/tools-tool-search) · [Anthropic Context Engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)                                                                              |
| 结构化输出与独立判定             | 槽位有变量和必保片段校验。Judge 有运行时枚举校验、安全回退与独立权限判定。 | 选高价值、可解析的输出先试 provider schema。在无能力的模型保留同等严格的运行时 parser 和失败回退，并用任务样本衡量语义误判。 [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)                                                                                                                                                                                  |
| 冻结样本、分阶段发布及可回退版本 | Eval Lab、历史、diff、已发布 revision、恢复与 profile 已存在。             | 将 Prompt Center 的候选绑定到 Eval Lab 的同样本 A/B，发布记录关联通过的实验和回滚点。先覆盖典型、边界与对抗数据，按任务用确定性断言或人工判分。 [OpenAI Evals](https://developers.openai.com/api/docs/guides/evaluation-best-practices) · [Anthropic Evals](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests) · [LangSmith Prompts](https://docs.langchain.com/langsmith/manage-prompts) |

建议先处理 T01，并用 RepoWiki cache probe 与 digest fixture 固定 T02/T06 的生效契约。随后对 A2UI 和 ToolSearch 做低成本对照，先跑可复现的序列化与中文召回，再接真实 provider。验收同时看任务成功率与成本每成功任务。优先数据集为 A2UI（输出路由和渲染）、ToolSearch（中/英文召回和工具调用）、RepoWiki（引用、语言和缓存）、Judge（误放/误拦、异常输出/OOD）。每组冻结模型、配置和样本，用未参与调参的样本比较任务指标、首次可用结果延迟、重试数与实际用量。

### 复核记录

| 执行                                                                             | 实际结果                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt Center、hook、storage、CLI，加 F01/F03/F06/F08/F13/F18/F20 核心回归       | 55 suites，54 通过、1 失败。899 tests，898 通过、1 失败。失败为 `use-prompt-slots.test.ts:23` 的 database 字段，独立复跑仍为 1 通过、1 失败。                                                                                                |
| `build-options.test.ts`、`prompt-partition.test.ts`、`context-breakdown.test.ts` | 3 suites，2 通过、1 失败。600 tests，599 通过、1 失败。失败为 trial skill 预算断言。                                                                                                                                                         |
| AI SDK dispatcher、ToolSearch、compaction                                        | 199 tests 全过。包含 Anthropic 第二缓存 breakpoint 的正常后缀控制。                                                                                                                                                                          |
| Renderer 动态后缀对照                                                            | 复用 `build-options.test.ts` 的 module-contribution fixture，添加 `cache: "turn"` 的 agent-knowledge 哨兵，比较同 fixture 无意图和 `skillIntents: ["chart"]`。1 个反例探针通过，对照后缀匹配，chart 条件下有 contextual skill 且后缀不匹配。 |
| Config-governance/插件 API                                                       | 4 suites，29 tests 全过。                                                                                                                                                                                                                    |
| RepoWiki 符号行号、prompt 声明、模板、cache key                                  | 4 文件，31 tests 全过。SQLite 反例脚本单独通过。                                                                                                                                                                                             |
| Node token 与准确性探针                                                          | catalog、实际视觉 builder、ToolSearch、语言差值、无关 scope digest 与“最近使用”反例。                                                                                                                                                        |
| Host authoring ABI                                                               | `readHostAuthoringIdentity` 拒绝。逐项比较 `readHostAuthoringAbi` 与 pin，仅 `sdkSourceSha256` 不同。                                                                                                                                        |

从仓库根目录复现主要测量：

```sh
rtk proxy pnpm exec tsx docs/evidence/2026-11-22-builtin-prompt-token-recheck.mjs
rtk proxy node scripts/test/run-sidecar-tests.mjs sidecar/src/runtimes/ai-sdk/index.test.ts sidecar/src/tools/adapters/ai-sdk-tool-search.test.ts sidecar/src/context/compaction.test.ts
rtk proxy node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.md --final
```

RepoWiki 在 `plugins/repowiki` 下复现：

```sh
PYTHONPATH=. rtk proxy .venv/bin/python ../../docs/evidence/2026-11-22-repowiki-prompt-cache-probe.py
rtk proxy uv run --offline --no-sync --with pytest --with pytest-asyncio python -m pytest -q -p no:cacheprovider tests/test_symbol_lines.py tests/test_editable_prompts.py tests/test_prompts.py tests/test_cache_keys.py
```

测试和探针输出保存在 `.cache/prompt-token-recheck-*`，本轮变更限于审计记录及离线探针。

## 2026-11-22 反证复审 · 完整问题清单

本轮复核的三个主张是成本数字应能追到实际请求形状，已发布的修订应在正确目标和正确缓存身份下生效，以及旧 fixes 的回归应覆盖用户会触发的组合。前两项关系到成本和结果的归因，后一项关系到编辑和发布是否会落到用户当前选择的目标。工作区基准仍为 `86c188cba4`。三名 fresh-context reviewer 分别拿到 prompt/工具/缓存装配、插件/RepoWiki/Eval、修复提交与回归测试的 artifact 和契约。他们没有收到前轮结论。按用户选择，复审使用同模型独立上下文和本地实验。

### T01–T07 逐项判定

| ID  | 优先级与状态                                | 复审证据及边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | P1 · 确认构建阻断                           | 两个本地完整制品集均被默认 `stagePluginArtifacts` 的实际 Host ABI 检查拒绝，发生在 staging 写入前。唯一差异是 `sdkSourceSha256`。用旧 pin 作隔离 oracle 的语义校验能通过，Node 制品兼容/拒绝控制共 27 项全过。SDK 哈希输入在最近一次修改 pin 后被 `84a538b5fe` 改动。实际签发新 kit 或完整发布未执行。另见 T14。                                                                                                                                                                                                          |
| T02 | P2 · 确认并扩大证据                         | 运行真实 Analyzer 全部阶段、SQLite 和 Python bridge，合成文件首次发送 4 次。重复输入、修订 A→B、英文→中文、模型 A→B 均复用完整旧结果，新增 resolver/发送均为 0。清缓存后 4 次新调用带新修订，概览明确带中文语言指令。另有内容身份反例，同大小入口文件改动改变概览 prompt 但键相同，模块文件名和内容边界变更可以得到同键。结果复用结论限于 scan analyzer 缓存，冷调用的解析对照通过。                                                                                                                                      |
| T03 | P2 · 成本确认，措辞歧义收窄                 | 重新测量原 builder 得到 406→5,771。用真实 renderer 组装和 AI SDK Anthropic adapter，在拦截的序列化主请求中，同一合成新会话 A2UI off/on 的 system 正文为 593→5,880，完整 JSON 为 709→6,745。该对照只向 sidecar 转交 prompt 字段。无 dock/inline chart 的回退场景仍会同时说静态图表交由视觉规则、带控件时用 A2UI Chart，并推荐 A2UI Chart 回退。这是两段指引没有显式说明优先级的歧义，未证明模型选错路由。                                                                                                                  |
| T04 | P2 · 确认名称负担和中文缺口，排除净成本泛化 | 10/100/500 个合成工具的完整长名称进入序列化请求，目录独立正文 187/1,447/7,047 token，工具定义分别为 1 个 ToolSearch。带三字段 schema 的首次请求仍明显省 token。另三个极简 schema fixture 开启后反而增加 JSON token。用英文名称、中文描述验证中文自由查询 0，英文及精确选择均为 1。原生 Claude Agent SDK 的 ToolSearch 未做相同 wire 捕获。另见 T08。                                                                                                                                                                      |
| T05 | P2 · 请求层确认                             | 使用同一动态 contribution 的 renderer→sidecar→Anthropic adapter 捕获 `cache_control`。chart intent 在 A2UI off 组确实追加 contextual skill，原两个 system breakpoint 变为一个。A2UI on 的 chart 对照没有追加该 skill，保持两个。另测无 base 的合法形状，整个 append（含动态段）获得唯一 system breakpoint，单改动态段就改变该块。后置 branch seed 和 plugin transform 的可能性仍为路径证据。结论仅涉及实际请求中的 system breakpoint 与块内容，缓存命中、history breakpoint、原生 Claude Agent SDK 和 provider 账单另验。 |
| T06 | P2 · 确认，影响到执行                       | 实际 Eval digest 和任务 executor 的本地替身显示，发布另一工作区插件的提示词或只改评测 agent 的头像/更新时间，都使任务在 `buildTarget` 前拒绝。仅保存未发布草稿的对照到达目标构建，model variant 对无关 slot 控制不变。Prompt Center 有文本 diff、历史和直接发布，未找到将同一 slot 的内置/已发布/草稿三版接入冻结样本评测，以及绑定可追溯发布证据的路径。                                                                                                                                                                 |
| T07 | P3 · 观测缺口确认                           | Judge cache hit 仍记第二次解析，但模型边界只有一次。直接调用插件解析接口也会记最近使用，记录仅按 prompt id 隔离，模拟账户切换后仍显示先前记录。记录保留的是标识、来源、时间和上下文。没有观测到正文本身泄漏。Web transcript fallback 看不到 system/schema 是已知范围，桌面已有 SDK 分类。字符差异是预算设计限制，样本比值不能外推。                                                                                                                                                                                       |

**请求层数据。** `js-tiktoken@1.0.21` 的 `cl100k_base` 计数，与 provider usage 分开。直接拦截 SDK 构造的 Anthropic POST 并返回现有合成 SSE，未创建网络连接。工具尺寸为合成样本。

| 场景                            | 关闭时 | 开启时 | 观察对象                                                          |
| ------------------------------- | -----: | -----: | ----------------------------------------------------------------- |
| A2UI 主对照                     |    593 |  5,880 | system 正文，A2UI 开关之外条件相同                                |
| A2UI 主对照                     |    709 |  6,745 | JSON 序列化请求                                                   |
| ToolSearch，3 个极简 schema     |    127 |    285 | 同三工具，首次 JSON 请求                                          |
| ToolSearch，10 个三字段 schema  |    994 |    432 | 同十工具，首次 JSON 请求                                          |
| ToolSearch，100 个三字段 schema |  9,274 |  1,692 | 同百工具，首次 JSON 请求                                          |
| ToolSearch，500 个三字段 schema | 46,074 |  7,292 | 同五百工具，首次 JSON 请求。未验证 provider 是否接受 eager 请求。 |

首次请求之外，工具发现、随后激活的 schema 和结果也要计入整任务成本。缓存边界的反例不依赖上述本地 token 编码器。

### 补齐的缺口

| ID  | 优先级与状态              | 证据和影响                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T08 | P3 · 条件性缺陷           | ToolSearch 排名和最终激活顺序不同。合成 cap=2 时，`search_records` 排首位，最后只激活 `zzed`。cap=1 对同请求返回匹配但无激活。cap=5 激活三个。测试的是低 cap 条件，未确认生产 provider 实际给出该 cap。                                                                                                                                     |
| T09 | P2 · 确认能力投影遗漏     | App 默认 custom A2UI catalog 可由 renderer 选择；prompt 侧仅接收 character catalog id。合成组件在只设置 app 默认时缺席，显式传入同一 catalog 后出现。没有测模型能否自行推断目录。                                                                                                                                                           |
| T10 | P3 · 源码确认             | Mermaid 渲染关闭时，视觉指引仍称 Mermaid fence 会原地渲染。完成态与流式 renderer 都读取开关，组装器只将 chart 设置传给视觉路由。证据是显示设置和 prompt 不一致，未测模型输出后果。                                                                                                                                                          |
| T11 | P2 · 确认错误写入         | Prompt Center 在 Workspace A→B 切换时，live query 暂时保留 A 的返回值，editor 用 B 的选择 key 初始化 A 的正文。A/B 同为 rev1 时，B 数据到达后也不重置正文。用实际组件、live query、service、事务和 fake IndexedDB，点击 Publish 后 B 的 rev2 存的是 A 的文本。B 起始 rev2 的对照会正确载入并发布 B。                                        |
| T12 | P2 · 确认多阶段输入不同步 | Profile remap 到 B 后，旧预览未失效且 Publish 可点击。立即点击写到旧 A，等 B 预览完成的对照写到 B。两真实 synthetic Dexie DB 控制中，逐条预览可流过账户切换并产生混合 DB 列表。批次已在 A 写第一条后切到 B，会抛 `prompt_override_account_changed`，A 第一条保留，第二条和 B 均未写，调用方只有失败提示。无切换应用 2 条。单条 CAS 仍有效。 |
| T13 | P2 · 确认回退状态丢失     | 注入实际 snapshot 读失败时，resolver 有 `snapshot-unavailable`，Host plugin API 把它压成普通 `{text,source:"default"}`。正常无覆盖也返回相同形状。RepoWiki Python 在该返回形状下继续使用出厂 wording。现有 Python 测试覆盖 transport 抛错，未覆盖 Host 明示成功但内部回退。                                                                 |
| T14 | P2 · 构建校验缺口         | Authoring kit 会打包 Python SDK wheel，但 Host ABI 的 SDK 源哈希未覆盖该 Python 源树。合成 ABI 夹具更改 Python SDK 方法签名，旧 pin 仍通过；改变 TS 声明的对照被拒绝。此项是校验边界，不代表本次已有不兼容 wheel 发版。                                                                                                                     |
| T15 | P1 · 确认输入检查遗漏     | Judge 仅对命令正文做 PII 检查，随后拼接 cwd。合成测试中无 PII 的命令加含模拟联系信息的 cwd 到达 stub LLM client，完整输入被同一 gate 判为不合格。含相同标记的命令正文被拦截，普通 cwd 通过。直连 renderer 的实际 utility client 将 prompt 交给 generation SDK，配对 Host 客户端另有深度 gate。未发送到真实 provider。                       |

相关位置见 [工具排序](../../sidecar/src/tools/adapters/ai-sdk-tool-search.ts)、[A2UI 渲染 catalog](../../lib/a2ui/runtime-settings.ts)、[发送组装](../../lib/claude/build-options.ts)、[Mermaid 显示](../../components/chat/markdown-renderer.tsx)、[Prompt Center editor](../../components/settings/prompts/code-prompt-detail.tsx)、[Profile dialog](../../components/settings/prompts/prompt-profile-dialog.tsx)、[Profile 服务](../../lib/prompts/profile.ts)、[插件解析响应](../../lib/plugin/api/prompts-api.ts)、[Python bridge](../../plugins/repowiki/repowiki/host.py) 和 [Kit 构建](../../scripts/plugin/authoring-kit.mjs)。

### F01–F20 再判定

| ID  | 当前修复判定                           | 验证与限制                                                                                                                                                                                                    |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | 原缺陷本地回归通过                     | command judge 与 auto-mode runner 对缺失/非法 risk 保守。样本不执行命令，真实模型分类准确率仍待测。                                                                                                           |
| F02 | 原 CAS 回归通过，发现相邻 UI 缺陷      | 同一 slot 在预览后被并发发布会产生冲突。映射变化与批次账户隔离另见 T12。                                                                                                                                      |
| F03 | 本地回归通过                           | Session sheet 保留 inherit/on/off 以及已有显式 false。                                                                                                                                                        |
| F04 | 原用例通过，普通 Plan 预览发现实质差异 | 原 cwd、变量、选择过渡回归通过。正常 Plan 组合使用 `agent.plan-mode` 运行时附加段，预览展示 legacy `agent.mode.plan`。实际 builder 捕获确认两个槽位有独立生效路径，显式 legacy mode 仍可达。                  |
| F05 | 原预览误记已修，最近使用语义未合拢     | 预览和 Reset 的 `record:false` 控制通过。Judge 缓存与插件只解析仍记为最近使用，见 T07。                                                                                                                       |
| F06 | 原 draft 回归通过，目标依赖仍过宽      | Published 旁的 draft 不再让实验拒绝执行。其他 agent/workspace 的发布及头像变化仍会触发 T06。                                                                                                                  |
| F07 | 条件性加固回归通过                     | 同版本新定义对象重新验证。正常升版仍通过原控制。                                                                                                                                                              |
| F08 | 消息角色修复回归通过                   | Canvas 普通与流式模型边界将附件置于 user 数据，并加外部资料标记。行为遵循率未测。                                                                                                                             |
| F09 | 局部失败和恢复回归通过                 | 模块加载失败可见并可重试。动态插件完整发版受 T01 影响。                                                                                                                                                       |
| F10 | 约定的登记已补，路径仍有缺口           | ADR 范围内的协议登记和 RepoWiki 9 个字段可解析。MCP server 外部消费沿用 D6。RepoWiki 的缓存复用与 fallback 分别见 T02、T13，发版见 T01。                                                                      |
| F11 | 守卫增强，原关闭结论过宽               | 逐 consumer 的 slot 名称与 accessor 守卫、已有 sentinel suites 通过。Catalog 检查按测试文件匹配 slot 和 override 机制，无法证明所有路径执行了真实发送断言。缺少可追溯逐 consumer 的语义验收，保留为测试缺口。 |
| F12 | 账户回退原用例回归通过                 | Reset 使用 resolver 的 account fallback，显示有效覆盖或跳过原因。对更具体上下文的提示为已知范围。一般 editor 切目标错误另见 T11。                                                                             |
| F13 | 持久化回归通过                         | Workspace instructions 落盘后才宣告保存，错误传播并回滚。                                                                                                                                                     |
| F14 | 跨账户快照回归通过                     | fake IndexedDB 与独立竞态控制均隔离 A→B。一个同账户读若在 publish 前开始，完成晚于新快照时可拿到旧版本；publish 后新发起的读取是新版本。对重叠读与已冻结的 turn 保留时序边界，未列成已经发生的跨账户回归。    |
| F15 | 行号修复回归通过                       | RepoWiki 前导空行锚点回归通过。T02 另涉及命中旧结果时重新使用旧分析文本。                                                                                                                                     |
| F16 | 正常升版回归通过                       | 同正文旧 contract 的 profile 条目可重新发布；同 contract 重复仍判 unchanged。                                                                                                                                 |
| F17 | 单条写入隔离回归通过                   | Publish 在 digest 后身份变化时拒绝，事务绑定来源 DB。Profile 的多条批次部分成功另见 T12。                                                                                                                     |
| F18 | 续行格式修复回归通过，角色边界仍存在   | Team transcript 缩进和说明有效，actual room runner 仍把 transcript 加入 system。模型误读率和实际授权后果无实测。                                                                                              |
| F19 | 排序回归通过                           | 单 binding 时间单调，历史和 Unavailable slot 查询顺序的原红用例通过。                                                                                                                                         |
| F20 | cwd/locale 回归通过，新增隐私边界缺口  | 判定缓存按 cwd、locale 和 context 区分，renderer 提供 effective cwd。T15 证明新拼入的 cwd 未经过 judge 的整段检查。T07 是应用缓存命中仍更新使用记录，属于不同问题。                                           |

### 排除和证据限度

- 延迟加载的名称列表确实占空间，实测同时出现净增和净减。不能把名称正文数字当作净 token 变化。
- A2UI chart 文案判定为歧义。无 A2UI MCP 定义的主对照只转交了 prompt，不能由此推断用户的 A2UI 工具一定无法调用。A2UI 模式开关在其他轨道究竟控制提示、工具还是显示，需要区分。
- 缓存块上的 `cache_control` 已在序列化 JSON 实测。该证据不能推断整个请求的缓存命中率或生产花费，也不能覆盖 native Claude Agent SDK。
- 同账户旧快照仅对与写入重叠的读观察到。F14 的 A→B 控制和发布后新读未出现旧版本。未将该时序、正确的 broadest-first 排序、或已经声明的静态预览省略加入缺陷清单。
- F11 guard 是源文本启发式，测试文件的存在不是运行证据。当前两条原红断言分别为 slot 的 `database` 字段和试用 Skill 的预算期望；没有因此改弱现有测试。
- 本轮重点结论可在合成夹具中确定。真实账户/设备、供应商用量和模型结果以及全量产品构建仍是开放验收，未修改产品源码。

### 复现记录

主要探针在仓库根目录运行：

```sh
rtk proxy pnpm exec tsx docs/evidence/2026-11-22-builtin-prompt-token-recheck.mjs
rtk proxy pnpm exec tsx docs/evidence/2026-11-22-builtin-prompt-wire-doubt.mjs
rtk proxy node docs/evidence/2026-11-22-builtin-prompt-editor-doubt.mjs
rtk proxy node --test scripts/build/plugin-artifact-contract.test.mjs scripts/build/stage-plugin-artifacts.test.mjs
```

RepoWiki 在 `plugins/repowiki` 下运行本地 venv：

```sh
PYTHONPATH=. rtk proxy .venv/bin/python ../../docs/evidence/2026-11-22-repowiki-prompt-cache-probe.py
rtk proxy uv run --offline --no-sync --with pytest --with pytest-asyncio python -m pytest -q -p no:cacheprovider tests/test_symbol_lines.py tests/test_editable_prompts.py tests/test_prompts.py tests/test_cache_keys.py tests/test_incremental.py
```

本轮统计为 focused Jest 59 suites 中 58 通过，928 tests 中 927 通过。组装 Jest 599/600，AI SDK sidecar 199/199，ABI 和 staging 27/27，RepoWiki 33/33。Mounted editor/profile 反例和正向对照 4/4。原有两条 Jest 红断言分别位于 `use-prompt-slots.test.ts` 和 `build-options.test.ts`。

T12 的批次账户切换与 F14 的重叠读取可另运行 `node .cache/prompt-doubt-2026-11-22/profile-races.cjs` 和 `node .cache/prompt-doubt-2026-11-22/snapshot-race.cjs`。这些夹具只包含合成数据库。

本机原始日志与独立 reviewer 的合成 DB 夹具保存在 `.cache/prompt-doubt-2026-11-22/`。退出时回收临时 Jest fixture。反例探针成功意味着观察到了反例和控制。

## 2026-11-22 修复记录（audit-fix 第二轮 · D10 / V14）

针对 `2026-11-22` 反证复审清单（T01–T15、F01–F20、X9）完成逐条源码核查、同类路径排查、根因修复与同目录回归测试：

| 范围 | 修复摘要 |
| --- | --- |
| **T01, T14** | `readHostAuthoringAbi` 将 `plugin-sdk/python/pyproject.toml` 与 `plugin-sdk/python/src/**/*.py`（排除 `__pycache__`、`*.egg-info` 及测试文件，拒绝符号链接）纳入 `sdkSourceSha256`；更新 `author-types` bundle、重签 `lib/plugin/distribution/authoring-kit.json`，并通过 `stage-plugin-artifacts.mjs` 全量校验与落盘。 |
| **T15 及同类直连路径** | `command-judge` 对拼接 `cwd`、`locale` 后的完整出站 prompt 及自定义规则做 `hasNoLeakingPii` 门禁；同步排查并补齐 `difficulty-judge`、`use-ai-diff-explain`（subject/customInstructions）、`use-ai-diff-review`（file.path/customInstructions）、`use-ai-commit-message`（staged files/customInstructions）、`ai-issue-assist`（projectName/labelNames/candidates）和 `turn-label` 的完整出站 PII 检查。 |
| **T07 及同类统计路径** | `resolution-log` 按活跃账户数据库分区并订阅切库通知；`command-judge`、`difficulty-judge`、终端/行内补全、`ai-shell`、`ai-commit`（model 轨道跳过 agent clause）、`cli prompts show`、`ctx.prompts.resolve`（默认 `record: false`，实际发送插件显式传 `record: true`）与 RepoWiki 预解析（缓存命中不记使用）统一改为仅在真实发送路径记录最近使用。 |
| **T11, T12, X9** | `usePromptSlot` 绑定活跃库与 `queryKey`，切换目标或账户同步清空旧快照；`CodePromptDetail` 将 `seedKey` 扩展到目标三元组以消除同 rev（A rev1 → B rev1）错写；`useOwnerPromptDocument` 在同一 `resource.key` 重渲时保留未保存草稿、切库重载；Profile 导出/预览/批量发布加账户栅栏，新增单事务原子 `publishPromptOverrideBatch`，导入弹窗在重映射预览未就绪时禁用勾选与发布；修复 `use-prompt-slots.test.ts` 与 `build-options.test.ts` 两条既有红断言（X9）。 |
| **T02, T13** | `PluginPromptsAPI.resolve` 透传 `fallback` 与 `skippedRevisionId`；RepoWiki `resolve_system_prompts` 对 `snapshot-unavailable` 抛 `LLMError` 阻断静默出厂回退；`Analyzer` 四阶段缓存键改用规范化 JSON 哈希并纳入生效系统提示词、语言、模型身份、入口/配置文件正文及模块文件路径边界。 |
| **T03–T06, T08–T10, F04, F11** | `build-options` 导出 `appendStableSection` 保持 contextual skill、branch seed、connector dispatch、room transcript 与 structured instruction 不破坏 `dynamicSystemPrompt` 后缀，AI SDK sidecar 修复无 base 时动态段误打 `ephemeral` 断点及 `@agent` 多段前缀断点位置（T05）；ToolSearch 增加 CJK 短语/二元组召回（T04）并修复低 `cap`（含 `cap=1`、`cap=2`）排名激活一致性与 `unloaded` 过滤（T08）；A2UI 协议投影 `appSettings.a2uiDefaultCatalogId`（T09）并消除无 dock 回退下的静态图表措辞冲突（T03）；视觉路由接入 `messageDisplay` / `messageDisplayOverride` 的 `markdown.mermaid` 开关并新增 `chat.visual-output.mermaid` / `no-mermaid` 槽位与双语词条（T10）；Eval 目标依赖收窄至当前目标适用作用域并剔除头像/时间戳等非语义字段（T06）；普通 Plan 预览对齐发送路径使用 `agent.plan-mode`（F04）；`build-options.test.ts` 遍历全部 `BUILT_IN_MODE_PROMPTS` 校验覆盖生效（F11）。 |

**留待用户决策的产品/协议取舍**：(1) T03 是否将 `chat.a2ui.protocol` 中 67 个标准组件起始描述符拆分为按需加载；(2) T04 是否为极小工具目录设置自动跳过 `ToolSearch` 的阈值或对常驻名称做分组摘要；(3) T06 是否在 Prompt Center 新增同一槽位 `shipped / active / draft` 三版本一键送入 Eval Lab 并绑定发布证据的跨模块工作流；(4) F18 多 Agent Room 是否将参与者历史 transcript 从 `system` 移入 `user` 消息层。
