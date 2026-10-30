# 云文档在右侧 Dock 的双视图预览计划

| 项目     | 内容                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 计划草案；首期双视图目标已确认；产品实现与真实提供商验收尚未开始                                                                                                                                                                    |
| 日期     | 2026-10-29，Asia/Shanghai                                                                                                                                                                                                           |
| 需求     | 飞书、Google 等云文档在右侧产物区域预览；用户明确选择“两种体验都作为首期要求”                                                                                                                                                       |
| 首期交付 | 同一文档可在右侧 Dock 查看只读内容快照，也可查看保留原平台排版、评论与协作的实时原文                                                                                                                                                |
| 证据     | [当前实现审计](../reports/2026-10-29-cloud-document-preview-audit.md)、[提供商研究](../reports/2026-10-29-cloud-document-provider-preview-research.md)、[持续证据账本 G15](../evidence/2026-10-21-feishu-document-support-audit.md) |
| 约束     | 复用 DocsProvider、附件管线、Dock 与浏览器；保留静态导出；不复制凭据体系                                                                                                                                                            |
| 负责人   | 云文档集成负责人；工作包按下文角色拆分，实际人员在启动时指定                                                                                                                                                                        |
| 日历工期 | P0 实验完成后估算；当前不承诺未经验证的原生集成交付日期                                                                                                                                                                             |

**建议在现有右侧 Dock 增加“内容快照 / 实时原文”两个视图，并把两者同时作为首期发布门槛。** 内容快照复用文档读取与文件渲染；实时原文优先验证独立登录环境中的原平台网页，飞书云文档组件作为备选技术路线。需要证明的是用户能在 Dock 内看到原生排版、评论和协作，外部浏览器跳转、登录页、iframe 加载完成或只读导出均不算完成。当前最大的未知是实时原文的登录、账号和浏览器隔离；先用有预算的实验确定路线，再进入产品实现。

## 1. 首期验收同时覆盖内容读取与实时原文

现有实现已经能读取云文档，也能在 Dock 打开网页，但附件预览仍在弹窗，引用和来源入口不一致。问题是缺少贯通入口、身份、生命周期和两种阅读方式的完整体验，而非缺少另一个侧栏。

| 目标                 | 首期成功标准                                                                                                               | 对应验收   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| G-P1：统一入口       | 聊天文档链接、暂存附件、已发送附件、引用/来源、已确认的建文档工具结果均可进入所属会话的右侧 Dock                           | AC1、AC2   |
| G-P2：内容快照       | 读取权限允许时显示正文/表格内容、来源、读取时间、完整性和显式刷新；不冒充原生文档                                          | AC3、AC6   |
| G-P3：实时原文       | Feishu 与 Google 的核心文档均能在 Dock 内登录、显示原生排版、查看评论；第二客户端改动后可见更新，具备权限时可人工评论/编辑 | AC4、AC5   |
| G-P4：身份与数据边界 | 不混用读取账号和浏览器账号，不跨会话/工作区展示旧结果；预览不会自动发给模型、发布或扩大分享                                | AC7—AC10   |
| G-P5：生产可用       | 静态导出、实际 Tauri 界面、键盘/焦点/i18n、恢复与失败状态均有证据                                                          | AC11、AC12 |

首期完整支持的基准平台建议为 **macOS Tauri 桌面端**，与当前工作站及 DocsProvider 的真实运行条件一致。Windows/Linux 进入各自发布支持矩阵前必须补实机证据；不能用 macOS 结果代表跨平台完成。Web、Capacitor、headless 的具体边界见第 7 节，此平台范围属于待确认的 Q2，不是已获用户同意的缩减。

资源范围如下；原生能力始终受原平台资源类型和文档 ACL 限制，不能把只读用户说成可编辑用户。

| 来源                   | 首期内容快照                                              | 首期实时原文                                                     |
| ---------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| 飞书 docx / legacy doc | 现有文本读取；明确布局/媒体损失                           | 对实际仍可访问的类型验证网页/组件；排版与评论；legacy 兼容性单列 |
| 飞书 Wiki              | 保留 Wiki 来源，解析到现有支持的 doc/sheet/bitable 读取器 | 保留 Wiki 导航语义及最终文档权限，不能只拼底层 token URL         |
| 飞书 Sheets / Bitable  | 现有分节 CSV，保留表/工作表与截断提示                     | 验证原生表格界面与该资源实际支持的评论/协作能力                  |
| Google Docs / Sheets   | Markdown/text 与分节 CSV                                  | 原平台原生文档/表格界面及其评论、协作能力                        |

Google Slides、任意 Drive PDF/Office 文件、Notion、OneDrive/SharePoint 不计入上述现有两家 provider 的首期资源承诺。它们有单独接入工作：Slides 需要扩展现有 Google provider；Notion/Microsoft 复用[已有方案](2026-10-22-cloud-document-providers-notion-microsoft.md)。此处不重复设计新 provider。首期不实现跨厂商统一编辑器、评论数据库或协作协议；原生视图内的人工操作继续由原平台处理。

## 2. 当前可复用的机制与真实缺口已经区分

