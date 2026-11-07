# Cognia 默认流程（六套）设计

状态：已定稿（2026-11-07，grill 五轮，§4.1–4.5；§4.5 修订了 §4.4 的部分结论），待实施，从 F0 开始。创建：2026-11-07（Asia/Shanghai）。证据取自 `dev` 的 `c05a61cd5d`。

上游：

- [ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md)：房间说话、小队干活、委派承诺；一个启动器 `launchChildRun`，房间→小队移交（§4）。实施计划 [2026-11-05-multi-agent-convergence.md](./2026-11-05-multi-agent-convergence.md)。
- ADR-0022 附录（ultracode 模式）、ADR-0071（任务级 lead 审查）、ADR-0100（模板平台）、ADR-0198（能力授予）、ADR-0199（agent variant）、ADR-0227（变更集与集成队列）、ADR-0070（风险→仪式）、ADR-0232（运行预估）、ADR-0238（配置治理）、ADR-0239（出站授权）。
- 起因：用户请求评估 VoltAgent `awesome-claude-code-subagents`（约 170 个角色）能否组合出 Cognia 默认提供的流程。

## 0. 结论先行

1. **默认提供流程，不提供角色目录。** 外部清单里有价值的是少数工作方法（surgeon-reviewer 的「逐条证伪、只报有影响的问题」，docs-drift-editor 的「先有 diff 再动手」），不是角色数量。语言专家、meta 编排类、业务行业类都不进默认集。
2. **Cognia 已经有大部分零件，缺的是把零件拼成可直接用的流程，以及几处收敛。** §1 的核对推翻了上一轮口头分析里的一处判断：内置小队模板不是只有一个 `Code Review Pair`，而是有 8 个（§1.3）。但这些模板只有角色名单，没有模式、隔离、触发、产出。
3. **审查已经有四套实现（§1.2）。** 流程 1 的首要工作是收敛，不是再加第五套。
4. **流程的本体是 skill 拼装（§4.5）。** 每个流程是一个 skill，由积木 skill 拼成；模式（扫描、证伪、评审、汇总等）本身也是积木 skill。默认由 agent 按 skill 执行；需要确定性、并行、可审计、可定时时，转成 workflow 模式运行。workflow 是 skill 的派生物，不是另一份定义。

## 1. 现状核对

### 1.1 ultracode 模式节点

| 事实                                                                                                                                                                                                                                | 位置                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 六个节点 `pattern.{multi-modal-sweep,loop-until-dry,adversarial-verify,judge-panel,completeness-critic,synthesize}` 靠 `registerNodeExecutor` 的模块加载副作用注册                                                                  | `lib/squads/patterns/*.ts`                                                                                                                                                                                                                                             |
| 唯一的非测试导入方是小队生命周期，且只在 ultracode 生效时懒加载                                                                                                                                                                     | `lib/squads/agent-team-runtime.ts:1133` `await import("./patterns/index")`                                                                                                                                                                                             |
| 执行时要求小队运行上下文，没有就抛错                                                                                                                                                                                                | `getTeamCtxOrThrow`（`lib/squads/patterns/_shared.ts`）                                                                                                                                                                                                                |
| 在工作流编辑器里 `hidden: true`，诊断规则把它们标为 `team` 专用                                                                                                                                                                     | `lib/workflow/nodes/catalog.ts:2678–2725`、`lib/workflow/diagnostics/checks/synthesizer-only.ts:31–36`                                                                                                                                                                 |
| 模式组合**总是**由 LLM 规划器现场产出；没有「固定组合」字段                                                                                                                                                                         | `lib/squads/ultracode/ultracode-planner.ts` `planUltracodeWorkflow`；`AgentTeamConfig.ultracode` 只有 `enabled / autoMode / maxFinderRounds / skepticsPerFinding / judgesPerAttempt / dryRoundsToStop`（`packages/plugin-contract/src/types/agent/agent-team.ts:621`） |
| 是否启用：`override` > `ultracode.enabled` + `autoMode`（`auto` 时看路由评估是否判为复杂）                                                                                                                                          | `lib/squads/ultracode/ultracode-trigger.ts`                                                                                                                                                                                                                            |
| 证伪视角是固定枚举 `correctness / security / perf / repro`，`repro` 需要工具。该文件是事实来源，不是契约包的垫片；消费方是 `params-schemas.ts:2764` 的 `z.enum`、`synthesize-ultracode.ts:44` 和 `types/agent/ultracode.test.ts:20` | `types/agent/ultracode.ts:28–32`                                                                                                                                                                                                                                       |
| 入口：聊天里的 `team` 工具、外部桥 MCP、CLI 桥、调度器的 `team-executor` 都能传 `ultracode` 布尔                                                                                                                                    | `lib/claude/team-builtin-tools.ts`、`lib/external-bridge/handlers/orchestration.ts`、`lib/cli-bridge/handlers/agent-team.ts`、`lib/scheduler/executors/team-executor.ts`                                                                                               |

