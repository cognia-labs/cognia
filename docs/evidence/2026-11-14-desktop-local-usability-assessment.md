# Desktop local usability assessment — 2026-11-14

- Status: verifying
- Lane: standard
- Created: 2026-11-14
- Updated: 2026-11-14
- Related: ADR-0250, ADR-0255; `docs/evidence/2026-11-13-agent-desktop-integration.md`

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 帮我分析一下现在这个项目，距离桌面端本地真实可用还差什么功能

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                  | State        | Basis                                                                                                                                                                                                                      | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | The shared checkout contains extensive concurrent changes.                                                                                                 | Observed     | `git status --porcelain=v1 --untracked-files=no`: 486 tracked entries; HEAD `4ab415a796f08155375287e630dbfa5d3e83221f`, branch dev, 2026-11-14.                                                                            | -          |
| O2  | Core onboarding, provider configuration, terminal dispatch, task-workspace capture, storage cleanup and recovery-gate suites pass.                         | Verified     | Eight scoped Jest suites, 165 tests passed on macOS arm64, 2026-11-14; command below.                                                                                                                                      | -          |
| O3  | The current root typecheck is not green.                                                                                                                   | Verified     | `pnpm typecheck` exits 2; test/story fixtures plus production mobile queue, container adapter and sidecar IP diagnostics; 2026-11-14.                                                                                      | -          |
| O4  | The static-export import audit passes.                                                                                                                     | Verified     | `pnpm lint:static-export`: 12,442 TS files audited, no forbidden Node-only bundle imports, 2026-11-14.                                                                                                                     | -          |
| O5  | Provider fallback can leave a running chat without a global pool permit.                                                                                   | Verified     | Current broker plus complete chat-lease module, injected store/IPC: limit 1, after fallback permits 0, a second chat starts and running becomes 2. `.cache/desktop-local-readiness-2026-11-14/admission.json`, 2026-11-14. | -          |
| O6  | The chat lease watcher releases capacity on optimistic idle before executor stop proof.                                                                    | Verified     | Same probe plus current controller ordering: idle precedes abort dispatch; no native executor or real file write exercised, 2026-11-14.                                                                                    | -          |
| O7  | The unified external-agent lifecycle host refuses managed install/update/rollback filesystem operations.                                                   | Observed     | `lib/ai/agent/external/lifecycle/native-runtime-host.ts:179`; runtime catalog distributions are empty; source inspected 2026-11-14.                                                                                        | -          |
| O8  | File-hash receipt storage exists, but the desktop tool-event bridge carries only paths and tool IDs.                                                       | Observed     | `lib/task-workspace/tool-evidence.ts`, `client.ts:1230`, `crates/cognia-task-workspace-host/src/host_surface.rs:1905`; Host service receipt API exists; source inspected 2026-11-14.                                       | -          |
| O9  | A live native desktop is not available through the debug bridge in this assessment.                                                                        | Verified     | `node scripts/tauri/agent-debug.mjs status`: bridge_unavailable, session null. No main desktop executable found in the Cargo debug directory. This is an environment observation, not a launch failure.                    | -          |
| O10 | Onboarding, local-provider model management, backups, crash recovery, artifacts and app updates already have implementations.                              | Observed     | Owning modules and call paths inspected below on 2026-11-14; no blanket runtime acceptance claimed.                                                                                                                        | -          |
| O11 | Module manifests retain pending real-smoke declarations; the optional agent-desktop session engine remains preview-gated.                                  | Observed     | `lib/*/module.ts`; `scripts/build/stage-agent-desktop-runtime.mjs:164`; integration ledger explicitly defers native qualification.                                                                                         | -          |
| A1  | The primary target is a single user running the Tauri app locally, with API/OAuth access allowed; fully offline inference is a separate acceptance branch. | Hypothesized | Interpretation of the request; not a user-confirmed product boundary.                                                                                                                                                      | -          |
| G1  | Deliver a prioritized current-source gap assessment that separates missing capabilities, reproduced defects and missing acceptance evidence.               | Agreed       | User request, 2026-11-14.                                                                                                                                                                                                  | -          |
| C1  | Analysis only: preserve concurrent edits, credentials and user data; no fixes, commits, installation or provider calls.                                    | Verified     | Scope of this request; actions limited to source reads, checks and disposable controlled probes.                                                                                                                           | G1         |
| C2  | Pending realSmoke or a failed repository check does not prove every feature is broken; old audit findings need fresh source reconciliation.                | Verified     | Evidence standard and observed recent repairs; ADR-0255 intentionally permits shared-directory runs.                                                                                                                       | -          |