| 已确认事实                                                                          | 当前拥有者                                                                                                                                                                                   | 对计划的影响                                                    |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 内置 reader 为 Lark、Google，均 `hosts: ["tauri"]`                                  | [provider registry](../../lib/docs-providers/index.ts)、[contract](../../lib/docs-providers/types.ts)、[reach](../../lib/docs-providers/reach.ts)                                            | 不因新增界面就声称新增 Web/手机读取能力                         |
| 选择云文档后 fetch → 合成 File → 附件 intake；绑定账号/授权代际，发送经过既有保护   | [staging](../../hooks/chat/use-remote-doc-staging.ts)、[intake](../../components/chat/composer/hooks/use-attachment-intake.ts)、[dispatch](../../lib/chat/attachments/dispatch.ts)           | 复用读取、取消与发送边界；预览与“附加到聊天”分开                |
| 附件弹窗与聊天文件预览已有可用渲染器                                                | [dialog](../../components/chat/composer/attachment-preview-dialog.tsx)、[FilePreviewSurface](../../components/file-viewer/file-preview-surface.tsx)                                          | 抽取或复用内容体，避免复制另一套文件预览                        |
| Markdown 链接已经请求侧边浏览器，Sources 面板尚未统一                               | [ChatLink](../../components/chat/markdown/chat-link.tsx)、[ExternalLink](../../components/shared/external-link.tsx)、[Sources](../../components/context-workbench/session-sources-panel.tsx) | 改入口路由，而非改所有外链的默认行为                            |
| Dock 已有 panel/artifact/page 三类 tab、会话恢复与页面生命周期                      | [tabs](../../stores/artifact/dock-tabs-store.ts)、[dock-pages](../../lib/artifacts/dock-pages.ts)、[host](../../components/artifacts/artifact-workspace-dock.tsx)                            | 统一 tab 条与 Dock 展示，不再新增独立右栏                       |
| `ContextRef` 只有 kind/id/label/raw；读取器完整绑定未保留在通用引用中               | [citation](../../lib/chat/mentions/attachment-citations.ts)、[ContextRef](../../packages/plugin-contract/src/lib/chat/mentions/types.ts)                                                     | 历史引用不能自动推断原读取账号；缺绑定就重新选择                |
| 原始附件与删除 tombstone 已有 owner；普通草稿会保存附件数据                         | [session assets](../../lib/db/session-assets.ts)、[drafts](../../lib/chat/draft-attachments.ts)                                                                                              | 预览本身不新建持久正文；主动附加沿用现有保留/删除规则           |
| 本地 Chromium 共享 default profile；会话 Dock 页面与该会话 agent 使用 `chat:` owner | [shared browser](../../lib/browser/shared-local-browser.ts)、[agent routing](../../lib/browser/agent-engine.ts)                                                                              | 页面 owner 不能证明 Cookie/登录态隔离；原生预览需要独立权限边界 |
| Lark parser 可接受未知 host 并标低置信，provider matchRef 未保留该标记              | [URL parser](../../lib/twin/ingest/lark-url.ts)、[provider](../../lib/docs-providers/providers/lark/index.ts)                                                                                | 不把当前“可提取 token”当作“可信原生页面 URL”                    |

2026-10-29 的审计运行了 **9 suites / 206 tests，全部通过**。这是旧流程的基线，不是本计划新功能或真实账号验收。普通 `pnpm test` 当时被自动安装中的 sidecar 导出检查阻断；显式关闭自动依赖同步后通过。实现开始时需重新检查，不把这个历史失败说成永久阻塞。

## 3. 先完成四个有终点的实验，禁止用降级路径替代首期目标

| 实验                | 要回答的问题 / 预算                                                                                       | 成功证据                                                                                                           | 停止条件与下一决策                                                                           | 负责人           |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------- |
| S1：Google 原生视图 | 现有本地 Chromium / 嵌入 WebView 中，隔离身份的私有 Docs 能否完成实际登录和协作？两轮，每轮最多 60 分钟   | 指定测试账号、原生页面、评论面板；第二客户端更新正文/评论后 Dock 内可见；记录引擎与登录方式                        | 两个允许路线均无法登录/显示协作，记录原因，首期实时能力保持阻塞；不改称“外链已支持”          | 桌面浏览器负责人 |
| S2：飞书原生视图    | 同样隔离条件下，原平台网页是否满足 docx/Wiki/表格？需要时验证官方组件；网页 60 分钟，组件鉴权调查 60 分钟 | 真实允许/拒绝文档、Wiki 跳转、评论/协作；组件路线要有官方签名与域名契约                                            | 组件需要新增可信签名服务时，先记录部署、密钥、来源域与运维依赖；不把 app secret 放入静态应用 | 飞书集成负责人   |
| S3：浏览器权限隔离  | 现有 `profileId` 与 session/grant 原语能否隔离原文登录态、agent、账号、窗口及 tab？90 分钟，含故障注入    | 不共享 agent default Cookie jar；未经授权 agent 不能枚举、捕获、驱动或借新页面访问原文身份；双账号和重建隔离可重复 | 只有 UI owner 隔离而无 Host/runtime 检查，则判失败；先补最低层 session 权限与兼容性合同      | 浏览器安全负责人 |
| S4：来源与恢复贯通  | 以不复制正文的方式，现有 staged/source asset/draft 能否恢复到正确文档？60 分钟                            | staged → send → history → restart → delete 的来源、assetId、hash、一致性；无账号信息进入分享投影                   | 如确需新表/索引或协议变更，重评规模，先完成 schema/兼容性评审，再编码                        | 附件数据负责人   |

实验输出保存在 `.cache/diagnostics/cloud-document-preview/`，只保存脱敏步骤、结果、截图和源快照；不保存 token、真实 Cookie、个人文档全文。实验代码不直接转成产品代码。真实账号与测试文档需要在执行时指定；评论/编辑测试使用明确授权的可丢弃文档。本次计划没有执行这些外部操作。

P0 的完成条件是**每个未知项有带证据的结论、所选生产合同、预计修改 owner 和可执行的验收断言**，不是完成 P3 的产品代码。S3 先用合成数据确定现有边界和最小原型，再决定是否具备测试登录的安全条件；没有条件时 S1/S2 记录受限项，先用非敏感样本确认候选路径。若结论是“现有原语不足，需要 P3 在既有 owner 增加受限 session/事件能力”，可在相关架构/安全评审明确批准该方案后进入 P3；若没有可信候选路线则停止并保留阻塞。S1—S4 的最终生产结论仍须在 P3/P4 以完整负测及真实双向协作关闭，不能把 P0 原型通过当成最终验收。

