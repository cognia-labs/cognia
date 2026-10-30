# 浏览器四项问题修复与真实对照

日期：2026-10-29。用户授权修复上一轮对抗性审查的 F1–F4，优先串流卡死与控制权竞态，保留控制权和输入安全校验并提供前后数据。四项修复均已实现，未提交或部署，也未更换用户浏览器资料或 Docker 容器。

## 修复行为

1. **串流 teardown 不再无限占用串行队列。** 退役旧帧监听、pending ACK 和排队帧后，对旧 CDP 的 stop/detach 分别设置默认 500 ms deadline；超时仍尝试 detach，并允许新 CDP 接管。直接替换、先 stop 再 start、viewport synchronization 和过期 attach 的清理路径均覆盖；迟到成功或失败不会退役新流。deadline 不是强制取消所有 Chromium 内部工作，也不保证整个 Chromium 进程失活时仍能恢复。
2. **claim/release 回包绑定原租约。** viewer 保留生命周期 epoch，hook 的条件释放还会核对当前 token/fence，因此在新租约首帧准备期间也不能误释放它。释放通知按已发布租约身份延迟交付，覆盖旧释放回包、重复空释放、获取失败、连接切换和卸载；正常的当前 claim 失败仍释放它自己的租约。
3. **重新验证立即撤销旧健康状态。** iframe load/恢复可见时发布 `connecting`、轮换 nonce、恢复辅助抓图；旧 nonce 不能重新打开健康状态。收到当前握手的有效健康报告后才恢复 `open`。原有首次输出/心跳 deadline、legacy 协议兼容和 managed 策略保留。
4. **诊断丢失和截断可见。** 共享类型增加 optional metadata；Console/Network 显示中英双语丢弃数量及逐条截断标记。标记位于长正文/URL 前方，避免被长内容挤出视口。滚动缓存淘汰记录时会累计并迁移丢失数，清空后重置；保留容量限制与脱敏。

复用现有 service、hooks 和 panels，未新增生产模块或控制通道。没有修改 Host 的 lease、fence、单次 frame proof、时效、尺寸、owner 或输入前验证，也没有重放输入。

## 真实 Chromium 恢复对照

Apple M4 Pro、48 GiB、macOS arm64、Node v26.12.1、Chromium 153.0.8010.12。基线是本轮修改前源码快照；服务 SHA-256 `bf702e32e26e9bb352aef5513b563dc4330613f7239d4f4451cb933b09cdefb6`，最终 `c0cf41f899d91d654368508d4800eaedea776b7bad5f4643d5c49e7cd88f9fee`。两组测量期间服务源码未变化，最终源码与官方 stager 资源一致。

实际 service/CDP 访问隔离的 Chromium 动画页面，第二个 Chromium 使用项目 `decodeRemoteBrowserFrame` 和 `createFramePainter` 解码 JPEG 并画到 canvas。故障注入只延迟旧 CDP stop/detach，Chromium 与 runtime 保持运行。传帧使用 Playwright evaluate/binding，**未经过 HTTP media 长轮询、Rust、Tauri IPC 或 WKWebView**。

每场景各一次预热、十次测量，固定 2500 ms 观察窗口。主指标从替换请求到真实画布首帧，报告中位数 ± MAD。基线超时样本按 censored 记录，不伪造有限恢复时间或百分比。

| 场景             | 修复前                 | 修复后                               |
| ---------------- | ---------------------- | ------------------------------------ |
| 旧 stop 不返回   | 0/10 在 2500 ms 内恢复 | 10/10 恢复，514.08 ± 1.80 ms         |
| 旧 detach 不返回 | 0/10 在 2500 ms 内恢复 | 10/10 恢复，514.43 ± 0.39 ms         |
| 无故障重启       | 10/10，16.21 ± 0.38 ms | 10/10，13.38 ± 0.89 ms；仅作保护检查 |

每组 30 次经 service/CDP 的实际页面点击均准确交付一次；故障解除后的串流继续出画，表单值保持。基线故障样本在观察窗口结束后才释放注入阻塞，再执行同样的输入/页面状态保护检查；不能把这解释为基线在卡死期间也能正常操作。

另用真实 Chromium 两个 CDP session 验证：旧 session stop/detach 后，新 session 继续产生帧，页面状态保留。这项验证支持隔离旧 CDP 的恢复方式。没有新增通用 FPS、CPU、总内存或正常交互延迟提升承诺。

## 控制权、健康与双语 UI 对照

