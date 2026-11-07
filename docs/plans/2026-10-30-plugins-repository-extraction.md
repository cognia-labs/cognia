# 第一方插件拆仓：先闭合产物合同，再迁移稳定基线

状态：P0 已完成，P1 主要修复已在现仓实施；§25 已将当前源码对齐到 Kit `e6ad2db0` / Host `380249a2`，全部 75 个 frontend 包及 1743 个 payload 文件独立比对通过。§24 的 stylesheet 修复已纳入新的 ABI 和产物。当前仍有一条 Host Feishu 凭据脱敏断言失败；P1d 的真实平台/生产资源/账户状态验收及暂缓全局检查未完成，禁止拆仓。尚未拆仓或发布。创建：2026-10-30；更新：2026-11-02（Asia/Shanghai）。作者：Codex。范围：插件、SDK 分发、Web/Tauri/Capacitor/CLI 构建与跨仓 CI。深度：Heavy。输入：[就绪度调查](../reports/2026-10-30-plugins-repository-extraction-readiness.md)。相关决策：[ADR-0155](../content/docs/en/adr/0155-plugins-reach-the-host-through-one-door.md)、[ADR-0156](../content/docs/en/adr/0156-every-in-tree-plugin-is-a-third-party-plugin.md)、[ADR-0195](../content/docs/en/adr/0195-a-plugin-writes-to-the-contract-not-around-it.md)。历史实施见 §17，Windows/Office 修复见 §21，历史冻结证明见 §23，UI/状态修复及边界见 §24，当前 ABI 与独立证明见 §25。

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

| ID / owner      | Given → When → Then                                                                                                                                        | 证据层次                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| T1 / SDK        | fresh plugin clone 无 Host → 安装 K、运行全 exports/声明/helpers → 不访问 sibling/Host alias，无缺依赖                                                     | 独立进程与解析输入清单                                           |
| T2 / 插件工具链 | 本地存在 Pi toolchain、venv 等 → 按当前 inventory 构建全部 frontend ZIP/默认 artifact → shipping 内容不变且无开发状态；manifest parity 和全部 entry 可加载 | 实际 builder + archive inventory + loader                        |
| T3 / Host 构建  | artifact hash 正确但 profile/contract/集合/catalog 错 → staging → 写入前失败；Host 输出 hash 不变                                                          | negative integration tests                                       |
| T4 / Host 构建  | warm/cold A，显式 B → 编译 CLI JS/pkg/Bun/brain → 编入的 catalog、receipt、资源都为 B；损坏 B 直接失败                                                     | 实际 bundler/layout，另跑已发布形态 CLI smoke                    |
| T5 / UI         | Host 无插件源码且无旧 public mirror → 加载 documents/modal/timeline → 三个丢失 selector 对应计算样式、响应式/焦点/hover 正常                               | production static export + Playwright screenshot/computed styles |
| T6 / 资源       | builtin 与 disk 插件 → 展示截图/主题/file icons，渲染 PDF → 无旧路径 404、无身份图标目录误用；worker 成功；越界资源拒绝                                    | 真实浏览器/桌面资源请求与渲染                                    |
| T7 / 产品验证   | 原 B 用户数据/禁用/授权/手装版本 → 升级到拆仓版本、重启/中断恢复 → 状态及优先级保持                                                                        | 合成账号配置 + 真实安装/启动流程                                 |
| T8 / SDK/合同   | Host ABI、style、WIT/profile 或插件来源变动 → 运行跨仓 CI → 选择正确 lane，兼容通过后才允许 pin 更新                                                       | consumer CI 与错误组合负测                                       |
| T9 / Host 构建  | staging 中断/离线缓存，或 A 编译期间以另一有效 B 发起构建 → 重跑/并发请求 → 完整重建或明确拒绝，不混合 A/B、不回退 latest；同集合共享必须无改写            | fault injection + receipt/read-lease 验证                        |
| T10 / 产品验证  | 已采用 A，新候选失败 → 回退被测试的 Host/K/P/A tuple → 构建及已有用户启动恢复，不反向迁移数据                                                              | 回滚演练                                                         |

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

本节保留 2026-10-31 的历史执行快照，其 Kit、数量、检查结果及“未提交”状态不代表当前版本；后续代码已包含于 `2bc50e4eb0`，最新结果见 §18。

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

## 18. 当前 Host artifact 对齐：2026-11-01

本次只处理用户指定的 artifact。当前权威输入已经由其他任务更新为 Kit `85b4ed70f704f730e4e5f9cd948ed0c8bdaeca812aafc4e096d1758d111321ce`、76 个插件（71 frontend）和 60 个 browser builtin；旧 artifact 仍引用 Kit `0cf65d9a`，实际 consumer 以 `authoring identity mismatch` 拒绝。没有回退新增的 Feishu 插件、重写 Kit pin 或更改产品收录。

通过现有 `node scripts/build/stage-plugin-artifacts.mjs` 执行串行 producer 和受锁保护的 staging，得到 artifact `7af7a18e816c93d53a81f382b9718fcc153402f3a9f077a1b58ed56da9c328bf`。本次实际更新 `builtinChunks` 与 `builtinIndex`；其余 section 不变。旧 reader 所属 POSIX process group 已消失，由现有 lease owner 正常回收，没有终止任何并行任务进程。

已验证：

- 当前 K/P/contract 语义准入通过，旧 artifact 仍被拒绝。
- 1743 个文件在 artifact 和 Host 六个 section 间逐一核对 bytes、实际 mode 和精确成员集合；receipt 和 immutable snapshot 均匹配同一 artifact digest。
- 将同一真实 artifact 接入一个没有 `plugins/` 的空 Host，producer tripwire 未触发；cold staging 完整写入，warm staging 不改写输出或 mtime。实际 Host 的 warm staging 也没有内容变更。
- `pnpm plugin:artifacts:test` 49/49 通过；registry/assets/preboot 的 focused Jest 3 suites/27 tests 通过。两处过期的 builtin 测试先复现失败，再补齐 60 个 builtin 与两个 Feishu ID 的预期。

原始证据位于 `.cache/plugin-extraction/2026-11-01-artifact/`，关键结果记录在[同一 ledger](../evidence/2026-10-21-plugin-repo-split-feasibility.md) 的 O69–O71 / V29 / M5。缓存是本地验证材料，不是正式发布。当前没有提交或发布本次增量，也没有启动拆仓。

本节 artifact 增量完成时，没有把 §17 的独立 producer 1736-file 比对重标记为新 Kit 的通过证据：当时新的完整独立证明尚未运行，harness 仍写死 69 个 frontend 包，因此 V25 为当前 tuple 重新打开。该部分随后已在 §19 补齐；全局 gate、Windows 进程族恢复、真实平台、用户状态升级和回滚验收仍保持未完成。

## 19. 当前 Kit 的完整独立构建与 Host 比对：2026-11-01

按用户要求继续验证 Kit `85b4ed70f704f730e4e5f9cd948ed0c8bdaeca812aafc4e096d1758d111321ce`。先用实际 inventory 复现旧脚本的 `71 != 69`，随后复用 `collectExtractionInventory` 从复制后的源码快照推导 frontend 目录/ID 清单；构建结果必须精确匹配该清单，没有把常量简单改成 71，也不允许缺少、重复或额外包静默通过。

