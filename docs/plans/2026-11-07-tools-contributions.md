# 工具贡献（ADR-0250 §14 `tools`）契约草案

状态：T0、T1、T2 已实施，T3（宠物）、T4（artifact/canvas + 视频生成）、T5（Sites + vector）、T6（验收 + 编辑器）、T7（Tasks 面板贡献点 + spawn_task）、T8（Agent Builder）追加实施（2026-11-07）。评审结论见 §6，实施记录见 §7–§15。创建：2026-11-07（Asia/Shanghai）。

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

## 8. T1 实施记录（2026-11-07）

- `filespace` 成为 manifest 模块（`lib/filespace/module.ts`），归属表的 `filespace` 行删除。`dependsOn`：account-sync、artifact、collab、data、share、terminal。`api` 列出其他模块要用的 16 个文件（Files 面板与其 store、loader、paths、sources、sensitive、policy、settings-links、share-files、grants-client、link-params、open、copy-link、live-share-credentials、use-conversation-filespace、agent-tools）。反方向，share、collab、artifact、terminal、account-sync 的行补了 filespace 要用的 `api` 文件；Files 面板对 `hooks/data` 桶文件的导入改为具体文件。
- 工具族：`lib/claude/filespace-builtin-tools.ts` → `lib/filespace/agent-tools.ts`，导出 `toolFamily`；条目不再带 `pluginId` / `requiresApproval`（由内核盖上，线上的 `pluginId` 仍是 `cognia-filespace-builtin`）。宿主依赖的测试接缝从 `plugin-tool-ipc` 移到 `agent-tools`。
- 声明：list `allow`/`read`；revoke_share、disable_webdav `allow`/`write`；share、enable_webdav `per-call`/`outbound`；五个都 `cancellable: false`（运行器不接取消信号）。
- 删除：`lib/claude/permissions/filespace-tool-rules.ts`（及测试）、`build-options` 的同意档和条目两段、`plugin-tool-ipc` 的分支、`HOST_TOOL_CLASSES` / `RISK_EXTERNAL_SEND_TOOL_IDS` / 探针拒绝名单里的手写 filespace 名字。保留：sidecar 的逐次名单（门禁要求）、外发目标抽取 `PUBLIC_TOOL_IDS`。
- 还清方向边 4 条：`build-options -> filespace`、`plugin-tool-ipc -> filespace`、`filespace-builtin-tools -> filespace`、`-> share`。
- 行为对照：`build-options` 现有的 filespace 用例（同意档、条目、`requiresApproval`、无会话不提供）全部改走模块后通过；条目在 `pluginTools` 里的位置从 acceptance 之后移到协调者块之前（已有的顺序断言里两者之间没有别的工具，结果不变）。

## 9. T2 实施记录（2026-11-07）

- `project-coordinator` 成为 manifest 模块（`lib/project-coordinator/module.ts`），归属表的行删除。`dependsOn`：chat、data、fleet、git、github、issues、memory、settings-store、squads、stack、tasks、usage。`api` 列出其他模块要用的 10 个文件（暂停横幅、线程行、`use-project-threads`、建议线程卡的启动动作、工作区概览的入口 / 看板 / 用量面板 / config、聊天控制器读的 project-access、结果卡读的 agent-tools）。反方向，chat、issues、usage、memory、tasks、fleet、stack 的行补了协调者要用的 `api` 文件；三处对 `hooks/data` 桶文件的导入改为具体文件。
- 工具族：`lib/claude/project-coordinator-builtin-tools.ts` → `lib/project-coordinator/agent-tools.ts`，导出 `toolFamily`。`surface`：没有会话、没有项目、会话没有角色或协调未开启时返回 `null`；线程得到 `report_to_coordinator` + `PROJECT_THREAD_PROTOCOL`，协调者得到十个协调工具 + `PROJECT_COORDINATOR_PROTOCOL`。条目不再带 `pluginId`（线上仍是 `cognia-project-coordinator-builtin`）。宿主依赖的测试接缝从 `plugin-tool-ipc` 移到 `agent-tools`。
- 声明：list_threads、read_thread_report `allow`/`read`；set_project_preference `ask`/`write`；其余八个 `allow`/`write`；十一个都 `cancellable: false`。与旧同意档和旧探针拒绝名单一致。
- `send-extras.ts` 只剩协调者每轮的项目状态段（含一次性的设置建议），入口改名 `resolveCoordinatorTurnSection`；`build-options` 只把它放进动态尾部。目标段不动。
- 删除：`lib/claude/permissions/project-coordinator-tool-rules.ts`（及测试）、`build-options` 的同意档参数和工具 / 协议拼接、`plugin-tool-ipc` 的分支和接缝、探针拒绝名单与实时语音不可取消名单里的手写协调者名字（现在由声明派生）。
- 还清方向边 3 条：`plugin-tool-ipc -> project-coordinator`、`project-coordinator-builtin-tools -> project-coordinator`、`-> tasks`。`build-options -> project-coordinator` 保留到上下文贡献。
- 行为对照：`build-options` 现有的协调者用例（工具、协议段、目标段、项目状态、线程只拿汇报工具、协调关闭不提供）改走模块后全部通过。有一处细微差别：旧代码里项目状态段读取失败会连同工具和协议段一起丢掉，现在工具和协议段不受状态段失败影响。旧同意档在有角色时给全部十一个工具写规则，现在只给本次提供的工具写。

## 10. T3 实施记录：宠物（2026-11-07）

计划外追加的一步：宠物已经是 manifest 模块，工具族和同意档却还在 `lib/claude/`，按同一套路迁过来。

- 工具族：`lib/claude/pet-builtin-tools.ts` → `lib/pet/agent-tools.ts`，导出 `toolFamily`。`surface`：`selfInvokeTools.pet === true` 且宿主是 `desktop` 时提供五个工具，否则 `null`（与原来的 `isTauri()` 判定等价：CLI 和 brain 先于平台检测）。宠物偏好改走 `petSettingsView`，不再直接读设置 store。条目不再带 `pluginId`（线上仍是 `cognia-pet-builtin`）；没有调用者的 `isPetBuiltinTool` 删除。
- 声明：pet_status `allow`/`read`；pet_care、pet_say、pet_reward `allow`/`write`；pet_show `ask`/`write`；五个都 `cancellable: false`。同意档和探针拒绝名单与之前一致；实时语音名单里宠物工具以前没有登记，现在按运行器不接取消信号如实声明为不可取消。
- 删除：`lib/claude/permissions/pet-tool-rules.ts`（及测试）、`build-options` 的 `petToolsSurfaced` 开关、同意档参数和追加段、`plugin-tool-ipc` 的分支、探针拒绝名单里的四个手写名字。
- 还清：方向边 `pet-builtin-tools -> pet`，`settingsAccess` 的 `pet-builtin-tools -> petSettings`，`size.settingsStoreImporters` 531 → 530；收敛清单 `lib-store-imperative` 去掉旧文件一条。
- 测试：`build-options` 的宠物用例改为模拟 `detectPlatform` 返回 `tauri`（模块工具族看的是 `toolSurfaceHost`，不再看 `isTauri`）；`plugin-tool-ipc` 的路由用例把注册表条目的 `load` 固定到静态导入的工具族（同文件其他用例会 `jest.resetModules`，懒加载拿到的副本看不到注入的 deps）；`types/agent/tool.test.ts` 改为断言内核盖的 plugin id。

## 11. T4 实施记录：artifact/canvas 与视频生成（2026-11-07）

- manifest 位置：`artifact` 的代码在复数目录（`lib/artifacts/`、`components/artifacts/`），分类器早就把它们归到子系统键 `artifact`。门禁的 `manifestKind` 改为用同一张别名表取 id，`lib/artifacts/module.ts` 的 id 是 `artifact`；不另建 `lib/artifact/`。
- artifact 成为 manifest 模块（归属表行删除）：`api` 由门禁报告的 22 个被引用文件组成（三处桶文件导入改成具体文件：`lib/artifacts/index.ts` 四处、`stores/artifact/index.ts` 一处、`hooks/data` 三处，测试 mock 同步）；它引用的 25 个模块的行补上 114 个 `api` 文件。`dependsOn` 25 项（去掉 filespace，加上 modules）。
- 依赖环（G6 不允许基线豁免）：filespace 依赖 artifact（FileSpace 把 artifact 当来源、打开 artifact），而 `components/artifacts/` 下的会话停靠栏 import 了 filespace 的文件面板、面板 id 和复制链接。按评审选择（停靠栏面板改成贡献点）：
  - 文件面板：`components/filespace/files-dock-panel.tsx` 作为 filespace UI manifest（新建 `components/filespace/module.ui.ts`）的 effect，挂载时把面板定义注册进 `contextPanelRegistry`（停靠栏本来就解析注册表里的面板，插件面板走同一条路）。停靠栏里的定义、渲染器、`DOCK_SESSION_PANEL_META` 条目、`WORKBENCH_PANEL_CATALOG` 条目删除；`artifact-dock` 的 reveal 判断改用 `isKnownDockPanel`，注册面板也能被 reveal 到。渲染器按会话 id 加 key，保留以前切会话重建的行为。
  - 复制链接：新端口 `conversation-file-links`（`types/modules/ports/conversation-file-links.ts`），filespace `provides`，artifact `requires: ["conversation-file-links?"]`；停靠栏编辑器用 `usePort`，没有提供方时不给"复制链接"。`hooks/modules/use-port.ts` 列入 `modules` 行的 `api`。
