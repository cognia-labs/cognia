# 个人助理模式缺口审计

- Status: verifying
- Lane: standard
- Created: 2026-11-17
- Updated: 2026-11-22
- Related: ADR-0117, ADR-0239, ADR-0243, ADR-0252, [Phase 2 实施计划](../plans/2026-11-22-personal-assistant-phase2-implementation.md)

## Original request

> 帮我分析一下现在的个人助理模式的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

> 继续研究相关模块，发现更多的问题

## Problem frame

本轮覆盖 Inbox 的 `assistant` 行为预设，以及身份、记忆、主动发现、长期执行、审批、交付和跨设备组成的持续助理体验。成功标准为当前能力清单、可复现问题、证据强度、行业对照和补全顺序。

源码中 `assistant` 写入 `autonomy: "act"`，engagement 跟随执行目标。持续工作能力另有 Scheduler、Bot、Goal、Delegation、Memory 和 Radar 入口。聊天自定义模式的 `personal` 分类提供默认提示词。将这些相关层纳入检查，是本轮采用的范围解释。[预设](../../lib/connectors/composition/im-mode-presets.ts#L50) · [分类提示词](../../stores/agent/custom-mode-store/helpers.ts#L158)

取证日期为 2026-11-17，时区 Asia/Shanghai。HEAD 为 `34e6103799`，工作区含并发未提交内容，包括 `lib/connectors/bus.ts` 和 `bus.runtime.test.ts`。结论描述本轮工作区。CodeGraph 返回 `Not initialized`，导航采用文本搜索和调用路径检查。本轮产品源码修改数为 0，临时探针测试执行后清理。

## Knowledge

| ID  | Statement                                                                    | State        | Basis                                                                        | Depends on |
| --- | ---------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------- | ---------- |
| G1  | 分析个人助理能力、缺口与问题，对照行业实践。                                 | Agreed       | 2026-11-17 用户请求。                                                        | -          |
| G2  | 继续研究相关模块并发现更多问题。                                             | Agreed       | 2026-11-17 用户追加请求。                                                    | G1         |
| O1  | 四预设映射 autonomy/engagement，执行目标独立解析。                           | Verified     | 2026-11-17 源码与 V1 的预设、effective-config、runtime、组件测试。           | -          |
| O2  | 活动自动回复进入 live-steer 后，切为 Silent/Draft 的后续消息仍可进入该运行。 | Verified     | 2026-11-17，V2 两个回归断言失败。真实 Bus/coordinator，终端 steer 使用替身。 | -          |
| O3  | Silent 下匹配 Workflow、Bot 和首次欢迎卡仍可触发。                           | Verified     | 2026-11-17，V3 的 manual-store、fan-out 和 welcome audit 断言通过。          | -          |
| O4  | 收件人授权缺省为 shadow，各操作类别分别配置 enforce。                        | Verified     | 2026-11-17，policy.ts:79–108、plan-delivery.ts:383–397，V4 的相关用例。      | -          |
| O5  | Draft 对 Direct、Team、Workflow 依次确认回复、计划、启动请求。               | Verified     | 2026-11-17，runtime 三个分支和 V1 的现有 runtime 测试。                      | -          |
| O6  | Radar 读取 memory/capture，接受建议后创建需验收 Goal。                       | Verified     | 2026-11-17，采集与 runner 调用链，V1/V4 的对应测试。                         | -          |
| O7  | 常驻 Host、事件调度、记忆治理、Delegation 恢复和交付版本机制已存在。         | Observed     | 2026-11-17，能力表列出的实现。V4 验证部分机制。                              | -          |
| O8  | 行业参考提供持续责任、云端调度、分级授权和恢复/投递状态管理。                | Observed     | 2026-11-17 阅读 Sources 中的厂商官方文档。                                   | -          |
| O9  | 现有 22 suites / 736 tests 全通过。                                          | Verified     | V1 为 440，V4 为 296，两轮套件集合无重复。                                   | -          |
| O10 | 草稿批准复用原 deadletter job，状态转换竞争可覆盖拒绝或批准。                | Verified     | 2026-11-17，V8，F13/F14，真实 DB 与 3 个行为断言。                           | -          |
| O11 | Radar 跨账户保存，记忆删除可跨 runtime target 提交。                         | Verified     | 2026-11-17，V11，F11/F12，真实加密 DB/Browser Vault。                        | -          |
| O12 | 完成统计可撤销暂停并丢计数，一次性重试在重启后失去调度。                     | Verified     | 2026-11-17，V10，F15/F16，公开 scheduler 入口和真实持久化。                  | -          |
| O13 | im-push 取消后仍 enqueue，投递后 audit 失败可产生不同身份的重试。            | Verified     | 2026-11-17，V10，F17/F18，真实 executor，enqueue/audit 注入替身。            | -          |
| O14 | headless 合并通知的新 occurrence 不再广播。                                  | Verified     | 2026-11-17，V10，F19，真实 notification runtime 与 fixture transport。       | -          |
| O15 | outbound runner 停止后仍可新发，双实例恢复交错暴露可重试中间态。             | Verified     | 2026-11-17，V9，F20/F21，真实 runner 与 fake adapter。                       | -          |
| O16 | Radar 取消后保存，旧报告接受与保留清理竞争会丢历史入口。                     | Verified     | 2026-11-17，V11，F22/F23，真实 executor/DB，模型和任务注册替身。             | -          |
| O17 | 本轮既有 16 suites / 525 tests 通过，19 个最终探针运行完成。                 | Verified     | 2026-11-17，V8–V12，追加研究的命令与日志。与首轮套件有重叠。                 | -          |
| H2  | Radar 来源删除、recall 可采纳性及手动/自动重叠需要进一步定义产品契约。       | Hypothesized | V11 的 3 项机制观察及当前调用方，尚无完整契约。                              | -          |
| A1  | 首批个人助理优先服务单一所有者的日程、消息、承诺及持续任务。                 | Hypothesized | 用于建议排序的产品假设，目标用户画像待确定。                                 | -          |
| Q1  | 用户实际启用的 Host、连接器、模型及权限类别。                                | Open         | 本轮使用源码和本地测试数据库。                                               | -          |

## 当前已经具备的能力

| 用户任务             | 当前基础                                                                                                | 取证入口                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 从 IM 自动处理请求   | Direct、Team、Workflow 路由，持久入站记录、排队、恢复及去重                                             | [runtime](../../lib/connectors/runtime.ts#L1865) · [bus](../../lib/connectors/bus.ts#L1095)                                                   |
| 周期性或事件驱动工作 | 对话式 once/cron/interval/event 任务，Bot 的 interaction/event/schedule/poll/derivedState/manual 触发器 | [任务](../../lib/scheduler/conversational-task-authoring.ts#L158) · [Bot](../../packages/plugin-contract/src/types/plugin/plugin-bot.ts#L136) |
| 日历和任务操作       | 内置 Lark 日历读写、忙闲、会议室及任务工具                                                              | [日历](../../lib/skills/built-in/lark/calendar.ts#L137) · [注册](../../lib/skills/built-in/lark/index.ts#L19)                                 |
| 长期记忆与治理       | 调用方范围授权、纠错、删除、失效、批量操作及学习关闭后的清理                                            | [调用方权限](../../lib/memory/api/caller.ts#L18) · [治理](../../lib/memory/control-plane/manage.ts#L130)                                      |
| 主动发现并采取下一步 | Radar 报告、来源引用、接受/忽略建议、稳定任务 ID、创建需验收 Goal                                       | [报告](../../lib/radar/radar-runner.ts#L43) · [建议](../../lib/radar/suggestions.ts#L18)                                                      |
| 跟踪执行和交付       | Delegation 义务与替代 attempt、恢复状态、交付快照/digest/版本确认                                       | [Delegation](../../lib/execution/delegation.ts#L243) · [版本](../../lib/issues/deliverables.ts#L23)                                           |
| 人工决策             | Attention 聚合聊天工具审批、团队 gate、运行审批，Scheduler 提供关注项和 agenda                          | [Attention](../../lib/attention/project.ts#L70) · [Scheduler](../../app/scheduler/route-body.tsx#L283)                                        |
| 笔记本休眠后继续工作 | 自建常驻 Host、手机/桌面配对、按条目迁移和无人值守权限                                                  | [Host](../content/docs/zh/companion/always-on-host.mdx#L6) · [迁移](../../lib/remote-host/migration/service.ts#L365)                          |

建议复用这些实现，并用完整用户旅程检验连接效果。

## 发现与补全建议

P1 表示直接影响可控性、核心助理流程或持续交付，P2 表示重要语义和体验补全。排序采用 A1 的用户场景假设。

### F1 · P1 · 模式收紧被 live-steer 路径绕过

**本地复现。** 保持一条自动回复运行，设置 `activeRunDispatchMode: "steer"`，将同一会话切为 Silent 或 Draft，再发送普通消息。两种情况都记录了 `inbound_live_steered`。

入站已得到 `manual-store` 或 `draft-prepare`，但 `enqueueRouteHandlerTurn` 选择 live-steer 时主要检查队列深度、steer 配置、处理器和 PII。当前路由决策未约束注入。coordinator 检查 provider、注入防护及 admit，bootstrap 的 admit 执行 PII 检查。排队路径另有 dequeue 时的 autonomy 收紧。[bus](../../lib/connectors/bus.ts#L1744) · [排队重检](../../lib/connectors/bus.ts#L1937) · [coordinator](../../lib/connectors/live-steer.ts#L35) · [bootstrap](../../lib/connectors/bootstrap/install-connector-runtime.ts#L658)

Silent 后的新消息可能继续进入 Agent，Draft 内容可能进入既有自动回复。Web/手机切换模式时跳过 `agent_interrupt`，桌面 interrupt 为 best-effort。[切换组件](../../components/inbox/mode-switcher.tsx#L103)

**补全方向。** 将当前 autonomy、已接纳权限上限、运行归属及输入修订纳入 live-steer admission，明确定义模式收紧对活动运行及后续发送的处理。

**验收。** 覆盖 Assistant → Silent/Draft、工具/媒体撤权、终端注入失败、已有部分输出。拒绝后仍能从持久记录恢复。当前复现到 Bus/coordinator 边界，实际模型消费与外部投递待实机验证。

### F2 · P1 · 收件人授权默认处于 shadow

**源码和机制测试确认。** 缺失设置时返回 `shadow`，只有精确配置 `enforce` 才强制该类别的收件人授权。messaging、github、browser、integration 独立配置。投递规划的 shadow 分支可记录 draft/deny，同时返回允许发送的决定。[默认值](../../lib/policy/action-review/policy.ts#L79) · [投递分支](../../lib/policy/action-review/plan-delivery.ts#L383)

个人助理对外动作需要检查各类别的有效 enforcement。工具审批、个人数据/凭据保护和沙箱分别参与决策。用户实际账户开关属于 Q1。

**补全方向。** 提供个人助理授权配置引导，展示接收人、账号、用途、范围与强制模式。调整默认值前，通过影子记录评估兼容及迁移影响。

**验收。** 无授权第三方、原会话回复、已有授权、拒绝后换工具、无人值守及类别独立配置均产生预期结果，单次批准范围在后续调用中可核验。

### F3 · P2 · Silent 的作用范围需要可见

**本地复现。** 主响应为 `manual-store`，匹配 Workflow 和 Bot 仍收到 fan-out。首次欢迎卡开启时产生 `inbound.welcome_sent`。这是当前响应路径与自动化订阅的组合语义。[fan-out](../../lib/connectors/bus.ts#L1458) · [欢迎卡](../../lib/connectors/help/help-dispatch.ts#L182)

“只记录会话，由人来回答”的文案尚未表达这些独立动作的范围。[文案](../../i18n/messages/zh-CN/inbox.json#L613)

**补全方向。** 菜单展示仍启用的关联自动化，提供覆盖会话相关活动运行和订阅的暂停控制，并标出影响对象，说明欢迎卡策略。

追加复核确认独立自动化的 pause/resume/cancel 命令和 cutoff 已存在，F3 的后续工作应复用该控制并明确 Silent 的范围。[命令](../../lib/connectors/commands/dispatch.ts#L350) · [控制实现](../../lib/connectors/automation-control.ts#L17)

**验收。** 用户能预见主回复、欢迎/帮助通知、Bot 和 Workflow 的切换后行为，暂停结果可读回。

### F4 · P2 · Draft 的确认对象随目标变化

| 目标     | 实际确认对象     |
| -------- | ---------------- |
| Direct   | 完成的回复草稿   |
| Team     | 执行前的团队计划 |
| Workflow | 工作流启动请求   |

统一文案“写好回复，等你确认后再发”覆盖 Direct。Team/Workflow 的最终产物经过后续路径交付。[Team](../../lib/connectors/runtime.ts#L2134) · [Workflow](../../lib/connectors/runtime.ts#L2234) · [Direct](../../lib/connectors/runtime.ts#L3294) · [文案](../../i18n/messages/zh-CN/settings/connections.json#L513)

**补全方向。** 根据 target 命名确认动作，为需要最终发送审核的任务设置显式交付门槛。

**验收。** 计划、工具授权和最终发送审核分别指向准确对象，批准后的可执行动作可提前查看。

### F5 · P2 · 预设与目标绑定带来理解成本

Direct 禁用 `delegate`。绑定 Team 后，选择 Assistant 清除显式 engagement，目标仍派生为 background，反向映射仍可显示 Delegate。[禁用条件](../../lib/connectors/composition/im-mode-presets.ts#L80) · [目标派生](../../lib/connectors/composition/mode-projection.ts#L64) · [反向映射](../../lib/connectors/composition/im-mode-presets.ts#L67)

Direct 当前会创建 `agent-turn` ExecutionRun。预设文件关于其“没有 ExecutionRun”的旧注释需更新。独立单 Agent 后台委派入口及完整运行语义仍需补齐。

**补全方向。** 分开展示响应方式、执行目标、运行 Host 和后台状态。单 Agent 长任务可复用 Goal/Delegation 的跟踪机制。

**验收。** 模式切换反馈可解释，长任务能返回身份、进度、停止/恢复入口和结果。

### F6 · P1 · 主动发现的数据范围与结果触达偏局部

Radar 生产路径读取近期 memory/capture，默认 14 天、最多 60 项输入。runner 未传 extra，日历、邮件和外部任务变更尚未直接进入这条采集路径。[采集](../../lib/radar/collect.ts#L24) · [runner](../../lib/radar/radar-runner.ts#L58)

报告 UI 位于 Pet Console 扩展槽。新建周期报告任务默认 `onComplete: false`、错误通知开启。接受建议后创建的 Goal 开启完成通知并要求验收。[挂载](../../components/radar/module.ui.ts#L3) · [通知](../../lib/radar/radar-cron-bridge.ts#L46) · [Goal](../../lib/radar/suggestions.ts#L47)

**补全方向。** 用已有 Radar/Scheduler/连接器提供“今日安排、待回复、承诺到期、外部变化”简报，展示数据时效、来源、建议原因、下一步和投递目标。配置安静时间、合并频率及紧急程度。

**验收。** 覆盖日程变化、截止提醒、重复事件、来源过期、建议接受/忽略、结果触达、账号断连及恢复。

### F7 · P1 · 常用个人数据源缺少已确认的开箱即用路径

本轮已确认的内置个人事务工具集中于 Lark 日历和任务。在 `lib/skills/built-in`、`lib/integrations`、`components/settings`、`integrations` 和仓内插件检索中，未找到 Gmail、Outlook、Google Calendar 对应的一体化配置和业务操作入口。MCP、外部插件、浏览器及用户本地 Skill 可补充能力，安装和授权状态属于 Q1。

**补全方向。** 按目标用户选择 Lark、Google Workspace 或 Microsoft 365 的首条完整路径，展示读/写能力、账号、授权范围、撤权、时效和失败恢复，服务动作结果关联助理任务。

**验收。** 空配置起步，完成授权、搜索、草稿、确认、写入和服务端读回，覆盖过期凭据、分页、时区及重试去重。

### F8 · P2 · 跨渠道身份与续办需要产品化

会话选择主要依据 `conversationKey`，Lark 同一私聊的 thread 有显式选择规则。统一 principal seam 已存在，当前 vendor 中只有 Lark 贡献 principal registry 和 sign-in links。其他平台返回 legacy，随后仍受各自入站策略及执行/个人数据边界控制。[会话](../../lib/connectors/session-bindings.ts#L170) · [principal](../../lib/connectors/principal/resolve.ts) · [Lark](../../lib/connectors/adapters/lark/contribution.ts#L158)

**补全方向。** 提供经验证的个人身份绑定、工作/私人上下文选择，以及跨渠道选择继续已有任务的入口，复用任务 ID 和 run control。

**验收。** 同一人从桌面转到 IM/手机可明确续办，解绑后停止个人上下文访问，群聊与多用户保有各自权限范围。

### F9 · P1 · 常驻准备流程需要衔接助理入口

现有常驻 Host 支持自建服务、配对和迁移。选择 Assistant 主要写入行为轴和兼容 mode，全天候运行仍需准备运行端。Bot/任务页面已有运行端和能力检查。[Host](../content/docs/zh/companion/always-on-host.mdx#L6) · [模式写入](../../components/inbox/mode-switcher.tsx#L88) · [能力检查](../../lib/scheduler/host-support.ts#L200)

**补全方向。** 委托持续任务时整合已有 Host 状态，展示责任 Host、运行条件、凭据/工具依赖、待审批原因、下次触发和恢复入口。

**验收。** 真实演练笔记本休眠、Host 重启、断网、审批超时、DST、执行完成但投递失败及迁移，检查重复外部副作用。本轮真实部署和离线运行待验。

### F10 · P2 · 面向个人责任的统一业务视图仍可补齐

Attention 已聚合审批，Scheduler 已有 agenda 和关注项，Inbox、Goal、Delegation、交付版本与 Radar 各有入口。当前聚合以执行对象和技术状态为主，个人助理可继续汇总“今天要决定什么、答应我的事还差什么、已交付什么、因何受阻”。这是基于入口和调用链的产品整合判断。[Attention](../../lib/attention/project.ts#L70) · [Scheduler](../../app/scheduler/route-body.tsx#L283) · [Radar UI](../../components/radar/module.ui.ts#L3)

**补全方向。** 按责任/目标聚合既有记录，提供下一检查点、待决策、产物版本、验收状态和简短活动时间线，关联服务端写入结果及可用撤销入口。

**验收。** 同一任务可找到 IM、执行、审批、交付和最终确认，自然语言可指向准确任务进行纠正、暂停及重试。

## 追加研究 · 2026-11-17

用户追加请求为“继续研究相关模块，发现更多的问题”。本轮新增 F11–F23 共 13 项具体缺陷，另记录 3 项需要明确产品契约的机制观察。优先级按隔离、用户控制、交付与恢复的影响排序。

### F11 · P1 · Radar 在账户 A 生成的内容写入账户 B

在 A 开始生成，模型响应等待期间切换活动账户数据库到 B，再完成原响应。B 原有报告数为 0，随后收到含 A 项目事实的 verdict 和 source ID；切回 A 后仍有 5 条原记忆、报告数为 0。

runner 在生成前读取设置与输入，等待模型后保存时重新调用当前 `getDb()`。UI 的异步生成回调没有加入账户切换的 pending-write/runtime cleanup 栅栏。[UI 入口](../../components/radar/radar-panel.tsx#L96) · [生成与保存](../../lib/radar/radar-runner.ts#L68) · [当前数据库保存](../../lib/db/radar-reports.ts#L11)

应在开始时固定账户与持久化作用域，在生成和落库之间检查作用域仍有效，并使切换能够取消或等待这一操作。验收需覆盖切换、锁定、退出登录、模型迟到和回到原账户。

本轮使用真实加密数据库和 Browser Vault，IndexedDB 为 fake-indexeddb，模型为确定性替身。通过生产数据库切换函数复现，完整密码/UI 切换待实机验收。[独立审查与证据](../../.cache/personal-assistant-followup-memory/findings.md)

### F12 · P1 · 记忆删除可落入新选择的 runtime target

在本地 target A 发起删除，等待向量清理期间切到 target B。若 B 有同一 memory ID，完成后 B 的记录被删且写入删除审计，调用返回 `ok:true`；A 原记录仍在。

普通记忆控制台通过 `runMemoryCommand` 进入本地 manage，读取原记录后等待向量 I/O，再以当前数据库执行 canonical delete。默认 commit 直接调用回调，未固定原数据库或验证切换。[路由](../../lib/memory/control-plane/routed-manage.ts#L106) · [读取与删除](../../lib/memory/control-plane/manage.ts#L319) · [向量等待后的提交](../../lib/memory/control-plane/manage.ts#L390) · [canonical delete](../../lib/db/memories.ts#L778)

应把原账户/target 的写入身份贯穿向量和 canonical 操作。已有同步、导入或复制数据可能保留同 ID，这是误删新库记录的条件；新库无该 ID 时也可能返回成功而原库未删。

本轮实测为同账户两个加密 target，向量 adapter 使用 deferred 替身。完整 target 菜单操作和跨账号误删待验。[探针](../../.cache/personal-assistant-followup-memory/probe.test.ts)

### F13 · P1 · 被授权机制暂存的草稿批准后没有可发送任务

真实 `holdOutboundForAuthorization` 将原 job 置为 `deadlettered` 并创建待批草稿，预览保留原 idempotency key。批准入口按这个 key 查到原终态 job，跳过 enqueue，随后把草稿标成 approved。

本地观察为 `draft=approved`、`job=deadlettered`、`enqueueCalls=0`。同一结构也用于发送身份需要重新授权后生成的草稿。[原 job 与草稿原子暂存](../../lib/db/outbound-jobs.ts#L434) · [runner 生成预览](../../lib/connectors/outbound-runner.ts#L946) · [无状态过滤的查找](../../lib/connectors/inbox-writes/local.ts#L129) · [批准分支](../../lib/connectors/inbox-writes/local.ts#L340)

应区分“已成功接纳的批准重放”与“导致这份草稿的旧失败 job”，为批准创建可追踪的新 attempt，并原子绑定草稿决定和交付。验收包含授权暂存、身份重新连接、编辑后批准、重复批准及原 job 保留/清理。

真实 DB、hold 和批准入口已复现。gateway 使用既有测试替身，此次因分支跳过而调用数为 0。[结果](../../.cache/personal-assistant-followup.Y7c0X6/draft-probes.log)

### F14 · P1 · 草稿状态转换竞争会覆盖用户决定

同一状态机存在两个已复现交错。

- 审批读取 pending 后等待 enqueue，另一个控制端先完成 reject；审批继续后最终为 `approved`，并产生 1 个 outbound job。
- 过期清理读取待过期列表后，另一操作先提交 approve；清理继续使用旧快照 bulkPut，最终把 approved 改为 `expired`。

原因是批准/拒绝分离读取后无条件更新，过期清理也没有在提交时重读状态。[批准/拒绝](../../lib/connectors/inbox-writes/local.ts#L340) · [无条件转换](../../lib/db/connector-drafts.ts#L99) · [过期清理](../../lib/db/connector-drafts.ts#L120)

应以事务或 revision/CAS 定义决定的唯一获胜方，并使 job 接纳与状态变更共同提交。对带 `expiresAt` 的记录，清理不能覆盖后来决定。跨设备两次不同决定需返回冲突与最新状态。

两种交错均以真实 IndexedDB 状态操作复现，enqueue 和 bulkPut 前的等待用于控制异步窗口。[结果](../../.cache/personal-assistant-followup.Y7c0X6/draft-probes.log)

### F15 · P1 · 任务完成统计覆盖暂停状态，并丢失并发计数

两个公开 `runTaskNow` 都完成，但数据库只保存 `runCount=1, successCount=1`。另一探针在统计读取后执行公开 `pauseTask`，先确认数据库为 paused，完成回写后却变回 active。

`updateTaskStats` 读取整行，在内存增量，再写回合并后的旧任务行。后续 next-run 更新看到 active，可重新安排任务。[统计读写](../../lib/scheduler/task-scheduler.ts#L3480) · [完整行写回](../../lib/scheduler/task-scheduler.ts#L3517) · [DB 更新](../../lib/scheduler/scheduler-db.ts#L130) · [再次调度](../../lib/scheduler/task-scheduler.ts#L3560)

应事务化统计增量，只更新此操作拥有的字段，保持用户最新 status/config/trigger。验收包括暂停/禁用/编辑与任务完成交错，及并发成功/失败统计、maxRuns 和连续失败规则。

真实 scheduler、SchedulerDatabase 和公开控制接口已复现，原生 timer 再次触发待验。[独立探针](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/findings.md)

### F16 · P1 · 一次性任务已安排的 retry 在重启后失去调度

一次性任务在线执行失败并持久化 `retry-scheduled` 与 `retryScheduledAt`，重试定时器到期前停止并重建 scheduler。重启后 task 仍 active，failed execution 仍承诺 retry-scheduled，但没有 nextRunAt，新 driver 的 `arm` 次数为 0，running/scheduled count 均为 0。

claim 已消费一次性 slot，重试主要依赖内存 timeout。启动恢复处理 running/pending，未恢复这条 failed retry intent，原 once 时间又已过去。[claim](../../lib/scheduler/scheduler-db.ts#L209) · [重试 timer](../../lib/scheduler/task-scheduler.ts#L3168) · [停止清理](../../lib/scheduler/task-scheduler.ts#L1431) · [启动调度](../../lib/scheduler/task-scheduler.ts#L953) · [过去的一次性时间](../../lib/scheduler/task-scheduler.ts#L3634)

应持久化并恢复剩余重试意图，或明确结算为终态并通知用户。验收需从“已提交 retry intent、timer 未执行”的持久状态启动，并核对次数、预算及重复副作用。

本轮使用同进程中新 scheduler 实例模拟重启，真实 DB 和 driver arm 记录已验证，完整应用 crash/restart 待验。[结果](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/probe-output.log)

### F17 · P1 · 取消 im-push 后仍会提交新外发任务

executor 仅初始检查 signal，随后等待目标/配置读取，最后 enqueue 的 options 没有传 signal。在目标读取期间 abort 后再释放，实际观察为 `aborted=true, enqueues=1, result.success=true`。[executor](../../lib/connectors/scheduler/im-push-executor.ts#L112) · [外发接纳](../../lib/connectors/scheduler/im-push-executor.ts#L177)

应在异步准备后重查取消，并把同一 signal 传给已有取消支持的 delivery gateway。验收分别在目标读取、审批、持久接纳和 wire 发送前取消。

真实 executor 已运行，enqueue 使用替身，本轮证明到提交调用边界。[结果](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/probe-output.log)

### F18 · P1 · enqueue 后审计失败可触发另一投递身份的重试

im-push 已 enqueue，随后 `notify.im_pushed` 审计写入失败，整个 executor 返回 failed。默认投递 key 包含 execution ID，scheduler retry 会生成新 ID。探针再次按新 retry ID 执行，得到两个不同 key，首次 failed、第二次成功。[key 与 enqueue](../../lib/connectors/scheduler/im-push-executor.ts#L174) · [enqueue 后审计](../../lib/connectors/scheduler/im-push-executor.ts#L218) · [统一失败返回](../../lib/connectors/scheduler/im-push-executor.ts#L242) · [retry 生成新运行](../../lib/scheduler/task-scheduler.ts#L3193)

外发队列按 key 去重，两次不同身份可各自发送。应保留一次逻辑 occurrence/attempt chain 的投递身份，并把副作用已接纳与后续诊断写入失败分别结算。周期任务下一 occurrence 仍需新的投递身份。

本轮真实 executor 和故障注入已验证，retry ID 变化有调度器源码支持。完整 timer → retry → 平台发送链待验。[结果](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/findings.md)

### F19 · P1 · 周期任务后续结果不再广播到配对端

recurring task 使用固定通知 dedupeKey 合并中心记录。headless runtime 的已发布缓存按 record ID 去重，后续 occurrence 更新同一记录后命中缓存，广播被跳过。

两次内容为 Monday/Tuesday 的通知返回相同 ID，数据库已是 `count=2, body=Tuesday` 且标记 toast delivered，transport 只有 1 次广播、内容仍为 Monday。[周期 dedupe](../../lib/scheduler/notification-integration.ts#L63) · [合并记录](../../lib/notifications/notify.ts#L134) · [广播缓存](../../lib/notifications/runtime.ts#L150)

应按一次 notify fan-out 或记录版本去重，使同一记录的新发生仍能推到在线 companion。验收包括新 occurrence、归档前后、读取后再发生和 runtime 重启。

真实 notification core/runtime 已运行，DB/transport 沿用现有 fixture 的替身，真实手机与 relay 待验。[结果](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/probe-output.log)

### F20 · P1 · outbound runner 结束后仍可开始发送

signal 只约束 runner 主循环，已 detached 的 conversation lane 没有共同停止或等待。一个探针在插件处理等待时 abort，runner Promise 已返回后再释放，随后发生 1 次 send，job 最终 sent。另一个探针在平台 semaphore 接纳点 abort 并移除注册 adapter，已经捕获的 adapter 引用仍开始 send。[lane 派发](../../lib/connectors/outbound-runner.ts#L2139) · [最终检查](../../lib/connectors/outbound-runner.ts#L1609) · [平台发送](../../lib/connectors/outbound-runner.ts#L1694) · [退出清理](../../lib/connectors/outbound-runner.ts#L2212)

bootstrap 用 void 启动 runner，teardown abort 后移除 adapter 和释放运行归属，对该 runner 的 lane 没有 join。[启动](../../lib/connectors/bootstrap/install-connector-runtime.ts#L815) · [teardown](../../lib/connectors/bootstrap/install-connector-runtime.ts#L492)

应把 signal/ownership 检查传到最终提交点，使停止完成有可核验的含义，并等待或隔离在途 lane。验收需区分已经发到平台的请求与停止后才开始的新请求。

真实 runner、个人内容最后检查和队列已运行，最终平台为 fake adapter。[结果](../../.cache/personal-assistant-followup.Y7c0X6/outbound-probes-final.log)

### F21 · P2 · stale sending 恢复存在可被另一 runner 重试的中间状态

恢复先把 sending 改为 failed，返回后 runner 再按平台能力改为 delivery_unknown。两个 runner 交错时，第二个可在这个窗口把 failed 当成正常待发任务。

确定性双实例探针观察到一次新 send。第二个已送达后，第一个继续恢复又把最终状态写为 `delivery_unknown`，错误为 `stale_sending_delivery_unknown`。[中间 failed 写入](../../lib/db/outbound-jobs.ts#L734) · [随后 unknown 写入](../../lib/connectors/outbound-runner.ts#L2050) · [unknown 更新](../../lib/db/outbound-jobs.ts#L1099)

应在同一持久化决策中根据平台语义恢复到正确状态，并限制迟到恢复覆盖较新终态。双实例重叠是本项条件，常规 boot 的 Web Lock/运行租约提供上层互斥。本轮直接复现两个 runner 的共享 DB 交错，生产热重启/租约交接是否造成该窗口需集成验收。

该结果证明恢复期间可新增一次外发；原 sending 的真实远端结果在探针中保持未知。[结果](../../.cache/personal-assistant-followup.Y7c0X6/outbound-probes-final.log)

### F22 · P2 · Radar 取消后继续生成并写入报告

executor 将 AbortSignal 命名为 `_signal`，调用 runner 时没有传递。模型开始后 abort，再完成响应，executor 返回 success 并保存 1 份报告。外层 scheduler 的 abort race 可以先结束运行，底层 Promise 的副作用仍继续。[executor](../../lib/scheduler/executors/radar-report-executor.ts#L21) · [生成与保存](../../lib/radar/radar-runner.ts#L68) · [外层 abort race](../../lib/scheduler/task-scheduler.ts#L3460)

应贯穿模型请求、账户作用域和最终保存检查，并在取消/超时后准确结算。此路径还会延长 F11 的跨账户窗口。

模型使用 deferred 替身，实际 provider 是否及时停止计费尚未测试。已确认取消后的本地保存。[探针](../../.cache/personal-assistant-followup-memory/probe-results.log)

### F23 · P2 · 清理可删除刚接受并创建 Goal 的旧报告

旧版报告没有 suggestions 字段，UI 会合成可接受建议。保留清理先选到旧报告，随后接受建议原子创建 Goal，再完成旧快照的 bulkDelete，报告被删除但 Goal 仍在。[旧版建议兼容](../../lib/radar/suggestions.ts#L7) · [接受事务](../../lib/radar/suggestions.ts#L29) · [保留清理](../../lib/db/radar-reports.ts#L42)

这会丢失已经接受的决定、证据和任务历史入口。应在同一事务内按当前状态挑选并删除，或在清理前校验决定版本。验收覆盖旧格式报告及接受/清理的所有顺序。

本轮真实 DB、建议事务、任务序列化和删除已复现，task 注册使用替身。新格式含 pending 建议的报告已有保护，未把这项扩大到所有报告。[结果](../../.cache/personal-assistant-followup-memory/probe-results.log)

### 三项边界观察

以下机制均已本地观察，具体产品约定会影响是否需要改变。

- 删除生成中的全部 memory 来源后，迟到的派生报告仍可保存，建议仍可接受为 Goal。UI 会显示来源不可用，Goal 指令要求执行前复核当前来源。需要明确“忘记来源”是否还撤销生成中的派生结果或既有承诺。
- Radar corpus 会纳入正常 recall 排除的 expiresAt 过期、quarantined、conflict、未验证 procedural 和 staleness expired 行。5/5 测试记录进入 collect。Radar 的 owner 活动分析是否采用相同的 recall 可采纳规则，需要形成明确契约。本轮未据此证明跨 principal 泄漏。
- scheduled Radar 与手动 Run now 可重叠并各自保存报告。手动 force 会跳过间隔限制，需要明确是否复用在途结果或允许独立刷新。同 scheduler 的 slot claim/allowConcurrent 另有机制。

这些观察的完整输入、断言和限制保存在[独立审查](../../.cache/personal-assistant-followup-memory/findings.md)。

### 本轮验证与取舍

现有 **16 suites / 525 tests 全通过**，由 root 的 5 suites / 288、Scheduler 的 3 suites / 63、Memory/Radar 的 8 suites / 174 组成。该数字是本轮运行量，与首轮 736 项存在重叠。

最终探针共 **19 项**。其中 12 个“不应发生”行为断言失败，7 个观察性反例断言通过；按语义归纳为 13 项缺陷和 3 项边界观察。早期 outbound 恢复探针的 fault hook 未挂到 Jest mock，曾 timeout。修正测试 hook 后，两条恢复/停止断言及新增最终 wire 取消断言均以行为差异失败，结论采用 final 日志。

- [草稿 3 项探针与重放](../../.cache/personal-assistant-followup.Y7c0X6/reproduce-drafts.cjs) · [日志](../../.cache/personal-assistant-followup.Y7c0X6/draft-probes.log)
- [outbound 最终 3 项探针与重放](../../.cache/personal-assistant-followup.Y7c0X6/reproduce-outbound-final.cjs) · [最终日志](../../.cache/personal-assistant-followup.Y7c0X6/outbound-probes-final.log)
- [Scheduler 6 项探针与重放](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/run-probes.mjs) · [日志](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/probe-output.log)
- [Memory/Radar 7 项探针与重放](../../.cache/personal-assistant-followup-memory/run-probes.mjs) · [日志](../../.cache/personal-assistant-followup-memory/probe-results.log)
- [root 基线](../../.cache/personal-assistant-followup.Y7c0X6/baseline-root.log) · [Scheduler 基线](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/existing-suites.log) · [Memory 基线](../../.cache/personal-assistant-followup-memory/baseline-tests.log)

本轮按 evidence-driven-dev 的 fresh failure hunt，安排了独立的 Scheduler 与 Memory/Radar 只读审查。真实 IM、模型、Tauri/手机、双 Host 和 UI 仍有 V6 的实机验收义务。标准 pnpm 启动在测试前再次遇到既有 agent-config-types Node 导出阻塞，定向测试使用同一仓库 Jest wrapper。探针测试已清理，产品源码修改数为 0。

优先处理 F11/F12 的数据作用域，再处理 F13/F14/F15/F20 的用户控制与接纳一致性，随后处理 F16–F19 的持续交付。F21–F23 与对应恢复、取消和保留生命周期一起验证。

## 业内实践对照

以下为 2026-11-17 阅读的官方机制。具体可用性受账号、地区和 rollout 影响。

| 参考                    | 官方实践                                                                                 | Cognia 可吸收的做法                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI dots             | 持续承担目标，结合记忆和连接应用，查看活动并改变方向，主动研究后的动作继续遵守行动规则。 | 把责任、检查点、进度和用户决策串入持续对话，落实 F1/F2 的控制边界。[入门](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) · [控制](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)       |
| ChatGPT Scheduled Tasks | 按时间、监测和受支持应用事件触发，检查账号、事件、条件、指令和待审批状态。               | 在已有 event trigger 上补齐数据源连接与用户可理解的检查面板。[说明](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)                                                                                                             |
| Claude Cowork           | 周期任务使用连接工具及插件，形成独立工作会话，云端调度和本地资源访问有各自条件。         | 助理任务直接呈现 Host、输入依赖、产物和历史会话。[调度](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork) · [跨端](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile) |
| OpenClaw                | 持久调度和恢复关联精确运行身份，区分执行与投递，会话可隔离并显式连接同一人的身份。       | 验收投递结果、不确定副作用、重试去重及身份映射。[恢复](https://docs.openclaw.ai/automation/cron-jobs/how-it-works) · [会话](https://docs.openclaw.ai/concepts/session)                                                                                   |
| Gemini Tasks            | 按动作管理许可，支持单次、会话内或保存授权，并在连接应用中管理。                         | 展示当前授权的对象、期限与有效范围，检验拒绝后的全部入口。[授权](https://support.google.com/gemini/answer/18766567?hl=en)                                                                                                                                |
| Meta Muse               | 个人 Agent、专用云计算机、跨应用处理任务及长期目标，由用户控制访问权限。                 | 初始化时连接身份、数据源、运行端和首个可验收任务。[介绍](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)                                                                                                                          |

## 建议顺序与验收旅程

第一轮处理 F1–F4，明确模式切换、授权和确认对象。F2 缺省迁移需评估兼容影响。

第二轮选一个数据生态贯通 F6、F7、F9，以 F10 的既有聚合能力承接入口。首批场景为每日简报、会议准备和会后承诺跟踪。

第三轮扩展 F5、F8，完善长任务后台执行、跨渠道续办和持续责任管理。

| 用户旅程     | 验收结果                                                       |
| ------------ | -------------------------------------------------------------- |
| 早间简报     | 读取当前日程、待办和授权消息源，附时效/来源，按用户设置投递。  |
| 临时改会     | 识别冲突，展示修改对象，取得所需授权后写入并读回。             |
| 会后跟进     | 承诺关联责任人、截止时间和来源，跟踪完成/延期并按规则提醒。    |
| 长任务       | 返回跟踪身份，后台推进，可纠正/暂停/恢复，产物版本和验收关联。 |
| 手机续办     | 身份经验证，选择准确运行，审批/取消可读回，避免重复执行。      |
| 活动任务撤权 | 活动、排队、恢复、steer、工具及投递应用当前收紧后的权限。      |

试点记录首次配置成功率、首个有效任务用时、最终验收成功率、催办次数、建议接受率、重复执行/投递、审批等待、无授权动作和每个已验收任务成本。数值目标由真实用户试点确定。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                     |
| ------------ | ------ | --------------------------------------------------------------- |
| scale        | high   | 涉及 IM、任务、记忆、身份、Host、审批和产物，可按旅程独立立项。 |
| technical    | medium | 复用既有模块，未知集中于活动运行撤权和跨端集成。                |
| coupling     | high   | 入站、运行、外发和任务归属共同遵守权限契约。                    |
| requirement  | medium | assistant 预设与持续助理分属两层，用户画像待确认。              |
| verification | high   | 本地验证决策，真实消费、投递、睡眠和跨设备需实机。              |
| risk         | high   | 个人数据、凭据、外发和不确定副作用。                            |

## Risks

| ID  | Risk (impact)                                             | Severity | Source                        | Claim                              | Refuted by                                   |
| --- | --------------------------------------------------------- | -------- | ----------------------------- | ---------------------------------- | -------------------------------------------- |
| R1  | 模式收紧后继续消费输入或自动回复。                        | high     | ADR-0252 与 live-steer 路径   | 当前模式约束新输入。               | Silent/Draft 输入进入旧自动运行。            |
| R2  | 用户误认为收件人授权已强制执行。                          | high     | ADR-0239、policy              | 有效授权状态可确认。               | shadow 规划 draft/deny 后仍允许投递。        |
| R3  | 名称导致对暂停或批准对象的误判。                          | medium   | UI、运行分支                  | 用户能预见切换与确认的作用。       | 同一标签的对象/范围随目标改变。              |
| R4  | 把源码和本地测试视作全平台可用性。                        | high     | 风险目录、Host 契约           | 持续助理完成跨端真实旅程。         | 实机发生丢失、失控或重复副作用。             |
| R5  | 历史分析或宣传导致错误补全方向。                          | medium   | 当前工作区、官方说明          | 建议考虑当前已有能力。             | 当前调用链已经完整验收建议中的旅程。         |
| R6  | 草稿审批、拒绝和过期竞争造成丢失交付或违背用户拒绝。      | high     | Draft 状态机、ADR-0131        | 用户决定对应一致的草稿和投递状态。 | 已批准无可发送 job，或拒绝被覆盖。           |
| R7  | 取消、重启及并发投递造成重复外发或错误终态。              | high     | 故障注入目录、outbound runner | 中止和恢复保留可核验的交付结果。   | 取消后发出新请求，或不确定副作用被自动重复。 |
| R8  | 异步生成和账户/来源变化造成数据错归属或失效上下文被使用。 | high     | 账户隔离、记忆治理            | 输出保存到原账户且使用可采纳来源。 | A 账户内容进入 B，或失效来源进入生成。       |

## Verification obligations

| ID  | Risk           | Method                                                           | Independence   | Evidence                                                                                                                                                                                             | Coverage                                                                   | Status  |
| --- | -------------- | ---------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- |
| V1  | R1, R3, R5     | 预设、路由、runtime、principal、控制、Radar、Attention 现有套件  | tool           | 仓库 Jest 入口，10 suites / 440 tests 全通过。命令见下方。                                                                                                                                           | macOS Node 26.12.1，本地 fixture/IndexedDB。                               | passed  |
| V2  | R1             | 切换 Silent/Draft 后发送 steer follow-up                         | tool           | 两个“不得注入”回归断言均失败，出现 inbound_live_steered。[日志](../../.cache/personal-assistant-audit.3SaU1l/steer.log)                                                                              | 真实 Bus/coordinator，终端 steer 替身。                                    | failed  |
| V3  | R3             | Silent 的 fan-out 和欢迎卡探针                                   | tool           | 1 个观察性用例通过，manual-store、Workflow/Bot 调用及 welcome audit。[日志](../../.cache/personal-assistant-audit.3SaU1l/fanout.log)                                                                 | 本地数据库、入队及审计。                                                   | passed  |
| V4  | R1, R2, R4, R5 | 队列、恢复、steer、授权、调度、Radar、会话、Delegation、交付套件 | tool           | 12 suites / 296 tests 全通过。[日志](../../.cache/personal-assistant-audit.3SaU1l/baseline-extra.log)                                                                                                | 机制级回归，各套件原有 fixture。                                           | passed  |
| V5  | R5             | 阅读当前官方文档并对照源码                                       | self           | 行业矩阵与 Sources，查阅日期 2026-11-17。                                                                                                                                                            | 公开机制，账号可用性各异。                                                 | passed  |
| V6  | R1, R2, R4     | 六条实机旅程和故障演练                                           | real-env       | 本轮待执行。                                                                                                                                                                                         | 真实 IM、模型、Host、手机、睡眠/重启及服务读回。                           | planned |
| V7  | R4             | 补充通过 pnpm test 启动两个定向套件                              | tool           | pnpm 在执行测试前自动准备依赖，postinstall 的 build-sidecar-linked-packages 报两个 agent-config-types 子路径仍解析到 TS，退出 1。[日志](../../.cache/personal-assistant-audit.3SaU1l/pnpm-entry.log) | 测试尚未启动，736 项通过结果来自直接调用仓库 wrapper。                     | blocked |
| V8  | R6             | 授权拦截后批准、拒绝/审批并发和过期竞争探针                      | tool           | 3 项行为断言均因实际不变量被破坏而失败。[日志](../../.cache/personal-assistant-followup.Y7c0X6/draft-probes.log)                                                                                     | 真实 DB/hold/Inbox write，gateway 沿用测试替身。                           | failed  |
| V9  | R7             | outbound runner 取消及恢复边界探针                               | tool           | 最终 3 项行为断言均因停止后发送或恢复交错而失败。[日志](../../.cache/personal-assistant-followup.Y7c0X6/outbound-probes-final.log)                                                                   | 真实 runner；fake adapter；双实例恢复有前置条件。                          | failed  |
| V10 | R7, R4         | Scheduler 与通知独立故障路径审查                                 | fresh-reviewer | 3 suites / 6 个行为断言失败，确认 5 根因。[审查](../../.cache/personal-assistant-followup-scheduler/scheduler-hunt-20261117-a/findings.md)                                                           | 真实 scheduler/DB，IM enqueue 和 transport 使用替身。                      | failed  |
| V11 | R8             | Radar/Memory 账户、来源和并发独立审查                            | fresh-reviewer | 7 个观察性反例断言通过，确认 4 缺陷、3 契约边界观察。[审查](../../.cache/personal-assistant-followup-memory/findings.md)                                                                             | 真实加密 DB/Browser Vault，模型/向量使用替身。观察性用例通过表示缺陷复现。 | failed  |
| V12 | R4, R5         | 本轮相关现有套件回归                                             | tool           | 16 suites / 525 tests 全通过，三组基线日志见追加研究。                                                                                                                                               | macOS Node 26.12.1，Jest wrapper，机制层。                                 | passed  |

### 命令与复现

V1 运行以下仓库命令。

```sh
node scripts/test/jest.mjs --runInBand --runTestsByPath \
  lib/connectors/composition/im-mode-presets.test.ts \
  lib/connectors/effective-config.test.ts \
  lib/connectors/bus.test.ts \
  lib/connectors/runtime.test.ts \
  lib/connectors/bus.principal.test.ts \
  lib/connectors/follow-up-control.test.ts \
  components/inbox/mode-switcher.test.tsx \
  lib/radar/suggestions.test.ts \
  lib/radar/radar-runner.test.ts \
  lib/attention/project.test.ts
```

使用 `pnpm test` 所指向的同一根仓库 wrapper。V4 完整路径位于日志末尾。

补充运行 `pnpm test --runInBand --runTestsByPath lib/connectors/composition/im-mode-presets.test.ts lib/policy/action-review/policy.test.ts` 在依赖准备阶段阻塞。`@cognia/agent-config-types/agent-capability-grant` 和 `@cognia/agent-config-types/agent-composition` 仍解析到源 `.ts`，postinstall 要求编译 JS 的 Node export。该轮测试未启动。此问题与模式审计独立，后续需修复 workspace 包构建与导出。本轮直接执行同一仓库 Jest wrapper 的结果独立记录于 V1/V4。

V2 复用 `bus.turn-queue.test.ts` fixture，注册真实 coordinator，以 deferred promise 保持首轮活动。coordinator 的终端 steer 返回 accepted。更新会话后调用真实 `dispatchInboundFull`，断言审计无 `inbound_live_steered`，两种模式均失败。

V3 复用 `bus.workflow-trigger.test.ts` fixture，设置 observe/human、欢迎卡开启及匹配 Workflow，验证主响应和独立订阅/通知的实际决策。

可重跑 [reproduce.cjs](../../.cache/personal-assistant-audit.3SaU1l/reproduce.cjs)。脚本生成唯一临时测试、只运行探针、保存日志并清理测试文件。缓存清理后上述证据文件可能失效，核心步骤和结果在本节保留。来源摘要见 [source-hashes.txt](../../.cache/personal-assistant-audit.3SaU1l/source-hashes.txt)。

现有测试合计 736 passed。观察性探针另有 1 passed，缺陷探针为 2 failed，复制 fixture 的既有用例因测试名过滤而 skipped。全量 lint/typecheck/build、覆盖率和真实 UI/E2E 的执行次数为 0。

## Decisions

| ID  | Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                  | Action    | Based on                                                           | Reversal trigger                                         |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| D1  | 2026-11-17 | Standard 分析，覆盖预设和持续助理相关模块。                                                                                                                                                                                                                                                                                                                                               | diagnose  | G1, O1                                                             | 用户限定另一对象或范围。                                 |
| D2  | 2026-11-17 | 优先记录活动模式收紧及缺省授权。                                                                                                                                                                                                                                                                                                                                                          | diagnose  | O2, O4                                                             | 真实入口有未发现的同步 fence，或部署构件实现不同。       |
| D3  | 2026-11-17 | 复用现有记忆、调度、恢复和交付，围绕用户旅程连接。                                                                                                                                                                                                                                                                                                                                        | diagnose  | O1, O5, O6, O7, O8                                                 | 对应旅程已真实验收，或用户画像改变。                     |
| D4  | 2026-11-17 | 继续检查草稿、投递、调度和记忆，增加独立故障路径审查。                                                                                                                                                                                                                                                                                                                                    | diagnose  | G2                                                                 | 候选问题被反证，或上层保证该不变量。                     |
| D5  | 2026-11-17 | 把 13 项实证缺陷列入 F11–F23，3 项契约观察继续保留为观察。                                                                                                                                                                                                                                                                                                                                | diagnose  | O10, O11, O12, O13, O14, O15, O16, O17                             | 反证表明正常调用层已阻止对应交错，或拥有者补充当前契约。 |
| D6  | 2026-11-22 | 完成 F1–F23 与 B1–B3 全量代码落地及本地回归验证：F2 采用无人值守/跨会话默认 enforce（同会话直接回复不误拦）并提供一键全量升级；F4 区分三类执行目标审批对象并限制仅 operator 批准；B1/B2/B3 落地来源删除重洗、治理过滤对齐及同账户单飞+强制重算；Phase 2 完成 `/inbox/needs-me`（F10）、宿主本人验证绑定码与私聊跨渠道 `/sessions all` + `/resume`（F8）、个人数据源配置与探测向导（F7）。 | implement | G1, G2, O1, O2, O4, O5, O6, O10, O11, O12, O13, O14, O15, O16, O17 | 实机演练（V6）发现外部平台或 OS 休眠唤醒差异时补充适配。 |

## Residual risks

| ID  | Residual                                         | From        | Why still open                                                                                              | Next action                                            | Status   |
| --- | ------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------- |
| X1  | live-steer 模式绕过及实际消费/发送影响。         | R1, V2      | Bus/coordinator/follow-up/outbound 已完成同步收紧与回归验证；真实平台流式回退归入 V6。                      | 随 V6 实机切换 Silent/Draft 演练确认。                 | open     |
| X2  | 实际 enforcement、连接器和 Host 状态未知。       | R2, Q1      | 已落地风险分层默认 enforce、shadow 横幅与个人数据源探测向导；生产账号实况待实机核验。                       | 在目标桌面宿主打开 Outbound 与 Personal Sources 核验。 | open     |
| X3  | 跨端、断网和睡眠/重启结果待验。                  | R4, V6      | 本地单元与数据库交错回归已覆盖，真实 OS 休眠、手机配对及第三方 IM 投递需实机环境。                          | 按下方 V6 实机验收清单逐项演练。                       | open     |
| X4  | 建议顺序依赖用户画像。                           | A1          | F1–F23 已全部落地，后续深化优先级取决于目标用户生态。                                                       | 根据真实日常使用反馈迭代数据源深度。                   | accepted |
| X5  | pnpm 启动器在依赖准备阶段阻塞。                  | R4, V7      | 2026-11-22 复核 `build-sidecar-linked-packages.mjs` 已退出 0，导出阻塞已解除。                              | 保持 CI 构建门禁监控。                                 | closed   |
| X6  | F13/F14 草稿接纳与状态竞争仍需修复。             | R6, V8      | 已完成单队列串行化、held-job 新幂等键派生及本地并发探针回归。                                               | 无需额外本地改动，随 V6 跨端审批确认。                 | closed   |
| X7  | F15–F21 的暂停、重试、取消和通知缺陷仍存在。     | R7, V9, V10 | 已修复暂停保留、once 重试恢复、取消信号透传、稳定幂等键、周期通知广播与 runner 停止围栏；真实 crash 待 V6。 | 随 V6 执行宿主重启与断网恢复演练。                     | open     |
| X8  | F11/F12/F22/F23 的作用域和生命周期缺陷仍需修复。 | R8, V11     | 已完成数据库作用域围栏、路由目标重校验、取消透传与旧报告保留保护。                                          | 已由单元与真实 IndexedDB 交错用例覆盖。                | closed   |
| X9  | 3 项 Radar 机制观察的产品契约未定。              | H2, V11     | 用户已拍板 B1/B2/B3 契约并完成源码与测试落地。                                                              | 契约已固化。                                           | closed   |

### V6 实机验收清单（待在真实 IM 与常驻宿主环境执行）

1. **运行中收紧模式（F1/F3）**：在飞书/Telegram 会话触发长回复，运行中切换为 `Silent` 或 `Draft`，确认在途流立即中止、无迟到自动外发，且 `/automation status|pause|resume` 与预期一致。
2. **外发收件人授权（F2/F7/F13/F14）**：在新配置账户下触发跨会话通知或 `send_email`/`send_mail`，确认默认拦截进入审批/暂存草稿，批准后生成新投递任务并成功送达一次。
3. **跨渠道本人身份续办（F8）**：在桌面端「联系人资料」生成一次性 `/bind` 码，在手机 IM 私聊发送 `/bind <code>` 绑定后运行 `/sessions all` 与 `/resume #1`，确认可接续桌面端会话，且群聊及外部联系人执行相同命令均被拒绝。
4. **个人责任中心与数据源向导（F7/F10）**：打开 `/inbox/needs-me` 核验待审草稿、HITL 审批、超时 SLA、受阻任务与 Radar 建议汇总及行内处理；在 `Settings -> Connections -> Personal sources` 点击「全部验证」核验 `lark-cli` 与 MCP 钥匙串凭据状态。
5. **休眠/重启与配对端通知（F15–F21）**：配置一次性失败重试任务与周期 Radar/提醒任务，重启桌面宿主并连接配对端，确认暂停态不回退、一次性重试恢复执行、周期通知后续轮次正常同步到配对端。

## Outcome

| ID  | Signal                                         | How / when measured                          | Result                                                   | Status  |
| --- | ---------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- | ------- |
| M1  | 给出能力、实证缺陷、缺口、行业对照和补全顺序。 | 2026-11-17 源码、736 项现有测试及 3 项探针。 | 已记录 F1–F10、证据边界与后续验收。                      | met     |
| M2  | 实际任务成功率和可控性提高。                   | 后续修复与用户试点。                         | 本轮产物为审计报告，业务结果待测。                       | pending |
| M3  | 发现原 F1–F10 之外的具体问题。                 | 2026-11-17，独立审查与 19 项最终探针。       | 新增 13 项实证缺陷、3 项机制观察，记录调用方和验收边界。 | met     |

## Sources

- [OpenAI dots 入门](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)
- [OpenAI dots 控制与隐私](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)
- [ChatGPT Scheduled Tasks](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)
- [Claude Cowork 周期任务](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- [Claude Cowork 跨端](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)
- [OpenClaw 调度与恢复](https://docs.openclaw.ai/automation/cron-jobs/how-it-works)
- [OpenClaw 会话与身份](https://docs.openclaw.ai/concepts/session)
- [Gemini Tasks 授权](https://support.google.com/gemini/answer/18766567?hl=en)
- [Meta Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
