# Storybook contributor guide / Storybook 开发指南

Storybook previews isolated Cognia component states in a browser. Use it to
review layout, translations, themes, and state-specific rendering. Stories do
not replace co-located Jest tests, application Playwright journeys, or native
Tauri / Capacitor acceptance.

Storybook 用于在浏览器中查看组件的布局、翻译、主题及不同状态。它不能替代 Jest
单元测试、应用级 Playwright 流程或 Tauri / Capacitor 真机验收。

## Run and navigate / 启动与导航

Install workspace dependencies from the repository root using the repository's
pinned pnpm. Then run:

```sh
pnpm storybook
# http://localhost:6006

pnpm build-storybook --output-dir .cache/storybook-full

# Selected scenes plus browser gates
pnpm storybook:quality
```

The dev entry point generates module registries and checks stale webpack
caches. The static build writes a standalone Storybook, separate from the
application's `out/`. Storybook's MCP endpoint is `http://localhost:6006/mcp`
while the dev server runs; `.mcp.json` registers it for clients that load that
configuration. Registration alone does not mean the endpoint is online.

开发入口先生成模块 registry、检查旧 webpack 缓存。静态产物独立于应用 `out/`。
MCP 仅在开发服务器运行时可用，配置存在不等于服务在线。

Open **Documentation → Overview** first. On a component's Canvas, use the
**Locale** and **Theme** menus for `en` / `zh-CN` and light / dark. The preview
uses real message bundles, app CSS, `public/` assets, UTC, Next App Router mocks,
and an isolated translation/theme/tooltip provider stack. It does not mount
`AppRuntime` or the full application bootstrap.

先打开 **Documentation → Overview**；在组件 Canvas 工具栏切换语言和主题。
预览复用真实翻译、样式和静态资源，不启动完整应用。

## Ownership and compatibility / 归属与兼容性

| Source                                                    | Responsibility / 职责                                                                     |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `.storybook/main.ts`                                      | Webpack framework, discovery, aliases, static assets / 框架、发现、别名、静态资源         |
| `.storybook/preview.tsx`                                  | Locale/theme toolbar and preview providers / 语言、主题、预览 provider                    |
| `.storybook/server-channel.ts`                            | Keep the oversized internal graph index server-side; retain HTTP MCP / 内部索引留在服务端 |
| `.storybook/quality-stories.json`                         | Explicit PR scene selection / PR 场景清单                                                 |
| `playwright.storybook.config.ts`, `tests/e2e/storybook/`  | Render/play, WCAG, keyboard, isolation and visual checks / 浏览器检查                     |
| `.github/workflows/storybook.yml`                         | Selected PR checks and full-catalog push builds / CI 入口                                 |
| `.storybook/overview.mdx`                                 | In-workshop entry guide / 预览内入口指南                                                  |
| `.storybook/next-layout-router-context.tsx`               | Scoped Next router compatibility shim / 路由兼容 shim                                     |
| `.storybook/mocks/use-chat-pane-runtime.ts`               | Chat controller action spies / 聊天控制器动作 spy                                         |
| `hooks/chat/use-follow-up-suggestions.mock.ts`            | Controllable follow-up suggestions / 可控的后续建议                                       |
| `components/**/*.stories.ts(x)`                           | Co-located component scenarios / 就近组件场景                                             |
| `lib/storybook/seed-stores.ts`, `seed-db.ts`, `fixtures/` | State reset and synthetic fixtures / 状态重置与合成数据                                   |
| `scripts/storybook/inventory.mjs`                         | Repeatable source inventory / 可复现源码清单                                              |

The running framework is `@storybook/nextjs` (webpack). Older stories still
import types from `@storybook/nextjs-vite`; that does not select the runtime
bundler. New or touched stories should use the running framework's types.
Do not migrate bundlers as a shortcut around an individual component failure.

当前运行框架为 webpack；旧文件中的 Vite 类型导入不决定运行时。新增或修改的 story
使用 `@storybook/nextjs` 类型。

Compatibility constraints in `main.ts` are deliberate:

- Lazy compilation builds a dev story when first opened; server readiness
  alone does not prove every story compiles.