路线选择规则：Google 优先原平台网页；飞书优先原平台网页，必要时换官方组件。**任何选择都必须满足隔离与双视图验收**。Google 的 Publish to web 只适用于用户已发布资源，不用于修复私有文档加载。`user-chrome` 仅在用户明确选择且隔离/权限审查通过时提供；不能自动挂接用户现有全部浏览器会话。托管远程浏览器不作为默认替代，因为它会改变私有页面的处理位置。

## 4. 一个文档 tab 管两种视图，正文、凭据与窗口状态分别归原 owner

所有入口先生成经过验证的文档打开请求，再由已有 Dock 控制其会话、tab、焦点和尺寸。快照与实时原文采用同一个文档 tab 的内部视图切换；不会显示两条竞争的 tab 栏。实时内容可以由现有 BrowserPreviewPane 的隔离会话模式承载，快照使用现有文件/文档渲染体。页面生命周期仍由原浏览器 owner 实现；不要把新安全模式交回普通 `chat:` agent 页面。

```text
聊天链接 / 附件 / 来源 / 工具结果
              │  validate + resolve document + capture destination
              ▼
        现有右侧 Dock 文档 tab
          ┌───┴─────────────────────┐
          ▼                         ▼
     内容快照                  实时原文
 DocsProvider / SessionAsset    隔离原文浏览器 / 飞书组件
 existing file renderer        provider-native UI
          │                         │
          └──── 显式“附加到聊天” ────┘
                     ▼
          existing intake → untrusted wrapper → PII send gate
```

这张流程图表达数据和权限分流：看文档不等于附加给模型，实时原文不等于持久快照。

受限原文模式必须覆盖现有浏览器的全部伴随行为，不仅隔离 tab/RPC。当前 [LocalChromiumPreview](../../components/browser/local-chromium-preview.tsx) 会调用 [useBrowserHistory](../../hooks/browser/use-browser-history.ts) 持久化访问记录，而 [browserHistoryKey](../../lib/db/browser-history.ts) 保留 query/fragment；[native local browser](../../src-tauri/src/browser/local.rs) 还向 local session 注入全局 enabled extensions、全局下发 extension reload，并通过 `app.emit` 广播事件。[bridge](../../crates/cognia-local-browser/src/bridge.rs) 转发的事件可能含页面与身份字段。直接复用会带入这些副作用，P3 必须逐项控制。

| 数据/合同（拟新增或扩展）    | 唯一 owner 与生命周期                                                                                                           | 验证/兼容规则                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `DocumentOpenRequest`        | 扩展 `lib/docs-providers/types.ts` 与现有打开路由；输入包括调用入口、目标 session/workspace、ref、期望视图、可选现有 asset 关联 | ref/URL/asset 均视为外部输入；严格识别类型与 host；本地调用也验证 session ownership；不含 token                                             |
| `RemoteDocumentProvenanceV1` | 现有 staged attachment → draft → `SessionAsset` 的可选来源元数据                                                                | 只含 provider/resource/type/规范 URL、读取时间、完整性、assetId/hash 对应关系；不含账号、epoch、浏览器 profile、Cookies；具体字段经 S4 固定 |
| 读取身份 binding             | 现有 provider authority；预览 controller 内存保存选定 accountId/epoch                                                           | 不扩写通用 `ContextRef.raw`；恢复后失去有效绑定就让用户重新选择，绝不绑定“第一个可用账号”                                                   |
| 快照正文                     | 未附加的预览仅存在可释放内存；已暂存/发送的内容继续归现有 staged bytes / SessionAsset                                           | Dock 不再持久化一份全文；body 绑定 revision/hash；来源删除/撤销保留语义明确；不能从历史消息反向“恢复”已删除源                               |
| Dock 文档描述与视图          | 同一 per-session tab owner 管理；普通 tab 保持原持久 slice，文档专用描述使用版本化扩展 slice                                    | 新文档 kind/active 引用不进入旧 envelope；扩展 slice 不复制普通 pages/order/open，不能假设旧客户端会丢弃未知 kind                           |
| 原文浏览器 session           | 扩展已有 local-browser Host/runtime，添加受限的文档查看 session 用途；session→profile/page 的权限归 Host/runtime                | Host 验证创建者与接收窗口，不能只信 renderer purpose；隔离 Cookie、普通历史、扩展及事件通道；枚举/自动化/下载/截图/录制等检查授权           |
| 历史 citation 关联           | 优先从所属消息的 asset/provenance 找到原快照；通用 citation 只保留可分享的来源引用                                              | 老引用仅有 URL/id 时提供显式账号选择或原文，不能伪造原快照/读取时间；新增字段按白名单投影                                                   |

新增源码只应承担无法放入现有 owner 的独立职责：例如 Dock 双视图内容体、跨入口打开协调器、受限浏览器 session 的授权验证。不能新增第二个 provider registry、凭据库、Blob 存储或通用浏览器实现。最终新增文件列表在 P0 后固定，并为受管源码补 co-located 测试。

不要把源码 Markdown artifact 伪装成远端原生文档，也不要只为 URL 新增 `ArtifactType`。本计划需要扩展的是 Dock 文档资源/描述与浏览器 session 的用途；如确实改变公开 plugin 类型，必须同时生成 contract/author types 并验证旧插件。

P3 的强制子任务及 owner 是：

