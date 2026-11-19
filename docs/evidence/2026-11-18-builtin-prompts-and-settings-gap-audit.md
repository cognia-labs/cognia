# Evidence ledger: builtin prompts and settings gap audit

- Status: verifying
- Lane: deep
- Created: 2026-11-18
- Updated: 2026-11-18
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

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                               | State       | Basis                                                                                         | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- | ---------- |
| O1  | Prompt Center, revisioned overrides, owner adapters and module contributions exist.                                                     | Verified    | lib/prompts/catalog.ts; ADR-0236; source read 2026-11-18                                      | -          |
| H1  | The main gaps are missing prompt-management features.                                                                                   | Invalidated | Rich management, eval and replay capabilities verified in source; inventory below, 2026-11-18 | O1         |
| H2  | Existing management features have runtime, concurrency or verification gaps.                                                            | Verified    | Bounded runtime probes and reconciled findings F01–F20 below, 2026-11-18                      | O1         |
| G1  | Inventory built-in prompts and settings, identify defects and gaps, compare current primary-source practices.                           | Agreed      | User request 2026-11-18                                                                       | -          |
| C1  | Audit only; preserve concurrent source changes and user data; no production prompt changes or external model sends.                     | Verified    | User asks analysis; shared tree status 2026-11-18                                             | -          |
| O2  | CodeGraph has no index in this checkout.                                                                                                | Observed    | codegraph explore returned no-index error 2026-11-18; use source search                       | -          |
| G2  | Challenge the original 13 findings and 2 candidates, remove overclaims, add omissions, update this ledger without product changes.      | Agreed      | User follow-up 2026-11-18                                                                     | G1, C1     |
| O3  | Three fresh reviewers reproduced narrower contracts with controls; two candidates now have isolated lifecycle/contract counterexamples. | Verified    | Adversarial storage/UI/safety scripts and reconciliation below, 2026-11-18                    | O1         |
| C2  | No product changes, original-test edits, user-data access, real model sends or external CLI review without authorization.               | Verified    | User follow-up and bounded probe execution, 2026-11-18                                        | C1         |

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

