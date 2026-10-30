# 浏览器性能问题修复与真实对照

日期：2026-10-28。诊断基线：`9ee9de7667`，共享工作区另有其他任务的未提交改动。用户随后授权“修复这些问题，需要有真实的性能对比”；六项本地浏览器问题已修改源码并补上回归测试。未提交、未更换用户浏览器资料或 Docker 容器。下方保留修复前诊断，历史缺陷描述不代表修复后的实现。

## 第二轮优化结果：本次请求

用户在追加诊断后授权“进行优化，然后要有真实数据对比”。本轮保留三项优化；自动适配的试验未通过行为保护检查，未进入产品。所有测量使用第一轮修复后的源码快照作为基线，不能把第一轮像素预算收益再次计入本轮。

### 已实现

1. **有界诊断缓存。** 每页 console/network 分别保留最多 500 条、256 KiB 序列化预算；超长字符串限制 4096 字符。保留最新记录，drain 首条用 `droppedBefore` 报告丢弃数量，单条裁剪标记 `truncated`，重读后计数归零。凭据脱敏仍先于保留/裁剪，页间隔离和请求详情策略保留。
2. **去掉 Chromium 重复采集。** 在同一个初始化脚本中先声明由 runtime 负责诊断，再安装 overlay，保证模式声明先执行。local/cloud/user-Chrome 的诊断使用既有 Playwright 采集；不再安装另一套 console/fetch/XHR/DOM 推送采集。embedded WebView 默认、元素选择、快照、录制和凭据行为保留。
3. **健康视频纯观看时暂停周期辅助抓图。** 只适用于 `open + healthVersion=1`、unmanaged、无控制租约且已有初始截图的观察者。首次截图失败仍重试；手动刷新可抓图；失去健康视频时立即补抓。接管仍先获取新 fence/proof，控制中继续原来截图与续租，managed、legacy、未验证媒体保持原策略。没有修改 Rust 的 proof、输入前像素验证、尺寸检查或 lease/fence 校验。

### 真实 Chromium 对照

同一 Apple M4 Pro、Node v26.12.1、Chromium 153.0.8010.12；快照与最终源码各预热一次后采样 10 次，最终四条测量命令顺序运行，期间没有本轮编译或测试。基线服务 SHA-256 为 `e8dca4f03ec0f6ac507c1697e27ba2422a8a41b5105bea41db8390840e2ede5e`，最终为 `bf702e32e26e9bb352aef5513b563dc4330613f7239d4f4451cb933b09cdefb6`；服务、page-scripts、overlay 测量前后哈希一致。

| 指标与负载                                                                                  | 基线               | 优化后             | 判定                                                     |
| ------------------------------------------------------------------------------------------- | ------------------ | ------------------ | -------------------------------------------------------- |
| 单页无人读取时，累计 6000 条约 1 KiB 日志、2500 次真实 loopback HTTP 响应后的诊断 JSON 总量 | 6,680,298 B        | 324,308 B          | −95.1%；这是诊断数据量，不能称总进程内存下降 95%         |
| 上述负载保留的 console/network 条数                                                         | 6000 / 2500        | 246 / 500          | 字节/条数界限生效，最新记录保留；报告丢弃 5754 / 2000 条 |
| 100 条对象日志负载：页面 logging 循环，中位数 ± MAD                                         | 21.40 ± 0.25 ms    | 1.85 ± 0.05 ms     | −91.4%，超过 20% 和噪声阈值                              |
| 同一对象日志样本：页面 TaskDuration 增量，中位数 ± MAD                                      | 25.987 ± 0.345 ms  | 4.143 ± 0.079 ms   | −84.1%，超过 20% 和噪声阈值                              |
| 每个对象日志样本的 overlay JSON 序列化 / 空推送                                             | 100 / 2            | 0 / 0              | runtime 在两组每个样本都收到完整 100 条日志              |
| 实际 Chromium→画布出画，中位数 ± MAD                                                        | 59.992 ± 0.004 FPS | 59.996 ± 0.015 FPS | 持平，符合帧率保护条件                                   |

日志缓存的 10 个连续批次用于验证增长曲线，不能当作 10 次独立内存运行。post-GC Node heap 增量记录为约 72.97 MB→65.95 MB，包含 Playwright、请求与其他对象，仅作归因数据；没有达到本轮 20% 阈值，也没有总应用 RSS 或长期总内存有界的结论。

