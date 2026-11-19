# Cognia 沙箱支持审计

- Status: verifying
- Lane: deep
- Created: 2026-11-09
- Updated: 2026-11-16
- Related: ADR-0028, ADR-0182, ADR-0217, ADR-0221, ADR-0233
- Checkout: `4be611e18063690d2cf5f7de678a3181d30a0af4`

## Original request

> 帮我分析一下现在的沙箱体系以及codex、claudecode自带的沙箱之类的，看看相关的关系，以及目前的支持情况，看看存在什么缺口

## Knowledge

| ID  | Statement                                                                                                                                                         | State       | Basis                                                                                                      | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| G1  | 从实际入口追踪谁执行、谁授权、谁限制文件和网络，并区分缺口与尚未验收的能力。                                                                                      | Agreed      | 原始请求，2026-11-09。                                                                                     | -          |
| C1  | 本轮交付现状审计和安全的本地实验。                                                                                                                                | Observed    | 原始请求，2026-11-09。                                                                                     | -          |
| O1  | Cognia 工具级沙箱、外部 Agent 进程级沙箱、项目放置和供应商原生权限分别由不同的组件执行。                                                                          | Verified    | ADR-0028、ADR-0182、ADR-0217，追踪当前 checkout 的工具、进程和放置入口，2026-11-09。                       | -          |
| H1  | macOS 的 Cognia 进程沙箱与 Codex 原生 Seatbelt 可以直接嵌套。                                                                                                     | Invalidated | V1 的两个内层模式都返回退出码 71。                                                                         | O1         |
| O2  | 当前 launcher 与本机 Codex 0.166.0 App Server 组合时，两个内层 Seatbelt 模式都启动失败。委托给外层的 `externalSandbox` 在同一环境中可执行命令，权限由外层决定。   | Verified    | V1，Apple Silicon macOS 的真实进程与 JSON-RPC。                                                            | O1         |
| O3  | 桌面重型工具沙箱关闭轻量 workspace confinement，局部禁用名单遗漏 `apply_patch`。启用对应工具且已有工具授权时，真实 sidecar handler 能写到沙箱工作区外的普通路径。 | Verified    | V2，当前 checkout 的 SendOptions、Anthropic 工具投影和权限门、临时目录真实写入。                           | O1         |
| O4  | 配置的 `network: off` 上限已把模型的 `on` 收窄。容器工具适配器仍向 egress-on 容器发送调用，并回报 `networkEnforced: false`。                                      | Verified    | V3，当前 checkout 的真实适配器与记录调用的 Host fixture。                                                  | O1         |
| O5  | 项目放置接管外部进程时，Docker 和远程准备路径使用 `EnvironmentSpec.egress`，未读取外部 Agent 的 `sandboxPolicy` 来收窄它。                                        | Observed    | V4，真实入口源码与项目规范，2026-11-09。                                                                   | O1         |
| O6  | macOS 单次工具 Seatbelt 能限制写入和网络，普通的工作区外文件仍可读。外部进程 wrapper 有独立的 `workspace` 读范围模式。                                            | Verified    | V5，当前 launcher 源码及当前构建的单次执行器。                                                             | O1         |
| O7  | Claude Agent SDK 的原生 Bash 配置有类型化传递及 Linux namespace 特例。外部 Claude ACP 采用另一条进程启动路径。                                                    | Verified    | V6，SDK 固定版本、选项转换和外部 manifest。                                                                | O1         |
| O8  | Windows lifecycle 有例外授权和可操作 UI，当前本地进程 launcher 仍按平台拒绝。单次 Windows runner 也会拒绝无法落实的文件根或关网要求。                             | Observed    | V7，Host 入口、lifecycle 和 Windows runner 源码，2026-11-09。                                              | O1         |
| Q1  | 实际桌面包、Linux/WSL2、Windows、Docker/Kubernetes/E2B/Lume 和真实账号分别能通过哪些端到端验收？                                                                  | Open        | V8 留待真实环境验证。                                                                                      | O1         |
| O9  | 本轮 checkout 的 `container` 适配器对已绑定 placement 调用未定义的 `egressOff`。                                                                                  | Verified    | V14 复现 `ReferenceError`。发送前组装在同一个 try/catch 中解读为 unplaced，保留聊天，隔离 shell 随后拒绝。 | O1         |
| O10 | Headless 内置容器工具确认了出网上限，执行请求仍不携带每次调用的读写根、CPU 秒数和内存上限。                                                                       | Verified    | V15 记录实际适配器 RPC，Rust 请求结构和运行器只采纳环境 size class 与 mount。                              | O1         |
| O11 | 容器任务 shell 的运行中调用忽略传入的 AbortSignal。                                                                                                               | Verified    | V16 在真实 session runtime 和 adapter 上取消待响应的 IPC，随后仍收到成功，未派发取消命令。                 | O1         |
| O12 | Canvas iframe 的 CSP 既挡不住 self-navigation，也可能被作者 HTML 中的伪 head 使注入落进注释。                                                                     | Verified    | V17 从实际 TS 入口执行，Chrome 回环收到了两个请求，正常 fetch 对照无请求。                                 | O1         |
| O13 | Kubernetes `egressEnforced` 根据配置推导，当前准入与 ready 阶段没有验证 CNI 实际断网；原生 NetworkPolicy 也缺域名能力。                                           | Observed    | V18 对照 Kubernetes backend、remote admission 与官方 NetworkPolicy 语义。                                  | O1         |
| O14 | 本地 Codex 0.166.0 的双层 Seatbelt 仍不可运行，外层可写时委托策略也可写。                                                                                         | Verified    | V19 使用磁盘上的 launcher 二进制和隔离的 Codex HOME 真实探针。                                             | O1         |
| O15 | 审计时 `cognia-exec-sandbox` 无法从 checkout 编译。                                                                                                               | Verified    | V20 在 `net_proxy.rs:968` 得到 Rust 语法诊断。                                                             | -          |
| Q2  | CNI、实际容器子进程、供应商工作流和三端交付包的有效策略是什么？                                                                                                   | Open        | V18、V21 留待受控真实环境验收。                                                                            | O1         |
| O16 | Docker CUA 和 E2B 托管桌面的 shell 策略校验把任何正数的 CPU 和内存配置当成满足任意调用上限。                                                                      | Verified    | V22 用真实校验器复现 2 CPU 和 2048 MiB 接受 1 CPU 秒和 16 MiB。两个 adapter 通过后都只发 argv 等执行参数。 | O1         |
| O17 | 容器 adapter 在清理 RPC 之前移除 binding，返回错误后再试会无操作返回成功。                                                                                        | Verified    | V23 两次 release 只有一次 Host 调用，且第一次失败。                                                        | O1         |
| O18 | MCP Apps 双 iframe 在 Chrome 中保留外层网络限制，即使内层的 CSP 被伪 head 吞掉。外层也拦截了内层明确配置的已批准 connect origin。                                 | Verified    | V24 使用生产 CSP evaluator、注入函数和外层 relay，在回环上观察实际浏览器策略。                             | O12        |

