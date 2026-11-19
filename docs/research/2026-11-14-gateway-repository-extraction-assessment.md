# Gateway 独立仓库可行性评估

日期：2026-11-14，Asia/Shanghai。

范围：评估现有 Gateway 能否拆为独立维护的 Rust 库，以及进一步成为 Claude Code / Codex 可直接使用的独立模型网关。本轮只分析并在 `.cache` 中复制源码做隔离实验；未创建远端仓库、未迁移生产代码、未修改 Cargo 集成或真实客户端配置。

## 判断

**可以拆，已有足够的核心模块化基础；当前尚不适合直接把目录搬走后作为独立产品发布。**

应分别看待三种目标：

| 目标                                                             | 当前可行性                                    | 主要工作量                                     |
| ---------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| 外仓维护的可嵌入 Rust Gateway 库                                 | 可行，隔离构建已验证；Cognia 消费方式尚需处理 | 中：依赖身份、宿主接口、共享契约与测试迁移     |
| 同一仓库再提供独立 `gatewayd`                                    | 可行，但当前 crate 没有 bin target            | 中到高：启动、配置、密钥、管理入口、日志与发布 |
| 将全部 Cognia Gateway 页面、Brain、插件、Runs 和组织能力一并独立 | 尚未形成独立产品闭环，不宜作为首次拆仓范围    | 高：跨 Rust/TS、Dexie/SQLite、账号和插件系统   |

这里的工作量是范围等级，不是经过排期验证的工期。独立发布的质量门槛还必须包括前一轮发现的 P1 修复；搬仓不会改变其错误行为。

## 已执行的隔离实验

完整命令、状态和限制见 [validation.json](../../.cache/diagnostics/2026-11-14-gateway-extraction/validation.json)。实验没有改原文件。

1. **只复制 `cognia-gateway` 到自己的 workspace：失败。** `cargo metadata --offline --no-deps` 返回 101，首先遇到 `workspace.package.edition was not defined`。它的 manifest 继承根 workspace 的 edition、MSRV、license、publish、dependencies 和 lints，且还有 sibling path dependencies。
2. **复制完整本地生产依赖闭包：库检查通过。** 将 Gateway 和 6 个基础 crate 放进独立 workspace，显式提供原 workspace 配置与 lockfile，执行默认 feature 的 `cargo check --offline -p cognia-gateway --lib`，exit 0，耗时 19.63 秒。平台为 macOS Apple Silicon；没有启用 `tauri-host`。
3. **同一隔离副本检查 tests：失败。** `cargo check --tests` 返回 101，两个 `include_str!` 仍读取原应用的 TypeScript 文件。详见 [isolated-tests.log](../../.cache/diagnostics/2026-11-14-gateway-extraction/isolated-tests.log)。这不是已经跑完测试后的失败，而是测试目标尚不能编译。
4. **模拟 Cognia 同时使用原基础 crate 与拆出副本：失败。** 消费者依赖原 `cognia-net` / `cognia-secrets` / `cognia-instrument`，并引用隔离 Gateway；`cargo tree --offline` 报 `package collision in the lockfile`，首先冲突的是两个 path 来源的 `cognia-core v0.1.0`。没有执行真实 Git 来源的消费验证。

第 2 项证明可以形成独立构建单元，第 4 项说明“带走依赖副本”不能直接成为最终集成方式。

## 已有的良好拆分基础

- [Cargo.toml](../../crates/cognia-gateway/Cargo.toml) 已将其声明为独立 library，默认 feature 为空；`tauri-host` 为 opt-in。无需把整个 Tauri 应用作为必需依赖搬走。
- [route_planner.rs](../../crates/cognia-gateway/src/route_planner.rs)、`execute.rs`、`translate/`、`cooldown.rs`、`concurrency.rs` 等核心行为集中在 crate 内。
- [GatewayHost](../../crates/cognia-gateway/src/host.rs) 已有 desktop 与 [headless](../../crates/cognia-companion-rpc/src/gateway_host.rs) 两种 Adapter，事件接口不是假设出来的扩展点。
- V2 routing snapshot 已使路由选择在 Rust 内执行；正确的 standalone 配置输入不必要求启动 Next.js 或 WebView。
- 已有 `BrainBridge`、`TicketMetaStore`、`MemberUsageStore`、`CredentialResolver` 等 Interface，可复用而不必设计第二套相同能力。
- [inference_http.rs](../../crates/cognia-gateway/tests/inference_http.rs) 已以真实 HTTP upstream fixture 检查协议行为，具备迁移回归测试的基础。