## Problem frame

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

Evaluate the current working tree against a practical desktop journey: install, start, configure a model, open a local project, chat, read/write files, run a terminal command, inspect/export results, stop work, restart and recover data. Use A1 as the stated scope assumption. Identify concrete missing capabilities and control-path defects without treating implementation inventory as runtime proof (C2). This assessment does not authorize implementing the proposed follow-up work (C1).

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                                     |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Frontend, Rust host, Node sidecar, packaging and persistent data participate.                                                   |
| technical    | medium | Existing source supplies most core features; lifecycle and ownership cross boundaries.                                          |
| coupling     | high   | A provider turn, terminal, task-workspace capture and recovery share run identity.                                              |
| requirement  | medium | A1 remains an explicit assumption; offline and cross-platform requirements differ.                                              |
| verification | high   | Headless checks are available; native installation, provider and restart qualification require a separate real-environment run. |
| risk         | medium | Read-only assessment; inaccurate readiness advice could misdirect release work.                                                 |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                                | Severity | Source                            | Claim                                                                                              | Refuted by                                                                |
| --- | ---------------------------------------------------------------------------- | -------- | --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| R1  | Report already-repaired or intentional behavior as a new blocker.            | high     | Existing audit drift; ADR-0255    | Current-source findings respect the active contract.                                               | Owning source shows the alleged defect repaired or behavior intended.     |
| R2  | Green unit tests are mistaken for desktop usability.                         | high     | Shell boundary                    | Test scope and native evidence are separately stated.                                              | Native acceptance claimed from Jest or import auditing alone.             |
| R3  | Lost capacity or optimistic Stop permits work beyond configured limits.      | medium   | Controlled failure injection      | Accounting follows live work and user-facing state distinguishes stop request from confirmed stop. | A running leg loses its permit or idle releases it before abort dispatch. |
| R4  | Manual dependency setup and incomplete output recovery block ordinary users. | medium   | Lifecycle host and receipt bridge | Missing capabilities are separated from supported manual paths and intentional Undo limitations.   | A missing path is described as universally blocking basic chat.           |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk     | Method                                                                | Independence   | Evidence                                                                                       | Coverage                                                                                               | Status  |
| --- | -------- | --------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| V1  | R1,R4    | Inspect owning source and reconcile recent repairs.                   | self           | Source inventory and exclusions below, 2026-11-14.                                             | Selected local-desktop core paths; not a complete repository security audit.                           | passed  |
| V2  | R2       | Run focused core regression suites.                                   | tool           | Eight suites, 165 tests passed.                                                                | Onboarding helpers, leases, terminal dispatch, storage and recovery gate; injected native boundaries.  | passed  |
| V3  | R2       | Run static-export audit.                                              | tool           | 12,442 files audited; exit 0.                                                                  | Forbidden imports; does not run Next build or Tauri.                                                   | passed  |
| V4  | R2       | Run actual repository typecheck.                                      | tool           | `pnpm typecheck` exits 2, diagnostics below.                                                   | Root stage failed; later sidecar-specific stage was not reached.                                       | failed  |
| V5  | R3       | Re-execute current broker/chat-lease control paths with injected I/O. | tool           | Both counterexamples reproduced; `.cache/desktop-local-readiness-2026-11-14/admission.json`.   | Capacity and watcher semantics; no actual model, process overlap or filesystem conflict.               | passed  |
| V6  | R2,R4    | Inspect current native bridge and qualify installed-app journey.      | real-env       | Status is bridge_unavailable; no app launch, build or installation attempted.                  | Live desktop/provider/restart acceptance not executed; this is not a demonstrated launch failure.      | planned |
| V7  | R1,R2,R4 | Independently review the assessment against owning source.            | fresh-reviewer | One bounded reviewer found three actionable scope/implementation issues; all reconciled below. | Current receipt/Undo implementation, local-engine guide, external runtime scope and evidence strength. | passed  |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                        | Action   | Based on                      | Reversal trigger                                                 |
| --- | ---------- | ----------------------------------------------------------------------------------------------- | -------- | ----------------------------- | ---------------------------------------------------------------- |
| D1  | 2026-11-14 | Gather source and bounded headless evidence; retain A1 as a visible scope assumption.           | diagnose | G1,C1,C2                      | User defines fully offline or a different platform as required.  |
| D2  | 2026-11-14 | Recommend a minimal desktop acceptance milestone before widening the supported feature surface. | diagnose | G1,O2,O3,O4,O5,O6,O7,O8,O9,C2 | Native acceptance or current-source repair changes a listed gap. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                       | From  | Why still open                                                                      | Next action                                                                         | Status |
| --- | ---------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| X1  | Current working tree does not pass typecheck.                                                  | V4    | Multiple diagnostics; no product repairs requested.                                 | Owners resolve diagnostics and rerun the complete command.                          | open   |
| X2  | Installed-app, provider, native permission, restart and restore behavior is unaccepted here.   | V6    | No live bridge; no cold native build attempted.                                     | Run the isolated real-desktop matrix below on an explicit artifact.                 | open   |
| X3  | Assessment freshness can decay with concurrent changes.                                        | R1    | Shared tree is actively changing.                                                   | Bind delivery evidence to the final tested revision and relevant dirty-file hashes. | open   |
| X4  | Independent review findings reconciled.                                                        | V7    | Three actionable findings corrected against owning source; no external CLI invoked. | None for this review; native acceptance remains under X2.                           | closed |
| X5  | Controlled accounting probes do not establish native overlap, duplicate writes or model spend. | R3,V5 | External I/O was injected.                                                          | Add native delayed-stop and real fallback acceptance.                               | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                | How / when measured                                                    | Result                                                                                               | Status  |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------- |
| M1  | User receives current, prioritized functionality and acceptance gaps. | Final assessment and source links, 2026-11-14.                         | Prioritized report, executed checks, independent reconciliation and native-evidence limits provided. | met     |
| M2  | Local desktop completes the complete install-to-recovery journey.     | Isolated installed artifact and controlled provider, future milestone. | Not measured in this analysis; no readiness or percentage claimed.                                   | pending |

