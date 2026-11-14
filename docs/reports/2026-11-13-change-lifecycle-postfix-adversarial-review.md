# Turn diff 与变更链：修复后的对抗性复核

日期：2026-11-13（Asia/Shanghai）。用户要求：“继续看看还有没有什么问题”。本轮检查当前实现，未修改产品代码；临时探针已撤除，输入、输出和源码身份保留在 `.cache/change-lifecycle-review-2026-11-13/`。

**结论：P1 尚未收敛。确认四个有执行证据的 P1，另有一个源码确认、尚未经过真实双 Host 验证的 P1 风险。** 三个 native 反例实际删除了隔离 fixture 中仍在使用的文件；另一个通过实际 TS 编排代码证明 Best-of-N 会撤销内层的停止保护。此前通过的回归仍保留其具体范围，但不能据此宣布整个变更链完成。

沿用 [ADR-0255](../content/docs/zh/adr/0255-runs-that-share-a-directory-keep-their-diffs-and-lose-undo.md) 和[当前实施方案](../plans/2026-11-11-change-lifecycle-stopgap-and-history.md)：同目录 agent 继续并发；重叠或停止未知时只读；不增加目录独占 writer、quarantine 平台、participant registry、另一套 changeset 或历史数据库。

## 1. 当前源码与证据边界

- 开始时 HEAD 为 `7d3dd4473524207654ada2c241e6b73858079dbb`，复核期间其他会话提交前进到 `1a0409400e4a027684533d24d701a28f3ae22006`。本轮没有提交或暂存。
- 开始时记录 47 个文件的 SHA-256，报告前对比仅 `protocol/companion-commands.json` 因并行工作发生漂移；所复现的 TaskWorkspace、SCM、lease 和执行链源码没有漂移。路由探针读取当前 manifest，所测 interrupt/close 仍声明为 `execution`。
- 当前 native owning crate 经过 Cargo 重新编译；使用公开 service API、独立 SQLite 连接、真实 Git 和真实文件系统。没有复用来源不明的旧可执行文件来证明当前行为。
- TS 探针执行当前源码，通过可控 Host/acceptance/transport ports 注入顺序和故障；这证明编排行为，不证明真实模型进程已在双端被错误关闭。
- 没有新增真实 Tauri、provider、Linux Host、Windows、Capacitor 或生产大仓性能验收。没有运行 coverage；之前的全量测试数字不重复计入本轮。
- 三个独立只读 reviewer 分别检查 native 清理/并发、SCM、停止与身份链。沿用用户此前“跳过跨模型”的选择，没有调用外部模型 CLI。

## 2. P1：本轮确认的问题

### P01：prune 把借用目录当成旧任务私产，删除活跃 bundle 的执行根

**已由当前 native API 复现，影响使用新 stop requirement 的 in-app 路径。**

`begin_run` 对 borrowed lease 保存 `workspace_id=None`，见 `crates/cognia-task-workspace/src/service.rs:1867`。`prune` 先检查旧 task 自己是否可清理，见 `store.rs:1043`、`service.rs:5369`；之后对没有 workspace ID 的 Shadow run 执行 `remove_dir_all`，见 `service.rs:5427`。它没有确认这段物理目录属于仍然 Active 的 bundle，也没有排除其他 task 正在借用该根。

复现顺序：同一 managed bundle 中 task A 完成并正向确认 executor 停止，空 patch Apply 后过保留期；task B 开始，仍有 pending stop requirement，并写入 `peer.txt`；执行 prune A。结果：

```json
{
  "bundleState": "active",
  "pruneAccepted": true,
  "peerRunState": "running",
  "rootExists": false,
  "peerFileExists": false
}
```

这不是“未使用新 stop 字段的旧调用方”专属问题：探针中 A、B 都使用 `begin_workspace_bundle_turn_with_stop_requirement(..., true)`。A 的完成允许历史清理，但不应授予删除 bundle 或 B 目录的权限。数据库仍保留 Active bundle 和 Running B，磁盘目录已消失。

建议复用既有 registry/bundle ownership 和 canonical-root 查询，让 task 保留期清理只清它拥有的资源；借用目录的删除交还既有 workspace 生命周期。在实际删除前，在现有 admission 临界区内复查其他活跃使用者。回归应同时覆盖“B 仍在运行”和“B 已结束但 bundle 仍 Active”，避免仅靠活动 run 检查掩盖所有权错误。

