# 第一方插件拆仓：先闭合产物合同，再迁移稳定基线

状态：P0 已完成，P1 主要修复已在现仓实施；Windows 进程恢复及 P1d 验收未完成，禁止拆仓。未提交或发布。创建：2026-10-30；更新：2026-10-31（Asia/Shanghai）。作者：Codex。范围：插件、SDK 分发、Web/Tauri/Capacitor/CLI 构建与跨仓 CI。深度：Heavy。输入：[就绪度调查](../reports/2026-10-30-plugins-repository-extraction-readiness.md)。相关决策：[ADR-0155](../content/docs/en/adr/0155-plugins-reach-the-host-through-one-door.md)、[ADR-0156](../content/docs/en/adr/0156-every-in-tree-plugin-is-a-third-party-plugin.md)、[ADR-0195](../content/docs/en/adr/0195-a-plugin-writes-to-the-contract-not-around-it.md)。实施结果见 §17。

## 1. 决策：可以推进拆仓，当前禁止直接删除源码

推荐建立一个 `cognia-labs/cognia-plugins` monorepo。插件实现、完整资源、插件自身测试和 producer 迁入新仓库；Host、SDK/contract 的权威源码、产品收录策略和 consumer 保留在 `cognia-next`。

现有 artifact 接口只是可用起点。复审已复现外置产物语义校验缺失、CLI catalog/资源错配、Tailwind 隐式源码依赖，并确认截图路径和目录外资源仍需处理。它们必须成为切仓前置工作。

实施分成两段：先在现仓修复这些问题、形成通过验收的基线 B；再迁移 B，并比较两仓产物和真实用户行为。第一次切仓不增加运行时热更新，不改变 plugin ID、功能版本、数据 schema、默认启用、权限或安装版本优先级。

本方案选择固定 authoring kit、显式 product profile、严格校验的 artifact schema 2，以及编译前统一 staging。仓库创建、可见性、人员和排期尚待实施评审决定；本轮没有创建远程仓库、提交或发布。

## 2. 成功标准覆盖两个独立仓库和全部现有分发面

| 编号 | 目标                                                  | 必须提交的验收证据                                                                                                                   |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| G1   | 插件仓库可以独立 install/typecheck/test/build/produce | fresh clone 仅含插件仓库、固定 kit 和公开依赖；无 Host checkout、外部 symlink、`NODE_PATH` 或 Host tsconfig alias                    |
| G2   | 产品仓库可以在没有 `plugins/` 时构建                  | cold/warm cache 均仅凭固定 pin 完成 Web static export、Tauri/Capacitor preparation 和 CLI 产物构建                                   |
| G3   | 分发内容完整并且来源可追溯                            | 插件 ID/version、manifest、贡献入口、资源、CSS、worker、preboot projection、desktop companion 一致；来源、profile、kit、合同指纹匹配 |
| G4   | 用户升级到拆仓版本后行为保持                          | 已有配置、启停、权限、插件数据和自行安装版本不丢失；浏览器/桌面/CLI 的可用性仍服从原 manifest                                        |
| G5   | 两仓可以独立演进并可回退                              | 插件先发布不可变产物，产品评审后更新 pin；支持旧 artifact 的版本保留；失败更新不产生可交付安装包                                     |

范围边界：本次迁移源码所有权与构建交付。Marketplace 协议升级、自动下载最新 builtin、重新设计 seeder、增加插件特权、新数据库迁移和发布整个 workspace 均不纳入首迁。Web/mobile 当前不能执行的 Python/WASM 功能不因拆仓扩大支持范围。

## 3. 当前证据支持产物接入，但没有证明完整独立性

复审快照：`5be39a8cb129e7b0ac0d1d870b8810f4a1fb5a83`；共享工作树存在其他改动，结论针对本次检查的实际文件。74 个 manifest：69 frontend、4 Python、1 WASM；browser profile 收录 58 个目录；desktop 显式 bundled 为 2 个 Python 插件，另外按规则生成 frontend Node runtime companion。`plugins/` 不在 pnpm workspace 中。

当前数据流：producer 读取 Host catalog、curation、依赖与 `public/plugins` → 生成 chunks/resources、icons、desktop packages 和三个 catalog → consumer 写入 Host 的生成目录 → runtime 读取生成 catalog。入口和所有权见 [artifact format](../../scripts/build/plugin-artifact-format.mjs)、[producer](../../scripts/plugin/artifacts/produce.mjs)、[consumer](../../scripts/build/stage-plugin-artifacts.mjs)。

以下探针保存在 `.cache/research/plugins-adversarial-2026-10-30/`，为本机可复现辅助证据；关键结果同时记录于本文件，CI 不能依赖该缓存目录。

| 证据                                                        | 实测结果                                                                                                                                            | 能证明的范围                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `delivery-probes.mjs` / `delivery-results.json`             | 三个空 catalog、零 browser/desktop payload 被接收；额外 `sdkVersion/contractVersion=999.0.0` 被忽略                                                 | 当前 consumer 不做上述语义准入；probe 使用隔离 fixture                                         |
| 同一 delivery probe                                         | warm A + 显式 B：stage 调用 0 次，仍打包 A；cold A catalog + B：编入 A digest，最终只有 B chunk                                                     | 实际 esbuild + consumer 顺序；未执行完整 CLI/native build                                      |
| `assets-style-probe.mjs` / `assets-style-probe-result.json` | 仅排除 `plugins/**` 后，扫描插件文件 1239→0；三个实际使用的 utility selector 从存在变为缺失                                                         | 使用当前已安装 PostCSS source 构造、Tailwind compiler/oxide；未执行 no-source production build |
| 同一 assets probe                                           | 无 Host mirror 时，material icon theme 报 `Missing plugin resource cognia-material-icon-theme/dist/material-icons.json`                             | 真实资源 collector；未到 JS 编译阶段                                                           |
| 同一 assets probe                                           | Azur Lane 图片已打进包，但 screenshot resolver 仍返回 `/plugins/...`                                                                                | collector/resolver 已确认；删除旧 mirror 后浏览器 404 为推断，尚未发起真实请求                 |
| `sdk-buildkit-probe.mjs` / `sdk-buildkit-probe.json`        | SDK/UI/GitHub kit 三个根的 manifest 生产/optional 闭包涉及 23 个内部包；53 个 SDK runtime entry 合并后无外部 `@cognia/*`，仍有 6 个第三方 specifier | JS 编译可行性；使用 Host 源码/tsconfig，未证明独立安装、声明或 Host binding                    |

