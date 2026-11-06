---
title: ADR-0132 — 应用内 Issue 追踪器（项目、Issue、执行桥、IM）
description: "每个工作区提供一个本地 Issue 追踪器，包含项目、Issue、固定看板和人类/运行时状态机。只读聚合 agent-task 与 agent-team 行，通过 issue 侧的 `issueRuns` 表派发到执行引擎，并在通知中心与交互式 IM 卡片中展示。"
---

# ADR-0132 — 应用内 Issue 追踪器（项目、Issue、执行桥、IM）

| 字段 | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态 | 已接受                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 日期 | 2026-08-18                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 基于 | ADR-0066 Agent Team 任务看板；ADR-0086 任务作用域资源工作区；ADR-0111 受管工作区 Registry；ADR-0113 工作区 / 项目作用域；ADR-0018 / ADR-0026 插件工作区后端；ADR-0009 / ADR-0025 平台连接器与 A2UI ⇄ IM 桥；ADR-0042 / ADR-0102 通知中心；ADR-0129 统一全局搜索；ADR-0090 统一 Agent 执行                                                                                                                                                                                                                                                                                                                                       |
| 范围 | `types/issues/`、`lib/db/{issues,issue-projects,issue-events,issue-counters,issue-runs,labels,github-issue-mirror}.ts`、`lib/issues/**`（`board-model`、`state-machine`、`views`、`sources/`、`run/`、`notify`、`im/`、`github-*`）、`components/issues/**`、`components/workspace/workspace-overview.tsx`、`app/{issues,projects,workspace}/`、`lib/global-search/providers/issues.ts`、`lib/skills/built-in/issues/`、`lib/connectors/bus.ts`（`issue_action` 分支）、`types/connectors/{interaction,audit}.ts`、`types/notifications/index.ts`、`packages/agent-config-types/src/work-submission.ts`、`crates/cognia-task-workspace/src/lifecycle.rs`、`src-tauri/src/task_workspace.rs`、`lib/git/commands.ts`、`stores/agent/agent-team-store/`（persist v7） |

## 背景

追踪器的切片 ①② （Dexie v170 / v171：项目、Issue、事件、计数器、标签、GitHub 镜像，`/issues` `/projects` `/workspace` 路由）上线时，**切片 ③ 的类型、i18n 键与 UI 占位已随之发出**——`canRun`、四种 `run_*` / `artifact_linked` 事件、`agent-team` / `agent-task` 源 id、「N 个 agent 在工作」磁贴、「我的 agent」视图——但没有任何生产者。这是本仓库反复出现的「建好但休眠」模式。以原始意图（Multica 计划、ADR-0066/0086/0111/0113/0018、已发 changeset 与消息包）为基线的审计列出了缺口：

- 「N 个 agent 在工作」写死为 `0`；「我的 agent」的 `agentKeys` 为空，永远匹配不到。
- 两个已声明的联邦源没有 adapter；`canRun` 没有消费者；`lib/issues/run/` 不存在。
- `/workspace` 链到设置页而不是打开唯一的工作区编辑器（`WorkspaceManageDialog`），也不显示信任状态与在跑 agent。
- 没有 ⌘K provider、没有 ADR（类型文件引用了一个不存在的 ADR）、没有受让人选择器，`WorkItemRefV1.kind` 没有 `"issue"`。
- 切片 ③ 整体——通知、IM 卡片、从聊天建单——未建。
- 相邻的工作区 / 团队缺口：`WorktreeCreate` / `WorktreeRemove` 四处声明零生产者；v86 之前创建的 Agent Team 没有 `projectId`，跨工作区泄漏；休眠的 `lib/terminal/collaboration` 分享模型（见 ADR-0133）；`project-store` 过期 docblock；e2b 工作区后端 shim 的 `else` 分支不可达且查找用了错误的 id 前缀。

非目标沿用切片 ①②：GitHub Projects v2 / 里程碑、双向字段同步、每项目**自定义列**、**保存视图**、**移动端写入**、自由标签重构、MCP 桥、IM `/issue` 斜杠命令、受管工作区页面（有意的技术债）、外部 agent 受让人。第 7 节新增的是视图*偏好*与列*折叠*——它们是固定六列与四个内置视图之上的显示状态，既不引入新列也不引入新视图。

