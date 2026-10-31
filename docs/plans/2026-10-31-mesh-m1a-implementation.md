# Mesh M1a 实施计划：停止/恢复安全 + 目标固定

状态：计划已定稿，未开始实施。创建：2026-10-31（Asia/Shanghai）。上游：[评审修订稿](./2026-10-31-cognia-mesh-cross-device-workspace.md) §4 M1a；决策 [ADR-0244](../content/docs/en/adr/0244-a-remote-run-has-stopped-only-when-its-worker-says-so.md)；证据 [台账](../evidence/2026-10-31-mesh-cross-device-workspace.md)。实施方式：每个工作包交给 Codex `gpt-6.1-sol` xhigh 实现，Claude 审查 diff、亲自重跑验证，并由第二模型做对抗审查后再提交。

## 1. 目标与验收

M1a 结束时，跨设备运行满足：

1. **不双跑**：上一次 attempt 没有停止证明时，同 Host 重试、跨 Host 重试和启动时恢复都不会启动新 attempt，而是进入人工处理。
2. **停止说实话**：停止只有在 Worker 确认（或自我隔离到期）后才显示为已停止；否则显示"停止未确认"。
3. **迟到结果无效**：旧 epoch 的续约、结算、事件和结果被拒绝。
4. **目标不漂移**：外部 Agent 和团队子任务的运行固定在派发时的 Host，切换 Host 后仍能实时接收事件和控制；内置 Agent 会话绑定 Host，发送前必须显式切换，绝不静默发到当前 Host。

发布门槛（SC-03/04/05）：

- macOS 桌面 ↔ Linux Box 测试环境上，有受控双 Worker、断网、主动撤销、Host 重启、审批等待五份证据（WP8）。
- 各工作包的单元测试和门禁全部通过。

## 2. 已确定的实现选择