- React Fast Refresh is disabled to avoid initialization cycles in the chat
  graph. Expect full reloads and state resets on edits.
- Root workspace directories such as `packages/` are watch-ignored to avoid a
  webpack symlink watcher failure. Restart after changing those dependencies.
- Node-only fallbacks permit browser bundling; they do not implement native
  features in the browser.
- Production builds disable source maps and persistent caches. Full builds use
  the framework's installed native SWC minifier with one worker and a 10 GiB
  Node heap: the default JavaScript minifier exhausted that heap on this graph.
  Full artifacts retain compression/minification; development keeps its
  debugging setup. The selected quality artifact is explicitly unminified to
  fit PR runners. The application's production build is unaffected.
- The pinned Storybook family is 10.6.6. Its internal module-graph index contains
  over nine million reverse edges in this repository. `server-channel.ts` keeps
  only this internal service snapshot off the browser websocket; local
  subscribers and HTTP MCP use the real index. Public graph status, globals and
  command replies are still forwarded. The shim fails visibly on an unknown
  transport contract and needs review on a Storybook upgrade.
- Automatic prop extraction is disabled because of recursion in the large
  store graph. Use explicit `argTypes` for the props readers need.
- The iframe-head file retains legacy interop shims. Their necessity has not
  been re-proven by this information audit; removal requires a separate
  before/after render check.

按需编译、整页重载和 workspace 依赖变更后重启均是当前预期行为；浏览器中的 Node
fallback 不代表原生功能可用。历史 shim 是否仍必需，需要独立验证后再删除。

## Author a useful story / 编写有用的 story

Extend an existing story when it owns the component. Put a new story beside
its component only when no existing file covers it. `Shared/StatusBadge` is the
small example with manual controls and selective Autodocs; `Chat/ChatPane`
illustrates a composed page with an explicit runtime adapter.

优先扩展已有 story。`Shared/StatusBadge` 展示控件和文档，`Chat/ChatPane` 展示组合页面
及运行时替身。命名应表达用户可见状态，而不是组件内部实现。

For each component, document:

1. **Purpose and inputs:** what it renders and the meaningful props.
2. **Setup:** required providers, store slices, DB rows and fixture builder.
3. **Scenario:** trigger, expected result, and callback effects.
4. **Boundary:** real versus mocked actions; browser versus native behavior.

Use `parameters.docs.description.component` and
`parameters.docs.description.story` for reader-visible prose. Comments in the
CSF source are useful for maintainers but are not a substitute for visible
documentation with the current configuration.

说明应包含用途、输入、依赖、触发条件、预期结果和平台边界。当前配置不会把所有源码
注释自动转换为可见文档。

```ts
import type { Meta, StoryObj } from "@storybook/nextjs"
import { StatusBadge } from "@/components/status-badge"

const meta = {
  title: "Shared/StatusBadge",
  component: StatusBadge,
  tags: ["autodocs"],
  args: { value: "running", labelNamespace: "twin.status" },
  parameters: {
    docs: {
      description: {
        component: "Translated status; no store, database or native host required.",
      },
    },
  },
  argTypes: { pulse: { control: "boolean", description: "Show the decorative status dot." } },
} satisfies Meta<typeof StatusBadge>

export default meta
type Story = StoryObj<typeof meta>
export const Running: Story = { args: { pulse: true } }
```

This is a metadata example, not an instruction to create a second StatusBadge
story file. Enable Autodocs per component after checking that its examples can
mount together safely. Global Autodocs would combine stories whose `beforeEach`
resets shared state or IndexedDB; keep those on separate canvases or write
documentation that does not mount them together.

此示例用于说明 metadata，不要重复创建文件。仅对可安全共同挂载的组件启用 Autodocs；
含共享状态或数据库重置的场景应单独预览。

### State and side effects / 状态与副作用

- Use `args` and `fn()` from `storybook/test` for prop-driven components.
  A spy records calls; it does not perform or verify the real operation.
- In `beforeEach`, reset every store the story mutates using `resetStore` /
  `resetStores`, then apply `seedStore`. The reset helper resets in-memory
  state; it is not a general browser-storage cleanup.
