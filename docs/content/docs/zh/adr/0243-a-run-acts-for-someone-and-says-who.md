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
2. **用谁的凭据。** 连接器每个适配器只保存一个用户 token。d74e413ff1 增加了一道检查（`lib/auth-providers/feishu/cli/acting-identity.ts`）：Lark 技能读取本回合的实时发送者，拒绝连接者以外的所有人，所以其他人都用不了个人功能。Bot 安装把凭据槽绑定到集成账号（`credentialBindings`）。它没有记录任何人的字段，它的 `owner` 是运行它的机器（`lib/placement/ownership.ts`）。
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

| 触发方式                      | 代表使用者     | 服务身份 | 绑定个人                                                   |
| ----------------------------- | -------------- | -------- | ---------------------------------------------------------- |
| 发起人自己的消息或操作        | 代表该发起人   | 可以     | 发起人就是被绑定的人时等同于代表使用者，否则只用声明范围   |
| 某人设置的定时或固定任务      | 代表该授权主体 | 可以     | 授权主体就是被绑定的人时等同于代表使用者，否则只用声明范围 |
| 外部事件（webhook、集成事件） | **绝不**       | 可以     | 只用声明范围                                               |

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

召回的个人记忆也属于这类读取：将其注入运行即会标记该运行（见实现状态，2026-11-09）。

**谁读取历史。** 每个回合有一个有效读者：

- 有发起人时，是全部发起人；
- 没有发起人时，是触发方式表格允许的、经过验证的授权主体；
- 服务身份和外部事件运行没有个人读者。

子 run 使用其当前 root 的读者。在同一 Host 上，`samePersonForHost` 将本地本人和 adapter 经验证的 connected owner 视为同一人：Lark `settings.connectedUser.openId`／`unionId`，或 Slack `settings.connectedTeam.authedUserId`。其他 platform person 仅按 platform、adapter、remote user 相等，或双方都有的同平台 union id 相等。消息、模型及插件字段均不能建立 reader authority。

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

额度池不拆分。token、费用和总时长是整棵运行树共用的一份持久化账本，记在声明它的那个运行上。子代理嵌套预算、Bot 费用上限、工作流费用上限和 best-of-N 费用上限，都是对这本账的声明：

- 每次执行在请求发出前预留：自带上限就预留自己的上限，否则占用剩余的全部，所以没有自带上限的兄弟执行会互相等待；
- 子执行从它上方最近的有效预留里借，所以一棵子树花的不会超过父级预留的；
- 自动重试和恢复从同一本账扣除，并保留它的绝对截止时间；人手动重跑用自己的一本新账和新的截止时间，但仍挂在原来的父运行下，归属不变；
- 确认执行已停止后，按它上报的用量结算；没有停止证明或没有用量时，扣除整个预留。未知的消耗绝不按零结算；
- 有美元上限时，没有价格的模型在设置价格之前会被拒绝。

引擎分层计量。绑定了 Cognia 模型的任务走 Host 模型网关，网关 ticket 的上限就是它的预留；回合成功结束且 ticket 已吊销后，按回合用量结算。用自己供应商登录的引擎保留自己的登录（2026-11-16 修订：不强制走网关）：它预留最坏情况，回合进行中按上报的用量扣除，达到预留即被中止，回合成功结束后按该用量结算。失败、取消或丢失的回合扣除整个预留。在有限的 token 或美元预算下，用自己登录、运行时不上报用量的引擎会被拒绝，而不只是被移除工具，因为没有工具的引擎仍会消耗模型 token；它可以改用 Cognia 模型走网关。

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
   - [x] 严格的披露范围（阶段 2D，2026-11-13）。
         目前只有 owner 拥有个人访问，所以这一步先于任何其他人获得访问而落地。
3. **部分实现：** 运行树权限（阶段 3A，进行中）；共享账本（3B-1，已实现）；外部引擎计量（3B-2，已实现）；外部引擎代理和配置隔离（3C）仍未完成。
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

**阶段 3B-1（2026-11-16）。** 每棵运行树一本 `RunLedgerV1`，不建索引，记在声明它的 `ExecutionRun` 上，只在单个 Dexie 事务里写入（`lib/execution/run-ledger.ts`）。预留沿 `parentRunId` 找到最近一个带账本的运行，并从这条链上最近的有效预留里借，先看运行自己，所以正在运行的 turn 再执行一次时，从这个 turn 自己的预留里借。可用额度是父预留的额度减去它已观测的花费和已借出的部分；在根上是上限减去已花费和顶层预留。结算时，有停止证明就按上报的用量扣，否则扣除预留减去仍在运行的子预留；扣款计入 `spent`，并从每个上级预留中减去；比父级活得久的子预留挂到下一个有效预留上。兄弟占着剩余额度时，预留会等待（可中止、轮询、受截止时间约束），只有没有任何东西能释放额度时才以 `budget_exhausted` 拒绝；`deadline_exceeded` 以及美元上限下的 `pricing_unknown` 立即拒绝。每个预留都通过子运行归属声明认领；启动恢复把所有没人认领的预留按未确认停止结算。

各条执行通道在执行时预留（`lib/execution/run-budget-rail.ts`）：`dispatchPrompt` 里的 sidecar turn（sidecar 通过 `runBudget` 收到预留的 token 上限和截止时间；Claude SDK pump 用完时中断，AI-SDK 循环限制每次请求并拒绝下一步；停止证明是没有后台进程的 `turn_settled` 或 `session_disposed`，sidecar 退出不算）、进程内 completion 通道、外部代理管理器的 `execute`/`executeStreaming`（网关 ticket 的上限就是预留），以及工作流里每个 `ai.prompt` 模型客户端（不隐藏重试、限制输出、按本次调用的用量结算）。声明：顶层子代理派发把 `subagentNesting.tokenBudget` 和 `timeoutMs` 声明在它挂靠子代理的那个运行上（如果这个运行在有预算的树里、自己却没有预留，就在子代理运行期间作为一个预留），子代理运行到这棵树的绝对截止时间；Bot 运行声明 `maxRunCostUsd`；工作流运行把 `maxCostUsd` 声明在它的执行运行上（在父树里是自己的一个预留，手动重试开新账，恢复沿用原账），结束时记录花了多少；best-of-N 组声明费用上限，每个候选（包括外部代理）预留自己那一份（`maxCostUsd / n`），所以候选仍然并行。Job Center 的手动重跑保留父运行，但声明一本新账；自动恢复保留原来的账，不再因 token 预算被拦下。

已删除：内存中的子树守卫（`dispatch-budget.ts`、`_budgetRootRunId`、`budgetRootRunId`）及其强制串行；3A 起记录但从未执行的 `RunAuthorityV1.pools`；Bot 在两次调用之间检查已花费的逻辑及其 ticket 换算；工作流预算引擎（`run-budget.ts`）、「预算未覆盖」标记和 `WorkflowRunLineage.budgetCeilingUsd`；best-of-N 对没有原生美元上限的运行时的拒绝。小队的 `tokenBudget` 仍是软性升级守卫（通知、暂停、降低并发），不是账本上限。

遗留：嵌入调用（`knowledge.embed`、`twin.rag`）不预留。具体命令和结果：`docs/evidence/2026-11-16-adr-0243-run-tree-budget-ledger.md`。

**阶段 3B-2（2026-11-16）。** 每个运行时在执行语义里声明是否上报回合用量（`AgentExecutionSemantics.usageReport`，取 `turn` 或 `none`；什么都没声明的适配器按 `none` 处理）。一个回合用量跟踪器（`@cognia/agent-runtime-kit/base-adapter` 的 `createTurnUsageTracker`）以同样方式读取 `usage_update`、`message_end` 和 `done`，供收集式 `execute()`、外部代理管理器的流式路径和预留共用，因此流式回合不再丢失终止帧携带的用量。管理器在用量变化时把当前数字记到预留上（`RailBudget.observe` 在达到预留时中止执行），只有在有停止证明时才按回合用量结算：回合成功结束（`done` 成功、`session_end` 完成或成功的结果），网关通道还要求 ticket 已吊销。在 token 或美元预留下，运行时不上报用量的原生引擎在发出任何请求之前以 `unmetered` 被拒绝；只有截止时间的预留仍允许运行。Bot 的外部代理路径在标记派发之前做同样的检查，并要求先完成设置。以美元上报、没有 token 拆分的供应商费用现在也计入；其他单位不计入。遗留：网关任务按引擎上报的用量结算，以 ticket 为上限，因为网关不返回 ticket 实际计量的花费；原生登录下引擎在成功 `done` 之后的调用不计入；按消息而非按回合上报的适配器（OpenCode v1）在回合中途可能滞后，直到 `done`。具体命令和结果：`docs/evidence/2026-11-16-adr-0243-external-engine-metering.md`。

**阶段 3A（第 15 轮，部分完成）。** 精确 cap 规则与 `caps: "explicit-v1"` 标记保持有效：仅继承的显式 authority、grant、Bot/composition authority、显式 workflow node cap 与 policy/unattended cap 进入记录；旧 surface 只继承 pools。Thread 准备阶段被拒绝后消耗该 run identity，重试使用新 queued 行并获得 durable acceptance 与活跃 child journal。Typed workflow runner 经新旧 deployment admission 将 workflow 及 agent node 关联到 Host tool-call/invocation run；模型参数不能选择父级，无 run 调用保持根。插件 façade 解析调用方的方式与 plugin SDK launch 相同：已准入行，其次 reservation 的 Host 已知父级，否则为根；reserved turn id 不会成为 workflow 父级。跨 project 的子 workflow 以带 observation 的根启动、不建立谱系链接，但把父级继承的显式 cap 记录为自身上限，其 agent node 仍受限；无显式 cap 时与 HEAD 相同，为普通根。凡携带尚未准入 turn id 的 hook 上下文（deferred build hook、goal/loop 续跑、plan step、后台投递、早期 chat error）都标记为 reserved，并在 Host 已知时附带父级。Plugin SDK/session/external launch 与 typed workflow façade 随后优先使用已准入行，其次该父级（仅当其行存在），否则无父级启动（已删除的 captured coordinator 保留带 observation 的根例外），不会因行缺失而被拒绝。Reader/mark 保留 reserved turn id；例外是 local-person 分支只携带 Host-only local proof（与 HEAD 相同），以及 façade 对无行 reservation 的隐私闸门不带该 id、但保留全部显式依赖。`onChatError` 经 await 的 hook 路径投递，不再作为 cold-cache 同步通知。CLI 自身工具选项保持 HEAD 的空 allow 与精确 deny 语义，继承 cap 单独应用严格空 allow 与 glob deny。本人输入的 project-thread turn 保留 Host-only local-person OAuth/checkout proof 及调用者显式 MCP 选项，行、hook 与 reader 仍保持 coordinator 谱系；普通已准入 turn 仍按自身行解析凭据。Legacy workflow retry 可保留自身 workflow root metadata，但 canonical execution parent 与 caps 仍经验证继承，其他矛盾 root 继续拒绝。Room 成员保持无父级 service/person 根且不继承 tree cap，privacy provenance 不建立祖先关系。Captured coordinator 缺失及已入 journal 的 pruned-parent 恢复仍保留带 observation 的根例外。Host 构建 MCP map、无映射 server withholding、三个已知 SDK server 例外及 workflow 自身选项语义保持不变。远程 `execution.turnOptions` 为没有生产 sender 的 dormant receiver seam，已在类型、receiver 注释与 AST 测试固定；既有远程限制仍在 `execution.policy`。在 dev `a1f113309d` 上的最终验证：320/328 suites、8219/8566 tests 通过；8 个失败 suite 在干净 dev 上同样失败。Native tsc 有 58 条全局诊断，全部 179 个修改路径诊断为零；修改的 sidecar suite 105/105 通过。不声明 native/provider 验收。精确命令、启动路径/引擎表及边界见 evidence ledger。3B 共享 accounting 与 3C credential/env/config 隔离及剩余 broker enforcement 仍未完成。

