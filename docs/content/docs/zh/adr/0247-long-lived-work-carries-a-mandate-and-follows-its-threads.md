---
title: "0247 — 长期工作携带授权凭据并跟随它的话题"
description: "在常驻 Host 上由外部发起的工作是一项承诺，而不是一个会话。运行期间它是一个 delegation；一旦留下分支、拉取请求或协调器线程，就提升为 Issue。承诺携带带版本的授权凭据（Mandate）：谁允许的、来自哪条消息、范围是什么、依据哪版策略。每次派生恢复之前都按规则重新评估它。承诺跟随它来自的话题和它创建的话题，所以评审、CI 失败或原 IM 话题里的追问都通过 Issue wakeup 送达，不需要路由器。Worker 把超出范围的请求交还。未被 @ 的群消息只由模型判断并记录\"本会成为工作\"，从不执行。"
---

# ADR 0247 — 长期工作携带授权凭据并跟随它的话题

**状态：** 已接受
**日期：** 2026-11-01
**修订：** 2026-11-01，对抗性审查之后
**相关：** [ADR-0137](./0137-delegation-runtime)（delegation 运行，T0/T1/T2）、[ADR-0132](./0132-issue-tracker)（Issue、Issue 运行与 wakeup）、[ADR-0204](./0204-a-project-coordinator-runs-threads-in-the-background)（协调器线程）、[ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)（常驻 Host）、[ADR-0243](./0243-a-run-acts-for-someone-and-says-who)（代理身份）、[ADR-0244](./0244-a-remote-run-has-stopped-only-when-its-worker-says-so)（停止证明）、[ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request)（外发授权）、[ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched)（能力授予）、[ADR-0131](./0131-cross-shell-inbox-relay)（入站只按规则路由）、[ADR-0194](./0194-a-judgment-is-a-provider-not-a-prompt)（决策执行器）、[ADR-0248](./0248-a-person-is-never-queued-behind-automated-work)、[ADR-0249](./0249-a-background-jobs-completion-reaches-the-agent)。调研：`docs/research/deepseek-superagent-harness-comparison-2026-11-01.md`。

> **经 ADR-0252 采纳（2026-11-05），附修订。** 引擎运行就是 ADR-0252 中由 `launchChildRun` 启动的子运行。§6 的投递使用 ADR-0252 §5 的 steer 入口。在 ADR-0243 的实时权限检查存在之前，§7 报告 `live_authority_unavailable`（影子模式下是一条 would-park 回执），并拒绝把工作区切到 `enforce`。

## 背景

DeepSeek 的 Super-agent 原型（`deepseek-ai/dsh-superagent-prototype`，MIT，首个提交 `6337fc8`）把几件事分开建模：

- **Trigger**：发生了什么；
- **Thread**：它属于哪段讨论；
- **Ticket + Mandate**：Agent 被授权做什么；
- **Assignment**：现在由谁在做；
- **订阅**：后续哪些事件送达这项工作（`Thread.subscriptions`，其中有一个只供上下文的子集）。

调研文档有详细对比。Cognia 已经具备大部分部件，但它们彼此没有连起来。常驻 Host（ADR-0224）要应答团队的 IM 和仓库，缺口在这里最明显：

- **承诺有两个互不相通的载体。**
  - `delegation` 运行（ADR-0137，`lib/execution/delegation.ts`）是异步工作背后的承诺。它是一张卡片，子运行通过 `parentRunId` 挂在它下面，支持 steer、停止、交给人，重试会生成替代运行。它只能由 IM 里的 `/delegate` 手动创建（`lib/connectors/commands/delegate.ts`）。T2 一步 `promoteDelegationToIssue` 只在模块头注释里出现过，并不存在。
  - `Issue`（ADR-0132）是另一个载体。它比运行活得久（`issueRuns`），可以重开；它持有指向其他系统的带索引链接（`externalRefs`、`*externalKeys`）；它跟踪关联拉取请求的状态和 CI（`recordIssuePullRequestState`、`recordIssuePullRequestChecks`）；它拥有 wakeup。
  - 协调器线程（ADR-0204）会产出 worktree、分支和拉取请求，却不属于以上任何一个。
