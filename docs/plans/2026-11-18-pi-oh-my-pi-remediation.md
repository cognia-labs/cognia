# Pi 与 Oh My Pi 分阶段修复与功能补齐方案

- 状态：Proposed
- 日期：2026-11-18（Asia/Shanghai）
- 复核基线：`d861ef61c4b6` 与当前工作树，ACP steering 含独立在途改动
- 依据：[两轮代码审计与原生探针](../evidence/2026-11-18-pi-oh-my-pi-support-audit.md)
- 深度：Heavy，涉及回合归属、审批、计量与宿主能力。责任角色和发布顺序为提案。

## 1. 首批修复回合归属、权限与用量

**第一阶段并行修 Pi 超时串轮、OMP Plan 权限映射、OMP 用量漏报，权限修复可独立先发。** Pi 继续使用原生 RPC，OMP 继续使用 ACP。后续修复生命周期与失败状态，再补齐安装、诊断、配对与会话体验。原生 OMP RPC 由明确的功能需求和生产 Host 证据决定。

| 阶段                | 交付                                                       | 完成门槛                                             | 主责角色              |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------- | --------------------- |
| S0 · 固定回归基线   | 把三项审计复现转成仓内夹具，锁定原生二进制与样本           | 三个回归分别能在修复前失败                           | 发布验证              |
| S1 · 三项优先修复   | A1 Pi 超时、A2 OMP Plan、A3 OMP 用量                       | 晚到帧归属、实际审批结果、连续及恢复回合的计量正确   | Pi 与 ACP 集成        |
| S2 · 生命周期与终态 | B1 Pi 探测、B2 Pi 准入、B3 Pi 历史、B4 OMP 失败与 steering | 进程回收、历史缺失、失败分类、输入未送达各有明确结果 | 集成与 Host           |
| S3 · 产品能力补齐   | C1 安装与诊断、C2 配对及审批、C3 OMP 会话                  | 已启用能力有相应 Host 验收。能力缺失时用户能看到原因 | 设置、Host 与发布验证 |
| S4 · 原生 RPC 评估  | D1 目标版本和生产守卫                                      | 指定平台的权限、会话及资源回收证据齐备后评审接入     | Host 安全与 OMP 集成  |

S2 可在 S1 开发期间准备夹具，Pi 生命周期变更在 A1 合入后叠加。C1、C3 可以分别发布，C2 的配对执行取决于实际 Host 能力。Gateway、全量 OMP 迁移、语音及原生生态控制进入后续需求评审。

## 2. S0 用原生制品和确定性夹具固定三条回归