| 启动路径                              | Host 应用点                                                                                                       | 父链接                                                                             | 测试                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 原生 dispatch / plugin SDK dispatch   | `launchChildRun` → execution service → `resolveSendOptions`                                                       | 固定 `execution:job` 父级；缺失则拒绝                                              | `launch-child-run`、`dispatch-run.identity`、`agent-executor`                           |
| SDK 原生子 agent                      | Host 最终收窄、sidecar `enforceNativeRunAuthority` / PreToolUse                                                   | 同一原生 query，无独立记录                                                         | `run-authority`、sidecar `options`（临时链接已安装依赖）                                |
| Squad 启动 / 委托                     | `createSquadRunRecords` 插入前解析                                                                                | parent 或 launching run                                                            | `squad-run-records`；委托复用公共 launcher                                              |
| 本地 teammate                         | 准入与继承上限收窄；overlay 扩展默认集合，再应用 frozen bundle 和祖先 cap                                         | 团队执行记录                                                                       | `capability-resolver`、`dispatch-teammate`                                              |
| 远程 teammate                         | `encodeRemoteWorkerPolicy` 合并继承 cap 与 HEAD mode/tools/MCP/sandbox 限制，placement 要求 worker-policy-v1      | Host 解析所属团队                                                                  | 真实 `dispatch-teammate` policy/placement 回归及 wire-policy 测试                       |
| Workflow agent / ensemble agent       | execution service 创建真实子记录                                                                                  | 所属 `execution:workflow:<id>`                                                     | `agent-turn`、`ai-ensemble`、execution-service                                          |
| Typed workflow tool                   | `agent-tools` / plugin façade → typed runner → deployment admission → workflow bridge                             | Host 调用 run（façade：已准入行，其次 Host 已知父级；不用 reserved id）；跨 project 子 workflow 保留显式 cap；无 run 调用保持根                                                   | 真实 workflow/agent-node matrix 与新旧 deployment admission 测试                        |
| External / ACP / remote external turn | manager 的 streaming 与非 streaming 入口读取 Host 来源                                                            | launcher / 远程 Host 准入                                                          | external `run-authority`、`manager`；未做真实 provider 验收                             |
| Plugin character turn / Bot 子级      | mode 取交集并等待持久化；Bot 在 executor 前保存策略                                                               | Host 父级 / Bot 根                                                                 | plugin `agent-turn`、Bot `run`                                                          |
| Plugin agent SDK                      | 以 `pluginExecutionContext` 保留整个异步 Host invocation，包括 streaming                                          | 精确 Host invocation → 子 launcher                                                 | SDK `run` invocation 生命周期回归                                                       |
| Best-of-N                             | candidate 身份进入公共选项解析器                                                                                  | Best-of-N 团队 execution                                                           | `runtime`                                                                               |
| Goal turn                             | 等待 goal journal 投影，再创建 turn 子运行                                                                        | 所属 `execution:goal:<id>`                                                         | `goal-headless-runner`                                                                  |
| Scheduler / creator / room            | scheduler 仅传真实 Host 行；Creator 最终收窄；room production 准入                                                | Creator 显式父级或首次 authoring run；room 为不继承运行树 cap 的 service/person 根 | 真实 cron、Creator 和 automated-room 选项对照；完整 IPC 单列                            |
| Plan step / Squad reconcile judge     | `step-dispatch:dispatchPlanStepNode`、`workflow-nodes:reconcileTeamRun` 先显式同步 plan，再在执行前创建独立子记录 | 所属 plan / team 记录                                                              | co-located 子 id 与结束状态回归                                                         |
| Coordinator / direct chat             | `acceptChatTurn` → 原子 `acceptWorkSubmission`；仅路由后进行本地回退准入                                          | Host 捕获父级；缺失 coordinator 父级时为带 observation 的根                        | 真实 window acceptance、冻结 crash replay、不重复 replay 及 Squad/Fusion 无多余记录回归 |
| Host background / paired turn         | `runHostAutomatedTurn` / `admitPairedChatTurn` 原子准入；paired 最终 authority 取交集                             | Host 保存的 thread coordinator                                                     | 真实准入覆盖父级存在、缺失及伪造 client claim                                           |
| Subworkflow / retry                   | `runWorkflow` / `syncWorkflowExecutionRun` 保持 HEAD project 归属，核对父级自身 project/source                    | 父 workflow；裁剪后的所有 retry 都为带 observation 的根，并重建自身 node cap       | Bridge 与 orchestrator workspace/pruned-seed 回归                                       |
| Connector / delivery child            | Connector resolved ceiling 不记录；`enqueueOutboundMany` 原子准入 delivery job                                    | Connector requester 根 / 确切的 delivering run                                     | Connector runtime、outbound-jobs 及 authority 事务回归                                  |

下表的 external 限制仅来自显式继承 cap；父级为 bypass 时，未设 mode 的子级仍按 `default` 应用。Cognia broker 在可见性层扣留排除的投影工具，包含空 allow-list 和 namespace glob。`auto` 先向下转换为 `acceptEdits`，再按引擎支持的 mode 收窄。

| 引擎 / 传输                                    | 原生工具                                                                                                | MCP / skills / subagents                                                                                                                                              | turns / 无人值守 profile                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Native Claude SDK                              | Host/sidecar mode 取交集；既有原生 tools 与继承 allow 取交集，不重新开放空或较窄 surface；保留强制 hook | MCP strict 过滤；继承 skill cap 筛选受信任 id，扣留不受信任原生内容；子 agent definition 与上限取交集；deny 参数模式保留 SDK 规则                                     | turns 取最小值；既有 unattended responder                                                          |
| Codex / SIWC app-server                        | shell-only deny 禁用 `shell_tool`、`unified_exec`；其他无法表达的原生列表拒绝                           | 过滤 Host MCP，分页枚举并在线程配置禁用 `only` 外 ambient server；禁用原生 multi-agent features；skill 限制仍拒绝                                                     | 保守计数 Host execution step 并取消；仅保留 callback 的 default mode 使用既有 unattended responder |
| claude-code ACP / 其他 ACP                     | 扣留投影工具；原生列表转换待补，目前拒绝                                                                | ambient MCP/skill/subagent 限制待 vendor 配置，目前拒绝                                                                                                               | Host step 计数；default callback responder                                                         |
| OpenCode / v2                                  | V1 完整清单 → prompt 映射；V2 保持 mode 下限；`Bash(rm:*)` 等参数 deny 返回类型化 `tools.deny` 拒绝     | ambient/native discovery 限制仍拒绝                                                                                                                                   | Host step 计数；default callback responder                                                         |
| Pi RPC                                         | 原生 exclusion floor 与 mode、别名取交集；`Bash(rm:*)` 等参数 deny 返回类型化 `tools.deny` 拒绝         | 继承工具 allow/deny 过滤实际 Pi MCP projection（真实 stdio 回归）；隔离 extension floor 禁用 ambient skills/extensions 与可选原生 subagent package；Host 过滤传入材料 | Host step 计数；default callback responder                                                         |
| OpenClaude                                     | 投影扣留；不支持的原生列表拒绝                                                                          | 不支持的 discovery 限制拒绝                                                                                                                                           | Host step 计数；default callback responder                                                         |
| Aider / Continue / DSH / Codebuff              | 既有 mode 下限；不支持的原生列表拒绝                                                                    | 不支持的 discovery 限制拒绝                                                                                                                                           | Host event-step 计数；无法保证 callback 时拒绝继承 profile                                         |
| Crush / Rovo / A2A / HTTP / WebSocket / custom | 既有 mode 证明；拒绝明确命名 engine 与 field                                                            | 不支持的 discovery 限制拒绝                                                                                                                                           | 无可计数 step / callback 时拒绝有限 turns / profile                                                |

3A 剩余验收：明确允许保留的 5 项基线（refinePlan、personal-visibility guard、personal-sink guard、Aside projection 和 personal-egress G6）、允许 localhost 监听的环境中的 HTTP/SSE 扩展用例、全局 compiler/dependency 上下文及更广 native/vendor 验收。Room 成员仍为不继承 tree cap 的 root；captured coordinator 缺失和已入 journal 的 pruned-parent 恢复仍使用带 observation 的 root 例外。保守事件计数不等同于原生 LLM turn 遥测。3B 仍欠共享 reservation/spend/deadline accounting；3C 仍欠 credential/env/config 隔离及剩余 broker enforcement。精确结果见 `docs/evidence/2026-11-13-adr-0243-phase3a.md`。

阶段 2D（2026-11-13）：收窄后的私密卡片通过 connector 既有固定通知语言目录及 A2UI／原生卡片路径，提供“分享到群组”和“保持私密”。新增 `marked-person` 操作人范围，使用经过验证的回调身份匹配每个被标记的人，包括 Host 主人经过验证的连接身份；发起人或运营者权限均不构成例外，callback 开关关闭及 ADR-0239 shadow mode 也不能放宽。既有回执的 Host 本地未索引字段保存原始请求、SHA-256 哈希、确切 adapter／conversation 目标、相关个人、持久化消息身份和 24 小时有效期。授权记录在 `personal.disclosure`，授权消耗与唯一 outbound job 在同一事务提交。runner 再次校验哈希、目标和相关个人，不允许改写或改道已披露的请求，仅在成功投递后发布不含私密内容的“已由本人分享”通知。私密投影使用独立幂等键，避免抑制原始请求的精确重放。

投递后的规范消息获得仅由 Host 写入的披露元数据。如果原消息还包含未披露的工具部分，则为实际投递内容单独持久化精确投影并记录披露，原消息仍受保护。同一 connector conversation 的同一 session 内后续轮次可以读取该消息，visibility digest 随披露变化。其他 session、派生 artifact、插件、公共分享链接及共享协作投影继续隐藏；通用 metadata／导入合并保留既有 Host 披露并丢弃传入授权。固定 text／markdown 的 `connector_send`、`connectors_send_message` 可以提供同一私密卡片并由 Host 重放，而原工具调用仍被拒绝。不透明／无哈希载荷、可变媒体、文档／integration／HTTP 写入及任意工具执行均不获得重放权限。声明接收方的类型化接缝在阶段 5 前拒绝 bound-person 通道。run taint 和阶段 2C-2 不透明出口围栏保持不变。本地验证及真实 provider／native 验收边界记录于 `docs/evidence/2026-11-13-adr-0243-phase2d.md`。

阶段 2C-2（2026-11-12，第 7 轮修复）：不透明工具在 dispatch 前检查所属 run 的规范 taint，审批与 shadow mode 均不能放宽。Native／AI SDK 围栏、admission 等待、CLI broker 策略、sandbox 逐命令断网与外部引擎限制继续生效。text-only completion interceptor 传递生产者的 Host run；匿名完成仅由显式标记或可证明的 consuming run 限制。S2 已覆盖 terminal／Git／shell、原生 guest、integration／connector selector、automation、workflow URL／project setup、backup HTTP、share 回调重试和 scheduler webhook fan-out。有限操作在 finally 释放；真实后台进程按 Host 进程身份、退出事件及有界 liveness 检查保留，run 结束不能单独证明进程结束。远程／OTLP 日志在批次、重放及回调拒绝后保留精确来源；文件、PDF、视频自动预览使用持久化保留的 Host 消息来源。固定内容 connector 投递保留独立 sink 授权。严格 guard 包含 38 个 AST 入口合约、3 个 MCP caller-context 合约、7 个 capability 策略与 48 个删除门禁变异检查。原 104 项均已审阅并解决；当前 767 项快照为 257 个 tool-gated、498 个 host-system、12 个 gated-here，没有 unresolved 类别。局部验证、基线限制与完整 S1 caller/run 表见 evidence ledger；这些检查不代表真实 provider 或操作系统防火墙验收。 Fix5 将 clean capture 绑定到真实 Host entry。插件实例保留接触过的全部 producer，回调结束后继续校验出口，直到实例卸载／重载；旧 API closure 保留旧实例限制。同树 delegation 和固定内容 sink 明确排除 opaque in-flight 登记。匹配的 fenced PreToolUse 远程 guard 拒绝工具；command guard 使用既有 network-off launcher，否则拒绝。其他生命周期 hook 只记录 warning，不 block。未知 session ancestry 必须 fence／等待，sandbox consumer 在终态／释放时清理，MCP run context 由结构门禁固定，未验证 non-read Host 工具对 marked run 拒绝。F3／F10 工具表与 pinning 结果见 evidence ledger。

