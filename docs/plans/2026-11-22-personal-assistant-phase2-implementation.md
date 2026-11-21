# Cognia 个人助理模式二期功能分阶段实施计划（F7 · F8 · F10）

| 项目       | 内容                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 状态       | 已对齐契约的可实施计划，2026-11-22                                                                                              |
| 作者与深度 | Antigravity，个人数据源连接、跨渠道身份续办与统一个人责任视图，Heavy                                                            |
| 证据基线   | Cognia `dev` 分支（已完成 F1–F6、F9、F11–F23 及 B1–B3 缺陷与契约收敛）                                                          |
| 评审角色   | Connectors、Inbox、Integrations、Host Secrets、Radar / Goal 各模块维护人及 QA                                                   |
| 来源       | [个人助理模式差距审计](../evidence/2026-11-17-personal-assistant-mode-gap-audit.md) · ADR-0009 · ADR-0131 · ADR-0239 · ADR-0250 |

本计划承接 2026-11-17 个人助理模式审计中三项跨子系统产品能力缺口（**F7 个人数据源一体化配置**、**F8 跨渠道身份验证与任务续办**、**F10 面向个人责任的统一视图**）。前期所有可控性、跨账户隔离、投递可靠性缺陷（F1–F5、F11–F23）以及边界策略契约（F2 分层默认强制授权、F4 草稿模式仅操作员审批、B1–B3 Radar 记忆治理与在途合并、F6 本地高优待办采集与有建议才通知、F9 委托就绪检查条）均已落地并验收。本计划在不引入运行时 Next.js 服务端依赖（严守 `out/` 静态导出约束）的前提下，明确三项能力的架构边界、数据契约、安全红线、工作包拆分与验收标准。

---

## 契约决策基线

以下产品与安全契约已与用户确认冻结，作为各工作包的设计前提：

1. **F7（个人数据源接入路径）**：**复用插件 / MCP 生态 + 内置配置向导与本地凭据托管**。不自建云端 OAuth 中转服务；Lark 日历/任务直接串联现有内置鉴权与 `lark-cli` 能力检查，Gmail、Google Calendar、Outlook 通过「个人数据源向导」引导安装/绑定官方或社区 MCP/插件预设，凭据统一写入桌面端系统 Keyring（`host-secrets`），静态导出前端零密钥落盘。
2. **F8（跨渠道身份关联与任务续办）**：**显式验证绑定 + 私聊受控续办命令**。禁止仅凭显示名或未经验证的字段自动打通跨平台身份；必须通过一次性绑定码（One-time Bind Code）或操作员在 Inbox Contact Profile 中人工确认合并，跨渠道身份才共享 `ContactProfile`。验证通过的同一自然人在**私聊（DM）**中可通过 `/sessions all` 查看名下跨渠道近期会话与活跃委托，并通过 `/resume <id>` 将指定会话/任务切入当前渠道继续处理；群聊默认隔离个人跨渠道上下文，防止隐私外泄（遵循 `personal-sink` 红线）。
3. **F10（个人责任统一视图）**：**Inbox 内置「待我处理 / Needs Me」聚合视图**。不新增顶层一级导航路由，避免分散入口与膨胀导航栏；在现有 `/inbox` 顶部工作台切换器中内嵌「待我处理」聚合面板，实时汇总 5 类个人责任项：待审外发草稿（`connectorDrafts`）、待批 HITL 卡片（工具/计划/工作流启动审批）、超时未回 SLA 会话（`conversationOverrides`）、受阻或待验收的 Goal / Team 委托、以及未决 Radar 行动建议，支持一键内联处置或跳转原上下文。

---

## 阶段 1 · F10：Inbox「待我处理 / Needs Me」个人责任统一视图

优先交付 F10，打通现有本地真值表，消除操作员在 Inbox、Goals、Scheduler 和 Pet Console（Radar）之间来回巡检的认知负担。

### 1.1 聚合数据模型与只读 Hook

在 `lib/inbox/` 与 `hooks/inbox/` 下构建纯前端响应式聚合层（基于 `useLiveQuery`，零新增 Dexie 表，兼容静态导出与配对端镜像表）：

