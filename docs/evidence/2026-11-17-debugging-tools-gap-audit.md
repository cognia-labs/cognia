# Evidence ledger: debugging tools gap audit

- Status: verifying
- Lane: standard
- Created: 2026-11-17
- Updated: 2026-11-17
- Related: ADR-0074, ADR-0102, ADR-0135; 2026-11-12-agent-observability-completion.md

## Original request

> 帮我分析一下现在的调试工具的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

## Knowledge

| ID  | Statement                                                                                                                              | State        | Basis                                                                                                                                                    | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Source contains unified logs/traces/incidents, performance captures, plugin/browser devtools and diagnostic submission.                | Verified     | Owning sources, runtime mounts, focused tests and ADR-0074/0102/0135, 2026-11-17. Source inventory is not real-shell acceptance.                         | -          |
| H1  | Debug-data boundaries can lose, mis-time or misattribute evidence; some public-API risks are dormant.                                  | Verified     | Original eight counterexamples re-run; adversarial Node/Rust probes and fresh source review, 2026-11-17. Scope distinctions recorded below.              | O1         |
| H2  | Diagnostic privacy policy differs across builders, exports and native packages.                                                        | Verified     | Current redact source confirms conditional header issue; actual package plus pinned-service privacy probe confirms compressed-event gap. No live upload. | O1         |
| G1  | Deliver existing capabilities, confirmed problems, missing capabilities, industry comparisons and an ordered roadmap.                  | Agreed       | Explicit user request, 2026-11-17.                                                                                                                       | -          |
| C1  | Audit only: preserve concurrent work, change no product behavior, transmit no user diagnostics, do not commit/publish.                 | Verified     | Authorized analysis scope and shared-tree instructions, 2026-11-17.                                                                                      | -          |
| A1  | Debugging tools means Cognia integrated developer/operator tools, including browser/plugin/workflow debugging and product diagnostics. | Hypothesized | Repository context and broad user wording.                                                                                                               | G1         |
| Q1  | Which capabilities pass real Tauri/Capacitor/provider/collector acceptance?                                                            | Open         | Headless/source evidence cannot establish cross-platform acceptance, 2026-11-17.                                                                         | O1         |

| G2 | Adversarially review the audit, correct unsupported claims and add missed counterexamples. | Agreed | Explicit follow-up request: 做一次对抗性审查, 2026-11-17. | G1 |

## Problem frame

Assess capture accuracy, cross-runtime correlation, failure inspection, safe export, reproducibility and fix validation (G1, A1). A panel inventory alone cannot establish usable debugging (H1, H2). Success is a reproducible audit with precise source references and primary-source comparisons. Product repairs and real diagnostic uploads are outside scope (C1).

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                     |
| ------------ | ------ | ----------------------------------------------------------------------------------------------- |
| scale        | high   | Renderer, logging packages, Rust/sidecar, browser/plugin/workflow tools and a separate service. |
| technical    | medium | Existing contracts/tests are inspectable; retry, timing and context need probes.                |
| coupling     | high   | Shared static export; cross-runtime trace, privacy and submission contracts.                    |
| requirement  | medium | Broad audit request; A1 states working scope explicitly.                                        |
| verification | high   | Logic is headless-verifiable; native/mobile/provider/deployed service acceptance is separate.   |
| risk         | low    | Synthetic audit only; findings concern high-impact privacy/reliability boundaries.              |

## Risks

| ID  | Risk (impact)                                                                   | Severity | Source                                                                    | Claim                                                                     | Refuted by                                                                            |
| --- | ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| R1  | Mistake scaffolding for working debugging or overlook existing functionality.   | medium   | ADR-0102/0135; catalog:wiring                                             | Audit follows actual producers, consumers and entry points.               | A claimed absence has a wired implementation or a claimed capability has no producer. |
| R2  | Incident evidence is silently lost, mis-timed or assigned to another operation. | high     | ADR-0102; OpenTelemetry context propagation/resiliency; independent sweep | Metrics/identities retain real meaning and losses are visible.            | Controlled retries, concurrency or known-duration requests create false records.      |
| R3  | Diagnostic export sends secrets/user content outside intended consent.          | high     | ADR-0074/0102; independent failure hunt; Sentry privacy docs              | Local inspection, export and submission policies are assessed separately. | Synthetic sensitive values survive a path advertised as scrubbed.                     |
| R4  | Overstate source/unit evidence as real-shell or service acceptance.             | medium   | Catalog:cross-shell; evidence skill verification reference                | Every conclusion states evidence scope.                                   | Report marks an unexercised environment verified.                                     |

| R5 | The audit itself overstates absence, severity or production reachability. | medium | Three fresh reviewers; doubt-driven contract | Findings separate runtime scope, conditional API behavior and live acceptance. | An existing production alternative or constrained caller refutes a broad claim. |

## Verification obligations

| ID  | Risk   | Method                                                                              | Independence | Evidence                                                                                                                                          | Coverage                                                                                                                                                                | Status  |
| --- | ------ | ----------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1     | Inspect source, wiring and tests for every debugging surface.                       | tool         | Owning paths and line references in capability inventory and findings below; two bounded read-only sweeps completed 2026-11-17.                   | Current checkout, not a shipped release; absence claims restricted to inspected interfaces.                                                                             | passed  |
| V2  | R2, R3 | Run synthetic production-module probes for loss, identity, timing and privacy.      | tool         | node --test docs/evidence/2026-11-17-debugging-tools-gap-audit.probes.mjs: 8 passed, 0 failed; .cache/debugging-tools-gap-audit/probes.log.       | Counterexamples document existing failures; TS production source compiled with native IPC/storage/timer ports substituted; overlay runs in jsdom; no user data/network. | passed  |
| V3  | R1, R2 | Run focused existing Jest/Node suites.                                              | tool         | Repository scripts/test/jest.mjs --runInBand --runTestsByPath (nine paths listed below): 9 suites / 142 tests passed, 7.441 s; focused-jest.log.  | Existing boundary regression tests; does not negate counterexamples or establish real-shell behavior. No coverage run.                                                  | passed  |
| V4  | R1, R3 | Compare official OpenTelemetry, Chrome, VS Code, Sentry and Langfuse documentation. | tool         | Primary pages fetched 2026-11-17 and linked in comparison/Sources below. Context7 monthly quota exceeded; official web docs used.                 | Workflow comparison, not procurement advice or a demand to embed complete IDE/DevTools functionality.                                                                   | passed  |
| V5  | R4     | Validate ledger and review final claims/diff/status.                                | tool         | ledger.mjs check --final: 0 errors / 0 warnings; Prettier check and node --check passed; scoped status contains only the two new audit artifacts. | Audit artifacts only; shared unrelated edits preserved.                                                                                                                 | passed  |
| V6  | R4     | Exercise real Tauri/Capacitor/provider/collector workflows.                         | real-env     | Not executed in this audit; no verified provisioned cross-platform/service setup.                                                                 | No real native crash/upload, provider, browser WebView, mobile or collector acceptance established.                                                                     | blocked |