Fix7 以内容排除替代 native guest 生命周期 lease：拥有独立 OS 网络能力的 Python、hybrid Python contribution 和 VSCode guest 不得接收带标记 run tree 的内容。工具、contribution、interceptor、stream 及 Host 回复均使用规范 Host 来源校验。匹配的 native PreToolUse guard 无法接收 payload 时拒绝工具，其他 hook 记录 warning 后跳过且不 block。Host 读取使等待中的 guest 所属 run 被标记时，只回复固定拒绝文本，错误回复同样受限。WASM 保留插件实例级 F2 Host API 围栏；较早未标记内容的交付不需要 guest lease。

残余边界：原生 `TodoWrite` 仍被豁免。较早未标记 turn 启动的脱离进程仍可能读取 transcript 或磁盘；本阶段未隔离这些进程，run 之外的进程隔离归阶段 3。

标记操作先持久化 taint，再等待受影响会话的 fence ACK 和已跟踪的在途 opaque 操作结束，期间不释放个人结果/上下文。Native/AI SDK 清理进程后检查存活 jobs，包括 detached origin。已注册且仍存活的 native background task 会拒绝个人内容 admission。Terminal lease 仅证明 shell 已退出；可能继续存活的 detached descendants（包括 nohup/disown 进程）属于 phase 3 进程隔离残余风险。MCP discovery/listing 不携带 run 内容，继续允许。这些本地 barrier 不等同于 OS 防火墙或真实 provider 验收。

外部引擎类别：内置 Claude、AI SDK 支持 live fence。Codex marked-start 强制网络关闭，禁用附加及发现的 native MCP server，将 fence 纳入 native session 身份，拒绝跨身份 resume，并在 resume/fork 保留网络上限。Codex 无 per-call native fence，因此拒绝 mid-run marking。其他外部协议保守拒绝 marked-start 和 mid-run admission。无 run id 的未标记 external 调用保持原行为。

run-bound 插件 openPane 保留同步 boolean：run boundary 的一次 canonical read 预热 Host 缓存；mark／祖先 revision 只使受影响的后代快照失效，无关 run 保留快照。cache miss 使用无副作用 probe 保留同步 boolean；仅一次 canonical read 通过后才能创建／导航 pane，回调前 cache 失效仍拒绝。插件 ctx.network 在 credential resolution 后、实际 dispatch 时只读取一次 canonical taint。直接 primitive 清单扫描 tool-capable workspaces 的生产源码超集，新增未分类调用点会失败；静态 alias 分析不能证明任意运行时代码的行为。web_search query、provider 流量和 DNS 仍是 residual。各 lane、实际验证及未完成验收见 `docs/evidence/2026-11-11-adr-0243-phase2c2.md`。

fix round 2 将安装的 SDK registry 所证明的 native 身份传递至 Host approval；同名插件／MCP 不获得例外。marked Codex 的 plan/dontAsk 保持未标记时的文件 sandbox 和 approval policy，只收紧网络。Host operation lineage 仅排除提交 mark 的调用栈及实际 stream，其他 sibling operation／stream 仍阻止释放。Native 插件 relay 按实际 Host round-trip 身份跟踪；用户覆盖同名 MCP namespace 时仍按第三方处理。有限操作与进程退出清理 Host process 状态；run 删除／终态不能替代真实进程退出，account 切换清理旧 scope。ACK 期间 account DB 变化也拒绝 admission。Terminal exit proof 仅覆盖 shell；退出后仍存活的 detached descendants 属于 phase 3 进程隔离残余风险，本阶段不证明完整后代隔离；本地回归不代表 provider／OS 验收。

Phase 2C-1（2026-11-10）：可移植的 personal-sink 判定与 Host 边界检查，在 connector 能证明私有目的地时，将仅属于一个人的回答收窄至本人；否则隐藏。run 的 taint 合并本身及沿结构父链到固定 identity root 的全部祖先标记；confirmation 创建的新 identity root 仍保留实时结构来源祖先，审批不会截断后续来源标记。声称存在但无法解析的 job parent 在创建新 job 前即被拒绝，不能洗成无标记的新根；execution 无法解析、祖先读取失败或出现环时隐藏。history 与 derived-context preparation 在释放上下文前，将实际仍可见来源的显式标记提交到消费 run；提交失败则隐藏该上下文。仅供 Host 本人 UI 使用的 owner helper 不污染 run。**D1 legacy 残余：**`effectivePersonalMarks` 对缺少版本标记的 connector 旧行所推断的读取时归属，仍过滤历史，但其推断本身不会污染消费 run；显式来源 message／artifact／run 标记会污染。公开快照继续包含这些 legacy 推断，并隐藏相应旧行。

第一轮复核修正：gateway 与 notification 入口必须显式传递 Host provenance。缺少精确消费 run 时隐藏 marked context，不再从同 session 的其他 active run 推断。已证明的本人受众可以接收 opaque payload；未知受众仍 withheld 且无 `contentHash`，因此 disclosure 不能解锁。confirmation 的读取标记会沿结构链跨 identity segment 提交。共享标题和编辑后的摘要草稿在来源消息删除后仍保留来源 run taint。流式回复合并过期 frame 并在 final 重读；native presentation 在每次 driver 写入前重查。收窄会清除原会话 placement/edit 指针；回执区分被隐藏的原内容与实际收窄内容，并在同一次 attempt 内去重。模型侧拒绝文案不含平台 ID。调用点清单包含 `app/**`，plugin `prepareEgress` 明确列为 2C-2。缺少可信 run binding 的旧 producer 继续 withheld，不将 session 或 wire run ID 提升为权限。

补充复核修正：workflow run／fanout 卡片在等待 origin resolution 前捕获 Host plugin invocation；team notification 保留 canonical team execution。固定命令和关闭状态文案与来源不明的旧标题／可选回答 detail 分别分类。新的人类入站消息预览显式归为 typed action，不推断为 run output。companion broadcast／push 独立检查未知受众：owner-local notification 不授权远端 reader，native push-by-ID 属于 opaque payload，不记录披露 hash。stream drain 也保留上一 promise 结算间隙到达的 final。Fumadocs 集合外的`docs/evidence/2026-11-10-adr-0243-phase2c1-caller-inventory.md`逐项记录调用分类与来源限制。

个人内容检查独立于 ADR-0239 的 `off`／`shadow`／`enforce`，operator 权限和工具／审批对话框都不能披露他人的内容。execution id 仅来自 Host 持有的 job、tool 和 invocation binding；plugin、model 或 message 提供的 run-id 字段不构成来源证明。sink 清单如下：

| 边界                                                                             | 受众证明与个人内容结果                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connector delivery gateway、queued runner、reply stream 与 run-presentation 更新 | 经验证的 Lark p2p／ephemeral 及 connected-owner Slack IM 目的地可以匹配标记本人。单人回答可收窄至受支持的 ephemeral card 或经验证的同 adapter DM，否则隐藏；每次后续 stream／update 重新检查 taint。群聊仅收到固定且不含内容的通知。reaction、typing 与删除不携带 run 内容。                                         |
| Outbound tool planner、integration execution 与 Squad GitHub delivery            | 每个提取出的收件人都须有证明；integration／document write 及未证明目标视为受众未知并隐藏，覆盖已批准／重放 job。直接本人写入使用显式 Host-origin 分类。                                                                                                                                                              |
| Lark built-in dispatcher                                                         | 读取仍可使用；document、sheet、wiki、base、task、calendar 和 drive mutation 视为受众未知，在 CLI 执行或审批前隐藏。不新增 permission-list reader 或 Lark scope。                                                                                                                                                     |
| Workflow HTTP／webhook 与 send／write node、scheduler、plugin Host invocation    | 保留 Host execution binding，应用同一未知受众或 connector 判定。                                                                                                                                                                                                                                                     |
| Browser submission                                                               | 未知受众的提交隐藏。opaque／无法精确 hash 的 browser payload 记录不含 `contentHash` 的 `withheld` receipt；该 receipt 不能用于披露。                                                                                                                                                                                 |
| Shared conversation import 与持久化 assistant event                              | 持久化 event history 的未来成员未知，因此个人内容以无 reader 投影，在准备附件前隐藏。若旧 append-only import 已含个人原文，则拒绝接管／激活；correction 无法抹去原始字节。本地 canonical 行保留。                                                                                                                    |
| ADR-0241 ephemeral live frame                                                    | 每帧重新读取认证成员集和 Host taint，再先用 `withholdForReaders` 过滤，后进入 assistant／PII 投影。live POST 缺少原子的 member-revision fence，仅读取当前成员不能证明实际发送时受众。因此保守使用无 reader 投影，即使当前仅有 owner，个人内容整条消息（含 tool part）仍变为占位符。                                  |
| 公开单／多会话 share snapshot                                                    | 无 reader 的匿名投影包含 legacy 标记，并在 materialize media 前执行。删除消息后，标题仍保留 source-session／祖先 run taint。准确 Host payload 对象绑定内存中的 projection proof，并在 upload 前重新检查；过期缓存和没有证明的原始 transcript snapshot 拒绝。仅延长 link 有效期的 renewal 不会重新构建既有 snapshot。 |
| Plugin `ctx.share.create`                                                        | execution 来源取自 Host invocation，未知公开受众在 share client 之前隐藏；opaque payload receipt 不记录可用于披露的 hash。                                                                                                                                                                                           |

收窄／隐藏判定将个人记录写入既有 action-review 或 delivery receipt 的无索引 `personal` 字段：persons、outcome、已知精确 payload 的 SHA-256 与 original target。无法取得精确 payload 时省略 hash，不授予任何披露可能性。无需 Dexie version／index 或依赖变更。source-scan 清单固定 typed send／stream／edit／upload、planner、Lark 与 collab／share writer 的调用位置和次数（含 alias），并单独检查权威 Host 边界；清单也登记 transport 实现及显式本人／固定通知路径，不把所有通用 `send` 方法都当作模型出站。

通用 tool 参数、Lark CLI 参数、plugin action input 和 adapter mutation descriptor 是 opaque handler descriptor，不能证明实际发送的字节；其前置检查隐藏 tainted call，且不记录披露 hash。固定的 raw HTTP 字符串 body 仍可在 Host transport 边界计算 hash。

后续义务：phase 2C-2 负责 opaque shell／sandbox network、`web_fetch` 与第三方 MCP egress；本阶段不证明这些渠道安全。phase 2D 仍需实现本人授权、绑定内容和目标的 disclosure、过期与内容／目标变化后的重新核验。当前 typed seam 没有携带 grant 的分支，任何现有本人／operator 审批都不能覆盖隐藏。phase 2B-2 的 native／paired-owner 义务继续开放。当前验证边界为定向本地回归与 source guard，不能据此宣称真实 provider send、collab-server 部署或 native desktop 验收通过。

保守的可用性限制：没有经验证的持久化 Host execution 的旧 agent／plugin scheduled job 及直接 external-CLI rail 隐藏出站写入；task／model 标签不会凭空生成无 taint 的 service run，恢复这些发送需要 durable Host admission／provenance。共享个人 live frame 还需 server-side audience-revision fence，才能安全地按成员集释放个人内容。既有公开 link 是独立快照，延长有效期不会追溯隐藏旧快照中的内容。

