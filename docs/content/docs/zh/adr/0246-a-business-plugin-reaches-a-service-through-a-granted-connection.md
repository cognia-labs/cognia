---
title: "0246 — 业务插件通过获授权的连接访问外部服务"
description: "基础插件（飞书、Google 等）负责适配某一家厂商的登录和协议，并提供认证服务。业务插件（日历、文档、任务、备份）声明依赖该服务，拿到不透明的连接引用，在自己的消费者授权范围内，借助 Host 注入的凭证发起请求。连接的身份、刷新、轮换、退出登录和回调都由 Host 负责；内置的 Rust 提供者实现同一套契约。"
---

# ADR 0246 — 业务插件通过获授权的连接访问外部服务

**状态：** Accepted（2026-11-01）；第 1—5 步已实施（2026-11-03）
**日期：** 2026-10-31
**相关：** [ADR-0026](./0026-plugin-extension-point-expansion)（集成）、[ADR-0126](./0126-plugin-subsystem-governance)（插件信任模型）、[ADR-0134](./0134-remote-document-providers)（文档提供者）、[ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched)（能力授权）、[ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)（常驻 Host）、[ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request)（出站授权）、[ADR-0243](./0243-a-run-acts-for-someone-and-says-who)（执行身份与凭证通道）

## 背景

目标方向是把厂商支持拆成两类插件：每家厂商一个**基础插件**，负责登录、账户和协议适配；每个领域一个**业务插件**（日历、文档、云盘、任务、IM、备份），依赖相应的基础插件。UI、Agent 和 Workflow 都通过公共接口使用这些能力，内置能力也逐步迁移到同一套 SDK。

一次对抗性审查（台账：`docs/reports/2026-10-31-external-service-plugin-architecture-adversarial-review.md`，ES-01 至 ES-36）发现：公共 SDK 只开放了认证和集成的一部分能力，缺少权限、生命周期、迁移和领域复用的完整契约。第一批修复已经关闭了不需要设计决策的缺陷（ES-01—06、13、14、18—22）。剩下的问题需要先做决定：

- **session 的身份信息太少。** `AuthSession` 只有 `id`、`accessToken`、`account {id,label}` 和 `scopes`；`getSession` 返回第一个 scopes 满足请求的 session。没有 issuer、client、tenant、主体类型或用途，消费者无法区分同一厂商的两个账户或两个 client（ES-07）。
- **授权没有分层。** 远端 OAuth 授权、Host 保存的 session，以及业务插件使用它的权利，目前是同一个东西。external-services 控制面的 `CapabilityGrant` 记录了连接、账户、workflow 和 session，但没有记录消费者插件。因此，一次共享登录会扩大所有消费者的权限（ES-08）。
- **provider 身份原先只是一个字符串。** 提交 b119bd3f9e 已经把 provider id 绑定到首次注册它的插件，直到该插件被卸载。但连接本身仍然没有记录它属于哪个 provider 包、哪个发布者、哪个契约版本（ES-09）。
- **刷新、轮换和退出登录没有跨窗口的协调者。** Google 的 Rust 控制器（`crates/cognia-connectors/src/google_docs_auth.rs`）用 nonce CAS 和断连屏障做协调，但只在单个进程内有效。开发中的飞书基础插件只在插件实例内部用一个 `Map` 去重刷新。插件认证 registry 本身没有任何锁（ES-10）。
- **回调由各个消费者自行校验。** Rust 中转（`axum_app.rs`）原样转发 `code` 和 `state`，不做校验，由各消费者检查 state。一次性消费、与 client 和 issuer 的绑定、取消以及迟到回调，还没有统一规则（ES-11）。
- 此外，**支持哪些认证方式**（ES-12）、**基础插件的升级顺序**（ES-15）和 **owner 接管**（ES-16）都还没有经过验收的契约；“库插件供业务插件依赖”也没有定义接口版本、账户作用域、权限传播和失效行为（ES-36）。
- **数据比访问权活得更久。** 远端文档会进入搜索索引、RAG 向量、聊天附件、Dock 快照和历史记录。连接断开、访问权被撤销，或远端条目被删除后，这些数据该怎么处理，目前没有规定（ES-23）。

插件信任模型维持 ADR-0126 的定义：前端插件是半受信的，运行在 Host realm 中。本 ADR 规定的是插件与 Host 之间如实可靠的契约，而不是沙箱。

## 决定

### 1. 授权分三层

