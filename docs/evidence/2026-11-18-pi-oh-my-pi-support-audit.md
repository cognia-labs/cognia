# Pi 与 Oh My Pi 支持审计

- Status: verifying
- Lane: standard
- Created: 2026-11-18
- Updated: 2026-11-18
- Related: [外部 Agent 支持审计](2026-10-27-agent-support-and-upstream-lifecycle-audit.md)、[Pi RPC ADR](../content/docs/en/adr/0119-pi-native-rpc-integration.md)、[Pi 子 Agent 验证](2026-10-21-pi-subagent-models.md)
- Baseline: 本机工作树，HEAD `f6b7354c51ac`。ACP 客户端包含在途修改。Pi、OMP 独立包和 OMP vendor profile 的结论以本轮读到的文件为准。

## Original request

> 帮我分析一下现在对pi和ohmypi的支持情况，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

## Knowledge

| ID  | Statement                                                                                                                          | State    | Basis                                           | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- | ---------- |
| G1  | 给出 Cognia 用户能走到的入口和实际能力、缺口、优先级、行业对照。                                                                   | Agreed   | 2026-11-18 用户请求                             | -          |
| O1  | Pi 产品入口注册 `pi-rpc`，由 `pi --mode rpc` 和受校验的 Cognia 扩展提供能力。                                                      | Verified | 产品注册、适配器源码、V1 原生进程               | -          |
| O2  | Oh My Pi 产品入口注册为 `omp acp`。独立 `omp-rpc` 包从 18.6.1 提取协议，产品注册表没有该工厂。                                     | Verified | 运行时目录、注册表、独立包说明、V2 原生进程     | -          |
| O3  | OMP ACP 18.22.2 切换原生 `plan` 后，当前 Cognia 会话记录为 `bypassPermissions`。                                                   | Verified | V3 真实适配器与 OMP 进程                        | O2         |
| O4  | Pi 版本探针可把退出码 2 判为 certified；超时返回时子进程仍在。                                                                     | Verified | V4 使用真实适配器及合成的本地子进程             | O1         |
| O5  | OMP ACP 在当前缺终端端口的配对传输配置，以及启用强制按工具审批规则的配置下，会在启动前拒绝。                                       | Verified | V2、OMP profile 和配对宿主端口实现              | O2         |
| O6  | Pi 认证 1.0.2，最低 0.85.1，1.5.2 已通过本轮离线探测且仍显示 unverified；指南仍写认证 0.84.1。OMP 目录缺少受测版本范围与托管制品。 | Verified | 适配器与目录、指南、上游 Releases、V1、V5       | O1, O2     |
| C1  | 本轮交付审计报告。进程样本使用临时 HOME、空项目、网络禁用与发布制品的 SHA-256 校验。                                               | Verified | 当前请求、V1–V4                                 | -          |
| Q1  | 真正的 Cognia Tauri / CLI / 配对 Host 入口在不同系统及供应商账号上的整条用户路径能否完成。                                         | Open     | V6 待真实环境验收                               | O1, O2     |
| O7  | Pi prompt ACK 超时后，上一轮迟到的文本和结束事件可以交给下一轮。变更配置时，显式 resume 也能打断后台原生运行。                     | Verified | V7 注入传输，真实适配器                         | O1         |
| O8  | Pi 的默认四进程限制可被五个并发开会话突破；打开会话与断开竞态可留下一个活跃进程。                                                  | Verified | V8 官方 Pi 1.0.2、1.5.2，无网络运行             | O1         |
| O9  | Pi 对 Host 上没有历史文件的原生 ID 返回 active 的新会话。                                                                          | Verified | V8 两个 Pi 版本，隔离状态目录                   | O1         |
| O10 | OMP 18.22.2 发每轮用量，Cognia 按会话累计量做差。供应商拒绝可作为正常文本返回并记为成功。                                          | Verified | V9 官方 OMP、本地合成供应商                     | O2         |
| O11 | 工作树在途的 ACP steering 实现把 OMP 的正常 promptRequired 回复当成无效响应。                                                      | Verified | V10 真实 OMP 加确定性交付边界；HEAD 工作树 diff | O2         |
| O12 | 当前 Rust 与 CLI Host 已有 raw stdout 通道；OMP RPC 仍需版本、状态隔离、可信守卫、出站撤销和原生身份映射的生产实现。               | Observed | V11 浏览 Host 与包契约，无生产运行              | O2         |