- Use `await seedDb(fill)` with existing fixture builders for Dexie views.
  It deletes and recreates the preview origin's Cognia DB, waits for built-in
  seeds, warms workspace scope, then inserts scenario rows. Use a dedicated
  Storybook origin/profile and do not run DB-reset stories concurrently.
- Keep IDs and timestamps fixed when a scenario does not test time. Clean up
  timers, subscriptions and temporary browser patches through the lifecycle's
  cleanup function. Verify switching A → B → A reproduces A.
- Follow-up suggestions and the chat-pane controller are globally aliased.
  Other effects can still reach real browser storage or network APIs. Inspect
  mount effects and provide narrow adapters before exercising those actions.
- Use translated production labels. Synthetic fixture prose does not prove
  translation completeness. Test long labels and narrow widths explicitly.

重置所有修改过的 store，使用固定 fixture；清理定时器与订阅，并验证 A → B → A
可复现。`seedDb` 会删除当前预览 origin 的数据库。只有明确替换的动作才是 mock，
其他网络和存储副作用需逐项检查。

### Scenario checklist / 场景检查

| Component kind / 类型        | States worth reviewing / 值得检查的状态                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Lists and panels / 列表面板  | Loading, empty, populated, error/retry, long content / 加载、空、正常、失败重试、长内容                            |
| Forms and dialogs / 表单弹窗 | Open/closed, invalid, pending, success/failure, disabled / 开关、无效输入、提交中、成功失败、禁用                  |
| Chat and runs / 聊天运行     | Thinking, streaming, tool/approval, interrupted, error, long transcript / 思考、流式、工具审批、中断、错误、长记录 |
| Host-dependent UI / 依赖宿主 | No host, disconnected, denied, unavailable capability / 无宿主、断连、拒绝、能力不可用                             |
| Shared primitives / 通用组件 | Variants, keyboard/focus, disabled, long translated labels / 变体、键盘焦点、禁用、长翻译                          |
| All visual UI / 所有可视界面 | English/Chinese, light/dark, narrow/wide, reduced motion / 双语、双主题、窄宽布局、减少动画                        |

This is a review matrix, not a claim that every cell already exists or that
every component needs every state.

## Inventory and current gaps / 清单与当前缺口

```sh
node scripts/storybook/inventory.mjs
node scripts/storybook/inventory.mjs --json > .cache/storybook-inventory.json
node --test scripts/storybook/inventory.test.mjs scripts/build/storybook-config.test.mjs
```

The inventory parses TypeScript syntax so fixture `description` fields and
comments do not inflate documentation counts. It reports local CSF metadata,
story exports, area counts, and every `.tsx` module without a same-stem story.
That last list includes providers, wrappers, and non-visual code. Triage it;
do not interpret it as a missing-feature count or a percentage of UI coverage.
Imported/spread metadata, re-exports, factories and inherited tags are outside
the static inventory's scope. Use the running `/index.json` for actual indexed
entries and render checks for runtime correctness.

AST 清单区分真正的文档字段与 fixture 数据。缺少同名 story 的文件只是候选项，包含
provider、wrapper 和非可视模块，不能直接换算为功能缺口或 UI 覆盖率。实际条目以
运行中的 `/index.json` 为准；索引成功也不等于渲染成功。

The dated baseline is in
[the evidence ledger](../evidence/2026-11-10-storybook-information-gaps.md).
Maintain a rolling backlog in this order:

## Automated workshop checks / 自动检查

```sh
pnpm storybook:config:test
pnpm storybook:quality:build
pnpm exec playwright install chromium
pnpm storybook:test
# Run the same selected assertions against a built, minified full catalog:
STORYBOOK_FULL_CATALOG=1 pnpm storybook:test
# Equivalent build + browser entry: pnpm storybook:quality
```

The normal dev/build commands retain the complete catalog. Only
`STORYBOOK_QUALITY=1` selects `.storybook/quality-stories.json`: 37 files with
148 explicitly tagged scenes. Discovery rejects absent files, empty selection
and missing Overview; it cannot pass by silently collecting zero stories.
RawFallback intentionally demonstrates an absent translation key and is not
in the quality selection.