## Problem frame

以会话或任务实际调用的执行入口为单位，识别审批、进程隔离、工具隔离、运行地点和出网策略的所有者。用临时文件和回环地址验证最可能改变结论的边界。审计结果包含复现的差异、源码确认的差异和独立的运行环境验收项。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                             |
| ------------ | ------ | ----------------------------------------------------------------------- |
| scale        | high   | 横跨外部 Agent、内置工具、sidecar、Host 放置和多个隔离后端。            |
| technical    | high   | 叠加涉及 Seatbelt、Linux namespaces、网络代理和不同的远程供应商控制面。 |
| coupling     | high   | 一个运行可混合调用本地工具、供应商原生工具、MCP 和远程执行目标。        |
| requirement  | low    | 用户要求现状、关系和缺口分析。                                          |
| verification | high   | macOS 本地边界可以实测。部署、设备、真实供应商和跨平台需要对应环境。    |
| risk         | high   | 误判文件或网络上限可能扩大访问范围，误判嵌套能力会造成执行不可用。      |

## Risks

| ID  | Risk (impact)                                                    | Severity | Source                                                                | Claim                                                                     | Refuted by                                                               |
| --- | ---------------------------------------------------------------- | -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| R1  | 双层 Seatbelt 令 Codex 在普通权限模式下无法运行命令。            | high     | ADR-0028，Codex App Server，Host launcher                             | 进程包裹后，标准 Codex 沙箱仍可执行无副作用命令。                         | App Server 初始化成功，随后命令因第二次应用 profile 退出 71。            |
| R2  | 已打开桌面 OS 沙箱的普通会话可通过遗漏的工具在 Host 写入。       | high     | ADR-0028、`RESTRICTED_MODE_DENIED_TOOLS`、sidecar 工具注册            | 启用重型沙箱后，剩余的写入工具仍受其文件边界限制。                        | `apply_patch` 继续投影并能写入工作区外的普通文件。                       |
| R3  | 容器内命令的网络比调用者请求的更宽。                             | high     | ADR-0182、ADR-0221、沙箱调用和放置接口                                | `off` 与 egress-on 不兼容时，调用应拒绝或执行于实际离线的隔离中。         | 适配器把调用发送到 egress-on placement。                                 |
| R4  | 外部 Agent 迁往项目容器后，个人设置的出网上限未随之传递。        | high     | ADR-0217、项目容器准入                                                | 从本地 launcher 切换到项目环境时，执行层仍收窄或拒绝不兼容的 Agent 策略。 | 项目后端只从 `EnvironmentSpec.egress` 得出网络设置，没有策略交集或拒绝。 |
| R5  | 把读根当成所有 macOS 路径的内核读上限。                          | high     | ADR-0028、Seatbelt profile                                            | 明确传入读根的单次 OS 执行会拒绝根外普通文件。                            | shell 读取根外标记成功。                                                 |
| R6  | UI 或文档把支持字段、许可或供应商能力解释为当前入口的执行能力。  | medium   | Codex 和 Anthropic 官方文档、Windows lifecycle、CUA provider registry | 同一入口的能力声明与实际生效机制一致。                                    | Windows 许可到不了 launcher，或 Claude SDK 设置被误读为 ACP 设置。       |
| R7  | 已绑定的 headless 容器工具被误标为不可放置，导致该会话执行失败。 | high     | ADR-0224 和 SendOptions                                               | 检查一个已绑定的离线容器不会抛异常。                                      | 健康的 fixture 绑定后校验抛出 ReferenceError。                           |
| R8  | 选择容器后，配置的窄文件范围和资源上限被静默丢弃。               | high     | session runtime、task-shell RPC、容器启动                             | 更窄的设置必须被执行层落实或在执行前拒绝。                                | 命令派发成功而请求只携带项目级 mount、placement 和出网限制。             |
| R9  | 用户取消后容器内任务仍可继续执行。                               | high     | Plugin SandboxAPI、runtime、task-shell RPC                            | 取消能够到达已启动的单次执行并收到终止确认。                              | AbortSignal 触发后继续等待 Host 成功且没有取消 RPC。                     |
| R10 | 用户运行 Canvas 内容后发出预期外的网络请求。                     | high     | iframe、CSP 注入                                                      | 网络禁用策略作用于 iframe 发起的所有请求。                                | 普通 fetch 被挡住，但 self-navigation 或伪 head 发送请求。               |
| R11 | Kubernetes 集群错误配置时可能被显示和准入为已强制断网。          | high     | Kubernetes provider mode、remote admission                            | 严格准入应有数据面证据。                                                  | 无实施 NetworkPolicy 的 CNI 仍通过控制面判定。                           |
| R12 | 最新 Rust 沙箱无法构建并覆盖已修改的代理路径。                   | high     | cognia-exec-sandbox                                                   | 当前源码可以构建并测试。                                                  | `cargo test` 在净化后地址的拨号分支编译报错。                            |
| R13 | 桌面所在 provider 的机器规格被误认为每次执行的资源上限。         | high     | `attestDockerPolicy`、`attestManagedPolicy`，以及其 shell adapter     | 实际能力超出请求时，必须收窄或拒绝。                                      | 2048 MiB 的机器被判定满足 16 MiB，CPU 并行度被当成累计 CPU 秒。          |
| R14 | 清理错误导致保留容器失去客户端追踪。                             | medium   | 容器 adapter 与 session runtime 的两层释放逻辑                        | 重试能再次清理上次失败的实例。                                            | 第二次 release 返回成功，Host 没收到第二次清理。                         |
| R15 | MCP App 获批的域名在渲染后仍无法连接。                           | medium   | 双层 iframe 的有效 CSP                                                | 受控的已批准地址可连接，未批准地址被拦截。                                | 已批准的 loopback fetch 被外层 CSP 拦住。                                |

## Verification obligations