## Problem frame

从用户选择预设开始，沿产品注册、实际 Host 端口、版本检测、会话和审批投影追到上游。G1 的判断基于发布二进制、可重复的适配器证据和相关规范。现有综合审计已有在途编辑，本轮在单独的双产品账本记录新证据，并引用原审计作为追溯入口。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                           |
| ------------ | ------ | ----------------------------------------------------- |
| scale        | medium | 两条协议、通用运行时目录、原生进程和共享会话 UI。     |
| technical    | medium | ACP 协商能力、Pi 扩展握手、原生和 Cognia 权限映射。   |
| coupling     | high   | 模式同时影响 UI、会话恢复和 Host 的审批。             |
| requirement  | low    | 支持现状、可复现问题、缺口和对照。                    |
| verification | high   | 离线可查协议和进程；工具权限与用户路径需要实际 Host。 |
| risk         | high   | 模式投影错误能改变 Host 审批决策。                    |

## Risks

| ID  | Risk (impact)                                          | Severity | Source                                 | Claim                                          | Refuted by                                        |
| --- | ------------------------------------------------------ | -------- | -------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| R1  | OMP 规划模式错误进入自动批准分支                       | high     | 双向模式映射                           | 规划模式降不到更宽松的 Cognia 级别             | 原生 plan 被记作 bypassPermissions                |
| R2  | Pi 误报可用或遗留探测进程                              | medium   | 探针退出与清理                         | 版本认证需要成功退出，超时能回收子进程         | 退出码 2 被认证或超时后进程仍在                   |
| R3  | 将独立包测试或协议广告当成发布端到端支持               | high     | 注册表、Host 端口、上游协议版本        | 每项声明对应已验证版本及实际入口               | 工厂未注册、Host 缺端口或能力只在另一个协议出现   |
| R4  | 升级后文档、二进制及功能认证不同步                     | medium   | 运行时目录、Pi guide 和 bundle pin     | 文档、认证及发布验收范围可追溯                 | 指南、适配器、制品的版本口径不同                  |
| R5  | 迟到输出被记到错误对话轮次，或正在后台执行的会话被热换 | high     | Pi RPC 事件无每轮请求 ID；会话替换检查 | 前一个 prompt 的结果只归属它自己的轮次         | 下一轮收到了前一轮文本或后台运行被杀              |
| R6  | Pi 残留进程或历史连续性失真                            | medium   | Pi 启动、断开、恢复                    | 进程限额与断开能覆盖待启动；恢复能验证原生历史 | 并发超限、关闭后进程仍在、找不到历史仍返回 active |
| R7  | OMP 少记用量或把拒绝计成成功                           | medium   | OMP 每轮 usage 与 ACP stopReason 对照  | 使用原始回合语义记录消耗和状态                 | 后续轮次用量丢失或拒绝被计为成功                  |
| R8  | 工作树在途 steering 把正常未接收结果报成协议故障       | medium   | 版本化 OMP steering 契约               | 回合刚结束时明确提示输入未发送                 | OMP 正常回复收到 invalid response                 |
| R9  | OMP RPC 产品接入误把传输和握手当成权限与出站保证       | high     | ADR-0217 与 OMP 注入端口               | 由实际运行 Host 验证和执行守卫                 | 用布尔声明或普通进程结束接口替代独立的执行证据    |

## Verification obligations