| V7 | R1, R4, R5 | Fresh-context adversarial review of finding tables, consumers and probe semantics. | fresh-reviewer | Three bounded reviewers; runtime scopes/caller constraints corrected; concrete new issues recorded below. | Native/privacy, browser/plugin/workflow, API/probe boundaries; no author Decisions passed. | passed |
| V8 | R2, R3, R5 | Deterministic adversarial probes plus focused regressions and actual Rust packaging/privacy experiment. | tool | 13 Node scenarios passed; 3 suites / 43 existing tests passed; offline Rust exit 0 with hash/incident mismatch and decoded sensitive compressed events. | Synthetic inputs only; pinned server source, not deployed service; no real UI/upload. | passed |

## Decisions

| ID  | Date       | Decision                                                                                                                          | Action   | Based on       | Reversal trigger                                                                           |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------- | ------------------------------------------------------------------------------------------ |
| D1  | 2026-11-17 | Diagnose toolchain and write audit; no repairs. Use skill-authorized read-only sweeps and fresh failure hunt.                     | diagnose | G1, C1, O1     | User changes scope or requests implementation.                                             |
| D2  | 2026-11-17 | Prioritize privacy and evidence correctness before new debugging panels; preserve existing replay/evaluation/performance systems. | diagnose | G1, O1, H1, H2 | New production evidence refutes a finding or establishes a higher-impact missing workflow. |

| D3 | 2026-11-17 | Reopen scope/severity claims; lower F02 to P3, narrow G02/G04/G05 and F06/F10/F13; add F14-F16 and adversarial evidence. | diagnose | G2, C1, O1, H1, H2 | New source or real-environment behavior contradicts a corrected claim. |

## Residual risks

| ID  | Residual                                                                                           | From       | Why still open                                                                                                                                              | Next action                                                                                       | Status |
| --- | -------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| X1  | Audited product defects and conditional API hazards remain unfixed.                                | R2, R3, R5 | User requested analysis and adversarial review, not implementation.                                                                                         | Implement the revised roadmap with failing behavioral regressions and acceptance.                 | open   |
| X2  | Real-shell/provider/service acceptance remains unverified.                                         | V6         | Source and deterministic headless checks cannot establish native/mobile/deployed behavior.                                                                  | Execute the bounded acceptance scenarios below in provisioned environments.                       | open   |
| X3  | Production JS symbolication, UI replay and actual deployed-service acceptance are not established. | R1, R4     | Pinned service privacy code has now been checked at revision 487e9f2d617c9d1b9b648ec510cafcf53b962c2c; actual deployment/build artifacts remain unverified. | Test known production stacks and deployed versions; do not generalize native symbolication to JS. | open   |
| X4  | F10 is a dormant public-API hazard, not proven current app trace contamination.                    | H1, R2     | Fresh review found no app production spanAsync/withSpanAsync consumers; explicit scoped loggers preserve identity.                                          | Guard the API and verify any future consumers.                                                    | open   |

## Outcome

| ID  | Signal                                                                                     | How / when measured                                               | Result                                                                                         | Status |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| M1  | User can distinguish defects, conditional API issues, capability gaps and validation gaps. | Initial audit followed by fresh adversarial review on 2026-11-17. | Revised to 16 records; F02 downgraded, runtime scopes corrected, three missed P2 issues added. | met    |

| M2 | Adversarial review changes overbroad claims and exposes missed failure modes. | Fresh reviews reconciled against source and synthetic experiments, 2026-11-17. | Three new P2 records; constrained header issue downgraded; existing alternatives and conditional APIs explicitly scoped. | met |

## 调试工具缺口审计

审计日期：2026-11-17（Asia/Shanghai）。对象是当前共享工作区的源码，包括尚未提交的改动，不代表某个已发布版本。未修改产品逻辑、未提交、未向诊断服务发送用户数据。

**结论：已有工具的覆盖面较广，最迫切的缺口是证据质量与调试闭环。** 当前能看到日志、Trace、资源指标、Crash、Workflow 执行和插件输出，但一些边界会丢字段、显示错误数值、混合不同执行实例，隐私处理也没有贯穿每一种报告。优先修复这些问题，比继续增加独立面板更有价值。

经对抗性复核，本轮记录 **16 条审计问题：12 条有合成反例（含条件性公共 API），4 条为源码调用链证据**。它们不是 16 项已在线上复现的缺陷。反例通过意味着成功观察到缺陷，不意味着产品已修复。另列 6 组能力缺口和 2 组验收缺口；没有用“搜索没找到”代替跨平台验收。

### 已有能力与真实边界

