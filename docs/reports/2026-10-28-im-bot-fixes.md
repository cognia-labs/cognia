# IM 与 Bot 十项问题修复及复审

日期：2026-10-28。依据：[原始十项审查](2026-10-28-im-bot-adversarial-review.md)。变更保留在共享工作区，未提交；保留了其他任务的修改。

## 修复结果

先完成 P1，再处理 P2。十项均有正式同目录回归；不使用 `.cache` 探针代替正式测试。

| ID  | 级别 | 最终行为                                                                                                                                      | 主要正式回归                                                                                     |
| --- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| F01 | P1   | IM 的 authority/autonomy 转为父 ceiling；Direct、Team、Workflow 均收窄                                                                        | `im-permission-ceiling.test.ts`、真实 Team handoff integration、`runtime.test.ts`                |
| F02 | P1   | Bot Workflow/Squad 继承 policy、preset、autonomy 上限；observe/human 不运行；恢复时沿用 policy checkpoint                                     | `ceilings.test.ts`、`run.test.ts`、两个 executor 测试、真实已发布 Workflow integration           |
| F03 | P1   | Bot producer、causation/depth 经 Workflow completion 延续；普通下游 Workflow 同时继承权限与 PII 要求，覆盖 version flag 1/0                   | `workflow-completed.test.ts`、orchestrator/fanout、真实 Bot→Workflow→Workflow→Agent integration  |
| F04 | P1   | 在所有 execution target 启动前检查 adapter/conversation mute、quiet hours                                                                     | `runtime.test.ts`，固定 UTC 窗口及 Team/Workflow 零启动断言                                      |
| F06 | P1   | 卡片描述、version/dependency lock 一起生成；plugin 也走 host 准备路径；点击固定版本；已停用部署拒绝新 admission                               | hold、approval handler、start-from-im、authority、plugin by-name integration                     |
| F05 | P2   | enforce 的消费与 accepted receipt 同事务；暂时失败由拥有 adapter 的 runtime 重试；固定幂等 invocation；admission 后 driver 启动故障仍可恢复   | callback authorization、handler 故障注入、recovery clock、bootstrap、authority orphan/abort 回归 |
| F07 | P2   | 出队复核静默、撤权、媒体授权；不能获得排队后新增的权限；保留原 session；plugin 委派继续继承实际 turn ceiling                                  | FIFO integration、permission resolver、真实 runtime 三 target、plugin integration                |
| F08 | P2   | event/manual/poll/schedule 共用声明策略投影；同 key 原子 claim 只能成功一个                                                                   | scheduler executor + event dispatch + Dexie claim integration                                    |
| F09 | P2   | latest 在同一事务去重、入队、淘汰；仅处理开放窗口、未启动的本地 pending；保留 all、运行、等待、重试及已结束窗口；迟到旧 dispatch 不淘汰新事件 | queue 与 dispatch integration，含资源/账户/trigger 隔离和重投不复活                              |
| F10 | P2   | connector 只核对 adapter，integration 只核对 integration account；错误账户仍拒绝                                                              | router 单测与混合凭据真实 installation/dispatch integration                                      |

Workflow approval receipt 为现有表的可选非索引字段，没有新增 Dexie schema/index。已接受的 pending/started 记录不因卡片 TTL 被清理；完成后保留消费记录，避免 redraw 复活旧决策。audit/off 继续保持 guard 不消费的契约，同时保存可恢复的 accepted dispatch。

## 对抗审查与处置

独立 IM、Bot 审查者在实现后检查真实调用链，并运行本地探针。另做 PII、接线和测试缺口审查。用户已明确跳过外部跨模型审查，本轮没有调用外部模型或发送消息。

复审发现并修复：排队新增工具授权扩大旧消息权限；plugin 卡片描述来自 editable draft；plugin 审批重算 live policy 而丢失当前 turn ceiling；已停用部署被 version lock 绕过；preset 强制 cap 遗漏；普通 completion 链及 legacy 分支丢失 security context；显式并发键跨资源/账户误合并；旧 dispatch 晚入队覆盖新事件；admission 与 driver 启动之间的故障窗口；orphan recovery 未贯穿 abort signal。新增或增强的回归覆盖这些交叉场景。