- 工具族：`lib/claude/artifact-builtin-tools.ts` → `lib/artifacts/agent-tools.ts`，`lib/claude/media-builtin-tools.ts` → `lib/media/agent-tools.ts`，各导出 `toolFamily`；`videoToolsAvailable` 从 `build-options` 移进 media 工具族。`lib/ai/media/` 经 `paths` 覆盖本来就归 media，9 个被引用文件列入 media 的 `api`。
- 声明：artifact_create/update、canvas_create/update/open `allow`/`write`；artifact_read/capture、canvas_read `allow`/`read`；artifact_delete `ask`/`write`；video_generate `ask`/`write`；video_status `allow`/`read`；全部 `cancellable: false`。同意档、探针拒绝名单与之前一致。实时语音：这些工具以前没登记为不可取消，会被提供给实时语音；现在如实声明，不再提供（它们的运行器不接取消信号，正是该名单注释说要排除的情况）。video_generate 的 effect 仍记为 `write`，没有改成 `outbound`，避免改变外发授权行为。
- 删除：两个同意档文件（及测试）、`build-options` 的 `videoToolsSurfaced`、两个同意档参数和两段追加、`plugin-tool-ipc` 的两个分支、探针名单里 7 个手写名字。`build-options` 保留 `artifactsChannelAvailable` / `artifactAuthoringEnabled`（路由提示词仍用，且它读本轮是否真的提供了 `artifact_create`）。
- 还清方向边 3 条：`artifact-builtin-tools -> artifact`、`media-builtin-tools -> media`、`build-options -> media`；收敛清单 `lib-store-imperative` 的旧条目改到新路径（同一笔债）。
- 测试：build-options 的移动端用例改为模拟 `detectPlatform`；IPC 测试抽出 `useModuleTools` 帮手（固定到静态导入的工具族），artifact、视频、宠物三处路由用例共用；停靠栏测试去掉文件面板用例（由 `files-dock-panel.test.tsx` 覆盖）。
- 既有问题（未改）：`lib/shell/workbench-panels.test.ts` 的对照测试在 HEAD 就失败（常量表缺 `SESSION_TASKS_PANEL_ID`、`SANDBOX_DESKTOP_PANEL_ID` 等）；`components/artifacts/artifact-annotations.test.tsx` 一处默认值断言失败；支持文档语料 `support:docs:check` 已过期。

## 12. T5 实施记录：Sites 与 vector（2026-11-07）

- 范围：Sites、vector 两族。templates 暂缓：它的 `squad_*` 三个工具会套用和保存 squad 模板（`lib/squads/apply-squad-template`、`publish-template-to-platform`、agent-team store），而 squads 的 `dependsOn` 已含 templates；templates 成为 manifest 后整族归它会形成环。要先把 `squad_*` 拆到 squads 模块的工具族（squads manifest 正由多智能体收敛那条线在改），`template_*`、`chat_template_*` 留给 templates。（已完成，见 §16。）
- 两者成为 manifest 模块（归属表的 `sites`、`vector` 行删除）。
  - `sites`：`dependsOn` browser、cli-bridge、data、editor、logging、scheduler、share、terminal；`api` 为设备页用的 `components/sites/site-status.tsx`、工作流节点用的 5 个构建/发布文件和工具族。logging、scheduler、terminal、cli-bridge 的行各补一个 `api` 文件。
  - `vector`：`dependsOn` agent-trace（agent-trace 行补 `instrument.ts`）；`settings: { keys: [] }` 加 `lib/vector/settings.ts` 的视图，只用来读内核的 `providerSettings`（找嵌入提供方的密钥），避免工具族直接导入设置 store（`settingsStoreImporters` 不增）。
- 工具族：`lib/claude/sites-builtin-tools.ts` → `lib/sites/agent-tools.ts`；`lib/claude/vector-builtin-tools.ts` → `lib/vector/agent-tools.ts`，`resolveVectorToolDeps` 和测试替身 `__setVectorToolDepsForTesting` 从 `plugin-tool-ipc` 一起搬入。`VECTOR_BUILTIN_PLUGIN_ID` 保留，它是向量权限在 `PluginAPIPermission` 空间里的主体，值不变。
- 门槛：Sites 只在 `host === "desktop"`（原来是 `isTauri()`）；vector 要 `selfInvokeTools.vector`、桌面、且会话或运行工作区有项目（与原来相同）。
- 声明：`list_sites` allow/read，`build_site` allow/write，`deploy_site` ask/outbound；`vector_search` ask/read，`vector_add_document`、`vector_delete_document` ask/write；全部 `cancellable: false`。
  - `deploy_site` 原本就在风险集合和 `HOST_TOOL_CLASSES` 里按名字记为外发，现在由声明派生，两处手写删除，行为不变。
  - vector 以前没有同意档，按"无规则即询问"落到人工审批。提交时先声明为 `ask`；T6 新增 `consent: "default"` 后改用它（见 §13），不再写规则，与迁移前完全一致。
  - vector 的运行器本来就接中止信号（与超时合并），以前分发器没传；现在传 `call.signal`。实时语音照旧不提供（已发到原生端的写入不会撤销）。
- 删除：`site-tool-rules`（及测试）、`build-options` 的 `sitesToolsSurfaced`、同意档参数和两段追加、`plugin-tool-ipc` 的两个分支和向量依赖解析、探针名单 4 个名字、实时语音名单 3 个名字、风险集合和 `HOST_TOOL_CLASSES` 里的 `deploy_site`。最佳 N 选一的 grant 拒绝名单和探针允许名单里的 `vector_search` 是策略选择，保留。
- 还清方向边 3 条：`sites-builtin-tools -> sites`、`vector-builtin-tools -> vector`、`plugin-tool-ipc -> vector`。收敛清单 `lib-store-imperative`：旧 Sites 条目改到新路径；向量依赖解析读的 vector store 和 project store 随文件搬走，新增一个成员（`plugin-tool-ipc` 还有别的读取，仍是成员，去掉它的 `stores/index.ts`），附例外记录 `2026-11-07-vector-agent-tools-stores.json`。
- 测试：两族各自的测试改到新位置并加 `toolFamily` 用例；两个 manifest 测试；build-options 的向量用例改为模拟 `detectPlatform`；IPC 的向量用例走模块注册表（`useModuleTools`）；`ipc.test.ts` 给向量条目补上内核会加的 `pluginId`。

## 13. T6 实施记录：托管桌面验收与编辑器（2026-11-07）

- spawn_task 试过、已撤回：`spawn-task-dispatch` 写停靠栏的 store，`tasks` 要依赖 `artifact`；而 `artifact` 已依赖 `tasks`（停靠栏渲染 Tasks 面板、用 `SIDECHAT_PANEL_ID`）。要先把 Tasks 面板改成贡献点、把 sidechat 面板 id 移到 artifact，再迁。改动保存在 `~/.cognia-briefs/patches/spawn-task-tools-wip.patch`。
- `automation` 成为 manifest 模块（归属表行删除）：`dependsOn` companion、remote-desktop、skill-recorder，`requires: ["ocr?"]`（屏幕 OCR 走端口，缺提供方时报类型化错误）；`api` 为门禁报的 19 个被引用文件加工具族。companion、skill-recorder、remote-desktop 的行补 `api`。
  - 工具族 `lib/claude/acceptance-builtin-tools.ts` → `lib/automation/agent-tools.ts`：仅桌面；有 `managedAcceptance.acceptanceId` 的子会话给两个证据工具；其他非 IM 会话（含无会话）给提议工具；有 `managedAcceptance` 但没有 id 时都不给。
  - 声明：`acceptance_checkpoint`、`acceptance_complete` allow/write，`propose_acceptance` allow/read，全部不可取消。
  - 以前分发器也接受 `mcp__cognia-plugin-tools__` 前缀的名字；模块分发只按裸名。sidecar 两条路径（`tools/plugin/proxy.ts`、`tools/adapters/ai-sdk.ts`）都发清单里的裸名，所以前缀写法实际不会出现，测试里去掉了这一例。