| ID  | Risk           | Method                                                                                         | Independence | Evidence                                                                                                                    | Coverage                                                              | Status  |
| --- | -------------- | ---------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------- |
| V1  | R3, R4         | 真实 Pi 1.0.2 和 1.5.2 加载本仓构建的扩展，读取状态、条目、会话树，再关闭                      | tool         | 官方 macOS ARM64 制品 SHA-256 校验一致；两版均收到 Cognia 扩展握手，运行时状态和会话树读取成功，子进程回收                  | 沙箱内离线 adapter-to-native；真实账号、交互和生产 Host 留给 V6       | passed  |
| V2  | R3             | 真实 OMP ACP 18.22.2 检测协商、会话操作和拒绝面                                                | tool         | SHA-256 校验一致；initialize、new、list、load、resume、fork、close、回收通过；缺终端及强制审批配置明确拒绝                  | macOS ARM64，注入进程、文件与终端端口，未发起真实文件、终端和模型调用 | passed  |
| V3  | R1             | 从公开会话配置方法切换 OMP 宣告的原生 Plan，核对 Cognia 会话记录                               | tool         | 原生返回 `plan`，`getSession` 返回 `bypassPermissions`，预设以 Cognia `plan` 创建会话则拒绝                                 | 复现模式投影；自动批准影响来自审批源码推导                            | failed  |
| V4  | R2             | 对实际 Pi adapter 注入可控的子进程退出和超时                                                   | tool         | 先打印 1.0.2 再退出 2 得到 certified/connected；20 ms 超时夹具仍有一支子进程，夹具随后回收                                  | 版本和通用探针控制流；用户配置故障以人工触发为准                      | failed  |
| V5  | R3, R4         | 阶段性测试、扩展指纹与生成目录，核对当前版本协议与产品资料                                     | tool         | 仓库 Jest 31 套件 1134 测试通过；扩展指纹、目录生成一致性与 runtime gate 均通过；对照见下文                                 | 版本/合同快照和测试断言                                               | passed  |
| V6  | R1, R3, R4     | 在真实 Cognia 客户端和目标 Host 上验证登录、流式工具回合、审批与拒绝、断线恢复和制品           | real-env     | 本轮运行环境为离线适配器夹具，账号与目标客户端矩阵仍待验证                                                                  | macOS/Linux、配对 Web/移动端、真实供应商；Windows 属未声明的产品平台  | planned |
| V7  | R5             | 用真实 adapter 和可控帧交付验证 ACK 超时与后台工作时替换                                       | tool         | 先前回合的文本出现在下一轮；运行中的后台会话被按原 ID 热换且进程回收一次                                                    | 注入传输，未对真实 CLI 的事件发生概率或完整 UI 链路做测量             | failed  |
| V8  | R6             | 官方 Pi 1.0.2/1.5.2，并发启动、断开竞态、缺历史重开                                            | tool         | 两版均在五并发时存活五个进程，启动并发断开后仍存活一个，对未知 ID 返回 active 且只有 thinking_level_change                  | 适配器、临时工作区和真实二进制；正常 cleanup 由夹具完成               | failed  |
| V9  | R7             | 官方 OMP 18.22.2 和本机 HTTP 模型夹具，发两个等用量回合、关闭恢复后再发送、返回供应商 HTTP 400 | tool         | 线路两轮各 12，Cognia 只报第一轮 12，恢复首轮无用量；400 变成 agent_message_chunk 和 end_turn，适配器输出 done.success=true | 合成模型，运行真实 OMP ACP，不涉及供应商实际账单                      | failed  |
| V10 | R8             | 将已结束 OMP 回合的回复暂存在测试传输，使 Cognia 仍判执行中，再检查 steering 结果              | tool         | 18.22.2 返回 promptRequired 与 queue=steering，工作树中的适配器报 invalid response                                          | 在途 ACP steering 路径；HEAD 尚无该调用路径                           | failed  |
| V11 | R9             | 从 OMP 独立包追到 Host 的真实进程端口、分发、守卫和释放                                        | self         | 当前 Rust/CLI raw stdout 通路存在；OMP 包精确卡 18.6.1、仅订阅 raw、没有产品工厂或生产 prepareSession                       | 生产 Host 的可信装载、隔离、重新绑定和同步撤销待验收                  | passed  |
| V12 | R5, R6, R7, R8 | 当前工作树相关 Jest 套件                                                                       | tool         | Pi RPC、ACP client、ACP vendor profiles、OMP lifecycle、ExternalAgentManager 的 5 套件 1007 测试通过                        | 现有测试与 V7–V10 的故障证据分别保留                                  | passed  |
| V13 | R9             | 运行 OMP 原生 guard 和生命周期套件                                                             | tool         | 2 套件 22 测试通过，覆盖宿主证明、转换失败回调、并发准入和释放                                                              | 本地注入测试，生产 Host 的回调及出站撤销未验收                        | passed  |
| V14 | R9             | 在生产 Host 分别验收可信扩展、同父子会话权限与同步出站撤销                                     | real-env     | 当前没有 OMP RPC 生产启动工厂，独立包使用注入端口                                                                           | 真实安装包、进程组、沙箱网络和清理                                    | planned |