现有 harness 新增 `--compare-host`，使用现有 artifact reader/contract owner 做逐文件比较。输入 Kit 必须匹配当前 Host pin，profile 必须匹配当前产品策略；源码、frontend 清单、Kit/profile、harness 和 Host snapshot 在验证中漂移时明确失败。比较使用已经冻结的 Host artifact `7af7a18e`，没有重新生成或覆盖 Host、Kit、profile 或其他并行任务的源码。

实际运行：

```sh
pnpm plugin:authoring:test --kit .cache/adr0246-authoring-kit --compare-host .cache/plugin-artifact-sets/7af7a18e816c93d53a81f382b9718fcc153402f3a9f077a1b58ed56da9c328bf --keep
```

独立目录仅含复制的插件源码、实际 Kit tarballs/wheel、固定公共依赖和公共 build tooling；无 Host checkout、SDK source link、`NODE_PATH` 或 Host tsconfig alias。实际通过：

| 验证                            | 结果                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| 全部公开 ESM/CJS exports 和声明 | 59 个 exports；声明以 `skipLibCheck: false` typecheck                     |
| 插件源码类型检查                | 340 个 TS 文件通过                                                        |
| 实际 helper suites              | 17 suites / 103 tests 通过                                                |
| Python wheel                    | 在独立 Python 3.13.14 venv 安装，所有 SDK 模块导入通过                    |
| 全部 frontend 包                | 71 个 metadata evaluation / ZIP 实际构建通过；逐 archive SHA-256 复核通过 |
| 默认 artifact 与 Host 比对      | 1743 个路径、raw bytes、实际权限位及完整 76-plugin inventory 完全一致     |

独立 artifact 为 `4aede9ec618acbf4a5eca15872662ca566e47185eceb7652c0ca2512cd992722`；Host artifact 为 `7af7a18e816c93d53a81f382b9718fcc153402f3a9f077a1b58ed56da9c328bf`。二者 source/toolchain provenance 按真实构建记录，manifest 自身 digest 不相等是预期；payload 逐文件相同。新 harness digest 为 `f0a852fd7c582269b1e8331e155b9c600a06d178431b36a077191ac1ccdb2288`。

本轮原始证据位于 `.cache/plugin-extraction/2026-11-01-independent/`：`count-red.log`、`proof.log`、`authoring-proof.json`、`frontend-packages.json`、`payload-equivalence.json`。通用 proof/equivalence JSON 指针更新为当前结果，旧 payload 比对另存 `previous-payload-equivalence.json`。相关 inventory/kit/bootstrap 定向测试 7/7 通过，变更脚本语法、ESLint 和格式检查通过。没有新增 runtime、共享合同或另一个 inventory owner。

Ledger 的 V25/V30 和 M6 已完成；V26/V27/V28 与 X14 保持未完成。包构建与交付等价不等于所有插件已在各平台激活并验证，也不替代 production static export、Windows 进程恢复、用户配置/权限/数据的升级和回滚验收。P1 全部通过前不启动 P2 拆仓。

## 20. 全局 typecheck 与 static-export 修复：2026-11-01

本轮按用户要求先复现当前错误，再修复并验证；§17 的旧失败记录保留为历史证据。全量 `pnpm typecheck` 实际复现 5 条诊断，均位于三个测试夹具：`NativeFrameStream` mock 缺少 `input`、E2B 配置工厂丢失 union narrowing、ACP 的 admission Set 被写成 `unknown`。修复只补齐真实接口和类型，没有修改生产逻辑、移除断言或增加检查抑制。ACP 文件原有的并行修改以本轮开始时的快照为基准保留，本轮仅调整对应 structural type。

`static-export` 的 14 条报告集中于 Codebuff/Crush 的三个独立 Node bridge/helper，其中一条是会擦除的 named type import。核对 owning `tsup` 配置和 native bridge staging 后，13 条运行时 Node imports 使用精确文件/module 豁免，并标记 `nodeOnly`：其他被扫描源码对这些文件的值导入必须失败，既支持相对 `.js` 路径，也使用根 `tsconfig.json` 的 JSONC aliases。两个公开 agent browser 入口实际通过 `esbuild platform:browser` 构建，其输入集合不含这三个 Node 文件。没有修改 bridge 源码或重写 embedded pins。

独立审查先后复现同一行第二条导入、带注释的 `type as` 值绑定、括号动态导入和常量字符串拼接四类漏报，新增回归先红后绿。导入解析改用现有 TypeScript AST，明确区分 erased type 和运行时绑定，并解开静态字符串表达式；不求值任意运行时变量。AST 同时消除了注释中 `require("fs")` 的旧误报，因此移除对应过期豁免。保留对全部 workspace 源码的扫描，没有排除整个 `packages/`。

全量 lint 首次失败仅来自此前 CLI 验证生成的 271 个 `cli/.cache/plugin-extraction-js/` 文件。现有 ESLint 缓存排除从根 `.cache/**` 扩展到 `**/.cache/**`；实际 admission probe 证明根/工作区缓存被忽略，`cli/src/index.ts` 和 gate 源码仍受检查。缓存保留，未删除其他任务的文件，也未放宽源码规则。

