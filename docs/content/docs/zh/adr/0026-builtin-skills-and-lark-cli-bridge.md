---
title: "ADR-0026：内置技能层 + lark-cli 桥接"
description: "代码审查通过的第一方 MCP 工具，包装 lark-cli，并连接 A2UI ⇄ 技能的 HITL 双向流程"
---

# ADR-0026：内置技能层 + lark-cli 桥接

- **状态**：已通过
- **日期**：2026-05-19
- **Schema 升级**：v42 → v43（`connectorCallbackBindings.payload?` + `"skill_invoke"` kind、`conversationOverrides.allowedBuiltInSkillIds` + `requireHitlForWrites`、`adapterInstances.lastKnownSkillCapabilities?`）
- **取代**：无 — 在 ADR-0009 / ADR-0025 之上叠加

## 背景

A2UI ⇄ IM 桥接（ADR-0025）解决了消息层，但 Lark 适配器仅覆盖 IM。助手能读写飞书消息，却接触不到飞书企业套件——日历、文档、多维表格、电子表格、任务、知识库——这些恰是 lark-cli 已经覆盖的高价值生产力域。

可安装的 Skills（`character.skillIds`）仅作提示注入，并不适合 shell 出 lark-cli。把 lark-cli 接入插件加载器又会污染信任模型。

我们需要一个独立的、**代码审查通过的内置技能层**：

1. 把每个 lark-cli 子命令包装为强类型 MCP 工具，助手可直接调用。
2. 复用现有 Lark 适配器 OAuth（`lib/connectors/adapters/lark/auth.ts`），用户无需单独跑 `lark-cli config init` / `auth login`。
3. 在 IM 渠道中执行清晰的信任分级：read 自动执行，write 弹出 A2UI 确认卡，destructive 需要按会话显式 opt-in。

## 决策

### 双轨并行

**Track A — 内置技能层 + lark-cli 桌面侧执行。** 每个 lark-cli 子命令通过强类型 MCP 工具暴露。执行发生在桌面 sidecar：通过 `execFile` 调用 npm 安装的 `lark-cli` 二进制，并把 Lark 适配器存储的 OAuth 凭证以环境变量形式注入。移动端通过现有 V2 server-client 通路触发，但执行始终在桌面侧。

**Track B — A2UI Dialog/Modal 能力填齐。** 纯适配器代码：把 Lark Card v2 的 `form_dialog` 与原生 Checkbox、Slack `views.open`、Discord `interaction.showModal` 接入到现有 A2UI capability matrix。独立于 Track A。

### 内置技能注册表

```
interface BuiltInSkill {
  id          // "lark.calendar.list_events"
  family      // "lark.calendar"
  label, description: BilingualString
  platforms   // PlatformKind[] | "any"
  mutation    // "read" | "write" | "destructive"
  imAccess    // "always" | "readonly" | "opt-in" | "blocked"
  mcpToolName // "lark_calendar_list_events"
  inputSchema: ZodTypeAny
  execute(args, ctx): Promise<unknown>
  hitlSurface?(args): A2UISegmentContent  // write/destructive 必须提供
}
```

每个技能在模块加载时通过 `registerBuiltInSkill()` 自注册。共享注册表提供 `listByPlatform()`、`listByMutation()`、`families()`。`lib/skills/built-in/index.ts` 触发所有家族的副作用 import。

### 信任模型

按 `mutation` 分级：

| 等级            | 默认 `imAccess` | HITL                         |
| --------------- | --------------- | ---------------------------- |
| `"read"`        | `"always"`      | 不需要——只走 PII 闸门 + 审计 |
| `"write"`       | `"always"`      | 默认弹出 A2UI 确认卡         |
| `"destructive"` | `"opt-in"`      | 始终弹出 A2UI 确认卡         |

按会话的覆盖：

- `ConversationOverrideRow.allowedBuiltInSkillIds: string[] | "all" | undefined`：`undefined`/`"all"` 沿用每个技能的默认 `imAccess`；`[]` 屏蔽全部；显式列表（支持 `family.*` 通配符）约束该会话可调用范围。
- `ConversationOverrideRow.requireHitlForWrites: boolean`：默认 `true`；受信内部群可设为 `false` 跳过 write 类的确认卡。destructive 级别忽略此开关，始终 HITL。

### Dispatcher 流水线

`runBuiltInSkill(skillId, args, ctx)` 顺序执行：

