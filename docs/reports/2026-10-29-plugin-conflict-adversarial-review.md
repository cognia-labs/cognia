# Plugin conflict resolution — adversarial review

日期：2026-10-29（Asia/Shanghai）。审查对象为共享工作树中的本轮插件冲突实现；记录时 HEAD 为 `bf8af10d457340d016bc91f9c4aff8d4b8e3c4c0`，实现尚未提交，不能用该 commit 代替当前文件内容。

2026-10-30 修复更新：下文保留原审查结论；F1–F7、E1 已修复并加入回归。当前相关测试为 36 个套件、765 项通过，原始 7 项失败探针均转绿。完整环境验收仍受全库检查及真实 native 验证边界限制，见[证据记录](/Users/bytedance/Project/cognia-next/docs/evidence/2026-10-29-plugin-conflict-resolution.md)。

结论：本轮审查不通过。确认 7 项本轮新增或放大的问题（5 项 P1、2 项 P2），另有 1 项与本轮验收相关的既有缺陷。未修改产品源码，未提交。三个独立审查者分别检查安装事务、注册表和交互入口，主审逐项核对源码及复现。未追加外部模型运行。

## Findings

### F1 · P1 · 临时暂停无法解除真实生命周期的依赖占用

定位：[install-flow.ts:710](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:710)。

普通消费者的持久化生命周期为 `intent: enabled`。本轮通过 `disablePlugin` 暂停消费者，只改变运行状态及 `actual`，保留 intent。随后 `installStagedBundle` 在 [manager.ts:3467](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:3467) 检查反向依赖，[manager.ts:2391](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:2391) 仅凭 enabled intent 就阻止 provider 替换。因此批准暂停之后，真实依赖更新仍失败；多层消费者还可能在暂停中间节点时失败。

执行当前 `PluginManager` class 中未改写的 `disablePluginInner` 和 `getRuntimeBlockingDependentIds`，结果为：

```text
status: disabled
lifecycle: { intent: enabled, actual: inactive }
blockers: [consumer]
```

现有 flow 测试替换了 manager，没有覆盖该约束。修复需通过现有生命周期控制面实现可恢复的 graph pause，处理并恢复原 intent，而不是只模拟 status。

### F2 · P1 · 显式替换可停用新插件必需的 provider，成功结果不能维持用户选择

定位：[install-flow.ts:520](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:520)。

复现：已启用的 B 和 target 声明共享贡献，target 同时必需依赖 B。选择“使用此插件替代”后，B 被停用；依赖复查只核对已安装版本，最终返回 installed。之后启用 target，[manager.ts:4192](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:4192) 会先启用 B，使 B 再次取得共享贡献，推翻替换选择。

此外，同一 resolver 用运行时 `disablePlugin` 处理永久替换，未写入 disabled intent；后续匹配的 activation event 仍可激活竞争者（[manager.ts:5683](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:5683)）。这是不同于临时暂停的持久化需求。

探针确认：resolver 返回 installed，但 B 保持 disabled。后续必需依赖自动启用路径经源码核实，未运行真实桌面激活。修复需拒绝与 target 必需依赖闭包矛盾的替换，并在成功提交时持久化明确的停用决定，失败时恢复原 intent。

### F3 · P1 · A2UI bridge 绕过保留键规则，恢复后还会删除原 owner

定位：新增 reservation 拒绝路径 [createOverlayRegistry.ts:239](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/lib/plugin/registries/createOverlayRegistry.ts:239)，遗漏的调用方 [a2ui-bridge.ts:131](/Users/bytedance/Project/cognia-next/lib/plugin/bridge/a2ui-bridge.ts:131)。

复现：A 注册组件 → reserve A → 暂停 A → B 注册同类型。底层 registry 拒绝 B，但 bridge 在调用 registry 之前就写入 render catalog、owner tracking 和 runtime store。恢复 A 时，registry 接受 A，bridge 却仍将 B 当 owner；之后禁用 B，会把 A 已恢复的 registry entry 删除。

使用实际 bridge、registry 和 reservation 的两个探针分别证明：拒绝 B 后仍调用 catalog 注册；恢复 A 再禁用 B 后，registry 组件变为 undefined。Catalog/store 外围为替身，没有执行真实页面渲染。修复应先确认 registry 接受相同贡献对象，再更新 catalog、tracking 和 store，并在 teardown 核对当前 owner。

