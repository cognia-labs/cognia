---
title: "0258 — 每个环境按同一份契约替换插件包"
description: "覆盖安装、更新和回滚插件是同一个操作：替换已安装的包。执行它的每个环境（桌面端更新器与回滚、CLI、VS Code 扩展安装、无头 Host、配对客户端）都遵守同样五条：只安装审核过的内容，提交前响应取消，把运行时恢复到原来的状态，让包、运行时条目、Dexie 行和安装来源保持一致，失败后只留下两种指定的恢复结果之一。这些条款以数据形式写在 lib/plugin/lifecycle/contract.ts，每个环境用自己的测试框架运行，尚未补齐的缺口逐条列出并由测试固定。"
---

# ADR 0258 — 每个环境按同一份契约替换插件包

**状态：** 已接受
**日期：** 2026-11-18

**相关：**
- [ADR-0209](./0209-a-cogpack-pins-plugins-and-a-cogset-owns-what-runs)：安装来源。对齐条款包括让来源记录保持最新。
- [ADR-0145](./0145-python-plugin-runtime-alignment)：Python 运行时，就绪状态描述的就是它的环境准备。
- [ADR-0224](./0224-an-always-on-host-is-a-peer-the-user-brings)：无头 Host，本契约覆盖的环境之一。

**证据：** 审计 `docs/evidence/2026-11-08-plugin-support-audit.md`（问题 PL01–PL19，缺口 ENV01–ENV07）。修复提交 `de7889b157..81c5c55bc4` 对齐了桌面端更新器与回滚、CLI 和 VS Code 扩展安装。方案：`docs/plans/2026-11-18-plugin-environment-readiness.md`。

## 背景

插件包会在好几个地方被替换，每处都是分别写的：

- 桌面端注册表更新器（`lib/plugin/lifecycle/updater.ts`）和显式回滚（`rollback.ts`）；
- CLI 的 GitHub 安装与更新（`cli/src/plugin/install.ts`、`cli/src/plugin/host.ts`、`cli/src/tui/runtime/plugin-controller.ts`）；
- VS Code 扩展安装（`lib/plugin/vscode-shim/install-vscode-extension.ts`），以及驱动它的 Open VSX 依赖图；
- 无头 Host 在原生安装之后的对齐（`cli/src/serve/plugin-runtime-adapter.ts`）；
- 配对客户端，其安装和分阶段更新通过 companion RPC 在 Host 上执行（`crates/cognia-companion-rpc/src/rpc/plugins.rs`）。

审计在这些地方发现了同一批缺陷的不同组合：
- 有的安装了审核之外的字节（PL02、PL03、PL12、PL14、PL15）。
- 有的在取消之后继续执行（PL16）。
- 有的把只是加载过、或者用户已停用的插件激活了（PL07、PL18）。
- 有的让数据库行、store 条目或安装来源记录的版本与磁盘上的不一致（PL04、PL05、PL10）。
- 有的在失败后留下停止的运行时或替换到一半的包（PL08、PL09、PL13）。

每次修复都只在本地，没有任何东西阻止下一个环境重犯同样的错误。

## 决定

### 1. 一个操作，五条条款

覆盖安装已有副本、更新和回滚都是同一个操作：**替换已安装的包**。执行它的每个环境都满足以下条款：

1. **身份绑定。** 提交的包就是审核过的那个：插件 ID 相同、版本相同，来源有摘要时摘要也相同（VSIX 的 sha256、GitHub commit、随包目录的文件清单）。不匹配时，在动任何已安装内容之前拒绝。
2. **取消。** 在提交（磁盘上的包发生变化的那一刻）之前响应取消。提交之后，操作把记录补完，并且不报告成功。
3. **运行时状态恢复。** 运行时回到原来的状态，即 `enabled`、`suspended`、`loaded` 或 `stopped` 之一（`lib/plugin/lifecycle/runtime-state.ts`）。替换不是激活一个只是加载过的插件、唤醒一个挂起的插件、或启动一个已停止或已停用插件的理由。
4. **对齐。** 完成后，磁盘上的包、运行时 store 条目、Dexie 行和安装来源描述的是同一个版本。
5. **恢复验收。** 失败绝不报告为成功。提交前失败时，一切保持原样，包括运行时。提交后失败时，只允许两种恢复结果之一：
   - 旧包回来了，运行时要么回到原来的状态，要么已停止并要求重启；
   - 新包保留，记录描述的是新包，运行时已停止，并告知调用方必须重启。

   两者之间的任何状态都不可接受：新包跑在旧记录上、旧字节配新数据库行、或运行时停留在替换到一半的包上继续运行。

