# Evidence ledger: managed cloud desktop completion

- Status: verifying
- Lane: deep
- Created: 2026-10-29
- Updated: 2026-11-16
- Related: ADR-0233 amendment A1–A10; ADR-0234 amendment N1–N5; docs/plans/2026-10-29-managed-desktop-completion.md

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 研究现在云电脑的实现，看看缺口，确保功能完整，不能省略或者简化，确保连接和传输以及管理的合理性，explore可以使用haiku，有问题和我确认，不能省略或者简化，不能重复实现，注意代码整洁规范 /grill-me

2026-11-16 复审请求

> 帮我分析一下现在的云电脑的缺口，看看差什么功能，存在什么问题

> 再看看相关的代码

## Knowledge

O1–O11 记录 10 月审计时的状态。当前结论见 O12 起及下方复审。复审读取 `dev` 的实际工作树，期间 HEAD 从 `5ff8b5b52b` 前进到 `e4eaf4bf96`。核心桌面路径在两个提交之间无差异，相关 RPC 文件另有工作树改动。

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                              | State        | Basis                                                                                                                                                          | Depends on |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | No production code writes `managed-desktops.json`; only tests call `save_registry`; provider keys can be stored only by operator `store-key`                                           | Verified     | grep of crates/src-tauri/cli/scripts at 9ee9de7667, 2026-10-29                                                                                                 | -          |
| O2  | `managed-desktop-release.json` is produced only as a CI artifact; no install path, so `release()` is None on real Hosts                                                                | Verified     | `managed_desktop_release.rs:27-44`, `images.yml:358-364`, 2026-10-29                                                                                           | -          |
| O3  | Qualification receipts are written only by the native operator with `--authorize-paid-smoke`; no RPC path                                                                              | Observed     | haiku explorer read of `smoke.rs`, `qualification.rs`, 2026-10-29                                                                                              | -          |
| O4  | Agent control, handoff execution and acceptance are blocked by compile-time constants                                                                                                  | Verified     | `managed_desktop_results.rs:17`, `control.rs:1103`, `managed_desktop_handoff.rs:116`, 2026-10-29                                                               | -          |
| O5  | No route from computer-use to a managed desktop: E2B lacks `gui`, registry has no managed branch, managed control is human-only                                                        | Observed     | haiku explorer, `connection-capabilities.ts:93`, `registry.rs:563-655`, `control.rs:1272,1453`, 2026-10-29                                                     | -          |
| O6  | Acceptance has no runner; `capture`/`complete` have no production caller; `agent_principal_id` has no production writer                                                                | Observed     | haiku explorer, results client + evidence.rs, 2026-10-29                                                                                                       | -          |
| O7  | Viewer polls one base64 screenshot per second over JSON RPC, also through the relay                                                                                                    | Observed     | `use-sandbox-desktop.ts:15`, viewer `:322-326`, 2026-10-29                                                                                                     | -          |
| O8  | Managed desktops and sandboxes are absent from the remote desktop list; adapter enum is `vnc`/`none` only; phones observe only                                                         | Observed     | `target.rs:30-33`, `remote-desktop-section.tsx:14-24`, viewer `:79-83,361`, 2026-10-29                                                                         | -          |
| O9  | Guest supervisor accepts fixed operations only; no confined exec, files or clipboard                                                                                                   | Verified     | `crates/cognia-desktop-guest/src/main.rs:25-47`, 2026-10-29                                                                                                    | -          |
| O10 | E2B key stored separately by ADR-0221 and ADR-0233 configs; template-build polling still private to sandbox-pool; base URL in three places                                             | Observed     | haiku explorer, `template.rs:239,311`, `provider.rs:218`, `remote-sandbox-draft.ts:41`, 2026-10-29                                                             | -          |
| O11 | Recipe-7 native P4 qualification passed on real E2B on 2026-10-17 in a private diagnostic Host                                                                                         | Observed     | `docs/plans/2026-10-16-managed-desktop-native-qualification.md`                                                                                                | -          |
| C1  | Shared working tree: explicit paths only, no stash/reset/checkout; foreign edits exist in sandbox viewer/hook files                                                                    | Verified     | CLAUDE.md §8; git status 2026-10-29                                                                                                                            | -          |
| C2  | Paid E2B smoke and enablement require separate explicit user authorization                                                                                                             | Verified     | user decision Q2, 2026-10-29                                                                                                                                   | -          |
| G1  | A user can configure, qualify, create, view, control, hand to an agent, accept and clean up a managed desktop from the product, on desktop, Web and phone, without the operator binary | Agreed       | grill Q1–Q23, 2026-10-29                                                                                                                                       | -          |
| G2  | No duplicate implementation: one frame data plane, one lease core, one qualification orchestration, shared E2B primitives                                                              | Agreed       | grill Q13–Q16, Q18, 2026-10-29                                                                                                                                 | -          |
| A1  | Guest screenshot latency allows ~6–8 fps while controlling                                                                                                                             | Unknown      | not measured; computer-server screenshot cost on E2B unknown                                                                                                   | -          |
| A2  | The host and the VNC plugin share the touch controls through the public `@cognia/plugin-ui` entry point | Verified | Both viewers import from the package root and the associated Jest suites pass, 2026-11-16 | - |
| A3  | ADR-0221 secret can be read by reference under `cognia-remote-sandboxes` for the same owner/Host                                                                                       | Invalidated  | `remote-sandboxes.json` is Host-level with no owner; the copy is gated by `host.admin` + Host consent and limited to E2B secret-store credentials (2026-10-29) | -          |
| O12 | 当前源码的 Tauri 和 server 打包目录缺少 Recipe 8 发布 pin。无自备受信清单的 Host 会禁用新建配置 | Verified | `pnpm audit:managed-desktop-release` 返回 absent。设置依据 release status 禁用新建。Host 先查数据目录，再查打包资源 | - |
| O13 | 设置、模板、报价、资格验证、显式创建和销毁、租约、代理委托、验收及受限文件和剪贴板已有正常入口 | Observed | [托管桌面设置](../../components/settings/automation/managed-desktop-settings.tsx#L96)、[资格 gate](../../crates/cognia-automation/src/cua_sandbox/managed/qualification.rs#L523)、[代理绑定](../../lib/sandbox/managed-desktop-binding.ts#L96) | - |
| O14 | 外部 VNC 的只读 session 在上游只提供 RFB None 时仍然连接，观看者键盘消息抵达上游 | Verified | 本机假 VNC 探针使用实际 Host 和只允许 View 的主体。Control 被拒绝，View 无租约，KeyEvent 仍被转发 | - |
| O15 | 原生画面流的观看重连会吞掉持久权限拒绝，输入队列溢出时查看器退出控制并丢弃排队输入 | Verified | 对实际 TS 帧解码和流函数注入假传输。两次 forbidden 仍继续安排恢复，单帧后第 34 次输入报错。查看器处理见 `NativeDesktopSession.input` | - |
| O16 | 同一 E2B 桌面的两个入口能力不同。设备页内联查看器仅有画面与基础控制，首次连接失败无就地重试。设置页查看器有 RPC 截图回退及受限文件和剪贴板 | Observed | [设备入口](../../components/devices/remote-desktop/remote-desktop-section.tsx#L358)、[原生查看器](../../components/devices/remote-desktop/native-desktop-viewer.tsx#L69)、[设置查看器](../../components/settings/automation/managed-desktop-settings.tsx#L599) | - |
| O17 | 工作负载配置只接受 egress Off。桌面最长 60 分钟、默认空闲 10 分钟销毁，每用户在单一 Host 上最多两台 | Verified | [配置拒绝](../../crates/cognia-automation/src/cua_sandbox/managed/config_admin.rs#L19)、[限额](../../crates/cognia-automation/src/cua_sandbox/managed/contracts.rs#L7)、[计数](../../crates/cognia-automation/src/cua_sandbox/managed/service.rs#L834)、[到期定义](../../crates/cognia-automation/src/cua_sandbox/managed/contracts.rs#L742) | - |
| O18 | 跨 Host Agent 绑定未接线，多租户拒绝委托和启动自动验收，Windows Host 拒绝依赖 Unix 进程组的 Git 交接 | Observed | [本地绑定](../../lib/sandbox/managed-desktop-binding.ts#L25)、[部署 gate](../../crates/cognia-companion-rpc/src/managed_desktops.rs#L1633)、[Git 交接](../../crates/cognia-automation/src/cua_sandbox/managed/handoff.rs#L268) | - |
| O19 | 验收证据契约仍检查已经移除的编译期开关和旧的资源比较表达式 | Verified | Node 运行的四项中两项失败，当前运行时授权和 HostSemantic 分支仍能在源码确认 | - |
| O20 | 托管服务 Rust 测试在共享依赖的语法错误处停止，未运行测试 | Verified | `cargo test --locked -p cognia-automation --lib cua_sandbox::managed` 在 `cognia-exec-sandbox/src/net_proxy.rs:968` 报错 | - |
| Q1 | 当前用户实际部署的镜像、回执及桌面、Web、Android 的可用性和性能如何 | Open | 现有真环境记录是旧 Recipe 7 私有诊断 Host。未检查目标部署和 Recipe 8 实例 | O11, O12 |
| O21 | Host 验收记录存储验收标准，公开运行摘要没有标准。重新打开面板时，前端从空的表单 ref 生成子会话首条提示 | Verified | 组件探针模拟收到 `awaitingSession`。面板未发起或重做本次验收，仍调用 attach，首条提示缺少 criterion-0 | - |
| O22 | 两个面板可以同时尝试绑定同一个验收。第二个失败后会取消已经被第一个绑定的运行 | Verified | 两个真实组件实例接收相同 `awaitingSession` 事件。使用响应顺序与 Rust 单次 attach 约束一致的假 Host，观察到两个子会话及一次取消 | - |
| O23 | 验收周期回收重新调用显式 delete，每次重置 next_retry_at，随后强制跳过退避 | Observed | [验收回收](../../crates/cognia-companion-rpc/src/managed_desktop_acceptance.rs#L546)、[显式删除](../../crates/cognia-automation/src/cua_sandbox/managed/service.rs#L1127)、[普通退避](../../crates/cognia-automation/src/cua_sandbox/managed/service.rs#L1166) | - |
| O24 | 证据不可读时，取消 RPC 在提交取消意图前返回。已终态运行的验收回收也可能卡在证据 I/O，普通桌面生命周期仍可执行自己的回收 | Observed | [取消](../../crates/cognia-companion-rpc/src/managed_desktop_acceptance.rs#L226)、[证据错误传播](../../crates/cognia-companion-rpc/src/managed_desktop_acceptance.rs#L422)、[周期回收](../../crates/cognia-companion-rpc/src/managed_desktops.rs#L383) | - |

## Problem frame

The managed desktop (ADR-0233) is built and natively qualified, but a user cannot reach it: configuration, release distribution and qualification exist only for the operator (O1–O3). Agent use and acceptance are locked by constants and lack a runner (O4–O6). The viewer path is a 1 fps poll that is absent from the remote desktop framework and limited on phones (O7–O8). Files, clipboard and shell need guest work (O9). Duplicated E2B pieces remain (O10). Solved means G1 and G2 hold, shown by targeted tests per package and the authorized real smoke in WP12. Out of frame: egress On/Allowlist, persistence/pause, region, live preview, cross-Host transfer, Lume.

上段是 2026-10-29 的问题框架。本轮复审以 Cognia 托管的 E2B 临时验收桌面为主，覆盖它复用的远程桌面链路，并核对外部 VNC、网页控制台和 RustDesk 的接入边界。真实交付需要从干净安装走完配置、开机、连接、接管、传输、验收和销毁。若产品目标扩展到可持续办公的云电脑，另需出网、状态保留和更长会话。该产品范围仍待确认。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                     |
| ------------ | ------ | ----------------------------------------------------------------------------------------------- |
| scale        | high   | 12 packages across Rust crates, companion RPC, renderer, guest image and CI                     |
| technical    | high   | delegation semantics over the shared lease, in-process frame adapter, confined guest operations |
| coupling     | high   | touches ADR-0233/0234/0221 code, plugin-ui, character/session binding, notifications            |
| requirement  | low    | 23 decisions confirmed by the user                                                              |
| verification | high   | real guarantees need paid E2B smoke and phone/relay smoke                                       |
| risk         | high   | spend, cross-owner access, sandbox escape via new guest operations                              |

## Risks

| ID  | Risk (impact)                                                                           | Severity | Source                     | Claim                                                                | Refuted by                                                                    |
| --- | --------------------------------------------------------------------------------------- | -------- | -------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| R1  | Config/credential RPC lets a caller target another owner's account or leaks a key       | high     | ADR-0233 §1                | Owner/Host come only from authenticated context; keys never returned | a test or smoke where a forged owner argument or response contains the key    |
| R2  | In-app qualification or delegation lets an agent spend money or create desktops         | high     | ADR-0233 §4                | Only human admin actions spend or delegate                           | an agent/service principal reaches create, qualify or delegate                |
| R3  | Agent input bypasses human takeover or survives revocation                              | high     | ADR-0234 §2                | Takeover fences and revokes in-flight agent input within one call    | agent input accepted after takeover/revoke                                    |
| R4  | New guest exec/file/clipboard operations escape the workload boundary or reach metadata | high     | ADR-0233 MMDS amendment    | Every operation runs inside the full boundary                        | a qualification probe gets a metadata/private response or escapes containment |
| R5  | Frame stream ticket reaches another target or keeps streaming after revoke              | medium   | ADR-0234 §9 security tests | Tickets bound to session/target/mode; revoke closes stream           | cross-target attach or frames after revoke                                    |
| R6  | Frame stream adds guest load per viewer or drains billing via idle reset                | medium   | design Q15                 | One poller per desktop; viewing is not activity                      | capture count scales with viewers, or idle timer refreshed by viewing         |
| R7  | Shared E2B primitive extraction changes code-sandbox template behavior                  | medium   | ADR-0233 §1                | Code provider semantics unchanged                                    | FakeE2b contract test diff                                                    |
| R8  | Runtime gates enable a configuration with a stale receipt                               | high     | ADR-0233 §9                | Switches require a current receipt and drop on config change         | switch on after a config/recipe change                                        |
| R9 | 外部桌面只读授权可实际发送输入 | high | ADR-0234 §2、§4 | 仅观看主体无法向外部桌面发出有效输入 | 上游改为 None 后，无控制租约的观看会话把 KeyEvent 送到服务器 |
| R10 | 干净安装不能开启托管桌面 | high | ADR-0233 A2–A4、WP12 | 启用该功能的发行包带有可核验的 Recipe 8 镜像清单 | 打包目录缺失清单，或新装 Host 上配置入口禁用 |
| R11 | 权限撤销、画面停滞或输入高峰导致旧画面、静默丢操作和重复重试 | medium | ADR-0234 N2–N3、连接和背压故障注入 | 终态拒绝可见，输入饱和有明确信号，重新观看无需重新获得控制 | 永久权限拒绝继续重试，或输入溢出后整个控制 stream 关闭 |
| R12 | 当前代码的生命周期与授权保护缺乏可运行的验证 | high | ADR-0233 A4、§5、§8，Rust 编译与协议契约 | 托管测试可构建，证据读取、授权和重试的契约接受当前正确实现 | 依赖无法编译或契约因旧源码表达式失败 |
| R13 | 已计费验收的结果不完整或被并发界面取消 | high | ADR-0233 A6、客户端重开和并发订阅 | 首条提示与 Host 持久化标准一致，重复绑定无副作用 | 重开后提示无验收标准，第二个面板取消第一处已绑定的运行 |
| R14 | provider 故障下回收反复请求或取消意图丢失 | medium | ADR-0233 §5、验收与普通生命周期回收路径 | 验收遵守统一退避，证据故障时仍可持久化停止和回收意图 | 后台绕过 next_retry_at，或证据读错误发生在取消意图落盘之前 |

## Verification obligations

| ID  | Risk   | Method                                                                                          | Independence   | Evidence                                                                                                                                                                                                                                                                                      | Coverage                                                                                                                                                  | Status  |
| --- | ------ | ----------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1     | Rust tests for forged owner, cross-owner copy, response/log redaction (WP3)                     | tool           | `cargo test -p cognia-automation --lib cua_sandbox::managed` 102 passed; `-p cognia-companion-rpc --lib managed_desktop` 51 passed (clean worktree, 2026-10-29)                                                                                                                               | owner/Host derived from principal; foreign owner sees nothing; copy only from a stored E2B secret-store credential; log redaction not separately asserted | passed  |
| V2  | R1, R2 | fresh-context review of config/qualify/delegate RPC authority                                   | fresh-reviewer | -                                                                                                                                                                                                                                                                                             | -                                                                                                                                                         | planned |
| V3  | R2     | Rust tests: agent/service refused for qualify, create, delegate (WP4, WP8)                      | tool           | `service::unqualified_production_refuses_before_any_paid_desktop_and_agent_cannot_authorize`, `managed_desktops::delegation_rpc_requires_human_admin_and_remote_lease_but_local_needs_no_lease`, `managed_desktop_results::human_or_unqualified_agent_cannot_publish_an_agent_verdict`        | qualify/create and delegate need a human administrator; agents cannot publish verdicts                                                                    | passed  |
| V4  | R3     | Rust tests for takeover/revoke/generation change plus real E2B agent takeover smoke (WP8, WP12) | real-env       | -                                                                                                                                                                                                                                                                                             | -                                                                                                                                                         | planned |
| V5  | R4     | recipe-8 workload qualification probes on real E2B (WP10, WP12)                                 | real-env       | -                                                                                                                                                                                                                                                                                             | -                                                                                                                                                         | planned |
| V6  | R5     | Rust tests for cross-target ticket and revoke-closes-stream (WP6)                               | tool           | `bridge::native_loopback_ticket_cannot_attach_to_another_target`, `control::frames_are_principal_and_fence_bound_and_single_use_globally`, `host::frames_revocation_closes_the_attached_native_bridge`, `frames::frames_revoke_each_viewer_independently_and_continue_capture` (`27f63a473c`) | ticket bound to principal, target and fence; revoke closes the bridge                                                                                     | passed  |
| V7  | R6     | fan-out test (N viewers, one capture) and idle-timer test; measured rate in desktop smoke       | tool           | `frames::fanout_dedup_and_stop_without_viewers` (one capture loop per target, stops without viewers)                                                                                                                                                                                          | fan-out tested; measured rate and the idle-timer check still wait for the WP12 smoke                                                                      | planned |
| V8  | R7     | sandbox-pool FakeE2b contract suite unchanged (WP1)                                             | tool           | `cargo test -p cognia-sandbox-pool --features e2b remote::e2b` 51 passed, `aaf3808e26`                                                                                                                                                                                                        | code-provider template naming/lookup untouched                                                                                                            | passed  |
| V9  | R8     | Rust tests: switch refused without receipt, dropped after config change (WP4)                   | tool           | `config_admin::forged_enablement_is_refused_without_current_native_receipts`, `delegation::disabling_the_switch_or_invalidating_receipts_between_sends_fences_the_pump`, `qualification::recipe_7_receipts_are_stale_under_a_recipe_8_trusted_release`                                        | switch refused without current receipts; stale receipts fence agent sends                                                                                 | passed  |
| V10 | R10 | 检查实际构建输入及新建配置门控 | tool | `pnpm --config.verify-deps-before-run=false audit:managed-desktop-release` 返回 0，输出 `No managed desktop release is pinned; managed desktops stay dormant in this build.` | 当前源码的默认打包资源。未读取用户 Host 数据目录 | failed |
| V11 | R9 | 用只允许 View 的配对主体连接回环 VNC fixture，从正常 Host session 投递自定义 KeyEvent | tool | 本机 Rust 探针通过实际 `open_session`、`attach_viewer`、RFB 握手及 TCP bridge。无 Control grant、无租约，8 字节 KeyEvent 抵达上游 | 本机 fake RFB 3.8，无认证上游，只读会话。无外部目标访问 | failed |
| V12 | R11 | 注入持续权限拒绝及单帧上的输入突发，复查两个查看器 | tool | 两次 `remote_desktop_forbidden` 后第三次重试仍被安排且继续上报 `remote_desktop_connection_lost`。一条已发送、32 条排队，第 34 条抛出 `remote_desktop_frame_invalid` | 实际客户端帧处理和流代码配合假传输。真实打字延迟未测 | failed |
| V13 | R9, R11 | 运行远程桌面 Rust 和相关 Jest 套件 | tool | `cargo test --locked -p cognia-remote-desktop --lib` 123/123。Jest unit lane 定向选择 components、hooks、lib、packages 和 plugins，60 suites、596/596 | 票据、掉线、接管、帧协议、VNC bridge、设置和客户端逻辑。现有用例未覆盖 V11–V12 的失败场景 | passed |
| V14 | R12 | 用 Node runner 检查镜像和验收契约 | tool | `node --test scripts/build/managed-desktop-release.test.mjs scripts/build/managed-desktop-context.test.mjs protocol/managed-desktop-results-contract.test.mjs` 15/17。两项均来自 protocol 文件第 23、68 行的旧断言 | 源码契约、镜像上下文和发布脚本。Jest 的广筛选也会误收此 Node suite | failed |
| V15 | R12 | 运行托管服务 Rust 生命周期、资格与隔离用例 | tool | 在 `net_proxy.rs:968` 编译失败，stderr 含 ``found `=>` `` | 共享依赖编译失败，未进入测试主体 | blocked |
| V16 | R3, R4, R6, R10 | 使用预期发布包和真实 Recipe 8 走完多端开机、接管、验收和销毁 | real-env | - | 需实际 Recipe 8 发布、目标 Host、配对 Android 与 Web、E2B 资格和计费授权 | blocked |
| V17 | R13 | 用已入库的待绑定运行打开新面板，并让两套面板同时收到该运行 | tool | 两个本机 Jest 探针确认 O21 和 O22。原有 `managed-desktop-handoff.test.tsx` 18/18 | 真实组件、假 Host 和会话依赖。Host 拒绝第二次 attach 的分支另有源码依据 | failed |
| V18 | R14 | 逐步核对 worker、验收回收、显式删除、退避及证据锁失败分支 | self | 周期任务调用强制删除路径，证据读取用 `?` 提前退出。分别见 O23、O24 | 静态控制流。实际调用频率、故障时限及 provider 效应需要 Rust 假 provider 测试 | failed |

## Decisions

| ID  | Date       | Decision                                                                                                                                                               | Action    | Based on       | Reversal trigger                                       |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------- | ------------------------------------------------------ |
| D1  | 2026-10-29 | Scope A + D link; implement after audit; paid smoke separately authorized (Q1, Q2)                                                                                     | implement | G1, C2         | user changes scope                                     |
| D2  | 2026-10-29 | Config/credential RPC + form; explicit key copy from ADR-0221; release bundled in signed builds; in-app qualification; runtime gates (Q3–Q7)                           | implement | O1, O2, O3, O4 | E2B API change invalidating smoke                      |
| D3  | 2026-10-29 | `cognia-frames` adapter on ADR-0234 data plane, one poller per target, also for Docker; native targets projected; phone control via shared touch kit (Q8, Q9, Q14–Q16) | implement | O7, O8, A2     | A2 Invalidated or A1 shows rates unattainable          |
| D4  | 2026-10-29 | Host delegation for general computer use and acceptance; agent fenced-preemptible without a lease; acceptance child session with two tools (Q17–Q21)                   | implement | O5, O6         | review finds lease semantics unsound for remote agents |
| D5  | 2026-10-29 | Recipe 8 for exec/files/clipboard as Stage 2; egress On/Allowlist deferred to its own amendment (Q10, Q11, Q19, Q22)                                                   | implement | O9             | user requires egress in this round                     |
| D6  | 2026-10-29 | Merge E2B build request/polling/base URL into cognia-e2b; code provider semantics unchanged (Q13)                                                                      | implement | O10            | V8 fails                                               |
| D7  | 2026-10-29 | Pin the release manifest in the repo with a source-digest drift gate; the first pin waits for an authorized image republish (Q24)                                      | implement | O2             | release pipeline gains signed remote manifests         |
| D8  | 2026-10-29 | Qualify inside the running Host; handoff uses a user-picked delivery; GUI and agent switches need only the four GUI receipts (Q25)                                     | implement | O3, O4         | review shows in-Host authority test weakens the store  |
| D9  | 2026-10-29 | Agents bind only managed desktops of the Host the session runs on; remote-Host binding becomes WP13 (Q26 option a)                                                     | implement | D4             | user asks for remote binding in this round             |
| D10 | 2026-11-16 | 优先修正 VNC 只读边界。把上游身份验证失败和有效输入权限作为两项独立检查 | harden | O14 | Host 严格阻止观看主体的 RFB 输入，且上游认证降级时回归测试通过 |
| D11 | 2026-11-16 | 跟踪 Recipe 8 发布和验证基线，再做真实端到端；重连和输入可用假传输提早复验 | diagnose | O12, O15, O19, O20 | 当前发布包、回执及验收流程的可验证证据补齐 |
| D12 | 2026-11-16 | 优先为验收按 ID 取回持久化标准，增加并发 attach 的幂等结果与恢复路径，并对后台回收补失败注入 | diagnose | O21, O22, O23, O24 | 多面板、重开和 provider、证据存储失败的回归检查均通过 |

## Residual risks

| ID  | Residual                                                                    | From | Why still open                          | Next action                                                 | Status |
| --- | --------------------------------------------------------------------------- | ---- | --------------------------------------- | ----------------------------------------------------------- | ------ |
| X1  | Real frame rate and CPU on E2B unknown                                      | A1   | not measured                            | measure in WP12 smoke                                       | open   |
| X2  | Host-local concurrency limit is not account-wide across Hosts               | D2   | accepted v1 limitation                  | label in UI                                                 | open   |
| X3  | Egress Off makes the desktop offline for internet-dependent acceptance      | D5   | deferred by decision                    | separate amendment                                          | open   |
| X4  | Agents can bind only managed desktops of the Host the session runs on       | D9   | decided Q26 (a), WP13                   | WP13                                                        | open   |
| X5  | Managed exec cannot narrow writes below the workload home or take env/stdin | D5   | guest exec contract is argv/cwd/timeout | requests are attested like Docker and refused when stricter | open   |
| X6 | 当前配置、计费和委托授权缺少本轮独立复跑 | V2 | 本轮检查聚焦发布和连接证伪 | 后续伴随当前 Host 和 provider 实测复跑 | open |
| X7 | 尚无当前 Recipe 8 的抢占、工作负载隔离、回收和多端画面实测 | V4, V5, V7, V16, M1, M2, M3 | 旧 Recipe 7 记录不能覆盖当前版本 | 做发布包真实验收，记录点击延迟、帧率、回收和残余费用 | open |
| X8 | 默认发行包没有启用托管桌面所需的发布清单 | V10 | Repo 没有 pin，缺失会被 drift gate 当作合法休眠 | 成功构建并发布 Recipe 8，固定 digest，核对发行资源和首次安装 | open |
| X9 | 外部 VNC 的 View 权限可能穿透到输入 | V11 | 在只提供 None 的 VNC 服务上已复现 | View 遇到 None 必须拒绝，并在数据面验证真正只读 | open |
| X10 | 恢复状态和输入拥塞缺乏可见、可恢复的反馈 | V12 | 设备页没有对这些故障的恢复路径 | 复用现有流与租约，区分终态拒绝和可恢复断线，完善输入积压处理 | open |
| X11 | 验收契约 gate 和托管 Rust 测试未绿 | V14, V15 | 旧断言、错误测试归属和共享依赖编译中断 | 恢复正确验证入口，复跑授权、幂等、清理和故障注入 | open |
| X12 | 验收重新打开丢标准，并发面板可重复创建子会话并取消成功绑定 | V17 | 标准和去重状态都在面板实例内 | 从 Host 的不可变验收记录恢复标准，覆盖两个面板和迟到响应 | open |
| X13 | 验收回收跳过退避，证据存储故障可阻止取消落盘 | V18 | 验收复用了显式删除路径，取消先读证据 | 用 fake provider 记录清理重试间隔，注入证据读失败并确认租约和云资源收敛 | open |

## Outcome

| ID  | Signal                                                                                         | How / when measured                    | Result | Status  |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------- | ------ | ------- |
| M1  | A user configures, qualifies and uses a managed desktop end to end without the operator binary | WP12 authorized real smoke             | -      | pending |
| M2  | Agent computer use and one acceptance complete on a managed desktop                            | WP12 authorized real smoke             | -      | pending |
| M3  | Phone controls a native target over relay                                                      | WP12 desktop smoke on the Huawei phone | -      | pending |
| M4 | 识别当前已实现功能、已证实问题和需真实证据的缺口 | 阅读实际调用链，跑定向验证和故障注入 | 本轮复审结论及 V10–V16 | met |
| M5 | 复核云电脑关键缺口的代码与运行条件 | 核对 RPC、Host 和组件调用链，验证验收恢复边界 | 代码复核及 V17–V18 | met |

## 2026-11-16 复审

### 优先处理的问题

1. **P0，默认构建无法从零新建托管桌面。** 打包和状态展示已经接线。当前分发目录只有 README，Host 预期 Recipe 8 的不可变镜像清单，且 drift gate 允许无 pin 的休眠构建成功。对有自备清单的 Host，实际状态以该机回读为准。发布后仍要建立当前配置绑定的回执，旧 Recipe 7 回执不能直接沿用。 [打包说明](../../src-tauri/resources/managed-desktop/README.md) · [发布加载](../../crates/cognia-companion-rpc/src/managed_desktop_release.rs#L37) · [新建按钮](../../components/settings/automation/managed-desktop-settings.tsx#L168)
2. **P0，外部 VNC 的只读权限可绕过。** Host 对 View 读取保存的只读密码，然而上游握手如果仅提供 `None`，仍会成功。随后桥接器双向透传 RFB 消息。若远端禁用了认证并允许输入，仅有查看权限的配对设备可越过 Cognia 的接管许可。修复至少需要对 View 拒绝降级到 None。若产品承诺 Cognia 自己强制只读，还要验证上游凭据被错配到可写账户时，数据面仍拒绝输入。 [View 的授权](../../crates/cognia-remote-desktop/src/commands.rs#L42) · [凭据选择](../../crates/cognia-remote-desktop/src/host.rs#L709) · [RFB 安全类型](../../crates/cognia-remote-desktop/src/rfb.rs#L137) · [双向桥接](../../crates/cognia-remote-desktop/src/bridge.rs#L535)
3. **P1，原生有流但恢复和交互不完整。** 设备入口首次失败只显示通用错误，需关闭重开。已连接后的观看重试会吞掉新的永久拒绝，重连页保留最后一帧且缺少明确重连提示。输入依赖一帧一条证明，饱和即丢弃未发队列并回到观看，Host 的非致命输入拒绝也仅进入审计。控制断线后必须手动重新取得租约是既有安全要求。 [重连与输入队列](../../lib/remote-desktop/native-stream.ts#L202) · [设备查看器](../../components/devices/remote-desktop/native-desktop-viewer.tsx#L69) · [Host 输入拒绝](../../crates/cognia-remote-desktop/src/bridge.rs#L450)
4. **P1，同一台桌面在不同入口的操作不对齐。** 管理入口有明确的状态、期限、销毁、文件和文本剪贴板。设备入口只挂基础查看器，没有相同的回退和传输控件。当前托管文件操作是工作负载家目录内的单文件路径式上传/下载，单文件 8 MiB。大文件、多文件、目录浏览、可恢复传输和自动剪贴板未在当前入口提供。托管帧是截图/JPEG，在 Host 去重并按帧调节频率。143 毫秒控制间隔和 2 秒静止间隔是代码参数，真实体验、GPU/CPU 和中继吞吐待测。 [设备入口](../../components/devices/remote-desktop/remote-desktop-section.tsx#L358) · [文件实现](../../components/settings/automation/sandbox-file-transfer.tsx#L90) · [帧率参数](../../crates/cognia-remote-desktop/src/frames.rs#L21)

### 产品边界与管理缺口

| 场景 | 当前可用能力与缺口 |
| --- | --- |
| 临时离线验收 | 有明确计费授权、硬截止、幂等创建、状态监控、自动回收、Agent/人工取证。当前交付受发布及资格阻塞。真实链路要覆盖未知创建结果、Host 重启、云端删除失败重试和云端零残留。 [生命周期对账](../../crates/cognia-automation/src/cua_sandbox/managed/service.rs#L1195) |
| 联网日常办公或联网验收 | 只接受 egress Off，依赖公网的网页、登录、依赖下载或远端服务不可用。不支持暂停和恢复、持久盘或快照、区域选择、端口实时预览或跨 Host 迁移。E2B 的 SDK 文档提供出网开关与暂停 API，Cognia 仍需相应隔离、持久化、计费和回收设计。 [ADR-0233 A10](../content/docs/zh/adr/0233-a-managed-desktop-accepts-a-delivered-commit.md#L389) · [E2B SDK](https://e2b.dev/docs/sdk-reference/python-sdk/v2.5.0/sandbox_sync) |
| 容量和成本运营 | 最多两台按 owner/Host 计数，报价依赖人工确认的账户权益和价格，界面汇总本 Host 的最大费用敞口和待清理资源。源码没有 E2B 账户级跨 Host 配额或实际账单对账入口。 [准入与配额](../../crates/cognia-automation/src/cua_sandbox/managed/service.rs#L827) · [费用监控](../../components/settings/automation/managed-desktop-monitor.tsx#L11) |
| Agent 与多端 | Agent 仅能绑定会话所在 Host 的托管桌面。多租户拒绝常规桌面委托和验收启动。Windows Host 拒绝依赖 Unix 进程组的 Git 交接。Web、Android 的代码路径存在，缺当前真机配对和真实 provider 验收证据。 [WP13](../plans/2026-10-29-managed-desktop-completion.md#L234) · [多租户门控](../../crates/cognia-companion-rpc/src/managed_desktops.rs#L1633) · [交接限制](../../crates/cognia-automation/src/cua_sandbox/managed/handoff.rs#L268) |
| 外部桌面连接 | VNC 仅有 None 和传统 VncAuth 的上游握手。RDP 通过自备 Guacamole 或 MeshCentral，RustDesk 为客户端唤起，Selkies 为本地 Docker 可选绑定。普通外部目标缺 Cognia 提供的文件、剪贴板、录制和 Agent Computer Use。 [ADR-0234 provider 边界](../content/docs/zh/adr/0234-a-remote-desktop-is-a-provider-binding-brokered-by-the-host.md#L119) |

本轮更新证据台账，执行本机 fixture 和定向测试。真机、计费实例和在用部署的验证仍待完成。Rust 阻断来自当前共享依赖，验收契约两项失败来自断言与实现漂移。下一轮应先恢复构建与验证链，发布并固定 Recipe 8，收紧 VNC 只读边界，再用一次完整的真实发布包测试覆盖桌面、配对 Web 和 Android。

### 代码复核

复核基于 `fb961a40e7` 及当前工作树。和初次复审之后的 `e4eaf4bf96` 相比，桌面核心目录与验收组件的已提交代码无差异。

- **标准在恢复时丢失。** Host 把标准写入 `AcceptanceRunRecord.request`，运行列表只返回 `run` 摘要。面板处理就绪事件时，从本地 `preparedInput.current` 取标准。重开面板会得到空标准，同一交付再次准备时还可能用到另一笔请求的标准。探针覆盖了空标准分支。 [Host 记录与摘要](../../crates/cognia-automation/src/cua_sandbox/managed/acceptance.rs#L73) · [首条提示生成](../../components/settings/automation/managed-desktop-handoff.tsx#L146)
- **并发绑定误触发取消。** `attaching` 只在单面板有效。两个面板都先创建子会话，Host 仅接受第一个 attach。第二个会收到 invalid state，进入前端通用失败分支，取消同一个验收。Host 的 cancel 路径会结束尚无已持久 verdict 的活动运行，并进入回收。 [前端订阅与取消](../../components/settings/automation/managed-desktop-handoff.tsx#L189) · [Host 单次绑定](../../crates/cognia-automation/src/cua_sandbox/managed/acceptance.rs#L527) · [Host 取消](../../crates/cognia-companion-rpc/src/managed_desktop_acceptance.rs#L226)
- **证据故障与停止耦合。** 取消先读证据以判断是否已有持久 verdict。索引损坏、密钥缺失或其他读错误会提前返回，取消意图尚未写入验收 journal。对已终态的运行，验收回收同样先读证据。普通生命周期负责资源到期和已记账的删除请求，因此这些故障的已知影响是即时取消失败、验收清理状态停滞或延迟。 [证据错误传播](../../crates/cognia-companion-rpc/src/managed_desktop_acceptance.rs#L422) · [普通回收](../../crates/cognia-automation/src/cua_sandbox/managed/service.rs#L1195)
- **验收后台绕过回收退避。** 周期 worker 的验收对账先走 `delete`，每次重写 `next_retry_at` 并强制前进。普通对账遵守 15 秒起步、最长 10 分钟的退避。验收尚待清理时，快速 provider 错误可能按 worker 的 5 秒周期重复触发。生命周期操作还共享一把锁，provider I/O 慢会延迟其他创建、连接和删除。这部分结论来自源码，实际频率及队列延迟待测。 [worker](../../crates/cognia-companion-rpc/src/managed_desktops.rs#L383) · [验收调用 delete](../../crates/cognia-companion-rpc/src/managed_desktop_acceptance.rs#L546) · [删除与退避](../../crates/cognia-automation/src/cua_sandbox/managed/service.rs#L1119)

远程验收的具体缺口位于子会话编排与工具权限。管理 RPC 存在配对设备管理员和 step-up 通路，设置页仍只在 local target 启动及绑定子会话，`checkpoint` / `complete` 工具也明确要求本地调用。外部 VNC 的只读降级发生在授权之后，`host.observe` 与 `host.admin` 在 Companion 入口已有区分。 [Host 授权分流](../../crates/cognia-companion/src/ws_remote_desktop.rs#L71) · [验收管理入口](../../crates/cognia-companion-rpc/src/managed_desktops.rs#L1785) · [本地证据工具](../../crates/cognia-companion-rpc/src/managed_desktop_acceptance.rs#L648)
