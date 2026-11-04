---
title: "0251 — Sites 是通过用户自己的 Cloudflare 账号发布的可选应用"
description: "Sites 把用户已有的项目发布到用户自己的 Cloudflare 账号，带不可变版本和可恢复的操作。它是可选应用：现在是模块，按 ADR-0250 §14 属于插件候选。它没有自己的 Rust 代码，也没有设置键，但拥有九张核心表，外部有五个文件引用它的状态词汇。Cloudflare 是唯一的供应商，凭据只留在本机钥匙串里，供应商结果不确定时走对账而不是重试。按 §9 的三个抽取条件，Sites 目前一个都没满足。本 ADR 列出需要先改的事，把这些表的去向留到真正抽取时再定。"
---

# ADR 0251 — Sites 是通过用户自己的 Cloudflare 账号发布的可选应用

**状态：** 提议中
**日期：** 2026-11-05

**相关：**
- [ADR-0084](./0084-cognia-sites)：Sites 的生命周期、持久化、隔离构建和访客访问。本 ADR 不改动其中任何一条。
- [ADR-0250](./0250-the-runtime-is-a-headless-kernel-the-desktop-embeds)：§9（抽取规则）与 §14（分类、清单、闸门）
- [ADR-0246](./0246-a-business-plugin-reaches-a-service-through-a-granted-connection)：授权连接，插件可使用凭据的模型
- [ADR-0059](./0059-cloud-deployment-headless-brain)：无头 brain，目前还没有钥匙串

**证据：** `docs/research/feature-module-analysis-2026-11-04.md`（§11.2 决定 Sites 以后可以抽成插件，并要求补写本 ADR）。下面的数字取自 2026-11-05 的代码树。

## 背景

ADR-0084 规定了一个 Site 怎样构建、版本化、部署和恢复。它没有说明 Sites 在 Cognia 的子系统中处于什么位置、别的部分可以怎样依赖它、其中有多少真的是 Cloudflare、它能不能离开应用。ADR-0250 §14 现在需要这些答案：它把 Sites 归为可选应用，§9 则规定模块只有同时满足三个条件才能变成插件。

Sites 约 12.9k 行、58 个文件。大部分是建在持久化操作状态机之上的控制台界面。供应商相关的代码只有一个目录。

## 决定

### 1. Sites 做什么，不做什么

Sites 把用户已有的项目，从用户自己的工作区，发布到用户自己的 Cloudflare 账号。它保存不可变的版本，通过重新部署旧版本来回滚，并管理这个站点的环境变量、资源、访客访问、域名、日志和下线。

它不是：
- **托管服务。** Cognia 不为 Sites 运行任何基础设施。部署出来的站点、数据和账单都归用户的 Cloudflare 账号。Cognia 关闭后，站点照常提供服务。
- **建站工具。** 源码、编辑、Git、终端、浏览器预览和产物属于项目、编辑器、源码管理、终端和浏览器这些子系统，Sites 只是调用它们（ADR-0084）。
- **分享链接、文档站或官网。** 分享链接是 ADR-0037 的服务；文档站是 `docs/`；官网是独立仓库。
- **服务器运维。** 把 Cognia 自己的服务部署到用户的机器上是 Ops Controller 的事（ADR-0059）。Sites 部署的是用户的项目。
- **多供应商抽象。** 见第 3 节。
- **无人值守的发布器。** 下线和清除只能在控制台里做，工作流节点碰不到（`lib/workflow/nodes/sites/index.ts`）。

### 2. 边界

**Sites 拥有。**

