# 模型路由收敛分析与目标结构（草案）

> 日期：2026-11-05<br>
> 基线：`dev`，HEAD `03d7e75b43`。共享工作区，文中的行号取自写作时的工作区，其他会话继续改动后可能漂移，复核时以符号名为准。<br>
> 方法：
>
> - 静态阅读加 grep，没有运行应用，也没有跑测试。唯一运行过的是只读的 `node scripts/gates/check-router-fusion-gate.mjs`。
> - 六条调用面的盘点先由只读子任务做出初稿，随后本文作者对其中会写进结论的数字逐条回到源码核对。核对不了的列在 §9。
> - 引用格式 `path:line`。ADR 引用的是英文版 `docs/content/docs/en/adr/`。
>
> 关联：ADR-0250 §14（五类、模块清单、G1–G8、M0–M4）、[功能模块化分析 2026-11-04](./feature-module-analysis-2026-11-04.md)、ADR-0090（统一执行与网关）、ADR-0198（能力授予）、ADR-0188（Router + Fusion）、ADR-0043（提供商路由引擎）。
>
> 范围：`planRoute`（`packages/provider-routing`）、`router-fusion`（`packages/router-fusion` 与 `lib/router-fusion/`）、Rust 网关 planner（`crates/cognia-gateway/`）、`lib/routing/`、`lib/usage/` 的预算部分、`lib/claude/routing-fallback.ts`。
>
> 范围外：`lib/claude/team-router.ts` 与 `team-primary-router.ts` 名字里有 router，但它们决定的是群聊里谁发言、回复几条（`team-primary-router.ts:14`、`team-router.ts:21`、调用方 `lib/chat/room/runner.ts:75`），与模型选择无关，不在本文处理。

## 1. 结论先说

1. **暂定方向（内核增加"模型路由与调用账本"一层）成立，但"合并"这个词会误导。** 六个盘点对象里，真正决策重叠的不是 `planRoute` 与 router-fusion 的纯引擎。后者是建在前者之上的：行动路由器对每个角色别名调用 `planRoute` 取部署（`lib/router-fusion/routing/run-route.ts:252`，`lib/router-fusion/chat/route-chat-turn.ts:447,498`），它选的是执行模式，`planRoute` 选的是部署。真正重复的是五件事：**预算 10 套、回退 10 套、难度分级 4 处、错误分类 3 处、Rust 与 TS 两份 planner**（§3）。内核层应该按这五件事收口，而不是把两个引擎合成一个。
2. **内核层是三块，不是一块：** 路由规划（选部署）、调用账本（预留、结算、记账）、预算策略（谁有多少额度）。三块今天各有一个半成品落点，见 §5.1。
3. **调用账本是横切设施，不属于 `fusion` 模块。** `router-fusion` 在仓库外部的 39 个源码文件里，只碰账本侧入口（`gate/*`、`settings/switches`、`database-name`）的有 21 个，只碰模式侧的 10 个，两边都碰的 8 个（§4.1）。统一的 `utility-ledger`、聊天封印、网关直通账本、重发改道都是账本的消费者。把账本放进可选模块，等于让内核依赖模块，违反 ADR-0250 §14"内核不依赖模块"（`0250-…md:234`）。
4. **`fusion` 模块留下的是"模式"这一层：** 行动路由器、规则与 LLM 分类器、cascade / panel / delegate 工作流、验证与验收、证据工具、Run API 的模式执行、cockpit 的 fusion 行、路由实验与影子路由、动作目录编辑器。它通过一个由内核定义的"路由选择"端口接入，而不是继续在 `resolveSendOptions` 里内联（现状见 §4.3）。
5. **`lib/routing/` 不需要成为任何一类。** 877 行里 `auto-tier.ts` 没有生产调用方，其余三个文件各自归入规划层或设置基础设施（§2.4）。
6. **回退不是路由的一部分，是发送管线的一部分。** `routing-fallback.ts` 读写聊天 store、调用 `sendPrompt`、切换聊天租约，应随 `lib/claude` 的拆解进入聊天引擎；它的"决策"部分（下一个候选、按错误类的重试预算）已经在 `RoutingAttemptController` 里，应当只留一份（§2.6）。
7. **最大的静默风险是 Rust planner 与 TS 引擎语义不一致，而不是代码量。** 同名策略 `quality`、`balanced`、`reliability`、`adaptive` 在两边语义不同；Rust 的难度打分是一个更粗的重写；`gateway_local_routing_v2` 默认开（`crates/cognia-gateway/src/types.rs:312`），所以网关流量默认走 Rust 版（§3.2）。建议先加一致性向量，再谈合并实现（§6 R7）。
8. **迁移顺序按风险递增：** 先做不动行为的盘点、死代码清理和引擎构造点收口，再切包，再切账本存储，再统一预算，最后把 `build-options` 里的 fusion 分支换成端口（§6）。每一步都能单独回滚，且不翻转任何默认开关。

## 2. 六套机制逐项盘点

### 2.1 `planRoute`（`packages/provider-routing`）

**规模与形态。** 非测试代码 4025 行（`packages/provider-routing/src/`），零 `@/` 导入，依赖 `@cognia/provider-core`、`provider-types`、`vector`（`packages/provider-routing/package.json`）。

**入口。**

- `ProviderRoutingEngine.planRoute(request)`：`packages/provider-routing/src/provider-routing-engine.ts:227`，是"规范 API"，返回一个有序的尝试计划。
- 构造工厂：`buildRoutingEngine`（`packages/provider-routing/src/build-preview-engine.ts:333`）与依赖装配 `buildRoutingEngineDeps`（同文件 `:246`）。
- 运行时注入点：`setProviderRoutingRuntimeAdapters`（`packages/provider-routing/src/runtime-adapters.ts:188`），宿主在启动时装入；浏览器宿主见 `components/providers/initializers/routing-runtime-initializer.tsx:29`，无头 brain 见 `lib/headless/runtimes/initializers.ts:337-346`（`name: "routing-runtime"`，`hosts: ["brain"]`）。

**调用方（生产代码，grep `planRoute`）。**

| 调用点                  | 位置                                                                                                             | 说明                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 聊天发送                | `lib/claude/build-options.ts:2211`                                                                               | 唯一的主路径；无候选时再试 `fallbackTier` 别名 `:2226`，之后 `fallbackProvider`、应用默认（`:2213-2254`） |
| Agent 执行器            | `lib/ai/agent/agent-executor.ts:1032`（工厂调用 `:1011`）                                                        | 自带 `dataPolicy` 覆盖                                                                                    |
| 工作流 `ai.prompt` 路由 | `lib/workflow/nodes/ai/ai-prompt-routed.ts:166`（工厂 `:146`）                                                   |                                                                                                           |
| 网关实时决策            | `lib/gateway/decide.ts:48`，由 `components/providers/gateway-provider.tsx:187` 驱动                              | 只在 `gateway_local_routing_v2` 关闭时才被 Rust 询问（§2.3）                                              |
| 路由测试面板            | `components/settings/provider/routing/routing-test-panel.tsx:74`                                                 | 预览，不影响发送                                                                                          |
| fusion 的 route host    | `lib/router-fusion/chat/chat-route-host.ts:47`（包装），`route-chat-turn.ts:447,498`，`routing/run-route.ts:252` | fusion 站在 `planRoute` 之上                                                                              |

队友和多数 `resolveSendOptions` 调用方（例如 `lib/ai/agent/team/teammate/dispatch-teammate.ts:321`）不直接调用，而是经 `build-options.ts` 间接进入。

**它做的决策（`provider-routing-engine.ts:227` 起）。**

- 选择：手动、别名、Auto 三种（`:262-300` 一带）。Auto 先做任务分类 `classifyRoutingTask`（`:231`），再算难度 `resolveDifficulty`（`:303`，定义 `:563`），用 `pickAutoAlias`（`:350`）选档位。分类别名覆盖难度档位。
- 硬约束：能力、数据策略（`excludedProviders`、`local-only`）。
- 过滤链：熔断、上下文窗口、RPM/TPM、**日预算**、会话亲和（`packages/provider-routing/src/filters/built-in.ts`，预算过滤器 `:80-110`，咨询性：全部超支时保留原列表并带 `overBudget` 注记）。
- 策略：reliability、quality、cost、speed、balanced、adaptive、least-busy（`packages/provider-routing/src/strategies/built-in.ts:47,69,75,93,112,138,171`）。
- **单请求成本软上限**：`maxCostPerRequestUsd`（`provider-routing-engine.ts:254-259`，过滤 `:427-430`），设置里是 `autoRouting.maxCostPerRequest`，经 `lib/claude/routing-runtime-deps.ts:97-106` 注入。