- **Wakeup 已经能把事件路由到工作，但话题够不到它。**
  - Issue wakeup（`lib/issues/wakeups/`）会把输入 steer 进正在运行的 run；run 接不住就暂存；没有 run 就启动一个。它带有循环上限和每小时频率上限。
  - 但它只认 Issue 自己时间线上的事件（`issue:activity`）。
  - 工作所在的 IM 话题里来了新消息，只会送到按 `conversationKey` 绑定的会话（`lib/connectors/session-bindings.ts`）。
  - 拉取请求的评审或 CI 结果只能经 15 分钟一次的 `github-issue-sync` 到达 Issue。`lib/issues/github-event-refresh.ts` 收到 webhook 只会刷新镜像，不做别的。
  - 协调器线程每 60 秒轮询一次自己的拉取请求（`pr-watch.ts`），Agent Team 每 30 秒一次。
- **被唤醒的 Issue 丢了上下文。** 没有活跃 run 时，wakeup 通过 `startIssueRun` 启动新 run，也就开了一个新会话。
- **没有任何地方记录这项工作为什么被允许。**
  - `ActingIdentityV1`（ADR-0243）记录了运行代表谁行事，而 `observeActingAuthority` 按约定只做审计（"callers must never branch on this result"）。
  - 发起请求的消息、授予的范围、当时生效的策略，都没有被记录。
  - 入站路由决策把 `policyRef.version` 硬编码为 `"1"`（`lib/governance/producers/connector.ts`）。
- **Worker 没法说"这不归我"。** 在被跟随的话题里，扩大工作范围的请求会作为普通输入到达，模型要么悄悄照做，要么忽略。
- **未被 @ 的消息不留证据。**
  - 入站准入按决策只走规则：ADR-0131 把"入站消息的 AI 分诊"列为非目标，`dispatch-rules.ts` 写着"no AI triage in v1"。
  - 连接器的 `autonomy: "observe"` 设置只存储消息，不记录判定器会怎么判。
  - 所以要不要放宽准入，正反两方面都没有证据。

本 ADR 没有采纳原型的哪些做法、为什么，列在"后果"里。

## 决策

### 1. 术语

- **承诺（Commitment）**：跨多次运行拥有一项长期工作的记录。提升之前它是一个 `delegation` 运行（T1）；提升之后是一个引用该 delegation 的 `Issue`（T2）。
- **授权凭据（Mandate）**：承诺携带的、带版本的授权依据。
- **被跟随的话题**：承诺从中接收事件的外部讨论，即 IM 话题、拉取请求或 GitHub Issue。跟随分 `owner` 和 `context` 两种。
- **派生启动**：任何不是由人直接发起的启动或恢复，包括 wakeup、事件、无人值守恢复、子运行启动和重试。

### 2. 工作何时成为承诺

适用于常驻 Host 拥有的工作，以及桌面上绑定了 IM 的会话。普通的一问一答仍是 T0。

1. **显式的实施请求自动成为 T1。** 一条已准入的 IM 或 GitHub 消息（被 @ 或私聊）引出的一轮开始修改仓库时，Host 生成一个 delegation，并把正在运行的这一轮收养进去（`acceptDelegation` + `adoptIntoDelegation`）。这是 `/delegate` 手动规则的自动形式。判断依据是这一轮第一次写入某个 git 根目录，这是确定性的，不取决于模型对消息的看法。工作很长但不写代码时，这一轮也可以通过工具（`delegation_accept`）提前收养自己。
2. **工作留下持久的代码产物时成为 T2。**
   - 一个 delegation 的某次运行第一次创建分支或打开拉取请求时，该 delegation 提升为 Issue。
   - 协调器线程（ADR-0204）在启动时就提升，因为它天生就是一个 worktree 加一个分支。
   - 本 ADR 实现 `promoteDelegationToIssue`。它在工作区的默认 Issue 项目里创建 Issue：`origin` 为 delegation 的来源消息，指派人是 Agent，状态 `in_progress`，再建一个 `targetId` 指向该 delegation 运行的 `IssueRun`。
   - 提升时还会复制授权凭据（§4）和跟随关系（§3），并安装系统 wakeup（§5）。
   - 这修订了 ADR-0137 的"T2 tracked"：只回答问题的一轮仍然永远不会被提升。持久的代码产物证明这项工作会比它的运行活得久、并且会被评审，所以提升不再需要等人。
