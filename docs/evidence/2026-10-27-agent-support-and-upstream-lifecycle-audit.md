# Evidence ledger: agent support and upstream lifecycle audit

- Status: verifying
- Lane: deep
- Created: 2026-10-27
- Updated: 2026-11-17
- Related: ADR-0090, ADR-0216, ADR-0217; working-tree external-agent catalogs

## Original request

> 校对一下cognia对下面的agent的支持情况，注意还要检查对应的agent是否活着，死了的就不要了

The requested names are Claude Code, Codex, Grok, Cursor, GitHub Copilot,
Muse, DeepSeek Harness, ZCode, OpenCode, MiMo Code, Amp, OpenClaude,
Antigravity, Pi, oh-my-pi, Hermes Agent, Devin, Goose, Auggie, Autohand Code,
Charm, Cline, CodeBuddy, Codebuff, Freebuff, Command Code, Continue, Droid,
Kilocode, Kimi, Kiro, Mistral Vibe, Qwen Code, Rovo Dev, and “+ any CLI agent”.

### Authorized implementation follow-up

> 把这些还活着但没接入的 agent 的支持补齐，oh-my-pi 也接入应用，修复这次发现的 OpenCode 测试和 runtime gate 问题，并做完整验证，别只加预设。注意符合现在的架构，，代码结构合理，有问题你可以先和我确认

The user selected managed terminal sessions for agents without a confirmed
stable machine interface: launch, status, interaction, stop and cleanup, with
explicit capability limits. Agents with usable ACP/SDK/machine interfaces use
the structured chat path. The earlier matrix below is the audit baseline;
implementation acceptance is tracked in the following table.

| Requirement | Flow and ownership                                                                                              | Acceptance and verification                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REQ-01      | Settings catalog → configure native protocol/account/workspace → existing external-agent host → chat execution. | Every new structured product has protocol wiring, inspected launch identity, host policy, capability/mode truth, instructions, streaming/failure/cancel/cleanup and negotiated session/MCP handling; regression and isolated real-process checks. |
| REQ-02      | Terminal-only catalog → explicit workspace → existing PTY host and dock.                                        | Reachable launch, deduplicated live session, native interaction, accurate exit/status, reopen, stop and removal; no fake structured chat capability.                                                                                              |
| REQ-03      | Oh My Pi → application entry → supported current protocol.                                                      | A real app-selected execution route, not merely an unregistered package or metadata row; host permission/outbound boundaries and lifecycle verified.                                                                                              |
| REQ-04      | OpenCode compatibility picker and runtime governance checker.                                                   | Preserve executable V1/V2 compatibility; actual checks pass and reject missing/malformed preset declarations.                                                                                                                                     |
| REQ-05      | Complete integration review and validation.                                                                     | Relevant unit/integration/package/native checks, type/lint/static-export/i18n/build gates, browser/native flow and source/diff review; report genuine blockers with exact evidence.                                                               |

Implementation sequence: establish exact current machine contracts and authority
limits; implement behind existing host ports; complete per-product registration,
policy and app paths; run focused red-to-green tests and isolated actual CLIs;
run broader gates and actual UI/native acceptance; reconcile each requirement.

No missing agent executable was found on the current PATH at follow-up start.
The filesystem had 8.1 GiB free. Task-local installs and builds must preserve
the shared workspace and existing installations; missing credentials or device
resources remain explicit acceptance prerequisites, not reasons to relabel
fixture traffic as authenticated acceptance.

## Problem frame

The remaining audit sections through the baseline review record preserve the
initial read-only snapshot. They do not describe the post-implementation state;
the implementation results and outstanding acceptance work follow them.

Audit the current working tree and current primary upstream sources. Separate
product lifecycle, built-in structured execution, package-only implementation,
manual terminal use, and runtime acceptance. An installable CLI, model-provider
entry, MCP configuration, transcript importer, or live repository alone does
not establish an executable Cognia agent integration. The deliverable is an
audit and a concrete remediation list.

The audit found **16 registered products, 1 package-only product, and 17 products
without built-in execution presets**, out of 34 requested names. No current
product in the list has sufficient primary evidence to remove it as dead.
Discontinued predecessors and moved repositories must be handled by exact
identity, as described below. No runtime source was changed by this audit.

This new dated ledger is necessary because previous evidence files cover
individual integrations or different dates; none covers this exact 34-product
inventory and its lifecycle comparison.

## Knowledge

| ID  | Statement                                                                                                                                                   | State    | Basis                                                                                                                                                                 | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | Audit all 34 named products and exclude discontinued implementations from the resulting support recommendations.                                            | Agreed   | User request, 2026-10-27.                                                                                                                                             | -          |
| C1  | Preserve concurrent changes and distinguish source registration from tested runtime behavior.                                                               | Verified | Current task instructions and dirty working tree, 2026-10-27.                                                                                                         | -          |
| O1  | Exactly 16 requested products map to current built-in execution presets and runtime catalog entries.                                                        | Verified | TypeScript AST extraction, runtime JSON comparison and source tracing; source-snapshot.json, 2026-10-27.                                                              | -          |
| O2  | oh-my-pi has a private integration package but no app dependency, protocol factory, built-in preset or runtime registration.                                | Verified | packages/agent-omp/package.json and src/manifest.ts, root package.json, manager.ts and runtime JSON, 2026-10-27.                                                      | -          |
| O3  | All 34 current product identities have current primary-source existence/distribution evidence; no current-product retirement was established.               | Verified | Two upstream research groups; primary sources in the matrix below, 2026-10-27. Existence is not an inference-service health check.                                    | -          |
| O4  | The old Python Kimi CLI and old Go OpenCode predecessor are discontinued; current Kimi Code and Crush remain active.                                        | Verified | Exact official archive/migration notices linked below, 2026-10-27.                                                                                                    | -          |
| O5  | The six selected Jest suites report 179 passed and 2 failed tests.                                                                                          | Observed | catalog-tests.log; Node v26.12.1, pnpm 11.18.0, 2026-10-27.                                                                                                           | -          |
| O6  | The runtime gate reads the preset union from its former owning file and reports false missing-preset errors.                                                | Verified | Standard gate fails; diagnostic reads 0 IDs at old path, 27 at owning path, and runChecks returns no errors with the owning source. gate-diagnostic.json, 2026-10-27. | -          |
| O7  | A generic CLI can use an available PTY manually, but structured execution needs a registered protocol, permitted command/environment, and a supported host. | Verified | Terminal session.rs, manager protocol registration, CLI validateCommand and Rust SpawnPolicy, 2026-10-27.                                                             | -          |
| O8  | ACP Registry discovery exists in the lifecycle service but has no application caller or browsing surface.                                                   | Verified | discoverRegistryRuntimes definition and call-site search; lifecycle/service.ts and registry-discovery.ts, 2026-10-27.                                                 | -          |
| G2  | 按当前代码逐个核对已接入的外部 Agent、运行入口、能力边界和已知故障。 | Agreed | 2026-11-17 用户请求，详见文末复核。 | - |
| O9  | 当前目录有 41 条运行时、44 个预设 ID，其中 43 个标为可执行。 | Verified | 2026-11-17，基于 f020e386afe8 的工作树，预设源、运行时门禁和适配器注册对照。 | - |
| O10 | ACP 模式通知可改变审批结果，A2A Agent Card 可改变带凭证的发送目标。 | Verified | 2026-11-17，真实适配器和合成传输输入，见文末 F1、F2。 | - |
| O11 | Qoder 1.1.65 可通过 Cognia CLI Host 完成隔离握手和重连。 | Verified | 2026-11-17，macOS ARM64 真实进程，session/new 要求认证。 | - |

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                                                                             |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| scale        | medium | 34 product identities across multiple upstream owners.                                                                  |
| technical    | medium | ACP, native RPC, app-server, SDK, headless and terminal-only surfaces differ.                                           |
| coupling     | medium | Presets, runtime catalog, security policy, host factories and UI exposure must agree.                                   |
| requirement  | low    | Audit and lifecycle filtering; no general integration implementation requested.                                         |
| verification | medium | Primary lifecycle evidence and source checks are available; account-specific runtime health is outside this audit.      |
| risk         | medium | Incorrect lifecycle filtering could remove an active successor; overstated support could promise nonexistent execution. |

## Risks

| ID  | Risk (impact)                                                                                     | Severity | Source                                                     | Claim                                                        | Refuted by                                                           |
| --- | ------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| R1  | A retired artifact or repository move is mistaken for a dead current product.                     | medium   | Kimi, Crush, Kilo, Goose and Codebuff upstream identities. | Filter by exact product and artifact, with primary evidence. | A current official retirement notice for a retained product.         |
| R2  | Catalog entries, dormant packages or manual CLI use are advertised as equivalent runtime support. | medium   | Current factory and catalog wiring.                        | Matrix describes the supported surface and its limits.       | A missing factory/preset in a claimed built-in route.                |
| R3  | Failing checks or historical smokes are presented as current full acceptance.                     | medium   | Focused test failures and older evidence reports.          | Report current checks and historical evidence separately.    | Claiming authenticated or cross-platform acceptance from this audit. |

| R4 | Agent 报告的运行时状态改变 Host 审批授权。 | high | ADR-0198、ADR-0243 及 ACP 客户端的模式映射。 | Host 计划模式在 Agent 通知后仍拒绝权限请求。 | 原输入和原审批策略不变时，先拒绝、后放行。 |
| R5 | 自动发现的远端可改变凭证和任务输入的接收方。 | high | 本轮 A2A Agent Card 与认证路径核对。 | 配置的凭证及任务输入只交给已授权 origin。 | 自动发现用同一个凭证跨 origin 提交请求。 |
| R6 | 服务中断后失去审批状态、复用失效会话或重复提交。 | medium | ADR-0217、适配器生命周期契约和本轮故障注入。 | 传输失败可以恢复或给出可安全处理的明确状态。 | 已提交请求被重发、关闭后进程未清理、恢复返回失效会话。 |

## Verification obligations

