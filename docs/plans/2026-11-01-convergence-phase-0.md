# 架构收敛 阶段 0 实施计划：止血

状态：计划已定稿，未开始实施。创建：2026-11-01（Asia/Shanghai）。上游：

- 决策：[ADR-0250](../content/docs/en/adr/0250-the-runtime-is-a-headless-kernel-the-desktop-embeds.md)
- 证据：[架构审计](../research/architecture-convergence-audit-2026-11-01.md)
- 相关：[ADR-0247](../content/docs/en/adr/0247-long-lived-work-carries-a-mandate-and-follows-its-threads.md)、[ADR-0249](../content/docs/en/adr/0249-a-background-jobs-completion-reaches-the-agent.md)

实施方式：

- 在独立 worktree 分支 `refactor/convergence-phase-0` 上进行，不在共享工作区里改代码。
- 机械性工作包交给 Codex `gpt-6.1-sol` xhigh；门禁设计和高风险核实由 Claude 负责。
- 每个工作包都由 Claude 审查 diff、亲自重跑验证，再由第二个模型做对抗审查，然后才提交。

## 1. 目标与验收

阶段 0 结束时：

1. **不再新增债务。** 收敛门禁记录全部基线，任何计数上升都会失败；无头注册表门禁不再按函数命名匹配。
2. **门禁全部通过。** `audit:host-parity`、`audit:headless-registry`、新的 `audit:convergence` 在 `dev` 上都是绿的。
3. **已确认的缺陷修复。** router-fusion outbox 有退避、有上限、有死信，不会再饿死新效果。
4. **两项高风险问题有答案。** Host 自动归档、shadow 入队的外发任务切到 enforce 之后的行为，都由测试回答；是缺陷的就修掉。
5. **基线全部记录。** ADR-0250 §5 中写着"阶段 0 测量"的那一项也测出来。

## 2. 工作包

### WP0 收敛门禁与基线（Claude 设计，Codex 实现）

新增 `scripts/gates/check-convergence.mjs`，注册到 `check-all.mjs`，并在 `package.json` 加上 `audit:convergence`、`audit:convergence:baseline`、`audit:convergence:test`。

度量项：

