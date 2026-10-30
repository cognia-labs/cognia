# Bot E2E 与真实 IM 验收方案

日期：2026-10-28，后续验证持续更新。状态：19 条 Bot 进程 E2E 已实现并通过；真实 IM 环境及后续接入方案待讨论。本机使用当前构建的 Brain 与已有 Rust Host 产物，完整 Rust 重编译因磁盘预检阻止。

目标是让每条测试回答一个具体问题：哪个输入进入了哪个 Bot、由哪个账户执行、产生了哪些持久状态和外部副作用，取消或崩溃后是否仍遵守同一契约。

## 测试体系

| 层                   | 执行环境                                                                   | 稳定断言                                               | 运行入口                                                  |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| 框架回归             | 本地模拟网络、临时文件                                                     | 判定、隔离、脱敏、构建身份、清理                       | `pnpm test:e2e:bots:harness`、`pnpm im:test:unit`         |
| Bot 进程 E2E         | 实际 Rust Host、当前构建 Brain、磁盘插件、SQLite；外部接收端为本地 fixture | 安装、交付、控制、账户、checkpoint 与真实 SIGKILL 恢复 | `pnpm test:e2e:bots:prepare` 后 `pnpm test:e2e:bots`      |
| 配对端 E2E           | 实际配对客户端、Host 认证／授权                                            | DPoP、租约、撤权、操作来源与实际执行效果               | 复用 Web↔Headless lane；Bot 专项矩阵待补                  |
| 真实 IM 验收         | 专用平台账户、会话、Host，先使用确定性模型                                 | 平台消息／回执与内部 delivery/run 相互对应             | 复用 `im:test:doctor`、`im:test:live`，组合控制场景待接入 |
| 真实模型／外部 Agent | 上述沙箱加实际 provider/runtime                                            | 有限预算内的终态、产物、取消、恢复                     | 独立限额验收，待明确账户与环境                            |

项目及 19 条用例见 [运行说明](../../tests/bot-e2e/README.md)。进程 E2E 的结果绑定构建收据和输入／输出摘要。`--brain-only` 只用于本地已有 Host 产物诊断，报告明确 `hostBuiltFromSource:false`，CI 拒绝将它作为当前 Rust 源码验收。

## 真实 IM 的完整执行流程

1. 选择独立测试 Host 和专用会话，保存到被 gitignore 排除的本地配置。操作者保留登录、密钥和授权步骤；报告仅使用账户、会话与 Host 的非秘密标识。
2. Doctor 核对实际 Host／Brain 构建身份、Bot definition/installation/trigger、输入与输出账户、runtime ownership、平台身份和历史读取权限。模型路由必须在发送前确认指向测试 fixture；无法确认时停止，不能仅在事后推断曾调用收费模型。
3. 记录配置快照，创建只属于本轮的 Bot installation、trigger mapping 和消息 marker。复用现有平台 driver 独立发送、观察平台消息，不通过被测 adapter 反证自己。
4. 依次运行 mention、无额外 mention 的 quote、允许／拒绝来源、双会话隔离、多 trigger、暂停／恢复、运行中取消、审批取消和重绑定。每个 case 独立记录 PASS / FAIL / NOT_RUN；必选 case 未执行时整轮不能通过。
5. 在已接收输入、已提交 step、已发送但回执丢失等明确边界注入故障。实际重启测试 Host，核对原 delivery/run/approval 身份、deadline 和平台副作用。平台接收结果不确定时验证待核对状态，不能无条件重试发送。
6. 保存 `platform message → ingress → delivery → parent/child run → step → outbound intent/ACK → platform reply` 关联，以及配置前后状态和构建身份。计数按本轮新增请求计算，避免把对话历史中的旧 marker 当作新执行。
7. 只清理本轮创建的安装、配置和消息 ID；清理失败单独列出。用户原账户、授权、会话及消息保留。

## 后续必须补齐的边界

- **Published Workflow**：需要使用真实 create/publish API 预置已发布 deployment，再从 Bot 执行真实 orchestrator；当前公开 RPC 缺少完整发布入口，不能用 draft 或 fake executor 代替。
- **正式插件安装与信任**：当前 workload 在私有测试 profile 中预置，并只信任该测试插件。正式 cogpack 传输、Host 信任授权与撤销、重启后的配置保留需要独立验收，不能由预置 fixture 代替。
- **Squad / agent-turn**：使用实际 Team/Character/provider 配置和真实进程调用链，确定性 provider 作为首层；外部模型单独验收。目前新增项目的正向 executor 是 Handler。
- **配对端控制负向矩阵**：过期／外来 admin lease、撤权、跨 Host、operation replay，必须使用真实设备认证。当前进程 lane 使用 service scope，不能替代这层授权证明。
- **真实平台组合场景**：目前 live harness 仍主要覆盖两轮文本，新的 Host 控制／账户测试尚未与真实 IM driver 连成同一个场景执行器。应在确定测试账户后补上 target readiness、场景选择、零发送观察和内部 trace collector。
- **QQ Official Bot**：已添加独立的 `qq-official` 群／C2C 客户端文本观察入口，配置和报告均与 OneBot 分开。被动回复窗口、流式发送及模糊回执仍需要真实平台专项场景；C2C 历史读取能力和应用到客户端 UIN 的身份映射尚待实测。不能把 OneBot PASS 作为 QQ Official 验收。
- **媒体与交互**：附件实际可读字节、卡片真实点击、重复／越权审批和拒绝后的零发送。

