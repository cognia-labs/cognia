# Gateway 外部 CLI 接入与负载均衡对抗性审查

审查日期：2026-11-14，Asia/Shanghai。

用户要求：在 Claude Code / Codex 进程连接指定 API 地址、由 Gateway 负载均衡的场景下，做一次对抗性审查，寻找更多缺口。

本轮没有修改产品源码、真实客户端配置或密钥，没有提交、推送或调用真实模型。新增此报告以保留本次聚焦外部 CLI 的反例，不改写此前 Gateway 修复台账。复现程序与日志保存在本机 `.cache/diagnostics/2026-11-14-gateway-review/`。

## 结论与证据范围

基础协议入口和调度算法已经存在，但不能由此推导出外部 CLI 接入、账号轮转和跨协议故障切换已经可靠。本轮确认 **20 项新增缺口，其中 8 项 P1、12 项 P2**，另列两项尚未运行真实 CLI 场景的源码风险。上一轮已经发现的 Codex 自动票据权限缺口不计入新增数量。

这里的“复现”分三种，不能混为生产验收：

- **HTTP**：运行真实 Rust Gateway 或 Node proxy，连接本机合成 upstream，检查状态、wire body 和命中次数。
- **函数/状态机**：直接编译当前 Rust 源模块或调用 Gateway 公共函数，验证状态迁移及生成的协议数据。
- **注入**：调用实际 CLI 函数，注入合成环境、配置、探测和启动依赖；没有启动真实 Claude/Codex 来证明用户流程。

三名独立上下文 reviewer 分别审查客户端、路由和协议；主会话复核源码，并补充并发与 HTTP 反例。跨模型复核已提供可选入口，本轮没有调用外部模型。未运行真实供应商、生产压测、完整桌面 UI 或真实 Claude Code 推理，因此不推断线上频率、实际吞吐量或所有客户端版本的表现。

16 个关键源码文件的 SHA-256 与当时 HEAD 保存在 [source-manifest.json](../../.cache/diagnostics/2026-11-14-gateway-review/source-manifest.json)。共享工作区存在其他任务的改动；本报告不是整个仓库的冻结快照。

## 审查契约

需要证伪的判断：一个外部 CLI 选择 Gateway URL、模型和凭据后，实际调用应保持该选择，并只在授权、协议兼容和能力满足的候选之间调度。Why：误选 endpoint 会改变数据和密钥去向；错误的账号切换、流式终止或容量计数会让编码任务失败或留下错误历史。

相关约束来自：

- [ADR-0163 §6](../content/docs/en/adr/0163-provider-operation-contract.md)：management credential 不进入 Agent 子进程。
- [ADR-0090](../content/docs/en/adr/0090-unified-agent-execution-and-gateway-compatibility.md)：候选冻结、credential affinity、认证失败切换、协议透明性与提交响应后的重试限制。
- [ADR-0043 Phase 9](../content/docs/en/adr/0043-llm-provider-execution.md)：能力过滤、deployment/key 独立轮转、冷却和有界重试。
- 当前代码承诺的并发排队上限、配置热更新和客户端模型持久化行为。

## P1：凭据、授权与核心执行失败

### F01 — Host 管理令牌进入 Claude/Codex 子进程