## 决策

### 1. 术语与不变量

`Workspace = Project`（`types/plugin/_compat.ts`），拥有 `WorkspaceRoot[]`、`IssueProject[]`、`Issue[]` 与 `AgentTeam[]`。Issue 的**受让人**是 `IssueActor`：`human`、`agent`（= `Character` id）或 `team`（= `AgentTeam` id）；其他一律被选择器与 IM 处理器拒绝。看板六列固定。**分诊是属性，不是第七列**（2026-09-29）：`Issue.triage = "pending"` 表示该 Issue 的状态与受让人只是尚未被接受的提议。它不改变任何列，也不改变任何类别投影；它改变的是谁可以启动 run——`trackerVerdict` 对由入口推导出的来源（`im`、`wakeup`）以 `issue-in-triage` 拒绝，而放行由人在 Run 对话框中点名的 run（`interactive`，见 `isNamedRunOrigin`）。接受分诊走与其他编辑相同的批量动作词汇表清除该属性，并释放期间被暂存的唤醒输入。GitHub 导入模式可把新导入的、未关闭且无人受让的 Issue 送入分诊（`GithubRepoSyncSettings.triageNewIssues`）。每个程序化入口（`ctx.issues`、工作流节点、已配对手机的 `issue_apply_action` / `issue_create`、External Bridge）都经同一套动作设置 `triage` 与子议题 `stage`，只有一个例外：External Bridge 可以把 Issue 送入分诊，但接受出分诊会被拒绝——由外部智能体给出守卫所等待的那次接受，守卫就形同虚设。人类迁移走 `lib/issues/state-machine.ts`。**run 在飞时运行时拥有 `in_progress`**——`moveIssue` 在自己的事务内读取该 Issue 的活跃 run，双向拒绝进出该列（第 8 节）——但没有活跃 run 时，人类可以像对待任何一列那样把 Issue 移进去。（本 ADR 早前的措辞是「人类永远不能移过去」，守卫从未实现过这一点，而守卫自己的注释恰恰主张相反：「issue tracker 不该跟用户争论」。以代码为准，措辞已对齐。）run 结束把 Issue 停在 `in_review`，绝不 `done`；取消 run 把它交还到 run 之前所在的列（`statusBefore`），并记为 `run_cancelled`（第 8 节）。运行桥的结算（`settleIssueRunAndIssue`，基于 `lib/db/issues.ts` 的 `applyRuntimeIssueStatus` / `handBackRuntimeIssueStatus`）是运行时迁移的唯一写入者。

### 2. 执行桥——`issueRuns`（Dexie **v174**）与 `IssueRunAdapter`

`lib/db/issue-runs.ts` 新增 `issueRuns` 表（`&id, issueId, [issueId+status], projectId, [projectId+status], adapterId, kind, targetId, status, startedAt, updatedAt`）——「哪些 run 属于这个 Issue」以 **issue 侧为唯一真源**；执行引擎从不加 `issueId` 列，新引擎接入不需要 schema bump（`AgentTeamTask.metadata.issueId` 只是反向便利）。之所以认领 v174 而不是 v172，是因为两个并发分支持有 v172（ADR-0130）与 v173；Dexie 允许留空。

`lib/issues/run/registry.ts` 定义 `IssueRunAdapter { id, kind, canRun(issue, project) → verdict, start(issue, ctx) → IssueRun, cancel(runId) }` 与 `registerIssueRunAdapter` / `listIssueRunOptions` / `startIssueRun`（拒绝或派发；**派发失败必须抛出**，绝不吞掉）。三个 adapter：`agent-task`（`createAgentTask` → `startAgentTaskNow`，在调度器接受任务时即返回，而非结束时）、`agent-team`（`createTask({ metadata: { issueId } })` + `startSquadRun`，即 ADR-0140 唯一的 Squad 入口；产物取自 delivery 节点 / 子运行工作区路径）、`github-loop`（仅当项目持有 `github-repo` 资源；在 `awaiting_approval` 闸门下执行 `executeIntegrationAction("runIssueLoop")`；仅桌面）。`running.ts` 暴露 `listRunningIssueIds()` 与 `viewerAgentKeys()`（所有 Character + AgentTeam 映射为 `agent:<id>` / `team:<id>`），这使得单人应用里「我的 agent」= 全部 agent/team 受让人。没有哪个 adapter 靠引擎回调来结算：`installIssueRunBridge`（`lib/issues/run/install.ts`）在 run 所指向的东西变化时让各 adapter `poll`——一个覆盖 `agentTasks` 与 `integrationActionJobs` 行及 Squad 运行记录的 Dexie `liveQuery`，加上对 AgentTeam store 的订阅——另有一个慢速兜底定时器与启动时的一次 reconcile。（2026-11 修订，见第 8 节：早前措辞写的是 `agentTaskAttempts` 的 `liveQuery` 与结算入口 `team-completion-linkage.ts`，运行桥两者都不读。）