Bot 复核：5 个原独立反例转绿，5 suites / 114 tests 通过，未再确认范围内可操作缺陷。IM 审查三轮，第三轮最后发现的 orphan recovery signal 遗漏已修复，并在 authority 的 orphan 回归中验证 abort 不启动、下一次有效重试恢复同一个 invocation。遵循三轮边界，未启动第四轮；最后一项以定向回归收口。PII 审查未发现新增发送绕过，指出的权限问题均已纳入修复；接线审查确认 shared desktop/headless bootstrap 与 plugin 路径可达。测试缺口审查提出的实际三 target ceiling 交接及 recovery clock 启动/5 秒/不重叠/abort 测试已补齐并通过。

## 验证

- 最终扩展回归：**36 suites、992 tests 通过**；另 1 个 suite（`bus.test.ts`）在初始化阶段失败，原始 baseline 同样复现。因此该次广域命令整体 exit 1，不能写成全仓测试通过。
- 任务涉及的正式回归文件全部通过，包括原子消费、审批故障恢复、orphan/abort、三 target 权限交接、时区 suppression、真实已发布 Workflow 链、混合凭据、并发 claim 和 latest 事务。
- `pnpm lint`：**exit 0，零 warning**。
- `pnpm typecheck`：exit 2，11 条任务外诊断（Context Workbench 3、Claude Chat 4、Discord BigInt 4）；**任务路径 0 条诊断**。Root 检查失败后其串联 sidecar:typecheck 没有执行。
- `pnpm plugin:builtin:build`：exit 0。任务格式、diff whitespace 与台账检查结果一并记录在台账。
- `pnpm build`、`pnpm lint:static-export` 未通过，具体原因及实际验证边界如下。

已运行 `pnpm plugin:builtin:build`，Workflow AI 当前 chunk 为 `0edc27f4223f310291b35c480231ccaa6ee415a4ac3b23e1ff00d4b58978a6d1.cjs`；manifest SHA-256 相符，产物包含 `prepareWorkflowApproval`。标准 stage 同时刷新了当前 tree 的 Browser Tools chunk，未手工改写生成目录。

本地集成使用真实发布、admission、orchestration、router、队列及 IndexedDB 事务；环境 preflight、最终 Agent 服务等明确替换为本地测试依赖。它不证明真实模型、真实 IM 平台、跨 Host 或已打包桌面端验收。

## 验证限制与后续

- `pnpm build` 在 prebuild 被任务外 native bridge pin 不一致拦住：`native bridge source, compiled output, or dependency inventory differs from embedded pins; review and explicitly --pin`。未绕过或重写这些 pins。
- `pnpm lint:static-export` 报告 `packages/agent-codebuff`、`packages/agent-crush` 的 14 个 Node-only import；本轮未添加 Node/server import。
- 扩展 Connector 测试的 `bus.test.ts` 初始化 guard 失败，经原始 dirty baseline 的 bus 及 commands 重跑，仍在 `goal-headless-runner → build-options → integrations/events → trigger-bridge` 上复现，0 条测试进入；不是本轮 queue/approval 修改引入。没有屏蔽该 guard。
- 全量 typecheck 的任务外诊断及最终计数见下方结果；未修改其他任务的 Context Workbench、Claude Chat、Discord/QQ 等代码。
- 真实浏览器/桌面端和外部 IM/模型 smoke 未运行：全量构建受上述 pin 阻断，且没有现成 3000 服务。本轮没有用旧产物宣称真实 UI/外部平台验收。

原十项批次未纳入 multi-trigger cardinality、disarm 后取消语义和 per-trigger credential slot；这些已由下方续批处理。

## 证据入口

