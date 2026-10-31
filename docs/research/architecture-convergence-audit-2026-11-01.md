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
> 关联：[DeepSeek Super-agent 对比](./deepseek-superagent-harness-comparison-2026-11-01.md)、ADR-0059（无头 brain）、ADR-0224（常驻 Host）、ADR-0247/0248/0249

## 0. 结论先行

当前问题主要是架构性的，有两个根因：

1. **运行时没有从 WebView 应用里抽出来。** 桌面是一个 React 应用顺带当运行时，常驻 Host 是把同一套前端代码无头化运行，再补一层注册表。每加一个功能，就可能多一份"桌面有、Host 没有"的债。
2. **没有共享的工作内核。** 运行和任务、队列、重试、限流、去重各自实现。安全和授权关口只能事后挨个出口补上，又缺少覆盖率门禁，所以很难放心从 shadow 切到 enforce。

团队并非不知道这些问题：有约 60 个审计门禁，多数带"只许变少"的基线；宿主一致性门禁逐条登记了差异；ADR-0059 早就规定新运行时必须注册到无头层。问题在于**债务被量化了，却没有被偿还**，新功能叠加的速度快过收敛的速度。

| 维度             | 关键数字                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| 运行时初始化器   | 105 个，其中 75 个拥有运行时；Host 有对应的 29 个；46 个没有，其中 **32 个未被任何文档或标注覆盖**           |
| 宿主一致性       | 已登记 **183** 项差异（87 项绕过宿主层、96 项只有一侧实现的 RPC）；65 个子系统标为"尚未迁移"；门禁当前不通过 |
| 运行时读 UI 状态 | 355 个 `lib/` 文件引用 `@/stores/`，其中 294 个在 React 外命令式读写                                         |
| 本地数据库       | Dexie **383** 张表（另有 3 张已删除）                                                                        |
| 重复概念         | 约 23 种运行/任务实体、约 17 个带重试的队列（≥5 条退避曲线）、约 22 个并发限流器、约 15 套去重机制           |
| 真相源           | Dexie、brain 双写持久化加旧快照、约 9 个 Rust SQLite、Postgres、账号同步 DO                                  |
| 已确认缺陷       | router-fusion outbox 无退避、无上限，且会饿死新效果                                                          |

## 1. 规模基线 [已核实]

| 指标                                                       | 数值                                |
| ---------------------------------------------------------- | ----------------------------------- |
| `lib/`+`hooks/`+`stores/`+`components/` 非测试 TS/TSX 行数 | 约 119 万行                         |
| 其中超过 1500 行的文件                                     | 70 个                               |
| `lib/` 非测试文件                                          | 5747 个                             |
| `hooks/` 非测试文件                                        | 745 个                              |
| `components/providers/initializers/` 非测试文件            | 105 个                              |
| `lib/headless/runtimes/` 非测试文件                        | 30 个                               |
| ADR                                                        | 244 份（编号到 0249，有重号和缺号） |

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

补充说明（代理检索）：

- **`getState()` 的用法。** 引用 store 的 355 个文件中，294 个调用了 `.getState()`、`.subscribe()` 或 `.setState()`，也就是在 React 之外命令式读写 UI 状态。被引用最多的是 settings（99）、chat（约 100）、project-store（46）、plugin-runtime（42）、agent-team-store（41）。
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

32 个未说明的缺口中，代理点名的有：自动化审计镜像、managed-desktop 告警、IM 通知、harness evolution、best-of-N 恢复、CLI 配置自动推送、终端启动、models.dev 和 OpenRouter 目录同步、Anthropic/Codex 配额探测、OAuth 续期、执行控制分派表、glance 发布、更新中心等。完整表格见代理原始输出，未逐项复核。

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

