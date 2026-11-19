# Cognia → DSH 插件能力逐项清单

日期：2026-11-11，Asia/Shanghai。对应[落地方案](../plans/2026-11-11-cognia-deepseek-harness-plugins.md)。

本表覆盖当前 manifest 与 ownership 表登记的全部 feature owner，并单列 Cognia 插件 manifest。它用于防止盘点遗漏；清单级分类不等于逐模块实现审计、可安装性证明或真实环境验收。方案中链接到具体实现的能力有更深入核对，其余在实施时补调用链证据。

扫描结果：33 个 host manifests、9 个 UI manifests、107 个过渡表模块，共 140 个 feature owner；56 个包 manifest；81 个插件 manifest。

## 1. 每个 feature owner 恰好归入一个能力族

`manifest` 表示当前有显式模块登记；`ownership` 只表示过渡表登记。stage 是源文件中的声明，不能替代 realSmoke；kernel/foundation/shell 不纳入这 140 项。F00–F21 的用户体验、理由与缺口以方案第4节为准。

| Feature owner          | 能力族                             | 优先级       | 接入方式                        | 当前登记证据                                               |
| ---------------------- | ---------------------------------- | ------------ | ------------------------------- | ---------------------------------------------------------- |
| `a2ui`                 | F03 A2UI / Apps                    | P3           | 原生协议+渲染/交互适配          | [stable manifest](../../lib/a2ui/module.ts)                |
| `account-sync`         | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `agent-builder`        | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [stable manifest](../../lib/agent-builder/module.ts)       |
| `agent-config`         | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `agent-ecosystem`      | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `agent-migration`      | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `agent-runs`           | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `agent-tasks`          | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `agent-trace`          | F16 Eval / Observability / Routing | P2→P4        | 读取先行；评测/路由分别适配     | [ownership](../../scripts/gates/module-ownership.json)     |
| `annotations`          | F01 Artifacts / Canvas             | P1→P3        | 原生核心+视图+适配              | [ownership](../../scripts/gates/module-ownership.json)     |
| `appearance`           | F19 Appearance / Pet               | P4           | 可选UI，原生窗口另适配          | [ownership](../../scripts/gates/module-ownership.json)     |
| `artifact`             | F01 Artifacts / Canvas             | P1→P3        | 原生核心+视图+适配              | [stable manifest](../../lib/artifacts/module.ts)           |
| `attention`            | F15 Tasks / Goals                  | P3/P4        | 查看或显式委托，单一调度owner   | [ownership](../../scripts/gates/module-ownership.json)     |
| `audio`                | F17 Media / Speech                 | P3           | 解析/生成/播放分别适配          | [ownership](../../scripts/gates/module-ownership.json)     |
| `automation`           | F11 Browser / Computer Use         | P3           | 复用DSH或连接Cognia Host        | [stable manifest](../../lib/automation/module.ts)          |
| `background-tasks`     | F15 Tasks / Goals                  | P3/P4        | 查看或显式委托，单一调度owner   | [stable manifest](../../lib/background-tasks/module.ts)    |
| `best-of-n`            | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `board`                | F09 Issues / Delivery              | P3           | Host流程+独立UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `bot`                  | F09 Issues / Delivery              | P3           | Host流程+独立UI                 | [stable manifest](../../lib/bot/module.ts)                 |
| `browser`              | F11 Browser / Computer Use         | P3           | 复用DSH或连接Cognia Host        | [ownership](../../scripts/gates/module-ownership.json)     |
| `browser-companion`    | F11 Browser / Computer Use         | P3           | 复用DSH或连接Cognia Host        | [stable manifest](../../lib/browser-companion/module.ts)   |
| `canvas`               | F01 Artifacts / Canvas             | P1→P3        | 原生核心+视图+适配              | [ownership](../../scripts/gates/module-ownership.json)     |
| `capture`              | F01 Artifacts / Canvas             | P1→P3        | 原生核心+视图+适配              | [ownership](../../scripts/gates/module-ownership.json)     |
| `ccswitch`             | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `chat-copilot`         | F07 Research / Radar               | P3           | 工具编排或显式Host委托          | [ownership](../../scripts/gates/module-ownership.json)     |
| `cli-bridge`           | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `code-adoption`        | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `codeserver`           | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [stable manifest](../../lib/codeserver/module.ts)          |
| `cogsets`              | F05 Knowledge / Wiki / Twin        | P2→P3        | 先授权检索，后完整reader        | [ownership](../../scripts/gates/module-ownership.json)     |
| `collab`               | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `commands-import`      | F18 Skills / Authoring             | P2→P4        | 内容先行，录制/治理经Host       | [ownership](../../scripts/gates/module-ownership.json)     |
| `connectors`           | F10 Connectors / Cloud Docs        | P3           | Host连接/授权+读写UI            | [stable manifest](../../lib/connectors/module.ts)          |
| `context-workbench`    | F01 Artifacts / Canvas             | P1→P3        | 原生核心+视图+适配              | [ownership](../../scripts/gates/module-ownership.json)     |
| `creator`              | F18 Skills / Authoring             | P2→P4        | 内容先行，录制/治理经Host       | [ownership](../../scripts/gates/module-ownership.json)     |
| `device`               | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `diagnostic-service`   | F16 Eval / Observability / Routing | P2→P4        | 读取先行；评测/路由分别适配     | [ownership](../../scripts/gates/module-ownership.json)     |
| `diff`                 | F01 Artifacts / Canvas             | P1→P3        | 原生核心+视图+适配              | [ownership](../../scripts/gates/module-ownership.json)     |
| `discover`             | F07 Research / Radar               | P3           | 工具编排或显式Host委托          | [ownership](../../scripts/gates/module-ownership.json)     |
| `document`             | F02 Office / Documents             | P2→P3        | 原生模型/编解码+适配            | [ownership](../../scripts/gates/module-ownership.json)     |
| `document-templates`   | F02 Office / Documents             | P2→P3        | 原生模型/编解码+适配            | [ownership](../../scripts/gates/module-ownership.json)     |
| `durable`              | F15 Tasks / Goals                  | P3/P4        | 查看或显式委托，单一调度owner   | [ownership](../../scripts/gates/module-ownership.json)     |
| `editor`               | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `editor-workbench`     | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `eval`                 | F16 Eval / Observability / Routing | P2→P4        | 读取先行；评测/路由分别适配     | [stable manifest](../../lib/eval/module.ts)                |
| `export`               | F02 Office / Documents             | P2→P3        | 原生模型/编解码+适配            | [ownership](../../scripts/gates/module-ownership.json)     |
| `external-bridge`      | F00 Host Bridge                    | P2           | 连接型                          | [ownership](../../scripts/gates/module-ownership.json)     |
| `external-services`    | F20 Plugin / External Services     | P4           | 逐契约适配，非全集兼容          | [ownership](../../scripts/gates/module-ownership.json)     |
| `file-viewer`          | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `files-library`        | F13 Files / Shares                 | P3           | 复用DSH文件，跨Host另授权       | [ownership](../../scripts/gates/module-ownership.json)     |
| `filespace`            | F13 Files / Shares                 | P3           | 复用DSH文件，跨Host另授权       | [stable manifest](../../lib/filespace/module.ts)           |
| `fleet`                | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `git`                  | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `github`               | F09 Issues / Delivery              | P3           | Host流程+独立UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `glance`               | F19 Appearance / Pet               | P4           | 可选UI，原生窗口另适配          | [ownership](../../scripts/gates/module-ownership.json)     |
| `goal`                 | F15 Tasks / Goals                  | P3/P4        | 查看或显式委托，单一调度owner   | [stable manifest](../../lib/goal/module.ts)                |
| `google-docs`          | F10 Connectors / Cloud Docs        | P3           | Host连接/授权+读写UI            | [stable manifest](../../lib/google-docs/module.ts)         |
| `governance`           | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `harness`              | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `host-admin`           | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `host-consent`         | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `host-installer`       | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `icons`                | F19 Appearance / Pet               | P4           | 可选UI，原生窗口另适配          | [ownership](../../scripts/gates/module-ownership.json)     |
| `images`               | F17 Media / Speech                 | P3           | 解析/生成/播放分别适配          | [ownership](../../scripts/gates/module-ownership.json)     |
| `inbound`              | F10 Connectors / Cloud Docs        | P3           | Host连接/授权+读写UI            | [ownership](../../scripts/gates/module-ownership.json)     |
| `inbox`                | F10 Connectors / Cloud Docs        | P3           | Host连接/授权+读写UI            | [ownership](../../scripts/gates/module-ownership.json)     |
| `integrations`         | F20 Plugin / External Services     | P4           | 逐契约适配，非全集兼容          | [ownership](../../scripts/gates/module-ownership.json)     |
| `island`               | F19 Appearance / Pet               | P4           | 可选UI，原生窗口另适配          | [ownership](../../scripts/gates/module-ownership.json)     |
| `issues`               | F09 Issues / Delivery              | P3           | Host流程+独立UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `jobs`                 | F15 Tasks / Goals                  | P3/P4        | 查看或显式委托，单一调度owner   | [ownership](../../scripts/gates/module-ownership.json)     |
| `knowledge-base`       | F05 Knowledge / Wiki / Twin        | P2→P3        | 先授权检索，后完整reader        | [stable manifest](../../lib/knowledge-base/module.ts)      |
| `labels`               | F09 Issues / Delivery              | P3           | Host流程+独立UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `lark-docs`            | F10 Connectors / Cloud Docs        | P3           | Host连接/授权+读写UI            | [stable manifest](../../lib/lark-docs/module.ts)           |
| `logging`              | F16 Eval / Observability / Routing | P2→P4        | 读取先行；评测/路由分别适配     | [ownership](../../scripts/gates/module-ownership.json)     |
| `loop`                 | F08 Workflow / Playbooks           | P2；编辑器P3 | 先连接已发布部署                | [ownership](../../scripts/gates/module-ownership.json)     |
| `lsp`                  | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `mcp-apps`             | F20 Plugin / External Services     | P4           | 逐契约适配，非全集兼容          | [ownership](../../scripts/gates/module-ownership.json)     |
| `media`                | F17 Media / Speech                 | P3           | 解析/生成/播放分别适配          | [stable manifest](../../lib/media/module.ts)               |
| `memory`               | F04 Memory                         | P2；原生P3   | 先连接既有数据                  | [stable manifest](../../lib/memory/module.ts)              |
| `monaco`               | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `ocr`                  | F06 OCR                            | P2           | 原生核心+文件/凭据适配          | [stable manifest](../../lib/ocr/module.ts)                 |
| `outbound`             | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `performance`          | F16 Eval / Observability / Routing | P2→P4        | 读取先行；评测/路由分别适配     | [ownership](../../scripts/gates/module-ownership.json)     |
| `pet`                  | F19 Appearance / Pet               | P4           | 可选UI，原生窗口另适配          | [stable manifest](../../lib/pet/module.ts)                 |
| `pi-packages`          | F20 Plugin / External Services     | P4           | 逐契约适配，非全集兼容          | [ownership](../../scripts/gates/module-ownership.json)     |
| `playbooks`            | F08 Workflow / Playbooks           | P2；编辑器P3 | 先连接已发布部署                | [beta manifest](../../lib/playbooks/module.ts)             |
| `plugin-convert`       | F20 Plugin / External Services     | P4           | 逐契约适配，非全集兼容          | [ownership](../../scripts/gates/module-ownership.json)     |
| `plugin-devtools`      | F20 Plugin / External Services     | P4           | 逐契约适配，非全集兼容          | [ownership](../../scripts/gates/module-ownership.json)     |
| `plugin-marketplace`   | F20 Plugin / External Services     | P4           | 逐契约适配，非全集兼容          | [ownership](../../scripts/gates/module-ownership.json)     |
| `power`                | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `project-coordinator`  | F09 Issues / Delivery              | P3           | Host流程+独立UI                 | [stable manifest](../../lib/project-coordinator/module.ts) |
| `project-knowledge`    | F05 Knowledge / Wiki / Twin        | P2→P3        | 先授权检索，后完整reader        | [stable manifest](../../lib/project-knowledge/module.ts)   |
| `provider-diagnostics` | F16 Eval / Observability / Routing | P2→P4        | 读取先行；评测/路由分别适配     | [ownership](../../scripts/gates/module-ownership.json)     |
| `qr`                   | F19 Appearance / Pet               | P4           | 可选UI，原生窗口另适配          | [ownership](../../scripts/gates/module-ownership.json)     |
| `radar`                | F07 Research / Radar               | P3           | 工具编排或显式Host委托          | [stable manifest](../../lib/radar/module.ts)               |
| `rag`                  | F05 Knowledge / Wiki / Twin        | P2→P3        | 先授权检索，后完整reader        | [ownership](../../scripts/gates/module-ownership.json)     |
| `recovery`             | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `remote-desktop`       | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `reply-copilot`        | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `review`               | F01 Artifacts / Canvas             | P1→P3        | 原生核心+视图+适配              | [ownership](../../scripts/gates/module-ownership.json)     |
| `routing`              | F16 Eval / Observability / Routing | P2→P4        | 读取先行；评测/路由分别适配     | [ownership](../../scripts/gates/module-ownership.json)     |
| `scm`                  | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `selection`            | F11 Browser / Computer Use         | P3           | 复用DSH或连接Cognia Host        | [ownership](../../scripts/gates/module-ownership.json)     |
| `selection-toolbar`    | F11 Browser / Computer Use         | P3           | 复用DSH或连接Cognia Host        | [ownership](../../scripts/gates/module-ownership.json)     |
| `server-ops`           | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `servers`              | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `session-import`       | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `settings-import`      | F18 Skills / Authoring             | P2→P4        | 内容先行，录制/治理经Host       | [ownership](../../scripts/gates/module-ownership.json)     |
| `sftp`                 | F13 Files / Shares                 | P3           | 复用DSH文件，跨Host另授权       | [ownership](../../scripts/gates/module-ownership.json)     |
| `share`                | F13 Files / Shares                 | P3           | 复用DSH文件，跨Host另授权       | [ownership](../../scripts/gates/module-ownership.json)     |
| `shell-intelligence`   | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `shiki`                | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `sites`                | F03 A2UI / Apps                    | P3           | 原生协议+渲染/交互适配          | [stable manifest](../../lib/sites/module.ts)               |
| `skill-marketplace`    | F18 Skills / Authoring             | P2→P4        | 内容先行，录制/治理经Host       | [ownership](../../scripts/gates/module-ownership.json)     |
| `skill-recorder`       | F18 Skills / Authoring             | P2→P4        | 内容先行，录制/治理经Host       | [ownership](../../scripts/gates/module-ownership.json)     |
| `slash-commands`       | F18 Skills / Authoring             | P2→P4        | 内容先行，录制/治理经Host       | [stable manifest](../../lib/slash-commands/module.ts)      |
| `source-control`       | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `speech`               | F17 Media / Speech                 | P3           | 解析/生成/播放分别适配          | [stable manifest](../../lib/speech/module.ts)              |
| `squads`               | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [stable manifest](../../lib/squads/module.ts)              |
| `stack`                | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `status`               | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `support`              | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `support-agent`        | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `support-report`       | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `tasks`                | F15 Tasks / Goals                  | P3/P4        | 查看或显式委托，单一调度owner   | [stable manifest](../../lib/tasks/module.ts)               |
| `templates`            | F08 Workflow / Playbooks           | P2；编辑器P3 | 先连接已发布部署                | [stable manifest](../../lib/templates/module.ts)           |
| `terminal`             | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [stable manifest](../../lib/terminal/module.ts)            |
| `theme`                | F19 Appearance / Pet               | P4           | 可选UI，原生窗口另适配          | [ownership](../../scripts/gates/module-ownership.json)     |
| `thread-handoff`       | F14 Agents / Squad / Harness       | P3/P4        | 显式委托+结果UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `tray`                 | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `tray-panel`           | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `twin`                 | F05 Knowledge / Wiki / Twin        | P2→P3        | 先授权检索，后完整reader        | [stable manifest](../../lib/twin/module.ts)                |
| `updates`              | F21 Host / Product Infrastructure  | 不整体迁移   | 保留原owner；专用管理插件另立项 | [ownership](../../scripts/gates/module-ownership.json)     |
| `usage-dock`           | F16 Eval / Observability / Routing | P2→P4        | 读取先行；评测/路由分别适配     | [ownership](../../scripts/gates/module-ownership.json)     |
| `vector`               | F05 Knowledge / Wiki / Twin        | P2→P3        | 先授权检索，后完整reader        | [stable manifest](../../lib/vector/module.ts)              |
| `vscode-compat`        | F12 Coding Workbench               | P3/P4        | 增量诊断/审查面板               | [ownership](../../scripts/gates/module-ownership.json)     |
| `webdav`               | F13 Files / Shares                 | P3           | 复用DSH文件，跨Host另授权       | [ownership](../../scripts/gates/module-ownership.json)     |
| `webhooks`             | F10 Connectors / Cloud Docs        | P3           | Host连接/授权+读写UI            | [ownership](../../scripts/gates/module-ownership.json)     |
| `wiki`                 | F05 Knowledge / Wiki / Twin        | P2→P3        | 先授权检索，后完整reader        | [ownership](../../scripts/gates/module-ownership.json)     |
| `work-migration`       | F09 Issues / Delivery              | P3           | Host流程+独立UI                 | [ownership](../../scripts/gates/module-ownership.json)     |
| `workflow`             | F08 Workflow / Playbooks           | P2；编辑器P3 | 先连接已发布部署                | [stable manifest](../../lib/workflow/module.ts)            |

