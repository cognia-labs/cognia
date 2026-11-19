# Evidence ledger: file management gap audit

- Status: verifying
- Lane: standard
- Created: 2026-11-17
- Updated: 2026-11-17
- Related: ADR-0124, ADR-0200, ADR-0222, ADR-0223; [replay probes](./2026-11-17-file-management-gap-audit.probes.mjs)

<!--
Edit by hand; keep the table shapes, because `ledger.mjs check` parses them.
Status: exploring | building | verifying | closed
Lane:   standard | deep
IDs are unique across the whole file. Depends-on / Risk / From cells take
comma-separated IDs. Use "-" for an empty cell.
-->

## Original request

> 帮我分析一下现在的文件管理的缺口，看看差什么功能，或者存在什么问题，并且对照业内的优秀实践

## Knowledge

<!--
Prefix → kind: O observation · H hypothesis · G goal/outcome · C constraint
· A assumption · Q open question.
State (O/H/A/C): Observed | Hypothesized | Verified | Contested | Unknown | Invalidated
State (G):       Proposed | Agreed | Revised
State (Q):       Open | Answered
Basis: where it comes from + scope + date, e.g. "sidecar log 2026-10-21, macOS only".
-->

| ID  | Statement                                                                                                                | State    | Basis                                                                                                                                      | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| O1  | File management spans the Files library, conversation FileSpace, native workspace files and paired-host RPC.             | Observed | Current source and CLAUDE.md subsystem map, 2026-11-17                                                                                     | -          |
| G1  | Inventory existing capabilities, verify defects and compare useful industry practices.                                   | Agreed   | User request, 2026-11-17                                                                                                                   | -          |
| C1  | Audit only: preserve concurrent changes, use synthetic data, do not change product behavior or publish/share real files. | Verified | Task scope and concurrent-tree-safety, 2026-11-17                                                                                          | -          |
| O2  | Existing capability coverage is substantial; six concrete defects reproduce with synthetic production-module probes.     | Verified | Nine audit probes: six observational assertions pass, three normative FileSpace assertions fail for the intended reason, macOS, 2026-11-17 | O1         |
| O3  | Existing focused tests pass without covering the newly found failures.                                                   | Verified | 19 suites / 227 tests passed through repository Jest entry point, 2026-11-17                                                               | O1         |
| O4  | Browser E2E could not start the app because the plugin artifact ABI gate rejected the development startup.               | Observed | .cache/file-management-gap-audit/browser-e2e.log, 2026-11-17                                                                               | -          |
| Q1  | Which gaps are genuine defects versus intentional ownership/platform boundaries?                                         | Answered | Capability inventory, defects F01-F13, contract risk A01 and gaps G01-G09 below, 2026-11-17                                                | O1, O2     |

## Problem frame

Assess the current checked-out implementation, including uncommitted edits. The deliverable is an evidence-backed audit with capability inventory, ranked reproducible or source-confirmed defects, product gaps and external primary-source comparisons (G1). No implementation, commit or release is authorized by this request (C1). A code-path or synthetic reproduction is sufficient for a scoped finding; actual desktop, paired-device and mobile acceptance require separate evidence.

<!-- One paragraph: the problem we are choosing to solve now, the outcome that
would show it is solved, and what is explicitly out of frame. Cite IDs. -->

## Complexity profile

<!-- Rating: low | medium | high | unknown. "unknown" is a valid answer; say what
would resolve it. Never sum these into a score. -->

| Dimension    | Rating | Why / what would resolve it                                                                                          |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------- |
| scale        | high   | Library, native filesystem, FileSpace, asset persistence and remote access are distinct surfaces.                    |
| technical    | medium | Existing implementation; no new architecture required for audit.                                                     |
| coupling     | high   | Browser, Tauri, Capacitor, host RPC and data lifecycle differ.                                                       |
| requirement  | low    | Analysis is explicit; feature priorities remain recommendations.                                                     |
| verification | high   | Headless tests are available; real native/paired/mobile evidence may be unavailable.                                 |
| risk         | high   | Incorrect conclusions about purge or access could encourage data loss or exposure; audit itself uses synthetic data. |

## Risks

<!-- ID prefix R. Severity: low | medium | high. Source: how the risk was found (catalog,
ADR-NNNN, git history, lens:STRIDE, reviewer, incident memory, …). Claim: the
property the design promises. Refuted by: the observation that would prove the
claim false. -->

