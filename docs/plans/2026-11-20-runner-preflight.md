# Runner 预检：部署后确认 Agent 真的能跑起来

> 状态：方案待确认，未实施。创建：2026-11-20（Asia/Shanghai）。
> 依据：[Runner 镜像审计](../evidence/2026-11-19-runner-image-readiness.md) F07，以及 2026-11-20 的决定「做一个单独的诊断命令，不并入 `/readyz`」。
> 范围：自托管 Host 的外部 Agent 执行路径，包括 legacy Docker、Kubernetes、workspace runtime 路由和 sandbox pool。不改变 `/readyz` 的语义，不调用模型。
> 本文的阶段、默认值和取舍是建议，经确认后才实施。

## 1. 建议与完成定义

**在 `cognia-external-agent` 里实现一个按阶段执行的 `RunnerPreflight`。由正在运行的 Host 通过管理员 RPC `host_runner_preflight` 执行，`cognia host doctor --runners` 和设备页的「运行时」区块调用这个 RPC 并展示结果。另外提供 `cognia-server runner-preflight` 子命令，供部署流水线在 Host 启动前，用同一份环境变量单独运行。** 检查用的是服务进程实际使用的那个后端和那份配置，不另外解析一遍配置。

完成须同时满足：

1. 第 4 节列出的每种失败，都由带故障注入的单元测试复现，并报告到正确的阶段：
   - 镜像不存在、私库没有凭据；
   - Pod 被 Restricted 拒绝、RuntimeClass 不存在、pull secret 名称错误；
   - 协议握手失败、工作区不可写；
   - workspace runtime 没有启动、密钥不对。
2. 预检创建的容器或 Pod 都带部署标签。正常结束、超时或 Host 崩溃之后，都能被删除，或由下一次启动时的孤儿清理回收。这一点有测试覆盖。
3. RPC 只有管理员能调用；同一时间只运行一次，并发请求共享同一个结果；不读取也不输出任何凭据内容。
4. 在真实环境中验收：
   - T2 Compose 跑一次成功，再分别人为制造「镜像 tag 不存在」和「`default` 路由到没启动的 runtime」，各跑一次失败；
   - 在 `deploy/k8s/overlays/kind` 加上 Restricted 标签，跑一次成功，再用 root 镜像跑一次被拒绝。
     结果记入账本；跑不了的环境标为未验收。

## 2. 现状

- `/readyz` 只表示控制面就绪（`crates/cognia-companion/src/healthz.rs:50`）。它无法证明 Runner 镜像能拉取、Pod 能通过准入、Agent 协议能握手。
- 后端由 `COGNIA_EXEC_BACKEND` 选定（`crates/cognia-external-agent/src/container_backend.rs:1654`），外面还有两层：
  - workspace runtime 路由（`workspace_runtime_backend.rs`），健康检查走 `/v1/health`，在 `:450`；
  - sandbox pool 路由（`sandbox_routing_backend.rs`），它自己有准入和探测：`cognia-sandbox-pool` 的 `admission.rs`、`probe_cache.rs`。
- Kubernetes 生成 Pod 的逻辑都已集中：
  - `runner_pod_manifest`（`kube_backend.rs:310`）
  - `inherit_from_server_pod`（`:141`）
  - `describe_pod_start`（`:187`）
  - `wait_until_running`（`:623`）
- 握手逻辑目前只在镜像 smoke 里（`deploy/runner/smoke.mjs:46` ACP、`:80` Codex app-server），Rust 侧没有可复用的离线握手。
- 运维入口已有两个：`cognia host doctor`（`crates/cognia-cli/src/commands/host.rs:2404`，含一次已认证的 RPC 检查），以及 `host_runtime_status` 管理 RPC（`crates/cognia-companion-rpc/src/rpc/host_admin.rs:387`，设备页的读取方是 `lib/remote-host/host-runtimes.ts`）。

## 3. 待你确认的决策

| 编号 | 问题                  | 选项                                                                                                                                                                             | 建议                                                                                          |
| ---- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D1   | 检查哪些 Agent        | **A**：组织 Agent 白名单（`cognia-server org-agents`）里启用的每个 runtime。**B**：只检查调用时指定的 runtime，默认 `codex-acp`。**C**：A，加上一个 `--runtime` 参数可以只查一个 | **C**。部署后的完整检查按白名单逐个执行；排查问题时可以只查一个                               |
| D2   | 握手做到哪一步        | **A**：ACP `initialize`、Codex app-server `initialize`，以及其他 CLI 的 `--version`，与镜像 smoke 一致，不需要模型凭据。**B**：再加一次真正的模型调用                            | **A**。预检不消耗用户额度，也不需要模型凭据；需要模型调用的验收继续放在 E2E                   |
| D3   | Kubernetes 准入怎么查 | **A**：先对后端将要创建的同一份 manifest 做 server-side dry-run（`dryRun=All`），通过后再创建一个真实的探测 Pod 并握手。**B**：只做 dry-run                                      | **A**。dry-run 能查出 Pod Security、配额、RuntimeClass 和字段错误，但查不出镜像拉取和握手问题 |
| D4   | 设备页要不要显示      | **A**：「运行时」区块新增一个「Runner 预检」卡片，显示上次的结果并提供运行按钮。**B**：只做 CLI                                                                                  | **A**。和已有的运行时状态放在一起，入口也一致                                                 |

