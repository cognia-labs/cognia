# 滑词工具栏的桌面区域选取方案

2026-11-17 起草 · 2026-11-18 按方案拷问的结论重写 · Heavy · macOS 与 Windows 的 Tauri 桌面、冻结整屏遮罩、聊天草稿与控件引用

**进入时冻结当前显示器，用户在静态画面上框选。** 悬停时优先吸附控件，其次吸附窗口；直接拖动就是自由框。确认在遮罩上就地完成：截图经现有附件入口进入聊天草稿；吸附到窗口或控件时，也可以作为控件引用加入，供同一对话里的智能体操作。

**首版只做 macOS 和 Windows，现有包结构不动。** 框选逻辑放进 `cognia-automation` 的新模块，窗口外壳放在 `src-tauri/src/capture/` 下，遮罩复用现有浮窗的 Tauri webview 加 NSPanel 做法。Linux 入口按能力隐藏。Web、Capacitor、远程 Host 和 Headless 不提供入口。

**以后滑词工具栏会拆成独立轻量应用。** 本方案先在 Cognia 里交付框选，结果结构不带 Tauri 类型，可以序列化，拆分时只需重写窗口外壳。拆分细节另见 [独立滑词工具栏的待拷问清单](./2026-11-18-standalone-selection-toolbar-open-questions.md)。

依据为 [前期调研与补充事实](../research/2026-11-17-desktop-region-picker-feasibility.md)、[ADR-0093 滑词窗口](../content/docs/en/adr/0093-selection-toolbar-content-hugging-window.md) 和 [ADR-0095 选区感知](../content/docs/en/adr/0095-desktop-selection-perception.md)。

## 1. 目标与交互

| 目标                | 可观察结果                                                                                                                             | 验收   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G1 从现有入口启动   | 滑词工具栏出现「框选区域」，聊天附件菜单也能进入，另有默认不绑定的可配置快捷键。没有文字选区时也能框选。                               | A1     |
| G2 冻结、吸附与拖框 | 进入后画面立即定格，高亮随指针在控件和窗口之间切换，拖动改为自由矩形。`Esc`、取消按钮、紧急停止或切换桌面都会结束会话。                | A2–A4  |
| G3 就地确认进草稿   | 选区旁出现工具条，可以拖手柄调整。截图与冻结画面逐像素一致，不含任何遮罩。点「添加图片」后，目标草稿多出一张图。                       | A5、A6 |
| G4 控件引用可用     | 吸附到窗口或控件时可以「作为控件引用添加」。智能体取界面状态时能找到该控件并标为「用户指定」；找不到唯一匹配时报告失效，提示用户重选。 | A8     |
| G5 能力随环境变化   | 缺屏幕录制权限时说明原因并引导到系统设置。缺辅助功能权限时只提供窗口吸附和自由框。不支持的平台不显示入口。                             | A7、A9 |

### 交互流程

