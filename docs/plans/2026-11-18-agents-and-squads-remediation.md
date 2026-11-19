# Cognia Agents 与 Squads 修复及补测方案

| 项目     | 内容                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态     | 待评审                                                                                                                                                                                                                   |
| 日期     | 2026-11-18（Asia/Shanghai）                                                                                                                                                                                              |
| 基线     | `8991a9d7be3b`，含共享工作树中已核对的相关调用点                                                                                                                                                                         |
| 范围     | F01–F12、T01–T14，涉及聊天、Squads、Workflow、执行账本、Room、CLI、CI 和跨端验收                                                                                                                                         |
| 评审角色 | Squads / Workflow Runtime、执行账本、Host 安全与 Companion、Agents 客户端与 CLI、测试基础设施、产品与评测                                                                                                                |
| 证据     | [能力审计及覆盖复查](../evidence/2026-11-18-agents-and-squads-gap-audit.md)、[多 Agent 收敛计划](2026-11-05-multi-agent-convergence.md)、[Handoff 与派发审计](../evidence/2026-11-17-handoff-task-dispatch-gap-audit.md) |

## 1. 先恢复验证能力，再修高风险运行行为

先修生命周期 fixture、发布审批样本、异步退出和浏览器初始化。随后在 Host 边界修任务授权、取消、预算和审批，在持久运行链路修结果回传及改令回执。已有 Agent Mode、Squad、Room、Delegation、Workflow 和 outbox 各自承担原有职责。

两类结果共同定义完成。每一项 F 都有产品行为和可观察结果，每一项 T 都有归属层和验收命令。对真实跨端能力的结论以实际 Tauri、Capacitor、Host/Worker 及适用引擎的验收记录为准。本文交付评审方案。

**当前依据。** 复查基线相对覆盖采样基线，核心实现没有相关提交变动，个人 egress 站点目录有其他改动。已核对 worktree 中相关入口。实施每个工作包前重新检查对应 diff。2026-11-18 的历史采样为 37 个 Jest 套件、657 个测试通过，22 个文件的行/分支/函数覆盖率为 87.36% / 80.80% / 84.75%。完整生命周期套件单独诊断。方案编制时重新执行 Playwright discovery，目标 5 个 spec 仍发现 15 例，同路径按 PR 标签筛选为 0 例。覆盖率和线上故障频次沿用各自已记录的证据范围。

### 阶段与交付顺序

| 阶段                            | 事项                              | 前置关系                                                                                                              | 阶段出口                                                                                                    |
| ------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **阶段 0 · 恢复验证基线**       | T08、T09、T10、T13                | T08 先于 T09 的完整重测。T10 可同步调查，T13 独立。                                                                   | 完整 lifecycle suite 的每例有可解释结果并能自然退出。当前静态导出的 Chromium 控台至少一条业务路径跑通。     |
| **阶段 1 · 守住任务和预算**     | F01–F04、T01–T03                  | F01 与 F02 可分开交付。F03 与 F04 共用恢复合同，先定预算状态和暂停原因的接口。                                        | 权限拒绝和取消赢得竞态时无副作用。审批继续调度，同一 run 的已用量和获批额度在重启后连续。                   |
| **阶段 2 · 恢复交付与跨端控制** | F05、F06、T04、T05、T11、T12、T14 | F05、F06 可分开验证。T12 依赖阶段 0 的 E2E 入口与相应产品修复。T11 在代表性用例稳定后启用。T14 随受影响路径逐项验收。 | Room 回传按 attempt 幂等，改令呈现真实结果。Chromium、Pixel 7 纳入 PR，真实设备和 Host 对应声明有验收证据。 |
| **阶段 3 · 让选择与执行一致**   | F07、F08、F10、F11、T06、T07      | F07 先形成有效执行计划的读取接口，F11 复用。F08 和 F10 可独立进入。                                                   | 显式 Agent 不可用时有诊断。复核一轮一次。单 Agent 路由能实际绕过建队。桌面和 CLI 能验证受支持的配置互通。   |
| **阶段 4 · 补齐成员协作与评估** | F09、F12                          | F09 依赖 F01、F02、F06 的权限、认领与回执规则。F12 可先准备数据，默认策略评审依赖阶段 3、4 的测量。                   | 成员消息可确认、任务认领有原子证据。发布可复查的对照结果与默认策略决策。                                    |

阶段 0 的测试修复与后续产品修复分开提交。测试隔离完成前，可以先写局部复现。发布阶段 1、2 需满足对应的早期测试门槛。各受影响平台在发布前逐一匹配本方案的适用范围。

### 事实源与边界

| 数据与操作                       | 权威所有者                                                                                             | 读取与显示                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Squad 任务、归属与认领           | Host 范围内的持久任务记录及 Squad coordinator，受账号、工作区和运行 attempt 约束                       | 看板、Workflow、Companion、团队工具      |
| 子运行身份、预算、批准和停机证明 | `executionRuns`、run-tree ledger、durable child、interrupt 与 receipt。Host 核对父子授权和 worker 证据 | Agent Runs、聊天控制卡、CLI、配对端      |
| Room 任务交付                    | Squad attempt 的持久终态及精确关联的结果。Background Tasks outbox 负责排队和投递                       | Room、原始提案与委派卡                   |
| Agent 有效配置                   | Host 依照目标、授予范围和引擎能力解析出的执行计划                                                      | Composer、Agent Mode、CLI 预览与运行详情 |
| 多 Agent 质量                    | 冻结输入、预算、轨迹和输出的评测运行                                                                   | 版本化评测报告与路由决策                 |

## 2. 阶段 0 · 先让既有测试触及真实行为

### T08 · 修复生命周期工作区租约 fixture

