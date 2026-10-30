# Plugin conflict repair — second adversarial review

> 修复状态更新（2026-10-30）：R1–R4 及修复中追加复现的两个边界均已修复。最终回归 37 suites / 799 tests passed，独立复核未再发现可操作问题。以下原审查结论保留为修复前证据；最新验收与限制见文末。

日期：2026-10-30（Asia/Shanghai）。本轮仅审查，未修改产品源码或 Git 状态。审查时 HEAD 为 `bf8af10d457340d016bc91f9c4aff8d4b8e3c4c0`；目标实现仍在共享工作树，不能用该 commit 代替当前文件内容。8 个核心源文件的 SHA-256 在审查前后保持一致，记录位于 `.cache/plugin-conflict-rereview-2026-10-30/source-sha256.json`。

结论：**不通过，确认 4 处新增回归：2 项 P1、2 项 P2。** 恢复逻辑还存在重叠暂停的隔离反例，归入 R1。全局 shortcut 队列的延迟级联和重载恢复语义另列为设计判断/验证边界，不混入已确认缺陷数。

三个全新上下文的独立 reviewer 分别检查生命周期、注册表/桌面队列、依赖规划，主审逐条复核并运行探针。用户选择跳过跨模型复核；未调用外部 CLI 模型。

## R1 · P1 · 恢复旧快照会覆盖暂停后的新用户意图

定位：[install-flow.ts:945](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:945)。

复现：插件原为 enabled → 为安装临时暂停 → 用户通过另一个管理入口明确禁用 → 安装恢复。`restore` 没有检查 intent revision 或暂停所有者，直接写回捕获的 enabled/auto，再调用 enablePlugin，覆盖较新的用户决定。

真实 `PluginManager.setPluginIntent`、`disablePlugin` 生命周期队列、`InMemoryPluginLifecycleStateAdapter` 的 probe 得到 `Expected disabled / Received enabled`。外围 runtime teardown 和完整 enable activation 使用原测试 harness 的替身。修复前 helper 仅调用 enablePlugin，它会被较新的 disabled intent guard 拒绝；新增的旧 intent 写回绕过了该保护。

同一缺乏所有者隔离的问题也影响重叠暂停：A 保存 enabled，B 在 A 暂停后保存 disabled；先恢复 A、再恢复 B，会得到 **intent=disabled、status=enabled**，而非原有 enabled/active 意图。中途恢复 A 还会在 B 的暂停尚未结束时启动消费者。主审的 3 个隔离探针分别覆盖手动禁用、提前恢复和最终 intent/status 不一致。

修复方向：暂停需要可识别所有者的生命周期租约、共享初始快照和引用计数；恢复时保留暂停后发生的新用户决定。单独对每次写使用当前 revision CAS，不能识别自己是否仍有恢复权限。

## R2 · P1 · 迟到的替换事件会删除较新的 Cogset 配置

定位：[install-flow.ts:510](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:510)，后果位于 [write-through.ts:71](/Users/bytedance/Project/cognia-next/lib/plugin/cogset/write-through.ts:71)。

复现：用户选择替换旧插件 → 后续 permission review 期间手动重新启用旧插件 → 安装成功。此时真实 lifecycle intent 已为 enabled，但 root 仅凭 `permanentDisabled` 集合，再发布 `marketplace-replacement/disabled`。事件序列为：

```text
manual / enabled
marketplace-replacement / disabled
```

接入真实 `startCogsetWriteThrough` 后，带 `config`、`expectedVersion`、`optional` 的原成员被删除，成员数 `Expected 1 / Received 0`，同时真实 intent 仍为 enabled。Storage I/O 使用隔离替身，未修改用户真实 Cogset。

这是新增 deferred publication 的回归。修复前没有该迟到事件。需要在发布时核对禁用决定的所有权和最新状态，并处理用户已重新选择的情况；集合记录不能充当当前事实。

## R3 · P2 · 用旧依赖版本的图误阻止合法升级

定位：[install-flow.ts:431](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:431)、[install-flow.ts:594](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:594)。

复现：target T 要求 `B ^2`，并选择替换竞争者 C；已安装且禁用的 B1 依赖 C，但可安装的 B2 已移除该依赖。`requiredProviders` 在 B2 准备前遍历 B1 的旧 manifest，提前把 C 判为必需，直接返回 requiredProviderConflict。

同一 fake DB/client 边界、生产 orchestration 的 before/current 对照：

