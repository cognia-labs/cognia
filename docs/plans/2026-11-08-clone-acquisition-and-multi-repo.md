# 大仓克隆获取与多仓处理：分阶段计划

状态：设计于 2026-11-08 grilling 中议定，同日已对照现有实现做过一轮修正（§5），尚未实施。创建：2026-11-08（Asia/Shanghai）。

上游：

- 证据账本：[`docs/evidence/2026-11-08-clone-acquisition-and-multi-repo.md`](../evidence/2026-11-08-clone-acquisition-and-multi-repo.md)。下文 O/H/R/V/D 编号都指这份账本。对照现状得出的修正见 O21–O39、D12–D15。
- 前置审计：`docs/evidence/2026-11-08-cognia-multi-repo-development-audit.md`（多仓能力审计，只读结论）。
- 外部参考：Markone 克隆加速调研（基线 `3494d384ce`），取舍见账本 D4。
- ADR 修订：
  - [ADR-0176](../content/docs/en/adr/0176-every-clone-shares-one-object-cache.md)：获取预算、错误类别、sparse 前置、分段指标。
  - [ADR-0111](../content/docs/en/adr/0111-managed-workspace-registry-and-bundle.md)：bundle 布局与入口。
  - [ADR-0147](../content/docs/en/adr/0147-repository-declared-workspace.md)：每根声明、跨仓 `dependsOn`、mise。
  - [ADR-0227](../content/docs/en/adr/0227-agent-changes-integrate-through-one-host-queue.md)：跨根集成。
  - ADR-0150 只加一个指针。

## 0. 总览

两条轨道并行推进，共用 `cognia-git-mirror` 这一层。轨道内的阶段按顺序走，轨道之间没有依赖，只有一个例外：B2 的布局改动和 A2 都会改 `create_execution`，所以 **B2 排在 A2 合入之后**。

| 阶段 | 内容                                                                                                     | 主要位置                                                                                                                                                   | 依赖        |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| A1   | 获取预算、可杀 runner（含排空管道）、取消桥、失败分类与重试、分段指标、「最近获取」表                    | `crates/cognia-git-mirror`、`cognia-git`、`cognia-task-workspace(-host)`、`cognia-sandbox-pool`、`lib/task-workspace/client.ts`、`components/performance/` | 无          |
| A2.0 | spike S1（sparse 前置与 overlay 是否等价）、S2（收窄补齐后 promisor 链能否补全）                         | 临时 worktree                                                                                                                                              | 不阻塞 A1   |
| A2   | `create_execution` 先 sparse 后检出；远程供给收窄 mirror 补齐                                            | `service.rs`、`remote_source.rs`、`cognia-git-mirror/src/{lib,plan}.rs`                                                                                    | A2.0 通过   |
| A3   | 本地基准，决定 `checkout.workers` 默认值                                                                 | `scripts/bench/`（新建）                                                                                                                                   | A1、A2      |
| B1   | merge-all 跨根依赖与捕获失败扣留；managed 发送保留 `@`、slash 和项目附加目录                             | `lib/squads/workspace/integrate-team-run.ts`、`registry-controller.ts`、`workflow-nodes/index.ts`、`hooks/chat/use-claude-chat-controller.ts`              | 无          |
| B2   | 相对布局、每根 provisioning 与信任、每根 origin、跨仓 `dependsOn`、变更提供方扣留消费方                  | `service.rs`、`store.rs`、`types.rs`、`lib/task-workspace/`、`lib/project-environment/`、`lib/workspace/`、`packages/plugin-contract` 类型                 | B1；A2 合入 |
| B3   | generic/subagent 与 Squad 子任务接多根；SCM 显示 bundle 别名；Codex、Aider、A2A、远程、沙箱按规则 7 标注 | `lib/ai/agent/execution/`、`lib/squads/agent-team-runtime.ts`、`components/source-control/`、各适配器和远程入口                                            | B2          |
| B4   | mise 作为可选 setup                                                                                      | `lib/workspace/provisioning-inference.ts`、`lib/project-environment/`                                                                                      | B2          |