### 3. 联邦源

`lib/issues/sources/{agent-task-source,agent-team-source}.ts` 以**只读**（`READ_ONLY_ISSUE_CAPABILITIES`）实现两个已声明的 `IssueSourceAdapter`，通过同一张表映射引擎状态（`agent-status-map.ts`：`pending→backlog`、`blocked/claimed→todo`、`in_progress/paused→in_progress`、`review→in_review`、`completed→done`、`failed/cancelled→canceled`）并深链回原生页面。联邦行默认入板、带源徽章、工具栏可按源过滤；带 `issueId`（metadata 或 `issueRuns.targetId`）的行标注「来自 KEY-1」。

### 4. UI

`issue-console.tsx` 读取实时 viewer（`viewerAgentKeys`）与运行集合；新的 `assignee-picker.tsx`（Character + AgentTeam + 我 + 未指派）接入创建与详情；`run-issue-dialog.tsx` 是 `canRun` 的消费者（模式 = 默认本地 AgentTask / AgentTeam / GitHub loop），详情面板显示运行记录、产物与取消。`/workspace` 直接挂载 `WorkspaceManageDialog`（一个编辑器，两个入口），按 root 显示信任状态（`lib/db/trusted-workspaces.ts`）与实时在跑 agent 磁贴。⌘K 新增 `lib/global-search/providers/issues.ts`（kind `issue`）；`WorkItemRefV1.kind` 新增 `"issue"`。

### 5. 通知与 IM（切片 ③）

`lib/issues/notify.ts` 把 Issue 事件投影到通知中心（`NotificationSource` `issue`，命令 `issue.open`）：指派 / 改派、run 成功 / 失败、进入 `in_review` / `done` / `canceled`、以及非本人评论。带固定水位 + 已见集合的 `liveQuery` 监听器不会漏事件；当 Issue 来自 IM 会话（`Issue.origin = { kind: "im", conversationKey, messageId? }`）或会话绑定了该项目（`ConversationOverrideRow.issueProjectId`）时，同一事件经治理队列推回 IM，受会话主动推送开关与 `hasNoLeakingPii` 双重门禁。

IM 卡片（`lib/issues/im/card.ts`）是纯 A2UI 构建器：恰好是**合法的人类迁移**（仅在 run 持有该 Issue 时才排除 `in_progress`）、引擎可接单时的 **Run** 按钮、以及 **打开** 链接；无按钮渠道使用编号镜像。按钮通过 `bindingHintFields`（Discord / Telegram / Slack / WeCom / Lark 映射器共用）携带 `bindingKind: "issue_action"` + payload，点击进入 `lib/issues/im/callback-handler.ts`（`ConnectorBus` 在 `tool_approve` 之前的短路分支）而不是模型轮次。移动 / 运行按钮可重复点击；只有建单确认卡 consume-once。从聊天建单是内置 skill `issue.create`（write 级，`hitlSurface`）：确认卡列出 ≤ 5 个项目、会话上次选择排在最前，**不点项目按钮就不落库**；`issue_list_projects` 解析项目名。Lark 与 Slack 入站现在携带 `replyTo`，引用建单在这两处与 Telegram / Discord 一致。处理器运行之前，点击要先通过**会话触发策略中与发送者相关的部分**（`lib/connectors/policy-eval.ts` 的 `senderTriggerRefusal`，与入站回合一样按 机器人 → 角色 → 会话覆盖 逐层解析）：被 `user-blocklist` 点名的发送者、或在只响应 `user-allowlist` 的机器人上不在名单内的发送者，同样不能通过点击移动或运行 Issue；读不到机器人配置行的点击一律拒绝（2026-09-30）。权限上限（`buildImPermissionCeiling`）只收窄运行可用的工具，并不是这道闸门。新增审计类型：`issue.card_action`、`issue.card_action_denied`、`issue.im_pii_blocked`。

