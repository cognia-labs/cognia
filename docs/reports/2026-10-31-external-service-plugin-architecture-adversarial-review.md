# 外部服务插件化架构对抗性审查

日期：2026-10-31。范围：当前工作树中的源码与本轮提出的跨厂商插件化方向。工作树含并行修改，本报告不是某个独立提交的审查结论。

结论：跨厂商拆分方向成立，但目前还不能承诺“接入一个基础插件，所有业务插件就能安全复用，并可独立迁移和升级”。现有 SDK 暴露了认证与 Integration 的部分能力，却没有形成完整的权限、生命周期、数据迁移和业务领域契约。继续批量搬迁会把已有缺口复制到更多插件。

本报告独立于飞书日历的功能验证记录：前者审查平台边界，后者记录某个插件实现的局部验证。已有局部测试通过不能反证本报告中的跨插件和异常生命周期问题。

## 审查对象与证据标准

审查的方案是：Host 保留通用运行时、凭证代理、权限、审批、审计与调度；飞书、Google 等基础插件提供各自认证、账户和协议适配；日历、文档、云盘、任务、IM 等业务插件依赖基础插件；UI、Agent 和 Workflow 通过公共接口使用这些能力；现有内置能力逐步迁移到同一套 SDK。

待证伪的主张是：“现有公共接口足以支撑上述目标，主要工作只是拆包和补适配器。”必须满足的契约是：复用已有行为、不扩大授权、不让停用后的代码继续使用旧凭证、不损坏既有数据和引用，并维持浏览器、Tauri、Capacitor、headless 的明确支持边界。

方法：三个独立上下文的只读审查，分别检查认证、公共领域契约、生命周期与迁移；主会话核对源码调用链并执行两个合成复现。按用户选择，本轮不追加跨模型或外部 CLI 审查。

证据标签：

- **已复现**：调用实际实现，用合成输入观察到了问题；没有使用真实凭证，没有请求外网。
- **源码确认**：入口、处理和效果的调用链成立；没有执行真实供应商操作或破坏性升级实验。
- **设计缺项**：目标尚未给出必要契约，不等同于已经发生线上故障。

P1 表示在依赖该边界开放或迁移能力之前应解决；P2 表示需要在方案或对应迁移批次中补齐。

## 完整问题台账

以下将审查中的复合发现拆为 **36 项独立问题**，便于逐项实施和验收；其中 **2 项已有合成复现**。这是对本次审查结果的整理，不是对后续代码变更的重新验收，也没有将设计缺项计作已发生的安全事故。

所有问题均为本次审查尚未验证关闭。证据中的“源码”表示源码确认，“设计”表示必须明确或补齐的契约；“源码＋设计”表示已有实现限制，仍需确定目标方案。追溯列对应下文 F01—F11 或“方案必须补齐的契约”。

### A. 认证、凭证与出站授权

| 编号  | 优先级 / 证据 | 问题与影响                                                                                        | 修复要求与最低验收                                                                          | 追溯 |
| ----- | ------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---- |
| ES-01 | P1 / 已复现   | 全局认证事件包含 token，且不检查消费者权限；无权限插件可收到其他 provider 的 session。            | 事件只含授权范围内的元数据；无权限、跨 provider 和撤权后的订阅均拿不到 token。              | F01  |
| ES-02 | P1 / 源码     | 认证 API 依赖 manifest 权限，外层仍是 shadow enforcement；旧 context 可能继续行使已撤销权限。     | 检查当前 grant/revision；先取得 context、再撤权、再调用及接收在途结果，均验证失效规则。     | F02  |
| ES-03 | P1 / 源码     | 账户 patch 只有类型限制，运行时可改认证绑定和 approvedOrigins；普通管理能力可能扩大凭证投递范围。 | 运行时字段白名单；伪造 patch 不能改变凭证所属账户、session 或允许来源。                     | F03  |
| ES-04 | P1 / 已复现   | PKCE 默认使用全局 fetch；认证能力可绕开统一网络权限、PII、审计与取消控制。                        | 强制 Host 治理的传输和端点注册；不给网络权限时，默认认证流程不能另开出站通道。              | F04  |
| ES-05 | P1 / 源码     | PII gate 仅凭字段名豁免数据；插件可把用户文本放进 credential 字段。                               | 豁免只对应 Host 解析的凭证引用；把邮箱等文本放入 access_token/header/query 时仍受策略约束。 | F04  |
| ES-06 | P1 / 源码     | 原始认证写请求的审批只覆盖 GitHub；其他 Integration 可绕开 action/job 审批直接写入。              | UI、Agent、Workflow 和插件直调共用写入授权；未经批准的日历 DELETE 等原始请求被阻止。        | F05  |

### B. 账户、授权与基础认证插件

| 编号  | 优先级 / 证据   | 问题与影响                                                                                                 | 修复要求与最低验收                                                                                                   | 追溯   |
| ----- | --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ |
| ES-07 | P1 / 源码＋设计 | session 的身份维度不足，按 scopes 超集选首个 session；同厂商多账户、tenant、client、用途可能无法明确选择。 | 定义稳定 connection 身份和显式选择；同厂商双账户、不同 client/用途不会串用。                                         | 契约 1 |
| ES-08 | P1 / 设计       | 远端 OAuth grant、Host connection 和业务消费者 grant 尚未明确分层；共享登录可能扩大业务授权。              | 每个消费者按操作、资源、scopes 和 revision 授权；新增供应商 scopes 不自动扩大旧消费者权限。                          | 契约 1 |
| ES-09 | P1 / 源码＋设计 | provider 所有权依赖当前 registry 和裸字符串；真正基础插件缺席时，同名实现可先占位。                        | 连接绑定预期包、发布者和接口版本；基础插件停用、卸载、重装期间，替代插件不能接管旧连接。                             | 契约 3 |
| ES-10 | P1 / 设计       | refresh、轮换和 logout 缺少统一跨实例协调契约；插件内 Map 不能保证跨窗口或旧新实现一致。                   | Host 按 token lineage 协调刷新、CAS 和撤销；并发刷新只提交有效轮换结果，logout 不被迟到刷新复活。                    | 契约 2 |
| ES-11 | P1 / 设计       | OAuth callback 的一次性消费、issuer/client/state 绑定、取消和迟到回调规则需统一。                          | 重放、错 client/issuer、取消后回调均不能建立连接；confidential-client secret 只由受信环境处理。                      | 契约 2 |
| ES-12 | P2 / 设计       | “基础认证插件”的协议范围未列明，容易把公共模型固化为单一 OAuth 流程。                                      | 对 OAuth PKCE/device/受信交换、API key/PAT、service-account/JWT 等候选方式列出按需支持矩阵与扩展方式；明确不支持项。 | 契约 8 |

