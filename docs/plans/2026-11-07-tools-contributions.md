# 工具贡献（ADR-0250 §14 `tools`）契约草案

状态：T0 已实施（2026-11-07），T1–T2 待做。评审结论见 §6，实施时的调整见 §7。创建：2026-11-07（Asia/Shanghai）。

上游：

- [ADR-0250](../content/docs/en/adr/0250-the-runtime-is-a-headless-kernel-the-desktop-embeds.md) §14：host 贡献含 `tools`，「`tools` carry their permission rules」；§9：`lib/claude` 解散，「feature tools go to their modules through `tools`」。`lib/modules/manifest-types.ts` 已有 `tools?: ModuleContribution` 字段，没有读取方。
- [能力授予贡献](./2026-11-07-capability-contributions.md) §1.2：`build-options` 的 21 条模块边里，filespace、协调者、workflow runner、slash、知识库、computer use 归为工具形状，留给本契约。
- 证据：本文 §1 的逐处核对，取自 `dev` 的 `9c4bf91bae`。

## 1. 现状

### 1.1 一个工具族今天由哪些部分组成

以 filespace 为例（ADR-0222 §9），一个进程内工具族散在 **9 处**，靠注释里的「同一个开关」维持一致：

| #   | 位置                                                                                                                           | 内容                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1   | `lib/claude/filespace-builtin-tools.ts`                                                                                        | 名字表、manifest 条目（手写 JSON Schema）、`isFilespaceBuiltinTool`、runner（从不抛错） |
| 2   | `lib/claude/permissions/filespace-tool-rules.ts`                                                                               | 内建同意档（ruleset）：每个工具 bare 名 + `mcp__cognia-plugin-tools__` 名各一条         |
| 3   | `lib/claude/build-options.ts` ~3232                                                                                            | `resolveFilespaceToolSurface` 算出 `{surfaced, sharing}`，决定是否合并同意档（最低层）  |
| 4   | `lib/claude/build-options.ts` ~4360                                                                                            | 同一个答案决定是否把 manifest 条目追加到 `opts.pluginTools`                             |
| 5   | `lib/claude/plugin-tool-ipc.ts` ~816                                                                                           | 分发链里的一个 `if (isX) return runX(...)` 分支（在插件注册表之前）                     |
| 6   | `sidecar/src/policy/permission/ladder.ts` `PER_CALL_PLUGIN_TOOL_NAMES`                                                         | 逐次审批名单（还要求 manifest 条目带 `requiresApproval: true`）                         |
| 7   | `lib/claude/unattended-permission-options.ts`、`lib/policy/risk/outbound-tools.ts`                                             | 权限类别（`outbound`）、ADR-0239 外发分类                                               |
| 8   | `lib/policy/action-review/outbound-targets.ts`                                                                                 | 外发目标的参数抽取（`public`）                                                          |
| 9   | `lib/harness/runtime/probe-policy.ts`、`lib/voice/live/runtime-bindings.ts`、`components/chat/message-parts/mcp-tool-card.tsx` | 探针拒绝名单、实时语音「不可取消」名单、结果卡                                          |

`build-options.ts` 里这样的工具块有 **21 段**（4233–4670），每段一个 `try { import; 去重追加 } catch { warn }`；同意档有 **10 个**，在 3239–3256 一次合并。分发链 `runPluginToolExec` 在插件注册表前后共有 **26 个**内建分支。注释反复强调「同意档不能脱离它管的工具单独出现」（否则是 inert payload，并破坏「无规则则无 ruleset」的提示缓存不变量），目前只靠人肉保证。

### 1.2 谁消费 manifest 和分发

`opts.pluginTools` 由 `resolveSendOptions` 产出，桌面渲染端、CLI（`cli/src/plugin/plugin-tool-dispatch.ts`）、headless brain、外部 agent（`lib/ai/agent/external/session/renderer-tool-host.ts`）、独立 AI SDK 对话（`lib/ai/chat/standalone-tools.ts`）共用；执行全部经 `handlePluginToolExec`。所以契约只要接在这两点，所有宿主同时生效，不需要逐宿主接线。实时语音自己调 `buildPluginToolsManifest()`，今天不含这些内建族，本契约不改变这一点。

### 1.3 用户点名的六处