- 从实际入口锁定断言。Pi 走 `PiRpcClientAdapter.prompt` 与 Manager 重试。OMP 走公开配置方法、ACP 权限代理、`done` 到 `BaseProtocolAdapter.execute` 和 Manager 汇总。利用同目录测试的进程端口夹具把审计复现转成回归，正式测试不依赖本机 `.cache` 脚本。
- Pi **1.0.2** 是适配器认证版、**1.5.2** 是已离线探测的对照版。OMP ACP **18.22.2** 是本轮对照版。锁定制品来源、SHA-256、平台和 Cognia revision，升级候选独立认证。 [Pi 1.0.2](https://github.com/earendil-works/pi/releases/tag/v1.0.2) · [Pi 1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2) · [OMP 18.22.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.22.2)
- 每例使用临时 HOME、独立工作区、测试账号环境和合成模型。保留帧类型、事件顺序、计数和退出状态。审批窗口和回合交付顺序用可控信号固定。

现有证据包括 Pi 的 adapter 迟到帧复现、两版官方 Pi 的进程与恢复异常，以及官方 OMP 的模式投影与 loopback 用量复现。完整 Tauri、CLI、配对路径、真实供应商和 Linux 仍需按下面矩阵验收。 [审计义务 V3、V7–V10](../evidence/2026-11-18-pi-oh-my-pi-support-audit.md#verification-obligations)

## 3. S1 保证每轮输出、权限与计量正确

### A1 · Pi 的不确定回合退出可接收状态

**模块与主责。** Pi 集成修改 `packages/agent-pi/src/{rpc-client,rpc-peer}.ts` 及同目录测试。Manager 负责错误分类和重试边界，涉及 `lib/ai/agent/external/{manager,turn-failure}.ts` 与对应测试。基类 `execute` 当前会将异常收敛为文本。修改 `packages/agent-runtime-kit/src/base-adapter.ts`，通过既有 `errorCode` 保留此类结果未知的原因，并在 Manager 的两个重试分支按结构化原因拦截。 [发送路径](../../packages/agent-pi/src/rpc-client.ts#L1435) · [ACK 与超时](../../packages/agent-pi/src/rpc-peer.ts#L202) · [Manager 重试](../../lib/ai/agent/external/manager.ts#L5495)

**改法。** Pi 命令 ACK 有 ID。原生输出和结束事件属于进程会话。区分经 Host 确认未写入、原生明确拒绝和送达结果未知。只要 prompt 可能已写出且无安全继续的终态，就先标记该进程为待回收，拦截新的 prompt、steer、队列写入和过期对话框答复。复用 `closeSession`、`clear_queue`、`abort` 与 Host 有界进程组终止。向 Manager 返回明确的不可自动重试原因。终止失败保留待回收记录和会话占用，清理成功后才接收下一条显式输入。

```text
可接收 → 等待 ACK → 运行 → agent_settled → 可接收
             └─ 送达结果未知 → 待回收 → Host 确认退出 → 可恢复
                                  └─ 清理失败 → 继续拒绝输入
```

保留 Cognia 与原生会话 ID。事件必须受进程归属约束，旧记录失效后丢弃晚到帧。同一 Host 进程 ID 若会让旧帧进入新订阅，应采用进程代际或经过验证的退出与排空屏障。采用代际 ID 前核对 Host 归属、启动租约和孤儿回收。仅延长 ACK 等待时间不能解决帧归属。 [Pi RPC 生命周期](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/rpc.md) · [Host 进程端口](../../lib/ai/agent/external/host/process-host.ts)

**验收。**

1. A 发送一次并超时。A 的迟到文本、工具结果、usage 和 `agent_settled` 分别在 B 开始前后到达。B 收到的 A 帧数为 **0**，只返回 B 的正文、用量和终态。
2. A 已写出且暂无可见活动时仍只发送 **1 次**。覆盖 Manager 的失败结果与抛异常两个重试分支。独立覆盖确认未写入、明确拒绝、正常 ACK、快速结束、对话框等待、用户取消与进程退出。
3. 终止失败时 B 被阻止。清理成功后只重开一次，用户显式发送新输入可继续既有历史。用官方 Pi 跑有状态的流式回合及故障注入，并从实际 Host 核对进程和迟到帧。

### A2 · OMP 原生 Plan 坚持受限审批

**模块与主责。** ACP 集成修改 `packages/agent-acp/src/vendors/catalog-expansion.ts` 中的 `ohMyPiAcpProfile`、`client.ts` 的模式协调和审批代理，以及必要的 `vendor-profile.ts` 类型。补 `catalog-expansion.test.ts`、`client.test.ts`。消费者包括 Manager、会话配置和 Agent 设置。若需要调整 UI 投影，同步组件测试与英、简中词条。 [OMP profile](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L218) · [模式写入](../../packages/agent-acp/src/client.ts#L3359) · [审批分支](../../packages/agent-acp/src/client.ts#L4690)

**改法。** OMP profile 显式把原生 `plan` 映射为 Cognia `plan`，并在上游广告 Plan 时支持反向映射。区分原生报告、Host 显式授权和当前有效审批上限。原生 Plan 或 Host Plan 任一生效时，权限代理保持受限。原生 `default` 兼容多个 Host 模式，它的通知不能自行授予 `bypassPermissions`。未知模式、切换待确认和请求失败时维持受限状态。厂商差异由 profile 表达。

| 入口或状态                                                                         | 处理                                                                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `session/new`、load、resume、fork                                                  | 先建立保守的审批上限，覆盖恢复时可能先于响应到达的请求。Plan 只有在会话广告后才写入原生配置。          |
| `setSessionMode`、`setConfigOption`、`current_mode_update`、`config_option_update` | 共用解析与状态协调。响应和通知无论先后，待确认状态不能放宽审批。迟到的旧状态不能覆盖已确认的当前策略。 |
| 离开 Plan 或收到未知模式                                                           | Host 显式授权与上游确认后才放宽。无法确认则提示受限原因。                                              |
| 强制逐工具审批                                                                     | 继续按当前能力拒绝启动。后续开放以实际工具执行经过 Host 代理为门槛。                                   |

**验收。**

1. 真实 OMP 18.22.2 验证 Plan 广告、直接创建、配置切换、关闭再恢复及分叉继承。覆盖原生 Plan 与 Host 曾显式选择 `bypassPermissions` 的组合，观察有效策略。
2. ACP 夹具验证真实审批代理结果。覆盖模式写入未返回、通知先到、未知模式、失败、离开 Plan、恢复时重放。受限窗口自动 `allow` 次数为 **0**。正常模式和其他 ACP vendor 行为回归。
3. 在隔离工作区的实际 Host 检查 OMP Plan 的写入、终端及既有规划工件处理。任何额外文件写入与终端权限都按原有边界检查。保留 `requireApprovalFor` 不可满足的拒绝测试。 [ACP 配置选项](https://agentclientprotocol.com/protocol/v1/session-config-options) · [OMP Plan 模式](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L2534)

### A3 · OMP 逐轮用量与会话占用分别记录

**模块与主责。** ACP 计量修改 `packages/agent-acp/src/{vendor-profile,client}.ts`、`vendors/catalog-expansion.ts` 及同目录测试。用量更新链路涉及 `packages/agent-contracts/src/external-agent.ts` 和 `packages/agent-runtime-kit/src/base-adapter.ts` 的 `foldUsageUpdate`／`createTurnUsageTracker`。Manager、预算、trace 和 Chat 消费端用既有测试验证。 [厂商用量钩子](../../packages/agent-acp/src/vendor-profile.ts#L126) · [共用跟踪器](../../packages/agent-runtime-kit/src/base-adapter.ts#L54) · [Manager 汇总](../../lib/ai/agent/external/manager.ts#L5640)

**改法。** 扩充既有 `promptUsage` 钩子的输入，让 OMP 能读取标准 `PromptResponse.usage`。在 OMP profile 校验后直投影为该轮的 `ExternalAgentTokenUsage`，保留上游总数及合法的缓存、推理计数，缺失或无效时报告未知。Devin 的累计差分及 Grok 等已有钩子各自保留回归。

OMP `usage_update` 的 `used/size` 是占用，`cost` 是会话累计。修正 `done.tokenUsage` 后，共用跟踪器仍可能将这些值补进回合账目。建议对既有用量更新事件增加可选的“仅会话上下文”语义，使占用与累计成本留在会话视图，计量器只消费实报的逐轮值。保留其他厂商的旧字段语义。核对预算、trace、CLI 与 Chat 后冻结字段名。混合版本要确认由能识别新语义的一侧完成权威计量，旧消费者的展示与入账行为单独验收。存在逐轮成本依据时才记录 `providerCost`。 [OMP 回合用量](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L2961) · [ACP 会话用量](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates)

**验收。**

1. 真实 OMP 加 loopback 模型，两轮返回 **12、12 tokens**，适配器与 Manager 分别记录 **12、12**，汇总 **24**。关闭恢复后的首轮仍只记录实报的 **12**。另测递增和递减样本。
2. 只有上下文占用或累计成本时，仪表仍可用，回合 tokens 和成本保持未知。覆盖用量缺失、负数、无效或零值、缓存字段、取消和失败，保留实报用量且每轮最多入账一次。
3. 回归一条原有累计计数 ACP 路径和一条既有 `promptUsage` 路径。沿预算、trace 和 UI 核对占用不会写入耗用。旧记录保留原值和未知状态，补账需有可核对的逐轮数据与独立方案。

## 4. S2 移除进程和终态的歧义

| 工作项与主责                            | 改动模块与做法                                                                                                                                                                                                                                                                                   | 必过验收                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1 · Pi 探针** · Pi 集成              | `packages/agent-pi/src/{rpc-client,auth}.ts`。`runCliProbe` 区分成功退出、非零、超时与清理未确认。成功退出才认证版本，保留 auth 的结构化非零语义。并发探针使用不同 ID。                                                                                                                          | 打印认证版本后退出 2 必须失败。超时后进程回收或明确阻止复用。并行探针无串读和残留监听。空模型列表与探测失败可区分。                                                                      |
| **B2 · Pi 准入/断开** · Pi 集成         | `rpc-client.ts` 的 `startSession`、`reclaimCapacity`、`disconnect`、`resumeSession`。核对 Manager 的 `ensureSessionCapacity`。异步准备前预留名额，按连接代际限制启动与断开，保护后台原生运行不被热换。参考独立 OMP RPC 的预留。                                                                  | 五并发同时最多四个子进程。满且全忙时有界拒绝。空闲回收符合既有顺序。断开后没有迟到注册与存活子进程。后台运行时更新指令不能关闭旧进程。                                                   |
| **B3 · Pi 恢复历史** · 会话集成         | `rpc-client.ts`、`lib/ai/agent/external/{manager,integrations/pi,session/open-native-session-in-chat}.ts`。复用同 Host、账号和工作区的原生会话查找。需要新增查询时再扩展 CLI `node-backend.ts`、Tauri `pi_sessions.rs` 与配对 IPC。                                                              | 同 ID 恢复正文和分支。缺失、跨 Host／账号、查找后文件消失均应返回可操作错误，Cognia 历史仍可读。可证明从未持久化的空会话可以安全重开。只有用户明确新开才改链接，旧链接无需加入绝对路径。 |
| **B4 · OMP 失败与 steering** · ACP 集成 | `packages/agent-acp/src/{client,vendor-profile}.ts` 与 OMP profile，必要时 `turn-failure.ts` 与会话输入消费者。优先识别上游结构化错误。18.22.2 的普通错误若只有文本加 `end_turn`，记录该版本的可判定边界并推动上游支持，避免猜测错误正文。已有 steering 改动合入后识别 OMP 的 `promptRequired`。 | 对成功、取消、拒绝、HTTP 400 和有无部分输出分别断言。支持结构化错误的版本须标记失败并显示诊断。steering 成功送一次，明确未送达时保留草稿，超时或结果未知时禁止自动发起新回合。           |

B2 的四个名额是单个 Pi 适配器的默认上限，仍遵循 Host 全局管理。B4 以结构化错误证据作为供应商失败修复的发布条件。 [Pi 限额](../../packages/agent-pi/src/rpc-client.ts#L1374) · [OMP 独立包预留](../../packages/agent-omp/src/rpc-client.ts#L208) · [OMP 错误映射](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L2336)

## 5. S3 补齐可安装、可诊断与可用的会话能力

| 工作项与主责                               | 改动模块与做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 必过验收                                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1 · 安装、版本、账号** · 运行时生命周期 | 复用 `lib/ai/agent/external/lifecycle/{service,launch-preparation,native-runtime-host}.ts`、`agent-readiness.ts`、`config/install-catalog.ts`、`components/settings/agent/agent-{inspector,readiness-pipeline}.tsx`。Pi 的目录由 `packages/agent-pi/src/manifest.ts` 生成，核对 `deploy/bundle/agent-versions.json` 与双语指南。OMP ACP 的行由 `protocol/external-agent-runtimes.json` 维护，执行目录一致性检查。OMP 提供目标 Host 的版本、认证方法、模型和首轮状态。托管分发采用经身份与 SHA-256 校验的制品。 | 同一目标 Host 可辨未安装、版本不兼容、待认证、无模型、可运行。外部 Provider 使用对应原生账号。已认证、仅探测通过和无法验证能区分。                       |
| **C2 · 配对与审批** · Host 就绪            | `agent-transport.ts`、`host/{file-host,terminal-host}.ts`、`integrations/acp.ts`、OMP profile 和设置入口。先呈现缺 Host 端口、强制审批不可用的原因。受控文件、终端、取消和清理均有实机证据后开启对应配对组合。                                                                                                                                                                                                                                                                                                 | Tauri、CLI、配对 Web／移动端分别匹配实际能力。有能力的 Host 测执行、权限拒绝和清理，缺端口的 Host 启动前给出原因。强制审批只有覆盖实际执行路径才可开放。 |
| **C3 · OMP 会话功能** · ACP 集成           | 扩展 profile 的现有通知钩子映射经版本确认的 OMP 压缩状态。结合 `capability/capability-live-facts.ts` 与 `components/agent/external-agent/{session-panel,session-operations}.tsx`，按协商补齐原生命令、模型、列表、加载、恢复及分叉体验。Cognia 指令当前在 ACP 兜底中作为普通 prompt 块，系统级注入取决于上游合同。                                                                                                                                                                                             | 压缩开始、完成、失败和断线有正确状态。会话操作对应真实方法，未广告的删除不可触发。模型与命令在刷新后对应当前 Host。已有原生历史的载入与重开保留归属。    |

新增文本走 split i18n 的 en／zh-CN，包含 aria label。静态导出复用现有 IPC 或配对传输。评审参考 Zed 把安装、认证和远程凭证放在同一用户路径，以及 ACP 协商与 OpenCode 显式权限规则。 [Zed 外部 Agent](https://zed.dev/docs/ai/external-agents) · [ACP 工具调用](https://agentclientprotocol.com/protocol/v1/tool-calls) · [OpenCode 权限](https://opencode.ai/docs/permissions/)

## 6. S4 按明确需求评估原生 OMP RPC

当前独立包限定 **18.6.1**，Rust 与 CLI 已有 raw stdout。若原生子 Agent 控制、goal/todo、handoff 或后台静止语义成为实际产品需求，先比较可验证的 ACP 扩展和 RPC。采用 RPC 时需要以下准入证据。 [OMP 独立包](../../packages/agent-omp/README.md) · [Rust 原始字节通道](../../crates/cognia-external-agent/src/process.rs#L660)

| 实施面      | 模块                                                                                                                                                          | 准入验收                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 版本与 wire | `packages/agent-omp/src/{manifest,rpc-peer,rpc-client}.ts`、`src/upstream/`、现有包级 acceptance                                                              | 目标制品通过协议协商、chunk、回合完成／静止、取消、重连和原生历史验证。                                  |
| Host 组合   | `integrations/register.ts`、`host/process-host.ts`、`lifecycle/launch-preparation.ts`。批准生产入口后，由 OMP 专属组合模块接管未实现的生产 `prepareSession`。 | 可信文件、临时 bootstrap、账号、原生目录与会话代际绑定。Host 与账号之间的授权和原生会话 ID 均不串用。    |
| 守卫与清理  | `packages/agent-omp/src/native-guard.ts`、Host 已有沙箱与代理端口                                                                                             | 验证父／子会话与恢复时的审批和重新绑定。转换失败能同步终止或撤销出站。进程组确认退出后才释放凭证等资源。 |

保留 ACP 配置与历史链接。若批准 RPC 产品接入，提供独立显式入口，并以授权的导入或恢复实现原生身份映射。实验入口可独立撤销。两个协议分别按对应的二进制版本和实际 Host 验收。

## 7. 验证、发布与回退

### 测试入口和发布证据

```bash
pnpm test --runInBand packages/agent-pi/src/rpc-client.test.ts packages/agent-pi/src/rpc-peer.test.ts lib/ai/agent/external/manager.test.ts lib/ai/agent/external/turn-failure.test.ts
pnpm test --runInBand packages/agent-acp/src/client.test.ts packages/agent-acp/src/vendors/catalog-expansion.test.ts packages/agent-runtime-kit/src/base-adapter.test.ts
pnpm test --runInBand packages/agent-omp/src/native-guard.test.ts packages/agent-omp/src/rpc-client.lifecycle.test.ts
```

- S1 各项按既有入口写同目录测试并跑原生制品和合成模型。由 Manager 的正常入口、实际 CLI 与 Tauri 验证声称支持的行为。Linux、配对端及真实供应商的结果按实记录。仓内 Playwright 支持测试可扩展设置与会话入口，用户路径从当前入口执行。 [现有 Playwright 用例](../../tests/e2e/agents/external-agent-support.spec.ts)
- 依据变更运行 `pnpm typecheck`、`pnpm lint`、`pnpm audit:agent-capabilities`、`pnpm audit:external-agent-runtimes`、`pnpm pi:extension:pin:check`。涉及 IPC 时加所属 Rust 测试与 `pnpm companion-api:check`，并验证配对端能力和旧 Host 降级。涉及 UI 时加 `pnpm i18n:build`、`pnpm i18n:build:check`、`pnpm lint:i18n`、`pnpm lint:static-export`。
- 验收记录包含版本、Host、传输、退出状态、审批结果、每轮用量及回收耗时。测试门槛为串轮、自动重放、自动放宽权限和超限均为 **0**。日志使用有限的错误分类与协议版本，原始 prompt、绝对路径和凭证不进入诊断事件。保持既有 PII、工作区、进程与出站边界。

### 推出与回退

S1 保留三个独立回退点，先在受控配置验证再推广。发现一次归属错误、自动放宽权限、重复计量或无法确认进程回收，暂停相关发布。Pi 可通过现有 `COGNIA_DISABLE_PI_RPC` 阻止新会话，存量由现有停止流程确认清理。OMP 权限回归时先停用受影响的配置，必要时以保守策略前滚。用量映射可单独回退，历史统计保留原始记录与修复版本时间点。S1–S3 使用兼容读取和可选事件字段，当前方案无需 Dexie 迁移。

## 8. 评审决定

| 决定                          | 推荐与影响                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Q1 · Pi 不确定 ACK 后何时恢复 | 先回收并报告送达结果未知，下一条显式输入再恢复。只有可验证的未写入才进入既有重试。       |
| Q2 · OMP 未知模式和 Plan 缺失 | 保持受限状态并给出原因。协商与 Host 授权均确认后才允许放宽。                             |
| Q3 · OMP 的宿主交付顺序       | 先完成 macOS／Linux 本地验收和跨端限制提示。配对终端与全工具审批按实际验收独立开启。     |
| Q4 · 原生 OMP RPC             | 等 ACP 扩展无法覆盖的需求明确，且目标制品、守卫与清理证据满足 S4，再确定平台与发布范围。 |

| 日期       | 角色                                         | 复核                                                         |
| ---------- | -------------------------------------------- | ------------------------------------------------------------ |
| 2026-11-18 | 方案撰写                                     | 对照两轮审计和当前调用方，首批三项均有主责、异常路径及验收。 |
| 待评审     | Pi 集成、ACP 权限与计量、Host 安全、发布验证 | 核对 Q1–Q4、可用测试 Host 和发布批次。                       |

相关契约 [ADR-0119 Pi 原生 RPC](../content/docs/en/adr/0119-pi-native-rpc-integration.md) · [ADR-0216 配置状态隔离](../content/docs/en/adr/0216-each-agent-configuration-keeps-its-own-state.md) · [ADR-0217 适配器与 Host 端口](../content/docs/en/adr/0217-agent-integrations-are-packages-behind-host-ports.md) · [既有 OMP 独立包方案](2026-10-05-oh-my-pi-package-integration.md)。