### C. 执行、依赖与运行时生命周期

| 编号  | 优先级 / 证据   | 问题与影响                                                                           | 修复要求与最低验收                                                                              | 追溯        |
| ----- | --------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------- |
| ES-13 | P1 / 源码       | job 从 queued 到 running 不是原子领取；并发批准或 drain 可执行同一写任务。           | 持久化 claim、owner、generation 和 lease；两个执行者只能有一个取得任务。                        | F06         |
| ES-14 | P1 / 源码       | 取消、停用或升级未统一约束已捕获 handler、网络请求及晚到提交；取消可被成功结果覆盖。 | 贯通取消与 generation 检查；旧操作不能再发请求或覆盖终态，已发出的远端写入进入可核对状态。      | F06         |
| ES-15 | P1 / 设计       | 基础插件升级与 required consumers 的停用、排空、兼容性和恢复顺序未形成完整契约。     | 保留依赖删除保护；版本冲突不激活，升级按依赖顺序排空，并按原启用意图恢复消费者。                | 契约 3      |
| ES-16 | P1 / 设计       | 已有 owner gating，但崩溃和 owner 接管时，刷新、同步和写任务的独占责任仍需验收。     | 故障注入验证 lease 接管和旧 owner 失效；不并发刷新、不重复同步提交、不盲目重放写操作。          | 契约 7、F06 |
| ES-17 | P1 / 源码＋设计 | 前端插件可在 Host realm 执行；SDK 包装并不构成针对恶意插件的隔离边界。               | 明确信任模型；若支持不受信插件，验证其不能直达 Host globals、网络和密钥；否则公开受信代码边界。 | 契约 4      |

### D. Schema、迁移、回滚与数据保留

| 编号  | 优先级 / 证据 | 问题与影响                                                                     | 修复要求与最低验收                                                                             | 追溯   |
| ----- | ------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------ |
| ES-18 | P1 / 源码     | migration runner 存在，但未找到实际激活/更新调用；仅检查声明不能保证回填执行。 | 从真实 manager 升级入口运行迁移；旧数据库的回填恰好一次，失败不会激活半迁移版本。              | F07    |
| ES-19 | P1 / 源码     | 相同表名集合可提前返回；索引或 schema 变化不能靠表存在性判断完成。             | 比较 schema/version 并执行正确迁移；同表名新增索引、修改索引和数据回填均由旧库升级测试验证。   | F07    |
| ES-20 | P1 / 源码     | 迁移完成标记和回滚备份存于会清理的审计表；90 天后可能丢失迁移状态。            | 独立持久化 migration ledger；清理旧审计后不重跑已完成迁移，也不意外失去承诺保留的回滚信息。    | F07    |
| ES-21 | P1 / 源码     | 回滚直接覆盖账户、订阅和 Workflow 快照；可能抹掉迁移后的用户编辑。             | 按记录/字段 revision 检测冲突；迁移后编辑再回滚，编辑得到保留或明确报告冲突。                  | F07    |
| ES-22 | P2 / 源码     | 默认“保留数据卸载”的文案，与无条件清理外部账户、关联状态和 secrets 不一致。    | 明确停用、保留卸载、本地清除、断连、远端撤销的效果；重装可恢复的数据及需重连项与 UI 承诺一致。 | F11    |
| ES-23 | P2 / 设计     | 断连、远端删除或访问权撤销后，本地索引、RAG、附件和历史快照的处理未统一。      | 定义在线权限与用户保存副本的独立保留规则；验证派生索引失效、在途读取停止和保留副本可追溯。     | 契约 5 |

### E. 公共领域扩展与统一账户 UI

| 编号  | 优先级 / 证据 | 问题与影响                                                                                 | 修复要求与最低验收                                                                              | 追溯 |
| ----- | ------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---- |
| ES-24 | P2 / 源码     | DocsProvider 有内部 registry，但缺少对应公共插件贡献入口，设置卡片仍固定厂商。             | 第三方插件不导入私有 @/ 模块即可注册、配置账户、搜索和读取，卸载时可完整解除贡献。              | F08  |
| ES-25 | P2 / 源码     | 文档 URL、provenance 和 Dock 校验有厂商闭集；新 provider 可能读到内容却不能引用或重开。    | 统一 namespaced 资源引用，贯通搜索、来源、附件、snapshot/live preview 和历史重开。              | F08  |
| ES-26 | P2 / 源码     | DocsProvider registry 缺少变更通知，hook 可持有旧 provider；停用或替换后旧读取未明确失效。 | 注册有 disposer/revision/通知；替换或停用后，旧函数与在途读取失效，已保存快照仍按保留规则可用。 | F08  |
| ES-27 | P2 / 源码     | Issue Sync 虽有 provider 注册，但持久化资源 union 和配置 UI 固定，扩展无法贯穿项目绑定。   | 公共贡献资源 schema、配置和映射；旧任务/多维表格的 externalRef、watermark、状态映射迁移后有效。 | F09  |
| ES-28 | P2 / 源码     | 备份 API 仅能触发创建/恢复，目的地注册和 fanout 仍固定厂商。                               | 公开 destination readiness、账户、上传、取消与结果契约；Host 继续负责加密、打包、调度和历史。   | F09  |
| ES-29 | P2 / 源码     | 服务视图 key 不包含 connection 实例；同服务多个账户可能被折叠或覆盖。                      | 分离服务定义与连接实例；两个账户同时可见且选择稳定，UI/Agent/Workflow 使用同一连接引用。        | F10  |
| ES-30 | P2 / 源码     | 统一管理入口偏向 MCP，普通 Integration 的登录、补权限、重认证和错误恢复表达不完整。        | 公开通用 setup/recovery contribution；普通 Integration 可从未连接走到可用，也可恢复过期授权。   | F10  |

