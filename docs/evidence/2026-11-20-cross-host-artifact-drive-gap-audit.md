# Cognia 跨 Host 产物交接审计

- Status: verifying
- Lane: standard
- Created: 2026-11-20
- Updated: 2026-11-20
- Related: ADR-0103、0188、0215、0222、0223、0224、0243
- Baseline: Cognia `49fa03bd9c82ceb276a536e842ed5b530e0d7231` 的工作副本，cognia-services 固定版本 `487e9f2d617c9d1b9b648ec510cafcf53b962c2c`，飞书文档 revision 1395。

审计期间工作副本的 cognia-services pin 更新为 `52ec93a316b6d25e81bc9da5206b597d60985f10`。已对照两个版本，`services/share-server` 和 `services/sync-server` 无差异。

## Original request

> 那就结合 Cognia 现有实现，充分研究实现，进行对照，看看目前的缺口和问题

## 审计结论

Cognia 已有**能离开源 Host 的文件副本**。普通消息附件在点对点接力完成后落地目标 Host，共享会话附件提交后落地协作服务，文件快照也能随分享链接下载。缺的是**把选定的任务产物发布为持久、可授权、可校验的文件版本，并由后续运行显式消费**。接力解决会话和工作区交接，文件页解决聚合和管理，这两个入口都适合承载该能力。

本轮在当前源码上复现了六个与交接直接相关的现象。其中配对下载截断与工作区混合版本来自 2026-11-17 的文件审计，本轮重新执行。其余覆盖附件缓存、工具附件投影、议题固定版本打开、共享消息发布时间。另有两个具备明确前提的源码风险。

## Knowledge

| ID  | Statement                                                             | State    | Basis                                                | Depends on |
| --- | --------------------------------------------------------------------- | -------- | ---------------------------------------------------- | ---------- |
| G1  | 对照 Aiden 云盘提案，查清 Cognia 的可复用实现、真实缺口和问题。       | Agreed   | 用户请求，2026-11-20。                               | -          |
| O1  | Aiden 的目标是跨临时电脑、云电脑和本地电脑交接任务产物。              | Observed | 飞书原文、需求画板和详细设计，revision 1395。        | -          |
| O2  | Cognia 已有若干跨源 Host 的文件路径，各有不同的权限、引用与清理范围。 | Verified | 当前调用路径、固定版本服务代码、现有测试及独立复核。 | -          |
| O3  | 当前实现可重现六项影响交接的行为，其中四项来自本轮定向探针。          | Verified | V2 的本地 Jest/jsdom 合成输入。                      | O2         |
| O4  | 现有运行身份测试通过，调用点清单守卫有两项基线差异。                  | Observed | V3 的 Jest 结果和两个清单断言，2026-11-20。          | -          |
| Q1  | 已部署双 Host 与对象存储上的断网、撤销和重启行为如何？                | Open     | 本轮证据为源码和本地组件测试。                       | O2         |

## Problem frame

从运行 A 在执行目录生成一份文件出发，跟踪它怎样被发现、复制、校验、授权、打开和回收。目标条件是 A 明确发布版本后，源 Host 下线，独立运行 B 按引用读取相同字节，并且权限变化、上传中断、同名改写和删除都能得到确定的结果。范围包含部署在 Cognia 中的文件与协作通路，以及 Aiden 文档的直接对照。

## Complexity profile

| Dimension    | Rating | Why / what would resolve it                                    |
| ------------ | ------ | -------------------------------------------------------------- |
| scale        | high   | 文件页、会话接力、协作服务、运行调度和沙箱都有相关入口。       |
| technical    | high   | 文件身份、字节版本和引用生命周期必须一致。                     |
| coupling     | high   | 权威可能在源/目标 Host、协作服务或分享服务，权限各异。         |
| requirement  | medium | 已明确交接目标。个人空间、团队空间与默认保留期取决于产品范围。 |
| verification | high   | 组件测试可校验具体合同，跨 Host 与存储故障还需要实际环境。     |
| risk         | high   | 假成功会造成不可恢复的产物损失，泛化现有授权会扩大数据范围。   |

