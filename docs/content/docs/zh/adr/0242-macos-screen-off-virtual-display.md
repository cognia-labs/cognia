---
title: "0242 — macOS 熄屏虚拟显示器"
description: "Developer ID Beta 通过运行时解析 CGVirtualDisplay，明确绑定 ScreenCaptureKit 的捕获目标，在物理面板休眠且会话未锁定时维持 Computer Use。"
---

# ADR 0242 — macOS 熄屏虚拟显示器

**Status:** Accepted (beta)
**Date:** 2026-10-27
**Related:** ADR-0020（Computer Use）、ADR-0196（crate 归属）
**Research:** `docs/research/2026-10-27-screen-off-macos-linux-feasibility.md` 第 1–3、5–6 节

## 背景

Windows 熄屏模式拥有 Parsec 虚拟显示器。macOS 原来通过 `SCScreenshotManager` 捕获 `CGMainDisplayID()`；阻止 CPU 休眠并不能保证休眠物理显示器仍有可捕获画面。虚拟显示器提供渲染基础设施，但不能证明合成输入不会唤醒物理面板。

验收包含两个独立条件：真实 Cognia 后端持续获取正确目标的新帧且输入作用于该目标；输入期间物理面板持续关闭。单元测试不能证明这两项硬件行为。

## 决策

发布受限的 **Developer ID Beta**，不通过 Mac App Store 分发。使用 `NSClassFromString` 解析 `CGVirtualDisplay`、`CGVirtualDisplayDescriptor`、`CGVirtualDisplaySettings`、`CGVirtualDisplayMode`，不生成私有类的静态链接引用。类缺失、系统不支持（捕获要求 macOS 14.4+）或 selector 不兼容时明确拒绝，不崩溃。

进程只拥有**一个 1920×1080、1× 缩放的显示器**。不包含分辨率配置、Retina、合盖运行或 Linux 后端。会话必须保持解锁、当前控制台活跃，并授予屏幕录制和辅助功能权限。合盖、会话失活、权限撤销或系统休眠会拒绝后续截图/输入并使显示器失效；恢复或解锁后必须重新 arm。后端不操作锁屏，也不主动让物理面板休眠。

复用 controller、100 ms 健康检查和 5 分钟闲置释放。macOS 后端 ID 为 `macos-cgvirtualdisplay`，Windows 保持 `windows-parsec-vdd`，其他平台报告 `unsupported`。`installed` 表示运行时类存在；`available` 还要求支持的系统、权限就绪、会话解锁及开盖。这只表示允许尝试，不表示硬件验收通过。macOS setup 只检查就绪状态，绝不启动 Windows 安装器。

### 窗口与坐标策略

保存活动显示器原点；对于无法仅靠原点恢复的镜像显示组明确拒绝。将拥有的虚拟屏设为主屏，原点为全局 `(0,0)`；将既有显示器整体平移到它的右侧，保留相对位置、mode、scale 和 rotation。释放时仅恢复仍在线的原显示器原点，仅删除自己创建的虚拟屏。原显示器缺失时报告恢复失败。

主屏切换不会自动迁移已有任务窗口。只迁移被明确指定的应用：树读取、元素解析和应用窗口截图把该应用的 focused/main window 移到虚拟屏。显示器截图不移动任何窗口，Cognia 自身窗口永远不移动（`window_target_failure`），宿主窗口和紧急停止按钮始终留在物理屏上。每个被移动窗口只保存首次位置和尺寸，物理屏位置经布局偏移反算后用于恢复。只在必要时缩小到虚拟屏内，并检查实际窗口完全位于虚拟边界内；不支持移动/缩放的窗口拒绝继续。全屏窗口和镜像显示组不在本 Beta 支持范围。恢复顺序为先物理显示器原点，再窗口位置/尺寸。布局修改只作用于本进程（`kCGConfigureForAppOnly`）：进程无论以何种方式退出，WindowServer 都会还原被平移的原点。

原点 `(0,0)` 加 1× 缩放使截图像素、AX points 和 CGEvent 全局坐标一致，避免应用会话坐标重复平移。显式输入坐标超出虚拟屏时拒绝。准备应用时同时把它激活到前台（通过 AX 读回当前焦点应用确认），并记为本次租约的被驱动应用。输入前检查实时会话、持有键盘焦点的应用是否就是被驱动应用、以及其 focused window 是否位于虚拟屏内；尚未指定目标、焦点被其他应用（包括 Cognia）夺走、或焦点窗口位于物理屏时一律以 `window_target_failure` 拒绝，绝不静默向其他应用或屏幕输入。释放或重新启用会清除被驱动应用。AX 语义操作先准备其解析到的目标应用。

### 捕获、身份与所有权