| 领域             | 当前已实现的能力                                                                                     | 主要依据与边界                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日志与事故       | `/logs` 汇总 Logs、Traces、Diagnostics、Incidents、Service；支持运输层健康、筛选、详情、关联跳转。   | `components/logging/diagnostics-workspace.tsx:61`、`:100`；`lib/logging/bootstrap.ts`。已有统一入口，不能再算作“缺一个日志中心”。                                                                 |
| Agent Trace      | 查询、分页、瀑布图、时间线、Span 详情、token/cost/error、JSON/OTLP 导出；详情独立读取完整 Trace。    | `components/logging/trace-workspace.tsx:312`、`:371`、`:607`；`lib/db/agent-traces.ts:151`。窗口读取上限 20,000 条且有截断提示、读取失败/重试，不是无提示截断。                                   |
| 性能诊断         | 系统/进程/Renderer 指标、Web Vitals、操作耗时、Capture、比较、与 run/trace 关联。                    | `components/performance/performance-dashboard.tsx`；`lib/perf/capture-controller.ts`、`capture-portability.ts`、`execution-correlation.ts`。进程资源是共享观察，不应当解释成单次 Agent 独占资源。 |
| Workflow         | 单节点执行、从步骤重跑、上游输出 seed、pinned data、历史 replay、输出和 retry/usage。                | `lib/workflow/runtime/step-executor.ts`、`lib/workflow/runtime/loop-container.ts`；`components/workflow/runs/`。已有重跑，不等同于可暂停的交互断点调试。                                          |
| 插件工具         | Dev Session、watch/hot reload 诊断、Managed IDE、frontend/Python/VSCode 日志汇流与 generation 隔离。 | `components/plugins/devtools/plugin-devtools-pane.tsx`；`lib/plugin/devtools/runtime-log-stream.ts:82`。WASM 没有对应日志通道。                                                                   |
| 内置浏览器       | Console/Network 面板、bounded ring、清空、丢历史和截断提示；支持 embedded push 与 Chromium pull。    | `hooks/browser/use-browser-devtools.ts`；`components/browser/browser-devtools-panels.tsx`。后端能力不同，不能把本地 Chromium 的能力外推到 embedded/remote。                                       |
| 评测与修复验证   | 真实 Trace 标注、failure taxonomy、存入 dataset、实验执行与评测。                                    | `components/eval/trace-annotation-panel.tsx:75`、`:137`；`components/eval/eval-lab-workspace.tsx:917`。不存在“完全没有 Trace → Dataset”的缺口。                                                   |
| Tauri 自动化调试 | 独立 agent-debug 启动/客户端、evaluate、截图、输入、窗口等调试能力。                                 | `scripts/tauri/agent-debug*.mjs`；`src-tauri/src/agent_debug.rs`。`cli_bridge/server.rs:146`、`:164`、`:177`、`:199` 有 feature gate、loopback、token 与 shared-mode 限权，本轮未证明权限漏洞。   |

### 问题清单

优先级是本次审计的建议：P1 优先处理隐私边界；P2 处理会误导定位或丢证据的问题；P3 是低频/受限路径或产品反馈问题。没有证据支持把本轮问题定为 P0。

| ID  | 建议 | 问题、触发条件与影响                                                                                                                                        | 证据级别                                                                             |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| F01 | P1   | Desktop raw crash report 未统一客户端 scrub；其 zstd events 在 pinned service 的解压前扫描中保留敏感内容。需已有手动/自动提交授权；不表示默认上传全部材料。 | 源码调用链 + 本地 Rust 组包/服务端 privacy 反例；无真实上传                          |
| F02 | P3   | Support report header 未统一 scrub；合成敏感值可绕过。但生产 category/locale 受限、route 为 pathname，尚未证明实际 caller 向 header 提供敏感值。            | 已运行 builder 边界反例；生产可达性未证明                                            |
| F03 | P2   | Native log 并发发送失败后积累多批数据；下一次失败只保留一个 batch，其余丢弃且 droppedEntries 保持 0。                                                       | 已运行反例：4 条 → 2 条                                                              |
| F04 | P2   | Embedded browser 用事件计数差作为 durationMs，慢请求和旁路 Console 活动都会被错误解释。                                                                     | 已运行 exact-overlay 反例                                                            |
| F05 | P2   | Embedded Console 直接 JSON.stringify(Error)，普通 Error 的 message/stack 变成 `{}`，错误记录失去定位价值。                                                  | 已运行 exact-overlay 反例                                                            |
| F06 | P2   | Plugin Dev Session 视图归一化丢弃 args/stack；原始 debug ring 与普通 /logs 另有数据来源。原始 Error 还可能更早被 JSON safeClone 丢详情。                    | 已运行投影反例；不能外推为所有日志全局丢失                                           |
| F07 | P2   | 普通 Workflow 执行的 resolved params 被记录为 {attempt}。Pinned 分支不运行 executor，却把 {pinned:true} 标成 resolved params。                              | 源码生产调用链；pinned 属于标签/来源错误                                             |
| F08 | P2   | Workflow inspector 只按 stepId 聚合，不同 retry/loop execution 的首次输入/错误与最后 terminal/usage 混合。部分失败/stream 事件本身也缺 execution identity。 | 源码生产调用链；不等于全局 usage 聚合错误                                            |
| F09 | P2   | Renderer → native platform log 转发丢弃 spanId/parentSpanId/executionId/requestId，剩下 traceId 无法在该通道精确关联到 Span。                               | 已运行生产传输反例                                                                   |
| F10 | P3   | Legacy ambient async 公共 API 的全局栈存在并发污染；本轮未找到 app 非测试生产调用，显式 scoped logger 有隔离。                                              | 已运行 API 反例；dormant API hazard                                                  |
| F11 | P2   | 同一 Crash 重试重建 UUID/time 和 artifactHash，不能复用同包续传。首次 create 已成功而后续失败时才产生重复/部分远端 incident。                               | 本地实际组包反例：hash/incident ID 不同；无真实服务请求                              |
| F12 | P2   | 同秒同类 caught panic 可顺序覆盖 txt/json；native monitor 单次退出，dmp 碰撞主要涉及多进程/快速重启。                                                       | 源码链；不是一个 monitor 连续处理多个 native crash                                   |
| F13 | P3   | arm 写入失败仍返回新 session；空存储时未开启，已有 session 时旧 scope/TTL 可能继续生效。UI 没有假成功 badge，但缺失败说明。                                 | 原反例 + 真实 Storage quota 与保留旧 session 反例；scope narrowing 属于 API 条件风险 |
| F14 | P2   | Canonical log append 失败时 batch 被丢弃，close 仍 resolve；只有 console.warn，未保留失败 batch/完整性状态。                                                | 已运行生产 sink + 实际 envelope/projection/redaction 反例；不要求阻断 chat           |
| F15 | P2   | 同 session 后续 turn 的 Trace 被赋予第一条用户请求，导入 Eval 后复现了错误输入。                                                                            | 已运行生产 resolveTracePrompts 反例；hook/import/annotation 可达                     |
| F16 | P2   | Workflow stepFailed producer 只保留 message/retryable，丢掉 Error stack；inspector 预留的 stack 区通常无数据。                                              | 源码生产调用链                                                                       |

