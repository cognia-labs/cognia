# Cognia gateway 差距补齐与修复结果

日期：2026-10-29，Asia/Shanghai。范围来自用户确认的“修复代码问题，并补齐全部能力差距”。对应原始比较为 Magpie `v0.1.1902`，不将该历史比较当作当前所有版本的持续兼容承诺。

本次已实现下表各能力族，补上入口、运行时接线、权限和用量处理。最后核验发现的成员后台日志权限问题仍在进行定向修复。本报告区分本地行为验证、浏览器 fixture、原生编译与真实供应商验收；不能据此宣称任意模型、客户端和供应商全面互通。

## 实现范围

| 验收项         | 已实现行为                                                                                                                                                                            | 主要代码                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 安全修复   | Embeddings 在发送前检查敏感文本；使用冻结模型、deployment 和 exposure；保留 transport 认证头；完整凭据身份与首次严格亲和原子认领；用量按实际结算。密钥创建持久化失败不发布 live key。 | [server.rs](../../crates/cognia-gateway/src/server.rs)、[execute.rs](../../crates/cognia-gateway/src/execute.rs)、[api_keys.rs](../../crates/cognia-gateway/src/api_keys.rs)                                                           |
| A02 Gemini     | `/v1beta`、`/v1alpha` 的模型目录、生成、流式生成、countTokens；与 Chat、Responses、Anthropic 双向转换；保留支持范围内的工具、思考和用量，正确处理 Google 嵌套输出上限。               | [gemini.rs](../../crates/cognia-gateway/src/server/gemini.rs)、[协议转换](../../crates/cognia-gateway/src/translate/gemini.rs)                                                                                                         |
| A03 Ollama     | `/api/version`、`tags`、`show`、`chat`、`generate`，包括 NDJSON、图片、工具、thinking 和错误格式。                                                                                    | [ollama.rs](../../crates/cognia-gateway/src/server/ollama.rs)                                                                                                                                                                          |
| A04 媒体与检索 | 图片生成/编辑、语音转写/翻译、TTS、rerank、视频创建/查询/下载；支持 multipart 和二进制；视频后续请求绑定原调用身份、账号与上游。                                                      | [media.rs](../../crates/cognia-gateway/src/server/media.rs)                                                                                                                                                                            |
| A05 文本隐私   | 可选文本掩码、回复还原；复用 `@cognia/redact`；流式保留原始帧、序号与工具身份，支持跨块占位符；插件新增或修改文本再次检查。                                                           | [privacy.rs](../../crates/cognia-gateway/src/server/privacy.rs)、[runtime-bridge.ts](../../lib/gateway/runtime-bridge.ts)                                                                                                              |
| A06 中间件     | 五类已有插件体系扩展点：请求、上游发送、流式事件、完整回复、用量；权限、超时和模型/用量等关键字段限制；桌面与 headless brain 使用内部桥接。                                           | [runtime-bridge.ts](../../lib/gateway/runtime-bridge.ts)、[privacy.rs](../../crates/cognia-gateway/src/server/privacy.rs)                                                                                                              |
| A07 搜索与视觉 | 配置别名后识别供应商网页搜索工具，为明确不支持图片的模型补偿内联图片；使用一次性原生子票据、冻结权限、父任务预算和同一并发限制。                                                      | [bridges.rs](../../crates/cognia-gateway/src/server/bridges.rs)                                                                                                                                                                        |
| A08 订阅调度   | 明确 opt-in 的订阅账号池；缓存额度窗口、重置时间、使用节奏与最近使用排序；未知额度保持未知；会话亲和；指定账号不会借用兄弟账号。                                                      | [snapshot-publisher.ts](../../lib/gateway/snapshot-publisher.ts)、[snapshot.rs](../../crates/cognia-gateway/src/snapshot.rs)、[execute.rs](../../crates/cognia-gateway/src/execute.rs)                                                 |
| A09 角色模型   | 管理任务内跨 provider/account 的角色绑定；每个 selector 的 deployment 授权；OpenCode/Pi 配置投影；续租保留已用额度和在途预留，不改用普通 key 绕过任务边界。                           | [model-plan.ts](../../lib/ai/agent/external/config/model-plan.ts)、[mint-session-ticket.ts](../../lib/gateway/mint-session-ticket.ts)、[task_lease.rs](../../crates/cognia-gateway/src/task_lease.rs)                                  |
| A10 客户端接入 | Claude Code、Codex、Gemini CLI、OpenCode 的检测、预览、接入、状态、恢复；私有备份和恢复日志；并发修改保护；失败撤销 live key；启动时未完成撤销恢复失败则拒绝启动监听。                | [gateway_config.rs](../../crates/cognia-agents/src/gateway_config.rs)、[client_connections.rs](../../crates/cognia-gateway/src/client_connections.rs)、[接入界面](../../components/settings/gateway/gateway-client-connections.tsx)    |
| A11 可观测性   | Gateway Logs 按 session 筛选、分组、导出，链接已有用量账本；真实 alias 和订阅池统计；隐私、扩展、补偿与客户端配置的中英界面。                                                         | [日志界面](../../components/settings/gateway/gateway-log-viewer.tsx)、[设置界面](../../components/settings/gateway/panels/overview-panel.tsx)                                                                                          |
| A12 Headless   | 共享日志/用量消费端，避免多次挂载重复写入；通过认证事件连接订阅并验证 ACK；保留账号/代际和成员隔离；双语运行文档。成员后台真实权限路径的最终修复见下文。                              | [telemetry-subscription.ts](../../lib/gateway/telemetry-subscription.ts)、[gateway-telemetry.ts](../../lib/headless/runtimes/gateway-telemetry.ts)、[运行文档](../content/docs/zh/subsystems/companion-api/headless-service-plane.mdx) |