| 族                      | 门槛（今天）                                                     | 同意档                                           | 额外内容                                                                                                                                                                                                   | 能否按本契约迁出                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| filespace               | 有会话、非 CLI 宿主；`sharing` 由生效的分享策略决定              | 有（list/revoke allow，share/webdav ask + 逐次） | 无                                                                                                                                                                                                         | **完全可以**。还清 `build-options -> filespace`、`plugin-tool-ipc -> filespace`；工具文件随模块搬走，`filespace-builtin-tools -> filespace/share` 两条边消失                              |
| project-coordinator     | `projectRoleToolsApply(session, project)`；协调者 / 线程两套工具 | 有（仅 `set_project_preference` ask）            | 会话稳定的协议段（`appendSystemPrompt`）；协调者每轮的项目状态段（动态尾部）；目标段（系统提示中段，见授予草案 §1.1）                                                                                      | 工具 + 同意档 + 协议段可以；动态状态段和目标段属于「上下文贡献」，见 §3 Q2                                                                                                                |
| workflow runner         | 有 `kind:"workflow"` 的技能，或 `ultracode` 档                   | 无                                               | 正常由 `cognia-workflow-ai` 插件注册同名工具；内建只是**兜底**（分发链在插件注册表之后）；ultracode 还要把插件自己的 `wf_*` 条目重新挂回                                                                   | 单个工具可以，需要契约支持「兜底」优先级；`ultracode` 重挂插件条目是思考档的事，留在内核                                                                                                  |
| slash（`SlashCommand`） | `selfInvokeTools.slashCommand`                                   | 无                                               | manifest 描述里带当前 slash 注册表的命令摘要                                                                                                                                                               | **不适用**：`slash-commands` 在归属表里是 `shell`，壳不贡献 host 能力；`build-options`/`plugin-tool-ipc -> slash-commands` 是内核指向壳的方向问题，另行处理（注册表列表经 port 或改归类） |
| 知识库（`knowledge_*`） | 有会话、知识阅读开启、agent 绑定了知识库                         | 无                                               | 构建时向 `session-reader` **注册每会话阅读器**（带解析出的知识库 id、访问绑定、检索依赖）；一段引导文字；同一模块还有每轮检索上下文（~2779）                                                               | 工具部分可以，但阅读器依赖解析器算出的 `agentKnowledgeBaseIds` / `knowledgeAccess`，且边 `build-options -> knowledge-base` 还有检索上下文那一半。跟上下文贡献一起做                       |
| computer use            | `character.enableComputerUse`、移动端总开关、IM 黑名单           | 无（走 `suppressApprovalForTools`）              | 工具本身来自 `plugins/computer-use`（插件工具）；内核做的是：按角色设置压掉聊天端审批、写 `computerUseConsentMode`、为插件执行器暂存每会话设置、`anthropicTools` + beta 头（SDK 忽略，注释已说明是死字段） | **不适用**：不是进程内工具族，是「对某插件工具的审批策略」。留在内核，或之后给 grant 加审批类字段时再议                                                                                   |

### 1.4 其余 15 族（不在本次，列出归属供排期）

| 族                                                                 | 归属                                 | 备注                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------ |
| pet                                                                | `pet`（已是 manifest 模块）          | 同意档 + `settingsAccess` 一条（`pet-builtin-tools -> petSettings`），很适合紧随试点 |
| media、sites、vector、templates、editor、artifact                  | 各自模块                             | 形状同 filespace                                                                     |
| acceptance、agent-builder、team、spawn-task                        | automation / agents / squads / tasks | agent-builder、team 也带协议段                                                       |
| web、skill、attachment、working_set、session-peer、project-history | 内核（web、skills、chat）            | 留在内核，随 `lib/claude` 拆分改名，不走贡献                                         |

## 2. 契约草案

### 2.1 manifest：静态声明 + 懒加载实现

```ts
// lib/filespace/module.ts
tools: {
  load: () => import("./agent-tools"),
  declare: {
    filespace_list:          { consent: "allow", effect: "read" },
    filespace_revoke_share:  { consent: "allow", effect: "write" },
    filespace_disable_webdav:{ consent: "allow", effect: "write" },
    filespace_share:         { consent: "per-call", effect: "outbound" },
    filespace_enable_webdav: { consent: "per-call", effect: "outbound" },
  },
},
```

`declare` 是字面量数据（门禁按 AST 读 manifest，和 `settings.keys` 一样），每个工具：

