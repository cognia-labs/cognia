# Issue 追踪器状态流整治计划：运行桥、写入边界、看板数据流、去重与死代码

状态：计划已定稿，未开始实施。创建：2026-11-05（Asia/Shanghai）。

上游：

- 决策基础：[ADR-0132](../content/docs/en/adr/0132-issue-tracker.md)。本计划结束时为它补 §8（修订记录）。
- 证据：2026-11-05 的三路只读审计（状态流、面板 UI、重复与死代码）加一路渲染接缝审计（自动链接）。关键结论已人工复核：写入边界的运行锁失效（`lib/db/issues.ts:297`）、`onStartError` 未接线（`lib/issues/run/agent-team-adapter.ts:376`）、事件在事务内发出（`lib/db/issue-events.ts:79,96`）、结算跨两个事务（`lib/issues/run/registry.ts:269-286`）。下文路径取自 `dev` 的 `1039587667`。
- 决策来源：同日 grill 会话，用户逐项拍板（见 §0）。

实施方式：

- 全部由 Claude 编写，不交给 Codex。
- 在共享工作区里改。每次提交只用 `git commit --only <paths>` 或显式 `git add <paths>`；提交前 `git diff --cached --name-only` 核对。
- 六个阶段，每个阶段单独提交（或一组提交），并在 `docs/evidence/2026-11-05-issue-tracker-state-flow.md` 记一条台账（evidence-driven-dev 格式）。
- 面向用户的改动带 changeset（`cognia-next`）。P1–P5 有用户可见变化（`patch` 为主，自动链接和泳道为 `minor`）；P6 的纯删除不带。
- 范围只在 Issue 子系统内（`types/issues/`、`lib/db/issue*.ts`、`lib/db/github-issue-mirror.ts`、`lib/issues/**`、`components/issues/**`、`components/mobile/issues/**`、`hooks/issues/**`、`stores/issues/**`、`lib/skills/built-in/issues/`、`lib/global-search/providers/issues.ts`），加上为收口写入、发出事件、渲染链接必须触及的调用点（`lib/companion/desktop-write-source.ts`、`lib/browser-companion/host-dispatch.ts`、`lib/external-bridge/**`、`lib/workflow/**` 的 issue 节点与触发器、聊天渲染器、提交详情）。跨子系统的重复（team `board-model`、三套移动守卫、`agent-task-board`）不在本计划内，另立任务。

## 0. 已定决策

