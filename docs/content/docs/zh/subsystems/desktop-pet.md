---
title: 桌面宠物
description: 在透明浮层窗口中运行的 Shimeji 式伙伴：五种窗口角色、四套受治理渲染器、显式模型兼容性、本地视线跟随、配对远程照护，以及受限的实时资源。
---

# 桌面宠物

<Status variant="beta">Beta · ADR-0058 · ADR-0219 · Dexie</Status>

<TLDR>
  桌面宠物已移除应用内悬浮小部件（ADR-0058 D14），在桌面端运行于独立的透明置顶 Tauri 窗口（`overlay` 与 `popup`）。
  同一份产物由 `WindowRole`（`lib/platform/window-role.ts`）决定启动为五种角色中的哪一种。
  Rust 以 `visible(false)` 创建这些窗口，并且**绝不**在创建路径上显示它们：
  在 Windows 上，一个 `transparent(true)` 窗口若在其 WebView 完成首帧提交之前被显示，
  会渲染成一块不透明的黑矩形。渲染端在挂载后调用共享的揭示逻辑（`lib/tauri/overlay-reveal.ts`），
  等待**两个 rAF** —— 先布局、后提交 —— 确保透明帧已显示后再显示窗口。
  配对后的 Web 与移动端可通过远程控制台照护并对话桌面宠物（ADR-0219）。
  底层模拟包括：需求衰减、照料状态、金币与商店、经验与升级、成就，以及带弹道计算的移动状态机。
</TLDR>

<StatGrid>
  <Stat label="窗口角色" value="5" hint="main · overlay · popup · island · web" />
  <Stat label="受治理渲染器" value="4" hint="svg · live2d · sprite-v2 · media" />
  <Stat label="控制台入口" value="2" hint="/settings?section=pet（桌面）· /me/pet（配对端）" />
  <Stat label="领域模块" value="14" hint="soul · needs · care · economy · xp · achievements · behavior · live2d · sprite-v2 · media-packs · bones · runtime · state · remote" />
</StatGrid>

设计动机见 [ADR-0058](../adr/0058-desktop-pet-subsystem) 与 [ADR-0219](../adr/0219-pet-console-remote-care)。

## 五种窗口角色，同一份产物

```ts
type WindowRole = "main" | "overlay" | "popup" | "island" | "web"
```

同一份静态导出会启动进每一种角色；`getWindowRole()`（`lib/platform/window-role.ts`）从 Tauri webview label 解析出当前角色 —— `PET_WINDOW_LABEL`（`"pet"`）、`PET_POPUP_WINDOW_LABEL`（`"pet-popup"`）、`ISLAND_WINDOW_LABEL`（`"island"`）。`isSecondaryOverlayRole()` 与 `isMainAppWindow()` 是守卫：它们阻止仅限主窗口的工作 —— 启动引导、迁移、单例以及账户数据库读取 —— 在浮层窗口里重复执行。

## 揭示协议源自一个真实 bug

透明浮层窗口是「创建时隐藏、由渲染端揭示」，而不是由 Rust 显示。在 WebView 完成首帧提交之前显示一个 `transparent(true)` 窗口，在 Windows 上会得到一块不透明黑矩形，直到某个操作强制重新合成 —— 也就是「不可见 / 点一下才出现」那个 bug。`lib/tauri/overlay-reveal.ts` 会等待两个动画帧（先布局，再提交后）才调用 `revealPetWindow()` / `revealIslandWindow()`，与主窗口的 `WindowShowInitializer` 契约保持一致。渲染端的揭示在所有平台上都经过 Rust（面板代数检查让落在打开与首帧之间的关闭胜过揭示），随后把尺寸微调一个像素以强制重新合成。已有窗口在首帧绘制之前不会再次显示。启动脚本会给悬浮窗与弹出窗口路由打上 `data-pet-overlay` 标记，因此它们在 React hydrate 之前背景就是透明的。

## 窗口管线

悬浮窗与弹出窗口都以不抢焦点的方式创建（`.focused(false)`；Windows 上为 `WS_EX_NOACTIVATE` / `WS_EX_TOOLWINDOW`；macOS 上为不激活的 NSPanel），宠物不会抢走用户正在使用的应用的焦点，两个窗口也不会出现在 Alt-Tab 中。系统关闭会走与 UI 相同的关闭路径。

