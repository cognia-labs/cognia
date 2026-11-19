# ProxyLane 与 Cognia 网络体系的集成评估

日期：2026-11-14（Asia/Shanghai）

本报告是跨项目设计对照，独立保存在 research，避免把尚未实施的建议写进现有 Network Proxy 子系统指南。没有修改运行时代码或集成第三方程序。

## 结论

建议借鉴 ProxyLane 的实际接管状态、连接生命周期、DNS 策略和受限流量观察设计；近期不把它作为 Cognia 的默认网络层，也不整体内嵌 DLL/MITM 栈。

Cognia 已经拥有显式代理策略和 HTTP/流式/WebSocket 原生出口。ProxyLane 的主要增量是 Windows 第三方进程透明接管和 UDP/QUIC 调试。对这些明确场景，可评估可选的外部工具启动适配；先证明有现有 transport/env/launcher 无法满足的需求，再考虑更深入集成。

这一结论是源码对照后的架构建议，不是 Windows 兼容性验收或性能结论。

## 分析基线与证据边界

- Cognia：当前工作树，HEAD 为 `28c112651e20c706c73b97c149e72256de64550f`。工作树存在大量并发修改和未跟踪文件；本文描述读取时的源码，不代表 HEAD、已发布版本或线上部署完全相同。
- ProxyLane：`d73d50b96b4fc3aed8ea342e6565f91841923e39`；最近核查的正式发布是 2026-11-12 的 v1.5.0。[上游提交](https://github.com/threatexpert/ProxyLane/commit/d73d50b96b4fc3aed8ea342e6565f91841923e39)、[发布记录](https://github.com/threatexpert/ProxyLane/releases/tag/v1.5.0)。
- CodeGraph CLI 已安装，但当前仓库没有索引；本次使用窄范围 rg 和源码调用链核查，没有创建索引。
- 运行了 7 个 Jest 套件及网络出口静态门禁，结果见文末。未运行 Rust、Tauri、Windows、真实 provider、ProxyLane 或跨平台 E2E。
- 相关约束包括 ADR-0028/0182 的沙箱出口、ADR-0118 的模型请求回放与 ADR-0196 的 native crate 分层。ADR-0250 当前标为 Proposed，仅用作 Host 方向背景，不视为全部已接受或已交付；具体实现判断以代码为准。

## Cognia 当前已有的体系

### 1. 一个 native 代理策略，多种受管 transport

`crates/cognia-net/src/proxy_config/mod.rs:23-59` 定义 Off/Manual/Auto、HTTP/HTTPS/SOCKS5、单个 endpoint、凭据、bypass 和 WebSocket 开关。Auto 是本地代理软件/端口发现与协议验证，不是操作系统 PAC 或进程透明接管（`detect.rs:1-17`）。

`route_for` 产生 Direct/Proxy 和原因；WebSocket 在配置为代理但不允许代理 WS 时明确拒绝，不静默直连（`mod.rs:237-260`）。运行时有 Uninitialized/Ready/Blocked 状态（`:529-551`）；初始化/错误期间不会默认获得直连权限。

| 请求类型          | 当前实际入口                                                                                | 含义                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 前端普通 HTTP     | `lib/network/proxy-fetch.ts:118-221` → `proxy_http_prepare/request/cancel`                  | Tauri 侧调用 Rust；策略与代理凭据由 native 处理         |
| 跨平台普通 HTTP   | `lib/network/platform-fetch.ts:182-220`                                                     | Tauri 原生桥、CapacitorHttp、浏览器 fetch 分流          |
| SSE/NDJSON/大响应 | `lib/network/platform-streaming-fetch.ts:230-295` → `proxy_http_stream_open/ack/cancel`     | Tauri Channel + ReadableStream；非 Tauri 路径采用 fetch |
| WebSocket         | `lib/network/platform-websocket.ts`、`crates/cognia-net/src/proxy_config/wsproxy.rs:34-133` | 明确建立 CONNECT/HTTPS CONNECT/SOCKS 隧道               |
| Rust 请求         | `crates/cognia-net/src/http_client.rs:197-290`                                              | 每目标应用 managed_client；另有 guarded/public 路径     |
| sidecar / 子进程  | `crates/cognia-sidecar/src/supervisor.rs:148-180,1006-1012`                                 | 启动时注入已解析的代理环境与 host 标记                  |

这些 Tauri 命令已在 `src-tauri/src/lib.rs:1488-1500` 注册。共享包的网络 adapter 也有启动接线：`lib/network/desktop-network-runtime.ts:77-92`、`lib/ai/provider-core-runtime-deps.ts:44-49`、`components/providers/initializers/deferred-boot-initializers-impl.tsx:70-80`。

不过，不能据此声明“所有模型调用都走同一个 fetch”。`createFeatureProviderClient` 默认采用 `getStreamingFetch()`（`lib/ai/provider-consumption.ts:592-593`），后者通常返回 global fetch（`lib/runtime/streaming-fetch.ts:32-42`）；Twin 等调用方显式传入 native streaming。普通桌面聊天则走 controller → sendPrompt → PII gate → Host agent_send/claude_send（`hooks/chat/use-claude-chat-controller.ts:6870-6885`、`lib/claude/ipc.ts:559-584,659-685`）。factory 默认值本身不能证明桌面主聊天发生绕过。

### 2. 凭据与资源控制已有更适合 Cognia 的基础

- `src-tauri/src/proxy_config/commands.rs:65-123` 串行化 keyring hydration 和策略发布；renderer 不获得代理密码。`lib/network/proxy-credentials.ts:37-95` 包含旧明文配置迁移及 keep/replace/clear 逻辑。
- `src-tauri/src/proxy_config/stream.rs:48-69,234-400` 已有限定的未 ACK 窗口、分块、消费停滞超时、取消和 generation 清理。不要把“支持背压”当成需要从 ProxyLane 首次引入的能力。
- `components/settings/network/network-section.tsx:27-76` 已有 General/Detection/Test/IP。`tabs/test-tab.tsx:80-105` 已显示经过清理的路由、状态与延迟；建议应扩展这些面板，而不是重复造基础代理测试页。
- `managed_client` 为每个新请求重新应用策略（`mod.rs:750-775`）；延迟探针另按 origin 与配置摘要缓存（`net_meter.rs:225-230,262-289`）。不应未经性能测量直接建议增加一个全局 singleton client。

### 3. 应用代理、目标授权与沙箱隔离是不同职责

`crates/cognia-exec-sandbox/src/net_proxy.rs:526-542` 根据原域名选择路由，但经已经核验的 IP 建立直连或代理隧道。Linux/Docker allowlist 还结合 namespace/network=none 与受控 bridge（ADR-0028、ADR-0182），不依靠子进程自愿遵从环境变量。

DNS 也不是一个全局开关能概括：

- 常规 SOCKS 路由使用 socks5h，交由代理解析目标（`proxy_config/mod.rs:207-234`）。
- generic guarded bridge 对远端代理 DNS 有明确的 best-effort 边界（`guarded_http.rs:1-6,519-541`）。
- 更严格的 public 请求路径使用已检查 IP 的 CONNECT/SOCKS，TLS 继续使用原始域名（`guarded_http.rs:218-261`、`pinned_http.rs:116-148`）。
- MCP/OAuth 的 Node 路径另有 socket lookup guard 和自有 dispatcher（`sidecar/src/platform/net/egress-guard.ts:154-204`）。这说明还要验证不同 dispatcher 与全局代理组合后的语义，不能仅因安装了进程级 fetch interceptor 就认定每条路径相同。

ProxyLane 不能代替这些授权与限制；尤其不能用透明代理放宽 network-off 或 allowlist 的执行边界。

## 真正值得借鉴的设计

| 借鉴点                 | Cognia 当前基础                                           | 建议与优先级                                                                                        |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 显示实际接管范围       | 已有 proxy_get_active、route summary、请求 ID、测试页     | 高：按 transport/进程显示配置是否已应用、哪些连接仍用旧配置；区分配置成功与实际覆盖                 |
| 显式能力矩阵           | 前端已检查 admission/download 协议版本                    | 高：扩展既有能力协商，明确 native HTTP、stream、WS、embedded browser、sidecar 的协议/DNS/热更新差异 |
| 连接与进程生命周期     | 新请求重建 client；sidecar 启动注入环境                   | 高：建立“新请求已生效 / 旧连接继续 / 子进程待重启”的可观察状态，不承诺瞬时全局改路                  |
| DNS 策略与失败语义     | socks5h、系统解析、checked-IP tunnel 并存                 | 中：先明确每条出口的解析位置；确有需求再增加代理内 DoH、bootstrap、TTL 缓存与并发查询合并           |
| 有界、可离线读取的诊断 | 已有 operation metrics、trace、模型请求摘要与 eval replay | 中：先记录阶段/字节/路由/错误等元数据；正文捕获单独 opt-in，按会话/请求关联并加密脱敏               |
| 子进程接管状态         | 已有 env 注入、显式 launcher、沙箱 bridge                 | 中：先核查工具是否支持显式代理；Windows 特殊进程才评估外部 Hook 适配                                |
| SSH / 多跳代理链       | 当前主配置只支持单跳 HTTP(S)/SOCKS5                       | 低：需求明确后在 cognia-net 内扩展连接器，不能仅为功能对齐引入整包                                  |

上游的对应依据：[DNS 与使用边界](https://github.com/threatexpert/ProxyLane/blob/d73d50b96b4fc3aed8ea342e6565f91841923e39/README.md)、[Hook 连接注册](https://github.com/threatexpert/ProxyLane/blob/d73d50b96b4fc3aed8ea342e6565f91841923e39/src/ProxyLaneHook/HookWinsock.cpp#L1349-L1487)、[资源参数](https://github.com/threatexpert/ProxyLane/blob/d73d50b96b4fc3aed8ea342e6565f91841923e39/src/ProxyLaneMitm/src/options.rs)、[录制格式](https://github.com/threatexpert/ProxyLane/blob/d73d50b96b4fc3aed8ea342e6565f91841923e39/src/ProxyLaneProtocol/src/recording-format.txt)。

### 热更新需要单独说明

当前 settings save → proxy_apply → renderer-local applied event（`stores/settings/settings-store.ts:940-953`、`stores/network-proxy/index.ts:144-165`）。该事件当前观察到的监听方是 embedded browser 重新导航（`hooks/browser/use-browser-pane-webview.ts:215-225`）。

sidecar 的代理是 native 启动快照；fetch interceptor 也只安装一次（`sidecar/src/platform/net/fetch-interceptor.ts:257-281`）。上述设置路径没有 sidecar 重启/重新配置调用。可以据此确定不同 transport 的配置应用生命周期不同；尚未做运行时实验，不能把它扩大成“所有活跃 sidecar 都必然错误”或“设置变更已全局生效”。

建议先增加策略版本与每个受管进程应用状态，并按 adapter 明确新请求重建、重连或用户确认重启的行为。ProxyLane 文档关于既存连接和浏览器后台复用的提醒，值得在 Cognia 内具体化。

### DNS 借鉴必须保留目标校验

ProxyLane 的 DoH 通过调用方提供的代理隧道执行，使用 bootstrap IP，失败不回落普通 DNS；TTL 和共享查询也有明确语义。这类设计有用，但 Cognia 不能简单把所有 DNS 改成远端 DoH：

1. 内网模型、局域网服务与私有 MCP 是有效的显式使用场景，不能不分请求目的全部禁止或全部放行。
2. public-only 请求仍需检查全部解析结果、固定连接 IP，并对重定向重新授权。
3. proxy endpoint 自身解析、bootstrap、业务目标解析是三个不同边界。
4. 若增加缓存，至少隔离解析策略/代理路由和相关授权范围；取消一个请求不能错误取消共享查询。
5. 首阶段先保证“行为可解释且无静默降级”，是否新增 DoH 应由真实 DNS 问题驱动。

### 录制应复用语义层，保留 Cognia 已有隐私契约

Cognia 已有：

- 仅携带摘要和引用的 model-request shadow（`lib/ai/replay/model-request-shadow.ts:75-140`）。
- actor 维度的 replay ledger（`lib/ai/replay/lease.ts:117`）。
- 录制代理在模型请求发出前调用 PII 检查（`cli/src/eval/replay/recording-proxy.ts:169-190`）。
- 真实 fixture 加密封装（`cli/src/eval/replay/fixture-maintenance.ts:45-64`）。
- ADR-0118 明确录制 opt-in、凭据排除、真实数据不入库，以及 canonical/runtime fidelity 区别。

这些并不证明全产品已经实现通用录制，但足以构成扩展所有权。网络诊断应关联 session/run/provider/request，而不是再建一套只能看到 PID 的观测系统。ProxyLane 的离线流量查看也不能直接替代 Cognia 的确定性模型回放。

上游普通代理密码、PSK 及部分私钥口令会写入 INI（[ProxyProfileStore](https://github.com/threatexpert/ProxyLane/blob/d73d50b96b4fc3aed8ea342e6565f91841923e39/src/ProxyLane/ProxyProfileStore.cpp#L200-L224)）；原始录制保留未经脱敏的字节。Cognia 不宜同步 keyring 密码到这种配置，也不宜自动把录制交给模型分析。

## 集成方式判断

| 方式                            | 判断               | 主要原因                                                                                    |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| 替换 Cognia 默认 HTTP/WS 网络层 | 不建议             | 高度重复现有策略；Windows-only，无法统一 Web/Capacitor/Linux/macOS/远程 Host                |
| 整体内嵌 Hook DLL 与 MITM/QUIC  | 近期不建议         | 增加注入、架构、浏览器版本、CA、构建和发布维护；自身受管请求可在已有 transport 观察         |
| 仅移植 Rust 协议/录制模块       | 暂无充分需求       | 需证明协议解析需求及安全/资源收益；现有 trace/eval 所有权应先复用，不因 Rust 实现就直接接入 |
| Windows 外部工具启动适配        | 有条件可行，未验证 | 用于明确不遵从显式代理的第三方进程，选择已有 profile，由用户控制安装与作用范围              |
| 导入离线诊断结果                | 可作为后续独立能力 | 需要受限解析、文件大小/路径校验、凭据脱敏与留存规则；原始记录不得自动发往模型               |

### 可调用接口存在，但不能当作现成的通用代理服务

ProxyLane 的 automation parser 支持 `--auto --profile ... --run ...`（[AutomationOptions.cpp](https://github.com/threatexpert/ProxyLane/blob/d73d50b96b4fc3aed8ea342e6565f91841923e39/src/ProxyLane/AutomationOptions.cpp#L147-L253)），Hook DLL 也导出若干入口（[exports](https://github.com/threatexpert/ProxyLane/blob/d73d50b96b4fc3aed8ea342e6565f91841923e39/src/ProxyLaneHook/ProxyLaneHook.def)）。因此外部启动适配有源码依据，不能说它完全没有自动化接口；本次未验证稳定的跨版本 SDK 合约。

PRC 的 TCP listener 要求先有 Hook 登记的原连接信息，没有登记便关闭 socket（[PRCTcpServer.cpp:187-203](https://github.com/threatexpert/ProxyLane/blob/d73d50b96b4fc3aed8ea342e6565f91841923e39/src/ProxyLaneHook/PRCTcpServer.cpp#L187-L203)）。不应把该端口直接填进 Cognia，当成普通 SOCKS5/HTTP forward proxy。

### 双重路由权威是实质风险

架构推断：Cognia 已配置远程代理 A 时，底层 Hook 看到的目标可能是 A，再经 ProxyLane 的代理 B 发起连接，形成未显式规划的 B→A 链。若 A 是本地 loopback，ProxyLane 的真回环绕过又可能使它不受接管。于是 UI 展示的 Cognia 路由与最终物理路径可能不同。

每条流量应有明确的路由所有者。若外部工具适配需要让 ProxyLane 接管，应在单独启动范围中明确代理职责；不能全局关闭 Cognia 的安全策略，或把 Hook 当作沙箱执行凭据。

透明网络 Hook 也不能修复 WebView 在 CSP/CORS 层拒绝的请求；没有 socket 发出时，底层没有连接可接管。打包 static-export 的 native bridge 仍然需要保留。

## 建议的工作顺序与验收

这些是建议，尚未授权或实施。

1. **先收敛出口与应用范围。** 对静态门禁 18 处发现逐项确认归属：改用受管 transport 或添加有依据的窄例外。验收：门禁通过；普通、流式、WS、sidecar、外部 CLI 分别记录实际出口；不能只测一个 HEAD 请求。
2. **补配置生命周期与诊断。** 复用现有 proxy status/test/IP 页、requestId、trace 与 sidecar supervisor；明确新请求、既有 SSE/WS 和长活进程的策略版本。验收：切换代理、密码、bypass、Off 后，分别证明下一请求与既存连接的实际行为，覆盖失败和取消。
3. **按问题增加 DNS/受限捕获。** 保留 checked-IP 和重定向授权；默认仅采元数据，正文捕获复用 PII/加密资产和回放合约。验收：无静默本地回退、共享查询取消隔离、TTL/配额、敏感头不入记录、容量满后行为明确。
4. **Windows 外部适配做单独 PoC。** 先选择一个现有 adapter/env 无法覆盖的具体工具，验证固定 ProxyLane 版本/profile/进程树，含重启、退出、异常恢复和升级。对 x64/ARM64、既存连接、浏览器复用、DNS/UDP/IPv6 分别取证。没有这些证据前不默认打包、自启、注入 Cognia 或安装 CA。

对于 SSH/多跳，应先有明确用户场景，再在 cognia-net 的连接器层评估；无需把 Windows GUI 和注入层带入跨平台主链路。

## 本次验证结果

通过：

```text
pnpm test --runInBand --runTestsByPath \
  lib/network/proxy-config.test.ts \
  lib/network/proxy-fetch.test.ts \
  lib/network/platform-fetch.test.ts \
  lib/network/platform-streaming-fetch.test.ts \
  lib/network/proxy-credentials.test.ts \
  lib/network/desktop-network-runtime.test.ts \
  lib/ai/replay/model-request-shadow.test.ts

Test Suites: 7 passed, 7 total
Tests:       131 passed, 131 total
```

未通过：

```text
pnpm audit:network-egress
[network-egress] 18 unmanaged egress site(s)
exit 1
```

门禁发现涉及 `components/mobile/discover/twin-sources-panel.tsx`、`lib/ai/media/video-jobs/host.ts`、`lib/decisions/providers/decision-sdk.ts`、`decisions-http.ts`、`lib/remote-desktop/native-stream.ts`、`packages/agent-rovo/src/service-launcher.ts` 等，以及若干 native `.no_proxy()`/新 client 调用。它们是当前脏工作树上的未声明出口发现，尚未逐项证明为实际泄漏或产品缺陷。此处没有修改 baseline 或修复其他会话的改动。

本次没有做功能实现，所以未运行全量 typecheck/build/lint、Rust 测试或 UI/E2E。131 项单测通过不能代替真实代理、桌面、Windows 注入、真实 provider 或生产网络验收。
