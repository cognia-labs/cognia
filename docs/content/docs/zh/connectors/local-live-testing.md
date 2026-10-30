---
title: "本地真实平台测试"
description: "用真实 IM 会话驱动已配置的 Cognia Bot，区分 QQ Official 与 OneBot 测试入口，模型端使用确定性 Fixture。"
---

# 本地真实平台测试

仓库中的其他连接器测试尚未验证完整的真实收发路径。mock E2E 使用模拟平台；`scripts/lark-live-smoke.mts` 调用真实飞书 API，但只覆盖出站，并以 Node 替代 Tauri。它们均未证明：真实平台推送消息后，消息经过真实传输层（飞书长连接和所有 Webhook 签名均在 Rust 侧）、准入门禁和 PII Gate，再由真实平台返回回复。

这套工具补的就是这个闭环。唯一被替换的是模型：用确定性 Fixture 顶替 Anthropic，断言因此稳定，跑多少次都不花钱。

```text
测试身份 → 真实 IM 平台 → 你已配置的 Cognia Bot → Connector 入站
→ 准入 + PII Gate → 确定性模型 Fixture → Connector 出站
→ 真实 IM 平台 → 测试身份观察到回复
```

## 需要准备什么

每个平台两个身份——负责发消息的**驱动方**，和你已经在 Cognia 里跑着的**目标 Bot**——外加一个只有这两者在场的专用会话。驱动方不复用 Cognia 自己的 Adapter 代码，而是直接调平台 API：否则同一个缺陷会在两侧同时出现，互相抵消成一次假绿。

目标 Bot 必须已经配置好、已启用，并在该会话里处于自动回复模式。这套工具**从不写入**你的数据库、Keyring 或 Connector 配置。

## 命令

```bash
pnpm im:test:target
```

终端 1。先起一个只监听回环的模型 Fixture，再以 `ANTHROPIC_BASE_URL` 指向它的方式启动 `pnpm tauri dev`。保持它运行。它会写出 `test-results/im-live/target.json`（权限 `0600`），Runner 靠这个文件找到 Fixture 并通过其控制面鉴权。

```bash
pnpm im:test:doctor -- --platform telegram
```

终端 2。只做预检，不发任何消息：校验驱动方身份确实不同于目标、凭据形态正确、会话可达、Fixture 在线。

```bash
pnpm im:test:live -- --platform telegram
```

P0 场景。`--platform all` 跑全部平台（任一平台没配齐时会直接拒绝启动；加 `--allow-unconfigured` 则跑已配置的，其余记为 `NOT_CONFIGURED`；没有实际 PASS 时仍以非零状态退出）。

另外两条命令不需要凭据，也不需要应用在跑：

```bash
pnpm im:test:unit
```

```bash
pnpm im:test:contract
```

`im:test:unit` 覆盖工具自身。飞书、Slack、Discord 和 Matrix 均有 CLI／HTTP／模型 fixture／报告组合用例，验证两轮对话、重复回复、绕过模型、Doctor 失败阻断和清理被拒。平台及响应目标仍是本地 stand-in；它们验证验收工具，不证明真实平台或已部署的 Cognia 目标通过。报告保存在 `.cache/test-results/im-observers/`。

`pnpm im:test:loopback` 是独立的生产适配器协议层，覆盖企业微信、钉钉、微信个人号和公众号。它让实际适配器／传输连接真实本地 HTTP／WebSocket 服务，通过现有 Host 命令／事件接口替代原生桥。准入 gate、native journal 和 checkpoint 存储为 fixture；Rust 签名校验、原生持久化、模型及真实平台／客户端验收不在此层证明范围内。用例验证实际请求和 ACK、会话／stream 隔离、取消、checkpoint 归属以及 claim／accept／ACK 顺序。报告位于 `.cache/test-results/im-loopback/`，明确 `realPlatform:false`，仅保留分类后的流量与清理计数，不保存正文或凭据。CI 已配置运行，无需平台密钥。

