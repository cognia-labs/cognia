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

QQ 返回 `READY` 或有效 `RESUMED` 前，网关保持**启动中**；凭据验证成功和获取网关地址都不代表已经在线。原生消息监听在打开连接前注册；鉴权有超时限制，断线会立即改变健康状态。退出 Cognia 会断开后台服务。

QQ 提示“灵魂不在线”或“未连接服务”时，表示其后台服务没有在线；使用此集成时，Cognia 就是该服务。请检查适配器的**健康**状态和实际入站消息的**审计**记录。仅保存凭据不足以完成接入，该提示本身也不能确定是沙箱名单问题。参见[官方 Agent 接入 FAQ](https://bot.q.qq.com/wiki/agent-qqbot/)。

### 验证 AI 回复

在适配器的 **AI 绑定默认值**中选择可用的提供商和模型，或配置其继承的应用默认模型。QQ 凭据仅用于接入 QQ；选定的 AI 提供商还需要自己的可用账户或凭据。

发送一条私聊测试消息，分别确认入站审计、出站送达和 QQ 中预期的 AI 答复。模型账户解析失败时，欢迎卡片或帮助卡片仍可能正常送达。如果审计出现 `route_handler_failed`，请检查选定的 AI 账户和运行时诊断；仅重连 QQ 无法修复 AI 账户缺失。

### 欢迎消息排版与预览

欢迎和帮助消息复用通用 A2UI 构建器。QQ 群聊和 C2C 将支持的 Card/Text 内容映射为原生 Markdown，没有按钮的消息也走此路径；已配置的按钮仍使用原生键盘。标题、分区标签和段落来自语义节点，普通文本按字面转义。QQ 使用官方文档支持的标题层级和加粗分区标签。频道及频道私信、不支持的输入控件仍保留明确降级。

在会话中发送 `/help welcome` 可预览当前欢迎消息。它复用通用帮助入口和受治理队列，不调用模型，也不会重置或消耗首次欢迎的去重记录。配置了自定义帮助触发词时，在该触发词后追加 ` welcome`。`/help` 仍显示完整帮助。更新后不会自动向已有会话重复发送欢迎消息。

### 复杂场景验收

使用你控制的测试会话，先完成欢迎阶段，再统计答复数量，因为首次欢迎本身是一条独立消息。每个场景保留入站 ID、AI 运行次数、出站状态／尝试次数和客户端观察结果。故障注入在隔离测试中进行，不要强制终止共享服务或耗尽真实平台额度。

| 场景 | 可观察结果 |
| --- | --- |
| 欢迎预览 | 标题和段落正确排版，不直接显示标题标记；无模型调用，不写入新的首次欢迎记录。 |
| 并发首次消息 | 只产生一个欢迎任务，每个获准任务仍执行；欢迎入队失败不阻断任务，也不记录虚假的欢迎成功。 |
| 连续两条私聊 | 分别关联两条回复，同一会话按队列顺序处理，不重复、不漏消费。 |
| 上下文与引用追问 | 保留会话，引用预期的上一条消息，并回答新的请求。 |
| 长 Markdown 与混合媒体 | 保留顺序和正文，发送前拆开互斥的平台负载，并检查累计被动回复额度。 |
| 按钮与重复回调 | 只有确认送达的消息回执才能授权操作；同一交互只执行一次；重新发出的卡片仍可点击。 |
| 两个收件人交错 | 即使逻辑流键相同，各自的服务器消息 ID、索引、正文和回复额度也保持隔离。 |
| 流式取消／重连 | 取消后不追加迟到内容；已确认的流继续使用同一服务器 ID，并以 `input_state=10` 完成。 |
| 最终 ACK 丢失／多段部分送达 | 队列在运行器重启后仍保持 `delivery_unknown`，不会自动再次 POST；已确认部分或流的证据仍可查。 |
| 二进制上传、音频编解码与权限失败 | 准备失败不消耗消息名额，重试复用已编码字节，被拒绝的操作不能获得权限。 |

本地 QQ 专项入口是 `pnpm im:test:qq`；帮助组合、通用队列和 bus 另有相邻 Jest 测试。原生 HTTP 和协议故障替身通过，不代表腾讯平台或客户端验收通过。[本地真实测试](./local-live-testing)中的 QQ 观察器验证两轮文本合同，不证明流式完成或回执恢复。真实原生流、文件／语音播放及群聊授权需分别确认。

## 3. 验证真实链路

1. 发送一条受控单聊消息，或在已授权的群聊／频道提及机器人，确认消息出现在 Cognia。
2. 确认 QQ 收到一条预期回复。逐条提及策略下，未提及机器人的普通群聊／频道消息可以入库而不触发回复。
3. 验证全量投递时，再发送一条未提及机器人的消息并确认到达；只测试提及消息不能证明全量权限。若全量消息的提及识别缺少已确认身份，应先运行适配器的身份探测，后续事件会使用更新结果，不能将其他成员的提及当成机器人身份。
4. 失败时查看**平台连接 → 审计日志**，同时检查控制台事件订阅、应用权限、回调地址可达性和出口 IP 白名单。
5. 验证原生引用时，回复一条接收的群聊／C2C 消息，再在 QQ 引用机器人的回复，确认 Cognia 显示父消息及预览。重启连接器后，使用新的被动上下文重复验证。引用需要本机曾接收的索引；选中旧消息不会延长发送窗口。
6. 分别发送一个小型二进制附件和一个大于 5,000,000 字节的本地文件，确认 QQ 收到的字节、文件名与原件一致，并在主机开启代理时重复验证。仅上传成功不代表消息已送达；Cognia 仍需最终发送接口返回明确的消息 ID。

QQ 的业务错误可能伴随 HTTP 成功状态。Cognia 检查 `err_code`，兼容旧 `code`，并保留 trace 标识辅助排查。待平台审核、去重拒绝或缺少明确消息 ID 的结果会要求人工核对，不会自动重发；这些任务不表示发送成功，手动重试前应先确认平台侧结果。

频道发送返回有效的 `data.message_audit.audit_id` 时，会进入通用异步回执流程。runner 通过主机持有的发送回调先持久化 `pendingReceipt`，任务保守地停留在 `delivery_unknown`，界面显示“等待平台结果”。`MESSAGE_AUDIT_PASS/REJECT` 按适配器、会话及 receipt 精确结算原队列任务：通过必须有真实消息 ID，拒绝不要求消息 ID。早到回调会保留到关联完成，重复回调幂等，冲突证据要求人工核对，等待中的队首会阻挡同会话后续发送。投递等待器继续等待明确结果，插件与配对客户端状态投影均保留 pending 标记；通过后复用原有已投递消息账本、SLA 与审计。已被平台审核的拒绝结果不能重放旧意图，需要重新编写并授权一条新消息。

获得 QQ 的 `MESSAGE_AUDIT` 权限后再开启“接收消息审核结果”。网关只在开启时增加 intent，Webhook 还需在控制台订阅；两种方式共用解析及队列结算。目前只映射官方明确的频道审核契约，缺少 ID、群聊／C2C 不确定结果及多段部分送达仍需人工核对。共享证据最多 10,000 条，可回收已完成 receipt，保留未决证据，容量耗尽时明确失败；未确认发送意图不会仅因配额窗口过期而被删除。

## 消息能力与限制

- **文本、媒体与文件**：四种场景支持被动文本回复；群聊／C2C 支持图片、视频、语音和文件（`file_type=4`），频道／频道私信仍仅支持公网 URL 图片。文件以原生媒体发送，不降级为文本链接。
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
- **C2C 原生流式**：符合自动发送策略的回复通过 `stream_messages` 更新同一条 QQ 消息，使用完整 Markdown 快照（`input_mode=replace`）、递增索引、首个响应返回的 `stream_msg_id`，并以 `input_state=10` 收尾。片段按 500 ms 合并发送，整条流共用一个逻辑被动回复名额。主 AI 对话和已授权的按钮回调可流式回复；草稿、人工模式、无人值守定时摘要及经其他连接器回复的对话仅发送最终结果。每个快照均经过 PII 检查；数字分身使用固定前置披露。该次原生 C2C 流替代单独的进度卡片。
- **流式边界与恢复**：Cognia 参考官方 Node SDK 指引，保守采用 **5 分钟流式窗口**；普通 C2C 发送仍沿用上述 60 分钟规则。快照上限为 **48 KiB UTF-8**。QQ 的 `remain_msg_len` 仅保留为响应信息，不作为还能追加多少字的配额；返回 0 或较小数值，不会因此停止后续快照或另发普通消息。已送达前缀不可改写；改写、混合媒体、卡片或显式引用的最终结果会先关闭已知预览，再走普通发送路径完整投递，报告替代方式并另计被动回复次数。取消仅收尾已经确认的安全内容，迟到片段会被忽略。停止适配器会停止排队刷新并保留检查点；重启后，已确认的流可在窗口内继续收尾。发送中断、缺失明确 ID 或最终投递不确定时要求核对，不会自动重发。检查点最多 1,000 条。已解决的被动流检查点保留 24 小时；发送中及确认不明的证据不会据此删除。召回检查点与回执保留到该用户消息的 30 天召回期限，避免旧 key 在 24 小时清理后重新打开。容量耗尽时要求核对，不保证永久去重；普通回复流不会设置 `is_wakeup`。
- **C2C 原生召回流**：显式 `sendOptions.mode: "reengagement"` 复用同一流管理器，使用 `is_wakeup=true`，沿用真实用户消息、拒收、30 天期限及额度检查。纯文本／Markdown 队列召回即使没有预览也走原生流式接口。首片、续片和 `input_state=10` 最终片共用一个平台消息 ID 和一次逻辑召回额度，跨周期续片保留原配额，不消耗被动回复次数。节流及 token 获取后，在实际请求边界再次检查额度有效期和接收许可。去重、待审核或确认不明的结果要求核对。召回预览已被接收后，改写、引用或混合最终内容只允许关闭已知安全前缀并报告投递不完整，不会另发第二条召回。取消和最终收尾使用跨管理器的持久条件写入。
- **其他限制**：群聊流式、通用 ARK 发送及小程序跳转仍不可用。当前群聊／C2C 发送参数表没有明确 ARK 出站结构，与旧指引存在冲突。快捷菜单、反馈及授权事件不会自动成为模型消息。
- **撤回及分场景能力**：原生撤回接口受 QQ 权限与时限约束；输入状态仅限 C2C，表情反应仅限频道。

### 键盘边界与原生卡片

Cognia 最多使用五行、每行五个按钮。QQ 标签上限为十个字符；生成的 A2UI 按钮会缩短标签，可读正文仍保留完整文字。显式原生载荷的非法标签、重复 ID、不安全链接或不支持的字段在发送前拒绝。链接仅接受不带 URL 凭据的 HTTP(S)。指令的 `enter=true`、`anchor=1` 仅限 C2C，选图器还取决于手机 QQ 客户端能力。本适配器不开放已废弃的 `click_limit`、频道专用身份组权限和小程序跳转。共享 `Button.confirmation` 映射至 QQ 回调按钮的 `action.modal`，`exclusiveGroup` 映射至 `group_id`。确认内容最多 40 字符且不可含链接，按钮文字最多四字符；其他适配器必须显式声明对应策略能力，QQ 客户端也需支持。

显式原生卡片使用 `MessageSegment` 的 `type: "card"`、`card.kind: "qq-keyboard"`，`card.payload` 包含 `content` 或 `markdown: { content }`，以及 `keyboard`；普通正文与 Markdown 互斥。键盘接受模板 `id` 或自定义 `content.rows`，二者不能同时传入。显式自定义回调的 `action.data` 必须指向同一会话中现有、有效的 callback binding，发送时由 Cognia 替换为本次发送的独立 token。没有受管 receipt 的模板／外部回调会被拒绝，其他不透明卡片类型仍不支持。

按钮 receipt 在连接器重启后保留，最长有效期为 30 天，不能超过作者 binding 的更短期限；已消费的审批不能再次授权。延迟超过五分钟的回调事件会在本地拒绝。键盘消息单独占用一个有序消息段，与 Markdown、媒体混排可能超过共享的群聊五次／C2C 四次回复预算，此时在任何上传或发送前拒绝。

验收时分别在群聊和 C2C 发送按钮卡片，重复点击普通按钮、重试一次性审批，并确认只有获准用户能够批准；通过已配置的 HTTPS 回调再测一次，核对回复保持在同一会话，区分失败／拒绝提示与最终操作结果。这些步骤依赖应用的真实 QQ 权限和兼容客户端。

## 通用连接器入口

### 通用系统互动

适配器通过 `events.interaction`、`events.delivery-status` 声明能力。平台无关的 `NormalizedInboundEvent.interaction`、`deliveryStatus` 共用既有 bus、`ctx.connectors.onInbound`、审计及 `trigger.connector.system`，工作流编辑器与运行时读取同一事件类型目录。QQ 快捷菜单 type12 以 `systemKind: 'interaction'` 携带 `featureId`，仅在会话策略允许、事件和审计原子捕获成功后 ACK。type13 点赞／点踩及取消复用通用 reaction 流程；type14/15/16 提供清空会话、进入／退出故事及模型变更观察；type18/19/20 提供授权观察。没有明确授权／撤销结果的 scope 不会开启主动消息同意。这些类型化元数据不会执行任意命令、删除 Cognia 历史或切换模型；显式配置的工作流／插件仍通过原有权限与 PII 流程操作。仅按钮与菜单发送交互 ACK，其他控制事件不发送。系统工作流继续保留既有 best-effort 边界，receipt 证据与队列结算则持久化。

### 管理及语音

这些功能先定义通用连接器契约，再由适配器映射平台协议。插件通过 `ctx.connectors.listManagementOperations(adapterId)` 发现已实现能力；`queryManagement` 需要 `connectors:read`，`manage` 需要 `connectors:manage`。输入是有名称、经过校验的操作参数，不接受任意平台 URL 或请求头。不支持的操作会在请求网络前拒绝。助手入口是需显式启用的 `im.query_resource`、`im.manage_resource`；修改操作必须经过原有桌面审批或 IM 确认卡，展示连接器、操作及具体变更，只允许获准的人确认或取消一次，执行前重新读取原会话权限。

| 操作 | 通用输入与 QQ 行为 |
| --- | --- |
| `links.create` | `{ purpose: 'add-contact', state?: string }` 生成添加机器人的邀请链接，需要通用能力 `links.create`。QQ 将 `state` 映射为 `callback_data`，最多 32 个 Unicode 字符，不裁剪或截断，并在出站前执行 PII 校验。只接受文档给出的公网 HTTPS `qun.qq.com/qunpro/robot/qunshare` 链接，不暴露响应中的 token。生成复用原有 manage 权限／确认流程，不会发送或发布链接。 |
| `assets.upload/list/delete` | 上传公网 URL 或显式 base64 图片、分页查询或删除属于该适配器的图片 ID。PNG/JPEG/GIF/WebP，上限 10,000,000 字节；原生主机校验格式、MIME、哈希，执行 prepare → PUT → complete。素材引用按适配器隔离，清单跨重启保留；Markdown、卡片和流式均检查有效期，只在确认引用成功后续期。QQ 每个机器人最多 100 张，闲置 90 天过期，不持久化带签名的预览 URL。 |
| `menus.get/set` | C2C 全局菜单，使用通用 prompt/slash/link、子菜单和开关结构；发布替换整个菜单。QQ 最多十个一级菜单，每个子菜单最多五项，名称遵循平台中英文加权长度。 |
| `commands.list/get/create/update/delete/targets` | 查询必须提供 `scope`（`private`、`group`、`channel`、`direct`）；后续使用返回 ID 修改。面板项是指令名称／描述或 HTTPS 链接。指定 C2C／群聊目标通过独立 targets 操作增删，每次最多 20 个目标 ID。 |
| `members.list/get/remove`、`blacklist.list/update` | 使用规范的会话／成员 ID；移除可显式要求禁止再次入群，并返回黑名单部分失败。成员及 bot-state 接口需要 QQ 内邀应用权限，只有群管理员身份不足以调用。 |
| `moderation.get/set`、`joinRequests.list/decide` | 公开的群管理员接口不依赖内邀成员读取权限；成员禁言期限不超过 30 天，审批必须给出确切的群／成员／申请 ID。受保护成员身份由 QQ 强制校验。已自动批准的入群事件记为生命周期通知，不当作新的待审批申请。 |
| `joinPolicies.list/create/update/delete/allowlist/execute` | 策略使用群 OpenID、启用状态、有效期、关联群和账号字符串白名单。QQ 最多 20 条策略、每条 100 个群，每次最多调整 10,000 个白名单账号。execute 返回 `accepted` 仅表示异步任务受理，不表示入群审批已完成。 |

```ts
const operations = ctx.connectors.listManagementOperations(adapterId)
const panels = await ctx.connectors.queryManagement(adapterId, {
  operation: 'commands.list', input: { scope: 'group', limit: 20 },
})
const invitation = await ctx.connectors.manage(adapterId, {
  operation: 'links.create', input: { purpose: 'add-contact', state: 'campaign_123' },
})
// invitation.link.url is returned; sharing it is a separate authorized action.
```

用户通过链接添加机器人后，`ctx.connectors.onInbound` 与 `trigger.connector.system` 收到 `kind: 'system'`、`systemKind: 'lifecycle'` 事件。通用 `referral.state` 保留 QQ 的 `scene_param`，`referral.source` 是 QQ 场景数值的字符串；平台专属 `channelData.friendAdd` 保留数值场景和有界短链 code。生命周期审计也保留 referral。这些字段仅是未受信任的来源数据，不代表身份、主动消息同意或回复授权，不创建聊天消息，也不自动启动 AI。跨应用 `union_openid` 和无关平台字段不保留；异常归因字段会被忽略，不丢弃有效的生命周期事件。

管理调用按机器人串行执行，并保守地低于菜单／面板／群接口的频率限制。停止适配器会使旧任务失效；权限错误明确指出应用授权或群身份要求，能力声明不等于平台已授予权限。本轮没有新增独立管理设置页，通用插件 API 与需启用的工具是可用入口。

`im.send_voice` 使用已捕获的既有会话，复用现有 TTS 设置、provider 凭据、角色音色解析、发音字典、缓存及重试链路，生成一个编码音频文件，不在本机播放；新云端合成计入用量，缓存命中不重复计量。完整原文和经过发音替换后真正朗读的文本均通过连接器 PII 校验，本地 TTS 也不能绕过。语音片段保留真实 MIME 和 transcript，进入受治理的出站队列，不会自动开启语音回复或云端转写。

QQ 群聊接受 MP3／WAV／SILK；C2C 上传文档只列 SILK。`im.send_voice` 现在通过通用本地音频转换入口，把已有 TTS 的缓冲音频编码为真实 Tencent SILK，再投递到已捕获的 C2C 目标。即使提供方 MIME 已匹配，也先解码并校验真实字节。发送重试复用队列中的编码音频，不再次调用 TTS。接收侧在安全公网 `voice_wav_url` 存在时优先使用 WAV，同时保留原始语音 URL；`asr_refer_text` 提供有界平台转写，继续经过既有媒体／模型策略。缺少转写时保留附件，不自动调用云端 STT。

平台无关的 `transcodeAudio` 接收内存中的 WAV（PCM／浮点）、MP3、AAC／ADTS、M4A／MP4 AAC、原生 FLAC、Ogg Opus、Tencent SILK，或明确声明采样率／声道的 PCM16（8–48 kHz，单／双声道），在一次性本地 WASM Worker 中输出单声道 24 kHz WAV 或 Tencent SILK，不将音频交给转码服务。限制为输入／输出 20 MB、300 秒、累计浮点解码样本 64 MB、同时一个转换任务、30 秒超时；SILK 末尾不足 20 ms 的帧补静音。取消会停止合成／转换，并回滚尚未提交的队列写入；持久化交接完成后由既有发送队列管理。此导出流程不支持 Vorbis、WebM、ADPCM WAV 和只能本机播放的浏览器语音 provider；请选择支持缓冲音频的 provider，以及 MP3／AAC／WAV 等格式。运行环境需要 Worker／WebAssembly 及随应用打包的编解码资源。

AAC-LC／HE-AAC 均在本地解码，支持单／双声道 ADTS，以及自包含的 M4A（fast-start、尾部 movie metadata、分片媒体）。`audio/aac`、`audio/mp4` 及 M4A MIME 别名走同一入口，因此现有 AAC TTS 设置可直接用于 C2C，无须切换 provider 或音频设置。M4A 会保留 priming 和单段媒体 edit（可带前置静音）的时间线；加密文件、外部引用、多轨道／多 sample description、途中布局变化、多 raw-block ADTS、多段／变速 edit、样本时序不一致会明确拒绝。MP4 元数据／表／packet 在 demux 前受限，原始解码量和呈现时间线分别遵守既有资源上限。本轮不增加 AAC 编码，通用输出仍为 WAV／SILK。

### 显式发送意图与图片策略

增量显式发送沿用 `ctx.connectors.streamReply(adapterId, { conversationKey, conversationRef, streamKey, sendOptions: { mode: "reengagement" }, text })`，其中 `text` 是累计 Markdown 快照。主机解析已保存的会话目标，每帧经过同一即时发送授权及 PII 检查，stream key 按插件隔离；缺少授权不会使用 unplanned shadow 豁免。最终结果仍经 `enqueueSend`，使用相同的 `sendOptions.mode` 与 `metadata.streamKey`。公共调用方使用自己的原始 key，主机在两个入口施加同一命名空间。普通自动回复、草稿／待审批和无人值守捕获的行为不变。

`OutboundRequest.sendOptions.mode` 默认是 `reply`；`proactive` 和仅限 C2C 的 `reengagement` 必须显式指定，`im.broadcast.deliveryMode` 也提供这一通用入口。两种意图始终需要出站治理授权，即使普通回复处于兼容模式也不例外。过期回复不会自动升级。C2C 主动发送需要记录到用户开启事件；用户明确拒收也会阻止召回。群聊主动消息需要平台允许。召回要求捕获过真实用户消息，在 0–1、1–3、3–7、7–30 天四个区间内各使用一次。Cognia 保守限制每机器人每分钟 30 次、每收件人每分钟 20 次及每天 1,000 次，并在发送前持久化意图；确认不明时要求核对而不自动重发。多段消息逐条计次，本地限额不能保证平台必然接收。

好友添加、开启／关闭接收和群生命周期事件保留已验证的外层事件 ID 及平台时间戳。允许回复的事件使用独立的五分钟事件授权，不伪造消息 ID，也不自动启动 AI 对话。Gateway 增加 `GROUP_MEMBER`（`1 << 24`）接收入群／成员事件；Webhook 仍需在控制台订阅。

`sendOptions.imagePolicy: 'require-complete'` 在群聊／C2C 原生 Markdown（含按钮卡）写入 `markdown.force_verify_image_resource=true`；纯文本和不支持的场景会拒绝该要求。流式最终消息若要求此策略，会走普通图片校验路径。共享 mention 片段的 `audience: 'all'` 生成群全员提及标记；直接注入原始标记会被拒绝，需要群管理员身份，按北京时间每群每天最多一个实际含全员提及的分段。

## 头像

频道和频道私信保留平台提供的 `author.avatar`；已有频道消息可通过绑定的服务器查询成员信息，频道会话可使用服务器图标。群聊／C2C 的 open ID 不是数字 QQ 号，不会用于拼接数字 QQ 头像地址。没有权威头像来源时，这些场景保留占位头像。ARK 卡片中的 avatar 属于消息内容，不代表发送者身份。

## 官方参考

邀请链接及来源事件依据[生成分享链接](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_generate_url_link.post.html)和 [FRIEND_ADD](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/friend_add.html)，于 **2026-10-28** 核验。

系统互动依据 [INTERACTION_CREATE](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html)；审核关联依据[频道发送](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/send.html)及[频道审核事件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/message/event.html)。

参见[访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[Webhook 回调](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/webhook.html)、[群聊全量消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)、[消息规则](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)、[自定义 Markdown](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html)和 [BotGo 配置指引](https://github.com/tencent-connect/botgo)。能力说明于 **2026-10-28** 对照官方文档核验，真实授权范围以应用为准。

引用及结构化字段以官方[群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[单聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)和[单聊事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html)为依据。

文件上传参见[群聊上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html)、[单聊上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_files.post.html)、[预上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_id_upload_prepare.post.html)及[分片完成](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_id_upload_part_finish.post.html)。官方 [Node SDK 用法](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md)确认 `fileData` 使用 base64；其旧大小表与较新的上传页面不同，本实现以此处明确列出的适配器字节上限为准。

按钮协议依据当前的[群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)、[C2C 发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[交互事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html)和[交互确认](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/interactions_interaction_id.put.html)文档，于 **2026-10-28** 校对。

C2C 流式依据[原生流式接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html)及[官方 Node SDK 用法](https://github.com/tencent-connect/qqbot-nodejs/blob/main/USAGE.md)，核对日期为 **2026-10-28**。验收时请求一段较长的 C2C 回复，确认同一个 QQ 气泡持续增长并正常结束；再验证取消及连接器重启。分别测试按钮触发的回复与待审批草稿。本地回归不能证明应用已获得实际流式权限，也不能代替 QQ 客户端渲染验收。

补充参考：[素材管理](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html)、[全局菜单](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_menu.put.html)、[指令面板](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.post.html)、[成员禁言](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_restrict_chat_setting.post.html)及[入群策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy.get.html)。