SDK probe 输出为 100 个文件、13,092,160 bytes，未压缩；这是实验值，不是最终 kit 的发布体积或预算。它还记录了 5 个 `lib/ai` 输入，说明 kit 生成依赖需要纳入来源快照。

## 4. 对抗性裁决：明确阻塞与受约束的既有风险

| ID / 严重性   | 结论与触发场景                                                                                            | 裁决及方案中的落点                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A1 / P1       | hash 正确的空/错 edition artifact 仍会覆盖 catalog；builtin 随后获得受信身份                              | 有效且可执行：§8 在写入前验证期望集合、身份与跨 catalog 一致性                              |
| A2 / P1       | warm tree 忽略 B；cold build 先编译 A、再写 B                                                             | 有效且可执行：§9 编译前准备同一 artifact；目录存在不能替代身份校验                          |
| A3 / P2       | 移走源码后 `sm:px-2`、`focus-visible:underline` 和 hover utility 缺失                                     | 有效且可执行：§7 产出插件自身 utility CSS，测试计算样式和 standalone ZIP                    |
| A4 / P2       | 截图走 icon resolver，旧绝对 URL 和 builtin 相对路径均可能指向错误资源根                                  | 有效且可执行：§7 按 contained resource 解析，保留 icon 专属目录的原语义                     |
| A5 / P1       | producer import 时读取 Host curation；资源回退 Host mirror；SDK/测试靠 Host 路径                          | 已知问题成立，原报告合同不足：§6 显式 kit/profile 输入，§10 分配测试 owner                  |
| A6 / 首迁阻塞 | 通用 frontend builder 把 Pi ignored toolchain 纳入递归收集，独立 ZIP suite 失败                           | 首次调查已复现：§7 统一 allowlist 与 builder；不能删除用户本地工具链来掩盖问题              |
| A7 / P1       | 现有分发证据未证明 SDK 独立安装及完整声明/运行时覆盖，root declaration 也不能承担真实 metadata evaluation | 有效且可执行：§6 发布完整 exports 的实作和声明，禁止 link 回 Host 或用 production stub 补洞 |

A8 / P1 是第二轮对方案本身发现的并发缺口：只锁住 staging，另一构建仍能在 A 编译期间覆盖固定生成目录。§8.3 规定贯穿编译和最终 layout copy 的 read lease，并由 T9 检查两个有效 A/B 输入的重叠构建。实施后的 POSIX 证明和 Windows 剩余问题见 §17。

