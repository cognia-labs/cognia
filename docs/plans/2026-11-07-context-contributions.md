# 上下文贡献（ADR-0250 §14 `context`）契约草案

状态：评审通过（2026-11-07），结论见 §6；C0–C4 已实施，记录见 §7–§11。§12 记忆与连续性的契约增补已评审（结论见 §12.5），C5a–C5c 已实施（§13–§15）。创建：2026-11-07（Asia/Shanghai）。

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

## 10. C3 实施记录：可复用知识库（2026-11-07）

- `knowledge-base` 从过渡表的行变成 manifest 模块（`lib/knowledge-base/module.ts`）：`dependsOn` rag、twin、workflow；`api` 列 ingest、revisions、检索、阅读器、阅读设置、会话记录六类文件。rag 行补 `generation-ingest`、`safe-embedding`，twin 行补 ingest 的 chunk、embed、ocr-fallback、parse（以前行对行不查 `api`）。
- 上下文贡献 `lib/knowledge-base/context.ts`：
  - `reader`：turn、不加文字。按 agent 绑定、能力授予的增减和调用方 `hostDeps.knowledgeAccess` 的上限算出知识库列表；渐进阅读开启且有库时建阅读器。结果作为会话状态交给内核（键 `knowledge-base.reader`）。没有库也照样返回，所以上一轮留下的更宽的记录总会被替换。
  - `retrieval`：turn、`agent-knowledge` slot、`deadlineMs: 15_000`。逐块过滤（评审选定）：`authorizeChunk` 在文档授权之外再要求块正文和文档标题都过 `hasNoLeakingPii`，泄露的块在计预算前剔除，其余照常；整段再过内核闸。块、引用、失败、预算经 `contextSources["knowledge-base.retrieval"]` 传出，类型 `AgentKnowledgeRetrievalSources` 在 `types/knowledge-base.ts` 合并进 `ContextSourcesMap`（引用和失败的类型也移到那里，原文件转导出）。`ContextHostDepsMap` 的 `projectKnowledge`、`knowledgeAccess` 在 `context.ts` 声明。
- 工具贡献：`lib/claude/knowledge-builtin-tools.ts` → `lib/knowledge-base/agent-tools.ts`（`toolFamily`）。四个工具 `consent: "default"`、`effect: "read"`（以前没有规则，走默认权限路径）。`surface` 只在 `reader` 建出阅读器时提供工具和阅读指引；`run` 从 `call.sessionState("reader")` 取阅读器。为此 `ToolSurfaceContext` 加可选的 `sessionState(id)`，`collectContributedTools` 按模块注入（只读本模块的键）；`ContextTurnContext` 不含它。探针白名单里的四个名字保留（它是显式放行的读取名单，不是由声明推导的）。
- 会话记录 `lib/knowledge-base/runtime/session-reader.ts` 改为读写内核的会话状态：`getKnowledgeAccessForSession`（防御性拷贝）、`getKnowledgeReaderForSession` 名字不变；一小时未用仍视为失效；`register*`、`clear*` 只留给测试和夹具。会话销毁的三处（`agent-executor`、`dispatch-agent-handler`、`dispatch-teammate`）改调内核新加的 `forgetContextSessionState`，一并丢掉所有模块的状态。
- `build-options` 删掉 Agent 知识库检索块、`systemPrompt` 里的 `agentKnowledgeSection`、阅读器注册块（含工具清单和指引的追加）；`knowledgeAccess` 的类型改从 `@cognia/plugin-contract` 取。`plugin-tool-ipc` 删掉知识工具分支（调用改由贡献工具路由，结果照旧过 `assertSafePluginToolResult`）。
- `contextSourcesOf` 移到 `lib/claude/context-sources.ts`，读取方不必加载贡献注册表。`SendOptions.agentKnowledgeContext` 删除；`hooks/chat/claude-chat-events.ts`、`lib/chat/room/runner.ts`、`lib/rag/chat-grounding.ts`、`lib/rag/compaction-runtime.ts` 改读 `contextSources`。插件契约源码又改了一次，authoring kit pin 仍待从干净检出重建。
- 还清方向边：`build-options`、`knowledge-builtin-tools`、`agent-executor`、`dispatch-agent-handler` 指向 knowledge-base 的四条。`dispatch-run`、`project-api` 读会话记录的两条保留（它们是 `api` 用法，迁到端口另议）。
- 行为差别：泄露 PII 的检索块被剔除（以前整段原样发送）；知识工具和指引跟其他贡献工具一起，排在 working-set 工具之前；记录在对话跌出最近 64 个时也失效。尾部顺序不变：检索段在 `agent-knowledge` 位，排在协调者状态段和草稿段之前，与原来一致。
- 测试：`context.test.ts` 9 例、`agent-tools.test.ts`、`module.test.ts` 新增；`session-reader.test.ts` 加 2 例；`context-session-state.test.ts` 加 1 例（forget）；`tool-contributions.test.ts` 加 1 例（surface 只读本模块状态）；`context-sources.test.ts` 新增；`build-options.test.ts` 改读 `contextSources` 并加一条 PII 块用例；`plugin-tool-ipc.test.ts` 的知识用例改走模块工具。`dispatch-agent-handler.test.ts` 两例后台派发的中止信号用例失败，原因在另一会话正在改的 `lib/execution/launch-child-run.ts`，与本次无关。

