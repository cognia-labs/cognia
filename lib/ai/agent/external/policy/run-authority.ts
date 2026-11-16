/** Translate Host-held run authority before an external process/session starts. */
import type { RunAuthorityV1 } from "@/types/execution/run"
import type { PersonalEgressContext } from "@/lib/execution/personal-egress"
import {
  persistRunAuthority,
  resolveRunAuthority,
  RunAuthorityError,
} from "@/lib/execution/run-authority"
import type { PermissionBoundExternalExecutionOptions } from "./permission-ceiling"
import { deriveExternalSessionPermission } from "./permission-cascade"

import type {
  ExternalAgentConfig,
  ExternalAgentProtocol,
  ExternalAgentEvent,
  ExternalAgentTokenUsage,
} from "@/types/agent/external-agent"
import type { MeteredUsage } from "@/lib/execution/run-budget-rail"
import { adaptPermissionMode } from "./permission-modes"
import { isCogniaProjectedTool } from "./tool-preapproval"
import { createUnattendedPermissionResponder } from "@/lib/ai/agent/execution/permissions/unattended-responder"

/** Shipped protocols with a stream of native tool/assistant execution steps. */
const COUNTABLE = new Set<ExternalAgentProtocol>([
  "codex-app-server",
  "codex-siwc-app-server",
  "acp",
  "pi-rpc",
  "opencode",
  "opencode-v2",
  "openclaude-cli",
  "dsh-sdk",
  "codebuff-sdk",
  "aider-cli",
  "continue-cli",
])