**不做**（D4、D6、D9、D10、D15）：

- Markone 的 `cat-file` 铺树、TOS 归档加 Range 下载、NAS 工作树缓存；`--no-hardlinks` 保留。
- 远程冷 clone 的 seed 和磁盘快照。
- 远程和沙箱的多根供给。
- Codex 按轮写入范围。
- 跨仓组合候选上的自动检查（后续阶段）。
- Process Compose 和 West。

## 1. 轨道 A：大仓克隆

### A1 预算、取消、分类、指标

**现状**（O3–O8、O21–O30）：

- 能复用的已有部件：叶子 crate 里的同步 runner 到时会 kill 并回收；`cognia-git` 有带预算、带 kill 的异步 runner `exec::run_within`；`Guard` 已有 `.fail()` 和 `set_ok()`。
- 缺口一：`worktree add`、sparse、`fetch origin`、PR base fetch、GitHub workspace 回退 clone 和 push、远程供给 refresh 都没有预算。
- 缺口二：mirror 的 quiet 包装把 stderr 丢了。
- 缺口三：同步 runner 轮询时不读 stderr。
- 缺口四：mirror 的环境里没有 `LC_ALL`。
- 缺口五：`git.exec` 的 5 个调用点从不 `.fail()`。
- 缺口六：沙箱的 `exec_collect` 超时只丢弃 future，不 kill 子进程。
- 缺口七：TS 侧的 `AbortSignal` 到不了 Rust。

**做法**：

1. **`AcquisitionBudget`**，放在 `cognia-git-mirror`。
   - 组成：每阶段上限（fetch、clone、derive、backfill、worktree_add、sparse、checkout、provisioning）、总 deadline、取消令牌 `Arc<AtomicBool>`。
   - 每次调用的时限取「阶段上限」和「deadline 剩余」中的较小值。
   - 现有数值都是各调用方自己定的，迁到预算里时保持不变：

     | 调用方                  | 位置                     | 时限   |
     | ----------------------- | ------------------------ | ------ |
     | GitHub workspace mirror | `github/workspace.rs:36` | 600 s  |
     | 远程供给                | `remote_source.rs:48`    | 600 s  |
     | guarded clone           | `repo.rs:185`            | 120 s  |
     | 认证 fetch              | `remote.rs:163`          | 120 s  |
     | 沙箱 clone              | `remote_prep.rs:64`      | 1800 s |

   - 新增值：增量 fetch 180 s。`worktree add` 和 checkout 只受总 deadline 约束。
2. **runner 改造**：
   - 同步 runner（`runner.rs`）：轮询期间并发排空 stdout 和 stderr（R15，V16）；每轮检查取消令牌；超时或取消时 kill 并回收，返回 `TimedOut` / `Cancelled`；环境里设 `LC_ALL=C`、`LANG=C`（O23）。
   - 异步侧复用 `exec::run_within`，只补取消令牌。
   - 以下调用改走 runner：`create_execution` 的 `worktree add` 和 sparse、`fetch_origin_throttled`、PR base fetch、`github/workspace.rs` 的回退 clone 和 push、`remote_source.rs` 的 refresh。
   - 沙箱 `clone_workspace` 要补一条真正的 kill 路径（O27）：用 exec inspect 拿到 pid 再 kill，或者给 `RunningRunner` 加 kill。
3. **取消桥**（O26，新工作）：
   - 仿照上传中止（`client.ts:769` → `host_surface.rs:798` → `transfer.rs:300`）建一个按 id 索引的注册表。
   - TS 把 `AbortSignal` 映射成一个取消 id，经 host 命令登记，中止时置位。
   - `spawn_blocking` 闭包持有对应令牌，结束时注销。
   - 取消和超时都走现有回滚：`unlock_git_worktree`、`cleanup_git_worktree`，加上 Registry 的失败分支。
