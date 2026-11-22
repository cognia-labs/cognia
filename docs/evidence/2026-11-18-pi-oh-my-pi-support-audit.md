# Pi 与 Oh My Pi 支持审计

- Status: verifying
- Lane: standard
- Created: 2026-11-18
- Updated: 2026-11-22
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
| G2 | 逐项复核上一轮 24 个问题，明确已修、部分落地和开放项，重新对照上游与产品实践。 | Agreed | 2026-11-22 用户请求 | - |
| O13 | 2026-11-21 的六个提交覆盖 Pi 生命周期、OMP ACP、Gateway、历史导入和诊断。 | Verified | 本地 dev HEAD `86c188cba482` 与下文复核表 | - |
| O14 | OMP 原生 Plan 和 12/12/12 回合用量通过。两版仍将合成供应商 HTTP 400 记为成功。 | Verified | V15，macOS arm64 官方 OMP 18.22.2 / 19.1.0 | O13 |
| O15 | Pi 原始竞态和缺历史在 1.0.2 / 1.5.2 / 1.6.0 的样本有改善。0.85.1 的自定义目录仍会打开空会话。 | Verified | V16，官方二进制与合成工作区 | O13 |
| O16 | Pi 同一持久化 ID 并发首次恢复可两次启动并同时失败。ACK 超时后重用进程 ID，重绑后晚到帧可以串轮。 | Verified | V17：真实 Pi + 可控 Host 查找时序；V18：注入传输 | O13 |
| O17 | Pi 认证版本在适配器与通用运行时评估不一致。OMP 19.1.0 可完成探针，目录版本评估为 unsupported。 | Verified | V19，目录和运行时评估函数 | O13, O14 |
| G3 | 对 Pi／OMP 支持和原修复结论做独立对抗性审查，并列出优先级和证据。 | Agreed | 2026-11-22 用户请求，本轮仅使用本地复核流程 | - |
| O18 | Manager 的正常执行和流式执行会把 Pi 缺历史转成新建。真实适配器加注入 Host 复现 Manager 重放已 ACK 的输入，以及 LRU 之后下轮失败。 | Verified | V21，当前源码可控探针 | O13 |
| O19 | Pi 同一进程的后台结算可提前结束新前台回合。缺历史查询的并行窗口也允许 close 返回后再启动。 | Verified | V22，独立审查与注入 Host | O13 |
| O20 | OMP Plan、认证与就绪有多个独立状态投影问题。目录版本判定也没有进入普通 ACP 握手。 | Verified | V23，独立 ACP 事件探针、产品调用链与固定版本上游 | O13 |
| O21 | OMP 导入可错选主分支、把 clear 前文本引入续聊、丢失附件或来源语义，并漏扫迁移后的目录。 | Verified | V24，真实 TS 导入链加合成 JSONL／文件系统 | O13 |

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
| R10 | 双路恢复或重绑上的新问题可能丢失回合与会话连续性 | high | Pi 恢复锁、进程 ID、Host stdout 排空 | 同一 ID 只启动一次，旧帧永远归属旧进程 | 两次启动、恢复失败或在新轮收到旧帧 |
| R11 | 实际运行、诊断与产品认证给出不同结论 | medium | 运行时清单、官方制品与原生诊断 | 每个 Host 的认证来自同一有证据的能力矩阵 | 同版本出现 certified 与 supported-uncertified，或候选越出支持范围 |
| R12 | 已接受输入被重发，或者旧结算截断新输入 | high | Manager deadline、Pi 原生回合投递 | 已接受输入只写一次，每个完成事件归属于原回合 | 两次 prompt 写入，或前台先空成功再丢出真实回复 |
| R13 | Plan 确认、认证与配置就绪状态不可信 | high | ACP 协商、OMP 原生 Plan、设置与 Manager | 能力不足时 Plan 保持受限，授权和就绪有可靠的运行信号 | 缺表单自动走确认、界面与代理审批不同、认证/就绪被误判 |
| R14 | 导入历史标错分支、角色、范围或目录，续聊取错上下文 | high | 上游 session DAG、reset/附件契约和 Cognia 导入 | 原生当前分支与清除边界正确，未知信息明确记损失 | 主分支错选、清除前内容进入 seed、无效附件或漏扫有效目录 |

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
| V15 | R1, R3, R7, R8 | 重跑 Plan 创建/切换、原生会话操作、12/12/12 计量、steering 终态、HTTP 400 | tool | OMP 18.22.2 与 19.1.0 均通过基础操作，400 仍返回 `end_turn` 与 `done.success=true` | 真实 arm64 ACP 进程与 loopback 合成模型，权限请求断言来自 Jest，真实 Host 审批待验收 | failed |
| V16 | R2, R5, R6 | 真实子进程退出/清理，官方 Pi 并发启动、断开、缺历史，热换用事件对照 | tool | 打印版本退出 2 被拒，探针超时剩余 0。Pi 1.0.2、1.5.2、1.6.0 各 4 成功/1 拒绝，断开残留 0，缺历史拒绝。0.85.1 自定义目录仍返回同 ID 的空 active 会话。后台热换被拒 | macOS arm64 真实 Pi 和注入过程端口 | failed |
| V17 | R6, R10 | 对真实 Pi 1.0.2 先顺序恢复已保存的 JSONL，再让两次恢复同时跨过历史查询 | tool | 串行正常并读到既有消息，并发发起两次 spawn，分别因一支进程提前退出和重复 ID 失败，最后会话不在运行 | 原生二进制、CLI 真实历史扫描逻辑、注入 Host 拒绝重复 ID；Tauri/CLI 生产端口也拒绝重号 | failed |
| V18 | R5, R10 | 将旧帧分别投递在超时回收后且未重绑、已重绑且下一轮发出后 | tool | 未重绑时丢弃。复用同 processId 并重绑后，旧文本和 `agent_settled` 被交给新轮 | 注入 Host 传输；生产 Rust/CLI 的退出与 stdout 排空顺序见下文，未测实际复现频率 | failed |
| V19 | R3, R4, R11 | 对照上游 Releases、两套版本判断、工厂与 Host 端口 | tool | Pi 1.0.2 在 adapter 显示 certified，通用评估为 supported-uncertified；OMP 18.22.2 在通用评估为 certified，19.1.0 为 unsupported；强制审批与缺终端组合在两个 OMP 版本均被明确拒绝 | 真实适配器加纯函数与源码，未从生产设置界面发起安装 | failed |
| V20 | R1, R2, R6, R7, R8, R9 | Jest 相关适配器、Manager、使用量、诊断、导入与 Gateway 测试；运行时目录、架构能力与扩展 pin | tool | 44 套 1835 测试通过；`audit:agent-capabilities`、`audit:external-agent-runtimes`、`pi:extension:pin:check` 通过 | 单元及集成夹具，成功信号仅对断言覆盖范围有效 | passed |
| V21 | R6, R10, R12 | 通过 Manager 对可控 Pi 流程重放 timeout、missing resume 和 LRU | tool | 普通 execute/stream 处理缺历史时新建会话；实际 Pi adapter 接 ACK 后，Manager timeout 在注入 Host 上写同一输入两次；LRU 后复用已关闭 id 得到 Unknown Pi session | 当前源码和临时 Jest 夹具；Manager execute 与适配器 Host 端口，未用生产客户端/供应商 | failed |
| V22 | R5, R6, R10, R12 | 同进程后台 settle、同 id 并发恢复/close、跨配置容量、重绑晚到帧 | tool | 推迟旧统计 ACK 后，前台没收到自身输出就空成功。独立阻塞查询探针复现重复 spawn 和 close 后启动。共用 Host 的两个 adapter 共 8 会话。V17/V18 复跑仍命中 | 真实 Pi 1.0.2 用于 V17 原生恢复；其余为注入端口，实际 Node 双启动尚待实机验证 | failed |
| V23 | R1, R3, R7, R11, R13 | 对 OMP Plan、ACP 认证/版本、终态和 Gateway 做不利对照 | tool | 可控 ACP 投影出现界面为 default、审批仍 deny，认证方法被当作认证必需，目录外版本能完成普通 initialize。两版真实 OMP HTTP 400 仍成功；同两版的 Gateway 配方实际通过 loopback 合成模型 | 原生 OMP 18.22.2/19.1.0 加合成 provider，Plan 缺表单的最终确认分支是源码证据 | failed |
| V24 | R14 | 独立审阅及复跑 OMP JSONL 与扫描合成夹具 | tool | 主分支错选、clear 前内容进入 branchSeed、角色与图片损失、两类目录错误及来源冲突已复现；迁移设置作用域有源码证据 | 实际导入 TS 与合成输入，未读取用户历史或运行真实 Tauri 迁移 UI | failed |
| V25 | R2, R4, R6, R8 | 聚焦 Pi、ACP、Manager、Gateway、导入、OMP 状态组件回归 | tool | 6 套 1011 项通过。真实 OMP 逐轮 12/12/12、steering 未注入和合成 Gateway 配方样本通过 | 正常路径及既有回归，另用 V21 到 V24 发现反例 | passed |

