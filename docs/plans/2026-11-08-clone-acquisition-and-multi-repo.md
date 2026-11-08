# 大仓克隆获取与多仓处理：分阶段计划

状态：设计已在 2026-11-08 的 grilling 中与用户达成共识，尚未实施。创建：2026-11-08（Asia/Shanghai）。

上游：

- 证据账本：[`docs/evidence/2026-11-08-clone-acquisition-and-multi-repo.md`](../evidence/2026-11-08-clone-acquisition-and-multi-repo.md)。下文 O/H/R/V/D 编号均指这份账本。
- 前置审计：`docs/evidence/2026-11-08-cognia-multi-repo-development-audit.md`（多仓能力审计，只读结论）。
- 外部参考：Markone 克隆加速调研（基线 `3494d384ce`）。逐项取舍见账本 D4。
- ADR 修订：
  - [ADR-0176](../content/docs/en/adr/0176-every-clone-shares-one-object-cache.md)：获取预算、错误类别、sparse 前置、分段指标。
  - [ADR-0111](../content/docs/en/adr/0111-managed-workspace-registry-and-bundle.md)：bundle 布局。
  - [ADR-0147](../content/docs/en/adr/0147-repository-declared-workspace.md)：每根声明、跨仓 `dependsOn`、mise。
  - [ADR-0227](../content/docs/en/adr/0227-agent-changes-integrate-through-one-host-queue.md)：跨根集成与消费方验证。
  - ADR-0150 只加一行指向 ADR-0176 的修订。

## 0. 总览

两条轨道并行推进，共用 `cognia-git-mirror` 这一层。轨道内各阶段按顺序进行，轨道之间没有依赖。只有 B2 的布局改动会碰到 A2 也改的 `create_execution`，所以 **B2 要排在 A2 合入之后**（见 §3）。

| 阶段 | 内容                                                                            | 主要位置                                                                                                                            | 依赖                    |
| ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| A1   | 统一获取预算、可杀 runner、取消、错误分类与重试、分段指标                       | `crates/cognia-git-mirror`、`cognia-git`、`cognia-task-workspace`、`cognia-sandbox-pool`、`cognia-instrument`                       | 无                      |
| A2.0 | spike S1（sparse 前置与 overlay 的等价性）、S2（收窄补齐后的 promisor 链）      | 临时 worktree                                                                                                                       | A1 不阻塞               |
| A2   | sparse-before-checkout（worktree 与 mirror 派生），收窄 blob 补齐               | `service.rs`、`cognia-git-mirror/src/{lib,plan}.rs`                                                                                 | A2.0 通过               |
| A3   | 本地基准脚本，决定 `checkout.workers` 默认值                                    | `scripts/bench/`                                                                                                                    | A1（需要分段指标）、A2  |
| B1   | merge-all 跨根依赖；managed 模式保留 `@` 引用目录                               | `lib/squads/workspace/integrate-team-run.ts`、`hooks/chat/use-claude-chat-controller.ts`                                            | 无                      |
| B2   | 相对布局、每根 provisioning、跨仓 `dependsOn`、消费方验证                       | `service.rs`、`bundle.rs`、`lib/task-workspace/`、`lib/project-environment/`、`lib/squads/workspace/`                               | B1；A2 合入             |
| B3   | 多根入口（generic/subagent、Squad 子任务、Codex）、SCM 别名、远程「仅主根」标注 | `lib/ai/agent/execution/`、`lib/squads/agent-team-runtime.ts`、`packages/agent-codex/`、`components/source-control/`、远程/沙箱入口 | B2                      |
| B4   | mise 作为可选 setup                                                             | `lib/project-environment/`                                                                                                          | B2（每根 provisioning） |

**不做**（账本 D4、D6、D9、D10）：

- Markone 的自定义 `cat-file` 铺树、TOS 日度压缩包加 HTTP Range、NAS 按 SHA 的工作树缓存；保留 `--no-hardlinks`。
- 远程冷 clone 的 CDN seed 和磁盘快照，等 M4 的数据再议。
- 远程与沙箱多根供给（本轮只做「仅主根」标注）。
- Process Compose 和 West。

