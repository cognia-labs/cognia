# Turn diff 审计的对抗性审查

日期：2026-11-10（Asia/Shanghai）。对象：[turn diff 缺口报告](2026-11-10-turn-diff-gap-audit.md)及其探针、支持矩阵和证据等级。按 `doubt-driven` 执行，产品源码保持只读；原报告与 ledger 已根据复核更新。Git fixtures 的本地 index/config 仅存在于新建 cache 目录，主工作树 Git index 未修改。

后续范围扩展到 AgentChangeset/integration/工作区历史，见[跨功能联合审计](2026-11-10-turn-diff-cross-feature-audit.md)。本次对抗复核的17项保留项不等于所有相关产品已完整验收。

## 审查结论

原报告需要纠偏：**撤回 F07 的正常 mobile Host 切换生产缺陷结论；收窄 F03、F06、F08、F12；扩展 F02/F09；补入 F17/F18 两项遗漏。** F01 的失败写入风险经独立提取函数实验保留，并发现补偿失败会丢失此前条目。F13–F15 的资源/算法缺口保留，但不代表已测得生产瓶颈。

修订后有17项保留缺口（4 P1、12 P2、1 P3）；F07 另记为加固义务，不计数。这个分类表示修复优先级与能力缺口，不能读作17项完整真实环境故障均已复现。

三个 fresh-context reviewer 分别审查 native、runtime、UI/performance。只提供 artifact 和 contract，未提供原作者的推理或预期结论。主会话核对 owning source、反例、祖先生命周期及实验边界。已按用户选择**跳过跨模型**，未调用外部 CLI reviewer。

## 需要改变原结论的反例

| 审查项         | 原结论的问题                                                                                                   | 决定性证据                                                                                                                                     | 处置                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A01 · F07      | hook-only 探针假定 Host 切换保留同一 hook，漏掉路由祖先                                                        | 实际 SurfaceAvailabilityBoundary + contract + hook：A online mount，B connecting unmount，B online 重建并重新读 B metadata/body                | 撤回普通切换的 P2 定性；孤立 hook origin 加固保留为未知可达性义务    |
| A02 · F06      | 从 agent.turn 叶子缺 begin 推广为 Plugin/Bot SDK、Goal 全部缺 capture                                          | Plugin Agent SDK 经 executeAgentTurnFromRenderer；external provider 经 central runner 转 Host remote-run owner，await begin 或明确 unavailable | 只保留 builtin-provider agent.turn API/Goal 缺口，避免新增双重 owner |
| A03 · F12      | 未承认 desktop 已有 Host-backed 历史 fallback                                                                  | DockWorkspace 直接列 tasks/runs；TaskResourcesPanel 的 patch 查询与可选 adoption 查询独立，旧 run 可选                                         | 只保留 chat card / turn picker 的 message→run 关联与回填缺口         |
| A04 · F03      | “POSIX 路径”范围过宽，alias 示例缺少显式控制条件                                                               | 普通 Git-backed 路径保留原拼写；有损转换在 non-Git/fallback/include；modified-file alias 缺失会 conflict，错误 Undo 示例事后建立匹配 alias     | 收窄 capture profile 与成功条件；有条件的 P1 路径完整性风险保留      |
| A05 · F08      | 把持续挂载时不刷新推广为所有进入/重连情况                                                                      | inactive Radix TabsContent 卸载，重开 Changes 初始化；正常连接恢复也经过 route boundary                                                        | 保留持续停留 Changes 的新 turn 发现缺口，注明现有恢复入口            |
| A06 · 证据身份 | 初始 native 结果缺 executable hash、fault launcher、fixture/argv/toolchain，单独运行 probe 源码不能重放 RLIMIT | 六个提取函数与当前源码匹配；新 runner 重新编译/注入故障，补充 manifest                                                                         | 修复证据包可重放信息；unknown-revision public binary 仍只是 E3       |

### F07 的正常切换保护确实存在