这些边界必须保持未完成标识，不能由单元测试数或 Handler E2E 的绿灯代替。

## 建议讨论的第一轮范围

按后续需求优先完善 **QQ Official 与 OneBot 的独立沙箱**。用户确认暂时没有专用环境，本轮先完成用例与流程，暂不连接真实 QQ 账号。环境就绪后先校准观察端与目标身份，再运行文本闭环和以下矩阵；之后连通 Handler 与一个已发布 Workflow，扩展多 trigger、暂停／取消、A/B 账户和重启。

需要确定的只有：测试 Host／配置文件位置、首个平台及专用会话、可使用的测试账户，以及真实模型验收的预算。平台凭据不写入方案或测试报告。

## QQ 专项执行顺序与验收矩阵

1. **隔离与校准**：在专用 Host 上启用目标 QQ Official 适配器，记录 AppID／OpenID、客户端 UIN、群号／group_openid 或私聊 peer／user_openid 的对应关系。观察端登录真人测试账号。用同一条受控消息的 marker、Host 发送回执和客户端历史校准身份；不能按昵称或直接把 AppID 当 UIN。C2C 必须先证明实际观察端可读取官方 Bot 私聊，否则停留为未执行。
2. **文本 smoke**：先启动 fixture 目标并核对模型路由，再执行 `pnpm im:test:doctor -- --platform qq-official` 和 `pnpm im:test:live -- --platform qq-official`。群聊两轮均显式 @，第二轮另加引用；C2C 是文本与引用。OneBot 使用自己的配置和 `--platform onebot`，第二轮强制纯引用无 @。两者保留独立报告。
3. **控制与故障专项**：在明确持久边界暂停、取消或重启专用 Host。以客户端结果与实际 run/delivery/stream intent/ACK 同时判定，不把本地单测和两个文本 turn 代替这些场景。组合场景执行器、Host trace collector 仍待接入专用环境。
4. **汇总与清理**：每项单独标注 PASS／FAIL／NOT_RUN；必选项未执行时整体验收不能通过。只清理本轮创建的配置、安装和消息，保留原授权及账户；当前只读观察器保留消息供人工清理。

| 场景                             | 当前可执行证明                                            | 真实 QQ 状态／通过条件                                     |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| Official 群 @ 与带 @ 引用        | 独立 driver、实际 CLI＋fixture＋报告组合回归              | NOT_RUN；身份校准后，两轮各一个关联模型请求和客户端回复    |
| Official C2C 文本与引用          | 私聊 history 分支及失败即停回归                           | NOT_RUN；先确认该部署确实能读取官方 Bot 私聊               |
| OneBot 纯引用无 @                | 验证 reply 段并拒绝目标 at 段                             | NOT_RUN；真人客户端纯引用实际触发，不能附加 @              |
| Official 群纯引用无 @            | 本地 parser/admission 合同存在                            | NOT_RUN；需要单独确认全量群消息实际投递授权                |
| 原生流式完成                     | 实际适配器测试原消息 ID、序号、终帧                       | NOT_RUN；平台 ACK 与客户端最终内容一致，非仅 HTTP 成功     |
| 发送中取消、关闭帧被拒           | 适配器延迟 ACK 与 429 关闭回归；取消状态保持              | NOT_RUN；取消后无新增内容、迟到终态不复活，重启仍成立      |
| 停止／启动续接                   | 实际适配器续接原 server ID、原 msg_seq，final 重放不 POST | NOT_RUN；专用 Host 真正重启后核对客户端无重复消息          |
| 模糊回执                         | pending、缺 ID、换 ID、连接丢失后重建适配器不重复 POST    | NOT_RUN；平台可能已接收时进入待核对，不降级重复发送        |
| 权限、多账户、多会话、多 trigger | Bot 控制进程 E2E 与独立协议回归                           | NOT_RUN；必须组合真实 QQ ingress、账户映射及 Host 控制执行 |
| 媒体／卡片                       | 序列化及适配器合同                                        | NOT_RUN；附件真实可读、真实客户端交互及越权拒绝            |

当前文本报告明确 `acceptanceScope=client-visible-text-smoke`，不包含应用身份映射、流式完成、Host 控制和回执恢复。历史中尚不支持的 Markdown／卡片投影不能伪装成文本。C2C 同秒满页且边界无法排序时明确失败，不能用发送者局部序号推断顺序。所有这些限制须随报告保留。

## 首批验证记录

实际结果：进程 E2E **12/12**，相关 Jest **10 suites / 259 tests**，IM observer 回归 **258/258**，harness 单测 **4/4**；均为实际运行结果。独立对抗审查两轮，已补强排队重绑定、迟到审批／结果、构建身份及进程清理断言。