| 字段           | 取值                                  | 派生出什么                                                                                                                 |
| -------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `consent`      | `"allow"` \| `"ask"` \| `"per-call"`  | 内建同意档（bare + `mcp__cognia-plugin-tools__` 两个键，最低层）；`per-call` 另加 manifest 条目的 `requiresApproval: true` |
| `effect`       | `"read"` \| `"write"` \| `"outbound"` | `outbound` → 权限类别 `outbound`（`HOST_TOOL_CLASSES`、ADR-0239 外发工具表）；`write`/`outbound` → 探针拒绝名单            |
| `secrets?`     | `true`                                | 权限类别 `secrets`                                                                                                         |
| `cancellable?` | `false`                               | 实时语音的「不可取消」名单（默认可取消，因为 runner 收到 `signal`）                                                        |
| `precedence?`  | `"fallback"`                          | 分发时排在插件注册表**之后**（workflow runner）；默认排在之前（今天所有内建族的位置）                                      |

一个名字只由一个模块声明（门禁检查），所以分发不必加载任何模块就能按名字找到归属。模块工具在分发链里排在所有内建工具之前，与内建工具重名时模块的生效。

### 2.2 懒加载文件：`surface` + `run`

```ts
// lib/filespace/agent-tools.ts
export const toolFamily: ModuleToolFamily = {
  /** 本次运行提供哪些工具；null 表示一个也不提供。 */
  async surface(ctx: ToolSurfaceContext): Promise<ToolSurface | null>,
  /** 执行一次调用；不抛错，失败放进结果。 */
  async run(name: string, args: Record<string, unknown>, call: ToolCallContext): Promise<unknown>,
}

interface ToolSurface {
  /** 只能是 declare 里的名字；描述和 schema 在这里给（sharing 之类的运行时差异落在这里）。 */
  tools: { name: string; description: string; jsonSchema: object; timeoutMs?: number; pathParams?: string[] }[]
  /** 会话稳定的说明，追加到 appendSystemPrompt（缓存前缀内）。见 Q2。 */
  instructions?: string
}
```

- `ToolSurfaceContext`：只读，复用 `CapabilityContributionContext`（会话 id/种类/工作区/平台绑定、解析出的 agent、surface、设置只读视图），再加 `host`（`desktop` / `cli` / `brain` / `mobile`）和 `activeProject`。拿不到 `SendOptions`。
- `ToolCallContext`：`plugin-tool-ipc` 今天已经有的东西——`sessionId`、`toolUseId`、`turnId`、`executionRunId`、`signal`、`sandboxRuntimeRef`、外发授权（`toolCallAuthorization`）。宿主依赖由模块自己解析（filespace 的 `agent-tool-deps.ts` 原样搬过去），测试接缝也在模块里。

### 2.3 内核怎么用

**解析（`resolveSendOptions`）**：在今天合并同意档的位置（~3239）之前，并发调用所有活跃模块的 `surface`，一个截止时间。对每个返回的族：

1. 检查 `tools[].name ⊆ declare`，否则整族跳过并报告；
2. 由**返回的**工具和它们的 `declare` 生成同意档，作为最低层并入 `mergeRulesets`（用户规则照旧覆盖）；
3. manifest 条目（`pluginId` 由内核盖为 `cognia-<module>-builtin`，与今天两族的线上 id 相同；`per-call` 加 `requiresApproval`）在今天内建块的位置追加到 `pluginTools`，名字去重；
4. `instructions` 按模块 id 顺序追加，位置在今天协调者协议段加入的位置（见 §7）。

同意档只从 `surface` 实际返回的工具生成，所以「同意档脱离工具单独出现」在结构上不可能，不再靠注释。

**失败**：`surface` 抛错、超时或越界返回 → 该族本轮不提供，记警告、随结果返回。工具贡献只会加东西，跳过不会让运行变宽，所以不需要授予契约里的 `refuse-turn`。模块文件加载失败同样只跳过（与授予不同：授予里加载失败要拒绝本轮，因为文件里可能有收窄型贡献；工具没有收窄型）。`experimental` 模块不贡献。

**执行（`plugin-tool-ipc`）**：生成的 `lib/modules/generated/tools.ts` 给出「名字 → 模块 + declare + 懒加载」。`runPluginToolExec` 开头查一次表：命中且非 `fallback` → 加载并 `run`；然后才是插件注册表；之后是 `fallback` 工具，再之后是内建技能等今天的兜底。结果照旧过 `assertSafePluginToolResult`（PII 深检），外发调用照旧 `begin/endOutboundToolExecution`。