### F. 同步、协议覆盖与插件化交付

| 编号  | 优先级 / 证据   | 问题与影响                                                                                | 修复要求与最低验收                                                                                                                   | 追溯         |
| ----- | --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| ES-31 | P1 / 设计       | 增量同步缺少跨插件共用的提交、重试和失效语义；通用调度不等于正确同步。                    | 定义分页提交点、cursor 失效、全量重建、tombstone、去重、限流、webhook 验签/续租及 poll 去重；失败不前移游标。                        | 契约 5       |
| ES-32 | P2 / 设计       | 缺少旧能力到新插件的逐项对照；通用 action 可能丢失日历、文档、表格、任务等领域语义。      | 列出旧入口、公共接口、新插件、数据迁移和行为证据；明确未支持项，不能用工具存在代替行为验收。                                         | 契约 6       |
| ES-33 | P2 / 设计       | browser/Tauri/Capacitor/headless 的认证、密钥、网络、调度和回调支持未统一声明。           | 按运行时实测并提供机器可读能力与恢复原因；静态导出不依赖运行时 Next.js 服务或前端保管服务端 secret。                                 | 契约 2、7    |
| ES-34 | P2 / 设计       | 工作树可运行不证明独立发布可用；内置目录、安装包、依赖解析和升级路径需同时验证。          | 内置与独立 ZIP 分别安装运行；验证依赖缺失/版本冲突、升级回滚和实际用户路径。                                                         | 契约 7       |
| ES-35 | P2 / 源码＋设计 | Host 中仍有飞书 OAuth 端点特例及多处厂商闭集；继续抽取可能变成“插件外壳＋Host 厂商分支”。 | Host 保留通用机制和受限校验，厂商协议以插件贡献表达；加入新供应商不再修改 Host 的厂商条件分支。                                      | F04、F08—F10 |
| ES-36 | P1 / 设计       | “库插件供业务插件依赖”的服务消费契约尚未明确；仅有包依赖不能定义权限、实例和失效行为。    | 复用现有依赖能力，明确 runtime service export/consume、接口版本、连接作用域、权限传播和失效；两个业务插件安全复用一个基础 provider。 | 契约 1—3、8  |

### 处理依赖与关闭标准

先确定 ES-07—ES-12、ES-17、ES-36 的账户/授权/信任与服务契约，再实施 ES-01—ES-06 的认证出站边界；执行和迁移问题 ES-13—ES-23 可以按独立模块推进；领域贡献 ES-24—ES-30 在上述稳定引用和生命周期之上接入；最后以 ES-31—ES-35 的跨厂商真实路径验证整体结果。

每项关闭都要包含对应实现、行为反例或集成检查、实际结果和必要的兼容性说明。设计项先形成明确契约，再按承诺范围验证；不能仅凭补了类型、写了 helper、单个插件测试通过或新增 TODO 关闭。

## F01 · P1 · 认证事件向无认证权限的订阅者暴露完整 session

**已复现；有效且可行动。** `ctx.auth.onDidChangeSessions` 直接订阅全局 registry，没有 `auth:consume` 检查，也没有按 provider 或消费者授权过滤。事件包含完整 `AuthSession`，其中有 `accessToken`。因此，即使调用方没有认证消费权限，也能从另一插件创建 session 时收到 token。

源码：[auth-api.ts:63](/Users/bytedance/Project/cognia-next/lib/plugin/api/auth-api.ts:63)、[AuthSession 与事件结构](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/lib/plugin/auth/auth-provider-registry.ts:25)、[创建 session 后广播](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/lib/plugin/auth/auth-provider-registry.ts:220)。

合成复现：[auth-event-repro.ts](/Users/bytedance/Project/cognia-next/.cache/external-service-adversarial/auth-event-repro.ts)，实际输出：

```json
{ "observedTokenWithoutPermission": true, "externalRequests": 0, "realCredentialsUsed": false }
```

验收：事件只包含必要元数据，并按消费者、provider 和有效授权过滤；撤销授权后旧订阅不能继续收到信息。普通业务消费者优先得到不透明 session/connection 引用，由 Host 注入凭证。

## F02 · P1 · 撤销权限后，旧认证 API 仍可能继续使用 manifest 权限

**源码确认；有效且可行动。** 创建认证 API 时的权限回调检查 manifest 声明。外层 governed context 虽然存在，但认证点位当前为 `shadow` enforcement；拒绝不会阻止真正调用。这不能支撑“用户撤销权限立即生效”的平台承诺。

源码：[context.ts:461](/Users/bytedance/Project/cognia-next/lib/plugin/core/context.ts:461)、[外层包装](/Users/bytedance/Project/cognia-next/lib/plugin/core/context.ts:516)、[认证点位 enforcement](/Users/bytedance/Project/cognia-next/packages/plugin-contract/contract/catalog.json:2354)、[shadow 分支继续执行](/Users/bytedance/Project/cognia-next/lib/plugin/contracts/governed-context.ts:84)。

验收：每次敏感调用检查当前运行时授权；授权 revision 改变后，旧 context、旧 session handle 和已经开始但尚未返回的操作均有明确失效规则。测试必须先取得 context，再撤权，最后调用旧对象。

## F03 · P1 · 账户更新没有运行时字段白名单，可扩展凭证投递范围

