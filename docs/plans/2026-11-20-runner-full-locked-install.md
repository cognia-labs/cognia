# Runner Full 变体改为从总锁安装

> 状态：方案已确认（2026-11-20，D1–D4 均按建议），未实施。创建：2026-11-20（Asia/Shanghai）。
> 依据：[Runner 镜像审计](../evidence/2026-11-19-runner-image-readiness.md) F04，以及 2026-11-20 的决定「Full 改为从总锁构建」。
> 范围：`cognia-runner` 的 `full` target 和共用同一安装脚本的 `cognia-server` `runtime-full`。Cursor 的可变安装器、base 镜像 digest、cosign 签名和漏洞扫描门禁不在本方案内。
> 第 3 节的决策已于 2026-11-20 确认；阶段与默认值按本文执行。

## 1. 建议与完成定义

**Full 改走 Selected 已有的安装链：`prepare --runtimes full` → `npm ci` → `stage` → `install-selected.mjs install`。Cline 进入总 pins，成为可分发的 runtime，Full 就不再需要第二套锁。** `install-agents.sh` 里的全局 `npm install -g` 整段删除，只剩 Cursor 这个显式开启的例外。

完成须同时满足：

1. Runner `full` 和 server `runtime-full` 里的每个 npm 包都来自带 integrity 的 lock：总锁 `deploy/bundle/npm/package-lock.json`，或第 3 节决策 D1 选 B 时的附加锁。两次构建同一 revision，`npm ls --all` 的输出逐字一致。
2. 安装后 PATH 上的命令集合，以及旧 ACP 包名的 `npx` 解析，与改动前一致；不一致的地方逐条写进 README 和 changeset。
3. 门禁检查：Full 的 runtime 集合等于 pins 里所有可分发 runtime（再加上附加锁，如果有），`install-agents.sh` 里不再有对已分发包的 `npm install -g`。
4. CI 上 Runner Full、Codex 和 server full 的镜像构建与 `smoke.mjs` 都通过，结果记入账本。本机无法构建镜像时，这一条标为未验收，不用 mock 代替。

## 2. 现状

| 路径           | 做法                                                                                                                                                                                                                                                            | 位置                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Selected       | `prepare` 按所选 runtime 裁剪 `package.json` 和 lock，`npm ci --ignore-scripts` 装到 `/cognia/glibc/lib/agents`，`stage` 按 pins 里的 SHA256 下载 Kiro、Droid 等资产，`install-selected.mjs install` 生成冻结 shim；Node 用 `/cognia/glibc/node` 自带的固定版本 | `deploy/runner/Dockerfile:23-45`、`:70-82`                           |
| Full（Runner） | `install-agents.sh`：`npm install -g` 安装 11 个包（只锁顶层版本），按 `installScripts` 白名单 `npm rebuild`，`install_vendor` 校验 Kiro/Droid，`install-full` 生成旧 ACP 包名的 shim；Node 用 base 镜像的                                                      | `deploy/runner/Dockerfile:83-118`、`deploy/runner/install-agents.sh` |
| Full（server） | 同一个 `install-agents.sh`，base 是 `node:26-trixie-slim`                                                                                                                                                                                                       | `deploy/docker/Dockerfile.cognia-server:420-433`                     |

Full 比 `--runtimes full` 多出的只有 Cline（`cline@3.0.73`，pins 里标为不可分发的系统 runtime）和可选的 Cursor。其余 11 个 runtime（claude-agent-acp、codex-acp、codex-app-server、gemini-cli、copilot-cli、qwen-code、pi、opencode、opencode-acp、kiro-cli、droid）本来就在总 pins 和总锁里。

Full 还接受按 Agent 的版本覆盖参数（`CLAUDE_CODE_VERSION` 等 build arg）。这些参数会绕过 lock。

## 3. 已定决策（2026-11-20）

| 编号 | 问题                                 | 选项                                                                                                                                                                                                                                                           | 决定与理由                                                                                                                                                                                                                              |
| ---- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | Cline 怎么进锁                       | **A**：作为 npm runtime 写进 `agent-versions.json` 和总锁，Selected 和 sandbox pool 的 bundle 也能选它。**B**：给 Full 单独建一份附加锁（`deploy/runner/full-extras/`），bundle 不变                                                                           | **已定 A：Cline 写进总 pins 和总锁**。只有一套锁和一套安装链。F09 里「产品有 preset、启动白名单里也有、Selected 却拒绝」的矛盾就此消除。代价是 bundle 的 `full` 变体多一个 Cline，bundle smoke 要加 Cline 的 ACP 初始化                 |
| D2   | 版本覆盖参数                         | **A**：删除，版本只来自 pins。**B**：保留，但传了覆盖参数的镜像打上 `unlocked` label，smoke 拒绝发布                                                                                                                                                           | **已定 A：删除版本覆盖参数**。覆盖参数原本就要求精确版本，改版本应当改 pins 并重新生成锁                                                                                                                                                |
| D3   | server `runtime-full` 怎么复用安装链 | **A**：server Dockerfile 复制一份同样的 `agent-build` 阶段，由门禁检查两份逐行一致。**B**：抽出共享的 `deploy/agents/Dockerfile`，两边用 BuildKit 命名构建上下文（`--build-context agent-tree=…`）引入。**C**：server 直接 `COPY --from=` 已发布的 Runner 镜像 | **已定 B：共享 `deploy/agents/Dockerfile` + 命名上下文 `agent-tree`**。只有一份实现。缺点是 Compose 的 `build` 和 CI 都要传这个上下文，要像 `plugin-artifacts` 一样提供会报错的占位阶段（`check-deploy-suite.mjs` 第 7 项已有现成模式） |
| D4   | Full 里 Agent 用哪个 Node            | **A**：与 Selected 一样用固定的 `/cognia/glibc/node`。**B**：继续用 base 镜像的 Node                                                                                                                                                                           | **已定 A：Full 用固定版本 Node**。可复现，也和 Selected、bundle 一致；base 镜像自带的 Node 仍留给项目工具使用                                                                                                                           |