### 6. 同一改动中补齐的相邻工作区 / 团队缺口

- **Worktree hooks 触发**（ADR-0111 决策 9，措辞已在那里修订）：Registry 通过 `WorktreeLifecycleSink`（Rust）发出，`lib/git/commands.ts` 在 `git_worktree_add/remove` 之后发出（TS）——两个生产者，因为 Registry 前面没有站着 Agent Team allocator 与源代码管理面板。仅观察性。
- **v86 之前的 AgentTeam** 回填 `projectId = DEFAULT_PROJECT_ID`（persist v7 `backfillTeamProjectIds`，在 `migrate` 与 `activateAgentTeamAccountStorage` 中都应用）；`updateTeam` 补打；模式选择器删除 `!t.projectId` 逃逸。
- **e2b**：`resolveWorkspaceBackendByKind`（精确 id，再 `:<kind>` 后缀）取代永远匹配不到已注册 `cognia-e2b-sandbox:e2b` 的 `"e2b"` 查找；删除 `setE2BBackend/getE2BBackend` shim 与不可达的插件分支。修正 `project-store` docblock。

### 7. 界面重建（2026-08-22）

第二次审计——这次审的是「UI 究竟够得着什么」——找出**十二个在全应用非测试代码中零调用方的导出**：`updateIssue`、`addIssueLabel`、`removeIssueLabel`、`addIssueComment`、`moveIssueToProject`、`deleteIssue`、`linkIssueToGithub`、`countIssuesByStatus`、`updateIssueProject`、`deleteIssueProject`、`computeIssueProjectProgress`、`reorderLabels`。第 2–5 节的读取面与运行面都已接线；**编辑面只存在于数据层**。三个后果对用户可见：

- 每个工作区**一辈子只能有一个 `IssueProject`**。`createIssueProject` 的唯一调用点是建单对话框的 `projects.length === 0` 分支，`/projects` 没有新建按钮，`deleteIssueProject` 零调用方——计数永远回不到零。
- Issue 建完之后无法改名、改描述、改优先级、打标签、换容器、删除，也无法对本地 Issue 评论。
- **全站没有任何一个标签 chip 能渲染出来。** 本地 Issue 拿不到标签；GitHub 行携带的是 `labels` 表中不存在的合成 id `github:<name>`，chip 全被过滤掉，而筛选菜单回退到 `?? labelId`，把原始字符串直接显示给用户。

重建中确立的决策：

