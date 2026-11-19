# 文档解析与导出：修复及功能补齐方案

> 状态：Proposed；尚未实施。创建／更新：2026-11-18（Asia/Shanghai）。
> 依据：[审计报告与证据账本](../evidence/2026-11-18-document-parsing-export-gap-audit.md)、[可重复探针](../evidence/2026-11-18-document-parsing-export-gap-audit.probes/README.md)。
> 深度：Heavy。范围：F1–F15、六类业内实践差距、两项待核实候选问题，以及发布所需的迁移、性能和真实环境验证。
> 本文中的阶段、负责人角色、指标和默认策略均为建议，不代表已承诺排期、已达到性能指标或已经修复。

## 1. 建议与完成定义

**建议先用 S0–S3 关闭 15 项已发现问题，再用 S4–S5 补齐结构化文档、质量提升、模板和任务恢复能力，最后通过 S6 的真实环境发布验收。** 测试、语料和安全检查从 S0 开始，每阶段执行，S6 负责汇总和跨环境验收。

解析侧首先保证“不改错数字、不错位、不遗漏而宣称完整”；导出侧首先保证“菜单可执行、文件可读、取消与失败可区分”。随后提升复杂版面和编辑保真度。沿用现有 parser、OCR、Blob 存储、索引 generation swap、富文档插件和 saveExport，不引入第二套文档存储或一开始替换整套编辑器。

交付完成须同时满足：

1. F1–F15 每项都有实际入口回归、真实文件产物或故障注入证据，全部满足第 4 节的关闭标准。
2. 六类业内实践各有可运行能力和量化验收；支持范围外的转换明确报告损失，不以成功生成文件代替语义正确。
3. 旧文档仍能读取；原件缺失能识别；重解析失败不会替换当前有效索引；删除、备份、恢复、配额和权限覆盖新增原件引用。
4. Web、Tauri、Capacitor 按实际支持平台验收，Word／Excel／PowerPoint／PDF 阅读器能打开并正确呈现支持范围内的产物。未跑的平台标记未验收，不用视口模拟或 mock 代替。
5. 所有发布必需检查通过，无未关闭的 P1 问题、无已知静默数据损失；功能缺失或真实环境阻塞如实记录。

本轮只交付方案。任意 Office 文件无损编辑、通用 PDF 正文编辑、数字签名生成、PDF/A 认证及合规级脱敏不属于基础发布承诺；第 10 节给出这些扩展的明确交付边界。

## 2. 当前事实、假设与现有基础

审计基线是 `b50c5c9501263e3abf20f5792c98756cdc675687`。方案复核时 HEAD 为 `2e6da23843f9134e8e6865d8f32a213d2402d5ad`，已审计 parser、核心 writer、Twin ingest、IM extractor、富文档插件和 HTML writer 的相关路径在两者间无差异。工作区存在其他并发改动；实施时必须重新冻结实际基线。

| 已确认基础                                                                                                            | 方案约束                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/document` 已有 `ProcessedDocument`、`DocumentStructure`、`DocumentSnapshot`、sourceSegments、诊断和质量摘要 | 增量扩展并让消费者持久化这些信息，不新建平行的解析结果类型体系                   |
| `lib/db/session-assets.ts` 已将原件放入 `messageMedia`，由 `messageMediaRefs` 记录引用                                | 复用底层 Blob 与引用账本；Twin／知识源不能伪造 session 身份调用 session 专属接口 |
| `lib/twin/ingest/persist.ts` 已使用 `lib/rag/generation-ingest`，成功后交换 generation 指针                           | 复用 revision 检查和原子交换；不能让新解析任务提前覆盖旧索引                     |
| 知识库 `lib/knowledge-base/ingest/ingest-source.ts` 已支持 base64 原始二进制                                          | 采用兼容读取和按需迁移，不把所有知识库来源误判为丢失原件                         |
| Chat 已有 PDF OCR fallback，OCR package 已有页级路由；上传／AnyDoc 已有部分限制                                       | 修复调用和入口一致性，保留已有保护，不重复建设 provider 和任务队列               |
| Word／表格／演示／PDF 插件已有独立编辑模型；表格已有公式解析与求值                                                    | 修复具体保真缺陷、桥接模型；不把已有编辑、公式或原始 PDF 导出当成空白            |
| `saveExport` 已有 typed outcome；已有模板 service 和导出 disclosure                                                   | 向上透传结果，扩展模板注册表，并保留 Digital Twin 来源标识等既有披露要求         |

工作负载默认设为“中英文知识摄取 + 常见 Office 编辑和导出 + 中等大小文档”。这是便于执行的建议，尚无客户语料支持。S0 固定基准设备、数据集和预算；不同 workload 通过版本化 profile 区分，不能在失败后悄悄放宽标准。

## 3. 目标架构与契约

### 3.1 一条受控读取路径、多个明确的输出投影

```text
Chat / Canvas / Twin / Project knowledge / KB / IM / Rich plugins
        |
        v
原件授权与格式识别 -> 统一 admission / 资源预算 -> reader / OCR / layout adapter
        |                                             |
        v                                             v
共享 Blob + 所属引用                        版本化文档 envelope + 诊断 / 损失
                                                      |
                         +----------------------------+------------------+
                         v                            v                  v
                结构化预览 / 来源定位          脱敏后的检索投影      编辑模型 / 导出投影
                         |                            |                  |
                  修正 / 重解析                 generation swap     writer -> saveExport
