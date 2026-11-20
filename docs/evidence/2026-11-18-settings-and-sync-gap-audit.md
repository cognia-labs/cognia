# Cognia 设置页面与同步审计

- Status: verifying
- Lane: deep
- Created: 2026-11-18
- Updated: 2026-11-20
- Related: [ADR-0097](../content/docs/en/adr/0097-cross-device-settings-contract-and-companion-reach.md)、[ADR-0215](../content/docs/en/adr/0215-one-person-one-encrypted-sync-space-many-writable-hosts.md)、[历史备份与同步审计](2026-10-21-backup-sync-gap-audit.md)

## Original request

> 帮我分析一下，看看现有的设置页面和设置同步或者存在什么问题，并且对照业内的优秀实践

## Knowledge

| ID  | Statement                                                                    | State    | Basis                                                           | Depends on |
| --- | ---------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- | ---------- |
| O1  | 用户请求审查设置页面、设置同步和行业对照。                                   | Observed | 2026-11-18 用户请求。                                           | -          |
| G1  | 找到用户可感知的问题，给出证据、影响、优先级和可用于验收的行业对照。         | Agreed   | 2026-11-18 用户请求。                                           | O1         |
| C1  | 使用隔离数据。审计范围为分析和取证。                                         | Observed | 2026-11-18 用户请求，共享工作区。                               | G1         |
| O2  | 本地设置、配对 Host 镜像、端到端加密账号同步和文件导入导出有不同的数据责任。 | Verified | 2026-11-18 源码，见下方现状和 ADR。                             | -          |
| H1  | 首次加入和暂停后恢复会丢失用户明确设置的偏好。                               | Verified | 2026-11-18 双副本探针，F1、F3。                                 | O2         |
| H2  | 用户关闭 Settings 同步后仍可能发出随后编辑的值。                             | Verified | 2026-11-18 公共引擎入口和双副本探针，F2。                       | O2         |
| H3  | 同步成功抵达数据库以后，设置仍可能留在旧值或呈现误导状态。                   | Verified | 2026-11-18 Host 清除语义、账号重读、push/pull 故障注入，F5–F7。 | O2         |
| O3  | 设置文件往返和全局重置有不一致，搜索缺少恢复密钥入口。                       | Verified | 2026-11-18 导入、保存、重置和双语言搜索探针，F8–F10。           | G1         |
| O4  | 同一对象键内的独立编辑可以丢掉一个子字段变化。                               | Verified | 2026-11-18 双副本资料字段冲突，F4。                             | O2         |
| O5  | 配对设置保存返回完整的已合并设置，返回路径缺少共享字段投影。                 | Verified | 2026-11-18 逐段核对本机保存、桥接和 RPC 响应，F11。             | O2         |
| Q1  | 已发行构建的账号同步开关、真实多端复现频率和现有用户影响范围。               | Open     | 2026-11-18 仅检查本地构建规则，使用隔离副本。                   | O2         |
| Q2  | 恢复同步时如何处置暂停期本地编辑，以及哪些设置应允许选择性同步。             | Open     | 2026-11-18 审计发现契约缺口，需产品决策。                       | H1,H2      |
| O6  | 对抗性复核补充了跨键并发、首次播种恢复、配置重置等反例。                     | Verified | 2026-11-18 本轮隔离探针及独立审查，A1–A8。                      | O2         |

## Problem frame

检查用户能否找到设置、判断改动会影响哪台设备、确认设置实际生效，并在覆盖后恢复。检查桌面 `/settings`、紧凑布局 `/me`、Settings Profile、本地持久化、账号同步与 Companion 镜像接缝。历史备份审计覆盖全量数据和备份目的地，本轮仅检查它与设置迁移、恢复的交界。

### 现状

| 路径           | 权威与入口                                                                                         | 已有能力                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 本机设置       | `saveSettings` 写本地 Dexie singleton，Zustand 提供运行态。宽屏 `/settings`，紧凑布局 `/me`。      | 按能力过滤导航，URL 分区和旧链接跳转，分区筛选、控件查找器、已修改项审阅、分区重置。                                   |
| 配对 Host      | 配对客户端排队发送 `app_settings_update`，Host 投影后下发。移动端 `/me/sync` 查看 Companion 拉取。 | 写入名单和下发投影从同一分类生成。待发字段可抵御普通的旧 Host 回包。                                                   |
| 账号加密同步   | ADR-0215 的同账号设备副本，各自操作自己的数据库。设置管理位于账号管理的身份页。                    | 设备审批、恢复密钥、撤销设备、按 Settings/Content 切换、加密 outbox 和按设置键合并。配对镜像数据库由 Host 的链路负责。 |
| 文件迁移及备份 | Settings Profile JSON 与数据页的全量备份分别使用自己的格式和入口。                                 | Profile 排除明确的密钥及 Provider 连接。账号加入提示合并或替换时，要求先保存本机备份。                                 |

