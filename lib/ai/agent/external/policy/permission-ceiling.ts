import { isCogniaProjectedTool } from "./tool-preapproval"
import { externalAuthorityOptions } from "./run-authority"
import { meetRunAuthority } from "@cognia/plugin-contract/types/execution/acting-identity"
import { RunAuthorityError } from "@/lib/execution/run-authority"
import type {
  AcpCapabilities,
  AcpPermissionMode,
  ExternalAgentExecutionOptions,
  ExternalAgentProtocol,
} from "@/types/agent/external-agent"
import {
  isCapabilityUsable,
  type ExternalAgentCapabilityProfileV1,
} from "@cognia/agent-config-types/external-agent-capability"
import { deriveExternalSessionPermission, MODE_RANK } from "./permission-cascade"
import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import { adaptPermissionMode, PROTOCOL_PERMISSION_MODE_SUPPORT } from "./permission-modes"

/** A hard policy is distinct from the manager's best-effort mode override. */
export interface PermissionBoundExternalExecutionOptions extends ExternalAgentExecutionOptions {
  permissionCeiling?: AgentPermissionCeiling
  inheritedRunAuthority?: import("@/types/execution/run").RunAuthorityV1
  /**
   * ADR-0243: this execution's own dollar share of its run tree's ledger (a
   * best-of-N candidate's cost / n). Without it the execution takes all that
   * is left.
   */
  maxBudgetUsd?: number
}

export function hasUnsupportedExternalPermissionDimensions(
  ceiling: AgentPermissionCeiling
): boolean {
  return (
    ceiling.allowedTools !== undefined ||
    Boolean(ceiling.disallowedTools?.length) ||
    ceiling.mcpServers !== undefined ||
    Boolean(ceiling.sandboxPolicy)
  )
}

/** These adapters apply the turn's mode before prompt, recreating their process when needed. */
export function appliesPermissionModeAtPrompt(protocol: ExternalAgentProtocol): boolean {
  return protocol === "pi-rpc" || protocol === "aider-cli"
}

/** Pass-through transports cannot attest a restrictive ceiling. */
export function attestsExternalPermissionMode(
  protocol: ExternalAgentProtocol,
  capabilities: AcpCapabilities | undefined,
  mode: AcpPermissionMode,
  profile?: ExternalAgentCapabilityProfileV1
): boolean {
  if (["a2a", "http", "websocket"].includes(protocol)) return false
  const adapted = adaptPermissionMode(mode, protocol).mode
  if (MODE_RANK[adapted] > MODE_RANK[mode]) return false
  const modeCapability = profile?.effective["permissions.set-mode"]
  // Contributed adapters have no shipped policy implementation to rely on.
  // Their live mode list and negotiated setter must both attest this mode.
  if (protocol === "custom" || !(protocol in PROTOCOL_PERMISSION_MODE_SUPPORT)) {
    return Boolean(
      profile?.negotiated &&
      modeCapability &&
      isCapabilityUsable(modeCapability.level) &&
      modeCapability.evidence !== "user-declared" &&
      capabilities?.permissionModes?.includes(adapted)
    )
  }
  // Pi restarts with a new process tool floor and Aider rebuilds its per-turn
  // invocation. Neither needs a set-mode RPC to enforce the supplied policy.
  const promptPolicy = appliesPermissionModeAtPrompt(protocol)
  if (
    modeCapability &&
    !isCapabilityUsable(modeCapability.level) &&
    (!promptPolicy || modeCapability.evidence === "user-declared")
  )
    return false
  if (capabilities?.permissionModes !== undefined)
    return capabilities.permissionModes.includes(adapted)
  // Codex and Pi attest mode changes through their shipped adapter, not the
  // legacy list. Before connection only adapter-code evidence qualifies; the
  // manager rechecks the negotiated profile before creating or resuming a turn.
  return (
    mode !== "plan" ||
    promptPolicy ||
    Boolean(
      (profile?.negotiated || modeCapability?.evidence === "adapter-code") &&
      modeCapability &&
      isCapabilityUsable(modeCapability.level) &&
      modeCapability.evidence !== "user-declared"
    )
  )
}

/** Validate before session creation; never reinterpret an allow-list as preapproval. */
export function enforceExternalPermissionCeiling(
  options: PermissionBoundExternalExecutionOptions | undefined,
  protocol: ExternalAgentProtocol,
  capabilities: AcpCapabilities | undefined,
  configuredMode?: AcpPermissionMode,
  profile?: ExternalAgentCapabilityProfileV1
): PermissionBoundExternalExecutionOptions | undefined {
  let ceiling = options?.permissionCeiling
  if (!ceiling) return options
  if (ceiling.sandboxPolicy)
    throw new RunAuthorityError("unsupported_authority", `${protocol}: sandboxPolicy`)
  if (
    ceiling.allowedTools !== undefined ||
    ceiling.disallowedTools?.length ||
    ceiling.mcpServers !== undefined
  ) {
    // The inherited authority is in Host ids; its already translated native
    // policy supplies the name mapping for this engine. Meet in ids, then
    // translate the result once at the engine edge.
    const inheritedIds = options?.inheritedRunAuthority?.mcpServers?.only ?? []
    const nativeNames = options?.nativePolicy?.mcpServers?.only ?? []
    const serverNamesById = Object.fromEntries(
      inheritedIds.flatMap((id, index) => (nativeNames[index] ? [[id, nativeNames[index]]] : []))
    )
    const serverIdsByName = Object.fromEntries(
      Object.entries(serverNamesById).map(([id, name]) => [name, id])
    )
    const authority = {
      schemaVersion: 1 as const,
      ...(ceiling.permissionMode ? { permissionMode: ceiling.permissionMode } : {}),
      tools: { allow: ceiling.allowedTools, deny: ceiling.disallowedTools },
      ...(ceiling.mcpServers
        ? {
            mcpServers: {
              only: ceiling.mcpServers.map((server) => serverIdsByName[server.name] ?? server.name),
            },
          }
        : {}),
    }
    options = externalAuthorityOptions(
      options?.inheritedRunAuthority
        ? meetRunAuthority(options.inheritedRunAuthority, authority)
        : authority,
      {
        ...options,
        permissionCeiling: ceiling.permissionMode
          ? { permissionMode: ceiling.permissionMode }
          : undefined,
      },
      { protocol },
      serverNamesById
    )
    const projectedDenies = ceiling.disallowedTools?.filter((name) => isCogniaProjectedTool(name))
    if (projectedDenies?.length)
      options.permissionCeiling = { ...options.permissionCeiling, disallowedTools: projectedDenies }
    ceiling = options.permissionCeiling ?? {}
  }
  const merged = deriveExternalSessionPermission(ceiling, {
    permissionMode: options?.permissionMode ?? configuredMode,
  })
  if (!merged.permissionMode) throw new Error("External agent permission ceiling has no mode")
  if (!attestsExternalPermissionMode(protocol, capabilities, merged.permissionMode, profile)) {
    throw new Error("External agent cannot enforce the inherited permission ceiling")
  }
  return { ...options, permissionMode: adaptPermissionMode(merged.permissionMode, protocol).mode }
}