Slack 历史／线程和 Matrix 历史会遍历分页，完整成功后才提交观察去重。非法 continuation、后续分页失败以及超过 100 页的保护上限都会明确失败，不能将部分历史计为成功。Matrix 的空页仍可能有 continuation，不能按 origin timestamp 提前停止分页。

`pnpm im:test:native` 从当前源码构建独立 Rust 进程，让同一组企业 IM 适配器经过真实 Rust HTTP／WS 命令和事件。额外原生用例覆盖 Telegram／Slack／Discord／Lark／QQ 回调验签、OneBot 反向 WS，以及公众号加密签名／appId、精确 ACK、挂起／拒绝准入和两次 SIGKILL／重启后的加密队列恢复。复用用例中的 JS 准入 gate／个人号 checkpoint 仍是 fixture，专门的公众号用例使用真实原生存储。这条 stdio 测试通道不等于 Tauri GUI／IPC 或真实平台验收，也不证明所有原生协议或掉电持久性。

原生单元测试运行 `cargo test --locked -p cognia-connectors --lib`；其内存存储与上述独立原生进程的真实加密磁盘 profile 分开。两条命令均接入 Bot E2E CI。源码／二进制身份、run ID 和进程生命周期／错误回执保存在 `.cache/test-results/im-native/*.json`；隔离生成的密钥与 profile 目录会删除且不上传。故障注入用例应保留明确失败回执。进程信任 fixture 自有、固定响应头的本地 peer；初始 URL 检查不是任意重定向服务的网络沙箱。

`im:test:contract` 汇总连接器传输、契约、去重和限流套件，现已包含企业微信、钉钉、微信个人号和公众号。Slack Socket Mode 覆盖协议断开／WS 关闭后重连、新连接身份和 ACK、退避及连接期间取消，以及监听注册失败后的资源回收。测试驱动生产代码，在原生边界使用 mock；contract 全部通过仍不证明所有协议或原生传输场景。Rust 侧 `crates/cognia-connectors/src/sigverify/` 的签名校验，以及 `replay_guard.rs` 的防重放由 `cargo test` 覆盖，不包含在这两条脚本中。

原生入口也运行两个真实 Matrix OlmMachine 和加密 SQLite，通过本地 homeserver relay 交换签名设备／一次性密钥及加密房间密钥。用例验证跨设备 Megolm、合法编码的密文篡改、账户／房间隔离、错误数据库口令，以及 SIGKILL／重启前后设备公钥和解密能力保持一致。仅 homeserver 投递为替身，加密没有 mock。组合原生用例还实际运行 Matrix adapter 的 sync、加密回复、游标恢复、迟到密钥重试、拒绝准入及停止／重启竞态。生产 DB API 在这条测试路径使用 Node `fake-indexeddb`，不证明浏览器磁盘持久性。媒体用例验证真实 SDK 附件加密、密文完整性、解密字节、账户／大小隔离，以及 SIGKILL 后加密缓存恢复。

运行中的 adapter 提供 `keyBackup.create()` 和 `keyBackup.restore(recoveryKey, version?)`。创建前先在原生加密存储保存恢复密钥；会话上传只有收到服务器 ACK 才计入备份。独立 UUID claim、未知创建结果的协调和确定未发送时的撤销，避免重复创建或覆盖尚未解决的密钥。新设备恢复在导入前检查密钥、版本及真实推导的 session ID，限制为 500 个会话／8 MiB，版本元数据限制为 64 KiB。另有经过实际 Host 执行与 SQLite 回执的回归，验证恢复输入／输出不落通用回执。这些是内部接口，尚无设置界面。原生用例使用受控本地 homeserver relay；真实 homeserver／客户端、交叉签名和 Tauri GUI／IPC 仍须单独验收。

## P0 场景做了什么