```ts
export type ResponsibilityKind =
  | "outbound_draft" // connectorDrafts (status === "pending" &&未过期)
  | "hitl_approval" // executionRunInterrupts / pending wf_approve & plan_approve bindings
  | "sla_overdue" // conversationOverrides (isOverdue(row, now))
  | "blocked_commitment" // chatGoals (paused | budget_limited | turn_limited | timed_out) & scheduledTasks (error/failed) & connectorInboundJobs (recovery_required)
  | "radar_suggestion" // radarReports 最新未决 pending suggestions

export interface PersonalResponsibilityItem {
  id: string
  kind: ResponsibilityKind
  priority: "urgent" | "high" | "normal"
  title: string
  subtitle?: string
  dueAt?: number
  createdAt: number
  sourceRef:
    | { kind: "conversation"; conversationKey: string; sessionId?: string }
    | { kind: "goal"; goalId: string; sessionId: string }
    | { kind: "task"; taskId: string }
    | { kind: "radar"; reportId: string; suggestionId: string }
}
```

- **排序契约**：按 `priority`（超时 SLA 与待批 HITL 为 `urgent`；待审草稿与受阻任务为 `high`；未决 Radar 建议为 `normal`）→ `dueAt` 升序 → `createdAt` 降序稳定排列。
- **跨模块边界（ADR-0250 G3/G4）**：仅通过已公开的 `lib/db/*` 数据读取层与 `hooks/connectors/*` 公开 API 读取，不在 `inbox` 与 `radar` / `goal` 之间制造循环依赖；计数徽标导出为 `usePersonalResponsibilityCount()` 供 Inbox 顶栏使用。

### 1.2 交互与内联动作

- **视图切换**：在 Inbox 主栏头部提供 `会话 (Conversations)` / `待我处理 (Needs Me)` 切换标签及未处理总数角标，支持按上述 5 类责任筛选。
- **原位处置（Inline Actions）**：
  - `outbound_draft`：直接调用 `approveDraft` / `rejectDraft`（走 `inbox-writes` 路由，自动兼容配对薄客户端转发到常驻 Host）或展开会话上下文。
  - `hitl_approval`：展示风险原因、目标收件人或计划摘要，提供「批准 / 拒绝」按钮，直接复用 `resolveApproval` 与工作流审批回调通道。
  - `sla_overdue`：一键打开对应会话并定位输入框，或执行「标记已解决 / 调整 SLA」。
  - `blocked_commitment`：对 `recovery_required` 入站任务提供「继续 / 重试 / 忽略」；对暂停/超限 Goal 或失败定时任务跳转对应详情并附带重试入口。
  - `radar_suggestion`：内联复用 `decideRadarSuggestion(reportId, suggestionId, "accepted" | "dismissed")`。

### 1.3 触点与测试要求

- **主要触点**：
  - `hooks/inbox/use-personal-responsibilities.ts`（+ `.test.ts`）
  - `components/inbox/needs-me/needs-me-panel.tsx`（+ `.test.tsx`）
  - `components/inbox/inbox-workspace.tsx`（接入标签切换与角标）
  - `i18n/messages/{en,zh-CN}/inbox.json`
- **验收用例**：5 类数据源各自出现、处置后实时消失、配对薄客户端只读/转发提示准确、`pnpm audit:modules` 零新增违规。

---

## 阶段 2 · F8：跨渠道身份显式验证与私聊受控续办

在现有 `ContactProfile` 与 `IdentityMergeDialog` 基础上，补齐跨平台同一人身份密码学/交互核验与私聊跨渠道续办闭环。

### 2.1 一次性绑定码与人工合并契约

1. **绑定码签发与核销（One-time Bind Code）**：
   - 操作员可在桌面端「联系人资料（Contact Profile）」或任一已验证私聊中执行 `/bind-channel`，由 Host 生成高熵短期绑定码（格式如 `BIND-XXXX-XXXX`，TTL 10 分钟，单次有效，仅保存 SHA-256 摘要、目标 `contactProfileId`、签发时间与剩余尝试次数上限 3 次）。
   - 用户在另一 IM 渠道（如从飞书切到 Telegram）向助理私聊发送 `/bind BIND-XXXX-XXXX`。
   - Host 校验摘要未过期、未消费、尝试未超限且当前会话为 `private`（私聊）后，调用现有身份合并事务将该渠道 `platformIdentityId` 关联至同一 `ContactProfile`，写入 `connectorAudit`（`identity.bound_via_code`），并立即销毁绑定码。
2. **操作员人工合并**：保留并强化 `components/connectors/identity-merge-dialog.tsx`，明确标注合并来源为 `manual_operator` 或 `verified_bind_code`；未经上述两种路径确认的外部账号一律视为独立主体。