## Decisions

| ID  | Date       | Decision                                                                                | Action   | Based on   | Reversal trigger                                                            |
| --- | ---------- | --------------------------------------------------------------------------------------- | -------- | ---------- | --------------------------------------------------------------------------- |
| D1  | 2026-11-18 | 推荐先修 OMP 模式和审批投影，接着修 Pi 版本探针。                                       | diagnose | O3, O4     | 修复后同一真实进程或故障夹具通过                                            |
| D2  | 2026-11-18 | 保留 Pi RPC 与 OMP ACP。优先补协商能力与实际 Host 可用性；单列 OMP RPC 的宿主接入评估。 | diagnose | O1, O2, O5 | 关键需求必须使用 OMP 原生 RPC，且 Host 证明守卫安装、运行期授权和子进程清理 |
| D3  | 2026-11-18 | 以版本、平台、Host 和能力为发布验收维度，区分已探测与已认证。                           | diagnose | O6         | 产品已有覆盖这些维度的发布认证和可见诊断                                    |
| D4  | 2026-11-18 | Pi 先隔离 ACK 超时后的不确定回合，再处理启动限额、断开和历史恢复。                      | diagnose | O7, O8, O9 | 失败回合的迟到帧隔离、启动有代际和名额、历史丢失能区分的回归均通过          |
| D5  | 2026-11-18 | OMP 在现有 ACP 按厂商适配每轮 usage 和结构化终态，避免影响共享的累计计数兼容。          | diagnose | O10, O11   | OMP 上游契约改为可协商的累计应答和结构化终态                                |
| D6 | 2026-11-22 | 按当前证据重开 Pi 回合归属/历史恢复和 OMP HTTP 400 终态；维持 OMP ACP 产品路径，另验证新版本范围。 | diagnose | O14, O15, O16, O17 | 故障注入不再串轮，真实 Pi 两个并发恢复只启动一次，旧目录缺历史显式拒绝，官方 OMP 的真实 wire 提供可判定失败信号。 |
| D7 | 2026-11-22 | 仅用本地独立审查与合成探针。优先处理 Pi 的回合/恢复、OMP Plan/失败终态和导入上下文。 | diagnose | O18, O19, O20, O21 | 修复后对应故障探针全过，并在生产 Host 验证权限、退出/排空、持续恢复和导入行为。 |