**源码确认；有效且可行动。** `updateAccount` 的 TypeScript 类型限制了可修改字段，但实际实现只剔除 `outboundRecipients`，随后把其余对象展开写入数据库。具有 `integrations:manage` 的插件可以越过类型传入 `approvedOrigins`、`authSessionId` 等字段。后续请求把账户的 `approvedOrigins` 合并进允许来源，再读取并注入关联 session 的凭证。

这条路径的前提是插件有相应 Integration 管理与执行能力、且存在可用认证账户；本报告不把它描述为无权限攻击。

源码：[API 转发](/Users/bytedance/Project/cognia-next/lib/plugin/api/integrations-api.ts:78)、[对象展开更新](/Users/bytedance/Project/cognia-next/lib/db/integrations.ts:178)、[唯一剔除字段](/Users/bytedance/Project/cognia-next/lib/db/integrations.ts:202)、[来源合并与凭证注入](/Users/bytedance/Project/cognia-next/lib/integrations/action-runner.ts:236)。

验收：Host 在运行时选择允许的更新字段；认证绑定、issuer/client、session、凭证来源范围只能通过 Host 授权事务改变。增加一个普通账户管理权限不能等价于增加凭证可发送的目的地。

## F04 · P1 · 公共 PKCE 默认传输绕过统一网络治理；PII 例外也依赖字段名

**PKCE 已复现，PII 分支源码确认；有效且可行动。** `createPkceFlow` 只检查 `auth:provide`；底层默认采用全局 `fetch`，接受调用者提供的 `tokenURL` 和 `extraTokenParams`。默认路径没有经过 `ctx.network` 的网络权限、PII、审计和生命周期控制。飞书插件传入受控 `fetchImpl`，只能约束该插件的当前实现，不能修复公共默认路径。

源码：[认证 API 入口](/Users/bytedance/Project/cognia-next/lib/plugin/api/auth-api.ts:66)、[默认 fetch 和任意 token 参数](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/lib/plugin/auth/auth-pkce-flow.ts:74)。

合成复现：[pkce-transport-repro.ts](/Users/bytedance/Project/cognia-next/.cache/external-service-adversarial/pkce-transport-repro.ts)；将全局 fetch 替换为内存桩，实际输出：

```json
{
  "rawSyntheticDataReachedDefaultTransport": true,
  "networkPermissionGranted": false,
  "requestsIntercepted": 1,
  "actualExternalRequests": 0
}
```

另一个独立缺口是 PII gate 根据 `authorization`、`access_token` 等字段名跳过检查。字段名无法证明值是 Host 托管凭证，插件也可能把普通用户文本放入该字段。新加的飞书 OAuth token 特例虽然限定了插件与端点，却把供应商协议继续写进 Host。

源码：[字段名例外](/Users/bytedance/Project/cognia-next/lib/plugin/api/plugin-pii-gate.ts:107)、[飞书特例](/Users/bytedance/Project/cognia-next/lib/plugin/api/plugin-pii-gate.ts:136)、[query 参数处理](/Users/bytedance/Project/cognia-next/lib/plugin/api/plugin-pii-gate.ts:177)。

验收：认证网络传输由 Host 强制代理，使用注册并校验的端点和请求描述；业务插件不能替换默认传输。PII 例外只对应 Host 解析出的实际凭证引用，不能由插件随意命名字段获得。供应商差异通过受限协议描述表达，而不是不断增加 Host 的厂商条件分支。

## F05 · P1 · 非 GitHub 的原始认证写请求可绕过 action 审批

**源码确认；有效且可行动。** 公共 `authenticatedRequest` 允许业务插件直接发送请求。原始非读请求的审批规划目前专门处理 GitHub；非 GitHub Integration 提前返回。因此，日历插件即使定义了需要审批的删除 action，也能通过原始 DELETE 路径绕过该 action 的参数、job 和审批约束。

源码：[公开入口](/Users/bytedance/Project/cognia-next/lib/plugin/api/integrations-api.ts:192)、[仅规划 GitHub 写请求](/Users/bytedance/Project/cognia-next/lib/integrations/action-runner.ts:108)、[原始请求调用链](/Users/bytedance/Project/cognia-next/lib/integrations/action-runner.ts:325)。

验收：每个认证写请求绑定到已批准的 capability invocation，核对实际账户、资源、method 和授权 revision；也可以提供明确授权的受限直连能力，但不能让普通 action 执行权限隐式获得任意写通道。Agent、Workflow、UI 和插件直接调用必须走同一决策边界。

## F06 · P1 · 任务缺少原子领取，停用或取消也未统一阻止晚到结果

**源码确认；有效且可行动。** job 执行先读取 `queued/retry_wait`，随后普通更新为 `running`，没有事务性 claim、owner、generation 或 lease。并发的批准与队列 drain 可以同时取得同一个待执行 job；模块内 controller Map 不是原子领取机制。

停用 Integration 时主要解除注册和 Workflow disposer。已捕获的 handler、正在执行的认证请求和结果落库没有统一绑定插件生命周期。取消后异步 handler 返回成功的路径，也没有统一的终态保护。

源码：[读取待执行状态](/Users/bytedance/Project/cognia-next/lib/integrations/action-runner.ts:625)、[后续建立 controller 并标记 running](/Users/bytedance/Project/cognia-next/lib/integrations/action-runner.ts:680)、[普通 DB 更新](/Users/bytedance/Project/cognia-next/lib/db/integrations.ts:552)、[解除注册](/Users/bytedance/Project/cognia-next/lib/plugin/bridge/integrations-bridge.ts:299)、[晚到成功路径](/Users/bytedance/Project/cognia-next/lib/integrations/action-runner.ts:727)。

验收：用持久化事务领取任务；插件、账户和 job 的取消信号传到请求层；旧 generation 禁止继续发请求或提交状态。远端写入一旦发出，取消不能承诺撤销远端效果，必须进入可核对的 unknown/reconciliation 状态。测试覆盖双执行者、停用中写入、取消后成功、进程崩溃和 lease 接管。

## F07 · P1 · 数据迁移有实现但未接入激活路径，迁移账本又依赖过期审计