## 1. 轨道 A：大仓克隆

### A1 预算、取消、分类、指标

**问题**：

- 多条获取路径没有超时（O3），也没有用户取消（O4）。
- mirror 失败时 stderr 被丢弃，错误不分类（O7）。
- 失败从不计数（O5），关键阶段没有计时（O6）。

**做法**：

1. **`AcquisitionBudget`**，放在 `cognia-git-mirror`，即现有 runner 所在的叶子 crate（O8）。它有三部分：
   - 每阶段的上限：`fetch`、`clone`、`derive`、`backfill`、`worktree_add`、`sparse`、`checkout`、`provisioning`。
   - 一个总 deadline。每阶段实际可用的时间取「阶段上限」和「总 deadline 剩余」中的较小值。
   - 一个取消令牌：`Arc<AtomicBool>`，或在异步侧用等价物。

   默认值沿用现有数字：mirror 与远程供给 600 s，guarded clone 120 s，沙箱 clone 1800 s。新增值写在 ADR-0176 修订里：
   - 增量 fetch 180 s，与 Markone 现值一致。
   - `worktree add` 和 checkout 不单设上限，只受总 deadline 约束，因为大仓 checkout 的时长本来就和规模成正比。

2. **可杀 runner**：现有的 `runner.rs` 要做到这三点：
   - 每次 git 调用都按「阶段上限与总 deadline 剩余」取较小值作为超时。
   - 轮询取消令牌。
   - 超时或取消时 kill 并回收子进程，并返回结构化的 `Cancelled` 或 `TimedOut`。

   以下调用一律改走这个 runner：
   - `create_execution` 里的 `worktree add`、`apply_provisioning` 的 sparse 命令、`fetch_origin_throttled`、PR base fetch。
   - `github/workspace.rs` 的网络回退 clone 与 push。
   - `remote_source.rs` 的 refresh fetch。
   - `cognia-sandbox-pool` 的 `clone_workspace`：先确认 `exec_collect` 会 kill（账本 Q3），确认不了就改成会 kill。

3. **取消的传递**：
   - TS 侧把 `AbortSignal` 映射成一个取消 id，经 host 命令登记。
   - Rust 侧在 `spawn_blocking` 闭包里持有对应的令牌，前端取消时置位。
   - 取消与超时都走现有回滚路径：`unlock_git_worktree`、`cleanup_git_worktree`，以及 Registry 状态机里的失败分支。
4. **错误分类**：`classify_failure` 从 `cognia-git/src/exec.rs` 下沉到 `cognia-git-mirror`，`cognia-git` 改为复用。
   - 分为 7 类：`Auth`、`NotFound`（分支、仓库或 ref 不存在）、`Network`、`TimedOut`、`Cancelled`、`Lock`、`DiskFull`，以及兜底的 `Other`。`NotFound` 是新加的。
   - mirror 路径改为保留 stderr，返回「失败 + 类别」，不再只返回 `None`。
5. **重试与降级**（Markone 可借鉴的三点，O20）：
   - 只有 `Network` 和 `TimedOut` 会重试：指数退避、有封顶、带 jitter，次数有上限，总时长不超过总 deadline。
   - mirror 返回 `Auth` 或 `NotFound` 时，不再回退到网络 clone，因为网络路径会得到同样的结论。
   - 其他类别仍按 ADR-0176 §4「cache miss 不是错误」，回退到网络。
   - 类别一直透传到 TS 错误码，UI 用 i18n 文案区分「凭据无效」「分支不存在」「网络超时」。
6. **指标**：
   - 新增这些 span：`git_mirror.ensure`（带命中或未命中属性）、`git_mirror.fetch`、`git_mirror.backfill`、`git_mirror.derive`、`workspace.worktree_add`、`workspace.sparse`、`workspace.checkout`、`workspace.network_clone`、`sandbox.clone`。
   - 修复 `Guard`：在失败路径上调用 `.fail()`（或改成以 `Result` 结束），让错误计数恢复真实。
   - 每次获取生成一份 `AcquisitionReport`，内容是各阶段耗时、mirror 命中与否、字节数或文件数（拿得到时才记）以及错误类别。它写在 Registry 的 workspace 行上，作为一个非索引 JSON 列，走 `store.rs` 的 up-migration；性能面板 `components/performance/` 的 hotspots 表可以按这份记录展开。不新增页面。
   - 属性里只放脱敏后的 remote、阶段名、时长、计数和类别（R11）。

