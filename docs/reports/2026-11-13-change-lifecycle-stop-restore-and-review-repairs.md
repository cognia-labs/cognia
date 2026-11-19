# Turn diff 与变更链 P1 修复记录

日期：2026-11-13（Asia/Shanghai）。范围：先修复 N01/N02，再补齐[最新止血方案](../plans/2026-11-11-change-lifecycle-stopgap-and-history.md)剩余 P1；保留 ADR-0255 的同目录并发，不扩展到 S3/S4 和性能待办。

下列记录保留本轮已实施的修复及其核心回归事实。**后续对抗性复核已重新打开整体 P1 完成结论**：发现 prune 删除活跃 bundle 根、跨连接 settle 丢失 overlap、archive 删除部分活跃根及 Best-of-N 外层 abort 绕过停止保护；见[修复后复核报告](2026-11-13-change-lifecycle-postfix-adversarial-review.md)。真实应用、模型及配对环境也尚未完成验收，不能将下列结果视为整个变更链或所有环境已通过。[前一份校验报告](2026-11-13-change-lifecycle-implementation-validation.md)保留为修复前基线。

## 最终行为

| 项目            | 修复                                                                                                                                                                                                              | 复用的 owner                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| N01             | 活动根比较复用 `canonical_lock_root`，覆盖 symlink、相同/相交目录和缺失后代。并发 begin 放行，重叠轮次只读；整目录 Restore 拒绝相交活动运行。                                                                     | TaskWorkspace store、原 restore admission lock                          |
| N02             | 物化/替换目录前拒绝所有不可逆源 patch，包括旧的无 reason 不可逆记录；不能用 snapshot Restore 绕过 Undo 限制。                                                                                                     | `IrreversibleReason::undo_refusal`、原暂存/替换流程                     |
| F02             | 三个 in-app owner 在 begin 提交 `executorStopRequired`，Host 在 turn 返回前记录可能写入者。legacy settle 也不能提前发布可撤销 patch；后续运行仍受污染保护，目录保持可用。                                         | 原 bundle lease、SQLite store、Host/RPC 命令                            |
| F02             | 停止证据最多等待 2 秒，结算 IPC 另计；未证实停止则只读。正向停止确认单调生效；迟到 ACK 不重捕获、不改首个 terminal outcome、不恢复旧 Undo，并保持原 Host/approval。多个重试的 stop promise 全部聚合。             | 原 capture stop promise、origin、standing approval                      |
| F02             | 自建 one-shot runtime 显式关闭，等待实际 disposal。复用会话保留上下文，并按本轮观察到的 executor ID 接受同一 loop 后续 disposal。Scheduler 取消不被 send ACK 卡住，发送前取消也传到 IPC。                         | `closeSession`、`executor_started` / `session_disposed`、PromptDelivery |
| F03             | 非 Windows 保留真实 backslash key，与 slash 路径并存；涉及这类路径的 patch 标记 `path_unsupported`，不再命中另一个文件。                                                                                          | 原 snapshot walk、include、patch reason                                 |
| F17 / F04       | begin、settle 都批量检查 attrs、转换配置和 index flags；只对可能受影响及 status 路径读物理字节。相同哈希继续复用 Git blob，不同字节进入现有 blob store。                                                          | 原 Git-backed capture、blob store、Undo                                 |
| Git fidelity    | LFS、gitlink、未物化条目保留不确定性，包括本轮新建的 LFS 文件和 index gitlink；相关变化标记 `fidelity_unknown`。full Restore 另外拒绝无法完整重建的 snapshot，避免删除干净 submodule；普通逆向 patch 不必触碰它。 | `WorkspaceSnapshot` 内部元数据、现有 reason                             |
| CF01            | prepare 后读取 `expectedOldSha` 策略，rebuild 后重读。policy-only head 检查缺失/失败/过期均拒绝；candidate 和 publish 使用所有要求的并集；策略无效/不可读时关闭入口。                                             | review-policy parser、SCM orchestrator、native gate                     |
| CF02            | 通用 runtime 接管原 Best-of-N 的按 SHA 获取方式；Best-of-N 委托同一实现。一次 review 只获取一个 checkout，多 profile 共用；获取后再核对 head，无检查则不获取。                                                    | Registry acquire、GitRef、provisioning、acceptance port                 |
| CF02            | 每个 profile 执行前 reset pinned SHA、清理 untracked，并删除声明的 report，包括 ignored/committed report。reset 失败不执行；未知停止时不再 reset/archive/drop/rebuild。                                           | SourceControlService 原 Git wrappers、guarded file bridge               |
| Checker cleanup | container 删除失败不能返回成功；macOS 成功退出也必须终止并确认 owned process group 消失，之后才允许释放 checkout。提前错误/取消保留 kill-on-drop，建组失败拒绝启动。                                              | 原 sandbox runner、`proc_group` helper                                  |

没有增加目录独占 writer、quarantine、participant registry、另一套 changeset/快照仓库或历史数据库。新 stop 表属于原 TaskWorkspace SQLite owner，只记录 in-app run 的停止证据。watcher 初始化失败发生在 executor 获得 turn 之前，清除对应 stop requirement，避免留下永久的虚假写入者。

## 验证结果

日志根目录：`.cache/change-lifecycle-fix-2026-11-13/`。保留初始源码副本、RED/GREEN、审查记录、局部格式化记录和最终源码哈希。