验证边界：本机未进行实际 IM 发送、外部模型调用、配对设备专项授权验收或 CI 运行。完整 Rust 源码构建预检要求 4 GiB 可用空间，本机不足，故使用明确标注的 `--brain-only` 本地产物诊断；CI 拒绝该模式。全仓 lint/typecheck/static-export 仍有本轮范围外错误，不能称全仓通过。

命令、初始失败与修复、最终日志以 `docs/evidence/2026-10-28-im-bot-ten-findings-fix.md` 的 Bot E2E follow-up 和 `.cache/diagnostics/bot-e2e-2026-10-28/` 为准。最新进程日志为 `runtime-tls.log`。

QQ 后续验证：`pnpm im:test:qq --runInBand` **34 suites / 783 tests 通过**，包含本轮新增 7 条实际适配器生命周期／模糊回执用例；`pnpm im:test:unit` **280/280 通过**，其中群／C2C 组合测试执行真实 CLI、fixture、HTTP 观察器和报告写入，但 QQ 平台及目标仍为本地 stand-in。独立对抗审查三轮，发现的身份、时间、消息 ID 和分页问题已补回归；第三轮未发现新的实质问题。QQ Doctor 因缺少专用配置实际以非零状态退出，未连接平台。用户已明确“暂时没有，先完善用例与流程”。

## 后续增加的进程用例

在原有 12 条基础上新增 7 条：审批通过的跨运行隔离、拒绝及迟到重放、审批原期限过期、精确取消排队项、跨账户相同 provider delivery ID、停用后拒绝新工作、卸载运行中及排队工作。用例始终走实际 Host／Brain／SQLite，外部副作用止于本地接收器。

审批期限对照实际持久 step 的 `startedAt`，并在到期前观察 pending 状态；停用输入核对持久 projection 已完成，再重投旧输入并验证新输入的独立身份。隔离用例通过屏障保证另一 installation 确实存在运行中及排队工作。缺少公开投影的内部状态仅从本轮私有 SQLite 只读观察，不新增生产调试入口或直接修改数据。

新用例发现并推动修复了 integration Bot source 未包含账户的身份冲突：新事件使用有版本前缀的固定长度摘要，覆盖 plugin／integration／account／provider delivery ID；已接受的旧事件按账户保留原 ID、run 和 checkpoint，防止升级后恢复出重复工作。摘要长度遵守现有 Host run ID 合同，不扩大协议限制。

停用用例还暴露了手动入口仍可接受新工作的缺陷。新工作在同一事务内检查 installation、definition 和运行状态，并在实际插入前再次核对插件注册身份；既有手动操作回执仍能在停用、插件卸载或默认 trigger 改变后被取回。回归测试覆盖嵌套入队期间插件卸载的竞态，不依赖事后的 runner 拒绝来掩盖错误入队。

最终完整运行 **19/19 通过**，耗时约 7.1 分钟，无跳过、重试或 flaky；相关 Bot 回归 **50 suites / 769 tests 通过**，其中针对本轮修复的 **7 suites / 246 tests** 也单独通过，harness **7/7**。两组 Jest 结果有重叠，不能相加。独立对抗审查已完成，复现发现的问题均补回归后修复；最后一轮未发现本轮范围内新的实质问题。

全仓 lint、typecheck 和本轮格式检查通过。静态导出检查仍有范围外 `agent-codebuff`／`agent-crush` 的 14 个 Node 导入问题。最终 19 条的 33 个测试进程组均已退出，早前中断尝试遗留的独立测试进程及私有 profile 也已清理。完整日志和构建身份见 `.cache/diagnostics/bot-expanded-verified-process.log`、`bot-expanded-bot-suite.log`、`bot-expanded-verified-cleanup.json` 与 `.cache/test-results/bots/`。

上述结果仍使用明确标注的已有 Rust Host 与当前构建 Brain；真实 QQ／飞书、配对设备和其他 executor 的未完成边界不变。

## 其他 IM 测试扩展，2026-10-29

本轮新增 49 条回归：四个平台的组合测试 20 条、Slack／Matrix 分页观察 19 条、Slack Socket Mode 传输生命周期 10 条。

| 平台／层                           | 本轮补齐的可执行合同                                                                                 | 证据边界                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 飞书、Slack、Discord、Matrix       | 各 5 条 CLI＋HTTP＋模型 fixture＋报告组合测试：两轮成功、第二轮重复、绕过模型、Doctor 拒绝、清理被拒 | 平台及响应目标为本地 stand-in，不等于真实 Cognia／平台收发             |
| Slack／Matrix 观察器               | 历史／线程完整分页、空页 continuation、重叠去重、非法游标、后页失败后重试                            | 实际 HTTP 观察请求；超过 100 页明确失败，不把部分历史当成功            |
| Slack Socket Mode                  | 协议断开／WS close 重连、新 token／URL、当前连接 ACK、退避取消、各连接阶段取消和部分监听注册失败     | 运行生产 generator；原生 bridge 使用 mock，尚未证明 native socket 行为 |
| 企业微信、钉钉、微信个人号／公众号 | 既有平台 contract／transport 套件加入统一 `im:test:contract` 与 CI                                   | 尚无独立客户端观察 driver，不表示已完成这些平台的组合／实网验收        |