4. **失败分类**（D12）：
   - `classify_failure` 不下沉，因为它返回的 `GitError` 带着 git2（O24）。
   - `cognia-git-mirror` 定义自己的 `FailureClass`：`NotFound`、`Auth`、`Network`、`TimedOut`、`Cancelled`、`Lock`、`DiskFull`、`Other`。
   - `cognia-git` 把它映射到 `GitError`：复用已有的 `NotFound`、`AuthRequired`、`NetworkFailed`、`LockHeld`，补上缺的 `TimedOut`、`Cancelled`、`DiskFull`。`classify_failure` 增加「分支、ref、仓库不存在」这个分支。
   - mirror 的 quiet 包装（`run_git_quietly`、`run_for`、`derive_from_mirror`）改为返回「失败 + 类别」。
5. **重试与降级**：
   - 只有 `Network` 和 `TimedOut` 重试：指数退避有封顶、加 jitter、次数有上限，总时长不超过 deadline。
   - mirror 返回 `Auth` 或 `NotFound` 时不回退网络；其他类别仍按 ADR-0176 §4 回退网络。
   - 错误类别透传到 TS 错误码，UI 文案走 i18n。
6. **指标**（D14）：
   - 新增 span：`git_mirror.ensure`（带命中属性）、`git_mirror.fetch`、`git_mirror.backfill`、`git_mirror.derive`、`workspace.worktree_add`、`workspace.sparse`、`workspace.checkout`、`workspace.network_clone`、`sandbox.clone`。
   - `git.exec` 的 5 个调用点在失败时调用 `.fail()`（O28）。
   - `AcquisitionReport` 包含各阶段耗时、是否命中、计数和错误类别。用 `store.rs` 的幂等 `ALTER TABLE ADD COLUMN` 给 `workspace_registry` 加一个 TEXT JSON 列（O29），同时改 INSERT、各 SELECT 和 `WorkspaceRecord`。
   - 新增 host 命令返回最近 N 次获取。`/performance` 页加一张「最近获取」表（新组件加同目录测试，文案走 i18n），不新增页面。
   - 属性一律脱敏（R11）。

**验收**：V2、V3、V11、V12、V16。Rust 测试写在文件内的 `#[cfg(test)]`，TS 测试同目录；`pnpm audit:rust-architecture` 通过；`pnpm lint:i18n` 通过。

### A2.0 两个 spike（实现前必须先做）

- **S1（H4，Q1）**：对每种 base（`workingState`、`localHead`、gitRef）、sparse 开或关、overlay 落在 cone 内或 cone 外，比较两条路径产出的树：
  - 现有路径：`worktree add` → overlay → sparse。
  - 新路径：`worktree add --no-checkout` → `sparse-checkout init --cone` 和 `set` → `checkout`（或 `read-tree -mu HEAD`）→ overlay。

  `apply_git_overlay` 按 `ls-tree` 写入快照条目（`snapshot.rs:1159-1225`），sparse 先生效后可能写出 cone 外的文件。spike 要确定现状下这类文件的最终形态，并让新路径复现它（D3：最终树和现状一致）。

- **S2（H5，R4）**：只在远程供给路径上，让 `materialize_commit` 按声明的 sparse 路径收窄。它目前没有 pathspec（O31），需要换一种 blob 枚举方式，比如按路径过滤 `ls-tree` 后用 `cat-file --batch` 预取。然后用同一个 mirror 派生出完整的树，检查缺失的 blob 能否沿 promisor 链补全。补不全时，按需扩大补齐范围，或者缺 blob 时显式报错再全量补齐；离线时必须报错，不能静默检出一棵残缺的树。

结论写回账本（H4、H5、D13）。任一 spike 不通过，就回到 grilling。

### A2 sparse-before-checkout（范围见 D13）

