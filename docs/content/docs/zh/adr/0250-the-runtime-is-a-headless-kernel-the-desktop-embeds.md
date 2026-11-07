---
title: "0250 — 运行时是桌面内嵌的无头内核"
description: "所有长期运行的行为都在同一个内核里，内核按无 UI 的常驻 Host 来设计。每个宿主只有一个内核、一个数据权威。桌面上的内核运行在 WebView 里，每个进程只有一个属主。另一种形态是桌面运行一个本地 brain 进程。一周的 spike 测量了这种形态，因启动和内存不达标，暂时否决。配对设备是客户端。独立运行的浏览器和移动端保留为内核之外的轻量 BYOK 路径。客户端断线时把操作存成意图排队，宿主不再写入任何后备权威。内核共用四个原语，执行引擎有明确的归属方。契约跨语言校验。插件在一次切换中迁到新的宿主层与 UI 层契约。迁移采用绞杀者模式，按可复现的清单度量，并由双宿主测试通道把关。内核之外，每个功能都是一个用只含数据的清单声明的模块；中央注册表按宿主生成；厂商拆成协议、认证、业务三层；每条依赖的方向都由门禁把守。"
---

# ADR 0250 — 运行时是桌面内嵌的无头内核

**状态：** 提议中
**日期：** 2026-11-01
**修订：** 2026-11-01，对抗性审查和一次独立审计之后（见审计 §10）；§2 于 2026-11-01 依据 spike S1 做出决定；2026-11-04 依据功能模块分析新增 §14，并修订 §9、§13

**相关：**
- [ADR-0059](./0059-cloud-deployment-headless-brain)：无头 brain 与注册表规则
- [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)：常驻 Host
- [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility)：统一执行
- [ADR-0137](./0137-delegation-runtime)：delegation
- [ADR-0239](./0239-an-outbound-action-is-authorized-by-the-request)：外发授权
- [ADR-0243](./0243-a-run-acts-for-someone-and-says-who)：执行身份
- [ADR-0247](./0247-long-lived-work-carries-a-mandate-and-follows-its-threads)、[ADR-0248](./0248-a-person-is-never-queued-behind-automated-work)、[ADR-0249](./0249-a-background-jobs-completion-reaches-the-agent)
- [ADR-0198](./0198-a-runs-capabilities-are-granted-not-patched)：能力授予，模块向一次运行添加能力的唯一形态（§14）
- [ADR-0246](./0246-a-business-plugin-reaches-a-service-through-a-granted-connection)：授权连接，能力端口和厂商分层的样板（§14）
- [ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs)：cogset，一个厂商的各部分如何一起分发（§14）
- [ADR-0068](./0068-frontend-package-extraction-and-compile-speed)：其中 S5 的 store 切分按 §14 的设置键归属来切
- [ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked)：Rust crate 分层，§14 不涉及

**证据：** `docs/research/architecture-convergence-audit-2026-11-01.md`；§14 的证据是 `docs/research/feature-module-analysis-2026-11-04.md`（计数脚本 `scripts/gates/convergence/subsystem-deps.mjs`）。**计划：** `docs/plans/2026-11-01-convergence-phase-0.md`。

> **由 ADR-0252 修订（2026-11-05）。** 阶段 3 中多 agent 的部分（子运行进入账本、该区域的统一状态词汇、ADR-0247 承诺）提前交付。其余的小队代码并入 M1 建立的 `squads` 模块。

## 背景

架构审计（第二轮对抗性审查后已修订）找到两个根因，以及几个跨越两者的问题。

**运行时住在 UI 里。**
- 105 个 provider 初始化器，其中 75 个承担运行时行为，只有 29 个有无头对应。
- 其余的最多有 32 个没有任何记录。32 是上限：其中一些其实有说明。
- 聊天轮次编排是一个 7,299 行的 React hook，没有无头对应，所以 CLI 重新实现了其中一部分。
- 内核代码和 Zustand store 耦合。只算静态导入，有 355 个 `lib/` 文件导入 `@/stores/`；算上动态导入是 475 个，其中 409 个以命令式调用。这些 store 并不都是 UI 状态。
- 有些行为要等到"会话下次打开时"才发生。
- `check-host-parity` 的基线是 183 项，而当前树上有 200 项：新增 26 项，关闭 9 项。
- ADR-0059 引入的注册表（`lib/headless/registry.ts`）只有 brain 在启动，桌面从不使用它。

**没有共享的工作内核。**
- 393 张 Dexie 表。
- 约 23 种类运行记录。
- 约 17 个持久化队列，至少五种退避曲线。
- 约 22 个互不知情的并发上限。
- 约 15 种去重机制。

**关口只是约定。**
- 没有门禁枚举外发规划器的调用方。
- 送达网关的静态测试只认一种导入写法。
- PII 门禁检查的是导入，不是调用。
- 恢复时的授权检查只做审计。
- 门禁有 122 个，但 PR 可以在同一个改动里调高棘轮基线，因为 CI 不和基准提交比较。

**第二轮补充的发现：**
- **数据权威随连接状态切换。** `DataPlane::pick`（`crates/cognia-companion/src/data_plane.rs:77`）优先选已连接的 brain，其次桌面渲染进程，最后是可写的 SQLite 后备。brain 断线期间写入的数据没有对账。
- **插件是公开边界。** 契约有 91 个命名空间、938 个方法，只有 120 个声明支持无头。`context.ts` 把运行时 API 和 UI API 构造在同一个对象里。
- **契约有多个语义来源。** Rust 签名、分发、清单、Zod 和响应 schema 各自定义一份。生成产物可以逐字节一致，行为却不同；`check-rpc-semantic-parity` 当前以 114 个不透明响应 schema 超过 110 的上限而失败。业务规则已经出现分歧：工作流 cron 编辑器接受 `L` 和 `#`，Rust 守护进程拒绝它们，而失败被 `safeInvoke` 吞掉了。
- **执行有约 17 条路径：** 两个 sidecar 引擎、14 个外部协议适配器和 completion rail。它们的进程、会话、审批、取消和恢复归谁管，都是隐含的。有些上限保护的是真实的原生资源，比如 Python 宿主的信号量，它们不是业务准入。
- **独立模式也在执行。** 未配对的手机、没有 Companion 的浏览器，会用用户自己的 key 在 WebView 里跑聊天轮次（`lib/ai/chat/standalone-engine.ts`，400 行）。
- **双宿主的安全网很薄。** e2e spec 有 200 个，其中 24 个针对 Tauri。真正跑在 Web↔无头栈上的只有 2 个，运行它们的 Compose 层级也不在 PR 路径上。

## 决策

### 1. 每个宿主一个内核、一个数据权威

**内核**就是所有长期运行的行为：调度器、送达执行器、恢复、连接器、bot、同步、聊天轮次编排、插话、后台结果、唤醒和监视器。

- 它们以 `HeadlessRuntime` 条目注册在 `lib/headless/registry.ts` 中。
- 一个宿主只运行一个内核。
- 这个内核是该宿主应用数据的唯一写入方。

### 2. 桌面在哪里运行内核

**决定：内核运行在 WebView 里（2b）。** 桌面保持单进程形态，并明确满足以下要求：
- **每个进程一个属主。** 每个桌面进程只启动一次内核，由主窗口或选出的 leader 负责。它有启动、取消和可等待的拆除，在 StrictMode 重放下也安全。其他窗口只是这个属主的客户端，不会成为第二个内核。
- **账户生命周期。** 内核通过 `registerRuntimeTargetCleanup` 加入账户与运行目标的生命周期。锁定或切换账户时，要等它拆除完成，才切换数据库选择。
- **宿主适配器矩阵。** 每个注册条目都说明它在各个宿主上如何组装，矩阵见 `docs/research/`（阶段 0a A5）。brain 的条目不能换个 bridge 就拿到桌面上复用：事件发布器、连接器服务的生命周期和插件适配器都不一样。桌面与 Host 的一致性靠三样东西保证：同一个注册表、这张矩阵和双宿主测试通道（§12）。
- **大数据量账户的存储预算。** 现有的 WebView 路径在数据量大时很慢。在 20 万条消息的数据集上，冷启动后第一屏侧栏列表要 5.6–6.8 秒才出来，会话列表 p95 是 630–785 ms。阶段 2 要为这条路径单独设定预算。

**暂时否决：桌面运行本地 brain（2a）。** spike S1 按测量前就定下的范围测量了 2a。证据台账是 `spike/local-brain-s1` 分支上的 `docs/evidence/2026-11-01-convergence-s1.md`。
- **存储通过。** brain 存储在每项操作上都比 WebView 快。在大数据集上，会话列表 p95 约 50 ms，WebView 约 700 ms。
- **启动和内存大幅超出范围，原因是结构性的。**
  - 冷启动增加的时间：普通账户约 +3.0 秒，大账户约 +37 秒，范围是 +0.8 秒和 +2.5 秒。
  - 空闲内存：883 MB 和 3.8 GB，范围是 400 MB 和 800 MB。
  - 空库的 brain 光加载模块图就要 2.5 秒和 669 MB；启动时还要把每一行数据都恢复进内存。
  - 要达标，需要落盘的 brain 存储，还要大幅缩小模块图，阶段 2 内做不到。
- **还有额外的工作。** 2a 还需要：
  - 去掉桌面端 `DataPlane::pick` 里的渲染进程后备；
  - 新增四个 brain 到 Tauri 的适配：`browser_local_rpc`、`proxy_http_request`、`ocr_http_fetch`、`perf_start_sampling`；
  - 迁移几个宿主存储。

**重新考虑的条件。** 同时满足以下两点时，重新考虑 2a：
- 落盘的 brain 存储加上缩小后的模块图，在两个数据集上都落入 S1 的启动和内存范围；
- 非 JSON 值能完整经过 brain 的持久化往返。

### 3. 客户端与独立路径

- **配对设备**（有 Companion 目标的移动端和浏览器）是某个宿主内核的客户端。
- **独立路径不属于内核。** 未配对的手机和没有 Companion 目标的浏览器，保留一条轻量的 BYOK 路径（`lib/ai/chat/standalone-engine.ts`）。
  - 它的能力清单是明确写出的（聊天、搜索、文档），并由测试固定。
  - 它复用内核的纯函数库：provider 解析、提示词组装、事件映射。
  - 内核不需要为了它而能在浏览器里运行。

### 4. 单一权威；客户端把意图排队

- **不再静默写入后备。** 内核不可用时，宿主不会把应用数据写进后备权威。`DataPlane::pick` 的 `Direct` 分支改为只读，或报告宿主不可用。
- **远程 Host 的 brain 受监管。** `cognia-server` 负责重启它，它停止期间客户端显示断开状态。
- **客户端把意图排队。** 连不上宿主的客户端，把用户的操作存为意图而不是数据，沿用 `mobileOutboundQueue` 的模式。宿主恢复后，客户端带着幂等键重放这些意图，由宿主逐条接受或拒绝。不存在需要对账的第二份数据。

### 5. 内核规则

- **不用 React。** 内核代码不导入 React，也不导入 `@/components/` 或 `@/hooks/` 里的任何东西。
- **状态只有一个属主。** 内核据以做决定的状态归内核所有，放在它的 store 或数据库里。持有内核所需领域状态的 Zustand store 迁进内核，UI store 订阅内核。内核代码对 UI store 的命令式读取，以棘轮方式降到零。
- **没有"下次打开时"。** 必须发生的行为，在它的触发条件出现时发生。
- **只有一个聊天引擎。** 聊天轮次编排是一个内核模块 `lib/runtime/chat-engine/`。桌面和 TUI 客户端通过宿主驱动它，重复实现删除。

### 6. 共享原语