1. 取一把每会话的锁，避免两个 Runner 互相污染。
2. 跑 `doctor`。失败就到此为止，一条消息都不会发出去。
3. 清空 Fixture 的请求日志。
4. **第一轮**——用不可预测的标记 `cognia-e2e:<platform>:<runId>:turn-1` @ 目标 Bot。
5. **并发**等待两件事：Fixture 捕获到该标记，以及 Bot 的回复出现在会话里。
6. **第二轮**——回复 Bot 自己那条消息。一般群聊用例分别验证 `selfMentioned` 和 `isReplyToSelf`；QQ Official 群聊的第二轮还必须 @，因此不能用它证明纯引用准入。QQ Official C2C 的第一轮为私聊文本。
7. 再观察 10 秒。同一轮出现第二条回答就是重复消费失败。
8. 在支持的平台删除测试消息（`IM_LIVE_KEEP=1` 可保留现场）。两个 QQ 观察入口均保留消息供手动清理。
9. 把脱敏证据写到 `test-results/im-live/<runId>/<platform>.json`——消息 ID、各阶段耗时、标记事实、Fixture 命中情况，**不含消息正文**。

## 配置

写进 `.env.im-live.local`（`.gitignore` 已覆盖），或直接用环境变量传入。每个字段都显式指定自己的变量名，因此任何平台都不可能拿到另一个平台的凭据。

```bash
# Telegram
IM_LIVE_TELEGRAM_DRIVER_BOT_TOKEN=
IM_LIVE_TELEGRAM_TARGET_CHAT_ID=
IM_LIVE_TELEGRAM_TARGET_BOT_USERNAME=
# IM_LIVE_TELEGRAM_API_BASE=https://api.telegram.org   # 例如 Test DC

# Slack —— 必须是用户 Token（xoxp-），不能是 Bot Token，原因见下。
IM_LIVE_SLACK_DRIVER_USER_TOKEN=
IM_LIVE_SLACK_TARGET_CHANNEL_ID=
IM_LIVE_SLACK_TARGET_BOT_USER_ID=

# Discord
IM_LIVE_DISCORD_DRIVER_BOT_TOKEN=
IM_LIVE_DISCORD_TARGET_CHANNEL_ID=
IM_LIVE_DISCORD_TARGET_BOT_USER_ID=

# 飞书 / Lark
IM_LIVE_LARK_DRIVER_APP_ID=
IM_LIVE_LARK_DRIVER_APP_SECRET=
IM_LIVE_LARK_TARGET_CHAT_ID=
IM_LIVE_LARK_TARGET_BOT_OPEN_ID=
IM_LIVE_LARK_TARGET_APP_ID=

# OneBot / NapCat (human-triggered, read-only HTTP observer)
IM_LIVE_ONEBOT_API_BASE=http://127.0.0.1:3000
IM_LIVE_ONEBOT_BEARER_TOKEN=
IM_LIVE_ONEBOT_TARGET_GROUP_ID=
IM_LIVE_ONEBOT_TARGET_BOT_UIN=
IM_LIVE_ONEBOT_DRIVER_USER_UIN=

# QQ Official 目标；独立的真人客户端观察凭据
IM_LIVE_QQ_OFFICIAL_OBSERVER_API_BASE=http://127.0.0.1:3002
IM_LIVE_QQ_OFFICIAL_OBSERVER_BEARER_TOKEN=
IM_LIVE_QQ_OFFICIAL_TARGET_CONVERSATION_ID=
IM_LIVE_QQ_OFFICIAL_TARGET_BOT_UIN=
IM_LIVE_QQ_OFFICIAL_DRIVER_USER_UIN=
# group（默认）或 c2c
# IM_LIVE_QQ_OFFICIAL_CONVERSATION_KIND=group

# Matrix
IM_LIVE_MATRIX_HOMESERVER=
IM_LIVE_MATRIX_DRIVER_ACCESS_TOKEN=
IM_LIVE_MATRIX_TARGET_ROOM_ID=
IM_LIVE_MATRIX_TARGET_USER_ID=

# 可选
# IM_LIVE_TURN_TIMEOUT_MS=120000
# IM_LIVE_DUPLICATE_WINDOW_MS=10000
# IM_LIVE_KEEP=1
```