分页缺陷先以 12 条失败复现；独立审查另复现了 4 条非法 falsy cursor。Slack 连接阶段取消先有 4 条失败，再以 2 条回归复现部分监听注册失败的泄漏，均修复后通过。清理核对实际创建的 probe／reply ID、每次 HTTP 清理请求及 deleted／retained 全集；不只比较数量。

最终 `pnpm im:test:unit` **319/319 通过**，包含上述 20 条组合测试，无跳过或取消；`pnpm im:test:contract --runInBand` **31 suites / 522 tests 通过**，其中 Slack 传输测试 14 条。独立对抗审查完成两轮，10 个故意破坏 Doctor 阻断、发送目标或清理 ID 的变异检查均被测试拒绝。CI 已配置运行并上传 `.cache/test-results/im-observers/`；本轮未实际触发远端 CI。

全仓 lint、typecheck、格式和 E2E 治理检查通过；静态导出仍被范围外的 14 个 Node 导入问题阻挡。20 份组合报告均明确标注本地平台与目标 stand-in，临时测试目录已全部清理。

本轮未发送真实 IM 消息或调用付费模型，也未重新运行 Bot Host／浏览器／Tauri E2E。真实平台权限、客户端渲染、媒体／卡片、断线恢复和多账户组合仍须按前述专用环境流程验收。执行日志见 `.cache/diagnostics/im-other-2026-10-29/`。

## 企业 IM 生产适配器协议层，2026-10-29

后续新增 **43 条测试**：`pnpm im:test:loopback` 的 32 条，以及钉钉／公众号同位置的 11 条回归。协议层运行实际 TypeScript 适配器、解析器和传输，连接真实本地 HTTP／WebSocket 服务；原生桥、准入和持久存储为测试替身。这比仅由 stand-in 响应目标验证验收 CLI 更深入，但仍不等于 Rust 或真实平台验收。

| 范围       | 新用例 | 可观察合同                                                                                                                   |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 企业微信   | 5      | subscribe、回调、跨会话 stream／req_id 隔离、迟到 preview ACK 与 final ACK、服务端拒绝、断线重订阅、停止后拒绝发送           |
| 钉钉       | 4      | 精确注册／发送路径、ticket、实际 HTTP 回复、接受完成后 ACK、仅一次 NACK、重连和运行时取消                                    |
| 微信个人号 | 10     | 实际长轮询／回复 HTTP、peer/context token、未接受输入重试、停止与 revision 隔离、checkpoint 逐项归属验证                     |
| 公众号     | 6      | 实际 XML 输入及出站 HTTP、先 claim 后 emit、拒绝 claim 后继续处理合法输入、独立 occurrence ACK、ACK 单独重试、启动恢复与取消 |
| 测试设施   | 7      | 实际 HTTP／WS、禁止外部 URL／路径逃逸、全局桥所有权、异步工作与重复 close、证据脱敏                                          |

新用例复现并修复了钉钉和公众号忽略 runtime abort 的问题，以及钉钉获取连接期间取消时的资源泄漏和错误 HTTP 注册结果被接受的问题。独立审查发现的弱断言均用反向变异验证后补强；测试设施也修复了地址重写、清理和报告字段问题。

实际结果：本地协议层 **32/32**、连接器契约 **32 suites / 544 tests**、两个适配器回归 **89/89**、IM 工具 **319/319** 全部通过。各组有包含关系，不相加作覆盖结论。最终 33 份 fixture 报告对应 32 个用例，记录 36 次本地 HTTP 请求、19 条 JSON WS 帧、13 条 WS 连接；异步清理计数均归零，正文／凭据检查通过。报告与清单位于 `.cache/test-results/im-loopback/`、`.cache/diagnostics/im-enterprise-2026-10-29/final-manifest.json`。

全仓 lint 和 E2E 治理通过。全仓 typecheck 的 root 阶段通过，sidecar 阶段被范围外的 318 条诊断阻挡，本轮改动路径无诊断；静态导出仍有范围外的 14 个 Node 导入问题。CI 仅完成接线，未运行远端任务；本轮未编译 Rust、操作真实账号或调用模型。四个平台的独立客户端观察 driver、原生持久化及实网矩阵仍待专用环境。

## Rust 原生桥补全（2026-10-29 后续）

新增 `pnpm im:test:native`，从当前源码编译独立 Rust 进程，复用同一批企业 IM 适配器；HTTP／WS 调用和事件经过真实 Rust 实现。额外覆盖 Telegram、Slack、Discord、Lark、QQ 回调验签与账户隔离、OneBot 反向 WS、公众号加密签名／appId、挂起／拒绝准入和精确 ACK，以及两次 SIGKILL 后未领取／已领取队列的加密磁盘恢复。stdio 仅为测试传输，不等同于 Tauri IPC。