1. Dock/浏览器 UI 负责人增加受限模式的历史策略：禁止普通 `recordBrowserVisit`、recent/history 与跨会话 URL 建议写入；仅保留本次页面内存导航栈。文档地址与登录跳转参数不能旁路进入普通历史表。
2. 桌面浏览器负责人在 `src-tauri/src/browser/local.rs` 的集成层与最低所属 crate/runtime 实现身份策略：受限 session 默认不加载普通扩展，普通扩展的安装、启停、更新、全局 reload 不得向其注入代码或重启其页面。
3. 桌面浏览器负责人把受限 session 的页面、dialog、credential、download 等事件改为 Host 侧授权的定向通道；普通 `app.emit` 不能载有这些私密 payload。事件订阅、请求/响应、截图流及 credential pendingId 使用都绑定创建窗口与会话，renderer 端过滤不能替代发送端授权。
4. 验证负责人完成跨窗口/跨连接订阅、普通 recent/history、扩展读文档和全局 reload 四条负测。普通浏览器原有历史/扩展/事件行为要有兼容回归。

“不新增 agent 权限”不等于撤销用户原先明确授予的全屏控制等独立能力；本功能不自动获得这些授权，也不能声称防住已经获得相应系统级权限的操作者。P0 必须区分普通 agent/browser tool、受限原文 session、用户明确授权的系统级操作，避免不可实现的绝对保证。

## 5. 入口、状态与恢复必须组成可走完的用户路径

| 入口                         | 动作与默认视图                                                                | 异常/恢复                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 聊天内已确认的文档 URL       | 普通点击打开实时原文；同一会话同一资源/身份复用 tab；保留修饰键外开语义       | 未知/仿冒域退回普通外链，不能显示可信提供商标识；没有账号时显式登录/选择                  |
| `@lark:` / `@gdoc:` 搜索结果 | 保留“附加到聊天”既有语义；增加可区分的“预览”动作，预览默认快照                | 预览不自动暂存附件；附加失败无 citation；不能因为增加预览而改变回车选择行为               |
| 暂存附件                     | 点击云文档附件在 Dock 打开原快照；可切实时原文；本地文件沿用既有行为          | 保留已处理/模型视图的区分，缺来源不猜测远端地址；移除附件后停止其悬挂读取                 |
| 已发送附件 / 引用 / Sources  | 按发送时 hash/revision 展示“当时的快照”；可打开实时原文或单独读取最新快照     | 原快照与最新快照分开，刷新不能改写既往发送内容或 citation                                 |
| 建文档工具结果               | 仅解析已完成成功结果中有 schema 的 provider/ref，提供打开动作；结果归其原会话 | 不扫描任意工具输出并自动执行 URL；运行中的重复 chunk 不反复打开；未知工具输出保留现有展示 |
| 恢复/重开 tab                | 恢复描述与所选视图；快照按 asset 查找；实时原文先复核可用环境和授权           | 不在恢复时自动启动多个登录窗口或恢复失效授权；显示“需要重新连接/选择账号”                 |

快照状态为 `idle → resolving → loading → ready/partial/empty/error`，刷新进入 `refreshing`，结束后更新“最新预览”而非原发送快照。关闭 tab、切换会话/工作区、销毁窗口取消当前调用；每个返回同时检查 requestId、目的地 generation、provider binding 与 active revision。失败保留旧内容时必须标“上次快照/刷新失败”。

实时原文状态为 `idle → preparing → needs-login → loading → ready/error/blocked`；不能把 frame `onLoad` 直接作为 native-ready。真实验收确认文档语义可见，运行时只对能可靠检测的 SDK/浏览器信号标 ready，其余保留诚实的连接/登录提示。Cookie/登录失效、引擎切换、Host 失联、页面重定向都需重新判断。

人工在原文中评论/编辑属于原平台交互；打开、刷新和恢复不自动执行编辑、评论、发布或共享。离开时不擅自关闭含未保存修改的原文页面；尊重 beforeunload/原生确认，并明确保存结果不确定。禁止自动重试不确定的写操作。

快照继续使用既有安全文本/Markdown 渲染规则，不执行文档脚本；不为补齐图片或附件保真度而自动下载任意正文 URL。需要加载外部媒体时遵循现有网络与权限策略，加载失败标为内容缺失。提供商登录所需的合法 OAuth/企业 SSO 跳转在 S1/S2 中建立受控来源清单；不能为“限制域名”直接拦掉必要登录，也不能放行任意未知重定向。

S1/S2 与最终 AC4/AC5 必须同时完成两个方向：第二客户端修改 → Dock 可见；有写权限的用户在 Dock 内提交评论与正文/单元格修改 → 第二客户端确认已保存。再用只读账号重复操作，由提供商拒绝且远端内容不变；只读 UI 不应发起写请求，但不能用“始终禁用编辑”让有写权限用例跳过。测试写入只发生在已指定的可丢弃样本，打开/刷新过程中不发起这些写入。

## 6. 身份隔离、来源校验与留存规则是实现前提