1. `create_execution`：
   - 有 `sparse_paths` 时：`worktree add --no-checkout` → 配置 sparse（cone）→ 检出，overlay 按 S1 的结论处理。
   - 没有 `sparse_paths` 时：路径完全不变。
   - `apply_provisioning` 不再处理 sparse，只做链接和 include。
   - 直接调用 `apply_provisioning` 的 sparse 测试（`service.rs:9740-9794`）改写为调用 `create_execution`。校验测试（`:9604-9637`）保留。
2. 远程供给（`remote_source.rs`）：把工作区声明的 sparse 路径传到 `MirrorRequest`，`materialize_commit` 按 S2 的方案收窄。
3. GitHub workspace 和 guarded clone 不变，它们没有 sparse 来源（O31）。
4. `workspace.sparse` 和 `workspace.checkout` 分别计时。

**验收**：V1、V4。

### A3 基准与 `checkout.workers`

- 新建 `scripts/bench/clone-acquisition.mjs`，手动运行，不进 CI。
  - 测试对象：cognia-next 和一个公开大仓（暂定 `torvalds/linux`，Q4）。
  - 测量维度：mirror 冷启动 / 热启动、sparse 关 / 开、workers 取 1、2、4、8。
  - 分段耗时从 A1 的「最近获取」命令读取。
- 结果写入账本 M1 和 V13，注明机器、磁盘和 git 版本。
- 默认值规则按 D11：效果达标才用 `-c checkout.workers=N` 设默认（已有先例 `integration.rs:527`、`snapshot.rs:426`）。用户自己配置过的不覆盖。

## 2. 轨道 B：多仓

### B1 依赖扣留与发送目录（真缺陷，先修）

1. `integrate-team-run.ts`（O11、O32、O33）：
   - **扣留状态提到所有根之外**：`changesetByTask`、held、ready 从每个根的循环里移出来。
   - **捕获失败也要扣留**：捕获失败的提供方，在同一根和跨根两种情况下都扣留它的依赖方（R14）。这个缺陷单根内就存在。
   - **扣留记录**：新增逐项的扣留记录 `heldBy: { changesetId?, logicalRootId, taskId, cause }`（O32），UI 和报告都显示它。
   - **任务级边**：字段叫 `dependencies`（`types/agent/agent-task.ts:22`），不叫 `dependsOn`。
   - **仓级边**：`AgentTeamRepositoryBinding.dependsOn` 是 root 到 root 的边（id 等于 `logicalRootId`），展开后变成两个根所有 changeset 之间的边。数据从 `mergeAllOptions`（`workflow-nodes/index.ts:554`）经 controller 传进 `integrateTeamRun`，不经过协调器。合并时加环检测，因为协调器本身不查环。
   - **只读仓**：只读仓不产生 changeset，所以不能当提供方。声明了也只做校验和提示。
   - **发布**：仍然每仓一个事务，按依赖顺序执行。
2. `use-claude-chat-controller.ts`（O15、O39）：managed 发送时，`additionalDirectories` 设为「bundle 别名 + 原样保留的 `@` 引用目录 + pending slash 路径 + 项目附加目录」，按路径去重，信任证明与非 managed 模式一致。

**验收**：

- V7 和 V15：测试直接写在 `integrate-team-run.test.ts`，覆盖三根依赖图，以及提供方捕获失败、被扣留、要求修改三种情况。把 `.cache/` 下的反例 probe 迁成仓内测试（`.cache/` 被 gitignore 忽略）。
- 增加发送目录的测试。

### B2 布局、每根配置、跨仓依赖

1. **相对布局**（D7，O9、O34）：
   - 路径在 `service.rs:2940-2944` 构造，改成每个根按相对于最近公共父目录的路径摆放。`bundle.rs` 的 `compose_alias_path` 取的是 git common dir 的最后一段，每个仓都会撞成 `.git`，所以不复用。
   - 退化情况（父目录过浅或跨卷）按名称平铺，并给出提示。名称在 host 侧清洗、去重、约束在 bundle 内（R6）。
   - `layoutVersion` 用幂等 `ALTER TABLE` 加到 `workspace_bundles` 上，`put_workspace_bundle` 负责持久化。
   - 旧 bundle 不迁移：managed restore 用存储的 `execution_root`，不受影响；scratch 会话的校验（`service.rs:672-685`）要改成按 `layoutVersion` 计算期望路径。