本轮新增 **21 条**测试。最终原生入口 **44/44**，Rust 连接器 **348/348**，连接器契约 **544/544**，JS loopback **32/32**，构建／Bot harness **9/9**。各组包含关系不相加。44 份进程回执中，41 份正常结束，3 份故障注入按预期明确记录失败；队列／socket 清理计数均为零，隔离密钥目录全部移除。源码和二进制身份、run ID 与结果报告位于 `.cache/test-results/im-native/`。

独立对抗审查补强了启动失败、关闭期间异常、错误签名与 appId、准入前禁止 ACK，以及 Cargo target 导致旧二进制误用的回归。接线复审确认实际 Cargo executable、Jest 选集及 CI 调用一致。CI 接线已完成，尚未运行远端任务。

本轮范围内 lint、格式、clippy 和 E2E 治理通过。全仓类型检查有 16 条范围外错误，全仓 lint 被 `plan-card.tsx` 两条错误阻挡，Rust 架构 gate 被范围外新增 `native_agent_bridge.rs` 阻挡；没有修改基线。真实平台／客户端、Tauri GUI／IPC、Matrix E2EE 全路径、模型及机器掉电恢复仍未验收。复用企业用例中的 JS 准入／checkpoint 仍为 fixture，公众号专门原生用例的加密存储与进程恢复已经实际验证。

## Matrix E2EE 与原生桥后续（2026-10-29）

新增 6 条原生用例，并延伸既有 `pnpm im:test:native`，不另建加密实现：

- 两个真实 OlmMachine 经现有 TS wrapper／Rust command，交换实际签名设备密钥、一次性密钥和 Olm 加密房间密钥，再跨设备解密 Megolm 消息。homeserver 仅由本地 HTTP relay 替代，加密及加密 SQLite 均为真实实现。
- SIGKILL 后恢复同一数据库与凭据，比较两类非空设备身份公钥，解密重启前后消息；模拟 key upload 已到服务器但 ACK 未落本地。
- 错误账户／房间、合法 base64 但字节被篡改的密文均拒绝；同一数据库错误口令不能打开，正常重开后公钥一致。拒绝外部 store 目录和身份冲突。
- 原生 HTTP 按 Unicode 实际 UTF-8 字节数验证 N 成功、N−1 明确超限；WS 二进制逐字节一致，非法双参数后通过同一 writer FIFO 屏障确认没有发送副作用。

独立对抗审查补齐了磁盘加密负例、密文完整性、公钥恢复、字节边界和无副作用断言，并修正测试类型问题。Crypto 审查三轮、桥接审查两轮完成。真实 homeserver、Tauri IPC、完整 TS adapter sync／重试、多媒体及交叉签名／备份仍单列，不能由本地 native crypto 结果推断已验收。

最终原生入口 **50/50**、既有 Matrix TS 测试 **222/222**、Rust crypto 单测 **8/8**、JS loopback **32/32** 均通过；范围内 lint／格式／clippy／治理通过。50 份进程回执中 47 份正常、3 份为预期故障注入，3 次 SIGKILL 均核验退出信号，无遗留队列／socket／私有 profile。源码及二进制身份检查通过。最新 root 类型检查仍有 9 条范围外 managed-desktop 错误，本轮路径无诊断。日志、最终 run ID 和报告位于 `.cache/diagnostics/im-matrix-native-2026-10-29/`。CI 使用现有原生入口自动选中新增用例，本轮未运行远端 CI。

## Matrix adapter sync、媒体与正式备份恢复（2026-10-29）

本轮按用户确认补齐正式备份／恢复能力，并将三类组合测试加入既有原生入口，未另建加密栈或伪造实网验收。新增 15 条原生测试，最终入口 **65/65**；以下结果包含既有 50 条，不相加声称独立覆盖。

| 范围           | 实际执行与断言                                                                                                                                                              | 证据边界                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| adapter sync   | 实际 adapter、原生 HTTP／OlmMachine、生产 DB CRUD；解密投递、可被另一设备解密的回复、游标恢复、迟到密钥恢复、准入拒绝、runtime abort、初始化／关闭及停止后 pending-row 归属 | Node IndexedDB 后端，不证明浏览器磁盘 |
| 媒体           | 实际 SDK 加密上传／下载解密、密文哈希、原文逐字节比较、加密缓存、命中不重复请求、账户／大小隔离、篡改拒绝和 SIGKILL 后缓存恢复                                              | 真实原生磁盘，本地 HTTP peer          |
| 密钥备份／恢复 | 运行中 adapter 的 `keyBackup.create()`／`restore(recoveryKey, version?)`；原生持久密钥、真实签名与加密备份；服务器 ACK 后才标记，新设备恢复后真实 pending event 被投递      | 正式内部 API；没有新增设置 UI         |

备份接入既有 service-only Host／Tauri command、命令清单及有限请求／响应 schema，并同步现有生成器产出的本地命令 ACL。创建前原生加密保存恢复密钥；UUID claim 串行化独立调用者，未确认的创建结果在 SIGKILL 后保留，先协调服务器状态再允许下一次创建。只有确定没有发送或明确认证拒绝才撤销自己的 claim。未知网络结果不盲重试。恢复先验证版本、公钥与由会话密钥真实推导的 Megolm session ID，再导入；限制 8 MiB／500 个会话及 64 KiB 元数据。返回的恢复密钥需要由调用方私密保存。