| 键                     | 计算方式                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib-store-imperative` | 引用了 `@/stores/`、并在文件内调用 `.getState(` / `.setState(` / `.subscribe(` 的 `lib/` 非测试文件                                                         |
| `lib-ui-imports`       | 引用了 `@/hooks/` 或 `@/components/` 的 `lib/` 非测试文件                                                                                                   |
| `queue-tables`         | `CURRENT_SCHEMA` 中的队列表：行类型带 `attempts` 字段，并带 `nextAttemptAt`、`lease*` 或 `status: "pending"`。以文件清单形式记录，阶段 1 迁到原语后逐个划掉 |
| `limiters`             | 非测试源码里的 `maxConcurrent*`、`Semaphore`、`ConcurrencyGate`、`concurrency:` 默认值，以文件:符号清单形式记录                                             |
| `run-tables-unlinked`  | 类运行表（清单写在门禁的配置里，初始值取自审计 §3.1）中，没有 `runId` 或 `parentRunId` 字段的表                                                             |

规则：

- 清单型度量按集合比较。新出现的条目视为新增债务，门禁失败；消失的条目会提示运行 `:baseline` 锁定。
- 输出要区分"新增"和"已偿还"。

验收：

- 门禁自身有测试（`node --test`），覆盖新增、偿还、基线写入。
- 在当前树上跑出来的基线数字与审计数字对得上，差异要逐项解释并写进证据台账。

### WP1 无头注册表门禁不再按命名匹配（Claude）

修改 `scripts/gates/check-headless-registry.mjs`：

- 现在：只检查名字形如 `install*` / `start*` / `register*` 的符号。
- 改为：初始化器在 `useEffect` / `useLayoutEffect`（以及它们调用的局部函数）里调用的**任何** `@/lib/**` 导入，都必须满足三者之一：
  - 能从 brain 的模块图到达；
  - 被 `headless-registry-exclusions.json` 按符号排除，并写明理由；
  - 被标为纯 UI 的符号。纯 UI 的判定依据是：符号所在模块只依赖 React 或 DOM，或者在排除文件的 `uiOnly` 段里列出。
- 第一次运行，预计会暴露审计里那 32 个未说明的缺口（以及门禁之前看不到的其他缺口）。

处理方式：

- 每一项都要归类：
  - 物理上不可能 → 写进排除文件并给出理由；
  - 尚未迁移 → 写进新的 `pending` 段，并注明对应阶段。`pending` 计入收敛基线，只许减少。
- 顺手删掉已经过时的排除项：`renderer-perf-initializer.tsx` 的 `subscribeRuntimeTargetContext`。

验收：

- 门禁测试覆盖以下情况：非 `install*` 命名的副作用被发现；被排除的符号放行；`pending` 计数只减不增。
- `provider-oauth-refresh-initializer.tsx` 的 `refreshExpiringOAuthCredentials` 必须被发现（审计已核实，它是回归样例）。

### WP2 宿主一致性门禁恢复通过（Claude 判断，Codex 补标注）

- 运行 `pnpm audit:host-parity:baseline`，锁定已经关闭的 9 项差异。
- 给 27 个未分类的子系统写分类（`physically-impossible` / `unmigrated` / `ui-assumption` / `seam-infrastructure`），每条附一句说明它的守卫实际做什么。
  - 分类要读代码后再判断，不能凭目录名猜。
  - 要特别核实 `lib/background-tasks`、`lib/best-of-n`、`lib/sandbox`、`lib/gateway`，它们很可能是 `unmigrated`。

验收：`pnpm audit:host-parity` 通过；每条新分类都有说明。

### WP3 修复 router-fusion outbox（Codex 实现，Claude 审查）

现状（审计 §6，已核实）：

- `lib/router-fusion/db/outbox.ts` 的 `drainOnce` 按 `createdAt` 取前 500 条 `pending`。
- 失败的行只增加 `attempts`，没有退避，没有上限，没有死信。

修改：

- `FusionOutboxRow` 新增：
  - `nextAttemptAt`；
  - 状态 `"deadletter"`；
  - `deadletteredAt`。
- `fusion-db.ts` 是独立的 Dexie 数据库：要给它升级版本，并加索引 `[status+nextAttemptAt]`（不涉及 CogniaDB 的 `CURRENT_SCHEMA`）。
- 重试复用 `decideNextAttempt`（`packages/plugin-contract/src/lib/queue/retry-policy.ts`）。达到上限就转为 `deadletter`，并记录诊断。
- drain 只取 `pending` 且 `nextAttemptAt <= now` 的行，按 `nextAttemptAt` 排序。这样毒行不会挡住新效果。
- 找不到 applier（未知 kind）时直接进死信，不再重试。

验收测试：

- 一个永久失败的效果，在第 N 次后进入死信；
- 600 条失败的行加 1 条新效果，新效果在第一次 drain 就被处理；
- 未知 kind 立即进死信；
- 原有行为（成功、跳过、并发 drain 合并）保持不变。

这是 ADR-0250 阶段 1 持久化队列原语的第一个用户。如果 WP0 的基线把它列为队列表，WP3 完成后它仍然保留在清单里，等阶段 1 迁到原语时再划掉。

### WP4 核实高风险问题一：Host 上的自动归档（Claude）

疑点（审计 §2.2）：

- `lib/chat/auto-archive-schedule.ts:80-102` 靠聊天 store 来判断"已打开 / 正在运行"的会话，从而豁免它们。
- 在 brain 上这个 store 是空的。
- 所以正在 Host 上运行的会话，可能被自动归档。

步骤：

1. 读归档的执行路径，确认它在 brain 上会不会运行：自动归档是一个调度器维护任务，而 brain 运行调度器。
2. 写特征测试：在 Node（brain 配置）下准备一个正在运行的会话（`ExecutionRun` 处于 running，或者有活跃的工作租约），然后运行归档任务，断言会话是否被归档。
3. 如果确认是缺陷，就改成从内核状态判断"正在运行"：活跃的 `executionRuns`、工作租约、后台保持的持久化记录，不再读 UI store。这是 ADR-0250 §2 规则的第一个落地点。

验收：测试固定行为；如果是缺陷，修复后测试由红转绿，并在台账里记一条。

### WP5 核实高风险问题二：shadow 入队的外发任务切到 enforce 之后（Claude）

疑点（审计 §5.2）：`lib/connectors/outbound-runner.ts` 发送前不会重新规划，只透传 `authorizedBy`。shadow 期间入队、本应被拦的任务，切到 enforce 后可能照样发出去。

步骤：

1. 读入队处（`enqueueGoverned`，`lib/connectors/delivery-gateway.ts`）在 shadow 下记录了什么：`plan.enforced`、shadow 回执。
2. 写测试：shadow 模式下入队一个本应被 `park` / `deny` 的任务，然后切到 enforce，再运行 runner，断言它会不会被发出。
3. 如果会发出，就让 runner 在发送前检查：任务入队时的规划结果是 shadow 下的非 allow，而当前模式是 enforce，则重新规划；不再允许就转为 park，并发出回执。修复方案要与 ADR-0239 的作者意图核对，必要时在 ADR-0239 里补一条后续说明。

验收：测试固定行为；如果是缺陷，修复并记入台账。

### WP6 Monitor 工具描述停止承诺送达（Codex）

ADR-0249 要求在它落地之前，Monitor 的描述先不再承诺"触发时送达"。

- 修改 `sidecar/src/tools/builtin/core-files/monitor.ts` 的描述：超过阻塞阈值后返回 `monitorId`，结果需要用相应的工具读取。
- 写清楚怎么读：先查实际可用的工具；如果没有可读的工具，就把这一点作为缺口记进台账，交给 ADR-0249 处理。

验收：`pnpm sidecar:test` 通过；描述与行为一致。

### WP7 证据台账与收尾（Claude）

- 新建证据台账 `docs/evidence/2026-11-01-convergence-phase-0.md`，按 evidence-driven-dev 的格式记录：
  - 各工作包的观察与结论；
  - 基线数字；
  - WP4、WP5 的结论；
  - 残余风险。
- ADR-0250 §5 中"阶段 0 测量"那一项，用 WP0 的实测值回填。
- 在 `dev` 上运行全部相关门禁：`audit:convergence`、`audit:headless-registry`、`audit:host-parity`、`audit:colocated-tests`、`typecheck`、受影响的测试（`pnpm test:changed`）。

## 3. 顺序与并行

```
WP0 ──┐
WP1 ──┼─→ WP7
WP2 ──┤
WP3 ──┤   （WP3、WP6 是机械性工作，交给 Codex 排队执行）
WP4 ──┤   （WP4、WP5 需要判断，由 Claude 做）
WP5 ──┤
WP6 ──┘
```

- WP0 和 WP1 都改门禁基础设施，但互相不依赖。WP1 新增的 `pending` 计数要接进 WP0 的门禁，所以 WP0 先合并。
- WP3、WP6 分别交给 Codex 执行。按"同一仓库一次只跑一个实现任务"的规则排队。
- WP4、WP5 是核实任务：先写测试，再决定要不要修。

## 4. 约束

- 只提交本阶段的路径，提交时用 `git commit --only` 或显式列出路径（CLAUDE.md 规则 8）。
- 不改 CogniaDB 的 `CURRENT_SCHEMA`。WP3 只升级 fusion 自己的数据库。
- 新增的门禁脚本和测试遵守同目录测试规则。门禁脚本的测试用 `node --test`。
- 不做覆盖率统计（CLAUDE.md 规则 3）。

## 5. 不在本阶段

- 持久化队列和限流器原语本身（阶段 1）。
- 桌面从注册表启动、抽出聊天引擎（阶段 2）。
- ADR-0247、ADR-0248、ADR-0249 的实现（分别归入阶段 3、1、2）。
- 审计待核实清单里 WP4、WP5 以外的项。它们按所属阶段处理，记进台账。
