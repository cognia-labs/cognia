# 能力授予贡献（ADR-0250 M3 最后一块）设计草案

状态：已实施（C0–C2，2026-11-07）。评审结论：只做 grant 形状、来源种类新增 `"module"`、按收窄/放宽区分失败策略、试点 browser-companion + goal。创建：2026-11-07（Asia/Shanghai）。

上游：

- [ADR-0250](../content/docs/en/adr/0250-the-runtime-is-a-headless-kernel-the-desktop-embeds.md) §14：`capabilityContributions` 只产出 `AgentCapabilityGrantV1`，由现有解析链逐阶段应用；不排序号、不改 `SendOptions`；需要新阶段的贡献先修订 ADR-0198。§13 M3 的度量是「`build-options` 触达的子系统数下降」。
- [ADR-0198](../content/docs/en/adr/0198-a-runs-capabilities-are-granted-not-patched.md)：一次运行的能力由 grant 授予，不在解析后打补丁。
- 证据：本文 §1 的逐处核对，取自 `dev` 的 `c05a61cd5d`，`lib/claude/build-options.ts`（6658 行）。

## 1. 现状：`build-options.ts` 对模块的 21 条方向边

基线 `scripts/gates/modules-baseline.json` 里 `lib/claude/build-options.ts -> <模块>` 共 21 条。逐处核对后分四类。只有第一类是 grant 形状。

### 1.1 grant 形状（本次范围）

| 模块                           | 位置         | 加了什么                                                                                                         | 能否用现有 grant 字段表达                                                                                                              |
| ------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| browser-companion（+ browser） | ~1668        | 会话由浏览器伴侣的 agent 模式发起时，push 一个 `browserCompanionGrant`（已经是 grant，只是在解析器里硬编码构造） | 能，原样                                                                                                                               |
| goal                           | ~5187        | 活动目标的 `<objective>` 段追加到 `appendSystemPrompt`；目标的每轮美元上限压低 `maxBudgetUsd`                    | 能：`instructions` + `maxBudgetUsd`（合并取最小值，ADR-0198 已定）                                                                     |
| connectors（IM 权限上限）      | ~120、~1104  | IM 会话的权限上限、调度工具按会话开放                                                                            | 大体能：`tools.deny` / `permissionMode` 上限；但它和平台绑定、能力矩阵缠在一起，排在后面                                               |
| a2ui                           | ~3362、~3563 | 启用时加 A2UI 工具名和 A2UI 协议段（+ 角色目录段）                                                               | 字段能表达（`tools.add` + `instructions`），但「是否启用」依赖解析器后段才算出的连接器能力评估，不能在 grant 折叠点之前判定 → 排在后面 |
| project-coordinator（目标段）  | ~3049        | 协调项目的目标段插在系统提示中段（稳定前缀里）                                                                   | 字段能表达，但 `instructions` 落在 `appendSystemPrompt`，位置变化会影响缓存前缀 → 排在后面                                             |

### 1.2 工具形状（不在本次范围 → ADR-0250 的 `tools` 贡献）

进程内内建工具经 `opts.pluginTools` 清单上送，并带各自的权限规则集：filespace（~3208）、project-coordinator 的路由/汇报工具（~4459）、workflow runner 工具（~3992、~4019）、slash-command 自调用工具（~4400）、知识库阅读工具（~4544）、computer use（~4674，automation）。grant 只能在已有工具里加减，不能注册工具定义和规则集。ADR-0250 已单列 `tools`（「工具连同权限规则」）。

### 1.3 每轮上下文形状（不在本次范围 → 需要另一份契约）

memory（~2508、~2622）、project-knowledge（~2702）、knowledge-base（~2779）、twin（~2419）：每轮检索出一段文本放进对缓存友好的动态尾部（`dynamicTailSections`），同时写旁路结果（`opts.twinContext`、`opts.agentKnowledgeContext` 引用列表）、过 PII 闸、写审计事件。twin 还会**替换**基础系统提示，这正是 ADR-0198 禁止 grant 做的事。workflow 编辑器 copilot（~5376）对某种会话直接覆盖整个提示和工具面。这些要的是「上下文贡献」：放置位置、token 预算、PII 闸、旁路结果都要在契约里写清楚，应当另立 ADR。

### 1.4 内核管道（留在内核）

agent-trace（~6198 根 span）、quiet hours（~5250 收件策略抑制）、lsp（~3746 `opts.lsp` 宿主配置）、harness overlay（~1737，ADR-0237）、context-workbench 的旁聊运行时（~1544）、support-agent。它们是解析器本身的职责或宿主配置，不是某个功能模块对一次运行的授予。后续随 `lib/claude` 拆分（ADR-0250 §9）改名搬迁，不走贡献。

## 2. 决定（拟写入 ADR-0198 的修订）

拟在 ADR-0198 末尾加一节，英文原文如下（评审通过后同步中文版）：

