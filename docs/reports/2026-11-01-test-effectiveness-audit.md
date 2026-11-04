# Cognia 测试有效性审计记录

日期：2026-11-01（Asia/Shanghai）。范围：检查与记录，未修复业务或现有测试，未暂存、提交或推送。

本报告合并十轮证据。结论是存在可复现的行为断言缺口，同时也有有效的安全和集成测试。**不能把文件数量、简单 matcher 数量或本次定向 mutation 的存活比例解释成全仓无效测试比例。**

完整结构化记录见 [审计台账](../evidence/2026-11-01-test-effectiveness-audit.json)，包含每项判定、失败摘录、mutation 计划、临时行为检查、源码 hash、运行摘要和原始证据索引。前两轮保留原始报告中的复现命令，未记录精确起止时间；第三轮起自动记录 argv、任务专用环境变量、时间戳和真实进程退出码。

## 运行范围

| 轮次 | 原始基线文件 | 原始基线通过 | 失败 |
| ---- | -----------: | -----------: | ---: |
| 1    |            6 |           49 |    0 |
| 2    |            9 |          126 |    0 |
| 3    |           11 |           55 |    0 |

第四至第十轮含多个运行面，基线分别见对应章节；隔离副本不与 workspace 重复累计。

这些是分轮具名运行，不能当作全量测试健康度。未运行 coverage、完整浏览器 E2E、真实 Tauri/Capacitor、真实 provider 或全仓 Rust 验证。第一轮 Jest 发现 12,217 个文件，静态识别 147,976 个定义；20,693 个简单 matcher、207 个无直接断言、223 个源码字符串检查文件只是筛查信号。

## 已记录问题

优先级建议：先处理固定 Host、备份上传密文、禁止覆盖的文件操作、交互审批实参和异常传播合同；再修补其余参数、类型完整性及 CI 选择缺口。所有条目的修复状态均为“本任务尚未实施”。

