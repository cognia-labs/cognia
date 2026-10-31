# 架构收敛 阶段 0 实施计划：0a 摸清事实、S1 本地 brain spike、0b 修复

状态：计划已定稿，未开始实施。创建：2026-11-01（Asia/Shanghai）。修订：2026-11-01，按第二轮审查和设计讨论的决定，由原 WP0–WP7 改写为 0a / S1 / 0b 三条线。

上游：

- 决策：[ADR-0250](../content/docs/en/adr/0250-the-runtime-is-a-headless-kernel-the-desktop-embeds.md)
- 证据：[架构审计](../research/architecture-convergence-audit-2026-11-01.md)（尤其是 §10）
- 相关：[ADR-0247](../content/docs/en/adr/0247-long-lived-work-carries-a-mandate-and-follows-its-threads.md)、[ADR-0249](../content/docs/en/adr/0249-a-background-jobs-completion-reaches-the-agent.md)

实施方式：

- 三条线各用一个独立 worktree 分支：`refactor/convergence-0a`、`spike/local-brain-s1`、`refactor/convergence-0b`。不在共享工作区里改代码。
- 机械性工作包交给 Codex `gpt-6.1-sol` xhigh；门禁设计、spike 和高风险核实由 Claude 负责。
- 每个工作包都由 Claude 审查 diff、亲自重跑验证，再由第二个模型做对抗审查，然后才提交。
- 每条线一份证据台账，放在 `docs/evidence/`，按 evidence-driven-dev 的格式记录。

## 0. 为什么拆成三条线

原计划把"摸清事实""修缺陷""定桌面形态"混在一个阶段里，第二轮审查发现了三个问题：

- **基线不可信。** 原 WP0 的启发式会漏掉独立数据库里的队列（`fusionOutbox`、`accountSyncOutbox`）、非 `maxConcurrent*` 命名的上限（SFTP 传输队列、`DEFAULT_AI_TURN_LIMIT` 一类常量），还把"有个叫 `runId` 的字段"当成"关联到了台账"。数字不可信，棘轮就没有意义。
- **修复不必等形态。** router-fusion outbox、cron 分歧这些缺陷，无论桌面最后选 2a 还是 2b 都要修。
- **形态需要测量。** 桌面要不要跑本地 brain（ADR-0250 §2），得靠 spike 的数据决定，不能在计划里假设。

所以：

- **0a** 先把事实和安全网建起来：可复现的清单、不能悄悄调高的基线、双宿主测试通道。
- **S1** 与 0a 并行，限时一周，回答 ADR-0250 §2 的五个问题。
- **0b** 与两者并行，不等 S1，修已确认的缺陷，让门禁在 `dev` 上恢复全绿。

ADR-0250 在 S1 结束后修订为 2a 或 2b。

## 1. 目标与验收

| 线  | 结束时                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0a  | 清单和计数器已提交，基线与清单逐项一致；基线增长检查在 CI 中生效；双宿主测试框架在 CI 中驱动至少一个行为跑通两个宿主；宿主适配器矩阵和插件 API 矩阵已提交 |
| S1  | ADR-0250 §2 的五个问题各有测量结果，写进 spike 台账；给出 2a 或 2b 的建议和理由                                                                           |
| 0b  | `dev` 上所有门禁为绿；每项修复都有由红转绿的测试；两项高风险疑点（Host 自动归档、shadow 期入队的外发任务）有测试固定的结论                                |

## 2. 0a：摸清事实、搭安全网

### A1 在干净 worktree 上确认门禁状态（Claude）

审计 §10.7 列出的红门禁是在共享工作区上跑的，里面混着其他会话未提交的改动。

- 在 `dev` 的干净 worktree 上跑 `scripts/gates/check-all.mjs` 的全部 122 个门禁。
- 逐个记录：通过、失败（附失败项）、跑不起来（附原因）。
- 在 `dev` 上也失败的，转成 0b 的工作项（见 B9）；只在共享工作区失败的，记为"属于其他会话的改动"，不处理。

验收：台账中有一张 122 行的门禁状态表，标明对应的 `dev` 提交。

### A2 可复现的清单和计数器（Claude 设计，Codex 实现）

新增 `scripts/gates/convergence/`：一个计数器脚本，加一组清单文件。

**规则：**

- 清单是带成员的列表，每个成员有文件、符号或表名，以及属主。计数器在给定提交上生成清单，结果可复现。
- 启发式只用来发现候选，候选要由人工确认后才进清单。确认结论写进清单的 `note` 字段。
- 清单文件头记录生成它的提交 SHA。