**sidecar 的逐次名单**：sidecar 是独立 Node 项目，不能读 `lib/`。`PER_CALL_PLUGIN_TOOL_NAMES` 保持字面量，门禁断言它包含所有 `consent: "per-call"` 的模块工具（多出来的只能是内核自己的，如 `browser_fill_credential`）。今天「名单 + manifest 标记两者都要」的规则不变。

### 2.4 不派生、暂时留在原处的

- `outbound-targets.ts` 的逐工具参数抽取：是外发审查的内核代码，需要「从参数读出目标」的函数。之后可以加 `outboundTarget(args)` 到 `ToolFamily`，本次不做。
- 结果卡（`mcp-tool-card.tsx` 的 `FilespaceShareCard`、`ProjectThreadCard`）：属于 UI，之后走 UI manifest 的一个 slot（如 `chat.toolResult`）。本次不动，组件仍从模块的 `api` 文件取名字表。
- 动态每轮段、目标段：上下文贡献。

## 3. 待评审的决定

**Q1 声明方式。** 推荐：manifest 静态 `declare` + 懒加载 `surface`/`run`（§2.1–2.2）。分发能按名字路由而不加载模块，门禁能查重名、派生名单、对 sidecar 名单做断言。替代：全部在懒加载文件里，运行时注册——少一处声明，但分发前必须加载所有模块，派生名单也只能在运行时做，门禁查不了。

**Q2 随工具的文字。** 推荐：`surface` 只能带会话稳定的 `instructions`；每轮变化的段落（协调者的项目状态、知识库检索）等「上下文贡献」契约，届时协调者的 `build-options -> project-coordinator` 边才还清。替代：现在就允许 `dynamicSection`（进动态尾部）——协调者一次迁完，但等于提前定下上下文契约的一半（放置、预算、PII 闸都没定）。

**Q3 派生范围。** 推荐：从 `declare` 派生同意档、`requiresApproval`、权限类别（`outbound`/`secrets`）、探针拒绝名单、实时语音可取消性；外发目标抽取和结果卡后续。替代：只派生同意档和逐次审批，其余名单仍手写（改动小，但每加一族仍要改 5 个文件）。

**Q4 试点。** 推荐：filespace + project-coordinator（工具、同意档、协议段；状态段和目标段留下）。filespace 证明完整形状，协调者证明 `instructions` 和协调者/线程两套工具。替代 A：filespace + workflow runner（多验证 `fallback`）。替代 B：只做 filespace。

## 4. 拟写入 ADR-0250 §14 的修订（英文原文，评审后同步中文版）

> ### Amendment (2026-11-07): the `tools` contribution
>
> A module that gives the agent in-process tools declares them in its
> manifest and implements them in one lazily loaded file. The kernel derives
> everything else a tool family used to register by hand.
>
> - **Declaration.** `tools.declare` is literal data: each tool's name,
>   `consent` (`"allow"`, `"ask"` or `"per-call"`), `effect` (`"read"`,
>   `"write"` or `"outbound"`), and optionally `secrets`, `cancellable: false`
>   and `precedence: "fallback"`. Names are unique across modules and the
>   kernel's own tools.
> - **Implementation.** `tools.load` names a file exporting `toolFamily`:
>   `surface(ctx)` returns the declared tools this run offers, with their
>   descriptions and schemas and optional session-stable `instructions`, or
>   `null`; `run(name, args, call)` executes one call and never throws. The
>   context is read-only and carries no `SendOptions`.
> - **What the kernel derives.** From the tools `surface` returned, and only
>   those: the lowest ruleset layer (both the bare and the
>   `mcp__cognia-plugin-tools__` spelling), `requiresApproval` for per-call
>   tools, the permission classes, the harness probe denial list and live
>   voice's cancellability. A consent tier can no longer be surfaced apart
>   from the tools it governs.
> - **Failure.** A family whose `surface` throws, times out or returns an
>   undeclared tool is left out of the run and reported. Tools only add, so
>   no failure refuses the turn.
> - **Dispatch.** `handlePluginToolExec` routes a declared name to its module
>   before the plugin registry, or after it for `precedence: "fallback"`.
>   Results still pass the PII check and outbound calls still carry their
>   authorization.
> - **Sidecar.** The sidecar keeps its literal per-call list; a gate asserts
>   it contains every module tool whose consent is `"per-call"`.
>
> Per-turn context that travels with a tool family (a coordinator's project
> status, knowledge retrieval) is not part of this contribution. The slash
> command tool is not a module's (its registry is a shell's), and Computer
> Use's chat-side approval policy governs a plugin's tools rather than
> providing any; both stay in the kernel.

## 5. 步骤与验收（评审通过后）