### P02：跨 service 结算覆盖并发重叠标记，Undo 删除另一 agent 的文件

**已由两个当前 service 连接及真实 Git/文件系统复现。**

`settle_run` 在 `service.rs:4743` 读取整份 run，在标为 Settling 后采集文件系统。该锁是当前 service 的 store mutex，另一连接仍可 begin。另一连接通过 `store.rs:1190` 把 A 的持久化 `overlapped` 改为 true；A 随后用旧的内存 run 在 `service.rs:4820` 判断是否不可逆，并在 `service.rs:4872` 整行覆盖回数据库。`store.rs:1086` 的 upsert 没有单调合并。

探针在真实 `git status` 调用处设 barrier：A 进入 settle capture；B begin 并确认数据库中 A 已被标为重叠；B 写 `peer.txt`；释放 A。结果：

```json
{
  "markedOverlappedDuringCapture": true,
  "finalOverlapped": false,
  "patchIncludesPeerWrite": true,
  "patchReversible": true,
  "undoAccepted": true,
  "peerFileExistsAfterUndo": false,
  "peerRunState": "running"
}
```

因此当前“重叠即只读”的约束在跨连接结算时不成立。两个连接在 begin 前均已打开，反例不依赖重启恢复或伪造事件；B 仍在运行，A 的 Undo 已删除 B 的文件。

建议把最终 fresh run 读取、不可逆判断、patch/run 持久化与 overlap marking 放在既有共享 admission/事务边界内协调。仅把 `put_run` 改为 OR 合并仍不充分，因为此前已构造的 patch 可能仍为 reversible；也不能用禁止同目录并发代替修复。

同一 capture 边界还存在源码子情形：borrowed baseline 在 `service.rs:1871` 先采集，到 `service.rs:2096` 才标记 overlap、发布 run；另一个写入者可能在此期间完成。此项并入 P02 的回归范围，**没有单独动态复现或重复计作一个 P1**。

### P03：archive 只保护 in-app pending stop，仍能删除普通活跃 run 的目录

**已由当前 native API 和真实目录删除复现；有明确适用范围。**

`archive_managed_workspace` 在 `service.rs:4232` 找到相交活跃 run 后，只对 `in_app_executor_stop_pending` 拒绝。普通 Running/Settling run 没有该表项时仍继续；非 scratch 根没有后面的 scratch 专用活跃检查。随后 `service.rs:4356` 调用目录移除。

复现：managed bundle 中使用普通 `begin_workspace_bundle_turn` 开始 borrowed run，写 `active.txt`，然后归档其 managed workspace。结果：

```json
{
  "archiveAccepted": true,
  "rootExists": false,
  "activeFileExists": false,
  "runState": "running",
  "workspaceId": null
}
```

**正向对照：** 使用 `executorStopRequired=true` 且尚未确认停止的 run，archive 正确拒绝，目录仍在。因此不能把这个问题写成“三个新接入的 in-app owner 全部不受保护”。但公共 native/Host 入口支持未 opt-in 的 run，生命周期的目录删除不应只依赖可选 stop 表；ADR-0244 的独立 `executor_stop_unconfirmed` 标记也未在此判断中直接检查。

建议复用已有 `active_runs_intersecting` 和停止状态，所有破坏目录的归档分支统一拒绝活跃/未证实停止的使用者，在现有 admission 边界内复查。只延迟归档；不限制普通并发 begin。

### P04：Best-of-N 外层自动 abort，绕过内层“停止未知，保留 checkout”

**实际 TS publication + orchestrator 的受控端口探针已复现；native reset 由源码确认。**

orchestrator 在 `lib/scm/integration/orchestrator.ts:258` 发现停止未证实，返回 `executor_stop_unproven` 并保留 prepared worktree。这一保护本身正确。但 `lib/best-of-n/publication.ts:188` 对所有非 published 且处于 HOLDING 状态的结果自动 `abortIntegration`，不区分这个 reason。native `crates/cognia-task-workspace/src/integration.rs:1344` 的 abort 会 reset integration worktree。

探针使用已通过自身 head 检查的 changeset，在 candidate 检查期间注入停止未知，输出：

```json
{ "reason": "executor_stop_unproven", "operations": ["abort-and-reset"] }
```

同文件 `releaseHeldIntegration`（第 85 行）及 `release`（第 224 行）也会在后续重试/恢复时无条件释放 held run。因此只在当前 publish 分支判断 reason 不足以保护重试和重启恢复。Squad/team 与 workflow 的对应包装没有复现这一自动释放行为，不把它们一起归为有缺陷。

