---
title: "0243 — 一次运行代表某个人执行，并写明是谁"
description: "每次 agent 运行写明其数据访问使用谁的权限：发起人本人的授权（代表使用者）、服务身份，或绑定到 Bot、并按本人声明收窄的某个人的凭据。通过某人授权读到的数据仍归此人：它被打上标记，标记随子运行、工具结果和历史传递，只能交给此人，或在此人亲自授予披露后离开。子 agent 继承一个只会收紧的权限，预算是整棵运行树共用的一个池。"
---

# ADR 0243 — 一次运行代表某个人执行，并写明是谁

**状态：** 提议中
**日期：** 2026-10-30
**相关：** [ADR-0009](./0009-platform-connectors)（连接器）、[ADR-0026](./0026-builtin-skills-and-lark-cli-bridge)（内置技能；其 2026-10-30 修订是本 ADR 的第一步）、[ADR-0149](./0149-a-person-is-not-a-device)（人、用户、成员关系）、[ADR-0174](./0174-the-bot-control-plane)（Bot 安装及其策略合并）、[ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched)（能力授予）、[ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)（常驻 Host）、[ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request)（外发授权）

## 背景

三个问题在不同地方、依据不同来源回答，彼此之间没有联系：

1. **谁可以使用。** 飞书发送者要通过主体登记表准入（`lib/connectors/principal/resolve.ts`）。其他平台，以及关闭登记表开关的飞书，解析结果都是 `legacy`。
2. **用谁的凭据。** 连接器每个适配器只保存一个用户 token。d74e413ff1 增加了一道检查（`lib/skills/built-in/lark/acting-identity.ts`）：Lark 技能读取本回合的实时发送者，拒绝连接者以外的所有人，所以其他人都用不了个人功能。Bot 安装把凭据槽绑定到集成账号（`credentialBindings`）。它没有记录任何人的字段，它的 `owner` 是运行它的机器（`lib/placement/ownership.ts`）。
3. **能做到什么程度。** Bot 策略合并（`lib/bot/policy/ceilings.ts`）限制权限级别、自动化程度、写操作审批、预算和无人值守配置。能力授予（ADR-0198）限制工具、技能、MCP 服务器和模式。

发起人只进入了部分决策，且来自三个不同的来源：
- **实时入站任务。** Lark 检查从中读取本回合的发送者。外发规划（`lib/policy/action-review/resolve-request-origin.ts`）通过 `lib/workflow/runtime/trigger-origin.ts`，从最新的运行中入站任务重建发起人。
- **持久化的 `run.initiator`。** 它为运行控制（批准、拒绝、停止）授权，见 `lib/execution/run-control.ts`，Bot 运行也包括在内。定时触发的 Bot 运行没有 initiator（`lib/scheduler/executors/bot-executor.ts`）。
- **共享运行协调器，** 用于协作会话中的成员。

webhook 的事件触发者没有主体（`lib/bot/sources/integration-event.ts`）。

缺少的是：

- **保密。** 群聊回复只按 chat id 授权（`lib/policy/action-review/plan-delivery.ts` 的 `sameChat`）。写共享文档根本不属于外发工具（`lib/policy/risk/outbound-tools.ts`）。没有任何机制追踪通过某人授权读到的数据，看它是否进入后续回复、子 agent 结果或会话历史；而连接器是按会话复用 session 的。
- **跨子 agent 的统一权限。** 为嵌套 agent 记录的上限只保留模式和工具列表，而且放在内存里（`dispatch-context-registry.ts`）。嵌套派发已经共享子树 token 预算和截止时间（`lib/claude/agents/dispatch-budget.ts`），但它没有和 MCP 限制、子 agent 列表、无人值守配置、Bot 费用上限及持久化统一起来：
  - 外部子 agent 会丢掉父级禁用列表（`lib/plugin/agent-sdk/dispatch.ts`）；
  - 插件传入的 `permissionMode` 在上限计算之后覆盖解析结果（`lib/plugin/api/agent-turn.ts`）；
  - Bot 的 squad 和工作流只拿到模式；
  - `maxRunCostUsd` 只在外部 agent API 中强制执行。