> ### Amendment (2026-11-07): modules contribute grants
>
> A feature module that customises every run it applies to, rather than one
> run a caller launches, contributes grants through its manifest
> (`capabilityContributions`, ADR-0250 §14). This adds a grant source, not a
> resolution stage: contributed grants are folded with the caller's at the
> point where `capabilityGrants` are folded today, and each field is applied
> at the stage this ADR already assigns it.
>
> - **Contract.** A module's `capabilityContributions` file exports
>   `contributions`, a list of `{ id, failure, produce(ctx) }`. `produce`
>   returns a grant or `null` from a read-only `CapabilityContributionContext`
>   (`types/agent/capability-contribution.ts`): the session's id, kind,
>   workspace and platform binding, the resolved agent's id, the surface, the
>   active goal, the prompt snapshot and a read-only view of the settings. It
>   gets no `SendOptions` and no caller dependencies.
> - **Fields.** A contribution may set `instructions`, `skills`, `mcpServers`,
>   `tools`, `knowledgeBases`, `subagents`, `permissionMode` and
>   `maxBudgetUsd`. It may not set `model`, `provider`, `effort`, `maxTurns`
>   or `permissionProfile`: those are the caller's choice for its run. A grant
>   naming one is refused as that contribution's failure. The source is
>   `{ kind: "module", id: "<module>/<contribution>" }`.
> - **Order.** Caller grants, then contributions in module id order and
>   manifest order, then the resolver's own (the read-only aside). Every
>   permitted field composes commutatively under `mergeCapabilityGrants`
>   except `instructions`, whose append order is this order.
> - **Failure.** Contributions run concurrently under one deadline. One whose
>   `failure` is `"skip"` that throws, times out or is refused is left out and
>   reported. One whose `failure` is `"refuse-turn"` fails the resolution
>   instead: a contribution that narrows (a deny list, a permission cap) must
>   not silently disappear. An `experimental` module contributes nothing.
> - **Where it runs.** Wherever `resolveSendOptions` runs (desktop renderer,
>   headless brain). A contribution that needs a host it is not on returns
>   `null`.
>
> Per-turn retrieved context (memory, knowledge, twin) and in-process tools
> with their rulesets are not grants and are out of this amendment; they get
> their own contracts (ADR-0250's `tools`, and a context contribution still to
> be decided).

要点说明：

1. **不新增解析阶段。** 只多一个 grant 来源，所以不动 ADR-0198 现有的「字段在哪一阶段应用」表。
2. **禁止贡献改模型、供应商、effort、轮数、无人值守权限档。** 这些是发起方对自己那次运行的选择；模块对「每次运行」改它们会让调用方的选择失效。
3. **收窄型贡献失败即拒绝本轮。** IM 权限上限这类贡献如果静默失败，本轮会比应有的权限更宽。放宽型（加工具、加说明）失败就跳过并报告。
4. **来源种类加 `"module"`。** 这要改 `packages/plugin-contract` 的 `CapabilityGrantSourceKind`，会让插件 authoring kit 的版本固定失效（它现在本来就是过期的，见记忆「kit pin not rebuilt」）。替代方案是复用现有种类（goal 用 `"goal"`，伴侣用现有的伴侣种类），不碰 plugin-contract，但追溯时分不出「模块贡献」和「调用方授予」。

## 3. 机制

- **manifest**：`capabilityContributions: () => import("./grants")`（字段已在 `lib/modules/manifest-types.ts` 里，类型从 `ModuleContribution` 收紧为 `LazyModule<ModuleCapabilityContributionsModule>`）。
- **生成**：生成器多写 `lib/modules/generated/capabilities.ts`，只有各模块 grants 文件的懒加载（同 `prompts.ts` 的做法，headless brain 打包时不带入其他功能代码）。
- **内核读取**：`lib/claude/capability-contributions.ts`（内核）首次解析时加载一次各模块的 contributions，之后每次 `resolveSendOptions` 并发调用 `produce`，结果和 `ctx.capabilityGrants`、`asideGrants` 一起交给 `foldCapabilityGrants`。跳过的贡献连同原因记一条警告日志并随结果返回；生效的授予带 `{ kind: "module", id }` 来源，便于追溯。
- **门禁**：
  - G5：`capabilityContributions` 是懒加载入口，文件导出 `contributions`；生成的注册表与生成器一致。
  - G4：内核文件不得因为某个模块的授予而 import 它（G2 已有）；本次迁走的方向边从基线删除。
  - 单测固定：禁用字段被拒、两种失败策略、顺序、实验阶段模块不贡献。

## 4. 试点与验收

| 步骤 | 内容                                                                                                                                          | 还清的方向边                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| C0   | ADR-0198 修订（中英）+ ADR-0250 M3 说明；契约类型、生成器、内核读取、门禁，带单测                                                             | 无                                                                                                                              |
| C1   | `browser-companion` 成为 manifest 模块（迁出归属表），`browserCompanionGrant` 改为它的贡献                                                    | `build-options -> browser-companion`、`catalog -> browser-companion`（`-> browser` 保留：解析器自己为已绑定会话放行浏览器工具） |
| C2   | `goal` 成为 manifest 模块，活动目标段和美元上限改为贡献（`instructions` + `maxBudgetUsd`）；`ctx.activeGoal` 仍由调用方传入，经贡献上下文转交 | `build-options -> goal`、`catalog -> goal`                                                                                      |

验收：

- `build-options.ts` 的模块边从 21 条降到 19 条，提示词目录另还清 2 条（共 4 条）；`pnpm audit:modules` 通过，基线增长检查里属于本任务的度量只降不升。
- `build-options` 的现有测试全部通过，并补充：伴侣会话仍得到同一个 grant；活动目标的段落文本、位置（在调用方 instructions 之后）、预算上限与改动前一致（用改动前的输出做对照快照）。
- 不做桌面冒烟（沿用之前的约定），在交付说明里写明。

后续（不在本次）：a2ui、project-coordinator 目标段、connectors IM 上限需要先把各自的「是否启用」判定前移到折叠点之前；`tools` 贡献和「上下文贡献」各自另立决策。

## 5. 评审结论（2026-11-07）

1. 范围：只做 grant 形状的贡献（C0–C2）。工具走 ADR-0250 的 `tools`，每轮上下文另立「上下文贡献」决策。
2. 来源种类：新增 `"module"`，接受 authoring kit 版本固定失效（之后统一重建）。
3. 失败策略：每个贡献声明 `failure`，收窄型 `"refuse-turn"`，放宽型 `"skip"`。
4. 试点：browser-companion + goal。