| ID  | 选择                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 依据                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | 停止状态用子任务/运行上的 `stop` 字段表示（`requested` / `confirmed` / `unconfirmed` + 证明），不在 11 值状态联合里加新值；终止状态只在拿到证明后写入。这样避免改动约 20 处状态 switch（`use-team-live-status.ts` 的 default 会把未知状态显示为 failed）。ADR-0244 决策 1 的语义不变。                                                                                                                                                                                                                                                                              | 代码地图：状态联合在 `packages/agent-orchestration/src/records.ts:65-89`，switch 分布于 squad、runtime、UI                                    |
| I2  | `dispatchEpoch` 是子任务上的非索引字段，每次申领递增，不需要 Dexie 版本升级。`attempt` 不能替代它：新子任务行会从 1 重新计数。                                                                                                                                                                                                                                                                                                                                                                                                                                      | `lib/db/schema.ts:780`；`replay.ts:89`                                                                                                        |
| I3  | Worker 自我隔离点：<br>• 复用现有 `host_rpc` 通道，由 Node 侧（`runtime-service`）保存每个会话的隔离状态（child、epoch、截止时间）。<br>• sidecar 两条执行路径各加一个强制准入：Claude rail 是无条件的 worker `PreToolUse` hook；AI SDK rail 放在最终 `execute` 之前，覆盖内置、插件和外部 MCP 工具。<br>• 准入发生在审批等待之后、实际执行之前；拒绝或超时即中断整个 turn。<br>• sidecar 在执行前再按本地截止时间复核一次。<br>• 不复用计费 ledger：它可被 bypass，30 秒无应答就放行。                                                                             | Codex 只读 spike（research-20261031-113148），`sidecar/src/runtimes/common/call-ledger-gate.ts:92,296`、`sidecar/src/platform/host-rpc.ts:47` |
| I4  | 控制断开：`worker-connect` 的 close/error 先调用幂等的 `service.controlLost()`，再结束输入。它只作用于 worker-dispatch 会话：立即关闭新工具和新 turn 准入、清空 followUps，并按截止时间中止。通用 RPC 的 EOF drain 行为保持不变。断线不会重新给满 TTL。                                                                                                                                                                                                                                                                                                             | `cli/src/agent/rpc/server.ts:442-458`，`server.test.ts:213`                                                                                   |
| I5  | 停止证明协议：作为 `turn/abort` 的严格模式（`targetTurnCommandId`、`dispatchEpoch`）。<br>• 先设置隔离闩，丢弃队列，取消待处理的权限和 elicitation。<br>• 中止后等待目标 activeRun 结束、执行器 teardown 成功。<br>• 返回持久化回执 `{stopped, turnStatus, followUpsDropped, sessionStatus, targetTurnCommandId, dispatchEpoch}`。<br>• 目标不匹配、超时或 teardown 失败时只返回"未确认"；turn 自然完成则报告 `completed`。                                                                                                                                         | spike Q1d                                                                                                                                     |
| I6  | 能力协商：Worker 在 manifest `hardCapabilities` 和 `SERVICE_CAPABILITIES` 中声明 `worker-self-fence-v1`（附 `fenceGraceMs`）和 `turn-interrupt-v1`。`RPC_PROTOCOL_VERSION` 保持 2；新方法只在对方声明能力时调用，旧 Worker 按旧语义运行，需要证明时转人工。**只有执行器是 sidecar 两条 rail（Claude Agent SDK / AI SDK）的 Worker 才声明 `worker-self-fence-v1`**；external backend（`createExternalAgentSession`，原生工具不经过 WP2b 准入）不声明，其恢复一律需要确认停止或人工。                                                                                 | `packages/agent/src/capabilities.ts`，`server.ts:259-292`；`worker-connect.ts:369-381`，`unified-runtime.ts:759-764`（对抗审查）              |
| I7  | 外部运行事件订阅固定到运行所在的 Host：<br>• 普通远端 Host 走 `acquireManagementChannel(origin.hostId)` 的 transport。<br>• paired Host 新增 retained-run 模式，用接纳时固定的 account、Host、配对身份和凭据建立独立连接，切换活跃 Host 不使它失效，只有配对或授权失效才失效。<br>• 本机发起的运行走 `localTransport`。<br>• 先 subscribe，并用一个同时覆盖 WebSocket 与 RTC/WAN lane 的"topic 已被接受"判断确认（现有 `hasSubscribedChannels` 只看 WebSocket，会拒绝只有 RTC lane 的有效连接），再发送 run；整个运行持有 lease，终止时释放。控制路径使用同一规则。 | spike Q2，`target-transport.ts:83-165`、`transport-companion.ts:1331-1370`                                                                    |
| I8  | 内置 Agent：会话记录目标 Host 和工作区。Composer 目标芯片选择另一台设备时，走 `useExecutionHostSwitch` 的受保护切换；在绑定到其他 Host 的会话里发送时，先要求切换。内置 turn 不做按轮路由（用户决定，2026-10-31）。                                                                                                                                                                                                                                                                                                                                                 | `hooks/devices/use-execution-host-switch.tsx:128`；`claude_send` 是 `target: execution`                                                       |
| I9  | 不跨设备比较绝对时间。<br>• Brain 在派发和续约中发送相对 `leaseTtlMs`，Worker 以收到时的单调时钟（`performance.now()`）计算本地截止时间。<br>• Brain 的 `fence-expiry` 证明按"最后一次发出续约的本地时间 + TTL + 宽限期"计算。<br>• 安全前提：一次续约的投递延迟小于宽限期。续约只在活连接上发送，旧连接上的帧不会在新连接投递，所以延迟上界由同一 TCP 连接决定；WP8 实测这个上界。                                                                                                                                                                                 | `rules.ts:98-125` 用 Brain 的 now+TTL（对抗审查：时钟偏移）                                                                                   |
| I10 | 任何会启动新执行的入口都走同一个准入判定 `assessRecoveryEligibility`，判定**按任务（runId+taskId）而不是按 teammate 的 child**：同一任务存在没有停止证明的旧 child 时，新 child 不得派发。入口包括：<br>• `recover`、`retryChild`、`durable-dispatch.fail`、squad runner；<br>• `setChildControlState(resume)`、`wakeChild`、`beginTakeover`/`completeTakeover`；<br>• workflow 节点的自动重试；<br>• `restart_run` 的 replacement。<br>控制句柄缺失不能当作暂停成功。                                                                                              | 对抗审查：`step-executor.ts:310-334,394-400`、`coordinator.ts:829-859,896-959`、`team-recovery.ts:317-338`、`start-squad-run.ts:402-478`      |

## 3. 工作包

每个工作包在单独的 Codex implement 作业中完成，scope 只含列出的目录和对应测试；跨出 scope 时作业报告 blocked，由 Claude 审批后扩展。用户可见的改动附 changeset。

### WP1 编排核心：epoch、停止记录、统一恢复规则

