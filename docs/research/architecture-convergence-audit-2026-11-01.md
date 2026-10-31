# Cognia 架构现状审计：运行时与 UI 耦合、核心概念重复、关口靠约定

> 审计日期：2026-11-01<br>
> 基线：`codex/modular-sync-20261030` 分支，HEAD `2a2c71aec4`，含其他会话未提交的改动（共享工作区）<br>
> 方法：静态审计，没有运行应用。
>
> - 门禁脚本实际运行了两个：`check-headless-registry.mjs`、`check-host-parity.mjs`。
> - 结构计数由脚本统计（`wc`、`grep`、解析 `lib/db/schema.ts`）。
> - 三个只读代理（Claude Haiku）分别检索"运行时与 UI 耦合""工作实体、队列、限流、去重""存储、写入权威与出口关口"三个维度。
> - 关键结论由人工抽查确认。
>
> 标记：**[已核实]** 表示审计者亲自读过代码或运行过门禁；**[待核实]** 表示只来自检索结果或注释，未在代码或运行时确认；其余条目来自代理检索，附文件路径，可能有少量误判。<br>
> 关联：[DeepSeek Super-agent 对比](./deepseek-superagent-harness-comparison-2026-11-01.md)、ADR-0059（无头 brain）、ADR-0224（常驻 Host）、ADR-0247/0248/0249/0250<br>
> **修订（2026-11-01，第二轮审查后）**：Codex（gpt-6.1-sol）做了对抗性审查和独立审计，关键结论由审计者在代码里复核。本版更正了表数、宿主一致性差异数、门禁数和 store 引用口径，补上第一轮遗漏的问题（§10），并更新了待核实清单（§9）。收敛方向已由 ADR-0250 决策（§8）。

## 0. 结论先行

当前问题主要是架构性的，有两个根因：

1. **运行时没有从 WebView 应用里抽出来。** 桌面是一个 React 应用顺带当运行时，常驻 Host 是把同一套前端代码无头化运行，再补一层注册表。每加一个功能，就可能多一份"桌面有、Host 没有"的债。
2. **没有共享的工作内核。** 运行和任务、队列、重试、限流、去重各自实现。安全和授权关口只能事后挨个出口补上，又缺少覆盖率门禁，所以很难放心从 shadow 切到 enforce。

团队并非不知道这些问题：注册表里有 122 个门禁（11 组），很多带"只许变少"的基线；宿主一致性门禁逐条登记了差异；ADR-0059 早就规定新运行时必须注册到无头层。问题在于**债务被量化了，却没有被偿还**，新功能叠加的速度快过收敛的速度。

| 维度           | 关键数字                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 运行时初始化器 | 105 个，其中 75 个拥有运行时；Host 有对应的 29 个；46 个没有，其中**至多 32 个**未被文档或标注覆盖（上限，见 §2.2）            |
| 宿主一致性     | 基线 183 项，**当前实际 200 项**（新增 26、关闭 9）；65 个子系统标为"尚未迁移"，另有 27 个未分类；门禁当前不通过               |
| 运行时读 store | 静态 import 口径 355 个 `lib/` 文件引用 `@/stores/`、294 个命令式读写；计入动态 import 为 475 / 409（不全是 UI 状态，见 §2.1） |
| 本地数据库     | Dexie **393** 张活动表（另有 3 张已删除；`CURRENT_SCHEMA` v250）                                                               |
| 重复概念       | 约 23 种运行/任务实体、约 17 个带重试的队列（≥5 条退避曲线）、约 22 个并发限流器、约 15 套去重机制                             |
| 真相源         | Dexie、brain 双写持久化加旧快照、约 9 个 Rust SQLite、Postgres、账号同步 DO                                                    |
| 已确认缺陷     | router-fusion outbox 无退避、无上限，且会饿死新效果；工作流 cron 在 TS 与 Rust 两端语义不一致，注册失败被吞掉                  |
| 第二轮补充     | 数据权威随连接状态切换；插件 API 938 个方法只有 120 个声明无头可用；契约语义一致性门禁失败；双宿主测试不在 PR 必过路径（§10）  |

## 1. 规模基线 [已核实]

| 指标                                                       | 数值                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `lib/`+`hooks/`+`stores/`+`components/` 非测试 TS/TSX 行数 | 约 119 万行                                                                                               |
| 其中超过 1500 行的文件                                     | 70 个                                                                                                     |
| `lib/` 非测试文件                                          | 5747 个                                                                                                   |
| `hooks/` 非测试文件                                        | 745 个                                                                                                    |
| `components/providers/initializers/` 非测试文件            | 105 个                                                                                                    |
| `lib/headless/runtimes/` 非测试文件                        | 30 个                                                                                                     |
| ADR（英文）                                                | 245 份（截至本次修订，编号到 0250，有重号和缺号）：Accepted 221、Proposed 21、Implemented 1、Superseded 2 |

最大的 10 个非测试文件：