独立对抗审查分别检查 sync、媒体、备份安全和跨层接线，修复了：

- 拒绝输入后错误推进 sync 游标、忽略 runtime abort、初始化与关闭交错、停止后删除尚未交付的 pending event，以及游标读取后缺失代际检查。
- 只扫描 `.enc` 的弱缓存断言；现在检查全部文件，拒绝意外文件并检验原文不落盘。
- 仅比较外层 session ID 的无效恢复检查、迟到 token 导致取消后仍发请求、未知创建结果被重放、元数据没有大小限制、并发创建 claim 不原子及覆盖未解决恢复密钥。
- Host 通用回执可能持久保存恢复密钥。备份命令改用已有私密结果策略，实际 canonical execute／SQLite／WAL 回归确认输入和结果均不落通用回执，重试仍重新执行领域逻辑。

最终结果：原生进程 **65/65**、Rust 连接器 **350/350**、同位置 TS 回归 **14 suites / 292 tests**、JS loopback **32/32**；额外 canonical 私密回执 **1/1**、命令策略 **1/1** 通过。各组有包含关系。root 类型检查、范围内 ESLint／格式、原生 fixture clippy 通过；E2E 治理通过，保留 14 条已有债务。API 生成检查为 **973 commands**。语义检查仍被范围外的 4 个不透明响应超额阻挡（114 > 110），新增 backup command 无该类问题，未降低基线。未运行全仓 build、sidecar 类型检查或远端 CI。

最终 run ID、源码／二进制摘要、过程回执和日志保存在 `.cache/diagnostics/im-matrix-sync-media-backup-2026-10-29/`。真实 homeserver／独立客户端、浏览器磁盘持久性、交叉签名、Tauri GUI／IPC 和机器掉电仍未验收。无真实平台消息、模型调用、用户 profile 写入或 coverage 检查。

## Matrix 交叉签名与浏览器持久化（2026-10-29）

本轮补齐运行中 adapter 的 `crossSigning.bootstrap(auth?)` 和 `crossSigning.status(userId?, deviceId?)`，接入现有 Rust crypto owner、internal service command 与 Tauri handler／ACL／生成目录。只调用真实 SDK 的非 reset 初始化；私有签名种子不离开原生加密存储。服务端 self-query 必须完整且没有失败，存在旧身份而缺少其私钥时拒绝替换。UIA 错误携带受限公开 challenge，调用方可据此显式重试；没有增加设置界面、身份重置、SAS／QR 或跨设备 secret-sharing 流程。

新增 7 条原生用例，验证：实际 master → self-signing → device 签名链、合法编码的伪造签名拒绝、已签名设备与本机信任的区别、外国旧身份保护、UIA／签名上传失败、取消期间的旧 runtime 隔离，以及在 crypto store 仍打开时直接 SIGKILL 后三组公钥和签名完全保持一致。签名 relay 合并新签名，保留原设备自签名；加密与信任判断由真实 SDK 执行。

新增 `pnpm im:test:browser`：先从当前源码构建独立原生进程，再构建较轻的浏览器集成包，在真实 Chromium 的私有磁盘 profile 中运行生产 Dexie schema／CRUD／加密 middleware／Matrix adapter。它复用已有 connector seam 和 native fixture，未另建持久层。

| 用例                 | 实际可观察结果                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完整关闭再重开浏览器 | 不重新 seed，pending 行、原始事件、attempts／重试时间／首次时间及 cursor 完全恢复；底层 IndexedDB 含 AES-GCM envelope，私有标记不落明文                         |
| 双标签页与账户隔离   | 同时写入同一 adapter/event，仅一次新增；相同 ID 在不同账户隔离；错误 DEK 读取失败，正确 DEK 恢复原数据                                                          |
| 浏览器与 native 组合 | 原生实际 Megolm 消息因缺密钥排队；重开后请求携带原 cursor；迟到密钥触发解密，明确发生准入拒绝且 pending 保留，放行后只交付该 composite messageId 并删除 pending |
| 资源获取失败         | 原生启动后让 HTTP listen 实际失败，仍退出原生进程、移除私有 profile，回执没有未结束请求／socket                                                                 |

浏览器关闭前设置 closing fence；清理期间迟到的旧 `/sync` 经过实际原生 HTTP 得到终止响应，旧 poll 不会拿走新浏览器的密钥。浏览器 manifest 纳入实际 spec、config、runner、构建 helper 和输入／输出摘要；native pre/post 检查继续核对源码、二进制与 run ID。CI 已接入浏览器安装、Matrix 单测、native 与 browser 入口，并仅上传 JSON，不上传 profile。

