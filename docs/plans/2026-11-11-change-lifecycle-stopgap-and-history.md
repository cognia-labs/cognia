# 变更链：先止血，再放行并发，再修投影与历史

日期：2026-11-11（Asia/Shanghai）。状态：**Proposed，未实施**。取代 [2026-11-10 change lifecycle convergence](2026-11-10-change-lifecycle-convergence.md)；原文保留，只用作审计项来源和全量映射的对照。并发模型见 [ADR-0255](../content/docs/zh/adr/0255-runs-that-share-a-directory-keep-their-diffs-and-lose-undo.md)。

缺口编号（F01–F18、CF01–CF05）沿用三份报告：[缺口审计](../reports/2026-11-10-turn-diff-gap-audit.md)、[对抗性复核](../reports/2026-11-10-turn-diff-adversarial-review.md)、[联合审计](../reports/2026-11-10-turn-diff-cross-feature-audit.md)。

## 1. 为什么重写

原方案的问题清单基本属实，但它按三个不成立的前提设计：多人团队、已上线产品、不可信客户端。它的 W02 主干（同一目录不允许两个独立 writer）还和实际用法冲突。评审中定下的前提如下，后文都以此为准。

| 决定       | 内容                                                     | 对原方案的影响                                            |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------- |
| 实施主体   | 一人调度 agent 会话                                      | 删角色表和 5–8 周排期；工作项按「一个会话能独立提交」切   |
| 数据现状   | 开发期，本地数据可重置                                   | 删旧数据保真、灰度、二进制降级、备份重验证                |
| 威胁模型   | gate 防漏传，不防恶意调用方                              | 删 native 策略适配、grant 迁移、evidence receipt          |
| 节奏       | 先拒绝不安全操作，再建机制                               | P1 从「一次建好」改为小改动止血                           |
| 共享目录   | 父子 agent、独立会话、Squad 队友、外部工具都会同目录并发 | W02 的互斥、durable reservation、participant 注册全部不做 |
| 停止未证实 | 该轮不可撤，目录可继续用                                 | 不做 quarantine 状态机和人工恢复入口                      |
| 并发归因   | 先重叠即整轮只读，再补写入回执恢复 Undo                  | 新增 S2 和 S4                                             |
| F17        | 只对有 eol/filter 转换的文件读磁盘原字节                 | 不做每轮全量读                                            |
| CF02       | 每个 head 一个新 checkout，profile 之间脏了再重置        | 不做每 profile 独立 checkout                              |
| 后续优先级 | 投影与历史先于入口覆盖和性能                             | 原 P3 提前；W05、W08 进待办                               |
| 验收环境   | macOS 桌面 + 真实模型，Linux 常驻 Host                   | Windows、Capacitor 真机标为未验证，不在范围               |

「P1」在报告里没有严重度定义，报告自己写明「优先级不是线上发生率」。本方案把它当修复顺序，不当发布门槛。

## 2. 已核对的现状

以下是 2026-11-10/11 对当前源码的只读核对，行号会漂移，实施前重新定位。