**源码确认；有效且可行动。** 插件启动路径应用表声明，但没有发现实际启动或更新流程调用 `runPendingMigrations`。桥接层在表名集合相同且表已存在时直接返回，没有据此执行索引变化或数据回填。更新器检查有无声明，不等价于迁移实际发生。

这是静态可达性结论；本轮没有在真实用户数据库上执行升级或制造损坏。

源码：[manager 激活前建表](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:4319)、[同名表提前返回](/Users/bytedance/Project/cognia-next/lib/plugin/dexie/bridge.ts:127)、[migration runner 定义](/Users/bytedance/Project/cognia-next/lib/plugin/dexie/migration-runner.ts:34)、[updater 检查](/Users/bytedance/Project/cognia-next/lib/plugin/lifecycle/updater.ts:785)。

另外，Integration 迁移的完成标记和回滚备份放在 `integrationAudit` 中，而审计清理会删除 90 天前的记录。完成标记过期后不能可靠阻止重跑，也不能保证回滚材料仍在。回滚直接恢复快照，也没有识别迁移后用户对账户、订阅或 Workflow 的修改。

源码：[读取完成标记](/Users/bytedance/Project/cognia-next/lib/integrations/migration.ts:85)、[备份与完成记录](/Users/bytedance/Project/cognia-next/lib/integrations/migration.ts:125)、[快照回滚](/Users/bytedance/Project/cognia-next/lib/integrations/migration.ts:235)、[90 天清理](/Users/bytedance/Project/cognia-next/lib/db/integrations.ts:613)。

验收：通过真实 manager 更新旧版本插件，证明 schema/index/backfill 恰好一次执行；独立持久化迁移 ledger，记录源、目标、版本、fingerprint 和阶段；回滚按字段或记录 revision 检查冲突。覆盖“清理审计后重新启用”和“迁移后用户编辑再回滚”，不能只测试直接调用 runner。

## F08 · P2 · 文档插件缺少贯穿搜索、引用、预览和历史的公共契约

**源码确认与设计缺项；有效且可行动。** DocsProvider 有内部注册表，但插件 context 没有对应的公共贡献 API；设置页仍固定展示飞书和 Google。即使增加注册入口，URL 识别、provenance 与 Dock 文档校验仍有厂商闭集，第三方 provider 可能搜索成功却无法保存可信引用或重新打开。

注册表移除本身也没有 revision/change 通知，搜索 hook memo 持有 provider。停用或替换后，旧函数和账户引用的失效需要一并处理。

源码：[内部注册表](/Users/bytedance/Project/cognia-next/lib/docs-providers/registry.ts:21)、[公共 context](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/types/plugin/plugin.ts:2738)、[固定设置卡片](/Users/bytedance/Project/cognia-next/components/settings/connections/docs-providers/docs-providers-card.tsx:68)、[memo provider](/Users/bytedance/Project/cognia-next/hooks/chat/use-remote-doc-search.ts:85)、[URL 识别](/Users/bytedance/Project/cognia-next/lib/docs-providers/document-url.ts:7)、[provenance](/Users/bytedance/Project/cognia-next/lib/docs-providers/document-provenance.ts:100)、[Dock 校验](/Users/bytedance/Project/cognia-next/lib/artifacts/dock-documents.ts:245)。

验收：一个不导入 `@/` 私有实现的第三方文档插件，完成注册、账户设置、搜索、读取、带来源引用、snapshot/live preview、附件、历史重开和停用恢复。停用后保留已保存快照，并中止旧 provider 的在途读取。

## F09 · P2 · Issue Sync 与备份仍有公共 API 之外的封闭扩展点

**源码确认与设计缺项；有效且可行动。** Issue Sync 已有公共 provider 注册和 disposer，不能说“完全没有插件 API”。但持久化项目资源仍是固定 union，配置界面固定枚举资源类型。只搬运同步函数无法支持新厂商的资源绑定、字段映射、watermark 和历史 externalRef。

备份公共 API 允许触发创建和恢复，却没有 destination 注册；目的地 dispatcher 和 fanout 仍固定供应商。不能用一个通用工具调用替代目的地的就绪检测、账户、加密包上传、取消和结果语义。

源码：[Issue provider 注册](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/lib/plugin/api/issues-api.ts:58)、[资源类型闭集](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/types/issues/index.ts:172)、[固定资源 UI](/Users/bytedance/Project/cognia-next/components/issues/project-resource-dialog.tsx:390)、[备份目的地 dispatcher](/Users/bytedance/Project/cognia-next/lib/data/destinations/index.ts:13)、[备份公共 API](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/lib/plugin/api/backup-api.ts:22)。

验收：公开 namespaced、schema-versioned 的资源和目的地贡献；Host 继续拥有同步引擎、备份打包加密、调度和历史。原有飞书任务、多维表格、Google Drive 备份绑定必须迁移后继续工作。

## F10 · P2 · 统一服务视图的 key 会折叠多个账户，恢复入口偏向 MCP

**源码确认；有效且可行动。** 服务视图按 `(pluginId, serviceId, providerId)` 合并，未把 connection 实例纳入 identity。同一服务的两个账户可能互相覆盖；review/manage 分支又主要面向 MCP，未给普通 Integration 统一表达登录、补权限、重新认证和错误恢复。

源码：[服务合并 key](/Users/bytedance/Project/cognia-next/lib/external-services/service-view.ts:97)、[非 MCP 操作分支](/Users/bytedance/Project/cognia-next/lib/external-services/service-view.ts:111)、[连接投影](/Users/bytedance/Project/cognia-next/lib/external-services/service-view.ts:134)。

验收：service/provider 定义与 connection 实例分开；同服务两个账户可同时显示、选择和恢复。UI、Agent、Workflow 使用完全相同的稳定 connection 引用，不能依赖“第一个账户”。

## F11 · P2 · “保留数据卸载”与外部账户清理的产品承诺不一致

