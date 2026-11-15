import type { RunAuthorityV1 } from "@/types/execution/run"
import { RunAuthorityError } from "@/lib/execution/run-authority"
/** Portable execution ceilings shared by dispatcher and receiver. No credentials or host paths. */
import type { HandoffPolicyV1 } from "@cognia/agent/handoff-envelope"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { BuildOptionsContext } from "@/lib/claude/build-options"
import { deriveExternalSessionPermission } from "@/lib/ai/agent/external/policy/permission-cascade"
import { clampSandboxPolicy, intersectPathRoots } from "@/lib/sandbox/policy-bridge"

export const REMOTE_WORKER_POLICY_CAPABILITY = "worker-policy-v1"

export function encodeRemoteWorkerPolicy(
  ceiling: AgentPermissionCeiling,
  sandboxRequired: boolean,
  workspaceRoot?: string,
  authority?: RunAuthorityV1,
  runAuthorityMcpServerIds: Readonly<Record<string, string>> = {}
): HandoffPolicyV1 | undefined {
  // worker-policy-v1 has no receiver for these dimensions. Refuse before placement.
  const unsupported = (["skills", "subagents", "maxTurns", "permissionProfile"] as const).filter(
    (field) => authority?.[field] !== undefined
  )
  if (unsupported.length)
    throw new RunAuthorityError(
      "unsupported_authority",
      `remote Squad worker: ${unsupported.join(", ")}`
    )
  if (authority?.permissionMode === "auto")
    throw new RunAuthorityError("unsupported_authority", "remote Squad worker: permissionMode.auto")
  ceiling = deriveExternalSessionPermission(
    {
      ...(authority?.permissionMode ? { permissionMode: authority.permissionMode } : {}),
      ...(authority?.tools?.allow ? { allowedTools: authority.tools.allow } : {}),
      ...(authority?.tools?.deny ? { disallowedTools: authority.tools.deny } : {}),
      ...(authority?.mcpServers?.only
        ? {
            mcpServers: authority.mcpServers.only.map((id) => ({
              name:
                Object.entries(runAuthorityMcpServerIds).find(
                  ([, serverId]) => serverId === id
                )?.[0] ?? id,
            })),
          }
        : {}),
    },
    ceiling
  )
  if (!Object.keys(ceiling).length && !sandboxRequired) return undefined
  const portableRoots = (roots: string[] | undefined): string[] | undefined =>
    roots?.map((root) => {
      const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "")
      const base = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "")
      if (!base || (normalized !== base && !normalized.startsWith(`${base}/`))) {
        throw new Error(
          "Remote worker cannot enforce a sandbox root outside its repository binding"
        )
      }
      const relative = normalized === base ? "." : normalized.slice(base.length + 1)
      if (relative.split("/").includes(".."))
        throw new Error("Remote worker sandbox root must be normalized")
      return relative
    })
  const policy = ceiling.sandboxPolicy
  return {
    policyVersion: 1,
    ...(ceiling.permissionMode ? { permissionMode: ceiling.permissionMode } : {}),
    ...(ceiling.allowedTools ? { allowedTools: [...ceiling.allowedTools] } : {}),
    ...(ceiling.disallowedTools ? { disallowedTools: [...ceiling.disallowedTools] } : {}),
    ...(ceiling.mcpServers
      ? { mcpServerNames: ceiling.mcpServers.map(({ name }: { name: string }) => name) }
      : {}),
    sandboxRequired: sandboxRequired || !!policy,
    ...(policy
      ? {
          sandboxPolicy: {
            ...policy,
            writableRoots: portableRoots(policy.writableRoots),
            readableRoots: portableRoots(policy.readableRoots),
          },
        }
      : {}),
  }
}