1. **进入。** 工具栏按钮、聊天附件菜单和快捷键分发同一个动作 `chat.captureDesktopRegion`。快捷键默认不绑定，避开智能快照的 `Alt+Shift+S`。动作 id 不能以 `selection.` 或 `tray.` 开头，否则会被渲染端的快捷键分发丢弃。从工具栏进入时，先收起工具栏再冻结。 [快捷键默认表](../../src-tauri/src/shortcuts/registry.rs#L589) · [前缀过滤](../../lib/tray/dispatcher.ts#L130) · [空默认值先例](../../lib/shortcuts/app-catalog.ts#L214)
2. **冻结。** Host 截取指针所在的显示器，同时记下这一刻的窗口列表（z 序、边界、进程、窗口 ID），然后在该显示器上显示遮罩和静态画面。指针在按下前移到另一块屏时，按需冻结那块屏并把遮罩移过去。每个选区只属于一块屏。
3. **选取。** 悬停时，先在冻结时的窗口列表里算出指针下的窗口，再在该窗口内向实时界面查询控件；控件边界无效或查询超时时，退回窗口边界。按下后超过拖动阈值就进入自由框。抬起后进入调整状态，可以拖手柄改边界。选取期间暂停滑词的文字候选弹窗，退出后恢复。
4. **确认。** 工具条提供「添加图片」「作为控件引用添加」（仅在吸附到窗口或控件时出现）「重选」「取消」。截图从同一张冻结画面上裁出。控件引用在确认时对实时界面重新解析一次，边界与冻结时偏差过大就提示「目标已变化」，留在调整状态。
5. **交付。** 结果交给主窗口，经 `acceptFiles` 加进目标输入框。目标的查找顺序与智能快照相同：先找聚焦的输入框，其次是上次用过的，再次是活动会话的；都没有就新建对话。加入成功后唤起主窗口。超出附件数或大小限额时，显示原因并提供「重新框选」。 [智能快照的目标选择](../../lib/chat/smart-snapshot-command.ts#L41) · [附件入口](../../components/chat/composer/hooks/use-attachment-intake.ts#L164) · [限额](../../lib/chat/attachments/prepare.ts#L19)
6. **智能体使用控件引用。** 引用随消息保存。智能体照常取界面状态，引用的控件在结果里标为「用户指定」，之后用普通句柄和回合令牌操作。现有的授权、禁区、紧急停止和目标校验全部照旧。

## 2. 现有实现与本方案的关系

| 现状                                                                                                                                                                                                           | 对本方案的影响                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 智能快照（`chat.captureSmartSnapshot`）截取聚焦窗口，连同无障碍文本作为两个附件加入输入框。它没有区域选择，只在有输入框挂载时生效。它直接调用 `attachments.add`，绕过了 `acceptFiles` 的数量和大小校验。       | 框选与智能快照并存，复用同一套目标输入框查找。P1 把智能快照也改走 `acceptFiles`。 [文件构造](../../lib/chat/smart-snapshot.ts#L125) · [绕过点](../../components/chat/composer/hooks/use-attachment-intake.ts#L269)                                                                                                                                       |
| `composer-append` 事件只表示「收到」，不表示加入成功。真正的结果来自 `acceptFiles` 返回的已加入文件。                                                                                                          | 交付以 `acceptFiles` 的返回值为准。 [事件桥](../../components/chat/composer/composer-append-bridge.tsx)                                                                                                                                                                                                                                                  |
| 现有浮窗（滑词工具栏、桌面宠物、灵动岛、录制控制条）都是 Tauri webview 窗口，macOS 上用 `tauri-nspanel` 转成 NSPanel。灵动岛已经覆盖整块显示器。仓里没有原生绘制的覆盖窗口。                                   | 遮罩用同一做法，以 React 绘制高亮、手柄和工具条，文案走 `next-intl`。 [滑词窗口](../../src-tauri/src/selection_toolbar.rs#L2489) · [NSPanel 转换](../../src-tauri/src/pet_window/macos_panel.rs#L532) · [窗口角色](../../lib/platform/window-role.ts#L118)                                                                                               |
| macOS 15 起，ScreenCaptureKit 不再理会 `sharingType = .none`。仓内录制控制条的截图排除只对旧的 CG 截图接口有效。ScreenCaptureKit 截显示器时排除列表为空。                                                      | 冻结在遮罩出现之前截图，不依赖任何截图排除机制。 [排除说明](../../src-tauri/src/recorder_window/capture_exclusion.rs#L9) · [空排除列表](../../crates/cognia-automation/native/macos/screen_capture.m#L723)                                                                                                                                               |
| `capture_global_region` 把全局桌面坐标换算成显示器内的物理像素。坐标约定是 macOS 用逻辑点，Windows 用物理像素。                                                                                                | 冻结和裁切复用这套坐标转换，按显示器 ID 绑定同一输出。 [区域截图](../../crates/cognia-automation/src/automation/platform/shared/screenshot.rs#L117) · [坐标约定](../../crates/cognia-automation/src/automation/platform/shared/desktop_space.rs#L1)                                                                                                      |
| automation 的 `ElementHandle` 只在一次会话的当前版本内有效，worker 重启就失效。动作要带 30 秒内、只能用一次的回合令牌，再做指纹和前台、遮挡校验。macOS AX 已有按祖先路径重放到实时界面的定位器，Windows 没有。 | 控件引用存平台定位器和指纹，不存句柄。智能体取界面状态时解析引用，动作仍走现有句柄路径。Windows 要补 UIA 定位器。 [句柄](../../crates/cognia-automation/src/automation/session.rs#L153) · [动作校验](../../crates/cognia-automation/src/automation/session.rs#L721) · [AX 定位器](../../crates/cognia-automation/src/automation/platform/ax/mod.rs#L237) |
| `desktop_pick_at_point` 是带审计和频控的单点接口，macOS 命中失败时退回聚焦窗口。`desktop_pick_session_start` 只记一条审计。                                                                                    | 悬停不走公共点查询，改用框选模块的内部查询：限定在目标窗口内，能报告未命中。 [点查询](../../crates/cognia-automation/src/automation/commands.rs#L2046) · [选取会话](../../crates/cognia-automation/src/automation/commands.rs#L2200)                                                                                                                     |
| 聊天引用类型 `ContextRefKind` 没有桌面控件这一类。模块可以通过 context contribution 注入上下文，并用 `sessionState` 把数据交给自己的工具。                                                                     | 新增 `desktopElement` 引用类型，由 automation 模块注入上下文和工具。 [引用类型](../../packages/plugin-contract/src/lib/chat/mentions/types.ts#L30) · [上下文注入](../../lib/ai/agent/execution/contributions/context-contributions.ts) · [automation 模块](../../lib/automation/module.ts)                                                               |
| `src-tauri/src` 新增顶层模块会被 `audit:rust-architecture` 直接拦下。`capture` 已在白名单内。`cognia-automation` 不打开 `tauri-host` 时不依赖 Tauri。                                                          | 逻辑放进 `cognia-automation`，窗口外壳放在 `src-tauri/src/capture/` 下，不新建 crate。 [层级配置](../../scripts/gates/rust-architecture.json) · [feature 定义](../../crates/cognia-automation/Cargo.toml)                                                                                                                                                |

## 3. 结构与所有权

```text
滑词工具栏 / 聊天附件菜单 / 快捷键
                │ start
                ▼
src-tauri/src/capture/region_picker.rs   遮罩窗口、NSPanel、capability、帧协议、通知 main
                │
                ▼
cognia-automation  automation/region_pick/   会话状态、冻结、窗口列表命中、控件查询、裁切、定位器
                │ 结果（可序列化，不含 Tauri 类型）
                ▼
主窗口：acceptFiles 加入图片；控件引用作为 desktopElement 引用进入草稿
                │ 发送后
                ▼
automation 模块：上下文注入，取界面状态时标出「用户指定」控件
```

| 位置                                                   | 内容                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/cognia-automation/src/automation/region_pick/` | 纯逻辑包括会话状态机、手势解释、冻结窗口列表上的命中、像素矩形取整与裁切、结果结构，都能单测。平台部分包括 macOS 和 Windows 的冻结截图、窗口列表、窗口内控件查询，以及 Windows UIA 定位器。命令放在 `tauri-host` feature 后面。 |
| `src-tauri/src/capture/region_picker.rs`               | 预热常驻的遮罩窗口、macOS NSPanel 转换、帧协议、焦点恢复、快捷键路由，以及只给遮罩窗口用的 capability 文件。不新增顶层模块。                                                                                                    |
| `app/selection-toolbar/region-picker/`                 | 遮罩路由和 UI 组件，归 `selection-toolbar` 模块，以后随工具栏一起拆出。窗口角色登记为只负责展示的次级浮窗，不启动 store 和账户。                                                                                                |
| `lib/automation/`                                      | `desktopElement` 引用的解析、上下文注入、在取界面状态的结果里标注「用户指定」，均在 automation 模块的 manifest 内声明。                                                                                                         |
| `packages/plugin-contract/`、`lib/chat/`               | `ContextRefKind` 新增 `desktopElement`，加上输入框里的引用标签、消息持久化和只读展示。智能快照改走 `acceptFiles`。                                                                                                              |

### IPC 约定

均为桌面壳的私有命令，不加入 CLI、MCP、插件 SDK 和 Companion 公共协议。Companion 命令清单按现有 desktop-only 先例标为仅本机。

| 命令或协议                  | 调用方                                   | 输入与输出                                                                                                                           |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `region_picker_start`       | `main`、`selection-toolbar`、Host 快捷键 | 不带坐标。返回 `sessionId`，或 `busy`、`unsupported`、`permissionRequired`。                                                         |
| `region_picker_cancel`      | 启动方、`main`、遮罩                     | 传 `sessionId`。已结束的同一 ID 返回成功，不报错。                                                                                   |
| `region_picker_hit_test`    | 仅遮罩                                   | 传 `sessionId`、样本序号和显示器内坐标。返回 `element`、`window` 或 `none`、矩形和可选标签。最多一个查询在途，外加一个最新待处理点。 |
| `region_picker_confirm`     | 仅遮罩                                   | 传 `sessionId`、动作（`image` 或 `elementRef`）和最终矩形。成功后通知 `main`，`elementRef` 可能返回 `targetChanged`。                |
| `region_picker_take_result` | 仅 `main`                                | 传 `resultId`，一次性取走。返回图像 MIME、字节、像素宽高、`displayId`、显示器内矩形和可选的控件引用。                                |
| `cognia-region://` 帧协议   | 仅遮罩                                   | 传送本次会话的冻结画面，按 webview label 和 `sessionId` 校验，会话结束即失效。                                                       |

Rust handler 以真实 webview label 和当前账户代次确认调用方。通知只发给 `main`，只带不透明 ID，不带图像。主窗口挂载时会主动补读一次，防止错过通知。错误使用固定 `code`：`busy`、`unsupported`、`permissionRequired`（区分屏幕录制和辅助功能）、`captureFailed`、`targetChanged`、`tooLarge`、`stale`。`cancelled` 是正常结束。

### 生命周期

| 状态               | 进入与退出                                                                           | 失败处理                                                                               |
| ------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `Freezing`         | 原子占用唯一的会话槽位。检查权限，截取显示器，记录窗口列表，然后显示遮罩。           | 再次启动返回 `busy`。截图失败时释放槽位，报 `captureFailed`。                          |
| `Selecting`        | 处理悬停、按下、拖动、调整。指针跨屏且尚未按下时，冻结新的屏。                       | 焦点被抢、显示器或桌面切换、账户变化、紧急停止，都进入 `Closing`。                     |
| `Confirming`       | 截图直接裁切冻结画面。控件引用重新解析实时界面并生成定位器。                         | 控件引用偏差过大时返回 `targetChanged`，回到 `Selecting`。                             |
| `Delivering`       | 结果交给 `main`，等主窗口取走。                                                      | 5 分钟没人取或会话被替换就回收。                                                       |
| `Closing` → `Idle` | 先作废本次会话代次，再收遮罩、释放冻结画面和后台任务，恢复文字候选和原来的前台应用。 | 取消发生在按下与抬起之间时，吃掉对应的抬起事件，不传给其他应用。迟到的结果按代次丢弃。 |

- **预算。** 从按下入口到看见冻结画面不超过 300 ms。悬停查询每秒最多 30 次，控件查询设消息超时。一块 5K 屏的冻结画面约 60 MB，只在会话期间保留。最终图像沿用附件的 10 MiB 上限，超出时先重新编码，仍超出则报 `tooLarge`。以上数字在 P0 实测后定稿。
- **坐标。** 选区先换算成所在显示器内的像素矩形，左上角向下取整，右下角向上取整，再裁到显示器边界。预览、裁切和返回的矩形用同一份结果。macOS 按逻辑点乘以缩放比，Windows 直接用物理像素。

## 4. 平台实现

| 平台        | 冻结与窗口列表                                                                                                                                                                      | 控件查询与遮罩                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | 用现有 ScreenCaptureKit 显示器截图冻结，此时遮罩还没出现。窗口列表用 `CGWindowListCopyWindowInfo` 取屏上窗口的 z 序、边界和 PID，过滤桌面层和 Cognia 自己的浮窗。需要屏幕录制权限。 | 用 `AXUIElementCreateApplication(pid)` 把命中限定在目标进程，再调用 `AXUIElementCopyElementAtPosition`，设消息超时，并检查控件属于同一个窗口。这样系统级命中就不会落到遮罩上。确认时用现有 AX 祖先路径生成定位器。遮罩是非激活 NSPanel，处理 `Esc` 时临时成为 key 窗口，层级盖过菜单栏，也能出现在全屏应用之上。缺辅助功能权限时只保留窗口吸附和自由框。 [AX 命中语义](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)                                                                                                                                                     |
| **Windows** | 用 `xcap` 截取显示器，单位是物理像素。窗口列表用 `EnumWindows` 加 DWM 可视边界，过滤最小化、cloaked 窗口和 Cognia 自己的浮窗。                                                      | 桌面级 `ElementFromPoint` 会命中遮罩，所以改为从目标 `HWND` 调 `ElementFromHandle`，按边界包含关系有预算地向下查找。新增 UIA 定位器：记录进程映像名、窗口类，以及从窗口根开始每一层的 `ControlType`、`AutomationId`、`Name` 和同类序号，用逐层 `FindFirst` 重放。遮罩是置顶工具窗口，由用户的点击或快捷键带入前台，按 Per-Monitor V2 DPI 绘制，退出时恢复原前台窗口。 [仓内 DWM 枚举](../../src-tauri/src/pet_window/surfaces.rs#L171) · [UIA 根查询](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-obtainingelements) · [UIA 缩放](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling) |
| **Linux**   | 首版不支持。`region_picker_start` 返回 `unsupported`，入口隐藏。                                                                                                                    | 这项能力在类型说明、界面和测试三处都标明暂不启用。X11 窗口栈和 Wayland 截图门户的调研保留在调研笔记里。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

冻结画面里会照常出现 Cognia 自己的桌面宠物和灵动岛（滑词工具栏会先收起）。这与用户当时看到的一致，记为首版行为，见第 8 节。

## 5. 控件引用

- **保存的内容。** 一条 `desktopElement` 引用包含以下字段，并附带同一次框选的截图：
  - 平台
  - 应用（bundle id 或进程映像名）
  - 窗口标题和类名
  - 角色、名称、值（截断）
  - 确认时的边界
  - 平台定位器（不透明字符串）
  - 指纹
  - 框选时间

  模型看到的是角色、名称、值、应用、窗口和边界组成的简短说明。名称和值属于本机文本，随消息发出时经过现有的 PII 闸门。

- **怎么解析。** 发送时，automation 模块的上下文注入把本对话里的引用放进 `sessionState`。智能体对目标应用取界面状态时，先用定位器重放，再用指纹比对。只有唯一匹配时，才把对应节点标为「用户指定」；没有匹配或多个匹配都报告 `stale`，并请用户重新框选。
- **不带授权。** 引用、截图和坐标都不构成执行授权。动作仍需新取的句柄和回合令牌，并经过 automation 的授权、禁区、紧急停止和前台、遮挡校验。不新增执行通道。
- **在其他端。** 配对的手机、Web 端和远程查看者只读显示引用标签，不提供对应工具。这一点在类型说明、界面和测试三处都要标明。

## 6. 权限、安全与可观测性

- **截图不额外拦截。** 用户主动框选只要求屏幕录制权限，不按滑词禁用名单或自动化禁区拒绝。DRM 内容由系统负责，截出来本来就是黑的。
- **停止与撤销。** 自动化紧急停止、账户切换和 Host 退出都会撤销进行中的会话和尚未取走的结果，不依赖渲染端收到事件后再清理。 [紧急停止](../../crates/cognia-automation/src/automation/kill_switch.rs#L65)
- **调用边界。** 遮罩有自己的 capability 文件，只开放遮罩用的命令。`take_result` 只限 `main`，帧协议只服务遮罩。事件和日志里不出现图像、窗口标题和控件文本。 [现有窄权限示例](../../src-tauri/capabilities/selection-toolbar.json)
- **无模型调用。** 框选和加入草稿本身不调用模型。发送后图像和引用说明沿用现有的附件出站和多模态隐私边界。
- **诊断。** 每次会话记一次开始和一次结束，只带平台、入口、结果类别和错误码。P0 期间本地记录冻结耗时、悬停命中耗时、确认到加入草稿的耗时，以及峰值内存。
- **回滚。** 每个平台的入口按能力开关控制，原生验收通过才打开。一旦出现误触、遮罩进图或跨账户读取，就关掉对应平台。已经进入草稿的图片照常作为普通附件读取。

## 7. 验收

| 验收          | 操作与判定                                                                                                                                                          | 验证层                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| A1 入口       | 有文字选区和没有选区时分别启动。快捷键冲突时保留菜单入口。Linux、Web、移动端不显示入口。                                                                            | Jest、桌面 smoke                    |
| A2 冻结       | 从按下到看见冻结画面不超过 300 ms（按 P0 实测定稿）。跨屏移动时按需冻结。Retina 和负坐标副屏上，冻结画面与屏幕对齐。                                                | 原生 fixture，macOS 和 Windows      |
| A3 输入隔离   | 指针悬在一个会计数的按钮上，依次测点击、拖动、跨屏抬起、按住鼠标时取消。底层按钮的计数和收到的按下、抬起都为 **0**。                                                | 原生 fixture，macOS 和 Windows      |
| A4 退出与并发 | `Esc`、连续启动两次、外部抢焦点、账户切换、紧急停止、显示器热插拔。旧会话不再交付，遮罩收起，原前台应用恢复，之后能重新进入。                                       | Rust 生命周期测试、原生 smoke       |
| A5 图像       | 已知色块与冻结画面逐像素一致，图中没有遮罩颜色。覆盖 Retina、负坐标副屏，以及 Windows 100% 和 150% 缩放的组合。                                                     | Rust 裁切属性测试、原生 fixture     |
| A6 草稿       | 有聚焦、上次用过、仅有活动会话、没有输入框四种情况。附件已满 6 个和超出大小时显示原因。只在目标会话里加入一张图。                                                   | Jest、Tauri E2E                     |
| A7 权限       | macOS 分别测缺屏幕录制权限（不能进入，引导到设置）和缺辅助功能权限（只有窗口吸附和自由框）。                                                                        | 原生 smoke                          |
| A8 控件引用   | 原生控件和 Electron 应用各测一遍。确认后重启 Cognia 仍能唯一解析。目标被移动、销毁或重建，以及同一 PID 的两个相似窗口，都报告 `stale`。智能体的动作走现有授权流程。 | Rust 定位器测试、原生 fixture、Jest |
| A9 保护面     | 错误的窗口 label、过期 ID、跨账户取结果、帧协议越权读取，都返回无结果。日志里没有图像和文本。                                                                       | ACL 测试、Rust 测试                 |

命令：

- Rust：`cargo test -p cognia-automation --lib` 和 `cargo test -p cognia-next --lib`。
- Jest：`pnpm test --runInBand --runTestsByPath <本次测试文件>`。
- UI 改动：`pnpm i18n:build`、`pnpm lint:i18n`、`pnpm lint`、`pnpm typecheck`、`pnpm lint:static-export`。
- 结构闸门：`pnpm audit:rust-architecture`、`pnpm audit:modules`、`pnpm audit:colocated-tests`。

跨应用键鼠和像素证据在 macOS 和 Windows 实机上跑原生 fixture。用户可见的改动附带 changeset。

## 8. 阶段与残余

| 阶段                  | 交付                                                                                                                                                               | 放行条件                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **P0 原生证据**       | 在 macOS 和 Windows 上用双窗口 fixture 验证：冻结延迟、webview 遮罩的输入隔离、`Esc` 与焦点恢复、混合 DPI，以及遮罩下的进程内 AX 命中和从窗口句柄出发的 UIA 查询。 | A2、A3、A5 有实测结果。延迟不达标时，再评估改用原生绘制遮罩。 |
| **P1 截图框选**       | 冻结、窗口吸附、自由框、就地确认、图片进草稿、诊断、ACL、国际化。智能快照改走 `acceptFiles`。                                                                      | A1–A7、A9 中与截图相关的部分通过。按平台关闭入口即可回退。    |
| **P2 控件吸附与引用** | 窗口内控件查询、`desktopElement` 引用、Windows UIA 定位器、取界面状态时标出「用户指定」。                                                                          | A8 通过。任一平台可以单独关掉控件吸附，保留截图框选。         |
| **之后**              | 拆出独立滑词工具栏（另开一轮拷问），再看 Linux。                                                                                                                   | 见清单。                                                      |

残余与已知行为：

- 冻结画面里会出现 Cognia 的桌面宠物和灵动岛。如果用户希望去掉，macOS 可以在冻结时给 ScreenCaptureKit 显式传入这些窗口的 ID，Windows 则需要先隐藏它们。
- 录制控制条的截图排除依赖 `sharingType`，在 macOS 上只对旧的 CG 截图接口有效。如果录制器或 `xcap` 改用 ScreenCaptureKit，这层排除会失效。这不在本方案范围内。
- macOS 的进程内 AX 命中在遮罩下能否稳定拿到细粒度控件，目前只有锁屏环境下的窗口查询证据，由 P0 确认。

## 9. 已定决策（2026-11-18）

| 编号 | 决策                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 用途：截图给 AI，同时把控件引用作为自动化目标。                                                                                              |
| D2   | 首版平台为 macOS 和 Windows。Linux 入口隐藏。                                                                                                |
| D3   | 进入时冻结整屏，不使用实时透明遮罩。                                                                                                         |
| D4   | 遮罩用 Tauri webview 窗口，macOS 上转成 NSPanel，预热常驻。延迟不达标再评估原生绘制。                                                        |
| D5   | 在遮罩上就地确认，结果经 `acceptFiles` 进入当前输入框，不另做主窗口预览和暂存令牌。                                                          |
| D6   | 与智能快照并存，两者都走 `acceptFiles`。                                                                                                     |
| D7   | 吸附到窗口或控件时，提供截图加控件元数据，不附无障碍子树文本。                                                                               |
| D8   | 控件引用存定位器和指纹，用时重新解析，唯一匹配才可用，否则报告失效。                                                                         |
| D9   | 智能体在取界面状态时看到「用户指定」标注，不新增执行通道。                                                                                   |
| D10  | 截图只要求屏幕录制权限。控件引用不带执行授权，执行走 automation 策略。紧急停止会取消进行中的框选。                                           |
| D11  | 不新建 crate：逻辑放进 `cognia-automation` 的新模块，窗口外壳放在 `src-tauri/src/capture/` 下。                                              |
| D12  | 先在 Cognia 里做框选，再拆独立滑词工具栏。                                                                                                   |
| D13  | 独立工具栏的方向：只保留一份实现，随 Cognia 打包并以子进程启动，也可单独安装；独立运行时用最小模型配置加结果卡片；独立运行时不能用控件引用。 |
