---
title: ADR-0114 — 统一聊天消息展示
description: "通过预设和会话覆盖控制消息展示，显示真实运行元数据，逐步展开技术细节，并由宿主管理消息框架。"
---

# ADR-0114 — 统一聊天消息展示

| 字段 | 值 |
| --- | --- |
| 状态 | 已接受 |
| 日期 | 2026-08-12 |
| 基于 | ADR-0057 — 聊天渲染完整性 |

## 背景

ADR-0057 补全了富消息部件，但展示策略仍分散在消息渲染器、独立的 Agent 流程设置、移动端操作以及 transcript 表面中。因此，助手身份、模型来源、耗时、用量、操作和技术部件的可见性并不一致。若渲染器从会话当前选择的模型推断历史消息，还会产生错误标注。

## 决策

### 单一的解析后展示契约

全局设置保存 `MessageDisplayPreferences`，`ChatSession` 可通过 `messageDisplayOverride` 覆盖。`resolveMessageDisplayOptions` 是唯一的优先级边界，并输出完整的渲染契约。预设包括 `focused`、`balanced` 和 `inspector`，默认使用 `balanced`。旧设置中的 `agentFlowMode` 继续作为读取回退，新写入统一进入消息展示偏好。

该偏好被归类为共享设置。普通分支、SDK fork、桌面端、Web 与 Capacitor 会保持一致展示，除非会话明确重置为继承。

### 宿主拥有框架，扩展拥有内容体

`MessageShell` 负责布局、语义化身份与时间、实时或完成状态、已有的运行详情以及底部操作位置。现有渲染器继续负责 Markdown、推理、工具、来源、文件、Artifact、A2UI、子智能体、诊断和插件内容体。插件保留消息部件、工具和扩展插槽，但不能替换完整的宿主消息框架。

`focused` 尽量减少技术细节，`balanced` 使用自动披露，`inspector` 展开已有追踪信息。错误、审批、诊断、未知部件、附件、Artifact 和安全相关状态在所有预设下都必须可达。未知原始部件在展示前会递归脱敏并限制大小。

### 真实且不可变的运行元数据

新的助手轮次可在 `metadata.run` 中持久化生成时实际解析出的 `providerId`、`modelId`、`startedAt`、`completedAt`、`durationMs` 和上报的 `finishReason`。内置、外部 Agent 与团队路径只记录生成时确实已知的值。Token、缓存与费用继续使用现有 `metadata.usage`。

旧消息或导入消息不会被重写，缺失字段直接省略。渲染器不会使用会话当前模型为历史消息兜底归因。

### 共享操作命令与稳定渲染

`resolveMessageActionCommands` 为桌面控件、键盘/溢出菜单和移动端长按面板提供同一套能力与安全模型。默认预设始终显示复制与更多。编辑和重试可用时，用户可直接访问这些操作。破坏性操作继续要求确认。

动效只使用 `motion/react`，并限制在结构化部件进入、状态、菜单和展开收起。全局或操作系统的减少动态效果会覆盖消息偏好。流式与完成态 Markdown 共享几何和策略，流式光标不占据布局宽度。解析后的展示配置变化时，虚拟 transcript 会使行高缓存失效，但不会把已经向上阅读的用户重新拉到底部。

## 持久化与兼容性

设置和会话字段都是可选 JSON 属性，运行数据保留在现有消息 metadata blob 中，因此不需要 Dexie schema 迁移或历史重写。会话分支复制可选覆盖；未设置覆盖的会话继续继承全局设置。

## 结果

- 无需分叉富部件渲染器即可获得可预测、可配置的信息密度。
- 历史来源保持真实，代价是旧消息缺失的信息会保持空白。
- 新展示选项必须先进入解析器及其测试，渲染器才能消费。
- 插件保持兼容，但不能接管完整消息框架。

## 修订 — 2026-11-17：回合折叠、统一渲染上下文、带位置的操作

由聊天界面重构记录（`docs/plans/2026-11-16-chat-surface-overhaul.md`，D10 和 D12）。

### 回合折叠

已完成的回合把过程折叠成一行"已工作 …"（`TurnProcessFold`，自 `4ad63e3941` 起已存在）。`foldTurnParts`（`lib/chat/turn-fold.ts`）决定哪些部分属于过程：结论之前的工具调用和推理。这一行只负责展开和收起：

- 收起时是一行弱化文字，让下面的结论读起来就是回答。
- 展开时以普通行显示回合的工具调用。折叠区里的工具组不再显示自己的标题，因为折叠区本身就是这个组。
- 主体只在展开时挂载；展开状态按消息记忆（`lib/chat/disclosure-memory`），虚拟列表把它滚出再滚回时仍保留读者的选择。

配对设备从 Host 读取的回合，会在细节加载之前，用回合的活动摘要画出同样的一行（[ADR-0257](./0257-a-remote-reader-folds-the-hosts-transcript-without-its-detail) §4）。打开它会获取该回合，回合中的消息自带各自的折叠。

### 统一渲染上下文

`MessageRenderContext`（`lib/chat/message-render-context.ts`，provider 在 `components/chat/message-render-context.tsx`）提供每条消息行所需的内容：角色、行操作、`canMutate(id, kind)`、项目根目录、解析后的显示设置、外壳的长按面板，以及该界面允许的命令。

- `MessageList`、`TranscriptMessageList`、`CompanionTranscriptMessages` 和手机的 `RemoteSessionDetail` 都提供它。行上传入的 prop 依然优先。
- 嵌套的 provider 会合并：内层的键优先，`canMutate` 和 `allowedCommands` 只会收窄。空值直接透传父级，所以什么都不收窄的作用域不会让任何行重新渲染。
- `MessageRenderer` 会重新提供它解析出的显示设置，所以消息内部嵌套的 Markdown 用的也是对话记录的设置。
- 面板组件由外壳提供，聊天界面从不导入移动端外壳。

### 带位置的操作

`resolveMessageActionCommands` 为每个命令指定位置（`bar` 或 `menu`），并按统一顺序返回，bar 的在前。桌面悬停工具栏、它的"…"菜单、常显工具栏和手机长按面板都从这一个列表绘制，各命令共用的逻辑放在 `useMessageCommands`。插件菜单项放进消息自己的"…"和面板中，排在分隔线之后。界面通过 `allowed` 传入它能执行的命令。读取 Host 对话记录的配对设备允许复制、分享、分享卡片、书签、朗读和选择文本；只有当 Host 以分支方式执行编辑、重发和重新生成时，才再加上这三项（ADR-0257 §6）。