- **谁能批准。** `initiator` 操作人范围也接受已配置的运营者（`lib/connectors/callback-authorization.ts`）。

多租户 Host 上的组织成员已经在个人分区中运行，使用组织持有的密钥和沙箱化工具，拿不到连接器 token（ADR-0149 与多用户组织方案）。本 ADR 不改动这条路径；配对 Host 会像其他大脑数据一样携带本 ADR 引入的记录。

## 决策

### 1. 用词

- **发起人（Requester）**：其消息或操作启动了本次运行，或被并入本次运行（插入的消息）的人。
- **事件触发者（Event actor）**：触发运行的 Cognia 之外的人，例如 GitHub 评论者或 webhook 发送方。事件触发者从来不是主体。
- **授权主体（Authorizing principal）**：为没有发起人的运行授权的人：创建或启用定时任务的人，或确认绑定的人。
- **执行主体（Acting principal）**：本次运行的数据访问所使用权限的那一方。
- **凭据通道（Credential lane）**：选择执行主体的方式，共三种，见下文。
- **传输身份（Transport identity）**：连接器用来承载消息的身份（例如 Lark 的 bot token）。它从不用于读写数据。
- **受众（Audience）**：一次投递或写入会到达的人。
- **个人标记（Personal mark）**：表示“这些内容来自 <某人> 自己的授权”的标签。

### 2. 运行只写明一次身份；权限只会收紧

运行携带一个 `ActingIdentityV1`，持久化在 `ExecutionRun` 上，分两部分：

- **启动时固定：** 通道、执行主体、没有发起人时的授权主体，以及绑定个人通道的绑定 id。这些永不改变。
- **单调变化：** 发起人集合和权限修订号。并入另一个人插入的消息时，运行先收紧权限（出现第二个发起人就取消个人访问），再接受这条消息。每一次带凭据的调用、每一次恢复、每一次启动子 agent，都检查最新的修订号。

快照本身从不授予权限。每次调用还会实时检查：
- 当前凭据的授权 epoch，与 d74e413ff1 的检查相同；
- 对绑定个人通道，当前的绑定与确认修订号。

撤销或收窄的绑定在下一次调用时即生效，包括已暂停和已恢复的运行。

数据访问且只读取执行身份来选择凭据：
- 工具从不只凭适配器 id 选凭据；
- 凭据通道不会落到另一个通道；
- 凭据缺失就拒绝。

承载消息是另一回事。传输身份只能把规划器（§5）已经决定的内容，送到它已经决定的受众，不能扩大受众，自身也不带任何数据访问权。正因如此，代表使用者的运行仍能通过 bot 发送 Lark 临时卡片。

### 3. 三种通道

**代表使用者（Delegated）。** 运行使用发起人本人的授权。凭据按连接和主体保存。

尚未授权的发起人会通过会话能支持的最私密方式收到授权链接：
1. 在已确认的普通群中用 Lark 临时卡片；
2. 否则，如果会话本身就是与此人的私聊，直接在会话中发送；
3. 否则发私信；
4. 否则在聊天中发出通知，说明去哪里授权。

回调只在登录的身份正是链接所发给的发起人时才接受 token。

有多个发起人的回合没有唯一主体，个人调用会被拒绝。本机桌面用户是自己会话的代表主体。

没有发起人的运行，只能代表它的授权主体执行。这涵盖了由本人设置的“每天早上把我的日程汇总发到我的私聊”。

**服务身份（Service）。** 运行使用服务身份：应用的租户 token、GitHub App 或服务账号，从不使用个人 token。它能触及的范围是以下两者的交集：
- 平台授予该身份的权限；
- 安装声明的资源、动作和接收方。

租户 token 只能通过这个通道访问数据。