| #   | 问题                   | 决定                                                                                                                                                                                                                               |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 范围                   | `/issues` 页面 + 详情面板 + 运行链路作为一个整体                                                                                                                                                                                   |
| D2  | 清理边界               | 仅 Issue 子系统；跨子系统另立任务卡                                                                                                                                                                                                |
| D3  | 交付                   | 本计划 + 六阶段实施，Claude 编写                                                                                                                                                                                                   |
| D4  | ADR 与代码冲突         | 明显 bug 修代码；语义选择问用户；ADR-0132 补 §8                                                                                                                                                                                    |
| D5  | 运行锁                 | `moveIssue` 在自己的事务内读 `issueRuns`（`[issueId+status]`），删除 `runActive` 参数；UI 预检查只用于置灰                                                                                                                         |
| D6  | 派发                   | 两阶段启动：事务内「无活跃 run」检查 + 插入 `queued` 行（兼作启动锁）→ 派发引擎；派发抛错则 run 结算 `failed`、issue 回 `statusBefore`、错误抛回调用方；engine 受理后标 `running`（github-loop 也一样）；agent-team 等受理而非完成 |
| D7  | team 任务停在 `review` | team 忙时 run 保持活跃；team 停下且任务在 `review` → `succeeded`；之后到 `completed` 不重复结算                                                                                                                                    |
| D8  | 取消                   | 新事件 `run_cancelled`（插件契约变更），通知显示「已取消」；所有 run 取消后回启动时记录的 `statusBefore`                                                                                                                           |
| D9  | 结算原子性             | run 结算 + PR 关联 + issue 状态一个 Dexie 事务；boot 时修复残留                                                                                                                                                                    |
| D10 | 事件总线               | 真正在事务提交后发出；删除 wakeup bridge 的 defer 绕行                                                                                                                                                                             |
| D11 | 看板数据流             | `IssueSourceAdapter.subscribe`；console 用一个合并 live hook；删 `federatedTick` 与重复 `localRows`；`reorderIssues` 更新 `updatedAt`                                                                                              |
| D12 | 写入收口               | 所有写入经 `lib/issues/service.ts` / `bulk-actions.ts`；建项目 + 建 issue 一个事务；静态门禁止 `components/**` 导入 `lib/db/issue*` 写函数；写回失败弹提示                                                                         |
| D13 | 看板 groupBy / density | 实现泳道（assignee / priority / project）和 density；`my-agents` 真正按 assignee 分                                                                                                                                                |
| D14 | 手机端                 | 深链接完整传递；`source=github                                                                                                                                                                                                     | collab`显示「此设备不可用」；状态下拉用`allowedIssueMoveTargets`+ 本机`issueRuns` 镜像过滤 |
| D15 | 死代码                 | 确认无引用的导出全删（连测试）；`reset*ForTesting` 保留；删前 tsc + 逐个 grep 复核                                                                                                                                                 |
| D16 | 标识符自动链接         | 接线实现（见 P5.7）                                                                                                                                                                                                                |
| D17 | `github_write_back`    | 在 `github-writeback.ts` 补生产者                                                                                                                                                                                                  |
| D18 | `relations.ts`         | 组件内联逻辑收入 `planning-hints.ts`，删 `relations.ts`                                                                                                                                                                            |
| D19 | 去重清单               | 枚举/匹配/映射/进度单一化；同步管线去重；冲突面板共用交互；`issue_list` 共用 `queryIssues`，skill 与 MCP 各自保留默认值和上限常量                                                                                                  |
| D20 | 写回后刷新             | 只刷被写的那一个 issue（`github-event-refresh` 单条路径），失败弹提示                                                                                                                                                              |
| D21 | 优先级往返             | 一张双向表，引擎默认值映回 `none`，往返不变                                                                                                                                                                                        |
| D22 | GitHub 评论读取        | 复用镜像的 `resolveGithubSyncReadClient`，经过 ADR-0243 的门                                                                                                                                                                       |
| D23 | 自动链接范围           | 聊天消息（两条渲染管线）、issue 描述与评论（含 GitHub 评论）、提交信息、IM 引用回复                                                                                                                                                |
| D24 | 链接解析               | `/issues?identifier=MERC-12`，页面异步解析，找不到显示「不存在」；渲染端只链接当前工作区已存在的项目 key                                                                                                                           |
| D25 | 不可信文本             | 也链接，但只生成应用内相对地址                                                                                                                                                                                                     |
| D26 | 验证                   | 受影响的 Jest 套件 + typecheck + 门禁 + Playwright e2e；不做浏览器预览和 Tauri 冒烟                                                                                                                                                |

## 1. 不变式

1. **一个状态写入者对应一种身份。** 人（及代人的门面）只经 `moveIssue`；运行时只经 `applyRuntimeIssueStatus`。两者的守卫都在数据库事务内完成，不依赖调用方传参。
2. **issue 侧是「哪些 run 属于这个 issue」的唯一真相**（ADR-0132 §2 不变）。引擎不加 `issueId` 列。
3. **派发失败一定抛出**，从不吞掉；一个 issue 同一时刻至多一个活跃 run。
4. **事件只在提交后可见。** 订阅方看到的每个事件都对应已存在的行。
5. **组件不写库。** 写入只经 service / bulk-actions，校验一处。
6. **不简化。** 不留桩、不留 `// TODO`、不剥错误处理；做不到的写成阻塞项回报。
7. **休眠三轴（Rule 7）。** 本计划结束时没有「声明了但没有生产者/消费者」的事件类型、能力位或视图选项。

## 2. 阶段与验收