## 对抗性复核带来的实际修复

独立 PII、运行时接线、静态导出、Tauri/Rust、测试缺口和 i18n 审查均已执行。具体发现经过代码核验后修复，未通过降低断言或关闭检查消除问题：

- 掩码后的 provider 插件仍可重新加入 PII：补上最终发送前检查，真实红绿验证由返回 200 变为 400，且上游收到零次请求。
- 补偿输出被判定无效时漏结算已产生的用量：先结算已知用量，再检查输出；已派发但用量未知时保守保留有界额度，明确尚未派发的请求释放预留。
- 流式占位符还原可能破坏终帧、混合换行或交错工具块：改为保留原始帧，按逻辑流身份恢复，不构造新的终帧或重复 usage。
- 外层桥接长超时被内层 10 秒限制截断：仅搜索/视觉内部命令改为 130 秒，其他 Run API 维持原有限制；真实 socket 验证了超过 10 秒的调用。
- 桌面 WebView 直接访问原生 lease 会被 CSP/Origin 限制拒绝：改用已有原生代理，实际 SDK 与 IPC 路径测试通过。
- 配置发布在验证内容后重新读取时间戳，可能覆盖并发编辑：发布、恢复和删除沿用同一份已验证的元数据与内容快照，并再次核对。
- 配置清理持久化失败时旧 key 仍可用：先撤销 live 权限，保留恢复记录；重启恢复失败时不开放网关。文件与密钥协调移至异步执行器之外。
- 两个角色复用同一补偿 alias 会编译冲突、Rust 的空 selector 会序列化为 TS 不接受的 null：分别补上去重和兼容解析测试。
- 最终源码追踪发现 person-brain 被当作普通 Device，而日志通道只允许 Service；同时它不能调用 operator 的 `gateway_status`。本项正在补充真实认证 WebSocket 与成员权限回归，不将 mock 成功 ACK 当作运行证据。

## 验证结果

下列计数存在包含关系，不相加成一个总数。

| 检查                                    | 实际结果                                                   | 证据                                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway Rust 全套                       | **506 passed, 0 failed**                                   | [gateway-final.log](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/gateway-final.log)                                                                         |
| 网关相关 Jest                           | **44 suites，1382 tests，1 snapshot 通过**                 | [gateway-suites-final.log](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/gateway-suites-final.log)                                                           |
| 内部桥接原生测试                        | **14/14 通过**                                             | [companion-final.log](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/companion-final.log)                                                                     |
| 四客户端配置 IO / 原生协调器 / 私有写入 | **8/8、4/4、2/2 通过**                                     | 临时 home 与真实本地网关；测试与源文件同置                                                                                                                            |
| 网关内部命令分发                        | **11 通过**；筛选之外的 30 项未运行                        | [gateway-dispatch-final.log](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/gateway-dispatch-final.log)                                                       |
| 项目 ESLint                             | 通过，零 warning                                           | [lint-final.log](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/lint-final.log)                                                                               |
| i18n                                    | build、build:check、lint、sort:check 通过；新 key 双语齐备 | [生成检查](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/i18n-final.log)                                                                                     |
| 原生命令编译                            | `cargo check -p cognia-gateway --features tauri-host` 通过 | [编译记录](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/tauri-command-check-final.log)                                                                      |
| Docs 类型检查                           | 通过                                                       | [docs-typecheck-final.log](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/docs-typecheck-final.log)                                                           |
| 浏览器客户端接入/恢复                   | 交互通过；明确标记为 IPC fixture                           | [截图](../../.cache/gateway-evidence/2026-10-29/client-connections-desktop.png)、[调用记录](../../.cache/gateway-evidence/2026-10-29/client-connections-browser.json) |