#### F01–F02：诊断信息的隐私边界不一致

F01 的用户承诺来自 `i18n/messages/en/logging.json:1040`：预览是 local/redacted payload。但 `hooks/logging/use-diagnostic-incidents.ts:245` → `crates/cognia-observability/src/crash/commands.rs:73` 直接读取原报告；`crash/submit.rs:194` 把完整报告放入 events，`:269` 附带原始文本，`:317` 写入 description；`diagnostic_package.rs:162` 的职责是读取、打包，而非内容脱敏。`crash/panic_hook.rs:49` 保留原始 panic message。

服务端接收后扫描无法阻止数据先离开设备。已有 minidump/screenshot 默认关闭及明确 consent 是有效措施；问题在必传文本的内容处理和“已脱敏”承诺，不能外推为所有附件均无授权发送。建议在组包前统一执行 privacy manifest + scrub + fail-closed final scan，并让 UI 预览与真正上传使用同一份规范化结果。

F02 已降为 P3 条件性 builder 边界问题：实际 error-report caller 的 category 是固定枚举，locale 受限，route 来自 usePathname；未找到实际敏感 digest 赋值。原合成输入不证明真实 UI 已可达泄漏。F02 在 `lib/support-report/build.ts:65`–`:75` 拼 header，`:82` 只 scrub body，`:88` 只 scrub title；`channels.ts:60` 起直接使用 Markdown。合成 route `/probe/jane.doe@example.com` 与 digest `Bearer synthetic-only-test-token` 均保留，最终 `hasNoLeakingPii(markdown)` 为 false。需要覆盖整个输出与 registry heading，而不只是正文。这里证明的是输入边界缺陷，没有测量当前生产 route/digest 包含敏感值的发生率。

#### F03、F09–F10：保存了日志，不等于保留了可信关联

`lib/logging/transports/native-transport.ts:78` 取走全部 buffer，`:94` 失败后只放回 `entries.slice(0,batchSize)`。两批并发失败后队列可包含 4 条；重试再次失败只保留 2 条，`:95` 的 health 更新没有累计丢弃数。修复应明确单批上限、串行 in-flight、重试顺序、队列边界与丢失计数，而不是增加无限重试。

同一文件 `:82`–`:89` 只转发部分字段；`lib/native/native-logging.ts:28` 的 payload 也没有 Span/execution 字段。这局限于 platform log 路径，不代表独立 OTLP Trace 通道不支持 W3C propagation。

`packages/logging/src/context.ts:153` 的 async Span 栈跨 await 共享。反例中 A、B 并发时 A 读到 B；A 结束弹出 B 后，B 又读到 A。`core.ts:456` 的 scoped logger 显式保存自己的 Span，可以避免这类污染；`:533` 的非 scoped fallback 仍读取 ambient state。当前非测试 app 源码未找到 spanAsync/withSpanAsync 的业务调用，所以将其保留为 dormant API hazard；建议限制 legacy API，不能据此声称现有 Agent Trace 已被污染。

#### F04–F06：调试工具本身改变了证据含义

`lib/browser/overlay.injected.js:2225` 初始化 tick，`:2288`/`:2300` 对 fetch、`:2324`/`:2339` 对 XHR 用计数差生成 durationMs。实际 probe 延迟约 121ms 的请求记录为 1ms；另一个请求插入 10 条 Console 后记录为 11ms。面板 `browser-devtools-panels.tsx:144` 把它显示为毫秒。应分离事件顺序和单调时钟计时，并声明仅计到 response headers 还是包含 body。

同文件 `:2236` 的 fmtArg 对 Error JSON.stringify，得到 `{}`。需要有界序列化 Error 的 name/message/stack/cause；循环对象、DOM、BigInt 也应有明确的降级与截断标记，不能让字符串化失败抹掉错误。

PluginDebugger 在 `lib/plugin/devtools/debugger.ts:105` 保存 message、args 和 stack，但 `runtime-log-stream.ts:104` 的 normalized schema 没有 args/stack。`plugin-dev-session-workbench.tsx:444` 只显示归一化 message。建议保留有界结构化 payload 与详情展开，并复用现有 redaction，而不是通过拼接无限长字符串补救。

#### F07–F08：Workflow 缺少执行实例级的正确观察

`lib/workflow/runtime/step-executor.ts:255` 真正执行 resolvedParamRecord，但 `:310` 把 `{attempt}` 传给 stepStarted；`event-log.ts:261` 将其包装为 payload.params；`components/workflow/runs/run-step-detail.tsx:149`、`:286` 将该字段显示为 resolvedParams。Pinned 分支在 step-executor `:183` 则记录 `{pinned:true}`，但该分支根本不调用 executor；问题是标签/fixture 来源错误。需要分别保存实际 resolved inputs 与调度元数据，并处理输入敏感性。

RunStepDetail `:63` 只按 stepId 筛选，`:64` 使用第一个 start，`:65` 使用最后 terminal，`:144` 使用第一个 completion/error；usage 又取最近记录。Loop runtime `loop-container.ts:486` 复用 child.id 并附加 iterationMeta；step-executor 已产生 stepExecutionId。应以 stepExecutionId/iteration/attempt 选择一个执行实例，聚合摘要与单次详情分开展示。普通 retry 已可触发混合，不必依赖循环；stepFailed/stream producer 也需先补 identity，单改 inspector 不够。

#### F11–F13：重试与复现的生命周期还不完整

`crash/submit.rs:330`–`:331` 每次创建新 UUID/time，`:459` 每次 submit 重新 build，临时包最终删除；`diagnostic_submit.rs:450` 对整个包求 hash 并据此创建/续传 incident（`:475`）。底层“同一个 package”的续传已经存在；需让上层持久保存稳定包与上传进度，避免每次“重试”变成新事故。

`crash/report.rs:103` 文件名只精确到秒，`:229`–`:230` 覆盖写入。增加碰撞安全标识和防覆盖创建，并测试同秒多记录；若一份报告的两种格式部分写入失败，还应报告证据完整性。