| 关注点 | 负责者 |
| --- | --- |
| 窗口位于哪个显示器 | `work_area_for` 用窗口中心点匹配 `available_monitors` 的桌面坐标矩形（`pet_window/mod.rs`） |
| 显示器或缩放变化 | `ScaleFactorChanged` 与跨显示器的 `Moved` 发出 `pet://work-area-changed` |
| 实时尺寸变化 | `pet_window_set_size`，以底部中心为锚点并限制在工作区内 |
| 弹出窗口定位 | `resolve_popup_placement`（`pet_window/popup.rs`），依据宠物在其所在显示器上的矩形；每次内容尺寸变化都会重新定位 |
| CSS → 桌面单位的指针增量 | `resolveCssToDesktopScale` / `petBoxScreenRect`（`lib/pet/overlay-geometry.ts`） |
| 任意窗口的宠物设置写入 | `updatePetSettings`（`lib/pet/settings-sync.ts`）：Web Lock、重新读取，再广播给所有宠物窗口跟随 |
| 账户资源的跨窗口投影 | `lib/pet/live2d/asset-bridge.ts`、`lib/pet/sprite-v2/asset-bridge.ts` 与 `lib/pet/media-packs/asset-bridge.ts` 仅在内存中将当前激活的外观资源从 `main` 投影至 `overlay` / `popup`，不共享账户密钥 |

`PetMount` 不再在主窗口渲染应用内悬浮小部件；`PetMainRuntime` 在主窗口中无头运行，负责控制器、事件源、语音/气泡逻辑及跨窗口投影桥（ADR-0058 D12、D14）。

## 可栖附「表面」按平台显式降级

宠物可以爬上其他可见顶层窗口的上边缘并沿其行走（Shimeji 风格）。`src-tauri/src/pet_window/surfaces.rs` 把它拆成三层，使业务逻辑无需真实桌面即可测试：`PetSurface` / `PetSurfaces` 这组 serde DTO、对普通 `WindowCandidate` 记录做纯判定的 `filter_and_sort_surfaces`、以及薄薄一层平台枚举。Windows 使用 `EnumWindows`；macOS 使用 Core Graphics 窗口元数据，并排除 Cognia 自身进程。Linux 返回空列表，因为 Wayland 有意不公开稳定的跨应用窗口几何信息；浮层会明确退化为常规地面游走，而不是悄无声息地损坏。

<Callout type="warn">
  `PetSurface` 是**具名结构体，不是元组**。裸元组会序列化成 JSON 数组，
  TypeScript 包装层随后会静默读到 `undefined` —— `pet_window/mod.rs` 里就有一条针对此事的回归备注。
</Callout>

## 模拟层

```
lib/pet/
  needs/decay.ts               # 需求随时间下降
  care/condition.ts            # 由需求推导出的健康状态
  care/evolution-flavor.ts     # 照料历史如何影响进化走向
  care/notify-care.ts  notify-scheduled-due.ts
  economy/coin-table.ts  item-catalog.ts  shop.ts  streak.ts
  xp/award-table.ts  leveling.ts
  achievements/registry.ts  check.ts
  behavior/locomotion-fsm.ts  ballistics.ts  wander-config.ts
  soul/generate-soul.ts        # 生成的性格
  bones/generate.ts  palettes.ts  prng.ts  account-id.ts   # 确定性的程序化外观
  state/reducer.ts             # 状态机
  runtime/pet-controller.ts  pet-scope.ts  pet-view.ts  init-pet.ts  apply-event.ts
  remote/host-dispatch.ts  idempotency.ts  transport.ts    # ADR-0219 配对远程照护
  overlay-geometry.ts  popup-geometry.ts
```

由 `account-id.ts` 播种的 `bones/prng.ts` 让同一账号下宠物的程序化外观保持稳定，而不会每次启动重掷。`pet-controller.ts` 在受 `pet-scope.ts`（账户 epoch 与重置代数）围栏保护的串行队列中，以单个 Dexie 事务原子提交成长、道具消耗、活动日记与成就解锁。

## 四套受治理渲染器

`types/pet/skin.ts` 为内置 **SVG**、**Live2D Cubism 3–5**、**Sprite v2** 和 **Media**（DSH WebM 视频包与 WebP/PNG 帧动画包）定义统一契约：类型化资源选择、能力矩阵、渲染模式、视线目标和结构化诊断。未知或已删除的选择会带诊断地归一化为 SVG；不会出现空白渲染，也不会静默进入永久降级。

`lib/pet/skin-runtime.ts` 是每个 WebView JavaScript realm 中唯一的昂贵资源所有者。它按 `configuration > interactive > console > thumbnail` 仲裁唯一实时渲染器，为未获得租约的预览保留中性快照，按资源复用对象 URL 与缓存，统计 renderer/WebGL/ticker/timer/URL/load/context-loss/fallback，并在资源失效或 WebView 销毁时释放。隐藏、挂起、减少动效和点击穿透暂停都会停止更新回调。Live2D 正常上限 60 fps，低功耗为 30 fps，静默期为 12 fps。

`lib/pet/live2d/` 负责 Cubism 模型发现、manifest 解析、导入校验、插件注册、参数/情绪/视线映射、口型同步和 URL 替换。兼容性分为 `ready`、`degraded`、`invalid`：settings、moc 或必要纹理不可用时阻止激活；缺失可选 motion、expression、sound、physics 或 pose 时，删除对应引用并明确报告。路径穿越、归一化重复、大小写不明确、损坏图片、Cubism 2 和超限资源都会在持久化前被拒绝。官方 Hiyori/Haru 语料在 `test-fixtures/pet/live2d-public-corpus.json` 中固定 revision 和 SHA-256；模型二进制下载到 `.cache`，不进入仓库。