**清单与发现方式：**

| 清单                   | 发现方式                                                                                                                              | 已知要覆盖的漏网项                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `runtime-initializers` | 承担运行时、既无注册条目也无排除说明的 provider 初始化器（与 A2 同时跑 B6 扩大后的无头注册表门禁，两者对账）                          | 审计 §2.2 的 32 个上限                                                                                |
| `lib-store-imperative` | 静态和动态导入 `@/stores/`、并调用 `.getState(` / `.setState(` / `.subscribe(` 的 `lib/` 非测试文件，两个口径都记                     | 294 / 409                                                                                             |
| `lib-ui-imports`       | 静态和动态导入 `@/hooks/` 或 `@/components/` 的 `lib/` 非测试文件                                                                     | 64 / 74                                                                                               |
| `durable-queues`       | 所有 Dexie 数据库（不只是 CogniaDB 的 `CURRENT_SCHEMA`）里行类型带重试计数、到期时间、租约或待处理状态的表，加上非 Dexie 的持久化队列 | `fusionOutbox`、`accountSyncOutbox`、`evalOnlineQueue`、`mediaGenerationJobs`、`connectorInboundJobs` |
| `caps`                 | 非测试源码里的并发与次数上限，分两段：`business`（业务准入）和 `native`（保护真实资源，附被保护的资源）                               | SFTP 传输队列、`DEFAULT_AI_TURN_LIMIT`、Python 宿主信号量、沙箱池、节点安装槽位                       |
| `run-tables`           | 类运行表，每张表记录它对 `executionRuns` 的引用方式：真实引用（外键语义、写入时同步）、仅同名字段、没有                               | 审计 §3.1 的约 23 种                                                                                  |

新增 `scripts/gates/check-convergence.mjs`，注册到 `check-all.mjs`，并在 `package.json` 加上 `audit:convergence`、`audit:convergence:baseline`、`audit:convergence:test`：

- 清单按集合比较。新出现的成员视为新增债务，门禁失败；消失的成员提示运行 `:baseline` 锁定。
- 输出区分"新增"和"已偿还"。

验收：

- 门禁自身有 `node --test` 测试，覆盖新增、偿还、基线写入，以及上表"已知漏网项"各自至少一例。
- 清单数字与审计数字逐项对账，差异逐条解释并写进 0a 台账，然后回填 ADR-0250 §11 的表。

### A3 基线增长检查（Claude）

现在 PR 可以在同一个改动里调高棘轮基线。新增 `scripts/gates/check-baseline-growth.mjs`：

- 枚举所有棘轮基线文件：`colocated-test-baseline.json`、host-parity 基线、i18n 基线、`check-rpc-semantic-parity` 的上限、A2 的清单，等等。清单本身写在门禁配置里，并有一个测试检查没有遗漏 `scripts/gates/` 下的 `*baseline*` 文件。
- 在 CI 中把每个文件与 PR 的合并基准比较，计数增长即失败。
- 例外：PR 带一条例外记录（`scripts/gates/baseline-exceptions/<日期>-<slug>.json`），写明增长项、属主和偿还阶段。例外记录本身也在台账里汇总。

验收：测试覆盖增长失败、减少通过、带例外通过、例外缺字段失败；CI 工作流中接入并在一个故意增长的分支上验证失败。

### A4 双宿主测试框架和 PR 通道（Claude 设计，Codex 补用例）

现状（审计 §10.5）：e2e spec 200 个，Tauri 24 个；真正跑在 Web↔无头栈上的只有 `tests/real-e2e/` 下的 2 个，而运行它们的 Compose tier 2 只在夜间和手动触发时跑（`.github/workflows/compose-e2e.yml`）。

- 抽出一个双宿主测试框架：同一个用例，一次以桌面 WebView 配置运行，一次以 Web 客户端加无头 brain 运行。brain 端复用 Compose 本地的 Anthropic fixture，保证不需要厂商密钥。
- 先迁入一个行为做样板：一次带工具调用的聊天轮次，断言两个宿主上的工作台账结果一致。
- 新增 PR 通道：改动涉及 `lib/headless/`、`lib/runtime/`、契约生成物、`crates/cognia-companion/` 时，跑这条 brain 集成通道并阻断合并。镜像构建太重的话，用预构建镜像加本次改动的 TypeScript 覆盖层，具体方案在台账里比较后定。

验收：样板用例在 CI 中两个宿主都跑通；路径过滤和阻断在一个测试 PR 上验证。