### 2.2 私聊跨渠道列表与续办命令（`/sessions all` · `/resume <id>`）

1. **权限与隐私门禁（Fail-closed）**：
   - 仅当满足以下**全部条件**时开放跨渠道查询与续办：
     1. 当前入站会话 `channelKind === "private"`（严禁在群聊/频道中回显跨渠道个人会话列表或恢复私密上下文）；
     2. 发送者 `platformIdentityId` 已通过 `verified_bind_code` 或 `manual_operator` 绑定至当前 Host 操作员本人的 `ContactProfile`（与 `readHostPersonContext()` 对齐）。
   - 不满足条件时，`/sessions all` 仅列出当前单会话历史（与现有 `/sessions` 行为一致）并温和提示需先在私聊完成身份绑定；群聊中调用 `/resume` 指向跨会话目标时直接拒绝并记录审计。
2. **会话枚举与接力机制**：
   - `/sessions all`：按最近活跃时间列出该已验证身份名下跨适配器（Lark / Telegram / Slack / 桌面主聊天）的最近 $N$ 条会话与运行中 Team/Goal 委托（展示短引用码 `#S1`..`#Sn`、渠道图标名、标题摘要、最后状态）。
   - `/resume <短码|sessionId>`：将当前 IM 私聊的活跃会话绑定（`sessionBindings`）切换至目标 `ChatSession`（若目标会话关联活跃 Goal / Team 运行，同时把后续进度卡片与审批通知路由回当前私聊会话，原渠道保留只读切换提示），实现「桌面发起任务 → 路上用飞书/Telegram 私聊无缝查看进度、补充指令与审批收尾」。

### 2.3 触点与测试要求

- **主要触点**：
  - `lib/connectors/identity/bind-code.ts`（+ `.test.ts`：生成、哈希存储、TTL、防暴力枚举、单次消费并发锁）
  - `lib/connectors/commands/cross-channel-sessions.ts`（+ `.test.ts`：`/sessions all` 与 `/resume` 命令处理、群聊拦截、`personal-sink` 校验）
  - `lib/connectors/session-bindings.ts`（扩展跨适配器受控重绑与审计记录）
  - `components/connectors/identity-merge-dialog.tsx`（展示绑定验证等级徽章与「生成跨渠道绑定码」入口）
  - `i18n/messages/{en,zh-CN}/inbox.json`、`connectors.json`
- **验收用例**：
  - 正常私聊签发并在第二渠道核销成功；过期码、重放码、猜错 3 次自动作废、群聊核销均被拒绝。
  - 已验证私聊执行 `/sessions all` 与 `/resume` 后，后续消息进入原目标 `ChatSession` 上下文且不触发跨人隐私拦截；未验证用户或群聊调用零信息泄露。

---

## 阶段 3 · F7：常用个人数据源一体化配置向导与 Radar 接入

在不破坏纯静态导出架构、不把第三方 OAuth 客户端密钥硬编码进前端包的前提下，打通高频个人办公数据源（Lark、Gmail、Google Calendar、Microsoft Outlook）的标准配置与健康自检闭环。

### 3.1 分层连接与凭据托管架构

| 数据源                             | 运行通道                           | 凭据存储与权限模型                                                                |
| ---------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| **Lark / 飞书（日历 + 任务）**     | 内置 `lib/skills/built-in/lark/`   | 复用桌面端已连接飞书用户主体与 `lark-cli` 鉴权状态；缺 scope 时给出精确权限项指引 |
| **Gmail / Google Calendar**        | 预设 MCP Server（本地 stdio 进程） | 引导填入用户自有 OAuth Client / App Token，经 Tauri IPC 存入系统 Keyring          |
| **Microsoft Outlook（邮件/日程）** | 预设 MCP Server / Graph 插件模板   | 同上，Token 仅驻留桌面/常驻 Host Keyring，渲染层仅持不透明 `credentialRef`        |

- **静态导出与平台降级契约**：在纯浏览器（Web 模式）下明确展示 `UnavailableNotice`（说明本地 MCP 进程与系统 Keyring 需要桌面端或已配对的常驻 Host），支持在已配对薄客户端远程查看连接健康状态但不在浏览器端落地长效刷新令牌。

### 3.2 「个人数据源向导」交互流程

在 `Settings → Connections`（及 Radar 设置区的「连接更多信号源」快捷入口）提供三步式配置卡片 `PersonalDataSourcesWizard`：