普通启动和构建保留完整目录；PR 检查明确选取 37 个文件中的 148 个场景，缺文件、
空选择、缺指南都会失败。故意使用缺失 key 的 RawFallback 不参与自动检查。

The dedicated Playwright configuration serves `.cache/storybook-static` on
127.0.0.1:6007, with no application global setup or host fleet. It waits for
Storybook's successful render **and play completion**, rejects page errors
and outbound host/provider requests, and runs axe WCAG A/AA checks. Projects
cover en/light, zh-CN/dark and a 390px viewport. Every selected canvas must also fit its viewport; horizontal scrollers keep
content overflow inside the control. Separate checks exercise modal
focus/Escape, checkbox and device-filter keyboard input, and A–B–A Files/Chat story selection in the same
preview realm. Store stories assert their initial state before mutation.

独立配置不启动应用后端；等待渲染与 play 断言完成，检查错误及意外外连，并运行
axe、键盘、焦点、同一预览内状态重置检查。自动矩阵是英文亮色、中文暗色及 390px
窄屏；这不是所有语言、主题与尺寸组合的穷举。

The visual fixture compares real spinner/skeleton/progress geometry and app
color tokens, with no visible system-font text. Geist fonts are served locally;
UTC and reduced motion are fixed. Baselines live beside the spec. Generate
updates with `pnpm storybook:test --grep @visual --update-snapshots`, inspect
all three images, then run again without update mode. Review baseline changes
as UI changes; do not refresh them merely to conceal a regression.

截图使用真实加载组件与主题颜色，固定字体、时区和动画。更新后人工检查三张基线，
再以普通模式比较；截图通过不能代表真实数据加载或原生功能正常。

CI runs the selected build/browser lane for relevant PR changes and pushes.
Full-catalog static builds and English/light selected-scene compatibility checks
run separately on dev/master pushes or manual `full_catalog` dispatch. The full
lane omits screenshot comparisons; visual baselines use the dedicated ARM
runner above. Browser diagnostics are retained for seven days.
Local execution does not establish that the hosted workflow has run.

### Added representative areas / 本次补充的代表区域

| Area        | States and boundary / 状态与边界                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| UI          | Button/input/checkbox/switch, textarea, radio/select, tabs, dropdown, dialog and loading / 表单、选择器、菜单、弹窗与加载状态                  |
| AI Elements | User/assistant message, reasoning, approval, task collapse and highlighted code with equal-length edits / 消息、推理、审批、任务及代码编辑     |
| Bots        | Healthy/selected/no trigger/dead-letter/orphan rows; real browser no-host notice / 列表及无宿主提示                                            |
| Creator     | Permission changes/stale approval, review outcomes, step progression and unavailable directory picker / 权限、审查、步骤及宿主缺失             |
| Files       | Empty/filter/trash/workspace copy, failed remote refresh notice and reset mobile lens selection / 空态、断连及移动端筛选状态                   |
| Onboarding  | Browser/desktop step sequences, busy and read-only selection / 步骤序列及禁用                                                                  |
| Agent Runs  | Plan, invalid budget, capability audit, host-required recovery and busy review / 审批及恢复表单                                                |
| Devices     | Controlled rail search/filter/selection, deferred loading, section navigation and host version advice / 受控筛选、延迟加载、分节导航与版本提示 |
| Issues      | Mixed editable/read-only selection, action eligibility, run history and paused wakeups / 混合权限、批量操作资格、运行历史与唤醒暂停            |
| Chat        | Empty/conversation/thinking/tool/error, code/long source and real streaming/finalized parity / 空态、消息、思考、工具、错误、代码与流式一致性  |

These are real components with typed synthetic inputs. Callback spies never
approve an actual run, pick a directory, reconnect a host or execute a Bot.
Native and paired-host notices use the honest browser-unavailable path;
separate Tauri/Capacitor/provider acceptance remains required.

这些场景使用真实组件和合成输入；spy 不会实际审批运行、选目录、连接宿主或执行 Bot。
真实外壳、配对宿主和模型服务仍需单独验收。

