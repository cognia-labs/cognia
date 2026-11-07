# 流程（Playbooks）实施计划：F0–F2

状态：待评审。创建：2026-11-07（Asia/Shanghai）。证据取自 `dev` 的 `7775a703b5`（收敛计划 P3 之后）。

上游：

- 设计：[2026-11-07-default-flows.md](./2026-11-07-default-flows.md)（已定稿，决策见其 §4.1–4.5）。本计划只覆盖 F0–F2；F3–F7 到时各写一份计划。
- 并发：[2026-11-05-multi-agent-convergence.md](./2026-11-05-multi-agent-convergence.md) 正在由另一个会话执行（P1–P3 已合入）。它的 P5 会改 `lib/squads/patterns/judge-panel.ts` 的聚合、`action.team.run` 和 `startSquadRun` 的输入构造。

## 0. 实施前核查（2026-11-07）

三路调研的结论，按对计划的影响列出。

### 0.1 skill 一侧

| 事实                                                                                                                                 | 位置                                                                                                                                            | 影响                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| skill 目录根下的额外文件：内置打包只收 `references/ scripts/ assets/`，静默丢弃；Rust 磁盘镜像把它挪进 `references/`；磁盘扫描看不到 | `scripts/build/build-builtin-skills.mjs:176,194–210`；`crates/cognia-skills/src/install.rs:702–716`；`crates/cognia-skills/src/native.rs:42–48` | `flow.yaml` 放 `references/flow.yaml`（§1 E1）                                                                                                                                                 |
| skill 之间没有结构化引用；`load_skill` 只能加载本次发送范围内的 skill                                                                | `lib/skills/runtime-loader.ts:262–321`                                                                                                          | skill 模式下，流程 skill 引用的子 skill 要经能力授予 `skills.add` 进入范围（`AgentCapabilityGrantV1.skills`，`packages/plugin-contract/src/types/agent-config/agent-capability-grant.ts:103`） |
| 插件 skill 运行时只读正文，兄弟文件到不了模型                                                                                        | `lib/claude/skills-io.ts:381–435`                                                                                                               | 插件里的流程 skill 的 `references/flow.yaml` 要由宿主读，不能指望模型读                                                                                                                        |
| **`action.skill.invoke` 是坏的**：读 `systemPrompt ?? body`，`Skill` 只有 `content`，注入的正文为空；测试只查注册                    | `lib/workflow/nodes/integrations/index.ts:39–40`                                                                                                | WP3 修复                                                                                                                                                                                       |
| 没有 `/<skill名>` 斜杠命令                                                                                                           | `lib/slash-commands/builtin.ts`                                                                                                                 | `/review` 等需单独注册                                                                                                                                                                         |
| 已有反方向的先例：工作流发布后生成 `kind:"workflow"` 的 skill                                                                        | `lib/workflow/publish/publication-lifecycle.ts:94–97`                                                                                           | 编译出的派生工作流不走发布流程，避免循环                                                                                                                                                       |

### 0.2 工作流一侧

| 事实                                                                                                 | 位置                                                                                                                                     | 影响                                         |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 模式节点：隐藏、诊断报错、执行器要小队上下文、懒注册                                                 | `lib/workflow/nodes/catalog.ts:2678–2725`；`lib/workflow/diagnostics/checks/synthesizer-only.ts`；`lib/squads/patterns/_shared.ts:20–28` | 放开要等模式核心抽离（F1b）                  |
| `action.team.run` 绕过 `startSquadRun`，`goal` 参数从不读取                                          | `lib/squads/workflow-nodes/index.ts:57–160`                                                                                              | 收敛 P5 修；本计划在其上加模板实例化         |
| `flow.subworkflow` 按 `workflowId` 引用，准入时锁定部署和版本，拒绝环，深度上限 10                   | `lib/workflow/nodes/data/flow.ts:646–730`；`lib/workflow/runtime/execution-authority.ts:134–170`                                         | 编译器生成的流程间调用直接用它               |
| 内置工作流每次启动 `bulkPut` 覆盖；没有只读标记，`isBuiltIn` 只防删除；`VisualWorkflow` 没有来源字段 | `lib/db/workflows.ts:236–240,324–333`；`packages/plugin-contract/src/types/workflow/visual.ts`                                           | 派生工作流需要新增来源与只读字段（契约改动） |
| 工作流没有运行预估面，没有美元上限；成本门禁只接了聊天发送                                           | `lib/usage/run-estimate/estimate.ts:38`；`WorkflowSettings`                                                                              | WP4、WP5 新做                                |
| 单一运行入口 `runWorkflow`；已发布的先经 `executeDeployedWorkflow`                                   | `lib/workflow/runtime/orchestrator.ts:126`                                                                                               | 预算与预估挂在这里                           |