公开 quote-card link 在现有仅接收文本的 builder 无法提供 Host 来源投影证明时也拒绝；本地渲染／下载仍可使用。transcript proof 同时绑定 payload 对象与准确的序列化内容，修改已检查 payload 不能复用原证明。

Notification Center、toast 与 OS 输出在持久化／展示前检查 Host-local 受众；他人的个人内容替换为本地化固定通知，移除携带内容的链接、action 和 metadata。IM 发送单独复核实际收件人。配置为以用户身份发送的 Lark adapter 可能拒绝缺少 run credential authority 的排队固定通知；Host 不会借用其他 run 的凭证或降级身份来强行显示通知。此时受保护的回答仍保持隐藏。

记忆召回标记（2026-11-09）：只按读者过滤召回的记忆还不够——基于个人记忆生成的回复会以无标记状态持久化，之后没有个人读者的消费方可以经由回复读到该事实。现在，带个人标记的记忆被实际注入运行时（召回、procedural 块、项目连续性，以及记忆 agent 工具的搜索与窗口结果），`addPersonalMarksToRun` 会在释放上下文或工具输出之前，把这些记忆的来源标记合并到消费运行及其每个结构祖先上，使用与凭据标记相同的事务和私有 journal 事件；提交失败则不提供该上下文。随后现有的持久化链会为回复加上标记。Workflow `action.memory.recall` 应用同样的读者过滤，webhook 与定时运行（没有个人读者）看不到这类记忆。插件 `ctx.memory.search` 和 MCP `memory_search` 是显式的 `memory:read` 授权，按契约保持命名空间过滤。配对 `sync_pull` 与 Companion `memory_mutate` 的信任问题仍归入尚未完成的 phase 2B-2 owner/member 区分。

Phase 2B（2026-11-08，非 Rust 部分）：可移植纯函数 `withholdForReaders` 对显式及 legacy 标记逐消息过滤，只有当前 root 的每个读者都与每个被标记的人相等时才保留原文，否则以固定英文归属占位符替换整条消息。被隐藏的消息不保留工具结果、附件、标题或任意 metadata。`preparePersonalHistory` 解析 Host identity 与源 session 的 legacy 归属；`preparePersonalDerivedHistory` 为摘要及旧的未证明产物保留祖先／来源标记；消息删除后仍合并源 session 保留的 run 标记，剩余未标记消息不能解除旧派生字段的归属。Host 自有 UI／job 通过显式 owner helper 读取；旧 owner 标题、branch seed、post-compaction instructions 与 generated skill 使用 Host-owner legacy 归属，仍合并已知源 session／run／message 标记。后续模型消费者在 `resolveSendOptions` 或相应 search／reference 边界重新推导来源 taint。其他来源未证明的共享或 replay 产物仍使用不授予任何读者访问的 unverified-person sentinel。过滤覆盖 native SDK、AI SDK（含 standalone browser）、external agent、CLI、Bot／plugin、connector、room、headless person agent，以及 compaction、recent history、branch／Aside／handoff seed、memory recall 与 distillation、search result／reference、recorded skill、延迟 title、eval replay／judging、后台／delegation／plan／teammate／peer 摘要和 shared-memory 读取。CLI suggestion 与 Explore／Plan 历史以及 plugin-session completion replay 均先过滤再展平。模型搜索入口重新检查 canonical 消息及其派生标题，本地 owner 的搜索索引保持完整。本人从 IM 转到桌面继续会话仍可读取自己的历史。phase 2D 的 disclosure 类型接缝没有携带 grant 的分支，不授予任何读者访问；delivery target 与 sink 仍在 phase 2C。

Dev-tip 移植（2026-11-09）：Squad delegation 将 launcher 创建的 child run context 经 `twin-answer` port 传入 twin persona 检索，按实时 root 读者判断可见性。Room hand-off 的 brief 与 result 经审批、outbox 和两种 room delivery lane 保留来源 run；automated turn 没有个人读者，在 embedding 与 dispatch 前过滤。Connector turn 在个人上下文检索前准入 Host identity，准备失败且未 dispatch 时结束该 run；存储的 IM member reply 保留执行标记。Shared-room catch-up 显式按 owner 读取；Host-restart recovery 只读取时间戳并写入固定 notice。模块贡献的 memory 使用 collector 的点分 source key 记录读者 digest。

visibility digest 为 `personal-v1:` 加 SHA-256，输入是排序去重后的规范化读者身份与 withheld message id 集合，不依赖正文、凭据 source 标签或消息顺序。只有当前 withheld-message 集合非空且 retained digest 不同（包括缺失）时才重建。当前没有隐藏消息时，全部 canonical 历史对当前读者可见：升级及放宽为 owner-only 时保留引擎并记录新 digest。Host send 携带 `personalVisibilityHasWithheld`，使 sidecar 使用相同复用规则。无索引字段 `ChatSession.runtimePersonalVisibilityDigest` 由 Host 本地保存，account sync 明确分类为 `local`；external route link 与 durable team child 在 native session id 旁保存 digest。CLI JSONL 的 `meta.runtimeHistory.personalVisibilityDigest` 保存 SDK／AI SDK 恢复身份，external session link 保存外部引擎 digest；sidecar 复用会话前比较 Host 提供的 digest。compact、restore、steer control 同样重新验证可见性；CLI control 先验证已过滤的 live lease，再使用不透明的 Host-owned control token。这些字段是无需查询的运行时身份，因此无需 Dexie version／index 变更。派生 preamble 的 reader stamp 在派发前重新验证，过期则拒绝派发，不重新进入旧引擎记忆。source-scan guard 固定 context／restore 边界，回归覆盖第二人 steer／后续复述、加入 requester 后重建、迁移 connector 旧历史、子摘要洗标记及 owner continuation。

**Phase 2B-2 Implementation status（2026-11-13）。** Rust 按经过认证的 tenant/device 和当前 SecurityStore 推导 paired reader；只有 active owner device 获得 Owner，member、未知设备、revoked/suspended owner、缺 tenant、缺 store 或 store 错误均为 Member。HTTP 与 canonical RPC 已绑定 tenant。唯一无需设备证明的 Owner 是精确的回环 `service` scope（Host 自己的 brain 与 CLI），它本就绕过设备能力检查（`jwt::is_service_scope`）；person child 的 `person-brain` scope 永远不匹配。transport decorator 在共享 bus 完成序列化后写入 Host role，覆盖 client role 字段，不修改 transport-neutral bus struct。五个 paired read arm 均携带此身份。`preparePairedHistory` 保留 owner 原有策略（已知 foreign-person 标记仍隐藏），member、缺失及未知 role 均没有 personal reader；消息页、timeline、turn detail、session title/preview/seed 与冷启动、增量、cursor sync 统一投影。可信 person-brain runtime profile 保留本人隔离 partition 的读取行为，客户端不能选择该 profile。降级 Direct SQLite 无法执行 canonical TS filter，因此以 typed `personal_visibility_unavailable` 拒绝 member，owner read 保持可用。会话存在任意 withheld 行时，media 读取保守拒绝；multi-tenant 部署尚未选择 person partition 时，member binary HTTP/RTC 同样拒绝，避免落入 operator store。

paired update/delete 在写入前拒绝 member 修改或删除其不可见 canonical 行。任何 caller 提交该行的 withheld placeholder（包括嵌入正文和旧 content 输入）均以 `personal_visibility_conflict` 拒绝。generic HostState bridge 同样覆盖 role，并在整个 edit/truncate/session-delete batch 提交前检查；member 不能使用仍铸造 local authority 的旧 orchestration action，但仍可经 `agent_send` 发送。owner turn 保留 local-person 准入；member turn 以没有 `LOCAL_PERSON_RUN` 的 `external-event` 准入，没有 personal reader，不能取得 Lark user token 或 Host sealed provider key。Host 忽略 client history/digest，绑定精确 run，并在 transcript lock 内复用桌面的 canonical-history 准备逻辑。存在 withheld 行且 retained digest 改变或缺失时，builtin SDK/AI SDK 引擎会关闭并从过滤后的历史重建，去掉 resume/fork identity；digest 相同或没有 withheld 行时保留引擎。member resume id 必须对应 canonical engine link。external route 的私有可见性改变时，以 `personal_visibility_changed` 拒绝，因为该 paired sidecar 路径不拥有 external manager 的重建流程。role 与 prepared-options handshake 都是内部 bridge payload，不改变 public request/response schema、command catalog、依赖或 Dexie schema。Rust 编译/测试以及真实 paired-device/provider 验收由外部继续验证；局部 JS 检查不代表这些结果。精确检查与残余项见 `docs/evidence/2026-11-13-adr-0243-phase2b2.md`。

Phase 2A-1（2026-11-04）：个人凭据 admission 在释放凭据前，以同一事务将无索引的 `ExecutionRun.personalMarks` 与私有 `personal.marked` journal event 写入执行 run 及沿结构父链到 identity root 的每个祖先；持久化失败则拒绝 admission。mark event 使用私有 observation sequence（`seq: 0`），不改变 run 状态、control revision、时间、snapshot 或 notification projection。本地 root／Host 直接 UI 使用 `local-person`，Lark IM owner 使用准确授权快照所验证并由 Host 保留的 platform principal。标记按 person 身份与 credential source 去重，保留最早读取时间。run 级标记覆盖工具与 assistant 消息、子任务／队友结果（包括 blackboard、plan 与 delegation）以及承载后台结果的 framed user turn。Host 将自己生成的 message id 绑定到准确 run，持久化时重新读取 Host run 状态，包含延迟 streaming 写入；已有 `metadata.personalMarks` 合并保留，后续 turn 不会抹去旧标记或因同一 session 而误继承其他 run 的标记。暂存云文档附件保守地给附加它的 user 消息写入 `local-person` 标记，保留原有 Host-local credential admission。IM assistant 行实际由共用 SDK event handler（`hooks/chat/claude-chat-events.ts`）写入，而非 `run-and-capture.ts`；HostState builtin dispatch 使用相同的桌面关联写入链，或由 headless terminal-event owner（`lib/work-submission/terminal-events.ts`）写入，headless person agent 则绑定其 action 的 execution。

旧 connector 历史由纯函数 `effectivePersonalMarks(message, session, context)` 在读取时解析：显式标记优先；否则，connector-bound session 中缺少 `metadata.personalMarkVersion: 1` 的消息属于 adapter 经 Host 解析的 bound／connected person，而不是 sender／requester。所有新 connector 行（ingress、普通 full／delta 写入、手动 Inbox 与 paired send）写入该逐消息版本标记；更新时版本仅取自存储行，包括没有 metadata 的旧行；传入 metadata 不能添加或抹去该版本。仅新的 Host-bound 行或从可信同步／导入副本新建的本地行可以获得版本。导入的平台历史没有 Host marking-version 证明，无论本地插入日期如何，均保守归入 legacy 历史。逐消息标记避免 session watermark 在并发 writer 间的竞争，无需 Dexie 升级、时间截点或回填。Phase 2B 调用方须先解析 bound person 再判断旧行。account sync 有意不传输 connector binding，因此导出／读取可携带副本时会实体化旧行的标记：有 connected Lark／Slack 身份时使用该 platform person，较旧 adapter 未记录 connected platform 身份时保守归属于 Host 的 local person；源行不做回填。metadata 冲突合并、旧备份／import／handoff 覆盖与 paired history 更新均保留已经知道的标记，不依赖普通 metadata 的冲突胜负。metadata 随 account sync capture、流式备份／恢复、conversation import、thread handoff（包含 canonical source／target 转换与 sequence digest）及 paired history／projection 保留；execution run 继续遵循其已有表策略。共享协作聊天的 allowlist 不变，属于 phase 2C sink 残余。本阶段仅记录来源：history withholding、engine rebuild 与执行仍在 phase 2B，sink／audience enforcement 在 phase 2C；不提升 schema version，不新增 UI，不引入有意的可见行为变化。