独立对抗审查分别执行交叉签名 3 轮、浏览器 3 轮，以及接线／测试缺口／PII／Tauri preflight。修复了不完整查询误重置身份、丢失 UIA challenge、旧操作唤醒新 runtime、native close 失败无法清理、过弱的三组密钥持久化断言、浏览器资源获取泄漏、未覆盖测试入口的指纹，以及用启动重试次数冒充准入拒绝的问题。浏览器第 3 轮发现关闭标志未真正赋值；随后补上赋值及实际迟到 HTTP 回归，最终 4 条重跑通过，未开启第 4 轮审查。

最终本地结果：

- `pnpm im:test:native`：**9 suites / 72 tests**，exit 0。
- `pnpm im:test:browser`：**4 passed**，无 skip／retry，exit 0；其中 3 条驱动浏览器，1 条为资源失败回归。
- Rust connectors lib：**351 passed**；相关 TS：**15 suites / 304 tests**；既有 Bot harness：**9 passed**。这些统计有包含关系，不相加。
- 范围内 ESLint／格式、native fixture clippy、API／CLI 生成及 command-manifest 检查通过。当前目录 982 commands，本轮只新增 cross-signing 命令。
- root 类型检查被范围外 `cli/src/tui/components/Transcript.tsx` 的 3 条 readonly 赋值错误阻挡，本轮路径无诊断。全局 semantic gate 仍为范围外 opaque debt `114 > 110`；未降低基线。E2E 治理通过，保留 14 条已有债务。

Native 最终 72 份回执中 69 正常、3 份为预期故障 helper；6 次 SIGKILL，所有清理计数归零。浏览器入口的 4 份原生回执全部正常，浏览器和原生私有目录均已移除。两条入口的源码／二进制身份一致。日志、build/run 和筛选回执见 `.cache/diagnostics/im-matrix-cross-signing-browser-2026-10-29/`。

证据边界：homeserver 投递、准入策略、交互 callback bus、默认内置 seed 及未使用的默认 Host transport 是 fixture；没有 fake-indexeddb。账户 DEK 由测试显式提供，因此不证明真实登录／Browser Vault 解锁链路。尚未验收真实 homeserver／独立客户端、完整应用界面／静态导出、Tauri GUI／IPC、设备间 SAS／QR 验证、secret sharing 或掉电持久性。未运行远端 CI，未发送真实消息／调用模型、检查 coverage 或提交代码。

## Browser Vault 与 Matrix 缺失消息恢复（2026-10-29 后续）

本轮新增 5 条浏览器用例、3 条原生用例，并把原有 native/browser 组合恢复用例升级为 Vault 凭据解析。Vault 场景使用生产 Argon2id 参数，由实际密码／账户绑定恢复密钥解封 master key，再由生产数据库激活流程创建内容 cipher；不提供 raw DEK，也不替换密码派生、WebCrypto 或 Vault repository。

- 真实浏览器重开后先确认 Vault 锁定，错误密码不改变原 Vault wraps／secrets 或 Matrix pending ciphertext，正确解锁恢复完整 pending、cursor 和存储凭据。
- 密码轮换及正确恢复后，原 Matrix ciphertext 不变，原凭据仍可读；外国账户的恢复密钥被拒绝，拒绝后的完整存储先核对无变化，再尝试正确恢复。合法 base64url 的密码 wrap 字节篡改也拒绝解锁且保留原数据。
- Vault 关闭前后及解密进行中的锁定均禁止新 HTTP。后者执行真实 WebCrypto 解密，仅暂缓其结果，不伪造解密；验证锁定后不会释放迟到 token。
- 原生补拉在两个非空页之间包含空页，核对跨页最旧优先及准确消息 IDs；后页 503 时第一部分也不能提前交付或提交 cursor；重试完成才交付全部历史及 live 输入。取消后，迟到响应没有副作用，重启请求必须实际带原 `since`／`to`。

独立审查发现并复现了产品缺陷：`BrowserVaultSession.decryptSecret()` 在捕获 CryptoKey 后发生锁定，仍会返回解密 token。新增真实 WebCrypto 单测在修复前明确返回了合成 token，修复后拒绝；生产函数在 await 后检查同一密钥仍由当前 session 持有，并在 finally 清零临时 plaintext buffer。回归同时检查拒绝和清零。其余修改在既有测试设施、用例和 CI 范围。

两组对抗审查各进行 2 轮，第二轮均未发现新的范围内问题。修复或补强了跨页排序／后页失败的假绿窗口、重启 cursor 断言、Vault 与 Matrix 分库检查，以及失败恢复前后完整存储比较。Preflight 核对了生产调用链、同位置测试、PII／静态导出边界和 CI 触发／选集；未增加模型调用、schema、原生命令或 UI。

本轮实际结果：`pnpm im:test:browser` **9 passed**（零 skip／retry），`pnpm im:test:native` **75 passed / 9 suites**；Vault 两份单测 **39 passed**，扩大到 keyring、credential-book 和 runtime target 后 **116 passed / 5 suites**（包含前述 39，不相加）。范围内 ESLint、格式、E2E 治理及 diff 检查通过。Root 类型检查有 16 条范围外诊断，本轮修改路径无诊断；未改基线或处理其他任务代码。证据位于 `.cache/diagnostics/im-matrix-vault-gap-2026-10-29/`。