| 行数 | 文件                                       |
| ---- | ------------------------------------------ |
| 7743 | `lib/plugin/core/manager.ts`               |
| 7299 | `hooks/chat/use-claude-chat-controller.ts` |
| 6606 | `lib/claude/build-options.ts`              |
| 6064 | `lib/ai/agent/external/manager.ts`         |
| 5316 | `components/desktop/channel-list.tsx`      |
| 5138 | `components/chat/composer.tsx`             |
| 4201 | `lib/scheduler/task-scheduler.ts`          |
| 4187 | `lib/connectors/bus.ts`                    |
| 4110 | `lib/companion/desktop-write-source.ts`    |
| 3633 | `lib/plugin/core/context.ts`               |

## 2. 运行时与 UI 耦合

### 2.1 分层方向反了 [已核实]

| 依赖                              | 文件数                |
| --------------------------------- | --------------------- |
| `lib/` → `@/stores/`（Zustand）   | 355                   |
| `lib/` → `@/hooks/`               | 33                    |
| `lib/` → `@/components/`          | 31                    |
| `lib/` 中带 `"use client"` 的文件 | 319（代理复数为 322） |

以上是**静态 import** 口径。Codex 复核时把动态 `import()` 和 `require` 也算进去：引用 `@/stores/` 的 `lib/` 文件为 475 个，其中 409 个命令式调用；引用 `hooks`/`components` 的为 74 个。

补充说明（代理检索）：

- **`getState()` 的用法。** 引用 store 的 355 个文件中，294 个调用了 `.getState()`、`.subscribe()` 或 `.setState()`，也就是在 React 之外命令式读写 store。注意：其中有一部分 store 承载的是领域状态（例如调度器、成本镜像，brain 也会用），不全是 UI 投影。所以这些数字只能说明"运行时与 Zustand 耦合"，不能直接等同于"运行时根据 UI 做决策"。被引用最多的是 settings（99）、chat（约 100）、project-store（46）、plugin-runtime（42）、agent-team-store（41）。
- **`"use client"` 多为装饰。** 只有 65 个 `lib/` 文件真正引用了 React。抽样 22 个带该指令的文件，约一半是运行时或适配器。无头 runtime 也直接导入了 15 个带该指令的模块，Node 会忽略它。
- **反向依赖的典型例子。** `lib/work-submission/chat-adapter.ts`、`lib/agent/composition/chat-orchestrations.ts`、`lib/claude/usage.ts`、`lib/claude/env-resolver.ts`、`lib/agent/external-agent-selection.ts` 引用了 `hooks/chat/use-claude-chat-controller`。[已核实]

### 2.2 初始化器与无头 Host 对照

代理把 105 个初始化器逐个分类：30 个纯 UI 或门控，75 个拥有运行时。75 个中：

| 情况                                                                  | 数量   |
| --------------------------------------------------------------------- | ------ |
| 有完整的无头对应（`lib/headless/runtimes/*.ts` 或 `initializers.ts`） | 25     |
| 部分对应                                                              | 4      |
| 没有对应，但有文档或标注说明                                          | 14     |
| **没有对应，也没有任何说明**                                          | **32** |

32 是**上限**：第二轮复核发现，至少 Anthropic/Codex 配额探测和更新中心在 `headless-registry-exclusions.json` 里其实有说明。没有逐项清单之前，这个数不能作为精确基线。32 个候选缺口中，代理点名的有：自动化审计镜像、managed-desktop 告警、IM 通知、harness evolution、best-of-N 恢复、CLI 配置自动推送、终端启动、models.dev 和 OpenRouter 目录同步、Anthropic/Codex 配额探测、OAuth 续期、执行控制分派表、glance 发布、更新中心等。完整表格见代理原始输出，未逐项复核。

部分对应的 4 项：

- `deferred-boot-initializers-impl`：无头只跑了 work-submission outbox，幻影运行守卫没有。
- `background-task`：无头只做恢复，没有结算监听，也不发完成通知。
- `shared-chat-lifecycle`：无头只有 feed。
- `template-platform`：无头只做信任对账。

已核实的例子：

- **OAuth 续期只在桌面运行。** `refreshExpiringOAuthCredentials` 全仓库唯一的调用点是 `components/providers/initializers/provider-oauth-refresh-initializer.tsx:46`。brain 是否持有 OAuth 凭据 [待核实]。
- **自动归档的豁免在 brain 上失效。**
  - `lib/chat/auto-archive-schedule.ts:80-102` 用聊天 store 判断哪些会话"已打开"，也用它判断哪些"正在运行"（`inFlightSessionIds(state.sessions)`），以此豁免归档。注释承认在 brain 上 store 为空，所以豁免是空操作。
  - 后果：Host 上正在运行的会话可能失去"运行中不归档"的保护。是否会真的被归档 [待核实]。

### 2.3 写在 `hooks/` 里的运行时