## Decisions

| ID  | Date       | Decision                                                                                | Action   | Based on   | Reversal trigger                                                            |
| --- | ---------- | --------------------------------------------------------------------------------------- | -------- | ---------- | --------------------------------------------------------------------------- |
| D1  | 2026-11-18 | 推荐先修 OMP 模式和审批投影，接着修 Pi 版本探针。                                       | diagnose | O3, O4     | 修复后同一真实进程或故障夹具通过                                            |
| D2  | 2026-11-18 | 保留 Pi RPC 与 OMP ACP。优先补协商能力与实际 Host 可用性；单列 OMP RPC 的宿主接入评估。 | diagnose | O1, O2, O5 | 关键需求必须使用 OMP 原生 RPC，且 Host 证明守卫安装、运行期授权和子进程清理 |
| D3  | 2026-11-18 | 以版本、平台、Host 和能力为发布验收维度，区分已探测与已认证。                           | diagnose | O6         | 产品已有覆盖这些维度的发布认证和可见诊断                                    |
| D4  | 2026-11-18 | Pi 先隔离 ACK 超时后的不确定回合，再处理启动限额、断开和历史恢复。                      | diagnose | O7, O8, O9 | 失败回合的迟到帧隔离、启动有代际和名额、历史丢失能区分的回归均通过          |
| D5  | 2026-11-18 | OMP 在现有 ACP 按厂商适配每轮 usage 和结构化终态，避免影响共享的累计计数兼容。          | diagnose | O10, O11   | OMP 上游契约改为可协商的累计应答和结构化终态                                |

## Residual risks

| ID  | Residual                                       | From         | Why still open                               | Next action                                                | Status |
| --- | ---------------------------------------------- | ------------ | -------------------------------------------- | ---------------------------------------------------------- | ------ |
| X1  | OMP 原生 Plan 与 Cognia 模式投影失配。         | V3           | 已复现，真实工具级后果仍待生产 Host 验收。   | 修映射和通用回退，用原生进程与审批回归验证。               | open   |
| X2  | Pi 探针退出与超时清理缺陷。                    | V4           | 已复现。                                     | 分离 exit 状态和版本解析，超时回收与限额验证。             | open   |
| X3  | 实际客户端、供应商与平台组合仍有验收空白。     | V6           | 无凭证、无实际客户端与发布镜像执行记录。     | 在预装的目标 Host 跑一次安装到恢复的完整流程。             | open   |
| X4  | Pi 回合和恢复缺陷仍开放。                      | V7, V8       | 当前已复现，实际产品频率未测。               | 固定回合归属，回收旧进程，显式区分 restore 与 create。     | open   |
| X5  | OMP 用量、失败状态和在途 steering 边界仍开放。 | V9, V10      | 用量和状态可复现；真实用户工作负载尚未核对。 | 在真实产物上复核版本化 wire，并将探针转成回归。            | open   |
| X6  | OMP RPC 生产守卫集成仍需独立验收。             | R9, V11, V14 | 包级 attestation 由注入宿主提供。            | 校验版本、文件、进程组和出站撤销，验收父子会话与进程退出。 | open   |

## Outcome

| ID  | Signal                                               | How / when measured        | Result                                                                     | Status  |
| --- | ---------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- | ------- |
| M1  | 能从产品入口解释两套支持现状并给出排期。             | 2026-11-18 证据与上游对照  | 两个可复现缺陷、两个明确的 OMP 宿主限制、版本与功能差距已入账。            | met     |
| M2  | 修复后真实客户端上的审批、登录、回合和恢复满足目标。 | 后续有修复的版本按 V6 验收 | 待安排。                                                                   | pending |
| M3  | 跟进源代码，定位协议行为、Host 放置和失败边界。      | 2026-11-18 第二轮代码审计  | 已复核 Pi 回合、启动、断开、恢复，以及 OMP 用量、回合终态和在途 steering。 | met     |