- `codeserver`（Pro IDE）成为 manifest 模块：`dependsOn` appearance、browser、canvas、data、editor、issues、theme；`api` 为 16 个被引用文件加工具族；`hooks/codeserver/use-code-server-workspace-sync.ts` 的 `hooks/data` 桶导入改成具体文件（测试 mock 同步）；editor、browser、appearance、theme、issues 的行补 `api`。
  - 归属：编辑器工具放 `codeserver` 而不是 `editor`：`components/editor/project/project-file-review-panel.tsx` 引用 artifact，而 artifact 依赖 editor，editor 成为 manifest 会成环。读取工具不分引擎，但整族的写入一半只有 code-server 能做，ADR-0088 也是 Pro IDE 的 ADR。
  - 工具族连同 `resolveEditorToolDeps` 搬到 `lib/codeserver/agent-tools.ts`；`surface`：有工作区且 `hasWorkspaceFsBackend()` 时给 `read_active_editor`，再有 `pro-ide` 能力时加五个写入工具（与原来的 `proIdeWriteToolsAvailable` 一致，该函数删除）。
  - 声明：`read_active_editor` default/read；`open_in_editor`、`reveal_in_editor`、`show_editor_diff`、`apply_editor_edit` allow/write；`save_editor_buffers` ask/write；全部不可取消。
- 新增 `consent: "default"`（评审选择）：`read_active_editor` 以前没有同意档，几乎每个带工作区的桌面回合都会提供；写成 `ask` 会让这些回合多一个规则集（测试"still omits the EDITOR tier"失败），并压过用户对整个工具写的通配规则。`"default"` 不写规则、不加 `requiresApproval`，调用交给本次运行自己的审批。类型、`rulesetForTools`、门禁的 `TOOL_CONSENTS`、门禁测试、ADR 文字、CLAUDE.md 同步；vector 三个工具也改用它。
- 删除：两个同意档文件（及测试）、`build-options` 的验收门槛和追加段、编辑器追加段和 `proIdeWriteToolsAvailable`、`plugin-tool-ipc` 的验收和编辑器分支与编辑器依赖解析、探针名单 5 个名字、实时语音名单 1 个名字。
- 还清方向边 2 条：`acceptance-builtin-tools -> automation`、`plugin-tool-ipc -> codeserver`。收敛清单 `lib-store-imperative`：编辑器依赖解析读 project store，随文件搬走，新增一个成员（`plugin-tool-ipc` 去掉 `stores/project/project-store.ts`，仍是成员），附例外记录 `2026-11-07-codeserver-agent-tools-stores.json`。
- 既有失败（未改，不属本次）：`lib/claude/agents/dispatch-run.identity.test.ts` 7 例（多智能体那条线的派发改动）、`lib/claude/usage.test.ts` 目录对照 1 例。

## 14. T7 实施记录：Tasks 面板贡献点与 spawn_task（2026-11-07）

- 先拆环（T6 撤回的原因）：照 Files 面板的做法，聊天停靠栏不再自己定义 Tasks 面板。
  - 新增 `components/tasks/tasks-dock-panel.tsx`：在上下文面板注册表里注册 `SESSION_TASKS_PANEL_ID`（review 活动、顺序 12、有状态保留），由 `components/tasks/module.ui.ts` 的 `effects` 挂载。
  - 注册表的 `appliesTo` / `getBadge` 是同步的，所以面板维护一个最多 8 个会话的观察缓存：计划用 dexie `liveQuery(listPlansBySession)`，变化时 `refresh()`；未完成任务数从聊天 store 的消息折叠（`sessionTaskTimeline`），数变化时 `refresh()`。可见：有计划或有任务列表；徽标：待审批计划数，否则未完成任务数。
  - `chat-dock-panels.tsx` 删掉 Tasks 定义、渲染器、计划 live query 和任务计数；`dock-panel-meta.ts` 删掉 `plan` 项；`lib/shell/workbench-panels.ts` 的静态目录删掉 `plan`（注册表面板由目录合并进来）。行为差别：Tasks 面板在自定义器里排到注册表面板一侧，不再在静态目录的固定位置。
  - `SIDECHAT_PANEL_ID` 从 `lib/tasks/spawn-task-core.ts` 移到 `lib/artifacts/session-workbench-scope-key.ts`，停靠栏和布局 store 改从这里引用。`artifact` 的 `dependsOn` 去掉 `tasks`。
- 再迁 spawn_task（套用 `~/.cognia-briefs/patches/spawn-task-tools-wip.patch`，两处冲突手工改）：
  - `tasks` 成为 manifest 模块（归属表行删除）：`dependsOn` agent、artifact、chat、context-workbench；`api` 为门禁报的被引用文件（任务行、图标、进度条/徽标、`task-view`、`spawn-task-dispatch`、Tasks 面板）加工具族。agent 行补计划视图的 4 个组件和 `use-session-plan`，chat 行补 `tool-row`。
  - 工具族 `lib/claude/spawn-task-builtin-tools.ts` → `lib/tasks/agent-tools.ts`：设置 `selfInvokeTools.spawnTask` 开启且宿主不是手机时提供；运行前过 PII 闸。插件 id 随模块变成 `cognia-tasks-builtin`（源码里没有按旧 id 判断的地方）。
  - 声明：`spawn_task` default/write，不可取消。它以前没有同意档，按 T6 的约定用 `"default"`，不写规则，与迁移前一致。
- 删除：`build-options` 的 spawn_task 追加段、`plugin-tool-ipc` 的分支与依赖解析、探针名单 1 个名字、实时语音名单 1 个名字。
- 还清方向边 2 条：`plugin-tool-ipc -> tasks`、`spawn-task-builtin-tools -> tasks`。
- 既有失败（未改）：`lib/shell/workbench-panels.test.ts` 对照 2 例，因为 `SANDBOX_DESKTOP_PANEL_ID` 未映射，HEAD 上就有。

## 15. T8 实施记录：Agent Builder（2026-11-07）

- 归属：按主题应归 `agent`（`lib/agents/` 经别名归 `agent`），但它是内核类。内核子系统要贡献工具得先变成模块，那样所有内核里导入 `lib/agents/**` 的文件都违反 G2，不可行。所以新建 `agent-builder` 模块（`lib/agent-builder/module.ts`），只装工具族和 builder 协议；会话、草稿、UI 留在内核，模块从内核的 lib 读（模块导入内核 lib 不需要 `api` 或 `dependsOn`）。
- 把整个 builder 搬进模块，挡路的不是 /agents 页面（内核的 UI 层按门禁是模块类，模块导入模块允许），而是 `build-options` 每轮的草稿段要读 `send-extras` / `tool-deps`：内核 lib → 模块会违反 G2。等上下文贡献落地，草稿段改成贡献，builder 就能整体搬进来。
- 搬动：`lib/claude/agent-builder-builtin-tools.ts` → `lib/agent-builder/agent-tools.ts`（加 `toolFamily` 和依赖注入）；`lib/agents/builder/builder-protocol.ts` → `lib/agent-builder/builder-protocol.ts`（现在只有工具族用它）；`AgentBuilderToolDeps` 接口挪到内核 `lib/agents/builder/tool-deps.ts`（内核不能导入模块的类型）。
- `surface`：会话 `kind === "agent-builder"` 且带草稿状态时，给四个工具和 builder 协议（作为 `instructions`），所有宿主都给，与原来一致。
- 声明：`agent_builder_get_draft`、`agent_builder_list_catalog` allow/read；`agent_builder_update_draft` allow/write；`agent_builder_create_agent` ask/write；全部不可取消。插件 id 仍是 `cognia-agent-builder-builtin`。
- `send-extras.ts` 只剩每轮草稿段，入口改名 `resolveAgentBuilderTurnSection`；`build-options` 只把它放进动态尾部。
- 删除：同意档文件 `lib/claude/permissions/agent-builder-tool-rules.ts`（及测试）、`build-options` 的同意档合并和工具/协议追加、`plugin-tool-ipc` 的分支与依赖解析、探针名单 2 个名字（现在由声明派生：update/create 是 write，被拒；get/list 是 read，放行，与原来一致）。
- 门禁：模块数 +1，附例外记录 `2026-11-07-agent-builder-module.json`；没有方向边可还（原来的边是内核 → 内核）。
- `build-options.test` 补两例：builder 对话拿到四个工具、同意档、协议和草稿段；普通对话都不拿。
- 既有失败（未改，不属本次）：`colocated-tests` 报 `lib/workflow/runs/budget-summary.ts`、`lib/workflow/runtime/run-budget.ts` 缺测试，typecheck 报 `budget-summary.ts`，都是另一个会话未提交的工作流预算改动。

## 16. T9 实施记录：模板与 Squad 模板工具（2026-11-07）