| 层 | 归属 | 含义 |
| --- | --- | --- |
| **远端授权** | 厂商 | 厂商允许已保存的 token 做什么（即其 scopes）。 |
| **连接** | Host | Host 为某个身份（见第 2 节）保存的一份远端授权，包括凭证、刷新 lineage 和状态。 |
| **消费者授权** | Host，按业务插件分别记录 | 某个业务插件通过某个连接、在某个连接 revision 下，可以使用哪些操作（及资源）。它申请的 scopes 必须存在于该 revision 上；授权时检查，但不另存为第二份允许列表，因为操作本身已经限定了消费者能调用什么。 |

业务插件只能在消费者授权范围内行动。给远端授权增加 scopes 会产生新的**连接 revision**，但不会扩大任何已有的消费者授权：需要新 scopes 的消费者必须重新申请。

消费者授权在现有 `CapabilityGrant` 上扩展 `consumerPluginId` 和 `connectionRevision` 两个字段，`authorizeExternalCapability` 会同时检查它们。Agent 和 Workflow 调用业务插件工具时，按该插件的消费者授权加上运行本身的检查（ADR-0198、ADR-0239）来授权，永远不会得到比被调用插件更宽的授权。

### 2. 连接有稳定身份

连接的身份由以下几部分组成：

- **provider**：provider id、所属插件 id、发布者、provider 契约主版本
- **issuer**：部署或签发方（例如 `open.feishu.cn`、Lark 国际版或私有部署；即账户的部署来源）
- **client**：持有该授权的 OAuth client id 或 app id
- **tenant**：厂商的租户或组织（厂商有此概念时）
- **principal**：远端账户 id 及其类型（`user`、`bot` 或 `service`），对应 ADR-0243 的凭证通道（`user` 对应 delegated 或 bound person；`bot`/`service` 对应 service）

插件持有的是**连接引用**：一个由 Host 签发的不透明 id，插件永远不自行构造或解析它。

**选择规则。** 业务插件请求连接但没有指定时，如果只有一个连接符合该插件所需的 provider 和 scopes，Host 自动绑定它；如果有多个，由用户为该插件选择一次，并持久化这个绑定。该插件的 UI、Agent 和 Workflow 都使用同一个引用，不再有“取第一个匹配的 session”的行为。

**不同用途共用连接。** 一份远端授权对应一个连接；不同用途是这个连接上的不同消费者授权。由于 Host 对每个 (issuer, client, principal) 只保留一条 lineage，要为某个用途单独建立连接，需要使用单独的 OAuth client，然后把消费者绑定到它。

**client 是身份的一部分。** 两个 OAuth client 就是两份远端授权，即使是同一个账户，也是两个连接。因此 Google 文档（loopback PKCE client）和云盘备份（device-code client）只有在配置为同一个 client 时才共用一个连接；client 不同时各自保留自己的连接，任何一方都不会迫使另一方重新登录。

### 3. 业务插件永远读不到凭证

业务插件拿到的只有连接引用和元数据（账户名称、scopes、状态）。请求都通过 Host 注入凭证发出：`ctx.integrations.authenticatedRequest`、集成 action，或基础插件提供的、本身不携带凭证并转而调用这些接口的协议工具。只有提供该 provider 的插件能通过 `ctx.auth.getSession` 读取自己 provider 的 token。`ctx.auth.onDidChangeSessions` 只投递元数据（ES-01，已完成）。

### 4. provider 身份与服务契约

- 基础插件声明 `providesServices: { "auth.<vendor>": "<精确版本>" }` 并注册自己的认证 provider。业务插件声明 `requiresServices: { "auth.<vendor>": "^<主版本>" }`（或使用 `optionalServices`）。现有解析器（`service-registry.ts`、`load-order.ts`）负责检查依赖是否存在、semver 是否满足以及有无循环依赖。
- 库模块（`ctx.libraries.importModule`）可以导出协议工具（请求构造、响应解析、分页），但永远不携带凭证，所以导入库模块不会带来任何授权。
- 每个连接都记录自己的 provider 信息（见第 2 节）。所属插件被停用时，连接进入 `provider-unavailable` 状态并保留凭证；被卸载时，Host 尝试在厂商侧撤销，把连接标为 tombstoned 并删除凭证，撤销失败也一样。其他插件即使注册同一个 provider id，也不能接管它：只要所有权绑定还在，注册就会被拒绝（b119bd3f9e）；卸载后出现的新 owner 只能从新连接开始。

### 5. 刷新、轮换和退出登录由 Host 协调

