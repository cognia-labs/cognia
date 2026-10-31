---
title: "0244 — 远端运行只有在 Worker 确认后才算停止"
description: "停止、暂停和恢复另一台设备上的运行时，只呈现实际知道的状态：停止分为已请求、已确认和未确认，其他信号都不算证明。Worker 失去派发租约时自我隔离，因此租约过期再加上声明的隔离宽限期可以作为证明。同 Host 重试、跨 Host 重试和启动时恢复都要等这份证明，否则交给人决定。撤销只结束授权，从不宣称进程已停；审批绑定到发起它的那次执行尝试。"
---

# ADR 0244 — 远端运行只有在 Worker 确认后才算停止

**状态：** 提议中
**日期：** 2026-10-31
**相关：** [ADR-0113](./0113-agent-team-multi-host-remote-dispatch)（多 Host 派发，由 brain 结算）、[ADR-0136](./0136-cross-device-placement)（放置；其"未完成"列出租约 fencing）、[ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)（B 阶段：租约级 fencing）、[ADR-0245](./0245-a-paired-device-is-granted-workspaces-not-a-host)（工作区授权；撤销后重新校验）、[ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)（执行运行与中断）

## 背景

持久化的 Agent Team 子任务可以在另一台设备上运行（ADR-0113）。brain 申领 60 秒派发租约，每 20 秒续约，并自己结算子任务。brain 对远端 turn 实际能观察到的，比代码当作已知的要少：

- **没有停止状态词汇。** 没有任何地方记录"已请求停止""已确认停止"或"停止未确认"。`durable-control.ts` 在任何子任务操作之前就把运行写成 `cancelled`（或 `pausing`）；子任务操作抛错时，运行停在 `cancelled`，没有完成时间，也没有轨迹事件。
- **远端暂停不会中断。** `worker-rpc-pool.ts` 把暂停实现为 `session.waitForIdle({ timeoutMs: 30000 })`，不发送 abort。超过 30 秒的 turn 会让子任务卡在 `pausing`。终止（`turn/abort`、等待空闲、关闭）是唯一会中断的路径，它的成功只是 RPC 应答。
- **断连不会停止 Worker。** Host 在 `worker_detach` 时不发送 abort；stdio RPC 服务端在 EOF 后会先把已接纳的 turn 跑完，再关闭服务（证据台账中的探针：`side_effect_after_eof` 先于 `service_closed`）。
- **"safe" checkpoint 只描述过去。** `isStoredChildReplaySafe`（`packages/agent-orchestration/src/replay.ts`）要求最后一个 checkpoint 可安全重放，且没有未结算的工具意图。它不涉及仍在收尾的旧 turn 接下来会发起的工具调用。恢复探针展示了一个最后一次 `Write` 已结算的子任务，因"连接关闭"被判失败，随后在没有任何停止证据的情况下被重试到 `device:b`。
- **三条恢复路径，三套规则。** 跨 Host 的 `retryChild` 要求 safe checkpoint；同 Host 重试不要求（它固定在源 Host，而旧 turn 可能仍在那里收尾）。启动时恢复（`coordinator.recover`）既不看租约，也不看 Host 是否在线。
- **没有 fencing token。** 续约和结算只比较租约 id；租约过期但未清除时，重新申领会复用 `existingChild.dispatchLeaseId`，于是卡住的旧持有者仍能续约和结算。
- **撤销不等于停止。** 撤销 `agent.worker` 会在一秒内关闭 socket；这段时间内的出站帧不会被重新校验，排队中的子任务只有在发起派发时才被判断，被撤销设备发起的待处理中断保持待处理。
- **审批没有绑定到执行尝试。** `ExecutionRunInterrupt` 没有子任务或 attempt 字段；团队恢复审批在发起时冻结子任务 id，批准时作用于这些子任务当前所处的任意 attempt。

## 决策

1. **停止有三种状态，只有一种是证明。** 停止或终止请求把子任务置为 `stop_requested`。只有拿到停止证明（决策 3）才变为 `stopped`。如果请求失败、超时，或控制通道先断开，子任务为 `stop_unconfirmed`：保持可见，从不显示为已停止，由人处理或等待之后的证明。运行在所有子任务 `stopped` 或已结算之前保持 `cancelling`，`cancelled` 最后写入。