建议让既有 IntegrationRun 的 hold 原因跨 publication/retry/recovery 保留，并让外层释放遵循同一 stop 结果；继续复用既有 SCM state/error、abort 和验收端口。需要覆盖第一次返回、再次 checks、release 和人工 Abort 的可达路径，不能另建通用 quarantine 服务。

## 3. P1 风险：源码与路由探针成立，真实双 Host 尚未验证

### P05：工作区结算绑定了原 Host，但执行器控制和监听仍跟随当前选择

`lib/claude/run-and-capture.ts:1488` 的取消、`lib/ai/agent/agent-executor.ts:883` 的 one-shot 关闭、`lib/best-of-n/runtime.ts:421` 和 Scheduler 延后关闭都调用全局 IPC。`lib/claude/ipc.ts:673`、`:1558` 只提交 session/command ID，没有原 Host。`lib/tauri/transport-routing.ts:196` 在调用时选当前 Host；第 230 行的订阅在切换时离开旧 Host。

执行当前 RoutingTransport、读取当前命令 manifest 的受控探针：A 拥有任务，切换到 B 后，interrupt 和 close 都发往 B；A 后续的 disposal 不再被原订阅观察到。其输出为 `ownerHost=A`、两个控制请求 `host=B`、`ownerDisposalAfterSwitchObserved=false`。

若 B 有同一个镜像 session 的活跃执行器，控制可能停止 B 的工作，而 A 继续运行；如果 B 没有该 session，则可能只表现为 A 取消失效/停止证据永久缺失。**本轮没有在真实配对设备上证明错误关闭进程，P1 是按前一个条件下的影响判定。**

SCM exact-head review 也有相同归属问题：`lib/scm/runtime.ts:146` 获取、`:173` pin、`:206` 清理每次重新获取当前 origin；`lib/scm/host.ts:92` 的默认调用同样跟随全局 transport。A→B 期间可能向 B 发出 unpin/archive，A 留下被 pin 的 checkout。工作区 lease 的迟到 ACK 回归并未覆盖这些控制及清理入口。

建议扩展已有 TaskWorkspaceOrigin/transport owner 绑定到整个操作的 send、interrupt、close、lifecycle subscription 及 SCM acquire/reset/cleanup；不要只给最后 settle 绑定原 Host。真实验收需覆盖 B 有/无镜像 session、A 迟到 disposal、断连和恢复。

## 4. 其余可操作问题

| ID  | 级别与证据                                       | 触发与影响                                                                                                                                                          | 当前锚点与建议                                                                                                                                                                                  |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P06 | P2；实际 orchestrator 受控探针                   | 在 await 策略读取期间取消，零 required checks 时仍执行 publish；输出 `signalAborted=true,outcome=published`。仓库切换/unmount 的 abort 也属于该入口。               | `lib/scm/integration/orchestrator.ts:144` 只在循环开头检查，`:287` 发布前未重查。复用 signal，在破坏性步骤前及跨 await 后确认；已提交的 CAS 另按已发生处理。                                    |
| P07 | P2；真实 Git/native reader + 实际 TS parser seam | `.cognia/workspace.json` 存在但为 UTF-16/NUL/非 UTF-8 时，native 返回 null，策略读取将其当缺失并允许默认 `requiredChecks=[]`。与“无效/不可读应拒绝”的实现声明不符。 | `crates/cognia-git/src/read.rs:216`、`:260`；`lib/scm/review/review-policy.ts:350`。区分不存在与存在但不可读，复用现有 Git 读取错误/策略结果，不扩展成 native 策略平台。                        |
| P08 | P2；实际 lease 受控探针                          | 首次 stop-unproven settle IPC 拒绝，之后真正 stop proof 到达也不再发送确认；后续 settle 重试复用同一 rejection。潜在写入者长期保留，后续轮次被不必要地降为只读。    | `lib/task-workspace/run-lease.ts:153` 先 await，`:162` 才注册迟到 proof；`:137` 缓存 completion。保证真实 proof 的登记不依赖首个 settle 成功，允许明确的失败恢复；不把该问题描述为不安全 Undo。 |
| P09 | P2；源码确认，未动态复现                         | ADR-0244 `executor_stop_unconfirmed` 的 begin 拒绝仍按字符串父子关系比较旧 execution_root 与当前 root，symlink/data-dir 别名可能绕过这条拒绝。                      | `crates/cognia-task-workspace/src/service.rs:1640`。复用已存在的 canonical-root 相交比较；这是旧 worker 隔离边界，不能据此声称已绕过 full Restore 或新 in-app 只读保护。                        |