**绑定个人（Bound person）。** Bot 安装可以绑定某一个人自己的凭据，例如 GitHub token，条件有三：
- 由本人确认绑定；
- 控制台把该安装标为“以 <某人> 的身份运行”；
- 绑定带有声明范围：运行不是由本人启动时，本人允许的动作、资源选择器和接收方。

本人发起的运行，以及本人授权的定时任务，都等同于代表使用者。其他人启动的运行，包括事件触发者，只能使用声明范围。不存在没有范围的绑定。

声明范围同时也是本人的常设披露。在范围内读取的内容可以发给声明的接收方，正是这一点让 Bot 能回复 issue 评论者。范围外的内容根本无法读取。

**哪种触发可以使用哪个通道。** 这在准入运行时检查，不交给安装自行决定：

| 触发方式 | 代表使用者 | 服务身份 | 绑定个人 |
| --- | --- | --- | --- |
| 发起人自己的消息或操作 | 代表该发起人 | 可以 | 发起人就是被绑定的人时等同于代表使用者，否则只用声明范围 |
| 某人设置的定时或固定任务 | 代表该授权主体 | 可以 | 授权主体就是被绑定的人时等同于代表使用者，否则只用声明范围 |
| 外部事件（webhook、集成事件） | **绝不** | 可以 | 只用声明范围 |

`run.initiator` 上现有的运行控制检查保持不变。它回答的是谁可以操控运行，而不是运行使用谁的权限。

### 4. 通道是由人切换的设置

通道按 IM 适配器和 Bot 安装分别设置，由运营者选择。修改通道是人写入的设置：它会推进 `humanRevision`，agent 无权写入。

- **IM 助手**默认使用代表使用者。
- **Bot 定义**为每个凭据槽声明可接受的通道。任何情况下都不会默认使用安装者自己的凭据。

### 5. 个人数据只属于本人

**标记。** 通过个人通道读取返回的内容带有个人标记，标明属于谁。标记会传递到：
- 运行本身；
- 基于带标记内容生成的工具结果；
- 子 agent 返回给父级的结果；
- 持久化到会话历史中的消息。

**谁读取历史。** 每个回合有一个有效读者：
- 有发起人时，是全部发起人；
- 没有发起人时，是触发方式表格允许的、经过验证的授权主体；
- 服务身份和外部事件运行没有个人读者。

只有当每个有效读者都是被标记的那个人，或已有披露覆盖他们时，带标记的内容才可见。否则上下文构建器会把它替换为写明归属的占位符。这样第二个人无法让助手复述别人的私密回答，父级也无法通过子 agent 洗掉个人读取。

**引擎也要遗忘。** 引擎各自保留记忆：SDK 的恢复会话、AI SDK 运行器的历史、外部 agent 的原生会话（`lib/chat/turn-route/history.ts`）。只过滤存储的会话记录并不够。可见性修订号是运行时会话身份的一部分。可见性收紧时，本回合不恢复旧的引擎会话，而是通过现有的会话记录失效机制（`hooks/chat/claude-chat-send-options.ts`），从过滤后的权威历史重建。这适用于原生、AI SDK、外部和 CLI 通路，也适用于配对 Host。

**所有出口，而不只是投递。** 携带某人标记的运行，只能把内容发送或写入：
- 写入时能证明实际受众仅为此人的目标：与此人的私聊、发给此人的临时卡片、权限列表只有此人的文档；
- 在此人授予披露之后的任意目标。

拥有资源并不够：此人拥有但共享给团队的文档，受众是整个团队。

这覆盖回复、文档和表格写入、集成动作、webhook 与 HTTP 调用、上传。受众无法确定的出口一律暂扣，直到授予披露。

不透明的出口另当别论。shell、脚本和任意 fetch 可能发送与批准内容不同的东西，所以披露无法为它们放行。带标记的运行，其 shell 和沙箱工具没有网络出口。内容只能通过发送固定内容的出口离开，并在实际发送的那一刻核对披露的内容哈希。

**投递。** 私密结果交给被标记的那个人，而不是自动交给发起人。只有在以下情况下才直接交给发起人：
- 发起人就是被标记的那个人；或
- 已有确切的披露，或绑定个人的声明范围覆盖了发起人。