## 真正需要切开的耦合

### 1. 构建依赖与共享 crate 身份

Gateway 有 5 个直接本地生产依赖：`cognia-agents`、`cognia-core`、`cognia-secrets`、`cognia-net`、`cognia-instrument`；再通过 core 引入 `cognia-problem`，生产依赖闭包合计 7 个 crate，见 [workspace-metadata.json](../../.cache/diagnostics/2026-11-14-gateway-extraction/workspace-metadata.json)。

这些基础 crate 同时被 Cognia 其他模块使用。长期在两仓各维护一份，除了本次已复现的 path package collision，还存在共享状态分裂风险：secret store 初始化、网络代理当前配置、instrumentation registry 都有进程全局状态。即使将来源改成 Git 使 Cargo 能区分 package ID，也不能假定两份状态会共享。后一项是根据当前全局状态实现作出的风险判断，未运行 Git 双副本实验。

建议优先采用宿主注入：网络客户端/egress policy、API-key store、用量 store、事件与指标由 Adapter 提供。纯文件写入和平台客户端配置应有明确单一 owner。必须保留的共享基础 crate，需要让两仓消费完全相同的来源和 revision。

### 2. `GatewayHost` 只隔离了事件，没有隔离全部宿主能力

该 Interface 只有 `emit` 与 `supports_live_decisions`。但 [api_keys.rs](../../crates/cognia-gateway/src/api_keys.rs) 仍直接调用 `cognia_secrets::secret_store`，server 定时 flush 也直接保存 keys；网络请求读取 `cognia_net::proxy_config::current()`。

因此，不能把“实现 GatewayHost”当成完成整个迁移。已有 `CredentialResolver` 也不等于 API-key 持久化和网络策略已经全部反转依赖。

`cognia-secrets` 已有 `init_headless`、主密钥环境/文件输入，无需声称要从零重写加密存储；独立宿主仍需拥有初始化、数据目录、命名空间和失败处理，避免误用原 Cognia 安装的存储。

### 3. 配置控制面仍由 Cognia 产生