## 5. 降级、排除和待验证项

这些线索不计入上述四个已复现 P1，避免把端口模型等同真实执行。

1. **普通 sparse-checkout 导致 exact-head 假绿：已排除该触发器。** 真实 Git 对照中 reset 删除了 pinned tree 未物化的 source，没有保留修好后的字节。手动设置 `skip-worktree` 的另一 fixture 确实在 `reset --hard HEAD`、`checkout -- .`、`clean -fd` 后保留修改且 status clean；但没有证明生产 verification checkout 会以普通 sparse provisioning 达到该状态。若后续证明 profile/provisioner 可合法改这些 index flags，再补成可达回归。`assume-unchanged` 的对照被 reset 正确还原。
2. **Scheduler 延后 ACK 关闭下一轮：撤回简单本地场景。** 端口测试证明 task 返回后才 closeSession(sessionId)，其所谓 generation 2 是测试标签；真实本地 `lib/claude/ipc.ts:373` 的 transcript lock 持有到 send ACK，阻止那种本地顺序。配对端 send 分支（同文件第 345 行）走不同路径，Host RPC 也有自己的 admission；是否能与旧 ACK 交错，需要真实双端/Host 级探针。不能用本轮模型测试宣称已经关闭了下一轮真实执行器。
3. **同 turnId、不同 executorId 的 disposal 被接受：条件风险。** `run-and-capture.ts:1556`、Scheduler `index.ts:1046` 用 turnId 或 executorId 匹配；但普通 fallback 不复用同一显式 turnId，默认 UUID 不满足初始猜测。恢复路径显式重用 wire turnId 时仍值得验证，本轮没有证明普通重试可触发。
4. **borrowed baseline 的发布前空窗：并入 P02。** 需要更细的采集屏障回归，不把同一归因/不可逆边界重复计数。

## 6. 复现程序与实际结果

证据目录：`.cache/change-lifecycle-review-2026-11-13/`。探针断言“观察到缺陷”，因此 runner 的 `passed` 表示复现成功，**不是产品修复通过**。

| 程序                                         | 执行与结果                                                                                                                                                                                              | 范围                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `native-cargo-probe.rs` / `native-probes.rs` | 临时 integration test `audit_lifecycle_20261113_f43c2a`，`cargo test -p cognia-task-workspace --test audit_lifecycle_20261113_f43c2a -- --nocapture`；最终 `native-cargo-probe-final.log`，1 probe 成功 | 三个真实 native 反例 + pending-stop archive 正向对照；prune 最终版本两轮均 opt-in stop requirement |
| `ts-probes.cjs`                              | `node .cache/change-lifecycle-review-2026-11-13/ts-probes.cjs`；`ts-results.json` 与 `ts-probes.log`                                                                                                    | Best-of-N 外层 abort、取消后发布、null 策略默认、失败 settle 丢迟到确认、Git flags/sparse 正反对照 |
| `policy-reader-probe.rs`                     | 临时 integration test `audit_policy_20261113_915cba`，`cargo test -p cognia-git --test audit_policy_20261113_915cba -- --nocapture`；`policy-reader-probe.log`，1 probe 成功                            | 真实存在的 88-byte UTF-16 Git blob 被读取为 None                                                   |
| `routing-probe.cjs`                          | `node .cache/change-lifecycle-review-2026-11-13/routing-probe.cjs`；`routing-probe.log`                                                                                                                 | 当前 RoutingTransport 和 manifest，A→B 的错误控制目标与监听迁移；Host 端口是 test double           |
| `scheduler-delayed-disposal-probe.txt`       | 临时同目录 Jest 文件；`pnpm test -- --runInBand lib/scheduler/executors/audit_lifecycle_20261113_2eeaad.test.ts --testNamePattern "audit: delayed owned disposal"`，1 selected passed、128 skipped      | 仅证明回调时序；本地可达性被真实 transcript-lock 代码反证，不能计作真实跨轮关闭                    |

