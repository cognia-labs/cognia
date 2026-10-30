# 账户体系研究：对抗性复核

后续状态：本报告记录修复前的证据与判定。已确认问题的实现修复、回归和验收限制见 [2026-10-30 修复报告](2026-10-30-account-lifecycle-repair.md)。

日期：2026-10-30。审查对象：[初轮研究报告](2026-10-30-account-startup-lock-lifecycle-audit.md)、其隔离反例及当前 owning source。代码共享树在审查期间仍有并发改动；未修改生产源码、真实账户或真实云端数据。

## 结果

初轮 7 项中，F1/F2/F3/F5/F6 保留为可行动缺陷，F6 按实际影响降为 P2；F4 改列产品策略待决；F7 降为 P3 的重复命令。新增 F8/P1：原生凭据删除失败被吞掉，退出仍报告已清除。

当前优先级为 F1/F2/F3/F5/F8，其后是 F6。没有证据支持“已经发生云端越权、数据泄漏或数据损坏”的结论。

## 审查方法与独立性

先确定反驳条件，再检查现有保护与实际调用链：

- F1 若上层失败回滚 session，或者读取/sync 拒绝不匹配身份，则原结论应被推翻。
- F2 若 logout、新登录与 refresh 共用失效代次或提交锁，则旧结果不应恢复/覆盖新状态。
- F3 若退出保留持久所有者，或者新登录/同步 enrollment 阻止另一人沿用旧数据，则原影响应收窄。
- F5/F6 若实际 transport 有超时，或当前 store 的 generation/cleanup 阻断旧 callback，则原 hook mocks 不能证明生产缺陷。
- F7 若 pendingLock 合并重复调用，就只能报告重复 interrupt，不能报告重复 teardown。

依据 `doubt-driven` 尝试了 auth 与 lock 两个 fresh-context reviewer，各重试一次；均返回 `Selected model is at capacity`，没有完成审查。这一环节记为 blocked，不能用它们的初步消息冒充独立审查结论。

随后由主审查者完成源码反驳与可执行探针。对工具反例的结果有确定性证据，对产品方案仍只有单模型判断。已按 skill 提供跨模型选项，用户选择“继续交付本轮审查结果”；未运行外部模型 CLI。

## 逐项判定

| 初轮项                                    | 复核结果              | 修订与依据                                                                                                                                                                                     |
| ----------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 / P1：拒绝另一人后仍保存其 token       | 保留，证据加强        | 原反例直接注入混合状态，单独不能证明登录链能产生它。新增组合实际 personal sign-in、session 写入、registry binding 和 cloud read；Bob 被拒绝后 token 确实保留。                                 |
| F2 / P1：refresh 在 logout 后恢复 session | 保留，范围扩展        | 没有共同 auth generation。新增反例确认旧 Alice refresh 也能覆盖较新的 Bob session。不等同于真实 issuer 必然继续接受 token。                                                                    |
| F3 / P1：退出删除归属后换人绑定           | 保留，按 ADR 契约解释 | `completeSignOut` 删除唯一绑定、数据保留；违反 ADR-0215 §10。旧实现与注释确实把它定义成退出行为，因此不能仅用函数名证明错误；实际冲突来自更晚的 ADR。                                          |
| F4 / P2：focus 绕过任务延期               | 改列产品策略待决      | 行为复现成立，但 hook 注释 16–28 行和既有测试明确规定 focus 即时锁、timer 有界延期。没有新产品契约前，不能将这一有意差异直接当作实现 bug。                                                     |
| F5 / P1：interrupt 卡住导致不锁           | 保留，限定平台        | Tauri local IPC 与 sidecar stdin 写入缺少这段操作的截止时间；实际 store 在等待期间尚未被调用。Companion transport 自带 timeout，不能推广“无限等待”到所有远程模式。                             |
| F6 / P1：旧 callback 锁新档案             | 保留，降为 P2         | 当前 store 已有 authenticationGeneration、accountRevision、pendingLock。改用实际 store、真实 switchAccount 编排及旧 hook unmount，仍可锁住 B；已证明的是错误锁定与可用性影响，未证明数据损坏。 |
| F7 / P2：重复 interrupt                   | 保留事实，降为 P3     | 两次事件会发两次 interrupt。但实际 store 将同时到达的 lock 合并为一次 teardown。没有证明额外破坏性后果。                                                                                       |

## 新发现 F8 / P1：本地删除失败仍报告退出成功

调用链：

1. `lib/logto/session-store.ts:137–140` 调用 `clearSecret(ref)`，没有启用 strict。
2. `lib/keyring/index.ts:118–124` 在 Tauri 中使用非 strict `safeInvoke`；该函数在 `46–52` 行吞掉 native IPC 错误。
3. `lib/logto/app-session.ts:368–374` 等待这个“成功”后无条件报告 `cleared: true`。
4. Settings 的 `account-identity-tab.tsx:67–70` 随后调用 `completeSignOut`，删除 profile binding。

反例不是替换 `clear` 为一个无行为 mock，而是组合实际 `app-session`、`session-store`、`keyring`、`completeSignOut`，只对 native IPC 与 issuer 注入失败。结果：