| 阶段 | 内容                                    | 结束时                                                                        |
| ---- | --------------------------------------- | ----------------------------------------------------------------------------- |
| P1   | 运行桥正确性                            | D5–D9 落地；每个缺陷有由红转绿的测试；boot 修复有测试                         |
| P2   | 事件总线 + `github_write_back` 生产者   | 提交后发出；workflow 触发器在订阅回调里读得到行                               |
| P3   | 写入收口 + 静态门 + 手机端写入校验      | 门禁通过；`components/**` 无 `lib/db/issue*` 写导入；companion 写入走 service |
| P4   | 看板数据流 + 泳道/density + 手机端 UI   | 联邦行实时刷新；泳道可用；手机深链接与守卫                                    |
| P5   | 去重 + 凭据门 + 自动链接                | §P5 清单全部完成                                                              |
| P6   | 删死代码 + 注释/ADR §8 + Playwright e2e | 死代码表清空；`pnpm docs:build` 通过；e2e 通过                                |

顺序理由：P1 修的是数据正确性，后续所有 UI 验证都依赖它；P2 必须早于 P3，因为收口后的写入路径都依赖总线语义；P4 的 `subscribe` 要建在 P3 收口后的写入之上；去重和删除放最后，降低前面 diff 的噪音。

## 3. 每阶段验证

- 只跑受影响的单测：`pnpm test -- <paths> --runInBand`（经 `scripts/test/jest.mjs`；不跑全量，不跑覆盖率）。写测试前读 `jest-gotchas` 技能。
- `pnpm typecheck`（需要 16 GB 堆）。
- 触及的门禁：`pnpm audit:colocated-tests`、`pnpm audit:modules`、`pnpm lint:i18n` + `pnpm i18n:build:check`、`pnpm docs:build`（P6）。
- 提交前跑 `preflight` 技能；新增模块必须过 `wiring-auditor`。
- P6 跑 Playwright：`pnpm test:e2e:build` 后 `PLAYWRIGHT_STATIC=1 pnpm test:e2e:static -- <spec>`（dev server 会自动建账号导致 `resetCogniaDb` 失败，必须用静态构建）。
- 不追 CI。

## 4. P1：运行桥正确性

### P1.1 运行锁进数据库（D5）

- `lib/db/issues.ts:moveIssue`：事务范围加入 `db.issueRuns`；在事务内用 `[issueId+status]` 查 `queued`/`running` 行得出 `runActive`。删除 `MoveIssueInput.runActive`。
- 调用方随之删参：`lib/issues/im/callback-handler.ts:236`、`lib/issues/sync/apply.ts:171` 及其上游 `lib/issues/sync/engine.ts:295,355`。
- 同步引擎（`sync/apply.ts`）对远端带来的状态变化是否也受运行锁约束：审计时它是调用方传参。实施时先读 engine 的语义；若远端状态需要覆盖运行锁，单独写成 `moveIssue` 的显式选项并在 ADR §8 说明，而不是恢复可选参数。此点实施时回报用户确认。
- 测试：`lib/db/issues.test.ts` 加「活跃 run 时拖入/拖出 `in_progress` 被拒、无需调用方传参」；`bulk-actions.test.ts` 加批量改状态遇活跃 run 的计数（`skipped`）。

### P1.2 两阶段启动与启动锁（D6）

