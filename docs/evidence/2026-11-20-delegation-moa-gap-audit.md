# Cognia 委派与 MoA 实现审计

- Status: verifying
- Lane: deep
- Created: 2026-11-20
- Updated: 2026-11-20
- Related: [ADR-0137](../content/docs/en/adr/0137-delegation-runtime.md) · [ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md) · [ADR-0188](../content/docs/en/adr/0188-a-routed-turn-spends-only-what-its-ledger-reserved.md) · [Agents 与 Squads 广域审计](2026-11-18-agents-and-squads-gap-audit.md)

## Original request

> 分析一下现在Cognia的委派或者moa机制的实现，看看目前存在什么缺口

> 做一次对抗性审查

## Knowledge

| ID  | Statement                                                                                               | State       | Basis                                                                                      | Depends on |
| --- | ------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------ | ---------- |
| G1  | 梳理用户可以实际触达的委派和多模型协作入口，定位可靠性与质量缺口。                                      | Agreed      | 2026-11-20 原始请求。                                                                      | -          |
| C1  | 代码基线为 `eaa2309187`。核对共享分支推进到 `3a49486dd1` 时，审计实现路径没有提交差异或本地改动。       | Verified    | 2026-11-20 `git status`、按路径 `git diff` 与 `git log`。                                  | -          |
| O1  | Cognia 已有运行树、Squad DAG、Council / Ensemble 和 Router Fusion，承担不同的工作和回执。               | Verified    | 2026-11-20 生产入口追踪，见能力地图。                                                      | C1         |
| H1  | 委派缺口源于缺少可运行的编排器。                                                                        | Invalidated | 同日核对实际启动器、工作流节点和已接通的 Fusion Host。                                     | O1         |
| O2  | 同一幂等键并发可启动两次，Delegate 的终态与 API 不保留澄清问题，待批准团队委派无法重载。                | Verified    | 探针 F01–F03，fake-indexeddb、Fake Provider、Jest jsdom，同日。                            | C1         |
| O3  | Squad 子运行结果从 Squad 级字段读取，Room 回传缺少终态回填接线，改令回执会丢失实际投递状态。            | Verified    | 探针 F04、独立只读复核、生产入口追踪，见 F04–F06，同日。                                   | C1         |
| O4  | Panel 会拒绝可行组合，Ensemble 超时释放逻辑并发位后原样本仍在运行，Council 可以在零回复时输出一致信心。 | Verified    | 探针 F07–F09，同日。                                                                       | C1         |
| O5  | Fusion 生产路由使用规则。历史 Squad 闭卷实验只覆盖一种任务配置。                                        | Verified    | `routing-experiment.ts`、`promotion.ts`、2026-10-25 评测实验条件，同日核对。               | C1         |
| Q1  | 真 Host 重启和跨设备回传会如何表现，各真实引擎对取消信号的支持是否一致？                                | Open        | 当前为源代码、内存依赖和测试存储。                                                         | O2, O3, O4 |
| Q2  | 多模型或多层聚合在哪些任务上能提高等成本验收率？                                                        | Open        | 需要真实 Provider、固定任务分层和同预算对照。                                              | O5         |
| O6  | Fusion 的审批提交、取消封账和未知副作用恢复存在状态分歧。                                               | Verified    | 2026-11-20 在 `3a49486dd1` 的生产 orchestrator、Dexie 和 boot sweep 故障注入，见 F11–F13。 | C1         |
| O7  | Council workflow 收到父级 abort 后仍启动后续调用，单候选代码 Panel 的兼容响应丢掉降级标记。             | Verified    | 2026-11-20 工作流适配器与模型替身、Panel 与实际兼容序列化器探针，见 F14–F15。              | C1         |

## Problem frame

沿着发起请求、确认受理、开始执行、等待人输入或审批、停止、结果返回的链路检查委派。沿着角色选择、并发候选、判定与综合检查多 Agent 输出聚合。以仓库生产入口和可重放反例作为审计完成信号。涉及真实引擎、跨端和模型质量的结果仍待验收。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                            |
| ------------ | ------ | -------------------------------------------------------------------------------------- |
| scale        | high   | 调用入口横跨 Chat、Room、Squad、Workflow、Run API，状态横跨运行树和 Fusion ledger。    |
| technical    | medium | 需要追踪不同 lease、outbox、等待状态及请求幂等性。                                     |
| coupling     | high   | 执行身份、项目 checkout、审批、预算和响应交付依赖多个持久化边界。                      |
| requirement  | medium | 当前缺口有明确反例。多层 MoA 的目标任务与可接受成本仍需界定。                          |
| verification | high   | 纯逻辑、假 Provider 和假 DB 能复现核心路径。真实暂停、重启、终止和质量增益需环境验收。 |
| risk         | high   | 重复支出、委派消失、错误结果回填，或用户误以为改令已经送达。                           |