## 4. 设计

**阶段**依次执行。某一阶段失败后，依赖它的后续阶段标为 `skipped`。每个阶段输出 `{ name, status: ok|warn|fail|skipped, detail, durationMs }`：

1. `config`：后端类型和已解析的参数。
   - Docker：镜像，以及凭据来源是匿名还是 `COGNIA_REGISTRY_AUTH_FILE`。
   - Kubernetes：namespace、RuntimeClass、pull secret 名称，以及它们是继承自 Server Pod 还是显式配置。
   - 路由：pool 是否开启，哪些 workspace 路由到了 runtime。
     只列名称，不列内容。
2. `image`：
   - Docker：调用现有的 `pull_image(image, auth)`（凭据经 `RegistryAuthSource`），或者确认本地已有该镜像。
   - Kubernetes：记为 `skipped`，由 kubelet 在第 4 步拉取。
3. `admission`：仅 Kubernetes。对 `runner_pod_manifest` 生成的同一份 manifest 做 dry-run 创建，失败时原样转述 API Server 给出的拒绝原因。
4. `start`：用与真实任务相同的 `RunnerSpec` 起一个探测 runner，命令取自 runtime catalog 的 launch。失败时 Kubernetes 用 `describe_pod_start`，Docker 用容器的退出状态。
5. `handshake`：按 D2 的范围握手。ACP 与 Codex app-server 的请求格式从 `smoke.mjs` 移植到 Rust，并保留 smoke 里的 JS 版本。
6. `workspace`：在探测用的工作区子目录里，以 Runner 的用户写入、读回、删除一个文件。
7. `teardown`：`kill` 后确认容器或 Pod 已经消失；删除失败标为 `warn`，并说明孤儿清理会回收它。

**路由**：pool 开启时，`image` 到 `start` 这几步改为调用 pool 现有的准入和探测，不再实现第二套；同时，回退目标后端也按上面的流程检查一遍。路由到 workspace runtime 的 workspace，检查它的密钥文件和 `/v1/health`，这样能查出 F13 那类误路由。

**实现位置**：

- 预检逻辑放在 `cognia-external-agent`，作为一个新模块 `preflight.rs`。它只依赖 `ExecBackend` 和 `ContainerApi`，以及 kube 后端里已有的函数，不往 `src-tauri` 放代码（ADR-0196）。
- RPC 放在 `cognia-companion-rpc` 的 `host_admin`；同时更新 companion 命令清单和响应 schema 目录。那份目录是手工维护的封闭目录，只能逐段修改。
- CLI 部分放在 `cognia-cli` 的 `host doctor`，`cognia-server` 新增一个子命令。
- UI 部分放在设备页的「运行时」区块，所有文案走 i18n，中英两份。

**安全**：

- 只有管理员能调用，与 `host_runtime_status` 同一档权限。
- 同一时间只运行一次，总超时默认 5 分钟。
- 探测资源带部署标签和 `cognia.preflight=true` 标签。
- 不向探测 Agent 传任何 provider 凭据。

## 5. 实施阶段

| 阶段 | 内容                                                                                                                             | 验证                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| P1   | `preflight.rs`：阶段模型、`config`、`image`、`start`、`workspace`、`teardown`，覆盖 Docker 与 Kubernetes；用现有 fake 做故障注入 | `cargo test -p cognia-external-agent`（container-exec、k8s-exec、test-support） |
| P2   | Kubernetes dry-run（`admission`）和 Rust 版握手（`handshake`）                                                                   | 单测：Restricted 拒绝、RuntimeClass 不存在、握手协议错误                        |
| P3   | 路由层：pool 复用已有探测，workspace runtime 健康检查                                                                            | `cargo test -p cognia-sandbox-pool` 相关模块                                    |
| P4   | `host_runner_preflight` RPC、命令清单、响应 schema、`cognia host doctor --runners`、`cognia-server runner-preflight`             | RPC 契约测试、`companion-api:check`、CLI 输出测试                               |
| P5   | 设备页卡片，中英 i18n                                                                                                            | Jest、`lint:i18n`、`i18n:build:check`、浏览器检查                               |
| P6   | T2 与 kind（Restricted）实机验收，记入账本                                                                                       | 见第 1 节第 4 条                                                                |

## 6. 风险

- **探测会创建真实资源**：如果在 Host 繁忙时运行，会占用一个 Runner 名额。预检遵守现有的并发与配额限制，不绕过；占不到名额时报告为 `warn`，而不是 `fail`。
- **dry-run 与实际创建的差异**：变更型 admission webhook 在 dry-run 时也会执行，但一些外部策略引擎在 dry-run 时不会写入审计记录，结论以第 4 步真实探测 Pod 的结果为准。
- **握手逻辑有两份实现**：JS smoke 与 Rust 预检会各有一份 ACP / app-server 请求。共用一份请求样例文件（protocol 目录下的 fixture），两边的测试都读取它，避免两边逐渐不一致。