`lib/pet/sprite-v2/import.ts` 校验固定 1536×2288 图集契约，`lib/pet/sprite-v2/asset-bridge.ts` 将主窗口中选中的精灵包实时投影到悬浮窗与弹出窗口。图集最后两行提供顺时针 16 个视线方向，按 22.5° 量化，并包含中心死区、迟滞和陈旧输入回到 idle。

`lib/pet/media-packs/` 负责校验并预处理 DSH 视频包（`config.jsonc` + WebM 片段）与帧动画包（`pet-manifest.json` + WebP/PNG 帧），并通过 `lib/pet/media-packs/asset-bridge.ts` 将选中的动画包投影至次级浮层窗口。

角色绑定可以继承全局选择，也可以选择 SVG、某个 Live2D 模型、Sprite v2 包或 Media 动画包。旧的 `live2dModelId` 会被惰性解释为类型化 Live2D 选择；删除资源时会在事务中清除匹配引用，仅当该皮肤类型正是当前启用皮肤时才回退至 SVG。

## 触达宠物与配对远程照护

在桌面端，所有召唤路径（全局快捷键、托盘切换、⌘K「切换桌宠」、设置中的悬浮窗开关、agent 的 `pet_show`）都运行 `openDesktopPetWindow()`（`lib/pet/commands.ts`），按已保存的几何位置打开，并启用已关闭的宠物。六个照料命令以及桌面窗口控制命令（`pet.open-popup`、`pet.toggle-click-through`、`pet.reset-position`）均可在「设置 → 快捷键」中绑定，宠物关闭时仍保持注册。待处理的注意力提醒气泡附带「立即查看」直达入口，可直接跳转到对应对话、团队或运行任务；新的注意力雷达报告以 `radarReport` 气泡提供「打开洞察」（D10）。

在 **Web 与移动端**（ADR-0219），宠物控制台位于 `/me/pet`，通过伴随设备 RPC 与已配对的桌面主机通信：

- **远程可用能力**：只读宠物状态投影（使用镜像骨骼绘制的简化矢量外观）、日常照料动作、背包道具使用、商店购买、装扮应用、改名、孵化以及宠物私密聊天（`pet_chat_send` 采用 `CommandReceiptPolicy::HostSemantic`，私密回复内容不落盘到伴随服务明文 SQLite 回执库）。
- **仅限桌面端**：外观与设置（`appearance`）、注意力雷达采集设置（`insights`）与桌面插件页签（`plugins`）会清晰展示桌面端专属说明，在桌面主机上管理。

## 控制台与自定义工作区

在桌面端，宠物控制台承载于 `/settings?section=pet`（ADR-0058 D15–D16），配对的 Web/移动端访问 `/me/pet`；所有入口均由 `petConsoleHref`（`lib/pet/console-tabs.ts`）生成，旧版标签 id（`nurture`、`customize`、`binding`）仍映射到对应位置。页头身份图块直接绘制宠物，展示可编辑名称及「等级 · 阶段 · 金币」，并提供「外观与设置」和桌宠开关。导航包括首页、对话、商店、收藏（图鉴、成就）、动态（待处理事项列表、日记、洞察）以及扩展（有插件注册时显示）。

首页以「现在最需要」开场：最低的需求以及恢复它最多的照料动作（`lib/pet/care/suggest-care.ts`，按控制器的效果表排序），作为页面主按钮。其下是照料动作与 `pet.panel.actions` 插件槽、背包与金币（含去商店入口）、快捷说话（含携带上下文的完整对话入口）以及档案。

外观与设置（`/settings?section=pet&petView=appearance`）承载 `PetCustomizationWorkspace`（唯一读取 `DEFAULT_PET_SETTINGS` 并通过 `updatePetSettings()` 合并持久化的所有者）及各角色专属外观绑定。

桌面右键弹窗是迷你首页：属性卡、需求、「现在最需要」、照料动作和快捷说话，之后是点击穿透、收回、打开宠物设置、外观与设置。所有「收回」（控制台页头、标题栏、弹窗、托盘、快捷键）都通过 `hideDesktopPetWindow` 持久化 `desktopPet.enabled = false`。

## 相关文档

<Cards>
  <Card title="ADR-0058" href="../adr/0058-desktop-pet-subsystem" description="桌面宠物的决策记录" />
  <Card title="ADR-0219" href="../adr/0219-pet-console-remote-care" description="配对远程照护控制台的决策记录" />
  <Card title="角色" href="../chat/characters" description="宠物的角色与皮肤从何而来" />
  <Card title="语音 / TTS" href="./misc-subsystems" description="use-pet-speak 驱动的 TTS 栈" />
  <Card title="调度器" href="./scheduler" description="触发宠物定时提醒的地方" />
  <Card title="桌面宠物 API" href="../plugin-dev/pet" description="插件能对宠物做什么" />
</Cards>
