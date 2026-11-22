# Cognia 账号、登录与注册复核

复核日期 2026-11-22（Asia/Shanghai）。应用基线为本地 `dev` 的 `86c188cba482`，官方 issuer 以 [服务锁定配置](../../integrations/cognia-services.json) 指向的 `52ec93a316b6d25e81bc9da5206b597d60985f10` 为准。锁定版本与 2026-11-17 的版本在 `services/identity-server/` 下没有差异。证据和遗留验收项记录在[账号生命周期台账](../evidence/2026-10-30-account-startup-lock-lifecycle-audit.md)。

同日已追加[对抗性复审与完整问题列表](./2026-11-22-account-login-registration-adversarial-review.md)，更新了三个重点结论的证据及边界。

## 结论

**2026-10-30 的 6 个修复项仍有回归覆盖。2026-11-17 的 7 个程序缺陷仍可复现，1 个移动端退出语义问题仍在。** 新确认了 Web 删除账号前的“停止”失效。另补查了启用 Sign in with Apple、上架 App Store 或 Google Play 时的删除要求。

账号体系已有本地档案隔离、可选的官方身份、自托管组织登录及端到端加密同步。近期还补齐了 CLI 按本地档案保存登录，以及同步空间切换提示和档案字段合并。登录产品最紧迫的缺口是删除取消、Tauri 恢复和移动账号入口。功能建设最优先的是可恢复的官方身份及其登录方式管理。

## 当前有哪些入口

| 场景                   | 当前行为                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全新 Browser           | 生产普通工作区先创建本地档案并确认 Browser Vault 恢复密钥。随后可登录官方账号或继续离线。公开分享有独立的访客路径。                                             |
| 全新 Tauri / Capacitor | 自动准备设备管理的本地档案。官方账号登录可跳过。Tauri 和宽屏 Browser 有侧栏账号管理。Capacitor 和 compact Browser 的“我的 → 云账号”只接通自托管配置与对应会话。 |
| 官方 Cognia 账号       | 首次和以后通过同一套第三方登录入口。客户端列出 Feishu、GitHub、Google、Apple。issuer 仅提供配置完成的方式，部署启用情况待验证。                                 |
| 自托管组织             | 有 Logto / OIDC、部署发现、组织选择、邀请及初始化。开放注册取决于部署策略。                                                                                     |
| 配对主机与账号同步     | 配对管理连接到某台 Host 的凭据。账号同步管理加密空间、设备审批与恢复密钥。两者各有生命周期，OAuth 登录会话也单独管理。                                          |

入口依据为 [AccountGate](../../components/account/account-gate.tsx)、[CloudSignInGate](../../components/account/cloud-sign-in-gate.tsx)、[移动云账号页面](../../app/me/cloud-account/page.tsx)、[官方账号子系统](../content/docs/en/subsystems/official-account.mdx)及[加密同步 ADR](../content/docs/en/adr/0215-one-person-one-encrypted-sync-space-many-writable-hosts.md)。

官方流程使用 authorization code + PKCE。issuer 配有数据库限流、路由 allowlist、refresh token 轮换及撤销。经验证邮箱相同才能自动关联第三方账号。Feishu 使用 tenant + union_id。删除申请要求新鲜认证并核对同一 subject，本地档案、官方身份及同步空间的删除范围各自有定义。真实 provider、浏览器 cookie 和跨设备结果仍需验收。

## 旧问题复核

2026-10-30 的 F1、F2、F3、F5、F6、F8 分别涉及错误身份替换档案 token、迟到 refresh 复活旧会话、退出后档案失去 owner、挂起的任务中断卡住空闲锁、旧回调锁住下一档案、原生删除凭据失败却报成功。现有应用集成回归和原生 secrets crate 测试均通过。旧 F4 仍是焦点/空闲时的产品策略，旧 F7 关于重复通知的风险仍按历史审查口径处理。见[修复报告](./2026-10-30-account-lifecycle-repair.md)、[认证生命周期集成测试](../../lib/identity/auth-lifecycle.integration.test.ts)和[空闲锁集成测试](../../hooks/account/use-auto-lock-on-idle.integration.test.ts)。