否则，结果和披露请求都交给被标记的那个人：有临时卡片就用临时卡片，否则发私信，否则暂扣并通知。

**披露。** 收窄后的卡片提供**分享到群**。披露严格只校验被标记的那个人，没有运营者例外。这是一个新的操作人范围，不复用现有的 `initiator` 范围，因为后者也接受运营者。披露绑定到确切内容（按哈希）和确切目标，记录在 action-review 回执上。对绑定个人通道，目标还必须在声明的接收方之内。

服务身份通道的输出照旧遵循 ADR-0239 的接收方授权。这项保护不受 ADR-0239 shadow 模式约束，因为保密检查若只记录不拦截，它的失败方式就是泄露本身。

### 6. 整棵运行树共用一个权限

一次运行的权限是一个 `RunAuthorityV1`：执行身份，加上每一个受限字段：
- 模式；
- 工具允许和禁用列表；
- 技能；
- MCP 服务器集合；
- 子 agent 列表；
- 无人值守配置；
- 各项限额。

约束单次执行的字段这样取交：
- 模式取权限更低的一方；
- 允许列表取交集；
- 禁用列表取并集；
- 单次执行的轮次上限取最小值。

没有任何字段是“内层优先”。解析之后才设置的值（插件的 `permissionMode`、队友的 `add` 叠加、授予中的 `tools.add`）与权限取交，绝不替换它。

额度池不拆分。token、费用和总时长是整棵运行树共用的一份持久化账本，它扩展了现有的子树 token 预算，并纳入 Bot 费用上限：
- 子 agent 在启动前先从账本预留额度；
- 重试和恢复从同一个池中扣除；
- 截止时间是绝对时间，恢复时不会重置。

在有限额度池下，每次执行都需要一个可强制执行的上界。无法计量或无法限制消耗的引擎会被拒绝，而不只是被移除工具，因为没有工具的引擎仍会消耗模型 token。未知的消耗绝不按零结算。只有确认执行已经停止后，才释放预留额度。

权限随运行持久化，完整传给运行启动另一个 agent 的每一种方式：原生子 agent、队友、squad、工作流 agent 节点、外部和 ACP agent、插件 agent 回合。有一个测试枚举这些启动路径。Bot 策略通过它到达每个子 agent。

无法表达某个字段的引擎，必须转换该字段，或由启动方扣下受影响的工具，绝不丢弃字段。

子 agent 继承执行身份，包括它的实时修订号，从不切换通道。

个人凭据从不离开 Host：
- 外部引擎的环境和 MCP 配置中不会出现个人 token。
- 外部引擎在个人通道下的访问，经由 Host 代理进行，每次调用都检查资源、动作和接收方。
- 引擎只有在具备完整的凭据与执行隔离时，才能进入个人通道：
  - 它自己的原生账号、系统钥匙串、配置目录和凭据助手都无法访问；
  - 它只使用 Host 提供的 MCP 配置；
  - 它的直接 API 出口只限于代理和它的模型端点。
- 无法做到这种隔离的引擎一律拒绝。这扩展了现有的拒绝机制：原生钥匙串账号共享的引擎已经会被拒绝（`crates/cognia-external-agent/src/process.rs`）。

## 考虑过的方案

- **继续以绑定了谁的凭据就用谁的身份运行**（d74e413ff1 之前）。否决：这样一来，被允许使用 bot 就等于借用别人的权限。
- **先检查发起人的权限，再用 owner 的 token 读取。** 否决：平台权限 API 回答的是调用身份本身的权限，所以这项检查本来就需要发起人自己的 token，而读取依然以 owner 的权限进行。
- **发群之前逐个检查每位成员对每个资源的权限。** 否决作为默认：它需要成员列表和逐资源查询，会与成员变动产生竞态，也不是每个平台都提供。以后可能作为收窄之外的可选方案。
- **只标记投递。** 否决：写进共享文档的摘要，或在之后回合中被复述的内容，不经过投递也会泄露同样的数据。
- **把允许的服务器的 token 交给外部引擎。** 否决：服务器允许列表并不能缩小 token 本身能触及的范围，声明范围将无法执行。
- **Bot 只允许服务身份。** 否决：现有 Bot 用的是个人 token，而带范围的绑定在别人触发时能提供同样的安全性。