### F4 · P1 · 最后一次暂停期间取消，仍会进入安装

定位：[install-flow.ts:710](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:710) 至 [prepared.install:730](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:730)。

最后一次 `signal.aborted` 检查发生在暂停之前。`await resolve(pauseIds)` 可能持续较久；期间离开页面，hook cleanup 会 abort，但暂停完成后没有再次检查，直接调用 prepared.install。

真实 flow 的延迟暂停探针结果：

```text
Expected: { status: cancelled, installCalls: 0, disposeCalls: 1 }
Received: { status: installed, installCalls: 1, disposeCalls: 1 }
```

修复应在异步暂停结束、提交开始前检查取消，并进入已有补偿路径。这不是“提交已经开始后无法取消”的情况：复现中 abort 发生时 install 尚未调用。

### F5 · P1 · 当前 peer 已改变后停用失败，不会进入恢复列表

定位：[install-flow.ts:852](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:852)。

`disabled.push(id)` 只在 `await disablePlugin(id)` 成功后执行。真实 manager 可以先移除 runtime/contributions，然后在 `suspendPluginExternalServices` 或生命周期持久化处失败，将状态置为 error 再抛出。当前 peer 因而不在补偿列表内。

复现：first 停用成功；second 在产生副作用后失败。resolver 只恢复 first，second 留在 error/off。隔离故障注入探针确认 `resumed: [first]`、`late: error`；真实 manager 的副作用和抛错顺序经源码核实。现有测试只模拟“尚未改变当前 peer 就拒绝”。修复需在操作前记录原状态，对失败操作检查实际变化，并补偿可恢复部分；不能把未恢复情况当普通 conflict 失败。

### F6 · P2 · sibling 使用旧计划，拒绝已经存在的可行依赖图

定位：[install-flow.ts:601](/Users/bytedance/Project/cognia-next/lib/plugin/marketplace/install-flow.ts:601)。

target 要求 `D >=1`、`E >=1`；D 最新为 2，要求 `E ^2`；E 有 3、2。批量计划选择 D2、E3。递归处理 D 时先安装 E2，再安装 D2；随后仍执行旧 E3 action，被 D2 的反向约束拒绝。此时 D2/E2 已满足 target，最终却返回 failed/dependencies/dependentVersionConflict。

真实 flow 和 resolver 的探针安装事件只有 E2、D2，没有 target。修复应在每个 sibling 执行前重读依赖状态，跳过已满足的项；需要变更版本时重新规划并审查新的动作。

### F7 · P2 · command 检测键与运行时不一致，错误检测现在会驱动实际停用

定位：[conflict-detector.ts:62](/Users/bytedance/Project/cognia-next/lib/plugin/package/conflict-detector.ts:62)。

提取器把 plugin-local command id 当共享键；manager 实际将其命名为 `${pluginId}.${id}`，composer 的可见 slash token 来自 name。A/B 都声明 `id: run`、name 分别为 `/alpha` 和 `/beta`，实际上没有共享键，detectConflicts 却返回 `conflictingPluginIds: [alpha]`，使用户可以停用无冲突的 A。不同 id、同 `/shared` name 则不报告，实际 composer 会给后者改名。

裸 id 检测问题原先存在；本轮新增的可执行停用策略放大其后果。两个 detector 探针和一个实际 detectConflicts 探针确认以上行为。修复应使用与实际执行命令、slash token 对应的键和各自规则，不能用裸 id 作为停用依据。

## Existing gap in the touched shortcut bridge

**E1 · P2 · Desktop 旧 disposer 会解除同插件刷新的新快捷键。**

定位：[plugin-shortcut-bridge.ts:106](/Users/bytedance/Project/cognia-next/lib/plugin/shortcuts/plugin-shortcut-bridge.ts:106)、[teardown:219](/Users/bytedance/Project/cognia-next/lib/plugin/shortcuts/plugin-shortcut-bridge.ts:219)。