**源码确认；有效且可行动。** 卸载默认 `purgeData: false`，文案承诺重装可以继续原来的状态；manager 却总是先清除外部连接、Integration 账户和相关状态，并清理插件 secrets。插件表中的 checkpoint 可以保留，但对应账户身份已经消失。

源码：[默认保留](/Users/bytedance/Project/cognia-next/hooks/plugins/use-plugin-uninstall.ts:95)、[产品承诺](/Users/bytedance/Project/cognia-next/i18n/messages/en/plugins/delete.json:4)、[无条件清理外部服务](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:4824)、[secrets 清理](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:4862)、[删除关联数据](/Users/bytedance/Project/cognia-next/lib/db/integrations.ts:245)。

验收：分别定义 disable、uninstall-retain、purge-local、disconnect 和远端 revoke；明确每个动作对账户、引用、授权、密钥、缓存、同步游标的效果。卸载清理密钥可以是正确的安全选择，但 UI 必须说明需要重连，并保留或明确迁移可恢复的数据引用；本报告不要求卸载后无条件保留 token。

## 方案必须补齐的契约

以下是设计缺项，不冒充已复现的故障。

### 1. 复用认证不等于共享所有授权

至少区分三层：供应商远端 OAuth grant、Host 中的 connection/session、每个业务消费者的本地 capability grant。基础插件负责协议适配；Host 负责凭证存储、投递、刷新协调和本地授权；业务插件只申请完成操作所需的权限。

稳定身份至少考虑 provider 包与发布者、部署域/issuer、client、tenant、account、user/bot 身份、用途和 scopes。资源与操作授权还需要消费者、resource、revision。当前 registry 按 scope 超集选第一个 session，不足以表达这些选择。

源码：[AuthSession](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/lib/plugin/auth/auth-provider-registry.ts:25)、[按 scopes 选择 session](/Users/bytedance/Project/cognia-next/packages/plugin-contract/src/lib/plugin/auth/auth-provider-registry.ts:214)。

不能把“同一个 Google 登录”推导为文档只读和云盘备份必须共用一套 token。仓库已经分别建模 docs 和 backups 的配置用途，应保留明确选择。新增远端 scopes 也不能自动扩大已有业务插件的本地权限。

源码：[Google 用途配置](/Users/bytedance/Project/cognia-next/lib/docs-providers/providers/google/config.ts:4)。

### 2. 凭证刷新、失效和登录回调必须由 Host 协调

需要为同一 refresh-token lineage 定义跨进程/窗口 single-flight、轮换 CAS、撤销屏障、过期重试，以及 refresh 与 logout 竞争的结果。插件实例内的 Map 只能协调该实例。Google 现有 Rust 认证实现已有 epoch 与断连协调，迁移时不能退化成每个业务插件各自刷新。

源码：[飞书实例内刷新协调](/Users/bytedance/Project/cognia-next/plugins/feishu-auth/src/oauth.ts:121)、[Google Host 认证协调](/Users/bytedance/Project/cognia-next/crates/cognia-connectors/src/google_docs_auth.rs:42)。

公共协议还应声明 PKCE/device/redirect 等流程的运行时支持、回调一次性消费、state/issuer/client 绑定、取消与迟到回调规则，以及带 secret 的 confidential-client 交换由哪个受信执行环境完成。静态导出的前端不能被假设拥有服务端密钥。

### 3. provider 身份和依赖不能只靠字符串

当前 provider 注册只阻止覆盖“已经存在”的其他所有者。当真正基础插件缺席时，另一有 `auth:provide` 的插件可能先注册同名 provider。已有连接必须绑定预期包、发布者和协议版本，不能在基础插件重装后被同名实现接管。

源码：[当前所有者检查](/Users/bytedance/Project/cognia-next/lib/plugin/api/auth-api.ts:45)、[能力桥 provider 注册](/Users/bytedance/Project/cognia-next/lib/plugin/contracts/capability-bridge-map.ts:523)。

依赖需要写明接口版本、支持的认证流程和 Host 能力，并规定循环依赖、版本冲突、缺失依赖、消费者停用/恢复。当前阻止删除仍被 required consumer 依赖的插件是合理保护，不应为了“独立卸载”删掉。独立发布与有兼容性约束的协同升级可以同时成立。

源码：[依赖停用保护](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:2451)、[依赖卸载保护](/Users/bytedance/Project/cognia-next/lib/plugin/core/manager.ts:4804)。

### 4. 明确插件的信任模型

前端插件目前可以在 Host realm 中执行：实现包含间接 eval 或向同一页面注入 Blob script。SDK 权限包装不能被描述成针对恶意同域代码的隔离沙箱。必须选择并公开“受信代码扩展”的边界，或者为不受信插件提供隔离执行、无直接 Host globals/网络/密钥的环境。

源码：[bundle evaluator](/Users/bytedance/Project/cognia-next/lib/plugin/core/evaluate-plugin-bundle.ts:22)、[浏览器 script 注入](/Users/bytedance/Project/cognia-next/lib/plugin/core/evaluate-plugin-bundle.ts:103)。

这不是要求本轮重写全部运行时；它要求不要以更强的安全承诺发布当前实现。即使采用受信插件模型，F01—F05 仍会造成误用和授权语义不一致。

### 5. 同步和索引的数据责任需要贯穿到断连

Host 提供通用队列、检查点持久化和任务治理；供应商业务插件提供各自增量协议。必须定义分页未完成时的提交点、游标失效、全量重建、删除 tombstone、去重键、429/backoff、webhook 验签和续租、poll/webhook 去重、断网恢复以及远端访问权撤销。

文档进入搜索、RAG、附件、聊天历史或本地索引后，还要定义断连/删除对派生数据的影响。保留用户主动保存的快照与撤销在线读取权限是两个不同决定。业务插件停用不能留下仍可使用旧凭证的后台同步器。

### 6. 不能用通用 action 替代领域语义