```text
before: installed; events = [B@2.0.0, target]
current: failed/conflict/requiredProviderConflict; events = []
```

保护规则应基于准备安装的所选版本图；尚未确定更新后的 manifest 时，不能把旧版本的依赖边当作最终依赖边。这不是要求忽略仍会保留的已安装消费者。

## R4 · P2 · A2UI 对象身份不能证明当前 caller 的注册被接受

定位：[a2ui-bridge.ts:119](/Users/bytedance/Project/cognia-next/lib/plugin/bridge/a2ui-bridge.ts:119)。

复现：A 注册对象 shared，B 随后注册同一对象。底层 registry 正确拒绝 B，但 `getComponent(type) === shared` 仍成立，bridge 因而重写 catalog、owner tracking 和 plugin store。结果是 canonical owner 仍为 A，投射 owner 却为 B。也验证了先将可变对象的 `pluginId` 改为 B、再交给 B 注册的变体。

生产入口 [context.ts:844](/Users/bytedance/Project/cognia-next/lib/plugin/core/context.ts:844) 原样转交 component；governed/disposable proxy 同样未 clone 或盖章，因此该引用条件可达。before 的显式 owner guard 会拒绝此路径。当前变体失败，before 对照通过。

需要使用 registry 记录的 caller ownership/接受结果作为权威，不能只比较可共享对象的引用，也不能只信任对象上可变的 pluginId。

## 已确认的新行为，需设计判断

### 全局 native 队列扩大延迟影响

[plugin-shortcut-bridge.ts:69](/Users/bytedance/Project/cognia-next/lib/plugin/shortcuts/plugin-shortcut-bridge.ts:69) 为所有 plugin、commandId 和 chord 共用一条 promise 链。A 的 Ctrl+Y 绑定尚未返回时，无关 B 的 Ctrl+U 不会进入 store.bind，其 wrapper command 也尚未注册；解绑和 root flush 同样排队。实际 store.bind 还等待 native invoke 和偏好持久化。

当前/before 对照确认了延迟级联，但**未实测 native 永久挂起，也没有仅凭串行化本身就判定为必须修复的正确性缺陷**。串行化同时避免了共享状态竞争；应明确是否接受全局队头阻塞，或拆分权威 native 操作、同键顺序与持久化协调，避免以简单 timeout 误判未知 native 结果。

### 临时持久化 intent 的重载恢复仍需验收

暂停会写 durable disabled intent，而原 intent 和 undo 闭包仅在内存中。源码没有在该 helper 中持久保存待恢复快照。真正要验证的是：在 pause 与 restore 之间重载/终止后，是否有既有恢复机制重建原意图。

本轮只证明 adapter 已变为 disabled，**没有执行真实浏览器重载/IndexedDB 或 native crash-restart**。不能把“暂停期间 intent 必须始终为 enabled”当作正确断言，因为现有依赖占用闸门正需要这一临时变更；恢复日志或失效策略属于待明确的设计边界，未计入 4 项已确认缺陷。

## 既有缺陷，不归因于本次修复

递归版本约束仍遗漏未提交父级的范围，可能先安装 E3、再降至父级要求的 E2；before 快照中已存在。其他未接入统一 review 的独立来源入口、native 真实验收和全库既有检查失败同样未作为本轮新增回归。

## 验证记录

- 既有测试复跑：**36 suites / 765 tests passed**，`.cache/plugin-conflict-rereview-2026-10-30/existing-tests.log`。
- 生命周期两个有效反例：**2 failed / 295 skipped**；断言分别为较新 manual disabled 被保留、真实 Cogset 成员未被迟到事件删除。`.cache/plugin-conflict-rereview-2026-10-30/lifecycle-probes.log`；测试位于 `.cache/r2-lifecycle-review-20261030-unique/manager-r2.test.ts`。
- Bridge/queue 对照：**3 failed / 2 passed**，包含当前 A2UI 的两个变体和全局排队行为，以及两个 before 对照。`.cache/plugin-conflict-rereview-2026-10-30/registry-probes.log`；测试位于 `.cache/r2-registries-review-20261030-9d4a/probes.test.ts`。
- Planner before/current 证据：**5 passed**，这些断言确认当前错误行为及其与 before 的差异，不能解读为修复通过。`.cache/plugin-conflict-rereview-2026-10-30/planner-probes.log`；测试位于 `.cache/r2-planner-adversarial-2026-10-30/review.test.ts`。
- 主审恢复隔离探针：**3 failed**，`.cache/plugin-conflict-rereview-2026-10-30/root-probes.log`。
- 没有运行 coverage、生产构建或真实 native 操作。以上替身边界与各 finding 一并列明；既有测试全绿不能推翻新增反例。

