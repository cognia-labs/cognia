---
title: "0252 — 房间负责对话，小队负责干活，委派负责承诺"
description: "房间、小队、委派仍是三条独立的轴：对话形态、执行器、承诺。一次运行的每个异步子任务都是 executionRuns 里的一行，用 parentRunId 关联，由同一个启动器启动，经同一个入口 steer，由同一台状态机控制。房间成员可以把工作交给小队，但要房间里的人确认。ADR-0177 的 IM 与共享房间两批补完；ADR-0247 和 ADR-0249 按这里记录的修订采纳；2026-11-05 审计发现的重复追踪器、steer 路径、控制状态机和休眠导出，分别合并、接线或删除。"
---

# ADR 0252 — 房间负责对话，小队负责干活，委派负责承诺

**状态：** 已接受
**日期：** 2026-11-05

**相关：**
- [ADR-0137](./0137-delegation-runtime)：`delegation` 运行类型、T0/T1/T2、steer、转交给人。本 ADR 修订它。
- [ADR-0140](./0140-squad-as-an-executor) 与 [ADR-0169](./0169-one-runtime-one-review-one-control-machine)：小队是执行器，一个运行时、一套评审、一台控制机。本 ADR 修订它们。
- [ADR-0177](./0177-a-room-is-one-conversation-shape)：房间是一种对话形态、三种成员来源。本 ADR 修订它。
- [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads) 与 [ADR-0249](./0249-a-background-jobs-completion-reaches-the-agent)：本 ADR 按 §9 的修订采纳。
- [ADR-0248](./0248-a-person-is-never-queued-behind-automated-work)：仍留在 ADR-0250 阶段 1。在那之前由 §5 保证人优先。
- [ADR-0250](./0250-the-runtime-is-a-headless-kernel-the-desktop-embeds)：本 ADR 提前交付阶段 3（work spine）中多 agent 的部分，并遵守 §14 的依赖方向规则。
- [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched)：每个子运行都由能力授权定制。
- [ADR-0217](./0217-agent-integrations-are-packages-behind-host-ports)：`packages/agent-orchestration` 拥有持久化协调器及其记录。
- [ADR-0243](./0243-a-run-acts-for-someone-and-says-who)：ADR-0247 §7 需要的实时权限检查。

**证据：** 2026-11-05 的四路只读审计和一次 grill 会话。下文路径和数字取自 `dev` 的 `03d7e75b43`。实施计划：`docs/plans/2026-11-05-multi-agent-convergence.md`。

## 背景

三份 ADR 画了三条轴，并让它们彼此分开。ADR-0177 说**房间**是一种对话形态。ADR-0140 说**小队**是执行器，不是一个去处。ADR-0137 说**委派**指的是承诺，不是引擎。这三条轴是对的，围绕它们长出来的东西不对。

**轴在该相交的地方没有相交。**

- **房间成员拿到的工具永远用不了。** 只要打开 `selfInvokeTools.teamCollaboration`，`resolveSendOptions` 就给每个 `kind === "team"` 的会话加上 `team_*` 协作工具，其中包括 `team_delegate`（`lib/claude/build-options.ts:4496`）。这些工具需要的调用者身份只由 `dispatchTeammate` 注册，所以房间成员的每次调用都被宿主以“only available to a teammate during a team run”拒绝（`lib/claude/plugin-tool-ipc.ts:989-1000`）。房间无法把工作交给任何人。
- **委派只有一个命令能创建。** `acceptDelegation`（`lib/execution/delegation.ts:121`）是 `delegation` 类型唯一的产生者，IM 的 `/delegate` 是它唯一的调用者。`team_delegate`、`dispatch_agent`、SDK `Task` 工具、插件 agent 派发、best-of-N 和 router-fusion 启动的子任务都到不了委派。T1 自动受理和 T2 `promoteDelegationToIssue` 从未实现。
- **IM 群的普通回复绕过了房间。** 它走 `runAndCapture`，不走 `RoomRunner`，所以房间说明和房间记忆默认值都不生效。`initialRoomMemoryFields` 没有调用者，IM 和共享房间从不会被创建成记忆关闭。`characterTeamId` 零命中：IM 群无法绑定角色团队。ADR-0177 的第 4、5 批大部分没做。
- **共享房间没有守卫。** `isLocallyOrchestratedRoom` 存在，但没人调用。`RoomRunner` 和 `room_send` 只检查 `kind === "team" && teamId`，从不问这个房间是否由协作服务器编排。