The second batch adds 11 CSF modules and 50 scenes, enriches two existing
composed surfaces, and extends the explicit quality selection by 60 scenes.
Device rail callbacks update story-local controlled state, so filtering and keyboard
selection really change the preview. Host updates always use an injected
install spy. Chat setup resets both stores, clears only its fixture session's
history preview and pending dispatch, and disables automatic suggestions and
provider fallback. Header/native effects remain outside these stories. Select and dropdown examples
include an inert background wrapper while their modal portal is open; the
browser checks native focus isolation and Escape restoration. Their open-state
axe results apply to this documented composition, not a bare primitive in any
host layout. No axe rule is disabled. Composed Chat now uses the production
default One syntax palette, corrected and checked by the third batch below.

第二批新增 11 个 story 文件、50 个场景，并完善已有设备列表及聊天组合页；自动选择
增加 60 个场景。设备筛选会真实更新预览状态，宿主安装始终注入 spy；聊天重置状态并
关闭自动建议与模型回退。计时流式演示仍留在完整目录，不作为确定性检查。

### Code surfaces / 代码预览

`Chat/CodeBlock` documents language fallback, wrapping, line emphasis and a
2,001-line CRLF/Unicode source. `Chat/ReadingSurface` has isolated One and
GitHub previews that switch real Streamdown output to finalized Markdown and
back. Its older rich-content examples remain manual. `AI Elements/CodeBlock`
adds line numbers and an equal-length middle edit that catches stale tokens.
All inputs are synthetic; Confirm/Edit only change local preview state.

`lib/shiki/chat-code-themes.ts` supplies the same corrected One and GitHub
registrations to all three production consumers. Public settings IDs stay the
same. Unique internal names prevent a previously loaded raw theme from winning
an engine cache lookup. The correction checks foreground rules against built-in
neutral surfaces and explicit token backgrounds; inherited ink and font styles
are retained. Other syntax families, arbitrary custom themes and wallpaper
backgrounds are outside this contrast evidence.

Browser assertions compare actual streaming/finalized token colours, switch
light/dark on existing DOM nodes, check keyboard access to AI and manual code
scrollers, and capture exact Unicode/CRLF copies locally. A clipped preview must
still copy the complete original source. The Node engine check also loads raw
themes first and verifies the real Shiki/Streamdown registrations and tokens;
Jest's theme adapters read the installed theme data rather than substitute
colours. These checks do not call a provider or the native shell.

第三批新增 7 个场景，补充三个代码预览区域：真实流式/完成态颜色一致、同一 DOM
亮暗切换、等长中间编辑、键盘横向滚动，以及截断显示时仍完整复制 CRLF/中文源码。
One 和 GitHub 共用生产修正，保留设置 ID；其他语法主题、自定义主题和壁纸背景仍需
单独验证。复制测试仅捕获当前浏览器上下文的写入，不改系统剪贴板。

### Remaining backlog / 剩余改进

- Extend explicit contracts and assertions across the older catalog. The
  selected suite does not render all 3,875 stories.
- Add more composed workflows and loading/error/long-content states only after
  reviewing mount effects and defining safe, narrow adapters.
- Audit additional syntax families and custom surfaces with the same real
  renderer, contrast, source-fidelity and theme-switch checks.
- Expand visual baselines beyond loading primitives and evaluate additional
  theme/locale combinations when useful.
- Reassess legacy iframe/router shims and old nextjs-vite type imports with
  before/after startup, rebuild and representative renders.

继续完善旧目录的说明、断言和组合流程，逐步扩展截图范围；不要根据文件数宣称完整
行为覆盖。历史兼容 shim 应以运行证据决定是否移除。

## Troubleshooting and verification / 排障与验证

The captured startup failure was `services:patches` for
`core/module-graph-index`: 11,781 indexed files and 9,151,926 reverse edges.
The server-only transport shim addresses this event without dropping stories
or disabling MCP. If the crash returns, retain logs and verify the exact event,
pinned package family and transport contract before changing the filter.
Increasing heap does not address V8's maximum string length.

已定位超大内部索引事件；shim 保留全部场景及 MCP 本地查询。再次出现时先核实事件、
依赖与 transport 契约，单纯增加堆内存无法解决字符串长度上限。