- 拆族：`template_*`、`chat_template_*` 五个工具归 `templates`（`lib/templates/agent-tools.ts`），`squad_list`、`squad_apply_template`、`squad_save_as_template` 归 `squads`（`lib/squads/agent-tools.ts`）。两族共用的部分放在 `lib/templates/agent-tool-kit.ts`（templates 的 `api`）：门槛 `templateToolsOffered`、同意主体、平台换算、列表/读取上限、结构化失败。
- 门槛不变：`selfInvokeTools.templates` 开启，且不是绑定 IM 的会话、不是 CLI（原来的 `artifactsChannelAvailable`）。同意代理的主体保留 `cognia-template-builtin`（`TEMPLATE_TOOL_CONSENT_SUBJECT`），已有授权继续有效；工具本身随模块以 `cognia-templates-builtin` / `cognia-squads-builtin` 发送。
- 声明：八个工具都是 `allow`（与原同意档一致，写入在运行器里问同意代理），读为 `read`，`template_instantiate`、`squad_apply_template`、`squad_save_as_template` 为 `write`，全部不可取消。三个写入工具以前在探针拒绝名单里手写，现在由声明派生。
- 拆环：只把 `squad_*` 拆走还不够。`lib/templates/runtime.ts` 的生产端口和 `legacy-sources.ts` 的旧 squad 模板读取直接用 agent-team store，`templates` 成为 manifest 后与 squads 形成 `dependsOn` 环。新增端口 `squad-templates`（`types/modules/ports/squad-templates.ts`，`{ agentTeam, legacyTemplates }`），由 squads 提供（`lib/squads/ports/squad-templates.ts`，代码从 runtime 搬来）。templates `requires: ["squad-templates?"]`：生产端口的 agentTeam 每次调用 `loadPort`，没有提供方时明确报错；旧模板读取没有提供方时读到空。
- `templates` 成为 manifest 模块（归属表行删除）：`dependsOn` a2ui、data、document-templates、share、workflow；`api` 在原行基础上加 `adapters.ts`（端口契约用的类型）、`agent-tool-kit.ts`、`install-shared-definition.ts`、`package-manifest.ts`、`publisher-identity.ts`（cogpack、分享、远程迁移在用）。a2ui、document-templates、share、workflow 的行各补 templates 用到的 `api` 文件；`use-scoped-template-catalog` 的 `hooks/data` 桶导入改成具体文件（测试 mock 同步）。
- 删除：`lib/claude/template-builtin-tools.ts`、`lib/claude/permissions/template-tool-rules.ts`（及测试）、`build-options` 的 `templateToolsEnabled`、同意档合并和追加段、`plugin-tool-ipc` 的分支和依赖注入（`__setTemplateToolDepsForTesting` 搬进模块，squads 一侧为 `__setSquadToolDepsForTesting`）、探针名单 3 个名字。
- 还清方向边 2 条：`template-builtin-tools -> squads`、`template-builtin-tools -> templates`。收敛清单：`lib-store-imperative` 旧条目改到 `lib/squads/agent-tools.ts`，端口文件新增一个成员（templates 的两个文件去掉 agent-team store，仍是成员），附例外记录 `2026-11-07-squad-templates-port-stores-{static,all}.json`；`run-tables` 两个成员改到新路径。
- 测试：旧运行器测试拆成两族各自的测试并加 `surface` 用例；`agent-tool-kit`、templates manifest、squads manifest（工具与端口）、端口实现的测试；runtime 和 legacy-sources 补端口转发与无提供方的用例；IPC 两例走模块注册表。`build-options.test` 的两例模板用例未改，经模块通过。

## 17. T10 实施记录：Squad 协作工具（2026-11-07）

- 一个模块只有一个工具族，squads 现在有两半：`lib/claude/team-builtin-tools.ts` → `lib/squads/collaboration-tools.ts`（`git mv`，导出 `teamToolFamily`），上一步的 Squad 模板工具 `lib/squads/agent-tools.ts` → `lib/squads/template-tools.ts`（导出 `templateToolFamily`）；新的 `lib/squads/agent-tools.ts` 合并两半的 `surface`（工具相加，instructions 只来自协作一半），`run` 按 `isTeamTool` 路由。
- 门槛不变：会话 `kind === "team"` 且 `selfInvokeTools.teamCollaboration` 开启；`twin_knowledge_search` 仍只在当前队员绑定了 twin、或团队有 `knowledgeTwinIds` / 成员有 `twinId` 时提供（`teamHasKnowledgeTwins` 从 `build-options` 搬入，`ctx.agent.twinId` 代替 `character.twinId`）。`TEAM_MESSAGING_PROTOCOL` 作为 `instructions`，位置从 team 段之后变成贡献工具的 instructions 内，内容不变。
- 调用：`run` 用 `getTeamDispatchContext(call.sessionId)` 找队员身份，`toolCall` 取 `call.outboundAuthorization`（与原分发器的 `toolCallAuthorization` 相同）；没有身份时返回原来的拒绝文案。注册表改为静态导入（只有类型依赖），避免兄弟测试 `resetModules` 后拿到另一份实例。
- 声明：十二个工具都是 `consent: "default"`（原来没有同意档），读为 `team_read_memory`、`team_list_members`、`task_get`、`twin_knowledge_search`，其余为 `write`，全部不可取消。`team_post_to_chat` 故意声明 `write`：声明 `outbound` 会进入风险分类器的 external-send 集合，让每次无头 IM 小队运行失败关闭（ADR-0070 否决过）；外发引擎仍按名字在 `OUTBOUND_TOOLS_OUTSIDE_RISK` 里审查它，外发目标提取器的分支保留。
- 删除：`build-options` 的 `teamHasKnowledgeTwins` 和 team 追加段、`plugin-tool-ipc` 的分支和注册表导入、探针拒绝名单 8 个名字（由非 read 声明派生；四个读工具本来就被发现阶段拒绝，行为不变）、实时语音名单 12 个名字（由 `cancellable: false` 派生）。插件 id 由 `cognia-team-builtin` 变为 `cognia-squads-builtin`，源码里没有按旧 id 判断的地方。
- 最佳 N 选一的拒绝名单仍按 `TEAM_TOOL_NAMES` 写死，改从 `lib/squads/collaboration-tools.ts` 导入（列为 squads 的 `api`）。connectors 行补 `audit.ts`、`delivery-gateway.ts`、`session-bindings.ts` 三个 `api` 文件。
- 还清方向边 4 条：`build-options -> squads`、`team-builtin-tools -> connectors / squads / twin`。收敛清单 `lib-store-imperative`：两个成员改到新路径，`build-options` 去掉 agent-team store。
- 测试：协作工具的原测试随文件搬动，补 `teamToolFamily`（门槛、twin 门、身份绑定、无身份拒绝）和 `teamHasKnowledgeTwins` 的用例；新增合并族测试；squads manifest 测试覆盖全部 15 个声明；IPC 两组 team 用例走模块注册表（`team_post_to_chat` 用例改为检查投递的授权）。`build-options.test` 的四例 team 用例未改，经模块通过。
- 多智能体收敛计划 P6 要求"只在小队队员会话下添加 `team_*`"，对应位置现在是 `teamToolFamily.surface`。

## 18. T11 实施记录：SlashCommand 与 slash-commands 模块（2026-11-08）

- `slash-commands` 从 shell 行变成 manifest 模块（`lib/slash-commands/module.ts`，归属表行删除）。`dependsOn`：artifact、best-of-n、context-workbench、goal、issues、loop、media、memory、skill-recorder、squads、workflow；`api` 为其他模块和界面在用的 13 个文件（注册表、`builtin`、`parse-segments`、`mention-boundary`、`merge`、`run-segments`、`system-blocks`、`custom`、`build-args`、`plugin-commands`、`actions/{goal,side-chat,workflow}`）。best-of-n、workflow、loop、skill-recorder、context-workbench 的行补了 slash 动作用到的 `api` 文件。
- 提示词：`actions/workflow.ts` 的五个 `developer.workflow.slash.*` 作为模块的 `prompts` 贡献（`lib/slash-commands/prompts.ts`），`lib/prompts/catalog.ts` 不再导入它。
- 拆环：`lib/squads/auto/run-executor.ts` 引用 `/council` 动作里的 `resolveCouncilRoster`，而 slash 的 `/plan` 动作读 agent-team store，两边都声明后会成环。`parseCouncilArgs`、`ParsedCouncilArgs`、`resolveCouncilRoster` 移到议会引擎 `lib/ai/council/roster.ts`（内核，纯函数，测试随移），`/council` 动作、自动小队执行器和 CLI 的议会控制器都从这里取。
- boot 依赖（评审选择"归入内核"）：注册表在命令未注册时动态导入 `lib/boot/capabilities.ts` 拉起插件运行时，模块不能导入 shell。该文件不导入任何东西，归属表加路径覆盖 `lib/boot/capabilities.` → `runtime`（基础层，与类型化 topic 同层，比内核更低，内核、模块、shell 都可用）。顺带还清内核和模块指向 boot 的 5 条基线边（`invoke-plugin-tool`、`activation-triggers`、`turn-route/snapshot`、`use-shadow-report`、`plugin-extension-slot` 等）。
- 工具族：`lib/claude/slash-builtin-tools.ts` → `lib/slash-commands/agent-tools.ts`（`git mv`），依赖注入 `__setSlashToolDepsForTesting` 从 `plugin-tool-ipc` 搬入。`surface`：`selfInvokeTools.slashCommand` 开启时在所有宿主提供（与原来一致，含 CLI），描述里列出注册的命令；`run` 用 `withHostCommandExecution` 以调用会话、`call.executionRunId` 执行，参数里伪造的运行 id 不起作用。
- 声明：`SlashCommand` default/write，不可取消。它以前没有同意档；探针拒绝和实时语音不可取消名单里的手写名字改由声明派生。
- 删除：`build-options` 的追加段（注释改为只讲 Skill）、`plugin-tool-ipc` 的分支、依赖解析和不再使用的 `withHostCommandExecution` 导入。
- 门禁：还清方向边 26 条（slash-commands 21 条，含 `build-options`、`plugin-tool-ipc` 两条；boot 5 条），最大 lib 环 166 → 165。模块数 139 → 140，附例外记录 `2026-11-08-slash-commands-module.json`。
- 既有失败（未改，不属本次）：`lib/slash-commands/actions/lark.test.ts` 1 例（`opts.transport is not a function`，把新 manifest 移开后照样失败）；`lib/squads/durable/durable-dispatch.test.ts`、`lib/squads/legacy-run-history.test.ts` 共 6 例，是多智能体那条线 P4 的控制机改动。