但它只检查名字形如 `installX`、`startX`、`registerX` 的副作用符号（见脚本头注释）。`refreshExpiringOAuthCredentials` 这类命名不在其列，所以 2.2 的 32 个未说明缺口里，有相当一部分是门禁看不到的。

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
| Dexie `CogniaDB` v249 | `lib/db/schema.ts`                                                                                                                                                                                                        | 桌面全部应用数据（调度器没有独立库，`SchedulerDatabase` 只是一层包装；`snapshot.ts` 头注释所说的"独立库"已过时）                                                       |
| brain 持久化          | `cli/src/serve/persistence/`                                                                                                                                                                                              | `journal-v4`（检查点加 jsonl，决定顺序）与 `sqlite-v5`（k/v）在迁移期间双写，切换要人工完成；另有旧的 JSON 快照（`cli/src/db/snapshot.ts`）。运行时默认用哪个 [待核实] |
| Rust SQLite           | 各 crate 一个文件：`jobs.sqlite`、`task-workspaces.sqlite`、`scheduler_meta.db`、`vectors.sqlite`、`file-share.sqlite`、`environment.sqlite`、agent-state `db.sqlite`、companion-security、companion-bus `SqliteAppStore` | 各自 crate 的状态                                                                                                                                                      |
| Postgres              | `crates/cognia-collab-server`                                                                                                                                                                                             | 组织协作数据，以服务端为准（ADR-0149）                                                                                                                                 |
| 账号同步              | Cloudflare DO 操作日志加 R2 快照（ADR-0215），协议源码在 cognia-services                                                                                                                                                  | 跨设备复制的数据，按字段 HLC，后写者赢                                                                                                                                 |

存在两份可写副本的地方：

| 两份副本                                      | 冲突处理                      |
| --------------------------------------------- | ----------------------------- |
| 账号同步各副本                                | 按设计可写，有收敛测试        |
| Dexie 与 Rust `run_mirror`                    | 有文档：以 Dexie 事件日志为准 |
| Dexie 与 `SqliteAppStore`                     | 未找到对账路径 [待核实]       |
| Dexie `scheduledTasks` 与 `scheduler_meta.db` | 都在写，对账逻辑没看 [待核实] |

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

**Monitor 工具承诺的送达没有消费者。** `sidecar/src/tools/builtin/core-files/monitor.ts` 告诉模型结果会在触发时送达，但 `jobs://monitor-fired` 只转给了调度器（`hooks/system/use-tauri-events.ts`）。ADR-0249 处理这一项。

## 7. 门禁资产（正面）

- `scripts/gates/check-all.mjs` 是唯一的门禁注册表，CI 通过 `--list-groups` 读取它。`check-gate-registry.mjs` 会让未注册的校验脚本失败。
- `package.json` 里约有 60 个 `audit:*` 门禁，多数带 `:baseline` 棘轮（只许变少）。
- 架构类门禁：Rust 分层、sidecar 分层、包边界、静态导出、无头注册表、宿主一致性、RPC 语义一致性、invoke 参数一致性、命令一致性、LLM 台账边界、供应商名分支、工作区归属等。

这些门禁说明问题已被识别和度量。缺的是两样：覆盖面（出口类门禁大多按约定生效），以及偿还节奏。

## 8. 收敛方向（供后续 ADR 使用，未决策）

1. **运行时内核脱离 UI。** 把编排和执行从 `hooks/` 和初始化器移到可以无头运行的层，UI 只负责订阅和展示，桌面与 Host 跑同一个内核。度量指标：32 个未说明的缺口、183 项一致性差异、65 个尚未迁移的子系统、294 处 `getState()`。
2. **一条工作主干。** `executionRuns` 作为唯一的运行记录，加上 ADR-0247 的"承诺"（delegation 提升为 Issue），作为所有入口的归宿；统一状态词汇。度量指标：约 23 种实体、4 种"成功"写法。
3. **一个入口、一个出口、一套队列原语。** 统一入站去重和归属，统一受治理的外发，统一重试、退避、死信策略，统一限流原语（带来源）。度量指标：约 17 个队列、≥5 条退避曲线、约 22 个限流器。
4. **关口要有覆盖率门禁。** 外发规划器、投递网关、写入权威、PII 调用都需要扫描调用方的门禁，而不只是检查 import。无头注册表门禁应改为按"被初始化器调用的 `lib/` 副作用"判断，不再按函数命名。

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
| 13  | 383 张表这个数字（解析 `CURRENT_SCHEMA` 的键得出，可能把非表的键算了进去）                                                                                              | 用 Dexie 运行时打开数据库后统计 `db.tables.length`                        |
| 14  | 代理检索得出的 75 / 29 / 46 / 32 分类                                                                                                                                   | 逐项复核初始化器表                                                        |

## 附：本次运行的命令

```bash
node scripts/gates/check-headless-registry.mjs
node scripts/gates/check-host-parity.mjs   # exit 1
```

统计脚本：用 `wc -l` 统计行数；用 `grep -rl` 统计 `lib/` 对 `@/stores/`、`@/hooks/`、`@/components/` 的引用和 `"use client"`；用 Node 解析 `lib/db/schema.ts` 的 `CURRENT_SCHEMA` 键数；用 Python 统计 `host-parity-baseline.json` 和 `host-parity-annotations.json`。