### 2. 就绪状态是契约的一部分

准备插件的环境（目前是 Python 依赖）是独立的操作，有自己的授权，不藏在安装里。它的结果是一个就绪状态，由 Host 根据构建环境时记录的信息计算，绝不靠猜测导入名：

| 状态 | 含义 |
| --- | --- |
| `not-required` | 插件没有声明环境。 |
| `not-prepared` | 从未为这个包构建过环境。 |
| `needs-uv` | 插件带锁（`uv.lock`）且未安装 uv；不会退回到无锁安装。 |
| `stale` | 环境是按其他依赖、其他锁或其他解释器构建的。 |
| `preparing` | 正在准备。 |
| `ready` | 环境与包匹配。 |
| `failed` | 上一次准备失败。 |
| `user-managed` | 用户自己运行解释器，不使用托管环境；不检查就绪。 |

解释器不满足插件要求时，增加一条警告（`interpreterWarning`），不阻止运行。这些状态在方案的 P3 中实现；本 ADR 先固定词汇。

### 3. 条款是数据，由各环境的测试框架运行

`lib/plugin/lifecycle/contract.ts` 以数据形式保存契约：

- `REPLACEMENT_SCENARIOS`：每一种原运行时状态，外加身份不匹配、提交前失败、提交后失败和取消；
- `contractViolations(scenario, versions, observed)`：某次观察违反了哪些条款；
- `CONTRACT_GAPS`：某个环境尚未补齐的条款，每条附原因；
- `NOT_YET_CONFORMING`：还没有运行这套用例的环境。

每个环境用已有的测试框架运行 `scenariosFor(environment)`，观察结果、磁盘上的包、它的记录以及之后的运行时。这样适配代码就挨着它所测试的代码。共用一个测试框架则要把每个环境的外部依赖重新 mock 一遍。`contract.test.ts` 固定这两份清单，所以补齐一个缺口或新增一个环境时，要同时修改本 ADR、该模块和测试。

### 4. 各环境现状

| 环境 | 身份 | 取消 | 运行时状态 | 对齐 | 恢复 | 运行用例 |
| --- | --- | --- | --- | --- | --- | --- |
| 桌面端注册表更新（`updater.ts`） | 是 | **否**：`installUpdate` 不接收取消信号 | 是 | 是 | 旧包回来，运行时已停止，要求重启 | `updater.test.ts` |
| 桌面端回滚（`rollback.ts`） | 是 | 否 | 是 | 是 | 恢复安全快照 | 尚未 |
| CLI 更新（`plugin-controller.ts`） | 是 | 是 | 是 | 是 | 新包保留，运行时已停止，要求重启 | `plugin-lifecycle.integration.test.ts` |
| VS Code 扩展安装 | 是 | **否**：取消即不提交已暂存的依赖图 | 是 | 是 | 旧包、数据库行、条目和来源恢复，运行时回到原状态 | `install-vscode-extension.test.ts` |
| 无头 Host 对齐 | 不适用（原生安装已执行） | 不适用 | **否**：总是启用 | 部分 | 无 | 尚未 |
| 配对客户端（经由 Host） | 各 RPC 命令未验证 | 未验证 | 由 Host 负责 | 由 Host 负责 | 由 Host 负责 | 尚未 |
| Capacitor 镜像 | 只读 | — | — | 只有“已排队”与“已生效”的标注 | — | 尚未 |

## 影响

- 新的会替换包的环境，或新的失败方式，都先在 `contract.ts` 里加一个场景或缺口。代码评审因此看到的是契约变更，而不是一处本地修复。
- 两个取消缺口是显式的。补齐它们的办法是给 `installUpdate` 和 VS Code 提交在提交前加一个取消点，然后删除对应的缺口条目。
- 回滚在其数据快照（方案 P1）落地后加入用例，因为恢复插件数据会成为它恢复条款的一部分。
- 无头 Host 和配对客户端最后对齐（方案 P5）。在此之前，它们留在 `NOT_YET_CONFORMING`，并记录各自仍有的行为。
- 本契约约束的是宿主的行为，不改动插件契约（`@cognia/plugin-contract`），因此不影响创作工具包的固定版本。