### A5 宿主适配器矩阵（Claude）

`docs/research/` 下新增一份矩阵：注册表里的每个 `HeadlessRuntime` 条目，加上 A2 `runtime-initializers` 清单里的每个成员，各占一行，列出它在 desktop、brain、person-brain 上分别如何组装：事件发布器、连接器服务生命周期、插件适配器、需要的原生能力。

用途：

- S1 用它判断 2a 下哪些原生能力要经 bridge 回调 Tauri 进程。
- 如果最后选 2b，它就是 ADR-0250 §2 要求的适配器矩阵。

验收：矩阵覆盖注册表全部条目和清单全部成员；S1 台账引用它。

### A6 插件 API 矩阵（Claude 设计，Codex 填表）

插件契约（`packages/plugin-sdk/contract/catalog.json`，contractVersion 1.7.0）有 91 个命名空间、938 个方法，其中 120 个声明支持无头。

- 为每个方法标注：宿主层、UI 层，还是两层都要；当前 TypeScript、Python、WASM 各自是否提供；第一方插件里有没有调用方。
- 标出 UI 层方法中，宿主侧插件可能调用、需要转给在线客户端的那些。
- 这份矩阵是新插件契约 ADR（ADR-0250 §9）的输入，不在阶段 0 里写那份 ADR。

验收：938 个方法全部标注；第一方调用方由脚本统计，不靠人工估计。

## 3. S1：本地 brain spike（Claude，一周）

分支 `spike/local-brain-s1`。spike 的代码不合入 `dev`，只合入台账和结论。

**目标：** 回答 ADR-0250 §2 的五个问题，每个都要有测量值。

| #   | 问题               | 方法                                                                                                                                         | 记录                                             |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | 桌面规模下的存储   | 准备不小于现有最大真实本地库的数据集（脱敏或合成，条数与真实库对齐）。在 brain 存储和当前 WebView Dexie 上分别测会话列表、打开会话、追加消息 | 吞吐、p50 / p95 延迟、数据集规模                 |
| 2   | 启动               | Tauri 启动 brain 子进程，测冷启动到 UI 可用的时间，以及 brain 进程的常驻内存                                                                 | 与当前桌面的差值                                 |
| 3   | 迁移               | 把一个现有桌面账户的数据从 WebView 数据库迁到 brain 存储，逐表核对条数；列出账户同步副本和其他宿主存储（向量库、job 数据库等）各自的去向     | 逐表条数对照、迁移耗时、无法迁移的项             |
| 4   | 一个完整的聊天轮次 | WebView 作为本地宿主的客户端，跑一次带工具和一次审批的轮次；同时打开两个窗口作为客户端                                                       | 是否跑通、两个窗口看到的状态是否一致、遇到的阻塞 |
| 5   | brain 崩溃并重启   | 轮次中途杀掉 brain，观察桌面的重启监管和 UI 的断开状态；客户端在断开期间的操作是否按意图排队                                                 | UI 表现、意图是否在恢复后被宿主接受或拒绝        |

**决定规则：**

- 五项都没有阻塞性问题，且问题 1、2 的退化在台账写明的可接受范围内 → 建议 2a。可接受范围在 spike 第一天写进台账，之后不改。
- 任何一项有无法在阶段 2 内解决的阻塞 → 建议 2b，并写明阻塞点。
- 建议交给用户决定，然后修订 ADR-0250 §2，删掉未选的那一支。

**时间盒：** 一周到期时，没答完的问题记为"未知"，并说明还需要多久。不自动延期。

## 4. 0b：修复

0b 不等 S1。每一项都先写测试固定现状，再修。

### B1 router-fusion outbox（Codex 实现，Claude 审查）

现状（审计 §6，已核实）：`lib/router-fusion/db/outbox.ts` 的 `drainOnce` 按 `createdAt` 取最早的 500 条 `pending`。失败只增加 `attempts`、写入 `lastError`，状态仍是 `pending`；没有退避、没有上限、没有死信。毒行超过 500 条后，新效果永远轮不到。

修改：