## 11. C4 实施记录：工作区知识库（2026-11-07）

- `project-knowledge` 从过渡表的行变成 manifest 模块（`lib/project-knowledge/module.ts`）：`dependsOn` rag、twin；`api` 列 `ingest/ingest-file`、`ingest/persist`、`runtime/build-deps`、`wire-ingest`（记忆、知识库管理界面、插件 project API、壳的 ingest 控制器和 project scope 用到的）。twin 行补 `runtime/reranker`。
- 上下文贡献 `lib/project-knowledge/context.ts`：`retrieval`，turn、`project-knowledge` slot、`deadlineMs: 15_000`。条件与原分支相同：有工作区、有知识文件、有查询、`enableProjectRag` 开、并且有检索运行时或策略为 keyword。逐块过滤沿用 C3 的选择：`applyProjectKnowledgeContext` 新增可选的 `keepChunk`，贡献传入「正文和文件名都过 `hasNoLeakingPii`」，被剔除的块既不进段落也不上报；整段再过内核闸。来源类型 `ProjectKnowledgeRetrievalSources` 在 `types/project-knowledge/index.ts` 合并进 `ContextSourcesMap`。
- `ContextHostDepsMap.projectKnowledge` 的声明从 `lib/knowledge-base/context.ts` 移到这里（键以本模块命名，两条知识贡献共用）；knowledge-base 只留 `knowledgeAccess`。
- `build-options` 删掉项目知识检索块和 `systemPrompt` 里的 `projectKnowledgeSection`，保留 `projectKnowledgeQuery`（上下文贡献的查询文字）；`projectKnowledgeDeps` / `projectKnowledgeUserMessage` 的注释改为说明它们经 `hostDeps` 和 `query` 交给贡献。`SendOptions.projectKnowledgeContext` 删除；四个读取方（`claude-chat-events`、房间 runner、`chat-grounding`、`compaction-runtime`）改读 `contextSources`，`adapter` 的 `ProjectKnowledgeSourcesContext` 结构不变。
- 还清方向边 `lib/claude/build-options.ts -> project-knowledge`。`lib/db/project-scope.ts`、`lib/plugin/api/project-api.ts` 指向它的两条保留（`api` 用法）。
- 行为差别：泄露 PII 的块被剔除（以前整段不检查就发送）。尾部顺序不变（slot 顺序里 `project-knowledge` 在 `agent-knowledge` 之前，与原来两个分支的先后一致），新增用例在缓存优化开时核对。
- 测试：`context.test.ts` 5 例、`module.test.ts` 2 例新增；`apply-project-context.test.ts` 加 1 例（`keepChunk`）；`build-options.test.ts` 改读 `contextSources` 并加 2 例（尾部顺序、PII 块）；`chat-grounding.test.ts`、`safe-send-prompt.test.ts` 改用 `contextSources`。
- 至此 `build-options` 里不再有知识检索分支；剩下的上下文段是记忆、连续性和分身（§2.5）。