### 0.3 模式核心

| 事实                                                                                                                                                                    | 位置                                                             | 影响                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| 模式文件只用到三样：`dispatchStructured(teamCtx, …)`、`teamCtx.concurrency.get()` 做扇出宽度、`teamCtx.team` 做提示词上下文；外加 `synthesize.ts:81` 一处直接写小队消息 | `lib/squads/patterns/*.ts`                                       | 抽离面小：一个「执行一步」端口 + 宽度 + 提示词上下文 + 汇总回调      |
| `TOOL_REQUIRING_LENSES` 无处执行；模式调度一律走带工具的通道                                                                                                            | `types/agent/ultracode.ts:32`                                    | 端口必须声明是否提供工具，`repro` 在无工具实现下要拒绝而不是静默降级 |
| 工作流模型调用只做 JSON Schema 校验，模式用 Zod                                                                                                                         | `lib/workflow/nodes/ai/structured-turn.ts`；`schema-validate.ts` | 端口实现自己做 Zod 校验，不复用工作流的 JSON Schema 路径             |
| `lib/scm` 引用模式文件是 G3 阻断（squads 有 manifest，`api` 里没有模式文件）                                                                                            | `lib/squads/module.ts:53–105`；`scripts/gates/check-modules.mjs` | 核心文件列入 squads `api`                                            |
| 收敛 P5 要把 `judge-panel` 的聚合搬到 `packages/agent-orchestration/src/aggregate.ts`                                                                                   | 收敛计划 §8                                                      | 模式核心抽离排在 P5 之后                                             |

### 0.4 模板、预估、调度、门禁

| 事实                                                                                                                                                               | 位置                                                                                                                                     | 影响                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 小队模板选择器读 Zustand store（`BUILT_IN_TEAM_TEMPLATES` 播种）+ 插件注册表（只来自已弃用的 `agentTeamTemplates`），不读模板平台目录；没有目录载荷→模板的反向映射 | `hooks/squads/use-squad-templates.ts:82–88`；`lib/templates/legacy-sources.ts:79`                                                        | WP9                                                  |
| 模板中心按 `TemplateDomain` 分类，新增一类要改契约                                                                                                                 | `packages/plugin-contract/src/lib/templates/contracts.ts:4–5,135,144`                                                                    | 「流程」做成 skill 域的筛选视图（§1 E3）             |
| 「Flows」与浏览器录制器的「Saved flows」撞名                                                                                                                       | `i18n/messages/en.json`                                                                                                                  | 英文名 Playbooks（§1 E2）                            |
| 所有预估都是提示性的，`startSquadRun` 不估算。这是 ADR-0232 的既定决定（「只提示，从不拦」）                                                                       | `components/squads/squad-masthead.tsx:176–190` 等；ADR-0232 Decision                                                                     | WP4；设计 Q21 按 §1 E6 修订                          |
| 调度器 `createTask` 总是 `active`；插件桥先建后暂停；插件经 `ctx.userScheduler` 建 `agent-team` 任务默认要人工确认                                                 | `lib/scheduler/task-scheduler.ts:1579`；`lib/plugin/bridge/scheduled-task-bridge.ts:171–186`；`lib/scheduler/write-authority.ts:194–199` | WP6；定时流程由卡片上的「启用」经人确认创建（§1 E5） |
| Bot 模板不需要新贡献类型，`manifest.bots[]` 即可上目录                                                                                                             | `lib/bot/console/catalog.ts:84`                                                                                                          | 设计 Q25 的「Bot 模板贡献类型」一项删除              |
| 变更集门禁：风险档在 review agent 之前已算出，但没传进去                                                                                                           | `lib/scm/review/review-changeset.ts:137–149`                                                                                             | F2 的分档接入很直接                                  |

## 1. 本计划新增的决定（2026-11-07 用户确认）