**验收**：

- 账本 V2：在每个阶段注入 kill 或取消，之后没有任何残留。
- V3：分类表测试，覆盖每一类的真实 stderr 夹具。
- V11：`pii-gate-auditor` 审查，并用带 token 的 remote 测 span 属性。
- V12：在假时钟下验证退避的上下界。
- 每个改动的 Rust 文件都带内联 `#[cfg(test)]`，TS 改动都带同目录测试。
- `pnpm audit:rust-architecture` 通过（只往已有 crate 里加代码，不新增模块）。

### A2.0 两个 spike（实现前必须先做）

- **S1（H4，Q1）**：在临时仓库里，对每种 base（`workingState`、`localHead`、gitRef）× sparse 开关 × cone 内外的 overlay，对比两种做法产出的树：
  - 现有做法：`worktree add`，然后 overlay，然后 sparse。
  - 新做法：`worktree add --no-checkout`，然后 `sparse-checkout init --cone` 与 `set`，然后 `checkout` 或 `read-tree -mu HEAD`，最后 overlay。

  重点看两点：现状下「cone 外被用户修改的文件」最终是什么样，以及新路径能否原样复现。复现不了时，在新路径里对 cone 外的 overlay 条目显式补写，补写规则要让结果和现状一致（D3：最终树必须和现在相同）。

- **S2（H5，R4）**：收窄 `materialize_commit` 只补 sparse 路径，然后用同一个 mirror 派生一个全树 checkout，看缺失的 blob 能否经 promisor 链（派生 clone 到 mirror，再到 origin）补齐。

  补不齐时有两个方案：
  - 方案 a：派生前按新任务的 sparse 范围（或全树）增量补齐 mirror，即按需扩大补齐范围。
  - 方案 b：缺 blob 时显式报错，然后按全量重新补齐。

  无论哪种，离线状态下都必须报错并说明原因，绝不能静默检出一棵缺文件的树。

两个 spike 的结论写回账本，更新 H4、H5 和 D3 的状态，以及记录 S1、S2 结果的 D 行。只要有一个不通过，就退回 grilling 重新决定 A2 的范围。

### A2 sparse-before-checkout

1. `create_execution`：
   - 有 `sparse_paths` 时，改为 `worktree add --no-checkout`，配置 sparse（cone），再 checkout。
   - 没有 `sparse_paths` 时，路径和现在完全一样，不引入任何行为变化。
   - `apply_provisioning` 不再负责 sparse，只做链接与 include。ADR-0147 规定的顺序（先 sparse、再链接、再 include）保持不变，只是 sparse 挪到了 checkout 之前。
2. mirror 派生（`derive_args`）：
   - 有 sparse 时，加 `--no-checkout`，在目标目录配置 sparse 之后再 checkout。
   - `materialize_commit` 按 sparse 路径收窄，具体方案以 S2 结论为准。
3. 失败回滚沿用现有路径。A1 的 `workspace.sparse` 和 `workspace.checkout` 两个 span 分开计时。

**验收**：

- V1：差分测试，新旧路径产出的树逐文件一致。
- V4：S2 转成回归测试。
- 现有 `service.rs` 中 sparse 相关测试（约 9637、9785 行附近）继续通过。

### A3 基准与 `checkout.workers`

- 新增 `scripts/bench/clone-acquisition.mjs`，手动运行，不进 CI。对象是 cognia-next 加一个公开大仓（暂定 `torvalds/linux`，账本 Q4）。测量矩阵：
  - mirror 冷与热；
  - sparse 关与开（开时给一个典型子目录集合）；
  - `checkout.workers` 取 1/2/4/8。
- 读取 A1 的 `AcquisitionReport`，拿到分段耗时。
- 结果写入账本 M1 与 V13，同时记录机器、磁盘类型和 git 版本。
- 只有大仓 checkout 快至少 20%、且 cognia-next 不变慢时，才在派生和 checkout 命令上以 `-c checkout.workers=N` 设默认值；用户已经配置了这个值时不覆盖（D11）。达不到就不设，只留数据。

