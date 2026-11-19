# 账号、登录与注册缺口审查

日期：2026-11-17（Asia/Shanghai）。范围：当前客户端、自托管登录边界、官方 identity-server 的锁定源码，以及当日查阅的一手行业资料。仅开展审查、隔离复现和文档记录，没有修改产品行为或操作真实账号。

结论：Cognia 已具备认证协议、本地隔离和加密恢复的基础，但账号生命周期还未形成一致的产品闭环。经后续对抗性审查，当前累计确认 **7 组程序缺陷、1 组退出语义问题**；另有 **8 组功能建议或待验证缺口，以及 4 组真实环境验证事项**。新增的删除取消竞态、native 恢复钥匙无法兑换应先于功能扩展处理，再修复账号入口、登录中断及退出反馈。增加更多社交登录按钮的优先级较低。

对抗性修订的逐项反证、被否定的推论和新增问题见[对抗性审查报告](./2026-11-17-account-login-registration-adversarial-review.md)。

本报告复用[既有账号证据台账](../evidence/2026-10-30-account-startup-lock-lifecycle-audit.md)。另建报告是为了保存本次更广的功能对标，避免覆盖 2026-10-30 的启动、锁定和修复历史。复现文件单独保存于 [audit probes](../evidence/2026-11-17-account-login-registration-gap-audit.probes/)，以便清理 `.cache/` 后仍能重跑。

## 1. 先分清四种身份与会话

| 层次                         | 当前含义                                                      | 不能据此推出的能力                                                    |
| ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| LocalProfile / 本地账号      | 选择本地数据库、内容密钥、凭据命名空间和锁定策略              | 不是官方账号注册，也不自动获得云备份                                  |
| 官方 Cognia Person           | 可选的个人云身份；通过 Feishu、GitHub、Google、Apple 登录     | 本地 passkey 不等于云账号 passkey；成功登录不等于已加入加密同步       |
| 自托管 Person + Organization | 向指定部署登录，通过 membership、邀请或部署初始化取得组织身份 | 不是向所有人开放的公共注册；组织邀请制可以是正确产品策略              |
| 配对 Host / Companion        | 客户端连接特定主机的凭据和数据通道                            | 断开配对不等于退出 Cognia 云账号；移除同步设备也不等于撤销 OAuth 会话 |

来源：[ADR-0054](../content/docs/en/adr/0054-local-multi-account-isolation.md)、[ADR-0149](../content/docs/en/adr/0149-a-person-is-not-a-device.md)、[ADR-0215](../content/docs/en/adr/0215-one-person-one-encrypted-sync-space-many-writable-hosts.md)、`lib/identity/official-deployment.ts`、`lib/identity/cloud-sign-in-flow.ts`、`hooks/companion/use-companion-sign-out.ts`。

当前首次使用路径存在平台差异：生产 Browser 普通工作区入口先创建本地账号并确认 Browser Vault 恢复密钥，再进入后续门禁；公共分享链接的 guest viewer 是明确例外，无账号时直接阅读，不经过建号。Tauri / Capacitor 在启动时自动准备设备管理的本地空间。官方账号允许继续离线，自托管组织登录另有 membership / invitation 流程。开发环境会跳过部分门禁，因此不能用普通 `next dev` 的体验代表正式版本。

## 2. 已有能力与应当保留的防护