## 结论与范围

核心功能覆盖已经较全。距离“桌面端本地真实可用”，主要差距集中在**可交付的安装启动链、执行生命周期可靠性、变更归属与撤销、真实环境验收**。

本报告将“本地”理解为单人使用 Tauri 桌面，允许访问 API/OAuth 模型。它不自动等于完全离线，也不包含多用户服务器、手机和跨设备协作的全量验收。没有依据给出完成百分比或剩余工期。

## 已有能力，不能再算作缺失

| 用户能力                                       | 当前源码证据                                                                                                                                        | 本轮验证边界                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 首次配置、导入已有 Agent 配置、选择首个任务    | `components/onboarding/flow.tsx`; `lib/onboarding/connect-provider.ts`; `setup-status.ts`                                                           | 两个 helper 套件通过；未操作真实登录或模型。                                |
| 本地模型连接、列模型、部分引擎的模型下载与删除 | `components/settings/provider/local-provider-model-manager.tsx`; `packages/provider-core/src/providers/local-provider-service.ts`; `ollama-pull.ts` | 源码存在；推理服务通常仍由用户安装和启动。不能说“完全没有本地模型支持”。    |
| 本地项目、交互终端、Agent 文件操作、任务 diff  | `lib/terminal/run-in-dock.ts`; `lib/task-workspace/client.ts`; host surface                                                                         | 终端 dispatch 和 run-lease 套件通过；没有真实 PTY/模型改文件验收。          |
| Artifact 预览、导出、Canvas 和 Files           | `hooks/artifacts/use-artifact-panel.ts`; `lib/artifacts/open-in-new-tab.ts`                                                                         | 近期已有隔离、scope 和导出修复；本轮不复述旧问题为当前故障。                |
| 加密备份、恢复入口、安全模式、崩溃任务重建     | `lib/data/backup-scheduler.ts`; `components/providers/recovery-boot-gate.tsx`; `lib/ai/agent/recovery/reconcile-crashed-runs.ts`                    | storage/recovery gate 套件通过；真实重启和恢复仍需验收。                    |
| 桌面安装包配置、捆绑运行时、应用更新           | `src-tauri/tauri.conf.json`; `lib/updates/adapters/desktop-adapter.ts`                                                                              | 不能称为未实现；macOS 更新明确采用 DMG/发布页交接。签名升级链未在本轮实测。 |

## 当前缺口与优先级

P0 表示建议作为“可日用的桌面最小版本”退出条件；P1 是扩大普通用户使用范围所需；P2 是特定能力的后续资格。它们不是未经验证的事故严重性定级。