## 4. 设计

1. **pins 与锁**（D1=A）：在 `deploy/bundle/agent-versions.json` 给 `cline` 加 npm 分发（命令取自 `protocol/external-agent-runtimes.json` 的 Cline launch），删掉它的 `unavailable`。把 `cline` 写进 `deploy/bundle/npm/package.json`，重新生成 `package-lock.json`。`bundle-agent-versions.mjs` 的 `validatePins` 和 `audit:external-agent-runtimes` 第 8 项会自动把它当成已分类的 runtime。
2. **Runner Dockerfile**：`full` target 改成 `FROM base`，并 `COPY --from=agent-build`，其中 `agent-build` 就是当前的 `selected-build`，`AGENT_RUNTIMES` 固定为 `full`。`configure-base` 的步骤与 Selected 相同。`INSTALL_CURSOR_AGENT=1` 时只运行 Cursor 那一段。
3. **`install-agents.sh`**：删除 `pin()`、`npm install -g`、`npm rebuild` 和 `install_vendor`（这些已由 `npm ci` 加 `stage` 完成），只留下 Cursor 段，脚本改名为 `install-cursor-agent.sh`。`install-selected.mjs` 里的 `install-full` 子命令如果没有别的调用方，一并删除，旧 ACP 包名的 shim 由 `install` 统一生成。
4. **server**（D3=B）：新增 `deploy/agents/Dockerfile`，把 `agent-build` 阶段移到这里。Runner 与 server 两个 Dockerfile 都通过命名上下文 `agent-tree` 引用它，各自保留一个会报错的占位阶段。`compose` 的 `build` 和 `images.yml` 都传入该上下文。
5. **门禁**：`check-deploy-suite.mjs` 新增一项，内容如下。
   - 两个 Full 镜像都从 `agent-tree` 取 Agent，并且不运行 `npm install -g`。
   - 占位阶段会失败。
   - 所有构建入口都传了上下文。
6. **兼容性清单测试**：`install-selected.test.mjs` 新增用例，对比 `--runtimes full` 生成的 shim 集合与当前 Full 的命令集合，即 `install-full` 生成的旧名字加上 npm 全局 bin。清单写成测试里的常量，以后增删命令要显式改这里。

## 5. 实施阶段

| 阶段 | 内容                                                                                                         | 验证                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| P1   | Cline 进 pins 和总锁，bundle smoke 加 Cline ACP 初始化                                                       | `node --test` 跑 Runner 预检、`audit:external-agent-runtimes`、`bundle-agent-versions.mjs check`；Codex-only `prepare` 仍成功 |
| P2   | 抽出 `deploy/agents/Dockerfile`，Runner `full` 改用它，`install-agents.sh` 缩成只装 Cursor                   | `install-selected.test.mjs` 的兼容性清单；`agent-image-profiles.test.mjs`                                                     |
| P3   | server `runtime-full` 改用 `agent-tree`；Compose 和 `images.yml` 传入上下文；门禁新增检查项                  | `check-deploy-suite.test.mjs`；`docker compose config`；actionlint                                                            |
| P4   | CI 构建并 smoke Runner Full、Codex、server full 和 bundle；对比改动前后镜像的 `npm ls --all`、命令清单和大小 | CI 结果记入账本；同一 revision 构建两次，`npm ls --all` 一致                                                                  |
| P5   | README、changeset、账本收尾                                                                                  | 文档构建：`docs:build`（如涉及 docs 站点）                                                                                    |

## 6. 风险

- **镜像体积**：Selected 的 `npm ci` 树与全局安装的树大小相近，但多了一份固定版本的 Node（约 100 MB）。P4 记录实际差值，明显变大时再讨论 Full 是否复用 base 的 Node（即 D4 的 B 选项）。
- **Cline 升级**：Cline 进总锁后，升级也走 pins 加锁的流程。它不再有单独的 `CLINE_VERSION`。
- **构建上下文**（D3=B）：漏传 `agent-tree` 的构建会被占位阶段拦下，不会静默产出空镜像。外部用户自行 `docker build` 时，命令需要多一个参数，README 要写清。
- **arm64**：本方案不改变架构矩阵，Runner 仍只发布 amd64（2026-11-20 决定暂不扩展）。