| 模块                                            | 角色                                                                           | 无头对应                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| `hooks/chat/use-claude-chat-controller.ts`      | 7299 行：发送、steer、审批、停止编排；21 个 `useEffect`、186 处 `getState()`   | 没有渲染端发送路径的对应；CLI 另写了一套 |
| `hooks/chat/steer-runtime.ts`                   | steer 队列，live 和 queued 两条通道，模块级 Set/Map                            | 无；CLI 另有 `use-steer-queue.ts`        |
| `hooks/chat/background-result-runtime.ts`       | 子 Agent 结果回流到父会话                                                      | 无；brain 只做恢复                       |
| `hooks/system/use-tauri-events.ts`              | 把 Tauri 托盘、菜单、job 事件转给 store 和调度器 [已核实 job 事件只转给调度器] | 无；brain 通过 RPC 接收调度事件          |
| `hooks/account-sync/use-account-sync-poller.ts` | 前台 20 秒轮询，新设备请求的提示                                               | 部分：无头有同步循环，没有提示路径       |
| `hooks/plugins/use-cli-bridge-events.ts`        | CLI 回环桥事件，定时清扫                                                       | 无                                       |

### 2.4 依赖"窗口打开 / 会话下次打开"的行为

| 位置                                                                     | 行为                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `hooks/chat/steer-runtime.ts:118-125`                                    | "打开"的定义是在 `openSessionIds` 里、有 pane，或有后台保持     |
| `hooks/chat/background-result-runtime.ts:11-12`                          | 父会话关闭时"下次空闲打开时再送" [已核实]                       |
| `lib/chat/reactions-store.ts:6-9`、`lib/chat/restore-withdrawn.ts:23-26` | 等会话下次打开时读取                                            |
| `lib/scheduler/task-scheduler.ts:850-858`                                | 错过任务的补跑只在页面可见且是 leader 时进行                    |
| `lib/collab/refresh-scheduler.ts:163-170`                                | 只在可见时刷新；无头传入"始终可见"                              |
| `lib/browser/local-client.ts:213-257`                                    | `document.hidden` 时跳过订阅                                    |
| `components/runtime/app-runtime.tsx:200-295`                             | 几乎所有初始化器都挂在 `AccountGate` 内，锁定状态下一个都不运行 |

ADR-0204 的背景里写明，没有 pane 的会话曾经无法运行（审批被自动拒绝、同伴消息被拒收），后来靠"后台保持"补上。[已核实]

### 2.5 宿主一致性门禁 [已核实：运行了门禁]

`node scripts/gates/check-host-parity.mjs` 的退出码为 1，输出：

- 4 个已核实的"物理上只能在桌面"的约定；
- 9 个已登记的差异已经关闭，需要运行 `pnpm audit:host-parity:baseline` 锁定；
- **27 个子系统带有宿主守卫，但没有分类记录**，例如 `lib/account-sync`、`lib/background-tasks`、`lib/best-of-n`、`lib/sandbox`、`lib/mcp`、`lib/gateway`、`hooks/goal`、`components/runtime`。

`scripts/gates/host-parity-baseline.json` 登记了 183 项差异：`A:`（绕过宿主层）87 项，`C:`（只有一侧实现的 RPC）96 项。

**当前实际差异是 200 项**：A 类 96 项，C 类 104 项（`--report` 输出；新增 26 项 = 9 项 A + 17 项 C，关闭的 9 项都在 C 类）。门禁明确拒绝把新增债务写进基线，所以"运行 `:baseline` 锁定关闭项"之前，必须先逐项处理这 26 项。[已核实 A 类计数]

`scripts/gates/host-parity-annotations.json` 的子系统分类：

| 分类                                  | 数量 |
| ------------------------------------- | ---- |
| unmigrated（尚未迁移）                | 65   |
| ui-assumption（假设有 UI）            | 60   |
| physically-impossible（物理上不可能） | 19   |
| seam-infrastructure（接缝基础设施）   | 12   |

被标为 unmigrated 的包括 `lib/agent`、`lib/ai`、`lib/chat`、`lib/claude`、`lib/a2ui`、`lib/browser`、`lib/canvas`，也就是最核心的模块。

### 2.6 无头注册表门禁的盲区 [已核实]

`node scripts/gates/check-headless-registry.mjs` 当前只报告一条过时的排除项（`renderer-perf-initializer.tsx` 的 `subscribeRuntimeTargetContext`），其他全部通过；排除文件里登记了 23 个初始化器的 29 个符号。

但它只检查名字形如 `installX`、`startX`、`registerX` 的副作用符号（见脚本头注释）。`refreshExpiringOAuthCredentials` 这类命名不在其列，所以 2.2 的候选缺口里，有相当一部分是门禁看不到的。

改进时必须保留它现有的判定条件：**"在 brain 可达的模块图里被调用"，而不是"模块可达"**。脚本头注释用 `installPlanNotificationActions` 说明过原因：模块因为其他导出而可达，但安装函数本身从未被调用。只放宽命名覆盖，不能放宽这个条件。

## 3. 核心概念重复

### 3.1 运行和任务实体（约 23 种）

