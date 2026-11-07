# 上下文贡献（ADR-0250 §14 `context`）契约草案

状态：评审通过（2026-11-07），结论见 §6；C0、C1、C2 已实施，记录见 §7–§9。创建：2026-11-07（Asia/Shanghai）。

上游：

- [ADR-0250](../content/docs/en/adr/0250-the-runtime-is-a-headless-kernel-the-desktop-embeds.md) §14：模块经 manifest 贡献 host 能力；工具贡献修订里明确「随工具族一起走的每轮上下文（协调者项目状态、知识检索）不属于工具贡献」。
- [工具贡献](./2026-11-07-tools-contributions.md) §3 Q2、§9、§15：协调者状态段、Agent Builder 草稿段、知识库都卡在这里。
- [能力授予贡献](./2026-11-07-capability-contributions.md)：目标段已经作为授予的 `instructions` 迁出（`lib/goal/context-injector.ts`），本契约不重做。
- 证据：本文 §1 的逐处核对，取自 `dev` 的 `ff2552c698`。

## 1. 现状

### 1.1 `resolveSendOptions` 里的上下文段

| #   | 段落                       | 生产者（模块）                                          | 每轮变？ | 放置（缓存优化开 / 关）                 | 输入                                                                      | 旁路输出                           | 方向边                                   |
| --- | -------------------------- | ------------------------------------------------------- | -------- | --------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------- |
| 1   | 数字分身检索 + 风格样例    | `twin` `applyTwinContext`                               | 是       | 尾部 / **替换** `baseSystem`            | `twinDeps`、`twinUserMessage`、查询向量                                   | `opts.twinContext`（消息上的来源） | `-> twin`                                |
| 2   | 长期记忆召回               | `memory` `applyMemoryContext`                           | 是       | 尾部 / `systemPrompt` 的 memory 位      | `memoryDeps`、`memoryUserMessage`、查询向量、**分身已取回的块（去重）**   | `opts.memoryContext`、个人召回预算 | `-> memory`                              |
| 3   | 项目连续性                 | `memory`（`@cognia/memory` 的 project-continuity）      | 是       | 尾部 / continuity 位                    | 同上 + 召回闸、分支、路径                                                 | `opts.projectContinuityContext`    | `-> memory`                              |
| 4   | 项目知识库                 | `project-knowledge` `applyProjectContext`               | 是       | 尾部 / projectKnowledge 位              | `projectKnowledgeDeps`、查询文本、项目文件                                | `opts.projectKnowledgeContext`     | `-> project-knowledge`                   |
| 5   | Agent 知识库               | `knowledge-base` `applyAgentKnowledgeContextFromDb`     | 是       | 尾部 / agentKnowledge 位                | 绑定的库 id（角色 + 授予增量 − 工作流访问限制）、阅读设置、访问授权、查询 | `opts.agentKnowledgeContext`       | `-> knowledge-base`                      |
| 6   | 协调者项目状态             | `project-coordinator` `resolveCoordinatorTurnSection`   | 是       | 尾部（两种模式都是）                    | 会话、活动项目                                                            | 无                                 | `-> project-coordinator`                 |
| 7   | 项目目标段                 | `project-coordinator` `buildProjectGoalSection`         | 否       | `systemPrompt` 中段（instruction 之后） | 活动项目                                                                  | 无                                 | 同上                                     |
| 8   | Agent Builder 草稿         | 内核 `lib/agents/builder/send-extras`（T8 后）          | 是       | 尾部                                    | 会话、目录（Dexie）                                                       | 无                                 | 无（内核→内核），但挡住 builder 整体搬迁 |
| 9   | 执行中的计划               | 内核 `lib/agent/plan/context-injector`                  | 按步变   | `appendSystemPrompt` 末尾（尾部之前）   | `ctx.activePlan`、Prompt Center 快照                                      | 无                                 | 无（内核）                               |
| 10  | 知识库阅读器注册（副作用） | `knowledge-base` `registerKnowledgeReaderForSession` 等 | —        | 不进提示；解析时登记到每会话注册表      | 同 #5 的库 id、访问、阅读设置、检索依赖                                   | 供 `knowledge_*` 工具调用时读      | 同 #5                                    |