对象日志是带较大可序列化 payload 的合成压力负载，改善不能外推到所有页面操作。画布每组另外 10 个三秒样本、30 次真实点击均收到，帧率不降；输入到画布中位数为 35.2→30.2 ms，改善不足预设 20%，因此只作为无明显退化的检查，不增加新的输入延迟优化承诺。传帧/输入仍使用 Playwright evaluate/binding，未包含 Rust media poller、Tauri IPC 或 WKWebView 出画。

### Docker 调度证据和未保留的试验

实际 baseline/final hook 运行十个 60 秒窗口：预热初始截图各 1 次，后续每分钟辅助截图 RPC 调用数为 **12→0**，十个窗口合计 **120→0**。此处使用 fake clock 和外部 RPC fixture，是真实 hook 的调度对照，**不是 Docker CPU、guest 编码或输入延迟实测**。当前 Docker/Colima socket 仍不存在；需要可用的更新后容器才能完成这部分真实 guest 前后对比。

fit-to-width 的隔离试验尝试过滤 `data-*` 属性变化。真实 Chromium 的 CSS 规则 `body[data-compact] #wide` 改变布局后，原实现会从 0.8 恢复到 1；过滤方案停在 0.8 并错误地认为没有待测变化。保护条件失败，方案仅存在缓存探针中，产品的适配逻辑保留。当前约 8 ms/秒的已测布局成本不构成放宽正确性约束的理由；本轮没有该项新增性能收益。

### 验证与复现

- 166 项 Jest 与 229 项完整 runtime 测试通过；健康/legacy/managed、初始抓图失败、控制中抓图/续租、消费 proof、超长 UTF-8 数据、逐页读取和脱敏回归均保留。十窗口调度对照另 1 项通过。未运行覆盖率。
- 全库 `pnpm typecheck`、`pnpm lint`、i18n lint/sort，以及修改路径格式/空白检查通过。最新 full static-export gate 仍在 agent-codebuff/agent-crush 报告 14 个既有 Node-only import，不在本轮范围；没有完整生产构建结论。
- 独立 wiring/test-gap/i18n 检查已处理阻塞项。官方 stager 已刷新 runtime 资源。最新 Tauri 只读 status 为 ready，不能沿用上一轮 bridge 不可达的状态；本轮未操作该既有原生会话的用户页面，没有声称新的 WKWebView 端到端验收。
- 真实浏览器测试曾在 teardown 报 `ENOTEMPTY` 并留下进程，原因是 fixture 先删 profile 后关 Chromium。已改为 await `closeAll` 后删本轮临时目录，删除一个重复 teardown；业务断言未删减。修正后完整 229 项通过。此前其他 WebSocket 间歇失败的全部原因仍未确认。

本轮缓存目录为 `.cache/browser-perf-round2-2026-10-28/`。完整源码快照与初始 diff 保留于 `baseline/`、`baseline-manifest.json`、`initial-diff.patch`；最终数据是 `comparison-final.json`、`baseline.json`、`result.json`、`paint-{baseline,result}-1.json`、`screenshot-counts.json`、`fit-experiment.json`。初始结果保存在 `provisional/`；正式顺序与退出码见 `matched-run.json`。没有选择最快一轮作为结论。

```sh
rtk proxy node .cache/browser-perf-round2-2026-10-28/run-matched.mjs
rtk pnpm test --config .cache/browser-perf-round2-2026-10-28/jest.config.mjs --runInBand
rtk proxy node .cache/browser-perf-round2-2026-10-28/fit-experiment.mjs
```

## 第一轮修复结果与真实对照

实测使用实际 `RemoteChromiumService`、Playwright Chromium，以及第二个真实 Chromium 内运行的项目 `createFramePainter`、帧解析和输入队列。鼠标从画布经实际 `dispatchInput` 送入被浏览页面，随后通过 JPEG 解码和画布像素变化检测出画。传帧使用 Playwright `page.evaluate`，输入使用 binding；未经过 runtime HTTP/media 长轮询、Rust poller、Tauri IPC 或 WKWebView。因此数据覆盖实际 Chromium 截屏/JPEG→画布解码出画与 service 输入路径，不是原生 Tauri 的端到端数据。

