# 子系统依赖分析与功能模块化方案（草案）

> 日期：2026-11-04<br>
> 基线：`codex/modular-sync-20261030`，HEAD `cb9ef6cff6`，共享工作区，含其他会话未提交的改动<br>
> 方法：
>
> - 静态分析，没有运行应用。
> - 数据由 `node scripts/gates/convergence/subsystem-deps.mjs --json <out> --md <out>` 产出，可以复跑。
> - §3 的归类矩阵是在脚本输出上按正文规则手工划分的。
> - 初稿经过一轮对抗性审查（新开上下文、以证伪为目标的独立审查者），14 项发现的处理见 §10。
>
> 关联：[架构审计 2026-11-01](./architecture-convergence-audit-2026-11-01.md)、ADR-0250（无头内核；§2 宿主适配矩阵，§9 新插件契约，§11 不可悄悄调高的棘轮）、ADR-0246（授权连接）、ADR-0198（单次运行的能力授予）、ADR-0059（无头注册表）<br>
> 状态：**草案**。2026-11-04 已定生成物不进仓、改为修订 ADR-0250、试点顺序；归类表已逐项讨论完。见 §9、§11

## 0. 结论先行

1. **耦合是网状的，不是几个大枢纽。**
   - `lib/` 层的 176 个子系统中，有 **150 个处在同一个强连通分量**里，也就是彼此可达。把基础层口径放宽到 30 个成员后，是 126 / 163。
   - 贪心地逐个拆掉"拆了之后最能缩小环"的子系统，拆掉 15 个，环里还剩 86 个。
   - 所以出路是一条全局的**依赖方向规则**加门禁，而不是拆几个上帝文件。
2. **加功能就得改公共文件。**
   - 近 60 天的 774 个 feat 提交中，有 286 个（37%）改了至少一个中央注册文件，38 个同时改了三个以上。
   - 改得最频繁的是 companion 命令目录。它本来就是生成物，但生成结果提交在仓库里，所以照样是冲突热点。只把注册表"改成生成物再提交"消除不了冲突（§4.5）。剔除它之后，仍有 246 个提交（32%）。
   - 例：加一个设置分区，至少要改五处：`SettingsSectionId` 联合类型、`SETTINGS_NAV`、`settings-shell.tsx` 里 66 个分支的 `switch`、同一文件里 66 个 `dynamic()` 声明，以及搜索关键词。
3. **有三个全局汇点，事实上充当了总线。**
   - 设置 store：530 个非测试文件直接 import 它的入口，`SettingsState` 有 151 个顶层成员。
   - `lib/db`：210 个数据模块中，88 个只有一个子系统在用。
   - 插件宿主 API：151 个文件，触达 82 个子系统。
4. **插件边界基本守住了。**
   - 含 TS 源码的 76 个一方插件里，没有一个直接 import `@/…`。
   - 唯一的例外是 `packages/plugin-sdk/src/index.ts:127` 从 `@/lib/ai/effort-surface` 转导出了一个值，插件经由 SDK 仍能碰到这一处宿主代码。
   - 失控的地方是**应用内部没有模块边界**，不是插件做得不够多。
5. **建议：先模块化，后插件化。**
   - 每个功能写一份**只含数据**的 feature module manifest，声明它拥有哪些文件、贡献哪些东西、依赖谁。
   - 中央注册表由 manifest 生成，每个宿主一份，里面只有懒加载入口。
   - 依赖方向由门禁执行，并接入 ADR-0250 §11 的棘轮。
   - 只有可替换的服务商实现和可选应用，才在新插件契约（ADR-0250 §9）落地之后迁成插件。迁成插件时如果涉及表，就是一次数据迁移，需要另行决策（§4.8）。

## 1. 口径与局限

**子系统怎么划分**

- 按目录名合并：`lib/X`、`components/X`、`hooks/X`、`stores/X`、`types/X`、`app/X` 都记为 `X`。
- 12 对单复数目录合并，例如 `plugin`/`plugins`。
- `components/providers` 命名为 `initializers`。
- `stores/settings`、`lib/settings`、`hooks/settings` 合称 `settings-store`，与设置界面 `components/settings` 分开。注意这个合并节点里还有熔断、限流等 7 个 store，所以它的 638 个引用文件**多于**设置 store 本身的 530 个。
- `packages/*` 记为 `pkg:*`，`plugins/*` 记为 `plugin:*`，`cli/src` 记为 `cli`。

**依赖怎么数**

- 入向和出向只数**值导入**。`import type` 和类型位置的 `import("x").T` 不计。
- 动态 `import()` 和 `require()` 按 AST 识别，计为值导入。
- 不计测试、stories、fixtures 和 `.d.ts`。约 35 个测试辅助文件（例如 `cli/src/test-support/*`）漏网，影响不大。

**基础层口径**

- 计算功能依赖和环时，排除一个**窄基础层**：`ui`、`utils`、`db`、`i18n`、`logger`、`tauri`、`types`，以及各层根目录下的散文件。§0 和 §2 用的都是这个口径。
- §3 的归类用**宽基础层**，共 30 个成员，额外包括 `platform`、`network`、`file` 等。两个口径下的环大小在 §0 都列了。

**统计的已知偏差**

- 注册表触点数的是"中央注册文件 import 了哪些子系统"，所以是**下限**：通过事件或字符串 id 间接注册的看不到。
- 表的使用只数 `lib/db` 之外对 `db.<表名>` 和 `.table("<表名>")` 的文本访问。经过 `lib/db` 辅助函数的访问看不到，所以共享程度被**低估**了。补充口径是"数据模块被谁 import"。
- fix 次数按 Conventional Commits 的 `fix` 前缀统计；一个提交碰到几个子系统，就给每个子系统各记一次。
- 目录名不等于职责。例如 `lib/ai/eval` 记在 `ai` 名下；`chat` 同时包含 `lib/chat` 引擎和 `components/chat` 界面。§3 里的"内核"指这些子系统的 `lib/` 部分，它们的 UI 部分将来是同名模块。

**敏感性**：审查者用改过的脚本副本复跑了几种口径，`lib/` 层的环始终在 145/173 到 152/179 之间，结论不依赖口径细节。

## 2. 现状

### 2.1 总量

| 项                                                  |            数 |
| --------------------------------------------------- | ------------: |
| 纳入分析的非测试 TS 文件                            |        13,547 |
| 子系统（含 53 个 `pkg:`、76 个 `plugin:`）          |           391 |
| `lib/` 层子系统 / 最大强连通分量（窄基础层）        | 176 / **150** |
| 同上，宽基础层（30 个成员）                         |     163 / 126 |
| 全部层去掉 UI 汇总点后的最大强连通分量              |           184 |
| 数据目录登记的表（`CORE_TABLE_NAMES`）              |           400 |
| 只被一个子系统直接访问的表 / 被 ≥3 个子系统访问的表 |      127 / 46 |
| `lib/db` 数据模块 / 只被一个子系统 import 的        |      210 / 88 |

### 2.2 环是网状的

审查者核实了两条真实的环：

- `lib/pet/commands.ts:7` 引用 `@/lib/plugin/commands/registry`，而 `lib/plugin/api/pet-api.ts:26` 又引用 `@/lib/pet/events/pet-event-bus`。
- `lib/chat/session-deletion.ts:2` 引用 `@/lib/claude/ipc`，而 `lib/claude/project-history-tool.ts:56` 又引用 `@/lib/chat/session-exposure`。

在 `lib/` 层贪心拆环，每一步拆掉的子系统和拆完后最大环的大小：

```
150 → plugin 144 → claude 138 → prompts 134 → scheduler 129 → connectors 125
    → task-workspace 122 → headless 119 → workflow 115 → chat 111 → ai 107
    → pet 104 → memory 100 → browser-companion 96 → slash-commands 93 → workspace 86
```

不存在"拆掉 3 个就解开"的捷径。要先定方向规则，再逐条消除违规边（§3.3）。

`lib/` 层里，被最多子系统依赖的是 `platform` 73、`ai` 61、`plugin` 60、`claude` 59、`chat` 54；依赖最多子系统的是 `plugin` 89、`ai` 68、`claude` 67、`workflow` 58、`connectors` 52。

### 2.3 中央注册表触点

| 注册表                                 | 文件数 | 引用的功能子系统 |
| -------------------------------------- | -----: | ---------------: |
| `components/providers/initializers/*`  |    105 |               94 |
| `lib/plugin/api` + `lib/plugin/bridge` |    151 |               82 |
| `lib/claude/build-options.ts`          |      1 |               54 |
| `lib/headless/*`                       |     40 |               48 |
| 应用外壳 / 侧栏                        |     37 |               31 |
| `lib/slash-commands/*`                 |     33 |               29 |
| `components/runtime/app-runtime.tsx`   |      1 |               23 |
| `lib/global-search/providers/*`        |     22 |               20 |
| 设置导航与分区                         |     14 |               17 |

近 60 天 774 个 feat 提交中，改过各中央文件的提交数：

| 中央文件                                                                        | 提交数 |
| ------------------------------------------------------------------------------- | -----: |
| companion 命令目录（`known_commands.rs` / `host-command-catalog.json`，生成物） |    107 |
| `lib/plugin/api/*`                                                              |     74 |
| `components/providers/initializers/*`                                           |     52 |
| `src-tauri/src/lib.rs`                                                          |     49 |
| `lib/claude/build-options.ts`                                                   |     44 |
| `lib/headless/runtimes/*`                                                       |     35 |
| `lib/data-governance/table-catalog.ts`                                          |     31 |
| `hooks/chat/use-claude-chat-controller.ts`                                      |     31 |
| `lib/db/schema.ts`                                                              |     25 |

改过至少一个中央文件的共 286 个（37%）；剔除生成物后为 246 个（32%）。审查者独立复算得到 278 个，单个文件的计数完全一致，差别来自匹配提交标题的方式不同。

引用功能子系统最多的单个文件：

| 文件                                       | 引用的功能子系统 |  行数 |
| ------------------------------------------ | ---------------: | ----: |
| `lib/claude/build-options.ts`              |               45 | 6,623 |
| `hooks/chat/use-claude-chat-controller.ts` |               35 | 7,606 |
| `lib/companion/desktop-write-source.ts`    |               34 | 4,111 |
| `components/chat/composer.tsx`             |               32 | 5,165 |
| `lib/prompts/catalog.ts`                   |               28 |   401 |
| `lib/claude/plugin-tool-ipc.ts`            |               26 | 1,191 |
| `hooks/chat/claude-chat-events.ts`         |               24 | 2,132 |
| `components/runtime/app-runtime.tsx`       |               23 |   544 |
| `lib/db/schema.ts`                         |               21 | 2,679 |

### 2.4 三个全局汇点

**设置 store**

- `stores/settings/settings-store.ts` 共 2,182 行。`SettingsState` 有 151 个顶层成员，其中 122 个是函数。
- 有 530 个非测试文件直接 import 它的入口。
- 设置同步的线上契约来自 `packages/agent-config-types/src/settings-sync.ts`，由 `gen-settings-sync.mjs` 生成 Rust 端的允许清单。所以拆分时必须保持扁平的 `AppSettings` 键（§4.3）。

**`lib/db`**

- 210 个数据模块中，88 个只有一个子系统在用。例如 `pet-conversation`、`radar-reports` 只属于 `pet`，`calibration-runs` 只属于 `eval`。
- 反向依赖：`db` 引用 `sync` 共 32 个文件，其中 29 个只是引用了 `lib/sync/tombstones.ts`。这个文件本身只依赖 `lib/db`，是一个放错位置的数据模块。搬走这一个文件，"基础层 → 内核"最重的这条边就能消掉约九成。
- 被最多子系统直接访问的表：`sessions` 22、`messages` 13、`executionRuns` 13、`workflowRuns` 7、`executionRunEvents` 7。

**插件宿主 API**

