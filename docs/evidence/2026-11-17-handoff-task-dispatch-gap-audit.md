# Evidence ledger: handoff task dispatch gap audit

- Status: verifying
- Lane: deep
- Created: 2026-11-17
- Updated: 2026-11-17
- Related: ADR-0064, ADR-0103, ADR-0137, ADR-0217, ADR-0243, ADR-0252; [probe runner](./2026-11-17-handoff-task-dispatch-gap-audit.probes.mjs); [implementation plan](../plans/2026-11-17-agent-handoff-and-task-dispatch.md)
- Snapshot: working tree over `d6497e0bf7`, macOS arm64; shared uncommitted changes included.

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 帮我分析一下现在的Handoff和任务派发的缺口，看看对各种agent的支持情况，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

Follow-up, 2026-11-17:

> 哪现在对codex或者claude dekstop等桌面端的支持情况呢

Planning follow-up, 2026-11-17:

> 给出完整的计划

The follow-up requests a reviewable implementation plan, including the user's
multi-desktop client list. It does not authorize product implementation or live
session operations. Current plan source checks use working tree HEAD
`532674905e`; the earlier test runs retain their original snapshot scope.

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                              | State       | Basis                                                                                                                                                                                   | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Audit current Handoff, dispatch, agent support and industry practices; deliver prioritized evidence, without product implementation.                                                   | Agreed      | User request, 2026-11-17, Asia/Shanghai.                                                                                                                                                | -          |
| G2  | Produce a complete implementation plan covering dispatch defects and all supplied desktop clients, with dependencies, acceptance, migration and rollback.                              | Agreed      | User follow-up “给出完整的计划”, 2026-11-17; proposal artifact linked above.                                                                                                            | G1         |
| C1  | Preserve shared changes; do not send real work to providers or mutate user sessions.                                                                                                   | Verified    | Task scope and dirty checkout, 2026-11-17.                                                                                                                                              | -          |
| O1  | Handoff spans transcript export, Codex App snapshots, cross-host tickets, delegation and Squad child runs.                                                                             | Verified    | Current owning source under lib/chat, lib/thread-handoff, lib/execution and lib/squads, 2026-11-17.                                                                                     | -          |
| H1  | A broad integration catalog conceals different control, definition and continuation semantics.                                                                                         | Verified    | 41 catalog runtime entries / 44 presets; dispatch and continuation probes plus owning manifests, 2026-11-17.                                                                            | O1         |
| H2  | Some apparent missing features are intentionally safe contextual continuation or explicit protocol limits.                                                                             | Verified    | Contextual cross-host tickets; capability-gated native resume; inherited authority and deadline enforcement in the real manager, 2026-11-17.                                            | O1         |
| O2  | Renderer cancel lacks the CLI's root-owner fence; collect reads the result before personal-visibility filtering without a root-owner fence.                                            | Verified    | Isolated handler probes; real dispatch/cancel registries with executor and visibility collaborators mocked, 2026-11-17.                                                                 | O1         |
| O3  | External subagent dispatch drops toolsEnabled and child definition restrictions; some inherited canonical restrictions are independently defended downstream.                          | Verified    | Boundary probes and source trace through permission-ceiling.ts and run-authority.ts, 2026-11-17.                                                                                        | O1         |
| O4  | Foreground whole-attempt retry can repeat a tool-capable effect after a transient lost acknowledgement.                                                                                | Verified    | Deterministic injected-effect counter = 2; dispatch-run.ts only applies the non-idempotent guard to background runs, 2026-11-17.                                                        | O1         |
| O5  | Cross-host requirements can select the wrong deployment and omit historical tasks/plans/checkpoints and external runtime provenance.                                                   | Verified    | Three orchestrator probes with injected messages/deployments and source session state, 2026-11-17.                                                                                      | O1         |
| O6  | CLI subagent runner accepts externalPresetId but continues using the parent's backend.                                                                                                 | Verified    | Real CLI runner with capture collaborator replaced; discovery and child-config source traced, 2026-11-17.                                                                               | O1         |
| O7  | A2A paused task states become successful generic turn results; the child launcher maps successful external results to completed.                                                       | Verified    | Real A2A mapper plus BaseProtocolAdapter collector probes; child launcher source trace, 2026-11-17.                                                                                     | O1         |
| H3  | A missing Cognia Desktop adapter implies Claude has no official Desktop handoff entry point.                                                                                           | Invalidated | User-supplied primary link verified against the official Deep Link article and CLI/Desktop references, 2026-11-17. This inference is rejected; no implementation decision relies on it. | -          |
| O8  | Claude documents new-task Deep Links and native local CLI-to-Desktop session continuation, with different platform and authentication limits.                                          | Verified    | Official sources linked in the correction section; documentation verification only, 2026-11-17.                                                                                         | -          |
| O9  | Cognia has not wired these public Claude task/session entry points into its current handoff actions.                                                                                   | Verified    | Targeted source searches in native/chat/navigation, frontend actions, CLI agent code and integration packages, 2026-11-17; internal claude://message events excluded.                   | -          |
| O10 | Public desktop task drafts and eligible native continuation exist across more clients than Claude; Zed also documents importing configured agents' threads over ACP.                   | Verified    | Official Codex, Cursor, VS Code, Qoder and Zed sources read on 2026-11-17; detailed evidence matrix below.                                                                              | -          |
| O11 | Cognia's current desktop handoff wiring is narrower than those upstream contracts; MCP projection, file opening and hosted CLI execution are separate existing paths.                  | Verified    | Exact URL/flag searches plus current handoff actions, Codex bootstrap, editor.ts and MCP adapters, 2026-11-17.                                                                          | -          |
| O12 | Windsurf evidence is an unversioned user report; Cursor cloud links have account and unresolved reliability caveats; OpenCode has an open regression report and an unmerged closed PR. | Verified    | Original upstream issue/forum threads and GitHub REST snapshots read on 2026-11-17. These establish evidence limits, not local runtime acceptance.                                      | -          |
| Q1  | Which provider, native-shell and multi-host acceptance claims are reproducible without live accounts?                                                                                  | Answered    | Local source and isolated tests establish listed boundaries; real provider, native shell, paired-host and device acceptance remain outside this audit.                                  | -          |

## Problem frame