## 2. 轨道 B：多仓

### B1 跨根依赖与 `@` 引用目录（真缺陷，先修）

1. `integrate-team-run.ts`：
   - `changesetByTask`、held 集合和 ready 集合提到所有根的循环之外。
   - 先按 `logicalRootId` 分组捕获，再对跨根的依赖统一做拓扑与扣留。
   - 提供方处于 held、changes-requested 或 failed 时，消费方以 `blocked_by_dependency` 扣留，reason 里写明提供方是哪个根、哪个任务。
   - 发布仍是每仓一个事务（ADR-0227 §2），只是顺序遵从依赖。
   - 依赖图的来源（D8）：任务级 `dependsOn`、B2 的仓级声明、`AgentTeamRepositoryBinding.dependsOn` 三者的并集。B1 先接任务级和 Squad 绑定，仓级声明在 B2 接入。
2. `use-claude-chat-controller.ts`：managed 发送时，`additionalDirectories` 改为「bundle 别名 + 原样保留的 `@` 引用目录」，按路径去重，信任证明与非 managed 模式一致（O15）。

**验收**：

- V7：三根依赖图（sdk 到 app、sdk 到 docs）的协调器测试；重跑前置审计里的反例 probe，期望 `counterexampleReproduced: false`。
- `@` 目录保留的测试。

### B2 布局、每根配置、跨仓依赖、消费方验证

1. **相对布局**（D7）：
   - bundle 根目录下按「各根相对最近公共父目录的路径」摆放，例如 `bundles/<id>/cognia-next/`、`bundles/<id>/cognia-services/`。存储键仍然用哈希，但只用作 bundle 目录名，不再作为根的目录名。
   - 公共父目录过浅（`/`、用户主目录）或各根跨卷时，退化为按目录名平铺成同级（重名时加后缀），并给出可见提示：相对路径依赖不受保证。
   - 同一仓库的子路径根，仍沿用现有的物理分组。
   - 名称在 host 侧清洗、去重并约束在 bundle 根以内（R6）。
   - bundle 记录 `layoutVersion`。旧 bundle 走旧路径恢复和释放，不迁移（C3）。
   - 写入 ADR-0111 修订。
2. **每根 provisioning**（D8）：
   - 每个物理组各自解析自己根目录下的 `.cognia/workspace.json` 和推断结果，`lib/task-workspace/workspace-provisioning.ts` 改为按根返回。
   - Rust 侧 `acquire_workspace_bundle` 接受「每个组一份 provisioning」。
   - 主根只声明多仓关系，不替别的仓做 sparse。
   - 每个根各自过信任门（ADR-0147），未批准的根不做 provisioning，并给出可见提示。
3. **跨仓 `dependsOn`**（D8）：
   - 消费方仓库的 `.cognia/workspace.json` 新增字段：
     ```json
     { "dependsOn": [{ "repository": "github.com/org/sdk" }] }
     ```
   - 匹配方式：按规范化后的 origin（host/owner/name）去匹配 Project 里各根的 origin。规范化规则在实现时定（账本 Q2），优先复用 `canonical_github_remote`。
   - 匹配不到、或匹配到多个，都要给出可见提示：多个时拒绝，绝不猜（R8）。
   - 这个字段计入配置摘要，改动会重新触发审批（ADR-0147「摘要覆盖全部」）。
   - 文件仍是 `version: 1`。没有这个字段的文件摘要不变，已有的审批不会重新弹出。
4. **消费方验证**（D8）：
   - 提供方本次有改动时，消费方在集成工作树上（包含提供方改动的组合）运行它声明的检查（ADR-0188 验收档或 `requiredChecks`），以检查结果为准。
   - 消费方没有声明检查时，进入 `awaitingApproval`，原因写「依赖已变更，无验证检查」。
   - 写入 ADR-0227 修订。

**验收**：

- V5：旧布局夹具能恢复、释放、reconcile。
- V6：命名测试。
- V8：origin 规范化表测试和歧义拒绝测试。
- 夹具测试：`file:../sdk` 能在相对布局下解析（H6）。