| ID  | Risk (impact)                                                          | Severity | Source                                        | Claim                                                                                | Refuted by                                                                               |
| --- | ---------------------------------------------------------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| R1  | Mislabel intentional file ownership or platform boundaries as defects. | medium   | ADR-0200/0222/0223                            | Every reported gap states the applicable ownership and platform.                     | A claimed missing operation already exists or is intentionally held back.                |
| R2  | Miss data loss or unauthorized filesystem actions.                     | high     | Risk catalog; independent native failure hunt | Destructive and access-related claims have owning-source evidence or isolated repro. | An assertion rests only on a UI label or a hypothetical scenario.                        |
| R3  | Treat passing tests as full platform acceptance.                       | high     | Risk catalog; verification reference          | Test result summaries include scope and residual environment limits.                 | Headless tests are presented as real paired/native acceptance.                           |
| R4  | Copy competitor features without relevance or current evidence.        | medium   | External primary-source comparison            | Recommendations map an actual user need to a documented practice.                    | A feature is attributed without official documentation or is unrelated to Cognia's role. |

## Verification obligations

<!-- ID prefix V. Risk: the R id(s) this obligation discharges.
Independence: self | subagent | fresh-reviewer | tool | other-model | human | real-env
Status: planned | passed | failed | blocked | waived
Evidence: command + result excerpt, commit, or artifact path — not "should pass".
Coverage: which conditions the evidence covers (and which it does not). -->

| ID  | Risk   | Method                                                                                 | Independence   | Evidence                                                                                                                                                                                                               | Coverage                                                                                                                                 | Status  |
| --- | ------ | -------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| V1  | R1     | Trace capability, UI entry point and owning writer against ADRs.                       | tool           | ADR-0200/0222/0223 and source inventory below; runtime entry points traced through FilesOps, hooks, RPC and native commands.                                                                                           | Current working tree, including existing uncommitted edits.                                                                              | passed  |
| V2  | R2     | Independent native/security failure hunt and safe focused reproduction where feasible. | fresh-reviewer | Separate bounded frontend/native/FileSpace reviews; F01-F06 have deterministic synthetic evidence; F07-F13 and A01 retain explicit source-only limits.                                                                 | No real files, native deletion, real SFTP or external shares exercised.                                                                  | passed  |
| V3  | R2, R3 | Run relevant existing tests and focused regression probes for selected findings.       | tool           | Existing 19 suites / 227 tests pass. Replay observations: 2 suites / 6 assertions pass documenting defects/limits. Replay regressions: 1 suite / 3 assertions fail, exposing FileSpace collisions; see commands below. | Headless synthetic behavior only; no coverage run. Failed normative probes indicate unresolved defects, not implementation verification. | passed  |
| V4  | R4     | Read official Finder, VS Code and Drive documentation and map to local source.         | tool           | Official search results for Apple, opened VS Code/Google/Microsoft docs; Sources below, checked 2026-11-17.                                                                                                            | Apple full-page fetch returned HTTP 429; tags/Smart Folders comparison uses official search excerpts.                                    | passed  |
| V5  | R3     | Exercise browser Files page with synthetic data if a runnable surface is available.    | real-env       | pnpm test:e2e web/files-library.spec.ts: config.webServer failed before tests, plugin-artifact authoring-kit ABI mismatch.                                                                                             | No browser assertions executed; no native/paired/mobile acceptance established.                                                          | blocked |

## Decisions

<!-- ID prefix D. Based on: only the IDs this decision ASSUMES still hold (if one is
later Invalidated, the decision reopens). Name ruled-out hypotheses in the
Decision text, not here.
Action: implement | spike | diagnose | experiment | harden | escalate | scope-down | stop | ship
Reversal trigger: the new evidence that would reopen this decision. -->

| ID  | Date       | Decision                                                                                                                                                                         | Action   | Based on           | Reversal trigger                                                                 |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ | -------------------------------------------------------------------------------- |
| D1  | 2026-11-17 | Perform read-only Standard-lane discovery; delegate bounded frontend and native audits as the skill permits, and investigate persistence/remote contracts centrally.             | diagnose | G1, C1, O1         | A changed task scope or evidence of a distinct file-management owner.            |
| D2  | 2026-11-17 | Deliver the verified audit and ranked recommendations; keep implementation and actual native/provider acceptance outside this task. Retain the blocked UI obligation explicitly. | diagnose | G1, C1, O2, O3, O4 | Product changes, a successful native/UI reproduction, or a revised product goal. |