2026-11-17 的编号如下。完整的历史证据在[缺口审查](./2026-11-17-account-login-registration-gap-audit.md)和[对抗性复核](./2026-11-17-account-login-registration-adversarial-review.md)。

| 编号    | 当前结论     | 用户影响和证据                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 · P1 | 仍可复现     | Web 关闭登录弹窗后，主页面继续等待。模拟关闭并推进 10 分钟，真实 PKCE 客户端的等待仍未结束，门禁也没有取消或继续离线操作。[Web popup](../../lib/logto/web-popup.ts)                                                                                                                                                                                  |
| F2 · P1 | 仍可复现     | 首次选离线后，Capacitor / compact Browser 的“我的 → 云账号”缺少官方重新登录入口。已有官方会话也看不到该会话的退出和删除控件。宽屏 Browser 侧栏的账号身份页是可用入口，旧的广告入口仍存在导航偏差。[移动页面](../../app/me/cloud-account/page.tsx) · [身份页](../../components/account/manage/account-identity-tab.tsx)                               |
| F3 · P2 | 语义问题仍在 | 移动首页的“退出登录”处理订阅和配对，确认文案写明这个范围。官方云会话有独立生命周期，缺少同处可用的明确退出路径。[退出 hook](../../hooks/companion/use-companion-sign-out.ts)                                                                                                                                                                         |
| F4 · P2 | 仍可复现     | Web 和 Desktop 的过时回调可使正常的新登录事务失败。复现范围是待处理事务的可用性。Capacitor 源码也会把 mismatch 当终态，真机回调未验收。[Web popup](../../lib/logto/web-popup.ts) · [原生回调](../../lib/logto/deep-link-callback.ts)                                                                                                                 |
| F5 · P2 | 仍可复现     | 自托管的组织选择和未加入组织门禁可完成本地退出，但忽略 issuer 结束会话 URL 和撤销失败报告。账号身份页已有对应反馈。真实 issuer cookie 是否仍活跃待测。[门禁](../../components/account/cloud-sign-in-gate.tsx) · [身份页](../../components/account/manage/account-identity-tab.tsx)                                                                   |
| F6 · P1 | 仍可复现     | 旧删除任务与取消并行时，取消返回成功，随后测试身份及 OAuth 记录仍被删，状态保持 `cancelled`。取消先于任务读取的对照保留了账号。证据来自锁定源码的真实 SQL 和内存 SQLite，同步绑定为受控桩。[删除执行器](https://github.com/cognia-labs/cognia-services/blob/52ec93a316b6d25e81bc9da5206b597d60985f10/services/identity-server/src/deletion/purge.ts) |
| F7 · P1 | 仍可复现     | Tauri 密码档案创建或升级可以拿到本地内容恢复密钥，锁定后同一客户端的恢复操作拒绝兑换。Capacitor 直接调用 store 的相同分支也拒绝，移动可见入口和真机密钥兑换待验收。[账户 store](../../stores/account/account-store.ts)                                                                                                                               |
| F8 · P2 | 条件性复现   | 自托管 issuer 合法地只返回 `sub` 时，未加入组织页隐藏退出，首次登录也没有继续离线路径。适用性取决于部署发出的 claims。[门禁界面](../../components/account/cloud-sign-in-screen.tsx)                                                                                                                                                                  |

近期确实修过相邻层。CLI 登录按本地档案绑定 Person（`bbf1a686bc`），换到其他同步空间先征求用户选择（`b42fd14df3`），同步初始化可续传（`e2fdaeb567`），档案字段逐项合并（`3cfcf8f0b0`）。这些改动各自改善了 CLI 或数据同步。生产构建默认仍需显式启用账号同步，账号概览已有对应提示。[同步开关](../../lib/account-sync/feature-flag.ts) · [同步子系统](../content/docs/en/subsystems/account-sync-data.mdx)

## 本轮新增发现

**F9 · P1 · Web 删除确认的“停止”没有取消操作。** 真实删除组件把 `AbortSignal` 交给 platform driver，Web 分支没有接线。隔离 probe 经过真实 UI、PKCE 客户端及 Web driver，点击“停止”后仍停留在等待界面，随后同一身份的有效模拟回调仍触发删除申请 POST。所有网络响应都由 fixture 提供。原组件测试注入了主动监听 abort 的替身，因此通过。Capacitor 分支同样没有消费这枚 signal，但系统浏览器自带取消路径，范围留给真机确认。修复验收应确认点击停止后立刻恢复界面，后到响应无法发出申请，且重新确认可以正常完成。[删除组件](../../components/account/manage/official-account-deletion.tsx) · [driver 分发](../../lib/logto/platform-drivers.ts) · [既有测试](../../components/account/manage/official-account-deletion.test.tsx)

**发布条件 · Apple 授权撤销和 Google Play 站外删除入口。** 若发行启用了 Sign in with Apple，Apple 指引要求删除流程配合 Apple token 撤销。锁定 issuer 在持久化时丢弃社交 provider token，当前 purge 覆盖 Cognia 身份、OAuth 记录及配置后的同步空间，未找到 Apple 撤销调用。应核实发布方案是否存在其他符合 Apple 指引的渠道。Google Play 对支持应用内创建账号的应用要求同时提供应用内路径和可发起删除的站外链接。所审查的移动常规路径缺失官方删除控件，公开的站外删除入口和商店提交配置也未验证。影响取决于实际发布形态及 provider 配置。[Apple 删除账号指引](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion) · [Google Play 删除账号要求](https://support.google.com/googleplay/android-developer/answer/13327111) · [issuer token 持久化规则](https://github.com/cognia-labs/cognia-services/blob/52ec93a316b6d25e81bc9da5206b597d60985f10/services/identity-server/src/auth.ts)

## 功能缺口与行业对标

| 编号        | 当前差项                                                                                                                               | 对标与验收目标                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 · P1     | 官方账号失去唯一第三方身份后，没有独立的恢复入口。已持有的 E2EE 密钥只负责其对应的数据域。                                             | 至少可预先配置一个独立的备用登录方式。验证失去公司 Feishu 后可以恢复同一 Person，并独立验证同步解密。[Linear 登录方式](https://linear.app/docs/login-methods) · [NIST 身份恢复](https://pages.nist.gov/800-63-4/sp800-63b.html#account-recovery)                                                                                                                                                                           |
| G2 · P1     | 账号页能显示已关联 provider，issuer 没有开放用户添加、移除登录方式或变更邮箱接口。已验证同邮箱的自动关联只覆盖部分用户。               | 增删和邮箱变更前重新认证，明确目标账号，防止移除最后一个可用方式。跨账号关联需要对应的身份归属证明。[Notion 账号设置](https://www.notion.com/help/account-settings) · [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)                                                                                                                                               |
| G3 · P1     | 有当前 token 撤销及同步设备管理，缺用户可见的云登录会话列表、逐会话撤销、退出其他会话和全部退出。                                      | 让用户看见当前和其他会话，并在另一设备验证指定会话确实失效。本地档案、Host 配对和同步凭据各自说明。[GitHub 会话管理](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/viewing-and-managing-your-sessions) · [Notion 账号设置](https://www.notion.com/help/account-settings) · [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) |
| G4 · P2     | 本地快速解锁已有 passkey / 生物识别。官方 issuer 未提供自己的 passkey、MFA 管理或可见的认证强度策略，外部 IdP 可以独立实施 MFA。       | 将云 passkey 或上游强认证用于官方身份与高风险操作，连同备用方式和凭据丢失路径一起验收。[Notion passkeys](https://www.notion.com/help/passkeys) · [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)                                                                                                                                                                                                       |
| G5 · P2     | Browser 首次建档和云登录仍是两个阶段。本地内容恢复与同步恢复使用不同密钥，构建版本也影响可用功能。                                     | 在建档、登录和切换设备时，让用户分别看懂本地数据解锁、云身份恢复及哪些数据已经同步。保留现有同步状态提示，用首次体验验证理解成本。[账号同步 ADR](../content/docs/en/adr/0215-one-person-one-encrypted-sync-space-many-writable-hosts.md)                                                                                                                                                                                   |
| G6 · P2     | 当前路径未找到官方云账号的新会话、绑定或恢复通知，以及用户可见的安全历史。已有数据库限流和本地安全页。                                 | 将通知和历史接到可撤销入口，记录事件范围、时间和最近会话，验证恢复或新增登录方式后能发现异常。[Linear 安全通知](https://linear.app/changelog/2024-05-30-passkeys-a-fast-and-secure-way-to-log-in-to-linear) · [NIST 恢复通知](https://pages.nist.gov/800-63-4/sp800-63b.html#account-recovery)                                                                                                                             |
| G7 · P2     | 登录页有说明文字，所审入口未见可点击的隐私政策、条款或版本化确认。客户端固定列四个 provider，issuer 对不可用 hint 会回到实际可用列表。 | 首次创建前可查阅政策。展示该 issuer 的可用方式，清楚反馈 provider 取消或不可用，并提供重试与离线路径。生产启用情况待核实。[官方登录界面](../../components/account/cloud-sign-in-screen.tsx)                                                                                                                                                                                                                                |
| G8 · 条件项 | 自托管已有 OIDC、组织 membership、邀请和初始化。官方路径还未建立域名认领、组织强制登录、SCIM 离职回收和企业安全审计的完整证据。        | 有企业客群需求时独立验收组织登录方式、入离职撤权及安全审计。[Linear 登录方式](https://linear.app/docs/login-methods) · [Linear SCIM](https://linear.app/docs/scim)                                                                                                                                                                                                                                                         |

协议取舍以 [RFC 8252](https://datatracker.ietf.org/doc/rfc8252/)、[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html)为参照。保留系统浏览器或系统认证会话及 PKCE，并使每次交互独立、可取消。发行版本还应验证真实回跳、issuer logout 和 refresh token family 的实际处置。NIST 的网络认证密码要求可为本地 vault 的弱密码拦截、长口令和密码管理器支持提供参考。云上密码、身份恢复与本地加密恢复需要独立验收。

## 修复次序及验收

1. **先保证删除和恢复的承诺。** 删除任务与取消由同一服务端状态转换裁决，并覆盖重试和同步绑定部分失败。Web 删除确认可取消，后到回调无副作用。对 Tauri 执行创建密码档案、保存密钥、锁定、兑换、重启后验证原数据可读的闭环。
2. **接通登录入口和退出。** 验收 Browser、Tauri、Capacitor 上的首次离线后重新登录，取消与重试，正常并发登录回跳，及已配对和未配对时退出指定会话。向用户分别反馈本机退出和远端撤销结果。
3. **补可恢复身份，再补账户安全管理。** 用“丢失唯一 provider 后回到同一账号”验收备用方式。随后验证登录方式变更、逐会话撤销、安全活动记录和通知。结合同步建立数据恢复说明及适用的商店发布门槛。

## 验证记录

| 检查                          | 结果和范围                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前应用、CLI 和同步定向 Jest | 18 suites、334 tests 通过。包括旧 profile/session 修复、空闲锁、移动退出、CLI 身份绑定和同步。首轮命令有 1 个路径后缀误写，修正后完整重跑。    |
| 2026-11-17 持久化反例         | 6 suites、13 probes 通过。通过表示预期的现存失败被复现。                                                                                       |
| 锁定 issuer 的完整 Vitest     | 临时目录按 lockfile 安装，24 suites、125 tests 通过。使用本地 workerd / D1 和受控 provider，包含轮换及撤销，不包含真实 issuer 或所有并发组合。 |
| issuer 删除竞态               | 复现和对照均通过。取消竞态中测试身份与 OAuth 记录被删；取消先于读取时保留。                                                                    |
| Web 停止删除确认              | 1 个新隔离 probe 通过，复现停止后仍收到删除申请。JSDOM 替代浏览器窗口与 issuer 传输。                                                          |
| 原生凭据层                    | `cargo test --locked --offline -p cognia-secrets --lib`，114 passed。范围为 crate 测试。                                                       |

日志和新增 F9 隔离 fixture 保存在 `.cache/account-registration-recheck/`。锁定 issuer 及客户端源码与测试结果适用于本地复核。本轮实际验收仍缺生产 Browser、Tauri、Capacitor 和真实 IdP 的全流程，线上分支、provider 配置、商店提交及同步绑定状态。交付为审查报告和原台账更新，产品实现、发布与真实账号状态未改动。
