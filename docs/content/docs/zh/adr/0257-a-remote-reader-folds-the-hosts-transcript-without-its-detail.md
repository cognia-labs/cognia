---
title: "0257 — 远程读者折叠 Host 的对话记录，不取其细节"
description: "配对设备通过三个只读的对话记录调用读取 Host 保存的对话：能力握手、分页的折叠回合时间线，以及按需读取某个回合的细节。折叠回合携带可安全展示的预览，并从协议 2 起附带不超过 1 KiB 的活动摘要，手机因此不必获取工具输入、结果或推理，就能画出和桌面端相同的折叠行。修订通知会说明一次写入改动了哪些回合，每个回合有自己的版本，游标是只有 Host 自己读取的键集。进行中的回合只绘制一次，成员智能体的回复以实时帧到达，编辑和重新生成走 HostState，从不走对话记录调用。"
---

# ADR 0257 — 远程读者折叠 Host 的对话记录，不取其细节

**状态：** 已接受
**日期：** 2026-11-17

**相关：**
- [ADR-0114](./0114-chat-message-presentation)：远程回合复用的折叠行和消息操作。
- [ADR-0127](./0127-chat-render-transport-efficiency)：Companion 帧批处理，承载修订通知和实时帧。
- [ADR-0241](./0241-a-shared-run-streams-to-its-members) 和 [ADR-0253](./0253-a-members-standing-reaches-the-host-and-every-partition-effect-answers-to-it)：成员智能体回复使用的实时帧格式（`transcript://live`）。
- [ADR-0250](./0250-the-runtime-is-a-headless-kernel-the-desktop-embeds) §4：Host 的 brain 未连接时返回 `HOST_UNAVAILABLE`。

**计划：** `docs/plans/2026-11-16-chat-surface-overhaul.md`，决策 D12，步骤 3.7、4.6、6.2b 和 6.5。

## 背景

对话记录协议于 2026-08 随 `9ca43bb0d6` 上线，当时没有 ADR。它让配对的浏览器或手机显示 Host 保存的对话，而不把对话复制到设备上。聊天界面重构在四处改动了它：

- **新鲜度（步骤 4.6）。** 一个回合里流式写入的回复会让读者持有的所有回合失效，分页游标是行偏移，会话增长时会漂移。
- **分支和作者（步骤 3.7）。** 折叠回合显示的是最后存储的回复，而不是读者选中的那个；展开的消息丢失了作者信息。
- **折叠回合（步骤 6.5）。** 折叠回合只有文本预览。手机无从得知回合是否调用过工具，因此画不出桌面端的折叠行。
- **进行中的回合（步骤 3.7 和 6.5）。** 手机会把正在运行的回合画两遍：一遍来自自己的流，一遍来自时间线；成员智能体的回复也从来看不到实时内容。

本 ADR 记录这些改动之后的协议。契约是 `packages/plugin-contract/src/types/agent-config/transcript.ts`，Host 投影是 `lib/chat/transcript/projection.ts`。

## 决策

### 1. 三个读取调用，没有写入

| 调用 | 返回 |
| --- | --- |
| `transcript_capabilities` | 协议版本，以及分页、字节和媒体上限（`transcriptCapabilitiesV1`）。 |
| `session_timeline` | 一页时间线条目，默认从最新开始（默认 30 条，最多 100 条）。 |
| `session_turn_messages` | 某个已完成回合的完整消息，按 `turnKey` 和读者看到的 `revision`、`detailRevision` 读取（默认 100 条，每页最多 200 条、2 MiB）。 |

时间线条目有三种：

- **`completed-turn`**：用户消息和最终回复的 `TranscriptMessagePreview`（只有文本和媒体引用，不含工具输入、结果和推理），被折叠内容的计数（`collapsed`），分支组（`branchSummary`），以及从协议 2 起的活动摘要（§4）。
- **`active-turn`**：正在运行的回合的完整消息。
- **`system`**：系统消息预览。

协议是只读的，写入走 HostState（§6）。错误是 `TranscriptProtocolError` 代码；`TRANSCRIPT_STALE` 表示读者应重新读取最新一页。

### 2. 版本和游标

- `TRANSCRIPT_PROTOCOL_VERSION` 为 **2**。版本 2 只增加了活动摘要，读者在它存在时绘制，因此客户端接受回答 1 或 2 的 Host（`lib/sync/session-history.ts`）。
- 游标对客户端不透明，只由签发它的 Host 读取。游标格式有自己的版本（`TRANSCRIPT_CURSOR_VERSION`，为 1），所以不改游标的协议升级不会让任何游标失效。
- 向后翻页的时间线游标是键集，即本页最旧一行的 `(createdAt, id)`，而不是从最新一端数起的行数。回复在最新一端流式写入时，它依然有效。旧的 `position` 形式游标会被视为过期，读者从最新一页重新开始。

### 3. 按回合判断新鲜度