## Residual risks

<!-- ID prefix X. From: the R / V / H / M ids this residual comes from.
What is still not known or not verified after this round. No invented
percentages. Status: open | accepted | closed. "accepted" needs the user. -->

| ID  | Residual                                                                                                     | From   | Why still open                                                                                                       | Next action                                                                                                                 | Status |
| --- | ------------------------------------------------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| X1  | Browser visual/E2E acceptance is unavailable for this snapshot.                                              | V5, O4 | Development startup is blocked by an existing plugin-artifact ABI gate; agent-browser CLI is also absent.            | Repair the owning plugin artifact/pin contract, then rerun the existing web Files E2E.                                      | open   |
| X2  | Native failure branches, real SFTP, real paired device, actual sharing and phone behavior remain unverified. | R2, R3 | Source evidence and stubs cannot establish OS/provider/device acceptance.                                            | Reproduce the specified cases with temporary native workspaces and dedicated test providers/devices before accepting fixes. | open   |
| X3  | Scale/performance, crash windows and adversarial concurrent operations were not measured comprehensively.    | R2, R3 | Audit found structural scaling limits but did not run large-directory, low-memory, multi-device or crash benchmarks. | Use the workload matrix below when choosing implementation priorities.                                                      | open   |
| X4  | Working-tree findings can drift as concurrent sessions change owning code.                                   | O1     | Shared checkout contains extensive pre-existing changes; this audit is not a release snapshot.                       | Recheck each cited owner before implementing or filing a release-blocking defect.                                           | open   |

## Outcome

<!-- ID prefix M. Signals that the ORIGINAL problem improved (validation, not verification).
Status: pending | met | not-met | not-measurable -->

| ID  | Signal                                                                                                                    | How / when measured                        | Result                                                                                                                                                                                       | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | The user receives a ranked audit with source evidence, reproduction status, current capabilities and industry comparison. | Audit artifact and final reply, 2026-11-17 | Capability inventory, six reproduced defects, seven source-confirmed issues, one separate API contract risk, nine capability gaps, official comparisons and validation plan delivered below. | met    |

## 审计结论

当前文件管理已经具备完整的基础操作。主要缺口集中在**文件身份与内容完整性、失败和截断是否可见、不同终端的操作一致性，以及大文件操作的恢复能力**。优先修复这些问题，比继续增加零散菜单更有价值。

本轮检查的是 2026-11-17 当前工作区，包含已有未提交修改。没有修改产品代码，没有提交、推送、创建真实分享或操作用户文件。本文和可重放探针是本任务新增的审计材料。

证据分级：

- **已复现**：通过真实生产函数或 hook，使用合成数据/transport stub 重现；不等于真实设备或服务验收。
- **源码确认**：拥有实现和调用链存在明确问题，尚未运行原生故障场景。
- **能力缺口**：目前缺少完整产品路径，未将其当成 bug。
- **合同风险**：危险 API 参数路径成立，但尚未找到普通 UI 的触发方式。

优先级：P1 表示可能产生错误文件、静默内容损失或明显资源/数据风险，建议先修；P2 表示可靠性、可操作性和信息准确性问题。未发现足以据此宣称生产事故或 P0 的证据。

## 已有能力与边界