| ID  | Risk                         | Method                                                                                       | Independence | Evidence                                                                                                                                    | Coverage                                                                                | Status  |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| V1  | R1                           | 从当前源码构建 launcher，直接对 Codex App Server 发送 `command/exec`，比较单层与双层。       | real-env     | 本机 0.166.0，单层两模式成功，双层两模式 exit 71 `sandbox-exec: sandbox_apply: Operation not permitted`，委托模式 exit 0。详见下表。        | macOS，真实二进制与 stdio；无模型回合。                                                 | failed  |
| V2  | R2                           | 对真实 SendOptions 加临时否定断言，再走 sidecar 工具投影、权限门和 handler。                 | tool         | Jest 探针保留 `apply_patch`、`directory_delete`、`terminal_repl_spawn`，`confinement` 为 undefined；已授权 `apply_patch` 实际创建根外标记。 | 普通受信工作区的桌面 OS 配置，启用 Anthropic coreFiles 工具。只实际调用 `apply_patch`。 | failed  |
| V3  | R3                           | 用真实 session runtime 绑定显式 off 上限并收窄 on 请求，走真实适配器并记录 Host IPC 参数。   | tool         | 否定断言失败，收到一次 `environment_task_shell_exec`，placement 为 egress-on，结果 `networkEnforced: false`。                               | 容器适配器边界。实际 Docker 网络未验收。                                                | failed  |
| V4  | R4                           | 对照本地 launcher、placement router、Docker 与远程准备阶段。                                 | self         | `harden_desktop_spawn` 对已路由 placement 跳过本地 wrapper，`prepare_local` 和远程准备从准入的 spec 取得 egress。                           | 已追踪源码。待实际 placement 中重复出网探针。                                           | planned |
| V5  | R5                           | 使用当前构建的 `cognia-sandbox-exec` 执行受控路径和 loopback 探针。                          | real-env     | 工作区内写成功、外部写拒绝、外部普通标记可读、回环拒绝。                                                                                    | macOS 单次工具 Bash 后端，普通文件，网络 off。                                          | failed  |
| V6  | R1, R6                       | 运行 Codex、Claude SDK、OS 及 placement 的现有测试。                                         | tool         | Jest 8 suites，426 passed，1 skipped；sidecar 54 passed；`cargo test --locked --offline -p cognia-exec-sandbox --lib` 224 passed。          | 测试范围见下文。未认证完整桌面、Linux 或 Windows。                                      | passed  |
| V7  | R6                           | 从 manifest 和设置追到真正的启动入口及 Windows runner 准入。                                 | self         | Claude SDK 与 ACP 使用不同入口；Windows 两个本地进程 wrapper 都拒绝不支持平台。                                                             | 当前源码。真实 Windows、WSL2 和 SDK 的 shell 行为待验收。                               | planned |
| V8  | R1, R2, R3, R4, R5, R6       | 补充完整桌面和远程 Host 的真实运行矩阵。                                                     | real-env     | 本轮真实运行限本机无认证进程和回环。                                                                                                        | 认证 Codex 0.167+、Claude SDK/ACP、Linux namespaces、Windows、容器和设备。              | planned |
| V9  | R2                           | 重跑普通会话、workflow overlay 和 PTY 策略变更测试。                                         | tool         | Jest 断言保留 bare 和 namespaced deny。sidecar 验证同策略 PTY 可写，较早的无沙箱 PTY 拒绝写入。                                             | 内置工具和 sidecar PTY。                                                                | passed  |
| V10 | R3, R4                       | 测试显式上限传到本地及远程容器准入，宽于请求时拒绝。                                         | tool         | Jest 容器夹具和 Rust pool 通过，包含远程不可证明的域名策略、旧实例复用隔离和错误消息不回显原始值。                                          | 实际 Host 准入代码与 fake 容器/provider，真实 Docker daemon 尚未运行。                  | passed  |
| V11 | R5                           | 当前构建的单次执行器通过 stdin JSON 读写标记并尝试回环连接。                                 | real-env     | `IN_SCOPE READ_WRITE_AND_EGRESS_OK`。已声明工作区内读写允许，兄弟文件读写和回环连接被拒绝。                                                 | Apple Silicon macOS，系统 shell 与 cat，保留无读根时的旧策略。                          | passed  |
| V12 | R6                           | 验证 Windows Host 识别和例外能力缺失的状态投影。                                             | tool         | lifecycle 和生产组装测试通过。Windows WebView 来源正确，Host 不支持时授权及连接均返回 `platform_unsupported`。                              | Jest Host fixture，真实 Windows 未运行。                                                | passed  |
| V13 | R1                           | 验证精确错误投影，同时保留原审批和沙箱。                                                     | tool         | Codex adapter 的 `item/completed` 回归通过。外层只增加一条写入限制时，真实系统仍拒绝重复 Seatbelt，日志为 `forbidden-sandbox-reinit`。      | 原生错误可解释，双层执行不可用仍成立。                                                  | passed  |
| V14 | R7                           | 运行当前适配器测试的已绑定离线检查，并追踪 SendOptions。                                     | tool         | 1 failed、550 passed、1 skipped，失败为 `ReferenceError: egressOff is not defined`。                                                        | 真实 TS 适配器，Host fixture。                                                          | failed  |
| V15 | R8                           | 经真实 session runtime 收窄到子目录、1 CPU 秒、16 MiB，再记录生产适配器的 RPC。              | tool         | 探针收到成功，RPC 仅带有效出网、工作区、cwd、命令及超时等参数。Rust 侧按项目 size class 和 mount 启动。                                     | 实测 RPC，源码追到 Docker runner。实际容器文件写入和资源消耗未实测。                    | failed  |
| V16 | R9                           | 等真实适配器派发后 abort，再释放 fixture 的 Host 响应。                                      | tool         | 只有初始 exec RPC，runtime 仍返回 exit 0。                                                                                                  | 容器调用层。未测试打包 UI Stop 与真实进程退出。                                         | failed  |
| V17 | R10                          | 从生产 TS 运行 Canvas，监听回环，比较普通 fetch、self-navigation 与带伪 head 的 HTML。       | real-env     | Chrome 147.0.7727.56 收到后两类请求，普通 fetch 无请求。邻近 Jest 5 suites 81 测试通过。                                                    | 浏览器策略与真实源函数。未测打包 WebView、MCP Apps 或 Artifact 的调用链。               | failed  |
| V18 | R11                          | 比较 provider 的控制面准入与官方 CNI 语义，再在隔离集群做实际 DNS、TCP 和节点地址负向探针。  | real-env     | 源码以配置推导已执行，Kubernetes 官方明确 NetworkPolicy 依赖 CNI。未使用真实集群。                                                          | 严格 Kubernetes placement，实际部署行为未知。                                           | blocked |
| V19 | R1                           | 比较 Codex 原生、双层 Seatbelt 和显式委托。                                                  | real-env     | 两个原生模式 exit 0。两个嵌套模式 exit 71 `sandbox_apply: Operation not permitted`。委托可创建工作区标记。                                  | 已有 Apple Silicon launcher 二进制，Codex 0.166.0，stdio，临时目录，无模型回合。        | failed  |
| V20 | R12                          | 从当前 checkout 运行 `cargo test --locked --offline -p cognia-exec-sandbox --lib`。          | tool         | `net_proxy.rs:968` 的 `Err(DialFailure::Refused) =>` 缺外层 match，编译 exit 101。                                                          | 当前 Rust crate。没有新构建的产物。                                                     | failed  |
| V21 | R3, R5, R6, R8, R9, R10, R11 | 验证允许、拒绝、实际进程终止和清理后的策略，包括重试、重连、复用与恢复。                     | real-env     | 当前无 Docker daemon，未使用真实云账号、集群、其它 OS、Tauri 或 Capacitor。                                                                 | Docker/gVisor、Kubernetes/Cilium、E2B、Lume、Linux/WSL2、Windows 与各壳。               | blocked |
| V22 | R13                          | 以更小的每次执行预算调用真实资源校验函数，追踪通过后的 adapter dispatch。                    | tool         | Docker CUA 和 E2B managed 都返回 `attested: true`，入参为 2 CPU、2048 MiB，对比 1 CPU 秒、16 MiB。                                          | 生产 TS 判定。未向实际 VM 压测。                                                        | failed  |
| V23 | R14                          | 让已记录容器 ID 的 release RPC 失败，再调用同一 ref 的 release，查看 RPC 次数。              | tool         | 第一次错误，第二次返回成功，总计只有一次 release RPC。                                                                                      | 真实 adapter，Host fixture。实际 Docker daemon 回收待验。                               | failed  |
| V24 | R10, R15                     | 在 Chrome 运行 MCP Apps 的生产双层 CSP 和 relay，比较普通拒绝、伪 head 和明确批准的 origin。 | real-env     | Chrome 147.0.7727.56 三组脚本均运行，回环无请求。伪 head 未安装内层 CSP，所有请求仍被外层拦截，已批准组也被拦截。                           | 生产 TS 和双 iframe browser 路径。未跑完整 AppBridge/原生 WebView。                     | failed  |