将拥有的 `CGDirectDisplayID` 明确传入 ScreenCaptureKit。虚拟屏使用 `SCStream`，只接受新的 complete frame，忽略 idle/blank/suspended sample。绝不回退到物理屏；捕获后复核显示器身份、geometry、scale 和生命周期 generation。应用窗口 stream 也执行相同的身份与 generation 检查。

设置页 probe 获取 controller 的独占 lease。若 action 已拥有显示器，probe 返回 busy，不截图也不释放；probe 期间 action 同样不能取得资源。取消或出错时 drop lease，过期 lease 不能释放后续 generation。返回的 monitor 来自已核验的目标身份。`nonBlack` 保留原编码大小启发式以兼容，不作为新鲜度、输入正确性或面板持续关闭的证明。Windows probe 同样按拥有的 GDI 显示器名称选择目标，未知身份不回退。

### 电源与失败分类

原生桥接获取独立且检查结果的 `PreventUserIdleSystemSleep` IOKit assertion，不申请 display assertion，也不声明用户活动。其语义与 `cognia-power` 的 System 一致，但资源独立拥有：该 crate 现有聚合 `acquire()` 是 best effort，不能证明本次就绪。小型 assertion 与原生显示资源共同管理，避免新增 workspace 依赖及 lockfile 改动；失败以 `power_hold_failed` 拒绝 acquire。不会移除或削弱其他子系统的 assertion；其他子系统的 display hold 可能阻止面板休眠，验收时必须记录。

错误分类保留：`unsupported`、`permission_missing`、`session_locked`、`system_sleep`、`lid_closed`、`power_hold_failed`、`capture_failure`、`window_target_failure`、`coordinate_invalid`、`driver_failure`、`restore_failure`。资源移除后，controller health 仍能看到恢复失败。

紧急停止、会话关闭、闲置和 controller shutdown 调用同一 driver release。若正常进程退出绕过 Rust managed-state drop，原生退出 terminator 也会恢复自己拥有的状态。强杀/崩溃后，WindowServer 回收自有显示器并还原本进程的布局修改，IOKit 回收 assertion；被移动的窗口不会复位，必须另做硬件恢复测试。失败只在其所属租约存续时阻断截图和输入；显示器释放后只在健康状态中报告，不再阻断物理屏上的自动化，失败的启用或探测无需重新启用即可恢复。松开鼠标按键和读取光标位置不受门控，按键释放总能送达系统。

## 被否决的方案

- **仅 public API：** 没有可用的公开 API 为当前登录桌面创建所需的软件显示器。
- **Dummy plug：** 可作为独立验证的外部输出，但不是零外设、由后端拥有的方案，不纳入本 Beta。
- **Mac App Store：** 与本方案的私有 API 分发选择不兼容。
- **仅切换主屏：** 已有任务窗口可能留在物理屏，必须明确迁移窗口。
- **仅阻止整机休眠或继续捕获物理屏：** 不能证明渲染面保留，也不能证明面板不亮。

## 真机验收计划

执行研究报告第 6 节：使用真实签名的 Tauri Developer ID 构建，覆盖最低支持版本与目标稳定 macOS，以 Apple Silicon 为主，若仍支持 Intel 则纳入。记录硬件、OS/build、签名身份、权限、显示布局及 power assertions。本 ADR 不声称已执行这些测试。

受控应用显示递增时钟、每轮 nonce、点击计数器、文本框及拖拽目标。每组运行 30 分钟，每秒采样，执行至少 300 次 click/type/scroll/drag，核对最终应用状态，记录 display ID、generation、geometry、帧时间、错误和输入结果。外部相机或光传感器必须确认面板持续关闭。随后超过 5 分钟不执行 action，检查 idle release。

分别覆盖：

1. 亮屏基线；仅显示器休眠（`caffeinate -i -t 1800` 加 `pmset displaysleepnow`，仅在受控测试账户关闭自动锁屏）；外屏电源关闭；拔线。不能把旧帧或换屏当成功。
2. Sidecar、DisplayLink、其他虚拟屏使用不同 nonce，并覆盖断开重连；不支持的镜像布局必须明确拒绝。
3. 权限 deny/revoke/regrant 及重启；锁屏/解锁；强制整机休眠/恢复；AC 和电池下合盖。合盖必须停止，不能作为成功运行。
4. kill switch、会话关闭、正常退出、强杀和崩溃。检查自有显示器消失、assertion 释放，primary/origins/mode/scale/rotation 与移动窗口恢复；原输出缺失时应报告降级恢复。
5. 每个显示器休眠条件下持续输入，并外部观察是否亮屏。虚拟 capture 正常不能单独满足此项。

## 影响

macOS 更新可能破坏私有 API 兼容性。目标不明确、布局或窗口不支持时 Beta 明确拒绝；arm 期间布局变化对用户可见。纯逻辑和 fake-driver 测试证明 contract 与编译，正确新帧、输入、物理面板持续关闭和异常恢复仍须完成上述真机验收，才能声称达到 Windows 等价能力。