- 官方账号采用 OIDC authorization code + PKCE；自托管保留 Logto。客户端区分官方 personal identity 与组织 identity。
- 本地账号物理数据库隔离；凭据按 profile 命名空间保存；登录前检查 profile 的持久 owner。认证 revision / CAS 防止迟到的登录、refresh 或注销回调覆盖新状态。
- 本地密码可更改；提供 PIN、图案、WebAuthn PRF passkey、原生生物识别快速解锁，能力取决于运行环境。Browser 密码 verifier 使用 PBKDF2 600,000 次；native 共用 Argon2id KDF。
- Browser Vault 有恢复密钥与重设密码入口。Native password profile 也会生成/展示内容恢复钥匙，但目前同一 native shell 的恢复 action 拒绝兑换，见 F7。账号同步另有设备批准、恢复密钥、设备移除和 epoch 轮换机制。
- 官方 issuer 不保存社交 provider access / refresh tokens；Feishu 身份使用 tenant + union_id；自动关联要求双方已验证的相同 email，不把未验证 email 当作身份凭证。
- issuer 有数据库级限流、精确路由 allowlist、关闭动态 client registration。当前源码和既有测试包含 refresh rotation / revocation；上游还包含 replay 后的 client/user family invalidation，不能概括为底层永远只撤销单个 token。
- 官方账号删除已经实现：新鲜登录、同一 subject 校验、默认 7 天且可配置的冷静期、取消申请接口与定时 purge；取消与已启动 purge 缺少原子协调，存在 F6 的已复现竞态。配置了 `SYNC_ADMIN` 的部署还会删除同步空间。本地数据删除是另一个动作。

来源：`lib/logto/{client,app-session,session-store}.ts`、`lib/identity/{sign-in,user-binding,official-account-deletion}.ts`、`lib/accounts/{password-client,password-policy}.ts`、`lib/accounts/quick-unlock/`、`crates/cognia-secrets/src/password_kdf.rs`、外部 identity-server 的 `src/{auth,route-allowlist}.ts` 和 `src/deletion/`。

上述是源码与隔离测试范围的能力盘点，不代表真实 provider、每种设备或生产部署均已验收。此前台账中的 owner 混淆、迟到 refresh 恢复已退出会话等旧缺陷已有修复，本报告没有将其重复列为当前问题。

## 3. 当前缺陷

优先级：P1 为会阻断主要路径或使退出承诺不成立的问题；P2 为有条件触发、可恢复但需要修复的问题。本轮未证明账号接管或跨用户数据泄露，因此没有据此列 P0。

### F1 · P1 · 关闭 Web 登录弹窗后，主界面没有退出等待的路径

触发：点击官方或自托管登录，随后直接关闭登录 popup。

`lib/logto/web-popup.ts:62` 的 `waitForCode` 只监听 `message`；既不观察 popup 关闭，也没有超时。`platform-drivers.ts` 的 Web 分支没有接入 abort；门禁进入 `signing-in` 后，`cloud-sign-in-screen.tsx:87` 只显示状态，没有取消、重试或继续离线按钮。

隔离复现执行了真实 driver、gate 和 screen，关闭 popup 后推进 **10 分钟 fake time**，Promise 仍 pending，页面仍显示 `signingIn`，可操作按钮为 0。需要刷新才能恢复。fake time 是确定性反例，不是浏览器实测的等待时长。对抗性复核又以真实 loginToLogto → runPkceAuthFlow → Web driver 路径复现等待，仅替换网络响应；原 gate probe 的 signIn 注入和 no-op scope guard 不能用于证明跨账号、取消或迟到提交安全。

建议：为每次登录建立可取消的事务；popup 关闭、超时、组件卸载均完成清理并返回可重试状态；保留取消及离线操作。修复验收应覆盖阻止弹窗、关闭弹窗、provider 取消、网络断开和迟到回调。

### F2 · P1 · Capacitor / compact Web 的官方账号入口未接通，Browser 的广告入口也有误

触发：在 Capacitor 或使用 compact shell 的 Browser 首次选择继续离线，再从“我的 → 云账号”重新登录；或已登录后从该页面管理账号。这里按 shell 分支判断，不能直接等同于物理手机：宽屏 Browser 有不同的侧栏入口。

`app/me/cloud-account/page.tsx:30` 只挂载 `CloudDeploymentCard`。该 card 在 `stored` 自托管地址存在时才读取 session（`:132`），登录和退出按钮也只在 `stored` 分支（`:301`）内；默认官方账号、没有自定义地址时，只呈现官方说明和自托管配置表单（`:383–398`）。两个渲染 probe 分别确认：signed-out 和 active 的官方 profile 都没有这些会话控制，连 `readState` 都没有调用。

