# 账号、登录与注册：对抗性审查

日期：2026-11-17（Asia/Shanghai）。审查对象：[原始缺口报告](./2026-11-17-account-login-registration-gap-audit.md)、其 probe，以及当前 owning source。三路独立 reviewer 分别攻击 cloud lifecycle、shell/导航可达性、issuer 能力声明；主会话逐项核对并重跑反例。仅修改审查材料，没有修改产品或服务源码、安装服务依赖、操作真实账号。

结论：新增 **2 个 P1、1 个条件性 P2**；原 F1/F2/F4/F5 保留，但修订平台、验证层级和安全含义。F3 保持 UX/退出范围问题。对 G5、provider 可用性和“缺少原生 MFA”的推论做了收窄。原报告已经合并这些修订，当前为 7 组程序缺陷、1 组退出语义问题；不能把它们都称为账号接管漏洞。

## 1. 新增 P1：取消删除成功后仍被旧 purge job 删除（原报告 F6）

Owning source：identity-server [purge.ts](../../../cognia-services/services/identity-server/src/deletion/purge.ts):63–73、[store.ts](../../../cognia-services/services/identity-server/src/deletion/store.ts):75–103、[routes.ts](../../../cognia-services/services/identity-server/src/deletion/routes.ts):66–68。当前 app pin 与相邻 checkout 的该服务子树一致。

实际时序：

1. 申请已到 purgeAfter；cron 快照读到 pending 用户。
2. cron 等待外部 `SYNC_ADMIN.purgeSpace` 对应的 hook。
3. 用户调用 DELETE；API 没有执行阶段或 deadline 拒绝条件，数据库成功改为 cancelled。
4. 旧 cron 不重新领取或验证申请版本，继续删除 OAuth 记录和 user。
5. `markPurged` 因记录已 cancelled 而不修改，但 job 仍报告 purged。

反例运行实际 `store.ts` / `purge.ts`、原始 migration 和 SQL，通过 Node SQLite 内存库承接 D1 接口。只替换外部 hook 与 Better Auth deleteUser 边界。结果：

```text
cancellationReturned = cancelled
deletionRecord.status = cancelled
deletionRecord.purgedAt = null
user / oauthAccessToken / oauthRefreshToken / oauthConsent = 0 rows
deleteUserCalls = 1
purgeReport.purged = [usr_cancelrace]
```

对照场景“cron 取快照前完成取消”保留用户，purgeReport 为空。不是把 SQL 效果硬编码进 mock，也没有删除真实用户。最强反驳是“到期后本来就不允许取消”；当前 API 和 pending UI 并没有执行该规则，反而确认取消，因此仍是状态机缺陷。

建议在任何不可逆 external effect **之前**，原子领取带版本的 pending → purging；取消与领取必须互斥，已不可取消时明确拒绝。仅在 hook 返回后再查状态不足以保护已经删除的同步空间。真实 D1、service binding 和 Better Auth 整体仍需并发验收。

## 2. 新增 P1：native 展示内容恢复钥匙，但同 shell 无法兑换（F7）

Owning source：`stores/account/account-store.ts:1010–1030,1058–1065,1433–1437,1709–1713,2011–2012`；`components/account/account-gate.tsx:186–245,431`。

当前所有 runtime 都 provision 内容 Vault，并向 password profile 展示恢复钥匙。Tauri 将默认设备空间设置为密码保护时，也展示保留的钥匙。但 native 锁屏隐藏恢复入口，store 的恢复 action 又提前拒绝：

```text
code = vault-not-provisioned
message = Desktop recovery requires the native recovery flow.
resetVaultWithRecoveryKey calls = 0
locked = true
```

actual `createAccountStore` 的三个隔离反例通过：Tauri 新建 password profile → 保存钥匙 → 锁定 → 恢复被拒；Capacitor 直接调用相同 store 也是如此；Tauri device → password promotion → 展示保留钥匙 → 锁定 → 恢复被拒。

Tauri 的前两类账号操作在账号管理界面可达。Capacitor 的 probe 只证明 store 行为，不能据此宣称现有 compact UI 已开放同样建号流程。密码、Vault、IPC、registry 使用现有测试边界，因此这里证明的是**支持的恢复路由缺失**，没有证明真实钥匙在密码学上不能解密内容。