- `lib/db/issue-runs.ts`：新增 `claimIssueRun(input)`——一个事务内检查该 issue 无活跃 run，插入 `queued` 行并记录 `statusBefore`（取当前 issue 状态），否则返回 `issue-run-active` 拒绝。替换 `run/registry.ts:187` 的「先查后写」。
- `lib/issues/run/registry.ts:startIssueRun`：claim → `applyRuntimeIssueStatus(in_progress)` → `adapter.start`。`start` 抛错时调用统一失败结算（run `failed` + issue 回 `statusBefore`，同一事务，见 P1.4），再把错误抛给调用方。
- `IssueRunAdapter.start` 契约改为：返回时引擎已受理。各适配器：
  - `agent-task-adapter.ts`：`runTaskNow` 抛错不再留 `queued`；受理即 `markIssueRunRunning`。
  - `agent-team-adapter.ts`：`startTeam` 改为等到「已受理」（team 状态离开 idle 或返回受理凭据）再返回；受理失败抛出。删除 `onStartError` 依赖。运行中的完成仍由 poll 结算。需要读 `agentTeamManager.start` 的返回形状确认「受理」信号；若当前 API 只在完成时 resolve，在 Agent Team 侧加最小的受理回调——这是唯一允许越界的点，改动前回报。
  - `github-loop-adapter.ts`：`executeIntegrationAction("runIssueLoop")` 受理后标 `running`；`awaiting_approval` 期间保持 `queued` 并在 ADR §8 写明这一状态的含义。
- `components/issues/run-issue-dialog.tsx` 已把 `IssueRunRefusedError` 映射到 `run.refusal.*`；新增的派发错误（非拒绝）在对话框里显示可读错误，i18n 两种语言。
- 测试：每个适配器的「start 抛错 → run failed、issue 回原列、错误外抛」；registry 的并发双派发只有一个成功（两个 `startIssueRun` 并发，一个得到 `issue-run-active`）；github-loop 受理后 `running`。

### P1.3 team 任务的 `review`（D7）

- `agent-team-adapter.ts:poll`：`default` 分支里 team 已停下（非 busy、非 idle）且 `task.status === "review"` → `succeeded`（带 summary 与 artifacts）；其余非终态仍按现有规则判 `failed`。
- 已结算的 run 再 poll 到 `completed` 时不变（`settleIssueRun` 幂等，补测试固定）。
- 测试：team 结束时任务在 `review` → issue `in_review`、run `succeeded`；team 仍忙时任务在 `review` → 保持活跃。

### P1.4 结算原子化与取消语义（D8、D9）

- `registry.ts:settleIssueRunAndIssue` 改为一个 Dexie 事务（`issueRuns`、`issues`、`issueEvents`）：settle run、`linkRunPullRequests`、`applyRuntimeIssueStatus`。`linkRunPullRequests` 与 `applyRuntimeIssueStatus` 若内部自开事务，改为接受外部事务（Dexie 嵌套事务语义：同表子集可复用）。
- 取消：`settleIssueRun` 对 `cancelled` 写新事件 `run_cancelled`（不再写 `run_failed` + `"cancelled"`）；issue 回 `statusBefore`（P1.2 起所有 run 都记录它；wakeup run 已有 `wakeup.statusBefore`，统一到 run 级字段，wakeup 字段保留只读兼容）。
- `applyRuntimeIssueStatus` 的守卫保持：只从 `in_progress` 交还；人中途移走的 issue 不被拉回。
- 契约：`packages/plugin-contract/src/types/issues/index.ts` 的 `IssueEventKind` 与 payload 联合加 `run_cancelled`；同步更新插件 SDK 目录（`packages/plugin-sdk/contract/catalog.json` 若列举事件）、wakeup 可匹配类型（`lib/issues/wakeups/model.ts`）、workflow 触发器、`lib/issues/notify.ts`（「已取消」文案，两种语言）、`lib/issues/activity-feed.ts` 的展示。契约变更使 authoring kit pin（`lib/plugin/distribution/authoring-kit.json`）失效：按 CLAUDE.md 的流程从干净 checkout 重建、在 cognia-plugins 的 `authoring-kits` 分支发布并更新其 `authoring-kit.lock.json`。
- 测试：取消 → `run_cancelled`、通知「已取消」、issue 回 backlog（原在 backlog 时）；结算中途抛错整体回滚。

### P1.5 check-in 与 boot 修复

