# 后台控制 B，同时让用户继续操作 A

| 项目        | 内容                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| 状态        | 调研与设计稿；没有新增后台驱动实现、安装或真机能力声明                                                                    |
| 作者 / 日期 | Codex / 2026-11-03，Asia/Shanghai                                                                                         |
| 深度        | Heavy：本机输入、窗口身份、Host 权限、SDK 协议和人机并发                                                                  |
| 用户场景    | 用户继续在 A 中输入、点击和拖拽，Agent 调试同一台 Mac 上已经打开的 B                                                      |
| 关联        | ADR-0020、ADR-0242；[现有证据账本](../evidence/2026-10-28-desktop-automation-parity-audit.md)                             |
| 评审角色    | Native maintainer、Automation/SDK maintainer、Desktop QA、Security reviewer                                               |
| 新文档理由  | 当前 ledger 保存事实和未完成验收；screen-off ADR 与 Lume 方案具有不同目标。独立方案避免把新的后台输入承诺写入既有能力说明 |

## 1. 推荐按窗口后台投递，并把“不抢前台”纳入执行权限

**这个场景可实现，推荐让 Agent 绑定 B 的具体窗口，并优先走控件语义、浏览器或应用调试协议；通用像素输入通过单独验证过的原生后台驱动补足。** A 继续使用系统前台、物理鼠标和键盘。

首期支持已经启动、同一 Space、非最小化的 B；允许 B 被 A 遮挡。最小化、隐藏、其他 Space、全屏、权限弹窗和任意游戏/画布各自需要兼容性资格，不能从“后台窗口可点击”推导出来。

`backgroundOnly` 是 Host 强制的执行约束。没有经过资格验证的后台路径，就报告不可用并暂停；不得自动激活 B，也不得把 Unknown 结果重放到前台。需要前台的动作保留为用户主动选择的另一种运行方式。

原生程序可以在收到动作后自行激活或打开菜单。公共控件接口、甚至已有原生后台驱动，都不能对任意 B 承诺全过程零焦点变化。因此严格模式只放行经过应用/版本/动作组合验证的路径；发现意外抢焦点立即停止后续输入、撤销该组合的资格并报告已发生的干扰。

本文交付调研和可评审设计；既有 P1 双屏真机验收仍按 ledger 保持未完成状态。

## 2. 行业经验支持“按能力分层”，没有通用的后台开关

以下为 2026-11-03 读取的一手资料。产品文档证明其公开行为，开源实现说明工程机制；均不构成 Cognia 已通过兼容性验收的证据。

