# 飞书 AI 参会：接口合同、执行宿主与实现路线研究

- 日期：2026-11-18，Asia/Shanghai。
- 范围：承接 [参会审计 ledger](../evidence/2026-11-17-meeting-participation-gap-audit.md)，继续研究 AI 参会优先、本人入会随后两条路径。本轮不实现产品、不真实入会、不启动 event consumer、不采集音频、不调用模型。
- 方法：本机 `lark-cli 1.0.98` 静态命令；官方同名 tag `v1.0.98`，commit `ac81f5056ab88f37d581d25916f3dab85abfca76` 源码；当前官方资料；Cognia 当前 owning source。版本字符串与同名 tag 匹配不等同于对已安装二进制的供应链证明。

## 本轮改变了哪些判断

**飞书首期可行性验证应聚焦“应用机器人 + 事件拉取 + 持久转写/摘要”，不能把已有语音聊天直接接上会议。** 新证据进一步区分了 HTTP 拉取、事件订阅和语音媒体；并暴露了无人值守恢复、重复长连接和跨 Host 所有权的限制。

| 研究结论                                                                             | 证据等级                                  | 影响                                                                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `meeting-events` 是有界 GET 分页，NDJSON 也是一次调用的有限输出                      | 官方源码 + 本机静态 help                  | 需要 Host poller、持久 cursor、限流与背压；不是启动一个 NDJSON 命令就常驻听会               |
| 实时转写拉取与 `event consume` 的 7 个 VC EventKey 不同；这 7 个订阅均标记 user 身份 | 官方 tag catalog + 本机 event list/schema | bot 入会权限不能直接复用到用户事件订阅；无用户授权时保留 bot polling 路线                   |
| `send` 有可选 UUID，`join` 没有同等参数；active 查询又不是“枚举机器人所有会议”       | 官方 join/send/active 合同                | “远端成功、本地未保存 meeting.id”后不能无条件靠重试或 active 查询恢复                       |
| 同一应用的多个长连接是随机单点投递，不是广播                                         | 飞书官方文档；Cognia 已有长连接代码       | 另起 CLI 订阅可能与 IM connector 竞争，需先确定唯一 ingress/fan-out owner；真实影响仍待验证 |
| 现有 SyncLease 是 device-local                                                       | Cognia owning source                      | 可以复用本地事务 fence，不能把它当成多台独立桌面的全局排他锁                                |
| 无机器人本地转写有成熟产品实践，但依赖本人在场和系统音频能力                         | Granola 官方说明 + Apple API              | 可以服务本人参会辅助；不等价于 AI 替用户独立到场                                            |

以上是接口、架构与研究结论，不新增“真实会议事故”计数。第一轮 B1/B2 和 T1 的结果仍是 2026-11-17 的证据，本轮没有重新运行它们。

## 精确的飞书合同

以下 URL 均固定到官方 tag commit，避免把不断变化的 main 当作认证版本。

| 动作                      | 身份与最小声明                                                          | 已确认边界                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| join                      | bot；`vc:meeting.bot.join:write`                                        | `POST /open-apis/vc/v1/bots/join`。请求含 meeting number、password、call_id、action；无 UUID、TTL 或租约字段。call_id 用于邀请关联，不得自行解释为幂等键 [L1] |
| leave                     | bot；同一 join scope                                                    | `POST /open-apis/vc/v1/bots/leave`，请求使用 meeting_id。这是机器人离会，不是结束整场会议 [L2]                                                                |
| events                    | user 使用 `vc:meeting.meetingevent:read`；bot 的条件性推荐为 join scope | `GET /open-apis/vc/v1/bots/events`，分别按身份校验。不能从本地 scope metadata 推断服务端灰度/数据范围已开通 [L3, L4]                                          |
| active meeting            | user 或 bot；bot 需要目标用户 open_id                                   | `/bots/user_active_meeting` 的 bot 结果只包含目标用户与机器人共同在场的会；不是机器人全量在会清单 [L5]                                                        |
| meeting message           | user 或 bot；`vc:meeting.message:write`                                 | text/reaction 两种。可传 UUID，最长 128 bytes；合同未在该源码定义去重有效期，需实测。没有向会议注入语音的 CLI 模式 [L6]                                       |
| lifecycle / artifact push | 当前 7 个 VC EventKey 均为 user                                         | meeting started/joined/ended、note generated、recording started/transcript generated/ended；各自需要 scopes 和控制台事件配置 [L7]                             |