建立逐项迁移表：旧入口 → 公共领域接口 → 新插件 → 数据/引用迁移 → 行为测试 → 明确不支持项。飞书现有 skills 已覆盖 calendar、doc、sheets、base、task、wiki；任务和多维表格同步还有状态方向、分区与字段映射。Google 文档、云盘备份也不是相同的读写模型。

源码：[飞书能力集合](/Users/bytedance/Project/cognia-next/lib/skills/built-in/lark/index.ts:7)、[任务同步](/Users/bytedance/Project/cognia-next/lib/issues/sync/providers/lark-task.ts:69)、[多维表格映射](/Users/bytedance/Project/cognia-next/lib/issues/sync/providers/lark-bitable.ts:53)。

日历至少逐项覆盖 recurrence/例外、时区与全天日程、参会人与 RSVP、忙闲、会议室、提醒和通知副作用；文档至少覆盖正文结构、权限、导出、引用、附件、快照与在线协作入口。具体供应商支持范围应按实际接口验证，本轮没有验证这些供应商线上能力。

### 7. 运行时和发行矩阵必须是接口的一部分

分别记录 browser、Tauri、Capacitor、headless 的认证、密钥、网络代理、调度和事件入口能力；不支持时提供机器可读的原因与恢复动作。飞书当前插件仅 desktop 可用，不能据此宣称其他运行时已经接通。

多窗口已有 owner gating，不能据此断言当前每个窗口都重复激活插件。仍需测试 owner 崩溃/接管时的刷新、同步和 action fencing。发行同时验证内置目录与独立安装包，而不仅是工作树源码可以 import。

源码：[现有 owner gating](/Users/bytedance/Project/cognia-next/components/providers/initializers/plugin-runtime-initializer.tsx:143)。

### 8. 认证方式与基础插件的服务消费契约

“基础认证”需要先列出按需支持的认证方式与运行时条件：OAuth PKCE、device flow、需要受信交换的流程，以及 API key/PAT、service-account/JWT 等非 OAuth 方式。这里是协议扩展范围的设计问题，不表示本轮要求一次性实现所有认证方式，也不表示这些方式在每个供应商或运行时都可用。

“库插件”也需要明确含义：它贡献哪些运行时服务，消费者通过什么已有公共能力取得服务，接口和依赖版本如何校验，服务实例属于哪个账户/连接，调用权限如何传递，以及 provider 停用或升级后旧引用怎样失效。应复用已有依赖与认证贡献机制，避免只加 `manifest.dependencies` 或构建期 import 就宣称完成了运行时复用。

最低验收是两个业务插件复用一个基础 provider，但各自只获得已批准的账户、操作和资源权限；其中一个被停用或撤权不影响另一个的合法授权，基础 provider 升级则按依赖契约统一排空和恢复。

## 最小落地顺序与验收

1. **先固定 Host 边界**：处理 F01—F05；明确受信/隔离模型，固定 connection、grant 和 credential handle。验收用无权限监听、旧 context 撤权、伪造账户 patch、原始 DELETE 和认证默认传输的反例测试。
2. **再闭合执行与存储生命周期**：处理 F06—F07、F11；通过 manager 的实际安装、升级、停用、卸载入口验证，不只测内部 helper。
3. **补公共领域贡献**：处理 F08—F10；用没有私有 `@/` import 的文档、Issue provider 和备份 destination 插件验证完整用户路径。
4. **做跨厂商纵向迁移**：至少覆盖飞书日历/文档、Google 文档/备份以及两个并存账户。新旧实现不能同时拥有同一刷新、同步或写操作。迁移保留旧账户选择、引用、调度、映射和 checkpoint 的可追溯关系。
5. **再批量抽取其他能力**：每批提交行为对照和回滚证据。一次飞书接入不能证明平台已经消除了厂商耦合。

建议的验收矩阵：

| 维度        | 必须观察的结果                                                                             |
| ----------- | ------------------------------------------------------------------------------------------ |
| 权限        | 无权限订阅拿不到 session；撤权后旧对象和在途结果失效；新增 scopes 不扩大旧 consumer grant  |
| 账户        | 同厂商双账户、不同 tenant/client/purpose 不串用；缺失基础插件时同名 provider 不接管旧连接  |
| 写入        | UI/Agent/Workflow/原始请求统一审批；双执行者不重复领取；不确定远端结果可核对               |
| 同步        | 中途失败不前移 cursor；重试稳定去重；过期游标全量恢复；删除和权限变化传播                  |
| 生命周期    | 停用、升级、断连、撤权使旧 generation 失效；owner 崩溃可接管且不重放写操作                 |
| 迁移        | 旧数据经真实 manager 升级；索引变化和回填恰好一次；90 天清理不丢迁移标记；回滚不覆盖新编辑 |
| 领域        | 第三方 provider 完成设置、业务操作、来源引用、历史重开和错误恢复；无 Host 厂商特判         |
| 运行时/发行 | 每个支持运行时有实际 flow 证据；内置与独立包行为一致；缺失能力有明确状态                   |

## 本轮验证与边界

- 两个合成复现均通过 `pnpm exec tsx` 执行实际实现，输出见 F01、F04；未使用真实凭证，未请求外网。
- 其余结论来自当前源码调用链；未执行供应商 OAuth、真实日历写入、生产数据库迁移或跨窗口故障注入。
- 本轮没有修改业务代码，没有把发现标为已修复，也没有提交或推送。报告是审查交付物，不是全量实现验收。
- 已有依赖删除保护、Google 认证用途隔离、owner gating 属于应保留的设计，未当作应删除的缺陷。
- 按用户选择，只完成本轮源码与同模型审查报告；未运行外部模型 CLI。

## 复核与处置（2026-10-31）

用三个独立只读上下文，按当前工作树逐项核对源码；ES-01、ES-06、ES-09、ES-14 的关键行由主会话再次读源码确认。以下结论覆盖上文“证据”列，决定已和用户逐项确认。

### 复核结论

