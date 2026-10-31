# plugins/ 独立仓库就绪度调查

日期：2026-10-30（Asia/Shanghai）。对象：当前工作树中的 `plugins/` 及其构建、SDK、Host 和验证链路。本轮只做研究并新增本报告，没有迁移代码、创建远程仓库或提交。

## 结论

**可以启动拆仓前置工作；现有产物接入基础尚未达到删除插件源码的标准。** 推荐建立一个 `cognia-labs/cognia-plugins` monorepo，集中管理第一方插件。产品仓库继续拥有 Host、SDK/contract、运行时、产品收录策略和 artifact consumer；插件仓库拥有插件实现、资源、插件测试和 artifact producer。

主要剩余工作在构建输入、依赖交付、测试归属与跨仓版本固定。现有 artifact consumer 已经支持没有 `plugins/` 的产品 checkout；producer 和若干验证仍依赖产品源码布局。两者必须分开验收。[artifact consumer](../../scripts/build/stage-plugin-artifacts.mjs#L45-L70)、[frontend builder](../../scripts/plugin/build-frontend-plugins.mjs#L174-L208)

### 2026-10-30 对抗性复审修正

首次调查中的“运行时边界已经具备”表述过强。复审已用隔离 fixture/compiler 探针确认：空或不兼容的 artifact 可通过当前校验；CLI 存在 warm cache 忽略显式输入和先编译旧 catalog 后复制新资源的路径；排除插件源码后，三个实际使用的 Tailwind selector 消失。截图 resolver 还保留旧 public mirror URL；资源已进包不足以保证请求路径正确。

SDK 分发也需要明确选择：SDK/UI/GitHub kit 三个根的 manifest 生产/optional 依赖闭包涉及 23 个内部包，仅有 root declarations 不足以覆盖全部真实插件。53 个 SDK runtime entry 的合并探针支持构建独立 authoring kit 的方向，但未证明独立安装/声明/运行时绑定。

完整审查裁决、选定合同、实施阶段、验收矩阵与回滚见 [第一方插件拆仓完整方案](../plans/2026-10-30-plugins-repository-extraction.md)。先在现仓修复前置缺口并形成稳定基线 B，再迁移 B；本次复审没有修复生产代码或执行拆仓。以下规模和首次测试记录作为调查证据保留，不作为基线 B 已通过的证明。

## 当前规模与已经成立的边界

按本轮目录与 Git 清单统计：

| 项目                          | 当前结果                                       |
| ----------------------------- | ---------------------------------------------- |
| 顶层插件 manifest             | 74：69 frontend、4 Python、1 WASM              |
| 产品 browser-builtins 收录    | 58                                             |
| 桌面单独打包 / dev-only       | 2 / 3                                          |
| `plugins/` tracked 文件       | 1,321，约 15.10 MiB                            |
| tracked 插件测试文件          | 347，其中 24 个显式标为 Host integration suite |
| 顶层插件自身的 `package.json` | 2，均为 GitHub Bot                             |

统计口径是直接插件目录中的 `plugin.json`、`git ls-files plugins/` 与测试文件清单；不包含未跟踪缓存。Office 的 nested runtime 有自己的依赖与 lock，不等于整个 `plugins/` 有独立工具链。`plugins/` 本身不在 pnpm workspace 列表中。[workspace 清单](../../pnpm-workspace.yaml#L1-L10)、[browser 收录](../../lib/plugin/distribution/browser-builtins.json)、[桌面分发分类](../../lib/plugin/distribution/distribution.json)

已经具备的关键条件：

- **插件通过公共 author API 接入 Host。** ADR-0156/0195 明确规定 SDK 边界、共享 SDK module 和禁止框架私有依赖；本轮 author-imports 检查覆盖全部 74 个插件并通过。GitHub bundled kit 是明确列出的第一方例外，需要随拆仓处理交付。[ADR-0156](../content/docs/en/adr/0156-every-in-tree-plugin-is-a-third-party-plugin.md)、[ADR-0195](../content/docs/en/adr/0195-a-plugin-writes-to-the-contract-not-around-it.md)
- **产品构建已有 artifact 输入。** `COGNIA_PLUGIN_ARTIFACTS` / `--from` 优先于本地生产；有显式输入时不加载本地 producer，也不要求存在 `plugins/`。schema 1 定义 browser chunks、icons、desktop packages 和三个生成 catalog；consumer 按 manifest 的 SHA-256 校验文件。[输入解析](../../scripts/build/stage-plugin-artifacts.mjs#L45-L70)、[校验](../../scripts/build/stage-plugin-artifacts.mjs#L82-L124)、[格式与落盘位置](../../scripts/build/plugin-artifact-format.mjs#L24-L80)
- **运行时主要读取产物。** Browser registry 来自生成 JSON，loader 验证 chunk digest 后加载，并绑定 Host 的共享 SDK；desktop seed 来自生成 catalog 和安装资源。产品启动已接入 seed。[registry](../../lib/plugin/core/browser-builtin-registry.ts#L7)、[loader](../../lib/plugin/core/loader.ts#L321-L340)、[digest](../../lib/plugin/core/browser-builtin-assets.ts#L26-L43)、[desktop seed](../../lib/plugin/distribution/seed-bundled-plugins.ts#L169-L170)、[启动接线](../../components/providers/initializers/plugin-runtime-initializer.tsx#L178-L192)
- **拆仓不要求重写权限模型。** Host discovery 仍负责 manifest/compatibility 校验与权限注册；CLI 已可用 `--dev-plugins-dir` 指向外部目录。[discovery](../../lib/plugin/core/manager.ts#L2883-L2935)、[CLI 路径解析](../../cli/src/plugin/dev-plugins.ts#L46-L67)

## 需要先完成的工作

### 1. 让 producer 拥有完整的独立构建输入

`--plugins` 只把源码目录变成可配置项。当前 frontend builder 在 module import 时读取产品仓库 `packages/plugin-contract/contract/catalog.json`；metadata evaluation 使用本地 `tsx`/module resolution；资源读取仍回退到 `public/plugins/<id>`；PDF worker 取自工具链 root 的 `node_modules/pdfjs-dist`。Browser producer 还在 import 时读取 Host 收录清单。[catalog 与 tsx](../../scripts/plugin/build-frontend-plugins.mjs#L17-L28)、[metadata](../../scripts/plugin/build-frontend-plugins.mjs#L174-L215)、[资源与 PDF](../../scripts/plugin/build-frontend-plugins.mjs#L257-L319)、[收录输入](../../scripts/plugin/artifacts/builtin-chunks.mjs#L28-L33)

因此，迁移范围应包括相关 producer/build helpers、插件所有资源、构建依赖和独立 lock。当前 `public/plugins/` 的 8 个 legacy resource 目录需要归入对应插件，不能只移动 `plugins/` 后遗漏资源。Host 的收录策略可以保持原归属，但 producer 必须消费明确、固定版本的配置输入，不能要求旁边存在产品 checkout。

### 2. 固定 SDK、contract 和共享 kit 的交付方式

author-imports 通过不代表 SDK 源码本身完全脱离 Host：当前 standalone baseline 仍有 5 处引用，分布在 5 个文件，包含 3 个测试文件与 2 个生产文件。生产引用分别是 SDK root 对 Host `resolveEffortSurface` 的导出，以及 contract 中 `backup-api` 的 Host 类型导入。[baseline](../../scripts/plugin/sdk-standalone-baseline.json#L3-L8)、[SDK root](../../packages/plugin-sdk/src/index.ts#L126)、[backup contract](../../packages/plugin-contract/src/lib/plugin/api/backup-api.ts#L5)

源码 manifest 中 SDK 为 `0.3.0`，仍依赖多个 `workspace:*` 包，包括 private 的 `@cognia/plugin-contract@0.0.0`。现有 packed consumer harness 会把 Cognia 依赖 overrides/link 回主仓库，不能据此证明从 registry 全新安装可用。本轮没有独立核实 registry 的当前发布状态，不把源码注释中的旧 404 描述当作当前事实。[SDK 依赖](../../packages/plugin-sdk/package.json#L358-L367)、[contract manifest](../../packages/plugin-contract/package.json#L1-L5)、[packed harness](../../scripts/plugin/test-sdk-package.mjs#L116-L151)

不需要为拆仓先发布整个 workspace。可以选择经过独立安装验证的版本化 tarballs，或扩展已有 author declarations bundle，并提供构建时确实需要的运行时模块。关键验收是新仓库不依赖产品源码路径。[已有 author bundle 机制](../../scripts/plugin/generate-author-types.mjs#L4-L23)、[声明独立性检查](../../scripts/plugin/generate-author-types.mjs#L96-L99)

另外，private `@cognia/github-bot-kit` 被三个 GitHub 插件和 Host PR observer 共用，应确定一个 owner，再通过固定版本交付给另一仓库，避免复制两份实现。[kit manifest](../../packages/github-bot-kit/package.json#L1-L5)、[插件消费者示例](../../plugins/github-delivery/src/index.ts#L13)、[Host 消费者](../../lib/github/pr-observe/fetch.ts#L19)

Python 测试同样有路径耦合：RepoWiki 与 Laya 的 `conftest.py` 从相邻产品仓库的 `plugin-sdk/python/src` 加载 SDK。应改为明确版本的 SDK wheel/bundle 或其他可固定输入。[RepoWiki](../../plugins/repowiki/conftest.py#L18-L23)、[Laya](../../plugins/cognia-laya-guard/conftest.py#L15-L20)

### 3. 迁移测试和治理责任，保留 Host 集成证据

插件行为测试和 author-imports 规则应随插件仓库迁移；直接驱动产品内部 API 的 24 个 Host integration suite 应留在产品侧，使用固定 artifact/fixture。不能为了拆仓简单删除测试或跳过所有跨仓检查。

除插件目录内测试外，产品侧仍有明确的源码路径检查：

- contract proof audit 对 `builtinContributionPaths` 做本地 `existsSync`，测试要求零 phantom path；当前 contract 引用了 `plugins/clipboard-tools` 等源码。[路径收集与验证](../../lib/plugin/contracts/contract-path-audit.ts#L55-L84)、[示例 contract](../../packages/plugin-contract/src/lib/plugin/contracts/plugin-capabilities.ts#L90-L94)、[零缺失断言](../../lib/plugin/contracts/contract-path-audit.test.ts#L76-L90)
- selection parity 读取 `plugins/ui-surface-reference/src/index.tsx`；WIT mirrors 包含 WASM 示例。[selection parity](../../scripts/plugin/check-selection-action-parity.mjs#L19-L30)、[WIT mirrors](../../scripts/gates/lib/wit-mirrors.mjs#L27-L28)
- 另有显式 ignored 的 Office runtime network smoke 从 `plugins/cognia-office/runtime` 拷贝 fixture。[Office smoke](../../crates/cognia-plugin-runtime/src/node_runtime.rs#L1328-L1347)

这些验证应改成有来源与版本的跨仓证据或 Host 自有 fixtures；确实需要检查插件源码的 consumer lane，可以显式指定固定 commit checkout 的 source root，而不再假设产品目录下存在 `plugins/`。24 个 suite 包含插件目录根部的 aggregate suites，不能原样移动路径就当作迁移完成。构建/单测路径选择、Jest 配置、coverage 清单与 Python/Rust gate 也应按新归属调整，而非在产品仓库中留下无效 glob。

### 4. 统一通用与专用打包路径，排除本地运行时残留

本轮 `standalone-packages` suite 在通用 frontend builder 构建阶段失败，实际错误为：

```text
RangeError [ERR_FS_FILE_TOO_LARGE]: File size (2881562112) is greater than 2 GiB
```

触发文件是本机 `plugins/pi-latex-workbench/vendor/runtime/toolchain/bundle.tar`，2,881,562,112 bytes，未跟踪且被 Git 忽略。通用 builder 会递归收集 `vendor`，只排除 `node_modules`、`.git` 和 `__pycache__`，因此误读了本地 provision 出来的 toolchain。[递归收集](../../scripts/plugin/build-frontend-plugins.mjs#L257-L293)、[suite 构建入口](../../plugins/standalone-packages.test.ts#L19-L24)

该插件现有专用 builder 已有 `vendor/runtime/toolchain/`、`vendor/runtime/render/` 排除规则，并严格按 `bundle_include` 打包。本轮实际复用它生成 ZIP：693,465 bytes、245 entries，确认不含 local toolchain/render。应复用或统一已有规则，避免两套分发结果；无需删除用户的本地 toolchain。[专用 allowlist](../../plugins/pi-latex-workbench/build.mjs#L9-L50)、[ZIP 内容写入](../../plugins/pi-latex-workbench/build.mjs#L64-L79)

这是当前工作树中的真实打包阻塞，不等于 clean tracked-source export 必然失败；也不能据专用插件的单次成功声称所有 frontend ZIP 已通过验收。

### 5. 接上不可变 artifact 的获取与兼容性验证

现有 release/test workflow 直接运行 staging，当前依赖“存在本地源码时自动生产”的 fallback；没有给这一调用提供外部 artifact 输入。[release](../../.github/workflows/release.yml#L306-L307)、[Jest preparation](../../.github/workflows/test.yml#L138-L142)

建议产品仓库增加类似 `integrations/cognia-plugins.json` 的 pin，记录插件源码 commit、artifact digest、format/contract 版本及来源，再由 fetch/check 入口准备 `COGNIA_PLUGIN_ARTIFACTS`。当前 artifact manifest 只描述 schema 与内容 digest，不表达这些跨仓版本和来源信息。Builtin 路径免于普通 package signature 校验，因此下载来源与 pin 应成为构建输入的一部分。[artifact manifest 生成](../../scripts/plugin/artifacts/produce.mjs#L74-L83)、[builtin signature policy](../../lib/plugin/core/manager.ts#L3877-L3883)

仓库已有可复用的治理模式：`cognia-services` 使用固定 revision 和跨仓 check；Browser Companion 的独立仓库由产品侧固定 commit 并执行 consumer compatibility lane。这里应复用这种模式，不必引入 git submodule 作为正常开发前提。[services pin](../development/services-extraction.md#L19-L39)、[Browser Companion consumer CI](../development/browser-extension-extraction.md#L11-L29)

## 建议归属与实施顺序

| 新 `cognia-plugins` 仓库                       | 产品仓库继续拥有                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| 插件源码、manifest、locale、图片与其他资源     | `lib/plugin` Host、UI、权限、安装、兼容性与运行时实现                             |
| 插件自身测试、Python/WASM 示例及各自 lock      | `packages/plugin-sdk`、`packages/plugin-contract`、`plugin-sdk/python` 的唯一来源 |
| producer、插件 build/test 工具链、独立依赖清单 | artifact format/consumer、产品收录与默认启用策略                                  |
| 插件 artifact 发布及版本化发布记录             | artifact pin/fetch、跨仓 contract 与产品集成测试                                  |

1. **先准备独立 producer。** 收齐资源和工具链；选择固定 SDK/kit/Python SDK 输入；让 artifact producer 在仅有新仓库的环境里构建；插件自身测试在新环境运行。
2. **再接产品 consumer。** 发布一个不可变 artifact；产品提交 pin/fetch/check；把 Host suites、source-proof 与 CI 路径分类迁移到正确 owner。
3. **最后删除产品侧插件源码。** 在不存在 `plugins/` 的 clean 产品 checkout 中运行相关构建、测试和真实加载流程，再切换常规 CI/release。

退出验收应同时满足：新仓库 fresh clone 可以 install/build/test/produce，且不读取产品 checkout；产品 fresh clone 可以仅凭 pin 下载、校验并消费 artifact；跨仓 contract、browser/desktop/CLI 加载与资源完整性通过；安装、升级、用户手动卸载后的行为及回退有实际验证；生产 static export/desktop packaging 的插件行为与迁移前一致。迁移应保留历史，只迁移 tracked 来源和必要新增文件，排除 `.venv`、`node_modules`、`target` 等本地生成物。

无源码产品构建还应检查插件 UI 的实际样式。当前 Tailwind 由产品 CSS 引入，显式 `@source` 主要指向 Streamdown；移动插件 JSX 后，utility CSS 是否仍完整进入最终产物需要视觉验证。首次调查没有证实样式缺陷；复审 compiler 探针已确认排除插件源码会丢失三个实际使用的 selector，完整无源码生产构建与视觉验收仍待执行。[CSS 入口](../../app/globals.css#L1-L12)

## 首次调查验证与边界

| 检查                                                                                                     | 实际结果                                                             |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm plugin:author-imports`                                                                             | 通过，检查全部 74 个插件                                             |
| `pnpm plugin:sdk:standalone`                                                                             | 通过，仍有 baseline 允许的 5 处 Host reference                       |
| `pnpm plugin:artifacts:test`                                                                             | 40/40 通过                                                           |
| `node --test scripts/plugin/{build-frontend-plugins,check-author-imports,check-sdk-standalone}.test.mjs` | 30/30 通过                                                           |
| Jest：`first-party-manifests`、`builtin-registry-coverage`                                               | 2 suites 通过，共 748 tests 通过                                     |
| Jest：`standalone-packages`                                                                              | 1 suite / 1 test 失败，构建误读 ignored 的 2.88 GB Pi toolchain 文件 |
| 复用 Pi 专用 builder 并检查真实 ZIP                                                                      | 成功；693,465 bytes、245 entries；不含 local toolchain/render        |

这些结果支持“现有 author 边界与 artifact consumer 隔离可用”，不能代替“新仓库 fresh clone 独立安装与构建”。本轮没有创建新仓库、实际迁移、在无产品源码环境完成 producer 安装构建，也没有完成全量 lint/typecheck/build、全平台真实 runtime、真实 provider 或安装包验收。