尾部：`dynamicTailSections`，最后拼到 `appendSystemPrompt` 末尾并单独放进 `opts.dynamicSystemPrompt`，sidecar 据此切分可缓存前缀（`appendStableSection` 的注释）。缓存优化默认开（`cacheOptimizationEnabled !== false`）；关掉时检索段回到 `systemPrompt` 的固定位置，顺序为 base → persona → harness → instruction → 工作区 → 项目目标 → memory → continuity → projectKnowledge → agentKnowledge → mode → skill → pluginSkill。

### 1.2 共同形状

每段都是同一个模式：一个开关判断 → 动态导入模块的 runtime → 取一段文字 → 按缓存开关二选一放置 → 可选地把「来源 / 预算」写到 `SendOptions` 的一个专用字段 → 失败只记日志、不拦这一轮。和工具族一样，开关、放置、旁路字段、失败处理散在 `build-options` 里，每加一个就多一个 `-> 模块` 边。

### 1.3 难点

- **替换而不是追加**：分身在缓存优化关时替换 `baseSystem`，并抑制 persona 段。它不是「一段上下文」，是身份。
- **段与段的依赖**：记忆召回用分身已取回的块去重（`opts.twinContext.retrievedChunks`）。
- **宿主注入的依赖**：`twinDeps`、`memoryDeps`、`projectKnowledgeDeps` 由调用方（`hooks/chat/claude-chat-send-options.ts`、`lib/ai/agent/agent-executor.ts`）按宿主构建（向量后端、嵌入器），`build-options` 只是透传。
- **知识库的状态**：库 id 由角色、授予增量、工作流访问策略共同算出；同一个结果既用于检索段，又登记给 `knowledge_*` 工具在调用时用（#10）。工具调用时拿不到解析时的工作流访问上下文，所以今天靠解析时的副作用登记。
- **旁路输出的消费者**：`hooks/chat/claude-chat-events.ts`、`lib/chat/room/runner.ts` 按字段名读这些上下文，把来源并进助手消息。

## 2. 契约草案

### 2.1 manifest

```ts
// lib/project-coordinator/module.ts
context: { load: () => import("./context") },
```

`load` 指向的文件导出 `contributions: readonly ContextContribution[]`：

```ts
interface ContextContribution {
  /** 模块内唯一；旁路输出以 `<module>.<id>` 为键。 */
  id: string
  /** "turn"：每轮变，进动态尾部；"session"：会话内稳定，进可缓存前缀。 */
  cache: "turn" | "session"
  /** 缓存优化关时（或 "session" 段）在 systemPrompt 里的位置，取自封闭列表（§2.3）。 */
  slot: ContextSlot
  /** 文字的 PII 处理（§3 Q2）。 */
  pii?: "gate" | "redacted-at-source"
  produce(ctx: ContextTurnContext): Promise<ContextSection | null> | ContextSection | null
}

interface ContextTurnContext extends ToolSurfaceContext {
  /** 本轮的检索查询：文字与（若调用方已算好）向量。 */
  query: { text: string | null; embedding: readonly number[] | null }
  /** 调用方注入的宿主依赖，按名取（§3 Q4）。 */
  hostDeps: Readonly<Partial<ContextHostDepsMap>>
  /** 本轮已折叠的能力授予（知识库增量等）与工作流访问策略。 */
  grant: Readonly<AgentCapabilityGrantV1> | null
  knowledgeAccess: Readonly<KnowledgeReadingAccess> | null
}

interface ContextSection {
  text: string
  /** UI 用的来源 / 预算，类型由 `ContextSourcesMap` 按 `<module>.<id>` 合并声明（§3 Q3）。 */
  sources?: unknown
  /** 解析时要留给本模块工具在调用时读的会话状态（§2.4）。 */
  sessionState?: unknown
}
```

### 2.2 内核做什么