/** Translate only an ancestor's ceiling. Own options are not an inherited restriction. */
export function externalAuthorityOptions(
  authority: RunAuthorityV1,
  options: PermissionBoundExternalExecutionOptions = {},
  engine: Pick<ExternalAgentConfig, "protocol" | "autoApprovePatterns"> = { protocol: "custom" },
  serverNamesById: Readonly<Record<string, string>> = {}
): PermissionBoundExternalExecutionOptions {
  const servers = authority.mcpServers?.only?.map((id) => serverNamesById[id] ?? id)
  const protocol = engine.protocol
  const unsupported: string[] = []
  const nativePolicy: NonNullable<PermissionBoundExternalExecutionOptions["nativePolicy"]> = {}
  const tools = authority.tools
  const nativeToolsRestricted =
    tools?.allow !== undefined || tools?.deny?.some((name) => !isCogniaProjectedTool(name))
  if (nativeToolsRestricted) {
    if (["pi-rpc", "opencode", "opencode-v2"].includes(protocol)) {
      for (const pattern of tools?.deny ?? []) {
        if (!isCogniaProjectedTool(pattern) && pattern.includes("("))
          unsupported.push(`tools.deny: ${pattern} (native argument rules unavailable)`)
      }
    }
    if (["pi-rpc", "opencode", "opencode-v2"].includes(protocol)) nativePolicy.tools = tools
    else if (
      ["codex-app-server", "codex-siwc-app-server"].includes(protocol) &&
      tools?.allow === undefined &&
      tools?.deny?.every(
        (name) =>
          isCogniaProjectedTool(name) ||
          ["Bash", "shell", "exec_command", "write_stdin"].includes(name)
      )
    )
      nativePolicy.tools = tools
    else unsupported.push("tools.native")
  }
  // Codex enumerates ambient servers and disables them in its per-thread config.
  // Pi's isolated extension floor loads only the Host-provided MCP projection.
  if (authority.mcpServers?.only !== undefined) {
    if (["codex-app-server", "codex-siwc-app-server", "pi-rpc"].includes(protocol))
      nativePolicy.mcpServers = { only: servers! }
    else unsupported.push("mcpServers.only (ambient discovery)")
  }
  for (const field of ["skills", "subagents"] as const) {
    if (authority[field]?.only !== undefined) {
      if (
        protocol === "pi-rpc" ||
        (field === "subagents" && ["codex-app-server", "codex-siwc-app-server"].includes(protocol))
      )
        nativePolicy[field] = { only: authority[field]!.only! }
      else unsupported.push(`${field}.only (native discovery)`)
    }
  }
  if (authority.maxTurns !== undefined && !COUNTABLE.has(protocol)) unsupported.push("maxTurns")
  const requestedMode =
    authority.permissionMode === "auto" ? "acceptEdits" : authority.permissionMode
  const permissionCeiling = deriveExternalSessionPermission(
    requestedMode ? { permissionMode: requestedMode } : {},
    deriveExternalSessionPermission(options.permissionCeiling ?? {}, {
      ...(requestedMode || options.permissionMode
        ? { permissionMode: options.permissionMode ?? "default" }
        : {}),
    })
  )
  if (authority.tools?.allow !== undefined)
    permissionCeiling.allowedTools = deriveExternalSessionPermission(
      { allowedTools: authority.tools.allow },
      permissionCeiling
    ).allowedTools
  if (authority.tools?.deny?.length)
    permissionCeiling.disallowedTools = [
      ...new Set([
        ...(permissionCeiling.disallowedTools ?? []),
        ...authority.tools.deny.filter((name) => isCogniaProjectedTool(name)),
      ]),
    ]
  const mode = permissionCeiling.permissionMode ?? options.permissionMode ?? "default"
  if (
    authority.permissionProfile &&
    (![
      "acp",
      "codex-app-server",
      "codex-siwc-app-server",
      "pi-rpc",
      "opencode",
      "opencode-v2",
      "openclaude-cli",
    ].includes(protocol) ||
      mode !== "default" ||
      engine.autoApprovePatterns?.length)
  )
    unsupported.push("permissionProfile (permission callbacks bypassed or unavailable)")
  if (unsupported.length)
    throw new RunAuthorityError("unsupported_authority", `${protocol}: ${unsupported.join(", ")}`)
  const custom = options.context?.custom
  const suppliedServers = custom?.mcpServers
  const responder = authority.permissionProfile
    ? createUnattendedPermissionResponder(`external ${protocol}`)
    : undefined
  return {
    ...options,
    inheritedRunAuthority: authority,
    ...(Object.keys(nativePolicy).length ? { nativePolicy } : {}),
    ...(Object.keys(permissionCeiling).length
      ? { permissionCeiling, permissionMode: adaptPermissionMode(mode, protocol).mode }
      : {}),
    ...(authority.maxTurns !== undefined
      ? { maxSteps: Math.min(options.maxSteps ?? Infinity, authority.maxTurns) }
      : {}),
    ...(servers && Array.isArray(suppliedServers)
      ? {
          context: {
            ...options.context,
            custom: {
              ...custom,
              mcpServers: suppliedServers.filter(
                (server) =>
                  server &&
                  typeof server === "object" &&
                  "name" in server &&
                  servers.includes(
                    String(
                      "id" in server
                        ? (serverNamesById[String(server.id)] ?? server.id)
                        : server.name
                    )
                  )
              ),
            },
          },
        }
      : {}),
    ...(responder
      ? {
          onPermissionRequest: async (request) => {
            const id = request.requestId ?? request.id
            const decision = await responder.onPermissionRequest({
              type: "permission_request",
              sessionId: request.sessionId ?? "",
              requestId: id,
              toolUseID: request.toolCallId ?? id,
              toolName: request.toolInfo?.name ?? request.title ?? "unknown",
              input: request.rawInput ?? {},
            })
            return { requestId: id, granted: false, reason: decision.message }
          },
        }
      : {}),
  }
}