| 结论                   | 编号                                                          | 说明                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 确认，比原描述更宽     | ES-01                                                         | catalog 中 `onDidChangeSessions` 的 `requiredPermissions` 为 `[]`；任何插件都能收到所有 session 的创建和删除事件，事件里带完整 token。                      |
| 确认，比原描述更宽     | ES-03                                                         | patch 除了能改 `approvedOrigins`、`authSessionId`，还能改 `pluginId` 和 `id`（`lib/db/integrations.ts:190` 的展开顺序）。                                   |
| 确认，比原描述更宽     | ES-06                                                         | `isGithubIntegration` 只看 `definition.id` 和 `github.*` action；id 不是 github、但允许来源包含 `api.github.com` 的 Integration，写 GitHub 也不会规划审批。 |
| 确认，比原描述更宽     | ES-13                                                         | 除了领取不是原子操作，action job 的 drain 也没有按 owner 窗口限定：drain 由 integrations 能力启动，而 `plugin-runtime` 在非主窗口同样会被标记为就绪。       |
| 确认                   | ES-09、ES-14、ES-18、ES-20、ES-21、ES-22、ES-25、ES-27、ES-28 | 调用链与原描述一致。ES-20/21 只能经插件 API 触达，仓库内没有调用方。                                                                                        |
| 部分成立（机制不同）   | ES-02                                                         | 运行时撤权机制存在，其他 API 也遵守（`permission-guard`）；问题在于 auth 只读 manifest，所以在 UI 中撤权对 auth 不生效，而不是“旧 context 持有过期权限”。   |
| 部分成立（严重度降低） | ES-04                                                         | 缺口属实；但前端插件与 Host 同域，本来就能直接调用 `fetch`，而且打包后桌面端 CSP 的 `connect-src` 会拦截任意 token 端点。这是契约问题，不是隔离边界问题。   |
| 部分成立（严重度降低） | ES-05                                                         | 属实，但 PII gate 防的是意外泄漏，把用户文本误放进凭证字段的概率很低。                                                                                      |
| 部分成立               | ES-19                                                         | 启动时的 restore 加上 Dexie 的 SchemaDiff，会在下次启动时补上新增索引；只有当前会话内拿不到。                                                               |
| 部分成立               | ES-24、ES-26                                                  | 托管的 MCP 服务器会动态注册 docs provider，所以注册表并非只能内部使用；按 namespace 缓存 provider 的窗口很小。                                              |
| 部分成立               | ES-29                                                         | lifecycle 对每个 (plugin, service, provider) 只生成一行，目前不会折叠；多账户是未来需求。                                                                   |
| 部分成立               | ES-30                                                         | 任何连接都能暂停和恢复；缺的只是重新认证入口。                                                                                                              |
| 不成立，或已有决定     | ES-17                                                         | ADR-0126 明确规定前端插件为“半受信”：执行任何代码前有逐个插件的信任授权（`manager.ts:3892`），默认要求签名，授权可撤销。                                    |
| 不成立，或已有决定     | ES-35                                                         | 插件 API 层唯一的飞书字面量（`plugin-pii-gate.ts:136`）属于未提交的 WIP；`lib/connectors/adapters/lark` 是有意设计的一方适配器。                            |
| 设计或功能缺项         | ES-07、08、10、11、12、15、16、23、31–34、36                  | 只有在跨厂商插件化落地时才成立；目前不是缺陷。                                                                                                              |

### 处置决定

- **方向**：先写 ADR（Proposed），覆盖 ES-07—12、15、16、23、36 以及迁移契约；定稿前，除 feishu-auth 外暂停把其他能力抽取为插件。
- **信任模型**：维持 ADR-0126 的半受信模型；ES-17 关闭，不对外宣称更强的隔离。ES-01—05 按契约完整性和权限 UI 如实性来修。
- **首批修复**（5 个提交，各带 changeset）：
  1. auth 契约：ES-01（订阅事件需要 `auth:consume`，按 provider 过滤，事件不带 token）、ES-02（auth 改用运行时权限检查）、ES-03（运行时字段白名单）、ES-04（默认走 Host 受管的传输）、ES-09（session 和账户记录 provider owner，owner 不同时拒绝）。
  2. 原始写请求：ES-06 接入 ADR-0239，新增通用 `integration` 类别，默认 shadow；GitHub 改为按请求 host 识别。
  3. job 执行：ES-13 用事务原子领取，drain 只在 owner 窗口运行；ES-14 取消后终态保持 `cancelled`，并标注“远端结果未知”，请求层传入 signal，停用插件时取消它的 job。
  4. 迁移：ES-18/19 在 manager 更新路径中执行 `runPendingMigrations`，并记录 schema 指纹，迁移失败则不激活新版本；ES-20/21 的 90 天清理跳过迁移记录，回滚前检查 `updatedAt`，发现冲突时报告并保留用户编辑。不升 Dexie schema。
  5. 卸载文案：ES-22 如实列出卸载时会被清除的内容；安全上的清理行为保持不变。
- **降级**：ES-05 降为 P3；飞书 token 端点特例在 feishu-auth 落地时改为由 provider 声明，并入 ADR。
- **关闭**：ES-17、ES-29、ES-30、ES-35。
- **后置**：ES-24—28、ES-31—34，以及 ES-26 的缓存刷新问题，跟随 ADR 之后的迁移批次处理。

### 落地记录

- 首批修复：5ee04bcdb8（ES-22）、b119bd3f9e（ES-01/02/03/04/09）、cb9ac351a0（ES-06）、bad783b824（ES-13/14）、52f21fa704（ES-18—21）。
- 设计契约：ADR-0246（Proposed），`docs/content/docs/{en,zh}/adr/0246-a-business-plugin-reaches-a-service-through-a-granted-connection.md`。
- ES-09 的 headless 持久化：cd624cccf9；复审发现的 7 个缺陷：838096514f；ES-05 维持 P3。
- ES-23 在初次分类时遗漏，2026-10-31 补入：断连、撤权和远端删除后派生数据与用户副本的处理规则写入 ADR-0246 第 10 节，代码尚未实现。
