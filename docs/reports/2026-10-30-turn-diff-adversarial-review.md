# Turn diff 对抗性审查 — 2026-10-30

**结论：确认 5 个 P1、4 个 P2，当前实现不能验收。** 本轮未修改生产代码或 tracked tests；复现文件与命令输出保存在 `.cache/turn-diff-review-2026-10-30/`。

| 编号 | 级别 | 已确认的问题                                                                | 证据边界                                            |
| ---- | ---- | --------------------------------------------------------------------------- | --------------------------------------------------- |
| F1   | P1   | 文件与 symlink 互换后，Undo 返回成功，却恢复成错误类型                      | 当前 native helper 和真实文件系统，两个方向均复现   |
| F2   | P1   | 第二个 helper 重复 Begin 后退出，会取消原进程仍在执行的回合                 | 两个真实 helper 进程，后续写入被遗漏                |
| F3   | P1   | 运行中打开 Task Resources 面板，会提前标记 ready，导致跳过 Host settle      | 真实组件、store 和 client，RPC transport 为替换实现 |
| F4   | P1   | RPC/SDK 借用会话报错后未停止 executor，却发布 available capture             | 真实 helper/文件系统，provider 为注入实现           |
| F5   | P1   | 已明确无法确认 executor 停止，仍发布 applied/reversible patch               | 真实 helper/文件系统，关闭失败为注入实现            |
| F6   | P2   | 新建文件的第 8192 字节之后出现非法 UTF-8，会使整轮无法生成 patch            | 实际二进制字节复现，EOF cleanup 也失败              |
| F7   | P2   | Autonomous external turn 完全绕过 capture，也没有 unavailable 提示          | 实际 hook 路径，后台事件为注入实现                  |
| F8   | P2   | Unknown-origin 文本 diff 丢失同时发生的 chmod 信息                          | 真实 helper；patch mode metadata 仍正确             |
| F9   | P2   | Restore Point 会撤销所有 roots 与 User/Unknown 文件，确认框却只显示汇总数量 | 源码确认，未执行真实 UI 撤销                        |

本机命令启动已恢复。20 个定向 suite 中 18 个通过、2 个失败：1150 个测试通过、7 个失败、1 个跳过。7 个失败分别来自旧 acquisition fixture、预期 NOTICE 和 microtask 时序假设，不能当成 7 个生产 bug；本报告的缺陷由独立复现确认。58 个文件 scoped ESLint 通过。全仓 typecheck 仍受原有 TUI/account-sync/dock 错误阻挡；两份生成 locale 仍未同步。

以下保留逐项源码位置、复现方法和修复方向的技术说明。真实 provider、安装版 Tauri 和跨设备环境验收不在本轮证据范围内。

This is a read-only review of the turn-diff completion in the shared dirty checkout at HEAD `bf8af10d45`, following the [completion report](2026-10-29-turn-diff-completion.md). Three fresh-context reviewers examined native patch/ownership safety, CLI execution lifetime, and retained UI/Host identity independently. They received source and contracts, without the previous review's conclusions. Findings were reconciled against current source and targeted reproductions. The user's earlier choice of repository-local review was retained; no external review CLI was invoked.

No production source or tracked tests were edited. Reproductions and command output are under `.cache/turn-diff-review-2026-10-30/`. A before/after hash comparison of 67 scoped source files found no changes. Native build/package preparation touched ignored build output only.

## Findings

| ID  | Priority | Finding                                                                    | Evidence                                                         |
| --- | -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| F1  | P1       | Observed Undo restores the wrong resource type                             | Actual current helper and filesystem, both conversion directions |
| F2  | P1       | Another helper's EOF can cancel a live run it never owned                  | Two actual helper processes                                      |
| F3  | P1       | Task Resources reads can suppress final Host settlement                    | Real component, store and client; mocked RPC transport           |
| F4  | P1       | Failed borrowed provider session can publish capture before executor stop  | Actual helper/filesystem with injected provider                  |
| F5  | P1       | Explicit executor-stop failure still publishes an applied reversible patch | Actual helper/filesystem with injected close failure             |
| F6  | P2       | Late non-UTF-8 bytes in a created file prevent patch settlement            | Actual helper and opaque file bytes                              |
| F7  | P2       | Autonomous external turns bypass capture                                   | Actual hook event path with injected autonomous envelopes        |
| F8  | P2       | Unknown-origin textual history hides accompanying mode changes             | Actual helper chmod/content reproduction                         |
| F9  | P2       | Restore Point confirmation omits its expanded root/contribution scope      | Source-confirmed UI/plan contract mismatch                       |

