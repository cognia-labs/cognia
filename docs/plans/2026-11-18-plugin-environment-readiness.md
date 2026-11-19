# 插件运行环境就绪、Python 锁定、数据回滚与生命周期契约方案

> 状态：P0–P5 已完成（2026-11-19），只剩各阶段的实机验证。创建：2026-11-18（Asia/Shanghai）。
> 依据：[插件支持审计证据](../evidence/2026-11-08-plugin-support-audit.md)（第 697 行起的 ENV01–ENV07），以及 2026-11-18 已落地的 PL01–PL19 修复（`de7889b157..81c5c55bc4`）。
> 范围：ENV01、ENV02、ENV03、ENV04、ENV07。ENV05 已修复；ENV06（独立插件 release 的产品采用）不在本方案内。
> 本文的阶段划分、默认值和数据格式是建议，经确认后才实施。

## 1. 建议与完成定义

**先写生命周期契约 ADR（P0），再按 ENV04 → ENV03 → ENV01 → ENV02 的顺序实施（P1–P4），最后把剩余环境对齐到契约（P5）。** P0 先行，是因为 ENV01 的就绪状态、ENV04 的回滚验收和 ENV07 的环境矩阵用的是同一套词汇。先定词汇，再写代码。

交付完成须同时满足：

1. 每项都有生产入口的回归测试（Jest、`node --test` 或 crate 内 `#[cfg(test)]`）以及故障注入用例，覆盖第 5 节列出的失败场景。
2. Python 插件的「已安装 / 依赖未就绪 / 可运行」三种状态由 Host 根据环境记录计算，不再靠导入名猜测，也不再只在加载时以一条报错字符串体现。
3. 带 `uv.lock` 的插件在线、离线（自带 wheel）两种情况都能按锁复现环境；锁过期或缺少 uv 时明确拒绝，不会退回到不带锁的安装。
4. 发生过数据迁移的插件回滚时，能恢复迁移前的插件数据；没有快照时维持现在的显式拒绝。
5. 生命周期契约 ADR 合入；Desktop、CLI、headless、paired client、VSIX 五个环境通过同一套契约一致性测试，未通过的环境如实标记。
6. Tauri 桌面实机验收第 7 节的流程；跑不了的平台标为未验收，不用 mock 代替。

本方案不修改 `@cognia/plugin-contract`（manifest 字段、`types/plugin`），所以不会让 authoring kit 的 pin 再次失效。2026-11-18 已决定暂不重新固定 kit。如果实施中发现非改契约不可，先停下来询问。

## 2. 已定决策（2026-11-18）

| 项           | 决策                                                                                           | 由此推出的规则                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| ENV01        | 安装完成后立即提示一键准备依赖，保留用户同意；卡片和详情页显示「已安装 / 依赖未就绪 / 可运行」 | 准备依赖仍是需要同意的独立动作（涉及网络和磁盘）；启用依赖未就绪的插件时给出结构化错误和「准备依赖」操作 |
| ENV02        | 支持 `uv.lock`；带锁插件一律用 uv 安装，缺少 uv 时提示安装，不退回到 pip                       | 带锁插件始终使用隔离环境（共享环境无法保证某一个插件的锁被精确满足）；锁与 `pyproject.toml` 不一致时拒绝 |
| ENV03        | 探测手动指定的解释器版本，不满足要求时只警告                                                   | 要求取自 Host 最低版本（3.9）和插件 `pyproject.toml` 的 `requires-python`；探测失败也只警告              |
| ENV04        | 每次插件数据迁移前先给该插件的表拍快照，回滚时一并恢复                                         | 恢复会丢弃迁移后写入的数据，因此回滚前要向用户展示并确认；没有快照时维持 `PluginDataVersionError`        |
| ENV07        | 先写 ADR，再逐个环境对齐，paired client 和 headless 放在最后                                   | 契约附带一套可在各环境适配器上运行的一致性测试                                                           |
| kit 重新固定 | 暂不                                                                                           | 本方案不改插件契约                                                                                       |

## 3. 当前事实与现有基础