- 151 个文件触达 82 个子系统，插件 API 几乎就是整个应用的外立面。
- 在这套 API 上每多迁一个功能，宿主就要多暴露一片内部细节。

### 2.5 正面信号

- 插件边界基本守住了，例外见 §0 第 4 点。
- CLI（无头 brain）直接复用 `lib/`，依赖 51 个功能子系统。
- CLI 的 esbuild 打开了代码拆分（`scripts/build/esbuild-shared.mjs:127` 的 `splitting: true`），所以 manifest 里的懒加载 `import()` 在单文件 Node 构建里也能保留。

## 3. 归类建议

### 3.1 判定规则

| 类                        | 含义                                        | 判定依据                                                                                                                                 |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 基础层 foundation         | 不带业务语义的管道                          | UI 原件、工具函数、数据库实例、平台与传输桥、日志、错误                                                                                  |
| 内核 kernel               | 被共同依赖、长期运行的行为（ADR-0250 内核） | 会话与消息、发送管线、模型网关与凭据、agent 执行、执行台账、身份与账号、工作区、同步、存储、队列与调度原语、授权、插件宿主、设置基础设施 |
| 外壳 shell                | 只做汇总和导航，不应被任何人依赖            | 设置界面、初始化器、`app/me`、桌面与移动外壳、全局搜索、slash 命令、无头装配                                                             |
| 模块 module               | 同进程、编译期链接的功能                    | 其余所有功能                                                                                                                             |
| 插件候选 plugin candidate | 可选、可替换，或者只需要很窄的接口          | 依赖它的子系统少；本质上是"某种能力的一个实现"，或者是一个可选应用                                                                       |

内核是一份封闭清单，扩充需要单独决策。没有点名的子系统默认是模块。

### 3.2 归类表

只列 ≥1500 行的子系统。列的含义：

- **真实入向**：去掉外壳汇总点之后，依赖它的功能子系统个数。
- **出向**：它依赖的功能子系统个数。
- **注册表**：引用它的中央注册表种类数。
- **表**：它直接访问的数据表个数。
- **fix**：近 60 天的 fix 提交次数。

全量数据见附录 B。

**基础层（30 个）**：`db` 67.4k、`tauri` 13.3k、`ui` 13.3k、`ai-elements` 10.6k、`observability` 7.7k、`runtime` 5.5k、`capacitor` 4.7k、`file` 3.9k、`shared` 2.8k、`error` 2.6k、`native` 2.6k、`platform` 2.5k、`data-governance` 2.5k、`network` 2.0k、`storage` 1.8k、`telemetry` 1.8k、`shortcuts` 1.7k、`diagnostics` 1.5k，等等。

`db` 需要瘦身，只保留三样：Dexie 实例、`schema.ts`、跨模块共享的核心表访问（会话、消息、执行台账）。其余数据模块随各自的归属搬走（§4.4）。

**内核（34 个）**

| 子系统           |   行数 | 真实入向 | 出向 | 注册表 |  表 | fix |
| ---------------- | -----: | -------: | ---: | -----: | --: | --: |
| `plugin`（宿主） | 165.2k |       75 |   95 |      8 |  15 |  52 |
| `chat`           | 155.1k |       81 |  122 |      8 |   7 |  55 |
| `ai`             |  93.7k |       74 |   65 |      6 |  26 |  35 |
| `agent`          |  61.3k |       42 |   57 |      7 |   8 |  14 |
| `claude`         |  43.8k |       62 |   69 |      5 |   0 |  23 |
| `scheduler`      |  41.1k |       39 |   45 |      6 |   4 |  24 |
| `skills`         |  31.2k |       16 |   27 |      5 |   8 |  17 |
| `router-fusion`  |  29.6k |       17 |   28 |      3 |   0 |  12 |
| `data`           |  16.4k |       39 |   30 |      2 |  77 |  13 |
| `account`        |  15.2k |       40 |   34 |      4 |   0 |  16 |
| `subscription`   |  13.0k |       21 |   13 |      4 |   6 |   2 |
| `sync`           |  12.7k |       15 |   28 |      1 |  31 |  20 |
| `execution`      |  12.7k |       26 |   22 |      6 |   7 |  13 |
| `companion`      |  11.4k |       18 |   45 |      2 |   3 |  13 |
| `workspace`      |  11.3k |       42 |   30 |      6 |   0 |  10 |
| `sandbox`        |  10.5k |       18 |   15 |      4 |   0 |   5 |
| `usage`          |   9.4k |       26 |   17 |      4 |   7 |   0 |
| `notifications`  |   8.5k |       27 |   15 |      1 |   6 |   6 |
| `connectivity`   |   8.2k |       13 |   18 |      0 |   0 |  12 |
| `policy`         |   7.0k |       21 |   13 |      1 |   0 |   7 |
| `settings-store` |   5.7k |       88 |   17 |      7 |   3 |   7 |

其余内核成员：`project-environment`、`remote-host`、`task-workspace`、`mcp`、`identity`、`gateway`、`prompts`、`signaling`、`plugin-runtime`、`logto`、`placement`、`outbound`、`attention`。

说明：

- **`subscription` 在初稿里列为插件候选，审查后改为内核。** 发送管线直接依赖它的 `core`：`lib/claude/env-resolver.ts:15,18`、`provider-attempt-options.ts:10-14`、`routing-fallback.ts:23`、`build-options.ts:177-180`。它属于模型凭据的管道。插件候选只是各家订阅的具体实现，其中 Kimi、MiniMax、智谱已经是插件了。
- `scheduler` 和 `skills` 的 `lib/` 部分是内核原语，各自的界面是同名模块。
- `prompts/catalog.ts` 引用了 28 个子系统，应当改成贡献点。

**外壳（14 个）**：`settings`（设置界面）198.4k、`mobile` 35.1k、`desktop` 17.8k、`shell` 13.6k、`initializers` 12.2k、`global-search` 7.8k、`slash-commands` 7.2k、`onboarding` 6.6k、`me` 4.8k、`headless` 4.6k、`dev` 3.6k、`conversations` 2.7k。设置界面下按功能划分的子目录归各自的模块所有。

**模块（154 个，其中 ≥1500 行的 57 个）**

| 子系统                |  行数 | 真实入向 | 出向 | 注册表 |  表 | fix |
| --------------------- | ----: | -------: | ---: | -----: | --: | --: |
| `connectors`          | 99.6k |       40 |   54 |      7 |  20 |  36 |
| `workflow`            | 94.6k |       30 |   69 |      6 |  20 |  21 |
| `a2ui`                | 35.9k |       13 |   19 |      4 |   3 |   6 |
| `issues`              | 32.1k |       19 |   30 |      5 |  13 |  10 |
| `artifact`            | 25.8k |       29 |   39 |      4 |   2 |  12 |
| `terminal`            | 25.5k |       18 |   26 |      4 |   0 |   3 |
| `browser`             | 23.2k |       14 |   22 |      3 |   0 |  13 |
| `logging`（查看界面） | 22.8k |       12 |   18 |      1 |   0 |   8 |
| `twin`                | 19.5k |       32 |   19 |      4 |   7 |   8 |
| `canvas`              | 16.9k |       15 |   27 |      1 |   4 |   4 |
| `harness`             | 16.7k |        6 |   23 |      2 |   1 |   1 |
| `editor`              | 15.8k |        8 |   24 |      1 |   0 |   8 |
| `device`              | 15.8k |       17 |   30 |      1 |   0 |  14 |
| `inbox`               | 15.5k |        8 |   22 |      1 |   7 |   4 |
| `memory`              | 15.1k |       23 |   24 |      6 |   2 |   5 |
| `files-library`       | 14.1k |        6 |   27 |      1 |   3 |   8 |
| `bot`                 | 12.6k |       12 |   29 |      4 |  12 |  14 |
| `source-control`      | 12.0k |        8 |   22 |      0 |   0 |   4 |
| `appearance`          | 11.9k |       16 |    7 |      3 |   0 |   4 |
| `context-workbench`   | 11.3k |       12 |   33 |      4 |   0 |   8 |

其余模块（按行数从大到小）：`collab`、`goal`、`templates`、`share`、`automation`、`glance`、`account-sync`、`integrations`、`git`、`filespace`、`fleet`、`discover`、`project-coordinator`、`external-services`、`squads`、`browser-companion`、`updates`、`agent-runs`、`tray`、`provider-diagnostics`、`best-of-n` 等。

有几组可以合并成更大的模块：

- 代码协作：`source-control`、`git`、`stack`、`scm`；
- agent 编排：`squads`、`agent-team`、`agent-runs`、`best-of-n`、`project-coordinator`；
- 桌面浮层：`glance`、`tray`、`tray-panel`、`island`、`fleet`；
- IM 平台：`connectors`、`inbox`、`bot`，其中平台适配器是插件候选。

**插件候选（29 个）**

第一种是**某种能力的一个实现**：内核定义能力端口（port），具体实现做成插件。ADR-0246 是样板。

| 能力端口                  | 现有实现                | 真实入向 | 说明                                                                      |
| ------------------------- | ----------------------- | -------: | ------------------------------------------------------------------------- |
| 文字识别 `ocr`            | `ocr` 1.5k              |       22 | `chat`、`plugin`、`workflow`、`project-environment` 直接 import，改走端口 |
| 语音 `speech`             | `voice` 5.4k、`tts`     |        1 | 6 家实时语音服务商已经是 adapter-registry 结构                            |
| 网页读取与搜索 `web`      | `web` 3.8k              |       12 | ADR-0060                                                                  |
| 云文档 `docs-provider`    | `docs-providers` 3.0k   |       13 | ADR-0134                                                                  |
| 远程桌面 `remote-desktop` | `remote-desktop` 3.3k   |        3 | RustDesk、VNC 已经是插件                                                  |
| 代码托管 `forge`          | `github` 1.8k           |        7 | `issues`、`integrations` 直接依赖它                                       |
| 远端 IDE                  | `codeserver` 4.4k       |       12 | Pro IDE                                                                   |
| 订阅实现                  | 各家订阅                |        — | 框架在内核，见上                                                          |
| IM 平台适配器             | `connectors/adapters/*` |        — | 框架是模块                                                                |

第二种是**可选应用**：

| 子系统                                                                       |  行数 | 真实入向 | 前置条件                                                       |
| ---------------------------------------------------------------------------- | ----: | -------: | -------------------------------------------------------------- |
| `pet`                                                                        | 31.0k |   **22** | 先反转依赖：账号、托盘、工作流、外观、glance 都在 import 它    |
| `sites`                                                                      | 12.9k |        5 | —                                                              |
| `external-bridge` + `wiki`                                                   | 12.7k |        3 | —                                                              |
| `eval` + `performance` + `perf`                                              | 22.2k |      ≤15 | `perf` 被 `chat`、`share`、`workflow` 用来打点，先拆出打点接口 |
| `session-import` + `agent-migration` + `commands-import` + `settings-import` |   9k+ |        8 | 都是一次性导入工具                                             |
| `status`、`creator`、`servers` + `server-ops`                                | 13.2k |      0–1 | —                                                              |
| `reply-copilot`、`selection-toolbar`、`island`                               |  8.5k |       ≤3 | —                                                              |

哪些候选应该直接删除或冻结，属于"功能台账"要做的决定，不在这份分析里定。

### 3.3 按这份归类，现有多少违规边

只看 `lib/` 层的值导入，按文件计数。