## 12. 记忆与项目连续性：契约增补（2026-11-07）

### 12.1 现状（`resolveSendOptions`，取自 `064d195145`）

| 段                            | 生产者                                                                                    | 输入                                                                                                                                           | 旁路输出                                                                                   | 与别的段的耦合                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 个人记忆召回（`memory` 位）   | `@cognia/memory` 的 `applyMemoryContext`，经 `lib/memory/runtime/apply-memory-context.ts` | `memoryDeps`、`memoryUserMessage`、查询向量、`targetAgentId` / `memoryBranch` / `memoryPath`、记忆配置、agent 记忆策略（可读 scope 收窄 deps） | `opts.memoryContext`（含投递回执 `snapshot`）；每次解析写一条 `recall-allowed/denied` 审计 | **分身已取回的块**（`opts.twinContext` 的 `contentRedacted`）用于去重；**把用掉的预算**交给连续性       |
| 项目连续性（`continuity` 位） | `@cognia/memory` 的 `applyProjectContinuityContext`                                       | 同上 + 召回闸 `evaluateProjectRecallGate`、workspace scope 可读                                                                                | `opts.projectContinuityContext`                                                            | 预算 = `resolveProjectRecallBudget(个人上限, 个人已用, 项目预算)`，借个人段剩下的；个人段失败时视为用满 |
| 数字分身（替换 `baseSystem`） | `twin`                                                                                    | `twinDeps`、`twinUserMessage`                                                                                                                  | `opts.twinContext`                                                                         | 本草案不动（§2.5）                                                                                      |

另外三点事实：

- 记忆的查询文字不等于知识查询。调用方只在记忆握手成功时给 `memoryUserMessage`，连接器在消息不适合嵌入时也不给（`lib/connectors/runtime.ts`），而 `memoryDeps` 仍然在。所以不能复用 `ctx.query.text`。
- 两段都已逐条过 PII（`hasNoLeakingPii`），挪进贡献后内核闸只是兜底，不会多丢段。
- `memory` 现在是过渡表的行。试把它改成 manifest：`dependsOn` 要列 11 个模块（chat、data、editor、git、governance、inbound、inbox、project-knowledge、rag、squads、twin），`rerank-prompt.ts` 定义的提示词要改成 `prompts` 贡献，约 38 处外部导入要补进各自的 `api`。

### 12.2 要补的三处契约

**A. 同模块内的先后（预算交接）。** 贡献可声明 `after: "<同模块另一条的 id>"`。内核先跑被依赖的那条，再跑依赖方，依赖方在 `ctx.prior` 里读到前者返回的 `handoff`（`ContextSection` 新增的可选字段，只在本次解析内传递，不进提示词、不存会话状态）。被依赖方失败、超时或返回 `null` 时，`ctx.prior` 为 `undefined`，依赖方按今天的规则退化（连续性当作个人预算已用满）。只允许同模块、一层、无环；加载时检查，不合格整个模块跳过并上报。截止时间各算各的。

- 备选：一条贡献交回多个 slot 的段（`sections: [{ slot, text, sources }]`）。内核不用排先后，但 sources 和 PII 闸都要按段拆，形状改动更大。
- 备选：连续性不借个人剩余，固定用项目预算。最简单，但会改变每轮的召回量。

**B. 内核已检索的内容（分身去重）。** `ContextTurnContext` 新增只读的 `kernelRetrieval: { twinChunkTexts: readonly string[] }`，取自分身段已经写好的 `opts.twinContext`（分身仍在内核，先于收集点运行）。分身迁出后改为同一字段由分身模块的贡献 `handoff` 提供，或另行设计。

- 备选：不传，放弃去重。记忆和分身会重复召回同一段话。

**C. 记忆专属的调用方输入。** 经 `hostDeps` 按名传入：`memoryQuery`（即 `memoryUserMessage`，缺省表示调用方没给，记忆不跑）、`memoryScope`（`{ targetAgentId, branch, path }`）。`hostDeps.memory` 继续是 `memoryDeps`。声明放在 memory 模块。

- 备选：把 `ctx.query` 扩成按用途的 `{ knowledge, memory }`。语义更清楚，但要改 C0–C4 已用的 `query.text`。