| ID  | Risk   | Method                                                                                                           | Independence | Evidence                                                                                                                 | Coverage                                                                               | Status |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------ |
| V1  | R2     | Parse actual preset object, cross-check runtime rows, trace factory/security/registry paths.                     | tool         | source-snapshot.json: requested=34, registered=16, packageOnly=1, notRegistered=17.                                      | Working-tree static wiring; not inference.                                             | passed |
| V2  | R1     | Check canonical official docs, repositories, archive notices and distribution metadata for every requested name. | subagent     | upstream-a.md and upstream-b.md, with primary links reproduced below; 17 names per group.                                | Product existence and maintenance signals; not account entitlement or endpoint health. | passed |
| V3  | R2, R3 | Run six existing catalog, preset, protocol-picker and registry Jest suites through pnpm test.                    | tool         | 5 suites passed, 1 failed; 179 tests passed, 2 failed. Failures concern legacy OpenCode picker expectations.             | Local unit/contract checks; no coverage collected.                                     | failed |
| V4  | R2, R3 | Run pnpm audit:external-agent-runtimes and diagnose failure without changing source.                             | tool         | Generated catalog is current; normal gate exits 1. Injecting the relocated owning preset-type source yields zero errors. | Catalog governance and parser diagnosis; normal entry point remains failing.           | failed |
| V5  | R3     | Review report completeness, task-only diff, formatting and source freshness.                                     | tool         | Final review record below.                                                                                               | Audit artifact only; existing unrelated changes preserved.                             | passed |

| V6 | R2 | 核对预设、目录、适配器、平台和客户端入口。 | tool | 41 条运行时、44 个预设 ID、43 个标记可执行；七条直接静态检查退出 0。 | 2026-11-17 工作树目录、注册、Host source 和 TUI 探针。 | passed |
| V7 | R4, R5, R6 | 用合成输入和实际适配器运行权限、发现、重试与清理的反例。 | tool | 文末 F1–F10，四个复现脚本均成功断言现存故障。 | 实际 TypeScript 适配器、合成帧、合成文件/凭证、Mac argv 边界。 | failed |
| V8 | R2, R3 | 运行仓库 Jest 和现有 smoke。 | tool | 328/337 套件通过、13 个测试失败；常规 pnpm 受 postinstall 阻塞。Codex 隔离握手及 Qoder Cognia Host 连接/重连通过。 | macOS ARM64；Qoder 首次会话要求凭证。 | failed |
| V9 | R3 | 平台与供应商可用性验收。 | real-env | 当前仅能取得上述无凭证进程证据及历史版本记录。 | Tauri、配对手机/浏览器、真实 PTY、Linux/Windows、已登录回合。 | blocked |

## Decisions

| ID  | Date       | Decision                                                                                                             | Action   | Based on           | Reversal trigger                                                       |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ | ---------------------------------------------------------------------- |
| D1  | 2026-10-27 | Deliver a source-backed audit; do not add unsupported presets from logos or generic CLI claims.                      | diagnose | G1, C1, O1, O2, O7 | User requests implementation of specific additional integrations.      |
| D2  | 2026-10-27 | Keep all current product identities; exclude only exact discontinued predecessors from recommendations.              | ship     | O3, O4             | Authoritative evidence establishes a current product has been retired. |
| D3  | 2026-10-27 | Carry current test/gate inconsistencies as findings rather than rewriting concurrent runtime work during this audit. | diagnose | G1, C1, O5, O6     | A follow-up authorizes the identified repairs.                         |
| D4 | 2026-11-17 | 用可达的运行入口作为逐项核对基数，按版本记录本地进程、协议夹具和源码证据。 | diagnose | G2, O9 | 工作树目录或运行入口变化。 |

## Complete support matrix

“Registered” means a built-in structured execution route exists in the checked
working tree. It is not a claim that every upstream feature or current release
has passed authenticated acceptance. “Not built in” still permits manual
terminal use when the executable, credentials and terminal host are available.
ACP compatibility elsewhere does not automatically add a Cognia preset,
security policy, credential environment, writable-state policy or certification.