1. **持久化队列。**
   - 提供租约与认领、带定时唤醒的到期时间、经 `decideNextAttempt` 的重试、死信状态、唯一幂等键和查看视图。
   - 位于独立数据库里的队列（例如 `fusionOutbox`）也要迁移。
   - 现有行要升级，不能靠新索引把它们藏起来。
2. **准入限流器，只管业务准入。**
   - 区分来源（ADR-0248），为人保留一个许可，分两档，停止操作从不排队。
   - 原生资源的背压留在原处，只要它保护的是真实资源，比如 Python 宿主信号量、沙箱池槽位、节点安装槽位。它们列入清单并注明属主，不做迁移。
3. **运行台账。** `executionRuns` 是运行的唯一记录。引擎表通过真实引用指向它，而不是靠一个恰好叫 `runId` 的字段。在内核内部，成功统一写作 `completed`。
4. **承诺**（ADR-0247）。被承诺作为属主跟进的线程，只有一个执行方：这个承诺。

### 7. 执行归属

每条执行路径，都要为它的进程、会话、工具审批、取消、恢复和排空各声明一个属主：
- 两个 sidecar 引擎；
- 每个外部协议适配器；
- completion rail。

这份声明是引擎与宿主之间的端口契约，每条路径用一个测试检查。合并路径不在范围内，但归属必须明确。

### 8. 契约与共享业务规则

- **每类契约一个权威。** 每一类契约都指明它的权威来源：命令签名、请求、响应、事件、错误、取消。
- **跨语言 fixture。** 行为一致性用两侧真实序列化产生的 fixture 来检查，而不只是比较生成的字节。
- **共享业务规则有共享测试向量。** 范围是 TypeScript 和 Rust 两边都有的规则：cron、时区、状态词表、序列化。
- **失败不被吞掉。** 必需的注册或持久化调用失败时，要以健康状态暴露出来，不能返回 `null`。工作流 cron 的分歧是第一个修复的案例。

### 9. 插件：一次切换到新契约

- **破坏什么。** 插件作者 API 是替换，不是扩展：
  - **范围：** TypeScript、Python 和 WASM 迁到同一个新契约，分宿主层（在内核里运行）和 UI 层（在客户端里运行）。
  - **旧契约**冻结归档，做法与 WASM `cognia:plugin@0.1.0` 相同。
  - **不动：** VS Code 扩展兼容层，它跟随 VS Code 自己的 API。
- **影响谁。** 只迁移第一方插件；没有外部作者需要支持。
- **什么时候。** 切换与阶段 2 同时进行，也就是内核迁移的时候。
- **宿主侧的 UI 调用。** 在宿主上运行的插件请求 UI 操作时，比如弹对话框或改变选区，会转给一个在线客户端。没有客户端在线时，调用以一个具名错误失败。
- **与模块共用一份 schema。** 插件的宿主层和 UI 层，就是模块声明的那两份只含数据的清单（§14）。插件契约在这份 schema 上只补充插件才需要的东西：打包、签名、权限和版本，不另定义第二种形状。
- **宿主 API 跟着属主走。** 现有插件宿主 API 中的 52 个功能命名空间，迁到各自所属的模块，由模块通过 `pluginApi` 字段贡献，与契约切换同时完成。插件宿主本身（分发、权限闸门、bridge、生命周期）留在内核。
- **模块满足条件才能变成插件。** 契约切换之后，一个模块只有同时满足以下三点，才能迁出为插件（§14 的 M4）：
  - 它对宿主的每一项依赖，都在插件契约暴露的范围之内；
  - 没有其他模块 import 它；
  - 它的表已有定论。插件表的名字带命名空间，格式是 `${pluginId}:${tableName}`（`lib/plugin/dexie/namespace.ts`），所以把核心表改成插件表就是改表名，也就是一次数据迁移。每个这样的模块单独决定：放弃旧数据、做显式迁移，还是保留核心表、只给插件授予访问权。
  - 需要自己的 Rust 窗口或宿主命令的模块，继续作为模块，因为插件带不了这部分代码。
- **契约本身**另写一份 ADR，在阶段 0a 和阶段 1 期间依据插件 API 矩阵（§13）编写。

### 10. 门禁能枚举的关口

以下每一项都只经过一个模块，并由门禁列出所有调用点：
- 外发审查规划；
- 连接器送达；
- 网络出口；
- 调用模型前的 PII 脱敏；
- 恢复时的授权检查，按 ADR-0243 §2 和 ADR-0247 §7 实时进行。

shadow 模式要等对应门禁显示全覆盖后，才按类别切到 enforce。授权决定和它所授权的工作一起持久化，这样模式切换时永远不必去猜之前的决定。

### 11. 不能被悄悄调高的棘轮

- **可复现的清单。** 基线是带成员的清单（文件、符号、表和属主），由一个已提交的计数器在记录的提交上生成，而不是启发式计数。
- **基线不能悄悄增长。** `scripts/gates/check-convergence.mjs` 在计数上升时失败。另有一个基线检查，把每个棘轮文件与合并基准比较，增长即失败，除非 PR 带着一条写明属主和偿还阶段的例外记录。
- **无头注册表门禁**保留"在可达集合内被调用"的规则，只扩大它考虑的符号范围。

| 指标 | 基线（以阶段 0a 的计数器为准） |
| --- | --- |
| 承担运行时、既无注册条目也无排除说明的初始化器 | ≤ 32（成员清单在 0a 给出） |
| `check-host-parity` 发现项 | 200（A 96，C 104） |
| 以命令式使用 `@/stores/` 的 `lib/` 文件 | 静态 294 / 含动态导入 409 |
| 导入 `@/hooks/` 或 `@/components/` 的 `lib/` 文件 | 静态 64 / 含动态导入 74 |
| 未迁到原语的持久化队列 | 0a 中给出清单（约 17） |
| 未迁到限流器的业务上限 | 0a 中给出清单（上限合计约 22，原生的另列） |
| 没有真实 `executionRuns` 引用的类运行表 | 0a 中给出清单 |

### 12. 一块代码如何迁移

1. **在两个宿主上做特征测试**，使用阶段 0a 的双宿主测试框架。涉及内核或契约的改动，在 PR 上跑一条阻断式的 brain 集成通道。
2. **迁移**，并在同一阶段**删除**旧路径。
3. **调低基线。**

每个阶段有自己的 worktree 分支和证据台账。Codex 分批做机械性迁移；Claude 做架构、抽取和审查。阶段 4 结束前，大约一半产能投入收敛。新功能继续开发，但要基于新原语，阶段 0 的门禁会拦住旧做法。

### 13. 阶段与退出条件

| 阶段 | 范围 | 退出条件 |
| --- | --- | --- |
| 0a. 摸清事实、搭安全网 | 在干净 worktree 上确认门禁状态；可复现清单和计数器；基线增长检查；双宿主测试框架和 PR 通道；宿主适配器矩阵；插件 API 矩阵 | 清单已提交；基线准确；测试框架在 CI 中驱动一个行为跑通两个宿主 |
| S1. 本地 brain spike（与 0a 并行，一周） | 五个测量问题：存储、启动、迁移、双窗口下的一个轮次、崩溃与重启 | 已完成：2a 暂时否决，§2 决定为 2b |
| 0b. 修复（并行，不等 S1） | router-fusion outbox，含行升级和到期唤醒；cron 分歧和被吞掉的失败；不再写入后备；持久化外发授权的来源；host-parity 新增的 26 项；扩大无头注册表门禁 | `dev` 上所有门禁为绿；每项修复都有测试 |
| M0. 模块摸底（与 0b 并行，约一周） | manifest 类型 `defineHostModule` 和 `defineUiModule`；过渡归属表；G1、G6、G7、G8 作为棘轮，G2 只报告；`lib/sync/tombstones.ts` 搬进 `lib/db` | 已完成（2026-11-05）：基线已提交，并与合并基准比较 |
| 1. 原语 | 持久化队列和限流器；所有队列和业务上限迁移；原生背压列入清单 | 队列和业务上限清单清空；ADR-0248 落在限流器上 |
| M1. 首批注册表和试点（与阶段 1 同期） | 生成器支持设置分区、搜索 provider 和 slash 命令；试点 `squads`、`eval`，然后是飞书三层；G2、G3、G4 改为阻断 | 试点新增设置分区、搜索 provider 或 slash 命令时，不改任何手写的中央文件；`packages/feishu-protocol` 已建立，框架目录不再 import 飞书适配器。已完成（2026-11-05）：生成器、三份注册表和 `squads`、`eval` 两个试点已落地；飞书三层已落地：协议包、认证层，以及不再 import 任何飞书文件的框架（14 处比较 `lark` 字面量仍记在基线里）；G2、G3、G4 已改为阻断 |
| 2. 内核移出 UI | 由注册表启动单一属主的 WebView 内核，配套适配器矩阵和大数据量账户的存储预算；抽出聊天引擎；每个运行时初始化器迁移完成，或以物理原因排除；插件契约切换，宿主 API 迁到各自的模块。模块线 M2 在同一阶段完成：`runtimes.adapters` 和 `effects` 取代"初始化器 + 无头"两处维护，表归属从 manifest 读取，只有单一使用者的数据模块随属主搬走；试点 `pet` | 未说明的缺口为 0；内核读取 UI store 为 0；`lib`→`hooks`/`components` 为 0；host-parity 只剩物理原因；第一方插件迁到新契约；`runtime-initializers` 清单清空；基础层 → 模块的边为 0 |
| M3. 内核汇点（与阶段 3 同期） | 设置键归属；能力端口，先做 `ocr`、`speech`（试点）和 `docs-provider`；能力授予贡献（先过 ADR-0198）；提示词贡献 | 设置 store 的引用文件数、`build-options` 触达的子系统数都在下降 |
| 3. 工作主干 | 运行表引用台账；统一状态词表；ADR-0247 的承诺 | 所有运行都在台账里 |
| 4. 先覆盖关口，再 enforce | 能枚举调用方的门禁；按类别 enforce | 证明全覆盖；通过的类别开启 enforce |
| M4. 抽出插件（契约切换之后） | 可抽出检查（§9）清零的模块迁出为插件；拥有表的模块各自做数据决策 | 迁出的插件进入插件仓库 |

M 开头的各行是 §14 的模块线。它们与内核各阶段并行，遵循同样的迁移方式（§12）和同样的棘轮（§11）。M2 属于阶段 2，不单独成为一个阶段。

### 14. 功能模块与生成的注册表

§5 规定内核不能 import 什么。本节规定内核之外的一切怎么切分，让加一个功能不再意味着改公共文件。

**为什么。** 功能模块分析在 2026-11-04 测得：
- **耦合是网状的，不是几个枢纽。** `lib/` 层 176 个子系统中，有 150 个处在同一个强连通分量里。拆掉最能缩小它的 15 个子系统，仍剩 86 个。拆上帝文件解决不了这个问题，要靠一条方向规则加门禁。
- **加功能就要改公共文件。** 近 60 天的 feat 提交中，37% 改了至少一个中央注册表，剔除 companion 命令目录后是 32%。加一个设置分区要改五处。
- **三个汇点充当了总线。** 设置 store 有 530 个直接引用文件，`SettingsState` 有 151 个成员。`lib/db` 的 210 个数据模块中，88 个只有一个使用者。插件宿主 API 触达 82 个子系统。
- **插件边界守住了。** 没有一个第一方插件 import `@/`。缺的是应用内部的模块边界。