- provider 只提供 `refresh(lineage)`；厂商支持撤销时，再提供 `revoke(lineage)`。何时调用由 Host 决定，provider 不参与。
- Host 的认证 registry 按 **token lineage** 用 `navigator.locks` 保证跨窗口只有一次刷新在进行（沿用 `lib/logto/session-lock.ts` 的 Logto 先例及其 IndexedDB 回退）；headless 环境下使用进程内互斥锁加 CLI 的持久化存储。
- 每份已保存的凭证都有 revision。只有当刷新开始时的 revision 仍是当前值时，刷新结果才会被提交（compare-and-swap）；轮换后的 refresh token 在同一次提交中写入。
- 退出登录时，先写入撤销屏障（一个 tombstone revision），再调用 `revoke`。之后才完成的刷新无法覆盖这个屏障，所以退出登录永远不会被迟到的刷新撤回。
- 内置的 Rust 提供者（目前是 Google 文档）保留现有控制器，以 **Host 提供者**（`pluginId: null`）的身份实现同一套契约。它的 nonce CAS 和断连屏障是 TS registry 的参考行为。

### 6. 回调只能消费一次，并且绑定到具体授权尝试

- 每次授权尝试都在 Host 中记录 `{provider, client, issuer, state, codeVerifier, expiresAt}`。`state` 是随机生成的，只能使用一次，10 分钟后过期。
- 回调只会被接受一次，并且只适用于它对应的 provider、client 和 issuer。取消授权尝试会删除这条记录，之后到达的回调会被丢弃。重放的回调或属于其他 client 的回调都不会建立连接。
- 需要 client secret 的 token 交换（confidential client）只在受信环境中执行：桌面端的 Rust host 或常驻 Host（ADR-0224）。静态导出的前端永远不保管 secret。

### 7. 认证方式

| 方式 | 第一版 | 运行时 |
| --- | --- | --- |
| OAuth 授权码 + PKCE（`oauth-pkce`） | 支持 | 桌面端（Tauri）和 Capacitor 通过 `cognia://auth/callback` deep link；浏览器端在厂商允许该回调地址时，通过弹窗和 `BroadcastChannel`。Headless 不支持：没有可交互的浏览器。 |
| 机密交换：不带 PKCE 的授权码（`oauth-confidential`），或 token 端点需要 client secret 的 PKCE | 只在受信环境中执行（见第 6 节） | 桌面端、headless brain、常驻 Host，或由配对网关在其 Host 上执行交换的浏览器/移动端客户端 |
| Client credentials（`client-credentials`，bot 或 service 主体） | 支持 | 仅受信环境，同上 |
| API key / 个人访问令牌（`api-key`） | 支持 | 所有运行时。作为 Host 连接凭证保存（浏览器需解锁保险库）。从不刷新；注入凭证的请求返回 401 时，连接进入 `needs-reauth`。 |
| Device authorization flow（`device-code`） | 仅 Host 提供者 | Google 云盘备份通过 Rust 控制器使用。插件提供者：以后支持；Host 以 `device-code-deferred` 拒绝，并在 UI 中标为不可用。 |
| Service account / 签名 JWT | 以后支持 | 仅受信环境 |

Host 用同一张矩阵（`lib/external-services/runtime-support.ts`）推导每种方式在各运行时的可用性，附稳定的原因和恢复操作，并按同一张矩阵执行（ES-33）。manifest 的 `runtimeCompatibility` 可以引用这些原因 id。只激活了配对网关的客户端按维度分别判断：交换和网络在 Host 上执行，密钥、回调和后台同步留在本地。

### 8. 升级与 owner 接管

- **基础插件升级（ES-15）。** 出现版本冲突时，manager 拒绝激活。升级时先让依赖它的消费者静止（`quiesceServiceConsumers`），再升级 provider，最后把每个消费者恢复到升级前的启用意图。包依赖（`dependencies`）的删除保护保持不变。`requiresServices` 消费者不会锁住它的 provider：卸载 provider 会停止消费者；消费者保留启用意图，记录缺失的服务并等待，任何兼容的 provider 出现后即恢复。
- **owner 接管（ES-16）。** 每项需要独占的职责都有 lease：刷新（lineage 锁）、同步（每个连接一份游标 lease）、action job（bad783b824 引入的 claim token 和 lease）。新 owner 只能在 lease 过期后接管。lease 过期的非幂等写入会被标记为 `remoteOutcome: "unknown"`，永远不会重放。验收需要针对这三类职责的故障注入测试。

### 9. 内置能力迁移到插件