| 类别 | 内容 |
| --- | --- |
| 代码 | `lib/sites/`（含 `lib/sites/cloudflare/`）、`components/sites/`、`hooks/sites/`、`stores/sites/`、`app/sites/`、`lib/db/sites.ts` |
| 类型 | `SiteProjectRow` 等行类型，定义在 `packages/plugin-contract/src/types/sites.ts`，由 `types/sites.ts` 再导出 |
| 文案 | `i18n/messages/{en,zh-CN}/sites.json` |
| 路由 | `/sites`，声明在 `lib/runtime/surface-contract.ts`、侧栏契约和 `lib/shell/full-viewport-routes.ts`。独立运行为 `full`，伴随设备为 `remote` |
| 数据表 | 九张：`siteProjects`、`siteVersions`、`siteArtifacts`、`siteEnvironmentRevisions`、`siteDeployments`、`siteOperations`、`siteOperationEvents`、`siteResources`、`siteBuildLogs`。都在 `CURRENT_SCHEMA` 和 `CORE_TABLE_NAMES` 里；其中三张的保留策略在 `lib/data-governance/table-catalog.ts` |
| 凭据 | 每个 Site 一条系统钥匙串条目，服务名 `cognia-sites`；另有 `siteProjects` 上的 `providerTokenState`，让界面不读取令牌就能知道有没有令牌。wrangler 二进制在共享的已批准二进制表里使用一个台账 id：`builtin:cognia-sites` |
| 注册项 | 工作流节点 `action.site.{build,deploy,rollback,status}` 及其检查器表单、全局搜索提供者 `builtin.sites`、只读插件 API `ctx.sites`、`SitesInitializer`（账号解锁时做恢复和通知）、`lib/storage/retention.ts` 里的产物清理 |
| 设置键 | 没有。Sites 不读任何 `AppSettings` 键 |
| Rust 与宿主命令 | 没有自己的。它调用通用命令：`sandbox_exec`、`git_log`、`git_status`、`detect_binary` 和 `detect_binary_invalidate` |

**Sites 依赖。** 数据库实例、账号存储（授权策略里的操作者身份）、项目与工作区、凭据钥匙串、沙箱策略桥、走代理的 fetch、文件操作、终端启动编排器与终端存储（预览）、内嵌浏览器、通知、工作流引擎、全局搜索和数据治理。这些都属于内核或基础层，所以 Sites 导入的每一项都符合方向规则。

**谁导入 Sites。** 两类：
- **注册项**，也就是 ADR-0250 §14 要变成清单字段的贡献点：工作流目录、全局搜索、保留策略、插件 API、初始化器、schema 和表目录。
- **一套共用词汇。** Sites 之外有五个文件从 `components/sites/site-status` 导入 `SiteTone` 和色调样式类：`components/desktop/status-bar-connectivity.tsx`、`components/devices/execution-host-switcher.tsx`、`components/devices/host-controls.tsx`、`components/settings/connectivity/panels/overview-panel.tsx` 和 `.../remote-hosts-panel.tsx`。它们用它给连接状态上色。这属于基础层的东西放错了位置，也是唯一真正的入向依赖。

### 3. 对 Cloudflare 的依赖

**Cloudflare 是唯一的供应商，代码也如实这样写。** `SiteProvider` 只有一个值 `"cloudflare"`。ADR-0084 说供应商行为放在"Sites 专用的托管边界"之后，但这个边界是一个目录，不是一个接口：hooks、boot、工作流节点以及构建、发布步骤都直接调用 `CloudflareSitesService`。本 ADR 不新增供应商接口。只对着一个实现设计接口，多半会猜错。接口随第二个供应商一起加；在那之前，清单、构建、产物和访客策略的代码保持不导入 Cloudflare，这样将来的接口才有东西可分。

**Sites 如何访问 Cloudflare。**
- **上传。** `wrangler` 在系统沙箱里运行，网络只放行 `api.cloudflare.com`。令牌是它的环境变量，只存在于这个上传进程里。构建本身从不接触凭据（ADR-0084）。
- **其余操作。** D1、R2、secrets、域名、Access 应用和策略、日志与分析，走 `https://api.cloudflare.com/client/v4` 及其 GraphQL 端点，通过应用的代理感知 fetch。
- **凭据。** 用户为每个 Site 提供一个 API 令牌。Sites 用 `/user/tokens/verify` 校验后存入本机钥匙串，且不会再返回。它留在这台主机的钥匙串里，只在该 Site 的执行目标是本机时使用。钥匙串无法枚举，所以 `providerTokenState` 记录 `verified` 或 `rejected`。
- **Wrangler。** 必须能在本机找到。Sites 在台账里批准它的确切字节，二进制缺失或被改动时，上传按失败关闭处理。

**失败模式及其结果。**