| 表                                                              | 状态词汇                                                                          | 与 `executionRuns` 的关系                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| executionRuns                                                   | queued, running, waiting, paused, recovery_required, completed, failed, cancelled | 中枢，11 种 kind                                                     |
| agentTasks / agentTaskAttempts                                  | pending…completed / queued…interrupted                                            | 任务无关联；attempt 有可选 `runId`                                   |
| agentTeamRuns / Tasks / ChildRuns                               | 10 种 / 8 种 / 团队状态加 terminated                                              | 经 bridge；child 有 `runId`                                          |
| chatGoals                                                       | active…preempted（8 种）                                                          | 经 agent-state-bridge                                                |
| agentPlans                                                      | draft…rejected（9 种）                                                            | 经 agent-state-bridge                                                |
| issues / issueRuns                                              | 6 列看板 / queued…cancelled                                                       | issueRuns 不写 executionRun [待核实]                                 |
| workflowRuns                                                    | pending…cancelled                                                                 | 派生 id `execution:workflow:<id>`                                    |
| scheduledTasks / scheduledTaskRuns                              | active…expired / pending…skipped                                                  | 部分：execution.id 作为 executionRunId 传入，对应行是否存在 [待核实] |
| botEventDeliveries                                              | pending…dismissed（8 种）                                                         | `run_bot_<deliveryId>`                                               |
| backgroundTasks                                                 | running, done, error, interrupted                                                 | [待核实]                                                             |
| runRecords                                                      | running…idle                                                                      | 独立（数字 runId）                                                   |
| workSubmissions                                                 | pending…settled                                                                   | 有 `runId`                                                           |
| collabRuns、twinJobs、memoryJobs、mediaGenerationJobs、evalRuns | 各自一套                                                                          | 独立                                                                 |
| hostDispatchQueue                                               | pending…deadletter                                                                | 可选 `runId`                                                         |

"成功"有四种写法：`completed`、`succeeded`、`done`、`sent`。评审状态也有 `review` 和 `in_review` 两种。

此外，ADR-0137 的 `delegation` 运行和 ADR-0132 的 Issue 是两种互不相通的"承诺"载体。`promoteDelegationToIssue` 只在注释中出现，并没有实现 [已核实]。ADR-0247 对此做了决策。

### 3.2 带重试的持久化队列（约 17 个）

共享重试策略在 `packages/plugin-contract/src/lib/queue/retry-policy.ts`（`decideNextAttempt`：5 次、1 秒起翻倍、25% 抖动、60 秒上限，遵守 Retry-After），但只有 Bot 队列、移动端队列和插件 resilience 在用。

| 队列                                                                          | 键与唯一性                                               | 重试                          | 运行器                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------- | -------------------------------------- |
| outboundQueue                                                                 | `notificationOperationKey` 唯一；`idempotencyKey` 不唯一 | 5 次、60 秒上限、熔断器       | `lib/connectors/outbound-runner.ts`    |
| mobileOutboundQueue                                                           | `idempotencyKey` 不唯一                                  | 共享策略                      | `lib/queue/outbound-queue.ts`          |
| notificationDeliveryIntents                                                   | `operationKey` 唯一                                      | 5 次，`min(5 分钟, 1 秒·2^n)` | `lib/notifications/delivery/`          |
| notificationProjectionWork                                                    | `subjectKey` 唯一，30 秒租约                             | 1 秒·2^n，5 分钟上限          | `coordinator.ts`                       |
| integrationActionJobs                                                         | `[accountId+idempotencyKey]` 唯一                        | 5 次（无幂等性时 1 次）       | `lib/integrations/action-runner.ts`    |
| connectorCleanupJobs                                                          | id                                                       | 30 秒·2^(n-1)，30 分钟上限    | `lib/db/connector-cleanup-jobs.ts`     |
| workSubmissions                                                               | `[accountId+idempotencyKey]` 唯一，租约                  | 5 秒·2^(n-1)，1 小时上限      | `lib/work-submission/outbox-runner.ts` |
| hostDispatchQueue                                                             | `idempotencyKey` 唯一                                    | 6 次，2 秒·2^n，5 分钟上限    | `lib/db/host-dispatch-queue.ts`        |
| fusionOutbox                                                                  | `effectId`，先查后加                                     | **无退避、无上限**            | `lib/router-fusion/db/outbox.ts`       |
| botEventDeliveries                                                            | `dedupKey` 唯一，2 分钟租约                              | 共享策略                      | `lib/bot/runtime/delivery-runner.ts`   |
| memoryJobs                                                                    | `dedupeKey` 不唯一，10 分钟租约                          | `retry_wait`                  | `lib/memory/lifecycle/job-worker.ts`   |
| twinJobs                                                                      | 无                                                       | 1 秒·2^(n-1)，60 秒上限       | `lib/twin/job-retry.ts`                |
| evalOnlineQueue、accountSyncOutbox、mediaGenerationJobs、connectorInboundJobs | 各异                                                     | [待核实]                      | —                                      |

`lib/db/bot-event-deliveries.ts:8-12` 的注释本身就警告过退避曲线的漂移。

### 3.3 并发限流器（约 22 个）

`lib/` 层：