- **Scope**：
  - `packages/agent-orchestration/src/{records,rules,replay,coordinator,store}.ts` 及测试。
  - `lib/db/agent-team-runtime.ts`(+test)。
  - `lib/ai/agent/team/durable/{durable-dispatch,durable-control,team-recovery}.ts`(+tests)。
  - `lib/ai/agent/team/squad/{squad-lifecycle-runner,squad-control,squad-run-records,start-squad-run}.ts`(+tests)。
  - `lib/workflow/runtime/step-executor.ts`、`lib/workflow/nodes/teams/index.ts`、`lib/ai/agent/team/workflow-nodes/index.ts`(+tests)：团队派发节点的自动重试必须等上一次派发结算并通过准入判定。
- **内容**：
  - `dispatchEpoch` 单调递增；申领时记录 `fenceGraceMs`，以及 Worker 是否声明了 `worker-self-fence-v1`。
  - 续约、结算、事件推进和结果投影都比较 epoch，重新申领不复用过期身份。
  - `stop` 记录（I1）与 `StopProof`（`ack` / `fence-expiry`）。
  - 单一的 `assessRecoveryEligibility(task, children, checkpoint, proof, now)`，按 I10 接入全部入口：`recover`、`retryChild`、`durable-dispatch.fail`、squad runner、`resume`、`wakeChild`、`beginTakeover`/`completeTakeover`、workflow 自动重试和 `restart_run`。
  - `beginTakeover` 在控制句柄缺失时记录 `pause_unconfirmed`，不当作成功；`squad-control` 不再把 `queued` 一律视为"从未启动"。
  - `restart_run`：旧运行拿到全部停止证明后才写 `cancelled` 并发布 `run.cancelled`；没有证明时 replacement 不派发，先进入人工处理。
  - 运行级停止先置为 `cancelling` 语义（`run.stop.state = requested`），所有子任务有证明或已结算后才写 `cancelled`。
- **验收**：
  - 迟到写入的回归测试：旧 epoch 被拒。
  - 三条恢复路径缺证明时都进入 `needs_input`，并带 `stop_unconfirmed`。
  - 把评审探针 `recovery-admission` 改写为正式测试：已结算的 Write 加上"连接关闭"不再允许跨 Host 重试。
  - workflow 重试换 teammate、takeover、resume、wake、`restart_run` 各有一条"缺证明则不派发"的测试。

### WP2a Worker 运行时：隔离状态、续约、严格停止、控制断开

- **Scope**：
  - `packages/agent/src/{rpc/protocol,capabilities,worker-manifest,client,types}.ts`(+tests)：`client.ts` 实际构造 `turn/run` 和 abort 参数（`:477-490`、`:534-539`），需要新增 fence、严格停止选项和 `renew` 调用入口。
  - `cli/src/agent/rpc/{runtime-service,server}.ts`(+tests)。
  - `cli/src/worker/worker-connect.ts`(+test)。
  - `cli/src/agent/runtime/{unified-runtime,cancellation}.ts`。
- **内容**：
  - `turn/run` 携带 `fence {childRunId, dispatchEpoch, leaseTtlMs}`（相对时间，I9）。
  - 新增 `dispatch/renew` 方法，按 epoch 匹配，幂等。
  - I4 的 `controlLost()`。
  - I5 的严格停止回执。
  - 本地截止 watchdog：到期后关闭准入并中止。
  - I6 能力声明。
  - `runSession` 保存目标 turn 的 commandId，不再丢弃。
- **验收**：
  - EOF 探针改写为测试：worker-dispatch 会话在控制断开后不再启动新工具，到截止时间中止。
  - 通用 RPC 的 drain 测试保持通过。
  - 严格停止只在真正 idle 且 teardown 成功后返回 `stopped:true`。

### WP2b Sidecar 强制准入

- **Scope**：
  - `sidecar/src/runtimes/claude-agent-sdk/{options,index}.ts`。
  - `sidecar/src/runtimes/ai-sdk/index.ts`（MCP gate 构造 `:1010-1032` 需要拿到 hostRpc 和会话隔离状态；turn 中断控制在 `:1842-1867`）、`sidecar/src/tools/adapters/ai-sdk.ts`、`sidecar/src/mcp/client/tools.ts`。
  - 新增 `sidecar/src/policy/fence/`（或架构 gate 允许的层）。
  - `cli/src/runtime/{bootstrap,stdio-transport}.ts`、`cli/src/agent/session-runner.ts`，用于传入 worker host_rpc handler。
- **内容**：
  - I3 的两条强制准入：拒绝时 deny 并中断 turn，不留给模型可恢复的工具错误。AI SDK rail 用专门的 `FenceDeniedError`，由 runtime 捕获后直接中止 turn；host_rpc 超时也按拒绝处理，由 sidecar 本地中止，不依赖 Node 再发中断。
  - 准入只在 worker-dispatch 会话启用，桌面普通会话不受影响。