这些值不会被打印或写入磁盘。Secret 会注册到脱敏器中；常见 Token 形态即使出现在平台错误消息中，也会被拦截。

## 会咬人的前置条件

下面这些失败看起来像产品坏了，其实不是。`doctor` 能看到的都会拦；剩下的列在这里，因为 Runner 是另一个进程，读不到你应用内的配置。

### 所有平台通用

- **同平台只保留一个启用中的 adapter**，或者确保所有同平台实例都已完成身份探测。当同平台存在第二个「身份未确认」的启用中 adapter 时，兄弟 Bot 反环门（`lib/connectors/bus.ts` step 9.6）会 **fail-closed**：驱动方消息只记入历史，AI 轮次根本不会跑。表现和传输层挂掉一模一样。
- **群里必须 @ 目标 Bot**（第一轮）或回复它（第二轮）。确认该会话的触发策略不是「只在别的 scope 生效」。
- **把当前 Provider 的自定义 Base URL 置空**，或指向 Fixture。金库里配置的 Base URL 会覆盖 `pnpm im:test:target` 注入的那个（`src-tauri/src/claude/host.rs` 的 `inject_provider_env`），这一轮就会走真模型。这种情况会被报成 `MODEL_NOT_INTERCEPTED`，绝不会算通过。

### Telegram

- 为驱动方开启 **Bot-to-Bot**。
- **关掉驱动方 Bot 的隐私模式**（@BotFather → `/setprivacy` → Disable，然后把它移出群再加回去）。隐私模式开着时，驱动方能发消息，但永远**看不到**目标的回复。`doctor` 会检查这一项。
- 驱动方 Token 不能同时被别的消费者占用——`getUpdates` 与已注册的 Webhook 互斥，第二个轮询者会抢走更新。`doctor` 会检查是否注册了 Webhook。

### Slack

- 驱动方**必须**是用户 OAuth Token。`lib/connectors/adapters/slack/parse.ts` 会无条件丢弃一切带 `bot_id` 的事件，所以第二个 Slack App 永远打不到目标。`doctor` 会直接拒绝 Bot Token。
- 驱动方用户必须已加入该频道。

### Discord

- 目标 Bot 需要 **`MESSAGE_CONTENT`** 特权 Intent，否则它收到的消息正文是空的。
- 驱动方 Bot 在该服务器需要 View Channel + Send Messages 权限。

### 飞书 / Lark

- 目标应用需要 **include-bot 类权限**，才能收到其它 Bot 的群消息。
- **权限、事件订阅、机器人能力的变更都需要发布新应用版本**才生效。改完配置后收不到事件，通常是版本没发布，而不是代码问题。
- 单应用最多 50 条长连接，且集群模式下是**随机投递给其中一条而非广播**——绝不要对同一个 App ID 并发跑两个 Runner。

### Matrix

- 使用**未加密房间**。本工具发送明文事件；`doctor` 会直接拒绝加密房间，而不是让这次运行白白超时。
- 驱动方账号必须已加入该房间。

## 运行失败之后

Runner 只能看到两件事：Prompt 有没有到达 Fixture，以及 Bot 往会话里发了什么。它读不到你应用内的 audit 行。所以它不猜单一原因，而是把这两个观测映射成一个结论 + 一份候选清单：