3. **提升后的 delegation 保留它的卡片。** IM 话题保留它的绑定（`executionRunBindings`），Issue 把 delegation 作为自己的运行。对提出请求的人来说，卡片没有任何变化。

### 3. 承诺跟随话题

- **表示方式。** 跟随是一个 `IssueExternalRef`，新增一个不建索引的字段 `follow?: "owner" | "context"`。
  - 现有的 `*externalKeys` 索引通过 `externalKeyOf` 就能回答"谁在跟随话题 X"。
  - 新增的 provider id：`im-thread`（`externalId` 是包含话题段的完整 `conversationKey`）、已有的 `github-pr`，以及 `github-issue`。
  - 提升之前，同样的引用以 `followRefs` 存在 delegation 运行上，提升时迁到 Issue。
  - 同步 provider 会忽略不属于自己的 provider，这一点在字段发布前由测试断言。
  - 因为带索引的键集合不变，所以不需要升级 schema。
- **Host 创建 owner 跟随。** 请求所在的话题，以及工作创建的每个拉取请求或 GitHub Issue（来自任务工作区的拉取请求记录和 `pr-observe` 发现路径），各建一条 owner 跟随。
- **Agent 只能添加 context 跟随。**
  - 添加用工具 `commitment_follow(threadRef)`。context 跟随不授权，不启动运行，也不唤醒已经结束的承诺。
  - Agent 可以移除自己添加的 context 跟随（`commitment_unfollow`，对应 DeepSeek 的 `markUnrelated`）。
  - 它永远不能添加或移除 owner 跟随。
- **人可以升级或移除跟随**，入口在 Issue 详情面板或 delegation 卡片上。

### 4. 授权凭据

```ts
interface CommitmentMandateV1 {
  revision: number // 只在人修改时或创建时递增
  basis:
    | { kind: "message"; conversationKey: string; messageId: string }
    | { kind: "github"; ref: string; deliveryId?: string }
    | { kind: "coordinator"; coordinatorSessionId: string; threadSessionId: string }
    | { kind: "person"; actor: IssueActor }
  requesterRef?: string // ADR-0243 的 requester / 授权主体 id
  scope: {
    workspaceId: string
    roots?: string[] // 工作可写的 git 根目录
    authority: RunAuthorityV1 // 上限；meetRunAuthority 只会收窄
    outboundGrantRefs?: string[] // 工作可使用的 ADR-0239 授予
  }
  brief: string // 用请求者自己的话描述要做什么
  policy: { digest: string; at: number } // 授予时生效的策略
}
```

- **存放位置。** 工作处于 T1 时，凭据存在 delegation 运行上，紧挨 `actingIdentity`。提升后改存 `Issue.mandate`，delegation 保留一个指针。承载这项工作的每个 `ExecutionRun` 都记录 `mandateRef: { commitmentId, revision }`。
- **范围由 Host 强制执行。**
  - 承诺每次运行的能力授予（ADR-0198 `AgentCapabilityGrantV1`）都由 `scope` 推导，resolver 永远不会放宽它。
  - 根目录约束任务工作区，外发授予引用约束 ADR-0239 的方案。
  - `brief` 不被强制执行，它是 §7 判断"是否超出范围"的依据。
- **策略摘要** 是对授予时决定准入和权限的所有因素做的哈希：
  - 该会话的准入策略（`evaluateAdmissionPolicy` 的输入、`ConversationOverrideRow`）；
  - 各类别的外发授权模式；
  - 引用的授予；
  - 代理身份的 `authorityRevision`。

  同一个摘要取代 `lib/governance/producers/connector.ts` 里硬编码的 `policyRef.version: "1"`，这样路由回执写的就是实际生效的规则。

### 5. 话题事件成为 Issue 活动

- **新增的 `IssueEventKind`：**
  - `thread_message`：被跟随 IM 话题里的消息；
  - `pr_review`：评审或评审评论；
  - `pr_comment`：被跟随拉取请求或 Issue 上的对话评论。

  `pr_state_changed` 和 `pr_checks_changed` 保留。每条记录都带跟随模式、行为者和一个确定性的 `sourceEventId`。