**同一件事被做了好几遍。**

| 关注点 | 份数 |
| --- | --- |
| 谁是谁的子任务 | 7：`executionRuns.parentRunId`、`backgroundTasks` 注册表（由 `lib/execution/job-bridge.ts` 反向投影）、`subagent-runtime-store`、`TeamDelegationRecord`、持久化团队子运行、`fusionDelegateSteps`、best-of-N 记录 |
| 启动 agent 子任务 | `dispatch_agent`（`lib/claude/agents/dispatch-run.ts`）、`team_delegate` 的后台模式（`delegation-orchestrator.ts`，904 行）、插件 `dispatchSubagent`、best-of-N `runExternalCandidate`、`ExternalAgentManager` 的四个调用方 |
| 停止子任务 | 5：`cancel-subagent`、`background-agent-manager.cancelAgent`、`cancelDelegation`、SDK `stopTask`、`control-handlers.ts` 里的 `job` 分支 |
| 子树嵌套 | 3：基于消息 part 的 `buildSubagentTree`、基于 store 记录的 `buildRuntimeTree`、SDK 桥的 owner 关联 |
| steer | 约 10 处：`control-handlers.ts` 的三个分支、`steerSession`、`steerDurableRun`、`steerIssueRun`、`live-steer.ts`、`routeSteer`、渲染进程队列，以及 CLI 里复制的 `STEER_PREFIX` 字面量 |
| 控制状态机 | 2：`squad/squad-control.ts`（自称“唯一的控制状态机”）和 `durable/durable-control.ts` |
| 回放安全判定 | 3：`packages/agent-orchestration/src/replay.ts`、`assessSquadRunReplay`、`isDurableChildReplaySafe` |
| 投票或评审团聚合 | 3：`consensus-orchestrator.ts`、`lib/ai/ensemble/run-ensemble.ts`、`patterns/judge-panel.ts` |
| 小队入口 | `startSquadRun` 有 11 个调用方，但 `action.team.run` 直接调 `runTeamLifecycle`，跳过 readiness、在跑运行检查和准入。`agentTeamManager` 作为它外面的一层外观仍有约十个调用方。 |
| 终态与活动判定 | 至少 4 份，分布在三种状态类型上 |
| 小队代码 | 两棵树：`lib/agent-team/` 和 `lib/ai/agent/team/` |

**委派**这个词有四种含义：运行类型、`TeamDelegationRecord`、`delegation-router`（基于规则的 agent 路由）、router-fusion 的 delegate 步骤。

**休眠代码。** 这片区域约有 50 个导出没有生产读者。逐项核对后分成：需要但从未接线（10 个）、已被另一份取代（6 个）、不需要（14 个）、只在本文件内使用（约 40 个）。另有 4 个被报为未使用的其实已经接线。

**早先 ADR 留下的未完成项。** ADR-0140 的两个延期项（与 Issues 共用一个看板组件、删除 `/agent-teams`）仍未完成。`/agent-teams` 只是重定向，`agentTeamsWorkspace` 命名空间还有 929 个 key。`lib/chat/room` 有四处从 `hooks/chat` 导入，ADR-0250 §14 禁止这样做。

## 决定

### 1. 三条轴，每条一个词

