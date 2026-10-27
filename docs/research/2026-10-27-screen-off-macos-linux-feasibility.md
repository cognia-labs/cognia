# Screen-off mode：macOS / Linux 可行性报告

研究日期：**2026-10-27**。本次仅阅读源码和公开资料，**未修改文件，未执行熄屏、输入注入、驱动安装或实机测试**。以下区分源码事实、平台资料支持的判断，以及仍需硬件验证的部分。

## 1. 结论

| 平台 / 范围                                       | 建议                               | 最小可行方向                                                                                                         |
| ------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| macOS，允许 private API、Developer ID 分发        | **Go-with-caveats：先做受限 beta** | 单个 `CGVirtualDisplay` + 指定 display 的 ScreenCaptureKit capture + 现有 CGEvent 输入 + system-only power assertion |
| macOS，要求全 public API、无需外设、Mac App Store | **No-go，尚无已验证的等价方案**    | 可提供用户自备 dummy plug 的受限路径；不能承诺自动创建虚拟显示器                                                     |
| Linux，限定 X11 和已验证硬件                      | **Go-with-caveats：最小 MVP**      | 保留 renderable output，必要时用户自备 dummy plug；继续使用 X11 capture + XTest                                      |
| Linux，原生 Wayland                               | **Go-with-caveats：独立实施阶段**  | `ScreenCast` / `RemoteDesktop` portal + compositor virtual output + PipeWire + libei，按运行时能力开放               |
| Linux，所有 DE / compositor 通用、零配置          | **No-go，不能作为统一承诺**        | 必须有 compositor/backend 支持矩阵                                                                                   |

最关键的验收条件有两个：

1. 熄屏后仍能取得**正确目标的最新画面**，输入确实作用于该目标。
2. 输入执行期间，**物理面板持续关闭**。