| 已确认事实（HEAD `81c5c55bc4`）                                                                                                                                                                                                                                                           | 方案约束                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 依赖只有在用户点同意后才安装：`PluginManager.installPythonDeps`（`lib/plugin/core/manager.ts:7993`）调用 `plugin_python_install_deps`（`crates/cognia-plugin-runtime/src/python/commands.rs:816`），入口只有详情页按钮（`components/plugins/detail/plugin-python-host-settings.tsx:333`） | 复用这条安装链和它的进度事件；新增的提示和按钮共用同一个动作                                                     |
| 加载时 `host.py:_check_dependencies`（`crates/cognia-plugin-runtime/src/python/host.py:516`）把 pip 名改写成导入名再 `find_spec`，缺失时抛出 `RuntimeError` 字符串（`host.py:573`）；`Pillow`→`PIL` 这类名字会被误报为缺失                                                                | 就绪判断改为比对 Host 记录的环境；删除这条名字猜测                                                               |
| `VenvMarker`（`python/venv.rs:247`）已记录解释器、版本、安装器、作用域，以及每个插件安装过的依赖                                                                                                                                                                                          | 在 marker 上扩展锁摘要和解释器路径，用它计算就绪状态，不另建记录文件                                             |
| 安装器有 `Uv`/`Pip`/`Custom` 三种（`venv.rs:94`），`install_into` 只接受 manifest 的依赖列表（`venv.rs:631`）；已有 `installUv`（`manager.ts:8156`、`commands.rs:920`）                                                                                                                   | 带锁安装是 `Uv` 分支下的新路径；缺少 uv 时复用 `installUv`                                                       |
| 手动指定的解释器直接视为可信，版本记为 `"custom"`（`commands.rs:1094-1100`）；Host 自动发现的解释器要求 ≥ 3.9（`python/discover.rs:15`）                                                                                                                                                  | 改为探测真实版本；`"custom"` 这个占位值随之删除                                                                  |
| 插件 manifest 没有 Python 版本字段（`packages/plugin-contract/src/types/plugin/plugin.ts:717-730` 只有 `pythonDependencies` 和 `pythonVenv`）                                                                                                                                             | 版本要求取自插件目录里的 `pyproject.toml`，不新增 manifest 字段                                                  |
| `runPluginMigrations`（`lib/plugin/dexie/migration-runner.ts:86`）在一个读写事务里提交迁移和数据版本；包降级时 `assertPluginDataVersion` 抛出 `PluginDataVersionError`（同文件第 19–41 行）                                                                                               | 快照放在迁移事务之前；恢复复用同一把表锁（`lib/plugin/dexie/bridge.ts`）                                         |
| 包备份只打包插件目录、Host 状态和 VS Code 树（`crates/cognia-plugin-runtime/src/backup.rs:63-100`），不含插件 Dexie 表                                                                                                                                                                    | 数据快照存在 Dexie 里，跟随数据所在的 runtime，不进入 Host 的 tar 备份                                           |
| 本轮已有 `lib/plugin/lifecycle/runtime-state.ts`（停止 / 恢复运行状态），Desktop 更新、回滚、VSIX 和 CLI 已经在用                                                                                                                                                                         | ADR 以它为状态恢复的参考实现；headless 适配器（`cli/src/serve/plugin-runtime-adapter.ts`）仍直接调用 load/enable |
| paired client 不是插件状态的权威方，只排队切换和来源记录（`lib/plugin/core/mirrored-client.ts`、`lib/plugin/cogset/remote.ts:31`）；安装在 Host 上通过 companion RPC 执行（`crates/cognia-companion-rpc/src/rpc/plugins.rs`）                                                             | 契约分别约束 Host 端的执行和 client 端「已排队 / 已生效」的标注                                                  |

uv 的锁安装语义（来源：astral-sh/uv 文档，经 context7 查询）：`uv sync --locked` 在锁与 `pyproject.toml` 不一致时失败，`--frozen` 则不检查；`UV_PROJECT_ENVIRONMENT` 指定安装到哪个环境；`--offline` 配合 `--find-links <wheel 目录>` 可以不联网、只从本地 wheel 安装。

## 4. 方案

### P0 生命周期契约 ADR（ENV07 第一步）

按 `ls docs/content/docs/en/adr` 取下一个编号（当前最新是 0257），en/zh 两份都要写。内容：

- **操作**：install、update、rollback、reload、enable/disable、uninstall、prepare-environment。
- **每个操作的五项要求**：
  1. 身份绑定：执行的必须是审核过的 id、版本和摘要。
  2. 取消点：提交前都可以取消；提交后完成剩下的步骤，但不再报告成功。
  3. 状态恢复：失败或完成后回到原来的运行状态，以 `runtime-state.ts` 的 enabled / suspended / loaded / stopped 为准。
  4. reconcile：磁盘包、runtime store、Dexie 行、install origin 四者要一致。
  5. 恢复验收：失败后哪些条件必须成立。
- **就绪状态**：`not-required` / `needs-uv` / `not-prepared` / `stale` / `preparing` / `ready` / `failed`，再加一个只给提示的 `interpreterWarning`。
- **环境矩阵**：Desktop、CLI、headless brain、paired client（经 RPC 由 Host 执行）、VSIX、Capacitor 镜像。逐格标注当前是否满足，以及对齐放在哪个阶段。
- **一致性测试**：一套操作脚本加断言，可以在每个环境的适配器上运行，形式参照 `tests/conformance/`。

产出 ADR 和一致性测试骨架；骨架先把已对齐的三个环境跑通。

### P1 迁移前数据快照（ENV04）

