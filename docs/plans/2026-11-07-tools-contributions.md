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