检查到的替代机制不能消除此反例：`unlockSecretStore` 只重试 OS 凭据存储初始化；native password rotation 需要已有解锁 session 和当前密码。既有 `account-store.test.ts:2478` 的“desktop host ... mints no recovery key”测试前提已经过时，而另一个 promotion 测试又确认会展示钥匙。测试各自通过没有覆盖生命周期组合。

修复需要 Host 合法验证恢复证明、更新 password verifier、保持数据密钥与身份绑定；不能只显示按钮并绕过 native 认证。

## 3. 新增条件性 P2：无 name/email 的登录隐藏退出操作（F8）

Owning source：`cloud-sign-in-gate.tsx:242–244`、`cloud-sign-in-screen.tsx:146`、`lib/identity/sign-in.ts:182`。

合法 subject-only 身份已被客户端身份构建支持，并有 subject 显示名 fallback；gate 却只用可选 name/email 设置 personName。整个退出 footer 又受 personName 真值控制。首次登录进入 unaffiliated 页面后，Sign out 和 Continue offline 同时不存在。

反例使用实际 gate/screen、真实 `captureAccountScope`、Dexie + fake-indexeddb；只注入外部登录结果与 organization standing。当前 provider 是否真的签发这种字段组合未实测。不能用所有 IdP 都会返回 name/email 消除这一问题：这些显示性字段可以缺失，参见 [OpenID Connect Core 的 Standard Claims](https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims)。

建议使用既有 subject fallback，并让退出操作与展示名独立。这是可用性问题，没有证明认证绕过或跨账号数据访问。

## 4. 原结论的收窄与反证

| 原结论                               | 对抗性结果与最终处理                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 popup 关闭后卡住                  | 保留。原 probe 注入 signIn 和 no-op scope，不能证明完整 PKCE 或跨账号安全。新增 actual loginToLogto → runPkceAuthFlow → Web driver probe，在模拟网络外保持真实流程，仍重现关闭后 10 分钟 fake time pending。 |
| F2 移动账号入口未接通                | 保留但按 shell 定义：Capacitor 总用 compact shell；Browser 随 viewport 分支。宽屏 Browser 的侧栏“管理账号 → 身份”是普通操作反例，存在可用入口。                                                              |
| Browser 的 advertised 登录路径       | 补充：离线提示的“设置 → 账号”因 isTauri 管理控件 gate 而在 Browser 不提供官方登录；侧栏“登录”指向旧 companion 设置，重定向后仍是 CloudDeploymentCard。不能因此忽略“管理账号”的有效替代入口。                 |
| F3 移动退出范围                      | 保持 P2 UX。确认框写明 subscription/pairing 范围；Capacitor 的 Anthropic signOut 又是 no-op，故只能写“调用订阅退出流程”，不能说实际清除了凭据或未履行全局退出承诺。                                          |
| F4 callback state 被破坏             | 保留，并扩展到 Desktop：真实 deep-link driver 在比较 state 前清理 listener；旧 A 回调拒绝了当前 B，正确 B 随后无法恢复。这里消费的是 pending transaction，不是已保存 session；没有证明 state/PKCE 绕过。     |
| F5 丢失 logout report                | 保留。注入值符合真实 report 类型，证明 caller 丢弃报告；不能据此声称已在真实 IdP 证明 cookie/token 继续有效。                                                                                                |
| G5 多把钥匙、默认不开同步就是 P1     | 泛化优先级不成立，改为 P2/待测产品建议。AccountSyncSummary 已在 overview 显示“此版本未提供账号同步”；不同加密域使用不同钥匙本身合理。native 兑换缺失单独升级为 F7。                                          |
| 固定四 provider 按钮可能导致登录失败 | 保留 UI/config 不一致风险，但 issuer 在 hint 不可用时会展示实际 enabled provider，已有 fallback；不能直接称为登录死路。                                                                                      |
| 生产 Browser 都先建号                | 缩窄为普通工作区首次入口。无账号的公共 share guest viewer 明确绕过建号与 cloud gate。                                                                                                                        |
| 缺少 Cognia 自建 MFA                 | 当前插件/route 缺口成立，不等于外部 provider 没有 MFA。应选择依赖并验证 IdP 强认证上下文，或建设自身强认证；不必机械叠加两套系统。                                                                           |