- [证据台账](../evidence/2026-10-28-im-bot-ten-findings-fix.md)
- `.cache/diagnostics/im-bot-fixes-2026-10-28/task-paths.json`：任务路径范围；`task.diff` 与 `baseline/` 为共享 dirty tree 对照，包含期间同文件并发编辑，不能整份作为 staging 清单。
- `regressions-final.json` / `.log`、`typecheck-final4.log`、`lint-final3.log`、`build.log`、`plugin-build.log`、`plugin-artifact-check.json`。
- `baseline-bus.log` 与 `bot-fresh-review/`：基线反证与独立复核。

## 2026-10-28 续批：剩余 IM / Bot 问题

本批按先交付身份与控制、再账户绑定的顺序完成。语义同步补充到中英 ADR-0174。

| 项目                    | 实现行为                                                                                                                                                                      | 主要正式回归                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 多 trigger 交付         | 身份改为 installation/trigger/event 三元组；同一事件每个匹配 trigger 独立交付；旧 receipt 仅复用其原 trigger，重投不重复执行                                                  | envelope、dispatch、router、bot-event-deliveries、runner                        |
| Disarm / pause / cancel | Disarm 停止未来 intake；pause 保留已接受工作并停止新 attempt，运行中的 attempt 可收尾；cancel 固定并终止已接受集合，失效审批并级联 Workflow/Squad，禁止 replay 和迟到结果复活 | installation、run、step、runner、Workflow/Squad executor、public replay         |
| IM 自动化控制           | `/automation pause/resume/cancel/status` 只控制该 conversation 的独立 Workflow/Bot observers；主 responder 的 mute/manual 保持原含义                                          | commands、automation-control、真实 bus FIFO、authority                          |
| Observer 恢复           | 接收及拒绝决定持久化；responder 完成后 observer 仍可恢复；恢复不重跑 responder；批量恢复排除不可用 adapter/满 conversation；长暂停恢复不误触发保留期清理                      | connector-inbound-jobs、bus.turn-queue、source、shared recovery clock/bootstrap |
| 多账户输入              | trigger 声明 `inputCredentialSlot`，安装 `triggerInputSlots` 可覆盖；路由、执行和 broker 都校验原来源与当前绑定；未绑定、歧义、来源不符时拒绝；输出槽位不会影响显式输入       | input-binding、dispatch、router、run、broker、local/host lifecycle              |
| 账户变更                | 重绑凭据或输入槽位取消已接受工作，避免旧工作换账户继续；本地及 host 校验共用规则；无歧义旧安装保留兼容路径                                                                    | lifecycle、host、broker、runner                                                 |
| 可操作界面与远端        | 控制台暂停/恢复、取消已接受工作、选择输入槽位；同一控制走 local/remote/companion owner route；旧 host 未声明 `bots.automation` 时不 relay                                     | RTL、hook、route、host、migration、sync                                         |
| SDK / 插件产物          | TS/Python 校验输入槽位和重复 trigger/credential ID；两个 GitHub Bot 和 PagerDuty 显式输入映射；GitHub manifest 与安装 ZIP 同步，builtin stage 更新                            | validator Bot tests、Python、first-party tests、ZIP 实际内容核对                |

### 对抗性复审收口

独立控制、账户、PII/权限审查与接线、测试缺口、i18n 审计均只读进行，未使用外部跨模型调用。本轮确认并修复的交叉问题包括：

- observer 在 responder 完成后丢失、暂停手交接后丢失、超过内存队列上限后不恢复，以及不可用 adapter 前缀饿死其他 conversation；
- 暂停期间拒绝的消息在恢复/重启后被补接；超过 14 天暂停的 observer 首次转交 Bot 时被当作过期工作清理；
- Workflow 在异步 admission 后覆盖已取消状态；foreign executor 在取消 heartbeat 前崩溃，恢复时丢失 `cancelRequestedAt`；显式取消与内部失败共用 abort 导致错误终态；
- cancel 结果被迟到运行写入覆盖、已取消 public replay 创建 successor、已脱离父 attempt 的 Workflow/Squad 子任务未停止；
- 旧 host 对 `paused:false` / 空映射漏做 feature 检查；同一个 install operation 重放忽略暂停/映射冲突；发布 ZIP 留着旧 manifest；
- 跨 Host bridge 只保留 Error.message，丢失账户错误的可翻译 reason。现在用有界稳定标记跨桥恢复类型，本地及远端共用现有翻译。