## 2. 81 个 Cognia 插件按迁移用途分类

现有插件通过 `@cognia/plugin-sdk`、`plugin.json` 和 Cognia Host API 激活，不能原样安装到 Cordis。以下是迁移用途判断，不是兼容性结论；示例、fixture、主题及外部服务预设也计入 manifest 总数。

| 插件目录 / ID                                                              | 用途与建议                                                    | 证据                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `agent-team-examples` / `cognia-agent-team-examples`                       | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/agent-team-examples/plugin.json)            |
| `anthropic-skills` / `cognia-anthropic-skills`                             | F18/P2–P3：可移植内容优先；角色/命令/工具引用需校验           | [manifest](../../plugins/anthropic-skills/plugin.json)               |
| `browser-tools` / `cognia-browser-tools`                                   | F11–F13/P3：工具增量；原生权限/文件根/执行机器需适配          | [manifest](../../plugins/browser-tools/plugin.json)                  |
| `clipboard-history` / `cognia-clipboard-history`                           | F11–F13/P3：工具增量；原生权限/文件根/执行机器需适配          | [manifest](../../plugins/clipboard-history/plugin.json)              |
| `clipboard-tools` / `cognia-clipboard-tools`                               | F11–F13/P3：工具增量；原生权限/文件根/执行机器需适配          | [manifest](../../plugins/clipboard-tools/plugin.json)                |
| `cognia-anime-effort` / `cognia-anime-effort`                              | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/cognia-anime-effort/plugin.json)            |
| `cognia-appearance-demo` / `cognia-appearance-demo`                        | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/cognia-appearance-demo/plugin.json)         |
| `cognia-arknights-theme` / `cognia-arknights-theme`                        | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/cognia-arknights-theme/plugin.json)         |
| `cognia-azur-lane-theme` / `cognia-azur-lane-theme`                        | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/cognia-azur-lane-theme/plugin.json)         |
| `cognia-backend-refactor` / `cognia-backend-refactor`                      | F18/P2–P3：可移植内容优先；角色/命令/工具引用需校验           | [manifest](../../plugins/cognia-backend-refactor/plugin.json)        |
| `cognia-bugfix-review` / `cognia-bugfix-review`                            | F18/P2–P3：可移植内容优先；角色/命令/工具引用需校验           | [manifest](../../plugins/cognia-bugfix-review/plugin.json)           |
| `cognia-builtin-characters` / `cognia-builtin-characters`                  | F18/P2–P3：可移植内容优先；角色/命令/工具引用需校验           | [manifest](../../plugins/cognia-builtin-characters/plugin.json)      |
| `cognia-character-seeds` / `cognia-character-seeds`                        | F18/P2–P3：可移植内容优先；角色/命令/工具引用需校验           | [manifest](../../plugins/cognia-character-seeds/plugin.json)         |
| `cognia-documents` / `cognia-documents`                                    | F02/P2–P3：优先复用 model/codec，工具/renderer/export 另接DSH | [manifest](../../plugins/cognia-documents/plugin.json)               |
| `cognia-game-worlds-theme` / `cognia-game-worlds-theme`                    | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/cognia-game-worlds-theme/plugin.json)       |
| `cognia-genshin-theme` / `cognia-genshin-theme`                            | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/cognia-genshin-theme/plugin.json)           |
| `cognia-glance-example` / `cognia-glance-example`                          | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/cognia-glance-example/plugin.json)          |
| `cognia-goal-insights` / `cognia-goal-insights`                            | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/cognia-goal-insights/plugin.json)           |
| `cognia-honkai-star-rail-theme` / `cognia-honkai-star-rail-theme`          | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/cognia-honkai-star-rail-theme/plugin.json)  |
| `cognia-laya-guard` / `cognia-laya-guard`                                  | F20/P4：运行时/模型/工具链另适配，不能靠迁移配置获得          | [manifest](../../plugins/cognia-laya-guard/plugin.json)              |
| `cognia-material-icon-theme` / `cognia-material-icon-theme`                | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/cognia-material-icon-theme/plugin.json)     |
| `cognia-office` / `cognia-office`                                          | F02/P2–P3：优先复用 model/codec，工具/renderer/export 另接DSH | [manifest](../../plugins/cognia-office/plugin.json)                  |
| `cognia-pdf` / `cognia-pdf`                                                | F02/P2–P3：优先复用 model/codec，工具/renderer/export 另接DSH | [manifest](../../plugins/cognia-pdf/plugin.json)                     |
| `cognia-presentations` / `cognia-presentations`                            | F02/P2–P3：优先复用 model/codec，工具/renderer/export 另接DSH | [manifest](../../plugins/cognia-presentations/plugin.json)           |
| `cognia-python-demo` / `cognia-python-demo`                                | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/cognia-python-demo/plugin.json)             |
| `cognia-python-runtime-demo` / `cognia-python-runtime-demo`                | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/cognia-python-runtime-demo/plugin.json)     |
| `cognia-rfc-toolkit` / `cognia-rfc-toolkit`                                | F18/P2–P3：可移植内容优先；角色/命令/工具引用需校验           | [manifest](../../plugins/cognia-rfc-toolkit/plugin.json)             |
| `cognia-sandboxed-tools` / `cognia-sandboxed-tools`                        | F20/P4：运行时/模型/工具链另适配，不能靠迁移配置获得          | [manifest](../../plugins/cognia-sandboxed-tools/plugin.json)         |
| `cognia-scheduler-tools` / `cognia-scheduler-tools`                        | F08/F14/F15/P3：明确编排owner，按能力拆分                     | [manifest](../../plugins/cognia-scheduler-tools/plugin.json)         |
| `cognia-scheduling-demo` / `cognia-scheduling-demo`                        | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/cognia-scheduling-demo/plugin.json)         |
| `cognia-share-watch` / `cognia-share-watch`                                | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/cognia-share-watch/plugin.json)             |
| `cognia-visualize` / `cognia-visualize`                                    | F02/P2–P3：优先复用 model/codec，工具/renderer/export 另接DSH | [manifest](../../plugins/cognia-visualize/plugin.json)               |
| `cognia-work-mode` / `cognia-work-mode`                                    | F08/F14/F15/P3：明确编排owner，按能力拆分                     | [manifest](../../plugins/cognia-work-mode/plugin.json)               |
| `cognia-zenless-zone-zero-theme` / `cognia-zenless-zone-zero-theme`        | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/cognia-zenless-zone-zero-theme/plugin.json) |
| `computer-use` / `cognia-computer-use`                                     | F11–F13/P3：工具增量；原生权限/文件根/执行机器需适配          | [manifest](../../plugins/computer-use/plugin.json)                   |
| `config-governance` / `cognia-config-governance`                           | F16/F18/P3–P4：评测/安全/治理/检查器独立适配                  | [manifest](../../plugins/config-governance/plugin.json)              |
| `context-inspector` / `cognia-context-inspector`                           | F16/F18/P3–P4：评测/安全/治理/检查器独立适配                  | [manifest](../../plugins/context-inspector/plugin.json)              |
| `deep-research` / `cognia-deep-research`                                   | F05/F07/P3：检索/研究/采集，保留引用与网络权限                | [manifest](../../plugins/deep-research/plugin.json)                  |
| `e2b-sandbox` / `cognia-e2b-sandbox`                                       | F20/P4：服务配置可映射MCP；凭据/授权/会话独立配置             | [manifest](../../plugins/e2b-sandbox/plugin.json)                    |
| `eval` / `cognia-eval`                                                     | F16/F18/P3–P4：评测/安全/治理/检查器独立适配                  | [manifest](../../plugins/eval/plugin.json)                           |
| `example-auth-provider` / `cognia-example-auth-provider`                   | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/example-auth-provider/plugin.json)          |
| `example-backup-destination` / `cognia-example-backup-destination`         | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/example-backup-destination/plugin.json)     |
| `example-docs-provider` / `cognia-example-docs-provider`                   | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/example-docs-provider/plugin.json)          |
| `example-issue-sync` / `cognia-example-issue-sync`                         | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/example-issue-sync/plugin.json)             |
| `example-sync` / `cognia-example-sync`                                     | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/example-sync/plugin.json)                   |
| `external-agent-adapter-example` / `cognia-external-agent-adapter-example` | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/external-agent-adapter-example/plugin.json) |
| `external-agent-preset-example` / `cognia-external-agent-preset-example`   | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/external-agent-preset-example/plugin.json)  |
| `feishu-auth` / `feishu-auth`                                              | F09/F10/P3：Host业务/连接先行，原生适配另评估                 | [manifest](../../plugins/feishu-auth/plugin.json)                    |
| `feishu-calendar` / `feishu-calendar`                                      | F09/F10/P3：Host业务/连接先行，原生适配另评估                 | [manifest](../../plugins/feishu-calendar/plugin.json)                |
| `figma-external-service` / `figma-external-service`                        | F20/P4：服务配置可映射MCP；凭据/授权/会话独立配置             | [manifest](../../plugins/figma-external-service/plugin.json)         |
| `github-comment-bot` / `github-comment-bot`                                | F09/F10/P3：Host业务/连接先行，原生适配另评估                 | [manifest](../../plugins/github-comment-bot/plugin.json)             |
| `github-delivery` / `github-delivery`                                      | F09/F10/P3：Host业务/连接先行，原生适配另评估                 | [manifest](../../plugins/github-delivery/plugin.json)                |
| `github-devin-bot` / `github-devin-bot`                                    | F09/F10/P3：Host业务/连接先行，原生适配另评估                 | [manifest](../../plugins/github-devin-bot/plugin.json)               |
| `impeccable` / `cognia-impeccable`                                         | F18/P2–P3：可移植内容优先；角色/命令/工具引用需校验           | [manifest](../../plugins/impeccable/plugin.json)                     |
| `kimi-subscription` / `cognia-kimi-subscription`                           | F20/P4：模型账户能力按DSH provider契约适配，不复制凭据        | [manifest](../../plugins/kimi-subscription/plugin.json)              |
| `minimax-subscription` / `cognia-minimax-subscription`                     | F20/P4：模型账户能力按DSH provider契约适配，不复制凭据        | [manifest](../../plugins/minimax-subscription/plugin.json)           |
| `ocr` / `cognia-ocr`                                                       | F06/P2：复用OCR核心，适配文件/凭据/provider                   | [manifest](../../plugins/ocr/plugin.json)                            |
| `pagerduty` / `pagerduty`                                                  | F09/F10/P3：Host业务/连接先行，原生适配另评估                 | [manifest](../../plugins/pagerduty/plugin.json)                      |
| `pet-daily-quests` / `pet-daily-quests`                                    | F19/P4：主题/浮层/宠物，适配DSH token和生命周期               | [manifest](../../plugins/pet-daily-quests/plugin.json)               |
| `pi-latex-workbench` / `cognia-pi-latex-workbench`                         | F20/P4：运行时/模型/工具链另适配，不能靠迁移配置获得          | [manifest](../../plugins/pi-latex-workbench/plugin.json)             |
| `playwright-mcp` / `cognia-playwright-mcp`                                 | F20/P4：服务配置可映射MCP；凭据/授权/会话独立配置             | [manifest](../../plugins/playwright-mcp/plugin.json)                 |
| `prompt-templates` / `cognia-prompt-templates`                             | F18/P2–P3：可移植内容优先；角色/命令/工具引用需校验           | [manifest](../../plugins/prompt-templates/plugin.json)               |
| `remote-desktop-rustdesk` / `cognia-remote-desktop-rustdesk`               | F21/P4：专用设备入口，不迁移Host管理全集                      | [manifest](../../plugins/remote-desktop-rustdesk/plugin.json)        |
| `remote-desktop-vnc` / `cognia-remote-desktop-vnc`                         | F21/P4：专用设备入口，不迁移Host管理全集                      | [manifest](../../plugins/remote-desktop-vnc/plugin.json)             |
| `remote-desktop-web-console` / `cognia-remote-desktop-web-console`         | F21/P4：专用设备入口，不迁移Host管理全集                      | [manifest](../../plugins/remote-desktop-web-console/plugin.json)     |
| `repowiki` / `cognia-repowiki`                                             | F05/F07/P3：检索/研究/采集，保留引用与网络权限                | [manifest](../../plugins/repowiki/plugin.json)                       |
| `ripgrep-tools` / `ripgrep-tools`                                          | F11–F13/P3：工具增量；原生权限/文件根/执行机器需适配          | [manifest](../../plugins/ripgrep-tools/plugin.json)                  |
| `screenshot` / `cognia-screenshot`                                         | F11–F13/P3：工具增量；原生权限/文件根/执行机器需适配          | [manifest](../../plugins/screenshot/plugin.json)                     |
| `skill-recorder` / `cognia-skill-recorder`                                 | F11–F13/P3：工具增量；原生权限/文件根/执行机器需适配          | [manifest](../../plugins/skill-recorder/plugin.json)                 |
| `sre-agent` / `sre-agent`                                                  | F09/F10/P3：Host业务/连接先行，原生适配另评估                 | [manifest](../../plugins/sre-agent/plugin.json)                      |
| `stagehand-mcp` / `cognia-stagehand-mcp`                                   | F20/P4：服务配置可映射MCP；凭据/授权/会话独立配置             | [manifest](../../plugins/stagehand-mcp/plugin.json)                  |
| `strix-security` / `strix-security`                                        | F16/F18/P3–P4：评测/安全/治理/检查器独立适配                  | [manifest](../../plugins/strix-security/plugin.json)                 |
| `test-lsp-contribution` / `cognia-test-lsp-contribution`                   | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/test-lsp-contribution/plugin.json)          |
| `ui-surface-reference` / `ui-surface-reference`                            | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/ui-surface-reference/plugin.json)           |
| `wasm-example-formatter` / `wasm-example-formatter`                        | 示例/参考/fixture：学习契约；不进入首发生产能力承诺           | [manifest](../../plugins/wasm-example-formatter/plugin.json)         |
| `web-clone` / `cognia-web-clone`                                           | F05/F07/P3：检索/研究/采集，保留引用与网络权限                | [manifest](../../plugins/web-clone/plugin.json)                      |
| `web-tools` / `cognia-web-tools`                                           | F05/F07/P3：检索/研究/采集，保留引用与网络权限                | [manifest](../../plugins/web-tools/plugin.json)                      |
| `workflow-ai` / `cognia-workflow-ai`                                       | F08/F14/F15/P3：明确编排owner，按能力拆分                     | [manifest](../../plugins/workflow-ai/plugin.json)                    |
| `workspace-tools` / `cognia-workspace-tools`                               | F11–F13/P3：工具增量；原生权限/文件根/执行机器需适配          | [manifest](../../plugins/workspace-tools/plugin.json)                |
| `zhihu-content-pipeline` / `zhihu-content-pipeline`                        | F09/F10/P3：Host业务/连接先行，原生适配另评估                 | [manifest](../../plugins/zhihu-content-pipeline/plugin.json)         |
| `zhipu-subscription` / `cognia-zhipu-subscription`                         | F20/P4：模型账户能力按DSH provider契约适配，不复制凭据        | [manifest](../../plugins/zhipu-subscription/plugin.json)             |

## 3. 重跑与边界

枚举 `lib/**/module.ts` 的 `id`，与 `scripts/gates/module-ownership.json` 中 `class=module` 的键做并集，再验证每个ID只分到一个F族；分别枚举 `components/**/module.ui.ts`、`packages/*/package.json`、`plugins/*/plugin.json`。这是本轮实际使用的统计方法。

这里未将目录存在、manifest stage 或单测文件存在视为功能通过验收；未运行coverage、产品测试、DSH安装或真实provider。新增/删除模块或并发修改后需重新计数，当前快照不保证未来工作区不变。