- **验收**：
  - 两条 rail 上，隔离状态失效后的下一次工具调用（内置、插件、MCP 各一）都被拒绝，且 turn 被中断。
  - `pnpm sidecar:test`、`sidecar:typecheck`、`audit:sidecar-architecture` 通过。

### WP3 Brain 接线：续约推送、暂停、停止证明、断连

- **Scope**：
  - `lib/ai/agent/team/workers/{worker-rpc-pool,tauri-worker-runtime,remote-worker-runtime}.ts`。
  - `lib/ai/agent/team/teammate/{dispatch-teammate,child-controls}.ts`。
  - `cli/src/serve/{bridge-client,serve-command}.ts` 的 detach 原因透传。
  - `lib/fleet/` 投影，以及以上文件的测试。
- **依赖**：WP2a 的 `client.ts` fence、严格停止和 `renew` 接口。
- **内容**：
  - 派发时传入 epoch 和相对 TTL；每次续约同时推送 `dispatch/renew`。
  - 暂停：Worker 有 `turn-interrupt-v1` 时中止并写 checkpoint；没有时进入 `pause_after_turn`，去掉 30 秒抛错；无法完成时为 `pause_unconfirmed`。
  - 终止使用严格停止，并记录 `ack` 证明。
  - `worker_detach` 透传原因：子任务进入 `stop.requested→unconfirmed`；只有 Worker 声明了隔离能力时，才按 I9 的 `fence-expiry` 规则自动补证明。
  - 失败路径更新 fleet 投影。
  - `WorkerRpcPool.run` 在发送时按当前 descriptor 复核能力和凭证，不只复核在线和容量。
- **验收**：
  - 在模拟 Worker 上走完断连→隔离到期→可恢复，以及断连→提前重连→等待证明两条路径。
  - 暂停不再卡在 `pausing`。

### WP4 中断绑定与撤销

- **Scope**：
  - `packages/plugin-contract/src/types/execution/run.ts`。
  - `lib/execution/{run-control,control-handlers}.ts`、`lib/db/execution-runs.ts`。
  - `lib/ai/agent/team/durable/team-recovery.ts`。
  - `crates/cognia-companion/src/ws_worker.rs`（出站帧授权复核）。
  - 以上文件的测试。
- **内容**：
  - 中断携带 `childRunId` 和 `dispatchEpoch`。
  - 决定写入改为 CAS：先把中断 `pending→deciding` 认领，再执行 handler，最后 resolve；handler 失败时回滚为 pending。
  - 团队恢复审批执行前逐个复核 epoch。
  - `companion_worker_send_frame` 复核 `agent.worker` 授权。
  - 撤销导致的 detach 让相关子任务的中断失效。
- **验收**：
  - 旧审批作用于已重新派发的子任务时被拒。
  - 两端并发决定只生效一个。
  - 撤销后 1 秒窗口内不再有出站帧（Rust 单测）。

### WP5 停止/恢复界面

- **依赖**：WP1 的 `stop` 字段和证明类型。
- **Scope**：
  - `components/agent/workspace/durable-operations.tsx`。
  - `hooks/agent-runs/use-team-live-status.ts`。
  - `lib/ai/agent/team/squad/{squad-control,squad-run-records}.ts`。
  - `components/settings/fleet/execution-workers-card.tsx`。
  - `i18n/messages/{en,zh-CN}/**` 拆分源，以及以上文件的测试。
- **内容**：
  - 展示停止中、停止未确认、已停止（附证明类型）。
  - 断连显示为"控制已断开，远端运行可能仍在继续"。
  - 恢复/重试选项展示上一次 attempt 的状态、证明和目标；没有证明时只给人工选项。
  - 修正状态映射的 default→failed。
- **验收**：组件测试覆盖各状态；`pnpm i18n:build` 和 `lint:i18n` 通过；浏览器预览截图。

### WP6 外部运行事件订阅固定

- **Scope**：
  - `lib/ai/agent/external/runtimes/remote/{remote-run-client,remote-execute,remote-host-configs}.ts`。
  - `lib/remote-host/{target-transport,management-channel,liveness}.ts`。
  - `lib/tauri/{transport-companion,transport-rtc}.ts`：新增同时覆盖 WebSocket 与 RTC lane 的"topic 已被接受"判断。
  - 以上文件的测试。
- **内容**：
  - I7。
  - `closeStaleManagementChannels` 把 paired Host 纳入已知集合。
  - 断线只标记控制丢失并尝试同源重连，不合成终止帧；终止帧始终不到时，运行 owner 有显式清理路径。