`lib/observability/debug-session.ts:157` 吞掉 storage failure 后仍在 `:164` 返回 session；`components/settings/sections/usage-cost-section.tsx:228` 不反馈失败。UI 从真实 snapshot 读取，所以不是“错误显示已开启”；准确问题是写入失败无解释、函数返回值不代表成功；如果此前已有 active session，失败的替换不会将其关闭，旧 scope/TTL 会保留。需要区分 armed/storage-unavailable/quota 等结果并支持重试。

### 功能与验收缺口

| ID  | 缺口                                                             | 当前边界                                                                                                                                                                                                                         | 建议完整行为                                                                                                                                                   |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01 | 浏览器请求检查流较浅                                             | 人工面板只有 Console/Network 列表与清空，没有请求详情、header/body、筛选、sanitized HAR。Local Chromium 的 `networkRequest` 已存在（`local-chromium-engine.ts:461`）；remote `:250`、embedded `agent-engine.ts:555` 明确不支持。 | 先接出已有 local 请求详情；统一 capability 表，清楚显示不支持原因，再补筛选、timing、redacted HAR/复现材料。                                                   |
| G02 | Native Monaco/vscode-shim 没有 DAP；Pro IDE 是另一条已实现路径   | Native shim 抛 NotSupportedError；Pro IDE/code-server 的 protocol-adapters.ts:728-805 已注册真实 VS Code adapter，extension.ts:199-221 激活；editor-engine-toggle.tsx:79-113 有 local VS Code fallback。                         | 展示 runtime capability 与已有替代路径；若确需 native DAP 再补实现，不能把整个 Cognia 判为无调试器。                                                           |
| G03 | Workflow/插件缺少交互断点                                        | Workflow 已有重跑、replay 和 pin；plugin debugger 明确是日志收集，旧的假 breakpoint/watch API 已移除。                                                                                                                           | 若实际用户需要，增加有状态的 pause/resume、按执行实例 step、条件断点/logpoint；需验证恢复后不重复外部副作用。不要重新添加空接口。                              |
| G04 | WASM Host 日志尚未接入 Dev Session drain                         | wasm/capabilities/logger.rs:30-52 已有带 plugin_id 的有界 structured tracing；WIT since_v0_2.rs:67-81 已调用。缺的是 renderer per-plugin/per-generation 历史/订阅。                                                              | 复用 Host logger，补 renderer bridge、sequence 与代际隔离；不再建议重造 Host logger。                                                                          |
| G05 | rawBodies 是未消费的 API tier 声明                               | debug-session.ts:36 声明该 tier，生产消费者只检查 deltas/prompts/toolDetails；当前 UI 没有独立 rawBodies 开关。                                                                                                                  | 移除/明确标记未实现的 API tier；实现前定义范围、上限、TTL、local-only 和 producer 验证。                                                                       |
| G06 | 失败 Span 到可重现实验入口不足，现有 prompt 对齐还存在正确性问题 | Span detail 可跳日志/session/performance；Eval 已能导入 Trace，但 trace-prompt.ts 把第一条 user message 分给同 session 所有 Trace（见 F15）。replay-bundle helper 未见 UI 调用。                                                 | 先按 run/turn/message 正确关联输入，再打通 generation 到现有 Eval；不另建评测引擎。                                                                            |
| U01 | 生产错误源码定位能力尚未证明                                     | 本仓 inspected Next/build/release surfaces 未找到 JS source-map 产物发布与 build/debug ID 关联；native minidump 和服务端 symbolication 设计存在。                                                                                | 用一次已知生产 JS 错误、一个 native minidump 验证源码文件/行号可还原；先核对 pinned service 和实际 release 产物，不能直接宣称“完全没有符号化”。                |
| U02 | 问题发生前的操作上下文/跨端验收缺证据                            | 存在 breadcrumbs、crash events、captures；本轮未证明有完整脱敏 UI replay，也未跑 Tauri/Capacitor/真实 provider/collector 流程。                                                                                                  | 优先本地、短时、有 consent 的 navigation/action/network breadcrumbs 和失败前后 evidence window；只有定位仍不足时再考虑 DOM replay，避免默认录制聊天/文档内容。 |

### 对照业内实践

以下是工作流基线的比较，不是要求 Cognia 内嵌整个 Chrome DevTools、VS Code 或托管平台。