对标复核：[Notion passkeys](https://www.notion.com/help/passkeys)说明其组织强制 IdP 模式限制 passkey 使用；[Linear 登录方式](https://linear.app/docs/login-methods)也区分认证方式与组织限制。参考这些产品可以帮助定义完整生命周期，不能直接推导 Cognia 必须复制每个按钮或策略。

## 5. 未升级为已确认漏洞的推论

- **旧 profile 回调一定污染新 profile**：原 probe 的 no-op scope 不足以支持。真实 switch 先 lock，AccountGate 会卸载旧子树，真实 scope 拒绝旧 candidate。本轮没有构造绕过这些保护的反例。
- **旧 refresh token 能伪造删除所需的新鲜认证**：对锁定 `@better-auth/oauth-provider@1.7.7` 的[官方包](https://registry.npmjs.org/@better-auth/oauth-provider/-/oauth-provider-1.7.7.tgz)检查显示 refresh 保留原 authTime，没有证实该绕过。
- **refresh family replay 已完整安全**：上游实现包含 family invalidation，但 predecessor CAS 与 successor 创建分离；并发重放窗口仍需要完整 issuer 验证。源码候选风险不等于本轮已复现漏洞。
- **pre-aborted Desktop signal 会导致可达产品绕过**：实际 helper 确实未处理进入 waitForCode 前已 aborted 的 signal；但真实普通用户调用顺序未建立。保留为 helper contract gap，不与 F4 的已复现旧回调混为一谈。

## 6. 审查证据与局限

| 检查                     | 本轮实际结果                      | 边界                                                                             |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------- |
| 三路独立 reviewer        | 已完成并逐项核对                  | 独立上下文，同一模型；不是外部跨模型审查                                         |
| 现有 owning suites       | 8 suites / 265 tests passed       | store、gate/screen、native callbacks、sync summary、deployment card、deletion UI |
| 审查 probes              | 6 suites / 13 probes passed       | 通过表示反例或边界成立，不表示产品已经修复                                       |
| issuer SQLite 反例与对照 | 2 scenarios passed                | 实际 store/purge SQL，内存 SQLite；不是 Cloudflare D1 的完整服务验收             |
| Probe 质量纠正           | 修复重复 CloudDeploymentCard 声明 | 原文件会报 TS2440；Jest 转译通过不能替代类型检查                                 |

新加入的 native recovery fixture 复用当前 store suite 的边界 mock，删除了复制后未使用的 helper。原先未接入的 mock 声明与重复 value import 已修正；probe 文件的专门类型诊断不能代表整仓 typecheck。审查材料的最终格式、lint、类型与 ledger 结果随本轮检查记录在 `.cache/account-registration-audit/adversarial/`。

所有持久反例放在 [audit probes](../evidence/2026-11-17-account-login-registration-gap-audit.probes/)，保持 `.probe.ts(x)` 命名，避免“断言缺陷仍存在”的历史审查脚本自动进入普通回归套件：

```sh
pnpm_config_verify_deps_before_run=false rtk proxy pnpm test -- \
  --config docs/evidence/2026-11-17-account-login-registration-gap-audit.probes/jest.config.mjs \
  --runInBand

rtk proxy node docs/evidence/2026-11-17-account-login-registration-gap-audit.probes/issuer-cancel-purge.probe.mjs \
  ../cognia-services/services/identity-server
```

本轮没有建立真实 IdP、Tauri/Capacitor 账号、生产构建或 D1/service-binding 环境，不能据此声称生产事故、真实密钥恢复验收或已完成安全认证。外部 CLI 复核选项已按 doubt-driven 提供；在没有获得选择和具体调用授权时不调用，也不记录为用户已选择跳过。

下一步应优先修复 F6/F7，再完成 F1/F2/F4/F5/F8。G1–G4 等功能路线仍有价值，但不应排在已复现的删除一致性和恢复通路问题之前。