Full-catalog traces capture much larger script responses. If a local run fails
with `ENOSPC` during `browserContext.close` or trace writing, retain the failed
report and check free disk space. For local confirmation, the same assertions
can run without trace capture:

```sh
STORYBOOK_FULL_CATALOG=1 pnpm storybook:test --trace off
```

This changes diagnostics only; keep the default CI trace policy and report the
local override. A resource-failed run does not count as a passing matrix.

完整目录的 trace 可能耗尽本地临时空间。保留失败报告、核实磁盘后，可用上述命令
关闭本地 trace 重新执行全部断言；CI 默认策略保持不变，并在结果中说明该选项。

| Symptom / 现象                                            | Check / 检查                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Story missing / 找不到 story                              | File matches `components/**/*.stories.@(tsx\|ts)`; valid CSF default export and named story; check `/index.json` / 文件匹配规则、CSF 默认导出与命名场景 |
| No Docs tab / 无 Docs                                     | Component has opted into `autodocs`; docs addon alone does not create every page / 是否显式启用 `autodocs`                                              |
| Empty prop table / props 表为空                           | Prop extraction is disabled; define manual `argTypes` / 手写 `argTypes`                                                                                 |
| Empty list / 列表为空                                     | Seed required DB rows and active workspace/store state / 初始化数据库、workspace 和 store                                                               |
| Missing runtime provider / 缺 provider                    | Use a narrow story adapter; do not mount the real app bootstrap / 提供明确的 story adapter                                                              |
| Workspace edits do not update / workspace 修改未更新      | Restart because those roots are watch-ignored / 重启预览                                                                                                |
| Router/module initialization error / 路由或模块初始化错误 | Check installed package versions and existing webpack/shim rules before adding more mocks / 检查依赖版本与兼容配置                                      |
| MCP connection refused / MCP 拒绝连接                     | Start the dev server and verify port 6006; static hosting does not serve the addon endpoint / 启动开发服务，静态站点不提供该端点                        |

For a change, run the focused Node checks above, lint the touched files, run
the relevant co-located Jest tests with `pnpm test --runInBand --runTestsByPath
<test-path>`, then inspect the actual affected story in a browser. Check both
locales/themes, keyboard access where relevant, console errors, and A → B → A
state isolation. Build the static workshop when config, docs, or shared preview
dependencies change. Record exact blockers rather than claiming the entire
catalog works after one successful render.

变更后执行针对性检查及关联 Jest 测试，在真实浏览器查看场景，检查语言、主题、键盘、
控制台和切换隔离；配置或共享预览依赖变更还需静态构建。单个场景通过不能代表整个
目录全部通过。

The application build is a separate acceptance boundary. The 2026-11-11 run
stopped before webpack at the authoring-kit ABI gate. The earlier Storybook
batch's global CSS and lockfile changes contribute to the mismatch; SDK inputs
also differ. Do not rewrite the pin in this shared tree to bypass the check.
[The authoring-kit policy, section 26](../plans/2026-10-30-plugins-repository-extraction.md)
requires a clean target checkout for rebuilding and validating the kit before
adopting its pin. Passing Storybook builds cannot establish application-build
acceptance while that gate is blocked.

应用构建仍被 authoring-kit ABI 前置检查阻塞，其中包含前两批全局 CSS/lockfile 变更的
影响，不能全部归为无关问题。需按上述契约在干净目标检出中重建、验证 kit 后处理 pin；
Storybook 构建通过不能替代这项验收。

## Sources

- [Storybook tags and selective Autodocs](https://storybook.js.org/docs/writing-stories/tags)
- [Storybook MDX documentation](https://storybook.js.org/docs/writing-docs/mdx)
- [WAI radio-group keyboard pattern](https://www.w3.org/WAI/ARIA/apg/patterns/radio/)
- [Playwright accessibility checks](https://playwright.dev/docs/accessibility-testing)
- [Playwright screenshot baselines](https://playwright.dev/docs/test-snapshots)
- [Storybook ArgTypes](https://storybook.js.org/docs/api/arg-types)
- Repository source: `.storybook/`, `lib/storybook/`, `package.json`,
  `.github/workflows/`, and ADR-0138 (reading-area layout stability).