### B3 多根入口、SCM、远程标注

1. **generic/subagent**（`agent-execution-service.ts`、`local-tauri-environment.ts`）和 **Squad 子任务**（`agent-team-runtime.ts:514`）：
   - bundle 带上全部根，`executionRoot` 仍是主别名，另外传 `additionalDirectories` = 其余别名。
   - 每个别名走和主根相同的 confinement 与信任证明（R10）。
2. **Codex**：把附加别名映射到 `writableRoots`，但仍然只在 `acceptEdits` 且非 `readOnly` 时生效（O17）。
3. **Aider / A2A**：维持拒绝。按规则 7 补齐三处标注：类型注释、UI 文案、测试。
4. **SCM**：
   - 当前会话有 managed bundle 时，根切换器先列出各根对应的 worktree（标注「任务副本」），原 checkout 作为另一组可选项。
   - 没有 bundle 时行为不变。
   - 新增文案进 `i18n/messages/{en,zh-CN}/**`，之后执行 `pnpm i18n:build`。
5. **远程与沙箱**（`remote-run-service.ts`、`host-project-source.ts`、`project_source.rs`、`run-environment.ts`）：多根项目继续只供给主根，按规则 7 三处标注：类型注释写明只有主根、UI 提示「远程只供给主根」、测试钉住。

**验收**：

- V10：各入口的 confinement 测试，并请 fresh-reviewer 审一遍 B3 的 diff。
- V14：Tauri smoke，见 §4。

### B4 mise

- 推断：根目录有 `mise.toml` 或 `.mise.toml`、且本机 `PATH` 上有 `mise` 时，在 setup 里加一个可推断的 `mise install` 步骤。
- 信任：与 `workspace.json` 的 setup 共用同一信任门（`workspace-config-trust`），批准前不执行（R9）。
- 边界：
  - 只执行 `mise install`，不跑 mise 的 tasks、hooks 和 env 指令。具体做法是传入只允许 install 的参数与环境，并在 ADR-0147 修订里写明。
  - 本机没装 mise 时跳过，并可见提示，不自动安装。
- 指纹：`setup-reuse` 的指纹加入 `mise.toml` 和锁文件（`mise.lock`，存在时才加）。
- 相对布局（B2）落地后，父目录里的 `mise.toml` 也能自然生效，前提是该父目录本身是 bundle 的一部分；否则不读。

**验收**：V9。

## 3. 执行方式

- 轨道 A 与 B1 互相独立，可以分别开会话或 worktree 并行做。
- B2 改 `create_execution` 周边的布局，A2 改同一函数的 checkout 顺序。**B2 在 A2 合入后再开工**，避免两个写入方改同一段代码。
- 每个阶段单独提交。
  - 用户可见的改动（A1 的错误文案、B2/B3/B4）各带一条 changeset（`cognia-next`，按影响取 `minor` 或 `patch`）。
  - A3 的脚本、spike、文档属于内部改动，不加 changeset。
- 每个阶段完成后更新账本的 V/D/M 行，并运行 `ledger.mjs check`。最后一个阶段结束时运行 `ledger.mjs check --final`。
- 提交前对改动跑 `preflight`，测试只跑受影响的 suite（`pnpm test -- <path>`、`cargo test -p <crate> <filter>`），不跑全量。

## 4. 真实环境验收（收尾）

- **V14 Tauri smoke**：
  1. 用同级的 `cognia-next` 和 `cognia-services`（或一对带 `file:../` 依赖的夹具仓）建多根 Project，开 managed 会话，开启 sparse。
  2. 中途取消一次获取，确认没有残留；再完整获取一次。
  3. SCM 显示任务副本。
  4. 在消费方执行 `pnpm install`，`file:../` 能解析。
- **Squad 实跑（M2）**：SDK 任务被要求修改时，app 被扣留，原因写明是 SDK。
- **Host smoke（X3）**：在 ADR-0224 的机器上触发一次远程冷 clone，检查 `sandbox.clone` span 和超时行为。
- 做不成的项都留在账本 Residual 里，不删。
