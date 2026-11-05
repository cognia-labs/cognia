---
title: "0253 — 成员资格要送达 Host，分区上的一切都以它为准"
description: "在多租户 Host 上，成员的 brain、轮次、沙箱运行、socket 和数据都取决于他在组织里的资格。但 Host 只能靠主动询问得知这个资格，会缓存答案，而且只有沙箱运行恰好复查时才会对变化作出反应。本 ADR 让协作服务器通过一条持久、可续传的流推送资格变化；让 Host 只有一个资格判定入口，所有路径都用它；规定每类变化对正在进行的工作产生什么效果；新增只能由 operator 操作的组织停用；把会话归属和 purge 都做成持久状态；并规定 Host 重启对成员被中断的运行意味着什么。此外，它确定成员设备只有一条写入路径，并把成员可能看到的错误码按原因拆开。"
---

# ADR 0253 — 成员资格要送达 Host，分区上的一切都以它为准

**状态：** 提议中
**日期：** 2026-11-05

**相关：**
- [ADR-0149](./0149-a-person-is-not-a-device)：用户、组织、工作区、设备。本 ADR 给组织加一个状态，术语不变。
- [ADR-0059](./0059-cloud-deployment-headless-brain)：headless brain 和多租户 `cognia-server`。
- [ADR-0243](./0243-a-run-acts-for-someone-and-says-who)：运行代表谁执行。成员的运行代表该成员执行，本 ADR 规定它何时必须停止代表。
- [ADR-0215](./0215-one-person-one-encrypted-sync-space-many-writable-hosts)：账号同步。第 9 节记录它和配对 Host 通道之间的边界。
- 计划：`docs/plans/2026-10-20-multi-user-organizations-permissions-and-rollout.md`。涉及 §7（撤销）、§9a（分区）、§9b（成员轮次），以及新增的 §9c（本 ADR 的问题清单和工作包）。

**证据：** 2026-11-05 对 person partition 链路的代码审查，范围包括 Host 各 crate、person brain、成员客户端和协作服务器。下面每个缺口都是在 `f88fad3a91` 的代码树里读到的，具体位置列在计划 §9c。

## 背景

P5 和 P6 让组织里的每个成员在多租户 Host 上拥有自己的分区：加密的数据根目录、一个 brain 进程、个人沙箱工作区、用量账本中的一行记录，以及设备绑定。成员可以用组织的模型聊天；在有合规沙箱池的 Host 上，还可以在沙箱里运行内置 agent。

这些操作都依赖同一个事实，而这个事实不归 Host 所有：成员在组织里的资格，由协作服务器掌握。审查发现 Host 对这个事实的处理很松散。

- **Host 只会主动拉取资格。**
  - 设备准入时询问协作服务器，答案缓存 5 秒；执行时再问一次，不走缓存；成员列表又用第三种方式问。
  - 角色到能力的映射，有的地方由 `cognia-tenant-auth` 计算，有的地方手写。
  - 没有任何机制通知 Host 某个成员已经离开。
- **成员离开后，正在进行的工作不会停。**
  - 启动 brain 时不检查资格，person brain 自己发出的请求也跳过资格检查，只有沙箱运行每 30 秒复查一次。
  - 解绑设备后它的 socket 仍然开着，只是逐帧过滤。
  - 计划 §7.5 写着 Host 会在下一个 lease 边界取消运行并记录 `revoked_during_run`，但 Host 上没有任何代码这样做。
- **成员会话的归属只存在内存里。** 重启后这张表为空，operator 侧的控制可以认领原本属于成员的 session id。此外，观察到未知 id 时，它会被永久记为 operator 所有。
- **purge 不是持久状态。**
  - 它先销毁内容密钥，这一点是对的。
  - 但此后任何一步失败，这个人又能被重新接纳。
  - 它还会把该成员的帧留在回放缓冲里，最长 24 小时；用量账本里的记录也不清。
- **重启会让运行变成孤儿。**
  - lease 和 watchdog 只存在内存里。
  - 磁盘上的绑定记录没有 container、lease 或 session id；沙箱守护进程会在 socket 断开时杀掉 agent，所以运行无法重新接上。
  - brain 的"连续性"其实是把转录记录重放给一个全新的 agent。