| 风险边界                  | 必须保持的规则                                                                                           | 反例验收                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| API 账号与原文登录账号    | 两种身份分别显示；原文登录未验证时不显示“与读取账号一致”；无可证明的映射时要求显式选择/确认              | A 账号快照与 B 原文同时存在时不可误标为同账号；切换/撤权后不能用旧数据冒充新读取                          |
| 跨 agent / 人工浏览器身份 | 原文登录 profile 与 agent default 隔离；Host/runtime session purpose、profile访问和 page操作均受权限控制 | agent 创建新页、传入 profileId、复用 sessionId、枚举/捕获页面都不能绕过                                   |
| URL 与网络                | 严格校验提供商 host、HTTPS、ID/path；保留可信 Wiki 来源；token/query/fragment 只按提供商允许清单处理     | 仿冒域、未知域、userinfo、脚本 scheme、敏感 query、恶意重定向不会得到 provider 凭据或可信标记             |
| 规范化与机密 URL          | API Bearer 不进入网页 URL；OAuth code/state 临时处理，不写 tab/history/log；允许的定位参数与鉴权参数分离 | 分享、重启、日志中无凭据参数；Google gid/tab/Wiki 必要定位不被静默丢失                                    |
| PII/模型输入              | 预览不调用模型；附加全文、选区、截图/OCR 时走既有显式发送/红线检查与 untrusted framing                   | 新旧入口产生同一安全判定；页面内容不能直接拼进 prompt 或向量化                                            |
| 分享/备份/导出            | 默认仅继承现有已附加资产规则；预览内存、原文 Cookie/profile 和本机绑定不进入 shared-session/备份/export  | 验证 `pickReferenceMetadata`、draft、SessionAsset 和 snapshot serializers，不能靠 TS 可选字段“自然不泄露” |
| 删除与断开                | 删除会话/资产释放内存、对象 URL 和对应关联；断开 provider 停止新读并使在途结果失效                       | 不能晚返回复活 tombstone；provider OAuth 断开不冒充已注销独立浏览器 Cookie，提供独立退出/清理入口         |
| 权限与组件密钥            | 沿用最小只读 API 授权；不因原文预览自动请求写权限；SDK若需要签名，密钥留在可信 owner                     | 静态 out、JS bundle、日志和浏览器地址中无 app secret；无未经批准的新服务依赖                              |

用户主动保存/发送的历史快照不随远端撤权被伪装为远端当前可读；它仍遵循本地资产访问、保留和删除规则。预览临时读取则在授权失效时清除，防止旧身份内容留在新身份页面。

## 7. 平台与旧版本行为必须明确，不能靠 iframe 兜底冒充支持

| 环境                           | 快照                                                              | 实时原文                                           | 首期验收口径                                                                   |
| ------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| macOS Tauri                    | 当前 provider 读取 + 既有资产查看                                 | S1/S2/S3 证明的受限浏览器/组件路线                 | 双视图均需真实验收；任一缺失不能声明首期完成                                   |
| Windows/Linux Tauri            | 合同相同，原生依赖按平台核验                                      | WebView/Chromium/登录差异分别测试                  | 没有实机结果就不进入该版本的完整支持矩阵；Q2 决定是否为本次发布阻断项          |
| 独立 Web                       | 可显示已授权已有快照；不新增本地 provider 读取                    | 仅声明已验证的 embed/显式远程浏览器能力            | 明示不可用原因；iframe 显示登录/被拦截不算成功                                 |
| Capacitor / paired Web         | 现有快照按现有共享/资产授权；没有文档 reader relay 时不宣称可刷新 | 使用现有允许后端时单列验证；不自动把私有文档送远端 | 手机需有真实 UI 降级验收；完整双视图若纳入 Q2 则先补 relay 与权限合同          |
| headless                       | 不挂载 UI，保留现有可用 reader 限制说明                           | 无 UI 预览，不能因此放宽 host 权限                 | 不新增“隐式远端文档读取”工具                                                   |
| 旧 Host / 旧 renderer / 旧插件 | 缺字段沿旧附件路径；未知来源版本拒绝自动绑定                      | 缺受限 session capability 明确提示升级             | 不降回 agent default profile；旧 tab 数据逐项读取，不让一条新 tab 毁掉其它记录 |

Dock 持久化变化必须有 `migrate/merge/validate` 和旧版读取测试。当前 `cognia-dock-tabs-v1` 的 version 为 2，旧 `parseDockTabKey` 会把未知前缀当 artifact；不能假设旧构建能安全理解新 document kind。**不迁移或复制整个 Dock store 到新 namespace**：普通 pages、order、open、activePageTabId 继续由旧 key/slice 唯一拥有，新版仅写入旧版可理解的安全投影；文档专用 descriptor、文档间次序与相对普通 tab 的位置提示放在同一 owner 的新版本化扩展 slice。扩展 slice 不保存普通页面状态，不构成第二份 Dock source of truth。

合并时先读取最新普通 slice，再验证文档 descriptor 的 session/asset/hash，用位置提示插入有效文档；位置提示引用的普通 tab 已关闭则追加，不复活该页。文档 active 指针只进扩展 slice，不能串到普通 `activePageTabId` 或其它旧版 workbench 持久状态。普通持久化写入始终滤除文档 key、受限 page URL/session 及引用。降级时文档 tab 不显示，普通状态仍持续更新；再升级要读取降级期间新增/删除的普通 tab，随后重新验证文档身份。必测“新版关闭普通 A → 降级后 A 不重现”“旧版新增 B → 再升级保留 B”“未知文档版本不影响普通 Dock”。

未附加的临时文档不能靠保存原始 URL 来“可恢复”：默认重启后不恢复该临时 tab，重新从来源打开。已附加/发送文档可用所属 session 的 assetId 与安全元数据恢复；若用户将来选择记住原文地址，需单独的明确设置与脱敏存储契约。受限文档描述不投影成普通 page URL。现有 snapshot/backup registry 一并检查新 namespace，默认排除临时/本机身份数据。

可选 provenance 字段优先附着既有资产记录，不先假设需要 Dexie 新版本；如果 S4 发现需要索引或存储布局改变，再按 `dexie-migration` 抢占最新可用版本并跑数据治理检查。

## 8. 工作包按依赖推进，但首期必须一起过门槛