| 限流器               | 默认值                       | 文件                                                                   |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| 执行代理 `ai-turn`   | 16                           | `lib/execution/broker.ts:62` [已核实]                                  |
| 工作流全局闸门       | 16                           | `lib/workflow/runtime/run-concurrency-gate.ts`                         |
| 工作流单次运行       | 4                            | `types/workflow/visual.ts`                                             |
| 调度器全局           | 5                            | `lib/scheduler/concurrency-limit.ts` [已核实]                          |
| 团队 teammate        | 5                            | `types/agent/agent-team.ts`                                            |
| 持久化团队公平调度器 | 8                            | `packages/agent-orchestration/src/fair-scheduler.ts`、`coordinator.ts` |
| 连接器平台发送       | 16                           | `outbound-runner.ts`                                                   |
| 连接器令牌桶         | 20 / 每秒 5                  | `outbound-runner.ts`                                                   |
| 集成动作             | 4 / 账号                     | `action-runner.ts`                                                     |
| 插件加载 / 更新      | 4 / 3                        | `lib/plugin/`                                                          |
| MCP 连接             | 4                            | `lib/mcp/runtime-gateway.ts`                                           |
| SFTP                 | 2                            | `lib/sftp/transfer-queue.ts`                                           |
| council / ensemble   | 4                            | `lib/ai/`                                                              |
| 批处理应用           | 16 / 4                       | `lib/workflow/apps/batch-service.ts`                                   |
| 同步拉取             | 6                            | `lib/sync/companion-sync.ts`                                           |
| 项目协调器线程       | 16（`maxConcurrentThreads`） | `lib/project-coordinator/config.ts`                                    |

Rust 层：

| 限流器           | 默认值   |
| ---------------- | -------- |
| Python 插件调用  | 4        |
| Node 安装        | 2        |
| 沙箱池 / 准备    | 4 / 4    |
| 网关单 key       | 默认不限 |
| companion 桥在途 | 128      |
| 文件 IO          | 8        |

这些限流器互不感知，也都不区分请求来自人还是自动化（ADR-0248 处理后者）。

### 3.4 去重机制（约 15 套）

由唯一索引强制：

- connectorInboundJobs、botEventDeliveries、evalOnlineQueue、workSubmissions、integrationActionJobs、hostDispatchQueue、通知的 operationKey。

只靠应用层"先查后写"：

| 位置                        | 依赖                                                      | 风险                  |
| --------------------------- | --------------------------------------------------------- | --------------------- |
| 入站台账（`inboundLedger`） | 复合索引非唯一，依赖 `recordAndCheckInbound`              | 是否在事务内 [待核实] |
| 连接器外发 `idempotencyKey` | `findDeliveredByIdempotencyKey`，外加内存中 1000 条的 LRU | 索引不唯一            |
| memoryJobs `dedupeKey`      | 非唯一                                                    | —                     |
| fusionOutbox `effectId`     | `ledger-store.ts:434` 先查后加                            | —                     |

## 4. 多个真相源

| 存储                  | 位置                                                                                                                                                                                                                      | 权威范围                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dexie `CogniaDB` v250 | `lib/db/schema.ts`                                                                                                                                                                                                        | 桌面全部应用数据（调度器没有独立库，`SchedulerDatabase` 只是一层包装；`snapshot.ts` 头注释所说的"独立库"已过时）                                                       |
| brain 持久化          | `cli/src/serve/persistence/`                                                                                                                                                                                              | `journal-v4`（检查点加 jsonl，决定顺序）与 `sqlite-v5`（k/v）在迁移期间双写，切换要人工完成；另有旧的 JSON 快照（`cli/src/db/snapshot.ts`）。运行时默认用哪个 [待核实] |
| Rust SQLite           | 各 crate 一个文件：`jobs.sqlite`、`task-workspaces.sqlite`、`scheduler_meta.db`、`vectors.sqlite`、`file-share.sqlite`、`environment.sqlite`、agent-state `db.sqlite`、companion-security、companion-bus `SqliteAppStore` | 各自 crate 的状态                                                                                                                                                      |
| Postgres              | `crates/cognia-collab-server`                                                                                                                                                                                             | 组织协作数据，以服务端为准（ADR-0149）                                                                                                                                 |
| 账号同步              | Cloudflare DO 操作日志加 R2 快照（ADR-0215），协议源码在 cognia-services                                                                                                                                                  | 跨设备复制的数据，按字段 HLC，后写者赢                                                                                                                                 |

存在两份可写副本的地方：

| 两份副本                                      | 冲突处理                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| 账号同步各副本                                | 按设计可写，有收敛测试                                                    |
| Dexie 与 Rust `run_mirror`                    | 有文档：以 Dexie 事件日志为准                                             |
| Dexie 与 `SqliteAppStore`                     | 未找到对账路径 [待核实]                                                   |
| Dexie `scheduledTasks` 与 `scheduler_meta.db` | 都在写，对账逻辑没看 [待核实]                                             |
| brain 与 Host 的 SQLite 降级存储（见 §10.1）  | **没有对账**：brain 断连时降级存储可写，重连后切回 brain [已核实选择顺序] |

## 5. 写入权威与出口关口靠约定

### 5.1 唯一写入者