- **错误码有歧义。**
  - `person_brain_unavailable` 同时表示六种不同的失败，而且全都标成可重试。
  - `host_data_unpartitioned` 一处返回 403，另一处返回 503。
  - `host_surface_forbidden` 不区分非成员、跨分区会话和未知命令。
- **成员设备有两条写入路径。** HostState 通道没就绪或消息带附件时，客户端会先在本地写入用户消息，再直接发送。Host 会拒绝这次发送，于是下一次转录同步后文本就丢了。

协作服务器已经有一个组织 feed，但它是进程内的 broadcast，按用户 grant 认证：
- 帧不能跨副本传递；
- 订阅者断线期间的帧会丢；
- 无法发给某个具体的 Host。

而且协作服务器根本不知道有哪些 Host 存在。

## 决定

### 1. Host 上只有一个资格判定入口

Host 上所有需要成员资格的路径都只问同一个服务：
- 设备准入、执行准入、启动 brain；
- 成员列表、事件受众；
- 组织策略写入、离开检查的定时扫描。

具体规则：
- **调用方声明需要多新的答案。** `Cached` 用于读请求和普通写请求的准入；`Fresh` 用于执行、组织策略写入，以及收到变化通知后启动 brain。没有第三条路径。
- **角色到能力的映射只来自 `cognia-tenant-auth`。** Host 和 TypeScript 客户端都不再手写计算。`types/identity/` 里的 TypeScript 对应实现继续作为手写镜像保留，由现有的、基于 `protocol/collab-capabilities-v1.json` 的一致性测试钉住；客户端代码调用它，而不是自己比较角色。
- **答案区分四种情况**：`member`、`not-member`、`org-suspended`、`unresolved`（协作服务器不可达或返回格式错误）。只有 `unresolved` 可重试。
- **缓存由第 2 节的流负责失效**，可以逐条失效，也可以整体清空。

### 2. 资格变化通过一条持久、可续传的流推送

凡是可能降低或改变某人资格的变更，协作服务器都在同一个事务里写一行 `standing_changes`：

| 类型 | 由谁写入 |
| --- | --- |
| `offboarded` | `offboard_org_member`、从组织移除 |
| `role_changed` | `set_org_member`、`transfer_org_ownership` |
| `workspace_removed` | `remove_workspace_member`，以及降低角色时的 `set_workspace_member` |
| `org_suspended`、`org_resumed` | 第 4 节 |

每行记录包含：单调递增的序号、组织、用户（组织级类型不带用户）、相关时带工作区，以及提交时间。

协作服务器以长连接流的形式提供 `GET /internal/v1/standing-changes?after=<seq>`：
- 用内部服务凭据认证，只返回该凭据有权访问的组织；
- 先发送游标之后的记录，然后随提交实时推送新记录，并定期发心跳；
- 记录只保留有限时间窗口。游标早于窗口时，返回一个 `resync` 帧，而不是记录。

Host 端：
- 启动时订阅，把游标存在自己的数据目录里，断线后退避重连。
- 收到 `resync`、发现序号断层或长时间断线后重连时，清空整个资格缓存，并对每个活跃成员做一次 `Fresh` 复查。
- 流断开期间，正确性仍由 5 秒缓存和第 3 节的定时扫描保证。这条流只是降低延迟，并不是唯一的保障。

放弃的方案：
- **让 Host 订阅现有的组织 feed。** 它的 broadcast 只在内存里，跨副本和 Host 断线期间都会丢帧，而且认证是按用户的。
- **Postgres `LISTEN/NOTIFY`。** Host 不直连协作数据库，所以还是得由服务器转发，而且没有持久性。
- **让协作服务器维护 Host 注册表并主动回调。** 这需要协作服务器能访问每个 Host 所在的网络，还要追踪它本来不需要知道的 Host。

### 3. 每类变化对正在进行的工作的效果