主要对照场景：浏览器为跨屏清晰度按 2× 启动，当前面板只需要 1× 物理像素；同一 1280×720 CSS viewport、合成页面、JPEG quality=80、相同帧率配置。Apple M4 Pro、macOS arm64、Node v26.12.1 上连续运行基线与最终版本，采样期间不运行本轮编译或测试。每组预热后取 10 个 3 秒样本，各进行 30 次鼠标点击。统计中位数和 MAD；预先规定改善至少 20%，且差值超过两组较大 MAD 的两倍，出画帧率下降不得超过 10%。

| 指标                           | 修复前中位数 ± MAD  | 修复后中位数 ± MAD  | 变化           |
| ------------------------------ | ------------------- | ------------------- | -------------- |
| JPEG 有效载荷                  | 11.370 ± 0.001 MB/s | 4.153 ± 0.0004 MB/s | −63.5%         |
| 串流 Chromium 进程树 CPU 秒/秒 | 1.176 ± 0.019       | 0.316 ± 0.009       | −73.1%         |
| 画布 Chromium 进程树 CPU 秒/秒 | 0.949 ± 0.034       | 0.350 ± 0.004       | −63.1%         |
| 输入到画布更新                 | 54.80 ± 0.95 ms     | 34.05 ± 0.80 ms     | −37.9%         |
| 实际画布出画                   | 60.011 ± 0.013 FPS  | 59.997 ± 0.006 FPS  | 噪声范围内持平 |

四项改善均超过预设实际意义和噪声阈值。此收益针对“启动密度高于面板所需密度”的场景；原本需要 2× 的面板保留完整 2560×1440 输出，另用 3 个真实画布样本验证，不承诺该场景同样降低 CPU。两组 30 次输入均在实际页面计数中收到，CSS 坐标头仍是 1280×720；截图检查文字可读。

最后消费者离开另做每组 10 个 3 秒样本，2× 浏览器保持同一动画页面。基线按旧 native unsubscribe 的效果停止消费者 ACK；修复版调用实际 `stopScreencastConsumer`：

| 指标                             | 修复前        | 修复后        |
| -------------------------------- | ------------- | ------------- |
| 取消消费后的 CDP 截屏事件        | 59.997 FPS    | 0 FPS         |
| Chromium CPU 秒/秒，中位数 ± MAD | 0.914 ± 0.033 | 0.078 ± 0.017 |
| 页面与表单值                     | 保留          | 保留          |

取消观看后的 CPU 时间下降约 91.5%；页面仍保留，未靠关闭会话实现。原始数据与统计：`.cache/browser-perf-fix-2026-10-28/comparison-final.json`、`paint-{baseline,result}-1.json`、`paint-result-2.json`、`idle-{baseline,result}.json`。源快照在该目录的 `baseline/`；最终服务 SHA-256 为 `e8dca4f03ec0f6ac507c1697e27ba2422a8a41b5105bea41db8390840e2ede5e`，测量期间源码未变化。连续复测的六个命令均退出 0，环境、源码哈希和各命令耗时见 `final-run-environment.json`；此前样本保留于 `before-final-matched-rerun/`，没有选择其中最好的一轮作为最终结果。

复现命令：

```sh
rtk proxy node .cache/browser-perf-fix-2026-10-28/paint-bench.mjs baseline 1 10
rtk proxy node .cache/browser-perf-fix-2026-10-28/paint-bench.mjs result 1 10
rtk proxy node .cache/browser-perf-fix-2026-10-28/paint-bench.mjs result 2 3
rtk proxy node .cache/browser-perf-fix-2026-10-28/idle-bench.mjs baseline
rtk proxy node .cache/browser-perf-fix-2026-10-28/idle-bench.mjs result
rtk proxy node .cache/browser-perf-fix-2026-10-28/summarize.mjs
```

### 已实现的修复

- ACK 保留同一帧 sequence，错误时可取消地重试，并有错误预算、短 RPC deadline 和 generation 检查；不重放输入。poller 结束通过 channel 通知前端，前端按订阅身份恢复，隐藏窗口时暂停。
- 旧 viewport 同步在停流前重新核对 active page；直播密度调整在同一 CDP 上更新输出边界，保留 CSS 坐标、质量和帧序列。恢复/切页不会让旧请求停止新串流。
- 动态切屏探针额外发现 CDP 拒绝在活动串流上再次 start。实现已改为同一 CDP 上串行 stop/start，清除旧 pending ACK，并在等待期间核对页面与 generation。真实 2×→1×→2× 切换及切换后的点击通过，失败记录为 `paint-live-transition-red.log`，通过记录为 `paint-live-transition.json`。
- 每个消费者有独立 streamId，迟到 unsubscribe/stop/start 无法替换或停止新消费者；最后消费者离开会停止 producer 并释放媒体 publisher。停止失败保留清理任务，初次启动失败及时返回，任务随 runtime generation 结束或显式 shutdown 收束。
- 扩展重启恢复当时仍有效的最新消费者，既不复活已退休的旧请求，也不丢失重启期间的新请求。
- DevTools 按稳定 source 共享在途工作，切换轮询频率也不叠加请求；console/network 各自接收成功结果，应用隐藏时暂停。
- 既有输入限制、凭据隔离、页面 owner 和 Docker 控制 lease/proof 校验未削弱。官方 stager 已生成新 runtime 资源。