| #   | Requested name / canonical product | Upstream lifecycle evidence                                                                                                                                                                                                                                   | Cognia current structured execution                                                                           | Disposition / integration detail                                                                                                                                                                                                                  |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claude Code                        | Active: [Anthropic repository](https://github.com/anthropics/claude-code).                                                                                                                                                                                    | Registered: `claude-code`, ACP via `claude-agent-acp`. Cognia also has a separate built-in Claude SDK engine. | Keep. Identify the [ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp) separately from the vendor CLI.                                                                                                                         |
| 2   | Codex                              | Active: [OpenAI repository](https://github.com/openai/codex).                                                                                                                                                                                                 | Registered: native `codex app-server`; explicit ACP route also exists.                                        | Keep. Native app-server and ACP are distinct surfaces; cloud/IDE documentation is not local execution.                                                                                                                                            |
| 3   | Grok → Grok Build                  | Active: [xAI product](https://x.ai/build), [vendor source](https://github.com/xai-org/grok-build).                                                                                                                                                            | Registered: `grok agent --no-leader stdio`, ACP.                                                              | Keep official Grok Build identity; do not substitute an unrelated community Grok CLI.                                                                                                                                                             |
| 4   | Cursor → Cursor Agent CLI          | Active: [official CLI docs](https://cursor.com/docs/cli/overview).                                                                                                                                                                                            | Registered: `cursor-agent acp`.                                                                               | Keep. [Official changelog](https://cursor.com/changelog/cli-jan-08-2026) retains `cursor-agent` as an alias of `agent`; current installer still creates both. IDE/background-agent surfaces are separate.                                         |
| 5   | GitHub Copilot → Copilot CLI       | Active: [official quickstart](https://docs.github.com/en/copilot/get-started/cli-quickstart).                                                                                                                                                                 | Registered: `copilot --acp`.                                                                                  | Keep current Copilot CLI; [ACP is public preview](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).                                                                                                                 |
| 6   | Muse → Meta Muse Code              | Active: [Meta docs](https://dev.meta.ai/docs/muse-code), [2026-08-05 launch](https://developer.meta.com/ai/resources/blog/build-with-muse-code/).                                                                                                             | Not built in.                                                                                                 | Keep as candidate. Native `muse serve`/`muse schema` and `@muse-code/sdk`; vendor ACP not established here. Muse Spark model support is separate.                                                                                                 |
| 7   | DeepSeek Harness                   | Active developer preview: [official repository](https://github.com/deepseek-ai/deepseek-harness).                                                                                                                                                             | Registered: managed runtime with SDK read-only/workspace-write and interactive ACP profiles.                  | Keep. Managed launch preparation is required; empty static process commands are not missing registrations. Current upstream also documents `npx @deepseek-ai/dsh web`; pinned source runtime support does not imply latest-package certification. |
| 8   | ZCode                              | Active: [Z.ai repository](https://github.com/zai-org/ZCode), [agent docs](https://zcode.z.ai/en/docs/agents).                                                                                                                                                 | Not built in.                                                                                                 | Keep as candidate. `zcode` TUI/web product exists; hosting other agents does not prove ZCode itself exposes ACP.                                                                                                                                  |
| 9   | OpenCode, current project          | Active: [current repository](https://github.com/anomalyco/opencode), [ACP docs](https://opencode.ai/docs/acp/).                                                                                                                                               | Registered: `opencode acp`, V2 service HTTP/SSE, and legacy V1 HTTP/SSE routes.                               | Keep current OpenCode. V1/V2 picker expectations disagree in current tests; do not conflate with archived Go OpenCode.                                                                                                                            |
| 10  | MiMo Code                          | Active: [Xiaomi repository](https://github.com/XiaomiMiMo/MiMo-Code), [vendor docs](https://mimo.xiaomi.com/mimocode/start).                                                                                                                                  | Not built in.                                                                                                 | Keep as candidate. CLI `mimo`, documented `mimo serve`/`attach`; interoperability with Cognia's existing protocols is not established. Model-provider support is separate.                                                                        |
| 11  | Amp                                | Active: [official CLI docs](https://ampcode.com/docs/cli).                                                                                                                                                                                                    | Not built in.                                                                                                 | Keep as candidate. Execute Mode and Streaming JSON are documented; no native ACP established here.                                                                                                                                                |
| 12  | OpenClaude                         | Active independent project: [Twigpine/openclaude](https://github.com/Twigpine/openclaude).                                                                                                                                                                    | Not built in.                                                                                                 | Keep as candidate. Current package `@twigpine/openclaude`, CLI `openclaude`; not Anthropic Claude Code or an automatic reuse of its adapter.                                                                                                      |
| 13  | Antigravity                        | Active: [Google CLI docs](https://antigravity.google/docs/getting-started?tab=cli), [official ACP integration](https://antigravity.google/docs/ide/extensions/zed/).                                                                                          | Registered: separate `agy_acp_server.par` runtime.                                                            | Keep. `agy` terminal login and the separately distributed ACP server are different surfaces.                                                                                                                                                      |
| 14  | Pi                                 | Active: [earendil-works/pi](https://github.com/earendil-works/pi).                                                                                                                                                                                            | Registered: `pi --mode rpc`, native JSONL RPC.                                                                | Keep current npm scope `@earendil-works/pi-coding-agent`; Pi is distinct from oh-my-pi.                                                                                                                                                           |
| 15  | oh-my-pi                           | Active: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), [releases](https://github.com/can1357/oh-my-pi/releases).                                                                                                                                    | Package only: `@cognia/agent-omp`; no app factory, preset, dependency or runtime entry.                       | Keep as candidate, explicitly not product-ready. Package declares native `omp-rpc`; later upstream also advertises ACP. Host preparation/guard and registration remain required.                                                                  |
| 16  | Hermes Agent                       | Active: [NousResearch repository](https://github.com/NousResearch/hermes-agent), [CLI reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md).                                                              | Not built in.                                                                                                 | Keep as candidate. `hermes`/`hermes chat`, one-shot and stream JSON exist; do not use legacy single-query runner identity as the preferred product.                                                                                               |
| 17  | Devin → Devin CLI                  | Active: [official CLI](https://devin.ai/cli), [vendor launch](https://cognition.com/blog/devin-for-terminal).                                                                                                                                                 | Registered: `devin acp`, with vendor-specific per-session composition.                                        | Keep CLI route; [ACP registry entry](https://zed.dev/acp/agent/devin). Cloud Devin availability is a separate surface.                                                                                                                            |
| 18  | Goose                              | Active: [current aaif-goose/goose repository](https://github.com/aaif-goose/goose), [ACP docs](https://goose-docs.ai/docs/gdk/acp/).                                                                                                                          | Registered: `goose acp --with-builtin developer`, approval mode.                                              | Keep; follow repository move from `block/goose`. Catalog certification remains narrower than current upstream releases.                                                                                                                           |
| 19  | Auggie                             | Active: [Augment CLI reference](https://docs.augmentcode.com/cli/reference).                                                                                                                                                                                  | Not built in.                                                                                                 | Keep; native [`auggie --acp`](https://docs.augmentcode.com/cli/acp/agent) is a candidate for the shared ACP adapter after host integration.                                                                                                       |
| 20  | Autohand Code                      | Active: [official source](https://github.com/autohandai/code-cli).                                                                                                                                                                                            | Not built in.                                                                                                 | Keep; native [`autohand --acp`](https://github.com/autohandai/code-cli/blob/main/docs/guides/ACP.md), npm `autohand-cli`.                                                                                                                         |
| 21  | Charm → Crush by Charm             | Active successor: [charmbracelet/crush](https://github.com/charmbracelet/crush).                                                                                                                                                                              | Not built in.                                                                                                 | Normalize to Crush (Charm). [`crush run`](https://github.com/charmbracelet/crush/blob/main/internal/cmd/run.go) exists; native ACP not established. Exclude archived Go OpenCode predecessor.                                                     |
| 22  | Cline                              | Active: [official repository](https://github.com/cline/cline), [ACP source docs](https://github.com/cline/cline/blob/main/docs/usage/acp.mdx).                                                                                                                | Registered: `cline --acp --auto-approve false`.                                                               | Keep actual CLI runtime. Current preset explicitly records version-specific image/MCP limitations and pending authenticated acceptance.                                                                                                           |
| 23  | CodeBuddy                          | Active: [Tencent CLI docs](https://www.codebuddy.ai/docs/cli/README).                                                                                                                                                                                         | Not built in.                                                                                                 | Keep; current npm `@tencent-ai/codebuddy-code`, `codebuddy --acp` per [official command docs](https://www.codebuddy.ai/docs/cli/slash-commands).                                                                                                  |
| 24  | Codebuff                           | Active distribution: [official quickstart](https://www.codebuff.com/docs/help/quick-start), [npm metadata](https://registry.npmjs.org/codebuff).                                                                                                              | Not built in.                                                                                                 | Keep; [`@codebuff/sdk`](https://www.codebuff.com/docs/advanced/sdk) is documented. Repository redirect to Freebuff is not a retirement notice.                                                                                                    |
| 25  | Freebuff                           | Active: [official CLI page](https://freebuff.com/cli), [current repository](https://github.com/CodebuffAI/freebuff), [npm metadata](https://registry.npmjs.org/freebuff).                                                                                     | Not built in.                                                                                                 | Keep terminal candidate. Latest-release headless/ACP contract not established; older official articles describe interactive-only use.                                                                                                             |
| 26  | Command Code → CommandCode.ai      | Active: [official docs](https://commandcode.ai/docs), [npm metadata](https://registry.npmjs.org/command-code).                                                                                                                                                | Not built in.                                                                                                 | Keep; native [`cmd acp`](https://commandcode.ai/docs/acp), npm `command-code`.                                                                                                                                                                    |
| 27  | Continue → Continue CLI            | Active: [official repository](https://github.com/continuedev/continue), [CLI docs](https://docs.continue.dev/cli/quickstart).                                                                                                                                 | Not built in.                                                                                                 | Keep; `cn -p ... --format json`/`cn serve` are documented, native ACP not established. IDE integration does not substitute for a CLI adapter.                                                                                                     |
| 28  | Droid → Factory Droid              | Active: [Factory integration docs](https://docs.factory.com/ide-integrations), [official ACP Registry manifest](https://github.com/agentclientprotocol/registry/blob/main/factory-droid/agent.json).                                                          | Registered: `droid exec --output-format acp-daemon`.                                                          | Keep. Current Registry uses exactly this command; manual `--output-format acp` is a separate documented surface, not evidence Cognia's command is broken.                                                                                         |
| 29  | Kilocode → Kilo Code / Kilo CLI    | Active: [current Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode), [CLI docs](https://kilo.ai/docs/code-with-ai/platforms/cli).                                                                                                                       | Not built in.                                                                                                 | Keep; `@kilocode/cli`, `kilo acp`. Legacy `Kilo-Org/kilo` was moved/archived.                                                                                                                                                                     |
| 30  | Kimi → current Kimi Code           | Active successor: [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code).                                                                                                                                                                            | Registered: current npm `@moonshot-ai/kimi-code`, `kimi acp`.                                                 | Keep current route. Exclude old archived Python `kimi-cli` and its PyPI aliases. Current preset reviews 2.2.0; latest npm observed 2.3.3 is not newly certified here.                                                                             |
| 31  | Kiro → Kiro CLI                    | Active, V3 transition: [official rollout](https://kiro.dev/blog/cli-3/), [ACP migration guide](https://kiro.dev/docs/cli/v3/acp-migration/).                                                                                                                  | Registered: `kiro-cli acp` (documented V2 route).                                                             | Keep. V3 explicitly uses `--agent-engine=v3`; evaluate separately. Existing ACP client already prefers model config options, but this is not complete V3 acceptance. No V2 shutdown date established.                                             |
| 32  | Mistral Vibe                       | Active: [Mistral repository](https://github.com/mistralai/mistral-vibe), [official installer docs](https://docs.mistral.ai/getting-started/quickstarts/vibe-code/install-cli).                                                                                | Not built in.                                                                                                 | Keep; native executable [`vibe-acp`](https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md), distinct from `vibe`.                                                                                                                |
| 33  | Qwen Code                          | Active: [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code).                                                                                                                                                                                              | Registered: `qwen --acp`.                                                                                     | Keep. [Official architecture](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/) describes native ACP; model-only provider support is separate.                                                                                 |
| 34  | Rovo Dev                           | Available during transition: [Atlassian command reference](https://support.atlassian.com/rovo/docs/rovo-dev-cli-commands/), [official staff transition announcement](https://community.atlassian.com/forums/discussion/3315222/introducing-rovo-cli-beta/p1). | Not built in.                                                                                                 | Keep transitional product candidate. Existing `acli rovodev run`/`serve`; successor `rovo` has different command/config identity. No current shutdown established.                                                                                |

### Lifecycle filtering: what to exclude

- **Old Python Kimi CLI:** [authoritative archive/migration notice](https://github.com/MoonshotAI/kimi-cli)
  explicitly says maintenance, fixes and security updates ended and existing
  installations will stop working. Keep the new npm Kimi Code product; Cognia
  already targets it. PyPI `kimi-code` is an old alias, not the replacement npm
  package `@moonshot-ai/kimi-code`.
- **Old Go OpenCode:** [opencode-ai/opencode](https://github.com/opencode-ai/opencode)
  explicitly says development moved to Crush. Exclude that implementation from
  new integration work. Keep modern `anomalyco/opencode` and Crush separately.
- **Moved Kilo repository:** [Kilo-Org/kilo](https://github.com/Kilo-Org/kilo)
  is archived and points to `Kilo-Org/kilocode`. Follow the current repository;
  do not delete Kilo Code as a product.
- **Repository moves alone are not death:** Goose moved to `aaif-goose/goose`;
  Codebuff's repository redirects to Freebuff while Codebuff's CLI/SDK
  distribution and official docs remain present. Rovo Dev explicitly remains
  available during its transition.

### “+ any CLI agent” needs a narrower promise

The supported general statement is: **an installed CLI agent can be used
manually in an available Cognia terminal; structured agent integration depends
on its protocol and host integration.** Browser-only environments need an
available terminal/process host. No arbitrary-agent terminal acceptance was
performed by this audit.

Structured execution currently has concrete factories for ACP, Codex
app-server, OpenCode V1/V2, Pi RPC, DSH SDK, Aider CLI and A2A. Legacy generic
`custom`/`http`/`websocket` protocol values are not universal adapters.
An ACP agent without a built-in preset may be technically configurable, but
its executable, provider environment, state roots and sandbox still need
appropriate host policy. Rust supports explicit operator command additions;
the audited CLI validator has a separate default allowlist. Neither is an
unconditional promise that every CLI agent can run through the structured API.

ACP Registry discovery is implemented but deliberately dormant: it does not
make every registry agent visible, installable, or certified in the application.
The Oh My Pi package is similarly an implementation artifact rather than a
runtime a user can currently select.

### Apparent compatibility differences checked before classification

- Cursor's [official changelog](https://cursor.com/changelog/cli-jan-08-2026)
  explicitly retains `cursor-agent`, and its [current installer](https://cursor.com/install)
  still creates both names. The installer was read as text, not executed.
  Cognia's command is not broken merely because new docs prefer `agent`.
- Factory's public manual uses `--output-format acp`, but the
  [official Registry manifest](https://github.com/agentclientprotocol/registry/blob/main/factory-droid/agent.json)
  uses `acp-daemon`, retained in the
  [2026-10-24 update](https://github.com/agentclientprotocol/registry/commit/4bb90a94464c6f2b33376d9b7f7b3da26f5c710a).
  Cognia matches that manifest; no launch defect is established by the naming difference.
- DeepSeek now publishes [`@deepseek-ai/dsh`](https://registry.npmjs.org/@deepseek-ai%2fdsh/latest),
  observed version `0.2.1-rc.2` with `bin: {"dsh":"lib/bin.js"}`.
  The unqualified “ships no binary of its own” comment in the CLI process
  validator is stale. The backend command's narrower statement about the
  transports Cognia drives is a different claim: npm distribution existence
  does not establish SDK/ACP compatibility or replace the pinned managed home.
- Kiro's [migration guide](https://kiro.dev/docs/cli/v3/acp-migration/)
  distinguishes `kiro-cli acp` from explicitly selected V3. The existing client
  already prefers `session/set_config_option` for advertised model options;
  complete V3 startup, approval, tool and resume behavior still needs acceptance.

## Current implementation evidence

- [Preset definitions](../../lib/ai/agent/external/config/presets.ts)
  and [ecosystem surfaces](../../lib/ai/agent/external/ecosystem-adapters.ts).
- [Runtime/version/platform catalog](../../protocol/external-agent-runtimes.json)
  and [launch/state policy](../../protocol/external-agent-security-policy.json).
- [Protocol factories](../../lib/ai/agent/external/manager.ts),
  [selectable protocols](../../lib/ai/agent/external/protocol-options.ts), and
  [admission checks](../../lib/ai/agent/external/capability/capability-preflight.ts).
- [Dormant registry discovery](../../lib/ai/agent/external/lifecycle/service.ts)
  and [registry classifier](../../lib/ai/agent/external/lifecycle/registry-discovery.ts).
- [Oh My Pi declarations](../../packages/agent-omp/src/manifest.ts)
  and [explicit package integration boundary](../../packages/agent-omp/README.md).
- [CLI command validator](../../cli/src/runtime/external/node-backend.ts),
  [Rust host policy](../../crates/cognia-external-agent/src/presets.rs), and
  [terminal PTY implementation](../../crates/cognia-terminal/src/session.rs).

### Runtime evidence remains version- and environment-scoped

Existing repository evidence is stronger for some routes, but it is not a new
run by this audit and must not be generalized to all 16:

- [Kimi 2.2.0 report](../reports/kimi-code-2.2.0-2026-10-18.md)
  records authenticated sandboxed ACP, tools, MCP, model selection and resume.
- [Copilot report](./2026-10-23-copilot-cli-support-audit.md)
  records real CLI/loopback checks and a native GitHub provider reply; some
  BYOK and app/device branches remain open.
- [Antigravity evidence](./2026-10-24-gemini-antigravity-cli-support-audit.md)
  records account-free real ACP/sandbox checks; authenticated inference and
  native app acceptance remain separate blocked branches.
- [Goose 1.56 evidence](./2026-10-25-goose-v156-support-audit.md)
  records actual binary and deterministic-provider checks. Runtime catalog
  certification still lists 1.52.0 rather than declaring all newer releases
  certified.
- [Codex 0.163.0 report](../reports/codex-app-server-2026-10-18/README.md)
  records a real CLI against a synthetic local provider, not authenticated
  service acceptance.

## Checks executed in this audit

Environment: macOS/Apple Silicon, Node `v26.12.1`, pnpm `11.18.0`.
Source baseline HEAD was `333a076f4c6ab2c77019a8dc3a4edafc19869954`, with extensive
pre-existing uncommitted changes. The matrix follows the working tree, not
that commit alone.

```sh
rtk proxy pnpm test --runInBand --runTestsByPath \
  lib/ai/agent/external/ecosystem-adapters.test.ts \
  lib/ai/agent/external/config/presets.test.ts \
  lib/ai/agent/external/config/install-catalog.test.ts \
  lib/ai/agent/external/protocol-options.test.ts \
  lib/ai/agent/external/lifecycle/registry-discovery.test.ts \
  packages/agent-acp/src/registry.test.ts
```

Result: **5 suites passed, 1 failed; 179 tests passed, 2 failed**, no coverage.
Both failures are in `protocol-options.test.ts`: tests expect legacy
`opencode` to be unselectable, while the current executable protocol list
includes it and the manager registers its factory. The audit does not decide
whether the intended V1 retirement or the retained compatibility route should
win by merely weakening either assertion.

```sh
rtk proxy pnpm audit:external-agent-runtimes
```

Result: generated JSON freshness passes, normal governance gate exits 1.
The checker reads `ExternalAgentPresetId` from the app preset file, but that
type is now owned by
`packages/plugin-contract/src/lib/ai/agent/external/config/presets.ts`.
Its old-path regex returns no IDs and falsely reports every catalog preset as
unshipped. A read-only diagnostic calling the existing `runChecks` with the
actual owning type source finds **27 preset IDs and zero errors**. This
diagnostic does not turn the normal failing command into a passing gate.

No installation, credential selection, authenticated inference, actual Tauri
UI flow, Windows/Linux runtime acceptance, full build, full lint or typecheck
was performed by this documentation-only audit.

### Reproducibility artifacts

Local task artifacts are under `.cache/agent-support-audit-2026-10-27/`:

- `source-snapshot.json`: all 34 mappings, counts, and hashes of owning sources.
- `upstream-a.md`, `upstream-b.md`: primary-source research and observed upstream
  repository/npm metadata, including exact dates and limitations.
- `catalog-tests.log`, `runtime-gate.log`, `gate-diagnostic.json`: actual checks.

These cache files are local supporting artifacts; primary upstream links and
the complete support matrix are retained in this ledger.

## Baseline audit residual risks

| ID  | Residual                                                                                 | From   | Why still open                                                               | Next action                                                                                       | Status |
| --- | ---------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| X1  | OpenCode V1/V2 picker behavior disagrees with two existing tests.                        | V3, R2 | Concurrent source retains V1 while tests express retirement.                 | Decide supported V1 compatibility policy, then align source and behavioral tests.                 | open   |
| X2  | Standard runtime governance command fails after preset-type ownership moved.             | V4, R2 | Checker still parses former source path.                                     | Repair checker to read the actual contract or canonical exported data; add relocation regression. | open   |
| X3  | Upstream existence does not prove paid-service/account or latest-version runtime health. | R3     | No current authenticated per-agent executions were performed.                | Use isolated per-version acceptance for each intended release and supported host.                 | open   |
| X4  | Kiro V3 needs version-specific acceptance; documented V2 remains a valid separate route. | R2     | V3 startup and behavior have not been executed here.                         | Inspect installed generation and test actual native startup and negotiated capabilities.          | open   |
| X5  | Seventeen missing presets and the unregistered Oh My Pi package remain integration work. | R2     | Audit does not implement host preparation, policies, factories or UI wiring. | Prioritize six documented native ACP candidates; review Oh My Pi host/guard boundary separately.  | open   |

## Outcome

These two signals record the initial audit disposition; the follow-up execution
paths and verification record below supersede its implementation counts.

| ID  | Signal                                                                     | How / when measured                                 | Result                                                                                                      | Status |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------ |
| M1  | Every requested product has a lifecycle/source-support disposition.        | 34-row matrix and AST/catalog snapshot, 2026-10-27. | 16 registered, 1 package-only, 17 not built in; all 34 current identities have upstream existence evidence. | met    |
| M2  | Discontinued predecessors are excluded without deleting active successors. | Exact archive/migration notices, 2026-10-27.        | Old Python Kimi and Go OpenCode excluded; current Kimi, Crush, OpenCode and moved Kilo/Goose retained.      | met    |

| M3 | 当前每个可配置产品有运行入口、缺口和证据来源。 | 2026-11-17 目录对照、文末矩阵和复现。 | 38 个产品已逐个核对，发现两个最高优先级的跨协议边界缺口。 | met |
| M4 | 真实工作负载下的可用性。 | 在目标 Host 上按版本运行带账号的回合、取消、恢复和 MCP。 | Qoder 隔离握手和重连已验证，其余见 X15。 | pending |

### Baseline audit review record

The audit changes only this dated ledger. Ledger validation reports zero errors
and zero warnings; Prettier check passes. The final review confirms exactly 34
unique, sequential matrix rows, no broken local links and no drift in the 11
hashed owning sources. Results are retained in `final-review.json`.
Product remediation and actual runtime acceptance remain the open residuals
above; this ledger therefore remains in `verifying` status.

## Implementation follow-up — 2026-10-27

The implementation follows ADR-0217: protocol packages own wire formats and
lifecycle, application factories inject existing host ports, and native-only
entry points remain outside browser bundles. New packages are necessary for
OpenClaude bidirectional stream-json, Crush private HTTP, Continue final JSON,
Rovo Dev owned authenticated HTTP, and Codebuff SDK; these contracts cannot be
truthfully represented as ACP or generic terminal output.

### Resulting execution paths

| Products                                                                           | Application integration                                                                                                     | Limits enforced                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auggie, Autohand Code, CodeBuddy, Command Code, Kilo Code, MiMo Code, Mistral Vibe | Existing ACP package with explicit vendor profiles and native argv.                                                         | Negotiate optional features; reject unsupported permission ceilings and mandatory approval policies before session RPC; no invented native mode flags. Command Code uses `commandcode`, avoiding Windows `cmd`.                                                                    |
| Muse, Amp, ZCode                                                                   | Source-inspected ACP bridges and registered application profiles.                                                           | Muse requires its native login and session-MCP permission. Amp requires explicit unrestricted permission mode and rejects host-enforced mandatory tool approval. ZCode uses its signed-in macOS desktop engine; native terminal route is also available.                           |
| Oh My Pi                                                                           | `omp acp` profile registered in the application, using guarded host file/terminal ports.                                    | Refuses hosts without required guarded ports; actual 18.13.1 account-free native lifecycle checked below.                                                                                                                                                                          |
| OpenClaude                                                                         | New `agent-openclaude` package, registered `openclaude-cli` factory, native stream-json with mandatory permission hook.     | Independent `.openclaude` state; exact native resume, permission/questions, streaming steps, cancellation and cleanup. Native file-shaped `.openclaude.json` remains a file.                                                                                                       |
| Crush (Charm)                                                                      | New `agent-crush` package and `crush-http` factory; verified Node helper owns private Unix socket and actual `crush` child. | No unauthenticated TCP fallback or arbitrary executable injection; fixed native command; owner-only short socket path; native state and private host temp grants.                                                                                                                  |
| Continue                                                                           | New `agent-continue` package and `continue-cli` factory; actual `cn -p ... --format json`.                                  | Final-result semantics and host history replay; no fabricated streaming tool events or native resume ID. Read-only Plan / explicit unrestricted modes only.                                                                                                                        |
| Rovo Dev                                                                           | New `agent-rovo` package and `rovo-http` factory; host-owned `acli rovodev serve`.                                          | Random per-lease bearer challenge rejects token-ignoring listeners; fixed process launch; no caller-selected service endpoint.                                                                                                                                                     |
| Codebuff                                                                           | New `agent-codebuff` package and `codebuff-sdk` factory; SDK 0.10.7 in verified separate Node closure.                      | Mandatory OS network-off, intercepted first-party fetch with PII gate, confined filesystem and brokered native tools. No SDK dependency in renderer. Exact completed SDK resume state. Unsupported native MCP/OAuth and mandatory policy combinations fail closed.                 |
| Freebuff and generic installed CLI                                                 | Existing PTY host/dock plus managed terminal profile/session UI, mounted in settings and chat manager.                      | Explicit cwd, launch deduplication, real status/interaction/reopen, failed-stop retry, stop and cleanup; terminal capability limits shown. No claim of structured tool/permission parity.                                                                                          |
| Hermes Agent                                                                       | Registered ACP profile, controlled foreground gateway/viewer, strict verified helpers.                                      | **User deferred Hermes testing.** Native Python/dependency closure and short IPC grants remain unresolved. Unwired grant experiments were removed from source and archived; no broad read/tmp grants or unmanaged daemon fallback was enabled. Do not classify Hermes as accepted. |

The original 17 missing products plus Oh My Pi now have reachable application
routes: 17 structured configurations (including deferred Hermes) and Freebuff
managed terminal. ZCode also has a native terminal alternative. A current
upstream product was not removed merely because a predecessor was archived.
The original matrix above remains the pre-change inventory.

### Runtime and safety repairs

- OpenCode V1 auto-spawn and V2 remain executable compatibility routes. Tests
  now assert both are selectable; only the documented remote V1 preset stays
  disabled. The runtime gate reads the actual closed exported preset union via
  TypeScript AST and rejects missing, malformed, empty or open declarations.
- Desktop/settings/mobile configuration preserves native local-service process,
  cwd and env; fixed bridge commands/arguments cannot become a generic Node
  script launcher. Quick-add persists supported isolated/shared state explicitly,
  instead of inheriting an incompatible isolation default.
- Four fixed verified Node resources have embedded build pins, complete SDK
  asset/dependency inventory and revalidation at spawn. Generic Node/shell
  execution is not allowlisted. CLI pkg/Bun layouts carry the closure and use
  an actual verified plain Node interpreter, rather than the Cognia executable.
- macOS 26 strict sandbox initially killed even `/bin/echo` and Node in dyld.
  The minimal fix allows data access to the literal root directory for loader
  enumeration, without recursive host reads. A real sandbox regression also
  proves an ungranted private file remains unreadable.
- Codebuff Git inspection disables repository-controlled external diff,
  textconv and signatures; hostile-repository reproduction now passes. Tests
  exercise the real Node entry over JSONL, filesystem escape and symlink races,
  policy approval, subprocess refusal, cancel/EOF and cleanup. PII tests now
  reach the allowed first-party sink and include an allowed positive control.
- Native vendor CLIs retain their own provider behavior. Cognia-origin prompt,
  history, file and tool-response boundaries use existing outbound gates; this
  does not claim every native vendor network request has SDK-style interception.
- Ordinary native staging now verifies the complete existing closure and avoids
  rewriting unchanged watched files; extra/tampered output is still replaced.
  This addresses repeated Turbopack filesystem settling during acceptance.

### Verification record

All local artifacts below are under `.cache/agent-support-audit-2026-10-27/`.
No coverage run, commit, push or modification of unrelated changes was made.

| Check                                              | Actual result                                                                                                                                                     | Evidence / scope                                                                                                                                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined affected Jest                             | 71 suites, 1,688 tests, 1 snapshot passed; runner exited normally 0.                                                                                              | `final-affected-jest.log`, `final-test-paths.json`. Includes five native packages, factories, forms, catalog, settings, terminal management, host verifier and sandbox launcher.                                                               |
| ACP / OpenClaude focused integration               | 30 suites / 626 tests passed.                                                                                                                                     | `owned-a-tests.log`; includes source-derived wire fixtures and real local child/socket fixtures, not authenticated upstream inference.                                                                                                         |
| Five package builds and isolated tarball consumers | Passed ESM/CJS/declarations and consumer checks.                                                                                                                  | `pack-openclaude.log`, `pack-crush.log`, `pack-continue.log`, `pack-rovo.log`, `pack-codebuff.log`.                                                                                                                                            |
| Runtime/capability/staging/release Node gates      | 87 tests passed including the staging no-churn/tamper regression.                                                                                                 | `final-node-gates.log`, `stage-watch-red.log`, `stage-watch-green.log`.                                                                                                                                                                        |
| Runtime and capability governance                  | Passed: 41 runtimes, 44 presets, zero unpinned launches waived.                                                                                                   | `deterministic-final.json`; both generated catalogs fresh.                                                                                                                                                                                     |
| Static export / companion API / i18n build check   | Passed.                                                                                                                                                           | `deterministic-final.json`; 962 remote commands /119 classified routes, no Node-only browser import, both ICU catalogs valid.                                                                                                                  |
| Full lint                                          | Passed.                                                                                                                                                           | `lint-final.log`; scoped final Prettier check also passed.                                                                                                                                                                                     |
| Full root typecheck                                | **Failed: 11 diagnostics outside task-owned paths.**                                                                                                              | `typecheck-final.log`: missing ContextPanelDefinition.activity in context-workbench tests; mock tuple/unknown types in use-claude-chat tests; Discord avatar BigInt literals under current TS target. No complete root typecheck pass claimed. |
| Sidecar typecheck                                  | Passed independently after root check short-circuited.                                                                                                            | `sidecar-typecheck.log`; all configured sidecar checks completed.                                                                                                                                                                              |
| Rust execution sandbox                             | 224 tests passed, including actual macOS restricted execution and denied private-file read.                                                                       | `final-exec-sandbox.log`.                                                                                                                                                                                                                      |
| Tauri compile check                                | `cargo check -p cognia-next --features agent-debug` passed.                                                                                                       | `tauri-check.log`; build-generated permission includes new command. Actual isolated native IPC passed; full shell boot remained blocked in local account registry.                                                                             |
| Codebuff actual isolated SDK startup               | Passed SDK 0.10.7 ready, zero host network requests, EOF exit0, mandatory network-off OS sandbox.                                                                 | `codebuff-os-smoke.log`; genuine staged SDK/assets outside repo, synthetic noncredential key, no model request.                                                                                                                                |
| Oh My Pi actual native lifecycle                   | Passed official18.13.1 initialize, session/new, config, idle cancel, close, EOF exit0 and child cleanup.                                                          | `native-omp/acceptance.json`, `native-omp/cleanup.json`, `native-omp/README.md`; private HOME/workspace, current native launcher, networkoff, zero prompts/credentials/provider requests. Inference-time cancellation not certified.           |
| CLI compiled Bun and release layout                | Passed real Bun1.4 to verified Node26.12.1, adjacent closure, rejected self-alias/preload, sticky interpreter identity; 74 focused Jest and12 build tests passed. | `cli-bun-resolver-smoke.log`, `cli-bun-node-stage-smoke.log`, `cli-release-build-green.log`. No cross-platform release artifact claimed.                                                                                                       |
| Browser / native UI / production static build      | Pending current isolated acceptance.                                                                                                                              | Dedicated3103 frontend; original3000 frontend and another native process belong to concurrent work and remain untouched. Native audit uses a private application identifier and data directory.                                                |
| Hermes                                             | Skipped by explicit user request.                                                                                                                                 | `check-repair/deferred-hermes-runtime/README.md`; failed grant fixtures are recorded, not counted as accepted.                                                                                                                                 |

### Independent review synthesis

PII, static-export, wiring, i18n, Tauri/Rust and co-located-test auditors reviewed
the scoped change. Findings led to concrete fixes for CLI release closure,
Codebuff Node IPC coverage and Git execution, native permission ceilings,
Crush host grants/command identity, quick-add isolation and OpenClaude file
roots. Matching English/Chinese keys exist; generated sources were built.
Hermes grant findings remain deferred under the user instruction rather than
being hidden by fixture-only results.

### Final local verification corrections

The broad test run exposed two further stale picker tests (legacy OpenCode
wrongly disabled; fixed keyboard order after catalog expansion). Both were
corrected without weakening selectable/disabled behavior. Real Node-entry
fixtures now stop their esbuild services. Inspector evidence traced the final
remaining timer to an existing Pi registration test that created the real
manager without disposing it; test-only finally cleanup fixed that leak.
The final71-suite run exited normally0 with1,688 tests passed.

Rust external-agent final run:353 passed, 0 failed, 1 Hermes-named test filtered
under the user deferral (`final-external-agent-rust.log`). No coverage collected.

Native audit process group92437/app93795/monitor95904 all stopped. The original
native PID82991 and port3000 frontend were preserved. IPC returned typed pinned
bridge launch objects and rejected unknown identities. Full UI stayed in account
registry unlock, screenshot timed out, and no adjacent heavy native page was
accepted. `native-tauri/README.md` and `cleanup.json` record the limitation and
cleanup; do not turn that partial seam result into a full smoke pass.

Browser acceptance completed on Chromium and Pixel7 viewport:2 tests each,
0 failures/retries. All16 non-Hermes structured presets were enabled; actual
OMP/Crush/Rovo/Codebuff form contracts and OMP/Codebuff persisted configs survived
reload. Freebuff/ZCode unavailable-host limits were verified. A browser without
a terminal Host cannot prove actual PTY launch/interaction/stop/cleanup. Screenshots
and exact scope are retained in `e2e/RESULTS.md`. Owned3103 server and its4.8GiB
cache were removed after acceptance; original3000 service remained untouched.

All five protocol package ESM/CJS/DTS builds passed again after final sources.
Crush and Codebuff final isolated tarball consumer checks passed again after
native/security changes (`pack-crush-final.log`, `pack-codebuff-final.log`). The
final pinned SDK actual OS smoke passed again (`codebuff-os-smoke-final.log`).

## Residual risks

| ID  | Residual                                           | From   | Why still open                                                                                                                                               | Next action                                                                                            | Status   |
| --- | -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------- |
| X6  | Hermes native acceptance and exact runtime grants. | R2, R3 | User explicitly requested skipping Hermes tests; strict installation closure/socket grants unfinished. Accepted deferral does not mean runtime acceptance.   | Resume as a separate acceptance/fix pass when Hermes is available; preserve fail-closed behavior.      | accepted |
| X7  | Authenticated provider turns for new products.     | R3     | No accounts/credentials supplied; source and protocol fixtures do not establish provider availability.                                                       | Isolated per-product authenticated tool/approval/cancel/resume checks with intended accounts/versions. | open     |
| X8  | Root typecheck red outside scoped paths.           | R3     | Eleven diagnostics in concurrent context-workbench/chat/Discord work.                                                                                        | Owning changes correct listed diagnostics, then rerun official typecheck.                              | open     |
| X9  | Full native/PTY/production build acceptance.       | R3     | Browser checks passed; native account bootstrap and real terminal Host flow remain blocked, and production build is running in a verified APFS source clone. | Record actual results below, preserving concurrent services.                                           | open     |
| X10 | Foreign-platform packaging/runtime.                | R3     | Workstation is macOS ARM; no Windows/Linux device acceptance.                                                                                                | Run relevant device/release workflows before platform-wide certification.                              | open     |
| X11 | Initial OpenCode V1/V2 picker test disagreement.   | V3, R2 | Follow-up repaired stale retirement assertions, preserved executable V1/V2 and documented-only remote route; affected assertions now pass.                   | Keep compatibility regression tests.                                                                   | closed   |
| X12 | Initial runtime parser ownership failure.          | V4, R2 | Follow-up uses the actual owning closed union and rejects missing/malformed/open declarations; official gate now passes.                                     | Keep parser relocation and malformed-input regressions.                                                | closed   |

| X13 | 本轮权限、凭证和运行时故障仍开放。 | V7 | 本轮交付审计，实际行为见 F1–F10。 | 先验证权限、凭证边界的修复，再做各适配器的故障与恢复回归。 | open |
| X14 | 本轮验证入口及断言差异仍开放。 | V8 | 常规 pnpm 的 Sidecar postinstall 阻断，直接 Jest 仍有 13 个失败。 | 修复包导出，确认配置行为的最新契约，逐条回归。 | open |
| X15 | 本轮真实供应商和平台验收待做。 | V9, M4 | 本机进程证据只有隔离 Codex 握手和 Qoder CLI Host 握手/重连；未覆盖登录与发布制品。 | 用目标版本分别验收供应商回合、审批、恢复、PTY、Windows/Linux 和配对宿主。 | open |

## 2026-11-17 外部 Agent 支持复核

> 检查一下现在对外部agent的支持情况。逐个检查现在支持的各个agent，看看目前存在的缺口

本轮使用 evidence-driven-dev Standard。核对的是本机工作树（基于 `f020e386afe8`，包含在途改动）的预设、适配器、宿主能力和用户入口。成功标准是每个预设都能落到对应产品和真实调用链，高风险缺口有可反驳的证据，真实服务验证标明版本和范围。

[预设表](../../lib/ai/agent/external/config/presets.ts#L192)、
[运行时目录](../../protocol/external-agent-runtimes.json)、
[适配器注册](../../lib/ai/agent/external/integrations/register.ts#L29)、
[PTY 目录](../../lib/agent-ecosystem/terminal-agents.ts#L2)。

- **37 个产品有结构化预设**，共 41 条运行时记录、44 个预设 ID，其中 43 个标为可执行。Codex 的 ACP 和 app-server、OpenCode 的四条路、DeepSeek Harness 的三种配置合并按产品计数。OpenCode V1 remote 是第 44 个 ID，仅有说明。自定义 ACP、A2A、插件协议和 SIWC 配置另计。
- **2 个精选 PTY 条目**，即 Freebuff 和 ZCode。ZCode 已计入结构化产品，Freebuff 只走 PTY。因此两个目录合计 **38 个不同产品**。
- 41 条记录中 38 条依赖系统命令、2 条为服务端点、1 条为 Cognia 管理的 DeepSeek Harness。29 条 ACP 系统记录均无管理分发包。系统目录有 10 条声明版本范围，只有 Aider、Goose、Codex app-server 在目录填写了非空 `certifiedVersions`。DSH 有单独的精确渠道策略，Pi RPC 有适配器自己的版本判定。
- 目录声明 macOS 41 条、Linux 40 条、Windows 9 条（含两个网络端点，V1 remote 只有说明）。Windows 行即 Codex app-server、Codex ACP、Claude Code ACP、Gemini、Copilot、Qwen、OpenCode V1 remote、OpenCode V2、OpenClaude。浏览器和手机上的本机进程型 Agent 走配对 Host，要求相应能力和权限。文末有仅本机运行的例外。 [Host 进程能力](../../lib/ai/agent/external/capability/process-plane.ts#L160) [ACP 客户端能力](../../lib/ai/agent/external/agent-transport.ts#L158)

### 逐个核对

下表的支持指 Cognia 当前调用链；关于版本、授权和平台的缺口以本次证据为准。ACP 的具体交互能力取决于宿主和 Agent 协商。未安装的系统 CLI 以源码和协议测试取证。

| Agent | Cognia 的入口 | 缺口或边界 |
| --- | --- | --- |
| Codex | `codex-app-server`，`codex` / `codex-acp`；另有 SIWC 协议 | app-server 支持范围从 0.149.0 起，目录只列 0.150.1 为认证版本。本机 0.166.0 用空 `CODEX_HOME` 启动，`initialize`、`thread/list` 通过。0.166.0 schema 有 `outputSchema`，Cognia `turn/start` 尚未接入。动态 MCP、原生子 Agent 管理和会话附加目录有能力缺口。ACP 需要另装桥，未探测到。 [Manifest](../../packages/agent-codex/src/manifest.ts#L39) [turn/start](../../packages/agent-codex/src/app-server-client.ts#L2050) |
| Claude Code | 外部 `claude-agent-acp`；内置 Claude Agent SDK 属独立执行路径 | PATH 上的 `claude` 2.1.326 只能确认 CLI 存在，未探测到外部桥。ACP 行无认证版本，内置 SDK 运行的验收不可移用于 ACP。 [生态配置](../../lib/ai/agent/external/ecosystem-adapters.ts#L755) [SDK](../../sidecar/src/runtimes/claude-agent-sdk/index.ts#L19) |
| Pi | `pi --mode rpc` 的原生 RPC，支持会话恢复和 fork | F6，版本探针能够把非零退出判为已认证，超时可留下子进程。适配器认证 1.0.2，指南仍写 0.84.1。未探测到实际 Pi。 [RPC](../../packages/agent-pi/src/rpc-client.ts#L109) [指南](../content/docs/en/chat/external-agents/pi-adapter.mdx#L73) |
| Oh My Pi | `omp acp`，有受控文件和终端端口 | 缺端口会拒绝连接，现有模型的强制逐工具审批组合也会拒绝。仓内独立 `omp-rpc` 包没有应用注册，旧 RPC 功能矩阵不能用于 ACP。 [ACP 配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L219) [OMP RPC manifest](../../packages/agent-omp/src/manifest.ts#L9) |
| OpenCode | V2 HTTP/SSE、ACP、V1 本机自动启动，V1 remote 仅说明 | F7，V1 无管理器持久订阅的直接调用有重复提交路径。V2 可执行，但中英文指南仍有旧 beta／仅说明表述。ACP 文案要求 2.0.0+，运行时目录允许 1.18.14+。本机未探测到 OpenCode。 [预设与版本说明](../../lib/ai/agent/external/config/presets.ts#L49) [V2 discovery](../../packages/agent-opencode/src/discovery.ts#L23) [上游 ACP](https://opencode.ai/docs/cli/acp/) |
| DeepSeek Harness | SDK 只读、SDK 工作区写、ACP interactive，由 Cognia 管理 | 当前策略仍固定 0.2.1-rc.2；系统上的 dsh 0.2.0-rc.2 属另一安装。两种 SDK 通道无原生恢复/逐次审批/turn 级取消；ACP 有审批、取消和恢复，缺 SDK 的 usage 与子 Agent 归属事件。上游后续版本已修过 ACP stdout 诊断串线。已存在的 macOS Bash `!` 复现针对同 pin，原隔离附件已清理，本轮未复跑。 [渠道矩阵](../../protocol/deepseek-harness-channel-certification.json#L5) [Bash 证据](2026-11-01-deepseek-harness-support-audit.md#L721) [上游发布](https://github.com/deepseek-ai/deepseek-harness/releases) |
| OpenClaude | 原生 stream-json、交互工具审批、按原生 ID 恢复 | F5，进程退出后同实例恢复会得到旧错误会话。目录支持 0.33.x，原生 fork 和跨重启历史发现未接入。 [适配器](../../packages/agent-openclaude/src/client.ts#L174) [Manifest](../../packages/agent-openclaude/src/manifest.ts#L14) |
| Antigravity | 独立 `agy_acp_server.par` 和登录 helper | 无 Plan、独立凭证克隆、Gateway 模式或历史导入，本机未探测到 ACP server。 [生态配置](../../lib/ai/agent/external/ecosystem-adapters.ts#L357) |
| Grok Build | `grok agent --no-leader stdio` | Agent 工具问题和 usage 有厂商映射。F10，运行预设可达，统一产品目录缺 Grok 键，生态关联查找返回空。此前只有指定版本的无账号验证记录。 [预设](../../lib/ai/agent/external/ecosystem-adapters.ts#L387) [目录断言](../../lib/agent-ecosystem/conformance.test.ts#L40) |
| MiniMax Code | `mcode acp`，按会话建进程 | 支持 Default、Plan、Bypass，明确拒绝强制逐工具审批规则。 [适配器](../../packages/agent-acp/src/minimax-adapter.ts#L39) |
| Kimi Code | `kimi acp`，含 Kimi 专用管理和 Gateway 模式 | fork 保留同 cwd 并重绑 MCP；`/compact` 缺可确认的完成事件，不能假定已完成；当前账号回合待复验。 [厂商配置](../../packages/agent-acp/src/vendors/kimi.ts#L75) |
| Cline | `cline --acp --auto-approve false` | Cognia 的 ACP 路径限制图片和会话级 MCP。CLI 自己的 MCP 配置仍属独立入口。 [厂商配置](../../packages/agent-acp/src/vendors/cline.ts#L45) |
| Qoder | `qoder --acp`，默认严格 MCP | 本轮实际 1.1.65 沙箱握手、登录方法、自定义状态目录及重连通过，`session/new` 明确要求认证。Plan 取决于会话声明。旧指南有带账号证据，当前目录认证字段未跟进。 [厂商配置](../../packages/agent-acp/src/vendors/qoder.ts#L33) [指南](../content/docs/en/chat/external-agents/ecosystem-presets.mdx#L166) |
| Goose | `goose acp`，含 Gateway 模式和子会话控制 | 子会话控制需协议报告至少 1.56.0；目录认证字段仍只列 1.52.0。真实供应商回合待复验。 [客户端](../../packages/agent-acp/src/client.ts#L3148) [运行时条目](../../protocol/external-agent-runtimes.json#L195) |
| Devin | ACP，每会话隔离；原生配置文件桥接 MCP | 依赖厂商认证和隔离配置，未探测到真实进程；能力不等同于共享 ACP 进程。 [厂商配置](../../packages/agent-acp/src/vendors/devin.ts#L34) [工厂](../../packages/agent-acp/src/factory.ts#L43) |
| Gemini CLI | `gemini --acp` | 上游已停个人 Google Free/Pro/Ultra 账号通路；API Key 或企业资格是单独入口，本轮无带账号验证。 [运行时条目](../../protocol/external-agent-runtimes.json#L321) [上游公告](https://github.com/google-gemini/gemini-cli/discussions/28017) |
| GitHub Copilot CLI | `copilot --acp`，含 Gateway 模式 | 会话 MCP 支持 HTTP/SSE，缺 stdio；`allow_all` 有专门的审批状态管理。真实账号回合待测。 [厂商配置](../../packages/agent-acp/src/vendors/copilot.ts#L41) |
| Kiro | `kiro-cli acp` | 预设仍用无参数的 ACP 兼容入口，缺 V3 显式选型和验证；上游现有客户端可留在 V2。 [预设](../../lib/ai/agent/external/ecosystem-adapters.ts#L848) [上游迁移说明](https://kiro.dev/docs/cli/v3/acp-migration/) |
| Qwen Code | `qwen --acp`，含 Gateway 模型配置 | 通用 ACP 能力由握手决定，登录、模型策略和真实工具流需验证。 [运行时条目](../../protocol/external-agent-runtimes.json#L396) [Gateway 配方](../../packages/agent-acp/src/vendors/qwen-gateway.ts) |
| Factory Droid | `droid exec --output-format acp-daemon` | 通用 ACP 加版本同意，需 Factory API Key 或原生登录；当前文档还写旧参数 `acp`。 [预设](../../lib/ai/agent/external/ecosystem-adapters.ts#L944) [指南](../content/docs/en/chat/external-agents/ecosystem-presets.mdx#L78) |
| Cursor CLI | `cursor-agent acp` | Cursor MCP 配置和 Background Agent 是说明入口；真实 ACP 版本和账号未验。 [生态配置](../../lib/ai/agent/external/ecosystem-adapters.ts#L975) |
| Auggie | 厂商 ACP 配置 | 通常只有 Default/Bypass；强制逐工具审批规则拒绝。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L46) |
| Autohand Code | 厂商 ACP，单独 setup 终端 | 强制逐工具审批拒绝；登录依赖 setup，Plan 未接入。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L62) |
| CodeBuddy | 厂商 ACP | 强制逐工具审批拒绝、通用模式受限，真实账号能力待验。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L79) |
| Command Code | `commandcode` 的 ACP | 拒绝 SSE MCP 和强制逐工具审批。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L99) |
| Kilo Code | 厂商 ACP | 强制逐工具审批拒绝、通用模式受限。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L114) |
| Mistral Vibe | 厂商 ACP | Plan 和强制逐工具审批未接入。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L130) |
| MiMo Code | 厂商 ACP | 依赖自己的原生登录，问题工具禁用，强制逐工具审批拒绝。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L152) |
| Hermes Agent | ACP 驱动受控的本机 gateway/viewer | 需要主机本地、绝对工作区及隔离状态目录；设置指南指向默认 `~/.hermes`，共享状态会被启动条件拒绝。原生 gateway 及 IPC 授权的验收仍见 X6。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L185) [Host](../../lib/ai/agent/external/integrations/hermes-daemon.ts) |
| Muse | 社区 ACP 桥 | 依赖原生登录和 session MCP 授权，无 SSE MCP，强制逐工具审批拒绝。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L235) |
| Amp | 本机 ACP 桥 | 必须显式启用 Bypass，拒绝强制审批，缺 fork 和 Orb/远端运行。 [配置](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L258) |
| ZCode | macOS 登录桌面引擎的 ACP 桥；另有管理 PTY | ACP 需要已登录的桌面引擎且图片未接入，PTY 存在 F8 身份/cwd 不一致。 [ACP](../../packages/agent-acp/src/vendors/catalog-expansion.ts#L303) [PTY](../../lib/agent-ecosystem/terminal-agents.ts#L2) |
| Aider | 本机逐轮 CLI、文本/图片、历史重放 | Plan/自动同意两种路径，缺原生会话恢复/fork、交互审批、会话 MCP、额外目录和 usage；只认证 0.86.2。 [Manifest](../../packages/agent-aider/src/manifest.ts#L14) |
| Continue | `cn -p --format json`，最终结果和历史重放 | F3，整轮输入进 argv；无流式工具过程、原生 resume、逐工具审批、会话 MCP 或额外目录。 [适配器](../../packages/agent-continue/src/client.ts#L174) |
| Crush（Charm） | Host 私有 Unix socket，SSE、原生恢复和厂商触发的审批 | 仅本地 POSIX Host，附加工作区根、会话 MCP、模型切换和交互问题未接入，强制审批规则拒绝。 [适配器](../../packages/agent-crush/src/client.ts#L297) [Host 工厂](../../lib/ai/agent/external/integrations/crush.ts#L15) |
| Rovo Dev | Host 自有 loopback bearer 服务，原生恢复、工具流和审批 | F4，审批失败无重试、取消失败会跳过关服；仅本地 POSIX，尚无模型切换、会话 MCP、额外目录和交互问题。 [适配器](../../packages/agent-rovo/src/client.ts#L142) |
| Codebuff | 固定 Node 桥、SDK 模型、brokered 工具和历史重放 | F5，桥崩溃会留下已连接的旧会话，显式 resume 能重建。仅本地 POSIX，Node 至少 26；无动态模型、会话 MCP、额外目录和规则匹配。版本探测报的是 Node，不能当 Codebuff SDK 已运行。 [适配器](../../packages/agent-codebuff/src/client.ts#L84) [Host 工厂](../../lib/ai/agent/external/integrations/codebuff.ts#L15) |
| Freebuff | 管理 PTY，显式 cwd 及 Host 安装 | 仅终端里的厂商会话，Cognia 没有结构化聊天、原生会话履历和工具审批。启动经过可改写参数的钩子，见 F8。 [PTY](../../lib/agent-ecosystem/terminal-agents.ts#L2) |

自定义集成也可通过新建表单选择 [ACP / A2A / 已注册插件协议](../../lib/ai/agent/external/protocol-options.ts#L79)。ACP Registry 的发现和安装分类存在，当前应用入口未调用 `discoverRegistryRuntimes`。A2A 只选 0.3/1.0 JSON-RPC binding，可由卡声明流式能力；当前实现无本地 workspace 授权、ACP 审批、MCP 挂载或持久恢复。普通自定义 CLI 可使用终端；托管 PTY 的品牌条目只有上述两个。 [ACP Registry 实现](../../packages/agent-acp/src/registry-lifecycle.ts#L11) [ACP Registry 官方文档](https://agentclientprotocol.com/get-started/registry) [A2A manifest](../../packages/agent-a2a/src/manifest.ts#L9)

### 当前缺口与复现

| ID | 优先级 | 行为和影响 | 证据 |
| --- | --- | --- | --- |
| F1 | P1 | **ACP Agent 可改写 Cognia 的审批判定。** Host 以 Plan 创建会话时，同一合成权限请求起初得到 reject，接到 Agent 的 `current_mode_update` 后得到 allow，无人工确认。原生模式状态和 Host 授权共用可变字段；Manager 在送出回合前设置的有效模式没有约束后续通知。检查证明 Host 已返回允许，原生 sandbox 仍是独立边界。 | 本轮真实适配器及 JSON-RPC 夹具，`acp-session-fixture.ts` 输出 `before=reject, after=allow`。 [通知处理](../../packages/agent-acp/src/client.ts#L5450) [审批处理](../../packages/agent-acp/src/client.ts#L4690) [Host 模式](../../lib/ai/agent/external/manager.ts#L4778) |
| F2 | P1 | **A2A Agent Card 能把已配置凭证及任务输入发到另一个 origin。** 配置只给 `configured.example.invalid` 提供 bearer，发现返回另一 HTTPS 域名时，适配器将原 bearer 与 prompt 一起交给该地址。前提是卡片发布者能控制 URL，且调用者未显式固定 `rpcEndpoint`。 | 本轮真实适配器及拦截 fetch，`a2a-origin.ts` 捕获跨域 POST 的合成凭证和合成 prompt。 [URL 选择](../../packages/agent-a2a/src/client.ts#L467) [发送过程](../../packages/agent-a2a/src/client.ts#L785) [Agent Card 规范](https://a2a-protocol.org/latest/specification/#8-agent-discovery-the-agent-card) |
| F3 | P2 | **Continue 长输入触发 OS 参数上限。** Cognia 接受最多 8 MiB 字符的拼接输入，随后把 prompt、历史和文件正文装进一个 argv 参数。本机约 1 MiB 的单个输入已出现 `E2BIG`。同用户进程列表也能看到用于对照的合成 argv。 | 本轮 ContinueAdapter 与本机 subprocess，1,048,593 字节的参数失败。 [参数组装](../../packages/agent-continue/src/client.ts#L201) [原生调用](../../packages/agent-continue/src/client.ts#L280) |
| F4 | P2 | **Rovo Dev 的审批和清理未覆盖短暂服务故障。** 提交审批的 HTTP 503 会清掉 pending，下一次重试收到 `permission request is not pending`。活动会话关闭时 cancel 的 503 导致跳过 service close，适配器中旧会话仍在。 | 本轮真实 adapter 与两个独立 503 夹具，第二次审批请求次数仍为 1，关服次数为 0。 [关停和审批](../../packages/agent-rovo/src/client.ts#L142) |
| F5 | P2 | **OpenClaude / Codebuff 在桥退出后保留失效会话。** OpenClaude 同实例恢复得到旧错误对象且下一轮失败；Codebuff 仍报告 connected 并复用缓存会话，下一轮失败，显式恢复可重启桥。 | 本轮两个真实 adapter 的 exit 夹具，分别在 `native-fault-injection.ts` 和 `terminal-headless-probes.mjs`。 [OpenClaude](../../packages/agent-openclaude/src/client.ts#L174) [Codebuff](../../packages/agent-codebuff/src/client.ts#L599) [会话复用](../../lib/ai/agent/external/manager.ts#L3863) |
| F6 | P2 | **Pi 版本探针可误报认证，并遗漏超时清理。** 打印认证版本后非零退出仍显示 certified/connected；挂住的探针超时后只移除监听，未杀子进程。 | 本轮实际 Pi adapter 和注入进程端口。 [认证读取](../../packages/agent-pi/src/rpc-client.ts#L691) [超时](../../packages/agent-pi/src/rpc-client.ts#L743) |
| F7 | P2 | **OpenCode V1 直连可重复提交。** 在未建立持久订阅的适配器入口，异步接口已接收请求但响应丢失，会回退到同步接口再发一遍。Manager 的持久订阅路径有防重放分支。 | 本轮真实 adapter 与两个 POST 的日志，外部请求由夹具处理。 [V1 回退](../../packages/agent-opencode/src/client.ts#L1124) [持久订阅保护](../../packages/agent-opencode/src/client.ts#L1057) |
| F8 | P2 | **Freebuff / ZCode PTY 报告的身份与 cwd 可以和实际启动不一致。** 合法的终端插件钩子改写 executable、args 和 cwd 后，托管行仍显示原 Agent 已启动及原 cwd。 | 本轮 Tauri 之外的真实 app orchestrator，加可变钩子、合成 PTY。 [身份认定](../../lib/terminal/agent-session.ts#L177) [钩子](../../lib/terminal/spawn-orchestrator.ts#L226) |
| F9 | P2 | **TUI `/backend` 缺 OpenCode V2 与三个 DSH 选项。** 同一工作树的 runnable 设置目录有四项。TUI 要求非空 `process.command`，过滤了 V2 的 HTTP 服务和等待管理器解析命令的 DSH；手输名称也由同一列表拒绝。 | 实际 `backendChoices()` 与 `getRunnablePresets()` 比对，通过非交互参数的路由另走 preset 构造。 [TUI](../../cli/src/tui/commands/backend-command.ts#L63) [非交互启动](../../cli/src/agent/external-agent-session.ts#L809) |
| F10 | P2 | **连接与可执行性呈现有落差。** ACP 只声明 `sessionCapabilities.resume` 时实际 resume RPC 成功，UI 的能力投影却因 `loadSession:false` 显示不支持。ACP 设置按协议列权限模式，部分厂商在连接或会话准备时明确拒绝这些模式或强制审批。Crush、Rovo 和 Codebuff 首轮才启动 service/bridge，Manager 在此前已标记 healthy。Grok 已有预设，统一生态目录未认领其运行时。 | 前半来自实际 ACP fixture，后半来自设置及服务调用链和失败的生态目录一致性测试。 [ACP readiness](../../lib/ai/agent/external/capability/capability-live-facts.ts#L66) [模式表单](../../components/settings/agent/agent-editor-dialog.tsx#L1893) [健康状态](../../lib/ai/agent/external/manager.ts#L3547) [生态一致性](../../lib/agent-ecosystem/conformance.test.ts#L40) |
| F11 | P2 | **常规验证入口在 postinstall 停止。** Sidecar runtime 的两个 `@cognia/agent-config-types` 导入落到 TypeScript 源码，部署所用 Node 导出应指向编译产物。当前阻断 `pnpm test` 与 `pnpm audit:*` 的自动依赖检查。 | 运行命令原始错误 `the bundled sidecar cannot load these`；直接调用相同 Jest 入口和各 gate 验证器可继续。 [Sidecar 导入](../../sidecar/src/runtimes/claude-agent-sdk/options.ts#L17) [包导出](../../packages/agent-config-types/package.json#L9) |

其余跨产品缺口集中在适配器能力向 UI 的投影、平台覆盖和版本验收。几条实际边界：

- Gateway 模型路由只为 10 个家族配置了运行配方，即 Claude Code、Qwen、Kimi、Goose、Copilot、Codex、OpenCode、Pi、DSH、Aider。对已注册 ACP Agent 仍需单独检测 Gateway 支持。 [Gateway 配方注册](../../lib/ai/agent/external/integrations/gateway.ts#L12)
- Crush、Rovo Dev、Codebuff 需要当前本机 Host 以及对应私有服务或桥，配对客户端与选中的外部运行环境会被工厂拒绝；ACP terminal/auth 能力也随实际 Host 变化。 [Crush](../../lib/ai/agent/external/integrations/crush.ts#L15) [Rovo Dev](../../lib/ai/agent/external/integrations/rovo.ts#L14) [Codebuff](../../lib/ai/agent/external/integrations/codebuff.ts#L15) [ACP Host](../../lib/ai/agent/external/agent-transport.ts#L158)
- 54 个核心包及预设套件、39 个 ACP 套件、8 个其他 adapter/终端套件分别通过，合计结果以覆盖范围更大的同一次运行计数。仓库 `smoke:agent` 只给 Kimi、Qoder 附厂商检查，其余 ACP 走通用探测，非 ACP 目录行没有该 runner 的 smoke lane。 [Smoke runner](../../scripts/smoke/agent.ts#L26)

### 本轮执行记录

- **仓库 Jest 入口** `node scripts/test/jest.mjs --silent --runInBand`，选择 agent 外部适配器、生态/运行时目录、配置 UI、CLI 进程和非交互启动路径。337 个套件共 328 通过、9 失败；7,203 个测试通过、13 失败、9 跳过，1 个 snapshot 通过。失败涉及模型子角色规则（5 个）、配置复制状态目录（1 个）、Grok 生态归属（1 个）、协议字面列表（1 个）、权限模式顺序（1 个）、运行时关联（3 个）以及 capability catalog 的 SIWC 提供方覆盖（1 个）。其中 Continue 旧测试仍期待仅历史导入，当前执行入口已存在；其余断言差异保留在 `.cache/external-agent-audit-2026-11-17/jest.log`，尚未逐条用干净 HEAD 归因。
- **静态门禁** 直接运行脚本的七个命令均退出 0。分别是 `scripts/build/gen-external-agent-runtimes.mjs --check`、`scripts/gates/check-external-agent-runtimes.mjs`、`scripts/build/gen-external-agent-launch.mjs --check`、`scripts/gates/check-engine-launch-hosts.mjs`、`scripts/build/gen-agent-capabilities.mjs --check`、`scripts/gates/check-agent-capabilities.mjs`、`scripts/gates/check-acp-v1-contract.mjs`。ACP 静态检查的规格版本为 1.21.0、SDK 为 1.5.0；上游另有 v2 Draft。 [ACP 规范](https://agentclientprotocol.com/protocol/v1/overview)
- **真实进程** macOS 26.5.2 ARM64，Node v26.12.1。运行 `node_modules/.bin/tsx scripts/smoke/agent.ts --list` 和 `node_modules/.bin/tsx scripts/smoke/agent.ts qoder`。Qoder 1.1.65 的结果是 `1/1 passed`、`sandboxedConnection=true`、`reconnect=true`、`session=authentication-required`，保留报告 `.cache/smoke-agent/qoder.json`。Codex CLI 0.166.0 在临时 HOME 直接启动 `app-server --listen stdio://`，发 `initialize` 后发 `thread/list`，返回 0 条隔离会话。这是 Codex 本身的握手证据。
- **故障注入** 在仓库根执行 `node_modules/.bin/tsx .cache/external-agent-audit-2026-11-17/<script>`，依次用 `acp-session-fixture.ts`、`a2a-origin.ts`、`native-fault-injection.ts` 和 `terminal-headless-probes.mjs`。四个脚本均退出 0，断言的是上述缺口的复现。测试使用合成请求、故障帧和临时目录。
- **仍需验收** 带账号的完整回合、MCP 实际授权与续期、真正的 Tauri 及配对手机/浏览器使用、Linux/Windows 打包，以及真实 PTY 四步启动/交互/停止/清理。应用执行和安全行为以已测试入口为证据，平台与版本行仅代表目录约束。