A1 的代码依据为 [consumer 的 schema/digest 校验](../../scripts/build/stage-plugin-artifacts.mjs#L88-L125) 和 [builtin 签名策略](../../lib/plugin/core/manager.ts#L3877-L3883)。A2 的依据为 [目录存在判断](../../scripts/build/lib/stage-builtin-plugin-assets.mjs#L43-L56) 与 [CLI 先编译](../../scripts/build/build-cli.mjs#L56-L60)、[后 staging](../../scripts/build/build-cli.mjs#L145)。

A3 的真实使用位置为 [documents card](../../plugins/cognia-documents/src/card.tsx#L167)、[setup modal](../../plugins/stagehand-mcp/src/ui/setup-modal.tsx#L222)、[timeline](../../plugins/sre-agent/src/panel/timeline-table.tsx#L157)。当前 builder 只处理普通 CSS，见 [esbuild 与 stylesheet 合并](../../scripts/plugin/build-frontend-plugins.mjs#L326-L394)。A4 见 [gallery](../../components/plugins/_shared/plugin-screenshot-gallery.tsx#L38-L56)、[public/builtin icon 路径](../../lib/plugin/utils/icon.ts#L124-L143)。

未采纳“theme-pack preview 同样必坏”的初步怀疑：[themes bridge](../../lib/plugin/bridge/themes-bridge.ts#L319-L336) 已剥离自身旧 mirror URL 并读取 contained asset；不能把截图缺口扩大到所有主题预览。

seeder 的版本比较、已安装插件优先级和 Dexie 回退限制属于既有行为。首迁不重写这些机制；先在现仓验证基线 B，再迁移同一 B。若实施发现必须改变 plugin version/schema 或安装所有权，则退出本次无功能变化窗口，单独评审兼容性和数据迁移。

## 5. 所有权唯一，产品通过两个固定输入连接插件仓库

```text
cognia-next 权威源码
  SDK/contract/UI/WIT ──► authoring kit K（不可变） ──┐
  产品收录策略 ────────► product profile P（带 hash） ├─► cognia-plugins
                                                    │   lock + 插件源码/资源/测试
                                                    └─► produce artifact A

cognia-next integrations pin ─► fetch/verify A ─► stage A ─► compile/package
                                                             │
                                         Web / Tauri / Capacitor / CLI
```

图中跨仓连接均是固定数据或构建产物；产品正常构建不读取插件源码，插件正常构建不读取 Host checkout。

| 内容                                                                  | 唯一 owner                            | 另一仓库如何消费                                                    |
| --------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| 74 个插件实现、manifest、资源、locale、各自测试与上游 vendor/license  | `cognia-plugins`                      | 产品固定完整 artifact；非默认插件可单独生成 ZIP                     |
| producer、通用 frontend packager、插件 build/test/author-import 规则  | `cognia-plugins`                      | consumer CI 执行新仓库自己的命令                                    |
| SDK/contract、plugin-ui、Python SDK、canonical WIT、CLI scaffold 模板 | `cognia-next`                         | 固定 authoring kit，保留单一合同来源                                |
| `github-bot-kit`                                                      | `cognia-next`，沿用现有 Host consumer | kit 携带可构建/测试的版本化包；插件打包时内联，Host loader 不共享它 |
| browser/desktop 收录、默认行为、平台支持策略                          | `cognia-next`                         | 导出 profile P；producer 不能自行扩大收录                           |
| artifact format、校验/获取、runtime、权限、安装、preboot、UI 壳       | `cognia-next`                         | SDK/format 的副本随 kit 交付且有 digest，不产生第二套可编辑实现     |
| Host 集成测试与 source-proof 检查                                     | Host 负责断言；插件仓库负责实现证据   | artifact fixture 或显式固定 commit 的 source checkout               |

保留现有 consumer、cache/helper 和资源 resolver 的 owner；优先扩展它们。确需新增的持久文件是两个 pin/profile 合同；新增 fetch/check 入口承担当前 staging 没有的跨仓下载和身份校验职责。其余新文件须在实现 PR 中说明为何无法扩展现有 owner。

## 6. 选定 authoring kit 路线，禁止把 workspace 解析当作分发能力

### 6.1 Kit K 从 Host 生成，插件只安装完整产物

首期采用 Host CI 生成并发布固定 digest 的 authoring kit，插件仓库以 lock 固定下载。Kit 使用真实 SDK/helpers，不增加运行时替身；声明 bundle 不能单独承担 metadata evaluation 或单测。

fresh clone 的顺序固定为“Node bootstrap → `pnpm install --frozen-lockfile` → check/build”。Bootstrap 只用 Node 内置模块读取新仓库的 kit pin，先校验 `authoring-kit.json` digest，再下载其中逐个固定 URL/hash 的 package tarball、wheel、contract/profile/style/WIT 文件，原子落盘到受控的 `.vendor/authoring-kit/`。pnpm 只解析这个已准备目录的 package tarballs；bootstrap 不依赖尚未安装的 SDK、JSZip 或 pnpm 生命周期 hook。kit 是带逐文件 hash 的分发集合，不要求安装前运行第三方解包代码。无有效 cache 且离线时明确失败。

在 [SDK package builder](../../packages/plugin-sdk/scripts/build-package.mjs)、[完整 runtime entries](../../packages/plugin-sdk/tsup.config.ts) 和 [declaration generator](../../scripts/plugin/generate-author-types.mjs) 的现有机制上扩展：

- SDK 的每个公开 export 条件都提供实际 ESM/CJS/DTS 文件，包括 alias entry 和 testing subpath；构建入口清单由 package exports 与 runtimeEntries 交叉验证。
- kit 专用 SDK 包将实际需要的内部 JS/type 依赖闭合，生成外部消费者用 manifest。不能把目前 `workspace:*` 改为 `0.0.0` 就当作可安装，也不能机械搬入 23 包闭包及 agent binaries。
- SDK/UI 继续以 Host 的共享 module 身份参与插件运行；plugin bundle 中的 React、SDK 和 plugin-ui 仍 external。GitHub kit 内联。CSS/UI 的共享依赖和 peer 列表由实际 output 与 declarations 校验。
- Python SDK 提供 wheel；WIT、contract catalog、允许的 shared modules 与 style contract 一同交付。版本、文件 hash、Host source commit/tree、generator/toolchain/lock digest 进入 `authoring-kit.json`。
- kit 生成可以读取 Host owning source；交付后禁止读取 Host `src`、`@/`、外部绝对路径、`cognia-source` 条件或 sibling link。第三方依赖/peers 固定在插件仓库 lock 中。

选择这条路线是为了不把内部 workspace 的发布与版本管理扩成拆仓前提。代价是需要维护 kit 构建和发布检查。备选的正常 npm 发布可后续替换 transport；仍须满足同一安装与 export 验收。将 SDK 权威源码一并迁走会扩大 Host 反向依赖，首期不采用。

Kit gate 必须在临时独立目录中安装实际 tarballs，禁用 Host tsconfig/`NODE_PATH`，遍历所有公开 export 做 import/require/typecheck；从新仓库运行所有插件 metadata evaluation、真实 helper 单测和 pack。对声明/JS 的第三方 external 均检查已声明依赖；对所有 `@cognia/*` external 检查 kit 内部闭合。此 gate 不能沿用当前 [packed harness 的 Host link overrides](../../scripts/plugin/test-sdk-package.mjs#L116-L151)。

当前 SDK standalone 检查允许 5 处基线引用；它不是零引用断言。本次要求的是交付 kit 闭合。需要清理的 runtime/type 边界应放在原 owning package，不复制 Host 业务实现到插件仓库。

### 6.2 Product profile P 是独立输入，解决 curation 所有权与 producer 独立性

从 `browser-builtins.json` 和 `distribution.json` 导出规范化 profile：`schema`、profile 名称、browser 目录↔ID 映射、desktop include/平台策略、dev-only 分类及内容 hash。保留有语义的顺序，对无序对象按 key 规范化，统一 UTF-8/LF。

producer 改成显式接收 `pluginsRoot`、`kitRoot`、`profileFile`、`outDir`；移除 module import 时读取 Host curation/catalog 的副作用。producer 只验证 profile 的内部合法性，Host 用当前产品策略的 hash 和期望集合做最终准入。

同一插件源码 commit 可针对不同 P 产生不同 artifact；缓存 key 至少包括 source tree、kit、P、lock、编译器版本与资源清单，不能只按 plugin version 或目录是否存在复用。修改收录策略时按“导出 P → 新仓库构建 → 产品更新 pin”顺序推进；不使用可变远端 main/latest。

## 7. 一个 package builder 同时提供 standalone ZIP 和内置 artifact

### 7.1 资源只能来自插件包及声明的固定构建依赖

闭合 `public/plugins/` 的目录时建立逐文件来源→包内路径→artifact URL 清单。版本控制内的 7 个目录共 1334 文件移入插件资源；PDF worker 从固定依赖生成。`dist/material-icons.json`、主题图片/字体、PDF worker、CSS、library CJS、二级 entry、Python 文件及 Node runtime provisioning 输入逐项核对。

统一 frontend package builder 的输出为 manifest、entry/resource 字节、mode、hash、dependency inputs。Browser artifact 和 ZIP 都消费这一个结果；Pi 等专用 builder 的 allowlist/排除规则并入此流程。额外 `build.mjs` 可作为薄入口，不能维护不同 ZIP 内容规则。显式资源缺失即失败，禁止回退到 Host `public/plugins`。

递归目录不是默认发行清单。现有 `bundle_include`、catalog pathFields 和受控资产目录共同形成 shipping allowlist；`.venv`、`node_modules`、`target`、本地 provision toolchain/render、工作台状态等始终排除。保留执行位、固定 ZIP 时间戳、排序 entries；拒绝越界路径、symlink 和同名规范化冲突。不要删除本机 toolchain 来让测试转绿。

PDF worker 取自插件仓库锁定的 `pdfjs-dist`，与使用它的 engine 版本绑定；worker URL/digest 与产物一起生成。Office runtime 只交付既有声明的 package/lock/probe 输入，不带开发机安装结果；provision 行为仍由 Host 原 owner 执行。

### 7.2 选择插件自带 utility CSS，闭合 standalone 与 builtin 两种交付

producer 为每个 frontend 插件用固定 Tailwind/compiler 与 K 的 style contract 编译 utility CSS，并与作者 CSS 合并至已有 `manifest.styles` 对应产物。Browser index 的 `bundledStyles` 与 ZIP 内 stylesheet 使用相同字节。

Style contract 包含需要的 theme utility 定义、dark/custom variant 与 CSS layer 约定，不包含 Host reset、字体注册和完整业务 CSS。插件不再依赖扫描 Host/sibling 源码，也不重复注入 preflight。React/UI 仍共享 Host 实例；style contract hash 是准入条件，不代表另起一个 UI runtime。

层顺序和 token 解析必须在 P1 明确固化：Host base/components 在前，插件 utilities 使用约定 layer，作者 CSS 按现有覆盖顺序加载。对 documents 响应式 padding、setup modal 键盘焦点、timeline hover 和暗色 token 做 computed-style/视觉断言。不能只判断 CSS 字节长度。

Style contract 必须逐项声明由 Host 全局提供的 token 名称、默认值/语义、变体和 layer；例如 `--spacing`、`--animate-spin`。producer 校验最终 utility 中的外部变量引用可由该合同提供，或有明确 fallback。插件自有 token 定义绑定插件根节点。编译出的 `:root/:host` 不能直接作为已完成的插件 token 初始化：现有 [scope wrapper](../../lib/plugin/styles/plugin-stylesheet.ts#L135-L146) 会使这些 selector 在普通插件子树内失配。

固定转换顺序为“Tailwind 编译 → 合并作者 CSS/按合同处理 token 根 → 生成 release stylesheet → 既有 Host scoping → 注入”。builtin 与 ZIP 使用同一 release stylesheet 和相同处理。补充 `animate-spin`、translate、ring、嵌套 layer/media 和 scope 外 sentinel 验收；在产品当前最低支持引擎上验证，不能以提高系统要求绕过失败。某必需引擎不满足时，由样式 owner 在 P1 补兼容实现并通过同一内外元素测试；未满足前保持 P5 阻塞。

已进行的隔离浏览器探针澄清了具体原因：Chromium 153.0.8010.12 与 Playwright WebKit 26.6 中，nested layer 的 keyframes/property 可以保留；实际 Tailwind 编译出的 1 个 keyframes、17 个 property 均已由当前 splitter hoist，不能据“嵌套定义必被丢弃”的未成立假设重写 hoisting。另一测试中，直接 scoped Tailwind 的动画/translate 失效，显式提供 Host 全局 token 后恢复 `spin` 和 `4px`；这验证 token 合同需要具体化，并未证明当前完整 Host 已有同样故障。证据为 `scope-layer-probe.mjs` / `scope-layer-probe-result.json`，不替代真实 native WebView 验收。

备选方案是 artifact 携带 class candidates 供 Host 编译；它能解决 builtin 源码移除，却仍把 standalone ZIP 样式依赖留给 Host，故本方案选择插件自带 CSS。P1 在主仓先禁用对第一方插件源码的隐式样式兜底，以免双份 CSS 让回归测试产生假通过。

### 7.3 截图和预览按资源类型解析，避免把图标根当作通用根

图库复用现有 contained resource 能力：自身 `/plugins/<id>/...` 先规范化为包内相对路径，再根据 builtin/disk 安装位置解析；拒绝跨插件 id、越界、编码后穿越。普通 remote URL 沿用原策略。`plugin-icons` 继续只承载身份图标，截图不得被改写到该目录。

沿用 themes bridge 已有的 preview 转换，不重写正确路径。为 gallery、theme preview、file icons 分别加入资源验收，并覆盖编码字符、缺失文件、builtin 与 disk install。浏览器应实际请求资源并记录状态；collector 成功不等于请求成功。

## 8. Schema 2 同时固定来源、兼容性和期望内容

### 8.1 新版本仅改变构建输入合同，runtime catalog 的版本独立

在现有 `plugin-artifact-format.mjs` 演进 schema 2，保留六个现有 section 和路径所有权。顶层新增必要身份字段，示意结构如下；占位符表示字段类型，不是可直接使用的 pin：

```text
schema: 2
source: { repository, revision, sourceTreeSha256, lockfileSha256 }
authoring: { kitSha256, sdkVersion, uiVersion, contractVersion,
             catalogSha256, sharedModulesSha256, styleContractSha256, witSha256 }
profile: { name, sha256 }
toolchain: { nodeVersion, packageManager, producerVersion }
inventory: [ { directory, id, version, type, manifestSha256 } ]
files: { normalizedRelativePath: sha256 }
```

产品新增 `integrations/cognia-plugins.json`，固定 repository、40-hex revision、完整 artifact archive URL/SHA-256、kit SHA-256、profile SHA-256 和相关合同 hash。源码 commit 用于可追溯；字节、profile 和兼容指纹共同决定是否采用，不能用来源 commit 相等代替内容验证。

兼容策略首期保守：构建侧按 exact fingerprint 接受已测试组合。普通 Host 改动不改变相关 fingerprint 时无需刷新 kit/artifact；SDK/共享 ABI/style/profile 变动需重新生成和 consumer 验证。旧已安装应用仍使用随该版本交付的旧 artifact，不在运行时下载 schema 2。schema 1 cache 给出明确迁移错误，不能忽略未知字段后继续接受。

### 8.2 校验顺序从信任根到 catalog 语义，再允许写入

1. fetch 仅接受产品 pin 指定的 repository/revision/asset；验证 archive hash 后解包至按 digest 命名的 cache。允许读取完全匹配且重新验证过的离线 cache；缺失或不匹配即失败，不退回 latest 或旧 checkout。
2. 校验 schema、必需字段、kit/profile/contract/shared-module/style/WIT 指纹。顶层 manifest 本身的身份由产品 pin 中的 archive hash 约束，不能只信 manifest 的自报 digest。
3. 沿用文件 hash、路径、symlink、额外文件检查；对下载及解包使用 pin 中审阅过的压缩/解压字节数与文件数上限，设置 120 秒单次下载超时、最多 2 次重试。失败退出且保留原有效 cache。
4. 对照 P 验证完整预期 browser 集合、显式 desktop 集合、由 nodeRuntime 推导的 companion 集合与平台支持。区分目录名和 manifest ID；缺失、额外、重复 ID 均拒绝。
5. 验证每个 index 的路径/ID/version、chunk URL/digest、允许的 shared module、二级 entry、resource root 与实际文件；desktop catalog 对应完整包及 per-file digest。preboot 必须等于同一组已校验 manifest 的 `dexie/characterPacks` 投影。
6. 验证成功后进入 staging。校验失败前后，Host 生成文件及目录 hash 必须完全不变。

精确集合检查针对进入 runtime 的 browser/desktop catalog。`plugin-icons` 可以包含 release inventory 中非默认插件的身份图标，沿用当前所有插件都提供图标的行为；这些文件仍受 inventory ID、路径及字节 hash 约束，不能因此向 runtime catalog 加入额外插件。

传入 `COGNIA_PLUGIN_ARTIFACTS` 或 `--from` 仍要走相同准入，不成为绕过 pin/合同的入口。开发者可显式选择本地 artifact 和 profile，但必须做同一语义校验；dirty kit/artifact 标明 source-tree digest，release lane 拒绝。此机制不增加插件权限，也不改变运行时签名策略。

### 8.3 写入完成后才发布本 checkout 的 staging receipt

复用现有 mirroring、`writeIfChanged` 与内容地址目录；用 checkout 级锁串行化生成输出，staging receipt 在所有指定 section 完成并复核后写入，记录 artifact/profile/hash 与 web/full 模式。构建调用必须等待 receipt 后才导入/编译 catalog。

锁不能在 staging 后直接释放给另一组产物。准备锁必须原子转交为绑定同一 artifact 的构建 read lease，覆盖首次读取 catalog、完整编译、最后一次 layout/安装资源复制与校验。需要写生成目录的操作不得越过任何活动 lease；同一已验证集合只有在无需改写生成目录时可共享读 lease。A 正在编译时请求切到 B，必须明确拒绝为 `artifact_in_use` 并提示隔离 checkout，不能悄悄覆盖 A，也不无限等待。dev watcher 的 lease 持续到该进程关闭；CI/release 使用独立 checkout。进程退出释放 lease，崩溃回收需核实 owner 已退出；receipt 不是 read lease 的替代。

中途 I/O/进程失败允许留下待修复的生成输出，但不得留下成功 receipt 或继续编译。重启根据固定 artifact 重建并验证全部 section；缓存中已验证 set 不就地修改。不能把现有逐文件原子写入描述成跨目录事务。开发机同时运行的 Web/CLI/mobile 入口必须共享准备锁和贯穿编译/复制的 lease 合同。

## 9. 所有构建入口在编译前消费同一集合

将“解析 pin/显式输入 → fetch/verify → stage/receipt → 编译 → layout copy”作为一个统一顺序，接到 predev/prebuild、mobile prepare、CLI JS/pkg/Bun 与 server/brain layout 的实际入口。

扩展现有 `stage-plugin-artifacts` 和 `stage-builtin-plugin-assets`：前者负责准备与校验；后者只从已验证的集合复制，并核对 receipt/最终 catalog。`public` 目录存在不再决定是否采用显式 B。所有 pipeline 在 esbuild/Next 导入生成 JSON 之前准备完成。

CLI `--js-only` 保留其轻量原意：允许消费已验证 cache，但缺少匹配 artifact 时给出明确准备要求；不能静默输出没有 builtin 资源的可交付包，也不能悄悄触发原先承诺跳过的 native/full build。完整 CLI/pkg/Bun 必须携带对应资源并验证编入 catalog 的 digest。

以下四个回归用实际 esbuild 与布局文件验证，不能只 mock `buildChunks` 调用次数：cold A catalog→B、warm A tree→B、warm A+损坏 B、cache clean 后固定 A 重建。编入 bundle 的 catalog digest、receipt 和每个最终 chunk 必须一致。网页/desktop 同样检查 generated catalog 与 `out/` 或安装资源闭包。

## 10. 测试与治理迁移保持断言，不按目录一刀切

插件目录有 347 个 tracked 测试文件，24 个显式 Host integration suite（包括根目录 aggregate suite）；实施 P0 必须重新生成逐 suite 归属清单。

| 测试/规则                                                                                | 迁移方式                                                                               | 不能接受的替代                                                |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 插件纯逻辑、真实 SDK helpers、UI、metadata、packaging 单测                               | 新仓库使用实际 kit、Jest/RTL 与插件自己的独立配置                                      | `@/` alias 回 Host、把所有 SDK 函数设为 identity/no-op        |
| Host PluginLoader、权限、registries、workflow API、数据库集成                            | 留在对应 Host owner，消费固定 artifact/fixture                                         | 只移动路径、删断言或一律 skip                                 |
| contract source-proof、selection parity、WIT example 镜像                                | 固定插件 commit 的 consumer lane，显式 source root；本地无 root 时不能假报“全部已验证” | 保留永远失效的 `plugins/...` 本地 `existsSync` 或只比较文件名 |
| author-import、allowlisted bundled kit、colocated rules、Jest lane、CI change classifier | 双仓分别治理各自源码，相关 Host ABI/profile/pin 改动选择 consumer lane                 | 原 glob 留空导致检查静默消失                                  |
| Python/WASM                                                                              | 新仓库 wheel/固定 WIT 输入与各自 lock；SDK 本身测试留 Host                             | conftest 添加相邻 `plugin-sdk/python/src`                     |

Host consumer lane 固定插件 commit，验证 kit/profile 指纹，运行新仓库 install/check/build/test/produce 和 Host loader/render 断言。正常产品 build 只消费预构建 artifact；只有 source-proof/兼容 CI lane 显式 checkout 插件源码。

文档、ADR 及 evidence 中指向迁走源码的链接也列入迁移清单：当前实现指向新仓库 owning path，历史证据使用对应 immutable revision 链接。插件开发/发布说明随新 owner 维护；不留下删除后才失效的本地路径。

仓库已有 services/browser extraction 的 pin/consumer 机制可复用。planner 失败时保守运行 consumer lane，同时保留 planner 的失败状态，不能因前置作业失败而漏掉兼容验证。

本地不新增 coverage 执行要求；保留既有 CI coverage 政策及测试断言。新增/编辑受管源码遵守 co-located tests；UI 修复经双语 i18n 与实际浏览器检查；静态导出路径保持无 Next runtime server。

## 11. 用户兼容与回滚以稳定基线 B 为边界

P1 的样式/资源/构建修复会改变产物，必须先在原仓完成各自回归，形成 B。随后物理拆分阶段保持 B 的 plugin ID/version/schema/default/权限和 shipping 内容；允许变化的是 repository provenance。不能先移动源码，再把缺失功能定义成“版本升级”。

基线比对至少包含：所有 normalized manifests、JS/CSS/resources 的路径和字节 hash、mode、三个 catalog 的语义内容、preboot 投影、nodeRuntime 输入及 Python/WIT 文件。排除对来源 commit 本身的机械相等要求。最终产物不含绝对 checkout 路径，按相同平台/锁定工具链进行可重现比较。

用户验收覆盖：已有禁用插件保持禁用、配置/权限/数据保留；用户自行安装较新/不同来源版本保持原优先级；同版本重新启动、旧应用升级、升级中断后重开、卸载后行为与 B 一致。seeder 不得因为仓库变更重新覆盖用户目录。

回滚分三层：

- **切换前构建失败：** 恢复上一个经过验证的 pin/K/P 组合，重建干净输出；失败 artifact 不进入 release。
- **切换后产品回归：** 回退产品 release 和与之验证过的 artifact tuple；保留旧 artifact、kit、source revision 和发布记录。禁止只退 artifact 到不匹配的新 Host。
- **数据不可逆变化：** 首迁不允许。若出现新 schema/plugin migration，停止本方案的无功能变化切仓，并先完成该数据变化独立的前向/回退合同。

关闭某个有问题插件仍使用现有禁用机制；不存在“自动放宽权限/签名以完成回滚”。本次不更改账号、密钥、私有文档或模型调用路径；测试不应使用用户真实凭据。

## 12. 实施阶段、唯一 owner 和停止条件

| 阶段               | 单一负责角色 / 依赖     | 交付物与验证                                                                                                         | 停止/回退条件                                                                      |
| ------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P0 固定清单        | 迁移负责人              | 保存实际工作树来源/hash、74 插件资源与测试归属、受影响构建入口和 B 的验收清单；把本轮缺口转成 owning-layer 失败用例  | 资源、dirty 来源或安装身份归属不明则不迁移                                         |
| P1a authoring 输入 | SDK 负责人；P0          | K、P、真实独立 export/install/typecheck/metadata 测试；依赖及 style/WIT 合同完整                                     | 任一 Host alias/link、缺声明、native agent 安装依赖或 production stub 则不发布 kit |
| P1b 产物闭包       | 插件工具链负责人；P1a   | 单一 packager、shipping allowlist、utility CSS、目录外资源及 screenshot 修复；69 ZIP 和默认 artifact 都可用          | 缺资源、打入本地状态、styles/render 不一致则保留源码继续修复                       |
| P1c consumer       | Host 构建负责人；P1a    | schema 2、语义校验、receipt/锁、CLI 编译前顺序及 cold/warm 负测                                                      | 错集合可通过、输出混用、校验失败仍修改输出/产出 release 则阻止切仓                 |
| P1d 稳定 B         | 产品验证负责人；P1b/P1c | 在原仓形成无隐式源码样式兜底的完整验收基线，并保存 payload 清单                                                      | 插件 ID/version/schema/default/权限需改变时先单独评审                              |
| P2 独立仓库        | 迁移负责人；P1d         | 按路径过滤保留 Git 历史；迁移 B 的源/资源/工具/测试/license，建立 root package/lock/AGENTS/CI；fresh clone 不读 Host | 仅在旧工作树才能 build/test，或比对不等价则不更新产品 pin                          |
| P3 发布候选        | 插件发布负责人；P2      | 固定 commit、K/P、不可变 artifact、hash、内容清单；真实新仓库自测通过                                                | dirty source 或 artifact 被覆盖即生成新版本，不覆盖既有 bytes                      |
| P4 产品采用        | Host 构建负责人；P3     | pin/fetch、所有入口接线、source-proof lane、去除正常 local producer fallback                                         | fresh Host 仍读取本地插件源码或 warm cache 掩盖失败则不删目录                      |
| P5 验收后删除      | 产品验证负责人；P4      | no-source Host 矩阵、用户状态/升级/回滚及基线比对通过，删除旧源码与无效配置                                          | 任一必需平台/关键路径无证据则保留切仓未完成状态                                    |

先后依赖明确，P1b/P1c 可在输入合同固定后并行。各阶段按独立 PR 评审，生产行为修复和物理迁移分开。人员与发布日期由 Q3 排定，当前没有已承诺的人日/DDL；未指定人员不会被伪写为已接受任务。

## 13. 验收矩阵必须包含成功、拒绝与恢复

| ID / owner      | Given → When → Then                                                                                                                             | 证据层次                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T1 / SDK        | fresh plugin clone 无 Host → 安装 K、运行全 exports/声明/helpers → 不访问 sibling/Host alias，无缺依赖                                          | 独立进程与解析输入清单                                           |
| T2 / 插件工具链 | 本地存在 Pi toolchain、venv 等 → 构建 69 frontend ZIP/默认 artifact → shipping 内容不变且无开发状态；manifest parity 和全部 entry 可加载        | 实际 builder + archive inventory + loader                        |
| T3 / Host 构建  | artifact hash 正确但 profile/contract/集合/catalog 错 → staging → 写入前失败；Host 输出 hash 不变                                               | negative integration tests                                       |
| T4 / Host 构建  | warm/cold A，显式 B → 编译 CLI JS/pkg/Bun/brain → 编入的 catalog、receipt、资源都为 B；损坏 B 直接失败                                          | 实际 bundler/layout，另跑已发布形态 CLI smoke                    |
| T5 / UI         | Host 无插件源码且无旧 public mirror → 加载 documents/modal/timeline → 三个丢失 selector 对应计算样式、响应式/焦点/hover 正常                    | production static export + Playwright screenshot/computed styles |
| T6 / 资源       | builtin 与 disk 插件 → 展示截图/主题/file icons，渲染 PDF → 无旧路径 404、无身份图标目录误用；worker 成功；越界资源拒绝                         | 真实浏览器/桌面资源请求与渲染                                    |
| T7 / 产品验证   | 原 B 用户数据/禁用/授权/手装版本 → 升级到拆仓版本、重启/中断恢复 → 状态及优先级保持                                                             | 合成账号配置 + 真实安装/启动流程                                 |
| T8 / SDK/合同   | Host ABI、style、WIT/profile 或插件来源变动 → 运行跨仓 CI → 选择正确 lane，兼容通过后才允许 pin 更新                                            | consumer CI 与错误组合负测                                       |
| T9 / Host 构建  | staging 中断/离线缓存，或 A 编译期间以另一有效 B 发起构建 → 重跑/并发请求 → 完整重建或明确拒绝，不混合 A/B、不回退 latest；同集合共享必须无改写 | fault injection + receipt/read-lease 验证                        |
| T10 / 产品验证  | 已采用 A，新候选失败 → 回退被测试的 Host/K/P/A tuple → 构建及已有用户启动恢复，不反向迁移数据                                                   | 回滚演练                                                         |

平台要求：Web 必须检查 `out/` 的真实静态服务；Tauri 覆盖 macOS/Windows/Linux 构建与安装资源，至少执行各平台受影响加载路径；Capacitor 覆盖 Android/iOS 的 web-only staging 和插件 UI/资源；CLI 覆盖 JS、pkg、Bun 及 server/brain layout，至少在其实际支持的平台运行 smoke。纯 Web 的 Playwright 通过不能替代 WKWebView、WebView、native/Python/Node provisioning。实际不可用平台须保留为未完成验收，不以单元测试代替。

当前已有可用命令包括：`pnpm plugin:author-imports`、`pnpm plugin:sdk:standalone`、`pnpm plugin:artifacts:test`、`pnpm plugin:contract:check`、`pnpm lint:plugin-sdk-wit`、`pnpm test -- --runInBand --runTestsByPath plugins/standalone-packages.test.ts`、`pnpm lint`、`pnpm typecheck`、`pnpm lint:static-export`、`pnpm build`。实现时将迁走的命令移交新仓库并更新实际 path；fetch/kit/check 的新命令在对应 PR 注册后才作为可执行入口，不将本方案示意命名声称为已存在。

## 14. 运行记录足够定位版本错配，不新增高基数业务遥测

构建日志记录选定 source revision、artifact digest、K/P/contract/style fingerprint、cache hit、staging 模式与耗时、browser/desktop 数量、拒绝 code 和 stage。错误 code 至少区分 `artifact_digest_mismatch`、`profile_mismatch`、`contract_mismatch`、`catalog_inconsistent`、`resource_missing`、`staging_incomplete`、`artifact_in_use`；日志同时给出固定 pin 与重新获取/重建动作。

CI 的验收阈值是任一身份/集合/资源/行为错配即失败。对比 B 的压缩/解压大小、文件数、JS/CSS 和启动 smoke 时间，变动必须在 PR 解释；本轮没有最终体积或延迟基线，不虚构百分比预算。首次发布保留每个候选的内容清单和测试证据，定位错误无需读取用户配置或凭据。

不新增运行时远程监控、模型发送、用户源码上传或自动部署。发布可信根是经评审的产品 pin 与指定仓库的 CI artifact；SHA-256 提供字节身份，不替代发布流程和代码评审。

## 15. 本轮已做的验证与尚未完成的验收分别记录

以下为实施前的方案复审记录，保留用于区分原始缺口与修复结果；2026-10-31 的实施验收见 §17。

方案复审实际运行：

- `pnpm plugin:author-imports`：通过，74 个插件；允许的 GitHub kit 例外仍在。
- `pnpm plugin:sdk:standalone`：通过，5 处允许的 Host reference 仍存在。
- `pnpm plugin:artifacts:test`：40/40 通过。
- `node --test scripts/build/lib/stage-builtin-plugin-assets.test.mjs`：6/6 通过；现有测试未阻止 A1/A2 探针场景。
- delivery、style/resource、SDK kit 三组隔离探针：结果见 §3；probe 的 mock/fixture 边界均已标注。

首次调查实际运行过的 Jest 为 2 suites/748 tests 通过、standalone ZIP suite 的 1 test 失败；Pi 专用 builder 生成的 ZIP 为 693,465 bytes、245 entries，排除了 toolchain/render。本轮没有把这些历史结果重新标记为新基线 B 的通过证据。

方案复审时尚未进行 production 修复。此后用户已授权先实施 P0–P1；新仓库 fresh-clone、完整 no-source Host static build、真实 native/platform matrix、正式 artifact 发布和回滚演练仍须按阶段完成，不能用 §17 的候选产物比对替代。

## 16. 评审决定与审查记录

| 决定          | 推荐                                                                                          | 备选与后果                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Q1 仓库与权限 | 一个 `cognia-labs/cognia-plugins` monorepo，沿用代码许可证和审阅流程；可见性经仓库 owner 确定 | 多个插件仓库增加 kit/profile/pin 和发布运维；首期不采用                                                   |
| Q2 技术路线   | 固定自包含 authoring kit + profile；artifact schema 2；插件自带 utility CSS；产品评审采用 pin | npm transport 可后续替换；candidate-only CSS 不满足 standalone 闭包；submodule/旁边 checkout 不满足 G1/G2 |
| Q3 执行与发布 | 用户已授权先实施 P0–P1；验收通过后才进入 P2，当前状态见 §17                                   | 没有已承诺的发布日期，未创建/发布远程仓库                                                                 |

| 审查项                                             | 结果                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 第一轮 fresh-context delivery reviewer             | A1/A2 成立；已在设计中纳入，production 未修复                                                        |
| 第一轮 fresh-context static-export/assets reviewer | A3/A4/A5 成立；theme-pack preview 的扩大判断已撤回                                                   |
| 主审核对                                           | 检查实际 source/probe；将已知 seeding/data 回退风险归为受约束 trade-off；新增 A7 的明确分发路线      |
| 可选跨模型复核                                     | 用户明确选择跳过；未调用外部 CLI，本轮仅记录内部独立上下文审查结果                                   |
| 第二轮方案合同审查                                 | 发现的 A8 已补入设计并经 reviewer 复核；未发现剩余确定性合同缺口，implementation acceptance 仍未执行 |
| CSS 路线定向复核                                   | nested-definition 丢弃假设在两种已测引擎上未成立；实际 token 根问题已明确写入 §7.2 和平台验收        |

实施源文件的具体 owner、验证和停止条件已列于 §12；本文件没有无 owner 的实现 TODO。P0–P1 已获执行授权，当前剩余验收、Q1 和后续发布准备见 §17，不代表已获发布授权。

## 17. P0–P1 实施记录：2026-10-31，候选基线尚未获准切仓

用户已授权“先完成 P0–P1 的前置修复和验证，通过后再拆仓，确保现有功能不回退”。以下改动均在现仓完成；原 `plugins/`、旧 public mirror 和现有安装/数据路径保留，没有创建远程仓库、删除源码、提交或发布。共享工作树同时存在其他任务改动，候选来源按实际 bytes/mode 记录，不能仅以 HEAD 标识。

| 阶段 | 已实施与证据                                                                                                                                                                                                                                                                                                            | 当前边界                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P0   | 新 inventory 记录 74 manifests、24 Host 测试接缝和 1334 个 mirror 文件的来源、bytes、mode、dirty 状态及构建入口；资源复制回插件自己的 `resources/`，原 mirror 保留                                                                                                                                                      | 盘点是构建输入快照，不是全部功能验收                                                                        |
| P1a  | Host 生成实际 SDK/UI/GitHub kit tarballs、Python wheel、catalog/profile/style/compiler/WIT 和带 hash 的公共 tooling；Node 内置模块 bootstrap；独立目录安装实际包，检查 59 个 ESM/CJS exports、全部公开声明、335 个插件 TS 文件、17 个真实 helper suites/103 tests、Python 模块导入以及 69 个 frontend 包的 metadata/ZIP | 这是无 Host checkout/alias/link 的本机独立分发证明；尚未建立或发布新仓库                                    |
| P1b  | ZIP/builtin 共用 packager；显式 allowlist、插件自有资源、执行位、二级 entry、共享 PDF worker、合并 utility/authored CSS；Host 停止隐式扫描插件源码；截图使用 contained resources                                                                                                                                        | 两种浏览器只验证真实 release CSS + Host scope 的 fixture，不能替代 production 页面及最低支持 native WebView |
| P1c  | Schema 2 固定 K/P/ABI/source；校验期望集合、catalog/preboot/manifest/entry/style/desktop companion/runtime/worker 闭包，拒绝额外 payload；immutable snapshot/receipt、跨进程 writer mutex/read lease；CLI/Tauri/mobile 编译前准备且最终复制同一产物                                                                     | POSIX 异常/正常 leader 退出的子进程族保护已测；Windows 仍缺普通构建进程族的可靠恢复及实机证明               |
| P1d  | Host 与独立 producer 的候选 payload 按逐文件 bytes/mode 比较；局部回归、完整 lint、真实 CLI JS build 已执行                                                                                                                                                                                                             | 全局测试/typecheck/static-export/build 和原生/用户状态验收未全通过，因此 B 未成立，P2–P5 不启动             |

新增模块各自沿用现有 owner：`source-fingerprint` 将既有缓存指纹从 Host artifact builder 中提取，供公共 cache helper 复用；compiler/contract/lease/preload/wrapper 分别承担固定编译语义、准入、进程间保护和编译入口；authoring-kit/bootstrap/proof/inventory/style 模块承担原先缺少的分发、安装前校验、独立证明、盘点和样式闭包。没有复制 Host runtime、权限系统或业务数据实现。GitHub helper 的 ESM/CJS/DTS 输出由原 owning package 的 `tsup.config.ts` 构建，kit 携带相同 dist bytes。

实施复核实际抓到并修复：SQLite connection 被 GC 提前释锁、正常 leader 退出后孤儿 worker 的 lease、空资源目录和 mode-only cache 漂移、metadata 与 release 的 class-field/CommonJS 语义差异、长驻 builder 的 helper Promise/module cache 陈旧、缺失 contribution integrity、未收录 payload、缺失共享 PDF worker及缺少 Node runtime provisioning 输入。对应失败用例先复现，再转绿。SDK/UI 仍是 Host shared modules，helper 在 metadata/release 内均使用实际实现。

当前可复现入口：

```sh
pnpm plugin:extraction:inventory --out .cache/plugin-extraction/p1-candidate-inventory.json
pnpm plugin:authoring:build --out .cache/plugin-extraction/authoring-kit --write-pin
pnpm plugin:authoring:test --kit .cache/plugin-extraction/authoring-kit --keep
pnpm plugin:artifacts:test
```

`--write-pin` 仅更新本地 K 身份；不是发布。Kit 的 HTTP 获取只接受固定 manifest/file hash；offline cache、坏 hash、越界/符号链接、同版本不同内容的安装包均有拒绝测试。完整独立 proof 的安装依赖来自固定包和当前 lock/patches，不使用 Host workspace link。

本次最终候选 K 为 `0cf65d9a62162efca628fe9d9b642bcdacc093977b51fd1ffec29ada65ff7db2`，本地 pin 见 [authoring-kit.json](../../lib/plugin/distribution/authoring-kit.json)。Host 和独立 producer 的 1736 个 payload 路径、内容、执行位完全相同，两个 artifact 均通过当前 semantic admission；来源/toolchain 元数据按各自真实构建记录。候选来源、原始清单和 proof hash 保存在 `.cache/plugin-extraction/{authoring-proof,payload-equivalence,p1-candidate-inventory}.json`，该缓存不是发布可信根。

最终定向 Node 测试 164/164、另组 entry/platform contract 测试 77/77、资源/图库 Jest 5 suites/74 tests 通过；两组 Node 文件选择不同，不能与历史重叠测试数累加。`pnpm lint`、author-imports、SDK standalone、contract check、WIT check 和 `git diff --check` 通过。SDK standalone 的 5 处已登记 Host reference 仍保留；K 的独立安装另有零 Host link/alias 证明。真实 CLI JS 构建成功，58 个 builtin 最终复制；将同一输出置于 CLI owning workspace、使用它声明的已安装 externals 后 `--help` 退出 0。外置 cache 目录直接启动曾因找不到 owning workspace 的 `undici` 失败；本项证明开发态 JS 入口，不能替代 pkg/Bun/server/brain 独立发行 layout 验收。

当前阻塞（具体命令及原始日志位于 `.cache/plugin-extraction/`，长期结论记录在[同一 evidence ledger](../evidence/2026-10-21-plugin-repo-split-feasibility.md)）：

- 全插件相关 Jest 快照：1081 suites/15403 tests 通过，19 suites/24 tests 失败，另有 1 suite/31 tests 跳过。失败包括 external-agent/identity/permission/样式原文断言及 source-proof 迁移等；没有把未逐项基线隔离的失败统称为“全部既有问题”。资源/图库相关 5 suites/74 tests 另行通过。
- `pnpm typecheck` 在本次未改动的 sandbox stream mock 和 `lib/remote-desktop/native-stream.ts` 的 BufferSource 类型处失败。
- `pnpm lint:static-export` 在 `agent-codebuff` / `agent-crush` 报 14 个 Node-only imports；没有新增豁免来掩盖检查。
- `pnpm build` 在首个 native-agent-bridges prebuild 因 source/compiled/dependency 与 embedded pins 不同而退出，尚未进入 Next build。未擅自 `--pin` 其他任务的 native bridge。
- WKWebView/WebView2/Android/iOS、Tauri 各发行平台和 CLI pkg/Bun/server/brain 实际形态，以及既有插件配置/权限/手装版本的升级、中断、回滚验收未完成。
- Windows 的 unconfirmed-family reader 在正常退出和 crash 后均保留，防止未知存活子进程时切换产物；可靠回收仍待普通构建适用的进程族 owner 与真实 Windows 测试。在此之前 Windows 产物切换不能视为保持原有开发体验，不能验收 P1c/P1d。

以上问题解除后，先重新生成并验收稳定 B，再按 P2 开始物理迁移。逐文件相同只证明两种 producer 的交付等价，不等于所有现有功能已无回退。