native probe 需要 `COGNIA_REVIEW_FIXTURE_ROOT`（绝对、独立临时目录）和 `COGNIA_REVIEW_REAL_GIT`。`native-cargo-probe.rs` 已含临时 test wrapper，可复制到报告所列临时测试路径运行，再仅删除自己的临时文件。所有 fixture 位于本轮独立临时目录或 `.cache/`，没有对用户仓库执行 reset/clean。直接 rustc 链接失败及早期相对路径 fixture 初始化失败仅作为调试日志，未当成缺陷或通过证据。

## 7. 建议修复顺序与验收

本轮只给出发现与修复边界，未实施以下修改：

| 顺序 | 工作                                    | 必须验证                                                                                                                         | 复用边界                                                        |
| ---- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1    | P01/P03：目录删除遵守所有权与活跃使用者 | expired A + Active bundle；B opt-in/普通 run；Shadow/Git worktree；scratch 正向对照；清理与 begin 交错                           | 原 registry、bundle、canonical root、admission 和 archive/prune |
| 2    | P02：重叠状态和 patch 可逆性原子收敛    | 两 service/连接；settle capture 中 begin；baseline capture 中 peer 完成；标记不回退；Undo 拒绝且 B 文件仍在；并发 begin 保持成功 | 原 store、TaskRun、PatchSet 和 overlap 查询                     |
| 3    | P04：外层释放遵守停止未知               | 首次 publish、再次 checks、release/recovery、人工 Abort；停止仍未知时没有 reset/drop/archive，真实停止后允许既有恢复流程         | 原 IntegrationRun、publication、orchestrator 和验收端口         |
| 4    | P05：固定整个操作的 Host 归属           | A→B 后 stop/close/事件仍属 A；B 镜像 session 不受影响；SCM checkout 在 A 清理；断连与迟到 ACK                                    | 原 origin 和 transport owner，补真实双端验收                    |
| 5    | P06–P09                                 | 每个受控反例先转成失败行为测试，再修复；保留前述正向对照                                                                         | 现有 signal、Git reader、lease、canonical helper                |

P01–P03 同时涉及 `service.rs`，实施时应由同一 owner 顺序修改；不通过抢占整个目录来规避竞态。工作区历史 UI、S3 投影/失效和 S4 归因回执继续留在已有阶段，当前先确保历史清理不会删除活跃目录。性能预算与真实大仓测量仍开放，不从本轮小 fixture 推断吞吐或 RSS。

当前修复状态已回写[原修复记录](2026-11-13-change-lifecycle-p1-repairs.md)、[实施方案](../plans/2026-11-11-change-lifecycle-stopgap-and-history.md)和[原 evidence ledger](../evidence/2026-10-29-turn-diff-completion.md)。原有测试通过事实保留，整体 P1 完成声明重新打开。

## 8. 修复状态（2026-11-14）