| 工作包             | 交付与现有修改位置                                                                                                              | 依赖                   | 唯一负责角色     | 验证 / 回退                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| P0：约束与路线     | S1—S4、固定资源/平台矩阵、身份隔离合同；ADR-0134/0214 兼容性结论                                                                | 指定测试环境/文档      | 云文档集成负责人 | 输出成功/失败步骤及源版本；不满足双视图则停在计划/实验，不冒充交付                          |
| P1：来源与资产     | `lib/docs-providers/types.ts`、staging/intake/draft、SessionAsset、citation readers/serializers；补来源与既有资产关联           | P0/S4                  | 附件数据负责人   | 暂存/发送/恢复/删除红→绿；旧数据与 share/export 白名单；关闭开关走旧附件路径                |
| P2：Dock 双视图    | tabs store、Dock host/panels、附件预览渲染体；统一文档 tab、切换、焦点和错误状态                                                | P1；原生接口可并行联调 | Dock 前端负责人  | 实际入口 RTL/Playwright、键盘/缩窄窗口；禁用新 tab 类型后旧 Dock 仍可用                     |
| P3：受限原文浏览器 | `lib/browser/local-client.ts`、browser Host/runtime、已有 native command/capability owner；隔离 profile/session、清理与版本协商 | P0/S3                  | 桌面浏览器负责人 | 越权与双账号故障注入、进程关闭/重新打开；关原文开关即拒绝新 session，保留用户未保存状态处理 |
| P4：两家原文集成   | Docs/Sheets、docx/Wiki/Sheets/Bitable 真实打开、登录、权限、导航、评论/协作；SDK路线只在已验证后选用                            | P3；P2 联调            | 云文档集成负责人 | AC4/5 实际账号与第二客户端；单 provider 开关关闭只作故障处置，不算双 provider 完成          |
| P5：贯通所有入口   | ChatLink、Sources、云文档附件、历史 citation、确有结构结果的 Lark 工具；去重与后台会话行为                                      | P1/P2/P4               | 会话集成负责人   | 一个入口一个端到端用例；重复 chunk/跨会话不抢焦点；普通外链保持原行为                       |
| P6：发布验收       | i18n/accessibility、静态导出、Tauri、平台降级、安全审核、文档与回退演练                                                         | P1—P5                  | 验证负责人       | AC1—AC12、证据账本与残余项；存在关键未验收项不得开全量                                      |

P1 与 P3 可在 P0 合同固定后由不同负责人并行实现；P2/P4 共享接口提前固定，P5 最终联调；P6 的测试样本、拒绝路径与断言应在 P1 开始前冻结。每个包包含自己的 co-located 测试，不能把所有测试推到 P6。

P0/S3 必须对第 4 节四项子任务给出合成数据/最小原型证据、现状失败点、权限合同、生产 owner 和负测规格；**P3** 才负责生产实现及完整通过这些负测：禁普通历史、禁全局扩展继承/热重载影响、Host 定向事件和旁路访问检查。P3 进入条件是 P0 的路线与合同评审通过，P3 退出条件是生产隔离测试通过，两者不互相等待。P4 的完成定义包含上述人工编辑/评论双向保存闭环。它们都是首期内容，不能推到上线后。

实际实现前采用最新明确基线的隔离 worktree，核对当前并行工作；不搬走、stash 或提交其它会话的修改。先复现/写失败行为检查，再补生产实现；提交前核对 GitHub 登录与仓库 author/committer，按显式路径分阶段提交。此计划本身不创建分支、提交或 PR。

## 9. 验收从用户结果反推，固定门槛不能因失败而放宽

| ID   | Given / When / Then 的核心断言                                                                                                                              | 证据层级                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| AC1  | 从五类入口点击文档，所属会话 Dock 展开正确 tab；后台工具结果不抢前台，重复打开不堆重复 tab                                                                  | integration + Chromium E2E + Tauri                         |
| AC2  | 在同一文档 tab 切快照/实时原文，关闭重开和切会话后内容/焦点正确；不多一条竞争 tab 栏                                                                        | RTL + 实际界面截图/键盘操作                                |
| AC3  | Feishu 与 Google 的首期资源分别读取正文/表格，标来源、读取时间、限制；空/错/partial 不是完整成功                                                            | provider fixture + 固定真实文档核对                        |
| AC4  | Feishu Dock 内原生排版/评论，第二客户端修改可见；Dock 内有权限用户提交评论和正文/表格修改，第二客户端确认已保存；只读账号拒绝且远端不变                     | real-env，指定可丢弃样本、双向操作与前后截图               |
| AC5  | Google Docs/Sheets 同 AC4 的双向协作/保存与只读拒绝；完成实际登录/重新打开；私有文档不需 Publish to web                                                     | real-env，Google 实际账号、可丢弃样本与第二客户端          |
| AC6  | 已发送快照显示发送时版本；远端更新后刷新仅生成最新预览，不改旧消息；不可访问 block/行列上限可见                                                             | integration + 对照文档                                     |
| AC7  | 双账号/双租户、重授权、失效、切引擎、跨窗口、旧请求晚返回，均无身份冒充或串会话                                                                             | fault injection + 真双账号；包含 Google `default` ID 重用  |
| AC8  | 未获授权的 agent 不能通过新页/复用 profile/session/截图/recording 访问原文；跨窗口/连接收不到受限事件；普通扩展不加载，reload 不干扰                        | Host/runtime 负测 + 扩展/事件样本 + 独立安全评审           |
| AC9  | 预览不自动附加/发模型/发表评论/编辑/分享；显式发送仍走原附件保护；拒绝时无多余 citation                                                                     | network/tool spies + PII gate 审计 + 真实操作观察          |
| AC10 | 关闭/删除/退出/重启/断连/share/export/backup 后无额外正文/登录态/绑定泄露；URL/登录参数不进入 browserHistory/recent；仿冒域不获信任；旧版回退不重开受限页面 | serializer/storage/history/native 负测 + 旧版/删除恢复测试 |
| AC11 | `out/` 生产静态构建可运行；macOS Tauri 实际窗口双视图通过；其它承诺平台分别有证据                                                                           | production build + real shell/device                       |
| AC12 | en/zh-CN、aria、键盘切换/关闭、焦点返回、窄屏/缩放/原文浮层正确；不支持平台有可操作解释                                                                     | i18n gates + browser/native visual check                   |