### 验证与未通过的边界

- Jest：10 suites，169 tests 通过；workspace-runtime 全部 227 tests 通过；`cognia-local-browser` 108 tests 与 native browser module 13 tests 通过。
- 修改路径 ESLint、格式/空白检查、i18n lint/sort 通过；冻结后再查 ESLint/Prettier 的结果见 `lint-final-frozen.log`、`format-final-frozen.log`。独立 native、wiring、测试缺口和 i18n 审查的修复阻塞项均已处理。没有运行覆盖率或提交代码。
- 完整 `pnpm typecheck` 仍有 18 个错误，分布在其他 7 个路径；完整 lint 在 `scripts/plugin/context-surface.mjs` 和 `tests/bot-e2e/fixtures/plugin.mjs` 失败；static-export gate 报告 agent-codebuff/agent-crush 下 14 个 Node-only import。这些不在本次修改范围，没有改写它们来制造绿色结果。
- 实际 Tauri launch 被现有 Tauri JS/Rust plugin 版本不匹配和 native bridge pin gate 拦截，当前 bridge 仍不可达；Docker colima socket 不存在。121 个 Rust 测试包含 native 编译和订阅流程，却不等于真实 WKWebView 输入/出画验收。没有生产 build 或 Docker/Selkies 性能提升结论。
- 磁盘在 native 测试后不足 1 GiB；仅清理了日志精确对应、已退出且无打开句柄的本轮旧测试可执行文件，记录在 `owned-test-artifact-cleanup.json`。没有清理共享目录或用户数据。后续完整原生验收需先解决上述仓库启动门槛并提供足够空间。

所有日志位于 `.cache/browser-perf-fix-2026-10-28/`：`frontend-final.log`、`runtime-tap-final.log`、`rust-final.log`、`native-final.log`、`scoped-lint-final.log`、`typecheck.log`、`lint.log`、`static-export.log`、`tauri-launch.log`、`stage-runtime.log`。红灯证明保留为 `rust-red.log`、`service-red.log`、`poll-red.log`；首次性能结果保存为 `initial-*`，最终统计为 `comparison-final.json`。

一次全 runtime 并发运行与额外浏览器探针重叠时，两个 WebSocket 场景失败并留下未退出的测试进程。只终止了由本轮测试日志和进程树确认的子进程，保留为 `runtime-concurrent.log`；失败场景隔离运行 2/2 通过。后续一次串行运行的 `off, the default, reports nothing` 也失败且未正常结束，记录为 `runtime-final.log`。最终不同时运行浏览器性能探针，采用 TAP、`--test-concurrency=1 --test-timeout=45000`，227/227 通过，没有修改这些测试的源码或断言。此前不稳定运行的根因尚未确认，不能据一次通过宣称它们已被修复。

## 下一轮候选：2026-10-28 追加检查

以下保留用户追问“还有什么可以优化的吗”时的诊断记录。该阶段只做源码检查、两个隔离的真实 Chromium 诊断探针和报告更新；随后授权的实施及实验判定见本文顶部“第二轮优化结果”。候选表描述的是实施前状态，不代表当前实现。

