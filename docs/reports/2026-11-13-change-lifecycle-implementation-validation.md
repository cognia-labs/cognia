# 变更链最新实现校验：止血已有进展，恢复保护仍有可复现绕过

日期：2026-11-13（Asia/Shanghai）。范围：当前 checkout `6c373e50441a2b8dd0c98fd458996fffbdb6b26d` **加工作树未提交内容**。本轮只校验、运行隔离 fixtures 和更新文档，未修产品代码、提交或发布。

## 结论

**不能标记整套改造完成。** F01 原件先删除的主要故障已修，irreversible reason 与共享目录重叠标记已经实现；snapshot restore 有新的 staging/rollback 实现，但“活动运行保护”和“不可逆来源拒绝”仍能被绕过。其余五个原 P1（F02、F03、F17、CF01、CF02）没有闭环，其中 F03/F17 已用当前构建的 native API 重新复现，CF01/CF02 已用当前 TS 与受控 ports 重放。

校验依据是取代旧版的 [2026-11-11 stopgap/history 方案](../plans/2026-11-11-change-lifecycle-stopgap-and-history.md)及 [ADR0255](../content/docs/en/adr/0255-runs-that-share-a-directory-keep-their-diffs-and-lose-undo.md)。不重新要求旧方案的独占 writer、durable reservation、native grants 或多年数据迁移；共享根保留 diff、保守关闭 Undo 是本轮实际契约。

## 1. 已实现、部分实现和未实施必须分开

| 最新工作项                    | 当前判定                       | 证据与边界                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-0 不可逆原因               | **已实现，范围有限**           | Rust/TS/契约已有 reason，Task Resources 有说明；旧 reversible:false 缺 reason 仍为 false，不把更早缺 reversible 的默认行为说成一律只读；turn card/Restore 按原因解释仍未补。reason 有定义不代表各安全路径已经设置 |
| S1-1 / F01 原件保护           | **主要故障已修**               | `ec1748470e`；`write_entry` 先写临时文件/设 mode 再 rename，失败路径原样；11 个 focused ledger tests（含故障注入/补偿） 通过。多文件补偿错误保留可见，但不保留 provenance pin 是最新方案明示取舍                  |
| S1-2 snapshot restore         | **部分实现，当前验收不通过**   | dirty `service.rs/lib.rs` + untracked `restore.rs` 已接通；4 个 restore helper tests 通过，但活动运行拒绝测试失败；另有 N02 真实 API 绕过                                                                         |
| S1-3 / F02 停止未证实只读     | **未实现**                     | lease settle/abort 没有 stop promise/reason 参数；generic service、Scheduler、Best-of-N builtin 仍未消费 executorStop                                                                                             |
| S1-4 / F03 不支持路径只读     | **未实现，当前 native 复现**   | literal backslash 仍变为 `/`，patch 仍 reversible；Undo 在当前 fixture 返回 Conflict，未撤销实际文件                                                                                                              |
| S1-5 / F04/F17 物理字节       | **未实现，当前 native 复现**   | clean CRLF/filter 使用 HEAD oid，Undo 写回 normalized bytes；index flags 掩盖变化                                                                                                                                 |
| S1-6 / CF01 发布策略并集      | **未实现，当前受控重放**       | orchestrator 仍不读取 prepared/rebuilt target SHA 上的 policy                                                                                                                                                     |
| S1-7 / CF02 exact-head checks | **未实现，当前受控重放**       | 通用 runtime 仍返回 mutable executionRoot；没有 checkout/profile 间 reset。Best-of-N 的独立获取是已有局部能力                                                                                                     |
| S2 同目录并发只读             | **核心已实现，恢复边界不完整** | overlap 持久化并使 patch 不可撤；相关 native cases 通过；但 managed overlap patch 仍能 snapshot restore，见 N02                                                                                                   |
| S3-1/S3-2 adoption            | **未实现**                     | CF03/04 原受控用例在当前源码仍复现；settle resource reconcile 不能替代 Apply/Undo adoption reconcile                                                                                                              |
| S3-3–S3-6 历史/Restore        | **主体未实现，局部状态已有**   | closing-only correlation、active session fallback、mobile idle discovery、确认后二次预检仍缺；已有 Host fallback 和部分 mobile loading/error 保留                                                                 |
| S4 写入回执/逐文件 Undo       | **未实现，基础原语存在**       | 当前 TUI 已消费 `file_pre_mutation` 做 checkpoint；尚非 Host before/after hash receipt chain，PatchFile 也无逐文件 reversible                                                                                     |
| F05/F06/CF05、F13–F16         | **已知待办/延期**              | 不计作已完成工作项回归；没有新性能数据或实时 diff UI 完成证据                                                                                                                                                     |