| 方向            |    边数 | 最重的几条                                                                                                | 规则                                               |
| --------------- | ------: | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 内核 → 模块     | **523** | `ai→workflow` 18、`plugin→external-services` 13、`skills→issues` 13、`ai→twin` 12、`skills→connectors` 11 | 禁止，改为由模块向内核注册                         |
| 模块 → 模块     |     309 | `issues→connectors` 7、`workflow→twin` 7、`issues→external-services` 6、`best-of-n→scm` 5                 | 只能经过对方的公开接口文件，并且要写进 `dependsOn` |
| 基础层 → 内核   |     140 | `db→sync` 32（其中 29 条来自放错位置的 `tombstones.ts`）、`db→chat` 15                                    | 禁止                                               |
| 内核 → 插件候选 |      78 | `chat→ocr` 8、`ai→github` 6、`chat→docs-providers` 6、`plugin→ocr` 5                                      | 改走能力端口                                       |
| 基础层 → 模块   |      65 | `db→workflow` 7、`db→issues` 4、`db→memory` 4                                                             | 禁止，数据模块随归属搬走                           |
| 内核 → 外壳     |      22 | `plugin→slash-commands` 5、`chat→slash-commands` 3                                                        | 禁止                                               |
| 模块 → 外壳     |       9 | `tray→slash-commands` 2                                                                                   | 禁止                                               |

另有两份已有清单（`scripts/gates/convergence/inventories/`）：`lib` 引用 `hooks` 或 `components` 的有 66 个文件（`lib-ui-imports`），`lib` 命令式读写 store 的有 410 个文件（`lib-store-imperative`）。

"内核 → 模块"的 523 条边里，有相当一部分其实是放错了目录。例如 `lib/ai/` 下面有属于工作流和孪生的代码。所以**第一步是建归属表，而不是搬代码**：归属理清之后，很多"违规"会变成模块内部的依赖。

### 3.4 三个难点

- **`pet`**：它是可选功能，却有 22 个子系统依赖它，连 `settings-store.ts` 都 import 了 `lib/pet/window-role`。要先把这些依赖反转过来。它适合做"反转依赖"的试点，但不适合当第一个试点。
- **`ocr`**：只有 1.5k 行，入向却有 22。这是典型的能力端口：先在内核里定义端口，让调用方改走端口，再把引擎迁成插件。
- **设置 store**：要拆成按模块划分的 slice，但存储和同步时仍然是扁平的键（§4.3）。拆完之前，用棘轮保证它的引用数不再增加。

## 4. Feature module manifest 设计

### 4.1 目标与非目标

**目标**

- 一个功能对应一份声明。加功能时只改自己的目录和自己的 manifest，不碰手写的中央文件。
- 中央注册表由声明生成。
- 依赖方向由门禁检查，违规数只许减少。
- 模块可以整体关闭，关闭后依赖它的代码在编译期就能发现。
- 形状和 ADR-0250 §9 新插件契约的两层一一对应，并复用仓库里已有的词汇（§7）。

**非目标**

- 不做运行时动态加载。保持静态导出、tree shaking 和无头 Node 运行的现状。
- 不一次性搬目录。
- 不处理 Rust。Rust 有 ADR-0196 的 crate 分层门禁；manifest 只登记模块用到的宿主命令，供一致性检查使用。
- 不碰 Dexie 的单一 schema。表的结构定义仍然集中在 `schema.ts`，manifest 只声明归属（§4.3）。

### 4.2 两份只含数据的清单

| 清单    | 位置                           | 规则                                                                                                   | 对应新插件契约 |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------- |
| host 层 | `lib/<id>/module.ts`           | 只 import `defineHostModule`。其余内容只能是字面量或懒加载入口 `() => import("…")`，顶层不执行任何代码 | host 层        |
| UI 层   | `components/<id>/module.ui.ts` | 同上，组件一律懒加载                                                                                   | UI 层          |

"只含数据"是审查后加上的硬约束。原因如下：

- 生成的注册表会被每个宿主静态 import。
- 如果 manifest 里带了 schema、defaults 这类值，或者有任何顶层副作用，所有模块都会被拉进启动时的急加载模块图。
- ADR-0250 已经把 brain 启动的模块图（2.5 秒、669 MB）当作预算问题来处理。

所以 schema、defaults 一律放到懒加载入口后面。

### 4.3 字段

```ts
// lib/<id>/module.ts —— 示意，字段名待 ADR 定稿
export default defineHostModule({
  id: "pet",
  kind: "module", // "kernel" | "module"；插件候选另加 extractTo: "plugin"
  stage: "stable", // "kernel" | "stable" | "beta" | "experimental" | "deprecated"
  owner: "@cognia/pet", // 与 .github/CODEOWNERS 的团队名一致
  acceptance: { evidence: "docs/evidence/…", realSmoke: "pending" }, // 或 "passed:<日期>"

  owns: ["components/settings/pet/**", "lib/db/pet-*.ts"], // 约定目录之外的额外归属
  dependsOn: ["chat", "notifications"],
  api: ["lib/pet/api/status.ts"], // 公开接口文件，见 §4.6
  provides: [{ port: "glance.slice", load: () => import("./glance-slice") }],
  requires: ["ocr?"],

  runtimes: [
    {
      name: "pet-proactive",
      criticality: "optional",
      // 每个宿主一个适配器，对应 ADR-0250 §2 的宿主适配矩阵
      adapters: { desktop: () => import("./runtime/desktop") },
    },
  ],
  settings: { keys: ["petEnabled", "petModelId" /* … */], load: () => import("./settings") },
  tables: ["petModels", "petMediaPacks", "radarReports"], // 只声明归属
  tools: { load: () => import("./tools") }, // 内置工具及其权限规则
  capabilityContributions: { load: () => import("./grants") }, // 产出 AgentCapabilityGrantV1
  slashCommands: () => import("./slash"),
  searchProviders: () => import("./search"),
  prompts: () => import("./prompts"),
  flags: { proactiveChat: { default: false } },
  messages: "pet", // i18n 命名空间
})
```

```ts
// components/<id>/module.ui.ts
export default defineUiModule({
  id: "pet",
  // 插槽名复用 CANONICAL_EXTENSION_POINTS（packages/plugin-contract/src/lib/plugin/contracts/plugin-points.ts）
  slots: { "pet.console.tab": () => import("./console-tab") },
  settingsSections: [
    {
      id: "pet",
      group: "appearance",
      icon: "paw-print",
      requires: ["desktop"],
      load: () => import("./settings"),
    },
  ],
  nav: [{ route: "/pet", icon: "paw-print" }],
  // 需要 React 上下文、路由、i18n、toast 的副作用
  effects: [{ name: "pet-window-title", load: () => import("./effects/window-title") }],
})
```

以下几点是审查后修正的：

- **`runtimes` 不能直接复用 `HeadlessRuntime`。**
  - `lib/headless/types.ts:77` 的 `HeadlessHost` 只有 `"brain" | "person-brain"`，`start(ctx)` 拿到的也是 brain 专用的上下文。
  - ADR-0250 §2 写明：brain 的条目不能靠换一个 bridge 就拿到桌面上复用，必须有按宿主区分的适配矩阵。
  - 所以 `runtimes` 只声明运行时的身份和重要性，每个宿主各写一个 `adapters` 入口。brain 适配器的签名沿用现有的 `HeadlessRuntime.start`。
- **需要 React 的副作用放进 UI 层的 `effects`，不冒充运行时。**
  - 105 个初始化器里，至少有 26 个用到了路由、`useTranslations`、toast 或 JSX，例如 `perf-hud-mount.tsx`、`context-keys-initializer.tsx`、`tray-panel-initializer.tsx`、`window-title-initializer.tsx`。
  - 运行时副作用也不只在初始化器目录里，例如 `components/project-coordinator/project-coordinator-host.tsx`。归类以已有的 `runtime-initializers.json` 清单为准。
- **`settings` 只声明归属的键，线上仍然是扁平的 `AppSettings`。**
  - 设置同步的唯一来源仍是 `packages/agent-config-types/src/settings-sync.ts`，Rust 端的允许清单由它生成。
  - 模块通过 `getModuleSettings("pet")` 拿到的是只包含自己那些键的视图。门禁检查的是"不读写别人的键"，存储结构不变。
- **发送选项不按单一的 `order` 排序。**
  - ADR-0198 规定，能力授予的每个字段在各自的阶段生效：`model` 在链头，`maxTurns` 在执行策略之后，`tools.deny` 在插件 hook 之后，`subagents.only` 在 `@agent` 路由之前。
  - 一个数字 `order` 加一个自由的 `contribute()`，等于 ADR-0198 明令禁止的"事后改 SendOptions"。
  - 所以模块只能产出 `AgentCapabilityGrantV1`，由现有的解析链按阶段施加。确实需要新阶段的，先修订 ADR-0198。
- **`tables` 只声明归属。"只改自己的目录"这个目标，不包括加表。**
  - 加表仍然要改 `schema.ts`、`CORE_TABLE_NAMES` 和治理产物，这是 Dexie 单一版本号的代价，接受它。
  - manifest 的作用是：让数据目录的 `owner` 不再靠 `ownerFor` 猜前缀；让门禁能发现"别的模块直接访问了我的表"。
  - 可参照的先例是 `lib/plugin/dexie/builtin-manifests.ts`，它把 manifest 里声明的表合进启动前的快照。
- `hosts`、`stage` 和 `effects` 合起来，正好落实 Rule 7 要求的"在三处标注休眠"：类型声明、UI 上的停用提示、对生成的注册表的测试。

### 4.4 先定归属，后搬家

- 每个模块默认拥有 `{lib,components,hooks,stores,types,app}/<id>/**`，再加上 `owns` 里列出的路径。
- 门禁要求每个非测试文件恰好有一个所有者：某个模块、某个内核成员、基础层或外壳。
- 一开始用一份过渡归属表兜底，表的行数作为棘轮。

这样不移动文件，边界就能生效，也避免了在共享工作区里大规模改路径。目录合并在模块被修改时顺手完成，例如 `lib/db/pet-*.ts` 搬进 `lib/pet/db/`，`lib/sync/tombstones.ts` 搬回 `lib/db/`。

### 4.5 中央注册表改为生成

生成器 `scripts/build/gen-module-registry.mjs` 为每个宿主产出一份聚合文件：`lib/modules/generated/{brain,desktop,mobile}.ts` 和 `components/modules/generated/ui.ts`。文件里只有懒加载入口。按宿主拆开，是为了让 brain 根本看不到桌面专用模块的入口。

**生成物是否进仓（待你决定）。** 审查指出，这次统计里最热的"中央文件"本来就是生成物（companion 命令目录），提交进仓的生成物照样会冲突。建议：

- 把生成步骤接进 `predev`、`prebuild` 以及测试和类型检查的前置步骤，和现有 `scripts/build/*` 的资产预处理放在同一个位置；
- 生成文件加入 `.gitignore`。

代价是任何检查之前都要先跑一次生成。

**设置界面的生成要求。** 生成文件带 `"use client"`，每个分区写成字面量形式的 `dynamic(() => import("…"), { ssr: false })`。`settings-shell.tsx` 和 `app/settings/page.tsx` 本来就是客户端组件，这样和静态导出兼容。

替换顺序：

| 注册表                | 现在                                                                  | 生成自                         | 先后                  |
| --------------------- | --------------------------------------------------------------------- | ------------------------------ | --------------------- |
| 设置分区              | 联合类型、`SETTINGS_NAV`、66 个 `case`、66 个 `dynamic()`、搜索关键词 | `settingsSections`             | 1                     |
| 全局搜索 provider     | 22 个文件加一份手写列表                                               | `searchProviders`              | 1                     |
| slash 命令            | 33 个文件                                                             | `slashCommands`                | 1                     |
| 插槽贡献              | 插槽词汇已有，挂载由宿主手写                                          | `slots`                        | 2                     |
| 导航和侧栏            | 手写                                                                  | `nav`                          | 2                     |
| 运行时和 React 副作用 | 105 个初始化器加 40 个无头文件，两处维护                              | `runtimes.adapters`、`effects` | 2，随 ADR-0250 阶段 2 |
| 表归属                | `ownerFor` 按前缀猜                                                   | `tables`                       | 2                     |
| 提示词目录            | `prompts/catalog.ts` 引用 28 个子系统                                 | `prompts`                      | 3                     |
| 能力授予贡献          | `build-options.ts` 引用 54 个子系统                                   | `capabilityContributions`      | 3，先过 ADR-0198      |
| 设置键归属            | 151 个成员的单一对象                                                  | `settings.keys`                | 3                     |
| 插件宿主 API          | 151 个文件触达 82 个子系统                                            | 由新插件契约定义               | 随 ADR-0250 §9        |

