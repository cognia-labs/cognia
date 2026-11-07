---
title: "0254 — 流程是一个可以编译成工作流的 skill"
description: "Cognia 把默认的工程流程做成 Playbook（流程）：由其他 skill 拼装成的 skill，可带一份 references/flow.yaml，确定性地编译成只读的 VisualWorkflow。质量模式变成积木 skill，背后是一份不再依赖小队的模式核心。引擎（模式核心、变更集门禁、证伪视角提示词）留在宿主；内容（流程、小队模板、命令、Bot 定义）放在第一方插件。启动前显示成本预估，运行中受预算约束。"
---

# ADR 0254 — 流程是一个可以编译成工作流的 skill

**状态：** 提议中
**日期：** 2026-11-07

**相关：**
- [ADR-0022](./0022-agent-team-runtime-hardening)（Ultracode 附录）：六个质量模式。被本 ADR 修订。
- [ADR-0252](./0252-a-room-talks-a-squad-works-a-delegation-promises)：启动小队和子运行的唯一入口是 `startSquadRun` 与 `launchChildRun`，流程也走它们。
- [ADR-0227](./0227-agent-changes-integrate-through-one-host-queue)：本 ADR 扩展的变更集审查门禁。
- [ADR-0070](./0070-risk-ceremony-policy-layer)：风险档决定一次变更受多少审查。
- [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched)：流程运行经能力授予圈定子 skill 和预算。
- [ADR-0232](./0232-a-long-run-shows-an-estimate-never-a-budget)：启动前显示的预估，保持只提示。
- [ADR-0100](./0100-unified-template-platform)：小队模板经模板目录进入选择器。

**证据：** 设计 `docs/plans/2026-11-07-default-flows.md`（grill 五轮，决定见 §4.1–4.5）与实施计划 `docs/plans/2026-11-07-playbooks-implementation.md` §0，均取自 `dev` 的 `7775a703b5`。

## 背景

Cognia 有好工程流程的大部分零件，却没有一套现成的流程。

- **模式存在，但只有一个调用方能用。** 六个质量模式（多视角扫描、穷举直到无新发现、证伪、评审团、完备性评审、汇总）只能在小队的 ultracode 运行里跑：它们按运行 id 查 `TeamRunContext`，查不到就抛错。它们在工作流编辑器里是隐藏的，组合每次由 LLM 规划器现场决定，任何流程都没法把组合固定下来。
- **审查有四套。** 逐文件 diff 提示（`lib/git/ai-review.ts`）、变更集门禁（`lib/scm/review/review-agent.ts`）、小队 PR 审查（`lib/squads/pr-feedback/reviewer.ts`）、lead 任务审查（ADR-0071）各审各的。门禁一次只看一个文件、只有一个视角，也从不核实一条发现是否成立。
- **模板只是名单。** 8 个内置小队模板只列了队员：没有模式、没有隔离、没有触发、没有产出。
- **skill 不能组合。** 一个 skill 想用另一个，只能用自然语言让模型去调 `load_skill`，而目标不在本次发送的范围里就会失败。

一份约 170 个单角色 subagent 的外部清单引出了「Cognia 默认该提供哪些流程」这个问题。清单的价值在少数工作方法上（报告前逐条证伪；只依据 diff 修文档），不在角色数量上。语言专家和元编排类角色，与基础模型和 Cognia 自己的运行时重复。

## 决定

### 1. 流程是一个 skill

**流程**（英文 Playbook）是由其他 skill 拼装成的 skill。它的 `SKILL.md` 保持标准格式，其他工具照常能读。它可以在 **`references/flow.yaml`** 里带一份结构化步骤。这个路径在内置打包、磁盘镜像和本地扫描中都原样保留，`load_skill_resource` 也本来就能读到。

`flow.yaml`（版本 1）声明输入、步骤和限额。每一步的 `uses` 取下列之一：`skill:<id>`、`pattern:<kind>`、`squad:<templateId>`、`playbook:<skillId>`、`approval`、`issue.*`、`notify`。步骤还声明依赖、并行、`requiresTools` 和是否需要人确认。限额限制子 agent 数、扇出和花费。

### 2. 一份定义，两种运行方式

- **以 skill 运行。** agent 在聊天或房间里按流程执行。流程引用的 skill 经授予的 `skills.add` 进入本次运行范围，`limits.maxBudgetUsd` 成为授予的 `maxBudgetUsd`。写代码的步骤经 `startSquadRun` 启动小队。
- **以工作流运行。** `flow.yaml` 确定性地编译成 `VisualWorkflow`：同样的输入得到同样的图。这张图是**派生物**：
  - 记录 `derivedFrom`（skill id、内容哈希），并且是 `readOnly`。
  - skill 一变就重新编译。
  - 想改图的人把它**分离**成一份普通工作流，之后不再跟随 skill。

  没有 `flow.yaml` 的 skill 仍可由编辑器的 AI 起草成工作流，人审后存为普通工作流。

以工作流运行时，一个流程调用另一个流程，被调用的流程会**内联**到调用它的步骤下，它的文本也计入内容哈希。不用 `flow.subworkflow`：它只能运行已发布的工作流，而派生工作流从不发布。编译器拒绝调用环。带 `sensitive` 输入的流程不编译成工作流，因为工作流运行会把输入存进运行历史；这类流程以 skill 运行。

### 3. 模式是积木 skill，背后一份核心

每个模式同时也是一个积木 skill。以 skill 运行时，由 agent 调用子 agent 执行；以工作流运行时，编译成对应的 `pattern.*` 节点。