桌面 [snapshot-publisher.ts](../../lib/gateway/snapshot-publisher.ts) 从应用设置、provider/model catalog、价格、订阅额度和 routing adapters 编译 snapshot；headless 在 [main.rs](../../crates/cognia-server/src/main.rs#L3061) 从 Profile Store 读取配置并发布。

独立 Gateway 需要自己的配置加载、验证、热更新和 credential resolution。可以直接支持一个版本化 snapshot/config 文件作为第一阶段，避免首期就复制 Cognia 的 Dexie、SQLite 和全部 provider 设置 UI。字段含义、版本、校验与 secret 引用必须明确，不能只保存一个能临时工作的 JSON dump。

### 4. 基础模型代理与 Brain 扩展需要明确分层

[brain_bridge.rs](../../crates/cognia-gateway/src/brain_bridge.rs) 明确说明：Runs、Sessions、Artifacts 的状态权威在 Brain；`cognia/*` 虚拟模型与 passthrough ledger 也通过该桥接执行。部分隐私掩码、插件中间件、搜索/视觉补偿走 [runtime-bridge.ts](../../lib/gateway/runtime-bridge.ts)。

独立仓库可保留这些 Interface 和明确的 unavailable 行为，但不能宣称无 Brain 时仍支持这些完整功能。纯模型 proxy 的默认运行路径应能脱离 Cognia；高级能力由 Cognia Adapter 或将来的独立实现提供。配置要求的关键安全环节不可用时，仍必须失败关闭。

### 5. 可执行宿主和管理入口尚未在 Gateway crate 内

Cargo metadata 只列出 lib、tests、bench，没有 bin。当前启动、配置初始化、profile 更新订阅、master-key 初始化和部分管理命令分布在 `cognia-server` / Tauri / Companion RPC。

独立 `gatewayd` 至少要负责配置/secret store 初始化、key 管理、启动/停止、信号退出、日志和健康检查。管理入口不能因为脱离原 Companion 认证就变成公开可写。它是新增宿主，不能把当前整个 `cognia-server` 搬过去当成“小启动器”。

### 6. 跨仓测试与契约不能依赖相对目录窥探源码

已经复现的编译耦合：

- `brain_bridge.rs:271` 读取 `lib/router-fusion/gate/run-api-bridge.ts`。
- `passthrough_ledger.rs:707` 读取 `lib/router-fusion/gate/passthrough-bridge.ts`。

另外，header policy 测试读取 `packages/provider-types/fixtures/header-policy-cases.json`；部分测试扫描根目录的 manifests，benchmark 假定 crate 位于 `workspace/crates`。需要迁出独立 contract fixtures/schema，并在 Cognia 侧保留 integration parity 检查，而不是复制应用目录来满足路径。

## 建议的仓库归属

| 新 Gateway 仓库拥有                                    | Cognia 仓库保留                                    |
| ------------------------------------------------------ | -------------------------------------------------- |
| 模型 HTTP 入口、协议转换和流状态机                     | Next.js 设置界面、Tauri IPC 与生命周期适配         |
| 路由、key rotation、冷却、重试、并发限制               | 应用账号、组织身份与当前账号切换触发               |
| ticket/lease 的执行规则和存储 Interface                | 现有 vault/Profile Store 到 Gateway 配置的 Adapter |
| 版本化 config/snapshot/telemetry/ticket 契约与 fixture | Brain、Dexie、Router Fusion、插件实现              |
| 同一核心的 standalone daemon、CLI 管理与独立 CI        | Cognia 对外仓版本的 pin、端到端兼容检查            |

建议首次拆分保持一个核心 crate，加一个 standalone runner；不要为每个内部文件创建新 crate。Cognia 继续嵌入同一个核心库，使 desktop/headless 和 standalone 修复来自同一 owner。

## 推进顺序与每步验收

1. **明确第一版范围。** 以外部 CLI 模型代理为主；列清 Brain 扩展的支持模式。验收：能力清单不以“存在路由”代替运行条件。
2. **在当前仓库收紧 Interface。** 将必须共享的 secret/network/metrics 全局状态交给 Adapter，处理客户端配置 IO 归属。验收：Cognia 与候选外仓核心共同消费时没有基础 crate 冲突或双份状态。
3. **迁移核心与契约，保持 Cognia 固定 revision 消费。** 可参考已经存在的 [cognia-services pin](../../integrations/cognia-services.json) 和 [contract gate](../../scripts/gates/check-cognia-services.mjs)。验收：干净 checkout 中独立构建/测试通过；Cognia 的 desktop/headless 兼容测试通过。
4. **补独立 runner。** 验收：无需 Cognia 配置/进程即可启动，设置 upstream、创建 key、重启保留配置、正确退出，并通过真实 Claude/Codex 基础生成与工具调用流程。
5. **达到发布门槛。** 修复前轮关键 P1，并验证多 provider/key、混合协议、断连、重启、凭据撤销；再补 Linux/container/Windows 等明确支持的平台。验收：同一组 contract 和故障测试在独立宿主及 Cognia 宿主通过。

当前 workspace 还继承 `publish=false` 和 `AGPL-3.0-or-later` 等发布元数据；新仓需要显式配置自己的 package/repository/release 策略。本报告不作许可证法律结论，也未执行发布。

## 风险与限制

- [上一轮对抗性审查](../evidence/2026-11-14-gateway-external-cli-adversarial-review.md) 的 16 个关键源码哈希本轮未变化；本次没有修复其中的 P1。
- 隔离 `--lib` 通过不代表 tests、真实运行或消费端集成通过；后两项实验分别发现了实际阻碍。
- 没有对原工程修改 dependency source，没有创建真实外仓，没有验证外仓 Git 引用、发布 artifact、Linux/Windows 或容器。
- 拆仓不会自动带来多实例共享调度、更高吞吐或安全性提升；这些需独立需求与证据。
