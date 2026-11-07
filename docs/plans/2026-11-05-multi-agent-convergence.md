# 多 agent 收敛实施计划：房间、小队、委派

状态：计划已定稿，未开始实施。创建：2026-11-05（Asia/Shanghai）。

上游：

- 决策：[ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md)
- 采纳并修订：[ADR-0247](../content/docs/en/adr/0247-long-lived-work-carries-a-mandate-and-follows-its-threads.md)、[ADR-0249](../content/docs/en/adr/0249-a-background-jobs-completion-reaches-the-agent.md)
- 修订：ADR-0137、ADR-0140、ADR-0169、ADR-0177、ADR-0250
- 证据：2026-11-05 的四路只读审计（Squad 运行时、委派路径、房间、跨区重复与死代码）和逐项休眠导出核对。下文路径取自 `dev` 的 `03d7e75b43`

实施方式：

- 全部由 Claude 编写，不交给 Codex。
- 在共享工作区里改。每次提交只用 `git commit --only <paths>` 或显式 `git add <paths>`。提交前 `git diff --cached --name-only` 核对，只含本任务的文件。
- 每个阶段单独提交（或一组提交），并在 `docs/evidence/2026-11-05-multi-agent-convergence.md` 记一条台账（evidence-driven-dev 格式）。
- 面向用户的改动带 changeset（`cognia-next`）。纯内部的阶段（P1、P2 中的删除）不带。

## 0. 不变式

整个计划里任何时候都必须成立：

1. **三条轴不混。** 房间是对话形态，小队是执行器，委派是承诺。房间 supervisor 协议和小队 lead 协议不合并。
2. **编排只在持有运行的宿主上执行。** 其他端（手机、companion、TUI）只投影。五个宿主行为一致：桌面、headless 宿主、配对手机/companion、IM、CLI/TUI（CLI/TUI 只要求能发起和观察）。
3. **人优先。** 人的消息和停止实时送达，不合并；派生输入在轮次边界排队；会话队列里人的轮次排在派生输入前面。
4. **不简化。** 不留桩、不留 `// TODO`、不剥错误处理。做不到的写成阻塞项。
5. **依赖方向（ADR-0250 §14）。** `lib/` 不导入 `hooks/` 或 `components/`；不新增 barrel。
6. **休眠三轴（Rule 7）。** 任何仍处于关闭或影子状态的能力（`mandateEnforcement: "shadow"`、`workObservation: "off"`、`squadHandoff: "auto"` 以外的默认值等）同时在类型上写明、在 UI 上标注、由测试固定。

## 1. 阶段与验收

| 阶段 | 内容                                                                      | 结束时                                                               |
| ---- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| P0   | ADR-0252、相关 ADR 的修订注、本计划、`CONTEXT.md` 术语                    | `pnpm docs:build` 通过；文档提交                                     |
| P1   | 小队代码搬到 `lib/squads/` 等默认路径                                     | 只搬迁、无行为变化；typecheck 和受影响单测通过                       |
| P2   | 休眠导出处理（删除/改内部/合并的部分）、小重复、共享房间守卫缺陷          | 判定表中 P2 的行全部完成；守卫缺陷有由红转绿的测试                   |
| P3   | 统一状态词汇、单一子运行树、`launchChildRun`、单一停止、单一嵌套规则      | 七套追踪器只剩 `executionRuns.parentRunId`；`job-bridge.ts` 删除     |
| P4   | 单一 steer 入口与队列规则、控制状态机合并、ADR-0249                       | 一个 steer 入口；一台控制机；后台 job 完成能唤醒 agent               |
| P5   | 绕过路径、删除 `agentTeamManager`、`startSquadRun` 输入 builder、聚合模块 | `action.team.run` 走 `startSquadRun`；外观删除；聚合只有一份         |
| P6   | 房间→小队转交，删除房间里的 `team_*` 工具，`lib/chat/room` 分层           | 房间成员能提议、人确认后小队运行并回流到房间                         |
| P7   | ADR-0177 第 4、5 批                                                       | IM 群绑定角色团队；共享房间改为检测；回复模式一个旋钮                |
| P8   | ADR-0247 §1–§6、§8、§9（§7 的结构和影子部分）                             | T1 自动受理、T2 升级、follow、线程事件、续接会话、handback、观察日志 |
| P9   | 看板共用、删除 `/agent-teams`、拆分 `agentTeamsWorkspace`、改名           | ADR-0140 的延期项关闭；命名按 ADR-0252 §1                            |
| P10  | ADR-0247 §7 的实时权限检查                                                | 等 ADR-0243 2B–2D 落地后接入；`enforce` 才允许开启                   |
| 收尾 | 真机冒烟                                                                  | 桌面 Tauri、手机、飞书真机冒烟全部通过并记入台账                     |

顺序理由：先搬迁和清理，降低后续 diff 的噪音；子运行树先于 steer、ADR-0249 和 ADR-0247，因为它们都建在它之上。

## 2. 验证规则（每个阶段）

- 只跑受影响的单测：`pnpm test -- <paths> --runInBand`（经 `scripts/test/jest.mjs`，不要 `-t` 陷阱，不跑全量，不跑覆盖率）。sidecar 改动跑 `pnpm sidecar:test` 的相关文件。
- `pnpm typecheck`（需要 16 GB 堆）。
- 触及的门禁：`pnpm audit:colocated-tests`、`pnpm lint:i18n` + `pnpm i18n:build:check`、`pnpm audit:sidecar-architecture`（改 sidecar 时）、`pnpm audit:rust-architecture`（改 Rust 时）、`pnpm docs:build`（改文档时）。
- 关键阶段（P4、P6、P7、P8）用 aiden 代理的真实模型（`http://127.0.0.1:8787/v1`，`ark-deepseek-v4.1-flash`）跑 headless 冒烟，记录到台账。
- 提交前跑 `preflight` 技能的六个审计；新增模块必须过 `wiring-auditor`。
- 不追 CI。

## 3. P0：文档

- `docs/content/docs/{en,zh}/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md`，两个 `meta.json` 登记。
- ADR-0137、0140、0169、0177、0250 加 “Amended by ADR-0252” 注；ADR-0247、0249 改为 Accepted 并加修订注。双语。
- `CONTEXT.md` 新增 “Multi-agent work” 术语：Room、Squad、Delegation、Child run。
- 本计划。
- 验收：`pnpm docs:build` 通过。

## 4. P1：搬迁

**范围：**