Map each user-visible transfer and dispatch path to its real executor, authority,
context, lifecycle and result-delivery contract. Distinguish implemented source,
locally reproduced defects, intentional limitations and unverified live behavior.
This dated cross-cutting audit is separate from the open multi-agent convergence
implementation ledger and the narrower sidechat audit. No production fixes or
live account operations are requested (G1, C1). Success is a support matrix,
reproducible findings and prioritized recommendations with primary references.
The G2 follow-up adds a source-accurate implementation plan without changing that
product execution boundary.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                          |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------- |
| scale        | high   | Multiple renderer, CLI, sidecar, Rust and protocol paths.                                            |
| technical    | high   | Continuation fidelity, async ownership and external harness boundaries.                              |
| coupling     | high   | Run journal, permissions, providers, outbox, workspaces and host placement.                          |
| requirement  | low    | Analysis and comparison; implementation is outside scope.                                            |
| verification | high   | Local tests can falsify contracts; live agent and paired-host acceptance need separate environments. |
| risk         | medium | Read-only product audit; false support/security claims would mislead remediation.                    |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                              | Severity | Source                            | Claim                                                                 | Refuted by                                                                   |
| --- | ---------------------------------------------------------- | -------- | --------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| R1  | Incorrect agent support claims                             | high     | Catalog and capability boundaries | Registration is distinguished from execution and native continuation. | A listed route has no production caller or ignores required capabilities.    |
| R2  | Lost context, authority widening or duplicate side effects | high     | STRIDE and failure-injection lens | Findings trace real boundaries and safe failure behavior.             | A synthetic caller can cross ownership or a retry repeats an unsafe attempt. |
| R3  | Unsupported reliability claims                             | medium   | Async lifecycle and recovery      | Restart, cancel and delivery semantics are assessed separately.       | A process-local result vanishes or cancellation has no ownership fence.      |
| R4  | Misleading industry comparison                             | medium   | Primary-source research           | Comparisons identify applicable mechanisms and product scope.         | A framework feature is assumed to be a drop-in Cognia capability.            |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk   | Method                                                                                                                                     | Independence | Evidence                                                                                                                                                                                         | Coverage                                                                                                                                        | Status |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| V1  | R1     | Trace source entry points, runtime catalog and capability negotiation.                                                                     | tool         | Catalog parsed: 41 runtime entries, 44 presets, 29 ACP runtime entries; register.ts and package manifests checked.                                                                               | Current working tree; registration and static semantics, no live certification.                                                                 | passed |
| V2  | R2     | Run focused existing suites and account-free adversarial probes.                                                                           | tool         | Baseline: 258 passed, 2 failed / 7 suites; boundary suites: 184 passed / 8 suites; probes: 15 passed / 5 fixtures. Commands and limits below.                                                    | Synthetic inputs, real owning functions; collaborators explicitly replaced. Existing baseline has two authority failures.                       | passed |
| V3  | R3     | Inspect run ownership, retry, cancel, outbox and recovery call paths.                                                                      | tool         | Renderer/CLI comparison, background recovery guards, job controls, manager authority/budget and A2A mapper/collector traced.                                                                     | Source and local fault injection; no real restart or paired-host acceptance.                                                                    | passed |
| V4  | R4     | Read current primary documentation for handoffs, durable execution and agent protocols.                                                    | tool         | OpenAI Agents SDK, Claude Code, LangGraph, ACP v1 and A2A current official pages read; references below.                                                                                         | Comparison as of 2026-11-17; not an endorsement or adoption decision.                                                                           | passed |
| V5  | R1, R2 | Validate ledger, probe syntax, formatting and scoped lint.                                                                                 | tool         | node --check passed; scoped ESLint exited 0; Prettier formatted both artifacts; ledger --final: 0 errors / 0 warnings.                                                                           | Only this task's audit files.                                                                                                                   | passed |
| V6  | R1, R4 | Re-enter upstream capability discovery after the user's Claude Deep Link correction; distinguish the official contract from Cognia wiring. | tool         | Official Deep Link article dated 2026-06-30, CLI reference --desktop and Desktop local-session continuation sections read; targeted source search finds no corresponding handoff implementation. | Documentation/source review only; no App launch or native session transfer.                                                                     | passed |
| V7  | R1, R4 | Verify the pasted multi-desktop list against primary docs, original reports, PR merge state and current owning Cognia modules.             | tool         | Official docs and their owning source checked; OpenCode #55106 open / #54187 closed and merged=false; Cursor full discussion read; Windsurf #283 and OpenChamber source inspected.               | Documentation and source acceptance only. Desktop/version/account acceptance remains X1.                                                        | passed |
| V8  | R1, R4 | Validate the implementation proposal against current owners, local links, goal/acceptance/work-package coverage and ledger structure.      | tool         | Proposal has 7 valid local links, 6 goals, 16 acceptance IDs, 15 work packages, 8 phases and balanced code fences; runtime catalog recounted as 41/44/29; ledger --final: 0 errors / 0 warnings. | Documentation/source validation only. Prior test results were not rerun on the plan snapshot; no production implementation or client operation. | passed |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                                                   | Action   | Based on                                              | Reversal trigger                                                                                |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D1  | 2026-11-17 | Diagnose all transfer classes before recommending consolidation; compare by contract, not naming.                                                                                                                                          | diagnose | G1, C1, O1                                            | New owning source or contradictory reproduction.                                                |
| D2  | 2026-11-17 | Preserve canonical authority and budget protection in the assessment; do not report missing dispatch option fields as a universal bypass.                                                                                                  | diagnose | H2, O3                                                | A full manager reproduction defeats the inherited protection.                                   |
| D3  | 2026-11-17 | Recommend repairing owner fences, retry safety and definition fidelity before expanding the agent catalog. Product implementation is a separate increment.                                                                                 | diagnose | G1, O2, O3, O4, O5, O6, O7                            | New source or corrected reproduction changes a finding.                                         |
| D4  | 2026-11-17 | Correct the Desktop assessment and prefer official new-task links and eligible native session handoff before considering UI automation for those operations. Keep lifecycle control and generic transcript import separate.                | diagnose | G1, O8, O9                                            | Upstream contract changes or a production Cognia adapter is found.                              |
| D5  | 2026-11-17 | Extend the assessment to operation-specific client adapters; prioritize documented task-draft links, separately qualify native continuation, and keep issue-only links conditional. Reuse existing handoff/context modules.                | diagnose | G1, O8, O10, O11, O12                                 | A changed official contract or real-client conformance evidence changes an operation's support. |
| D6  | 2026-11-17 | Deliver a phased implementation proposal: preserve canonical run/ticket owners, repair evidenced boundaries first, and separately qualify draft delivery, native continuation, control and return. No product implementation is performed. | diagnose | G2, C1, O1, O2, O3, O4, O5, O6, O7, O8, O10, O11, O12 | Current source changes or client conformance evidence invalidate a proposed boundary.           |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                                | From   | Why still open                                                                                                                  | Next action                                                                             | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ |
| X1  | Real provider, native UI, mobile and two-host transfer acceptance is unmeasured.                                                        | R1, R3 | No live accounts or user sessions were exercised for this analysis.                                                             | Run a contract matrix per runtime/version/host using disposable workspaces.             | open   |
| X2  | Two baseline plugin dispatch tests fail with authority_unavailable.                                                                     | V2     | The current unchanged source and test fixture disagree about Host authority; source/regression cause was not fixed in an audit. | Repair and rerun the two named baseline tests without weakening authority checks.       | open   |
| X3  | Boundary probes replace executor/network/visibility collaborators, so they do not prove remote intrusion or live provider side effects. | R2, V2 | Intentionally account-free, isolated evidence.                                                                                  | Add end-to-end tests for parent ownership, child-only policy and lost acknowledgements. | open   |
| X4  | Final artifact syntax, lint, format and ledger checks completed.                                                                        | V5     | No remaining artifact-check blocker.                                                                                            | Re-run if either audit file changes.                                                    | closed |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                               | How / when measured                                                    | Result                                                                                                                                  | Status |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Evidence-backed support matrix, prioritized gaps and actionable industry comparison. | Current source trace, tests and primary-source comparison, 2026-11-17. | Delivered below; no product fixes or provider acceptance are claimed.                                                                   | met    |
| M2  | Complete, reviewable plan for dispatch repair and multi-desktop Handoff.             | G2 proposal structure/source/link checks, 2026-11-17.                  | Delivered in docs/plans/2026-11-17-agent-handoff-and-task-dispatch.md; rollout dates are conditional estimates, not product acceptance. | met    |