2. **每根 provisioning 与信任**（D8、D15，O35）：
   - Rust：`WorkspaceProvisioning` 从「每个 bundle 一份」改为「每个物理组一份」（`types.rs:879`，这是破坏性的 API 变更，同步改 host 和 TS 客户端）。
   - TS：`registry-controller.ts` 和 `workspace-provisioning.ts` 按每个根读取它自己的 `.cognia/workspace.json` 和推断结果。
   - 信任：主根沿用原来的审批键，已有审批不会重新弹出。附加根用自己的路径作为键，首次使用时审批一次（R16，V17）。没批准的根不做 provisioning，并给出提示。
3. **每根 origin 与跨仓 `dependsOn`**（D8，Q2）：
   - origin 存储：`WorkspaceRoot` 增加可选的 `origin`，在添加根或探测仓库时写入（`lib/workspace/project-repository.ts` 目前只处理主根）。字段是可选且不建索引的，不需要升 Dexie 版本。
   - origin 解析：新写一个 `parseOrigin` 解析器，输出规范化的 host/owner/name，覆盖 ssh、https、`.git` 后缀、大小写和 GHE（V8）。现有的 `canonical_github_remote` 和 `httpsRemoteUrl` 都不适用（O35）。
   - 声明方式：消费方的 `.cognia/workspace.json` 写 `"dependsOn": [{ "repository": "github.com/org/sdk" }]`。匹配不到或匹配到多个都拒绝，并给出提示（R8）。
   - 解析器要显式校验这个字段：现有解析器会忽略未知键。不要输出空数组，以保证没写这个字段的文件 digest 不变。digest 由 `workspace-config-trust.ts:126-141` 计算。
   - 这些边和 B1 的仓级边合成同一张图。
4. **变更提供方扣留消费方**（D15）：
   - 第一版：提供方本次有改动时，消费方一律进入 `awaitingApproval`，扣留记录写明提供方。
   - 跨仓组合候选上的自动检查放到后续阶段，账本 X4 记录。现有的单仓逐 changeset 检查（`lib/scm/runtime.ts:101-117`）照常执行。

**验收**：

- V5：用旧布局和 scratch 夹具验证。
- V6、V8、V17。
- 增加 `file:../sdk` 夹具测试（H6）。

### B3 入口、SCM、标注

1. **generic/subagent**：`OpenWorkspaceResult` 增加 `additionalAliases`（`local-tauri-environment.ts:71-76`），bundle 从工作区所属 project 取全部根（`agent-execution-service.ts:319`），并写入执行配置。
2. **Squad 子任务**：`agent-team-runtime.ts:514` 交接时带上 `additionalAliases`。每个附加别名走和主根相同的 confinement 和信任证明（R10）。
3. **SCM**：数据已经有了，就是 `SessionExecutionBinding.roots`，`use-git-branch-indicator.ts:79` 已经在读。根切换器优先列出本会话的任务副本，原 checkout 作为另一组。新增文案进 `i18n/messages/{en,zh-CN}/**`，然后执行 `pnpm i18n:build`。
4. **按规则 7 三轴标注**（D15）：
   - Codex：写范围是固定在进程上的静态 `writableRoots`（O36），不接收 managed 多根。
   - Aider、A2A：拒绝附加根。现在只有测试覆盖，类型和 UI 都缺。
   - 远程和沙箱：只供给主根，Rust 侧实际取的是「第一个存在的根」（`project_source.rs:112-120`），要在类型注释里写明，并加 UI 提示。现有测试（`host-project-source.test.ts:60-68`）保留。

**验收**：V10、V14。