| 优先级 | 候选                                          | 当前证据与建议                                                                                                                                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | runtime 日志与网络摘要设置容量上限            | 页面 `console` / `network` 是普通数组，只在读取时清空。真实页面无读取时，三轮分别积累 600→1200→1800 条日志、250→500→750 条网络记录；请求详情 Map 的 200 条上限没有限制这些数组。先按条数和字节数设置有界保留，并明确报告截断；尤其要覆盖窗口后台、后台标签和没有打开 DevTools 的情况。                                                                            |
| 2      | Docker 健康视频流中的辅助截图改为按需         | 当前 streaming 分支仍在上次抓图结束后等 5 秒再抓完整截图；`capture` 执行 Base64 和完整像素解码，并持有共享桌面 guard。可以在已确认媒体健康且纯观看时减少辅助抓图，接管、回退和 native 输入前立即补新 proof。lease renewal、失效检查、fence、单次 proof、完整像素校验和输入前尺寸复核均需保留。当前没有 Docker 实测收益。                                          |
| 3      | 减少 fit-to-width 的重复布局测量              | 当前 damage 会调度最多约每 150 ms 一次 fit 评估；DOM 脏时每秒可把 zoom 临时重置为 1 后测量。2000 节点、宽度不变但持续改属性的真实页面，每 3 秒执行 19–20 次评估、6 次布局，布局耗时 23.5–24.8 ms。值得研究更精确的尺寸/布局失效通知，保留真实宽度变化、溢出、导航及切屏行为。                                                                                     |
| 4      | Chromium 模式停用未被消费的 overlay 采集/推送 | `OVERLAY_TRANSPORT_SCRIPT` 把推送出口置为空函数，但 overlay 默认仍开启 console/network/snapshot 推送及 DOM watcher。真实页面 200 条日志同时进入 runtime 与 overlay 各 200 条，约 4.55 秒形成 16 个 console 和 8 个 snapshot 推送，序列化 21024 个字符后交给空出口。应按 backend 配置需要的 hook，保留 embedded WebView、录制、选取、凭据保护和 runtime 自身日志。 |
| 5      | 串流缓冲区拷贝与截图解码调度                  | 编帧、latest-store、Rust HTTP 结果转 Vec、前端 frame slice、Blob 前复制均存在完整数据复制；Docker 像素解码还同步占用 async 执行线程。先用 native profile 区分编码、解码、复制和线程阻塞成本，再决定哪些所有权拷贝可省或哪些 CPU 工作应隔离；保留 Blob 跨引擎兼容和完整截图验证。当前没有这些改动的前后性能数据。                                                  |

第 1 项是源码和实际缓冲增长共同确认的稳定性缺口：此前窗口隐藏仍定期 drain 会部分掩盖它，暂停后台读取后更需要补上服务端界限。读取后数组确实归零，关闭页面也会释放记录，因此这是“页面仍存活且缺少消费时的无界保留”，不是所有场景都会持续泄漏的结论。

第 3 项探针另用**固定相同 0.8 zoom、关闭自动适配**作为成本归因对照，三个样本各为 0 次额外布局。它失去了自动适配语义，不能作为可交付优化或收益承诺。当前测出的布局成本约 8 ms/秒，说明存在额外工作，也说明这个合成负载尚不足以解释严重卡顿。第 4 项只关闭 push 的对照仍保留两份 200 条日志；console 推送为 0，snapshot 仍有 1 个启动时已排队的任务。完整去重需要在安装 hook 前配置，而不是只把出口改为空函数。

来源：[runtime 日志采集](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:1529)、[数组 drain](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:2416)、[辅助截图调度](/Users/bytedance/Project/cognia-next/hooks/automation/use-sandbox-desktop.ts:245)、[截图完整验证](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/cua_sandbox/desktop_session.rs:243)、[fit 调度](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:2232)、[fit 布局读取](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/page-scripts.mjs:175)、[Chromium 推送空出口](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/page-scripts.mjs:17)、[overlay hook 安装](/Users/bytedance/Project/cognia-next/lib/browser/overlay.injected.js:2930)。

诊断命令与原始结果位于 `.cache/browser-perf-fix-2026-10-28/`：

```sh
rtk proxy node .cache/browser-perf-fix-2026-10-28/buffer-growth-probe.mjs
rtk proxy node .cache/browser-perf-fix-2026-10-28/next-candidates.mjs
```

两条命令均退出 0，分别保留 `buffer-growth-probe.json/.log` 与 `next-candidates.json/.log`；源码哈希前后一致。使用新建临时 profile 和本机 fixture，结束后关闭实例并清理本轮临时 profile；没有读取用户 profile、启动 Docker 或修改已有会话。fit 仅每种状态 3 个三秒样本，overlay 每种状态一次 200 条日志负载；这些是候选归因和可复现计数，未按正式性能验收的十样本/噪声阈值判定收益。

## 修复前的定位与处理顺序（诊断阶段）