复现命令（均经仓库 Jest wrapper）：

```sh
rtk proxy pnpm --config.verify-deps-before-run=false test --runInBand --config .cache/plugin-conflict-rereview-2026-10-30/root-probes.config.ts --runTestsByPath .cache/plugin-conflict-rereview-2026-10-30/root-probes.test.ts
rtk proxy pnpm --config.verify-deps-before-run=false test --runInBand --config .cache/r2-lifecycle-review-20261030-unique/jest.config.ts --runTestsByPath .cache/r2-lifecycle-review-20261030-unique/manager-r2.test.ts --testNamePattern 'R2 preserves a newer manual disable|R2 does not publish a stale replacement'
rtk proxy pnpm --config.verify-deps-before-run=false test --runInBand --config .cache/r2-registries-review-20261030-9d4a/jest.config.cjs --runTestsByPath .cache/r2-registries-review-20261030-9d4a/probes.test.ts
rtk proxy pnpm --config.verify-deps-before-run=false test --runInBand --config .cache/r2-planner-adversarial-2026-10-30/jest.config.cjs --runTestsByPath .cache/r2-planner-adversarial-2026-10-30/review.test.ts
```

## 修复与验收更新 · 2026-10-30

本次按用户授权修改四个现有模块及其同位测试，未新增产品模块，未提交或推送。任务前文件快照位于 `.cache/plugin-conflict-r3-repair-2026-10-30/before/`，不包含共享工作树其他改动。

| 问题 | 实现与验证                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1   | `PluginLifecycleCoordinator` 持有共享初始快照、引用计数和 intent 串行队列；较新的公开 intent 写入使旧 lease 失效。真实 Manager 验证双释放顺序、手动禁用和暂停期间禁止 dispose。      |
| R2   | 替换事件由仍有效的 lease 在 intent 队列内提交，发布不再进行额外存储读取。真实 Cogset follower 验证完整成员 metadata 保留；安装测试覆盖最终 shortcut drain 挂起时发生 manual enable。 |
| R3   | 不沿将被替换的不兼容旧版本继续遍历依赖边；冲突决定先持有 deferred lease，选定依赖后才实际暂停。测试同时覆盖 B2 移除和保留 C 的场景。                                                 |
| R4   | A2UI bridge 注册与删除均核对 registry 的 canonical caller metadata，引用身份与可变 `pluginId` 均不单独充当权威。真实 registry 的共享引用两种变体通过。                               |

独立审查在本次修复期间另发现并修正两项 P2：共享暂停的 teardown 与补偿都失败时，剩余 holder 必须收到失败而不能发布 disabled；依赖规划中已被用户手动禁用的消费者，不应进入实际恢复图。三个反例先在旧实现失败，再以共享 failure 状态与 `willResume()` 驱动的恢复图修复。第二次限定复核未再发现可操作问题。

最终验证记录（均未启用 coverage）：

- **37 suites / 799 tests passed**：检测器、overlay/command registry、Manager/coordinator、Cogset、shortcut/A2UI/tools bridge、安装/review client、hook 与已有 dialog 测试。`.cache/plugin-conflict-r3-repair-2026-10-30/regressions-final.log`。
- 本次 8 个代码/测试文件的 ESLint 与 Prettier **通过**；i18n lint、i18n sort、plugin contract 和 author-types check（85 declarations）**通过**。目录内对应 `lint-scoped-final.log`、`format-final.log`、`i18n-lint.log`、`i18n-sort.log`、`contract.log`、`author-types.log`。
- 全库 lint 首轮通过；最终复跑被同期范围外文件 `tests/bot-e2e/fixtures/matrix-browser.ts:104` 的 `react/no-children-prop` 阻断。未修改他人 fixture。`lint-final.log`。
- 全库 typecheck 与 static-export 仍有任务范围外错误；static-export 为 14 个 `agent-codebuff`/`agent-crush` Node-only imports。完整结果记录在本轮 `typecheck-final.log`、`static-export.log`，不能把局部绿灯解释为全库通过。
- 新增实现无 UI、路由或 Rust 改动；未运行生产构建、signed native 安装、真实 OS shortcut、reload/crash 恢复或 coverage。临时 durable intent 与 global queue 的既有设计边界保留在上文和 evidence ledger。
