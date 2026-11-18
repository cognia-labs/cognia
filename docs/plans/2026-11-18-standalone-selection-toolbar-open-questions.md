# 独立滑词工具栏的待拷问清单

2026-11-18 · 方向已定，细节待拷问 · 等桌面框选（[区域选取方案](./2026-11-17-cross-platform-desktop-region-picker.md)）交付后再开一轮

**方向。** 滑词工具栏会成为独立的轻量应用，不安装 Cognia 也能用。工具栏只保留一份实现：Cognia 桌面把它随包带上，以子进程方式启动；它也可以单独安装。

- **独立运行时的 AI 动作**：解释、翻译、提问只用一个 OpenAI 兼容端点和 key，key 存在系统钥匙串里，结果在工具栏展开的卡片里流式显示。
- **检测到 Cognia 时**：交给 Cognia 的聊天。
- **控件引用**：独立运行时不可用，因为执行要靠 Cognia 的 automation worker。

## 现状

- **检测核心能直接复用。** `selection_events`、AX observer 和输入钩子在 `cognia-automation` 里，不依赖 Tauri。独立应用可以依赖这个 crate（不开 `tauri-host`）。 [选区事件](../../crates/cognia-automation/src/automation/selection_events.rs) · [feature 定义](../../crates/cognia-automation/Cargo.toml)
- **工具栏本体要重写外壳。** [selection_toolbar.rs](../../src-tauri/src/selection_toolbar.rs) 约 4000 行，依赖：
  - `AppHandle`
  - 账户代次检查 `account_binding_epoch`
  - `AutomationState`
  - OCR 注册表
  - 快捷键注册表
  - 桌面宠物的 NSPanel 转换

  其中的纯逻辑（触发判定、搜索引擎、禁用站点、OCR 放行判定、定位夹取）可以搬走。

- **AI 动作现在全在主窗口执行。** 解释、翻译、提问、单位换算交给聊天输入框；记忆和朗读在主窗口；改写用主窗口的 LLM client。复制、搜索、打开链接、写邮件由 Rust 直接完成。 [动作表](../../components/selection-toolbar/selection-toolbar-actions.ts) · [主窗口执行方](../../components/providers/initializers/selection-toolbar-initializer.tsx)
- **缺少交接通道。** 没有能让外部进程把内容放进 Cognia 草稿的生产通道：deep link 只处理插件，CLI bridge 只在调试构建里提供。 [deep link](../../app/deep-link/page.tsx) · [CLI bridge](../../src-tauri/src/cli_bridge/server.rs)
- **没有先例。** 仓里没有第二个 Tauri 应用。

## 待拷问

| 编号 | 问题                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | 和 Cognia 的交接通道：由 Cognia 启动时用父子进程管道；单独安装时如何发现正在运行的 Cognia（本机 socket 或命名管道加按用户发放的令牌）；图片怎么传；协议怎么定版本。                             |
| S2   | 单独安装的和随包的两份二进制谁来运行：按用户会话做单实例锁，先启动的持有；版本不一致时谁让位；macOS 上两份二进制的辅助功能和录屏授权各自独立，用户可能要授权两次。                              |
| S3   | 仓库位置：放在本仓库，作为同一 Cargo workspace 的成员，直接依赖 `cognia-automation`；还是像 services、website、plugins 那样拆到独立仓库，用 git 依赖引用 crate。                                |
| S4   | 第二套发布流程：bundle id、签名、公证、自动更新通道，以及 Windows 安装包。还有随 Cognia 打包的那份如何跟着 Cognia 一起更新。                                                                    |
| S5   | 界面技术：再做一个 Tauri 应用，用独立的小前端包（复用 `components/selection-toolbar/`），还是另选方案。工具栏页面目前在主应用的 Next 静态导出里。                                               |
| S6   | 独立运行时的动作集合：复制、搜索、打开链接、朗读（系统 TTS）、OCR（Apple Vision 或 Windows OCR）、最小配置的 AI 动作，各自在哪运行、结果怎么呈现；框选在独立运行时只提供截图（复制或交给 AI）。 |
| S7   | 账户与设置：独立运行时没有 Cognia 账户。禁用应用名单、站点名单和快捷键存在哪；连接 Cognia 后如何同步。                                                                                          |
| S8   | 体积：如果 `cognia-automation` 带进来的 e2b、远程桌面等依赖让体积或编译时间超出预期，是否把它们改成可选 feature。                                                                               |