| 变化 | Host 上的效果 |
| --- | --- |
| `offboarded`、`org_suspended` | 取消该成员的 tool-less 轮次和沙箱运行，每个都记为 `revoked_during_run` 并写审计；停掉 brain；关闭该成员所有已绑定设备的所有 socket；新的准入请求用 `person_not_member` 或 `org_suspended` 拒绝。 |
| `role_changed` | 让该成员的缓存失效。轮次继续运行。需要旧角色的写入（比如 `org.policy.manage`）因为走 `Fresh`，会立即被拒绝。 |
| `workspace_removed` | 取消放置在该工作区的运行，记录方式同上。该成员的其他工作不受影响。 |
| `org_resumed` | 让该组织的缓存失效。不会自动重启任何东西。 |

补充规则：
- **启动 brain 要检查资格。** person brain 自己的请求仍然免于逐请求的资格检查，因为 brain 不可能比启动它的资格活得更久：一旦资格出现负面变化，brain 就会被停掉。
- **每 30 秒扫描一次**有活跃 brain 或运行的成员，所以漏掉的通知最多延迟 30 秒生效。这个扫描取代现在只针对沙箱运行的 watchdog 复查，该 watchdog 的其他职责保持不变。
- **设备解绑、停用或吊销时，立即关闭该设备的 socket**，而不只是过滤它的帧。
- **已经产生的输出留在分区里**，由 purge（第 6 节）处理。已经发到外部的效果显示为"未决"，绝不显示为"已回滚"，与计划 §7.5 一致。

### 4. 组织停用

组织新增一个状态：`active` 或 `suspended`。
- 只有部署 operator 能改它，方式是 `cognia-collab-server org suspend|resume <org>` 和对应的 operator 路由。组织 owner 不能停用或恢复自己的组织。
- 停用期间，成员对协作服务器和任何 Host 的每个请求都返回 `org_suspended`（403，不可重试），并产生第 3 节的效果。
- 分区数据、组织凭据、用量和成员关系全部保留，恢复后照常使用。
- 删除组织仍然留在计划的 P7。

### 5. 会话归属持久化

Host 的 security store 新增一张表，把 session id 映射到拥有它的分区，或映射到 operator。
- 成员第一次发送时绑定到他的分区；operator 控制时绑定到 operator。两者都和现在一样，在任何 await 之前原子完成。
- 这张表在启动时加载。
- 发布事件时观察到未知 session id，不再记录归属：没有归属的帧不带分区标记，按 operator 帧发布。
- purge 会删除该成员的行。

### 6. purge 是持久状态

purge 在做任何事之前，先往成员的元数据里写一个 `purging` 状态。此后：
- 启动 brain 一律返回 `person_purging`（409，不可重试）；
- Host 重启后会在启动时继续完成这次 purge。

原有步骤的顺序不变：
1. 停掉运行和 brain；
2. 删除工作区和执行记录；
3. 删除该成员的回执；
4. 销毁内容密钥；
5. 删除数据根目录；
6. 删除元数据。

purge 另外还要：
- 把该成员的分区帧从事件总线的回放缓冲里删掉；
- 从组织用量账本里删除该成员的行；
- 删除该成员的会话归属行（第 5 节）；
- 清掉 brain 缓存的 artifact key base。

只有最后删除元数据那一步才会清除 `purging` 状态。

### 7. Host 重启时对账成员的运行

Host 启动时，在接纳成员之前，先把执行记录和自己名下的容器与存活的 lease 逐一比对。重启后不会有任何存活的 lease，所以找到的每个成员运行都会以 `host_restarted` 为原因终止：停掉容器、注销记录、写审计，该会话显示一条可读的失败信息。

组织也可以选择让被中断的轮次续跑：
- 组织 agent 策略新增 `resumeAfterRestart`，和该策略的其他字段一样由 owner 或 admin 设置。
- operator 用 `COGNIA_PERSON_RESUME_AFTER_RESTART` 设默认值，不设置时为关闭。
- 开启后，该成员的 brain 会在同一个个人工作区里启动一个新 agent，把转录记录作为历史重放，在转录里标注"因 Host 重启重试"，然后重新派发被中断的用户轮次。
- 这是至少一次（at-least-once）语义：第一次尝试已经产生的工具效果可能会再发生一次。转录里的标注会告诉成员这一点。