## 与 Aiden 的逐项对照

| 维度         | Aiden 方案                                                                                       | Cognia 当前实现与边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 存储与所有权 | 每个 Aiden 空间最多绑定一个有效 ADrive 团队空间，创建有预占和 request ID，文件由 ADrive 持久化。 | Files 聚合文件页上传、媒体、文档、Artifact 和工作区文件。工作区条目按会话、根和路径定位，字节仍从磁盘或留存的账本捕获读取。收藏和目录只固定符合条件的本地媒体引用。参见 [sources.ts](../../lib/files-library/sources.ts#L285)、[workspace-files-io.ts](../../lib/files-library/workspace-files-io.ts#L99)、[files-library-items.ts](../../lib/db/files-library-items.ts#L45)。                                                                                                                                                                                                                                                                                                                                                                                  |
| 点对点交接   | 上传成功后传盘标识和文件路径。源运行环境可随后停止。                                             | 普通消息 `file` 附件可经已有接力复制并校验 canonical 字节，目标导入创建媒体引用。常驻 Host 接力也能把 Git 补丁或 tar 校验后应用为目标 checkout，显式回传可以在本机生成新 checkout。两种方式要求交接时连通指定目标，成功落地后，目标副本可以独立存在。Git 快照验证 Git tree，tar 与 Git 路径都可能排除忽略文件，后续读取的是可写 checkout。图片附件也可能存在单独的原件。参见 [attachments.ts](../../lib/thread-handoff/attachments.ts#L96)、[host-state-store.ts](../../lib/sync/host-state-store.ts#L1232)、[snapshot-handoff.ts](../../lib/remote-host/code-supply/snapshot-handoff.ts#L202)、[code_snapshot.rs](../../crates/cognia-task-workspace/src/code_snapshot.rs#L765)、[result-return.ts](../../lib/remote-host/code-supply/result-return.ts#L202)。 |
| 私有共享字节 | 空间权限通过服务端校验，CLI 在多个运行环境中调用同一服务。                                       | 协作服务已支持本地卷/S3 兼容对象存储、会话级读写票据、SHA-256 提交及接收端校验。已提交的附件可独立于源 Host 被同一共享会话的成员读取。现有 HTTP 接口以会话成员和附件为边界，50 MiB 上限，上传、提交校验和下载均整件缓冲。参见 [chat_attachment_store.rs](../../crates/cognia-collab-server/src/chat_attachment_store.rs#L12)、[chat_api.rs](../../crates/cognia-collab-server/src/chat_api.rs#L3243)、[shared-chat-conversion.ts](../../lib/collab/shared-chat-conversion.ts#L40)。                                                                                                                                                                                                                                                                             |
| 预览和复用   | 网页可列目录、预览、下载和按 session 看。Agent 计划使用 `ls`、`upload`、`cat`、`download`。      | Files 与 FileSpace 已有入口。配对 Files 使用在线 Host，文件传输上限 10 MiB。实时 FileSpace 按当前权限访问持有文件的 Host，协作请求的应答对象属于单个请求，约 15 分钟过期。迁移目标缺少可直接解析到文件的通用产物输入。参见 [ADR-0223](../content/docs/zh/adr/0223-files-is-a-space-you-manage.md#9-手机)、[remote/types.ts](../../lib/files-library/remote/types.ts#L178)、[session_files.rs](../../crates/cognia-collab-server/src/session_files.rs#L1)。                                                                                                                                                                                                                                                                                                      |
| 快照分享     | 预览和下载链接由服务端申请。                                                                     | Cognia 的加密文件快照已有分块、重试、散列校验、独立于源 Host 的读取和过期/撤销。文件票据绑定分享 code，分享链接的读取模型与项目成员、运行身份分离。现有分享上传先创建信封，全部文件提交后客户端才返回成功，失败时尝试撤销。可复用其传输与校验设计。参见 [share/client.ts](../../lib/share/client.ts#L262)、[share/blobs.ts](../../lib/share/blobs.ts#L232)、[固定版本分享服务](https://github.com/cognia-labs/cognia-services/blob/487e9f2d617c9d1b9b648ec510cafcf53b962c2c/services/share-server/src/handlers.rs#L612)。                                                                                                                                                                                                                                       |
| 版本与交付   | 设计例子通过远端路径传递文件。方案未定义跨任务不可变版本、覆盖语义和消费凭证。                   | 议题可固定 Cognia Artifact 内容、记录摘要和验收，也可接受附版本声明的外部 URL。外部引用的版本字符串没有绑定 Cognia 验证过的远端字节。Router Fusion 另有带时效的、绑定 gateway key 的运行产物读取，但内容留在所属 brain 的 Fusion 数据库。两者都已实现领域内版本或访问合同。参见 [issue.link_artifact](../../lib/skills/built-in/issues/link-artifact.ts#L25)、[deliverables.ts](../../lib/issues/deliverables.ts#L23)、[Router Fusion 存储](../../lib/router-fusion/db/ledger-store.ts#L2115)、[读取票据](../../lib/router-fusion/api/artifact-tokens.ts#L2)。                                                                                                                                                                                                  |
| 个人跨设备   | 团队盘聚焦空间内交接。                                                                           | 个人账号同步已有设备登记、加密操作日志及首批六张表。当前固定版本服务路由覆盖设备和操作日志，文件大对象在 ADR-0215 后续阶段。个人同步的设备受众与团队运行授权各有自己的边界。参见 [tables.ts](../../lib/account-sync/data/tables.ts#L387)、[固定版本同步服务路由](https://github.com/cognia-labs/cognia-services/blob/487e9f2d617c9d1b9b648ec510cafcf53b962c2c/services/sync-server/src/routes.ts#L33)、[ADR-0215](../content/docs/zh/adr/0215-one-person-one-encrypted-sync-space-many-writable-hosts.md#实现第-3a-阶段)。                                                                                                                                                                                                                                      |

Aiden 文档的总体约束写明单有效绑定，时序图仍有“查询 1:N”字样。文件接口将上传写法绑定空间 `read`，隐私段落对普通成员只明确列出读权限。CLI 的 Agent 身份接入与写接口在时序图标为待完成。挂载是需求画板中的目标，详细设计给出的是 CLI/API。可移植的经验是持久化与执行环境分别管理，以及分片、失败分类、审计和会话过滤。 [需求与选型](https://bytedance.larkoffice.com/wiki/QEdHwAy6Hi3QIdki9cIcYBiUnfg#doxcn9Haz6HrYiDGXUPOkNiXcMg) · [技术设计](https://bytedance.larkoffice.com/wiki/QEdHwAy6Hi3QIdki9cIcYBiUnfg#doxcnd8av5VrG0FOBrL7IrajIqd)

## 已复现的问题

| ID  | 优先级 | 触发与观测                                                                                                                                                                  | 影响和证据                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | P1     | 配对 Host 返回长 Canvas/Artifact 的正文预览及 `textTruncated`。下载读取同一个字段，131,089 字节 ASCII 样本成功下载为 131,072 字节。                                         | 下载、ZIP 及使用同一正文入口的调用有静默截断风险。复跑文件审计 F01。 [host-dispatch.ts](../../lib/files-library/remote/host-dispatch.ts#L293) · [remote-ops.ts](../../lib/files-library/remote/remote-ops.ts#L76)                                                                                                                                                                                                |
| F02 | P1     | 配对分块读取只比较文件大小。两次合成读分别取等长版本的前后块，返回 `AABB`，两份合法版本分别为 `AAAA` 与 `BBBB`。                                                            | 上传端输入自己已经不稳定时，对一个拼出的文件计算哈希仍会成功。需从稳定版本读取并在最终提交校验。复跑文件审计 F02。 [remote/client.ts](../../lib/files-library/remote/client.ts#L376) · [本机文件读取](../../lib/files-library/workspace-files-io.ts#L211)                                                                                                                                                        |
| F03 | P1     | 源和目标对同一原始图片使用同一个媒体键，但 canonical 字节可不同。目标命中不同的本地版本时，已提交且正确的 staging 文件没有被检查。探针删除缓存后同一 staging 文件校验通过。 | 接力可因目标已有一份不同转码而失败。现有媒体写入还会保留已有 canonical blob，修复需明确用哪个内容版本。探针用合成字节和模拟媒体缓存。 [源图片](../../lib/chat/media/ingest-media.ts#L85) · [目标候选](../../lib/thread-handoff/attachments.ts#L96) · [媒体持久化](../../lib/db/message-media.ts#L49)                                                                                                             |
| F04 | P2     | 合法 canonical 输入把文件仅放在 `toolCalls[].attachments`。清单可遍历该层，目标导入只投影工具输入/文本输出。定向探针验证目标引用为空，普通 `file` part 对照保留。           | 若 canonical 生产方或导入方提供这种形状，可能传了文件却没有可用的消息引用；只通过当前默认编码器的普通附件流不会触发这个探针。 [附件清单](../../lib/thread-handoff/attachments.ts#L31) · [目标投影](../../lib/chat/import-handoff-session.ts#L43) · [目标引用索引](../../lib/sync/host-state-store.ts#L1296)                                                                                                      |
| F05 | P2     | 议题内联预览使用固定副本，点击名称时操作只收到 artifact ID 和源会话 ID。                                                                                                    | 选择旧版本后打开仍会定位到源会话当前产物。源会话已删除时，固定预览可用而打开失败。本轮用组件测试确认所传参数。 [预览](../../components/issues/deliverables/issue-deliverables-section.tsx#L42) · [打开](../../components/issues/deliverables/issue-run-artifact-link.tsx#L32)                                                                                                                                    |
| F06 | P1     | 活跃共享会话先 append/broadcast 消息事件，再把附件从 pending 提交为 available。探针在 commit 注入故障，事件已经追加，调用返回失败。                                         | 接收端遇到 pending 附件会拒绝整次投影，游标暂不推进。发送 journal 支持再次送同一内容时恢复，已有导入会话在提交后才激活。风险具体落在活跃会话发送路径。 [发送](../../lib/collab/shared-run-coordinator.ts#L510) · [服务器事件](../../crates/cognia-collab-server/src/chat_api.rs#L2063) · [票据](../../crates/cognia-collab-server/src/chat_api.rs#L3334) · [接收投影](../../lib/collab/shared-chat-sync.ts#L565) |

### 源码确认的边界和风险

- **staging 提交确认可能领先于可用状态。** Companion 在异步校验后调用 Dexie `update`，未检查更新条数就返回引用。同设备取消或清理在该窗口删除行时，提交调用可能回成功。现有直接接力随后会再核验文件，通常能阻止无效交接。真实并发触发尚未复现。 [commitAttachmentUpload](../../lib/db/session-attachment-uploads.ts#L359)
- **议题关联的查询与提交之间存在竞态。** 工具先找活动 run，真正写入时只检查行是否存在。若 run 已删除，底层静默返回，工具仍可报告 `linked`；若期间结算，还可附上条目。现有存储合同允许部分调用对已有 run 附加产物，约束应放在该工具的事务入口。真实竞态尚未复现。 [调用处](../../lib/skills/built-in/issues/link-artifact.ts#L96) · [数据库写入](../../lib/db/issue-runs.ts#L288)
- **调用点清单守卫已漂移。** `run-authority-guard.test.ts` 的 launch inventory 和 row-source inventory 两项断言失败，差异包含 agent delegation 和 chat hooks 的迁移路径，以及若干调用计数。运行授权行为测试通过。清单差异影响对覆盖范围的置信度，需要逐项确认再更新清单。 [启动点断言](../../lib/execution/run-authority-guard.test.ts#L194) · [来源断言](../../lib/execution/run-authority-guard.test.ts#L405)

## 当前产品缺口与验收

| ID  | 缺口                                                                                                                                                                                          | 验收线                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| G01 | **发布和物化断开。** Files 中的工作区路径、会话附件、代码 checkout、议题记录都有自己的引用。调度到另一 Host 时，未找到能够把用户选定的任意文件版本作为工作区输入的通用合同。                  | 在运行 A 选定文件，发布完成后关掉源 Host，再创建 B。B 获取的是相同哈希，不要求原目录名或源会话在线。                         |
| G02 | **持久字节与可见引用缺少统一提交。** 现有多条流程各自处理 staging、断点、校验和清理。发布到项目后需要持久文件版本、上传 ID 的重试边界、孤儿清理与生命周期所有者。                             | 上传任一步中止、进程重启、提交响应丢失均可恢复或显式失败。已提交版本可读，重试不会生成重复版本，未完成版本不出现在消费入口。 |
| G03 | **项目和运行的授权交集没有通用文件入口。** 现有作用域分别是会话成员、配对设备、分享票据、Gateway key 和 Host 管理租约。运行身份可作为授权输入，仍需服务端绑定目标项目、操作、对象版本和受众。 | 同项目只读运行可读指定版本但不能发布。跨项目、过期、撤销的凭证读取失败。沙箱只得到限时操作能力，审计含实际发起人与执行运行。 |
| G04 | **保留和删除不共享语义。** 源 workspace 文件、快照、共享会话附件、议题回执随各自所有权清理。需要明确已发布产物是否独立于源会话/文件、项目删除和撤销如何触发回收。                             | 删除源路径后保留已发布版本；删除发布版本或撤销授权后未来读取失败；清理失败可重试，未到期的其他引用仍有效。                   |
| G05 | **完整读取与错误体验不统一。** 预览可以有界，交接输入和下载须能验证完整字节。不同 Host 和文件来源的限额、不可用、失效、上传中需要可见。                                                       | 先覆盖两台 Host、至少一种二进制文件、超长文档、同大小改写和大文件中断。文件页和接续运行对同一版本显示一致的状态。            |

建议按组织工作区场景先验证一个小闭环。协作服务已有 S3/本地存储、工作区/会话权限和完整性校验，是评估持久存储落点的首选现有实现。沿用对象存储适配和现有身份基础，单独定义产物版本的引用、读写许可、保留和提交状态。文件页用于发现和预览，调度器在目标 Host 物化明确选择的版本。首轮重点验证文件字节和授权合同，完整目录挂载、个人双向网盘同步和 ADrive 接入可以各自评估。 [协作存储适配](../../crates/cognia-collab-server/src/chat_attachment_store.rs#L12) · [运行身份](../../lib/execution/run-authority.ts#L37)

## Risks

| ID  | Risk (impact)                          | Severity | Source                             | Claim                                    | Refuted by                                          |
| --- | -------------------------------------- | -------- | ---------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| R1  | 读取或接受了非预期版本。               | high     | F01–F05。                          | 引用、打开和下载指向一份完整的版本。     | 返回截断、混合字节或打开可变来源。                  |
| R2  | 上游停止或上传失败后，产物仍显示可用。 | high     | F06、G01–G02。                     | 发布的产物已提交，目标可独立读取。       | 消息可见但其附件仍 pending，或目标只能等待源 Host。 |
| R3  | 新入口重用过宽的授权。                 | high     | 项目、会话、分享和配对的权限边界。 | 服务端能验证每个读取者与文件版本的关系。 | 只依靠链接、设备级许可或调用者自报的项目。          |

## Verification obligations

| ID  | Risk       | Method                                                                                         | Independence   | Evidence                                                                                                                  | Coverage                                                                           | Status  |
| --- | ---------- | ---------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------- |
| V1  | R1, R2, R3 | Walk production call paths, compare exact service pins and seek counterexamples.               | fresh-reviewer | 上述文件和服务路由，加一次独立源码复核。独立复核执行 11 个 Jest suite、435 个测试，通过。                                 | 查明直接接力、HostState、静态分享和协作各自保留的边界。与 V3 的部分 suite 重叠。   | passed  |
| V2  | R1, R2     | Re-run safe synthetic defect probes.                                                           | tool           | 文件审计 observations 6/6；本轮三个 cache suite 定向探针 4/4。                                                            | 两项历史完整性缺陷重现，四项本轮行为复现。模拟字节源、组件打开动作和协作服务提交。 | passed  |
| V3  | R1, R2, R3 | Run focused repository Jest suites through `pnpm test`.                                        | tool           | 两轮共 20 个 suite 通过、1 个 suite 失败，617 个通过、2 个失败。失败来自 `run-authority-guard.test.ts` 的两份调用点清单。 | 现有接力、Files、分享、协作、固定版本和身份测试。清单失败不等同于授权行为失败。    | failed  |
| V4  | R1, R2, R3 | Shut down the source after publish on two real Hosts and exercise storage and permission loss. | real-env       | 尚无真实双 Host 或服务部署结果。                                                                                          | 需独立部署环境、两个 Host 及真实持久卷或对象存储。                                 | planned |

## Decisions

| ID  | Date       | Decision                                                           | Action   | Based on       | Reversal trigger                                     |
| --- | ---------- | ------------------------------------------------------------------ | -------- | -------------- | ---------------------------------------------------- |
| D1  | 2026-11-20 | 建议先验证显式产物发布和目标 Host 读取，保留当前各入口的授权边界。 | diagnose | G1, O1, O2, O3 | 已有通用实现被发现，或产品目标改为个人文件全量同步。 |

## Residual risks

| ID  | Residual                                                 | From   | Why still open                                 | Next action                                              | Status |
| --- | -------------------------------------------------------- | ------ | ---------------------------------------------- | -------------------------------------------------------- | ------ |
| X1  | 调用点覆盖清单与实际源码存在差异。                       | V3, O4 | 运行行为测试通过，guard 仍列出迁移和计数差异。 | 实现产物工具时核对所有新增和迁移的调用点后同步证据清单。 | open   |
| X2  | 双 Host 关机、对象存储重启、撤销和并发清理尚无真实证据。 | V4, Q1 | 无上述环境的运行记录。                         | 用可丢弃工作区、测试账号和对象执行 G01–G05 的验收线。    | open   |

## Outcome

| ID  | Signal                                           | How / when measured                          | Result                                                                     | Status |
| --- | ------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| M1  | 获得可追溯的现状对照、确认的问题和可验收的缺口。 | 对照本报告、独立复核和 2026-11-20 命令结果。 | 七个维度对照、六项复现、两项源码风险及五项能力缺口，附调用点清单失败记录。 | met    |

### 复查命令

- `node docs/evidence/2026-11-17-file-management-gap-audit.probes.mjs observations`
- `pnpm test --config .cache/artifact-handoff-gap-audit/replay-jest.config.ts --runInBand --watchman=false --runTestsByPath .cache/artifact-handoff-gap-audit/projection.test.tsx .cache/artifact-handoff-gap-audit/shared-publish.test.tsx .cache/artifact-handoff-gap-audit/attachment-cache.test.tsx --testNamePattern observes`
- `pnpm test --runInBand --runTestsByPath lib/remote-host/code-supply/snapshot-handoff.test.ts lib/remote-host/code-supply/result-return.test.ts lib/thread-handoff/orchestrator.test.ts lib/thread-handoff/attachments.test.ts lib/share/blobs.test.ts lib/share/client.test.ts lib/filespace/agent-tools.test.ts lib/account-sync/data/tables.test.ts lib/skills/built-in/issues/link-artifact.test.ts components/issues/deliverables/issue-deliverables-section.test.tsx lib/files-library/remote/client.test.ts lib/files-library/remote/remote-ops.test.ts lib/files-library/workspace-files-io.test.ts lib/execution/run-authority-guard.test.ts`
- `pnpm test --runInBand --runTestsByPath lib/collab/shared-run-coordinator.test.ts lib/collab/shared-chat-conversion.test.ts lib/collab/shared-chat-sync.test.ts lib/execution/run-authority.test.ts lib/execution/run-authority-matrix.test.ts lib/issues/deliverables.test.ts lib/db/issue-runs.test.ts`
