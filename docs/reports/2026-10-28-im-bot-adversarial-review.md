# IM 与 Bot 实现的深入研究及对抗审查

日期：2026-10-28（Asia/Shanghai）。范围仅限 IM Connector、IM 审批与任务调度、Bot 事件与执行器；不扩展到普通聊天或 Router + Fusion。

基于当前共享工作区，HEAD 为 `9ee9de76678140ff47f1cc8a77cde12a4cb91d8d`，同时存在其他任务的未提交修改。因此这里审查的是当前工作区行为，不是某个提交或 PR 的增量。未改产品代码、未发送真实 IM 消息、未调用真实模型。前置模式说明见 [Bot 模式实现研究](2026-10-28-bot-modes-implementation-research.md)。

## 结论

命名混乱之外，确认了 **10 项实现缺陷**。最需要先处理的是：跨执行器交接丢失权限上限、Bot 与 Workflow 之间的防循环断裂，以及 IM 审批没有把批准、具体版本和可靠启动绑定成一个完整过程。

| ID  | 优先级 | 问题                                              | 主要触发条件                                                 |
| --- | ------ | ------------------------------------------------- | ------------------------------------------------------------ |
| F01 | P1     | Team/Workflow 没有继承 IM Authority/Autonomy 上限 | 会话要求只读，目标 Team 自身允许 bypass                      |
| F02 | P1     | Bot Workflow executor 没有传递 Bot 权限上限       | plan/observe Bot 调用带 acceptEdits Agent node 的 Workflow   |
| F03 | P1     | Workflow 完成事件重置来源，Bot 可再次触发自己     | Workflow Bot 监听 workflow.succeeded 并启动会成功的 Workflow |
| F04 | P1     | IM 静音对 Team/Workflow 执行不生效                | 已静音 Adapter/会话仍收到匹配消息                            |
| F05 | P2     | 瞬时启动错误永久消耗 Workflow 审批                | 用户批准后、运行落库前发生暂时故障                           |
| F06 | P1     | 旧审批卡片会启动后来发布的新版本                  | V1 卡片等待期间生产部署更新为 V2                             |
| F07 | P2     | 排队轮次不复核后续静默/权限收紧                   | A 运行、B 排队，随后修改会话控制                             |
| F08 | P2     | Poll 与 event 使用不同的实际并发键                | 两种 trigger 声明同一个 concurrencyKey                       |
| F09 | P2     | coalesce: latest 只是声明，没有合并行为           | 同一资源在 debounce 窗口内连续产生事件                       |
| F10 | P2     | 同时绑定 IM 和 Integration 凭据会过滤所有事件     | 一次安装同时绑定 Adapter 与 integration account              |

P1 表示应优先修复的权限、错误授权或失控执行问题；P2 表示需要修复的可靠性、路由或调度问题。这里的优先级不代表已在线上观察到事故。

## 审查方法与反证要求

先补全消息、审批、事件、交接的调用链，再由两个独立上下文审查者分别检查 IM 与 Bot。审查者只接收源码范围与行为约束，没有接收上一轮研究的结论作为答案。主会话逐项检查反证并重跑关键复现。

本轮使用的约束是：

- 响应方式和工具权限应作用于实际执行，换一个执行器不能扩大调用方上限。
- 静音与 quiet hours 的生成端行为应符合 `policy-resolve.ts` 已写明的语义。
- 审批应约束被批准的具体工作，且一次瞬时基础设施故障不能令批准永久消失。
- Bot 自触发与深度限制必须跨 Workflow 边界延续。
- trigger 声明的来源过滤、并发、debounce/coalesce 必须在最终入队和执行时生效。

本轮没有把所有“看起来奇怪”的组合都判成 bug；文末记录了未计入缺陷的情况。

## F01：IM 权限上限没有进入 Team/Workflow

**触发与结果：** 会话设置 `authority: plan`，或 Adapter 设置 `defaultAuthority: plan`，但绑定的 Team 自身配置 `bypassPermissions`。实际 Team 的持久化 execution constraints 仍然是 `bypassPermissions`。`autonomy: confirm` 应产生的 `default` cap 也没有传进去。