```

这是责任划分，不要求所有插件都经过一个前端函数。纯格式与预算契约位于已有共享 package，各入口通过适配器遵守；UI Worker、Host 和移动端保持各自执行边界。主应用继续静态导出，不引入 Next.js 运行时服务。

### 3.2 最小共享 envelope

| 契约                     | 必需内容与不变量                                                                                                            | 归属／兼容方式                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| OriginalSource           | owner scope、source ID／revision、原件引用、原始 MIME／格式、byte length、content hash、原件是否保留                        | Blob 在既有 media store；新增文档 source adapter，授权依据 owner，hash 只用于完整性／去重                                                      |
| ParseIdentity            | parser／provider 及版本、配置 hash、语言、策略、开始／结束时间、source revision                                             | 解析结果可追溯；配置变化触发新 generation，不能伪装成同一次解析                                                                                |
| DocumentStructure        | 原文、独立 embedding 投影、层级／阅读顺序、页／slide／sheet locator、typed cells、spans、inline runs、asset refs；可选 bbox | 扩展 `packages/document/src/types.ts`；维持当前 UTF-16 半开区间及 locator 约定，偏移重算后必须校验                                             |
| Diagnostics / LossReport | 范围、code、severity、处理策略、遗漏／降级特征、可否重试；confidence 可为 unknown                                           | 保留现有 quality 值的兼容语义；非空文本不自动等于 complete；无实测置信度不填虚构分数                                                           |
| ExportPlan               | 输入类型 document／code／spreadsheet／presentation／original PDF、目标格式、writer、能力、已知损失、资产／字体／模板需求    | 能力菜单与执行由同一 resolver 产生；不支持时在生成前给出原因；禁止自动降级为另一种文件却沿用原格式承诺                                         |
| ExportOutcome            | generated artifact、delivery 状态及 render/save 阶段错误；cancelled 与 delivery-unknown 单独表示                            | 尽量扩展／透传 `SaveExportOutcome`；Web 只能知道下载已发起时不得宣称已写入磁盘；crash 后无交付证据时不能假称成功／失败；保留现有调用兼容适配层 |

共享的是身份、结构、能力与损失契约，不是把 XLSX 公式、PPTX 坐标和 DOCX 修订强行塞进同一种 Markdown AST。各插件继续拥有领域模型，通过明确映射导入／导出。插件不得直接导入 Host 私有 `lib/`；共享类型通过现有 package／SDK 的公开入口发布。

原件、提取原文、embedding 内容和导出投影必须区分。原件默认保留在用户当前数据域；上传云 OCR、embedding 或模型前，继续经过现有权限、路由和 PII gate。保存原件不自动授权上传、跨账户共享或云端同步。

### 3.3 执行、取消与预算

复用现有上传检查，抽取可跨入口调用的纯 admission 层；格式识别同时参考扩展名、MIME、magic bytes，冲突产生 typed diagnostic。String 输入按实际 UTF-8 字节计费，ArrayBuffer／Blob 不因输入容器不同绕过相同策略。不得仅靠 MIME 或扩展名信任文件。

下表是 **S0 待校准的初始建议**，不是已测性能。有效限制取入口策略、运行环境和用户配置中的最严格值；不提高已有更严格限制。

| 资源       | 初始建议及行为                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 压缩包     | 保留已有 1,000 entries、100 MiB 总解压量、50 MiB 单成员、200 倍压缩比上限；流式读取时继续记账，不能只相信 ZIP header                                   |
| 原件字节   | 保留 Chat／AnyDoc 等入口当前限制；普通文档建议上限 50 MiB，移动端 10 MiB。超限返回可恢复错误或转受控后台能力，不默认截断                               |
| 展开复杂度 | 单任务最多 250,000 个展开单元格、200 页／slide；移动端 50,000 cells、50 页。行列 repeat 必须为有限正整数，先算预算再分配；大规模空白重复使用稀疏表示   |
| 图片／输出 | 解码前检查像素，单图建议 40 MP、移动端 12 MP；解码总像素、内存和最大输出同样限额；提取文本建议 10 MiB，移动端 2 MiB                                    |
| 并发       | 本地解析桌面最多 2 个 worker，移动端 1 个；复用 AnyDoc 已有队列约束，不通过新增队列扩大总并发                                                          |
| 时间       | 本地普通任务建议 30 秒、OCR／layout 任务按 provider SLA 设置显式总 deadline；现有 AnyDoc 60 秒上限不得绕过。取消后 1 秒内停止本地工作或终止隔离 worker |

不能中断的第三方同步解析需放入可终止 Worker／隔离进程；只传 AbortSignal 但继续占用 CPU 不算取消完成。云端取消是否真正停止计费必须按 provider 能力说明，本地停止等待不等于远端任务已取消。达到预算时返回 `partial`／`blocked` 的具体原因及处理建议，禁止返回完整成功；只有显式选择部分结果时才能发布部分索引。

### 3.4 任务状态、Host 与交互

逻辑状态为 `queued → admitted → running → validating → committing → succeeded`；`running` 另有 read／parse／OCR／render 的进度。等待远端、可恢复重试分别为 `waiting-provider`／`retry-wait`，均受总 deadline 约束；终态为 `succeeded`、`partial`、`failed`、`cancelled`、`blocked`。这些是契约语义，实施时映射已有 job 状态，不直接假定现有数据库已有这些枚举。仅明确允许的源任务可以以 partial 提交；权限、预算或内容校验失败不能转换为成功。

提交前重查 cancel、source revision 与授权；提交已经完成时，迟到取消返回已完成事实，不谎报已撤销。App 关闭必须等待可中止任务退出或终止 worker；终态不会因为旧 callback／重试到达而恢复 running。所有跨 Worker／Host DTO 使用带 schemaVersion／taskId／owner scope／revision 的可序列化对象，不传函数或依赖隐式 tuple 顺序。

Standalone Web／mobile 使用本地已支持能力；paired Web／mobile 路由到明确 Host，并固定 task 的 Host 身份。断连只变成等待／失败，不能悄悄在另一 Host 重执行或上传云端；取消发送到原执行者，重连对账。需要新增 Tauri command 时，Rust 主责同时注册 command、最小 capability／ACL 和跨端 DTO 测试；通过路径访问原件必须校验授权目录、规范化路径及 symlink／traversal，不能扩大为任意文件访问。

用户界面统一展示 pending、processing、partial、failed、cancelled、offline 和 retry 状态，优先解释受影响内容与处理动作。质量面板／导出菜单支持键盘操作、可访问名称、焦点返回和屏幕阅读器进度播报；警告不只依赖颜色，避免逐页播报造成噪声。所有文案含 aria 文案走中英 split i18n；这些与 UI 同阶段验收，不推迟到最后补做。

## 4. F1–F15 逐项修复与关闭标准

责任角色是实施分工建议：ING（解析与摄取）、DATA（存储）、EXPORT（导出）、OFFICE（富文档插件）、UI（交互）、QA（验证）。每项须有单一主责，其他角色负责边界评审。表中的关闭要求是自动化回归加指定真实环境证据，不是仅看源码。

| ID／优先级        | 主责与现有落点                                                                                                            | 具体修复                                                                                                                                       | 阶段／关闭标准                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 / P1           | ING；`lib/twin/ingest/{stage,parse,ocr-fallback,persist}.ts`、`lib/twin/worker-runtime.ts`、Twin add-source UI；DATA 协作 | stage 保留原件引用、真实格式和解析摘要；loader 能取回 bytes；页级 OCR 在空文本拒绝前执行，混合 PDF 保留原生文本页；重解析复用 generation swap  | S1：从真实 add-source 路径导入扫描／混合 PDF，产生对应页文本与 locator；刷新／重启后能重解析；失败／取消不替换旧 generation；原件 hash 一致                                          |
| F2 / P1           | ING；`packages/document/src/parsers/office-parser.ts`、project／Twin ingest                                               | 删除无条件两位舍入；分离源数值、显示格式、公式和缓存结果；消费者保存准确投影                                                                   | S1：`0.00012345`、`1.23456789`、负数、科学计数、日期和公式缓存经过实际持久化与检索仍正确；不能恢复源文件本已超出数值精度的数据，也不能声称任意精度                                   |
| F3 / P2           | ING；`packages/document/src/document-processor.ts`，Chat／Canvas／project 调用点                                          | 按格式分派，HTML／CSV String 走专用 parser；处理 encoding／BOM，HTML 排除 script／style 内容，CSV 保留引号／换行／列结构                       | S1：同一有效文档 String／bytes／Blob 的标准化结果一致；真实消费者不再把 HTML 源码作为正文；畸形输入有诊断                                                                            |
| F4 / P2           | ING；processor、`lib/connectors/adapters/_shared/inbound-media.ts`                                                        | 文本格式二进制统一解码；支持 TXT／Markdown／JSON／code／XML；IM 传播提取失败，不能吞成空成功                                                   | S1：format × payload × consumer 矩阵全部满足对应契约；无 BOM／UTF-8 BOM／UTF-16 BOM、无效编码和不支持编码均有明确结果；真实 IM 附件抽样验收                                          |
| F5 / P2           | ING；`packages/document/src/parsers/open-document-parser.ts`                                                              | 使用命名空间感知的 XML 读取；保留 self-closing／covered／repeated cells、typed ODF values、merge spans 与公式结果；先检查展开预算              | S1：空 B1 后 C1 仍为 C1；value-only float 不丢；重复行列、合并格、日期／布尔／货币映射及 locator 精确；异常 repeat 有限时拒绝                                                        |
| F6 / P2           | ING；`packages/document/src/parsers/presentation-parser.ts`                                                               | 按 presentation relationships／sldIdLst 顺序读取；保留无文本／图片页位置、备注和非文本遗漏诊断                                                 | S1：`slide2 → slide1 → slide3` 顺序、3 页数量、各页 locator 精确；空页不被当成 parser error，图片页未 OCR 时标注内容范围                                                             |
| F7 / P1 hardening | ING；processor、upload inspection、Canvas import、所有 adapter                                                            | 共用 admission 和展开预算；maxFileSize 真正生效；Worker deadline／取消、XML 外部实体禁用、归档路径及资源检查                                   | S1：每个入口运行字节／压缩／repeat／像素／deadline／取消探针；`maxFileSize: 2` 拒绝 37-byte 输入；惰性恶意文件在 parser 前被拒，且证明 parser 未调用；受限进程内压力验证不失控       |
| F8 / P1           | EXPORT；`lib/files/document-writer/index.ts`、artifact PDF                                                                | 注册并嵌入有分发许可的 Unicode 字体，增加 fallback／缺字诊断，校验换行和分页；字体按需加载且可离线获取                                         | S2：中／日／英文、数字和约定 emoji 集实际 PDF 渲染无乱码、可搜索／复制；emoji 若以图片呈现须披露可访问性与复制限制；离线静态构建产物可用；不影响原始 PDF 导出                        |
| F9 / P2           | EXPORT；`lib/canvas/document-export.ts`、Canvas export menu                                                               | 共用 capability resolver；code PDF 走 code writer，不依赖 React visual projection                                                              | S2：Python／JSON 从真实菜单导出非空、可读 PDF；每个展示格式均能执行或明确显示禁用原因；新增类型有能力矩阵回归                                                                        |
| F10 / P2          | UI；Canvas exporter、menu、rail、`lib/files/save-export.ts`                                                               | typed outcome 贯穿生成、保存和通知；取消安静退出；render/save 错误独立可操作提示，所有格式一致                                                 | S2：Web download-issued、原生 saved／cancelled、render-error／save-error 分别验证；raw／HTML／SVG 与 PDF／PNG 同样有失败反馈；真实原生取消无成功或失败 toast                         |
| F11 / P2          | EXPORT；`lib/files/document-writer/{blocks,index}.ts`、artifact export／hook                                              | 输入区分 code 与 document；保留 code 空白／换行；将现有 Markdown 能力映射到 typed blocks／runs，生成原生表格、图片、链接、列表、分页与损失报告 | S2 修复 code；S3 完整关闭：三行 Python 缩进与换行保留；DOCX XML 有 native table／drawing／hyperlink／break；Word 与 PDF 阅读器呈现正确；不支持项导出前可见，不再字面输出伪装丰富格式 |
| F12 / P2          | OFFICE；`plugins/cognia-documents/src/{model,docx}.ts`                                                                    | 为 table／cell comment 建合法锚点；不把无锚 comment 自动移到首段；round-trip validator 检查 anchor 语义和关系                                  | S3：表格、段落、多 comment 导入→导出→导入后归属和内容精确；Word 中定位正确；孤立 anchor 输出诊断并阻止宣称 lossless                                                                  |
| F13 / P2          | OFFICE；`plugins/cognia-office/src/{model,xlsx,runtime}.ts`                                                               | null-safe views；隔离 enrichment 错误到 sheet／feature；补齐字体名／字号／下划线／边框／旋转，并检测尚不支持的样式                             | S3：无 view／normal view 控制样本同样保留 bold；多 sheet 不因一个异常全丢；新增样式 round trip 正确；所有已识别但未保留属性进入损失报告与确认流程                                    |
| F14 / P2          | OFFICE；`plugins/cognia-presentations/src/{model,pptx,runtime}.ts`                                                        | 模型增加 inline runs，保留每 run 字号、粗斜体等支持属性；未知格式进损失报告；语义 validator 比较 runs                                          | S3：Alpha 18pt bold／Beta 36pt italic 往返后各自样式精确，PowerPoint 呈现正确；旧模型可读；不支持项不得 `warnings=[]` 且宣称无损                                                     |
| F15 / conditional | EXPORT；`lib/export/html/beautiful-html.ts`、custom theme editor／store                                                   | 主题字段改为受限颜色值，解析并规范化；拒绝标签终止、URL、任意声明；写入与导出两端验证；旧非法值返回可见 fallback                               | S2：合法内置／自定义颜色视觉不变；已有 breakout fixture 无脚本节点或执行；`</style>`、恶意 URL／CSS 值被拒；普通文本安全转换不回退；不把本地 palette 缺陷夸大为已证实远程 XSS        |

两项候选也必须得到结论：**N1**（DOCX metadata）：S0 用完整 Mammoth／浏览器路径核实，若确认则 S1 读取 ZIP 的 `docProps/core.xml` 并测 title／author／timestamps／缺失字段。**N2**（中文名与保存碰撞）：S0 在真实 Capacitor 环境核实，S2 补齐 Unicode 文件名规范化、唯一命名／明确覆盖选择和重试幂等性。没有设备时记录阻塞；不得以“未复现”直接关闭。

## 5. 业内实践差距与补齐结果

这些是可借鉴的设计实践，不是工具排名或引擎替换决定。以官方资料为依据，保留 Cognia 已有能力。

| Gap                                | 对照依据                                                | Cognia 增量与主责                                                                     | 阶段／必须证明的结果                                                                                                    |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| G1 结构化文档与来源                | Docling 文档树、层级、布局和 provenance [S1]            | ING＋DATA：envelope、原件、typed table／runs／assets、locator 和可重处理身份          | S1 最小保留，S4 完成：从检索片段定位原页／sheet／slide，能解释处理版本；不以扁平 Markdown 覆盖唯一结构                  |
| G2 明确策略与质量提升              | Unstructured partitioning [S2]、Docling confidence [S3] | ING：fast／OCR／layout 按页路由；低质量标记、人工复核、重解析比较和显式 provider 选择 | S4：扫描／混合／双栏文档走预期策略；空白页与识别失败区分；每页状态可查；无分数时为 unknown；升级耗时／费用可解释        |
| G3 复杂表格结构                    | Azure Document Intelligence Markdown elements [S4]      | ING＋OFFICE：typed cells、rowspan／colspan、caption／footnote，跨页表格保留页来源     | S1 坐标正确，S4 丰富结构：固定表格样本结构指标达标、关键数字 100% 准确；Markdown 只是投影，CSV 降级需提示合并／样式损失 |
| G4 reader／模型／writer 与显式损失 | Pandoc 转换边界和 reference document [S5]               | EXPORT＋OFFICE：能力 resolver、统一 loss report、原生写入、模板／引用样式             | S2–S3 修复与契约，S5 模板：支持子集语义往返全通过，未知项有范围和策略；预览与保存使用同一产物／配置                     |
| G5 有界处理                        | Docling 文件、页、像素和解压限制 [S6]                   | ING：统一预算、并发、可终止 worker、可恢复任务；DATA 负责保留与清理                   | S1 阻止无限展开，S5 完成恢复：所有入口限额一致，取消／超时释放资源，重启不产生重复索引或孤立原件                        |
| G6 按任务测质量                    | OmniDocBench 分别评估文本、表格、公式、阅读顺序 [S7]    | QA：固定双语 corpus、golden 结构、性能／内存和真实文件对照；不直接套用综合分数        | S0 建基线，每阶段运行，S6 封版：每个声称支持的能力有正负样本、单独指标和完整证据；准确率与 save 成功率分开              |

Docling 的 table confidence 在所查官方文档中仍标为未实现；因此不使用它作为现成质量门槛。Azure 已是现有 OCR provider 选项，工作重点是把 provider 的结构化结果传递到消费端，而不是再次“接入 Azure”。

不同目标格式采用各自的能力验收，不能要求所有格式支持分页或可编辑的 Office 对象：

| 目标                | 验收重点                                                                          | 不适用或必须披露的损失                                                                     |
| ------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| DOCX／生成型 PDF    | 内容、字体、表格、图片、布局、分页／页码；DOCX 的原生对象，PDF 的阅读／复制／打印 | DOCX 与 PDF 的可编辑性不同；TOC 分别验收字段更新策略与静态链接；复杂对象依 capability 披露 |
| XLSX／PPTX          | typed values／公式状态／styles／merges，或 slides／runs／位置／notes              | 不强制文章式目录／footnote／分页；打印按该 Office 文档的 print settings 验收               |
| HTML／Markdown／TXT | 内容顺序、声明的语法、链接／资产与编码；HTML 可另验收打印样式                     | TXT 无表格对象／样式；Markdown 对 span／公式等依已声明 dialect 降级；不承诺固定页码        |
| JSON／JSONL／CSV    | 声明 schema／record、字段类型、转义、编码与坐标／列契约                           | CSV 不保存多 sheet／merge／style；不要求排版、目录、页眉页脚                               |
| PNG／SVG／离线 ZIP  | 可视区域完整、尺寸／清晰度、包内路径／资源完整                                    | 图像不等于可编辑文档；ZIP 的保真度由其中具体文件决定                                       |
| 原始 PDF 插件输出   | 原件与已声明页面／表单操作、签名修改保护                                          | 不套用生成型 PDF 的新字体／排版验收，不因复制原件宣称新建 PDF/A 或 tags                    |

## 6. 按优先级划分的实施阶段

依赖关系：S0 →（S1 与 S2 可并行）；S3 依赖 S2 的导出契约；S4 依赖 S1 的原件与解析契约；S5 依赖 S3、S4；S6 汇总所有阶段的真实环境证据。S3／S4 在各自前置稳定后可并行。存在共享类型改动时先合入小型契约 PR，避免多个分支同时定义同一模型。

### S0 — 冻结事实、回归语料与契约

**优先级：发布前置；主责：QA，ING／EXPORT 共同签认。**

- 固定实际 source commit、依赖锁、测试命令、设备／OS／Office 版本、corpus hash、初始指标和支持矩阵；记录并发工作区差异，必要时使用隔离 worktree。
- 把审计四个探针转换为能断言正确行为的回归测试；先记录确实失败的断言。现有探针 exit 0 只代表成功复现，不能当成验收绿灯。
- 用同一依赖环境在隔离基线核实 `custom-numbering` 失败：修正错误检测或真实缺失，不能通过删测试、降低断言或忽略 warning 过关。
- 形成 format × payload × consumer × shell 矩阵；确认低层共享类型、损失状态和资源策略；核实 N1／N2。
- 固定第 7 节 corpus 和初始预算，保存首轮错误率、耗时与峰值内存，不填写估算结果冒充实测。

**退出验收：** F1–F15 均有 test ID／人工步骤、失败依据和负责人；N1／N2 有结论或明确阻塞；基线测试失败已归因并有处理归属；所有硬指标和 fixture hashes 已入库。交付 `acceptance-matrix`、baseline results 和失败产物，不要求本阶段把产品测试全部变绿。

**回退／阻塞策略：** 基线漂移重跑受影响范围；不能确认 source／fixture 身份则不宣称回归已关闭。可继续与阻塞设备无关的实现。

### S1 — 摄取正确性、原件与资源边界

**优先级：最高；主责：ING；关闭 F1–F7，处理 N1；DATA 评审持久化。**

三个可独立实施的工作包：A 为格式路由、数值／ODS／PPTX correctness；B 为 Twin 原件引用与 loader／OCR／generation；C 为共同 admission、展开预算和隔离执行。B 只引入恢复所需最小 envelope，不等待 S4 的高级版面能力。

原件写入与 source 创建需有原子提交或可补偿的 staging／commit 协议。引用在源删除前不能被 GC；取消或失败的新任务释放未提交引用。所有调用路径接入相同策略：Chat、Canvas、Twin、project knowledge、knowledge base、IM 和富插件，不遗漏直接 parser API。

**退出验收：**

- 第 4 节 F1–F7 的断言全部通过；原件 hash、坐标、数字及 slide 顺序在持久化后仍准确。
- 实际 Twin 导入扫描／混合 PDF，证明 OCR 被调用且输出有页来源；本地 provider 与至少一个已支持且已配置的云 provider 分别验收。无云环境时明确留下发布 profile 限制。
- 原件写完／解析中／OCR 返回前／generation 提交前取消与崩溃注入：旧索引不变、无孤立引用、恢复后可重试。
- 各入口超预算 fail closed，错误包含 limit／observed／scope；受控进程证明取消和期限生效，不运行失控 OOM 测试。
- 账户／workspace 切换不能访问其他 owner 的原件或复用未授权结果；备份／删除／GC 回归通过。

**发布与回退：** 新摄取能力通过解析 profile／feature flag 分批启用；失败可停止新 ingest 并继续读旧 generation。原件引用和 schema 迁移不能通过切 flag 删除；禁止回退到静默舍入路径继续摄取。

### S2 — 基础导出可用、安全且状态可信

**优先级：最高；主责：EXPORT，UI 协作；关闭 F8–F10、F15，修复 F11 code 部分及 N2。**

交付 Unicode font pipeline、code input、capability resolver、typed outcome、主题颜色验证和无静默覆盖的文件命名。字体使用有分发许可的资源并记录许可／版本／包体积；从现有静态资源按需读取，不依赖运行时 Next 服务或外部字体网络请求。

**退出验收：**

- 中日英文与约定 emoji corpus 的 PDF 真正生成、渲染、提取；无缺字方框／乱码／裁切，源码缩进、换行、分页准确。
- Python／JSON 的 Canvas PDF 菜单可实际执行；菜单能力矩阵与 writer dispatch 同源且无悬空选项。
- 每个输出格式跑成功、取消、render failure、save failure；原生取消不 toast failure；Web 只显示有证据的下载状态。
- 同中文标题连续导出、重复点击、失败重试和跨 shell 同名文件，不静默覆盖不同内容；覆盖只在明确选择后发生。
- 主题注入回归失败关闭，旧非法主题有恢复提示；合法主题、disclosure 和现有 HTML 文本安全边界保持。

**发布与回退：** 可逐个 writer／格式关闭，不整体禁用已验证原件导出。关闭有缺陷的 PDF writer 时显示原因，不重新启用已知乱码 writer。F11 在 S3 完成前仍保持 open，不能只因 code 修复就关闭。

### S3 — 富内容与 Office 语义保真

**优先级：高；主责：OFFICE，EXPORT 负责 core writer；完整关闭 F11–F14。**

- core writer 使用 typed blocks／runs 和结构化 Markdown 解析，支持 headings、paragraphs、inline emphasis、nested lists、quotes、code、native tables、local images／alt、hyperlinks、page breaks；复用既有 Markdown 能力，先做依赖复用核查，不引入第二套不一致语法。
- DOCX comment 锚点落在合法段落／表格单元内容，表格级 anchor 映射需明确且可逆；无锚 comment 保留为诊断对象，不挪到其他段落。
- XLSX 修复 null view，并实现约定字体／边框／旋转模型；PPTX 增加 runs。schemas 如需升级，具备 v1→新版本迁移和未知新版本只读／拒绝改写行为。
- validator 比较 typed values、公式文本／缓存状态、merge ranges、comments、runs、assets 和顺序；区分语义等价与字节等价，ZIP 时间戳等不作为语义失败。
- 每个 export plan 有 loss report。默认阻止未确认的破坏性转换；可选保留原件、只读预览或明确接受转换，沿用已有插件确认流程。

**退出验收：** 第 4 节 F11–F14 全部通过；F1–F15 状态全部关闭且各自证据齐全；Word／Excel／PowerPoint 中验收指定产物，图片、表格、超链接、comment 和 mixed runs 保持。旧插件文档可读写支持子集；未知特征既不误报无损，也不清空原件。已有 `custom-numbering` 失败在本阶段前修复并保持通过。

**回退：** 不破坏性重写原始文件；新模型保存前留 source revision 和可恢复快照。旧客户端不能读新模型时拒绝写入并提示升级，不静默转换为 v1。

### S4 — 结构化解析、来源定位与质量提升

**优先级：高；主责：ING；完成 G1–G3，扩展 G6。**

交付 envelope 的完整持久化、页级质量面板、来源导航、重解析／版本比较。优先沿用 PDF 原生文本与现有 OCR adapter，针对低质量／混合页升级；多栏阅读顺序、复杂表格、图片／caption、页眉页脚、公式和跨页表格使用显式结构与诊断。云 OCR 结构映射落到实际 `packages/ocr` provider，实现层不放在仅转导出的 `lib/ocr` shim。

无法在当前本地引擎可靠恢复的版面，进入用户可见的 layout provider 策略／复核，不制造推测内容。新增外部引擎只在相同 corpus 上证明准确率／成本收益且符合 local／cloud 权限后接入。一个解析失败页不能让整文档毫无提示地 complete。

**退出验收：**

- 片段可回到原页、slide 或 sheet range；bbox 存在时高亮位置正确，无 bbox 时仍有可靠 locator；原文和 embedding 偏移映射通过 invariant 检查。
- 多栏／跨页表格／公式／图片页 corpus 按第 7 节指标验收；typed cell 与 spans 持久化再读一致，结构信息不会在 ingest 中丢弃。
- 每页能看到来源、策略、状态、遗漏和可用质量信号；失败／unknown／空白／部分成功分开；质量面板能发起受预算约束的重解析。
- provider 切换与 parser 配置变更生成新 ParseIdentity；新结果验证后再交换；检索到旧 generation 时仍能定位其原件版本。
- 云端路径经过 PII／权限边界并明确适用范围；不能脱敏的原始版面上传须遵守既有显式用户授权，默认不因低质量自动上云。

**回退：** 可关闭新 layout adapter；读取保留的旧结果，显示处理版本。无法满足某能力的 accuracy 时标为不支持／需复核，不能用单一平均分掩盖高风险字段错误。

### S5 — 模板、长文档与可恢复任务

**优先级：中；主责：EXPORT／ING，分别拥有输出与任务工作包；完成 G4–G5 的功能补齐。**

输出工作包扩展现有 `lib/document-templates`：模板样式、页边距、页眉页脚、页码、目录、caption／footnote、代码样式、数学公式与引用；建立格式 capability 表。DOCX 优先原生可编辑结构；无法原生表示的公式／图形可选 SVG／图片并带替代文本和损失说明。HTML／Markdown／ZIP 导出离线资产包，所有引用有稳定相对路径；不隐式抓取任意远程资源。

任务工作包在 `lib/twin/{job-worker,job-control,job-retry}.ts`、`lib/twin/ingest/job-runner.ts` 和 `lib/db/twin-jobs.ts` 扩展 Twin 生命周期；知识库保持自己 ingest job 的所有权，共享恢复契约，不把所有任务迁入 Twin 队列。增加持久化 checkpoint、进度、恢复、取消、配额、背压、缓存失效与局部重试。现有导出没有覆盖的持久化任务需在 EXPORT 领域增加最小 job adapter，先证明现有任务服务不能直接扩展，不创建通用第二队列。相同 source revision＋parser config 可以复用已授权解析结果；编辑、权限、provider 版本或配置变化后不能复用过期结果。读取与纯解析可有界重试，生成索引采用 generation 幂等提交；保存失败不得自动覆盖或不断重复下载。

**退出验收：**

- DOCX／生成型 PDF 各至少一份中英混排长文档模板通过其已声明能力对应的分页、目录跳转／更新策略、页码、表格跨页、caption／footnote、公式、引用和打印检查；其余格式按第 5 节能力表验收，明确不适用项。预览与最终文件的配置一致。
- 引用序号和来源链接可追溯；离线包不存在断链／缺图，不泄露本机绝对路径或隐式请求第三方 URL。
- app／worker 在 read、parse、OCR wait、persist、export、save 前后重启：任务状态可解释，已提交 generation 不重复提交，旧索引可用，取消后的任务不会复活；交付不确定的保存进入 delivery-unknown，恢复时不自动再次写文件／下载。
- 有界 retry 只重试可恢复阶段；provider 无 idempotency 或远程取消能力时明确可能重复费用，不能声称 exactly-once；最终失败有可操作原因。
- 固定设备与 corpus 的延迟、峰值内存、UI responsiveness 达到 S0 冻结预算；压力测试队列有上限，历史原件的保留和 GC 遵守用户策略。

**回退：** 各模板／provider／后台策略可独立停用；旧模板和文件仍可读取。恢复 checkpoint 版本不兼容时从原件重新开始安全阶段，不能重复提交 generation 或保存副作用。

### S6 — 真实环境验收与分批发布

**优先级：发布门槛；主责：QA／Release，模块主责签认。**

从 S1 起积累真实环境证据；S6 使用固定候选构建执行完整 acceptance matrix，并审查所有功能开关、文档、迁移和回滚。先内部验证，再小范围用户启用，最后默认开启；各批次以错误／损失／取消／预算指标与用户反馈为推进依据，不假定当前已有百分比发布基础设施。

**退出验收：**

- 所有 F 和 G 对应验收行通过，N1／N2 有可复查结论；无 P1、无已知静默损失、无未处理的能力宣称与实际结果不一致。
- Web、Windows／macOS／Linux Tauri、Android／iOS Capacitor 的声明支持矩阵完成；某平台做不到则该能力保持关闭并在产品矩阵明确，不把整体标为全平台通过。
- 至少 Windows／macOS 的实际 Microsoft Office 验证目标支持子集；PDF 至少两个独立阅读器验证渲染／复制／打印，LibreOffice 作为互操作补充。记录客户端版本而非假定一致。
- 升级、旧文档读取、新旧客户端混用、备份恢复、删除／GC、配额、账户切换、失败重试和 crash recovery 全通过。
- 生成 release evidence bundle：commit、build／依赖、corpus hash、自动化结果、逐项状态、截图／文件、性能报告、剩余已披露限制和回滚演练结果。

**停止放量条件：** 出现数据错位／舍入、跨 owner 访问、原件丢失、错误成功状态、取消失效、已知损失未披露或资源失控，立即停止相应能力新任务，保留可读旧数据和诊断；修复后重新通过受影响阶段，不靠降级为静默成功恢复放量。

## 7. 验收体系与量化标准

### 7.1 固定语料与测试矩阵

起步 corpus 为 **30 份小型基准文件**，辅以格式／payload 参数化和单独的大文件性能样本。不能用 30 个 happy paths 替代负向覆盖。

| 类别            | 数量 | 必含特征                                                                                         |
| --------------- | ---- | ------------------------------------------------------------------------------------------------ |
| PDF             | 8    | 原生中英、纯扫描、混合页、双栏、跨页表格、公式／图注、空白页、长页／分页                         |
| XLSX／ODS       | 6    | 高精度小数、typed values、合并／空格、repeated／covered cells、无 view／多 sheet、公式／丰富样式 |
| DOCX            | 5    | tables／links／images、段落与表格 comments、修订／编号、code／CJK、metadata／页面样式            |
| PPTX            | 4    | relationship 重排、空白／图片页、mixed runs、表格／图表／notes                                   |
| 文本／HTML／CSV | 4    | encoding／BOM、HTML script／style、带引号换行 CSV、Python／JSON 空白语义                         |
| 负向输入        | 3    | 加密／截断、repeat／ZIP／图片预算、非法 theme／资源引用；由每个基准生成独立变体                  |

每份 fixture 记录许可证／来源、输入 hash、期望结构、可接受损失、oracle 和所有适用 test IDs。使用自制或可再分发公开样本；客户文件须单独授权和脱敏，不随测试结果上传。坏文件仅在有 CPU／内存／时间上限的隔离环境运行。

调用矩阵至少覆盖 Chat、Canvas、Twin、project knowledge、KB、IM 和四个富插件；并非每个入口支持全部格式，先按 capability 声明生成正／负向矩阵。支持的组合要成功，不支持的组合要明确拒绝。所有 save writer 覆盖对应 shell 的 success／cancel／render error／save error。

### 7.2 硬门槛与统计目标

| 指标                                          | 建议验收线                                                                                           | 证据／解释                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 数字、坐标、顺序、comment anchor、支持的 runs | 固定语料 **100% 精确**                                                                               | 对解析结果、持久化结果及 round trip 分别比较；不得用整体文本相似度掩盖局部错值                                            |
| 静默损失                                      | **0 个已知未披露损失**                                                                               | 支持特征精确保留；检测到的不支持特征出现在 scoped LossReport，用户确认策略被实际执行                                      |
| 原生文本提取                                  | 固定文本层样本除声明规范化外精确匹配                                                                 | whitespace／Unicode normalization 规则先固定，不删除有意义 code 空格或表格边界                                            |
| OCR／layout                                   | 起始目标：清晰扫描 CER ≤1%，复杂扫描 ≤3%；table TEDS ≥0.95；curated 阅读顺序完全正确                 | S0 测量后冻结可实现的 profile；清楚列出语言／扫描条件／样本数。高风险数值字段仍要求精确或进入人工复核，不能以平均指标放行 |
| 公式                                          | 支持公式结构标准化后精确；渲染正确                                                                   | 区分数学 OCR、Office 公式文本和重新计算。未重算需标记缓存状态；不得声称完整 Excel 兼容                                    |
| 导出视觉／可编辑性                            | 固定样本无乱码、裁切、覆盖或缺图；声明 native 的元素确实为 native                                    | PDF 图像人工检查＋区域比对，DOCX／XLSX／PPTX 包内结构检查＋真实客户端；不要求跨系统字体像素完全一致                       |
| 取消／预算                                    | 本地取消 1 秒内终止工作；超限不提交完整结果；队列保持上限                                            | 带计时和资源采样的故障注入，远端取消另记结果；主线程不能承担不可中断的大解析                                              |
| 延迟／内存                                    | S0 按设备记录绝对预算；后续相同样本 p95 不较冻结基线上升超过 10%，除非有评审后的明确能力收益与新预算 | 至少 20 次受控重复，冷／热启动分开；不混合设备、provider 或文本／OCR任务。新增能力不能凭空套用旧路径耗时                  |
| 保存／恢复／隔离                              | 确定性用例 **100% 通过**                                                                             | 下载已发起与磁盘已保存分开；失败不覆盖文件／旧 generation；跨 owner 访问失败；重启恢复无重复可见提交                      |

以上统计指标是建议目标，尚无客户分布保证。S0 若发现当前引擎无法达标，应缩小公开支持 profile 或增加经评估的 adapter，并记录决定；不能删除失败样本或只改 complete 标签掩盖未满足的产品要求。

### 7.3 自动化与真实环境的边界

实现阶段新增／修改 `components/`、`hooks/`、`lib/`、Rust 源码时按仓库规则补 co-located tests；不为纯文档变更创建产品单测。延续 Jest 入口 `pnpm test`，先跑相关行为回归；共享 package／schema 改动再扩大调用方检查。

需要的工程门槛由改动范围决定：`pnpm lint`、`pnpm typecheck`、格式检查；涉及客户端打包执行 `pnpm lint:static-export`／`pnpm build`；插件边界执行 `pnpm plugin:contract:check`、`pnpm author-types:check`、`pnpm plugin:author-imports`；持久化变更执行 `pnpm audit:data-governance`，结合 `pnpm audit:colocated-tests`、`pnpm audit:modules`。新增 UI 文案编辑双语 split sources 后执行 `pnpm i18n:build`、`pnpm i18n:build:check`、`pnpm lint:i18n`。这些是未来实施命令，本方案未运行产品检查。

E2E 扩展既有 `tests/e2e/mobile/twin-sources.spec.ts`、`tests/e2e/web/files-library.spec.ts`、workflow Twin ingest／RAG 和 Tauri OCR 场景；为跨入口解析和保存增加定向 spec，使用 `pnpm audit:e2e-governance` 校验归属。新 spec 的理由是目前缺少完整 document export flow，不复制现有 fixture／driver。

Web 用静态构建和 `pnpm test:e2e:static`；移动视口用现有 mobile project 辅助布局验证，但 Android／iOS 的实际文件保存必须在设备或受支持模拟器上跑安装包。当前 Playwright Tauri project 是 Windows WebView2 CDP 路径，不能当作 macOS／Linux 自动化已覆盖；后二者使用实际 Tauri smoke／原生操作并保留证据。真实 IM 不在未授权情况下发消息；实施时使用已授权测试账号／专用会话验收，缺少环境明确阻塞。

不在本方案中要求本地 coverage run；现有 CI coverage policy 维持。mock 单测不计为准确率、真实 provider、Office 或跨平台验收。

## 8. 迁移、隐私与故障恢复

### 8.1 存储与数据迁移

1. **扩展引用所有权，复用存储。** 为 document source 增加明确 owner 类型／适配器。现有 `messageMediaRefs` 的 owner 分类、级联删除、GC、配额、备份及导入都必须识别它；不能只添加一个新 prefix 后继续让旧逻辑误当 message owner。hash 相同不代表权限共享。
2. **版本化、增量、可重入。** schema 编号在实施时按最新数据库版本分配；不在本方案硬编码下一个版本。新增 nullable 字段和双读适配先落地；按批次回填，记录进度和失败，完成后才切默认写路径。老数据无需全库一次重解析。
3. **旧 Twin 原件不可凭空恢复。** 仅存 Markdown 的来源标记 `legacy-text-only`／`sourceRetained=false`，继续允许当前检索并展示精度／来源限制；OCR、精确页来源或原件再导出需要重新导入。不把重包成 TXT 称为恢复 PDF。
4. **已有知识库 base64 原件兼容。** dual-read 后按需迁入 Blob，核对 decoded bytes hash 并原子记录引用；完成验证前不删除旧载荷。旧精度文本可在有原件时重新解析，否则无法证明恢复，应要求重导入。
5. **原子发布。** 原件 staging、解析 snapshot、引用和 generation 之间采用当前数据库事务／提交协议；跨事务边界设置可恢复状态和补偿清理。source revision 变化则丢弃过时任务结果。
6. **备份与同步。** 原件是否进入备份／远端同步沿用用户选择和敏感数据策略；版本化 manifest 记录“含原件／仅文本”，恢复后可验证 hash 和引用。不能把以前仅同步文本的账户自动升级为上传原件。

### 8.2 失败状态与恢复动作

| 故障点                                     | 必须保留的状态                                                     | 恢复行为                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| admission 拒绝／密码／损坏文件             | 原因、范围、是否可用原件；不创建假成功文档                         | 提示换文件、解密或调整被允许的 profile；不无限重试                                                        |
| 原件落库后 crash                           | 未提交引用可识别，已有 source 不受影响                             | 恢复继续提交或回收 staging；GC 不能删活跃／已提交引用                                                     |
| OCR 部分页失败／配额耗尽                   | 已成功页、失败页列表、provider request identity                    | 明确选择部分结果或有界重试失败页；不自动发往另一云 provider                                               |
| 解析完成但 revision 已变                   | 新旧 source revision 和任务身份                                    | 拒绝过期结果；新 revision 重新调度，旧有效 generation 继续服务                                            |
| generation 提交时失败                      | 原指针、候选 snapshot／chunks 的归属                               | 回滚未提交候选；恢复后去重／清理，不出现半新半旧索引                                                      |
| writer 失败／字体或资产缺失                | typed render error、ExportPlan、loss report                        | 修复依赖或选择明确支持的格式；不创建零字节“成功文件”                                                      |
| 用户取消／save 失败                        | cancelled 与 save error、目标名称／重试状态                        | 取消无错误提示；失败可显式重试，避免重复下载或覆盖不同内容                                                |
| 已交给 OS／浏览器，但 durable ack 前 crash | 导出 artifact hash、attempt、handoff 记录；交付为 delivery-unknown | 不自动重新保存／下载；原生目标可在权限内核对实际文件 hash，浏览器无法核对时告知不确定并由用户选择重新下载 |

对临时网络错误建议最多 2 次带退避重试；本地输入错误不重试；所有重试受总 deadline／成本限额控制。远程服务未提供幂等性时不能保证不重复计费，应展示任务状态并禁止后台无限重发。

数据库事务不能包住 OS 写文件或浏览器下载。持久化任务须先记录交付 attempt／意图，再调用 shell adapter，并在可观察结果返回后记 ack；两个边界之间中断时保留不确定性，不伪造 exactly-once。用户明确重新交付视为新的 attempt，采用唯一名称或明确覆盖选择。此规则同时覆盖“记录意图但尚未调用”与“已交付但未记 ack”的不可区分窗口。

### 8.3 安全与审计信号

防护覆盖解压读取、XML 外部实体、展开 cell／page／pixel、字体／图片解码、远程资源和导出 HTML。外链默认保留为链接，不自动抓取；允许下载时必须经过已有网络／权限策略，限制 scheme、redirect、大小及 timeout。模板／主题仅接受已定义字段，不执行任意脚本或把用户输入拼接进 style。

记录匿名化 task ID、格式／字节量、reader 版本、phase timings、limit rejection、quality／loss codes、cancel latency、save outcome 和 retry 次数。日志不含文档正文、原始图片、PII、访问凭据或未经许可的完整路径。解析结构质量与导出／交付质量使用独立面板，不能用“导出函数成功率”遮蔽内容损失。

建议指标名为 `document_parse_duration_ms`、`document_parse_result_total`、`document_limit_rejection_total`、`document_loss_total`、`document_cancel_latency_ms`、`document_save_result_total`；ING 拥有 parse／budget，EXPORT 拥有 loss／save。标签仅使用有界 format、stage、shell、provider class、result code，不将 source ID、文件名、用户文本或任意版本串作为指标标签；受控本地 trace 中的 task ID 仅用于关联。S0 记录新增字体／worker 的压缩包体积、冷启动、存储增长及 provider 每页／任务费用，S2／S4／S5 对照批准的预算验收；无 provider 定价或账号数据时标记未测，不能报告零成本。

任一静默损失、跨 owner 命中或原件丢失立即告警并停用对应新任务；取消超过 1 秒或性能超出第 7 节预算触发 Release 复核并停止扩大启用范围。任务终止和隔离进程清理有测试，不能遗留 detached work 阻塞测试或退出。

## 9. 工作拆分、决策与评审

### 9.1 建议 PR 边界与责任

| 工作包                                     | 主责                                     | 依赖与评审                                                     |
| ------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------- |
| W0 baseline、fixtures、acceptance matrix   | QA                                       | S0；各模块确认 oracle，保持坏样本与产物可复查                  |
| W1 route／numeric／ODS／PPTX               | ING                                      | S1；F2–F6 可拆小 PR，共享 processor 改动集中一个 owner         |
| W2 原件引用与 Twin loader／OCR             | DATA＋ING，DATA 主责存储提交             | S1；引用分类／GC／备份、generation、PII 边界共同评审           |
| W3 admission／预算／worker                 | ING                                      | S1；Host／UI／插件分别确认运行时接线，不能只交付未调用工具函数 |
| W4 Unicode／code／resolver／outcome／theme | EXPORT                                   | S2；UI、static-export、i18n、真实 shell 共同验收               |
| W5 DOCX／core richer writer                | OFFICE；core writer 由 EXPORT 子任务负责 | S3；schema 与 loss contract 先稳定，comment／native 元素检查   |
| W6 XLSX styles 与 PPTX runs                | OFFICE                                   | S3；两个独立 serializer PR，统一损失字段和版本策略             |
| W7 envelope／layout／quality UX            | ING                                      | S4；DATA、UI、OCR provider／PII、retrieval locator 联合评审    |
| W8 templates／references／offline assets   | EXPORT                                   | S5；复用模板 service，检查 disclosure 与外部资源策略           |
| W9 durable tasks／recovery／performance    | ING                                      | S5；复用当前 worker／job 实现，DATA／Host 评审恢复与资源边界   |
| W10 real clients／migration／release       | QA／Release                              | S6；每个验收矩阵行关联构建、平台、产物与结果                   |

实施前由团队把角色映射到具体 owner 和排期。当前没有人力／设备／客户样本信息，因此不提供虚构工期；关键路径是 W0 → W2/W3 → W7 → W9 → W10，输出线 W4 → W5/W6 → W8 与其并行。任何 PR 都不能为了缩短路径省略自己阶段的行为验收。

新文档是审计后的独立实施方案，不能把尚未执行的设计写成审计事实。实施时优先扩展表中现有模块；只有 owner 适配层、可终止执行边界或缺失的端到端 spec 确实没有合适归属时新建文件，并在 PR 解释原因。

### 9.2 可直接采用的建议与仍需确认的产品选择

| 选择                   | 建议默认值                                                         | 何时需要重开／责任                                                    |
| ---------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 是否换文档引擎         | 先修现有链路，新增 adapter 以同一 corpus 的收益为依据              | S4 本地复杂版面指标不达标时，由 ING 提供同条件质量／性能／成本对比    |
| 原件保留               | 新来源默认在现有数据域保留，可按用户策略删除；显示容量与重处理影响 | S0 DATA／产品确认保留期、配额和同步行为；未确认前不自动扩大云同步范围 |
| OCR 上云               | 默认本地／当前已选 provider；不得因低质量自动增加云上传            | S4 产品／隐私 owner 确认 profile；不阻塞本地路径修复                  |
| 导出损失               | 支持子集精确保留；破坏性损失需现有确认流程，提供原件／只读替代     | S3 OFFICE／EXPORT 固定 loss 等级和未知 feature 策略                   |
| 主要 workload          | 中英文知识摄取＋常见 Office；复杂数学／合规 PDF 作为独立 profile   | S0 产品／QA 用真实需求调整 corpus；更改必须版本化并保留旧指标         |
| 原生平台与 Office 环境 | 支持矩阵中声明的平台逐个验收；无环境的能力不默认启用               | S0 Release 列出设备／账号缺口，S6 清零阻塞或明确限制发布范围          |

这些选择不阻碍修复明显错误，也不代表用户已经批准新增云服务、费用或外部发布。实施授权和外部账号／资源权限在执行对应动作时依据会话与项目规则确定。

### 9.3 备选方案与取舍

- **只加格式或再接一个 parser：不采纳作为主方案。** 不能修复 stage 丢原件、错误保存状态、消费者舍入及 loss validator；新 parser 同样可能被错误调用。
- **全面换成 Docling／Pandoc／Office 引擎：暂不采纳。** 先用 corpus 证明收益，并测静态 Web、移动端、安装体积、许可、离线与 Host 部署成本；必要时作为受控 adapter，保留现有契约。
- **只把所有输出改成 Markdown：不采纳。** 无法履行 typed cells、comment anchor、mixed runs、公式与原生可编辑导出的要求。
- **复制 Blob／job／template 系统：不采纳。** 会造成删除、权限、备份及恢复语义分叉；优先扩展已存在的 owner adapter 和生命周期。
- **所有格式都承诺无损：不采纳。** 明确支持子集、结构化 LossReport、原件保留和实际客户端验证更可验收。

## 10. 高阶 PDF 与专门领域功能

这些不属于 15 项缺陷，也不是六项通用实践的强制前置。建议在 S0 明确是否纳入所选产品 profile；若纳入，就成为该 profile 的发布门槛，不能宣传后留空。

| 工作包                   | 范围／依赖                                                                              | 验收标准与建议                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| E1 无障碍与归档 PDF      | S3/S5 后；生成带阅读顺序、语义 tags、alt、语言及书签的 PDF；明确 PDF/A／PDF/UA 目标版本 | 使用适用标准验证器及真实辅助阅读工具，保留报告；未通过不能声明合规。建议有归档／无障碍需求时独立排期，不用“嵌入字体”代替认证               |
| E2 安全 redaction 与签名 | 依赖受支持 PDF engine；分别设计不可逆内容移除、签名生成／验证及证书信任策略             | redaction 后原文／图片对象不可检索恢复；签名验证明确算法、证书链／时间及修改状态。当前签名保护不等于密码学验证；无引擎与威胁模型不进入承诺 |
| E3 表单／学术增强        | 复用已有 AcroForm 操作；增加版式表单字段结构、学术公式／引用 styles 和领域词表          | 领域 corpus 的字段／公式／引用精确率、人工复核流程与导出闭环独立达标；现有表单填写和公式编辑不重复开发                                     |

## 11. 本方案验证记录与来源

本轮做的是设计和文档验证，未修改产品代码、未重跑产品测试、未进行真实设备或 Office 验收。原审计的 185 parser tests、103 core export tests 等历史结果只作为 baseline；rich plugin scope 的 76 pass／1 fail 仍需 S0 归因，不能视为当前通过。

独立 reviewer 完成只读审查，确认 F1–F15／G1–G6 无遗漏，提出两项 P2 方案缺口：保存 handoff 与 ack 之间的交付不确定性，以及把分页要求套到不支持的格式。两项均采纳，补充 delivery-unknown／禁止自动重发和逐格式能力表；第二轮仅复核这两项，均通过。未调用外部模型；跨模型复核已作为可选项提供，未收到授权不执行。

结构检查已确认 15 项 finding、6 项 practice gap、7 个阶段均各有独立映射，文内本地 Markdown 链接有效。原审计账本的 X1–X5 保持 open；方案完成不关闭产品风险。

| Heavy proposal 检查面  | 结论与证据范围                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| 目标、事实、范围、取舍 | 通过文档审查；第 1／2／9 节区分观察、建议、产品选择及非目标                                      |
| 架构、契约、接线与平台 | 通过文档审查；第 3／4 节明确 owner、入口、状态、DTO、Host／ACL 与 static-export 边界；未验证实施 |
| 数据、迁移、权限与恢复 | 通过文档审查；第 8 节覆盖引用／GC、双读／回填、旧数据、交付不确定性与删除／备份                  |
| 观测、性能、成本       | 设计覆盖；绝对预算、设备与费用仍是 S0 的显式决策／测量项，不能声称已达标                         |
| UI、移动与可访问性     | 设计覆盖；第 3.4／7.3 节规定状态、键盘／播报、双语及真实环境；没有产品 UI 变更                   |
| 测试、交付与回退       | 通过文档审查；F／G→阶段→证据均可追溯，阶段有进入依赖、退出门槛和停止／回退策略                   |
| 图与来源               | 纯文本责任流已人工检查；没有 Mermaid 渲染项；一手来源和源码落点列于下方                          |

文档验证：`pnpm exec prettier --check` 对本方案和账本通过；`node .agents/skills/evidence-driven-dev/scripts/ledger.mjs check docs/evidence/2026-11-18-document-parsing-export-gap-audit.md --final` 返回 0 errors／0 warnings；结构脚本确认 F／G／阶段数量、退出／回退条款与本地链接。上述命令通过 RTK 执行，仅证明文档检查通过，不代表产品测试通过。

内部依据：`packages/document/src/{types,document-processor}.ts`、`lib/twin/ingest/{stage,parse,persist}.ts`、`lib/knowledge-base/ingest/ingest-source.ts`、`lib/db/{session-assets,message-media,message-media-refs}.ts`、`lib/files/{document-writer,save-export.ts}`、`lib/export/disclosure.ts`、`lib/document-templates/`、四个富文档插件，以及 `tests/e2e/README.md`／Playwright 配置。具体缺陷行号和复现命令见审计报告，避免在方案里复制容易漂移的整份证据。

外部一手来源（2026-11-18 核对；用于设计对照，不代表 Cognia 已达到对应能力）：

- [S1 — DoclingDocument：统一结构、层级和 provenance](https://docling-project.github.io/docling/concepts/docling_document/)。支持第 5 节 G1 的设计。
- [S2 — Unstructured partitioning 与策略](https://docs.unstructured.io/open-source/core-functionality/partitioning)。支持 G2 的格式／策略路由。
- [S3 — Docling confidence scores](https://docling-project.github.io/docling/concepts/confidence_scores/)。支持 G2 的质量表达，同时保留 table confidence 未实现的限制。
- [S4 — Azure Document Intelligence Markdown elements](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/markdown-elements?view=doc-intel-4.0.0)。支持 G3 的复杂表格／caption／footnote 结构。
- [S5 — Pandoc manual](https://pandoc.org/MANUAL.html)。支持 G4 的模型转换、损失边界与 reference document 配置。
- [S6 — Docling advanced options](https://docling-project.github.io/docling/usage/advanced_options/)。支持 G5 的文件／页／像素及解压预算。
- [S7 — OmniDocBench 官方项目](https://github.com/opendatalab/OmniDocBench)。支持 G6 的分任务质量评估；本文未采用未经实测的排名或综合准确率。

[S1]: https://docling-project.github.io/docling/concepts/docling_document/
[S2]: https://docs.unstructured.io/open-source/core-functionality/partitioning
[S3]: https://docling-project.github.io/docling/concepts/confidence_scores/
[S4]: https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/markdown-elements?view=doc-intel-4.0.0
[S5]: https://pandoc.org/MANUAL.html
[S6]: https://docling-project.github.io/docling/usage/advanced_options/
[S7]: https://github.com/opendatalab/OmniDocBench
