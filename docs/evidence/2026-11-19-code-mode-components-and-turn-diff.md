# Code Mode 组件优化与 TurnDiff 接入评估

- Status: verifying
- Lane: standard
- Created: 2026-11-19
- Updated: 2026-11-19
- Related: [Code Mode 现状评估](../research/2026-11-19-cognia-code-mode-readiness.md) · [ADR-0117](../content/docs/en/adr/0117-composed-agent-modes-and-creator.md) · [ADR-0255](../content/docs/en/adr/0255-runs-that-share-a-directory-keep-their-diffs-and-lose-undo.md)

## Original request

> 继续研究相关的组件，看看有没有什么可以优化的
>
> 还有一个问题，就是codemode能准确识别文件修改之类的吗，实现turndiff的效果

## Problem frame

**桌面只读试点优先解决模式生效、空工具表、两种引擎的结果契约和 Stop。** `Both` 的 SDK 声明会增加上下文，值得先根据实际工具集合算账。进程采样异步化改善事件循环响应，当前探针未证明它能解决脚本超时。**TurnDiff 可以沿用 TaskWorkspace 的基线与结算快照。** 对未来的程序化写入，具体文件归属和能否撤销取决于可信 Host 收据和停止证明。当前 Code Mode 仍为只读，本轮做源码核查和夹具验证。

## Knowledge