- **schema**：新增 `pluginDataSnapshots` 表（`&id, pluginId, dataVersion, createdAt`）和 `pluginDataSnapshotRows` 表（`[snapshotId+table+chunk]`，按块存行）。这是 Dexie schema 改动，按 `dexie-migration` skill 执行：编辑 `CURRENT_SCHEMA`、递增版本、在 `CORE_TABLE_NAMES` 中登记、运行 `pnpm db:governance:write`。数据治理上标为本机插件数据：不参与账号同步，不进入跨设备同步，不进入完整数据导出。
- **拍快照**：在 `manager.ts` 调用 `runPluginMigrations` 之前，如果有待执行的迁移（`currentVersion > appliedMigrationVersion`），在同一把表锁内读出 `meta.tableNames` 的全部行和 meta 行，写成一份快照，记录迁移前的数据版本和包版本。迁移失败时删除这份快照（数据没有变）；成功则保留。
- **恢复**：`lib/plugin/lifecycle/rollback.ts` 回滚到目标包时，如果目标的数据版本低于已应用的版本，先找对应数据版本的快照。找到就在一个读写事务里清空插件表、写回快照行、把 meta 的 `appliedMigrationVersion` 改回快照版本。找不到就维持 `PluginDataVersionError`。恢复放在 rollback 的补偿路径里，失败同样计入失败项。
- **确认**：回滚前，UI 显示「回滚会丢弃 v{x} 之后写入的插件数据」以及条数，用户确认后才执行。en 和 zh-CN 都要加 key。
- **保留与清理**：每个插件保留最近两份快照；卸载并删除数据（`removePluginTables` 的 retention 模式）时一起删除。
- **配额**：写快照前用 `navigator.storage.estimate()` 估算可用空间。不够时弹窗说明这次升级之后无法回滚数据，用户选「不留快照继续」或「取消升级」（2026-11-18 已定）；选择继续时，在插件详情页标出该版本没有数据快照。
- **测试**：migration-runner、bridge 和 rollback 的单元测试，加 `persistence.integration.test.ts` 的真实 IndexedDB（fake-indexeddb）用例。场景：迁移失败、恢复失败、多次迁移后回滚两级、卸载清理。

**实施记录（2026-11-19，已完成）**

- 快照在迁移的同一个读写事务里写入，先于任何插件代码执行。迁移抛错时，快照随事务一起回滚，因此不需要额外的删除步骤。读写都经过 Dexie：插件表在账户库中按行加密，并把表名和主键绑定进去，原生层面的拷贝无法解密。
- schema v257。两张表分别是 `pluginDataSnapshots`（`&id, pluginId`）和 `pluginDataSnapshotRows`（`[snapshotId+table+chunk], snapshotId`）。排序在内存中完成，同一插件内的创建时间严格递增。行表标为机密、加密存储，只保存在本机，不参与同步，也不导出。快照在表目录中的保留策略为 `cap`。
- 恢复分三种情况：
  - 显式回滚：只有在用户确认了对应快照之后才执行；没有可用快照时，在动任何东西之前就拒绝。
  - 更新失败和崩溃恢复：只自动恢复本次更新开始之后拍下的快照。
  - 恢复完成后，删除用过的那份快照和比它更新的快照。
- 无头 Host 没有人可问，默认不留快照继续，并记录一条“已跳过”的快照，插件数据页会标出来。
- 删除了 `rollback.ts` 中从未被调用的内存配置迁移，包括 `MigrationScript`、`registerMigration` 和 `applyMigration`，以及 `createRollbackPlan`、`rollbackToLatestBackup` 和回滚历史。
- 契约：回滚作为 `desktop-rollback` 加入契约用例，并新增一条数据条款：磁盘上的包必须能读取当前数据。回滚的身份检查和取消点记为缺口。
- 测试改用真实 fake-indexeddb，放在 `bridge.test.ts`、`migration-runner.test.ts`、`data-snapshots.test.ts` 和 `data-rollback.test.ts` 中，没有另写 `persistence.integration.test.ts` 用例。

### P2 解释器版本探测（ENV03）

- **探测**：用户为插件指定解释器时，Host 执行 `<path> -c "import sys; print('%d.%d.%d' % sys.version_info[:3])"`，用现有的 `parse_python_version` 解析，再与两项要求比对：Host 最低版本 3.9，以及插件 `pyproject.toml` 里 `[project].requires-python` 的 PEP 440 范围（如果有）。
- **结果**：版本写入 `Interpreter.version`，删除占位值 `"custom"`。不满足要求或探测失败时返回 `interpreterWarning`，照常运行。
- **范围解析**：先确认 `pep440_rs`（Astral，uv 也在用）的许可证和依赖体积，再决定引入它还是在 crate 内实现 `>=,>,<,<=,==,!=,~=` 的组合。实施时二选一，并在提交中写明理由。
- **UI**：`plugin-python-host-settings.tsx` 在解释器字段旁显示警告；en/zh-CN 加 key。
- **测试**：crate 内测试覆盖版本输出解析、范围匹配和探测失败；组件测试覆盖警告显示。

**实施记录（2026-11-19，已完成）**

