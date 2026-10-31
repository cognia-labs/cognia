---
title: "0245 — 配对设备获得的是工作区授权，而不是整台 Host"
description: "除了用于本人设备的 Owner 邀请，Host 还可以发出从零权限起步的受限邀请。受限设备按工作区获得授权：读文件、写文件、读会话历史。Host 根据自己可信的根目录解析每个工作区，因此请求方提供的路径或 allowedRoots 不能扩大授权。运行 Agent、终端或浏览器仍是 Host 级授权，除非 Host 能在该工作区强制执行沙箱。Host 管理权限保留原名，不会被重新包装成工作区授权。"
---

# ADR 0245 — 配对设备获得的是工作区授权，而不是整台 Host

**状态：** 提议中
**日期：** 2026-10-31
**相关：** [ADR-0143](./0143-device-console)（设备控制台，未知不等于离线）、[ADR-0149](./0149-a-person-is-not-a-device)（人、设备与成员关系）、[ADR-0172](./0172-remote-access-is-verified-not-assumed)（经过验证的可达性）、[ADR-0182](./0182-a-project-names-the-image-it-runs-in) 与 [ADR-0183](./0183-the-agent-is-brought-to-the-image)（沙箱执行）、[ADR-0222](./0222-a-conversations-files-are-a-view-and-sharing-them-is-a-grant)（文件共享授权）、[ADR-0244](./0244-a-remote-run-has-stopped-only-when-its-worker-says-so)（撤销不等于停止）

## 背景

配对与设备生命周期已经可靠：邀请是一次性的哈希秘密，TTL 为 300 秒或 600 秒；撤销不可逆；已撤销的设备 id 或密钥不能重新注册（`crates/cognia-companion-security/src/security_store.rs`）。授权却不够细：

- **每个邀请都会创建 Owner。** `register_owner_device` 插入 `role = 'owner'`，默认授权包括 `host.admin`、`terminal.open`、`process.spawn` 和 `secret.manage`。配对即获得全部权限。
- **授权按设备划分。** `capability_grants` 的键是 `(tenant, device, capability)`，没有根目录维度。`Control` 打包了 `agent.run`、`workspace.read`、`workspace.write`、`git.write` 和 `workflow.run`。
- **按根目录授权的机制在别处。** External Bridge 按 `WorkspaceRoot.id` 给每个 MCP 调用方授予根目录（`lib/external-bridge/workspace/grants.ts`）；文件共享授权（ADR-0222）覆盖 WebDAV、SFTP 和协作成员。两者都不适用于配对设备。
- **路径约束曾信任请求方。** 远端 `write_text_file_confined` 和 `ensure_dir_confined` 直接使用 RPC 参数里的 `allowedRoots`；在尚不存在的路径段之后出现的 `..` 能通过祖先目录检查，并在写入时越出根目录。两处都随本 ADR 一并修复（由 Host 根目录约束请求；未解析的遍历在创建任何目录之前就被拒绝）。
- **直连路径的身份验证弱于中继。** 中继路径用二维码里的 Host 签名密钥验证。直连路径只在 Capacitor 原生端固定 TLS；在其他客户端上 `serverFingerprint` 被丢弃，而配对后的指纹检查比较的是邀请自带的 `fp`，不是连接上实际看到的证书。

主要场景是同一个人的多台设备（笔记本把任务委派给台式机或常驻 Box）。多人共用的 Host 复用组织成员模型（ADR-0149），不由本 ADR 处理。

## 决策

1. **两种邀请。** Owner 邀请继续用于本人设备，保持现有授权。受限邀请注册的设备没有任何工作区授权，也没有 Host 管理权限。"配对不自动获得全部权限"指的就是受限邀请，控制台标明设备持有哪一种。

2. **工作区授权。** 一条授权是 `(device, workspaceId, capabilities)`，能力取自 `files.read`、`files.write` 和 `sessions.read`。`workspaceId` 指 Host 上的工作区（桌面端注册的项目根目录，或 headless Host 的 spawn policy 工作区根下的目录）。授权在设备控制台中列出、授予、撤销和审计。没有授权即没有访问。

3. **由 Host 解析路径。** 每个文件、会话或执行请求都写明 `workspaceId`，Host 从自己的可信来源把它解析为规范根目录：桌面端注册表或 headless spawn policy。请求方的路径和 `allowedRoots` 只能收窄，不能扩大。路径约束对最深的已存在祖先做规范化，在创建任何目录之前拒绝未解析的 `..`/`.` 遍历，创建目录后再次检查，并拒绝最后一段是符号链接的目标。Windows 路径前缀只在规范形式上比较。

4. **执行不靠文件工具来限定范围。** `agent.run`、终端和浏览器访问仍是 Host 级授权。只有当 Host 声明能对该工作区强制执行沙箱（ADR-0182/0183）时，才存在工作区级的 `agent.run`，而且这类运行从不回退到无沙箱启动。授权界面会写明：拥有 shell 权限时，文件工具的限制约束不了目录访问。

5. **Host 管理保留原名。** Owner 和 admin 能力（`host.admin`、`secret.manage`、生命周期操作）显示为 Host 管理。它们从不被呈现为、也不会被迁移成工作区授权，现有 Owner 设备保留这些能力。

6. **变更后重新校验。** 授权变更或撤销对下一个操作生效。排队任务和待处理中断在派发或决定时重新校验（ADR-0244 决策 7）；运行中的任务走 ADR-0244 的停止流程。

7. **每条路径都验证身份。** 直连配对在所有能固定的客户端上固定 Host 的 SPKI（桌面端用自己的 TLS 栈，Capacitor 用原生能力），在邀请被消耗之前，把固定值与连接上的证书比较，不一致即拒绝。配对房间在邀请被兑换时关闭，而不只是到期时关闭。

## 影响

- 受限设备可以读写某个工作区的文件和历史。要在那里运行 Agent，需要 Host 级信任或带沙箱的工作区。这是有意为之：任何更弱的方案都会宣称一条 shell 能越过的边界。
- 新增记录和协议字段：邀请类型、Host 上的 `workspace_grants` 表，以及文件和会话请求上的 `workspaceId`。仍发送原始路径的旧客户端，对受限设备一律被拒绝。
- Composer 中的远端 `@file` 引用使用已授权工作区上的 `files.read`。

## 未完成

- 组织范围或跨人员的委派（由 ADR-0149 的成员关系负责）。
- 按工作区区分的浏览器 profile。
- 在 `files.write` 和 Host 级 `agent.run` 已覆盖范围之外，对 git 或工作流操作的单独授权。

## 考虑过的方案

- **所有配对都从零权限起步。** 符合"配对不授予任何权限"的字面要求，但会给最常见的场景——本人自己的设备——多加一步。受限邀请覆盖另一种场景。
- **对 Agent 做"软"工作区限制并加警告。** 否决：它宣称了一种 shell 能突破的约束。
