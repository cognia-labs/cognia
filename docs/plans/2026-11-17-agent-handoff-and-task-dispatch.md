# 让任务派发、桌面任务入口与原生会话续接形成可验证的闭环

| 项目         | 内容                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态         | Draft / 可评审实施计划；尚未实施，未通过真实客户端验收                                                                                                                  |
| 作者 / 日期  | Codex / 2026-11-17，Asia/Shanghai                                                                                                                                       |
| 深度         | Heavy：跨 UI、共享契约、CLI、外部协议、Host、Rust、sidecar、持久化与多账号边界                                                                                          |
| 来源         | Handoff / 任务派发缺口分析、Claude Desktop 官方能力补充、多桌面客户端清单，以及“给出完整的计划”                                                                         |
| 证据         | [审计与复现记录](../evidence/2026-11-17-handoff-task-dispatch-gap-audit.md)、[15 项隔离探针](../evidence/2026-11-17-handoff-task-dispatch-gap-audit.probes.mjs)         |
| 当前基线     | 2026-11-17 工作树，HEAD `532674905e`；前次探针基于 `d6497e0bf7` 上的工作树，不能视为新基线已重跑                                                                        |
| 关联约束     | ADR-0103、ADR-0137、ADR-0198、ADR-0217、ADR-0243、ADR-0252；不修改现有 Room / Squad / Delegation 的含义                                                                 |
| 评审角色     | Execution maintainer、Agent protocol maintainer、Desktop/Host maintainer、Security reviewer、QA owner                                                                   |
| 实施授权边界 | 本轮交付本地计划；不安装客户端、不操纵当前用户会话、不提交或发布，不把计划中的能力写成已实现                                                                            |
| 新文档理由   | 现有审计记录缺陷与证据，本文负责跨模块交付契约；[agent-desktop 集成计划](2026-11-12-agent-desktop-integration.md)讨论 UI 自动化引擎，不能替代 Agent 客户端 Handoff 方案 |

**推荐先修复派发边界，再交付五类客户端的官方任务入口，最后逐项开放原生会话续接、运行控制和结果回流。** Deep Link 是目标客户端的投递方式；跨 Host 所有权转移继续使用现有 ticket 协议，异步执行继续使用 `launchChildRun` 和 `executionRuns`。

本计划覆盖 Claude Desktop、Codex App、Cursor、VS Code / Copilot、Qoder IDE、Windsurf、OpenCode、OpenChamber、Zed，以及现有外部 runtime / plugin / CLI 入口的一致性。上游公开文档、Cognia 接线和真实版本验收分别记录。

首个用户可用增量是：选择目标与操作，审阅任务及上下文，在目标客户端准备草稿，并准确看到“已交给系统打开 / 目标已确认 / 需要用户继续”。后续只有取得原生句柄、目标能力和运行证据，才显示“继续原会话”或提供自动控制。

默认建议均写入本文，可直接据此拆分工作包；Q1–Q4 是发布范围与维护成本的评审项，不阻塞先做证据回归和基础修复。日期是资源假设下的估算，不构成交付承诺。

## 1. 用三个独立维度描述交接，避免一个“支持”掩盖不同能力

当前 Cognia 已有结构化历史、跨 Host ticket、统一 child-run、权限上限和 Codex 专用交接；问题是不同入口的约束、执行者和状态不完全一致，桌面任务入口也没有覆盖上游已公开的能力。应扩展已有所有者，再补缺少的薄适配层。

| 术语                  | 用户意图                                | 成功证据                                           | 不应推出的结论                              |
| --------------------- | --------------------------------------- | -------------------------------------------------- | ------------------------------------------- |
| Task Handoff（L1）    | 在另一客户端准备新任务                  | 草稿投递 receipt；有目标确认时记录 draft-ready     | 操作系统接受 URI 不代表用户已提交任务       |
| Context Handoff（L2） | 携带目标、历史摘要、工作区和证据        | 上下文 digest、附件 manifest、损失清单、可读取范围 | 历史摘要不是目标 runtime 的原生状态         |
| Session Handoff（L3） | 继续目标 runtime 已存在的同一会话       | 原生 handle 的来源、同一 session ID、目标恢复证据  | 任意 transcript 导入不等于原生续接          |
| Ownership Transfer    | 把 Cognia 对话的写入所有权交给另一 Host | ADR-0103 source/target commit 与 write guard       | 新任务草稿不需要冻结源对话                  |
| Task Dispatch         | 让受管理的执行者承担工作                | canonical run、权限/预算、进度、终态与结果投递     | 有 Deep Link 就具备可取消、可观察的执行能力 |

L1/L2/L3 可以分别支持；没有原生续接的客户端仍可具有完整任务草稿与上下文入口。

| 目标                          | 当前证据                                                       | 计划验收                                                                        |
| ----------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| G1 派发不串树、不重放副作用   | F01–F07 存在已复现边界缺口                                     | A01–A05：owner fence、失败关闭、约束兑现、实际 backend 与 lost-ack 负例全部通过 |
| G2 覆盖公开桌面任务入口       | Codex 专用通路已接线，其他多为 CLI / MCP / 文件打开            | A06：Claude、Codex、Cursor、VS Code、Qoder IDE 分操作资格验收；不承诺自动提交   |
| G3 上下文可追溯且不转移授权   | 现有 canonical/context/import 基础可复用，F08/F09 缺字段与映射 | A07–A09：历史状态、附件、来源与损失可核对，权限重新判定                         |
| G4 原生续接和多轮控制语义准确 | native 能力存在于部分 adapters；通用 job 控制未贯通            | A10–A12：同会话证明、等待状态、受限 follow-up/stop 与重启恢复                   |
| G5 回流形成可审阅交付物       | Codex 已有不可变回流快照；通用结果偏文本                       | A13：typed outcome、artifact、patch review 与去重导入                           |
| G6 支持范围可以运营和回滚     | runtime catalog 存在，桌面操作资格尚不统一                     | A14–A16：版本/平台/账号/Host 矩阵、禁用恢复、三端诚实降级                       |

包含所有客户端的评估、资格状态、明确降级和后续接入落点。无公开契约的客户端不以猜测 URL 实现生产支持；自动提交、跨账号共享、持续双向历史合并、任意第三方状态转换不纳入首版承诺。后续扩展必须保留这些边界。

## 2. 复用现有所有者，避免再造一套调度和会话系统

以下为源码确认的责任划分；测试结果与真实运行资格见第 12 节。2026-11-17 重新解析 runtime catalog：41 个 runtime entries、44 个 presets，其中 29 个 ACP entries；这些数量不代表逐个验收通过。