## 产品能力矩阵

| 能力             | Pi                                                                                                                                                        | Oh My Pi                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户入口和分发   | `pi-rpc`，运行时目录选择系统 `pi`；另有完整 Runner 镜像的 npm 1.0.2 pin。                                                                                 | `oh-my-pi`，系统 `omp acp`。两者预设目录均声明 macOS/Linux，无 Windows 产品支持声明。                                                                                |
| 会话和交互       | 模型、推理档位、图片、streaming、steer、取消、resume、fork；Pi 会话树、增量条目、导出、队列、扩展交互进入共用会话操作。                                   | ACP 启动协商、会话 list/load/resume/fork/close、mode/thinking、配置过 provider 时的模型选择；声明嵌入上下文和图片、HTTP/SSE MCP。18.22.2 没有宣告 `session/delete`。 |
| 工具、审批、状态 | 原生工具和直接 shell 由扩展、中介与 Host 沙箱共同约束。外部 MCP 由 Cognia 扩展挂载。支持 Pi 原生登录引导、模型/账号探测、Gateway 配方、显式选择的 Pi 包。 | ACP 文件、终端和工具决策依赖 Host 端口及上游的请求。使用 OMP 自己的认证，支持 ACP 声明的原生凭证和终端认证方法。当前 Gateway 配方无 OMP。                            |
| 生态扩展         | Pi package 管理、迁移和历史解析已有入口。子 Agent 模型控制取决于支持的扩展家族和 Gateway 入口；原生 Pi 核心能力与扩展能力分别验收。                       | 18.6.1 的 `agent-omp` 包包含原生队列、子 Agent、goal/todo、handoff、voice、历史解析和 host-tool/URI。产品走 ACP，独立包的功能矩阵仅适用于该 RPC 包与注入宿主。       |