## 19. T12 实施记录：终端坞工具与 terminal 模块（2026-11-08）

- `terminal` 从模块行变成 manifest 模块（`lib/terminal/module.ts`，归属表行删除）。`dependsOn`：agent-ecosystem、chat、companion、device、file-viewer、memory、plugin、twin、vscode-compat、workflow、workspace；`api` 为其他模块在用的 34 个文件（会话与登记表、坞运行器 `run-in-dock`/`run-cognia`/`script-runner`、SSH 配置与连接、shell 检测、补全、`dock-tool-handler`（终端启动初始化器预热导入）、两个 hook 和 terminal store）。companion、workspace、agent-ecosystem、device、file-viewer、vscode-compat、workflow 的行补了终端用到的 `api` 文件。
- 提示词：`completion.terminal`、`developer.ai-shell.plan`、`developer.ai-shell.error-advisor` 作为模块的 `prompts` 贡献（`lib/terminal/prompts.ts`），`lib/prompts/catalog.ts` 不再导入。
- 拆环：artifact 依赖 terminal（坞新标签页的终端按钮），tasks 依赖 artifact，而 AI shell 计划视图从 tasks 取状态图标，声明后成环。`TaskStatusIcon` 移到基础层 `components/shared/task-status-icon.tsx`（测试随移），只以 `import type` 读 `TaskViewStatus`（方向检查不计纯类型导入）；计划视图用 `TaskStatusIconProps["status"]` 取状态类型，不再导入 tasks。五个使用者改导入路径，tasks 的 `api` 去掉该文件。
- 工具族：`lib/terminal/agent-tools.ts`。`surface`：`settings.terminal.exposeDockToAgents` 为 true、代理未关闭插件工具（原来整个清单在 `disablePluginTools` 闸内）、且不是无头宿主上的 scratch 工作区会话（原来在 scratch 里被过滤并按名拒绝）时提供四个条目；`run` 校验动作名后调用 `runTerminalDockAction`，处理器每次调用仍重读开关。schema 文件 `git mv` 到 `lib/terminal/dock-tool-schemas.ts`，删掉旧插件 id `cognia:builtin:terminal-dock`（条目改以 `cognia-terminal-builtin` 传递）。
- 声明：spawn、write 为 default/write；read_recent、wait_for_exit 为 default/read；都不可取消（处理器不接收取消信号）。探针名单里手写的 spawn/write 删除（由 `effect !== "read"` 派生；两个读取和原来一样由发现式拒绝覆盖，因为模块条目也在解析后的 `pluginTools` 里）。实时语音的 `terminal_dock_` 前缀排除删除（由 `cancellable: false` 派生）。
- 删除：`sidecar-tools-bridge` 的 `buildTerminalDockManifestEntries` 和 `exposeDockToAgents` 选项、`build-options` 的开关读取、`plugin-tool-ipc` 的前缀分支。顺序变化：坞条目原在插件条目之后、`ask_user` 之前，现在随模块工具追加在清单末尾；语义裁剪原本作用于整份插件清单，模块工具不经过它。
- 门禁：还清方向边 2 条（`plugin-tool-ipc -> terminal`、`prompts/catalog -> terminal`），尺寸度量没有增长，不需要例外记录。`packages/plugin-contract` 里 `exposeDockToAgents` 注释仍提到旧函数名，未改（改动会使作者工具包锁失效）。

## 20. T13 实施记录：workflowNodes 贡献、workflow 模块与 typed runner（2026-11-08）

- 起因：工具贡献只能由 manifest 模块提供，而如实声明 workflow 的依赖（35 个模块）会经由 10 个反向依赖 workflow 的 manifest 模块（artifact、eval、goal、knowledge-base、pet、sites、slash-commands、squads、templates、terminal）形成 11 个模块的 G6 环。用户选择先做节点贡献机制，再反转零散的边。
- W1 机制（2d3b8d9383）：`ModuleManifest.workflowNodes = { load }`，被加载的文件在导入时经 `registerNodeExecutor` 注册执行器并导出 `workflowNodeKinds`。生成器写 `lib/modules/generated/workflow-nodes.ts`（`MODULE_WORKFLOW_NODES`），manifest 校验覆盖该字段。加载器 `lib/workflow/nodes/module-nodes.ts`：按模块记忆化、并发调用共用一次加载、跳过 experimental、导入后核对声明的 kind 是否都已注册（缺失记错误日志）、失败的模块下次再试且不影响其他模块。`built-ins/index.ts` 在引擎导入时启动加载，`step-executor.ts` 的 `runStep` 在 `getExecutor` 之前等待它；`executor-coverage.test.ts` 先等待加载器再做覆盖检查。
- W2 节点族迁入各模块（b26d0cd298）：`git mv` 七个节点族及其测试——terminal → `lib/terminal/workflow-nodes/{dock,session,script}.ts`（入口 `index.ts` 汇总 8 个 kind），artifacts、goals（20 个 kind）、sites、knowledge、evaluation（`eval.run`、`eval.gate`）、automation/pet → `lib/<module>/workflow-nodes.ts`。每个入口导出 `workflowNodeKinds`，测试断言声明与实际注册一致；七个 manifest 加 `workflowNodes`，artifact、pet、sites 的 `dependsOn` 加 `workflow`。运行结束时的资源释放改为登记式：`lib/workflow/runtime/run-resources.ts` 的 `registerRunResourceReleaser`，terminal 的会话节点登记 `closeRunSessions`，编排器不再导入 terminal。
- W3 反转零散的边（同一提交）：
  - knowledge-base：新端口 `knowledge-base-revisions`（`assertBindings`、`resolveCurrentBindings`，契约 `types/modules/ports/knowledge-base-revisions.ts`，提供方 `lib/knowledge-base/ports/revisions.ts`）；`execution-authority.ts` 和 `lib/db/workflow-apps.ts` 经 `lib/workflow/runtime/knowledge-revisions.ts` 使用，没有提供方而需要检查绑定时抛错，不静默跳过。`knowledge/access.ts` 的类型改从 plugin-contract 取。
  - pet：`runtime/pet-event-trigger.ts` 移到 `lib/pet/workflow-trigger.ts`（列入 pet 的 `api`），两个启动方改导入。
  - artifact：`ARTIFACT_TYPES` 移到 `types/artifact/artifact-types.ts`，`lib/artifacts/constants.ts` 重新导出。
  - templates：`authoring.ts`、`portable-bundle.ts`、`types/workflow/portable-bundle.ts` 的契约改从 `@cognia/plugin-contract/lib/templates/contracts` 导入；`lib/templates/{catalog,repository}.` 路径覆盖归 `db`。
  - eval：`lib/ai/eval/artifact-crypto.` 路径覆盖归 `credentials`（四条 foundation → eval 边变成 foundation → credentials，净数下降，增长检查通过）。
  - slash-commands：`lib/slash-commands/actions/workflow.ts` 移到 `lib/workflow/editor/copilot-slash-commands.ts`；slash 的 `prompts` 贡献随之删除（`lib/slash-commands/prompts.ts` 及测试），prompt id 不变。
- W4 workflow 成为 manifest 模块（同一提交）：`lib/workflow/module.ts`，`owns` `app/portal/` 和 `lib/db/workflow-{apps,conversations,stats}.ts`，`dependsOn` 26 个模块，`api` 43 个文件，`requires: ["ocr", "knowledge-base-revisions?"]`，`prompts` 为新文件 `lib/workflow/prompts.ts`（AI 节点提示、Copilot 提示与快捷动作、slash 工作流提示），`lib/prompts/catalog.ts` 不再导入 workflow。归属表删除 workflow 行，十余个被 workflow 导入的行补了 `api`。
- W5 runner 与 Copilot（ab256d1686）：
  - `ToolSurfaceContext.skills`：本次运行已解析的技能（`id`、`kind`），build-options 传给 `collectContributedTools`。
  - 工具族 `lib/workflow/agent-tools.ts`：有 `kind: "workflow"` 技能或处于 `ultracode` 档、且代理未关闭插件工具时提供 `wf_run_workflow_typed`（描述与 schema 取自 plugin-contract 的 `WORKFLOW_RUNNER_TOOL_DEFINITION`），`run` 懒加载 `executeRunWorkflowTyped`。声明 `default`/`write`、不可取消、`precedence: "fallback"`：插件 `cognia-workflow-ai` 启用时它的注册先应答，清单按名字去重保留插件条目；插件缺席时条目以 `cognia-workflow-builtin` 传递。实时语音名单里手写的 `wf_run_workflow_typed` 删除（由 `cancellable: false` 派生）。
  - build-options 删掉两段 runner 追加（技能和 ultracode），ultracode 档"重新挂回插件自己的 `wf_*` 条目"保留，`WORKFLOW_AI_PLUGIN_ID` 改从 plugin-contract 取；plugin-tool-ipc 删掉 runner 回退分支，由模块的 fallback 分支接手。
  - Copilot：新端口 `workflow-editor-session`（契约 `types/modules/ports/workflow-editor-session.ts`，`prepare(sessionId)` 返回身份提示、打开图的快照、允许/禁止工具名单和可读目录），workflow 以 `lib/workflow/ports/editor-session.ts` 提供，`buildWorkflowSnapshotBlock` 一并搬入。build-options 的 workflow-editor 分支保留子代理注册、`forwardSubagentText` 和删除 `mcpServers`，其余应用端口返回值；没有提供方时保持原提示并记警告。