- **IM：每条消息只有一个执行者。**
  - 连接器总线对消息去重（总线第 1 步 `ensureConnectorInboundJob`）并准入之后，查找以 **owner** 身份跟随 `im-thread:<conversationKey>` 的承诺。
  - **有这样的承诺**：总线把消息交给该承诺投递，自己不再排入 route-handler 轮次，也不再直接 live-steer。
  - **承诺投递**（§6）是执行这条消息的唯一路径：steer 承诺的活跃 run、续接上次的会话，或者启动一个 run。人发的消息仍然即时送达，因为投递会把它 live-steer 进去（§6.2）。
  - **话题没有被任何承诺跟随**：沿用今天的会话路径，不做改动。
  - **回执**：每次移交都在追加时间线条目的同一个事务里，写入一份以 `(commitmentId, sourceEventId)` 为键的持久化接收回执。崩溃后重放时，发现回执已存在就什么也不做。正是这份回执保证不会有两个消费者对同一条消息动手。
- **GitHub。**
  - 来自集成的事件（`lib/integrations/events.ts`；App webhook 见 `github-webhook.ts`，个人令牌 webhook 见 `github-repo-webhook.ts`）只要涉及被跟随的 `github-pr` 或 `github-issue`，就立即追加为活动。
  - 拉取请求的状态和检查结果直接从载荷调用 `recordIssuePullRequestState` / `recordIssuePullRequestChecks` 写入。它们只写引用的 `meta`，从不碰镜像水位线。
  - `github-event-refresh.ts` 原本就会安排的镜像刷新照旧安排。
  - 重复事件按集成事件的 `[accountId+deliveryId]` 和 `sourceEventId` 合并。
- **轮询降为对账兜底。** 15 分钟同步、`ProjectPrWatch` 和 `PrFeedbackController` 继续运行，但只按同一个 `sourceEventId` 补上 webhook 漏掉的事件。
- **系统 wakeup 规则。** 提升时安装一条系统 wakeup 规则：匹配来自 owner 跟随的 `thread_message | pr_review | pr_comment | pr_state_changed | pr_checks_changed`，并用 `actorKinds` 排除 Agent 自己。系统规则本来就不受链路访问上限约束，每小时频率上限照常生效。
- **context 跟随的事件** 只追加到时间线，并且只作为上下文送进正在运行的 run，从不触发 wakeup。
- **提升之前**，delegation 只跟随它的来源话题：此时它还没有拉取请求，否则早就提升了。总线以同样的方式把该话题的消息交给 delegation：delegation 的投递负责 steer 或续接它的会话，并使用同一种回执。Issue 活动时间线和系统 wakeup 从提升时才开始。

### 6. 送达与续接

wakeup 执行器现有的三种送达方式不变，只有三处改动：

1. **合并。** 同一承诺的 owner 事件，在一个短窗口内（默认 30 秒，可按工作区设置）到达的，合并成一份 brief（对串联输入调用 `buildWakeupBrief`）。连续五条评审评论只唤醒一轮。
2. **事件在轮次边界加入，人的消息即时送达。** 活跃 run 按 steer 队列规则接收事件 brief（评审、CI、评论），ADR-0249 送达 job 完成结果用的也是这条规则：run 还在流式输出时先排队，这一轮结束后再取出。人在 owner 跟随话题里发的消息，以及任何停止请求，都直接 live-steer，从不合并。这样，总线改为把人的消息交给承诺之后，人原先从绑定会话得到的即时性不会丢失。
3. **续接而不是重开。** 没有活跃 run 时，`startIssueRun` 会拿到 `continueSessionId`，也就是最近一次运行最新的会话（`issueRunSessionIds`）。前提是这个会话仍存在、未归档、且所在运行时支持恢复。只有不满足时，才用 Issue 摘要开一个新会话。

### 7. 恢复时重新评估授权凭据

每次派生启动（§1）之前，Host 都确定性地重新评估三件事：