`official-sign-in-prompt.ts:36` 又将首次离线决定持久保存，后续启动不再主动提示。因此该常规移动路径无法履行“以后到账号设置登录”的承诺。这里确认的是这个入口未接通；没有声称所有手工 deep link 或隐藏入口都不可用。宽屏 Browser 的侧栏“管理账号 → 身份”可以打开 AccountIdentityTab，是可用的反例；该 tab 已有 request-sign-in、退出和删除控件。另两条广告入口确实有问题：离线提示指向“设置 → 账号”，但该页的管理按钮/dialog 用 isTauri() 隐藏于 Browser；侧栏“登录”又指向旧 companion 设置并重定向到同一个 CloudDeploymentCard。因此不能声称所有 Browser 登录都无路可走。

建议：为移动端提供真正的官方账号中心，展示当前 person、登录方式、登录/退出、同步状态与删除入口；把自托管部署配置作为独立的高级设置。用一条完整测试覆盖“首次离线 → 从我的登录 → 重启 → 退出”。

### F3 · P2 · 移动“退出登录”实际是订阅和配对退出，缺少统一的账号语义

`app/me/page.tsx` 底部的 `SignOutButton` 调用 `useCompanionSignOut`。实际 hook 只处理 Anthropic subscription、`clearCompanionConfig()`，随后跳转 `/pair`（`hooks/companion/use-companion-sign-out.ts:83–103`）。该路径没有调用 `signOutFromLogto`、官方 session 删除或 `completeSignOut`。

所以当本机同时存在官方云会话和配对信息时，这个按钮成功返回只说明订阅退出流程和配对清理已执行，不能表示官方身份已退出。需要同时保留的反证是：`i18n/messages/zh-CN/mobile/me.json:194,200` 的确认和成功文案已明确写出 Anthropic 凭据及配对 JWT，不能将其描述为“承诺全局退出却未履行”。本项属于按钮命名、账户心智与官方退出入口缺失的问题，部分与 F2 重合。既有 hook 测试确认清理调用和成功返回；未在真机验证保留云 token 重启后的可用性，也没有据此推导明文泄漏或账号接管。

建议：区分“退出 Cognia 账号”“退出订阅账号”和“断开这台主机”；新增或接通官方退出动作，清理其明确承诺范围的 session 和运行时身份，并反馈远端撤销结果。本地加密数据是否保留应单独说明。验证必须覆盖官方登录 + 已配对、官方登录 + 未配对、仅配对三种组合。

### F4 · P2 · 旧回调会消费另一笔正在等待的登录事务（Web / Desktop）

`lib/logto/web-popup.ts:3,43,84` 把所有 tab / profile 的 callback state 写入同一个 `localStorage` key；回调在比较之前就删除这个 key。popup 名称也固定。

两个确定性反例：A 开始 → B 开始 → A 回调，A mismatch 且消费 B 的 state，随后合法 B 回调也失败；旧的无关回调也能删除当前 state。确认的是正常并发/重试时的可用性缺陷，**没有证明 state 校验被绕过**。

Desktop 也有同类反例：deep-link-callback.ts:71–80 在比较 state 前移除 listener，旧 A 回调使等待中的 B 拒绝，后到的正确 B 回调无法恢复。此处删除的是待处理事务，不是已保存 session。Capacitor 源码也返回 mismatch，但本轮未做对应真机验收。

建议：按随机 transaction id 隔离 pending state 和窗口；只有匹配的响应能消费自己的记录；绑定预期 popup source，过期事务独立清理。保留 state 与 PKCE 校验。

### F5 · P2 · 门禁内退出丢失远端注销结果

组织选择或未加入组织时显示的退出按钮，调用 `components/account/cloud-sign-in-gate.tsx:153` 的 `defaultSignOut`。它丢弃 `signOutFromLogto` 的返回报告，包括 `endSessionUrl` 和 token 撤销失败状态，然后直接恢复登录选择（`:658`）。