| #                  | 决定                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1                 | 结构化步骤段放 `references/flow.yaml`。现有打包、磁盘镜像、扫描都不用改；skill 模式下 agent 也能经 `load_skill_resource` 读到                                                                           |
| E2                 | 英文名 **Playbooks**，中文「流程」。插件目录 `plugins/cognia-playbooks`（取代设计里的 `cognia-flows`）                                                                                                  |
| E3                 | 模板中心的「流程」是 skill 域的筛选视图：带 `references/flow.yaml` 的 skill 即流程。不新增 `TemplateDomain`                                                                                             |
| E4                 | F1 拆成 F1a（与收敛计划不重叠，先做）和 F1b（模式核心、`action.team.run`、模板引用 skill，等收敛 P5 合入后做）                                                                                          |
| E5                 | 定时流程不由插件自动建任务。流程卡片上的「启用定时」打开调度器表单，经人确认创建（符合 `confirmationRequired` 策略）；默认不存在任务，即默认关闭                                                        |
| E6（修订设计 Q21） | ADR-0232 规定预估只提示、不拦任何东西。预估一律只显示，不弹确认、不加阈值设置。花费由预算管：小队的 `RunBudgetGovernor`、skill 模式授予的 `maxBudgetUsd`、工作流新增的美元上限（WP5，这是预算不是预估） |

## 2. 代码放在哪

- **`lib/skills/playbook/`**（`skills` 子系统，kernel 级）：`flow.yaml` 的 schema、解析、校验、编译器。纯函数，只依赖 `types/**`，不引用任何 module。
- **`lib/playbooks/`**（新 module，带 `module.ts`）：宿主侧的启动、卡片数据、预估查询、斜杠命令注册、设置。新 module 需要 `scripts/gates/baseline-exceptions/` 下一条记录。
- **`lib/squads/patterns/`**（squads module）：模式核心，F1b 抽离后核心文件列入 squads `api`。
- **`plugins/cognia-playbooks/`**：内容。6 个模式积木 skill、6 个流程 skill、8 个小队模板、Bot 定义、技能资源。F2 起建立。

## 3. F0：文档

| WP    | 内容                                                                                                                                                                                                                                        | 产出     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| WP0.1 | 新 ADR-0254「A playbook is a skill that compiles to a workflow」（en + zh，`meta.json` 两份）：skill 为本体、`references/flow.yaml`、确定性编译与 AI 起草、派生工作流只读可分离、模式即积木 skill、引擎与内容分层、门禁由宿主自带、成本规则 | ADR 文件 |
| WP0.2 | ADR-0022 加修订注：模式核心脱离小队上下文；小队模板的 ultracode 组合来自 playbook 编译结果，规划器仅在无组合时使用；视角加 `architecture`、`tests`；`repro` 必须有工具                                                                      | 修订注   |

验收：`pnpm docs:build` 通过。无 changeset（文档）。

## 4. F1a：与收敛计划不重叠的平台前置

每个 WP 一个提交；有用户可见变化的带 changeset。

### WP1 `flow.yaml` schema 与解析

- `lib/skills/playbook/schema.ts`：Zod schema，`version: 1`。字段：
  - `inputs[]`：借用录制器 `InputVariable` 的形状（`name`、`kind: variable | literal | sensitive`、`description`、`required`）。
  - `steps[]`：`id`、`uses`（`skill:<id>` / `pattern:<kind>` / `squad:<templateId>` / `playbook:<skillId>` / `approval` / `issue.*` / `notify`）、`with`（参数，可引用 `{{inputs.x}}` 和 `{{steps.<id>.output}}`）、`needs`（依赖）、`parallel` / `forEach`、`requiresTools`、`humanConfirm`。
  - `limits`：`maxSubagents`、`maxFanout`、`maxBudgetUsd`。
  - `outputs`。
- `lib/skills/playbook/parse.ts`：从 skill 资源里取 `references/flow.yaml`，解析并逐条报告问题（RFC 6901 指针，沿用 `review-policy.ts` 的做法）。
- 测试：合法 / 非法 / 未知字段 / 环依赖 / 未知 `uses` 前缀。

### WP2 编译器与派生工作流

- `lib/skills/playbook/compile.ts`：`flow.yaml` → `VisualWorkflow`，确定性（同输入同输出，节点 id 由步骤 id 派生）。映射：
  - `skill:` → `action.skill.invoke` + `ai.prompt`（WP3 修好后）。
  - `pattern:` → `pattern.*` 节点。F1b 之前能编译出图，但不能运行：编辑器诊断照旧拦截，带模式步骤的 playbook 在卡片上不提供「以 workflow 运行」，并标明原因（规则 7，见 §7）。
  - `squad:` → `action.team.run`（参数形状按收敛 P5 之后的定义；F1a 只产出图，不运行）。
  - `playbook:` → `flow.subworkflow`（被调用的 playbook 先编译）。
  - `approval` → `action.approval.request`；`issue.*` → `action.issue.*`；`notify` → `action.notify.send`。