- `FusionOutboxRow` 新增 `nextAttemptAt`、状态 `"deadletter"`、`deadletteredAt`。
- `fusion-db.ts` 是独立的 Dexie 数据库：升级它自己的版本，加索引 `[status+nextAttemptAt]`。不涉及 CogniaDB 的 `CURRENT_SCHEMA`。
- **现有行升级。** 版本升级时，给所有没有 `nextAttemptAt` 的 `pending` 行补上值（取 `createdAt`），否则它们在新索引下查不到，会被悄悄藏起来。已超过上限的行直接转为死信。
- 重试复用 `decideNextAttempt`（`packages/plugin-contract/src/lib/queue/retry-policy.ts`）。达到上限转为死信，并记录诊断。
- drain 只取 `pending` 且 `nextAttemptAt <= now` 的行，按 `nextAttemptAt` 排序。
- **到期唤醒。** drain 结束后，按最早的 `nextAttemptAt` 安排一次唤醒。否则没有新效果写入时，到期的重试永远不会被处理。
- 找不到 applier（未知 kind）时直接进死信。

验收测试：

- 永久失败的效果在第 N 次后进入死信；
- 饿死用例：先写入 600 条永久失败的行并让它们各失败一次，再写入 1 条新效果，新效果在下一次 drain 就被处理（用例里的时钟固定，不依赖真实时间）；
- 只有到期重试、没有新写入时，唤醒会触发 drain；
- 旧版本数据库升级后，原有 `pending` 行全部可见；
- 未知 kind 立即进死信；
- 原有行为（成功、跳过、并发 drain 合并）保持不变。

阶段 1 迁到持久化队列原语之前，它留在 A2 的 `durable-queues` 清单里。

### B2 工作流 cron 分歧与被吞掉的失败（Claude 判断，Codex 实现）

现状（审计 §6，已核实）：编辑器的 TS 解析器接受 `L` 和 `#`，Rust 守护进程（`crates/cognia-scheduling/src/workflow/triggers/cron_daemon.rs:62`）拒绝。注册经 `lib/workflow/runtime/tauri-bridge.ts` 的 `safeInvoke` 调用，异常记录一次就返回 `null`，`registerTrigger` 照常返回。`persistRunState` 走同一个 `safeInvoke`。

修改：

- **共享测试向量。** 新增一组 cron 向量文件（表达式、时区、期望的下几次触发时间或期望的拒绝），TS 和 Rust 两侧的测试都读它。这是 ADR-0250 §8"共享业务规则有共享测试向量"的第一个落地点。
- **对齐语义。** 两侧接受同一个集合。是让 Rust 支持 `L` 和 `#`，还是让编辑器拒绝，要先看现有已保存的工作流里有没有用到；有用到的就让 Rust 支持。结论记进台账。
- **失败不再被吞掉。** `registerTrigger` 和 `persistRunState` 改为显式返回失败，编辑器在保存时显示错误。已保存但从未注册成功的触发器，启动时重新注册一次并报告结果。
- `safeInvoke` 的其他调用点逐个分类：可以容忍失败的保留，必需的改为显式失败。

验收：向量在两侧测试中都通过；注册失败的用例由"静默成功"变为"显式失败"；用户可见的错误文案接入 i18n。

### B3 宿主不再写入后备权威（Claude）

现状（审计 §10.1）：`DataPlane::pick`（`crates/cognia-companion/src/data_plane.rs:77`）在没有已连接的 brain、也没有渲染进程时，返回可写的 `Direct` SQLite 存储。brain 断线期间写进去的数据没有对账。

步骤：

1. **先列清楚。** 枚举 `DataPlane::Direct` 的所有写方法，以及今天哪些部署会真正走到 `Direct`：只有 `cognia-server` 而 brain 未连接时、person 分区等。结论写进台账。
2. **写入改为拒绝。** `Direct` 分支的写方法返回明确的 `HOST_UNAVAILABLE` 错误，读方法保留。这是 ADR-0250 §4 的落地。
3. **客户端表现。** 核对每类客户端收到 `HOST_UNAVAILABLE` 时的行为：移动端已有的 `mobileOutboundQueue` 是否按意图排队并在恢复后重放；浏览器客户端是否显示断开状态。没有排队能力的客户端，在 0b 里至少要显示明确的错误，不能丢弃用户输入而不提示；完整的意图队列记为阶段 2 的工作。
4. 更新 `data_plane.rs` 的模块文档和 companion 响应 schema 目录（手工维护，按条目修改，不重新导出）。

验收：Rust 测试覆盖"brain 未连接时写入被拒绝、读取正常"；移动端在断开期间的一次发送，恢复后被宿主接受；行为变化写进 changeset。

### B4 持久化外发授权的来源（Claude）

疑点（审计 §5.2）：`lib/connectors/outbound-runner.ts` 发送前不重新规划，只透传 `authorizedBy`。shadow 期间入队、本应被拦下的任务，切到 enforce 后可能照样发出。