S1-2 尚未提交的实现也在本轮测试中，不能只用 HEAD 排除它；同样不能把它记为已合入修复。旧方案头部已经有 Superseded 标识，无须恢复其废弃设计。

## 2. 当前可复现的恢复问题需要优先处理

### N01 · P1 · canonical alias 漏记 overlap 并绕过活动根的 snapshot restore 拒绝

当前测试命令：

```sh
rtk proxy cargo test -p cognia-task-workspace --lib a_snapshot_restore_is_refused -- --nocapture
```

实际结果：**0 passed / 1 failed，exit 101**。`a_snapshot_restore_is_refused_while_a_run_is_active_in_its_directory` 在 [service.rs](../../crates/cognia-task-workspace/src/service.rs#L14176) 的 `unwrap_err()` 得到 `Ok(TaskRun)`。

[restore_run_snapshot](../../crates/cognia-task-workspace/src/service.rs#L5436) 使用 [active_runs_intersecting](../../crates/cognia-task-workspace/src/store.rs#L1109) 预检；后者按存储路径直接 `Path::starts_with` 比较。当前 macOS fixture 的 managed root 保存为 `/var/...`，观察运行使用 canonical `/private/var/...`，同一物理目录未被识别为相交。准入锁能序列化检查和替换，但不能修正错误的根身份判断。

补充实际 API fixture 在 canonical `/Users/.../.cache` 下通过 data-dir symlink 制造同样的身份差异：两个字符串路径 canonical 相等，observer 未标 overlap、managed patch 仍 reversible；observer 仍 Running 时 restore 成功并删除其后建文件。故不只是测试临时目录特例，还影响 S2 的 overlap 标记。

最小后续：只在既有 restore/admission 边界统一 canonical identity，覆盖同根、祖先/后代及 symlink aliases，并保留恢复期间 begin 等待的最新契约；不引入一般 writer 独占。先让该失败测试通过，再补 canonical/noncanonical 正反对照。

证据：`.cache/change-lifecycle-validation-2026-11-13/native/logs/focused-02-a_snapshot_restore_is_refused.txt`。

### N02 · P1 · overlap patch 的整目录 snapshot restore 未受不可逆标记约束

当前构建 public API fixture：

1. managed run 与一个直接观察该 executionRoot 的 run 同时存在。
2. 改文件并 settle 两个 run；managed patch 得到 `reversible=false, irreversibleReason=overlap`。
3. 在 managed execution root 创建 `later.txt`。
4. 调用 `restore_run_snapshot(managedRunId)`，**返回成功，later.txt 消失**。

这不是旧方案的额外要求：ADR0255 §2 明确要求 overlap patch 不允许 Undo 或 snapshot restore。当前 restore 只检查 isolation/保留数据/活动根，没有根据源 run/patch 的 irreversible reason 拒绝，因此待所有运行结束后仍可重建混入他人变化的历史目录。

最小后续：在任何目录写入前，验证源 run/patch 的可恢复条件并给出对应原因；overlap/stopUnproven 等来源限制必须进入 Host restore gate。读取历史 diff 不受影响。补“只读来源 + 无 active run + 后续用户文件”的行为回归，并覆盖 missing patch/reason 的实际兼容约定。

证据：当前构建 probe 的输出为 `patchReversible:false, reason:"overlap", restoreAccepted:true, laterFileExists:false`，见 `native/logs/current-public-api-probe-v3-output.jsonl`。这是实际临时文件的 native 操作，不是 fake Host。

## 3. 原六个 P1 的当前状态

| 项目 | 当前校验结果                                                                                                                                                                                               | 后续动作                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| F01  | **主要原件删除故障已修**；单文件写失败与已完成项补偿 cases 通过。未宣称多文件 crash 原子性/fsync，最新计划明确不做                                                                                         | 保留本轮失败注入；修正文档旧映射里“失败当前项也回滚/保留 pins”的过期措辞                               |
| F02  | **Open**。`run-lease.ts` 只有 finalState，无 stop evidence；`agent-execution-service.ts` catch 直接 abort；Scheduler abort 立即结束并 settle failed；native 没有生产 StopUnproven 标记路径                 | 按 S1-3 接通 stop promise 与只读结果；不重新引入已否决的目录 quarantine                                |
| F03  | **Open，native reproduced**。非 Git literal `a\b.txt` 被记录为 `a/b.txt`，`reversible=true`；Undo outcome 为 Conflict（Rust Result::Ok 不等于 Reverted）；literal 文件仍为修改后的内容，slash 文件保持原值 | 实施 S1-4 的 scoped pathUnsupported；既有 Git path 正常能力不一概降级                                  |
| F17  | **Open，native reproduced**。确认为 clean Git row 后 CRLF→Undo 得 LF；filter 的 SMUDGED→Undo 得 CLEAN；仍宣称 reversible                                                                                   | 实施 S1-5 对 attrs/config/index flags 的 raw baseline 采集；验证真实 Git preconditions                 |
| CF01 | **Open，controlled actual-TS reproduced**。policy required profile failed，stored requirements 为空，manual-style prepare/publish 仍收到空列表                                                             | 在唯一 TS orchestrator 按每次 prepared/rebuilt expectedOldSha 读取策略并并集；无须旧 native grant 体系 |
| CF02 | **Open，controlled actual-TS reproduced**。pinned commit 为 broken、live root 为 fixed，fake sandbox 测到 fixed，report 却标 pinned SHA 为 passed                                                          | S1-7 每 head fresh checkout，按最新选择在 profile 间核验/复位，停止后清理                              |

F03 当前 probe **没有制造匹配内容的 slash alias**，所以本轮直接证明“错误路径 key + 冲突且未撤真实文件”，不扩大为已复现撤错另一文件。F17 首个 CRLF control 因 Git status 仍 dirty 而走 raw overlay，确实能够原样恢复；刷新 index 并证明 clean 后的后续 fixture 才复现 normalized Undo。两组结果都保留，不能用一个通过或失败 control 代表所有路径。

F04 的 assume-unchanged/skip-worktree current-native fixtures 另表明：磁盘确有变化，patch 却为空且 reversible；S1-5 仍需处理，不能以新 archive 路径的 byte-preservation tests 替代 capture/Undo。

CF01/02 探针用实际 TS review/orchestrator/acceptance report builder，Host/执行 sandbox ports 受控；`published` 是 fake Host 返回，**没有执行真实 Rust Git publish**。Squad/Best-of-N 已有的 policy union、Best-of-N head checkout、防脏目标/CAS 保护仍存在，不能推广为全部入口都绕过。

## 4. 投影、历史和入口覆盖的原缺口仍有清晰边界

| 条目    | 当前事实                                                                                                                                                             | 对应阶段                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| CF03    | Bundle Apply/retry/Undo 发 ledger notification，但不调用 adoption projection；受控两根 Host Applied→Reverted，本机仍 Pending、projectionCalls=0                      | S3-2                           |
| CF04    | 两根并发更新整行丢一根；迟到 Apply 可覆盖已完成 Undo 的本机投影。当前无 Host stateRevision，也无包住 read-modify-put 的事务                                          | S3-1，先于 S3-2                |
| F08     | mobile Changes 只在已知 unsettled run 存在时轮询，连续打开 idle 页面仍不能发现新 run；重开/reconnect 可刷新                                                          | S3-4                           |
| F09     | 旧 card 无 busy gate；Restore 初始按钮有 busy，但确认后不复检。Host Undo 后标 active run overlap，不能当作 S3-6 预检已完成                                           | S3-6；snapshot 的 N01/N02 另计 |
| F10     | 新消息无 metadata.sessionId 时，card/Restore 仍用 activeSessionId；已有 transcript context 没用于这两项                                                              | S3-5                           |
| F11     | 完整历史仍在加载时 preview 的 Restore 可显示 files.none；mobile 已有一些 loading/error 状态，不能说全部缺失                                                          | S3-4                           |
| F12/F18 | tracker 仍只绑定 closing assistant；Restore 逐 assistant 查本机 row，遇中间消息缺 row 即终止；未接 native message binding/Host group 回填                            | S3-3                           |
| CF05    | Squad base target 仍在 reconcile 时读 currentBranch；dispatch-frozen target 尚未实现                                                                                 | 明确延期                       |
| F05     | Scheduler external 仍未向 executeOnExternalAgent 传 signal；Best-of-N 已传 signal。现有 headless placement checks 不等于各路径已用 filesystem-authority capture 策略 | 入口覆盖待办                   |
| F06     | builtin-provider Plugin/Bot agent.turn 与 scheduled Goal 仍可直接 runAndCapture；Plugin Agent SDK 的 executeAgentTurn 下层覆盖保持有效                               | 入口覆盖待办                   |

详细源链见 `.cache/change-lifecycle-validation-2026-11-13/scm/notes.md` 与 `history/notes.md`。特别保留三项反过度结论：桌面 Task Resources 的 Host-backed fallback 已有；正常 mobile Host 切换 F07 仍撤回；service 已有 task 排序，不能复活“冷恢复总选最早 task”的猜测。

Task Resources/history 的 retained origin helper parity、真实双 Host lifetime 与 checkpoint invalidation 仍需实际流程验证，本轮没有把它们升级为已证 wrong-Host mutation。

## 5. 性能和相邻新功能不能代替变更链验收

- **F13–F15 仍是待办。** ordinary capture 未传 work budget、settle 锁内 I/O、watcher channel/batch 无界、per-message session filtering 与串行 Restore 查询仍可在源码定位。当前已有 budgeted replica、输出 cap、Git cache、trace/capture correlation 和 transcript virtualization，应复用。此次没有运行性能 benchmark，不报新的 latency/RSS，也不复用 2026-11-10 synthetic timing 当今天的生产数据。
- **F16 仍延期。** Codex `turn/diff/updated` 仍是 session.metadata 的单值；当前 Codex history/usage/Opik/observability 更新不等于 keyed turn diff、持久 review 或 UI consumer。
- **S4 的一条历史事实必须纠正。** [TUI useAgentSession](../../cli/src/tui/hooks/useAgentSession.tsx#L541) 已消费 `file_pre_mutation`，交给 [checkpoint-capture](../../cli/src/tui/runtime/checkpoint-capture.ts)。它是 before checkpoint，不是 Host run/path/before+after 哈希链；仍不能据此恢复 overlap 文件级 Undo。
- **停止未证实后下一轮 baseline 的保证有时间前提。** ADR0255 说 late write 会进入下一轮 baseline，仅当写入发生在下一轮 begin 之前成立。若 begin 先发生，旧 executor 的晚写可能进入下一轮 diff。S1-3 验收必须包含此交错；可继续允许并发，但需明确后续轮次的只读/污染传播或真实停止观测，不能声称单纯放行就能保证 baseline。当前 S1-3 本身尚未实现，此项不误计为一个已落地新回归。

## 6. 本轮实际运行结果

| 检查                               | 实际结果                                                                                                                 | 证明范围                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| current native build               | **成功**，实际编译当前 lib 和 dirty restore 路径；unique focused tests **32 passed / 1 failed**；binary/rlib hashes 保留 | macOS 当前 native fixtures，不是已安装 Tauri/provider                                                                             |
| restore helper                     | **4 passed**                                                                                                             | staging/替换/回滚 helper 的既有断言                                                                                               |
| focused ledger tests（含故障注入） | **11 passed**                                                                                                            | 写失败/补偿及其他 ledger 既有断言；不扩大为 fsync/crash guarantee                                                                 |
| active-root restore refusal        | **0 passed / 1 failed，exit 101**                                                                                        | N01 的现有回归测试确实失败                                                                                                        |
| native public API probes           | **N02、F03、F17/F04 已复现**；passing controls 同时保留                                                                  | 实际临时 Git/filesystem + 当前构建；身份见 native logs/manifest                                                                   |
| runtime focused Jest               | **6 suites / 297 tests passed**，0 skipped                                                                               | 既有 lifecycle/reason/support assertions，不补证缺少的 stop-unproven 流程                                                         |
| cross-feature focused Jest         | **17 suites passed / 1 failed；533 tests passed / 1 failed**，0 skipped                                                  | mobile `use-session-changes.test.ts:215` 仍期望 zero-hunk 不读取 diff，与当前 retained-text reconstruction 语义不一致；未修改断言 |
| actual-TS controlled probes        | **两组脚本 exit 0**，表示成功复现 CF01–CF04 缺陷                                                                         | fake Host/database/sandbox ports；不是修复通过                                                                                    |

Jest 两批无重叠：合计 **24 suites、830 tests passed / 1 failed，0 skipped**。这些 passing suites 仍缺 policy-at-prepared-SHA、pinned-broken/live-fixed、并发 projection、intermediate assistant group、late busy/mobile idle discovery 等关键 acceptance assertions，不能用 green 个数抵消已重放的缺陷。

复现命令和完整输出：

- `.cache/change-lifecycle-validation-2026-11-13/runtime-tests.{json,log}`、`cross-feature-tests.{json,log}`；使用仓库 `pnpm test -- --runInBand --runTestsByPath ...`，未运行 coverage。
- `scm-contract-probes.cjs` / `scm-probe-results.json`；`adoption-probes.cjs` / `adoption-probe-results.json`。
- `native/logs/`：每个 cargo filter、当前 public API probe 源码/输出、cargo build JSON 和 native artifact 身份；保留首次 CRLF control 与后续 clean-row preconditions。
- 各领域 `source-hashes.json`、root initial/final source validation；只有带当前源码/构建身份的结果计本轮 native 证据，不沿用 UNKNOWN-revision helper。

未运行完整仓库 typecheck/lint/build、真实模型、Tauri UI、Linux paired Host、Windows 或 Capacitor 真机。本次未修改产品源码，故不宣称这些边界已通过；native build 与 focused tests 的真实结果如上。

## 7. 校验后的最小执行顺序

1. **先补 N01/N02**：restore canonical active-root 判断、不可逆来源 gate；复用现有 admission/staging，不重建整套根锁。
2. **继续 S1-3–S1-7**：stopUnproven、pathUnsupported、物理 baseline、orchestrator policy union、fresh check checkout。保留 F01 已修路径；不把 pending 当已完成。
3. **S3-1→S3-2→S3-3–6**：先 transactional/versioned projection，统一 single/bundle reconcile，并按每个物理 run 的最终结果更新，再修 turn groups/Host 回查、状态、会话身份与确认预检。
4. **S4 与原待办仍独立**：TUI checkpoint 可复用，但不是 receipt chain 已完成；性能在实际预算/测量前保持待办；CF05/入口覆盖按新方案排序。

本报告是 G7 的当前实现校验结果。已实现能力予以保留，失败测试和未验证环境继续进入 [原 evidence ledger](../evidence/2026-10-29-turn-diff-completion.md)，不替用户接受残余风险，也不把本次校验当作实施或发布授权。
