# DeepSeek Super-agent Harness 与 Cognia 对比：可借鉴的设计与不采纳的部分

> 研究日期：2026-11-01<br>
> 外部基线：`deepseek-ai/dsh-superagent-prototype` 首个提交 [`6337fc8`](https://github.com/deepseek-ai/dsh-superagent-prototype/commit/6337fc823ce20251c8de8085948165c81aaa701e)（MIT，216 个文件，`src/` 共 111 个文件约 1.56 万行），以及 DeepSeek 署名、经 [ChainCatcher 转载](https://www.chaincatcher.com/article/2300676) 的《Super-agent 设计探索》全文<br>
> 证据原则：
>
> - DeepSeek 的判断只引用其仓库源码与文档，以及文章原文；
> - Cognia 的判断以当前仓库代码和 ADR 为准；
> - 外部核验由 Codex（gpt-6.1-sol，联网、只读）完成，Cognia 侧由代码检索加人工抽查完成。
>
> 产出的决策：[ADR-0247](../content/docs/zh/adr/0247-long-lived-work-carries-a-mandate-and-follows-its-threads.md)、[ADR-0248](../content/docs/zh/adr/0248-a-person-is-never-queued-behind-automated-work.md)、[ADR-0249](../content/docs/zh/adr/0249-a-background-jobs-completion-reaches-the-agent.md)

## 0. 结论先行

这套设计值得借鉴的，不是"多 Agent 并行"，而是把 Agent 的运行单位从会话换成"承诺 + 授权 + 事件归属"。

Cognia 不需要另起一个 Super-agent 层，因为部件大多已经存在：

- **承诺**：delegation（ADR-0137）和 Issue（ADR-0132）；
- **事件进入工作的路径**：Issue wakeup，已经有 steer、暂存和新开运行三种送达方式，以及循环和频率上限；
- **代理身份**：ADR-0243；
- **外发授权**：ADR-0239，带 shadow 模式和回执；
- **受治理的外发队列**：带 `delivery_unknown`，不盲目重发。

真正的缺口是把这些部件连起来，并补上四处空白：

1. 记录"这项工作为什么被允许"的 Mandate，并在恢复时用它校验；
2. 话题与承诺之间多对多的跟随关系，加上 webhook 直通；
3. 不会被自动化工作挤占的人类优先槽；
4. 后台 job 完成后回到 Agent 循环。

## 1. 文章勘误（对照源码）

| 文章说法                                        | 实际情况                                                                                                                     | 依据                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Worker 有 `handback`、`markUnrelated`、`attach` | `attach` 属于 Router 的 `orchestrator_route`；Worker 只有 `orchestrator_trigger_handback` 和 `orchestrator_thread_unrelated` | `src/app/tools/executor.ts`、`src/app/tools/main.ts` |
| 每个 Ticket 一个 git worktree                   | worktree 只是可选 prepare 命令的典型用法。没有配置 prepare 命令时，Worker 从空目录开始                                       | `docs/003-execution.md`、`src/executor/dsh.ts`       |
| Subscription 是独立领域对象                     | 没有同名类型。关系存在 `Thread.subscriptions: string[]`，只供上下文的子集存在 `Thread.context`                               | `src/core/model.ts`                                  |
| Outbox 按 Ticket + 会话保序                     | 基本属实，但前序消息连续失败三次后，就不再挡住后续消息                                                                       | `src/app/outbox.ts`                                  |
| 后台 shell 最多等 30 分钟                       | 30 分钟从这一轮结束时开始算；交给人验收而保留的 shell job 不受此限；超时也不会杀掉子 Agent                                   | `docs/003-execution.md`                              |
| 外部 Watchdog                                   | 文章描述的是内部实践，公开原型的源码里找不到                                                                                 | 源码树                                               |
| 实验证明了多任务优势                            | 只证明了调度行为。编码被替换成"耗时工具"，时间按 1/4 压缩。单会话在中性提示词下 0/5 次委派                                   | 文章 §7.1                                            |

文章没有提到、但值得注意的几点：

- **Router 批处理。** Router 一次决定 1–20 个 Trigger，单项被拒不影响整批；每个 Thread 同一时间最多一个 Eval。
- **没有单独的"需要人决策"报告类型。** 需要人决策时，用结构化的 `human_action` 转成 Ticket 的 `Attention`。
- **GitHub 去重分两层。** 先在同一轮通知里按编号合并，再按确定性 Trigger id 去重。正文编辑不会作为新请求重新进入。
- **自动合并只靠提示词约束。** 条件是改动少于 200 行，文档自己也承认宿主没有合并相关的判断逻辑。

## 2. 概念映射

| DeepSeek             | Cognia 现状                                                                                                                                                                         | 缺口                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Ticket               | delegation 运行（T1，`lib/execution/delegation.ts`）和 Issue（T2，`issueRuns` → `AgentTaskAttempt.sessionId`）                                                                      | 两者不相通；`promoteDelegationToIssue` 只有名字没有实现；T1 只能用 `/delegate` 手动创建；协调器线程两者都不属于            |
| Mandate              | `ActingIdentityV1`（ADR-0243，存在 `ExecutionRun` 上）                                                                                                                              | 没有来源消息、范围、策略版本；`observeActingAuthority` 只做审计；路由决策的 `policyRef.version` 硬编码为 `"1"`             |
| Thread↔Ticket 订阅   | IM：`conversationKey` → 会话（`session-bindings.ts`），一个会话只对应一个会话来源；GitHub：`integrationBinding` → 会话；Issue `externalRefs`（`*externalKeys` 索引）带 PR 状态和 CI | 没有跨渠道归属：Lark 话题和它产出的 PR 指不到同一个承诺                                                                    |
| 事件直通             | Issue wakeup（`lib/issues/wakeups/`）：活跃 run 就 steer，接不住就暂存，没有 run 就新开                                                                                             | 话题事件进不了 wakeup；PR 事件靠轮询（Agent Team 30 秒、协调器线程 60 秒、Issue 同步 15 分钟）；唤醒后开新会话，丢失上下文 |
| Gate + LLM 评估      | 只有规则准入（`conversation-admission.ts`），ADR-0131 明确不做 AI 分诊                                                                                                              | 未被 @ 的消息不留"本会接"的证据                                                                                            |
| off / observe / auto | ADR-0239 外发授权有 shadow/enforce；连接器的 `autonomy: "observe"` 只存储消息                                                                                                       | 入站侧没有反事实记录                                                                                                       |
| handback             | 无                                                                                                                                                                                  | 模型可能悄悄扩大自己的范围                                                                                                 |
| 人类优先槽           | 执行代理 16（续接豁免）、调度器 5、团队 8，都不区分来源；只有协调器对用户发起的线程放行                                                                                             | 在 Host 上，自动化工作可以占满全部许可                                                                                     |
| 异步 ReAct           | 子 Agent 结果会回流到父会话（`background-result-runtime.ts`）                                                                                                                       | shell job 和 monitor 结束只通知调度器；Monitor 承诺的"触发时送达"没人执行                                                  |
| Effects + Outbox     | 受治理外发队列（`outbound-jobs.ts`、`outbound-runner.ts`），带 `delivery_unknown`；聊天受理（ADR-0125）和通知（ADR-0190）把状态与副作用放在同一事务；router-fusion outbox           | IM 回复的状态变更与入队不在同一事务；`outboundQueue.idempotencyKey` 不唯一。收益递减，本轮不处理                           |
| Chain of Recall      | `project_history_search`（按消息 id 展开）                                                                                                                                          | 没有跨任务、PR、话题统一的 ID 读取；`artifact_read` 在 8000 字符处截断且不能分页。本轮不处理                               |

## 3. Cognia 设计上更强、但部分尚未生效的地方

> 修订（第二轮审查）：第一版把下面几条写成了"已经在生效的保证"，这是错误的。这里把"已经存在的机制""按类别可开启的强制""实际已强制的路径""尚待实现的 ADR 保证"分开写。

- **外发授权：机制已在，默认没有强制。** ADR-0239 在出口处做规划，比 DeepSeek 只写在提示词里的合并条件更好；但 `lib/policy/action-review/policy.ts:79-94` 对所有没有显式设为 enforce 的类别都返回 shadow，而 shadow 不改变行为。所以今天它是**观察**，不是**拦截**，覆盖率也没有门禁（见架构审计 §5.2）。
- **外发不确定时不盲目重发**（`delivery_unknown`）：这一条已经生效。DeepSeek 允许消息在前序失败三次后越过它。
- **授权收窄与停止证明：设计上更保守，部分仍只做审计。** ADR-0243 规定权限只会收窄，ADR-0244 规定只有 Worker 确认才算停止；但 `observeActingAuthority` 仍是 observe-only，恢复执行时不会拦截（`lib/execution/acting-authority.ts:347-373`），ADR-0244 状态是 Proposed。DeepSeek 在策略变更时只通知运行中的 Ticket。
- **执行隔离。** Cognia 有沙箱池和工作区边界（ADR-0182/0183、ADR-0227）。DeepSeek 原型的 Router 和 Worker 都是 `danger-full-access`，并能访问运行用户的主目录。

## 4. 决策与不采纳

经与用户逐项确认（2026-11-01）：

- **产出形式。** 写 ADR，按缺口加固现有子系统，不新建协调层。
- **部署形态。** 先做常驻 Host，桌面一起受益。
- **承诺的载体。** T1 delegation 承载进行中的工作；产出分支/PR 或协调器线程时，自动提升为 T2 Issue（修订 ADR-0137 的"T2 只能显式创建"）。
- **Mandate。**
  - 存放：T1 阶段在 delegation 上，提升后在 Issue 上，带版本；每次运行记录引用。
  - 范围：结构化范围由宿主强制执行，文字 brief 供 handback 判断。
  - 恢复：先按规则重新评估；不通过就暂停，等人处理。
  - 上线：先 shadow，再 enforce。
- **跟随。** Host 自动建 owner 跟随；Agent 只能通过工具加 context 跟随。webhook 为主，轮询降为对账兜底。
- **送达。** 事件合并后在轮次边界注入；没有活跃 run 时续接上次会话。
- **handback。** 项目内的承诺先交给协调器，否则发卡片给人。
- **群聊主动发现。** 只开 observe，配合人工标注。升级门槛（至少 50 条标注、精确率至少 90%）写进 ADR，升级需要新 ADR。
- **人类优先槽。** 停止永不排队；每个限流器预留 1 个许可给人；人在每个队列里优先。
- **job 回流。** 复用子 Agent 结果的回流路径；Host 和保持中的会话空闲时直接唤醒；唤醒有上限并计入预算。

不采纳的部分及理由：

| 不采纳                         | 理由                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| 对所有入站消息做 LLM 路由      | ADR-0131 仍然有效。Cognia 的用户群包括单人桌面，多人组织模式还在建设中，先收集证据           |
| 新建独立的 Ticket 实体         | 已有 delegation、Issue、Agent 任务、目标、计划、团队运行，新实体会成为第七种，进一步分散归属 |
| 原型的 Effects/Outbox 引擎     | 现有外发队列和事务化受理已经覆盖关键路径，剩余的原子性缺口收益递减                           |
| 只靠提示词的合并规则           | 与 ADR-0239 的出口规划原则相悖（注意：Cognia 的出口强制目前默认仍是 shadow）                 |
| "失败三次后放行后续消息"的排序 | 会让读者看到乱序的结论                                                                       |
| 策略变更只通知                 | 与 ADR-0243"权限只会收窄"的原则相悖（该原则在恢复路径上尚未强制，见 ADR-0247 §7）            |
| 统一的 Chain of Recall         | 本轮痛点没有选它，留作后续单独评估                                                           |

## 5. 验收场景（来自原文，按 Cognia 的决策改写）

| 场景                               | 期望                                    | 对应                                          |
| ---------------------------------- | --------------------------------------- | --------------------------------------------- |
| 同一 GitHub 事件重复投递           | 不重复唤醒                              | ADR-0247 §5（`deliveryId` + `sourceEventId`） |
| PR review 到来                     | 在原会话里继续                          | ADR-0247 §5–6                                 |
| 连续 5 条评审评论                  | 只唤醒一轮                              | ADR-0247 §6                                   |
| 有人在跟随的话题里要求扩大范围     | handback，不悄悄扩大                    | ADR-0247 §8                                   |
| 请求者的权限被收回后，事件试图唤醒 | 暂停等人；人停止过的承诺永不自动恢复    | ADR-0247 §7                                   |
| Host 满载时，人发出停止或新请求    | 停止立即送达，新请求最多等一个许可      | ADR-0248                                      |
| 后台构建结束                       | 空闲会话被唤醒并收到结果                | ADR-0249                                      |
| 群里出现模糊的设计讨论             | 只记录"本会忽略/本会接"，不回复、不执行 | ADR-0247 §9                                   |