## 审计结论

当前的核心缺口是**同一项派发意图经过不同入口后，执行者、约束和任务状态不能完整保持一致**。
已经有相当完整的基础设施：统一 child-run launcher、`parentRunId`、delegation、Squad durable coordinator、
background outbox、能力清单、权限上限、预算账本、跨 Host ticket 与 source freeze。下一步应先补齐这些
边界上的一致性，再扩大 agent 名单。以下优先级是审计建议，未替用户接受风险。

证据分级：**复现**表示执行了拥有该行为的真实函数，但使用了隔离测试协作者；**源码确认**表示完成调用链核查；
**能力缺口**表示当前明确不提供或仅部分提供；**待验收**表示没有真实 provider / shell / device 证据。

## 当前 Handoff 与派发路径

| 路径                      | 已实现                                                                                                             | 主要边界                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| App ↔ Cognia CLI          | JSONL transcript、富内容投影、media materialization、context budget/summary、幂等导入快照。                        | 不是通用第三方 agent 原生会话迁移；目标端重新建立执行上下文。                                   |
| Cognia ↔ Codex App        | 显式 desktop action、PII 检查、role-preserving snapshot、导出 receipt、内容寻址回流快照。                          | Codex 专用通路；回流是不可变历史分支。未在本轮启动真实 Codex App。                              |
| 跨 Host / 手机 Handoff    | offer → preflight → accept → source commit → target commit，source lock、digest、attachment manifest、TTL 与恢复。 | 当前构造的 continuation 明确为 contextual；目标本地 provider/workspace/credentials 必须匹配。   |
| `dispatch_agent`          | 单次/并行/background/collect/cancel/resume、深度与环检测、model override、run tree、日志与部分结果。               | 普通 child job 缺少 live steer；resume 是重新派发。Renderer/CLI 的 owner 与 executor 语义不同。 |
| Room → Squad / delegation | Room proposal、confirm/auto policy、T1 delegation、Squad child、统一结果回送。                                     | 是异步工作承诺与执行关系，不等于转移当前对话的执行控制。                                        |
| 外部 agent / A2A          | 注册协议 adapter、capability preflight、原生 session controls、host placement、权限与预算边界。                    | 能力取决于协议、agent、版本与运行环境；注册并不等于通过全流程验收。                             |

主要拥有者：`lib/chat/{export-handoff-to-cli,import-handoff-session,dispatch-to-codex-app,handoff-context}.ts`、
`lib/thread-handoff/`、`lib/execution/launch-child-run.ts`、`lib/ai/agent/execution/delegation/`、
`lib/squads/`、`cli/src/agent/subagent-{dispatch,runner}.ts`。ADR-0252 的统一方向已有实质实现，不能按旧目录或旧审计说它完全未接线。

## 各类 agent 支持矩阵

以下为**当前源码支持与声明的语义**，并非本轮逐个账号实测。41 个 runtime entries 对应 44 个 preset IDs；
同一产品的多个协议和别名会分别计数。A2A、plugin adapter 和手动 terminal 不能并入这个数量冒充新增原生 runtime。

| agent / 协议族                             | 派发与原生 continuation                                                                                                                                                                                                                                    | 尚缺或必须区分                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cognia built-in / native SDK subagents     | 支持 built-in/plugin/template 子 agent，工具、model/provider、深度、部分结果；SDK 原生子 agent 另有 bridge。                                                                                                                                               | `dispatch_agent.resume` 只用旧 prompt + result 重新创建工作；普通 job 没有 live steer；CLI 与 renderer 不完全一致。                |
| Codex app-server                           | 注册 structured adapter；native resume、turn-boundary fork、turn cancel、逐工具审批。                                                                                                                                                                      | 不能推导出跨机器可原样迁移 app-server runtime；`codex` / `codex-acp` 是另一个 ACP 入口。                                           |
| Claude Code external / ACP                 | `claude-code` preset 走 `claude-agent-acp`；原生 session 能力按协商提供。                                                                                                                                                                                  | 不等于 built-in SDK 子 agent 的全部功能；不保证 Claude Code 原生 team、memory、worktree 参数都能由通用 dispatch 表达。             |
| ACP 族，共 29 runtime entries              | Codex ACP、Claude Code、Gemini CLI、Copilot CLI、Cursor、Kiro、Qwen、Kimi、Cline、Goose、Devin、Antigravity、Grok、MiniMax、Qoder、Auggie、Autohand、CodeBuddy、Command Code、Kilo、Mistral Vibe、MiMo、Hermes、oh-my-pi、Muse、Amp、ZCode、OpenCode ACP。 | 共用 adapter 不意味着每个 agent 都支持 load/resume/fork、图片、elicitation、steer 或相同的审批；需要能力协商及 preset refinement。 |
| OpenCode server / remote / V2              | 3 runtime entries；native resume/fork，cancel；V2 有额外 native steer 支持。                                                                                                                                                                               | V1 和 V2 的能力不同；原生 subagent 管理/模型控制等仍需按 profile 核验。                                                            |
| Pi RPC                                     | 单独 RPC adapter、relaunch-with-session、native fork/steer、Cognia extension 工具桥。                                                                                                                                                                      | 不可与 ACP/oh-my-pi 混称；manifest 不承诺 Pi RPC 原生 subagent/background-task 管理。                                              |
| DeepSeek Harness                           | `dsh-sdk` adapter，3 个 preset IDs；支持执行和 native subagent 事件。                                                                                                                                                                                      | 当前 adapter 的 resume/fork/steer 不支持，cancel 作用于进程，审批按 launch profile 固定。上游有某功能不等于本 adapter 已暴露。     |
| OpenClaude                                 | 独立 adapter；relaunch-with-session、逐工具审批。                                                                                                                                                                                                          | 不支持 fork；未在本轮做账号验收。                                                                                                  |
| Crush / Rovo Dev                           | 独立 HTTP adapters，声明 native resume、逐工具审批。                                                                                                                                                                                                       | 无 fork；manifest usage report 为 none，有限 token/dollar 预算下真实 manager 可能安全拒绝启动。                                    |
| Aider / Continue / Codebuff                | 独立 structured adapters；history-replay continuation。                                                                                                                                                                                                    | 不是 native resume；无 fork。Codebuff cancel 为 process，Aider 无逐工具审批，Continue profile-fixed。                              |
| A2A remote agent                           | adapter 确已注册；Agent Card、stream/poll/resubscribe、artifact、task/context ID、cancel；同一 live session 可补充 input/auth。                                                                                                                            | adapter resume/fork 不支持，disconnect 清内存；paused task 与 completed child 的映射存在下述缺口。                                 |
| 自定义 plugin protocol / Freebuff terminal | plugin 可注册 adapter；Freebuff 为用户操作的 terminal，ZCode 另有 terminal 入口。                                                                                                                                                                          | 普通 CLI/PTY、MCP 连接、历史 importer 均不能自动提供 structured dispatch、原生 resume 或 Host policy attestation。                 |