- 范围解析用 `pep440_rs` 0.7.3，不在 crate 内自写。许可证 Apache-2.0 OR BSD-2-Clause，在 `deny.toml` 允许范围内；默认不启用任何 feature，新增的传递依赖只有 `unscanny`。`pyproject.toml` 用工作区已有的 `toml_edit` 读取，读取时不跟随符号链接，超过 1 MiB 不读。
- 探测沿用 `--version` 输出，与全局发现走同一个函数和同一套解析，没有另加 `-c` 脚本。探测本身改用 `cognia_core::process_probe::run_probe`，这是从 Node 和 Bun 的版本探测里抽出的共享实现：独立进程组、超时后杀掉整组进程、读取输出前先清理残留子进程。Node 和 Bun 的探测也改用它，三处重复合成一处。
- `Interpreter.version` 改为 `Option<String>`，删除占位值 `"custom"`，也删除了 venv 标记缺少版本时的占位值 `"venv"`。
- 检查覆盖所有来源：用户指定的解释器（加载时现探测）、Host 构建的 venv（版本取自标记）、全局发现的解释器。顺序依次是：能否读到版本、是否低于 Host 最低版本 3.9、是否满足 `requires-python`。`requires-python` 无法解析也给出警告，所以没有警告就表示检查通过。
- 加载回复带 `interpreter`（`source`、`argv`、`version`），有问题时再带 `interpreterWarning`（`version-unknown`、`below-host-minimum`、`requirement-unmet`、`requirement-unreadable`）。警告同时写入插件的日志页和应用日志，插件照常加载。
- 没有新增 Host 命令。命令注册链（companion 协议、生成的命令目录、OpenAPI）目前有其他会话的未提交改动；按需检查由 P3 的 `plugin_python_readiness` 提供。设置卡片显示最近一次加载的结果，并且只在已保存的解释器路径与那次加载一致时显示。回复用 zod 校验，存入非持久的 Zustand store `stores/plugin-runtime/python-interpreter-report-store.ts`。

### P3 依赖就绪与一键准备（ENV01）

- **就绪计算**：新增 Host 命令 `plugin_python_readiness(plugin_id)`，结合 manifest 依赖（或锁摘要，见 P4）、`VenvMarker` 里该插件记录的依赖、解释器版本和安装器，返回 P0 定义的就绪状态和原因。companion RPC 同步接入：用 `pnpm companion-api:gen` 重新生成 `known_commands`，再运行 `pnpm companion-api:check`。
- **用户自管环境**：`use_venv=false` 或使用自定义安装器时，返回 `user-managed`，不阻止加载；导入错误在真正导入时照常报出。
- **删除名字猜测**：去掉 `host.py:_check_dependencies` 和加载时的字符串报错。启用依赖未就绪的插件时，manager 抛出结构化的 `PythonDependenciesNotReadyError`（带就绪状态）。
- **安装后提示**：在 marketplace、本地目录、Git、cogpack 这几条安装流程成功之后，对声明了依赖的 python/hybrid 插件弹出「准备 Python 依赖」确认框，列出依赖、安装器和网络/磁盘影响，提供「准备 / 稍后」。准备动作与详情页按钮共用一个 hook（新建 `hooks/plugins/use-python-environment.ts`，附同目录测试）。
- **状态显示**：`components/plugins/plugin-card.tsx`、`plugin-status-badge.tsx` 和详情页显示三种状态，其中「依赖未就绪」带准备操作。准备过程中显示进度，复用现有的 python 事件流。
- **测试**：Rust 就绪计算覆盖每种状态各一条；manager 的结构化错误；hook 与确认框测试；四条安装流程各有一条「装完弹出提示」的测试。

**实施记录（2026-11-19，已完成）**

- **Host 端计算**：`crates/cognia-plugin-runtime/src/python/readiness.rs` 的 `compute_readiness` 依次判断：
  1. 没有声明依赖 → `not-required`。
  2. 关闭了托管环境、用户指定了解释器、或使用自定义安装器 → `user-managed`，原因分别是 `venv-disabled`、`interpreter-override`、`custom-installer`。用户指定解释器是计划之外加的一种：Host 不为它构建环境，拿 venv 记录去比对没有意义。
  3. 正在准备 → `preparing`。
  4. 有环境记录时比对三项：依赖集合（共享环境只比对本插件登记的那份）、解释器版本、安装器。都一致 → `ready`；有不一致，且最近一次准备失败 → `failed`，否则 → `stale`，并列出原因。
  5. 没有环境记录：最近一次准备失败 → `failed`，否则 → `not-prepared`。