### F1 — P1: Undo reports success after restoring the wrong file type

[ledger.rs:661](../../crates/cognia-task-workspace/src/ledger.rs#L661) derives `AppliedFile.before_kind` from the final `file.resource_kind`, the same value used for `after_kind`. A type-changing edit therefore loses the baseline kind even though the baseline hash and mode are retained.

With the freshly rebuilt helper, a regular file changed into a symlink was undone into a symlink whose target was the original file contents. A symlink changed into a regular file was undone into a regular file containing the old link target. Both operations returned `state: reverted`, with no conflict. This is a false success with an incorrect filesystem result.

Preserve the actual baseline and final resource kinds independently. Do not infer the original kind from the final entry or only from Unix mode bits.

Evidence: [native reproduction results](../../../.cache/turn-diff-review-2026-10-30/native/reproduction-results.json), `file-to-link` and `link-to-file`.

### F2 — P1: Idempotent Begin grants another helper destructive cleanup ownership

[service.rs:1469](../../crates/cognia-task-workspace/src/service.rs#L1469) returns an existing matching run before establishing that this service owns its active capture. [worker_cli.rs:178](../../crates/cognia-task-workspace/src/worker_cli.rs#L178) adds every returned running/settling run to that helper's EOF cleanup set. Closing stdin then invokes `settle_cancelled_run` through [worker_cli.rs:69](../../crates/cognia-task-workspace/src/worker_cli.rs#L69).

Process A began an observed run. Process B repeated the same Begin and received `running`. B exited normally; the run immediately became `cancelled`. A subsequently wrote `later edit by original owner` and settled, but its retained diff still ended at the earlier `first live edit` snapshot. The process-owner lock did not prevent this path.

An idempotent result must not confer ownership of another process's cleanup or settlement. Carry or verify an actual owner lease before adding a run to the worker cleanup set.

Evidence: [native reproduction results](../../../.cache/turn-diff-review-2026-10-30/native/reproduction-results.json), `ownership`.

### F3 — P1: Merely opening Task Resources can strand the running Host lease

The new guard at [client.ts:491](../../lib/task-workspace/client.ts#L491), and the corresponding selection at [turn-tracker.ts:335](../../lib/code-adoption/turn-tracker.ts#L335), require the frontend entry to remain `running` before settling. However, the existing Task Resources list effect invokes [reconcile at panel.tsx:145](../../components/artifacts/workspace-mode/task-resources-panel.tsx#L145), which unconditionally sets the run to `ready` in [task-workspace-store.ts:81](../../stores/task-workspace-store.ts#L81), even while the Host run is still streaming. The component is reachable from Current Task in [dock-workspace.tsx:710](../../components/artifacts/workspace-mode/dock-workspace.tsx#L710).

A component reproduction used the real panel, store and settle client. Without the panel, settlement sent `task_workspace_settle`. With the panel mounted and read RPCs still reporting the run as running, the store became `ready`; settlement returned `null` and sent zero commands. Consequently, normal turn completion can leave the native capture/lease open and block the next send as busy.

Resource refresh must not mark a run terminal. Settlement ownership needs a stable run/lease identity rather than this presentation-state heuristic.

Evidence: [component reproduction](../../../.cache/turn-diff-review-2026-10-30/ui/panel-reconcile.test.tsx), [Jest result](../../../.cache/turn-diff-review-2026-10-30/ui/panel-reconcile-jest.json), [recorded client/store comparison](../../../.cache/turn-diff-review-2026-10-30/ui/panel-reconcile-repro.json). The reproduction replaces transport, not the lifecycle implementation; it is not a real installed-shell test.

### F4 — P1: A failed borrowed session may be captured as complete while its executor is alive

[unified-runtime.ts:468](../../cli/src/agent/runtime/unified-runtime.ts#L468) only closes a provider lease when the turn owns it or the outer cancellation has fired. RPC/SDK callers lend a session across turns. A `send()` rejection outside that outer cancellation can therefore leave the executor alive, while final capture uses the default `executorCloseFailed === false` and returns `available: true`.

The reproduction used an injected provider and the actual current helper/filesystem. After the send rejected, executor close was never called. The retained patch contained `base → early`; a later write by the still-live executor changed disk to `late-tail`, omitted from that patch. Existing inner watchdog rejection is one production path where a send promise can fail without proving terminal drain.

Require positive terminal/drain evidence, or retire a failed borrowed session before settlement. Preserve healthy multi-turn sessions without treating a rejected promise alone as proof of process completion.

Evidence: [CLI reproduction spec](../../../.cache/turn-diff-review-2026-10-30/cli/borrowed-session.repro.test.ts), [verification summary](../../../.cache/turn-diff-review-2026-10-30/cli/verification-summary.json).

### F5 — P1: `executorStopped=false` still publishes reversible native state

[workspace-client.ts:146](../../cli/src/worker/workspace-client.ts#L146) invokes `owner.settle(runId, "failed")` even when `executorStopped` is explicitly false, then closes the helper. Only the returned client receipt is downgraded to unavailable.

With an injected executor whose close rejected, the actual helper returned a retained run in `failed` and a patch in `applied`, with `reversible: true`, although the outer receipt said `capture-failed`. Capture ownership was released and the retained CLI diff/undo APIs could still see that reversible patch. F4 concerns a missing stop check; this finding concerns ignoring a known failed stop check.

Failed execution and an unconfirmed executor stop need different ledger finalization semantics. A client-only unavailable flag cannot make a published native patch unavailable to every other reader.

Evidence: [CLI reproduction spec](../../../.cache/turn-diff-review-2026-10-30/cli/borrowed-session.repro.test.ts), failed-close case in [verification summary](../../../.cache/turn-diff-review-2026-10-30/cli/verification-summary.json).

### F6 — P2: A created opaque file can abort settlement because only its prefix was checked

[ledger.rs:52](../../crates/cognia-task-workspace/src/ledger.rs#L52) now attempts text hunks for created regular files classified as non-binary. [snapshot.rs:1253](../../crates/cognia-task-workspace/src/snapshot.rs#L1253) tests only the first 8192 bytes for that classification.

Creating `data.dat` containing 9000 ASCII `a` bytes, then `0xff` and a newline, caused settle to fail with `git diff returned non-UTF-8 patch for data.dat`. `getPatch` returned null; EOF cleanup failed again and the helper exited 1. The earlier implementation did not build textual hunks for a created file, so this is an expanded failure surface from the current change.

Validate the complete input before treating it as UTF-8, or retain this entry as an opaque/binary replacement instead of aborting the whole run.

Evidence: [bytes reproduction](../../../.cache/turn-diff-review-2026-10-30/native/bytes-results.json), `lateNonUtf8`.

### F7 — P2: Autonomous external logical turns have no capture owner

[useAgentSession.tsx:325](../../cli/src/tui/hooks/useAgentSession.tsx#L325) routes out-of-band lifecycle envelopes directly into the reducer; capture is acquired only in explicit `sendInner`. These are real logical turns: [external-agent-session.ts:1263](../../cli/src/agent/external-agent-session.ts#L1263) allocates separate `oob` run/turn identities for them.

An actual hook-path reproduction emitted `TURN_START → TOOL_CALL → TURN_COMMIT` with zero capture calls and no unavailable receipt. Thus a runtime supporting autonomous/background turns can display a completed tool-bearing turn without the retained diff path promised for explicit sends. This was an injected event source, not a live provider run.

Either provide an execution-side owner before such tool-bearing turns begin, or expose this runtime mode's capture limitation explicitly.

Evidence: autonomous case in [TUI reproduction](../../../.cache/turn-diff-review-2026-10-30/cli/tui-timing.repro.test.tsx), [verification summary](../../../.cache/turn-diff-review-2026-10-30/cli/verification-summary.json).

### F8 — P2: Unknown-origin text reconstruction drops accompanying chmod history

[service.rs:4908](../../crates/cognia-task-workspace/src/service.rs#L4908) reconstructs text for Unknown-origin records and returns it directly, bypassing the real `file_diff_header` when a body diff exists.

Changing content while chmod changes `100644 → 100755` produced correct before/after modes in patch metadata, but returned textual history still declared `100644` and omitted `old mode/new mode`. Native mode metadata and Undo were not shown to be wrong by this reproduction; the defect is incomplete/misleading textual history, including CLI diff output.

Evidence: [bytes reproduction](../../../.cache/turn-diff-review-2026-10-30/native/bytes-results.json), `modeAndContent`.

### F9 — P2: Restore Point confirmation does not disclose its expanded mutation scope

[restore-point-dialog.tsx:95](../../components/chat/restore-point-dialog.tsx#L95) now loads all recorded roots; the plan includes user uploads and Unknown contributions from patch metadata. But [the confirmation at line 318](../../components/chat/restore-point-dialog.tsx#L318) still supplies only file/turn counts. Both locale strings describe changes by the replies and do not identify roots, Hosts, or user/unknown contributions.

For a multi-root restore containing uploads, the user approves aggregate counts and those files on additional roots are also undone. The ordinary turn card now discloses that scope, but the broader Restore Point action does not. Carry affected root/Host and contribution details into the plan/confirmation instead of dropping them to counts. This finding is source-confirmed; no real destructive UI action was performed.

## Verification and limits

| Check                                   | Result                                                       | Meaning                                                                                            |
| --------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Current helper build, `--jobs 2`        | Passed                                                       | Current native source compiled; the prior workstation launch block was not observed in this review |
| Native process/filesystem reproductions | Four findings reproduced                                     | Two helper ownership, two resource-kind directions, opaque bytes and chmod/body cases              |
| CLI cache-only reproductions            | Three findings reproduced                                    | Real helper/filesystem, injected provider/close behavior and autonomous envelopes                  |
| Panel component reproduction            | 1 suite, 2 tests passed                                      | Assertions establish the faulty behavior versus a control; this is not product acceptance          |
| Integrated focused Jest                 | 18 suites passed, 2 failed; 1150 passed, 7 failed, 1 skipped | Existing tests still have gaps; see classification below                                           |
| Scoped ESLint                           | 58 TS/TSX files passed, zero warnings                        | Lint does not establish lifecycle or inverse correctness                                           |
| Scoped `git diff --check`               | Passed                                                       | Selected reviewed production paths                                                                 |
| Root typecheck                          | Failed in existing Transcript/account-sync/dock paths        | No turn-diff-path diagnostic in this run; whole-repository typecheck is not green                  |
| i18n build freshness                    | Failed: both generated locales drift                         | Pending generated message rebuild remains a real release gate                                      |
| Source recheck                          | 67 scoped hashes unchanged                                   | Review did not alter the audited source                                                            |

The seven integrated failures should not be presented as seven demonstrated production bugs:

- Three chat tests replace the entire workspace lease acquisition without activating the real store. The new running-owner check consequently sees no owned run. These fixtures no longer model production acquisition.
- Four TUI tests assume no capture NOTICE and synchronous invocation of close callbacks. A cache-only copy with only those expected-event/timing assumptions adjusted passed 4/4. The tracked tests were not weakened or changed.

No coverage check, broad Rust suite, live model/provider, installed Tauri, physical mobile, or remote sandbox acceptance was run. Reproduction tests that pass here assert bad behavior; they are evidence of the findings, not evidence that the feature passes acceptance.

The freshly built helper SHA-256 is `e9771099942a28555474c831b3aef819186d281a438ecd1459e6bb7df9ae16fc`. Source identities and detailed output are retained in [source snapshot](../../../.cache/turn-diff-review-2026-10-30/source-snapshot.json), [source recheck](../../../.cache/turn-diff-review-2026-10-30/source-recheck.json), [focused Jest JSON](../../../.cache/turn-diff-review-2026-10-30/focused.json), [typecheck log](../../../.cache/turn-diff-review-2026-10-30/typecheck.log), and [i18n freshness log](../../../.cache/turn-diff-review-2026-10-30/i18n-check-final.log).

## Repair order

First repair F1–F5: inverse resource identity, actual process ownership, and proof of executor termination are load-bearing. Then address opaque-byte fallback, autonomous capture coverage, complete textual metadata and Restore Point disclosure. Update the stale fixtures and generated locales, and rerun these adversarial cases alongside the normal suites. No fixes were applied in this review.