创建虚拟显示器可以解决第一项的基础设施问题，但不自动证明第二项。XTest 会触发 screensaver 退出逻辑；CGEvent 和 libei 也没有通用的“不唤醒面板”保证。[X server 实现](https://raw.githubusercontent.com/mirror/xserver/master/Xext/xtest.c)、[CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent/post%28tap%3A%29?language=objc)、[libei 说明](https://libinput.pages.freedesktop.org/libei/)

## 2. 当前仓库实际情况

| 部分                | 已确认的实现及影响                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Driver / controller | [`virtual_display/mod.rs`](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/automation/virtual_display/mod.rs:146) 的 `VddDriver` 已提供 `acquire → ping → release` 接口。非 Windows 使用 `NoopDriver`，health 的 backend 仍固定为 `windows-parsec-vdd`。                                                                                                                                  |
| 生命周期            | [`controller.rs`](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/automation/virtual_display/controller.rs:30) 使用专用线程、100 ms ping、5 分钟 idle release；`arm()` 最多等待 10 秒。                                                                                                                                                                                                   |
| Windows topology    | [`driver_windows.rs`](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/automation/virtual_display/driver_windows.rs) 实际保存的是 `prev_primary`；[`topology.rs`](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/automation/virtual_display/topology.rs) 通过平移布局切换 primary。它不是包含 mode、scale、rotation、mirror、enabled outputs 的完整 topology snapshot。 |
| Setup               | [`cognia-vdd-setup.rs`](/Users/bytedance/Project/cognia-next/crates/cognia-elevated-setup/src/bin/cognia-vdd-setup.rs) 是 Windows `pnputil` 安装器，以 marker 表示安装成功，不能直接移植成 macOS/Linux setup。                                                                                                                                                                                              |
| macOS capture       | [`ax/mod.rs`](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/automation/platform/ax/mod.rs:361) 已调用 ScreenCaptureKit：display screenshot 经 [`screen_capture.m`](/Users/bytedance/Project/cognia-next/crates/cognia-automation/native/macos/screen_capture.m:589) 的 `SCScreenshotManager`；app-session capture 使用 `SCStream`。默认 display 是 `CGMainDisplayID()`。                |
| macOS input         | 经 `enigo` 使用 CGEvent；Accessibility 权限独立于 Screen Recording。                                                                                                                                                                                                                                                                                                                                        |
| Linux capture       | [`atspi/mod.rs`](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/automation/platform/atspi/mod.rs:96) 调用 `xcap`。本地 resolved `xcap 0.9.8`：X11 screenshot 使用 **xcb `GetImage`，不是 XShm**；Wayland fallback 为 GNOME `ScreenshotArea` → Screenshot portal → wlroots/wayshot。没有 Cognia 自己管理的持续 ScreenCast/PipeWire session。                                              |
| Linux input         | 当前 `enigo 0.6.1` 默认 feature 是 `x11rb`；本仓未开启其 Wayland/libei features，也没有此路径上的 uinput 实现。安装 `xdotool` 不等于可以控制原生 Wayland 应用。                                                                                                                                                                                                                                             |
| UI / probe          | [`screen-off-card.tsx`](/Users/bytedance/Project/cognia-next/components/settings/automation/screen-off-card.tsx) 在非 Windows 隐藏操作。现有 probe 只以截图编码大小 **>8 KiB** 推断 `nonBlack`，不能证明新鲜度、正确屏幕或输入成功。                                                                                                                                                                        |
| Power               | 已有 [`cognia-power`](/Users/bytedance/Project/cognia-next/crates/cognia-power/src/lib.rs)。macOS 区分 system/display assertion；Linux 两个 level 都使用 `systemd-inhibit --what=sleep:idle`。`acquire()` 不返回失败结果，不能直接作为严格模式的 readiness 证据。                                                                                                                                           |

相关 ADR 命中 `0020`、`0106`、`0196`：主要约束是统一 kill switch、释放 virtual display，以及 setup binary 的 crate 归属。未找到已经决定 macOS/Linux screen-off 架构的 ADR。

另有两个移植前必须处理的契约问题：

- portal 授权可能超过 10 秒，不能直接放进当前同步 `acquire()` 后等待用户操作，否则可能出现调用已超时、资源稍后才创建的情况。
- 当前 settings probe 遇到 `AlreadyActive` 后仍会 release **process-global** display；新增后端应使用 lease/ownership，避免测试按钮拆掉正在执行的自动化会话。[命令实现](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/automation/commands.rs:1561)

## 3. macOS

### 3.1 熄屏后哪些部分可能失效

| 状态                                      | Capture                                                                                                     | Synthetic input                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 外接显示器按键关闭，macOS 仍保留该 output | 可能继续；取决于显示器是否保留 EDID/HPD，以及 WindowServer 是否继续渲染。不能与 OS display sleep 混为一谈。 | unlocked session 下 CGEvent 路径仍可使用；是否唤醒其他物理屏需实测。 |
| OS display sleep，系统仍运行              | **现有 `SCScreenshotManager` 路径有直接失败证据**；不能假设 keep-awake assertion 就能修复。                 | 事件投递不依赖面板发光，但权限、session 状态及 wake 行为仍适用。     |
| 拔线 / output 消失                        | display 枚举、默认主屏和 capture target 可能改变；已有 stream/filter 必须重新验证。                         | 全局坐标可能变化，旧截图对应坐标不能继续使用。                       |
| 合盖                                      | 若触发 system sleep，自动化不再持续运行。符合 closed-display 条件时是另一种情况。                           | 同左；虚拟屏是否足以满足合盖运行条件未验证。                         |
| Screensaver，未 lock                      | 不能把画面当成原应用仍可见的证明；可能捕获遮挡内容或出现不同更新行为。                                      | 输入可能退出 screensaver，并使面板亮起。                             |
| Lock                                      | 不属于本需求的 unlocked-session 范围；应停止 driving。                                                      | 不应尝试绕过 lock 或继续向原应用输入。                               |
| System sleep                              | 不存在持续的新 capture / input 执行。                                                                       | 同左。                                                               |

Apple DTS 在 **2026-05** 针对“仅 display sleep、HTTP server 仍运行”的报告表示，`SCScreenshotManager` 无法直接捕获该场景中的窗口。这是具体案例的支持答复，不是所有 `SCStream` filter 的完整行为规范，但足以否定“现有物理屏截图路径肯定继续工作”。[Apple DTS](https://developer.apple.com/forums/thread/827059)

对 API 的具体判断：

- **ScreenCaptureKit**：`SCStream` 明确定义 `complete`、`idle`、`blank`、`suspended` 等状态；有 callback 或 image buffer 不等于最新完整桌面帧。当前 native collector 尚未检查该状态。[Apple `SCFrameStatus`](https://developer.apple.com/documentation/screencapturekit/scframestatus/idle)
- **`CGWindowListCreate` / `CGWindowListCopyWindowInfo`**：枚举窗口元数据不等于获取画面，不能用窗口仍在列表中证明截图正常。[Apple window-list API](https://developer.apple.com/documentation/coregraphics/cgwindowlistcreate)
- **`CGWindowListCreateImage` / `CGDisplayCreateImage`**：属于旧 capture 路径；当前 SDK 有弃用/obsolete 限制，Apple 要求迁向 ScreenCaptureKit。即使旧 binary 在某版本仍可调用，也没有找到可依赖的“display asleep 时持续新帧”契约，不建议作为 fallback。[Apple release notes](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)、[`CGDisplayCreateImage`](https://developer.apple.com/documentation/coregraphics/cgdisplaycreateimage?language=objc)

### 3.2 候选方案

| 方案                                             | 要求、稳定性与限制                                                                                                                                                     | 映射到现有生命周期                                                                                                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`CGVirtualDisplay`**                           | 用户态 private API；没有发现必须 root、kext 或关闭 SIP 的要求。需 Screen Recording、Accessibility。无公开稳定性保证，必须检测 class/selector、创建结果和实际 capture。 | `acquire`：保存布局、创建并强引用一个 virtual display、等待枚举、绑定 capture target；`ping`：检查对象/output/capture/power 状态；`release`：停止 capture、恢复布局、释放对象与 power hold。 |
| **`IOPMAssertion` / `caffeinate`**               | public power API。`-i` 防止 idle system sleep；`-d` 阻止 display sleep；`-u` 会点亮已关闭屏幕。它只解决系统保活，不能单独修复 capture surface。                        | 作为所有有效方案的附属资源。优先扩展 `cognia-power`，不再启动一套独立常驻脚本。                                                                                                              |
| **HDMI/DP dummy plug**                           | 以硬件维持 output；无需创建虚拟屏的 private API。用户需外设和空闲接口；仍须验证内置面板关闭、热插拔及合盖行为。                                                        | `acquire` 选择并验证现有 dummy output，而非创建；release 只恢复 Cognia 改过的布局，不能移除用户硬件。                                                                                        |
| **BetterDisplay / DeskPad / Sidecar 类外部工具** | 可辅助原型和硬件对照，但不能把外部工具存在视为 Cognia backend ready。Sidecar 也不是可随意复用的通用虚拟显示创建 API。                                                  | 若作为外部依赖，只能管理明确拥有的资源；不得销毁用户原有虚拟屏。                                                                                                                             |

`CGVirtualDisplay` 有可检查的真实实现：

- Chromium 使用从 CoreGraphics binary 生成的 private declarations，并处理 macOS 14 的非零 vendor / 不同 serial 要求、对象强引用和异步 display notifications。**其测试工具另有 display-sleep blocker，因此不能作为熄屏成功证据。**[Chromium 实现](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/display/mac/test/virtual_display_util_mac.mm)
- DeskPad 提供 private header；许可是 MIT。Chromium 对应代码采用 BSD-style/BSD-3-Clause 许可，复用需保留相应声明。[DeskPad header](https://github.com/Stengo/DeskPad/blob/main/DeskPad/CGVirtualDisplayPrivate.h)、[MIT license](https://github.com/Stengo/DeskPad/blob/main/LICENSE.md)、[Chromium license](https://chromium.googlesource.com/chromium/src/+/HEAD/LICENSE)
- BetterDisplay 当前为 proprietary license，不应直接复制或随 Cognia 重新打包。[BetterDisplay license](https://betterdisplay.pro/license/)

**物理屏控制仍是独立风险。** BetterDisplay 自己区分 soft-disconnect 和 panel standby，并记录 Apple Silicon / Intel 差异。因此 brightness=0、黑色 overlay 或从布局移除显示器，都不能独立证明“真正熄屏”。[BetterDisplay connections 文档](https://betterdisplay.pro/guide/interface-reference/settings/displays/overview/connections/)

ScreenCaptureKit 可以处理 virtual displays，但存在多虚拟屏断开重连后**抓错屏幕**的上游报告：即使 filter 的 displayID、尺寸正确，也可能取得另一屏内容。没有查到可普遍依赖的修复保证。MVP 应只拥有一个虚拟屏，并用可识别内容验证目标。[Apple forum / FB17797423](https://developer.apple.com/forums/thread/786829)

### 3.3 Entitlements、分发与坐标

- **TCC**：Screen Recording 和 Accessibility 分别检查；Input Monitoring 是监听输入相关权限，不能替代前两者。
- **Sandbox**：DeskPad 的 sandboxed build 带有 `com.apple.VirtualDisplay` mach-lookup temporary exception。这是参考实现要求，不能直接照搬为当前 Tauri build 的必要 entitlement。[DeskPad entitlements](https://raw.githubusercontent.com/Stengo/DeskPad/main/DeskPad/DeskPad.entitlements)
- **SIP**：本路线没有证据要求关闭 SIP；不应设计成依赖关闭 SIP。
- **Mac App Store**：2.5.1 要求 public APIs，因此不建议将 `CGVirtualDisplay` 作为 App Store 路线。
- **Developer ID / notarization**：是另一个分发流程；notarization 不等于 App Review，也不代表 private API 获得支持。实际签名、hardened runtime、TCC 和公证包必须验证。本仓当前启用了 `hardenedRuntime`。[App Review](https://developer.apple.com/app-store/review/guidelines/#software-requirements)、[Notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

坐标应绑定**已获取的 display ID、logical bounds、pixel dimensions、scale 和 topology generation**。macOS CGEvent 使用 global logical points，而截图是 pixels。无旋转、无 crop 时可以按：

```text
globalX = displayOriginX + imageX × logicalWidth / capturedWidth
globalY = displayOriginY + imageY × logicalHeight / capturedHeight
```

crop、缩图和 rotation 另计入变换。单纯 make-primary 不能解决 HiDPI，也不能保证原有应用窗口自动移到虚拟屏；必须决定移动哪些窗口、何时恢复。

### 3.4 建议

**允许 private API 时，做单虚拟屏 beta；否则先支持用户自备 dummy output。**

MVP 限制建议：

- 单个 owned virtual display，固定 1920×1080、1× scale。
- ScreenCaptureKit 显式绑定目标 display，禁止默默 fallback 到其他屏。
- 使用 system-only power hold。
- 第一期不承诺合盖；lock、system sleep、权限撤销时停止输入。
- 物理屏保持关闭须经过输入期间的硬件验收，不能仅凭 virtual display 创建成功开放“已验证”状态。

人工必须决定：private API 分发风险、支持哪些硬件/OS、是否接受外设、窗口迁移策略，以及 `keepScreenOn` 与 screen-off 同时请求时的优先级。

## 4. Linux

### 4.1 熄屏后哪些部分可能失效

| 状态                     | X11                                                                                                                      | Wayland                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 仅 DPMS off，output 保留 | X server/root drawable 通常仍存在，`GetImage`/XShm 可能继续取得内容；是否持续更新取决于应用、compositor 和驱动，须实测。 | 物理 output 的 repaint/capture 可能暂停；portal/PipeWire 不承诺电源关闭后该 surface 仍更新。 |
| 显示器按键 off           | 若保留 connector，可能继续；若发生 HPD disconnect，变成 topology 变化。                                                  | 同样取决于 connector 和 compositor。                                                         |
| 拔线 / disable output    | RandR 几何、primary 和可枚举 monitor 可能改变，现有 `xcap` 可能失败或选到其他屏。                                        | 被采集 output 可能被移除，stream 可停止或关闭；必须保留另外的 virtual output。               |
| Screensaver / lock       | XTest 可能退出 screensaver；lock 后事件可能进入 locker，不能视为仍控制原应用。                                           | compositor 可暂停/撤销 emulated input 和 capture；lock 与输出关闭是不同状态。                |
| 合盖                     | 常触发 logind/DE 的 suspend 或 lock；需单独验证。                                                                        | 同左。                                                                                       |
| System suspend           | 无持续 capture/input。                                                                                                   | 同左。                                                                                       |

**XShm 不解决熄屏问题。** 它把 drawable 图像读取到共享内存，是传输方式；不创建 output、不维持 repaint，也不控制 DPMS。[XShm API](https://www.x.org/releases/X11R7.5/doc/man/man3/XShmQueryExtension.3.html)

DPMS 中的 `Suspend` 是显示器电源等级，不是整机 suspend。XTest 输入仍可进入同一 X server，但上游实现会退出已激活的 screensaver。因此不能承诺 `xset dpms force off` 后持续输入永远不亮屏；反复强制 off 的轮询也可能闪屏。[DPMS 规范](https://xorg.freedesktop.org/archive/current/doc/libXext/dpmslib.html)、[XTest 实现](https://raw.githubusercontent.com/mirror/xserver/master/Xext/xtest.c)

对输入后端分别判断：

| 后端               | 熄屏时的可行性与边界                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **XTest**          | unlocked X11 session 中可继续工作；需要正确 `DISPLAY` / X authentication。Xwayland 的可用性不代表可控制所有 native Wayland 应用。                            |
| **uinput**         | 向内核创建的虚拟输入设备送事件，不依赖 capture；需要 `/dev/uinput` 权限/ACL 或受限 helper，且必须处理 seat 和绝对坐标映射。它也可能触发 wake，不解决显示面。 |
| **libei / portal** | compositor 授权后可工作；服务器可以 pause/filter/discard 事件。应观察 device resumed/paused 状态，不能仅以 FD 打开成功报告可用。                             |

[uinput 内核文档](https://docs.kernel.org/input/uinput.html)、[libei device protocol](https://libinput.pages.freedesktop.org/libei/interfaces/ei_device/index.html)

### 4.2 候选方案

| 方案                                 | 要求 / 稳定性                                                                                                                                            | 当前会话、生命周期与坐标                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **X11 retained output / dummy plug** | 一般同用户即可，无需内核模块；显示器 HPD 行为和 GPU 驱动需列入支持矩阵。                                                                                 | 对当前桌面改动最小。保存 RandR primary、mode、position、rotation 等；选定 output，保持系统运行；release 恢复自己改过的状态。                       |
| **Xvfb / Xdummy**                    | Xvfb 是独立内存 framebuffer X server；Xdummy 需 Xorg dummy DDX，安装/配置可能需管理员。                                                                  | 创建的是另一个 X server，**不会接管当前 `:0` 的已有窗口**。适合专用自动化桌面，需 target-aware `DISPLAY`、authentication、应用启动和独立坐标空间。 |
| **`xrandr --setmonitor … none`**     | RandR monitor 几何定义，无 root；不是新 DRM connector/CRTC。                                                                                             | 可以划分已有 framebuffer，但不保证 `xcap` output 枚举能看到，也不能保证物理 outputs 全消失后仍渲染。不能单独实现 VDD。                             |
| **VKMS**                             | 内核软件 KMS；内核须启用/加载模块，通常需管理员。                                                                                                        | 新 DRM device 不代表当前 compositor 自动纳入该显示。多 GPU、renderer、buffer import 和现有桌面接入需验证；不宜作为首选。                           |
| **EVDI**                             | out-of-tree kernel module + `libevdi`；涉及 DKMS/kernel ABI、Secure Boot 签名和发行版维护。                                                              | 具备 add/remove/update，形式上接近 VDD；仍需 compositor 接纳、mode/EDID 管理和完整恢复。                                                           |
| **wlroots headless output**          | 依赖具体 compositor。Sway `create_output` 需要合适 backend，源码标为开发用途；不能推定所有 wlroots compositor 相同。                                     | 是真正不显示给用户的 output。acquire 创建并布置目标 workspace；capture 绑定该 output；release 恢复并移除 owned resource。                          |
| **GNOME/Mutter virtual monitor**     | `RecordVirtual` 是 private API，跨版本稳定性风险高。`mutter --virtual-monitor` 是启动 compositor 的选项，不是向正在运行的 GNOME 注入 output 的通用接口。 | 直接启动 headless/nested compositor 通常创建另一会话。对现有会话优先 portal；GNOME Remote Login 也不能等同于接管当前已登录桌面。                   |
| **KDE/KWin virtual output**          | KWin 有实际 virtual-output 实现；优先经 portal 能力，而非直接绑定内部协议。                                                                              | KWin 将 output 生命周期绑定 screencast stream，适合 acquire/session-close→release。逻辑尺寸、scale 和窗口位置必须同步。                            |
| **PipeWire virtual source**          | 媒体 node，不是显示设备。                                                                                                                                | 单独创建 source 不会给 compositor 增加桌面区域；必须先有 compositor virtual output 或其他画面生产者。不能独立实现 `VddDriver`。                    |

对应一手依据：[Xvfb](https://xorg.freedesktop.org/releases/X11R6.8.2/doc/Xvfb.1.html)、[VKMS](https://kernel.org/doc/html/latest/gpu/vkms.html)、[EVDI](https://github.com/DisplayLink/evdi)、[wlroots headless API](https://wlroots.pages.freedesktop.org/wlroots/wlr/backend/headless.h.html)、[Sway 创建实现](https://raw.githubusercontent.com/swaywm/sway/master/sway/commands/create_output.c)、[GNOME 维护者说明](https://discourse.gnome.org/t/question-about-remoting-the-gdm-greeter-session/32812)、[KWin 实现](https://raw.githubusercontent.com/KDE/kwin/master/src/plugins/screencast/screencastmanager.cpp)、[PipeWire capture tutorial](https://docs.pipewire.org/page_tutorial5.html)。

Sway 还明确区分：

- `output … power off` 保留 workspaces/windows。
- `output … disable` 会失去该 output 的 workspace/window 关联。

保留关联仍不保证该物理 output 的 capture 持续更新。[Sway output 文档](https://raw.githubusercontent.com/swaywm/sway/master/sway/sway-output.5.scd)

### 4.3 原生 Wayland 应采用的路径

建议采用同一授权 session 管理 capture 和 input：

```text
RemoteDesktop.CreateSession
  → SelectDevices
  → ScreenCast.SelectSources
  → RemoteDesktop.Start
  → ScreenCast.OpenPipeWireRemote
  → RemoteDesktop.ConnectToEIS
```

必须查询接口版本、`AvailableDeviceTypes` 和 `AvailableSourceTypes`。ScreenCast 定义了 **`VIRTUAL = 4`**，但只有 backend 实际宣告支持时才可使用。授权恢复 token 也不保证永久免确认。[ScreenCast interface](https://github.com/flatpak/xdg-desktop-portal/blob/main/data/org.freedesktop.portal.ScreenCast.xml)

RemoteDesktop 推荐 EIS/libei；建立 EIS 连接后不能继续混用 `Notify*` 输入方法。session 关闭或 EIS 断开应使 backend 失效并释放资源。[RemoteDesktop contract](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)

坐标不能沿用“Linux 全是物理像素”的假设：

- PipeWire buffer pixels 不一定等于 compositor logical size。
- libei absolute device 的 region 可能只覆盖部分桌面。
- 应使用 stream metadata / `mapping_id` 匹配输入 region，并处理 scale、rotation、crop。
- output 重建后，旧 node ID、display ID 和 transform 均须失效。[libei regions](https://libinput.pages.freedesktop.org/libei/api/structei__region.html)

还有一个当前风险：上游 issue 报告 `xdg-desktop-portal 1.21.1` 的 virtual-source absolute input 可因零尺寸校验失败而返回 `Invalid position`；本次看到 issue 仍 open。不能仅凭发行版版本号判断，需实测对应 build 或优先验证 EIS 路径。[Issue #2077](https://github.com/flatpak/xdg-desktop-portal/issues/2077)

### 4.4 部署与许可

建议优先依赖系统提供的 compositor、portal 和 PipeWire，避免把整套桌面或内核驱动打进应用。

| 组件                    | 分发判断                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Xorg / Xvfb / dummy DDX | 通常为 MIT/X11 类许可，但具体捆绑版本及 `Xdummy` wrapper 要单独核对；本次未完成 wrapper 的逐文件许可审计，MVP 不建议捆绑。                                                                                                                                                                                                                                                    |
| PipeWire                | 主要为 MIT；部分 ALSA/JACK 组件有 LGPL/GPL 例外，不能给整个依赖树统一标 MIT。[License](https://github.com/PipeWire/pipewire/blob/master/LICENSE)                                                                                                                                                                                                                              |
| Mutter / KWin / Krfb    | 不建议复制 compositor 实现。所查 KWin screencast 文件为 LGPL-2.0-or-later；`krfb-virtualmonitor` 为 GPL-3.0-or-later，且会启动 VNC 服务，不应当成纯显示配置工具。[KWin source](https://raw.githubusercontent.com/KDE/kwin/master/src/plugins/screencast/screencastmanager.cpp)、[Krfb source](https://raw.githubusercontent.com/KDE/krfb/master/krfb/main-virtualmonitor.cpp) |
| VKMS                    | 内核 GPL 路线；优先使用发行版模块，不自行维护一套模块发行。                                                                                                                                                                                                                                                                                                                   |
| EVDI                    | **module 为 GPL v2，library 为 LGPL v2.1-or-later，其余多数文件 MIT**；不能被根目录 license badge 误导。[上游说明](https://github.com/DisplayLink/evdi#licensing)                                                                                                                                                                                                             |

uinput 和内核模块需要分别管理设备 ACL、安装授权与生命周期，不能因此让整个 Cognia 以 root 运行。systemd 的 sleep、idle、lid-switch inhibitors 语义也不同；尤其 lid 行为还可能由 DE 接管。[systemd inhibitors](https://systemd.io/INHIBITOR_LOCKS/)

### 4.5 建议

**第一阶段：X11 受限 MVP。**

支持“已验证 retained output / 用户自备 dummy output + 当前 unlocked X11 session”，不安装 kernel module，不声称 `--setmonitor` 是 VDD。其价值是最小成本验证完整 Cognia capture/input/恢复路径。

**第二阶段：原生 Wayland portal backend。**

先选一个明确的 KDE/portal 组合验证 virtual output、input 和 physical power-off；GNOME 按运行时 portal 能力开放，Sway 作为独立 backend。若要求第一期即“纯软件、控制现有 Wayland 桌面”，应直接承担这个阶段的范围，不能把 Xvfb 当成替代完成。

## 5. 与现有 contract 的具体接合

### Lifecycle 与 topology

现有 controller 可以复用，但不能只增加两个 `driver_*.rs`：

| 阶段      | 新后端需要的行为                                                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acquire` | 确认 unlocked session、权限和电源策略；保存真实布局；创建/选择 output；等待 ready；建立 capture/input target；失败时回滚部分资源。                                    |
| `ping`    | macOS 不需要模拟 Parsec IOCTL；检查 display/capture 对象。Linux 监听 portal/session/output/power 状态。健康检查可保留在 controller，实际事件读取需要平台 event loop。 |
| `release` | 停止输入、释放 capture/session、恢复仍存在的物理 outputs、移除 owned virtual output、释放自己的 power hold。不能销毁用户已有屏幕。                                    |
| 异常      | topology 变化、lock、permission revoke、stream/EIS disconnect 应使旧坐标失效。恢复失败要可诊断；当前 infallible、异步 release 不能证明恢复已完成。                    |

`AcquiredDisplay` 当前只有 label/width/height，建议增加内部 typed target 与 geometry：display/output identity、logical bounds、pixel size、scale/transform、generation。renderer 原有 `monitor` 字符串可以保留，不应继续承担真实资源标识职责。

还需处理窗口归属：**虚拟屏上有一张新桌面，不等于原任务应用已在那里**。迁移、mirror 或专用 workspace 应是明确策略，并记录可恢复状态。

### Health / setup / probe

现有字段可以保留，但应定义跨平台语义：

- `installed`：所需 backend/dependency 已存在；内置 macOS backend 不需要伪造 installer marker。
- `available`：当前 session、权限、output 和输入路径具备尝试条件；**不是物理屏已持续熄灭的证明**。
- `backend`：真实选中的 backend ID。
- `driverVersion`：可选的平台/依赖版本，UI 应改为通用名称。
- `lastError`：区分缺权限、unsupported compositor、locked session、capture failure、restore failure。

建议的 backend IDs：

| Backend                        | `setup` 应做什么                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `macos-cgvirtualdisplay`       | 显示 private API 提示、引导 Screen Recording / Accessibility；无需 Windows 式 elevated installer。 |
| `macos-existing-output`        | 引导选择并验证用户提供的 dummy/virtual output。                                                    |
| `linux-x11-existing-output`    | 验证 X connection、目标 output、power hold；缺硬件时提供说明。                                     |
| `linux-wayland-portal-virtual` | 由用户启动 portal 授权；能力不足明确报告。                                                         |
| `linux-sway-headless`          | 检查 compositor/backend/protocol，不按 `linux` 字符串直接开放。                                    |

UI 需要取消 `isWindows` 分支，并区分“可设置”“缺权限”“不支持”“运行故障”。仅返回 `available:false` 时统一显示 Setup required 会误导用户。

probe 应验证动态 fixture、目标身份和至少一次输入后的状态变化。当前 `nonBlack` 可保留兼容，但编码大小不应继续作为成功依据；还应避免释放其他会话持有的 display lease。

### 预计修改范围

无需先创建新 crate。平台 driver、capture routing 留在 `cognia-automation`；保活扩展已有 `cognia-power`。

| 范围          | 预计文件 / 模块                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 共用          | `virtual_display/{mod,controller}.rs`、`commands.rs`、`lib/automation/client.ts`、health hook、`screen-off-card.tsx`、双语 split i18n、相关测试 |
| macOS         | 新 `driver_macos.rs` 与小型 native virtual-display bridge；更新 `build.rs`、`ax/screen_capture.rs`、native capture 的身份/状态校验              |
| Linux X11     | 新 X11 driver/topology 模块；更新 `atspi/mod.rs`、capture target routing 和能力检测                                                             |
| Linux Wayland | 新 portal session、PipeWire capture、libei input、target geometry 模块；不能只靠启动命令接通                                                    |
| Power         | `cognia-power/src/lib.rs`：专用 screen-off hold、可观测失败、Linux 允许 display-off 的策略及与其他 hold 的冲突规则                              |
| 文档          | 补充 ADR、支持矩阵和硬件验收记录；Windows setup binary 无需为用户态方案扩展                                                                     |

粗略工程估计，假设一名熟悉仓库的工程师、有硬件和签名环境，包含测试及基本恢复：

| 交付                                              | 估计                                  |
| ------------------------------------------------- | ------------------------------------- |
| macOS private-API beta                            | **2–4 周**                            |
| Linux X11 受限 MVP                                | **1–2 周**                            |
| 一个 Wayland compositor 组合的完整 portal backend | **3–5 周**                            |
| 扩展 GNOME/KDE/Sway、多 GPU 与 kernel-module 路线 | 另行估计，不能从首个 backend 成功推算 |

这些是范围估算，不含 Apple/private API 回归、上游修复等待和完整发行版认证。

## 6. 真机测试计划

以下是待执行计划，不是本次测试结果。

### 公共验收方法

使用受控测试应用，展示递增时钟、每轮 nonce、点击计数器、文本框和拖拽目标。每个阶段必须通过**真实 Cognia backend**截图与输入；`grim`、DeskPad 或远控工具单独成功只能作为对照。

建议每组持续 **30 分钟**：

1. 每秒取样，检查 fixture 时间和 nonce 持续推进。
2. 执行至少 300 次 click/type/scroll/drag，核对应用内最终状态。
3. 记录 capture target、帧时间、geometry、错误、输入结果。
4. 用外部相机或光传感器确认面板持续关闭；软件 power 状态不足以证明无亮屏。
5. 再单独等待超过 5 分钟无 action，验证 idle release。

### macOS

在真实签名的 Tauri app 上测试；覆盖项目最低支持版本和当前目标稳定版本，Apple Silicon 为主，若仍支持 Intel 则加入 Intel。

| 操作             | 方法                                                                                                         | 预期 probe / 行为                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 亮屏基线         | 正常操作 fixture                                                                                             | 正确 display、尺寸、nonce、输入结果                                                             |
| 仅 display sleep | 测试时使用 `caffeinate -i -t 1800` 保持系统运行，再执行 `pmset displaysleepnow`；测试账户先确认不会随即 lock | 当前普通 physical capture 允许明确失败；候选 virtual backend 必须取得最新 fixture，面板持续关闭 |
| 物理 off / 拔线  | 分别关闭外屏电源、拔线，不能合并                                                                             | 重新验证 display identity/geometry；不允许静默换屏                                              |
| 合盖             | 分别测 AC/电池、dummy/virtual output                                                                         | 第一阶段若不支持，明确停止；不得以“进程偶尔还运行”判定通过                                      |
| 多虚拟屏         | 与 Sidecar、DisplayLink、另一个 virtual display 共存，断开重连                                               | 必须用不同 nonce 检出抓错屏；无法可靠确认时 fail closed                                         |
| TCC              | deny、revoke、regrant，重启真实 app                                                                          | health 区分 installed 与 permission-ready，输入不静默成功                                       |
| 退出/kill/crash  | kill switch、正常退出、强杀                                                                                  | owned display 消失、自己的 assertion 释放、物理屏可恢复                                         |

Apple 的 closed-display 外屏条件另有电源、外置输入设备等要求，不能假设 CGVirtualDisplay 自动满足。[Apple closed-display guidance](https://support.apple.com/en-ie/102501)

### Linux

至少覆盖 Xorg、GNOME Wayland、KDE Wayland；Sway 单独验收。记录 distro/kernel/GPU/compositor/portal/PipeWire 的精确版本，以及 HDMI/DP/eDP、scale 和输出布局。

| 操作                  | 方法                                                                              | 预期                                                                     |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| X11 DPMS              | 同一用户会话执行 `xset dpms force off`；恢复用 `xset dpms force on`               | 继续取得新 fixture；输入后面板不得重新发光，否则该配置不满足严格熄屏     |
| 物理 off / disconnect | 分别按电源键、拔线                                                                | 区分 retained output 与 output lost；不能复用旧 transform                |
| Sway power off        | 先用 `swaymsg -t get_outputs` 确认名称，再对物理 output 执行 `output … power off` | virtual output 保持 active；不要用 `*` 把 virtual output 一并关闭        |
| GNOME/KDE             | 使用各自显示睡眠机制；portal 授权在亮屏阶段完成                                   | 检查 VIRTUAL、stream、EIS device 和输入 region；依赖不足报告 unavailable |
| Portal revoke/restart | 撤销授权、关闭 session、重启相关服务                                              | 停止输入、销毁 owned output，不保留假 Ready                              |
| Lid / lock / suspend  | 分开触发；记录 logind 和 DE 状态                                                  | lock 后停止 driving；suspend 不期待持续执行；resume 后重建身份与坐标     |
| 布局变化              | 双屏负坐标、100%/150%、rotation、hotplug                                          | 点中正确 fixture，旧 generation 被拒绝                                   |

最终还需检验 release 后的 primary、mode、position、scale、rotation 和窗口位置；若原物理屏仍不可用，应给出可恢复的降级状态，而不是报告“完全恢复”。

**尚未验证的发布门槛**是：目标硬件上持续新帧、输入期间物理面板不亮、virtual-output 重建后不抓错屏，以及异常退出后的恢复。完成这些之前，适合发布的是 backend 原型或受限 beta，不能宣称 macOS/Linux 已具备 Windows 等价能力。

## Sources

主要一手资料已随对应结论链接；核心依据为：

- Apple：[ScreenCaptureKit sleep 答复](https://developer.apple.com/forums/thread/827059)、[virtual-display capture 问题](https://developer.apple.com/forums/thread/786829)、[power assertion flags](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.8)、[App Review](https://developer.apple.com/app-store/review/guidelines/)。
- X11：[DPMS](https://xorg.freedesktop.org/archive/current/doc/libXext/dpmslib.html)、[XTest 实现](https://raw.githubusercontent.com/mirror/xserver/master/Xext/xtest.c)。
- Wayland：[ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html)、[RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)、[libei](https://libinput.pages.freedesktop.org/libei/)。
- Virtual outputs：[KWin](https://raw.githubusercontent.com/KDE/kwin/master/src/plugins/screencast/screencastmanager.cpp)、[wlroots](https://wlroots.pages.freedesktop.org/wlroots/wlr/backend/headless.h.html)、[VKMS](https://kernel.org/doc/html/latest/gpu/vkms.html)、[EVDI](https://github.com/DisplayLink/evdi)。