probe 注入“access / refresh 撤销均失败 + 有 end-session URL”的真实返回形状，确认没有打开 URL，也没有错误提示。相反，账号设置页的退出会提示撤销失败并打开 end-session URL。浏览器 issuer cookie 是否实际继续生效仍需真实 IdP 验证，但该入口未发起 RP logout 的代码事实已确认。

建议：所有出口共用同一份有类型的退出结果处理，区分本地已退出、远端撤销失败、issuer cookie 注销尚未完成。用户可以离开，但不能收到含糊的成功承诺。

### F6 · P1 · 取消删除返回成功后，已启动的 purge 仍删除账号

identity-server 的 src/deletion/purge.ts:63–73 先快照选出到期用户，等待外部 purge hook，再删除 OAuth rows 和 user。与此同时 routes.ts:66–68 允许 DELETE 取消；store.ts:75–83 仅检查 pending，没有执行阶段/申请版本的 CAS。取消成功后旧 job 继续工作，markPurged 因状态已 cancelled 不更新，但 report 仍报告 purged。

隔离 probe 运行锁定源码的实际 store.ts / purge.ts，使用真实 SQLite、原始迁移和 SQL，只控制外部 hook 与 deleteUser 边界：cron 选中到期申请 → 等待 hook → 取消返回 cancelled → 释放 hook → user/access token/refresh token/consent 四表均为 0，删除记录仍为 cancelled。对照场景“在 cron 快照前取消”保留账号。确认的是可达竞态，不是生产事故。

建议：在任何不可逆外部 effect 前，以申请版本和明确的 purging 阶段原子领取；取消与 job 领取采用互斥状态转换。已不可取消时不能返回 cancelled。仅在 hook 后重新读状态不足以保护已执行的同步空间删除。需要真实 D1 / service-binding 并发验收。

### F7 · P1 · Tauri 展示恢复钥匙，但锁定后没有同 shell 兑换路径

stores/account/account-store.ts:1010–1030 在所有 runtime provision 内容 Vault，:1058–1065 向 password profile 展示恢复钥匙；Tauri 从设备空间设为密码保护时还会展示保留钥匙（:1709–1713）。门禁要求保存确认。但 lock screen 仅在 usesBrowserVault() 时显示恢复入口，恢复 action 在 native 分支直接抛出 vault-not-provisioned（:1433–1437）。

三条 actual-store probe 确认：Tauri 新建 password profile、Tauri 设备空间设密码，以及直接调用 Capacitor store 建立 password profile 后，均可看到钥匙，却在锁定后被恢复 action 拒绝，Vault reset 从未调用。前两条在 Tauri 账号管理界面可达；Capacitor 反例只证明 store 路由，不代表 compact UI 已有同样建号入口。

unlockSecretStore 只重试 OS secret-store 初始化；native password rotation 又要求已解锁 session 和当前密码，均不能替代遗忘密码后的恢复。没有证明钥匙在密码学上不能解密数据，也没有对真实 native 账号操作。需要设计 host 侧合法的恢复证明与 password verifier 更新，不能简单跳过 native 安全检查。

### F8 · P2 · 缺少可选 name/email 的自托管登录会隐藏退出操作

CloudSignInGate 的 settle 仅从 name/email 设置 personName（:242–244）；CloudSignInScreen 把整个退出 footer 放在 personName 真值条件内（:146）。没有这些可选信息的 subject-only 身份本已被 resolveIdentityFromClaims 支持，却会在 unaffiliated 页面失去 Sign out，且该页面没有 Continue offline。

actual gate/screen + 真实 Dexie/fake-indexeddb + 真实 captureAccountScope 的 probe 确认该形状；只注入外部登录和 membership 结果。不是每个 provider 都会触发，也没有进行真实 IdP 身份签发；它证明了客户端支持的身份形状可以导致退出入口消失。建议使用 subject/displayName fallback，并让退出操作与展示名独立。

## 4. 功能和体验缺口，以及行业对标