“没有媒体 CLI 模式”仅限定所检查版本和接口；不能推出飞书整个生态永远没有其他媒体集成方式。若目标包含 AI 开口发言，仍需独立寻找并验收 provider 的 send-audio 能力；本地 TTS 播放不能替代它。

### 分页、转写与内容完整性

官方实现默认单页 20，限制 20–100；`--page-all` 使用 100/page、最多 200 页。达到上限可以仍返回 `has_more=true`。这只是 CLI 处理上限，不是服务端总容量承诺；服务端也可能返回更少条目。[L3]

翻页循环在 `has_more=false` **或** cursor 为空时停止，并保留最后的 page_token。因此：非空 token 可以是下一次增量的恢复点，不能单独作为“本批仍有下一页”的依据；`has_more=true` 但无 token 则标记不完整，而不是循环猜测。此前 skill 中关于非空 token 的一般提示，应结合这一实际源码语义解释。[L3]

转写 item 的渲染明确读取 `speaker`、`text`、`start_time_ms`；同名 speaker 在 pretty 展示里会区分，但业务身份须保存 provider ID，而非展示名。源码仍保留原始 payload。该路径没有给出完整的转写 finality、修订版本、丢失补偿、cursor 寿命、服务端保留期或速率 SLA；这些仍是未知项，不能用“支持 transcript_received”替代可用性和准确性验收。[L3]

建议的业务合同属于本次设计推论：

- `MeetingRef` 保留 provider、账号/连接 ref、principal、租户边界、number 与 instanceId；ID 全程保持字符串。
- `MeetingEvent` 保存原始 eventId/type/time/payload 与接收时间；独立保存 item 级 speaker/source。未知字段保留，未知命令语义不执行。
- `TranscriptSegment` 保存 sourceEventId、speakerId、provider 时间、文本、可用的版本/最终态；未提供的字段保持 unknown，不编造 final=true。
- `captureStartedAt`、最后成功 cursor、contentGap、晚加入/早退出区间与 artifactReadyAt 分开，摘要显示覆盖区间。
- shared-document URL 只是线索。入会授权不自动授予 Docx/Drive 权限；按同一 share_id 关联原文，未获权限时明确摘要缺少共享文档内容。[L3]

### 订阅不是另一种 polling 参数

本机只执行了 `event list --domain vc --json` 和两项 `event schema --json`，没有执行 `consume`。结果与官方 tag 的 7 个 EventKey/身份声明一致。[L7]

`consume` 需要单独的进程与订阅生命周期：stderr ready marker、stdout 事件、取消/退出与订阅清理。官方 skill 还说明：无界 consumer 收到 stdin EOF 会正常退出；SIGKILL 可能跳过 VC unsubscribe；`--quiet` 会隐藏丢弃告警。不能把“进程 exit 0”统一视为“完整会议业务结束”。这些是官方使用约束，本轮没有启动 daemon 验证。[L8]