步骤：

1. 读入队处（`enqueueGoverned`，`lib/connectors/delivery-gateway.ts`）在 shadow 下记录了什么。
2. 写测试：shadow 模式下入队一个本应被 `park` 或 `deny` 的任务，切到 enforce，再运行 runner，断言它会不会被发出。
3. **无论测试结果如何，都把授权来源持久化到任务上：** 规划时的模式（shadow 或 enforce）、规划结论、策略版本、回执 id。它们与队列行在同一个事务里写入（审计 §5.2：现在入队时会删掉原始 `authorization`，shadow 下被拒的分支不带 `authorizedBy`，回执在入队之后单独写且允许失败）。这是 ADR-0250 §10"授权决定和它所授权的工作一起持久化"的落地。
4. runner 发送前检查：任务的规划结论是 shadow 下的非 allow，而当前模式是 enforce，就重新规划；不再允许就转为 park，并发出回执。缺少来源字段的历史任务按"未知"处理，同样重新规划。
5. 修复方案与 ADR-0239 的作者意图核对，必要时在 ADR-0239 里补一条后续说明。

验收：测试固定行为；历史任务（无来源字段）的用例覆盖到；如果原先会发出，修复后测试由红转绿，并记进台账。

### B5 宿主一致性门禁恢复通过（Claude 判断，Codex 补标注）

现状（`pnpm audit:host-parity -- --report`）：当前 200 项，A 类 96、C 类 104；与基线 183 相比新增 26 项（都在 C 类），关闭 9 项；另有 27 个未分类的子系统。

- 逐项处理 26 项新增：读代码判断是真实的新缺口（记进 A2 清单并注明阶段）还是门禁误报（修门禁规则）。不能直接写进基线了事。
- 给 27 个未分类子系统写分类（`physically-impossible` / `unmigrated` / `ui-assumption` / `seam-infrastructure`），每条附一句说明它的守卫实际做什么。要特别核实 `lib/background-tasks`、`lib/best-of-n`、`lib/sandbox`、`lib/gateway`。
- 处理完后运行 `pnpm audit:host-parity:baseline`，锁定关闭的 9 项。基线变化经 A3 的增长检查，新增部分要带例外记录。

验收：`pnpm audit:host-parity` 通过；26 项和 27 个子系统每条都有结论。

### B6 扩大无头注册表门禁（Claude）

修改 `scripts/gates/check-headless-registry.mjs`：

- **现在：** 只检查名字形如 `install*` / `start*` / `register*` 的符号，并要求它们"在 brain 的可达集合内被调用"。
- **改为：** 初始化器在 `useEffect` / `useLayoutEffect`（以及它们调用的局部函数）里调用的**任何** `@/lib/**` 导入符号，都必须满足三者之一：
  - **在 brain 可达集合内被调用。** 保留原规则的"被调用"要求，不能退化成"模块可达"：模块被 brain 导入、但这个符号从没被调用，仍然算缺口。
  - 被 `headless-registry-exclusions.json` 按符号排除，并写明理由；
  - 是纯 UI 符号：所在模块只依赖 React 或 DOM，或在排除文件的 `uiOnly` 段里列出。
- 新增 `pending` 段：尚未迁移的项写进去并注明阶段，计入 A2 的 `runtime-initializers` 清单，只许减少。
- 删掉过时的排除项：`renderer-perf-initializer.tsx` 的 `subscribeRuntimeTargetContext`。

验收：门禁测试覆盖以下情况：

- 非 `install*` 命名的副作用被发现；
- 模块被 brain 导入、但符号没被调用的情况被判为缺口（防止回归到"可达即可"）；
- 被排除的符号放行；
- `pending` 只减不增；
- `provider-oauth-refresh-initializer.tsx` 的 `refreshExpiringOAuthCredentials` 被发现（审计已核实的回归样例）。

### B7 核实 Host 上的自动归档（Claude）

疑点（审计 §2.2）：`lib/chat/auto-archive-schedule.ts:80-102` 靠聊天 store 判断"已打开 / 正在运行"的会话，从而豁免它们。brain 上这个 store 是空的，所以正在 Host 上运行的会话可能被自动归档。

步骤：