以下是产品能力差距，不自动等于安全漏洞，也不要求 Cognia 同时引入邮箱密码、短信和所有社交登录。

| ID / 建议优先级                         | Cognia 当前状态与缺口                                                                                                                                                                                                                                                     | 业内参考 / 建议                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 · P1 · 可恢复的云身份                | 官方仅有第三方登录，`emailAndPassword.enabled=false`；没有独立邮箱 code、云 passkey 或恢复身份入口。失去原 provider 后，sync 恢复密钥不能代替身份登录。                                                                                                                   | 至少提供一个事先配置的备用身份或独立登录方式，以及清晰的失去 provider 恢复流程。恢复身份和解密数据是两步，不应承诺客服能恢复 E2EE 密钥。                                                                 |
| G2 · P1 · 登录方式管理                  | UI 只从 token 展示已关联 provider；官方 allowlist 不开放显式 link/unlink、email 变更。双方已验证 email 的自动关联无法解决 Feishu 无可信 email、Apple 隐藏 email、工作/个人 email 不同的常见情况。                                                                         | 提供重新认证后添加/移除登录方式、确认目标账号、最后一个入口保护和身份冲突提示。不能用“同 email”或客户端 principal link 直接代替用户证明两个账号都归自己。                                                |
| G3 · P1 · 远程会话管理                  | 有单次 token revoke 和加密同步设备管理；没有面向用户的 OAuth 登录会话清单、逐会话退出和全设备退出接口/页面。                                                                                                                                                              | 增加 session 列表、最近活动、退出其他会话、全部退出。区分云会话、同步设备和配对主机，并说明已下载的数据无法远程收回。                                                                                    |
| G4 · P2 · 云账号强认证                  | 本地 PRF passkey / biometric 已有；官方 issuer 未配置云 passkey、TOTP/MFA 或面向用户的强认证策略，现有 allowlist 也不开放这些路由。不能由此推断用户的 Google / Apple 等 provider 没有 MFA。                                                                               | 可评估云 passkey + 备用方式，或依赖 IdP 强认证并验证所需认证上下文；缺少自建 MFA 不等于外部身份只有单因素。对管理登录方式、恢复及其他高风险变更做 fresh authentication。删除账号已有这部分防护，应复用。 |
| G5 · P2 / 待验证 · 身份与数据的产品表达 | Browser 首次要创建本地账号并保存一把恢复钥匙，官方同步又有另一把钥匙；native 同 shell 恢复另见 F7。默认 production 的 account-sync flag 关闭，但 AccountSyncSummary 已在 account overview 明确显示该构建未提供同步。多把钥匙本身是不同加密域的合理设计，不足以直接定 P1。 | 明确说明“本地锁”“Cognia 身份”“同步”“两类恢复密钥”的作用；保留已有构建能力提示，再验证用户是否能理解哪些数据已备份。评估渐进式设置，不将登录成功暗示成云备份完成。                                        |
| G6 · P2 · 账号安全中心                  | 已有本地 security tab；未找到官方账号的新登录/新增登录方式/异常恢复提醒及用户可读的安全历史闭环。issuer rate limit 已有，不能据此说完全没有防滥用。                                                                                                                       | 提供新会话与安全设置变化通知、可撤销入口、安全事件历史；对认证漏斗记录脱敏阶段、取消原因和失败类型。此项为当前已检查路径的缺口，生产外围告警另待核实。                                                   |
| G7 · P2 · 注册前告知与 provider 可用性  | 官方注册/登录 UI 有 privacy 说明文字，但所审查的入口没有可点击隐私政策/服务条款及版本记录。客户端固定展示四个 provider，issuer 仅启用已配置的 provider；未启用的 hint 会回退为实际可用 provider 列表，不能直接推导登录失败。                                              | 补齐政策链接和必要的版本化确认；让服务端公布已启用的方式，或在跳转前给出明确可用性结果。后者是条件性配置风险，未证明生产有某个 provider 故障。                                                           |
| G8 · 条件项 · 企业生命周期              | 自托管已有 OIDC、组织 membership、邀请和 bootstrap。未从本轮官方身份路径建立域名认领、组织强制登录策略、SCIM 离职回收和企业安全审计的完整证据。                                                                                                                           | 若目标包括企业客户，再单列 SAML/OIDC enforcement、SCIM、域名归属与离职撤权验收；个人本地优先产品不必一开始补齐全部企业能力。                                                                             |