- `checkInIssueRun`（`registry.ts:415`）改用同一个原子结算助手（mode `checkin`），也关联 PR。引擎继续跑到轮次结束是既定设计（docblock 写明）；这段时间内是否允许新的派发是语义问题——现状允许。实施时保持现状并在 ADR §8 写明，除非实施中发现会导致双写，届时回报。
- boot 修复：`lib/issues/boot.ts` 启动时扫描「issue 在 `in_progress`、无活跃 run、最近一个 run 已终结」的行，按该 run 的终态补做 issue 迁移（`succeeded`/`failed` → `in_review`，`cancelled` → `statusBefore`），每条追加 `status_changed` 事件，by 为 runtime actor。人手动放进 `in_progress` 且从未有过 run 的 issue 不动。
- 测试：boot 修复的三种终态和「从未运行」不动。

## 5. P2：事件总线与 `github_write_back`

- `lib/db/issue-events.ts`：`appendIssueEvent(s)` 在 `Dexie.currentTransaction` 存在时把发出挂到该事务的 `complete`（失败/中止则丢弃），否则立即发出。修正 `lib/issues/event-bus.ts` 的 docblock。
- 删除 `lib/issues/wakeups/bridge.ts:19-22` 一带的 defer 绕行，改为直接处理。`lib/workflow/runtime/issue-event-trigger.ts` 的 `getIssue` 保持原样（现在读得到）。
- `lib/issues/github-writeback.ts`：成功写回后在本地 issue 上追加 `github_write_back` 事件（payload 已在契约中声明，`index.ts:580`）。
- 测试：事务中止时订阅方收不到事件；事务内多事件按序在提交后发出；workflow 触发器回调内 `getIssue` 返回新行；写回成功产生事件且 wakeup 能匹配。

## 6. P3：写入收口与静态门

### P3.1 service 补齐

`lib/issues/service.ts` 成为组件和门面共同的写入入口。补齐当前组件直写的操作，全部复用 bulk-actions 的门或同一套校验：

- 负责人（`issue-detail-panel.tsx:198-205`）→ `applyIssueBulkAction({kind:"assignee"})`。
- 评论（`:258-271`）→ bulk-actions `comment`。
- 创建（`create-issue-page.tsx:262-325`）→ `createIssueRecord`；新增 `createIssueProjectWithFirstIssue`（一个事务内建容器 + issue，失败整体回滚）。
- 项目控制台、项目资源、cycles、deliverables、关联 GitHub、collab 冲突面板：在 service 增加对应函数（`updateIssueProjectRecord`、`deleteIssueProjectRecord`、`attachProjectResource`、`upsertCycle`/`deleteCycle`、`acceptDeliverable`、`linkIssueGithub`、`resolveCollabConflict`），每个都做输入校验并追加事件（已有事件的保持）。`collab-conflicts-panel.tsx` 不再直接 `getDb()`。
- 共享组织分支（`enqueueCollabMutation`）创建后也 `onCreated` 并选中新 issue；`issue-console.tsx:735,970` 的 `local:` 硬编码改为 `makeUnifiedIssueId`。

### P3.2 门面收口

- `lib/companion/desktop-write-source.ts:2079-2143`：`issue_apply_action` 用 `isIssueStatus` 等校验 payload 后走 `applyIssueBulkAction`；`issue_create` 走 `createIssueRecord`，非法 assignee（不是 human/agent/team）拒绝。
- `lib/browser-companion/host-dispatch.ts:742`、`lib/skills/built-in/issues/create.ts:83`：改走 `createIssueRecord`。
- 错误码：门面把拒绝原因按现有 refusal 词汇返回，手机端本地化。

### P3.3 静态门

- 新门禁 `scripts/gates/check-issue-write-boundary.mjs`（+ 同名 `.test.mjs`），在 `check-gate-registry` 登记：`components/**`、`app/**`、`hooks/**` 不得导入 `lib/db/issues`、`lib/db/issue-*`、`lib/db/github-issue-mirror` 的写函数（白名单只允许 `list*`/`get*`/类型）。放进 `pnpm audit:*` 系列并挂到 `check-all.mjs`。
- 写回失败：`issue-console.tsx:678-680` 的 `.catch(() => undefined)` 改为 toast（i18n）。