**五类。** 每个子系统恰好属于一类：
- **基础层：** 没有业务含义的管道：UI 原件、工具函数、数据库实例、平台与传输桥、日志、错误。
- **内核：** §1 的内核，以及所有功能都依赖的部分：会话与消息、发送管线、模型网关与凭据、agent 执行、运行台账、身份与账号、工作区、同步、存储、队列与调度原语、授权、插件宿主、设置基础设施。内核是一份封闭清单，逐个子系统的记录在分析文档（其中 §11）里，增加成员要修订本 ADR。
- **外壳：** 只做汇总和导航，不被任何人依赖：设置界面、初始化器、`app/me`、桌面与移动外壳、全局搜索、slash 命令、无头装配。
- **模块：** 其余所有功能，编译期链接，在同一进程内运行。内核清单没有点名的子系统都是模块。
- **插件候选：** 实现某个能力端口、或者属于可选应用的模块。在 §9 的抽出规则放行之前，它仍是模块。

依赖只朝一个方向：基础层不依赖它之上的任何一层；内核不依赖模块、插件候选或外壳；模块不依赖外壳。

**每个模块两份只含数据的清单。**
- **宿主层：** `lib/<id>/module.ts`，用 `defineHostModule`。**UI 层：** `components/<id>/module.ui.ts`，用 `defineUiModule`。它们和 §9 插件契约的两层一一对应。
- **只含数据。** 清单只 import 自己的 `define*` 辅助函数，顶层只能是字面量和懒加载入口 `() => import("…")`，不能有 schema、默认值或副作用。每个宿主都会静态 import 生成的注册表，而 S1 已经说明急加载模块图是一项预算（§2）。
- **身份与生命周期：** `id`、`kind`、`stage`（`kernel`、`stable`、`beta`、`experimental`、`deprecated`）、`owner`（`.github/CODEOWNERS` 中的团队）、`acceptance.realSmoke`（`pending` 或 `passed:<日期>`）。
- **边界：** `owns`（默认 `{lib,components,hooks,stores,types,app}/<id>/**` 之外的路径）、`dependsOn`、`api`、`provides` 和 `requires`（能力端口）。
- **宿主层贡献：** `runtimes`、`settings.keys`、`tables`、`tools`、`capabilityContributions`、`taskExecutors`、`builtinSkills`、`pluginApi`、`workflowNodes`、`searchProviders`、`slashCommands`、`nav`、`prompts`、`flags`、`messages`。
- **UI 层贡献：** `slots`（插槽名取自 `CANONICAL_EXTENSION_POINTS`）、`settingsSections`、`effects`。

已有规则管着的字段，按已有规则来：
- **`runtimes`** 声明运行时的身份和重要性，外加每个宿主一个适配器，也就是把 §2 的适配矩阵写成数据。每个适配器都是一个模块路径。brain 适配器沿用 `HeadlessRuntime.start` 的签名，并写明它在哪些 brain 档位上启动（`hosts`）。`HeadlessHost`（`brain`、`person-brain`）不扩充，不让桌面冒充 brain。
- **`effects`** 放需要 React 上下文、路由、i18n 或 toast 的副作用，它们不是运行时。一个初始化器属于哪种，以 `runtime-initializers` 清单为准。
- **`settings.keys`** 声明模块拥有哪些扁平 `AppSettings` 键。线上格式不变，`packages/agent-config-types/src/settings-sync.ts` 仍是同步来源。模块通过一个视图读自己的键。ADR-0068 S5 的 store 切分按这份归属来切。
- **`capabilityContributions`** 只产出 `AgentCapabilityGrantV1`，由现有的解析链按阶段施加（ADR-0198）。没有排序数字，也不修改 `SendOptions`。需要新阶段的贡献，先修订 ADR-0198。
- **`tables`** 只声明归属。schema 仍集中在 `CURRENT_SCHEMA`，所以加表仍要改 `lib/db/schema.ts` 和治理目录。这是 Dexie 单一版本号的代价，接受它。
- **`tools`** 带上各自的权限规则：每个工具的同意方式和作用以数据声明，规则集由内核从声明派生（见下文 M3 的修订）。**`taskExecutors`** 把执行器和它的任务来源一起声明。
- **三处标注休眠（Rule 7）。** `stage`、模块停用时 UI 上的停用标注、对生成注册表的测试。`experimental` 模块不进导航，也不启动运行时。停用的模块不启动运行时，导航里隐藏，访问它的路由时显示"已停用"，表保留。

**生成注册表，永不进仓。**
- `scripts/build/gen-module-registry.mjs` 为每个宿主生成一份注册表：`lib/modules/generated/{brain,desktop,mobile}.ts` 和 `components/modules/generated/ui.ts`，里面只有懒加载入口。按宿主拆开，brain 就看不到任何桌面专用的入口。
- 宿主层只有一份与宿主无关的 `lib/modules/generated/host.ts`。其中的字段在所有宿主上都一样适用；设置分区能否访问，和内置分区一样在运行时由 `requires`、`profiles` 决定。第一个按宿主区分的字段 `runtimes.adapters` 没有让它拆开（M2）：适配器是模块路径，生成器把每个宿主的懒加载 import 写进该宿主自己的运行时注册表。`host.ts` 和 `ui.ts` import 的就是 manifest 本身（数据加懒加载入口），外壳读取的是 `lib/modules/registry.ts` 和 `components/modules/registry.ts`。
- 这些文件加入 `.gitignore`，由 `postinstall`、`predev`、`prebuild`、`prestorybook`、`scripts/test/jest.mjs`、`typecheck-root.mjs` 和 CLI 构建生成，brain 的 Docker 构建和 CI 跑的正是这些入口。提交进仓的聚合文件会冲突，现在提交进仓的 companion 命令目录就是这样。在共享工作区里重新生成，还会把其他会话尚未提交的 manifest 一起写进提交。
- 注册表按顺序迁移：M1 迁设置分区、搜索 provider 和 slash 命令；M2 迁插槽、导航、运行时与副作用、表归属；M3 迁提示词、能力授予贡献和设置键；插件宿主 API 随 §9 迁移。
- 一份注册表改为生成之后，再往里手写条目，G5 就会失败。
- **M1 为这三份注册表定下的规则。**
  - slash 命令的描述是 manifest 里的数据，处理函数是懒加载的 `load`。它以 `builtin` 作用域并入 `BUILTIN_SLASH_COMMANDS`，所以列出内置命令的界面都会列出它。
  - 搜索 provider 懒加载，和内置 provider 注册在一起。它到达后，对话框会重跑查询；无头搜索会等它加载完。provider 的 `kind` 仍属于搜索词表（`lib/global-search/types.ts`），模块要加新的 kind 就加在那里，就像加一个类型。
  - 设置分区的元数据（分组、Lucide 图标名、`after`、`requires`、`profiles`、布局、关键词）是数据，文案是模块自己命名空间下的完整 key。分区 id 的类型由 manifest 推出；插件契约里的 `SettingsSectionId` 只列插件可以打开的分区。
  - 休眠：`experimental` 模块不向这三处贡献任何东西；深链接到它的分区时，页面会说明该分区已关闭。
- **`eval` 试点为过渡归属表定下的规则。**
  - 模块的代码放在别的子系统目录下时，由它的 manifest 用 `owns` 认领；它在表里的行和路径覆盖在同一次改动里删掉（G1 不允许两处同时存在）。`eval` 的行和 `lib/ai/eval/`、`lib/plugin/eval/` 两条覆盖都改成了认领，每个文件的所有者不变，G2 没有新增边。
  - manifest 可以先放在 `lib/<id>/module.ts`，代码不必先搬过去。搬代码是另一次改动，要有它自己的理由。
  - 规模度量计的是模块带来的开销，不是模块存在本身。G7 的急加载文件数不计 manifest，所以只含数据的模块不增加它。
  - `stage` 记录实际发布的状态。分析 §11.2 把 `eval` 列为 experimental，但它现在正常发布，而 experimental 模块不贡献任何东西，所以在单独决定关闭它之前保持 `stable`。
- **M2 为导航和插槽定下的规则。**
  - `nav` 是宿主层字段。它只是数据，而读导航目录的代码都在 `lib/` 下：侧栏及其"更多"菜单和自定义面板、Go 菜单和原生菜单的路由、⌘K、标题栏和窗口标题、界面可用性边界、全视口路由、手机快捷方式。若从 UI 注册表读取，就会新增 `lib`→`components` 的边。
  - 一个条目装着共享表原先为一个目的地记录的全部信息：布局里存的 id、路由、模块自己命名空间下的标签与别名 key、Lucide 图标和插画、分组与类别、`after` 锚点（Go 菜单位置不同时另给 `goMenuAfter`）、仅桌面标志、`fullViewport`，以及可选的手机快捷方式。（按宿主能力显示的标志原本为宠物页面而设，已随页面一起移除：按操作门控现在属于设置分区，见下文。）
  - `lib/shell/nav-catalog.ts` 是唯一的合并目录：`SIDEBAR_NAV_META` 加上各个启用模块的条目，按锚点插入。锚点不存在、id 或路由重复时直接抛错。所有读取方都按完整 key 查标签，内置条目的 key 是 `desktop.guildRail.<key>`。
  - 布局默认值和持久化的 id 是针对 id 的布局，不是贡献。`DEFAULT_PINNED_IDS`、手机默认网格和旧 id 映射继续写 `squads`。暂时关闭的模块，其已存储的 id 会保留，不会丢弃（`knownNavIds`）。
  - 原生 Go 菜单（`src-tauri/src/menu.rs`）读不到注册表，所以仍是一份镜像，由 `menu-actions.test.ts` 对照合并目录检查。
  - `slots` 的键必须是 `CANONICAL_EXTENSION_POINTS` 中的条目，值必须是懒加载入口。切片 A 时还没有模块填充插槽；渲染路径随 `pet` 试点落地（见下文）。
  - `squads` 和 `eval` 把自己的目的地从侧栏目录、图标表、Go 菜单布局、全视口列表、手机目录、插画覆盖表和侧栏标签中移了出来。侧栏目录位于 `packages/plugin-contract`，所以这次迁移使插件开发套件的固定版本失效，重新固定是单独的一步。
- **M2 为表归属定下的规则。**
  - 模块在 manifest 的 `tables` 里认领自己的表，数据目录（`lib/data-governance/table-catalog.ts`）的 `owner` 就是认领者。目录直接读取生成的宿主注册表：它是位于 `lib/modules/registry.ts` 之下的数据层代码，而注册表只含数据和懒加载入口。没有 manifest 认领的表沿用原来按前缀推断的归属，G7 的 `unclaimedTables` 只降不升。
  - 直接访问指 `db.<table>`、`getDb().<table>`（或 `rawDb()`）和 `.table("<table>")`。只评判其他模块：一个模块的文件读取另一个模块认领的表，就是一条 `tableAccess` 记录，这份列表只减不增（G4，自 M2 起阻断）。数据层、内核和外壳不受评判，因为备份、同步和数据治理本来就要读所有表。
  - 共享的访问器留在 `lib/db/`。模块通过它 import 的 `lib/db/` 文件访问到的表算作已访问，所以认领一张表不会逼着访问器搬家。
  - 只有一个 manifest 模块 import 的 `lib/db/` 文件归这个模块所有，由它在 `owns` 里认领（G4）。只被其他数据文件 import 的文件原地不动。G7 的 `singleUserDataModules` 统计剩下的单一使用者文件，它们的模块还没有 manifest（本切片时为 37）。
  - 随后这些文件随属主一起搬走：G7 的 `singleUserDataModules` 为 0。没有 manifest 的模块无法认领文件，所以这 36 个文件各自在 `scripts/gates/module-ownership.json` 里得到一条 `paths` 记录，交给它唯一的使用者。归属表的棘轮只统计 `subsystems` 行，所以这些记录不需要例外；属主有了 manifest 后由 `owns` 认领，这些记录随之删除。文件路径不变：按分析文档对共享工作区的建议，移到 `lib/<id>/` 下的工作在模块下次修改时完成。有两类不跟随 import 方：设置壳不拥有数据，所以只有「设置 → A2UI」调试器使用的 `a2ui-event-history.ts` 归 `a2ui`；只有 `lib/storage/retention.ts` 使用的两个保留期辅助文件归 `storage`，它和数据层一样属于基础层。这次搬迁偿还了 8 条数据层的方向边。
  - `eval` 认领了它的 20 张 `eval*` 表和 `lib/db/eval-dataset-versions.ts`。harness 采纳和工作流部署门禁中的三处直接读取已记入基线，偿还方式是改走 eval 的 `api`。