| ID  | Statement                                                                                                                                                                                                                                                     | State       | Basis                                                                                                                                                                                                                                                                                                                                                         | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | 工具呈现菜单仍枚举 `Code` / `Both`。Host 能力只影响解析摘要，当前 hook 取初始探测一次。`AxisSelect` 已支持禁用项和原因。                                                                                                                                      | Verified    | 2026-11-19 源码。[模式 hook](../../hooks/agent/use-code-sandbox-presentations.ts#L19) · [选项](../../components/agent/composition/composition-picker.tsx#L270) · [共用禁用逻辑](../../components/agent/composition/composition-picker.tsx#L381)                                                                                                               | -          |
| O2  | `run_code` 与子工具各受工具清单约束。AI SDK 中仅允许 `file_info` 时 `Code` 的内建表为空；仅允许 `run_code` 时仍注册入口，但没有可调用 SDK。在工具搜索开启的夹具里，`Code` 首步仅有 `ToolSearch`。                                                             | Verified    | 真实工具表组装和 ToolSearch 控制器探针，未向 provider 发送。                                                                                                                                                                                                                                                                                                  | -          |
| O3  | 32 个可编程只读工具时，完整 SDK 声明约 3,148 `o200k_base` tokens，`Both` 会把它附加到直接工具定义。Claude SDK 常规配置没有 Cognia coreFiles 的四个 SDK 函数，等价夹具注册 28 个。                                                                             | Verified    | 真实 registry、Zod→JSON Schema、声明生成器及本地 tokenizer，见下方测量。                                                                                                                                                                                                                                                                                      | -          |
| O4  | 同一 `file_hash` 缺失文件错误，在 AI SDK 的嵌套 JS 中 reject，在 Claude SDK 包装中 resolve 成 `isError: true`。外层脚本 `SyntaxError` 被标为 `resource-exhausted`。                                                                                           | Verified    | 实际两种 sidecar 适配器、JS 子进程和不存在的临时夹具文件。[AI SDK 错误映射](../../sidecar/src/tools/adapters/ai-sdk.ts#L222) · [Claude SDK 嵌套包装](../../sidecar/src/tools/adapters/sdk-mcp.ts#L49) · [外层失败](../../sidecar/src/tools/builtin/run-code/index.ts#L66)                                                                                     | -          |
| O5  | 每 25 ms 同步进程组 RSS 采样造成可测的事件循环阻塞。异步同频原型降低最大观测延迟，两组超时数相同。异步改为 125 ms 的小样本也没有提高成功数。                                                                                                                  | Verified    | macOS、Node v26.12.1、受控本机探针，详见下方。                                                                                                                                                                                                                                                                                                                | -          |
| O6  | Chat 的 Local 观察模式以 `workingState` 起步，TaskWorkspace 结束后做实际字节结算，`TurnChangesCard` 按消息关联的 run 查看 `PatchSet`、文件和 Undo。                                                                                                           | Verified    | 当前源码。[聊天入口](../../hooks/chat/agent-chat-send.ts#L3312) · [基线](../../lib/task-workspace/client.ts#L215) · [结算](../../crates/cognia-task-workspace/src/service.rs#L4772) · [消息投影](../../lib/code-adoption/turn-tracker.ts#L325) · [TurnChangesCard](../../components/chat/turn-changes-card.tsx#L130)                                          | -          |
| O7  | 现有 `ToolMutationReceipt` 存储可用，但当前 TS 的资源事件只带路径、操作与工具 ID。Patch 应用的 provenance 查询要求唯一工具的收据匹配整个文件的前后 hash。Local 观察流程未用这个工具级匹配来生成来源。同一文件连续多次写的收据链与重叠时逐文件 Undo 仍需接通。 | Verified    | 当前源码。[路径线索](../../lib/task-workspace/tool-evidence.ts#L33) · [可信收据](../../crates/cognia-task-workspace/src/service.rs#L5208) · [精确匹配](../../crates/cognia-task-workspace/src/provenance.rs#L476) · [Patch 使用方](../../crates/cognia-task-workspace/src/ledger.rs#L450) · [观察结算](../../crates/cognia-task-workspace/src/ledger.rs#L709) | O6         |
| O8  | 发送侧 `toolDigest` 用 allowed names 和空 schema 建立，sidecar AI SDK 把 composition digest 作为 `promptFingerprint`。它无法标识 `run_code` 实际签名、激活工具集及运行时规则变化。                                                                            | Verified    | 当前源码。[发送摘要输入](../../lib/agent/composition/resolve-turn-composition-safely.ts#L45) · [摘要构造](../../lib/agent/composition/resolve-turn-composition.ts#L93) · [实际消费者](../../sidecar/src/runtimes/ai-sdk/index.ts#L1372)                                                                                                                       | -          |
| H1  | 单独把同步采样改成异步，能消除本机短脚本的批量超时。                                                                                                                                                                                                          | Invalidated | 两组各 8 次，均为 1 成功、7 超时，异步组仅改善事件循环延迟。结论限于该夹具。                                                                                                                                                                                                                                                                                  | O5         |
| Q1  | 批量延迟的剩余成因、真实隔离下的采样机制及轻量宿主方案。                                                                                                                                                                                                      | Open        | 单独交替测 `READY` 时，又观察到两个路径均正常。需要同批次分段观测启动、IPC 和回收。                                                                                                                                                                                                                                                                           | O5         |
| G1  | 在桌面已有文件工作区的 Chat turn 内，得到实际可执行的只读 `Both`，后续在带写权限的工作区为受控写工具提供可靠 TurnDiff 与可解释的归属。                                                                                                                        | Proposed    | 用户请求与现状评估。                                                                                                                                                                                                                                                                                                                                          | O2,O6,O7   |

## 哪些组件值得优先优化

1. **会话能力与工具表一起确认。** 交给实际执行 Host 报告 `probing`、可用或原因。绑定 Host、sidecar 代际和本轮有效工具权限，切换 Host 或重启时更新。会话保留用户选择，发送前解析本轮实际生效值。沿用 `AxisSelect.unavailableHint`，让空 SDK、运行时不支持和未完成探测的原因可见。`run_code` 仅在 wrapper 本身可用且允许至少一个内嵌工具时上架。`Code` 或显式选择的 `Both` 应将入口纳入现有 ToolSearch 常驻优先级，同时遵守 provider tool cap；如果第一步只有发现工具，就把该状态纳入验收。 [Host 缓存](../../lib/ai/code-mode/sandbox-status.ts#L51) · [工具搜索优先级](../../sidecar/src/tools/adapters/ai-sdk-tool-search.ts#L162)
2. **统一嵌套结果及错误。** 在 broker 保留 tool schema、授权和 redaction；为脚本定义稳定的 JSON 可消费结果和错误类型，明确 `tool-failed`、拒绝、脚本语法失败、预算、停止。复用 `cognia/failure` 元数据。先补 `file_hash` 缺失文件跨引擎同结果、普通错误和预算结果不同的测试。声明注释应保留必需的参数语义与可用范围。运行时在生成实际工具表后记录展示给模型的有序目录版本、签名和可见性摘要，保持历史 replay 值的含义。 [工具错误协议](../../sidecar/src/tools/kernel/result.ts#L10) · [声明生成器](../../sidecar/src/tools/builtin/run-code/sdk-declaration.ts#L117)
3. **复用 Stop 现成的进程跟踪和 trace。** `trackChildProcessGroup` 与 `ToolSession.disposeProcesses` 已有收尾及 proof，可接入 `run_code` 进程而无需复制另一套信号逻辑。让脚本退出、超时和取消统一关闭新调用入场，结清或标记仍在途的 Host 请求。现有 canonical `tool_progress`、trace span 已识别父调用 ID。脚本只需向这些通道增加父子关联和带限额的状态事件，聊天复用 `StructuredToolPart` 展开逐个调用。只记录耗时、目标工具、权限及结果摘要。 [进程跟踪](../../sidecar/src/tools/state/process-group.ts#L57) · [Session teardown](../../sidecar/src/tools/session.ts#L113) · [父子事件](../../sidecar/src/host/events/canonical/index.ts#L70) · [Trace span](../../packages/agent-trace/src/chat-tool-spans.ts#L82) · [聊天工具卡](../../components/chat/message-parts/structured-tool-part.tsx#L306)
4. **工具目录先压缩说明，再按需加载详情。** `Both` 先保留关键工具及常用签名，复用受同一权限过滤的 ToolSearch/目录查询加载详情。后续用任务正确率衡量 schema 压缩代价。签名、默认值、路径和返回结构以 owning definition 为准。上下文成本优化需与 executor 延迟分别测。 [工具参数 schema](../../sidecar/src/tools/kernel/args.ts#L29)

## TurnDiff 怎么接

| 目标                               | 可复用的组件                                                                                                                                                                                            | 边界                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 展示「这轮工作区最终变了什么」     | 开始记录 TaskWorkspace baseline，观察中使用 watcher 提示，确认结算后从实际字节生成 `PatchSet` 并投影到 `TurnChangesCard`。本轮已有未提交改动时取工作树作为起点。                                        | 仅覆盖 capture policy 允许的目录与文件，结算展示净变化。脚本算出补丁、随后还原内容或返回一段字符串不会产生净文件变化。              |
| 证明「这次 Code 调用改了这个文件」 | 写能力仍由受控 `edit` / `apply_patch` 等 Host 实现。写入边界绑定 turn、run、父 `run_code`、子调用 ID 和有序 mutation。Host 从真实文件取 before/after hash，并记录 create、delete 或 rename 的路径关系。 | 仅来源为脚本返回、工具输入或 watcher 文件名时只作线索。当前 Code SDK 只有读取/查询，`Both` 的直接写入可由现有 turn capture 捕获。   |
| 使用 Undo                          | 保留现有 PatchSet 冲突校验。未来可按同一路径的连续收据解释 `A→B→C`，再研究 per-file Undo。                                                                                                              | 当前 overlap 和 stop unproven 仍会让 patch 不可逆。多 Agent 共写、手改、Shell 及外部 MCP 写入缺信任链时保留可读 diff 与不确定来源。 |
| 参考 Codex 实时反馈                | Codex 适配器把 `turn/diff/updated` 的 unified diff 保存到 session metadata，并把完成的 `fileChange` 作为 Host 的路径线索。                                                                              | Cognia 通用历史使用 TaskWorkspace 按 run 的记录。上游事件可作为运行中预览来源，不能替代本机可信写收据或 Undo 判定。                 |

写入回执要发自工具已完成的写入边界。对同一文件并发写，受控写工具需要版本或顺序检查；一轮内发生部分写入或取消，应保存实际已发生的变更并保留未知状态。正式结算以在途写入关闭和 Host 实际快照为准。测试优先覆盖原本 dirty、新建或删除、移动、同文件两次顺序写、同文件共写、拒绝和写后取消。 [Codex diff intake](../../packages/agent-codex/src/app-server-client.ts#L2665) · [Codex completed file-change](../../packages/agent-codex/src/app-server-client.ts#L3015) · [重叠与停止判定](../../crates/cognia-task-workspace/src/service.rs#L4853) · [ADR-0255 收据规划](../content/docs/en/adr/0255-runs-that-share-a-directory-keep-their-diffs-and-lose-undo.md#L62)

聊天长历史的额外优化是先渲染已有 `CodeAdoptionTurnRow` 摘要，再按展开或刚需获取原 Host patch。当前每张有历史 run 的卡片挂载会逐个请求 `getTaskPatchSet`。若真实长会话证明存在 IPC 压力，可以复用按 origin 与 runId 去重的读取，继续以新鲜的 Host 状态判断 Undo。 [当前读取逻辑](../../components/chat/turn-changes-card.tsx#L130)

## 本机探针结果

目录估算取实际注册的只读内建定义，将原始形态序列化为 `{name,description,parameters}`，用 `js-tiktoken` 的 `o200k_base` 测文本。小表启用 `coreFiles` 和 `fileExtras`，大表另外启用 Git、LSP、CodeGraph、AST。结果不包含 provider 封装、Tool Search 步骤或缓存计费。

| 模式夹具        | 工具数 | 直接工具定义估算 | 现有 Code SDK 估算 | SDK 只保留签名的下界 |
| --------------- | ------ | ---------------- | ------------------ | -------------------- |
| AI SDK 小表     | 10     | 1,811            | 1,406              | 481                  |
| AI SDK 大表     | 32     | 4,377            | 3,148              | 1,167                |
| Claude SDK 对照 | 28     | 3,462            | 2,451              | 1,000                |

大表 `Both` 的两部分合计约 7,525 tokens。只缩短工具级说明至首句后，SDK 约 2,847 tokens。只保留签名的列是成本下界，尚未验证模型能否正确使用。

进程探针使用 `return 42`、1.5 秒测试墙钟预算和现有测试夹具的启动方式，生产文件未改动。两个实现交替跑，各 8 次。25 ms 同步版与异步版都只成功 1 次，最大观测事件循环延迟分别为 78 ms 和 17 ms。第二批比较 25 ms 与 125 ms 的非重叠异步采样，分别成功 8/8 和 7/8。异步原型在单独的低内存阈值测试仍返回 `memory`。另一次同环境交替测只握手与现有 supervisor，各 5 次均成功，`READY` 约 74–254 ms 与 147–227 ms。由此保留降低阻塞的方向，同时将故障归因留给进一步同批次分段测量。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                         |
| ------------ | ------ | ------------------------------------------------------------------- |
| scale        | medium | 只读试点涉及 picker、send 与 sidecar。写入归属扩到 Rust workspace。 |
| technical    | high   | 真实 OS 环境的进程生命周期、多次文件变更的证据链。                  |
| coupling     | high   | 工具发现、Trace、replay 与 TaskWorkspace 共享运行身份。             |
| requirement  | low    | 当前请求为可行性和优化评估。                                        |
| verification | high   | 功能夹具可独立验证，打包 Host、真实隔离和模型成功率需专题验收。     |
| risk         | high   | 写入归属错误可能导致 Undo 改到另一来源的字节。                      |

## Risks

| ID  | Risk (impact)                                              | Severity | Source           | Claim                                                    | Refuted by                                       |
| --- | ---------------------------------------------------------- | -------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------ |
| R1  | 看得到 Code 却无法发出有效脚本，或两种引擎走不同错误分支。 | high     | O1、O2、O4       | 实际 send、模型工具表及 JS 结果同一契约。                | 首步无可用入口、缺失文件分支不一致。             |
| R2  | 会话性能被进程采样或声明放大拖慢。                         | medium   | O3、O5           | 精简目录保持任务正确率，进程隔离不拖住其他会话。         | 正确率下降或延迟、超时改善只出现在单一测试条件。 |
| R3  | TurnDiff 将其他 Agent/人类写入归错，导致错误撤销。         | high     | ADR-0255、O6、O7 | 归属使用可验证的 Host 事实。来源或终止不确定时保留只读。 | 仅有 watcher 事件便归属到脚本或授予 Undo。       |

## Verification obligations

| ID  | Risk  | Method                                                                                     | Independence | Evidence                                                                                                                                                                                                                                                                                                         | Coverage                                                                                       | Status  |
| --- | ----- | ------------------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| V1  | R1    | 接入前的工具表和错误分支定点探针。                                                         | tool         | `buildAiSdkTools`、`createAiSdkToolSearchController`、`buildCogniaToolsServer`，O2、O4 输出及断言。                                                                                                                                                                                                              | 本机 fixture，不调用模型。                                                                     | passed  |
| V2  | R2    | 相同目录字节/估算 token，交替运行相同脚本比较采样。                                        | tool         | SDK 1,406–3,148 估算 tokens、25 ms A/B 同为 1/8 完成、async 最大观测延迟 17 ms。                                                                                                                                                                                                                                 | 受控 macOS/Node v26.12.1 样本。                                                                | passed  |
| V3  | R1,R2 | 打包桌面真实 launcher 端到端使用 `Both`，分段测延迟及 Stop，真实 provider 跑固定任务基准。 | real-env     | -                                                                                                                                                                                                                                                                                                                | 正常发送路径、宿主退出、目录发现效果。                                                         | planned |
| V4  | R3    | 复核 TaskWorkspace、可信收据 API 与 Chat 卡片调用链。                                      | self         | O6–O7 的 owning source。                                                                                                                                                                                                                                                                                         | 当前源码，未验证未来 Code 写入。                                                               | passed  |
| V5  | R3    | 受控写入端到端回归 baseline、可信归属、连续/共写、停止未知、跨 Host 及撤销。               | real-env     | -                                                                                                                                                                                                                                                                                                                | 新写入接线及真实文件系统，单独决定发版。                                                       | planned |
| V6  | R3    | 当前卡片、查询 hook、结算投影及工具路径线索的 Jest 回归。                                  | tool         | `pnpm test --runInBand --runTestsByPath components/chat/turn-changes-card.test.tsx hooks/chat/use-turn-changes.test.ts lib/code-adoption/turn-tracker.test.ts lib/task-workspace/tool-evidence.test.ts`，65 项通过。                                                                                             | 覆盖不可逆 patch 时隐藏 Undo、按原 Host 打开历史等。查询 hook 的 suite 存在 React `act` 警告。 | passed  |
| V7  | R1    | 运行 picker、父子 trace、digest 和 ToolSearch 的现有回归。                                 | tool         | `pnpm test --runInBand --runTestsByPath components/agent/composition/composition-picker.test.tsx packages/agent-trace/src/chat-tool-spans.test.ts lib/agent/composition/digest.test.ts`，66 项通过。`node scripts/test/run-sidecar-tests.mjs sidecar/src/tools/adapters/ai-sdk-tool-search.test.ts`，18 项通过。 | 验证可复用的现有组件行为。                                                                     | passed  |

## Decisions

| ID  | Date       | Decision                                                                                               | Action     | Based on | Reversal trigger                                         |
| --- | ---------- | ------------------------------------------------------------------------------------------------------ | ---------- | -------- | -------------------------------------------------------- |
| D1  | 2026-11-19 | 现有 picker、registry 和执行器为只读 `Both` 的实现起点。先使工具能正常注册，再统一结果和 Stop。        | spike      | O1,O2,O4 | 打包版无法建立同样的 OS launcher 与 Hook 生命周期。      |
| D2  | 2026-11-19 | 保留进程隔离，测低开销监督和最短有用目录；去掉「异步采样足以解决超时」这一假设。                       | diagnose   | O3,O5    | 同环境验证给出可重复的启动、IPC、采样和回收归因。        |
| D3  | 2026-11-19 | TurnDiff 复用 TaskWorkspace 与 `TurnChangesCard`，把归属的写收据接入 Host；先支持显示再验收安全 Undo。 | scope-down | O6,O7    | 目标 Host 的 workspace baseline 或变更证据无法可靠交付。 |

## Residual risks

| ID  | Residual                                     | From  | Why still open                                             | Next action                                          | Status |
| --- | -------------------------------------------- | ----- | ---------------------------------------------------------- | ---------------------------------------------------- | ------ |
| X1  | 真实 Host 路径、短脚本延迟和模型效果未确认。 | V3,Q1 | 当前结果为离线、小样本，各批次表现不同。                   | macOS 打包环境按启动、首个 IPC、结算、回收分段记录。 | open   |
| X2  | 写入接线及准确可逆的边界未验证。             | V5    | Code 当前只读，收据存储不等于写工具已接入或可逐文件 Undo。 | 仅在持有正向过程与文件证据的受控工作区验收。         | open   |

## Outcome

| ID  | Signal                                             | How / when measured                             | Result                         | Status  |
| --- | -------------------------------------------------- | ----------------------------------------------- | ------------------------------ | ------- |
| M1  | 确定哪些组件有可测的改进方向及 TurnDiff 复用方案。 | registry、两路错误、进程与 workspace 源码复核。 | 已确定优先优化顺序与覆盖边界。 | met     |
| M2  | Code Mode 与 TurnDiff 在真实环境按目标工作。       | V3、V5。                                        | 待实现后的端到端验收。         | pending |