### P3.4 测试

每个新 service 函数有单测；门禁对正例/反例有测试；companion 两个命令的非法 payload 测试。

## 7. P4：看板数据流与 UI

### P4.1 源订阅（D11）

- `types/issues/unified.ts:IssueSourceAdapter` 加 `subscribe(query, onChange): () => void`（必选）。实现：local/github/collab/agent-task 用 Dexie `liveQuery`；agent-team 订阅 agent-team zustand store。
- `lib/issues/sources/registry.ts` 加 `subscribeAll(query, onChange)`，合并各源结果。
- 新 hook `hooks/issues/use-unified-issues.ts`（+ 测试）：订阅合并结果。`issue-console.tsx` 用它取代 `useState` 快照、`federatedTick`、`localSignature` 和独立的 `localRows`；进度计算改用同一份数据。
- `lib/db/issues.ts:reorderIssues` 更新 `updatedAt`。
- 测试：agent-team store 变化 → hook 输出变化；reorder 后顺序立即反映。

### P4.2 泳道与 density（D13）

- `lib/issues/board-model.ts:buildIssueSwimlanes` 接回生产：`IssueBoard` 接收 `groupBy`、`density`；groupBy 为 `none` 时单泳道。泳道按 assignee / priority / project；拖放跨泳道只改状态，不改泳道字段（与 Display 语义一致；若要跨泳道改负责人，另立需求）。
- `components/board/kanban-board.tsx` 是共享渲染壳：若它不支持泳道，在 Issue 侧组合多个看板实例而不改共享壳，避免越界。
- density 影响 `IssueCard` 的行高与字段（compact 隐藏描述/标签行）。
- `my-agents` 视图按 assignee 分泳道。
- i18n、stories 更新；测试覆盖 groupBy 切换、空泳道、键盘移动跨泳道。

### P4.3 手机端（D14）

- `app/issues/route-body.tsx:18`、`route-body.mobile.tsx:7`：传全部参数。`components/mobile/issues/issues-mobile-body.tsx` 支持 assignee/project/cycle 过滤；`source=github|collab` 显示「此设备不可用」空态（i18n）。
- `issue-mobile-actions.tsx:88-103`：状态下拉用 `allowedIssueMoveTargets`，`runActive` 来自本机 `issueRuns` 镜像（确认 `issueRuns` 已在手机同步表注册；若未注册，P4 内补注册并回报）。
- 测试：深链接参数、守卫后的选项列表。

## 8. P5：去重、凭据门与自动链接

