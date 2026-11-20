# Bot 核心机制审计

- Status: fixed
- Lane: deep
- Created: 2026-11-18
- Updated: 2026-11-20
- Related: [ADR-0174](../content/docs/en/adr/0174-the-bot-control-plane.md) · [Bot 插件契约](../content/docs/en/plugin-dev/bots.mdx) · [Host 进程验收设计](../../tests/bot-e2e/README.md)

## Original request

> 帮我分析一下，看看现有的Bot机制（核心机制，不包括IM逻辑），或者存在什么问题，并且对照业内的优秀实践

## 结论

Cognia 的 Bot 将触发条件、安装配置和运行策略绑定到已有执行器。这套分工值得保留。故障集中在几套组件交接的位置：用户批准了计划，Squad 怎样读取答案；子任务结束，父 Bot 怎样记录结果；Host 恢复时，哪些工作允许重做；两个控制操作都显示成功时，数据库究竟留下什么。

最值得先修的是 **Squad 的批准与终态、步骤重放、安装并发写入**。它们已经能在本地分别造成用户批准无效、失败显示成功、动作重复、已关闭的触发器仍然启用。下面的优先级按这些后果和触发条件排列。未统计线上发生率。

第二轮对抗性复核新增 15 组问题。卸载期间仍能接单、迟到重试反转触发器开关、内嵌 Python Host 无法运行文档示例、自动重试后显示旧结果，均已在相应运行边界复现。建议将 B16–B19 与首轮四项一同排入首批。见下文对抗性复核。

## 实际运行路径