| 检查                                                      | 实际结果                                | 证据 / 限制                                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 相关 Jest，14 suites                                      | **767 passed，0 failed**                | `ts-complete.log`；其后 Scheduler executor-ID 复核 **128 passed**，`scheduler-loop-final.log`，不重复累计                                               |
| `cargo test -p cognia-task-workspace -- --test-threads=4` | **686 unit + 10 integration passed**    | `native-resource-bounded-final.log`；最终源码包含新建 LFS/gitlink 回归。较早默认并行复跑遇磁盘 I/O 错误，清理本轮缓存后限制测试 worker 数并全部复跑通过 |
| `cargo test -p cognia-exec-sandbox --lib`                 | **227 passed**                          | `sandbox-full.log`；包含实际 macOS Seatbelt 和进程测试                                                                                                  |
| Host stop round-trip 回归                                 | **1 passed**                            | `host-stop-roundtrip-final.log`；覆盖 required-at-begin、legacy settle、late ACK、watcher 失败                                                          |
| RPC 可选 stop 字段测试                                    | **构建阻塞，未执行**                    | `rpc-stop-contract.log`：依赖编译 `No space left on device`；生成契约检查通过不能代替此测试                                                             |
| scoped ESLint                                             | **通过，0 warnings**                    | `scoped-lint.log`、`scheduler-lint-final.log`                                                                                                           |
| Companion/CLI generation + check                          | **通过，contract v4**                   | `contract-generation-final.log`、`contract-final.log`；begin/settle 可选 stop 字段已进入生成契约和 OpenAPI                                              |
| Command parity / manifest                                 | **通过**                                | `parity.log`：300 literal commands 均注册；1799 descriptors 覆盖 1352 Tauri registrations 和 1000 remote commands                                       |
| Static export                                             | **通过**                                | `static-export-final.log`：12427 TS files，无新增 Node-only bundled import                                                                              |
| OpenAPI lint                                              | **通过，12 warnings**                   | `api-lint.log`；未隐藏现有 warnings                                                                                                                     |
| 独立复核                                                  | native / wiring / test-gap / PII 已复核 | 原审查新增的具体 P1 均已修复；用户此前选择跳过跨模型，本轮未调用外部模型 CLI                                                                            |

有效 RED 包括 `restore-red.log`、`aliases-red.log`、`path-red.log`、`fidelity-red.log`、`flags-red.log`、`policy-red.log`、`pinned-runtime-red.log` 和对应 GREEN。不是仅在修复后添加永远通过的断言。

特别边界已有回归：

- Git before 和 after 都构造成 **status clean** 的 CRLF/filter/UTF-16/autocrlf fixture，检查 retained after blob 为物理字节，Undo 精确恢复 before；index flag 也覆盖 begin 后才添加。
- exact-head 使用真实 Git 和真实检测进程：live 已修好、第一 profile 也改源码，两个 profile 的检测 exit code 仍为 **1**，且第二个看不到旧 ignored report。acquire/sandbox transport 是 test double，此结果不冒充完整 native acceptance。
- macOS writer 先确认实际启动，再证明成功返回后发生晚写：`sandbox-stop-red-v3.log` 有效失败，`sandbox-stop-green.log` 通过。更早 fixture 的路径/权限前提不成立，不作为有效 RED。
- 本轮新建 LFS/gitlink 也有有效失败与通过记录：`created-fidelity-red.log`、`created-fidelity-green.log`。attrs 查询覆盖 HEAD + status 路径，index 元数据复用原 `ls-files` 查询。
- begin flag、Host A timeout 后切换 B 的 late ACK、两个独立 stop promise、获取 checkout 期间 head 移动均有显式断言。

## 尚未完成的验收

1. **真实 Tauri、模型和跨设备流程未验收。** Tauri 启动在编译阶段遇到 ENOSPC，未打开可用新应用；已停止本会话追踪的启动进程。RPC 定向测试同样被磁盘阻塞。释放空间后需重跑 RPC、Tauri 取消/并发/Restore、真实模型与 Linux Host 配对。Windows、Capacitor 和生产静态导出构建也没有新增验收声明。
2. **仓库全局门禁有范围外失败。** `pnpm lint`：0 errors / 10 warnings，因 `--max-warnings=0` 失败。`pnpm typecheck`：20 条诊断来自 8 个范围外路径，本轮受影响路径无诊断。Host parity 指向未改动的 `lib/terminal/serial-session.ts` unpinned subscribe。分别见 `lint.log`、`typecheck-final.log`、`parity.log`；没有改 unrelated code 或刷新 baseline 掩盖。
3. **持久会话的未知停止仍会保留只读。** 不为恢复 Undo 强行关闭用户复用的 conversation；在实际 disposal 前，该轮及受污染轮次不可撤，目录继续可用。主动逃逸 owned process group 的恶意 daemon containment、MCP/hooks/LSP 全面进程生命周期没有在本轮作新保证。
4. **性能未作新承诺。** 普通 clean 文件继续复用 Git blob，但增加批量元数据查询；autocrlf 等配置可能读更多路径。回归耗时不代表大仓吞吐、RSS 或 UI 性能，预算与测量仍按 F13–F15/F18 待办推进。
5. **S3/S4 和其他 P2 保留。** adoption/history 投影、checkpoint/invalidation、精确消息 provenance、多根导航、F05/F06/CF05 等不属于本次 P1 补齐。此前 mobile zero-hunk fixture 没有改断言掩盖失败。

工作期间 HEAD 从 `6c373e50441a2b8dd0c98fd458996fffbdb6b26d` 因其他会话提交前进到 `2692107ecb2c7b61dbbda477aa70d80a640e133b`。本会话没有提交、切分支或恢复他人源码；仅清理了本轮生成的可重建编译缓存。实现与核心回归完成，完整环境验收仍开放。