- **请求者是否仍有权限，并做实时检查。** 不能只比较版本号：
  - `checkActingAuthority` 只检查身份是否存在、`authorityRevision` 有没有递增（`packages/plugin-contract/src/types/execution/acting-identity.ts:132-139`），而凭据或绑定被撤销时 revision 不一定变化。
  - 实时权限解析器要读取：当前凭据的授权代际；对绑定个人的运行，还要读取当前的绑定和同意版本。这正是 ADR-0243 §2 对每次调用已经提出的实时检查要求（"快照本身从不授予权限"）。
  - revision 比较保留，作为一项独立的快照检查；
- 来源话题的准入规则是否仍接纳该请求者；
- 范围是否仍在当前上限之内：工作区、根目录、当前策略的 RunAuthority 上限，以及引用的授予。

评估结果：

- **通过**：运行继续，并在运行上记录当前策略摘要。凭据版本不变，因为只有人能改它。
- **不通过**：承诺暂停。delegation 发起一个中断，Issue 暂存它的 wakeup 输入（ADR-0132 已经保证这些输入永不丢弃）。一张卡片发给请求者，有协调器时发给协调器，说明哪一项已经不成立。
- **人停止过的承诺**（运行被取消、Issue 被移到 `canceled`）永不被事件恢复。输入会被暂存并展示出来。
- **人撤销时**（撤销凭据、移除跟随、收回请求者的授予）：活跃 run 经 ADR-0244 的停止路径停下。拿到停止证明之前，承诺不显示为已停止。

**本节的验收用例**包括：
- revision 未变但凭据已撤销；
- revision 未变但绑定已收回；
- 人已停止承诺之后又有事件到达。

**上线方式是先 shadow，再 enforce**，和 ADR-0239、ADR-0243 同一模式。

- 设置项 `agentPermissions.mandateEnforcement: "shadow" | "enforce"`，默认 `shadow`。
- shadow 下，检查不通过只写一条 `mandate.would_park` 回执，运行照常继续，shadow 报告列出这些回执。
- 等报告证明这项检查只拦了该拦的，再按工作区逐个开启 enforce。
- enforce 下，`unattended-resume` 和 `child-launch` 两处的 `observeActingAuthority` 改为调用方据此分支的检查。
- shadow 状态在设置项的类型上写明，在设置界面里标注，并由测试固定。

### 8. 交还（handback）

绑定到承诺的运行可以调用 `commitment_handback({ sourceEventId, reason })`，用于它判断超出凭据 `brief` 或 `scope` 的输入。

1. **时间线。** 该事件在时间线上被标记为 `handed_back`，这个事件 id 永远不会再送进本承诺的运行。这就是 DeepSeek 的 `handedBackHere` 防护，按 `(承诺, sourceEventId)` 去重。
2. **交给谁。**
   - 承诺属于某个项目协调器时，交还作为同伴报告发给协调器（ADR-0204 §5），由协调器决定。
   - 否则在来源话题里给写这条消息的人发一张卡片，三个选项：
     - **新建 Issue**：走现有的 IM 提议路径（`lib/issues/im/propose.ts`，origin 为那条消息）；
     - **扩大范围**：生成一个新的凭据版本，只有对该承诺有权限的人能批准；
     - **忽略**。
3. **交还不是拒绝。** 运行继续做范围内的事。

### 9. 未被 @ 的群消息：只观察

- **默认关闭。** 会话覆盖项 `workObservation: "off" | "observe"`，默认 `off`。
- **确定性预过滤。** 开启 `observe` 后，准入没有路由到任何一轮的消息先过一道确定性预过滤：
  - 发送者是群成员，不是机器人或 Agent 自己；
  - 消息不是引用或转发的内容；
  - 消息不在已被 owner 跟随的话题里。
- **判定。** 通过的消息交给 `runDecision`（ADR-0194，先过 PII 闸门）。准入提示词要求三点同时成立：讨论针对本工作区，有参与者明确希望做某项具体修改，方向已经确定。引用或转发的指令永远不算数。
- **记录。** 判定结果写入新表 `workObservations`：本会接 / 本会忽略、理由、本会提出的范围、提示词版本、模型。这需要升级 Dexie 版本、加入 `CORE_TABLE_NAMES`，并运行 `pnpm db:governance:write`。
- **observe 从不做的事。** 不回复，不建 Issue，不提议，不运行。
- **人工复核。** 设置页按会话列出观察记录，由人逐条标注判定对或错。
- **超出 observe 需要一份新 ADR。** 新 ADR 必须证明三点：该会话至少 50 条已标注判定，"本会接"的精确率至少 90%，没有任何一条"本会接"落在引用或转发内容上。在那之前，ADR-0131 的非目标继续有效。本节只是收集证据，不做路由。

