---
title: "0249 — 后台 job 的完成结果会送达 Agent"
description: "Agent 启动的 shell job 或 monitor 完成后，结果送回启动它的会话，走的是子 Agent 结果已经在用的同一套日志和送达路径。空闲会话被唤醒并收到合并后的结果；正在流式输出的会话在下一个轮次边界收到。Host 上或处于后台保持中的会话，即使没人打开也会被唤醒。唤醒按会话设上限，并计入运行预算。Monitor 工具\"触发时送达结果\"的承诺由此兑现。"
---

# ADR 0249 — 后台 job 的完成结果会送达 Agent

**状态：** 提议中
**日期：** 2026-11-01
**相关：** [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads)（轮次边界送达）、[ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background)（后台保持）、[ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)（常驻 Host）、[ADR-0248](./0248-a-person-is-never-queued-behind-automated-work)（唤醒属于派生启动）。调研：`docs/research/deepseek-superagent-harness-comparison-2026-11-01.md`。

## 背景

DeepSeek 的文章描述了异步（"全双工"）工具：耗时工具先返回 `Started`，完成结果稍后作为事件到达，Agent 在当前步骤结束后处理它，期间仍可接收新输入。文章说这已在 DeepSeek Harness 中实现，但默认没有开启。Cognia 已经有了一半：

- **后台 job 本身已经在跑。** `run_in_background` 的 shell 运行在 Rust job 监管器之下（`crates/cognia-jobs`：SQLite、进程组、`MAX_JOBS_PER_SESSION = 8`），经 `sidecar/src/tools/state/host-background-shells.ts` 调用。Agent 用 `bash_output` 读取输出（可用 `wait_ms` 长轮询），用 `kill_shell` 停止。
- **完成结果到不了 Agent。** 监管器发出 `jobs://exited` 和 `jobs://monitor-fired`。`hooks/system/use-tauri-events.ts` 只把这两个事件转给调度器事件（`job:exited`、`monitor:fired`）。定时任务可以据此触发，但启动 job 的 Agent 除非主动轮询，否则什么也不知道。
- **Monitor 承诺的送达没人执行。** `Monitor` 工具（`sidecar/src/tools/builtin/core-files/monitor.ts`）最多阻塞五分钟，之后返回一个 `monitorId`。它的描述告诉模型"结果会在触发时送达"，但没有任何消费者把已触发的 monitor 注入会话。这是一个处于休眠状态的承诺，正是规则 7 禁止的那种标注不全的休眠。
- **子 Agent 的结果已经能回流。** 这条路径是 `hooks/chat/background-result-runtime.ts` 和 `lib/background-tasks/completion-delivery.ts`（`frameBackgroundResults`）。已结束的后台运行（`BackgroundTaskKind` = `subagent | plugin-agent | team-delegation`）先记入日志，再作为一轮带框的输入送进父会话：
  - 父会话正在流式输出时，先留在队列里，这一轮结束后再送；
  - 父会话关闭时，在它下次以空闲状态打开时送；
  - 父会话已删除时，只发通知。

  批次标识被持久预留，只有聊天的工作台账确认受理后，送达才算完成。TUI 有自己的消费者（`cli/src/tui/components/app/use-background-results.ts`）。
- **在 Host 上，"下次打开"永远不会发生。** 常驻 Host 上的会话，以及靠后台保持（ADR-0204 §3）存活的会话，都没有人去打开，这样排队的结果会无限期等下去。

## 决策

1. **job 和 monitor 都是后台任务。** `BackgroundTaskKind` 新增 `shell-job` 和 `monitor`。监管器接受从 Agent 会话启动的后台 shell，或布置一个 monitor 时，写入一条日志项，以 job 或 monitor 的 id 为键，关联到该会话和运行。`jobs://exited` 和 `jobs://monitor-fired` 负责结算这条日志项；转给调度器的那一路保持不变。
2. **只有一条送达路径。** 已结算的日志项走现有的完成送达机制：正在流式输出的会话在下一个轮次边界接收，多次结算合并成一轮带框输入。框内包含：
   - 类型和 id；
   - 退出码或触发原因；
   - 耗时；
   - 有界的输出尾部：预算与 bash 工具的内联输出相同，完整日志仍可通过 `bash_output` 读取。

   输出作为不可信数据加框，与同伴消息的处理方式相同。
3. **没人打开时也会唤醒。** Host 拥有的会话（ADR-0224）和处于后台保持中的会话在空闲时直接被唤醒，而不是等人打开。没有后台保持的桌面会话行为不变。唤醒属于派生启动（ADR-0248）。
4. **有上限。** 每个会话有唤醒上限（默认每小时 6 次）和合并窗口（默认 10 秒）。
   - **超过上限时，** 结算结果排队等待会话因其他原因开始的下一轮，并发一条通知说明有结果在等。
   - **计入预算。** 唤醒通过现有台账计入运行预算，预算耗尽的会话不再被唤醒。
5. **Agent 可以逐个 job 选择。** `run_in_background` 新增 `notify: "on_exit" | "none"`，默认 `on_exit`。Agent 用 `kill_shell` 自己停掉的 job 不会唤醒它。已经在调用中内联返回结果的阻塞式 `Monitor` 调用，事后不会再送一次。
6. **每个运行 Agent 会话的外壳都要有消费者。** 包括桌面聊天 hooks、无头 brain 和 TUI。Host 的 job 监管器必须发出同样的两个事件，第 1 阶段在 Host 上验证这一点之后才在 Host 上发布。在 Host 上确认这两个事件之前，工具结果会如实报告 `notify` 不可用，而不是悄悄忽略。

## 实现位置

| 关注点 | 位置 |
| --- | --- |
| 日志类型 | `lib/background-tasks/registry-core.ts`、`lib/background-tasks/completion-delivery.ts`（job 与 monitor 的加框） |
| 结算 | `hooks/system/use-tauri-events.ts`（与调度器转发并行结算）、无头 brain 的事件接线、`cli/src/tui/components/app/use-background-results.ts` |
| 工具 | `sidecar/src/tools/builtin/core-files/bash.ts`（`notify`）、`monitor.ts`（描述与行为一致）、`sidecar/src/tools/state/host-background-shells.ts` |
| 唤醒策略 | `hooks/chat/background-result-runtime.ts`（保持中会话与 Host 会话的空闲唤醒、上限、合并、预算检查） |

每个改动到的模块都带同目录测试（规则 3），sidecar 测试套件在 `pnpm sidecar:test` 下运行，通知文案接入 i18n（规则 4）。

## 后果

- Agent 可以启动一次构建或测试，接着处理下一个请求，等 job 结束时再做反应，不必再花轮次轮询，也不必卡在阻塞调用里。
- 一个被遗忘的长 job 结束时可能多花一轮。上限、预算检查和 `notify: "none"` 限制了这项代价。
- Monitor 工具的描述由此兑现。在本 ADR 落地之前，它的描述必须先停止承诺送达。