## 后果

- 想在聊天中使用个人功能的人需要授权一次。在此之前，他们收到的是私下的授权链接，而不是答案。
- 用到个人数据的群聊回答默认变为私下回复，本人点一下即可分享。
- 读取过个人数据的运行，没有本人的披露授权，就不能把结果写到共享位置。这是主要的新增摩擦，是有意为之。
- 从聊天启动的 agent team 运行中个人调用被拒绝的问题随之消失：队友继承持久化的身份，不再重新推导。
- 没有按用户 OAuth 的平台，只对本机用户提供代表使用者通道。没有临时消息的平台，通过私信完成收窄。

**迁移。**
- 现有绑定个人凭据的 Bot，只有当提供方身份（例如 token 背后的 GitHub 账号）能对应到已知的人、并由此人确认时，才成为绑定个人。其他绑定一律转为 `needs_setup`，并在控制台提示。
- 个人现有的定时任务，只有在能确认创建者时才继续以代表使用者运行，其余转为 `needs_setup`。
- 配对迁移（ADR-0224）随安装一起携带这些授权记录。
- **标记机制上线前保存的历史没有标记，但不视为公开内容。** 在 d74e413ff1 之前，连接器会话中的每一次个人读取，用的都是适配器连接用户的 token。所以连接器会话中已有的历史，标记为属于此人，并使这些会话的引擎记录失效。无法确定连接用户的，历史只对当时的发起人可见，或者新的发起人从一个新会话开始。

## 推进步骤

在约束新权限的保护生效之前，不扩大任何访问。

1. 身份与权限类型持久化在 `ExecutionRun` 上，加上实时修订号与 epoch 检查，以及传输身份的拆分。每个入口都设置它们，行为不变。
2. 保密，强制执行：
   - 个人标记，及其在子 agent、工具结果和历史中的传递；
   - 历史隐藏；
   - 受众收窄和出口检查；
   - 严格的披露范围。
   目前只有 owner 拥有个人访问，所以这一步先于任何其他人获得访问而落地。
3. 覆盖每条启动路径的运行树权限、共享账本，以及外部引擎的代理与配置隔离。
4. 开放代表使用者通道：按主体保存的凭据库、授权链接及其投递方式、回调身份校验（先做 Lark）。它取代仅限 owner 的检查。只有在上述旧历史标记和引擎记录失效完成之后，这一步才能发布。
5. 绑定个人通道：确认、声明范围、控制台标注，以及转为 `needs_setup` 的迁移。
6. 其他平台，随各自支持按用户授权而跟进。

第 4、5 步发布之前，本 ADR 背后的攻击场景要作为验收测试运行：
- 第二个人插入消息；
- 子 agent 洗掉个人读取；
- 之后回合中的复述请求；
- 写入共享文档的摘要；
- 运营者代为分享；
- 运行暂停期间撤销绑定；
- 并行子 agent 的预算；
- 向外部 CLI 导出 token；
- 不支持临时卡片的 Lark 私聊；
- 第二个发起人加入后恢复的引擎会话；
- 迁移后会话中的旧历史；
- 由其他人触发的绑定个人读取；
- 针对代表使用者安装的 webhook；
- 授予披露后的 shell 出口；
- 写入本人拥有但已共享的文档的摘要；
- 有限预算下无法计量的引擎。

## 实现状态

Phase 1A 在 `ExecutionRun` 上以 observe mode 记录执行身份和已解析的运行权限。凭证选择和既有拒绝逻辑保持不变；权限修订不匹配只记录私有事件，不阻止执行。子运行保留父运行的固定身份（包括原始触发类型）；父身份不可用时记录 `child` 触发类型，不推测主体。权限强制执行和共享预算池记账仍属于后续阶段。