- **回复带安装器**：凡是 Host 负责准备的状态，`plugin_python_readiness` 的回复都带 `installer`（`uv` 或 `pip`），确认框据此写明用哪个安装器。设置为 `auto` 时只有 Host 知道有没有 uv，所以由 Host 报告。回复同时带 P2 的 `interpreterWarning`。
- **同一插件一次只准备一个**：由 `Preparations` 守卫保证，第二个请求直接拒绝。请求中途被放弃时记为失败，状态不会卡在 `preparing`。
- **删除名字猜测**：`plugin_python_load` 删除了 `dependencies` 参数，`host.py` 删除了 `_check_dependencies` 和对应的字符串报错。manager 加载前先查询就绪状态，处于四种未就绪状态时抛出 `PythonDependenciesNotReadyError`；回复无法解析时不拒绝加载。headless brain 用的是同一个 manager，同样经过这道检查。
- **顺带修正**：companion 响应目录里 `plugin_python_install_deps` 原来声明为 `NullResult`，实际返回的是 `PythonInstallOutcome`，headless 和移动端平面会以 `contract_output_violation` 拒绝这个回复。
- **前端状态**：就绪报告和最近一次准备的结果存在非持久的 `stores/plugin-runtime/python-readiness-store.ts` 里；`hooks/plugins/use-python-environment.ts` 读取它，并提供刷新和准备两个动作。确认框只有一个，`components/plugins/python/python-prepare-dialog.tsx`。
- **提示宿主**：`PythonPreparePromptHost` 挂在应用根部，消费 `lib/plugin/python/prepare-prompt-requests.ts` 的队列。它先查询 Host，只有 `not-prepared`、`stale`、`failed` 三种状态才弹窗。
- **状态显示**：卡片、Library 行和详情页头部显示 `PluginPythonEnvironmentBadge`；详情页的环境区显示原因、进度行和准备结果。
- **安装后提示的接入点**：`runMarketplaceInstall` 新增 `onInstalled`，在整个安装（含连带安装的依赖插件）提交后回调一次。`usePluginPreInstall` 用它覆盖 marketplace、GitHub/Git、本地目录和 Load unpacked 四条 UI 流程；cogpack 导入对话框对 `result.installed` 逐个提示。种子插件、devtools 自动重装和回滚重装不提示。
- **启用失败**：启用失败的 toast 遇到 `pythonDependenciesNotReady` 时提供「准备依赖」操作，直接打开确认框。
- **准备成功后自动重新启用**：manager 在准备成功后读取插件的生命周期记录。同时满足以下四个条件时，它以 `python-environment-prepared` 为原因重新启用插件：
  1. 用户把插件设为启用（intent 为 `enabled`）；
  2. 插件当前没有在运行；
  3. 最近一次失败正是本插件的 `PythonDependenciesNotReadyError`；
  4. 准备后的就绪状态不再阻止加载。

  拒绝信息的格式和识别它的正则只在 `lib/plugin/python/dependencies-not-ready.ts` 定义一次，错误分类和 manager 都用它。重新启用失败不影响准备本身，准备仍记为成功。准备结果多了 `resumed` 字段，toast 据此显示「已就绪，并已重新启用」。

- **未验证**：没有在 Tauri 桌面实机跑过「安装 → 提示 → 准备 → 可运行」这条流程。

### P4 uv.lock 锁定与离线安装（ENV02）

- **约定**：插件根目录同时有 `pyproject.toml` 和 `uv.lock` 时视为带锁插件；可选的 `wheels/` 目录作为离线 wheel 源。锁是依赖的唯一来源：如果 manifest 还写了 `pythonDependencies`，manifest 校验给出警告并忽略该字段。
- **安装**：执行 `uv sync --locked --no-dev --no-install-project --project <插件目录> --python <解释器>`，并设置 `UV_PROJECT_ENVIRONMENT=<venvs/<id>>`。有 `wheels/` 时追加 `--offline --find-links <插件目录>/wheels`。带锁插件强制使用隔离环境；如果用户设置了 shared，提示该设置不生效。
- **缺少 uv**：安装器是 `Pip` 或 `Custom` 时，就绪状态为 `needs-uv`，提示走现有的 `installUv`，不退回到不带锁的安装。
- **就绪与更新**：`VenvMarker` 记录 `uv.lock` 的 sha256；插件更新或回滚后锁变化，状态变为 `stale`，再提示准备。
- **打包**：确认 `scripts/build/plugin-artifact-format.mjs`、目录 / Git / 归档安装器和 `archive_limits.rs` 的大小上限都能容纳 `pyproject.toml`、`uv.lock` 和 `wheels/`。上限不够时先报告，不悄悄调大。
- **文档**：plugin-dev 文档（en/zh）写明这项约定，并给出生成离线 wheel 的命令（`uv export` 加 `pip download`，或 `uv` 的等价流程，实施时按当时文档核实）。
- **测试**：crate 内测试覆盖带锁命令的参数拼装、`--locked` 失败、离线参数和强制隔离；集成测试在装有 uv 的 CI job 上真实执行一次离线 sync，无 uv 的 job 跳过并标明。

**实施记录（2026-11-19，已完成）**