- **收集**：所有活跃模块的贡献并发 `produce`，共用一个截止时间（同工具贡献，2 s；检索类可单独放宽，见 §5 C0）。
- **失败**：抛错、超时、返回非字符串文字的段被跳过并上报；上下文只做加法，任何失败都不拦这一轮。
- **PII**：见 §3 Q2。
- **放置**：`"turn"` 段在缓存优化开时按模块 id + 贡献 id 的稳定顺序进动态尾部，关时进 `slot`；`"session"` 段总是进 `slot`。同一 `slot` 内按模块 id 排序。
- **旁路输出**：`sources` 放进 `opts.contextSources["<module>.<id>"]`，消费者按键读（§3 Q3）。
- **工作流编辑会话**照旧不拼尾部（`session.kind === "workflow-editor"`）。

### 2.3 `ContextSlot` 封闭列表

照今天 `systemPrompt` 的顺序，只收上下文性质的位置：`"project-goal"`、`"memory"`、`"continuity"`、`"project-knowledge"`、`"agent-knowledge"`。缓存优化关时，迁移后的提示与迁移前逐字节相同。新增位置要改内核的列表和顺序，门禁拒绝未知值。

### 2.4 解析时的会话状态（知识库阅读器）

贡献可以在 `ContextSection.sessionState` 里交回「本轮解析出的访问范围」。内核把它存进按 `(sessionId, "<module>.<id>")` 键的注册表，每次解析整体替换，会话删除时清掉；同一模块的工具族在 `run` 里通过 `ToolCallContext.sessionState(id)` 读。这替代今天 `registerKnowledgeReaderForSession` / `registerKnowledgeAccessForSession` 的直接调用，副作用归内核，模块只交数据。

### 2.5 暂不覆盖

- **分身**（#1）：它替换身份段、抑制 persona，不是追加的上下文。留在内核，等「身份贡献」或单独评审。记忆的去重输入因此也暂由内核传入（记忆迁移排在分身之后，或 `ContextTurnContext` 增加只读的 `earlier` 视图，届时再议）。
- **执行中的计划**（#9）：内核自有（`lib/agent/plan`），没有模块边，不动。
- **目标段**：已是能力授予的 `instructions`。

## 3. 待评审的决定

**Q1 放置。** 推荐：贡献声明 `cache`（turn / session）和 `slot`（封闭列表），内核负责放置，缓存优化关时也与今天逐字节一致。替代：只声明 turn / session，内核按模块 id 追加——更简单，但缓存优化关时段落顺序会变，需要接受一次提示变化。

**Q2 PII 闸。** 推荐：内核对每段 `hasNoLeakingPiiDeep`，不过则丢弃并上报；文字来自已脱敏存储的贡献声明 `pii: "redacted-at-source"` 跳过（分身的 `contentRedacted`、记忆）。今天各 runtime 自己在检索时闸过，预期与现状一致，迁移时用对照测试确认。替代：完全由模块负责，内核不闸——改动小，但「每个外发调用都过 PII 闸」只靠约定维持。

**Q3 旁路输出。** 推荐：`opts.contextSources` 一个按 `<module>.<id>` 键的映射，类型用 `ContextSourcesMap` 声明合并（同 `TopicMap`）；每迁一个生产者，就把它的消费者（`claude-chat-events.ts`、`room/runner.ts`）改成按键读，并删掉 `SendOptions` 上对应的专用字段。替代：保留专用字段，贡献返回「写哪个字段」——不用改消费者，但 `SendOptions` 继续随模块增长，内核仍要认识每个模块的类型。

**Q4 宿主依赖与查询。** 推荐：v1 不动调用方：`twinDeps`、`memoryDeps`、`projectKnowledgeDeps` 原样进 `ctx.hostDeps`（类型用 `ContextHostDepsMap` 合并声明），查询文字和向量进 `ctx.query`；之后再把向量后端 + 嵌入器收成一个 `retrieval` 端口。替代：现在就做 `retrieval` 端口——一步到位，但要同时改两个调用方和各宿主的构建方式，范围翻倍。