1. **状态枚举**：`lib/skills/built-in/issues/_core.ts:26-33`、`lib/external-bridge/mcp-server/server.ts:1612`、`lib/workflow/nodes/params-schemas.ts:536` 改为从 `ISSUE_STATUSES` 派生（`z.enum(ISSUE_STATUSES)`）；`lib/slash-commands/actions/issue.ts:150` 的「未完成」集合改为按 `statusCategoryOf` 派生。
2. **文本匹配**：`service.ts:180-187`、`board-model.ts:91-99`、`lib/skills/built-in/issues/list.ts`、`create-issue-page.tsx:1156-1158` 合并为 `lib/issues/views.ts`（或 `board-model.ts`）里的一个 `matchesIssueText`。
3. **优先级（D21）**：`issuePriorityToAgentTaskPriority`、`issuePriorityToSubAgentPriority` 合并到 `agent-status-map.ts`，与反向映射成一张双向表；往返测试覆盖全部取值。
4. **状态列**：`buildIssueColumns` 并入 `buildIssueGroups(…, "status")`。
5. **进度**：console、`cycle-console`、`project-console` 统一用 `lib/issues/project-progress.ts`；修 `project-console.tsx:115` 的过时注释。
6. **同步管线**：一次同步只 reconcile 一遍（`sync/runner.ts:72,96` 与 `sync-runner.ts:130` 合并）；`github-sync.ts:101-124,142-152` 复用 `sync/engine.ts` 的离线重置与清除围栏；删除不可达的 `syncRepoIssues` 回退；修 `sync-runner.ts:2` 与 `github-issue-sync-executor.ts:3-4` 的注释。写回后刷新（D20）改走 `github-event-refresh` 的单条刷新，失败 toast。
7. **自动链接（D16、D23–D25）**：
   - `lib/issues/identifier.ts`：保留 `extractIssueIdentifiers`，新增按已知项目 key 过滤的分段函数 `segmentIssueIdentifiers(text, knownKeys)`。
   - 已知 key：`hooks/issues/use-issue-project-keys.ts`（live 的当前工作区项目 key 集合）。
   - 聊天：一个 rehype 插件 `components/chat/markdown/rehype-issue-identifiers.ts`（跳过 `a`/`code`/`pre`），加入 `components/chat/markdown-renderer.tsx` 的 `rehypePlugins` 与 `rehypePluginsWithoutRawHtml`，以及 `components/chat/markdown/rendering-policy.ts` 的 `chatStreamdownRehypePlugins`，位置在 sanitize 之后。不可信管线也加，只生成相对地址。
   - `components/chat/markdown/chat-link.tsx` 加 `/issues?identifier=` 的应用内分支。
   - 纯文本面：新组件 `components/issues/issue-linkified-text.tsx`，用于 issue 描述（`editors/issue-text-editor.tsx:82` 的展示态）、本地评论（`issue-detail-panel.tsx:788-793`）、GitHub 评论（`github-comments-section.tsx:120-121`）、提交信息（`components/source-control/commit-detail.tsx:251-253`）、IM 引用（`components/chat/message-parts/reply-to-quote.tsx`）。
   - 页面：`app/issues/page.tsx` 读 `?identifier=`，用 `getIssueByIdentifier` 异步解析为 id；找不到显示「不存在」（i18n）。手机端同样支持。`lib/issues/hrefs.ts` 加 `issueIdentifierHref`；`lib/slash-commands/actions/issue.ts:101` 的本地 href 拷贝改用 `hrefs.ts`。
8. **冲突面板**：抽 `components/issues/conflict-resolution-actions.tsx`（保留本地 / 保留远端），sync 与 collab 两个面板共用；存储不变。
9. **`issue_list`**：skill（`lib/skills/built-in/issues/list.ts`）与 MCP（`lib/external-bridge/handlers/issues.ts`）都调 `queryIssues`；默认值与上限各自声明为常量（25/100、50/200）。assignee 作用域判断复用 `views.ts:matchesViewScope`。
10. **评论凭据（D22）**：`lib/issues/github-comments.ts` 改用 `sync/providers/github.ts:resolveGithubSyncReadClient`；凭据未授权时评论区显示可操作的空态（i18n），不静默失败。修文件头注释。
11. **relations（D18）**：`issue-planning-section.tsx:107,110,119` 的内联逻辑收入 `planning-hints.ts`；删除 `relations.ts` 及测试。

每项带测试；自动链接的 rehype 插件、分段函数、`IssueLinkifiedText`、页面解析各有单测。

## 9. P6：死代码、文档与 e2e

### P6.1 删除表（删前逐个 grep + typecheck 复核）