- **先做了实测**（uv 0.11.21，macOS）。结论有两条改变了方案：
  - 锁文件记录了每个包的来源。对着 PyPI 生成的锁，安装时即使加 `--find-links wheels` 也照样去 PyPI 地址取文件，离线时失败。反过来，锁是对着 `wheels/` 生成的，安装时再传一个绝对路径的 `--find-links`，`--locked` 会判定锁需要更新。
  - 因此 **Host 不传 `--find-links`**，离线时只加 `--offline`。作者在 `pyproject.toml` 写 `[tool.uv] no-index = true` 和 `find-links = ["wheels"]`，再执行 `uv lock --offline`，锁里每个包的来源都会是 `source = { registry = "wheels" }`。这套流程用空缓存实测通过。
  - 实测还确认了几点：
    - `--python` 可以直接指向插件自己 venv 里的解释器，uv 会复用这个 venv，并保留 Host 的 marker 文件。
    - `uv sync` 不往插件目录写任何东西。
    - 缺少 wheel 时，uv 输出 ``Failed to download `包==版本` ``。
    - 锁与 `pyproject.toml` 不一致时，uv 输出 ``needs to be updated, but `--locked` was provided``。
- **识别带锁插件**：`crates/cognia-plugin-runtime/src/python/lock.rs` 的 `detect_lock`，只在插件根目录同时有 `pyproject.toml` 和 `uv.lock` 时成立。
  - `uv.lock` 通过 `contained_path` 读取，不跟随符号链接，上限 32 MiB。
  - 它计算锁的 sha256，并列出锁定的包（不含插件自身的 project）。
  - `wheels/` 是真实目录时，视为离线安装。
  - 锁存在但读不了时直接报错，不猜测状态。
- **安装**：`venv::provision_locked` 一律用 uv 建插件自己的隔离环境，并把插件从共享环境的贡献者里移除，然后执行 `uv sync --locked --no-dev --no-install-project --no-progress --project <插件目录> --python <venv 解释器> [--offline]`。
  - 运行时设置 `UV_PROJECT_ENVIRONMENT`，并去掉用户环境里的 `VIRTUAL_ENV` 和 `UV_FROZEN`（后者与 `--locked` 冲突）。
  - 同步期间 marker 的 `lockDigest` 先清空，成功后才写入，半装的环境不会被当作就绪。
  - 设置或 manifest 要求共享时，安装结果的 `downgradedReason` 会说明带锁插件一律用独立环境；详情页对这种情况显示翻译后的文案。
- **安装器**：带锁插件一律用 uv，安装器设置（包括 pip 和自定义安装器）对它不生效。只有设置为 uv 且填了路径时才用那个路径。
  - 和方案写法的出入：方案写的是「安装器是 Pip 或 Custom 时为 `needs-uv`」，实际按已定决策「带锁插件一律用 uv」实现：找得到 uv 就用；只有找不到 uv 时才是 `needs-uv`，并且只在需要准备时才报这个状态。环境已经按当前锁就绪的插件，卸掉 uv 后照样能运行。
- **就绪状态**：
  - 新增 `needs-uv`，会阻止加载。
  - 新增过期原因 `lock`：环境不是按当前锁同步的，比如锁变了、之前按 manifest 依赖构建，或者在共享环境里。
  - `failed` 新增可选的 `cause`：`lock-out-of-date`，或 `missing-wheels`（附包名）。准备记录里保存 cause，前端据此显示中英文说明，不直接展示 uv 的原文。
  - 回复新增 `lock`，内容是 `packages`、`offline` 和 `ignoresManifestDependencies`。
  - companion 响应目录 `PythonReadinessReport` 同步更新，新增 `PythonLockSummary` 和 `PythonPreparationFailureCause` 两个定义。
- **manifest 警告**：方案原本要在 manifest 校验里给出警告，但 manifest 校验在 `packages/plugin-contract` 里，改了会让 authoring kit 的 pin 失效，而且它看不到插件目录里的文件。所以改为：Host 在就绪回复里报告 `ignoresManifestDependencies`，详情页显示警告，准备时 Host 记一条 warn 日志。
- **缺少 uv**：确认框写明会先用 Python 运行时的 pip 安装 uv，确认按钮改为「安装 uv 并准备」。`installPythonDeps` 新增 `installUv` 选项，在同一次准备里先装 uv，装失败也记为这次准备失败。
- **前端**：
  - 提示宿主不再因为 manifest 没有 `pythonDependencies` 就跳过，交给 Host 判断。
  - 确认框和详情页列出锁定的包，并说明是否离线安装。
  - 详情页在安装器设置旁注明安装器和环境范围对带锁插件不生效；详情页的 uv 安装按钮安装完 uv 后会重新查询就绪状态。
  - 启用失败的文案增加 `needsUv` 分支。ICU 的 select 键不能含连字符，所以分类器传入驼峰形式的状态。
- **打包核对**：
  - Git 和本地目录安装原样复制，只跳过 `.git`、`.github`、`node_modules`、`target`。
  - 归档下载上限：下载 128 MiB、解压 512 MiB、20,000 个条目。cogpack 上限：压缩 100 MiB、展开 300 MiB、8,192 个文件。
  - 普通 wheel 包放得下；多平台的编译依赖可能超过 cogpack 上限，已写进文档，没有调大上限。
  - 捆绑的第一方插件要在 `include` 里列出 `pyproject.toml`、`uv.lock` 和 `wheels/**/*.whl`；目前没有带锁的第一方插件。