### 4.6 模块之间怎么通信

| 方式         | 用途                                                                                          | 约束                                                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 公开接口文件 | A 需要 B 的能力                                                                               | 只能 import B 的 `api` 里列出的**具体文件**（例如 `lib/pet/api/status.ts`）和 `types/<B>/**`。**不建 barrel**：`check-root-loading-boundaries.mjs` 已经因为加载面过大，禁止了 `@/hooks/chat`、`@/lib/plugin` 这类 barrel。B 要写进 A 的 `dependsOn`，且 `dependsOn` 图必须无环 |
| 能力端口     | 可互换的实现：ocr、speech、web、docs-provider、forge、remote-desktop、sandbox 后端、IM 适配器 | 内核定义端口；模块或插件通过 `provides` 提供实现，使用方通过 `requires` 声明需要                                                                                                                                                                                               |
| 事件         | 需要反转依赖方向                                                                              | 内核提供类型化事件总线，事件类型由发布方在 `types/<id>/events.ts` 中声明                                                                                                                                                                                                       |
| 贡献点       | 外壳和内核收集各模块的东西                                                                    | 只能通过 manifest 字段                                                                                                                                                                                                                                                         |

### 4.7 生命周期和开关

- `experimental` 模块默认不进导航，也不启动运行时。
- 现在分散在约 14 个文件里的特性开关，逐步收进 manifest 的 `flags`，读取入口只有一个。
- 模块关闭后：运行时不启动；导航里隐藏；直接访问它的路由时显示"已停用"；表结构保留。
- `stable` 模块的 `acceptance.realSmoke` 如果还是 `pending`，门禁发出警告。这是"真实验收通过才算完成"的落点。
- 构建期 profile 留到以后再做，例如移动端构建时不打包 `hosts` 里没有 `mobile` 的模块。

### 4.8 从模块到插件

插件候选要等新插件契约落地后才迁移。迁移之前，由门禁计算每个候选的"可抽出度"，看三件事：

1. 它对宿主的依赖里，有多少超出了插件契约会暴露的范围；
2. 还有多少其他模块在 import 它（必须为 0）；
3. 它是否拥有核心表。

第 3 点是审查后修正的。插件表的名字带命名空间，格式是 `${pluginId}:${tableName}`（`dexie/namespace.ts:22`），所以把核心表改成插件表就等于**改表名，也就是数据迁移**。CLAUDE.md 规定本地数据不做迁移，加 `upgrade()` 回填之前也要先问。因此，拥有核心表的候选在迁移前要单独决定：放弃旧数据、做显式迁移，还是保留核心表、只给插件授予访问权。

## 5. 配套门禁

所有门禁都注册进 `scripts/gates/check-all.mjs`。计数类门禁做成 `scripts/gates/convergence/counter.mjs` 的新清单，复用它的指纹、排除项和复核机制；基线登记在 `scripts/gates/baseline-growth.json`，与合并基点比较。

| 门禁              | 检查什么                                                                                                                                                                                                                                                                                              | 度量 / 基线                                     | 阶段                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------- |
| G1 归属完整       | 每个非测试源文件恰好有一个所有者；`owner` 和 `.github/CODEOWNERS` 一致                                                                                                                                                                                                                                | 过渡归属表的行数，只许减少                      | 从 M0 起阻塞               |
| G2 依赖方向       | 基础层 → 其他、内核 → 模块 / 插件候选 / 外壳、模块 → 外壳，都算违规。规则引擎扩展 `check-package-boundaries.mjs`，不另写一套                                                                                                                                                                          | 违规边集合（按"文件 → 子系统"取指纹），只许减少 | M0 只报告，从 M1 起阻塞    |
| G3 公开接口       | 跨模块只能 import 对方 `api` 里列出的文件；对方已写进 `dependsOn`；不许新增 barrel                                                                                                                                                                                                                    | 违规 import 集合，只许减少                      | M1                         |
| G4 声明与实际一致 | `dependsOn` 与实际的 import 一致；`tables` 与实际的表访问一致；`settings.keys` 没有被别的模块读写；`runtimes.adapters.brain` 确实在 brain 的模块图里被调用（沿用 `check-headless-registry` 的判定：要被调用，可达不算）；`runtime-initializers` 清单里的每一项，要么已迁移，要么已在 `effects` 里归类 | 不一致项为 0                                    | M1                         |
| G5 生成结果可复现 | manifest 只含数据（顶层只允许字面量和懒加载入口）；生成器能无报错跑完；已迁移的注册表里禁止手写条目                                                                                                                                                                                                   | 0                                               | 每迁移一个注册表就启用一个 |
| G6 无环           | `dependsOn` 图无环；实际 `lib/` 层最大强连通分量的大小（当前 150）                                                                                                                                                                                                                                    | 只许减少                                        | 从 M0 起作为棘轮           |
| G7 规模与加载预算 | 模块数、`experimental` 模块数、表数、`SettingsState` 成员数、设置 store 的引用文件数（530）；每个宿主生成的注册表所带来的急加载模块图大小                                                                                                                                                             | 只许减少，例外要有记录                          | M0                         |

G2 和 G6 转成门禁时，复用 `counter.mjs` 的源码读取器和 `check-headless-registry.mjs` 的 `resolveSpecifier`，不沿用本分析脚本里简化的解析器。

## 6. 迁移步骤

| 步                 | 内容                                                                                                                                                                         | 退出条件                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M0 摸底（约 1 周） | 分析脚本进仓；`defineHostModule` 和 `defineUiModule` 的类型；过渡归属表；G1、G6、G7 作为棘轮，G2 只报告；把 `lib/sync/tombstones.ts` 搬回 `lib/db`，顺手消掉最重的一条违规边 | 基线已提交，与合并基点的比较生效                                                          |
| M1 第一批加试点    | 生成器支持设置分区、全局搜索和 slash 命令；3 个试点模块写好 manifest；G2、G3、G4 改为阻塞                                                                                    | 试点模块新增设置分区或搜索项时，不改任何手写的中央文件                                    |
| M2 运行时与表      | 用 `runtimes.adapters` 加 `effects` 取代"初始化器 + 无头"两处维护（与 ADR-0250 阶段 2 合并）；数据目录的 `owner` 从 manifest 读取；只有单一使用者的数据模块随归属搬走        | `runtime-initializers` 清单清空；初始化器只剩 `effects` 的生成物；"基础层 → 模块"违规为 0 |
| M3 内核汇点        | 设置键归属；能力端口（先做 ocr、speech、docs-provider）；能力授予贡献；提示词贡献点                                                                                          | 设置 store 的引用数、`build-options.ts` 引用的子系统数开始下降                            |
| M4 抽插件          | 新插件契约落地后，迁出可抽出度已清零的候选                                                                                                                                   | 迁出的插件进入插件仓库（plugins-repository-extraction 计划）                              |

试点建议：

1. **`eval`**：入向只有 2，有路由和开关（`NEXT_PUBLIC_EVAL_LAB`）。它的 `lib` 部分放在 `lib/ai/eval` 里，正好用来验证归属表。
2. **`voice`**（加上 `tts`）：入向只有 1，已经是 adapter-registry 结构，用来验证 `speech` 能力端口。
3. **`pet`**：入向 22，覆盖设置、表、运行时、插槽、副作用，用来验证依赖反转。放在前两个之后做。

## 7. 复用已有资产

| 已有资产                                           | 用法                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ADR-0250 阶段 2、§2 适配矩阵、§9 新插件契约        | `runtimes.adapters` 就是适配矩阵；两份清单就是新插件契约的两层。建议和新插件契约的 ADR 共用一份 schema |
| `scripts/gates/convergence/counter.mjs` 及其清单   | G1、G2、G6、G7 作为新清单接入；G4 读取 `runtime-initializers.json`                                     |
| `scripts/gates/baseline-growth.json`               | 新棘轮全部登记在这里                                                                                   |
| `scripts/gates/check-package-boundaries.mjs`       | 作为 G2 的方向规则引擎                                                                                 |
| `scripts/gates/check-root-loading-boundaries.mjs`  | G3 的 barrel 禁令与它保持一致                                                                          |
| `check-headless-registry.mjs`                      | G4 沿用它的"必须被调用"判定                                                                            |
| `CANONICAL_EXTENSION_POINTS` 与 `pnpm audit:slots` | UI 层的 `slots` 直接使用这套插槽名                                                                     |
| `packages/agent-config-types/src/settings-sync.ts` | 设置的线上契约不变，`settings.keys` 只声明归属                                                         |
| `lib/plugin/dexie/builtin-manifests.ts`            | 把 manifest 声明的表合进启动快照的先例                                                                 |
| `lib/headless/types.ts` 的 `HeadlessRuntime`       | brain 适配器的签名                                                                                     |
| `.github/CODEOWNERS`                               | `owner` 字段的团队名                                                                                   |
| ADR-0198 `AgentCapabilityGrantV1`                  | 发送管线贡献的唯一形态                                                                                 |
| ADR-0246 授权连接                                  | 能力端口的样板                                                                                         |

## 8. 风险

- **急加载模块图膨胀。** 应对：manifest 只含数据，注册表按宿主拆分，G7 测量每个宿主注册表带来的急加载图。
- **manifest 与实际漂移。** 应对：由 G4 对账。只有声明、没有门禁的部分，会重演审计 §5.1 里"注释说唯一写入者、实际没人检查"的情况。
- **两套注册方式并存。** 应对：一次只迁一类注册表，迁完立即对它启用 G5。
- **生成物不进仓带来的工具链成本。** 每个检查入口都要先跑一次生成。如果最终决定进仓，就要接受它是冲突点，并保证生成结果稳定排序，尽量减少冲突。
- **发送管线和设置风险最高。** 应对：放到 M3，能力授予贡献先过 ADR-0198。
- **共享工作区冲突。** 应对：M0、M1 只新增文件，不移动目录。

## 9. 决策记录

2026-11-04 讨论后的结论：

| #   | 事项                      | 结论                                                                                                                                                                                                                                                                    | 状态             |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | §3.2 的归类表             | 已逐项讨论完，以 §11 为准                                                                                                                                                                                                                                               | 已定             |
| 2   | 生成的注册表是否进仓      | **不进仓**。加入 `.gitignore`，由 `postinstall`、`predev`、`prebuild`、`scripts/test/jest.mjs`、`typecheck-root.mjs` 的入口生成；CI 和 brain 的 Docker 构建同步接上。理由：在共享工作区里重新生成时，会把其他会话尚未提交的 manifest 一起写进聚合文件                   | 已定             |
| 3   | 落成 ADR 的方式           | 不新开 ADR-0251，改为**修订 ADR-0250**（它仍是 Proposed）：新增 §14「功能模块与生成的注册表」，只追加、不重编号（门禁和 `baseline-growth.json` 引用了 `ADR-0250 §N`）；同步修改 §9、§13 和中文版。ADR-0068 Track 3 中的 S5（store slice）与本方案重叠，在修订中注明关系 | 已定方向，待起草 |
| 4   | 试点顺序                  | **`squads` → `eval` → 飞书三层 → `speech` 端口 → `pet`**（飞书三层见 §11.5）。`squads` 覆盖 M1 的三类注册表（设置分区、搜索 provider、slash 命令）；`eval` 验证归属表；`speech` 放在 M3；`pet` 的依赖反转最后做                                                         | 已定             |
| 5   | M0 何时开始、人力怎么分配 | 未讨论                                                                                                                                                                                                                                                                  | 待讨论           |