### 12.3 截止时间

两段今天没有时限；`enableQueryExpansion` 开着时，召回前会调一次效用模型做查询扩展。拟定 `recall` 和 `continuity` 都声明 `deadlineMs: 15_000`（内核上限）。超时则该段缺席并上报，不阻塞发送。连续性在 `after` 下串行，最坏情况是 30 s，比今天的「无上限」短。

### 12.4 步骤

| 步骤 | 内容                                                                                                                                                                                                                                                                                                                                                                 | 还清的方向边              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| C5a  | 内核：`after` / `prior` / `handoff`、`kernelRetrieval`；ADR-0250 修订；单测                                                                                                                                                                                                                                                                                          | 无                        |
| C5b  | `memory` 成为 manifest 模块（补 `dependsOn`、`api`，提示词改为 `prompts` 贡献），行为不变                                                                                                                                                                                                                                                                            | 无                        |
| C5c  | `memory` 贡献 `recall`（turn、`memory` 位）和 `continuity`（turn、`continuity` 位、`after: "recall"`）；`opts.memoryContext` / `opts.projectContinuityContext` → `contextSources["memory.recall" / "memory.continuity"]`，消费者（`claude-chat-events`、房间 runner、adapter 两个 merge、`chat-grounding`、`compaction-runtime`）跟着改；删除 `build-options` 两个块 | `build-options -> memory` |

验收沿用 §5：缓存优化开关两种情况下提示词逐字节一致（尾部顺序 memory → continuity → project-knowledge → agent-knowledge 不变），来源在消息上的呈现、投递回执和审计事件不变。

### 12.5 评审结论（2026-11-07）

1. 预算交接：同模块内的 `after` + `handoff`（`ctx.prior`），只允许一层、无环。
2. 分身去重：内核只读字段 `kernelRetrieval.twinChunkTexts`。
3. 记忆专属输入：走 `hostDeps.memoryQuery`、`hostDeps.memoryScope`，`query.text` 不动。
4. 截止时间：`recall`、`continuity` 各 15 s，内核上限不变。

## 13. C5a 实施记录：内核的先后与内核检索（2026-11-07）

- 类型（`lib/modules/manifest-types.ts`）：`ContextContribution.after?`、`ContextSection.handoff?`、`ContextTurnContext.prior?` 和必填的 `kernelRetrieval: { twinChunkTexts }`。
- 读取方 `lib/claude/context-contributions.ts`：
  - 加载时检查：`after` 不能指向自己，必须是本模块列出的 id，被等的那条自己不能再有 `after`（一层，因此无环）；不合格就跳过整个模块并上报，与其他形状错误相同。
  - 运行：没有 `after` 的照旧一起启动；有 `after` 的在被等的那条结束后启动，`prior` 取它的 `handoff`。对方失败、超时、返回 `null`、段没有文字或没交 handoff 时，等待方拿到的上下文里没有 `prior` 键。等待方的截止时间从这时算起。放置、PII 闸、来源和会话状态都不变；handoff 不进任何输出。
- `build-options`：收集时传 `kernelRetrieval.twinChunkTexts`，取自上面分身段写好的 `opts.twinContext`（`contentRedacted`），没有分身时是空数组。
- 测试：`context-contributions.test.ts` 加 7 例（先后与 handoff、对方 4 种失败、对方超时后自己的截止、kernelRetrieval 透传）和 4 种不合格的 `after` 列表；`build-options.test.ts` 加 1 例（有、无分身时贡献读到的 `kernelRetrieval`）；其余四个模块的上下文测试补上 `kernelRetrieval` 字段。目前没有贡献声明 `after`，运行时行为不变。

## 14. C5b 实施记录：memory 成为 manifest 模块（2026-11-07）