| 术语 | 是什么 | 不是什么 |
| --- | --- | --- |
| **房间（Room）** | 两个以上参与者的对话（ADR-0177）。成员在记录里发言。 | 执行器。房间把工作交出去（§4）。 |
| **小队（Squad）** | 有 lead、队员、任务看板和评审的执行器（ADR-0140、ADR-0169）。在发起它的对话里只是一条消息。 | 对话形态。小队从不以多个成员的身份在房间里发言。 |
| **委派（Delegation）** | 异步工作背后的承诺（ADR-0137、ADR-0247）：一张卡、一个负责人，比任何一次引擎尝试活得更久。 | 引擎、路由规则或工具。 |
| **子运行（Child run）** | 代表另一个运行启动的运行，用 `parentRunId` 关联到它。 | 保存在 `executionRuns` 之外任何地方的记录。 |

房间 supervisor 的 `<dispatch to>` 协议和小队 lead 的 JSON 计划保持分开。supervisor 决定对话里下一个谁发言，lead 为执行器规划任务。合并它们会让其中一方假装成另一方。

**用词。** `delegation` 只指这个运行类型以及属于它的东西。`TeamDelegationRecord` 变成子运行的投影，并相应改名。`delegation-router` 改为 agent 路由。router-fusion 内部保留 “delegate” 一词，类型和界面上叫 “step”。术语表条目在 `CONTEXT.md`。

### 2. 一棵子运行树

**`executionRuns.parentRunId` 是“谁是谁的子任务”的唯一记录。** 每个异步子任务都是 `executionRuns` 的一行：后台子 agent、插件 agent、外部 CLI agent、twin 回答、小队运行、best-of-N 候选、房间转交。ADR-0137 的权重不变：

| 权重 | 存在什么 |
| --- | --- |
| T0 | 这一轮及其轮内工作。在这一轮里运行的 SDK `Task` 子 agent 仍是消息 part，由 SDK 桥投影，不是运行。 |
| T1 | 工作活过这一轮时的一个 `delegation` 运行：`/delegate`、房间转交（§4）、自动受理（ADR-0247 §2）或 `delegation_accept`。引擎运行是它的子运行。 |
| T2 | 引用该委派的 Issue（ADR-0247）。 |

普通一轮的子任务如果没有活过这一轮（例如这一轮在等的后台 `dispatch_agent`），就是这一轮的子运行，不产生委派。

**在小队内部**，队员运行仍保存在持久化协调器自己的记录里（`packages/agent-orchestration`，ADR-0217）。它们是执行器的内部细节，就像工作流的步骤一样。小队运行本身是 `executionRuns` 里的一个 `team` 运行，委派或一轮对话指向的就是它。

**其他追踪器的去向：**

| 现在 | 变成 |
| --- | --- |
| `backgroundTasks` | 只做投递发件箱：等待送达父会话的已结束结果（§9、ADR-0249）。有运行支撑的条目，状态从运行读取。只有不是运行的 `shell-job` 和 `monitor` 条目保留自己的状态。 |
| `lib/execution/job-bridge.ts` | 删除。启动器自己写 `executionRuns` 行，不再反向投影。 |
| `subagent-runtime-store` | 基于 `executionRuns` 和实时进度事件的读模型，自己不持久化任何东西。 |
| `TeamDelegationRecord` | 子运行的投影，加上小队的审批与深度策略。 |
| `fusionDelegateSteps` | 不变。它们是一个 `fusion` 运行内部的 router-fusion 步骤日志。 |
| best-of-N 记录 | 分组和候选记录保留。每个候选都是分组运行的子运行。 |

**嵌套只有一条规则：** 节点的父节点就是它的 `parentRunId`。消息 part 树、设置里的运行时树和 SDK 桥都从同一个模块读这条规则。

### 3. 一个启动器，一种停止

**`launchChildRun`**（位于 `lib/execution/`）是启动子运行的唯一方式。它接收父运行 id、目标（`agent`、`external`、`twin` 或 `squad`）、一份 `AgentCapabilityGrantV1`（ADR-0198），以及它所属的委派（如有）。它写入运行行、关联父运行、启动引擎并记录派发延迟（`recordSquadDispatchLatency` 变成启动器的通用派发指标）。它的调用方：