1. 确认归档任务在 brain 上会不会运行：它是调度器维护任务，而 brain 运行调度器。
2. 写特征测试：在 Node（brain 配置）下准备一个正在运行的会话（`ExecutionRun` 处于 running，或有活跃的工作租约，或有后台保持记录），运行归档任务，断言会话是否被归档。
3. 如果是缺陷，改为从内核状态判断"正在运行"：活跃的 `executionRuns`、工作租约、后台保持的持久化记录，不再读 UI store。这是 ADR-0250 §5"状态只有一个属主"的第一个落地点。

验收：测试固定行为；如果是缺陷，修复后由红转绿，并记进台账。

### B8 Monitor 工具描述停止承诺送达（Codex）

ADR-0249 要求在它落地之前，Monitor 的描述先不再承诺"触发时送达"（审计 §6）。

- 修改 `sidecar/src/tools/builtin/core-files/monitor.ts` 的描述：超过阻塞阈值后返回 `monitorId`，结果需要用相应的工具读取。
- 先查实际可用的读取工具；没有的话，描述里不提读取方式，并把这一点作为缺口记进台账，交给 ADR-0249。
- 按规则 7 补齐三处标注：类型注释说明送达尚未实现，描述里不承诺，测试固定"没有异步送达"。

验收：`pnpm sidecar:test` 通过；描述与行为一致。

### B9 A1 发现的其他红门禁（Claude 分派）

A1 确认在 `dev` 上也失败的门禁，逐个修复。审计 §10.7 在共享工作区上看到的候选有：

- `check-rust-architecture`：未登记的 `src-tauri/src/native_agent_bridge.rs`；
- `check-sidecar-architecture`：7 项；
- `check-colocated-tests`：1 个缺测试的文件；
- `check-rpc-semantic-parity`：114 个不透明响应 schema，超过上限 110。修复方向是给新增的响应补 schema，不是调高上限。

只在共享工作区失败的，不在本阶段处理。

验收：A1 表格里 `dev` 上失败的门禁全部转绿。

## 5. 顺序与并行

```
0a: A1 ─→ A2 ─→ A3
          A4（独立）
          A5 ─────────┐
          A6（独立）   │
S1:  ─────────────────┴─→ 建议 2a / 2b ─→ 用户决定 ─→ 修订 ADR-0250 §2
0b: B1、B2、B4、B7、B8（独立）
    B3（独立，但它的客户端核对结论要同步给 S1 问题 5）
    B6 ─→ B5（B6 改变门禁口径后再处理 host-parity 的分类，避免分两次）
    A1 ─→ B9
```

- A2 的 `runtime-initializers` 清单与 B6 的门禁输出对账，两者同时收尾。
- A3 要在 B5 锁定基线之前合并，这样 B5 的基线变化也经过增长检查。
- Codex 的实现任务按"同一仓库一次只跑一个实现任务"的规则排队：B1、B2、A2 的计数器、A6 的填表、B8。
- S1 第一天写下问题 1、2 的可接受范围，A5 的矩阵在 S1 第三天前给出初稿。

## 6. 收尾

- 三份证据台账：`docs/evidence/2026-11-01-convergence-0a.md`、`…-s1.md`、`…-0b.md`。各自记录观察与结论、基线数字、残余风险。
- 用 A2 的实测值回填 ADR-0250 §11 的表；用 S1 的结论修订 ADR-0250 §2。
- 在 `dev` 上运行：`audit:convergence`、基线增长检查、`audit:headless-registry`、`audit:host-parity`、`audit:colocated-tests`、`typecheck`、受影响的测试（`pnpm test:changed`）、`pnpm sidecar:test`，以及 A4 的双宿主通道。
- 用户可见的变化（B2 的错误提示、B3 的断开行为）各写一条 changeset。

## 7. 约束

- 只提交本阶段的路径，提交时用 `git commit --only` 或显式列出路径（CLAUDE.md 规则 8）。
- 不改 CogniaDB 的 `CURRENT_SCHEMA`。B1 只升级 fusion 自己的数据库。
- 新增的门禁脚本和测试遵守同目录测试规则，门禁脚本的测试用 `node --test`。
- 不做覆盖率统计（CLAUDE.md 规则 3），不跑全量测试套件。

## 8. 不在本阶段

- 持久化队列和限流器原语本身（阶段 1）。
- 实施 2a 或 2b、抽出聊天引擎、客户端完整的意图队列（阶段 2）。
- 新插件契约 ADR 的编写（阶段 0a 结束后、阶段 1 期间），以及插件切换（阶段 2）。
- ADR-0247、ADR-0248、ADR-0249 的实现（分别归入阶段 3、1、2）。
- 审计待核实清单里未被以上工作包覆盖的项，按所属阶段处理，记进台账。