最后一项 foreign cancellation 在独立审查中复现后，先补正式失败回归，再修复 admission 事务，并通过最终 Workflow/control 回归。账户复审已确认三项反例关闭，未再确认剩余 P1/P2；PII 审查未发现新增绕过或无人值守提权。审查结果不等于真实平台验收。

### 续批验证结果

- 最终广域命令：**101 suites，100 通过、1 失败；2,347 tests 通过、1 失败**，整体 exit 1。唯一失败为既有 subagent `modelRoles.version=2` 拒绝断言；当前 `agent-contracts` 已接受 version 2。用 **HEAD 原 validator + 当前共享依赖** 在内存执行同一输入，也返回 valid/无 diagnostic；本批 validator diff 只新增 Bot 校验，没有修改该契约。未删除或弱化这个断言。
- Bot manifest 定向回归：**69 tests 通过**；最终 Workflow/control 复核 **4 suites / 129 tests 通过**，已包含 foreign lease cancel 和跨桥错误恢复。
- Python Bot SDK：**62 tests 通过**；三个第一方 Bot **51 tests 通过**；未运行 coverage。
- `pnpm lint`：exit 0，零 warning。i18n build、build:check、sort:check、lint:i18n 均 exit 0，新增中英文 key 覆盖已独立复核。
- author-types:check、companion command manifest gate、plugin:builtin:build 均 exit 0。两个 GitHub ZIP 与当前 manifest 一致，均含 `inputCredentialSlot: github`。
- 最终 `pnpm typecheck`：exit 2，**12 条任务外错误，任务范围 0 条**：Context Workbench 3、Claude Chat 4、Discord 4、并发 QQ 测试 1。Root 失败后的串联 sidecar:typecheck 未执行。
- static-export gate 仍为 Codebuff/Crush 的 **14 个任务外 Node-only import**；本批没有新增 Node/server import。
- `pnpm build` 仍在 native bridge pin 校验失败，未进入应用编译；`pnpm dev` 同样被 predev 阻断。未绕过、重写 pins，也未使用旧产物冒充验证。

真实浏览器/桌面、真实跨 Host RPC、外部 IM 和模型端到端 smoke **尚未验证**。需要先由 native bridge 变更的拥有者审阅并修复 pins、恢复全仓 gate，再在准备好的桌面/Host 和授权测试账户验收。本批没有提交、推送或发送外部消息。

续批诊断根目录：`.cache/diagnostics/im-bot-remaining-2026-10-28/`。`regressions-final.json`、`final-cancel-controls.log`、`bot-validation-final.log`、`python-tests.log`、`validator-baseline.log`、`typecheck-final2.log`、`lint-final2.log` 和 `plugin-artifact-check.json` 保存真实结果。`task-paths.json` / `task.diff` 用于共享 dirty tree 范围核对，不能作为整份 staging 清单。

## 2026-10-28 再续批：取消等待与 observer 失败恢复

本批继续处理运行边界，修复了三组可复现漏项：

1. **暂停等待不响应取消**：Workflow 现在会观察 caller AbortSignal、run 的 cancelled 状态及 foreign-lease cancelRequestedAt；新 admission、legacy 和 orphan recovery 都传递同一取消上下文。取消后不会启动 executor；caller 中断保留 pending admission，恢复仍复用同一个 run。
2. **读取阶段仍可能挂起**：阻塞的首次 IndexedDB 读取也可被 abort；数据库关闭时不会被 Dexie liveQuery 吞错而永久 pending。独立探针和正式回归覆盖首次读取、关闭错误及 listener/subscription 清理。
3. **Workflow observer 失败被当作完成**：matching/admission 抛错会保留 durable receipt，恢复仍使用原 occurrence，不重跑 responder。兄弟 transfer 全部结束后才推进 FIFO。新增可选、非索引的 completeJobOnSettle 保存 intake 时的完成责任，原子完成 observer-only job；startup 不会把它转交给后来安装的 responder，也不会覆盖主 responder 或 recovery_required 状态。没有 Dexie schema/index 迁移。