- **一套动作词汇，一道门。** `lib/issues/bulk-actions.ts:IssueBulkAction` 表达每一次编辑——无论落在一个还是十二个 Issue 上；`canApplyBulkAction` 在任何写入之前按每一项自己的 `capabilities` 把门。结果是**如实计数**（`applied` / `skipped` / `failed`），不是假定成功。`lib/issues/menu-model.ts` 决定菜单提供什么、禁用什么、勾选什么——右键菜单、批量工具条与详情面板都渲染它。
- **`title` 与 `description` 在词汇内但被排除出 `menu-model`**，因此永远不会出现在批量菜单里。
- **GitHub 标签绝不物化。** `lib/issues/github-label-display.ts` 为 `github:*` id 构建临时展示行，仅用于渲染与筛选。所有*写入*菜单只接收本地标签——把合成 id 应用到本地 Issue 会存下一个「只有那条 GitHub 行恰好在板上时才解析得出」的引用。
- **布局。** `/issues` 在 `FeaturePageShell` 的左窗格获得导航栏（视图、容器、标签），并在看板上方获得筛选条，每个生效的分面渲染成一枚可单独移除的 chip；头部回到单行。此前所有东西都挤在 `FeaturePageHeader` 唯一的 `controls` 槽里，而该槽渲染在隐藏滚动条的 `overflow-x-auto` 中——窗口一窄，右半边控件就无声地滚出边界。
- **视图偏好按视图持久化**（`stores/issues/issue-view-store.ts`）。覆盖值是部分的，缺省回落到 `IssueViewDefinition`——四个内置视图声明了不同默认值，一套全局覆盖会跟它们打架。列折叠是一个字段、每列三态：缺省表示「空则折叠」，存在则是用户的明确决定。
- **`/projects` 改为 master-detail 控制台**——表格（名称、KEY、状态、负责人、目标日期、进度、issue 数）、可写入全部八个可编辑字段的检视面板、创建，以及一个会说明 issue 数量的删除，因为级联会带走其下每一个 issue、事件与运行记录。`key` 保持不可变；每一个已打印的标识符都嵌着它。
- **拖拽图层。** 被拖卡片乘 `<DragOverlay>` 传送到 `document.body`，`zIndex 60`。原地位移时它会被列的 `overflow-y-auto` 与看板的 `overflow-x-auto` 裁剪，并因为 `opacity < 1` 在 `z-auto` 开出堆叠上下文而被后面的列**盖住**。`components/agent/workspace/board/task-board.tsx` 有逐行相同的缺陷，同法修复。
- **键盘。** 看板的 `KeyboardSensor` 只占用空格键，让回车键留给「打开卡片」；水平移动按生命周期顺序在列之间解析——dnd-kit 的 `sortableKeyboardCoordinates` 假设只有一个可排序列表，在六个并排的列表上会判错目标。
- **十二个里有两个是删除而非接线。** `countIssuesByStatus` 唯一可能的消费者是导航栏计数，而它只读本地表，永远给不出与旁边联邦看板一致的数字。`computeIssueProjectProgress` 为一份两个真实消费者都能在已加载数据上一趟算完的统计，每个容器跑一次查询；`lib/issues/project-progress.ts` 是唯一实现。其余十个都有了 UI 路径，包括 `linkIssueToGithub`——没有它，`github-loop` 适配器会拒绝每一个不是由 GitHub 同步创建的议题，因为应用里没有任何地方能写入 `githubRef`。
- **标签目录管理**由「设置 → 连接 → 标签」泛化而来，不是复制。`colorMode` 区分两个 scope：会话标签存自由 hex，Issue 标签存 oklch 主题令牌，原生颜色输入框会把后者无声改写成前者。
- 移动端保持只读，并且现在会明说：行可点开只读详情，不再只是给一个打不开的行加底色；`/projects` 也补上了它从未有过的移动端页面。

### 8. 2026-11 状态流修订

第三次审计——这次审的是**状态流**：什么让 Issue 在列之间移动、谁可以移动、应用其余部分何时得知——找到了类型检查与 mock 掉 adapter 的测试都看不见的竞态与缺口：同一个 Issue 可以同时启动两个 run；run 锁是一个调用方得记得传的 `runActive` 参数；结算 run 与移动 Issue 之间崩溃，Issue 就卡在 `in_progress`；取消一律把 Issue 丢回 `todo`；事件在事务提交之前就发布；`github_write_back` 已声明却没有生产者；人类写入经由好几扇门进入数据层。计划：`docs/plans/2026-11-05-issue-tracker-state-flow-overhaul.md`；证据：`docs/evidence/2026-11-05-issue-tracker-state-flow.md`。