新身份通过 `rootRunId` 标记根运行；子运行保留创建时的身份快照，实时观察和发起人吸收则读写根运行。元数据记录不改变 `updatedAt`，相同值不重复写入，并随运行的下一次实际更新同步到其他设备。缺少已知人工来源的自动入口记录为 `external-event`。

Phase 1B 按用途（`transport`、`service-data` 或 `adapter-admin`）标记每次 tenant-token 使用，不改变凭证选择或请求行为。

Phase 2-0 关闭子会话绑定和模型伪造绑定漏洞：子会话技能继承根会话的 IM 规则，模型及工具表面移除回调绑定提示，仅 dispatcher 签发的绑定可以确认技能，conversation scope 回调要求双方提供匹配的 key。飞书个人授权必须通过本地桌面会话根的验证或既有 IM 所有者检查；没有会话的 Squad 运行保留非个人技能，个人授权标记为未验证。Phase 3 将通过持久化的运行身份恢复本地启动的 Squad 的个人授权访问。


### Phase 2-0 fix 6：Host 卡片与会话创建审计（2026-10-31）

工作流运行和 fan-out 审批由 Host 在记录绑定后通过 governed delivery 直接发送。两个 API 都重新读取指定 session 的 IM origin，拒绝目标不匹配，并只使用 Host 的实时 initiator。workflow-ai 始终提供当前 tool session；插件选择已有 IM session 的边界仍由既有 `connectors:send` capability 决定。workflow-ai 只返回 `sent: true` 确认，不返回 `surface`，并要求模型不要重新发送卡片。`prepareWorkflowApproval` 保留原有返回字段以兼容契约；模型转发信任注册表、issuance window 和异步投影均已移除。模型及工具卡片的全部 `binding*` 提示和带命名空间的回调值均会被剥离，包括未知前缀；Host 直接构建的卡片保持有效。插件不能登记 dispatcher 专属的 `skill_invoke` 绑定。

确认绑定保存持久化 ROOT session id。子会话和审批路由删除后，点击仍从 ROOT 恢复 IM binding，并使用点击者作为 acting sender。持久化的本地 team 根会话与本地 direct 会话采用相同 personal-lane 证明；没有会话的 Squad runtime 仍未验证。`programmaticCreator` 为非索引字段，不需要 Dexie version bump，也不授予 `runPluginAgentTurn` 所有权。

以下表格覆盖 `lib/`、`hooks/`、`components/` 中的聊天会话 `createSession` / `sessions.add` 调用，以及追踪中涉及的生命周期适配器和 Host/shared 投影；technical identifiers 与英文版一致。

