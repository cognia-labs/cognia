# 会议平台接入研究：Zoom、Google Meet、Teams、腾讯会议

- 研究日期：2026-11-18（Asia/Shanghai）。下文所有外部链接均于该日访问。
- 状态：公开契约核验完成；账号 entitlement、平台审核、实际入会与媒体链路均未实测。
- 范围：承接 [2026-11-17 gap audit](../evidence/2026-11-17-meeting-participation-gap-audit.md)，只核验这四个平台。飞书与 Cognia 源码复用由主研究报告负责。
- 方法：读取平台官方文档、官方仓库与服务商自己的产品契约。未登录账号、安装工具、改凭据、加入会议、发送消息/音频或调用模型；未修改产品源码、运行产品测试。
- 单独成文原因：平台契约、生命周期与发布日期需要独立留档，不能把新增资料混写为上一轮已验证事实。

## 结论

**应将“本人打开并加入会议”“可见 AI 参会者”“平台内容流”“会后产物”做成不同能力。** Zoom 的推荐 AI 路线是 RTMS 内容流，明确没有额外参会者且只能接收；Google Meet Media API 已确定关闭；Teams raw-media bot 仍有技术契约，但官方不推荐用于 AI；腾讯会议新增的官方 `tmeet` CLI 值得接入管理/会后能力，却没有公开的 live join 或音频工具契约。依据见各平台章节；这些是文档结论，不是本账号能力证明。

针对 AI 优先的建议是：继续验证飞书可见机器人；将 Zoom RTMS（自建或托管）作为“实时内容接入”单独评估；Google Meet / Teams 的可见 AI 参会者先做购买服务与平台准入验证；腾讯会议先做 `tmeet` 管理/产物和本人入会，live AI Bot 另走商务/SDK 能力确认。此顺序是研究建议，未作为实施决定。

## 能力口径与矩阵

“接收文字”指可供程序消费的内容；客户端里看得见字幕、拿到 calendar invite 或查询到 participant 不等于具有该能力。“本人音频”不代表 Cognia 能注入 AI 音频。`未证实` 表示没有找到足够的公开契约，不表示平台绝无私有能力。