| 现在                               | 搬到                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/ai/agent/team/**`             | `lib/squads/**`（子目录结构保留：`squad/`、`durable/`、`teammate/`、`gates/`、`patterns/`、`workers/`、`ultracode/`、`auto/`、`delivery/`、`ledger/`、`memory/`、`pr-feedback/`、`workflow-nodes/`、`workspace/`） |
| `lib/agent-team/**`                | `lib/squads/`（与上面的文件同名时先停下来比对，不覆盖）                                                                                                                                                            |
| `stores/agent/agent-team-store/**` | `stores/squads/agent-team-store/**`（persist 的 storage key 不变）                                                                                                                                                 |
| `components/agent/workspace/**`    | `components/squads/**`                                                                                                                                                                                             |
| `hooks/squads/**`                  | 不动（已是默认路径）                                                                                                                                                                                               |

**M1 已落地（`4333cfabc0`）：** `lib/squads/` 已有 `module.ts`、`search-provider.ts`（原 `lib/global-search/providers/squads.ts`）、`slash-command.ts`（原 `lib/slash-commands/actions/squad.ts`）及测试；`components/squads/` 已有 `module.ui.ts` 和一批组件。这些文件名保持不变，搬入的文件遇到同名先停下比对。

**步骤：**

1. `git status --short -- <上述路径>` 必须为空；有其他会话的未提交改动就暂停，告知用户。
2. `git mv` 搬迁。用脚本改写所有 `@/lib/ai/agent/team/`、`@/lib/agent-team/`、`@/stores/agent/agent-team-store`、`@/components/agent/workspace/` 导入以及 `jest.mock` 路径和动态 `import()`。
3. 模块门禁（ADR-0250 M1）：
   - `scripts/gates/module-ownership.json`：清空后删除 `lib/ai/agent/team/` → `agent-team` 的路径覆盖和 `agent-team` 行（G1 不允许无文件的行）；`lib/squads`、`components/squads`、`hooks/squads`、`stores/squads` 由清单拥有。
   - 搬迁后跑 `node scripts/gates/check-modules.mjs`；若新出现的 G2 边只是搬迁文件原有的边换了路径，用 `--write-baseline` 重写，`scripts/gates/modules-baseline.json` 的计数不得增长。
   - 生成的注册表（`lib/modules/generated/host.ts`、`components/modules/generated/ui.ts`）被 gitignore，永不暂存。
4. 同步更新：`CLAUDE.md` 子系统表的 Agent Team 行、`scripts/gates/` 里写死的路径（`colocated-test-baseline.json`、headless registry、host parity 等）、`lib/runtime/surface-contract.ts`、文档里的路径引用。
5. 验收：`pnpm audit:modules` 通过；`rg "lib/ai/agent/team|lib/agent-team/|components/agent/workspace|stores/agent/agent-team-store"` 只剩 ADR 和历史计划里的引用；typecheck 通过；搬迁涉及的测试套件全部通过；`audit:colocated-tests` 通过。

**陷阱：** `patterns/index.ts` 由 `agent-team-runtime.ts:1133` 动态加载，路径字符串要一起改；`packages/plugin-contract` 和 `cli/` 里若有相对路径或文档链接也要搜。

## 5. P2：休眠导出与小重复

### 5.1 休眠导出判定表

判定已由用户确认。“阶段”列是落地的阶段。

**接线（WIRE）：**

| 符号                                                             | 接到哪里                                                                                                | 阶段 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---- |
| `initialRoomMemoryFields`（`lib/chat/room/settings.ts`）         | `createPlatformSession`（`lib/connectors/session-bindings.ts:246`）创建 IM 群房间时，以及共享会话导入时 | P7   |
| `reviseDelegationPlan`（`lib/execution/delegation.ts`）          | `/delegate` 在 adopt 之后、自动受理和房间转交拿到规划结果时，发出 `plan.created`                        | P8   |
| `listDelegationChildren`                                         | 成为委派子运行的唯一查询；`delegation-bridge.ts:77,128` 改用它                                          | P3   |
| `steerSessionRun`（`lib/collab/client.ts:1648`）                 | steer 入口对共享会话的分派目标（服务端 `chat_api.rs:348` 已有）                                         | P4   |
| `resolveMemberConfig`（`lib/claude/build-options.ts`）           | 替换 `build-options.ts` 约 `:1892`、`:2387` 处内联的同一合并逻辑（先核对 IM 覆盖行的形状）              | P2   |
| `isLocallyOrchestratedRoom`（`lib/chat/room/kind.ts`）           | `RoomRunner` 入口和 `room_send` 分支的守卫（见 5.3）                                                    | P2   |
| `isAgentTeamDispatchPart`、`isSquadRunPart`、`isSquadGatePart`   | `components/chat/message-renderer.tsx:2351,2357,2361` 用守卫代替字符串比较                              | P2   |
| `listAllTeamSubagentIds`                                         | `workflow-template-registry.ts:50-56` 和 `capability-audit.ts:116-119` 共用它构造子 agent id 集合       | P2   |
| `getInstanceCapabilityWarnings`、`getTeammateCapabilityWarnings` | 小队设置、队员行和运行前同意界面显示能力告警（`agent-team-runtime.ts` 约 L582 的注释承诺了这个读者）    | P2   |
| `recordSquadDispatchLatency`                                     | 改为 `launchChildRun` 的通用派发延迟指标                                                                | P3   |

**合并（MERGE）：**

| 符号                       | 并入                                                                                   | 阶段 |
| -------------------------- | -------------------------------------------------------------------------------------- | ---- |
| `requestCancelSubagentRun` | `requestCancelSubagentRunAndWait`，再并入统一停止                                      | P3   |
| `resolveTeamCapabilities`  | `resolveTeammateCapabilities` 的团队池步骤；同时修正 `capabilities-and-plugins.mdx:59` | P2   |
| `migrateSquadTemplate`     | `stores/agent/agent-team-store/store.ts:263-270` 改为调用它                            | P2   |
| `hasActiveDelegationChild` | 基于 `currentDelegationAttempts` 的单一辅助函数，`delegation-bridge.ts:128` 使用       | P3   |
| `buildRunPrFeedback`       | `promoteDelegationToIssue`（ADR-0247 T2）                                              | P8   |
| `useTeamChat().stopMember` | `stopRoomMember`（`lib/chat/room/stop-member.ts`）                                     | P2   |

**删除（DELETE），连同测试：** `squadRunTraceId`、`isLiveSquadRunStatus`、`validateInstanceCapabilities`、`controlDurableRuns`、`completeExternalDelegation`（同时改 `consensus-delegation-memory.mdx:102`）、`planUserTurn`（同时改 `runner.ts:31`、`types.ts:29`、`room-target-picker.tsx:49` 的过时注释）、`liveSubagentRunCount`、`getInflightController`、`indeterminateSubagentProgress`（连同其头注释）、`listTeamMembers`（同时改 `build-options.mdx:26`）、`ensureTeamPrObservationsReady`、`carriesLegacyRuntimeSelector`、`isOnCurrentSquadContract`、`lib/chat/room/index.ts`（barrel）。持久化字段 `displayMode`、`workspaceTab` 在 P9 随 persist 版本删除。

**只去掉 export（KEEP-INTERNAL）：**

- 小队状态：`LIVE_SQUAD_RUN_STATUSES`、`TERMINAL_SQUAD_RUN_STATUSES`、`isSettledSquadRunStatus`（P3 统一状态词汇时会被替换）。
- 生命周期：`ensureConfiguredSquadRuntimeDeps`、`bindSquadStoreReader`、`bindSquadStoreWriter`、`RESUME_SKIP_STATUSES`、`SQUAD_NOT_READY_REASON`。
- 评审门：`settleSquadReview`、`sanitizeDecision`、`squadReviewRequestId`、`squadReviewInterruptIdFor`、`SQUAD_REVIEW_CHANNELS`。
- 守卫：`looksLikeIdleAckOnlyText`、`stableJitterMs`、`replanNewTaskSchema`、`replanNewMemberSchema`、`isHeadlessOrigin`。
- 委派策略：`assertTeamDelegationDepth`、`activeTeamDelegationDepth`、`wouldCreateTeamCycle`（P3 后作为 `launchChildRun` 前的守卫，仍是内部）。
- 持久化运行时：`durableTeamSpec`、`appTeamPathPolicy`、`fleetTeamRemoteSessions`、`redactTeamTextForPersistence`。
- 失败回退（设计如此）：`heuristicAssessment`、`heuristicRoster`、`heuristicTasks`。
- 其他小队辅助函数：`auditAllAgentTeamsCapabilities`、`integrationBranchName`、`orderByDependencies`、`classifyTeamTaskAccess`、`expertiseMatchScore`、`teammateCharacterId`、`createGithubDeliveryAdapter`、`declineGithubStackPublish`、`decodeRemoteWorkerPolicy`、`progressLedgerVerdictSchema`、`compareTemplateVersions`、`catalogRowsFor`。
- 子 agent：`resolveSubagentDispatchVerdict`、`resolveDispatchWidth`、`releaseDispatchBudgetForSession`、`loadNesting`、`frameSteerQueue`、`formatToolLine`。
- 房间：`clampInstructions`、`speakerHandle`、`sanitizeSpeakerLabel`、`handoffParagraph`、`nonTextPartMarkers`。
- 例外：被测试直接导入的符号（如 `tallyVotes`、`computeWinner`、`thresholdMet` 这类文档化的测试缝），改为通过公开函数测试；做不到时保留 export 并在注释中写明是测试缝。`__*ForTesting` 不动。

**已接线（误报，不处理）：** `renderProposalDoc`、`toolDisplayName`、`listPendingAgentTeamSteering`、`backfillLegacyTeamRun`。

**`agent-runtime-store` 的三个 `@deprecated` 镜像字段**（`runtime`、`externalAgentId`、`externalHostConfig`）：降级窗口已关闭，P9 随 persist 版本删除 `legacyMirrors` 与 `refFromLegacyFields`。

### 5.2 小重复

- workflow 小队节点参数：`lib/workflow/nodes/params-schemas.ts:387-425` 的 zod 是唯一来源，`workflow-nodes/team-ops.ts:21-56` 的手写接口改为 `z.infer`。
- composer 的 `roomReplyHint`（`components/chat/composer/room-target-picker.tsx:49-63`）改为调用 `holdReasonFor`（`lib/claude/team-router.ts:204-212`）。
- `use-team-chat.ts` 里写了三遍的 companion 错误处理（`:181-189`、`:363-373`、`:394-404`）合为一个函数；companion `stop` 复用 runner 的 steer 清理。
- `MAX_AUTO_ROUNDS` 从 `team-primary-router.ts` 移到房间设置模块（`lib/db/teams.ts:8`、`teams-section.tsx:29` 改导入）。
- `agent-team-compat.ts` 只剩 normalizer：按内容改名为 `agent-team-normalize.ts`。

### 5.3 共享房间守卫缺陷

1. 先写复现测试：构造一个带 `collaboration` 的会话，经 `getHostRoomRunner().sendRoomTurn` 和 `room_send` 分支提交一轮，断言当前会进入本地编排（红）。
2. 在两个入口加 `isLocallyOrchestratedRoom` 守卫：共享房间返回明确的拒绝（错误码 + i18n 文案），不进入本地 runner。
3. 测试转绿；带 changeset（patch）；单独提交。
4. 如果复现测试证明当前已被别处拦住（例如会话转换处拒绝），在台账记下证据，守卫仍然加上，作为入口的显式约束。

## 6. P3：一棵子运行树与一个启动器

### 6.1 状态词汇

- 执行运行的终态判断沿用契约里已有的 `isTerminalRunStatus`（`@/types/execution/run`），不再另写一份。
- 小队运行和子运行的词汇放在拥有 `AgentTeamRunStatus` 的包里：`@cognia/agent-orchestration/rules` 的 `isTerminalTeamStatus`、`isParkedTeamStatus`、`teamRunOutcome`（`terminated` 对调用方报 `cancelled`）。协调器和 replay 规则也用它。
- 新增 `lib/execution/run-status.ts`：`isLiveRunStatus`（终态的补集）、`isSettledTeamRunStatus`，以及小队运行落定后写入执行日志的唯一事件映射 `executionEventForSettledTeamRun`。
- 替换：`lib/execution`、`lib/squads`、`lib/issues/run/agent-team-adapter.ts` 里所有手写的终态列表和 `terminated → cancelled` 换算；删除 `isTerminalSquadRunStatus`、`LIVE_SQUAD_RUN_STATUSES`、`TERMINAL_SQUAD_RUN_STATUSES`、`isSettledSquadRunStatus`、`SETTLED_EXECUTION_RUN_STATUSES`。
- 不动：`lib/agent/squad-presence.ts` 读的是小队定义的 `TeamStatus`（planning/executing），不是运行状态；`mapLegacyRunStatus` 和 `monitor-model.ts` 的 `mapRunStatus` 映射的是工作流的 `RunStatus`。三者都在本区域的状态类型之外。`subagent-runtime-store` 的子 agent 状态由 6.3 改成读模型时处理。

### 6.2 `launchChildRun`

新增 `lib/execution/launch-child-run.ts`（内核）。按实际实现：

```ts
interface LaunchChildRunInput {
  parentRunId?: string
  delegationRunId?: string // 属于某个委派时，它就是父运行
  target:
    | { kind: "agent"; prompt: string; systemPrompt?: string; background?: JobCenterEntry }
    | {
        kind: "external"
        agentId: string
        prompt: string
        systemPrompt?: string
        workingDirectory?: string
        timeoutMs?: number
      }
    | {
        kind: "twin"
        twinId: string
        question: string
        systemPrompt?: string
        background?: JobCenterEntry
      }
    | { kind: "squad"; squadId: string; brief: string; origin: string; ultracode?: boolean }
  grants?: readonly AgentCapabilityGrantV1[] // ADR-0198，与 executeAgent 一致是数组
  sessionId?: string // 缺省取父运行的会话
  title: string // id 或固定短语，不放提示词
  childId?: string
  surface?: SpanSurface
  signal?: AbortSignal // 停止：引擎启动前中止则什么都不启动
}
// → { started: true; childId; executionRunId; outcome: Promise<ChildRunOutcome> }
//   | { started: false; reason: "parent_not_found" | "grant_not_honoured" | "engine_unavailable" | "engine_refused" | "journal_failed" | "cancelled"; detail? }
```

- 结果契约 `types/execution/child-run.ts`：`ChildRunOutcome { status: completed|failed|cancelled; text?; error?; timedOut? }`、`StartedChildEngine { outcome; stop }`。文本和错误只交给调用方，不进 journal，不进 span。
- 引擎：`agent` → `executeAgent`、`external` → 托管主机上先 `placeDispatchedAgent`，再在截止时间内调 `ExternalAgentManager.execute`，这两个都是内核导入。`twin` 和 `squad` 是模块拥有的能力，走端口：`types/modules/ports/twin-answer.ts`、`types/modules/ports/squad-launch.ts`，由 squads 清单 `provides` 提供（`lib/squads/ports/`）。twin 端口在 twin 模块有清单后迁过去，契约不变。
- 行的写入：`agent`/`external`/`twin` 由启动器先写 `execution:job:<childId>`（`startToolExecutionRun`，`parentRunId` 加上从父运行继承的身份），然后才登记到 Job Center、启动引擎。这样 `job-bridge` 的投影会找到已有行，不会写出无父的行（它在 6.3 删除）。最后由启动器按结果落定。`squad` 的 `team` 行由小队运行在自己的事务里写：`startSquadRun` / `createSquadRunRecords` 新增 `launchedByRunId`，写成父链接和 `child` 身份，不带替换语义。同时有 `parentRunId`（替换）时以替换为准。替换查找改为只认同一小队的 `team` 子行，被启动的其他小队子运行不再被误判成替换。
- 父运行必须存在，否则拒绝（`parent_not_found`），不会挂一个悬空链接。
- 授权：每个引擎声明自己应用哪些授权字段（`agent`、`twin` 全部；`external`、`squad` 一个都不应用）。授权设了引擎会忽略的字段时，在写任何东西之前拒绝（`grant_not_honoured`）。
- 派发延迟：每个子运行在落定时发一条完成的 agent-trace span（`invoke_agent`，provider `cognia.subagent|external|twin|team`，`handoff` 从父到子，`child.dispatch` 事件带 `latencyMs`），只带 id 和代码。`recordSquadDispatchLatency`（无生产调用方）删除。
- 本切片迁移：`delegation-orchestrator.ts` 的 background/external/twin/team 四个分支全部走 `launchChildRun`。编排器只留安静时段、审批、深度、环检测，以及记录和钩子。父运行：调用方给出且存在的运行（工作流节点传 `execution:workflow:<runId>`）优先，否则用来源小队的 live 运行行，否则无父。取消统一由 `AbortController` 交给启动器，不再分别调 `cancelAgent` / `abortTeam`。顺带修复：安静时段推迟的 team 委派在批准后会真正启动（原来批准后什么都不跑）。
- `dispatch_agent`（`startDispatchRun`，Job Center 重跑和启动时自动恢复的 `background-tasks/redispatch.ts` 也经过它）已迁移：重试、子树预算、截止时间、审批路由和 Job Center 日志是调用方自己的策略，作为启动器的调用方引擎（`target: { kind: "agent", engine, label }`，不应用授权）。行的写入、父链接、落定和派发 span 由启动器负责。固定的父运行行已不存在时用 `missingParent: "unparented"` 无父启动，保持原来的语义。租约在启动前丢失时什么都不启动（原来会带着已中止的信号去派发）。
- 插件 Agent SDK 已迁移：`dispatch_agent` 之外启动子 agent 的入口（插件 `ctx.agent.dispatchSubagent`、托管 IDE broker 的 `invokeAgent`、外部桥 `agent_dispatch`）改走新的 `dispatchSubagentAsChildRun`。它把 `dispatchSubagent` 作为调用方引擎交给启动器，结果和抛出的错误与原来完全一致；行默认无父，调用方可传父运行和会话。外部桥按 `characterId` 运行的分支同样作为调用方引擎，保留 channel、finishReason、usage。`dispatchSubagent` 本身仍是引擎（`dispatch_agent` 在调用它），不自己写行。`runTeam` 改为 `squad` 目标，经端口走 `startSquadRun`，返回运行的结果状态；`options.origin` 原来被忽略（一律 `plugin`），现在照传，外部桥的运行记为 `external`。CLI TUI 的 `dispatchSubagent` 调用不迁移（D13，X5）。
- best-of-N 已迁移：每个候选（Cognia 与外部 `runExternalCandidate` 两条通道）的一次尝试（`dispatch.run`）作为启动器的调用方引擎，预算检查、用量记账、变更集捕获和错误都留在尝试里。启动器在候选自己的会话里写 `execution:job:<candidateId>`，父运行是分组的持久团队行（`execution:team:<teamRunId>`，由协调器 `prepareRun` 写出），父行不存在时拒绝，候选在尝试前失败。候选授权仍交给 `resolveSendOptions`，引擎不应用授权。顺带修复：分组行原来停在 `queued` 永不落定，现在 `finish` 按分组结果落定（需要人处理的分组记为 `recovery_required`）。

### 6.3 追踪器收敛

- `lib/background-tasks/` 已改为投递箱：渲染端条目不再保存 `status`，只保留投递字段（父会话、结果、批次身份、投递状态、重放凭据）和投递箱自己的两个事实：`settledAt`（结果已记录）、新增的 `interruptedAt`（结果到达前宿主已停止）。`listBackgroundTaskRecords` / `getBackgroundTaskRecord` 联接 `execution:job:<runId>` 得出 `status`：宿主停止为 `interrupted`；结果未记录或运行未结束为 `running`；运行完成为 `done`，否则 `error`；没有运行行（启动被拒）的按结果判断。租约围栏、重放、投递、清理只读投递箱事实。CLI 条目继续保存状态（D13）。不升 Dexie 版本：渲染端条目不再进入 `status` 索引，索引继续服务 CLI 条目；更新时清除旧行残留的状态。旧数据不迁移（X11）。
- 已删除 `lib/execution/job-bridge.ts` 及测试。桥原来独占的两件事已迁走：插件 `ctx.agent.run` / `runStreamed`（`lib/plugin/agent-sdk/run.ts`）改为启动器的调用方引擎（独立行，标题为 label 或 agent id，Job Center 登记保留用于取消）；启动时被中断的渲染端任务，由启动对账（`interruptBackgroundTasksOnBoot` 的 `onInterrupted`）把对应 `execution:job:<runId>` 行落定为 `cancelled`，所有者未知的也算。父运行解析：admission pin 早已经 `dispatch_agent` 传给启动器；桥对非 subagent 行按会话推断父运行的逻辑从未生效（这些行都不带会话），不迁移。没有 `backgroundTasks` 条目的启动器行（调用方引擎、非后台 twin/external）在宿主重启后的对账见 6.5（X10，已修复）。
- `stores/agent/subagent-runtime-store` 已改为读模型：持久化部分只保留 `templates`；条目的实时进度来自两个引擎的事件；有 `execution:job:<id>` 行的运行，状态取自该行（`runs`，由 `run-projection.ts` 维护：对跟踪中的 id 发一条 live query，store 有第一个条目时启动，没有 IndexedDB 时不启动），`upsert` / `setStatus` 不能把条目改离运行行的状态。只有没有运行行的条目（轮内 SDK `Task`、启动前被拒的派发）用引擎上报的状态；运行行为 `failed` 时保留引擎报的 `timeout`。聊天卡片没有实时条目时跟随运行行（刷新后不再永远显示运行中）。契约类型 `SubAgent` 不变。
- `TeamDelegationRecord` 已改为子运行投影 + 小队策略字段：记录只保留小队知道的事（原因、目标、审批、准入时的深度 `metadata.delegationDepth` / `delegationChain`、子运行交回的文本），启动后通过 `metadata.executionRunId` 链接子运行行。`lib/squads/delegation-view.ts` 的 `projectDelegation` 把行状态映射到委派词汇：未结束为 `active`，并在 `queued`/`waiting`/`paused`/`recovery_required` 时给出 `runStatus`；结束取行的结果，截止时间超时仍记为 `timeout`（行只能记 `failed`）；运营者的取消和启动前的策略状态（等待审批、拒绝）以记录为准。失败原因统一显示为 `error`（原来面板只读从未写入的 `error`，失败原因从不显示）。`delegations-panel.tsx` 对已链接的子运行发 live query 并读投影。深度和环检测改走运行树（见 6.4 `run-tree.ts`）：子运行之上各 `team` 运行的小队（`squadIdForTeamRun`：运行记录，否则开场事件）加上来源小队，再沿运行树看不到的边（等待审批、仍在启动的委派）向上延伸；目标在链上或经这些边能到达链上的小队即为环；链长即子运行深度。仅凭 store 能判断的拒绝（自委派、未上树的边构成的环或超深）同步返回失败记录；运行树的检查在启动时进行（批准后也会重查），被推迟的委派在创建时也查一次，永远无法运行的直接失败。`HandoffEnvelope` 在启动时才附上，两端都是真实运行 id：`parentRunId` 为子运行挂靠的运行，`childRunId` 为子运行行，`parentChain` 为根到父的运行 id，`depth` 为链长；没有父运行的委派不附 envelope（X7 关闭）。改名留到 P9（见命名表）。
- best-of-N：候选写子运行行，分组运行为父（已在 6.2 完成）。

### 6.4 单一嵌套规则与单一停止

- 已新增 `lib/execution/run-tree.ts`（随 6.3 的委派投影一起落地）：通用的 `buildTree` / `flattenTree`（缺父成根，环被打断，每项只放一次），行上的 `childrenOf`、`buildRunTree`，以及按 `parentRunId` 索引读取的 `readRunAncestors`（近到远，遇缺失父行、环或 `MAX_RUN_TREE_DEPTH` 停止）和 `readRunSubtree`。规则只有 `parentRunId`。委派的深度和环检测在用它；`lib/claude/subagent-tree.ts`（聊天记录的子 agent 树）和 `components/settings/subagents/runtime-tree.ts`（设置里的运行时树）已改用 `buildTree`，各自只保留自己的排序和深度约定（聊天记录从 1 起、part 自带的 `depth` 优先）。SDK 桥只负责给轮内 `Task` 连上 `parentSubagentId` 边，树的形状由前者统一构建。
- 停止已合并为一个：`lib/execution/run-stops.ts` 是进程内子运行的停止登记表，启动器在引擎运行期间把每个 `job` 子运行的停止登记在其运行 id 下（默认是引擎自己的停止；Job Center 登记的子运行走后台 agent 管理器的取消；调用方可传自己的 `stop`：`dispatch_agent` 先在后台投递箱记下取消意图再中止，插件 agent 走管理器的取消），引擎结束时注销。`run-control.ts` 新增 `stopRunTree`：根运行先停（有登记的停止直接调用，否则按类型交给 handler：小队走 Squad 控制、工作流走取消……），再按父先子后的顺序停掉其下所有仍在运行的运行；某个子运行拒绝不影响其余；根已结束时仍会停掉还活着的后代；行读不到但本进程有登记时照样能停。控制门的 `stop` 同样级联到整棵树。`control-handlers.ts` 的 `job` 分支改为调用登记表（不再找渲染端后台登记表）。调用方：`cancel-subagent.ts` 的 `cancelChildRun` / `cancelSubagentRun`（聊天卡片、Job Center、设置运行时页、模型的 `dispatch_agent({cancel})`）在有登记时走 `stopRunTree`；尚未启动的派发（还在解析定义、路由审批）用它自己的取消登记，轮内 SDK `Task` 用 `stopTask`（`sdk-subagent-bridge`），尚未登记停止的 Job Center agent 走管理器。插件 `ctx.agent.cancelAgent` 只取消 Job Center 跟踪的 agent（与原来范围相同），经 `cancelChildRun`；插件流式运行的 `cancel()` 在启动后走 `stopRunTree`，启动前仍同步走管理器。`cancelDelegation` 对已链接子运行的委派走 `stopRunTree`（委派出去的小队自己的委派也一并停止），仍在启动中的走启动信号；`stopRunTree` 停不到时退回启动信号。
- 遗留：本进程外执行的运行（配对主机、常驻 Host）的停止仍走控制门转发到该主机；登记表只覆盖本进程启动的子运行（设计如此）。

### 6.5 验收

- `rg "job-bridge|subagent-runtime-store.*persist|TeamDelegationRecord"` 只剩投影类型与文档；每个调用方都通过 `launchChildRun`。
- 新增测试：每种目标的启动与父链接；在跑中刷新后能从引擎对账；停止一棵树会停止所有子节点；轮内 SDK `Task` 不产生运行行。
- 升级时进行中的后台工作：能对账的对账，否则标记中断（测试固定）。

按实际实现（P3 完成）：

- **刷新后的对账（X10）。** 新增 `lib/execution/child-run-ownership.ts`。启动器在写行之前为子运行取得所有权（Web Lock `cognia:child-run:<runId>`，同源的所有 webview 共享，进程死亡时由浏览器释放；没有浏览器窗口的单进程宿主用进程内集合），落定之后释放，并在开启事件上标记 `launchedBy: "child-run"`。恢复循环每一轮先读未结束的 job 行，再读仍被持有的所有权，把带标记、无人持有、没有 `backgroundTasks` 条目的行落定为 `run.cancelled`（`host_stopped`，用启动器自己的落定事件 id 去重）。没有 Web Locks 的浏览器跳过，不猜。`execution:job:` 也是出站投递和集成动作 job 的 id 空间，不带标记的行（包括标记之前写的行，X12）一律不碰。
- **验收测试。** 每种目标（agent、external、twin、调用方引擎）写在父运行下；对账的选择、顺序与落定；停止一棵树（6.4）；轮内 SDK `Task` 不写运行行和事件行；升级用例由 background-tasks 的 “parks legacy rows without treating absence of a lease as proof of death” 固定。
- **审计。** `job-bridge` 代码已无；`subagent-runtime-store` 只持久化模板；`TeamDelegationRecord` 只剩投影类型（P9 改名）。6.2 列出的子运行入口都经过 `launchChildRun`；其余 `executeAgent` 调用方（计划步骤的 `agent_turn`、工作流 ensemble 节点、GitHub issue 循环、小队队员、工作流候选挑选）做的是自身运行的工作，不是委派子运行。收敛清单仍引用已删的 `job-bridge.ts`，`audit:convergence` 在 `HEAD` 上同样失败（X13）。

## 7. P4：steer、控制机、ADR-0249

### 7.1 单一 steer 入口

- `lib/execution/run-control.ts` 的 `steer` 成为唯一入口，按类型分派：`agent-turn` → `steerSession`（`lib/claude/ipc.ts:693`，sidecar `routeSteer`）；`team` → `steerDurableRun`；issue 运行 → `steerIssueRun`；`delegation` → 转发给在跑子运行；共享会话 → `steerSessionRun`。
- 迁移调用方：聊天里对运行中小队的追问（`use-claude-chat-controller.ts` 的小队保持分支）、`lib/connectors/live-steer.ts`、IM `steer:`/`调整：`（`follow-up-items.ts:52-55`）、卡片按钮、Issue 唤醒、P4.3 的完成通知。
- 文本规则：`lib/claude/steer.ts` 的 `STEER_PREFIX` 是唯一来源，`cli/src/tui/runtime/driven-turns.ts:77` 改为导入；IM 前缀放在同一模块。
- 队列规则：新增 `lib/execution/steer-queue.ts`（纯函数）：人的输入与停止立即送达；派生输入在流式期间排队、轮次边界合并成一份简报；会话队列中人的轮次排在派生输入之前。`hooks/chat/steer-runtime.ts` 的纯逻辑移到这里（同时解决 `lib/chat/room` 导入 hooks 的一处）。
- `steer_degraded` 语义保留，测试固定。

### 7.2 控制状态机

- `lib/squads/durable/durable-control.ts` 是唯一的控制机；`squad-control.ts` 只留守卫：遗留运行、readiness、回放判定。
- 回放判定只留 `packages/agent-orchestration/src/replay.ts` 的 `assessRecoveryEligibility` / `isChildReplaySafe`；`assessSquadRunReplay`、`isDurableChildReplaySafe` 删除，调用方改用包里的函数。
- `controlSquadRun` 与 `controlSquadTeam` 合为一个入口，`control-handlers.ts:296` 和机器人运行时改用它。

### 7.3 ADR-0249

按 ADR-0249 的“实现面”表逐项实现，并按 ADR-0252 §9 修订：

- `BackgroundTaskKind` 加 `shell-job`、`monitor`；以 job/monitor id 幂等 upsert，接受终态先到。
- Rust：`crates/cognia-jobs` 的启动调用接收 session/run id，退出与触发事件携带它们；持久化 job 与 monitor 的查询供对账使用。
- 设置：`hooks/system/use-tauri-events.ts` 在调度器转发旁边结算；headless brain 事件接线；TUI 消费者 `cli/src/tui/components/app/use-background-results.ts`。
- 工具：`bash` 的 `run_in_background` 加 `notify: "on_exit" | "none"`（默认 `on_exit`）；`kill_shell` 停的不唤醒；`Monitor` 的描述与行为一致，阻塞调用已内联返回的不再投递。
- 唤醒：宿主拥有或有后台保持的会话在空闲时唤醒；每会话每小时 6 次上限、10 秒合并窗口；计入运行预算，预算耗尽不唤醒；超出上限的排到下一次轮次并发一条通知。唤醒走 7.1 的队列规则。
- 对账：每次消费者启动或重连时查询 supervisor 的持久化记录，补结算和补建条目；投递仍经批次身份保证一次。
- 验收用例：job 在启动 ACK 之前退出；消费者在 job 中途重载；事件到达两次；同一个 monitor 内联与异步两条路径。
- i18n：通知文案中英两份。

按实际实现（2026-11-08，`cb06a20651`、`4bb804800e`、`7d0f2dc091`）：

- 窗口的消费者没有放进 `use-tauri-events.ts`（它只在 Tauri 里挂载），而是放在 `BackgroundTaskInitializer`，桌面和配对的手机都经它消费。进程内的 shell（CLI 的 sidecar）发 `background_job_settled` 帧，记录同一条 outbox 条目。
- 每个 job/monitor 的结束都先向 supervisor 认领投递（`jobs.claimDelivery`，先到先得），两台配对设备或窗口加 brain 只有一方投递。
- 投递核心移到 `lib/background-tasks/result-delivery.ts`，按宿主注册一条 lane：窗口的 lane 在 `hooks/chat/background-result-runtime.ts`；brain 的 lane 是宿主内部的自动轮（`lib/background-tasks/host-delivery-lane.ts`），先入工作账本再按 HostState 的方式派发，不改线上协议。`background-tasks` 成为清单模块，brain runtime 为 `background-job-delivery`。
- 未覆盖：房间成员子会话、成员分区、IM 推送只走原有投递，见证据台账 X14–X19。

### 7.4 验收

- headless 冒烟（真实模型）：agent 后台跑一个 `sleep 5 && echo done`，结束后会话被唤醒并看到结果；人在唤醒排队期间发的消息先被处理。
- `rg "STEER_PREFIX ="` 只有一处定义。

## 8. P5：绕过路径、外观、聚合

- **startSquadRun builder。** 新增 `lib/squads/squad/build-start-input.ts`，为连接器（`lib/connectors/team-dispatch.ts`）、客户端路由（`lib/execution/squad-start-dispatch.ts`）、机器人（`lib/bot/runtime/executors/squad.ts`）、Issues（`lib/issues/run/agent-team-adapter.ts`）、插件 API、斜杠命令、companion 写处理、重试、恢复、eval 构造输入。
- **`action.team.run`。** `workflow-nodes/index.ts:150` 改为通过 `startSquadRun`（带 workflow 来源与 signal），等待运行结束后再把结果交给节点；保留节点现有输出形状，测试固定。
- **删除 `agentTeamManager`。** 逐个迁移调用方：`lib/scheduler/executors/team-executor.ts`、`lib/plugin/agent-sdk/dispatch.ts`（走 `launchChildRun`）、`delegation-orchestrator.ts`、`components/agent/workspace/durable-operations.tsx`、`board/board-toolbar.tsx`、调度器两个编辑器、`lib/squads/search-provider.ts`、`lib/plugin/api/team-api.ts`、`lib/cli-bridge/handlers/agent-team.ts`、`workflow-nodes/team-ops.ts`、`lib/squads/slash-command.ts`。然后删 `agent-team.ts` 里的外观（保留其中仍被使用的类型与工具函数，挪到合适的模块）。
- **best-of-N。** 保留直连协调器，候选已在 P3 成为子运行；这里只核对监控面板显示。
- **聚合模块。** 新增 `packages/agent-orchestration/src/aggregate.ts`（无 `@/` 导入）。先写行为对照测试：对同一组输入分别跑 `consensus-orchestrator.ts`（`tallyVotes`/`computeWinner`/`thresholdMet`）、`lib/ai/ensemble/run-ensemble.ts`、`patterns/judge-panel.ts`、`lib/ai/council/run-council.ts` 的聚合部分，记录差异。一致的合并；不一致的逐项判断哪种正确，保留的在模块里写明原因。四个界面改为调用该模块。改完后 `pnpm build:packages`。

按实际实现（2026-11-08，`29186d2655`）：

- builder 按"来源界面"建模（`SquadStartSurface`：chat、console、companion、im、bot、scheduler、issue、workflow、plugin、remote、evaluation、retry、child），由它统一决定 `origin`、`triggeredFrom`、是否带本机人的授权，以及会话是完整对象还是只有 id。
- 需要等结果的调用方（调度器、`action.team.run`、compose 的 `autoStart`）走 `lib/squads/squad/run-squad-to-end.ts`：经 `startSquadRun` 启动，等执行行进入终态，调用方取消时经 `controlSquadRun` 停掉这一个运行；拒绝抛 `SquadRunRefusedError`。生命周期的结束原因按 runId 留在进程内，取不到时读持久记录的 `recoveryReason`。
- `action.team.run` 的工作流知识授权和 fan-out 深度冻结进 `executionConstraints`，恢复重入时不丢；节点的 `goal` 参数原来声明了却没传，现在传入。
- 外观删除后：恢复是 `lib/squads/durable/recover-squad-runs.ts`，子运行重试是 `retry-squad-child.ts`；看板的暂停/恢复走 `useSquadRunControl`（可达配对 Host），⌘K 的启动是人的启动尝试，暂停/恢复走 `dispatchRunControl`，拒绝时 toast。
- 聚合模块的对照测试是 `lib/squads/aggregation-parity.test.ts`。四处原本在打平规则上一致；不一致的四处按模块规则统一：空白回答算失败（ensemble 原来算作回答）、比较前去掉首尾空白（ensemble 原来把 `yes` 与 `yes\n` 分成两票）、没被评分的尝试排在最后且不能获胜（judge panel 原来当 0 分，可能被选为赢家），全部未评分时 judge panel 失败而不是给出 0 分赢家。另：非有限或负的票重计为 0（共识投票原来会被负权重拉低）。保留的差异写在模块头注释里：小队投票判定法定数、ensemble 的"多数票"只报众数、judge panel 取多名评委均值、council 的一致度是合成者自评。
- best-of-N 监控面板核对：候选行的"停止"原来报成功但尝试继续跑，已改为只停这一个候选（中断其会话，记为 cancelled）。组行原来是 `team` 行（重试、暂停、引导被提供却做不成，停止落到 recovery_required，候选不嵌套，标签是原始提示词）。按用户选择改为独立的运行 kind `best-of-n`：组行 `execution:best-of-n:<teamRunId>` 在持久运行准备前写出，团队日志因此不再写 `team` 行，持久运行的用量记到组行；唯一的控制是停止，由 best-of-N 自己注册（`lib/best-of-n/run-control.ts`，从桌面恢复初始化器挂上，内核控制表不能引用模块），取消整组，组读到 cancelled 后落定组行；候选是组行的子运行，标题 `Best-of-N i/n · 智能体 (模型)`，租约指向候选自己的行，活跃的 broker 腿替代该行并沿用其 kind 与父行；运行监控面板按父子嵌套显示。线上协议不需要改：没有任何地方枚举运行 kind（schema 目录、Rust 同步注册表、`execution_run_control` 只带 runId），旧版配对客户端把这一 kind 显示为"其他"（台账 D33、O38、X23–X25）。

## 9. P6：房间→小队

- **删除房间里的协作工具。** squads 工具族的 `teamToolFamily.surface`（`lib/squads/collaboration-tools.ts`，原 `build-options.ts` 的分支，2026-11-07 迁入）改为只在小队队员会话（有 team-dispatch 上下文）下提供 `team_*`；房间会话不再添加。`selfInvokeTools.teamCollaboration` 的设置说明同步更新。
- **新工具 `room_handoff_to_squad({ squadId?, brief })`。** 定义在房间工具清单中，带权限规则；只在房间会话里提供。调用写一张提议卡（A2UI 或现有卡片部件），不启动任何东西。
- **设置。** `roomSettings.squadHandoff: "confirm" | "auto"`，默认 `confirm`。在房间设置编辑器中可改；`auto` 需在 UI 上说明含义。
- **确认。** 桌面、手机、IM、宿主渠道的确认都走同一个命令（`desktop-write-source.ts` 增加分支，headless 共用）。确认后：`acceptDelegation`（来源 = 房间这一轮），再经 `launchChildRun` 以 `squad` 目标启动；默认小队为房间绑定的小队（P7），卡上可改选。
- **结果回流。** 小队结束后，一条折叠消息写入房间；经 ADR-0249 投递唤醒提议的成员（房间 runner 在下一轮次边界处理）。
- **steer/停止。** 卡片上的按钮经 P4 入口作用于委派。
- **分层。** `lib/chat/room` 不再导入 `hooks/`：`steer-runtime` 的纯逻辑已在 P4 移到 `lib/execution/steer-queue.ts`；`stream-coalescing` 和 `use-effective-cwd` 的纯部分移到 `lib/chat/` 下，hook 只留 React 外壳。
- **验收。** headless 冒烟（真实模型）：角色团队房间里一个成员提议“让小队写一个 hello 脚本”，人确认，小队运行完成，房间里出现折叠结果，成员被唤醒并回应。桌面渲染与手机投影各验证一次卡片显示（手机在收尾阶段真机验证）。

## 10. P7：ADR-0177 第 4、5 批

- **IM 群绑定角色团队。** `ConversationOverrideRow` 新增 `characterTeamId`；`teamId` 改名为 `squadId`（非索引字段，不升 Dexie 版本；读取时兼容旧字段一次）。`lib/connectors/effective-config.ts` 与 inbox 覆盖 UI 同步。
- **回复走 `RoomRunner`。** 绑定了角色团队的 IM 群，入站消息由连接器运行时交给宿主的 `RoomRunner`（`kind: "im"`），不再走 `runAndCapture`。每条角色回复以连接器的 bot 身份发出，带角色署名；平台支持富内容时带头像卡片头（共用 `lib/connectors/adapters/_shared/a2ui-mapper.ts`）。支持多 bot 的平台可选“角色→bot”映射。
- **未绑定角色团队的 IM 群** 也作为 `im` 房间：普通回复同样经 `RoomRunner`，使房间说明、回复模式、静音、记忆默认值生效。
- **默认值与完整度。** `initialRoomMemoryFields` 在 `createPlatformSession` 和共享会话导入时应用；`completenessFor` 在平台只给人数或管理员时返回 `partial`；收件箱区分群聊与私聊。
- **一个回复模式旋钮。** 收件箱的激活策略（`triage-controls.tsx:86`）与 `roomSettings.replyMode` 合并为一个设置，双向映射写在一处；房间设置编辑器覆盖 IM 和共享房间。
- **共享房间。** 删除 `NEXT_PUBLIC_SHARED_CHAT_ENABLED`（`lib/collab/shared-chat-feature.ts`）；以协作服务器已配置且 `/health` 报告受支持协议为可用条件；不可用时入口显示原因（三轴标注）；本机偏好保留。共享房间读取 `roomSettings`；静默判定写入审计；追赶卡片上线。
- **验收。** 单测覆盖每种绑定组合（只角色团队、只小队、两者、都无）；headless 冒烟用 IM 测试适配器跑一个两角色群聊回合；飞书真机冒烟放到收尾。

## 11. P8：ADR-0247

按 ADR-0247 自己的 Rollout 顺序，跳过 §7 的实时部分与 enforce：

1. **mandate。** `CommitmentMandateV1`、策略摘要（替换 `lib/governance/producers/connector.ts` 里写死的 `policyRef.version: "1"`）、`mandateRef`、影子检查与报告。`agentPermissions.mandateEnforcement: "shadow" | "enforce"` 默认 `shadow`；实时权限检查报告 `live_authority_unavailable`，此时拒绝切到 `enforce`。三轴标注。
2. **follow 与线程事件。** `IssueExternalRef.follow`、`ExecutionRun.followRefs`、`im-thread`/`github-issue` 提供方；连接器总线在去重和准入之后把被 owner 关注的线程消息交给承诺投递，并写回执；GitHub 事件追加为 Issue 活动；轮询降为对账；系统唤醒规则与合并。
3. **T1 自动受理与 T2 升级。** 首次写入 git 根时自动受理（常驻宿主、绑定 IM 的会话、GitHub 触发）；`delegation_accept` 工具；首次建分支或开 PR 时 `promoteDelegationToIssue`（并入 `buildRunPrFeedback`）；协调线程启动即升级；`reviseDelegationPlan` 接入。
4. **续接会话。** `startIssueRun` 接受 `continueSessionId`，按 ADR-0247 §6 判定能否续接。
5. **handback。** `commitment_handback` 工具；协调者同级报告或线程卡片（新 Issue / 扩大范围 / 忽略）。
6. **观察日志。** `workObservation: "off" | "observe"` 默认 `off`；预过滤 + `runDecision`（PII 门在前）；新表 `workObservations`（按 `dexie-migration` 技能：改 `CURRENT_SCHEMA`、升版本、`CORE_TABLE_NAMES`、`pnpm db:governance:write`）；设置页评审。

每一步都在 headless 宿主上验证（`lib/headless/runtimes/issue-tracker.ts` 已在 brain 启动），并在台账记录。T1/T2 用真实模型冒烟：IM 测试适配器发一条“修改 README”的请求 → 自动受理 → 建分支 → 升级为 Issue → 线程追问经 steer 到达。

## 12. P9：看板、路由、i18n、命名

- **看板共用。** 合并 `lib/squads/board-model.ts` 与 `lib/issues/board-model.ts` 的 `columnDropId`、`parseDndId`、`reorderColumn`/`reorderIssueColumn`；`components/squads/board/task-board.tsx` 与 `components/issues/board/issue-board.tsx` 共用一个看板组件（各自的卡片和守卫通过参数注入）。ADR-0066 的守卫、CQRS 投影、Companion RPC 和插件点不变。
- **删除 `/agent-teams`。** 删 `app/agent-teams/**`，更新 `lib/runtime/surface-contract.ts:549-553`；导航 legacy alias 若仍存在保留只读映射。
- **拆分 `agentTeamsWorkspace`。** 统计仍在使用的 key，按使用方拆进 `squads` 等命名空间；删除无引用的 key；更新 `pnpm lint:i18n:baseline`（只能下降）并 `pnpm i18n:build`。
- **持久化字段。** `agent-team-store` 删除 `displayMode`、`workspaceTab`；`agent-runtime-store` 删除三个降级镜像与 `legacyMirrors`/`refFromLegacyFields`；两者都升 persist 版本，migrate 中剔除。
- **命名。**

  | 现在                                                              | 改为                                      |
  | ----------------------------------------------------------------- | ----------------------------------------- |
  | `TeamDelegationRecord`                                            | `SquadChildRunView`                       |
  | `delegation-orchestrator.ts`                                      | `child-run-policy.ts`                     |
  | `lib/ai/agent/external/delegation-router.ts`（`routeDelegation`） | `agent-routing.ts`（`routeAgentRequest`） |
  | router-fusion 对外的 delegate 类型与 UI 文案                      | step                                      |
  | `agent-team-compat.ts`                                            | `agent-team-normalize.ts`（若 P2 未完成） |

  插件契约里的公开类型改名时保留一个 `@deprecated` 别名一个版本，并重建 `packages/plugin-contract` 与 SDK（`pnpm build:packages`）。按 `CLAUDE.md`，改 `types/plugin` 会使 authoring kit pin 失效，需要按 cognia-plugins 的流程重钉。

## 13. P10：ADR-0247 §7 实时权限

- 前提：ADR-0243 2B–2D 已在 `dev` 上（实时凭据授权 epoch、绑定与同意 revision 的解析器）。开工前先读那几次提交。
- 把影子检查里的 `live_authority_unavailable` 替换为真实检查；ADR-0247 §7 的三条验收用例（revision 未变但凭据被撤销、revision 未变但绑定被撤回、人已停止后到达事件）。
- 解除“拒绝切换 enforce”的限制；是否把任何工作区切到 `enforce` 由影子报告决定，不在本计划内。

## 14. 收尾：真机冒烟

- 桌面 Tauri（`tauri-smoke` 技能）：房间→小队全流程；后台 job 唤醒；委派卡片 steer/停止。
- 配对手机：房间提议卡确认；委派卡片投影。
- 飞书真机：IM 群绑定角色团队，多角色署名回复；`/delegate` 与自动受理；线程追问到达承诺。
- 常驻宿主（ADR-0224 那台）：T1/T2 与 follow 的端到端。
- 每项结果写入台账；未能完成的写成残余风险。

## 15. 风险与陷阱

- **共享工作区。** P1 搬迁影响面大，必须在相关路径没有他人未提交改动时进行；中途发现冲突立刻停下。提交只含自己的路径。
- **ADR-0243 并行。** 另一个会话在做 2B–2D，会改 `lib/execution/acting-authority.ts` 一带。P8 只在 mandate 结构上依赖它的类型，不改它的文件；需要改时先协调。
- **插件契约。** P3、P9 若触及 `packages/plugin-contract` 的公开类型，要重建包并处理 authoring kit pin。
- **Dexie。** 只有 P8 的 `workObservations` 需要升版本。`ConversationOverrideRow` 字段改名是非索引字段，不升版本。
- **jest。** 用 `--runInBand`，不跑全量；worktree 里跑 jest 需要临时包装配置（见记忆）。
- **磁盘。** cargo 增量会占满磁盘；P4 的 Rust 改动只跑相关 crate 的测试。