| 文件                                        | 导出                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/db/github-issue-mirror.ts`             | `getGithubIssue`、`bindRepoToIssueProject`、`clearRepoMirror`、`pruneRepoMirror`、`latestMirroredUpdate`、`repoMirrorEtag`、`countMirroredIssues` |
| `lib/db/issue-events.ts`                    | `appendIssueEvents`（若 P1/P2 用上则保留）                                                                                                        |
| `lib/db/issue-cycles.ts`                    | `:70`、`:124` 的两个导出                                                                                                                          |
| `lib/db/issue-counters.ts`                  | `peekIssueNumber`                                                                                                                                 |
| `lib/db/issues.ts`                          | `mapIssuesByExternalProvider`                                                                                                                     |
| `lib/issues/identifier.ts`                  | `parseIssueIdentifier`（若 P5.7 未用上）                                                                                                          |
| `lib/issues/relations.ts`                   | 整个文件（P5.11 之后）                                                                                                                            |
| `lib/issues/planning-hints.ts`              | `hasPlanningBadges`                                                                                                                               |
| `lib/issues/sync/field-clock.ts`            | `syncFieldOfEvent`                                                                                                                                |
| `lib/issues/sync/providers/lark-bitable.ts` | `mappedFields`                                                                                                                                    |
| `lib/issues/sync/conflicts.ts`              | `listOpenSyncConflicts`                                                                                                                           |
| `lib/issues/github-event-refresh.ts`        | `GithubEventIssueRefresher.pending`、`refresh` 及 `pendingKeys` 依赖（若 P5.6 未用上）                                                            |
| `lib/issues/wakeups/model.ts`               | `conditionTargetId`                                                                                                                               |
| `lib/issues/sources/local-source.ts`        | `mutate`（`bulk-actions` 对 local 从不调用；确认后删并在类型上把 `mutate` 留给联邦源）                                                            |
| `types/issues/collab.ts`                    | `toCollabActor`、`issueActorsResolvable`                                                                                                          |
| `stores/issues/issue-view-store.ts`         | `reset`（若仅测试使用，按仓库惯例改名为 `__resetForTesting` 或保留注释）                                                                          |

`reset*ForTesting` 系列保留。组件级死导出审计时未扫完，P6 补扫 `components/issues/**` 与 `hooks/issues/**`，结果加入本表。

### P6.2 文档

- 修所有过时注释：`state-machine.ts:3-14`（调用方清单）、`event-bus.ts:7-8`、`sources/registry.ts:4-5`、`github-comments.ts:1-8`、`sync-runner.ts:2`、`github-issue-sync-executor.ts:3-4`、`issue-console.tsx:686-689`。
- ADR-0132 补 §8「2026-11 状态流修订」：运行锁在数据库层、两阶段启动、`review` 结算、`run_cancelled` 与 `statusBefore`、原子结算与 boot 修复、提交后事件、写入边界门禁、源订阅、泳道、自动链接；更正 §2 的结算来源描述（agent-task 监听 `agentTasks` + `integrationActionJobs`，agent-team 由 store 订阅 poll）与 §Consequences 中「一处强制」「每个事件都有生产者」的表述。中英两份 ADR 同步。

### P6.3 Playwright e2e

- 新 spec `tests/e2e/issues/issue-state-flow.spec.ts`：创建项目与 issue（单事务）、拖放、活跃 run 时 `in_progress` 置灰与写入拒绝、取消后回原列并显示「已取消」通知、联邦源行实时刷新、泳道切换、`?identifier=` 深链接与「不存在」态。
- 按 `check-e2e-governance` 的要求登记 spec。运行时需要可控的假 run 适配器：用现有 e2e 测试接缝（`NEXT_PUBLIC_E2E=1`）注册，不改生产注册逻辑；若无现成接缝，先读 `tests/e2e` 的既有做法再定，回报。

## 10. 风险与回报点

实施中遇到下列情况先停下回报，不自行决定：

1. 同步引擎的远端状态是否受运行锁约束（P1.1）。
2. `agentTeamManager.start` 没有「受理」信号，需要在 Agent Team 侧加回调（P1.2）。
3. check-in 期间允许新派发是否导致双写（P1.5）。
4. 手机同步表未注册 `issueRuns`（P4.3）。
5. e2e 没有可用的假适配器接缝（P6.3）。
6. authoring kit 重建需要干净 checkout 与 cognia-plugins 推送（P1.4）——推送前确认。

## 11. 后续（不在本计划内）

跨子系统重复：`lib/issues/board-model.ts` 与 `lib/ai/agent/team/board-model.ts` 的拖放/筛选逻辑，三套移动守卫（`canMoveIssue`、`canMoveTask`、`guardAgentTaskMove`）的语义对齐，`components/agent/agent-task-board.tsx` 迁移到 `components/board/kanban-board.tsx`。以独立任务卡提出。