- 内置账户通过 `ctx.integrations.migrateLegacy` 迁移。它的完成标记和备份不会被审计清理删除；回滚时会保留迁移后被编辑过的记录，并报告这些冲突（ES-20/21）。
- 每个迁移批次都要附一张对照表：旧入口 → 公共接口 → 新插件 → 数据和引用迁移 → 行为测试 → 明确不支持的部分（ES-32）。新旧实现在任何时候都不能同时负责同一项刷新、同步或写入。

### 10. 断连、撤权或远端删除之后的数据

在线访问权和用户主动保留的副本是两件独立的事：

| 数据 | 断开连接或撤销授权 | 远端条目被删除或失去访问权 |
| --- | --- | --- |
| **进行中的读取** | 由 Host 负责的读取（文档提供者、同步）会被中止。每次读取都带着连接 revision；revision 变化后才返回的结果会被丢弃，传输已完成的原始 integration 请求也一样。 | 读取失败，条目标记为不可用。 |
| **后台同步、监听、webhook** | 停止并释放游标（同步 lease 结束），不再有任何东西使用旧凭证。 | 下次同步时把该条目移出同步集合（tombstone）。 |
| **派生数据**（搜索索引条目、RAG 分块和向量、链接预览、缓存的元数据） | 删除该连接产生的派生数据。它们来自在线访问，不应比访问权活得更久。 | 下次同步时删除。 |
| **用户保留的副本**（用户加到消息里的附件、Dock 快照、保存的 artifact、历史中引用的摘录、导入 Twin 的文档、由 Issue Sync 导入的事项） | 保留，基于本地副本构建的内容（Twin 的分块和向量）也一并保留；来源断开期间，拒绝基于它们的刷新、重新同步和发布。每份副本都带来源信息：provider、连接、远端 id 和获取时间。界面显示“来源已断开”，在恢复同一账户的连接之前，不能刷新，也不能在线重新打开。 | 保留，标记为“来源已删除或不可访问”。 |

重新连接同一账户（同一连接身份，见第 2 节）后，保留的副本恢复在线重新打开；派生数据由下一次同步重建，而不是恢复。清除插件数据（卸载时勾选“同时清除存储数据”）会删除它产生的派生数据；用户保留的副本属于用户，只能由用户自己删除。撤销某个业务插件的消费者授权，同样会停止它的读取和同步，但不影响同一连接上的其他消费者。

## 考虑过的方案

- **业务插件经同意后可读 token。** 对插件作者更简单，但每个消费者都会变成凭证持有者，撤销单个消费者的权限也无法真正生效。否决。
- **通用的 Rust 认证控制器。** 在桌面端最稳，但浏览器和移动端无法使用。只保留给现有的内置 provider。
- **由各基础插件自行协调刷新。** 无法跨窗口协调，也无法在升级期间协调新旧两个实现。否决。
- **库模块导出绑定凭证的 client。** 用起来方便，但凭证会进入消费者的上下文。否决，改用不携带凭证的协议工具。
- **每种用途单独建立连接。** 隔离最强，但同一个账户要反复登录。作为用户可选项保留，不作为默认行为。

## 影响

- 业务插件的权限不会超出它的消费者授权；撤销某个消费者，不影响其他消费者。
- 同一厂商的多个账户、client 或 tenant 可以并存，消费者通过显式绑定来选择。
- 基础插件更简单：不再需要自己调度刷新，也不需要自己管理回调。
- external-services 视图改为按连接 id 区分连接，而不是按 `(plugin, service, provider)`，因此多个账户会分别显示（ES-29）。
- 插件作者需要声明服务依赖并申请消费者授权。现有集成在迁移前继续作为它们自己的消费者正常工作。

## 推进计划

1. **契约类型。** 连接身份与连接引用、连接 revision、`CapabilityGrant.consumerPluginId` 和 `connectionRevision`、连接上的 provider 信息；同步更新插件契约 catalog 及其镜像。
2. **Host 协调。** 在认证 registry 中实现 lineage 锁、revision CAS 和撤销屏障；实现授权尝试记录与一次性回调消费；实现 headless 存储。
3. **消费者授权。** 授权检查、连接选择与绑定 UI、授权申请提示、按连接区分的 external-services 视图，以及第 10 节的规则：带 revision 检查的读取、断连时停止同步、清除派生数据、保留副本的来源信息。
4. **飞书纵向验证。** `feishu-auth` 作为第一个基础插件（桌面端 PKCE，支持 tenant 和 bot 主体），一个业务插件（日历）作为消费者，并附 ES-32 对照表。
5. **Google 作为 Host 提供者。** 通过同一契约暴露 Rust 控制器；文档和备份作为 Google 提供者的两个消费者，使用同一 OAuth client 时共用一个连接（见第 2 节）。
6. **分批抽取**其余能力，每批都附对照表和回滚证据。