| 责任                            | 已有拥有者                                                                                                                       | 本次改动                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 异步 child-run / parent tree    | `lib/execution/launch-child-run.ts`、`executionRuns.parentRunId`                                                                 | 保持唯一 launcher、journal、control 路径；不增平行任务数据库                  |
| 父子任务 wire contract          | `packages/agent/src/handoff-envelope.ts`                                                                                         | 扩展任务目标与可验证交付要求；兼容 re-export 不作 owning source               |
| canonical transcript / 历史状态 | `packages/agent-contracts/src/canonical-session.ts`                                                                              | 复用 tasks/plans/goals/checkpoints/history 等；缺失字段显式 loss              |
| context 构造 / 导入导出         | `lib/chat/handoff-context.ts`、`import-handoff-session.ts`、`export-handoff-to-cli.ts`                                           | 增加任务 brief、范围、证据与预算；不另造 transcript 格式                      |
| 跨 Host 所有权                  | `lib/thread-handoff/`、`packages/agent-config-types/src/thread-handoff.ts`                                                       | 修 provider 选择、历史状态与 provenance；增加明确的目标配置映射               |
| 权限和预算                      | `external/policy/{run-authority,permission-ceiling,permission-cascade}.ts`、run budget rail                                      | 收敛 child/per-call/parent 限制；不能兑现时启动前拒绝                         |
| renderer / plugin / CLI 派发    | `dispatch-agent-handler.ts`、`dispatch-run.ts`、`lib/plugin/agent-sdk/dispatch.ts`、`cli/src/agent/`                             | owner fence、typed 结果、backend fidelity、策略与重试一致性                   |
| 桌面入口                        | `hooks/chat/use-session-desktop-handoffs.ts`、`SessionRowMenuItems`、`components/chat/chat-header.tsx`                           | 共用目标选择及预览，保留既有 CLI / Codex 入口                                 |
| Codex 专用控制和回流            | `lib/native/codex-app-control.ts`、`lib/chat/dispatch-to-codex-app.ts`、`crates/cognia-codex-app/`、`sidecar/codex-app-control/` | 保留现有 receipt / snapshot；补契约一致性，独立资格化 CDP 控制                |
| OS 打开入口                     | `lib/tauri/opener.ts`、Tauri opener ACL                                                                                          | 增加封闭的 Agent URI builder / 校验，保持通用网页 opener 语义                 |
| API / ACP 客户端                | `packages/agent-{opencode,acp,a2a}/` 等                                                                                          | 优先复用既有协议；按协商能力开放 load/list/steer 等                           |
| 工作区隔离                      | Squad teammate / workspace isolation                                                                                             | 抽取可复用的 existing seam，普通写入型 dispatch 使用相同隔离与 patch 回交规则 |

`HandoffEnvelope` 当前指父子派发，`ThreadHandoffTicket` 指跨 Host 对话所有权。桌面草稿适配器不能复用同名类型伪装成上述任一操作。

```text
Chat / CLI / Plugin
        |
        v
Task brief + canonical context + losses
        |
        v
Capability preflight + Host authority + workspace mapping
        |
        +--> Desktop draft adapter --> OS / target app --> delivery receipt
        |
        +--> launchChildRun --------> existing runtime --> run events / artifacts
        |
        +--> thread-handoff --------> target Host -----> two-phase commit
```

图 1：共用上下文与准入，投递草稿、执行工作、迁移所有权分别进入已有或专属的最小边界。

## 3. 客户端按操作接入，首批采用有公开契约的任务草稿

“文档确认”仅说明上游契约；以下新适配均需真实客户端资格测试后才标为 Cognia 已支持。功能状态使用 `documented / implemented / qualified / experimental / unavailable`，另存验证日期与原因，避免布尔值压平证据。