[运行时目录](../../protocol/external-agent-runtimes.json#L427) · [产品注册](../../lib/ai/agent/external/integrations/register.ts#L29) · [Runner pin](../../deploy/bundle/agent-versions.json#L128) · [Pi 操作](../../packages/agent-pi/src/rpc-client.ts#L1847) · [会话操作 UI](../../components/agent/external-agent/session-operations.tsx#L272) · [OMP 独立包](../../packages/agent-omp/README.md) · [Gateway 配方](../../lib/ai/agent/external/integrations/gateway.ts#L12)

## 建议处理顺序

1. **P1 · OMP Plan 的权限投影。** 默认返回的模式列表包含原生 Plan。Cognia 用共享配置操作发送 `mode=plan`，上游接受，Cognia 的通用 fallback 却记录为 `bypassPermissions`。后续如果有 ACP 权限请求且配置没有强制询问，Host 审批代码可读到自动允许状态。复现范围为模式投影，自动批准影响来自代码路径。建议同时覆盖创建、切换、恢复和未知模式，遇到未知模式保留受限状态或明确拒绝。 [厂商映射](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L9) · [OMP profile](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L218) · [会话写入](../../packages/agent-acp/src/client.ts#L3428) · [审批分支](../../packages/agent-acp/src/client.ts#L4738) · [上游 Plan](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L2534)
2. **P1 · OMP 可运行性和逐工具审批。** 当前配对 UI 传输的 Host 能力声明缺 ACP terminal，不能启动该预设。命令行 Host 单独提供 macOS/Linux 的终端能力。原生预批准工具可能不发 ACP 权限请求，强制 `requireApprovalFor` 被明确拒绝。先在设置和 Agent 选择处呈现受限原因。若要支持配对执行，验收所属 Host 的受控终端或等价的沙箱内能力。任何强制审批承诺需要覆盖实际执行路径。 [当前端口](../../lib/ai/agent/external/agent-transport.ts#L152) · [CLI 端口](../../cli/src/runtime/external/host-branch.ts#L42) · [启动要求](../../packages/agent-acp/src/client.ts#L1090) · [ACP 工具调用](https://agentclientprotocol.com/protocol/v1/tool-calls)
3. **P2 · Pi 探测与版本认证。** 版本探测忽略退出码，超时缺回收。修复后让文档、运行时诊断、Runner pin 与认证清单一致。Pi 1.5.2 的本轮离线握手可以作为下一轮兼容试验的输入。OMP 配置应显示实际运行版本与能力来源，ACP 的已测版本应独立于 18.6.1 RPC 包的认证。 [版本判定](../../packages/agent-pi/src/rpc-client.ts#L109) · [探针](../../packages/agent-pi/src/rpc-client.ts#L691) · [Pi 指南](../content/docs/en/chat/external-agents/pi-adapter.mdx#L71) · [Pi 1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2) · [OMP 18.22.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.22.2)
4. **P2 · OMP 的原生能力与产品入口。** 上游 ACP 已发原生 `_omp/compaction/start|end`，并提供 `_omp/usage`、扩展列表等自定义请求。Cognia 共用 ACP 客户端处理标准化的 `compaction_update` 与 `usage_update`，当前 OMP profile 未接这些厂商扩展。先按使用价值补状态、可见的原生配置与会话管理。等需要子 Agent 控制、goal/todo 或 handoff 时，再比较扩展 ACP 与单独接入 RPC 的成本。 [上游 ACP 扩展](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L1644) · [Cognia ACP 事件](../../packages/agent-acp/src/client.ts#L5353) · [OMP RPC 语义](https://github.com/can1357/oh-my-pi/blob/v18.22.2/docs/rpc.md#prompt-lifecycle)
5. **P2 · 安装和账号诊断。** 两个系统预设都依赖 PATH，OMP 也没有 Pi 对应的专用账号状态卡或 Gateway 模型配方。可沿用 Cognia 现有运行时生命周期，给出实际 Host 上的安装、版本、登录、模型可达性和首轮验证状态。 [系统运行时目录](../../protocol/external-agent-runtimes.json#L768) · [Pi 状态卡入口](../../components/settings/agent/agent-inspector.tsx#L798) · [Zed 的安装与认证边界](https://zed.dev/docs/ai/external-agents)

## 行业实践对照

| 实践                                                                                                                  | 可用于 Cognia 的验收标准                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zed 将 Registry 安装、线程选择、Agent 原生认证及远程凭证边界放进产品流程。                                            | 用户可在目标 Host 知道安装状态、实际版本、账号来源、可选模型和拒绝原因。对于已有会话，沿用 Cognia 的原生会话入口并显示当前 Host 与状态目录。 [Zed 外部 Agents](https://zed.dev/docs/ai/external-agents) · [ACP Registry](https://agentclientprotocol.com/get-started/registry)  |
| ACP 对模型、模式等使用协商的 config options。OpenCode 的权限规则显式匹配动作与资源并返回 ask、allow 或 deny。         | 区分 UI 标签、原生模式和 Host 权限。以实际审批结果验收权限边界，未知模式保持受限。 [ACP 配置](https://agentclientprotocol.com/protocol/v1/session-config-options) · [OpenCode Permissions](https://opencode.ai/docs/permissions/)                                               |
| Pi RPC 用 `agent_settled` 区分已接收与完全静止；OMP RPC 分开处理 `prompt_result` 与 `session_settled`。               | 保留 Pi 已实现的生命周期判断。扩展 OMP 时独立验收开始、回合返回、后台工作、取消、断线恢复与回收这些时点。 [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) · [OMP RPC](https://github.com/can1357/oh-my-pi/blob/v18.22.2/docs/rpc.md) |
| openma/pi-acp 声明映射原生会话管理、命令、扩展交互、工具差异和终端。Zed 的 Agent Panel 提供提交前逐块查看和接受变更。 | 以用户能看懂的会话连续性、文件变更和工具状态做验收。优先复用 Cognia 现有会话树和工具 UI；具体协议由所需能力与 Host 权限决定。 [openma/pi-acp](https://github.com/openma-ai/pi-acp) · [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel#reviewing-changes)                   |

## 复核记录

- 仓库 Jest 命令为 `pnpm test --runInBand packages/agent-pi/src packages/agent-omp/src packages/agent-acp/src/client.test.ts packages/agent-acp/src/vendors/catalog-expansion.test.ts lib/ai/agent/external/integrations/pi.test.ts lib/ai/agent/external/config/presets.test.ts lib/ai/agent/external/config/install-catalog.test.ts`。
- 原生夹具位于本机 `.cache/pi-omp-support-audit/native-probe.ts`。使用 `node_modules/.bin/tsx` 运行，参数依次为 `pi <path-to-pi>`、`omp <path-to-omp>` 或 `pi-faults`。Pi 使用本仓 `stagePiExtension` 构建扩展。OMP 夹具的 binary 路径 basename 为 `omp`，以进入实际 vendor profile。所有进程由临时目录、最小环境及 macOS 禁网配置启动。
- 正常运行原生结果涵盖两个 Pi 发行版和 OMP ACP 的无账号生命周期。真实供应商、MCP 数据、工具执行、高风险模式切换、打包成品、Linux 与真实配对客户端列入 V6。

## 第二轮代码深查

第二轮基线为 `d861ef61c4b6` 的工作树。上轮到本轮 HEAD 的变化未触及两个适配器、独立 OMP RPC 包与 Rust 进程模块。当前 ACP client 工作树 diff 中的 steering 功能仍在开发，只有下面的 steering 发现依赖这项改动。

### Pi 的回合与进程生命周期

1. **P1 · 超时后的帧串入下一轮。** `PiRpcPeer` 用 ID 匹配命令 ACK，原生 `message_update` 和 `agent_settled` 则属于进程会话。ACK 超时后，`prompt` 只在有待处理对话框时关闭进程，否则释放当前队列和 busy 标记。探针模拟 `agent_start` 还未到达，下一轮开始后收到了上一轮的迟到文本和结束帧。同进程再接收输入前，应证明未发送、已停止或旧进程已经回收。两次提交需能分别归因。 [ACK 清理](../../packages/agent-pi/src/rpc-client.ts#L1506) · [事件投影](../../packages/agent-pi/src/rpc-client.ts#L1839) · [Pi RPC 生命周期](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/rpc.md)
2. **P2 · 并发启动与断开。** `reclaimCapacity` 检查 `processes.size`，后续才注册新记录，中间缺待启动名额。五个并发请求均通过默认四进程的检查。断开关掉当时已登记的进程，但没有取消尚未登记的启动。两个官方 Pi 版本均复现相同结果。Manager 的可选 `maxConcurrentSessions` 也只查当前已登记的会话。独立 OMP RPC 已有同步预留名额和连接代际校验，可作为 Pi 并发修复的参考。 [Pi 断开](../../packages/agent-pi/src/rpc-client.ts#L678) · [进程限额](../../packages/agent-pi/src/rpc-client.ts#L1374) · [Manager](../../lib/ai/agent/external/manager.ts#L4345) · [OMP RPC 预留](../../packages/agent-omp/src/rpc-client.ts#L208)
3. **P2 · 缺失历史被当成恢复成功。** `resumeSession` 共用 `--session-id`，Pi 会在存储中缺这个 ID 时创建同 ID 的会话。租约恢复可以继续，但用户可能以为旧上下文仍然存在。使用临时空 HOME 和有效 UUID，两版均返回 active、原 ID，只读到一个思考档位变更。显式恢复历史和恢复从未写入历史的空会话需要不同结果。 [Pi 恢复](../../packages/agent-pi/src/rpc-client.ts#L774) · [Manager 恢复结果](../../lib/ai/agent/external/manager.ts#L2383)
4. **P2 · 热换跳过后台运行状态。** 原生后台运行可使 `nativeRunning` 为真而 adapter 的 `busy` 为假。普通 prompt 会检查二者，但带新选项的 resume 只检查 `busy` 和 `shellRunning`，并在普通 prompt 的运行检查之前执行。夹具验证旧进程被关掉并同步重开。修复需复用统一的运行状态，保留显式停止和恢复的语义。 [恢复条件](../../packages/agent-pi/src/rpc-client.ts#L795) · [发起回合](../../packages/agent-pi/src/rpc-client.ts#L1459)

### OMP 的产品 ACP 语义

1. **P2 · 回合用量漏报。** OMP 的 `buildTurnUsage` 已在服务端对本轮前后做差，Cognia 默认再对这组数做差。本机 18.22.2 两轮各返 12，第二轮和关闭恢复后的首轮被记成未知用量。Manager 直接从适配器结果累计，影响其使用统计。共享 ACP 已有 `promptUsage` 厂商钩子，可沿用该入口处理 OMP 的回合用量，另外保留上下文占用及会话累计成本的语义。 [上游用量](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L2961) · [Cognia 累计量路径](../../packages/agent-acp/src/client.ts#L3084) · [厂商钩子](../../packages/agent-acp/src/vendor-profile.ts#L126) · [Manager 统计](../../lib/ai/agent/external/manager.ts#L5640)
2. **P2 · 普通供应商错误被记成成功。** OMP 18.22.2 把探针中的模型 HTTP 400 写成助手文本并返回 `end_turn`。Cognia 因此上报成功。既要保留上游文本，又要通过上游协议或明确的厂商扩展识别失败。当前证据只覆盖指定版本和错误类别，通用 ACP 层不宜用自然语言内容猜测是否失败。 [上游错误投影](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L2229) · [Cognia 终态](../../packages/agent-acp/src/client.ts#L3009) · [ACP 完成语义](https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons)
3. **在途 P2 · steering 的未接收应答。** 回合刚结束时，OMP 返回 `{ outcome: "promptRequired", queue: "steering" }`。当前工作树的通用适配器审核 `reason === "noRunningTurn"`，于是报告 invalid response。应向用户保留原输入并明确它未进入原回合，交付语义不确定时应继续禁止自动重发。 [上游 steering 扩展](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L1753) · [工作树处理](../../packages/agent-acp/src/client.ts#L2834)
4. **指令层级的产品差异。** OMP ACP 会话创建只接收 cwd 与 MCP servers，未消费 Cognia 的 `_meta.systemPrompt`。共享 ACP 适配器有兜底，会把变化的指令作为 prompt 中的普通文本块发送。Pi 则通过 Cognia 守卫扩展在启动时注入原生 system prompt。源码支持这个差异，模型实际服从程度仍未测量。 [OMP 创建会话](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L1102) · [ACP 发送上下文](../../packages/agent-acp/src/client.ts#L2636) · [Pi 指令构造](../../packages/agent-pi/src/rpc-client.ts#L2782)

### OMP 原生 RPC 接入依赖

当前 Rust 进程和 CLI 端均支持原始字节通道，原生 OMP adapter 也明确要求该通道。剩余工作主要是由宿主确认可用二进制和版本，将会话状态、账号、守卫和协议绑定到同一运行环境。独立包当前只允许 18.6.1。产品接入还需要落实原生会话定位和工具审批，验证可信扩展隔离与复绑，在守卫转换失败时提供同步终止或撤销出站的能力，最后确认进程和后代结束后才释放资源。这些义务应先与实际 Host 接口对齐，再做产品注册。 [Rust 原始通道](../../crates/cognia-external-agent/src/process.rs#L660) · [OMP 端口合同](../../packages/agent-omp/src/rpc-client.ts#L39) · [版本要求](../../packages/agent-omp/src/rpc-client.ts#L150) · [守卫失败处理](../../packages/agent-omp/src/native-guard.ts#L235)

复核使用本机缓存的 `pi-adversarial.ts`、`pi-turn-adversarial.ts` 和 `omp-adversarial.ts`。运行的官方二进制沿用上轮 SHA-256 校验，OMP 模型仅连临时 loopback 夹具，未读取用户凭证。当前工作树的 5 个指定 Jest 套件全部通过，共 1007 项，`ExternalAgentManager` 测试的清理日志有一条读取缺失 protocol 的错误，测试进程退出 0。未对该日志做问题归因。