## 4. 拟写入 ADR-0250 §14 的修订（英文原文，评审后同步中文版）

> ### Amendment (2026-11-07): the `context` contribution
>
> A module that adds text to a run's system prompt contributes it through its
> manifest instead of a branch in the send path.
>
> - **Declaration.** `context.load` names a file exporting `contributions`,
>   each with an `id`, a `cache` class (`"turn"` for text that changes every
>   turn, `"session"` for text stable within a session), a `slot` from the
>   kernel's closed list, and `produce(ctx)` returning a section or `null`.
> - **Placement.** The kernel places every section: turn sections in the
>   dynamic tail when cache optimization is on and in their slot otherwise,
>   session sections in their slot. A module never writes `SendOptions`.
> - **Failure.** A contribution that throws, times out or returns malformed
>   text is left out and reported. Context only adds, so no failure refuses
>   the turn.
> - **PII.** The kernel gates every section and drops one that leaks, unless
>   the contribution declares its text redacted at the source.
> - **Side outputs.** Sources and budgets for the UI travel in
>   `contextSources`, keyed by `<module>.<id>` and typed by declaration
>   merging; a session state the module's own tools read at call time is
>   stored by the kernel, not registered by the module.
>
> Identity replacement (the twin) and the kernel's own sections (an executing
> plan) are not context contributions.

## 5. 步骤与验收（评审通过后）

| 步骤 | 内容                                                                                                                                                                                               | 还清的方向边                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| C0   | ADR-0250 修订（中英）；类型；生成器写 `lib/modules/generated/context.ts`；门禁（`slot` 合法、`id` 唯一、导出存在）；内核收集、PII、放置、`contextSources`、会话状态注册表；单测                    | 无                                                                     |
| C1   | `project-coordinator`：状态段（turn，尾部）和项目目标段（session，`project-goal` 位）改为上下文贡献；删除 `send-extras.ts` 和 `build-options` 的两处                                               | `build-options -> project-coordinator`                                 |
| C2   | `agent-builder`：草稿段改为贡献；随后把 `lib/agents/builder/**`、`components/agents/builder/**`、`hooks/agents/use-builder-tool-support.ts` 搬进模块（/agents 页面属内核 UI 层，按门禁可导入模块） | 无（内核→内核），解除 T8 的遗留                                        |
| C3   | `knowledge-base` 成为 manifest 模块：Agent 知识库段（turn，`agent-knowledge` 位）+ 阅读器会话状态 + `knowledge_*` 工具（工具贡献）；`opts.agentKnowledgeContext` → `contextSources`                | `build-options -> knowledge-base`、`plugin-tool-ipc -> knowledge-base` |
| C4   | `project-knowledge`：项目知识库段；`opts.projectKnowledgeContext` → `contextSources`                                                                                                               | `build-options -> project-knowledge`                                   |
| 之后 | 记忆与连续性（依赖分身的去重输入，§2.5）、分身（身份贡献）                                                                                                                                         | `-> memory`、`-> twin`                                                 |

验收：

- 每步迁移前后，同一组会话在缓存优化开、关两种模式下得到的 `systemPrompt`、`appendSystemPrompt`、`dynamicSystemPrompt` 逐字节相同（对照测试），旁路来源在消息上的呈现不变。
- `pnpm audit:modules` 通过，本任务相关的度量只降不升。
- 不做桌面冒烟（沿用约定），交付说明里写明。

## 6. 评审结论（2026-11-07）

1. 放置：贡献声明 `cache`（turn / session）和封闭列表里的 `slot`，内核放置；缓存优化关时与今天逐字节一致。
2. PII：内核对每段统一 `hasNoLeakingPiiDeep`，不过则丢弃并上报；来源已脱敏的贡献声明 `pii: "redacted-at-source"` 跳过。
3. 旁路输出：`opts.contextSources`，按 `<module>.<id>` 键，`ContextSourcesMap` 声明合并；每迁一个生产者就改它的消费者并删掉专用字段。
4. 宿主依赖：v1 原样透传进 `ctx.hostDeps`，查询进 `ctx.query`；`retrieval` 端口以后再做。