| 验证                                                          | 当前结果                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm typecheck`                                              | exit 0；实际运行 root、sidecar、pi-extension 和 sidecar packages 检查    |
| 三个受影响夹具的 `pnpm test --runInBand --runTestsByPath ...` | 3 suites / 536 tests 全部通过                                            |
| `node --test scripts/gates/check-static-export.test.mjs`      | 28/28 通过，含 negative fence 和真实 browser entry bundle                |
| `pnpm lint:static-export`                                     | exit 0；12002 TS 文件、27 条有效豁免、3 个 Node fences；无 stale warning |
| `pnpm lint`                                                   | 最终 exit 0，无 warning                                                  |
| 独立只读复核                                                  | 测试类型与 static-export/config 两组复核通过，无剩余本轮阻塞             |

原始证据位于 `.cache/plugin-extraction/2026-11-01-global-checks/`，包括修复前后日志、失败回归、逐文件 source 快照和本轮 scope diff。Ledger 的 V31/V32、M7 完成；V26/V27/V28 与 X14 继续保留。全局 Jest、production build、Windows family recovery、真实平台和既有用户状态的升级/中断/回滚尚未在本轮验收。检查期间磁盘曾返回 `no space left on device`，随后约余 436 MiB；未清理并行任务产物或启动大型构建。

本轮未更改 Kit、profile、插件产物或现有运行时，也未提交、发布或执行拆仓。此前当前 Kit 的 71-package / 1743-file 独立证明继续作为 §19 的分项证据，不能替代尚未完成的 P1d。

## 21. Windows lease 与 Office 版本修复：2026-11-01

用户本轮授权先修复两个定向问题，明确暂缓全局检查，并要求保留并行任务及 P1 验收边界。本节替代前文关于“Windows 尚无普通构建进程族 owner”的当前结论；原记录保留为历史。没有运行全局 Jest/typecheck/lint/build，没有拆仓、提交或发布。

Windows 新编译 lease 在 Node preload 阶段、业务模块导入前挂接到随机 `Global\CogniaPluginArtifact-<uuid>` Job。staging 查询该 Job 的实际 active process count，全部结束才回收，避免把 leader PID 消失或复用当成整组结束。查询失败仍拒绝切换；挂接失败不执行业务入口。

沿用现有 Node lease owner，新增的 `plugin-artifact-windows-job.ps1` 只承担 Windows Job 的 P/Invoke，不能直接放进跨平台 JavaScript；普通 build 不需要预先编译 Rust sandbox runner 或应用其隔离策略。PowerShell 由独立的 detached Node guardian 持有，避免 guardian 被编译器的 libuv Job 自动终止。guardian 死亡会关闭 Job 并终止其持有的编译进程族，不留失去保护的后台编译。环境按大小写不敏感方式移除 `NODE_OPTIONS` 和 lease selector，握手必须匹配随机 Job 名。

独立复核抓到并修复 libuv 父子 Job 生命周期、`Local\` 跨 session 误回收，以及继承 preload 提前输出 ready 的问题。设计依据为 [Windows Job 生命周期](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[kernel object namespaces](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces) 和 [libuv Windows process 实现](https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/process.c)。真实 wrapper 终止时，Windows/libuv 可能结束整个嵌套 Job；测试只有在 worker 已确认停止时才允许零 lease。真正仍存活的 detached orphan 必须继续持有 lease。

旧格式 `unconfirmedFamily` 没有可靠的历史进程族身份，仍保守拒绝，不按“leader 已退出”自动删除。已存在此类记录的旧 checkout 应先确认相关构建进程族停止，再针对具体记录恢复，或使用隔离 checkout；本轮没有清理用户或并行任务的旧记录。

发布调查通过 GitHub connector 和只读 GitHub CLI/API 完成：`cognia-labs/cognia` 与旧仓库 `MaxQian888/cognia-next` 的当前 Release 均为空，58 个 tag 全为 backup，Release workflow 没有 run；公开 `dev` 分支仍提供 `cognia-office@0.1.0` 源码。结论是没有查到当前官方二进制发布，不能据此排除已删除/私有/手动分发。旧缓存候选与当前旧 artifact 的 Office `dist/index.js` hash 分别为 `a37ea3dd…` 与 `ceec3afd…`，同为 `0.1.0`，所以不再复用该身份。

Office 源 manifest 升为 `0.1.1`，ID、权限、默认值、runtime provisioning 与配置 schema 不变。没有改变生产 seeder：仅旧 builtin 随新版本升级，用户手装、较新和已删除包继续优先；安装失败不推进 marker，下一次重试。新增策略用例先在旧 catalog 上复现失败；候选 fixture 用于隔离并行 Host 输入漂移，实际源码/ZIP 另行核对，不能把 fixture 当作 Host 已采用。

| 定向验证                                                       | 结果                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows 10.0.26200、PowerShell 5.1、Node 26.12.1 Job lifecycle | 15 passed、0 failed、1 个 POSIX 专用用例 skipped；覆盖正常/异常退出、true orphan、wrapper/guardian 终止、lowercase preload 隔离和 attachment denial                |
| Windows artifact staging 与实际 A-to-B esbuild fixtures        | 17/17 通过，含 cold/warm、相互排斥、写入前语义拒绝与同集合共享                                                                                                     |
| macOS lease/wrapper/staging                                    | 26 passed、0 failed、7 个 Windows 专用用例 skipped                                                                                                                 |
| Office seeder 与真实插件入口 Jest                              | 2 suites / 33 tests 通过，含升级一次、手装/较新/删除保留、中断重试及 manifest 版本校验                                                                             |
| Office standalone ZIP                                          | 实际 `0.1.1`、8 files；archive SHA-256 `302f412a30db07521ff5fe4eb354c890690a587c4069b41a95b8d83ddb268668`，主入口与 runtime entry 完整，独立 reviewer 重新打开核对 |

最终将 lease、wrapper、staging 三组在 Windows 合并复验：32 passed、0 failed、1 POSIX-only skipped；9 个传入源码文件 SHA-256 与本地完全一致，见 `windows-final.log` 和 `windows-source-hashes.json`。

Windows 测试仅写入独立 `%TEMP%/cognia-plugin-lease-…`，使用官方 archive SHA-256 `b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4` 校验的临时 Node26。原全局 Node24 和项目工作树未被替换。Windows staging fixtures 只读复用该机已安装的依赖；不是完整产品 build。Office 定向 standalone 构建复用 §19 已安装的固定 Kit 公共依赖；不是新的完整 71-package fresh-install proof。

本轮出现新的并行输入漂移：SDK/contract 的 `catalogSha256` 与 `sdkSourceSha256` 改变，而 Kit pin 仍为 `85b4ed70`。正常 `stage-plugin-artifacts` 在 ABI 检查处拒绝，尚未把 Office `0.1.1` 采用到 Host；Host catalog 仍为 `0.1.0`。未替并行任务重建或更新其 Kit pin，也未手改 generated catalog。§19 的 71-package / 1743-file 结果保留为原 tuple 的历史证明，V25/V29/V30 与 M5/M6 为当前输入重新打开。

原始证据位于 `.cache/plugin-extraction/2026-11-01-lease-office/`：`publication.json`、`abi-drift.json`、`windows-lease-verified.log`、`windows-stage-final.log`、`node-final.log`、`office-red.log`、`office-tests.log`、`office-candidate.json` 和源码快照。V27/V33/V34、M8/M9 的定向范围通过，V35 的 Host 采用仍阻塞；P1d、平台/既有用户状态验收和暂缓的全局检查继续保留。下一步需由并行 SDK 工作形成一致的新 Kit，再正常生成/采用 artifact 并刷新完整独立比对，P1 全部通过前不启动 P2。

## 22. 当前 Kit ABI、Office 采用与完整独立比对：2026-11-01

本节解除 §21 的当前 Kit/Host 采用阻塞。用户要求的 SDK 稳定性复核、新 Kit 构建、Office `0.1.1` 采用、全部 frontend 独立构建及逐文件比对均已通过；P1d 的其余平台、用户状态和暂缓全局验收继续保留，未拆仓、提交或发布。

先对 SDK/contract/UI/GitHub/Python/types 共 1358 个文件两次采样，内容没有漂移。并行引入的 `defineIssueSyncProvider` 及 issue-sync-provider contract 通过 generator parity、4 suites/580 tests；Host API/bridge/context 的 4 suites/517 tests 通过。76 个插件的 author-imports 通过，SDK standalone 仍只保留已登记的 5 处 Host reference，没有新增。本轮未改写 SDK/contract 实现。

最终复核发现 7 个文件与早期采样不同；时间线确认它们在 Kit 构建前已更新，而不是完整 proof 之后的新增漂移。3 个生产文件的实际 hash 均已收录在两份新 Kit 的来源清单中，另 4 个为分发来源清单外的测试文件。重新逐项核对最终 Kit 的 974 个 SDK/contract 相关构建输入，全部与当前源码一致；相关 4 组定向测试另行重跑，证据见 `sdk-final-stability.json` 与 `sdk-final-tests.log`。

通过现有 authoring builder 实际构建 SDK/UI/GitHub tarballs、Python wheel 和公共 tooling，生成候选 Kit `5e8882b4cedf6184a513ce64588915f2c14a8e715a84ef633bff656af3cac2a4`，没有在构建时使用 `--write-pin`；构建后立即核对 7301 个来源输入没有漂移。受现有 writer mutex 保护采用该候选后，另一个已运行的构建任务又将 pin 更新为 `cb656fbb`。检测到这一变化后，没有回写覆盖它，而是核验其全部分发文件 hash、当前 ABI/profile，以及与本轮候选完全相同的 SDK/UI/GitHub archive hash，再将其分发冻结到本轮 `adopted-kit/`，按该 pin 重新生成 Host。

两个 Kit 的 tool/source provenance 不同，不能只凭 hash 不同判断 SDK ABI 不一致。最终采用的 Kit 来自并行构建的 Node `26.5.0`，本轮候选使用 Node `26.12.1`；并行 Kit 的来源记录中 `packages/agent-dsh/src/install.ts` 后续发生修改，已记录为来源快照差异，没有声称 7301 个输入始终与当前工作树一致。最终当前 ABI/profile、实际分发文件和 producer payload 分别验证，不绕过任何 pin 或准入检查。`pin-adoption.json` 保留中间 `5e8882b4` 过程；最终身份以 `selected-kit.json`、`host-adoption.json` 和完整 proof 为准。

| 身份                 | 最终 SHA-256                                                       |
| -------------------- | ------------------------------------------------------------------ |
| Kit                  | `cb656fbbadfc86d88b0c42f49049bda8461557f2c354d551ebc2732c72a9df43` |
| Host artifact        | `a6a07d44594ff433890c1f87a9f60de9a78c71821c88302d32b580066d5b1c87` |
| Independent artifact | `48929093f1f34e9d4d7cc651f27ca7cbf36744a407ba2ce8c710eddddfd73531` |
| Proof harness        | `f0a852fd7c582269b1e8331e155b9c600a06d178431b36a077191ac1ccdb2288` |

Host 经现有 `stage-plugin-artifacts.mjs` producer/stager 采用新 artifact；本轮更新 builtin chunks/index 和 desktop payload/catalog，preboot 与 icons 无内容变化。76 个插件、71 frontend、60 browser builtin 收录保持当前产品策略。Office 源 manifest、desktop catalog、实际 native staged manifest、browser resource manifest 和独立 ZIP 全部为 `0.1.1`。Office 升级测试改为读取实际采用的 catalog，移除强制候选版本 fixture，避免旧 Host 产物也能误通过；生产升级策略没有改变。

完整独立构建持有既有 artifact process-family reader lease，输入使用不可变 Host snapshot：

```sh
COGNIA_PLUGIN_ARTIFACTS=.cache/plugin-artifact-sets/a6a07d44594ff433890c1f87a9f60de9a78c71821c88302d32b580066d5b1c87 node scripts/build/with-plugin-artifacts.mjs -- node scripts/plugin/test-authoring-kit.mjs --kit .cache/plugin-extraction/2026-11-01-kit-refresh/adopted-kit --compare-host .cache/plugin-artifact-sets/a6a07d44594ff433890c1f87a9f60de9a78c71821c88302d32b580066d5b1c87 --keep
```

独立目录从实际 Kit fresh install，无 Host checkout、workspace link、Host tsconfig alias 或 `NODE_PATH`。包成员继续由冻结源码 inventory 推导，没有写死 69 或 71。实际结果：

| 验证                                         | 结果                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 公开 ESM/CJS exports 与声明                  | 59 个 exports 导入及声明检查通过，`skipLibCheck: false`                                           |
| 插件 TypeScript                              | 340 个文件通过                                                                                    |
| 实际 helper suites                           | 17 suites / 103 tests 通过                                                                        |
| Python wheel                                 | 在新 venv 中通过 Python 3.13.14 模块导入                                                          |
| 全部 frontend metadata/ZIP                   | 71/71 实际构建通过，71 个 archive hash 复核通过                                                   |
| Host 与独立 payload                          | 1743 个文件的精确路径集合、原始 bytes、实际 mode、插件 inventory 全部一致                         |
| 漂移保护                                     | 源码、Host ABI、profile、Kit、harness 和冻结 Host snapshot 均通过                                 |
| 新 SDK helper                                | ESM/CJS root 与 `api/issues` 的实际 `defineIssueSyncProvider` 导入、identity 和异步 pull 行为通过 |
| Host staged 输出                             | 1743 个实际文件与 artifact 的 bytes/mode/membership 一致，semantic admission 与 receipt 通过      |
| 无源码 Host cold/warm                        | 六个 section 完整采用，不调用 producer；warm 无 changed section，文件 mtime 不变                  |
| Artifact 回归                                | 49/49 通过                                                                                        |
| 实际 catalog、Office、registry、preboot Jest | 4 suites / 57 tests 通过                                                                          |
| Authoring/bootstrap/inventory tooling        | 7/7 通过                                                                                          |
| 定向 lint/format                             | 编辑的测试与生成 JSON 通过；未运行全局 gate                                                       |

独立 wiring auditor 重新读取实际 Kit、两组产物、1743 个文件、Host staged 输出和 71 个 ZIP；独立 test-gap/upgrade auditor 确认实际 catalog 采用、升级用例有效，且 desktop catalog 没有其他同版本不同内容的增量。两组复核均没有新增阻塞。

原始日志、冻结 Kit、proof、inventory 和身份记录位于 `.cache/plugin-extraction/2026-11-01-kit-refresh/`；根目录下 `authoring-proof.json` 与 `payload-equivalence.json` 已刷新为最终 tuple。缓存仅为本地验收材料，不是正式发布。Ledger 的 V25/V29/V30/V35、M5/M6 当前通过；V26/V28 与 X14 保持开放，剩余真实生产页面/资源、最低支持 native engine、支持平台及既有用户配置/权限/手装版本的升级、中断和回滚验收，以及用户暂缓的全局检查，不能由本轮交付等价证明替代。P1 全部通过前不启动 P2。

## 23. Contract 依赖指纹与漂移保护：2026-11-01

用户确认本轮只修复插件 contract 指纹和漂移检查，待并行 backup-destination 输入稳定后刷新 Kit/Host、重跑所有 frontend 包和逐文件比对。全局检查、其他模块及平台/用户状态验收不在本轮范围，P1 全部通过前仍不拆仓。

§22 完成后，并行功能新增 `PluginBackupAPI.registerDestination`、backup destination 类型和 SDK helper。只变更 contract 源码而 catalog/SDK entrypoints 尚未更新时，旧 Kit 缺少新声明，但原 `sdkSourceSha256` 不包含 contract 来源，ABI 和 artifact admission 仍可通过。随后 catalog 与 SDK 文件变化触发现有拒绝；§22 的通过证据只适用于当时冻结的 tuple。

修复复用现有 owner 与 schema 2：`sdkSourceSha256` 追加 `packages/plugin-contract/src` 的生产 TS/JSON 和该 package manifest，覆盖内容修改、文件增删和 exports 变动；测试与 README 不参与该指纹，symlink 仍拒绝。选择完整 contract owner 作为保守边界，因此 contract 内部生产源码变化也要求重建 Kit，没有引入另一套身份协议。Kit builder 同步记录 contract 来源，并比较构建前后的完整 ABI；独立 proof 显式比较 Kit/Host authoring，结束时重新验证整个 Kit 分发。两个新公开 helper 的实际测试通过包根入口执行，不链接回 Host 源码。

四个 contract-only 用例先复现 `Missing expected exception`，修复后全部拒绝旧 pin，另验证 test/docs 不改变身份及 symlink 不能绕过。定向 tooling 15/15；并行改动整理后，SDK/contract 与 Host API/context/module bridge 合并复验为 6 suites/1099 tests 通过。contract generator、76 个插件 author-imports 和 SDK standalone 通过，后者仍仅有已登记的 5 个 Host reference。旧 Kit 的实际 proof 启动和 staging 均被拒绝，staging 拒绝前后的 1743 个文件、pin 与 receipt 字节及 mode 不变；旧实际 SDK 声明消费得到预期的 `TS2339: Property 'registerDestination' does not exist on type 'PluginBackupAPI'`。

前五次在共享工作树中的实际 Kit 构建被来源/ABI 保护中止，涉及并行修改的 registry、生成 i18n、backup scheduler/config，以及 contract/SDK 的格式化。第四次实际触发了新增的 ABI 前后核对。所有失败尝试均未写 pin、未采用 artifact，本任务未修改或豁免这些来源。

随后将完整源码复制到本任务的隔离快照，workspace 依赖指向快照，复用已安装的第三方依赖；Git 使用单独的 index。快照内实际重建 contract 和 Kit，保留全部来源/ABI 检查，得到候选 `ff8ce69b60fc14aebab3f00a42d8057c0dce2d93b52a33278f0de9fbbb897a90`。快照输入在构建内稳定，不要求其他并行任务停止修改原工作树。候选的 ABI/profile 与当前 Host 一致，来源记录明确指向冻结构建输入，没有声称全部 Host 实现与快照始终相同。

采用前 compare-and-swap 发现并行任务已更新 pin 为 `5a8e6cfb`，因此拒绝覆盖。实际找到该 pin 对应的 `.cache/adr0246-p7c/authoring-kit`，核验全部文件 hash、当前 ABI/profile 后冻结到本轮 `adopted-kit/`，保留其 pin。并行 Kit 使用 Node `26.5.0`，隔离候选使用 Node `26.12.1`；两份 SDK 分发只有 `dist/manifest.js` 中一行 AJV JSON 来源路径注释不同，其他 SDK 文件及 UI/GitHub archive 完全一致。最终 proof 使用保留下来的并行 Kit，而非中间候选。

| 身份                 | 最终 SHA-256                                                       |
| -------------------- | ------------------------------------------------------------------ |
| Kit                  | `5a8e6cfb9210bfca95ef76f454fae07a535ae6f6c32d28f994d2f46cb6e2700a` |
| Host artifact        | `64198c6bf05efd840c418c85892fb2101d3c60d2f44cd50c6c0ffaa1b70093f0` |
| Independent artifact | `84a782052acb79feedca1f52ab8f1f4caf8b5a1a934757b0be71a0d582d71b04` |
| Proof harness        | `8da7acb029b30c66d900dd99fd48c96c70adadb20e6cda8ba34e40c2a3f6ca15` |

通过正常 producer/stager 刷新 Host 后，完整独立 proof 在已有 process-family reader lease 下执行：

```sh
COGNIA_PLUGIN_ARTIFACTS=.cache/plugin-artifact-sets/64198c6bf05efd840c418c85892fb2101d3c60d2f44cd50c6c0ffaa1b70093f0 node scripts/build/with-plugin-artifacts.mjs -- node scripts/plugin/test-authoring-kit.mjs --kit .cache/plugin-extraction/2026-11-01-contract-fingerprint/adopted-kit --compare-host .cache/plugin-artifact-sets/64198c6bf05efd840c418c85892fb2101d3c60d2f44cd50c6c0ffaa1b70093f0 --keep
```

| 当前验证                     | 实际结果                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| SDK 分发                     | 59 个公开 ESM/CJS exports 与声明检查通过，`skipLibCheck: false`                              |
| 新声明消费                   | 从实际包调用 `PluginBackupAPI.registerDestination`，贡献参数与 registration 返回类型检查通过 |
| 插件 TypeScript              | 340 个文件通过                                                                               |
| 公开 helper                  | 19 suites/105 tests 通过，包含两个新 helper 的实际包根入口                                   |
| Python wheel                 | 新 venv 导入通过                                                                             |
| Frontend 构建                | inventory 推导的 71/71 metadata/ZIP 实际构建，全部 71 archive hash 通过                      |
| 当前 Host/独立 payload       | 1743 个文件的路径、原始 bytes、实际 mode 和 inventory 完全一致                               |
| 前一版 Host 对比             | 相比 §22 的 `a6a07d44`，1743 个 payload 的 bytes/mode 均未变化                               |
| Host 实际输出                | 六个 section 的实际成员、bytes/mode 与 immutable artifact/receipt 匹配                       |
| Office                       | source、catalog、native、browser、独立 ZIP 全部为 `0.1.1`                                    |
| Source-free Host             | 六个 section cold staging 通过，producer 未调用；warm 无变化、mtime 不变                     |
| Artifact 回归                | 49/49 通过                                                                                   |
| Office/registry/preboot Jest | 4 suites/57 tests 通过                                                                       |

本轮代码修改只涉及现有 artifact contract 与其测试、authoring builder 和独立 proof；其他变更为本插件任务的文档、验证缓存及正常 artifact 刷新，没有改写并行 backup 功能、全局配置或其他业务模块。完整证据位于 `.cache/plugin-extraction/2026-11-01-contract-fingerprint/`，根 `authoring-proof.json` 与 `payload-equivalence.json` 已指向最终 tuple。V25/V29/V30/V35/V36 与 M5/M6/M10 当前通过；V26/V28、X14 和 P1d 的其余验收保持开放。没有全局 gate、coverage、拆仓、提交或发布。

## 24. 插件 UI/资源和升级、中断、回滚的定向修复（2026-11-02）

用户在只读调查后明确选择按限定范围落地。此次保留并行 SDK、catalog 和其他业务修改，没有更新 Kit/pin/profile/Host artifact，没有执行全局构建、typecheck 或 coverage，也没有访问真实用户目录、提交、发布或拆仓。

### 24.1 已修复的行为

- 插件 stylesheet 保留现代引擎的 `@scope`，缺少 `CSSScopeRule` 时使用浏览器 CSSOM 解析，再为每个选择器主体添加零 specificity 的边界。保留列表成员各自的优先级，边界位于伪元素之前；不影响 keyframes 和条件规则。release utility CSS 使用已有 Lightning CSS 依赖降低到 Safari 16.0 语法，包括 range media queries。没有提高最低系统要求；这不代表已在 iOS 16 实机通过。
- 手动回滚复用 TS PluginManager 的 graph reservation、停用、卸载、加载及启用入口；恢复禁用/挂起状态；不再改写 manifest 版本自证成功。扫描、目标版本及 config 迁移失败会报告失败；迁移使用深拷贝，抛错不污染原 config。禁用插件的计划也不再显示 load/enable。
- 普通 unload 清除 live guard、运行时和 session consent，保留持久 WASM preopen 决策；uninstall/revoke-all 仍负责删除持久授权。没有为了回滚重新授予 session/confirm 权限。
- native backup ID 加入唯一标识并使用 `create_new`，同秒备份不再覆盖。多目录恢复在既有 backup owner 中持久化日志；未提交时恢复旧树，提交后保留新树；恢复中先原子移走待丢弃树，再还原旧树；清理前原子退役到 `.cleanup-*`，支持恢复过程再次中断。
- ZIP/目录安装改为复用已有 Marketplace stage/commit/finalize 事务及启动恢复；没有引入第二套单插件安装事务。启动先恢复 backup restore，再执行 Marketplace recovery。
- native snapshot E2E 改为正确的必需 `pluginId`、flat snapshot 和 NotFound 合同。现有 inventory 为空时只证明空 inventory 与 missing-id 行为；未制造一个假的正向安装验收。

### 24.2 已执行的定向验证

| 验证                | 实际结果与边界                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 插件 Jest           | 7 suites / 447 tests 通过；覆盖 manager、rollback、stylesheet、Dexie bridge/migration/persistence 及 WASM grant helper                                                                                       |
| 浏览器与 compiler   | 9 cases 通过；Chromium 153、当前 WebKit 26.6；现代与强制 fallback CSS 的响应式、focus/hover/dark、动画、伪元素、specificity 和外部 sentinel                                                                  |
| 业务 UI/资源        | 实际 Documents card、Playwright setup modal、SRE timeline 组件源码，加真实 release CSS/ZIP round-trip 资源；builtin/ZIP URL 下图标可解码；真实 PDF worker 在 Tauri CSP 下绘制非空画布且没有 fake-worker 回退 |
| 持久浏览器          | 同一个测试 profile 关闭浏览器再启动；真实 IndexedDB + `runPluginMigrations` 验证迁移失败原子回退、中断事务回退、成功迁移只执行一次、拒绝已迁移数据的旧版本；合成 retained tables/localStorage 行逐项保持     |
| Rust source harness | 31 tests 通过；直接 include 当前 backup/contract/contained-path 源码，提取当前 Marketplace 事务函数及定向测试；11 个 restore/recovery/cleanup 终止阶段、3 个 local install 终止阶段；strict Clippy 通过      |
| 其他定向检查        | 目标文件 ESLint/Prettier、Rust 文件格式通过；Tauri spec discovery 为 2 cases；3 个只读 preflight reviewer 的 actionable finding 已修复                                                                       |

两个新增 browser script 放在既有 `scripts/plugin/*.test.mjs` 入口下：现有 CSS fixture 无法验证业务组件和真实 PDF worker，现有 fake-indexeddb close/reopen 测试无法验证浏览器进程重启。它们没有新增产品 harness 或通用持久化层。截图在 `.cache/plugin-extraction/2026-11-01-ui-state/screenshots/`；日志、源码指纹及 source-harness 适配器在同一 evidence 目录。

### 24.3 继续保留的验收边界

UI 测试直接 bundle 组件源码，未经过 release JS → Host loader → PluginManager 安装链；有限资源请求不代表截图 gallery、theme/file-icon/font 和全部插件资源通过。持久状态测试使用真实迁移内核，但 retained rows 是合成表，不代表真实 CogniaDB、账户权限、批准的 binary、WASM 决策及 SQLite/WAL 的完整升级验收。Rust harness 使用轻量 runtime-state/path adapter，不是完整 crate/Tauri 编译；完整 crate 先受并行 Cargo 下载锁阻塞，随后触发大规模重编译，已停止自己的尝试，保留其他进程。

E2E governance 执行后报告 `tests/e2e/helpers/gestures.ts:1` 的既存 timeout exception 于 2026-10-31 到期；它不属于此次插件改动，未修改或延长期限。真实 Tauri/Capacitor、最低 iOS 16（当前只有 iOS 26.5 simulator）及匹配 production export 均未声称通过。

当前 `readHostAuthoringIdentity()` 仍报 Host authoring kit ABI mismatch，§23 只能作为冻结版本的历史证明。后续需在并行源码稳定后生成匹配的 Host/Kit/profile/artifact，并用隔离用户 profile 驱动完整升级、重启与回退，阶段之间不得 reset DB；不能用包文件回滚替代数据兼容检查或自动反向迁移。V26/V28、X14/X16 与 P1d 继续开放，P1 全部通过前不拆仓。

## 25. 当前 SDK/contract、Kit/Host ABI 与全部 frontend 独立证明（2026-11-02）

本轮范围为用户明确要求的 ABI 刷新和插件定向验证。当前 inventory 为 80 个插件，其中 75 个 frontend、60 个 browser builtins；继续使用 inventory owner 推导包集合，没有恢复 69/71 的固定数量断言。并行 SDK/contract 的生产源码保持稳定，2699 个插件源文件在采用前后重新枚举成员并核对 bytes 和执行位。没有恢复、覆盖或提交其他任务的源码。

SDK/UI 在本任务冻结快照内实际构建；contract build、contract check 和 80 插件 public-import 检查通过。随后并行任务修改 `pnpm-lock.yaml`，使首份候选不再匹配 live ABI，因而没有采用。保留新的锁文件 `ef7a25d1`，复核 25 个 Kit 外部依赖的已安装版本与快照一致，再复用本轮新构建的 SDK/UI 输出重新生成 Kit；GitHub Kit 仍实际构建。一次 pnpm 自动安装改写快照锁文件也被原有来源保护拒绝。全部 Kit 文件与 ABI 检查保持启用。

完整 declaration program 中三个并行 Host/agent 文件继续变化，但只读审查确认它们没有向 SDK 分发引入实现或公开类型，只有两个文档注释提及 Host manager。没有声称整个 Host program 与快照始终相同。Host 通过已有 TypeScript aliases 消费当前 SDK/UI source；其 live 与冻结包的运行时 JS 完全相同，未覆盖 live package dist 中的声明输出。

| 身份                 | 最终 SHA-256                                                       |
| -------------------- | ------------------------------------------------------------------ |
| Kit                  | `e6ad2db0f9ab8708bd55e0ab6550d9325c765dbcdac5799194b268e17a36edb5` |
| Host artifact        | `380249a281f37b771aee2793f5524a24b5eea54b31857f6a7da7940bdf1755ea` |
| Independent artifact | `e9953fc66d5acaf674ca6eac026f8da6e89d7f11982e12b9df2e064d3d9af222` |
| Proof harness        | `8da7acb029b30c66d900dd99fd48c96c70adadb20e6cda8ba34e40c2a3f6ca15` |

独立 proof 使用全新的临时项目与实际 Kit archives，没有 Host source alias 或 workspace link。未携带 lockfile 的常规安装因 SheetJS CDN 超时失败，离线模式也拒绝缺失的 URL 解析输入；任务内 DNS 优先级尝试没有消除完整 GET 超时。另行下载的完整 tarball 与当前锁文件的 SHA-512 一致。最终验证仅将匹配 Kit 的锁文件中 `xlsx` URL importer 及已有 package resolutions 作为初始 lock seed，其他直接依赖照常解析，然后执行原 proof 的普通安装和 frozen-lockfile 安装；复用标准 pnpm 内容缓存及其完整性检查。没有修改 proof、依赖 URL/版本、供应链策略或断言。此结果证明独立安装和构建，不证明 CDN 在无缓存新机上的可用性。

采用脚本复审还发现 pin CAS 与 staging 分两次持锁的覆盖窗口。现有 stager 新增可选 `beforeWrite`，在 reader lease 检查后、任何 immutable/mirror 写入前等待 callback 完成。采用脚本在同一个 writer transaction 中绑定 stager 已验证的 buffer digest，核对当前源码、profile、完整插件成员/执行位、旧 pin、旧 receipt、1743 个旧 Host 文件及 proof，再以临时文件 rename 写 pin，并连续持锁完成正常 staging。两条 cold/warm 失败回归先复现缺少 guard 的问题，修复后证明 callback 等待期间其他 writer 被拒绝，拒绝采用不改变并行输出、receipt 或 immutable 集合。最后再次持锁核验 live identity 和实际产物。这是协作 writer 的并发保护，不是多文件断电或 SIGKILL 原子事务。

| 当前验证                     | 实际结果与边界                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 独立 SDK/插件消费            | 59 个公开 ESM/CJS exports、公开声明（`skipLibCheck: false`）、345 个插件 TS 文件通过                                            |
| 独立 helper/Python           | 19 suites / 105 tests；新 venv wheel 导入通过                                                                                   |
| Frontend archives            | 75/75 实际构建，完整目录/ID 集合和每个 ZIP hash 通过                                                                            |
| 独立与 Host payload          | 1743 个路径、原始 bytes、实际 mode、80 插件 inventory 全部相等                                                                  |
| Live Host                    | 新 pin、ABI/profile、六个 section、immutable set、receipt 和实际 Host 文件匹配                                                  |
| Office                       | source、desktop catalog、native、browser index/resource、独立 ZIP 均为 `0.1.1`；未修改升级优先级或发布版本                      |
| Source-free fixture          | 显式 artifact/identity 的 staging API cold 六个 section 通过，producer 调用 0 次；warm 文件和 mtime 不变；不是生产构建/启动验收 |
| Artifact                     | 51/51，通过新增的两条持锁 promotion 回归                                                                                        |
| Office/registry/preboot      | 4 suites / 57 tests 通过；真实 fallback CSSOM 的顶层 keyframes、插件 selector 边界与现代 scope 断言均保留                       |
| SDK/contract/Host public API | 6 suites / 675 tests 通过；另有 11 个 tooling tests 通过                                                                        |
| Lease/wrapper                | 9 通过、7 个 Windows 平台用例在 macOS 跳过、0 失败；不声称本轮 Windows 实机验收                                                 |
| 定向质量检查                 | 目标文件 ESLint、Prettier、diff whitespace 和只读 wiring/test-gap 复审通过；未执行全局 gates 或 coverage                        |

相对上一 Host，1702 个文件不变，39 个同路径文件变化，并替换两个 Feishu 内容寻址 chunk。变化来自已授权的 Safari 16 CSS 降级、并行 Feishu 源码和关联 catalog；没有把它们恢复成旧产物。Host registry 原有动画用例假定必须出现 `@scope`，在实际采用 fallback CSS 后失败；修正为按当前 engine 检查，fallback 通过真实 CSSOM 确认顶层 keyframes 与 selector bound，保留现代分支的原断言，未修改产品 CSS 行为或并行新增的 Feishu registry 条目。

**保留的失败与验收边界：** `lib/plugin/core/context.test.ts:4163` 的 `limits the interim Feishu refresh exception after PKCE to host source builtin` 仍失败：测试期望 builtin refresh 凭据明文透传，实际返回脱敏 placeholders。7-suite 探测为 1060 passed / 1 failed；采用后单独复测仍失败。该实现与断言均未被本轮修改，不能直接判定为生产缺陷，也没有为通过验收放宽脱敏策略。需单独确认当前凭据策略后处理。V26/V28、X14/X16、真实生产/native/最低 iOS/已有账户状态验收及暂缓的全局检查保持开放，完整 P1 尚未通过，不拆仓。

证据位于 `.cache/plugin-extraction/2026-11-02-kit-host-refresh/`，汇总为 `verification.json`；`live-verification.json`、`final-independent-proof.json`、`frontend-packages.json` 和 `independent-lock-seed.json` 保留实际身份与安装边界。根 `authoring-proof.json` / `payload-equivalence.json` 已更新为本轮 tuple。本轮没有提交、发布、创建外部仓库或访问真实用户目录。

## 26. Kit pin 重建、内置目录刷新与 Feishu refresh 用例结论（2026-11-04）

§25 后并行提交再次改动了 authoring 输入，`e90e43dd79` 写入的 pin 与其所在提交树也不一致：catalog、style contract、SDK/UI source 与 lockfile 五个摘要不同，catalog 摘要回到更早的值，说明当时把共享工作树中未提交的改动算了进去。所有 artifact production 因此拒绝，`predev` / `prebuild` 无法 stage 插件。

| 项目           | 本轮处理与结果                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kit pin        | 在 `cb9ef6cff6` 的干净 worktree 中重建：依赖以 `--ignore-scripts` 从本地 store 安装，sidecar 依赖补齐后 `plugin-contract` 连同声明完整构建（只有 JS 时 Kit 摘要不同，不能采用）。新 Kit `e02ce9625c59688d984cde5b67e9fc7ab8a077cd442e44c22a97a2232fb0f2c2`，提交 `5023cb0d80`                                                                                         |
| 独立 proof     | 同一 worktree 运行 `scripts/plugin/test-authoring-kit.mjs`：76 个 frontend 包、346 个插件类型检查文件、19 组 helper suites 与 Python wheel 导入通过                                                                                                                                                                                                                   |
| 内置目录       | 主工作树 `stage-plugin-artifacts` 成功并更新两个已提交的 generated catalog；干净 worktree 对同一提交生成的结果逐字节一致，说明是已提交目录滞后，提交 `b8d55cbde9`                                                                                                                                                                                                     |
| Feishu refresh | §25 保留的 `context.test.ts` 失败按 ADR-0246 判定为过时断言：`feishu-auth` 已是 Host-managed provider，不持有 refresh token 或 client secret，refresh 由 Host 以私有 provenance 发起（ADR-0246 §5，`ed802d1c66`）。插件自建的 token POST 对任何来源（含 builtin）都不享有明文例外，用例改为四种来源均期望脱敏，`context.test.ts` 387/387 通过；产品代码与脱敏策略未改 |

**规则：** pin 只能在目标提交的干净检出中重建，不在共享工作树中运行 `--write-pin`；任何改动 SDK/UI/contract、`globals.css` 或 `pnpm-lock.yaml` 的提交都会使 pin 失效，需要随之刷新。

V26/V28、X14/X16 与 P1d 的其余边界不变：生产静态导出、真实 Tauri/Capacitor/最低 iOS、已有用户状态的升级/中断/回滚与暂缓的全局检查仍未验收，P1 未通过，不启动 P2。

## 27. P2 独立仓库建立（2026-11-04）

用户决定在 P1 尚未全部通过时先做 P2，且只做 P2：建立带历史、可独立构建和测试的新仓库。Host 继续使用本地 `plugins/`，产品 pin 与构建入口不变，P3–P5 未开始。在 P4 之前，Host 的 `plugins/` 仍是唯一源码真相，新仓库只导入。

| 项目        | 结果                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库        | 公开仓库 [cognia-labs/cognia-plugins](https://github.com/cognia-labs/cognia-plugins)，AGPL-3.0-only；`main` 为 `672a45453b`                                                                                                                                                                                                                                           |
| 历史        | `git filter-repo` 按 `host-sync-paths.txt` 过滤 Host `dev`：`plugins/` 与 producer/packager 及其测试（`scripts/plugin/{build-frontend-plugins,plugin-styles,bootstrap-authoring-kit}`、`scripts/plugin/artifacts/{produce,builtin-chunks,desktop-plugins}`）。`produce.test.mjs` 依赖 Host consumer，留在 Host                                                        |
| Kit 传输    | Kit `e02ce9625c59` 的 15 个文件发布在 `authoring-kits` 孤立分支（提交 `6ea1099666`）；`authoring-kit.lock.json` 用固定提交的 raw URL 与 SHA-256 锁定，`scripts/bootstrap.mjs` 只用 Node 内置模块下载并逐文件校验，再把 `tooling/` 安装为 git-ignored 的 `scripts/build/*.mjs`                                                                                         |
| 构建与产物  | `pnpm build` 产出 76 个 frontend ZIP，读取仓库外文件即失败；`pnpm produce --repository cognia-labs/cognia-plugins` 产出 schema 2 集合。为保持 producer 两仓逐字节相同，Host 增加 `--repository` 参数（`9ece5d27e5`），不再在新仓库改写该文件                                                                                                                          |
| 测试归属    | Jest 两个 project（node/jsdom，`@swc/jest`）；kit 包 `.cjs` 入口 `require` ESM，需允许 transform；DOM polyfill 与 `usePluginTranslations` 测试端口在本仓库 setup 中绑定（Host 规则：当前 locale → 英文 → key）。`node:test` 套件由 `pnpm test:node` 运行，不进 Jest；Python 套件用 kit 的 SDK wheel，`uv --frozen` 不改写 `uv.lock`                                   |
| Host-owned  | `host-integration-tests.json` 列出 40 个只能在 Host 运行的测试：导入 Host 模块或越出 `plugins/` 的相对路径、读取 Host 文件（catalog、distribution、`app/globals.css`）、依赖 Host 运行时端口（effort surface）、或比对按 Host workspace 源码构建的已提交 ZIP（两个 GitHub bot：kit 的 `github-bot-kit` dist 与 Host 源码产出的注释/class field 不同）。列表只减不增   |
| 同步        | `scripts/sync-from-host.sh <Host checkout> [ref]` 重跑同一过滤；filter-repo 结果确定，上次过滤头必须是新头的祖先，否则停止且不合并。首次同步把 `9ece5d27e5` 的两个插件提交以 merge 导入，`plugins/` 树哈希与 Host `dev` 相同                                                                                                                                          |
| Fresh clone | 从 GitHub 克隆后，经 https 下载 kit、`pnpm install --frozen-lockfile`，typecheck、Jest（322/323 suites）、`node:test`（22/22）、pytest（repowiki 327、laya-guard 72）、build、produce 全部完成，不读取 Host。首次克隆暴露 pnpm 11 拒绝未批准的安装脚本（`@parcel/watcher`、`@swc/core`、`esbuild`），已在 `pnpm-workspace.yaml` 的 `allowBuilds` 中按 Host 的选择批准 |
| 比对        | fresh clone 集合与 Host 在 `9c378f0e4d` 用同一 Kit 产出的集合：1744 个文件的内容、hash、mode 全部一致；manifest 只有 `source`（repository/revision/sourceTree/lockfile）与 `toolchain.producerSha256` 不同。之后 Host 插件源码只改了一个不发布的测试文件，producer 只增加 `--repository`                                                                              |
| CI          | `.github/workflows/ci.yml`：bootstrap → install → typecheck → Jest → `node:test` → pytest → build → produce，上传集合与 ZIP。按开发阶段约定，本轮未跟进远端 CI 结果                                                                                                                                                                                                   |

**已知问题：**

- `plugins/cognia-documents/src/docx.test.ts` 的 "does not report reconstructed layout…" 曾在两仓以相同方式失败（多报 `table-formatting`）：`09633f3fb6` 把 `docx` 从 9.7.2 升到 9.9.0 后，未指定列宽的表格 grid 改为按版心宽度均分（两列各 4513），导入检测仍硬编码 `100`。`22255f01c1` 改为按列数向 writer 取期望 grid，新仓库同步后 Jest 323/323 通过。
- Host pin 曾再次失效：`d881d6f702`（ADR-0243 2A-0）改动了 `packages/plugin-contract/src/types/plugin/plugin.ts`，`sdkSourceSha256` 由 `b9e7682f…` 变为 `84065ee1…`。Host 自身的 producer 因此拒绝 ABI，`predev` / `prebuild` 无法 stage 插件。已在 `a401011b8b` 的干净检出中重建 Kit `8f9a0e383a0a`（`test-authoring-kit.mjs` 通过：76 个 frontend 包、346 个类型检查文件、19 组 helper suites、Python wheel 导入），Host pin 提交 `f236c394a5`；Kit 发布在 `authoring-kits` 提交 `75111729dc`，新仓库 lock 提交 `c66c0c5`。重新比对后，两仓集合的 1744 个文件与 `toolchain` 完全一致，manifest 只有 `source` 不同。

**规则：** P4 之前不在新仓库修改 `host-sync-paths.txt` 所列文件，插件改动只进 Host 再同步；两仓差异只放在新仓库自己的配置与 `scripts/*.mjs` 中。新仓库提交使用 GitHub 账号身份（`277988694+MaxQian888@users.noreply.github.com`）。

P2 交付物已建立，但 §17–§26 记录的 P1 验收边界未变，P2 不改变产品 pin，不能据此启动 P4/P5。

## 28. Kit pin 再次重建（2026-11-07）

上下文贡献迁移（ADR-0250 §14）两次改动了 authoring 输入：`9d699315d7` 从插件契约删除 `SendOptions.twinContext`，此前 C3、C4 又把 `ContextSourcesMap` 的模块扩充写进了 `types/knowledge-base.ts` 与 `types/project-knowledge/index.ts`。

| 项目     | 结果                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 构建 | 在干净检出中，`plugin-sdk` 的声明构建拒绝发布：`types/knowledge-base.ts` 进入 SDK 声明，扩充把 `@/lib/modules/manifest-types` 带了进去。两处扩充移到各自的 `context-sources.ts`，由模块的贡献导入（`3c7f602b94`）                       |
| 构建前提 | `plugin-contract` 的声明构建需要先运行 `scripts/build/gen-module-registry.mjs`：生成的模块注册表被 gitignore，干净检出里没有                                                                                                            |
| Kit      | 在 `3c7f602b94` 的干净 worktree 中重建 Kit `01c67873c883`（`sdkSourceSha256` 由 `84065ee1…` 变为 `c7f22dbe…`）；`test-authoring-kit.mjs` 通过：76 个 frontend 包、346 个类型检查文件、19 组 helper suites（105 例）与 Python wheel 导入 |
| Host pin | `2a190110b9`；按提交树计算的 ABI 与 pin 一致                                                                                                                                                                                            |
| 新仓库   | Kit 发布在 `authoring-kits` 提交 `831c22b`；`main` 的 lock 提交 `71dbae6`（`pnpm-lock.yaml` 只更新 SDK、UI 两个 tarball 的 integrity）；bootstrap、typecheck、build（76 个 frontend 包）通过。见下方同步与比对                          |

同步与比对（同日）：`sync-from-host.sh ~/Project/cognia-next dev`（Host `e731ec525d`）报告没有新的插件历史。自上次导入的 `22255f01c1` 以来，`host-sync-paths.txt` 所列路径在 Host 上没有提交，`host-sync.json` 不变。两仓用 Kit `01c67873c883` 各自产出集合：新仓库在 `71dbae6` 运行 `pnpm produce`；Host 在 `e731ec525d` 的干净 worktree 中，先构建 contract、SDK、UI（需要先生成模块注册表、安装 sidecar 依赖），再不带 `--kit` 运行 producer。带 `--kit` 时，Host 会因工作区里的 SDK 不是从 Kit 包安装的而拒绝。

结果：1744 个文件的内容和 mode 全部一致；manifest 只有 `source.repository`、`source.revision`、`source.lockfileSha256` 三项不同，`sourceTree` 与 `toolchain` 相同。