- 门禁：还清方向边 `build-options -> workflow`、`plugin-tool-ipc -> workflow`，此前还清 `catalog -> workflow`、`hooks/use-template-catalog -> templates`、`work-submission -> eval`；没有尺寸度量增长，不需要例外记录。`lib/execution/control-handlers.ts -> best-of-n` 是其他会话的新边，每次写基线后剔除。
- 既有失败（在 HEAD 上同样失败，非本次引入）：`lib/workflow/nodes/built-ins/index.test.ts` 18 例，`lib/eval/workflow-nodes.test.ts` "gates a run against param thresholds"，`lib/db/workflow-apps.test.ts` "freezes an app-selected Knowledge Base revision override"。
- 未做：桌面冒烟（运行一个含终端/目标/知识库节点的工作流、带图体技能的对话调用 runner、编辑器 Copilot 会话）。

## 21. T14 实施记录：connectors 成为 manifest 模块与 conversation-channel 端口（2026-11-08）

- 起因：用户要求还清 `plugin-tool-ipc -> connectors`（ask_user 的 IM 分支），并要求架构统一。根因有三：内核的人机交互原语放在 `lib/connectors/hitl/`；connectors 只是归属表的一行，不能 `provides` 端口，而声明 manifest 会形成 12 个模块的 G6 环；"会话绑定在哪个渠道、渠道允许什么、谁来回答"没有统一接口。按四步实施，每步单独过门禁。
- 第 1 步 HITL 原语归内核（b1996d647f）：`approval-registry`、`callback-prefixes` 及测试 `git mv` 到 `lib/claude/hitl/`，约 50 个导入方直接改路径，不留转发文件。speech 不再依赖 connectors。还清 4 条方向边。
- 第 2 步 connectors 成为 manifest 模块（拆环）：
  - 免打扰合并（3840c1aa96）：`outbound-runner` 里的副本删除，所有调用方改用 `lib/notifications/policy/quiet-hours.ts`；新增 `isInQuietRange`、`msUntilQuietRangeEnd` 两个区间形式。比对测试向量时发现内核实现的 DST 缺陷（夏令时开始那一夜的释放时间算到次日），`nextWallClockInstant` 改为按日历日步进，附 patch changeset。还清 `notifications/routing -> connectors`。
  - 回合活动追踪器及 diff 移到 `lib/claude/turn-activity/`，`types/execution/turn-activity-diff.ts` 承接类型；`circuit-breaker` 转发文件删除，6 个使用方直接导入 plugin-contract（2a733cd8d7）。
  - 宠物改订阅保留 topic `connectors.inbound`（`{ seq, at }`，`types/connectors/events.ts`），bus 在入站观察者通知时发布，序号为模块级（21de7178be）。
  - lark-cli 传输（`exec-lark-cli`、`acting-identity`、`auth-bridge`、`process`）移到飞书认证层 `lib/auth-providers/feishu/cli/`，twin 不再依赖 connectors（4a20bea17b）。计划中"整文件移到 lark-docs"改为此做法：被 twin 导入的是传输层，不是文档抓取。
  - manifest（9302d36fad）：`lib/connectors/module.ts`，`owns` `app/lark/`、五个连接器数据文件、`lib/skills/built-in/{im,lark}/`；`dependsOn` 21 个模块；`api` 58 个文件；`requires: ["ocr", "speech"]`；`provides` `conversation-channel`；`prompts` 为 `lib/connectors/prompts.ts`（`CONNECTOR_CAPABILITY_PROMPTS`，`lib/prompts/catalog.ts` 不再导入）；`workflowNodes` 为 `lib/connectors/workflow-nodes.ts`（6 个 `action.connector.*` kind，原 `lib/workflow/nodes/connectors/`）。归属表删除 connectors 行及其路径覆盖，十余个被 connectors 导入的行补了 `api`。
  - 端口首批方法：`claimsBinding`、`hostCapabilities`、`waitForAutomation`、`listSiblingConversations`、`postText`、`appendAudit`。goal 的目标驱动闸门、workflow 的三处自动化等待（准入、封存启动、恢复）、squads 的 `team_post_to_chat` 默认依赖都改走端口；pet、twin、goal、squads、workflow 的 `dependsOn` 去掉 connectors。`TeamToolDeps.appendAuditEntry.conversationKey` 改为必填。测试里不合法的会话键改为真实格式。
- 第 3 步 ask_user 与技能确认（ef03cd2159）：端口加 `askUser`（不属于本渠道的会话返回 `null`）和 `confirmSkill`。读取方加 `askUserInConversation`，按模块顺序询问，第一个应答者胜出。connectors 成员用自己的 `im-elicitation-context` 调 `runImAskUser`；技能确认卡片的投递逻辑从 dispatcher 原样搬到 `lib/connectors/hitl/skill-confirmation.ts`。`run-and-capture` 的 IM 归因移到 `lib/connectors/hitl/permission-attribution.ts`，由连接器运行时的权限应答者在返回前标注（摘要轮的登记没有 runId，原来就不归因）；内核只采用应答者给出的 `attribution`。还清 `plugin-tool-ipc -> connectors`、`run-and-capture -> connectors`。
- 第 4 步 build-options（f421dc89e7）：端口加 `capabilityPrompt`、`channelCapabilities`。build-options 对 IM 绑定会话取一次渠道：宿主能力（computer use、OCR、调度工具共用一次结果）、能力提示（缓存逻辑保留，渠道尚未学到能力矩阵时返回 `null`、不缓存）、清单的渠道能力与指纹都来自渠道；没有渠道认领的 IM 绑定什么也不给，清单的渠道能力为空列表。`adapterAllowsBuiltInSkill`、`resolveRequireHitlForWrites`、`matchesSkillSelector` 移到技能框架 `lib/skills/built-in/channel-ceiling.ts`（清单构建是同步的，不适合走异步端口，且读的是内核数据行）；调度工具名移到 `lib/scheduler/agent-tool-names.ts`，测试核对 MCP 服务端确实注册了它们，build-options 不再重新导出。还清 `dispatcher -> connectors`。计划中的单一 `runPolicy` 改为三个窄方法：build-options 的缓存键和闸门顺序原样保留更安全。
- 门禁：共还清方向边 12 条，尺寸度量没有增长，不需要例外记录。每次写基线后剔除其他会话的 `lib/chat/... -> chat:ui` 行。
- 仍留：`build-options`、`skills/built-in/manifest.ts`、`skills/built-in/index.ts -> connectors` 来自内置技能族的注册和 Lark CLI 能力探测，已在 §22 还清；`plugin/api/workflow-author-api.ts` 的工作流审批卡片见 §23。
- 既有失败（在本轨道开始前的提交上同样失败）：`lib/skills/built-in/context.test.ts` 4 例、`lark/doc.test.ts` 1 例、`lark/capabilities.integration.test.ts` 5 例、`im/resolve-contact.test.ts` 1 例、`lib/claude/build-options-cache-opt.test.ts` 7 例，以及 T13 记录的工作流用例。
- 未做：桌面冒烟（飞书机器人上的 ask_user 卡片、工具审批与归因、技能确认卡片、免打扰时段、目标驱动闸门、IM 触发的工作流、computer use / 调度工具的会话开关）。

## 22. builtinSkills 贡献：内置技能族归属各模块（2026-11-08）