## 7. C0 实施记录：内核部分（2026-11-07）

- 类型（`lib/modules/manifest-types.ts`）：`ContextSlot`、`ContextHostDepsMap` / `ContextSourcesMap`（空接口，由模块从 `types/<id>/**` 合并声明）、`ContextTurnContext`（工具 surface 的上下文 + `query` + `hostDeps` + `grant`）、`ContextSection`、`ContextContribution`、`ModuleContextModule` / `ModuleContextEntry`；manifest 加 `context?: { load }`；`ToolCallContext` 加可选的 `sessionState(id)`。
- 生成器：`lib/modules/generated/context.ts`（`MODULE_CONTEXT_CONTRIBUTIONS`，每模块一个懒加载，按模块 id 排序）。门禁：`context` 字段只能是 `{ load }` 且为懒加载项，被加载的文件要导出 `contributions`；测试 3 例。
- 内核读取方 `lib/claude/context-contributions.ts`：并发 `produce`，每条贡献各自截止（默认 2 s，可声明 `deadlineMs`，上限 15 s）；PII 闸用 `hasNoLeakingPii`；放置、来源、会话状态如 §2.2；失败跳过并记日志。
- 会话状态 `lib/claude/context-session-state.ts`：每次解析整体替换；工具调用经 `runContributedTool` 注入的 `sessionState(id)` 只能读本模块的键。
- `build-options`：在拼 `systemPrompt` 之前收集；slot 段插在对应的内核段之后（`project-goal` 在协调者目标段后，`memory` 在记忆段后……），turn 段推进动态尾部（在内核检索段之后、协调者状态段和草稿段之前），`sources` 写 `opts.contextSources`，有会话时替换会话状态。`hostDeps` 的名字：`twin`、`memory`、`projectKnowledge`、`knowledgeAccess`；查询文字取 `projectKnowledgeQuery`（项目知识查询，缺省为路由提示）。
- `SendOptions.contextSources`（`packages/plugin-contract`）：改了插件契约源码，authoring kit pin 失效，需从干净检出重建（CLAUDE.md 的 §26 流程），本次不做。
- 与 §2 草案的差别（实现时定下）：
  - `slot` 可选：协调者状态段和 Agent Builder 草稿段今天在缓存优化关时也进尾部，所以没有 slot 的 turn 段总是进尾部；`session` 段必须有 slot。
  - 尾部排序：先按 slot 顺序，再放没有 slot 的，组内按模块 id 和 manifest 顺序。只按模块 id 排，等项目知识库（`project-knowledge`）和 Agent 知识库（`knowledge-base`）都迁出后，两段的顺序会按字母颠倒，提示词就不再逐字节一致。
  - 工作流的知识访问策略不单列为 `ctx.knowledgeAccess`，而是作为 `hostDeps.knowledgeAccess` 传入：它的类型属于 `knowledge-base` 模块，内核的 manifest 类型不能引用。
  - 会话删除时不单独清理：注册表只保留最近解析的 64 个会话，最久未解析的先淘汰。
  - `slot` 合法性和 `id` 唯一性由类型和读取方在加载时检查（不合格则整个模块跳过并上报），门禁只查形状和导出。
- 测试：`context-contributions.test.ts` 13 例、`context-session-state.test.ts` 4 例、`tool-contributions.test.ts` 加 1 例（只读本模块状态）、`build-options.test.ts` 加 4 例（尾部 / slot / 缓存关 / 上下文与旁路输出）。目前没有模块声明 `context`，所以运行时行为不变。

## 8. C1 实施记录：项目协调（2026-11-07）

- `lib/project-coordinator/send-extras.ts` → `context.ts`（测试同改名）：保留 `resolveCoordinatorTurnSection`（依赖接口改名 `CoordinatorStatusDeps`），导出 `contributions`：
  - `project-goal`：`cache: "session"`、`slot: "project-goal"`；协调者和线程都给（`projectRoleToolsApply`），复用 `buildProjectGoalSection`（它自己的 PII 判断保留）。
  - `status`：`cache: "turn"`、无 slot（缓存优化开关都进尾部，与原来一致）；`deadlineMs: 5_000`，因为要读线程、PR 观测和日程三处 Dexie，磁盘忙时不能丢段（setup 提议一旦记为已提出就不会再给）。