**它保存的状态。**

- 引擎自身无状态；会话亲和有一个进程内 Map（`packages/provider-routing/src/session-affinity-store.ts:14`，30 分钟 TTL）。
- 它读的实时状态**住在 Zustand store 里**：健康指标、熔断器、速率窗口、在途计数、今日花费镜像（`lib/claude/routing-runtime-deps.ts:29-35` 导入 `stores/settings/{health-metrics,circuit-breaker,provider-cost-mirror,rate-limit,in-flight}-store`）。写入方是 `lib/claude/provider-telemetry.ts`（`routing-runtime-deps.ts:17` 的注释）。这与 ADR-0250 §5"内核决策所依赖的状态由内核持有，不留在 UI store"相冲突（`0250-…md:114`）。

**与其他机制的重叠。** 日预算与单请求软上限是预算机制的第 3、4 套（§3.4）。`difficulty-router.ts` 与 `lib/ai/routing/auto-model-resolution.ts`、Rust `difficulty_alias` 是同一个想法的多份实现（§3.1）。引擎有 4 处手写构造（§3.5）。

### 2.2 `router-fusion`

**规模。** `packages/router-fusion/src` 16430 行（非测试），`lib/router-fusion/` 26327 行，合计约 4.3 万行。`lib/` 部分没有 Dexie 主库表，数据在一个兄弟 IndexedDB 里（见"状态"）。

**包内分层（`packages/router-fusion/src`，行数为非测试）。** 依赖方向很干净，可以机械切开：

| 目录                                 |             行数 | 依赖                                     | 归属判断                                                                                                                                        |
| ------------------------------------ | ---------------: | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `money/`                             |              124 | 无                                       | 账本                                                                                                                                            |
| `state/`                             |              271 | `contracts`                              | 账本（run、call attempt、step reservation 状态机）                                                                                              |
| `ledger/`                            |              344 | `money`、`state`                         | 账本（`planRunCreation` `planner.ts:103`、`planCallReservation` `:165`、`planMarkUncertain` `:239`、`planSettle` `:266`）                       |
| `usage/`                             |              223 | `contracts`、`money`                     | 账本（用量归一，互斥桶）                                                                                                                        |
| `util/`                              |              172 | 无                                       | 账本                                                                                                                                            |
| `contracts/`                         |              741 | 无                                       | 需要拆：账本合同与 `RouteDecision`、模式合同（`schemas.ts:43` `EXECUTION_MODES`，`:228` `RouteDecisionSchema`）                                 |
| `settings/`                          |              877 | `config`、`routing` 等                   | 拆：`settings/switches.ts`（零导入叶子，`:11,34,58`）属账本侧；`settings.ts` 属模块                                                             |
| `config/`                            |              876 | `prompts`、`contracts`、`money`          | fusion（编译配置、内置动作目录）                                                                                                                |
| `routing/`                           |             1537 | `config`、`fake` 等                      | fusion（`action-router.ts:294` `routeAction`，`rules-classifier.ts:127`，`deployment-filter.ts:147`）                                           |
| `workflows/`                         |             6000 | `fake`、`contracts`、`verify`、`prompts` | fusion（`direct.ts:73`、`cascade.ts:105`、`panel.ts:451`、`delegate.ts:600`）。端口定义 `ports.ts:140` 的 `CallLedgerPort` 是工作流与账本的接缝 |
| `verify/`、`acceptance/`、`prompts/` | 1425 / 166 / 124 |                                          | fusion                                                                                                                                          |
| `fake/`、`live/`                     |      1430 / 1546 |                                          | fusion（测试与实机冒烟设施，`fake` 从包入口导出，`index.ts:40-51`）                                                                             |
| `api/`                               |              521 |                                          | fusion（Run API 与聊天兼容的请求规则）                                                                                                          |

**`lib/router-fusion/`（行数为非测试）。**

- 账本侧：`db/ledger-store.ts` 2250 行（`FusionLedgerStore` `:334`，"唯一写钱的地方"，ADR-0188 `:64`）、`db/outbox.ts`、`db/outbox-appliers.ts`、`db/fusion-db.ts`、`db/retention.ts`，`gate/*` 3326 行（`feature-gate.ts:33`、`breaker.ts:70`、`chat-send.ts:82`、`utility-ledger.ts:327`、`database-name.ts` 等），`calls/ledgered-llm-client.ts`、`calls/utility-run.ts`、`calls/gateway-ledger-source.ts`，`chat/chat-runs.ts`（861 行，`beginChatRun` `:181`、`finalizeChatRun` `:777`）、`chat/tenant-budget.ts`。
- 模式侧：`runtime/*`（`orchestrator-host.ts` 869 行，模式分发 `:541`/`:576`/`:630`/`:715`）、`tools/*`（2191 行，证据与工作区读写）、`verify/*`、`routing/llm-classifier.ts`、`api/*`（Run API 与伴随 RPC，2775 行）、`eval/*`（路由实验、影子路由、晋升回滚，2244 行）、`agents/*`、`prompts/*`。
- 混合：`ledger-store.ts` 同时装着调用账本（`prepareCall` `:1265`、`markDispatched` `:1424`、`settleCall` `:1579`、`markUnknown` `:1527`、`reserveStage` `:1783`）与运行生命周期、产物和工作流事件（`createRun` `:600`、`acquireLease` `:770`、`finalizeRun` `:1047`、`artifactStore` `:2110`、`appendWorkflowEvent` `:2191`）。好消息是它已经把对外的面按端口切好了：`ledgerFor`（`:2236`，`CallLedgerPort`）、`eventSinkFor`（`:2229`）、`artifactStore`（`:2110`）、`outboxContext`（`:2220`）。拆分沿这些端口走，不需要发明新边界。

**决策。** 模式选择（`routeAction`，`action-router.ts:294`）：显式动作优先，其次显式模式，再次规则行，再次候选偏好；排除项有 `MODE_NOT_ALLOWED`（`:353`）和 `FUSION_RECURSION`（`:372`）。输出是完整的 `RouteDecision`（`contracts/schemas.ts:228`）。聊天的默认动作固定为 `direct_baseline`（`lib/router-fusion/chat/route-chat-turn.ts:91`），也就是说聊天路径上 fusion 的"模式选择"在默认情况下是空操作，只有预留、结算、封印是实打实在做事。

**状态。**

- 兄弟 IndexedDB `<主库名>-router-fusion-v1`（`lib/router-fusion/gate/database-name.ts:19-31`），Dexie 版本 6（`lib/router-fusion/db/fusion-db.ts:72`；ADR-0188 `:299-316` 写的是版本 5，已落后一版：v6 给 outbox 加了 `[status+nextAttemptAt]` 并升级旧行）。21 张表（`fusion-db.ts:75-95`）。
- 其中账本相关：`fusionLedger`、`fusionReservations`、`fusionCallAttempts`、`fusionOutbox`、`fusionIdempotency`、`fusionSessionLocks`；模式相关：`fusionRuns`、`fusionRunEvents`、`fusionArtifacts`、`fusionToolOperations`、`fusionDelegateSteps`、`fusionPatchSets`、`fusionAcceptanceApprovals`；实验：`fusionRoutingSamples`、`fusionPredictorManifests`、`fusionShadowDecisions`；决策与配置：`fusionRouteDecisions`、`fusionConfigSnapshots`。
- 备份仅限本机，同步为无（ADR-0188 `:313` 起的治理段）；主库的每一条删除路径都会同时删兄弟库（`lib/data/clear.ts`、`lib/db/storage-layout.ts`、`lib/runtime/target-registry.ts`、`stores/account/account-store.ts` 都导入 `gate/database-name`）。
- **对 G7 的盲区：** 模块化分析里 `router-fusion` 的"表"列是 0（`feature-module-analysis-2026-11-04.md:834`），因为这 21 张表不在 `lib/db/schema.ts`。G7 的表数统计看不到它们。
- 设置：`AppSettings.routerFusion`，类型 `RouterFusionSettings`（`packages/plugin-contract/src/types/agent-config/index.ts:6207`，定义 `packages/router-fusion/src/settings/settings.ts:92`），六个面开关全部默认 `false`（`settings.ts:142-165`）。
- 内存：断路器（`gate/breaker.ts`，持久化跳闸 `trippedSurfaces`）。沙箱侧的账本闸门在 sidecar（`sidecar/src/runtimes/common/call-ledger-gate.ts:92,105,253,308,360`），按 `SendOptions.ledger` 印章触发，30 秒无应答则旁路。

**调用方。** 见 §4.1，仓库外部共 55 个文件（含 2 个 `cli/.cache` 缓存文件）。