- 起因：T14 之后发送路径上最后的 connectors 边来自内置技能族的注册（`lib/skills/built-in/index.ts` 直接导入 `./lark`、`./im`）和 Lark CLI 能力探测（`manifest.ts`、`build-options` 直接导入 `lark/capabilities`）。这两者对没有 IM 绑定的桌面会话也生效，不适合放进 `conversation-channel` 端口。ADR-0250 §14 早已预留 `builtinSkills` 贡献字段，本次实现它。
- 契约：`ModuleManifest.builtinSkills = { load }`。被加载的文件在导入时注册技能族，可选导出 `register()`（需要再加载代码的技能族），导出 `builtInSkillFamilies`，可选导出 `availability`。闸门类型 `BuiltInSkillAvailability`（`lib/skills/built-in/types.ts`）：`governs`、不阻塞的 `isAvailable`（尚未探测时在后台启动探测并按"不可用"作答，与原行为一致），`settle(scope)` 等待该范围清单所依赖的信息并返回缓存键，范围内无可提供技能时返回 `null`。
- 门禁：`module-manifests.mjs` 校验 `builtinSkills` 只有懒加载的 `load`，生成 `lib/modules/generated/builtin-skills.ts`（`MODULE_BUILTIN_SKILLS`），G5 覆盖；`check-modules.test.mjs` 加两例。
- 加载器 `lib/skills/built-in/module-skills.ts`：按模块记忆化、并发共用一次加载、跳过 experimental、等待 `register`、声明的族没有任何技能时记错误日志、失败的模块下次重试；`isBuiltInSkillAvailable`、`builtInSkillAvailabilityGates`、`builtInSkillAvailabilityKey`（各闸门 settle 的结果拼成键，settle 抛错记日志并记为 failed）。
- 索引：`lib/skills/built-in/index.ts` 去掉 `./lark`、`./im`，导入时 `void loadModuleBuiltInSkills()`，新增 `whenBuiltInSkillsRegistered()`。读取方都先等待它：build-options（清单缓存未命中时）、plugin-tool-ipc 的名字查找、`/lark`、插件 `skills.invokeBuiltIn`（`listBuiltIns` 是同步的插件契约，不能改，依赖索引导入时已启动加载）、IM 权限上限、连接器运行时在缓存适配器技能摘要之前、设置页 Lark 标签。
- 使用：`manifest.ts` 的清单与能力摘要改用 `isBuiltInSkillAvailable`；build-options 的缓存键改为 `builtInSkillAvailabilityKey`（仅 `builtInSkillsRequested` 时，范围为绑定的平台或桌面），不再导入 lark-cli 探测。
- 贡献者 connectors：`lib/connectors/builtin-skills.ts` 导入 `im` 族，经厂商接缝 `ConnectorVendorContribution.builtInSkills`（`families` 常量 + 懒加载的 `load`）在 `register` 中加载各厂商的技能族，并把各厂商闸门合成一个闸门（框架文件不点名厂商，G8 通过）。Lark：`lib/connectors/adapters/lark/builtin-skills.ts` 导入六个族并给出 lark-cli 闸门（原 manifest/build-options 里的逻辑原样搬入），`larkContribution.builtInSkills` 声明六个族名。issues、scheduler、插件转换三个内核技能族仍直接导入（issues 还没有 manifest，`index.ts -> issues` 保留）。
- 测试：新加载器、connectors 合成闸门（伪造厂商目录）、Lark 闸门与族注册各有测试；`manifest.test.ts` 的 Lark 闸门用例改为通过加载器注入的伪闸门，不再依赖 lark-cli 模块。
- 门禁结果：还清方向边 3 条（`build-options`、`skills/built-in/index.ts`、`skills/built-in/manifest.ts` 指向 connectors），尺寸度量没有增长。
- 既有失败（HEAD 上同样失败）：`context.test.ts` 4 例、`lark/doc.test.ts` 1 例、`lark/capabilities.integration.test.ts` 5 例、`im/resolve-contact.test.ts` 1 例、`build-options-cache-opt.test.ts` 7 例、`slash-commands/actions/lark.test.ts` 1 例（"refuses a non-owner…"，在 HEAD 的工作树中确认）。
- 未做：桌面冒烟（桌面会话与飞书会话里 Lark 技能的出现与 lark-cli 不可用时的隐藏、设置页 Lark 标签）。

## 23. 工作流审批卡片走 conversation-channel 端口（2026-11-08）

- 起因：§21 之后 `lib/plugin/api/workflow-author-api.ts` 仍直接导入 connectors：插件的 `prepareWorkflowApproval`（运行前审批，挂起派发）和 `prepareFanoutApproval`（扇出订阅审批）自己解析 IM 实时投递目标、构建卡片并经 delivery-gateway 发出，`recordCallbackBinding` 直接写连接器的回调绑定表。
- 端口：`ConversationChannel` 加三个方法，形状与 `confirmSkill` 一致。
  - `approveWorkflowRun({ workflowId, runParams?, triggeredFrom })`、`approveWorkflowFanout({ workflowId, workflowName, triggeredFrom, actorScope })`：返回 `{ surfaceId, workflowName, surface }`，卡片无法送达时抛错。`triggeredFrom` 是调用方已经与会话核对过的 IM 来源（`ConversationWorkflowOrigin`）。
  - `recordCallbackBinding(binding)`：为本渠道服务的会话登记插件卡片的一个选项；没有会话键时按适配器判断；不属于本渠道时返回 `false`。读取方加 `recordConversationCallbackBinding`，按模块顺序询问，第一个登记成功的渠道胜出。
- connectors 成员：两张卡片的逻辑从 workflow-author-api 原样搬到 `lib/connectors/hitl/workflow-approval-cards.ts`（实时投递目标的解析与拒绝条件、运行审批取会话上限与会话自身上限的较窄者并交给 `holdWorkflowDispatchForApproval`、扇出卡片的两个绑定与中英文文案）。成员的 `recordCallbackBinding` 在会话键可解析或适配器存在时写入。
- workflow-author-api：保留来源核对（必须是带会话的 IM 来源，且与 Host 记录的触发来源一致），`approvalActorScope` 仍按 Host 记录的发起人计算后交给渠道；没有渠道认领时抛"delivery target is unavailable"。`recordCallbackBinding` 保留对 `skill_invoke` 的拒绝和 `wf_approve`/`wf_cancel` 的发布版本锁定，再交给渠道；没有渠道服务该绑定时抛错。行为变化：此前为不存在的适配器登记绑定会静默成功，现在拒绝。
- 纯函数构建器 `buildApprovalSurface` 从 `lib/connectors/a2ui-bridge/workflow-to-a2ui.ts` 移到内核 `lib/claude/hitl/workflow-approval-surface.ts`（与回调前缀相邻），插件 API 仍同步暴露它；不再重新导出前缀。
- 测试：卡片测试随逻辑搬到 `workflow-approval-cards.test.ts`（含真实 Lark/Telegram 序列化、起草中拒绝、上限合成），API 测试改为模拟读取方，成员与读取方测试各加用例。
- 门禁结果：还清 `lib/plugin/api/workflow-author-api.ts -> connectors`，尺寸度量没有增长。
- 未做：桌面冒烟（飞书里插件发起的工作流运行审批与扇出审批卡片、点击后的派发）。

## 24. T15：还清内核与基础层 → connectors 的剩余方向边（2026-11-08）

- 起因：§21–§23 之后，`modules-baseline.json` 里仍有 30 条从内核或基础层指向 connectors 的方向边（包括 `types/connectors/**` 的运行时值）。这些边分三类：放错位置的纯函数或展示组件；本属于渠道、可以做成 `conversation-channel` 方法的问题；本身就是 connectors 逻辑、只是放在内核目录里的文件。
- 第 1 批，放回真正的归属（d77e09caf5，还清 11 条）：
  - `parseConversationKey` 改从 plugin-contract 导入（db 的 conversation-overrides、出站策略的 outbound-targets 和 plan-delivery）；
  - `inbound-stored-parts` 移到 `lib/db/`，`inbound-labels` 移到 `lib/chat/`；
  - `readResolvedPrincipal` 移到 `lib/execution/resolved-principal.ts`；
  - `unavailable-notice` 移到 `components/platform/`；
  - `use-draft-approval` 移到 `hooks/connectors/` 并列入 api；
  - 收件箱遥测导出改用 SDK 的 `downloadBlob`。
  - 计划中把 `inbox-writes/route.ts` 移到 `lib/runtime` 的一步没有做：它依赖 `stores/remote-host`（内核），会产生一条基础层 → 内核的新边。改为由渠道的 `writeRoute` 提供（见第 2 批）。
- 第 2 批，`conversation-channel` 加方法（63985f5231，还清 7 条指向 connectors 的边，外加 `inbound-connector -> inbox` 一条）。
  - 新增方法：`injectionProtection`、`writeRoute`、`addReaction`、`removeReaction`、`deliverNotification`（返回 `ConversationNotificationOutcome`）。
  - 读取方 `sessionInjectionProtection` 读取 `imAuthorityBinding ?? platformBinding`：没有 adapterId 时返回 `undefined`；没有渠道认领时返回 `true`。ipc 的 3 处调用和外部智能体管理器改用它。
  - `lib/chat/reactions.ts`：会话绑定补全 conversationKey，镜像改走渠道；`reactionAbilityFor` 改为接收 `WritePlaneRoute`。
  - IM 通知：`lib/notifications/im-deliver.ts` 只解析记录所属的会话并交给渠道，跳过原因新增 `no-channel`；投递逻辑（会话绑定、开关、PII 闸门、卡片或文本、入队、审计）移到 `lib/connectors/notifications/im-deliver.ts`。
  - 通知动作回调移到 `lib/connectors/notifications/action-callback.ts`，并修正与实现不符的注释：审计在 handler 内完成，不是由调用方完成。
  - 入站桥移到 `lib/connectors/notifications/inbound-bridge.ts`。`notifications/install.ts` 只安装插件桥；入站桥由 connectors 的 UI effect `inbound-notification-bridge` 挂载，挂载的窗口与原来相同。
  - `lib/execution/run-resume-listeners.ts`：`control-handlers` 恢复运行后调用 `notifyAgentRunResumed`；`install-connector-runtime` 登记一个监听器，调用 `resumeDurableInboundJobs`，并在 teardown 时注销。