2. **暂停说明是哪种暂停。** 声明了 `turn-interrupt-v1` 的 Worker 通过中止当前 turn 并写 checkpoint 来暂停；否则暂停是 `pause_after_turn`，界面说明它在等当前 turn 结束。无法完成的暂停是 `pause_unconfirmed`，不会永远停在 `pausing`。

3. **停止证明只有两种。**
   - **确认停止：** Worker 针对该子任务和 attempt 报告 turn 已中止、会话空闲。
   - **自我隔离到期：** Worker 在 manifest 的 `hardCapabilities` 中声明了 `worker-self-fence-v1`，子任务租约已过期，且自过期起已超过声明的隔离宽限期。

   工具结果、连接关闭、未声明 `worker-self-fence-v1` 的 Worker 租约过期，以及没有后续事件，都不算证明。

4. **Worker 自我隔离。** 声明 `worker-self-fence-v1` 的 Worker 在本地保存每个子任务的租约 epoch。每次调用工具前，检查最近一次成功续约仍在租约 TTL 之内。续约失败或控制通道断开时，它停止启动新工具，在宽限期内中止 turn，并在下次联络时上报这次中止。宽限期在 manifest 中声明，先实测再写入发布门槛。

5. **租约带 fencing epoch。** 每次申领都会递增子任务上单调的 `dispatchEpoch`。续约、结算、事件推进和结果投影比较 epoch，而不只比较租约 id；旧 epoch 的写入被拒绝并记录。重新申领从不复用已过期租约的身份。

6. **统一的恢复规则。** 同 Host 重试、跨 Host 重试和启动时恢复都要求上一次 attempt 的停止证明，再加上可安全重放的 checkpoint。没有证明时，子任务进入 `needs_input`，附带 `stop_unconfirmed` 恢复事项。首版不提供绕过这条规则的强制接管。

7. **撤销结束授权，不结束进程。** 撤销一经确认，立即拒绝使用该授权的新操作，包括出站帧。排队中的子任务在派发时重新校验授权，以该授权发起的待处理中断随之失效。撤销从不把子任务置为 `stopped`；它启动决策 1 中的停止流程。

8. **审批绑定到执行尝试。** 中断记录携带 `childRunId` 和 `dispatchEpoch`。决定只在子任务仍处于该 epoch 时生效；团队恢复审批在执行前逐个重新校验子任务的 epoch。决定的存储写入以 `status = pending` 做 compare-and-set。

9. **界面展示证据。** 恢复或重试选项写明上一次 attempt 的状态、证明（或证明缺失）以及目标。断连显示为"控制已断开，远端运行可能仍在继续"，而不是"离线且已停止"。

## 影响

- Worker 消失时重试会变慢：要么等隔离宽限期结束，要么由人决定。这是换取"同一份工作绝不在两台 Host 上各跑一遍"的代价。
- 没有 `worker-self-fence-v1` 的旧 Worker 永远不会产生自我隔离证明，它们的失败总是需要确认停止或由人处理。
- 新增协议字段：派发、续约、结算和事件上的 `dispatchEpoch`；中断上的 `childRunId` 和 `dispatchEpoch`；两个能力名。旧客户端按旧语义继续工作，在需要证明的地方被拒绝。
- Attention 中的"停止未确认"和"恢复选择"事项（跨设备工作区计划的 M1b 里程碑）来自决策 1 和决策 6。

## 未完成

- 工具级幂等键。任意工具副作用无法通用去重，因此这里不把它作为恢复依据。
- 对未确认子任务的强制接管。
- 宽限期和传播时延的具体数字。先在 macOS ↔ Linux Box 测试环境实测，再写入任何发布门槛。

## 考虑过的方案

- **只靠 brain 侧证明（不改 Worker）。** 没有确认停止就拒绝一切重试。安全，但每次网络分区都要人工处理；保留为不支持自我隔离的 Worker 的兜底。
- **把租约过期本身当作证明。** 否决：EOF 探针表明，控制方消失后，已接纳的 turn 仍会继续运行。