来源：`protocol/external-agent-runtimes.json`、`lib/agent-ecosystem/{capability-catalog,terminal-agents}.ts`、
`lib/ai/agent/external/integrations/register.ts` 与各 `packages/agent-*/src/manifest.ts`。
Browser/Capacitor 不在本地执行这些 CLI；配对 Host 可替客户端执行。`supportsExternalAgents()` 比
`runsExternalAgentProcessesLocally()` 的范围更广，不能把“浏览器没有本地进程”误报成“浏览器完全不能使用外部 agent”。

## 优先处理的问题

| ID  | 优先级 / 证据         | 问题、触发条件与影响                                                                                                                                                                                                                              | 修复方向 / 验收                                                                                                                                                                   |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | P1 / 复现             | Renderer 的 `cancel` 只拿 run ID，不核验调用 session 所属 root。无关 session 提交另一个 live run 的 ID，可令其 signal aborted。CLI 同入口已有 owner fence。                                                                                       | 从 Host-held execution root 验证目标为本树成员，拒绝无关树；保留 UI 的显式全局管理权限，不能由模型借用。双 root 负例与同树 nested 正例。                                          |
| F02 | P1 / 复现 + 范围限制  | Renderer collect 在个人可见性过滤前，读取并消费其他 session 的 live/journal result；没有 CLI 的 root owner 参数。probe 中无关 session 得到非个人标记结果。                                                                                        | 先做 run owner/descendant 检查再 collect/markCollected，再执行 personal visibility。probe 的 visibility 是透传 mock，不声称绕过真实 personal disclosure，也不声称远程跨用户入侵。 |
| F03 | P1 / 故障注入         | `dispatch-run.ts:534` 只对 background 非幂等运行禁止整次重试。foreground 工具已经产生效果、随后收到可重试传输错误时，完整 attempt 再跑一次。probe 中 effects 从 1 变 2。                                                                          | 所有模式按 effect certainty 与 idempotency 判定重试；unknown outcome 不等于没执行。写入的 lost-ack 测试必须只有一个效果，允许停在待核实。                                         |
| F04 | P1 / 复现             | 外部 subagent 分支忽略 per-call `toolsEnabled:false`，也没有执行 built-in 分支的空工具禁用语义，并回报 `toolsAvailable:true`。                                                                                                                    | 在外部 engine edge 转成可证明的 deny-all；协议不能执行时显式 refusal。不可只修改返回的 boolean。                                                                                  |
| F05 | P1 / 复现 + 源码      | 外部 subagent 的 `def.disallowedTools`、`def.maxTurns` 没有成为 engine 约束；`def.tools` 只放顶层 `allowedTools`，未作为 hard `permissionCeiling`。真实 ceiling validator 遇到没有 ceiling 的此请求原样返回。                                     | 把子定义、per-call 与父约束求交，走现有 `externalAuthorityOptions` / `enforceExternalPermissionCeiling`，不可建第二套 validator。无法兑现的维度启动前拒绝。                       |
| F06 | P1 / 复现，能力一致性 | CLI discovery 保留 `externalPresetId`/config pin，但 `runCliSubagent` 仍继承父 `agentBackend`。指定 Codex 子 agent 的定义可实际在父 built-in/provider 上执行，无显式拒绝。                                                                        | CLI 复用可执行的外部 binding 路径，或在 manifest/dispatch 阶段明确拒绝；必须测实际 backend/config/account，不能只测 schema 里有 preset 字段。                                     |
| F07 | P2 / 复现             | `isDispatchAllowedByPolicy` 的 settings 读取异常被 `catch { return true }` 转为允许。已有拒绝规则在读取故障时不能作为边界。                                                                                                                       | settings unavailable 时 typed refusal；缺省未配置与读取失败分开。CLI 当前也不应用 renderer Dexie 的 subagent rules，须明确配置作用域。                                            |
| F08 | P2 / 复现             | Handoff 选择 deployment 时把明确 provider override 与 model match 写成同一个 `find` 的 OR。多个 provider 同名 model 时，列表中更早的错误 deployment/credential 成为目标 requirements。                                                            | 先精确匹配 override；仅在没有 override 时按 model 解析，歧义显式处理。probe 同时保留了正确 continuation override 和错误 requirements，证明内部不一致。                            |
| F09 | P2 / 复现             | 跨 Host envelope 重新构造为 header + turns，丢弃源 session 已有的历史 tasks/plans/checkpoints；目标 receiver 已能接 `historicalState`，但 source 没发送。                                                                                         | 传递允许的历史任务与证据状态，记录 conversion losses；不得把历史 approval 或任务记录解释为新的执行授权。                                                                          |
| F10 | P2 / 复现 + 集成推论  | A2A `input-required`/`auth-required` → `done success:true end_turn` → generic result success，paused task state 没带出。外部 child launcher 又把 success 映射为 completed。普通对话一轮结束合理，但 delegation 可把“还需补充资料”显示成工作完成。 | 区分 turn ended 与 task terminal；保留 taskId/contextId + paused reason，投影为可恢复 interrupt。mapper + real base collector 已复现；真实 delegation UI 仍需 E2E。               |

定位：F01–02 见 `lib/ai/agent/execution/delegation/dispatch-agent-handler.ts:61,78,97` 与
`lib/background-tasks/renderer-subagent-registry.ts`；CLI 正例在 `cli/src/agent/subagent-dispatch.ts:204`。
F03 见 `lib/ai/agent/execution/delegation/dispatch-run.ts:520`。
F04–05、F07 见 `lib/plugin/agent-sdk/dispatch.ts:247,432,506,548,610`。
F06 见 `cli/src/agent/{discover-agents.ts:154,subagent-runner.ts:156}`。
F08–09 见 `lib/thread-handoff/orchestrator.ts:161,182`。
F10 见 `packages/agent-a2a/src/client.ts:354`、`packages/agent-runtime-kit/src/base-adapter.ts:300`、
`lib/execution/launch-child-run.ts:306`。

## 功能缺口与正确保留的限制

1. **通用派发的多轮协作不完整。** `dispatch_agent` 可 collect/cancel，完成后 resume 用旧 prompt + result 重新派发。
   `control-handlers.ts:682` 的 job handler 只实现 stop/open_details；没有对 live child 的统一 send/steer/ask-parent。
   外部协议即使支持 steer/native resume，也不会自动穿过这个入口。建议把 native session handle、follow-up 与 contextual re-dispatch 分开显示。
2. **跨 agent / 跨 Host 的可携带任务包不足。** 当前缺少统一的目标/验收条件、未完成项、artifact refs、证据位置、
   历史状态、source runtime/version 与损失清单的组合。已有 context budgeting、summary 和 attachment manifest，应扩展这些模块。
   目前 external session 在 offer 中被标为 `cognia`（`sdkSessionId ? claude-code : cognia`），需要修正 provenance；
   这不意味着应该伪造跨 Host native resume。
3. **工作区隔离没有覆盖普通 dispatch。** 普通 child 默认用父 cwd，定义与 schema 没有 worktree/isolation 选项；
   Squad 已有 workspace isolation，适合复用。写入型并行工作需要独立 checkout、明确文件归属、patch handback 与冲突处理。
4. **目标能力与配置映射仍依赖本地 ID。** 跨 Host preflight 对 provider/deployment/credential/workspace refs 做精确匹配；
   独立配置但语义等价的 Host 缺少显式映射/选择流程。不能简单删掉 preflight，只应增加受审查的映射。