提供商样本至少包括：Feishu docx/Wiki/Sheets/Bitable 与 Google Docs/Sheets；有权限与拒绝访问；图片/表格/评论；复杂或超限内容。legacy doc 若找不到当前仍可访问样本，必须作为该类型发布支持的未验收项，不从 docx 推断。只有原平台支持的语义才逐项验收，Sheets/Base 的协作不能机械套用 Docs 评论 UI。

拟使用的现有验证入口如下；标注为未来执行，不能把列出的命令视为已通过：

```sh
# focused baseline; implementation must add the changed owners' co-located suites
rtk proxy pnpm --config.verify-deps-before-run=false test --runInBand --runTestsByPath lib/docs-providers/providers/lark/index.test.ts lib/docs-providers/providers/google/index.test.ts lib/docs-providers/reach.test.ts hooks/chat/use-remote-doc-staging.test.tsx components/chat/composer/attachment-preview-dialog.test.tsx components/shared/external-link.test.tsx lib/browser/open-url-request.test.ts lib/browser/backend-availability.test.ts lib/artifacts/dock-pages.test.ts
rtk proxy pnpm lint
rtk proxy pnpm typecheck
rtk proxy pnpm i18n:build
rtk proxy pnpm i18n:build:check
rtk proxy pnpm lint:i18n
rtk proxy pnpm lint:static-export
rtk proxy pnpm audit:colocated-tests
rtk proxy pnpm audit:data-governance
rtk proxy pnpm audit:network-egress
rtk proxy pnpm build
```

改公开契约时增加现有 `plugin:contract:check`、`author-types:check`、`plugin:author-imports`；改 Companion/Host 合同时增加 `companion-api:check` 和旧 Host 真机负测；改 Rust 时增加所属 crate 的 fmt/Clippy/单测与 `audit:rust-architecture`。P3 预计涉及 native/Host，不能只跑前端测试。

P3 至少将现有 `crates/cognia-local-browser/` 与 `services/workspace-runtime/src/browser-service-local.test.mjs` 纳入变更影响和测试清单；Tauri 的 `AppHandle` 集成仍留在 `src-tauri/src/browser/local.rs`，可独立的权限/事件转换逻辑放最低所属 crate。不能为绕过当前全局广播/扩展策略另起一个浏览器服务。

新增 E2E 使用根 `pnpm test:e2e` 与当前存在的 `chromium` / mobile project，路径待实现创建后固定。现有 `test:e2e:tauri` 为 Windows WebView2 路线，不作为 macOS WKWebView 的证据；macOS 按 `tauri-agent-debug` / `tauri-smoke` 的实际能力执行。覆盖率按仓库 local opt-in，不默认运行；已有 CI 阈值保持。

进入发布前做独立 wiring、i18n、static-export、PII、test-gap 审核；涉及 Rust 时加入 Tauri/Rust reviewer。关键身份/隔离结论要由未参与实现的 reviewer 复核，最终仍以真实双视图结果为准。

## 10. 性能预算、观测与回退都有明确边界

以下是待测的设计预算，不是已有性能事实：已有快照切换目标 p95 ≤ 300 ms；重复打开不重复 fetch；原文只在用户选择/恢复确认后启动，闲置不额外占一个 active stream。远端加载耗时单独记录，10 秒进入“仍在加载/检查登录”提示；超时不自动换账号/引擎或重试写操作。快照读取和原文连接每个文档各至多一个活动请求；旧请求取消，结果按 generation 丢弃。

快照内存继续受现有字符/字节/行列预算约束；受限原文最多 2 个同时运行的登录 profile、每个 profile 最多 4 个文档页为初始可调预算，须测 profile 内存与现有 runtime session cap 后固定。达到上限提供关闭旧页/显式切换，不静默挤掉有未保存内容的原文。关闭隐蔽页面的 stream，保留页面/登录环境与否遵循 owner 生命周期；窗口销毁确保所有测试任务退出。

沿现有诊断体系新增低基数字段：`docs_preview_open/settle/refresh/native_connect`；维度只含 provider、resource kind、view、backend、result/error class、duration bucket。不得记录 URL、标题、doc ID、账号、token、Cookie 或原文截图。记录 gate拒绝/超时用于本地排障，不默认上报新云端。

出现一次错误身份显示、越权 agent/profile 访问、凭据外泄、自动发布/编辑，立即停止扩大范围并关闭相应 provider/原文入口，保留脱敏 evidence；两种视图未恢复前不能宣称功能完整。普通加载失败可保留快照，但显式标记原文未连通。

发布采用同一个功能开关下的双视图候选：内部实验 → 指定账号/文档验收 → 双 provider canary → 承诺平台放量。阶段是工程依赖顺序，不是把实时原文推到下个版本。任一核心 provider 的 AC4/AC5/AC7/AC8 未通过，禁止宣称首期双视图完成。

回退关闭新入口与新文档 tab 恢复，保留旧附件、普通浏览器页签和已发送资产；关闭原生新 session，不擅自抹掉用户登录 profile 或未保存工作。可选来源元数据保留，旧版忽略未知字段；文档 tab descriptor 逐项丢弃/降回可识别的安全描述，不能把受限原文改成普通 agent 浏览器页。新增临时 body/object URL 必须释放。共享协议/存储有变更时按 P0 的兼容窗口验证后再发。

## 11. 复杂度、评审决策和启动条件