/** Count conservative execution steps, cancelling at the inherited bound, once. */
export function externalAuthorityStepGuard(
  options: PermissionBoundExternalExecutionOptions | undefined,
  cancel: (reason: string) => Promise<void>
) {
  const limit = options?.inheritedRunAuthority?.maxTurns
  let steps = 0
  let cancellation: Promise<void> | undefined
  const ids = new Set<string>()
  return {
    get reason() {
      return cancellation ? `run_authority.maxTurns: ${limit}` : undefined
    },
    observe(event: ExternalAgentEvent): Promise<void> | undefined {
      if (limit === undefined || cancellation) return cancellation
      const key =
        event.type === "tool_use_start"
          ? `tool:${event.toolUseId}`
          : event.type === "message_start" && event.role === "assistant"
            ? `message:${event.messageId ?? steps}`
            : undefined
      if (!key || ids.has(key)) return undefined
      ids.add(key)
      if (++steps >= limit) cancellation = cancel(`run_authority.maxTurns: ${limit}`)
      return cancellation
    },
  }
}

// Composite privacy sources are deliberately not a single execution identity.
// Keep the dispatch owner in Host memory without changing that privacy shape.
const externalRunOwners = new WeakMap<object, string>()
/** The Host-bound run an external execution acts for, if any. */
export function externalRunAuthorityId(
  context: PersonalEgressContext | undefined
): string | undefined {
  return context ? (externalRunOwners.get(context) ?? context.executionRunId) : undefined
}

/**
 * Engine usage as the ledger meters it. ACP reports context occupancy with no
 * prompt/completion split; that is not billed tokens, so it stays unknown.
 */
export function externalMeteredUsage(
  usage: ExternalAgentTokenUsage | undefined
): MeteredUsage | undefined {
  if (!usage) return undefined
  const tokens = usage.promptTokens > 0 || usage.completionTokens > 0
  // A dollar cost the provider named in USD stands on its own (Goose reports
  // only that); a cost in any other unit, or none, leaves the dollars unknown.
  const costUsd =
    usage.providerCost?.currency?.toUpperCase() === "USD" ? usage.providerCost.amount : undefined
  if (!tokens && costUsd === undefined) return undefined
  return {
    ...(tokens
      ? {
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          ...(usage.promptTokensIncludeCache
            ? {}
            : {
                cacheReadTokens: usage.cacheReadTokens ?? 0,
                cacheCreationTokens: usage.cacheWriteTokens ?? 0,
              }),
        }
      : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  }
}

export function bindExternalRunAuthority<T extends PersonalEgressContext>(
  context: T,
  runId: string
): T {
  externalRunOwners.set(context, runId)
  return context
}

/** Read only Host-bound producer references; option fields never select a parent. */
export async function enforceExternalRunAuthority(
  context: PersonalEgressContext | undefined,
  options: PermissionBoundExternalExecutionOptions | undefined,
  engine?: Pick<ExternalAgentConfig, "protocol" | "autoApprovePatterns">
): Promise<PermissionBoundExternalExecutionOptions | undefined> {
  // Provenance is not ancestry. Only the Host-bound external run selects the
  // canonical parent chain; personalSources can never select a write target.
  const runId = externalRunAuthorityId(context)
  if (!runId) return options
  const resolved = await resolveRunAuthority({ runId })
  if (
    !resolved.inheritedAuthority ||
    !Object.keys(resolved.inheritedAuthority).some(
      (key) => !["schemaVersion", "caps"].includes(key)
    )
  )
    return options
  const ids = resolved.inheritedAuthority.mcpServers?.only
  let servers: Array<{ id: string; name: string } | undefined> = []
  try {
    if (ids?.length)
      servers = await (await import("@/lib/db/schema")).getDb().mcpServers.bulkGet(ids)
  } catch {
    throw new RunAuthorityError("authority_unavailable", "MCP server identities unavailable")
  }
  const namesById = Object.fromEntries(
    servers.flatMap((server) => (server ? [[server.id, server.name]] : []))
  )
  const translated = externalAuthorityOptions(
    resolved.inheritedAuthority,
    options,
    engine,
    namesById
  )
  await persistRunAuthority(runId, resolved.authority ?? resolved.inheritedAuthority)
  return translated
}
