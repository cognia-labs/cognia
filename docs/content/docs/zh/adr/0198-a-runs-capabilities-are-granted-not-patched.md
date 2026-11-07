---
title: "0198 — 一次运行的能力靠授予，而不是事后修补"
description: "定时任务、工作流节点、插件、Bot 和子代理派发此前在解析器返回 SendOptions 后修改配置，绕过工具过滤器、受限模式、父级权限上限和最终封口，并允许定时任务替换禁用列表。改为将带版本的 AgentCapabilityGrantV1 交给 resolveSendOptions，每个字段在其扩展配置字段的对应阶段生效。"
---

# ADR 0198 — 一次运行的能力靠授予，而不是事后修补

**状态：** 已接受**日期：** 2026-09-27 **修订：** 2026-11-07，模块贡献授予（见文末修订）**相关：** [ADR-0117](./0117-composed-agent-modes-and-creator)（组合轴）、[ADR-0161](./0161-agent-identity-runtime-and-host)（身份、运行时、部署位置）、[ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)（统一执行服务）、[ADR-0002](./0002-scheduler-full-agent-resolution)（定时运行解析完整智能体）

## 背景

智能体配置（`Character`）描述"这个智能体是谁"。启动智能体的功能还需要描述"这一次运行额外能用什么、必须不用什么"：定时任务需要它的报告技能，工作流步骤想要某个 MCP 服务器和更严格的权限，插件想追加一段提示词。

此前它们都没有对应的输入。`resolveSendOptions` 只读取角色、会话、模式和少量场景字段，于是每个调用方都在结果上打补丁：

- 定时任务在解析器返回后，直接赋值 `model`、`permissionMode`、`maxTurns`、`effort`，对 `allowedTools` 取并集，**整体替换** `disallowedTools`，换掉 MCP 映射，并把临时技能拼进系统提示词（`applyPayloadOverrides`、`applyAdHocSkill`）。
- `executeAgent` 在解析后才合并运行级禁用列表、追加系统文本；只要传了 `characterId`，调用方的 `model`、`allowedTools`、`maxSteps` 都会被忽略。
- 插件和 Bot 的回合只能选角色和权限模式。

在解析器之后打补丁，会绕过解析器最后执行的所有约束：工具过滤器、受限模式、父级权限上限，以及封口工具面的 finalizer。定时任务的"替换"语义会丢掉角色的禁用项、过滤器的禁用项、MCP 服务器的禁用规则和 IM 安全禁用；它的 `permissionMode` 则绕过了整条权限链。payload 的模型在选定服务商之后才赋值，任务可能把 Anthropic 的模型 id 发给别的服务商。

另外，`resolveTurnAgentMode` 从不读取 `ctx.compositionSelection`：连接器回合自己的组合只进入了转录记录的标记，提示词增量、工具和权限仍来自桌面端输入框最后一次的选择。

## 决策

### 一个契约

`packages/agent-config-types/src/agent-capability-grant.ts` 定义 `AgentCapabilityGrantV1`：

| 字段 | 生效位置 | 方向 |
| --- | --- | --- |
| `model`、`provider`、`effort` | 各自解析链的最前端 | 替换，之后照常路由 |
| `maxTurns` | 执行策略之后 | 替换 |
| `instructions[]` | 追加到 `appendSystemPrompt` | 只追加，不替换提示词 |
| `skills.add` / `.remove` | 并入角色技能 / 会话禁用 | 增加 / 收窄 |
| `mcpServers.only` / `.add` / `.remove` | MCP 子集，只从已启用的服务器中取 | 收窄 / 增加 / 收窄 |
| `tools.add` | 允许列表，与技能声明的工具同等对待 | 增加 |
| `tools.deny` | 禁用列表，插件钩子之后再次施加 | 收窄 |
| `tools.restrictTo` | 插件钩子之后与允许列表取交集 | 收窄 |
| `knowledgeBases.add` | 智能体知识检索 | 增加 |
| `subagents.only` | 原生子智能体映射，在各分支注册之后、`@agent` 路由之前 | 收窄 |
| `permissionMode` | 对解析结果的上限 | 只能收窄 |

`BuildOptionsContext.capabilityGrants` 接受一个有序列表。纯函数 `mergeCapabilityGrants` / `foldCapabilityGrants` 负责逐层合并：禁用项取并集，后续层无法撤销已有禁用项；`restrictTo`、`mcpServers.only` 和 `subagents.only` 取交集；权限上限保留权限更低的那个。

### 允许增加，但仍受约束

授予可以增加角色未列出的工具、技能、MCP 服务器或知识库。所有增加项都在工具过滤器、受限模式、父级上限和 `finalizeToolSurface` 之前进入，因此永远不会越过它们。运行所在工作区未启用的 MCP id 会被忽略，不会被自动开启。

### 调用方

