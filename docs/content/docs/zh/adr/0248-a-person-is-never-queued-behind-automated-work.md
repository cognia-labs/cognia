---
title: "0248 — 人永远不排在自动化工作后面"
description: "每个争抢执行上限的启动都标明来源：是人做的，还是派生出来的。停止、暂停和取消永不占用许可，也永不排队。每个限流器保留一个派生工作拿不到的许可，在每个队列里人的启动都排在派生启动前面。来源由准入工作的入口设置，永远不由 Agent 设置。"
---

# ADR 0248 — 人永远不排在自动化工作后面

**状态：** 提议中
**日期：** 2026-11-01
**相关：** [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads)（派生启动）、[ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)（常驻 Host）、[ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background)（协调器准入）、[ADR-0244](./0244-a-remote-run-has-stopped-only-when-its-worker-says-so)（停止证明）、[ADR-0243](./0243-a-run-acts-for-someone-and-says-who)（请求者）。调研：`docs/research/deepseek-superagent-harness-comparison-2026-11-01.md`。

## 背景

DeepSeek 的原型额外预留一个 worker 槽位，留给人对已有 Ticket 的消息和状态询问。没有这个槽，新自动创建的 Ticket 可能占满所有槽位，人就够不到自己发起的工作。Cognia 有三个相互独立的限流器，没有一个知道启动来自人还是自动化：

- **执行代理**（`lib/execution/broker.ts`）：`ai-turn` 上的加权 FIFO 信号量，`DEFAULT_AI_TURN_LIMIT = 16`。
  - 如果某个会话已经有活跃的执行段，它的新租约免于排队（续接豁免），所以追加到正在运行的一轮里的追问永远不会被挡住。
  - 但人发给空闲会话的新消息（例如在 Host 应答的 IM 会话上）要排在所有已排队的自动执行段后面。
- **调度器**（`lib/scheduler/concurrency-limit.ts`，`decideConcurrencyAdmission`）：`maxConcurrentExecutions`，默认 5。超过上限时，按任务的重叠策略缓冲或丢弃。Agent 任务类型的 Issue 运行都经过它。
- **持久化 Agent Team**（`packages/agent-orchestration/src/fair-scheduler.ts`）：带数值优先级和老化机制的公平调度器，`globalConcurrency` 为 8。没有任何入口按来源分配优先级。

唯一区分来源的规则是 `admitThreadStart`（`lib/project-coordinator/admission.ts`）：用户要求的线程可以超过 `maxConcurrentThreads` 启动，协调器自己发起的启动则先暂存。

在常驻 Host 上，定时任务、Bot、wakeup 和 ADR-0247 的事件驱动运行都是派生的。它们可以占满全部三个限流器，人的停止或新请求就只能等它们。

停止大多已经不走许可：代理取消会触发租约的信号，团队停止写入意图后直接调用协调器。但这条规则没有在任何地方写明，也没有测试固定它。

## 决策

1. **停止、暂停和取消永不占用许可，也永不排队。** 这是三个限流器共同的不变量，每个限流器都有测试固定。今天还要经过排队操作的停止路径，按本 ADR 算缺陷。停止*证明*仍遵循 ADR-0244，本条只保证停止请求不经等待就送达工作。
2. **每个启动都带来源。** 租约、调度器启动和团队派发新增 `origin: "person" | "derived"`。
   - **person**：交互式聊天发送；人在已准入的 IM 会话里（被 @ 或私聊）或被跟随话题里发的消息；人点名启动的运行（`isNamedRunOrigin`，即 `interactive` 运行来源）；人对承诺的追问或 steer。
   - **derived**：定时任务、Bot 投递、wakeup、协调器自己发起的线程、事件驱动的承诺运行（ADR-0247）、重试与恢复。
   - **由入口设置。** 来源由准入工作的入口设置；触发动作是人本人的行为时，读取 ADR-0243 的请求者。Agent 不能设置也不能修改来源，派生运行的子运行也是派生的。
3. **每个限流器预留一个许可。**
   - 派生工作最多使用 `limit − 1` 个许可。
   - 人的工作可以使用任何空闲许可，包括预留的那个。
   - 上限为 `1` 的限流器不预留，只适用第 4 条。
4. **在每个队列里，人排在前面。**
   - 在代理的 FIFO 和调度器的缓冲里，排队中的人的启动先于任何排队中的派生启动被准入。
   - 公平调度器给人的启动最高优先级档，老化只在同一档内生效。
5. **其余不变。** 人的工作一旦准入，仍计入上限。代理的续接豁免和协调器对用户的放行保持原样，上限值本身及其设置也不变。
6. **可见。** 代理的"正在运行"视图和调度器面板显示每个执行段的来源。派生启动如果只是因为预留许可而等待，会如实报告这个原因，而不是笼统地说"达到上限"。

## 实现位置

| 关注点 | 位置 |
| --- | --- |
| 来源类型与入口 | `packages/plugin-contract/src/types/execution/`（租约与启动输入上的 origin）、聊天发送控制器、连接器运行时（`enqueueRouteHandlerTurn`）、Issue 运行入口、调度器执行器 |
| 执行代理 | `lib/execution/broker.ts`（预留许可、两档 FIFO、停止不变量测试） |
| 调度器 | `lib/scheduler/concurrency-limit.ts`（`decideConcurrencyAdmission` 接收来源）、任务调度器缓冲顺序 |
| 团队 | `packages/agent-orchestration/src/fair-scheduler.ts`、`coordinator.ts`（优先级档、停止不变量测试） |

每个改动到的模块都同步更新同目录测试（规则 3）；运行视图中的标签接入 i18n（规则 4）。

## 后果

- 在负载很高的 Host 上，人的请求最晚在空出一个许可时启动，停止永不等待。
- 每个限流器的派生吞吐少一个许可，这是这项保证的代价。
- 入口忘记设置来源时默认为 `derived`。这最多让人多等，永远不会让自动化占用预留许可。由测试断言这个默认值。