取消等待的独立对抗审查做了三轮，先后发现首次读取 abort 窗口和 Dexie 吞闭库错误，均先红后绿修复；第三轮未再确认 P1/P2，独立探针的 abort listener 残留为 0。Observer transfer 三轮审查发现并修复“receipt settled、job 仍 queued”及 startup responder 重放；额外通过 public recovery 重现 stale snapshot 竞争，并改为以事务提交后的完成所有权决定是否启动 responder。最后未再确认 P1/P2。PII 复核未发现新 bypass、payload 改写或 unattended 提权。测试缺口审计提出的 legacy、orphan 和 marker-only 分支均已补上。

新增 `tests/e2e/bots/control-plane.spec.ts`，因为此前没有 `/bots` 浏览器路径。两条 `@critical` 用例覆盖配对 UI → transport → Host fixture 的暂停/恢复、输入槽位、reload、旧 Host 禁用，并检查准确签发的 adminLease、独立 gesture UUID，以及暂缓 Host snapshot 时 UI 不抢先改变。Fixture 的 TTL 与生产默认 600 秒对齐。它不证明 Rust 授权或真实 IM。

本批实际验证：

- **14 suites / 319 tests 通过，exit 0**。包括真实本地发布/admission/IndexedDB/FIFO 与故障注入；外部模型和平台服务没有调用。
- `--detectOpenHandles`：**2 suites / 48 tests 通过，exit 0，无 persistent handle 诊断**。普通 Jest 个别运行的一秒退出提示已专项检查，没有使用 forceExit 或清空全局 timer。
- **本次范围 ESLint exit 0，零 warning**；scope 格式、diff whitespace 与 ledger 检查通过。全量 `pnpm lint` 曾 exit 0，最后一次因并发 QQ `serialize.ts` 的 `encodeQQMessageId` unused-symbol warning exit 1，未修改该并发工作。
- Playwright discovery：**exit 0，发现 2 tests / 1 file**。E2E governance：exit 0，0 新 finding，14 项原 tracked debt。
- **浏览器用例未执行**：`pnpm test:e2e:build` 和目标 `pnpm test:e2e` 均在 native bridge pin 检查退出，应用编译及用例均未开始。未绕过或重写 pins；没有拿旧 out/ 作为证据。
- 最终 `pnpm typecheck`：exit 2，**11 条任务外错误、当前增量 0 条错误**（Context Workbench 3、Claude Chat 4、Discord 4）。其串联 sidecar:typecheck 未执行。

真实浏览器、桌面、跨 Host 和外部 IM 验收仍未完成。需要先修复 native bridge pin 阻断及现有全仓类型错误，再执行新 browser journey 和准备好的真实 Host/IM smoke。未提交、推送、运行 coverage 或额外跨模型审查。

本批证据根目录：`.cache/diagnostics/im-bot-hardening-2026-10-28/`，结果汇总为 `final-summary.json`；失败反例、最终测试、句柄检查和浏览器阻断日志均保留。`bus.ts` 中同期新增的 referral audit 字段及 connector-status 类型属于并发工作，已保留，不计入本批修复。

补充 sibling 回归分别门控 Workflow 和 Bot：同一批另一个 Workflow 先失败，后一个 occurrence 仍需等门控 sibling 结束。三个旧 system-trigger 测试改为等待确切可观察调用，消除单个零延迟 timer 的时序假设。最终广域结果见 `regressions-all-final3.json`；最新全仓类型检查见 `typecheck-all-final3.log`，范围 lint 为 `lint-scoped-final.log`。