| 参照            | 优秀实践                                                                                                  | Cognia 已有                                                       | 差距与建议                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenTelemetry   | 通过 trace/span context 关联信号；跨进程显式传播；队列、持久化、重试与 loss metrics 有明确定义。          | W3C propagation、OTLP、spool、transport health、统一事件契约。    | 修 F03/F09/F10；检查所有 debug 数据边界字段守恒，loss 可观测，队列失败不伪装为成功。[Context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)、[Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/)。                                |
| Chrome DevTools | 选中请求可看 timing phases、headers/response/initiator；HAR 默认移除 Cookie/Authorization 等敏感 header。 | 有基本 Console/Network，local Chromium 有请求详情底层能力。       | 修真实计时与 Error；补“列表 → 详情 → sanitized 导出”的人工操作链，后端不支持的字段显式显示 unavailable。[Network reference](https://developer.chrome.com/docs/devtools/network/reference)。                                                                                          |
| VS Code         | 调试是运行控制 + 状态检查：breakpoints、call stack、variables/watch、step、logpoints/条件断点。           | 编辑器、LSP、Managed IDE，Workflow 有 replay/rerun。              | 明确 DAP 与 workflow breakpoint 的目标，区分重跑与暂停，不宣称日志面板就是完整 debugger。[Debugging](https://code.visualstudio.com/docs/debugtest/debugging)。                                                                                                                       |
| Sentry          | 错误关联可还原的源码位置；Replay 在客户端默认 mask 文本和 block 媒体，隐私处理发生在数据出机前。          | Crash/incident、consent、诊断包、服务端处理契约。                 | 修 F01/F02，统一预览/上传规范；补生产 JS stack → 源码的验收；如增 Replay 需默认遮罩且允许逐元素阻止。[Source maps](https://docs.sentry.io/platforms/javascript/sourcemaps/)、[Replay privacy](https://docs.sentry.io/platforms/javascript/session-replay/privacy/)。                 |
| Langfuse        | 从 generation 携带消息/模型设置进入 Playground；从 Trace 建 dataset，运行对比实验。                       | Trace、usage、annotation、dataset、Eval lab、Langfuse transport。 | 应优先打通 G06 的直接操作流和输入完整性，不另建一个评测引擎。Playground 重跑单次 generation 不等于安全重放整个有副作用 Agent。[Playground](https://langfuse.com/docs/prompt-management/features/playground)、[Datasets](https://langfuse.com/docs/evaluation/experiments/datasets)。 |

一个适合 Cognia 的目标流程是：用户在指定 session 开启有 TTL 的 debug session → 可见地确认 producer/权限/存储均可用 → 复现 → 从一个 runId/traceId 查看实际执行输入、错误和关联资源 → 预览并导出默认脱敏的证据 → 保存为已有 Eval 用例 → 在固定版本/参数下验证修复。任一步数据不完整，都应显示原因、截断数和支持边界。

### 建议推进顺序与验收

| 顺序                        | 范围                      | 完成条件                                                                                                         |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1：隐私与证据保全           | F01/F03/F11/F12           | 组包/压缩事件在出机前 scrub；并发失败不静默丢失；同包重试复用 identity；同秒 crash 不覆盖。                      |
| 2：让观察结果可信           | F04-F09/F13-F16           | 修计时/Error/执行实例、canonical 完整性、turn prompt 对齐和失败 stack；arm 失败有明确结果。                      |
| 3：连接已有工具             | F02/F10，G01/G04-G06，U01 | 条件性 builder/API hardening；复用 Host WASM logger、local network、Eval、capture；验证发布栈源码还原。          |
| 4：按真实用户需求补高级调试 | G02/G03，U02              | 先验证用户确实需要内置 DAP/交互断点/Replay，再实现完整状态机；含暂停恢复、取消、重入、工具副作用隔离与隐私验收。 |

不建议一开始统一重写日志框架或接入更多供应商。当前系统已有 OTel、Trace、Eval、性能与事故基础，修边界和串联流程可直接利用现有投入。排序是本轮建议，尚未经过真实用户故障定位时长/发生率测量。

### 验证记录与复现

环境：macOS / Apple Silicon，Node v26.12.1；2026-11-17 当前工作区。没有运行 coverage。

```sh
node --test docs/evidence/2026-11-17-debugging-tools-gap-audit.probes.mjs
# 8 tests passed / 0 failed: documented existing counterexamples.

node scripts/test/jest.mjs --runInBand --runTestsByPath \
  lib/logging/transports/native-transport.test.ts \
  packages/logging/src/context.test.ts \
  lib/support-report/build.test.ts \
  lib/observability/debug-session.test.ts \
  lib/plugin/devtools/runtime-log-stream.test.ts \
  components/browser/browser-devtools-panels.test.tsx \
  hooks/browser/use-browser-devtools.test.ts \
  components/workflow/runs/run-step-detail.test.tsx \
  lib/workflow/runtime/step-executor.test.ts
# 9 suites passed / 142 tests passed; 7.441 seconds.
```

第二条使用 `pnpm test` 在 package.json 中指向的同一个仓库 wrapper。一次只读 sweep 尝试 `pnpm exec tsx` 时，包管理器先触发依赖准备，随后在现有 agent-config-types Node exports 解析处失败，探针尚未执行；后续用直接 Node 运行 wrapper，避免再次隐式安装。共享工作区原本有大量未提交文件，不能把后续脏文件归因于这次命令；未重置/还原这些文件。

首次探针运行还暴露了 docs 子工作区自己的 TypeScript 解析差异，已将探针固定从根 package.json 解析依赖；上列 8/8 是修正探针加载器后实际执行结果。没有通过修改产品代码或弱化断言来获得通过。

日志保存于 `.cache/debugging-tools-gap-audit/probes.log` 与 `focused-jest.log`。源代码行为反例、源代码调用链证明、真实环境验收是三种不同证据。未运行全仓 lint/typecheck/build、真实 Tauri/移动端 UI、Rust fault injection、部署服务、远程 provider 或 collector；本次只有审计文档/探针改动，不代表完整产品验收或漏洞生产发生率已测量。

新建 ledger 的原因：`docs/evidence/` 没有同一问题的现有 open ledger；`2026-11-12-agent-observability-completion.md` 覆盖的是 Agent observability 修复，不覆盖本次 browser/plugin/workflow/diagnostic 工具审计。新建 probes.mjs 是为了保存合成反例，不把暂时证明错误行为的断言加入正式产品回归测试。

### Sources

均为 2026-11-17 查询的一手资料；比较限定在上述明确功能，不依据供应商营销排名。

- [OpenTelemetry — Context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [OpenTelemetry — Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/)
- [Chrome DevTools — Network reference](https://developer.chrome.com/docs/devtools/network/reference)
- [VS Code — Debugging](https://code.visualstudio.com/docs/debugtest/debugging)
- [Sentry — Browser JavaScript source maps](https://docs.sentry.io/platforms/javascript/sourcemaps/)
- [Sentry — Session Replay privacy](https://docs.sentry.io/platforms/javascript/session-replay/privacy/)
- [Langfuse — Playground](https://langfuse.com/docs/prompt-management/features/playground)
- [Langfuse — Datasets](https://langfuse.com/docs/evaluation/experiments/datasets)

## Adversarial review — 2026-11-17

Follow-up request:

> 做一次对抗性审查

本轮由三个 fresh-context reviewer 分别检查 native/privacy、browser/plugin/workflow、probe/公共 API。它们只收到 findings/capability 表和证据契约，没有收到作者的 Decisions 或推导过程。审查目标是推翻错误结论、寻找现有缓解和遗漏反例，不是确认原报告。未修改产品代码。

### 复核后修正

| 原记录                       | 分类                                       | 实际处理                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G02：没有 DAP                | Valid + actionable：范围过宽               | 限定为 native Monaco/vscode-shim；Pro IDE/code-server 有实际 adapter factory、broker DAP relay 和 activation wiring。已有 local VS Code fallback。撤回“引导外部 IDE 也需从零建设”的建议。 |
| G04：WASM 无日志             | Valid + actionable：遗漏已有实现           | Host 有带 plugin_id 的有界 logger，真实 WIT linker 已接入。缺口收窄为 Dev Session 的 renderer drain/订阅与 generation/sequence；不新建重复 Host logger。                                  |
| F02：header 泄漏 P2          | Valid + actionable：降级/条件化            | 改为 P3 builder-boundary hardening。生产 category/locale 受限、route 无 query，未证明 caller 会给这些 header 敏感值；合成输入不足以证明实际 UI disclosure。                               |
| F06：插件错误详情丢失        | Valid + actionable：限定数据平面           | 确认是 Dev Session 投影损失；普通 /logs 与 debugger ring 另有来源。另发现 safeClone 的 JSON roundtrip 也会更早丢原始 Error，需要在 source 与 projection 两处解决。                        |
| F07/F08：参数/执行实例       | Valid + actionable：补触发条件与生产侧约束 | Pinned 不运行 executor；retry 已足以混合详情。失败/stream producer 也缺 execution identity，不能只按现有 stepExecutionId 修改 UI。step-cost 的全局聚合另有 identity key，不在此缺陷范围。 |
| F10：并发 Trace 污染         | Valid + actionable：收窄影响               | 保留公共 API 反例，标为 dormant API hazard；本轮没有找到 app 生产 spanAsync/withSpanAsync 调用，不据此认定当前 Agent Trace 受污染。                                                       |
| F13：写入失败后未开启        | Valid + actionable：原反例前提不完整       | 空 storage 时成立；已有 active session 时，失败的替换保留旧 scope/TTL。UI 忽略返回值、读取实际 snapshot，故不声称显示假成功。                                                             |
| G05：rawBodies 开关          | Valid + actionable：区分 UI/API            | 当前没有独立 rawBodies UI 控件；问题是未消费的 API tier 声明，不再建议“隐藏一个不存在的 UI 开关”。                                                                                        |
| F03：mock 是否制造不可能并发 | Counterargument rejected by evidence       | 使用真实 forwardPlatformLoggingEntries，只替换外部 invoke 失败，仍观察到队列 4 → 2、droppedEntries=0。                                                                                    |
| F01/F11：仅源码推断          | Evidence strengthened                      | 用真实组包函数、实际 cognia-observability package API 和 integration-pin 服务端 privacy 代码做本地 Rust 实验，确认压缩 events 保留敏感文本及重试 identity 不稳定。无真实上传。            |

### 新增 F14：Canonical 捕获失败后没有保留失败 batch/完整性状态（P2）

`lib/chat/canonical-sink.ts:219` 的 flush 先清 pending，再 append；`:233` 捕获失败只 console.warn。close 在 `:168` 删除 active map，之后即使 append 失败也 resolve，再 close 不能重试。`lib/execution/direct-chat-run.ts:319` 的终止路径 await close，却没有得到“证据写入失败”的结果。

新 probe 使用实际 sequencer、projection、redaction 和 sink，仅将持久化 port 替换为一次 quota failure。结果：3 条事件未写入、close resolve、只有一次 warning；再次 close 不再 append，下一个 run 的成功写入也没有补回上一批。当前已有测试明确要求 telemetry 失败不拒绝 chat caller，这个选择可保留；缺口是 debug capture 缺少失败 batch、loss counter 或 incomplete 标识，不是要求把日志失败传播成聊天失败。

底层 `canonical-log.ts:140` 只在写入成功后更新 dedupe，说明丢失来自上层吞错/清批；本轮没有证据证明这个问题会独立触发重复工具副作用，不能这样外推。

### 新增 F15：Trace → Eval 绑定了错误 turn 的 prompt（P2）

`lib/ai/eval/trace-prompt.ts:54` 始终取 session 第一条 user text，`:79`–`:82` 将这个 prompt 分给该 session 的所有 traceId。`hooks/eval/use-eval-data.ts:79`、`components/eval/import-dialog.tsx:248` 和 `trace-annotation-panel.tsx:142` 实际使用该映射。

真实纯函数反例：同一 session 有 FIRST successful request、SECOND failing request，两条 turn Trace 最终都得到 FIRST successful request。后续失败 Trace 的导入/标注可能生成第一轮输入的 case，导致重现实验验证了错误问题。修复须用 run/turn/message identity，而不是继续以 sessionId 选择第一条消息；没有完整关联时需明确 fallback，不能标成 recovered original prompt。

### 新增 F16：Workflow failure producer 丢弃 stack（P2）

`lib/workflow/runtime/step-executor.ts:382`–`:385` 从 caught Error 只提取 message，发送 `{message,retryable}`；`event-log.ts:265`–`:272` 的 stepFailed shape 没有 stack/执行实例元数据。`components/workflow/runs/run-step-detail.tsx:151`–`:153`、`:262`–`:269` 却等待 `payload.stack` 才展示错误定位。

这不等同于“全仓任何渠道都没有 stack”；成立的是普通节点失败路径没有将原始 stack 送到该 inspector。应在有界脱敏后保留 Error name/message/stack/cause，补 stepExecutionId/attempt，并用一次真实节点 throw 验收 producer 到详情显示。

### F01/F11/F12 的重要补充边界

F01 的客户端 config/breadcrumb 已有 scrub（`lib/native/crash-context.ts:78`、`:88`），mobile report 捕获也有脱敏。Desktop raw panic/backtrace/hostname/路径和用户 description 尚未统一处理；mobile description 同样在 `mobile-submit.ts:114` 原样编码，不能把 desktop raw-report 结论套到 mobile report。

手动提交已包含 consent；minidump/screenshot 默认关闭。自动提交需单独开启且只覆盖开启后的报告（`auto-submit.ts:179`），默认 consent 不含可选附件。这些保护排除“默认静默上传全部材料”的描述，但不修复“已脱敏”的不实承诺。

更强的 pinned-service 反例：native events 由 `diagnostic_package.rs:162` zstd 压缩，`diagnostic_submit.rs:315` 上传压缩 bytes。在 integration pin **487e9f2d617c9d1b9b648ec510cafcf53b962c2c**，服务端 api/worker 在解压前扫描，而 privacy 对非 UTF-8 直接保留；事件解压到 processing 才发生。实际输出为 `events_server_sanitized_equal=true decoded_still_has_email=true`。普通文本附件会被服务端 scrub，不能据此推断压缩 events 同样安全。这里只验证 pinned source + 本地组包/扫描，不证明线上部署版本和真实线上存储内容。

F11 同一输入两次实际组包得到 `retry_same_hash=false`、`retry_same_incident_id=false`、`parts_equal_after_manifest=true`。只有第一次 create 已抵达服务端、随后 upload/complete/receipt 持久化失败时，第二次提交才会产生重复/部分 incident；首次请求尚未抵达则没有服务端重复。底层同包 resume 本身并未被否定。

F12 顺序 caught panic 同秒已经足以覆盖；native monitor 每次只处理一个 dump 后退出（`monitor.rs:251`），native dmp 的 File::create 覆盖窗口主要属于多进程或快速重启，不应描述成同一个 monitor 连续处理多个 crash。

### 对抗性验证与边界

```sh
node --test \
  docs/evidence/2026-11-17-debugging-tools-gap-audit.probes.mjs \
  docs/evidence/2026-11-17-debugging-tools-gap-audit.adversarial-probes.mjs
# 13 passed / 0 failed: original 8 + 5 adversarial scenarios.

node scripts/test/jest.mjs --runInBand --runTestsByPath \
  lib/chat/canonical-sink.test.ts \
  lib/ai/eval/trace-prompt.test.ts \
  components/eval/trace-annotation-panel.test.tsx
# 3 suites / 43 tests passed, 1.079 seconds.

cargo run --offline \
  --manifest-path .cache/debugging-tools-gap-audit/native-adversarial-rust/Cargo.toml \
  --target-dir .cache/debugging-tools-gap-audit/native-adversarial-rust/target --quiet
# Exit 0; exact observed booleans recorded above, not a full native smoke.
```

原 probe 已从 redact/dist 改为读取当前 redact/src，消除“编译当前 owning source”的声明与旧 probe loader 之间的不一致。补充 probes 使用真实 JSDOM Storage quota，还证明已有 59 分钟 broad session 在失败的 narrow replacement 后继续生效；当前 GUI 只传 duration，较严重的 scope-narrowing 失败限定为 API 条件风险。

记录位于 `.cache/debugging-tools-gap-audit/adversarial-all-probes.log`、`adversarial-focused-jest.log`、`adversarial-native-rust.log`；源码指纹见 `adversarial-source-hashes.json`。Rust harness 使用当前源码提取的未改动组包函数和实际 crate；服务端 privacy 从 integration pin 读取，不采用本地服务仓库较新的 HEAD。截图采集被替换为无能力，所有可选附件默认关闭；没有网络请求。

本轮停止条件：一次独立复核已产出实质修正和三个新增问题，主要反驳已逐项裁定并补确定性证据；未启动无改动重复 reviewer。跨模型已按 doubt-driven 交互规则提供选项，截至本轮记录未取得外部 CLI 的具体运行授权，未执行。真实 UI/native/device/provider/service acceptance 仍未完成，相关 residual 保留 open。

## 修复轮 — 2026-11-18

提交 `ccea6f9f0a`（dev）。逐条先对照当前源码复核，再修复；16 条记录均成立。

| ID          | 处理                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01         | 新增 `crash_privacy::CrashScrubber`：home 目录→`~`、主机名（整词）→`[REDACTED_HOST]`、高置信凭据、邮箱/外部路径。写盘、预览（`read_normalized`）、组包、zstd events、CLI 打包与移动端描述共用；最终扫描不通过则拒绝上传（`privacy_rejected`）。 |
| F02         | header 每个值与 section heading 逐项 scrub，整份 Markdown 再做一次 fail-closed 扫描。                                                                                                                                                           |
| F03         | 单个 in-flight flush、按批顺序重发、失败批次连同其后条目回到队首；队列上限 1000，超出丢最旧并计入 `droppedEntries`。                                                                                                                            |
| F04/F05     | 请求计时改用 `performance.now()`（fetch 到 headers，XHR 到 loadend）；Console 有界序列化 Error 的 name/message/stack/cause，循环/BigInt/DOM 有明确标记。                                                                                        |
| F06         | Debugger 用共享 `lib/error/serialize-error.ts` 克隆 args，优先保存被记录 Error 自身的 stack；Dev Session 条目带 args/stack 并可展开。                                                                                                           |
| F07/F08/F16 | 每次 attempt 记录实际 resolved inputs（日志脱敏规则 + 64 KB 上限），所有 step 事件带 `stepExecutionId`/attempt/iteration；Inspector 按执行实例分组并可切换；失败保留有界 stack/cause。                                                          |
| F09         | Renderer→native 转发补齐 spanId/parentSpanId/executionId/requestId（TS + Rust）。                                                                                                                                                               |
| F10         | 删除无调用方的 `withSpanAsync`/`withTraceAsync`/`traced`；`spanAsync` 只在 scoped logger 上携带 span，不再写全局栈。                                                                                                                            |
| F11         | 包构建一次存于 `crash-reports/staged/<stem>/`，重试复用同一 identity/time/hash；receipt 落盘、报告删除或保留期清理时移除。                                                                                                                      |
| F12         | 文件名加毫秒 + 8 位随机后缀，txt/json/dmp 均 create-new；半对写入失败显式报错。                                                                                                                                                                 |
| F13         | `armTraceDebugSession` 返回结果；写入失败时清除旧会话（fail closed）；设置页显示失败原因。                                                                                                                                                      |
| F14         | 失败批次保留（上限 1000）并随下一次 flush 幂等重写；`closeChatCanonicalLog` 返回完整性结果，不完整时写 `chat` warning。                                                                                                                         |
| F15         | 每条 Trace 取其开始时刻之前最近的一条用户消息（1 s 时钟容差）；无法对齐时不返回，调用方回退到 preview。                                                                                                                                         |
| G05         | 删除无 producer 的 `rawBodies` tier。                                                                                                                                                                                                           |

顺带修正：`submissions.json` 被误列为 crash 报告；`vscode-extension` 无日志通道的过期测试。

未处理（不属于确定性缺陷修复）：G01–G04、G06 的新调试能力，U01/U02 的真实环境验收。验证范围：受影响的 26 个 Jest 套件（615 tests）、`cognia-observability` 196 + 320、`cognia-cli` crash 6，提交树 tsc 对改动文件 0 错误。未运行：src-tauri `cargo check`（被 `cognia-exec-sandbox/src/net_proxy.rs` 的现存语法错误阻断，非本次改动）、真实 Tauri/移动端/诊断服务 smoke。本文件上方两个 probes.mjs 断言的是修复前行为，现已过期。