1. 注册表查找 — 找不到时返回 `unknown_skill` 拒绝。
2. Zod schema 校验 — 失败返回 `invalid_args`。
3. PII 闸门 `hasNoLeakingPii`（与 Twin/Goal 共享）— 命中返回 `pii_blocked`。
4. 会话白名单 — 不通过返回 `not_allowed_for_channel`。
5. `imAccess` 检查 — `destructive_opt_in_required` /`readonly_requires_channel_curation` / `skill_blocked_in_im` 拒绝。
6. 按 mutation 分级 HITL 路由：
   - read / write+`requireHitlForWrites=false` / `hitlBypass=true`：立即执行
   - write / destructive：渲染 `skill.hitlSurface(args)`，写入 `connectorCallbackBindings` 行（`kind: "skill_invoke"`，`payload: {skillId, args}`），返回 `pending_hitl`

每个闸门都会写入 `connectorAudit` 行，使用新增的审计类型（`builtin_skill_invoked` / `_denied` / `_hitl_pending` / `_hitl_approved` / `_hitl_rejected` / `_failed`）。PII 在写审计前先做脱敏。

### A2UI ⇄ 技能双向流程

用户在 A2UI 卡片点击 Confirm。适配器 parser 把平台 payload 规范化为 `ConnectorCallbackEvent` 交给 `ConnectorBus.dispatchConnectorCallback`。Bus：

1. 按 `triggerId`（namespace `"callback"`）去重。
2. 调用 `resolveCallbackBinding(adapterId, actionId)` 查找绑定。
3. 检测到 `binding.kind === "skill_invoke"`，跳过标准 digest-turn 路径。
4. 读出 `binding.payload.{skillId, args}`，调用 `runBuiltInSkill(skillId, args, { hitlBypass: true })` 再次执行。

Cancel 点击则记录 `builtin_skill_hitl_rejected` 并返回。

### Sidecar 暴露

内置技能 manifest 合并到现有的 `opts.pluginTools` 流。Sidecar 的 `plugin-tools.mjs` 据此构建一个合成 `cognia-plugin-tools` MCP server，并通过 `plugin_tool_exec` IPC 把调用代理回 renderer。`lib/claude/plugin-tool-ipc.ts:handlePluginToolExec` 在 plugin 注册表未命中时回落到内置技能注册表（按 `mcpToolName` 查找），统一走同一个 IPC 通道，无需新增 IPC 通道。

### lark-cli 执行

`lib/skills/built-in/lark/exec-lark-cli.ts` 包装 `execFile`：

- 二进制定位：`LARK_CLI_BIN` 环境变量 → PATH 查找 → Windows`%APPDATA%\npm\lark-cli.cmd` 兜底。
- 上限：5 分钟超时（可调）、1 MB stdout 上限、`windowsHide: true`。
- 通过 `auth-bridge.ts` 注入鉴权环境变量：从 Lark 适配器存储的 OAuth 令牌生成 `LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_USER_ACCESS_TOKEN`（或 `LARK_TENANT_ACCESS_TOKEN`）。
- 缺失 `--as` 时自动前置 `--as user|bot`。
- HITL 再触发时 dispatcher 传 `confirmed: true`，自动追加 `--yes`，满足 lark-cli 自己的确认闸门。
- 退出码 10 被翻译为结构化的 `hitl_required`。

### 每会话 capability prompt

`buildCapabilityPromptSection(platform, matrix, skillCapabilities?)` 新增第四条 bullet：

> 本会话可用的内置技能：lark.calendar (read+write)、lark.doc
> (read+write+destructive) …… write/destructive 操作默认通过 A2UI
> 确认卡路由。

`AdapterInstanceRow.lastKnownSkillCapabilities` 在适配器启动时缓存每家族的 mutation 集合，热发送路径无需每次遍历注册表。

## 影响

### 正面

- 飞书企业全套件（日历/文档/电子表格/多维表格/任务/知识库）成为助手可调用对象，无需重写 OAuth 或上传管道。
- 信任模型按技能 + 按会话明确分级，每一步都有审计。
- A2UI 确认卡复用现有基础设施（`connectorCallbackBindings`、`dispatchConnectorCallback`、`recordCallbackBinding`），无新持久层。

### 负面

- 桌面侧必须安装 lark-cli。auth bridge 在未安装时给出明确错误。
- 移动端经 V2 server 中转（按 ADR-0014），无法独立运行技能。v1 可接受。
- `pluginTools` manifest 在 Lark v1 携带最多 40+ 条目，系统提示词 context 预算变大。通过 IM 的 `allowedBuiltInSkillIds` 过滤以及桌面端的 `character.enableBuiltInSkills` opt-in 缓解。

### 不在 v1 范围内

- 其余 Lark 家族：`mail`、`drive`、`slides`、`vc`、`minutes`、`whiteboard`、`approval`、`attendance`、`contact`、`event`、`okr`。
- 原生 Lark Node SDK 接入（仅在 lark-cli 不够用时再考虑）。
- 在 cognia UI 中驱动 `lark-cli config init` / `auth login`。
- Lark 之外的跨平台 skill 家族（Slack canvas、Discord forums、Telegram mini-apps）。