本地浏览器除了有资源优化空间，还存在可触发画面停更的恢复和并发缺口。优先处理停更与停流生命周期，再讨论清晰度、帧率和轮询预算。上一轮 Selkies 修复针对 Docker 桌面，未覆盖这里的本机 Chromium JPEG 串流。

| 顺序 | 位置与触发条件                                      | 已有证据                                                                                                                                              | 建议方向                                                                                       |
| ---- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | 本地帧 ACK 在 runtime 清除 pending 之前失败         | 实际 Chromium/runtime 注入丢失首个 ACK 后，3 秒收到 180 个底层 damage 事件，但只发布首帧，6 次媒体长轮询均无新帧；重放该 ACK 后，随后 3 秒发布 181 帧 | 同一 session/runtime generation 内保留待确认帧，有限退避重试；失败预算耗尽后明确结束并恢复串流 |
| 2    | viewport 同步通过入口检查后，等待 resize 时发生切页 | 确定性屏障下，B 已成为 active 且拥有串流；随后 A 的旧同步请求返回，B 的串流变为 null                                                                  | 在停流前重新检查页面与串流 generation；旧请求不能停止后来页面的串流                            |
| 3    | 最后一个帧消费者取消订阅                            | Rust 只停止 media poller；实际 Chromium 在不再收到消费者 ACK 后仍生成 180 帧/3 秒，显式 stop 后为 0 帧                                                | 最后消费者离开时停止 producer 并释放媒体 publisher；迟到的取消请求不能停止新订阅               |
| 4    | media 请求连续失败后恢复，但 runtime 进程未退出     | 源码确认 poller 耗尽预算后退出，却没有向前端发出结束信号；前端仍保留非空 frameSubscription                                                            | 传递订阅结束原因，清理对应订阅并在仍需观看时退避重订阅                                         |
| 5    | 最高连接显示器密度高于当前窗口所需密度              | 实际相同合成页面：2× 比 1× 的像素数为 4 倍，JPEG 字节速率约 2.60 倍，浏览器进程树 CPU 时间约 3.02 倍                                                  | 研究展示密度/像素预算和可调整串流分辨率，保留跨屏清晰度与会话状态                              |
| 6    | DevTools drain 请求变慢，或应用窗口转入后台         | 实际 hook 探针：9 秒积累 14 个未完成 RPC；后台且工具折叠时 18 秒仍发起 8 次 RPC                                                                       | single-flight；每一路独立处理成功结果；根据窗口可见性和工具栏统计需要调度                      |

### 1. ACK 丢失后的停更

调用链：

- [bridge.rs:456](/Users/bytedance/Project/cognia-next/crates/cognia-local-browser/src/bridge.rs:456) 在确认前推进 media cursor，ACK 失败分支只记日志，没有保留重试任务。
- [client.rs:215](/Users/bytedance/Project/cognia-next/crates/cognia-local-browser/src/client.rs:215) 的 control 请求没有应用层重试。
- [browser-service.mjs:2773](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:2773) 必须匹配 pending sequence 并完成 CDP ACK，才清除 pending、发布下一帧。
- [runtime-server.mjs:434](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/runtime-server.mjs:434) 的媒体读取只返回比 cursor 新的帧。没有新发布时正常返回空；这不会触发 Rust 的媒体错误预算。

仅 ACK 响应丢失、服务端实际上已经处理成功时，不能据此判定冻结。真正退出进程、切页或重新订阅也可能恢复。本次探针注入的是 ACK 尚未送到 runtime 的失败分支；没有实际执行 Rust poller，Rust 调用端缺少重试的结论来自源码。

恢复不得重放键鼠事件、重启共享 Chromium 或关闭用户页面。重试 ACK 需要绑定原 session 和 runtime generation，并正确处理“服务端已处理、响应丢失”的歧义。

### 2. resize 与切页竞态

[browser-service.mjs:3474](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:3474) 已经拒绝对非 active 页发起同步；“后台页面直接同步就会停掉前台流”这个初始判断被源码反驳。

剩余问题在检查之后的异步等待：A 通过检查，等待 `page.setViewportSize`；B 在此期间被激活并建立串流；A 随后执行 [3629 行](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:3629) 的无条件 `stopScreencast(sessionId)`，发现当前页面已不是 A，因此不再启动串流。探针用实际两个 Chromium 页面，并在实际 resize 调用外加确定性等待屏障复现，最终 active=B、stream=null。