未通过的检查也保留原结果：

| 检查                      | 当前失败及归属                                                                                                                                            | 后续动作                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 全仓 `pnpm typecheck`     | 12 项范围外诊断：`connector-matrix-native.test.ts` 的 unknown 类型，及 managed-desktop 测试 fixture 缺少字段。此前插件 `isTauri` 错误已被所属并行改动修复 | 等所属改动修复后重跑全仓检查；不能将此前通过当作最终通过。[日志](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/typecheck-final.log) |
| `pnpm lint:static-export` | 14 个 `agent-codebuff` / `agent-crush` Node-only import，均在本次网关范围外                                                                               | 修复对应浏览器打包边界后再构建。[日志](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/static-export-final.log)                       |
| 严格 Clippy               | 4 项既有诊断：`concurrency.rs` unit error、`runs.rs` large error、`types.rs` question-mark、`translate/ir.rs` 测试模块位置；相关诊断代码未由本次引入      | 在所属清理中解决；没有添加 suppression。[日志](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/clippy-final.log)                      |
| 扩展 Jest 检查            | 45 suites 中 44 通过；1422 项中 1 项 `workflow_cancel_run` 断言失败，属于并行 workflow 路径                                                               | 保留失败断言；网关分发筛选检查另有 11 项通过。[日志](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/jest-final.log)                  |

## 使用条件与验收边界

1. **协议和媒体能力仍取决于上游。** 媒体入口将请求路由到支持该 API 的上游；它不会让普通文本模型获得图片、视频或语音生成能力。原生 Google 的签名思考状态仅在同协议透传时完整保留。
2. **隐私覆盖可检查文本。** 图片、音频和视频二进制没有被声称为已脱敏。脱敏、中间件和补偿需要可用的桌面或 headless brain；必需环节不可用时明确失败。
3. **补偿有明确范围。** 处理声明的网页搜索工具；客户端函数工具仍交由客户端执行。搜索最多 6 轮、12 次内部调用，最终结果缓冲后返回；视觉补偿仅处理内联图片，最多 8 张，不抓取远程 URL。每次内部提示词最多 64 KiB，输出最多 2048 token，总上限 32768 token，父任务与模型限制可进一步收紧。
4. **视频 ID 是临时能力。** 仅原调用身份可查询/下载，24 小时失效，不跨重启保存；账号变化清空历史映射。
5. **订阅池按明确同意启用。** 使用已缓存的账号额度，不额外联网轮询，不修改用户全局选中的订阅账号。Headless 保留独立 Profile Store 与 secret-store/env 凭据边界，不自动读取桌面 vault。
6. **客户端状态证明配置和连通。** 接入探测调用 `/v1/models`；它不等于已验收真实客户端的生成、工具和认证全过程。文件并发检查是乐观检测，不承诺对不合作外部写入者提供操作系统级事务锁。

本轮没有发起付费供应商调用，也没有修改用户真实 Claude/Codex/Gemini/OpenCode 配置。已启动的 browser fixture 服务已停止。

前期的旧 Tauri 应用与 3000 端口占用均已自行退出；本任务没有停止它们。环境空闲后已启动当前源码的受管桌面会话，正在编译，结果将单独记录。主应用/完整 Docs 生产构建、当前源码 Tauri UI、已安装 CLI 和真实上游验收仍未完成；证据台账保留 `verifying`，没有宣称生产验收完成。

变更保留在当前工作区，未提交、未推送。共享工作区的其他改动未纳入本次交付。

## 相关记录

- [验收与证据台账](../evidence/2026-10-28-gateway-gap-repair.md)
- [修复前历史比较](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/audit.md)
- [比较报告的对抗性审查](../../.cache/diagnostics/2026-10-28-gateway-magpie-gap/adversarial-review.md)
