---
title: "QQ 官方机器人配置"
description: "配置 QQ 官方机器人，支持群聊／C2C 文件发送、二进制及分片上传、原生 Markdown、引用回复、按钮键盘与交互回调。"
---

# QQ 官方机器人配置指南

Cognia 使用 **QQ 开放平台**机器人的 **App ID** 和 **AppSecret**（界面称为 **Client Secret**）接入官方服务。个人 QQ 账号接入请参阅 [OneBot / NapCat 指南](./qq-via-onebot-faq)。

群聊／C2C 支持原生 Markdown 与可见引用回复。接收的引用、嵌套消息／聊天记录及 ARK 卡片会转换为会话内容；引用索引与被动发送授权分别保存。

群聊／C2C 文件发送支持公网 URL 及用户选择的本地附件原始字节。更新后的原生主机对 5,000,000 字节以内的附件直接上传二进制，更大的附件分片上传，原生来源上限为 200,000,000 字节，再按原有被动回复规则发送文件。

## 1. 准备 QQ 应用

1. 打开 [QQ 开放平台](https://q.qq.com)，创建机器人，在**开发设置**中记录 App ID 和 AppSecret。旧的静态 Token 已弃用。
2. 配置沙箱参与者，并确认应用获准使用的会话类型。测试正式环境前，完成平台要求的上线审核。
3. 如果应用要求 **IP 白名单**，填写连接器运行主机的公网出口 IP。公网回调隧道提供入站 HTTPS，不一定改变主机的出口 IP；切换网络或代理后应重新核对。
4. 在 QQ 控制台订阅需要的事件：

| 会话              | 事件                      | 前提                                       |
| ----------------- | ------------------------- | ------------------------------------------ |
| QQ 群聊提及机器人 | `GROUP_AT_MESSAGE_CREATE` | 应用已获群聊能力。                         |
| QQ 群聊全部消息   | `GROUP_MESSAGE_CREATE`    | 在 QQ 平台开启接收所有消息，并订阅该事件。 |
| QQ 单聊           | `C2C_MESSAGE_CREATE`      | 应用已获 C2C 能力。                        |
| 频道提及机器人    | `AT_MESSAGE_CREATE`       | 公域频道消息权限。                         |
| 私域频道全部消息  | `MESSAGE_CREATE`          | 私域机器人的 `GUILD_MESSAGES` 权限。       |
| 频道私信          | `DIRECT_MESSAGE_CREATE`   | 频道私信权限。                             |

平台投递权限与 Cognia 回复规则分别生效。收到普通群消息不代表自动触发 AI 回复；默认的逐条提及策略仍要求消息指向机器人。只有希望机器人响应每条消息时，才将相应会话设为始终回复。

## 2. 添加连接器

1. 打开**设置 → 平台连接 → 适配器**，点击**添加连接器**，选择 **QQ 官方机器人**。
2. 输入显示名称、App ID 和 Client Secret。
3. 保留新连接器默认的 **HTTPS Webhook**，保存配置。
4. 重新打开适配器，复制回调 URL，在 QQ 控制台填写该地址并配置事件订阅。运行主机需要可从公网访问的 HTTPS 入口；本地回环地址无法接收 QQ 回调。QQ 文档允许的回调端口为 **80、443、8080、8443**。
5. 完成 QQ 的回调验证。Cognia 在原生主机校验请求签名并回答验证挑战。

私域频道机器人获得权限后，可开启**接收全部频道消息**。网关模式会增加 `GUILD_MESSAGES` 订阅；Webhook 模式还需在控制台订阅 `MESSAGE_CREATE`。没有该权限的公域机器人应保持关闭。此开关不会开启 QQ 群聊全量投递；`GROUP_MESSAGE_CREATE` 需另行在 QQ 平台配置。

凭据存放在操作系统钥匙串，通过 `https://api.bot.qq.com/app/getAppAccessToken` 换取访问令牌。Cognia 缓存令牌，在接近过期时刷新，并使用 `Authorization: QQBot <access_token>` 调用 REST 接口。

Webhook 模式的**测试凭据**只验证令牌获取。适配器显示运行中或凭据测试成功，都不能证明回调可达、订阅正确或真实消息已投递。

### 网关兼容模式

仅在应用具有网关访问权限时选择 **Gateway WebSocket**。已有网关适配器保留原来的传输模式。该模式的凭据测试还会解析 `GET /gateway`，返回地址不代表已完成登录。

网关使用 HELLO / IDENTIFY / 心跳 / RESUME，并在断线后退避重连；这些步骤不适用于 Webhook 回调。当前 QQ 文档仍描述网关协议，而腾讯 BotGo 指引推荐 Webhook，具体可用性取决于应用。

## 3. 验证真实链路

1. 发送一条受控单聊消息，或在已授权的群聊／频道提及机器人，确认消息出现在 Cognia。
2. 确认 QQ 收到一条预期回复。逐条提及策略下，未提及机器人的普通群聊／频道消息可以入库而不触发回复。
3. 验证全量投递时，再发送一条未提及机器人的消息并确认到达；只测试提及消息不能证明全量权限。若全量消息的提及识别缺少已确认身份，应先运行适配器的身份探测，后续事件会使用更新结果，不能将其他成员的提及当成机器人身份。
4. 失败时查看**平台连接 → 审计日志**，同时检查控制台事件订阅、应用权限、回调地址可达性和出口 IP 白名单。
5. 验证原生引用时，回复一条接收的群聊／C2C 消息，再在 QQ 引用机器人的回复，确认 Cognia 显示父消息及预览。重启连接器后，使用新的被动上下文重复验证。引用需要本机曾接收的索引；选中旧消息不会延长发送窗口。
6. 分别发送一个小型二进制附件和一个大于 5,000,000 字节的本地文件，确认 QQ 收到的字节、文件名与原件一致，并在主机开启代理时重复验证。仅上传成功不代表消息已送达；Cognia 仍需最终发送接口返回明确的消息 ID。

QQ 的业务错误可能伴随 HTTP 成功状态。Cognia 检查 `err_code`，兼容旧 `code`，并保留 trace 标识辅助排查。待平台审核、去重拒绝或缺少明确消息 ID 的结果会要求人工核对，不会自动重发；这些任务不表示发送成功，手动重试前应先确认平台侧结果。

## 消息能力与限制

- **文本、媒体与文件**：四种场景支持被动文本回复；群聊／C2C 支持图片、视频、SILK 语音和文件（`file_type=4`），频道／频道私信仍仅支持公网 URL 图片。文件以原生媒体发送，不降级为文本链接。
- **二进制与分片上传**：群聊／C2C 支持 base64 data URL 和文件／图片片段的内联 `dataBase64`；共享输入框中选择的本地文件沿用原有的持久字节接入流程。最终序列化阶段拒绝任意路径字符串及 `file:` URL，因为连接器发送权限不代表文件系统授权。需要更新后的原生连接器主机，本地附件无需公网隧道。**5,000,000 字节以内**通过 JSON `file_data` base64 直传；更大的来源依次执行 `upload_prepare`、存储预签名 URL 的原始 PUT、`upload_part_finish` 和 `/files` 合并。上传器计算整文件 MD5／SHA1、精确前 10,002,432 字节的 MD5 及每片 MD5；首次 PUT 前校验完整分片计划，并通过共享节流保持低于文档规定的 10 QPS。
- **大小与失败处理**：原生上传器读取一个有界快照，上限为 **200,000,000 字节**；群聊／C2C 输入框可选择任意文件类型，保留原始字节，不做文档提取、图片缩放或视频采样；沿用共享输入框的**单文件 10 MiB、每条消息六个文件**上限，超过直接上传阈值仍会走分片上传。已知文件大小在上传前校验，真实字节数在主机侧再次校验。原生图片／语音超过 20,000,000 字节、视频超过 30,000,000 字节时，按 QQ 软限制改为文件上传。URL 来源仍由 QQ 下载，并受平台格式、配额和权限约束。分片顺序上传，总时限 300 秒；尚未实现跨重启持久续传。上传失败不会发送消息；耗时较长的上传可能用尽被动窗口，发送前会再次检查。
- **上传授权与次数**：适用的上传阶段始终使用 `srv_send_msg=false`；分片不消耗被动回复次数，最终媒体消息按每段计次。QQ API 凭据不会发送给预签名存储地址；存储请求仅允许公网 HTTPS、拒绝重定向，并走主机经过地址校验的代理链路。上传不会改为主动推送。
- **被动回复预算**：群聊每条消息 **5 分钟内最多回复 5 次**；C2C **60 分钟内最多回复 4 次**。多段发送共用预算。Cognia 保守地将 C2C 输入状态计入次数，并为最终答案预留一格。频道／频道私信保留 5 分钟窗口；上下文过期后拒绝发送，不会自动改为主动推送。
- **原生 Markdown**：群聊／C2C 的助手回复和显式 Markdown 片段使用 `msg_type=2` 与 `markdown.content`，无需申请模板。标题、强调、列表、链接和内联图片交由 QQ 的 Markdown 渲染器处理。纯文本消息仍按文本发送；混合普通文本与 Markdown 时，普通文本会转义，Markdown 原文保留。频道／频道私信的 Markdown 仍显式降级为文本，频道内邀权限尚未在此适配器启用。
- **Markdown 与媒体混排**：独立附件与原生 Markdown 按片段顺序分开发送，每一段均计入同一被动回复预算；超出预算会在任何上传或发送前拒绝。原生 Markdown 被平台拒绝时直接报告错误，不会静默改为文本重发。Markdown 中的内联图片链接由 QQ 自行处理，不额外拆分为附件消息。
- **原生引用回复**：群聊／C2C 的显式回复将接收消息的 `message_scene.ext.msg_idx`，或机器人发送结果的 `ext_info.ref_idx`，写入 `message_reference.message_id`。当前真实入站 `msg_id` 仍负责被动授权，引用其他消息不能绕过时限或次数。文本、Markdown、媒体分段均保留同一引用目标。按适配器和会话隔离的映射在重启后保留，多段发送的每个确认成功段也会保存；缓存有界，索引缺失、冲突或已清理时，显式原生引用会在发送前失败。没有已知索引的旧式 reply 片段保留已报告的文本降级；频道／频道私信行为不变。
- **结构化接收**：`message_scene.ext` 保留带填充的索引并移除 `auth_token`；`msg_elements` 支持有深度和数量上限的递归消息及聊天记录。原生引用保留只读预览，已知父消息可关联本地记录；未知父消息仅展示预览，不虚构跳转或机器人身份。ARK 卡片展示白名单内的标题、描述、来源／标签、地址、安全链接和预览；未知字段、含凭据或非公网 URL 会被忽略。卡片头像不会成为发送者头像。引用／聊天记录中的历史媒体及卡片预览只作展示上下文，不会成为新的模型附件；当前消息附件仍遵循原有媒体策略。
- **原生按钮**：群聊／C2C 的 A2UI `Button` 转为自定义 `keyboard.content.rows`。回调按钮使用 action type 1，HTTP(S) 链接按钮使用 type 0，Button 的可选 `qqCommand` 字符串使用 type 2，在输入框插入指令。行、列、卡片和文本保留可读正文；不支持的输入控件保留已报告的文本替代。频道场景继续使用文本替代，不支持消息编辑，也不会自动从已处理卡片上移除按钮。
- **交互回调**：在 QQ 管理端订阅 `INTERACTION_CREATE`；Gateway 默认增加 `INTERACTION`（`1 << 26`）。Cognia 将每次发送的独立 token 与已持久化、确认送达的按钮 receipt 校验，检查适配器、场景、会话、过期时间及事件提供的按钮／来源消息 ID。群回调必须提供 `group_member_openid`，C2C 使用 `user_openid`；平台未提供来源消息 ID 时不会自行构造。工作流、工具和技能审批保留原有 binding 类型、操作者限制与一次性消费规则。回调继续受会话允许／拒绝列表约束；显式点击无需额外 @ 机器人。
- **回调确认与回复**：原生主机的 Webhook 传输 ACK 与 `PUT /interactions/{id}` 是两层确认。Cognia 在路由准入时确认回调，不等待模型或工作流完成；ACK 不代表操作已经完成。同一次点击重投使用相同事件 ID，新的点击使用新 ID；查找 binding 使用独立的 action key。瞬时路由失败允许重试，不重复尝试 ACK。回复及审批确认保留该次点击捕获的 `event_id`，不会冒充 `msg_id`，也不会绕过被动回复时限、引用及多段总次数检查。
- **其他限制**：C2C 流式、主动／唤醒推送、无关事件触发发送、全局菜单／指令面板管理、可复用 Markdown 素材管理及通用 ARK 卡片发送仍未实现。这里只路由受 Cognia 管理的消息按钮回调；快捷菜单、反馈及授权事件不会成为模型消息。
- **撤回及分场景能力**：原生撤回接口受 QQ 权限与时限约束；输入状态仅限 C2C，表情反应仅限频道。

### 键盘边界与原生卡片

Cognia 最多使用五行、每行五个按钮。QQ 标签上限为十个字符；生成的 A2UI 按钮会缩短标签，可读正文仍保留完整文字。显式原生载荷的非法标签、重复 ID、不安全链接或不支持的字段在发送前拒绝。链接仅接受不带 URL 凭据的 HTTP(S)。指令的 `enter=true`、`anchor=1` 仅限 C2C，选图器还取决于手机 QQ 客户端能力。本适配器不开放已废弃的 `click_limit`、频道专用身份组权限、小程序跳转及二次确认 modal 字段。

显式原生卡片使用 `MessageSegment` 的 `type: "card"`、`card.kind: "qq-keyboard"`，`card.payload` 包含 `content` 或 `markdown: { content }`，以及 `keyboard`；普通正文与 Markdown 互斥。键盘接受模板 `id` 或自定义 `content.rows`，二者不能同时传入。显式自定义回调的 `action.data` 必须指向同一会话中现有、有效的 callback binding，发送时由 Cognia 替换为本次发送的独立 token。没有受管 receipt 的模板／外部回调会被拒绝，其他不透明卡片类型仍不支持。

按钮 receipt 在连接器重启后保留，最长有效期为 30 天，不能超过作者 binding 的更短期限；已消费的审批不能再次授权。延迟超过五分钟的回调事件会在本地拒绝。键盘消息单独占用一个有序消息段，与 Markdown、媒体混排可能超过共享的群聊五次／C2C 四次回复预算，此时在任何上传或发送前拒绝。

验收时分别在群聊和 C2C 发送按钮卡片，重复点击普通按钮、重试一次性审批，并确认只有获准用户能够批准；通过已配置的 HTTPS 回调再测一次，核对回复保持在同一会话，区分失败／拒绝提示与最终操作结果。这些步骤依赖应用的真实 QQ 权限和兼容客户端。

## 头像

频道和频道私信保留平台提供的 `author.avatar`；已有频道消息可通过绑定的服务器查询成员信息，频道会话可使用服务器图标。群聊／C2C 的 open ID 不是数字 QQ 号，不会用于拼接数字 QQ 头像地址。没有权威头像来源时，这些场景保留占位头像。ARK 卡片中的 avatar 属于消息内容，不代表发送者身份。

## 官方参考

参见[访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[Webhook 回调](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)、[群聊全量消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)、[消息规则](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)、[自定义 Markdown](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html)和 [BotGo 配置指引](https://github.com/tencent-connect/botgo)。能力说明于 **2026-10-28** 对照官方文档核验，真实授权范围以应用为准。

引用及结构化字段以官方[群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[单聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)和[单聊事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)为依据。

文件上传参见[群聊上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html)、[单聊上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html)、[预上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_prepare.post.html)及[分片完成](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_part_finish.post.html)。官方 [Node SDK 用法](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md)确认 `fileData` 使用 base64；其旧大小表与较新的上传页面不同，本实现以此处明确列出的适配器字节上限为准。

按钮协议依据当前的[群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[C2C 发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[交互事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html)和[交互确认](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html)文档，于 **2026-10-28** 校对。
