# Cognia CLI 接口封装缺口审计

日期：2026-10-28（Asia/Shanghai）。范围：非 TUI CLI。下方原始审计保留研究基点 `9ee9de76678140ff47f1cc8a77cde12a4cb91d8d` 的证据；包含其他会话尚未提交的协议/RPC 改动。用户随后授权实现，最新修复状态见文末“实现跟进”。没有对真实 Host 发起操作，也未验证发布版本。

## 结论与已有能力

Cognia 已有通用接口封装，主要缺口在**契约保真和自动化工作流**。优先修复参数被改写、请求 schema 选错、幂等键撞名、敏感日志及 operation 兼容，随后完善脚本输出和文件/事件接口；不建议先另写一套业务命令清单。

P1 表示优先修复的行为/敏感数据问题，P2 表示可绕行的封装/工作流缺口，P3 表示文档/演进缺口；不是线上事故等级。

| 入口                    | 已有能力                                                                                                                             | 边界                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Rust `cognia host`      | categories/resources/commands/schema/call/doctor/events/skills；完整 schema 验证、dry-run、风险确认、幂等键、分页聚合、输出校验/投影 | loopback Headless service，不承担远程 device pairing |
| Node `cognia-agent api` | call/list/groups/describe/schema/request；生成 resource aliases；host records、DPoP pairing、TLS pin、relay fallback、operation wait | 编译时静态索引，须适配不同 wire                      |
| Node 专用命令           | run/auth/config/prompts/provider/sdk/worker/account-sync/eval/security 等                                                            | 本次检查接口共用层，不逐个验收业务 arm 或 agent loop |
| Desktop CLI bridge      | 插件开发、handoff、provider 等限定能力                                                                                               | 不是通用高权限 RPC 代理                              |

来源：[Rust CLI](../../crates/cognia-cli/src/cli.rs)、[Node dispatcher](../../cli/src/cli/index.ts)、[ADR-0171](../content/docs/en/adr/0171-the-cli-speaks-the-protocol-not-a-copy-of-it.md)、[ADR-0078](../content/docs/en/adr/0078-cli-app-bridge.md)。

## 接口盘点

| 表面                                      | 当前数量 | 解释                                                        |
| ----------------------------------------- | -------: | ----------------------------------------------------------- |
| manifest descriptors                      |    1,753 | 含未在这两类 RPC wire 发布的能力，不能直接用作 CLI 缺口分母 |
| Headless concrete RPC                     |      964 | `/internal/_rpc/{具体名称}`                                 |
| Device concrete RPC                       |      783 | `/api/_rpc/{具体名称}`，是前者子集，不能相加                |
| Rust embedded catalog                     |      964 | 数量一致仅证明枚举                                          |
| Node generated index                      |      944 | internal 944、http 772、79 groups                           |
| manifest 中没有这两类 concrete RPC 的条目 |      789 | 需逐项确认 runtime/authority 边界，不能直接认定应远程暴露   |

Rust 九类：sessions 60、agents 109、tasks 110、automation 93、connectors 72、extensions 108、knowledge 28、development 288、system 96。workflow、plugin、scheduler、git、browser 等已有通用调用入口；缺少手写专用命令不等于没有 API。

来源：[manifest](../../protocol/companion-commands.json)、[Headless OpenAPI](../api/headless-service-api.openapi.yaml)、[Device OpenAPI](../api/mobile-companion-api.openapi.yaml)、[Rust catalog](../../crates/cognia-cli/assets/host-command-catalog.json)、[Node index](../../cli/src/api/generated/command-index.ts)。完整差集/源文件 SHA-256：`.cache/diagnostics/cli-api-audit-2026-10-28/inventory.json`。

## 已确认缺口

### F1 · P1 · debug 输出 credential request body