- manifest 加 `context: { load: () => import("./context") }`。
- `build-options`：删掉两处 import、`projectRoleToolsSurfaced`、`systemPrompt` 里的目标段和尾部的状态段分支；目标段由 `...contextSlot("project-goal")` 在原位置提供，状态段在收集点推入尾部（原分支与收集点之间没有别的尾部段，顺序不变）。
- 还清方向边 `lib/claude/build-options.ts -> project-coordinator`。
- 行为差别：状态段现在过内核 PII 闸（线程标题等若含泄露信息，整段丢弃并上报）；以前不检查。目标段以前就检查。
- 测试：`context.test.ts` 加 4 例（声明、目标段给谁、状态段给谁）；`build-options.test.ts` 的上下文注册表 mock 改为真实注册表 + 测试模块，新增 1 例：缓存优化开关两种情况下目标段就是整个 `systemPrompt`、状态段就是整个动态尾部。原有的协调者用例全部通过。

## 9. C2 实施记录：Agent Builder（2026-11-07）

- 草稿段：`lib/agents/builder/send-extras.ts` → `lib/agent-builder/context.ts`，导出 `contributions`：`draft`，`cache: "turn"`、无 slot（缓存优化开关都在尾部，与原来一致），`deadlineMs: 5_000`（渲染草稿要读技能、MCP 服务器、知识库三张表）。`build-options` 删掉 `agentBuilderDraftSurfaced` 和尾部分支。
- 整体搬迁（发送路径不再导入 builder 后才可能）：
  - `lib/agents/builder/{builder-session,draft-ops,runtime-tool-support,tool-deps}` → `lib/agent-builder/`（模块内改用相对导入）；
  - `components/agents/builder/*` → `components/agent-builder/`（`../agent-visuals` 改成绝对路径）；
  - `hooks/agents/use-builder-tool-support.ts` → `hooks/agent-builder/`。
- 引用方：`components/agents/agents-view.tsx`、`components/agents/create/agent-create-chooser.tsx`（及测试）改从 `@/components/agent-builder/` 导入。它们属于 `agent:ui`，按门禁是模块类，导入模块的 `api` 文件允许。
- manifest：`dependsOn` agent、chat、skills；`api` 加 setup、workspace、drafts 三个视图；`context` 指向 `./context`。chat 行补 `chat-scope-provider`、`chat-view`、`composer`、`empty-state`、`composer/model-picker`、`use-claude-chat`；agent 行补 `character-editor`、`use-agent-catalogs`、`agent-visuals`、`mode/runtime-selector`、`use-agent-runtime-catalog`；skills 行补 `use-plugin-skills`。
- 还清方向边 `lib/agents/builder/tool-deps.ts -> skills:ui`（文件搬走后，模块导入内核 UI 走 `api`，不再是方向边）。收敛清单 `lib-ui-imports` 的成员随文件改键为 `lib/agent-builder/tool-deps.ts`；顺带补上 C1 漏改的两处键（`lib-ui-imports`、`lib-store-imperative` 里的 `lib/project-coordinator/send-extras.ts` → `context.ts`）。两份清单的「metrics 不等」报错在 HEAD 上就有，不是本次造成。
- ADR-0243 的信任表里 setup 视图的路径同步改为新路径。
- 行为差别：草稿段现在过内核 PII 闸；同一份草稿经 `agent_builder_get_draft` 读出时本来就过 `assertSafePluginToolResult` 的 PII 深检。
- 测试：`context.test.ts` 加 3 例（声明、给 builder 对话、不给别的）；搬走的组件、hook、lib 测试照常通过；`build-options.test.ts` 的 builder 用例（工具、同意档、协议、草稿段）不改即通过。