同插件连续绑定同一 chord 两次，再调用旧 disposer，旧 binding 仍以相同 commandId 调用 store.unbind，删除新 binding。本轮仅为 browser 添加 predecessor 清理；desktop 的这个既有问题仍未补齐。探针使用 desktop 分支和 shortcut store 替身，未执行 native OS 注册。应以当前 binding 身份保护 native teardown，并增加 desktop 刷新回归。

## Verification and limits

- 当前 32 个既有套件、703 项测试重新运行全部通过：`.cache/plugin-conflict-adversarial-existing-tests.log`。这说明既有测试未发现上述问题，不代表上述行为正确。
- 新增 registry/bridge/detector 对抗性探针 6 项均在期望的行为断言处失败：`.cache/adversarial-registry-75bf.test.ts`、`.cache/adversarial-registry-75bf.config.ts`、`.cache/adversarial-registry-75bf.log`。
- 新增取消探针 1 项在期望断言处失败：`.cache/adversarial-ui-20261029-7f3b/cancel-pause.probe.test.ts` 和同目录 Jest config。
- 4 个 source-executing 场景确认当前错误行为，脚本以验证该错误行为的断言运行，因此 exit 0：`.cache/adversarial-install-20261029-8d4a.cjs`。其中 manager class 从当前源码提取、转译，执行原方法；外围资源隔离，不能等同 native 集成测试。
- 不把原有 local bundle、signed URL、local VSIX 等入口未接入统一 review 的问题归为本轮新增回归。Open VSX discard 的既有缺口也单独保留为范围限制。
- 本次未执行生产构建、真实签名插件安装或 OS 快捷键测试；未复跑全库 lint/typecheck/static-export，因为此次没有产品源码改动。
- 跨模型复核已通过交互问题提供选项；当前记录仅包含本轮同模型独立审查，没有获得外部 CLI 运行授权。

复现命令：

```sh
rtk proxy pnpm --config.verify-deps-before-run=false test --runInBand --config .cache/adversarial-registry-75bf.config.ts --runTestsByPath .cache/adversarial-registry-75bf.test.ts
rtk proxy pnpm --config.verify-deps-before-run=false test -- --config .cache/adversarial-ui-20261029-7f3b/jest.config.ts --runInBand
rtk proxy node .cache/adversarial-install-20261029-8d4a.cjs
```

建议先修复 F1–F5 的生命周期、提交取消和归属补偿问题，再修复 F6/F7，并将隔离探针转换为共用真实 manager 生命周期状态的 co-located 回归。保留“已经批准安装的依赖，在后续 parent 取消时可能仍安装着”这一已明确披露的行为，不将其误判为回滚缺陷。

## 2026-10-30 修复与验证

- F1/F5：保存原 intent/runtime 后再停用，支持晚失败补偿；真实 manager 的多层占用检查、active auto 使用方、休眠和在途激活恢复均有验证。
- F2：保护请求树及待恢复消费者的必需依赖闭包。明确替换持久化 disabled intent；只有整个安装及 native 队列收尾成功后才发布用户意图。临时暂停和取消不改坏 Cogset 的成员、配置、版本约束或 always-on 集合。
- F3/F7：A2UI 只投射实际接受的组件；命令使用真实 namespaced ID 和共享 slash token 规则，别名同样规范化，避免误停用。
- F4/F6：暂停结束后再次检查取消；递归安装后重读 sibling，跳过已满足项或重新规划、重新确认版本。
- E1：native bind/unbind 串行化，旧释放器不能移除新绑定；取消排队和在途绑定时保持保留键。根流程等待 fire-and-forget native 队列完成后才释放 reservation。

验证日志位于 `.cache/plugin-conflict-repair-2026-10-30/`：`tests-final.log` 为 36/765 全通过；原始 registry/detector 6 项和取消 1 项探针通过。补齐测试 fixture 类型后，快捷键 21 项及该文件 lint 重跑通过。Root lint、i18n build/check/lint/sort、插件契约检查通过。最终 typecheck 无任务路径诊断，但全库检查仍受范围外错误阻塞；全库 static-export 为 14 项范围外问题，author-types 生成包仍过期。

没有运行 production build、真实签名包安装或 OS 快捷键验收；没有修改或清理其他任务的代码，也没有提交。
