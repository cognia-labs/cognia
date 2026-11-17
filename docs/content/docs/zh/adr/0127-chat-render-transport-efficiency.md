---
title: "0127 — 聊天渲染与传输效率，以及消息自定义契约"
description: "所有聊天轨使用同一合并策略，批量发送 Companion 帧，并扩展消息展示契约。对每个未启用的聊天和传输功能记录审计后的处置结论。"
---

# ADR 0127 — 聊天渲染与传输效率，以及消息自定义契约

**Status:** Accepted **Date:** 2026-08-16 **Builds on:** ADR-0114（统一消息呈现）、ADR-0090（统一 agent 执行）、ADR-0027（移动同步）、ADR-0021（WebRTC 广域传输）**范围：** 主应用（浏览器 / Tauri / Capacitor）与公开分享页。**不含** CLI TUI（`cli/src/tui/` 是独立的 Ink 渲染器）。

## 背景

对聊天渲染路径、消息自定义面和四条传输轨（本地 sidecar、Companion WS/WebRTC、外部 agent、独立 CLI）的审计确认了以下事实：

- **渲染已成熟但各轨不对称。** sidecar 轨每帧最多提交一次 React 状态、流式增量经 250 ms 防抖落 Dexie（`hooks/chat/stream-coalescing.ts`）。**外部 agent 轨**两者皆无：`writeAssistant()` 每个 delta 全量 `replaceSessionMessages`，且只在 turn 结束时持久化，中途崩溃丢失部分内容。后台（非当前面板）会话每事件直写 Dexie、无节流。
- **上网前零合并。** sidecar 每 token 一行 JSON；Rust 每行一个 Tauri 事件；Companion `EventBus` 每事件一个带 seq 的帧；WS 与 WebRTC 每事件一帧、不压缩。慢订阅者遇 `broadcast::Lagged` 即被断开（`ws.rs`）或被要求重同步（`signaling/dispatch.rs`）。唯一带宽杠杆是全开/全关的 `streamPartialMessages`。
- **虚拟化只看条数。** `VIRTUALIZE_THRESHOLD = 40`；39 条、每条 200 KB 代码块的会话走普通文档流。
- **呈现契约（ADR-0114）已完整接通**，但渲染器的 9 项能力（`enableMath/Mermaid/Diff`、`showLineNumbers`、代码换行、`mathFontScale/Alignment/ShowCopyButton`、衬线正文）只以硬默认 prop 存在——无设置、无 UI。`messageDisplay` 本身缺席于 `SECTION_OWNED_KEYS` 与 `APPEARANCE_CONFIG_KEYS`，导致"重置本节"、变更审查、外观导出静默跳过它。
- **休眠清单** 共 20 项（见 *处置*）。每项现已接线、删除或明确记为 inert。

## 决策

### 1. 所有到达渲染器的轨共用一套合并策略

`SessionCoalescingRegistry`（rAF 节流的 store 提交 + 250 ms 防抖 `persistStreamingMessages`，turn 结束时同步提交 + 全量 `persistMessages` 封口）是**唯一**的流式写策略。外部 agent 轨原样采用；后台面板分支的直写 Dexie 也采用同一防抖。绕过注册表的轨视为 bug，由"合成 100 tok/s 流下每帧 ≤ 1 次 store 提交"的测试钉住。

### 2. Companion 帧批量化，只在发送环

批帧位于 `companion_api/ws.rs` 与 `companion_api/signaling/dispatch.rs` 的每订阅者发送环，**不**在 `EventBus`（进程内 A2A 消费者保持逐帧语义）。规则：

- 窗口 **50 ms** 固定。空闲订阅者的首帧立即发出（首 token 时延不变），其后帧在窗口内累积。（评审时定为 33 ms；实现时改为 50 ms——33 ms 在 100 tok/s 下约 31 次/秒发送（−69%），无法满足 §5 的 −80% 标准；50 ms 稳态 ≤ 20 次/秒。）
- 连续帧**跨 channel** 合并，保持总线顺序（`seq` 严格递增）。控制帧（`stream_ready`、`resync_required`、`ping`）、帧数或字节上限、窗口到期均触发 flush。（2026-11-16 修订：原规则只合并同一 channel 的连续帧，但 sidecar 每个 token 发两份，原始帧走 `claude://message`、规范信封走 `agent://message`，分别给不同的消费者，于是每次交替都会 flush，流式回复退化成一帧一发。各客户端本来就按每个内层帧自己的 channel 分发；信封上的 `channel` / `event` 取第一帧的值。）
- 回放突发同样批量化。
- 封套 — WS：`{ "type": "event_batch", "channel", "seq_from", "seq_to", "frames": [EventFrame…] }`（安全，因真实 channel 名总含 `://`）；RTC：`{ "kind": "event-batch", "event", "seq_from", "seq_to", "frames": [...] }`。
- 客户端（`lib/tauri/transport-companion.ts`、`lib/tauri/transport-rtc.ts`）把批展开进既有的每 channel 单调 seq 游标路径；单帧永远有效（兼容旧服务端）。
- `Lagged` 处理不变。
- `agent://message` 并行规范流**不在范围内**；其退役仍归 ADR-0090 Phase 9，此处仅记为已知传输成本。