配对协议的四类字段包括双向共享、Host 权威下发、设备本地、桌面专属。账号同步只取其中的 `shared`，账号设置同步开关控制账号引擎的数据类别。壁纸文件路径、麦克风硬件 ID 和密钥留在本地有明确理由。生产环境没有显式开关时默认禁用账号同步，实际投放状态仍待核实。 [字段分类](../../packages/agent-config-types/src/settings-sync.ts) · [账号表策略](../../lib/account-sync/data/tables.ts#L371) · [数据库归属](../../lib/account-sync/data/own-database.ts#L1) · [构建开关](../../lib/account-sync/feature-flag.ts#L20)

### 已确认的问题

P1 表示可能暴露凭据、破坏同步同意或使设置被跨设备覆盖，优先处理。P2 表示具体功能、可恢复性或信息呈现缺陷。

| ID  | 优先级 | 观察与影响                                                                                                                                                                                                                                     | 证据                                                                                                                                                                                                                                                                                                                                                            |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | P1     | **新设备只设过本机麦克风，也能把账号深色设置覆盖成「跟随系统」。** 加入判断忽略所有设置，之后却为新设备上每个已物化的共享键使用整行时间戳播种。较晚的本机保存给默认值带来更新的时钟，并绕过合并选择和备份。                                    | 双副本复现。 [加入判断](../../lib/account-sync/data/join.ts#L117) · [播种时钟](../../lib/account-sync/data/join.ts#L196) · [播种设置](../../lib/account-sync/data/join.ts#L274) · [本机保存](../../lib/db/settings.ts#L698)                                                                                                                                     |
| F2  | P1     | **关闭 Settings 同步后，关闭期间的编辑仍可发往账号。** 同一个键有旧待发记录时，关闭会停止捕获，发送端仍读当前值，携带旧记录的时钟发出新值。另一副本确实收到了关闭之后保存的主题。                                                              | 双副本复现，使用公开的 `setClasses` 和 `syncNow`。 [开关](../../lib/account-sync/data/engine.ts#L562) · [捕获](../../lib/account-sync/data/capture-middleware.ts#L294) · [发送取值](../../lib/account-sync/data/pusher.ts#L101) · [待发队列](../../lib/account-sync/data/pusher.ts#L257)                                                                        |
| F3  | P1     | **重新打开同步可覆盖暂停期的本机编辑。** 已有时钟的设置键被补种逻辑跳过，恢复时重放云端变更。设备 A 改为「跟随系统」、设备 B 暂停期间改为深色后，两端最终都变成「跟随系统」，B 的改动从未入队。                                                | 双副本复现。 [恢复流程](../../lib/account-sync/data/engine.ts#L562) · [已有时钟的键](../../lib/account-sync/data/join.ts#L274)                                                                                                                                                                                                                                  |
| F4  | P2     | **不同设备各改个人资料的一个子字段，合并后会少一项。** `profile.displayName` 与 `profile.bio` 同属一个顶层键，整个对象只有一个时钟。两副本虽收敛，其中一次独立编辑被覆盖。                                                                     | 双副本复现。 [设置捕获](../../lib/account-sync/data/capture-middleware.ts#L174) · [整键应用](../../lib/account-sync/data/applier.ts#L222)                                                                                                                                                                                                                       |
| F5  | P2     | **配对设备的外观分区重置无法传递可选项的清除。** `colorTheme: undefined` 在请求 JSON 中消失。反向路径的 Host 投影省略 `undefined`，客户端收到一条有效新快照后仍保留旧配色。                                                                    | 重置构造、线格式与客户端拉取探针。 [重置](../../lib/settings/profile-transfer.ts#L219) · [队列](../../lib/settings/mirror-to-host.ts#L62) · [Host 投影](../../lib/sync/desktop-sync-source.ts#L1408) · [客户端合并](../../lib/sync/handlers/app-settings.ts#L77)                                                                                                |
| F6  | P2     | **账号拉取更新后，运行中的外观可继续使用旧值。** 实际重读函数更新嵌套的 `settings`，绕过了设置 store 的内部投影更新逻辑。探针中 `settings.accentColor` 变了，外观订阅使用的顶层 `accentColor` 仍是旧值。                                       | 同步后的重读和 Zustand 订阅边界复现。 [重读](../../hooks/account-sync/use-account-sync-engine.ts#L40) · [内部投影](../../stores/settings/settings-store.ts#L873) · [外观订阅](../../lib/appearance/custom-theme-applier.tsx#L25)                                                                                                                                |
| F7  | P2     | **拉取成功能盖掉发送错误，并刷新「上次同步」。** UI 仍可显示待发数量，却失去发送失败原因。复现中 push 持续失败，pull 完成后状态显示无错误、较新的时间和一个待发项。                                                                            | 引擎故障注入。 [状态写入](../../lib/account-sync/data/engine.ts#L256) · [状态显示](../../components/account/sync/account-sync-data-panel.tsx#L107)                                                                                                                                                                                                              |
| F8  | P2     | **设置文件导出与导入不对称，而且导入接收无效值。** 有效的 Ocean 配色能导出，导入时静默丢弃。用途允许的 `theme` 键却可接受并保存无效枚举值。文件选定后页面直接保存补丁。                                                                        | 两条文件探针。 [导出](../../lib/settings/profile-transfer.ts#L157) · [导入](../../lib/settings/profile-transfer.ts#L182) · [保存入口](../../components/settings/actions/settings-actions-menu.tsx#L84)                                                                                                                                                          |
| F9  | P2     | **「全部恢复默认」保留可选外观覆盖。** 同一数据库中全局重置保留 Ocean，外观分区重置才清除。两个按钮使用不同的键集合，全局确认文案承诺覆盖每项偏好。                                                                                            | 本机保存对照探针。 [全局/分区补丁](../../lib/settings/profile-transfer.ts#L219) · [外观归属](../../lib/settings/section-keys.ts#L125) · [确认文案](../../i18n/messages/zh-CN/settings/actions.json#L17)                                                                                                                                                         |
| F10 | P2     | **设置搜索缺少账号同步恢复入口。** 桌面查找器用英文 `recovery key` 或中文「恢复密钥」搜索不到账号设置入口。紧凑界面的「同步状态」页执行配对 Host 拉取，账号同步在身份页操作，备份又在数据页。                                                  | 双语言真实索引探针、路由源码。 [查找器](../../lib/global-search/providers/settings.ts#L78) · [账号操作](../../components/account/manage/account-identity-tab.tsx#L321) · [配对状态](../../components/mobile/me/sync-status-panel.tsx#L155)                                                                                                                      |
| F11 | P1     | **配对设置保存的响应可能带出 Host 本地凭据。** Host 保存时读取含已还原密钥的运行态设置，落库时拆出密钥，返回值仍使用拆分前的对象。正常保存的桥接和 RPC 响应直接转发该对象。触发条件是已获准写设置的配对端、Host 有可读取的凭据、执行经过该桥。 | 源码确认，实际网络响应及已发布版本未采样。 [密钥还原](../../lib/db/settings.ts#L339) · [保存返回](../../lib/db/settings.ts#L752) · [写响应](../../lib/companion/desktop-write-source.ts#L2150) · [桥接返回](../../crates/cognia-companion-bus/src/desktop_writes_bridge.rs#L163) · [服务分发](../../crates/cognia-companion-rpc/src/rpc/service_plane.rs#L2798) |

另有一条静态风险。配对设置先提交本机，再尝试写入待发队列。建队失败的异常被吞掉，调用方收到成功，依赖队列计数的提示也可能没有可显示的记录。尚未做真实 Host 上的故障注入。 [本机成功与队列失败边界](../../lib/db/settings.ts#L710)

### 行业对照与验收线

| 能力                 | 公开实践                                                                                                                                                                       | Cognia 对应的验收线                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 找到单项和理解作用域 | VS Code 设置编辑器支持单项搜索、稳定深链、已修改项过滤及用户/工作区范围。                                                                                                      | 统一两处设置搜索的结果语义，索引账号同步、密钥恢复和备份。关键表单显示其作用域，区分本设备、当前 Host、账号全部设备。 [VS Code 设置](https://code.visualstudio.com/docs/configure/settings)                                                                                                                                                          |
| 选择同步范围         | VS Code 支持按类别和单项排除，默认排除机器范围设置。Firefox 公开说明可选数据类型、各平台可用性和恢复密钥，提供端到端加密。JetBrains 插件 SDK 把 roaming 能力声明到组件和类别。 | 保留现有密钥和设备本地边界，设置页按类别说明覆盖范围与排除项。暂停后创建的值不能借旧 outbox 发出。 [VS Code Settings Sync](https://code.visualstudio.com/docs/configure/settings-sync) · [Firefox Sync](https://support.mozilla.org/en-US/kb/sync) · [JetBrains Roaming Settings](https://plugins.jetbrains.com/docs/intellij/roaming-settings.html) |
| 冲突和恢复           | VS Code 对无法自动合并的改动提供本地与远端比较、明确选择以及本地与远端备份。IntelliJ IDEA 可从设置同步历史恢复，也允许导入前选择组件。                                         | 首次加入和重新启用先识别明确设置的值及冲突。独立子项可合并，同一项有歧义时给出差异或可恢复快照。配置导入先校验并预览，重置前显示影响。 [VS Code Settings Sync](https://code.visualstudio.com/docs/configure/settings-sync#_resolve-conflicts) · [IntelliJ IDEA Backup and Sync](https://www.jetbrains.com/help/idea/sharing-your-ide-settings.html)  |
| 状态和动作反馈       | Nielsen Norman Group 将及时、明确的系统状态作为可用性准则。                                                                                                                    | 本机保存、待发送、Host 已应用、账号已同步、失败各有可区分的状态。失败不能被另一方向的成功清除，全部同步按钮说明它会运行哪条链路。 [Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/)                                                                                                                          |

## 对抗性复核

2026-11-18 从 `dev` 的 `d425a059a7` 开始在共享工作区复核，期间的 CLI 提交及 `6948032cfb` 的 Sites 变更没有改变本次检查的设置同步分支。两名独立审查者分别按账号同步和设置/Companion 契约阅读源码，输入没有包含原审计的判定。我用 13 个新探针检验边界和新增反例，重跑了原有 12 个探针。凭据边界使用只读源码追踪。

### 原 11 项的判定

| ID  | 复核结论和适用边界                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | **成立，有前提。** 新设备必须已有物化共享值的设置行，且相同键的播种时钟要赢过账号值。无设置行的新设备能正常拉取深色主题。没有聊天等内容时，加入判断仍忽略显式设置，且加入对话框没有列出设置键数。                                                                                                                                                                                                                        |
| F2  | **成立，有前提。** 同键已在 outbox 时，关闭后保存的新值可以随旧项上传。若关闭前同键没有待发项，关闭后的新编辑确实不会被捕获或上传。结论只涉及账号引擎的 Settings 开关。                                                                                                                                                                                                                                                  |
| F3  | **成立，补充第二种结果。** 有较新的远端同键操作时，本机暂停期间的改动可被覆盖。没有较新的远端操作时，原时钟相等，重放也不会覆盖本机，结果是两端持续分歧，暂停期间的值从未上传。                                                                                                                                                                                                                                          |
| F4  | **成立，限共享对象内。** 同一个顶层对象的子字段共享一个 LWW 时钟。主题与字号作为两个不同顶层键、顺序走捕获和合并时，实测可以收敛。生产保存交错仍有独立的跨键覆盖路径，见 A1。                                                                                                                                                                                                                                            |
| F5  | **成立，限缺席语义。** 序列化和投影丢失的是 `undefined`，原表中的「空值」应精确为 `undefined`。Host 明确下发 `colorTheme: "default"` 时配对端正确更新。WebRTC 表单清空 STUN/TURN 的路径也会生成 `undefined`，其中 TURN 仍有已配置的临时服务器时会下发临时列表。 [WebRTC 保存](../../components/settings/companion/webrtc-card.tsx#L262) · [Host 投影](../../lib/sync/desktop-sync-source.ts#L1419)                       |
| F6  | **成立，限派生订阅。** 账号引擎重读会更新 `state.settings`，普通明暗主题、字号等嵌套订阅可以响应。调色板、强调色等顶层派生订阅会继续读旧值。Companion 路径另见 A6。                                                                                                                                                                                                                                                      |
| F7  | **成立，限状态语义。** 一次 pull 成功可以把仍存在的 push 错误清空并刷新共用时间，待发送数量仍然可见。另一条源码风险是过大项目后来成功发送，空的 `tooLarge` 结果不会清空既有提示。 [状态合并](../../lib/account-sync/data/engine.ts#L268)                                                                                                                                                                                 |
| F8  | **成立，避免推广到全部字段。** 有效 Ocean 配色能导出，和合法 `theme` 一起导入时丢失可选配色。只剩被过滤键的文件会报空配置。无效 `theme` 示例确实写入了本机数据库，其他字段可能有规范化。排除 Provider 连接和密钥有明确设计依据。                                                                                                                                                                                         |
| F9  | **成立，且存在另一方向的错误。** 全局重置会恢复明暗模式，但保留不在 `DEFAULTS` 的 Ocean 覆盖，分区重置能清除。全局重置还会清掉某些凭据，见 A7。                                                                                                                                                                                                                                                                          |
| F10 | **缩窄为入口表达与查找缺口。** 「恢复密钥」及 `recovery key` 的设置搜索结果确实缺少账号入口。配对状态仍可从宽屏 Connectivity → Sync 或紧凑页 `/me/sync` 进入，账号管理的身份页也保有账号同步入口。代码能证明能力和目标不同，用户是否困惑没有可用性研究证据。 [Connectivity 面板](../../components/settings/connectivity/panels/sync-panel.tsx) · [身份页](../../components/account/manage/account-identity-tab.tsx#L321) |
| F11 | **源码路径确认，生产事件未知。** 输出契约只要求对象，经过授权的成功写入会照原结果返回，并可把同一结果存为幂等回执。需要有设置写授权、可用写桥及可读取凭据。已检查的 `sync_pull` 维持出站字段投影。 [输出注册](../../src-tauri/src/companion_api/output_registry.rs#L588) · [响应和回执](../../crates/cognia-companion/src/remote_execution.rs#L613) · [拉取投影](../../lib/sync/desktop-sync-source.ts#L1408)            |

以账号数据替换的情形单独做了对照。本机设置键在账号已有对应操作时会应用账号值，账号历史中没有该键时会保留本机值。对话框明确列出替换聊天、角色、技能、记忆及保留内置项。由于它没有承诺抹掉这些本机设置，不把这一行为列为丢数据缺陷。 [替换逻辑](../../lib/account-sync/data/join.ts#L323) · [按钮文案](../../i18n/messages/zh-CN/accountSync.json#L196)

### 新发现

| ID  | 优先级 | 现象和触发条件                                                                                                                                                                                                                    | 证据                                                                                                                                                                                                                             |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | P1     | **普通本机设置保存与账号拉取交错，可跨设备回退一个无关设置。** 设备 B 保存仅本机使用的麦克风，在读旧行后、全行写入前收到 A 的新主题。恢复普通保存后，B 把旧主题写回，并赋予它新的修改时钟。A 最终也被回退。                       | 注入全行写入时序，使用真实读、合并、捕获、加密和双副本。 [本机保存](../../lib/db/settings.ts#L670) · [账号应用](../../lib/account-sync/data/applier.ts#L222)                                                                     |
| A2  | P1     | **首次播种中断后，正常重启可漏掉尚未扫描的设置。** 先提交 capture，后分段播种。注入中断后重启，已播种聊天能发出，预置主题仍只有本地值且没有时钟。正常重启不会补播，手工再编辑仍可产生新操作。                                     | 在两个播种阶段之间注入异常后启动真实引擎。 [武装事务](../../lib/account-sync/data/join.ts#L167) · [播种顺序](../../lib/account-sync/data/join.ts#L301) · [重启判定](../../lib/account-sync/data/join.ts#L143)                    |
| A3  | P2     | **跟随系统语言的设备可以覆盖另一端手动选的语言。** B 跟随英语系统，接收 A 的手动中文后仍解析为英语。B 后续保存本机麦克风时，把它解析出的英语当作共享设置新改动发回去。A 的持久化语言因此被改成英语，模式仍为手动。                | 双副本真实保存复现，无需并发交错。 [字段分类](../../packages/agent-config-types/src/settings-sync.ts#L163) · [本机语言解析](../../lib/i18n/locale-preference.ts#L33) · [整行保存](../../lib/db/settings.ts#L687)                 |
| A4  | P2     | **配对待发项遮住 Host 值后，失败也不会自动补拉。** 本机 pending 让客户端跳过对应字段，但增量游标照常前进。该项进入死信后，普通重试沿新游标只能得到空增量，旧预览值会一直等到 Host 再更新或拉取游标被重置。                        | 复现 pending → 拉取 → deadlettered → 增量重试，重置游标作正对照。 [遮罩](../../lib/sync/handlers/app-settings.ts#L77) · [游标更新](../../lib/sync/handlers/base.ts#L223) · [同步调度](../../lib/sync/companion-sync.ts#L1260)    |
| A5  | P2     | **账号同步后一页失败，前一页已提交的设置可能没有刷新通知。** 第一页写入主题并推进游标，第二页请求报错，成功回调收不到第一批的变更。下一次成功拉取从新游标开始，仍没有设置通知。                                                   | 分页故障注入，核对真实数据库、游标和 `onApplied`。 [批量提交](../../lib/account-sync/data/applier.ts#L298) · [拉取回合](../../lib/account-sync/data/sync-round.ts#L152) · [回调发布](../../lib/account-sync/data/engine.ts#L268) |
| A6  | P2     | **Companion 拉取后，已经加载的设置 store 仍可能持有整个旧设置。** 在已加载 store 下，主题确实落库，正常的 `load()` 会短路，显式 `retryLoad()` 才能看到新值。写入 Host 的处理函数也只落库。直接监听 Dexie 的消费者有独立刷新路径。 | 拉取和 store 复现，Host 写入范围为静态核对。 [拉取](../../lib/sync/handlers/app-settings.ts#L77) · [store 加载](../../stores/settings/settings-store.ts#L903) · [Host 保存](../../lib/companion/desktop-write-source.ts#L2150)   |
| A7  | P2     | **「全部恢复默认」实际上会清空内置搜索 Provider 的主 API key。** 文案承诺保留密钥和凭据。测试中 Tavily 的主 key 变空，附加 key 列表仍在。作用域是有空主 key 默认值的内置搜索 Provider。                                           | 用合成值确认保存和落库。 [确认文案](../../i18n/messages/zh-CN/settings/actions.json#L19) · [主 key 默认值](../../packages/web-search/src/types.ts#L710) · [合并](../../lib/db/settings.ts#L617)                                  |
| A8  | P2     | **宽屏配对状态卡可把从未同步显示成「正常」。** 卡片只看有无记录错误，调度器明确不记录无 Host，组件测试也把所有行尚未同步、无错误的 fixture 断言为 Healthy。紧凑页面有单独的未配对状态。                                           | 实际组件现有测试与调度源码。 [宽屏状态](../../components/settings/companion/sync-status-card.tsx#L140) · [no_host 分支](../../lib/sync/companion-sync.ts#L1253)                                                                  |

另有三条未跑实际设备的源码风险，作为后续定向验收的输入。

- Tauri 已选中远程 Runtime Host 时，WebRTC 表单把本机设置写入 Dexie 后提示成功，应用配置的控制器却通过通用 transport 发 Host Admin 命令。该组合缺少显式路由上下文，命令会被拒绝，控制器只记录日志。未选远程 Host 时通用 transport 可落到本机。 [保存提示](../../components/settings/companion/webrtc-card.tsx#L262) · [控制器](../../lib/signaling/desktop-controller.ts#L216) · [路由规则](../../lib/tauri/transport-routing.ts#L226)
- 更换或清除自动 TURN Provider 凭据先删除旧 keyring 项，再保存配置。保存失败时，旧配置仍可引用已删的项。还应核对表单协议和日志脱敏，当前两个输入复用解析器，校验提示直接回显无效行。 [保存顺序](../../components/settings/companion/webrtc-card.tsx#L260) · [凭据生命周期](../../components/settings/companion/webrtc-card.tsx#L660) · [表单解析](../../components/settings/companion/webrtc-card.tsx#L220)
- 账号或 Runtime Target 切换时，已经在飞的旧引擎拉取在停止后仍可能完成。设置刷新使用无 scope 的读取，异步回来以后也没有校验当前数据库代际。已确认缺少守卫，实际 UI 在切换时是否出现旧快照仍需测。 [引擎停止](../../lib/account-sync/data/engine.ts#L528) · [拉取完成](../../lib/account-sync/data/engine.ts#L338) · [设置重读](../../hooks/account-sync/use-account-sync-engine.ts#L40)

ADR-0215 记录了早期 staging 的浏览器和 Headless CLI 通过结果，且当时生产构建仍关闭账号同步。该证据不覆盖本轮故障时序，当前生产构建开关和真实设备上的发生频率仍未核实。 [阶段 3a 记录](../content/docs/en/adr/0215-one-person-one-encrypted-sync-space-many-writable-hosts.md#L330)

复核运行结果为 5 组隔离探针 25 项通过，其中 13 项为本轮新增。另有账号同步相关既有套件 6 组、73 项通过、1 项跳过，以及宽屏状态卡、WebRTC 表单、信令控制器和 transport 路由 4 组、106 项通过。部分既有用例刻画当前缺陷行为，通过表示结果符合断言。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                  |
| ------------ | ------ | ---------------------------------------------------------------------------- |
| scale        | high   | 设置壳、搜索索引、配置文件、Zustand/Dexie、Host RPC 与账号同步。             |
| technical    | medium | 合并、可选键清除和同步状态需要明确数据语义，已有时钟、队列及字段契约可复用。 |
| coupling     | high   | 同一设置键影响本机、配对 Host 和可写副本，旧客户端仍使用现有 wire 约定。     |
| requirement  | medium | 审计目标明确，恢复同步的暂停期编辑策略及类别粒度有待选择。                   |
| verification | high   | 可用隔离测试复现逻辑，真实发布配置、Host 离线和跨壳验收另需环境。            |
| risk         | high   | 错误覆盖可传播到整个账号，暂停失效打破用户的同步同意。                       |

## Risks

| ID  | Risk (impact)                                | Severity | Source                                       | Claim                                                      | Refuted by                                           |
| --- | -------------------------------------------- | -------- | -------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| R1  | 首次加入、恢复或同组并发覆盖用户设置。       | high     | ADR-0215、双写与历史重放。                   | 默认值和无关写入不会覆盖显式设置，独立修改能保留。         | 麦克风编辑重置账号主题，或者资料并发编辑掉字段。     |
| R2  | 设置关闭后仍传播编辑。                       | high     | 采集开关与 outbox 分离。                     | 关闭后产生的更改不会发出。                                 | 另一副本收到在关闭后编辑的值。                       |
| R3  | Host 清除或账号设置拉取后有效设置滞后。      | medium   | ADR-0097、序列化和 store 投影。              | 清除可往返，运行态及时采用落库后的值。                     | 收到新快照仍保留旧配色，或 store selector 返回旧值。 |
| R4  | 用户无法识别设置作用域、失败与恢复入口。     | medium   | 设置导航与状态流。                           | 中英搜索能定位账号同步操作，错误和成功有准确语义。         | 恢复密钥查找不到，pull 成功盖掉 push 失败。          |
| R5  | 配置文件和全局重置承诺超出实际行为。         | medium   | Profile 持久化和设置操作入口。               | 合法设置可往返，无效值在保存前被拒绝，重置对明确范围完整。 | 有效主题导入丢失、无效主题保存、全局重置漏项。       |
| R6  | 客户端发布配置或真实设备行为不同于本机证据。 | medium   | 构建开关、三壳和双同步面。                   | 生产方式安装后能完成首次加入、暂停、恢复与清除。           | 任一真实设备流程出现旧值、未报告待发或不可达入口。   |
| R7  | 本机凭据越过配对设置写回应的权限边界。       | high     | 反查 ADR-0097 下发限制及同一数据的写回流向。 | 所有设置回包只携带调用方需要且有权看见的字段。             | 成功响应直接携带保存函数返回的含密钥设置对象。       |

## Verification obligations

| ID  | Risk              | Method                                                     | Independence | Evidence                                                                                          | Coverage                                                                                   | Status  |
| --- | ----------------- | ---------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| V1  | R1,R2             | 双副本执行加入、停启、并发编辑。                           | tool         | 隔离探针复现 F1–F4。                                                                              | 生产捕获、加解密、应用及公开开关。Fake IndexedDB、内存同步服务。                           | failed  |
| V2  | R3,R4             | 走清除线格式、store 重读、带错误的双向同步状态和双语搜索。 | tool         | 隔离探针复现 F5–F7、F10。                                                                         | JSON 边界与 mock Companion 响应、真实 Zustand 和设置搜索索引。                             | failed  |
| V3  | R5                | 实际导出/导入和重置补丁走本地保存。                        | tool         | 隔离探针复现 F8–F9。                                                                              | 有效及无效颜色主题，两个重置入口的数据层。                                                 | failed  |
| V4  | R1,R2,R3,R4,R5    | 跑既有相关套件和同步生成一致性门禁。                       | tool         | 18 套件 468 测试通过，`[gen-settings-sync] OK`。                                                  | 工作区现有单测和组件测试，含普通设置收敛、排除、本机持久化、配对投影、搜索及状态。         | passed  |
| V5  | R6                | 在本机测试之外核验生产制品与两台设备。                     | real-env     | 本轮记录真实环境验证入口和边界，未执行。                                                          | Tauri/Capacitor、独立浏览器、真实配对 Host 与发布构建。                                    | blocked |
| V6  | R7                | 沿设置写结果反向追踪密钥来源、转发及投影。                 | self         | F11 路径直接转发。既有写路径的 2 个用例通过，覆盖保存后返回设置与输入结构校验，缺少响应字段检查。 | 桌面写桥及 service plane，核对工作区及 HEAD 对应的 Rust 分支。                             | failed  |
| V7  | R1,R2,R3,R4,R5,R7 | 逐项寻找反例、限制适用面并检查生命周期接缝。               | tool         | 25 个隔离探针通过，A1–A8 已记录。两名独立审查者复核源代码。                                       | 双副本、故障注入、设置持久化及 UI store，凭据路径只读追踪。                                | failed  |
| V8  | R1,R2,R3,R4,R5,R7 | 修复后逐项回归：每条改动配一个在旧代码上失败的用例。       | tool         | join 4 例、引擎 6 例、设置保存 4 例在 HEAD 代码上失败、修复后通过；受影响 232 套件 2954 例通过。  | Fake IndexedDB 双副本、公开引擎入口、真实 Zustand、导入/重置数据层；不含真实壳与真实网络。 | passed  |

## Decisions

| ID  | Date       | Decision                                                                                                    | Action   | Based on          | Reversal trigger                                 |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------- | -------- | ----------------- | ------------------------------------------------ |
| D1  | 2026-11-18 | 按本机、账号和配对 Host 分别追踪来源、落库和显示，配置文件作为独立入口核对。                                | diagnose | O1,O2,C1          | 出现合并两条同步链路的实施决策或不同的权威模型。 |
| D2  | 2026-11-18 | 优先收紧配对写回应、暂停边界、首次加入和恢复时的编辑保留。随后统一清除语义、store 刷新和状态，再打磨导航。  | harden   | H1,H2,H3,O3,O4,O5 | 真实路径反证，或团队明确新的停启与冲突契约。     |
| D3  | 2026-11-18 | 保留 F11 的优先级，将 A1、A2 纳入首批修复，先兜住回退、首启中断和停启边界。F10 收敛为搜索缺口。             | harden   | O5,O6             | 已发行配置、真实双设备或故障注入反证。           |
| D4  | 2026-11-20 | F2/F3 按用户选择：关闭期间继续记录时钟但不收发，重新打开后上传，较新修改为准。                              | harden   | H1,H2,Q2          | 产品改为关闭即丢弃或选择性同步。                 |
| D5  | 2026-11-20 | F4 不在本仓库单独改：协议 §7 规定设置按键一个 `value` 字段，子字段时钟需先改 cognia-services 规范再升 pin。 | escalate | O4                | 协议规范落地子字段时钟，或决定拆分对象设置键。   |

## Residual risks

| ID  | Residual                                       | From  | Why still open                                                                     | Next action                                                                        | Status |
| --- | ---------------------------------------------- | ----- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| X1  | 初次加入、暂停期上传和恢复丢值。               | V1,V8 | 已修复（e2fdaeb567），双副本回归通过；未做真实壳。                                 | 真实断网、重启、旧版本和在飞请求矩阵，随 X4 一起跑。                               | open   |
| X2  | 清除传播、设置生效和状态反馈出现分歧。         | V2,V8 | 已修复（465bf08d4f、e2fdaeb567），单测含建队失败。                                 | 两端实际 UI 与真实配对 Host 上的上行故障，随 X4 一起跑。                           | open   |
| X3  | 导入和重置存在部分成功。                       | V3,V8 | 键集、逐值校验、全局重置已修复（465bf08d4f）；导入前预览未做，改为提示被跳过的键。 | 决定是否需要导入预览和重置撤销。                                                   | open   |
| X4  | 生产构建开关及真实设备结果未知。               | V5    | 证据来自当前工作区、测试和官方文档。                                               | 用开关开启的测试构建及隔离账号跑 Tauri、Capacitor 和 Web，验证配对与账号两条链路。 | open   |
| X5  | 写响应最小化及已发行客户端影响范围待验证。     | V6,V8 | 回包改为 `{ updated, updatedAt }`，合成凭据断言通过（465bf08d4f）。                | 已发行客户端只读 `ok`，配对传输回归并入 X4。                                       | closed |
| X6  | 交错保存、恢复、状态和搜索凭据边界仍存在缺陷。 | V7,V8 | A1–A8 与源码风险 1–7 已修复并有回归断言；F4 见 D5。                                | 真实壳验证并入 X4；F4 等协议决定。                                                 | open   |

## Outcome

| ID  | Signal                                                 | How / when measured                                     | Result                                                                                                            | Status  |
| --- | ------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- |
| M1  | 能区分已复现缺陷、刻意的本地范围与尚待真实验证的行为。 | 2026-11-18 源码追踪、隔离探针、既有测试和官方文档对照。 | F1–F11 已逐项收紧范围，A1–A8 有补充证据和优先级。                                                                 | met     |
| M2  | 用户配置可保留、同步状态可相信并可从误覆盖恢复。       | 修复后复跑探针以及 V5 实设备矩阵。                      | 2026-11-20 代码修复与回归断言完成（232 套件中 231 通过，失败为既有的 vector 分区守卫）；V5 实设备未跑，F4 待 D5。 | pending |

## 复查方式

核对基线为 `dev` 的 `8991a9d7be3b`，取证使用共享工作区的源码。并发提交 `d425a059a7` 未变更本轮审计的实现。存在并发编辑的 Rust service plane 文件已核对 HEAD 的相关命令分支。测试环境为 Darwin arm64、Node v26.12.1。探针保留在本机 `.cache/settings-sync-gap-audit/`，初审的 3 个套件共 12 个探针。复核在同目录加入 adversarial-account 和 adversarial-companion，五个套件共 25 个探针。已有测试分别为 11 套件 / 146 用例、7 套件 / 322 用例、写路径选择执行 2 个用例。

```bash
pnpm test -- --runInBand --config .cache/settings-sync-gap-audit/jest.config.mjs
pnpm test -- --runInBand lib/account-sync/data/join.test.ts lib/account-sync/data/engine.test.ts lib/account-sync/data/sync-round.test.ts lib/sync/handlers/app-settings.test.ts lib/settings/mirror-to-host.test.ts lib/db/settings.test.ts components/settings/settings-shell.test.tsx components/settings/finder/control-registry.test.ts components/account/sync/account-sync-data-panel.test.tsx components/account/sync/join-choice-dialog.test.tsx app/me/sync/page.test.tsx
pnpm test -- --runInBand hooks/account-sync/use-account-sync-engine.test.ts lib/global-search/providers/settings.test.ts stores/settings/settings-store.test.ts lib/settings/profile-transfer.test.ts lib/account-sync/feature-flag.test.ts components/mobile/me/sync-status-panel.test.tsx lib/sync/desktop-sync-source.test.ts
pnpm test -- --runInBand lib/companion/desktop-write-source.test.ts -t app_settings_update
pnpm test -- --runInBand components/settings/companion/sync-status-card.test.tsx components/settings/companion/webrtc-card.test.tsx lib/signaling/desktop-controller.test.ts lib/tauri/transport-routing.test.ts
pnpm settings-sync:check
node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/2026-11-18-settings-and-sync-gap-audit.md --final
```