| Fixture 命中 | Bot 回复         | 结论                        | 含义                                                                                                                                                                                                                                |
| ------------ | ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 否           | 否               | `TIMEOUT`                   | 消息在 AI 轮次之前就被丢弃了。候选：传输未连接；兄弟 Bot 反环门 fail-closed；群里没 @ 到；chat 白/黑名单；静默时段；PII Gate（`reason: "pii_blocked"`）。                                                                           |
| **否**       | **是**           | **`MODEL_NOT_INTERCEPTED`** | 闭环是通的，但回答来自**真实模型**，并且真的计费了。原因是金库里的 Provider 覆盖了 Base URL、这一轮带了冻结执行规格（`sidecar/dispatch/subprocess-env.mjs` 会按白名单重建子进程环境），或者应用是用普通的 `pnpm tauri dev` 启动的。 |
| 是           | 否               | `FAIL`                      | 模型跑过了，出站失败。检查出站队列死信、Bot 的发言权限、以及熔断器。                                                                                                                                                                |
| 是           | 标记不对         | `FAIL`                      | 这条回复属于别的轮次——通常是有第二个 Runner，或有人在同一个会话里说话。                                                                                                                                                             |
| 是           | 两条带标记的回复 | `FAIL`                      | 入站事件被消费了两次，或者两个 Bot 在互相回答。                                                                                                                                                                                     |

每条候选都会连同实现该规则的文件一起打印，你可以直接去读真正的门禁，而不是只信这份清单。证据文件保留了平台消息 ID，失败之后仍然可以去会话里把消息找出来。

## 覆盖范围

真实场景设计覆盖各平台主传输上的文本闭环（Telegram 长轮询、Slack Socket Mode、Discord Gateway、飞书长连接、Matrix `/sync`）。实际平台验收必须配置专用账户并运行；本地工具测试不代表已经完成实网验证。

未覆盖：次要传输（Webhook 与 Discord Interaction HTTP 留在契约测试里）、媒体与附件、按钮 / 卡片 / Modal、安装与 OAuth 流程、Matrix E2EE、真实模型的回答质量、以及公网 Webhook 隧道。事件重放、断线与 Resume 无法从平台侧主动制造，因此留在 `pnpm im:test:contract`，而不是在这里假造。

## OneBot / NapCat live lane

先配置 Cognia 的正向或反向 WS。在 NapCat WebUI 额外添加 **HTTP 服务端** 供测试观察：绑定 `127.0.0.1`，选择空闲端口（示例 `3000` 可能已被 Next.js 占用），设置 `messagePostFormat=array` 和 `token`，保存时启用。`IM_LIVE_ONEBOT_API_BASE` 指向该 HTTP 端口，不是 WebUI 或 WS 端口。Bearer Token 使用这个 HTTP 连接项的 token。两个 QQ 账号均需加入测试群，先发一条测试消息确保历史非空。

fixture 目标启动后，先运行 `pnpm im:test:doctor -- --platform onebot`，再运行 `pnpm im:test:live -- --platform onebot`。Doctor 调用 `get_login_info` 和 NapCat 扩展 `get_group_msg_history`，任一失败都不能计为通过。测试打印 marker 后，由**另一个真人 QQ 账号**通过客户端 @ 选择器发送；第二轮引用第一轮机器人的回复并发送新 marker。每次真人操作限时 `IM_LIVE_TURN_TIMEOUT_MS`。观察器验证发送者和真实 `at`/`reply` 段，分页读取历史，按消息 ID 去重，复用 fixture 命中、重复窗口和报告检查。它不调用发送/删除 API，消息保留供人工核对清理。请使用安静的专用测试群。

## QQ Official 客户端观察入口

`qq-official` 是独立的被测目标，使用**真人账号**登录的 NapCat 作为只读 HTTP 观察器。它不要求在 Cognia 配置 OneBot，不读取官方 Bot 的 AppSecret，也不通过观察端发消息或删消息。观察端登录账号必须等于 `IM_LIVE_QQ_OFFICIAL_DRIVER_USER_UIN`，并且不同于目标 Bot 的**客户端 UIN**。AppID、OpenID 和昵称不能当成 UIN；正式验收前仍须核对专用 Host 上实际启用的适配器及身份映射。

```bash
pnpm im:test:unit
pnpm im:test:qq
pnpm im:test:target
# 配置 .env.im-live.local 后，在另一终端执行：
pnpm im:test:doctor -- --platform qq-official
pnpm im:test:live -- --platform qq-official
```