## Decisions

| ID  | Date       | Decision                                                                                                     | Action     | Based on                    | Reversal trigger                                             |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------ | ---------- | --------------------------- | ------------------------------------------------------------ |
| D1  | 2026-11-09 | 通过真实 launcher、真实 sidecar 和记录调用的适配器 fixture 分别找反例。                                      | experiment | O1, C1                      | 发现探针走了不同执行入口或使用了旧 launcher。                |
| D2  | 2026-11-09 | 优先记录执行层未落实的权限和失败的启动组合，分别保留兼容性和权限影响。                                       | diagnose   | O2, O3, O4, O5, O6, O7, O8  | 运行环境或 Host 明确证明了等价的强制边界。                   |
| D3  | 2026-11-16 | 先核对新旧路径和共享 checkout，优先验证悄悄丢失的限制、启动失败与取消，再核对 provider 能力矩阵。            | diagnose   | G1, O1                      | 如果新入口已在最终执行层重做同一策略的准入，重跑既有探针。   |
| D4  | 2026-11-16 | 将修复优先级定为构建及运行恢复、容器与 Canvas 隔离、取消和 Codex 组合，后续再补 provider 特性。              | diagnose   | O9, O10, O11, O12, O14, O15 | 出现当前源码修复与对应负向验证，或新的跨租户反例。           |
| D5  | 2026-11-16 | 把 headless 丢失资源字段和桌面 provider 的错误 attest 分别定位到各自执行入口，记录 MCP Apps 的实际策略交集。 | diagnose   | O10, O16, O17, O18          | 新的执行边界落实真实配额、补偿清理或域名批准后实际网络行为。 |

## Residual risks

| ID  | Residual                                                    | From        | Why still open                                                   | Next action                                                                   | Status |
| --- | ----------------------------------------------------------- | ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| X1  | macOS Codex 组合不可用。                                    | V1          | 原生层与 Cognia launcher 同时试图应用 Seatbelt。                 | 为 Host 强制边界与 Codex 原生边界定义兼容的切换条件，验证只读模式仍只读。     | open   |
| X2  | 桌面重型工具沙箱遗漏写入面。                                | V2, V9      | 新规则已在最终工具投影前重新施加，PTY 复用检查已覆盖。           | 交付包复测归入 X5。                                                           | closed |
| X3  | 容器出网准入待真实环境验证。                                | V3, V4, V10 | 双路径回归通过，Docker daemon 未运行，远程 provider 用 fixture。 | 在可用 Host 上验证 off、allowlist、拒绝前无执行和运行时复用。                 | open   |
| X4  | macOS 单次沙箱忽略显式读根。                                | V5, V11     | 已用当前构建的执行器验证修复。                                   | 其他 macOS 版本和工具链验收归入 X5。                                          | closed |
| X5  | 平台、供应商及打包环境差异。                                | V7, V8      | 本机版本和本地进程证据覆盖有限。                                 | 在真实 Host 上执行统一的允许和拒绝探针，记录版本、实际 placement 与生效策略。 | open   |
| X6  | 离线容器绑定检查抛异常。                                    | V14         | 当前 checkout 既有测试失败。                                     | 恢复 offline attestation，补从 SendOptions 到真实容器的验证。                 | open   |
| X7  | 容器未执行细粒度目录和资源限制。                            | V15, V21    | 实测接口缺字段，真实 guest 执行待验。                            | 在派发前比对并拒绝无法满足的上限，或在容器内落实。                            | open   |
| X8  | 容器 shell 缺单次取消和确认。                               | V16, V21    | runtime 到 RPC 之间丢失取消。                                    | 以一次 exec 为单位终止进程树，并做 Stop 回归。                                | open   |
| X9  | Canvas 可信 iframe 的 CSP 网络假设有反例。                  | V17, V21    | Chrome 已复现，其他共享调用点及 WebView 待验。                   | 消除正则落入非 head 的路径，并在浏览器层证明导航和连接限制。                  | open   |
| X10 | Kubernetes 出网能力证据不足。                               | V18, V21    | 生产 CNI、节点例外及网络策略组合未探测。                         | 在准入前执行数据面负向探针，覆盖是否有额外 allow 策略。                       | open   |
| X11 | 本机 Codex 嵌套仍不可用。                                   | V19         | 现有 launcher 原生实测。                                         | 委托前保证 Codex 原有只读、出网和审批边界，补认证回合。                       | open   |
| X12 | 当前 Rust 沙箱构建失败。                                    | V20         | 语法错误阻塞重建及新源码验证。                                   | 修复拨号分支，再跑完整执行器及容器后端。                                      | open   |
| X13 | 真实平台与供应商资格验收缺口。                              | V21         | 本轮使用 macOS、Chrome、Codex 二进制与协议 fixture。             | 在可控环境执行 V21 矩阵。                                                     | open   |
| X14 | 桌面资源校验允许大于请求的规格。                            | V22         | adapter 未传 per-call CPU 秒和内存限制。                         | 执行端落实或拒绝，验证累计 CPU 与内存分别生效。                               | open   |
| X15 | 容器清理重试丢失待回收 ID。                                 | V23         | 上层重试不能恢复 adapter 已清掉的 binding。                      | 保留失败 ID，确认部分成功和重试下的 Host 调用。                               | open   |
| X16 | MCP Apps 已批准的 loopback connect origin 被外层 CSP 阻塞。 | V24         | 生产双 iframe 样式已实测。跨浏览器和完整应用流程待验。           | 保证 approved case 能连，同时重验未获批、伪 head 和导航例外。                 | open   |

## Outcome

| ID  | Signal                                                   | How / when measured                                 | Result                                                                                          | Status  |
| --- | -------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| M1  | 可按入口说明谁执行沙箱、哪些边界有反例、还有哪些需验收。 | 当前 checkout 源码、官方文档和本地探针互证。        | 找到三处可重现的组合或策略问题，另有宽读、外部 Agent placement 策略及 Windows 能力差异。        | met     |
| M2  | 上述边界在交付包、认证会话及远程平台的有效策略一致。     | V8 的真实运行矩阵。                                 | 后续验收。                                                                                      | pending |
| M3  | 重新回答当前 checkout 的缺口，并给出独立证据。           | 2026-11-16 的源码追踪、Jest、Chrome 及 Codex 探针。 | 复现构建失败、离线判定异常、丢限、丢取消、Canvas 请求以及 Seatbelt 叠加失败。补齐后端能力边界。 | met     |
| M4  | 复核相邻的 CUA shell、容器回收和 MCP Apps 入口。         | 2026-11-16 的源码、实际校验器和 Chrome。            | 证实桌面错误接受较宽资源、清理重试不派发，以及 MCP Apps 已批准连接仍被拦截。                    | met     |

