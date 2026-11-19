# Cognia Agents 与 Squads 能力审计

- Status: verifying
- Lane: deep
- Created: 2026-11-18
- Updated: 2026-11-18
- Related: [ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md), [收敛实施台账](2026-11-05-multi-agent-convergence.md), [Handoff 与派发审计](2026-11-17-handoff-task-dispatch-gap-audit.md)

## Original request

> [$evidence-driven-dev](/Users/bytedance/Project/cognia-next/.agents/skills/evidence-driven-dev/SKILL.md) 帮我分析一下Agents模式和Agent Team等类似概念，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

## Knowledge

| ID  | Statement                                                                                                                                                | State       | Basis                                                                                                                                                                          | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| G1  | 识别 Cognia 已有的 Agent 能力、实际缺陷与功能缺口，并给出业内对照和优先级。                                                                              | Agreed      | 用户原始请求，2026-11-18。                                                                                                                                                     | -          |
| C1  | 审计当前共享 worktree，以 `93b7406a3c11005eea8209f8c8950a6e57e66864` 为基线，保留并行工作。                                                              | Verified    | `git rev-parse HEAD`、按路径核对工作树差异，2026-11-18。涉及 `build-options.ts` 与 `agent-chat-send.ts` 的相关分支已检查差异。                                                 | -          |
| H1  | Cognia 需要先增加一套多 Agent 编排引擎。                                                                                                                 | Invalidated | 当前已有可达的单轮子运行、Squad DAG、审批、委派、候选执行与工作区集成。对应用户问题的首批动作可复用已有执行面。                                                                | -          |
| H2  | 优先缺口在入口的执行承诺、队内交付以及中断后的恢复。                                                                                                     | Verified    | F01–F10 的仓内证据及离线检查，2026-11-18。                                                                                                                                     | O1, O2, O3 |
| O1  | 当前入口拆分为 Agent 定义、会话配置、执行方式及运行控制。                                                                                                | Verified    | `app/agents/page.tsx:5`、`lib/agent/composition/turn-agent-mode.ts:115`、`lib/agent/composition/chat-orchestrations.ts:40`、`app/agent-teams/page.tsx:31`。                    | -          |
| O2  | Squad 的任务依赖、控制、审批和工作区已有生产调用路径。                                                                                                   | Verified    | `lib/squads/squad/start-squad-run.ts:396`、`lib/squads/agent-team-runtime.ts:1140`、`lib/squads/teammate/dispatch-teammate.ts:1314`、`lib/squads/gates/squad-review-gate.ts`。 | -          |
| O3  | 存在取消任务仍进入 DAG、预算状态重建、控制回执与结果补投等契约断点。                                                                                     | Verified    | F02–F06 的本地组件探针和生产路径核对。                                                                                                                                         | -          |
| O4  | 独立 verifier 的候选 Host 判断与浏览器传输实现分歧。                                                                                                     | Verified    | `lib/agent/composition/verified-fresh-agent.ts:434`、`lib/tauri/transport-instance.ts:27` 和 WebStubTransport 探针。                                                           | -          |
| O5  | 既有闭卷研究评估中，单 Agent 平均分更高，且求解器 token 与耗时更少。                                                                                     | Observed    | [2026-10-25 评测](../reports/2026-10-25-multiagentbench-research-100.md#results) 的 100 个任务记录。                                                                           | -          |
| O6  | Claude Code 团队实验功能提供任务自领取、成员消息和人工直达，LangGraph 给出 checkpoint 与中断重放语义，OpenAI Agents SDK 区分子代理工具与会话控制权接管。 | Verified    | 2026-11-18 阅读文末所列官方资料。                                                                                                                                              | -          |
| Q1  | 真机多端与第三方运行时上，控制、审批、计量和回传可重复通过的组合有哪些？                                                                                 | Open        | 当前源证据和离线测试。需要真实 Host、配对设备、运行时及许可。                                                                                                                  | -          |
| Q2  | 哪些用户任务的成功率提升足以支付并发团队的成本？                                                                                                         | Open        | 历史评估只覆盖固定角色的闭卷研究。                                                                                                                                             | O5         |
| O7  | 重点覆盖采样完成，22 文件中 12 文件三项达到 90%。                                                                                                        | Verified    | Jest 37 suites / 657 tests，V8 JSON/LCOV，2026-11-18，`d861ef61c4b6`。                                                                                                         | -          |
| O8  | 若干高覆盖文件未保护启动接线、安装时序或跨模块的真实结果。                                                                                               | Verified    | 测试断言与生产入口对照，见测试覆盖复查。                                                                                                                                       | O7         |
| O9  | 选定的 15 个 Squad 相关 Playwright 用例均不进入当前 PR tag filter。                                                                                      | Verified    | 同路径同项目的有/无 `--grep` discovery，2026-11-18。                                                                                                                           | -          |

## Problem frame

审计范围包括 `/agents`、聊天 Agent Mode、显式及隐式 Subagent、持久 Squad、Room、Delegation、Workflow、验收型多 Agent 与外部 Runtime。沿入口 → 配置解析 → 启动 → 运行控制 → 结果回传逐一核对。预期交付是可复核的能力地图、重点缺陷、业内对照及后续验收条件（G1、M1）。真实端到端适用范围和质量提升分别记录于 M2、M3。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                |
| ------------ | ------ | -------------------------------------------------------------------------- |
| scale        | high   | 产品入口横跨 Composer、Squads、Agent Runs、IM、CLI 和 Host。               |
| technical    | high   | 区分项目定义、有效策略、引擎可收敛状态、预算预留与停机证明。               |
| coupling     | high   | 同一运行在聊天、看板、远端协调器上有不同记录和投影。                       |
| requirement  | medium | 当前目标是审计。平权团队、默认路由阈值与可接受成本属于未来产品决策。       |
| verification | high   | 纯逻辑可离线验证，配对权限、远端进程终止和真实供应商计费需现场验证。       |
| risk         | high   | 取消、审批、预算或作用域偏差会影响文件写入、外部动作、跨队数据边界和计费。 |

## Risks

| ID  | Risk (impact)                                                    | Severity | Source                                               | Claim                                                      | Refuted by                                                           |
| --- | ---------------------------------------------------------------- | -------- | ---------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| R1  | 用户选择的 Agent 与实际执行身份分歧。                            | high     | ADR-0117、Claude Code Subagents、独立入口追踪。      | 有效目标与 UI 一致，缺少能力时出现明确诊断。               | 同名目标解析分歧、显式目标被静默丢弃或 verifier 选项可选但无法执行。 |
| R2  | 看板、成员和团队控制与调度失配，继续执行被取消的工作或漏掉改令。 | high     | ADR-0066、ADR-0169、STPA、fresh review。             | 调度前采用最新任务状态，控制回执代表实际接收状态。         | 取消任务进入调度，或 0 份回执仍被上层显示已接受。                    |
| R3  | 续跑重置预算、批准后卡死或已完成结果未回传。                     | high     | ADR-0243、ADR-0252、故障注入视角、fresh review。     | 续跑沿用同一治理状态，等待审批可继续，已落盘结果最终送达。 | 预算/额度丢失、剩余 DAG 停在零并发、重启后缺少 outbox 记录。         |
| R4  | Squad 工具的任务读写越出队伍边界。                               | high     | STRIDE、ADR-0243 主体与授权原则。                    | Host 侧检查调用者 Squad 与目标任务归属。                   | 路径在全局任务映射读写时只使用 taskId，且找不到独立的同队约束。      |
| R5  | 缺少质量增益证据时默认扩大团队使用，增加成本、时延与重复工作。   | medium   | Anthropic Research、历史 MultiAgentBench、比较评测。 | 使用多 Agent 能提高特定任务验收率或改善成本/时延边界。     | 在同模型与可比预算下，实际任务成功率没有改善。                       |

## Verification obligations

| ID  | Risk           | Method                                                                    | Independence   | Evidence                                                                                                                                 | Coverage                                                                                                       | Status  |
| --- | -------------- | ------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2, R3     | 仓内执行链路与现有 Jest 合同检查。                                        | tool           | 两组共 24 suites / 474 tests 通过。另有 18 个配置装配筛选用例通过，请见验证记录。                                                        | 状态机、launcher、mode resolver、团队工具、预算 rail、审批/恢复和 Handoff。在本地 mock、内存或测试 DB 中运行。 | passed  |
| V2  | R1, R2, R3     | 独立路径追踪及无外部调用的反例探针。                                      | fresh-reviewer | 两路专项审查及离线探针。取消仍生成 dispatch 节点，预算重建归零，批准补额后仍为零并发，WebStubTransport 拒绝 verifier 依赖的 agent_send。 | 生产路径以静态读取定位，隔离探针执行真实纯模块。没有启动模型、子进程或设备。                                   | passed  |
| V3  | R4             | 独立核对 runtime 调用者身份、任务读取和评论写入。                         | fresh-reviewer | 两条按 ID 处理的生产路径缺少队伍归属检查。独立复核确认现有可见性过滤隐藏未证明来源的读取正文，Companion 评论有单独的归属检查。           | 结构性约束缺口。实际暴露范围受可见数据、运行时和配置约束。                                                     | passed  |
| V4  | R2, R3, R4     | 桌面与 paired 二端在真实 Host/Worker 验证停止、恢复、拒绝跨队访问及回传。 | real-env       | 本轮使用仓内和离线证据。                                                                                                                 | 含断线、重复响应、待审重启、进程丢失和两个队伍并发。                                                           | planned |
| V5  | R5             | 查对官方资料与历史实验口径。                                              | self           | 2026-11-18 读取官方文档及 100 个闭卷任务的既有报告。                                                                                     | 有效区分团队、委派、接管与 Workflow。质量数字仅限历史赛道。                                                    | passed  |
| V6  | R5             | 代表性真实任务对照与质量验收。                                            | real-env       | 已给出控制变量与验收指标。                                                                                                               | 并行研究、代码交付、跨 Host 工作区和需要人工批准的任务。                                                       | planned |
| V7  | R2, R3         | 运行完整 Squad 生命周期 Jest suite。                                      | tool           | 与补充套件同批启动后约 5 分钟无结论，终止该次运行。                                                                                      | 未得到该完整 suite 的通过或失败结果。两个已完成的重点测试批次单独记录。                                        | blocked |
| V8  | R1, R2, R3, R4 | 样本覆盖率与行为断言交叉核对。                                            | tool           | 37 suites / 657 tests 通过。V8 行 87.36%、分支 80.80%、函数 84.75%。各模块路径和断言见复查。                                             | 22 个选定 TS/TSX 文件、指定 Jest suites，局部采样。                                                            | passed  |
| V9  | R1, R2, R3     | Playwright 发现和 E2E 治理检查。                                          | tool           | Chromium 7、Pixel 7 8；PR tag 筛选为 0。治理检查通过，14 条已登记例外。                                                                  | 五个 Squad 控台、mobile 远端启动、Workflow 节点 spec，不代表全仓或完整运行。                                   | passed  |
| V10 | R2, R3         | 重跑完整 Squad 生命周期并隔离重点用例。                                   | tool           | 全 suite 65 秒无汇总。筛选后四个已存在的完成场景均失败，随后存在未退出的异步操作。                                                       | Jest 环境及既有 fixture。                                                                                      | failed  |
| V11 | R2, R3         | Chromium 控台目标用例运行。                                               | tool           | 进程到达 `/squads`；首例初始化超时，日志有 Dexie 阻塞，第二例在外部预算处中断。                                                          | 当前源码 dev boot；seeded browser fixture。                                                                    | blocked |

## Decisions

| ID  | Date       | Decision                                                                                       | Action   | Based on       | Reversal trigger                                         |
| --- | ---------- | ---------------------------------------------------------------------------------------------- | -------- | -------------- | -------------------------------------------------------- |
| D1  | 2026-11-18 | 沿现有运行链路完成能力审计，关联已有收敛计划与 Handoff 审计。                                  | diagnose | G1, C1, O1, O2 | 新路径改变当前入口或运行所有权。                         |
| D2  | 2026-11-18 | 优先修正任务作用域、调度、治理和交付语义，继而补足有效配置、成员协作与路由。                   | diagnose | H2, O3, O4, O6 | 真实环境证据或路径修复改变问题的触发条件和影响范围。     |
| D3  | 2026-11-18 | 将多 Agent 的默认范围由任务对照评估决定。                                                      | diagnose | O5, O6         | 代表性任务的验收率、成本或时延显示可重复的收益。         |
| D4  | 2026-11-18 | 将行覆盖结果同边界断言逐条核对。先修生命周期及浏览器验证入口，再补足高风险行为并选入 PR gate。 | diagnose | O7, O8, O9     | 生命周期和浏览器测试恢复，新回归断言被当前 CI 实际发现。 |

## Residual risks

| ID  | Residual                                                     | From   | Why still open                                         | Next action                                                                                        | Status |
| --- | ------------------------------------------------------------ | ------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------ |
| X1  | 真实进程停机、审批恢复、授权与投递的跨端验收。               | V4, Q1 | 当前只有源码、离线检查及已有套件。                     | 使用一次性工作区及受控 Host、Worker 和配对设备验证故障矩阵。                                       | open   |
| X2  | 多 Agent 的净收益、适用任务与默认切换阈值。                  | V6, Q2 | 历史闭卷研究报告无法衡量真实工具、代码交付与对等协作。 | 固定模型与预算，按任务分层比较真实验收结果。                                                       | open   |
| X3  | 完整 Squad integrated lifecycle 套件缺少执行结论。           | V7     | 该批次挂起后终止。                                     | 修复环节分别隔离生命周期用例并定位挂起条件。                                                       | open   |
| X4  | 重点 lifecycle 用例失败且 runner 留有未退出的异步操作。      | V10    | 既有期望未满足，见复查日志。                           | 修复工作区租约 fixture，并单独排查 Jest 异步退出。四个筛选用例已在只补齐模拟字段的缓存副本中通过。 | open   |
| X5  | Chromium 启动路由可达，真实测试 fixture 无法稳定完成初始化。 | V11    | 首例未越过 Dexie 数据准备。                            | 排查重复数据库连接，重跑当前静态产物上的控台路径。                                                 | open   |

## Outcome

| ID  | Signal                                               | How / when measured                                       | Result                                                    | Status  |
| --- | ---------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- | ------- |
| M1  | 能力地图、可追溯的发现、官方对照及优先级可供排期。   | 2026-11-18 审阅入口、运行时、测试及官方资料。             | 本文能力矩阵、F01–F12、分期验收。                         | met     |
| M2  | 真实 Host 上完成取消、改令、审批与重启后的安全交付。 | 修复后的代表性端到端故障注入。                            | 待验证。                                                  | pending |
| M3  | 异构任务上多 Agent 带来有成本约束的验收率改善。      | 固定任务/模型/预算的配对试验。                            | 待测。                                                    | pending |
| M4  | 量化现有样本覆盖并指出优先补齐的可观察结果。         | 2026-11-18 重点 Jest、E2E discovery、生产路径和现有断言。 | 已交付测试覆盖复查及可复现的报告，V10、V11 保留运行阻塞。 | met     |

## 结论

Cognia 已经有较完整的多 Agent 执行骨架，尤其是持久 Squad、工作区隔离、人工审批和主机控制。最值得先处理的差距集中在三个用户能感知的承诺。选中的 Agent 应该实际执行。取消和改令应当控制真正的工作。重启后应延续同一预算、审批和结果交付。

ADR-0252 的实体边界适合保留。Room 保存多人交流，Squad 执行带依赖的目标，Delegation 记录可以追踪的异步工作承诺。Chat 的 Mode、Agent 身份、运行时与编排方式各有独立职责。产品可以用一个执行方式选择器解释何时用谁，同时让运行中状态回到同一个控台。

## 能力地图

| 概念                                          | 对用户的作用                                                                                            | Cognia 当前实现                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents / Character                            | 保存可以反复使用的 Agent 身份、配置和运行绑定。                                                         | `/agents` 提供创建、详情、聊天与任务派发。外部 Runtime 是其可能的执行绑定。[Agents 入口](../../app/agents/page.tsx#L5) · [运行绑定](../../lib/agents/runtime-binding.ts#L67)                                                                                                                                                      |
| Agent Mode / Composition                      | 改变当前会话一轮的 prompt、默认工具及权限选择。                                                         | 会话级 preset、旧 mode 的模型等覆盖项、独立的编排轴。在聊天可直接选择的编排为 Direct、Squad 与独立复核。[Mode 解析](../../lib/agent/composition/turn-agent-mode.ts#L115) · [聊天编排](../../lib/agent/composition/chat-orchestrations.ts#L33)                                                                                     |
| Subagent / 显式 `@`                           | 主 Agent 可委派限定任务并接收结果。用户也可显式选择由指定 profile 执行当前一轮。                        | `dispatch_agent` 可接派发目标并进入子运行。Composer `@` 解析第一个匹配目标，入口的可选能力存在 F07 的差异。[目标解析](../../lib/chat/mentions/agent-targets.ts#L92) · [派发入口](../../lib/ai/agent/execution/delegation/dispatch-agent-handler.ts) · [子运行 launcher](../../lib/execution/launch-child-run.ts)                  |
| Agent Team / Squad                            | Lead 和成员围绕一个目标，分工、审查并交付。                                                             | 看板、依赖 DAG、成员池、工作区隔离、复核、预算治理、恢复和多 Host 绑定。旧 `/agent-teams` 重定向到 `/squads`，运行详情复用 Agent Runs。[入口](../../app/agent-teams/page.tsx#L24) · [调度](../../lib/squads/agent-team-runtime.ts#L1140) · [集成](../../lib/squads/workspace/integrate-team-run.ts)                               |
| Room / 群聊                                   | 多条身份可见的发言，以及人对话题、参与成员的干预。                                                      | Room runner 与共享房间有各自执行边界。成员可生成 Squad 提案，人确认后启动并把结果作为一条消息回到原 Room。详见 F05 的重启缺口。[ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md#4-a-room-hands-work-to-a-squad) · [确认入口](../../lib/squads/room-handoff/decide.ts#L204)              |
| Delegation / Handoff                          | 记录谁答应做什么、接收哪段上下文、何处追踪。                                                            | 子运行树和 Delegation 可以关联 Squad、后台 Agent、外部或 Twin。同步 `@` 的单轮目标选择、Room 的异步移交、SDK 中的当前发言权接管具有不同生命周期。[ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md#2-one-child-run-tree) · [Handoff 审计](2026-11-17-handoff-task-dispatch-gap-audit.md) |
| Workflow / Ultracode                          | Workflow 用显式步骤执行可复用流程。Ultracode 为 Squad 的复杂目标组装规划及验证。                        | Workflow 以 `/workflow` 等入口触发，可调用 Squad；Squad 有 flat、wave 和 Ultracode 路径。[编排可用性](../../lib/agent/composition/chat-orchestrations.ts#L46) · [Squad Workflow 适配](../../lib/squads/workflow-nodes/index.ts#L702) · [运行时分流](../../lib/squads/agent-team-runtime.ts#L1140)                                 |
| Best-of-N、Council、Ensemble、Router + Fusion | Best-of-N 对同一任务产生可比产物；Council/Ensemble 汇总回答或样本；Router + Fusion 决定路由及组合执行。 | Best-of-N 有候选选择、检查及发布，Council/Ensemble 有独立合成，Router + Fusion 含路由约束与决策记录。[候选发布](../../lib/best-of-n/publication.ts#L60) · [合成执行](../../lib/squads/auto/run-executor.ts#L72) · [路由](../../lib/router-fusion/chat/route-chat-turn.ts#L487)                                                    |
| External Agent / Worker                       | 选用外部引擎或执行主机。                                                                                | Squad 可以单独解析成员能力、Runtime、模型及 Worker 策略。真实可用性受引擎协商、配对状态、工作区及权限所限。[成员能力解析](../../lib/squads/teammate/capability-resolver.ts) · [Worker 策略](../../lib/squads/workers/remote-worker-policy.ts) · [启动就绪](../../lib/squads/squad-readiness.ts#L162)                              |

## 问题和功能缺口

### P1 控制、隔离和恢复

| ID  | 发现及影响                                                                                                                                                                                                                                        | 判定与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01 | **任务工具缺少同队归属核验。** `task_get` 按 ID 取任务和评论，`task_add_comment` 按 ID 追加评论。Host 已能解析调用者所属 Squad，应在读写前使用同一队伍作用域。                                                                                    | 独立源码复核确认。调用者绑定、workspace 隔离及 Companion 评论校验均存在。Agent 评论写入仍缺少同队核验。读取命中后经过 provenance 过滤，当前调用缺少可信来源时正文被替换为占位符，命中与缺失的响应仍不同。需要另行验证真实配置下的可见范围。[工具读写](../../lib/squads/collaboration-tools.ts#L584) · [个人可见性](../../lib/squads/collaboration-tools.ts#L710) · [评论存储](../../stores/squads/agent-team-store/slices/actions.slice.ts#L903) · [Companion 评论核验](../../lib/companion/agent-team-write-handlers.ts#L151) |
| F02 | **看板取消可以留下可调度任务。** 普通 flat 新运行读取全部状态，取消项进入 DAG。已生成的普通 DAG 也没有在 dispatch 前重新读取看板状态的判断。                                                                                                      | 纯模块探针复现 `allowed:true` 与 `action.team.task.dispatch`。真实 worker 尚未运行。重启恢复路径已有 `resumeTaskFilter`，会排除取消项。[看板规则](../../lib/squads/gates/task-move-guard.ts#L39) · [flat 任务读取](../../lib/squads/agent-team-runtime.ts#L398) · [dispatch 实现](../../lib/squads/workflow-nodes/index.ts#L191) · [恢复过滤](../../lib/squads/squad/squad-lifecycle-runner.ts#L118)                                                                                                                           |
| F03 | **治理预算设置与运行状态分歧。** Governance 保存自己的 token cap 与百分比阈值，运行时从 Overview 的 `team.config.tokenBudget` 取 cap，只读取 Governance 的临界动作，阈值采用默认值。重建同一 run 的局部 governor 时重置使用量，也未恢复批准扩额。 | 字段接线经源码核对，预算重建用纯模块探针确认。另有 ADR-0243 的 run-tree 预算 rail，断点针对 Squad 自身治理限额及审批，真实供应商账单未测。[治理输入](../../components/squads/settings/section-governance.tsx#L227) · [运行时创建](../../lib/squads/agent-team-runtime.ts#L825) · [默认值](../../lib/squads/gates/budget-guard.ts#L61) · [Run-tree ledger](2026-11-16-adr-0243-run-tree-budget-ledger.md)                                                                                                                       |
| F04 | **预算扩额、死锁解封后仍可能停在零并发。** 人工 gate 将并发降到 0，批准回调扩额或解封成员，控制器只支持向下调整。仍有节点且没有在途步骤时，普通 Workflow scheduler 会标记 `orchestration_stalled`。                                               | 纯模块探针确认扩额成功后 cap 仍为 0。失败分支由源码确认。实际审批及重启的端到端行为待验证。[预算 gate](../../lib/squads/agent-team-runtime.ts#L994) · [死锁 gate](../../lib/squads/gates/deadlock-gate.ts#L83) · [并发控制器](../../lib/workflow/runtime/concurrency-controller.ts#L11) · [调度失败分支](../../lib/workflow/runtime/orchestrator.ts#L1052)                                                                                                                                                                     |
| F05 | **Room → Squad 的结算补投缺少启动接线。** 初次确认后通过当前进程的 Promise 观察完成。如果进程在持久 outbox 写入前退出，Room 恢复只消费已经留下的条目。                                                                                            | `reconcileRoomHandoffs` 有测试，生产搜索只见声明。重复确认能恢复既有运行身份，已有 outbox 能继续投递。还应让结算结果绑定确切 attempt，现有补投用 Squad 最新结果和 60 秒时间邻近推断归属。[观察结算](../../lib/squads/room-handoff/settle.ts#L118) · [结果归属逻辑](../../lib/squads/room-handoff/settle.ts#L159) · [Room 启动投递](../../lib/background-tasks/runtime-room-lane.ts#L28) · [重复确认](../../lib/squads/room-handoff/decide.ts#L218)                                                                             |
| F06 | **改令回执成功语义过宽。** Run fan-out 尝试所有非终态孩子，子请求拒绝后被吸收。只要候选数大于 0，上层即返回 delivered，包含全部失败、0 条回执的情况。已排队的 receipt 也被折叠成 delivered。                                                      | 源码确认。coordinator 已能区分排队和送达，应在运行层保留，与 partial/rejected 一起表达。聊天收到 delivered 会认定已接受，跳过后备路径。[所有权 fan-out](../../lib/squads/durable/durable-control.ts#L502) · [上层状态](../../lib/execution/control-handlers.ts#L114) · [coordinator](../../packages/agent-orchestration/src/coordinator.ts#L840) · [聊天处理](../../hooks/chat/agent-chat-send.ts#L1086)                                                                                                                       |

### P2 入口、成员过程与路由

| ID  | 发现及影响                                                                                                                                                                                                                                                                                                                                                                            | 判定与证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F07 | **显式 `@Agent` 与实际执行身份可能不一致。** picker 包含专用 provider/外部 preset 的派发目标，直接聊天只注册 SDK 兼容 profile。最终 map 缺失目标时请求按普通聊天继续。项目 Markdown 同 ID 覆盖运行时定义，picker 却保留先注册的条目。Markdown 的 `hidden` 与 `disabled` 已被解析，GUI picker 和 SDK map 仍保留全部条目。CLI 会过滤 disabled，Cognia AI SDK 路径直接应用匹配 profile。 | 源码确认，核心路径与 HEAD 一致。派发专用目标已有独立 `dispatch_agent` 路径。Claude SDK 可应用指定 profile，AI SDK overlay 保留当前 provider 模型，外部和 standalone 路径需要各自给出支持理由。[picker 优先级](../../components/chat/composer/hooks/use-composer-mention-sources.ts#L53) · [两种 catalog](../../lib/agent/builtin-catalog/projection.ts#L165) · [最终映射](../../lib/claude/build-options.ts#L4763) · [AI SDK overlay](../../sidecar/src/runtimes/ai-sdk/index.ts#L254) · [Markdown 投影](../../lib/chat/mentions/markdown-agent-targets.ts#L33) · [CLI disabled 过滤](../../cli/src/agent/discover-agents.ts#L115) |
| F08 | **独立复核的可用性与生命周期存在断点。** `web-standalone` 被判可用，但 verifier 使用 Host capture，WebStubTransport 拒绝 `agent_send`。同时异步安装 watcher 若晚于原回合结算，会把回复归为已存在消息而跳过。                                                                                                                                                                          | WebStubTransport 探针复现 `no_host_transport`。已有 Jest 测试验证迟到时忽略旧回复，生产时序窗口通过源码串联推断。Companion 已有明确禁用原因。[可用性](../../lib/agent/composition/verified-fresh-agent.ts#L434) · [Watcher](../../lib/agent/composition/verified-fresh-agent.ts#L503) · [异步安装](../../hooks/chat/agent-chat-send.ts#L2627) · [Host 传输](../../lib/tauri/transport-instance.ts#L27)                                                                                                                                                                                                                             |
| F09 | **成员互发和自领取仍有实质缺口。** 已有 `team_send_message`、抗刷屏、共享记忆、任务评论、DAG 及池分配。该消息调用写入团队 store 后立即回成功，已核对的路径没有 receiver 消费/唤醒/确认。可直接逐成员 steer 已在 Durable Operations 存在。                                                                                                                                             | 源码路径与 repo 搜索。当前工具面也没有原子 self-claim 入口。成员间协调优先做带接收状态的 mailbox、代码外置的讨论证据，再评估是否开放自领取。[协作工具](../../lib/squads/collaboration-tools.ts#L739) · [池分配](../../lib/squads/teammate/teammate-pool.ts#L171) · [成员 steer](../../components/squads/durable-operations.tsx#L400)                                                                                                                                                                                                                                                                                               |
| F10 | **轻量路由没有充分减少建队开销。** 自动编排评估后继续编 roster 与分解 DAG，随后才决定 executor。`single_agent_recommended` 会映射 `single-send`，快速创建和批准 UI 仍物化 Squad。                                                                                                                                                                                                     | 源码确认。auto-compose 已可评估并预览，也有独立分析与委派执行分支。建议在用户确认的自动路由中先决定轻量路径，按需才调用建队模型。[评估及编队](../../lib/squads/auto/auto-orchestrate.ts#L115) · [executor 决策](../../lib/squads/auto/dispatch-executor.ts#L50) · [UI 路由](../../components/squads/auto-compose-dialog.tsx#L380)                                                                                                                                                                                                                                                                                                  |

### P3 配置复用与评估

| ID  | 缺口                                                                                                                                                                  | 当前证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F11 | **执行前的有效配置和跨端能力矩阵。** 展示实际引擎、模型、profile 来源、剩余权限、适用工具、工作位置、成本估计和拒绝/回退原因。在 GUI、TUI 与 Companion 解释配置来源。 | GUI app preset catalog 读取自定义和插件预设，CLI 本地 TUI 读取 filesystem JSON，SDK 定义调用可传 composition selection。直接探针确认 GUI 导出的 `{version,type,mode}` 会被 CLI 的根层 `name` schema 拒绝。[GUI catalog](../../lib/agent/composition/app-preset-catalog.ts#L31) · [GUI 导出](../../stores/agent/custom-mode-store/slices/actions.slice.ts#L210) · [CLI mode](../../cli/src/config/agent-mode.ts#L60) · [CLI 组装](../../cli/src/agent/session-context.ts#L315) |
| F12 | **用户验收任务与真实轨迹评测。** 给 Agent Runs 补齐相关的有效路由、回执、budget hold 与最终产物引用，并为多 Agent 的投入产出设立可复现对照。                          | 内部已有 MultiAgentBench、轨迹、子运行记录和 cockpit。旧研究评测的 communication 分数是文本/依赖载荷代理指标。真实成员间消息被接收及是否影响后续决策仍需测量。[历史评测及限制](../reports/2026-10-25-multiagentbench-research-100.md#2-communication-ratings-do-not-measure-observed-message-exchange) · [运行控台](../../components/agent-runs/run-detail-pane.tsx#L350)                                                                                                     |

## 业内对照

| 业内实践                                                                                                                                                       | 对 Cognia 的启发                                                                                                                      | 官方来源                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Code Agent Teams** 提供独立成员会话、共享任务清单、受锁保护的任务领取、成员直达和 hook 质量门禁。当前仍标实验，in-process 成员有恢复限制。            | Squad 的持久编排与工作区适合处理交付。优先补齐成员可确认的收件与人工改令、任务生命周期，然后决定是否需要对等自领取。                  | [Agent Teams](https://code.claude.com/docs/en/agent-teams)                                                                                                               |
| **Claude Code Subagents** 支持定义作用域、独立上下文、工具、模型、权限、前后台和子会话恢复。                                                                   | 为 Cognia 的显式选择展示实际目标及其可用能力，让用户知道自动委派与直接选择的上下文和生命周期。                                        | [Subagents](https://code.claude.com/docs/en/sub-agents)                                                                                                                  |
| **OpenAI Agents SDK** 区分 agents-as-tools、handoff 与应用代码编排。前者的主 Agent 汇总，handoff 的目标 Agent 接管该轮。Trace 带上模型、工具、handoff 与门禁。 | 在入口按结果所有权和是否跨轮区分调用、接管、后台交付。用一个 run trace 串联子任务、审批、投递、预算和产物。                           | [Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/) · [Tracing](https://openai.github.io/openai-agents-python/tracing/)                    |
| **LangGraph** 用 thread checkpoint 支持中断后继续，已定义清楚重入会重跑节点及副作用处理的语义。                                                                | 把等待批准和普通调度停滞表示成不同状态。把可执行步骤、预算、审批及 outbox 对应到可恢复的运行/attempt 身份，验证重放中的外部动作幂等。 | [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) · [节点重入](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)       |
| **Anthropic Research / Evals** 在可拆分工作负载中分配独立上下文并回收结果，同时跟踪成本。质量评估包含轨迹和最终环境状态。                                      | 值得并行的任务包含独立研究、互相复核和可分工作区的交付。评测应依据链接证据、测试结果和最终产物。                                      | [多 Agent Research](https://www.anthropic.com/research/multi-agent-research-system) · [Agent evals](https://www.anthropic.com/research/demystifying-evals-for-ai-agents) |

历史的 100 个闭卷研究任务中，Single / Serial Squad / Parallel Squad 平均分分别是 **3.79 / 3.47 / 3.53**，solver p50 为 **34.9 / 98.9 / 54.9 秒**。Parallel 求解 token 约为 Single 的 **4.23 倍**。该批实验用固定角色、任务图和模型评分。它支持保守路由和同步记录投入产出。可工具化研究、真实代码任务及成员协作的新策略仍需单独评估。[原始结果与口径](../reports/2026-10-25-multiagentbench-research-100.md#results)

## 建议顺序与验收

1. **先兑现现有运行承诺。** F01–F06 优先。取消应在初次编译及真正派发前生效，两支 Squad 并存时任务读写必须限定在本队；扩额后恢复调度、累计预算不重置；改令当条展示拒绝/排队/送达；Host 重启在终态写入、outbox 写入和消费三个边界各测一次，用户收到一条与正确 attempt 关联的结算。
2. **收敛入口与配置解释。** F07、F08、F10、F11。用三个常用选择覆盖默认路径：普通会话、委派限定子任务、团队交付。可验收的结果包括同名配置在 UI 和 Host 使用同一 resolver，显式目标不可用时给出原因，独立复核覆盖快回复及浏览器不支持场景，单 Agent 建议能实际采用低成本路径。保留手动选择 Squad 与 Workflow。
3. **补足可控协作，再评估默认扩展。** F09、F12。先验证成员定向消息从持久化到消费的完整轨迹、停止到期及任务结果引用；再测原子领取任务的需要。按独立研究、强依赖任务、代码交付三个赛道比较单 Agent／有限子 Agent／Squad，在相同模型与相近 token 或成本预算下记录验收率、p50/p95、token/成本、人工干预、重复副作用与恢复成功率。

## 验证记录

基准日期为 2026-11-18，北京时间。审计读取当前工作树，以 `93b7406a3c11` 为基线。收尾时 HEAD 前移到 `f6b7354c51ac` 的 QQ Connector 修复，按路径 diff 核对本文引用的核心入口、运行和控制代码没有随之改变。生产代码未编辑。测试使用本地 Jest 和合成数据，未使用真实供应商账号、Worker、IM 或设备。

两个有效批次分别为 **12 suites / 269 tests** 和 **12 suites / 205 tests**，共 **24 个不同套件、474 个测试通过**。额外筛选 `lib/claude/build-options.test.ts` 的 18 个用例通过，其余 535 个用例由筛选条件跳过。补充批次最初因生命周期 suite 无结论而终止，重跑时更正了一个不存在的 Agents 测试路径，使用现有 Console 和 route-state 用例。`pnpm_config_verify_deps_before_run=false` 仅关闭 pnpm 运行脚本前的依赖校验和自动安装，沿用当前 checkout 的依赖。

```bash
pnpm_config_verify_deps_before_run=false pnpm test -- --runInBand --runTestsByPath \
  app/me/agent-modes/page.test.tsx \
  lib/agent/composition/turn-agent-mode.test.ts \
  lib/squads/auto/auto-orchestrate.test.ts \
  lib/squads/auto/assess-routing.test.ts \
  lib/squads/collaboration-tools.test.ts \
  lib/squads/durable/durable-control.test.ts \
  lib/squads/durable/durable-runtime.test.ts \
  lib/squads/durable/team-recovery.test.ts \
  lib/squads/room-handoff/decide.test.ts \
  lib/execution/launch-child-run.test.ts \
  lib/execution/squad-start-dispatch.test.ts \
  lib/execution/run-budget-rail.test.ts

pnpm_config_verify_deps_before_run=false pnpm test -- --runInBand --runTestsByPath \
  lib/agent/composition/chat-orchestrations.test.ts \
  lib/agent/composition/verified-fresh-agent.test.ts \
  components/chat/composer/hooks/use-composer-mention-sources.test.ts \
  lib/chat/mentions/agent-targets.test.ts \
  lib/squads/room-handoff/settle.test.ts \
  lib/squads/synthesize-workflow.test.ts \
  lib/squads/auto/dispatch-executor.test.ts \
  lib/execution/run-control.test.ts \
  cli/src/config/agent-mode.test.ts \
  components/agents/agents-console.test.tsx \
  hooks/agents/use-agents-route-state.test.ts \
  lib/chat/mentions/markdown-agent-targets.test.ts
```

四个本地组件检查均退出 0。检查使用实际实现、合成输入及无副作用的通知器。

| 检查                                                                          | 实际输出与覆盖                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node --import tsx` 调用 `canMoveTask` 与 `synthesizeTeamWorkflow`            | 执行中可从 pending 移到 cancelled，`allowed:true`。传入已取消任务，flat 合成仍生成 `action.team.task.dispatch`。 |
| `node --import tsx` 调用 `createBudgetGuard` 与 `createConcurrencyController` | 同一 run 用量 96/100，批准扩额后 96/150 且并发 0。重建 guard 得到 0/100。                                        |
| `node --input-type=module` 调用 `WebStubTransport.call("agent_send")`         | 返回 `no_host_transport tauri-only command from web mode: agent_send`。                                          |
| `node --import tsx` 通过 CommonJS 加载 `customModeFileSchema`                 | 平铺的 mode JSON 校验成功，GUI 格式的导出封装被拒绝。                                                            |

[浏览器 E2E](../../tests/e2e/agent-runs/squad-run-controls.spec.ts) 已有基于种子数据的控台状态检查，[移动 E2E](../../tests/e2e/mobile/squad-remote-start.spec.ts) 的 Host RPC 经拦截。两种测试的存在均无法覆盖本轮待验收的真实进程、权限与 Worker 场景。浏览器 E2E、Tauri、真实配对设备与外部引擎本轮未执行。

## 测试覆盖复查

> 研究相关的代码，看看有无什么覆盖的问题

2026-11-18 基于 `d861ef61c4b6` 的工作树复查，本轮只更新审计文档。测试范围聚焦 F01–F11 中的身份解析、任务派发、审批恢复和结果回传。上文记录了首次审计时的执行结果。

### 覆盖率

37 个 Jest 套件、657 个测试通过。V8 对选中的 22 个文件采样，行 **87.36%**（7,182/8,221）、分支 **80.80%**（1,414/1,750）、函数 **84.75%**（189/223）。12 个文件三项均达到 90%。这组结果只代表执行了指定测试的样本。完整生命周期套件单独复查，其结果见下文。本次采样按仓库局部覆盖的做法跳过聚合阈值校验，现有全量 CI 和改动文件门槛继续由各自配置执行。原始数据及精确命令在 `.cache/agents-squads-coverage-2026-11-18/`。

| 文件                                                                     |      行 |    分支 |    函数 | 代表行为                                                                      |
| ------------------------------------------------------------------------ | ------: | ------: | ------: | ----------------------------------------------------------------------------- |
| [Squad 主生命周期](../../lib/squads/agent-team-runtime.ts)               |  56.93% |  40.38% |  23.52% | 本轮合并只纳入 durable 等关联 suite。预算审批回调的相关行命中为 0。           |
| [持久运行控制](../../lib/squads/durable/durable-control.ts)              |  89.58% |  81.33% |  75.00% | 有停止未证实和部分改令失败场景，缺全部子任务拒绝的产品断言。                  |
| [执行控台处理器](../../lib/execution/control-handlers.ts)                |  82.36% |  70.53% |  80.00% | 上层 steerer 被调用，现有断言覆盖正回执或 0 候选。                            |
| [启动恢复](../../lib/squads/durable/recover-squad-runs.ts)               |  95.74% |  76.05% | 100.00% | 覆盖审批后调用续跑入口，审批额度和恢复后的限制未被断言。                      |
| [任务移动规则](../../lib/squads/gates/task-move-guard.ts)                | 100.00% | 100.00% | 100.00% | 状态转换完整。调度器是否尊重转换属于另一个合同。                              |
| [任务 DAG 合成](../../lib/squads/synthesize-workflow.ts)                 |  99.68% |  95.83% | 100.00% | 已覆盖依赖和校验，当前缺生产入口对取消项的整合验证。                          |
| [协作工具](../../lib/squads/collaboration-tools.ts)                      |  96.93% |  85.17% |  96.42% | 行命中同时包含替身依赖，任务归属和真实读取过滤的组合未被断言。                |
| [Room 结算与补投](../../lib/squads/room-handoff/settle.ts)               |  82.10% |  87.80% |  85.71% | 补投函数的主要分支由单测直接调用。启动时是否走到该函数仍需整合验证。          |
| [Room 投递启动](../../lib/background-tasks/runtime-room-lane.ts)         | 100.00% | 100.00% |  66.66% | 测试验证已存在 outbox 的投递调度。                                            |
| [独立复核](../../lib/agent/composition/verified-fresh-agent.ts)          |  93.02% |  81.25% |  75.00% | production follow-up 装配的相关行命中为 0。                                   |
| [Markdown Agent 投影](../../lib/chat/mentions/markdown-agent-targets.ts) | 100.00% | 100.00% | 100.00% | 同 ID、`hidden`、`disabled` 的跨入口一致性需要行为断言。                      |
| [自动组队对话框](../../components/squads/auto-compose-dialog.tsx)        |  98.34% |  91.60% |  94.44% | 主要交互用注入的 plan 与 executor 测试，缺真实 single-send 决策的端到端调用。 |

### 优先补的行为合同

| 优先级                               | 当前断言与断点                                                                                                                                                                                                                                                                                                                                                                               | 最小补测                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1 取消任务（F02）**               | 看板 [状态转换矩阵](../../lib/squads/gates/task-move-guard.test.ts#L24) 和 [任务筛选](../../lib/squads/agent-team-runtime.test.ts#L1169) 分别有测试。筛选用例注入自己的 completed filter，普通启动后及等待派发期间的取消没有生产路径断言。                                                                                                                                                   | 在生命周期 suite 保留真实调度，把执行器替换成可控 fixture。分别覆盖启动前取消与 DAG 建成后取消，确认被取消节点没有调模型或打开工作区，也不会被写回 completed。已有浏览器看板与运行控台可扩一条薄端到端用例。 |
| **P1 预算与审批恢复（F03–F04）**     | [治理 UI](../../components/squads/settings/section-governance.test.tsx#L307) 断言保存 callback，[预算单测](../../lib/squads/gates/budget-guard.test.ts#L188) 断言注入阈值，[死锁测试](../../lib/squads/gates/deadlock-gate.test.ts#L96) 断言解封 mock，[启动恢复](../../lib/squads/durable/recover-squad-runs.test.ts#L114) 断言重新调用生命周期。四处均缺对下一步实际调度和剩余额度的检查。 | 用真实的设置解析、持久审批、governor 与调度器，断言批准后后续任务确实执行，重启后校验已用量、获批扩额和拒绝路径。                                                                                            |
| **P1 Room 重启回传（F05）**          | [补建测试](../../lib/squads/room-handoff/settle.test.ts#L147) 直接调用函数，第二个终态相隔一小时。 [启动测试](../../lib/background-tasks/runtime-room-lane.test.ts#L49) 预置 outbox。缺生产启动接线、近时间 attempt 的结果归属及重复启动断言。                                                                                                                                               | 用固定存储、真实 bootstrap 与投递 lane 构造终态 Squad 但 outbox 空的重启。验证一条正确 attempt 的结果，重复启动数量不变。跨进程再用受控 Host smoke 验证落盘边界。                                            |
| **P1 Squad 改令回执（F06）**         | [durable 控制](../../lib/squads/durable/durable-control.test.ts#L268) 测试部分失败；[控台处理器](../../lib/execution/control-handlers.test.ts#L994) 的 mock 只覆盖有回执或候选为零，并将排队场景视为成功。缺候选数大于零且回执为零，也缺 UI 区分已接收排队和真正送达。                                                                                                                       | 在控制边界同时断言 all-refused、partial、queued、delivered 的持久结果与用户状态。现有 stop-proof 检查继续复用。                                                                                              |
| **P1 任务权限（F01）**               | [任务工具测试](../../lib/squads/collaboration-tools.test.ts#L637) 注入 store 操作， [个人可见性替身](../../lib/squads/collaboration-tools.test.ts#L37) 通常原样返回消息。测试验证作者与输出形状，缺目标任务归属、读证据和合法同队场景。                                                                                                                                                      | 为真实 Host 工具准入补权限合同，验证同队授权和越界拒绝、无写入及不区分不可访问目标。使用无真实用户数据的隔离 fixture。                                                                                       |
| **P2 执行身份与独立复核（F07–F08）** | [装配测试](../../lib/claude/build-options.test.ts#L2694) 固定未知 ID 时清空 `opts.agent`，[复核测试](../../lib/agent/composition/verified-fresh-agent.test.ts#L502) 固定未配对 web 可用，两者均未检查随后真正执行的能力。现有 watcher 用例覆盖依赖注入和已存在回复。                                                                                                                         | 测整条 picker → host 请求，断言不可用显式目标给出诊断，同时覆盖同名 profile 和 disabled。复核使用独立转发目标、固定 turnId 与快回复时序，断言 verdict 或明确不可用。                                         |
| **P2 单 Agent 路由（F10）**          | [Auto Compose 组件](../../components/squads/auto-compose-dialog.test.tsx#L386) 验证普通快速创建物化，另有 Council/Ensemble 分支。单 Agent 建议返回的 executor 有独立单测，缺该决策经过 Quick Create、Approve 实际调度的断言。                                                                                                                                                                | 用真实决策函数喂快速创建与确认路径，验证单 Agent 路由及模型调用次数，确认不会先生成 roster、DAG 或物化 Squad。                                                                                               |

### E2E 实际纳入范围

- Playwright 发现当前 5 个相关 spec 共 **15 个用例**，Chromium 7 个、Pixel 7 8 个。按 CI 的 `@smoke|@critical|@a11y|@visual` 筛选得到 **0 个**。此结论只覆盖明确列出的 Squad 控台、远端启动及 action.team 节点 spec。建议在补齐契约后各选一条 Chromium 和 Pixel 关键路径纳入 PR gate。[CI 过滤](../../.github/workflows/test.yml#L1146)
- Chromium 的 Squad 控台用例用 [dev bridge](../../tests/e2e/agent-runs/squad-run-controls.spec.ts#L46) 预置团队与运行。它验证阻止启动、共享控台与审批表单 reload。工作流的 [action.team.run](../../tests/e2e/workflows/nodes/action-team/run.spec.ts#L25) 目前断言节点字段和保存重开，缺实际执行后的 Squad run 与终态。使用现有 spec 补一条任务执行联动即可覆盖编辑器边界。
- Pixel 7 的 [远端启动](../../tests/e2e/mobile/squad-remote-start.spec.ts#L119) 拦截 Host RPC 并合成状态变化，覆盖 lease、重试、批准/拒绝与离线操作。对同一条链补真实 Host/Worker smoke，检查停机证明和有副作用的进程重启。macOS 环境未执行 Windows WebView2，真实 Capacitor 同样待验收。
- `pnpm audit:e2e-governance` 通过，0 个新违规、14 条已登记例外。门禁规则覆盖 spec 写法与例外台账。上述 15 条未被 PR 选中的事实来自实际 discovery。

### 当前运行验证的阻塞

- 直接运行 `lib/squads/agent-team-runtime.test.ts` 在 65 秒诊断预算内未汇总。筛选四个既有测试后，Jest 报告 **4 个失败、57 个由名称过滤跳过**。独立任务、依赖顺序、恢复任务过滤和计划批准都得到 `failed`，预期为 `completed`。随后 Jest 报告仍有未停止的异步操作，40 秒外部预算退出 124。测试输出保存在 `lifecycle-suite.log` 和 `lifecycle-slice.log`。四个断言未达到成功结果。首次收集覆盖率时本套件单独隔离。 在 `.cache` 中保留原断言并加入运行轨迹日志后，确认独立任务用例的两个子运行报 `lease.additionalAliases is not iterable`，且 executor 调用数为 0。定位到测试的 [FakeController](../../lib/squads/agent-team-runtime.test.ts#L52) 没有提供 [dispatcher 使用的租约字段](../../lib/squads/teammate/dispatch-teammate.ts#L2046)。仅给隔离副本的 mock 补 `additionalAliases: []`，四个原失败用例均通过，57 个仍由筛选跳过。副本用 `--forceExit` 收集结果，异步退出问题未验证。证据为 `lifecycle-reason.log` 和 `lifecycle-lease-control.log`。 同一隔离副本跑完整 61 例，结果为 **56 通过、5 失败**。四个发布审批场景得到 `delivery_failed`，预期为 `delivery_awaiting_approval`。PAT 发布场景被 `PersonalSinkWithheldError` 拒绝。四个状态差异是否出于同一权限原因仍待隔离，结果保存在 `lifecycle-lease-full.log`。
- Chromium 使用当前源码的 loopback Next dev、`NEXT_PUBLIC_E2E=1` 和 eager profile，打开 `/squads` 得到 200。针对控台的 grep 选中两个用例。第一个在 `__cogniaSeedSquad` 的 `page.evaluate` 达到 60 秒超时，浏览器日志有 Dexie 升级/删除被连接阻塞与 `DatabaseClosedError`。第二个在 105 秒的外部诊断预算处中断。此轮没有得到 UI 契约的通过结果。证据为 `chromium-dev.log`、`chromium-smoke.log` 与 Playwright trace。当前 `out/` 的 Squad 页面产物早于本轮源码，留待新鲜静态构建复核。