- `dispatch_agent`（渲染进程和 CLI），
- `team_delegate`（在小队内部），
- 插件 Agent SDK 派发，
- best-of-N 候选，
- 房间转交，
- `/delegate` 和自动受理在需要新的引擎运行时。

`delegation-orchestrator.ts` 只保留小队策略：审批、深度和环检测。它们作为 `launchChildRun` 之前的守卫运行。

**停止子任务就是对它的运行做 run-control stop。** 五条取消路径合为一条，按类型分派给引擎。ADR-0244 要求停止证明的地方仍然需要引擎给出证明。

### 4. 房间把工作交给小队

- **成员提议。** 房间会话不再有 `team_*` 工具；这些工具只留给小队队员。房间成员改为拿到 `room_handoff_to_squad({ squadId?, brief })`。调用它会在房间里创建一张提议卡，不启动任何东西。
- **人来确认。** 房间里的人确认这张卡，在哪个界面都可以：桌面、手机、IM 或宿主的渠道。`roomSettings.squadHandoff: "confirm" | "auto"` 默认 `confirm`。`auto` 让调用立即启动运行，仍受房间的能力授权和风险策略约束。
- **确认后铸一个 T1 委派。** 它的来源是这一轮房间对话，小队运行是它经 `launchChildRun` 启动的子运行。小队默认是房间绑定的那个（§6），可以在卡上改选。
- **结果以一条消息返回。** 小队的结果作为一条折叠消息进入房间（ADR-0140 §6）。它通过 ADR-0249 的投递到达提议的成员，在房间 runner 的下一个轮次边界唤醒它。
- **卡上的 steer 和停止** 经 §5 作用于委派。

### 5. 一个 steer 入口，一台控制机

**steer。** 所有调用方都通过 run control 的 `steer` 来 steer：对运行中小队的聊天追问、IM `steer:`、卡片按钮、工具、Issue 唤醒以及 ADR-0249 的完成通知。run control 按类型分派给引擎（sidecar 的 `routeSteer`、持久化运行时、Issue 运行时、共享会话的协作服务器 `steerSessionRun`）。引擎保留，它们之上的入口合为一个。

**队列规则：人优先。** 与 ADR-0247 §6 和 ADR-0249 共用：
- **人的消息和任何停止都实时送达**，从不合并。
- **派生输入排队。** 评审、CI 结果、任务完成和唤醒在运行流式输出期间排队，在轮次边界合并成一份简报后放出。
- **人排在前面。** 在一个会话的队列里，人的轮次总是排在已排队的派生输入之前。

在 ADR-0248 的限流器落地之前，这条规则在会话内保证人优先；限流器落地后在会话之间也保证。steer 的文本规则（`STEER_PREFIX`、IM 前缀）只在一个模块里。`steer_degraded` 的含义不变（ADR-0137）。

**控制。** `durable-control.ts` 是唯一的控制状态机。`squad-control.ts` 里小队特有的部分变成它之前的守卫：遗留运行、readiness 和回放判定。回放判定只有一份，在 `packages/agent-orchestration/src/replay.ts`。`controlSquadRun` 和 `controlSquadTeam` 合为一个入口。

**入口。** `startSquadRun` 是启动小队运行的唯一方式，`action.team.run` 也走它。`agentTeamManager` 删除：调用方直接用 `startSquadRun`、控制入口或读模型。所有调用方用同一个 builder 构造 `startSquadRun` 的输入。

**best-of-N** 仍直接调用持久化协调器，因为它不是小队。它的候选是子运行（§2）。

### 6. 房间补完 ADR-0177

- **IM 群绑定角色团队。** 会话覆盖新增 `characterTeamId`。
  - **一个 bot。** 绑定了角色团队的群是 `im` 类型的房间，各角色通过连接器唯一的 bot 身份回复。每条回复都署上角色名，平台能渲染富内容时再加头像卡片头。
  - **多个 bot。** 允许多个 bot 身份的平台可以把角色映射到不同的 bot，但这个映射是可选的。