对标依据：

- [Notion 账号设置](https://www.notion.com/help/account-settings)将登录方式、验证 email、两步验证和全设备退出集中管理；[Notion passkeys](https://www.notion.com/help/passkeys)包含创建、管理和丢失后使用备用方式的流程。Cognia 值得借鉴的是完整生命周期与跨端可达性。
- [Linear 登录方式](https://linear.app/docs/login-methods)与[安全能力说明](https://linear.app/security)列出 email code、SSO、passkey，以及企业 SAML / SCIM 和登录方式限制。[Linear passkey 公告](https://linear.app/changelog/2024-05-30-passkeys-a-fast-and-secure-way-to-log-in-to-linear)还将新会话、安全设置变化通知作为配套能力。这是对 G1–G4、G6、G8 的产品参考。
- [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)强调恢复和高风险行为重新认证；[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)要求明确退出并在服务端使已退出会话失效。这支持修复 F3/F5 与补齐 G3，而不是要求把所有独立登录会话无差别一起关闭。
- [RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700)要求 public client 使用 PKCE，以及 refresh token sender constraint 或 rotation。Cognia 已采用 PKCE，issuer 已有 rotation 测试；仍需补验旧 refresh token 重放后的 token-family 处置，不能把 rotation 测试直接当成全部 replay 防护已验收。
- [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)对网络认证的单因素密码采用至少 15 字符，并要求常见/泄漏密码 blocklist。Cognia 本地密码硬门槛目前仅 8 字符且无 blocklist，强度展示主要按长度和字符类别评分。由于这里保护的是本地 vault，不能直接断言违反其网络认证要求；可借鉴长 passphrase、常见弱密码拦截与密码管理器支持，避免把复杂度打分当作抗猜测证明。

## 5. 建议实施次序和验收边界

1. **先修复不可逆和恢复问题，再完成核心闭环**：F6/F7 优先，然后 F1/F2/F4/F5/F8；F3 为退出语义整理。验收覆盖首次离线后重新登录、popup 取消、双 tab、旧回调、注销远端失败和官方登录+配对组合；三种 shell 分别确认。
2. **再提供身份可恢复性**：G1/G2；定义失去公司 Feishu、第三方被封禁、不同邮箱、最后一种登录方式被移除时的处理。关联新增身份前要求双方重新认证。恢复密钥继续只负责其既定密钥域。
3. **补齐账号安全管理**：G3/G4/G6，提供 session 管理、强认证和通知；复用现有 fresh-login 与 typed logout reports，避免再做一套分叉逻辑。
4. **整理首次体验与发布条件**：G5/G7，清晰区分本地与云账号，统一三端术语、政策链接、provider 启用状态和 sync flag；有企业需求再推进 G8。

可衡量的结果应是：新用户能理解自己是否已登录、是否已备份；中断登录可恢复；失去一个 provider 后仍有合适的恢复路径；退出后指定范围的会话确实失效。新增按钮数量和单测数量均不能替代这些结果。

## 6. 首次审查的验证与未验证事项

环境：macOS / Apple Silicon；客户端 HEAD `3fae43be64`，`dev` 分支；共享工作树存在大量其他任务变更。使用当前工作树源码，仅编辑本任务文档和 audit probes。

官方服务 pin 为 `487e9f2d617c9d1b9b648ec510cafcf53b962c2c`；相邻 `cognia-services` checkout HEAD 为 `71984922519c7bed73332bc38f9178fed444dbbc`。检查 `services/identity-server`，两者没有源码差异，该子目录也没有未提交变更。没有据此推断线上部署已更新。

实际结果：

| 检查                                                                       | 结果                            | 实际边界                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| 当前 16 个 account / identity / OIDC / quick-unlock / mobile logout suites | **16 suites，325 tests passed** | 含 auth-lifecycle integration；没有覆盖率，没有实际 provider                             |
| 新增隔离反例                                                               | **2 suites，6 probes passed**   | 4 个 cloud probes + 2 个 mobile card probes；通过表示成功复现缺陷，不是修复成功          |
| Fresh-context cloud lifecycle review                                       | 完成，保留 3 组有反例的缺陷     | source + injected external edges，无真实 IdP cookie                                      |
| identity-server focused Vitest                                             | **未执行成功**                  | 独立服务无 `node_modules`，`vitest: command not found`；已有服务测试仅阅读，不算本轮通过 |
| 真实 Browser / Tauri / Capacitor + IdP                                     | **未运行**                      | 未建立隔离测试身份、真机和 production-shell 环境                                         |

审查 probe 文件的 scoped ESLint 已通过（0 warnings）；证据台账 `check --final` 已通过（0 errors / 0 warnings）。这些检查仅覆盖本次审查材料。

root `pnpm test` 首次执行触发自动 install，postinstall 被既有 sidecar linked-package 的 node export-condition 校验挡住，未进入 Jest。后续使用 `pnpm_config_verify_deps_before_run=false` 运行已安装依赖。一次 focused 路径误写 `.test.ts`，修正为实际 `.test.tsx` 后得到上表的最终通过结果。保留失败日志，不把失败的命令计入通过。

重跑反例：

```sh
pnpm_config_verify_deps_before_run=false rtk proxy pnpm test -- \
  --config docs/evidence/2026-11-17-account-login-registration-gap-audit.probes/jest.config.mjs \
  --runInBand
```

focused 测试路径：`lib/identity/{auth-lifecycle.integration,cloud-session,official-account-deletion}.test.ts`、`lib/logto/{client,web-popup,app-session}.test.ts`、`lib/accounts/{password-policy,tab-session-unlock}.test.ts`、`lib/accounts/quick-unlock/{client,passkey}.test.ts`、`components/account/{account-gate,cloud-sign-in-gate}.test.tsx`、`components/account/manage/{account-identity-tab,account-security-tab}.test.tsx`、`hooks/companion/use-companion-sign-out.test.tsx`、`components/mobile/me/sign-out-button.test.tsx`。

日志位于 `.cache/account-registration-audit/`：`focused-tests.log`、`durable-probes.log`、`identity-worker-tests.log` 和初始失败日志。源码探查时 CodeGraph 返回缺少索引，已使用 `rg` 与 owning source 继续；没有创建或更新索引。未对仅文档审查声称完整 app build、lint 或 native 安全验收。

仍需完成的四组验证：

1. **provider 与注册可达性**：生产四种 provider 实际启用、Feishu 跨租户资格、Apple 回调、授权取消、首次建号/重复注册/身份冲突；源码列出 provider 不代表配置和资格已就绪。
2. **真实退出和重放**：真实 cookie 的 RP logout、token 撤销后各 resource server 的失效时延、旧 refresh token replay / family 撤销、登出与并发 refresh 的端到端竞态。
3. **恢复与删除闭环**：丢失 provider、丢失设备/恢复密钥、native secret store 不可用；7 天后 identity 与同步空间 purge、失败重试、离线副本说明。源码有删除机制不等于生产已完成一次删除验收。
4. **三端真实用户路径与测量**：release Browser / Tauri / Capacitor 的首次使用、离线后回归、移动 account controls、系统浏览器返回、passkey/biometric 支持，以及注册完成率、取消率和错误归因。

后续对抗性审查的新增验证与结论单列在[对抗性审查报告](./2026-11-17-account-login-registration-adversarial-review.md)；上表 325 tests / 6 probes 为首次审查的历史结果，不代表后续新增探针数量。

这些事项保持在台账的 open residuals 中。本轮审查可以交付，但没有把账号体系记为“已修复”或“已生产验收”。