1. **选择数据源预设**：展示 Lark 日历与任务、Gmail、Google Calendar、Outlook 四张标准卡片及当前状态（`未配置` / `就绪` / `需重新授权` / `仅桌面宿主可用`）。
2. **环境与凭据自检**：
   - Lark：一键检测 `lark-cli` 可用性、账号登录态及日历/任务读取权限，运行只读连通性探针（拉取未来 24 小时日程数量，不持久化正文）。
   - Gmail / Google Calendar / Outlook：自动填充经过审计的 MCP 启动模板参数，采集凭据写入 `host-secrets`，启动 MCP 握手并验证预期只读工具（如 list events / list unread threads）已注册。
3. **接入助理与主动发现（可选开关）**：
   - 允许按数据源粒度勾选「允许对话助理按需查询」与「纳入 Attention Radar 近期信号摘要」。
   - **写入与外发保护**：所有发信、改日历、建外部任务类工具自动纳入 `isOutboundToolId` / ADR-0239 收件人授权与 HITL 审批门禁，绝不因开启只读摘要而放开静默外发。

### 3.3 与 Radar 采集管道的受控衔接

- 在 `lib/radar/collect.ts` 的信号源适配器中增加可选只读快照收集器（仅在对应数据源开启「纳入 Radar」且运行在拥有凭据的桌面/常驻 Host 时执行，受同一 `AbortSignal` 与超时预算约束）：
  - 提取未来 48 小时关键日程冲突/临近截止外部任务、近期高优未回复邮件主题摘要（先经 `@cognia/redact` `hasNoLeakingPii` / 脱敏管道处理，仅将归一化短摘要作为瞬时分析输入，**不在 `radarReports.sources` 中持久保存邮件原文副本**，与 `B1` 零副本留存原则一致）。

### 3.4 触点与测试要求

- **主要触点**：
  - `lib/integrations/personal-sources/presets.ts`（+ `.test.ts`：四类数据源预设定义、所需工具集与只读探针契约）
  - `lib/integrations/personal-sources/health-probe.ts`（+ `.test.ts`：Lark 与 MCP 握手自检、超时与错误分类）
  - `components/settings/connections/personal-sources-wizard.tsx`（+ `.test.tsx`：配置流、Keyring 引用绑定、Web 模式降级提示）
  - `lib/policy/risk/outbound-tools.ts`（补充 Gmail/Outlook/Calendar 外发写工具 ID 映射及单测）
  - `i18n/messages/{en,zh-CN}/settings.json`、`radar.json`
- **验收用例**：
  - 凭据仅通过 `credentialRef` 传递，Dexie 与日志中零明文 Token（通过 PII 与静态导出门禁）。
  - 外发邮件/日历邀请工具在默认账户下触发 `F2` 收件人授权询问或暂存草稿。
  - 数据源离线或 Token 失效时，向导与委托就绪条准确提示 `reauth_required`，且不阻塞 Radar 其余本地信号生成。

---

## 工作包依赖与总体验收门槛

| 工作包                     | 对应审计项            | 前置依赖                              | 预计交付粒度  | 退出标准                                                                      |
| -------------------------- | --------------------- | ------------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| **WP1 · 个人责任统一视图** | F10                   | 已就绪（复用现有本地表）              | 1 个独立 PR   | Inbox「待我处理」聚合 5 类事项并支持原位处置，薄客户端转发一致                |
| **WP2 · 跨渠道验证与续办** | F8                    | 已就绪（复用 `ContactProfile`）       | 1 个独立 PR   | 一次性绑定码 + 私聊 `/sessions all` & `/resume` 闭环，群聊严格隔离            |
| **WP3 · 个人数据源向导**   | F7（+ F6 外部源扩展） | `host-secrets` + MCP 注册表（已就绪） | 1–2 个独立 PR | Lark / Gmail / Google Calendar / Outlook 向导自检通过，写操作受 ADR-0239 约束 |

每次合并必须通过以下确定性门禁：

- 同目录单元测试：`pnpm test --runInBand --runTestsByPath <touched-tests>` 且 `pnpm audit:colocated-tests` 零缺失。
- 架构与静态导出守卫：`node scripts/gates/check-modules.mjs`（零新增违规）、`pnpm lint:static-export`、`pnpm lint`（零 warning）、`pnpm typecheck`。
- 国际化一致性：`pnpm i18n:build && pnpm i18n:build:check && pnpm lint:i18n`。