| 阶段             | 当前行为与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定义与安装       | 目录合并插件清单与本机定义。安装保存 definitionId、pinnedVersion、作用域、凭据槽、触发器覆盖和策略。仓内 plugins/*/plugin.json 直接声明了三个 Bot，分别为 repository-monitor、comment-commands、schedule-digest，三个都使用 handler。其他三个执行器也有独立的实现与测试。[目录](../../lib/bot/console/catalog.ts#L85) · [安装](../../lib/bot/control-writes/lifecycle.ts#L259) · [执行器注册](../../lib/bot/runtime/executors/index.ts)                                                        |
| 触发与入队       | 本次覆盖 manual、event、schedule、poll、derivedState。事件可来自集成、桌面、Workflow 或另一个 Bot。路由先匹配订阅、条件与因果链，按每个匹配的安装和触发器生成独立 delivery。唯一索引在队列入口去重，每个调度时隙也有稳定身份。[路由](../../lib/bot/events/router.ts#L170) · [身份编码](../../lib/bot/events/envelope.ts#L51) · [入队](../../lib/db/bot-event-deliveries.ts#L185) · [调度时隙](../../lib/scheduler/executors/bot-executor.ts#L99)                                               |
| 执行与控制       | 桌面或 headless Brain 领取本地 delivery。领取使用事务、租约、并发键和安装并发上限，镜像行在领取时被排除。delivery 派生稳定 runId，交给 handler、agent-turn、workflow 或 squad。策略解析会收紧传入的权限与预算，重入会再次与原有策略快照取交集。[桌面入口](../../components/providers/initializers/bot-runtime-initializer.tsx#L71) · [Brain 入口](../../lib/headless/runtimes/bots.ts#L27) · [领取](../../lib/db/bot-event-deliveries.ts#L366) · [策略快照](../../lib/bot/runtime/run.ts#L435) |
| 等待、恢复与结果 | 工作可保存步骤结果，等待审批或关联事件时可释放租约，运行日志与进度进入统一 journal。普通成功路径在一个事务内提交定时触发状态、完成事件与 delivery。Workflow 子执行还使用父 runId 作为幂等键，并区分成功、失败、取消与等待。下面若干发现正好可以复用这些已有做法。[步骤](../../lib/bot/runtime/step.ts#L191) · [挂起](../../lib/db/bot-event-deliveries.ts#L580) · [提交](../../lib/bot/runtime/run.ts#L606) · [Workflow](../../lib/bot/runtime/executors/workflow.ts#L81)                      |

Agent Turn 另有一层保护。Bot 传入派生自 runId 的稳定 operationId、角色与权限配置，Agent Turn 模块核对已完成操作的请求指纹。这里对普通 handler 步骤的重复计数，不能外推为每次模型调用都重复计费。[Bot 调用](../../lib/bot/runtime/executors/agent-turn.ts#L181) · [操作与结果匹配](../../lib/plugin/api/agent-turn.ts#L386)

## 首轮优先处理的四项

| 编号                                         | 触发条件与观察结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 修复验收                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01 · Squad 计划批准失效                     | Bot 的审批委托将 approved 转成布尔 true。Squad 网关读取 answer.outcome，只有 approve 才放行。用生产 Bot 委托和 Squad 生命周期配合合成审批，实际得到 failed，原因是 “Plan rejected after max revisions”。该结论限定在委托回答先起作用的路径。[Bot 委托](../../lib/bot/runtime/executors/squad.ts#L174) · [桥接](../../lib/squads/squad/start-squad-run.ts#L278) · [Squad 网关](../../lib/squads/agent-team-runtime.ts#L775)                                                                                        | 两侧共享具名的审批结果类型。用真实委托同时覆盖批准、拒绝、过期，验证批准后计划确实进入执行。                                                                |
| B02 · 子 Squad 失败或取消，父 Bot 显示成功   | Squad 执行器只查询子运行是否已经结束。预置子运行 failed、cancelled 两种状态，使用实际查询和父运行提交逻辑，两次都得到父 completed、delivery succeeded。依赖父成功的后续 Bot 可能误启动。Workflow 执行器已有逐态映射可复用。[Squad 查询](../../lib/bot/runtime/executors/squad.ts#L140) · [返回结果](../../lib/bot/runtime/executors/squad.ts#L199) · [Workflow 对照](../../lib/bot/runtime/executors/workflow.ts#L113)                                                                                            | 对四种子状态分别断言父状态、delivery、journal 和下游事件。只有子成功才能触发成功分支。                                                                      |
| B03 · 两种 SDK 的步骤重放保证过强            | Python 的 async with run.step 在缓存命中时仍 yield 给调用方。同运行同名步骤进两次，实测代码块执行 2 次、检查点只写 1 次。TypeScript 正常命中缓存会跳过回调，但模拟本地副作用已发生、检查点写失败后，同一回调执行了两次。公开注释使用 “once per run, ever”。这里验证的是本地计数器，外部服务是否重复取决于它的幂等机制。[Python SDK](../../plugin-sdk/python/src/cognia/bot.py#L172) · [TypeScript 契约](../../packages/plugin-contract/src/types/bot/run.ts#L77) · [执行顺序](../../lib/bot/runtime/step.ts#L191) | Python 提供由 SDK 决定是否调用的回调式步骤，兼容旧 API 并明确 memoized 分支。为有副作用的步骤提供稳定操作键，验证正常重放和“对端成功、检查点未写”两个窗口。 |
| B04 · 两个控制操作均成功，安装只保留其中一个 | 经公开本机接口并行保存配置和禁用 Bot，前者返回已保存配置，数据库最终为 disabled、空配置，humanRevision 只增加 1。并行关闭两个不同触发器也只保留后一次覆盖，前一个仍为 armed。原因包括事务外整行读改写，以及根据先前读取的触发器映射构造补丁。[安装写入](../../lib/db/bot-installations.ts#L203) · [开关写入](../../lib/bot/control-writes/local.ts#L82)                                                                                                                                                           | 按意图在同一事务内读取最新值、合并并增加 revision，必要时拒绝过期修订。两组并发操作都应得到可解释的结果，并在重新读取后保持。                               |

## 其他已复现的问题

| 编号                                                  | 条件、影响与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 建议验收                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| B05 · 失败订阅收不到事件                              | handler 耗尽一次尝试后，run 为 failed、delivery 为 deadletter，订阅 bot.run.failed 的另一个安装收到 0 条。直接调用同一投影器则入队 1 条。正常成功通知也在提交后异步派发并吞掉错误，存在提交后停机丢通知的窗口；这个窗口仅有源码证据。[投影器](../../lib/bot/sources/bot-run.ts#L21) · [唯一生产调用](../../lib/bot/runtime/run.ts#L638) · [失败路径](../../lib/bot/runtime/run.ts#L745)                                                                                                    | 只在确定终态后发布相应事件。终态和待发记录一起提交，在发布前后停机均可恢复，订阅端按稳定键去重。                      |
| B06 · 恢复时 delivery 与 run 终态分裂                 | 从“最后一次尝试正在运行”的存储状态调用 Host 恢复函数，delivery 变为 deadletter，已有 ExecutionRun 仍为 running。成功路径已有多表事务，这个恢复路径只更新 delivery。[启动恢复](../../lib/db/bot-event-deliveries.ts#L731) · [租约过期恢复](../../lib/db/bot-event-deliveries.ts#L704)                                                                                                                                                                                                       | 重启或租约过期耗尽重试后，Run 详情、队列和下游订阅观察到相容的终态。                                                  |
| B07 · 停用触发器后，已交给调度器的 tick 仍可新入队    | 实际调用 disarm，待它成功返回再执行之前已交付的轮询 tick，结果为 success 且新增 1 条 delivery。执行器校验安装和触发器类型，没有在入队时复核 armed。既有积压任务另有保留语义。[调度入口](../../lib/scheduler/executors/bot-executor.ts#L76) · [入队](../../lib/scheduler/executors/bot-executor.ts#L127) · [SDK 约定](../../packages/plugin-contract/src/types/bot/api.ts#L193)                                                                                                             | 以入队作为边界，解除前已接受的工作遵循既有规则，解除完成后的定时准入为零。                                            |
| B08 · 串行轮询也可能重复读同一页                      | 以相同并发键先入队两个时隙，两个 handler 都读到游标 zero，最终为 zero-next。第二个时隙在第一个提交结果之前已把旧游标复制进事件。该问题影响使用事件游标的插件。自行管理游标或下游去重的插件有额外保护。[取游标](../../lib/scheduler/executors/bot-executor.ts#L97) · [写入事件](../../lib/scheduler/executors/bot-executor.ts#L117) · [提交新游标](../../lib/bot/runtime/run.ts#L345)                                                                                                       | 首次执行每个时隙时读取上个已提交游标，再为该 delivery 固定它。让积压、重试和取消用例分别验证游标。                    |
| B09 · 一项安装达到并发上限，另一项也会等              | A 已占满唯一运行槽，队首另有 5 条属于 A 且并发键各异，B 有一项就绪工作。默认批量为 5，连续三轮均只返回 A 的 5 个 throttled，B 保持 pending。队列已能跳过被相同并发键挡住的工作，此处是安装级容量筛选晚于截取批次。[批次选择](../../lib/db/bot-event-deliveries.ts#L339) · [安装上限](../../lib/bot/runtime/delivery-runner.ts#L152)                                                                                                                                                        | 满额安装的候选不占用本轮其他安装可用的名额，验证 A 仍受限且 B 能在下一轮启动。                                        |
| B10 · 插件暂时不可用，会永久丢弃已接受的工作          | 合成安装保持启用，暂时清空注册表。已接受的事件被置为 dismissed；恢复注册后未执行，回放接口也返回 false。同样的暂时缺定义在事件准入阶段被标为可重试。探针模拟了注册表缺失，未测量它在真实启动时的出现概率。[准入](../../lib/bot/events/dispatch.ts#L118) · [运行](../../lib/bot/runtime/delivery-runner.ts#L183) · [回放](../../lib/bot/control-writes/local.ts#L267)                                                                                                                       | 区分加载中、已卸载、已停用。短时不可用保留工作，恢复时只执行一次。                                                    |
| B11 · 等待事件时，消费条件与等待条件不同              | 同一安装两个触发器共享关联键，一个等待明确指定 answer。另一个触发器 other 的事件被 runner 标为 consumed_by_wait 并 dismissed，原 step 却拒收并继续等待。另一个探针在 t=100 发起等待、期限 t=200、事件 t=220 才收到，t=230 恢复时仍返回该事件；无事件的对照组返回 null。[队列消费](../../lib/bot/runtime/delivery-runner.ts#L123) · [等待者匹配](../../lib/db/bot-event-deliveries.ts#L610) · [step 匹配与超时](../../lib/bot/runtime/step.ts#L414)                                         | 持久化 answer trigger、关联键与截止时间，消费和唤醒使用同一谓词。分别验证无关事件、截止前到达但稍后读取、截止后到达。 |
| B12 · 版本漂移后，手动与自动入口执行不同契约          | v1 安装遇到 v2 定义，定时任务仍能入队，手动运行被拒。进一步让 v1 完成一个步骤后挂起，更新插件和配置，同一个 run 在 v2 完成，复用了 v1 的步骤输出，并读到新配置。执行时对权限重新收紧仍应保留。[漂移识别与定义解析](../../lib/bot/installed-bot.ts#L108) · [自动运行判断](../../lib/bot/installed-bot.ts#L193) · [手动入口](../../lib/bot/control-writes/local.ts#L186) · [重读配置](../../lib/bot/runtime/run.ts#L494)                                                                     | 明确哪些升级可自动继续；固定在途运行的定义和业务输入，或在恢复时显式迁移。所有入口显示相同的规则与原因。              |
| B13 · 本机与配对 Host 的安装校验不一致                | 安装界面只提交条目和作用域。同一个必填字段无默认值的定义，本地无凭据槽的夹具得到 enabled、空配置，配对 Host 的实际 mutation 拒绝 Invalid Bot configuration。仓内 GitHub 两个 Bot 确有无默认值的必填项；它们还可能因缺凭据进入 needs_setup。[表单](../../components/bots/install-bot-sheet.tsx#L176) · [本机](../../lib/bot/control-writes/lifecycle.ts#L259) · [Host](../../lib/bot/control-writes/lifecycle-host.ts#L185) · [真实清单](../../plugins/github-comment-bot/plugin.json#L248) | 选定统一的安装流程：安装时收齐必填项，或允许创建待配置安装、配置完成后才运行。本机和远程使用同一校验与状态转换。      |
| B14 · 时长预算对不响应取消的进程内 handler 只能发信号 | 预算 20 ms，handler 等待一个可控 Promise。到 70 ms 已收到 abort，delivery 仍为 running；释放 Promise 后才结束为 cancelled。runner 在执行退出后才清理续租定时器。这里没有验证独立插件进程的强制终止。[定时器](../../lib/bot/runtime/run.ts#L490) · [handler 调用](../../lib/bot/runtime/executors/handler.ts#L22) · [续租](../../lib/bot/runtime/delivery-runner.ts#L203) · [公开契约](../../packages/plugin-contract/src/types/bot/run.ts#L124)                                            | 明确软取消与强制结束的适用执行器。超限运行必须有可观察状态，并验证长期不返回时的槽位与迟到结果。                      |
| B15 · 长时间暂停后完成的工作，会从配对端结果中消失    | 人工时钟跨过 14 天保留期，恢复并完成后，Host 仍有 succeeded 记录。按最近变更增量读取只返回新对照行；把旧行的终态直接交给镜像也会立即清理。Host 按 settledAt 保留终态，增量和镜像按 receivedAt 截断。[Host 保留](../../lib/db/bot-event-deliveries.ts#L875) · [增量](../../lib/sync/desktop-sync-source.ts#L1117) · [镜像清理](../../lib/bot/sync/bot-event-deliveries.ts#L74)                                                                                                              | 统一终态保留与增量时间语义。暂停超期的 delivery 今日完成后，离线恢复的配对端应能读到终态。                            |

## 业内实践与适用性

| 可比机制               | 官方实践                                                                                                                                                                                                                                                                                                                                                  | Cognia 可采用的最小改动                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 步骤重放与外部副作用   | Inngest 的 Python step.run 接收可调用对象。其可靠执行指南明确提出，远端接受请求与本地记录结果之间仍有失败窗口，操作幂等键应跨重试保持稳定。[Python 步骤](https://www.inngest.com/docs/reference/python/steps/run) · [Inngest 可靠执行](https://www.inngest.com/docs/durable-execution/best-practices)                                                     | B03 保留当前稳定 runId/stepName，将它们用于作者可获得的操作键，同时为业务上跨 run 的重复提供业务键入口。  |
| 子任务结果与升级       | Temporal 的父历史记录子工作流状态；其 Worker Versioning 支持把在途的 pinned workflow 固定到开始执行的部署版本。[Child Workflows](https://docs.temporal.io/child-workflows) · [Worker Versioning](https://docs.temporal.io/best-practices/worker)                                                                                                          | B01、B02 先复用已有 Workflow 的逐态处理。B12 可以先在不兼容升级时停止并解释，旧代码长期并存是更重的选择。 |
| 终态与事件同时可靠提交 | AWS 的 transactional outbox 将业务状态与待发事件写入同一事务，再由发布者投递；重复投递由消费者幂等处理。[Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)                                                                                                                  | B05、B06 复用现有数据库事务与确定性 delivery ID，将发布意图纳入终态提交。                                 |
| 等待与公平性           | Azure Durable Task 的外部事件指定实例和事件名，可与持久化计时器竞争。SQS fair queues 用安静租户的排队时长衡量吵闹租户的影响。[Azure 外部事件](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-external-events) · [SQS 公平队列](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html) | B09、B11 可在现有本地队列内实现。观察每个安装最老可执行任务等了多久，以及错误消费、等待超时的数量。       |
| 控制面并发与定时启停   | Kubernetes 提供 resourceVersion 检测过期覆盖，也支持字段级 patch。Argo CronWorkflow 将 suspend、重叠执行策略和错过时隙的容忍期限分别声明。[Kubernetes API](https://kubernetes.io/docs/reference/using-api/api-concepts/) · [Argo CronWorkflow](https://argo-workflows.readthedocs.io/en/latest/cron-workflows/)                                           | B04 使用数据库已有事务进行字段合并；B07、B08 划定“接受的时隙”和“执行时读取的游标”各自的时间点。           |

## 对抗性复核（2026-11-18）

复核基线为 `c128e6a056`。本轮在首轮 B01–B15 之外确认 **15 组新问题（B16–B30）**。最值得同时排进首批修复的是 B16–B19。B20 和 B21 分别影响故障排查和结果保留。这里按用户能观察到的故障分组，同一现象的独立复现只计一次。优先级反映触发条件和后果，线上频率未知。

### 建议先修的四项

| 编号                                                       | 用户可观察到什么                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 修复验收                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **B16 · 卸载成功后，新运行还能成功提交**                   | 进入插件的异步 `onUninstall` 后，公开手动入口仍接受新任务。让 handler 启动，再让卸载返回并确认安装行已消失，最后放行 handler，实际得到 run `completed`、delivery `succeeded`。卸载先取消一次积压，之后等待钩子才删安装。完成时只复核租约。探针落在下一次 30 秒心跳之前，handler 仅返回合成结果。[卸载](../../lib/bot/control-writes/lifecycle.ts#L509) · [完成判定](../../lib/bot/runtime/run.ts#L616) · [心跳](../../lib/bot/runtime/delivery-runner.ts#L203)                                                                                                                                                                                                                                                   | 卸载首先持久化停止接单的状态，再取消积压、执行清理。以相同交错验证卸载期间的新请求被拒绝，已撤销运行无法提交成功。                   |
| **B17 · 较早的远端启用重试可反转较晚的停用**               | 同一触发器的“开”遇到临时网络错误进入退避，“关”随后到达 Host 并成功。恢复后旧“开”又执行，Host 最终为开。每个手势有独立幂等键，入队时未携带同一触发器的序号。本项发生在顺序点击之后，和 B04 的本机并发写入有不同修复点。[远端写入](../../lib/bot/control-writes/remote.ts#L119) · [领取条件](../../lib/db/mobile-outbound-queue.ts#L846)                                                                                                                                                                                                                                                                                                                                                                           | 让同一安装及触发器的已确认新意图优先。用一次退避、一次更新、一次迟到重试，验证设备和 Host 最终都为关。                               |
| **B18 · 文档中的 Python Bot 无法在内嵌 Host 按示例运行**   | 把仓库 SDK 加入 `PYTHONPATH`，用标准输入输出启动 Rust 实际嵌入的 `host.py`。示例的 `from cognia.bot import define_bot` 报 `ModuleNotFoundError`。只用 `import cognia` 的贡献可以注册，收到的参数可用 `run["runId"]` 读取，访问文档对象的 `run.run_id` 则报 `AttributeError`。这会先于 B03 的步骤重放问题阻断按指南编写的插件。仓内两个 GitHub Bot 使用 TypeScript。[作者指南](../content/docs/plugin-dev/bots.mdx#L124) · [Rust 内嵌入口](../../crates/cognia-plugin-runtime/src/python/commands.rs#L30) · [模块注入](../../crates/cognia-plugin-runtime/src/python/host.py#L509) · [分发](../../crates/cognia-plugin-runtime/src/python/host.py#L816) · [快照桥接](../../lib/plugin/bridge/bots-bridge.ts#L148) | 同一份文档示例在 SDK 单测和内嵌 Host 中均能导入，验证 `BotRun` 身份及一次步骤调用与恢复。保留原始快照型插件的兼容用例。              |
| **B19 · 自动重试成功后，结果详情仍可能返回上次尝试的输出** | 第一次 handler 算出 A，在提交成功状态时注入一次本地写失败。自动重试算出 B 并成功。真实详情读取返回 A，同一次查询的完成事件却记录 B。另一个独立探针在不同存储边界得到相同结果。`__host:result` 在成功事务之前写入，首次完成的值会一直保留。[写入顺序](../../lib/bot/runtime/run.ts#L590) · [首次写入保留](../../lib/db/bot-run-steps.ts#L70) · [详情读取](../../lib/execution/run-detail-source.ts#L30) · [插件结果读取](../../lib/plugin/api/bots-api.ts#L327)                                                                                                                                                                                                                                                   | 将最终输出与成功事件、delivery 终态原子发布，或按已确认的尝试读取。对“计算已完成、终态提交失败一次”验证 UI 详情和插件 API 都返回 B。 |

### 其他新问题

| 编号                                                           | 复现、影响与适用范围                                                                                                                                                                                                                                                                                                                                                                                                                           | 修复验收                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **B20 · 第二次显式重试可让详情打不开**                         | 以标准 UUID、常规安装 ID 和五字符触发器走手动执行、失败、Retry、再失败、再 Retry。三个持久化 run ID 分别长 111、206、323。最后一个 run 存在，详情读取拒绝超过 256 字符的 ID。重试把整个上一条 delivery ID 再编码进下一条。[重试身份](../../lib/bot/control-writes/local.ts#L274) · [详情长度检查](../../lib/execution/run-detail-source.ts#L22)                                                                                                | 使用有界的新标识，另存父子关系。连续多次 Retry 后每个详情仍可打开，并兼容已生成的长 ID。                         |
| **B21 · 14 天后删掉 delivery，步骤和最终输出仍可读**           | 对成功运行写入一个步骤和最终结果，推进到第 15 天，执行正式保留期清理。旧 delivery 消失，新对照行保留。旧 run 的业务步骤、策略及结果三个检查点均在，详情仍可读出结果。数据目录将该表声明为 14 天随 delivery 清除，通用清理器只处理分配给中央执行器的表。[保留契约](../../lib/data-governance/table-catalog.ts#L1935) · [领域清理](../../lib/db/bot-event-deliveries.ts#L875) · [中央清理范围](../../lib/data-governance/table-catalog.ts#L2322) | 对到期已结束运行清除相应步骤，保持活跃等待、合法重试和近期结果可读。若需独立保存结果，应分别声明保存内容和期限。 |
| **B22 · 取消死信会改写已失败的 run，日志仍以失败结束**         | 将任务跑至最终失败，从公开取消路径处理死信后，run 行变成 `cancelled`，最后一个 run 事件仍为 `run.failed`。投递面板为死信提供取消入口。[取消分支](../../lib/bot/runtime/run.ts#L204) · [面板按钮](../../components/bots/sections/deliveries-section.tsx#L144)                                                                                                                                                                                   | 明确“放弃再投递”的动作，保留已结束执行的历史。校验处置死信前后详情、审计日志和投递状态能互相解释。               |
| **B23 · 调度对账并发时，一个轮询触发器可产生两条任务**         | 对同一份已启用安装并行调用两次正式对账函数，用实际调度器和本地测试数据库读到两条同 tag 任务。再串行对账一次恢复到一条。已证明任务重复，业务 handler 是否执行两次还取决于时隙身份和入队去重。[对账快照](../../lib/bot/schedule/reconcile-timed-triggers.ts#L151) · [创建](../../lib/bot/schedule/reconcile-timed-triggers.ts#L209) · [仓内有界 ID 与并发合并先例](../../lib/scheduler/managed-tasks.ts#L50)                                     | 重复、并行对账均只留下一个任务。验证并行创建当下的行数，以及之后的时隙去重。                                     |
| **B24 · 镜像跳过 Host 更新，却推进同步游标**                   | 配对端有待确认的触发器变更时，收到含另一项暂停设置的 Host 行。镜像跳过整行，同步结果却报已应用 1 条并推进游标。队列最终失败后下一轮增量为空，镜像同时保留错误开关和过期暂停值。从零重拉纠正两项。传输响应由夹具提供，应用与游标推进使用生产逻辑。[镜像跳行](../../lib/bot/sync/bot-installations.ts#L48) · [进度与计数](../../lib/sync/handlers/base.ts#L223)                                                                                  | 挂起写入期间保留远端更新，或在确认和失败时按安装主动重读，验证无新 Host 编辑也能收敛。                           |
| **B25 · Host 卸载没有向增量镜像发布删除标记**                  | 先增量读到安装，再卸载。用前一次游标读取，结果为零行、零个删除 ID。显式补入删除标记后，同一读法得到预期 ID。在线 `/bots` 会轮询 Host。本结论针对依赖持久化镜像的读取。[卸载写入](../../lib/db/bot-installations.ts#L417) · [增量协议](../../lib/sync/delta.ts#L41) · [在线读取](../../hooks/bots/use-bot-host-read.ts#L55)                                                                                                                     | 同一事务删除安装并记录删除 ID。验证已同步过的配对端下一次增量即可清除镜像。                                      |
| **B26 · 配对触发器可能已入队，调用却报告失败**                 | 在 `disabled`、`needs_setup` 镜像上，修改触发器均已写入本地并产生 pending 命令，随后通用更新试图在镜像取消任务，抛出所有权错误。启用状态的对照则正常入队。另据源码，正常入队时 UI 会直接提示已启用，此时 Host 仍可能尚未处理。[远端路径](../../lib/bot/control-writes/remote.ts#L135) · [写后取消](../../lib/db/bot-installations.ts#L241) · [UI 回执](../../hooks/bots/use-bot-control-writes.ts#L143)                                        | 三种安装状态下均分别呈现提交中、已应用、失败。已入队的操作能凭同一命令 ID 跟踪，镜像修改不触发本机执行逻辑。     |
| **B27 · 相同安装请求在插件升级后返回不同的业务回执**           | 相同操作 ID 在目录未变时重放成功，钩子只运行一次。升级目录版本后，安装行仍在，相同请求却报目录已变。Host 业务层先核对当前目录，再读安装回执。原生中继的 24 小时幂等缓存可覆盖其中一部分重复请求。[校验顺序](../../lib/bot/control-writes/lifecycle-host.ts#L171) · [回执](../../lib/bot/control-writes/lifecycle-host.ts#L205) · [中继缓存期限](../../crates/cognia-companion-security/src/idempotency.rs#L19)                                 | 在业务层验证同一授权主体、同一请求的已完成回执可跨目录版本重读，复用 ID 但改变输入仍应报冲突。                   |
| **B28 · 用列表返回的事件 ID 排除取消，恰好取消了要保留的任务** | `listDeliveries` 返回规范 ID `bev_bot_report-7`。把它交给 `cancelResource.exceptEventId`，目标仍被取消。改用入队时的 `report-7` 可以保留。另有契约限制，同一安装内两个仓库均用资源 ID 7 时，按 ID 取消会同时命中两者。[列表输出](../../lib/plugin/api/bots-api.ts#L315) · [取消筛选](../../lib/plugin/api/bots-api.ts#L119) · [资源身份](../../packages/plugin-contract/src/types/bot/event.ts#L43)                                            | 让查询返回的标识可直接传给写接口。对有作用域的资源提供无歧义筛选，并验证例外项存活。                             |
| **B29 · 两个匹配触发器被报告为两个安装**                       | 一个接收安装声明两个匹配触发器，`emit` 返回 `matchedInstallations: 2`，两条投递属于同一安装。另测同一个发送 run、相同 type 和 payload，仅将资源 A 改为 B，队列保留 A。改变 payload 才新增 B。后者符合当前哈希定义，构成表达两个不同业务事件的限制。[计数与哈希](../../lib/plugin/api/bots-api.ts#L358) · [响应](../../lib/plugin/api/bots-api.ts#L388) · [公开契约](../../packages/plugin-contract/src/types/bot/api.ts#L217)                  | 去重计算命中的安装数。若作者需要分别发布两个资源，提供显式事件标识，同时保留同一事件重入去重。                   |
| **B30 · 迟到的监控结果可倒退最近成功时间并清除新错误**         | 同一安装较新运行写入成功时间 2100，随后写入错误和重试时间 2400。较旧运行迟到，提交成功时间 1750，最终监控时间倒退为 1750，错误和重试时间一并消失。两个仓内 GitHub Bot 的确会将一次扫描的时间传给此 API。[覆盖逻辑](../../lib/plugin/api/bots-api.ts#L143) · [Devin Bot](../../plugins/github-devin-bot/src/monitor.ts#L367) · [Comment Bot](../../plugins/github-comment-bot/src/handler.ts#L81)                                               | 保证较旧观测无法覆盖较新观测。以相反完成顺序验证时间、错误、重试时间三者一致。                                   |

### 旧结论的修订与被排除的推断

- **B11 的适用面比首轮广。** 两个正常触发器共享并发键时，同一个答复既让等待者完成，又单独启动了一次 handler。按资源取消的 pending 子项虽然已 `dismissed`、显式 Retry 返回 false，仍可被同键等待当成答复。复用同一键时，新一轮还能取到早于本 run 的旧答复。SDK 入队会自动加安装前缀，等待直接使用原字符串。短键超时，完整键命中。Python helper 还缺少 TypeScript 已有的 `triggerId` 筛选参数。建议明确答复的有效时间、取消语义、关联键命名空间、触发器与消费方，再让唤醒和读取共用同一判定。[生产等待](../../lib/bot/runtime/step.ts#L423) · [队列匹配](../../lib/db/bot-event-deliveries.ts#L825) · [命名空间](../../lib/plugin/api/bots-api.ts#L104) · [Python 参数](../../plugin-sdk/python/src/cognia/bot.py#L205)
- **B13 已落到两个仓内实例。** 使用 GitHub Devin Bot 和 GitHub Comment Bot 的真实配置 schema，配对安装面板构造的请求都因缺少必填字段被 Host 拒绝，安装行数为 0。向同一 Host 请求显式补入合成必填配置即可安装。本轮没有使用 GitHub 账户。另有 API 差异，本机手动运行保留字符串输入，配对 Host 命令会将它变为 `{}`。当前 UI 表单提交对象，这项差异直接影响 API 调用者。[表单](../../components/bots/install-bot-sheet.tsx#L177) · [Devin 清单](../../plugins/github-devin-bot/plugin.json#L144) · [Comment 清单](../../plugins/github-comment-bot/plugin.json#L248) · [Host 手动输入](../../lib/companion/desktop-write-source.ts#L2459)
- **B14 需要区分运行总时长和活动执行时间。** 公开契约写的是单次 run 的墙钟上限。本轮用配合取消信号的 handler 设置 200 ms 上限，等待 400 ms 超时且正常恢复，run 仍成功。现有审批用例明确要求挂起时不计活动时间。因此“挂起期间达到总时限应强制取消”属于待确定的产品语义。B14 原先已复现的非协作 handler 阻塞仍成立。[公开契约](../../packages/plugin-contract/src/types/plugin/plugin-bot.ts#L286) · [计时器](../../lib/bot/runtime/run.ts#L490) · [对照测试](../../lib/bot/runtime/run.test.ts#L446)
- **缩小三个外推。** B10 的注册缺口在重载时有明确源码路径，正常 Brain 冷启动按序等待插件初始化，当前证据不能推算启动丢单率。B16 另有一项故障注入观察，准备卸载钩子快照时读取失败会留下安装行，而钩子本身抛错可继续删除。预运行死信重新耗尽尝试后，本机 Retry 可以再次重置它。这是两次有效调用，缺乏与同一用户手势的关联证据，未计为重复执行缺陷。[插件重载](../../lib/plugin/bridge/bots-bridge.ts#L99) · [启动顺序](../../lib/headless/bootstrap.ts#L142) · [卸载钩子](../../lib/bot/control-writes/lifecycle-hooks.ts#L85) · [本机重试](../../lib/bot/control-writes/local.ts#L293)
- **已有保护得到复核。** B04 的两个并行控制调用均可返回成功而丢掉一次更新。串行修正后两个触发器都能关闭。B06 的最终放弃路径在 delivery 被清理后仍留下 running 的 run。B09 在另一个夹具中仍能连续三轮跳过可运行的安装。事件路由构造绑定时会合并清单配置默认值，未采纳“所有条件都忽略默认配置”的推断。[控制写入](../../lib/bot/control-writes/local.ts#L103) · [恢复](../../lib/db/bot-event-deliveries.ts#L731) · [路由默认值](../../lib/bot/events/dispatch.ts#L83)

### 与业界做法对照

- **重试与用户意图。** AWS 将请求 ID、语义等价的响应及迟到重试放在同一个契约里。B27 可以用“升级前成功、升级后用原 ID 再问”验收。B17 还需要表示两个不同手势的先后顺序，单次幂等键只标识其中一个手势。[AWS Builders’ Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
- **同步与恢复。** Kubernetes 的 list/watch 使用资源版本追踪进度，历史不可用时重新列举。对 B24、B25，可复用 Cognia 现有的更新游标、删除标记和按实体重拉机制，让一次跳行或卸载仍有明确的收敛路径。[Kubernetes API Concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- **超时的边界。** Temporal 区分整个执行和单次运行的时间上限。对 Cognia，先分别定义等待、重试和活动执行计入哪一个限额，才能为 B14 编写无歧义的验收用例。[Temporal Glossary](https://docs.temporal.io/glossary#workflow-execution-timeout)

### 本轮复核方法

同模型的三个独立审阅分别检查了执行与重试、控制与同步、插件与 SDK。主审对照生产源码，并独立运行核心保留期、重试、计时和调度探针。四个新 Jest 套件共 **36 项**（11 + 11 + 10 + 4），包含交叉复现、正对照和故障注入。首轮 23 项反例全部重现。本轮另跑仓库内 8 套相关回归共 157 项、Python SDK 原有 62 项，全部通过。内嵌 Python Host 使用原脚本和两个真实 stdio 子进程。Jest 使用生产逻辑和 fake IndexedDB，配对传输、外部提供方和实际断电均未接入。完整 Rust Host + Brain 的准备仍受 4 GiB 空间门槛限制。

本机探针保存在忽略目录。下列命令可在当前工作目录复核。每一行的行为、对照与生产入口也已列在上表。成功的反例断言表示观察到了相应故障。

```sh
pnpm test --config .cache/bot-adversarial-control-20261118/jest.config.mjs --runInBand
pnpm test --config .cache/bot-adversarial-retries-20261118/jest.config.mjs --runInBand --testTimeout=45000
pnpm test --config .cache/bot-adversarial-sdk-20261118/jest.config.mjs --runInBand
pnpm test --config .cache/bot-adversarial-core-20261118/jest.config.mjs --runInBand
plugin-sdk/python/.venv/bin/python -B .cache/bot-adversarial-sdk-20261118/sdk_host_probe.py
```

## 修复与复核（2026-11-20）

B01–B30 已在 2026-11-19 的 11 个提交中修复。2026-11-20 对照 HEAD `785d0d8572` 逐项复核：重跑审计留下的 6 组探针（59 项反例），反例在当前代码上全部不再成立。其中 9 项是因为接口改名或测试用了未带安装前缀的关联键而失败，这些项另以生产路径写探针复核（`.cache/bot-audit-verify-20261120/`）。另跑 Bot 相关 122 套 Jest（2412 项）、Python SDK 71 项和 `cognia-plugin-runtime` 的 `python::commands` 41 项（真实 Python）。复核新发现 4 处缺口和 1 处兼容死代码，已修复。

| 编号                         | 修复提交                                 | 复核结论                                                                                           |
| ---------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| B01、B02                     | `20a3e10283`                             | 已修复；补测过期审批按拒绝处理（`16914d3bfe`）                                                     |
| B03                          | `2e15ba4577`                             | 已修复：至少执行一次，同一步骤的每次尝试拿到同一个幂等键；Python 改为 `step_run`                   |
| B04                          | `5c045c8540`                             | 已修复；同类缺口另修，见下                                                                         |
| B05、B06、B09、B19、B21、B22 | `70aa109493`                             | 已修复                                                                                             |
| B07、B08、B23                | `4467048e73`、`f113b9bd46`               | 已修复；未声明并发键的轮询时隙改为按触发器串行                                                     |
| B10、B11                     | `6e9e361cfb`                             | 已修复；用带前缀的生产关联键复核“一次答复只唤醒等待者”                                             |
| B12                          | `2dce690c8d`、`f113b9bd46`               | 已修复：定义版本和运行配置都在首次进入时固定                                                       |
| B13                          | `b22e41d0b7`、`2dce690c8d`               | 已修复；`needs_setup` 文案改了但旧测试未改，已补（`16914d3bfe`）                                   |
| B14                          | `70aa109493`、`2dce690c8d`               | 已修复，口径为执行时间；耗尽预算的运行原先记为普通取消，现改为失败并写明原因（`4e54f87a9b`）       |
| B15、B24、B25                | `e79790494f`                             | 已修复                                                                                             |
| B16                          | `70aa109493`、`5c045c8540`               | 已修复                                                                                             |
| B17                          | `5c045c8540`                             | 已修复；删除派发时升级旧值命名键的兼容代码，并修订 ADR-0174（`886157baa8`）                        |
| B18                          | `474cfd687e`                             | 已修复；内嵌 Host 的 Rust 测试用真实 Python 通过                                                   |
| B20                          | `5c045c8540`、`b007bb6104`、`f113b9bd46` | 已修复 ID 增长；修复让投递面板找不到重试后继，导致重复提供 Retry，已修复；触发器 ID 限制为 64 字符 |
| B26、B27                     | `5c045c8540`                             | 已修复                                                                                             |
| B28、B29、B30                | `654ee2d357`                             | 已修复；`needs_setup` 写入用的是旧 monitor 快照，已修复（`590837eb54`）                            |

复核新发现的缺口：

- **重试后继链接（B20 回归）。** 后继 ID 改为摘要后，投递面板仍按 `retry:<deliveryId>` 查找，重试后链接丢失、Retry 重复出现。配对镜像只有外壳 envelope，所以改为在后继行上记录 `retryOf`，同步投影也携带它。
- **预算耗尽（B14 余项）。** 耗尽预算原先记为 `cancelled`，原因写的是 “cancelled”，也不发布 `bot.run.failed`。现在记为失败，原因写明预算，不自动重试，重放会以新预算开始新运行。人工取消仍是取消。
- **`needs_setup` 写入覆盖 monitor（B04、B30 同类）。** 工作区获取和外部 Agent 两处用运行开始时读到的 monitor 整体覆盖，并且不写 `lastErrorAt`。现在统一由 `holdBotInstallationForSetup` 基于最新行合并。
- **兼容死代码。** 删除 `normalizeLegacyBotWriteKey` 和 `botDeliveryId` 的两参数旧格式，生产代码已不再生成这两种格式。

用户 2026-11-20 对三项待定问题都选了推荐方案，已在 `f113b9bd46` 实现：运行配置在首次进入时固定，恢复和重试都沿用这份（B12）；没有声明 `concurrencyKey` 的 poll/derivedState 时隙按触发器串行（B08，复现探针已不再成立）；清单校验、CLI lint 和本机定义都拒绝超过 64 字符的触发器 ID（B20）。

## Problem frame

审计对象是非 IM 自动化从安装到结果可追踪的整条路径。核查依据为 2026-11-18 的当前工作树，开始时 HEAD 为 `8bfa0b59ed`，工作树有其他并行改动。对问题的确认以具体调用、输入、输出及反例为准。运行时没有使用真实账号、模型或外部业务服务。

## Knowledge

| ID  | Statement                                                          | State       | Basis                                                            | Depends on |
| --- | ------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------- | ---------- |
| G1  | 分析 Bot 核心机制、识别问题并与业界实践比较。                      | Agreed      | 2026-11-18 用户请求                                              | -          |
| C1  | 范围为控制面、非 IM 入口、执行器、队列、SDK、配对只读投影。        | Observed    | 用户范围与 ADR-0174                                              | G1         |
| O1  | 当前实现具备确定性投递、事务领取、可挂起步骤和运行日志。           | Verified    | 本报告运行路径、存储实现与定向回归                               | C1         |
| O2  | 人工决策、子任务终态、步骤结果和安装变更均存在可观测的交接错误。   | Verified    | B01–B04 合成数据与真实组件的组合探针                             | O1         |
| O3  | 排队、恢复、订阅、升级、安装与配对读模型在特定边界下产生不同结果。 | Verified    | B05–B15 的具体条件、对照与源码；B05 的成功发布停机窗口是源码推断 | O1         |
| H1  | 上述条件在生产中的频率和外部损失可以从本地探针推算。               | Invalidated | 探针没有真实部署的频率、流量或外部回执                           | -          |
| Q1  | 真 Host 重启、配对设备和实际插件进程能覆盖哪些额外边界？           | Open        | 原生准备的空间检查未通过；进程内证据范围见下                     | -          |
| G2  | 对既有结论作对抗性审查并查找其他相关问题。                         | Agreed      | 2026-11-18 用户追问                                              | G1         |
| O4  | 第二轮在公开控制、运行终态、SDK 和数据保留中确认另外 15 组问题。   | Verified    | B16–B30，以及已有结论的交叉验证                                  | G2         |

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| scale        | high   | 触及插件 SDK、调度、持久化、四类执行器、桌面与 Brain、镜像。 |
| technical    | medium | 状态机与事务已有实现，关键在交接时机与返回值契约。           |
| coupling     | high   | runId、deliveryId、SDK 形状、暂停和升级影响多处消费者。      |
| requirement  | low    | 用户要求机制分析、问题证据和业内对照，范围明确。             |
| verification | high   | 边界可本机注入，真实进程停机、外部回执和配对同步需独立验收。 |
| risk         | high   | 假成功、重复执行或覆盖配置会改变用户可观察结果。             |

## Risks

| ID  | Risk (impact)                                                                  | Severity | Source                                   | Claim                                          | Refuted by                                       |
| --- | ------------------------------------------------------------------------------ | -------- | ---------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| R1  | 决策或运行状态传错，依赖方执行错误分支。                                       | high     | ADR-0174、独立执行器审阅                 | 批准、失败、取消和成功跨层保持含义。           | 子失败映射为父成功；失败订阅没有投递。           |
| R2  | 在重试或升级中重复动作，或混用不兼容的业务输入。                               | high     | SDK 契约、Inngest、Temporal              | 完成记录重放与未记录副作用的语义能被作者区分。 | 缓存命中进入 Python 步骤体，或重试重复本地动作。 |
| R3  | 操作被覆盖、旧 tick 或错误事件获准处理。                                       | high     | ADR-0174、竞态探针、Kubernetes           | 写入、关闭和关联等待在所有入口遵循相同规则。   | 两次保存成功却有一个更新消失，或无关事件被消费。 |
| R4  | 可运行工作或结果在队列和镜像中丢失。                                           | high     | 队列故障审阅、配对协议、SQS              | 无关安装可取得工作，近期终态可从配对投影读到。 | 就绪行持续跳过，或当天终态无法同步。             |
| R5  | 生命周期、重试身份和结果读取跨层失配，导致卸载后仍运行、详情丢失或输出不一致。 | high     | B16–B30，两个真实 Python Host 脚本子进程 | 每次已确认的写入、终态与对外读取可互相核对。   | 命令收据、run 日志、详情、检查点或镜像出现矛盾。 |

## Verification obligations

| ID  | Risk           | Method                                                                  | Independence | Evidence                                                                                                                                    | Coverage                                                                 | Status  |
| --- | -------------- | ----------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------- |
| V1  | R1,R2          | 检查生产调用链并使用合成子运行、审批、检查点失败和受控 Promise。        | subagent     | B01、B02、B03、B05、B12、B14 的实际结果见问题表；集中复核命令见下。                                                                         | 生产执行器及持久化代码，外部提供方和物理崩溃使用替代边界。               | passed  |
| V2  | R3             | 并发调用公开控制接口，回放 tick，运行同一主机安装命令，并注入等待时钟。 | tool         | B04、B07、B08、B11、B13，包含超时无事件对照。                                                                                               | fake IndexedDB、合成清单、生产控制与步骤逻辑。                           | passed  |
| V3  | R1,R4          | 运行有序队列、最后一次尝试、注册恢复和保留期的正反例。                  | subagent     | B05、B06、B09、B10、B15 均观察到表内记录与查询结果。                                                                                        | 单机数据模型，模拟重启时已存状态和同步时间。                             | passed  |
| V4  | R1,R2,R3,R4    | 运行仓库定向 Jest、Python SDK、进程验收工具自测。                       | tool         | 23 套 Jest、501 项，Python 62 项，harness 10 项均通过。                                                                                     | 回归证据；独立 Workflow 集成见 V5。                                      | passed  |
| V5  | R1             | 单独重跑 Workflow 集成并检查进程退出。                                  | tool         | 4 项断言通过，随后 Jest teardown 后仍有 Workflow fanout 异步导入，退出码 1。                                                                | 测试生命周期；未据此推断生产工作流失败。                                 | failed  |
| V6  | R1,R2,R4       | 准备并运行隔离的 Rust Host + Brain 进程验收。                           | real-env     | pnpm test:e2e:bots:prepare 报 Bot E2E preparation needs at least 4 GiB free disk space。当前无 build receipt，Cargo 目标目录亦无已建 Host。 | 本轮未启动进程验收。                                                     | blocked |
| V7  | R1,R2,R3,R4,R5 | 以独立审阅和正常公开入口验证重试、卸载、SDK、保留期和配对镜像。         | subagent     | 四个新 Jest 套件 36 项、首轮反例 23 项、真实内嵌脚本 stdio 探针；各项对照、边界与读数见本轮复核。                                           | fake IndexedDB、生产函数、隔离子进程，网络与 Rust 宿主未进行设备级联测。 | passed  |
| V8  | R1,R2,R5       | 复核运行详情、步骤存储、控制与调度等现存回归。                          | tool         | 本轮 8 套 Jest 共 157 项、Python SDK 62 项通过。                                                                                            | 仓内单测，故障复现另见 V7。                                              | passed  |

## 复核方法

复核夹具保存在本工作树忽略的 `.cache/bot-core-audit-2026-11-18/`。Jest 探针的通过表示观察到了问题表内写明的现状，同时包含正常路径作对照。集中重跑共 5 套、23 项通过，耗时 9.239 秒。另用实际 Python SDK 及内存 Host stub 观察到 body_entries=2、checkpoints=1。上表保留各项输入、预期及源码锚点。

```sh
pnpm test --config .cache/bot-core-audit-2026-11-18/jest.config.mjs --runInBand
PYTHONPATH=plugin-sdk/python/src plugin-sdk/python/.venv/bin/python .cache/bot-core-audit-2026-11-18/python_step.py
PYTHONPATH=plugin-sdk/python/src plugin-sdk/python/.venv/bin/python -m pytest -q plugin-sdk/python/tests/test_bot.py
pnpm test:e2e:bots:harness
pnpm test --runInBand --runTestsByPath lib/bot/runtime/executors/workflow.integration.test.ts
```

首次 19 套 Jest 合跑显示 433 项断言通过，命令退出 1。单独运行 Workflow 集成复现了 `Jest environment has been torn down`；去掉该套并加入注册、SDK、调度、因果链等用例后，23 套均以 0 退出。检查宽度以这里实际列出的执行层次为准。

## Decisions

| ID  | Date       | Decision                                                                           | Action   | Based on | Reversal trigger                                             |
| --- | ---------- | ---------------------------------------------------------------------------------- | -------- | -------- | ------------------------------------------------------------ |
| D1  | 2026-11-18 | 先定位跨层行为并对照源码，保留现有执行架构。                                       | diagnose | G1,C1,O1 | 发现另一套生产 Bot 控制入口。                                |
| D2  | 2026-11-18 | 首批验收针对 B01–B04；第二批围绕终态发布、队列恢复和调度准入；其余按使用场景排期。 | diagnose | O2,O3    | 线上频率、影响范围或版本兼容目标改变优先序。                 |
| D3  | 2026-11-18 | 将 B16–B19 与首轮四项同排首批；B14 的总时长和活动时长另外澄清。                    | diagnose | O4,G2    | 真实设备验收结果、采用的 Python 作者接口或计时契约发生变化。 |

## Residual risks

| ID  | Residual                                                                                                                                                            | From            | Why still open                                                           | Next action                                                                    | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------ |
| X1  | Native Host 停机恢复、实际配对设备、独立插件进程和外部副作用回执。                                                                                                  | V6,R2,R4        | 本轮仅有合成事件、本机 SDK、存储及执行边界证据；进程准备受磁盘门槛限制。 | 在有足够空间的隔离环境重跑进程用例，给已发现的失败窗口加入可观测的接收端回执。 | open   |
| X2  | Workflow 集成测试在 teardown 后仍有异步工作。                                                                                                                       | V5              | 单独执行重现，未修复测试或运行时代码。                                   | 追踪并等待 fanout 完成，再复核返回码。                                         | open   |
| X3  | 实际流量中的发生率、重试副作用、升级兼容策略及队列延迟。                                                                                                            | R2,R4           | 局部行为不能量化真实用户损失，固定或迁移版本还涉及产品选择。             | 结合真实安装版本与队列观测确定发布顺序。                                       | open   |
| X4  | B12 配置固定、poll 时隙默认串行、触发器 ID 长度上限三项产品决定。                                                                                                   | 2026-11-20 复核 | 用户已选定。                                                             | 已在 `f113b9bd46` 实现并补测试。                                               | closed |
| X5  | plugin-contract 源码有改动（`plugin-bot.ts` 的触发器 ID 上限常量和注释、`validation.ts`、`types/bot/run.ts`），authoring kit 的 pin 尚未重建；`docs:build` 未运行。 | 2026-11-20 复核 | 磁盘余量约 10 GiB，kit 需要在干净 checkout 中重建。                      | 下次重建 kit 时一并处理，再跑 `pnpm docs:build`。                              | open   |

## Outcome

| ID  | Signal                                                                    | How / when measured                                                          | Result                                                                                              | Status |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| M1  | 用户能识别 Bot 的职责、判断哪些契约会失效，并拿到逐项复核方式及业界依据。 | 2026-11-18，源码调用链、定向回归、独立探针与官方文档。                       | 交付运行路径、15 组问题、适用条件和修复验收；本次仅做审计。                                         | met    |
| M2  | 分清新增问题、首轮结论覆盖范围和需要产品决定的语义。                      | 2026-11-18，独立审阅、可读源码、故障注入和正常入口对照。                     | 新增 15 组已复现的问题，补充等待、安装、计时等边界，给出首批修复验收。真实设备验收仍开放。          | met    |
| M3  | B01–B30 修复后，审计反例在 HEAD 上不再成立，复核发现的缺口也已修复。      | 2026-11-20，重跑 6 组探针、122 套 Jest、Python SDK、内嵌 Host 的 Rust 测试。 | 59 项反例均不再成立；修复 4 处缺口，删除 1 处兼容代码；3 项决定已实现。真实 Host 和设备验收仍开放。 | met    |