Phase 2A-0 ADR-0246 移植（2026-11-02）：Google OAuth 生命周期仍由 Rust 持有；个人凭证 gate 保护 auth.google Host connection 的凭证读取、可能调用 userinfo 的 native snapshot 与 OAuth completion/device polling，以及 token 撤销。拒绝 disconnect 时保留连接，缺少证明的后台清理不发起 Google 用户调用。缺少证明的后台对账只读取已发布元数据，不发起用户认证 snapshot；Settings、picker、staging 和 dock preview 传入 Host-local 证明，并保持旧 `default` 绑定可解析。Provider 插件在 run 外读取自身 Host-managed session，归类为插件持有的 token 材料，与 `auth:exchange` 一样登记清单并留待 phase 5/6 治理。run 内的 owner 与 consumer 读取以 Host 持有的 tool/command invocation 及其准确 attempt 判定，绝不依赖插件字段。每次凭证读取在首次 await 前固定 proof/读取开始时的身份，后续 invocation 只能收紧权限。只有验证了持久化 parent、plugin owner 和准确 identity root 的 Host 子作业，才可与父 tool binding 重叠；兄弟作业与无关 invocation 仍拒绝。Lazy activation、依赖激活和 fallback command 接收方继承 Host binding；callback 即使超时也保留绑定，直到实际结束。Consumer 在 run 内外的每次非 owner 凭证读取均须有对应 operation grant，run 内还须通过个人凭证判定。Raw Host-managed session 读取不携带 operation grant，不能用 local-person run 或过渡 token-read policy 替代。显式 Bot binding 仍留待 phase 5。保留对账锁、身份传播与作业结算。

Phase 2A-0 Host callback 绑定（2026-11-04）：所有者例外仅适用于 Host 派发之外。每个 Host callback 按实际执行代码的插件绑定身份，覆盖跨插件 interceptor 和 issue-sync provider。现有 invocation 机制保留准确的 Host execution context，或已证明为本人直接 UI 操作的不透明 `LOCAL_PERSON_RUN`，直到 callback 实际结束，覆盖超时、取消竞态与 iterator step。没有 run 的 Host 后台工作使用 `HOST_BACKGROUND`（`executionRunId: ""`），拒绝个人凭证，也不能借用仍在等待的本地 invocation。Host proof 不传入插件参数。定时 issue sync、备份、对账、可见性更新及未关联 execution 的 hook 均不能落入派发外的所有者读取例外。Context 的命令式注册及导出的 contribution/factory 返回值复用该绑定，保留同步返回契约、constructor 和 class receiver。Native Python/WASM 调用、Python contribution stream、VS Code extension callback 和 frontend IDE provider 复用同一绑定，覆盖 transport 实际结束。Host 数据迁移 callback 使用后台 sentinel。RPC 和 library import 在等待同意、激活或加载之前固定发起身份，后来的本地 invocation 不能替换它。Library disposal 属于 Host 后台工作，后续导出方法调用绑定各自本次 invocation。备份 wrapper 在嵌套调用中保留准确操作身份；Host 登录在 authorize、exchange 和 describe 间传递已固定的身份，Settings 操作传入不透明的本地证明。已有的 integration job、tool attempt、workflow integration node、command provenance 与 scheduler executor 保留原有绑定。插件自行启动的 timer、activation 和 panel UI 代码在派发外没有 Host binding；这些插件持有凭证仍是 phase 5/6 的残余范围，不属于 2A-0 已完成的保护。不修改 schema 或持久化字段；未验证真实 provider 和桌面验收。

Phase 2A-0 第 6 轮复审（2026-11-01）：技能确认卡入队携带 dispatcher 已解析的准确 session/run，覆盖子执行路由；未知 run 保持未验证身份。所有者确认卡在原回合结束后仍可通过 Lark send-as-user 准入。批量出站删除在同一事务内结算 execution、删除队列行并记录 Host tombstone，保留已完成执行及其他作业。删除 adapter 和 workspace 复用该路径；companion 的保留期清理、同步 tombstone 及切换 Host 时的清空也复用它，不回传 tombstone，也不结算镜像 Host execution。Host 切换先结算本地作业，再清空 execution 摘要。集成账号删除原已在事务内结算作业，本轮增加回归测试。不修改 schema 或持久化字段；未验证真实 provider 发送。

### Phase 2A-0 批量删除审计（第 6 轮）

| 生产删除/清空路径                                                                                         | 结算方式                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `lib/db/outbound-jobs.ts`：保留期清理及单个 cancel/veto                                                   | 统一 `deleteOutboundJobs` 事务；保留终态结果，取消活动/缺失作业，记录 Host tombstone。                              |
| `lib/connectors/adapter-residue.ts`：`removeAdapterInstance` → reaper 的 adapter/status 复合索引范围      | 统一删除事务，不影响其他 adapter。                                                                                  |
| `lib/db/project-scope.ts`：workspace 级联中的动态 project 表删除                                          | 在包含 execution/event/projection 表的 workspace 事务内调用统一删除。                                               |
| `lib/sync/handlers/outbound-queue.ts`：过期镜像 `bulkDelete` 及 `base.ts` 默认 tombstone 删除             | 均改走统一删除，不回传 tombstone；只有拥有本地私有 journal 的执行才结算。                                           |
| `lib/sync/companion-sync.ts`：切换 Host 时的动态 `clear`                                                  | 先删除出站作业，再清空 execution 摘要；不回传 tombstone。                                                           |
| `lib/db/integrations.ts`：未绑定账号删除，`integrationActionJobs.where("accountId").equals(...).delete()` | 已有事务在删除前结算终态/取消活动 execution；绑定账号的安全记录保留。未发现其他生产 integration-job 批量删除/清空。 |

动态 account-sync 替换仅涉及 sessions、messages、characters、skills、memories 和 settings；plugin 清空仅涉及带命名空间的 plugin 表，均不删除上述作业表。整个数据库重置同时移除作业及 journal；测试 fixture 清空仅用于测试。

Phase 2A-0 第 5 轮复审（2026-11-01）：Connector 派发将 tool IPC 绑定到 Host 创建的当前 journal execution，恢复时使用准确的 `:attempt`；稳定 provider identity 仅用于路由，不参与凭证准入。内置技能及嵌套 agent 派发忽略 wire `runId`。批量投递转发 Host enqueue options；`im.broadcast`、`im.send_voice`、`im.create_chat` 的首条消息及 `im.dispatch_task` 的 brief 复用现有 Host run/session scope 解析，覆盖子执行路由。reroute 在原投递作业结算前继承其准确 execution；持久化地址没有 topic 时也能安全重路由。同一次 UI 操作只有携带不透明 Host 本人准入、account/action/input/key 匹配且原 job 自身记录为 local-person 身份根时，才能继续原集成作业；以其他 run 为根的作业仍要求准确身份根匹配，序列化的 person/source 标签不授予权限。不修改 schema 或持久化字段。回归测试经过真实恢复派发→`sendPrompt`→tool IPC、真实 enqueue→runner→Lark 准入及真实集成入队→审批→重放；未验证真实 provider 发送。

### Phase 2A-0 出站生产者审计（第 5 轮）