§6 的试点建议以本表第 4 项为准。

## 10. 对抗性审查记录

| #   | 发现                                                                                      | 判定         | 处理                                                                       |
| --- | ----------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| 1   | `HeadlessRuntime` 只支持 brain；26 个初始化器依赖 React；运行时副作用不只在初始化器目录里 | 成立         | 改为 `runtimes.adapters` 加 `effects`；M2 的退出条件改用清单               |
| 2   | barrel 形式的公开接口违反 `check-root-loading-boundaries`；静态注册表会扩大急加载图       | 成立         | 公开接口改为具体文件；manifest 只含数据；注册表按宿主拆分；G7 增加加载预算 |
| 3   | 插件表带命名空间，迁移等于改表名                                                          | 成立         | §4.8 改为单独决策                                                          |
| 4   | 单一 `order` 与 ADR-0198 的分阶段规则冲突                                                 | 成立         | 只允许产出能力授予                                                         |
| 5   | 提交进仓的生成物仍是冲突点；最热的"中央文件"就是生成物                                    | 成立         | 建议生成物不进仓，列入待决定                                               |
| 6   | 重复造了插槽词汇、设置同步来源、边界引擎和 CODEOWNERS                                     | 成立         | §7 改为复用                                                                |
| 7   | 发送管线依赖 `subscription` 的核心                                                        | 成立         | 移入内核                                                                   |
| 8   | 150 / 176 的环：给出两条真实的环，换口径后在 145–152 之间                                 | 核实         | 补充宽口径数字                                                             |
| 9   | 类型位置的 `import("x").T` 被算成值导入                                                   | 成立，影响小 | 脚本改为按 AST 识别；全层的环从 211 降到 206，`lib` 层不变                 |
| 10  | 638 是合并节点的数字                                                                      | 成立         | 设置 store 本身的引用数改用 530                                            |
| 11  | `db→sync` 主要来自放错位置的 `tombstones.ts`                                              | 成立         | 写入 §2.4 和 M0                                                            |
| 12  | 设置分区的触点比初稿说的多                                                                | 成立         | 在 §0、§4.5 补全                                                           |
| 13  | 插件 SDK 转导出了一个宿主值                                                               | 成立         | §0 第 4 点加上限定                                                         |
| 14  | CLI 的 esbuild 开了代码拆分，懒加载可以保留                                               | 核实         | 写入 §2.5                                                                  |

## 11. 归类逐项决议

按批次讨论，逐步更新。§3.2 的表格是初稿；与本节冲突时，以本节为准。

### 11.1 内核批

**A 组：保留在内核（2026-11-04 认可）**

以下 24 个子系统，`lib/` 部分留在内核，界面部分划为同名模块：

- 会话与执行：`chat`、`agent`、`execution`、`prompts`
- 账号与工作区：`account`、`identity`、`logto`、`workspace`、`task-workspace`
- 数据与计量：`sync`、`usage`、`notifications`、`policy`
- 执行环境：`mcp`、`sandbox`、`project-environment`、`placement`、`gateway`
- 宿主连接：`companion`、`connectivity`、`signaling`
- 状态：`settings-store`、`plugin-runtime`

附带调整：

- `lib/sync/tombstones.ts` 搬回 `lib/db`；
- `chat` 的 `image-edit` 归图片工作台模块；
- `outbound` 和 `attention` 并入 policy 的界面模块。

**B 组：逐项讨论**

| 项              | 决议                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 日期       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `ai`            | 认可拆分：<br>• `agent/team`（26.3k）移入 `agent-orchestration` 模块（与 squads、agent-runs、best-of-n、project-coordinator 合并）<br>• `eval`（11.0k）移入 `eval` 模块<br>• `media` 和视频任务移入 `media-generation` 模块<br>• `agent/external`、`operations`、`generation` 留在内核                                                                                                                                                                                                                                                                                                                          | 2026-11-04 |
| `data`（备份）  | 内核只留框架：快照构建与加密、注册表、恢复、调度、就绪契约、通用界面。<br>WebDAV、GitHub、Google Drive 各自成为模块 `backup-webdav` / `backup-github` / `backup-google-drive`，各自拥有设置键和设置卡片。<br>GitHub 和 Google Drive 改走 ADR-0246 的连接，Google Drive 去掉对 docs-providers 内部状态的依赖。新插件契约落地后，后两者可以抽成插件                                                                                                                                                                                                                                                               | 2026-11-04 |
| `subscription`  | 内核只留 `core`、`limits`、`retry`、`sync`。<br>按 §11.5 的厂商三层拆分：账号登录归认证层；订阅额度、余额查询、模型目录分别作为订阅、余额、模型目录端口的实现。<br>Anthropic、OpenAI（含 `siwc`）这两家的实现做成模块；其余厂商（含 `balance/` 下的 8 家余额查询、opencode、commandcode）做成插件                                                                                                                                                                                                                                                                                                               | 2026-11-04 |
| `router-fusion` | 先不归类，单独做"模型路由收敛"专项分析。<br>暂定目标：内核新增"模型路由与调用账本"一层，合并 `provider-routing` 的 `planRoute`、`packages/router-fusion` 的纯引擎和 `lib/usage` 的预算部分；cascade、panel、delegate 模式、cockpit、路由实验和影子路由作为 `fusion` 模块。<br>专项分析在归类表过完之后做                                                                                                                                                                                                                                                                                                        | 2026-11-04 |
| `plugin`        | 认可拆分。<br>• 宿主本体（约 64k：core、API 分发与权限闸门、bridge 基础设施、messaging、auth、security、package、lifecycle 等）留在内核。<br>• 插件生态 42.4k 拆为模块：`vscode-compat`（vscode-shim、ide、lsp 加界面，**保留为 stable**）、`plugin-convert`、`cogsets`、`plugin-marketplace`、`plugin-devtools`（experimental）；`character-pack` 并入角色模块，`pi-packages` 并入 Pi agent 模块，`eval` 并入 eval 模块。<br>• 52 个功能命名空间 API（14.6k）和 21 个贡献类 bridge（3.7k）通过新增的 `pluginApi` 贡献点归各自模块，与 ADR-0250 §9 的契约切换一起做。<br>• 插件管理界面划为 `plugin-manager-ui` | 2026-11-04 |
| `skills`        | 认可拆分。<br>• 运行时、`bundle` 和内置技能注册表留在内核，用 `builtinSkills` 贡献点取代 `built-in/index.ts` 的 barrel。<br>• `built-in/lark`、`built-in/im` 归 connectors；`built-in/issues` 归 issues；`built-in/scheduler` 归 scheduler。<br>• 拆出 `skill-marketplace`（marketplace、skills.sh）、`skill-recorder`（recording 加界面、Rust record、`plugins/skill-recorder`）、`skills-ui` 三个模块                                                                                                                                                                                                         | 2026-11-04 |
| `claude`        | 认可拆分，并进一步决定**解散 `lib/claude` 这个目录**：内容早已不是只针对 Claude 的，目录名不应再用厂商名。<br>• 发送管线主体、权限核心、委派分发、核心 agent 工具留在内核，按职责改名搬迁（例如并到 ADR-0250 §5 的 `lib/runtime/` 下，具体名字在实施时定）。<br>• 约 14 组功能工具连同各自的 `*-tool-rules.ts`，通过 `tools` 贡献点归各自模块。<br>• `team-router` 归 `agent-orchestration`；`routing-fallback` 并入模型路由专项。<br>• MCP 同步适配器和 `subagent-importers` 组成 `agent-config-sync` 模块；workflow 子 agent 归 workflow。<br>• `build-options` 在 M3 改为能力授予贡献                        | 2026-11-04 |
| `scheduler`     | 认可拆分。<br>• 调度核心、三种驱动（node、renderer、Rust 守护进程）、通用执行器（background-job、plugin、script）留在内核。<br>• 约 12 个功能执行器连同各自的任务来源，通过 `taskExecutors` 贡献点（执行器加来源一起声明）归各自模块；`plan`、`backup` 的属主在内核，留下。<br>• 界面和界面数据层（任务编写、筛选、即将运行、模板等）划为 `scheduler-ui`。<br>• cron 以 Rust 守护进程为权威，TS 侧只做校验，两边共用一套测试向量。<br>• `legacy-db-migration.ts` 列为删除候选，删除前先核实没有用户停留在旧库版本                                                                                               | 2026-11-04 |
| `remote-host`   | 认可拆分。<br>• 连接与凭据（transport、management channel、liveness、version、credential vault、host secrets）、代码供给（`code-supply`）、组织模型（`org-models`）留在内核。<br>• Host 管理（update、runtimes、system 及对应 hooks）划为 `host-admin` 模块，与设备控制台放在一起。<br>• 工作迁移（`migration/` 及对应 hooks）划为 `work-migration` 模块。<br>• GitHub runner 归 GitHub 模块（forge 端口的实现）                                                                                                                                                                                                | 2026-11-04 |

内核批已全部过完（2026-11-04）。

新增的 manifest 贡献点：

- `taskExecutors`：调度执行器与任务来源，一起声明
- `builtinSkills`：内置技能处理器
- `pluginApi`：插件 API 命名空间

`tools` 贡献点需要同时携带工具的权限规则。

删除和清理候选：`lib/scheduler/legacy-db-migration.ts`，删除前先核实。

### 11.2 插件候选批（2026-11-04）

原来的"插件候选"细分为四种去向：

- 内核端口加实现；
- 长期作为可关闭的模块；
- 将来可以抽成插件；
- 冻结或删除。

不少可选应用依赖 Rust 侧的窗口或命令，插件无法携带这些代码，所以只能留作模块。

**能力实现类（认可）**