- **M2 为运行时和副作用定下的规则。**
  - 适配器写成模块路径，不写懒加载入口：manifest 旁边的 `./runtime/<name>`，或 `@/…`。brain 会打包 `host.ts`（数据目录要读它），如果在那里写懒加载 import，桌面适配器就会进入 brain 的模块图，`check-headless-registry` 也会把桌面专属的副作用当成 brain 已调用。所以生成器把每个宿主的懒加载 import 分别写进 `lib/modules/generated/{brain,desktop,mobile}.ts`，每个宿主只 import 自己那一份。
  - brain 适配器写作 `{ module, hosts }`。它的 `start` 就是 `HeadlessRuntime.start`，`hosts` 写明 brain 档位。`ModuleHost` 仍是 `brain`、`desktop`、`mobile`。写了 `person-brain` 的运行时还要加入 `PERSON_BRAIN_RUNTIMES`，由 roster 的测试钉住。`lib/headless/runtimes/modules.ts` 紧接在初始化器那一批之后注册每个 brain 适配器，所以每个 brain 适配器在构造上就会在 brain 上被调用。
  - 桌面和手机适配器通过 `ModuleRuntimeHost`（`components/providers/initializers/module-runtime-host.tsx`）启动。桌面构建（Tauri 和浏览器）读 `desktop.ts`；Capacitor 构建解析到 `lib/modules/runtimes.mobile.ts`，读 `mobile.ts`。运行时可以写明它等待的延迟启动组（`boot`：`core-chat`、`workflow-automation`、`integrations` 或 `knowledge-agents`）。主启动区和每个组各挂一个宿主。
  - 渲染端的一次运行在账户解锁后启动；切换账户时，等上一次的拆除完成后再重启。一个运行时失败不影响其他运行时，拆除按相反顺序进行，桌宠的浮层窗口什么都不启动。
  - 没有适配器的宿主要在 `absent` 里写明原因，模块门禁强制要求。于是 `check-headless-registry` 对初始化器的要求（没有 brain 对应项的副作用必须写原因）对模块运行时同样成立。门禁还检查适配器能解析、导出了 `start`，以及运行时名称在各模块之间不重复。
  - 休眠：`experimental` 模块的运行时在任何宿主上都不启动，由针对每份注册表的测试钉住。
  - 试点：
    - `squads` 接管了小队引导这一对：`SquadBootstrapInitializer` 和 brain 自己注册的 `agent-team-runtime`。现在它是一个与宿主无关的适配器，在三个宿主上运行，并保留 brain 运维人员重启它时用的名称。
    - `eval` 接管了在线评测的消费循环，只在渲染端宿主上运行。manifest 写明了 brain 为什么没有适配器，它在 `runtime-initializers` 清单里的那一项已偿还。
  - `effects` 只做形状校验：每项一个名称，加一个懒加载入口。渲染它们的宿主随 `pet` 试点落地（见下文）。
- **M2 在插槽、副作用和 pet 试点上定下的规则。**
  - 模块在 UI manifest 中用 `slots` 填充规范扩展点。扩展点的宿主通过 `PluginExtensionSlot`（`components/modules/slots.tsx`）绘制这些条目：排在插件贡献之前，按模块 id 排序，每项都是懒加载组件，各自包在 `ModuleBoundary` 里，因此一个模块出错既不会拖垮插槽，也不会拖垮插件。`usePluginSlotHasExtensions` 也计入模块条目，所以只有被填充时才出现的宿主位置（宠物控制台的「扩展」）对模块和插件一视同仁。
  - `effects` 是需要 React 上下文、路由、i18n 或 toast 的副作用。`ModuleEffectsHost` 在应用的 provider 内、每个窗口中挂载一次，每项包在 `ModuleBoundary` 里；由副作用自己决定在哪个窗口生效。它们取代了在应用运行时里手动挂载的初始化器。
  - 休眠：`experimental` 模块不填充插槽，也不挂载副作用。`slots.test.tsx` 和副作用宿主的测试固定了这一点。
  - `pet` 是试点。它的 manifest 拥有自己的表、悬浮窗与弹窗路由、设置分区，以及 `pet-mount` 副作用（`PetMount`，另有 Capacitor 版本），后者原先是手动挂载的。雷达是独立模块，从自己的 UI manifest 填充 `pet.console.tab`，不再由控制台直接导入。
  - 宠物没有页面。它的控制台就是「设置 → 宠物」分区（ADR-0058 D16），所以 manifest 不声明 `nav`，侧栏、Go 菜单、原生菜单和 ⌘K 都没有宠物这一项。设置分区可以声明自己在非桌面端需要的宿主操作：`hostOperation`（snake_case 操作 id，由模块门禁校验）让 `settingsSectionBlockReason` 在已配对主机未声明该操作的伴侣端返回 `capability`。宠物声明的是 `pet_get`，手机 `/me/pet` 入口使用同一判断（`hostAdvertisesOperation`）。
  - 依赖反转，第一部分。原先有 30 个子系统 import `pet`，其中大多数用的并不是宠物自己的代码：每条启动路径都要问的窗口角色（`lib/platform/window-role.ts`，`getWindowRole`）、所有透明浮层共用的首帧揭示（`lib/tauri/overlay-reveal.ts`）及其底下的原生显示与揭示命令（`lib/tauri/overlay-windows.ts`）、`useDocumentHidden`（`hooks/use-document-hidden.ts`），以及远程宠物照料和文件写入共用的伴侣端幂等账本（`lib/companion/idempotency-ledger.ts`）。它们以中性的名字移到了基础层或内核，pet 的 `api` 不再列出。`/pet` 移入 manifest 的 `slashCommands`。pet 现在拥有 `lib/tauri/pet-window.ts` 和两个只有它使用的数据文件（`lib/db/pet-media-packs.ts`、`lib/db/pet-sprite-packs.ts`）。import pet 的子系统从 30 个降到 17 个（`scripts/gates/convergence/subsystem-deps.mjs`），偿还了 9 条基线中的方向边。剩下的引用都是读取宠物状态或链接到宠物：托盘与 glance 的切片、工作流节点与触发器、智能体工具、插件宠物 API 和提示词目录。它们随 M3 的贡献点和 §9 的插件宿主 API 一起迁移。
  - 依赖反转，第二部分：由宠物发布的状态。托盘菜单和 glance 从一个类型化的主题读取宠物的心情与需求，不再 import pet。`lib/runtime/topics.ts`（基础层，不 import 任何东西）在每个 JS realm 里为每个主题保留一个最新值：`publishTopic` 和 `clearTopic` 写入，`readTopic` 和 `subscribeTopic` 读取，`useTopic`（`hooks/use-topic.ts`）是 React 读取方。模块在 `types/<id>/**` 里通过合并 `TopicMap` 声明自己的主题，读取方只 import 模块的类型。`pet.status`（`types/pet/events.ts`）携带 `enabled` 和 `at(now)`：后者给出按读取方时钟衰减后的宠物，并附带由宠物自己的照料阈值算出的分档（`low`、`neutral`、`high`），托盘因此不再 import 这些阈值。发布方是 pet 的 `pet-status` effect：`ModuleEffectsHost` 在每个窗口、每个宿主上挂载它，因为读取方分散在各处（主窗口的托盘与 glance、设置里的托盘面板预览、独立手机的 glance）；它卸载时撤回主题，读取方显示为「没有宠物」。托盘不再 import pet，import pet 的子系统从 17 个降到 16 个。glance 保留两处不是状态的引用：控制台的路由（`petConsoleHref`）和手机上的远程照料命令。二者都是 pet 的 `api` 文件，等导航和命令迁入贡献点（M3）时再处理。主题是保留的状态，不是事件流：新值替换旧值，晚挂载的读取方看到的是最新值。
- **M3 为能力端口定下的规则，以 `speech` 为试点。**
  - 端口是内核在 `types/modules/ports/<id>.ts` 里声明的契约，合并进 `PortMap`（`lib/modules/ports.ts`），所以 id 和契约在两端都受类型检查，不需要运行时常量。模块用 `provides: [{ port, load }]` 提供实现，被加载的文件以 `port` 导出实现。使用方调用 `loadPort(id)`（或 `readPort`，React 里用 `hooks/modules/use-port.ts` 的 `usePort`），从不 import 实现。实现在第一次使用时懒加载，每个 JavaScript realm 只加载一次。没有任何活跃模块提供的端口解析为 `null`，所有使用方都把它当作「此处不可用」：`experimental` 的提供方不提供任何东西（规则 7）。
  - 和运行时适配器不同，端口提供与宿主无关。manifest 的懒加载入口在 `host.ts` 里，所以每个宿主都能解析端口，能在哪里工作由实现自己决定。`speech` 在 brain 上也能合成（连接器的语音消息），朗读和实时语音则需要窗口。
  - 门禁。G5：提供项指向已声明的端口，其文件导出 `port`，每个端口只有一个模块提供（`lib/modules/ports.ts` 在运行时也拒绝两个），不带 `?` 的必需端口有活跃的提供方。G4：`requires` 恰好等于模块文件实际请求的端口（用字面量 id 调用 `loadPort`、`readPort` 或 `usePort`），模块不会 require 自己提供的端口。
  - `speech` 模块（`lib/speech/module.ts`）接管了 `lib/tts/`、`lib/voice/`、它们的 hook、正在播放条、设置分区和实时语音对话框；归属表里的 `tts`、`voice` 两行随之删除。它的端口（`types/modules/ports/speech.ts`）包含朗读（`readAloud`：共享播放器的状态、停止，以及为聊天消息、流式回复、宠物和桌面选区朗读）、缓冲式 `synthesize`，以及 `live`（一个审批是否属于实时语音的工具调用，以及对它「始终允许」）。聊天的朗读按钮、自动朗读和审批路径、手机上的消息菜单、宠物、选区工具条和连接器的语音消息现在都向端口请求，没有一个再 import `lib/tts/` 或 `lib/voice/`。负责朗读的两个聊天 hook 移到了 `hooks/chat/`，它们喂数据用的推送流成为基础层工具（`lib/utils/pushable-stream.ts`）。设置分区移入 speech 的 UI manifest，正在播放条成为它的 effect。服务商密钥的钥匙串在设置键有归属之前一直归设置 store（一条 `paths` 记录），见下文。偿还了两条基线中的方向边，`lib` 层最大的环从 168 降到 167。
  - 不走端口的部分。输入框打开的实时语音对话框和角色编辑器里的试听按钮是界面，所以它们是 speech 模块的 `api` 文件。手机的 `/me/speech` 页用「我的」页的组件编辑语音设置，仍归外壳。
  - 第二个端口 `ocr`。归属表里的内核行 `ocr` 变成了一个模块（`lib/ocr/module.ts`），由它提供端口（`types/modules/ports/ocr.ts`）：用户的 OCR 设置、宿主的识别依赖、计量过的 `extract`、PDF 路由（`pdfDeps`、`extractPdf`）、自动路由当前可用的 `candidates`，以及已注册的 `providers`。纯引擎仍是 `@cognia/ocr` 包，两端都直接 import：它的类型、`OcrError`、置信度工具，以及插件同步注册服务商用的注册表。智能体的屏幕工具、连接器收到的图片、采集增强、附件和数字分身的 PDF 兜底、工作流节点、回复助手的本地识别、发现页和插件 OCR API 现在都向端口请求。没有模块提供时，它们各自按自己的语义降级：不附文字、提取记为失败，或抛出带类型的 `unsupported_shell` 错误。安装内置服务商的运行时成为模块的 `ocr-runtime`：brain 一个适配器（重启时清空注册表），两个窗口宿主共用一个（用走代理的云端传输安装，账号切换重启时保留注册表）；它取代了 `OcrRuntimeInitializer` 和 brain 名单里单独的注册。设置分区移入 OCR 的 UI manifest。输入框通过 `api` 文件使用模块的 `useOcr` hook，和它使用 speech 的对话框一样；手机的 `/me/ocr` 页也通过 `api` 文件显示这个分区。半个应用都在用的两个字节工具，SHA-256 和图片字节处理，移到了基础层（`lib/utils/hash.ts`、`lib/utils/image-bytes.ts`）。偿还了两条基线中的方向边，`lib` 层最大的环降到 166。因为一个内核行变成了模块，模块数加一，并附了例外记录。采集增强以前读的是 `OcrResult` 里不存在的字段，所以从没附上过 OCR 文字；现在改读 `combinedMarkdown` 和 `combinedText`。
  - `docs-provider`，第一个集合端口。集合端口有多个提供方：它的契约合并进 `PortCollectionMap`，每个提供它的活动模块贡献一个成员，`loadPortCollection` 一次加载全部成员；某个成员加载失败只会被报告出来，不会挡住其他成员（`readPortCollection` 读取已经加载好的）。模块闸门允许这类端口有多个提供方。两个内置云文档来源离开了框架，各自成为模块：Google Docs（`lib/google-docs/`）和 Lark Docs（`lib/lark-docs/`），分别向端口（`types/modules/ports/docs-provider.ts`）贡献自己的 provider。`lib/docs-providers/` 里的框架仍属内核，从不 import 它们：注册表第一次被读取时开始加载成员，每个成员到达即注册，订阅者随之重新渲染；可能跑在这之前的两个调用方会先等它们，一个是 OAuth 深链（它本身就可能是唤起应用的那个链接），一个是留存副本的来源检查。必须在任何成员加载前就成立的东西仍同步留在框架里：每个内置项的文档 URL 规则，这样停靠栏标签页能恢复，来源记录也能保住 URL。来源记录的解析现在从这份目录读取它认识哪些 provider、哪些要保留 Lark 的 doc/docx 提示，不再点名厂商。这次移动顺带堵上了三处厂商泄漏：Lark URL 解析器并入 `@cognia/feishu-protocol`，Google 的宿主状态移到 Google 认证层（`lib/auth-providers/google/state.ts`），与厂商无关的 A1 区间构造留在框架里。Google 的登录流程（`config.ts`、`auth.ts`、`oauth-pending.ts`）暂时留在它的模块里，作为设置卡片使用的入口。Lark Docs 通过数字分身的 Lark fetcher 读文档，偿还了两条基线中的方向边；模块数加二，并附了例外记录。