### 3. 双阈值虚拟化

`MessageList` 在消息条数 ≥ 40 **或** 所有 part 文本总长 > 256 KB 时虚拟化。两者皆未达的会话保持零 ResizeObserver 的文档流路径。

### 4. 扩宽消息展示契约

`MessageDisplayPreferences.overrides` 新增：

```ts
markdown?: {
  math?: boolean; mermaid?: boolean; diff?: boolean;
  codeLineNumbers?: boolean; codeWrap?: boolean;
  mathFontScale?: 0.8 | 1 | 1.2; mathAlign?: "center" | "left"; mathCopy?: boolean;
};
bodyFont?: "sans" | "serif";
```

每个预设提供默认值。解析仍由 `resolveMessageDisplayOptions` 完成（ADR-0114 优先级：会话覆盖 → 全局 → 预设）。**两条**渲染分支（Streamdown 流式、react-markdown 定稿）与代码块渲染器读取解析值；块内工具栏开关仍是解析默认值之上的临时覆盖。控件出现在 `MessageDisplayControls`（桌面外观页、会话设置抽屉、移动端设置面板）。分享页只读全局。Shiki 主题保持硬编码（`lib/chat/code-theme.ts`）——两渲染器必须一致，引入选择器带来的耦合不值得。

`globals.css` 声明 `@theme --font-serif`；`bodyFont: "serif"` 应用到消息正文，`typographyExt.serifFamily` 首次有了消费者。

每面密度（`density.chat / .table / .sidebar`）落地：消息列表容器 `densitySurfaceProps("chat")`，会话列表 `("sidebar")`，`Table` 根 `("table")` 且单元格读 `--density-row-padding`。

### 5. 可度量验收

| 场景 | 标准 |
| --- | --- |
| 2000 条会话、40 图、12 mermaid | TTI < 800 ms；longTask 总计 < 1.5 s |
| 单条 200 KB 代码块 | 定稿后无 > 100 ms 主线程阻塞 |
| 100 tok/s 持续 60 s | 每帧 ≤ 1 次 store 提交、≤ 1 次 React 提交；无 > 50 ms longTask |
| Companion 100 tok/s | 过网帧数 − ≥ 80 %；首 token 时延 + ≤ 50 ms |

确定性计数断言（每帧提交数、批数、Dexie 写次数）在 Jest 中运行并作为 CI 门禁。耗时类指标放在 `@perf` 标记的 Playwright 套件（`tests/e2e/mobile/chat-render-perf.spec.ts`），保持可选。

### 6. 休眠清单处置

| 项 | 处置 |
| --- | --- |
| 朗读按钮在 `focused`/`balanced` 下不可达（只在 `actions: "all"` 分支渲染） | **已修复** — core/hover 分支同样渲染 |
| 桌面 `MessageList` 漏传 `directCharacter` | **已修复** |
| `MessageRenderer` memo 比较器漏 `onRewindFiles` | **已修复** |
| `messageDisplay` 及 6 个兄弟键不在 `SECTION_OWNED_KEYS` / `DEFAULTS` | **已修复** — 归属 Appearance/Conversation；完整性守卫覆盖 |
| `APPEARANCE_CONFIG_KEYS` 导出 `agentFlowMode` 却不含 `messageDisplay` | **已修复** |
| `DEFAULT_APPEARANCE_SLICE` 零消费者 | **已接线** 进 `getSettings()` 作为单一默认源 |
| `AgentFlowDisplayToggle` + `chat.header.flowDisplay.*` | **已删除** — 被 `MessageDisplayControls` 取代 |
| 测试专用导出（`parseShortcut`、`KeyboardShortcut`、`DetailsGroup`、`computeTimelineGeometry`） | **已删除 / 内部化** |
| `ChatHeaderPresetPill`（系统提示词预设切换） | **已接线** 到聊天头部中央 chip 区 |
| `density.chat/.table/.sidebar` 死旋钮 | **已接线**（§4） |
| `typographyExt.serifFamily` 死旋钮 | **已接线**（§4） |
| 隐藏的 markdown/数学/代码渲染 prop | **已升格**为设置（§4） |
| 插件工具结果渲染器注册表（生产 0 注册） | **已填充** — `web-tools`、`screenshot`、`clipboard-history` 注册卡片 |
| `command_ack`（发出、无人消费） | **已消费** — 重复命令 ⇒ 不重插用户消息、不重进流式态 |
| `session_closed`（AI-SDK 轨） | **更正，无改动** — 审计称其被转发后丢弃；实际上 `sidecar/agent-host.mjs` 的 `makeWrappedEmit` 在上线前拦截它（只用于退休多轮会话条目），`sidecar/claude-host.test.mjs` 钉住其永不转发。渲染端加 case 反而是死代码。 |
| `companion://device-paired`（有监听、无发射） | **已发射** — 设备注册处，仿 `device-seen` |
| `browser://console`、`browser://network`、`browser://snapshot`（声明未发） | **已发射** — overlay sentinel 通道 push-on-append（保留 drain 命令），由 DevTools 抽屉（console/network）与 agent-engine 快照缓存（按 generation）消费；Companion 转发默认**关** |
| `gateway://decide` 渲染端往返（默认 flag 关） | **inert，不变** — ADR-0090 Phase 9 |
| `agent://message` 并行规范流 | **不变** — ADR-0090 Phase 9 |
| `http` / `websocket` / `custom` / `sse` 外部 agent 协议（仅类型层） | **inert，不变** |
| `TauriTransport` 无 `Transport.readBinary` | **设计上 inert**（桌面读 Dexie blob） |