[surface-contract.ts:61](../../lib/runtime/surface-contract.ts#L61) 将 `/remote-sessions` 标为 offline blocked。[host-orchestration.ts:399](../../lib/companion/host-orchestration.ts#L399) 激活 Host 时先发布 connecting，再 await reload/negotiate/sync；[surface-availability-boundary.tsx:58](../../components/runtime/surface-availability-boundary.tsx#L58) 在非 online 时替换 children。

实际 boundary 与实际 mobile hook 的受控 snapshot/RPC 实验使用相同 sessionId/runId：mounts `1→1→2`、unmounts `0→1→1`；B online 后重新 list/runs/patch，body 也来自 B。它证明原 hook-only 输入遗漏了当前 ancestor 保护，并没有证明所有可想象的 transport hot-swap 都安全。若将来有绕过 connecting/unmount 的入口，再重新验证原点绑定。

### F06 存在不同的 capture owner，不能只检查叶子

[Plugin Agent SDK run.ts:203](../../lib/plugin/agent-sdk/run.ts#L203) 调用统一 agent execution service；cwd-bearing tracked rail 在执行前 acquire bundle。API/Goal 使用 external provider 时，[run-and-capture.ts:917](../../lib/claude/run-and-capture.ts#L917) 转 Host external runner，[remote-run-service.ts:991](../../lib/ai/agent/external/runtimes/remote/remote-run-service.ts#L991) 在 execute 前开 capture 或记录 unavailable。

builtin API/Goal 仍未注入 taskWorkspace，Host builtin RPC 也只在有 envelope 时 begin。因此 F06 收窄后成立；修复不能再替已有 owner 的路径开启第二轮 capture。

## 原报告漏掉或低估的失败

### B01 · P1 · clean Git 的 HEAD 内容不等于实际磁盘 baseline（新增 F17）

当前 [snapshot.rs:630](../../crates/cognia-task-workspace/src/snapshot.rs#L630) 对 clean tracked file 只 lstat，并采用 HEAD oid/size；[service.rs:8093](../../crates/cognia-task-workspace/src/service.rs#L8093) 用 raw `cat-file` 补 before blob。Observed inverse 和 Undo 直接保留/写回这份表示。

两个隔离 Git fixture 初始 status 都为空：

| fixture                  | 原磁盘 bytes（hex） | HEAD bytes（hex）  | 支持性 public-service Undo 结果            |
| ------------------------ | ------------------- | ------------------ | ------------------------------------------ |
| core.autocrlf=true       | `6265666f72650d0a`  | `6265666f72650a`   | Reverted/no conflicts，磁盘变为 HEAD 的 LF |
| 可逆 clean/smudge filter | `576265666f72650a`  | `436265666f72650a` | Reverted/no conflicts，磁盘变为 HEAD 表示  |

物理 bytes 与 Git 的差异为新鲜实验；完整 source chain 为 E2；Undo 实验使用已保存、revision 未知的 native executable，仍仅 E3。未将这个 binary 包装成当前源码构建。Git LFS、working-tree-encoding 与其他 OS 是待测变体，不能称已覆盖。

验收必须 initially clean，capture→edit→Undo 后逐字节比较原磁盘内容。单测 `git status` clean 或文本语义相同不足以验证物理保真。

### B02 · P2 · 正常工具迭代可产生多条 assistant，却只索引 closing reply（新增 F18）

[Claude adapter:934](../../lib/claude/adapter.ts#L934) 保留不同 assistant IDs；[turn-tracker:290](../../lib/code-adoption/turn-tracker.ts#L290) 将每轮 capture 关联到 closing assistant。但 [assistantMessagesAfter:47](../../lib/chat/restore-point.ts#L47) 收集每一条后续 assistant，[loadRestoreTurns:87](../../components/chat/restore-point-dialog.tsx#L87) 对任一 missing correlation 就 throw。

有界实际函数/append 片段实验：`[u,a-tool,a-final]`，row 绑定 a-final、fixture 的 Host mock 假定该 run 的 patch 可用；Restore 首先只查 a-tool，报 `Turn change record is unavailable`，patchReads 为空。由于 patchReads 为空，探针没有建立真实 Host patch 完整性；它证明 correlation 拒绝发生在任何 Host 查询之前。此情况不需要 prune/sync；未执行真实 provider 全链路，不能推为所有 provider 每轮都发生。

修复应使用 turn/message range，并对 run/root 去重；不能任意跳过 missing row 或重复 Undo 同一 run。

### B03 · F09 扩展：旧 turn card 没有 busy 首阶段保护

原报告只指出 Restore modal 已打开后 busy 变化未阻止确认。实际上 [TurnChangesCard:167](../../components/chat/turn-changes-card.tsx#L167) 的 canUndo、button、handler 都没有会话 busy 订阅；[message-renderer.tsx:1239](../../components/chat/message-renderer.tsx#L1239) 也不会因其他新 turn streaming 就卸载旧回复 card。

因此只修 Restore confirm 不够：普通个人会话的新 turn 已在执行时，仍可通过旧 card 打开并提交 Undo。这里是源码可达性结论；没有执行真实并发磁盘 mutation，不宣称已经绕过三方冲突保护。所有 Undo surface 及 Host 的 mutation/execution root fence 应统一验证。

### B04 · F01 强化：补偿本身也可删除此前成功写入的文件

独立重编译的六个关键函数体与当前源码一致。单文件 RLIMIT 故障重复得到 target 缺失；双文件变体第一条写入成功、第二条超限失败，然后第一条的 rollback 也在删原目标后写失败，最终两个目标均不存在。

这是 commit 阶段错误路径，不是“每次容量不足都会丢文件”。blob 容量检查在提交前拒绝可保留原文件；before blobs 也可能供显式恢复。应保留“无自动恢复”的精确说法，不能推广为永远不可恢复。

## 所有原始项目的核对结果

| 原编号 | 结果                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| F01    | 保留 P1，独立故障实验强化；限定到写入/补偿阶段                                                                                          |
| F02    | 保留 P1/E2，区分 builtin owner、Scheduler Host attachment 与 external ordinary cancel；补 manager timeout 不等待 adapter stop 的路径    |
| F03    | 保留有条件 P1，收窄到 non-Git/fallback/include 和 alias 前提                                                                            |
| F04    | 保留 flags/submodule E2/E3；正常 Git bytes 另列 F17                                                                                     |
| F05    | 保留 P2，Scheduler/Best-of-N 直接 manager 路径确实不同于 central Host owner；signal 缺失仅归 Scheduler                                  |
| F06    | 保留收窄后的 builtin API/Goal P2；移除对 Agent SDK/external provider 的笼统缺失判断                                                     |
| F07    | 撤回正常 Host 切换的 P2 结论；孤立 hook 硬化与未来 bypass-boundary 场景保留                                                             |
| F08    | 保留 P2，限定 Changes 持续挂载                                                                                                          |
| F09    | 保留 P2，扩大到没有 busy 首门槛的旧 card                                                                                                |
| F10    | 保留 P2，声明级探针 + fresh message 真实源路径；持久化/timeline 已带 session metadata 的消息不泛化                                      |
| F11    | 保留 P2，preview while store empty 有 ancestor 支持；完整历史到达后重新规划                                                             |
| F12    | 保留 message→run card/picker P2；承认 desktop Task Resources Host fallback                                                              |
| F13    | 保留 E2 资源边界风险；仅内容变化、需要 text hunks 的非 binary 路径起正反 diff，不称每个文本文件都执行                                   |
| F14    | 保留 E2 无界队列/批量工作；Stop 有早退出检查，不称必定处理完所有排队事件                                                                |
| F15    | 保留 O(M×N) 实际 query 工作量；N 有10,000-row retention 上界，missing row 可提前失败，不称每次 Restore 都完成全部 RPC，也不外推真实延迟 |
| F16    | 保留 P3 原生实时 diff 的 metadata-only 能力边界，独立 retained filesystem ledger 不受此结论否定                                         |

## 实际验证与证据身份

原报告的18-suite artifact 摘要核对一致：634 passed、1 failed、1 skipped；没有把原失败悄悄改成通过。本轮另外运行：

```bash
rtk proxy pnpm test -- --runInBand --runTestsByPath \
  components/runtime/surface-availability-boundary.test.tsx \
  components/artifacts/workspace-mode/task-resources-panel.test.tsx \
  lib/plugin/agent-sdk/run.test.ts \
  lib/plugin/api/agent-turn.capture.integration.test.ts \
  lib/chat/restore-point.test.ts \
  components/chat/restore-point-dialog.test.tsx
```

**6 suites、180 tests 通过，无 skipped**；有既有 React act console warnings。测试本身没有覆盖所有新增反例，因此全绿不否定 F17/F18 或 F09。

新增 replay：

```bash
rtk proxy node .cache/turn-diff-adversarial-2026-11-10/ancestor-probe.cjs
rtk proxy node .cache/turn-diff-adversarial-2026-11-10/source-fragments.cjs
rtk proxy node .cache/turn-diff-adversarial-2026-11-10/native-check.cjs
rtk proxy node .cache/turn-diff-adversarial-2026-11-10/git-fidelity-check.cjs
```

这些脚本仅修改自身 cache fixtures；native fault runner 在子进程内注入 RLIMIT/SIGXFSZ。new Rust probe 编译是小型提取函数实验，没有执行全 Cargo rebuild。原 public-service executable SHA-256 为 `0db546498194f8a56aa9631f56a7527b2d8673897e53eb8eedb6cf0571e03e7c`，其链接的 rlib revision 仍未知。

完整 runtime/native/UI reviewer notes、source hashes、输入快照、实际结果、编译/执行身份和测试日志保留于 `.cache/turn-diff-adversarial-2026-11-10/`，并另打包交付。原报告行号来自该目录的 `original-gap-audit.md`；修订后不能按旧行号定位，应用 F 编号对照。

停止条件：本轮发现的实质性问题已逐项分类并修订，不继续扩大无关搜索。真实 provider、native 当前完整构建、设备、跨平台、真实配对切换及并发 Undo/late-write 实验仍是未完成验收。没有修改产品源码、弱化断言、执行 coverage 或接受这些残余风险。