| 表面                       | 已有能力                                                                                                                                                                                             | 所有权与边界                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 全局 Files library         | 聚合 Canvas、Artifact、图片、上传文件、视频和 Agent workspace 文件；places × lenses；格式/时间/大小/workspace 过滤；收藏、最近、文件夹、重命名、复制、模板、预览、聊天引用、批量操作、ZIP 和链接分享 | 是聚合与保留层。Files 自己拥有的上传与来自会话/磁盘的引用，删除和重命名语义不同。见 `lib/files-library/ops.ts`、`rename.ts`、`trash.ts`。 |
| 生命周期                   | Trash、恢复、删除确认、撤销移入 Trash、30 天清理任务、引用 pin 与媒体 GC                                                                                                                             | Files 永久删除不会直接删除 workspace 磁盘文件；仍由其他会话持有的内容也不应被 Files 销毁。                                                |
| 会话 FileSpace             | disk mounts、uploads、artifacts、复制链接、深链、快照分享、live grants 的 UI 接入                                                                                                                    | `/uploads`、`/artifacts` 是派生只读视图；磁盘编辑进入 workspace editor。见 ADR-0222。                                                     |
| Workspace editor/native FS | 文件树、创建/重命名/移动/删除/复制、文件搜索、内容搜索、watch；checked save、SHA-256 前置条件、dirty draft、冲突反馈                                                                                 | 原生删除是永久删除，不等于 Files Trash。写入已有并发保护，不能笼统说“没有保存冲突检测”。                                                  |
| Browser / paired / mobile  | 普通 Web 管理本地 library；paired 客户端管理 Host library；专门的移动列表、选择、抽屉与刷新路径                                                                                                      | 普通 Web 不读取本机 workspace。paired 传输 10 MiB 上限、新建文档和分享 held-back、离线不排队重放写操作，均为 ADR-0223 的明确选择。        |
| 预览与 SFTP                | viewer registry、懒加载、Markdown/HTML/JSON 的 filesystem rich preview；HTML CSP；SFTP 文件浏览与持久传输队列、暂停/取消/重试、上传恢复                                                              | 本轮未验收真实 SFTP、分享后端或原生窗口。不同来源的预览支持不同，不应由某个 viewer 推断所有来源均已支持。                                 |

## 六项已复现问题

### F01 · P1 · paired 下载可能成功返回被截断的文档

- 定位：`lib/files-library/remote/types.ts:178` 设置 `FILES_REMOTE_TEXT_MAX = 128 * 1024`；`remote/host-dispatch.ts:293` 的 `get` 截断并返回 `textTruncated`；`remote/remote-ops.ts:76` 的 `documentText` 忽略该标记，`payloadFor:110` 将文本直接导出。
- 触发：通过 paired 设备下载超过 131,072 个 JavaScript 字符的 Canvas/Artifact。
- 实测：合成 ASCII 原文 131,089 bytes，成功生成的下载 Blob 只有 131,072 bytes，无拒绝或不完整状态。
- 影响：下载/ZIP 的文档尾部丢失；同一读取助手也用于只读预览和 Use in chat。这里的文本 cap 与 10 MiB 二进制传输上限是两回事。
- 建议验收：完整内容使用分块或独立下载合同；暂不支持完整读取时，下载和聊天引用应明确拒绝，预览应明确显示截断。

### F02 · P1 · workspace 分块读取可拼出不存在的混合版本

- 定位：`lib/files-library/remote/client.ts:392` 仅检查各块的 `size` 是否改变；`workspace-files-io.ts:223` 的本地整文件组装甚至不比较每块版本。`crates/cognia-files/src/files.rs:1287` 每次按路径打开一片。
- 触发：读取进行到一半，文件被另一个进程或 Agent 替换，替换前后大小相同。
- 实测：第一片来自 `AAAA`，第二片来自等长的 `BBBB`，实际返回 `AABB`，无重试或错误。
- 影响：下载或传给聊天的内容既不是旧版也不是新版。探针证明客户端接受混合块；未执行真实磁盘并发复现。
- 建议验收：整个传输绑定稳定版本/句柄，必要时带版本 token 和完整 hash；变化时重新读取或报告冲突。仅比较大小不足以满足该要求。

### F03 · P1 · FileSpace 同名消歧会生成相同地址，链接可能打开另一份文件

- 定位：`lib/filespace/sources.ts:50` 截取 sourceId 前 8 字符；`assignNames:58` 不对生成后的路径再次查重；`findDexieEntry:151` 取第一个匹配项。
- 触发 A：两个 `report.pdf` 的 ID 是 `asset-ab111…`、`asset-ab222…`。当前 upload ID 本身使用 `asset-` 前缀，因此这两个 ID 都截成 `asset-ab`，地址都成为 `/uploads/report~asset-ab.pdf`。
- 触发 B：消歧得到的 `report~abcdefgh.pdf` 与真实存在的同名文件碰撞。
- 实测：唯一地址数分别为 `1 / 2`、`2 / 3`；第二个条目的地址解析回第一个条目的 ID。三条正常期望的断言均失败，原因吻合。
- 建议验收：稳定 ID 与可读名称分离；最终路径集合始终唯一；复制的地址必须解析回原条目。保留旧链接兼容规则，避免简单更名导致历史链接失效。