5. **派发结果仍偏文本。** Renderer fanout 把 `startDispatchRun` 结果统一作为 `ok:true` 文本交回，bridge 也返回 `result`；
   CLI 会在全部失败时返回 tool `error`。建议内部保留 typed status/error/retryability/artifacts，再投影给模型和 UI。
6. **`ask` 不是已实现的 subagent approval。** `subagent-dispatch-policy.ts` 明确把 ask 作为 reserved、v1 等同 allow；
   当前设置 UI 主要是 deny globs。它是缺失的产品能力，不能描述成现有 ask 审批被绕过。

必须保留的安全行为：不转移历史 allow；未知 native state 时降级 contextual；共享 session 拒绝走普通 Handoff；
unsupported rich content/attachments 明确拒绝；权限维度无法执行时 manager 安全拒绝；有限预算但没有可信 usage 的 native engine 可以拒绝。

## 反证与撤回的宽泛判断

- 边界 probe 证明 `_permissionCeiling` 的 deny/sandbox/MCP 部分没有传入外部分支，且定义 MCP server 未与此列表求交；
  但真实 manager 会从 Host-bound canonical run 读取祖先 authority，再执行 `externalAuthorityOptions`。
  因此结论收窄为**子定义或仅调用参数中的限制丢失，以及入口之间的契约不一致**，不宣称所有父权限都能绕过。
- 边界 probe 中 `_deadlineMs` 没有转换成外部 timeout，fake engine 可以超时后成功返回；真实 manager 的
  `beginExternalBudget` / `beginRailBudget` 会为 canonical run 的 deadline 生成 abort signal。
  因此不能用该 probe 宣称普通 `dispatch_agent` 没有超时限制。直接 API 的参数契约仍值得补齐，优先级低于 F01–F10。
- A2A 已实现 input/auth 同 live session 续传、resubscribe/poll 与 artifact，不能建议“从零接 A2A”；缺的是这些状态进入 durable delegation 后的持久化和控制语义。
- 对没有 native resume 的协议，context replay 是诚实的能力降级。问题是要把模式和损失说清楚，不是把能力表改成 native。

## 与业内实践对照