- **Apply/Undo 写入**：`crates/cognia-task-workspace/src/ledger.rs` 的 `write_entry` 先 `remove_file` 目标，再写同目录临时文件、设 mode、rename。`commit_plans` 失败时只逆序回滚已完成的 entry，回滚错误被 `let _ =` 丢弃；当前失败的那一项不在回滚集合里，它的原件已经删除。整条路径没有 fsync。
- **已有的 intent 记录**：`provenance_mutations` 表在文件写入前落 `prepared` 行并 pin before/after blob，启动时 `capture::reconcile` 重放。它只协调 provenance 行，不重做也不回滚文件。
- **快照恢复**：`restore_run_snapshot` 先 hydrate blob，再 `clear_worktree_contents`（除 `.git` 外全删），再 `materialize` 逐个 `fs::write`。清空和物化期间不持锁，中途失败没有保护。checkout 回退路径也调用同一个清空函数。
- **基线采集**：Git 路径用 `ls-tree` 的 oid 和一次 lstat，干净文件不读内容，只有 `status` 列出的路径读 overlay。非 Git 或不匹配的根走全目录 walk 并整文件读入。service 的 begin 路径不传预算。
- **路径 key**：walk 路径在所有平台上执行 `replace('\\', "/")`。provenance 的 `path()` 拒绝含 `\` 的路径。
- **停止确认**：`requires_executor_stop_confirmation`、`confirm_executor_stopped` 只有 `worker_cli.rs` 调用，`lib/`、`sidecar/`、`src-tauri/src` 没有调用方。`bind_assistant_message` 只有测试调用。ADR-0244 的状态是 Proposed。
- **重叠准入**：`check_capture_root_admission` 在 begin 时扫描全部 run，同一根或祖先/后代根上已有 `Running|Settling` 的就地观察 run 时，拒绝第二个就地观察 run。也拒绝与停止未确认的 run 相交的任何获取。
- **归因记录**：settle 是全根前后对比，不按路径过滤。唯一的工具时刻命令 `task_workspace_record_tool_event` 不带哈希，生产调用方只有 Codex 和 SIWC 的 `onFileChanges`。带哈希的 `record_tool_mutation_receipt` 只有测试构造。sidecar 的 `file-checkpoint.ts` 发出 `file_pre_mutation` 帧，仓内没有消费者。
- **Undo 语义**：以 after 为 base、before 为目标做三方合并（`merge_entry`，回退到 `git merge-file`）。别人的改动能干净合并时保留，不能合并时报冲突。重复的 Apply/Undo 合并结果是无操作，所以不需要客户端幂等键。
- **不可逆标记**：`PatchSet.reversible` 是整个 patch 的布尔值，目前只在 blob 容量超限且请求允许时置 false。Undo 拒绝不可逆 patch，Task Resources 面板据此禁用按钮。没有逐文件或逐 hunk 的标记，也没有原因字段。
- **发布 gate**：native 的 `publish_integration` 并集三处 required checks（run 已存、调用方传入、各 changeset 已存），从不读仓库里的策略。`lib/scm/review/review-changeset.ts` 的 `requiredChecksFor` 在评审时并入目标 ref 的策略；`integrate-dialog.tsx` 和 `lib/scm/integration/orchestrator.ts` 不读策略。Squad 和 Best-of-N 自己并入。
- **检查目录**：通用 SCM runtime 用 `changesetRootForRevision` 返回采集时的 `executionRoot`。`lib/best-of-n/checks.ts` 用 `gitRef: headSha` 取新的托管 checkout。

2026-11-11 补充核对（只读源码，没有运行）：

1. **第二个同目录运行现在整轮被拒。** 就地观察的唯一调用方是聊天控制器 `hooks/chat/use-claude-chat-controller.ts`，begin 抛错后走 `refuseTurn`（`task_workspace_unavailable`），这一轮不执行，也不回退到托管模式或无采集执行。用户看到「工作区不可用」和「重试或绑定文件夹」的提示，附带未翻译的 Rust 原文。远程外部 agent 路径（`remote-run-service.ts`）同样以原始报错失败。托管 run 不受就地观察 run 阻挡，只被停止未确认的 run 阻挡。
2. **托管执行根默认不会嵌进源仓库。** 它在 `<data_dir>/task-workspaces/executions/<task>/<run>` 下。例外是把 `COGNIA_TASK_WORKSPACE_EXECUTION_ROOT` 显式设到仓库内，代码只校验绝对路径。反方向没有拦截：begin 不拒绝把一个托管执行根当作就地工作区。
3. **`integrateChangesets` 是发布的唯一 TS 入口。** 手动对话框、Squad merge-all、工作流节点、Best-of-N（含 CLI bridge）都经 `createScmRuntime(...).integrate` 到 `lib/scm/integration/orchestrator.ts`；Harness 只评审不发布；插件没有入口。orchestrator 在 prepare 前原样透传调用方的列表，publish 前只与 Host 已存的列表并集。它的输入里没有仓库根和 blob 读取器；目标 SHA 在 prepare 之后才有（`run.expectedOldSha`）。`reviewChangeset` 不把并集写回 changeset。
4. **F02 的调用点都不等执行器停止。**
   - `run-and-capture.ts`：超时立即 reject；abort 后最多等 1 秒（`INTERRUPT_DRAIN_TIMEOUT_MS`）就 reject。它通过 `onExecutorStarted(executorStop)` 把真正的停止 promise 交给调用方，注释写明 reject 不是停止证明。
   - `agent-execution-service.ts`：成功路径在执行返回后 `lease.settle("ready")`；失败路径直接 `lease.abort()`，不取用 `executorStop`。
   - `agent-executor.ts`：只透传 signal 和 timeout，不 settle。
   - Scheduler chat：abort 立即 resolve，随后 `taskLease.settle("failed")`。Scheduler 的外部 agent 路径不传 signal，取消到不了执行器。
   - `external/manager.ts`：超时触发的取消不 await，立即 reject；abort 只发 `stopAgent`。报告说的「等待 `run.execution`」在 `remote-run-service.ts` 的 `cancelRemoteExternalRun` 里。
   - settle 的公共面是 `lease.settle`（`lib/task-workspace/run-lease.ts`）到 `settleWorkspaceBundleTurn`，只接受 `ready`、`failed`、`cancelled`，没有可逆性参数。`lib/squads/teammate/dispatch-teammate.ts` 已有一个最多等 2 秒的 `executorStop` 等待，可作参照。

仍未核对：

1. 诊断渲染是否显示 `message` 里的 Rust 原文。
2. 聊天的工作目录选择器是否过滤掉托管执行根。
3. 进程内的 bundle-turn begin 是否会走到 `begin_worker_run`（它会武装 Host 的停止栅栏）。
4. `run.repoCommonDir` 能否作为 `readReviewPolicyAtRef` 的仓库路径。
5. 以上 F02 结论都来自读代码，晚到写入实验仍没有跑；S1-3 的失败测试就是这个实验。

## 3. S1 止血

每项一个提交，先写会失败的测试，确认失败原因，再修。S1-0 先落地，其余互不依赖，但改 `service.rs` 的项一次只由一个会话做。

### S1-0 不可逆原因字段

**已实现**（`21b3168222`，2026-11-11）。与下文的出入：枚举值按仓库惯例用 camelCase（`capacity`、`stopUnproven`、`overlap`、`pathUnsupported`、`fidelityUnknown`）。`capacity` 是唯一随 apply 设置、并在下一次保留了反向数据的 apply 时解除的原因；其余原因描述运行本身，一旦设置不解除，bundle 重试的复位也不清它们。后续各项用 `PatchSet::mark_irreversible` 置原因。聊天里的 turn card 和 Restore 对话框还没有按原因显示说明，只有 Task Resources 面板有。

给 `PatchSet` 加 `irreversible_reason`（`capacity`、`stop_unproven`、`overlap`、`path_unsupported`、`fidelity_unknown`），现有容量路径填 `capacity`。同步 serde、TS 类型、companion 契约生成物和面板文案（en、zh-CN 分片）。后续各项只是置这个字段，不再各自改 DTO。

验收：旧记录缺字段时读作「未知原因的不可逆」，不读作可逆；面板按原因显示说明。

### S1-1 F01：写入先落盘再替换

`write_entry` 改为先在目标同目录写临时文件并设 mode，再 rename 覆盖目标；不再预先删除。symlink 用临时名创建后 rename。删除类 entry 保持直接删除，它的原件已经作为 before blob 被 pin。临时文件在失败时清理。

`commit_plans` 把失败的当前项也纳入回滚；回滚错误不再丢弃，汇总进返回的错误，列出没有恢复的路径。before blob 在这种失败下不释放。

不做：多文件事务日志、fsync、`RecoveryRequired` 状态。单文件 rename 已经保证「要么旧内容要么新内容」，多文件中途失败靠回滚加明确报错。

验收：在写临时文件、chmod、rename 三处注入失败，单文件时原件字节和 mode 不变；双文件时第一项被回滚，回滚再失败时错误里有路径，blob 仍可读。

### S1-2 快照恢复先物化再替换

`restore_run_snapshot` 改为先把目标快照物化到执行根同一文件系统下的暂存目录，全部成功后再替换执行根内容（保留 `.git`），失败则删除暂存目录，执行根不动。checkout 回退路径走同一函数。

恢复只在该根（含祖先和后代）没有 `Running|Settling` 的 run 时允许，检查和替换都在现有的 capture admission 锁内完成。这是本方案保留的唯一互斥。

验收：物化中途缺 blob 或写失败，执行根逐字节不变；恢复期间 begin 同一根被拒绝；有活动 run 时恢复被拒绝并说明原因。

### S1-3 F02：停止未证实不产生可撤 patch

改动落在两处公共面，不逐个调用点打补丁：

- `lease.settle` 和 `lease.abort` 增加一个可选的执行器停止 promise。传入时先等它，最多等一个固定上限（参照 `dispatch-teammate.ts` 的 2 秒，具体值实施时定）。等到了照常 settle；等不到则仍然 settle 以保留 diff，并把 `stopUnproven` 传给 Host，由 Host 在产出的 patch 上置 `reversible = false`、原因 `stop_unproven`。settle 的 Host 命令为此加一个字段。
- `agent-execution-service.ts` 和 Scheduler chat 执行器接住 `onExecutorStarted` 给出的 `executorStop`，在取消和超时路径上传给 lease。Scheduler chat 在 abort 时改用 `cancelled`。

不设 `executor_stop_unconfirmed`，所以下一轮可以在同一目录开始，新基线取当时的磁盘状态。

本项不做：Scheduler 外部 agent 路径不传 signal、`external/manager.ts` 超时不等取消。这两处不 settle 采集，属于 F05，留在待办。worker CLI 和 ADR-0244 的远程 run 路径不变。

验收：用一个取消后延迟写文件的假执行器，在停止 promise 上限内没停的，该轮 patch 不可撤且原因正确，下一轮 begin 成功且基线包含晚到的写入；上限内停下的，patch 可撤且包含全部写入。`cancelRemoteExternalRun` 等待 `run.execution` 的现有行为回归不变。

### S1-4 F03：含反斜杠的文件名不可撤

非 Windows 上，walk 路径遇到文件名含字面 `\` 的条目时记录下来。变更集合里出现这类路径的 patch 置不可逆，原因 `path_unsupported`。不引入可逆编码，不处理 Windows、UNC、大小写和非 UTF-8。

验收：同时存在 `a\b.txt` 和 `a/b.txt` 的非 Git 目录，修改前者后 Undo 被拒绝，后者不被触碰。普通 Git 路径不受影响。

### S1-5 F17 和 F04：受转换影响的文件读原字节

`capture_git_backed` 在 begin 时找出磁盘字节可能不等于 HEAD blob 的已跟踪文件：

- `git check-attr` 查到 `text`、`eol`、`filter`、`working-tree-encoding` 任一生效的；
- `core.autocrlf` 或 `core.eol` 会转换的文本文件；
- `git ls-files -v` 标出 assume-unchanged 或 skip-worktree 的。

只对这些文件读磁盘内容，原始字节的 blob 哈希等于 HEAD oid 就继续复用 Git 对象，不等就存物理 blob 作基线。普通仓库没有额外开销；开了 autocrlf 的仓库每轮会读全部文本文件，这个成本已接受。submodule、LFS、稀疏检出未物化的条目不做处理，出现在变更集合里时 patch 置不可逆，原因 `fidelity_unknown`。

验收：真实 Git fixture，干净的 CRLF 文件和带 clean/smudge filter 的文件，capture、修改、Undo 后磁盘字节与修改前逐字节相同。

### S1-6 CF01：发布入口并入目标策略

`integrateChangesets` 是唯一入口（第 2 节补充核对 3），并集只加在这里：

- `IntegrateChangesetsDeps` 增加一个按 ref 读评审策略的依赖，由 `createScmRuntime` 注入，实现复用 `readReviewPolicyAtRef`。仓库路径取被集成 changeset 的 `sourceRoot`，与 `reviewChangeset` 的读法一致。
- prepare 之后用 `run.expectedOldSha` 读策略，把 `policy.requiredChecks` 并入校验和 publish 用的 required checks。rebuild 之后目标 SHA 变了就重新读。策略解析失败时拒绝发布，与评审侧「无法解析则交给人」的处理一致。
- native 不改。Squad 和 Best-of-N 自己并入的那部分保留，重复项由现有的去重消掉。

验收：目标策略要求一个 changeset 没有存的检查，该检查缺失或失败时，手动发布被拒绝；目标移动后新增的策略检查同样生效；Squad 和 Best-of-N 的现有行为不变。

### S1-7 CF02：检查在钉住 SHA 的新 checkout 里跑

通用 SCM runtime 的检查改用 Best-of-N 的获取方式：按 changeset 的 head SHA 取一个托管 checkout，检查在它里面执行，报告绑定这个 SHA。同一 head 的多个 profile 共用这个 checkout；每个 profile 跑完后核对 HEAD 和工作区是否仍等于该 SHA，不等就重置后再跑下一个。checkout 在检查执行器结束后才释放。

验收：钉住的提交是坏的、活动目录已修好，检查必须失败；第一个 profile 改了源码，第二个 profile 看到的仍是原始内容。

## 4. S2 放行同目录并发，重叠的轮次只读

见 ADR-0255。现在第二个同目录运行整轮被拒（第 2 节补充核对 1），所以这一段修的是一个现存的功能阻断，不只是归因。它只依赖 S1-0，可以排在 S1-0 之后、与 S1 其余各项并行。

实施步骤：

1. `check_capture_root_admission` 不再因为「已有就地观察 run」拒绝第二个；与停止未确认的 run 相交的拒绝保留。
2. run 上持久化一个 `overlapped` 标记。begin 时发现相交根上有 `Running|Settling` 的 run，给双方都置上；对某个根执行 Apply、Undo 时，该根上活动的 run 也置上。标记只增不减。托管 run 的执行根与就地工作区相交时同样算重叠。
3. settle 时带标记的 run 产出的 patch 置不可逆，原因 `overlap`。diff 照常可读。
4. 同一轮内的父子 agent 仍是一个 capture，不算重叠。外部工具的写入检测不到，继续靠 Undo 的三方合并和冲突报告。
5. 仍会被拒的情况（与停止未确认的远程 run 相交）补一条专门的诊断文案，en 与 zh-CN 都加，不再落到「绑定文件夹」的提示上。

验收：两个 run 在同一目录时间重叠，两边的 patch 都只读且原因为 `overlap`；不重叠的前后两轮各自可撤；重叠的 run 之一先 settle、另一个后 settle，后者仍只读。

## 5. S3 投影与历史

范围是日常能看到的状态错误。远端 Host 的 origin 保留为查询 key，因为有一台 Linux 常驻 Host 在用。

| 项                    | 改动                                                                                                                                                                                                                | 涉及缺口 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S3-1 单调修订         | Host 的 PatchSet 增加单调 `stateRevision`，每次状态变化加一。Dexie 投影在一个事务里合并，拒绝比已存修订旧的结果；不带修订的旧事件触发重新读取 Host                                                                  | CF04     |
| S3-2 统一 reconcile   | `lib/task-workspace/client.ts` 的 single 和 bundle Apply、retry、Undo 走同一个 reconcile 入口，按每个物理 run 的最终结果更新；bundle 的总状态不映射成所有根 Accepted。投影失败标 pending，重连后补，不重发 mutation | CF03     |
| S3-3 turn group       | tracker 把一轮的 user、中间 assistant、收尾 assistant 消息关联到同一组 run；接通 `bind_assistant_message` 的生产调用。Restore 按组解析并去重 run，缺行时先查 Host，不静默跳过                                       | F18、F12 |
| S3-4 读路径状态       | turn card、mobile Changes、Task Resources 区分 loading、missing、expired、conflict 与 empty；mobile idle 后订阅 ledger 失效通知刷新                                                                                 | F08、F11 |
| S3-5 会话身份         | Restore 和分屏使用显式 transcript sessionId，不用 activeSessionId 猜                                                                                                                                                | F10      |
| S3-6 Restore 二次预检 | 确认对话框关闭后在 Host 侧重新预检；旧 turn card 补 busy 的第一道检查                                                                                                                                               | F09      |

S3-1 和 S3-2 先做，其余依赖它们的修订和 reconcile 入口。每项的验收沿用联合审计里的两个交错用例（迟到的 Apply 不覆盖 Undo；bundle 部分成功只更新成功的根）和对应报告条目的复现。

## 6. S4 写入回执，恢复重叠轮次的 Undo

单独立项，S2 稳定后再做。

1. 内置写文件工具（write、edit、apply-patch）经 sidecar 已有的 `file_pre_mutation` 帧，向 Host 上报带 run、路径、写前写后哈希的回执，走现有的 `record_tool_event_with_receipt`。
2. `PatchFile` 增加逐文件的可逆性。重叠的 run settle 时，某个文件从基线到当前的变化能被本 run 的回执链完整解释（首个回执的写前哈希等于基线，末个回执的写后哈希等于当前）的，这个文件可撤；其余只读。
3. bash、MCP 工具、外部 agent 的写入没有回执，在重叠轮次里保持只读。Codex 的路径级事件不带哈希，不当回执用。

## 7. 待办，不排期

- **入口覆盖**（原 W05）：F05 external authority 与 Scheduler signal（含 Scheduler 外部 agent 路径不传 signal、`external/manager.ts` 超时不等取消）、F06 builtin-provider Plugin/Bot `agent.turn` 与 scheduled Goal 的 capture、CF05 Squad target 漂移。按实际遇到的问题逐项修。
- **性能预算**（原 W08）：F13 capture 预算与锁内 I/O、F14 watcher 无界工作、F15 查询重复。S1-5 会让 autocrlf 仓库变慢，出现体感问题时先做 F13。
- **F16** Codex 实时 diff hint：继续延期。
- **不做，除非前提变化**：多文件事务日志与 fsync；durable root reservation 与 participant 注册；native 策略 gate、grant 迁移、evidence receipt。重开条件是插件或组织成员能调用 changeset/integration 命令。目前这些命令已经通过 companion RPC 暴露给配对设备（`workspace.write`、High、Interactive），这一点在重开时要先评估。
- **未验证平台**：Windows/NTFS 的路径与 CRLF 行为，Capacitor 真机。

## 8. 全量缺口映射

| 缺口          | 处理                                          | 位置       |
| ------------- | --------------------------------------------- | ---------- |
| F01           | 先落盘再 rename，回滚含当前项，错误不丢       | S1-1       |
| F02           | 等完成信号；未证实则该轮只读                  | S1-3       |
| F03           | 含反斜杠路径的 patch 不可撤                   | S1-4       |
| F04           | index flag 文件读原字节；submodule 等置不可逆 | S1-5       |
| F05、F06      | 入口覆盖                                      | 待办       |
| F07           | 已撤回，不处理                                | 无         |
| F08           | ledger 失效通知刷新                           | S3-4       |
| F09           | 恢复需根上无活动 run；UI 二次预检             | S1-2、S3-6 |
| F10           | 显式 sessionId                                | S3-5       |
| F11           | 区分 loading 与 empty                         | S3-4       |
| F12、F18      | turn group 与 Host 回查                       | S3-3       |
| F13、F14、F15 | 性能预算                                      | 待办       |
| F16           | 延期                                          | 待办       |
| F17           | 受转换影响的文件读原字节                      | S1-5       |
| CF01          | orchestrator 并入目标策略                     | S1-6       |
| CF02          | 钉住 SHA 的新 checkout                        | S1-7       |
| CF03          | single 与 bundle 共用 reconcile               | S3-2       |
| CF04          | 事务加单调修订                                | S3-1       |
| CF05          | Squad target 冻结                             | 待办       |

## 9. 验证与提交

- native：`cargo test -p cognia-task-workspace`，过滤时一次只传一个 filter。故障注入用现有测试缝，不够时在 `write_entry` 和 `materialize` 加仅测试可见的失败点。
- TS：`pnpm test -- --runInBand --runTestsByPath <具体测试文件>`。不跑全量，不跑 coverage。
- 契约：改 DTO 的项（S1-0、S2、S3-1、S4）跑 `pnpm companion-api:gen` 及其 check，并核对手工维护的 response-schema catalog。
- UI 文案：en 与 zh-CN 分片加 key，`pnpm i18n:build`，`pnpm lint:i18n`。
- 真实环境：S1 和 S2 各做一次 macOS 桌面冒烟（真实模型，取消一轮、并发两轮、恢复一次快照），S3 在 Linux Host 加桌面的配对下看一次历史与 Restore。
- 提交：每项单独提交，命令里写明本项改动的路径；用户可见的项带 changeset。