[runCall](../../cli/src/cli/api-command.ts#L243) 将 `JSON.stringify(built.body)` 前 2,000 字符写入 stderr，没有字段脱敏。隔离 mock 调用 `host_provider_credential_set`，日志包含 synthetic `apiKey` 全值。证明范围是**显式 debug 下的请求字段日志泄露**，没有证明默认输出泄露、真实凭据外传或权限绕过。

建议：记录 command/wire/request ID/字段结构，递归脱敏 sensitive values。验收：嵌套对象/数组放 synthetic canary，debug/error 输出均不含 canary。`host show` 的脱敏不能保护此路径。

### F2 · P1 · service/device 请求 schema 被混为一套

[generator](../../scripts/build/gen-cli-api-index.mjs#L170) 使用 `onHeadless ?? onDevice` 选择唯一 schema；[entry type](../../cli/src/api/types.ts) 只存一套 flags；[runCall](../../cli/src/cli/api-command.ts#L180) 在选择 transport 前验证请求。实际上 [device overrides](../../crates/cognia-headless-contract/src/lib.rs#L11) 区分主机绝对路径和 workspace 坐标。

对共同 RPC 的顶层字段盘点：303 个 device schema 含 service schema 没有的字段；其中 73 个还存在 service 必填字段已不属于 device schema 的情况。**不是 303 个命令全部不可用**。

```text
git_status internal: required repoPath
git_status http:     required workspaceId; optional relativePath

api call git_status --data '{"workspaceId":"workspace-a"}'
→ CLI: git_status is missing repoPath
```

device `git_clone` 需要 `workspaceId/destinationRelativePath/adminLease`，索引却要求 `destination`。`adapter_instance_mutate --admin-lease ...` 也被本地判定为未知字段。`--data` 无法绕开旧必填字段检查。

建议：保留 per-wire schema，确定 wire 后按相应 schema 验证，不合并成宽松的字段并集。验收：同命令 internal/device 正反例均到 mock dispatch，device body 不接受绝对路径。

### F3 · P1 · false/null boolean 参数被改写为 true

[parseArgv](../../cli/src/cli/args.ts#L139) 对 boolean flag 先设置 `true`，随后才处理 inline value；[runCall](../../cli/src/cli/api-command.ts#L198) 的二次解析将命令 boolean 字段加入此集合。真实 parser + apiCommand + mock transport 已复现：

```text
--muted=false       → body.muted = true
--a2ui-enabled=null → body.a2uiEnabled = true
```

`--data '{"id":"bot-a","muted":false,"a2uiEnabled":null}'` 可绕行，通用 `--no-muted` 尚未实现。建议明确 bare/inline/value/null 语法；验收覆盖 api call、derived command 和相邻 flags。

### F4 · P1 · body intent key 与 transport 幂等键撞名

[generator reserved flags](../../scripts/build/gen-cli-api-index.mjs#L37) 未保留 `idempotency-key`，但 [GLOBAL_FLAG_NAMES](../../cli/src/cli/format.ts#L38) 包含它。[buildRequestBody](../../cli/src/api/validate.ts#L174) 跳过该 flag，[invokeCommand](../../cli/src/api/invoke.ts#L133) 把它用于 transport metadata。

15 个索引条目有同名 body flag，包括 `execution_run_create`、`pet_item_purchase`、`files_library_upload_commit`、`workflow_handoff_create`。

```text
api call execution_run_create --mode cascade --text test --idempotency-key intent-a
→ execution_run_create is missing idempotencyKey
→ Fix: pass --idempotency-key <string>  # 重复建议无法生效的输入
```

body key 可用 `--data` 绕行；业务 intent key 不应自动假设与 transport UUID 同生命周期。建议拆开这两个概念，并共用 reserved flag 定义。验收分别观察 body key/header UUID 和重试行为。

### F5 · P1 · Node 返回值失真，cancelled operation 被视为成功

[readBody](../../cli/src/api/transport.ts#L83) 将 scalar/null 包装为 `{value:...}`。fake fetch 实测 `false`、`7`、`"hello"`、`null` 全部改形。当前 Rust catalog 有 188 个纯 null、32 个 boolean、26 个 string、10 个 integer 输出契约；这是类型数量，不是已执行命令数。

[pollOperation](../../cli/src/api/invoke.ts#L230) 又使用 `operation.result ?? operation`，实测合法 `result:null` 变成整个 operation document。

独立审查还发现遗漏反例：服务端 canonical cancelled operation 是 `done:true,status:"cancelled"`，可以没有 result/error（[serializer test](../../crates/cognia-companion-security/src/operations.rs#L261)）。pollOperation 只拒绝 error/failed 状态，因此返回 ok:true；补充真实 apiCommand + mock transport 后，`--wait --json` 的退出码也实测为 0。这会让脚本把取消误当作任务成功，不能只写成泛泛的取消体验建议。

另有输出一致性缺口：device 的 [completed_rpc_response](../../crates/cognia-companion/src/api.rs#L1300) 返回 `{requestId,result,operationId?}`，internal handler/relay 返回领域值，Node execute 未统一领域结果/metadata 边界。保留 raw wire envelope 本身不是服务端错误，但脚本切 wire 后须改变取值路径。

建议：body 保持 unknown 原值，execute 的领域结果/metadata 分开，raw request 保持 wire 文档；读取结果用字段存在性。验收同值经 internal/direct-device/relay/wait 均保真；canonical cancelled fixture 必须保留取消语义，明确终态和脚本退出码。

### F6 · P1 · Rust operation consumer 仍读取旧形状

服务端 [internal_rpc_handler](../../crates/cognia-companion/src/api.rs#L1225) 用 [Operation::running](../../crates/cognia-companion-security/src/operations.rs) 回答 202：`{id,done,status,metadata}`；operation GET 使用同一 document，完成时结果在顶层 `result/error`。

Rust [run_call](../../crates/cognia-cli/src/commands/host.rs#L888) 只读取 `operationId`，因此当前 202 不能令它切到 operation GET，会继续同 key POST。[parse_operation_response](../../crates/cognia-cli/src/commands/host.rs#L1686) 还要求旧 `receipt.result/body`，不能读取新顶层 result。现有 `accepted_rpc_is_completed_through_the_operation_route` 测试仍构造旧 `{operationId,status,receipt}`。

同 key POST 可能最终读到完成结果，**不能说所有异步调用必败，也没有证明副作用重复执行**。但正常 polling/accepted metadata 已落后于服务端契约。

建议共享 canonical Operation，必要时兼容旧格式。验收用真实 Operation serializer 生成 fixture，验证一次 POST 后 GET 到 succeeded/failed/cancelled，并覆盖 no-wait。本项是 server/client source trace，未执行 Rust rebuild 或真实 Host smoke。

### F7 · P1（快照漂移）· Node index 漏 20 个当前 RPC

`pnpm cli:api:check` 实际退出 1：`gen-cli-api-index: cli/src/api/generated/command-index.ts is out of date.`。catalog 两项测试失败，独立差集计算一致。

20 项分为 browser submission 3、connector 6、org 8、person 3；device wire 缺其中 11 项（browser 3 + org 8），名单见 inventory.json。

这是**当前 working tree 产物未同步**，不能据此断言已发布包也缺失。drift gate 已存在，应在相关协议工作稳定后重新生成并验证。本次未修改他人正在编辑的生成产物；重生成也不能解决 F1–F6。

### F8 · P2 · Node schema/validation 是浅层字段摘要

[ApiCommandFlag](../../cli/src/api/types.ts) 未保留完整 nested schema、bounds/pattern/format 和 output schema；`api schema` 只输出 `describeEntry(...).fields`，不是完整 JSON schema。

[buildRequestBody](../../cli/src/api/validate.ts#L131) 检查 object 和部分 required/enum，却不遍历 data 未知字段，不验证 data 字段类型和 nested 约束。以下输入均实测获本地 ok:true：

```json
{"id":42,"muted":"false","unknownField":"extra"}
{"id":"bot-a","activationTtlMs":-1,"trigger":{}}
```

服务端仍有 [contract validation](../../crates/cognia-companion/src/remote_execution.rs#L688)，所以不是服务端校验或权限绕过。缺口在 discovery 和拒绝前移；Rust host 已有完整 contract validator。

另外，Node list/describe 来自静态表，没有 host-aware catalog/schema fallback。可人工 `api request GET /api/catalog`，但不自动更新 api call。本次没有实时 version-skew 实验；将动态协商作为建议，不宣称已复现协议版本不匹配故障。

### F9 · P2 · approval 的 Fix 命令不存在

[preflight](../../cli/src/api/invoke.ts#L74) 和 [failureFix](../../cli/src/cli/api-command.ts#L160) 提示 `cognia-agent host lease <command>`，但 [hostCommand](../../cli/src/cli/host-command.ts#L135) 没有 lease 分支。真实 handler 实测退出 2：`unknown host subcommand "lease"`。

底层已有 `host_admin_lease_issue`，不是缺 lease API。建议提供真实可执行的 api call 引导或安全 orchestration wrapper，保留 Host 上的人类确认，配合 F2 修复字段差异；不能提升 caller authority 来绕过。

### F10 · P2 · raw HTTP escape hatch 不能代表完整 REST/文件/流封装

[runRequest](../../cli/src/cli/api-command.ts#L283) 只接受 JSON body，调用 transport 时只传 timeout；raw request 两种 transport 都不转发 idempotency header。mock 实测 `api request ... --idempotency-key <uuid>` 的 header 仍为空。因此不是 F7 未索引写命令的通用替代。

响应统一 text + JSON parse；synthetic CSV 200 被当作成功的 `{__nonJsonBody:...}`，非 JSON 内容还截断为 500 字符。不能作为可靠 binary download/CSV export/multipart upload/SSE/WebSocket client。

[route registry](../../protocol/companion-api-routes.json) 已有 media、batch export、human-input files、workflow events 等接口；不是每个 route 都必须手写 CLI，但不能以 api request 存在证明它们已经封装。建议按真实用户路径补 JSON/raw/file/stream mode、允许的 headers 和 content types。

### F11 · P2 · 脚本失败信息和总 deadline 不完整

[emitFailure](../../cli/src/cli/errors.ts) 仅写文本 stderr；`--json` 下非法 git_status 仍是空 stdout + 文本错误。远端常见错误共用退出 1，没有结构化 failure envelope。Rust host 已有结构化错误和细分退出码。

[failureFromResponse](../../cli/src/api/transport.ts#L123) 丢弃 Problem 的结构化 details/retryable/operationId 和 Retry-After。synthetic 410 实测丢失 details.replacement；wait 还简化 operation error。

[invokeCommand/pollOperation](../../cli/src/api/invoke.ts#L133) 为 execute 和后续 polling 分配新预算，每次 poll 又使用完整 timeout，没有端到端 deadline。fake clock 复现 timeoutMs=1000 的完整调用累计 2400ms。**API help 明确说 per-request budget**，所以应报告缺少总 deadline/源码注释误导，不能说违反已声明的总超时承诺。DPoP token acquisition 也在 httpCall timeout 之外。

建议提供稳定 JSON failure 和完整 Problem metadata，明确 per-request/total budget，统一取消语义；不要机械给所有写操作添加重试。

### F12 · P2 · Node 分页聚合、device events 和 relay-only 异步观察不闭合

Node session_list 实测只发一次请求并输出 nextPageToken，没有 all/paginate aggregator，也没有 device events subscribe/watch/reconnect/cursor 的非 TUI 命令；raw HTTP request 不消费 WebSocket/SSE。

这是 workflow/convenience 缺口：手动 pageSize/pageToken 已可翻页；Rust host call --paginate 和 host events --since 已有本机 service 实现。

[withRelayFallback](../../cli/src/api/transport.ts#L375) 只给 execute 提供 relay；operation GET/raw routes 仍需要 direct address。host login 的 relayLoginNote 已告知此限制，应视为已知拓扑限制，不是未披露的安全漏洞。建议补 bounded pagination、重复 token 检测、event cursor/reconnect，再定义 relay-only 异步观察能力。

## 避免误报与建议顺序

- 789 个无 concrete RPC 的 manifest 条目不是缺失 API 数；manifest internal 标签也不等于存在 /internal/_rpc 路由。
- 没有手写 workflow/plugin/browser command 不等于没有 API。
- Device/service authority 差异是安全边界，不能扩宽 CLI bridge 或降低凭据要求。
- Rust 已有完整 schema、dry-run、风险确认、pagination、events、output validation，不能列为整个 CLI 的空白。
- ADR-0175 的 resource/verb grammar、dotted names 和统一 Page/Problem/Operation 不能仅凭 Accepted 状态当成已落实。当前源代码仍有 underscore names、alias fields 和分裂的 consumers；这是 P3 文档/迁移信息，不建议先大规模改名。

| 批次 | 工作                         | 验收                                                                                                                         |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1    | F1–F6；协议工作稳定后处理 F7 | canary 不泄漏；per-wire 正反例；false/null round-trip；双幂等键；scalar/Operation 保真；canonical server fixture；index gate |
| 2    | F8–F11                       | full schema；可执行 approval；JSON failure/Problem metadata；raw/file mode；deadline/取消故障注入                            |
| 3    | F12；按需业务 shortcuts      | 多页/重复 token；事件断线续传；direct/relay-only matrix；真实 desktop/headless smoke                                         |

每项先补行为失败用例，按独立边界拆修复。Node/Rust 共享契约与语义，不必为表面统一重写已有功能。

## 验证与局限

- pnpm cli:api:check：退出 1，索引漂移。
- 12 个相关 Jest suites：**11 passed / 1 failed；243 passed / 2 failed，245 tests**。失败均是 catalog 与 manifest/OpenAPI 不一致；其余通过不代表覆盖到上述反例。
- `.cache/diagnostics/cli-api-audit-2026-10-28/probe-results.json`：当前源 parser/validator/command/transport 的隔离断言。注入 fake fetch/Host，stub 的只是未使用的默认连接/登录/home lookup；未用真实凭据。
- Rust F6 为 owning server serializer + consumer source trace。没有 cargo test/rebuild、全仓 lint/typecheck/build 或真实 Host/device/relay smoke，不将它们标为通过。本次仅新增研究文档。
- CodeGraph 因无 index 不可用，使用 rg/owning-source reads，没有初始化索引。磁盘空间在研究中从约 1.7GiB 降至约 100MiB，不启动大型构建。
- 缓存附件未入源控；清除后可根据本文命令/body/预期反例补正式 co-located tests。后续 PR 不应依赖缓存证据。

复现（repository root）：

```bash
rtk proxy pnpm cli:api:check
rtk proxy pnpm test --runInBand --runTestsByPath \
  cli/src/api/catalog.test.ts cli/src/api/validate.test.ts \
  cli/src/api/invoke.test.ts cli/src/api/transport.test.ts \
  cli/src/api/connect.test.ts cli/src/api/relay-transport.test.ts \
  cli/src/cli/api-command.test.ts cli/src/cli/api-dispatch.test.ts \
  cli/src/cli/host-command.test.ts cli/src/cli/args.test.ts \
  cli/src/cli/format.test.ts cli/src/cli/errors.test.ts
rtk proxy node .cache/diagnostics/cli-api-audit-2026-10-28/inventory.mjs
rtk proxy node .cache/diagnostics/cli-api-audit-2026-10-28/build-probe.mjs
rtk proxy node .cache/diagnostics/cli-api-audit-2026-10-28/probe-bundled.mjs
```

## 对抗性审查

已按 doubt-driven 执行 fresh-context review：reviewer 只收到本文、研究契约和 source/probe 路径，没有收到作者的 ledger Decisions 或推理过程。任务为 cli_audit_adversarial，当前模型继承；不是跨模型审查。

| 轮次 | 审查发现                                       | 核验与分类                                                                                                                   | 处理                                                           |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1    | 遗漏 cancelled operation 被 Node wait 视为成功 | Valid + actionable。重新读取 server canonical serializer、pollOperation、apiCommand，并补隔离 probe，确认 ok:true 且退出 0。 | 补入 F5，并加入 canonical cancelled fixture/脚本退出语义验收。 |

第 2 轮仅复核修改后的 F5、退出语义与审查记录，reviewer 返回“无剩余 actionable issues”，达到 bounded review 的停止条件。用户于 2026-10-28 明确选择“跳过（保留独立审查结果）”；跨模型补审未执行。其余原始分类未被 reviewer 报告为需要撤回；这不等于通过全部真实环境验收。

## 实现跟进 — 2026-10-28

用户已授权按 P1、P2 顺序修复上述十二类缺口，补齐回归并重新对抗性审查；跨模型继续跳过。原始审计的失败结果属于修复前快照，以下记录当前工作区实现和验证范围。

| 缺口 | 修复后行为                                                                                                                                                    | 主要回归位置                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| F1   | debug 只记录 wire、command、字段名；raw query 不进入 debug 或路径校验错误。                                                                                   | `api-command.test.ts` 的 credential/query canary，包括非法路径。                           |
| F2   | 先选 wire，再按 service/device 的独立完整 schema 构造和验证参数。                                                                                             | `types.test.ts`、`validate.test.ts`、`api-command.test.ts`。                               |
| F3   | 显式 boolean false、nullable null 保留原值。                                                                                                                  | `args.test.ts`、`validate.test.ts` 和构建产物进程测试。                                    |
| F4   | body 使用 `--body-idempotency-key`，全局 `--idempotency-key` 独立进入 header；共享保留 flag 清单。                                                            | generator、validator、command 双键断言。                                                   |
| F5   | scalar/null、device result envelope、canonical cancelled/error terminal state 保真，失败不再退出 0。                                                          | `transport.test.ts`、`invoke.test.ts`、`api-command.test.ts`。                             |
| F6   | Rust 读取 canonical id/done/result/error 并兼容旧 Operation；receipt 404 不再重新 POST 写操作。                                                               | `host.rs` 内 canonical fixtures 和缺失回执测试。                                           |
| F7   | 重新生成索引，当前 964 internal / 783 device，漂移检查通过。                                                                                                  | catalog/spec 一致性断言与 `cli:api:check`。                                                |
| F8   | 保留 standalone nested/circular schema、输入/输出校验；`--live` 获取有权限的 Host catalog/schema，版本不匹配明确拒绝。                                        | generator、validate、live discovery、catalog filters。                                     |
| F9   | approval 提示改为真实的 `api call host_admin_lease_issue`，仍由 Host 决定授权。                                                                               | preflight 和 CLI remedy 断言。                                                             |
| F10  | JSON/raw file/multipart、受限 headers、text/bytes/stream 响应与原子保存；pinned HTTPS 在 EOF 前交付首块。                                                     | request 回归、真实本地 TLS 持续流测试、构建产物 binary save。                              |
| F11  | JSON failure 保留 Problem/retry metadata；总预算贯穿鉴权、请求和轮询；取消覆盖 key import、RTC handshake、challenge/token/401 refresh、JSON/text/error body。 | 明确 red→green 的取消测试，断言无迟到 RPC、立即关闭 RTC，返回 timeout。                    |
| F12  | bounded pagination、重复 token 检测；direct/relay events cursor/reconnect/resync；原子的 watch ready/replay/live 边界；operation-get 按当前身份读取回执。     | Node/RTC 事件测试、Host 实际 Watch pump/operation-get handler、跨 device/person/org 拒绝。 |

新增模块仅用于独立生命周期：`events.ts` 管理连接、游标与重连；`api-flags.json` 共享运行时和生成器的保留参数。其余逻辑扩展现有模块。`cli/package.json` 补齐现有 CLI 构建链已经引入的两项音频运行时依赖，版本与 root 一致。

### 取消、流与重放的验收细节

- handshake 取消在 RTC 尚未完成连接时就关闭已创建的 transport；key import 完成后也不能创建迟到连接或派发 mutation。
- 401 刷新取消不能被吞成原始 auth failure；`DOMException`、自定义取消 reason 和响应体中途取消均归为 timeout，后续 RPC/重试数不增长。
- 本地 pinned HTTPS 返回首块后保持连接不结束；客户端可以在 EOF 前读取首块，取消后下一次读取拒绝。
- Host 使用 `kind:"watch"` 接收频道和可选 cursor，先发送 `event-watch-ready`，再投递筛选后的 replay，随后处理 live。客户端丢弃 barrier 之前的 live，防止高序号抢先导致 replay 被去重丢失。
- wildcard 过滤和 canonical family acknowledgment 共用 Host 的 exact/trailing-star 语义；ack 后推进超过原 acknowledgment deadline 仍不会误失败。
- relay 读取 operation 使用 `operation-get` 控制帧，保留 device/person/org 的现有 ownership 检查；不通过重放原 mutation 获取回执。

### 实现后的独立审查

| 审查           | 可执行发现                                                                                            | 处理                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Node boundary  | raw query 日志和非法路径错误回显；header 大小写；relay retry advice；live description/filter/groups。 | 均核验成立并修复；补 canary、header、metadata 和 filtering 回归。                           |
| Event replay   | wildcard 事件被精确匹配丢弃；canonical family acknowledgment 不能覆盖具体频道。                       | 共用 channelMatches；补 direct/relay 和 acknowledgment timer 回归；边界复核无剩余具体问题。 |
| Runtime wiring | 新 events、schema/catalog、operation-get 和 watch frame 的运行时接线。                                | 未发现具体接线缺口；仅源码审查。                                                            |
| Test audit     | 缺鉴权/响应体取消及 Host 实际 handler 测试。                                                          | 新增 challenge/token/refresh/body、真实 Watch pump 与 operation-get 授权测试。              |

用户多次明确跳过跨模型；未调用外部模型 CLI。最终检查结果和仍未验证的范围在下方更新，不将同模型独立审查当作真实部署验收。

### 上一阶段验证结果

| 检查               | 实际结果                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 相关 Jest          | **16 suites / 479 tests 全部通过**，包括 auth challenge/token/refresh、两种共享鉴权 waiter 顺序、非协作响应流、direct/relay 剩余预算、取消后的迟到派发。                                                                 |
| 生成器             | **71 tests 全部通过**；顺手修正 scheduler 测试迁移后的源码路径。                                                                                                                                                         |
| Rust CLI           | **35 个 host tests 通过**，canonical Operation/null/cancelled 与缺失回执行为均覆盖。                                                                                                                                     |
| Host dispatch      | **18 tests 全部通过**；真实 Watch ready/replay/live、wildcard、跨身份 operation-get 均通过。                                                                                                                             |
| Companion 广泛测试 | **869 passed / 1 failed**；唯一失败是本次未修改的 `environment_pool::tests::delivery_history_schema_matches_the_published_response_contract`，TaskDeliveryRecord.sourceId 的 optional/nullability 与发布 schema 不一致。 |
| 契约漂移           | `pnpm cli:api:check`、`pnpm companion-api:check` 通过。                                                                                                                                                                  |
| 构建和进程验收     | 当前 JavaScript CLI 生产构建通过；7 个 HTTP/WS fixture 用例通过：device schema、false/null/scalar、双幂等键、分页、二进制保存、events、总超时。                                                                          |
| Lint / 格式 / diff | 最终 `pnpm lint`、本次文件 Prettier、任务路径 diff whitespace 检查通过。                                                                                                                                                 |
| Typecheck          | root 11 个错误（context-workbench、use-claude-chat tests、Discord BigInt）；CLI 3 个错误（bot lifecycle UUID、Discord BigInt）。均在本次未修改的代码。                                                                   |
| Static export      | 失败：agent-codebuff/agent-crush 中 14 项 Node-only imports，本次未修改。                                                                                                                                                |

最后一轮 fresh-context boundary review 又提出两项 P2，均已复现并补回归：共享鉴权中的短 waiter 不应等待长 waiter 的 I/O，也不能取消仍有效的其他 waiter；direct→relay、watch、operation-get 不能重新获得完整超时预算。修复后每个 waiter 独立响应取消，最后一个 waiter 离开才关闭鉴权 I/O，通道切换传递剩余预算。为响应体增加可取消等待，避免不消费 fetch signal 的流拖住预算。该轮未继续无限递归审查；按 bounded review 停止并记录修复证据。

验证日志位于 `.cache/diagnostics/cli-api-repair-2026-10-28/`；持续回归测试在上述源码同目录，验收不依赖缓存文件。证据账本：[implementation ledger](../evidence/2026-10-28-cli-api-wrapper-gap-audit.md)。

尚未验证发布包、真实 paired Host/device、真实 relay 服务或跨平台环境；全仓失败项需要其 owning changes 修复后重跑。以上修复已在工作区完成，未提交或推送。跨模型仍按用户选择跳过。

### 继续完善结果（最新）— 2026-10-28

本轮关闭了 CLI 自身检查和真实 Host 验收的缺口：

- CLI 使用独立的 ES2022 target 和 `.cache/typecheck/cli.tsbuildinfo`，避免继承浏览器 target、共用根目录增量缓存；补齐当前 workspace aliases。`controlBotAutomationLocally` 明确接收 string operation ID，回归确认传入 ID 保存在取消回执中。
- `TaskDeliveryRecord.sourceId` 按 Rust 的 optional Option 模型保留 missing/null/string，拒绝数字；重新生成协议消费者。原 Companion 唯一 schema 失败已关闭。immutable-source handoff 的输入约束与拒绝测试仍保留，legacy 输出兼容不授予 handoff 权限。
- 新增 `pnpm cli:test:api:host` 和 README 操作入口；使用当前编译的 server、当前 JS CLI、私有缓存目录和 synthetic keys，运行真实 loopback Host。既有 bundle runner 负责构建产物、conversation runner 负责 TUI/model，故 Host 生命周期验收单独归属此 runner。

| 最新检查        | 实际结果                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Jest            | **17 suites / 539 tests passed**。                                                                                                             |
| Node 脚本       | **82 tests passed**，包括生成器、CLI config 和 Host 夹具。                                                                                     |
| Companion Rust  | **870 passed / 0 failed**。                                                                                                                    |
| Rust CLI host   | **35 passed / 0 failed**。                                                                                                                     |
| CLI typecheck   | **通过**；之前三个直接阻塞已关闭。                                                                                                             |
| 构建与契约      | 当前 `cognia-server`、JS CLI 构建、两个 API drift gates 通过。                                                                                 |
| 真实 Host smoke | **6 项通过**：paired DPoP 原生 RPC、live catalog、事件 replay、持久化 cursor、TLS pin 的 stream save、事件总超时取消。                         |
| Lint            | 最终 `pnpm lint` 通过。                                                                                                                        |
| 全仓剩余        | root typecheck 仍有 11 个 context-workbench/Claude chat tests/Discord 错误；static-export 仍有 14 个 agent-codebuff/agent-crush Node imports。 |

真实 fixture 首轮沿用了 Host 默认 signaling，得到 relay 邀请，随后已修正为启动前显式关闭 signaling，并将环境备用地址锁定到 loopback；最终成功流程强制要求 direct cgnp3 邀请。整个过程使用 synthetic keys，没有读取或修改已有用户 Host profile/provider 凭据。

本轮 fresh-context 对抗审查复现了夹具的 SIGINT 子进程遗留和初始化 EIO 临时目录遗留；均修复并补测试。实际入口的 SIGINT/SIGTERM 测试验证退出码 130/143、子进程被回收、私有目录删除；bounded recheck 无剩余具体发现。跨模型继续跳过。

以上真实验收使用不依赖 brain 的原生 RPC，execution/signaling 关闭；不代表模型执行、真实远端 relay、发布包或物理设备/跨平台验收。日志仍在 `.cache/diagnostics/cli-api-repair-2026-10-28/`，本轮使用 `continue-*.log`；可重复验收入口已在源码中保存。未提交或推送。