**与其他机制的重叠。**

- 预算：D22 把租户额度作为运行的预留来源（`lib/router-fusion/chat/tenant-budget.ts:27-35,59-72`），D35 让旧的 `enforceCostBudget` 在印章发送时让位（`hooks/chat/use-claude-chat-controller.ts:3909-3916`，晚检 `:6020-6025`，重放 `lib/work-submission/stored-chat-dispatch.ts:121-130`）。
- 回退：账本化发送的改道被限制为每轮至多 2 次（`lib/router-fusion/gate/chat-send.ts:120`，被 `routing-fallback.ts` 引用），内容策略链在账本化发送里关闭（`routing-fallback.ts:380-383`）。
- 用量行：账本的结算经 outbox 写入 `sessionUsage`（`lib/router-fusion/db/outbox-appliers.ts:215-220`，`commitUsageRow` 调用 `:218`），与旧的 `recordResultUsage` 是同一张表的两个写入口，由 `costSource: "ledger"` 区分。
- 网关：直通账本在 Rust 与 TS 之间来回（§2.3）。

**未账本化的 LLM 调用。** `scripts/gates/llm-ledger-boundary-baseline.json` 登记了 54 个文件：21 个 `ledgered-entry`、18 个 `unwrapped`（只许减少，ADR-0188 `:112` 附近的说明）、8 个 `not-a-provider-call`、5 个 `d27-out-of-scope`、2 个 `client-factory`。侧车上带工具的非聊天轨道整体未账本化（ADR-0188 `:110-117`）。这说明账本今天只覆盖"一部分"调用，把它提升为内核设施的同时必须保留这条棘轮。

### 2.3 Rust 网关 planner（`crates/cognia-gateway/`）

**规模。** `route_planner.rs` 864 行；周边 `server.rs` 8306、`route_ticket.rs` 2470、`runs.rs` 2480、`virtual_models.rs` 1141、`passthrough_ledger.rs` 740、`brain_bridge.rs` 484。

**入口。** `plan_candidates`（`route_planner.rs:378`）、`candidates_for_model`（`:412`）、`bindings_for_candidates`（`:458`）。调用点 `server.rs:3664-3687` 的 `route_candidates`：

- `gateway_local_routing_v2` 为真且快照有 `routing_policy` → 本地 `plan_candidates`，**不回渲染器**；
- `gateway_local_routing_v2` 为假 → 发 `gateway://decide` 事件，等渲染器 800 ms（`live_decision`，`server.rs:~3719`、`DECIDE_TIMEOUT_MS`），由 `lib/gateway/decide.ts:48` 调 `planRoute` 回答；
- 其余情况退回 `resolve_candidates`。

`gateway_local_routing_v2` 默认值为 `true`（`crates/cognia-gateway/src/types.rs:312`），所以**默认情况下 TS 的 `planRoute` 不参与网关流量**，ADR-0090 附录（2026-08-04）正是为此引入的（`0090-…md:460-476`）。TS 一侧的 decide 往返仍是活代码（`components/providers/gateway-provider.tsx:170-192`），但只在该标志关闭时才会被触发。

**调用方。** Cargo 依赖：`crates/cognia-agent-state`、`cognia-companion`、`cognia-companion-rpc`、`cognia-server`、`cognia-problem`（源码里没有用到 `cognia_gateway`，依赖可能是多余的）、`src-tauri`。`cognia-cli` 与 `cognia-sidecar` 不依赖。TS 侧：`lib/tauri/gateway.ts`、`lib/gateway/*`（非测试 3248 行）、`components/providers/gateway-provider.tsx`、`components/settings/gateway/*`、`lib/headless/runtimes/gateway-telemetry.ts`。

**决策。**

- 资格：`entry_is_eligible`（`route_planner.rs:143-206`）：可执行提供商、可用、`local-only`、约束（熔断、RPM/TPM、日成本）、能力、条件。冷却不在这里查。
- 分布：`selected_index`（`:54-91`）：`priority` / `weighted`（按指纹与游标的哈希取模）/ `round-robin`。
- Auto：`auto_entries`（`:312-375`）：`difficulty`（`difficulty_alias`，`:251`）、`quality`（别名倒序，`:326`）、`balanced` / `adaptive`（别名旋转一位，`:327-329`）、`reliability`、`cost`、`speed`、`least-busy`。
- 候选之后：凭证轮转与冷却（`execute.rs` 的 `expand_key_pools` `:343`、`cooldown.rs` 的 `usable_pool` `:191`）。
- 路由票据冻结候选（`route_ticket.rs`，ADR-0090 §5 `:174-200`）：票据内只能在冻结列表里移动，且只能在响应字节之前。

**状态。** 全在进程内：轮转游标（`route_planner.rs:16-20`，满 1024 键清空）、冷却表（`cooldown.rs`）、并发与在途（`concurrency.rs`）、会话凭证租约（`lease.rs`）、票据注册表（`route_ticket.rs:353`）。快照由渲染器推送：`lib/gateway/snapshot-publisher.ts`（`buildGatewaySnapshot` `:376`，路由策略 V2 在 `:395-435`，`buildEnrichedGatewaySnapshot` `:806`），经 `components/providers/gateway-provider.tsx`（去抖 1.5 s、每 5 分钟、订阅与配置变化时推送）。

**用量与账本相关。** 请求日志（`gateway://request-log` → Dexie `gatewayRequestLog`，`lib/db/schema.ts:627`，上限 5000 行）；直通账本（`passthrough_ledger.rs:273,328`，受 `gatewayPassthroughLedger` 开关管，经 `lib/companion/desktop-write-source.ts:387-395` → `lib/router-fusion/gate/passthrough-bridge.ts` 到兄弟库）；组织成员月度 token 上限（`org_usage.rs:83-93`，默认内存存储，只有无头服务器挂了加密存储，`crates/cognia-server/src/main.rs:3043`）；API 密钥配额（`api_keys.rs:339`）。**Rust 里没有美元账本**（`crates/` 内没有对应实现，来自盘点，未做穷尽搜索）。

**与 fusion 的耦合。** `runs.rs`（Run API，2480 行）、`virtual_models.rs`（`cognia/*` 虚拟模型，1141 行）是 fusion 的专属代码，却住在内核 crate 里。耦合方式是桥（`brain_bridge.rs`，实现 `crates/cognia-companion/src/gateway_brain.rs:111`），Rust 不直接依赖 TS 的 fusion 代码，所以只是"概念上"的内核依赖模块，不是编译依赖。

### 2.4 `lib/routing/`（RouteLLM-lite 自动档位）