## 修复轮次与验收计划

> 尝试修复这些问题

按现有边界逐项验证。

1. 工具入口先复现遗漏的 Host mutator，再确认重型沙箱拒绝原生和 namespaced 两种名称，且经证明有 wrapper 的命令仍可用。
2. 先复现容器丢弃已收窄的出网限制，再验证本地命令和外部进程在 Host 准入处拒绝超出上限的环境，拒绝不触发回退。
3. 先复现 macOS 单次命令读取根外的普通标记，再用当前构建的执行器验证根内读写、根外拒绝、系统命令可启动。
4. Windows 本地 readiness 和同意入口须服从当前 launcher 支持，远程入口及已有 consent 记录保持兼容。
5. Codex 委托路径必须保留每个模式的只读、额外写根、出网和审批边界。没有等价性证据时，仅改进诊断。以真实 App Server 和当前构建的 launcher 复核。

## 修复轮次结果

- **桌面工具和 PTY。** 在 workflow、插件和运行授权合并后补齐内置 Host mutator 的 deny。经确认走 process wrapper 的工具仍保留。PTY 后续操作核对创建时保存的进程策略，避免复用无沙箱或策略不同的旧终端。
- **任务容器和外部进程。** Session Runtime 最终只收窄出网字段，保持有效的只读文件目标。容器调用的网络上限随内部 RPC 发送，并在 Host 准入时与已展开预设的有效出网比较。无法满足时拒绝。`networkEnforced` 仍专指离线。文件辅助工具本身请求 `off`，所以会在出网环境中拒绝。远程 provider 的一般 allowlist 声明不足以证明 DNS 也受限，严格请求只接受能证明离线的远程环境，并与可选环境使用不同的复用键。
- **macOS 可读根。** 非空读取范围使用已有的 scoped loader profile。系统运行时、显式可写范围和专用 scratch 保留读取权，空列表兼容旧行为。
- **Windows 和 Codex。** lifecycle 读取真实 Host 平台，有实际能力才允许申请 Windows 未沙箱例外。当前 Cognia Host 没有该能力。Codex 只新增 `sandbox_apply` 诊断。真实内核对有约束的外层拒绝再次应用 Seatbelt。现有进程级 profile 无法替代 Codex 逐回合的只读和出网限制。

第一轮先复现了工具 deny、容器关网、旧 PTY、macOS 读根、Windows consent 和 Codex 错误投影问题。最终针对性 Jest 为 10 suites、1082 通过、1 跳过。Sidecar 为 81 通过。Rust 执行器与 pool 为 480 通过、2 忽略。Companion Rust `cargo check`、内部 API 合同、静态导出检查、Agent 能力与同目录测试 gate 通过。改动涉及的 TS/sidecar 文件通过针对性 ESLint，sidecar 主 tsconfig 检查通过。

整仓 `pnpm typecheck` 停在 `tmp/ui-polish/picker-head.tsx:168` 的语法错误。整仓 `pnpm lint` 有 13 个范围外警告。缩小 TypeScript 输入后仍有并行 OCR 改动及 sidecar ES target 的诊断。Docker CLI 可用，daemon socket 无法连接。未完成真实 Docker/Kubernetes/E2B、Windows、Linux/WSL2、Tauri 打包及带模型回合的 Codex 验收。X1、X3 和 X5 继续保留。

## 支持矩阵

| 入口                    | 当前执行面                                                                                                                                                                                           | 关键限制                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cognia 内置工具         | 轻量 workspace confinement 做工具路径判断和审批。重型会话以 `sandbox_*` 等受控工具替代部分 Host 工具。macOS 用 Seatbelt，Linux 用 bwrap，CLI 可调用 Rust 单次执行器，特定 CLI 路径另有交互进程包装。 | 重型沙箱由 session → character → app 设置解析，普通会话默认关闭。轻量检查依赖 workspace 及工具分类。两者在部分入口互斥。Windows runner 有 restricted token、low integrity 和 Job Object，文件根和关网要求无法执行时拒绝。 |
| Cognia 外部进程         | 本地 macOS/Linux 用 `cognia-external-agent-launcher` 包住 vendor 进程和子进程。外部 Agent 独立 state root 和受保护路径规则与此配合。                                                                 | 普通外部 Agent 策略默认允许 home 读和完整出网。workspace 范围、allowlist 和 off 可收窄。外层 off 同时影响模型和认证流量。Windows 严格 launcher 拒绝。                                                                     |
| Codex App Server        | Host launcher 或项目 placement 在外，Codex 的 `readOnly`、`workspaceWrite`、显式 bypass 在内。适配器在 thread 和 turn 分别使用相应的 wire 类型，管理策略及人工审批有独立映射。                       | 默认/plan 等权限模式收窄至 read-only，acceptEdits 可到 workspace-write。命名 profile 与显式 `externalSandbox` 委托没有常规选择路径。Codex ACP 的适配能力需单独验证。                                                      |
| Claude Agent SDK        | 内置 SDK `0.3.305` 支持传递 `sandbox` 配置，native Bash 沙箱与 Cognia 的工具替换分开。Linux namespace 特例需要一次性显式批准并要求启动失败时关闭。                                                   | 普通重型沙箱开关不会统一开启 Claude 原生 Bash 沙箱，特殊开关会削弱原生 shell 文件隔离。Claude SDK 是独立运行入口。                                                                                                        |
| 外部 Claude Code ACP    | `claude-agent-acp` 从外部进程路径启动，由 Cognia 外层 launcher 或项目环境控制。                                                                                                                      | 内置 SDK 卡片的设置没有映射到外部 ACP。Claude 自带 Bash 沙箱的生效取决于原生入口、配置和平台。                                                                                                                            |
| 项目环境                | Docker、远程 Kubernetes、E2B 通过 Host provider set 选择 agent 和 task shell 的执行地点，按 `EnvironmentSpec` 准入。                                                                                 | 要求隔离的 placement 失败时拒绝，允许回退的情况有原因并返回原路径。Kubernetes egress 取决于配置和集群。E2B 远程 provider 的出网与 E2B 前端 microVM 工具 adapter 是不同能力，后者会拒绝无法证明的 per-call allowlist。     |
| Computer Use 和其他隔离 | CUA 有 Docker computer-server、特定条件下的 E2B 生命周期或托管桌面、版本化 Lume adapter。插件 Worker/Node/WASI 和 iframe 另有运行时隔离。                                                            | E2B GUI 能力取决于托管委派和资格验证。Lume 需对应的 macOS Host 与契约版本。普通浏览器或移动端通过配对 Host 使用其能力，本地代码预览与 Host shell 使用不同边界。                                                           |