| 实践与一手依据                                                                                                                                                                                                                                                                                  | Cognia 已有基础                                                                             | 适合补齐的差距                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Agents SDK 区分 manager 的 agents-as-tools 与把对话控制交给 specialist 的 handoff；handoff 可通过 inputFilter 裁剪历史。见 [orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/) 与 [handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/)。    | Room / Squad / delegation 分工，以及历史 context projection。                               | 对外区分“委托工作”“转移执行控制”“复制历史”；上下文策略显式化，并在 handoff 边界独立执行授权/PII policy。                           |
| Claude Code 的 subagents 提供明确的 tools、disallowedTools、model、maxTurns、memory 与 worktree isolation；前台/后台与续接各有语义。见 [subagents](https://code.claude.com/docs/en/sub-agents)。                                                                                                | 子 agent 定义、model/provider、tool ceiling、background/outbox；Squad workspace isolation。 | 外部与 CLI rail 的定义保真；普通 dispatch isolation、live follow-up、native resume 和 parent dialogue。不能照搬某个厂商所有字段。  |
| LangGraph 使用 checkpointer 持久化 thread state，并把重试边界与幂等效果分开；缺少 ack 时结果未知，不能视为未发生。见 [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 与 [fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)。 | durable Squad、background recovery phase/effect classification、outbox、预算与 stop proof。 | 将 background 的效果不确定性规则用于 foreground；持久化足以恢复的任务状态、effect receipts 与幂等键，补 crash-after-effect 验收。  |
| ACP v1 要求先确认 loadSession 能力，再请求 session/load；不能因协议名称相同就假定可恢复。见 [session setup](https://agentclientprotocol.com/protocol/v1/session-setup)。                                                                                                                        | capability manifest、negotiated profile、guard 与 preset refinements。                      | 支持矩阵显示 exact protocol/version/host 的可用操作；Handoff target preflight 应显示 contextual/native/blocked 及损失。            |
| A2A 区分 task、context、message 和 artifact，并保留 input/auth required、任务订阅与幂等 cancel。见 [current specification](https://a2a-protocol.org/latest/specification/)。                                                                                                                    | A2A adapter 的 task/context、stream/poll/resubscribe、artifact 与 cancel。                  | 将 paused task 持久化为 delegation interrupt；恢复同 task，并区分“回合有回应”和“承诺已完成”。协议本身不保证发送效果 exactly-once。 |

这些是具体机制的对照，不是对产品整体能力的排名，也不是引入新 orchestration framework 的理由。

## 建议实施顺序与验收

| 批次 | 范围                                                                                | 完成条件                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | F01–F05：owner、retry、external constraint fidelity。                               | 双 root 越界操作被拒；同树 nested 仍可控制；lost ack 不重复效果；每项 child restriction 在 engine 生效或启动前拒绝。                                         |
| 2    | F06–F10：CLI executor、policy read、provider selection、历史状态、A2A paused task。 | 相同定义跨入口选择相同 engine/config；故障不放宽 policy；跨 Host 带上允许的任务证据；A2A 问题保持等待状态而非完成。                                          |
| 3    | 通用 follow-up/native resume、上下文包与普通 child isolation。                      | 运行中可纠正/提问；重启后保留原生或明确 contextual 身份；隔离 checkout 可交回产物并处理冲突。                                                                |
| 4    | 按协议/版本/Host 建 conformance 验收矩阵。                                          | builtin、Codex、ACP、OpenCode、Pi、DSH、A2A 和 replay 类各至少覆盖成功、拒绝、cancel、restart、输入等待、lost ack、结果回送；Windows/Linux/mobile 单独取证。 |

## Desktop follow-up：Codex App 与 Claude Desktop

本节区分**桌面 App 本体**、Cognia 托管的 CLI/SDK runtime，以及“桌面客户端调用 Cognia MCP tools”。
前面的 41-runtime 统计不代表 41 个桌面 App 已被接管。补查日期：2026-11-17；仍然不操作用户正在运行的桌面 App。

| 产品 / 入口                          | 当前实际接入                                                                                                                                                                                          | 支持等级与限制                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex App：会话 Handoff              | Chat header / session actions → `dispatchSessionToCodexApp` → Tauri → `cognia-codex-app`；导入完整对话快照、验证 transcript/cwd、保存 receipt、打开 deep link；可手动回流 linked immutable snapshot。 | **已有专用 UI 与后端**。回流通过读取 Codex 历史导入，不是双向实时同步；本轮没有真实 App 验收。                                                                                                     |
| Codex App：任务控制                  | 已注册 runtime status、task list/read/create/send/interrupt/open、inventory；native command、companion RPC 与 generated CLI/API catalog 都存在。                                                      | **后端/API 能力已实现**。不能说“只能打开 App”。但 create/send/interrupt/list 的 TS wrappers 在 app 生产代码中未找到调用者，通用 child launcher 也没有 Codex App target；不能等同完整统一派发接线。 |
| Codex CLI app-server / ACP           | `ExternalAgentManager` 托管的独立 runtime，支持任务执行与相应 native session controls。                                                                                                               | **结构化执行已接入**，与控制用户正在打开的 Codex App 是两条实现路径。                                                                                                                              |
| Claude Desktop：MCP                  | `claude-desktop` config adapter 可导入/投影 stdio MCP 配置；External Bridge 有连接配置与 setup UI，另有 CC Switch provider/config 管理。                                                              | **配置与工具互通已实现**。方向主要是 Claude Desktop 调用 Cognia tools，不代表 Cognia 可以向 Desktop 新建/续发任务。                                                                                |
| Claude Desktop / Cowork：Cognia 接线 | 当前 frontend/launcher 中未找到官方 Deep Link 或 `claude --desktop` handoff adapter，也未找到 Desktop cancel/result-return 控制链。                                                                   | **官方已提供任务入口及符合条件的原生 CLI 会话接力，Cognia 尚未接入**。这与 CLI/SDK/ACP 的普通执行支持分开统计；详见下方更正。                                                                      |

源码依据：

- UI：`components/chat/chat-header.tsx`、`hooks/chat/use-session-desktop-handoffs.ts:115`、`lib/chat/dispatch-to-codex-app.ts:206,235`。
- Codex App control：`lib/native/codex-app-control.ts`、`src-tauri/src/codex_app_dispatch.rs:33`、`src-tauri/src/lib.rs:734`、
  `crates/cognia-codex-app/src/lib.rs:1530`、`crates/cognia-companion-rpc/src/rpc/codex_app.rs:123`。
- 远端 RPC 并非任意无权限访问：list 要求授权 workspace，read/send/interrupt 校验 thread cwd，输入路径另有检查。
- Claude Desktop：`lib/mcp/config-adapters/claude-desktop.ts:69`、`components/settings/external-bridge/panels/setup-panel.tsx:84`。

桌面端专项缺口：

1. **Codex App 控制链依赖内部 UI / CDP 与本地 rollout。** task-create/send 经过 renderer composer automation，
   task read 结合本地 rollout mirror；这与稳定的独立 `codex app-server` adapter 不同。App 升级后需要独立版本验收。
   `ensureCodexCdpRuntime` 默认允许自动 relaunch，可能重启 App；本次只读源码，没有调用该操作。
2. **平台和安装布局仍偏 macOS。** 当前默认 `/Applications/ChatGPT.app`、`Contents/MacOS/ChatGPT`、bundle ID
   `com.openai.codex`，由 bundled CLI layout discovery 配合使用。不能推导 Windows/Linux 桌面控制已经可用；
   本机其他安装名称也需要发现/配置与验收。见 `sidecar/codex-app-control/shared.ts:8`。
3. **控制命令存在，统一任务生命周期未补齐。** 需要把 App-owned thread/turn 关联到 Cognia run/delegation、
   持续进度、外部审批归属、停止回执与结果回送。当前 Handoff 完成表示快照导入成功，不表示外部任务执行完成。
4. **部分请求参数只到中间层。** Rust `CodexAppTaskSendRequest` 接收并验证 `model`、`effort`、`approvalPolicy`；
   `sidecar/codex-app-control/cli.ts` 的 `sendTask` 没有使用这些字段。`task-interrupt` 中 `turnId` 由 Rust 校验，
   sidecar 实际仅按 thread 调用 interrupt。这是源码确认的契约缺口，尚未在真实桌面验证用户影响，不能宣称精确 turn 控制或这些设置已生效。
5. **Claude Desktop 的 HTTP setup recipe 需要校准。** Setup panel 提供把 loopback HTTP URL 写入 `mcpServers` 的
   `claude-desktop-http` 示例，但 Cognia 自己的 Desktop adapter 明确只投影 stdio；当前 Claude 官方说明 remote connector
   从 Anthropic cloud 连接公共 HTTPS 服务，不能直接访问用户的 `127.0.0.1`。
   不能把这个示例视为已经验收的 Desktop HTTP 连接。应分别交付 local stdio 与 remote connector 的正确操作流程。
   一手依据：[Claude remote MCP 网络要求](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)。

补充验证：

```sh
pnpm_config_verify_deps_before_run=false pnpm test --runInBand \
  lib/native/codex-app-control.test.ts lib/chat/dispatch-to-codex-app.test.ts \
  lib/mcp/config-adapters/claude-desktop.test.ts \
  hooks/chat/use-session-desktop-handoffs.test.ts --silent
# 4 suites / 42 tests passed; transport, import and UI collaborators are isolated.
```

日志：`.cache/handoff-dispatch-audit-desktop.log`。这些 tests 验证调用与数据契约，没有实际创建、发送或中断桌面任务。
Rust 有 `live_installed_codex_import_preserves_snapshot_and_reuses_its_receipt`，默认 ignored，需要真实 App/bundled CLI，
且该 smoke 自身不提交 model turn。本轮也没有运行它。

## Claude 官方机制核验与审计更正

用户补充官方链接后，本轮重新进入 discovery（D4）。此前只核查 Cognia 当前接线，未核全 Claude 的上游桌面入口；
应将结论更正为：**Claude 官方已经支持任务入口和有条件的 CLI 会话接力，Cognia 尚未接线；通用会话导入、运行控制及自动回流仍是另一层能力。**
H3 被证伪；O8/O9 分别记录上游能力和本仓状态，后续判断不得把两者混为一谈。

| 层级               | 已核验的官方路径                                                                                          | Cognia 的适用方式                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 Task Handoff    | `claude://code/new`、`claude://cowork/new` 预填任务；普通 chat/project 也有公开链接。                     | 增加目标客户端 action，携带经过权限/PII 处理的 brief 与本地 workspace；成功只能记录为已打开/已交接，不能记录为已执行。                                  |
| L2 Context Handoff | 新任务可以携带经整理的上下文，但 Deep Link 本身不是历史 session importer。                                | 复用现有 context projection/summary 与 loss reporting。Code 的 file 参数当前不生效，交接文件读取方案需要单独验收，不能把 file 填进去就认定已附件。      |
| L3 Session Handoff | 本地原生 Claude Code CLI session 可用 `/desktop` 或 `claude --desktop --resume <id>`，也可 `--continue`。 | 仅为能证明原生来源和 session ID、满足版本/平台/登录/占用条件的记录提供此 action；任意 Cognia conversation ID 或外来 transcript 不得代入 native resume。 |

官方 [Deep Link 文档](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)
确标注 2026-06-30，覆盖 macOS/Windows/Linux。它是预填输入，用户仍需发送并确认 folder；`q` 约 14,000 字符后会被截断，
因此 Cognia 应在打开前处理超长内容，不依赖目标静默截断。Code 只使用首个 folder，file 仅接受但暂未实现；
Cowork 可重复传 folder/file。Code 的 `prompt` 是 `q` 别名。对原文未覆盖的行为仍需真实客户端验证。

官方 [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags) 与
[Desktop 本地续接说明](https://code.claude.com/docs/en/desktop#coming-from-the-cli)
确认 `--desktop` 从 v2.1.285 起提供，只适用于 macOS / Windows x64 与 Claude subscription 登录；
API key 和文档列出的第三方 provider 不适用。`--resume` 需要真实 session ID；活跃终端或后台占用的 session 不能移交。
CLI flag 不接受附加新 prompt 或任意其他 flags，不能把 new-task 参数与 native resume 混用。
Desktop `/resume` 的本地 CLI 续接保留原会话；Linux Deep Link 可用不能推导 Linux `--desktop` 也可用。

当前已读官方文档未建立第三方任意 transcript 导入、持续向既有 Desktop Code/Cowork 会话发消息、
通用自动回流的公开协议。这里记录为**缺少已核实的公开契约**，不以文档未提及证明所有版本绝对不存在。
社区 `claude://resume?...` 不列入已验证能力。

实施建议也随之更新：先复用现有 handoff UI/context 模块增加官方 L1 adapter，再为有原生 provenance 的会话增加 L3；
L2 复用历史上下文导出。用独立能力字段表达 open/prepopulate/native-resume/send/interrupt/result-return，
避免把三个层级当成一条线性成熟度评分。没有为核验启动 App、发任务、迁移会话或改动产品源码。

本次修改仅为报告更正；运行 formatter 和 ledger --final，不重跑与文档修订无关的行为测试。

## 多桌面客户端补查：用户粘贴清单的逐项核验

输入：用户提供的多客户端 Handoff 清单（2026-11-17）。逐项核查官方文档、原始讨论和当前 Cognia 源码，
没有启动编辑器、发送任务、安装客户端或执行原生会话移交。结论是**应扩大客户端适配范围，同时按操作和证据等级分开标注**。

| 客户端                  | 上游核验结果                                                                                                                                                                                                      | 当前 Cognia 接线与判断                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex / ChatGPT Desktop | 官方文档提供 `codex://threads/new`、`prompt`、本地绝对 `path`、`originUrl` 和既有 thread 链接；CLI `/app` 可在 macOS/Windows 打开当前保存会话。                                                                   | 已有 snapshot handoff、已有 thread 打开和内部 bootstrap。`sidecar/codex-app-control/cdp-bootstrap.ts:96` 已构造 `codex://new?path=...&prompt=...`，不能记为完全没有 Deep Link。尚缺面向用户、独立于 CDP 自动发送的通用任务草稿入口和原生 CLI 续接 action。 |
| Claude Desktop          | 前节已核验公开 new-task Deep Links 与有限条件的 CLI → Desktop 原生续接。                                                                                                                                          | MCP/CLI 执行已有；官方 L1/L3 handoff action 尚未接入。                                                                                                                                                                                                     |
| Cursor                  | 官方 prompt Deeplink 文档确认 `cursor://anysphere.cursor-deeplink/prompt?text=...`，用户确认后发送；URL 编码后的总长度上限为 10,000 字符。                                                                        | 已有 `cursor-cli` ACP、MCP config adapter、CLI editor file/goto；未找到对应 desktop prompt handoff action。Cloud-agent open-by-ID 不应直接标成通用稳定支持，详见下方讨论反证。                                                                             |
| VS Code / Copilot       | `vscode://agents/new?prompt=...&workspace=...` 准备 Agents window 草稿；`workspace` 是编码后的 folder URI。1.146（2026-11-11）正式更新说明记录实验性 Copilot CLI `/code`，要求 CLI ≥1.0.107 并启用 experimental。 | MCP projection、TUI editor/file URI 等已有。未找到 agents/new 或 Copilot CLI → Desktop handoff adapter；不能把 Cognia 内部 vscode-shim、扩展宿主或 `copilot-cli` runtime 算作外部 VS Code 桌面接力。                                                       |
| Qoder IDE               | 官方 `/chat?text=...&mode=...&isNewChat=...` 支持预填；需登录与确认，`ask` 实际按 chat 处理，可选择新建或当前聊天。                                                                                               | 已有 Qoder ACP runtime；未找到 Qoder IDE Deep Link handoff action。IDE 与独立桌面 agent App 需要不同产品标识，不能互相推断。                                                                                                                               |
| Windsurf                | 原始 issue #283 有 `windsurf-next://cascade/newChat?...` 预填成功而 autoRun 不生效的用户报告，但版本字段仍是占位符。                                                                                              | 已有 MCP config adapter 和 TUI editor/file launch；未找到已验证的 Cascade task handoff。该 URL 只能列作候选兼容入口，不能承诺稳定跨平台或自动执行。                                                                                                        |
| OpenCode Desktop v2     | #55106 仍 open；2026-11-01 用户报告 macOS Desktop 2.2.5 丢弃 directory/prompt。#54187 已 closed，`merged=false`。当前 dev 的 deep-link helper 仍只提供 console auth-return 解析。                                 | Cognia 已有独立 V1/V2 service adapters。优先沿现有 server session 连接实现可靠操作，再验收 Desktop 能否定位该 service 的同一 session；API 成功不等于 Desktop 已选中会话。不能把 2.2.5 报告泛化成所有未来/当前构建必然失败。                                |
| OpenChamber             | 项目当前 source 有 `openchamber://session/<id>?message=...` builder/parser，文档描述 desktop pending-link 接收与窗口路由；还可携带 instance/host identity。                                                       | 是独立客户端，不能算作 OpenCode Desktop 的功能。Cognia 未找到专项接线；可作为额外 target，必须绑定同一个 OpenChamber/OpenCode instance，链接不是公共分享或任意历史导入。                                                                                   |
| Zed                     | 官方不仅提供 ACP hosting，还明确提供 Import Threads：从已配置 External Agents 列出并导入既有 sessions，去重后可打开继续；无 working directory 的 session 跳过。                                                   | 不应只记录为“支持 CLI 打开目录”。Cognia 与 Zed 都可能是 ACP client/host，不能把它们当成可直接互接的两个 ACP agent。应验证共同外部 agent 的 session store/list/load，或另行评估 Cognia 的 ACP server 面，不由已有 ACP client 实现自动获得。                 |

一手来源及需修正的细节：

1. **Codex task draft 与 native continuation 分开。**
   [官方 Deep Links](https://learn.chatgpt.com/docs/app/commands#deep-links) 中 `originUrl` 只匹配目标已有 workspace roots 的 Git remote，
   不是自动 clone 或跨机器路径映射；同时存在 path 时先解析 path。prompt 仅进入 composer，不自动提交。
   [官方 CLI slash commands](https://learn.chatgpt.com/docs/cli/slash-commands#continue-in-the-desktop-app-with-app) 记录 `/app` 打开同一保存会话。
   既有 thread ID 只有对正确目标存储/Host 可解析才有意义；来源错误或缺失时不能把任意 Cognia ID 当作原生 ID。
2. **VS Code 不能只看“链接打开了”。**
   [官方 CLI/URI 文档](https://code.visualstudio.com/docs/configure/command-line#prepare-a-new-agent-session-draft)
   说明已有 New Session draft 会被保留而不是被链接内容覆盖；workspace 参数需要 folder URI，不能直接塞裸路径。
   该网页偶发超时，已读取 [官方文档仓库源文件](https://github.com/microsoft/vscode-docs/blob/main/docs/configure/command-line.md) 核对。
   [1.146 release notes](https://code.visualstudio.com/updates/v1_146#continue-a-copilot-cli-session-in-vs-code-experimental)
   明确 `/code` 保留 conversation/model/effort/mode，但 CLI-only `--allow-tool` 和本次临时 approvals 不移交。
   不应以“保留部分权限”为由迁移临时授权。
3. **Cursor cloud 链接的原帖有后续反证。**
   [稳定 prompt 协议](https://cursor.com/docs/reference/deeplinks) 与
   [cloud-agent open-by-ID 讨论](https://forum.cursor.com/t/open-by-id-url-for-the-cloud-agent/159908) 的证据等级不同。
   后者早期回复给出 `background-agent?bcId=...`；2026-05-18 的后续回复明确说 shared Enterprise service-account runs
   不能靠链接让其他成员接续，建议使用将来接续者自己的账号。之后用户仍报告 same-account 链接失败。
   因此保留“同账号/同实例的条件候选，需实机验收”，不把早期回复截成稳定团队共享承诺。
4. **Qoder 的范围是 IDE。**
   [官方 Qoder IDE Deeplinks](https://docs.qoder.com/user-guide/deeplink) 可作为 L1 优先目标；
   Code/CLI/native session、独立 Qoder desktop agent App 的能力分别验证。
5. **Windsurf 是报告，OpenCode 是有日期的回归证据。**
   [Windsurf #283](https://github.com/Exafunction/codeium/issues/283) 的存在证明有人如此报告，不建立已审计的版本/平台契约。
   [OpenCode #55106](https://github.com/anomalyco/opencode/issues/55106) 的 2.2.5 复现来自用户；
   [PR #54187](https://github.com/anomalyco/opencode/pull/54187) 经 GitHub API 确认 closed/unmerged，自动清理评论不是技术拒绝，
   也不是已被替代实现修好的证据。只读了 [dev helper](https://github.com/anomalyco/opencode/blob/dev/packages/desktop/src/main/lifecycle/deep-link.ts)，
   未在本轮对完整上游桌面代码或最新安装包做全量运行验收。
6. **OpenChamber、Zed 有比清单更强的直接源码/文档依据。**
   [OpenChamber link source](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/lib/sessionLinks.ts) 与
   [接收路由说明](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/sync/DOCUMENTATION.md) 建立了 session/message 导航路径。
   [Zed Importing Threads](https://zed.dev/docs/ai/external-agents#importing-threads) 建立了从配置 agent 导入继续的公开能力；
   这不等于任意第三方 transcript 都能通过 URL 塞给 Zed。

对 Cognia 的实现含义：

- **复用现有模块，而不是另造一套 Handoff Manager。** 现有 `lib/chat/handoff-context.ts`、
  `lib/thread-handoff/{orchestrator,service,client}.ts`、session action hook 已分别拥有上下文、跨 Host ticket 与 UI。
  新客户端 adapter 负责准确编码 workspace/prompt/原生身份以及声明可用操作；不把 Deep Link 升格为所有工作状态的统一传输协议。
- **支持矩阵按操作和条件填写。** 至少分别描述 open-project、prefill-task、open-native-session、resume-native-session、
  send-live-input、interrupt、observe-result；附产品/版本/平台/账号/Host/store 与 evidence。
  L1/L2/L3 可作 UI 解释，但不是一个“越高就全包含”的单一等级。
- **交接成功的回执要分层。** OS 接受 URL 只能证明唤起请求已交给系统；已有草稿可能保留，目标可能打开错误账号或实例。
  没有 target acknowledgement 时保持未确认，不能写为任务已开始/已完成。原生 session ID 还必须绑定 owning runtime/Host/account。
- **编码与上下文预算按 target 计算。** Cursor 限制的是编码后整条 URL，Claude 文档描述 prompt 字符截断；
  VS Code 使用 folder URI，Codex 可以匹配已有 Git remote。复用现有 PII gate 与 context summary/loss reporting，
  不把 URI 字符串当成可携带任意文件、凭据或历史审批的通道。
- **建议分批。** 先补 Claude、Codex、VS Code、Cursor prompt、Qoder IDE 的公开 L1；
  独立补有来源证明的 Claude/Codex/Copilot CLI native handoff；
  OpenCode 沿已接入的 service API，Zed 验证共同 agent 的 ACP import/load，OpenChamber 单独管理 instance-aware navigation。
  Windsurf 与 Cursor cloud-ID 特殊场景进入条件兼容清单，取得实机证据再扩大承诺。

本节为分析扩展，没有新增产品 adapter。验证为官方页面/仓库源文件、GitHub issue/PR 当前状态与本仓源码交叉核对；
未新增无关行为测试，所有桌面端真实验收继续列在 X1。报告格式与 ledger --final 在修订后复核。

## 验证记录与限制

使用 Node v26.12.1、pnpm 11.18.0，未请求 coverage。只新增本 ledger 与复现 runner；fixtures/logs/config 均在 `.cache/`。

```sh
# pnpm 11 的依赖自动检查会先 install；本 checkout 的 sidecar postinstall 失败。
# 以下配置仅关闭重复自动 install，不关闭 Jest、assertion 或质量规则。
pnpm_config_verify_deps_before_run=false pnpm test --runInBand \
  lib/thread-handoff/service.test.ts lib/thread-handoff/orchestrator.test.ts \
  lib/ai/agent/execution/delegation/dispatch-agent-handler.test.ts \
  lib/ai/agent/execution/delegation/subagent-dispatch-policy.test.ts \
  lib/execution/launch-child-run.test.ts cli/src/agent/subagent-dispatch.test.ts \
  lib/plugin/agent-sdk/dispatch.test.ts --silent
# 7 suites: 6 passed / 1 failed; 258 tests passed / 2 failed.

pnpm_config_verify_deps_before_run=false pnpm test --runInBand \
  lib/chat/handoff-context.test.ts lib/chat/export-handoff-to-cli.test.ts \
  lib/chat/import-handoff-session.test.ts \
  lib/ai/agent/external/policy/permission-ceiling.test.ts \
  lib/ai/agent/external/policy/run-authority.test.ts \
  lib/execution/run-budget-rail.test.ts packages/agent-a2a/src/client.test.ts \
  cli/src/agent/subagent-runner.test.ts --silent
# 8 suites / 184 tests passed.

node docs/evidence/2026-11-17-handoff-task-dispatch-gap-audit.probes.mjs
# 5 copied fixtures; 15 audit probes passed; unrelated copied tests skipped.
```

两项 baseline failure 均在 `dispatchSubagentAsChildRun`：
`launches the dispatch as a child run under the run id it reports`、`names the parent and the conversation when the caller has them`，
错误为 `RunAuthorityError: authority_unavailable`。没有修改产品源码来让测试变绿。

首轮 pnpm 自动 install 的原始阻断：`@cognia/agent-config-types/agent-capability-grant` 与
`agent-composition` 解析到 `.ts` 源文件，bundled sidecar 的 linked-package gate 要求 compiled JS `node` export。
日志：`.cache/handoff-dispatch-audit-baseline.log`；实际测试日志：`.cache/handoff-dispatch-audit-jest.log`、
`.cache/handoff-dispatch-audit-boundaries.log`、`.cache/handoff-dispatch-audit/probes.log`。

CodeGraph 无索引，本轮使用 `rg` 与源码回退；未擅自初始化。Context7 quota 已用尽，因此外部对照改读官方网页。
未运行全仓 lint/typecheck/build、真实 provider、原生 UI、手机或两 Host 验收；本轮没有 UI 或产品源码改动。
ledger 保持 verifying，表示产品缺陷与真实环境验收仍开放，不影响本轮分析交付已经完成。
