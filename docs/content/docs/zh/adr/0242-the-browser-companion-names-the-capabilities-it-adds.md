---
title: "0242 — 浏览器伴侣声明它新增的能力"
description: "扩展和 Host 分开发布，而 agent-safe-v1 是冻结的、封闭的操作词汇表。本 ADR 保持该 profile 不变，在它旁边增加能力：扩展在 hello.features 中声明每项能力；浏览器未声明某项能力时，Host 在发送前就拒绝该能力的操作。首批两项能力是按会话生效的请求规则（network-rules-v1）和用于端到端测试的录制步骤（recording-v1）。"
---

# ADR 0242 — 浏览器伴侣声明它新增的能力

**状态：** 提议中
**日期：** 2026-10-27
**相关：** [ADR-0228](./0228-the-browser-companion-captures-richly-and-can-be-driven)（设备 socket、`agent-safe-v1` profile 及其取消规则）、[ADR-0201](./0201-the-desktop-browser-runs-chromium-locally)（浏览器工具及其特权引擎方法）

## 背景

ADR-0228 §5 把驱动词汇表冻结为 `agent-safe-v1` profile。扩展在 `hello.features` 中发送该 profile；Host 只向协商了它的连接转发操作，扩展会拒绝自己未实现的操作。任何一方都无法增加对方没有同意的能力。

扩展现在新增了两项 Agent 应当能够使用的能力：

1. **请求规则。** 侧边栏可以让页面请求直接返回结果、失败、延迟或重定向，也可以改写请求头。Agent 在复现 bug 时，也需要在它驱动的标签页里这样做。
2. **录制步骤。** 用户可以录制自己在页面中的操作。这些步骤是端到端测试的原始素材；编写测试的 Agent 需要读取它们，或者在自己的标签页中录制。

扩展通过浏览器商店发布，Host 随桌面应用发布。知道新操作的 Host 会遇到不知道该操作的扩展，反之亦然。把新名称加进 `agent-safe-v1`，会改变一个按定义冻结的 profile；每次新增都另立一个完整的新 profile，则会让每次新增都变成双方必须同步升级。

## 决定

### `agent-safe-v1` 保持不变；能力在它旁边另行声明

profile 的含义不变：可安全取消的信封格式，加上 ADR-0228 定义的操作。能力是 `hello.features` 中的另一项，名称自带版本，例如 `network-rules-v1`。能力只增加操作，不改变其他任何东西。它的操作使用同一种信封，遵守相同的取消、暂停和接管规则，并需要相同的 `browser.drive` 授权。

`packages/companion-client/src/browser-agent-protocol.json` 在 `operations` 中列出全部操作，并在 `operationFeatures` 中把每个受能力约束的操作映射到对应的能力。Rust socket 的 `OPERATIONS` 和 `OPERATION_FEATURES` 由测试固定为与该文件一致。

### 浏览器未声明的能力，Host 直接拒绝

`call()` 在检查 profile 之后检查能力。如果连接的 `hello` 没有声明某个操作所需的能力，该操作会以 `browser_feature_unsupported`（HTTP 412，不可重试）被拒绝，既不进入队列，也不会发送。扩展仍然会拒绝它未实现的操作，因此早于本 ADR 的 Host 同样安全。

Agent 工具在所有后端上都会注册。对应的引擎方法是可选的，只有扩展引擎提供，而且属于特权方法：只有第一方 Browser Tools 能拿到。在其他任何后端上，这些工具都返回 `browser_feature_unsupported`。

### `network-rules-v1`

| 操作 | 平面 | 参数 |
| --- | --- | --- |
| `set_network_rules` | call | `rules`：替换本会话的全部规则 |
| `clear_network_rules` | call | — |
| `list_network_rules` | read | — |

一条规则包含 `match`（`*` 通配、`/regex/flags`，或 URL 的一部分）、可选的 `method` 和 `action`。`action` 取 `fail`、`respond`、`modify`、`delay`、`redirect`、`request_headers` 或 `response_headers` 之一，并带上该动作需要的字段。`list_network_rules` 返回每条规则及其 `coverage` 和 `hits`。改写请求头、拦截和重定向作用于标签页的所有请求（`all-requests`）；伪造响应体、修改响应体、延迟，以及受 `times` 限制的规则，只作用于页面自己发起的 `fetch` 和 XHR（`page-requests`）。`all-requests` 规则的 `hits` 为 `null`：这类规则由浏览器直接应用，不申请读取浏览记录的权限就无法统计匹配次数。

Agent 的规则只作用于其会话持有的标签页。侧边栏会显示这些规则，用户可以删除。会话被释放、停止或被用户接管时，规则会被清除，也不会写入用户自己的规则库。

### `recording-v1`

| 操作 | 平面 | 参数 |
| --- | --- | --- |
| `start_recording` | call | —：在会话当前活动的标签页中录制 |
| `stop_recording` | call | — |
| `list_recordings` | read | — |
| `get_recording` | read | `id`，可选 `format`：`steps` 或 `playwright` |

每个步骤使用 Agent 自己的动作名称（`click`、`fill`、`select`、`press_key`、`navigate` 等，外加 `assert`），并附带目标元素的定位器，按优先级从高到低排列。敏感字段的值永远不会被录制：步骤只标明该字段是敏感字段，生成的测试从环境变量读取它的值。`get_recording` 指定 `format: "playwright"` 时，还会返回扩展生成的 Playwright 测试。录制内容和生成的测试都属于来自页面的数据，工具会把它们标记为不可信内容。

Agent 只能在其会话持有的标签页中录制。页面和侧边栏都会显示正在录制，并提供停止按钮；会话结束时录制随之停止。

## 后果

- 两侧可以按任意顺序发布某项能力。在两侧都具备之前，Agent 得到的是明确的拒绝，而不是“未知操作”错误。
- 后续的每项能力都沿用同一套结构：一个能力名称，其操作列入 `operations` 和 `operationFeatures`，一个可选的特权引擎方法，在其他所有后端上一律拒绝。
- `get_recording` 是读操作。录制内容可能很大，幂等账本从不保存它。
- 每个新操作都会改变扩展在 `provenance/host-contract.json` 中固定了哈希的文件。扩展采用此版本时，需要显式刷新其 vendored 的 `companion-client` 以及这些哈希。

## 发布

1. Host 改动和本 ADR 先合入。对于没有声明这两项能力的扩展，它们不改变任何行为。
2. 扩展实现 `network-rules-v1`，刷新 vendored 的协议文件，并开始声明该能力。
3. 扩展实现 `recording-v1` 并声明该能力。