依据：[Cognia 沙箱实现索引](../content/docs/en/subsystems/sandbox/index.mdx)、[外部进程策略](../content/docs/en/subsystems/sandbox/os-backends.mdx)、[Codex adapter](../../packages/agent-codex/src/app-server-client.ts)、[Claude SDK option projection](../../sidecar/src/runtimes/claude-agent-sdk/sdk-options.ts)、[Claude ACP manifest](../../packages/agent-claude-code/src/manifest.ts)、[远程 providers ADR](../content/docs/en/adr/0221-a-remote-sandbox-is-a-provider-behind-the-same-seam.md)、[CUA adapter registry](../../lib/sandbox/adapter-registry.ts)。

## 上游对照

- Codex 本地原生执行有文件和网络规则，审批单独决定能否升级。OpenAI 当前文档列出 macOS Seatbelt、Linux bwrap/seccomp、Windows MXC 与传统模式、WSL2 Linux 模式，也支持命名 permission profiles。App Server 协议定义了把 sandbox 委托给已隔离服务进程的 `externalSandbox`。选择此模式时需由 Host 实现当前会话仍应遵守的文件、网络与审批边界。 [OpenAI Codex 审批和沙箱](https://learn.chatgpt.com/docs/agent-approvals-security) · [权限 profiles](https://learn.chatgpt.com/docs/permissions) · [App Server 协议](https://learn.chatgpt.com/docs/app-server)
- Claude Code 的本地原生沙箱约束 shell 及其子进程。内置 Read/Edit/Write、WebFetch、hooks、MCP 由其他权限机制和外层环境决定。当前官方文档列出 macOS、Linux/WSL2，明确原生 Windows 无此 Bash 沙箱。启用后可用 `failIfUnavailable` 和 `allowUnsandboxedCommands` 约束依赖缺失或失败后的回退。 [Anthropic Bash 沙箱](https://code.claude.com/docs/en/sandboxing) · [Claude Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)

## 复核方法与结果

V1 和 V5 从当前 checkout 构建原生二进制。

```sh
CARGO_INCREMENTAL=0 cargo build --locked --offline -p cognia-exec-sandbox \
  --bin cognia-external-agent-launcher --bin cognia-sandbox-exec
```

在隔离的 HOME、CODEX_HOME、TMPDIR 和测试目录启动 `codex app-server --stdio`，发送 `initialize`、`initialized`、`command/exec`。用同一参数经 `cognia-external-agent-launcher --cwd <work> --writable <work> --writable <home> --writable <tmp> --readable <work> --readable <home> --readable <tmp> --` 重复调用。探针尝试工作区内外各一次写入，读取普通外部标记，并连接独立的 loopback 监听器。用 `cognia-sandbox-exec` 的 stdin JSON 调用 `bash` 时配置 `writable` 和 `readable` 均为测试工作区，`network` 为 `off`。所有文件和 socket 都是本轮临时资源。

| 组合                            | 退出码 | 写工作区内 | 写工作区外 | 读工作区外标记 | 连接回环 |
| ------------------------------- | ------ | ---------- | ---------- | -------------- | -------- |
| Codex 原生 `readOnly`           | 0      | 拒绝       | 拒绝       | 成功           | 拒绝     |
| Codex 原生 `workspaceWrite`     | 0      | 成功       | 拒绝       | 成功           | 拒绝     |
| Cognia 外层 + 上述任一内层      | 71     | 未执行     | 未执行     | 未执行         | 未执行   |
| Cognia 外层 + `externalSandbox` | 0      | 成功       | 拒绝       | 成功           | 拒绝     |
| Cognia 单次 OS tool Bash        | 0      | 成功       | 拒绝       | 成功           | 拒绝     |

- V2 在 `build-options.test.ts` fixture 中用同一个普通项目比较 sandboxEnabled 的开和关。开时有 Bash deny、缺 `apply_patch` deny 且 `confinement` 为空。随后调用 `collectCogniaToolDefs`、`passesToolLists` 和 `createAnthropicCanUseTool`，在已授权的 fixture 中执行 `apply_patch`，成功创建工作区外标记。普通工具授权仍存在，实测区别是写入没经过选定的 OS sandbox。 [SendOptions](../../lib/claude/build-options.ts#L4037) · [sidecar 写入 handler](../../sidecar/src/tools/builtin/core-files/apply-patch.ts#L254)
- V3 复制 `container-exec-adapter.test.ts` fixture，将 placement 改为 `egress.tier: "on"`，保留 payload 的 `request.network: "off"`，验证 Host 调用是否被拒绝。实际调用了一次，参数保留 egress-on placement，未携带调用方的 network 请求。另一个探针在 `session-runtime.test.ts` fixture 中绑定显式 `policy.network: "off"`。先确认 `clampRequest` 将模型的 on 收窄为 off，之后真实适配器仍派发到 egress-on placement。由此区分了默认请求值和用户配置的上限。adapter 只转发 `command`。 [Session Runtime](../../lib/sandbox/session-runtime.ts#L658) · [容器适配器](../../lib/sandbox/container-exec-adapter.ts#L120)
- V4 区分进程路径和工具路径。进程策略确实传入 Host spawn，已路由时 wrapper 退出，项目容器的准备从 placement spec 求 egress。外部 Agent 自己的内层仍可能限制个别动作，不能据此推断整个容器进程接受同一个出网上限。 [进程 Host](../../lib/ai/agent/external/host/process-host.ts#L65) · [launcher 分支](../../crates/cognia-external-agent/src/sandbox.rs#L1175) · [本地容器准入](../../crates/cognia-sandbox-pool/src/docker.rs#L1345) · [远程准备](../../crates/cognia-sandbox-pool/src/docker/remote_prep.rs#L631)
- V6 使用 `pnpm test -- --runInBand --runTestsByPath` 执行 `packages/agent-codex/src/{app-server-client,config-requirements}.test.ts`、`cli/src/runtime/external/sandbox-launcher.test.ts`、`cli/src/runtime/sandbox/builtin-process-sandbox.test.ts` 和 `lib/sandbox/{environment-placement,run-environment,container-exec-adapter,runtime-availability}.test.ts`。使用 `node scripts/test/run-sidecar-tests.mjs` 执行 `sidecar/src/runtimes/claude-agent-sdk/{runtime-policy,sdk-options}.test.ts`。

## 缺口的处理顺序

1. 先处理实际权限扩大。收敛桌面 Host mutators 的路由，并在容器 admission 处对 per-call、Agent、项目和 Host 上限求交集。后端只支持环境级出网时，应对无法满足的请求给出明确拒绝。保持 Host 侧的敏感路径保护和工具审批。
2. 为 Codex 定义受控的原生模式与外层委托选择。外层能证明所需文件和网络约束时才适合委托。直接用 workspace 可写的外层替换 read-only 内层，会失去 read-only，已由 V1 的写入对照证明。
3. 在同一运行报告中关联 requested、admitted、effective，分别标注 Host、provider 与 vendor runtime 的文件、网络、凭证、审批和放置结果。现有 `placement-report` 与 Codex 管理策略的投影可作为输入。修正 Windows 同意状态和 launcher 能力的落差，再按平台做原生验收。 [Placement report](../../lib/sandbox/placement-report.ts#L64) · [Windows 授权 service](../../packages/agent-runtime-kit/src/lifecycle/service.ts#L622) · [Windows 单次执行器准入](../../crates/cognia-exec-sandbox/src/windows.rs#L236) · [外部进程 wrapper 准入](../../crates/cognia-external-agent/src/sandbox.rs#L1250)

## 2026-11-16 复核

> 帮我分析一下现在的snadbox的缺口，看看差什么功能，存在什么问题

本轮把 sandbox 理解为 Cognia 的 Agent/工具执行、项目运行环境、Computer Use 桌面，以及插件和 Canvas/Artifact 的隔离边界。跟踪顺序为会话或任务选择、策略收窄、Host 准入、实际后端、诊断。本轮仓库有并行改动。起始 HEAD 为 `5ff8b5b52b`，主要核对点为 `e4eaf4bf96` 加当时 worktree。HEAD 未必包含 worktree 中的网络策略修复。旧轮发现的 PTY 拦截、外部 launcher 出网上限和 macOS 显式读根仍有修复路径，验收范围见 V9–V13 和本轮 V20–V21。

### 当前问题与依据

| 优先级         | 发现                                                           | 证据与影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0，构建       | Rust 代理处理器存在悬空的 match arm。                          | V20。当前源码无法构建执行器或验证同一构建产物。[拨号分支](../../crates/cognia-exec-sandbox/src/net_proxy.rs#L934)                                                                                                                                                                                                                                                                                                                                                                                        |
| P1，可用性     | Headless container 绑定成功后，离线检查抛出 `ReferenceError`。 | V14。SendOptions 会记录 unplaced，聊天仍能发送，容器工具随后拒绝执行。[适配器](../../lib/sandbox/container-exec-adapter.ts#L99) · [SendOptions](../../lib/claude/build-options.ts#L4080)                                                                                                                                                                                                                                                                                                                 |
| P1，权限       | 任务容器静默丢弃细粒度文件和资源限制。                         | V15。整个项目 workspace 仍是 mount 输入。CPU 和内存来自环境 size class，工具指定的 CPU 秒数、内存和子目录策略未到执行层。可以确认境内边界变宽的路径，未实测 guest 对同一项目兄弟目录的写入。[RPC](../../lib/sandbox/container-exec-adapter.ts#L147) · [Host 请求](../../crates/cognia-sandbox-pool/src/runtime.rs#L127) · [容器启动](../../crates/cognia-sandbox-pool/src/docker.rs#L1592)                                                                                                               |
| P1，权限       | Canvas iframe 可以产生预期外网络请求。                         | V17。普通 fetch 被 CSP 阻止。iframe 自身导航可发送请求。带伪 head 的注释可使 CSP 落入注释，随后 fetch 真正发出。观测范围为 iframe 中的合成数据和回环服务器。MCP Apps、Artifact 与部分插件 Webview 共用注入组件，处理路径不同，各自需验证。[Canvas 入口](../../lib/native/code-execution-strategy.ts#L106) · [CSP 注入](../../lib/security/frame-csp.ts#L46) · [MCP Apps](../../lib/mcp/apps-sandbox.ts#L124)                                                                                             |
| P1，运行控制   | 容器命令开始后缺单次取消。                                     | V16。SDK 已把 signal 传到 runtime，该 tier 分支没传至执行器。Host 超时可发 kill。容器释放只移除闲置实例，无法替代单个运行的取消。[工具分派](../../plugins/cognia-sandboxed-tools/src/index.ts#L494) · [容器分支](../../lib/sandbox/session-runtime.ts#L790) · [Host 超时](../../crates/cognia-sandbox-pool/src/docker/task_shell.rs#L307)                                                                                                                                                                |
| P1，可用性     | Codex 原生与 Cognia 外层 Seatbelt 叠加仍失败。                 | V19。显式委托时实测可写，原生 read-only 则拦截同一写入。当前产品 client 仅投影原生三种模式。仅替换成委托会改变只读语义。[Codex client](../../packages/agent-codex/src/app-server-client.ts#L1286) · [App Server 协议](https://learn.chatgpt.com/docs/app-server#command-execution)                                                                                                                                                                                                                       |
| P1，条件性风险 | Kubernetes 的离线声明缺少数据面验证。                          | V18。控制面接受 NetworkPolicy 后，代码根据 mode 声称已实施。效果依赖 CNI、同 Pod 的其它策略和节点地址例外。普通 NetworkPolicy 模式无法对域名做 allowlist。Cilium 有域名策略，外部 Agent 的严格域名上限仍需要证明或拒绝。[Kubernetes 实现](../../crates/cognia-sandbox-pool/src/remote/kubernetes.rs#L815) · [远程准入](../../crates/cognia-sandbox-pool/src/docker/remote_prep.rs#L630) · [Kubernetes 官方文档](https://kubernetes.io/docs/concepts/services-networking/network-policies/#prerequisites) |

### 功能边界

| 使用入口                           | 已有能力和缺口                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS / Linux 本地                 | Seatbelt 与 bwrap 单次工具及外部 launcher。Linux allowlist 是隔离 netns 加过滤代理，需要能建立命名空间、桥和握手。代理支持 HTTP/CONNECT，缺原生 TCP、UDP、DNS 出网能力。macOS 单次工具可因配置明确收窄读根，当前 Rust 构建阻断本轮新产物的复验。[OS backend](../content/docs/en/subsystems/sandbox/os-backends.mdx)                                                                                                                                |
| Windows / WSL2                     | 原生 runner 有 restricted token、low integrity 和 Job Object。原生文件根、关网和本地外部 Agent wrapper 仍缺。已识别到不可实施的严格请求会拒绝。WSL2 单列验收。[Windows runner](../../crates/cognia-exec-sandbox/src/windows.rs#L232) · [外部进程](../content/docs/en/subsystems/sandbox/os-backends.mdx#external-agent-process-policy)                                                                                                             |
| Headless Docker / Kubernetes / E2B | 外部 Agent placement 支持本地与远程 provider。内置 `container` 工具路径只支持本地 Docker，远程 provider 在 Host task-shell 层拒绝。Local Docker 有冷文件快照和 fork，E2B 声明同实例暂停/恢复与内存恢复，缺文件快照和 fork。Kubernetes 在当前 Host 合同没有对应快照能力。[Task shell](../../crates/cognia-sandbox-pool/src/docker/task_shell.rs#L153) · [Snapshots](../content/docs/en/subsystems/sandbox/snapshots.mdx#providers-and-verification) |
| E2B 工具 microVM                   | 绑定已有 E2B workspace。普通本地会话无法凭这个 tier 自动得到一个 VM。这个适配器拒绝严格域名规则及配置的每次 CPU/内存限制，网络 on/off 在实例创建时决定。与项目 E2B provider 不同。[绑定](../../lib/claude/build-options.ts#L4071) · [E2B 工具适配器](../../plugins/e2b-sandbox/src/microvm-exec.ts#L250)                                                                                                                                           |
| Computer Use                       | Docker 桌面有 GUI、生命周期和条件式文件/执行能力。托管 E2B 的 agent GUI 和工作区操作依赖授权和资格。Lume 依赖对应 macOS Host 和 versioned contract。通用 CUA 云记录没有同等操作矩阵。[能力解析](../../lib/sandbox/connection-capabilities.ts#L67) · [Lume 审计](2026-10-23-lume-sandbox-integration.md)                                                                                                                                            |
| 浏览器和移动端                     | JS、HTML、CSS 在浏览器 iframe 执行，Canvas Python 在桌面才有运行器。其余跨壳沙箱能力取决于可用的绑定 Host 或 provider。[执行语言能力](../../lib/native/code-execution-strategy.ts#L254)                                                                                                                                                                                                                                                            |
| 安全诊断                           | 已有 runtime availability、placement 报告和 sandbox audit。OS 的有效网络证据较细，容器审计当前主要记录 tier、provider 与终止状态。文件根、资源、出网机制、实际后端及 fallback 理由需要在同一运行视图关联。[Placement](../../lib/sandbox/placement-report.ts#L64) · [容器审计](../../lib/sandbox/session-runtime.ts#L1241)                                                                                                                          |

### 重现与验证范围

- 常规 `pnpm test` 在自动 `postinstall` 失败，原因是 sidecar linked-package 检查发现 `agent-capability-grant`、`agent-composition` 的 Node 入口指向源码。已用同一个项目 Jest wrapper `node scripts/test/jest.mjs --runInBand --runTestsByPath` 执行，主范围 10 suites 中 9 通过、1 失败，550 通过、1 失败、1 跳过。
- [容器 RPC 和取消探针](../../.cache/sandbox-audit-2026-11-16/container-contract-probe.test.ts) 的 2 个断言复现当前行为，Host 为 fixture。临时 Jest 入口已移除。复跑时将探针临时链接到 `lib/sandbox/`，用 `--runTestsByPath`，完成后移除该链接。
- [Canvas 浏览器探针](../../.cache/sandbox-audit-2026-11-16/canvas-iframe.mjs) 使用仓库 Playwright 与本机 Chrome，运行实际 TS 源和共享 CSP 注入，页面及两个命中 URL 均为临时 127.0.0.1。Chrome 只收到 `self-navigation`、`comment-fetch`。相邻既有 Jest 测试 5 suites、81 passed。
- [Codex Seatbelt 探针](../../.cache/sandbox-audit-2026-11-16/codex-seatbelt.mjs) 需要 `codex` 和现有 `target/debug/cognia-external-agent-launcher` 两个路径参数。未用账号、模型回合或生产 workspace。当前 Rust crate 构建失败，所以该探针只证明现有二进制上的行为。
- `docker info --format '{{.ServerVersion}}'` 报 daemon socket 不可达。Kubernetes/Cilium、E2B、Lume、Linux/WSL2、Windows、Tauri/Capacitor 和真实模型仍待验收。

建议按依赖顺序恢复 Rust 构建和离线容器绑定，修复容器丢限、Canvas 出网和单次取消，以统一的真实运行矩阵验证安全边界。随后处理 Codex 原生权限到外层委托的等价性和各 provider 的适用能力。仓库变更仅限本证据记录。

## 2026-11-16 二次代码复核

复核开始时 HEAD 为 `24e6253773`，检查期间共享 checkout 前移到 `fb961a40e7`。Rust `cargo check --locked --offline -p cognia-exec-sandbox --lib` 仍在同一位置失败。新增 loopback 分支的提交 `5ff8b5b52b` 删除了非 loopback 路径的 `match dial_any(...)` 起始段，以及其成功和超时分支，留下单独的 `Err(DialFailure::Refused) =>`。恢复时需保留按过滤后的 IP 拨号与 502/504 区分。[代理分支](../../crates/cognia-exec-sandbox/src/net_proxy.rs#L934)

`egressOff` 回归来自当前 worktree。改成 `egressTier` 并且在执行结果中使用了新 helper，绑定后的判定仍旧调用旧名字。Host RPC 有 service-only 和多租户准入，还会核对 cwd 的原始路径和规范化路径，但字段没有 per-call 文件、CPU 和内存限制。Host 已有命令超时对应的单次 session signal，可以作为补取消的执行接点。[适配器](../../lib/sandbox/container-exec-adapter.ts#L68) · [Host RPC](../../crates/cognia-companion-rpc/src/rpc/service_plane.rs#L1197) · [Host 终止](../../crates/cognia-sandbox-pool/src/docker/persistent.rs#L185)

- **桌面资源校验也有独立缺口。** Docker CUA 和 E2B 托管桌面的 `workspaceExec` 调用同一套判定，只要求机器存在正数 CPU 和内存配置。2 CPU 和 2048 MiB 都被当作满足 1 CPU 秒与 16 MiB。调用通过后两个执行入口都没有带资源策略。验证范围是校验和源码，不含运行中资源消耗。[判定](../../lib/sandbox/docker-policy-attestation.ts#L110) · [Docker 执行](../../lib/sandbox/docker-adapter.ts#L198) · [E2B 执行](../../lib/sandbox/e2b-adapter.ts#L96)
- **容器清理重试会丢失失败 ID。** 容器 adapter 先删 binding 再派发清理。Host 报错后，session runtime 保留清理记录以便重试，但 adapter 的 binding 已消失。实测第二次返回成功且未重发 Host RPC。Host 的空闲回收仍有独立路径。[适配器](../../lib/sandbox/container-exec-adapter.ts#L76) · [上层重试](../../lib/sandbox/session-runtime.ts#L1140)
- **MCP Apps 的双 iframe 行为与 Canvas 不同。** Chrome 147.0.7727.56 下，伪 head 仍能吞掉内层 CSP，但继承的外层 `default-src 'none'` 阻止该 fetch。同样，明确批准并写进内层 `connect-src` 的回环 origin 也被外层拦截。这个探针只证明当前 Chrome 的实际 fetch 结果，Artifact 和原生 WebView 仍待单独验证。[MCP 外层](../../lib/mcp/apps-sandbox.ts#L85) · [生产分派](../../components/mcp-apps/mcp-app-frame.tsx#L148)

本轮 Jest 共 6 suites，5 通过、1 失败，70 项通过、1 项失败。失败仍为 `egressOff`。新增的两个断言用于复现桌面校验与清理重试，Host 使用 fixture。浏览器运行真实双 iframe 和 CSP，未启动完整应用。可用本地 [TS 探针](../../.cache/sandbox-audit-2026-11-16/second-pass-contract-probe.test.ts) 与 [MCP 双 iframe 探针](../../.cache/sandbox-audit-2026-11-16/mcp-iframe.mjs) 重现。