**原因：** [deriveImPermissionCeiling](../../lib/connectors/im-permission-ceiling.ts#L25) 最终只返回 `disallowedTools`，没有把解析后的 Authority/Autonomy 转成 `permissionMode`。IM runtime 在 [建立 parent ceiling](../../lib/connectors/runtime.ts#L1642) 后直接启动 Team/Workflow；消费 composition 的代码在后面的 Direct 分支。Team [合并 parent 与自身策略](../../lib/ai/agent/team/squad/start-squad-run.ts#L375) 时收不到调用方 mode。

**证据：** `im-authority-ceiling.audit.test.ts` 使用真实 effective config、ceiling、IM Team wrapper、`startSquadRun`，只注入持久化与最终 lifecycle。conversation-plan、adapter-plan、confirm 三种场景，目标持久化 mode 均为 bypass。另 runtime 边界复现确认 Team 和 Workflow 的实参都缺少 `permissionMode: plan`。

**排除的解释：** 模型由 target 管理是已有设计；Authority 没有标为 target-managed，ADR-0117 也要求子执行只能收紧权限。Team 的默认询问模式只在合并结果未设置 mode 时补齐，不能限制目标显式 bypass。

**修复方向：** 在目标分支之前把最终 Authority/Autonomy 的 cap 纳入同一个 `AgentPermissionCeiling`，然后让现有收紧规则继续合并。无需再建一套权限系统。

## F02：Bot Workflow executor 同样丢失权限上限

**触发与结果：** Bot 的策略为 `maxAuthority: plan`、`maxAutonomy: observe`，其目标 Workflow 含 `permissionCap: acceptEdits` 的 Agent node。真实 Workflow 调度仍进入该 node，最终执行服务收到的 parent ceiling 为 `undefined`，而 capability grant 带 `acceptEdits`。

**原因：** [Workflow executor](../../lib/bot/runtime/executors/workflow.ts#L75) 没有向 Execution Authority 传 `securityContext.permissionCeiling` 或对应 composition 约束。Authority 的 [默认 securityContext](../../lib/workflow/runtime/execution-authority.ts#L286) 不会依据 `caller: bot:...` 找回 Bot policy；[Agent node](../../lib/workflow/nodes/actions/agent-turn.ts#L212) 因而收到空上限。Bot run 虽然解析了 policy/composition，执行器没有消费它们。

**证据：** `bot-review/repro.test.ts` 最后一个探针经过真实 Workflow 创建、发布、admission、orchestration 和 node 调度。只替换环境 capability preflight、标题生成与最终 Agent 服务，不访问模型或网络。Workflow 自身的 `riskGating` 在复现中显式关闭，以验证它不能替代父权限上限。

**范围：** Bot Squad executor 也没有向 start primitive 传 permission ceiling，是相邻待一并检查的缺口；本项已经实际复现的是 Workflow → Agent node 链路，不把 Squad 的全部后果算作已验证。

**修复方向：** 将 Bot policy/composition 的结果通过现有安全上下文传给 Workflow，再由各 node 继续收紧；`observe` 等禁止执行的参与语义还需在交接前落地。

## F03：Bot → Workflow → Bot 可以绕过防循环

**触发与结果：** 一个 Workflow Bot 监听 `workflow.succeeded`，并启动有匹配 integration trigger 的已发布 Workflow。该 Workflow 完成后，同一安装再次收到事件，尽管 `allowSelfTriggering: false`。本地实际连续运行四轮，产生四个不同 Workflow run；每轮后继事件都声称 `{selfProduced: false, depth: 0}`。

**原因：** [Workflow completion 投影](../../lib/bot/sources/workflow-completed.ts#L50) 无条件使用 `externalProvenance()`，而 [completion fan-out](../../lib/workflow/runtime/workflow-completion-fanout.ts#L90) 没有把原始 Bot 因果来源传下去。Workflow 自己的 `chainDepthOf()` 只识别 `trigger.workflow.completed`，Bot executor 使用的却是 `trigger.integration.event`，所以该保护也不会积累深度。每轮新的 runId 又产生新的 eventId，正常去重无法拦截。

**证据：** `bot-review/repro.test.ts` 倒数第二个探针通过真实已发布 Workflow、默认 Bot executor、execution authority、orchestrator、completion fan-out、router、Dexie queue。四轮超过 Bot depth cap 3，但始终允许继续入队。Workflow 仅含本地 trigger，未执行真实外部动作；复现结束后主动 disable 安装。

**排除的解释：** Workflow 直接订阅自己的完成事件确实会被保护；这里绕经 Bot，因此不是同一条路径。普通外部 Workflow 完成事件可视为 external，但由 Bot 自己启动的运行不能丢掉已知来源。

**修复方向：** 从 Bot 调用开始持久携带因果来源与 generation depth，在 Workflow completion 端延续它，再复用已有 Bot loop guard。

## F04：静音只阻止 Direct，Team/Workflow 仍执行

**触发与结果：** Adapter 已 `muted: true`，同一消息在 Direct 不调用模型，但切到 Team/Workflow 后仍调用对应 launcher。即使最终投递被静音延迟，也已经启动了计算和工具执行。

**原因：** [Team 分支](../../lib/connectors/runtime.ts#L1704) 和 [Workflow 分支](../../lib/connectors/runtime.ts#L1796) 位于 Direct 的 suppression gate 之前，并在启动后 `break`。目标 launcher 不另读 IM 静音策略。[静音语义](../../lib/connectors/policy-resolve.ts#L135) 明确要求生成端也受约束。

**证据：** `im-runtime.audit.test.ts` 两个“muted 不应启动”的断言失败，Direct 控制断言通过。会话级 mute 与 quiet hours 共享相同缺失边界，已有调用链支持该判断；本轮没有为每一种 quiet window 单独运行时区矩阵。

**修复方向：** 在各目标 dispatch 前统一执行生成端 suppression，并记录实际来源。独立 Workflow/Bot 订阅是否服从同一个 mute 则需单独明确，不应偷偷把静默等同于全局暂停。

## F05：瞬时启动失败会永久消耗审批

**触发与结果：** 用户点 Approve 后，Workflow 的部署查询或持久化在创建 run 前暂时失败。该卡片的 Approve/Cancel 已被消费；相同 callback 重投被去重，新点击则被 `binding_consumed` 拒绝。运行数仍为零。

**原因：** [bus 在 dispatch 前 consume](../../lib/connectors/bus.ts#L3079)，审批处理失败后 [仍返回 terminal](../../lib/connectors/bus.ts#L3254)。没有持久化待启动的已批准任务，也没有可恢复状态。

**证据：** `im-approval-failure.audit.test.ts` 使用真实 bus、默认 enforce authorization、callback binding DB。只令 `startWorkflowFromIM` 第一次暂时失败，随后已经可成功，但无论平台重投还是用户重试都不再调用启动。观测为两行 consumed、callback recorded、仅一次 startup attempt、零 Workflow run。

**排除的解释：** 原子消费确实阻止重复批准，不应简单删除。消费前 binding 查询的 retry 分支不能覆盖消费后的错误。

**修复方向：** 以可靠状态机或 outbox 持久化“已批准、待启动”的意图，并绑定幂等运行；不能只回滚消费而允许重复副作用。

## F06：批准旧卡片，执行的是后来发布的新版本

**触发与结果：** 发布 V1 → 创建审批卡 → 发布 V2 → 批准原卡片。实际 `workflowRuns.versionId` 指向 V2。

**原因：** [held payload](../../lib/connectors/hitl/workflow-run-approval.ts#L169) 只冻结 workflowId、名称、参数和权限 ceiling，没有 deployment/version lock。[点击启动](../../lib/a2ui/workflow-approval-handler.ts#L143) 又按 workflowId 解析当时的生产指针。虽然运行开始后 artifact 是固定的，但固定时间晚于批准对象的展示。

**证据：** `im-approval-version.audit.test.ts` 使用真实创建、两次发布、hold、批准及 Workflow run 落库；要求原版本的断言得到第二个 versionId 而失败。

**修复方向：** 创建卡片时冻结已发布的版本及依赖 lock，并展示该版本；点击时使用现有 locked dependency 接口执行，或版本变化后重新请求确认。

## F07：出队时不复核静默和权限收紧

**触发与结果：** A 运行、B 已入 FIFO；随后用户把会话切为 silent/human/plan。B 真正执行时仍收到旧 `ai-run` 和旧权限行。切换后新收到的 C 正确变成 `manual-store`，所以不是写入没有生效。

**原因：** [FIFO 闭包](../../lib/connectors/bus.ts#L1526) 捕获入队时的 decision/resolved/override/adapterRow。runtime 复用这些快照，`beforeSend` 只检查源消息更改，不重新检查控制策略。UI 的 best-effort interrupt 也不会改掉队列闭包。

**证据：** `im-queue.audit.test.ts` 挂起 A，入队 B，写入 silent/plan，再入队 C，释放 A。C 为 manual-store/plan，B 仍是 ai-run/undefined。

**排除的解释：** 模型调用开始后冻结 composition 是合理的；B 尚未开始调用，不能把这一原则当成无视后续收紧的理由。若产品希望已接纳任务始终使用旧配置，至少应明确提供“取消排队工作”的控制。

**修复方向：** 保留任务身份与必要输入快照，但在实际 dispatch 前重新核验禁用、静音、授权撤回等安全门槛，只能收紧已接纳的上限。

## F08：定时与事件触发的并发键不一致

**触发与结果：** event 与 poll 都声明 `github-monitor`，实际分别落库为 `installation::github-monitor` 与 `installation::poll`；两行可同时成功 claim。

**原因：** [scheduler Bot executor](../../lib/scheduler/executors/bot-executor.ts#L125) 用 trigger.id 替换配置的 key，而 [事件 router](../../lib/bot/events/router.ts#L176) 使用实际模板插值。队列的原子互斥正确，但作用在两个不同 key 上。

**证据：** `bot-review/repro.test.ts` 第二个探针真实调用 timed executor、事件 dispatch、Dexie claim。实际第一方 GitHub Devin/Comment Bot 的 webhook 与 poll 声明了共享 key，配置不是假想输入。下游幂等可能减少重复外部写入，不能恢复对 cursor/state 的互斥。

**修复方向：** 两个 producer 使用同一套 key 投影，并一致传递等待时是否占并发槽等字段。

## F09：latest coalescing 未实现

**触发与结果：** debounce 窗口内连续入队两个同资源事件，窗口结束后 handler 执行两次。

**原因：** [router](../../lib/bot/events/router.ts#L190) 只给每个事件分别加 `notBefore`，dispatch/queue/runner 没有读取并兑现 `coalesce: latest`。串行运行不等于合并事件。

**证据：** `bot-review/repro.test.ts` 第四个探针观察到 handler 两次执行。第一方 [PagerDuty Bot](../../plugins/pagerduty/src/index.ts#L692) 明确声明 15 秒合并及每 incident 一次 triage，因此这会带来多轮分析、审批和可能的 notes 写入，而不只是一个无消费者的类型字段。

**修复方向：** 定义合并作用域和已运行事件的边界，再在入队事务中替代同窗口未开始的旧工作；不能仅延后所有事件。

## F10：混合凭据绑定造成双向失配

**触发与结果：** 合法安装同时绑定 GitHub integration account 与 Slack Adapter。GitHub 事件缺少 adapterId，Slack 事件缺少 integrationAccountId，两种来源都得到零 delivery。

**原因：** [bindingsForInstalledBot](../../lib/bot/events/dispatch.ts#L71) 给每个 trigger 同时附上两种 account constraint；[triggerMatches](../../lib/bot/events/router.ts#L71) 在区分来源之前强制同时匹配两个 ID。

**证据：** research 与独立 reviewer 各自通过真实 installation/dispatch/Dexie 复现。SDK 类型和安装层接受这一组合；本轮没有找到现成第一方 Bot 同时声明这两种凭据，因此明确限定影响为该合法混合配置。

**修复方向：** 根据 event source 区分输入身份与输出凭据；长期需要 trigger 明确引用所使用的 slot，避免“第一个 credential”决定全部来源过滤。

## 已刻画但没有直接计入 10 项缺陷的情况

- **同 installation/event 匹配多个 trigger：** router 返回两个命中，但 [deliveryId](../../lib/bot/events/router.ts#L149) 与 [dedupKey](../../lib/db/bot-event-deliveries.ts#L155) 都不含 triggerId，最终仅保留第一行。真实复现返回两个相同的 triggerId，DB 只有一行。router 测试承诺多 delivery，而 queue 契约强调 event × installation 去重，二者需要统一。应先明确是“每 trigger 各运行”还是“多条件合成一次”，不应直接扩大 fan-out 制造重复副作用。
- **Disarm 后已入队工作仍执行：** 已复现，但 disarm 可能只表示停止未来 intake。若要同时取消 pending/parked/running，需要明确产品动作；本轮不直接判为取消缺陷。
- **静默主回复仍允许独立 Bot/Workflow 订阅：** 当前 bus 显式将它们作为观察者；除非产品承诺“停止所有自动化”，不能单凭这个现象认定越权。
- **草稿的三种确认对象不同：** Direct 回复、Team 计划、Workflow 启动是现有明确设计；文案应准确区分，但本轮没有把差异本身算成运行时缺陷。
- **lease、claim、审批本身并非全部失效：** 原子 claim 会检查并发、有效 lease 与 maxConcurrent；终态写前有 ownership fence；Bot 审批有内容漂移和 deadline 校验；镜像记录有执行 fence。这些保护的存在已检查，没有把局部缺陷扩大成整体失效结论。

## 验证与本地证据

所有诊断文件位于 [本地证据目录](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/)。缓存中的契约失败是审查复现，不是提交到正式测试树的回归；没有削弱、删除或修改现有测试。

| 检查                      | 实际结果                           | 如何理解                                                                         |
| ------------------------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| 当前已有 focused Jest     | 11 suites / 349 tests 通过         | 原有测试没有覆盖本轮发现的组合边界                                               |
| IM 契约与控制探针         | 4 suites / 8 tests：6 失败、2 通过 | 失败分别证实 mute、权限、版本和排队问题；通过含 Direct 控制与审批错误刻画        |
| IM Authority 完整交接探针 | 1 suite / 3 tests 通过             | 断言当前错误行为，三种限制均落为目标 bypass                                      |
| Bot 独立复现              | 1 suite / 7 tests 通过             | 刻画实际缺陷及一项尚待明确的 disarm 语义；包括真实本地 Workflow 四轮链与权限交接 |
| Bot research 契约探针     | 1 suite / 5 tests 失败             | 与独立复现交叉验证；不是“修复后的测试通过”                                       |

执行入口均为仓库 `pnpm test`。可复跑：

```sh
pnpm test --config .cache/diagnostics/im-bot-adversarial-2026-10-28/jest.audit.config.ts --runInBand
pnpm test --config .cache/diagnostics/im-bot-adversarial-2026-10-28/bot-review/jest.config.ts --runInBand
pnpm test --config .cache/diagnostics/im-bot-adversarial-2026-10-28/bot-research/jest.config.ts --runInBand
```

关键记录：

- [已有测试结果](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/existing-focused-results.json)
- [IM 复现结果](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/im-repro-results.json)、[日志](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/im-repro.log)
- [IM Authority 结果](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/im-authority-results.json)
- [Bot 独立复现源码](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/bot-review/repro.test.ts)、[结果](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/bot-review/results.json)
- [Bot research 契约](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/bot-research/contracts.test.ts)、[日志](../../.cache/diagnostics/im-bot-adversarial-2026-10-28/bot-research/repro.log)

没有运行全仓 build、typecheck、lint 或真实平台 E2E，因为本次未修改产品源码；文档单独做格式和 diff 检查。外部跨模型审查已作为可选项提出，本报告未把它算作已执行验证。下一步应先为 F01/F02/F03 固化正式回归测试与最小修复，再处理 IM 审批的持久化/版本边界，最后修复路由与合并策略。