## 实现位置

| 关注点 | 位置 |
| --- | --- |
| 提升、自动收养 | `lib/execution/delegation.ts`（`promoteDelegationToIssue`）、`lib/issues/run/`（以 delegation 为依托的 `IssueRun`）、任务工作区的分支/PR 钩子、`lib/project-coordinator/thread-session.ts` |
| 跟随 | `packages/plugin-contract/src/types/issues/index.ts`（`IssueExternalRef.follow`、provider）、`ExecutionRun.followRefs`、`lib/db/issues.ts`、Issue 详情面板、delegation 卡片 |
| 授权凭据 | `packages/plugin-contract/src/types/execution/`（`CommitmentMandateV1`、`mandateRef`）、`lib/execution/acting-authority.ts`、`lib/governance/producers/connector.ts`（策略摘要） |
| 话题事件 | `lib/connectors/bus.ts`（第 1 步与准入之后）、`lib/integrations/events.ts`、`lib/issues/github-event-refresh.ts`、`lib/issues/wakeups/`（事件类型、系统规则、合并、续接） |
| 交还 | sidecar 工具 + `lib/issues/im/propose.ts`、协调器同伴报告 |
| 观察 | 会话覆盖项、`lib/decisions/run-decision.ts`、`workObservations`（Dexie）、设置页 |

每个新模块都带同目录测试（规则 3），每条新字符串都接入 i18n（规则 4）。无头一致性方面，brain 已经启动了 Issue 跟踪器（`lib/headless/runtimes/issue-tracker.ts`），每个阶段都要在 Host 和桌面上分别验证。

## 上线顺序

1. 授权凭据类型、策略摘要、`mandateRef`、shadow 检查与报告。
2. 跟随关系、IM 与 GitHub 话题事件、系统 wakeup、合并。
3. 自动 T1 收养与 T2 提升（分支/PR、协调器线程）。
4. 唤醒时续接会话。
5. 交还。
6. 观察日志与复核页面。
7. 按工作区开启 enforce，以 shadow 证据为前提。

每个阶段都在 `docs/evidence/` 下记录证据台账。

## 后果

- 一个承诺现在能收到评审、CI 失败和原 IM 话题里的追问，并在保有上下文的会话里继续。延迟不再由轮询决定，而由 webhook 送达决定。
- 外部发起的工作总能回答"谁允许的、来自哪条消息、在什么范围内、依据哪套规则"。enforce 下，答案过时会阻止派生恢复，而不只是被记录下来。
- Host 上 Agent 打开的每个拉取请求都会在 Issue 看板上多出一行。这是修订 ADR-0137 所接受的代价。普通回答和不涉及代码的 delegation 仍然不占用 Issue 编号。

**没有从原型采纳的部分：**

- 对每条入站消息做分诊的 LLM 路由器。ADR-0131 继续有效，§9 只收集证据。
- 独立的 Ticket 实体。那会成为 delegation、Issue、Agent 任务、目标、计划、团队运行之外的第七种类似任务的记录。
- 原型的 Effects/Outbox 引擎。Cognia 受治理的外发队列已经拒绝盲目重发（`delivery_unknown`），聊天受理和通知已经把状态与副作用放在同一事务里提交。
- 只靠提示词的合并规则。ADR-0239 在出口处强制执行。
- 允许后续消息越过一条已失败三次的消息的那种排序。
- 对运行中的工作只做通知的策略变更。§7 改为暂停。

## 待定问题

- **跨运行时的会话续接** 取决于各运行时的恢复能力。§6 的规则会回退到新会话；哪些运行时满足条件，在第 4 阶段测量。
- **合并窗口默认 30 秒** 只是起始值，第 2 阶段在真实仓库上测量评审的突发情况。