- **根因已复现。** `AgentTeamRegistryWorkspaceController` 的假实现缺少必填 `additionalAliases`。派发在读取该字段时失败，executor 调用数为 0。隔离副本补字段后，四个原失败用例通过。[生命周期测试](../../lib/squads/agent-team-runtime.test.ts#L52) · [派发消费](../../lib/squads/teammate/dispatch-teammate.ts#L2046)
- **改动范围。** 在现有套件复用或扩充类型化 lease fixture，按生产返回类型校验完整形状。补单根和多根两类工作区，不对生产派发加入针对测试的兼容逻辑。
- **验收。** 原四例保持完成及依赖断言并全部通过。多根用例断言附加 alias 被传到实际派发请求。测试 fixture 缺少必填字段时，类型检查失败。

### T09 · 让发布审批测试具备真实来源与授权

- **已知现象。** 修正租约后的隔离套件中，四例得到 `delivery_failed`，预期 `delivery_awaiting_approval`。一例 PAT 发布被 `PersonalSinkWithheldError` 拒绝。PAT 直接失败发生在个人数据出站门禁。四例是否同源仍待诊断。[发布审批测试](../../lib/squads/agent-team-runtime.test.ts#L378) · [个人可见性](../../lib/execution/personal-visibility.ts)
- **改动范围。** 对五例分别记录首个实际拒绝、身份和出站状态。用测试账号、批准收据、来源标记和发布目标构造合法场景。改动首先落在 fixture 和断言，证实产品分支错误时才修改持久运行或发布桥。保留 ADR-0243 的授权、个人内容可见性和凭证边界。
- **验收。** 合法路径进入等待审批，获批后恰好调用一次假的发布端口。拒绝、失败、取消及批准与取消竞争各有可观察的终态。加入一例未获相应披露授权时拒绝且发布调用为 0。原五例得到可解释结论，合法样本通过且隐私负向断言生效。

### T10 · 让 lifecycle suite 自行退出

- **根因仍待定位。** 已观察到失败汇总后 Jest 仍存活。具体持有句柄的 timer、listener、待结算 Promise 或 DB 连接尚未证实。[测试清理](../../lib/squads/agent-team-runtime.test.ts#L332)
- **改动范围。** 先用单例、`--detectOpenHandles`、未完成任务清单或 `async_hooks` 缩小持有者，沿 setup/teardown、审批 watcher、runtime 注册及 fixture 关闭追踪。修复拥有者的 dispose/abort，并补完成、失败、取消三条清理检查。
- **验收。** 原套件正常运行连续三次，自然退出并有完整测试汇总。诊断捕获的句柄随 owner 解绑。退出验证使用原 runner 和现有超时，`--forceExit` 仅用于定位期间保留失败日志。

### T13 · 修复 Chromium IndexedDB 初始化阻塞

- **已知现象。** 当前 dev smoke 的路由已返回 200，seed 超时伴随 Dexie upgrade/delete blocked 与 `DatabaseClosedError)。持有旧连接的具体组件或窗口仍待定位。[DB reset helper](../../tests/e2e/helpers/db-reset.ts#L386) · [Squad seed](../../tests/e2e/agent-runs/squad-run-controls.spec.ts#L46)
- **改动范围。** 对照当前源码与新鲜静态导出，记录账号分区、test bridge、开库连接代次和 reset 顺序。使用已有测试上下文及 fixture，验证关闭旧连接或初始化等待屏障。若真实切换账号也会触发，修复 DB 生命周期的拥有者并加低层回归。
- **验收。** 用当前源码生成的 E2E 静态导出跑目标 spec，默认预算内稳定越过 seed、看到就绪阻塞及控台/审批业务断言。三次独立 browser context 均通过，无重试后才通过、无任意 sleep，失败附 trace 和连接状态。

## 3. 阶段 1 · Host 准入、取消和审批有一致结果

### F01 · 用 Host 身份约束团队任务工具的读写

- **根因由源码确认。** 调用者已绑定到 Squad，任务读写依旧按裸 task ID 查找。读取另有来源过滤，缺来源时会遮蔽任务文本。Companion 评论入口已有独立归属检查。[任务工具](../../lib/squads/collaboration-tools.ts#L584) · [Companion 校验](../../lib/companion/agent-team-write-handlers.ts#L151)
- **改动范围。** 复用 Host 的账号分区、工作区和队伍归属校验，在工具获取及写入任务前同时核对可信 caller、目标归属与活动权限。评论检查与追加使用同一权威操作，避免两步竞态。读取仍经过个人可见性与 PII 门禁。缺少可信来源时保持遮蔽。对无权限、目标不存在使用相同对外响应。
- **验收。** 合法同队请求仅访问被授权资料。拒绝样本不能追加评论、产生通知或得到可区分的目标命中状态。成员撤销与评论竞争时，失效身份不能写入。Companion 路径继续用同一归属合同。由 T02 验证。

### T02 · 在真实工具边界验证同队规则

- **根因。** 测试注入 task getter/comment sink，个人可见性 mock 通常返回原数据，断言主要覆盖作者和输出形状。[协作工具测试](../../lib/squads/collaboration-tools.test.ts#L637)
- **改动范围。** 扩 co-located tests，以受控 Host 会话绑定、真实任务 store/持久层、两支合成 Squad 和实际读取过滤构造权限矩阵。Companion 入口加对应合同测试，运行中撤销用确定性屏障演练。
- **验收。** 同队已授权读写、同队缺可信来源、跨队、跨工作区、撤销、新旧快照竞态各有断言。越界响应同不可见对象，检查持久任务、评论、通知和外部执行计数。首次回归在旧实现上失败于预期的归属条件。

### F02 · 取消和任务准入在 Host 上互斥

- **根因已局部复现。** 普通 flat 启动使用任务快照，编译和派发缺取消的统一准入条件。恢复路径已有独立状态过滤。[任务读取](../../lib/squads/agent-team-runtime.ts#L398) · [任务派发](../../lib/squads/workflow-nodes/index.ts#L191) · [恢复过滤](../../lib/squads/squad/squad-lifecycle-runner.ts#L118)
- **改动范围。** 在编译时排除已取消任务，派发前以持久任务行和当前 run/attempt 的条件更新抢占准入。Host 上的 board cancel 与 claim 使用同一权威边界，Zustand 看板投影只展示已确认的结果。取消赢得条件更新时标记节点为取消/跳过，必需依赖取消的后续任务显示确定的阻塞原因。已 claim 的任务按现有 stop 与 worker 证明流程控制。
- **验收。** flat、wave 和适用的恢复路径均无取消后新租约、模型调用、工具副作用或完成态覆盖。对必须依赖的数据，只在上游成功或有可信持久输出时放行。已开始任务的停止状态按实际证明更新，相关 UI 不伪造确认。全部任务已取消时说明无可运行任务，模型和工作区调用均为 0。由 T01 验证。

### T01 · 用可控调度屏障证明取消胜出

- **根因。** move guard 与 DAG 生成分别通过，现有 lifecycle filter 测试只注入 completed 过滤器。[move guard 测试](../../lib/squads/gates/task-move-guard.test.ts#L24) · [lifecycle filter 测试](../../lib/squads/agent-team-runtime.test.ts#L1169)
- **改动范围。** 在生命周期与派发测试中保留实际 store、调度 worker 和持久准入，仅替换模型及工作区副作用端口。覆盖启动前取消、DAG 后取消、claim 先赢、取消与恢复/重试竞争及依赖传播。在 T12 增一条薄 Chromium 看板验证。
- **验收。** 两个取消先赢的用例在旧版本有派发证据，在新版本副作用计数为 0。claim 先赢只产生一次 attempt，停机走同一入口。依赖任务不执行，独立 sibling 可完成。

### F03 · 持久预算是同一 run 的事实源

- **根因已确认。** Governance 保存的额度与阈值未由当前 governor 消费。进程内用量及扩额在同一 run 重建时清空。已有 run-tree ledger，为本计划的预算准入权威。[Squad runtime](../../lib/squads/agent-team-runtime.ts#L825) · [Governance 输入](../../components/squads/settings/section-governance.tsx#L227) · [Run ledger](../../lib/execution/run-ledger.ts)
- **改动范围。** 用一个预算 resolver 读取新旧 config、验证单位与阈值，并把开始时的有效设置绑定到 run。令 Squad 自身限额成为共享 run ledger 内的 root limit 或父预算下的 hold，审批状态使用已存在的 interrupt/receipt。用审批唯一 ID、run ID 与版本进行幂等扩额，补齐 ledger 受控扩额能力时保留原父预算、当前授予与 stop-proof 边界。governor 从持久使用量和额度派生告警，不重复计费。旧 run 缺少可信用量时显示待校对状态，确认前阻止无证据的自动续跑。人工明确发起的新 run 只有在旧 attempt 通过安全检查后，才按现有的新运行预算语义启动。
- **验收。** 保存的 cap 和阈值实际生效。并发预留不超出父预算。同一 run 的重启及重复批准不重置用量或重复扩额。未知用量和 stop 未证实遵循已有保守结算。冲突旧配置遵守 Q1。由 T03 验证。

### F04 · 把等待审批与容量置零独立表示

- **根因已局部复现。** gate 用 `reduceTo(0)` 冻结，controller 只允许下调。审批回调只扩额或解封。普通调度器见零在途与待执行节点可判定停滞。[死锁 gate](../../lib/squads/gates/deadlock-gate.ts#L83) · [并发控制](../../lib/workflow/runtime/concurrency-controller.ts) · [调度循环](../../lib/workflow/runtime/orchestrator.ts#L1052)
- **改动范围。** 使用现有 durable interrupt 表达等待原因，调度器等待对应状态变化。暂停期间的可用并发与限流后的容量分别计算。获批只解除对应 gate 的等待。操作员暂停、其他未决审批、停止与旧 epoch 优先。续跑按持久决策在当前 attempt 重建等待，节点不可推进且没有合法等待原因时仍报真实停滞。
- **验收。** 存在待执行节点时，批准扩额或解封使下一节点执行，已有完成节点保持一次。拒绝、停机、过期或旧 attempt 批准无新调度。多个 gate 并发时只解除指定 gate，取消可终止等待。由 T03 验证。

### T03 · 验证预算批准真的恢复调度

- **根因。** 现有设置、预算、死锁与恢复测试只覆盖各自的回调或状态。真实 scheduler、已用额度和 approved amount 没有同一断言。[预算单测](../../lib/squads/gates/budget-guard.test.ts#L188) · [恢复审批测试](../../lib/squads/durable/recover-squad-runs.test.ts#L114)
- **改动范围。** 增加 settings→snapshot→ledger 测试，并在 lifecycle/workflow 集成测试挂接真实 governor、scheduler 和持久中断。使用固定时钟、可控模型用量与运行录像式断点，验证批准前、批准后、重启回放、并发重复和过期情况。
- **验收。** 首次回归复现零并发与额度重置。修复后批准前无后续调度，批准后满足剩余额度的任务完成。单一批准应用一次，父上限遵守。限额不足、拒绝、暂停或停止时没有新调用。无需由 UI E2E 穷举预算状态。

## 4. 阶段 2 · 每次交付和改令都有可核对的收据

### F05 · 按 Squad attempt 持久化并恢复 Room 回传

- **根因由源码确认。** 当前进程用 Promise watcher 写 outbox，启动只读取已写入记录。补建函数未接生产启动，恢复结果还取 Squad 的最新摘要并按时间猜测归属。[结算与补建](../../lib/squads/room-handoff/settle.ts#L118) · [Room 投递启动](../../lib/background-tasks/runtime-room-lane.ts#L28)
- **改动范围。** 用现有 run 所属持久记录保存可授权读取的精确结果引用。若 Workflow run 的输出不能证明同一 attempt，先补可兼容的 attempt 结果字段，再接入恢复投递。初次运行和恢复运行均在 Host 持久终态路径发出结算，Squad bootstrap 在 vault/账号就绪后启动可重复的补建扫描。扫描和 live settle 共用 attempt 唯一键，缺失或失败的 outbox 写入可重试。依赖方向由 Squads 调用已公开的 Background Tasks 端口。若消费者尚未注册，持久 pending 由 lane 启动重新发现。手机只投影 Host 结果。
- **验收。** 在终态写入前后、outbox 插入后及消费者确认前分别中断，重启最终只投递一次与该 attempt 一致的结果。两个 attempt 短间隔结束时互不串文本。对终态前中断的 attempt，先验证原运行可安全恢复。停机或结果不可证实时保持相应的待恢复状态。旧数据无可信结果时展示终态和运行链接。取消、撤权、切换账号或房间无合法 receiver 时按既有授权语义处理，取消不唤醒重新执行。由 T04、T12、T14 验证。

### T04 · 用生产启动入口验收补投

- **根因。** `reconcileRoomHandoffs` 单测手动调用函数，Room 启动测试预置 outbox。历史用例的终态相隔较久，无法发现时间近邻误关联。[补建测试](../../lib/squads/room-handoff/settle.test.ts#L147) · [启动测试](../../lib/background-tasks/runtime-room-lane.test.ts#L49)
- **改动范围。** 覆盖 Squads bootstrap、terminal hook、Background Tasks lane 和测试数据库。加入双启动、写入失败后重试、重启后才终态、两个近时间 attempt、旧数据无结果及取消/撤权。不用注入调用直接唤醒补建函数。
- **验收。** 业务入口可检出「终态已落盘、outbox 缺失」并向正确 Room 投递一次。结果引用、attempt、Room 及授权一致，重复启动、重新订阅或重新确认产生 0 条额外消息。

### F06 · 将已排队与已送达保留到调用端

- **根因由源码确认。** durable fan-out 返回候选数和 receipt IDs，丢失单条 receipt 状态，上层按候选数判断 delivered。Delegation 聚合也把子级 queued 当作已接收并归并为 delivered。[控制聚合](../../lib/squads/durable/durable-control.ts#L493) · [Run 队伍路由](../../lib/execution/control-handlers.ts#L114) · [委派聚合](../../lib/execution/steer.ts#L175)
- **改动范围。** 用现有 coordinator receipt 作为记录。内部区分 `queued`、`delivered`、`rejected`，聚合表述全部送达、全部排队、部分接受与零接受。保留逐子 run/attempt 的去重身份，由 Host 在原有命令重放边界统一处理。同一请求已落盘时，聊天、Run 控台和 Room 卡片读取该收据及后续状态，不再创建另一路重试。协议采用兼容的可选汇总字段，旧端语义见 Q2。
- **验收。** 全拒绝明确失败，UI 保留用户输入。已排队显示待送达，状态经 receipt 更新后转为已送达。部分接受明确显示接受范围。重复 RPC、重连和 attempt 替换不会产生第二条提交或将旧指令送给无权执行者。由 T05、T14 验证。

### T05 · 覆盖每种收据及客户端重试

- **根因。** durable 单测覆盖一拒绝一成功，上层测试覆盖正回执及候选为零。缺候选大于零全部拒绝，也缺已排队与送达的 UI 区别。[durable 测试](../../lib/squads/durable/durable-control.test.ts#L268) · [控制处理器测试](../../lib/execution/control-handlers.test.ts#L994)
- **改动范围。** 增加 coordinator + RunControl 集成及聊天/控台组件断言。使用受控 Worker 模拟全拒绝、混合、全部排队、即时送达、断线再送、回执写入失败与旧端版本。
- **验收。** 每种状态都能断言持久行和 UI 文案。对同一 command ID 重试只生成原来的有效收据。调用被拒绝时本地不会进入 accepted，也不会静默丢弃手动重试途径。

### T12 · 给 Workflow、Room 与 Companion 端到端路径补业务结果

- **根因。** 控台使用播种运行，`action.team.run` spec 断言编辑器持久化，移动用例拦截 Host RPC 并合成状态。三者已有覆盖的 UI 与传输合同各有价值。[控台 spec](../../tests/e2e/agent-runs/squad-run-controls.spec.ts) · [Workflow 节点 spec](../../tests/e2e/workflows/nodes/action-team/run.spec.ts) · [移动端 spec](../../tests/e2e/mobile/squad-remote-start.spec.ts)
- **改动范围。** 保留现有用例并扩展三条实际业务链。Chromium 从看板动作验证取消后节点不再进入队列，并提供 Run/Room 回传入口的用户可见断言。Workflow 节点复用真实 `startSquadRun` 入口，在 Host-capable integration harness 跑确定性 executor 并检查结果。Pixel 7 的 RPC 夹具断言排队/送达和无重复请求。真实 Worker 停机由 T14 验收。
- **验收。** 三条路径都使用实际入口，并断言运行 ID、状态、结果或错误。Workflow 对应一次真实持久启动与终态。浏览器断言能发现任务取消后继续工作或结果不回传。Pixel 7 的失败注入能捕捉回执误报或重复 RPC。

### T11 · 让代表性 E2E 真正进入 PR 调度

- **根因已重新核对。** 同一路径的 15 个 Playwright 用例缺少当前 PR 选择标签，无一被选中。[PR filter](../../.github/workflows/test.yml#L1146)
- **改动范围。** 完成 T12、T13 后，按已有标签约定各选至少一条 Chromium、Pixel 7 的高价值业务路径标记 `@critical`。优先选取消/终态及权限/回执链路。现有 PR 过滤机制直接消费。
- **验收。** 使用与 PR 相同的 project 和 grep 发现清单，两个 project 都至少选中一条对应契约。当前静态导出环境和实际 PR job 均通过，治理审计通过。首次失败后重试通过仍按现有 flaky gate 处理。

### T14 · 用真实 Host/Worker 证明停机、恢复、权限和交付

- **根因。** 现有 Jest、浏览器及 viewport 证据未穿透真实 Worker、原生传输、provider 和跨设备租约。[远程停止原则](../content/docs/en/adr/0244-a-remote-run-has-stopped-only-when-its-worker-says-so.md) · [Dual-Host 配置](../../playwright.dual-host.config.ts)
- **改动范围。** 复用现有 Tauri、dual-host 流程和一次性账户/工作区。最小矩阵为真实 Tauri ↔ Worker、真实 Android 和 iOS 的拟发布 Companion ↔ Host 组合、desktop/brain 的 Room handoff。覆盖本地/远端 Worker、断线/租约到期、待审重启。实际启用的内置 SDK、AI SDK 和已声明支持的外部引擎分别取得证据。外部发布、跨设备和真实计费用专用受控环境，经资源所有者批准后执行。
- **验收。** 按拟发布组合记录正常和故障场景、Worker 停机证明、拒绝跨队的状态、正确 Room attempt 交付及重连去重结果。每个声明支持的外部引擎须有实际记录。真实设备保留脱敏的运行 ID、trace/event 和可观察结果。超时未确认时停在可恢复或待人工状态。没有被验收的组合保持未认证，阻止该组合扩大可用范围。

## 5. 阶段 3 · 用户看到的 Agent 与 Host 实际执行一致

### F07 · 让 Picker 与执行共用有效目标解析

- **根因由源码确认。** Picker 读取可派发模板，直接聊天读取 SDK 可执行定义。两边对同名 Markdown、可见性与模型能力的过滤不同。目标未注册时发送装配不设置 `opts.agent`，回合仍可按普通聊天继续。[Picker](../../components/chat/composer/hooks/use-composer-mention-sources.ts#L53) · [发送装配](../../lib/claude/build-options.ts#L4763) · [AI SDK overlay](../../sidecar/src/runtimes/ai-sdk/index.ts#L254)
- **改动范围。** 从 agent catalog 和既有 grant/runtime resolver 返回有效目标描述，选择器和 Host 发送端使用同样的 id、来源优先级、`hidden` / `disabled`、引擎能力和过滤理由。Host 在真实发送前按当前政策重新验证。合法自定义目标走其已支持的执行 lane。普通发送缺能力时返回明确诊断，由用户明确选择回到 Direct 或使用现有委派入口。
- **验收。** 同名定义的标签、来源和实际请求一致。隐藏定义不出现在 Picker，禁用定义无法执行，撤销 grant 后拒绝发送。AI SDK 显示实际模型，明确该引擎不支持的字段。External、Standalone、Companion 各有准确的可用状态。由 T06 验证。

### F08 · 以 turn 身份触发一次实际可执行的独立复核

- **根因。** 未配对 Browser 被判断可用，生产复核依赖 Host capture。异步 watcher 登记较晚时按“已存在消息”过滤当前最终回复。[复核实现](../../lib/agent/composition/verified-fresh-agent.ts#L434) · [启动 watcher](../../hooks/chat/agent-chat-send.ts#L2627)
- **改动范围。** 依据实际 capture transport/capability 判断可用性，Picker 和执行入口共用。用既有 turn ID 与 terminal event 关联复核，订阅及晚到补读使用同一个持久或实际运行所有者可重读的终态记录。使用原有 verifier/session 路径记录主请求、实际产物、diff 和 verdict，核对来源与权限，继续以 plan 模式运行复核。以稳定身份防止同一 turn 的重复验证。
- **验收。** 未配对 Web 与不支持的 Companion 明确禁用原因且请求数为 0。支持 Host 下，快/慢主回复、主回复与订阅同时落盘、重复事件、取消/失败各有预期结果。成功回合只生成一个实际 verdict，失败可见。复核不能写文件或产生外部副作用。旧版本无可信 turn 对应关系的完成回复保持原历史。由 T06 验证。

### T06 · 覆盖真实身份与复核的执行结果

- **根因。** 旧用例分别固定 stale ID 清空与 Browser 可用，未断言随后请求或实际传输。Watcher suite 通过注入依赖覆盖局部状态。[装配测试](../../lib/claude/build-options.test.ts#L2694) · [复核测试](../../lib/agent/composition/verified-fresh-agent.test.ts#L502)
- **改动范围。** 以同一 fixture 驱动 catalog、Picker、Host resolver、权威 grant 和记录实际请求的运行时适配器。更新相冲突的旧期待，保留明确 Direct 与合法 Agent SDK 路由的已有语义。浏览器 E2E 补一条显式不可用的可见反馈，Headless 集成测试以真实 turn journal 覆盖复核。
- **验收。** stale、同名覆盖、隐藏/禁用、权限变更和三种运行时能力差异分别有负向及正向断言。快回复与重复完成事件恰好触发一次 verifier 请求，取消/失败不产生调用或误报成功。

### F10 · 单 Agent 路由减少真实执行开销

- **根因由源码确认。** 自动编排先生成 roster 和 DAG，再选择 executor。`single-send` 在快速和批准入口落入 Squad 物化。[编排顺序](../../lib/squads/auto/auto-orchestrate.ts#L115) · [两条入口](../../components/squads/auto-compose-dialog.tsx#L380)
- **改动范围。** 评估后及早分流，只有需要团队的路径再编队与分解。复用已有直接发送/Run、Council、Ensemble 和 handoff。交互中明确单 Agent 的实际行动及用户确认，意图从自动推荐切到手动组队时才继续编队。无有效目标时显示失败理由，循既有授权。
- **验收。** 自动推荐 Direct 时 roster 生成、任务分解、Squad 创建均为 0 次。显式确认后只启动一条单 Agent run，并返回可追踪结果。手动创建 Squad 仍生成可审查计划，背景委派、Council、Ensemble 保留各自路径。由 T07 验证。

### T07 · 验证推荐结果实际改变派发与调用次数

- **根因。** 决策函数与 Auto Compose 组件分别测试，`single-send` 缺真实两入口的调用/落盘断言。[组件测试](../../components/squads/auto-compose-dialog.test.tsx#L386)
- **改动范围。** 用真实 planner 的路由选择和可计数的模型替身，把分类结果带到 Quick Create 和预览确认。加入手动指定 Squad、分类不确定、二次点击与用户取消。
- **验收。** 两入口对 single、Squad、Council/Ensemble 与 handoff 记录正确目标、调用次数和持久对象。取消及重复提交无意外模型或写入。单 Agent 路由两条用例在旧实现上均能检测出多余调用或 Squad 记录。

### F11 · 模式文件互通与有效配置预览

- **根因已复现。** GUI 导出封装与 CLI 的严格根层 schema 不兼容，有效配置的能力/来源分布在不同入口与引擎。[GUI 导出](../../stores/agent/custom-mode-store/slices/actions.slice.ts#L210) · [CLI 解析](../../cli/src/config/agent-mode.ts#L65)
- **改动范围。** 定义单个版本化模式导入/导出契约，适配历史 GUI 封装和 CLI 平铺格式。优先扩展现有配置模块和 schema。保留有效工具、权限和模型字段，明确报告目标平台忽略或不支持的项目。配置文件只描述请求，Host 仍按 F07 解析并校验实际生效能力。Composer、配置页、CLI 和 Run 详情共享解析结果或其只读投影。
- **验收。** 同一份受支持字段配置 GUI→CLI→GUI 往返语义一致。旧文件可继续读取，未知版本或不兼容字段有明确诊断。预览与最终运行记录中的有效模型、工具、Host、权限一致。权限变化时按真实授权重新判定。新文案双语、可键盘操作，配对端显示 Host 判定。

## 6. 阶段 4 · 成员协作和路由以实测结果上线

### F09 · 交付可确认的队友消息与受控任务认领

- **根因由源码确认。** `team_send_message` 写团队 store 后立即返回成功。已核对的路径缺接收端消费、唤醒及确认。任务由 coordinator 和成员池分配，产品工具没有成员主动认领入口。[消息工具](../../lib/squads/collaboration-tools.ts#L739) · [成员池](../../lib/squads/teammate/teammate-pool.ts#L171)
- **改动范围。** 第一批扩展现有团队消息和 coordinator，持久化同队目标、来源、递送/消费计数与过期状态。复用控制通道的安全轮次边界及人类输入优先，按消息 ID 和目标 attempt 去重。使用现有 message guard、队伍和运行授权做限流，撤销后禁止旧接收绑定继续消费。第二批为明确开启且支持该能力的队伍提供认领入口，通过 F02 的 Host 原子准入复用依赖、工作区、并发、授权与预算规则，保留 Lead 分配。缺少 worker 能力时显示原因。
- **验收。** 消息从持久化、等待、接收至应用结果均可检查，重启或重复回执只消费一次。已结束/失效目标和过期消息不启动新轮次，失败可见。至少两个成员同领一个任务时只有一个成功，重复请求复用认领结果，取消或依赖未满足的任务不产生副作用，释放须符合停机证明。看板与任务记录同步。开放范围按 Q3。

### F12 · 在可比预算下衡量多 Agent 的净收益

- **根因。** 历史 MultiAgentBench 使用固定角色和闭卷任务，部分通信分数来自文本/依赖载荷，缺真实消费、产物和恢复证据。[历史评测](../reports/2026-10-25-multiagentbench-research-100.md#results) · [现有评测入口](../development/multiagentbench.md)
- **改动范围。** 复用现有评测的冻结清单、随机顺序、预算和恢复能力，为真实产品入口补可控场景与证据采集。建议先预注册 3 组，每组至少 10 个独立任务、每种模式至少 3 次。任务组覆盖可并行调查、强依赖交付、含评审/故障恢复的代码交付。比较单 Agent、有限 Subagent 和 Squad，记录有效引擎/模型、模型预算、总耗时、额外审批/人工干预、结果引用、消息消费和停止收据。Worker 与工作区以相同条件运行。用测试通过、可验证产物与人工校准评分评价成功，缺失试验、失败与花费进入分母。首次全链路评估前冻结预算和阈值。
- **验收。** 交付可复算的配对结果、明确样本/失败/未测范围、验收率、p50/p95、token/费用、重复执行及恢复成功率。硬性安全不变量在受测样本中零违反。默认仍走单 Agent，只有预注册的任务组收益达到 Q4 门槛后才扩大自动路由。报告样本不足时保留显式选择和观察阶段。

## 7. 兼容、权限和回滚服从同一 Host 事实源

### 关键状态与兼容合同

| 边界                      | 采用方案                                                                                                                                                      | 失败时的表现                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **任务取消与认领**        | 持久条件更新绑定 account/workspace、Squad、run、attempt 及当前状态。投影按版本读取。相同命令重试使用同一结果。                                                | 状态变化、权限撤销或 Host 丢失时拒绝或留待确认。旧 attempt 不接管新任务。                                                          |
| **预算批准**              | 额度为整数 token，阈值在 0–1 且 warning ≤ critical，使用持久的有效配置。影响父预算的增加必须由对应父权威确认。审批收据与额度扩展幂等。                        | 额度不足、未知花费、未确认停止有各自诊断。任何重入都只能使用可证明的剩余预算。                                                     |
| **回传与消息消费**        | attempt 结果引用、既有稳定投递 ID 与 Room 持久接受收据各自可追踪。在确认前重试使用同一 ID，接收端通过同一 ID 返回既有接受状态。每个账号和投递目标有清晰归属。 | 旧结果只有终态时交付终态和链接。源或受众无法验证时不暴露内容。外部收件端缺幂等能力时显示送达未确认，并按原通道的规则决定人工恢复。 |
| **steer 版本协商**        | 现有 `accepted` 表示命令被接受，收据信息描述送达程度。新字段可选并由实际能力协商或版本判断使用。                                                              | 老端无法区分送达与排队时仅展示可证实的旧状态，或禁止容易误报的动作。新端连旧 Host 时不凭 accepted 推断送达。                       |
| **模式交换与 Agent 路由** | 历史配置继续读，新写入按 canonical schema。运行快照所含配置版本只读。                                                                                         | 收到未知版本、失效目标、能力不明或 revoked grant 时给原因并等待明确选择。                                                          |

优先扩展现有版本化记录及可选字段。只有现有表、索引无法提供原子约束时才提出 Dexie schema 变更，并另给版本、大小、跨端投影、删除传播和迁移证据。旧记录的内容引用、预算用量和已投递事实须有可信来源。缺失项统一显示为未知或待恢复，避免影响新记录。旧客户端无法读新增状态时，使用已协商的保守状态或结束该混合版本的对应动作。允许升级跨过一个支持窗口的具体版本由发布负责人在 T14 环境矩阵记录。新增 IPC 字段时同时保存 Host 先升级与客户端先升级的证据。

### 安全与观测

- 源代码中的 Host 绑定、Task Workspace 租约、执行授权、隐私标签与目标作用域继续提供准入依据。模型给出的 Team ID、路径、权限声明只视为输入。读写、批准、改令、投递在实际执行点重新验证。外部引擎无法提供停止凭据时显示未确认并保留原 fencing 和人工恢复。
- Room、成员消息、复核、评测和报告都复用各自的授权与 PII 出站门禁。报告和 telemetry 持久化有限的运行/attempt 引用及结果码，原始 prompt、任务正文、凭证、工作目录和完整结果不进入指标标签。账号删除和数据治理仍覆盖新增的可选投影与回执。
- 复用 Run/Workflow 轨迹与已存在的控制、审批、交付事件。观测字段记录 capped/used/reserved、dispatch 计数、拒绝原因、queued/delivered/partial、重启补投结果。统计按 Host 类型、引擎族、状态和原因分类，run ID 只用于日志关联。任何重复外部副作用、跨队异常写入或未证实停机却成功结算的证据，立即冻结对应灰度。预算确认后长期停在等待、outbox 超出现有重试窗口时进入操作员恢复检查。
- 回滚停止新能力曝光与自动准入，允许已证实的 run 结算及 pending outbox 安全处理。保留原收据与 attempt 账本，回滚后也能查询并对账。授权和停机相关修复参与安全版本边界，降级目标需仍能拒绝不安全动作。曾遇到 budget/history 字段不兼容时先验证旧 reader 或先暂停相应恢复路径。

### 阶段发布与回退

| 阶段 | 发布入口                                                       | 暂停扩量或回退条件                                                                                 |
| ---- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0    | 测试映射与当前 branch 的基线可重复                             | 独立用例依赖执行顺序、出现句柄泄漏、seed 无法稳定完成时暂停后续发布。                              |
| 1    | 局部回归、账户隔离、取消与预算正反路径通过，再在受控 Host 运行 | 任一跨队写入、错误 dispatch、预算越界或错误恢复即停止对应运行入口。保留已经写入的审计及预算记录。  |
| 2    | 两个 PR E2E 项目、按 attempt 回传与真实设备目标组合通过        | 有重复、串结果、伪送达或未确认停止时冻结对应端。保留 outbox 和 receipt，修正后按既有幂等键补投。   |
| 3    | 所属 runtime 与 GUI/CLI 兼容矩阵通过                           | 因能力误判而执行了其他 Agent、重复复核或误建队时撤下对应 UI 能力，保留显式 Direct 和已有效的模式。 |
| 4    | 受控团队的邮箱与原子认领、预注册评估通过                       | 成员消息重复/越权、任务双认领或指标未达门槛时维持手动编排，保留可追溯结果与人工恢复。              |

## 8. 验证按风险分层，运行失败保留原始证据

| 界面/边界                    | 可运行入口                                                                                                                                                                                                                                                  | 证据                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Owner tests                  | `pnpm test -- --runInBand --runTestsByPath <本工作包实际套件路径>`                                                                                                                                                                                          | 产品缺陷有修复前失败与修复后通过的断言。竞态以显式屏障构造。记录用例、断言和真实运行结果。 |
| 生命周期与归属               | `pnpm test -- --runInBand --runTestsByPath lib/squads/agent-team-runtime.test.ts`。其他组合从 F01–F06 及 T01–T05 所列 co-located suite 选取                                                                                                                 | 原测试自然退出。合法、拒绝、重启、重复及部分成功分支分开验收。                             |
| Chromium / Pixel 7           | `pnpm test:e2e:build` 后运行 `PLAYWRIGHT_STATIC=1 pnpm test:e2e --project=chromium tests/e2e/agent-runs/squad-run-controls.spec.ts`，另在 `mobile-pixel-7` 运行 `tests/e2e/mobile/squad-remote-start.spec.ts`。具体新增场景登记到对应 spec 或 Host 运行套件 | trace、截图、服务日志与业务终态。CI 选用发布时的同项目、标签及静态产物。                   |
| 原生与多 Host                | 在支持 Windows WebView2 的执行机运行 `pnpm test:e2e:tauri` 和 `pnpm test:e2e:dual-host:desktop`，真实 Capacitor／Host／Worker 另附操作记录                                                                                                                  | 支持的真实设备矩阵、stop proof、审批与恢复顺序、实验环境版本和可复看结果。                 |
| CI 合同与 TypeScript         | `pnpm lint`、`pnpm typecheck`、`pnpm audit:colocated-tests`、`pnpm audit:modules`。UI 跑 `pnpm i18n:build`、`pnpm i18n:build:check`、`pnpm lint:i18n`、`pnpm lint:static-export`。E2E 跑 `pnpm audit:e2e-governance`。                                      | 变更范围、失败归因及实际输出。覆盖率验收沿用仓库已有门禁。                                 |
| Sidecar / Companion 条件门槛 | 触及 adapter 时运行相关 sidecar 测试、`pnpm sidecar:typecheck`、`pnpm audit:sidecar-architecture`。若 RPC 投影改动，运行 `pnpm companion-api:check` 加双方版本整合测试。                                                                                    | 真实事件与旧版本兼容。生成检查通过后仍测试新增字段及跨版本行为。                           |
| 多 Agent 对照                | `pnpm eval:multiagentbench --dry-run --cases 3` 可检验当前基线 runner 的选择与配置。F12 的产品路径按冻结方案另运行                                                                                                                                          | manifest、预算、测试产物和每组指标。现有 runner 的 dry run 无法给出真实产品收益。          |

## 9. 评审决定与责任

| 决策                                  | 选项与建议                                                                                                                                                                                                                                                                                                                        | 确认责任与时机                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Q1 · 冲突预算如何迁移**             | 建议让旧双配置冲突的现有 Squad 沿用实际生效的正数 Overview cap，并在 UI 标明冲突。只有无正数 Overview cap 时使用有效 Governance cap。用户保存新配置后统一写 canonical 值，显式 0 表示无限，仍受父限额。对旧数据直接套新的 cap 会突然改变运行行为。用更紧 cap 有控制收益，也可能无预告中断旧任务。运行中的约束通过批准与账本更新。 | Squads 与执行账本 owner，阶段 1 实现前。              |
| **Q2 · 混合版本如何表达排队**         | 建议 Host 保留旧字段，能力已协商时返回新版摘要。对会将 accepted 误画为送达的旧端，使用可表达的待确认状态，仍无法表达时保守关闭该混合版本的动作。全量强制升级会加快清理，也会打断旧配对设备。                                                                                                                                      | Companion 与 Run Control owner，阶段 2 协议设计评审。 |
| **Q3 · 何时启用成员自领取**           | 建议先提供成员消息和管理员主动启用的自领取。现有 Lead 分配仍可用。默认对等领取会改变任务归属、并发及用户可控性，先由 T14 与 F12 的定向样本验证。                                                                                                                                                                                  | Squads 产品与 Host owner，阶段 4 灰度前。             |
| **Q4 · 哪些任务值得自动进入多 Agent** | 建议预注册可接受的预算和延迟。建议试验门槛为配对验收率至少提高 5 个百分点且区间下界高于 0，或质量差的下界不低于 −2 个百分点且每次成功成本或 p95 至少降低 10%。其他关键指标不得超过预注册预算和时延上限。按任务聚类估计区间，小样本证据不足时继续手动入口。正式试验的门槛和预算由评审签认后使用。                                  | 产品与评测 owner，F12 计费实验前。                    |
| **Q5 · 哪些平台进入本次发布**         | 建议按 T14 逐项批准实际 Host、设备与 provider 资源。无法获得真实证据的平台保持其原有可用边界，对新增声明不予认证。                                                                                                                                                                                                                | 发布与平台 owner，阶段 2–4 各组合发布前。             |

| 工作包                    | 责任角色                        | 独立核验                                                            |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| T08–T10、T13              | 测试基础设施                    | Squads owner 核对有效 fixture、失败条件、自然退出及浏览器业务断言。 |
| F01–F02、T01–T02          | Squad 调度与 Host 权限          | Host/Companion reviewer 审核真实 authority 和取消竞态。             |
| F03–F04、T03              | 执行账本与 Workflow Runtime     | 独立核对重放、额度、停机与二次审批。                                |
| F05–F06、T04–T05          | Room 投递与 Run Control         | 跨端 reviewer 验证 attempt 证据、客户端回执和旧版本。               |
| T11–T12、T14              | E2E 与发布平台                  | 目标环境负责人签认实际 PR、原生设备及 Worker 证据。                 |
| F07–F08、F10–F11、T06–T07 | Agent Runtime 和 Composer / CLI | 支持矩阵由平台 owner 按有效策略核对。                               |
| F09、F12                  | Squads 协作与评测               | 安全 reviewer 检查消息和认领，评测 owner 公开可复算资料。           |

| 评审记录                     | 状态                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| 2026-11-18 · 源码及范围核对  | 已核对当前调用路径和 PR 发现结果。产品行为和测试修复均待后续实施。 |
| 设计/安全评审及 T14 资源确认 | 等待角色评审 Q1–Q5。                                               |

相关 ADR 包括 [ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md) · [ADR-0169](../content/docs/en/adr/0169-one-runtime-one-review-one-control-machine.md) · [ADR-0243](../content/docs/en/adr/0243-a-run-acts-for-someone-and-says-who.md) · [ADR-0244（Proposed）](../content/docs/en/adr/0244-a-remote-run-has-stopped-only-when-its-worker-says-so.md) · [ADR-0249](../content/docs/en/adr/0249-a-background-jobs-completion-reaches-the-agent.md) · [ADR-0117](../content/docs/en/adr/0117-composed-agent-modes-and-creator.md)