`group` 的会话 ID 填客户端 QQ 群号。两轮均通过真实 @ 选择器操作，第二轮还需引用首轮目标回复。报告记录 `group-quote-with-mention`，与 OneBot **纯引用、不含 @** 的操作分开。官方群纯引用需要另行确认全量消息投递授权，不能由群 @ 订阅推断。参见[官方群 @ 事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)与[全量群消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)。

`c2c` 的会话 ID 必须等于目标客户端 UIN。首轮发送私聊文本，第二轮引用目标回复。前提是当前观察端的 `get_friend_msg_history` **确实能读取该官方 Bot 私聊**；部分客户端／协议组合可能不支持。历史接口失败或返回异常即停止，不回退到群聊、不以人工填写“通过”代替。先用受控目标消息关联 Host 发送回执与客户端历史，只保存 ID、marker 和身份事实。该文本 smoke 不证明 C2C 流式完成或客户端渲染。

观察器校验登录身份、数值 ID、秒级时间戳、显式发送者／对端／会话字段一致性，以及回复不早于测试输入；通过 [NapCat 历史接口](https://napneko.github.io/develop/api/doc)分页读取。群同秒边界使用原生 `real_seq`；C2C 满页且最旧时间相同时，无法用发送者局部序号排序，会明确失败，请使用安静的专用会话。无法识别的 Markdown／卡片历史仍为未验证，不能拼成虚构文本。

报告记录 `acceptanceScope.kind=client-visible-text-smoke`，明确排除官方应用身份映射、流式完成、Host 控制和模糊回执恢复。smoke PASS 仅证明两轮可见文本与 fixture 的关联，不等于 QQ 全量验收完成。配置缺失以非零状态退出，真人消息保留后由操作者清理。扩展矩阵及 NOT_RUN 项见仓库内 `docs/reports/2026-10-28-bot-e2e-acceptance-plan.md`。

### 飞书身份、权限和 Doctor 边界

`IM_LIVE_LARK_TARGET_BOT_OPEN_ID`（`ou_…`）用于 @；`IM_LIVE_LARK_TARGET_APP_ID`（`cli_…`）用于识别历史中的应用发送者，两者不能混用。机器人信息接口的 `bot` 位于响应顶层。历史查询支持分页，话题回复使用 `container_id_type=thread` 且不传时间范围。

真人入站需要 `im.message.receive_v1`、私聊读取和群 @ 读取权限。另一个机器人的 @ 事件需要 `im:message.group_at_msg.include_bot:readonly`；**完整双轮自动测试第二轮不含 @**，还需 `im:message.group_msg.include_bot:read`。权限/订阅变更后发布版本。观察应用需历史读取权限（`im:message.history:readonly`、`im:message:readonly` 或 `im:message` 之一）及群历史权限 `im:message.group_msg`、机器人发消息权限、测试群访问权限。Doctor 只验证观察应用的 token、身份、群和历史；目标应用权限、可用范围、消息订阅、卡片回调 `card.action.trigger` 和真实投递仍需后台及客户端核验。

## 双轮文本之外的功能验收

自动 PASS 只覆盖 @、引用回复、fixture 命中及重复回复。以下逐项记录 PASS / FAIL / NOT_RUN，并保留消息 ID、run/job ID、时间和可见结果，不记录密钥或无关消息正文。

| 场景     | 操作                                            | 必需证据                                       |
| -------- | ----------------------------------------------- | ---------------------------------------------- |
| 多媒体   | 分别发送图片、文件、语音、视频，下载返回附件    | 字节真实可读或明确降级；发送者/会话正确        |
| 草稿编辑 | 草稿模式收到消息，在收件箱修改并批准，重复批准  | 平台只收到一次编辑后的内容；拒绝不发送         |
| 权限     | 授权与非授权用户操作，重复及过期审批            | 拒绝/过期/已消费动作无副作用；成功有回执       |
| 工作流   | 选择工作流并触发，在支持的控制界面批准/取消     | run 正确、状态流转完整、终态可见、无跨会话操作 |
| 恢复     | 断开重连 NapCat/飞书，待处理任务期间重启 Cognia | 恢复消费归属、任务可查、无重复模型执行/发送    |
| 隔离     | 两用户、两群，含 @ 与不含 @                     | 触发策略与上下文边界正确                       |

OneBot 卡片文本为只读，回复数字不等同原生点击。支持的审批请在 Cognia 关联会话/运行中处理。飞书卡片验收必须由真实授权客户端点击，同时检查拒绝和重复点击。

来源（核对日期 2026-10-01）：[飞书历史](https://open.feishu.cn/document/server-docs/im-v1/message/list)、[接收权限](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[NapCat 配置](https://doc.napneko.icu/config/basic)、[NapCat 历史实现](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts)。


### 交叉签名与浏览器磁盘集成

`pnpm im:test:native` 还覆盖 Matrix 显式交叉签名初始化／状态、实际签名校验、已签名但尚未信任的设备、旧身份保护、UIA／签名拒绝、取消，以及存储仍打开时 SIGKILL 后三组公钥的持久恢复。私有签名种子保留在原生加密存储。

运行中的 adapter 提供 `crossSigning.bootstrap(auth?)` 和 `crossSigning.status(userId?, deviceId?)`；初始化失败时可带有受限的公开 `authChallenge`，供调用方显式完成 UIA 重试。没有增加身份重置或设置界面。

`pnpm im:test:browser` 构建原生 fixture 和当前源码的浏览器集成包，以真实 Chromium 磁盘 profile 及生产 Dexie／加密／Matrix 模块验证：完整关闭再重开后的 pending 行与 sync 游标、双标签页去重、错误密钥／账户隔离、底层加密 IndexedDB 行、迟到密钥恢复，以及明确拒绝准入后再成功交付。监听失败用例另行验证资源清理。

homeserver 投递、准入策略、交互回调 bus、默认内置数据及未使用的默认 Host transport 是明确的 fixture 边界；这条路径不使用 fake-indexeddb。它不证明完整应用界面／静态导出、Tauri IPC、真实 homeserver／客户端互通或设备间交互验证。私有 profile 用后移除，不上传 CI。


浏览器入口还使用真实 Browser Vault 创建／密码解锁、密码轮换和账户绑定恢复，并保留生产 Argon2id 参数。完整重开浏览器后，由 Vault 恢复既有 Matrix 内容和加密凭据，不传入原始 DEK。错误密码／恢复密钥及合法编码的 wrap 篡改必须保留原加密存储；真实 WebCrypto 解密完成后暂缓返回，再锁定 Vault，确认不会释放迟到凭据或发出新原生请求。这是 Vault／存储 API 集成，不等于 AccountGate 界面或 account-store 启动验收。

原生 sync 另覆盖多个非空页面的加密补拉、后续页失败时零部分交付／零游标提交，以及取消后重启时实际 `since`／`to` 请求的核验。既有 CI 入口会自动选择这些用例。


AccountGate 现有独立的真实浏览器渲染入口，保留生产 singleton store、initializer、账户注册表、Vault、运行目标和数据库启动（含内置数据初始化）。用例通过真实控件完成创建、每份恢复密钥确认、错误认证、恢复重置、账户切换及浏览器重启。外围 workspace、导航和未调用的 execution broker 是明确的测试接缝；这不等同完整应用静态导出验收。

Matrix 的 `adapter.verification.pending(userId)` 可发现同步收到的设备验证请求；`interact` 提供显式请求／接受、SAS 比较确认、QR 数据生成／扫描确认、查询及取消。原生用例使用两个真实 SDK 加密实例和自有 loopback 交付，验证 MAC／QR 篡改拒绝、原事务重试与进程重启后的信任持久化。QR 使用真实协议数据，但本轮未增加产品操作界面，也不验收相机／光学解码、secret-sharing、真实 homeserver 或独立客户端互通。QR 临时秘密走 HostSemantic 私有回执策略，不作为恢复密钥保存。