边界：这是实际浏览器磁盘／Vault API／Matrix/native 集成，homeserver 投递、准入策略、callback bus、内置 seed 和未使用的默认 Host transport 仍为 fixture。原生-only 用例的 Node IndexedDB 不证明浏览器存储；浏览器 Vault 用例才承担该验证。adapterInstances 的 cursor/config 遵循现有 secret-externalized 元数据策略，不宣称这些字段加密。AccountGate／account-store 启动、SAS／QR、secret sharing、Tauri IPC 和真实 homeserver／独立客户端仍须分别验收；没有账户凭据，未发实网消息、跑远端 CI、调用模型、检查 coverage 或提交代码。本轮没有 Rust 生产变更，未单独重跑 Rust library 单测，真实 Rust 进程随两个集成入口编译执行。

## AccountGate UI 与 Matrix SAS／QR（2026-10-30）

本轮按真实浏览器组件链路和原生协议/API 验收。AccountGate 使用生产组件、singleton account store、initializer、Vault、注册表、runtime target、Dexie boot/seed 和实际 Chromium 磁盘 profile；不注入解锁状态或 DEK。覆盖创建及逐密钥确认、错误密码／恢复密钥、原始密文保持、锁定后的实际数据库读取拒绝、恢复重置、账户切换与完整浏览器重启。外层 workspace、导航、未调用的 execution broker 和 Next 浏览器兼容层是明确的测试接缝；不是完整应用或 Tauri IPC 证明。

SAS／QR 通过正式内部/Tauri command 和运行中 Matrix adapter 的 verification API，使用 matrix-sdk-crypto 0.19.1 的实际密码学、加密存储与 loopback HTTP/to-device sync。测试双向 SAS 数字／emoji、双方确认、取消、有效编码 MAC 篡改、QR master-key/flow 绑定、错误／篡改 QR、同步发现、接受／取消原事务重试、后台签名拒绝不 ACK，以及真实 SIGKILL 后信任保留而未完成流程失效。API 已接入运行中的 adapter 和原生 command；本轮没有新增 SAS／QR 产品操作界面或相机扫描。

真实测试和对抗审查推动的修复：

- 恢复密钥的确认勾选绑定当前密钥，不能沿用前一账户的确认。
- 锁定同步撤销 Vault/content cipher；认证按账户 owner 串行，后发生的 lock 撤销早先解锁，排队解锁保留它遇到的 cleanup failure。
- Vault 的迟到激活被拒绝；实际数据库解密在锁定后拒绝返回明文并清零临时 buffer。密码 rewrap 已提交后，锁定仅撤销激活，保留新密码与注册表的一致性。
- 交互验证保留确切 SDK transaction 以恢复网络失败；取消不受旧握手阻塞，取消本身重试也复用原事务。共享 native ACK 边界拒绝非空 signature failures，覆盖后台 pump。
- 流程按 user/device/flow 绑定，创建前限制容量；QR 临时秘密通过 HostSemantic 策略排除在通用 receipt/run storage 之外。实际 canonical execute/SQLite/WAL 回归检查该边界。

两个独立对抗审查 artifact 均进行了 3 个有界周期。末轮发现的提交／激活竞态、排队 cleanup failure 和取消事务重试问题已修复，并用针对性回归和完整 native/browser 重新运行验证；没有追加第四轮，也不将此表述为“末轮未发现问题”。额外 preflight 检查注册、ACL、运行链路、共置测试、i18n、静态导出依赖边界和 PII 出站，无新增 blocker。用户此前拒绝的外部跨模型审查未执行。

实际结果：`pnpm im:test:native` 10 suites / 83 passed；`pnpm im:test:browser` 12 passed，0 failed/skipped/flaky/retries；相关共置回归 8 suites / 388 passed；加密 DB middleware 20 passed；Rust connector library 352 passed；私有 QR receipt policy 与真实 canonical receipt 各 1 passed。计数有重叠，不相加作为覆盖率。范围内 ESLint、Prettier、clippy、协议/CLI 生成检查和 E2E governance 通过。全仓类型检查仍有范围外错误，未改 baseline。

证据：`.cache/diagnostics/im-account-verification-2026-10-30/`，包含最终 source/binary/run 身份、匹配回执、原始失败与最终成功日志。原生 run `c1058e21-0541-465b-a66f-d74205f6b63b`，浏览器 run `295858d0-07d9-4b47-b339-732817ff9e95`。profile/进程清理与最终 manifest 详见该目录。

剩余边界：受控 homeserver、Matrix admission/callback/默认 seed/unused Host transport 测试接缝；AccountGate entry 保留真实 seed，但仍无 full-app static export、Tauri GUI/IPC、真实平台、独立 Matrix 客户端、相机/光学 QR 或 secret-sharing 验收。没有发送真实消息、调用付费/外部模型、运行 coverage、提交、推送或远程 CI。

SDK 依据：[0.19.1 VerificationRequest](https://docs.rs/matrix-sdk-crypto/0.19.1/matrix_sdk_crypto/struct.VerificationRequest.html)；实现同时核对了本机锁定版本的 SDK 源码。