- **小队和角色团队可以同时绑定。** 现有覆盖字段 `teamId` 实为小队 id，改名为 `squadId`。
  - **两者都绑。** 角色团队负责对话，绑定的小队是 §4 的默认目标。
  - **只绑小队。** 每一轮都交给小队，与现在一致。
- **IM 群的普通回复走 `RoomRunner`**，因此房间说明、回复模式、静音和记忆默认值在每个平面上都生效。
- **默认值。**
  - **记忆关闭。** 创建 IM 或共享房间时应用 `initialRoomMemoryFields`。
  - **完整度。** 平台只给出人数或管理员时返回 `partial` 档。
  - **收件箱。** 收件箱区分群聊和私聊。
- **回复模式只有一个旋钮。** 收件箱的激活策略和 `roomSettings.replyMode` 合为一个设置。房间设置编辑器覆盖 IM 和共享房间，不只是团队房间。
- **共享房间靠检测，不靠开关。**
  - **检测。** 删除 `NEXT_PUBLIC_SHARED_CHAT_ENABLED`。配置了协作服务器且其 `/health` 报告受支持的协议时，共享房间可用。
  - **不可用时。** 入口说明不可用及原因（Rule 7）。本机偏好保留。
  - **设置。** 共享房间遵守 `roomSettings`。
  - **静默与追赶。** 静默判定写入审计，追赶卡片上线。
- **runner 拒绝不归它编排的房间。** `RoomRunner` 和 `room_send` 先检查 `isLocallyOrchestratedRoom`。共享房间只由协作服务器编排。
- **分层。** `lib/chat/room` 不再导入 `hooks/`。它需要的 steer 队列、流合并和有效 cwd 辅助函数移到 `lib/`。

### 7. 这片区域只有一套状态词汇

小队运行、子运行、委派和房间成员运行使用 `ExecutionRunStatus`，以及一个基于 `EXECUTION_TERMINAL_STATUSES` 的终态/活动判定模块。小队协调器的状态在一处映射过去。这片区域之外的状态类型（工作流运行、router-fusion、插件契约的公开类型）留给 ADR-0250 阶段 3 的其余部分。

### 8. 一个聚合模块

计票、阈值、胜者和评审团结论合并放在一个没有 `@/` 导入的纯模块里：`packages/agent-orchestration/src/aggregate.ts`。小队共识、工作流 ensemble 节点、ultracode 评审团和 council 都读它。四个界面各自的语义不变。某个界面的现有行为与共享规则不同的，要么保留并在模块里写明，要么核实哪种正确后去掉，绝不悄悄抹平。

### 9. 经修订的 ADR-0247 和 ADR-0249

**采纳 ADR-0247 的 §1 到 §9 全部内容**，包括 handback 和观察日志。观察日志需要为 `workObservations` 升 Dexie 版本。修订：
- **子运行。** 它所说的“引擎运行”就是 §2 的子运行，经 §3 的启动器启动。
- **steer。** 它 §6 的投递使用 §5 的 steer 入口和队列规则。
- **范围。** 自动 T1 受理保持 ADR-0247 规定的范围：常驻宿主、绑定 IM 的会话、GitHub 触发的工作。桌面普通对话不自动受理，因为人就在场，会话本身就是载体。显式的异步工作（房间转交、`delegation_accept`、`/delegate`）在每个宿主上都会铸委派。
- **实时权限检查要等 ADR-0243** 的 2B 到 2D 阶段。在那之前：
  - 检查报告 `live_authority_unavailable`；
  - 影子模式下这是一条 `mandate.would_park` 回执，运行继续；
  - 该检查不可用时，工作区不能切到 `mandateEnforcement: "enforce"`，因此强制模式下的启动绝不会在缺少这项检查的情况下放行。

  把任何工作区切到 `enforce` 不在本次范围内，需要 ADR-0247 所要求的影子证据。

**采纳 ADR-0249。** 修订：
- **发件箱。** 它的日志就是 §2 的投递发件箱。
- **类型。** `shell-job` 和 `monitor` 是发件箱里两个不是运行的类型。
- **唤醒。** 它的唤醒是 §5 队列规则下的派生输入。
- **房间转交。** 房间转交的结果走同一条投递。