接受之前，只抽取了 `feishu-auth`，以及按 2026-10-31 接受的例外抽取的 `feishu-calendar`（c94a6623c4）。两者现在都运行在本契约上（第 4 步）。后续抽取按第 6 步进行。

## 实施状态

第 1—5 步及其承载的审查条目（ES-07—12、15、16、23—34、36）已实施；ES-05 另有过渡方案（790409b15e）。第 6 步尚未开始。

| 步骤 | 提交 | 说明 |
| --- | --- | --- |
| 前置修复 | b119bd3f9e、cd624cccf9、cb9ac351a0、bad783b824、52f21fa704、5ee04bcdb8、838096514f、3e421eabfa、5843a0036b | ES-01—06、13、14、18—22 |
| 1. 契约类型 | 88839f2109、88190841f5、35e9d6dc2c | |
| 2. Host 协调 | 72bfdc2904、af4e830f88、aa04caf227 | lineage 锁、revision CAS、撤销屏障、一次性回调，以及经 `cognia-net` 的 `auth:exchange`。CLI 把凭证保存在 `0600` 文件存储中，用 `O_EXCL` 文件锁，与 `logto.json` 相同，不放进加密快照。 |
| 3. 消费者授权与第 10 节 | 68d70d0e14、c3d348ce20、ea7cd32c2e、23f4f7daf3、45d7a34d65、39b1708d70、e022cd293f | 在注入凭证时检查授权，读取也不例外。保留副本带设备本地的来源信息和“来源……”状态，包括导入 Twin 和 Issue Sync 的内容；GitHub issue 镜像作为派生数据清除。 |
| 第 8 节 升级与接管 | 43f59e2191 | 升级前静止消费者、按连接的同步租约，三种租约都有故障注入测试 |
| 领域贡献（ES-24—28） | c74a78f73a、fb1baf0a1f、19db335e88、781eb66849、4ab64c0282 | `ctx.docsProviders`、Issue Sync 提供者、`ctx.backup.registerDestination`、Host 管理的认证提供者，以及不引用 Host 代码的示例插件 |
| 4. 飞书纵向验证 | fb84bc93ac、81cce06da3、f63804eead、ed802d1c66、f5db767198、7f75f7f62b、889154ac2b | 内置 Lark 成为 Host 提供者；`feishu-auth` 提供 `auth.feishu`（用户 PKCE、bot client credentials）；`feishu-calendar` 通过授权消费它。插件 PII gate 对飞书刷新的豁免已移除。 |
| 5. Google | c5d07a460b、3d005f801b、282f37bedb | Rust 控制器负责交换、刷新和撤销，按 client 使用 Host 保存的 secret。文档和云盘备份消费 `auth.google`。 |
| 增量同步（ES-31） | 2aa72591dc、d2799a1822、b38620883c、9406caedfb | 按页提交和 tombstone 的共享核心；Issue Sync 和 GitHub 镜像迁到其上；公开的 `ctx.sync`；`feishu-calendar` 使用 Host 游标 |
| 运行时与发布（ES-33、34） | 07af5f3535、409e2886ec | 每格都有证据测试的运行时支持矩阵；经真实 manager 的飞书发布矩阵 |

行为对照表（ES-32）：`plugins/feishu-calendar/README.md` 和 `docs/evidence/2026-11-02-adr-0246-es32-builtin-migrations.md`。

已知限制：

- 非 owner 调用 `ctx.auth.getSession` 仍会拿到 token，并记录审计（`DEFAULT_CONSUMER_TOKEN_READ_POLICY = "allow-with-audit"`）。下一个版本改为 `deny`。
- 插件 `device-code` 暂不开放（第 7 节）。
- 同步订阅续期（`external-sync-renewal`）暂不启用；`feishu-calendar` 使用轮询。
- Node 目标插件只能在激活时注册 `ctx.sync` 驱动。
- 后台同步只在运行 integration runtime 的环境中执行（桌面端、headless brain）。
- 真实账户冒烟测试（飞书用户与 bot、日历同步、内置 Lark 共用连接、Google 文档、云盘备份、断连清除）尚未进行。