| 规则                                                           | 现状                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyRuntimeIssueStatus`（`lib/db/issues.ts:1085`）           | 唯一调用方是 `lib/issues/run/registry.ts`。其他写 `db.issues` 的地方是良性的。代码里有守卫，没有门禁                                                                                                                                                                             |
| `lib/scheduler/write-authority.ts`（ADR-0167，号称"唯一关口"） | `scheduler-db.ts` 可以直接写任务，任何导入者都能绕过；没有门禁检查                                                                                                                                                                                                               |
| 只在注释里声明"唯一写入者"、没有门禁也没有测试                 | `lib/router-fusion/db/ledger-store.ts`（钱的唯一写入者）、用量台账、`stores/shortcuts/app-keybinding-store.ts`、`lib/db/mcp-servers.ts`、`cognia-codeserver/src/profile.rs`、`cognia-net/src/proxy_config/mod.rs`、cua_sandbox README、`src-tauri/src/claude/commands.rs:359` 等 |

### 5.2 出口关口

**外发授权（ADR-0239）**

- 四个规划器的已知调用方有 `claude-chat-events.ts`、`run-and-capture.ts`、调度执行器、投递网关、集成 action-runner、`browser/submission-gate.ts`。
- **没有门禁扫描调用方**。新加的外发工具如果不经过规划器，什么都不会失败。
- 默认按类别处于 shadow；shadow 的观察调用会吞掉错误，例如 `run-and-capture.ts:1561`、`claude-chat-events.ts:837`。
- ADR-0239 的"已知缺口"列表本身记录了几处绕过：`/lark` 斜杠命令的审批绕过 `approveTool`；GET 请求的数据从不被暂扣；专用 worker 里的 WebSocket 看不见。

**投递网关**

- `delivery-gateway.static.test.ts` 只拦截从字面路径 `@/lib/db/outbound-jobs` 具名导入 `enqueueOutbound*` 的情况。它只扫描 `app`、`lib`、`components`、`hooks`、`stores`，覆盖不到 `packages`、`plugins`、`cli`、`sidecar`，也覆盖不到命名空间导入、相对导入和其他修改函数。
- `outbound-tab.tsx:104-110` 对死信的重试不经过规划器。这是否是有意的人工重试 [待核实]。
- **外发 runner 发送前不重新检查授权**（`outbound-runner.ts:663-667` 只透传 `authorizedBy`）。shadow 期间入队的任务，切到 enforce 后可能仍会发出 [待运行时核实]。
- **入队时的规划结果没有和队列行一起保存。** `delivery-gateway.ts` 入队时删除了原始 `authorization`，只保存 `authorizedBy`；shadow 下被拒的分支返回 send 和回执，但不带 `authorizedBy`；回执在入队之后单独写入，并且允许失败。所以 runner 事后无法可靠地判断"这一行入队时是 shadow 下的非 allow"。要修复，必须先让授权来源、模式、规划结果和策略版本与队列行原子保存。

**网络出口门禁**（`check-network-egress.mjs`）

- 扫描 TS 与 Rust，例外清单有 62 条。
- 不扫描 `cli/`（约 90 处裸 `fetch`）和 `sidecar/`（约 14 处）。理由可能是 Node 进程没有 WebView 的 CSP [意图待核实]。

**PII 门禁**（`check-pii-boundaries.mjs`）

- 按 import 判断：文件引入了 `@cognia/redact` 就算通过，不检查是否真的调用了 `hasNoLeakingPii`。

### 5.3 运行中授权检查只做审计 [已核实]

`lib/execution/acting-authority.ts:348` 的 `observeActingAuthority` 注释写明"Audit-only… Callers must never branch on this result"。`lib/governance/producers/connector.ts:50-55` 的路由决策把 `policyRef.version` 硬编码为 `"1"`。

## 6. 已确认的缺陷 [已核实]

**router-fusion outbox 无退避、无上限，而且会饿死新效果。**

- `lib/router-fusion/db/outbox.ts` 的 `drainOnce` 按 `createdAt` 取最早的 500 条 `pending`。
- 失败只增加 `attempts`、写入 `lastError`，状态仍是 `pending`。
- 没有退避，没有次数上限，也没有死信。
- 后果：永久失败的效果每次 drain 都会重试；毒行一旦超过 500 条，之后的新效果永远轮不到执行。

**工作流 cron 在 TS 和 Rust 两端语义不一致，而且失败被吞掉。** 编辑器用的 TS 解析器接受 `L` 和 `#`（如 `0 0 L * *`、`0 0 * * 1#2`），Rust 守护进程（`crates/cognia-scheduling/src/workflow/triggers/cron_daemon.rs:62`）明确拒绝。注册通过 `lib/workflow/runtime/tauri-bridge.ts` 的 `safeInvoke` 调用，异常只记录一次就返回 null，于是 `registerTrigger` 正常返回。结果是用户以为保存好的触发器从来没有注册成功。`persistRunState` 也走同一个 `safeInvoke`。

**Monitor 工具承诺的送达没有消费者。** `sidecar/src/tools/builtin/core-files/monitor.ts` 告诉模型结果会在触发时送达，但 `jobs://monitor-fired` 只转给了调度器（`hooks/system/use-tauri-events.ts`）。ADR-0249 处理这一项。

## 7. 门禁资产（正面）