- **run 锁在数据层。** `moveIssue`（`lib/db/issues.ts`）在自己的事务内读取 Issue 的活跃 run，没有调用方能漏掉这一检查；`runActive` 参数已删除。run 持有 Issue 时看板把 `in_progress` 置灰，IM 卡片与菜单读同一个答案，被拒绝的移动会如实报告而不是被丢掉。
- **两阶段启动。** `claimIssueRun`（`lib/db/issue-runs.ts`）在**同一个事务**里检查活跃 run 并插入一行 `queued`、`targetId` 为空的记录。这就是启动锁：争抢同一 Issue 的两次派发不可能都通过。随后 adapter 派发，`bindIssueRunDispatch` 记下引擎接受的内容以及 `statusBefore`（Issue 原来所在的列）。引擎接受期间落下的取消会发现认领已不在，绑定成为空操作。超过 `ISSUE_RUN_DISPATCH_STALE_MS`（5 分钟）仍未绑定的认领说明派发被打断（窗口在认领与接受之间关闭）；reconcile 将其结算为失败，而 Issue 从未为它移动过，原地不动。agent-task adapter 的启动在调度器接受时返回（`startAgentTaskNow`），不等到完成。
- **结算。** `settleIssueRunAndIssue`（`lib/issues/run/registry.ts`）在**同一个事务**里结算 run、关联其产物中的 PR、移动 Issue。成功与失败都推进到 `in_review`；取消交还到 `statusBefore` 并追加新事件类型 `run_cancelled`，而不是记为失败。停在 `review` 的 Agent Team 任务结算为 `succeeded`：团队已完成它那部分，与其他 run 一样由人在 `in_review` 审阅该 Issue。启动时 `repairStrandedIssues` 在首次 reconcile 之前运行一次，修复崩溃后停在 `in_progress`、旁边是已结束 run 的 Issue——仅当事件轨迹表明正是那个 run 把它放进去；人主动移进 `in_progress` 的 Issue 不动。
- **事件在提交后才到达订阅者。** `lib/db/issue-events.ts` 在每条追加记录持久化之后才发布到 `lib/issues/event-bus.ts`：自成事务的写入立即发布，否则在根事务 `complete` 时按追加顺序发布（每个事务一个 FIFO 队列）。中止事务里的记录永不发布，因此插件、工作流触发器与通知漏斗永远看不到不存在的行。
- **`github_write_back` 有了生产者。** 看板对 GitHub 的每次回写都作为一个集成作业运行，其幂等键以 `issue-writeback:` 开头（`lib/issues/github-writeback.ts`）。作业成功时，向关联到该 GitHub Issue 的每个本地 Issue 追加一条 `github_write_back`。记录以作业为键，所以可能记录它的三条路径（调用本身、对仍在排队或重试的作业的监听、启动时的 `reconcileGithubWritebacks`）合起来只记一次。
- **人类写入只有一扇门。** 人或任何门面发起的写入都经过 `lib/issues/service.ts`（及 `lib/issues/bulk-actions.ts`），由它校验输入并完成写入隐含的后续动作，例如仓库解绑时撤掉它的刷新计划。`parseIssueAction` / `assertCreateRequest` 在此处检查输入，每个门面都调用它们，因此已配对手机的 `issue_apply_action` / `issue_create` 与插件的 `ctx.issues` 和一次点击受同样的检查。`pnpm audit:issue-write-boundary`（`scripts/gates/check-issue-write-boundary.mjs`，无基线）对 `components/`、`app/`、`hooks/` 下任何从 `lib/db/issues`、`lib/db/issue-*` 或 `lib/db/github-issue-mirror` 导入写操作、或经 `getDb()` 写这些表的文件报错。
- **每个源都是实时的。** `IssueSourceAdapter.subscribe` 为必填（`types/issues/unified.ts`）：先交付当前行，再交付每次变化。看板通过一个 `subscribeAll` 读取所有源，所以联邦的 agent-task / agent-team 行与 GitHub 镜像原地刷新，不必重新加载。启动之后注册的源经 `onSourcesChanged` 到达已打开的看板。本地源只读；本地写入走 service。
- **泳道与排序。** 视图按受让人、项目或优先级分组时，看板为每组画一行状态列（`lib/issues/board-model.ts` 的 `buildIssueSwimlanes`，每条泳道一个 `KanbanBoard`），顺序与列表分组一致；分组即第 7 节的按视图偏好。`reorderIssues` 会更新 `updatedAt`，因此手动排序与其他编辑一样到达实时订阅者与已配对手机的增量拉取。手机跟随 `?id=` 与 `?source=` 深链，把任何非本地源视为不可用（它只持有本地 Issue 表），并且只提供主机在已同步的 run 锁下会允许的状态迁移。
- **标识符即链接（`MERC-12`）。** 聊天内核拥有一个通用的内联链接注册表（`lib/chat/inline-links.ts`，由 `rehypeInlineLinks` 与 `InlineLinkedText` 渲染）。Issue 模块为项目 key 存在于当前工作区的标识符注册一种类型（`lib/issues/inline-links.ts`，key 来自 `lib/issues/project-keys.ts`），从而守住模块门禁的依赖方向：聊天不导入 issues。链接携带可打印的标识符（`/issues?identifier=MERC-12`）；页面解析一次，没有对应 Issue 时提示「未找到」。它们出现在聊天 Markdown、Issue 描述与评论、GitHub 评论、提交信息以及引用的 IM 回复中。
- **同步。** 冲突 reconcile 按同步阶段（先镜像、后导入）各运行一次，而不是按仓库。从看板写 GitHub 后只从水位重读该仓库（`GithubEventIssueRefresher.refreshAfterWrite`）；同步忙时排队，失败时告知用户。GitHub 评论读取沿用同步的凭据规则（`resolveGithubSyncReadClient`），没有可读该仓库的凭据时评论区会明说。从 Issue 启动的 run 在联邦行上保留 Issue 自己的优先级，而不是引擎最接近的一档。
- **死代码。** 一次调用方普查删掉了无人可达的导出（`getGithubIssue`、`bindRepoToIssueProject`、`clearRepoMirror`、`pruneRepoMirror`、`latestMirroredUpdate`、`repoMirrorEtag`、`countMirroredIssues`、`appendIssueEvents`、`peekIssueNumber`、`getIssueCycleByExternalKey`、`mapIssuesByExternalProvider`、`hasPlanningBadges`、`syncFieldOfEvent`、`mappedFields`、`listOpenSyncConflicts`、`conditionTargetId`、`extractIssueIdentifiers`、本地源的 `mutate`、事件刷新器的 `pending`）。协作参与者收窄**已接线**（ADR-0149 §10）：写入共享议题的每个参与者都经由 `lib/issues/collab-actor.ts` 走 `resolveCollabActor`。“我”解析为当前配置绑定的 `usr_…` 用户，标签用此人的名字而非本地化的“我”。协作源的受让人修补、共享创建和批量门禁都会拒绝协作平面无法识别的参与者并说明原因；选择器和菜单会提前将其置灰。共享行还会提供工作区的现任成员作为受让人（`hooks/issues/use-collab-assignee-members.ts`），名册与评论提及同源，取自服务器，每次打开受让人菜单都会重新获取，因为服务器只接受现任成员；本地议题以及本地与共享混合的选择永远看不到成员。详情面板通过同一菜单模型修改共享议题的受让人。`toCollabActor` 与 `issueActorsResolvable` 没有调用方，已删除。