## Residual risks

| ID  | Residual                                       | From         | Why still open                               | Next action                                                | Status |
| --- | ---------------------------------------------- | ------------ | -------------------------------------------- | ---------------------------------------------------------- | ------ |
| X1  | OMP 原生 Plan 与 Cognia 模式投影失配。         | V3           | 已复现，真实工具级后果仍待生产 Host 验收。   | 修映射和通用回退，用原生进程与审批回归验证。               | open   |
| X2  | Pi 探针退出与超时清理缺陷。                    | V4           | 已复现。                                     | 分离 exit 状态和版本解析，超时回收与限额验证。             | open   |
| X3  | 实际客户端、供应商与平台组合仍有验收空白。     | V6           | 无凭证、无实际客户端与发布镜像执行记录。     | 在预装的目标 Host 跑一次安装到恢复的完整流程。             | open   |
| X4  | Pi 回合和恢复缺陷仍开放。                      | V7, V8       | 当前已复现，实际产品频率未测。               | 固定回合归属，回收旧进程，显式区分 restore 与 create。     | open   |
| X5  | OMP 用量、失败状态和在途 steering 边界仍开放。 | V9, V10      | 用量和状态可复现；真实用户工作负载尚未核对。 | 在真实产物上复核版本化 wire，并将探针转成回归。            | open   |
| X6  | OMP RPC 生产守卫集成仍需独立验收。             | R9, V11, V14 | 包级 attestation 由注入宿主提供。            | 校验版本、文件、进程组和出站撤销，验收父子会话与进程退出。 | open   |
| X7 | OMP 供应商拒绝仍有绿色成功状态 | V15 | 18.22.2 / 19.1.0 上均实际复现，结构化钩子没收到信号 | 对接可验证的上游错误信号，分别验证取消、合规拒绝与供应商失败 | open |
| X8 | Pi 最低支持版本的自定义目录可恢复成空会话，持久化 ID 并发恢复失败 | V16, V17 | 0.85.1 探针返回 active。1.0.2 同 ID 并发双失败 | 将权限一致的历史查询与重启串行化，加入最低版本与自定义目录验收 | open |
| X9 | Pi 重绑后仍可能接受旧进程的迟到 stdout | V18 | 注入传输已复现，Rust 和 CLI 有退出与读尾之间的时序空白，完整 Host 尚未复现 | 使用不同进程代际标识，或验证端到端排空屏障 | open |
| X10 | OMP 新主版本没有走完认证，Pi 认证有两个口径 | V19 | 19.1.0 超出目录；Pi 1.0.2 三个证据来源中的通用目录漏了认证 | 统一版本来源，按发行制品和目标 Host 分列验收 | open |
| X11 | 已接受 Pi 输入会重发，旧后台或旧进程结算可完成新回合，恢复可丢上下文或并发失败 | V21, V22 | 真实 adapter 的可控端口和 Manager 流程已复现 | 按回合所有者隔离事件和 retry；保存会话在准入至关闭范围内串行化 | open |
| X12 | OMP Plan 与运行就绪信号会失配，部分选择可能缺少显式确认 | V23 | 有固定上游证据、ACP 事件探针和真实 loopback 反例 | 确认能力不足时收紧 Plan，区分 ACK／业务终态／运行时就绪 | open |
| X13 | OMP 历史导入会选错上下文或目录 | V24 | 合成数据已复现，真实数据和 Tauri UI 仍待验收 | 按上游重放分支、reset、角色/目录语义，声明无法恢复的信息 | open |

## Outcome

| ID  | Signal                                               | How / when measured        | Result                                                                     | Status  |
| --- | ---------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- | ------- |
| M1  | 能从产品入口解释两套支持现状并给出排期。             | 2026-11-18 证据与上游对照  | 两个可复现缺陷、两个明确的 OMP 宿主限制、版本与功能差距已入账。            | met     |
| M2  | 修复后真实客户端上的审批、登录、回合和恢复满足目标。 | 后续有修复的版本按 V6 验收 | 待安排。                                                                   | pending |
| M3  | 跟进源代码，定位协议行为、Host 放置和失败边界。      | 2026-11-18 第二轮代码审计  | 已复核 Pi 回合、启动、断开、恢复，以及 OMP 用量、回合终态和在途 steering。 | met     |
| M4 | 对旧清单逐项给出现状，并重跑影响结论的原生与故障对照。 | 2026-11-22，本地 dev `86c188cba482` | 10 项原问题已修或功能已接入，9 项部分落地，5 项仍开放；另发现并发恢复与版本诊断差异。 | met |
| M5 | 实际 Cognia 首次登录及恢复中，权限、终态和生命周期满足产品发布要求。 | 补齐修复后运行目标客户端、Host 和真实供应商矩阵 | 当前已有可复现红项，完整产品链路待验收。 | pending |
| M6 | 产出独立复核、可复跑反例和按优先级的问题列表。 | 2026-11-22，本地 dev `86c188cba482` | 25 个对抗性问题，8 个 P1、15 个 P2、2 个 P3。 | met |

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