- 每次对话记录写入都会发布 `transcript://revision`，带上会话的新 `revision`；写入方能说出改动的回合时，还会带上 `turnKeys`（最多 16 个，`TRANSCRIPT_REVISION_TURN_KEYS_MAX`）。不带 key 的通知表示"任何回合都可能变了"，与 key 出现之前的行为一致。通知只带 id，从不带内容。
- 每个已完成回合有自己的 `detailRevision`，即对其各行 id 和持久的逐次写入戳（`syncRevision`）计算的 `transcriptTurnVersion`。会话其他地方的写入，或流入另一回合的回复，都不会改变它，所以读者在会话修订号变化时仍可保留已获取的回合细节。
- 收到点名了回合的通知时，控制器（`lib/chat/transcript/controller.ts`）只重新读取最新一页并拼接进去。较旧的条目保持原位和原游标，展开的回合只在其 `detailRevision` 变化时重新加载。拼接无法证明与整体重读等价的情况都会退回整体重读，不带 key 的通知也是如此。

### 4. 折叠回合携带其活动

`CompletedTurnTimelineItem.activity`（`TranscriptTurnActivity`）说明回合在得出回答的过程中做了什么：

| 字段 | 含义 |
| --- | --- |
| `toolCount`、`failedCount` | 工具调用次数，以及其中以错误结束的次数。 |
| `tools` | 最多 8 个工具（每个名称最多 64 个字符），带调用次数和失败次数，按首次使用的顺序。 |
| `reasoningCount` | 推理片段数。 |
| `sourceCount` | 回复携带的引用和来源文档数。 |
| `runDurationMs` | 已封存运行记录的时长（如有）。 |

- Host 统计读者所选线程（§5）上的回复，也就是预览所取的那些消息。它从列表末尾去掉工具，直到摘要的 JSON 小于 `TRANSCRIPT_ACTIVITY_BYTE_LIMIT`（1 KiB）。
- 回复既没调用工具也没有推理的回合没有 `activity`，因为这样的回合在本地也没有折叠行。
- 读者把摘要标记到它渲染的预览上（`lib/chat/transcript/turn-activity.ts`）。`MessageRenderer` 用本地回合同样的 `TurnProcessFold` 行绘制它，带上时长和一行细节（工具名、来源数）。打开这一行会通过 `MessageRenderContext` 中的 `expandTurn` 请求该回合的细节，而不是打开一个空的折叠区。

### 5. 选中的分支，以及作者

- Host 使用与聊天 store 相同的可见性规则（`lib/chat/branch-visibility.ts` 中的 `visibleThread`）和会话的 `activeBranchByGroup`，所以折叠回合预览的是读者选中的回复，其活动统计的也是那条回复。
- 完整消息（`TranscriptMessage`，见于进行中回合和回合细节）保留 `senderId`、`senderKind` 和共享会话的 `collaboration` 记录。读者把它们提升到消息 metadata 中，与本地 `rowToUIMessage` 的做法一致，所以团队成员或共享房间的作者在两端以同样的方式显示。

### 6. 进行中的回合和写入

- **只画一次。** 手机通过自己的会话流接收它发起的回合，同时也从时间线读到它。`withLiveTurn`（`lib/chat/transcript/live-turn-view.ts`）会去掉时间线中已由流尾部绘制的那份副本。
- **成员智能体的回复**运行在成员的 person brain 里，而不是 Host 的 sidecar 中，所以没有任何会话流承载它。brain 以 `transcript://live` 帧发送它（格式见 ADR-0241 和 ADR-0253）。手机订阅这些帧（`useTranscriptLiveTurn`），用实时回复替代时间线中较旧的副本，直到时间线读到帧的 `afterRevision` 之后。
- **写入是 HostState 操作。** 配对设备通过携带 `branch` 的 `message.enqueue`（`packages/plugin-contract/src/types/agent-config/host-state.ts` 中的 `HostStateMessageBranch`）来编辑、重发或重新生成。Host 把它变成桌面端的分支：被替换的回复或问题作为兄弟分支保留，回合的 prompt 从 Host 存储的行重建。只有 Host 广播 `host_state_message_branch` 且本设备控制该对话时，客户端才会提供这些操作；旧 Host 的封闭校验器会拒绝这个字段。

## 后果

- 手机以桌面端的折叠行和分支选择绘制 Host 对话，只在读者打开某个回合时才获取其细节。一个折叠回合的开销是它的预览加最多 1 KiB。
- 协议 2 之前构建的客户端会拒绝版本 2 Host 的握手（它只接受 1），因此必须与 Host 一起更新。这一代价在 D12 时已被接受：摘要需要一个读者能检测到的版本。
- 时间线条目上的新字段需要一个读者能检测到的协议版本，除非所有读者都已忽略它。`protocol/companion-response-schemas.json` 对 `TranscriptTimelineItem` 是开放的，所以 Rust 桥会原样传递新字段。
- 修改 `transcript.ts` 或 `host-state.ts` 会改变插件契约，从而使 authoring kit 的钉版（`lib/plugin/distribution/authoring-kit.json`）失效。kit `e0fbfe49147e` 已包含这两处改动。

## 本 ADR 不决定的事

- 手机上每个工具的耗时：活动摘要只有计数，没有时间。
- 桌面、手机和配对浏览器共用一个实时归约器：三种折叠的输入不同（SDK 事件、外部智能体事件、实时帧补丁），合并它们会改变协议（计划步骤 5）。