应防止旧同步请求影响后来的前台页面，同时保留 viewport/frame sequence 对齐，避免旧画面配新坐标。简单删除 `synchronizeFrame` 会破坏已有正确性约束。

### 3. 取消消费没有停止截屏

[local-client.ts:199](/Users/bytedance/Project/cognia-next/lib/browser/local-client.ts:199) → [local.rs:809](/Users/bytedance/Project/cognia-next/src-tauri/src/browser/local.rs:809) 只删除 Rust StopHandle。runtime dispatcher 当前没有对应 stop 操作；它的 latest-frame 存储也不知道消费者已经离开。

local 模式在已经有 pending 的情况下，仍会替换 queued event 并确认后续 CDP damage 帧，见 [browser-service.mjs:2704](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:2704)。因此不能假设“停止 ACK 就等于停止编码”。缓存有界，这不是无限帧队列或已经证实的内存泄漏。

需要停止视频 producer，同时保留 owner、页面、登录状态及后台 agent 所需的浏览器会话。取消订阅的异步操作还需要识别原订阅，避免旧取消请求停掉刚恢复的新订阅。

### 4. poller 退出没有通知前端

[bridge.rs:484](/Users/bytedance/Project/cognia-next/crates/cognia-local-browser/src/bridge.rs:484) 在连续 media 错误达到预算后返回；[local.rs:794](/Users/bytedance/Project/cognia-next/src-tauri/src/browser/local.rs:794) 记录日志并移除 native 记录。前端 [shared-local-browser.ts:577](/Users/bytedance/Project/cognia-next/lib/browser/shared-local-browser.ts:577) 却仍认为 frameSubscription 存在，后续同步也不会重新订阅。

这与真正的 runtime 进程退出不同：后者已经有 `session.closed` 通知。此项是同一进程内传输失败后的恢复缺口，本轮未在真实 native shell 注入连续 media 失败。

### 5. 高分屏成本与持续 JPEG 传输

[local-render-scale.ts:36](/Users/bytedance/Project/cognia-next/lib/browser/local-render-scale.ts:36) 采用所有连接显示器中的最高密度，范围 1–4。这是为了跨屏保持清晰度，不能简单当作错误。当前本地 screencast 使用至少 quality=80、`everyNthFrame=1`，没有本地 maxWidth/maxHeight，见 [browser-service.mjs:2698](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:2698) 和 [2760 行](/Users/bytedance/Project/cognia-next/services/workspace-runtime/src/browser-service.mjs:2760)。

实际服务、相同 1280×720 CSS viewport、相同合成动画页面，每种密度 3 次独立会话、每次采样 3 秒，结果为中位数：

| 指标                       | 1×        | 2×         |
| -------------------------- | --------- | ---------- |
| JPEG 实际尺寸              | 1280×720  | 2560×1440  |
| 帧率                       | 59.97 FPS | 59.67 FPS  |
| 每帧 JPEG                  | 113,842 B | 297,834 B  |
| JPEG 有效载荷字节速率      | 6.83 MB/s | 17.77 MB/s |
| 浏览器进程树 CPU 秒/实际秒 | 0.433     | 1.305      |
| CPU 秒/秒的 MAD            | 0.023     | 0.012      |

这是 loopback/IPC 前的 JPEG 有效载荷，不是外网带宽；CPU 是该测试 Chromium 进程树的时间增量，不含 Tauri 画布解码。两种密度在此负载下都接近 60 FPS，所以数据证明成本差异，不能证明用户现场掉帧，也不能承诺某个优化幅度。

需要按当前展示尺寸、显示器和交互状态设计预算，并验证文字清晰度、切屏、截图及输入坐标。不得通过自动重启共享 Chromium 来修改密度，否则会丢失页面状态。首轮校准误用了内部 `renderScale` 字段，已保留为 `calibration-incorrect-option.json` 并排除；最终结果使用公开 `deviceScaleFactor` 且断言实际生效。

### 6. DevTools 轮询和后台展示

[use-browser-devtools.ts:128](/Users/bytedance/Project/cognia-next/hooks/browser/use-browser-devtools.ts:128) 使用 `setInterval`，不等待上次 drain 完成。console/network 使用 `Promise.all`，单路失败还会使另一条成功的 drain 结果没有被接收；runtime drain 会用 `splice(0)` 清空数据，因此需要独立处理成功结果。