飞书官方还明确，同一应用多 client 只有随机一个接收消息，最多 50 个连接，处理超过 3 秒会重推。Cognia 默认已有 [native long-connection](../../lib/connectors/adapters/lark/transport-long-conn.ts#L48)。所以“原 connector + 同 App ID CLI event daemon”需专门验证分流和丢弃风险；不要把每个进程看到的事件当作全量。[L9]

首个 polling 实验不需要为了获取实时转写而新增事件 daemon。后续若接入 lifecycle/artifact push，应沿统一 ingress 持久化后再 fan-out，或通过明确独立的应用/订阅设计隔离；不能默认两个接收器同时完整工作。

独立复核进一步验证了当前缺口：[Rust 普通事件路径](../../crates/cognia-connectors/src/lark_ws.rs#L694) 在 emit 后发送 200 ACK，不等待 TS 持久化；[TS dispatcher](../../lib/connectors/adapters/lark/index.ts#L753) 对 parser 返回 null 的 VC envelope 只记录 warning 后返回。[离线探针](../evidence/2026-11-17-meeting-participation-gap-audit.routing-probes.mjs) 使用实际 parser 和 AST 提取的 dispatcher，四类 VC synthetic event 均未到达 normalized bus，支持的 IM positive control 正常通过。metadata 活动/tenant backfill 仍可能发生。该证据确认“尚无 VC body 路由”；不等于复现了真实双客户端丢事件，也没有在 wire 上执行 ACK。

## 无人值守时最难的恢复窗口

以下是从合同推出的待验证风险，不是本轮已发生的事故。

1. join 已在服务端生效，Host 在保存 meeting.id 前崩溃：join 没有通用幂等参数；如果目标用户不在会中，active 接口也不能保证发现机器人。必须验证其他 provider readback/participant lookup 路径，否则把状态保留为 `join-unknown`，不能宣称已安全重试。
2. 同一应用的机器人被多个本地用户或多个 Host 请求入会：远端实例基数、复用语义、谁有权退会均未证实。不能简单按本地 sessionId 去重，也不能让共享采集绕过每个消费者的 ACL。
3. revoke/断网发生在 leave 前：本地 abort 不会自动撤销服务器上的 participant。join 合同无 TTL 字段，不代表 provider 没有内部策略，但本设计没有证据可依赖。需要独立的 cleanup authority、管理员恢复或确定的 provider 退会机制；未确认前保持 `leave-unconfirmed`。
4. 机器人参加但没有 transcript_received：可能是平台配置、权限、功能可用性或暂时无内容；不能自动开启本地录音或切换用户身份“补齐”。

这些窗口应在定时自动参会、连续多会和后台常驻之前验证；否则只能提供受监督的试验能力。

## Cognia 可以复用什么，不能直接照搬什么

| 现有 owner                                                                                                                                                                          | 可复用                                                             | 限制与接入义务                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [AuthConnection metadata](../../packages/plugin-contract/src/types/plugin/plugin-auth.ts#L46) 与 [consumer API](../../packages/plugin-contract/src/lib/plugin/api/auth-api.ts#L111) | Host 保管凭据、opaque ref、revision、grant、principalKind          | `connections.get` 没有 principalKind filter；不能复制 Calendar 的 service/scopes 查询后假定拿到 bot。须显式选连接并验证 kind/ref，不匹配则拒绝                              |
| [Feishu auth provider](../../plugins/feishu-auth/src/oauth.ts#L114)                                                                                                                 | client-credentials 分支与 bot refresh；user OAuth 单独存在         | 支持认证方法不是会议 scopes/灰度已开通的证据，也不是授权可跨 user/bot 自动重试                                                                                              |
| [SyncLease](../../lib/external-services/sync-lease.ts#L17)、[DB transaction fence](../../lib/db/sync-leases.ts#L75)                                                                 | 本地 owner、token、renew、abort、cursor commit                     | DB 明确是 device-local。多台独立 Host 不能靠它保证全局唯一；先绑定一个执行 Host，迁移后远端核对                                                                             |
| [Integration events](../../lib/integrations/events.ts#L151)、[ingress drainer](../../lib/integrations/ingress-client.ts#L141)                                                       | event insert/dedup、projection 恢复、先 publish 后 ACK、deadletter | 需要 meeting normalizer 和声明事件类型；不把每个字幕片段都投影到 Inbox 或自动发起 Agent run                                                                                 |
| [Bot scheduler executor](../../lib/scheduler/executors/bot-executor.ts#L30) 与 delivery runner                                                                                      | 定时/poll delivery、重试、取消和单 delivery lease                  | delivery 结束不等于远端机器人离会；poll cursor 也不替代 meeting-session 的持续 ownership                                                                                    |
| [Lark CLI process bridge](../../lib/auth-providers/feishu/cli/process.ts#L37)                                                                                                       | 桌面受控 CLI 执行，适合受监督 feasibility spike                    | 非 Tauri 拒绝，不是可直接搬到 headless 的执行链；持续服务需要验证 Node/plugin Host 路径                                                                                     |
| [Live voice](../../lib/voice/live/capture.ts#L115) 与现有 ScreenCaptureKit                                                                                                          | microphone、音频编解码/播放及 screenshot 基础                      | microphone 不等于系统音频；现有 [native screen collector](../../crates/cognia-automation/native/macos/screen_capture.m#L125) 只接 Screen output。B1/B2 在音频启用前仍需修复 |

建议：受监督的桌面实验可先复用认证 CLI；如果首期要求桌面关闭后仍自动参会，正式路线应优先验证 host-owned meeting integration，经已有 auth/network broker 调官方 API，再接 Bot/Scheduler。两条路线共用纯 normalizer/业务合同，运行时保留一个 canonical adapter，不建第二套 token store。这是实施建议，尚未作技术选型承诺。

## 三种产品形态的实际取舍

| 形态                            | 解决什么                                                                 | 不解决什么                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 飞书官方机器人 + 转写拉取       | 可见应用身份、明确会议 instance、服务端文本事件，适合 AI 旁听整理        | 当前检查的 CLI 不提供 AI 语音回传；真实灰度、延迟、断点恢复待验                                           |
| 托管 meeting bot / Output Media | Recall 文档声明 Zoom/Meet/Teams/Webex 可输出媒体，可作为互动 AI 路线候选 | 所检查支持表没有飞书/腾讯；vendor 声明不保证目标会议放行、账号政策或同意。不是飞书灰度失败的自动兜底 [P1] |
| 本机 system audio + mic         | Granola 采用本人在场、本地开始采集的方式；可跨本人参加的平台整理         | 不会替缺席用户独立参会；bot-free 不等于本地推理、没有数据出站或不需告知 [P2–P3]                           |

Granola 的可借鉴点是把手动开始、通知/持续可见提示、私有笔记和显式分享结合起来；其官方同时说明使用云端转写/整理。Cognia 可借鉴控制面而不照搬云处理、保留或训练策略；“只留文本”也需要独立的文本保留/删除策略。[P2–P3]

Apple 提供 Core Audio process taps 采集一个或多个进程输出，也有 ScreenCaptureKit 音频路径。process tap 需要 `NSAudioCaptureUsageDescription` 和系统授权。研究只能证明有受支持的平台 API，不能证明 Cognia 现有 screenshot bridge 已具备系统音频或 Windows/mobile parity；应单独做原生生命周期、耳机切换、进程过滤和自身 TTS 回声排除实验。[P4–P5]

### 会上开口发言是另一个里程碑

Recall 的 Output Media 官方合同支持受控网页把音视频输出到会议；该模式不能只输出音频并关闭视频，且与短音频 Output Audio/automatic output 互斥。网页混音与包含 bot 自身声音的 raw mix 也要区分，以免反馈。适用平台和这些限制应进入 capability matrix，而不是统一一个 supportsVoice 布尔值。[P1]

声学 VAD 只解决“有人开始/停止说话”，不解决“是否应该回应”。Cognia 的候选控制面应区分 listen-only、被点名回应、人工批准发言和主动主持；初期默认旁听，prompt 之外仍需可执行的发言开关、停止优先级、速率和作用域限制。此处是产品设计建议，不是模型或 provider 已验证的安全保证。

### 采购成本需要按 active 时间核算

2026-11-18 官方公开 PAYG 价格为标准 bot `$0.50/hour`，内置转写另 `$0.15/hour`；这些是研究时点价格，不是报价或总拥有成本。计费文档说明 bot 的 active 时间包含等待室与未录制阶段；更大 variant、保留、模型、网络和运维另计。[P6–P7]

仅作算术示例：100 小时 active bot + 80 小时内置转写，基础费用为 `100×0.50 + 80×0.15 = $62`，不含额外项目。应同时记录有效内容分钟数、等待/空会分钟数及失败原因；不能只用日历时长预测成本。飞书官方接口的实际配额/成本本轮未找到足够证据，不假定为无限免费。

## 最有价值的下一轮实验

以下均未执行，需要选定可丢弃会议、账号和执行 Host 后，在既定授权范围内进行。前六项先解决会改变路线的未知，不能用更多 mock 测试代替。

| 实验                | 方法                                                                                  | 成功证据 / 失败后动作                                                                    |
| ------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| E1 租户能力与内容源 | bot join、等待/放行、读取带唯一短语的转写；记录实际 scopes、错误码与 trace ID         | 入会和有效内容分别证实；灰度不可用则保留 blocked，不换身份绕过                           |
| E2 无人值守恢复     | 本人不入会，注入 join 远端生效后本地未保存的窗口；验证可用 readback                   | 能找到并清理同一个远端实例；若无法核对则明确 join-unknown，暂不启用自动多会              |
| E3 转写语义         | 至少两人，含同名 speaker、中英混合、交叠、修正、静音、晚加入，逐条对照预先记录的短语  | 测 P50/P95 内容延迟、漏段/重复、speaker 与修订；阈值由产品确认，不拿厂商宣传准确率当证据 |
| E4 分页/恢复        | 断连、重复页、token 失效、has_more=true、空 token、撤权，验证原始落盘与 cursor commit | 有界重试、不跳页；可检测/展示缺口。速率先按服务配额设定                                  |
| E5 ingress 共存     | 相同 App ID 下 connector 与候选事件路径的受控测试，对照 IM、VC 和回调唯一标记         | 明确投递 owner 与 fan-out；不丢既有 IM/card 事件，不能只测 VC                            |
| E6 停止与权限撤销   | 网络中断/Host kill/重启/撤权前后停止，区分本地资源与远端 participant                  | 两类资源各有结束证明；未确认远端退出时保留 leave-unconfirmed 与恢复入口                  |
| E7 本人入会与音频   | 校验实际账号与 mic/camera；若探索本地转写，再验证系统音频 + mic 选择与自身回声排除    | 不能验证 prejoin 时仅 opened/guided；这不是 AI 无人值守能力                              |
| E8 交付             | 最小转写/摘要落盘，用户读回，跳转 speaker/time/source；单独批准分享                   | 不完整会议显式标记；关闭/撤权后不产生新的外发                                            |

容量方面只给出推导：N 场会、每 Δ 秒轮询一次、每次一页时，基础请求约为 `60N/Δ` 每分钟，未含 backfill/重试。它不是配额或实测容量。先测可用 quota、处理时间和背压，再决定 Δ；不要从“实时事件”字样推出低延迟或无限并发。

## 研究工件与 Sources

本机静态 catalog/schema 与官方源文件快照、SHA-256 在 `.cache/meeting-research-20261118/`；`contract-source-index.json` 记录 tag、commit、7 项 event identity/scopes 与源文件 hashes。只读公开 source 与静态本机元数据，不创建服务端订阅。Context7 本轮已可用，用于导航后回到官方 tag 核验；不沿用前一轮的 quota 失败作为当前状态。

- L1：[join 源码](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/shortcuts/vc/vc_meeting_join.go)。
- L2：[leave 源码](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/shortcuts/vc/vc_meeting_leave.go)。
- L3：[events、分页、转写与 payload](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/shortcuts/vc/vc_meeting_events.go)。
- L4：[query identity scopes](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/shortcuts/vc/helpers.go)。
- L5：[active meeting source](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/shortcuts/vc/vc_meeting_list_active.go)、[精确可见性合同](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/skills/lark-meeting/references/lark-vc-meeting-list-active.md)。
- L6：[meeting message 与 UUID](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/shortcuts/vc/vc_meeting_message_send.go)。
- L7：[7 个 VC event registrations](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/events/vc/register.go)。
- L8：[event consumer 进程与退出合同](https://github.com/larksuite/cli/blob/ac81f5056ab88f37d581d25916f3dab85abfca76/skills/lark-event/SKILL.md)。
- L9：[飞书官方长连接要求](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)。
- P1：[Recall Output Media 合同与限制](https://docs.recall.ai/docs/stream-media)。
- P2：[Granola 安全与处理模型](https://www.granola.ai/security)。
- P3：[Granola 通知、可见提示与管理员控制](https://www.granola.ai/blog/ai-notetaker-participant-privacy-consent)。
- P4：[Apple Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps.md)。
- P5：[Apple system audio usage description](https://developer.apple.com/documentation/bundleresources/information-property-list/nsaudiocaptureusagedescription.md)。
- P6：[Recall pricing](https://www.recall.ai/pricing)。
- P7：[Recall usage calculation](https://docs.recall.ai/docs/calculating-usage)。