- `scripts/gates/check-all.mjs` 是唯一的门禁注册表，CI 通过 `--list-groups` 读取它。`check-gate-registry.mjs` 会让未注册的校验脚本失败。
- 门禁注册表里共有 122 个门禁、11 组，默认都是阻塞的；`package.json` 有 14 个 `:baseline` 写入脚本；仓库里有 21 份 `*-baseline.json`。
- **"只许变少"并不可靠**：基线写入脚本会按当前扫描结果直接覆盖基线，检查再拿同一工作树里的基线来比较。同一个 PR 可以顺手改大基线，CI 也不和基础提交比较。
- 架构类门禁：Rust 分层、sidecar 分层、包边界、静态导出、无头注册表、宿主一致性、RPC 语义一致性、invoke 参数一致性、命令一致性、LLM 台账边界、供应商名分支、工作区归属等。

这些门禁说明问题已被识别和度量。缺的是两样：覆盖面（出口类门禁大多按约定生效），以及偿还节奏。

## 8. 收敛方向（已由 ADR-0250 决策）

第一版列出的四条方向（运行时内核脱离 UI、一条工作主干、统一入口出口与队列原语、关口覆盖率门禁）已写入 ADR-0250。第二轮审查之后的设计决定：

- 桌面倾向本机运行 brain，WebView 作为客户端，由一周的 spike 验证。
- 独立模式（浏览器、手机 BYOK）保留为轻量路径，不属于内核。
- 宿主只有一个权威，客户端只排队意图。
- 插件 API 换新契约，与阶段 2 一起硬切换。
- 话题被承诺以 owner 身份跟随时，追问只由承诺负责执行。

详见 ADR-0250 和 `docs/plans/2026-11-01-convergence-phase-0.md`。

## 9. 待核实清单

| #   | 事项                                                                                                                                                                    | 建议的核实方式                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Host 上正在运行的会话会不会被自动归档（2.2）                                                                                                                            | 在 brain 上跑归档任务，同时让一个会话在运行                               |
| 2   | brain 是否持有 OAuth 凭据，过期后是否失效（2.2）                                                                                                                        | 查 `lib/headless/runtimes/host-provider-keys.ts` 与凭据类型；做 Host 冒烟 |
| 3   | 32 个未说明缺口中，哪些会造成用户可见的故障                                                                                                                             | 逐项对照 `check-host-parity` 的分类，补全标注                             |
| 4   | shadow 期间入队的外发任务，切到 enforce 后是否仍会发出（5.2）                                                                                                           | 单元测试：shadow 下入队，切换模式，再运行 runner                          |
| 5   | Dexie 与 `SqliteAppStore`、`scheduledTasks` 与 `scheduler_meta.db` 的对账                                                                                               | 读写入路径，找对账代码                                                    |
| 6   | brain 持久化运行时的默认后端（journal-v4 还是 sqlite-v5）                                                                                                               | 读 `defaultManifest`                                                      |
| 7   | `issueRuns`、`backgroundTasks`、`runRecords`、`mediaGenerationJobs`、`agentTeamChildRuns` 与 `executionRuns` 的关联；`scheduledTaskRuns` 对应的 executionRun 行是否存在 | 读写入函数                                                                |
| 8   | `inboundLedger` 的先查后写是否在事务内                                                                                                                                  | 读 `recordInbound`                                                        |
| 9   | `evalOnlineQueue`、`accountSyncOutbox`、`mediaGenerationJobs`、`connectorInboundJobs` 的重试与运行器                                                                    | 读运行器                                                                  |
| 10  | 连接器 runner 的 `computeBackoffDelay(job.attempts)` 是否差一                                                                                                           | 读实现并补测试                                                            |
| 11  | 网络出口门禁不扫 `cli/` 和 `sidecar/` 是否有意为之                                                                                                                      | 查门禁注释与 ADR                                                          |
| 12  | 死信手动重试绕过规划器是否有意为之                                                                                                                                      | 查 ADR-0239 与 `outbound-tab.tsx` 的设计说明                              |
| 13  | ~~383 张表~~ 已更正为 393（第一版只数了冻结的 `SCHEMA_V240`）                                                                                                           | 已解决                                                                    |
| 14  | 代理检索得出的 75 / 29 / 46 / 32 分类（32 已知偏大）                                                                                                                    | 逐项复核初始化器表，产出可复跑的清单                                      |
| 15  | brain 断连期间写入 Host 降级存储的数据，重连后是否丢失（§10.1）                                                                                                         | 集成测试：断连 → 写入 → 恢复 → 读取                                       |
| 16  | 当前工作区里红掉的门禁，哪些来自其他会话未提交的改动（§10.7）                                                                                                           | 在干净的 worktree 上重跑                                                  |
| 17  | Jest 全量的实际耗时与失败率                                                                                                                                             | 看 CI 记录，或单独跑一次                                                  |
| 18  | 现存 fusion outbox 待处理行没有 `nextAttemptAt`，加索引查询后会被隐藏（Codex 用内存 Dexie 测过）                                                                        | 修复前写升级测试                                                          |

## 10. 第二轮审查补充的发现

下面各条来自 Codex 的独立审计和对抗性审查。标 [已核实] 的已由审计者在代码里复核，其余附证据路径，属于推断或静态统计。

### 10.1 数据权威随连接状态切换 [已核实选择顺序]

`crates/cognia-companion/src/data_plane.rs:77` 的 `DataPlane::pick` 按以下顺序选择数据面：