```text
reportedCleared=true
persistedSessionStillReadable=true
bindingDeleted=true
```

同一 native delete 使用现有 `{ strict: true }` 会拒绝。默认退出路径却将本地删除故障隐藏为成功。若 issuer 同时不可达，凭证仍可能具备远端效力；若 issuer 已成功撤销，则这里只证明凭证残留，不能声称 token 继续有效。

Mobile 的 secure-store delete catch 与 Browser 的 IndexedDB delete error 分支也有吞错源码，但本轮只执行了 Tauri fixture，其他平台的实际故障后果仍需验收。

## 对原反例的补强

### 组合登录链：F1

原 `identity-repro.cjs` 预先提供 Alice binding / Bob session，证明了错误的 active 判定，却没有自行证明混合状态的形成过程。

新增 `adversarial-review.cjs` 先保存 Alice 并完成其实际 binding，再从实际 `signInToOfficialAccount` 发起 Bob 的 session 保存与绑定。只注入 issuer 响应、native storage、projection/host 外部副作用；核心登录、持久化和 binding 函数不替换。断言：

```text
login rejects: already bound
storedSubject=usr_bob
displayedPerson=usr_alice
```

这补上调用链可达性。依然没有真实 PKCE、签名验证、云端同步或 UI 验收。

### 实际 store：F5/F6/F7

新增 `current-store.probe.test.ts` 复用当前 `account-store.test.ts` 的依赖 fixtures，执行实际 `createAccountStore`、`lock` 和 `switchAccount`；不再用 `lockMock` 代替 store 编排。crypto/native/registry 等外部边界仍是 fixtures。

- F5：interrupt 不 settle，30 分钟虚拟时间后，actual store 的 `locked=false`；vault revoke 和 subscriptions stop 均未调用。
- F6：A 开始 interrupt；卸载旧 hook；实际 `switchAccount` 成功打开 B；交付 A 的旧响应后，B 的 `locked=true`、`unlockedAccountId=null`。新 store guards 没有保护 hook continuation。
- F7：visible + focus 产生两次 interrupt，交付响应后只发生一次 subscriptions teardown。这直接证伪了从重复命令推断重复拆卸的扩大解释。

## 对设计建议的反驳

“登录优先”“记住设备但仍可锁定”“锁定后后台任务继续”都只能作为候选产品方案。当前 cloud session 已按 profile 存储，本地数据库/密钥/运行时也依赖已打开的 profile；不能把组件挪到 AccountGate 外就视作完成登录重构。

应先明确匿名数据归属、同人多 profile 的恢复规则、失败提交/退出清理、跨 tab 失效、云会话与本地解锁的区别。后台执行还需要独立判断主体、密钥和授权。初轮建议没有验证这些方案，不构成可直接实施的完整设计。

## 验证记录

所有命令均从仓库根目录执行；无 coverage、真实账号写操作或真实网络请求。

```sh
rtk proxy node .cache/account-lifecycle-audit/adversarial-review.cjs

pnpm_config_verify_deps_before_run=false rtk proxy pnpm test -- \
  --config .cache/account-lifecycle-audit/jest.config.ts --runInBand

pnpm_config_verify_deps_before_run=false rtk proxy pnpm test -- \
  --runInBand --runTestsByPath \
  lib/keyring/index.test.ts lib/logto/session-store.test.ts \
  lib/logto/app-session.test.ts lib/identity/personal-sign-in.test.ts \
  lib/identity/user-binding.test.ts stores/account/account-store.test.ts \
  hooks/account/use-auto-lock-on-idle.test.ts
```

结果：

- 3 个加强 source-module 反例退出码 0：组合失败登录、native delete 失败、旧 refresh 覆盖较新 session。
- 2 个研究 suites / 7 个 probes 通过：原 4 个 hook probes 加 3 个实际 store probes。
- 7 个既有 suites / 249 tests 通过。与初轮 439 tests 有重叠，不累加。
- 初次 actual-store probe 因过早 import 导致 Jest mock TDZ，未执行测试；改为 fixture 初始化后的动态 import 后重跑成功。没有改生产源码来适配 probe。
- `adversarial-source-sha256.txt` 固定当前源码范围；旧 source snapshot 的 account-store hash 已过期，其余原关键模块未漂移。
- 整理报告期间 account-store 再次被并发修改。已针对最新 store 重跑 7 个研究 probes，全部通过（1.218 s），且前后 hash 一致；日志为 `adversarial-lock-final-tests.log`，hash 为 `adversarial-current-store-before.sha256`。前述 249 个既有测试是较早快照的运行结果，不扩张为后续所有并发改动的验收。

产物位于 `.cache/account-lifecycle-audit/`：`adversarial-review.cjs`、`adversarial-results.ndjson`、`current-store.probe.test.ts`、`adversarial-lock-tests.log`、`adversarial-existing-tests.log`。

## 保留的不确定性

未验证：真实 native sidecar 卡住的发生率、真实 issuer 的 refresh/revoke 交错、三端 production UI、用户当前超时值、enrollment 后跨人数据是否实际上传，以及完整重构方案。fresh reviewer 未完成，跨模型由用户跳过。这是有明确反例和文档修订的单模型复核，不是独立安全认证。