/** @internal Test seam: exported for its unit tests, not for production callers. */
export function decodeRemoteWorkerPolicy(
  policy: HandoffPolicyV1,
  workspaceRoot: string
): AgentPermissionCeiling {
  const bind = (roots: string[] | undefined) =>
    roots?.map((root) =>
      root === "." ? workspaceRoot : `${workspaceRoot.replace(/[\\/]$/, "")}/${root}`
    )
  return {
    ...(policy.permissionMode ? { permissionMode: policy.permissionMode } : {}),
    ...(policy.allowedTools ? { allowedTools: [...policy.allowedTools] } : {}),
    ...(policy.disallowedTools ? { disallowedTools: [...policy.disallowedTools] } : {}),
    ...(policy.mcpServerNames
      ? { mcpServers: policy.mcpServerNames.map((name: string) => ({ name })) }
      : {}),
    ...(policy.sandboxPolicy
      ? {
          sandboxPolicy: {
            ...policy.sandboxPolicy,
            writableRoots: bind(policy.sandboxPolicy.writableRoots),
            readableRoots: bind(policy.sandboxPolicy.readableRoots),
          },
        }
      : {}),
  }
}

/** Compose host and sender ceilings; a host's broader roots must never erase a narrower sender root. */
export function remoteWorkerCeiling(
  policy: HandoffPolicyV1,
  workspaceRoot: string,
  local?: AgentPermissionCeiling
): AgentPermissionCeiling {
  const incoming = decodeRemoteWorkerPolicy(policy, workspaceRoot)
  const effective = deriveExternalSessionPermission(incoming, local)
  // Read roots use clampSandboxPolicy's shared read-ceiling union and strict
  // refusal through deriveExternalSessionPermission above. Preserve the
  // existing intersection semantics for host/sender writable directories.
  for (const dimension of ["writableRoots"] as const) {
    const parent = incoming.sandboxPolicy?.[dimension]
    const child = local?.sandboxPolicy?.[dimension]
    const roots = parent && child ? intersectPathRoots(child, parent) : (parent ?? child)
    // Current sandbox adapters interpret an empty path list as host defaults, not deny-all.
    // Refuse that unrepresentable contract rather than silently substituting defaults.
    if (roots?.length === 0)
      throw new Error(`Worker sandbox cannot represent an empty ${dimension} ceiling`)
    if (roots) {
      effective.sandboxPolicy = clampSandboxPolicy(incoming.sandboxPolicy, {
        ...effective.sandboxPolicy,
        [dimension]: roots,
      })
    }
  }
  return effective
}

/** Reuse the ordinary final permission clamp and sandbox tool lowering. */
export async function resolveRemoteWorkerOptions(
  ctx: BuildOptionsContext,
  policy: HandoffPolicyV1,
  workspaceRoot: string
) {
  const { resolveSendOptions } = await import("@/lib/claude/build-options")
  const local = deriveExternalSessionPermission(
    { sandboxPolicy: ctx.character?.sandboxPolicy ?? ctx.appSettings?.sandboxPolicy ?? undefined },
    ctx.permissionCeiling
  )
  const effective = remoteWorkerCeiling(policy, workspaceRoot, local)
  const resolved = await resolveSendOptions({
    ...ctx,
    permissionCeiling: effective,
    ...(policy.mcpServerNames
      ? {
          preloadedMcpServers: (ctx.preloadedMcpServers ?? []).filter((server) =>
            policy.mcpServerNames!.includes(server.name)
          ),
        }
      : {}),
    ...(policy.sandboxRequired
      ? {
          session: ctx.session ? { ...ctx.session, sandboxEnabled: true } : ctx.session,
          character: ctx.character
            ? { ...ctx.character, sandboxEnabled: true, sandboxPolicy: effective.sandboxPolicy }
            : ctx.character,
          appSettings: {
            ...ctx.appSettings,
            sandboxDefaultEnabled: true,
            sandboxPolicy: effective.sandboxPolicy,
          } as BuildOptionsContext["appSettings"],
        }
      : {}),
  })
  if (policy.mcpServerNames && resolved.mcpServers) {
    resolved.mcpServers = Object.fromEntries(
      Object.entries(resolved.mcpServers).filter(([name]) => policy.mcpServerNames!.includes(name))
    )
  }
  return resolved
}