## Risks

| ID  | Risk (impact)                                                            | Severity | Source                                               | Claim                                                            | Refuted by                                                          |
| --- | ------------------------------------------------------------------------ | -------- | ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| R1  | 重复受理同一请求，产生多份工作和花费。                                   | high     | ADR-0188、故障注入视角。                             | 同键同请求只启动一个 run。                                       | 并发调用得到两个实际启动 ID。                                       |
| R2  | 已受理的委派或澄清无法恢复。                                             | high     | ADR-0137、ADR-0252、STPA。                           | 等待期间保存待办和续跑所需输入。                                 | 重载丢失审批，或澄清直接封为失败。                                  |
| R3  | 上游收到旧结果、漏结果或假改令回执。                                     | high     | ADR-0252、2026-11-18 广域审计、独立只读复核。        | 按 attempt 交付，回执对应实际投递。                              | 从 Squad 级字段回填，终态后没有补投，或零子回执仍报已送达。         |
| R4  | 聚合缺少有效候选或实际执行超出并发承诺。                                 | high     | ADR-0188、工作流生产适配器、故障注入视角。           | 能排到合法模型组合，时限作用到执行，聚合状态反映有效候选。       | 可行组合被拒、超时后并发槽溢出、零候选时仍报告一致。                |
| R5  | 增加模型调用后成本上升，任务收益未知。                                   | medium   | 2026-10-25 评测、Fusion B6。                         | 指定任务在可比预算下验收率更高。                                 | 同模型、同预算的配对评估没有增益。                                  |
| R6  | 已审批的工作挂起，取消后仍返回答案，或未知副作用被重启流程封成普通失败。 | high     | ADR-0188 REC-03/04/06、Fusion 状态机、故障注入视角。 | 审批决策和续跑原子衔接，调用方按最终状态返回，人工核对可跨重启。 | 注入审批与续跑之间中断、取消与封账竞态、核对期间 lease 过期后重启。 |

## Verification obligations

| ID  | Risk               | Method                                                        | Independence   | Evidence                                                                    | Coverage                                                       | Status  |
| --- | ------------------ | ------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | ------- |
| V1  | R1, R2, R3, R4     | 跑现有聚焦 Jest 和隔离反例。                                  | tool           | 基线 14 suites / 334 tests 通过。反例 7 suites / 8 场景通过，见下方命令。   | 生产模块配合假 DB、假 Provider、可控 launch 和 sleep。         | passed  |
| V2  | R2, R3             | 独立核对审批、结果、补投和 steer 调用。                       | fresh-reviewer | 独立源追踪及内存探针观察到 Squad 空/旧结果、queued 和零回执被报 delivered。 | 精确调用链和替代边界依赖，未启动真实 Squad。                   | passed  |
| V3  | R1, R2, R3, R4, R6 | 真实 Host 重启、重复投递、审批恢复、子执行器取消和配对回传。  | real-env       | 本轮无真实 Host、引擎和配对设备联跑记录。                                   | 故障点与各引擎真实执行行为。                                   | planned |
| V4  | R5                 | 同预算单 Agent、Cascade、Panel、Squad 按任务配对。            | real-env       | 2026-10-25 闭卷 Squad 结果只可作为历史参照。                                | 需成本、p95、可独立验收的结果和降级率。                        | planned |
| V5  | R1, R2, R3, R4, R6 | 两路 fresh-context 复核并重跑离线探针，注入跨事务和封账边界。 | fresh-reviewer | 旧结论范围修订与新增 F11–F15 见对抗性复审。                                 | 真实源模块，依赖可控替身，无真实 Provider 计费或真 Host 重启。 | passed  |

## Decisions

| ID  | Date       | Decision                                                                                    | Action   | Based on       | Reversal trigger                                         |
| --- | ---------- | ------------------------------------------------------------------------------------------- | -------- | -------------- | -------------------------------------------------------- |
| D1  | 2026-11-20 | 基于现有执行路径诊断，并优先验证重复启动、等待状态、终态回传和聚合失败。                    | diagnose | C1, O1         | 生产入口或状态所有者发生改变。                           |
| D2  | 2026-11-20 | 对幂等启动和按运行交付给出最高修复优先级。现有诊断足以定位可修改的契约。                    | diagnose | O2, O3, O4     | 运行级输入和结果成为交换边界，或反例在真实路径中被证伪。 |
| D3  | 2026-11-20 | 先修 Fusion 审批恢复、取消后唯一终态及人工核对保留，与原先的幂等启动和按 attempt 交付并列。 | diagnose | O2, O3, O6, O7 | 生产路径改变或真实环境验收推翻离线反例。                 |