- **M3 为设置键归属定下的规则，以 `speech`、`pet`、`ocr` 和 `eval` 为试点。**
  - 以 manifest 为准。`settings: { keys, section? }` 写明模块拥有哪些扁平的 `AppSettings` 键，以及由哪个设置分区重置和审阅它们；不写 `section` 时就是模块自己的 id。`lib/settings/section-keys.ts` 里这些分区在 `SECTION_OWNED_KEYS` 中的条目由 manifest 派生，只有内核的分区仍然手写。speech 分区现在还认领了自定义 SSML 和发音词典两个键，重置该分区时它们也会被清除。
  - 模块通过视图读写。`defineSettingsView(module.settings.keys)`（`stores/settings/view.ts`）在同一个设置 store 上提供 `get`、`use`、`subscribe`、`update` 和 `applyLocal`。读取看到的是整个设置对象，因为模块也会读内核的键；写入时只要补丁里有视图之外的键就抛错，什么都不保存。其他代码要读的试点各用一个 `api` 文件暴露自己的视图（`lib/speech/settings.ts`、`lib/pet/settings.ts`、`lib/eval/settings.ts`）；OCR 唯一的键本来就由它的分区和端口写入。只有一个模块用的 setter 离开了 `SettingsState`：六个朗读 setter 移到 `lib/speech/settings.ts`；服务商密钥的钥匙串镜像原是 speech 寄存在设置 store 里的状态，现在成了 speech 模块自己的 store（`lib/speech/provider-keys.ts`），钥匙串那条 `paths` 记录也从归属表里删掉了。`SettingsState` 的成员从 151 降到 139，设置 store 的导入方从 573 降到 531。
  - 门禁。G4：认领的键必须是 `AppSettings` 的键；它要被模块的文件或这些文件导入的 `@cognia/*` 引擎包用到（speech 的 Edge 和 realtime 键在 `@cognia/tts` 里读取）；模块的 `section` 必须是它 UI manifest 里的设置分区；`defineSettingsView` 只能在 manifest 模块的文件里调用，且只能传该模块自己的 `settings.keys`。设置 store 之外导入它、又用到别的模块所认领键的文件记为一条 `settingsAccess`，这是只减不增的新度量。现存十条，都在不能导入模块的代码里（G2）：输入框的语音控件、聊天的朗读、引导流程的本机扫描、存储保留、宠物的 agent 工具和插件宠物 API。它们会随内核自己的贡献一起移到所属模块的 `api` 之后。线上格式和 `packages/agent-config-types/src/settings-sync.ts` 没有变化。
- **M3 为提示词贡献定下的规则，以 `pet` 和 `radar` 为试点。**
  - 定义了代码自有提示词（ADR-0236）的模块，把它们列在 manifest 指向的一个文件里：`prompts: () => import("./prompts")`，该文件以 `prompts` 导出它们；每条定义仍放在解析它的代码旁边。提示词目录（`lib/prompts/catalog.ts`，属于内核）不再导入任何模块的提示词。生成器多写一份注册表 `lib/modules/generated/prompts.ts`，里面只有对每个模块 `prompts` 文件的懒加载导入，所以目录以及打包它的 CLI 不会加载任何 manifest 或其他功能代码。
  - 目录里随产品发布的列表仍是同步的；模块的提示词通过 `loadPromptCatalog()` 加入：它把每个活动模块的文件加载一次（`experimental` 模块不贡献），某个模块的文件加载失败或重复了已有 id 时，报告并警告、保留其他模块，并在下次调用时重试失败的那个。加载完成后，查询结果在随产品发布的提示词之后、插件的之前列出模块提示词。所有读目录的入口都先等它：Prompt Center 的代码槽列表、提示词配置导入、`ctx.agentConfig` 对代码槽的读写，以及 CLI 的 `prompts` 命令。发送路径仍从使用方自己的定义解析提示词，从不经过目录，所以发送不用等这次加载。
  - 门禁。G5：`prompts` 是懒加载入口，它的文件导出 `prompts`，磁盘上的提示词注册表与生成器输出一致。G4：文件（测试除外）调用了 `definePrompt` 的 manifest 模块必须声明 `prompts`。宠物的人设、灵魂和精灵孵化提示词以及 radar 的报告提示词已迁出，还清目录的两条方向基线；剩下十九条，都属于还没有 manifest 的模块。
- **M3 为能力授予贡献定下的规则，以 `browser-companion` 和 `goal` 为试点。**
  - 契约见 ADR-0198 的修订：模块的 `capabilityContributions: { load }` 文件导出 `contributions`，每个贡献从只读的运行上下文产出一个授予；内核为它加盖来源 `{ kind: "module", id: "<模块>/<id>" }`，拒绝调用方自己的字段（`model`、`provider`、`effort`、`maxTurns`、`permissionProfile`），并在原来折叠 `capabilityGrants` 的位置、调用方授予之后折叠它。`"skip"` 贡献只能加东西；凡是收窄的贡献声明 `"refuse-turn"`，失败时本次解析失败。生成器写出 `lib/modules/generated/capabilities.ts`（每个贡献文件一条懒加载导入），由 `lib/claude/capability-contributions.ts` 读取。
  - `build-options.ts` 原先导入的 21 个模块里，逐处核对（`docs/plans/2026-11-07-capability-contributions.md`）后只有五处是授予形状。其余的分三类：带权限规则集的进程内工具（filespace、协调者和 workflow runner 的工具、slash 命令工具、知识库工具、computer use），属于 `tools` 贡献；每轮检索的上下文（记忆、知识库、项目知识、twin），需要带放置位置、预算和引用的「上下文贡献」；解析器自己的管道（trace、quiet hours、LSP 配置、harness overlay、旁聊运行时），留在内核。
  - `browser-companion` 和 `goal` 成为 manifest 模块（它们的归属表行已删除），贡献各自的授予和提示词，还清四条方向边：`build-options.ts` 和提示词目录各指向它们的一条。`build-options.ts` 仍触达 19 个模块；`browser` 那条保留，因为解析器自己为已绑定的会话放行浏览器工具。A2UI、协调者的目标段和 IM 权限上限也是授予形状，但它们是否生效取决于解析器在折叠之后才算出的状态，要等这个判定前移后再迁。