节点执行器变成 **模式核心** 之上的薄壳。核心在 `lib/squads/patterns/core/`，列入 squads 模块的 `api`。它只依赖一个注入的端口：

- 执行一个结构化步骤：提示词、Zod schema、`requiresTools`、取消信号；
- 扇出宽度；
- 提示词上下文；
- 可选的汇总回调。

端口有三种实现：小队队员（即现有行为）、工作流模型调用、普通 `LlmClient`。**不提供工具的实现会拒绝需要工具的步骤**，`repro` 视角不会悄悄失去复现能力。模式节点可以在编辑器里放置。

证伪视角新增 `architecture` 和 `tests`。

### 4. 引擎留在宿主，内容做成插件

- **宿主：** 模式核心、证伪视角提示词、变更集门禁用的组合、审查策略、`flow.yaml` 的 schema 和编译器（`lib/skills/playbook/`），以及启动、预估、设置等胶水代码（`lib/playbooks/`）。
- **插件 `plugins/cognia-playbooks`（默认启用）：** 流程 skill 和积木 skill、8 个内置小队模板（从契约包搬出，`builtin.agentTeam.<id>` 解析到它们）、斜杠命令和 Bot 定义。

禁用插件会去掉流程、模板和命令，但不改变变更集门禁。这个插件以后可以随 `plugins/` 其余部分迁到 cognia-plugins 仓库。

小队模板是流程的执行配置：成员名单、隔离与集成设置，以及队员要用的 skill。它的 ultracode 组合来自一个流程（`ultracode.playbookSkillId`），只有没指定时才运行规划器。

### 5. 变更集门禁按风险档审查，先证伪再拦

门禁把变更的风险档传给审查：

- **low 档**：保持现在的逐文件审查，只证伪 high 和 critical 的发现。
- **medium 和 high 档**：跑完整组合。四个视角各自扫描；medium 及以上的前 15 条发现，每条由三个怀疑者证伪；其余标为「未证伪」写进报告，不计入结论。
- **被多数推翻的 critical 发现仍要人看。** 结论变为「需要人批」，并附上推翻理由。证伪用来减少噪音，不会放松门禁。

`unavailable` 的含义不变：没有模型、回复无法解析或没审全，都要交给人。小队 PR 审查改用同一核心。lead 任务审查只在任务产出是变更集时使用它。

### 6. 启动前看得见成本，运行中受预算约束

- **预估只显示，从不强制（ADR-0232 不变）。** 手动启动流程、小队或工作流时都显示预估。以 skill 运行时的预估按 `flow.yaml` 计算，并标明是估计。预估不弹确认，也不停止任何运行。
- **花费由预算约束，不由预估约束：**
  - 小队沿用 `RunBudgetGovernor`；
  - 以 skill 运行时，用授予里的 `maxBudgetUsd`；
  - 工作流运行新增美元上限（`WorkflowSettings.maxCostUsd`），按使用量账本累计。它是新的预算，不是预估。
  - 计数规则（2026-11-07 定）：步骤上报的成本，以及能按模型价目表估价的用量，都计入上限。无法计价的步骤、或调用了模型却没有上报用量的步骤，不会让运行停止；运行日志和运行摘要把它标为「预算未覆盖」。这与聊天配额「成本未知即拒绝」的规则有意不同：工作流无人值守，拒绝会让成本只是无法计量的运行失败。
  - 子工作流继承上级剩余的额度，花费同时记到上级。
- 运行达到预算即停止：在途步骤中止，不再启动新步骤，运行以 `budget_exhausted` 走常规失败路径（catch 节点、失败通知、完成扇出），不受错误策略影响。
- 定时流程默认关闭。要从流程卡片经调度器表单由人启用，保留调度器对 agent 任务的确认规则。

### 7. 流程出现在哪里

- **聊天与房间：** `/review`、`/debug`、`/research`、输入框建议、⌘K。
- **小队面板与模板中心：** 流程是 skill 域的一个筛选视图，不新增模板域。
- **工作流库与编辑器。**
- **自动化：** 调度器、Bot 定义、Issue 运行、变更集门禁。

英文名用 **Playbooks**，因为「Flows」已被浏览器录制器的 saved flows 占用。

## 影响

- **一个流程只有一份定义。** 从聊天、小队模板或工作流库启动同一个流程，执行的步骤相同。
- **medium 风险的审查更严，low 风险的审查更安静。** medium 和 high 的变更要为更完整的审查付费；low 风险的变更花费与现在大致相同。
- **模式可以在小队之外复用。** 包括用户自建的工作流，因此工作流的美元上限和预估面成了前提，而不是附加项。
- **契约改动。** `VisualWorkflow.derivedFrom` / `readOnly`、`WorkflowSettings.maxCostUsd`、`ultracode.playbookSkillId` 都要改 `packages/plugin-contract`，并重建 authoring kit。
- **小队模板选择器改读模板目录。** 内置模板要等目录启动后才出现，选择器需要加载状态。
- **两种运行方式的结果可能不一致。** 以 skill 运行时扇出由 agent 决定，结果和成本更不稳定。定时任务和需要审计的场景默认以工作流运行。
- **先后顺序。** 模式核心和 `action.team.run` 的改动要等 ADR-0252 的 P5 合入，P5 同样会改 `judge-panel.ts` 和 `action.team.run`。

## 修订

- **ADR-0022（Ultracode 附录）。**
  - 模式运行在一份不再依赖小队的核心上。
  - 小队模板的组合来自流程；没有流程的运行仍使用规划器。
  - 视角新增 `architecture` 和 `tests`。
  - `repro` 需要工具，没有工具时拒绝执行。
  - 模式节点可以在编辑器中放置。