实际 hooks/viewer 各十次相同序列，外部 RPC 使用可控 fixture，jsdom 与 fake clock 用于确定性交错。这些是调度/控制权数据，**不是 Docker 或 native 延迟实测**。

| 指标                                 | 修复前    | 修复后                                    |
| ------------------------------------ | --------- | ----------------------------------------- |
| 旧 claim 回包误释放新租约            | 10/10     | 0/10                                      |
| iframe load 后继续公开旧 `open`      | 10/10     | 0/10，立即进入重新验证                    |
| 重载后无新健康报告的 14 秒内辅助抓图 | 每次 0 次 | 每次 3 次，首次在 revalidation 后立即调度 |

重载时 iframe 的首次输出 deadline 仍是 15 秒；“立即”指公开 readiness 撤销和抓图调度，不代表整个黑屏时间或 native 延迟变成 0 ms。

Console/Network 使用真实 Chromium 采集的有界数据：分别保留 500 条、报告丢弃 101/21 条，末条正文/URL 均截断。取代表性保留行，传给**实际生产 React panels、UI primitives 和 next-intl**，每种语言/版本各十次渲染检查：

| 实际 Chromium UI | 修复前 | 修复后                        |
| ---------------- | ------ | ----------------------------- |
| 丢弃提示         | 0 处   | 2 处，准确显示 101/21 条      |
| 截断标记         | 0 处   | 2 处，英文/中文均位于可见视口 |

这是一份组件 fixture，使用最小布局样式和 platform-detection stub，未加载完整 Cognia app。渲染次数不作为独立性能样本。中文截图：`.cache/browser-four-fixes-2026-10-29/panels-result-zh-CN.png`。

## 验证结果与范围

- **269 项 Jest / 9 suites 通过；237 项完整 runtime 测试通过。** 包含输入 proof 消费、过期/尺寸/fence 拒绝、凭据隔离、managed/legacy、首次截图失败、辅助截图失败保留有效控制、nonce、迟到 stop/detach 成功与失败、直接替换、旧 release、重复 release、首帧准备期 claim 和 ring rollover。
- 原始四项回归先失败，再通过。独立审查补出的重复释放与首帧准备期竞态也各有正确原因的红灯记录。没有删除既有断言、放宽输入检查或运行覆盖率。
- 当前全库 `pnpm lint`、`pnpm lint:i18n`、`pnpm i18n:build:check`、`pnpm i18n:sort:check` 通过；修改路径 ESLint、格式/空白检查通过。官方 stager 已刷新 134 个文件。
- 最新 `pnpm typecheck` 仍有 **9 个错误，均在本轮之外的两个 managed-desktop 测试文件**；本轮修改路径没有类型诊断。static-export gate 仍报告 agent-codebuff/agent-crush 的 14 个 Node-only import。没有完整生产 build 或打包结论。
- Docker/Colima socket 仍不存在，未启动 daemon、替换容器或操作现有 native 用户会话。真实 Docker/Selkies CPU、媒体故障恢复及 WKWebView 端到端验收仍未完成。
- 独立审查限定三轮；最后的首帧准备期发现由条件 token/fence 释放和实际交错回归收敛，未继续增加模型审查轮次。未运行外部模型 CLI。

## 数据与复现

机器可读汇总：[2026-10-29-browser-four-fixes-comparison.json](2026-10-29-browser-four-fixes-comparison.json)。完整原始数据、源码快照、红绿测试日志和探针保留在 `.cache/browser-four-fixes-2026-10-29/`，属于本机证据，不是产品随包资源。

```sh
rtk proxy node .cache/browser-four-fixes-2026-10-29/recovery-bench.mjs baseline
rtk proxy node .cache/browser-four-fixes-2026-10-29/recovery-bench.mjs result
rtk proxy node .cache/browser-four-fixes-2026-10-29/hooks-compare.mjs
rtk proxy node .cache/browser-four-fixes-2026-10-29/panels-browser.mjs
rtk proxy node .cache/browser-four-fixes-2026-10-29/summarize.mjs
```

恢复时间测量应顺序运行，期间避免本轮编译和测试。原始数据是 `recovery-{baseline,result}.json`、`hooks-comparison.json`、`panels-browser.json`；核验源码与打包资源用 `comparison-final.json` 的 integrity 字段。早期 locale spy、测试 matcher 失败与并发改动造成的早期 gate 失败保留缓存日志；初次 ESM harness 不兼容记录在工具输出中，没有把这些当作产品红灯。