**含义：** 模式节点可以在模板里通过 `config.ultracode` 打开，也能从调度器定时跑；但流程作者没法钉死「sweep → verify → synthesize」这样的固定管线，也没法加 `architecture`、`tests` 这类新视角。加视角只改 `types/agent/ultracode.ts`，不碰契约包。钉死组合要给 `AgentTeamConfig.ultracode` 加字段，这在 `packages/plugin-contract` 里，按 CLAUDE.md 会使 authoring kit pin（`lib/plugin/distribution/authoring-kit.json`）失效，需要重建并发布。

### 1.2 审查：四套实现

| #   | 实现                                                                 | 用在哪                                                                      | 形态                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `lib/git/ai-review.ts` `generateDiffReview`                          | 源码管理界面的逐文件提示                                                    | 单视角、逐文件、一次调用；格式坏的回复降级为「无发现」                                                                                                                                                           |
| R2  | `lib/scm/review/review-agent.ts`                                     | 变更集门禁（ADR-0227 §3），经 `lib/scm/runtime.ts` 的 `scm.reviewChangeset` | 在 R1 上包一层：上限 40 个文件 / 单文件 48 KiB / 总 256 KiB，PII 闸，缺模型、回复不可解析、有文件没审到都判 `unavailable`（需要人批）；只要有 `critical` 就 `requestChanges`。**不对发现做证伪，没有跨文件视角** |
| R3  | `lib/squads/pr-feedback/reviewer.ts`                                 | 小队队员 PR 的内部审查，`requestChanges` 时把 `review_pickup` 推回队员      | 结构化裁决，走 `dispatchStructured`，需要小队上下文                                                                                                                                                              |
| R4  | `lib/squads/gates/task-review-policy.ts` + `action.team.task.review` | 小队任务级 lead 审查（ADR-0071）                                            | lead 对队员产出给结论，修订次数有上限                                                                                                                                                                            |

另有 `parallel-review` 小队模板（三个审查员，§1.3）和 ultracode 的 `adversarial-verify`，都能产出审查结论，但都不接 R2 的门禁。

审查策略只能加严、在目标 ref 读取，这一点要保留：`lib/scm/review/review-policy.ts`（`reviewAgent: required | optional | off`，`humanApproval: protected | always`）。

### 1.3 内置模板与房间

| 目录                                    | 内容                                                                                                                                    | 位置                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 小队模板 `BUILT_IN_TEAM_TEMPLATES`（8） | parallel-review、competing-hypotheses、research-team、full-stack-dev、cross-layer、documentation-team、refactoring-team、security-audit | `packages/plugin-contract/src/types/agent/agent-team.ts:1859` |
| 子 agent 模板（4）                      | research-web、code-review、content-writer、data-analyzer                                                                                | `packages/plugin-contract/src/types/agent/sub-agent.ts:594`   |
| 内置房间（`teams` 表，4）               | Brainstorm Group、Research Group、Doc Polishers、Code Review Pair                                                                       | `lib/db/teams.ts:274` `seedBuiltInTeams`                      |
| 内置角色（7）                           | coding、research、writer、brainstorm、translator、goal_tracker、support                                                                 | `lib/db/builtin-character-pack.ts` 等                         |
| 内置工作流模板（6）                     | auto-team-objective、team-lifecycle-review、team-delegation-hub、parallel-analysts、inbox-triage-twin、http-retry-fallback              | `lib/workflow/definition/templates/`                          |

小队模板每次启动都会以 `builtin.agentTeam.<id>@1.0.0` 重新投影到模板平台（`lib/templates/builtin-overlays.ts`）。模板类型 `AgentTeamTemplate` 的 `config` 是 `Partial<AgentTeamConfig>`，**已经能携带** `ultracode`、隔离与 `reconcile`、`taskReview`、`requirePlanApproval`、预算等。现有 8 个模板一个都没用：只设了 `executionMode`、`requirePlanApproval`、`enableMessaging`。

### 1.4 其余零件