## 2026-11-22 复核

本节以本地 `dev` 的 `86c188cba482` 为基线。前文记录的是 2026-11-18 两轮审计。编号沿用当时完整的 24 项问题清单。“已修”限下表所述问题和验证范围。“部分”表示旧问题仍能在某个受支持组合复现，或者已交付诊断、映射等一部分能力。复核使用独立探针、已有回归测试和当前源码。探针在 macOS arm64 的临时 HOME 和空项目中运行，Pi 禁网，OMP 模型只访问 loopback。各官方制品的 SHA-256 与 Releases API 一致。

### 当前可用入口

- **Pi** 走 `pi-rpc` 和带指纹的 Cognia 扩展。正常入口支持流式对话、模型和推理档位、图片、取消、steering／follow-up、会话树与分支、原生历史、扩展 UI、经许可的 Pi packages 与 MCP。适配器最低接受 0.85.1，认证 1.0.2，1.5.2／1.6.0 通过本次离线适配器探针并标为未认证。Full Runner 仍 pin 1.0.2。 [产品注册](../../lib/ai/agent/external/integrations/register.ts#L29) · [Pi 指南](../content/docs/en/chat/external-agents/pi-adapter.mdx) · [Pi 1.6.0](https://github.com/earendil-works/pi/releases/tag/v1.6.0)
- **Oh My Pi** 走系统 `omp acp`。实测可创建、列表、加载、恢复、分叉、关闭，支持原生 Plan／thinking、原生认证方法发现，并有流式输出、协商模型、HTTP／SSE MCP 与图片能力。Cognia 增加了 Gateway 作业配方、JSONL 历史导入及迁移条目、设置诊断和压缩状态投影。`omp-rpc` 独立包目标制品为 18.6.1，应用和 CLI 的运行入口仍走 ACP。 [运行时目录](../../protocol/external-agent-runtimes.json#L768) · [OMP 独立包](../../packages/agent-omp/README.md) · [OMP 19.1.0](https://github.com/can1357/oh-my-pi/releases/tag/v19.1.0)

### 上轮 24 项逐项判定

| # | 上轮问题 | 状态 | 本次证据与剩余边界 |
| -- | -- | -- | -- |
| 01 | Pi ACK 超时串轮与不确定送达的重试 | 部分 | `49c169317a` 退休旧进程、阻止直接再发，Manager 回归验证不自动重放。重绑复用 processId 时仍可接到旧帧，见 V18。 |
| 02 | OMP Plan 权限映射 | 已修 | `87f7b294b1`。两版实际原生 Plan 创建和切换都投影为 `plan`。ACP 夹具验证 Plan、未知模式及切换期的审批上限。真实 Host 文件/终端执行仍在 V6。 |
| 03 | OMP 用量漏报 | 已修 | `87f7b294b1`。两版的两轮各 12，恢复首轮仍是 12。共享 tracker 回归验证上下文占用与累计金额不会变成回合实耗或成本。实际供应商账单未核对。 |
| 04 | Pi 非零退出仍被认证 | 已修 | `49c169317a`。子进程输出 1.0.2 后退出 2，结果为 `unsupported/error`。 |
| 05 | Pi 超时探针残留 | 已修 | `49c169317a`。实际子进程超时后剩余 0，Jest 覆盖并发探针 ID。 |
| 06 | Pi 五个并发启动突破四进程上限 | 已修 | `49c169317a`。三个正式版本均为 4 成功、1 拒绝、峰值 4。Manager 可选上限也有并发回归。 |
| 07 | Pi 并发断开后仍留下进程 | 已修 | `49c169317a`。三个正式版本均拒绝并发启动，断开后余 0。 |
| 08 | Pi 丢失历史后恢复为空会话 | 部分 | 测过的 1.0.2／1.5.2／1.6.0 均拒绝。最低接受版本 0.85.1 使用自定义 `PI_CODING_AGENT_DIR` 仍返回同 ID 的空 `active`。另见同 ID 并发恢复问题。 |
| 09 | Pi 配置热换中断原生后台回合 | 已修 | `49c169317a`。可控 native-running 状态下更换指令被拒，当前进程未被杀。 |
| 10 | OMP 普通供应商失败仍显示成功 | 部分 | `9bf9bfbe22` 接入结构化错误钩子。18.22.2 和 19.1.0 均仍将合成 HTTP 400 投影为助手文本加 `end_turn`，Cognia 得到 `done.success=true`。 |
| 11 | OMP steering 的 `promptRequired` 被误判为无效响应 | 已修 | `87f7b294b1`。两版原生回复被处理为没有可投递回合，Chat 保存失败的输入记录，尝试投递后不走自动重发。 |
| 12 | Pi 认证版本与双语指南冲突 | 已修 | `49c169317a`。双语指南与适配器均为 1.0.2／0.85.1。通用目录使用另一版本来源的问题见 V19。 |
| 13 | OMP ACP 版本认证矩阵 | 部分 | `9bf9bfbe22` 加 18.22.2 和 `>=18.22.2 <19.0.0`。没有覆盖最新 19.1.0、Linux 或完整产品 Host。 |
| 14 | 两者缺托管安装 | 开放 | 系统预设仍依赖目标 Host 的可执行文件，运行时目录 `distributions` 为空。Pi 的 Full Runner pin 仅属于对应镜像。 |
| 15 | OMP 缺账号和就绪诊断 | 部分 | `71d013f769` 增加桌面/移动 UI 卡，显示命令、协商版本、认证方法、模型和最近运行。真实登录及模型验证未跑，#10 可把失败运行映射成首轮已验证。 |
| 16 | OMP 当前配对端缺 ACP terminal | 部分 | 已在设置说明并在启动前明确拒绝。当前配对 Web／移动 transport 仍无相应端口。 |
| 17 | OMP 强制逐工具审批 | 部分 | 已在设置说明并拒绝 `requireApprovalFor`。原生预批准动作的实际中介能力仍缺。 |
| 18 | OMP compaction 和厂商扩展 | 部分 | `9bf9bfbe22` 增加 `_omp/compaction/start|end` 状态投影，有合成 wire 回归；其余原生扩展和断线收尾待验收。 |
| 19 | OMP 原生会话与迁移 | 部分 | `2e6cfd4e4c` 增加历史导入、目录和迁移注册。两个实测版本有 list/load/resume/fork/close，均未宣告 delete。 |
| 20 | OMP 原生系统指令层级 | 开放 | ACP 下仍通过普通 prompt 上下文传递 Cognia 系统指令。Pi 可在启动时经扩展注入原生系统指令。 |
| 21 | OMP 缺 Gateway 模型配方 | 已修 | `3a0483583b` 注册模型配方并接 CLI / sandboxd；配置与 CLI 回归通过。真实 Gateway 账号出站尚未验收。 |
| 22 | OMP 原生 RPC 高级能力缺产品入口 | 开放 | 独立包有原生队列、子 Agent、goal/todo、handoff、voice、host tool/URI。生产 Host 准入和运行入口仍未接入。 |
| 23 | Pi 子 Agent 与 MCP 边界 | 开放 | 子 Agent 模型控制仍依赖已适配的扩展和 Gateway 入口。Pi MCP 桥处理 stdio／HTTP／SSE，拒绝 ACP-channel MCP。 |
| 24 | 两者 Windows 本地运行 | 开放 | 产品目录仍声明 macOS/Linux 且要求沙箱。配对运行取决于承载端能力，OMP 的当期配对限制见 #16。 |

### 剩余问题与优先级

1. **优先处理 Pi 回合归属和会话恢复。** 回收过程清掉旧订阅，但新进程复用 `<配置 ID>:<会话 ID>`。注入探针在第二轮发出后交付同 ID 的延迟帧，第二轮收到上一代文本并被旧 `agent_settled` 结束。Rust 独立 stdout 任务未与退出确认联结，CLI 的 kill 等待 `exit`，生产传输的实际串轮未复现。另一个原生探针用真实 Pi 1.0.2、真实 CLI 历史扫描和注入 Host 时序复现并发双失败。持久化检查 await 发生在写入重启锁之前，两条恢复同时创建同一个进程 ID。两者分别要求进程代际归属和查找至启动全段的同 ID 串行化。0.85.1 的自定义目录用真正原生二进制仍能恢复空会话，需把有效状态目录纳入旧版本的历史判定。 [Pi 恢复](../../packages/agent-pi/src/rpc-client.ts#L867) · [进程启动](../../packages/agent-pi/src/rpc-client.ts#L1059) · [Rust stdout](../../crates/cognia-external-agent/src/process.rs#L657) · [CLI kill](../../cli/src/runtime/external/node-backend.ts#L830)
2. **优先修复 OMP 假成功。** 两个原生版本在 HTTP 400 夹具中都没有提供结构化错误。适配器的预留钩子无法触发，设置卡依据最近运行的成功状态可能显示首轮已验证。定位并验证可协商的失败信号，以同一故障夹具验收运行终态和诊断状态。 [OMP terminal hook](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L35) · [OMP 就绪卡](../../components/settings/agent/omp-status-card.tsx#L142)
3. **统一安装和认证。** 直接给通用评估函数传真实版本串，Pi 1.0.2 得到 `supported-uncertified`，因为 Pi manifest 没有传递认证范围。OMP 18.22.2 得到 `certified`，19.1.0 得到 `unsupported`。原生 ACP 探针在 19.1.0 的基础能力通过。这是升级候选证据，完整 Host、真实账号以及供应商错误映射仍欠验证。设置还需要区分安装状态、兼容性、当前账号、模型及实际能否运行。 [Pi manifest](../../packages/agent-pi/src/manifest.ts#L38) · [通用版本评估](../../packages/agent-runtime-kit/src/lifecycle/runtime-version.ts#L284)
4. **按使用场景补 OMP。** 优先核对配对终端和工具审批的实际覆盖，再补指令层级及会话体验。原生 RPC 的子 Agent 控制、队列和 handoff 需要生产 Host 的账号隔离、受信扩展与运行期出站/进程组约束验收。

### 同类产品对照

| 参考 | 可检验的差距 |
| -- | -- |
| Zed 和 ACP Registry 的安装、Agent 原生认证和既有线程导入 | Cognia 已有两者的历史导入和 OMP 诊断入口。系统预设安装仍依赖用户；统一目标 Host 上的检测、可信安装、版本确认、登录、模型验证与首轮结果。 [Zed External Agents](https://zed.dev/docs/ai/external-agents) · [ACP Registry](https://agentclientprotocol.com/get-started/registry) |
| ACP 的能力协商、权限请求与 OpenCode 的动作/资源权限 | 保留 Cognia OMP 缺 Host 端口或强制审批不可执行时的拒绝。要开放对应能力，实际工具及终端动作需要受同一权限边界约束。以调用层的 ask／allow／deny 和资源范围验收。 [ACP Initialization](https://agentclientprotocol.com/protocol/v1/initialization) · [ACP Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) · [OpenCode Permissions](https://opencode.ai/docs/permissions/) |
| Pi RPC 的命令响应相关性与 session 事件，OMP RPC 的 prompt 结果与 session settled，ACP 的逐轮用量与会话占用 | 产品应能单独验证请求送达、运行终态、后台静止、进程回收和输出所有权。OMP 会话占用和逐轮实耗应沿不同语义传递，失败必须有可解释的结构化结果。 [Pi RPC](https://docs.pi.dev/latest/rpc) · [OMP RPC](https://github.com/can1357/oh-my-pi/blob/v19.1.0/docs/rpc.md) · [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) |

### 复跑记录

- `pnpm test --runInBand` 的第一组覆盖 Pi、OMP 独立包、ACP、runtime-kit、Manager、Gateway 和导入，39 套件 1692 项通过。第二组覆盖 OMP 诊断 UI（桌面/移动组件）、生态与导入注册，5 套件 143 项通过。Manager 的既有 Gateway mock 清理日志和 jsdom `act(...)` 警告不影响本轮退出码。
- `pnpm audit:agent-capabilities`、`pnpm audit:external-agent-runtimes`、`pnpm pi:extension:pin:check` 均退出 0。目录检查通过并不验证实机主版本或所有业务能力。
- 现有缓存探针复制到 `.cache/pi-omp-support-audit/recheck-*.ts` 并反转修复断言。用 `node_modules/.bin/tsx` 执行。 `recheck-native.ts` 接受 `pi-faults`、`pi <binary>` 或 `omp <binary>`。`recheck-pi.ts`、`recheck-pi-legacy.ts` 接受 `pi <binary> <capacity|disconnect|missing-resume>`。`recheck-pi-resume-race.ts` 接受 `pi <binary>`。`recheck-pi-turn.ts` 使用注入 Host。`recheck-omp.ts` 接受名为 `omp` 的官方二进制路径。新制品和旧版的 OMP 启动链接放在 `.cache/pi-omp-support-audit/recheck-2026-11-22/`。
- 验证范围为适配器和注入 Host，不涉及用户 HOME、真实账号或供应商账单。合成用量走到 ACP adapter 的 done；共享 tracker 和 Manager 由现有测试验证。生产 Tauri／CLI、Linux、真实配对端、真实供应商登录／审批与发布镜像继续保留在 V6／V14。

## 2026-11-22 对抗性审查

同一基线 `86c188cba482`。三位独立审查者分别检查 Pi 生命周期、OMP ACP 与 Gateway、OMP 历史与迁移。对照前一轮结论重新核对生产调用链。用户选择仅使用本地证据。下表中的 A 编号属于本轮。P1 优先处理错误授权、重复执行、错误终态和用户上下文错用。P2 指配置或会话组合下的主要功能缺陷。P3 指较局部的表示和诊断缺陷。

| ID | 优先级 | 问题与证据 |
| -- | -- | -- |
| A01 | P1 | **OMP Plan 在缺少表单交互时可能自动通过。** Cognia 允许配置关闭表单能力，仍可选择 Plan。18.22.2 的上游分支会直接批准提案并离开 Plan。已核对握手能力和上游源码，生产文件/终端动作未执行。 [客户端协商](../../packages/agent-acp/src/client.ts#L1087) · [上游确认逻辑](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/modes/acp/acp-agent.ts#L2719) |
| A02 | P1 | **Pi 已 ACK 的 prompt 在 Manager 超时后被重发。** 实际 Manager 与 Pi adapter 加注入 Host，首发已收到 started ACK，未产生可见输出，外层 deadline 先失败并发起取消，随后同一 prompt 被写两次，调用最终成功。原来的 adapter uncertain 错误测试只覆盖错误已带标记的路径。 [Manager deadline 与 retry](../../lib/ai/agent/external/manager.ts#L5583) |
| A03 | P1 | **Pi 同进程后台结算可以提前结束前台。** 后台 settled 先清运行标记，统计 ACK 延迟时可进入下一个前台 prompt。旧 done 归给新 prompt，探针实际返回空的成功结果，真正前台输出随后去了会话订阅。 [settled](../../packages/agent-pi/src/rpc-client.ts#L1805) · [路由](../../packages/agent-pi/src/rpc-client.ts#L2086) |
| A04 | P1 | **Pi 重绑后仍接受旧进程迟到帧。** 恢复前的晚到帧被丢弃，恢复后复用进程 ID 时，探针将旧文本和 settle 投给新回合。生产 Tauri／CLI 的实际频率待实机验收。 [进程 ID](../../packages/agent-pi/src/rpc-client.ts#L1063) |
| A05 | P1 | **Pi 缺失历史在普通执行中会被静默替换。** `execute` 与 `executeStreaming` 的可控夹具都证明，adapter 返回类型化缺历史错误后，Manager 新建会话并把当前输入发给它。已验证的路由不包含独立 Gateway 作业。 [普通 Manager 恢复](../../lib/ai/agent/external/manager.ts#L3989) |
| A06 | P1 | **Pi 同 ID 恢复、启动和关闭的边界未串行化。** 已保存会话用真实 Pi 1.0.2 重跑，串行通过、并发双失败。拒重号的另一注入 Host 看到三次 spawn 尝试和一次抢占。单独 close 在同步历史检查完成前返回，随后会话仍可启动。 [恢复登记](../../packages/agent-pi/src/rpc-client.ts#L893) · [关闭](../../packages/agent-pi/src/rpc-client.ts#L1578) |
| A07 | P1 | **OMP 将供应商错误记为成功。** 18.22.2 与 19.1.0 的真实进程均把合成 HTTP 400 发作助手文本和 `end_turn`，Cognia 本轮记录为成功，可能造成任务误判和首轮假验证。无需调用模型的本地命令也会产生成功终态，不能单凭该信号证明模型可用。 [回合终态](../../packages/agent-acp/src/client.ts#L3126) |
| A08 | P1 | **OMP 的 `/clear` 前内容进入导入后的续聊种子。** 合成 JSONL 探针观测到 reset 前后两条都进入 `branchSeed`，无对应损失。上游在重放模型上下文时遵循清除边界，完整历史仍可用于导出。 [导入续聊种子](../../lib/session-import/index.ts#L280) · [上游上下文](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/session/session-context.ts#L507-L526) |
| A09 | P2 | **Pi 普通 Chat 重启后没有原生续接。** 数据库写了会话 ID，下一次普通本地发送只查活会话、内存链接或经过验证的导入；正常持久化链接不参与。这条源码路径会用会话摘要并新建 native ID。未运行桌面重启。 [发送参数](../../hooks/chat/agent-chat-external-turn.ts#L1416) · [内存持久化](../../stores/agent/agent-runtime-store.ts#L180) |
| A10 | P2 | **Pi 被 LRU 回收后，Manager 仍复用已关闭的会话。** 实际 Manager 和 Pi adapter 的注入测试中，稳定配置的下一轮得到 `Unknown Pi session`，未触发恢复。 [Manager 缓存读取](../../lib/ai/agent/external/manager.ts#L3919) · [Pi LRU](../../packages/agent-pi/src/rpc-client.ts#L1559) |
| A11 | P2 | **Pi 的缺历史判定在兼容路径上失真。** 0.85.1 使用自定义状态目录仍返回同 ID 的空 active；Node 和 Rust 列表也会把不可读目录或非法 header 过滤掉，适配器收到空数组后当作不存在。前者真实二进制已复现，后者为代码追踪。 [历史检查](../../packages/agent-pi/src/rpc-client.ts#L891) · [CLI 扫描](../../cli/src/agent/tool-host/pi-sessions.ts#L128) |
| A12 | P2 | **ADR 的每 Host 四进程在实现中按配置计数。** 两个 Pi 配置共用注入 Host，合计同时启动了 8 个。现有产品约定若确实采用每配置限额，ADR 与 Host 总量治理仍有差异。 [ADR-0119](../content/docs/en/adr/0119-pi-native-rpc-integration.md#decision) · [适配器计数](../../packages/agent-pi/src/rpc-client.ts#L1550) |
| A13 | P2 | **Node Host 对重复进程 ID 的处理有独立缺口。** 预检查跨越异步准备，注册可被覆盖；冲突消息还未匹配回收与类型化识别。源码证据，未执行生产 Node 双子进程。 [Node 预检查](../../cli/src/runtime/external/node-backend.ts#L596) · [回收判断](../../packages/agent-runtime-kit/src/spawn-reclaim.ts#L30) |
| A14 | P2 | **OMP Plan 退出后，界面显示 Default，Host 仍按 Plan 拒绝。** 注入原生模式与配置更新，实际 ACP 审批判定从正常允许变为拒绝，公开会话模式是 default。 [模式状态](../../packages/agent-acp/src/client.ts#L1701) |
| A15 | P2 | **OMP 认证和 Gateway 就绪有误判。** 可选方式列表被解释为需要登录，即使已有凭证。Gateway 首轮快照写在临时配置，设置卡读取保存配置，实际成功仍可显示未运行。第一条有 ACP 探针，第二条有调用链。 [认证判断](../../packages/agent-acp/src/client.ts#L2052) · [Gateway 作业](../../lib/ai/agent/external/manager.ts#L5296) · [设置卡](../../components/settings/agent/omp-status-card.tsx#L33) |
| A16 | P2 | **Pi 与 OMP 版本判定在目录和实际连接间分裂。** Pi 1.0.2 在适配器为 certified、通用目录为未认证。OMP 普通握手接受目录不支持的 18.22.1／19.0.0、未确认的 18.23.0，19.1.0 也有真实适配器证据。这些结果属于各自测试入口，生产设置的安装/同意流程未驱动。 [Pi 目录](../../packages/agent-pi/src/manifest.ts#L38) · [OMP 目录](../../protocol/external-agent-runtimes.json#L783) · [ACP 握手](../../packages/agent-acp/src/client.ts#L1841) |
| A17 | P2 | **OMP 导入可选错主分支，分支恢复缺 leaf 身份。** 导入忽略原生 activeLeafId，按结构叶子时间排序。探针把放弃的答复当主线程。主、分支虽保存为不同 Cognia 记录，恢复绑定同一 native ID 且不带 leaf。 [DAG 投影](../../lib/session-import/adapters/oh-my-pi.ts#L157) · [恢复绑定](../../lib/session-import/adapters/oh-my-pi.ts#L485) · [上游分支语义](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/session/session-entries.ts#L347-L356) |
| A18 | P2 | **OMP 扫描漏掉 XDG 历史，并会误选默认 profile。** 迁移后 XDG 路径原生有效，合成扫描用当前 resolver 得到 0 条、目标目录得到 1 条。显式 default 也被错误替换为较低优先级的 Pi profile。 [TS 目录](../../lib/agent-roots/index.ts#L125) · [Rust 目录](../../crates/cognia-agents/src/paths.rs#L239) · [上游目录](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/utils/src/dirs.ts#L355-L399) |
| A19 | P2 | **Pi／OMP 历史来源可被误判或重复列出。** 普通路径中有 OMP 标记的合成文件同时被两者认出，自动选择归给 Pi。共用显式目录时，原生 Pi 文件可被两套扫描同时列出。 [来源解析](../../lib/session-import/index.ts#L43) · [OMP 扫描](../../lib/session-import/adapters/oh-my-pi.ts#L597) |
| A20 | P2 | **OMP 外置图片被拼成无效 data URL。** 合法上游 blob 引用未解析，导入将引用当 base64 正文。合成夹具验证失效，并且损失提示只泛称内联正文省略。 [图片导入](../../lib/session-import/adapters/oh-my-pi.ts#L317) |
| A21 | P2 | **OMP 扩展消息的显示与角色丢失。** 隐藏 custom_message 被列为用户发言；另一种原生 custom 消息计入摘要但导入时丢失。合成夹具得到摘要 3、实际 2。 [消息投影](../../lib/session-import/adapters/oh-my-pi.ts#L260) · [上游显示约定](https://github.com/can1357/oh-my-pi/blob/v18.22.2/packages/coding-agent/src/session/session-entries.ts#L307-L325) |
| A22 | P2 | **默认桌面 OMP 安装可能被迁移向导隐藏。** OMP 配置 probe 固定显示缺失，通用文件 API 在默认 scope 下不可读取外部根时，向导将其判作未安装。原生历史扫描另走独立接口。源码证据，未运行 Tauri UI。 [迁移判定](../../lib/agent-migration/probe.ts#L17) · [Tauri 文件权限](../../src-tauri/capabilities/default.json#L36) |
| A23 | P2 | **取消或拒答会把 OMP 整个配置显示为 Blocked。** 当前远程 Agent 仍保持连接，Manager 把单轮取消／拒答的失败覆盖为配置级 executable=false，设置就绪会优先读到它。 [Manager](../../lib/ai/agent/external/manager.ts#L5067) · [就绪状态](../../lib/ai/agent/external/agent-readiness.ts#L75) |
| A24 | P3 | **OMP 导入会生成空会话，并把续接标为 fork。** 两种合成合法形态分别产生零消息且无损失的记录，以及错标关系。额外工作目录也未保留。 [摘要](../../lib/session-import/adapters/oh-my-pi.ts#L406) · [关系](../../lib/session-import/adapters/oh-my-pi.ts#L383) |
| A25 | P3 | **OMP 压缩事件已投影，界面仍只显示计数。** 外部 Agent 面板把更新变成 activity 数字，用户无法在该面板区分开始、失败、完成。 [诊断面板](../../components/agent/external-agent/diagnostics-panel.tsx#L282) |

### 复核通过的反向对照

- 既有六套定向 Jest 共 1011 项通过。定向范围包含 Pi/ACP 适配器、Manager、OMP Gateway、历史导入与设置卡。临时 Manager 用例证明存在重复写入、静默新建和 LRU 后失败，未向产品源码或长期测试添加改动。
- Pi 原来的 ACK timeout 标记、退役后未重新绑定的帧拦截仍有效。每适配器四进程上限和单次启动与 disconnect 的基本回归仍成立。A02、A03、A04、A06 覆盖额外时序。
- 官方 OMP 18.22.2 和 19.1.0 真实 ACP 进程下，原生 Plan 基础映射、逐轮用量 12／12／12、steering 未送达语义保持通过。原生 Gateway 配方也分别用合成租约和 loopback 模型发出有效请求并得到 12 tokens。A01、A14 补充的是 Plan 确认及后续状态。Gateway 生产租约和配置就绪仍有独立验收义务。
- 导入探针为 `.cache/omp-history-review-good/probe.ts`。证据脚本使用合成历史、测试路径和测试租约，未读用户会话、触碰真实账号或调用真实供应商。本轮外部参照来自固定版上游公开合同。