- 第 3 批，`taskExecutors` 贡献（0cb9660450，还清 1 条）。
  - 契约：`taskExecutors: { types, load }`。被加载的文件导出 `taskExecutors: Partial<Record<ScheduledTaskType, TaskExecutor>>`。
  - 门禁：`module-manifests.mjs` 校验 `load` 为懒加载，只允许 `load` 和 `types` 两个字段，`types` 是非空、不重复、格式为 `^[a-z][a-z0-9:-]*$` 的列表。它生成 `lib/modules/generated/task-executors.ts`；`check-modules` 检查一个类型只有一个模块拥有。
  - 加载器 `lib/scheduler/module-executors.ts`：为每个声明的类型产生一个 owner，按模块记忆化，失败后重试，跳过 experimental，声明了没提供或提供了没声明都记日志。它通过 `executor-owners.ts` 并入 `TASK_EXECUTOR_OWNERS`。
  - `im-push` 移出内置执行器表，执行器移到 `lib/connectors/scheduler/im-push-executor.ts`，贡献文件为 `lib/connectors/scheduler/task-executors.ts`。
  - 行为：im-push 不再在启动时登记，改为第一次到期时由 owner 加载。调度器的各执行路径原本就在找不到执行器时先查询 owner，所以行为不变。
  - 附带：负载编辑器里 segments 示例 JSON 的 placeholder 标注了 i18n-exempt。
  - `scheduler-db.ts` 的 `sanitizeScheduledOutboundPayload` 不在本批：清洗用到 A2UI 辅助函数，而 a2ui 是模块，需要另找办法，因此 `scheduler-db -> connectors` 保留。
- 第 4 批，`identity-principal-links` 集合端口（4d9286209b，还清 4 条）。
  - 契约 `types/modules/ports/identity-principal-links.ts`：`attachSignIn(input) → { attached, foreign }`，`unlinkSelfBound(input) → string[]`。Lark 的 `login-link.ts` 的输入输出类型改为端口类型的别名。
  - 读取方 `lib/identity/principal-links.ts`：按模块顺序询问成员并合并结果；加载失败或调用失败的成员记日志并跳过；最后再调用一次 `assertCurrent`，保证档案被切换时仍抛错。四个调用点原有的 try/catch 和 `deps` 注入不变。
  - connectors 成员 `lib/connectors/ports/identity-principal-links.ts` 遍历厂商接缝新增的 `principalLinks` 钩子；`larkContribution.principalLinks` 懒加载 `principal/login-link`。
  - 顺带修正 `lib/db/connector-types.ts` 里一处过时的路径注释。
- 第 5 批，深链路由（1780b702e1，还清 1 条）：`ConnectorDeepLinkRouter` 改为返回 null 的组件，作为 connectors 的 UI effect `deep-link-router` 挂载；`app-runtime.tsx` 去掉对它的包裹。两者原本是同一父节点下的兄弟，i18n 和 toast 上下文都可用。
- 合计还清基线 25 行：24 条指向 connectors，1 条 `inbound-connector -> inbox`。尺寸度量没有增长。
- 剩余 6 条，需要尚未存在的贡献机制：
  - `plugin/api/connectors-api`、`plugin/bridge/connectors-bridge`：等 §9 的 `pluginApi`；
  - `companion/desktop-write-source`：等配对设备写命令的贡献机制；
  - `sync/handlers/conversation-overrides`：等同步处理器的贡献机制；
  - `db/connector-inbound-jobs`：崩溃恢复仍直接续跑连接器任务，可以改用第 2 批的恢复监听器；
  - `scheduler/scheduler-db`：im-push 载荷清洗（已由 §25 还清）。
- 期间门禁里出现的外来报错：另一会话未提交的 room 工作（`lib/connectors/hitl/room-handoff-card.ts` 的 G4 端口声明，`lib/connectors/runtime.ts -> lib/squads/room-handoff/im-room.ts` 的 G3），以及 4 行 `lib/chat/... -> chat:ui` 已还清但未锁定的基线行。都不属于本轮，保持原样。
- 未做的桌面冒烟：
  - 飞书里的表情回应镜像；
  - IM 通知卡片和动作回调；
  - 入站通知；
  - 定时 IM 推送；
  - 连接器和文档提供方的 OAuth 深链回调（包括冷启动）；
  - 登录后飞书主体的自动关联，以及登出或接管后的解绑。

## 25. T16：A2UI 纯函数核心抽成 `@cognia/a2ui-core`（2026-11-08）

- 起因：§24 留下的 `scheduler-db -> connectors`。先试过用集合端口 `scheduled-payload-sanitizer`，由存储层在写入前异步加载 connectors 的清洗函数，已撤回，没有提交。
  - 撤回原因：`lib/radar/suggestions.ts` 会在自己的 Dexie 事务里调用 `schedulerDb.createTask`。端口首次加载要等一次动态 import，事务会提前提交。用 `Dexie.waitFor` 也保不住（测试报 "Transaction committed too early"）。
  - 结论：清洗必须同步完成。它只依赖 a2ui 的 JSON Pointer 读取，因此把 A2UI 中不依赖宿主的部分抽成包。
- 包 `packages/a2ui-core`（912b457ad3）：
  - 从 `lib/a2ui/` 用 `git mv` 移入 `data-model`、`computed`、`component-tree`、`parser`、`streaming-preview`、`mcp-tool-schemas`，测试随文件移动。
  - 新增 `segment-sanitize.ts`：`withoutBindingHints`、`sanitizeOutboundSegments`、`sanitizeScheduledOutboundPayload`，从 `a2ui-to-segments.ts` 原样搬入。纯清洗用例随之搬到 `segment-sanitize.test.ts`，依赖 `buildA2UISegment` 的集成用例留在 connectors。
  - `index.ts` 汇总导出所有文件，宿主代码一律按文件导入 `@cognia/a2ui-core/<文件>`。
  - 注册方式与 `feishu-protocol` 相同：
    - `tsconfig.json`、`cli/tsconfig.json` 加路径别名；
    - `jest.config.ts` 加 `moduleNameMapper`；
    - `pnpm-workspace.yaml` 排除它，避免新增锁文件 importer、使授权工具包 pin 失效；
    - 列入 `check-package-boundaries` 的 `HOST_INDEPENDENT_PACKAGES`。
- 导入改写：用脚本把能解析到被移走文件的导入说明符改为包路径，共 101 个文件，`jest.mock` 路径也一并改写。相对导入只改真正指向 `lib/a2ui/` 的那些，例如 `lib/subscription/anthropic/parser` 没有被误改。
  - `lib/a2ui/index.ts` 的转出改为从包导入。
  - a2ui 的 `api` 列表去掉已移走的 4 个文件。
  - 宿主代码、sidecar 注释和 18 篇文档中的旧路径同步更新。`packages/plugin-contract` 的注释不改。
- 附带：pre-commit 的 i18n 检查扫描整个暂存文件，所以把 `a2ui-interactive-guide.tsx` 原有的两处硬编码文案（"No steps defined"、"Optional"）接入已有的 `learning.guide` 命名空间（新增 `noSteps`、`optional` 两个键，中英文都有），测试的 next-intl 模拟同步更新。
- 门禁结果：
  - 还清方向边 4 条：`scheduler-db -> connectors`、`claude/adapter -> a2ui`、`claude/run-and-capture -> a2ui`、`claude/builtin-mcp/resolve -> a2ui`。尺寸度量没有增长。
  - package-boundaries 通过（22 个包）。
  - 全量类型检查只有已知的外来错误。
  - Jest 236 个套件中 234 个通过。另外 2 个失败来自别人的改动：`a2ui-fallback.test.tsx` 受无边框 Alert 改动影响；`protocol-adapter-spec.parity.test.ts` 因为新增了 `chatgpt-siwc` provider 族。
- 剩余指向 a2ui 的内核边：
  - `build-options`、`prompts/catalog`：A2UI 协议提示词、生成提示词、执行增强提示词，以及 A2UI 系统提示词段，应作为 a2ui 自己的 `prompts` / `context` 贡献。前提是 a2ui 先成为 manifest 模块，并确定该段相对连接器能力提示词的位置（目前由 build-options 按"A2UI 段在前、能力段在后"拼接）。
  - `plugin/api/agent-turn`、`plugin/bridge/a2ui-bridge`、`plugin/core/context`：等 `pluginApi`。
