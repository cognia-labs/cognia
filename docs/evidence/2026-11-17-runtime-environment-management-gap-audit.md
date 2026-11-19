# Evidence ledger: runtime environment management gap audit

- Status: verifying
- Lane: deep
- Created: 2026-11-17
- Updated: 2026-11-17
- Related: ADR-0147, ADR-0182, ADR-0183, ADR-0221, ADR-0224; [bounded probes](./2026-11-17-runtime-environment-management-gap-audit.probes.mjs)

## 审计结论

截至 2026-11-17，Cognia 已有较完整的运行环境底座。对抗审查后，最高优先级是 **setup 和管理操作绑定固定 Host、初始化的并发与崩溃恢复、Windows 子进程及输出管道的有界收尾**。构建产物远程交付、目标容器内 setup 和跨端管理是后续能力增量。建议先修正确性，再扩展环境种类。

本轮范围是项目环境、镜像目录、Dev Containers 构建、Docker/Kubernetes/E2B placement 及管理入口。云电脑和常驻 Host 的系统级问题已有 [另一份审计](./2026-11-17-cloud-desktop-and-always-on-host-gap-audit.md)，本报告只处理与项目运行环境直接相连的部分。证据来自当前共享工作树；工作树含大量并发变更，不能等同于已发布版本或线上配置。

**证据等级：**“已复现”指加载真实 executor/setup-reuse，替换文件、数据库和 transport I/O 后的确定性行为；“源码确认”指完整读到对应控制路径；“待验证”不作为已发生的生产事故。本轮没有执行安装脚本、访问真实密钥或创建云资源，也没有修改业务源码。

## 已有能力与实际边界