| 步骤 | 内容                                                                                                                                                                                                  | 还清的方向边                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0   | ADR-0250 修订（中英）；`ModuleToolFamily` 等类型；生成器写 `lib/modules/generated/tools.ts`；门禁（`declare` 形状、名字唯一、sidecar 名单断言）；内核收集器 + 派生 + 分发接入；单测                   | 无                                                                                                                                                                        |
| T1   | `filespace` 成为 manifest 模块（迁出归属表）；`filespace-builtin-tools.ts` + 同意档 + deps 搬到 `lib/filespace/agent-tools.ts`；删 build-options 和分发链里的 filespace 段；派生名单替换 5 处手写条目 | `build-options -> filespace`、`plugin-tool-ipc -> filespace`、`filespace-builtin-tools -> filespace`、`-> share`                                                          |
| T2   | `project-coordinator` 成为 manifest 模块；两套工具 + 同意档 + 协议段迁出；动态状态段、目标段暂留（Q2）                                                                                                | `plugin-tool-ipc -> project-coordinator`、`project-coordinator-builtin-tools -> project-coordinator`、`-> tasks`；`build-options -> project-coordinator` 保留到上下文贡献 |

验收：

- 现有 `build-options`、`plugin-tool-ipc`、两族的工具与同意档测试全部通过；补对照测试：迁移前后同一组会话得到的 `pluginTools`（顺序可变时比集合）、`permissionRuleset`、`requiresApproval` 一致。
- `pnpm audit:modules` 通过，属于本任务的度量只降不升；`pnpm sidecar:test` 通过。
- 不做桌面冒烟（沿用约定），交付说明里写明。

## 6. 评审结论（2026-11-07）

1. 声明方式：manifest 静态 `declare` + 懒加载 `surface`/`run`。
2. 随工具的文字：`surface` 只带会话稳定的 `instructions`；每轮动态段、目标段等「上下文贡献」。
3. 派生范围：同意档、`requiresApproval`、权限类别、探针拒绝名单、实时语音可取消性；外发目标抽取和结果卡后续。
4. 试点：filespace + project-coordinator。

## 7. T0 实施记录（2026-11-07）

- 类型：`lib/modules/manifest-types.ts` 的 `ModuleToolDeclaration`、`ToolSurfaceContext`（在授予的上下文之上加 `host`、`activeProject`）、`ToolSurface`、`ToolCallContext`、`ModuleToolFamily`、`ModuleToolsEntry`；manifest 的 `tools` 从 `ModuleContribution` 改为 `{ declare, load }`。
- 生成：`lib/modules/generated/tools.ts`，每个模块一行：`declare` 原样作为数据，加一条懒加载导入。
- 门禁（G5）：`tools` 形状（名字是字母开头、不含 `__`、最长 64；字段取值）、`tools.load` 文件导出 `toolFamily`、名字跨模块唯一、`per-call` 工具都在 sidecar 的 `PER_CALL_PLUGIN_TOOL_NAMES`（读不出这个 Set 字面量也报错；夹具树里没有 sidecar 文件则跳过）。
- 内核：`lib/modules/tool-declarations.ts` 只读声明数据（不加载模块）；`lib/claude/tool-contributions.ts` 收集 surface（共 2 秒截止）、派生规则集、分发。工具族的加载结果在解析和分发之间共用，加载失败下次重试。
- 接入：`resolveSendOptions` 在合并同意档之前收集，派生的规则集作为最低层的一员并入；条目和 `instructions` 在今天协调者工具块之前追加（T2 迁协调者时协议段的位置不变）。`plugin-tool-ipc` 在所有内建分支之前分发，`fallback` 在插件注册表之后、workflow runner 兜底之前。
- 派生名单：`classesForPluginTool`（`outbound`/`secrets`）、`RISK_EXTERNAL_SEND_TOOL_IDS`（因此也进 `OUTBOUND_TOOL_IDS`；名字小写化以匹配 `normalizeToolId`）、探针的 `DENIED_PLUGIN_TOOLS`（非 `read`）、实时语音的不可取消名单。名单覆盖所有声明的工具，不论模块阶段；只有分发跳过 `experimental` 模块。
- 与草案的差别：`instructions` 的位置按现状放在协调者块处，而不是 grant 的 `instructions` 之后，这样 T2 迁移前后协调者协议段在提示词里的位置不变。
- 目前没有模块声明工具，所以 T0 不改变任何运行的行为；T1（filespace）是第一个使用者。