完整的 `enqueueGoverned` / `enqueueGovernedMany` 调用文件、别名和依赖注入包装逐项列于[英文清单](../../en/adr/0243-a-run-acts-for-someone-and-says-who.md#phase-2a-0-outbound-producer-audit-round-5)。身份分为：本地 Inbox 本人操作的准确 session 与不透明准入；IM 直接/草稿回复的当前准确 attempt；reroute 在原 job 结算前继承的准确 job execution；usage-status 的 service automation；广播及另外三个 `enqueueAuthorized` 技能生产者的 Host 准确 run/session scope。其余清单条目是没有已验证个人执行的 bot/system 通知，保持未证明的 external-event 身份；投递策略审批不等于个人凭证授权，send-as-user 必须拒绝，不能借 source 或 metadata 恢复个人权限。未知技能 scope 同样明确拒绝，不猜测 session 中的活跃 run。

Phase 2A-0 第 4 轮复审（2026-11-01）：IM 恢复只持久化已验证属于同一 session/source 的父关联；workflow 重试在关联和继承前验证来源 workflow。集成幂等命中在入队事务内核验 account、action、规范化 input 和调用者身份根，覆盖并发命中；身份根未知或不同均拒绝返回缓存输出及派发。已验证的 Bot binding 与 Host 后台审批、重试继续继承原身份；通用本地 UI 准入不能接管已有作业。Squad 挂起发布的成功或失败在同一事务内结算 durable run 和 execution；stop/cancel 保留终态 journal 路径，在等待子执行控制前后使用条件写入，并保留先完成发布的终态；每种终态都释放聊天 settlement watcher。拒绝发布仍保留可恢复的挂起，直到再次批准或停止。

Phase 2A-0（2026-11-01）：Host 的统一个人凭证准入复用持久化执行身份根，并保留 Lark 已有的 IM 所有者例外；身份未知、service、external-event 及未证明授权人的 schedule 均拒绝个人凭证。Host UI 直接操作传递不可由标签伪造的本地个人准入，不虚构 run。Lark send-as-user 的发送和刷新均解析 Host 入队时绑定的精确投递 execution；持久化 source、message 和 card 标签均不授予个人权限。本地 Inbox UI 在入队时传递不透明准入，配对 Inbox RPC 保持未证明身份；定时推送记录未证明个人授权的 schedule，presence 和 escalation 作业记录 service 身份。IM `continue_safely` 的 attempt 及其投递作业继承原始身份根，即使多个 attempt 共用 source message；身份缺失或不是所有者时拒绝，不降级为 bot，并保留原子 token/epoch 快照。自动挂载的 MCP App 从 Host journal 解析工具调用的准确 execution，并额外要求内存中的 Host builtin 派发证明；身份未知、外部引擎或已结束历史的自动读取拒绝 OAuth 并保持未加载。挂载卡片不授予本地个人准入。拒绝时移除 MCP OAuth 服务器及其工具命名空间，外部引擎不接收个人 OAuth 配置，无法验证 MCP 凭证映射时重建保留的 AI-SDK 上下文。集成 HTTP 读写及内置 Issue Loop 的 git 凭证在 provider/connection 解析之前执行同一准入；user connection、旧 PAT/OAuth provider 及未分类的旧 provider 视为个人凭证，已验证的 bot/service connection 和 Host GitHub App installation provider 保持服务身份。GitHub 的隐式 PAT 与 `gh auth token` 回退缺少准入时拒绝。延迟集成任务在入队事务中创建独立 execution，继承精确身份根，审批和重试期间保持可执行，任务终结后再结算；`actor: person` 不授予凭证。作业终态与 execution 结算在所属 DB 的同一事务中完成，覆盖出站删除/veto、异步 receipt、队列上限、集成取消及过期 claim 恢复。策略拒绝不创建存活 execution；启动 drain 对账终态或已缺失的作业，并保留审批等待与重试中的执行。无 session 的独立 local-person Squad 可通过明确 execution id 准入；传入 session 时仍校验归属。Squad 发布或挂起在真实 lifecycle 的 completion hook 中完成，早于 durable/execution 终态结算；Aside OAuth 准入仅根据所有回退后的最终 runtime 判断。凭证清单覆盖 Lark auth snapshot 的直接调用、别名及 native command，并明确登记账号设置及已准入的 token/epoch 检查。不新增持久化字段。操作者明确选择的 Bot `credentialBindings` 本片不变，其 bound-person 同意、范围及 `needs_setup` 迁移属于 phase 5。文档 provider、twin API/CLI 导入、Lark user HTTP 和连接器隐式个人 token 探测统一准入；未证明个人授权的 Slack presence token 同样拒绝。调用插件前剥离 Host 准入证明。ADR-0246 的 Host user connection（含 Lark）、Host-managed user session、备份 GitHub PAT 和 Drive OAuth 均使用同一准入；手动备份 UI 传递 Host 证明，未证明个人授权的 schedule 拒绝，已验证的 bot/service/app connection 保持服务身份。`auth:exchange` 不释放 Host 保存的个人 token：授权码或 refresh token 由插件提供，Host 仅注入该插件配置的 client secret（service），插件持有的用户 token 材料留待 phase 5/6 治理。不修改 schema 或持久化字段；个人内容标记留待 phase 2A-1。

Phase 2-0b（2026-10-31）：Bot 按 installation/topic 使用有主 app transcript，持久化普通用户消息、回复和引擎 resume id，并在同一事务内按 transcript generation 校验最终回复与 resume 写入；plugin 同样持久化。独立、非索引的 `imAuthorityBinding` 传递给根会话及子会话的 skill 权限检查，不向 composer、Inbox、历史加载、projection 或配对同步暴露 delivery binding。Connector 的索引与旧记录、活动会话与私聊线程、兄弟会话、链接及 group context 查询继续隔离所有权。外部发送者仍是 event actor；Lark 显式使用 app/service-data 身份，在最终工具结果标明身份，个人及仅支持用户身份的操作说明 phases 4 和 5。无人值守写操作继续使用 approval park 并暂停 wall clock。Connector 确认回调创建 Host run 并传递精确 execution id；requester 重放记录点击者，Bot/plugin 重放保留原 service lane。未修改 Dexie schema。重试复用 delivery/step 对应的用户消息，保留独立 attempt id，重建历史时排除当前消息；capture owner 复用既有转换器保存 SDK/external 工具及 A2UI 完整 parts。QQ 确认回归覆盖原 run 已结束或缺失的场景，测试 fixture 补齐生产环境已有的 runtime translator。Fixes 3–5（定向回归已验证）：打开的 Bot/plugin pane 按已提交的 transcript revision 刷新，旧视图的全量写入沿用 connector 规则保留遗漏行。投递目标复用 `deliveryTargetFromEvent`，按事件的结构化地址与 source message 校验，不再解析 conversation key；topic session key 仍为 installation 加事件原始 conversation key，兼容仅保留 target 的旧队列事件。媒体在受 generation 校验的回复事务前完成准备；有效的 SDK image/file 与 external artifact 内容可完成纯媒体 capture，空媒体不能。Lark 独立于 IM binding 解析 run identity：外部事件、定时任务及无 binding 的 run 默认显式使用 bot/service-data，已绑定 IM 会话中的 requester 仍默认走经过 owner 检查的委托身份，local desktop 默认行为不变，显式 user-only 请求保留原个人权限检查；binding 仍约束 adapter 选择。 并发首次触发按 caller、installation/topic key、character、cwd 和 IM authority 锁住查找与创建，再按实际 session id 串行执行完整 turn。同源 Web Locks 覆盖窗口及 worker；内存回退仅覆盖单个 realm，确定性、仅插入的 session id 保证跨 context 创建幂等，显式更换 cwd 后使用新的确定性槽位，无需修改 schema。无 binding 的 Bot/plugin 子会话继承根会话持久化的无人值守 approval park，审批未决时不能成功完成。Middleware 转换后的文本替换捕获的原文及其派生 codeblock surface 和引用，保留工具、媒体及非原文派生 surface；过滤后无其他内容的回复沿用 capture 的空回复拒绝规则。提交过滤结果前使旧引擎上下文失效，后续 turn 从 canonical history 重建。 后续复审修复以不透明、绑定具体请求的人工批准凭据区别于自动 permission allow；子会话完整继承交互根会话确认卡或无人值守根会话 park。桌面 send/regenerate/edit/steer 尊重 capture 占用状态，并与 Bot/plugin 共用整会话 admission。Operation completion 在既有 recovery journal 中与回复原子提交，按 operation namespace 加锁，重放时不再调用模型，并按原始 booking 与 cost authority 补齐 lifecycle/usage settlement。内部 fallback/plan/steer 续跑保留已有 turn lease，独立 trigger 必须重新取得 admission。删除会话、清空或删除消息及截断 transcript 时移除 completion 内容副本并保留不可重放的 tombstone。Fixes 8–9：会话自身进行中的 turn 里追加的内容进入 steering 或队列；因其他 owner 占用而被拒绝的发送会抛错，Composer 保留输入。逻辑用户行在派发前、最终提交内和失败时都要校验（存在、属于同一会话、角色与内容不变）；用户行变化时 turn 以终止且不可重试的取消结束。admission 时与用户行一起写入 pending operation 记录，用户行被删除时该记录变为 tombstone，重试不会复活已删除的 prompt。桌面所有主动删除都显式传递 delete id，其他写入方产生的未知行在旧视图全量写入时仍被保留。Stop 持有会话 lease 直到 interrupt 命令完成，迟到的 interrupt 不会命中下一个 turn。后台子任务保留绑定原始 run 的审批路由，父 turn 结束后自行建立 durable park，只有人工批准才能满足。middleware 未派发给引擎就给出的回复视为引擎历史已过期：不保存 resume id、不确认 invalidation，下一轮从存储的 transcript 重建。Stop 若在发出 interrupt 前失败，会撤销其 admission 屏障。永久删除 workspace 时在同一事务内把其会话的 operation completion 变为 tombstone。SDK 或 HostState turn 收尾时决定的 steer 续发及下一个 plan/goal/loop 步骤，即使原派发尚未返回，也只沿用处理该事件时持有会话的那个 lease；若会话已被其他 turn 取得或 Stop 尚未完成，则重新取得 admission，延后执行的步骤总是重新取得。仅在同步执行 steer 续发期间持有该 lease，清空队列触发的嵌套 store 通知不会在续发接管前释放它；不会跨越处理函数中的等待（如 goal judge）持有，新消息仍可接管。无论桌面 lease 是否仍在，Stop 都在首次 await 前为共享会话 admission 设置屏障，直到 interrupt 完成或 Stop 于发出 interrupt 前失败：非阻塞的桌面 admission 与续发被拒绝，排队的 Bot/plugin turn 等待，包括 Stop 开始时已持锁的 turn 之后及多次重叠 Stop 的情况；共享 Web Lock 把屏障带到其他窗口，途中的同步异常不会让屏障残留。每个 lease 在整个生命周期内独占 stop 屏障，任何窗口的 Stop 都排在运行中的 turn 之后，并先于后续 admission 获得共享屏障；每个待完成的屏障只持有一个共享锁，直到最后一个重叠 Stop 完成；排队的生产者让位于在其后申请的 Stop，加入已有 lease 时检查其他窗口的 Stop，admission 时固定目标会话，等待过的生产者重新校验账户数据库。已派发但未提交的 turn（失败或用户行变化）会使引擎上下文失效，下一 operation 从存储的消息重建；即使关闭运行中的 runtime 失败，也会在该 turn 所属数据库写入持久失效标记。残余（既有行为，本次未改变）：Stop 不会取消仍在派发前异步准备阶段的桌面发送。completion 保留其 prompt 与回复的消息 id 及这些行的摘要：删除或截断其他消息不影响重放；任一行缺失或被任何写入方改动（包括不写 tombstone 的 plugin repository 与直接表访问）时拒绝重放。

Phase 2-0 fix 9（2026-10-31）：Lark 个人 token 现在要求执行工具的 run 所记录的 identity root 同时具备 `trigger: local` 与 `local-person` authorizing principal；既有 IM owner 检查不变。会话 binding、creator 标记与 plugin 调用上下文仍只能拒绝，不能授予权限。Host 发送时将既有 IPC turn/attempt 绑定到准确 run；未知关联拒绝，没有关联时要求所有 kind 中恰好一个活跃 run。identity、root、读取缺失或 account/target 切换均拒绝。子任务继承固定 root。Host 使用内存 symbol 授予本地入口证明，调用者提供的 origin 不能制造 local 权限。已认证的 paired chat 与手动 Squad UI 操作代表配对用户，获得相同 Host 证明；remote Run API 不获得。保留 account sync creator 字段及 schema bump。非可信 native/model 内容会移除 run-control 路由字段；bus 独立要求持久化的 Host run-card binding，并匹配 adapter、conversation 与平台 message。伪造回调不能占用真实卡片的去重键。

### Fix 9 writer 审计

| Writer                                                                | Trigger                                                                      | 原因                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `direct-chat-run.ts`                                                  | 仅 Host 证明为 `local`，否则 `external-event`                                | 桌面发送、编辑、重新生成和手动排队消息携带证明；自动续跑不能创建证明。                                                    |
| `acting-authority.ts:startToolExecutionRun`                           | Host `local`、继承 root 的 `child`，否则 `external-event`                    | slash command 与本地 room member 的最小入口记录；前后台工具子任务继承准确记录的 parent。                                  |
| `work-submission/service.ts`                                          | 获证明的 `local`、connector `requester`、内部 `child`，否则 `external-event` | Chat adapter 转发证明；已认证 paired-turn 与 HostState chat 入口签发证明，source 标签与 remote Run API 输入不能。         |
| `squad-run-records.ts`                                                | 获证明的 `local`、继承的 `child` 或按 origin 分类                            | 桌面手动 Start、手动 `/squad`、已认证 paired 手动 Start 签发证明。Plugin `runTeam` 强制 plugin origin，传入 `ui` 也无效。 |
| `agent-team-bridge.ts`、`durable-runtime.ts`、`legacy-run-history.ts` | `requester`、`schedule`，否则 `external-event`                               | Origin 投影不能创建 local 证明；已有 canonical run 保留其固定 identity。                                                  |
| `workflow-bridge.ts`                                                  | `requester`、`schedule`、`child`，否则 `external-event`                      | 类似手动的 origin 不足以证明用户，包括自动启动的 workflow。                                                               |
| `agent-state-bridge.ts`、`delegation.ts`                              | `requester`、`schedule`，否则 `external-event`                               | 无 binding 的 goal、plan、delegation 不推断本地用户。                                                                     |
| `bot/runtime/run.ts`                                                  | `requester`、`schedule`，否则 `external-event`                               | Bot 的 manual/desktop trigger 仍属于 Bot 自动化。                                                                         |
| `security-scan-bridge.ts`、Fusion `outbox-appliers.ts`                | `external-event`                                                             | Plugin scan 与调用者提供的投影 origin 不能制造证明。                                                                      |
| `connectors/runtime.ts`                                               | `requester` 或继承的 `child`                                                 | 来自 inbound sender 或明确 recovery parent。                                                                              |
| `job-bridge.ts`、`managed-desktop-results.ts`、`db/execution-runs.ts` | 继承 root 或未证明的 `child`                                                 | 仅记录中的 parent 传递 identity；缺失 parent 不授予 local 权限。                                                          |
| `unattended-park.ts`                                                  | `schedule` 或 `child`                                                        | 私有入口调用者仅为 schedule 或继承的 unattended 工作。                                                                    |
| `recordRunAuthority`                                                  | 不变                                                                         | 仅收紧记录的 ceiling，不创建 identity 或 local trigger。                                                                  |

### Fix 9 合法个人使用路径

- 桌面 chat 发送、编辑重发和重新生成创建获证明的 direct-chat run。自动 goal、loop、background delivery 使用没有本地证明的核心发送函数。
- 活跃 turn 中手动排队的消息在内存中保留证明直到 drain。混合队列或重启恢复后缺少证明时拒绝个人权限；用户明确重新发送可建立新 run。
- 前台与后台子任务使用准确 caller root；IPC 关联指向 canonical job run。
- 本地 team conversation member 在 dispatch 前建立最小本地入口，并在 cleanup 时结算。
- 桌面手动 Squad Start、composer 启动的 Squad、手动 `/squad` 与已认证 paired 手动 Start 创建获证明的 Squad root，teammate 继承它。
- 手动 `/lark` 已接入 Host composer 并建立最小本地入口；model/plugin slash 调用不能提供 symbol。
- 桌面 skill 使用 tool IPC 入口及准确 run context，plugin skill 不能借用桌面会话。已认证 paired chat 与 room UI 采用同一用户授权判断。

验证：42 个改动相关 suite、1573 个测试通过，覆盖持久化 run、实际 sync/branch/fork 路径、生产 callback codec 与完整 bus dispatch 回归。最小 Host 入口与首条 journal event 原子提交，入口失败不遗留活跃权限记录。验收限制：必跑的既有 `lark/auth-bridge.test.ts` 正向 fixture 没有 execution run，且不在允许修改的 Lark 文件集合中；已安装 Lark CLI dry run 需要当前不可用的 keychain，现有依赖图也缺少 package。扩展 plugin 检查还报告了范围外 `public/_cognia/builtin-plugins/` 中缺失的 staged artifact，以及未改动的 compatibility/catalog 测试失败，随后进程耗尽 Node heap。未声称真实 provider 或 native UI 验收通过。

Phase 2-0 fix 8（2026-10-31）：原生回调清理新增 WeCom `button_list[].key` 与 QQ 回调 `action.data`，同时覆盖 Lark `value.actionId`、Slack `action_id`/`callback_id`、Discord `custom_id` 和 Telegram `callback_data`。回归使用真实 serializer 与 callback parser；Slack、Discord、Telegram、WeChat、DingTalk、Matrix、OneBot 按既有契约降级或拒绝 opaque card。WeChat personal 数字回复与 QQ C2C 回调保留可信发送者地址；WeCom 私聊缺少 `chatid` 时使用 `from.userid`，不放宽会话权限检查。Lark/Slack 回调缺少聊天地址时仍无法证明权限；Discord 要求 channel，Telegram 要求锚定消息。account sync 在 `SYNC_SCHEMA_VERSION = 2` 下保留 `programmaticCreator`（遵循 ADR-0215 的版本超前暂存规则）；固定版本的 `@cognia/sync-protocol` 接受正整数 schema version 与任意带时钟字段，因此无需修改 cognia-services wire contract 或更新 pin。paired-Host 投影、备份恢复、会话重新导入、shared 转换保留非本地来源；旧备份覆盖和重新导入不能抹去已知标记。同步或恢复后的 plugin 根会话仍拒绝个人权限通道。无需 Dexie 版本变更；真实 provider 投递尚未验证。

Phase 2-0 fix 7（2026-10-31）：Host 的 workflow/fan-out 审批从触发会话解析完整 conversationRef 与 deliveryTarget，保留 topic 锚点，缺失地址时拒绝发送。血缘解析通过 Host codec/route 穿过无行成员与已清理的中间节点，并验证根行、冲突、循环和深度。scheduler 的任务及执行输入持久化、`im-push` 与延迟 `connection:outbound:send` 发送均清理 model/tool 的回调提示与命名空间值；digest 回复沿用相同清理。fan-out 目标必须同时匹配绑定和点击会话。确认绑定保存调用方 session、workspace root、project 与 character；重放重新读取根 IM 权限并核验点击者，子行清理后 Lark 个人令牌检查仍使用根权限。无需新增索引或 Dexie 版本。本地回归覆盖生产 Lark/Telegram serializer，尚未验证真实 provider 投递；缺少执行快照的历史确认仍沿用其记录的根上下文。

Phase 1A 在 `ExecutionRun` 上以 observe mode 记录执行身份和已解析的运行权限。凭证选择和既有拒绝逻辑保持不变；权限修订不匹配只记录私有事件，不阻止执行。子运行保留父运行的固定身份（包括原始触发类型）；父身份不可用时记录 `child` 触发类型，不推测主体。权限强制执行和共享预算池记账仍属于后续阶段。

新身份通过 `rootRunId` 标记根运行；子运行保留创建时的身份快照，实时观察和发起人吸收则读写根运行。元数据记录不改变 `updatedAt`，相同值不重复写入，并随运行的下一次实际更新同步到其他设备。缺少已知人工来源的自动入口记录为 `external-event`。

Phase 1B 按用途（`transport`、`service-data` 或 `adapter-admin`）标记每次 tenant-token 使用，不改变凭证选择或请求行为。

Phase 2-0 关闭子会话绑定和模型伪造绑定漏洞：子会话技能继承根会话的 IM 规则，模型及工具表面移除回调绑定提示，仅 dispatcher 签发的绑定可以确认技能，conversation scope 回调要求双方提供匹配的 key。飞书个人授权必须通过本地桌面会话根的验证或既有 IM 所有者检查；没有会话的 Squad 运行保留非个人技能，个人授权标记为未验证。Phase 3 将通过持久化的运行身份恢复本地启动的 Squad 的个人授权访问。

### Phase 2-0 fix 6：Host 卡片与会话创建审计（2026-10-31）

工作流运行和 fan-out 审批由 Host 在记录绑定后通过 governed delivery 直接发送。两个 API 都重新读取指定 session 的 IM origin，拒绝目标不匹配，并只使用 Host 的实时 initiator。workflow-ai 始终提供当前 tool session；插件选择已有 IM session 的边界仍由既有 `connectors:send` capability 决定。workflow-ai 只返回 `sent: true` 确认，不返回 `surface`，并要求模型不要重新发送卡片。`prepareWorkflowApproval` 保留原有返回字段以兼容契约；模型转发信任注册表、issuance window 和异步投影均已移除。模型及工具卡片的全部 `binding*` 提示和带命名空间的回调值均会被剥离，包括未知前缀；Host 直接构建的卡片保持有效。插件不能登记 dispatcher 专属的 `skill_invoke` 绑定。

确认绑定保存持久化 ROOT session id。子会话和审批路由删除后，点击仍从 ROOT 恢复 IM binding，并使用点击者作为 acting sender。持久化的本地 team 根会话与本地 direct 会话采用相同 personal-lane 证明；没有会话的 Squad runtime 仍未验证。`programmaticCreator` 为非索引字段，不需要 Dexie version bump，也不授予 `runPluginAgentTurn` 所有权。

以下表格覆盖 `lib/`、`hooks/`、`components/` 中的聊天会话 `createSession` / `sessions.add` 调用，以及追踪中涉及的生命周期适配器和 Host/shared 投影；technical identifiers 与英文版一致。

| Entry point                                                                             | Classification                                  | Durable proof / delegation                                                                                      |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `lib/plugin/agent-sdk/session.ts` — `createPluginAgentSession` / resume                 | programmatic, marked                            | `plugin-agent-sdk`; resume stamps legacy rows before another send                                               |
| `lib/ai/agent/agent-executor.ts` — temporary tool session                               | programmatic, marked                            | `plugin-agent-executor`                                                                                         |
| `lib/plugin/api/session-api.ts` — `ctx.session.createSession`                           | programmatic, marked                            | `plugin:<id>`; awaited durable row and cache use the same id                                                    |
| `lib/plugin/api/session-seed.ts` — `startSeededSession`                                 | programmatic, marked                            | `plugin-seed`, including workflow session nodes                                                                 |
| `lib/plugin/api/agent-turn.ts` — owned agent turn                                       | programmatic, marked                            | Existing `agentTurnOwner`; creator markers grant no adoption rights                                             |
| `lib/workflow/nodes/teams/index.ts` — character-send session                            | programmatic, marked                            | `workflow`                                                                                                      |
| `lib/ai/agent/team/teammate/dispatch-teammate.ts` — tool-enabled teammate               | programmatic, marked                            | `team-teammate`; registered run ancestry still resolves the root                                                |
| `lib/ai/eval/targets/chat.ts` — default evaluation dependency                           | programmatic, marked                            | `evaluation`                                                                                                    |
| `lib/agent/composition/verified-fresh-agent.ts` — verification session and DB adapter   | programmatic, marked                            | `verification-agent`; adapter forwards the seed                                                                 |
| `lib/harness/runtime/editor-runner.ts` — agentic editor                                 | programmatic, marked                            | `harness-editor`                                                                                                |
| `lib/harness/runtime/probe-runner.ts` — probe, surface discovery, DB adapter            | programmatic, marked                            | `harness-probe`; adapter forwards the seed                                                                      |
| `lib/best-of-n/runtime.ts` — candidate rows / `sessions.add`                            | programmatic, marked                            | `best-of-n` on the shared native/external candidate row                                                         |
| `lib/scheduler/executors/index.ts` — scheduled chat/team                                | programmatic, marked                            | `scheduler`                                                                                                     |
| `lib/scheduler/executors/goal-executor.ts` — scheduled goal                             | programmatic, marked                            | `scheduler-goal`                                                                                                |
| `lib/integrations/events.ts` — projected inbox thread                                   | programmatic, marked                            | `integration-event` and existing `integrationBinding`                                                           |
| `lib/connectors/session-bindings.ts` — `createPlatformSession` / `sessions.add`         | programmatic, marked                            | `connector` and existing `platformBinding`                                                                      |
| `lib/connectors/commands/dispatch.ts` — both command creation branches                  | programmatic, marked                            | Delegates to `createPlatformSession`                                                                            |
| `lib/db/background-tasks.ts` — admitted persistent child / `sessions.add`               | programmatic, marked                            | `background-task` plus parent/attached-child ancestry                                                           |
| `lib/sync/host-state-store.ts` — `session.create` and `session.import` / `sessions.add` | programmatic, marked                            | `host-state` on both rows                                                                                       |
| `lib/browser-companion/service.ts` — agent/session creation branches                    | programmatic, marked                            | `browser-companion`                                                                                             |
| `lib/browser-companion/host-dispatch.ts` — production session adapter                   | programmatic, marked                            | Stamps `browser-companion` at the Host boundary                                                                 |
| `lib/files-library/remote/host-dispatch.ts` — new attachment conversation               | programmatic, marked                            | `remote-files`                                                                                                  |
| `lib/router-fusion/api/run-api-host.ts` — session port                                  | programmatic, marked                            | `run-api` and existing gateway `origin`                                                                         |
| `lib/skills/recording/controller.ts` — controlled trial                                 | programmatic, marked                            | `skill-trial`                                                                                                   |
| `lib/dev/expose-test-globals.tsx` — anchor/performance and staged fixtures              | programmatic, marked                            | `dev-fixture` on both creation branches                                                                         |
| `lib/project-coordinator/thread-session.ts` — thread creation adapter                   | programmatic, marked                            | `project-thread`, then attached-child ancestry                                                                  |
| `lib/db/sessions.ts` — `createSession`                                                  | trusted desktop UI entry / programmatic, marked | Shared persistence primitive; retains the caller seed verbatim                                                  |
| `lib/db/sessions.ts` — `forkSessionFromParent`                                          | trusted desktop UI entry / programmatic, marked | Inherits creator/owner/origin/integration provenance; legacy IM/shared/default-plugin forks get `nonlocal-fork` |
| `lib/chat/start-session.ts` — `startNewSession`                                         | trusted desktop UI entry / programmatic, marked | Shared lifecycle owner; preserves `programmaticCreator`                                                         |
| `hooks/chat/use-sessions.ts` — `create`                                                 | trusted desktop UI entry                        | Forwards the explicit new-conversation seed                                                                     |
| `components/desktop/desktop-chat-workspace.tsx` — New Team Conversation                 | trusted desktop UI entry                        | Persisted unbound `kind: team` root; member ids decode to it                                                    |
| `components/goal/goal-quick-create-dialog.tsx`                                          | trusted desktop UI entry                        | User submits a goal                                                                                             |
| `components/onboarding/flow.tsx`                                                        | trusted desktop UI entry                        | User selects the first task                                                                                     |
| `components/settings/chat-templates-section.tsx`                                        | trusted desktop UI entry                        | User chooses a template                                                                                         |
| `lib/files-library/use-in-chat.ts` — `resolveUseInChatTarget`                           | trusted desktop UI entry                        | User sends a selected file to chat                                                                              |
| `lib/pet/chat/seed-main-chat.ts`                                                        | trusted desktop UI entry                        | User hands pet text to the main-chat draft                                                                      |
| `lib/shell/start-guild-conversation.ts` — both new-conversation branches                | trusted desktop UI entry                        | Explicit shell agent/team conversation actions                                                                  |
| `components/workspace/workspace-recent-conversations.tsx`                               | trusted desktop UI entry                        | Workspace new-chat action                                                                                       |
| `components/providers/initializers/selection-toolbar-initializer.tsx` — both branches   | trusted desktop UI entry                        | Selection-toolbar handoff                                                                                       |
| `components/settings/data/webdav-sync-card.tsx`                                         | trusted desktop UI entry                        | User requests setup help                                                                                        |
| `components/data/export/schedule-card.tsx`                                              | trusted desktop UI entry                        | User requests cloud setup help                                                                                  |
| `components/settings/agent-runtime/sdk-session-manager.tsx`                             | trusted desktop UI entry                        | User explicitly continues a native SDK conversation                                                             |
| `lib/ai/agent/external/session/open-native-session-in-chat.ts` — chat adapter           | trusted desktop UI entry                        | User explicitly continues a selected native agent session                                                       |
| `components/providers/initializers/tray-panel-initializer.tsx`                          | trusted desktop UI entry                        | Tray handoff                                                                                                    |
| `components/providers/tauri-provider.tsx`                                               | trusted desktop UI entry                        | Launch new-chat action                                                                                          |
| `hooks/system/use-tauri-events.ts`                                                      | trusted desktop UI entry                        | Native new-chat menu event                                                                                      |
| `hooks/agents/use-start-agent-chat.ts`                                                  | trusted desktop UI entry                        | User starts an agent chat                                                                                       |
| `hooks/codeserver/use-code-server-chat-bridge.ts` — staging session                     | trusted desktop UI entry                        | Editor handoff stages selected diagnostics/files                                                                |
| `components/chat/message-im-actions.tsx`                                                | trusted desktop UI entry                        | Continue quoted IM text locally, staged for the operator                                                        |
| `components/chat/composer.tsx` and `components/chat/composer/bottom-toolbar.tsx`        | trusted desktop UI entry                        | Composer launch/runtime choices                                                                                 |
| `components/agent-builder/agent-builder-setup.tsx` — session adapter                    | trusted desktop UI entry                        | User opens the agent builder                                                                                    |
| `lib/project-coordinator/coordinator-session.ts`                                        | trusted desktop UI entry                        | User enables/opens the workspace coordinator                                                                    |
| `lib/slash-commands/actions/issue.ts`                                                   | trusted desktop UI entry                        | User opens an issue conversation and stages its prompt                                                          |
| `lib/slash-commands/actions/sessions.ts` and `lib/slash-commands/builtin.ts`            | trusted desktop UI entry                        | New-chat actions delegate to the host UI callback                                                               |
| `lib/collab/shared-chat-sync.ts` — shared row projection                                | programmatic, marked                            | `shared-chat`; legacy `collaboration` also refuses local personal authority                                     |
| `lib/sync/host-state-service.ts` — new summary rows                                     | programmatic, marked                            | `host-state`; existing rows retain their original provenance                                                    |

同名的 browser、external-engine、CRDT、OAuth session API 不创建 `ChatSession`；`lib/usage/` 和 external manager 中的 `sessions.add` 为 `Set.add`。分支和 aside 保留 `parentSessionId` / session `surfaceBinding` 根链路；editor/resource workbench 属于桌面 UI 入口。此审计没有修改 import/restore writer。

**剩余风险。** 默认标题、`agentTurnOwner`、`origin`、`integrationBinding` 可识别的旧插件会话不会获得本地 personal authority。经 plugin agent SDK 恢复时，Host 在继续执行前补记缺失标记；SDK fork 保留已知非本地来源。旧插件会话若使用自定义或修改过的标题且没有剩余来源字段，在经 SDK 恢复之前仍无法与桌面会话可靠区分；没有批量改写旧记录。队列与绑定测试不代表真实 IM provider 交付验收。

**生成契约。** 使用 `scripts/plugin/generate-contract.mjs` 生成 Rust CLI catalog、Python contract、TypeScript resource effects、plugin-point catalog 和 plugin-dev API reference。沙箱禁止 tsx CLI 的 IPC socket，因此通过 `node --import tsx` 启动其子任务并调用同一 `generate` 导出完成生成和检查。已执行包含 codeserver extension NLS 的 `pnpm i18n:build`。另一会话暂存的 `crates/cognia-cli/assets/author-types.json` 未修改也未重新生成；其中尚无 `prepareFanoutApproval`，reviewer 后续执行 `pnpm author-types:bundle` 会加入该方法和 `sent` 返回字段。

Phase 2C-1 第二轮复核（2026-11-10）：会话标题、状态/错误、目标输出、自动提案和共享摘要使用该会话所有显式消息/run 标记及其结构祖先的并集，不使用旧数据的推断归属，也不选择环境中的活跃 run。已验证通知来源合并后保留实时并集；未知来源仍为未知。排队投递持久化原始来源供重试检查。Host 存储、配置、传输生命周期通知显式归为后台服务；Issue/site 通知采用该分类的前提是带标记的内置技能、插件及工作流写入均在持久化前被拒绝。Phase 2A-0 个人凭据仅属于 Host owner，因此未知来源可显示在 owner 本地 feed/toast/OS，已知外部人物标记仍被投影。Phase 4/5 开放其他人的个人访问时必须重新审视此前提；配对成员设备属于 2B-2，不等同本地 owner。Fumadocs 内容集合之外的`docs/evidence/2026-11-10-adr-0243-phase2c1-caller-inventory.md`记录已恢复来源与真实剩余缺口。 IM 命令回复（`/status`、`/character`、`/team`、`/workflow`）中的角色、团队、工作流和规则名称属于 Host 配置标签，按 Host 后台内容分类；残余风险是带标记的运行自己写进配置的名称，本阶段不追踪。

Issue 创建确认使用独立 Host proposal source 记录，在点击时核对原草稿、项目、会话并重读来源标记；组件/model payload 不能提供该证明，旧提案缺失证明时拒绝。重路由保留 session/composite 来源；派生会话沿 canonical parent 读取显式标记。

Fix7 terminal lease 仅在成功 child wait 或既有 PTY 确认退出事件后释放。私有 headless kill 传播错误、有界等待，并返回 exited／stillRunning／unknown；仅 exited 释放 Host lease。wait 失败不产生退出证明。one-shot、consent、workflow 取消时晚到的 spawn 及显式 close 均使用这一生命周期。私有 headless 自然退出由下一次有界 close 确认，在此之前保守保留 lease。当前沙箱无法写入指定共享 target 目录，Rust 验证因此 blocked；JavaScript 局部测试不能代替原生编译或实际进程退出验收。当前结果及残余边界见 phase2C2 evidence ledger。

### Phase 2C-2 fix9：明确标记、持久 binding 与退出证明

插件没有个人 reader。Transcript 读取和订阅使用 engine 相同的 phase 2B effective visibility，包含 Host message-to-run 归属及消息写入后新增的 run 标记。Session id、标题和时间戳保持原值；明确带标记的 transcript seed 执行投影。IM history 解析 canonical stored message，attachment grant 保留所属 message。插件驱动的 run/tool 结果仅在对应 Host run 确知带标记时 withheld；缺少 provenance 本身不会触发 withholding。Artifact、canvas、editor/terminal data、日志及 events/bus payload 保持不变：派生 artifact 投影属于 2C-2 之外的残余风险，任意文件系统数据也未建立文件级来源。

清洁 sandbox 多轮交互复用原 binding fingerprint，不纳入每轮 run id。Binding 一旦被 tainted run 使用，在 record 重建和 consumer pruning 后仍保持 network-off（无法证明该能力的 tier 则拒绝），直至 session/workspace binding 被销毁。单一 run 的插件 callback cache miss 不会记录 exposure；异步内容交付等待 canonical read，同步 callback 保持返回形状，仅在明确证明标记后记录到捕获的 activation。Cold composite callback 尚需展开 canonical producer 才能完整执行此规则。Fresh external-tool facade 也仍需绑定调用方 Host 来源或证明上游 gate；这些 fix9 未完成项记录于 evidence ledger。

External chat capture、person-agent replay、best-of-N、scheduler 和 remote Host turn 绑定真实 Host run。恢复 external session 保留已消费来源，未绑定新 run 的 fleet continuation 不得清除此来源。Remote transport correlation id 不等同 execution row。

One-shot timeout 和异常返回通过 blocking thread 执行 kill proof，在有限 operation 结束前把未确认 session 身份转交 TS process lease。只有成功 child wait 证明退出。Wait 失败停止后续信号发送，但仍报告 Unknown。有界原生退出记录（TTL 十分钟，上限 1024 条）在旧 registry 立即移除后保留。One-shot session 不出现在 managed-process snapshot；旧 kill/kill-all 保持不等待语义，src-tauri 未修改。

Terminal proof 仅覆盖 shell，detached descendants 仍属 phase 3 隔离工作。本地测试不代表 provider/firewall 验收。此版本的 Rust 测试和 tauri-host 编译由外部 verifier 执行，evidence ledger 区分外部结果与本地检查。

### Phase 2C-2 fix10：补齐组合来源与外部运行绑定

插件冷缓存组合回调会展开所有不透明或显式 producer，在交付内容前等待读取 canonical marks。缺失来源不会记录曝光。曝光缓存与“来源未知时拒绝外发”分开，缺失 run 的拒绝不能变成插件永久曝光。若读取另一来源期间已有 producer 新增 marks，正向证据读取器会按当前依赖重新读取。普通同步回调保持原有返回形态；冷缓存组合交付在证据就绪前返回 Promise。

生产 external-tool getter 接收并传递调用方的 Host personalSource；原生 external session id 不能建立 run 权限。manager 在执行工具前合并该来源与会话保留来源。getter 测试使用真实 canonical run；person-agent runner 测试使用真实 manager 与 canonical history：clean replay 不变，marked ACP 在交付前拒绝，marked Codex 携带 network-off metadata。message、metadata 与 settle outcome 均在后续工具复用前断言。chat 和两个 best-of-N 交付点均补齐来源绑定 co-test 与可逆 without-fix 证明。

fix10 brief 提供了 fix9 后独立验证的336个 cognia-terminal 测试和 tauri-host check 通过结果。fix10 未修改 Rust 或 sidecar；该结果取代此前 native 验证阻塞，以及 fix9 的 Q3/Q4 后续项。evidence ledger 保留本地验证的准确结果，并区分 adapter policy 测试与真实 provider/OS 验收。派生产物、任意文件系统来源、脱离 shell 的后代进程和 provider/firewall 验收仍遵循前述阶段边界。

Phase 2C-2 fix11：ctx.agent 的所有可调用 runner 返回值都经过个人读取投影，并绑定真实 Host 子运行。正常 one-shot 先释放 PTY，再等待真实子进程退出；存活 shell 仅保留轻量进程记录，以 managed 状态显示在性能面板。未确认退出的 close 保留租约，但不会使干净 workflow 失败。退出证明只按4096条数量上限淘汰，不按时间过期；原生证明事件及时释放租约。wait 失败仍发送 UI Exit(null)，但不产生退出证明。sandbox/history 的未知读取只拒绝本次调用，不写入 sticky 或缓存；已删除的 branch parent 使历史处于未验证状态。冷缓存同步 guard/render/notification 分别返回 false/null/undefined（disabled 返回 true），跳过 guest 并异步预热；异步回调继续等待证明。

命名残余 **cold-single-run-handoff-window**：普通单运行回调可能先交付内容，再由 setTimeout(0) 记录 exposure，需由 phase3 进程/插件隔离关闭该时序窗口。命名残余 **restart-provenance-loss**：内存中的 sticky network-off 与 external-source 状态不跨重启保留，需由 phase3 持久化运行/绑定来源和恢复机制在恢复派发前重建。Phase2C-2 不声称已关闭这两项；本轮 Rust 测试及 tauri-host 编译由外部验证者执行。