| 参考                                                                                                                      | 已公开的经验                                                                | Cognia 的采用边界                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [OpenAI Computer Use](https://learn.chatgpt.com/docs/computer-use)                                                        | 官方列出 macOS 下用户继续使用其他应用的后台场景；Windows 的前台限制单独说明 | 证明本机 A/B 并行是可交付产品目标；没有公开足以直接复用的完整 macOS 驱动实现 |
| [UiPath UI Automation](https://docs.uipath.com/studio/standalone/2025.10/user-guide/ui-automation)                        | 区分控件模拟、窗口消息和硬件事件；前两者的后台适用性取决于目标技术          | 按动作选择投递机制，并核验最终效果。不能把硬件鼠标键盘路径标成后台能力       |
| [Cua Driver 机制](https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/concepts/how-cua-driver-works.mdx) | 每次输入绑定窗口/进程；区分后台、页面协议、前台以及动作效果                 | 参考窗口身份、路由和结果契约；上游 `main` 文档不是已固定或验收的发行版本     |
| [Cua macOS 限制](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/MACOS.md)                 | 菜单可能短暂抬窗，应用可自行激活；部分拖拽依赖应用调试协议，其他组合拒绝    | 不能照搬“后台”标签为“绝不打断”；严格模式需要预先拒绝已知抬窗路径及未知组合   |
| [Cua macOS 原理](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)                           | 窗口定向输入使用平台专有机制，包含 SkyLight/private SPI                     | 候选实现需要版本固定、授权边界和系统兼容性评审；本轮不安装或调用这些机制     |
| [Microsoft PiP](https://learn.microsoft.com/en-us/power-automate/desktop-flows/run-desktop-flows-pip)                     | 单独桌面/会话适合隔离 GUI 自动化，模式有各自限制                            | 可选的隔离路线；它改变应用实例/会话，不能替代用户指定的本机 B 场景           |

## 3. 现有代码能复用观察和安全边界，通用输入仍依赖前台

| 状态                | 当前事实与所有者                                                                                                                                                                                                  | 设计影响                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Confirmed           | [worker.rs](../../crates/cognia-automation/src/automation/worker.rs) 的 `deliver_action` 分离 semantic 和 synthetic；TypeText、PressKey、Drag 不走 semantic                                                       | 保留分层，增加后台路由的 admission，不删除前台路径的安全检查                                      |
| Confirmed           | [AX backend](../../crates/cognia-automation/src/automation/platform/ax/mod.rs) 的 Pointer/Keyboard 校验系统焦点和窗口；Pointer 使用系统级 hit-test                                                                | 这是全局投递的必要保护。后台路径需使用 B 自身窗口/控件校验，系统级 hit-test 会命中遮挡它的 A      |
| Confirmed           | AXPress、AXValue 等语义操作与显式 Focus 已有实现                                                                                                                                                                  | 按控件能力复用；语义调用仍可能引起应用自己的激活行为，不能整体宣称无干扰                          |
| Confirmed           | [session.rs](../../crates/cognia-automation/src/automation/session.rs) 已有 windowId、surface、revision、一次 turnToken 和捕获身份                                                                                | 保留这些绑定，扩展执行约束和明确窗口选择；当前 AppLocator 只定位应用，不足以选择 B 的任意一个窗口 |
| Confirmed           | [ScreenCaptureKit bridge](../../crates/cognia-automation/native/macos/screen_capture.m) 和 [Rust capture](../../crates/cognia-automation/src/automation/platform/ax/screen_capture.rs) 提供按窗口截图及帧几何校验 | 观察 B 不必截取被 A 遮挡的桌面区域；当前修正版本的完整真机验收仍未通过                            |
| Confirmed           | [screen-off driver](../../crates/cognia-automation/src/automation/virtual_display/driver_macos.rs) 的 `prepare_application` 会迁移并激活目标，输入还要求其拥有键盘焦点                                            | screen-off 解决显示生命周期，不提供独立人机输入。严格后台任务不能隐式 acquire 或复用该模式        |
| Confirmed           | [remote desktop session](../../crates/cognia-automation/src/cua_sandbox/desktop_session.rs) 已有控制租约、preemption 和 cleanup quarantine                                                                        | 可参考生命周期契约；不把本机 B 自动切到 VM                                                        |
| Historical evidence | ledger 中公开 PID 定向事件实验仅证明部分文本投递，未证明正确的窗口快捷键和后台拖拽                                                                                                                                | 重放同一方案不足以完成设计；完整 native route 必须通过新的 A/B 并发矩阵                           |

## 4. 两条输入流分别拥有 A 和 B 的目标

```text
User mouse / keyboard -> OS foreground + physical pointer -> A

Agent -> existing Host policy + session(B window) -> delivery admission
                                                    |
                     +------------------------------+-----------------+
                     |                              |                 |
              qualified semantic             DOM / app-debug    qualified native
                     |                              |                 |
                     +------------------------------+-----------------+
                                                    |
                                      B -> window capture -> effect check
```

图 1：后台任务没有通往全局 HID 或自动 Focus 的边；动作资格不足时停在 admission。

### 4.1 三条路线覆盖不同能力和测试保真度

| 路线               | 首选场景                                   | 必须满足的条件                                                                | 不代表已覆盖的测试                                                |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 控件语义           | 读取状态、按钮、设置值、选择已有选项       | B 的确切控件支持对应原生动作；组合已验证不抬窗；前后状态可读取                | `setValue` 不等于逐字输入，不能覆盖 IME、按键处理或用户拖拽       |
| DOM / 应用调试协议 | Web B、受控 Electron B、正在开发的 Tauri B | 复用已授权、确切实例/页面的连接；能力说明保证该动作不激活窗口                 | 合成 DOM 事件不等于真实硬件输入；文件选择器和原生菜单需要其他路径 |
| 原生窗口定向输入   | 无应用协议但支持后台事件的 B               | 精确窗口身份、独立 agent pointer/键状态、固定驱动版本、逐事件取消和兼容性资格 | 不能推导任意控件、全局快捷键、系统对话框或所有拖拽都可后台完成    |

路由顺序为：符合此次测试语义的应用协议或控件语义 → 已具备资格的窗口定向输入 → 不可用。需要验证硬件行为的测试不能为了后台成功而自动替换成 DOM/value 写入。

应用内 focused control 与系统 frontmost app 是不同状态。后台驱动可需要让 B 内部选中目标输入框，但不能通过全局 Focus 完成。B 的多窗口也不能仅用 PID 区分。

### 4.2 契约约束由 Host 持有，模型不能放宽

下列字段是提议，不是当前公开 API：

| 契约                                               | Host 校验与生命周期                                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deliveryMode: backgroundOnly / foregroundAllowed` | 绑定任务/session 的执行 grant；新后台 UI 明确创建 `backgroundOnly`。旧调用省略该字段也不能绕过已有 grant                                                                                                                                     |
| `target`                                           | Host 发现应用实例和窗口，签发 `windowTargetToken`，绑定 native window ID、保留的 native 身份和窗口/连接 generation；观察也按该确切窗口捕获，不能重新按标题/主窗口猜选。实例重新启动和窗口 ID 重用均失效                                      |
| `observation`                                      | 复用 lineage、revision、turnToken、native handle 和同一截图的坐标系；移动/缩放/重建重新观察                                                                                                                                                  |
| `fidelity`                                         | 由测试目的决定 semantic 或 native-input 需求；不同语义的动作不能静默替换                                                                                                                                                                     |
| `capability`                                       | Host 管理的 operation profile，包含 OS/driver/app build、window/toolkit、控件或页面语义标识、具体操作、参数约束、必要状态前提和 effect verifier。区分不抬窗、会短暂切焦点、需前台、未知；某个按钮通过不能给同一窗口的全部 AXPress/click 授权 |
| `monitorLease / fence`                             | 绑定 Host 观察到的系统前台窗口、B 的人类输入归属、监控健康和本次接管 generation；投递端也验证。必须覆盖不激活 B 的滚动/点击；不能只监控前台变化。监控失效立即撤销 admission                                                                  |
| `result.delivery`                                  | 继续区分未投递、已投递、部分/未知和拒绝；不把驱动成功返回当成业务成功                                                                                                                                                                        |
| `result.effect`                                    | confirmed / unverified / contradicted；来自 B 的独立读回或断言。只收到 AX 写回/事件回执不能证明效果                                                                                                                                          |
| `result.interruption`                              | none-observed / detected / monitoring-unavailable；监控不可用时严格模式不准发送，后者用于拒绝或 in-flight 监控丢失的结果。采样没看到焦点变化不构成数学保证                                                                                   |

首期不创建新的持久化任务队列、Dexie 表或第二套 Computer Use broker。扩展现有 session、worker、backend 与 canonical schema；新增平台驱动仅在现有 backend 无法拥有平台机制时引入窄模块。

窗口发现和选择需进入同一版本化能力协商：Host 提供应用内窗口清单和不透明 target token，`get_app_state` 及后续动作消费同一 token。native capture 以确切 window ID/保留身份选择窗口，不能只给既有标题/矩形打分选择器增加一个 UI 字段。目标不可唯一确认时拒绝。

### 4.3 后台动作在实际投递前校验 B，不借用 A 的状态

1. Host 复核现有权限、kill switch、任务 grant、确切应用实例/窗口和 hard-target policy。观察、启动、截图同样受不激活约束。
2. 要求有效 monitor lease，选择符合 fidelity、operation profile、参数和状态前提的路由；已知会激活的菜单、快捷键和其他动作在发送前拒绝。未知组合不自动探测性点击真实 B。
3. 复用 native window/element 身份及实时截图几何；后台指针使用 B 的窗口坐标和 B 内部定位，禁止用 A 上的全局命中结果替代。
4. 沿用现有 `prepare_action` 在投递前消耗 turnToken 的规则；读回失败、进程崩溃或拒绝都不能让同一 token 再次投递。实际投递仍通过现有 worker 序列化。复合动作逐事件检查 generation、cancel、policy 和目标，不新增并行全局输入线程。
5. 读回 B 的效果。Unknown/partial 不自动重试，不回退到前台；只允许重新观察来判断下一步。效果确认不会重新开放已经消耗的 token。

外部 helper/应用协议的接收端需在每个 primitive 实际提交时复核 generation；首期每个目标最多一个在途 primitive，不在 helper 预排队整个宏。撤权提升 fence，丢弃旧 generation 的未提交事件，只有接收端确认不再提交旧事件并返回 cleanup/drain 状态后，才能接纳新的 agent 控制。已经交给 OS/应用的输入无法撤回，必须作为已提交或 Unknown 单独报告；fence 不承诺撤销它引发的业务副作用。无法 fence/drain 的调用不开放严格模式的复合输入，不能只在外围包装一个取消按钮。

## 5. 人类接管和异常激活终止当前后台资格

| 事件                                                                   | 后台任务行为                                                                                             | 恢复                                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 用户继续操作 A 或另一个非目标窗口 C                                    | 继续操作 B；更新当前人类输入/焦点 observation                                                            | 不把任务开始时的 A 当成永久前台目标                                                                          |
| 用户操作 B，包括不激活窗口的滚动/点击；或 B 成为系统前台且来源无法确定 | 撤销 B 的 admission，提升目标输入 epoch/fence，停止尚未提交的后续事件，标记已提交/in-flight 结果可能未知 | 用户选择继续后重新观察、申请新 generation；不靠闲置计时偷偷恢复                                              |
| B 自行激活、抬窗或切 Space                                             | 停止后续输入，记录已经发生的干扰，撤销该动作资格                                                         | 不强行恢复到过时的 A。需要驱动恢复焦点时，必须有独立授权和当前人类 activity epoch 保护；该组合不属于严格模式 |
| 取消、kill switch、权限撤销、锁屏或 helper 崩溃                        | 撤销 admission 并提升接收端 fence，释放该任务持有的输入状态；清理/旧队列停止无法确认时 quarantine        | fence/drain 与 cleanup 均确认后才能恢复，重启使旧句柄/资格全部失效                                           |
| B 关闭/重启、窗口重建或 helper 重连                                    | 失效旧 token、frame、target 和 driver generation                                                         | 新发现和新观察；不按旧 PID 或窗口 ID 继续                                                                    |

清理不能对共享 HID 盲发“释放所有按键”，否则会打断用户在 A 中持有的修饰键或拖拽。候选原生驱动必须证明输入状态归属于 agent，并具备只清理其自身状态的能力；不具备时不开放该复合动作。

前台/窗口变化先复用 AX/原生生命周期通知；人类对 B 的输入另需可靠归属机制，覆盖不激活窗口的滚动、点击及其造成的布局变化。优先使用受控 B 的局部输入 observation；第三方 B 必要时使用经授权的原生输入元数据监控，只保留事件类型、目标窗口与 epoch，不读取或记录 A 的文本内容。不能区分 agent 与 human 输入、不能归属窗口、只有前台变化通知或缺少所需权限时，该路线不准进入严格模式；不能用“用户应先点暂停”替代自动撤权。

如监控实现需要 Input Monitoring，需单独声明、最小化申请并取得用户授权；缺少权限时显示明确不可用原因。投递端在提交前复核目标输入 epoch、监控健康和 fence。人类在最后一次校验后插入的操作仍可能与一个已提交 primitive 在途重叠，必须停止后续提交并报告 Unknown，而不是承诺已经撤回该输入。监控健康丢失后不继续执行严格后台输入。

候选 Cua 驱动若自行执行 foreground restore、隐藏启动恢复或菜单补偿，Host 不能靠外围的 `backgroundOnly` 字段把这些内部副作用消除。adapter 必须证明能够禁用/约束这些行为、遵守 fence 并导出监控健康；否则该原样版本不具备严格模式资格，需要受审查的上游扩展、自有窄实现或保持不可用。

## 6. 首期 UX 只需目标、运行状态和可理解的拒绝原因

开始时选择 B 的明确窗口，默认显示“后台运行，不切换当前应用”；观察和动作调用都继承该选择。状态展示“后台运行”“目标窗口已转到前台，任务已暂停”“此操作需要前台”或“效果未确认”。这些为文案草案，实现时接入 en/zh-CN 的 next-intl。

遇到不支持的步骤，保留已完成结果并暂停；用户可主动进入现有前台运行方式或结束任务。无需每次点击重新确认窗口，也不会静默迁移实例、换登录状态或启用 VM。

## 7. 实现扩展现有模块，保护旧客户端与权限边界

| Owner role / 模块                                                                        | 负责内容与接入点                                                                                                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Automation maintainer / `automation/session.rs`, `worker.rs`, `backend.rs`               | 执行 grant、目标/window 发现接缝、路由 admission、结果语义和取消；现有 command → worker 链路实际消费约束                                        |
| Native maintainer / AX、UIA 与候选 driver adapter                                        | 平台能力、后台观察/投递、窗口内定位、agent 输入状态清理及 qualification；原有 foreground 校验继续适用于其路径                                   |
| SDK maintainer / plugin-contract、`lib/automation`、computer-use plugin、workflow schema | canonical schema、capability negotiation、工具说明；旧客户端不能把 `backgroundOnly` 升级为前台权限                                              |
| App/browser integration maintainer / 现有 Companion 与受控调试连接                       | 绑定确切 browser tab/webview/app instance；只开放已声明的不激活操作。`agent-safe-v1` 新操作须新增 named capability 并由 Host 拒绝未声明的浏览器 |
| Desktop UI maintainer / 现有 automation inspector 与任务界面                             | 选择窗口、执行模式、暂停/恢复；无新 Next server/API route，沿用 Tauri 与 static-export 边界                                                     |
| Desktop QA / 现有 native smoke fixtures                                                  | A/B 并发输入、资格矩阵、跨屏/遮挡/重启和独立效果验证                                                                                            |

能力协商失败或旧 Host 不认识严格模式时，拒绝启动后台任务并说明升级要求。已有明确授权的前台任务保持原路径。禁用后台 feature flag 会中止后台 admission，不能改写成 foreground。

第三方原生 helper 是新的信任边界：固定 artifact hash/版本、签名身份和协议；继承现有 Host 身份与任务授权，禁止模型直接连接它。外部 helper 需经过已存在的受鉴权 transport 或单独设计受限通道，不能复用无鉴权 localhost 管理口。TCC 仅申请所需 Screen Recording/Accessibility；脚本路由需要额外 Automation 权限时单独声明。

任何新截图/文本送往模型仍走已有 PII gate；默认日志只记路由、结果枚举和计数，不记输入正文、窗口标题、URL、token 或凭据。诊断原始帧继续遵守现有用户授权与保留规则，不额外创建长期副本。

## 8. 验收证明 A 连续可操作，并单独验证 B 的效果

资格按应用/动作分开报告，拒绝率不算成功率。以下是拟定验收门槛，没有已经运行的声明：

| 验收            | Given / When / Then                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 文本并发     | A 持续输入带序号的文本，B 同时进行 100 轮 click/value/text 操作；A 无丢字、错序、串字，B 独立状态断言正确                                                                                                                                    |
| A2 修饰键与拖拽 | A 持有修饰键/执行拖拽时 B 执行其已具备资格的输入；A 的持键、释放和拖拽轨迹不被 agent 清理或全局移动改变                                                                                                                                      |
| A3 焦点全过程   | 用系统 focus/window notification 和 fixture key/resign、事件记录交叉验证，不能只比较动作前后；严格组合出现一次抬窗、切 Space 或 agent 造成的焦点转移即失败                                                                                   |
| A4 遮挡与多屏   | B 被 A 完全遮挡、在另一物理屏、移动或缩放；捕获和输入仍绑定 B，旧 frame 坐标拒绝，A 不收到 agent 事件                                                                                                                                        |
| A5 同进程多窗口 | B 有两个窗口与多个同名控件；只修改选中的窗口/控件，兄弟窗口不变；窗口 ID/PID 重用后旧 token 拒绝                                                                                                                                             |
| A6 用户接管     | 人类从 A 改用 C 时 B 继续；B 转到前台或收到人类非激活式滚动/点击后，目标 epoch/fence 变化，停止尚未提交事件并返回 drain 结果。注入“Host 预检后发生 B 滚动”的竞态，旧布局动作不得继续提交；区分已经提交的未知输入。不把焦点强行恢复为最初的 A |
| A7 不支持与未知 | 不支持的菜单/hover/IME/快捷键/画布操作明确拒绝；partial/Unknown 不自动换路或重放；原生 `typeText` 不被 `setValue` 冒充                                                                                                                       |
| A8 生命周期     | 取消、撤权、锁屏、monitor lease 失效、helper 崩溃与重启阻止后续提交；人为延迟 Host→helper RPC 和旧 generation 队列，证明 fence ack 后没有旧事件提交。只释放 agent 状态；drain/清理未确认保持 quarantine                                      |
| A9 全链路       | plugin/workflow/旧客户端字段缺省均不能绕过 Host 的 backgroundOnly；同一请求保持硬目标策略、turnToken、限流和审计                                                                                                                             |

先在可丢弃 Cocoa fixtures 测，随后对目标 AppKit、Electron、Tauri/Web B 分别验证。最小化、其他 Space 和系统弹窗不合并到“被遮挡”验收。Native-input fidelity 另做逐键、选区、IME 和真实业务断言；当前方案没有承诺所有组合均可后台支持。

复用 `scripts/smoke/desktop-automation-macos.mjs` 和 fixtures 扩展 background-only 场景；原脚本会主动 Focus，因此现有十项前台安全矩阵不能充当新验收。保留旧矩阵以检测前台路径回归。实现时使用当前 `pnpm test`、scoped Cargo tests、lint/typecheck 和相关 SDK/Host gate；coverage 仍仅在用户明确要求时本地运行。

运行时记录有界指标：route、action class、OS family、qualification tier、delivery/effect、pause reason、focus violation count、cleanup ack 与延迟。窗口/进程细节只进入受控诊断，不做 metric labels。任何检测到的错误目标/焦点侵犯立即禁用该资格；清理未确认禁用该会话。

首期保留现有单 worker，资格缓存随 OS/app/driver/generation 变化失效；不增加 VM、模型调用或常驻捕获服务。新增时延/内存没有当前测量值，需在相同 A/B workload 下与前台 baseline 对比后报告；不虚构性能提升或“零开销”。

## 9. 交付按安全契约、可用动作、原生资格分阶段推进

| 阶段 / Owner                               | 依赖与交付                                                                                      | 验证 / 退出条件                                                                                                                                   | 回滚                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| P0 / Automation maintainer + QA            | 确定 B 的具体技术与动作清单；建立 A 输入与焦点连续性 fixture，保留现有前台矩阵                  | 未改驱动前得到真实基线和可复现干扰；无需重做已被证伪的裸 PID 拖拽路线                                                                             | 仅测试/文档                           |
| P1 / Automation + SDK maintainers          | Host backgroundOnly grant、window target、拒绝/Unknown 契约；对已有语义或受控调试路线做资格验证 | 每条开放路线验证适用的 A1–A9，包括持键/拖拽并发和移动/遮挡；无法验证的状态在 admission 拒绝，不能让 native 路线的通过代替 semantic/debug 路线证据 | flag 关闭并撤销 grant，保留原前台入口 |
| P2 / Native maintainer + Security reviewer | 评估固定版本 Cua adapter 与自有窄驱动的成本；受管 helper、能力表、agent 输入状态和平台资格      | 必须通过 A1–A9；系统升级或应用升级造成资格失效。不能验证的动作继续关闭                                                                            | 停止 helper、撤销资格，不转前台       |
| P3 / Desktop UI maintainer + QA            | 独立状态、手工恢复、目标应用 canary 和有限 rollout                                              | 每个应用/动作分别发布通过项、拒绝项和监控盲区；任一 focus/target violation 即回滚该组合                                                           | feature flag 禁用，活动 session 失效  |

本轮不执行 helper 安装、TCC 修改或 private SPI，也不改 accepted screen-off ADR。新的内部字段暂不持久化；未来需要保存用户模式偏好时，单独设计现有 settings 的向前兼容读取和导入/备份行为。没有跨版本后台自动恢复或参数降级。

## 10. 评审决策与未完成证据保持显式

| ID  | 选择与建议                                                                                      | 影响                                                                                     |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Q1  | 建议默认 backgroundOnly，不能完成就暂停；foregroundAllowed 为用户主动选择                       | 对应用户 A/B 并行目标，接受部分动作先不可用                                              |
| Q2  | 建议先复用公开语义/受控调试协议；对固定版本 Cua native adapter 做独立资格实验后再决定复用或自研 | private SPI、发布渠道、签名、许可证及维护成本均需 Native/Security 评审；没有预先授权安装 |
| Q3  | 建议首期限定同 Space、非最小化但可被遮挡的 B，并按具体应用/动作发布                             | 防止把更广的隐藏/最小化/跨 Space 能力混作首期承诺                                        |
| Q4  | 建议优先受控 B 的局部人类输入监控；通用第三方 B 需要额外 Input Monitoring 时单独授权            | 没有可靠监控或权限的路线保持不可用；不通过扩大采集 A 的内容来凑出“自动接管”能力          |

排期不在本轮假设人员承诺。后续工作均为上述单一 owner role 持有的阶段交付；技术验证完成是下一阶段前置，不设未经团队确认的日历 DDL。

| 评审日期   | 评审内容                                                   | 结果                                                                                                                                 |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-03 | 当前源代码、accepted ADR、一手行业资料与用户 A/B 澄清      | 已完成调研；本机后台投递实现与资格仍待实施                                                                                           |
| 2026-11-03 | 独立对抗审查：Host strict-mode、窗口定向路由和人类输入冲突 | 3 个限定周期完成；4 项初审与 1 项复审缺口均修正，末轮无新实质缺陷。用户先前已跳过额外跨模型复核；未调用外部 CLI。不构成实现/真机证据 |

本轮验证仅限设计与来源一致性、Markdown/ledger 检查。历史 P1 的专项测试结果不作为本设计的后台输入通过证据；完整前台双屏验收及其环境阻塞继续保留在原 ledger。