## 分层

| 层                | 模块 / 文件                                                        |
| ----------------- | ------------------------------------------------------------------ |
| 技能契约          | `lib/skills/built-in/types.ts`                                     |
| 注册表            | `lib/skills/built-in/registry.ts`                                  |
| Dispatcher        | `lib/skills/built-in/dispatcher.ts`                                |
| Manifest          | `lib/skills/built-in/manifest.ts`                                  |
| Lark exec         | `lib/skills/built-in/lark/exec-lark-cli.ts`                        |
| Auth bridge       | `lib/skills/built-in/lark/auth-bridge.ts`                          |
| Lark 家族         | `lib/skills/built-in/lark/{calendar,doc,sheets,base,task,wiki}.ts` |
| Bus 集成          | `lib/connectors/bus.ts`（skill_invoke 分支）                       |
| Sidecar 桥接      | `lib/claude/plugin-tool-ipc.ts`（内置技能 fallback）               |
| Build-options     | `lib/claude/build-options.ts:resolveSendOptions`                   |
| Capability prompt | `lib/connectors/a2ui-bridge/capability-evaluator.ts`               |
| Settings UI       | `components/settings/built-in-skills/`                             |
| Slash command     | `lib/slash-commands/actions/lark.ts`                               |
| Schema            | `lib/db/schema.ts`（v43）、`lib/db/connector-types.ts`             |
| Audit             | `types/connectors/audit.ts`（6 个新 kind）                         |

## 修订 — 2026-10-30：IM 对话中的个人授权

内置技能上下文携带当前轮次的全部人类发送者（remoteUserId，以及可用时的
principalId、unionId），无法确认时为 `unknown`。上下文与确认卡的操作人限制
共用入站任务查询，并收集被同一 executionRunId 吸收的已完成消息。运行任务的
executionRuns 记录必须属于调用技能的 sessionId；记录缺失或属于其他会话时为未知。
尚在实时注入的 steering 消息、本地 `createdAt >= current.createdAt` 且已完成但
未归属运行的 steer，以及查询失败均保留为未知。时间窗口使用本地入站时间，不使用
平台消息时间戳。queued 和标记 `steer-replay` 的消息等待下一轮，不计入本轮。
确认卡重新执行技能时显式携带经过回调权限验证的点击者，不再用届时正在运行的任务
推断操作人。

技能必须读取 session 持久化的 `platformBinding` 判断是否来自 IM。只有当前轮次
的每位发送者都与适配器的 `settings.connectedUser.openId` 相同，才能使用其个人
user token；双方都有 unionId 时还必须一致。缺少 connectedUser、发送者未知或
为空、跨应用身份以及查询失败均以 `sender_not_token_owner` 拒绝。所有 Lark CLI
技能的读写操作和联系人姓名搜索共用该检查；仅传 sessionId 的 `/lark` 也不能绕过。
没有 platformBinding 的本地会话继续使用连接者的个人授权。

OAuth 将原生 token 发布操作返回的 `authorizationEpoch` 写入 connectedUser。
检查只获取一次原生授权快照，要求元数据 epoch 与快照一致；没有 epoch 的旧记录
必须满足快照中与 token 原子写入的 `accountLabel` 等于 `name || openId`。授权缺失
或不匹配时拒绝。检查返回该快照中已验证的 accessToken 和 epoch：CLI 直接使用此
token，HTTP 请求的刷新和重试也限定在此 epoch。对已记录 epoch 的元数据，切换账户
时即使 connectedUser 尚未完成独立写入，也不能将旧所有人的元数据与新账户的 token
组合使用。旧记录的名称比较无法区分同名账户；完成 OAuth 连接后会记录 epoch，供
后续检查使用。

不再隐式从用户身份降级为 tenant 身份。CLI bridge 首选用户身份但缺少 user token
时返回 `user_not_authorized`。OpenAPI harness 要求调用方明确选择
`identity: "user" | "bot"`：用户模式在 token 缺失、失效或刷新失败时使用现有的
`notAuthorized` 账户错误拒绝，机器人模式只使用 tenant token。文档搜索与读取、
Twin 导入，以及按账户配置的任务清单/多维表格同步资源和选择器均显式使用用户模式。

残余边界：适配器 reply-as-user 和 `lookupAsPerson` 消息路由保持原样；没有绑定
IM 会话的 Bot 控制面运行、其他 IM 平台的身份策略，以及群聊受众权限检查均不属于
本次修订。请求者是 token 所有人，并不代表群内所有成员都有权查看其个人数据。