- 契约：`VisualWorkflow` 加 `derivedFrom?: { kind: "playbook"; skillId; contentHash; compiledAt }` 与 `readOnly?: boolean`（`packages/plugin-contract`，重建 authoring kit，cognia-plugins 仓库重钉）。
- 存储与保护：`updateWorkflow` 拒绝写 `readOnly` 行；编辑器只读打开；「分离」= `duplicateWorkflow` 并清掉 `derivedFrom` / `readOnly`。skill 内容哈希变化时重新编译覆盖派生行。
- AI 起草：无 `flow.yaml` 的 skill，「转成工作流」走现有 workflow 编辑器 copilot 起草，保存为普通（非派生）工作流。
- i18n：只读提示、分离按钮、来源徽章（en + zh-CN）。changeset：minor。

### WP3 修复 `action.skill.invoke`

- 读 `content`；插件 skill 取正文（非 inline 时经 `skills-io` 读取）；补正文断言测试。独立 bugfix 提交，changeset：patch。

### WP4 运行预估：新面与显示

- `RunEstimateSurface` 加 `workflow`、`playbook`；样本来源按各自运行记录取。
- 只显示，不确认（ADR-0232 不变，§1 E6）。接入点：小队启动（masthead 已有提示）、工作流手动运行、playbook 启动，复用 `RunEstimateHint`。skill 模式按 `flow.yaml` 估算并标「估计」。
- 测试：无样本、置信度低时的文案、skill 模式估算。i18n。changeset：minor。

### WP5 工作流运行预算上限

- `WorkflowSettings.maxCostUsd`（契约，和 WP2 一起重建 kit）；`runWorkflow` 内按使用量账本累计，超限停止并标记原因；子工作流继承剩余额度。
- 测试：超限停止、未知成本的处理（拒绝还是放行要在 WP 开始时对照 `quota-service.ts` 的「成本未知即拒绝」规则定）。changeset：minor。

### WP6 调度器初始状态

- `CreateScheduledTaskInput.status?: "active" | "paused"`；`task-scheduler.ts:1579` 照此创建，暂停的任务不上定时器；插件桥改为直接以 `paused` 创建（`defaultEnabled !== true` 时）。
- 测试：暂停创建不触发、桥行为。changeset：patch。

### WP7 视角枚举

- `VERIFIER_LENSES` 加 `architecture`、`tests`；对应怀疑者提示词进 `pattern-prompts.ts`（只加提示词定义，不动执行逻辑）；`params-schemas.ts` 的 enum 随之放宽；更新 `types/agent/ultracode.test.ts`。
- 与收敛 P5 只在 `pattern-prompts.ts` 有邻接，P5 改的是 `judge-panel.ts`，冲突面小；动手前确认对方未改该文件。

### WP8 skill 模式的子 skill 范围

- 加载流程 skill 时，读其 `flow.yaml` 的 `uses: skill:` / `pattern:` 引用，经能力授予 `skills.add` 把子 skill 加入本次运行范围；`limits.maxBudgetUsd` 进授予的 `maxBudgetUsd`。
- 落点：`lib/playbooks/` 产出授予，交给 `resolveSendOptions` 的授予链（ADR-0198），不改解析后的 `SendOptions`。
- 测试：子 skill 进入范围、预算取最小值。

### WP9 模板中心视图与小队选择器

- 模板中心：skill 域加「流程 / Playbooks」筛选入口（`hooks/templates/use-template-route-state.ts`），卡片显示「以 skill 运行 / 以 workflow 运行」、入口说明、定时启用入口（E5）。
- 小队模板选择器改读模板平台目录：补目录载荷 → `AgentTeamTemplate` 的映射；内置行在启动后才有，选择器加加载态；插件 `requires` 警告改从目录的 `dependencies` / `capabilities` 推出。`create-squad-dialog.tsx` 与 `agent-team-templates-section.tsx` 一起改。
- 测试 + i18n。changeset：minor。

## 5. F1b：收敛计划 P5 合入之后

### WP10 模式核心抽离