### B4 mise

- **推断**：`provisioning-inference.ts` 新增一种 setup 步骤候选。目前只有 `cacheLink` 和 `include` 两种（O38）。根目录有 `mise.toml` 或 `.mise.toml` 时，提出 `mise install`。
- **检测**：在 setup 执行器所在的环境里检查 `mise` 是否在 `PATH` 上，桌面和 Host 都这样做，不依赖只在 Tauri 下可用的 `detectCli`。检测不到就跳过，给出提示，不自动安装。
- **信任**：审批 digest 纳入 `mise.toml` 和锁文件的内容，修改其中任一个都会重新弹出审批（R9，V17）。只执行 `mise install`，不运行 mise 的 tasks、hooks、env 指令。
- **复用**：在 `setup-reuse` 的指纹里加入 `mise.toml` 和锁文件。目前没有默认输入，要新写代码。

**验收**：V9、V17。

## 3. 执行方式

- 轨道 A 与 B1 互相独立，可以各开会话或 worktree 并行。B2 在 A2 合入之后开工。
- `packages/agent-codex` 上有其他会话未提交的改动。B3 对 Codex 只做标注，避免碰它的运行逻辑。
- 每个阶段单独提交。A1 的错误文案和「最近获取」表、B1–B4 是用户可见的改动，各带 changeset（`cognia-next`）。spike、基准脚本和文档不加 changeset。
- 每个阶段结束后更新账本，运行 `node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/2026-11-08-clone-acquisition-and-multi-repo.md`。最后一个阶段加 `--final`。
- 提交前跑 `preflight`。测试只跑受影响的 suite，不跑全量。

## 4. 真实环境验收（收尾）

- **V14 Tauri smoke**：
  1. 用一对带 `file:../` 依赖的同级仓建多根 Project，开 managed 会话，sparse 开启。
  2. 中途取消一次，确认没有残留，再完整获取一次。
  3. 「最近获取」表显示这两次的记录，SCM 显示任务副本。
  4. `pnpm install` 能解析 `file:../`。
- **M2**：用 Squad 实跑，SDK 有改动时 app 被扣留，原因里写明 SDK。
- **X3**：在 ADR-0224 那台机器上触发一次远程冷 clone，检查 `sandbox.clone` 的 span 和超时 kill。
- 做不了的项保留在账本 Residual 里。

## 5. 对照现状的修正记录（2026-11-08）

两个只读代理逐条核对了 §1 和 §2。我亲自复核了其中影响最大的几条：`runner.rs:120-200`、`span.rs:40-62`、`remote_prep.rs:550-592`、`integrate-team-run.ts:258-270`、`service.rs:668-688`、`workspace-config-trust.ts:192-204`、`process-write-authority.ts:95-115`。

**用户新做的决定**：

- Codex 写范围本轮不做，只标注。
- 跨仓消费方第一版直接扣留，组合检查以后再做。
- A2 只覆盖 worktree 和远程供给的补齐。
- `/performance` 页加「最近获取」表。

**按显而易见的默认处理**：

- 主根原有审批保持有效，附加根各自审批一次。
- 审批 digest 纳入 `mise.toml`。
- mise 检测在 setup 执行环境里做。

**新发现的缺陷**：

- 捕获失败的提供方不会扣留它的依赖方。
- mirror runner 的 stderr 管道可能写满后阻塞。
- 沙箱超时不 kill 子进程。
- managed 发送丢失 slash 路径和项目附加目录。

**修正的错误前提**：

- `classify_failure` 不能下沉到 mirror crate。
- `Guard` 不需要修。
- Registry 没有 up-migration 列表。
- `bundle.rs` 并不决定路径。
- scratch 校验会重新计算路径。
- provisioning、信任、origin 目前都只认主根。
- 没有现成的 origin 解析器。
- 没有 `canonical-json.ts` 这个文件。
- 推断机制里没有 setup 步骤这类候选。
- SCM 别名数据已经存在。