- **触发**：使用 `COGNIA_SERVICE_TOKEN` 连接 headless Host，再运行 `cognia-agent x`。
- **原因**：[agent-launcher.ts:258](../../cli/src/x/agent-launcher.ts#L258) 复制父环境，删除名单不包含该管理令牌；[mint-ticket.ts:146](../../cli/src/x/mint-ticket.ts#L146) 恰好要求用户在父环境配置它。
- **证据（注入）**：`serviceTokenInherited=true`，而对照的 `OPENAI_API_KEY` 确实已移除。只使用 sentinel，没有读取或输出真实令牌。
- **影响**：外部 Agent 及其工具可读取 Host 管理权限，违反 ADR-0163 的明确边界。另观察到 `CODEX_ACCESS_TOKEN` 被保留，但其特定客户端认证优先级未在此认定。
- **修复方向**：以运行所需环境白名单构造子环境，并移除 Host、bridge、provider 管理凭据。

### F02 — fallback 把供应商 B 的 key 配给供应商 A 的地址

- **触发**：同协议配置中，A 有 `baseURL` 但没有 key；B 有自己的 `baseURL` 和 key。
- **原因**：[x-command.ts:400](../../cli/src/cli/x-command.ts#L400) 与 [x-command.ts:420](../../cli/src/cli/x-command.ts#L420) 分别选择首个有 key 的 provider 和首个有 URL 的 provider，没有保持同一来源。
- **证据（注入）**：最终配置为 `second-owner-key-sentinel` + `https://first-owner.invalid/v1`。
- **影响**：除了认证失败，还可能将一个供应商的真实密钥发往另一运营方的 endpoint。探针只构造配置，未向外发送该 sentinel。
- **修复方向**：从同一个 provider 原子解析 protocol、endpoint、credential；缺失项不能从另一个 provider 拼接。

### F03 — 显式指定的 Gateway 不可用时改用其他 upstream

- **触发**：明确传入 `--gateway`、配置 gateway 或 `COGNIA_GATEWAY_URL`，但其 `/healthz` 探测失败。
- **原因**：[gateway-connect.ts:244](../../cli/src/x/gateway-connect.ts#L244) 对默认发现和显式目标采用同一个 Node fallback 分支。
- **证据（注入）**：显式远端 URL/key 最终得到 `mode=node-proxy`、本地 fallback 地址。
- **影响**：请求不再经过选定 Gateway 的 alias、策略和审计边界；CLI 虽输出连接模式，但没有要求用户重新选择路由。Node fallback 的本地 HTTP 对照还证明，正常 PII 检查会拒绝的合成邮箱原文能够到达 upstream，不能把两条路径的隐私行为当成相同。
- **修复方向**：显式目标不可用时失败关闭；自动发现情况下的 fallback 与显式绕行应分别建模。

### F04 — streaming 等待响应头没有超时，健康备用线路不会被尝试

- **触发**：首选 upstream 接受 TCP 和请求，但一直不返回 HTTP 响应头。
- **原因**：[server.rs:4196](../../crates/cognia-gateway/src/server.rs#L4196) 对 streaming 不设置 request timeout；[server.rs:4296](../../crates/cognia-gateway/src/server.rs#L4296) 的 `send().await` 没有 header deadline。stream idle timeout 在取得响应、进入 [stream_response](../../crates/cognia-gateway/src/server.rs#L4852) 后才生效。
- **证据（HTTP）**：connect/request/stream-idle 三个 timeout 均设为 1 秒；2.2 秒后首请求仍 pending，健康 backup 命中 0 次；并发上限为 1 时第二请求返回 429。
- **影响**：未提交响应也不触发故障切换，并持续占用 concurrency slot。源码中该阶段无超时；实验只观察有界的 2.2 秒，未无限等待。
- **修复方向**：独立限制取得响应头的时间，到期后在候选预算内切换，避免为整个生成设置过短总时限。

### F05 — translated stream 的中断/错误被编码为正常完成

- **触发**：OpenAI SSE 只有部分文本后 EOF；或 Anthropic SSE 发送 `overloaded_error` 后结束。
- **原因**：[stream.rs:220](../../crates/cognia-gateway/src/translate/stream.rs#L220) / 237 在没有终止原因时默认 `Stop`；Anthropic error 事件未得到错误分支处理。server 还会先 finish transcoder，再补 stalled 错误帧。
- **证据（状态机）**：partial OpenAI 输出后生成 `end_turn`、`message_stop`；Anthropic `overloaded_error` 被丢弃，生成 `finish_reason=stop`、`[DONE]`。
- **影响**：客户端看到的成功终帧可能掩盖截断、阻止正确重试并污染后续历史。是否某一真实客户端在收到后续错误时仍能补救，未在本轮逐版本验证。
- **修复方向**：必须观察合法完成标志后才能生成成功终帧；EOF、error 和 idle timeout 走 inbound 协议的失败终止。

### F06 — 并行工具参数片段写入已经关闭的 Anthropic block

- **触发**：OpenAI 一个 turn 中返回两个并行工具调用，参数跨多个 chunk 交错到达。
- **原因**：[stream.rs:621](../../crates/cognia-gateway/src/translate/stream.rs#L621) 遇到第二个工具即关闭前一个 block，但后续片段仍按原 index 写入。
- **证据（状态机）**：有效输入得到 `content_block_stop(index=0)` 后的 `content_block_delta(index=0)`；`parallel_deltas_after_stop=1`。
- **影响**：Claude Code 使用的 Anthropic SSE 生命周期无效，工具参数可能提前结算或导致解析失败。真实 Claude CLI 的具体报错未运行。
- **修复方向**：保留每个并行工具的独立生命周期，或缓冲并串行输出完整 block。

### F07 — Gemini 上游的 streaming Responses 被二次编码

- **触发**：Codex/其他客户端通过 `/v1/responses` streaming 使用 Google/Gemini upstream。
- **原因**：[server.rs:4953](../../crates/cognia-gateway/src/server.rs#L4953) 已使用 `GeminiToResponses` 输出 Responses SSE；外层 [server.rs:3281](../../crates/cognia-gateway/src/server.rs#L3281) 又按 Chat SSE 交给 `ResponsesStream` 编码，丢弃原事件。
- **证据（HTTP + 状态机）**：upstream 正常返回 `gemini answer` 与 STOP；客户端 HTTP 200，但没有该文本，`output=[]`，终帧为 `response.failed`，错误为 `upstream stream ended before completion`。
- **影响**：这一组合下基础文本生成也不能正常返回。
- **修复方向**：明确内部流的协议类型，保证 Responses framing 仅执行一次。

### F08 — `allowAuthFailover=false` 在下一次请求被绕过

- **触发**：`sticky-with-failover` ticket、明确禁止认证失败切换；账号 A 先成功，随后返回 401；下一次请求仍使用同一票据。
- **原因**：[execute.rs:756](../../crates/cognia-gateway/src/execute.rs#L756) 在 key 池过滤后找不到 leased A 时，直接返回其余账号；[server.rs:4394](../../crates/cognia-gateway/src/server.rs#L4394) 的认证失败限制只控制本次 attempt。
- **证据（HTTP）**：三次请求为 **200(A) → 401(A) → 200(B)**，lease 移到 B，票据授权未改变。
- **影响**：跨请求换账号绕过了显式授权限制。
- **修复方向**：区分导致 lease 不可用的原因；认证失败时，禁止在后续请求自动提升其他账号。

## P2：负载分配、兼容性与配置生命周期

### F09 — alias 和 key 池同时轮询，部分 key 永久收不到正常流量

- **位置**：[execute.rs:359](../../crates/cognia-gateway/src/execute.rs#L359)、[execute.rs:411](../../crates/cognia-gateway/src/execute.rs#L411)。
- **触发/原因**：两个 provider 各两个 key，alias round-robin；展开整条 fallback 链时，每个 provider 都推进 key cursor，即使最终没有向该 provider 发请求。
- **证据（HTTP）**：连续 8 次成功：**P-A=4、P-B=0、Q-A=0、Q-B=4**。
- **影响/修复**：两层轮转产生固定相位，账号池容量未被实际使用；应把 key 预留放到 provider 真正成为 attempt 的时刻。

### F10 — 单 key provider 忽略 cooldown 与 permanent disable

- **位置**：[execute.rs:383](../../crates/cognia-gateway/src/execute.rs#L383)。
- **触发/原因**：没有 rotation pool 时直接返回 candidate，不读取服务器已记录的冷却状态。
- **证据（HTTP）**：P→Q priority alias，P 返回 `429 Retry-After:60`，Q 健康、fallback budget=1；连续两次均 502，P 收到 2 次、Q 收到 0 次，cooldown 表已有记录。函数探针还证明 permanent 401 的单 key 仍处于首位。
- **影响/修复**：停用账户反复消耗尝试预算，健康备用被遮蔽；单 key 与池 key 应共用发送前资格检查。

### F11 — task provider 的 cooldown 写入/读取使用不同身份

- **位置**：[server.rs:3486](../../crates/cognia-gateway/src/server.rs#L3486) 与 [execute.rs:389](../../crates/cognia-gateway/src/execute.rs#L389)。
- **触发/原因**：错误按 `sourceProviderId` 写入，池展开按 `provider.id` 查询。本地 manual-key task 在 [mint-session-ticket.ts:576](../../lib/gateway/mint-session-ticket.ts#L576) 更换 id、保留 source 和 key pool，真实可达。
- **证据（函数 + 调用链）**：source 名下所有 key 均被 permanent disable 后，task id 的池仍展开全部 key。本轮没有该 task 路径的完整 HTTP/外部 Agent 复现。
- **影响/修复**：task 的 401/429 状态无法阻止后续选取；应统一 credential/account/transport 的冷却身份。remote task/显式 subscription 清池不能覆盖本地 manual pool 场景。

### F12 — strict tools / Responses schema 没有在候选选择前过滤

- **位置**：[route_planner.rs:130](../../crates/cognia-gateway/src/route_planner.rs#L130)、[server.rs:4110](../../crates/cognia-gateway/src/server.rs#L4110)。
- **触发/原因**：planner 的 structured-output 提取遗漏 `tools[].function.strict` 和 Responses `text.format`。后续模型 metadata 检查发现不支持，直接返回，未尝试兼容 fallback。
- **证据（HTTP + 函数）**：P 明确不支持、Q 明确支持 structured output；strict function tool 请求得到 400，两者 upstream 命中均为 0。Responses schema 的函数探针同样选中 P。
- **影响/修复**：候选集中有兼容容量却无法使用；应统一各入口的能力需求提取，并在分配前过滤。

### F13 — 迟到的 429 覆盖永久 401，复活已停用 key

- **位置**：[cooldown.rs:163](../../crates/cognia-gateway/src/cooldown.rs#L163)。
- **触发/原因**：同 key 多个在途请求先后收到 401、429；`record_cooldown` 无条件覆盖永久状态，也可能缩短较长冷却窗口。
- **证据（确定性状态交错）**：permanent 401 → temporary 429(until=2000) → `usable_pool(now=3000)` 返回该 key。未另运行并发 HTTP 场景。
- **影响/修复**：停用不是单调状态；临时更新应保留 permanent，并对恢复窗口取最大值。

### F14 — 添加跨协议备用线路，反而拒绝可原生处理的请求

- **位置**：[server.rs:3982](../../crates/cognia-gateway/src/server.rs#L3982)；Responses 的全候选 native 判定也有相同结构。
- **触发/原因**：任一候选需要转换，便在尝试首选原生 upstream 前解析整个请求为 IR；IR 不支持的原生字段导致直接 400。
- **证据（HTTP）**：同一个 Anthropic document 请求，native-only 返回 **200**；只增加 OpenAI fallback 后返回 **400**，原生 upstream 命中 **0**，错误为 `unsupported content block type: document`。
- **影响/修复**：备用线路缩小主线路原生能力；转换资格应按候选检查，不能提前否决原生候选。

### F15 — Responses 并行工具历史被拆成错误的 Chat message 顺序

- **位置**：[responses.rs:70](../../crates/cognia-gateway/src/translate/responses.rs#L70)。
- **触发/原因**：每个 `function_call/custom_tool_call` 单独创建 assistant message，没有将同一 turn 的调用合并。
- **证据（实际序列化数据）**：合法 Responses 输入 `c1,c2,output(c1),output(c2)` 变成 `assistant(c1),assistant(c2),tool(c1),tool(c2)`。OpenAI 官方 converter 对同一 turn 的工具调用采用合并方式；本轮未调用真实 Chat provider 验证其 400。
- **影响/修复**：Chat 工具结果不再紧跟声明它们的完整 assistant turn，续轮可能被拒；应在 IR/输出端保留同一 assistant turn 的多个调用。

### F16 — 取消等待泄漏排队计数

- **位置**：[concurrency.rs:125](../../crates/cognia-gateway/src/concurrency.rs#L125)。
- **触发/原因**：等待 future 被撤销/边界取消时，`fetch_add` 已执行，`.await` 后的 `fetch_sub` 永远不会执行。
- **证据（直接编译源码）**：持有唯一 slot，依次 poll 并取消 256 个 waiter；下一 waiter 配置等待 80ms，实际 **0ms** 直接拒绝。空闲 fast path 仍能工作，不是整条 key 永久不可用。
- **影响/修复**：繁忙时不再具有配置声明的排队能力；等待计数需要 RAII decrement，入队上限也应原子预留。

### F17 — 并发上限热更新创建独立容量

- **位置**：[concurrency.rs:147](../../crates/cognia-gateway/src/concurrency.rs#L147)。
- **触发/原因**：cap 变化时替换整个 semaphore，旧 active permits 不计入新 gate。
- **证据（直接编译源码）**：已有 2 个在途请求，cap 从 2 改为 1，仍成功接受新请求，总在途 **3**。
- **影响/修复**：新配置不能约束后续入场；应在同一 gate 上调整容量，或将旧 active 数计入新的 admission。

### F18 — 远端 listener 搭配本地签发的 ticket

- **位置**：[gateway-connect.ts:213](../../cli/src/x/gateway-connect.ts#L213)、[gateway-connect.ts:220](../../cli/src/x/gateway-connect.ts#L220)。
- **触发/原因**：选择远端 URL、允许 remote、未提供其 gateway key，但本地 desktop 能 mint ticket。minter 不绑定所选 listener，连接端忽略 ticket 的 `endpoint`。
- **证据（注入）**：所选 `https://remote-gateway.invalid` 被配上 issuer endpoint 为 `http://127.0.0.1:47823/v1` 的 local ticket。
- **影响/修复**：独立远端 registry 无法认证，也会接收到不属于它的 bearer；必须验证 listener 与 issuer 的关联，不能仅因某个 Host 能签票据就使用。

### F19 — Node proxy 丢弃 API 路径前缀，模型发现又可能重复 `/v1`

- **位置**：[proxy-server.ts:325](../../cli/src/x/proxy-server.ts#L325)、[proxy-server.ts:401](../../cli/src/x/proxy-server.ts#L401)；发现逻辑在 113。
- **触发/原因**：用 `/v1/...` absolute-path reference 构造 URL 覆盖 base path；发现逻辑则直接追加 `/v1/models`。
- **证据（HTTP）**：配置 `/tenant/openai/v1`，推理实际请求 `/v1/responses`。`/v1/v1/models` 的发现问题是源码推导，未单列一次发现请求。
- **影响/修复**：有租户/代理前缀的合法 API 地址不能按配置访问；统一 API base 和相对操作路径。

### F20 — 已保存的企业 alias / 自定义模型被默认模型覆盖

- **位置**：[model-selector.ts:73](../../cli/src/x/model-selector.ts#L73)。
- **触发/原因**：上次成功保存的模型不在 hard-coded catalog，下一次启动未显式传 `--model`。非 TTY 分支只接受 catalog 内 remembered 值。
- **证据（函数）**：`custom-company-model` 被替换为 `claude-sonnet-4-20250514`。
- **影响/修复**：同一已保存配置不能稳定复用 Gateway alias；尊重保存值，并从被选 Gateway 获取模型清单。

## 另外两项源码风险

### H01 — 持久客户端配置没有闭合 helper / 子 Agent 模型授权

[gateway_config.rs:249](../../crates/cognia-agents/src/gateway_config.rs#L249) 设置 Claude 主模型，但 helper=None 时不绑定 Haiku fallback；[client_connections.rs:472](../../crates/cognia-gateway/src/client_connections.rs#L472) 同时创建只允许 main alias 的 Key。保留的 family/subagent/review 旧配置也可能指向授权集合外的模型。`x` launcher 已对 family 设 main fallback，可作为两条接入方式不一致的源码对照。

这是可行动的配置缺口，但**未执行真实 Claude Code 后台模型请求或 Codex review/subagent 流程**。需要以全新与已有配置分别运行真实客户端，确认当前版本实际选择和认证优先级，不能用 `/v1/models` 探测成功代替。

### H02 — 长期运行的 `x` ticket 没有续期

[mint-ticket.ts:44](../../cli/src/x/mint-ticket.ts#L44) 得到 `expiresAtMs`，连接对象丢弃该值，`x` 路径未维护 renewal；Rust 默认 TTL 为 12 小时。长时间保持运行的 CLI 到期后会被拒绝，当前也没有明确到期/恢复交互。

本轮没有等待 12 小时；这是源码确定的生命周期限制。需要短 TTL 的同构端到端验证，并决定是 Host 续租还是显式停止/恢复。

## 没有算作新增缺陷的项目

- 上轮已确认：`x codex` 自动票据没有申请 `responses`，默认票据访问 `/v1/responses` 返回 403；显式 Gateway Key 路径不受这一项影响。
- Ticket 的候选冻结与会话粘性本身是 ADR 的设计选择，不能直接把它不参与普通请求的 weighted/round-robin 作为缺陷；跨会话初始分配能力不足应单独立需求。
- process-local 调度不等于多实例协调，这是部署能力边界；本轮没有据此虚构分布式容量测试结论。
- Node fallback 原文转发已用合成数据验证，但普通 key 的 privacy mode 本来就可关闭，因此没有把“所有 proxy 必须无条件脱敏”当成已确定契约；其与指定 Gateway 不等价的风险纳入 F03。
- namespaced forced `tool_choice` 候选因输入合法性不足撤回；不得将其 probe 错误算为产品 bug。
- 看到 source ID 与 least-busy 的命名差异，但相关 task 走 frozen ticket 路径，尚不足以建立普通动态路由中的完整反例，未列为缺陷。

## 复现材料与验证记录

下面的程序 exit 0 表示成功重现了报告中的错误行为，**不表示产品行为通过验收**。

| 程序                                                                                                                                                                                              | 实际结果                                                  | 覆盖的新增项       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------ |
| [client-review-probe.ts](../../.cache/diagnostics/2026-11-14-gateway-review/client-review-probe.ts) / [日志](../../.cache/diagnostics/2026-11-14-gateway-review/client-review-probe.log)          | Bun exit 0；合成环境/配置、注入依赖与本地 Node upstream   | F01–F03、F18–F20   |
| [header-wait-probe.rs](../../.cache/diagnostics/2026-11-14-gateway-review/header-wait-probe.rs) / [日志](../../.cache/diagnostics/2026-11-14-gateway-review/header-wait-probe.log)                | Rust exit 0；真实 Gateway socket；三组 HTTP 对照          | F04、F07、F14      |
| [protocol-adapter-probe.rs](../../.cache/diagnostics/2026-11-14-gateway-review/protocol-adapter-probe.rs) / [日志](../../.cache/diagnostics/2026-11-14-gateway-review/protocol-adapter-probe.log) | Rust exit 0；直接编译当前 translator 模块，检查实际输出   | F05、F06、F07、F15 |
| [routing_http_probe.rs](../../.cache/diagnostics/2026-11-14-gateway-review/routing_http_probe.rs) / [日志](../../.cache/diagnostics/2026-11-14-gateway-review/routing_http_probe.log)             | Rust exit 0；真实 Gateway 与本地 upstream；4 组 HTTP 场景 | F08–F10、F12       |
| [routing_probe.rs](../../.cache/diagnostics/2026-11-14-gateway-review/routing_probe.rs) / [日志](../../.cache/diagnostics/2026-11-14-gateway-review/routing_probe.log)                            | Rust exit 0；公共函数与共享状态交错                       | F08、F10–F13       |
| [concurrency-probe.rs](../../.cache/diagnostics/2026-11-14-gateway-review/concurrency-probe.rs) / [日志](../../.cache/diagnostics/2026-11-14-gateway-review/concurrency-probe.log)                | Rust exit 0；直接编译当前 concurrency 模块                | F16、F17           |

Rust HTTP 程序链接本工作区已有的 `cognia-gateway` 构建产物；translator 与 concurrency 探针通过绝对路径直接编译当前模块。命名空间、CLI 注入和 source-chain 结果均按以上证据等级报告，未冒充真实供应商验收。`.cache` 内容是本机验证产物，不保证随 Git 发布。

上轮正常路径测试通过和已安装 Codex 的本地工具往返，并不能排除这些反例。本轮没有运行 coverage、全仓 build/typecheck，也没有为了审查改动任何生产实现。

## 修复排序建议

1. 先闭合 F01–F03、F08 的凭据/选址/授权边界，并修复 F04 的响应头挂死。
2. 处理 F05–F07、F14–F15 的协议状态机；覆盖真实多工具、错误帧与 native + fallback 组合。
3. 处理 F09–F13、F16–F17 的调度/冷却/并发状态，使用组合场景而非分别只测单层算法。
4. 完成 F18–F20 与 H01–H02 的客户端配置、模型保存和票据生命周期，再做真实 Claude/Codex 双客户端验收。

## Sources

- Anthropic [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)：content block 事件生命周期，以及流内 `overloaded_error` 的合法性，用于 F05–F06。
- OpenAI [官方 Chat converter](https://github.com/openai/openai-agents-python/blob/main/src/agents/models/chatcmpl_converter.py)：同一 assistant turn 的工具调用合并处理，用于 F15 的协议对照。
- Claude Code [Model configuration](https://code.claude.com/docs/en/model-config#environment-variables)：family/helper 模型选择的进一步验收依据；H01 的当前行为仍以本仓源码判断为限。
- 其余判断以链接的当前 owning source 和本地合成探针为证据，未使用第三方网关宣传作为支持程度依据。