- **验收**：
  - A→B 切换后，原运行继续收到帧，取消和审批仍到达 A（普通 Host 与 paired Host 各一组测试）。
  - 本机发起的运行在远端 Host 活跃时仍可接收和控制。

### WP7 内置会话绑定 Host + Composer 目标芯片

- **Scope**：
  - `components/chat/composer/`：新目标芯片，复用 `ExecutionHostChip` / `AgentRuntimeSelector` 的数据。
  - `hooks/chat/use-claude-chat-controller.ts` 的发送守卫。
  - 会话记录的 Host/工作区字段（`lib/db/` 会话表，非索引）。
  - `hooks/devices/use-execution-host-switch.tsx` 的调用接入。
  - i18n 拆分源，以及以上文件的测试。
- **内容**：
  - I8。
  - 工作区列表来自目标 Host（`listWorkspaceEnvironments` / `fs_workspace_roots`）。
  - 发送时复核目标 Host 的在线状态和能力；不可用时提供等待、取消或切换，绝不回退到其他设备。
  - 新会话在首次发送时绑定 Host。
- **验收**：
  - 在绑定 A 的会话里、B 处于活跃时发送，会被拦截并提示切换。
  - 芯片在键盘和读屏下可用，中英文案齐全。
  - 浏览器预览验证（Tauri stub 方案）。

### WP8 真实环境验收与测量

- **Scope**：不改产品代码；脚本放在 `scripts/smoke/`（如需要），证据写入台账。
- **内容**：在 macOS 桌面 ↔ Linux Box（ADR-0224 那台）上运行五个场景：受控双 Worker、断网、主动撤销、Host 重启、审批等待。测量隔离宽限期、撤销传播和续约到达时延，再把数字写入 ADR-0244 和发布门槛。
- **验收**：台账 V2、V6 变为 passed；Q1 得到回答。

## 4. 顺序与依赖

```
WP1 → WP2a → WP2b → WP3 → WP4 → WP5
WP6（独立）  WP7（独立）
全部 → WP8
```

仓库同一时间只允许一个 Codex implement 作业，因此串行执行。顺序为 WP1、WP2a、WP2b、WP3、WP4、WP6、WP5、WP7、WP8：WP6 放在 UI 之前，因为它关闭的是正确性缺口。

## 5. 每个工作包的流程与门禁

1. Codex implement（`gpt-6.1-sol`、xhigh、限定 scope、`--verify` 指定测试）。
2. Claude 阅读 diff，亲自重跑 `--verify` 命令和以下门禁，确认 attribution 中没有 Codex 的越界修改。
3. 第二模型对抗审查：WP1–WP4、WP6 用 Codex review `--adversarial`；WP5、WP7 用 i18n-reviewer 子代理。
4. 修正审查发现，在 `git commit --only` 前后各检查一次文件清单。

| 改动类型      | 必跑门禁                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| TS 库/组件    | 定向 `pnpm test -- <files> --runInBand`、定向 eslint、`tsc --noEmit`（16 GB heap）、`pnpm audit:colocated-tests` |
| sidecar       | `pnpm sidecar:test`、`pnpm sidecar:typecheck`、`pnpm audit:sidecar-architecture`                                 |
| Rust          | `cargo test -p <crate> <filter>`；只格式化自己改的行                                                             |
| i18n          | `pnpm i18n:build`、`pnpm lint:i18n`                                                                              |
| 协议/manifest | `packages/agent` 测试；`pnpm build:packages`（如改到零 `@/` 包）                                                 |
| UI            | 浏览器预览验证与截图                                                                                             |

## 6. 风险与回退

- **对抗审查（2026-10-31）发现的 8 处缺口已并入**：I6、I7、I9、I10，以及 WP1、WP2a、WP2b、WP3、WP5、WP6 的 scope。
- **旧 Worker 不支持隔离**：恢复全部转人工，功能不退化，只是不再自动重试。灰度期间在设备控制台标出 Worker 是否支持隔离。
- **隔离宽限期过短导致误中止**：宽限期由 Worker 声明，WP8 实测前采用保守默认值（租约 TTL 60 秒 + 宽限期 30 秒），并在 ADR 中注明尚未实测。
- **sidecar 准入增加每次工具调用的往返**：本地截止时间复核允许在 Node 不可达时直接拒绝，往返只发生在 worker-dispatch 会话。
- **磁盘空间**（当前约 8 GB）：不跑全量构建；Rust 只跑单 crate 测试；`docs:build` 推迟到磁盘允许时。