- `lib/memory/module.ts`：`dependsOn` chat、data、editor、git、governance、inbound、inbox、project-knowledge、rag、twin；`api` 在原来 4 个文件之外补 21 个（`lib/memory/api/*` 七个、`control-plane/{manage,routed-manage,policy}`、`external/{discover,home}`、`history-filter`、`memory-event-bus`、`run-turn-memory`、`twin-lifecycle`、`hooks/memory/{use-memory-command,use-message-memories}`、`components/memory/{add-memory-dialog,memory-delete-confirm,memory-row}`）。过渡表删掉 memory 行；chat 行补 `mention-backlinks-chip`，rag 补 `retrieval-control-panel`，governance 补 `producers/memory`，inbound 补 `distiller`，inbox 补 `extract-plain-text`。
- 提示词贡献 `lib/memory/prompts.ts`：`knowledge.memory.*` 六个定义（顺序与目录原来一致），`lib/prompts/catalog.ts` 删掉对应的导入和条目。调用方本来就直接用定义解析，不依赖目录。还清 `lib/prompts/catalog.ts -> memory`。
- 环：试改时 memory 和 squads 互相依赖。memory 只借用了 `components/squads/settings/confirm-action-dialog.tsx`，它是通用的确认框，于是连测试和 story 一起搬到 `components/shared/`（foundation），13 处导入改路径，squads 的 `api` 去掉它，story 标题改为 `Shared/ConfirmActionDialog`。
- `hooks/data/index.ts` 是汇总导出，不能列为 `api`：`use-memory-console.ts` 和 `memory-namespace-picker.tsx` 改从 `hooks/data/use-client-live-query` 导入，五个测试的 mock 路径跟着改。
- 测试：`module.test.ts`、`prompts.test.ts` 新增；记忆、提示词目录、squads 设置、协调者、记忆设置相关的 124 个套件通过。运行时行为不变。

## 15. C5c 实施记录：记忆召回与项目连续性（2026-11-07）

- `lib/memory/context.ts`：
  - `recall`：turn、`memory` slot、15 s。没有 `hostDeps.memory` 或 `memoryQuery` 时不跑；照旧写 `recall-allowed/denied` 审计；不可召回时返回 `null`；按 agent 记忆策略的可读 scope 收窄 deps；`twinChunkTexts` 取 `ctx.kernelRetrieval`；只要召回完成就交出 `handoff: { limit, used }`（即使没有文字，与原来「完成即记录个人预算」一致）；有记忆、程序块或降级时上报来源（含投递回执 `snapshot`）。
  - `continuity`：turn、`continuity` slot、`after: "recall"`、15 s。召回闸、`canRecall`、workspace scope 三道条件与原分支相同；预算用 `ctx.prior`，没有交接时按「个人预算已用满」计算，与原来召回没跑或失败时相同。
- `hostDeps` 新增 `memoryQuery`（`memoryUserMessage`）和 `memoryScope`（只在有 `memoryDeps` 时传）；`memory`、`memoryQuery`、`memoryScope` 的类型由 memory 模块声明。来源类型 `MemoryRecallSources`、`ProjectContinuitySources` 在 `types/memory/context-sources.ts` 合并进 `ContextSourcesMap`。
- `build-options` 删掉两个块和 `systemPrompt` 里的两段（由 `contextSlot("memory")`、`contextSlot("continuity")` 提供）；`memoryDeps` 的类型改从 `@cognia/memory` 取。删除 `SendOptions.memoryContext`、`projectContinuityContext`；读取方（`claude-chat-events`、房间 runner、`chat-grounding`、`compaction-runtime`）改读 `contextSources`，`project-history-evidence-registry` 的注释跟着改。
- 方向边 `build-options -> memory` 未还清：项目历史工具（`lib/claude/project-history-tool`）是否提供仍由 `build-options` 读 `resolveMemoryConfig`（`types/memory`）判断。把它迁进 memory 的工具族另做。
- 提交说明：本步的 `build-options.ts` 删块和 `lib/memory/module.ts` 的 `context` 一行，被另一会话的提交 `63ffc35320`（ADR-0252 P4）在它的提交钩子运行时一并带走；其余部分在本步提交。
- 测试：`lib/memory/context.test.ts` 9 例新增；`build-options-memory.test.ts`（召回、程序块、降级、连续性借预算、闸）改读 `contextSources` 后不改断言即通过，作为迁移前后的对照；`compaction-runtime.test.ts` 改用 `contextSources`；`build-options.test.ts` 的 hostDeps 用例不变。
- 至此发送路径里只剩分身一个检索段（§2.5）。