| ID  | 提交         | 修复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 回归与残余                                                                                                                                                                                                                                                                                                                          |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01 | `4ab415a796` | prune 只删除 task 自己拥有（有 `workspace_id`）的目录；借用的 bundle/lease 目录交还 workspace 生命周期。自有目录被其他 task 的活跃 run 使用时保留该 task。删除前先取 admission 锁，再取根栅栏。                                                                                                                                                                                                                                                                                          | `prune_leaves_a_borrowed_bundle_directory_to_its_workspace`（B 仍在运行 / 已结束两种）、`prune_keeps_an_owned_workspace_another_task_is_using`。                                                                                                                                                                                    |
| P03 | `4ab415a796` | archive 对所有相交的活跃 run 拒绝，不再只看 in-app pending stop；整个归档持有 admission 锁，检查到删除之间不能开始新 run。                                                                                                                                                                                                                                                                                                                                                               | `archive_refuses_a_plain_borrowed_run_until_it_settles`；原 scratch 与 pending-stop 用例不变。                                                                                                                                                                                                                                      |
| P02 | `4ab415a796` | settle 在 admission 锁下重读持久化的 `overlapped` 再决定可逆性；Apply/Undo 在写入与打标记期间持有同一把锁；`put_run` 永不清除已存的标记。                                                                                                                                                                                                                                                                                                                                                | 独立集成测试 `overlap_survives_concurrent_settle`（两连接、真实 Git、`git status` 屏障），去掉重读后确认失败。borrowed baseline 的发布前空窗由同一把锁覆盖，未单独动态复现。                                                                                                                                                        |
| P04 | `b3ec3118b2` | 停止未证实的扣留写到 Host：orchestrator 随检查记录 `executorStopUnprovenUntil`（检查时限 + 60 秒回收余量；未知时 24 小时，Host 同样上限），Host 把 run 留在 Prepared、`error.code=executorStopUnproven`，在期限前拒绝 abort、drop 和 publish。publication 不再释放该 run，重跑检查与重启 release 透出 Host 拒绝。Agent Changes 的中止需要人确认检查已停止。                                                                                                                              | native 两个用例（期限内拒绝、确认后中止、过期后恢复）、orchestrator / publication / host / runtime / UI 用例。残余：旧版 Host 会忽略新增的可选参数，扣留退化为原行为；期限依赖 Host 在检查时限内回收进程组。                                                                                                                        |
| P05 | `b896d9ee22` | 轮次在订阅时固定 Host：桌面端持有它发送到的 transport，切走的远程 transport 在最后一个持有者释放前不被关闭；发送、interrupt、close 和生命周期订阅都走这条路由，选择已变时拒绝发送。IPC 按会话记录路由，轮次结束且 Host 不再被选中时保留 5 分钟供延后关闭，之后只留名字并拒绝迟到控制。配对客户端无法到达旧目标，目标或路由代数变化后拒绝调用、丢弃事件。变更集检查一次性捕获 origin，检出的获取、pin、重置、归档、changeset 调用和 Git 读取都走该 origin；选中 Host 变化后拒绝运行验收。 | `execution-route`（A→B 后控制与事件仍属 A、B 不受影响、持有计数、配对端失效）、IPC（发送/中断/关闭随路由、选择变化拒绝发送、保留期后拒绝、进行中不释放）、run-and-capture、SCM runtime/host/git/client 用例。残余：未在真实双 Host 上验证；审批、responder 等其他会话内调用仍跟随当前选择；配对端切走后旧轮次的停止只能判为未证实。 |
| P06 | `de829a92a2` | orchestrator 在每次 await 之后、prepare、drop、rebuild、publish 之前都检查 signal；prepare 之前取消则什么都不准备。停止未证实的扣留仍优先于取消；CAS 已提交的 publish 按已发布报告。                                                                                                                                                                                                                                                                                                     | 策略读取、分析、验收检查、目标移动后各一个取消用例，扣留优先与已提交 CAS 两个正向对照；原"开始前已取消"用例改为断言不 prepare。                                                                                                                                                                                                     |
| P07 | `aa2162d6f6` | `git_read_blob_at_ref` 增加可选 `requireText`：开启时 `null` 只表示不存在，存在但为二进制、含 NUL、非 UTF-8（含 UTF-16）、符号链接或目录时报错。审核策略读取使用它，所有调用方本来就把读取失败当拒绝；diff 类调用保持宽松。请求 schema、OpenAPI 与 CLI 索引同步重新生成。                                                                                                                                                                                                                | native：NUL / UTF-16 / Latin-1 / 目录 / 符号链接被拒、宽松读取不变、缺失仍为 `null`；TS：策略读取传 `requireText`、读取抛错即拒绝，git 命令与 SCM service 透传。残余：旧版 Host 会因未知参数拒绝请求，结果同样是拒绝。                                                                                                              |
| P08 | `50520db2bf` | 迟到的停止证明在等待首次 settle 之前登记，每个 stop promise 只登记一次，并在该 settle 返回（无论成败）后再发送；失败的 settle/abort 不再缓存，下一次调用会重试，并重新申请审批（turn 自身的审批范围已随失败关闭）。                                                                                                                                                                                                                                                                      | 首次 settle 失败后真实停止仍发送确认、失败后重试得到新结果且只确认一次、迟到确认失败后重试携带已有证明三个用例；task-workspace 全部 471 个用例通过。                                                                                                                                                                                |
| P09 | `83f47d5f45` | `check_capture_root_admission` 对两侧根都用 `canonical_lock_root`，与 `active_runs_intersecting` 相同。                                                                                                                                                                                                                                                                                                                                                                                  | `an_unconfirmed_executor_closes_its_root_through_a_path_alias`（存储根为符号链接别名本身与其子目录），修复前确认放行。残余：这是旧 worker 隔离边界，不据此声称 full Restore 或 in-app 只读保护有变化。                                                                                                                              |

P01–P09 均已修复。未做：真实双 Host、桌面端冒烟，以及 host crate 全量测试（`cognia-automation` 有其他会话引入的编译错误）。