| ID  | 顺序 / 性质                             | 还差什么                                                                            | 用户影响与完成标准                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L01 | P0 / 当前集成缺陷                       | 收敛实际 typecheck 错误，并固定可重复验证的版本。                                   | 当前全量类型门禁失败，不能把各自通过的模块直接当作一个已验证桌面版本。先恢复全量门禁，再对同一版本做静态导出和原生打包。                                                                                                                                                                             |
| L02 | P0 / 已复现控制缺陷                     | Provider fallback 持续持有全局执行配额；Stop 的 UI 状态与执行器停止证据分开。       | 限额 1 时 fallback 后可出现 2 个 running leg。Stop 请求不应被当作执行器已经结束；是否仍运行、能否重试和失败原因需可见。不能据此声称已发生真实进程冲突或重复写文件。                                                                                                                                  |
| L03 | P0 / 交付与验收缺口                     | 在干净配置下完成安装包→首次启动→配置模型→首个真实任务。                             | 开发机能运行与普通用户安装后可用是不同义务。验证应用自带 Node/sidecar/launcher/前端资源、密钥存储、权限、错误提示及退出重开；本轮没有发现“整个安装功能缺失”的证据。                                                                                                                                  |
| L04 | P0 / 可靠性验收缺口                     | 真实的结果保存、导出、关闭重开、强退恢复、备份恢复验收。                            | 源码已有这些功能，但尚不能由本轮单测证明真实 WebView、Keychain、磁盘和 sidecar 故障下的数据结果。用隔离项目/账户确认消息、附件、文件变更与授权状态，恢复不自动重放不明副作用。                                                                                                                       |
| L05 | P1 / 明确缺少统一托管能力               | 外部 Agent runtime 的批准分发包、安装、校验、激活、更新、回滚和卸载。               | 统一生命周期后端当前主动拒绝移动文件的操作，runtime catalog 没有批准的 distributions。已手动安装并登录的外部 Agent 仍可使用；内置 Agent 不因此不可用。个别 runtime 专用安装入口不等于通用托管链已完成。                                                                                              |
| L06 | P1 / 部分实现、缺少生产闭环             | 补齐写前/写后哈希 receipt 的产生与桥接、回执链判定、逐文件可撤资格及 Undo/UI 消费。 | 当前路径事件只带路径/调用 ID；PatchFile 还没有逐文件 reversible 字段，overlap 在 settle 时将整个 patch 标为不可撤，Undo 也先拒绝整个 patch。重叠时保留 diff、禁用 Undo 符合当前 ADR-0255 止血范围。恢复可证明归属文件的 Undo 需要上述完整链路，单接 receipt 存储不足。复用既有 TaskWorkspace owner。 |
| L07 | P1，完全离线需求成立时前置 / 产品边界   | 可选的应用内推理引擎托管安装/启动，以及完整离线任务验收。                           | 已有 Ollama/LM Studio 等连接和模型管理；setup wizard 主要提供下载链接、命令和连接检测。离线资格还要验证模型已下载、工具调用、embedding/OCR 按任务所需本地化，以及失败时不暗中依赖云。不能把这些离线条件扩大成所有桌面用户的要求。                                                                    |
| L08 | P2，若承诺跨应用自动化则前置 / 资格缺口 | Computer Use 的真实权限、目标窗口绑定、Stop/紧急停止与应用退出清理验收。            | Native 是现有默认；新 agent-desktop session engine 是 opt-in preview，构建器限 native macOS arm64。integration ledger 明确延期验证。这不阻塞仅聊天、终端和文件操作的桌面范围。                                                                                                                       |

## 建议的最小可用里程碑

先选定一个可验收的支持范围：一个桌面平台和一条内置 provider 路径；若首版包含外部 Agent，再加入一种已安装 runtime。增加另一平台或完全离线路径时单列资格。对同一安装包执行以下用户任务：

1. **首次成功**：干净应用配置启动；添加 provider；完成真实对话并显示准确的失败原因。
2. **本地工作**：在一次性项目读取文件、创建文件、修改文件、运行带退出码的命令，核对磁盘内容与 UI diff。
3. **用户接管**：流式响应和工具执行期间 Stop；注入延迟停止、失败和 fallback；核对真实进程、运行状态及配额，保留必要的停止未知状态。
4. **结果交付**：接受/拒绝变更、在受支持条件下 Undo，导出一个 Artifact 并重新打开；并发场景正确显示不可撤原因。
5. **重启恢复**：正常关闭、退出程序、强退后重开；核对对话、附件、项目、任务结果与密钥状态，不自动重复未知外部动作。
6. **数据恢复**：创建加密备份，在隔离配置里恢复并核对数据；模拟磁盘写入失败，确认错误可见且不谎报成功。
7. **交付升级**：如进入分发范围，验证签名/公证安装包和一对真实 N-1/N 升级，保留用户数据。个人源码试用不必因此等待完整公网更新运营。