- **定时任务：** `buildSchedulerCapabilityGrant` 把 payload 转成一条授予。`disallowedTools` 改为并入禁用列表，`permissionMode` 改为上限。技能任务的技能通过 `ephemeralSkillIds` 传入。智能体已被删除、或技能在任何地方都未启用时，运行直接失败，而不是以无人设的默认智能体运行。
- **`executeAgent`：** 自身参数转成授予（`executeAgentConfigGrant`）：有 `characterId` 时，`model` 位于解析链最前，`allowedTools` 起收窄作用。`maxSteps` 终于作为 `maxTurns` 生效，`capabilityGrants` 原样透传。文本通道以指定智能体的身份发言。当智能体或授予绑定了知识库或数字分身时，工具通道会构建检索依赖。用户级长期记忆仍只属于聊天界面。
- **工作流 `action.agent.turn`：** 支持额外技能、MCP 服务器、知识库、禁用工具、追加指令和权限上限；追加指令同样经过节点的出站守卫。
- **智能体团队：** 队友解析出的 `subagentIds` 通过 `subagents.only` 收窄团队会话的原生子智能体。列表为空时保留整个团队范围，与 MCP 服务器一致。
- **插件与 Bot：** `runPluginAgentTurn` 和 `ctx.agent.run` 接受 `capabilityGrants`（会校验，并把调用方标记为来源）以及组合选择。Bot 传入完整的投影组合。

`resolveTurnAgentMode` 接受调用方提供的 `selection`，修复了上面的连接器割裂问题。

## 影响

- 一次运行的定制是一个可审查的值，可追溯到发出它的功能，并由处理配置本身的同一段代码解析。
- 依赖 `disallowedTools` 替换智能体禁用项、或依赖 `permissionMode` 放宽权限的定时任务，现在会以更窄的权限运行。这正是预期的变化。
- `runPluginAgentTurn` 显式传入的 `permissionMode` 仍是直接赋值。这是无头插件回答"谁来审批"的既定方式，这个决定仍留在调用处。
- 冻结的执行规格（ADR-0090）仍由调用方的 `provider` 和 `model` 字段推导，而不是由智能体配置推导。它只影响能力门控和指纹，不影响派发。

## 修订（2026-11-07）：模块贡献授予

有的功能模块要定制的是它适用的每一次运行，而不是调用方发起的某一次运行。这类模块通过 manifest 贡献授予（`capabilityContributions`，[ADR-0250](./0250-the-runtime-is-a-headless-kernel-the-desktop-embeds) §14，M3）。这只是多了一个授予来源，没有新增解析阶段：贡献的授予在原来折叠 `capabilityGrants` 的位置和调用方的授予一起折叠，每个字段仍在上表规定的阶段生效。

- **契约。** 模块的 manifest 指向一个文件（`capabilityContributions: { load: () => import("./…") }`），该文件导出 `contributions`，即 `{ id, failure, produce(ctx) }` 的列表（`lib/modules/manifest-types.ts`）。`produce` 从只读的 `CapabilityContributionContext` 返回一个授予或 `null`；上下文包括会话、解析出的智能体、设置、调用方传入的活动目标，以及本次运行冻结的 Prompt Center 视图。它拿不到 `SendOptions`，也拿不到调用方注入的依赖。
- **字段。** 贡献可以设置 `instructions`、`skills`、`mcpServers`、`tools`、`knowledgeBases`、`subagents`、`permissionMode` 和 `maxBudgetUsd`。不能设置 `model`、`provider`、`effort`、`maxTurns` 和 `permissionProfile`：这些是调用方对自己那次运行的选择，写了其中任何一个的授予会被拒绝。来源由内核加盖：`{ kind: "module", id: "<模块>/<贡献>" }`。
- **顺序。** 先是调用方的授予，再按模块 id、manifest 内的顺序排贡献，最后是解析器自己的（只读旁聊）。在 `mergeCapabilityGrants` 下，允许的字段无论顺序如何合并结果都一样，只有 `instructions` 按这个顺序追加。
- **失败。** 所有贡献在同一个时限（`CAPABILITY_CONTRIBUTION_DEADLINE_MS`）内并发执行。每个贡献声明失败（抛错、超时、授予被拒）意味着什么。`"skip"` 把它略过并报告；这类贡献只能加东西，设置了收窄字段（拒绝列表、`restrictTo`、移除、`only`、权限上限、预算）的会被拒绝，因为它静默丢失会让本次运行变宽。`"refuse-turn"` 让本次解析失败，凡是收窄的贡献都必须用它。贡献文件加载失败同样让解析失败，因为它可能含有收窄型贡献；下一次解析会重试。`experimental` 模块不贡献。
- **在哪里执行。** 凡是运行 `resolveSendOptions` 的地方（桌面渲染进程、headless brain），以及 `resolveSessionAsideReadOnly`，这样贡献的权限上限也约束旁聊的权限。生成的注册表 `lib/modules/generated/capabilities.ts` 只含每个贡献文件的懒加载导入；读取方 `lib/claude/capability-contributions.ts` 不导入任何模块。个人对话（person-chat）和聊天参与者两条路径在折叠授予之前就返回了，不接受贡献。

试点：`browser-companion`（原先在解析器里构造的 agent 模式说明，`"skip"`）和 `goal`（活动目标的段落作为说明、每轮美元上限作为预算，`"refuse-turn"`）。目标段落现在排在活动计划段落和调用方说明之后，也就是授予说明追加的位置。

每轮检索的上下文（记忆、知识库、项目知识、twin）以及带权限规则集的进程内工具都不是授予，不在本次修订范围内，各自另立契约：ADR-0250 的 `tools`，以及尚待决定的「上下文贡献」。