本轮按 `evidence-driven-dev` 的 Deep discovery 处理，原因是双实时登录、原生浏览器、共享身份与多 shell 验证；本次仅交付计划，未进入产品实现。

| 维度         | 评级    | 原因 / 消除不确定性的动作                                                                         |
| ------------ | ------- | ------------------------------------------------------------------------------------------------- |
| scale        | high    | Dock、附件来源/恢复、共享类型、native session/权限、真实 provider 至少五个集成面；P0 固定变更清单 |
| technical    | unknown | 当前资料不证明私有 Google/Feishu 在所选隔离登录环境中完成协作；S1/S2/S3 决定路线                  |
| coupling     | high    | ADR-0134/0214、asset/draft、公开类型与 Host/runtime；不能只修 UI                                  |
| requirement  | medium  | 双视图首期已确认；平台边界、SDK部署和外部验证环境仍需评审                                         |
| verification | high    | 真实账号、第二客户端、native UI、跨账号负测，Jest 无法替代                                        |
| risk         | high    | Cookie/原文身份与 agent、敏感来源传播、外部人工编辑及恢复语义                                     |

| 决策                 | 选项与建议                                                                                                                 | 状态                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Q1：首期体验         | 快照与实时原文都交付，缺任何一种都不算首期完成                                                                             | **用户已确认，2026-10-29**                    |
| Q2：首期完整支持平台 | 建议 macOS Tauri 完整支持，其它平台逐项取证；也可将 Windows/Linux/Web/手机全列为首发阻断项，需扩大 P0 与 reader relay 范围 | 提案待确认，不能由 agent 默认认定用户接受降级 |
| Q3：原生实现路线     | 优先隔离浏览器中的原平台页面；飞书组件为满足相同结果的备选；若需签名服务需单独批准部署                                     | 待 S1—S3 证据后决定；不在未知前锁定 SDK       |
| Q4：浏览器身份与账号 | 推荐独立文档登录环境；不复制系统 Cookie、不自动连接 user-chrome、不推断 API 身份等于网页登录身份                           | 技术/安全评审阻断项                           |
| Q5：留存与恢复       | 只预览默认内存；主动附加沿原资产规则；恢复只保留安全描述，重新选择身份                                                     | 推荐方案，P1 前确认 serializer 与用户文案     |
| Q6：环境与排期       | 指定可丢弃 Feishu/Google 文档、两侧协作账号、目标 OS；P0 通过再给日历交付承诺                                              | 启动 P0 前解决，当前不访问任何实际账户        |

评审记录与后续动作：

| 评审                        | 日期       | 结论 / 限制                                                                                                                                                               |
| --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前源与既有审计核对        | 2026-10-29 | 已列出现有 owner 与缺口；没有把旧测试当作新功能证据                                                                                                                       |
| 独立 fresh-context 风险发现 | 2026-10-29 | 8 类失败场景已纳入 AC；特别增加未知 host、共享 profile、历史数据留存与原文协作证据                                                                                        |
| 方案一致性复核，第 1 轮     | 2026-10-29 | 3 个 P1 与 1 个 P2 均确认成立：普通历史、全局事件、全局扩展，以及 Dock 发起的协作保存闭环。已逐项补入 P0/P3/P4、AC4/5/8/10；另修正旧客户端 namespace 与临时 tab 恢复假设  |
| 方案一致性复核，第 2 轮     | 2026-10-29 | 两个 P2 确认成立：P0/P3 完成条件循环、整个 Dock namespace 分叉。已明确原型/合同评审与生产退出条件，改为普通状态单一持久 slice + 文档专用扩展，并加入普通页降级/再升级断言 |
| 方案一致性复核，第 3 轮     | 2026-10-29 | 未发现新的实质性计划缺陷。只审查计划及本轮修订；真实登录/SSO、Host隔离、双向协作仍是 P0/P3/P4 未验证门槛                                                                  |
| 真实 provider / 产品验收    | 未执行     | S1—S4 与 AC1—AC12 都是未来工作，不标为已通过                                                                                                                              |

| 动作                                        | 唯一 owner       | DDL                                                     |
| ------------------------------------------- | ---------------- | ------------------------------------------------------- |
| 确认 Q2/Q5/Q6 的评审输入与 P0 执行安排      | 云文档集成负责人 | 2026-10-30，建议评审检查点，非已承诺开发日期            |
| S1/S2 输出可复现 provider 路线结论          | 云文档集成负责人 | 2026-10-30，需账号/文档先就绪；否则当天记录阻塞与新日期 |
| S3 输出 Host/runtime 隔离合同和回退方案     | 桌面浏览器负责人 | 2026-10-30，建议检查点；失败即保持首期阻塞              |
| S4 输出来源/恢复/序列化变更表与旧版测试清单 | 附件数据负责人   | 2026-10-30，建议检查点；需要 schema 变更则重评          |

## Sources

- 本地 owning source、两份当前研究报告、[ADR-0134](../content/docs/en/adr/0134-remote-document-providers.md)、[ADR-0214](../content/docs/en/adr/0214-the-chat-dock-is-a-tabbed-browser-that-remembers-each-task.md) 已在相关判断旁链接。
- [Google Publish/Embed](https://support.google.com/docs/answer/183965?hl=en)、[Chrome embedded-content cookies](https://support.google.com/chrome/answer/95647?hl=en)、[Drive export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats) 证明已发布嵌入/快照导出的条件，不证明 Cognia 私有文档原生协作已可用。
- [Feishu Cloud Docs integration](https://open.feishu.cn/solutions/detail/docs?lang=zh-CN) 证明官方组件路线存在；SDK 版本、签名/密钥 owner、允许域名和各资源兼容性仍需 S2 核验。
- 外部资料核查于 2026-10-29；当前计划没有新增外部调用、凭据、部署或文档修改。