## 后果

- 所有到达渲染器的轨写入节奏一致；外部 agent 轨中途崩溃不再丢失部分内容。
- Companion 消费者收到更少、更大的帧；不识别 `event_batch` 的旧客户端须先于发出它的服务端升级——WS/RTC 契约版本随之提升。
- 新呈现选项必须先加入 `resolveMessageDisplayOptions` **和**两条渲染分支才对用户可见；测试强制 Streamdown/react-markdown 一致。
- 启用每面密度与衬线正文让此前 inert 的 UI 生效；曾设置过它们的用户升级后会看到变化。
- 浏览器 push 通道新增的 Rust → 渲染端事件量只在嵌入浏览器打开期间、且仅本地存在。

## 修订 — 2026-11-17：统一 Markdown 配置，流式时已定型的前缀保持不变

由聊天界面重构记录（`docs/plans/2026-11-16-chat-surface-overhaul.md`，D7–D9）。§2 中 2026-11-16 记录的跨通道帧批处理，就是同一重构的步骤 4.5。

### 两个引擎，一套配置（D7）

完成态渲染器（react-markdown，`MarkdownRenderer`）和流式渲染器（Streamdown）都保留，共用一套配置：

- `resolveChatMarkdownConfig`（`components/chat/markdown/chat-markdown-config.ts`）把解析后的显示设置和文本的可信度，转换成 remark 和 rehype 列表、URL 转换、LaTeX 预处理和设置对应的 class。
- `resolveChatStreamdownConfig` 从同一个对象派生 Streamdown 的插件集，带上应用自己的围栏渲染器（见 [ADR-0218](./0218-chat-reading-surface-links-blocks-and-charts) 的修订）。
- `MarkdownRenderer`、`StreamingTextPart`、推理、宠物聊天和技能编辑器的 AI 弹窗都读取它。

因此流式文本也有了标题 id、LaTeX 预处理、单美元符号行内公式（Streamdown 自带的 math 插件关闭了它）、`diff` 围栏和项目文件链接，与完成态一致。提及在 Markdown 内部渲染（`rehypeMarkdownMentions`）。标题 id 在同一消息分开渲染的各块之间保持唯一：一个纯 rehype 步骤通过选项接收前面各块已用掉的 id。Streamdown 按插件名和 JSON 选项缓存处理器，按块创建的闭包会共用第 0 块的处理器。较长的完成态回复保留懒加载分段，但带有链接定义或脚注定义的回复渲染为一棵树，以便引用能够解析。

一致性测试检查的是功能矩阵，而不只是共享语义：`tests/integration/fixtures/markdown-renderer-matrix.tsx` 用真实引擎，在完成态、分段和流式三条路径上渲染标题 id、公式、diff 和 mermaid 围栏、链接、引用、脚注和提及。

### 流式时已定型的前缀保持不变（D8、D9）

- **只对尾部做 remend。** Streamdown 在解析前会补全未闭合的标记。增量块解析器在只有尾部变化时复用尾部之前的所有块，所以它补上的闭合符不再迫使整体重新解析。已定型的块从不被重写。
- **大围栏限流。** 超过 4,000 个字符的未闭合围栏最多每 200 ms 前进一次，大代码块不会在每个增量上重新高亮。
- **墨迹动画只作用于最后一块。** 尾部之前的块只渲染一次，不带动画插件。超过 12,000 个字符或启用减少动态效果时关闭墨迹动画。

在 50 KB 回复上的测量（Node 基准，步骤 4.4）：流式 DOM 从 4.38 MB 降到 1.15 MB，单次增量 p95 从 7.8–14.1 ms 降到 6.0–8.8 ms；20 KB 围栏的 p95 从 5.8–9.5 ms 降到 1.9–2.0 ms。

"后果"中"测试强制 Streamdown/react-markdown 一致"一条，现在指上面的功能矩阵。新的 Markdown 功能应加到 `resolveChatMarkdownConfig` 和矩阵里，而不是只加到某一个引擎。