[local-chromium-preview.tsx:460](/Users/bytedance/Project/cognia-next/components/browser/local-chromium-preview.tsx:460) 在工具折叠时仍每 6 秒读取两路，这可能用于工具栏计数，不能直接删掉；当前调度还没有 document.hidden 条件。应明确活动窗口、工具展开和统计刷新各自需要的更新频率。

本地 hook 的另一个探针确认：两个仍活动挂载的 owner 在 document.hidden 时，会收到同一 active-page 帧的两次回调；`useSharedLocalBrowser` 没有可见性参数，[shared-local-browser.ts:579](/Users/bytedance/Project/cognia-next/lib/browser/shared-local-browser.ts:579) 对所有 listener 广播。至少存在回调及包解析/复制的 fan-out；实际是否发生多次 JPEG 解码取决于各 pane 的 viewport 检查，不能一概而论。

**边界修正：** 普通 dock 换面板或折叠经由 [context-workbench.tsx:2565](/Users/bytedance/Project/cognia-next/components/context-workbench/context-workbench.tsx:2565) 的 React Activity 清理 effects，browser panel 又被标为 exclusiveSurface。因此不能声称普通折叠 dock 一定继续解码。这里应关注应用窗口后台化，以及没有进入 Activity hidden 的多个活动展示面。

## Docker 桌面仍值得继续测量的两处

1. [use-sandbox-desktop.ts:243](/Users/bytedance/Project/cognia-next/hooks/automation/use-sandbox-desktop.ts:243) 在 Selkies 模式仍定期获取完整辅助截图。纯观看且实时流已验证健康时，可以研究使用轻量状态检查、按需截图，并在回退/接管/原生输入时立即获取新的 proof。必须保留 lease renewal、blur/expiry、fence、单次 proof 及输入前尺寸校验。当前没有 Docker CPU/延迟数据，不能认定这就是现场主因。
2. [desktop_session.rs:243](/Users/bytedance/Project/cognia-next/crates/cognia-automation/src/cua_sandbox/desktop_session.rs:243) 的 async capture 内同步完成 base64 和完整图片解码。较大截图可能占用 async executor；可研究有并发上限的阻塞任务或复用现有解码执行设施。不能删除完整解码、像素预算或拿旧图替代输入前校验。锁与撤销顺序须单独验证。

embedded WebView 当前已有 ref 驱动的矩形测量、rAF 合并、未变化跳过更新和隐藏时 park，没有证据支持优先重写这些机制。本轮没有验证 native WebView 真实 CPU、视频播放或输入延迟。

## 验证范围与复现

- `rtk pnpm test --config .cache/browser-perf-audit-2026-10-28/jest.config.mjs --runInBand`：2 suites，3 个诊断探针通过。它们确认当前行为，不表示缺陷已修复。
- `rtk pnpm test --runInBand --runTestsByPath hooks/browser/use-browser-devtools.test.ts hooks/browser/use-shared-local-browser.test.ts lib/browser/shared-local-browser.test.ts lib/browser/frame-painter.test.ts lib/browser/local-input-queue.test.ts lib/browser/local-render-scale.test.ts lib/browser/local-viewport-scheduler.test.ts components/browser/local-chromium-preview.test.tsx`：8 suites，113 tests 通过。
- `rtk proxy node .cache/browser-perf-audit-2026-10-28/service-probe.mjs`：实际 `RemoteChromiumService` 和 Playwright Chromium，独立临时 profile，密度对照与无消费者探针。
- `rtk proxy node .cache/browser-perf-audit-2026-10-28/ack-loss-probe.mjs`：实际 Chromium、MediaLatestStore，ACK 丢失/恢复和 resize/切页竞态。

环境：macOS arm64、Node v26.12.1、playwright-core 1.63.0、Chromium 153.0.8010.12；合成页面，无外部站点、用户资料或登录态。原始结果和日志在 `.cache/browser-perf-audit-2026-10-28/`，包括 `summary.json`、`service-results.json`、`ack-loss-results.json`、`poll-probes.log` 和 `focused-tests.log`。服务源码测量前后 SHA-256 相同。

诊断阶段的 Tauri bridge 为 bridge_unavailable，Docker colima socket 不存在，因此当时没有 native 输入到出画、真实 Docker/Selkies 验收或产品优化前后对照。该阶段仅诊断与报告，未构建应用或清理共享缓存。随后授权的源码修复、真实浏览器层对照和仍受阻的原生验收见本文顶部。