### F04 · P2 · 键盘翻过第 60 个条目会选中未渲染的文件

- 定位：`hooks/files-library/use-files-page.ts:86` 对完整结果建立 selection，`:99` 只渲染前 60 个；`use-files-keyboard.ts:83` 先改变 selection/preview，再尝试寻找 DOM 节点。
- 实测：61 个条目，从第 60 项按 ArrowDown，selection 和 preview 转到第 61 项，但该项没有 DOM，焦点仍停留在第 60 项。
- 影响：用户可见焦点与实际选中目标不一致。后续 Delete 按 selection 行动，可能针对看不见的文件；本轮没有实际删除任何文件。
- 建议验收：跨页先加载/滚动目标，再同步焦点与 selection；删除前的目标必须和可见选择一致。

### F05 · P2 · paired 正文搜索不会随列表刷新而更新

- 定位：`hooks/files-library/use-remote-files-backend.ts:110` 的搜索 effect 依赖只有 `[client, search]`。
- 实测：同一查询下刷新列表，条目由 `a` 变为 `new`，正文匹配仍是 `{a}`，Host search 调用次数仍为 1。
- 影响：上传/修改文件、手动刷新或增大图片加载窗口后，同一查询可能漏掉新增匹配项。
- 建议验收：正文命中与同一 library revision/image window 绑定，刷新后重新检索并抛弃过期答案。

### F06 · P2 · 正文搜索失败被当成没有命中

- 定位：同一 hook `:120` 捕获异常后写入空命中集合，没有设置公开的错误状态。
- 实测：Host 正文搜索拒绝，`contentMatches` 为空且 `source.error === undefined`。
- 影响：实际只有标题搜索成功时，用户仍可能看到“无结果”，无法区分文件不存在与正文检索失败。
- 建议验收：显示正文搜索失败/结果不完整与重试入口；不能把失败转换成权威的空结果。

## 七项源码确认问题

| ID / 优先级 | 问题与触发                                                     | 定位、影响和验收方向                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F07 · P1    | 目录递归复制没有拒绝目标位于源目录之下，例如 `src → src/child` | `crates/cognia-files/src/files.rs:2014,2063` 先创建目标再枚举源，会继续进入刚创建的子目录，直到 OS 限制或错误并留下部分结果。workflow `lib/workflow/nodes/files/index.ts:372` 可调用。应在创建任何目标前拒绝相同目录/后代目录。未运行该资源放大场景。                                                |
| F08 · P2    | 复制遇到嵌套 symlink 会跳过，却返回完整成功                    | 同文件 `:2072`，workflow `:386` 返回 `copied:true`。跳过链接是刻意安全策略；问题是没有 skipped 明细/部分成功语义。应明确哪些内容未复制，失败后如何处置半成品。                                                                                                                                       |
| F09 · P2    | 文本预览的 `maxBytes` 只限制返回内容，不限制读盘/内存          | 同文件 `:1173` 先 `read_to_end`、整文件 SHA 与 UTF-8 解码，再截断。小预览可能分配整个大文件。普通 editor 的 stat 可减轻风险，但不能保护所有调用或 stat 后增长；未测内存峰值。应明确 bounded preview 与 full version hash 的开销合同。                                                                |
| F10 · P2    | 本地 watcher 注册失败后静默丢失刷新能力                        | `lib/files/workspace-watch.ts:55` 将注册失败变成 false；`components/editor/project/use-project-editor.ts:1452` 又跳过本地 desktop polling。OS watch 资源不足等场景下外部更改可能不刷新。应暴露降级状态并启用合适的 fallback。checked save 已存在，不能据此声称所有保存都会覆盖。                     |
| F11 · P2    | workspace 搜索缓存没有 Host 身份                               | `lib/files/workspace-search.ts:28,64` 仅以 root/query/limit 作键，30 秒内命中不访问 transport。切换到相同路径的另一 Host 可显示上一个 Host 的文件名。应绑定 Host/transport generation，并在切换时失效；未做真实 Host 切换。                                                                          |
| F12 · P2    | 目录枚举中的错误被转换为成功的空/部分列表                      | `crates/cognia-files/src/files.rs:1529` 的 `walker.flatten()` 丢弃遍历错误，metadata 错误也退为默认值，最后 `Ok(out)`。权限/I/O 故障可能伪装成目录无内容；应区分空、未完整读取和失败。未注入原生权限故障。                                                                                           |
| F13 · P2    | SFTP 下载暂停/崩溃后的续传只保留进度，没有保留对应字节         | `lib/sftp/transfer-queue.ts:260` 只持久化 transferred/size，received 在整个下载结束后才保存；`lib/sftp/client.ts:312` 的块在函数局部内存，暂停抛错后丢失。恢复依赖 row.received，正常暂停后实际从零开始。应持久化已收块/临时文件与版本。仅针对下载；上传已按 Host write head 恢复。未连接真实 SFTP。 |