- **修订（2026-11-07）：`tools` 贡献。** 给 agent 提供进程内工具的模块，在 manifest 里声明工具，在一个懒加载文件里实现。一个工具族过去要手工登记的其余部分，都由内核派生。调研和评审结论见 `docs/plans/2026-11-07-tools-contributions.md`。
  - 声明。`tools.declare` 是字面量数据：每个工具的名字、`consent`（`"allow"`、`"ask"`、`"per-call"` 或 `"default"`；`"default"` 不写规则，调用交给本次运行自己的审批，和没人写过规则的工具一样）、`effect`（`"read"`、`"write"` 或 `"outbound"`），以及可选的 `secrets: true`、`cancellable: false` 和 `precedence: "fallback"`。一个名字只由一个模块声明。
  - 实现。`tools.load` 指向导出 `toolFamily` 的文件。`surface(ctx)` 返回本次运行提供的已声明工具（带描述、schema 和可选的会话稳定 `instructions`），或 `null`。`run(name, args, call)` 执行一次调用，失败写进结果。上下文只读（会话、agent、设置、目标、提示词快照、宿主和工作区），不含 `SendOptions`。
  - 内核派生什么。只按 `surface` 实际返回的工具：最低一层规则集（bare 名和 `mcp__cognia-plugin-tools__` 名两种写法，用户自己的规则照旧覆盖它），以及逐次审批工具条目上的 `requiresApproval`。按声明，无论本次是否提供：`outbound`、`secrets` 权限类别，风险分类器的 `external-send` 集合和外发策略引擎的审查名单（`effect: "outbound"`），harness 探针的拒绝名单（所有非 `"read"` 工具），以及实时语音不宣告的工具（`cancellable: false`）。同意档再也不会脱离它管的工具单独出现。外发引擎的目标抽取和结果卡暂时留在原处；没有抽取器的外发工具按未知目标审查。
  - 失败。工具族的文件加载失败、`surface` 抛错或超过共同的截止时间、提供了未声明的工具或别的模块已提供的工具，就不进本次运行，并报告。工具只会增加能力，所以没有哪种失败会拒绝本轮。`experimental` 模块什么也不提供，也不参与分发。
  - 分发。`handlePluginToolExec` 按声明的名字把调用路由到模块，排在所有内建工具和插件注册表之前；`precedence: "fallback"` 的工具排在注册表之后（替代插件通常注册的同名工具）。结果照旧过 PII 检查，调用带着它的外发授权。所有解析发送并执行 `handlePluginToolExec` 的宿主（桌面、CLI、brain、外部 agent、独立对话）都不用各自接线就能用上模块工具。
  - sidecar。sidecar 是独立项目，保留字面量的 `PER_CALL_PLUGIN_TOOL_NAMES`。门禁检查它包含每个声明为 `consent: "per-call"` 的工具。
  - 代码位置。生成器写出 `lib/modules/generated/tools.ts`（声明数据加每个工具族一条懒加载导入）。`lib/modules/tool-declarations.ts` 不加载模块就能回答关于声明的问题，`lib/claude/tool-contributions.ts` 收集 surface 并执行调用。贡献的条目和说明在今天协调者工具加入的位置进入运行。
  - 不属于模块工具的。随工具族一起的每轮上下文（协调者的项目状态、知识检索）等上下文贡献。slash 命令工具读的是壳的注册表，computer use 的聊天端审批策略管的是插件的工具、自己不提供工具；两者都留在内核。试点先是 filespace，然后是项目协调者的工具和协议段。
  - `filespace` 是第一个（2026-11-07）。它成为 manifest 模块（归属表的行删除，share、collab、artifact、terminal、account-sync 的行把它用到的文件列为 `api`），工具族搬到 `lib/filespace/agent-tools.ts`，手写的同意档、解析器里的两段、分发器的分支，以及权限类别、风险和探针名单里的名字都已删除。它的运行提供的工具和同意档与之前相同。还清四条方向边：`build-options.ts` 和 `plugin-tool-ipc.ts` 指向 filespace 的两条，以及旧工具文件指向 filespace 和 share 的两条。
  - 项目协调者是第二个（2026-11-07）。它成为 manifest 模块（chat、issues、usage、memory、tasks、fleet、stack 的行把它用到的文件列为 `api`），两套工具族搬到 `lib/project-coordinator/agent-tools.ts`：`surface` 给协调者它的工具和协议段，给线程汇报工具和线程协议段。手写的同意档、分发器的分支，以及探针和实时语音名单里的名字都已删除。它的运行提供的工具和同意档与之前相同，协议段在提示词里的位置不变。每轮的项目状态段和项目目标段在有上下文贡献之前留在解析器里，所以 `build-options.ts -> project-coordinator` 保留；还清另外三条方向边：`plugin-tool-ipc.ts` 指向协调者的一条，以及旧工具文件指向协调者和 tasks 的两条。
  - 桌面宠物随后（2026-11-07）。宠物本来就是 manifest 模块，所以只迁工具：工具族搬到 `lib/pet/agent-tools.ts`（`selfInvokeTools.pet` 打开后在桌面宿主上提供，宠物偏好通过它自己的设置视图读取），手写的同意档、解析器里的开关和追加段、分发器的分支，以及探针名单里的名字都已删除。它的运行提供的工具和同意档与之前相同（`pet_show` 询问）。还清一条方向边和一条 `settingsAccess` 记录，设置 store 的导入者少了一个。
  - artifact 和 media 随后（2026-11-07）。两者都成为 manifest 模块。manifest 的 id 现在取其目录对应的子系统键，所以 `lib/artifacts/module.ts` 的 id 是 `artifact`，与分类器早就把复数目录归给它一致。artifact 与 canvas 工具族搬到 `lib/artifacts/agent-tools.ts`（发送端有停靠栏时提供：不是绑定 IM 的会话、不是 CLI，且没有关闭代理创作；移动壳上不提供 canvas），视频工具族搬到 `lib/media/agent-tools.ts`（同样的停靠栏条件，加上一个可达的视频提供方）。它们的同意档（`artifact_delete`、`video_generate` 询问）、解析器里的段落、分发器的分支和探针名单里的名字都已删除。`artifact` 成为 manifest 后与 filespace 形成 `dependsOn` 环：filespace 读 artifact，而 `components/artifacts/` 下的会话停靠栏 import 了 filespace 的文件面板和复制链接。现在文件面板由 filespace 的 UI manifest（`effects`）注册进上下文面板注册表，停靠栏编辑器经由 filespace 提供的新端口 `conversation-file-links` 复制链接。还清三条方向边。实时语音不再提供这些工具：它们的运行器不接取消信号，不可取消名单以前漏登了它们。
  - Sites 和 vector 随后（2026-11-07）。两者都成为 manifest 模块。Sites 工具族搬到 `lib/sites/agent-tools.ts`（在桌面宿主上提供：发布要用的 Dexie、钥匙串和系统沙箱只在那里），`deploy_site` 现在声明为 `effect: "outbound"`，风险集合和权限类别按声明计入它，不再按名字。vector 工具族连同依赖解析搬到 `lib/vector/agent-tools.ts`（`selfInvokeTools.vector` 打开后，在桌面上提供给有项目的运行）。它通过一个不认领任何键的设置视图读内核的提供方设置，并且现在把本轮的中止信号传给存储调用。vector 工具以前没有同意档，所以声明为 `consent: "default"`：不写规则，仍由本次运行自己的审批决定，与之前一样。Sites 的同意档、解析器里的段落、分发器的分支，以及探针、实时语音、风险和权限类别名单里的名字都已删除。还清三条方向边。templates 工具族暂时留在内核：它还会套用 squad 模板，而 squads 依赖 templates，要先在两个模块之间拆开。
  - 托管桌面验收和编辑器工具随后（2026-11-07）。`automation` 成为 manifest 模块：验收工具族搬到 `lib/automation/agent-tools.ts`，在桌面宿主上提供（证据工具给验收运行挂靠的子会话，提议工具给其他不绑定 IM 的对话）。`codeserver`（Pro IDE）成为 manifest 模块：编辑器工具族连同依赖解析搬到 `lib/codeserver/agent-tools.ts`，有工作区且宿主有工作区文件系统后端时提供读取工具，再有 Pro IDE 能力时提供五个写入工具。编辑器工具归 `codeserver` 而不是 `editor`，因为后者会与 `artifact` 形成 `dependsOn` 环。它们的同意档、解析器里的段落和 `proIdeWriteToolsAvailable`、分发器的分支，以及探针和实时语音名单里的名字都已删除。`read_active_editor` 以前没有同意档，又几乎在每个带工作区的桌面回合都提供；声明为 `"ask"` 会让这些回合多出一个以前没有的规则集，所以为它和 vector 工具新增了 `consent: "default"`。还清两条方向边。
  - `spawn_task` 在拆掉阻挡它的环之后跟进（2026-11-07）。聊天停靠栏不再自己绘制 Tasks 面板：`tasks` 成为 manifest 模块，它的 UI manifest 挂一个副作用，把面板注册进上下文面板注册表（与 Files 面板做法相同）；sidechat 面板 id 移到 `artifact`。工具族搬到 `lib/tasks/agent-tools.ts`，在设置开启 `spawnTask` 时提供，手机宿主除外。`spawn_task` 以前没有同意档，所以声明为 `consent: "default"`。它在解析器里的段落、分发器的分支以及探针和实时语音名单里的名字都已删除，还清两条方向边。
  - Agent Builder 的工具随后（2026-11-07）作为 `agent-builder` 模块迁出：工具族 `lib/agent-builder/agent-tools.ts` 在 builder 对话里提供四个工具，builder 协议作为它们的 instructions。按主题它们归 agent 子系统，但那是内核；内核子系统要贡献工具就得变成模块，而所有内核调用方都会导入它。所以这些工具单独成为一个模块，通过内核的 lib 访问 builder 的会话和草稿。当时 builder 的实时草稿是每轮的段落，仍由发送路径添加，所以 builder 其余部分留在内核，等上下文贡献（同日稍后已迁入，见下）。它们的同意档文件、分发器分支和探针名单里的名字都已删除。
  - 模板工具随后（2026-11-07）分到两个模块。`templates` 成为 manifest 模块，工具族 `lib/templates/agent-tools.ts` 提供模板目录和已存聊天模板的工具；三个 `squad_*` 工具归 squads 模块的工具族 `lib/squads/agent-tools.ts`。两族由同一个设置（`selfInvokeTools.templates`）开启，都不提供给绑定 IM 的会话和 CLI；每次写入仍在迁移前授权所用的主体（`cognia-template-builtin`）下询问插件同意代理，所以八个工具都按原同意档声明为 `allow`。只拆工具还不足以让 `templates` 成为 manifest：它的运行时通过 agent-team store 实例化和读取 squad 模板，而 squads 依赖 templates。平台的这一侧现在是 squads 提供的 `squad-templates` 端口，templates 用 `loadPort` 取用。同意档文件、解析器的门槛和追加段、分发器分支及其依赖注入、探针名单里的名字都已删除。还清方向边 2 条。
  - Squad 协作工具随后（2026-11-07）迁入 squads 模块的工具族，该族现在分两半：`lib/squads/collaboration-tools.ts`（十二个 `team_*`、`task_*` 和 `twin_knowledge_search` 工具，`selfInvokeTools.teamCollaboration` 开启后提供给小队派发会话，团队消息协议作为它们的 instructions）和 Squad 模板工具，由 `lib/squads/agent-tools.ts` 组合，调用按名字路由到声明它的那一半。工具族把每次调用绑定到该会话派发时的队员，来自其他会话的调用一律拒绝，与原分发器一致。这些工具以前没有同意档，所以声明为 `consent: "default"`；`team_post_to_chat` 声明为 `write` 而不是 `outbound`，因为把它算作外发会让每次无头 IM 小队运行都失败关闭（ADR-0070），外发引擎仍按名字审查它。按知识 twin 决定是否提供 `twin_knowledge_search` 的检查从解析器移进工具族。解析器的追加段、分发器分支、探针和实时语音名单里的这些名字都已删除。还清方向边 4 条，其中包括 `build-options -> squads`。