| ID                  | 轮次 | 问题                                                 | 证据类型                                                   |
| ------------------- | ---: | ---------------------------------------------------- | ---------------------------------------------------------- |
| [TEA-001](#tea-001) |    1 | QuickAppBuilder 的父级回调失效仍全绿                 | mutation                                                   |
| [TEA-002](#tea-002) |    1 | 创建按钮测试只有 render，没有按钮断言                | mutation_with_effective_lower_layer                        |
| [TEA-003](#tea-003) |    1 | 配额 clamping 测试只验证写死的 50                    | source                                                     |
| [TEA-004](#tea-004) |    1 | 手写数组长度不能检查 union 的完整性                  | compiler_probe                                             |
| [TEA-005](#tea-005) |    1 | 移动通知 E2E 自证 mock 且未检查事件结果              | source_and_helper_probe                                    |
| [TEA-006](#tea-006) |    1 | 工作流节点 E2E 的成功状态没有证明业务副作用          | source_and_call_path                                       |
| [TEA-007](#tea-007) |    1 | 已有强工作流 E2E 被 PR 标签过滤排除                  | runner_discovery                                           |
| [TEA-008](#tea-008) |    1 | 现有 E2E 静态门禁不能判定断言的行为质量              | governance_function_probe                                  |
| [TEA-009](#tea-009) |    1 | E2E 手势等待例外已过复审日期                         | gate_execution                                             |
| [TEA-010](#tea-010) |    2 | 缺失 pinned Host 的异常断言可能完全不执行            | mutation_and_independent_probe                             |
| [TEA-011](#tea-011) |    2 | Memory 回退只检查调用次数，未保留配置来源            | mutation_and_independent_probe                             |
| [TEA-012](#tea-012) |    2 | 名为禁用 Memory 的测试没有禁用输入                   | source                                                     |
| [TEA-013](#tea-013) |    2 | 通知路由检查渠道数量但漏掉标题内容                   | mutation_and_independent_probe                             |
| [TEA-014](#tea-014) |    2 | Canvas rethrow 测试未证明 promise 拒绝               | mutation_and_independent_probe                             |
| [TEA-015](#tea-015) |    3 | WebDAV 上传体被改成明文，两个套件仍全绿              | mutation_and_independent_probe                             |
| [TEA-016](#tea-016) |    3 | CLI 交互审批丢失工具实参仍 7/7 通过                  | mutation_and_independent_probe                             |
| [TEA-017](#tea-017) |    3 | WebDAV 恢复单测漏校解密口令，但真实集成测试有效      | mutation_with_effective_integration                        |
| [TEA-018](#tea-018) |    3 | Web Locks 环境掩盖了备用备份队列回归                 | mutation_and_environment_specific_probe                    |
| [TEA-019](#tea-019) |    4 | Rust 下载目标测试放过 Err 和错误 triple              | isolated_rust_subset_mutation_and_probe                    |
| [TEA-020](#tea-020) |    4 | Sidecar 命令 hook 丢失工具名称仍 10/10 通过          | node_runner_mutation_and_in_memory_probe                   |
| [TEA-021](#tea-021) |    4 | Sidecar native model hook 漏测事件上下文             | node_runner_mutation_and_in_memory_probe                   |
| [TEA-022](#tea-022) |    5 | Rust crash backoff 的窗口断言放过零延迟              | whole_rust_module_mutation_and_probe                       |
| [TEA-023](#tea-023) |    5 | Rust 大输出截断只检查上限和标记，漏查正文            | whole_rust_module_mutation_and_probe                       |
| [TEA-024](#tea-024) |    5 | Sidecar broker 的 request ID 匹配未覆盖并发乱序      | node_runner_mutation_and_in_memory_probe                   |
| [TEA-025](#tea-025) |    6 | Rust legacy offset 分页漏查行内容完整性              | complete_rust_crate_source_copy_mutation_and_probe         |
| [TEA-026](#tea-026) |    6 | Sidecar 工具 middleware 漏查参数和取消上下文转发     | node_runner_mutation_and_independent_context_probe         |
| [TEA-027](#tea-027) |    6 | Sidecar deadline 测试未保护调用方给定的时长          | node_runner_mutation_and_virtual_clock_probe               |
| [TEA-028](#tea-028) |    7 | Rust replay cache 漏测有效期结束前的重放拒绝         | whole_rust_module_mutation_and_boundary_probe              |
| [TEA-029](#tea-029) |    7 | Rust rate limiter 的 Retry-After 仅有下界断言        | whole_rust_module_mutation_and_deterministic_time_probe    |
| [TEA-030](#tea-030) |    7 | Sidecar DNS guard 漏测公私地址混合回答               | node_runner_mutation_and_mixed_dns_probe                   |
| [TEA-031](#tea-031) |    7 | Sidecar IPv6 前缀误判普通域名，原实现可复现          | unmodified_source_behavior_probe                           |
| [TEA-032](#tea-032) |    8 | Rust SSE 未终止帧的容量拒绝没有回归断言              | whole_rust_modules_mutation_and_loopback_http_probe        |
| [TEA-033](#tea-033) |    8 | Rust SSE/NDJSON 跨 chunk 的合法 UTF-8 会损坏         | unmodified_rust_modules_loopback_http_behavior_probe       |
| [TEA-034](#tea-034) |    8 | Sidecar webhook 丢失配置 headers 仍全绿              | node_runner_mutation_and_loopback_http_header_probe        |
| [TEA-035](#tea-035) |    8 | Sidecar webhook 未处理进入前已取消的 signal          | unmodified_source_loopback_http_abort_probe                |
| [TEA-036](#tea-036) |    9 | Rust inbound allowlist 漏测多个配置项的并集          | whole_rust_module_mutation_and_multi_entry_probe           |
| [TEA-037](#tea-037) |    9 | Sidecar OAuth state 格式测试放过常量回归             | node_runner_mutation_and_repeated_generation_probe         |
| [TEA-038](#tea-038) |    9 | Sidecar OAuth expiry 只校验 number，漏掉秒到毫秒换算 | node_runner_mutation_and_fixed_clock_probe                 |
| [TEA-039](#tea-039) |   10 | Rust KDF 的 known-vector 测试自比，未锁定算法和成本  | whole_rust_module_mutation_and_literal_configuration_probe |
| [TEA-040](#tea-040) |   10 | Rust provider 成对更新的原子性承诺缺少并发断言       | whole_rust_module_mutation_and_single_lock_snapshot_probe  |
| [TEA-041](#tea-041) |   10 | Sidecar EXDEV fallback 测试实际只走同文件系统 rename | node_runner_mutation_and_injected_exdev_real_files_probe   |
| [TEA-042](#tea-042) |   10 | Sidecar copy 的 overwrite:false 存在检查后覆盖竞态   | unmodified_source_controlled_io_race_behavior_probe        |
| [TEA-043](#tea-043) |   10 | Sidecar Git repo cache 用例未检查是否重复启动探测    | node_runner_mutation_and_runner_call_count_probe           |

<a id="tea-001"></a>

### TEA-001 · QuickAppBuilder 的父级回调失效仍全绿

onAppSelect 仅被传入，未驱动选择或检查回调。移除三处回调后原套件仍 13/13 通过。

源码/测试：[components/a2ui/quick-app-builder.test.tsx:258](../../components/a2ui/quick-app-builder.test.tsx#L258)。

建议：驱动生成、模板创建或选择路径，并断言父级收到正确 appId。

原始证据：`.cache/test-quality-audit-20261101/drop-app-selection.json`、`.cache/test-quality-audit-20261101/applied-drop-app-selection.log`。

<a id="tea-002"></a>

### TEA-002 · 创建按钮测试只有 render，没有按钮断言

移除生成按钮后父套件仍 13/13 通过；子组件测试 3 条失败，因此这是父级声明过宽，不能认定全局无保护。

源码/测试：[components/a2ui/quick-app-builder.test.tsx:148](../../components/a2ui/quick-app-builder.test.tsx#L148)。

建议：删除重复的空声明或补可访问按钮断言，同时保留已有子组件行为测试。

原始证据：`.cache/test-quality-audit-20261101/drop-generate-button.json`、`.cache/test-quality-audit-20261101/child-baseline.json`。

<a id="tea-003"></a>

### TEA-003 · 配额 clamping 测试只验证写死的 50

测试构造 usagePercent: 50 后检查 0～100，没有调用实际配额计算或截断逻辑。

源码/测试：[lib/storage/types.test.ts:55](../../lib/storage/types.test.ts#L55)。

建议：把 clamping 合同放到真实计算函数，输入负数、超限值和零 quota。

原始证据：`.cache/test-quality-audit-20261101/baseline.json`。

<a id="tea-004"></a>

### TEA-004 · 手写数组长度不能检查 union 的完整性

StorageCategory[] 允许 union 扩展而数组不变；隔离副本新增类别后，原测试仍通过实际根编译器检查。

源码/测试：[lib/storage/types.test.ts:18](../../lib/storage/types.test.ts#L18)。

建议：使用 exhaustive Record 或精确类型集合检查；保留真正有效的编译期合同。

原始证据：`.cache/test-quality-audit-20261101/type-widening.log`、`.cache/test-quality-audit-20261101/type-widening/types.ts`、`.cache/test-quality-audit-20261101/type-widening/types.test.ts`。

<a id="tea-005"></a>

### TEA-005 · 移动通知 E2E 自证 mock 且未检查事件结果

先注入 ID 42 再从 mock 读取；第二条只发事件。未挂载应用、没有监听器或监听器同步抛错时 helper 仍完成。

源码/测试：[tests/e2e/mobile/local-notifications.spec.ts:19](../../tests/e2e/mobile/local-notifications.spec.ts#L19)。

建议：从产品入口安排通知，检查真实产品路由或状态；明确 mock 事件投递失败的可观察信号。

原始证据：`.cache/test-quality-audit-20261101/notification-helper-probe.json`。

<a id="tea-006"></a>

### TEA-006 · 工作流节点 E2E 的成功状态没有证明业务副作用

名为创建角色、发送任务、分类或循环的部分测试只读取最新 run 的 succeeded；helper 不检查角色行、出站 payload、分类值或循环次数。

源码/测试：[tests/e2e/workflows/nodes/action-character/create.spec.ts:35](../../tests/e2e/workflows/nodes/action-character/create.spec.ts#L35)。

建议：保留状态 smoke，并按节点增加持久行、输出或执行事件断言；已有更强 engine 测试不能忽略。

原始证据：`.cache/test-quality-audit-20261101/playwright-discovery.json`。

<a id="tea-007"></a>

### TEA-007 · 已有强工作流 E2E 被 PR 标签过滤排除

PR 命令筛选标签。完整 Chromium 发现 327 条、PR 选中 47 条；循环及两个分支强测试无标签，尽管注释称其进入 PR。47 本身不是缺陷，具体合同遗漏才是。

源码/测试：[tests/e2e/workflows/engine/loop-iterations.spec.ts:71](../../tests/e2e/workflows/engine/loop-iterations.spec.ts#L71)。

建议：按关键路径策略给这三条测试补正确标签，并增加选择策略合同检查。

原始证据：`.cache/test-quality-audit-20261101/playwright-discovery.json`、`.cache/test-quality-audit-20261101/playwright-pr-discovery.json`。

<a id="tea-008"></a>

### TEA-008 · 现有 E2E 静态门禁不能判定断言的行为质量

实际 auditSource 拒绝 literal true 断言，但接受空测试体、自造数据断言及 status-only helper；该规则不覆盖普通 Jest 套件。

源码/测试：[scripts/gates/check-e2e-governance.mjs:71](../../scripts/gates/check-e2e-governance.mjs#L71)。

建议：以有限规则阻止明显新增空壳，兼容 helper 和 throwing query；不能把门禁通过解释为行为有效。

原始证据：`.cache/test-quality-audit-20261101/governance-probes.json`。

<a id="tea-009"></a>

### TEA-009 · E2E 手势等待例外已过复审日期

audit:e2e-governance 返回 1：gestures.ts 的 arbitrary-timeout 例外应在 2026-10-31 复审，审计日期为 2026-11-01。

源码/测试：[scripts/e2e/governance-exceptions.json:4](../../scripts/e2e/governance-exceptions.json#L4)。

建议：复审真实手势时间语义与等待需求，再修正例外；不能机械延长日期或删除必要持续时间。

原始证据：`.cache/test-quality-audit-20261101/round3/governance-recheck.log`。

<a id="tea-010"></a>

### TEA-010 · 缺失 pinned Host 的异常断言可能完全不执行

第二个 try 只有 catch 内断言。让缺失固定 Host 时选择第一台机器后仍 20/20 通过；独立 toThrow 检查准确失败。

源码/测试：[lib/ai/agent/team/workers/remote-worker-runtime.test.ts:137](../../lib/ai/agent/team/workers/remote-worker-runtime.test.ts#L137)。

建议：对缺失和离线两个调用分别直接断言 typed throw，并检查 Host 与 reason。

原始证据：`.cache/test-quality-audit-20261101/round2/missing-pinned-fallback.json`、`.cache/test-quality-audit-20261101/round2/probe-control.json`、`.cache/test-quality-audit-20261101/round2/probe-mutant.json`。

<a id="tea-011"></a>

### TEA-011 · Memory 回退只检查调用次数，未保留配置来源

删除 settings store 回退后仍 5/5 通过；store fixture 和默认配置均 enabled: true。独立 disabled-store 检查预期 false、实际收到 true。

源码/测试：[lib/ai/agent/team/memory/memory-context.test.ts:42](../../lib/ai/agent/team/memory/memory-context.test.ts#L42)。

建议：使用非默认设置，核对 builder 获得的有效配置及共享依赖。

原始证据：`.cache/test-quality-audit-20261101/round2/drop-memory-fallback.json`、`.cache/test-quality-audit-20261101/round2/probe-control.json`、`.cache/test-quality-audit-20261101/round2/probe-mutant.json`。

<a id="tea-012"></a>

### TEA-012 · 名为禁用 Memory 的测试没有禁用输入

只让 mocked builder 返回 undefined，再断言 undefined；getSettings 输入仍 enabled: true，未覆盖真实关闭配置。

源码/测试：[lib/ai/agent/team/memory/memory-context.test.ts:55](../../lib/ai/agent/team/memory/memory-context.test.ts#L55)。

建议：显式设置 enabled: false，再验证真实边界收到该配置；不要靠 mock 返回值代替禁用条件。

原始证据：`.cache/test-quality-audit-20261101/round2/baseline.json`、`.cache/test-quality-audit-20261101/round2/behavior-probes.json`。

<a id="tea-013"></a>

### TEA-013 · 通知路由检查渠道数量但漏掉标题内容

将所有通知标题清空后 15/15 仍通过。独立 deliver payload 检查预期 Approval required、实际收到空标题。

源码/测试：[lib/ai/agent/team/team-notifier.test.ts:58](../../lib/ai/agent/team/team-notifier.test.ts#L58)。

建议：保留渠道、去重和挂起断言，补 title/body 与 run/task 关联的代表性 payload 合同。

原始证据：`.cache/test-quality-audit-20261101/round2/blank-notification-title.json`、`.cache/test-quality-audit-20261101/round2/probe-control.json`、`.cache/test-quality-audit-20261101/round2/probe-mutant.json`。

<a id="tea-014"></a>

### TEA-014 · Canvas rethrow 测试未证明 promise 拒绝

普通 provider 错误改为返回 partial output、保留 error state 后，18/18 仍通过；独立 await rejects 检查失败。

源码/测试：[hooks/canvas/use-canvas-actions.test.ts:128](../../hooks/canvas/use-canvas-actions.test.ts#L128)。

建议：直接 await rejects，再分别检查错误状态和保留的 partial output。

原始证据：`.cache/test-quality-audit-20261101/round2/swallow-canvas-failures.json`、`.cache/test-quality-audit-20261101/round2/canvas-probe-control.json`、`.cache/test-quality-audit-20261101/round2/canvas-probe-mutant.json`。

<a id="tea-015"></a>

### TEA-015 · WebDAV 上传体被改成明文，两个套件仍全绿

保留加密调用，但把上传参数从加密 body 改为 plaintext 后，共享 scheduler 15 条和 provider 4 条全部通过；history 仍可标注 passphrase 加密。

源码/测试：[lib/data/backup-scheduler.test.ts:452](../../lib/data/backup-scheduler.test.ts#L452)。

建议：断言上传的精确字节来自加密输出，并校验 metadata 大小与发送体一致；仅调用过加密函数不足以证明发送的是密文。

原始证据：`.cache/test-quality-audit-20261101/round3/plaintext-webdav-upload.json`、`.cache/test-quality-audit-20261101/round3/probe-control.json`、`.cache/test-quality-audit-20261101/round3/probe-mutant.json`。

<a id="tea-016"></a>

### TEA-016 · CLI 交互审批丢失工具实参仍 7/7 通过

所有 request fixture 的 input 均为空对象；把传给审批 prompt 的真实 input 清空仍 7/7 通过，未证明用户能看到将执行的参数。

源码/测试：[cli/src/agent/permission-gate.test.ts:37](../../cli/src/agent/permission-gate.test.ts#L37)。

建议：用带路径、内容或命令的非空请求验证审批器收到完整 request，同时保留拒绝和异常默认 deny 的检查。

原始证据：`.cache/test-quality-audit-20261101/round3/empty-approval-input.json`、`.cache/test-quality-audit-20261101/round3/probe-control.json`、`.cache/test-quality-audit-20261101/round3/probe-mutant.json`。

<a id="tea-017"></a>

### TEA-017 · WebDAV 恢复单测漏校解密口令，但真实集成测试有效

强制解密使用错误口令后单测仍 8/8 通过；真实加解密与存储集成用例中两个成功恢复合同准确失败，另外两个预期拒绝的合同通过。

源码/测试：[lib/webdav/restore.test.ts:90](../../lib/webdav/restore.test.ts#L90)。

建议：给 decrypt mock 补精确 envelope/口令参数断言，并保留真实加密集成测试；不能将本项归为全局未覆盖。

原始证据：`.cache/test-quality-audit-20261101/round3/wrong-restore-passphrase.json`。

<a id="tea-018"></a>

### TEA-018 · Web Locks 环境掩盖了备用备份队列回归

移除同目标队列等待后原有 2/2 仍通过；实际 Jest 运行面存在 navigator.locks，原生锁继续串行化。临时禁用该 API 后，原实现新增检查通过、移除队列版本新增检查失败：second 提前进入。

源码/测试：[lib/data/backup-write-lock.test.ts:3](../../lib/data/backup-write-lock.test.ts#L3)。

建议：显式覆盖原生锁存在和缺失两种运行面，并在 finally 释放挂起任务与恢复全局环境。

原始证据：`.cache/test-quality-audit-20261101/round3/parallel-backup-writes.json`、`.cache/test-quality-audit-20261101/round3/queue-probe-control.json`、`.cache/test-quality-audit-20261101/round3/queue-probe-mutant.json`、`.cache/test-quality-audit-20261101/round3/queue-native-lock-control.json`、`.cache/test-quality-audit-20261101/round3/queue-native-lock-mutant.json`。

## 有效对照与排除项

- **CTRL-001 · Goal session map 的行为断言有效**：返回空 map 后 3 条原有测试失败、2 条通过。 证据：`.cache/test-quality-audit-20261101/drop-session-id.json`。
- **CTRL-002 · 生成按钮的子组件测试有效**：删除按钮后子组件 3/7 失败，原始基线 7/7 通过。 证据：`.cache/test-quality-audit-20261101/drop-generate-button.json`。
- **CTRL-003 · 账号切换与所有权 token 重检有效**：重复使用初始会话后 2/4 失败，拦截不同用户和丢失 profile ownership。 证据：`.cache/test-quality-audit-20261101/round2/stale-sync-token.json`。
- **CTRL-004 · 二进制审批的跨插件隔离断言有效**：按路径查询而忽略 pluginId 后，跨插件测试准确失败，8 条其他测试通过。 证据：`.cache/test-quality-audit-20261101/round2/cross-plugin-approval.json`。
- **CTRL-005 · 真实 WebDAV 加解密和恢复集成有效**：解密口令被固定改错时，包含 portable retrieval key 的恢复和 legacy 恢复两个成功合同准确失败；单测 8 条仍通过。 证据：`.cache/test-quality-audit-20261101/round3/wrong-restore-passphrase.json`。

- **类型 fixture：不能整体判无效**。根 tsconfig 确实包含检查过的测试；SessionPatch 等编译期排除字段检查可有价值。Jest 通过不能替代编译器证据。
- **try/catch 筛选：候选不等于缺陷**。静态识别 35 个候选块，许多在 try 之前已有 toThrow/rejects；只有有独立复现证据的合同被列为已证实。
- **直接丢弃异步断言：窄扫描未发现**。在识别到的静态标题测试里，没有直接丢弃的 resolves/rejects 或 waitFor expression statement；不能外推所有异步路径。
- **启动/平台 source guard：本轮不判为无效**。SessionPowerInitializer、PlatformDesktopSources、PlatformShell 同时具有窄的结构 guard 与行为断言；11 文件基线包含这些测试，不能仅因 readFileSync 标成无效。
- **取消、备份导出和加密：仅有命名基线证据**。实际运行了 receipt 取消、biometric export guard、content cipher 与 auto-lock 测试；未对每个安全合同做破坏实验，不能声明所有安全边界均被验证。

## 第三轮实际命令与结果

| 实验                     | 退出码 | 通过 | 失败 | 跳过 |
| ------------------------ | -----: | ---: | ---: | ---: |
| baseline                 |      0 |   55 |    0 |    0 |
| empty-approval-input     |      0 |    7 |    0 |    0 |
| parallel-backup-writes   |      0 |    2 |    0 |    0 |
| plaintext-webdav-upload  |      0 |   19 |    0 |    0 |
| probe-control            |      0 |   24 |    0 |    0 |
| probe-mutant             |      1 |   22 |    2 |    0 |
| queue-probe-control      |      0 |    3 |    0 |    0 |
| queue-probe-mutant       |      1 |    2 |    1 |    0 |
| wrong-restore-passphrase |      1 |   10 |    2 |    0 |

第三轮命令、环境变量和起止时间逐条保存在 JSON 台账的 `runs`；不要将 mutation 或新增检查在故意破坏时的失败，描述为原代码测试失败。

本地复现入口：

```sh
rtk proxy node .cache/test-quality-audit-20261101/round3/run.cjs baseline
rtk proxy node .cache/test-quality-audit-20261101/round3/run.cjs plaintext-webdav-upload
rtk proxy node .cache/test-quality-audit-20261101/round3/run.cjs empty-approval-input
rtk proxy node .cache/test-quality-audit-20261101/round3/run.cjs probe-control
rtk proxy node .cache/test-quality-audit-20261101/round3/run.cjs probe-mutant
```

mutation harness 会核对源码 hash，遇到并发改动会拒绝运行，不会回滚或覆盖其他人的工作。原始快照、日志和完整 Jest JSON 位于 `.cache/test-quality-audit-20261101/`，受 Git 忽略；清理该目录会失去原始附件，本报告与 JSON 台账仍保留核心证据、摘要、计划和校验值。

<!-- BEGIN:test-effectiveness-audit-round4 -->

## 第四轮：Rust 与 sidecar

本轮原始基线为：官方 sidecar runner 的 5 个具名文件共 **80/80 通过**（72 + 8）；未修改的 `cognia-canonical-json` crate 以 `cargo test --locked --offline -p cognia-canonical-json --lib` 跑出 **7/7 通过**。下载模块只在隔离 Cargo workspace 中原样提取三个纯函数、四个原始测试，基线 **4/4 通过**；该结果不能冒充完整 Tauri 编译或接受。完整 JCS 模块副本保留全部七条原测试，共享 fixture 仅做 include 路径适配。

发现 70 个 Cargo workspace member；sidecar 默认 lane 293 个文件、live lane 3 个文件，另有三个 nested package 自管 runner。未运行这些 live/ignored/platform-specific 接受，也未将它们仅因被分层排除就认定为无效。

<a id="tea-019"></a>

### TEA-019 · Rust 下载目标测试放过 Err 和错误 triple

原测试仅在 if let Ok 时检查字符串包含连字符。在保留三个原始纯函数及四个原始测试的隔离 Cargo harness 中，把受支持主机的解析结果改为 Err，或改为 audit-wrong-target，四个测试均继续通过。精确主机 triple 的新增检查在原实现 5/5 通过，两种破坏均仅新增检查失败（4 通过、1 失败）。这是窄 smoke 合同未保护 supported-host 映射；不是完整 Tauri 测试结果。

源码/测试：[src-tauri/src/cli_bridge/download.rs:346](../../src-tauri/src/cli_bridge/download.rs#L346)。

建议：将受支持主机必须成功与精确目标映射分开断言；对 unsupported OS/arch 单独验证错误分支。当前新增 fixture 仅针对 macOS aarch64，不冒充跨平台接受。

原始证据：`.cache/test-quality-audit-20261101/round4/download-control.run.json`、`.cache/test-quality-audit-20261101/round4/download-error.run.json`、`.cache/test-quality-audit-20261101/round4/download-wrong.run.json`、`.cache/test-quality-audit-20261101/round4/download-probe-control.run.json`、`.cache/test-quality-audit-20261101/round4/download-probe-error.run.json`、`.cache/test-quality-audit-20261101/round4/download-probe-wrong.run.json`、`.cache/test-quality-audit-20261101/round4/rust-download.plan.json`。

<a id="tea-020"></a>

### TEA-020 · Sidecar 命令 hook 丢失工具名称仍 10/10 通过

stdin 测试只匹配 PreToolUse 片段。将前台命令 hook payload 的 tool_name 清空后，原十条测试全部通过。新增完整 payload round-trip 检查在原实现 11/11 通过，破坏后原十条仍通过、仅新增一条失败。命令 hook 没有获得原本的工具身份时仍可被错误宣称 payload 已送达。

源码/测试：[sidecar/src/hooks/handlers/command.test.ts:44](../../sidecar/src/hooks/handlers/command.test.ts#L44)。

建议：对 stdin 接收的完整 JSON 做等值检查，覆盖 tool_name、非空 tool_input、session 与 provenance；保留退出码、超时、EPIPE 等既有检查。

原始证据：`.cache/test-quality-audit-20261101/round4/command-hook-blank-tool-mutant.run.json`、`.cache/test-quality-audit-20261101/round4/command-hook-blank-tool-probe-control.run.json`、`.cache/test-quality-audit-20261101/round4/command-hook-blank-tool-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round4/command-hook-blank-tool.plan.json`。

<a id="tea-021"></a>

### TEA-021 · Sidecar native model hook 漏测事件上下文

首条测试传入非空 payload，却主要断言 options 与 hook-origin。将 handlerPrompt 的事件输入替换为 {} 后八条原测试全部通过。新增检查通过 fake query 捕获真实 prompt：原实现 9/9 通过，破坏后原八条仍通过、仅新增一条失败。此项针对 prompt/agent hook 的事件上下文；MCP 分支另按 handler.input 生成请求。

源码/测试：[sidecar/src/hooks/native-executor.test.ts:39](../../sidecar/src/hooks/native-executor.test.ts#L39)。

建议：用非空事件的工具名称和参数检查经过 redaction 的模型输入；隐私过滤与上下文完整性是两个独立合同。

原始证据：`.cache/test-quality-audit-20261101/round4/native-hook-drop-event-mutant.run.json`、`.cache/test-quality-audit-20261101/round4/native-hook-drop-event-probe-control.run.json`、`.cache/test-quality-audit-20261101/round4/native-hook-drop-event-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round4/native-hook-drop-event.plan.json`。

### 有效对照

- **CTRL-006 · Rust JCS golden vectors 与 UTF-16 排序检查有效**：未修改仓库内 canonical-json crate 的 --lib 基线 7/7 通过；完整模块隔离副本也 7/7 通过。把 UTF-16 key sort 改成普通字符串排序后 2/7 原测试失败：golden vectors 与明确的 UTF-16 排序合同。副本仅把共享 fixture include 路径改为原 fixture 的绝对路径。 证据：`.cache/test-quality-audit-20261101/round4/canonical-utf8-mutant.log`。
- **CTRL-007 · Sidecar native hook 预算拒绝检查有效**：禁用 budget.exhausted 分支后，原有预算/递归用例准确失败，另外七条通过。不能因为该文件漏查 payload，就把整个文件判成无效。 证据：`.cache/test-quality-audit-20261101/round4/native-hook-budget-open-mutant.log`。

### 本轮实际运行结果

| 实验                                  | 运行面         | 退出码 | 通过 | 失败 | 跳过/ignored |
| ------------------------------------- | -------------- | -----: | ---: | ---: | -----------: |
| sidecar-baseline                      | sidecar        |      0 |   72 |    0 |            0 |
| rust-canonical-workspace-baseline     | rust-workspace |      0 |    7 |    0 |            0 |
| canonical-control                     | rust-isolated  |      0 |    7 |    0 |            0 |
| canonical-utf8-mutant                 | rust-isolated  |    101 |    5 |    2 |            0 |
| command-hook-blank-tool-mutant        | sidecar        |      0 |   10 |    0 |            0 |
| command-hook-blank-tool-probe-control | sidecar        |      0 |   11 |    0 |            0 |
| command-hook-blank-tool-probe-mutant  | sidecar        |      1 |   10 |    1 |            0 |
| download-control                      | rust-isolated  |      0 |    4 |    0 |            0 |
| download-error                        | rust-isolated  |      0 |    4 |    0 |            0 |
| download-probe-control                | rust-isolated  |      0 |    5 |    0 |            0 |
| download-probe-error                  | rust-isolated  |    101 |    4 |    1 |            0 |
| download-probe-wrong                  | rust-isolated  |    101 |    4 |    1 |            0 |
| download-wrong                        | rust-isolated  |      0 |    4 |    0 |            0 |
| native-hook-budget-open-mutant        | sidecar        |      1 |    7 |    1 |            0 |
| native-hook-drop-event-mutant         | sidecar        |      0 |    8 |    0 |            0 |
| native-hook-drop-event-probe-control  | sidecar        |      0 |    9 |    0 |            0 |
| native-hook-drop-event-probe-mutant   | sidecar        |      1 |    8 |    1 |            0 |
| sidecar-native-baseline               | sidecar        |      0 |    8 |    0 |            0 |

sidecar 的注入只发生于 Node load hook；Rust 的生产函数与测试仅复制到 `.cache/` 隔离 crate，未改写仓库原始模块。所有故意破坏导致的退出码 1 或 101 都是预期证据，不是原始产品代码失败。本地工具链为 rustc 1.99.0、Cargo 1.99.0、Node v26.12.1，运行于 macOS arm64。

复现：

```sh
rtk proxy node .cache/test-quality-audit-20261101/round4/run.cjs sidecar-native-baseline
rtk proxy node .cache/test-quality-audit-20261101/round4/run.cjs command-hook-blank-tool-mutant
rtk proxy node .cache/test-quality-audit-20261101/round4/run.cjs native-hook-drop-event-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round4/run.cjs download-probe-control
rtk proxy node .cache/test-quality-audit-20261101/round4/run.cjs download-probe-error
rtk proxy node .cache/test-quality-audit-20261101/round4/run.cjs canonical-utf8-mutant
```

原始快照、精确函数提取内容、依赖版本与 lock、fixture 适配说明、临时检查代码、命令/env/退出码和失败摘要均已补入 JSON 台账。源码 hash 漂移会让 harness 拒绝运行。Rust 分支尚缺完整 Tauri、全 workspace 和跨平台接受；sidecar 尚缺默认 lane 全量、nested packages 与 live SDK/Host 接受。本轮仍未收集 coverage。

<!-- END:test-effectiveness-audit-round4 -->

<!-- BEGIN:test-effectiveness-audit-round5 -->

## 第五轮：Rust 输出、退避与 sidecar MCP 关联

本轮实际原始基线：官方 sidecar runner 的 **9 个具名文件 47/47 通过**；真实 Cargo workspace 的三个模块过滤器合计 **16/16 通过**（backoff 5、output 5、limits 6）。另有完整模块隔离副本 **16/16 通过**，用于 mutation；它们重复上述模块，不能相加成 32 个独立 Rust 测试，也不代表两个 crate 的完整测试。

选定 sidecar 文件为 broker、tool-bridge、auto-reconnect、OAuth callback、host send、env、which、git、local-spans。OAuth callback 使用本地 loopback HTTP，Git helper 调用本机 Git；MCP broker 使用 fake socket，自动重连注入函数，没有连接真实 MCP/provider。其余具名文件只完成基线和源码审查，未对每个合同做 mutation。

<a id="tea-022"></a>

### TEA-022 · Rust crash backoff 的窗口断言放过零延迟

remaining_inside_and_past_window 只检查 Some 且剩余时间 <= 150ms，没有下界或精确时长。把窗口内 remaining 一律改为 Some(Duration::ZERO)，完整模块隔离副本的五条原测试仍全部通过。新增精确窗口检查在原实现 6/6 通过，破坏后 5 通过、1 失败（Some(0ns) 对 Some(250ms)）。真实 workspace 的 supervision_backoff::tests 基线也为 5/5 通过。brain supervisor 将 remaining 直接传给 tokio::time::sleep，因此零延迟会取消实际退避；本轮没有启动 supervisor 进程循环。

源码/测试：[crates/cognia-core/src/supervision_backoff.rs:96](../../crates/cognia-core/src/supervision_backoff.rs#L96)。

建议：用注入的 Instant 精确断言窗口起点、窗口内剩余时长、截止点及 reset 后状态；保留现有 delay table 与单次失败立即重启合同。

原始证据：`.cache/test-quality-audit-20261101/round5/workspace-backoff-baseline.run.json`、`.cache/test-quality-audit-20261101/round5/backoff-control.run.json`、`.cache/test-quality-audit-20261101/round5/backoff-zero.run.json`、`.cache/test-quality-audit-20261101/round5/backoff-probe-control.run.json`、`.cache/test-quality-audit-20261101/round5/backoff-probe-zero.run.json`、`.cache/test-quality-audit-20261101/round5/rust-backoff.plan.json`。

<a id="tea-023"></a>

### TEA-023 · Rust 大输出截断只检查上限和标记，漏查正文

大输出用例检查 truncated、长度上限和结尾 marker，未检查被保留的正文。只在达到截断容量时把保留前缀清空、仍追加 marker，完整模块的五条原测试仍全部通过。原测试里短输出的取消恢复与 stalled EOF 精确断言没有被破坏，不能将整个文件判为无效。新增通过真实异步内存流读入大量 UTF-8 文本并检查完整保留前缀的检查，在原实现 6/6 通过；破坏后原五条通过、新增一条失败（实际 16 bytes，对预期 1,000,000 bytes）。真实 workspace 的 output::tests 基线为 5/5 通过。

源码/测试：[crates/cognia-exec-sandbox/src/output.rs:87](../../crates/cognia-exec-sandbox/src/output.rs#L87)。

建议：对超限输入断言精确保留前缀与 marker，覆盖 read_capped 和直接 truncate_utf8 路径；保留既有 cancellation、EOF 和 UTF-8 边界合同。

原始证据：`.cache/test-quality-audit-20261101/round5/workspace-output-baseline.run.json`、`.cache/test-quality-audit-20261101/round5/output-control.run.json`、`.cache/test-quality-audit-20261101/round5/output-empty.run.json`、`.cache/test-quality-audit-20261101/round5/output-probe-control.run.json`、`.cache/test-quality-audit-20261101/round5/output-probe-empty.run.json`、`.cache/test-quality-audit-20261101/round5/rust-output.plan.json`。

<a id="tea-024"></a>

### TEA-024 · Sidecar broker 的 request ID 匹配未覆盖并发乱序

名为 matching response id 的用例只保留一个 pending 请求。把按 message.id 查找和移除改为按 pending 的插入顺序取首项，broker 四条与 tool-bridge 十条原测试仍 14/14 通过。新增两请求并发、先返回第二个 response 的检查，在原实现连同原测试 15/15 通过；破坏后原十四条通过，仅新增检查失败，两个结果的 owner 发生对调。这证实具名套件遗漏关联性合同，不是原始实现已存在串单。

源码/测试：[sidecar/src/mcp/client/broker.test.ts:5](../../sidecar/src/mcp/client/broker.test.ts#L5)。

建议：用不同方法和参数发起至少两个 pending 请求，按相反顺序返回并检查各自结果；补未知/重复 ID、分片与合帧场景，同时保留已有错误传播检查。

原始证据：`.cache/test-quality-audit-20261101/round5/sidecar-baseline.run.json`、`.cache/test-quality-audit-20261101/round5/broker-fifo-mutant.run.json`、`.cache/test-quality-audit-20261101/round5/broker-fifo-probe-control.run.json`、`.cache/test-quality-audit-20261101/round5/broker-fifo-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round5/broker-fifo.plan.json`。

### 有效对照

- **CTRL-008 · Rust rlimit 内存单位换算检查有效**：真实 workspace 的 limits::tests 与完整模块隔离副本分别 6/6 通过。将 MB 到 bytes 的系数从 1024*1024 改成 1024，三个原测试准确失败：memory_mb_converts_to_bytes、all_caps_set、absurd_memory_saturates_instead_of_overflowing；其余三条通过。本轮未调用 setrlimit 或验证操作系统实际限额。 证据：`.cache/test-quality-audit-20261101/round5/limits-kilobytes.log`。
- **CTRL-009 · Sidecar broker 的断连和坏帧拒绝检查有效**：把 failAll 对 pending promise 的 reject 改成 resolve({})，四条原测试中的断连与 malformed frame 两条以 Missing expected rejection 失败；另两条通过。这证明已覆盖的拒绝合同有效，并不证明多个 pending 的每一种情况都已覆盖。 证据：`.cache/test-quality-audit-20261101/round5/broker-fatal-open-mutant.log`。
- **CTRL-010 · Sidecar MCP 自动重连次数上限检查有效**：移除 used >= maxPerServer 预算退出后，原八条中默认一次上限与显式 maxPerServer=2 两条失败，另外六条通过。默认基线八条全通过；测试注入 reconnect，没有连接真实 MCP server。 证据：`.cache/test-quality-audit-20261101/round5/mcp-reconnect-unlimited-mutant.log`。

### 本轮实际运行结果

| 实验                           | 运行面         | 退出码 | 通过 | 失败 | 跳过/ignored |
| ------------------------------ | -------------- | -----: | ---: | ---: | -----------: |
| sidecar-baseline               | sidecar        |      0 |   47 |    0 |            0 |
| broker-fifo-mutant             | sidecar        |      0 |   14 |    0 |            0 |
| broker-fifo-probe-control      | sidecar        |      0 |   15 |    0 |            0 |
| broker-fifo-probe-mutant       | sidecar        |      1 |   14 |    1 |            0 |
| broker-fatal-open-mutant       | sidecar        |      1 |    2 |    2 |            0 |
| mcp-reconnect-unlimited-mutant | sidecar        |      1 |    6 |    2 |            0 |
| workspace-backoff-baseline     | rust-workspace |      0 |    5 |    0 |            0 |
| workspace-output-baseline      | rust-workspace |      0 |    5 |    0 |            0 |
| backoff-control                | rust-isolated  |      0 |    5 |    0 |            0 |
| backoff-zero                   | rust-isolated  |      0 |    5 |    0 |            0 |
| backoff-probe-zero             | rust-isolated  |    101 |    5 |    1 |            0 |
| backoff-probe-control          | rust-isolated  |      0 |    6 |    0 |            0 |
| output-control                 | rust-isolated  |      0 |    5 |    0 |            0 |
| output-empty                   | rust-isolated  |      0 |    5 |    0 |            0 |
| output-probe-empty             | rust-isolated  |    101 |    5 |    1 |            0 |
| output-probe-control           | rust-isolated  |      0 |    6 |    0 |            0 |
| limits-control                 | rust-isolated  |      0 |    6 |    0 |            0 |
| limits-kilobytes               | rust-isolated  |    101 |    3 |    3 |            0 |
| workspace-limits-baseline      | rust-workspace |      0 |    6 |    0 |            0 |

Rust 的隔离副本保留整份模块和全部原始测试，没有内容适配；仅在副本中定点修改生产函数并附加临时检查。sidecar 使用 Node load hook 进行内存注入。上表退出码 1/101 是故意破坏下的预期结果，所有原始基线均为 0。

独立 lock 初次解析被本地索引中的 yanked Tokio 1.54.0 拒绝（exit 101）；之后以仓库 Cargo.lock 为种子保留原 pinned 版本，离线完成依赖裁剪和编译，再用 `--offline --locked` 跑全部隔离测试。准备过程没有升级依赖，记录见 `.cache/test-quality-audit-20261101/round5/dependency-setup.json`。

复现：

```sh
rtk proxy node .cache/test-quality-audit-20261101/round5/run.cjs sidecar-baseline
rtk proxy node .cache/test-quality-audit-20261101/round5/run.cjs workspace-backoff-baseline
rtk proxy node .cache/test-quality-audit-20261101/round5/run.cjs workspace-output-baseline
rtk proxy node .cache/test-quality-audit-20261101/round5/run.cjs workspace-limits-baseline
rtk proxy node .cache/test-quality-audit-20261101/round5/run.cjs backoff-probe-zero
rtk proxy node .cache/test-quality-audit-20261101/round5/run.cjs output-probe-empty
rtk proxy node .cache/test-quality-audit-20261101/round5/run.cjs broker-fifo-probe-mutant
```

本轮新增 3 项已证实缺口、3 项有效对照和 19 次具名测试运行。命令、环境覆盖、起止时间、退出码、失败名称/摘录、源码快照与 hash、精确 mutation 和临时 probe 已存入台账。没有改动仓库业务代码或现有测试，没有运行 coverage、完整 Rust/Tauri/sidecar lane 或真实 provider 接受。

<!-- END:test-effectiveness-audit-round5 -->

<!-- BEGIN:test-effectiveness-audit-round6 -->

## 第六轮：Rust 分页、原子写与 sidecar middleware/deadline

本轮原始基线：官方 sidecar runner 的 **9 个此前未运行文件 78/78 通过**；真实 Cargo workspace 的 `cognia-problem --lib` 默认特性 **28/28 通过**，`cognia-core` 的 `fs_atomic::` 与 `installed::tests` 过滤器分别 **21/21、5/5 通过**，合计 **54/54**。独立副本也合计 **54/54**，属于重复运行面，不能相加成 108 个不同的 Rust 测试。

sidecar 九文件为 shared deadline、pending、input-stream、read-only-timeout、result-cap、stream-watchdog、context/tool-result-cap、sdk-mcp、host/control/handle。SDK MCP 测试通过真实 SDK 的 in-memory transport 运行；未调用真实模型或远程 MCP server。Rust problem 保留整个 src 目录的三份源码；另外两个复制整份模块和全部原始测试，均只在审计 cache 中变更。

<a id="tea-025"></a>

### TEA-025 · Rust legacy offset 分页漏查行内容完整性

legacy_offset_pages 测试验证 items.len、next token 和 total，没有比较 rows 到 items 的值。仅把对象形式 legacy offset page 的每条已取出行替换为 Value::Null，保留数量、token 和 extras，完整 cognia-problem 源码隔离副本的 28 条默认 --lib 原测试仍全部通过。新增含 id、title 和嵌套对象的 wire 检查在原实现 29/29 通过，破坏后原 28 条通过、新增一条失败，实际 items=[null]。真实 workspace 的未修改 crate 默认 --lib 基线 28/28 通过。session_list RPC 可达此转换器；本轮未启动 RPC server。

源码/测试：[crates/cognia-problem/src/paging.rs:520](../../crates/cognia-problem/src/paging.rs#L520)。

建议：对 legacy offset/cursor 的完整 item 值及 into_value_with 后的 wire items 做等值断言，使用非空嵌套数据，同时保留 token、terminal-page 与 extras 合同。

原始证据：`.cache/test-quality-audit-20261101/round6/workspace-problem-baseline.run.json`、`.cache/test-quality-audit-20261101/round6/problem-control.run.json`、`.cache/test-quality-audit-20261101/round6/problem-nullrows.run.json`、`.cache/test-quality-audit-20261101/round6/problem-probe-control.run.json`、`.cache/test-quality-audit-20261101/round6/problem-probe-nullrows.run.json`、`.cache/test-quality-audit-20261101/round6/rust-problem.plan.json`。

<a id="tea-026"></a>

### TEA-026 · Sidecar 工具 middleware 漏查参数和取消上下文转发

timeout 与 result-cap 两类 wrapper 的局部测试均使用空 args/extra。把 handler(args, extra) 改成 handler({}, {}) 后，连同 sdk-mcp 的十一条测试分别仍 19/19、21/21 通过；单独保留 args 但清空 extra 也得到相同结果。新增用非空 path/limit 和含 AbortSignal、requestId 的 context 捕获实参：原实现分别 20/20、22/22 通过；参数+context 破坏与 context-only 破坏各只新增一条失败。后者独立证明额外上下文不是被前一个断言遮住。wrapper 通过 SDK MCP 与 tool bridge 注册路径可达。本实验验证传递身份，不验证工具实际响应 abort。

源码/测试：[sidecar/src/tools/middleware/read-only-timeout.test.ts:41](../../sidecar/src/tools/middleware/read-only-timeout.test.ts#L41)。

建议：为 timeout 和 cap 的启用路径分别断言非空 args 与原 extra/AbortSignal 到达 handler；增加组合包装后调用真实可观察 handler 的集成检查，保留现有超时和截断输出断言。

原始证据：`.cache/test-quality-audit-20261101/round6/timeout-drop-args-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/timeout-drop-args-probe-control.run.json`、`.cache/test-quality-audit-20261101/round6/timeout-drop-args-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/timeout-drop-context-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/timeout-drop-context-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/cap-drop-args-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/cap-drop-args-probe-control.run.json`、`.cache/test-quality-audit-20261101/round6/cap-drop-args-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/cap-drop-context-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/cap-drop-context-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/timeout-drop-args.plan.json`、`.cache/test-quality-audit-20261101/round6/cap-drop-args.plan.json`、`.cache/test-quality-audit-20261101/round6/timeout-drop-context.plan.json`、`.cache/test-quality-audit-20261101/round6/cap-drop-context.plan.json`。

<a id="tea-027"></a>

### TEA-027 · Sidecar deadline 测试未保护调用方给定的时长

原 helper 只用立即完成/拒绝的 work 或 1ms 的 pending 超时，没有需要等待但仍在较长预算内完成的 work。把 setTimeout 的 ms 参数写死为 1，deadline 三条与上层 control handle 二十三条原测试仍 26/26 通过。新增使用 Node mock timers 的确定性检查：20ms 完成的 work 在 100ms 预算内必须成功；原实现连同原测试 27/27 通过，破坏后原二十六条通过、新增一条失败（expired 对 finished）。runControlWithTimeout 通过此 helper 实施默认 10,000ms 控制预算；这不是原实现已经提前超时的证据。

源码/测试：[sidecar/src/shared/deadline.test.ts:5](../../sidecar/src/shared/deadline.test.ts#L5)。

建议：用虚拟时钟检查预算前仍 pending、预算内稍后完成的 work 成功、截止点触发 timeout，避免只检查最终 timeout 文案或上限耗时。

原始证据：`.cache/test-quality-audit-20261101/round6/deadline-hardcoded-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/deadline-hardcoded-probe-control.run.json`、`.cache/test-quality-audit-20261101/round6/deadline-hardcoded-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round6/deadline-hardcoded.plan.json`。

### 有效对照

- **CTRL-011 · Rust atomic write 的 fsync 错误拒绝与旧值保护有效**：真实 workspace 与完整模块隔离副本分别 21/21 通过。调用 sync_file 但吞掉其错误后，delayed_enospc_from_sync_preserves_destination_and_cleans_stage 与 sync_failure_does_not_publish_a_new_destination 两条原测试失败，其余十九条通过。该测试注入 ENOSPC 错误，不代表已造成真实磁盘满或验证断电恢复。 证据：`.cache/test-quality-audit-20261101/round6/atomic-ignore_sync_error.log`。
- **CTRL-012 · Rust Installed 的重复安装拒绝检查有效**：真实 workspace 与整模块副本分别 5/5 通过。第二次 install 不再返回 AlreadyInstalled、改为 Ok 时，installed_is_write_once_and_keeps_the_first_value 原用例准确失败，其他四条通过。保留第一个值并不能替代显式重复安装拒绝合同。 证据：`.cache/test-quality-audit-20261101/round6/installed-accept_duplicate.log`。
- **CTRL-013 · Sidecar stream watchdog 的上游取消检查有效**：移除 timeout/error catch 对 iterator.return 的调用后，cancels the source iterator on timeout 原测试失败，其余七条通过；未修改基线八条通过。测试使用自定义异步迭代器，没有连接真实 HTTP/provider。 证据：`.cache/test-quality-audit-20261101/round6/watchdog-no-cancel-mutant.log`。

### 本轮实际运行结果

| 实验                                 | 阶段/运行面                 | 退出码 | 通过 | 失败 |
| ------------------------------------ | --------------------------- | -----: | ---: | ---: |
| sidecar-baseline                     | sidecar                     |      0 |   78 |    0 |
| timeout-drop-args-mutant             | sidecar                     |      0 |   19 |    0 |
| timeout-drop-args-probe-control      | sidecar                     |      0 |   20 |    0 |
| timeout-drop-args-probe-mutant       | sidecar                     |      1 |   19 |    1 |
| cap-drop-args-mutant                 | sidecar                     |      0 |   21 |    0 |
| cap-drop-args-probe-control          | sidecar                     |      0 |   22 |    0 |
| cap-drop-args-probe-mutant           | sidecar                     |      1 |   21 |    1 |
| deadline-hardcoded-mutant            | sidecar                     |      0 |   26 |    0 |
| deadline-hardcoded-probe-control     | sidecar                     |      0 |   27 |    0 |
| deadline-hardcoded-probe-mutant      | sidecar                     |      1 |   26 |    1 |
| watchdog-no-cancel-mutant            | sidecar                     |      1 |    7 |    1 |
| problem-control                      | rust-isolated               |      0 |   28 |    0 |
| problem-nullrows                     | rust-isolated               |      0 |   28 |    0 |
| problem-probe-nullrows               | rust-isolated               |    101 |   28 |    1 |
| problem-probe-control                | rust-isolated               |      0 |   29 |    0 |
| atomic-control                       | rust-isolated               |      0 |   21 |    0 |
| atomic-ignore_sync_error             | rust-isolated               |    101 |   19 |    2 |
| installed-control                    | rust-isolated               |      0 |    5 |    0 |
| installed-accept_duplicate           | rust-isolated               |    101 |    4 |    1 |
| workspace-problem-baseline           | rust-workspace              |      0 |   28 |    0 |
| workspace-atomic-baseline            | rust-workspace              |      0 |   21 |    0 |
| workspace-installed-baseline         | rust-workspace              |      0 |    5 |    0 |
| timeout-drop-context-mutant          | sidecar                     |      0 |   19 |    0 |
| timeout-drop-context-probe-mutant    | sidecar                     |      1 |   19 |    1 |
| cap-drop-context-mutant              | sidecar                     |      0 |   21 |    0 |
| cap-drop-context-probe-mutant        | sidecar                     |      1 |   21 |    1 |
| atomic-control-setup-error           | compile setup（未进入测试） |    101 |    — |    — |
| atomic-ignore_sync_error-setup-error | compile setup（未进入测试） |    101 |    — |    — |

共新增 **28 条运行记录**，其中 **26 次进入测试**，另两次是隔离 atomic manifest 初次缺少 `tempfile` 开发依赖的编译准备失败（E0433，退出 101，测试数记为 null）。已保留两份失败日志及原 manifest；补入仓库锁定的 tempfile 3.27.0、以原 Cargo.lock 为种子离线解析后，未改测试源码即得到 21/21 基线及 19 通过/2 失败的预期破坏结果。`--no-run` 仅属于准备，不记作测试通过。设置详情见 `.cache/test-quality-audit-20261101/round6/dependency-setup.json`。

本轮三个缺口均有原实现通过与 mutation 下新增 probe 失败的对照。其余故意破坏的退出码 1/101 是审计证据，不是原始代码失败；上表明确单列了准备失败。没有运行 coverage、完整 sidecar lane、完整 core crate、axum 特性、真实 Host/provider、其他 OS 或真实磁盘满/断电接受。

复现：

```sh
rtk proxy node .cache/test-quality-audit-20261101/round6/run.cjs sidecar-baseline
rtk proxy node .cache/test-quality-audit-20261101/round6/run.cjs workspace-problem-baseline
rtk proxy node .cache/test-quality-audit-20261101/round6/run.cjs workspace-atomic-baseline
rtk proxy node .cache/test-quality-audit-20261101/round6/run.cjs workspace-installed-baseline
rtk proxy node .cache/test-quality-audit-20261101/round6/run.cjs problem-probe-nullrows
rtk proxy node .cache/test-quality-audit-20261101/round6/run.cjs timeout-drop-context-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round6/run.cjs cap-drop-args-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round6/run.cjs deadline-hardcoded-probe-mutant
```

<!-- END:test-effectiveness-audit-round6 -->

<!-- BEGIN:test-effectiveness-audit-round7 -->

## 第七轮：Rust replay/rate/cancellation 与 sidecar egress

原始具名基线：官方 sidecar runner 八文件 **43/43 通过**；真实 workspace 的 `cognia-core command_error::tests` **6/6 通过**（另外 40 条 filtered）。Rust 的 replay、rate、request_cancellation、egress 整模块副本分别 **5、10、4、21 条**，合计 **40/40 通过**；后者仅是四份源码的隔离运行，不能称为完整 companion-security/net crate 或服务接受。

本轮新增 **3 项 mutation 证实的测试缺口、1 项未修改实现即可复现的误拒绝缺陷、3 项有效对照**。新增 19 次测试运行；另四次 `--no-run` 准备成功，记录于 dependency-setup，不计作测试通过。为减少磁盘占用，只复用第六轮 Cargo 编译缓存，未改其源码、manifest 或历史日志。

<a id="tea-028"></a>

### TEA-028 · Rust replay cache 漏测有效期结束前的重放拒绝

现有用例在初始 now 检查 replay，再跳过 expiry 检查可复用，没有在 expiry 前一秒验证仍须拒绝。将缓存存储的 expires_at 减一秒，完整原模块副本五条原测试仍 5/5 通过。新增 exact-expiry 检查在原实现 6/6 通过，破坏后原五条通过、新增一条失败，expiry-1 时同一 assertion 被再次接受。mark_redeemed 被 Lark assertion 与 DPoP 路径使用，但本轮没有运行签名/JWT/HTTP 链路。这是 mutation 证明的边界缺口，原实现没有提前过期。

源码/测试：[crates/cognia-companion-security/src/replay_cache.rs:66](../../crates/cognia-companion-security/src/replay_cache.rs#L66)。

建议：对有效期最后一秒和恰好到期分别断言拒绝/可更新，并保留容量满时 fail-closed 及按需清理检查。

原始证据：`.cache/test-quality-audit-20261101/round7/replay-control.run.json`、`.cache/test-quality-audit-20261101/round7/replay-early_expiry.run.json`、`.cache/test-quality-audit-20261101/round7/replay-probe-control.run.json`、`.cache/test-quality-audit-20261101/round7/replay-probe-early_expiry.run.json`、`.cache/test-quality-audit-20261101/round7/rust-replay.plan.json`。

<a id="tea-029"></a>

### TEA-029 · Rust rate limiter 的 Retry-After 仅有下界断言

burst 与 read ceiling 用例只要求 retry_after.as_secs() >= 1；接受/拒绝和 refill 用例没有校验客户端收到的等待值。把所有拒绝等待值写成 3,600 秒后，完整模块的十条原测试仍 10/10 通过。新增 capacity=1、refill=0.25/s 的确定性 Instant 检查在原实现 11/11 通过，破坏后原十条通过、新增一条失败（3600s 对 4s），新增检查还覆盖半补充时应为 2s。RPC 会把该值转成 retry-after 信息；本轮未启动服务。隔离 mutation 引入 unused wait 的编译 warning，日志保留；没有宣称仓库 lint 或整 crate 门禁通过。

源码/测试：[crates/cognia-companion-security/src/rate_limit.rs:254](../../crates/cognia-companion-security/src/rate_limit.rs#L254)。

建议：按 token deficit/refill 精确断言 Retry-After，包括非整数 refill 的 ceil、半补充和恢复后接受；不能以 >=1 替代正确等待时间。

原始证据：`.cache/test-quality-audit-20261101/round7/rate-control.run.json`、`.cache/test-quality-audit-20261101/round7/rate-hour_wait.run.json`、`.cache/test-quality-audit-20261101/round7/rate-probe-control.run.json`、`.cache/test-quality-audit-20261101/round7/rate-probe-hour_wait.run.json`、`.cache/test-quality-audit-20261101/round7/rust-rate.plan.json`。

<a id="tea-030"></a>

### TEA-030 · Sidecar DNS guard 漏测公私地址混合回答

现有拒绝用例只返回单一私有 IP，成功用例返回两个公有 IP。把 rows.some(private) 改成仅检查 first.address，egress guard 五条与 OAuth flow 五条原测试仍 10/10 通过。新增 public/private 两种排列并调用捕获到的 socket lookup：原实现 11/11 通过，破坏后原十条通过、新增一条失败，公有地址在首位时未返回拒绝错误。实验通过 fake Agent/fetch/lookup 运行，没有发起真实 DNS 或连接；不表示原实现在接受该混合回答。

源码/测试：[sidecar/src/platform/net/egress-guard.test.ts:66](../../sidecar/src/platform/net/egress-guard.test.ts#L66)。

建议：覆盖不同顺序和地址族的混合 DNS 回答，并同时断言 all 与单地址 lookup 都在返回任何地址前 fail-closed；保留 redirect 和私网显式批准合同。

原始证据：`.cache/test-quality-audit-20261101/round7/dns-first-only-mutant.run.json`、`.cache/test-quality-audit-20261101/round7/dns-first-only-probe-control.run.json`、`.cache/test-quality-audit-20261101/round7/dns-first-only-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round7/dns-first-only.plan.json`。

<a id="tea-031"></a>

### TEA-031 · Sidecar IPv6 前缀误判普通域名，原实现可复现

isPrivateOrReservedHost 未先判定输入为 IPv6，直接检查 fc/fd/fea 等文本前缀。未修改的当前实现把 feature.example.com、fd.example.com、fc.example.com 都分类为 private/reserved，validateRemoteUrl 随即拒绝 HTTPS URL；example.com 对照正常。原 egress/OAuth 十条仍通过，新增三个普通 DNS label 的检查在未改业务源码时全部失败（总计 10 通过、3 失败）。另有直接调用原函数的 JSON 观测，未发起任何网络请求。此项是当前实现的真实误拒绝和测试缺口，区别于 TEA-028～030 的故意破坏实验；不声称这些示例域名实际解析为公有 IP。

源码/测试：[sidecar/src/platform/net/egress-guard.ts:39](../../sidecar/src/platform/net/egress-guard.ts#L39)。

建议：仅对已识别为 IPv6 的地址应用 IPv6 范围规则，保留 localhost/.local 与实际 DNS 地址检查；加入以相关字母开头的普通域名对照，再验证真实 socket lookup 的私网拒绝仍有效。

原始证据：`.cache/test-quality-audit-20261101/round7/egress-domain-prefix-probe-control.run.json`、`.cache/test-quality-audit-20261101/round7/egress-domain-prefix.plan.json`、`.cache/test-quality-audit-20261101/round7/domain-prefix-observation.json`、`.cache/test-quality-audit-20261101/round7/observe-domain-prefix.mjs`。

### 有效对照

- **CTRL-014 · Rust replay cache 满容量时的 fail-closed 检查有效**：完整模块未修改基线 5/5 通过；在满容量且均未过期时清空有效条目并接受新 assertion，rejects_new_assertions_when_all_entries_are_still_valid 准确失败，其余四条通过。有效期边界漏测不等于容量保护也无效。 证据：`.cache/test-quality-audit-20261101/round7/replay-evict_valid.log`。
- **CTRL-015 · Rust request cancellation 的 generation 清理检查有效**：完整原模块副本四条通过；删除 finish 的 generation 相等条件，让旧请求清理新 owner，stale_cleanup_does_not_unregister_replacement 原测试失败，另三条通过。未运行 HTTP 请求或完整 cognia-net crate。 证据：`.cache/test-quality-audit-20261101/round7/cancellation-stale_cleanup.log`。
- **CTRL-016 · Sidecar egress 禁止重定向的断言有效**：将 redirect:error 改成 follow，egress/OAuth 十条中的普通与显式批准私网两种 fetch 路径各有一条原测试失败（8 通过、2 失败）。这里检查传给 fetch 的策略，没有启动真实重定向 HTTP server。 证据：`.cache/test-quality-audit-20261101/round7/egress-redirect-follow-mutant.log`。

### 本轮实际运行结果

| 实验                               | 运行面                 | 退出码 | 通过 | 失败 |
| ---------------------------------- | ---------------------- | -----: | ---: | ---: |
| sidecar-baseline                   | sidecar                |      0 |   43 |    0 |
| workspace-command-error-baseline   | rust-workspace         |      0 |    6 |    0 |
| dns-first-only-mutant              | sidecar                |      0 |   10 |    0 |
| dns-first-only-probe-control       | sidecar                |      0 |   11 |    0 |
| dns-first-only-probe-mutant        | sidecar                |      1 |   10 |    1 |
| egress-redirect-follow-mutant      | sidecar                |      1 |    8 |    2 |
| replay-control                     | rust-isolated          |      0 |    5 |    0 |
| replay-early_expiry                | rust-isolated          |      0 |    5 |    0 |
| replay-probe-early_expiry          | rust-isolated          |    101 |    5 |    1 |
| replay-evict_valid                 | rust-isolated          |    101 |    4 |    1 |
| replay-probe-control               | rust-isolated          |      0 |    6 |    0 |
| rate-control                       | rust-isolated          |      0 |   10 |    0 |
| rate-hour_wait                     | rust-isolated          |      0 |   10 |    0 |
| rate-probe-hour_wait               | rust-isolated          |    101 |   10 |    1 |
| rate-probe-control                 | rust-isolated          |      0 |   11 |    0 |
| cancellation-control               | rust-isolated          |      0 |    4 |    0 |
| cancellation-stale_cleanup         | rust-isolated          |    101 |    3 |    1 |
| egress-control                     | rust-isolated          |      0 |   21 |    0 |
| egress-domain-prefix-probe-control | sidecar 原实现行为检查 |      1 |   10 |    3 |

最后一项 `egress-domain-prefix-probe-control` 的三条失败来自未修改的业务实现，是 TEA-031 的实际缺陷证据；其余 mutation 下的 1/101 属于故意破坏对照，不能与原始代码失败混淆。Node load hook 的 applied 记录证明该项只追加检查、没有改业务模块。另有直接调用原函数的四组 JSON 观测，无 DNS、HTTP 或模型请求。

fetch-interceptor 基线启动本机 HTTP/TCP 代理和子进程，检验 proxy/bypass 路由；egress/OAuth 使用 fake Agent、fetch、resolver 和 transport，不代表真实公网/SSRF 接受。Rust 缓存/限流/取消实验不涉及真实签名、token、HTTP 服务或 OS credential store。没有运行 coverage、全 sidecar lane、完整 Rust workspace 或真实 Host/provider。

复现：

```sh
rtk proxy node .cache/test-quality-audit-20261101/round7/run.cjs sidecar-baseline
rtk proxy node .cache/test-quality-audit-20261101/round7/run.cjs workspace-command-error-baseline
rtk proxy node .cache/test-quality-audit-20261101/round7/run.cjs replay-probe-early_expiry
rtk proxy node .cache/test-quality-audit-20261101/round7/run.cjs rate-probe-hour_wait
rtk proxy node .cache/test-quality-audit-20261101/round7/run.cjs dns-first-only-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round7/run.cjs egress-domain-prefix-probe-control
rtk proxy node .cache/test-quality-audit-20261101/round7/observe-domain-prefix.mjs
```

<!-- END:test-effectiveness-audit-round7 -->

<!-- BEGIN:test-effectiveness-audit-round8 -->

## 第八轮：Rust HTTP streaming 与 sidecar webhook/执行合同

原始基线：官方 sidecar runner 八文件 **60/60 通过**；SSE 与 NDJSON 两份完整原模块、全部原测试的隔离 crate **16/16 通过**（9 + 7）。Rust 的网络测试实际驱动本机 TCP/HTTP 与 reqwest；没有编译完整 cognia-net 或启动 Tauri。隔离 adapter 只复制现有 ensure_crypto_provider 函数，两个生产模块内容及原测试没有适配；版本由原 Cargo.lock 锁定，代理环境覆盖明确保存在 run metadata。

本轮新增 **2 项 mutation 证实的缺口、2 项未修改实现即可复现的缺陷、3 项有效对照、13 次测试运行**。另一次 `--no-run` 准备成功，不计作测试通过。

<a id="tea-032"></a>

### TEA-032 · Rust SSE 未终止帧的容量拒绝没有回归断言

删除 buffer.len()>MAX_FRAME_BYTES 的拒绝分支后，整份 SSE 与 NDJSON 原模块的十六条测试仍 16/16 通过。新增本机 HTTP chunked origin 发送 2 MiB 无帧边界数据：原实现 17/17 通过，破坏后原十六条通过、新增一条失败，结果为 Ok(1) 而非 FrameTooLong。SSE 原网络用例检查普通帧、尾帧和 403 body，没有覆盖未终止帧的内存上限；本轮 fixture 有限，不产生无限流或 OOM。

源码/测试：[crates/cognia-net/src/sse_stream.rs:120](../../crates/cognia-net/src/sse_stream.rs#L120)。

建议：给 SSE 增加超过 MAX_FRAME_BYTES 且无空行的实际流输入，检查具体错误和 cap；保留既有评论帧、尾帧和 HTTP 错误正文断言。

原始证据：`.cache/test-quality-audit-20261101/round8/streams-control.run.json`、`.cache/test-quality-audit-20261101/round8/sse-no-cap-mutant.run.json`、`.cache/test-quality-audit-20261101/round8/sse-cap-probe-control.run.json`、`.cache/test-quality-audit-20261101/round8/sse-cap-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round8/rust-streams.plan.json`。

<a id="tea-033"></a>

### TEA-033 · Rust SSE/NDJSON 跨 chunk 的合法 UTF-8 会损坏

SSE 与 NDJSON 都逐 chunk 调用 String::from_utf8_lossy；合法字符 é 的 c3/a9 两字节跨 HTTP chunk 时，未修改的模块把它交付成两个替换字符 ��。原十六条测试全部通过，新增两个真实本机 HTTP chunked 流检查在原实现各失败一条（16 通过、2 失败），且事件/行数量仍为 1，说明内容被静默损坏而非解析中断。fixture 以 HTTP chunk framing 分隔字节，没有依赖 TCP write/flush 恰好成为读边界或任意 sleep。原注释承认 lossy fallback，但 ASCII 用例未验证完整响应中本来合法的 UTF-8；本轮不声称任何修复方案已接受。

源码/测试：[crates/cognia-net/src/sse_stream.rs:109](../../crates/cognia-net/src/sse_stream.rs#L109)。另见 [crates/cognia-net/src/ndjson_stream.rs:118](../../crates/cognia-net/src/ndjson_stream.rs#L118)。

建议：保留原始 bytes 到完整帧/行后再解码，或用跨 chunk 的增量 UTF-8 decoder；为 SSE 与 NDJSON 分别加入多字节字符的边界排列及真正非法字节合同。

原始证据：`.cache/test-quality-audit-20261101/round8/streams-control.run.json`、`.cache/test-quality-audit-20261101/round8/streams-utf8-unmodified-probe.run.json`、`.cache/test-quality-audit-20261101/round8/streams-utf8-unmodified-probe.log`、`.cache/test-quality-audit-20261101/round8/rust-streams.plan.json`。

<a id="tea-034"></a>

### TEA-034 · Sidecar webhook 丢失配置 headers 仍全绿

原 webhook 两条只传空或 undefined headers；agent-hooks 十四条也没有验证此通道的自定义 HTTP header。删除 fetch headers 中的配置 spread 后，两文件仍 16/16 通过。新增本机 origin 捕获非空 synthetic header 的检查：原实现 17/17 通过，破坏后原十六条通过、仅新增一条失败。body 与 content-type 断言不能替代认证/路由等自定义 header 的传递合同。

源码/测试：[sidecar/src/hooks/handlers/webhook.test.ts:24](../../sidecar/src/hooks/handlers/webhook.test.ts#L24)。

建议：用本机 origin 检查非空配置 header 与 JSON body 同时到达，保留 content-type、非 2xx 和 PII redaction 检查。

原始证据：`.cache/test-quality-audit-20261101/round8/webhook-drop-headers-mutant.run.json`、`.cache/test-quality-audit-20261101/round8/webhook-drop-headers-probe-control.run.json`、`.cache/test-quality-audit-20261101/round8/webhook-drop-headers-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round8/webhook-drop-headers.plan.json`。

<a id="tea-035"></a>

### TEA-035 · Sidecar webhook 未处理进入前已取消的 signal

runWebhookHandler 只注册未来的 outer abort 事件，没有处理传入 signal 已 aborted。新增本机 HTTP origin 和预先 abort 的 controller，未修改业务源码时仍收到 1 次真实 POST（预期 0）；原十六条通过，仅新增一条失败。handlers/index 将外层 signal 直接传入该函数，因此该入口没有“信号必须尚未 abort”的前置条件。本轮只验证调用前取消，不声称在途取消、超时或重试全部失效。

源码/测试：[sidecar/src/hooks/handlers/webhook.ts:36](../../sidecar/src/hooks/handlers/webhook.ts#L36)。

建议：在关联取消信号时处理已有 aborted 状态，并覆盖调用前取消与在途取消；断言 origin 无请求/连接终止及约定的 warning，而不只检查最终 promise 完成。

原始证据：`.cache/test-quality-audit-20261101/round8/sidecar-baseline.run.json`、`.cache/test-quality-audit-20261101/round8/webhook-pre-aborted-probe-control.run.json`、`.cache/test-quality-audit-20261101/round8/webhook-pre-aborted-probe-control.log`、`.cache/test-quality-audit-20261101/round8/webhook-pre-aborted.plan.json`。

### 有效对照

- **CTRL-017 · Rust NDJSON 的超长未终止行检查有效**：删除 NDJSON 的 MAX_LINE_BYTES 检查后，原 refuses_a_single_line_that_blows_the_size_cap 失败，其余十五条通过；未修改联合基线十六条通过。这是已有 2 MiB 本机流输入的有效保护，不能把 SSE 的缺口外推到 NDJSON。 证据：`.cache/test-quality-audit-20261101/round8/ndjson-no-cap-mutant.log`。
- **CTRL-018 · Rust SSE 的最终无空行尾帧检查有效**：跳过 EOF 后的尾帧交付，原本机网络测试 streams_frames_as_they_arrive_and_reports_error_bodies 失败，另外十五条通过。真实 socket 用例虽然漏测 UTF-8/cap，仍能保护已断言的尾帧合同。 证据：`.cache/test-quality-audit-20261101/round8/sse-drop-tail-mutant.log`。
- **CTRL-019 · Sidecar tool args 的 Zod 默认值检查有效**：safeParse 成功后返回原 input、丢弃 parsed.data，parsing applies defaults and keeps valid values 原测试失败（缺 limit:20），另八条通过。没有用只比较 schema 的测试代替实际 parse/default 检查。 证据：`.cache/test-quality-audit-20261101/round8/args-discard-defaults-mutant.log`。

### 本轮实际运行结果

| 实验                               | 运行面             | 退出码 | 通过 | 失败 |
| ---------------------------------- | ------------------ | -----: | ---: | ---: |
| sidecar-baseline                   | sidecar            |      0 |   60 |    0 |
| streams-control                    | rust-isolated      |      0 |   16 |    0 |
| sse-no-cap-mutant                  | rust-isolated      |      0 |   16 |    0 |
| sse-cap-probe-control              | rust-isolated      |      0 |   17 |    0 |
| sse-cap-probe-mutant               | rust-isolated      |    101 |   16 |    1 |
| streams-utf8-unmodified-probe      | 原实现独立行为检查 |    101 |   16 |    2 |
| ndjson-no-cap-mutant               | rust-isolated      |    101 |   15 |    1 |
| sse-drop-tail-mutant               | rust-isolated      |    101 |   15 |    1 |
| webhook-drop-headers-mutant        | sidecar            |      0 |   16 |    0 |
| webhook-drop-headers-probe-control | sidecar            |      0 |   17 |    0 |
| webhook-drop-headers-probe-mutant  | sidecar            |      1 |   16 |    1 |
| webhook-pre-aborted-probe-control  | 原实现独立行为检查 |      1 |   16 |    1 |
| args-discard-defaults-mutant       | sidecar            |      1 |    8 |    1 |

`streams-utf8-unmodified-probe` 的两条失败与 `webhook-pre-aborted-probe-control` 的一条失败来自未修改实现；其余 mutation 的 1/101 是故意破坏对照。前者是本机 HTTP chunk framing 下的真实文本损坏，后者是本机 origin 实收一次 POST；不是通过 mock 自造结果。所有请求都只到本机，没有真实 provider、Ollama、Ops server 或用户数据。

### 执行清单与证据保留

当前默认 sidecar lane 发现 **293 个文件**，历史具名命令与本轮合计明确执行 **39 个默认文件**，剩余 **254 个**逐项列于 `.cache/test-quality-audit-20261101/round8/suite-progress.json`；另有 3 个 live 文件未运行。这是显式执行清单，不是 coverage、有效性比例或当前版本全绿证明。inventory helper 首次相对 import 多了一层父目录而退出 1，纠正后成功；未进入业务测试，详情在该 JSON。

全部验证完成后，可用磁盘降至约 126 MiB；仅清理本审计生成的 `round6/cargo-target` 编译输出（约 689 MiB）。确认历史证据 manifest 没有任何该目录条目，未删除运行日志、源码快照、harness、manifest 或 lock。清理前后和重建说明见 `.cache/test-quality-audit-20261101/round8/cache-cleanup.json`；后续 Rust 复现需重新编译保留的依赖和源码。没有清理其他工作区内容。

复现：

```sh
rtk proxy node .cache/test-quality-audit-20261101/round8/run.cjs sidecar-baseline
rtk proxy node .cache/test-quality-audit-20261101/round8/run.cjs streams-control
rtk proxy node .cache/test-quality-audit-20261101/round8/run.cjs sse-cap-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round8/run.cjs streams-utf8-unmodified-probe
rtk proxy node .cache/test-quality-audit-20261101/round8/run.cjs webhook-drop-headers-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round8/run.cjs webhook-pre-aborted-probe-control
```

本轮仍仅检查和记录；两个原实现缺陷尚未修复。未运行 coverage、完整 Rust workspace、完整 sidecar lane、真实 Host/provider 或跨平台接受。

<!-- END:test-effectiveness-audit-round8 -->

<!-- BEGIN:test-effectiveness-audit-round9 -->

## 第九轮：Rust allowlist/request-origin 与 MCP OAuth/host RPC

原始基线：官方 sidecar runner 七文件 **44/44 通过**；两份完整 Rust 原模块 allowlist/request-origin 的隔离测试 **15/15 通过**（7 + 8）。真实 workspace 的 `workspace_env::tests` 默认 **3/3**，开启 `workspace-env-async` 后 **5/5**；后者包含三个默认用例，不能相加成八个不同测试。异步 feature 的两条检查覆盖 current-thread runtime 响应及 none/error/panic 合同。

request-origin 的源文件与八条原测试完全不改；独立 manifest 将 reqwest 重导出的同一个 `http::header` 类型通过依赖 alias 暴露，以避免为纯分类函数编译 HTTP/TLS 栈。真实 reqwest re-export 的本地源码、hash 和行号见 `.cache/test-quality-audit-20261101/round9/header-alias-evidence.json`。该结果不是完整 companion-security crate 或 listener/tunnel 接受。

本轮新增 **3 项 mutation 证实的缺口、4 项有效对照、18 次测试运行**；两次 `--no-run` 只计依赖准备，不计测试通过。没有新增已复现的原实现缺陷；原始具名基线均通过。

<a id="tea-036"></a>

### TEA-036 · Rust inbound allowlist 漏测多个配置项的并集

七条原测试只使用零个或一个 allowlist 项。把 contains 循环改为仅检查首项，完整模块副本仍 7/7 通过。新增两个不同 CIDR、分别命中及无关地址拒绝的检查在原实现 8/8 通过，破坏后原七条通过、新增一条失败，第二网段 192.168.0.0/16 被忽略。此项是模块集合合同缺口，不是原实现已忽略后续项，也未验证其他 listener/集成测试是否另有保护。

源码/测试：[crates/cognia-net/src/inbound_policy/allowlist.rs:111](../../crates/cognia-net/src/inbound_policy/allowlist.rs#L111)。

建议：至少配置两个互不覆盖网段并置换顺序，检查每项都可命中且其他地址拒绝；将 /0、重复项和混合 bare-IP/CIDR 作为独立边界。

原始证据：`.cache/test-quality-audit-20261101/round9/allowlist-control.run.json`、`.cache/test-quality-audit-20261101/round9/allowlist-first_only.run.json`、`.cache/test-quality-audit-20261101/round9/allowlist-probe-control.run.json`、`.cache/test-quality-audit-20261101/round9/allowlist-probe-first_only.run.json`、`.cache/test-quality-audit-20261101/round9/rust-allowlist.plan.json`。

<a id="tea-037"></a>

### TEA-037 · Sidecar OAuth state 格式测试放过常量回归

randomState 的原测试只匹配 16 位 hex。将函数改为每次返回 0000000000000000，provider、loopback flow、headless 三文件的十四条原测试仍 14/14 通过。新增 32 次独立生成不复用同一常量的检查：原实现 15/15 通过，破坏后原十四条通过、仅新增一条失败。这个 probe 只证明能发现常量复用，不能证明均匀分布、完整熵或密码学安全；当前实现的随机源是 Math.random，未在本轮完成随机源安全接受。headless 流使用外部传入的 256-bit state，不能把此 mutation 外推为该来源也失效。

源码/测试：[sidecar/src/mcp/oauth/provider.test.ts:6](../../sidecar/src/mcp/oauth/provider.test.ts#L6)。

建议：保留格式 smoke，并补独立授权尝试的 state 生成合同；单独明确随机源和熵要求、通过可控随机源验证调用路径，不把重复采样通过当作安全证明。

原始证据：`.cache/test-quality-audit-20261101/round9/oauth-constant-state-mutant.run.json`、`.cache/test-quality-audit-20261101/round9/oauth-constant-state-probe-control.run.json`、`.cache/test-quality-audit-20261101/round9/oauth-constant-state-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round9/oauth-constant-state.plan.json`。

<a id="tea-038"></a>

### TEA-038 · Sidecar OAuth expiry 只校验 number，漏掉秒到毫秒换算

saveTokens 用例只检查 expiresAtMs 的 typeof。把 Date.now()+expires_in*1000 改成 Date.now()+expires_in，provider/flow/headless 十四条原测试仍 14/14 通过。新增固定 Date.now()=1000、expires_in=100 的时钟检查在原实现 15/15 通过；破坏后原十四条通过、新增一条失败，1100 对 101000。原实现换算正确；本轮没有连接 issuer、刷新真实 token 或验证 OS keyring/前端完整链路。

源码/测试：[sidecar/src/mcp/oauth/provider.test.ts:30](../../sidecar/src/mcp/oauth/provider.test.ts#L30)。

建议：使用固定时钟精确检查绝对 expiresAtMs，并明确零、缺失或异常 expires_in 时的状态更新合同；保留 token 保存和 PKCE verifier 清除断言。

原始证据：`.cache/test-quality-audit-20261101/round9/oauth-expiry-units-mutant.run.json`、`.cache/test-quality-audit-20261101/round9/oauth-expiry-units-probe-control.run.json`、`.cache/test-quality-audit-20261101/round9/oauth-expiry-units-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round9/oauth-expiry-units.plan.json`。

### 有效对照

- **CTRL-020 · Rust tunnel listener 的 loopback 与 bucket 隔离检查有效**：完整 request_origin 模块基线 8/8 通过；禁用 TunnelIngress 分支后，两条 tunnel 原用例失败（6 通过、2 失败），分别抓住 loopback 权限泄漏与 visitor 选择 rate-limit bucket。隔离 manifest 用 reqwest 实际重导出的同一 http HeaderMap 类型；没有运行真实 listener、Cloudflare 或 VS Code tunnel。 证据：`.cache/test-quality-audit-20261101/round9/origin-ignore_listener.log`。
- **CTRL-021 · Rust inbound allowlist 错误清洗与长度检查有效**：把错误文本中的 sanitize helper 改成原 entry，rejects_garbage_with_sanitized_bounded_error 原测试失败，另六条通过。多项并集的缺口不代表该文件的错误边界断言无效。 证据：`.cache/test-quality-audit-20261101/round9/allowlist-raw_error.log`。
- **CTRL-022 · Sidecar OAuth transport 的 guarded fetch 传递检查有效**：把传给 HTTP/SSE transport 的 fetch 改为 undefined，构造参数用例准确失败，另一个懒加载/unauthorized 判断用例通过。测试用 fake 构造器检查函数身份；没有进行远程 OAuth 请求。 证据：`.cache/test-quality-audit-20261101/round9/oauth-transport-no-guard-mutant.log`。
- **CTRL-023 · Sidecar host RPC 的并发乱序关联检查有效**：把按 rpcId 取出并删除改成 FIFO，现有双请求逆序回复用例失败（10 通过、1 失败）。与 TEA-024 broker 的单 pending fixture 不同，这条原测试已有足够区分能力；本轮未运行 Rust stdio Host。 证据：`.cache/test-quality-audit-20261101/round9/host-rpc-fifo-mutant.log`。

### 本轮实际运行结果

| 实验                               | 运行面         | 退出码 | 通过 | 失败 |
| ---------------------------------- | -------------- | -----: | ---: | ---: |
| sidecar-baseline                   | sidecar        |      0 |   44 |    0 |
| workspace-env-baseline             | rust-workspace |      0 |    3 |    0 |
| oauth-constant-state-mutant        | sidecar        |      0 |   14 |    0 |
| oauth-constant-state-probe-control | sidecar        |      0 |   15 |    0 |
| oauth-constant-state-probe-mutant  | sidecar        |      1 |   14 |    1 |
| oauth-expiry-units-mutant          | sidecar        |      0 |   14 |    0 |
| oauth-expiry-units-probe-control   | sidecar        |      0 |   15 |    0 |
| oauth-expiry-units-probe-mutant    | sidecar        |      1 |   14 |    1 |
| oauth-transport-no-guard-mutant    | sidecar        |      1 |    1 |    1 |
| allowlist-control                  | rust-isolated  |      0 |    7 |    0 |
| allowlist-first_only               | rust-isolated  |      0 |    7 |    0 |
| allowlist-probe-first_only         | rust-isolated  |    101 |    7 |    1 |
| allowlist-raw_error                | rust-isolated  |    101 |    6 |    1 |
| allowlist-probe-control            | rust-isolated  |      0 |    8 |    0 |
| origin-control                     | rust-isolated  |      0 |    8 |    0 |
| origin-ignore_listener             | rust-isolated  |    101 |    6 |    2 |
| host-rpc-fifo-mutant               | sidecar        |      1 |   10 |    1 |
| workspace-env-async-baseline       | rust-workspace |      0 |    5 |    0 |

所有 1/101 均是故意破坏后的预期结果，不是原实现失败。本轮没有 skipped/cancelled。provider/flow/headless 使用 fake SDK/transport；transport 的构造器记录参数，host RPC 使用内存 emit/result，不涉及真实 issuer、浏览器、Host stdio 或 token/credential store。随机 state 重复采样检查仅针对常量回归，不构成随机源安全接受。

默认 sidecar lane 仍为 293 个文件，历史及本轮显式执行 46 个，余下 247 个列于 `.cache/test-quality-audit-20261101/round9/suite-progress.json`；另 3 个 live 文件未运行。此清单不等于 coverage、全量有效性或当前全部通过。

复现：

```sh
rtk proxy node .cache/test-quality-audit-20261101/round9/run.cjs sidecar-baseline
rtk proxy node .cache/test-quality-audit-20261101/round9/run.cjs workspace-env-async-baseline
rtk proxy node .cache/test-quality-audit-20261101/round9/run.cjs allowlist-probe-first_only
rtk proxy node .cache/test-quality-audit-20261101/round9/run.cjs oauth-constant-state-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round9/run.cjs oauth-expiry-units-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round9/run.cjs host-rpc-fifo-mutant
```

本轮仅审计记录，未修改仓库业务代码或现有测试；未运行 coverage、完整 Rust/sidecar、真实 provider 或跨平台接受。

<!-- END:test-effectiveness-audit-round9 -->

<!-- BEGIN:test-effectiveness-audit-round10 -->

## 第十轮：Rust KDF/provider 状态与 sidecar 文件/Git 工具

原始基线：官方 sidecar runner 七文件 **30/30 通过**；Rust `password_kdf.rs` 与 `api_key.rs` 两份完整原模块、原测试的隔离基线 **15/15 通过**（6 + 9）；真实 workspace `cognia-core::node_runtime::tests` **6/6 通过**。workspace 结果限 macOS，Windows 专用 `CREATE_NO_WINDOW` 用例未进入该平台构建。隔离 manifest 使用根 Cargo.lock 的锁定依赖，没有初始化整个 secrets crate、OS keyring 或真实凭据。

本轮新增 **5 项问题（4 项 mutation 证实的断言缺口、1 项原实现覆盖竞态）、4 项有效对照**。完成 **23 次测试运行**；另 **3 次测试前环境阻断**保留独立记录。两次成功 `--no-run` 及一次等待共享缓存锁超时的 no-run 均不计测试执行或测试通过。累计 **43 项问题、27 项有效对照、167 条运行记录**。

<a id="tea-039"></a>

### TEA-039 · Rust KDF 的 known-vector 测试自比，未锁定算法和成本

a_known_vector_stays_stable 两次调用同一个 helper，再自验证及检查长度，没有固定期望摘要。完整原模块基线 6/6；将 TIME_COST 从 2 改为 1，或把 Argon2id 改成 Argon2i，原六条分别仍全过，PHC 字面前缀仍声称 argon2id/t=2。新增检查绕过 wrapper 常量，使用字面参数 m=19456、t=2、p=1、32 字节及固定盐直接调用锁定的 RustCrypto：原实现 7/7，两种破坏均为原六条通过、仅新增一条失败。它独立于 wrapper 的参数/算法选择，但复用同一 crypto 依赖，不是独立 Argon2 实现、外部标准向量或密码学安全证明。

源码/测试：[crates/cognia-secrets/src/password_kdf.rs:128](../../crates/cognia-secrets/src/password_kdf.rs#L128)。

建议：用经过独立确认的完整固定 PHC 向量锁定算法、成本和输出，并测试历史固定记录的兼容性；保留现有随机盐与错误口令检查。

原始证据：`.cache/test-quality-audit-20261101/round10/kdf-control.run.json`、`.cache/test-quality-audit-20261101/round10/kdf-cost.run.json`、`.cache/test-quality-audit-20261101/round10/kdf-algorithm.run.json`、`.cache/test-quality-audit-20261101/round10/kdf-probe-control.run.json`、`.cache/test-quality-audit-20261101/round10/kdf-probe-cost.run.json`、`.cache/test-quality-audit-20261101/round10/kdf-probe-algorithm.run.json`、`.cache/test-quality-audit-20261101/round10/rust-kdf.plan.json`。

<a id="tea-040"></a>

### TEA-040 · Rust provider 成对更新的原子性承诺缺少并发断言

set_provider 文档承诺 atomically，现有九条测试只在更新完成后依次读取字段。把写 key 与写 base_url 拆为两个写锁并在中间 yield，完整模块原九条仍 9/9。新增 biased join：一个任务更新，另一个用单次读锁快照观察；原实现 10/10，破坏后原九条通过、新检查读到 new-key/old-url 而失败。此项确认 writer 对单锁 reader 的合同缺口，不能推导独立 public getters 或整个 sidecar spawn 已获得一致快照；原实现本身仍用一个写锁。

源码/测试：[crates/cognia-secrets/src/api_key.rs:169](../../crates/cognia-secrets/src/api_key.rs#L169)。

建议：增加受控调度的成对状态检查，拒绝新旧字段混合；另行审查实际 consumer 是否用一次快照读取，不能用这个局部 probe 代替集成验证。

原始证据：`.cache/test-quality-audit-20261101/round10/api-control.run.json`、`.cache/test-quality-audit-20261101/round10/api-split_update.run.json`、`.cache/test-quality-audit-20261101/round10/api-probe-control.run.json`、`.cache/test-quality-audit-20261101/round10/api-probe-split_update.run.json`、`.cache/test-quality-audit-20261101/round10/rust-api.plan.json`。

<a id="tea-041"></a>

### TEA-041 · Sidecar EXDEV fallback 测试实际只走同文件系统 rename

名为 falls back to copy-then-delete on EXDEV 的用例明确只做 same-fs move。删除 EXDEV 分支的 copy/unlink、改成直接抛错，原七条仍 7/7。新增检查注入 rename 的 EXDEV，随后使用真实临时文件执行 copy/unlink：原实现 8/8，破坏后原七条通过、仅新增一条失败。该 probe 验证注入错误后的 fallback，不是实际跨设备挂载或原实现 fallback 已坏。

源码/测试：[sidecar/src/tools/builtin/file-extras/file-transfer.test.ts:47](../../sidecar/src/tools/builtin/file-extras/file-transfer.test.ts#L47)。

建议：显式制造 EXDEV 并同时断言目标字节正确、源已删除；再分别覆盖复制失败时保留源、非 EXDEV 错误传播。

原始证据：`.cache/test-quality-audit-20261101/round10/move-no-exdev-mutant.run.json`、`.cache/test-quality-audit-20261101/round10/move-no-exdev-probe-control.run.json`、`.cache/test-quality-audit-20261101/round10/move-no-exdev-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round10/move-no-exdev.plan.json`。

<a id="tea-042"></a>

### TEA-042 · Sidecar copy 的 overwrite:false 存在检查后覆盖竞态

原七条全部通过，但只检查目标在进入调用前已存在的情形。原业务源码不改，在 copyFile 包装器内、存在性检查之后用 wx 创建目标，再调用真正的 fs.copyFile：目标从 concurrent-writer-bytes 被覆盖成 source-bytes，新增保留内容断言失败（原七条通过、新增一条失败）。源码先 stat 再无排他 flag 地 copy，无法保证 overwrite:false。这里是受控 I/O 时序下复现的当前实现缺陷，使用真实临时文件；没有启动两个真实 writer 进程，也未对 rename/move 的相似路径做同等复现。

源码/测试：[sidecar/src/tools/builtin/file-extras/file-transfer.ts:29](../../sidecar/src/tools/builtin/file-extras/file-transfer.ts#L29)。

建议：复制时将 overwrite:false 落到 COPYFILE_EXCL 等文件系统排他操作，并保留竞争创建后的内容/错误断言；另行核实 rename/move 的平台适配合同。

原始证据：`.cache/test-quality-audit-20261101/round10/sidecar-baseline.run.json`、`.cache/test-quality-audit-20261101/round10/copy-overwrite-race-probe-control.run.json`、`.cache/test-quality-audit-20261101/round10/copy-overwrite-race-probe-control.log`、`.cache/test-quality-audit-20261101/round10/copy-overwrite-race.plan.json`。

<a id="tea-043"></a>

### TEA-043 · Sidecar Git repo cache 用例未检查是否重复启动探测

名为 caches the result (no re-spawn on repeat) 的原测试重复调用真实 Git，但不统计 runner 调用。禁用 validatedRepos 命中分支后，原四条仍 4/4。新增可注入 runner 计数，同 cwd 连续两次必须只执行一次：原实现 5/5，破坏后原四条通过、新检查观察到两次而失败。此项只确认顺序成功调用的 memoization 缺口，不是并发 single-flight、缓存失效或实际性能基准。

源码/测试：[sidecar/src/tools/builtin/git/run.test.ts:10](../../sidecar/src/tools/builtin/git/run.test.ts#L10)。

建议：用现有 GitRunner 注入点检查成功缓存、reset 后重探测以及失败不缓存；另行定义并发和工作目录生命周期合同。

原始证据：`.cache/test-quality-audit-20261101/round10/git-no-cache-mutant.run.json`、`.cache/test-quality-audit-20261101/round10/git-no-cache-probe-control.run.json`、`.cache/test-quality-audit-20261101/round10/git-no-cache-probe-mutant.run.json`、`.cache/test-quality-audit-20261101/round10/git-no-cache.plan.json`。

### 有效对照

- **CTRL-024 · Rust KDF 错误口令和摘要内容比较检查有效**：把 constant_time_eq 改为仅比较长度，六条原测试中两条准确失败（4 通过、2 失败）：错误口令拒绝和同长异内容比较。该对照证明功能内容检查有效，未测量执行时序，不能证明 constant-time 安全。 证据：`.cache/test-quality-audit-20261101/round10/kdf-content_compare.log`。
- **CTRL-025 · Rust API key/OAuth bearer 的空白归一化检查有效**：绕过 normalize_optional_value 的 trim 后，provider 与 OAuth bearer 两条原用例失败（7 通过、2 失败）；原测试保护带空白值与 blank 清除合同。未调用 OS keyring、真实 token 或 provider。 证据：`.cache/test-quality-audit-20261101/round10/api-no_trim.log`。
- **CTRL-026 · Sidecar diff 大输出截断检查有效**：将 headTruncate 的上限换为 patch.length，原三条中大 patch 用例准确失败（2 通过、1 失败），缺少 truncated 标记。此对照不等于所有 diff 正文/格式边界已全面检查。 证据：`.cache/test-quality-audit-20261101/round10/diff-no-cap-mutant.log`。
- **CTRL-027 · Sidecar Node 文件 hash 的实际字节断言有效**：移除 Node stream 的 hash.update 后，三条摘要用例失败（2 通过、3 失败），抓住 SHA-256、多算法和 partial-Bun 回退的空内容摘要。运行面是 Node 与 partial-Bun 回退，没有接受完整 Bun 快路径。 证据：`.cache/test-quality-audit-20261101/round10/hash-drop-bytes-mutant.log`。

### 本轮实际运行结果

| 实验                              | 运行面         | 退出码 | 通过 | 失败 |
| --------------------------------- | -------------- | -----: | ---: | ---: |
| sidecar-baseline                  | sidecar        |      0 |   30 |    0 |
| move-no-exdev-mutant              | sidecar        |      0 |    7 |    0 |
| move-no-exdev-probe-control       | sidecar        |      0 |    8 |    0 |
| move-no-exdev-probe-mutant        | sidecar        |      1 |    7 |    1 |
| copy-overwrite-race-probe-control | sidecar        |      1 |    7 |    1 |
| git-no-cache-mutant               | sidecar        |      0 |    4 |    0 |
| git-no-cache-probe-control        | sidecar        |      0 |    5 |    0 |
| git-no-cache-probe-mutant         | sidecar        |      1 |    4 |    1 |
| diff-no-cap-mutant                | sidecar        |      1 |    2 |    1 |
| hash-drop-bytes-mutant            | sidecar        |      1 |    2 |    3 |
| kdf-control                       | rust-isolated  |      0 |    6 |    0 |
| kdf-cost                          | rust-isolated  |      0 |    6 |    0 |
| kdf-probe-cost                    | rust-isolated  |    101 |    6 |    1 |
| kdf-algorithm                     | rust-isolated  |      0 |    6 |    0 |
| kdf-probe-algorithm               | rust-isolated  |    101 |    6 |    1 |
| kdf-content_compare               | rust-isolated  |    101 |    4 |    2 |
| kdf-probe-control                 | rust-isolated  |      0 |    7 |    0 |
| api-control                       | rust-isolated  |      0 |    9 |    0 |
| api-split_update                  | rust-isolated  |      0 |    9 |    0 |
| api-probe-split_update            | rust-isolated  |    101 |    9 |    1 |
| api-no_trim                       | rust-isolated  |    101 |    7 |    2 |
| api-probe-control                 | rust-isolated  |      0 |   10 |    0 |
| node-runtime-baseline             | rust-workspace |      0 |    6 |    0 |

`copy-overwrite-race-probe-control` 的 1 是**未修改业务源码下的实际缺陷**；其他 1/101 为故意破坏后的预期失败。原始具名基线全部通过，本轮测试执行没有 skipped/cancelled。临时行为检查只追加于内存加载的 sidecar 测试或隔离 Rust 副本，未改仓库现有测试。

### Cargo 环境阻断与恢复

| 尝试                             | 结果                                                | 是否进入测试 |
| -------------------------------- | --------------------------------------------------- | ------------ |
| 共享 package cache               | 180 秒等待超时，`spawnSync rtk ETIMEDOUT` / SIGTERM | 否           |
| 私有 cache 首次 workspace 解析   | 缺少 pinned cognia-services Git cache，退出 101     | 否           |
| 补入 services 后再次解析         | 缺少 pinned plugins-workspace Git cache，退出 101   | 否           |
| 补齐已存在的 public Git cache 后 | node_runtime 原基线 6/6，退出 0                     | 是           |

未中断其他 Cargo 进程。通过 APFS `cp -cR` 将已有公共 crates.io registry 及 Cargo.lock 中三个 Git 依赖的本地 cache 复制到任务私有 `CARGO_HOME`，不是指向共享可变源的 hardlink/symlink；没有复制 Cargo 凭据或用户配置，也没有网络下载。初次 KDF no-run 的 120 秒锁等待超时、后续两次成功编译和上述三次阻断分别见 `.cache/test-quality-audit-20261101/round10/dependency-setup.json`、`.cache/test-quality-audit-20261101/round10/private-cargo-home.json` 与对应 `*.run.json` / `*.log`，不计原测试失败。

### 保留的未证实候选与范围

file_info 用例名称提到 mtime，却没有直接 mtime 断言；本轮该文件原基线 3/3，但尚未做针对 mtime 的行为/mutation 验证，因此不计新问题。deny_list 源码已有 tenant 隔离及由 `SecurityStore::in_memory` 支持的 revoke/restart 检查，本轮未执行，不计有效对照或无效测试。源码与 hash 见 `.cache/test-quality-audit-20261101/round10/static-inspections.json`。

默认 sidecar lane 293 个文件，历史及本轮显式执行 **53 个**，尚余 **240 个**列于 `.cache/test-quality-audit-20261101/round10/suite-progress.json`；另 3 个 live 文件未运行。这是文件执行清单，不是 coverage、全量有效性或当前所有文件通过的证明。

复现（使用已经准备好的离线私有 cache）：

```sh
rtk proxy node .cache/test-quality-audit-20261101/round10/run.cjs sidecar-baseline
rtk proxy node .cache/test-quality-audit-20261101/round10/run.cjs node-runtime-baseline
rtk proxy node .cache/test-quality-audit-20261101/round10/run.cjs kdf-probe-cost
rtk proxy node .cache/test-quality-audit-20261101/round10/run.cjs kdf-probe-algorithm
rtk proxy node .cache/test-quality-audit-20261101/round10/run.cjs api-probe-split_update
rtk proxy node .cache/test-quality-audit-20261101/round10/run.cjs move-no-exdev-probe-mutant
rtk proxy node .cache/test-quality-audit-20261101/round10/run.cjs copy-overwrite-race-probe-control
rtk proxy node .cache/test-quality-audit-20261101/round10/run.cjs git-no-cache-probe-mutant
```

本轮仅审计与记录。没有修复业务代码或现有测试；未运行 coverage、完整 Rust/sidecar、真实账户/provider、Tauri/sidecar 进程链路、Bun 完整快速路径或跨平台接受。

记录质量检查：历史条目保留、ID/链接、实际退出码/失败名称、源码快照与原始证据 hash 校验均通过；`prettier --check` 通过。检查命令、时间、退出码与日志保存在 `.cache/test-quality-audit-20261101/round10/record-checks.json`。这些文档/台账检查不计入 23 次产品测试执行。

<!-- END:test-effectiveness-audit-round10 -->

## 尚未完成的范围

- 静态扫描的简单 matcher、无直接断言、type-only 与 source-string 队列仍需按行为合同逐项审查。
- Rust/sidecar 已完成第四至第十轮具名抽查；其余默认 lane、nested packages、live SDK/Host、全 Rust workspace、完整 Tauri/Capacitor 和其他平台尚未全面接受。
- 本任务仅检查和记录；已确认缺口的产品测试修复仍未实施。

源码一致性复查：136 个具名源码/测试/fixture，130 个与实验 hash 一致。后续源码漂移：lib/data/backup-scheduler.ts、lib/data/backup-scheduler.test.ts、lib/webdav/restore.ts、lib/webdav/restore.test.ts、lib/webdav/restore.integration.test.ts、crates/cognia-companion-rpc/src/rpc.rs；TEA-015、TEA-017 与相关 CTRL-005 的 backup/restore 结论仅适用原快照，当前版本需复验。rpc.rs 的 rate-limit 传递点已在第九轮源码复查，本轮该上下文 hash 仍一致，仍使用 retry_after.as_secs()，见 .cache/test-quality-audit-20261101/round9/context-recheck.json；不代表 RPC runtime 接受。第十轮 15 个实验目标及额外 deny_list 源码筛查快照均未漂移。仓库仍有其他会话的改动，不以全局 clean 状态作为本次结论。