| Entry point | Classification | Durable proof / delegation |
| --- | --- | --- |
| `lib/plugin/agent-sdk/session.ts` — `createPluginAgentSession` / resume | programmatic, marked | `plugin-agent-sdk`; resume stamps legacy rows before another send |
| `lib/ai/agent/agent-executor.ts` — temporary tool session | programmatic, marked | `plugin-agent-executor` |
| `lib/plugin/api/session-api.ts` — `ctx.session.createSession` | programmatic, marked | `plugin:<id>`; awaited durable row and cache use the same id |
| `lib/plugin/api/session-seed.ts` — `startSeededSession` | programmatic, marked | `plugin-seed`, including workflow session nodes |
| `lib/plugin/api/agent-turn.ts` — owned agent turn | programmatic, marked | Existing `agentTurnOwner`; creator markers grant no adoption rights |
| `lib/workflow/nodes/teams/index.ts` — character-send session | programmatic, marked | `workflow` |
| `lib/ai/agent/team/teammate/dispatch-teammate.ts` — tool-enabled teammate | programmatic, marked | `team-teammate`; registered run ancestry still resolves the root |
| `lib/ai/eval/targets/chat.ts` — default evaluation dependency | programmatic, marked | `evaluation` |
| `lib/agent/composition/verified-fresh-agent.ts` — verification session and DB adapter | programmatic, marked | `verification-agent`; adapter forwards the seed |
| `lib/harness/runtime/editor-runner.ts` — agentic editor | programmatic, marked | `harness-editor` |
| `lib/harness/runtime/probe-runner.ts` — probe, surface discovery, DB adapter | programmatic, marked | `harness-probe`; adapter forwards the seed |
| `lib/best-of-n/runtime.ts` — candidate rows / `sessions.add` | programmatic, marked | `best-of-n` on the shared native/external candidate row |
| `lib/scheduler/executors/index.ts` — scheduled chat/team | programmatic, marked | `scheduler` |
| `lib/scheduler/executors/goal-executor.ts` — scheduled goal | programmatic, marked | `scheduler-goal` |
| `lib/integrations/events.ts` — projected inbox thread | programmatic, marked | `integration-event` and existing `integrationBinding` |
| `lib/connectors/session-bindings.ts` — `createPlatformSession` / `sessions.add` | programmatic, marked | `connector` and existing `platformBinding` |
| `lib/connectors/commands/dispatch.ts` — both command creation branches | programmatic, marked | Delegates to `createPlatformSession` |
| `lib/db/background-tasks.ts` — admitted persistent child / `sessions.add` | programmatic, marked | `background-task` plus parent/attached-child ancestry |
| `lib/sync/host-state-store.ts` — `session.create` and `session.import` / `sessions.add` | programmatic, marked | `host-state` on both rows |
| `lib/browser-companion/service.ts` — agent/session creation branches | programmatic, marked | `browser-companion` |
| `lib/browser-companion/host-dispatch.ts` — production session adapter | programmatic, marked | Stamps `browser-companion` at the Host boundary |
| `lib/files-library/remote/host-dispatch.ts` — new attachment conversation | programmatic, marked | `remote-files` |
| `lib/router-fusion/api/run-api-host.ts` — session port | programmatic, marked | `run-api` and existing gateway `origin` |
| `lib/skills/recording/controller.ts` — controlled trial | programmatic, marked | `skill-trial` |
| `lib/dev/expose-test-globals.tsx` — anchor/performance and staged fixtures | programmatic, marked | `dev-fixture` on both creation branches |
| `lib/project-coordinator/thread-session.ts` — thread creation adapter | programmatic, marked | `project-thread`, then attached-child ancestry |
| `lib/db/sessions.ts` — `createSession` | trusted desktop UI entry / programmatic, marked | Shared persistence primitive; retains the caller seed verbatim |
| `lib/db/sessions.ts` — `forkSessionFromParent` | trusted desktop UI entry / programmatic, marked | Inherits creator/owner/origin/integration provenance; legacy IM/shared/default-plugin forks get `nonlocal-fork` |
| `lib/chat/start-session.ts` — `startNewSession` | trusted desktop UI entry / programmatic, marked | Shared lifecycle owner; preserves `programmaticCreator` |
| `hooks/chat/use-sessions.ts` — `create` | trusted desktop UI entry | Forwards the explicit new-conversation seed |
| `components/desktop/desktop-chat-workspace.tsx` — New Team Conversation | trusted desktop UI entry | Persisted unbound `kind: team` root; member ids decode to it |
| `components/goal/goal-quick-create-dialog.tsx` | trusted desktop UI entry | User submits a goal |
| `components/onboarding/flow.tsx` | trusted desktop UI entry | User selects the first task |
| `components/settings/chat-templates-section.tsx` | trusted desktop UI entry | User chooses a template |
| `lib/files-library/use-in-chat.ts` — `resolveUseInChatTarget` | trusted desktop UI entry | User sends a selected file to chat |
| `lib/pet/chat/seed-main-chat.ts` | trusted desktop UI entry | User hands pet text to the main-chat draft |
| `lib/shell/start-guild-conversation.ts` — both new-conversation branches | trusted desktop UI entry | Explicit shell agent/team conversation actions |
| `components/workspace/workspace-recent-conversations.tsx` | trusted desktop UI entry | Workspace new-chat action |
| `components/providers/initializers/selection-toolbar-initializer.tsx` — both branches | trusted desktop UI entry | Selection-toolbar handoff |
| `components/settings/data/webdav-sync-card.tsx` | trusted desktop UI entry | User requests setup help |
| `components/data/export/schedule-card.tsx` | trusted desktop UI entry | User requests cloud setup help |
| `components/settings/agent-runtime/sdk-session-manager.tsx` | trusted desktop UI entry | User explicitly continues a native SDK conversation |
| `lib/ai/agent/external/session/open-native-session-in-chat.ts` — chat adapter | trusted desktop UI entry | User explicitly continues a selected native agent session |
| `components/providers/initializers/tray-panel-initializer.tsx` | trusted desktop UI entry | Tray handoff |
| `components/providers/tauri-provider.tsx` | trusted desktop UI entry | Launch new-chat action |
| `hooks/system/use-tauri-events.ts` | trusted desktop UI entry | Native new-chat menu event |
| `hooks/agents/use-start-agent-chat.ts` | trusted desktop UI entry | User starts an agent chat |
| `hooks/codeserver/use-code-server-chat-bridge.ts` — staging session | trusted desktop UI entry | Editor handoff stages selected diagnostics/files |
| `components/chat/message-im-actions.tsx` | trusted desktop UI entry | Continue quoted IM text locally, staged for the operator |
| `components/chat/composer.tsx` and `components/chat/composer/bottom-toolbar.tsx` | trusted desktop UI entry | Composer launch/runtime choices |
| `components/agents/builder/agent-builder-setup.tsx` — session adapter | trusted desktop UI entry | User opens the agent builder |
| `lib/project-coordinator/coordinator-session.ts` | trusted desktop UI entry | User enables/opens the workspace coordinator |
| `lib/slash-commands/actions/issue.ts` | trusted desktop UI entry | User opens an issue conversation and stages its prompt |
| `lib/slash-commands/actions/sessions.ts` and `lib/slash-commands/builtin.ts` | trusted desktop UI entry | New-chat actions delegate to the host UI callback |
| `lib/collab/shared-chat-sync.ts` — shared row projection | programmatic, marked | `shared-chat`; legacy `collaboration` also refuses local personal authority |
| `lib/sync/host-state-service.ts` — new summary rows | programmatic, marked | `host-state`; existing rows retain their original provenance |