## 单独列出的 API 合同风险

**A01 · P1 待原生复现：workspace root 删除保护只拒绝空字符串。**

`crates/cognia-files/src/files.rs:1954` 只检查 `rel_path.trim().is_empty()`，而 `resolve_workspace_target:809` 允许 canonical target 等于 root。直接 API 将绝对 root 当作 relPath，可进入 `remove_dir_all(root)`；paired 转发在 `crates/cognia-companion-rpc/src/rpc/filesystem.rs:1683`。尚未找到正常 UI 的触发入口，也未执行删除探测，因此不把它计入六项已复现问题。

验收应以解析后的目标身份判断“不能删除 root”，覆盖空路径、`.`、规范化别名和绝对路径，并在独立临时 workspace 运行。仅检查原始字符串不足以证明该不变量。

## 九项产品能力缺口

| ID  | 当前缺口                                                | 建议与边界                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G01 | Files 正文检索只是 bounded excerpt，不是完整文档搜索    | `aggregate.ts:43,163` haystack 上限 20,000 字符；尾部唯一关键词探针漏检。paired search 另有 200 hits 上限且没有截断标记。先显示检索范围/未索引状态，再做分段全文索引、命中片段和定位。原生 workspace content search 是另一条已存在的路径。                                                    |
| G02 | 文件夹移动缺少键盘和移动端入口                          | `files-dnd.tsx:88,120` 只有 pointer DnD；`files-folder-menu.tsx:33` 无 Move；移动布局不挂 DnD。复用已有 moveFolder 增加菜单/选择目标路径，不能仅有底层 API。                                                                                                                                  |
| G03 | Files 缺少统一传输任务中心                              | `use-files-actions.ts:404` 串行上传加 loading toast；没有每文件进度、取消、恢复/重试的完整 UI。paired 底层已有分块和进度回调，SFTP 也已有队列，应复用并明确哪些状态可靠。                                                                                                                     |
| G04 | 导入目录没有重建逻辑文件夹层次                          | `lib/chat/drop-entries.ts:76,113` 把目录路径放进文件名；`files-drop-zone.tsx:74` 将所有文件交给当前 folder。应提供保留目录结构的导入和冲突预检，避免只把斜杠替换为安全文件名。                                                                                                                |
| G05 | 网格和移动列表没有完整排序控件                          | `files-list-table.tsx:113` 有列头排序；`files-toolbar.tsx:24` 和 mobile header 没有对应入口，但持久偏好仍影响排列。建议跨布局复用 sort 菜单并显示当前规则。                                                                                                                                   |
| G06 | 标签、保存搜索/智能集合缺少统一入口和模型               | Files 支持单一 folder、favorites 和固定 lenses；当前 FilesEntry/preferences 无通用 tags 或 saved-query 集合。先支持用户多标签与保存筛选，不必立即自动分类或复制内容。                                                                                                                         |
| G07 | Files 缺少统一版本/操作历史入口，workspace 删除恢复薄弱 | Artifact/Canvas 已有版本功能（`stores/artifact/artifact-store.ts:856,893`、`components/canvas/version-history-panel.tsx`），不可重复建设。应在 Files 链到对应历史，补足上传/磁盘来源的变更记录与恢复策略。不要把 library Trash 当作磁盘备份。                                                 |
| G08 | 分享状态可见，但缺少统一的逐文件访问解释                | `FilesEntry.sharedLinks` 与 `share.ts` 已有标记、组织策略/会话授权检查，FileSpace 已有 live grants。缺口是从一个文件解释所有有效分享入口、谁可访问、快照还是实时内容、何时失效/如何撤回的统一路径；不宜直接再建第二套 ACL。                                                                   |
| G09 | 大型 library/目录缺少端到端的分页、完整性和负载合同     | `sources.ts:298` 仍聚合全量 session assets、library items 等；remote Host 每次分页重建全量 aggregate/revision；`fs_list_workspace_dir` 无 cursor，workspace filename search 上限 200 且无 continuation。先定义基准、busy/truncated/partial 状态与增量合同；这些是结构风险，未实测“已经很慢”。 |