| 失败 | 结果 |
| --- | --- |
| 本机没有令牌，或 Cloudflare 拒绝它 | 操作被拒绝并给出明确错误，`providerTokenState` 变为 `rejected` |
| 修改类调用超时、429、5xx 或网络错误 | 结果不确定。操作被标记为待对账，绝不盲目重试（`mutationOutcomeIsUncertain`）。之后的对账读取供应商状态来收尾 |
| 应用在操作中途退出 | 租约过期。下次解锁时 `bootSites` 恢复自己名下所有 Site 的操作 |
| 连不上 Cloudflare | 构建、预览以及读本地库的控制台照常可用，供应商操作失败，已部署的站点不受影响 |
| Access 策略在 Cognia 之外被改动 | 检测到漂移。受限站点按失败关闭处理（ADR-0084） |
| 共享或被接管的资源 | 清除时原样保留（ADR-0084） |
| 不在桌面端 | 每个特权操作都禁用并说明原因。无头 brain 目前无法恢复 Sites，因为 `createLocalKeyringStore` 在 Tauri 之外会抛错（`scripts/gates/headless-registry-exclusions.json`，phase 2）。这是卡在凭据决定上的欠账，不是 Sites 自己的决定 |

Cognia 对 Cloudflare 的其他使用（伴随设备隧道指南、TURN 凭据）与 Sites 相互独立，不共享代码。

### 4. 通向插件的路径

ADR-0250 §9 规定模块必须同时满足三个条件才能作为插件移出；需要自己的 Rust 窗口或宿主命令的模块则保持为模块。Sites 目前的状态：

| 条件 | 状态 | 阻碍 |
| --- | --- | --- |
| 没有自己的 Rust 或宿主命令 | **已满足。** 没有 | 无。它调用的通用命令必须仍能通过插件契约访问 |
| 所有宿主依赖都在插件契约暴露的范围内 | **未满足，部分未核实** | 契约有沙箱、secrets、git、终端、浏览器、通知、数据库和工作流创作这些面。未核实：沙箱面能否表达 Sites 每次调用的挂载、CPU 与内存上限和主机白名单。缺少：操作者身份（插件没有账号，`assertSiteAuthoringCapability` 对它无法运行，`lib/plugin/api/sites.ts` 已有记录）；一个表示"可以发布网站"的权限（目前 `ctx.sites` 是只读的，权限为 `database:read`）。另外未核实：插件能否访问已批准二进制台账 |
| 没有其他模块导入它 | **未满足** | 上面那五个连接状态相关的文件。把 `SiteTone` 移到基础层的状态词汇里即可解决。注册项变成清单贡献之后就不再算导入 |
| 它的表已经定下来 | **未满足** | Sites 在核心 schema 里有九张表。插件的表以 `${pluginId}:${tableName}` 命名空间，所以抽取意味着改名，也就是一次数据迁移 |

**Sites 是否拥有核心表？** 是：九张，都在 `CURRENT_SCHEMA` 和 `CORE_TABLE_NAMES` 里，`siteProjects.projectId` 指向核心的项目。它们只归 Sites 所有：除上面的注册项外，没有别的子系统读写它们，`ctx.sites` 是脱敏的只读投影。

**现在决定的事。**
1. Sites 是可选应用，在三个条件都满足之前保持为模块。本阶段不抽取。
2. 下次改动 `SiteTone` 的五个导入方中的任何一个时，把这套词汇移到基础层。此后，从 Sites 之外新增对 `components/sites/` 或 `lib/sites/` 的导入，即违反 G2 或 G3。
3. 模块轨道推进到 Sites 时，它的清单把路由、九张表、工作流节点、搜索提供者、保留执行器和初始化器声明为贡献，`settings.keys` 为空。
4. Cloudflare 的命名只留在 `lib/sites/cloudflare/`、控制台里与供应商相关的标签页，以及镜像 Cloudflare 对象的类型里。
5. 插件契约只在抽取排上日程时，才为插件新增 Sites 权限和操作者身份，不提前做。新增权限要改目录并重新生成五个产物，所以它是单独的决定。

**这里不决定的事。** 抽取时九张表的去向。选项就是 ADR-0250 §9 的三个：丢弃数据、迁移，或保留核心表并授予插件访问权。丢弃会让受管的 Cloudflare 资源变成孤儿并丢失回滚历史，除非先做一次清除，所以可能性最小。选择取决于契约能授予什么，在抽取排上日程时再定。

## 后果

- Sites 暂时留在应用里，用户的站点不受任何影响。
- 唯一便宜的修复是移动色调词汇，它去掉了唯一的入向依赖，不论抽取最终如何都值得做。
- 第二个供应商、无头的 Sites 宿主和插件形态的 Sites，各自都需要一个这里有意推迟的决定：供应商接口、无头钥匙串，以及带操作者身份的发布权限。每一项都有明确的触发条件，所以都不会被提前投机地建出来。