| 平台与路线                                 | 本人入会                                | 独立可见 AI 身份                                          | 接收内容                                               | 向会议发音频                           | 主要边界                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zoom invitation / Meeting SDK              | 支持客户端/嵌入体验                     | Meeting SDK 明确不支持 bots / AI notetakers               | 人类 SDK 有 raw-data 能力，不能据此批准 AI 用途        | 人类会议音频，不构成 AI 许可           | SDK JWT / 用户身份、会议准入。[Z1](https://developers.zoom.us/docs/meeting-sdk/)、[Z2](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065180)                                                                                                                                                                                                                                    |
| Zoom RTMS                                  | 另走客户端                              | 无额外 roster participant；有 app 披露                    | live audio / transcript / video / screen share         | 不支持，receive-only                   | Developer Pack、user-managed app、host/admin 控制与外部分发审核。[Z3](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)、[Z4](https://developers.zoom.us/docs/rtms/meetings/add-features/)                                                                                                                                                                                                 |
| Google Meet URI / REST / add-on            | `meetingUri` 打开本人入会               | REST/add-on 没有通用 Bot 参会契约                         | REST 产物与 lifecycle events；非通用 live media        | 未证实通用 API                         | REST 与 add-on 仍受支持；不能承接即将关闭的 Media API。[G1](https://developers.google.com/workspace/meet)、[G2](https://developers.google.com/workspace/meet/api/guides/overview)、[G3](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces)                                                                                                                                   |
| Google Meet Media API                      | 非新项目路线                            | 旧 preview 能力不应作新基线                               | 仅既有 DPP 过渡访问                                    | 本轮不据此承诺                         | 新申请关闭；2027-01-15 关端点。[G4](https://developers.google.com/workspace/meet/release-notes)                                                                                                                                                                                                                                                                                                      |
| Teams invitation / ACS Calling SDK interop | 支持；ACS 可 external 或 Teams identity | ACS 是 participant 客户端契约，不自动等于 headless AI Bot | 取决于该身份、SDK 与 meeting policies                  | 本人 Calling SDK 音频能力；AI 用途另核 | 不得将 ACS meeting join 推导成 Call Automation WebSocket/media/control 能力。[M1](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-workflow)、[M2](https://learn.microsoft.com/en-us/azure/communication-services/concepts/teams-interop)、[M3](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide) |
| Teams Graph application-hosted media bot   | 不使用本人 delegated join               | 有 app/bot participant 技术路线                           | raw media，允许收/发方向声明                           | 技术契约支持                           | 官方不推荐 AI；C#/.NET、Azure Windows Server、permissions、recording status。[M4](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)、[M5](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots)                                                     |
| Teams Graph transcripts                    | 不负责入会                              | 不要求建立媒体 Bot                                        | 会后 transcript / recording                            | 无                                     | tenant controls、组织权限或 meeting-specific RSC。[M6](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts)                                                                                                                                                                                                                                 |
| 腾讯会议邀请链接 / native SDK              | 支持；SDK 企业版                        | SDK join 不足以证明受支持的 AI Bot                        | 公共 SDK reference 未给出通用 raw-audio export 契约    | 常规客户端音频；AI injection 未证实    | SDK 需售后交付/企业版；公开 join/leave callback 可用于本人状态回执。[T1](https://meeting.tencent.com/support/topic/387/index.html)、[T2](https://cloud.tencent.com/document/product/1095/58217)、[T3](https://github.com/Tencent-Meeting/TencentMeetingSDK/blob/main/Docs/Common/TencentMeetingSDK%EF%BC%88TMSDK%EF%BC%89%E6%8E%A5%E5%8F%A3%E5%8F%82%E8%80%83%E6%96%87%E6%A1%A3.md)                  |
| 腾讯会议 `tmeet` CLI / MCP                 | 可返回加入链接，不负责实际 join         | 公开全量清单没有 join/leave                               | management / reports / recording transcripts / minutes | 无公开音频命令                         | OAuth account 或 MCP Token；账号可用性文档存在冲突。[T4](https://cloud.tencent.com/document/product/1095/133827)、[T5](https://cloud.tencent.com/document/product/1095/133826)                                                                                                                                                                                                                       |

## Zoom：AI 内容流已明确，交互语音仍缺独立路线

1. **先前政策结论成立。** Meeting SDK 首页直接规定只设计用于人类场景，不支持 bots / AI notetakers，AI note-taking 应用转向 RTMS。同一页保留 native raw-data 介绍不构成该用途政策的例外。[Z1](https://developers.zoom.us/docs/meeting-sdk/)
2. **RTMS 是 botless 且 receive-only。** 官方迁移 blueprint 明确没有 participant 加入；Zoom 向会议披露 app 正在访问内容。RTMS 不向会议发送 audio/video，也不负责 mute/end；side-panel Surface App 可承担状态、告知和控制。不能把 RTMS 产品文案写成“Cognia AI 已作为成员入会”。[Z3](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)
3. **新项目可开发不等于零门槛。** 需要 Developer Pack credits、General user-managed app、RTMS started/stopped subscriptions 和所需媒体 scopes；只需 transcript 时可只申请 `meeting:read:meeting_transcript`，scopes 不能 optional。外部用户安装前需要 App Review，包括 unlisted 分发；审批通过与当前账号 entitlement 本轮未验证。[Z4](https://developers.zoom.us/docs/rtms/meetings/add-features/)、[Z5](https://developers.zoom.us/docs/rtms/meetings/submit-app-review/)
4. **准入由多个角色控制。** admin 可控制账户是否允许 RTMS；host 控制内容分享许可。participant 可看到内容向 app 发送的披露和 App Activity Notifications；请求可能因 host 未加入、拒绝或禁用而失败。已授权 OAuth app 不能绕过会议中的 host/admin 控制。[Z6](https://developers.zoom.us/docs/rtms/meetings/ux-host-admin-tools-ctrls/)、[Z7](https://developers.zoom.us/docs/rtms/meetings/ux-participant/)
5. **可行部署推断：** 常驻后端处理 webhook、维护 WebSocket 与流终止，比每场运行完整会议客户端简单；这是基于迁移 blueprint 的设计推断，仍需实测 webhook 验签、stream 重连、host revoke、数据去重和关流。媒体文档可提供 per-participant / merged audio 与 timestamp，但不应把原始包到达当成完整逐字稿。[Z3](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)、[Z8](https://developers.zoom.us/docs/rtms/meetings/media/)
6. **官方已列出托管购买路线。** 同一 Zoom migration blueprint 明确将 Recall.ai 称为 RTMS Preferred Partner，提供 managed RTMS infrastructure，承接 WebSocket 与媒体处理并经 API 输出结构化数据；同时列出 Attendee、MeetStream 提供 RTMS support。因此“自建 RTMS”和“购买 managed RTMS”都是有 Zoom 官方文档依据的候选，不能把 Recall 的 Zoom 能力只描述成通用 participant Bot。托管仍受 RTMS 的 receive-only、账号授权及 host/admin 控制约束，实际套餐/entitlement 本轮未测。[Z3](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)

旧官方论坛 2025-04-18 曾预告未来 Audio Publishing；当前迁移 blueprint 仍明确 receive-only。路线按已发布 contract 取值，不能用 roadmap 预告声称 speech injection 已开放。[Z9](https://devforum.zoom.us/t/developer-preview-what-s-coming-we-want-your-feedback/131652)、[Z3](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)

本人入会可先使用 invitation link，官方流程包含浏览器打开与客户端启动确认；链接发起不能证明实际 admitted。只有必须内嵌体验时再评估 Meeting SDK 及签发服务。[Z2](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065180)、[Z1](https://developers.zoom.us/docs/meeting-sdk/)

## Google Meet：排除新 Media API，保留本人入口与会后流程

**关闭结论经两处官方页面交叉核验。** Overview 标注 DPP discontinued、不会 GA、关闭新申请；2026-10-28 release notes 确认 2027-01-15 永久停端点，只有既有参与者能在过渡期继续 approved credentials / staging。REST API 和 Add-ons SDK 不受此次关闭影响。不要把旧 media preview 教程当作新项目可获得能力。[G1](https://developers.google.com/workspace/meet)、[G4](https://developers.google.com/workspace/meet/release-notes)

REST 官方将 active conference metadata / participant sessions / lifecycle events 归入会中管理，将 recordings / Google Docs transcripts / granular speech entries / smart notes 归入会后产物；它没有替代 Media API 的通用双向实时媒体契约。Add-on 的作用是嵌入协作应用，不能据此推出 bot 音频权限。[G2](https://developers.google.com/workspace/meet/api/guides/overview)、[G1](https://developers.google.com/workspace/meet)

产物必须在会议结束前配置生成，transcript 不要求同时录制；Meet API entries 在会后 30 天删除，Drive 文件保留遵循 Drive/Vault 规则。下载 Drive recording/transcript 的 scopes 为 restricted；存储或传输 restricted scope 数据可能需要 security assessment。Meet REST 只支持 user authentication；domain-wide delegation 仍是模拟用户，不是给任意会议建立无用户媒体机器人。[G5](https://developers.google.com/workspace/meet/api/guides/artifacts)、[G6](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)

本人入口使用官方 `meetingUri`。`phoneAccess` / `gatewaySipAccess` 也可返回，但可能为空；它们不保证目标会议开通任何 gateway。SIP/H.323 经 Pexip 接入是官方存在的互通路线，需要组织配置及 gateway，而不是 Media API 替代品；AI endpoint 的授权、音频出口和身份显示未获本轮文档证明。[G3](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces)、[G7](https://knowledge.workspace.google.com/admin/meet-hardware/allow-3rd-party-devices-to-join-meet-video-meetings)

**必须保留 admission 文档冲突。** Google 当前 Host controls 帮助明确写第三方 bots 使用 Ask to join 会自动被拒；Recall 的 Meet guide（页面显示七个月前更新）却仍描述匿名 bot 默认人工放行。不能据此判断任一目标会议必能加入，也不能把 provider API 的 create 成功当成 Google admission 成功。应以目标租户当前 policy 和一次性会议验证结果为准。[G8](https://support.google.com/meet/answer/9302870?co=GENIE.Platform%3DDesktop&hl=en)、[R1](https://docs.recall.ai/docs/google-meet)

## Teams：技术上可有双向 Bot，不能忽略推荐用途和执行宿主

### Graph real-time media bot

先前“官方不推荐 AI”成立，但**不推荐不是技术禁止**。官方仍描述 app-hosted media bot 收发 frame-level voice/video、参加多方会议并声明 send/receive modalities；目前列举 intended scenarios 为 CVI、Compliance Recording、Contact Center。AI 替代建议指向 Copilot Studio 与 Graph transcripts。其 Copilot Studio 链接落到泛产品 overview，不足以证明 Cognia 自定义 Agent 已有可直接接入的 live audio meeting contract。[M4](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)、[M7](https://learn.microsoft.com/en-us/microsoft-copilot-studio/fundamentals-what-is-copilot-studio)

发布的部署契约是 C#/.NET、Azure Windows Server guest OS；C++ / Node.js 不支持实时媒体访问，不能当作 macOS Tauri 进程或纯 static-export 浏览器功能。媒体 call 固定在承载它的 VM；必须考虑 drain、断机与 leave。文档还标示 Developer Preview，近期媒体库更新要求应在实施时重新核定。[M5](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots)

Graph `POST /communications/calls` 支持 app join；app-hosted media 还需 `Calls.AccessMedia.All`，而非普通 delegated 本人 token。官方权限表含 `Calls.JoinGroupCalls.Chat` 的 RSC route 及组织级 join permissions；组织级 permissions 需要 admin consent。使用媒体内容进行录制、持久化或派生录制数据前，要先成功调用 `updateRecordingStatus`。这些准入与 recording obligation 要单独设计。[M8](https://learn.microsoft.com/en-us/graph/api/application-post-calls?view=graph-rest-1.0)、[M9](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/registering-calling-bot)

### ACS 是容易遗漏、也容易误读的官方路线

ACS Calling SDK 允许 external identity 或 Microsoft Entra/Teams identity 加入 Teams meeting；前者可无 Teams license，后者需要 Teams license。external display name 带 `(External)`。这是本人定制客户端的候选路线，身份不是自动取得的 Microsoft 365 Bot 身份。[M2](https://learn.microsoft.com/en-us/azure/communication-services/concepts/teams-interop)

ACS Call Automation 的 bidirectional WebSocket audio streaming 有官方 quickstart，但不能把它与 Calling SDK meeting interop 拼接为已支持的“任何 Teams meeting 双向 AI”。2026-09 retirement/breaking-change guide 特别区分：meeting interop 是 client-side participation，不自动建立 Call Automation meeting control、recording、server-side streaming、transcription 的支持；server-side streaming 和 client raw-audio API 也分属两种能力。[M10](https://learn.microsoft.com/en-us/azure/communication-services/how-tos/call-automation/audio-streaming-quickstart)、[M3](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide)

ACS standalone 服务在 2028-09-30 面临 retirement / breaking changes；meeting interop 等 Teams-aligned scenarios 按各自 documented capability 保留支持。新方案须先取得精确组合（identity、meeting/call 类型、SDK、方向、操作）的支持依据，不能因为接了 AI 服务就推断持续可用。[M3](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide)

### 会后与准入

Graph transcript/recording 是清晰的会后路线，可选组织级 permission 或特定 meeting 的 RSC；tenant 管理员还可独立禁用 transcript Graph access 或 speaker attribution。已有 scope 不保证返回 speaker-bearing transcript。[M6](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts)

外部 Bot 检测会根据 tenant policy 将已检测 Bot 强制放到 lobby，默认 RequireApprovalWhenDetected，需有权限的 organizer/presenter 显式放行；当前官方页面也承认漏检与误判。该页面使用 `Set-CsTeamsMeetingPolicy` 的正文与 `Set-CsTeamsEventsPolicy` 的示例存在不一致，实施前应查实际 cmdlet，不直接复制。[M11](https://learn.microsoft.com/en-us/microsoftteams/manage-external-bots)

本人入会优先使用会议原有 join URL；官方 deep link 文档明确只负责带出用户 join UI。需要嵌入本人会议客户端时，才评估 ACS Calling SDK；不要把 deep link、chat bot、Graph media bot、ACS call automation 混成一个 adapter flag。[M1](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/deep-link-workflow)

## 腾讯会议：新增官方 CLI；live AI 还必须独立取证

### `tmeet` 不是未知第三方包装

官方落地页提供 `@tencentcloud/tmeet`，腾讯云文档直接链接 `TencentCloud/tencentmeeting-cli`。官方 CLI 文档更新于 **2026-11-17 09:15:30**，列出全量 **19 个命令**：auth 3、meeting 7、record 6、report 2、troubleshooting 1；没有 `join`、`leave`、实时音频收发或 live transcript subscription。`record transcript-get` 读取录制转写，`report participants` 查询参会记录，都不能证明 AI 实际参会。[T4](https://cloud.tencent.com/document/product/1095/133827)、[T6](https://meeting.tencent.com/meeting-cli/index.html)、[T7](https://github.com/TencentCloud/tencentmeeting-cli)

CLI 基于 OAuth2，以所授权账号操作；当前单账号登录，换账号需 logout/login。官方写明只访问该账号数据，不具备跨账号/企业级数据访问权限；即便 business/enterprise 账号使用表写“已开放”，也不表示管理员获得全企业会议内容。CLI 文档要求自建 Agent 仍实现 create/update/cancel 的确认约束；Skill 文字约束不自动成为 Cognia Host 生产授权机制。[T4](https://cloud.tencent.com/document/product/1095/133827)

**建议的使用位置：** management/artifacts adapter，执行时固定 account binding；`joinUrl` 交给本人入会流程。若要让多个 Cognia 用户共享 headless executor，不应共享一个 `~/.tmeet` 登录状态；这是根据单账号契约作出的架构推断，隔离执行和凭据生命周期还需单独验证。

### MCP 仍是管理/产物工具，账号开放状态存在冲突

腾讯云 MCP 文档同样于 2026-11-17 更新，列出 **18 个工具**，覆盖 meeting management、members、recordings/minutes、辅助；无实际 live Bot 加入或媒体入口。其服务在云端，本地 Python 代理注入账号 Token，不能因协议名 MCP 推出不同会议能力。[T5](https://cloud.tencent.com/document/product/1095/133826)

同一云文档的“使用条件”表写全部版本已开放，安装章节又写“当前仅支持个人账号体验”，FAQ 还要求企业账号切为个人；帮助中心另一页仍将 business/enterprise 标为申请灰度。应记录为**官方发布信息冲突**，不能擅自选择较乐观的一句，也不能将其扩大成“腾讯企业账号整体不能接入”。需在选定 CLI/MCP route 后核定实际账号 entitlement。[T5](https://cloud.tencent.com/document/product/1095/133826)、[T8](https://meeting.tencent.com/support/articles/14/index.html)

### 不能忽略 native SDK、Bot 方案与 MRA，但各有不同边界

- **Native SDK：** 官方明确企业版专用、售后交付 SDK；公共 interface 包含 `joinMeeting`、`onJoinMeeting`、`leaveMeeting`、`onLeaveMeeting`，可形成比单纯打开 URL 更强的本人状态回执。查阅的统一 reference 描述客户端控制/状态，不足以证明任意 AI raw-audio export/injection 或 unattended bot policy；不能先承诺后再找接口。[T2](https://cloud.tencent.com/document/product/1095/58217)、[T3](https://github.com/Tencent-Meeting/TencentMeetingSDK/blob/main/Docs/Common/TencentMeetingSDK%EF%BC%88TMSDK%EF%BC%89%E6%8E%A5%E5%8F%A3%E5%8F%82%E8%80%83%E6%96%87%E6%A1%A3.md)
- **官方 Bot 方案：** 远程视频调度方案明确展示“腾讯会议 Bot / 推流机器人”，用于把监控画面带入会议。这足以推翻“腾讯不存在任何 Bot 能力”的绝对说法，却不能证明通用 AI 参会者可接收全会音频、说话、跨组织入会或已向普通开发者开放。需要腾讯提供具名产品、API/SDK、license、双向媒体与 AI 使用范围的书面 contract。[T9](https://meeting.tencent.com/open/solutions2026/video/index.html)
- **MRA：** 官方支持 SIP/H.323 设备入会，每个设备消耗一个企业并发许可端口，也可使用自有企业许可配对；这是设备互通路线，不是公开 AI Bot license。只有已有会议室/网关资产、且厂商确认允许自动化语音 endpoint 时才值得试验。[T10](https://meeting.tencent.com/support/topic/1698/)
- **本人入口：** 官方支持邀请链接验证身份后加入及会议号入会，并可选择 mic/camera。可优先落地 invitation/client launch；实际 join callback 需 SDK 或当前客户端观测，不能把 launcher 返回成功显示为“已入会”。[T1](https://meeting.tencent.com/support/topic/387/index.html)

## Build / buy 的落点

| 目标                             | 建议                                                          | 成立条件与未知项                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zoom 实时记录/分析：自建 RTMS    | 自建 adapter，单独显示 app 内容流                             | Developer Pack、scopes、host/admin 许可、外部审核；不满足 AI 开口发言。[Z3](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)、[Z5](https://developers.zoom.us/docs/rtms/meetings/submit-app-review/)                                                                                                                                        |
| Zoom 实时记录/分析：managed RTMS | 比较 Recall.ai、Attendee、MeetStream 的 RTMS 产品             | Zoom 官方明确列出：Recall 为 RTMS Preferred Partner，另两家提供 RTMS support。需要核定具体套餐、授权责任、数据处理与退出条款；托管不增加 AI 发音频能力。[Z3](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)                                                                                                                               |
| Zoom 可见 AI / 语音 participant  | 作为第三条路线独立核定，不能由 RTMS 能力推导                  | 普通 Bot 产品的音频输出承诺不能替代 Zoom AI 用途政策和该实现路线的有效 contract。[Z1](https://developers.zoom.us/docs/meeting-sdk/)、[R3](https://docs.recall.ai/docs/zoom-overview)                                                                                                                                                                   |
| Meet / Teams 可见 AI 参会者      | 先验证托管 Bot 服务，减少自建媒体客户端维护                   | Recall 自家文档列 Zoom/Meet/Teams 支持，可作为供应商契约依据；它没有腾讯会议条目。列表不证明平台许可、目标租户准入或服务质量。[R2](https://docs.recall.ai/docs/meeting-platforms)                                                                                                                                                                      |
| Teams 自建双向媒体               | 仅在原始媒体为硬需求且接受 Windows/Azure 运维时进入独立 spike | 技术 route 仍有文档；需解释为何选择官方不推荐用于 AI 的方案并取得精确场景支持证据。[M4](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)、[M5](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots) |
| 腾讯管理与会后                   | 优先 `tmeet` OAuth CLI 或对应正式 API                         | 正确账号、数据权限、录制/转写实际生成；CLI 缺 live join 不应阻塞这条独立路线。[T4](https://cloud.tencent.com/document/product/1095/133827)                                                                                                                                                                                                             |
| 腾讯实时双向 AI                  | 暂不承诺通用支持；向腾讯核定 SDK/Bot/MRA 的具体合同           | 官方 Bot 营销证据不能替代接入/API/媒体契约。[T2](https://cloud.tencent.com/document/product/1095/58217)、[T9](https://meeting.tencent.com/open/solutions2026/video/index.html)                                                                                                                                                                         |

购买时须区分具体产品：Recall 的 managed RTMS 是 Zoom 官方文档列出的购买候选；其通用 Zoom Bot 页面另行承诺凭 meeting URL 以 participant 方式入会。前者的官方依据不能自动为后者的 AI 用途、语音输出或 entitlement 背书，本轮未确认通用 Bot 的实际实现 route 或例外授权。应向供应商核实具体产品、平台许可与变更保障，不能仅凭支持表宣布所有 Zoom Bot 场景已获支持。[Z3](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)、[R3](https://docs.recall.ai/docs/zoom-overview)、[Z1](https://developers.zoom.us/docs/meeting-sdk/)

## 下一轮可执行 feasibility tests（本轮未执行）

以下是每条路线的验收实验，均应使用专用测试账号、一次性会议与已明确同意的参与者；先以固定测试音频/文字校验链路，无需调用模型。数值为建议验收目标，不是平台 SLA。

| ID  | 实验                                   | 最少需要的环境                                                                  | 必须保存的证据 / 失败判定                                                                                                                                                           |
| --- | -------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 四平台本人 invitation handoff          | macOS 当前客户端与浏览器；后续补 mobile                                         | 选定 account → 预入会 mic/camera 状态 → lobby → admitted → leave；launcher success 与 join success 分开。错误账号、无客户端、过期链接必须能回退，不记录含 password/token 的原始链接 |
| F2  | Zoom transcript-only RTMS              | Developer Pack + 私有 user-managed app + test meeting                           | consent 与 app disclosure 截图、started/stopped webhook、100 条带 speaker/time 的测试句、host deny/revoke、重连；撤权后不得继续接收。另测外部 host，不能沿用本账户授权推断          |
| F3  | Meet 会后闭环                          | 允许 transcription 的 Workspace test account 与 OAuth consent                   | 真实开启 transcription → fileGenerated → API entries/Drive 读取；确认同账号权限、无转写时返回、30-day entry retention 的处理设计。不能用空响应宣布成功                              |
| F4  | Meet/Teams 托管 Bot admission          | 一个已选供应商测试 workspace；两个测试租户                                      | anonymous / authenticated、内外部会议、lobby deny/remove、host absent、tenant Bot policy；保存 provider status 与平台 roster 双侧证据。任何一侧仅 created 不算入会                  |
| F5  | Teams Graph transcript + tenant policy | admin 可授权的测试租户；RSC test meeting                                        | 最小 scope、RSC 安装、实际转写、GraphAccessToTranscriptsDisabled、speaker-attribution disabled；证实 tenant controls 优先于 OAuth scope                                             |
| F6  | Teams 双向媒体或 ACS 组合核验          | 若采用 Graph：Azure Windows C# host；若采用 ACS：精确 SDK/identity/meeting 类型 | 先获得该组合官方支持依据；接收固定音频并回放一次明确同意的短提示、recording-status notification、leave/drain；不能以 ACS 通话 quickstart 替代 Teams meeting 验证                    |
| F7  | 腾讯 `tmeet` read-only entitlement     | 用户选定的 personal/business/enterprise 测试账号；显式允许安装后再装            | 实际版本/help、OAuth account binding、meeting get、本人有权录制 transcript 读取、logout/revoke；先不做 create/update/cancel。比较 CLI 与 MCP 账号支持，保留冲突与权限错误           |
| F8  | 腾讯 live Bot contract                 | 腾讯具名接入方案、文档、license 与可用 SDK                                      | 确认 inbound/outbound audio、visible identity、host consent、external tenant、允许 AI/无人值守、OS/headless/concurrency；任一缺项不得把 management CLI 宣称为替代品                 |

所有 live 路线还需验证：同一会议的幂等意图/重复 participant、授权撤销与会中踢出、进程崩溃后的 reconcile、最大驻留/空会自动离开、artifact 归属/删除，以及读取会议内容后再向模型发送的独立授权。以上是设计和验收建议，不是从供应商公开 API 自动获得的保证。

## 未决问题

1. 用户需要的 AI 第一阶段是否必须在 roster 可见、是否必须说话；若两者均为硬要求，Zoom RTMS 单独不能满足。
2. 四个平台目标账号、租户、deployment region、管理员配合与付费 entitlement 尚未选择/验证。
3. 腾讯 CLI 全版本开放、MCP 内部冲突与 Bot 商务能力的真实适用范围需具体账号/厂商确认。
4. Meet 对 third-party bots 的当前 admission 政策与供应商旧文档冲突；需在目标组织做受控实验。
5. Teams AI 不推荐说明、Graph raw-media preview、ACS 的媒体组合与长期支持要求，必须在生产选型前得到精确场景答案。
6. 本轮无真实 provider outcome；所有厂商页面均可能更新，不能将该研究日期之外的可用性作为已证事实。

## Sources

下表为关键一手来源索引；正文链接为可直接支持对应主张的页面。访问日期统一为 **2026-11-18（Asia/Shanghai）**。`published contract` 仅指公开页面的承诺/限制，`actual entitlement` 本轮均未知。正文中的 Recommendations / tests 为研究推断与建议。

| 来源                                                                                                                                                                                                                                                                                                                                                                                               | 所属方 / 证据用途                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [Zoom Meeting SDK](https://developers.zoom.us/docs/meeting-sdk/)；[bot → RTMS migration](https://developers.zoom.us/blueprints/migrate-bot-to-rtms/)                                                                                                                                                                                                                                               | Zoom；人类用途政策、botless / receive-only                    |
| [RTMS scopes/app](https://developers.zoom.us/docs/rtms/meetings/add-features/)；[review](https://developers.zoom.us/docs/rtms/meetings/submit-app-review/)；[admin](https://developers.zoom.us/docs/rtms/meetings/ux-host-admin-tools-ctrls/)；[participant experience](https://developers.zoom.us/docs/rtms/meetings/ux-participant/)                                                             | Zoom；付费、授权、分发、披露                                  |
| [Meet overview](https://developers.google.com/workspace/meet)；[release notes](https://developers.google.com/workspace/meet/release-notes)；[REST overview](https://developers.google.com/workspace/meet/api/guides/overview)                                                                                                                                                                      | Google；Media API shutdown、剩余产品边界                      |
| [Meet artifacts](https://developers.google.com/workspace/meet/api/guides/artifacts)；[auth](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize)；[Host controls](https://support.google.com/meet/answer/9302870?co=GENIE.Platform%3DDesktop&hl=en)                                                                                                                     | Google；产物、scopes、Bot admission                           |
| [Teams media](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts)；[host requirements](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots)；[create call](https://learn.microsoft.com/en-us/graph/api/application-post-calls?view=graph-rest-1.0) | Microsoft；双向技术契约、AI 推荐边界、宿主与权限              |
| [Teams transcripts](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts)；[external Bot controls](https://learn.microsoft.com/en-us/microsoftteams/manage-external-bots)                                                                                                                                                                  | Microsoft；会后权限与会议准入                                 |
| [ACS interop](https://learn.microsoft.com/en-us/azure/communication-services/concepts/teams-interop)；[ACS transition guide](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide)                                                                                                                                                             | Microsoft；本人客户端候选、server/client media 边界与长期支持 |
| [腾讯 CLI](https://cloud.tencent.com/document/product/1095/133827)；[MCP](https://cloud.tencent.com/document/product/1095/133826)；[CLI source](https://github.com/TencentCloud/tencentmeeting-cli)                                                                                                                                                                                                | 腾讯；新官方 CLI、全量能力、账号范围与冲突                    |
| [腾讯 SDK](https://cloud.tencent.com/document/product/1095/58217)；[SDK reference](https://github.com/Tencent-Meeting/TencentMeetingSDK/blob/main/Docs/Common/TencentMeetingSDK%EF%BC%88TMSDK%EF%BC%89%E6%8E%A5%E5%8F%A3%E5%8F%82%E8%80%83%E6%96%87%E6%A1%A3.md)；[Bot scenario](https://meeting.tencent.com/open/solutions2026/video/index.html)                                                  | 腾讯；不能从 CLI 缺 join 推断整个平台没有 Bot/SDK             |
| [Recall platforms](https://docs.recall.ai/docs/meeting-platforms)；[Meet](https://docs.recall.ai/docs/google-meet)；[Zoom](https://docs.recall.ai/docs/zoom-overview)                                                                                                                                                                                                                              | Recall 自己的供应商契约；不是 Google/Zoom 的支持或授权背书    |