| 文件                       | 行数 | 做什么                                                                              | 生产调用方                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---: | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto-tier.ts`             |   38 | `pickAutoAlias`，对包内同名函数的薄包装（`:27-37`）                                 | **没有。** 只有注释引用：`components/settings/provider/routing/auto-routing-section.tsx:8`、`packages/provider-routing/src/difficulty-router.ts:199`、`packages/plugin-contract/src/types/agent-config/index.ts:6192`、`cli/src/config/schema.ts:1059`、`cli/src/config/to-build-context.ts:427` |
| `calibration.ts`           |  130 | 从 `agentTraces` 推荐 `balanced` / `powerful` 阈值，只在用户点击时落盘（`:50-130`） | 仅 `components/settings/provider/routing/routing-test-panel.tsx:19,45`                                                                                                                                                                                                                           |
| `plan-trace-attributes.ts` |   81 | 把 `RoutingPlan` 变成 `routing.plan` 追踪属性（`:41-80`）                           | `lib/ai/agent/agent-executor.ts:67,662`、`lib/ai/agent/team/teammate/dispatch-teammate.ts:85,410`、`hooks/chat/use-claude-chat-controller.ts:373,5957`                                                                                                                                           |
| `seed-default-mappings.ts` |   51 | 给没有 `modelMappings` 的用户补层级别名（`:24,44`）                                 | `stores/settings/settings-store.ts:111-113,879,1640`                                                                                                                                                                                                                                             |

状态：无（全是纯函数或读写 `AppSettings`）。它不是一套独立的路由机制，而是 `planRoute` 的外围：一个死薄包装、一个设置页分析工具、一个追踪属性构造器、一个设置播种器。模块化分析把它称作"第 4 套路由机制"（`feature-module-analysis-2026-11-04.md:726`），代码上不成立。

### 2.5 `lib/usage/` 的预算部分

**模块（`lib/usage/`）。**

| 文件                                                | 做什么                                                                                                                       | 入口                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `cost-budget.ts`                                    | 纯策略：日、月 × 全局、提供商、项目 六个范围；`warning` 0.80、`critical` 0.95、`exceeded` 1.0（`:119-124`）                  | `evaluateCostBudget` `:141-197`                            |
| `cost-budget-gate.ts`                               | 同步预检与强制；任何异常都放行（`:112-113,124-125`）；超支时对每个阻塞范围发一条人工审批（`:136-142`）                       | `isCostBudgetConfigured` `:83`，`enforceCostBudget` `:105` |
| `cost-budget-runtime.ts`                            | 读花费：全局与提供商读 `providerCostDaily`（`:86`），项目读 `sessionUsage`（`:58-72`）；阈值通知与单次授权审批（`:150-214`） |                                                            |
| `usage-ledger.ts`                                   | 唯一的事务写入口：同一事务里写 `sessionUsage` 并对 `providerCostDaily` 加增量；成本在写入时冻结                              | `commitUsageRow` `:190-279`                                |
| `claimed-turn-usage.ts`                             | 让无头调用方自己记账，聊天运行时跳过那一轮                                                                                   | `claimTurnUsage` `:36-46`                                  |
| `pricing.ts` + `model-price-catalog.generated.json` | 分层价格解析；离线目录只被 `pricing.ts:37` 导入                                                                              | `resolveModelPricingUsd` `:255`                            |

**状态。** Dexie 主库：`sessionUsage`（`lib/db/schema.ts:537-538`）、`providerCostDaily`（`:594`）、`usageSourceStates`（`:596`）。设置键 `costBudget`（`packages/plugin-contract/src/types/agent-config/index.ts:4146-4150`；文档注释写明 100% 为硬限，对比咨询性的 `ProviderConstraint.dailyCostBudget`，`:4141-4144`）。

**调用方（`enforceCostBudget`，穷尽）：** 仅三处——`hooks/chat/use-claude-chat-controller.ts:3909-3916`（发送前）、`:6020-6025`（router-fusion 故障后的晚检）、`lib/work-submission/stored-chat-dispatch.ts:124-130`（重放）。**团队、插件、best-of-n、harness、工作流的花费都不经过这个闸门**，它们通过 `claimTurnUsage` 避免重复记账：`lib/plugin/api/agent-turn.ts:487`、`lib/best-of-n/runtime.ts:322`、`lib/harness/runtime/probe-runner.ts:291`、`lib/harness/runtime/editor-runner.ts:412`。

**用量行写入方。** 大多数都经 `commitUsageRow`（`lib/db/session-usage.ts:70` 的 `upsertSessionUsage`，及 router-fusion 的 `outbox-appliers.ts:218`）。绕过它的：`lib/usage/external-usage-index.ts:119`（导入行）、`lib/sync/handlers/session-usage.ts:50`（`bulkPut`，不更新 `providerCostDaily`，同步行是否带 `imported` 标记未核实）。`incrementProviderCost`（`lib/db/provider-cost-daily.ts:70`）没有非测试调用方，疑似死代码。

**预算机制清单（十套，§3.4 展开）。** `cost-budget`；fusion 租户额度与运行上限；引擎日预算；引擎单请求软上限；团队 `RunBudgetGovernor`；dispatch token 预算；插件 SDK 预算；SDK 自带 `maxBudgetUsd`；工作流应用配额；Rust 组织月度 token 上限。

### 2.6 `lib/claude/routing-fallback.ts`

**规模与入口。** 430 行。唯一的生产调用方是 `hooks/chat/claude-chat-events.ts:33`（导入）与 `:695-702`（调用），入口 `attemptRoutingFallback`（`lib/claude/routing-fallback.ts:329-430`）。`classifyError`（`:79-83`）没有非测试调用方，是遗留的二元分类。

**决策（`:329-430`）。**

1. 总开关 `routingFallbackEnabled === false` 关闭（`:338`）；首个可见帧或工具分发之后不重放（`:355`）；账本化发送超过 2 次改道不再试（`:357-358`）。
2. 错误分类用 `classifyProviderErrorInfo`（`:365`，来自 `packages/provider-routing/src/error-classifier.ts`）。
3. 专用链（`:371-394`）：`context-window-exceeded` 与 `content-policy` 只走映射里声明的专用链；账本化的内容策略失败直接停（`:380-383`）。
4. 下一个候选（`:396-413`）：有 `routingPlan` 时用 `RoutingAttemptController`（`packages/provider-routing/src/routing-attempt-controller.ts`），否则用 `fallbackEntries[]`。
5. 只重试瞬态错误（`:419`）；按错误类的 `retryPolicy.maxRetries` 限额（`:423-424`）。
6. `issueRetry`（`:86-319`）：订阅模式不得隐式切到计量计费（`:99-103`），清掉 `fallbackModel`（`:179`），账本化发送时改道走 `rerouteRouterFusionSend`（`:199-224`），重发前复核计费边界（`:228-245`）。

**状态。** 读写聊天 store 的 `lastSendBySession`（`useChatStore`，`:329` 之后），读设置 store；重试经 `sendPrompt` 发往侧车，并切换 `lib/execution/chat-lease`。这是发送管线的一部分，不是纯路由。

**它还依赖 fusion。** 静态导入 `lib/router-fusion/gate/chat-send`（`routing-fallback.ts:37`）。

**`fallbackModel` 与回退机制清单（十套，§3.3 展开）。**

## 3. 重叠与分歧

### 3.1 难度分级：4 处，3 套阈值

| 实现       | 位置                                                                                                                                                                                   | 备注                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS 规范版  | `packages/provider-routing/src/difficulty-router.ts`：`scoreDifficulty` `:45`、`deterministicDifficulty` `:116`、`pickAutoAlias` `:201`、`classifyRoutingTask` `:255`                  | 引擎调用 `provider-routing-engine.ts:231,303,350`                                                                                                                                                                             |
| 薄包装     | `lib/routing/auto-tier.ts:27-37`                                                                                                                                                       | 没有生产调用方                                                                                                                                                                                                                |
| 角色档位   | `lib/ai/routing/auto-model-resolution.ts:36,49-84`                                                                                                                                     | 重写了"先降后升"的循环；`["fast","balanced","powerful"]` 在这里（`:36`）和引擎（`provider-routing-engine.ts:352`）各硬编码一次；调用方 `lib/ai/generation/agent-role-client.ts:14-15,50-51`、`cli/src/cli/handoff-cmd.ts:158` |
| Rust 版    | `crates/cognia-gateway/src/route_planner.rs:251-266`                                                                                                                                   | `长度/4000 + 代码围栏 0.25 + 含 analyze/reason 关键词 0.2`，与 TS 的 `scoreDifficulty`（长度/2000×0.3、代码、关键词、结构）不是一个算法                                                                                       |
| 第三套阈值 | `classifyRoutingTask` 的 0.2 / 0.5 / 0.75（`difficulty-router.ts:275-276`）对比引擎默认 0.34 / 0.67（`provider-routing-engine.ts:302`，Rust 同为 0.34 / 0.67，`route_planner.rs:265`） |                                                                                                                                                                                                                               |

另有一个 LLM 二次判断（`lib/ai/routing/difficulty-judge.ts:163,285`），只在边界附近咨询，缓存是进程内 Map；它还会在 fusion 开启时走 `lib/router-fusion/routing/llm-classifier`（`difficulty-judge.ts` 导入的 `gate/*` 与 `routing/llm-classifier`）。

### 3.2 TS 策略与 Rust 策略：同名不同义

| 策略        | TS（`strategies/built-in.ts`）                            | Rust（`route_planner.rs`）                           | 差异                 |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------- | -------------------- |
| reliability | 先暖群体，再成功率、p95、在途（`:47-67`），选一个         | 只按成功率排整张表（`:342-347`）                     | 算法与输出形状都不同 |
| quality     | 取第一个（`:69-71`）                                      | 别名倒序（`:326`）                                   | 含义不同             |
| balanced    | 0.4 成功率 + 0.3 延迟 + 0.3 成本（`:112-136`）            | 别名旋转一位（`:327-329`）                           | 不等价               |
| adaptive    | 带 5 分钟误差衰减的打分（`:138-168`）                     | 先成功率再延迟（`:360-371`）                         | 不同                 |
| weighted    | `alias-resolver.ts` 的 `weightedShuffle`（`Math.random`） | 指纹与游标的哈希（`route_planner.rs:64-87`），确定性 | 一随机一确定         |
| round-robin | TS 里没有                                                 | `:89`，快照校验放行（`snapshot.rs:465-466`）         | 只有 Rust 有         |
| least-busy  | `:171-185`                                                | `:388-391`                                           | 同形                 |

**错误分类也是两份。** TS：`packages/provider-routing/src/error-classifier.ts` 的 `ORDERED`（`:75-84`）与 `classifyFromStatus`（`:170-178`，408 → timeout，≥500 → server-error，401/403 → auth）。Rust：`passthrough_ledger.rs:106-115`（429、401/403、5xx、其余 invalid-request）与 `cooldown.rs:109-152`（只有 429/529 会让密钥冷却，`:105-110` 的注释明说 5xx 不冷却，401 或配置的关键词才永久禁用）。TS 把 408 与 5xx 当作可重试瞬态，Rust 的冷却表对它们不动作。再加上 `routing-fallback.ts` 里遗留的正则分类 `classifyError`（`:61-83`，死代码）。

**冷却与健康状态也是两份。** TS：Zustand 的熔断器与健康指标（§2.1），上游 Retry-After 经 `lib/gateway/telemetry-forwarder.ts:35-36` 转进熔断。Rust：自己的内存冷却表。两边互不读取。

**哪边是对的，本文没有判断。** 差异可能是有意（Rust 只拿到快照里的 `success_rate`、`latency_ms`、`pricing_per_1_m`，算不了 p95 与衰减），也可能是漂移。这是产品决策，不是代码决策，见 §7 问题 3。

### 3.3 回退：十套

| #   | 机制                                                         | 位置                                                                                                                                                                    |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 渲染器跨提供商重试                                           | `lib/claude/routing-fallback.ts:329`                                                                                                                                    |
| 2   | 引擎 `fallbackEntries` 与 `RoutingAttemptController`         | `lib/claude/build-options.ts:2265-2270`、`routing-attempt-controller.ts`                                                                                                |
| 3   | SDK 回合内 `fallbackModel`（仅 Anthropic 同族）              | 设置于 `build-options.ts:2301-2314`；侧车 `sidecar/src/runtimes/claude-agent-sdk/index.ts:92-94`（账本化时关闭）；读回 `sidecar/src/host/events/canonical/system.ts:88` |
| 4   | 插件 SDK 重试                                                | `lib/plugin/agent-sdk/run.ts:264-266`：任何拒绝都重试，**不分类错误**                                                                                                   |
| 5   | 无候选回退（`fallbackTier` → `fallbackProvider` → 应用默认） | `build-options.ts:2213-2254`                                                                                                                                            |
| 6   | fusion 的改道（至多 2 次）                                   | `routing-fallback.ts:199-224`、`lib/router-fusion/gate/chat-send.ts:120`                                                                                                |
| 7   | 角色档位回退                                                 | `lib/ai/routing/auto-model-resolution.ts:49-84`                                                                                                                         |
| 8   | 便宜档下移（非失败触发）                                     | `packages/provider-routing/src/cheap-tier.ts:73-101`，`lib/workflow/runtime/model-preference-controller.ts:34-53`                                                       |
| 9   | 网关的候选行走（响应字节前）                                 | `crates/cognia-gateway/src/execute.rs`、ADR-0090 附录 `:475-476`                                                                                                        |
| 10  | 侧车无人值守重试策略（重试，不换模型）                       | `sidecar/src/runtimes/claude-agent-sdk/index.ts:54,135,170`                                                                                                             |

另有显式清除 `fallbackModel` 的五处：`lib/chat/room/runner.ts:1532`、`lib/ai/agent/agent-executor.ts:763`、`dispatch-teammate.ts:521`、`routing-fallback.ts:179`、`lib/router-fusion/chat/chat-turn-bridge.ts:300`。ADR-0188 把其中三条列为"破坏账本不变量"的行为（SDK 静默 `fallbackModel`、AI SDK 与 CLI 隐式重试、内容策略链，`0188-…md:23-26`），账本化发送是靠"清除"绕开它们，而不是靠它们自己遵守账本。

### 3.4 预算：十套

| #   | 机制                      | 位置                                                                                                                                                                                                                                                      | 覆盖面                             |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | `costBudget` 美元闸门     | `lib/usage/cost-budget*.ts`                                                                                                                                                                                                                               | **只有聊天发送**（三处调用，§2.5） |
| 2   | fusion 租户额度与运行上限 | `lib/router-fusion/chat/tenant-budget.ts:27-72`，调用方 `chat-fusion-turn.ts:251`、`calls/ledgered-llm-client.ts:84`、`calls/gateway-ledger-source.ts:180`、`chat/chat-turn-bridge.ts:158`、`agents/agent-fusion-run.ts:286`、`api/run-api-host.ts:227`   | 账本化的所有面                     |
| 3   | 引擎日预算（咨询性）      | `filters/built-in.ts:80-110`；`getTodaySpend` 依赖 `provider-routing-engine.ts:98`                                                                                                                                                                        | 只影响选择                         |
| 4   | 引擎单请求软上限          | `provider-routing-engine.ts:254-259,427-430`                                                                                                                                                                                                              | 只影响选择                         |
| 5   | 团队 `RunBudgetGovernor`  | `lib/ai/agent/execution/run-budget-governor.ts:143-208`（token）；它的美元控制器（`:219-284`）接受 `costPolicy`、`costSpend`（`:131-133`），**团队运行时没有传**（`lib/ai/agent/team/agent-team-runtime.ts:817-826` 只传 token 与通知器），其他地方也没有 | token 与扇出；美元上限是死接口     |
| 6   | dispatch token 预算       | `lib/claude/agents/dispatch-budget.ts:35-45`，`dispatch-run.ts:223`，`lib/plugin/agent-sdk/dispatch.ts:382`                                                                                                                                               | 子代理分发                         |
| 7   | 插件 SDK 预算             | `lib/plugin/agent-sdk/budget.ts:66-110`（自己记 `usedUsd`），创建于 `session.ts:151-157`                                                                                                                                                                  | 插件运行                           |
| 8   | SDK 自带 `maxBudgetUsd`   | 来自能力授予 `build-options.ts:1702`、目标配置 `:5196-5198`；侧车 `sidecar/src/runtimes/claude-agent-sdk/index.ts:95-98`；`lib/harness/runtime/driver.ts:942`                                                                                             | 单次 SDK 运行                      |
| 9   | 工作流应用配额            | `lib/workflow/apps/quota-service.ts:62-95`                                                                                                                                                                                                                | 工作流应用（日 token 与日美元）    |
| 10  | Rust 组织月度 token 上限  | `crates/cognia-gateway/src/org_usage.rs:83-93`、`route_ticket.rs:274,1050`                                                                                                                                                                                | 网关多成员（token 单位）           |

ADR-0090 §8 早已写明意图：团队预算守卫抽成唯一的 `RunBudgetGovernor`，"重复的插件预算记账被迁移或移除"，网关租户与 API 密钥配额保持传输层限制（`0090-…md:261-271`）。实际状态是 #5 的美元部分没接线，#7 仍有自己的美元记账。

**单位不统一。** 账本用整数 microusd（`packages/router-fusion/src/money/microusd.ts:10`），`cost-budget` 与引擎用浮点美元，Rust 与治理用 token，`maxBudgetUsd` 用 SDK 的美元。把它们统一前，先要有一个"换算与归属"层，而不是让每套自己换。

### 3.5 引擎构造点与依赖装配

- `buildRoutingEngineDeps` 已经被共享（`build-options.ts:2012`、`:6458`，`chat-turn-bridge.ts:254`，`api/route-host.ts:34`，`calls/ledgered-llm-client.ts:42`，`gateway-provider.tsx:183`）。依赖装配没有分叉。
- 构造 `ProviderRoutingEngine` 却是手写的四处：`lib/claude/build-options.ts:2028`、`:6461`，`lib/router-fusion/chat/chat-turn-bridge.ts:257`，`lib/router-fusion/api/route-host.ts:38`。工厂 `buildRoutingEngine`（`build-preview-engine.ts:333`）有三个使用方：`agent-executor.ts:1011`、`ai-prompt-routed.ts:146`、`gateway-provider.tsx:184`（外加路由测试面板 `routing-test-panel.tsx:71`）。分叉的唯一理由是 `build-options.ts:2012` 那一处带了 `explicitProviderId` 的特殊依赖，其余三处没有。

### 3.6 其他漂移点

- 过期注释：多处注释指向不存在的 `lib/ai/routing/{semantic-tool-router,default-mappings,model-mapping-registry,build-preview-engine,filter-registry}.ts`（实际在 `packages/provider-routing/src/`；例如 `packages/plugin-contract/src/types/agent-config/index.ts:6158-6162`、`build-options.ts:2009`）。`seed-default-mappings.ts:4-6` 说引擎只在 `modelMappings.length > 0` 时启用，而 `build-options.ts:1999` 的判断是选择类型。
- `lib/ai/routing/cheap-model-hint.ts`、`difficulty-judge.ts`、`auto-model-resolution.ts` 仍住在 `lib/ai/routing/`，属于规划层的宿主侧适配，不是 `lib/ai` 的内容。
- 兄弟库的版本与 ADR 不同步（§2.2）。

## 4. 与 ADR-0250 §14 的对照

### 4.1 `router-fusion` 现在被谁依赖

仓库外部 55 个文件（含 2 个 `cli/.cache` 缓存文件、13 个 `components/**` UI 文件）。其余 39 个源码文件按导入路径粗分（含注释命中 2 个，见脚注）：

| 类别                                                                                         | 数量 | 例子                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 只碰账本侧入口（`gate/*`、`settings/switches`、`gate/database-name`、`chat/store-provider`） |   21 | `lib/claude/routing-fallback.ts:37`、`lib/ai/renderer-llm-client.ts`、`lib/ai/ledgered-generation-seam.ts`、`lib/workflow/nodes/ai/{ai-prompt-routed,ai-prompt-v2,executors}.ts`、`lib/twin/{worker-runtime,runtime/build-deps}.ts`、`lib/project-knowledge/runtime/retrieve.ts`、`lib/companion/desktop-write-source.ts`、`lib/gateway/snapshot-publisher.ts`、`lib/data/clear.ts`、`lib/db/storage-layout.ts`、`stores/account/account-store.ts`、`hooks/chat/{use-claude-chat-controller,claude-chat-events,router-fusion-chat-turn}.ts` |
| 只碰模式侧（`explicit-run`、`eval/*`、`verify/*`、`runtime/*`、`prompts/*`、包根）           |   10 | `lib/scm/{runtime,verify/changeset-checks,review/review-changeset,integration/orchestrator}.ts`、`lib/prompts/catalog.ts:31`、`lib/workflow/nodes/params-schemas.ts`、`lib/ai/eval/configuration-targets.ts`、`cli/src/cli/eval-command.ts`，以及两处只在注释里提到包名的文件（`lib/project-environment/workspace-config-trust.ts:289-301`、`packages/eval-core/src/routing/manifest.ts:22`）                                                                                                                                               |
| 两边都碰                                                                                     |    8 | `lib/claude/build-options.ts`、`lib/claude/run-and-capture.ts`、`lib/ai/ledgered-model-call.ts`、`lib/ai/routing/difficulty-judge.ts`、`lib/ai/agent/team/teammate/member-fusion-turn.ts`、`lib/workflow/nodes/ai/fusion-action.ts`、`lib/ai/eval/routing-experiment.ts`、`packages/plugin-contract/src/types/agent-config/index.ts`                                                                                                                                                                                                        |

脚注：这是按导入路径做的正则粗分，没有区分 `import type`、动态导入、注释；不要把数字当作精确的边数，只看比例。

两点观察：

- **账本侧入口的消费者远多于模式侧**，且散布在聊天、工作流、孪生、项目知识、同伴 RPC、账号存储、数据清理。把它们归入"一个可选模块"，G2 会立刻报出十几条内核到模块的违规边。
- **内核的契约包已经依赖 fusion 的类型。** `packages/plugin-contract` 把 `@cognia/router-fusion` 作为工作区依赖（`packages/plugin-contract/package.json:58`），并在 `AppSettings` 里引用 `RouterFusionSettings`（`packages/plugin-contract/src/types/agent-config/index.ts:6207`）与 `DelegateTimeline`（`:4004`）。设置键归属（M3）会把前者变成 `settings.keys`，后者属于模式侧类型，应当随模式契约一起出去。

### 4.2 现有门禁已经红了

`node scripts/gates/check-router-fusion-gate.mjs`（本文作者在 HEAD `03d7e75b43` 上运行）退出码 1，报四条静态导入违规：`lib/prompts/catalog.ts:31`、`lib/scm/runtime.ts:15`、`:20`、`lib/scm/verify/changeset-checks.ts:24`。涉及的都是模式侧（`role-prompts`、`delegate-host-ports`、`code-acceptance-host`），而 `lib/prompts` 在模块化分析里是内核成员（`feature-module-analysis-2026-11-04.md:228`，`:606`）。这说明**模式侧的代码已经在被内核成员静态依赖**，边界只靠一个脚本在守，而脚本已经失守。这四处是已有问题，不是本文引入的，也不在本文范围内修。

### 4.3 `build-options` 里的 fusion 分支与 ADR-0198、§14

`lib/claude/build-options.ts` 共 6658 行，其中 44 行提到 router-fusion。静态导入的是闸门（`:68-76`），其余在 `fusionGate === "on"` 后动态加载：`:1944-1953` 判定闸门，`:2076-2206` 里选择 fusion 运行与直连路由并改写 `opts.routingPlan`、`opts.aliasResolution`、`model`、`providerId`，`:6440-6520` 在末尾封印（盖 `ledger` 与 `routerFusion` 印章、删 `fallbackModel`）。这是 `resolveSendOptions` 内部的内联分支。ADR-0198 的结论是"调用方不要在 `resolveSendOptions` 之后补 `SendOptions`"（`0198-…md:20-42`），§14 把 `capabilityContributions` 限定为只产出 `AgentCapabilityGrantV1`（`0250-…md:248`）。fusion 的两个动作并不是能力授予：**选一条部署**是路由，**盖账本印章**是记账。它们需要自己的内核端口，而不是借道授予。

### 4.4 暂定方向逐项核对

| 暂定方向的说法                            | 核对结果                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内核增加"模型路由与调用账本"一层          | 成立。修正：这是三块（规划、账本、预算策略），且"调用账本"要与 ADR-0250 §6 第 3 条的"运行账本"（`executionRuns`，`0250-…md:127`）区分命名，两者不是一个东西       |
| 合并 `planRoute`                          | 它本来就是内核（模型网关与凭据在内核清单里，`0250-…md:229`），不需要"合并进"什么。要收口的是它周围的重复：难度分级、错误分类、引擎构造点、运行时状态住在 UI store |
| 合并 router-fusion 的纯引擎               | 只合并账本部分（`money`、`state`、`ledger`、`usage`、`util`，共约 1134 行 + 合同的一部分）。行动路由器与工作流属于模块                                            |
| 合并 `lib/usage` 的预算部分               | 成立，但先不合并数字，先合并"入口"（§5.1 的准入接口）                                                                                                             |
| cascade、panel 等做成可选 `fusion` 模块   | 成立。delegate 与 cockpit 的 fusion 行、路由实验、影子路由同归模块                                                                                                |
| （未提）Rust 网关 planner                 | 需要单独的一致性处理（§3.2、R7）                                                                                                                                  |
| （未提）`lib/routing`、`routing-fallback` | `lib/routing` 拆散；`routing-fallback` 随聊天引擎（§2.4、§2.6）                                                                                                   |

## 5. 推荐的目标结构

### 5.1 内核层：三块

目录建议放在 `lib/runtime/` 之下（ADR-0250 §14 "Recorded" 已经把 `lib/claude` 的内核部分改名到 `lib/runtime/`，`0250-…md:298`），避免新增一个顶层子系统。名字与路径是建议，不是决定。

**K1 路由规划（`@cognia/provider-routing` 加宿主适配）**

- 留在包里：引擎、过滤器、策略、难度、错误分类器、尝试控制器、亲和存储、别名解析（现有的 4025 行）。
- 进入宿主适配：`lib/claude/routing-runtime-deps.ts`（161 行）、`lib/ai/routing/{auto-model-resolution,cheap-model-hint,difficulty-judge}.ts`、`lib/routing/{plan-trace-attributes,seed-default-mappings}.ts`、`calibration.ts`、`lib/claude/provider-telemetry.ts`。
- 状态收归：健康、熔断、速率窗、在途、今日花费镜像五个 store 由内核持有（ADR-0250 §5），UI 订阅它们，不是反过来。
- 引擎构造只留一个工厂。
- 删除：`lib/routing/auto-tier.ts`（没有生产调用方，先核实再删）。

**K2 调用账本（建议包名 `@cognia/call-ledger`，从 `@cognia/router-fusion` 切出）**

- 包内：`money`、`state`、`ledger`、`usage`、`util`，加 `contracts` 里属于运行、调用尝试、预留、结算的那一部分，加 `settings/switches.ts`（零导入叶子）。
- 宿主侧：`FusionLedgerStore` 里属于调用账本的方法（`prepareCall`、`markDispatched`、`settleCall`、`markUnknown`、`abandon`、`reserveStage`、`releaseStage`、`recordObservedCall`、`reconcileExpiredUnknown`）、`outbox`、`outbox-appliers`、`retention`、`fusion-db`、`gate/*`（含断路器、故障隔离、拒绝诊断）、`calls/{ledgered-llm-client,utility-run,gateway-ledger-source}`、`chat/{chat-runs,tenant-budget,chat-turn-bridge,store-provider}`、passthrough 与 run-control 的桥。
- 对模块暴露：`CallLedgerPort`（`packages/router-fusion/src/workflows/ports.ts:140`）、`EventSink`、`ArtifactStore`，这三个端口现在已经存在，只是定义在模块一侧的包里，应上移到账本包。
- 存储：保留兄弟库，不动名字（见 §7 问题 2）。账本相关的 6 张表（§2.2）归内核；运行生命周期与产物表按下一条处理；`fusionAccount`、`fusionFeedback`、`fusionApiSessions` 三张表（`fusion-db.ts:75,87,88`）本文没有归类，Run API 相关的两张预计随模块，`fusionAccount` 要看它存的是账号级额度还是模式配置。
- ADR-0250 §6 第 1 条已经把 `fusionOutbox` 列为要迁到统一持久队列的例子（`0250-…md:120-122`），这一步与 K2 的切分共享同一个落点。

**K3 预算策略（`lib/usage` 内）**

- 保留 `cost-budget.ts` 的纯策略，作为所有美元限额的唯一来源。
- 新增一个准入入口，形如"给定一次计划花费与范围，返回允许 / 拒绝 / 需要一次授权"。聊天闸门（`cost-budget-gate.ts:105`）、账本的租户额度（`tenant-budget.ts`）、团队治理器的美元控制器（`run-budget-governor.ts:219-284`）、插件预算（`lib/plugin/agent-sdk/budget.ts`）、工作流应用配额（`quota-service.ts:62-95`）都调它，而不是各自读 `sessionUsage` 再各自比较。
- **不要把 token 预算并进美元账本。** 团队治理器同时限制并发、扇出、尝试次数（ADR-0090 §8 `:267-271`），这些不是钱；组织月度 token 上限（Rust）是另一种单位。统一的是"限额来源"与"准入入口"，不是单位。
- 引擎的日预算与软上限（#3、#4）保持在规划层，只作为选择时的咨询，不作为强制闸门；强制由 K2 的预留负责。

### 5.2 `fusion` 模块

`id: "fusion"`，`kind` 为模块（暂不是插件候选，理由见 §7 问题 4）。

**拥有（沿用现有目录，不搬家，符合 §14"文件只在下次被改时才搬"，`0250-…md:265`）：**

- `packages/router-fusion` 剩余部分：`config`、`routing`、`workflows`、`verify`、`acceptance`、`prompts`、`fake`、`live`、`api`、`contracts` 里的模式部分、`settings/settings.ts`。
- `lib/router-fusion/{runtime,tools,verify,routing,api,eval,agents,prompts,settings,live}`、`calls/role-call-executor.ts`、`db/delegate-store.ts`。
- `components/router-fusion/*` 与设置页的 fusion 区（`components/settings/provider/routing/router-fusion-*.tsx`）。
- 数据：模式与实验相关的表（`fusionRuns`、`fusionRunEvents`、`fusionArtifacts`、`fusionToolOperations`、`fusionDelegateSteps`、`fusionPatchSets`、`fusionAcceptanceApprovals`、`fusionRoutingSamples`、`fusionPredictorManifests`、`fusionShadowDecisions`、`fusionRouteDecisions`、`fusionConfigSnapshots`）。

**提供与需要。**

- `provides`：`route-selector`（给定一次发送的输入，选动作与模式，返回 `RouteDecision`，对应今天 `selectChatFusionRun`、`selectChatDeployment`、`routeRunRequest`，`lib/router-fusion/chat/route-chat-turn.ts:415`、`routing/run-route.ts:202`）；`run-api`（Run API 的模式执行，`lib/router-fusion/api/run-api.ts`）；`acceptance`（现在 `lib/scm/*` 通过类型 `AcceptancePort` 使用，`lib/scm/review/review-changeset.ts:19`、`lib/scm/integration/orchestrator.ts:23`；这个端口类型应当落在内核合同里，而不是模块包里）。
- `requires`：`call-ledger`、`route-planning`（`planRoute`）、沙箱后端、网页与工作区工具。
- 设置键：`routerFusion`。
- 休眠三轴（Rule 7）：`stage` 起步用 `beta`，禁用时 UI 的"已禁用"标签，加一个覆盖生成注册表的测试。现状是六个面开关全默认关（§2.2），开关语义与 `stage` 要对齐，不要出现"开关开着、模块禁用"的半状态。

**manifest 草案（数据，仅示意字段，不是最终形态）：**

```ts
// lib/router-fusion/module.ts（草案）
export default defineHostModule({
  id: "fusion",
  kind: "module",
  stage: "beta",
  owns: ["packages/router-fusion/**"],
  dependsOn: ["call-ledger", "route-planning"],
  provides: ["route-selector", "run-api", "acceptance"],
  requires: ["call-ledger", "route-planning"],
  settings: { keys: ["routerFusion"] },
  tables: [/* 模式与实验相关的 12 张兄弟库表；G7 需要先能识别兄弟库 */],
  taskExecutors: [/* 如果 delegate 的 run 要被调度 */],
})
```

### 5.3 内核到模块的接缝：路由选择端口

`resolveSendOptions` 不再内联 fusion 分支，改成：

1. 内核定义 `route-selector` 端口：输入是路由请求（现有 `RoutingRequest` 加上 `surface`、`sessionId`、提示、提示附件、预算范围），输出是 `RouteDecision`（只含选中的部署、模式、候选序列、原因码）。
2. 默认实现是内核自带的 `direct`（今天聊天的固定动作 `direct_baseline`，`route-chat-turn.ts:91`）：调用 K1 的 `planRoute`，不引入任何模式。
3. `fusion` 通过 `provides` 注册更丰富的实现。端口存在而没有实现提供者时回落到默认；端口有实现但出故障时按今天的 D38 处理（旁路到原路径，计入断路器，`ADR-0188 :41-52`）。
4. 印章与预留（`sealChatRoute`，`route-chat-turn.ts:625`）在内核，因为它属于账本。

这与 §14 的"能力端口"形状一致（`0250-…md:261`，内核定义端口，模块提供实现，消费者 `requires`）。它不走 `capabilityContributions`，因为后者只产出 `AgentCapabilityGrantV1`，不能改写路由。

### 5.4 Rust 侧

- `passthrough_ledger.rs`、`org_usage.rs`、`api_keys.rs`（配额）、`route_ticket.rs`、`cooldown.rs`、`route_planner.rs` 是内核（ADR-0090 §5 把网关定为"首选的安全与路由边界"，`0090-…md:174-200`）。
- `runs.rs` 与 `virtual_models.rs` 是 fusion 专属，经 `brain_bridge.rs` 与大脑通信。这是**概念上**的内核依赖模块，不是编译依赖。要不要拆 crate（`cognia-gateway` 与 `cognia-gateway-fusion`）受 ADR-0196 的分层门禁约束，本文不判断，列入 §7 问题 5。
- planner 是否统一实现见 R7 与 §7 问题 3。

## 6. 迁移顺序

每一步都满足：独立可回滚、不翻转任何默认开关、不改变发送行为，直到最后一步。编号 R 是本文的步骤，与 ADR-0250 的 M0–M4 和阶段号的对应写在"落点"一栏。

| 步                   | 内容                                                                                                                                                                                                                                                                                                                                                                            | 退出条件                                                                                  | 风险                                                                                                                                                  | 落点                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| R0 盘点与棘轮        | 新增路由盘点：引擎手写构造点（现 4）、`fallbackModel` 机制（现 10）、预算机制（现 10）、错误分类器（现 3）、`router-fusion` 外部导入（现 55）；登记到 `scripts/gates/baseline-growth.json`，只许减少。顺手清死代码：`lib/routing/auto-tier.ts`、`routing-fallback.ts:79` 的 `classifyError`、`provider-cost-daily.ts:70` 的 `incrementProviderCost`（每个先确认没有调用方再删） | 盘点可复跑，基线入库                                                                      | 极低                                                                                                                                                  | M0                                                                                                |
| R1 引擎构造点收口    | 把 `chat-turn-bridge.ts:257`、`route-host.ts:38`、`build-options.ts:6461` 改为 `buildRoutingEngine`；`build-options.ts:2028` 因带 `explicitProviderId` 的特殊依赖，工厂加这个参数后同样收口                                                                                                                                                                                     | 手写构造点为 0                                                                            | 低                                                                                                                                                    | M0                                                                                                |
| R2 规划层成形        | 拆散 `lib/routing/`（§5.1 K1）；`routing-runtime-deps.ts`、`lib/ai/routing/*` 归并到一个目录；五个健康与速率 store 迁入内核（订阅方向反转）                                                                                                                                                                                                                                     | 内核代码不再读 `stores/settings/*` 的路由状态（ADR-0250 §5 的棘轮之一）                   | 中：`useCircuitBreakerStore` 等有 UI 订阅方，需逐个迁                                                                                                 | 阶段 2                                                                                            |
| R3 切包              | `@cognia/router-fusion` 拆出 `@cognia/call-ledger`：`money`、`state`、`ledger`、`usage`、`util`、合同里属账本的部分、`settings/switches`。需要先把 `contracts/` 拆开（本文没有量化它的耦合，§9），并跑 `pnpm build:packages`（CLAUDE.md：子 tsconfig 的 `paths` 会替换根的）                                                                                                    | 两个包各自独立构建；`@cognia/call-ledger` 对 `@cognia/router-fusion` 零依赖               | 中                                                                                                                                                    | M0–M1                                                                                             |
| R4 账本存储切分      | 沿现有四个端口（`ledgerFor`、`eventSinkFor`、`artifactStore`、`outboxContext`，`ledger-store.ts:2110-2236`）把 `ledger-store.ts`（2250 行）拆成账本核与运行生命周期两部分；`gate/*`、`calls/*`、`chat/*` 里的账本部分迁入内核目录                                                                                                                                               | 内核到模块的静态边（§4.1 的 21 + 8 个文件）清零或只剩闸门                                 | 高：`ledger-store.ts` 是"唯一写钱的地方"，拆分必须保持"每次变更一个 IndexedDB 读写事务"（ADR-0188 `:64`）。要在不改事务边界的前提下拆文件，不是拆事务 | 阶段 3（"工作脊柱"）与 §6 持久队列同批                                                            |
| R5 预算准入统一      | 新增准入入口（§5.1 K3）；聊天闸门、租户额度、团队治理器美元控制器、插件预算、工作流配额逐个改调它；`RunBudgetGovernor` 的美元控制器要么接线要么删                                                                                                                                                                                                                               | 美元闸门调用点从 3 处变成"所有强制点经同一入口"；团队运行有真实的美元上限，或明确决定没有 | 中：行为变化——今天团队与插件没有美元闸门，接线后会开始拒绝                                                                                            | 阶段 3 之后，可独立排期                                                                           |
| R6 `fusion` 成为模块 | 写 manifest、`route-selector` 端口、`resolveSendOptions` 去掉内联分支；修掉 §4.2 的四条违规；`plugin-contract` 里 `RouterFusionSettings`、`DelegateTimeline` 的引用改走 `settings.keys` 与模式合同                                                                                                                                                                              | G2 在 fusion 上 0 违规；§14 的 G4 能核对 `tables` 与 `settings.keys`                      | 高：这是对聊天发送主路径的改动，要保留 D37"关闭即未改动"的性质                                                                                        | M3（能力端口与设置键归属）；`build-options` 的拆解在 ADR-0250 §14 里已经排在 M3（`0250-…md:298`） |
| R7 Rust 与 TS 一致性 | 先写一致性向量（同一份快照、同一请求，TS 与 Rust 各出一个有序候选，断言一致或把差异登记为已知差异），放进 `tests/conformance/`（CLAUDE.md 已把它列为统一执行的一部分）。向量落地后，由 §7 问题 3 的产品决策决定谁为准                                                                                                                                                           | 向量覆盖 §3.2 表里的每个策略；每一处差异都有"有意"或"待修"的标记                          | 低（只加测试），但会暴露分歧                                                                                                                          | 与 R2 并行                                                                                        |
| R8 回退归位          | `routing-fallback.ts` 随 `lib/claude` 的拆解进入聊天引擎（ADR-0250 §5 的 `lib/runtime/chat-engine/`）；候选选择留在 `RoutingAttemptController`；插件 SDK 的无分类重试（`run.ts:264-266`）改用同一个错误分类器；`fallbackModel` 的五处显式清除改成由账本印章统一处理                                                                                                             | `fallbackModel` 机制从 10 降到有名字、有归属的几套                                        | 中                                                                                                                                                    | 阶段 2（聊天引擎抽取）之后                                                                        |

**关于顺序的两个说明。**

- R2 与 R7 彼此独立，且都不依赖 R3–R6，可以最早开始。R3–R4 要等 ADR-0250 的持久队列（§6 第 1 条）定下 `fusionOutbox` 的迁移方式，否则会先拆一遍再迁一遍。
- 这一路上不要同时做"把 fusion 默认打开"。六个面开关全默认关（`settings.ts:142-165`），实机冒烟是否做过，本文没有查到记录；ADR-0188 的 B7（故障注入矩阵）仍是计划中（`0188-…md:400`）。账本成为内核设施之后，它的"默认值与实机验证"与"代码位置"必须分开决定。

## 7. 需要拍板的问题

1. **账本是否最终默认开启。** 内核设施通常不是可选的，但今天的账本是可选并带断路器与旁路的（D36–D38）。建议迁移期间保持原有语义，是否默认开启另开一个决定，以实机冒烟与 B7 为前提。
2. **兄弟库是否改名与拆库。** 现名 `<主库>-router-fusion-v1`，内核账本放在名为 `router-fusion` 的库里不太顺眼，但改名等于数据迁移，也会动到 §2.2 列出的四条删除路径。建议先不动，只在文档里标明"这个库是调用账本的库"。如果要拆成两个库（账本库与模式库），要重写事务边界，成本远高于文件拆分，不建议在 R4 里一并做。
3. **Rust 与 TS 谁为准。** §3.2 的差异是产品语义，不是实现细节。需要产品给出每个策略的权威定义；技术上的选项是 (a) 以 TS 为准，Rust 移植并对齐向量；(b) 以 Rust 为准，TS 对齐；(c) 两边保留各自的"降级版"，把差异写进文档与界面。本文倾向 (a)，理由是 TS 一侧有完整的健康、亲和、p95 与衰减信号，而 Rust 只拿到快照里的几个数值。
4. **`fusion` 是否会成为插件候选。** 只要它 `provides` 一个端口，§14 就把它归为"插件候选"。但它依赖沙箱、网页与工作区工具、账本、Dexie 的兄弟库、`lib/scm` 的验收端口，§9 的抽取条件很难在短期内清零。建议先作模块，不抽插件。
5. **Rust crate 是否拆开 `runs.rs` 与 `virtual_models.rs`。** 受 ADR-0196 分层门禁约束，拆开可以让"内核不依赖模块"在 Rust 里也成立，代价是多一个 crate 与桥接测试。优先级低于 R2–R6。
6. **预算准入是否要强制覆盖团队与插件。** 这是行为变化（R5），今天团队与插件运行没有美元上限。要不要加、加多少，是产品决定。

## 8. 一句话版本

内核加三块：路由规划、调用账本、预算策略；`fusion` 只拿走"模式"这一层，通过一个路由选择端口接入；Rust 与 TS 先靠一致性向量对齐，再谈合并；迁移从零行为变化的盘点和死代码清理开始，到最后才改 `resolveSendOptions` 主路径。

## 9. 未核实与已知局限

- `crates/cognia-gateway/src/server/*.rs`（6625 行）只读了签名；嵌入、探测、媒体路径是否都经 `route_candidates`（`server.rs:3664`）未确认。
- `packages/router-fusion/src/contracts/`（741 行）里账本合同与模式合同的纠缠程度没有量化，R3 的难度取决于它。
- `lib/usage/run-estimate/` 的调用方没有核对；`lib/goal/*`、`lib/harness/*` 的预算处理只核对了 `maxBudgetUsd` 的几个调用点。
- `lib/sync/handlers/session-usage.ts:50` 写入的同步行是否带 `imported` 标记，没有核对生产方。
- `crates/` 内没有美元账本这一说法来自盘点，没有做穷尽搜索；组织用量存储在桌面端是否挂载，只依据 grep。
- `cognia-problem` 对 `cognia-gateway` 的依赖是否多余，只看了源码里没有 `cognia_gateway` 的引用，没有看 `Cargo.toml` 的 feature。
- §4.1 的比例由正则分类得出，含注释命中，不是精确的边数。
- 没有运行任何测试，也没有做真实提供商或桌面壳的验证。本文是读代码得出的判断，所有"没有生产调用方""没有传入"类的结论，在据此删除或改动前都应当再 grep 一遍。