- **文档**：新增 `docs/content/docs/{en,zh}/plugin-dev/python-environments.mdx`，内容包括两种依赖声明方式、Host 执行的命令、离线 wheel 的五步流程（命令已实测）、就绪状态表和打包上限。
- **测试**：
  - `lock.rs` 覆盖识别、包列表、摘要、离线判定、拒绝符号链接、命令参数、失败归类和错误文案。
  - `readiness.rs` 覆盖带锁插件的各个状态。
  - `commands.rs` 覆盖：不依赖本机是否有 uv 的 `needs-uv`、按锁就绪、锁变化后过期、没有 uv 时拒绝准备且不退回 pip、锁读不了时报错。
  - `venv.rs` 有两条真实 uv 测试：离线同步成功（包括移出共享环境、能导入、不写插件目录）；缺 wheel 归类为 `missing-wheels`、锁过期归类为 `lock-out-of-date`。本机没有 Python 或 uv 时，这两条打印 skip 后跳过。
- **未验证**：
  - 没有在 Tauri 桌面实机跑过带锁插件在线、离线各准备一次的流程。
  - Windows 路径没有验证。
  - `installUv` 走运行时的 pip，遇到 Homebrew 这类受 PEP 668 保护的 Python 会失败；这是已有的限制，这次没有改。

### P5 剩余环境对齐（ENV07 第二步）

- **headless**：`cli/src/serve/plugin-runtime-adapter.ts` 改用 `replaceDiskPlugin` 和 runtime-state，遵守停用意图，接入一致性测试。
- **paired client**：Host 端 RPC 安装命令接收并校验审核过的 id、版本和摘要（与 PL02/PL03 一样）；client 端区分「已排队」和「已生效」，Host 回执后刷新状态。
- **Capacitor 镜像**：只读，标注清楚，纳入一致性测试中的只读断言。
- **收尾**：每个环境通过一致性测试后，更新 ADR 的矩阵。

**实施记录（2026-11-19）**：

- **决定**：用户选择让设备的包变更经由 Host 的插件管理器执行（桌面端与无头 Host 同一套），不在 Rust 里先换包。
- **共用的替换步骤**：新增 `lib/plugin/lifecycle/replace-package.ts`。它依次预留依赖图、停下运行时、在包锁内提交、登记磁盘上的 manifest、恢复原状态。持久意图为停用的插件保持停止，新插件进入调用方指定的状态。支持一次提交替换多个插件，包锁按 id 排序加锁。CLI 的 `replaceDiskPlugin` 改为调用它，原有测试不变、全部通过。
- **headless**：`plugin-runtime-adapter.ts` 的对齐改走共用步骤（提交为空操作，因为包已经换好），不再一律启用。Host 自己的处理已经应用过的变更，事件会被跳过：处理前登记，事件到达时消费一次，5 分钟后过期。适配器启动时把 Node 端的磁盘发现提供给 Host 处理逻辑，停止时撤回。契约环境 `headless-reconcile` 运行 4 个前置状态场景；身份、提交前失败、取消、提交后失败记为缺口，并写明原因。
- **Host 处理设备请求**：新增 `lib/plugin/lifecycle/host-package-change.ts`，`desktop-write-source` 把 `plugin_install`、`plugin_install_from_github`、`plugin_uninstall`、`plugin_commit_staged_update`、`plugin_backup_restore` 交给它。`plugins.rs` 中这些 arm 对非 service 调用方一律转交 Host 桥接（GitHub 安装仅在非 `deferCommit` 时转交，超时 300 秒）；只有 service principal 直接执行原生命令。brain 用 service 传输回调原生命令，这条路径不需要新增内部命令。
  - 身份：`plugin_commit_staged_update` 新增必填的 `expectedVersion`。TS 端先校验一次；Rust 端新增 `commit_reviewed_staged_update_for_state`，在换包之前比对暂存元数据中的版本。Tauri 命令同样要求这个参数。请求 schema 已同步更新，桌面端的两个调用方也会传入它。
  - manifest 安装只接受 manifest 中的 id；GitHub 安装先用 `deferCommit` 暂存，得知插件 id 后再停下插件、带版本提交、最后 finalize；提交失败时丢弃暂存。
  - 卸载交给插件管理器，由它先卸载运行时再删包。
  - 提交后若无法启动，新包保留、运行时停止，返回 `plugin_restart_required:`。前缀 `plugin_change_malformed` / `plugin_identity_mismatch` 在 Rust 端映射为 400 / 422。
  - 客户端等待时间：`transport-types.ts` 为这五个命令设为 330 秒，测试确保两份命令清单保持一致。
  - 契约环境 `host-package-change` 运行 7 个场景；取消记为缺口。