| 需要的能力          | 现状                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 定时触发            | 调度器 `team-executor`（可带 `ultracode`）、`workflow-executor`；维护类任务清单 `lib/scheduler/maintenance-tasks.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 运行预估            | `lib/usage/run-estimate/launch.ts`，现接 `/goal`（`lib/slash-commands/actions/goal.ts:454`）和 harness（`lib/harness/runtime/start.ts:429`）。**小队启动未接**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 小队预算            | `budget-guard.ts`、`AgentTeamConfig` 的 token 预算与 `governance.budget`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 风险→仪式           | `lib/policy/risk/ceremony.ts`：`requirePlanApproval`、`requireAcceptance`、`manualContinue`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 集成队列            | ADR-0227，小队 `reconcile: "merge-all"` 走 `lib/squads/workspace/integrate-team-run.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 出站（PR 评论、IM） | ADR-0239 的 `plan-integration.ts` / `plan-delivery.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 记忆整理            | `@cognia/memory` 的 consolidator（`lib/memory/consolidate/consolidator.ts` 是垫片）。只在写入路径上跑：聊天回合结束经记忆任务队列（`hooks/chat/claude-chat-events.ts:1936` → `lib/memory/run-turn-memory.ts` → `job-worker.ts`，房间 runner 也走这里）、每回合顺带排的空闲维护（`lib/memory/lifecycle/maintenance.ts:176`）、`storeMemoryCore` 的主动写入（`/remember`、插件 API、工作流节点、经批准的运行学习提案 `lib/execution/run-learning-materializer.ts:276`）。**小队运行不触发记忆抽取。** `run-memory-lint.ts` 只由记忆控制台的 Health 页和手机端调用，没有定时或聊天入口                                                                                      |
| 文档漂移            | **没有**。`config-governance` 插件的每周漂移检查只管 agent 配置；`lib/wiki/lint/` 只管 wiki 页                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 依赖扫描            | **没有**确定性的依赖过期 / 安全公告扫描                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 诊断入口            | 崩溃（`lib/diagnostic-service/`、`crates/cognia-observability`）和支持报告（`lib/support-agent/`、`lib/support-report/`）**都不能启动 agent 运行**，只提交报告或生成 `/issues/new` 链接。Issue 能：`lib/issues/run/install.ts:81–83` 注册了 `agent-team`（调 `startSquadRun`，模式由小队配置决定）、`agent-task`、`github-loop` 三个适配器，入口是运行 Issue 对话框、IM 按钮和 issues 技能。CI 失败只能经用户配置的 Bot 规则启动小队（`lib/bot/runtime/executors/squad.ts:149` 调 `startSquadRun`，`origin: "bot"`；从 github-delivery 插件到 `routeBotEvent` 的全链路未追）；内置的 pr-feedback 只在已有小队运行内部推消息。`competing-hypotheses` 模板没有任何代码引用 |
| 房间→小队           | ADR-0252 §4 已接受，实施在收敛计划 P6，**未实现**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 斜杠命令            | 有 `/council`、`/goal`、`/plan`、`/loop`、`/issue`、`/best-of-n`；**没有** `/review`、`/debug`、`/research`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 2. 设计原则

1. **skill 是本体，workflow 是派生模式（§4.5，取代 §4.4 的「工作流图是唯一定义」）。** 流程的唯一定义是 skill 目录（`SKILL.md` + `flow.yaml`）；聊天命令、小队模板、工作流库、自动化触发都是它的入口和视图。不新建执行器，启动小队一律走 `startSquadRun` / `launchChildRun`（ADR-0252 §3、§5）。
2. **角色是视角提示词，不是独立角色。** 视角落在队员的 `systemPrompt` 或证伪的 lens 上。确实需要的工程角色做成 `char_builtin_coding` 的 variant（ADR-0199），不做副本。
3. **升级现有模板，不另起一套。** 8 个小队模板搬进内容插件并升级，旧的平台 id 做别名（§4.3 Q26）。
4. **引擎和内容分层。** 引擎（模式核心、门禁、审查策略、视角提示词、门禁用的组合）留在宿主；内容（模板、固定组合、命令、定时任务、Bot 模板、技能）放在内置插件 `plugins/cognia-flows`，以后随 cognia-plugins 迁出（§4.2、§4.3）。
5. **只加严。** 流程不能绕过 `review-policy`、风险仪式、出站授权和 PII 闸，也不能放宽它们。
6. **成本看得见。** 每套流程启动前给出 ADR-0232 预估；定时流程有预算上限，超了就停并通知。
7. **休眠三件套（CLAUDE.md 规则 7）。** 任何「先放着」的能力，要在类型上写明、界面上标注、测试里钉住。

## 3. 六套流程

每套流程写清：触发、组合、门禁、产出、复用的现有零件、要新增的东西。

### 3.1 流程 1：变更审查

- **触发：** 变更集捕获后（R2 门禁）；PR（小队 PR 反馈）；新增 `/review [范围]`。
- **组合：** `multi-modal-sweep`（视角：正确性、安全、架构边界、测试缺口）→ 对每条发现跑 `adversarial-verify`（默认 3 个怀疑者，多数推翻就丢）→ `synthesize` 出「能否合并」的结论和保留下来的发现。
- **门禁：** `review-policy` 在目标 ref 读取；`unavailable` 的语义不变（缺模型、没审全都需要人批）；风险仪式照旧。
- **产出：** 结论写回 R2 的 `ReviewAgentOutcome`；PR 评论经 ADR-0239 出站授权。
- **收敛方向：** R2 的单次逐文件审查作为 sweep 里的一个「逐文件」视角保留，外层加证伪和综合。R3、R4 改成调用同一个审查核心；R1 保持轻量界面提示，不进门禁。
- **新增：** 固定组合能力（§4 决策 D1）；`architecture`、`tests` 两个视角（D2）；`/review` 命令；把 `parallel-review` 模板升级为本流程的模板形态。

### 3.2 流程 2：根因诊断

- **触发：** 诊断服务的崩溃、支持报告、CI 失败、Issue；新增 `/debug`。
- **组合：** 收集证据（日志、复现步骤、最近改动）→ `loop-until-dry` 穷举假设，直到连续两轮没有新假设 → 每条假设跑 `adversarial-verify`（`repro` 视角需要工具，所以要在可写工作区里跑）→ `synthesize` 出根因 → 修复加回归测试，走流程 1 审查。
- **门禁：** 没有确诊不进入修复（用 `requirePlanApproval` 或一个专门的门禁，D4）；修复走集成队列。
- **产出：** 一个 Issue（根因、证据、被推翻的假设）加一个变更集。
- **复用：** `competing-hypotheses` 模板升级为本流程。
- **新增：** 诊断来源到小队启动的衔接（未核实，D5）；`/debug`。

### 3.3 流程 3：需求→交付

- **触发：** 一个 Issue；房间移交（ADR-0252 §4，依赖收敛计划 P6）；`/goal`。
- **组合：** 不用 ultracode，用现有的平铺任务 DAG：澄清（`lib/squads/auto/clarify-objective.ts`）→ 计划（风险高时必须批准）→ 拆任务（`decompose-tasks.ts`）→ 队员各自在隔离 worktree 干活 → 每个任务的 lead 审查（R4，收敛后调流程 1 的核心）→ `reconcile: "merge-all"` 进集成队列。
- **门禁：** 风险仪式的 `requirePlanApproval`、`budget-guard`、replan / deadlock 门禁。
- **产出：** 集成后的变更集；收尾时把改动文件交给流程 6 的文档漂移检查。
- **复用：** `full-stack-dev`、`cross-layer`、`refactoring-team` 三个模板升级，补上隔离与 `merge-all`。
- **新增：** 语言/技术栈视角按改动文件注入 skill（grant，ADR-0198），不做语言专家角色。

### 3.4 流程 4：依赖与构建维护（定时）

- **触发：** 每周一次的调度任务，默认关闭，用户开启。
- **组合：** 确定性扫描（过期依赖、安全公告；不调模型）→ 按风险分档（补丁、次版本、大版本、有公告）→ 每档一个队员在隔离 worktree 里升级并跑仓库检查 → 流程 1 审查 → 集成队列。
- **门禁：** 大版本和有破坏性变更说明的一律人批；补丁级可自动进队列（D7）。预算超了就停。
- **产出：** 每档一个变更集，加一份汇总报告。
- **新增：** **确定性依赖扫描器**（现在没有，§1.4）。按规则 2 不能先放个桩，需要定下范围（D6）。

### 3.5 流程 5：技术调研→决策

- **触发：** `/research`；从内置房间 Research Group 移交。
- **组合：** `multi-modal-sweep` 多源（web research skill、wiki、记忆、仓库）→ `completeness-critic` 找缺口并补一轮 → 有多个方案时用 `judge-panel` 打分（或复用 `/council` 的多模型共识）→ `synthesize`。
- **门禁：** 结论必须带来源；出网检索经 PII 闸。
- **产出：** ADR 草稿或调研文档写到 Files；可选一条记忆。
- **复用：** `research-team` 模板升级为本流程。

### 3.6 流程 6：知识与文档维护（定时或收尾）

- **触发：** 小队运行结束（收尾钩子）；每周定时。
- **组合（文档漂移）：** 上次运行以来的 diff → 找出引用了被改符号或路径的文档 → 每处由一个队员修 → 流程 1 审查。
- **组合（记忆）：** 从运行记录抽取决策 → 与已有记忆去重（复用 consolidator）→ 提出更新建议。
- **门禁：** 写记忆要人确认；文档修改走变更集。
- **复用：** `documentation-team` 模板；consolidator、memory lint。
- **新增：** 文档漂移检测器（现在没有）。

### 3.7 护栏（不是流程）

`config-governance` 插件（ADR-0238）加两项审计：角色和子 agent 描述互相重叠；描述总量超出预算。用户自己导入大量外部 agent（`lib/plugin/convert/` 的 claude-family 路径）时也会被提醒。

## 4. 决策

下表是 grill 前的原始问题，全部已在 4.1–4.3 定下，以 4.1–4.3 为准。

| #   | 问题                     | 选项                                                                                                                                                              | 倾向                                                     |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| D1  | 流程怎么钉死模式组合     | a. `AgentTeamConfig.ultracode` 加 `plan?: UltracodePlan`，有就跳过规划器；b. 让模板写规划器提示，仍由 LLM 组合；c. 把模式节点从小队里解放出来，作为普通工作流节点 | a：可测、可预估；b 不可复现；c 牵扯小队上下文，范围太大  |
| D2  | 新视角                   | a. `VERIFIER_LENSES` 加 `architecture`、`tests`；b. lens 改成开放字符串加提示词表                                                                                 | a：最小改动；只改 `types/agent/ultracode.ts`，不动契约包 |
| D3  | 审查收敛                 | a. R2 外包一层 sweep→verify→synthesize，R3、R4 调同一核心；b. 只升级 R2，R3、R4 暂不动                                                                            | a，但分阶段                                              |
| D4  | 诊断的「先确诊再修」     | a. 复用 `requirePlanApproval`；b. 新加诊断门禁                                                                                                                    | 待定                                                     |
| D5  | 诊断来源接入范围         | 崩溃 / 支持报告 / CI / Issue 先接哪几个                                                                                                                           | 先 Issue + CI                                            |
| D6  | 依赖扫描器范围           | pnpm、Cargo、两者都要；数据源（OSV、GitHub Advisory）                                                                                                             | 待定                                                     |
| D7  | 补丁级升级可否自动进队列 | 自动 / 一律人批                                                                                                                                                   | 默认人批，可开                                           |
| D8  | 定时流程的默认状态       | 全部默认关 / 文档漂移默认开                                                                                                                                       | 全部默认关                                               |
| D9  | 模板升级方式             | 原 id 升版本 / 新 id 并存                                                                                                                                         | 原 id 升版本                                             |
| D10 | 斜杠命令                 | 加 `/review`、`/debug`、`/research` / 只加 `/review`                                                                                                              | 待定                                                     |
| D11 | 先做哪套                 | 建议顺序：1 → 2 → 3 → 5 → 6 → 4                                                                                                                                   | 流程 1                                                   |
| D12 | 小队启动接运行预估       | 一并做 / 另起                                                                                                                                                     | 一并做（流程 1 前置）                                    |

### 4.1 已定（grill 第一轮，2026-11-07）

| #          | 决定                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D11 / 范围 | 六套都进本计划，分阶段实施，顺序 1 → 2 → 3 → 5 → 6 → 4。流程 3 的房间移交等收敛计划 P6                                                                                      |
| D1         | 把模式核心从小队上下文里抽出来，小队、R2 门禁、`/review` 共用同一核心；同时给 `AgentTeamConfig.ultracode` 加 `plan?: UltracodePlan`，有就跳过规划器（契约改动，要重建 kit） |
| D2         | `VERIFIER_LENSES` 加 `architecture`、`tests`（只改 `types/agent/ultracode.ts`）                                                                                             |
| D9         | 内置小队模板保留原 id，就地升版本（第三轮 Q26 修订：搬进插件，旧 id 做别名）                                                                                                |
| D8         | 定时流程（4、6）全部默认关闭，打开入口放在流程卡片上                                                                                                                        |
| D12        | 小队启动接 ADR-0232 运行预估，作为流程 1 的前置；同时给发现条数设上限                                                                                                       |

### 4.2 已定（grill 第二轮，2026-11-07）

| #         | 决定                                                                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内容/引擎 | 「harness 配置」指 Cognia 出厂的流程内容（固定组合、视角提示词、小队模板、内置角色和技能）。**引擎留在主仓库**（模式核心、门禁、审查策略、R2 接入）。内容先在本仓库做成声明式数据，和引擎分层；schema 稳定后整体迁到 cognia-plugins 仓库，不另开第三个仓库                                           |
| Q7        | 模式核心留在 squads 模块，作为它的 `api` 文件对外；scm 依赖 squads；提示词留在提示词中心。核心只依赖注入的「执行一步并返回结构化结果」接口：小队里由队员执行，R2 门禁用 `LlmClient`                                                                                                                  |
| Q8        | R2 门禁按 `assess-change-risk` 分档：low 档保持单次逐文件审查，只证伪 high/critical 级别的发现；medium/high 档跑完整的扫描→证伪→汇总                                                                                                                                                                 |
| Q9        | 被多数推翻的 critical 不丢，结论改为「需要人批」并附推翻理由                                                                                                                                                                                                                                         |
| Q10       | R3 在 F2 收敛到审查核心；R4 只在任务产出是变更集时调用审查核心，其余保持现状                                                                                                                                                                                                                         |
| Q11       | 只证伪 medium 及以上、按严重度排前 15 条；其余标「未证伪」，列入报告、不参与结论；15 可在模板里改                                                                                                                                                                                                    |
| Q12 / D4  | 诊断分两段运行：诊断运行产出根因卡片 → 人在 Issue 上确认 → 按流程 3 启动修复运行                                                                                                                                                                                                                     |
| Q13 / D5  | 所有来源统一先落成 Issue：Issue 现成；崩溃和支持报告加「建 Issue 并诊断」按钮；CI 失败附一条内置 Bot 规则模板，默认关闭                                                                                                                                                                              |
| Q14 / D10 | 加 `/review`、`/debug`、`/research` 三个命令，只负责启动对应流程                                                                                                                                                                                                                                     |
| Q15       | 小队结束时的记忆复用「运行学习提案」，人批准才写入；不新增自动抽取                                                                                                                                                                                                                                   |
| Q16       | 文档漂移：确定性候选（diff 里被改的导出符号和路径 → grep 文档）+ 模型判断是否过时，过时的才修                                                                                                                                                                                                        |
| Q17 / D6  | 依赖扫描覆盖 pnpm/npm 和 Cargo；过期依赖用各生态自带命令，安全公告查 OSV（外网，走网络出口闸）                                                                                                                                                                                                       |
| Q18 / D7  | 补丁级升级默认需要人批，用户可打开「补丁级自动进队列」                                                                                                                                                                                                                                               |
| Q19       | 模板对应：parallel-review → 流程 1；security-audit → 流程 1 的「安全优先」预设；competing-hypotheses → 流程 2；full-stack-dev / cross-layer / refactoring-team → 流程 3；research-team → 流程 5；documentation-team → 流程 6。内置房间 Code Review Pair、Research Group 保留，P6 后分别移交流程 1、5 |
| Q20       | 文档漂移的扫描范围由 `.cognia/workspace.json` 的 `docs` 块配置，在目标 ref 读取；没配置时用默认约定：`README*`、`docs/**`、根目录 `*.md`                                                                                                                                                             |
| Q21       | 人手动启动时总显示预估，超过用户设定的阈值才弹确认；定时和门禁触发的不弹，靠预算上限停下并通知                                                                                                                                                                                                       |

### 4.3 已定（grill 第三轮，2026-11-07）

插件通道核查（同日）：小队模板选择器只读已弃用的 `agentTeamTemplates` 字段（`hooks/squads/use-squad-templates.ts:23,57`，启用时记弃用诊断 `lib/plugin/core/manager.ts:6576–6592`）；`ctx.templates.register` 进的平台目录选择器不读。模板 `config` 经可移植投影后 `ultracode`、`workspaceIsolation`、`taskReview` 都保留（`lib/templates/adapters.ts:127–150`），但没有第一方插件用过。插件提示词靠 `ctx.prompts.register` 运行时登记，插件禁用就消失。斜杠命令能注册（`lib/plugin/api/commands-api.ts:143`），但 `ctx.team.start` 要现成的小队 id，`ctx.agent.runTeam` 绕过 `startSquadRun`（收敛计划 P5 处理）。插件定时任务的 `defaultEnabled` 只在显式 `false` 时暂停，`ctx.userScheduler.createTask` 没有启用开关，`agent-team` 定时任务要现成的 `teamId`。Bot 能贡献定义但没有「模板」概念。内置插件默认开启来自启动激活加 `auto` 意图（`lib/plugin/core/lifecycle-state.ts:55–58`）。

| #              | 决定                                                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q22            | 流程内容做成内置第一方插件 `plugins/cognia-flows`：模板、固定组合、斜杠命令、定时任务、Bot 模板、技能。cognia-plugins 从 `plugins/` 带历史同步，以后迁出就是跟着同步走                                                |
| Q23            | 引擎自带视角提示词和 R2 门禁用的组合，由宿主代码拥有、登记在提示词中心；流程 1 的模板引用同一组合。内容插件被禁用不影响门禁                                                                                           |
| Q24            | 内容插件默认开启；其中的定时任务和 Bot 模板单独默认关闭                                                                                                                                                               |
| Q25            | 插件通道缺口在本计划 F1 修：选择器改读模板平台目录、Bot 模板贡献类型、用户定时任务支持默认关闭、命令和定时任务能从模板实例化并经 `startSquadRun` 启动。`ctx.agent.runTeam` 的绕过交给收敛计划 P5                      |
| Q26（修订 D9） | 8 个内置小队模板从契约包的 `BUILT_IN_TEAM_TEMPLATES` 搬进 `cognia-flows`；模板平台的 id 解析把 `builtin.agentTeam.<id>` 映射到插件模板，已有引用不断。以后改模板不再动契约包、不再重建 kit。搬迁放在 F2（随插件首版） |

### 4.4 已定（grill 第四轮：多种使用方式，2026-11-07）

核查：已有 6 个内置工作流模板（`lib/workflow/definition/templates/`），没有一个是工程流程；`action.team.run` 只收 `teamId` 和 `goal`（`lib/workflow/nodes/params-schemas.ts:341`），不能从模板实例化、不能传 ultracode；模式节点在编辑器里隐藏且只能在小队里跑；有 `flow.subworkflow` 可嵌套调用；工作流运行没有接运行预估。ultracode 本身就是把组合编译成一张 VisualWorkflow 再跑（`lib/squads/ultracode/synthesize-ultracode.ts`）。

| #               | 决定                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q27 / Q31       | **一份定义，多处呈现。** 每个流程「怎么做」只存一份，形态是工作流图（模式节点 + 审批 / Issue / 通知等节点）；聊天命令、小队模板、工作流库、自动化触发都是它的入口和视图，改一处各处都变。流程之间用 `flow.subworkflow` 组合（流程 3 的逐任务审查调流程 1，流程 2 的修复段调流程 3）。写代码的段落（流程 2 修复段、流程 3、流程 4 升级段）在图里通过「启动小队」节点调用，隔离 worktree 与集成队列仍由小队提供 |
| D1 修订         | `ultracode.plan` 改为引用工作流定义（小队模板指向内置工作流），不另存一份紧凑计划；小队运行时用队员实现「执行一步」接口去跑这张图                                                                                                                                                                                                                                                                             |
| Q28             | 模式节点在工作流编辑器里对用户开放（取消 `hidden`）；工作流运行提供「执行一步」的模型实现；工作流启动接 ADR-0232 预估（规则同 Q21），运行有预算上限                                                                                                                                                                                                                                                           |
| Q29             | 定制方式：常用旋钮（视角、上限、怀疑者数、各步模型）直接调；改结构就把内置工作流复制到自己名下改，内置版升级不影响副本                                                                                                                                                                                                                                                                                        |
| Q30 / Q32       | 第一版的使用位置：聊天与房间（命令、输入框建议、⌘K；房间移交等 P6）、小队面板与模板中心、工作流库与编辑器（运行、复制、嵌套）、自动化触发（定时、Bot、Issue 运行、门禁）。CLI / MCP / 插件 API 不在第一版                                                                                                                                                                                                     |
| Q33             | 流程的「家」：模板中心 `/templates` 新增「流程」类别，每个流程一张卡片，放参数、定时开关、运行记录和各入口说明；不新增顶级页面                                                                                                                                                                                                                                                                                |
| Q34（修订 Q13） | Issue 详情和源码管理页不加页内按钮；崩溃和支持报告上的「建 Issue 并诊断」推到后续版本。Issue 现有的「运行」对话框能选流程，变更集门禁照常运行，CI 失败的 Bot 模板保留（默认关）                                                                                                                                                                                                                               |

### 4.5 已定（grill 第五轮：skill 拼装为本体，2026-11-07）

核查：插件已能分发 skill（`PluginSkillDef`），内置 skill 是 `SKILL.md` 目录（`skills/built-in/`）；workflow 有 `action.skill.invoke`，但它只是把 skill 渲染进下一个 AI 步骤的提示词；**没有 skill → workflow 的转换器**。可参考的结构化步骤模型在 skill 录制器（`lib/skills/recording/step-model.ts`）。

| #                     | 决定                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q35（修订 Q27 / Q31） | **流程的本体是 skill。** 流程是 skill，由积木 skill 拼装（skill 引用子 skill）；workflow 是从 skill 转出来的一种运行模式。「一份定义、多处呈现」仍成立，但那一份定义是 skill，不是工作流图   |
| Q36                   | 转换：skill 目录里有结构化步骤段就确定性编译成工作流图；没有就由 AI 读 skill 起草，人审后保存。内置流程一律带结构化步骤段                                                                    |
| Q37                   | 转出的 workflow 是派生物、只读，skill 改了就重新生成；想直接改图就「分离」成独立副本，之后不再跟随 skill                                                                                     |
| Q38                   | 每个模式（多视角扫描、穷举直到无新发现、证伪、评审团、完备性评审、汇总）也是一个积木 skill：skill 模式下由 agent 调子 agent 执行；转成 workflow 时编译成对应的模式节点，由引擎的模式核心执行 |
| Q39                   | skill 由当前 agent 在聊天 / 房间里执行；需要写代码、隔离和集成队列的步骤，在 skill 里写「启动小队」。小队模板 = 角色名单 + 隔离 / 集成配置 + 队员要用的 skill，是 skill 的执行配置           |
| Q40                   | 结构化步骤段放在 skill 目录里的独立文件 `flow.yaml`，与 `SKILL.md` 并列；`SKILL.md` 保持标准格式，别的工具照常能读。`flow.yaml` 的 schema 在 F1 定                                           |
| Q41                   | skill 模式的成本：有 `flow.yaml` 就按它给预估（标明是估计）；子 agent 数和扇出上限写在 `flow.yaml` 里；运行用能力授予（ADR-0198）的 `maxBudgetUsd` 兜底                                      |

**对前几轮的影响：**

- **D1（第三次修订）：** 小队模板不再引用工作流定义，而是引用 skill；ultracode 的组合来自该 skill 的 `flow.yaml` 编译结果。
- **Q22：** `plugins/cognia-flows` 的主体是 skill 目录（流程 skill + 积木 skill），外加模板、命令、定时任务、Bot 模板；内置工作流由 skill 编译生成，不在插件里手写。
- **Q23 不变：** 变更集门禁仍由宿主代码直接调用模式核心，不经过 skill，也不依赖插件。
- **Q28 不变：** 模式节点在编辑器开放，工作流接预估和预算。
- **Q29：** 定制方式变为：调 `flow.yaml` 里暴露的参数；改结构就复制 skill 到自己名下改；只想改图就把派生 workflow 分离出来。
- **Q30 / Q32 / Q33 / Q34 不变：** 入口和「流程」类别照旧，卡片上的流程即流程 skill，并显示「以 skill 运行 / 以 workflow 运行」两种方式。
- **积木 skill 清单（初稿）：** 模式类 6 个（对应 Q38）；领域类：证据收集、依赖扫描、文档漂移候选、根因卡片、变更集审查结论；流程类 6 个：review、debug、deliver、maintain-deps、research、maintain-docs。

## 5. 拟定阶段

| 阶段 | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 验收                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0   | 本文定稿；修订 ADR-0022 附录：模式核心脱离小队上下文、流程以 skill 为本体并可编译成 workflow、小队模板引用 skill、模式节点对用户开放、`architecture`/`tests` 视角、R2 分档与「被推翻的 critical 需要人批」                                                                                                                                                                                                                                                                                                                                                                                                                                           | ADR 修订合入                                                                                                                                       |
| F1   | 平台前置：①模式核心抽成 squads 的 `api`，注入「执行一步」接口（队员 / 工作流模型调用 / `LlmClient` 三种实现）；②`flow.yaml` schema 与 skill → workflow 编译器（确定性编译；无 `flow.yaml` 时 AI 起草 + 人审）、派生 workflow 只读与「分离」；③小队模板引用 skill 的契约 + 重建 authoring kit；④视角枚举；⑤模式节点取消 `hidden`，工作流运行可执行模式节点；⑥skill 模式、小队、工作流启动都接运行预估（skill 模式按 `flow.yaml` 估计）与超阈值确认，并有预算上限；⑦`action.team.run` 支持从模板实例化并传 ultracode；⑧插件通道缺口：选择器读模板平台目录、Bot 模板贡献类型、用户定时任务默认关闭、命令与定时任务从模板实例化并经 `startSquadRun` 启动 | `pnpm build:packages`、`pnpm plugin:author-imports`、`pnpm audit:modules` 通过；现有小队 ultracode 运行行为不变；编译器对同一 `flow.yaml` 输出稳定 |
| F2   | 流程 1：6 个模式积木 skill + review 流程 skill（含 `flow.yaml`）；审查核心（扫描→证伪→汇总，前 15 条上限，未证伪标注）；R2 按风险分档接入（宿主直调核心）；R3 收敛；R4 在产出是变更集时接入；新建 `plugins/cognia-flows`，含 parallel-review 与 security-audit 预设、`/review`；8 个内置模板搬进插件，`builtin.agentTeam.<id>` 别名；模板中心「流程」类别与流程卡片                                                                                                                                                                                                                                                                                  | 单测；在一个真实变更集上跑通 low 和 medium 两档门禁；review 以 skill 运行和以 workflow 运行各跑一次，从命令、小队模板、工作流库三处启动行为一致    |
| F3   | 流程 2：debug 流程 skill（诊断段）→ Issue 上确认根因 → 修复段（subworkflow 调流程 3）；Issue「运行」对话框可选流程；CI 失败 Bot 模板（默认关）；`/debug`；competing-hypotheses 升级                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 用一个已知 bug 跑通，至少推翻一条错误假设                                                                                                          |
| F4   | 流程 3：full-stack-dev / cross-layer / refactoring-team 补隔离与 `merge-all`；房间移交等收敛计划 P6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 一次端到端的 merge-all                                                                                                                             |
| F5   | 流程 5（research-team 升级、`/research`）；流程 6（漂移检测器、`.cognia/workspace.json` 的 `docs` 块、小队结束接运行学习提案）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 各跑一次真实运行                                                                                                                                   |
| F6   | 流程 4：依赖扫描器（pnpm/npm + Cargo + OSV，经网络出口闸）；补丁级自动入队开关                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 在本仓库跑一次，只出报告                                                                                                                           |
| F7   | 护栏：配置治理插件加描述重叠与描述总量两项审计                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 插件单测                                                                                                                                           |
| F8   | 后续：流程 schema 稳定后，`plugins/cognia-flows` 随 cognia-plugins 同步迁出                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 另起计划                                                                                                                                           |

每阶段：同目录测试、i18n 双语、changeset、`pnpm audit:modules`；动到契约包的阶段重建 authoring kit。

## 6. 风险

- **成本：** sweep×verify 的扇出是乘法。默认 4 视角 × N 条发现 × 3 怀疑者。必须有发现条数上限和预估。
- **重复：** 如果流程 1 没有收敛 R2/R3/R4，就会变成第五套审查。
- **契约改动：** D1 的 `ultracode.plan` 改 `packages/plugin-contract`，要重建 kit 并到 cognia-plugins 仓库重新钉版本。D2 只改 `types/agent/ultracode.ts`，不需要。
- **依赖 ADR-0252：** 流程 3 的房间移交、`startSquadRun` 唯一入口都依赖收敛计划 P3–P6。
- **多处呈现会分叉：** 只要哪个入口自己存了一份步骤或参数，就会出现同名流程在不同地方行为不同。每个入口只能引用 skill；派生 workflow 只读，改图要显式分离。F2 起每个流程都要有「三处启动行为一致」的测试。
- **skill 模式与 workflow 模式结果不同：** skill 模式由 agent 自行把握扇出，结果和成本都会比 workflow 模式更不稳定。卡片上要说明两种方式的区别；需要稳定结果（定时、门禁前置、审计）的场景默认用 workflow 模式。
- **用户自拼的图很贵：** 模式节点开放后，用户能拼出大扇出的图，工作流的预估和预算上限是开放的前提，不能后补。
- **插件通道首次承载这些字段：** 没有第一方插件用过模板里的 `ultracode`、`workspaceIsolation`、`taskReview`，F1 要为这条兼容路径补测试。工作区隔离只在桌面端生效。
- **内容插件和引擎的边界：** 插件禁用时，门禁用的组合和视角提示词仍由宿主提供；模板、命令、定时任务随插件消失。这一点要在类型、界面和测试三处都标明（规则 7）。
- **未核实项：** github-delivery 插件的 `check_run.completed` 到 Bot 路由 `routeBotEvent` 的全链路。