## Residual risks

| ID  | Residual                                         | From   | Why still open                                | Next action                                                                                         | Status |
| --- | ------------------------------------------------ | ------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| X1  | 真实 Host 的中断、跨端结果与引擎取消行为未实测。 | V3, Q1 | 本轮探针只运行本地替身。                      | 在 Host 写入终态后、outbox 入队前注入退出，用配对端验证每个 attempt 的回传，再验证每种引擎的 stop。 | open   |
| X2  | Panel、多层 MoA 或团队路线的实际增益未知。       | V4, Q2 | 历史闭卷样本无法外推到当前 Panel 和工具任务。 | 以单 Agent 自检为同预算基线，按任务测验收率、成本、p95、降级率。                                    | open   |

## Outcome

| ID  | Signal                           | How / when measured            | Result                                     | Status  |
| --- | -------------------------------- | ------------------------------ | ------------------------------------------ | ------- |
| M1  | 有可定位和重放的当前缺口。       | 对照生产入口、已有基线和反例。 | 14 项运行行为发现，外加 1 项质量证据缺口。 | met     |
| M2  | 当前实现完成真实端到端委派验收。 | 执行 V3。                      | 真实环境验收待做。                         | pending |

## 能力地图

| 机制                           | 实际入口与执行语义                                                                                                                                                                                                                  | 当前边界                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通 Delegation 与 child run   | `/delegate` 可以把正在执行的工作挂到可独立跟踪的承诺上。`dispatch_agent`、插件调度、Room 到 Squad、Best-of-N 等入口复用 `launchChildRun` 并按 `parentRunId` 建立血缘。SDK 内联子代理作为 turn 内的消息部分。                        | 实际运行可出现在树上。审批前、原调用方等待、跨进程结果回传仍有下列断点。见 [ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md#2-one-child-run-tree) 和 [launchChildRun](../../lib/execution/launch-child-run.ts)。                                                                                               |
| Squad 与 Ultracode             | Squad 以 lead、teammate、任务依赖和 review 调度；Room 通过 handoff 交给 Squad 并收报告。Ultracode 通过 Squad 的 workflow graph 组合并行分析、复核、评判和综合节点。                                                                 | Squad 执行级结果与团队定义仍有混读。先前报告还覆盖取消准入、预算恢复与审查入口。见 [Squad lifecycle](../../lib/squads/agent-team-runtime.ts) 和 [Ultracode 节点](../../lib/squads/patterns/index.ts)。                                                                                                                                                   |
| Router Fusion Panel 与 Cascade | Panel 并行生成 2–3 个初始候选，匿名交给 judge，限制取证复查轮数，再综合与检查。Cascade 先验证便宜模型输出，按检查结果升级。通过 opt-in 的 Router Fusion 在 Chat 和 Run API 等入口可达，Chat 的显式 Cascade / Panel 按文本回合处理。 | Panel 属于固定拓扑，支持标注降级，Chat 请求显式允许降级。原始 MoA 还定义多层 Agent，每层可以读上一层全部输出。当前查看的产品入口未发现可配置的通用多层 MoA 执行模式。见 [Panel](../../packages/router-fusion/src/workflows/panel.ts)、[Chat 路由](../../lib/router-fusion/chat/chat-fusion-turn.ts)、[MoA 原论文](https://arxiv.org/abs/2406.04692)。    |
| Router Fusion Delegate         | lead 给出子任务与路径边界，worker 逐项处理，执行失败时有 repair / takeover 路径。通过沙箱验收、步骤 journal 与审批交付 patch，以 `patch_only` 为默认。                                                                              | 需要项目工作区、可用沙箱和获批验收配置。入口包含 Run API 和选用 Fusion 的 Agent/Squad/Workflow。普通 Chat Fusion 模式为 Auto、Direct、Cascade 与 Panel。见 [ADR-0188 B4](../content/docs/en/adr/0188-a-routed-turn-spends-only-what-its-ledger-reserved.md#delegate-b4) 和 [Delegate workflow](../../packages/router-fusion/src/workflows/delegate.ts)。 |
| Council、Ensemble 与 Best-of-N | `/council` 和 `ai.council` fan-out 后交给综合模型。`ai.ensemble` 重复执行 agent 或 subworkflow，可投票、按阈值、按分选优或综合。Best-of-N 在同一冻结基线做独立候选并审查发布胜者。                                                  | 三者的结果与失败语义由各自执行器定义。见 [Council](../../lib/ai/council/run-council.ts)、[Workflow Ensemble](../../lib/workflow/nodes/ai/ai-ensemble.ts) 和 [Best-of-N](../../lib/best-of-n/core.ts)。                                                                                                                                                   |

## 缺口与证据

| ID  | 优先级 | 现象、影响及依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 证据范围                                                                                                                      |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| F01 | P1     | **同一个幂等键并发启动两份工作。** Run API 先读幂等记录，随后创建会话和 run，最后写入幂等记录并启动。两次并发请求均返回新建，各自启动一个 ID；之后顺序重放只看到最后留存的映射。Panel、Delegate 共享受理路径。见 [`run-api.ts:389`](../../lib/router-fusion/api/run-api.ts#L389)、[`run-api.ts:435`](../../lib/router-fusion/api/run-api.ts#L435)。                                                                                                                                                                             | 本地探针用真实 API 受理函数和 Dexie 实现，DB 使用 fake-indexeddb，执行器为直接模式 fixture，观测到两条记录和两次 start。      |
| F02 | P1     | **Delegate 的澄清问题无法续答。** lead 的 `need_input` 带问题数组抛出，Host 只把错误码与通用消息带入终态。澄清原文仍保存在内部调用产物。API 有 `resume kind=input`，但同一个 run 回 `RUN_NOT_WAITING`。见 [`delegate.ts:930`](../../packages/router-fusion/src/workflows/delegate.ts#L930)、[`orchestrator-host.ts:840`](../../lib/router-fusion/runtime/orchestrator-host.ts#L840)、[`run-api.ts:819`](../../lib/router-fusion/api/run-api.ts#L819)。                                                                          | Fake Provider 返回一个明确问题，经真实 graph、Host 和 store 后，问题不在终态错误中，服务端调用产物仍可读。                    |
| F03 | P1     | **待批准团队委派重载后消失。** `TeamDelegationRecord` 在持久化时被排除，待执行参数也只在内存 `Map`。重载后按原 ID 无法批准。静默时段触发等待时，工作流 `action.team.delegate` 会把立即 resolve 的 `awaiting_approval` 当正常 step 输出，即使启用了 `awaitCompletion`。见 [`delegation-orchestrator.ts:601`](../../lib/squads/delegation-orchestrator.ts#L601)、[`store.ts:30`](../../stores/squads/agent-team-store/store.ts#L30)、[`team-ops.ts:343`](../../lib/squads/workflow-nodes/team-ops.ts#L343)。                      | 用真实 Zustand 持久化快照和重新水合复现记录消失。工作流后续行为为源码核对。                                                   |
| F04 | P1     | **Squad 已完成可以回空结果或上一轮报告。** launcher 按 `executionRunId` 等终态，却从 `teams[squadId].finalResult` 取内容。普通 Squad 的 `result.output` 进入生命周期结果，只有 Ultracode 分支在此写团队级 `finalResult`；Room outbox 直接保存 launcher 返回值。见 [`squad-launch.ts:44`](../../lib/squads/ports/squad-launch.ts#L44)、[`agent-team-runtime.ts:1275`](../../lib/squads/agent-team-runtime.ts#L1275)、[`settle.ts:90`](../../lib/squads/room-handoff/settle.ts#L90)。                                             | 真实 launch port 配合可控 terminal/Team fixture 复现空和旧报告，独立复核匹配源头。                                            |
| F05 | P1     | **Room 回传会在终态到入队的窗口丢失。** 正常完成依赖进程内 promise 观察器，启动后的 Room lane 只扫已入队记录。`reconcileRoomHandoffs` 无生产调用点；其现有回填以完成时间接近程度推断结果归属，已有前次反例显示会误归。见 [`decide.ts:260`](../../lib/squads/room-handoff/decide.ts#L260)、[`settle.ts:119`](../../lib/squads/room-handoff/settle.ts#L119)、[`runtime-room-lane.ts:39`](../../lib/background-tasks/runtime-room-lane.ts#L39)。                                                                                   | 当前生产接线独立确认，关联 2026-11-18 F05。真实停机窗口待跑。                                                                 |
| F06 | P1     | **Squad 改令可能显示已送达，实际仅排队或无回执。** coordinator 区分 `queued` 与 `delivered`。durable 层只返回尝试子数和回执 ID；上层只要有子进程就报 `delivered`，Chat 将消息标为已接受并跳过备用队列。见 [`coordinator.ts:848`](../../packages/agent-orchestration/src/coordinator.ts#L848)、[`durable-control.ts:502`](../../lib/squads/durable/durable-control.ts#L502)、[`control-handlers.ts:114`](../../lib/execution/control-handlers.ts#L114)、[`agent-chat-send.ts:1086`](../../hooks/chat/agent-chat-send.ts#L1086)。 | 独立内存探针观察到 `delivered` 携带 queued 回执及空列表，关联 2026-11-18 F06。                                                |
| F07 | P2     | **有合格的异构组合，Panel 仍会拒绝。** `ActionRouter` 独立选出每个角色的首选，之后发现 `modelRevision` 重复就排除整个 action。允许的别名有备选 revision 时也不会重新配对。见 [`action-router.ts:393`](../../packages/router-fusion/src/routing/action-router.ts#L393)、[`action-router.ts:444`](../../packages/router-fusion/src/routing/action-router.ts#L444)。                                                                                                                                                               | 同一 registry 和输入，自动选角拒绝；用 router 的显式 role override 选择备选后通过。override 在探针中用于证明有解。            |
| F08 | P1     | **Ensemble 的样本超时只结束等待。** 样本超时后立即释放逻辑并发槽，已启动的底层调用仍可继续。子工作流只收到父级 signal，样本超时没有独立 signal。Council 使用同类 timeout 包装。见 [`run-ensemble.ts:110`](../../lib/ai/ensemble/run-ensemble.ts#L110)、[`run-ensemble.ts:199`](../../lib/ai/ensemble/run-ensemble.ts#L199)、[`ai-ensemble.ts:273`](../../lib/workflow/nodes/ai/ai-ensemble.ts#L273)、[`run-council.ts:198`](../../lib/ai/council/run-council.ts#L198)。                                                         | Ensemble 探针设置并发 1，观察到两个同时活动的样本，节点返回时第一个仍活动。Council 为源代码同型核对，真实引擎停止效果待验证。 |
| F09 | P2     | **Council 零候选也会综合并显示“完全一致”。** `respondedCount` 为 0 时仍调用 synthesizer，将其文本解析为 `confidence`。若汇总模型生成答案和 `unanimous`，报告可以同时显示 0/2 与一致。见 [`run-council.ts:278`](../../lib/ai/council/run-council.ts#L278)、[`run-council.ts:338`](../../lib/ai/council/run-council.ts#L338)。                                                                                                                                                                                                    | 脚本模型令两个成员失败，综合器照常执行，返回 `respondedCount: 0` 和 `confidence: unanimous`。                                 |
| F10 | P2     | **还缺足以选择 MoA 的实证数据。** Fusion 学习路由仅 shadow，真实规则流量的 propensity 为 1，晋级检查会拒绝这类数据。历史 100 道闭卷研究中，Single 均分 3.7933，Serial 和 Parallel 分别低 0.3200、0.2633，且消耗更多 solver tokens。实验的对象是固定配置的 Squads。见 [历史评测](../reports/2026-10-25-multiagentbench-research-100.md#results)、[`routing-experiment.ts:224`](../../lib/router-fusion/eval/routing-experiment.ts#L224)、[`promotion.ts:25`](../../lib/router-fusion/eval/promotion.ts#L25)。                    | 当前源证据与历史定量结果。当前 Panel 或同预算多层 MoA 增益仍未知。                                                            |

## 修复顺序与验收

1. **先保证每次受理和交付可追踪。** 并发同键最多启动一次；每个 attempt 的结果只回到自己的父运行；从终态前后任一故障点恢复后，Room 最终收到同一份回执。F01、F04、F05 可用同一套重试与故障场景驱动。
2. **再修等待与控制状态。** 同一 Delegate run 可查看问题并带版本续答；重启后待批准委派可辨认并安全继续；队列、已送达、明确失败分别传回调用方。并发位要等样本停止或有可审计的终止回执再释放。覆盖 F02、F03、F06、F08、F14。Fusion 的审批事务恢复、取消封账和人工核对保留（F11–F13）与第一步并列处理。
3. **最后提高聚合可用性并测收益。** Panel 在合格模型中联合选角，Council 根据有效回复数明确失败或降级。用同预算、分任务对照决定是否扩大 Panel 或增加多层 MoA。覆盖 F07、F09、F10、F15。

## 对抗性复审

2026-11-20 在 `3a49486dd1` 上复审。两位独立审查者按 ADR 合约核查生产接线和探针假设，主审复现并修订报告。本轮跨模型复审按用户选择跳过。

### 原发现的范围修订

- **F01 维持 P1。** 两个请求属于同一调用方和端点、带同键同体、各自创建新会话，测试租户额度允许两次受理。复查 Tauri 桥并发处理请求，同既有会话的锁无法解释新会话场景。探针断言两个不同 run ID，并核对顺序重放指向最后留存的映射。 [桌面桥接](../../lib/companion/desktop-write-source.ts#L268) · [会话绑定](../../lib/router-fusion/api/run-api.ts#L306)
- **F02 维持 P1，修正「问题丢失」的范围。** 调用记录仍保存 Lead 的澄清原文，终态故障和 API 响应只携带通用错误。相同 run 输入续答时还要产生新的计划步骤身份，否则会按固定逻辑步骤 `delegate:plan` 重放旧计划。 [调用产物](../../lib/router-fusion/db/ledger-store.ts#L1589) · [计划步骤](../../packages/router-fusion/src/workflows/delegate.ts#L911) · [重放键](../../lib/router-fusion/db/ledger-store.ts#L2092)
- **F03–F04 维持 P1。** F03 针对尚未创建 child 的 Squad `TeamDelegationRecord`；工作流提前继续的分支使用静默时段等真实触发的审批等待。F04 的旧报告可由同一 Squad 先跑 Ultracode 再跑普通执行产生，启动与状态更新都会保留旧团队字段。 [工作流发起](../../lib/squads/workflow-nodes/team-ops.ts#L269) · [更新团队状态](../../stores/squads/agent-team-store/slices/actions.slice.ts#L466)
- **F05–F06 维持 P1，修复要求扩大。** Room 的通用 Retry 把替补 run 挂在原 Squad run 下；现有 backfill 只读 delegation 的直接子节点，需要同时修复 attempt 发现与结果归属。Steer 在父委派层也会把唯一的 `queued` 子回执提升成 `delivered`，本轮补了对应探针。 [Retry 启动参数](../../lib/squads/squad/build-start-input.ts#L230) · [Room 回填](../../lib/squads/room-handoff/settle.ts#L60) · [父委派回执](../../lib/execution/steer.ts#L180)
- **F07 维持 P2。** 新增 Host 路由探针。同一资源池仅调换候选顺序，就从拒绝变成选中。独立离线复核还发现从三席缩到两席后，保留的 `panel_c` 配置会参与路由去重，而执行仅取前两席。 [Host 路由](../../lib/router-fusion/routing/run-route.ts#L249) · [执行成员](../../lib/router-fusion/runtime/orchestrator-host.ts#L609)
- **F08 维持 P1，限定实测范围。** 违背并发上限的直接证据来自可控样本。生产子工作流只收到父级信号，样本超时缺独立取消。Agent 工具路径另有自身超时，供应商并发和实际终止时间仍待测。 [子工作流调用](../../lib/workflow/nodes/ai/ai-ensemble.ts#L273)
- **F09 维持 P2，保留单模型兜底语义。** 全员失败时让综合器直接答复是显式设计，缺陷是零候选也可以报告“一致”。F10 仍是证据缺口。 [Council fallback](../../lib/ai/council/run-council.ts#L154)

### 新增发现

| ID  | 优先级 | 现象与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F11 | P1     | **Fusion 审批已入库，重试和重启都无法推进该 run。** 审批记录和 `resumeRun` 分两个事务。只提交前者后，相同审批重试返回 `RUN_NOT_WAITING`，API 也找不到待审批 ID。启动恢复跳过 `waiting_for_approval`。本地探针提交真实审批事务并注入中断，调用方等待中的 run 一直保留，既有 caller 的超时路径可取消。 [审批与续跑](../../lib/router-fusion/runtime/delegate-approvals.ts#L147) · [boot 恢复查询](../../lib/router-fusion/chat/chat-runs.ts#L363)                                                                        |
| F12 | P1     | **取消已经胜出，调用方仍能拿到成功和答案。** 在答案产物已写、封账事务开始前插入真实 Cancel。Jest 观测持久状态为 `cancelled`、没有 `answer.completed`，同一次 `executeFusionRun` 回 `succeeded`，Run API 读取函数仍可读到该答案。Chat 和 Agent/Workflow 都消费返回值，兼容 API 的终态检查另行拒绝取消结果。 [orchestrator 封账](../../lib/router-fusion/runtime/orchestrator-host.ts#L489) · [终态裁决](../../lib/router-fusion/db/ledger-store.ts#L1142) · [Run API 结果](../../lib/router-fusion/api/run-api.ts#L552) |
| F13 | P1     | **等待人工核对的 Delegate 会被 boot 恢复当成丢失运行。** 未确认的工作区副作用使 run 进入 `reconciling`。本地探针用真实状态转换与测试时钟推进 lease 过期，boot 将它封为 `failed/RUN_LOST`，虽然事件里已有 `reconciliation.required`。模拟副作用只写入状态，真实文件施加结果与人工处理未实测。 [核对状态](../../lib/router-fusion/db/ledger-store.ts#L894) · [boot 恢复分支](../../lib/router-fusion/chat/chat-runs.ts#L316)                                                                                             |
| F14 | P1     | **取消 Workflow Council 后仍会启动新角色调用。** `executeAiCouncil` 没有把父步骤 signal 传到 Council。串行模式在首成员中触发 abort，仍启动第二成员和 synthesizer，本地观察到取消后新增两次调用。 [工作流适配](../../lib/workflow/nodes/ai/ai-council.ts#L72) · [Council 调度](../../lib/ai/council/run-council.ts#L269)                                                                                                                                                                                                |
| F15 | P2     | **单候选代码 Panel 的兼容响应丢失降级。** 允许降级时实际走单候选路径，账本事件发出 `run.degraded`，但代码任务基本验证得到 `quality_status: unknown`，兼容序列化只认 `degraded` 字面值，最终返回 `routing.degraded: false`。本地探针执行真实 Panel 与兼容响应构造。 [单候选降级](../../packages/router-fusion/src/workflows/panel.ts#L1416) · [质量状态](../../packages/router-fusion/src/verify/profiles.ts#L135) · [兼容响应](../../packages/router-fusion/src/api/chat-compat.ts#L148)                               |

修复验收要同时观察数据库终态、返回值和调用方展示。审批与恢复在事务中断后可重试。取消或组合降级都要传递一致的结果，Room 以本次 attempt 的身份连同终态和内容投递。真实 Host 与真实模型验收继续跟踪 V3、V4。

## 验证记录

使用仓库 `pnpm test`，未测覆盖率。第一组针对 ActionRouter、Panel、Delegate workflow、Run API、Delegate Host、Chat Fusion、`runEnsemble` 和 `ai.ensemble`，8 suites / 205 tests 通过。第二组针对 Squad delegation orchestrator、Squad launch port、Room handoff settle、Squad store、child launcher 和 `runCouncil`，6 suites / 129 tests 通过。对抗性复审另执行 orchestrator Host、Delegate Host、启动恢复、审批、Host 路由和 Workflow Council，6 suites / 108 tests 通过，其中 Delegate Host 套件是重跑。

从仓库根执行 `node docs/evidence/2026-11-20-delegation-moa-gap-audit.probes.mjs`。脚本重用原 Jest harness，在 `.cache/delegation-moa-gap-audit/` 生成临时测试，初审 7 suites / 8 反例通过。本轮最终 12 suites / 15 反例通过，断言的是当前缺口。实际执行范围为本地组件、状态库、生产适配函数与可控替身。真实 Provider、Tauri 重启、跨设备、外部 Agent 和成本对照需要另行验证。本轮更新审计文档和探针，产品代码未修改。

## 修复记录（2026-11-20）

在 `e2afecf577` 之上提交三批：`f2728e24f3`（Router Fusion：F01、F02、F07、F11–F13、F15）、`7107b04fc0`（Ensemble / Council：F08、F09、F14）、`adafb9a002`（Squad 与改令：F03–F06）。每批在只含 HEAD 与本批改动的稀疏工作树里跑过对应 Jest 套件。重跑本文探针后 13 个反例失败，即缺口已不再出现，另有 2 个仍通过：

- **F08 反例仍通过，属设计内。** 该样本忽略自身 abort 信号。超时后它保留并发位，直到停止宽限（默认 10 s）结束，随后释放并在结果中记 `stopUnconfirmed`，即复审要求的「可审计的终止回执」。JS 无法强制终止不响应信号的任务。
- **F03 反例超时。** 等待批准的委派现在要等到真正结束才 resolve。反例断言的「重载后无法重建」仍成立，持久化方案待决定。

`agent-team-runtime.test.ts` 在 HEAD 上原有 32 项失败。根因是多仓库改动（`263149ea77`）后，测试的 workspace lease 替身缺少 `additionalAliases`，已在第三批补上。剩余 5 项（GitHub 交付与 personal sink 相关）在基线提交上同样失败，与本次修复无关。

| ID  | 结论                                                            | 处理                                                                                                                                                                    |
| --- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | Confirmed                                                       | 幂等键在建 run 前原子认领；20 并发同键只启动一个 run（API-01）。                                                                                                        |
| F02 | Confirmed, reframed                                             | `waiting_for_input` 停放，问题落为产物、事件和人工交接；续答以 `delegate:plan:<round>` 新步骤身份继续同一 run。                                                         |
| F03 | Confirmed                                                       | 等待批准的委派完成前不 resolve，步骤 abort 时停止等待。用户选「持久化（脱敏）」后，`ca77023017` 把待批准委派写入 `squadParkedDelegations`（v259），重启后恢复，见下节。 |
| F04 | Confirmed（同类：compose 节点、trigger.team、team.finalResult） | 一律读本次 run 自己的 `workflowRuns` 行；每次 run 结束写或清空 team 的 `finalResult`。                                                                                  |
| F05 | Confirmed                                                       | 补投发现挂在原 attempt 下的 Retry，按各 attempt 自己的报告归属，删除 60 s 时间猜测；squads runtime 在启动时及每次 Squad run 结束时补投。                                |
| F06 | Confirmed（同类：IM、配对设备）                                 | 送达 / 排队 / 降级分开返回；Chat 将排队显示为排队，回合结束时结算或撤回回执。                                                                                           |
| F07 | Confirmed                                                       | Panel 成员联合回溯选择不同模型版本，仅前 `panel_size` 个角色参与。                                                                                                      |
| F08 | Confirmed                                                       | 新原语 `bounded-fan-out`：超时 abort、占位到停止或宽限结束，并记 `stopUnconfirmed`。                                                                                    |
| F09 | Confirmed                                                       | 少于两个回答时共识为 `unknown`。                                                                                                                                        |
| F10 | 证据缺口                                                        | 未改代码，见 X2。                                                                                                                                                       |
| F11 | Confirmed                                                       | 审批与续跑同一事务；续跑被拒时回滚审批。                                                                                                                                |
| F12 | Confirmed                                                       | 以封账结果为准；封账期被取消的 run 返回 `cancelled`，不记结果产物。                                                                                                     |
| F13 | Confirmed                                                       | boot sweep 不再处理 `reconciling`。                                                                                                                                     |
| F14 | Confirmed                                                       | Workflow Council / Ensemble / routed prompt 传递步骤 signal，取消后不再发起调用或综合。                                                                                 |
| F15 | Confirmed                                                       | 降级先于验收判定（PAN-03），兼容响应保留 `routing.degraded`。                                                                                                           |

X1、X2 与 V3、V4 仍为 open / planned。

## 修复记录（2026-11-21）：F03 持久化

用户选择「持久化（脱敏）」，`ca77023017` 落在 `f155f9dd6d` 之上。

- **写入。** 委派被推迟到 `awaiting_approval` 时，记录和运行参数写入 `squadParkedDelegations`（schema v259，squads manifest 认领，`encrypted-content`）。prompt、system prompt 与 reason 经 `redactTeamTextForPersistence` 换成占位符。脱敏后仍泄漏的运行不写入，只留不带 `run` 的行。
- **恢复。** Squad bootstrap 的 recover 阶段调用 `restoreParkedDelegations`，把行放回 store 与 `pendingRuns`，状态仍为待批准。不带 `run` 的行恢复为 `failed`（`DELEGATION_RUN_WITHHELD`）；来源 Squad 已删除的行直接删除。读取失败不阻断启动，只记一条警告，行留到下次启动。
- **批准与取消。** 批准先在一个事务里认领并删除该行再运行，所以两个窗口同时显示时只有先批准的那个会运行，另一个结束为 `DELEGATION_TAKEN_ELSEWHERE`。取消或结束时删除该行。创建它的进程仍用内存里的原文运行；重启后恢复的按脱敏文本运行，面板会提示。
- **测试。** 在 `delegation-orchestrator.test.ts` 用「清空 store 与内存、保留数据库」模拟重启，共 11 个用例；另有 `parked-delegations`、`squad-parked-delegations`、`persisted-text`、`bootstrap`、`squad-bootstrap`、`delegations-panel` 与 `schema.test.ts` 的 v259 升级用例。
- **探针。** 本文 F03 反例仍超时：它等待一个已暂停委派的 completion，而这个 completion 现在要等批准或取消才结束；反例也不调用启动时的恢复。重启后的行为由上述回归用例覆盖。
- **残余。** 未在 Tauri 桌面或真实浏览器里重启验证；只有 HEAD 与本批改动的拆分没有跑 Jest，跑过的是主树（多一个其他会话的 v258 改动）。另一会话未提交的 `workflowTriggers` 删除已随工作树改为 v260，其 `schema.test.ts` 仍断言 258。