**本 ADR 不采纳 ADR-0248。** 它仍挂在 ADR-0250 阶段 1 的限流器上。

### 10. 代码放在哪里

- **小队代码移到 `lib/squads/`。** `lib/agent-team/` 和 `lib/ai/agent/team/` 在一次只做搬迁的提交里合并过去。同一规则下还有两处搬迁：`stores/agent/agent-team-store` 移到 `stores/squads/`，`components/agent/workspace` 移到 `components/squads/`。这些是 ADR-0250 §14 为模块 id `squads` 定的默认路径。ADR-0250 M1（`4333cfabc0`）已经建立了 `lib/squads/` 和 `components/squads/`，其中有模块清单、搜索提供方和斜杠命令，搬来的文件沿用原名并入。搬迁同样遵守 M1 的门禁：`agent-team` 归属行及其 `lib/ai/agent/team/` 覆盖在目录清空后删除；G2 边指纹只有在数量不增长时才重写基线。
- **委派留在 `lib/execution/`**，属于运行账本，是内核。
- **房间留在 `lib/chat/room/`。**

每次搬迁前都确认没有其他会话在被移动的路径下持有未提交的修改。

### 11. 清理

- **ADR-0140 的延期项。**
  - 小队看板和 Issues 看板共用一个组件、一个看板模型。
  - 删除 `/agent-teams` 并更新界面契约。
  - 把 `agentTeamsWorkspace` 拆进仍在使用它的命名空间，删除无用的 key。
- **删除没人读的持久化字段**，并升 persist 版本：`displayMode`、`workspaceTab`，以及 `agent-runtime-store` 上的三个降级镜像字段。降级窗口已关闭。
- **休眠导出按计划里的判定表处理。** 每一个都接线、合并、删除或改为内部；接线的项随测试一起交付（Rule 7）。
- **过时的文字一并更正。** 描述了不存在调用方的注释和文档，在同一次改动里修正。

## 后果

- **房间成员可以请求干活**，并在房间里看到它完成。那些总是失败的工具没有了。
- **一棵运行树，一个问题一个答案。** “这个运行启动了什么？”“它下面还有东西在跑吗？”“把它全停掉”，每个问题都只从一张表得到一个答案。
- **每个宿主上的每次异步转交都会出现委派卡片**，不只是 IM 里的 `/delegate`。回答和轮内子 agent 仍不产生卡片。
- **steer 和停止的行为与界面、引擎无关。** 人永远不会排在一条评审意见或一个完成的任务后面。
- **部分旧的本地数据不迁移：** 内存里的子 agent store、`TeamDelegationRecord` 数据块和旧的 `backgroundTasks` 状态。升级时正在进行的后台工作，能从引擎对账的就对账，否则标记为中断。
- **ADR-0250 阶段 3 缩小。** 剩下的是其他运行类型的账本引用，以及这片区域之外的状态词汇。

## 修订

- **ADR-0137。** 子运行只由启动器创建，每次异步转交都可以是委派（§2、§3）。steer 入口见 §5。T2 升级属于 ADR-0247。
- **ADR-0140 / ADR-0169。**
  - 小队代码位于 `lib/squads/`。
  - `agentTeamManager` 和第二台控制机删除。
  - `action.team.run` 走唯一入口。
  - 延期项关闭。
  - 房间经 §4 到达小队。
- **ADR-0177。**
  - 第 4、5 批按 §6 补完。
  - 房间成员不再有 `team_*` 工具。
  - IM 群可绑定 `characterTeamId` 和 `squadId`。
  - runner 检查 `isLocallyOrchestratedRoom`。
- **ADR-0247、ADR-0249。** 按 §9 的修订采纳。
- **ADR-0250。** 阶段 3 中多 agent 的部分在这里交付（§7、§9）。M1 建立的 `squads` 模块接收其余的小队代码。