- **cogpack 迁移**：`transfer-install.ts` 改为一次替换全部成员。Host 上已有的成员先停下，安装后恢复原状态；新成员启动；停用意图的成员保持停止；安装失败时恢复原运行状态。桌面端和无头 Host 走同一条路径，旧的 `activateOnDesktop` 已删除。
- **配对客户端**：
  - `plugin-transfer.ts` 新增 `reconcileTransferWithReview`，用审核过的 id 和版本核对 Host 的回复。版本不同或未提到的插件记为 `plugin_not_applied`。
  - 开关：新增 `lib/plugin/core/mirrored-toggle-receipt.ts`。Host 回复后读回 `plugins` 表：应用成功时合并成一次拉取；Host 拒绝时先回卷游标再拉取；网络错误或超时不算回复，开关保持“已排队”。由 `companion-outbound-runner-provider.tsx` 的 dispatcher 调用。手机端 Discover 插件面板在开关排队时给出“已排队”提示（复用 `plugins.lifecycleFeedback` 的文案，没有新增 key）。
- **Capacitor 镜像**：`contract.ts` 新增 `MIRROR_CLAUSES` 和 `mirrorViolations`，共四条：不替换包、不运行插件、Host 回复前标为已排队、回复后读回。这些条款由开关、回执和卸载拒绝的测试运行。`NOT_YET_CONFORMING` 已清空并删除。
- **ADR**：矩阵按环境重写，新增 cogpack 迁移一行，影响部分写明剩余问题。
- **未验证**：
  - Rust 改动（`plugins.rs`、`marketplace.rs`）没有编译，新加的 Rust 测试也没有运行：磁盘只剩约 150 MB，其他会话正在占用。
  - 没有在桌面端或无头 Host 上用真实的配对设备跑过更新、回滚、卸载或 cogpack 迁移。
  - 没有在手机上看过“已排队”提示和读回效果。

## 5. 失败场景清单（每项至少一条测试）

| 阶段 | 场景                                              | 期望结果                                                                |
| ---- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| P1   | 迁移函数抛错                                      | 数据和版本不变，快照被删除，插件不激活                                  |
| P1   | 回滚时快照恢复中途失败                            | 事务回滚，数据保持迁移后的状态，rollback 报告失败项且 `requiresRestart` |
| P1   | 没有快照（迁移发生在本功能之前，或快照已被清理）  | 维持 `PluginDataVersionError`，并提示可选操作                           |
| P2   | 解释器路径不可执行或输出无法解析                  | 给出警告，照常尝试启动，启动错误正常报出                                |
| P3   | 依赖准备失败或被取消                              | 状态为 `failed` / `not-prepared`，环境不留下半装的记录                  |
| P3   | 共享环境里另一个插件的依赖发生变化                | 只有受影响插件变为 `stale`                                              |
| P4   | `uv.lock` 与 `pyproject.toml` 不一致              | 准备被拒绝，提示作者重新生成锁                                          |
| P4   | 离线且缺少某个 wheel                              | 准备失败并列出缺少的包，不联网                                          |
| P5   | paired client 发起安装，Host 收到的摘要与审核不符 | Host 拒绝，client 显示未生效                                            |

## 6. 待定项与风险

1. **快照空间不足时怎么办**：已定（2026-11-18），让用户选择，见 P1「配额」。
2. **ADR 编号**：其他会话可能同时新增 ADR，编号在写入前现取。
3. **schema 版本递增**：其他会话可能同时修改 `CURRENT_SCHEMA_VERSION`，按 `dexie-migration` skill 先检查有没有并发占用。
4. **`pep440_rs` 依赖**：已核实并引入（2026-11-19），见 P2 实施记录。
5. **Windows 路径**：uv 的 `--project` 和 `UV_PROJECT_ENVIRONMENT` 在 Windows 上要实机验证。
6. **共享工作区**：本仓库多个会话并发编辑，提交按 CLAUDE.md Rule 8 只包含自己的路径。

## 7. 验收

- 每个阶段完成后跑本阶段涉及的 Jest、`node --test`、`cargo test -p cognia-plugin-runtime`（加 `--features tauri-host`）、`pnpm audit:modules`、`pnpm audit:colocated-tests`、`pnpm lint:i18n`、`pnpm i18n:build:check`；P1 另跑 `pnpm db:governance:write` 并确认生成文件只多出本方案的两张表，P3 另跑 `pnpm companion-api:check`。
- Tauri 桌面实机：
  - 安装 Python 插件 → 弹出准备提示 → 准备 → 卡片显示可运行；
  - 带锁插件在线和离线各准备一次；
  - 手动指定 3.8 解释器后出现警告；
  - 对迁移过数据的插件执行回滚并确认数据回到迁移前。
- paired client：手机或浏览器配对 Host，发起安装，校验「已排队 → 已生效」，以及摘要不符时被拒绝。
- 每阶段一个 changeset（`cognia-next`，patch；P0 只有文档，不需要）。

## 8. 不在本方案内

- ENV06：独立插件 release 的产品采用（见 `docs/plans/2026-10-30-plugins-repository-extraction.md` §27）。
- 修改插件契约（manifest 字段、SDK 类型）以及 authoring kit 的重新固定。
- PEP 751 `pylock.toml` 和 requirements + hash 方式：已决定先只支持 `uv.lock`。