- **修订（2026-11-07）：`context` 贡献。** 模块往一次运行的系统提示里加文字，经由 manifest 贡献，不再在发送路径里加分支。现状调查和评审结论见 `docs/plans/2026-11-07-context-contributions.md`。
  - 声明。`context.load` 指向一个导出 `contributions` 的文件。每条贡献有 `id`、`cache` 类别（`"turn"` 每轮变化，`"session"` 会话内稳定）、可选的 `slot`（内核的封闭列表：`project-goal`、`memory`、`continuity`、`project-knowledge`、`agent-knowledge`，按 `systemPrompt` 中的顺序）、可选的 `pii: "redacted-at-source"`、经网络检索时可选的 `deadlineMs`，以及返回段落（`text`、可选 `sources`、可选 `sessionState`）或 `null` 的 `produce(ctx)`。上下文在工具 surface 的上下文之外，还带本轮的查询、调用方注入的宿主依赖（按名字，类型由 `ContextHostDepsMap` 合并声明）和折叠后的能力授予。
  - 放置。所有段落由内核放置，模块从不写 `SendOptions`。turn 段在开启缓存优化时进动态尾部，关闭时进它的 slot；没有 slot 的总是进尾部。session 段必须指明 slot，并且总是放在那里。尾部先按 slot 顺序列出 turn 段，再列没有 slot 的，每组内按模块 id 排序，所以从发送路径迁出的段落保持原分支给它的位置。
  - PII。内核检查每段文字，泄露的连同其 sources 一起丢弃，除非贡献声明文字在来源处已脱敏。
  - 旁路输出。贡献报给界面的内容放在 `SendOptions.contextSources`，键为 `<module>.<id>`，类型由合并进 `ContextSourcesMap` 声明（用 `contextSourcesOf` 读取）。`sessionState` 由内核按会话保存（`lib/claude/context-session-state.ts`，保留最近 64 个），同一模块的工具通过 `ToolCallContext.sessionState(id)` 读取；模块不再在解析时以副作用登记每会话状态。
  - 失败。上下文只做加法：贡献文件加载失败、抛错、超时或段落没有文字，都只是跳过该部分并上报，从不拒绝这一轮。
  - 位置。生成器写 `lib/modules/generated/context.ts`；`lib/claude/context-contributions.ts` 负责收集和放置；门禁检查 manifest 形状和 `contributions` 导出，读取方在文件加载时检查每条贡献的字段。
  - 不属于上下文贡献的。执行中计划的段落是内核自己的。活动目标已经作为能力授予的 instructions 进入。（分身和记忆召回最初因为分身替换身份段、召回要读分身取回的内容而留在这里，后来经 `identity` 位和 `after` / `kernelRetrieval` 迁出，见下文。）
  - 项目协调是第一个（2026-11-07）：`lib/project-coordinator/context.ts` 贡献项目目标（session 段，放在 `project-goal` slot，给协调者和它的线程）和协调者的实时项目状态（没有 slot 的 turn 段，所以无论是否开启缓存优化都在尾部）。两个分支都离开了发送路径，方向边已还清。一次运行发送内容的唯一变化：状态段现在和其他段一样要过内核的 PII 闸，以前不经检查直接发送。
  - Agent Builder 随后（2026-11-07）：实时草稿成为 `lib/agent-builder/context.ts`，一个没有 slot 的 turn 段；发送路径不再导入 builder 之后，builder 的其余部分也搬进了 `agent-builder` 模块：会话、草稿和目录代码来自 `lib/agents/builder/`，视图从 `components/agents/builder/` 搬到 `components/agent-builder/`，运行时工具支持 hook 搬到 `hooks/agent-builder/`。agents 页面通过模块的 `api` 使用 setup、workspace 和草稿列表视图（内核的 UI 层按模块计），模块用到的 chat 和 agent 视图列进它们所在行的 `api`。草稿现在要过内核的 PII 闸；同一份草稿经 `agent_builder_get_draft` 读出时本来就要过，所有工具结果都是如此。
  - 可复用知识库随后（2026-11-07）成为 `knowledge-base` 模块。`lib/knowledge-base/context.ts` 贡献两条：`reader` 不加文字，它算出这次对话能读什么（agent 绑定的知识库，再按授予和调用方的上限收窄），渐进阅读开启时还有这些库上的阅读器，作为会话状态留下；`retrieval` 是这一轮检索到的摘录，放在 `agent-knowledge` slot 的 turn 段，截止 15 s，块和引用经 `contextSources["knowledge-base.retrieval"]` 传出（`SendOptions.agentKnowledgeContext` 字段已删除，它的四个读取方改用 `contextSourcesOf`）。`knowledge_*` 读取工具是模块的工具族（`lib/knowledge-base/agent-tools.ts`，`consent: "default"`、`effect: "read"`），只提供给 `reader` 建出了阅读器的运行，连同阅读指引。为此工具的 surface 现在也能读本模块的会话状态（`ToolSurfaceContext.sessionState`）。嵌套派发和插件 project API 经 `lib/knowledge-base/runtime/session-reader.ts` 读同一份记录；会话销毁时经内核的 `forgetContextSessionState` 丢掉所有模块的状态。一次运行得到的内容有三处变化：文字或文档标题泄露 PII 的检索块在计入预算前被剔除，其余块照常进入提示词（整段随后再过内核闸）；知识工具和指引跟其他贡献工具放在一起，不再排在 working-set 工具之后；不再使用的记录在对话跌出最近解析的 64 个时也会失效。还清四条方向边。
  - 工作区知识库随后（2026-11-07）成为 `project-knowledge` 模块（所有权表里的行改为 manifest）。`lib/project-knowledge/context.ts` 贡献 `retrieval`：本次运行所在工作区知识文件的摘录，放在 `project-knowledge` slot 的 turn 段，截止 15 s，经 `contextSources["project-knowledge.retrieval"]` 上报；`SendOptions.projectKnowledgeContext` 已删除，它的四个读取方改用 `contextSourcesOf`。模块同时声明 `hostDeps.projectKnowledge`，两条知识贡献都读这个检索运行时。与 agent 知识库一样，正文或文件名泄露 PII 的块被剔除，其余照常进入提示词；以前整段不经检查直接发送。尾部顺序不变：按 slot，工作区摘录排在 agent 摘录之前。发送路径里最后一个知识分支已删除，方向边已还清。
  - 先后与内核检索（2026-11-07，为记忆和项目连续性准备；计划 §12）。贡献可以声明 `after`，指向同模块里它要等的另一条贡献。被等的那条在段的 `handoff` 里交出一个值，等待方以 `ctx.prior` 读取；handoff 只在本次解析内传递，不进提示词、来源或会话状态。只允许一层：被等的那条自己不能再声明 `after`，所以不会成环；读取方在文件加载时检查，不合格就跳过整个模块。被等的那条失败、超时、返回 `null` 或没有交出东西时，`prior` 不存在，由等待方决定怎么退化。等待方的截止时间从对方结束时算起。其余贡献照旧并发，放置照旧按 slot，与运行先后无关。`ctx.kernelRetrieval.twinChunkTexts` 是分身取回块的脱敏文本：发送路径在收集上下文之前已经检索过分身，记忆召回可以据此去掉提示词里已有的内容；分身离开发送路径时，这个字段改由分身自己的贡献提供。
  - 记忆成为 manifest 模块（2026-11-07），行为不变，为召回和项目连续性改成上下文贡献做准备。它的六个写入和重排提示词离开 `lib/prompts/catalog.ts`，改由 `prompts` 贡献提供（`lib/memory/prompts.ts`）。它的 `api` 列出别处用到的 21 个文件（外部桥和工作流节点调用的记忆 API、控制面、外部 home 发现、轮次 runner、事件总线、工作台视图），chat、rag、governance、inbound、inbox 的行列出它用到的文件。`ConfirmActionDialog` 从 `components/squads/settings/` 移到 `components/shared/`：它是通用组件，记忆借用它是 squads 与 memory 成环的唯一原因。两个记忆视图改从 `useClientLiveQuery` 自己的文件导入，而不是 `hooks/data` 汇总导出（汇总文件不能做 `api`）。目录的方向边已还清。
  - 记忆召回和项目连续性随后（2026-11-07）迁为 `lib/memory/context.ts`：`recall` 放在 `memory` slot 的 turn 段，去掉分身已取回的内容（`ctx.kernelRetrieval.twinChunkTexts`），并交出自己的召回预算；`continuity` 放在 `continuity` slot 的 turn 段，`after` `recall` 运行，借用它剩下的预算（没有交接时不借，与以前召回没跑时相同）。两段各 15 s。调用方的记忆输入经 `hostDeps.memory`、`hostDeps.memoryQuery`、`hostDeps.memoryScope`（`targetAgentId`、branch、path）传入，由模块声明；审计事件、策略收窄和投递回执不变。`SendOptions.memoryContext` 和 `projectContinuityContext` 已删除，读取方改用 `contextSources["memory.recall"]` 和 `["memory.continuity"]`。发送路径还剩一处读记忆：项目历史工具用 `resolveMemoryConfig` 判断是否提供，所以方向边保留，等这个工具迁进模块的工具族。至此发送路径里只剩分身一个检索段。
  - `project_history_search` 随后（2026-11-07）迁为 memory 模块的工具族（`lib/memory/agent-tools.ts`，执行逻辑搬到 `lib/memory/project-history-tool.ts`）。`surface` 沿用原来的闸：会话属于某个工作区（会话自己的，否则取本次运行的）、项目连续性已开启、不是临时对话。声明为 `default`/`read`，不可取消（执行逻辑不接收 signal）。分发器的分支、`plugin-tool-ipc.ts` 里的依赖解析和发送路径里的块都已删除；工具改用插件 id `cognia-memory-builtin`，没有读取方依赖旧 id。至此发送路径不再读取记忆：`build-options.ts -> memory` 和旧工具文件指向外部桥的方向边已还清。
  - 身份位（2026-11-07，为分身准备；计划 §17）。`ContextSlot` 增加 `identity`，它不是位置而是替换：这一段取代 agent 的基础系统提示词，persona 段随之省略。段可带 `cacheSplit: { stable, dynamic }`；缓存优化开时稳定部分替换基础提示词、动态部分排在动态尾部最前，否则整段替换。全应用最多一个模块声明它（模块门禁在各上下文文件里找 `slot: "identity"`；万一加载到两个，按模块 id 取第一个，另一个上报）。身份贡献先单独运行，有自己的截止时间，不能声明 `after`，也不能被 `after` 指向；它交出的脱敏文本（字符串列表）以 `ctx.kernelRetrieval.identityTexts` 交给其余每条贡献，取代 `twinChunkTexts`，记忆召回因此不再知道是哪个模块取回的。泄露 PII 的身份段（全文或任一切分部分）连同来源一起丢弃，什么也不交出；没有文字的身份段仍交出取回的文本。
  - 分身成为 manifest 模块（2026-11-07），行为不变，为身份段迁移做准备。它的十五个蒸馏、重排和系统模板提示词离开 `lib/prompts/catalog.ts`，改由 `prompts` 贡献提供（`lib/twin/prompts.ts`），目录的方向边还清。有两处导入会经由已经依赖分身的模块成环，各改成一个分身声明需要、但没有也能运行的端口：`memory-namespaces`（memory 提供；分身的生命周期经它让删除的分身对应的记忆失效）和 `eval-benchmarks`（eval 提供；人设页的基准按钮经它建数据集，没有提供方时不显示）。CLI 桥的分身处理器改为导入运行时文件本身，不再经 `lib/twin/runtime` 汇总导出。
  - 分身的身份段随后（2026-11-07）迁为 `lib/twin/context.ts`：`identity`，`identity` slot 的 turn 段，截止 15 s。agent 绑定了分身、调用方传了 `hostDeps.twin` 和非空的 `hostDeps.twinQuery` 时运行（`hostDeps.twinInjectSource` 标注注入日志）。文字是分身提示词，`cacheSplit` 是模板的稳定与动态两段，交出的是检索块的脱敏文本（记忆召回据此去重），来源是 `contextSources["twin.identity"]`，降级时也上报。它仍自己检查拼好的提示词是否泄露 PII，泄露时不交出并记 `prompt-pii-blocked`；并比内核截止早一秒放弃，好让注入日志记下 `timeout`。`SendOptions.twinContext` 已删除，聊天钩子、房间 runner、grounding 和压缩改用 `contextSourcesOf` 读来源。发送路径不再导入分身，`build-options.ts -> twin` 已还清；发送路径里不再有检索段。

**模块之间怎么通信。**
- **公开接口文件。** 一个模块只能通过另一个模块 `api` 里列出的具体文件，以及 `types/<id>/**`，来 import 它。不建 barrel，这是 `check-root-loading-boundaries` 已有的要求。对方必须写在 `dependsOn` 里，且 `dependsOn` 图无环。
- **能力端口。** 内核定义端口，模块或插件通过 `provides` 提供实现，使用方通过 `requires` 声明需要。目前的端口有：`ocr`、`speech`、`web-reader`、`web-search`、`docs-provider`、`forge`、`remote-desktop`、沙箱后端、IM 适配器，以及订阅、余额、模型目录。端口的形状参照 ADR-0246 的授权连接。
- **类型化事件。** 需要反转依赖时，用内核的事件总线，事件类型由发布方在 `types/<id>/events.ts` 中声明。
- **贡献点。** 外壳和内核只通过 manifest 字段收集各模块的东西。

**先定归属，后搬家。** 每个非测试源文件恰好有一个所有者：某个模块、某个内核成员、基础层或外壳。还没有 manifest 认领的文件由一份过渡归属表兜底，它的行数是一个棘轮。文件只在所属模块下次被修改时才搬，这样共享工作区不会遭遇大规模改路径。

**厂商分三层。** 一个厂商从来不是一个单元，按每部分的性质拆开：