## 影响

- 追踪器表面本不该留下休眠项。2026-11 的审计（第 8 节）发现这一条说过了头：`github_write_back` 没有生产者，run 锁是调用方可以漏传的参数，人类写入经由好几扇门进入数据层。第 8 节之后每种事件都有生产者，运行时 / 人类边界两侧各只有一个写入者：运行时是运行桥的结算，人是 `lib/issues/service.ts`，由 `audit:issue-write-boundary` 守住。
- 引擎对 Issue 无感；新增引擎 = 一个 adapter + 一行状态映射。
- IM 成为 Issue 的一等参与者，既不需要新传输，也不需要每次点击都走模型摘要；PII 不过闸不出门。
- 同伴的两个 Dexie 认领（v172、v173）迫使本 ADR 跳到 v174——见 schema 块注释。
- 第 7 节的重建**无需 schema 变更**：折叠、密度与导航栏宽度是 UI 偏好，标签管理复用现有 `labels` 表。
- 本子系统两次发现「建好但休眠」——一次对照声明的意图（背景），一次对照 UI 够得着的范围（第 7 节）。第二类对类型检查和任何 mock 掉数据层的测试都不可见，只有调用方普查能找到。第三轮（第 8 节）在状态流里找到同一类问题：只在并发、崩溃或第二个写入者出现时才显形的竞态与缺失的生产者。

## 验证

各阶段的共置测试（adapter、源、通知监听器、卡片构建器、回调处理器、skill、worktree sink、persist 迁移）；`pnpm i18n:build && pnpm lint:i18n` 对齐；新模块的作用域覆盖率 ≥ 90%。完整的 `test:coverage:changed --strict` 与 `tauri-smoke` 在共享且磁盘吃紧的机器上未能跑完，记为待办。