不采用"重新接管原来的 agent"，原因有三：
- 记录里没有 container、lease 或 ACP session id；
- 沙箱守护进程会在 socket 断开时终止 agent；
- 目前没有任何内置 agent 通过 ACP `session/load` 驱动。

要让这三点都成立，就得改沙箱守护进程和每一个 agent 适配器，而转录重放已经覆盖了这个场景。

### 8. 成员能看到的错误码各不相同

每个错误码只有一种含义、一个 HTTP 状态码、一个是否可重试的标记。它们都登记在协议目录里，客户端的诊断提示和两种语言的文案为每一个提供映射。

| 错误码 | 状态码 | 可重试 | 含义 |
| --- | --- | --- | --- |
| `person_not_member` | 403 | 否 | 此人在组织里没有资格。 |
| `org_suspended` | 403 | 否 | 组织已停用（第 4 节）。 |
| `session_partition_mismatch` | 403 | 否 | 会话属于另一个分区或 operator。 |
| `host_surface_forbidden` | 403 | 否 | 该命令不在此主体可调用的范围内。 |
| `person_purging` | 409 | 否 | 此人的分区正在 purge。 |
| `person_brain_starting` | 503 | 是 | brain 没能及时就绪。 |
| `person_brain_stopping` | 503 | 是 | fleet 或该 brain 正在停止。 |
| `person_brain_capacity` | 503 | 是 | 不变。 |
| `person_brain_busy` | 409 | 是 | 不变：有轮次在跑时拒绝 purge。 |
| `person_storage_failed` | 500 | 否 | 元数据、密钥或数据根目录的 I/O 失败。 |
| `host_authority_unavailable` | 503 | 是 | 无法确定资格。 |
| `host_data_unpartitioned` | 403 | 否 | 这台 Host 不保存成员分区。所有地方统一用这个状态码。 |

`person_brain_unavailable` 退役。

### 9. 成员设备只有一条写入路径

在成员分区上，成员的每次写入都通过 HostState intent：
- 通道尚未协商好或快照尚未确认时，intent 在 outbox 里等待，就绪后再发送。
- 绝不回退到直接发送；在 Host 接受 intent 之前，绝不写入用户消息。
- intent 完全无法发送时，设备显示拒绝原因，并把文本连同附件退回输入框。

`message.enqueue` 携带附件引用。设备通过现有的会话附件上传通道把附件传到成员分区，两种成员轮次都能收到。

账号同步（ADR-0215）和配对 Host 通道都会复制会话、消息、角色、技能、记忆和设置，但服务对象不同：
- 账号同步在同一个人自己的多台设备之间做端到端复制；
- 配对 Host 通道把 Host 上的数据提供给设备。

多租户 Host 上的成员设备只通过配对 Host 通道获取分区数据。是否退役其中一条管道，另行决定。

### 10. 用量不会丢失，并且有定价

- 成员轮次的用量记录通过持久 outbox 写入并重试。写入失败绝不只记一条日志就算了。
- agent 报告输入 token 为 0 时，brain 改用 gateway 账本里该轮次的数字。
- 组织模型的部署档案可以填写输入和输出单价。没填时按模型 id 查内置目录；两者都没有时显示为"未定价"，绝不显示为免费。

## 后果

- 成员离开、降级或组织停用，在流的一个往返内生效；流断开时最多 30 秒内生效。
- Host 多了一个持久游标、一张 security store 表和一个元数据状态。比本 ADR 旧的 Host 不支持与更新的协作服务器或客户端配合使用：三者一起发布，客户端里兼容旧 Host 的回退分支全部删除（见计划 §9c）。
- 重启会让成员丢掉进行中的轮次，除非其组织开启了续跑；开启续跑则可能重复一次工具效果。
- 协作服务器新增：一个组织状态、一张保留期有限的 outbox 表、一条内部流路由，以及两个 operator 命令。

## 休眠项

本 ADR 中没有休眠的部分。`resumeAfterRestart` 默认关闭，但它是一个设置项，不是休眠代码：开和关两个分支都在运行，也都有测试。