- 新 `lib/squads/patterns/core/`：每个模式一个纯函数，依赖注入的 `PatternStepPort`：`runStep({ prompt, schema(Zod), schemaHint, requiresTools, signal }) → { value, raw }`、`fanoutWidth`、`promptContext`、`onSynthesized?`。
- 三种实现：小队队员（包 `dispatchStructured`，行为不变）、工作流模型调用（`createLlmClient` + Zod 校验 + 一次修复重试）、`LlmClient`（门禁用）。无工具的实现收到 `requiresTools` 时直接报错，`repro` 视角在这些实现下不可选。
- 节点执行器变成薄壳：有小队上下文用队员实现，否则用工作流模型实现。执行器在工作流启动时注册（不再懒加载）。取消 `hidden`，`synthesizer-only` 诊断改为只拦「需要工具的视角用在无小队图里」。
- 核心文件列入 squads `api`。现有 6 个模式测试改测核心 + 薄壳。

### WP11 `action.team.run` 从模板启动

- 在 P5 之后的 `startSquadRun` 路径上，加 `templateId` 参数：先实例化（`applySquadTemplate` 的平台路径，记录来源），再启动；加 `ultracode` 参数。

### WP12 小队模板引用 playbook

- `AgentTeamConfig.ultracode` 加 `playbookSkillId?`：有就用 playbook 编译出的组合，跳过规划器（契约，重建 kit）。

## 6. F2：流程 1（变更审查）

- `plugins/cognia-playbooks/` 建立，内置启动激活。内容：6 个模式积木 skill、`review` 流程 skill（`references/flow.yaml`）、`parallel-review` 与 `security-audit`（安全优先视角组）模板、`/review` 命令。
- 8 个内置小队模板从 `BUILT_IN_TEAM_TEMPLATES` 搬进插件；`squad-template-platform.ts` 的解析把 `builtin.agentTeam.<id>` 映射到插件模板；`stores/squads/agent-team-store/initial-state.ts`、`builtin-overlays.ts`、`hooks/discover/use-discover-query.ts` 改读插件来源。
- 审查核心（宿主自带，不依赖插件）：扫描 4 视角 → 证伪（medium 及以上前 15 条，3 个怀疑者）→ 汇总；「未证伪」标注；被推翻的 critical → 需要人批。
- R2：`review-changeset.ts:139` 把 `risk.tier` 传给审查；low 档维持单次逐文件 + 只证伪 high/critical；medium/high 档跑完整核心。`unavailable` 语义不变。
- R3（`lib/squads/pr-feedback/reviewer.ts`）改调核心；R4 仅当任务产出是变更集时调核心。
- 验收：单测；在一个真实变更集上跑通 low、medium 两档；`review` 以 skill 运行和以 workflow 运行各一次；从 `/review`、小队模板、工作流库三处启动行为一致。

## 7. 规则与门禁

- 每个 WP：同目录测试（`pnpm audit:colocated-tests`）、en/zh-CN 双语 + `pnpm i18n:build` + `pnpm lint:i18n`、`pnpm audit:modules`、相关 jest（`pnpm test -- <路径>`，不跑全量）、`pnpm typecheck`（16 GB 堆）。
- 动到 `packages/plugin-contract` 的 WP（WP2、WP5、WP12）：`pnpm build:packages`、`pnpm plugin:author-imports`、重建 authoring kit 并到 cognia-plugins 重钉。
- 共享工作区：只提交自己的路径（`git commit --only`），提交前 `git diff --cached --name-only` 核对；`lib/squads/` 下动手前先看收敛会话是否有未提交改动。
- 休眠三件套：F1b 之前，带模式步骤的 playbook 没有 workflow 模式入口——类型注释写明、卡片上标「暂不可用」、测试钉住。

## 8. 风险

- **收敛计划进度不可控**：F1b 被 P5 阻塞。F1a 的 9 个 WP 足够先做；若 P5 推迟，WP10 可以和收敛会话约定只碰 `patterns/` 而不碰 `judge-panel.ts` 的聚合部分。
- **契约改动集中**：WP2、WP5、WP12 都要重建 kit。WP2 与 WP5 合并成一次重建。
- **选择器切换到目录**会让内置模板在账户解锁、目录启动前不可见，需要加载态，并确认移动端同样处理。
- **WP5 成本未知的处理**会影响所有工作流，不只是 playbook；开工前单独确认。