| 能力                       | 当前状态与证据                                                                                                                                                                                                                                                    | 仍需区分的边界                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 多项目环境定义             | setup、actions、OS 覆盖、普通变量、keyring 引用、启用及默认环境；[类型](../../packages/plugin-contract/src/types/project-environment.ts#L165)、[管理器](../../components/settings/project-environment-manager.tsx#L463)。                                         | 定义和初始化记录属于设备端数据；不等于目标实例的就绪证明。                                              |
| 仓库即配置与信任           | `.cognia/workspace.json`、JSONC devcontainer、声明摘要及批准；[解析](../../lib/project-environment/devcontainer.ts#L1)、[解析优先级与批准](../../lib/project-environment/resolve-environment-spec.ts#L350)。                                                      | 是明确限制的子集；不能按完整 VS Code Dev Containers 兼容性宣传。                                        |
| 镜像目录与准入             | baseline/tenant 分层、registry allowlist、digest pin、隔离与规格下限、批准撤销；[目录模型](../../crates/cognia-environment/src/catalog.rs#L77)、[准入](../../crates/cognia-environment/src/policy.rs)。                                                           | 不可变 digest 证明镜像身份；软件清单、漏洞状态和可用能力还需独立证明。                                  |
| Dockerfile / Features 构建 | 已接官方 CLI，使用 Git 提交快照、Feature lock、并发上限、超时、取消、构建记录及元数据合并；[构建服务](../../crates/cognia-sandbox-pool/src/build.rs#L200)、[Host 接线](../../crates/cognia-companion/src/environment_pool.rs#L56)。                               | 需要运维配置 CLI 路径及版本；构建结果是本地 Docker image ID。旧 ADR 的“build dormant”描述已落后于源码。 |
| 多 provider placement      | local、指定 provider、auto，Docker/Kubernetes/E2B 共用驱动协议；[provider set](../../crates/cognia-sandbox-pool/src/providers/set.rs#L1)、[运行选择](../../lib/sandbox/run-environment.ts#L290)。                                                                 | 可选择 provider 不代表该 provider 支持所有图片、网络或 snapshot 能力。                                  |
| 基础可靠性与回收           | remote 并发上限、最大寿命、idle timeout、会话租约、重启后的 orphan 对账；[限制](../../crates/cognia-sandbox-pool/src/remote/mod.rs#L45)、[对账及测试](../../crates/cognia-sandbox-pool/src/docker/remote_prep.rs#L2974)。                                         | 已有回收，不能列为完全缺失；跨 Host/供应商账户容量和费用视图仍需补齐。                                  |
| 快照与保留语义             | 本地有 filesystem checkpoint/fork；remote 按 provider 声明收窄 pause/memory resume；[能力](../../crates/cognia-sandbox-pool/src/docker/snapshots.rs#L250)、[E2B](../../crates/cognia-sandbox-pool/src/remote/e2b/mod.rs#L810)。                                   | Docker 冷快照不等于内存恢复；remote checkpoint/fork 仍拒绝。不要统一显示为同一种“恢复”。                |
| 网络与凭据边界             | 有 Host 准入、egress enforcement 判定和 mandatory/multi-tenant 拒绝；setup 密钥留在 Host 解析并脱敏。[远程准入](../../crates/cognia-sandbox-pool/src/docker/remote_prep.rs#L645)、[输出脱敏](../../crates/cognia-companion-rpc/src/project_environment.rs#L496)。 | 桌面本地容器使用用户自身凭据是已声明例外；本报告没有证明真实 provider 的隔离边界。                      |
| 初始化优化与修复           | 有 setup inputs fingerprint、outputs 存在检查、同请求合并、mise 安全安装及可选 bootstrap Agent/readiness checks；[executor](../../lib/project-environment/executor.ts#L103)、[类型](../../packages/plugin-contract/src/types/project-environment.ts#L92)。        | 普通 setup 成功主要依据退出码；bootstrap checks 也需要针对正确实例执行。                                |

## 优先处理的问题

### F1 · P1 · lockfile 已变化的自动请求仍会加入旧 setup（控制逻辑已复现）

适用条件：普通 setup、bootstrap disabled，第二请求为 `force:false`；chat/scheduler 的正常调用满足这一条件。`runSetupCoalesced` 先比较 setup definition signature，匹配就直接返回 `joined:true`；普通 `setupReuse.inputs` 的内容在进入 `runSetupOnce` 后才计算。因此第一轮根据 lockfile v1 计算 fingerprint 后，lockfile 改成 v2，第二个请求仍可拿到第一轮的成功。探针得到一条 mocked transport 请求、第二轮 `success:true, joined:true`。mock installer 没有读取 lockfile，不能据此声称真实安装器一定消费了 v1。

证据：[join 路径](../../lib/project-environment/executor.ts#L209)、[稍后计算 fingerprint](../../lib/project-environment/executor.ts#L259)、[探针](./2026-11-17-runtime-environment-management-gap-audit.probes.mjs)。这里复现的是请求身份比较缺陷；未在真实包管理器中测量安装结果。

反证：手动 Run setup 使用 `force:true`，会等待后重新执行；bootstrap 不 join，也不直接跳过新 readiness。后续第三个独立普通请求会重新计算 fingerprint，并能检测 v2，缺陷不是永久缓存失效。force 与第三请求两个保护性反例均已加入探针；bootstrap 保护由既有源码及测试支持。

建议：等待在途操作结束后重读输入，并按内容身份判断是否仍可复用；setup 期间输入变化时，不应给新请求签发旧就绪结果。验收：运行中修改 lockfile，第二轮必须重新检查或执行，且最终记录绑定 v2；同时保留 force 每次运行、bootstrap 新检查、failed/bypassed 不共享、mise digest 参与身份的已有保护。[真实自动调用](../../hooks/chat/agent-chat-send.ts#L3618) · [scheduler](../../lib/scheduler/executors/index.ts#L946)

### F2 · P1 · 中断的普通 setup 不会撤销更早的成功证明（控制逻辑已复现）

适用条件：ordinary setup reuse 已启用、bootstrap disabled、历史 fingerprint 匹配、outputs 仍存在，后续请求未 force。执行前会写入 `running`，但 `latestSetupRecord` 过滤掉所有 running，只在已结束记录中选最新。此前成功过、随后强制安装运行到一半崩溃时，上述条件下自动请求可以跳过 setup。探针构造“成功记录 + 更新的 running 记录”，实际返回 `reused:true`；并未执行真实崩溃。真实 DB 会追加 running 并保留旧成功，合成历史的结构与写入模型一致。[DB 写入](../../lib/db/project-environments.ts#L88)

证据：[写 running](../../lib/project-environment/executor.ts#L347)、[忽略 running](../../lib/project-environment/setup-reuse.ts#L200)。正常 failed/bypassed 会阻止复用，这是已有保护；缺口是未结束尝试的恢复。本轮没有杀死真实安装进程。

建议：执行尝试绑定 Host/进程代际或租约；失主的 running 先转为 interrupted/unknown，并使旧 ready 失效。验收：在安装中途终止、重开应用，必须重新验证依赖，不能凭目录存在恢复为就绪。

### F3 · P1 · 同目录不同 profile 不受当前 setup 锁串行（控制逻辑已复现）

flight key 是 `environment.id + scope + 原始 executionRoot`，Map 又只存在当前 JS 模块。同一目录换环境 ID 就不会串行。探针在第一轮未结束时启动另一 profile，观测到两个 mocked `transport.call` promise 重叠；没有 native IPC 或真实 installer 运行。Host shell 分支未提供目录级安装锁，支持实际重叠风险判断。不同 scope、路径别名以及多个窗口/进程也属于需要覆盖的边界；跨窗口/进程本轮未做实机复现。

证据：[key 和 Map](../../lib/project-environment/executor.ts#L195)。已有保护只覆盖相同 environment/scope/路径字符串，并不构成目录级互斥。

建议：在实际执行的 Host 端以规范化 workspace identity 管理锁和尝试记录，profile/fingerprint 是锁内的请求身份。验收：两个 profile、两个窗口和同目录别名并发触发，installer 最大并发始终为 1；取消后不能出现失主安装进程。

### F4 · P2 能力增量 · Host setup 与 runtime initialization 明确分离

手动 Run setup/Run action 使用 `project_environment_execute`，参数没有 runtime/provider/placement；Host 最终运行自己的 shell 或 OS sandbox。因此选择 Python 容器或远程 E2B 后，这里的安装成功不能证明包已安装到所选 runtime。探针确认所选 provider 不进入该 RPC。

证据：[管理器调用](../../components/settings/project-environment-manager.tsx#L533)、[executor payload](../../lib/project-environment/executor.ts#L417)、[Host 执行分支](../../crates/cognia-companion-rpc/src/project_environment.rs#L434)。当前[文案](../../i18n/messages/en/projectEnvironment.json#L13)明确称其为 local setup，runtime 文案明确描述 external agents 的镜像选择。对抗审查未发现把这里的 Host success 消费为目标容器 ready certificate 的调用面。**因此这是符合现有合同的分阶段执行，不构成已证实的错误执行或 sandbox escape，移出 P1 缺陷队列。** devcontainer lifecycle 已提供另一条目标初始化路径。

建议：显式区分 Host preparation 与 runtime initialization，并让目标内 setup/actions/checks 共享同一不可变 placement。展示实际 Host、provider、实例代际、image/bundle digest 和检查时点。验收：只在目标容器创建的依赖与标记才能使该目标 ready；Host 的成功不能替代目标成功。

### F5 · P2 · 排障入口缺少持续日志与 setup 取消（源码确认）

executor 返回 stdout/stderr，但管理器只显示通用成功或错误摘要；setup 请求没有 operation ID/AbortSignal，也没有对应取消动作。命令等待配置了超时，但这不能证明整个过程和输出收尾有界；Windows 缺陷见 F8。构建服务已有 cancel，应避免把两者混为一谈。

证据：[输出返回](../../lib/project-environment/executor.ts#L460)、[UI 消费](../../components/settings/project-environment-manager.tsx#L555)、[按钮](../../components/settings/project-environment-manager.tsx#L1115)。建议复用现有进程管理能力，提供脱敏分步日志、超时/截断标识、服务端取消回执及清理结果。验收：安装挂起时能取消整个进程组，重开页面仍能查看最终状态。

### F6 · P2 · 本地 build 到远程运行之间缺少产物发布链路（源码确认）

构建成功保存的是 Docker image ID；remote preparation 需要 registry image，并对本地构建直接拒绝 `sandbox_image_not_remote`。用户完成构建、批准、选择远程 provider 后，仍不能直接运行这个产物。

证据：[产物](../../crates/cognia-sandbox-pool/src/build.rs#L693)、[远程拒绝](../../crates/cognia-sandbox-pool/src/docker/remote_prep.rs#L657)。这是明确支持边界；已有手工 registry 镜像目录不等于自动发布。

建议：增加 build → push → registry manifest digest → scan/attestation → catalog/approval → provider 的链路，或提供受控远程 builder。验收：在新 Host 上不依赖原 Docker daemon，用同一 registry digest 拉取并启动；批准显示实际发布的产物与平台。

### F7 · P1 · setup 成功历史与在途请求缺少 Host 身份（源码确认 + 合成上下文复现）

同一设备从配对 Host A 切到 B，两端具有同样的 `executionRoot`、输入内容及 outputs 路径时，A 的成功可以令 B 的自动 setup 返回 `reused:true`。signature 没有 Host/OS/执行代际；历史只匹配 root/scope，flight key 只包含 profile/scope/root。而 workspace 文件和 setup transport 在调用时选择当前 Host。

证据：[signature](../../lib/project-environment/setup-reuse.ts#L132)、[历史](../../lib/project-environment/setup-reuse.ts#L192)、[flight key](../../lib/project-environment/executor.ts#L197)、[Host 选择](../../lib/tauri/transport-routing.ts#L213)、[workspace 文件路由](../../lib/files/workspace-fs.ts#L1)。探针只模拟 A/B 上下文和相同文件结果，得到 B `reused:true` 且零 setup transport 请求；不是双 Host 实机证据。手动 force 和 bootstrap 的反证继续成立。

更进一步，mise、输入探测及普通 setup 分别调用 transport，执行中切 Host 可将一次操作分到不同 Host；这条分段执行路径尚未做真实复现。建议从文件/信任读取到 fingerprint、join、脚本、日志和历史都绑定固定 Host 与实例代际，而不是只给缓存 key 加一段当前 Host。验收包括 A/B 同路径不共享成功、执行中切 Host 后旧操作继续控制原 Host 或明确拒绝。

### F8 · P1 · Windows Host setup 的子进程与输出收尾可能超出 timeout（源码确认，待 Windows 验收）

本地非 OS-sandbox 路径给 shell leader 设置 `wait_timeout`，超时后 kill/wait leader，再同步 join stdout/stderr reader。调用的 `kill_process_group` 在 Windows 是 no-op。若 installer 子孙进程继承了输出管道，leader 被杀后它仍可能运行，reader 会继续等待 EOF，整个 setup 不受原 timeout 约束。正常 leader 退出后仍有后台子进程持管道时，也存在同类路径。

证据：[shell 等待与 reader join](../../crates/cognia-companion-rpc/src/shell.rs#L119)、[Windows no-op](../../crates/cognia-exec-sandbox/src/proc_group.rs#L32)。Unix 有进程组清理；构建服务另有 Windows taskkill 分支，不能用它为 setup 路径背书。本轮运行于 macOS，没有执行 Windows 复现，不能宣称已测得无限等待或 orphan。

建议使用 Job Object 或等价的树级生命周期控制，并给终止、死亡确认及管道收尾设置整体预算。验收：Windows 中运行持有 stdout/stderr 的孙进程，在 timeout 或 leader 提前退出后，setup 都有明确终态，并证实后代不再写 workspace。

### F9 · P2 · 管理面板切 Host 后可能保留旧状态并操作新 Host（源码确认）

runtime hook 的 reload 依赖 project/root/commit，没有订阅 Host 身份；repository coordinates 的 effect 只依赖 root。面板仍挂载、A→B 的路径和 props 未变时，A 的 catalog、declaration、approval 或 build 可留在 state，后续 build/poll/cancel/approve 调用却使用当前全局 transport。两个挂载入口没有按 Host 设置 key；能力保持可用时 CapabilityGate 不会自动重新挂载。

证据：[reload effect](../../hooks/sandbox/use-project-runtime-environment.ts#L291)、[coordinates](../../components/settings/project-environment-runtime.tsx#L128)、[build poll/cancel](../../hooks/sandbox/use-project-runtime-environment.ts#L422)、[approve](../../hooks/sandbox/use-project-runtime-environment.ts#L475)。Host 权限、workspace 及 build identity 检查会拒绝部分错误请求，不能因此推论批准绕过；仍有旧状态与操作目标不一致、job not found 或原 Host 作业失去控制的路径。

建议将缓存、异步响应 epoch 和管理动作按 Host 归属；切 Host 清空状态并重载，原有 job 的 poll/cancel 固定原 Host。验收：两个配对 Host、同路径切换、延迟响应和构建在途时，页面不显示错误 ready，不向错误 Host 发起管理动作。

## 2026-11-17 对抗审查与裁决

两名独立上下文 reviewer 分别检查 setup 结论/探针和环境管理范围/遗漏；主会话逐项复核源码并补充反例。用户明确选择跳过额外 CLI 审查，本轮未调用外部模型 CLI。

| 审查意见                                               | 裁决               | 报告变化                                                          |
| ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------- |
| F1/F2 未明确 force、reuse、bootstrap 适用条件          | 有效，可执行修订   | 收窄到普通自动 setup；补充手动 force 与 bootstrap 已有保护。      |
| F1/F3 把 mocked transport 描述为 native/installer 重叠 | 有效，证据措辞错误 | 明确是控制逻辑复现，真实 installer 结果未测量。                   |
| F1 可能被理解为永久 stale cache                        | 有效，需补反证     | 第三次请求重新 hash 并运行的保护性探针通过。                      |
| F4 属明确设计边界，缺少 P1 违反合同证据                | 有效，原优先级过高 | 调整为 P2 产品能力增量；不将不同执行目标本身视为缺陷。            |
| 未覆盖 Host 身份、管理切换及 Windows 收尾              | 有效，遗漏         | 新增 F7/F8/F9；分别记录合成验证与真实环境缺口。                   |
| F6 可能已有自动发布链路                                | 未找到反证         | 保留 F6；手动 registry catalog、Git publish 不能替代 image push。 |

原样重跑环境编辑器 suite 仍为 34 passed / 2 failed。诊断只改 Testing Library 失败打印器，两个失败都显示 keyring 校验错误。进一步只在临时测试层把对 Radix trigger 的 `fireEvent.change` 改成真实 option 的键盘选择，**原断言不变，两项均通过（其余 34 skipped）**。原因是当前 NativeSelect 桌面分支把 label/id 给 button，真正 select 是隐藏 mirror；旧测试 change 了 button，未走选项选择。[当前控件](../../components/ui/native-select.tsx#L105) · [原测试](../../components/settings/project-environment-manager.test.tsx#L390)

该反例支持“测试交互过时”，不支持真实 provider 保存或认证失效。原样 suite 尚未修复，不能改报全绿；也没有真实浏览器保存验收。诊断与交互适配仅位于 `.cache/runtime-environment-audit/trace-save-validation.cjs` 和 `trace-select-interactions.cjs`，未修改测试源文件或断言。对应日志是 `adversarial-validation-trace.log`、`adversarial-picker-countercheck.log`。首次尝试 spy 只因模块导出不可重定义而失败，未作为产品证据使用。

修订后的 probe 共七项结果：五项现象（其中 F4 是设计边界）和 force/后续请求两项保护性反例，全部通过；输出 `adversarial-probes.json`。定向重新运行 `executor.test.ts` 与 `setup-reuse.test.ts` 为 **2 suites / 78 tests 全通过**。这说明现有测试仍未覆盖全部发现，不代表缺陷已修复。两个 reviewer 对修订稿做第二轮检查，没有新的实质发现；最后对齐了推荐表的 F7/F8/F9 与 F4 归类，满足停止条件。

## 尚缺的产品能力及业内对照

以下是能力建议，不表示所有项都应立即实现，也不表示已有底层机制完全不存在。

| 能力                           | 当前差距                                                                                                                                                                       | 业内实践与适合 Cognia 的增量                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 独立的 ready 状态与一键诊断    | 镜像 probe、driver reachable、spec preview、setup 结果分别存在；没有在这些入口中看到统一的“这个任务现在能否在这个实例运行”诊断。普通 reuse 仅检查 outputs 存在。               | Kubernetes 区分 startup/readiness/liveness；Coder health 给错误码及处置步骤。Cognia 应组合权限、provider、镜像/架构、bundle、网络/依赖源、runtime checks，保留检查时间和实例身份。[S3](https://kubernetes.io/docs/concepts/workloads/pods/probes/) [S4](https://coder.com/docs/admin/monitoring/health-check)                                                                                                      |
| 项目预构建与可认领的 warm pool | 当前有 on-demand image build 和已有实例复用，尚未在上述构建服务及 UI 中发现按分支/配置维护预构建、自动失效及 ready 池控制器；两者不能等同。                                    | Codespaces 将预构建绑定仓库/分支/devcontainer 并在 push/配置变化时更新；Coder 维护目标数量、认领、TTL。先做内容寻址预构建和显式命中原因，再按冷启动数据决定 warm pool。[S1](https://docs.github.com/en/codespaces/prebuilding-your-codespaces/about-github-codespaces-prebuilds) [S2](https://coder.com/docs/admin/templates/extending-templates/prebuilt-workspaces)                                              |
| 可恢复的构建作业               | 活跃 jobs 在内存 HashMap；只有成功产物入库。面板卸载会请求取消其构建。                                                                                                         | 参考 Codespaces 的可重开查看的工作流状态与日志；Cognia 需要持久化 job/attempt、启动对账、可追踪取消，明确关闭页面是否意味着停止构建。[构建状态](../../crates/cognia-sandbox-pool/src/build.rs#L200) [页面生命周期](../../hooks/sandbox/use-project-runtime-environment.ts#L162) [S5](https://docs.github.com/en/codespaces/prebuilding-your-codespaces/managing-prebuilds)                                         |
| 受维护的预装环境与软件清单     | 镜像目录已支持标签、digest、规格、来源及撤销，但缺少在目录/准入模型内标准化的软件版本清单、验证时间、CVE/签名处置状态和升级差异。`provenance` 是可选通用值，尚非可信证明策略。 | BuildKit 的 SBOM/provenance 记录内容及来源。沿用已有发布/扫描设施，将验证结果关联到 image digest；提供 Node/Python/Rust 等经过资格验证的目录项，不让用户凭镜像名称猜工具版本。[目录](../../crates/cognia-environment/src/catalog.rs#L77) [S6](https://docs.docker.com/build/metadata/attestations/)                                                                                                                |
| 多端一致的管理能力矩阵         | 普通端口 open 受 `isTauri()` 限制；snapshot/preview 管理主要本地桌面可用，配对桌面有 shared-preview 子集，Web/移动端显示 dormant。                                             | Dev Containers 规范的转发端口面向 local/web。应按 Host+provider+客户端能力展示可执行操作；如要手机端完整管理，需要受鉴权 relay，而不是开放容器公网端口。[端口](../../hooks/sandbox/use-project-runtime-environment.ts#L346) [管理分支](../../components/settings/sandbox-management-panels.tsx#L70) [S7](https://raw.githubusercontent.com/devcontainers/spec/main/docs/specs/devcontainerjson-reference.md)       |
| 资源、成本与保留策略可见性     | 已有并发、idle TTL、最大寿命及 instances/sessions 计数；尚缺这一管理面中的 CPU/内存/磁盘压力、项目费用归因、跨 Host 配额、保留成本和用量告警。                                 | Coder 明确哪些连接/Agent activity 延长使用时间，区分活动超时与强制停止。Cognia 应展示预计回收时间、保留的内容、硬截止和计费来源；运行中的 Agent 不应因无人看页面而被误当闲置。[状态](../../crates/cognia-sandbox-pool/src/status.rs#L42) [限制](../../crates/cognia-sandbox-pool/src/remote/mod.rs#L45) [S8](https://coder.com/docs/user-guides/workspace-scheduling)                                              |
| 可共享的环境合同与凭据注入     | 仓库声明和 Host 批准可共享，但 project definition 是设备端；要重现环境仍需同时知道本地定义、Host baseline、bundle 和有效批准。                                                 | 输出不含 secret value 的 environment manifest，记录各层来源和 digest；凭据独立绑定 scope/目标/有效期，在运行时注入。Codespaces 将 secrets 限定到授权仓库，并将其与 Dockerfile/Feature 构建阶段分开。[模型](../../packages/plugin-contract/src/types/project-environment.ts#L165) [S9](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces) |
| 开发服务拓扑与兼容性说明       | Compose/mounts/privileged 等被拒绝；waitFor 等被忽略，GPU 不可选。多服务项目不能只靠单个 runtime 选项完成。                                                                    | Dev Containers 规范覆盖 Compose 和明确的 lifecycle 等待语义。Cognia 应先发布可机读兼容矩阵；若需要数据库/缓存，再设计隔离的 service dependencies、健康检查及网络。拒绝任意 host mount/privileged 是安全边界，不能为兼容性直接放开。[解析合同](../../lib/project-environment/devcontainer.ts#L1) [S7](https://raw.githubusercontent.com/devcontainers/spec/main/docs/specs/devcontainerjson-reference.md)           |

## 待验证项与不应放大的结论

1. **显式环境失效的选择语义。** [selection](../../lib/sandbox/run-environment.ts#L467) 在 preferred ID 不存在时选首个 enabled，禁用的显式环境则返回无 runtime/policy；[列表](../../lib/db/project-environments.ts#L71) 按 updatedAt 排序。存在静默换定义的路径，但 chat/scheduler 后续还有缺失环境拒绝，尚未证明所有调用面都能实际 spawn。建议逐入口验证后决定对显式 ID fail closed，不宣称已证实全局隔离绕过。
2. **能力承诺。** Host setup 的 [effective_policy](../../crates/cognia-companion-rpc/src/project_environment.rs#L216) 只将 required capabilities 中的 sandbox 转成执行策略。其他 capability 是否被各消费者充分校验需另行验证，不能把列表当作统一 readiness certificate。
3. **真实 provider 与发布配置。** 本轮没有验证 Docker daemon、Kubernetes cluster、E2B 实例或当前已安装 App。桌面缺 pinned bundle 会保持 remote sandboxes off，这是[已声明门槛](../../crates/cognia-sandbox-pool/src/desktop.rs#L9)，不能据当前源码推定用户发布包已启用或完全不可用。
4. **网络降级。** mandatory/multi-tenant 已拒绝不能落实 egress 的 provider；optional placement 的降级需按设计与 UI 提示评价。本轮没有证明 provider allowlist 的真实隔离效果。

## 推荐顺序与验收标准

| 顺序           | 范围                                                       | 完成标准                                                                                                                  |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1 · 正确性     | F1/F2/F3/F7/F8；固定 Host 与执行代际，保证整体收尾有界     | 变 lockfile 不误 join；崩溃后不复用旧 ready；同目录安装互斥；A/B 不共享成功证明；Windows 后代进程与输出管道在预算内收尾。 |
| 2 · 可操作性   | F5/F9、Host 归属的状态与操作、一键诊断、显式环境 ID        | 长任务有脱敏日志和可靠取消；切 Host 后清空/重载旧状态；原 job 的 poll/cancel 留在原 Host；不支持操作可提前解释。          |
| 3 · 可复现交付 | F4/F6、目标内初始化、预装目录、可恢复 build、环境 manifest | 新 Host 以同一产物摘要启动；关闭页面/重启后的 build 有可解释终态；镜像软件与验证状态可查；secret 不进入镜像/导出配置。    |
| 4 · 效率与规模 | 预构建/warm pool、资源成本、多服务扩展                     | 先记录冷/热启动 p50/p95、构建/初始化失败率及每成功任务资源消耗，再证明缓存/预构建带来改善；不能仅以“有缓存”验收。         |

## 验证记录（初审与复核）

- 初审四个隔离探针重现目标行为，原始输出 `.cache/runtime-environment-audit/probes.json`。对抗复核后当前脚本扩展为七项结果，见上述复核记录和 `adversarial-probes.json`；使用真实 TypeScript executor/setup-reuse，transport、文件、数据库为假边界。可重跑：`node docs/evidence/2026-11-17-runtime-environment-management-gap-audit.probes.mjs`。输出 `.cache/runtime-environment-audit/probes.json`。
- 使用仓库 Jest entry point 跑 10 个定向 suite：**9 passed / 1 failed；293 passed / 2 failed**。失败位于 `project-environment-manager.test.tsx` 的 provider 切换认证设置保存与本地无 API key provider 保存。单独重跑该 suite 为 **34 passed / 2 failed**，失败同样是预期 `putMock` 未调用。初审时根因未明；对抗复核已用不改变断言的键盘选项交互定位为过时测试事件目标。原样 suite 尚未修复，不能报全绿，也不能宣称真实 UI 已验收。
- 原始 `pnpm test` 被 pnpm 自动依赖检查引发的 postinstall 阻断：`@cognia/agent-config-types/agent-capability-grant`、`agent-composition` 的 Node exports 指到 TS source。随后用已确认的 `--config.verify-deps-before-run=false` 保留仓库测试入口运行。这不是关闭 Jest 检查；实际测试仍报告上述失败。相关共享依赖未作修复。
- 本轮没有运行 coverage、全仓 typecheck/lint/build、Rust 测试或 UI/真实 provider 验收。业务源码未改；这些结果不构成生产或跨平台认证。
- 审计脚本的 scoped ESLint、Prettier 和重新运行通过；台账 `check --final` 为 0 errors / 0 warnings。这里只验证审计制品，没有修复上述产品问题。

定向测试的实际命令（从仓库根执行）：

```sh
pnpm --config.verify-deps-before-run=false test --runInBand --runTestsByPath \
  lib/project-environment/executor.test.ts \
  lib/project-environment/setup-reuse.test.ts \
  lib/project-environment/resolve-environment-spec.test.ts \
  lib/project-environment/devcontainer.test.ts \
  lib/project-environment/runtime-selection.test.ts \
  lib/sandbox/run-environment.test.ts \
  lib/sandbox/environment-placement.test.ts \
  hooks/sandbox/use-project-runtime-environment.test.ts \
  components/settings/project-environment-runtime.test.tsx \
  components/settings/project-environment-manager.test.tsx
```

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 帮我分析一下现在的运行环境管理的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                                                                 | State     | Basis                                                                                                                                                          | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O1  | Runtime environment management spans repository declarations, project setup, host catalog/admission, execution placement and sandbox lifecycle.                           | Observed  | Source inventory and ADR-0147/0182/0183, 2026-11-17.                                                                                                           | -          |
| H1  | The initial prioritization grouped setup correctness with Host/runtime target integration.                                                                                | Contested | Adversarial review retained F1–F3 but found F4 follows explicit local-setup contract; revised priorities now include F7/F8.                                    | O1, O2     |
| H2  | Some apparent omissions are intentional provider or security boundaries, rather than implementation defects.                                                              | Verified  | F6 explicit remote image refusal; parser forbidden fields; snapshot capabilities; no real-provider certification claimed.                                      | O1, O3     |
| G1  | Deliver an evidence-backed audit of current capabilities, missing functions, concrete problems, industry comparisons and priorities.                                      | Agreed    | User request, 2026-11-17.                                                                                                                                      | -          |
| C1  | Audit only; preserve concurrent changes and avoid real resource creation, deletion or secret reads.                                                                       | Observed  | User requested analysis; heavily modified shared checkout at start.                                                                                            | -          |
| Q1  | Which provider and client combinations work in a real deployment?                                                                                                         | Open      | Source and headless checks cannot certify real Docker/Kubernetes/E2B or native/mobile flows.                                                                   | O1         |
| O2  | Ordinary non-bootstrap, unforced setup can join across changed input or reuse older success after unfinished setup; different profiles overlap mocked transport requests. | Verified  | Real executor/setup-reuse, mocked I/O; narrow scope and protective counterexamples in adversarial-probes.json, 2026-11-17.                                     | O1         |
| O3  | Builds/Features, provider TTL and orphan reconciliation already exist; local build artifacts are refused by remote preparation.                                           | Observed  | build.rs, remote/mod.rs and docker/remote_prep.rs; source review 2026-11-17.                                                                                   | O1         |
| O4  | Focused tests have two environment editor failures, while nine other suites pass.                                                                                         | Verified  | Ten suites: 293 passed, 2 failed; manager-only repeat: 34 passed, 2 failed. Exact names and scope above, 2026-11-17.                                           | O1         |
| O5  | Current official practices distinguish ready from live, preserve artifact identity, prebuild selected configurations and expose lifecycle/cost rules.                     | Observed  | S1–S9 primary sources read 2026-11-17; comparison table above.                                                                                                 | -          |
| Q2  | Why do the two environment editor saving assertions fail?                                                                                                                 | Answered  | Tests change the labeled Radix button rather than choose an option. Same assertions pass 2/2 with keyboard-option test interaction; raw suite remains failing. | O4         |
| O6  | Host identity is absent from setup signature/history; routing selects active Host at each call, and management state does not reload solely on Host switch.               | Observed  | F7/F9 source checks; F7 simulated context probe only; no paired-Host real run, 2026-11-17.                                                                     | O1         |
| O7  | Windows local non-sandbox setup has leader timeout but no tree cleanup or bounded output-reader join.                                                                     | Observed  | shell.rs:119–150 and proc_group.rs:32; F8 source-only, no Windows execution, 2026-11-17.                                                                       | O1         |
| H3  | Correctness priorities should include setup Host identity, ordinary reuse/concurrency and Windows bounded cleanup.                                                        | Verified  | Adversarial source review and scoped probes; prioritization remains a recommendation, not measured production incidence.                                       | O2, O6, O7 |

## Problem frame

Audit Cognia's project runtime environments and their setup, catalog, placement, lifecycle and management boundaries (G1). Success means a reviewable inventory and prioritized findings with owning-source evidence, reproducible checks when feasible, current primary-source comparisons, and explicit uncertainty. This is not an implementation or production certification task (C1). Cloud desktop/always-on host management is adjacent; its separate audit is not duplicated.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                      |
| ------------ | ------ | ------------------------------------------------------------------------------------------------ |
| scale        | high   | UI, IndexedDB, setup executor, Rust host authority, sandbox drivers and provider integrations.   |
| technical    | medium | Existing subsystem; provider lifecycle and reproducibility have nontrivial semantics.            |
| coupling     | high   | Browser/Tauri/Capacitor, paired Hosts and headless execution share contracts.                    |
| requirement  | low    | Read-only capability and defect audit; no product trade-off must be decided to inspect evidence. |
| verification | high   | Pure resolver checks are local; execution isolation and resource cleanup require real providers. |
| risk         | high   | Wrong execution target, secrets, approvals, filesystem mutation and resource cost.               |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                               | Severity | Source                                | Claim                                                                                                         | Refuted by                                                                                  |
| --- | --------------------------------------------------------------------------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| R1  | Wrong Host or readiness identity reported to user.                          | high     | ADR-0182; FMEA; independent reviewers | Each setup result binds its own Host/execution identity; runtime readiness requires target-specific evidence. | A setup result for A reused on B, or a Host setup result consumed as container readiness.   |
| R2  | Repository code crosses an unapproved authority or network boundary.        | high     | ADR-0147/0182; STRIDE                 | Trust and admission remain authoritative at execution.                                                        | Repository changes or provider routing bypass approval or execute on the Host unexpectedly. |
| R3  | Stale or failed resources become unusable or consume capacity indefinitely. | medium   | Coder lifecycle practices; FMEA       | Lifecycle has actionable state, reconciliation and recovery semantics.                                        | Orphans or stale-ready resources cannot be detected or repaired.                            |
| R4  | Audit mistakes planned capabilities for absent implementations.             | medium   | evidence-driven-dev risk catalog      | Findings follow owning code and independent counterexample review.                                            | Existing reachable behavior contradicts a claimed gap.                                      |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk           | Method                                                                                         | Independence   | Evidence                                                                                                                                                              | Coverage                                                                          | Status  |
| --- | -------------- | ---------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2         | Trace UI → resolver → admission → execution and management, including Host changes.            | self           | F1–F9 source review and explicit scope/counterevidence, 2026-11-17.                                                                                                   | Current checkout; F4 is an intentional boundary, not a demonstrated defect.       | passed  |
| V2  | R1, R4         | Run focused existing suites and bounded behavior probes.                                       | tool           | Four probes reproduced; Jest 9 suites passed, 1 failed, 293 tests passed, 2 failed; manager-only repeat also failed twice.                                            | Headless mocked boundaries; tests are not all green.                              | failed  |
| V3  | R1, R2, R3, R4 | Fresh-context failure hunt, source counterchecks.                                              | fresh-reviewer | Independent reviewer found setup identity/recovery/locking defects; root reproduced three and separately confirmed execution target split; preserved counterevidence. | Read-only source review and root probes; no real providers.                       | passed  |
| V4  | R3, R4         | Read current official Dev Containers, Codespaces, Coder and infrastructure guidance.           | tool           | S1–S9 official pages read 2026-11-17 and linked near claims.                                                                                                          | Practices are comparison inputs; feature parity is not required.                  | passed  |
| V5  | R1, R2, R3     | Real-provider and native/paired/mobile fault acceptance.                                       | real-env       | Not performed in audit: no provisioned test target.                                                                                                                   | Docker/Kubernetes/E2B and three client shells.                                    | blocked |
| V6  | R1, R4         | Adversarial counterexamples, Host-context probe and corrected picker-interaction countercheck. | tool           | Seven probe cases pass; picker countercheck retains assertions and passes 2/2; raw editor suite still 34/2.                                                           | Mocked I/O/context and Jest DOM only, no production provider/native acceptance.   | passed  |
| V7  | R1, R3         | Windows descendant/pipe timeout acceptance and paired A/B Host switching.                      | real-env       | Source defects F7/F8/F9 reviewed; no Windows or paired test target executed.                                                                                          | Actual process-tree death, cleanup budget and delayed Host operations unverified. | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                                                      | Action   | Based on                   | Reversal trigger                                                                     |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------- | ------------------------------------------------------------------------------------ |
| D1  | 2026-11-17 | Diagnose the current subsystem and compare practices before proposing implementation.                                                                                                                         | diagnose | O1, G1, C1                 | User narrows the product scope or new owning modules change the system model.        |
| D2  | 2026-11-17 | Deliver the audit with evidence and ordered acceptance criteria. Carry real-provider acceptance and failing editor tests; do not implement fixes in this task.                                                | diagnose | O1, O2, O3, O4, O5, G1, C1 | Production evidence contradicts source findings or fixes change the owning paths.    |
| D3  | 2026-11-17 | Re-enter risk discovery: narrow F1–F3 evidence, move F4 out of P1, add F7–F9 and preserve real-environment obligations. Two revised-artifact reviews reached stop conditions. User declined extra CLI review. | diagnose | O1, O2, O4, O6, O7, G1, C1 | Real paired/Windows results or owning-source changes contradict these scoped claims. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                                    | From       | Why still open                                                                           | Next action                                                                                                    | Status |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Actual Docker/Kubernetes/E2B isolation, cancellation, resource cleanup and native/paired/mobile behavior remain unverified. | V5, Q1     | No provisioned audit target used; no resource mutations authorized by analysis.          | Use disposable targets to run the acceptance matrix, including process/Host crashes and provider readback.     | open   |
| X2  | Two raw editor tests still use obsolete picker interaction; product saving failure is not established.                      | V2, Q2     | No source-test fixes in this audit; no real browser acceptance.                          | Update tests to select rendered options without weakening assertions; rerun original suite and real save flow. | open   |
| X3  | Explicit missing/disabled profile behavior may be guarded by later consumer checks; no global isolation bypass established. | R2         | Reachability varies by chat, scheduler and external spawn entry.                         | Validate each entry with missing and disabled explicit IDs; inspect actual spawn placement.                    | open   |
| X4  | Probe results do not measure real installer damage or production incidence.                                                 | R1, R3     | File/DB/transport I/O was mocked, bootstrap disabled; only decision logic was exercised. | Repeat lockfile change, interrupted reinstall and cross-window contention using disposable workspaces.         | open   |
| X5  | Windows process-tree/pipe boundedness and real paired-Host setup/management consistency are unverified.                     | V7, O6, O7 | macOS audit only; no actual Windows process or A/B Host manipulation.                    | Disposable Windows descendant test and paired-host delayed-operation fault matrix.                             | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                           | How / when measured                                              | Result                                                                                                               | Status |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | User can identify existing capabilities, confirmed defects, missing capabilities and next steps. | Evidence report plus two bounded adversarial cycles, 2026-11-17. | Nine F items with F4 downgraded, eight capability comparisons, seven probe cases and explicit residuals. Audit only. | met    |