| 层 | 内容 | 形态 | 可以依赖 |
| --- | --- | --- | --- |
| 1. 协议库 | API 客户端、签名与验签、分页、错误映射、数据类型。不含业务，不持有凭据，没有状态 | 不 import `@/` 的包，例如 `packages/feishu-protocol`。Rust 部分留在各自的 crate | 只依赖基础层 |
| 2. 认证提供方 | 登录、账号、刷新、轮换、登出、回调，例如 `auth.feishu` | 基础插件（`feishu-auth`），或内置的 Rust provider（`auth.google`） | 自己的协议库 |
| 3. 业务实现 | 每个能力端口一个：IM 适配器、云文档、issue 同步、日历、备份、OCR | 归端口所在的模块，或者做成插件 | 凭据只经 ADR-0246 的授权连接获取；只 import 协议库；业务实现之间互不 import |

- 协议库做成包而不是库插件，是因为 ADR-0246 还没有定义库插件怎样服务业务插件（接口版本、账号范围）。它不持有凭据、没有状态，所以可以放心共用。
- **飞书先做（M1）。** `packages/feishu-protocol` 包含部署定义、scope、PKCE、OAuth 与 tenant token 请求、响应信封、错误码和分页，HTTP 传输由调用方传入。认证层在 `lib/auth-providers/feishu/`，与 `auth.google` 并列：token 缓存、用户 token 刷新与重试包装、OAuth 发起、待处理记录和回调、宿主连接 provider，以及云文档、issue 同步、Twin 读取时使用的鉴权 API。它调用的 connectors 宿主桥（connectors crate 的 Tauri 绑定、事件监听、服务入口和凭据轮换事件）只依赖基础层，所以归属表把它归到 `tauri`，把 connector OAuth 的 state key 和 scope 审计归到 `oauth`。这次迁移没有新增 G2 边，还偿还了 8 条。这个包只走源码，通过 `@cognia/feishu-protocol` 路径别名解析。它暂时不进 pnpm workspace：新增 workspace 成员会在锁文件里多一个 importer，导致插件 authoring kit 的 pin 失效。下次重建 kit 时再加入。
- **框架与厂商无关。** IM、云文档、issue 同步、备份、调度这些框架里，不出现厂商名，也不 import 厂商实现。厂商专用的行为，比如飞书的运行展示驱动，由业务实现以贡献的形式提供。由 G8 把守。IM 框架里的贡献是 `ConnectorVendorContribution`（`lib/connectors/vendor-contribution.ts`），收的是框架手里没有运行中适配器时需要的东西：静态能力、适配器工厂、身份探测、OAuth 完成、被动心跳、头像、启动服务、命令卡片和审批卡片、最终回答卡片、运行卡片，以及 principal 注册表。运行中适配器自己的钩子仍在 `PlatformAdapter` 上。每个框架从实现旁边的一份目录读取它的实现（`lib/connectors/adapters/_vendors.ts`、`lib/docs-providers/providers/_builtin.ts` 和 `_document-urls.ts`），目录只能 import 各实现的入口文件。贡献只在加载时 import 轻量常量，其余在钩子里按需加载。M1 做完了飞书：它的构建器、网页入口和客户端、运行卡片和 principal 注册表搬到 `lib/connectors/adapters/lark/` 下，文档 URL 解析搬进飞书文档 provider。这个接缝属于宿主内部，不是插件契约的一部分。
- **一个厂商的全套一起分发。** "一键安装某厂商全套"用 cogset（ADR-0209）组合，这是分发层的打包，不是代码依赖。
- 同样的拆法适用于 Google（协议库、`auth.google`、Drive 备份和 Docs）、GitHub（由 `octokit-factory` 和 `auth-app` 组成的协议库、GitHub 连接、`forge` 实现、`backup-github`、runner），以及各家订阅（协议库、账号登录，再加订阅、余额、模型目录三个端口的实现）。

**门禁。** G1、G2 和 G6–G8 合在一个门禁里运行：`scripts/gates/check-modules.mjs`（`pnpm audit:modules`），注册在 `scripts/gates/check-all.mjs`。它用 `scripts/gates/convergence/counter.mjs` 的源码读取器和解析器读取源码、解析 import。它的棘轮是过渡归属表 `scripts/gates/module-ownership.json` 和 `scripts/gates/modules-baseline.json`，两者都登记在 `scripts/gates/baseline-growth.json`，与合并基准比较（§11）。G5、G3 和 G4 在 M1 并入。下表的数字是门禁在 M0 时自己的计数，标明 M1 的是 M1 时的计数。

- **外壳的贡献工具包。** 外壳把模块构建贡献时要用的文件，作为 `api` 列在归属表里：设置分区工具包（`components/settings/common/`）、搜索 provider 辅助函数、移动端 spot 图标。import 这些文件不算 G2 违规边；import 外壳的其他文件仍然算。
- **生成的注册表**是唯一被允许的"内核 → 模块" import，因为它们负责收集各个模块。G5 检查它们，它们不算 G1、G2、G6 的源文件。

| 门禁 | 检查什么 | 度量 | 起始 |
| --- | --- | --- | --- |
| G1 归属 | 每个非测试源文件恰好有一个所有者；`owner` 与 `.github/CODEOWNERS` 一致 | 过渡归属表的行数，只降不升 | M0，阻断 |
| G2 方向 | 基础层 → 上层、内核 → 模块 / 插件候选 / 外壳、模块 → 外壳的值 import。内核成员的 app、components、hooks 文件算作它的界面模块 | 违规边按"文件 → 所有者"取指纹（M0 时 1,124；M1 列出外壳工具包后为 1,088），只降不升 | M0 只报告；自 M1 起阻断 |
| G3 公开接口 | 跨模块 import 只能到达 `dependsOn` 目标的 `api` 文件，或 `types/**`；`api` 文件不能是 barrel（只有一条再导出的文件，即代码搬进 package 后留在原路径的转发文件，不算）。只判进出有 manifest 的模块的 import；仍在过渡表里的子系统等有了 manifest 再纳入，在此之前它的行（kernel 成员则为其 UI 模块）可以列 `api` | 违规 import，按 `文件 -> 目标` 记指纹（M1 时为 0），只降不升 | M1 |
| G4 声明与实际一致 | `dependsOn`、`tables`、`settings.keys` 与实际的 import、表访问、键读取一致；brain 适配器在 brain 的模块图里被调用（沿用 `check-headless-registry` 的规则：要被调用，可达不算）；`runtime-initializers` 的每一项已迁移或已归为副作用。M1 里：`dependsOn` 恰好等于 manifest 所在模块的文件实际 import 到的模块；声明的表或键必须存在、被本模块文件访问，且只有一个认领者。M2 起：通过 import 的 `lib/db/` 文件访问到的表算作已访问；只有一个 manifest 模块 import 的 `lib/db/` 文件由它认领；模块的文件访问另一个模块认领的表，记为一条 `tableAccess`；每个运行时适配器都能解析并导出 `start`，没有适配器的宿主在 `absent` 里写明原因，roster 注册每个 brain 适配器，所以每个都在 brain 上被调用。M3 起：`requires` 恰好等于模块文件实际请求的端口；认领的设置键是 `AppSettings` 的键，模块的设置 `section` 存在，只有 manifest 模块能定义设置视图且只能覆盖自己的键，用到别的模块所认领键的文件记为一条 `settingsAccess`；文件里定义了代码自有提示词的 manifest 模块，要通过 `prompts` 贡献它 | 不一致为 0；`tableAccess` 与 `settingsAccess` 只减不增 | M1 |
| G5 生成 | manifest 只含数据，懒加载入口都能解析；贡献项形状正确、图标在图标目录里、模块之间不冲突；生成的注册表与生成器输出一致，所以没有手写条目 | 0 | 每迁一份注册表启用一份：自 M1 起覆盖设置分区、搜索 provider 和 slash 命令；自 M2 起覆盖导航（图标、插画、取值范围、完整 key）、插槽名、按宿主分开的运行时注册表和副作用的形状；自 M3 起覆盖端口提供（端口已声明、导出 `port`、每个端口一个提供方、每个必需端口都有提供方）、提示词注册表（`prompts` 文件导出 `prompts`）、能力注册表（`capabilityContributions.load` 文件导出 `contributions`）和工具注册表（`tools.load` 文件导出 `toolFamily`、一个工具名只由一个模块声明、每个逐次审批工具都在 sidecar 的 `PER_CALL_PLUGIN_TOOL_NAMES` 里） |
| G6 环 | `dependsOn` 图无环；`lib/` 层所有者图里最大强连通分量的大小（168；分析按原始目录数出的是 150） | 只降不升 | M0 |
| G7 规模与加载 | 模块数、`experimental` 数、表数、`SettingsState` 成员数、设置 store 的引用文件数（573，含类型 import），以及从 M1 起生成的注册表在 manifest 之外急加载的文件数（M1 时为 1：`lib/modules/define.ts`），以及从 M2 起没有 manifest 认领的核心表数（380）和只被一个尚无 manifest 的模块 import 的 `lib/db/` 文件数（37） | 只降不升；例外要有记录 | M0 |
| G8 框架与厂商无关 | 框架目录里没有按厂商名分支、没有以厂商命名的文件，也不 import 厂商实现。沿用 `check-provider-name-branches.mjs`（ADR-0090）的做法，加上基线 | 违规项（M0 时 166，大多在 connectors 框架里；M1 做完飞书后 107），只降不升。目录 import 框架文件和实现入口文件以外的东西，也算一项 | M0 |

子系统的键来自 `scripts/gates/lib/subsystems.mjs`，依赖分析脚本也用它，所以两者对任何路径的归属都一致。

**迁移。** 模块线就是 §13 里的 M0–M4。试点顺序：`squads`（M1 的三类注册表）、`eval`（归属表）、飞书三层（G8 和协议包）、`speech`（第一个端口，M3）、`pet`（依赖反转，M2）。

**随归类一起记录的决定。**
- 解散 `lib/claude`：它的内容早已不只针对 Claude。内核部分按职责改名（例如放到 `lib/runtime/` 下），功能工具通过 `tools` 归各自模块，`build-options` 在 M3 改为能力授予贡献。
- 删除候选，删除前各自核实：`lib/scheduler/legacy-db-migration.ts`（没有用户还停在旧库版本）、A2UI 的 academic 模板 `types/academic` 和 `components/a2ui/academic`（没有模型还会产出它们）。
- `creator` 并入开发者工具模块，标为 `experimental`。

**本节不决定的事。**
- M0 何时开始，以及产能怎样与内核各阶段分配。
- 模型路由收敛：`provider-routing` 的 `planRoute`、`router-fusion`、Rust 网关的 planner、`lib/routing` 和 `lib/usage` 的预算部分。另做专项分析。
- `sites` 另写一份简短的 ADR：定位、边界、对 Cloudflare 的依赖和插件化路径。

## 后果

- **桌面和 Host 仍然是同一个内核的两个宿主。** 它们在不同的进程里启动同一个注册表。一致性靠适配器矩阵和双宿主测试通道保证，而不是靠运行同一个程序。换来的是：桌面不需要第二个进程，没有额外的启动开销，也不需要数据迁移。
- **S1 暴露了常驻 Host 的 brain 已知的代价。** 大账户上崩溃后约 37 秒才能重新提供服务，常驻内存约 3.8 GB。持久化还会丢失非 JSON 值，这一点由阶段 0b 修复。落盘的 brain 存储是 ADR-0224 Host 的后续工作，也是重新考虑 2a 的前提。
- **插件破坏一次，** 在阶段 2。第一方插件届时重写，旧契约作为冻结的历史保留可读。
- **未来几个月约一半产能**投入收敛。进度以无法悄悄调高的清单来度量。
- **有些行为会改变。** 过去只因为窗口开着才生效的行为，今后在触发时发生。断线期间的写入，今后作为意图等待，而不是落进后备存储。每一项变化都记录在所属阶段的证据台账里。

## 待定问题

- **新的插件契约**，另写一份 ADR。
- **WebView 内核在大数据量账户下的存储预算**，在阶段 2 开始时确定。