MCP、工作流、知识库和桌面自动化按承诺的版本范围分别验收。移动端、云托管、多用户、Digital Twin、更多连接器和桌宠不应自动成为上述本地核心里程碑的退出条件。

## 本轮执行的检查

```sh
pnpm test -- --runInBand --runTestsByPath \
  lib/onboarding/setup-status.test.ts \
  lib/onboarding/connect-provider.test.ts \
  lib/execution/chat-lease.test.ts \
  lib/terminal/run-in-dock.test.ts \
  lib/task-workspace/run-lease.test.ts \
  lib/updates/adapters/desktop-adapter.test.ts \
  lib/storage/storage-manager.test.ts \
  components/providers/recovery-boot-gate.test.tsx
# Test Suites: 8 passed, 8 total; Tests: 165 passed, 165 total.

pnpm lint:static-export
# OK: 12442 TS files audited, 41 allowlisted imports, 6 standalone Node sources fenced.

pnpm typecheck
# Exit 2 in root check; sidecar-specific check after && was not reached.

node .cache/desktop-local-readiness-2026-11-14/admission-probe.mjs
# Two counterexamples reproduced. Exit 0 means bad behavior reproduced,
# not that the intended product contract passed.

node scripts/tauri/agent-debug.mjs status
# ok: false; status: bridge_unavailable; session: null.
```

Typecheck 中的代表性原文：

```text
lib/sandbox/container-exec-adapter.ts(101,27): error TS2304: Cannot find name 'egressOff'.
sidecar/src/platform/net/ip.ts(16,15): error TS2737: BigInt literals are not available when targeting lower than ES2020.
```

另外有 Storybook 和测试 fixture 类型不匹配。`container-exec-adapter` 的错误位于 Headless container 路径，不能由此断言本地桌面 shell 已复现故障。`next.config.ts` 明确将类型门禁放到独立 `pnpm typecheck`，因此不能用一次可产出的静态 bundle 代替类型门禁。

没有执行全量 lint、生产 Next build、Rust 编译/测试、原生启动/安装、浏览器交互或真实模型/更新调用。环境当时约有 10 GiB 可用磁盘空间；这只是未开展冷原生构建的背景，不证明项目无法构建。CodeGraph CLI 可用但当前索引未初始化，本轮回退到精确搜索及源码读取。

## 旧审计的处理

- 更新适配器当前已经传递 `downloadOnly` 和 `expectedVersion`，并检查 catalog exclusion；不重复报告旧版本的对应问题仍然存在。
- Artifact 当前已有 storage-generation fence、sandboxed 新窗口预览和导出前挂载 preview；旧审计问题列表不直接作为当前缺陷清单。
- Storage、Memory、Terminal、LSP 和 Sidechat 的旧报告有后续修复。其尚未完成的真实验收可以指导矩阵，历史失败数量不计作当前未修问题数量。
- 2026-11-14 的 TaskWorkspace cleanup/restore 修复已经进入当前 HEAD；不将 2026-11-13 的破坏目录发现未经复核再次列为当前 P0。
- 同目录并发及重叠轮次禁用 Undo 符合 ADR-0255；本报告不建议恢复目录独占作为“本地可用”的条件。

## 独立复核与收敛

一次独立源码复核提出三项可行动问题，均已核对并修正文档：

- L06 不只是桥接缺失：`PatchFile` 没有逐文件可撤状态，settle 将 overlap patch 整体设为不可撤，Undo 会先拒绝整个 patch；现有单次哈希匹配也不足以解释多次写入链。补齐 producer、桥接、链判定、逐文件资格和 Undo/UI 消费均属于后续实现。
- L07 的安装/启动引导已经挂载在设置页，不能再列作缺失；可选的应用内托管与完整离线任务验收才是剩余范围。
- 内置 provider 已足够定义最小版本的一条模型路径；外部 Agent 仅在首版承诺支持时加入验收。

复核同时确认 fallback accounting 和 idle-before-interrupt 顺序仍在当前源码中，以及统一 managed-install host 仍主动拒绝文件操作。额外跨模型复核选项已提供；没有调用任何外部模型 CLI。

相关 13 个关键源码的 SHA-256 快照保存在 `.cache/desktop-local-readiness-2026-11-14/source-hashes.json`。结论绑定本轮读取时的工作树，不能代替之后修改版本的重新检查。