同名的 browser、external-engine、CRDT、OAuth session API 不创建 `ChatSession`；`lib/usage/` 和 external manager 中的 `sessions.add` 为 `Set.add`。分支和 aside 保留 `parentSessionId` / session `surfaceBinding` 根链路；editor/resource workbench 属于桌面 UI 入口。此审计没有修改 import/restore writer。

**剩余风险。** 默认标题、`agentTurnOwner`、`origin`、`integrationBinding` 可识别的旧插件会话不会获得本地 personal authority。经 plugin agent SDK 恢复时，Host 在继续执行前补记缺失标记；SDK fork 保留已知非本地来源。旧插件会话若使用自定义或修改过的标题且没有剩余来源字段，在经 SDK 恢复之前仍无法与桌面会话可靠区分；没有批量改写旧记录。队列与绑定测试不代表真实 IM provider 交付验收。

**生成契约。** 使用 `scripts/plugin/generate-contract.mjs` 生成 Rust CLI catalog、Python contract、TypeScript resource effects、plugin-point catalog 和 plugin-dev API reference。沙箱禁止 tsx CLI 的 IPC socket，因此通过 `node --import tsx` 启动其子任务并调用同一 `generate` 导出完成生成和检查。已执行包含 codeserver extension NLS 的 `pnpm i18n:build`。另一会话暂存的 `crates/cognia-cli/assets/author-types.json` 未修改也未重新生成；其中尚无 `prepareFanoutApproval`，reviewer 后续执行 `pnpm author-types:bundle` 会加入该方法和 `sent` 返回字段。