| ID  | Risk (impact)                                                                   | Severity | Source                                | Claim                                                         | Refuted by                                                                          |
| --- | ------------------------------------------------------------------------------- | -------- | ------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| R1  | Incomplete inventory falsely labels existing functionality missing.             | high     | ADR-0236; FMEA                        | Every reported family maps to an owner and consumer.          | Existing implemented feature contradicts a gap claim.                               |
| R2  | Saved overrides diverge from preview or runtime, or overwrite concurrent edits. | high     | ADR-0236; shared-state lens           | Overrides preserve scope, authority and revision semantics.   | Deterministic counterexample or traced bypass.                                      |
| R3  | Syntactic tests are mistaken for model quality or injection resistance.         | high     | Anthropic evaluation guidance; STRIDE | Findings explicitly state evidence strength and scope.        | Real model quality claimed from mocked or string-only tests.                        |
| R4  | Industry advice is outdated or ignores Cognia architecture.                     | medium   | Primary-source comparison             | Recommendations link current sources and existing mechanisms. | Advice requires replacing a capability already present or contradicts current docs. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk       | Method                                                                                        | Independence   | Evidence                                                                                                                                                              | Coverage                                                                                                   | Status  |
| --- | ---------- | --------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1         | Inventory code slots, owners, settings and runtime consumers.                                 | tool           | inventory-capture.mjs: 266 definitions, 0 module failures, 0 editable default validation errors; full inventory linked below.                                         | Registered shipped slots complete for this load; dynamic plugins and raw text families separately bounded. | passed  |
| V2  | R2         | Run focused tests and isolated counterexample probes.                                         | tool           | 45 suites: 43 passed / 2 failed; 544 passed / 3 failed. Narrow rerun: 79 passed / 1 failed. Diagnostic probes reproduce findings; see verification record.            | Existing baseline is not green. Pure and stub-backed counterexamples only; no provider calls.              | failed  |
| V3  | R1, R2, R3 | Fresh-context failure hunt of source and audit assumptions.                                   | fresh-reviewer | Independent reviewer found preview parity, stale verdict cache, draft/eval invalidation, and usage-log ambiguity; reproduced in persisted probes.                     | Findings reconciled against source and existing controls; no full UI/device acceptance.                    | passed  |
| V4  | R4         | Read current primary documentation.                                                           | tool           | OpenAI, Anthropic, LangSmith, Cursor and Claude Code primary sources retrieved 2026-11-18 and mapped below.                                                           | Documented practices, not benchmark rankings.                                                              | passed  |
| V5  | R3         | Model-quality and real-shell acceptance.                                                      | real-env       | Not run in this source audit.                                                                                                                                         | Requires representative datasets, selected models and shell matrix.                                        | blocked |
| V6  | R1, R2, R3 | Fresh-context doubt-driven review in three bounded domains.                                   | fresh-reviewer | Storage, UI and safety/catalog reviewers returned independent findings; all 13 originals and both candidates reconciled below.                                        | Same-model independent context; no external model review performed.                                        | passed  |
| V7  | R2, R3     | Stronger lifecycle, transaction, mounted UI, loader and output-boundary probes with controls. | tool           | Storage: 10 JSON results; safety: 25 result/control records plus completion; history: 2 controls; UI: 4 suites, 9 selected probes passed, 71 inherited tests skipped. | Actual modules with explicitly isolated dependencies; no browser/native/provider acceptance.               | passed  |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                           | Action   | Based on       | Reversal trigger                                                                                      |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | 2026-11-18 | Inventory and diagnose before recommending additions; use isolated probes.                                                                                                         | diagnose | O1, G1, C1     | Evidence reveals a different prompt owner or execution path.                                          |
| D2  | 2026-11-18 | Deliver an audit and reproducible evidence; prioritize existing boundary defects before adding new management infrastructure. H1 is ruled out.                                     | stop     | O1, H2, G1, C1 | Real runtime evidence contradicts findings or user requests implementation.                           |
| D3  | 2026-11-18 | Re-enter diagnosis for G2; independently challenge artifacts and contracts before updating conclusions.                                                                            | diagnose | G2, C2         | Stronger evidence disproves an original finding.                                                      |
| D4  | 2026-11-18 | Retain bounded defects and risks, correct unsupported expansions, promote C-A/C-B with limits, add five standalone findings and one F04 subcase. Stop this review cycle; no fixes. | stop     | G2, O3, C2     | Real shell/provider evidence contradicts the isolated results, or the user authorizes another review. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                        | From   | Why still open                                                                                                  | Next action                                                                                         | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| X1  | Existing focused test failures remain; no product fix was requested.                                                            | V2     | Audit preserves the shared checkout and assertions.                                                             | Repair chronology/order tests and verify underlying storage ordering.                               | open   |
| X2  | Real-provider prompt quality, attack outcome, desktop/mobile/paired-host parity are unmeasured.                                 | V5, R3 | Mounted jsdom UI and isolated DB exercised; no real browser/native/provider/account-vault flow.                 | Execute the proposed acceptance matrix with controlled accounts and representative fixtures.        | open   |
| X3  | Cross-account read/write races are reproduced in isolated actual core DB lifecycle, not verified in full account UI/Host/vault. | R2     | Fake IndexedDB and inert peripheral middleware bound the evidence; production timing/frequency remains unknown. | Run full account/vault/Host acceptance; fence both reads and writes by account identity/generation. | open   |
| X4  | Full semantic quality of every prompt and runtime-loaded third-party plugin is not established by the inventory.                | R1, R3 | Registry enumeration is complete for this load; content review is risk-focused.                                 | Extend feature-specific datasets and capture enabled plugin inventory in the intended deployment.   | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                                 | How / when measured     | Result                                                                                                                                                   | Status |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | User has an evidence-linked inventory, prioritized findings and industry comparison.                   | Audit report 2026-11-18 | Full inventory, settings map, 20 reconciled findings and comparison delivered below; C-A/C-B promoted with explicit limits. No product behavior changed. | met    |
| M2  | The follow-up separates genuine defects from overclaims and adds omissions with reproducible controls. | Doubt review 2026-11-18 | All 13 originals retained in narrower categories; both candidates promoted; five new standalone findings and a preview-transition subcase added.         | met    |

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