| 客户端 / 产品                       | 首选接入与精确边界                                                                                                                                    | 原生续接 / 回流路线                                                                                                             | 批次与退出条件                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Desktop Chat / Code / Cowork | `claude://claude.ai/new?q=…`、`claude://code/new?q=…&folder=…`、`claude://cowork/new`；Code `file` 不作为已支持附件，Cowork 重复 folder/file 独立建模 | Chat/project ID 仅定位；Code CLI `/desktop` 或 `claude --desktop --resume ID` 单独资格化；新任务不伪装恢复既有 Code/Cowork 会话 | P2 草稿，P3 原生续接；folder 确认、长度、登录与 OS 分别验收。[官方 Deep Link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)、[CLI→Desktop](https://code.claude.com/docs/en/desktop#coming-from-the-cli)                                                   |
| Codex App                           | 官方 `codex://threads/new?prompt=…&path=…`，或合法 `codex://new`；`originUrl` 仅匹配已配置工作区，`path` 优先，不隐式 clone                           | `codex://threads/ID` 定位；CLI `/app` 继续保存的原生会话；既有 Cognia snapshot import / return 保留独立动作                     | P2 官方草稿，P3 原生续接，P4 可控执行；不把现有内部使用 Deep Link 误报为缺失。[官方链接](https://learn.chatgpt.com/docs/app/commands#deep-links)、[/app](https://learn.chatgpt.com/docs/cli/slash-commands#continue-in-the-desktop-app-with-app)                                             |
| Cursor                              | `cursor://anysphere.cursor-deeplink/prompt?text=…`；编码后完整 URL 上限 10,000 字符；当前项目上下文需用户可见                                         | Cloud Agent `bcId` 仅为条件候选，账号归属和实测必需；未确认通用本地 session 恢复                                                | P2 Prompt；P6 Cloud link；不承诺 URL 中任意目录参数或跨账号续接。[官方文档](https://cursor.com/docs/reference/deeplinks)、[完整上游讨论](https://forum.cursor.com/t/open-by-id-url-for-the-cloud-agent/159908)                                                                               |
| VS Code / Insiders + Copilot        | `vscode://agents/new?prompt=…&workspace=…`；workspace 是编码后的 folder URI；目标已有 draft 不被覆盖                                                  | Copilot CLI `/code`、`/code-insiders` 为实验性原生续接；CLI 专属授权不直接继承                                                  | P2 draft；P3 实验性续接；Copilot CLI ≥1.0.107 且开启实验项，逐版本复核。[官方 CLI 文档源码](https://github.com/microsoft/vscode-docs/blob/main/docs/configure/command-line.md)、[1.146](https://code.visualstudio.com/updates/v1_146#continue-a-copilot-cli-session-in-vs-code-experimental) |
| Qoder IDE                           | `qoder://aicoding.aicoding-deeplink/chat?text=…&mode=agent&isNewChat=true`；mode allowlist；ask 当前按 chat；默认新聊天                               | 未确认按本地 ID 恢复；`isNewChat=false` 需明确用户选择，不能静默改写当前草稿                                                    | P2 IDE 草稿；独立 Qoder 桌面 Agent 另列 unavailable，不能套用 IDE 契约。[官方文档](https://docs.qoder.com/user-guide/deeplink)                                                                                                                                                               |
| Windsurf                            | `windsurf-next://cascade/newChat` 是原始用户报告中的候选；`autoRun=true` 不作为能力                                                                   | 无稳定公开恢复契约                                                                                                              | P6 disposable 环境 spike；记录实际版本和 scheme，再决定 experimental 或 unavailable。[上游报告](https://github.com/Exafunction/codeium/issues/283)                                                                                                                                           |
| OpenCode Desktop / server           | 执行优先走现有 V1/V2 server session API；桌面 URI 与 server 会话是独立资格项                                                                          | API 创建/恢复/观察已有 session；不能把 server 成功视为桌面已定位                                                                | P4 API；P6 Desktop。V2.2.5 有目录/prompt 丢失报告，不能假设所有新版本仍坏；PR #54187 closed/unmerged 不能作为修复依据。[问题](https://github.com/anomalyco/opencode/issues/55106)、[PR](https://github.com/anomalyco/opencode/pull/54187)                                                    |
| OpenChamber                         | 独立客户端 `openchamber://session/ID?message=ID`；可含 instance host，限已配置实例                                                                    | 仅打开该实例已有 OpenCode session；不提供通用第三方历史导入                                                                     | P6 可选导航；instance、account、session 三者一致。[链接源码](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/lib/sessionLinks.ts)、[接收及路由说明](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/sync/DOCUMENTATION.md)                         |
| Zed                                 | CLI 打开项目；优先检验 configured agent 的 ACP list/load 和 Import Threads                                                                            | 同一 agent 原生 session store 兼容时继续；Cognia 与 Zed 都是 ACP client，不能直接互当 agent                                     | P5/P6 ACP 兼容矩阵；无 cwd 的 session 与不可导入类型显式解释，不发明通用 `zed://` Prompt API。[官方 external agents](https://zed.dev/docs/ai/external-agents#importing-threads)                                                                                                              |

Claude 的 Deep Link 在官方文档覆盖 macOS/Windows/Linux；这不推出 Linux 支持 CLI `--desktop`。后者按当前文档单列 macOS、Windows x64、订阅登录、CLI ≥2.1.285 和无占用会话等前提；API key / Bedrock / Google Cloud Agent Platform / Foundry 认证不作为可用路径。提示词约 14,000 字符的上游截断风险在投递前处理，不依赖目标静默截断。

## 4. 全部 runtime 接受同一组契约检查，能力仍按协议细分

不为每个 preset 新写一套 Handoff。catalog、manifest、实际协商和资格记录共同决定有效能力，不能仅由产品名称决定。

| 族                                                  | 计划中的检查与补齐                                                          | 不统一伪装的差异                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Built-in / SDK / Plugin                             | 同树 collect/cancel、child policy、typed outcome、审批与 follow-up          | SDK turn 内子任务仍按 ADR-0252 保持 message part，不强行全变 run               |
| Codex app-server / Claude ACP / 其他 29 ACP entries | list/load/fork/cancel、工具限制、内容、elicitation、usage 与恢复逐项协商    | 同一 ACP transport 不代表全部 agent 支持同样能力；Codex App 与 app-server 分离 |
| OpenCode V1/V2 / Pi RPC                             | 保留各自 native resume/fork/steer profile，完善 run projection 和恢复       | V1/V2、Pi RPC/ACP 不混用 handle                                                |
| DeepSeek Harness                                    | 验证运行、子 agent 事件、进程取消、launch-profile 权限                      | 当前 adapter 无 resume/fork/steer 时明确禁用；不因上游支持便打开按钮           |
| OpenClaude / Crush / Rovo                           | 保留 native continuation 与审批能力，补恢复和预算资格                       | usage 不可信且预算有限时继续安全拒绝，不能为了“支持”绕过预算                   |
| Aider / Continue / Codebuff                         | history-replay 明示为上下文重派发，保留取消/审批 profile                    | 不称 native resume；process cancel 与 turn cancel 分别展示                     |
| A2A                                                 | taskId/contextId、input/auth 等待、artifact、resubscribe、cancel 与重启恢复 | 一轮结束与 task terminal 分开；不存凭据或宣称通用 native fork                  |
| 自定义 plugin adapter / terminal-only               | manifest 声明、Host enforcement、契约测试与明确 refusal                     | Freebuff 等纯 PTY 只提供终端入口，MCP 只提供工具互通，不自动获得受管执行       |

每个有效操作记录 `transport × product × runtimeVersion × adapterVersion × platform × authClass × hostFeature`。版本未知只能进入有界 experimental，任何限制无法证明兑现时返回 `capability_not_supported`，不能忽略字段继续启动。

## 5. 先逐项修复 F01–F10，并补齐结果、审批和协作边界

实施前把审计探针改写为 owning 文件的 co-located 回归测试，先确认在实施基线失败且原因相符。探针不替代真实 manager / Host 的负例；当前已有正确的 authority、budget、CLI owner fence 作为反向对照保留。

| 工作包                    | 修复内容与最小落点                                                                                                                                                           | 行为验收                                                                                                                                 | 责任角色                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| WP01（F01/F02）           | renderer collect/cancel/resume 先解析可信 caller，再按 canonical root / descendant fence 查目标；消费结果前授权；CLI 共用判定契约                                            | 同树 nested 正例；另一 root、伪造 session、旧 generation 拒绝；被拒 collect 不 markCollected、不返回内容；personal disclosure 仍二次过滤 | Execution maintainer      |
| WP02（F03）               | `dispatch-run.ts` foreground/background 共用 side-effect certainty；只有证明未执行或具备目标端幂等键才重试                                                                   | 注入“效果已发生后 lost ack”，计数必须 1；结果为 recovery_required/uncertain；纯只读失败可有界重试                                        | Execution maintainer      |
| WP03（F04/F05）           | `dispatch.ts` 将 parent ceiling、子定义和 per-call policy 单调求交；toolsEnabled=false/空 allowlist 为 deny-all；deny 取并集；MCP 取交集；maxTurns/deadline 进入实际执行边界 | 用真实 manager 验证禁工具、deny tool、未授权 MCP、超轮/超时和父预算；不能兑现者启动前 typed refusal；不只检查传参                        | Agent protocol maintainer |
| WP04（F06/F07）           | CLI 子定义选择实际 external preset/config/credential binding；策略未配置与读取失败区分；CLI/headless 明确策略作用域并消费已解析 snapshot                                     | 指定 Codex 子定义时实际 backend 为目标 preset；配置读失败不启动；不要求 CLI 直接读 renderer Dexie                                        | CLI maintainer            |
| WP05（F08/F09）           | provider override 优先且唯一，未配置时才 model 解析；保留允许历史状态、真实 runtime/version 与 losses；target mapping 按第 7 节                                              | 两 provider 同名模型不能选错 credential；历史 tasks/plans/checkpoints 往返；历史 allow 不转授权；未知 native 仍 contextual               | Handoff maintainer        |
| WP06（F10）               | A2A mapper → base collector → manager → child launcher 全链携带 task state；转成 waiting/input 或 auth interrupt，保持 task/context refs                                     | input-required/auth-required 不出现 run.completed；补充信息后同一 task 继续；断线/重启后 get/resubscribe，不重建 task                    | Agent protocol maintainer |
| WP07（结果与控制）        | 所有 dispatch 分支返回 typed outcome，再投影到文本；普通 job 接入统一 steer/control；完成后的 contextual redispatch 与 native resume 分开                                    | fanout 部分/全失败按 item 显示；send/stop 收到 ACK 后才更新；unsupported 操作不显示为成功                                                | Execution maintainer      |
| WP08（审批与 ask-parent） | 保留旧 `ask` reserved-v1 语义；新增版本化审批 policy，复用 `executionRunInterrupts`；子任务问父/问人独立于 tool approval                                                     | 新审批模式默认不启动，批准后再次校验 authority/generation；拒绝/过期/撤销不执行；旧插件不被静默改义                                      | Execution maintainer      |
| WP09（写入隔离）          | 普通并行写任务复用 Squad workspace isolation，定义文件责任与 patch handback                                                                                                  | 两 child 默认独立 worktree；同文件冲突停止合入并展示；用户未提交改动保留；apply 前复核 base digest                                       | Workspace maintainer      |

新审批 policy 的 worker 和 consumer 必须协商新 capability；不支持的旧 consumer 不能把未知 ask 当 allow。约束集合中模型、turn limit、工具和 sandbox 各按真实 engine 的可执行维度映射；不能把 prompt 里的“请勿使用工具”当 enforcement。

## 6. 薄的桌面适配契约连接现有入口，能力和事实分别存储

建议新增小范围 `lib/chat/desktop-handoff/`：目标定义/URI builder、preflight/dispatch、receipt repository，分别 co-located tests。新增理由是当前 CLI exporter、Codex snapshot dispatcher、跨 Host ticket 都不拥有通用桌面草稿语义；此目录不拥有 run 调度、通用 transcript 或 authority。共享 IPC 契约落在实际 owning package，兼容包只 re-export。

拟议契约如下，字段和操作是计划，不是当前 API：

```typescript
type DesktopOperation =
  | "open-project"
  | "prepare-task"
  | "open-native-session"
  | "continue-native-session"
  | "send-input"
  | "interrupt"
  | "observe-result"

interface DesktopTargetCapability {
  targetId: string // product + client edition; not a runtime preset alias
  operation: DesktopOperation
  transport: "uri" | "native-cli" | "api" | "acp" | "codex-control"
  evidence: "documented" | "implemented" | "qualified" | "experimental" | "unavailable"
  qualificationRef?: string
  unavailableReason?: string
  limits: { promptChars?: number; encodedUrlChars?: number; supportsFiles: boolean }
}
```

目标定义还需声明支持 OS/arch、版本范围、workspace 语法、账号条件、是否仅预填、是否具有可核实 ACK。产品 capability 来源不能由 renderer 传入替代 Host 自己的判断。

| 输入 / 输出       | 生产者 → 校验者 → 消费者                                                           | 关键规则                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Task brief        | 当前用户或 agent → existing context builder / authority → URI/API/child dispatcher | objective、expectedOutput、acceptance、scope、unfinished、artifact refs、context digest；只带必要历史                    |
| Workspace mapping | 当前 project/target selection → owning Host → 目标 adapter                         | portable workspaceRef 在 Host 解析；URI 目录只在目标机器使用                                                             |
| Native binding    | 已验证 runtime receipt / history → owning Host → continuation adapter              | runtime/product/version/session/host/workspace/store identity、account binding（可取得时）、observedAt；原始 ID 不是授权 |
| Dispatch outcome  | runtime event → owning reducer → model / UI / outbox                               | 成功/失败/等待/取消/不确定、错误码、retry disposition、artifact refs、native binding；不靠文本判断成功                   |
| Delivery receipt  | 投递 adapter → receipt repository → UI/recovery                                    | requestId、context digest、目标/operation、证据等级、时间和错误；不存完整 prompt/URL/凭据                                |

`Native binding` 只把机器可核对的身份作为前提。无法取得账号 identity 时记录 `accountBinding=unverified`，阻止跨账号自动恢复；可提供经用户选择的“打开”动作，不能借此宣称验证了同一账号原生续接。历史 importer 产生的来源提示也不能自行升级为可操作 handle。

### 6.1 草稿投递与执行状态分别判断

| Receipt 状态                 | 进入条件 / 所有者                                            | 允许后续                                                              |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| prepared                     | context/PII/长度/能力/workspace 检查完成，receipt 已落盘     | 发起一次 launch，或取消                                               |
| launching                    | dispatcher 在发送前原子 claim requestId，记录 target binding | ACK→delivered；确定未投递→failed；结果不明→uncertain                  |
| delivered                    | OS 接受 URI / CLI 收到命令，不代表目标任务已开始             | 有目标可核实证据时更新 target-confirmed；否则保持已交给系统           |
| target-confirmed             | 目标 API/可信 receipt 证明 draft/session 已加载              | 提供打开/关联；只有受管 execution 能创建/更新 run                     |
| uncertain                    | 发送后丢回复、进程崩溃或超时，不能证明是否接收               | 查 receipt / 目标状态；不自动重开。用户确认再次打开时生成新 requestId |
| failed / cancelled / expired | 确定未投递、发送前取消、或准备物过期                         | 修正输入重新 preflight；不改变已启动的外部任务                        |

草稿操作没有 `completed` 状态。没有目标 ACK 的 URI，最多自动进入 delivered。用户自报已处理只能记录为用户确认，不能冒充目标协议证据。取消已投递草稿只停止 Cognia 跟踪，不能报告外部任务 cancelled。

执行使用已有 `queued/running/waiting/paused/recovery_required/completed/failed/cancelled`：turn end 不产生 task terminal；remote 不可达进入恢复态，不将未知结算为失败后自动重跑。每个暂停任务保留复核所需的 task/context ID；`auth-required` 只跳转目标认证流程，禁止把凭据输入模型上下文。

已终态 run 不改回 running：后续工作产生有 lineage/replacesRunId 的新 attempt，必要时仍归属同一 delegation；同一原生 session 可以跨 attempt 继续，但 task 与 turn 的生命周期分别记录。等待输入或认证期间仍受原 authority、绝对 deadline 和预算约束，超时/撤销会关闭待决 interrupt；补充输入不能重新获得无限预算。事件按 owning run revision/sequence 合并，重复忽略，乱序先 reconcile，旧 generation 不驱动新 attempt。

公共错误至少区分 `ownership_denied`、`policy_unavailable`、`capability_not_supported`、`target_unavailable`、`workspace_unresolved`、`native_binding_mismatch`、`session_busy`、`pii_blocked`、`payload_too_large`、`approval_required`、`delivery_uncertain`。错误携带安全的 reason、next action 和 retry disposition；UI 翻译错误码，不把任意 native stderr 原样展示为产品文案。

### 6.2 持久化只补草稿 receipts，执行仍用 run journal

新增 `desktopHandoffReceipts` 账号数据库表，理由是未执行草稿既不是 run，也不是跨 Host 所有权 ticket。索引提议 `&id,[sessionId+createdAt],[state+updatedAt],expiresAt`；按 source session/current account 隔离，Host dispatch journal 保存目标本地 launch 的相同 requestId。它只存元数据和受控 artifactRef，不存 task 全文、原始 URL 或 argv。

实际执行的 native task/context binding 给现有 `ExecutionRun` 增加版本化可选字段。目标标识是账号/Host 作用域的恢复元数据，不投影给模型或公开 API；它不是凭据，即使 renderer 持有 ID 也必须由 Host 重新授权。真正凭据仍只在 Host secret store。run events/outbox 负责投影，不把用于展示投递的 `ExecutionRunBinding` 当 engine ownership。两处写入用各自 owning storage 的事务/CAS，跨 Host 通过 ACK reconcile，不能假设跨库事务。

默认提议：prepared artifact 24 小时过期；终态 receipt 元数据保留 30 天；活动/uncertain receipt 不自动清除到无法恢复。源会话删除联动清理本地引用；外部任务删除是另一个明确动作，不能从本地 cascade 推导。retention 接入现有清理机制，资源超限时阻止新投递并提示处理，不丢弃未解决记录。

## 7. 上下文、路径与来源保持可携带，跨 Host 只通过明确映射

任务包由现有 canonical session 与 task brief 组合，至少包含目标、完成标准、未完成项、文件责任、工作区逻辑引用、必要历史、artifact/evidence refs、runtime provenance、版本、内容 digest 与 `SessionLossReport`。历史计划/任务是只读事实，不能自动变成待执行队列；历史工具调用不得重放。

| 场景                          | 解析方式                                                                                | 拒绝或降级                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 同机 Desktop                  | owning Host 验证绝对 cwd、canonicalize/symlink 后仍在授权 root；本地 URI builder 编码   | cwd 不存在/越界则选择已授权 workspace，不回落 home 继续派发                |
| VS Code workspace             | 通过文件 URI encoder 处理 Windows drive/UNC、空格、Unicode、#、%                        | 不把裸 path 当 folder URI，不拼字符串猜转义                                |
| Codex originUrl               | 去凭据的已配置 Git remote 匹配；path 优先                                               | 多匹配需选择；没有匹配不 clone、不把 remote 账号信息放 URI                 |
| 远端 Host                     | `workspaceRef` / rootId / 相对路径 → target Host root；需要代码用已有 codeCheckout 流程 | 不发送源机绝对路径给目标执行；不把 controller 机器路径当 Host 路径         |
| provider / model / credential | 显式 override 优先；target preflight 返回本地可选项，用户/策略选定 mapping digest       | 没有精确或批准映射即 blocker；不传 credential material，不按同名模型猜账号 |
| 附件 / 交接文件               | 现有 SHA-256/长度/mediaType manifest 和受控 materialization                             | 路径引用不是附件；目标无法读取时展示 loss 或阻塞，不能报告已附带           |
| 超过 URI 限制                 | 先算编码后总长和目标 prompt 上限；展示缩减预览、摘要和遗漏                              | 不静默截断；支持读本地材料者可用受控交接文件，否则导出/复制后由用户操作    |

摘要若调用模型必须经过现有 outbound PII gate；预算继续使用现有 context builder 的限制与 loss。URI/API/CLI 最终发送内容、文件名和新增摘要均复查 PII，不只检查用户最后一条消息。机密文件不因被列入 manifest 自动获得读取或外传授权。

跨 Host 增加新字段时保留 `thread-handoff-structured-v1` 安全底线；改变 mandatory mapping/历史语义另加协商 capability，不能把新必填字段塞入同版本让旧端默默忽略。未知 native binding 仍作 provenance，`nativeRuntimeAvailable:false` 在缺乏目标证明时保持正确拒绝。

## 8. 用户从同一个入口完成选择、预览、投递和恢复

现有会话行菜单与 header 共用一个 lazy-loaded 目标选择流程；不新增独立调度页面。默认操作为“在其他客户端准备任务”，保留“携带上下文创建任务”“继续原生会话”“移交到其他 Host”的不同文案。目标列表显示可用操作与不可用原因，不能用一个绿色“支持”覆盖全部操作。

| 步骤                | 触发与系统行为                                                                             | 可观察结果 / 异常恢复                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| HP01 选择目标和操作 | 用户从当前会话/选中任务进入；系统读取当前账号、执行 Host、目标版本与 capabilities          | 未安装、未知版本、未登录、无 workspace、远端离线各给原因；无能力可导出 task brief          |
| HP02 预览投递内容   | 展示任务目标、上下文预算/损失、工作区、文件数量、是否只预填，以及目标机器                  | PII 阻塞回到编辑；Claude Code 文件不显示为附件；用户改目标后重算长度与 mapping             |
| HP03 投递前准入     | Host 校验 actor、scope、workspace、操作、generation 和 request digest；落 prepared receipt | 策略读取失败/审批拒绝/版本不符不 launch；双击同一 request 返回同一 receipt                 |
| HP04 唤起或续接     | 使用封闭 URI/API/CLI adapter；发送前 claim，再发送一次                                     | URI 无 ACK 显示“已交给系统打开，等待在目标确认”；超时后 uncertain 并提供检查，不显示运行中 |
| HP05 跟踪受管任务   | 仅对具有 observe/control 的目标绑定 run，展示进度、等待输入、审批与停止                    | 离线后先 reconcile；旧 ACK/审批按 generation 拒绝；不支持控制则只提供打开目标              |
| HP06 继续与回流     | 显式继续同 native session，或导入新快照/结果；native/contextual 分开                       | 已占用原生会话不能强抢；结果缺失可重新检查；同 digest 去重，更新历史生成新不可变分支       |
| HP07 审阅交付物     | 展示输出/证据/patch、base revision 和失败项                                                | patch 冲突回到审阅，不能自动覆盖本机未提交工作；外部执行结论与验证结论分别显示             |

入口需覆盖 keyboard/focus、loading/empty/error、screen reader、取消与重试；`.tsx` 的 label/aria/toast/error 使用 `next-intl`，编辑 en/zh-CN split sources 后生成。浏览器测试只能证明 UI 和契约，不能证明原生 app 收到草稿。

发现与探测复用既有 runtime discovery / Host inventory；桌面 app 从 OS application registration/安装元数据读取 edition、version 与 scheme association。缺失元数据标 unknown，不以启动 app、提交 prompt 或开启 CDP 作为菜单探针。菜单只读有界缓存，用户可刷新；进程/版本/scheme 变化使缓存失效。未知平台 URL 上限以该组合资格测试的最大安全值约束，不能借用其他客户端的上限；没有安全值就提供导出而非尝试超长 URI。

| Cognia 表面          | 草稿 / native / 受管执行策略                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Tauri desktop        | 本机已资格化 scheme / CLI；native 需句柄与目标环境匹配；API/ACP 通过已有 Host 路径                                                         |
| 浏览器               | 用户手势可尝试本机公开 URI，反馈仅为 launch-requested/unknown；没有本地路径证明时不附 cwd；远端执行交给授权 Host，不假装浏览器可本地 spawn |
| Capacitor standalone | 不把桌面 scheme 发到手机；支持导出任务材料，或通过已授权的 Desktop Host 请求在该 Host 打开                                                 |
| 配对 browser/mobile  | 作为 controller，明确显示目标 Desktop Host；新 Host feature/operation 协商后再调用，断线保留请求状态；不能扩大为任意远端 URI/进程执行      |
| Cloud/headless Host  | 具有 API/ACP/CLI 执行能力不代表有图形桌面；无桌面 session 的 Host 不提供 desktop launch，改为受管执行或导出                                |

## 9. 原生续接先证明会话归属，自动控制再独立开放

Claude `/desktop`、Codex `/app`、Copilot `/code` 是 runtime 专属机制，不能统一成 `client --resume ID`。优先给受管理且拥有真实 session binding 的 CLI 会话提供适用入口；交互 slash command 通过现有受控终端 integration 发送，不发明对应非交互 flag。

| 阶段             | guard 与动作                                                                           | 失败恢复                                                    |
| ---------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| native preflight | 验证 product/版本/OS/认证类别、Host、workspace/store、原生 ID 来源，查询占用与原有历史 | 缺前提时禁用 native continuation，可显式选择 context 新任务 |
| prepare transfer | 由拥有该 CLI 的 supervisor 等待当前回合可交接点，flush/save；沿既有 control 拒绝新输入 | 不能保全 session 时停止流程，不通过 kill 丢失状态           |
| native launch    | 由目标官方流程接管；旧 executor release/退出证据与目标 ACK 记入 receipt                | ACK 丢失先检查目标状态；未证明 release 不能再启第二写入者   |
| reconcile        | 比对同 native session、cwd 与历史锚点；用户仍需目标的目录/权限确认                     | 不同 ID 或复制时记录为 snapshot/contextual，不显示同会话    |
| return           | 重新取得 native ownership 或导入不可变 canonical snapshot；历史 grants 不恢复          | 双端占用阻塞可写恢复；导入可只读，不自动启动任务            |

Codex 现有 `task-create/send/interrupt` 控制需补一次专项审查：Rust 接受的 model/effort/approvalPolicy 与 sidecar `sendTask` 的真实行为一致；`turnId` interrupt 确认被消费或明确拒绝；安装路径、bundle/executable discovery 跨平台；list/read/create/send/stop 接入统一 run control 才能计作产品可达。

官方草稿入口默认不需要 CDP 重启。既有会话 snapshot 导入仍复用原路径；可能需要 renderer/CDP/relaunch 的执行控制作为独立 compatibility capability，只能在专用用户配置环境取得资格后开放，不能自动重启用户正在工作的 app。协议失败不得切换成 GUI 点击再提交一次。真实第三方 app 没有双向事件时保留手动检查与回流，不建立持续历史合并承诺。

## 10. 所有外部操作走同一授权、隐私和取消边界

| 风险                   | 设计约束                                                                                         | 必测反例                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 跨 root/账号控制或读取 | Host-held actor/root/descendant + current generation；UI 管理权限与模型工具授权分开              | 随机合法 runId、其他 account DB、旧 Host ACK、伪造 controller 参数   |
| 子定义约束被丢弃       | parent/definition/call 的权限单调收窄；受限 budget 不放宽；协议无法兑现即 refusal                | deny-all、MCP 替换、sandbox 缺失、maxTurns 不支持、无 usage 有限预算 |
| URI/CLI 注入           | 只允许 product/operation builder；scheme/path/query allowlist；参数化 spawn、禁 shell 字符串拼接 | 引号、反引号、`$()`、换行、重复 query、伪造 file URI、路径 traversal |
| 数据外泄               | 最终 outbound PII gate、最小上下文；不记录 raw prompt/URL/argv；URI 只放经检查的必要 brief       | 多轮历史、附件名、摘要、Git credential URL、错误堆栈意外泄露         |
| 重试重复启动           | requestId + immutable content digest + owning claim；unknown outcome 先查询                      | 发送后崩溃、lost ACK、双击、跨 tab、重连重复、目标重复事件           |
| 历史授权复活           | 历史工具/approval 仅 evidence；target 重授权；权限 generation 绑定                               | late approval、会话导入 granted event、旧 runtime handle             |
| 本机/远端路径混淆      | target Host 解析 portable refs；本机 materialization 受目录/符号链接限制                         | remote cwd 指向 controller、UNC、junction/symlink、根外文件          |
| 停止是假成功           | run control 发送到实际 executor；按协议记录 turn/process stop proof                              | 无 ACK、旧 turnId、进程断线后继续工作、取消与完成竞态                |

Tauri 新增命令若必要，需在 shared Rust owner 实现、shell 注册、生成 CLI contract、capability/ACL、Companion RPC 的授权/协商同步接线；消息用对象，不使用 tuple 返回。不得为本功能全局放宽 opener/filesystem/shell 权限。Capacitor 内嵌浏览器不是 desktop URI launcher，不能直接复用后声称三端等价。

## 11. 数据和协议增量可回滚，禁用新入口不破坏旧会话

| 项目                         | 迁移方式                                                                            | 旧端与回滚                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| desktop receipt 表           | 空表增量迁移；当前 schema 256，实施时协调分配下一版本，不能预占并覆盖并发 migration | UI/dispatcher 关闭后仍能只读查看和清理；老 schema binary 不直接打开更高版本 DB，应保留迁移兼容构建或从备份恢复 |
| 旧 `codexHandoff`            | 幂等惰性投影 receipt，标记 legacy provenance；保留原字段读写兼容                    | 不伪造旧导出的 ACK/原生权限；维持至少一个支持版本的双读，确认无旧 writer 后再清理                              |
| run native task binding      | optional/versioned，缺失按 legacy 行为；不 backfill 猜测 session                    | 旧 reader 不识别时仅展示/禁控制；新 writer需经 capability gate，未知必要版本拒绝                               |
| task brief / typed outcome   | 在 actual owning contract 增加可选字段；旧文本接口保留投影；强语义要求另协商版本    | 不能把 waiting 投影为 completed；旧 consumer 无法表达暂停则明确 unsupported，不带任务启动                      |
| cross-host mapping / history | 新 offer 保存 mapping digest 与 canonical losses；原 ticket 状态机不变              | 新能力关闭后禁止新 offer，status/reconcile/abort 保持可用；accepted 不因 TTL 自动解冻                          |

按 target+operation 管理 rollout gate：`desktop-task-entry`、`native-continuation`、`managed-desktop-agent-control`、`experimental-client-links` 是拟议 gate 名；生产设置由 owning Host 判定，不能依赖公开前端 env 扩权。客户端版本变化使资格失效时降为需重新确认/experimental，不直接扩大 supportedRange。

回滚顺序：停止新 claim → 关闭对应 operation → 保留已投递 receipt 与运行中的观察/停止/恢复 → reconcile 未知结果 → 回到旧入口。不能为了回滚恢复 F01–F07 的不安全行为；基础安全修复若有问题应暂停派发并前向修正。无证据的 uncertain 交接由用户/运营处理，不自动重发。

## 12. 验收先看行为与真实目标，再看支持数量

已有证据：前次 7 suites 中 258 passed / 2 failed；另外 8 boundary suites 184 passed、4 desktop suites 42 passed、15 audit probes passed。两项 baseline failures 是 `dispatchSubagentAsChildRun` 的 authority_unavailable，必须修复正确 fixture 或真实缺陷，不放宽 authority。以上不是本计划新实现的验证，也不构成原生验收。

| ID  | Given / When / Then 的核心断言                                                                  | 最低证据                                                             |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A01 | 另一 root 调 collect/cancel/resume → refusal，原目标状态/结果未被消费；同树合法操作成功         | renderer+CLI+Host 边界集成负例                                       |
| A02 | 工具产生一次效果后 lost ACK → 不自动重跑；前后台相同                                            | 实际 dispatch reducer + sentinel effect fixture                      |
| A03 | parent/child/call 收窄 tools/MCP/轮数/预算 → engine 兑现或启动前拒绝                            | 真实 manager + 至少 Codex/ACP/不可兑现 adapter 三类                  |
| A04 | CLI externalPreset 指向目标 → 实际 backend/config 一致；policy 读取失败 → 不执行                | CLI runner 捕获 + disposable native/API smoke                        |
| A05 | fanout 成败混合、审批/等待 → typed 状态准确，无假成功或过期执行                                 | tool payload+UI+run journal                                          |
| A06 | 五类首批 target 草稿 → 正确 prompt/workspace；不自动提交、不覆盖已有 draft；没有 ACK 不显示开始 | 每个 qualified OS/客户端版本的真实草稿截图/核验、无模型调用 sentinel |
| A07 | provider override + 同名模型 → 正确 binding；历史任务/证据与 attachments → digest 对齐          | source/target 集成、缺附件/不支持内容负例                            |
| A08 | 不同机器 project/provider/credential ID → 显式映射后可继续，无凭据或绝对路径传播                | dual-host contract + 两 Host 实测                                    |
| A09 | PII/超长/非法路径/引用越权 → 发送前阻塞或显式缩减，损失可见                                     | owning policy 测试、encoded URL 边界、Host trace                     |
| A10 | eligible 原生 CLI → 目标仍为同 ID/工作区/历史；活跃占用、错账号/版本 → 拒绝                     | Claude/Codex 真实 disposable 会话，Copilot 单列 experimental         |
| A11 | A2A 需要 input/auth → waiting，重启后同 task resubscribe；完成才 completed                      | 测试 A2A server + owning collector/recovery + delegation UI          |
| A12 | live follow-up/interrupt → 正确 native session/turn；旧 generation ACK 不作用新任务             | runtime/API 集成、stop proof、取消/完成竞态                          |
| A13 | 同内容回流两次 → 同 snapshot；目标历史变化 → 新 branch；patch 冲突 → 人工审阅                   | canonical importer、既有 Codex return、真实 artifact/patch 流        |
| A14 | 关闭 operation 或目标升级失格 → 停新任务，旧状态仍可恢复                                        | 升降级/kill switch/receipt 重启演练                                  |
| A15 | browser/mobile/controller/cloud → 只展示真实能力，目标 Host 明确                                | Playwright static export、配对模式、真实 Tauri/手机资格              |
| A16 | 未资格版本/issue-only target → experimental/unavailable，不显示为稳定支持                       | catalog consistency gate、Windsurf/OpenCode/Zed/OpenChamber 资格记录 |

### 12.1 检查命令按改动层执行，真实客户端矩阵不能被 mock 替代

以下为当前脚本存在的入口，实施时补入新 co-located test 路径；不运行 coverage，除非用户另行要求。首次开工重跑 baseline 及 probes，处理共享树差异；每个行为包均 fail → fix → pass。

```bash
# Owning dispatch and handoff regression suites
pnpm test --runInBand lib/thread-handoff/service.test.ts lib/thread-handoff/orchestrator.test.ts lib/ai/agent/execution/delegation/dispatch-agent-handler.test.ts lib/ai/agent/execution/delegation/subagent-dispatch-policy.test.ts lib/execution/launch-child-run.test.ts cli/src/agent/subagent-dispatch.test.ts lib/plugin/agent-sdk/dispatch.test.ts
pnpm test --runInBand lib/chat/handoff-context.test.ts lib/chat/import-handoff-session.test.ts lib/chat/dispatch-to-codex-app.test.ts lib/native/codex-app-control.test.ts hooks/chat/use-session-desktop-handoffs.test.ts

# For changed UI/contracts/native boundaries
pnpm lint
pnpm typecheck
pnpm i18n:build
pnpm i18n:build:check
pnpm lint:i18n
pnpm lint:static-export
pnpm build
cargo test -p cognia-codex-app
pnpm sidecar:typecheck

# Select affected cases/projects; then real native/paired acceptance
pnpm test:e2e:static
pnpm test:e2e:tauri
pnpm test:e2e:dual-host:harness
pnpm test:e2e:dual-host:desktop
```

当前环境曾在 pnpm 自动校验依赖阶段触发无关 postinstall 失败：两个 agent-config-types 子路径解析为 `.ts`，不符合 sidecar compiled-JS gate。为重现实验可仅禁用自动依赖重装（`pnpm_config_verify_deps_before_run=false`），不得把跳过构建或 gate 当正式验收通过；实施前由 build owner 修复/确认环境。全仓检查失败需区分本变更新增和既有问题，二者都记录，不用绿的 scoped tests 代替发布门槛。

真实验收记录包含 app/CLI/adapter/OS/arch/build、认证类别、workspace fixture、操作、期待/实测、receipt/run ID（受控证据内）、截图/日志、验证日期及失败恢复。首批在 macOS Apple Silicon 的隔离 profile 验收，再逐项补 Windows x64、Linux x64/arm64 等实际发布支持组合；不要求不存在的上游组合，不将一个平台通过外推全平台。

## 13. 分八个阶段交付，每个阶段都有可独立停止的边界

依赖顺序是安全基线 → 上下文/契约 → 公开草稿；原生续接、受管控制、隔离回流各有独立门槛。资格不足的目标保持关闭，不阻塞已经通过的目标发布。

```text
P0 baseline/fixes --> P1 context/contracts --> P2 official task drafts
                              |                       |
                              |                       +--> P3 native continuation
                              +--> P4 managed control
                              +--> P5 isolation/results
                              +--> P6 client qualification

P2 / P3 / P4 / P5 / P6 applicable acceptance --> P7 platform rollout
```

图 2：P3–P6 可由不同负责人独立推进，但各自依赖的安全、契约和真实验收不能跳过。

| 阶段                   | 交付 / 主责角色                                                                      | 进入条件                                            | 验证与退出条件                                                              | 中止 / 回滚                                                     |
| ---------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| P0 安全与一致性基线    | WP01–04，复现归档、baseline 两项失败诊断；Execution maintainer                       | 明确独立变更范围，保全共享工作树；重跑探针          | A01–A04；F01–F07 各有回归，不降低 authority；未修路径先阻断                 | 禁相关 dispatch，前向修复；不回退 owner/policy 栅栏             |
| P1 上下文与数据契约    | WP05、typed result、capability/receipt schema；Handoff maintainer                    | P0 基线可用；contract owner 确认                    | A05、A07–A09；迁移/旧端/去重/故障恢复通过                                   | 停新 writer，保留旧读取/receipt；新协议 gate off                |
| P2 五类官方桌面草稿    | Claude、Codex、Cursor、VS Code、Qoder；Desktop maintainer                            | P1；真实测试 profile 与目标安装可用                 | A06，i18n/a11y/static export；每个目标记录已资格平台                        | 单 target/operation 关闭；导出 brief/旧入口仍可用               |
| P3 原生续接            | Claude / Codex；Copilot 实验项；Desktop maintainer                                   | P1 native binding、P2 UI，真实订阅/CLI 前提         | A10；同 ID、占用、认证、版本、丢 ACK/退出演练                               | 禁 native continue，显式选择 contextual 新任务                  |
| P4 受管多轮与 A2A 恢复 | WP06/07/08；Codex 参数契约、OpenCode API；Agent protocol maintainer                  | P0/P1；可用 API/进程控制 harness                    | A05、A11/A12；等待/审批/stop proof/重启同任务                               | 禁 send/execute，保留 observe/stop/reconcile；未知不重跑        |
| P5 隔离写入与结果回流  | WP09、artifact/patch return；Workspace maintainer                                    | P1 typed results；写入执行须 P4 control             | A13；两 child worktree、冲突、用户改动与重入导入                            | 停 apply/merge；保留隔离 checkout 与证据供审阅                  |
| P6 兼容客户端资格      | Windsurf、Cursor Cloud、OpenCode Desktop、OpenChamber、Zed；Compatibility maintainer | P1 操作矩阵，disposable app profiles                | A16；每个 spike 输出 capability profile 或明确关闭原因/复查触发器           | 停候选 URI；API/ACP/导出路径保留，不用自动点击补救              |
| P7 三端/多 Host 发布   | 升级/迁移/清理/回滚、双语产品文档、资格 gate；QA owner                               | 对拟发布操作完成 A01–A16 的适用项；未过项不对外开放 | Tauri/browser/mobile/dual-host 真实矩阵、可操作 runbook 与 kill-switch 演练 | target/operation kill switch；不停止必要恢复和已运行任务的 stop |

### 13.1 每个工作包同时交付源码、接线、测试、文档和恢复证据

| 工作包                            | 依赖              | 主要落点 / 产物                                                                                 | 独立验证                                                          |
| --------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| WP10 target adapters / URI safety | WP05、P1 contract | 新 `lib/chat/desktop-handoff/`，现有 opener/Host seam；五类 builder 与 capability records       | 编码/限长/路径负例 + A06/A09；新命令若有则 ACL/注册/生成契约齐备  |
| WP11 UI 与 receipts               | WP10              | 原 hook/menu/header，新增复用 preview/selector；账号 DB migration/cleanup；locale split sources | A05/A06/A14/A15、a11y/locale/UI，重启/双击/跨 tab                 |
| WP12 native continuation          | WP10/11           | existing CLI supervisor / terminal command integration、Host native binding 与查询              | A10、release/save/ACK races；不启动用户现有 app 实验              |
| WP13 Codex managed control        | WP03/07/11        | existing Rust/sidecar/Companion wrappers，typed accepted/refused fields 与 run-control 接线     | A12；send/turnId、fixture/真实 isolated App、跨平台安装发现       |
| WP14 API/ACP/A2A qualification    | WP06/07、P1       | existing OpenCode/A2A/ACP packages，版本化 lifecycle 与恢复 binding                             | A11/A12/A16；真实 protocol fixture 与 selected runtime acceptance |
| WP15 compatibility/rollout        | WP10–14 的适用项  | qualification manifest、catalog consistency check、三端验证、双语 subsystem docs                | A14–A16、upgrade/kill-switch、文档构建、发布证据索引              |

WP10–15 主责分别为 Desktop maintainer、Frontend maintainer、CLI maintainer、Desktop/Host maintainer、Agent protocol maintainer、QA owner。一个包的 acceptance 只能由其主责汇总签署；Security / QA 分别复核权限和真实环境结果，不用设计者自评代替独立验证。

### 13.2 估算用于排期讨论，实施以门槛通过为准

假设 3 名工程师（Execution/Protocol、Desktop/Host、UI/Workspace）与 1 名兼职 QA，可获得三平台隔离测试环境和相关订阅。估计整体 **7–10 周**，其中原生客户端差异和上游接口不稳定风险最高；这不是已测工时，也没有把实验失败折算为“支持完成”。一名工程师串行执行应重新估算，不沿用这个日历。

建议 2026-11-18 启动：P0 至 2026-11-27；P1 至 2026-12-04；P2 至 2026-12-18；P3/P4/P5 在契约完成后并行，目标 2027-01-08；P6 至 2027-01-15；P7 发布评审目标 2027-01-22。P0/P1 未通过则后续目标日期顺延，不能压缩安全和原生验证。客户端兼容 spike 每项上限 2 工程日；无稳定路线时输出 unavailable/experimental 与可用替代，不无限延长或默认批准未知风险。

## 14. 运营用可判定的信号，未知结果优先恢复

以下指标与预算均为提议目标，不是测量结果。默认不增加模型调用；显式请求摘要才使用现有预算账本。URI/API adapter lazy-load，不把原生依赖引入 static export 的顶层路径。

| 信号                                          | 维度（低基数）                                                     | 初始阈值 / 动作                                                                           | 主责                      |
| --------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------- |
| `handoff.prepare/launch/receipt`              | product、operation、transport、OS、error class、qualification tier | 本地无模型 prepare p95 目标 <300 ms；尚无基线，P1/P2 测量；不将 app 启动计入纯 prepare    | Desktop maintainer        |
| `dispatch.policy_refused / ownership_refused` | caller surface、reason enum、runtime family                        | 正例误拒逐项诊断；任何串树成功立即关闭入口并调查                                          | Execution maintainer      |
| `dispatch.uncertain / recovery_required`      | transport、effect certainty、failure phase                         | canary 任一重复副作用或错误自动重放立即中止；unknown receipt 超 24h 进入可见待处理        | Execution maintainer      |
| `handoff.target_confirmed`                    | qualified target/version cohort、OS                                | canary 同组合 ≥20 次，投递/恢复失败 >5% 暂停扩量；无 ACK URI 不纳入 target-confirmed 分母 | QA owner                  |
| `run.waiting / resumed / stop_ack`            | runtime family、reason、control type                               | auth/input 不进入 completed；stop 超协议 deadline 标 unconfirmed，提示打开目标检查        | Agent protocol maintainer |
| `handoff.context_loss / return_dedup`         | loss kind、artifact kind、result class                             | 未披露 loss、digest mismatch、跨账号数据任何一例立即停操作                                | Handoff maintainer        |

日志只记录受控 ID/digest、目标与错误枚举，prompt/URL/path/native session 原值仅按需进入授权证据或账号/Host 作用域的私有恢复数据；账号/会话 ID 不用作 metric label。receipt 的 idempotency 是一次点击请求，不是相同内容永远去重；用户明确新建任务应生成新 requestId。单 source/target operation 同时仅一个 launch claim；查询/恢复有界并发与退避，不以轮询替代有协议的订阅。

runbook 至少包含：客户端未注册 scheme、版本失格、目录未授权、无效 native handle、CLI 会话被占用、prepared 过期、delivered 无目标确认、uncertain、A2A auth/input 等待、返回历史不匹配、patch 冲突。每个问题都给“检查哪条 receipt/run、查询哪一目标、何时可以重试、如何关闭操作”，不要求用户排查内部 API 名称。

## 15. 推荐决策明确，尚未验证的能力保留发布阻断条件

| 备选                                      | 取舍                                                         | 推荐                                                          |
| ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| 新建通用 HandoffManager，统一全部状态     | 会重复 run journal 与 two-phase ticket，草稿也可能被当作执行 | 不采用；共用上下文/准入，保留各语义所有者                     |
| 所有客户端先用 GUI/CDP 自动发送           | 可以绕过缺失公开入口，但维护成本高，无法可靠证明幂等/停止    | 不作为默认；Codex 既有控制单独资格化，未资格客户端仅草稿/导出 |
| 仅做 Deep Link，不修现有派发              | 短期 UI 可见，但已知 owner/约束/重试问题继续影响执行         | P0 前置，P2 可在其安全基线和 P1 完成后独立发布                |
| 共享 native session ID，跨 agent 自动转换 | 不能证明 native state/账号/权限兼容，容易伪造恢复            | 仅 verified binding + target contract；其余显式 contextual    |
| 一次全平台全客户端发布                    | 资格矩阵过大，单个上游回归拖累全部目标                       | 按 product/operation/platform 放量；未验收组合关闭            |

**Q1 首批默认范围。** 选项为五类官方草稿，或仅 Claude/Codex。推荐五类都进入 P2，按资格逐项开放；Claude/Codex 为先完成顺序，不删减其他三个的计划。

**Q2 自动执行的默认权限。** 选项为草稿默认、显式受管执行，或默认自动提交。推荐前者：只有具备 enforced policy、observe/control、结果和恢复资格的目标允许用户选择受管执行；草稿能力不升级权限。

**Q3 Codex compatibility 控制的维护范围。** 选项为保留并独立资格化现有控制，或长期只提供官方草稿与 snapshot 回流。推荐保留已有能力，补 send/interrupt 契约和实例隔离；未通过真实资格不扩大自动控制。若维护投入不获批准，P2/P3 和既有安全回流仍可独立交付。

**Q4 平台和资源承诺。** 选项为 macOS 先行、其余逐项资格，或多平台同步发布。推荐前者；第 13.2 节日历依赖资源/订阅/平台可用性，发布时未通过平台不显示 qualified。retention 的 24h/30d 默认值和实验性客户端开关随本项一起评审，不把未接受的残余风险记作 accepted。

| 评审 / 当前状态             | 日期       | 结论与条件                                                                  |
| --------------------------- | ---------- | --------------------------------------------------------------------------- |
| Codex 源码与结构自审        | 2026-11-17 | 计划覆盖 G1–G6、F01–F10、九类桌面目标、失败/迁移/回滚与 A01–A16；仅文档审查 |
| Execution / Protocol review | 待安排     | 实施前确认 owner fence、authority 求交、task/turn 状态和兼容策略；未签署    |
| Desktop / Host review       | 待安排     | 确认 native release/ACK、URI limits、跨平台与 Codex 专用控制；未签署        |
| Security / QA review        | 待安排     | 独立权限负例、真实 app/Host/device 证据和 kill-switch；未验收               |

| 待办                                                         | 单一负责人角色            | 提议 DDL（资源假设同第 13.2 节） |
| ------------------------------------------------------------ | ------------------------- | -------------------------------- |
| T01 确认实施基线、拆 WP01–15、重跑探针和失败 fixture         | Execution maintainer      | 2026-11-20                       |
| T02 完成 Q1–Q4 范围/资源评审，分配 migration/contract owner  | Technical lead            | 2026-11-20                       |
| T03 确认 disposable profiles、真实订阅、OS matrix 与证据规范 | QA owner                  | 2026-11-24                       |
| T04 完成 P0 基础修复及真实 manager 负例                      | Execution maintainer      | 2026-11-27                       |
| T05 冻结 P1 兼容契约、schema migration 与恢复测试            | Handoff maintainer        | 2026-12-04                       |
| T06 交付五类官方草稿资格记录与 UI                            | Desktop maintainer        | 2026-12-18                       |
| T07 完成 native / A2A / managed control 和隔离回流门槛汇总   | Agent protocol maintainer | 2027-01-08                       |
| T08 完成候选客户端 spike，并记录每项可用或关闭结论           | Compatibility maintainer  | 2027-01-15                       |
| T09 完成平台发布评审、双语文档、运行手册与回滚演练           | QA owner                  | 2027-01-22                       |

## Sources 与证据边界

仓内事实以 [审计 ledger](../evidence/2026-11-17-handoff-task-dispatch-gap-audit.md)、[runtime catalog](../../protocol/external-agent-runtimes.json)、[ADR-0103](../content/docs/en/adr/0103-cross-host-session-handoff.md)、[ADR-0252](../content/docs/en/adr/0252-a-room-talks-a-squad-works-a-delegation-promises.md)及第 2 节 owning source 为依据。探针的 collaborator 替换与 baseline 失败范围保留在 ledger；本计划不声称新功能测试已运行。

桌面主来源直接链接于第 3 节，核验日期 2026-11-17。VS Code HTML 文档本次刷新超时，采用已读的官方 vscode-docs owning source；Windsurf 与 Cursor Cloud 属原始问题/讨论证据；OpenCode PR 关闭不推断为技术否决或已在别处修复。资格测试应固定版本/commit，不以 mutable main 文档代替安装版本事实。

业内对照采用已有基础而非照搬框架：[OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/)提供执行控制交接的概念分离；[LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)提供持久化与副作用重放约束；[ACP session load](https://agentclientprotocol.com/protocol/session-setup)和 [A2A task lifecycle](https://a2a-protocol.org/latest/topics/life-of-a-task/)用于会话恢复、等待与终态契约对照。它们不证明任何 Cognia adapter 已有对应产品能力。