| 子系统           | 决议                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ocr`            | 注册表和自动路由留在内核，作为 `ocr` 端口，22 处直接 import 改为调用端口。本地引擎（Tesseract、平台原生）做成模块，云 OCR 适配器做成插件 |
| `voice` + `tts`  | 内核定义 `speech` 端口（TTS 加实时语音），controller 和 session 归 speech 模块。6 家实时语音做成插件，数量**暂不削减**                   |
| `web`            | 内核提供 `web-reader` 和 `web-search` 两个端口，各家搜索服务做成插件                                                                     |
| `docs-providers` | 框架和端口留在内核。Google、飞书各自作为云文档端口的业务实现，通过授权连接使用 `auth.google` 和 `auth.feishu`（§11.5）                   |
| `remote-desktop` | 会话管理和查看器做成模块，RustDesk、VNC、web-console 等后端保持插件                                                                      |
| `github`         | 内核定义 `forge` 端口，GitHub 按 §11.5 的三层拆分：协议库、GitHub 连接、各项业务实现                                                     |
| `codeserver`     | 只做模块（依赖 Rust），可以关闭                                                                                                          |

**可选应用类（认可）**

- 长期作为可关闭的模块：
  - `pet`：先做依赖反转；`radar` 并入 pet。
  - `capture`：并入知识 / wiki 模块，**保持现状，不冻结**。
  - `selection-toolbar`。
  - `island`：并入桌面浮层模块。
  - `performance`：做成 experimental 面板模块；`perf` 的打点接口下沉到基础层。
  - `status`、`eval`（experimental）、`external-bridge` 加 `wiki`。
  - `agent-interop`：由 session-import、agent-migration、commands-import、settings-import 和 agent-config-sync 合并而成。
- 将来可以抽成插件：`sites`、`reply-copilot` 加 `chat-copilot`。等新插件契约落地后评估；reply-copilot 先做模块。
- `creator`：并入"开发者工具"模块（与 `plugin-devtools` 合并），标为 experimental。
- `servers` 加 `server-ops`：**保持现状**，归类为可关闭模块。
- 待办：为 `sites` 补一份简短的 ADR，写明定位、边界、Cloudflare 依赖和插件化路径。

### 11.3 模块批（2026-11-04，均认可）

**A. 19 个功能模块组**

| 模块组           | 成员                                                                                                                                              |          行数 | 决议                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | --------------------------------------------------------------------------------------------------------------------------------- |
| IM 平台          | connectors、inbox、bot、webhooks、labels、audio、host-consent、`app/lark`                                                                         |        130.6k | 框架留在模块里（约 45k）。飞书 IM 适配器按 §11.5 从协议库中剥离出来，与其余 10 个平台适配器一样**全部保留**，新契约落地后迁成插件 |
| 工作流与自动化   | workflow、automation、loop、durable、tools、jobs                                                                                                  |        105.2k | 节点按领域拆分，由各模块通过新增的 `workflowNodes` 贡献点注册                                                                     |
| 内容与产物       | artifact、canvas、files-library、filespace、share、export、templates、document-templates、document、images、media、annotations、file-viewer、diff |         89.3k | 拆成三个模块：产物与画布、文件空间、分享与导出                                                                                    |
| 终端与编辑器     | terminal、editor、editor-workbench、monaco、lsp、shiki、shell-intelligence、sftp                                                                  |         47.5k | 拆成终端、编辑器两个模块                                                                                                          |
| 工作跟踪         | issues、goal、board                                                                                                                               |         42.8k | issues、goal 各自成为模块；board 是两者共用的界面件                                                                               |
| 知识与记忆       | memory、twin、rag、knowledge-base、project-knowledge、vector、inbound，以及 wiki、capture                                                         |         40.5k | memory、twin 各自成为模块，其余合并为 `knowledge`                                                                                 |
| 生成式界面       | a2ui、mcp-apps、academic                                                                                                                          |         37.5k | 一个模块                                                                                                                          |
| 支持与诊断       | logging、diagnostic-service、support-report、support、support-agent、provider-diagnostics、updates、recovery                                      |         35.1k | 一个模块                                                                                                                          |
| 浏览器           | browser、browser-companion                                                                                                                        |         27.1k | 一个模块                                                                                                                          |
| 代码协作         | source-control、git、stack、scm、review、code-adoption                                                                                            |         25.6k | 一个模块                                                                                                                          |
| agent 编排       | agent-team、squads、agent-runs、best-of-n、project-coordinator、tasks、background-tasks、thread-handoff、agent-tasks                              | 22.5k + 26.3k | `agent-orchestration`                                                                                                             |
| 桌面浮层         | glance、tray、tray-panel、fleet、usage-dock、selection、power、island                                                                             |         21.6k | 一个模块，桌面专用                                                                                                                |
| 对话工作台       | context-workbench                                                                                                                                 |         11.3k | 并入 chat 的界面模块                                                                                                              |
| 同步与协作       | collab、account-sync、cli-bridge、webdav                                                                                                          |         20.5k | collab、account-sync、cli-bridge 各自成为模块；webdav 即 `backup-webdav`                                                          |
| agent 质量与治理 | harness、governance、agent-config、agent-trace                                                                                                    |         19.7k | 拆成 harness（experimental）和配置治理两个模块                                                                                    |
| 设备与 Host      | device、host-installer、qr                                                                                                                        |         17.1k | 并入 `host-admin` 和设备控制台                                                                                                    |
| 外观             | appearance、icons                                                                                                                                 |         12.2k | 主题框架作为模块，主题本身已是插件                                                                                                |
| 集成与外部服务   | integrations、external-services、auth-providers、oauth                                                                                            |         11.7k | auth-providers、oauth 并入内核（ADR-0246 的连接机制），其余作为模块                                                               |
| 插件生态         | discover、pi-packages、extensions                                                                                                                 |          7.5k | discover 并入 `plugin-marketplace`，pi-packages 并入 Pi agent 模块                                                                |

**B. 小目录**

- **并入内核**：
  - `work-submission`、`queue`（队列原语）、`decisions`、`presets`
  - `project`（project-store，归 workspace）
  - `provider`、`magpie`（归 ai）
  - `builtin`（内置 hook 脚本）
  - `host-secrets`（归 remote-host）、`push`（归 notifications）
  - `search`（归 web 端口）、`analysis`（归 chat）
- **下沉到基础层**：
  - `security`、`keyring`、`locks`、`jsonc`、`constants`、`config`
  - `network-proxy`、`pwa`、`biometric`、`profile`
  - `interactions`、`loading-ui`、`paste-collapse`、`data-hooks`、`feature-shell`、`surface`
  - `_platform`、`core`、`packaging`
  - `testing`、`test`、`browser-stubs`
- **并入外壳**：`boot`、`guide`
- **特殊项**：
  - `routing`（RouteLLM-lite 自动档位）是第 4 套路由机制，并入模型路由专项。
  - `ccswitch` 并入 `agent-interop`。

**C. 路由壳**

`share-target`、`plugin-auth`、`invite`、`remote-sessions`、`deep-link`、`mobile-onboard`、`pet-overlay`、`pet-popup`、`portal`、`recorder-controller`、`logs`、`lark` 这几个 `app/*` 目录，各自归对应的模块所有，不单独算作模块。

**删除候选**：A2UI 的 academic 模板（`types/academic` 和 `components/a2ui/academic`，约 2.1k）。删除前先核实模型是否还会产出这些组件。

### 11.4 归类汇总

**贡献点**：§4.3 原有的字段之外，这一轮新增了以下几个：

- `taskExecutors`：执行器与任务来源，一起声明；
- `builtinSkills`；
- `pluginApi`；
- `workflowNodes`；
- 原有的 `tools` 字段要携带权限规则。

**删除和清理候选**（都需要先核实）：

- `lib/scheduler/legacy-db-migration.ts`
- A2UI 的 academic 模板

**冻结**：`creator` 并入开发者工具，标为 experimental。

**专项**：模型路由收敛。范围是 `provider-routing`、`router-fusion`、Rust 网关的 planner、`lib/routing`，以及 `lib/usage` 的预算部分。

**待办**：为 `sites` 补写 ADR。

### 11.5 厂商三层规则（2026-11-04，更正 11.1–11.3 中"厂商单元"的写法）

之前写的"一个厂商一个单元"与 ADR-0246 冲突：把 IM、文档等能力塞进 `feishu-auth`，基础能力就会变成一个飞书大模块。改为下面的三层：

| 层            | 内容                                                                      | 形态                                                                        | 依赖                                                                        |
| ------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1. 协议库     | API 客户端、签名与验签、分页、错误映射、数据类型；不含业务，不持有凭据    | 不依赖 `@/` 的包，例如 `packages/feishu-protocol`；Rust 部分仍放在 crate 里 | 只依赖基础层                                                                |
| 2. 认证提供方 | 登录、账号、刷新、轮换、登出、回调，例如 `auth.feishu`                    | 基础插件（`feishu-auth`），或内置 Rust provider（如 `auth.google`）         | 依赖协议库                                                                  |
| 3. 业务实现   | 每个能力端口一个实现，例如 IM 适配器、云文档、issue 同步、日历、备份、OCR | 归属端口所在的模块，或做成插件                                              | 凭据只经 ADR-0246 的授权连接获取，只 import 协议库，业务实现之间互不 import |

协议库做成包，是为了绕开 ADR-0246 尚未定义的"库插件服务业务插件"接口（接口版本、账号范围）。协议库不持有凭据、不保存状态。

**框架厂商中立**：IM、云文档、issue 同步、备份、调度等框架目录里，不得出现厂商名，也不得 import 厂商实现。厂商专用的部分（例如飞书的运行展示驱动）以贡献点的形式由业务实现提供。由新门禁 G8 执行（见下）。

**分发**：一键安装"某厂商全套"的需求，用 ADR-0209 的 cogset/cogpack 组合，这只是分发层的组合，不是代码耦合。

**飞书现状与去向**：

| 现有                                                                                                                                                                         | 去向                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `lib/connectors/adapters/lark/` 中的 `auth.ts`、`host-auth.ts`、`authed-api.ts`、上传、分页、错误映射（目前被 docs、issues、twin、skills、integrations、policy 直接 import） | 协议库 `packages/feishu-protocol`；涉及凭据的部分进 `feishu-auth` |
| `adapters/lark/` 其余部分、`lark-web`、`app/lark`、`skills/built-in/lark`、`run-presentation/lark-*`、`components/settings/connections/forms/lark*`                          | 飞书 IM 适配器（IM 平台模块的业务实现，以后做成插件）             |
| `docs-providers/providers/lark`                                                                                                                                              | 云文档端口的飞书实现                                              |
| `issues/sync/providers/lark-*`                                                                                                                                               | issue 同步端口的飞书实现                                          |
| `twin/ingest/lark-doc-fetcher.ts`                                                                                                                                            | 改走云文档端口                                                    |
| `ocr/providers/lark-basic.ts`                                                                                                                                                | OCR 端口的飞书实现                                                |
| `plugins/feishu-calendar`                                                                                                                                                    | 不变，已经是标准的业务插件                                        |
| Rust `crates/cognia-connectors/src/lark_*`、`sigverify/lark.rs`、`cognia-companion/src/lark_entry.rs`                                                                        | 留在 crate，属于协议层                                            |

**同一规则适用于**：

- **Google**：协议库，加 `auth.google`（`lib/auth-providers/google`、`google_docs_auth.rs`），加 Drive 备份、Docs 等业务实现。
- **GitHub**：协议库（`octokit-factory`、`auth-app`），加 GitHub 连接，加 forge 端口实现（issues 同步、PR 观察、stack）、`backup-github`、github-runner，以及现有的 GitHub 插件。
- **各家订阅**：协议库，加账号登录，加订阅、余额、模型目录三个端口的实现。

**新门禁 G8：框架厂商中立**

- 沿用 `check-provider-name-branches.mjs`（ADR-0090）的做法，把检查范围扩到上述框架目录。
- 现有违规记入基线，只许减少。例如 connectors 框架里约 20 个文件直接 import 飞书适配器。
- 从 M0 起作为棘轮。

**试点**：飞书三层放在 `squads`、`eval` 之后。顺序更新为：`squads` → `eval` → 飞书三层 → `speech` → `pet`。

## 附录 A：复现

```bash
node scripts/gates/convergence/subsystem-deps.mjs --json /tmp/subdeps/deps.json --md /tmp/subdeps/table.md
```

- JSON 里包含每个子系统的 `importers`、`outEdges`、`registryTouch`，以及 `libEdges`（`lib` 层的边，带文件计数）、`giantCycle`、`hubs`、`sharedTables`、`dbModules`。
- 有三项是在这份 JSON 和 `git log --since=60.days` 上跑一次性脚本得到的，没有进仓：§2.2 的贪心拆环、§3.3 的归类矩阵、§2.3 的提交统计。转成门禁后由 G2、G6 取代。

## 附录 B：全量指标（≥1000 行，不含窄基础层、`pkg:`、`plugin:`）

- 入向、出向只数功能子系统。
- 不稳定度 = 出向 ÷（入向 + 出向）。
- lib→UI、lib→他人 store 按 import 语句计数。
- 大环指全部层的最大强连通分量。

<!-- generated by scripts/gates/convergence/subsystem-deps.mjs at 12d5c20691; do not edit by hand -->

| 子系统                 |   行数 | 文件 | 入向（功能） | 出向（功能） | 不稳定度 | lib→UI | lib→他人 store | 注册表种类 |  表 | 共享表 | 60 天 fix | 大环 |
| ---------------------- | -----: | ---: | -----------: | -----------: | -------: | -----: | -------------: | ---------: | --: | -----: | --------: | :--: |
| `settings`             | 198382 |  773 |           35 |          146 |     0.83 |      0 |              0 |          2 |   3 |      2 |        46 |  ●   |
| `plugin`               | 165196 |  830 |           84 |           95 |     0.58 |      8 |             94 |          8 |  15 |     15 |        52 |  ●   |
| `chat`                 | 155087 |  689 |           90 |          122 |     0.61 |      1 |             24 |          8 |   7 |      7 |        55 |  ●   |
| `cli`                  | 143665 |  634 |            0 |           51 |        1 |      0 |              0 |          0 |   0 |      0 |        57 |      |
| `connectors`           |  99605 |  402 |           49 |           54 |     0.59 |      0 |              9 |          7 |  20 |     16 |        36 |  ●   |
| `workflow`             |  94572 |  423 |           39 |           69 |      0.7 |      1 |             13 |          6 |  20 |     11 |        21 |  ●   |
| `ai`                   |  93703 |  430 |           82 |           65 |     0.55 |      2 |             59 |          6 |  26 |     13 |        35 |  ●   |
| `agent`                |  61252 |  299 |           52 |           57 |     0.59 |      1 |              5 |          7 |   8 |      5 |        14 |  ●   |
| `claude`               |  43827 |  177 |           70 |           69 |     0.55 |      2 |             45 |          5 |   0 |      0 |        23 |  ●   |
| `scheduler`            |  41058 |  188 |           46 |           45 |     0.54 |      1 |              3 |          6 |   4 |      3 |        24 |  ●   |
| `a2ui`                 |  35859 |  195 |           18 |           19 |      0.6 |      0 |              1 |          4 |   3 |      3 |         6 |  ●   |
| `mobile`               |  35149 |  171 |           30 |           75 |     0.73 |      0 |              0 |          3 |   0 |      0 |        53 |  ●   |
| `issues`               |  32094 |  146 |           24 |           30 |     0.61 |      0 |              7 |          5 |  13 |     11 |        10 |  ●   |
| `skills`               |  31177 |  189 |           22 |           27 |     0.61 |      0 |              7 |          5 |   8 |      7 |        17 |  ●   |
| `pet`                  |  31028 |  256 |           27 |           29 |     0.56 |      0 |             13 |          5 |   2 |      2 |         4 |  ●   |
| `router-fusion`        |  29637 |  103 |           23 |           28 |     0.64 |      0 |             10 |          3 |   0 |      0 |        12 |  ●   |
| `artifact`             |  25768 |   85 |           32 |           39 |     0.58 |      2 |              8 |          4 |   2 |      2 |        12 |  ●   |
| `terminal`             |  25544 |  134 |           25 |           26 |     0.58 |      0 |             12 |          4 |   0 |      0 |         3 |  ●   |
| `browser`              |  23198 |   95 |           16 |           22 |     0.64 |      0 |              1 |          3 |   0 |      0 |        13 |  ●   |
| `logging`              |  22784 |   56 |           14 |           18 |     0.67 |      0 |              0 |          1 |   0 |      0 |         8 |  ●   |
| `twin`                 |  19484 |   95 |           36 |           19 |     0.48 |      0 |              1 |          4 |   7 |      7 |         8 |  ●   |
| `desktop`              |  17753 |   59 |           17 |           55 |     0.76 |      0 |              5 |          2 |   1 |      1 |        13 |  ●   |
| `canvas`               |  16948 |   86 |           17 |           27 |     0.66 |      1 |              2 |          1 |   4 |      4 |         4 |  ●   |
| `harness`              |  16654 |   63 |            8 |           23 |     0.79 |      0 |              3 |          2 |   1 |      0 |         1 |  ●   |
| `data`                 |  16387 |   95 |           43 |           30 |     0.48 |      0 |              1 |          2 |  77 |     47 |        13 |  ●   |
| `editor`               |  15833 |   47 |           10 |           24 |     0.76 |      0 |              0 |          1 |   0 |      0 |         8 |  ●   |
| `device`               |  15787 |   71 |           21 |           30 |     0.64 |      1 |              1 |          1 |   0 |      0 |        14 |  ●   |
| `inbox`                |  15504 |  103 |           14 |           22 |     0.67 |      0 |              0 |          1 |   7 |      7 |         4 |  ●   |
| `account`              |  15241 |   67 |           47 |           34 |     0.44 |      0 |              0 |          4 |   0 |      0 |        16 |  ●   |
| `memory`               |  15118 |   94 |           29 |           24 |     0.54 |      0 |              1 |          6 |   2 |      2 |         5 |  ●   |
| `files-library`        |  14130 |   85 |            7 |           27 |     0.83 |      0 |             11 |          1 |   3 |      3 |         8 |  ●   |
| `shell`                |  13623 |   74 |           22 |           33 |     0.63 |      0 |              2 |          3 |   0 |      0 |        11 |  ●   |
| `subscription`         |  12950 |  101 |           28 |           13 |     0.41 |      0 |             19 |          4 |   6 |      3 |         2 |  ●   |
| `sites`                |  12863 |   58 |            8 |           24 |     0.79 |      0 |              1 |          2 |   2 |      0 |         4 |  ●   |
| `sync`                 |  12694 |   58 |           20 |           28 |     0.63 |      1 |              8 |          1 |  31 |     25 |        20 |  ●   |
| `execution`            |  12691 |   52 |           35 |           22 |     0.49 |      0 |              4 |          6 |   7 |      7 |        13 |  ●   |
| `bot`                  |  12630 |   78 |           16 |           29 |     0.68 |      0 |              3 |          4 |  12 |     10 |        14 |  ●   |
| `initializers`         |  12197 |  141 |            6 |          114 |     0.95 |      0 |              0 |          1 |   0 |      0 |        23 |  ●   |
| `source-control`       |  12016 |   52 |           10 |           22 |     0.72 |      0 |              0 |          0 |   0 |      0 |         4 |  ●   |
| `appearance`           |  11935 |   77 |           18 |            7 |     0.34 |      1 |             12 |          3 |   0 |      0 |         4 |  ●   |
| `companion`            |  11368 |   37 |           24 |           45 |     0.68 |      0 |              4 |          2 |   3 |      2 |        13 |  ●   |
| `context-workbench`    |  11270 |   50 |           15 |           33 |     0.72 |      0 |              0 |          4 |   0 |      0 |         8 |  ●   |
| `workspace`            |  11264 |   63 |           47 |           30 |     0.43 |      0 |              3 |          6 |   0 |      0 |        10 |  ●   |
| `ai-elements`          |  10571 |   45 |           19 |            3 |     0.21 |      0 |              0 |          0 |   0 |      0 |         1 |  ●   |
| `sandbox`              |  10547 |   50 |           21 |           15 |     0.49 |      0 |              4 |          4 |   0 |      0 |         5 |  ●   |
| `collab`               |  10377 |   36 |           20 |           20 |     0.54 |      0 |              8 |          2 |  10 |      3 |         5 |  ●   |
| `external-bridge`      |  10167 |   39 |            6 |           24 |     0.84 |      0 |              3 |          1 |   6 |      6 |         1 |  ●   |
| `goal`                 |  10038 |   62 |           18 |           23 |     0.61 |      0 |              1 |          5 |   4 |      4 |         2 |  ●   |
| `templates`            |   9569 |   43 |           15 |           19 |      0.6 |      0 |              7 |          4 |   0 |      0 |         8 |  ●   |
| `usage`                |   9441 |   52 |           30 |           17 |     0.42 |      1 |              4 |          4 |   7 |      7 |         0 |  ●   |
| `eval`                 |   8580 |   33 |            2 |            9 |     0.82 |      0 |              0 |          0 |   0 |      0 |         3 |  ●   |
| `notifications`        |   8457 |   62 |           30 |           15 |     0.42 |      2 |              4 |          1 |   6 |      2 |         6 |  ●   |
| `share`                |   8422 |   40 |           35 |           18 |      0.4 |      0 |              0 |          2 |   1 |      1 |         7 |  ●   |
| `automation`           |   8419 |   37 |           18 |           12 |      0.5 |      1 |              5 |          5 |  10 |      8 |         3 |  ●   |
| `connectivity`         |   8220 |   44 |           16 |           18 |     0.58 |      0 |              0 |          0 |   0 |      0 |        12 |  ●   |
| `perf`                 |   8135 |   37 |           14 |            9 |     0.47 |      0 |              1 |          3 |   4 |      2 |         1 |  ●   |
| `glance`               |   8046 |   48 |            9 |           21 |     0.76 |      0 |              0 |          2 |   0 |      0 |         1 |  ●   |
| `global-search`        |   7805 |   44 |           10 |           33 |      0.8 |      3 |              4 |          1 |   0 |      0 |         3 |  ●   |
| `session-import`       |   7777 |   39 |           11 |           12 |     0.69 |      0 |              0 |          2 |   0 |      0 |         2 |  ●   |
| `observability`        |   7695 |   54 |           15 |            5 |      0.4 |      0 |              0 |          2 |   0 |      0 |         2 |  ●   |
| `slash-commands`       |   7244 |   33 |           17 |           27 |     0.66 |      0 |             21 |          3 |   0 |      0 |         7 |  ●   |
| `account-sync`         |   7125 |   53 |            9 |           10 |     0.58 |      0 |              1 |          1 |   5 |      1 |         8 |  ●   |
| `policy`               |   6956 |   25 |           23 |           13 |     0.42 |      0 |              3 |          1 |   0 |      0 |         7 |  ●   |
| `integrations`         |   6927 |   23 |           12 |           19 |     0.68 |      0 |              0 |          3 |   7 |      6 |        10 |  ●   |
| `project-environment`  |   6680 |   19 |            9 |           11 |     0.58 |      0 |              2 |          0 |   1 |      1 |         1 |  ●   |
| `onboarding`           |   6636 |   43 |            6 |           21 |     0.83 |      1 |              0 |          0 |   0 |      0 |         2 |  ●   |
| `git`                  |   6625 |   39 |           28 |           18 |     0.47 |      0 |              0 |          2 |   0 |      0 |         4 |  ●   |
| `remote-host`          |   6611 |   35 |           28 |           24 |     0.52 |      0 |              0 |          3 |   0 |      0 |         6 |  ●   |
| `task-workspace`       |   6162 |   23 |           26 |           11 |     0.33 |      0 |              5 |          1 |   0 |      0 |         9 |  ●   |
| `filespace`            |   5874 |   33 |           14 |           16 |     0.58 |      0 |              5 |          3 |   0 |      0 |         1 |  ●   |
| `settings-store`       |   5742 |   27 |           95 |           17 |     0.22 |      1 |              0 |          7 |   3 |      3 |         7 |  ●   |
| `performance`          |   5529 |   24 |            1 |            9 |     0.86 |      0 |              0 |          0 |   2 |      2 |         2 |  ●   |
| `fleet`                |   5528 |   28 |           15 |           13 |     0.52 |      0 |              3 |          1 |   0 |      0 |         5 |  ●   |
| `mcp`                  |   5524 |   32 |           17 |           10 |     0.44 |      0 |              0 |          2 |   5 |      3 |         5 |  ●   |
| `runtime`              |   5473 |   30 |           57 |           32 |     0.38 |      0 |              1 |          3 |   0 |      0 |        14 |  ●   |
| `voice`                |   5442 |   23 |            2 |            7 |     0.86 |      0 |              2 |          0 |   0 |      0 |         0 |  ●   |
| `discover`             |   5376 |   29 |            2 |           24 |     0.94 |      0 |              0 |          0 |   0 |      0 |         3 |  ●   |
| `me`                   |   4820 |   52 |            0 |           26 |        1 |      0 |              0 |          0 |   0 |      0 |        10 |      |
| `capacitor`            |   4710 |   34 |           32 |            4 |     0.14 |      0 |              0 |          2 |   0 |      0 |         5 |  ●   |
| `headless`             |   4602 |   40 |            8 |           44 |     0.87 |      0 |              3 |          1 |   0 |      0 |        10 |  ●   |
| `status`               |   4479 |   31 |            1 |            1 |     0.83 |      0 |              0 |          0 |   0 |      0 |         4 |  ●   |
| `codeserver`           |   4372 |   24 |           12 |           11 |     0.54 |      0 |              0 |          0 |   0 |      0 |         2 |  ●   |
| `identity`             |   4203 |   23 |           14 |            9 |     0.42 |      0 |              0 |          2 |   9 |      1 |         5 |  ●   |
| `project-coordinator`  |   4185 |   36 |            9 |           24 |     0.76 |     10 |              4 |          3 |   0 |      0 |         3 |  ●   |
| `external-services`    |   4141 |   23 |           12 |           12 |     0.54 |      0 |              0 |          2 |   8 |      7 |         1 |  ●   |
| `gateway`              |   3964 |   14 |            8 |           15 |     0.71 |      0 |              4 |          2 |   0 |      0 |         1 |  ●   |
| `file`                 |   3938 |   28 |           57 |           13 |     0.23 |      0 |              4 |          4 |   0 |      0 |         4 |  ●   |
| `squads`               |   3927 |   24 |            4 |           18 |     0.85 |      0 |              0 |          0 |   3 |      3 |         7 |  ●   |
| `browser-companion`    |   3878 |   13 |            6 |           12 |     0.73 |      0 |              1 |          3 |   0 |      0 |         3 |  ●   |
| `servers`              |   3852 |   17 |            1 |            6 |     0.89 |      0 |              0 |          0 |   0 |      0 |         3 |  ●   |
| `web`                  |   3829 |   19 |           14 |            4 |     0.42 |      0 |              0 |          1 |   0 |      0 |         2 |  ●   |
| `updates`              |   3695 |   24 |            3 |            9 |     0.84 |      0 |              3 |          2 |   0 |      0 |         0 |  ●   |
| `agent-runs`           |   3694 |   19 |            5 |           13 |     0.78 |      0 |              0 |          0 |   0 |      0 |         7 |  ●   |
| `dev`                  |   3599 |    4 |            1 |           14 |     0.94 |      1 |             10 |          1 |  12 |     11 |         7 |  ●   |
| `reply-copilot`        |   3431 |   17 |            6 |            9 |     0.71 |      0 |              0 |          1 |   0 |      0 |         1 |  ●   |
| `prompts`              |   3429 |   30 |           33 |           36 |     0.55 |      0 |              7 |          4 |   0 |      0 |         0 |  ●   |
| `tray`                 |   3365 |   23 |            6 |           12 |     0.75 |      5 |              3 |          2 |   0 |      0 |         1 |  ●   |
| `remote-desktop`       |   3287 |   19 |            3 |            4 |     0.67 |      0 |              0 |          1 |   0 |      0 |         1 |  ●   |
| `provider-diagnostics` |   3209 |   14 |            5 |            8 |     0.71 |      0 |              3 |          0 |   4 |      0 |         2 |  ●   |
| `creator`              |   3106 |   22 |            1 |           10 |     0.93 |      0 |              1 |          0 |   0 |      0 |         1 |  ●   |
| `docs-providers`       |   2982 |   27 |           15 |            6 |     0.44 |      0 |              0 |          1 |   2 |      2 |         4 |  ●   |
| `best-of-n`            |   2804 |   18 |            6 |           12 |     0.74 |      1 |              2 |          3 |   3 |      3 |         3 |  ●   |
| `signaling`            |   2781 |   11 |           11 |            5 |     0.41 |      0 |              0 |          0 |   0 |      0 |         2 |  ●   |
| `shared`               |   2771 |   12 |           34 |           11 |     0.29 |      0 |              0 |          1 |   0 |      0 |         4 |  ●   |
| `conversations`        |   2744 |   12 |            3 |           18 |     0.89 |      0 |              0 |          0 |   0 |      0 |         0 |  ●   |
| `diagnostic-service`   |   2716 |   11 |            5 |            6 |     0.58 |      0 |              0 |          2 |   0 |      0 |         0 |  ●   |
| `selection-toolbar`    |   2683 |    9 |            4 |            5 |     0.67 |      0 |              0 |          1 |   0 |      0 |         0 |  ●   |
| `tray-panel`           |   2657 |   16 |            3 |            6 |     0.75 |      0 |              0 |          1 |   0 |      0 |         0 |  ●   |
| `error`                |   2607 |   14 |            8 |           10 |     0.65 |      0 |              0 |          1 |   0 |      0 |         1 |  ●   |
| `native`               |   2551 |   17 |           29 |            8 |     0.31 |      0 |              1 |          3 |   0 |      0 |         1 |  ●   |
| `wiki`                 |   2519 |   19 |            4 |            6 |     0.64 |      0 |              0 |          0 |   0 |      0 |         1 |  ●   |
| `platform`             |   2512 |   14 |           90 |            5 |      0.1 |      0 |              0 |          7 |   0 |      0 |         3 |  ●   |
| `work-submission`      |   2489 |   12 |            5 |           10 |     0.72 |      0 |              1 |          2 |  12 |     10 |         4 |  ●   |
| `data-governance`      |   2468 |    2 |            3 |            0 |        0 |      0 |              0 |          0 |   0 |      0 |         7 |      |
| `shell-intelligence`   |   2464 |   12 |            1 |            3 |     0.83 |      0 |              0 |          0 |   0 |      0 |         0 |  ●   |
| `island`               |   2442 |   19 |            5 |            7 |     0.67 |      2 |              2 |          1 |   0 |      0 |         1 |  ●   |
| `thread-handoff`       |   2441 |   10 |            9 |           16 |      0.7 |      0 |              0 |          2 |   3 |      3 |         0 |  ●   |
| `plugin-runtime`       |   2417 |    6 |           16 |            1 |      0.2 |      0 |              0 |          3 |   0 |      0 |         3 |  ●   |
| `scm`                  |   2387 |   12 |            4 |            7 |     0.67 |      0 |              0 |          0 |   0 |      0 |         0 |  ●   |
| `boot`                 |   2278 |   13 |            6 |            2 |     0.43 |      0 |              0 |          2 |   0 |      0 |         3 |  ●   |
| `export`               |   2194 |   17 |            7 |            4 |     0.42 |      0 |              0 |          1 |   0 |      0 |         1 |  ●   |
| `logto`                |   2091 |   11 |            9 |           11 |     0.57 |      0 |              0 |          1 |   0 |      0 |         7 |  ●   |
| `stack`                |   2085 |   13 |            8 |            4 |     0.33 |      0 |              0 |          0 |   0 |      0 |         0 |  ●   |
| `knowledge-base`       |   2067 |    9 |            6 |            3 |     0.53 |      0 |              0 |          2 |   4 |      2 |         0 |  ●   |
| `agent-team`           |   2042 |   16 |           12 |            5 |     0.37 |      0 |              1 |          3 |   4 |      4 |         3 |  ●   |
| `network`              |   2037 |   13 |           42 |            8 |     0.22 |      0 |              1 |          4 |   0 |      0 |         2 |  ●   |
| `images`               |   2017 |    9 |            4 |            0 |        0 |      0 |              0 |          1 |   0 |      0 |         0 |      |
| `cli-bridge`           |   1921 |   16 |            9 |           11 |     0.63 |      0 |              5 |          1 |   5 |      5 |         0 |  ●   |
| `storage`              |   1840 |   15 |            9 |            7 |     0.53 |      0 |              0 |          2 |   2 |      2 |         1 |  ●   |
| `telemetry`            |   1795 |   10 |           18 |            1 |     0.18 |      0 |              0 |          3 |   0 |      0 |         0 |  ●   |
| `github`               |   1762 |   10 |            7 |            1 |     0.42 |      0 |              0 |          1 |   0 |      0 |         1 |  ●   |
| `pi-packages`          |   1759 |   11 |            4 |            4 |      0.6 |      0 |              0 |          1 |   0 |      0 |         0 |  ●   |
| `server-ops`           |   1758 |    7 |            2 |            1 |      0.5 |      0 |              0 |          0 |   0 |      0 |         0 |  ●   |
| `shortcuts`            |   1744 |   15 |           20 |            3 |     0.22 |      0 |              0 |          1 |   0 |      0 |         0 |  ●   |
| `placement`            |   1714 |   15 |           11 |            5 |     0.37 |      0 |              1 |          1 |   1 |      0 |         1 |  ●   |
| `governance`           |   1704 |   10 |            7 |            1 |     0.38 |      0 |              0 |          0 |   0 |      0 |         0 |  ●   |
| `loop`                 |   1603 |   14 |            6 |            5 |     0.53 |      0 |              0 |          1 |   0 |      0 |         0 |  ●   |
| `ocr`                  |   1541 |   40 |           26 |            4 |     0.23 |      0 |              0 |          4 |   0 |      0 |         0 |  ●   |
| `diagnostics`          |   1533 |   17 |           10 |            5 |      0.5 |      0 |              2 |          0 |   0 |      0 |         3 |  ●   |
| `rag`                  |   1434 |    8 |           11 |            7 |     0.56 |      0 |              0 |          0 |   1 |      1 |         0 |  ●   |
| `feature-shell`        |   1426 |    5 |           31 |            0 |     0.09 |      0 |              0 |          1 |   0 |      0 |         2 |      |
| `sftp`                 |   1393 |    5 |            3 |            3 |      0.7 |      0 |              0 |          2 |   0 |      0 |         1 |  ●   |
| `background-tasks`     |   1340 |    4 |            9 |            6 |     0.44 |      0 |              0 |          2 |   0 |      0 |         1 |  ●   |
| `agent-migration`      |   1334 |   10 |            2 |           13 |     0.89 |      0 |              0 |          0 |   0 |      0 |         1 |  ●   |
| `review`               |   1296 |    7 |            4 |            6 |     0.62 |      0 |              0 |          0 |   0 |      0 |         0 |  ●   |
| `ccswitch`             |   1273 |   12 |            3 |            5 |     0.75 |      0 |              1 |          0 |   0 |      0 |         0 |  ●   |
| `theme`                |   1245 |    8 |           10 |            2 |     0.29 |      0 |              0 |          1 |   0 |      0 |         1 |  ●   |
| `tasks`                |   1230 |    9 |            9 |            5 |      0.5 |      0 |              3 |          0 |   0 |      0 |         1 |  ●   |
| `credentials`          |   1230 |    5 |           25 |            3 |     0.16 |      0 |              0 |          2 |   0 |      0 |         1 |  ●   |
| `document`             |   1213 |    6 |            1 |            0 |     0.67 |      0 |              0 |          0 |   0 |      0 |         0 |      |
| `project-knowledge`    |   1183 |    7 |            5 |            4 |      0.6 |      0 |              0 |          3 |   4 |      3 |         0 |  ●   |
| `audio`                |   1168 |    5 |            1 |            0 |      0.5 |      0 |              0 |          0 |   0 |      0 |         0 |      |
| `code-adoption`        |   1160 |    6 |            6 |            2 |      0.4 |      0 |              2 |          1 |   1 |      1 |         1 |  ●   |
| `academic`             |   1123 |   13 |            0 |            0 |        0 |      0 |              0 |          0 |   0 |      0 |         0 |      |
| `queue`                |   1114 |    3 |            5 |            5 |     0.56 |      0 |              0 |          0 |   0 |      0 |         5 |  ●   |
| `outbound`             |   1100 |    6 |            5 |            7 |     0.67 |      0 |              0 |          1 |  12 |      7 |         0 |  ●   |
| `webdav`               |   1098 |   13 |            5 |            5 |     0.58 |      0 |              0 |          0 |   0 |      0 |         1 |  ●   |
| `file-viewer`          |   1089 |   14 |            9 |            4 |      0.4 |      0 |              1 |          0 |   0 |      0 |         1 |  ●   |
| `decisions`            |   1029 |   11 |            3 |            2 |     0.63 |      0 |              0 |          1 |   0 |      0 |         0 |  ●   |
| `editor-workbench`     |   1007 |    6 |            5 |            4 |     0.44 |      0 |              0 |          1 |   0 |      0 |         0 |  ●   |