1. 已连接的 brain socket；
2. 桌面 WebView 渲染端；
3. Host 的 SQLite 降级存储（`Direct`）。

降级存储可以创建、修改、删除消息（同一文件 :174、:208、:236）。brain 断连期间写进去的数据，恢复连接后数据面会切回 brain 的 Dexie，没有找到对账或重放逻辑。现有 e2e（`tests/real-e2e/web-headless.spec.ts:199-227`）是等恢复之后才发消息，没有覆盖断连窗口。是否会真的丢数据 [待核实]。

### 10.2 插件是对外兼容边界

- `packages/plugin-contract/contract/catalog.json`：91 个命名空间、938 个方法，**只有 120 个方法声明了无头可用**；75 个命名空间的权限执行处于 shadow。
- `lib/plugin/core/context.ts:270` 用同一个 `baseContext` 同时构造运行时 API 和 UI API；`config` 直接读 `usePluginStore`。
- brain 上的 PluginManager 依靠 Node 适配器和浏览器环境 shim 运行（`cli/src/plugin/plugin-runtime.ts:141`）。

### 10.3 契约有多个独立的语义来源

Rust 命令签名、RPC dispatch、命令 manifest、Zod 请求定义、响应 schema、headless dispositions 各自维护语义。`gen-companion-api --check` 通过，但 `check-rpc-semantic-parity` 失败：不透明响应 schema 有 114 个，超过上限 110。生成结果一致，不等于跨语言行为一致。

### 10.4 原生资源背压与业务调度要分开

Rust Python host 的信号量（`crates/cognia-plugin-runtime/src/python/protocol.rs:545`）保护的是真实进程，不能并进业务限流器。执行路径约 17 类：sidecar 两个引擎、14 个外部协议适配器、补全通道。它们不是 17 份重复的 agent 循环，需要的是明确的所有权边界：进程、会话、审批、取消、恢复、drain 各由谁负责。

### 10.5 双宿主测试安全网不在 PR 必过路径上

- `cli/src/serve/serve-command.test.ts` 会调用真实的 `bootstrapHeadlessRuntimes`，但用的是脚本化 WebSocket 和 mock。
- `tests/e2e` 有 200 个 spec，其中 24 个是 Tauri spec；真实的 Web↔headless e2e 只有 2 个。
- `.github/workflows/compose-e2e.yml` 的 tier2 只在 schedule、手动触发和 push 时运行，不跑 pull_request。

ADR-0250 要求"每次迁移先在两个宿主上做特征测试"，目前还需要逐项搭建。

### 10.6 规模（Rust 侧）

| 位置            | 文件  | 行数（含文件内测试）                                                   |
| --------------- | ----- | ---------------------------------------------------------------------- |
| `src-tauri/src` | 142   | 68,553（超过 `rust-architecture.json` 的 `maxLoc` 67,656，目前只告警） |
| `crates/`       | 1,157 | 848,016                                                                |

`#[tauri::command]` 共 952 个（src-tauri 507、crates 445）。最大的文件是 `crates/cognia-task-workspace/src/service.rs`（14,870 行）。抽查还发现，异步的 workflow 命令里直接做同步 SQLite 读写（`crates/cognia-scheduling/src/workflow/commands.rs:452`、`run_mirror.rs:250`），这是阻塞风险。

### 10.7 当前工作区门禁健康度

在当前共享工作区上（包含其他会话未提交的改动），以下门禁失败：

- `check-rust-architecture`：未登记的 `src-tauri/src/native_agent_bridge.rs`；
- `check-sidecar-architecture`：7 项；
- `check-colocated-tests`：新增 1 个缺测试文件；
- `check-rpc-semantic-parity`：114 > 110；
- `check-host-parity`：26 项新增差异和 27 个未分类子系统。

以下门禁通过：`check-package-boundaries`、`gen-companion-api --check`、`check-plugin-sdk-wit`。

是否在干净的 worktree 上也是红的 [待核实，§9 第 16 项]。

### 10.8 流程信号

- 最近 8 周（截至 2026-10-31）共 1,688 个提交，其中 `fix` 类 485 个，占 28.7%。
- 英文 ADR 245 份中，有 21 份是 Proposed，其中至少 3 份已部分或全部实现。
- `docs/plans` 共 124 份，其中 40 份不在 archive 里、页首显示仍未完成。

建议把"决策批准""实现完成""真实验收"三种状态分开记录。

## 附：本次运行的命令

```bash
node scripts/gates/check-headless-registry.mjs
node scripts/gates/check-host-parity.mjs   # exit 1
node scripts/gates/check-host-parity.mjs --report   # 第二轮：A 类 96
```

第二轮审查由 Codex 执行，记录在本地 job 目录：`review-20261031-182022-753d86`（对抗性审查）、`research-20261031-182040-1166a9`（独立审计）。

统计脚本：用 `wc -l` 统计行数；用 `grep -rl` 统计 `lib/` 对 `@/stores/`、`@/hooks/`、`@/components/` 的引用和 `"use client"`；用 Node 解析 `lib/db/schema.ts` 的 `CURRENT_SCHEMA` 键数；用 Python 统计 `host-parity-baseline.json` 和 `host-parity-annotations.json`。