## 行业实践对照

下表是针对 Cognia 现有角色的建议，不是竞品功能越多越好的评分。外部事实均采用官方来源；产品选择属于本次审计推论。

| 参照                       | 官方实践                                                                                 | Cognia 对应的实际改进                                                                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Finder                     | 多标签和按规则自动更新的 Smart Folders；预览与列表组织                                   | 现有 folders/favorites/lenses 可以保留，增加跨 folder 标签与保存筛选（G06），优先解决目录导入和排序的一致性（G04/G05）。[Apple 官方说明](https://support.apple.com/guide/mac-help/organize-your-files-in-the-finder-mchle9f0a1b2/mac)                                                            |
| VS Code                    | Explorer 的键盘导航/过滤；Timeline 汇合 Git 与本地保存，支持比较和恢复                   | 修复焦点/分页和 folder Move 可达性（F04/G02）；在 Files 聚合已有 Artifact/Canvas 历史，再补 workspace 恢复（G07），不必复刻整个 IDE。[VS Code 官方说明](https://code.visualstudio.com/docs/editing/getting-started/userinterface)                                                                |
| Google Drive：查找         | 文件类型、人员、修改时间的组合筛选；高级查询与内容查找                                   | Cognia 已有部分筛选，重点是让用户知道正文检索失败、范围有限、结果截断，再扩展全文和保存查询（F05/F06/G01）。[Drive 官方搜索说明](https://support.google.com/drive/answer/2375114?co=GENIE.Platform%3DDesktop&hl=en)                                                                              |
| Google Drive：历史/权限    | 可查看 rename/move/share 等活动，管理旧版本；集中解释 Viewer/Commenter/Editor 和撤回访问 | 做来源感知的版本/活动入口和统一访问解释（G07/G08），沿用 Cognia 现有快照/live grant/组织授权模型。[活动与版本](https://support.google.com/drive/answer/2409045?co=GENIE.Platform%3DDesktop&hl=en)、[管理访问](https://support.google.com/drive/answer/7166529?co=GENIE.Platform%3DDesktop&hl=en) |
| OneDrive / Microsoft Graph | 上传 session、分块恢复、显式提交、名称冲突策略和 ETag 前置条件                           | 先保证传输不静默丢内容，版本变化可识别，失败可恢复（F01/F02/F13/G03）；10 MiB 上限目前是设计边界，是否提高应由使用场景和资源预算决定。[Microsoft 官方合同](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)                                        |

## 建议实施顺序与验收条件

| 顺序 | 工作包                                                              | 完成时必须证明                                                                                                                         |
| ---- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 文件身份和数据完整性：F01/F02/F03/F07，加 A01 的安全临时目录复现    | 大文档下载/引用完整或明确拒绝；任何条目链接都能回到自己；同大小文件替换被识别；目录不能复制进自己；root 不能通过别名被删除。           |
| 2    | 让失败、范围和选择准确：F04/F05/F06/F08/F10/F11/F12，G01 的状态表达 | 焦点与删除目标一致；当前 revision 的搜索结果可刷新；搜索/目录读取失败可区分于空；部分复制有明细；watch 降级、Host 切换不留下误导状态。 |
| 3    | 日常效率与恢复：F13、G02/G03/G04/G05/G07                            | 键盘/手机可移动文件夹；导入目录结构可保留；传输能取消重试且续传字节真实存在；历史入口复用已有版本系统。                                |
| 4    | 规模化与知识组织：G06/G08/G09，以及预览类型扩展                     | 以明确数据量和目标设备测延迟/内存/可操作性；访问解释完整；标签/保存查询解决实际查找任务。                                              |

暂不建议先做多栏文件管理器、完整云盘同步、为每种来源重建编辑器，或只加 AI 自动整理。当前的首要问题有明确的完整性和失败语义证据，扩张范围不会自动解决这些问题。

建议后续验收矩阵：Web/本地 Tauri/paired browser/paired phone；1、61、501、10,000 个条目；空、131,072 字符前后、10 MiB 前后、大型目录；同名文件、目录套入自身、同大小替换、Host 切换、网络中断、watch 注册失败、暂停/重启恢复、磁盘权限错误。具体性能目标需要根据用户的真实工作负载确定，本轮未杜撰延迟或吞吐数字。

## 实际验证记录

现有 scoped tests 均通过：

| 范围                                                                     | suites | tests | 结果                                                |
| ------------------------------------------------------------------------ | ------ | ----- | --------------------------------------------------- |
| aggregate / trash / share / remote client / remote ops / library folders | 6      | 76    | passed                                              |
| workspace FS / watcher / workspace-file I/O / workspace search           | 4      | 69    | passed                                              |
| Files keyboard / page / remote backend / folder menu                     | 4      | 32    | passed；已有 remote hook 测试出现 React act warning |
| FileSpace sources / open、viewer loader / registry、SFTP queue           | 5      | 50    | passed                                              |
| 合计                                                                     | 19     | 227   | 现有测试通过不代表上述缺陷已修复                    |

执行均经仓库 `pnpm test` 入口，额外使用 `--config.verifyDepsBeforeRun=false` 防止 pnpm 11 自动安装。最初直接执行时，在 Jest 前的 postinstall 因 `@cognia/agent-config-types/agent-capability-grant` 和 `/agent-composition` 的 TS/compiled export 解析检查失败，未执行任何测试；没有修改包配置来掩盖该失败。

可重放的隔离探针：

```sh
# 6 个观察用例：确认 F01/F02/F04/F05/F06 和 G01 的当前表现
rtk proxy node docs/evidence/2026-11-17-file-management-gap-audit.probes.mjs observations

# 3 个正确性断言：当前应失败，分别揭示 F03 的地址唯一性和解析问题
rtk proxy node docs/evidence/2026-11-17-file-management-gap-audit.probes.mjs regressions
```

探针调用实际生产模块和 hook，只 mock transport/数据边界，文件生成到 `.cache/file-management-gap-audit/`，不修改根 Jest 配置和产品代码。观察组 2 suites / 6 tests passed；FileSpace 正确性组 1 suite / 3 tests failed，均为已说明的缺陷。原始日志位于同目录 `replay-observations.log`、`replay-regressions.log`，native 现有测试日志为 `native-tests.log`。

浏览器验证尝试：

```sh
rtk proxy pnpm --config.verifyDepsBeforeRun=false test:e2e \
  tests/e2e/web/files-library.spec.ts --project=chromium --workers=1 \
  --reporter=list --output=.cache/file-management-gap-audit/playwright
```

结果：`config.webServer` 启动失败，报错 `Plugin artifact contract: Host authoring kit ABI; regenerate and validate the kit before updating its pin mismatch`；浏览器测试未执行。该失败来自共享工作区的启动前置条件，不是文件管理功能已失败的证据。没有绕过这项产品构建 gate。

未运行全仓 lint/typecheck/build、coverage、真实 Tauri/手机/paired Host/SFTP/外部分享验收；本任务没有产品修改。新增材料的 Prettier、探针 ESLint、`node --check` 和 `ledger --final` 均通过（ledger 0 errors / 0 warnings）。ledger 保持 `verifying` 是为了携带真实环境残余项，不表示审计结论已修复了功能。

## Sources

- 本地实现：上述 owning paths；ADR-0124/0200/0222/0223。没有将 ADR 中的意图直接当成运行验证。
- [Apple — Organize your files in the Finder](https://support.apple.com/guide/mac-help/organize-your-files-in-the-finder-mchle9f0a1b2/mac)：使用官方搜索摘要；正文抓取 HTTP 429。
- [VS Code — User interface / Explorer / Timeline](https://code.visualstudio.com/docs/editing/getting-started/userinterface)：已读取正文。
- [Google Drive — Search for files](https://support.google.com/drive/answer/2375114?co=GENIE.Platform%3DDesktop&hl=en)：已读取正文。
- [Google Drive — Check activity & file versions](https://support.google.com/drive/answer/2409045?co=GENIE.Platform%3DDesktop&hl=en)：已读取正文。
- [Google Drive — Share and manage access](https://support.google.com/drive/answer/7166529?co=GENIE.Platform%3DDesktop&hl=en)：已读取正文。
- [Microsoft Graph — driveItem: createUploadSession](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)：已读取正文。
